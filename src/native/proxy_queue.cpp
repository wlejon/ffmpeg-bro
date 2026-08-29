// The proxy queue. See proxy_queue.h.

#include "proxy_queue.h"

#include "ffmpeg_hardware.h"

#include "util/log.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace ffmpegbro {
namespace {

/// Bits per pixel per frame for the proxy's picture.
///
/// A proxy is looked at while a hand is moving and is never rendered from, so
/// what it has to survive is judging where a cut belongs — not a grade. This
/// number puts 720p60 at about 12 Mbit/s, which is close to what `h264_nvenc`
/// at `cq 26` produced for the same content when the format was being chosen
/// (14 Mbit/s, 44 MB for twenty-five seconds).
///
/// A *bitrate* rather than a quality, and that is the one interesting decision
/// here: `crf`, `cq`, `qp` and `global_quality` are four different spellings
/// belonging to four different encoders, and which one exists depends on which
/// encoder this build happened to open. Every encoder has a bitrate. Setting a
/// key one of them does not have would be exactly the "unknown option is an
/// error, not a shrug" case, on a code path chosen by what hardware is present.
constexpr double kBitsPerPixel = 0.22;

/// How often a running proxy notices a Stop and publishes progress: every this
/// many output frames.
constexpr int kPublishEvery = 30;

struct Entry {
    ProxyStatus st;
    ProxyRequest req;
    std::atomic<bool> stop{false};
};

struct Queue {
    std::mutex m;
    std::condition_variable wake;
    std::vector<std::shared_ptr<Entry>> all;
    std::deque<std::shared_ptr<Entry>> pending;
    std::vector<std::thread> workers;
    int busy = 0;
    bool closing = false;
    uint64_t nextId = 1;

    /// `fetch_queue.cpp`'s rule and its reason: a `std::thread` still joinable
    /// when a function-local static is destroyed calls `std::terminate`, which
    /// reads as a crash on the way out of a clean shutdown.
    ~Queue() {
        {
            std::lock_guard<std::mutex> lock(m);
            for (const auto& e : all) e->stop.store(true);
            pending.clear();
            closing = true;
        }
        wake.notify_all();
        for (auto& t : workers) if (t.joinable()) t.join();
    }
};

Queue& q() {
    static Queue instance;
    return instance;
}

bool terminal(ProxyStatus::State s) {
    return s == ProxyStatus::State::Done || s == ProxyStatus::State::Failed ||
           s == ProxyStatus::State::Cancelled;
}

/// Everything one transcode holds, freed however it leaves.
struct Run {
    AVFormatContext* in = nullptr;
    AVCodecContext* dec = nullptr;
    AVFormatContext* out = nullptr;
    AVCodecContext* enc = nullptr;
    AVStream* ost = nullptr;
    SwsContext* sws = nullptr;
    AVFrame* src = nullptr;
    AVFrame* dst = nullptr;
    AVPacket* pkt = nullptr;
    AVPacket* opkt = nullptr;
    bool headerWritten = false;

    /// Put the trailer down and close the file, and say how big it turned out.
    ///
    /// **Called before the terminal status is published, not by the destructor**
    /// — `ffmpeg_job.h`'s rule, arriving here for exactly the reason it states:
    /// "the obvious act on seeing *stopped* is to open what was made". It was a
    /// destructor first and `supercut/cuts.js` renames the finished file into
    /// place the instant it reads Done, which on Windows is a rename of a file
    /// the muxer still had open — a proxy that was written, reported, and then
    /// silently never appeared. Idempotent, so `~Run` can call it too.
    int64_t close() {
        int64_t bytes = 0;
        if (out) {
            if (headerWritten) { av_write_trailer(out); headerWritten = false; }
            if (out->pb && !(out->oformat->flags & AVFMT_NOFILE)) {
                bytes = avio_size(out->pb);
                avio_closep(&out->pb);
            }
        }
        return bytes;
    }

    ~Run() {
        close();
        if (sws) sws_freeContext(sws);
        av_frame_free(&src);
        av_frame_free(&dst);
        av_packet_free(&pkt);
        av_packet_free(&opkt);
        avcodec_free_context(&enc);
        avcodec_free_context(&dec);
        if (out) avformat_free_context(out);
        if (in) avformat_close_input(&in);
    }
};

/// An even number, because every 4:2:0 encoder wants one and a proxy that is
/// refused for an odd height is a proxy nobody gets.
int even(int v) { return v < 2 ? 2 : (v & ~1); }

/// The pixel format this encoder takes that is closest to what a decoder here
/// hands over. Asked of libavcodec rather than assumed: `h264_nvenc` and
/// `libx264` do not offer the same list, and a format neither of them has is
/// what `avcodec_open2` fails on with nothing useful to say.
AVPixelFormat formatFor(const AVCodec* codec) {
    const AVPixelFormat* fmts = nullptr;
    int n = 0;
    if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0,
                                     reinterpret_cast<const void**>(&fmts), &n) < 0 ||
        !fmts || n <= 0)
        return AV_PIX_FMT_YUV420P;
    for (int i = 0; i < n; ++i)
        if (fmts[i] == AV_PIX_FMT_YUV420P) return AV_PIX_FMT_YUV420P;
    return fmts[0];
}

/// Open the best H.264 encoder this build has for a proxy, hardware first.
///
/// **Asked of libavcodec, never listed here.** `av_codec_iterate` is walked for
/// encoders of `AV_CODEC_ID_H264` and each is *opened*, because whether one
/// works is not a property of the build — a machine with no card, a card with
/// every NVENC session in use, and a driver too old for the parameters asked
/// for all answer at `avcodec_open2` and nowhere earlier. The hardware ones are
/// tried first because they are 15x faster here for exactly this shape of work,
/// and the software one is what the loop falls back to rather than failing:
/// slower is a wait and none is a feature that does not exist.
///
/// `*fmt` is left holding the format the opened encoder takes.
bool openEncoder(AVCodecContext** out, AVPixelFormat* fmt, int w, int h,
                 AVRational timeBase, AVRational rate, const AVCodecContext* dec,
                 bool globalHeader, std::string* err) {
    std::vector<const AVCodec*> tries;
    void* it = nullptr;
    while (const AVCodec* c = av_codec_iterate(&it)) {
        if (c->id != AV_CODEC_ID_H264 || !av_codec_is_encoder(c)) continue;
        if (isHardwareEncoder(c)) tries.insert(tries.begin(), c);
        else tries.push_back(c);
    }
    if (const AVCodec* fallback = avcodec_find_encoder(AV_CODEC_ID_H264))
        if (std::find(tries.begin(), tries.end(), fallback) == tries.end())
            tries.push_back(fallback);
    if (tries.empty()) { *err = "this build has no H.264 encoder"; return false; }

    const int64_t bits = static_cast<int64_t>(
        static_cast<double>(w) * h * (rate.den > 0 ? av_q2d(rate) : 30.0) * kBitsPerPixel);

    for (const AVCodec* c : tries) {
        AVCodecContext* enc = avcodec_alloc_context3(c);
        if (!enc) continue;
        enc->width = w;
        enc->height = h;
        enc->pix_fmt = formatFor(c);
        enc->time_base = timeBase;
        enc->framerate = rate;
        // **Every frame a keyframe, which is the whole point of the file — and
        // `gop_size = 1` is not how to ask for it.** NVENC refuses that outright:
        // `InitializeEncoder failed: invalid param (8): Gop Length should be
        // greater than number of B frames + 1`, and with no B frames at all that
        // reads as "greater than one", so the one value that means what is wanted
        // here is the one value it will not take. What every encoder does honour
        // is a *frame* marked `AV_PICTURE_TYPE_I` — libavcodec's wrappers turn
        // that into an IDR for libx264 and for NVENC alike — so the keyframes are
        // asked for one picture at a time in `emit`, and these two are only what
        // makes that possible: no B frames to reorder around a forced I, and a
        // GOP short enough that nothing drifts if an encoder ever ignored the
        // mark. It is checked rather than assumed: `tests/proxy_test.cpp` counts
        // the keyframes and requires one per frame.
        enc->gop_size = 2;
        enc->max_b_frames = 0;
        // And the mark alone is not enough either, which is the second half of
        // the same story: both libx264's and NVENC's wrappers turn a forced I
        // into an *IDR* only when their own `forced-idr` option is on, and an I
        // that is not an IDR is not flagged as a keyframe, so nothing seeking
        // the file would ever land on one. Asked of libavcodec rather than
        // assumed — an encoder without the option keeps the GOP of two above,
        // which is one P frame of walking and 0.45 ms.
        if (enc->priv_data &&
            av_opt_find(enc->priv_data, "forced-idr", nullptr, 0, 0))
            av_opt_set_int(enc->priv_data, "forced-idr", 1, 0);
        enc->bit_rate = std::max<int64_t>(bits, 500000);
        // Carried rather than defaulted: a proxy that says nothing about its
        // colour is a proxy drawn beside the render in a different one.
        enc->color_range = dec->color_range;
        enc->color_primaries = dec->color_primaries;
        enc->color_trc = dec->color_trc;
        enc->colorspace = dec->colorspace;
        if (globalHeader) enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
        std::string why;
        const int rc = avcodec_open2(enc, c, nullptr);
        if (rc >= 0) {
            *out = enc;
            *fmt = enc->pix_fmt;
            LOG_INFO("proxy: encoding with %s (%dx%d, %.1f Mbit/s)", c->name, w, h,
                     enc->bit_rate / 1e6);
            return true;
        }
        char buf[256] = {0};
        av_strerror(rc, buf, sizeof(buf));
        why = buf;
        LOG_INFO("proxy: %s would not open (%s), trying the next", c->name, why.c_str());
        avcodec_free_context(&enc);
        *err = std::string("no H.264 encoder here would open: ") + c->name + " said " + why;
    }
    return false;
}

/// One proxy, start to finish, on the worker thread.
void runOne(const std::shared_ptr<Entry>& e) {
    const auto began = std::chrono::steady_clock::now();
    const auto elapsed = [&began] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
    };

    ProxyStatus st;
    {
        std::lock_guard<std::mutex> lock(q().m);
        e->st.state = ProxyStatus::State::Running;
        st = e->st;
    }
    const auto publish = [&e, &st] {
        std::lock_guard<std::mutex> lock(q().m);
        e->st = st;
    };
    publish();

    Run r;
    std::string err;
    const auto fail = [&](const std::string& why) {
        r.close();          // for `close()`'s reason: the file is done with first
        st.state = ProxyStatus::State::Failed;
        st.error = why;
        st.elapsedSec = elapsed();
        publish();
        LOG_ERROR("proxy failed: %s", why.c_str());
    };

    if (!openInput(&r.in, e->req.input, &err)) { fail(err); return; }
    const int vi = av_find_best_stream(r.in, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (vi < 0) { fail("there is no picture in it to make a proxy of"); return; }
    AVStream* ist = r.in->streams[vi];
    if (!openDecoder(&r.dec, ist->codecpar, ist->time_base, e->req.input, true, &err)) {
        fail(err);
        return;
    }

    const int srcW = r.dec->width > 0 ? r.dec->width : ist->codecpar->width;
    const int srcH = r.dec->height > 0 ? r.dec->height : ist->codecpar->height;
    if (srcW <= 0 || srcH <= 0) { fail("the picture has no size"); return; }
    // **Never larger than the source.** A proxy of a 480p recording is 480p and
    // still worth making: what makes a scrub instant here is the keyframe on
    // every frame, and the size is the second half of it.
    const int dstH = even(std::min(e->req.height, srcH));
    const int dstW = even(static_cast<int>(std::lround(
        static_cast<double>(srcW) * dstH / static_cast<double>(srcH))));

    AVRational rate = av_guess_frame_rate(r.in, ist, nullptr);
    if (rate.num <= 0 || rate.den <= 0) rate = AVRational{30, 1};

    if (avformat_alloc_output_context2(&r.out, nullptr, "matroska",
                                       e->req.path.c_str()) < 0 || !r.out) {
        fail("could not open a Matroska writer for " + e->req.path);
        return;
    }
    AVPixelFormat encFmt = AV_PIX_FMT_YUV420P;
    if (!openEncoder(&r.enc, &encFmt, dstW, dstH, ist->time_base, rate, r.dec,
                     (r.out->oformat->flags & AVFMT_GLOBALHEADER) != 0, &err)) {
        fail(err);
        return;
    }
    r.ost = avformat_new_stream(r.out, nullptr);
    if (!r.ost || avcodec_parameters_from_context(r.ost->codecpar, r.enc) < 0) {
        fail("could not describe the proxy's picture to the muxer");
        return;
    }
    r.ost->time_base = r.enc->time_base;
    r.ost->avg_frame_rate = rate;
    if (!(r.out->oformat->flags & AVFMT_NOFILE) &&
        avio_open(&r.out->pb, e->req.path.c_str(), AVIO_FLAG_WRITE) < 0) {
        fail("could not write to " + e->req.path);
        return;
    }
    if (avformat_write_header(r.out, nullptr) < 0) {
        fail("the Matroska header would not go down");
        return;
    }
    r.headerWritten = true;

    r.src = av_frame_alloc();
    r.dst = av_frame_alloc();
    r.pkt = av_packet_alloc();
    r.opkt = av_packet_alloc();
    if (!r.src || !r.dst || !r.pkt || !r.opkt) { fail("out of memory"); return; }
    r.dst->format = encFmt;
    r.dst->width = dstW;
    r.dst->height = dstH;
    if (av_frame_get_buffer(r.dst, 0) < 0) { fail("out of memory for the picture"); return; }

    st.span = r.in->duration > 0 ? r.in->duration / static_cast<double>(AV_TIME_BASE) : 0.0;
    publish();

    int64_t lastPts = AV_NOPTS_VALUE;
    bool cancelled = false;

    // Encode one scaled picture. Returns false with `err` set.
    const auto emit = [&](AVFrame* frame) -> bool {
        if (frame) {
            AVFrame* use = frame;
            AVFrame* down = nullptr;
            if (isHwPixelFormat(static_cast<AVPixelFormat>(frame->format))) {
                // A proxy asks for no `-hwaccel`, so this is only reached by an
                // input that carries one of its own. Bring it down rather than
                // refuse: the scale below is libswscale's and wants planes.
                if (!downloadFrame(&use, &down, &err)) return false;
            }
            if (!r.sws) {
                r.sws = sws_getContext(use->width, use->height,
                                       static_cast<AVPixelFormat>(use->format),
                                       dstW, dstH, encFmt, SWS_BILINEAR,
                                       nullptr, nullptr, nullptr);
                if (!r.sws) {
                    av_frame_free(&down);
                    err = "no scaler from this picture to the proxy's size";
                    return false;
                }
            }
            if (av_frame_make_writable(r.dst) < 0) {
                av_frame_free(&down);
                err = "out of memory for the picture";
                return false;
            }
            sws_scale(r.sws, use->data, use->linesize, 0, use->height,
                      r.dst->data, r.dst->linesize);
            int64_t pts = use->best_effort_timestamp != AV_NOPTS_VALUE
                              ? use->best_effort_timestamp
                              : use->pts;
            // A stream with no timestamps, or one that repeats one, still has to
            // come out strictly increasing or the muxer refuses the packet.
            if (pts == AV_NOPTS_VALUE) pts = lastPts == AV_NOPTS_VALUE ? 0 : lastPts + 1;
            if (lastPts != AV_NOPTS_VALUE && pts <= lastPts) pts = lastPts + 1;
            lastPts = pts;
            r.dst->pts = pts;
            // See `gop_size` above: this is how the file comes to be all
            // keyframes, and it is the one way that works on every encoder.
            r.dst->pict_type = AV_PICTURE_TYPE_I;
            av_frame_free(&down);
            const int rc = avcodec_send_frame(r.enc, r.dst);
            if (rc < 0) { err = "the proxy's encoder refused a picture"; return false; }
        } else if (avcodec_send_frame(r.enc, nullptr) < 0) {
            err = "the proxy's encoder refused to flush";
            return false;
        }

        for (;;) {
            const int rc = avcodec_receive_packet(r.enc, r.opkt);
            if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
            if (rc < 0) { err = "the proxy's encoder failed"; return false; }
            r.opkt->stream_index = r.ost->index;
            av_packet_rescale_ts(r.opkt, r.enc->time_base, r.ost->time_base);
            const int w = av_interleaved_write_frame(r.out, r.opkt);
            av_packet_unref(r.opkt);
            if (w < 0) { err = "the proxy could not be written"; return false; }
            st.frames++;
        }
    };

    // Hand one packet to the decoder and write whatever comes back out.
    const auto pump = [&](AVPacket* pkt) -> bool {
        if (avcodec_send_packet(r.dec, pkt) < 0) return true;   // a bad packet is skipped
        for (;;) {
            const int rc = avcodec_receive_frame(r.dec, r.src);
            if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
            if (rc < 0) { err = "the input would not decode"; return false; }
            const bool ok = emit(r.src);
            av_frame_unref(r.src);
            if (!ok) return false;
            if (st.frames % kPublishEvery == 0) {
                st.position = lastPts != AV_NOPTS_VALUE
                                  ? lastPts * av_q2d(ist->time_base) : 0.0;
                st.span = std::max(st.span, st.position);
                st.progress = st.span > 0.0
                                  ? std::min(1.0, std::max(0.0, st.position / st.span))
                                  : 0.0;
                st.elapsedSec = elapsed();
                publish();
            }
        }
    };

    while (av_read_frame(r.in, r.pkt) >= 0) {
        if (e->stop.load()) { av_packet_unref(r.pkt); cancelled = true; break; }
        const bool mine = r.pkt->stream_index == vi;
        const bool ok = mine ? pump(r.pkt) : true;
        av_packet_unref(r.pkt);
        if (!ok) { fail(err); return; }
    }
    if (!cancelled) {
        if (!pump(nullptr)) { fail(err); return; }      // drain the decoder
        if (!emit(nullptr)) { fail(err); return; }      // drain the encoder
    }

    // **Closed before the state is published**, and a cancelled one is closed
    // too: the trailer is what makes what was written playable, so stopping a
    // proxy leaves a short file rather than a header with nothing after it.
    st.bytes = r.close();
    st.state = cancelled ? ProxyStatus::State::Cancelled : ProxyStatus::State::Done;
    if (!cancelled) st.progress = 1.0;
    st.position = lastPts != AV_NOPTS_VALUE ? lastPts * av_q2d(ist->time_base) : 0.0;
    st.elapsedSec = elapsed();
    publish();
    LOG_INFO("proxy %s %s (%lld frames, %dx%d, %.1f s)",
             cancelled ? "stopped at" : "wrote", st.path.c_str(),
             static_cast<long long>(st.frames), dstW, dstH, st.elapsedSec);
}

void worker() {
    for (;;) {
        std::shared_ptr<Entry> mine;
        {
            std::unique_lock<std::mutex> lock(q().m);
            q().wake.wait(lock, [] { return q().closing || !q().pending.empty(); });
            if (q().closing && q().pending.empty()) return;
            if (q().pending.empty()) continue;
            mine = q().pending.front();
            q().pending.pop_front();
            if (mine->stop.load()) {
                mine->st.state = ProxyStatus::State::Cancelled;
                continue;
            }
            q().busy++;
        }
        runOne(mine);
        {
            std::lock_guard<std::mutex> lock(q().m);
            q().busy--;
        }
        q().wake.notify_all();
    }
}

/// One thread, started on the first proxy. See the header for why one.
void ensureWorker() {
    if (!q().workers.empty()) return;
    q().workers.emplace_back(worker);
}

} // namespace

uint64_t startProxy(const ProxyRequest& r, std::string* err) {
    if (r.input.path.empty()) { *err = "a proxy needs an input to read"; return 0; }
    if (r.path.empty()) { *err = "a proxy needs somewhere to write"; return 0; }
    if (r.height < 16) { *err = "a proxy needs a height of at least 16"; return 0; }

    std::lock_guard<std::mutex> lock(q().m);
    ensureWorker();
    auto e = std::make_shared<Entry>();
    e->req = r;
    e->st.id = q().nextId++;
    e->st.label = r.label.empty() ? r.path : r.label;
    e->st.path = r.path;
    e->st.state = ProxyStatus::State::Queued;
    q().all.push_back(e);
    q().pending.push_back(e);
    q().wake.notify_one();
    return e->st.id;
}

std::vector<ProxyStatus> proxyList() {
    std::lock_guard<std::mutex> lock(q().m);
    std::vector<ProxyStatus> out;
    out.reserve(q().all.size());
    for (const auto& e : q().all) out.push_back(e->st);
    return out;
}

ProxyStatus proxyStatus(uint64_t id) {
    std::lock_guard<std::mutex> lock(q().m);
    for (const auto& e : q().all) if (e->st.id == id) return e->st;
    return ProxyStatus{};
}

void stopProxy(uint64_t id) {
    std::lock_guard<std::mutex> lock(q().m);
    for (const auto& e : q().all) {
        if (e->st.id != id) continue;
        if (terminal(e->st.state)) return;
        e->stop.store(true);
        if (e->st.state == ProxyStatus::State::Queued) {
            e->st.state = ProxyStatus::State::Cancelled;
            q().pending.erase(std::remove(q().pending.begin(), q().pending.end(), e),
                              q().pending.end());
        }
        return;
    }
}

void clearFinishedProxies() {
    std::lock_guard<std::mutex> lock(q().m);
    q().all.erase(std::remove_if(q().all.begin(), q().all.end(),
                                 [](const std::shared_ptr<Entry>& e) {
                                     return terminal(e->st.state);
                                 }),
                  q().all.end());
}

void waitForProxies() {
    std::unique_lock<std::mutex> lock(q().m);
    q().wake.wait(lock, [] { return q().pending.empty() && q().busy == 0; });
}

void stopAllProxies() {
    std::vector<std::thread> threads;
    {
        std::lock_guard<std::mutex> lock(q().m);
        for (const auto& e : q().all) {
            if (terminal(e->st.state)) continue;
            e->stop.store(true);
            if (e->st.state == ProxyStatus::State::Queued)
                e->st.state = ProxyStatus::State::Cancelled;
        }
        q().pending.clear();
        q().closing = true;
        threads.swap(q().workers);
    }
    q().wake.notify_all();
    for (auto& t : threads) if (t.joinable()) t.join();
    std::lock_guard<std::mutex> lock(q().m);
    q().closing = false;
}

} // namespace ffmpegbro
