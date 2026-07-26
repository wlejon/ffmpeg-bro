// Where does the time in a seek actually go?
//
// Scrubbing was measured at 185-570 ms per seek through the UI. This times
// the layers underneath it separately — demuxer seek, decode, YUV->RGB
// conversion — so the fix targets whatever is actually expensive rather than
// whatever looks expensive.
//
// Usage: ffmpeg-bro-perftest <media-file>

#include "ffmpeg_backend.h"

#include "video/media_backend.h"
#include "video/video_pipeline.h"
#include "video/yuv_to_rgb.h"

#include <chrono>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

using namespace bro::video;

namespace {

using Clock = std::chrono::steady_clock;

double msSince(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

void report(const char* label, double totalMs, int ops) {
    std::printf("  %-38s %8.2f ms/op   (%d ops, %.0f ms)\n",
                label, ops ? totalMs / ops : 0.0, ops, totalMs);
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <media-file>\n", argv[0]);
        return 2;
    }
    ffmpegbro::registerFfmpegBackend();
    const std::string path = argv[1];

    VideoPipeline pipe;
    if (!pipe.open(path)) {
        std::fprintf(stderr, "cannot open %s\n", path.c_str());
        return 1;
    }
    const TimeNs dur = pipe.durationNs();
    std::printf("\n%s — %dx%d, %.3f s\n\n", path.c_str(),
                pipe.frameWidth(), pipe.frameHeight(), dur / 1e9);

    // ── through the pipeline, the way the UI does it ───────────────────────
    {
        auto t0 = Clock::now();
        const int n = 20;
        for (int i = 0; i < n; ++i) pipe.seekTo(dur / 4 + i * 100000000LL);
        report("VideoPipeline::seekTo (+0.1s steps)", msSince(t0), n);
    }
    {
        auto t0 = Clock::now();
        const int n = 20;
        for (int i = 0; i < n; ++i) pipe.seekTo(dur * 3 / 4 - i * 100000000LL);
        report("VideoPipeline::seekTo (-0.1s steps)", msSince(t0), n);
    }
    {
        // Forward playback with no seek at all: what a small step SHOULD cost
        // if it didn't restart the demuxer.
        pipe.seekTo(0);
        auto t0 = Clock::now();
        const int n = 30;
        for (int i = 1; i <= n; ++i) pipe.advanceTo(i * 33000000LL);
        report("advanceTo (+1 frame, no seek)", msSince(t0), n);
    }

    // Frame stepping, the transport button people hold down. Forward is one
    // decode; backward has to walk the GOP again, which is inherent.
    {
        pipe.seekTo(dur / 2);
        auto t0 = Clock::now();
        const int n = 30;
        for (int i = 0; i < n; ++i) pipe.stepFrame(1);
        report("stepFrame(+1)", msSince(t0), n);
    }
    {
        pipe.seekTo(dur / 2);
        auto t0 = Clock::now();
        const int n = 30;
        for (int i = 0; i < n; ++i) pipe.stepFrame(-1);
        report("stepFrame(-1)", msSince(t0), n);
    }

    // ── the layers underneath ──────────────────────────────────────────────
    const MediaBackend* be = nullptr;
    std::unique_ptr<MediaSource> src;
    for (const auto& b : mediaBackends()) {
        if (!b.open) continue;
        src = b.open(path);
        if (src) { be = &b; break; }
    }
    if (!src || !be) return 1;

    const TrackInfo* videoTrack = nullptr;
    for (const auto& t : src->tracks())
        if (t.kind == TrackKind::Video) { videoTrack = &t; break; }
    if (!videoTrack) return 1;
    src->setActiveTracks({videoTrack->id});
    auto dec = be->makeVideoDecoder(*videoTrack);
    if (!dec) return 1;

    // Demuxer seek alone.
    {
        auto t0 = Clock::now();
        const int n = 50;
        for (int i = 0; i < n; ++i) src->seekTo(dur / 4 + i * 100000000LL);
        report("MediaSource::seekTo alone", msSince(t0), n);
    }

    // Decode with no RGBA conversion, and the conversion on its own.
    {
        src->seekTo(0);
        dec->flush();
        MediaPacket pkt;
        VideoFrame frame;
        int frames = 0;
        double decodeMs = 0, convertMs = 0;
        std::vector<uint8_t> rgba(size_t(pipe.frameWidth()) * pipe.frameHeight() * 4);

        while (frames < 120 && src->readPacket(pkt)) {
            auto t0 = Clock::now();
            dec->decode(pkt);
            bool got = false;
            while (dec->nextFrame(frame)) got = true;
            decodeMs += msSince(t0);
            if (!got) continue;

            auto t1 = Clock::now();
            i420ToRgba(frame.y, frame.u, frame.v,
                       frame.strideY, frame.strideU, frame.strideV,
                       int(frame.width), int(frame.height), rgba.data(),
                       int(frame.width) * 4);
            convertMs += msSince(t1);
            frames++;
        }
        report("decode only (per frame)", decodeMs, frames);
        report("i420ToRgba (per frame)", convertMs, frames);
    }

    std::printf("\n");
    return 0;
}
