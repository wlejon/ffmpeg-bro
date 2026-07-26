// Drives a real media file through bro's VideoPipeline with the ffmpeg
// backend registered — the exact path <video> takes.
//
// This is a C++ test rather than a headless script deliberately: the things
// most likely to be wrong here (backend precedence, timestamp rescaling,
// B-frame reordering, seek + decoder flush, resampled audio) are all below the
// JS surface, and checking them from C++ means a failure points at the line
// that caused it instead of at a black rectangle.
//
// Usage: ffmpeg-bro-decodetest <media-file> [more files...]

#include "ffmpeg_backend.h"

#include "video/media_backend.h"
#include "video/video_pipeline.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

using namespace bro::video;

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const char* what) {
    std::printf("  %s  %s\n", ok ? "PASS" : "FAIL", what);
    g_checks++;
    if (!ok) g_failures++;
}

void checkf(bool ok, const char* fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    check(ok, buf);
}

// A frame is "not blank" if anything in it differs from the top-left pixel.
// Catches the classic silent failure: a decoder that returns success and
// hands back an all-green or all-black buffer.
bool hasContent(const std::vector<uint8_t>& rgba) {
    if (rgba.size() < 16) return false;
    for (size_t i = 4; i < rgba.size(); i += 4) {
        if (rgba[i] != rgba[0] || rgba[i + 1] != rgba[1] || rgba[i + 2] != rgba[2])
            return true;
    }
    return false;
}

void testFile(const std::string& path) {
    std::printf("\n%s\n", path.c_str());

    // ── the registry picks ffmpeg ──────────────────────────────────────────
    const MediaBackend* chosen = nullptr;
    for (const auto& be : mediaBackends()) {
        if (!be.open) continue;
        if (auto src = be.open(path)) { chosen = &be; break; }
    }
    checkf(chosen && chosen->name == "ffmpeg",
           "opened by the ffmpeg backend (got %s)", chosen ? chosen->name.c_str() : "none");

    // ── it opens through the pipeline ──────────────────────────────────────
    VideoPipeline pipe;
    if (!pipe.open(path)) {
        check(false, "VideoPipeline::open");
        return;
    }
    check(true, "VideoPipeline::open");
    checkf(pipe.frameWidth() > 0 && pipe.frameHeight() > 0,
           "dimensions known before first decode (%dx%d)",
           pipe.frameWidth(), pipe.frameHeight());
    checkf(pipe.durationNs() > 0, "duration reported (%.3f s)", pipe.durationNs() / 1e9);
    checkf(pipe.frameRate() > 0.0 && pipe.frameRate() < 1000.0,
           "frame rate reported (%.3f fps)", pipe.frameRate());

    // ── the first frame decodes and is not blank ───────────────────────────
    pipe.advanceTo(0);
    check(pipe.hasFrame(), "first frame decoded at t=0");
    check(hasContent(pipe.currentRgba()), "first frame has image content");
    checkf(pipe.currentRgba().size() ==
               size_t(pipe.frameWidth()) * pipe.frameHeight() * 4,
           "RGBA buffer sized for the frame");

    // ── timestamps advance monotonically, in step with wall time ───────────
    const TimeNs dur = pipe.durationNs();
    const TimeNs step = 40 * 1000000LL;   // 40 ms
    TimeNs last = -1;
    int backwards = 0, decoded = 0;
    for (TimeNs t = 0; t < dur && t < 5 * 1000000000LL; t += step) {
        if (pipe.advanceTo(t)) decoded++;
        if (pipe.currentPts() < last) backwards++;
        last = pipe.currentPts();
    }
    checkf(decoded > 0, "frames decoded while advancing (%d)", decoded);
    // The regression this guards: with B-frames, using the PACKET pts made
    // currentPts jump around in decode order instead of walking forward.
    checkf(backwards == 0, "presentation timestamps never go backwards (%d violations)",
           backwards);
    checkf(last > 0 && last <= dur + step,
           "final pts %.3f s inside the stream", last / 1e9);

    // ── seek lands where asked and does not replay stale frames ────────────
    if (dur > 2 * 1000000000LL) {
        const TimeNs target = dur / 2;
        pipe.seekTo(target);
        check(pipe.hasFrame(), "frame available after seek");
        check(hasContent(pipe.currentRgba()), "post-seek frame has image content");
        // The contract is the frame the instant falls INSIDE: the last one at
        // or before the target, so the delta is one frame at most and never
        // positive.
        const double delta = (pipe.currentPts() - target) / 1e9;
        checkf(delta > -0.2 && delta <= 0.0,
               "seek to %.3f s landed at %.3f s (delta %.3f s)",
               target / 1e9, pipe.currentPts() / 1e9, delta);

        // ── stepping moves by pictures, and is reversible ──────────────────
        // The emulation every player reaches for — currentTime += 1/fps —
        // cannot do this: with a 1/12800 timebase and B-frames the seconds
        // round trip misses the boundary and a back step lands where it
        // started.
        const TimeNs origin = pipe.currentPts();
        check(pipe.stepFrame(1), "step forward reports a move");
        checkf(pipe.currentPts() > origin, "step forward advanced (%.4f -> %.4f s)",
               origin / 1e9, pipe.currentPts() / 1e9);
        check(hasContent(pipe.currentRgba()), "stepped frame has image content");

        check(pipe.stepFrame(-1), "step back reports a move");
        checkf(pipe.currentPts() == origin,
               "step back returns to the exact frame (%.4f vs %.4f s)",
               pipe.currentPts() / 1e9, origin / 1e9);

        // Repeatedly, in both directions — the failure mode was a step that
        // silently did nothing every time.
        //
        // Sixty is chosen to cross at least one keyframe, which is where
        // backward stepping used to stall for good: a 1 ns step rounds to
        // nothing in the container's timebase, so a seek meant to land before
        // a keyframe landed on it, and the walk stopped dead at the top of
        // whatever GOP it had reached.
        const int WALK = 60;
        TimeNs walk = origin;
        int fwd = 0;
        for (int i = 0; i < WALK; ++i) {
            if (!pipe.stepFrame(1)) break;
            if (pipe.currentPts() <= walk) break;
            walk = pipe.currentPts();
            ++fwd;
        }
        checkf(fwd == WALK, "%d forward steps each moved (%d)", WALK, fwd);
        int back = 0;
        for (int i = 0; i < WALK; ++i) {
            if (!pipe.stepFrame(-1)) break;
            if (pipe.currentPts() >= walk) break;
            walk = pipe.currentPts();
            ++back;
        }
        checkf(back == WALK, "%d back steps each moved (%d)", WALK, back);
        checkf(pipe.currentPts() == origin, "the walk was exactly reversible");

        // And all the way to the start, however many keyframes are in the way.
        pipe.seekTo(dur / 8);
        TimeNs prev = pipe.currentPts();
        int steps = 0, stalls = 0;
        while (pipe.stepFrame(-1) && steps < 100000) {
            if (pipe.currentPts() >= prev) { ++stalls; break; }
            prev = pipe.currentPts();
            ++steps;
        }
        checkf(stalls == 0, "no stall while walking back (stopped at %.4f s)", prev / 1e9);
        checkf(steps > 0 && prev < dur / 8 / 4,
               "walked %d frames back to the start (%.4f s)", steps, prev / 1e9);

        // Nothing before the first frame.
        pipe.seekTo(0);
        check(!pipe.stepFrame(-1), "no frame before the first");

        // Seeking backwards must not resurrect frames from ahead of the
        // target — that is what decoder flush() is for.
        pipe.seekTo(0);
        checkf(pipe.currentPts() < 1000000000LL,
               "seek back to 0 landed at %.3f s", pipe.currentPts() / 1e9);
    }

    // ── audio decodes to sane PCM ──────────────────────────────────────────
    if (pipe.audioSampleRate() > 0) {
        checkf(pipe.audioChannels() > 0 && pipe.audioChannels() <= 8,
               "audio track: %u Hz, %u channels",
               pipe.audioSampleRate(), pipe.audioChannels());

        // Decode the audio through a second source, the way ElVideo does.
        const MediaBackend* be = nullptr;
        std::unique_ptr<MediaSource> src;
        for (const auto& b : mediaBackends()) {
            if (!b.open) continue;
            src = b.open(path);
            if (src) { be = &b; break; }
        }
        size_t totalSamples = 0;
        bool clipped = false;
        int decodedPackets = 0;
        if (src && be) {
            uint32_t audioTrack = 0;
            std::unique_ptr<AudioDecoder> dec;
            for (const auto& t : src->tracks()) {
                if (t.kind != TrackKind::Audio) continue;
                dec = be->makeAudioDecoder(t);
                if (dec) { audioTrack = t.id; break; }
            }
            check(dec != nullptr, "audio decoder created");
            MediaPacket pkt;
            AudioFrame frame;
            while (dec && src->readPacket(pkt)) {
                if (pkt.trackId != audioTrack) continue;
                if (!dec->decode(pkt, frame)) continue;
                decodedPackets++;
                totalSamples += frame.samples.size();
                for (float s : frame.samples) {
                    if (s < -1.5f || s > 1.5f) clipped = true;
                }
                if (decodedPackets > 2000) break;   // enough to be convincing
            }
        }
        checkf(decodedPackets > 0, "audio packets decoded (%d)", decodedPackets);
        checkf(totalSamples > 0, "PCM produced (%zu samples)", totalSamples);
        check(!clipped, "PCM is normalized float, within [-1.5, 1.5]");
    } else {
        std::printf("  ----  no audio track\n");
    }
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <media-file> [more...]\n", argv[0]);
        return 2;
    }

    ffmpegbro::registerFfmpegBackend();

    // The version/probe surface the UI reads.
    std::printf("%s\n", ffmpegbro::libavVersion().c_str());
    auto hw = ffmpegbro::availableHwAccels();
    std::printf("hwaccels:");
    for (const auto& h : hw) std::printf(" %s", h.c_str());
    std::printf("%s\n", hw.empty() ? " (none)" : "");

    for (int i = 1; i < argc; ++i) {
        testFile(argv[i]);

        // probe() must agree with what the pipeline actually opened.
        auto p = ffmpegbro::probeMedia(argv[i]);
        checkf(p.ok, "probe succeeded (%s)", p.ok ? p.formatName.c_str() : p.error.c_str());
        checkf(p.durationSec > 0, "probe duration %.3f s", p.durationSec);
        checkf(!p.streams.empty(), "probe found %zu streams", p.streams.size());
    }

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
