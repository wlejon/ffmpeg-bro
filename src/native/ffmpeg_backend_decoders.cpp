// Video/audio decoders, backend registration, and media probing.
// See ffmpeg_backend.h and backend_internal.h.

#include "ffmpeg_backend.h"
#include "backend_internal.h"

#include "export_frame.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_report.h"

#include "util/log.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <cstdio>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace ffmpegbro {
namespace backend_detail {
namespace {

// ── VideoDecoder ───────────────────────────────────────────────────────────

class FFmpegVideoDecoder : public VideoDecoder {
public:
    ~FFmpegVideoDecoder() override {
        if (sws_) sws_freeContext(sws_);
        if (frame_) av_frame_free(&frame_);
        if (swap_) av_frame_free(&swap_);
        if (avpkt_) av_packet_free(&avpkt_);
        if (ctx_) avcodec_free_context(&ctx_);
    }

    bool init(const TrackInfo& t) {
        auto priv = privateOf(t);
        if (!priv || !priv->par) return false;
        timeBase_ = priv->timeBase;

        // Nothing to open: the pictures arrive decoded. `avcodec_open2` on the
        // wrapped_avframe decoder would work and would then refuse every packet
        // — its first act is to check that the pointer still matches its own
        // buffer, which is exactly what a crossing cannot preserve — so the
        // codec is skipped rather than opened and worked around.
        if (priv->wrapped) {
            wrapped_ = true;
            frame_ = av_frame_alloc();
            swap_ = av_frame_alloc();
            return frame_ && swap_;
        }

        // Frame + slice threading across all cores. For H.264/HEVC/AV1 this is
        // what makes software decode keep up with 4K, and unlike a hardware
        // decoder it costs no GPU->CPU readback — which matters here more than
        // anywhere, because bro's renderer wants planes in system memory and
        // playback has no way to keep a picture on the card. An input that
        // asks for `-hwaccel` still gets it (the decision belongs to the input
        // and the same decision has to reach the timeline and the render), and
        // every frame is brought back down in `nextFrame`. The input's own
        // decoder options are applied after this and therefore win.
        //
        // **Deciding it automatically was measured and refused, and AV1 is why
        // it was measured again.** The argument above was made against 4K AVC,
        // and the case that should have broken it is a long recording of AV1 —
        // the codec whose software decode is supposed to be at realtime, which
        // is the one condition a pipeline cannot recover a seek's head start
        // from. On this machine (RTX 4090, Windows 11) it is not, and the card
        // is slower at everything measured. One pass per row, decode plus the
        // readback playback always pays, in ms per picture:
        //
        //     1440p60 AV1  (mandelbrot, 63 Mbps)   software 2.11   [1]
        //     1440p60 AV1  (+ film grain)          software 2.23   [1]
        //     4K AVC                               software 1.47   cuda 4.37
        //                                                          dxva2 4.84
        //                                                          d3d11va 5.28
        //     640x360 AVC                          software 0.06   cuda 0.30
        //
        //     [1] no hardware column: every AV1 *decoder* in this build that
        //         takes a device is reachable only by asking for one by name —
        //         see `hwDecoderFor`. Through ffmpeg's CLI, which can, d3d11va
        //         and libdav1d decode this file in the same wall clock and the
        //         card uses 4.6x less CPU (1.4 s against 6.3 s for ten seconds).
        //
        // And the many-streams case, which is the one this application is,
        // does not reverse it either: eight 4K AVC decoders at once are 2.7 s
        // of wall clock in software against 8.2 s on cuda and 10.1 s on
        // d3d11va, because a card has two decode engines and a CPU here has
        // thirty-two threads. Twelve 640x360 decoders are 0.17 s against 0.86 s.
        //
        // So the automatic choice is the CPU, which is what it already was, and
        // the numbers are here rather than in a commit message because the next
        // person to think "surely the GPU" should be able to see what was run.
        // What the measurements did change is one layer down: an input that
        // *asks* for a device now gets one for AV1 too, which it could not
        // before — the saving there is CPU rather than time, and it is the
        // caller's decision to make.
        std::string why;
        if (!openDecoder(&ctx_, priv->par, timeBase_, priv->input,
                         /*threaded=*/true, &why)) {
            LOG_WARN("ffmpeg: %s", why.c_str());
            return false;
        }

        frame_ = av_frame_alloc();
        swap_ = av_frame_alloc();
        avpkt_ = av_packet_alloc();
        return frame_ && swap_ && avpkt_;
    }

    bool decode(const MediaPacket& pkt) override {
        if (wrapped_) {
            AVFrame* f = unwrapFrame(pkt.data.get());
            if (!f) return true;   // not one of ours; nothing to show for it
            av_frame_unref(frame_);
            // Referenced, not stolen: the packet owns the frame and may still
            // be held by whoever routed it. This is one refcount, not a copy
            // of a picture.
            if (av_frame_ref(frame_, f) < 0) return true;
            // The pts on the frame is the graph's; the one on the packet has
            // already been through `-ss`/`-itsoffset` and the container's start
            // time, which is the clock everything above here is on.
            wrappedPts_ = pkt.pts;
            haveWrapped_ = true;
            return true;
        }
        if (!ctx_ || !pkt.data) return false;
        av_packet_unref(avpkt_);
        // Reference the caller's buffer rather than copying: the packet's
        // shared_ptr keeps it alive, and libavcodec is done with it by the
        // time send_packet returns for every decoder we use.
        avpkt_->data = const_cast<uint8_t*>(pkt.data->data());
        avpkt_->size = static_cast<int>(pkt.data->size());
        avpkt_->pts = fromNs(pkt.pts, timeBase_);
        avpkt_->dts = avpkt_->pts;
        avpkt_->flags = pkt.keyframe ? AV_PKT_FLAG_KEY : 0;

        int rc = avcodec_send_packet(ctx_, avpkt_);
        avpkt_->data = nullptr;
        avpkt_->size = 0;
        if (rc == AVERROR(EAGAIN)) return true;   // drain first, then re-send
        if (rc < 0) {
            // A corrupt or unreferenced packet is not a reason to tear the
            // pipeline down — the next keyframe recovers.
            LOG_WARN("ffmpeg: video decode error: %s", avErr(rc).c_str());
            return true;
        }
        return true;
    }

    bool nextFrame(VideoFrame& out) override {
        if (wrapped_) {
            // One packet is one picture, so there is no reorder buffer to
            // empty and nothing to hand back on a second call.
            if (!haveWrapped_) return false;
            haveWrapped_ = false;
            return handOver(out, wrappedPts_);
        }
        if (!ctx_) return false;
        av_frame_unref(frame_);
        int rc = avcodec_receive_frame(ctx_, frame_);
        if (rc < 0) return false;   // EAGAIN/EOF: nothing more this round
        return handOver(out, -1);
    }

    /// The picture in `frame_`, as bro takes one. `ptsNs` at or above zero is
    /// the timestamp to use — a wrapped frame carries the graph's own clock and
    /// the packet's has already been through the input's `-ss` and the
    /// container's start time — and below zero asks the frame.
    bool handOver(VideoFrame& out, int64_t ptsNs) {
        // A hardware decode still has to arrive here as pixels: what bro's
        // renderer takes is three planes it can read, and there is no path in
        // playback that could hand it a device handle. So the picture comes
        // down, unconditionally.
        //
        // The download is cheap — 3–4% of a CUDA decode, measured — and it is
        // the *decode* that makes `-hwaccel` a loss on the timeline, because
        // libavcodec threaded across every core is several times faster than
        // one NVDEC stream pulled a frame at a time. The UI says so where the
        // choice is made.
        if (frame_->hw_frames_ctx) {
            std::string why;
            if (!downloadFrame(&frame_, &swap_, &why)) {
                LOG_WARN("ffmpeg: %s", why.c_str());
                return false;
            }
        }

        const int w = frame_->width;
        const int h = frame_->height;
        if (w <= 0 || h <= 0) return false;

        int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                         ? frame_->best_effort_timestamp
                         : frame_->pts;
        out.pts = ptsNs >= 0 ? ptsNs
                             : (ts != AV_NOPTS_VALUE ? toNs(ts, timeBase_) : 0);
        out.width = static_cast<uint32_t>(w);
        out.height = static_cast<uint32_t>(h);

        const auto fmt = static_cast<AVPixelFormat>(frame_->format);
        if (fmt == AV_PIX_FMT_YUV420P || fmt == AV_PIX_FMT_YUVJ420P) {
            // Already what bro wants. Plane pointers stay valid until the next
            // nextFrame() call, which is exactly libvpx's contract too.
            out.y = frame_->data[0];
            out.u = frame_->data[1];
            out.v = frame_->data[2];
            out.strideY = frame_->linesize[0];
            out.strideU = frame_->linesize[1];
            out.strideV = frame_->linesize[2];
            out.storage.reset();
            return true;
        }

        // Anything else — 10-bit HDR, 4:2:2 broadcast, 4:4:4 ProRes, RGB
        // screen captures — goes through swscale into I420.
        return convertToI420(fmt, w, h, out);
    }

    // A null packet is how libavcodec is told the stream ended: receive_frame
    // then hands back the reorder buffer instead of returning EAGAIN. HEVC
    // with a full DPB holds sixteen pictures there, which is a full second of
    // a 15 fps file that would otherwise never be seen.
    void drain() override {
        if (ctx_) avcodec_send_packet(ctx_, nullptr);
    }

    void flush() override {
        // Also clears the drained state, so the decoder accepts packets again
        // after a seek away from the end.
        if (ctx_) avcodec_flush_buffers(ctx_);
        // A wrapped frame from before the seek belongs where it came from, and
        // there is no codec here holding anything else.
        haveWrapped_ = false;
    }

private:
    bool convertToI420(AVPixelFormat fmt, int w, int h, VideoFrame& out) {
        sws_ = sws_getCachedContext(sws_, w, h, fmt, w, h, AV_PIX_FMT_YUV420P,
                                    SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!sws_) return false;

        const size_t ySize = static_cast<size_t>(w) * h;
        const int cw = (w + 1) / 2, ch = (h + 1) / 2;
        const size_t cSize = static_cast<size_t>(cw) * ch;

        // Every plane gets slack after it, not just the last: three planes
        // packed back to back means one plane's spill lands in the next, and
        // the last one's lands outside the allocation. See kSwsSlack.
        const size_t yPlane = ySize + kSwsSlack;
        const size_t cPlane = cSize + kSwsSlack;
        auto buf = std::make_shared<std::vector<uint8_t>>(yPlane + cPlane * 2);

        uint8_t* dst[4] = {buf->data(), buf->data() + yPlane,
                           buf->data() + yPlane + cPlane, nullptr};
        int dstStride[4] = {w, cw, cw, 0};
        int rc = sws_scale(sws_, frame_->data, frame_->linesize, 0, h, dst, dstStride);
        if (rc <= 0) return false;

        out.storage = buf;
        out.y = dst[0];
        out.u = dst[1];
        out.v = dst[2];
        out.strideY = w;
        out.strideU = cw;
        out.strideV = cw;
        return true;
    }

    AVCodecContext* ctx_ = nullptr;
    AVFrame* frame_ = nullptr;
    /// The spare a hardware frame is brought down into; swapped with `frame_`
    /// rather than copied, so a hardware decode allocates once and not once a
    /// picture.
    AVFrame* swap_ = nullptr;
    AVPacket* avpkt_ = nullptr;
    SwsContext* sws_ = nullptr;
    AVRational timeBase_{1, 1000};

    /// This track's packets are frames already — no codec is open and
    /// `frame_`/`swap_` are the only things allocated. See `Wrapped`.
    bool wrapped_ = false;
    bool haveWrapped_ = false;
    int64_t wrappedPts_ = 0;
};

// ── AudioDecoder ───────────────────────────────────────────────────────────

class FFmpegAudioDecoder : public AudioDecoder {
public:
    ~FFmpegAudioDecoder() override {
        if (swr_) swr_free(&swr_);
        if (frame_) av_frame_free(&frame_);
        if (avpkt_) av_packet_free(&avpkt_);
        if (ctx_) avcodec_free_context(&ctx_);
        av_channel_layout_uninit(&outLayout_);
    }

    bool init(const TrackInfo& t) {
        auto priv = privateOf(t);
        if (!priv || !priv->par) return false;
        timeBase_ = priv->timeBase;

        // Sound arriving already decoded — `-f lavfi -i sine=1000`. The same
        // crossing and the same answer as the picture side; see `Wrapped`.
        // What comes out still goes through swresample, because the layout and
        // rate a filter produces are its own and the caller asked for theirs.
        if (priv->wrapped) {
            wrapped_ = true;
            rate_ = priv->par->sample_rate;
            channels_ = priv->par->ch_layout.nb_channels;
            if (rate_ <= 0 || channels_ <= 0) return false;
            if (av_channel_layout_copy(&outLayout_, &priv->par->ch_layout) < 0) return false;
            frame_ = av_frame_alloc();
            return frame_ != nullptr;
        }

        std::string why;
        if (!openDecoder(&ctx_, priv->par, timeBase_, priv->input,
                         /*threaded=*/false, &why)) {
            LOG_WARN("ffmpeg: %s", why.c_str());
            return false;
        }

        rate_ = ctx_->sample_rate;
        channels_ = ctx_->ch_layout.nb_channels;
        if (rate_ <= 0 || channels_ <= 0) return false;
        // Default to the source's own layout; setOutputFormat overrides.
        if (av_channel_layout_copy(&outLayout_, &ctx_->ch_layout) < 0) return false;

        frame_ = av_frame_alloc();
        avpkt_ = av_packet_alloc();
        return frame_ && avpkt_;
    }

    bool setOutputFormat(uint32_t sampleRate, uint32_t channels) override {
        if (sampleRate == 0 || channels == 0 || channels > 8) return false;

        AVChannelLayout want{};
        // A named layout gives swresample a real downmix matrix (5.1 → stereo
        // folds the centre and surrounds in at the right levels); an unnamed
        // one would just truncate channels and lose the dialogue.
        av_channel_layout_default(&want, static_cast<int>(channels));
        av_channel_layout_uninit(&outLayout_);
        if (av_channel_layout_copy(&outLayout_, &want) < 0) {
            av_channel_layout_uninit(&want);
            return false;
        }
        av_channel_layout_uninit(&want);

        rate_ = static_cast<int>(sampleRate);
        channels_ = static_cast<int>(channels);
        // Force the resampler to be rebuilt against the new target.
        if (swr_) swr_free(&swr_);
        swrInFmt_ = AV_SAMPLE_FMT_NONE;
        swrInRate_ = 0;
        return true;
    }

    bool decode(const MediaPacket& pkt, AudioFrame& out) override {
        if (!pkt.data) return false;

        out.sampleRate = static_cast<uint32_t>(rate_);
        out.channels = static_cast<uint32_t>(channels_);
        out.pts = pkt.pts;
        out.samples.clear();

        if (wrapped_) {
            AVFrame* f = unwrapFrame(pkt.data.get());
            if (!f) return false;
            av_frame_unref(frame_);
            if (av_frame_ref(frame_, f) < 0) return false;
            return appendFrame(out);
        }

        if (!ctx_) return false;
        av_packet_unref(avpkt_);
        avpkt_->data = const_cast<uint8_t*>(pkt.data->data());
        avpkt_->size = static_cast<int>(pkt.data->size());
        avpkt_->pts = fromNs(pkt.pts, timeBase_);
        avpkt_->dts = avpkt_->pts;

        int rc = avcodec_send_packet(ctx_, avpkt_);
        avpkt_->data = nullptr;
        avpkt_->size = 0;
        if (rc < 0 && rc != AVERROR(EAGAIN)) {
            LOG_WARN("ffmpeg: audio decode error: %s", avErr(rc).c_str());
            return false;
        }

        // One packet can yield several frames (and, for codecs with a decoder
        // delay, none at all on the first calls). Append everything available.
        bool got = false;
        for (;;) {
            av_frame_unref(frame_);
            rc = avcodec_receive_frame(ctx_, frame_);
            if (rc < 0) break;
            if (!appendFrame(out)) break;
            if (!got) {
                // The frame's own timestamp beats the packet's once we have it.
                int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                                 ? frame_->best_effort_timestamp
                                 : frame_->pts;
                if (ts != AV_NOPTS_VALUE) out.pts = toNs(ts, timeBase_);
            }
            got = true;
        }
        return got;
    }

    void flush() override {
        if (ctx_) avcodec_flush_buffers(ctx_);
        // The resampler holds a filter tail from before the seek; emitting it
        // after would splice a few ms of the old position onto the new one.
        if (swr_) swr_free(&swr_);
        swrInFmt_ = AV_SAMPLE_FMT_NONE;
        swrInRate_ = 0;
    }

private:
    // Resample/interleave one AVFrame onto the end of `out.samples`.
    bool appendFrame(AudioFrame& out) {
        const auto inFmt = static_cast<AVSampleFormat>(frame_->format);
        if (!swr_ || inFmt != swrInFmt_ || frame_->sample_rate != swrInRate_) {
            if (swr_) swr_free(&swr_);
            int rc = swr_alloc_set_opts2(&swr_, &outLayout_, AV_SAMPLE_FMT_FLT, rate_,
                                         &frame_->ch_layout, inFmt, frame_->sample_rate,
                                         0, nullptr);
            if (rc < 0 || !swr_ || swr_init(swr_) < 0) {
                LOG_WARN("ffmpeg: cannot build audio resampler");
                return false;
            }
            swrInFmt_ = inFmt;
            swrInRate_ = frame_->sample_rate;
        }

        // Account for whatever swr is holding back, so nothing is dropped.
        const int64_t delay = swr_get_delay(swr_, rate_);
        const int maxOut = static_cast<int>(
            av_rescale_rnd(delay + frame_->nb_samples, rate_, frame_->sample_rate, AV_ROUND_UP));
        if (maxOut <= 0) return true;

        // Grown with slack, converted into, then shrunk to what was actually
        // written — so the buffer libswresample writes into is bigger than the
        // sample count while `samples.size()` stays honest about how many there
        // are. Shrinking a vector never reallocates, so the slack survives as
        // spare capacity. See kSwrSlack — this is libswresample, not libswscale.
        const size_t base = out.samples.size();
        out.samples.resize(base + static_cast<size_t>(maxOut) * channels_ + kSwrSlack);
        auto* dst = reinterpret_cast<uint8_t*>(out.samples.data() + base);
        int written = swr_convert(swr_, &dst, maxOut,
                                  const_cast<const uint8_t**>(frame_->extended_data),
                                  frame_->nb_samples);
        if (written < 0) {
            out.samples.resize(base);
            return false;
        }
        out.samples.resize(base + static_cast<size_t>(written) * channels_);
        return true;
    }

    AVCodecContext* ctx_ = nullptr;
    AVFrame* frame_ = nullptr;
    AVPacket* avpkt_ = nullptr;
    SwrContext* swr_ = nullptr;
    AVChannelLayout outLayout_{};
    AVSampleFormat swrInFmt_ = AV_SAMPLE_FMT_NONE;
    int swrInRate_ = 0;
    int rate_ = 0;
    int channels_ = 0;
    AVRational timeBase_{1, 1000};

    /// Sound that arrives already decoded — no codec is open. See `Wrapped`.
    bool wrapped_ = false;
};

} // namespace
} // namespace backend_detail

// ── Registration ───────────────────────────────────────────────────────────

void registerFfmpegBackend() {
    using namespace backend_detail;
    static bool done = false;
    if (done) return;
    done = true;

    // libav writes to stderr by default, which for a windowed build goes
    // nowhere. Route it into bro.log with everything else, at a level that
    // reports real problems without narrating every packet.
    //
    // There is exactly one `av_log` callback in the process and it lives in
    // ffmpeg_report.cpp, because the console and the report want different
    // amounts of the same stream: this level governs what is *printed*, while
    // the report keeps everything down to AV_LOG_INFO whether or not it is on
    // screen. Installed here as well as from `main` so that no order of the two
    // can leave the callback un-installed — it is idempotent.
    av_log_set_level(AV_LOG_WARNING);
    installLogCapture();

    // libavdevice's formats do not exist until this has run — not merely
    // unlisted: `av_find_input_format("gdigrab")` would not find one either, so
    // a screen grab was unreachable from every direction. Done here rather than
    // where something enumerates, because this runs before the engine is
    // constructed and a device is a source like any other.
    registerDevices();

    MediaBackend backend;
    backend.name = "ffmpeg";
    // Above bro's built-in WebM backend: libavcodec decodes VP8/VP9/Opus too,
    // and keeping one code path for every container means one set of seek,
    // timestamp and reordering semantics instead of two.
    backend.priority = 100;

    // A src that names a registered input is opened as that input, options and
    // all; anything else is a path, opened the way it always was.
    //
    // This is the whole of how an input's options reach *playback*. bro's
    // `<video>` takes a string and this backend is registered generically, so
    // there is nowhere else to put them — and a token that names the input
    // rather than repeating its path is what lets two inputs on one file carry
    // two different option bags, and what lets a URL be a src at all (bro
    // resolves anything that does not start with `/` or `x:` against the
    // document, which turns `https://…` into a path under ui/).
    backend.open = &openBackendSource;
    backend.makeVideoDecoder = [](const TrackInfo& t) -> std::unique_ptr<VideoDecoder> {
        auto dec = std::make_unique<FFmpegVideoDecoder>();
        if (!dec->init(t)) return nullptr;
        return dec;
    };
    backend.makeAudioDecoder = [](const TrackInfo& t) -> std::unique_ptr<AudioDecoder> {
        auto dec = std::make_unique<FFmpegAudioDecoder>();
        if (!dec->init(t)) return nullptr;
        return dec;
    };

    bro::video::registerMediaBackend(std::move(backend));
    LOG_INFO("ffmpeg: media backend registered (%s)", libavVersion().c_str());
}

// ── Probe ──────────────────────────────────────────────────────────────────

ProbeResult probeMedia(const std::string& path) {
    MediaInput in;
    in.path = path;
    return probeMedia(in);
}

ProbeResult probeMedia(const MediaInput& in, OpenWatch* watch) {
    ProbeResult r;
    r.path = in.path;

    AVFormatContext* fmt = nullptr;
    std::string why;
    if (!openInput(&fmt, in, &why, watch)) {
        // Without the path in front of it, because the caller already knows
        // which file it asked about and `openInput` prefixes it for the log.
        const std::string prefix = in.path + ": ";
        r.error = why.compare(0, prefix.size(), prefix) == 0 ? why.substr(prefix.size()) : why;
        return r;
    }

    r.ok = true;
    r.formatName = fmt->iformat && fmt->iformat->name ? fmt->iformat->name : "";
    r.formatLongName = fmt->iformat && fmt->iformat->long_name ? fmt->iformat->long_name : "";

    // How long the *input* is, which is how long the file is only when nothing
    // has been said about a window. A clip's length comes from this, so an
    // input trimmed with `-ss`/`-t` has to report the trimmed length here or
    // the timeline would lay out a clip running past the end of its own input
    // — and an input that loops has no measured length at all, so `-t` is the
    // whole of the answer. Both rules live in `inputDuration`.
    const auto window = [&](double d) { return inputDuration(in, d); };

    const double rawDuration =
        fmt->duration != AV_NOPTS_VALUE ? fmt->duration / double(AV_TIME_BASE) : 0.0;
    r.durationSec = window(rawDuration);
    r.bitRate = fmt->bit_rate;
    if (fmt->pb) r.sizeBytes = avio_size(fmt->pb);

    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        AVStream* st = fmt->streams[i];
        AVCodecParameters* par = st->codecpar;

        StreamSummary s;
        s.index = static_cast<int>(i);
        switch (par->codec_type) {
            case AVMEDIA_TYPE_VIDEO:    s.kind = "video"; break;
            case AVMEDIA_TYPE_AUDIO:    s.kind = "audio"; break;
            case AVMEDIA_TYPE_SUBTITLE: s.kind = "subtitle"; break;
            default:                    s.kind = "data"; break;
        }
        s.codec = avcodec_get_name(par->codec_id);
        if (par->codec_tag) {
            char fourcc[AV_FOURCC_MAX_STRING_SIZE] = {0};
            s.tag = av_fourcc_make_string(fourcc, par->codec_tag);
        }
        if (const AVCodecDescriptor* d = avcodec_descriptor_get(par->codec_id)) {
            s.codecLong = d->long_name ? d->long_name : "";
            s.textSub = par->codec_type == AVMEDIA_TYPE_SUBTITLE &&
                        (d->props & AV_CODEC_PROP_TEXT_SUB) != 0;
        }
        if (const char* p = avcodec_profile_name(par->codec_id, par->profile))
            s.profile = p;
        s.bitRate = par->bit_rate;
        // Matroska keeps one duration for the whole file and none per track,
        // so falling back to the container's is the best answer available
        // rather than reporting a clip of length zero.
        s.duration = st->duration != AV_NOPTS_VALUE
                         ? window(st->duration * av_q2d(st->time_base))
                         : r.durationSec;
        s.isDefault = (st->disposition & AV_DISPOSITION_DEFAULT) != 0;

        if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
            s.width = par->width;
            s.height = par->height;
            AVRational fr = av_guess_frame_rate(fmt, st, nullptr);
            s.fps = fr.den > 0 ? av_q2d(fr) : 0.0;
            if (const char* pf = av_get_pix_fmt_name(static_cast<AVPixelFormat>(par->format)))
                s.pixFmt = pf;
            if (par->sample_aspect_ratio.num > 0 && par->sample_aspect_ratio.den > 0)
                s.sampleAspect = av_q2d(par->sample_aspect_ratio);
            // Left empty when the file is untagged. av_color_*_name answers
            // "unspecified"/"unknown" for those, which reads like a value and
            // is not one.
            if (par->color_space != AVCOL_SPC_UNSPECIFIED)
                if (const char* v = av_color_space_name(par->color_space)) s.colorSpace = v;
            if (par->color_range != AVCOL_RANGE_UNSPECIFIED)
                if (const char* v = av_color_range_name(par->color_range)) s.colorRange = v;
            if (par->color_primaries != AVCOL_PRI_UNSPECIFIED)
                if (const char* v = av_color_primaries_name(par->color_primaries))
                    s.colorPrimaries = v;
            if (par->color_trc != AVCOL_TRC_UNSPECIFIED)
                if (const char* v = av_color_transfer_name(par->color_trc)) s.colorTransfer = v;
            // Rotation lives in a display matrix side-datum; a phone video is
            // 1920x1080 on disk and 1080x1920 on screen, and only this says so.
            //
            // **There is one answer to it in this binary, and this is not a
            // second reading of the matrix.** There used to be: this block
            // truncated where `rotationOf` rounds (an 89.9999° matrix reported
            // 271) and accepted angles that are not quarter turns, which no
            // path here can apply — so the Sources stage could report a
            // rotation the render would not honour and the player could not
            // express. The export reader turns the picture with `rotationOf`
            // and the playback backend above reports it to bro with
            // `rotationOf`; a probe that disagreed with either would lay a clip
            // out at a size nothing produces.
            s.rotation = rotationOf(st);
        } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
            s.sampleRate = par->sample_rate;
            s.channels = par->ch_layout.nb_channels;
            char layout[64] = {0};
            if (av_channel_layout_describe(&par->ch_layout, layout, sizeof(layout)) > 0)
                s.channelLayout = layout;
            if (const char* sf = av_get_sample_fmt_name(static_cast<AVSampleFormat>(par->format)))
                s.sampleFmt = sf;
        }

        if (const AVDictionaryEntry* e = av_dict_get(st->metadata, "language", nullptr, 0))
            s.language = e->value;
        if (const AVDictionaryEntry* e = av_dict_get(st->metadata, "title", nullptr, 0))
            s.title = e->value;

        r.streams.push_back(std::move(s));
    }

    avformat_close_input(&fmt);
    return r;
}

std::string libavVersion() {
    char buf[128];
    std::snprintf(buf, sizeof(buf), "libavformat %u.%u.%u, libavcodec %u.%u.%u",
                  LIBAVFORMAT_VERSION_MAJOR, LIBAVFORMAT_VERSION_MINOR,
                  LIBAVFORMAT_VERSION_MICRO, LIBAVCODEC_VERSION_MAJOR,
                  LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO);
    return buf;
}

std::string libavConfiguration() {
    const char* c = avcodec_configuration();
    return c ? c : "";
}

std::vector<std::string> availableHwAccels() {
    std::vector<std::string> out;
    AVHWDeviceType t = AV_HWDEVICE_TYPE_NONE;
    while ((t = av_hwdevice_iterate_types(t)) != AV_HWDEVICE_TYPE_NONE) {
        if (const char* name = av_hwdevice_get_type_name(t)) out.emplace_back(name);
    }
    return out;
}

} // namespace ffmpegbro
