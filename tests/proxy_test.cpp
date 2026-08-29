// The proxy queue: does it make the one kind of file it exists to make?
//
// A proxy has exactly three properties, and every one of them is load-bearing
// for the reason `src/native/proxy_queue.h` measured — so all three are asserted
// against the file that comes out rather than against the request that went in.
//
// **Every frame is a keyframe.** This is the whole point and it is also the one
// that quietly went wrong: `gop_size = 1` is refused by NVENC outright (*"Gop
// Length should be greater than number of B frames + 1"*), and the mark that
// replaces it — `AV_PICTURE_TYPE_I` on every frame — produces a non-IDR I frame,
// which is **not flagged as a keyframe**, unless the encoder's own `forced-idr`
// option is on as well. Two of those three states produce a plausible file that
// seeks at the speed of the one it was made from. So the test counts.
//
// **It is the size it was asked for, and the shape it came from.** The height
// is the request; the width is whatever keeps the source's aspect, rounded to
// even because 4:2:0 needs it. A proxy of a portrait clip is portrait.
//
// **It is the same length.** A proxy is seeked to `sourceTime(clip, t)` on the
// clip's own clock, so a proxy that ran short — or long — would put a different
// picture on the screen from the one being edited.
//
// Plus the two things a queue owes anybody: a request it cannot perform is
// refused *at the call* with a reason, and a proxy asked to stop stops.
//
// Usage: ffmpeg-bro-proxytest <landscape.mp4> [<portrait.mp4>]
//
// Every section says what it found and is skipped when its fixture is absent.

#include "ffmpeg_backend.h"
#include "ffmpeg_input.h"
#include "proxy_queue.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

using namespace ffmpegbro;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
    ++checks;
    if (!ok) ++failures;
    std::printf("  %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
}

void checkf(bool ok, const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    check(ok, buf);
}

void section(const char* name) { std::printf("\n== %s ==\n", name); }

/// What a file's video stream is: size, length, and how many of its frames a
/// player could seek straight to.
struct Look {
    bool ok = false;
    int width = 0;
    int height = 0;
    double duration = 0.0;
    int frames = 0;
    int keyframes = 0;
};

Look look(const std::string& path) {
    Look out;
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) return out;
    if (avformat_find_stream_info(fmt, nullptr) < 0) { avformat_close_input(&fmt); return out; }
    const int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (vi < 0) { avformat_close_input(&fmt); return out; }
    out.width = fmt->streams[vi]->codecpar->width;
    out.height = fmt->streams[vi]->codecpar->height;
    out.duration = fmt->duration > 0 ? fmt->duration / double(AV_TIME_BASE) : 0.0;

    // Counted off the packets rather than decoded: `AV_PKT_FLAG_KEY` is exactly
    // what a demuxer's index offers a seek, which is the property being asserted.
    AVPacket* pkt = av_packet_alloc();
    while (pkt && av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index == vi) {
            out.frames++;
            if (pkt->flags & AV_PKT_FLAG_KEY) out.keyframes++;
        }
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    avformat_close_input(&fmt);
    out.ok = true;
    return out;
}

/// Run one to completion and hand back its final status.
ProxyStatus run(const ProxyRequest& r) {
    std::string err;
    const uint64_t id = startProxy(r, &err);
    if (!id) {
        ProxyStatus bad;
        bad.state = ProxyStatus::State::Failed;
        bad.error = err;
        return bad;
    }
    waitForProxies();
    return proxyStatus(id);
}

const char* stateName(ProxyStatus::State s) {
    switch (s) {
        case ProxyStatus::State::Queued:    return "queued";
        case ProxyStatus::State::Running:   return "running";
        case ProxyStatus::State::Done:      return "done";
        case ProxyStatus::State::Failed:    return "failed";
        case ProxyStatus::State::Cancelled: return "cancelled";
    }
    return "?";
}

/// One source, proxied, and every property of the result checked against it.
void proxyOf(const std::string& src, const std::string& out, int height) {
    const Look was = look(src);
    if (!was.ok) { std::printf("  (no %s — skipped)\n", src.c_str()); return; }

    ProxyRequest r;
    r.input.path = src;
    r.path = out;
    r.height = height;
    r.label = "test";
    const auto began = std::chrono::steady_clock::now();
    const ProxyStatus st = run(r);
    const double took = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - began).count();

    checkf(st.state == ProxyStatus::State::Done,
           "a proxy of %dx%d is made (%s%s%s, %.2f s)", was.width, was.height,
           stateName(st.state), st.error.empty() ? "" : ": ", st.error.c_str(), took);
    if (st.state != ProxyStatus::State::Done) return;

    const Look now = look(out);
    checkf(now.ok, "and it opens");
    if (!now.ok) return;

    checkf(now.height == height, "it is %d tall, which is what was asked for", now.height);
    // Even, and the aspect within a pixel of the source's — which is the whole
    // of what "the shape it came from" can mean once both sides are rounded.
    const double wantW = double(was.width) * height / double(was.height);
    checkf((now.width & 1) == 0 && std::fabs(now.width - wantW) <= 2.0,
           "and %d wide, against %.1f for the source's aspect", now.width, wantW);

    checkf(now.frames > 0 && now.keyframes == now.frames,
           "every one of its %d frames is a keyframe (%d are) — which is the whole "
           "of why it exists", now.frames, now.keyframes);

    checkf(was.duration <= 0.0 || std::fabs(now.duration - was.duration) < 0.15,
           "and it is %.2f s against the source's %.2f", now.duration, was.duration);
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("usage: ffmpeg-bro-proxytest <landscape.mp4> [<portrait.mp4>]\n");
        return 2;
    }
    registerFfmpegBackend();
    // `out/`, which is gitignored and where every other native suite writes.
    std::error_code ec;
    std::filesystem::create_directories("out", ec);
    const std::string landscape = argv[1];
    const std::string portrait = argc > 2 ? argv[2] : "";

    section("a proxy of a landscape clip");
    proxyOf(landscape, "out/proxy-landscape.mkv", 240);

    if (!portrait.empty()) {
        section("a proxy keeps the shape it came from");
        proxyOf(portrait, "out/proxy-portrait.mkv", 240);
    }

    section("a source smaller than the proxy is not enlarged");
    {
        // The height asked for is larger than the fixture; what comes back is the
        // fixture's own, because a proxy exists to be *quick* and upscaling one
        // buys nothing but pixels to convert. Every frame is still a keyframe,
        // which is the half that was worth the transcode.
        const Look was = look(landscape);
        ProxyRequest r;
        r.input.path = landscape;
        r.path = "out/proxy-big.mkv";
        r.height = was.height * 4;
        const ProxyStatus st = run(r);
        checkf(st.state == ProxyStatus::State::Done, "it is made (%s)", stateName(st.state));
        if (st.state == ProxyStatus::State::Done) {
            const Look now = look("out/proxy-big.mkv");
            checkf(now.height == was.height,
                   "and it is %d tall, not %d — the source's own height", now.height,
                   r.height);
            checkf(now.frames > 0 && now.keyframes == now.frames,
                   "and still all keyframes (%d of %d)", now.keyframes, now.frames);
        }
    }

    section("what it refuses, at the call");
    {
        // The refusal is read into a local *before* `checkf`, because the order
        // in which a call's arguments are evaluated is unspecified: written
        // inline, `err.c_str()` was being read before `startProxy` had written
        // it, and every one of these three reported the previous one's sentence.
        const auto refused = [](ProxyRequest r, const char* word, const char* what) {
            std::string err;
            const uint64_t id = startProxy(r, &err);
            checkf(id == 0 && err.find(word) != std::string::npos, "%s: %s", what,
                   id == 0 ? err.c_str() : "it was accepted");
        };

        ProxyRequest none;
        none.path = "nowhere.mkv";
        refused(none, "input", "a request with no input is refused");

        ProxyRequest nowhere;
        nowhere.input.path = landscape;
        refused(nowhere, "write", "a request with nowhere to write is refused");

        ProxyRequest tiny;
        tiny.input.path = landscape;
        tiny.path = "tiny.mkv";
        tiny.height = 4;
        refused(tiny, "height", "a request for a four-pixel picture is refused");
    }

    section("a file that is not one");
    {
        ProxyRequest r;
        r.input.path = "no-such-file-anywhere.mp4";
        r.path = "out/proxy-nothing.mkv";
        const ProxyStatus st = run(r);
        checkf(st.state == ProxyStatus::State::Failed,
               "an input that will not open fails on the thread with a reason (%s: %s)",
               stateName(st.state), st.error.c_str());
    }

    section("stopping one");
    {
        // Queued and stopped before the worker reaches it, which is the branch
        // that has to answer without opening anything at all.
        ProxyRequest r;
        r.input.path = landscape;
        r.path = "out/proxy-stopped.mkv";
        r.height = 240;
        std::string err;
        const uint64_t id = startProxy(r, &err);
        checkf(id != 0, "it queues");
        stopProxy(id);
        waitForProxies();
        const ProxyStatus st = proxyStatus(id);
        checkf(st.state == ProxyStatus::State::Cancelled ||
               st.state == ProxyStatus::State::Done,
               "and a stop is answered rather than ignored (%s)", stateName(st.state));
    }

    section("the list");
    {
        const size_t before = proxyList().size();
        checkf(before > 0, "every proxy this process made is still listed (%zu)", before);
        clearFinishedProxies();
        checkf(proxyList().empty(), "and clearing the finished ones empties it");
    }

    stopAllProxies();
    std::printf("\n%d checks, %d failed\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
