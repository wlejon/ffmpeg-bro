#include "ffmpeg_backend.h"

#include "ffmpeg_capabilities.h"
#include "ffmpeg_report.h"

#include "util/log.h"
#include "video/audio_decoder.h"
#include "video/media_backend.h"
#include "video/media_source.h"
#include "video/video_decoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/display.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

using bro::video::AudioDecoder;
using bro::video::AudioFrame;
using bro::video::Codec;
using bro::video::MediaBackend;
using bro::video::MediaPacket;
using bro::video::MediaSource;
using bro::video::TimeNs;
using bro::video::TrackInfo;
using bro::video::TrackKind;
using bro::video::VideoDecoder;
using bro::video::VideoFrame;

namespace {

// bro's timestamps are nanoseconds from the start of the stream.
constexpr AVRational kNsTimeBase{1, 1000000000};

/// Slack to leave past the end of anything libav* is asked to write into.
///
/// Both libswscale and libswresample work a whole SIMD block at a time, so the
/// last store of a row — or of a run of samples — can go past the end of what
/// was asked for. A buffer sized to exactly width*height, or to exactly the
/// sample count, is therefore too small however carefully the count was worked
/// out. This is the padding av_image_alloc and av_samples_alloc would have
/// added, and it is not optional: a 640-wide file is a whole number of blocks
/// and never showed it, while a 360-wide one corrupted the heap on the first
/// frame — far enough from the write that it surfaced at process shutdown,
/// which is where this cost two afternoons.
constexpr size_t kSwsSlack = 256;

TimeNs toNs(int64_t ts, AVRational tb) {
    if (ts == AV_NOPTS_VALUE) return AV_NOPTS_VALUE;
    return av_rescale_q(ts, tb, kNsTimeBase);
}

int64_t fromNs(TimeNs ns, AVRational tb) {
    return av_rescale_q(ns, kNsTimeBase, tb);
}

std::string avErr(int code) {
    char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(code, buf, sizeof(buf));
    return buf;
}

Codec toBroCodec(AVCodecID id) {
    switch (id) {
        case AV_CODEC_ID_VP8:        return Codec::VP8;
        case AV_CODEC_ID_VP9:        return Codec::VP9;
        case AV_CODEC_ID_AV1:        return Codec::AV1;
        case AV_CODEC_ID_H264:       return Codec::H264;
        case AV_CODEC_ID_HEVC:       return Codec::H265;
        case AV_CODEC_ID_MPEG2VIDEO: return Codec::MPEG2Video;
        case AV_CODEC_ID_MPEG4:      return Codec::MPEG4;
        case AV_CODEC_ID_PRORES:     return Codec::ProRes;
        case AV_CODEC_ID_OPUS:       return Codec::Opus;
        case AV_CODEC_ID_VORBIS:     return Codec::Vorbis;
        case AV_CODEC_ID_AAC:        return Codec::AAC;
        case AV_CODEC_ID_MP3:        return Codec::MP3;
        case AV_CODEC_ID_FLAC:       return Codec::FLAC;
        case AV_CODEC_ID_AC3:        return Codec::AC3;
        case AV_CODEC_ID_EAC3:       return Codec::EAC3;
        default: break;
    }
    // Every flavour of raw PCM maps to one bro codec id.
    const AVCodecDescriptor* d = avcodec_descriptor_get(id);
    if (d && (d->props & AV_CODEC_PROP_LOSSLESS) && d->name &&
        std::strncmp(d->name, "pcm_", 4) == 0) {
        return Codec::PCM;
    }
    return Codec::Other;
}

// Carried from the demuxer to the decoder through TrackInfo::backendPrivate.
// AVCodecParameters is the whole point: flattening it into codecPrivate would
// drop the extradata framing, pixel format and colour description that make an
// H.264 or HEVC stream decodable at all.
struct TrackPrivate {
    AVCodecParameters* par = nullptr;
    AVRational timeBase{1, 1000};
    int streamIndex = 0;

    ~TrackPrivate() {
        if (par) avcodec_parameters_free(&par);
    }
};

std::shared_ptr<TrackPrivate> privateOf(const TrackInfo& t) {
    return std::static_pointer_cast<TrackPrivate>(t.backendPrivate);
}

// ── MediaSource ────────────────────────────────────────────────────────────

class FFmpegSource : public MediaSource {
public:
    ~FFmpegSource() override {
        if (pkt_) av_packet_free(&pkt_);
        if (fmt_) avformat_close_input(&fmt_);
    }

    bool open(const std::string& path) {
        int rc = avformat_open_input(&fmt_, path.c_str(), nullptr, nullptr);
        if (rc < 0) {
            // Not this backend's file (or unreadable). Stay quiet: the
            // registry contract is that a backend declining a format says so
            // by returning nullptr, not by logging.
            fmt_ = nullptr;
            return false;
        }
        rc = avformat_find_stream_info(fmt_, nullptr);
        if (rc < 0) {
            LOG_WARN("ffmpeg: '%s' opened but has no readable stream info: %s",
                     path.c_str(), avErr(rc).c_str());
            return false;
        }

        pkt_ = av_packet_alloc();
        if (!pkt_) return false;

        // Container-level start time, subtracted from every timestamp so the
        // stream begins at 0 the way bro's clock expects. Taken once and
        // applied to all tracks so a/v stay in sync relative to each other.
        if (fmt_->start_time != AV_NOPTS_VALUE)
            startOffsetNs_ = av_rescale_q(fmt_->start_time, AV_TIME_BASE_Q, kNsTimeBase);

        const TimeNs formatDuration =
            fmt_->duration != AV_NOPTS_VALUE
                ? av_rescale_q(fmt_->duration, AV_TIME_BASE_Q, kNsTimeBase)
                : 0;

        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            AVStream* st = fmt_->streams[i];
            AVCodecParameters* par = st->codecpar;
            const bool isVideo = par->codec_type == AVMEDIA_TYPE_VIDEO;
            const bool isAudio = par->codec_type == AVMEDIA_TYPE_AUDIO;
            if (!isVideo && !isAudio) continue;
            // Cover art and thumbnails are single still frames stapled into an
            // audio file; treating one as the video track would "play" a JPEG.
            if (isVideo && (st->disposition & AV_DISPOSITION_ATTACHED_PIC)) continue;

            TrackInfo t;
            // bro treats track id 0 as "unset", and stream 0 is a perfectly
            // ordinary stream, so shift by one.
            t.id = static_cast<uint32_t>(i) + 1;
            t.kind = isVideo ? TrackKind::Video : TrackKind::Audio;
            t.codec = toBroCodec(par->codec_id);
            if (isVideo) {
                t.width = static_cast<uint32_t>(par->width);
                t.height = static_cast<uint32_t>(par->height);
                // Prefers the container's declared rate and falls back to one
                // measured from the timestamps, which is what makes this
                // sensible for a variable-frame-rate phone capture.
                const AVRational fr = av_guess_frame_rate(fmt_, st, nullptr);
                if (fr.num > 0 && fr.den > 0) t.frameRate = av_q2d(fr);
            } else {
                t.sampleRate = static_cast<uint32_t>(par->sample_rate);
                t.channels = static_cast<uint32_t>(par->ch_layout.nb_channels);
            }
            if (par->extradata && par->extradata_size > 0) {
                t.codecPrivate.assign(par->extradata,
                                      par->extradata + par->extradata_size);
            }
            t.durationNs = st->duration != AV_NOPTS_VALUE
                               ? toNs(st->duration, st->time_base)
                               : formatDuration;

            auto priv = std::make_shared<TrackPrivate>();
            priv->par = avcodec_parameters_alloc();
            if (!priv->par || avcodec_parameters_copy(priv->par, par) < 0) return false;
            priv->timeBase = st->time_base;
            priv->streamIndex = static_cast<int>(i);
            t.backendPrivate = priv;

            if (isVideo && videoStreamIndex_ < 0) videoStreamIndex_ = static_cast<int>(i);
            tracks_.push_back(std::move(t));
        }

        return !tracks_.empty();
    }

    const std::vector<TrackInfo>& tracks() const override { return tracks_; }

    bool readPacket(MediaPacket& out) override {
        if (!fmt_ || !pkt_) return false;
        for (;;) {
            av_packet_unref(pkt_);
            int rc = av_read_frame(fmt_, pkt_);
            if (rc < 0) return false;   // EOF or hard read error

            const uint32_t trackId = static_cast<uint32_t>(pkt_->stream_index) + 1;
            auto it = std::find_if(tracks_.begin(), tracks_.end(),
                                   [&](const TrackInfo& t) { return t.id == trackId; });
            if (it == tracks_.end()) continue;   // a stream we don't expose

            AVStream* st = fmt_->streams[pkt_->stream_index];
            int64_t ts = pkt_->pts != AV_NOPTS_VALUE ? pkt_->pts : pkt_->dts;
            TimeNs pts = ts != AV_NOPTS_VALUE ? toNs(ts, st->time_base) - startOffsetNs_ : 0;
            if (pts < 0) pts = 0;

            out.trackId = trackId;
            out.codec = it->codec;
            out.kind = it->kind;
            out.keyframe = (pkt_->flags & AV_PKT_FLAG_KEY) != 0;
            out.pts = pts;
            out.duration = pkt_->duration > 0 ? toNs(pkt_->duration, st->time_base) : 0;
            out.data = std::make_shared<std::vector<uint8_t>>(
                pkt_->data, pkt_->data + pkt_->size);
            return true;
        }
    }

    void setActiveTracks(const std::vector<uint32_t>& trackIds) override {
        if (!fmt_) return;
        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            const uint32_t id = i + 1;
            const bool keep = std::find(trackIds.begin(), trackIds.end(), id) != trackIds.end();
            // AVDISCARD_ALL stops the demuxer handing us the packet at all,
            // so an unwanted 1080p video track costs nothing to skip past.
            fmt_->streams[i]->discard = keep ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
        }
    }

    bool seekTo(TimeNs pts) override {
        if (!fmt_) return false;
        const int idx = videoStreamIndex_;
        // Rounded DOWN, not to nearest. The contract is "at or before", and a
        // container tick is tens of microseconds wide — rounding to nearest
        // can carry a target that sits just below a frame up onto it, and a
        // seek meant to land before a keyframe lands on it instead.
        const AVRational tb = idx >= 0 ? fmt_->streams[idx]->time_base : AV_TIME_BASE_Q;
        const int64_t target =
            av_rescale_q_rnd(pts + startOffsetNs_, kNsTimeBase, tb, AV_ROUND_DOWN);
        // BACKWARD lands on the keyframe at or before the target; the pipeline
        // decodes forward from there and drops what it doesn't need.
        int rc = av_seek_frame(fmt_, idx, target, AVSEEK_FLAG_BACKWARD);
        if (rc < 0) {
            LOG_WARN("ffmpeg: seek to %.3fs failed: %s", pts / 1e9, avErr(rc).c_str());
            return false;
        }
        return true;
    }

private:
    AVFormatContext* fmt_ = nullptr;
    AVPacket* pkt_ = nullptr;
    std::vector<TrackInfo> tracks_;
    int videoStreamIndex_ = -1;
    TimeNs startOffsetNs_ = 0;
};

// ── VideoDecoder ───────────────────────────────────────────────────────────

class FFmpegVideoDecoder : public VideoDecoder {
public:
    ~FFmpegVideoDecoder() override {
        if (sws_) sws_freeContext(sws_);
        if (frame_) av_frame_free(&frame_);
        if (avpkt_) av_packet_free(&avpkt_);
        if (ctx_) avcodec_free_context(&ctx_);
    }

    bool init(const TrackInfo& t) {
        auto priv = privateOf(t);
        if (!priv || !priv->par) return false;
        timeBase_ = priv->timeBase;

        const AVCodec* codec = avcodec_find_decoder(priv->par->codec_id);
        if (!codec) {
            LOG_WARN("ffmpeg: no decoder for video codec %s",
                     avcodec_get_name(priv->par->codec_id));
            return false;
        }
        ctx_ = avcodec_alloc_context3(codec);
        if (!ctx_) return false;
        if (avcodec_parameters_to_context(ctx_, priv->par) < 0) return false;

        // Frame + slice threading across all cores. For H.264/HEVC/AV1 this is
        // what makes software decode keep up with 4K, and unlike a hardware
        // decoder it costs no GPU->CPU readback — which matters while the
        // renderer still wants frames in system memory.
        ctx_->thread_count = 0;
        ctx_->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
        ctx_->pkt_timebase = timeBase_;

        int rc = avcodec_open2(ctx_, codec, nullptr);
        if (rc < 0) {
            LOG_WARN("ffmpeg: cannot open %s decoder: %s", codec->name, avErr(rc).c_str());
            return false;
        }

        frame_ = av_frame_alloc();
        avpkt_ = av_packet_alloc();
        return frame_ && avpkt_;
    }

    bool decode(const MediaPacket& pkt) override {
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
        if (!ctx_) return false;
        av_frame_unref(frame_);
        int rc = avcodec_receive_frame(ctx_, frame_);
        if (rc < 0) return false;   // EAGAIN/EOF: nothing more this round

        const int w = frame_->width;
        const int h = frame_->height;
        if (w <= 0 || h <= 0) return false;

        int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                         ? frame_->best_effort_timestamp
                         : frame_->pts;
        out.pts = ts != AV_NOPTS_VALUE ? toNs(ts, timeBase_) : 0;
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
    AVPacket* avpkt_ = nullptr;
    SwsContext* sws_ = nullptr;
    AVRational timeBase_{1, 1000};
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

        const AVCodec* codec = avcodec_find_decoder(priv->par->codec_id);
        if (!codec) {
            LOG_WARN("ffmpeg: no decoder for audio codec %s",
                     avcodec_get_name(priv->par->codec_id));
            return false;
        }
        ctx_ = avcodec_alloc_context3(codec);
        if (!ctx_) return false;
        if (avcodec_parameters_to_context(ctx_, priv->par) < 0) return false;
        ctx_->thread_count = 0;
        ctx_->pkt_timebase = timeBase_;

        int rc = avcodec_open2(ctx_, codec, nullptr);
        if (rc < 0) {
            LOG_WARN("ffmpeg: cannot open %s decoder: %s", codec->name, avErr(rc).c_str());
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
        if (!ctx_ || !pkt.data) return false;

        out.sampleRate = static_cast<uint32_t>(rate_);
        out.channels = static_cast<uint32_t>(channels_);
        out.pts = pkt.pts;
        out.samples.clear();

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
        // spare capacity. See kSwsSlack.
        const size_t base = out.samples.size();
        out.samples.resize(base + static_cast<size_t>(maxOut) * channels_ + kSwsSlack);
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
};

} // namespace

// ── Registration ───────────────────────────────────────────────────────────

void registerFfmpegBackend() {
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

    backend.open = [](const std::string& path) -> std::unique_ptr<MediaSource> {
        auto src = std::make_unique<FFmpegSource>();
        if (!src->open(path)) return nullptr;
        return src;
    };
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
    ProbeResult r;
    r.path = path;

    AVFormatContext* fmt = nullptr;
    int rc = avformat_open_input(&fmt, path.c_str(), nullptr, nullptr);
    if (rc < 0) {
        r.error = avErr(rc);
        return r;
    }
    rc = avformat_find_stream_info(fmt, nullptr);
    if (rc < 0) {
        r.error = avErr(rc);
        avformat_close_input(&fmt);
        return r;
    }

    r.ok = true;
    r.formatName = fmt->iformat && fmt->iformat->name ? fmt->iformat->name : "";
    r.formatLongName = fmt->iformat && fmt->iformat->long_name ? fmt->iformat->long_name : "";
    r.durationSec = fmt->duration != AV_NOPTS_VALUE ? fmt->duration / double(AV_TIME_BASE) : 0.0;
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
        if (const AVCodecDescriptor* d = avcodec_descriptor_get(par->codec_id))
            s.codecLong = d->long_name ? d->long_name : "";
        if (const char* p = avcodec_profile_name(par->codec_id, par->profile))
            s.profile = p;
        s.bitRate = par->bit_rate;
        // Matroska keeps one duration for the whole file and none per track,
        // so falling back to the container's is the best answer available
        // rather than reporting a clip of length zero.
        s.duration = st->duration != AV_NOPTS_VALUE
                         ? st->duration * av_q2d(st->time_base)
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
            if (const AVPacketSideData* sd = av_packet_side_data_get(
                    par->coded_side_data, par->nb_coded_side_data,
                    AV_PKT_DATA_DISPLAYMATRIX)) {
                double deg = av_display_rotation_get(reinterpret_cast<const int32_t*>(sd->data));
                if (deg == deg) {   // not NaN
                    int d = static_cast<int>(-deg);
                    d %= 360;
                    if (d < 0) d += 360;
                    s.rotation = d;
                }
            }
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
