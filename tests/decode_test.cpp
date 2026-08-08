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
//                              [--rotated <file>] [--sound-only <file>]
//
// The two named arguments are for the fixtures whose whole point is one fact —
// a display matrix on the stream, and a file with no video stream in it. Named
// rather than positional because what is asserted about each is *that* fact,
// and a test that guessed which file was which from its name would be one
// rename away from asserting nothing.

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
    pipe.settleAt(0);
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
        if (pipe.settleAt(t)) decoded++;
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
        pipe.settleAt(target);
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
        pipe.settleAt(dur / 8);
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
        pipe.settleAt(0);
        check(!pipe.stepFrame(-1), "no frame before the first");

        // And the file really ends where it says it does. H.264 and HEVC hand
        // pictures back several frames late and hold a whole reorder buffer
        // until the stream ends; without draining the decoder at end of stream
        // that buffer — sixteen pictures for HEVC — is simply never shown, and
        // the last second of the file does not exist as far as playback is
        // concerned.
        const TimeNs nearEnd = dur > 3000000000LL ? dur - 3000000000LL : 0;
        pipe.seekTo(nearEnd);
        pipe.settleAt(nearEnd);
        TimeNs lastPts = pipe.currentPts();
        int forward = 0;
        while (pipe.stepFrame(1) && forward < 100000) {
            if (pipe.currentPts() <= lastPts) break;
            lastPts = pipe.currentPts();
            ++forward;
        }
        const double frameSec = pipe.frameRate() > 0 ? 1.0 / pipe.frameRate() : 1.0 / 25.0;
        checkf(forward > 0, "stepped %d frames to the end of the file", forward);
        checkf((dur - lastPts) / 1e9 < frameSec * 2.5,
               "the last picture is %.2f frames from the end (%.4f s of %.4f s)",
               ((dur - lastPts) / 1e9) / frameSec, lastPts / 1e9, dur / 1e9);
        check(pipe.isEnded(), "and the pipeline reports the file ended");

        // Seeking backwards must not resurrect frames from ahead of the
        // target — that is what decoder flush() is for.
        pipe.seekTo(0);
        pipe.settleAt(0);
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

// ── a clip recorded sideways ───────────────────────────────────────────────
//
// The decoder hands the picture back as it was coded; only the container's
// display matrix says which way up it is meant to be seen. `TrackInfo` carries
// it now, so the size a page lays a clip out at is the *shown* size and the two
// differ by a swap at a quarter turn. Nothing about this is visible in the
// pixels, which is why it needs a fixture with the side datum on it and why
// every check below is about the metadata rather than about the picture.
void testRotated(const std::string& path) {
    std::printf("\n%s (rotated)\n", path.c_str());

    // What the file says, asked of the probe the UI reads.
    auto p = ffmpegbro::probeMedia(path);
    checkf(p.ok, "probe succeeded (%s)", p.ok ? p.formatName.c_str() : p.error.c_str());
    const ffmpegbro::StreamSummary* v = nullptr;
    for (const auto& s : p.streams) if (s.kind == "video") { v = &s; break; }
    check(v != nullptr, "the fixture has a video stream");
    if (!v) return;
    checkf(v->rotation == 90, "probe reports a 90 degree rotation (got %d)", v->rotation);

    // And what the *backend* says, which is the number bro lays out against.
    // Two readings of one display matrix is exactly the bug this fixture is
    // here to catch, so both are asserted and they have to agree.
    VideoPipeline pipe;
    if (!pipe.open(path)) { check(false, "VideoPipeline::open"); return; }
    checkf(pipe.rotationDegrees() == 90, "the track reports 90 degrees clockwise (got %d)",
           pipe.rotationDegrees());
    checkf(pipe.frameWidth() == v->width && pipe.frameHeight() == v->height,
           "the frames are still the coded size (%dx%d)", pipe.frameWidth(), pipe.frameHeight());
    checkf(pipe.displayWidth() == pipe.frameHeight() &&
               pipe.displayHeight() == pipe.frameWidth(),
           "and are shown swapped (%dx%d)", pipe.displayWidth(), pipe.displayHeight());

    // A rotated file still decodes like any other: the correction is
    // presentation and the pictures are untouched.
    pipe.settleAt(0);
    check(pipe.hasFrame(), "first frame decoded");
    check(hasContent(pipe.currentRgba()), "and it has image content");
    checkf(pipe.currentRgba().size() ==
               size_t(pipe.frameWidth()) * pipe.frameHeight() * 4,
           "RGBA buffer is sized for the coded frame, not the shown one");
}

// ── a file with no picture in it ───────────────────────────────────────────
//
// bro's pipeline takes a source when *either* half of it decodes, so a file of
// sound plays: it has a duration, a clock that advances, an end that fires
// once, and no frames to step. Everything here is the mirror image of what
// `testFile` asserts about a file with pictures.
void testSoundOnly(const std::string& path) {
    std::printf("\n%s (sound only)\n", path.c_str());

    auto p = ffmpegbro::probeMedia(path);
    checkf(p.ok, "probe succeeded (%s)", p.ok ? p.formatName.c_str() : p.error.c_str());
    bool anyVideo = false;
    for (const auto& s : p.streams) if (s.kind == "video") anyVideo = true;
    check(!anyVideo, "the fixture really has no video stream in it");

    VideoPipeline pipe;
    if (!pipe.open(path)) { check(false, "VideoPipeline::open on a file with no picture"); return; }
    check(true, "VideoPipeline::open");
    check(!pipe.hasVideo(), "the pipeline says it has no picture");
    checkf(pipe.durationNs() > 0, "duration comes off the audio track (%.3f s)",
           pipe.durationNs() / 1e9);
    checkf(pipe.audioSampleRate() > 0 && pipe.audioChannels() > 0,
           "audio track: %u Hz, %u channels", pipe.audioSampleRate(), pipe.audioChannels());
    check(pipe.frameWidth() == 0 && pipe.frameHeight() == 0,
          "and reports no frame size, rather than a plausible one");

    // The clock is the media clock: there are no pictures for it to be the
    // timestamps of. Advancing has to move it and never move it backwards.
    const TimeNs dur = pipe.durationNs();
    pipe.settleAt(0);
    TimeNs last = -1;
    int backwards = 0;
    for (TimeNs t = 0; t < dur; t += 100 * 1000000LL) {
        pipe.settleAt(t);
        if (pipe.currentPts() < last) backwards++;
        last = pipe.currentPts();
    }
    checkf(backwards == 0, "the clock never goes backwards (%d violations)", backwards);
    checkf(last > dur / 2, "and reached %.3f s of %.3f s", last / 1e9, dur / 1e9);
    check(!pipe.stepFrame(1), "there is no frame to step to");
    check(!pipe.hasFrame(), "and never a frame to show");

    // A seek re-arms the end, which is what makes playing it twice work.
    pipe.seekTo(0);
    pipe.settleAt(0);
    checkf(pipe.currentPts() < 500 * 1000000LL, "seek back to 0 landed at %.3f s",
           pipe.currentPts() / 1e9);
}

} // namespace

int main(int argc, char* argv[]) {
    // Unbuffered, because a test that dies mid-run has to have said how far it
    // got. Through a pipe stdout is fully buffered, so a crash discards every
    // line printed before it and the failure reads as "nothing ran".
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <media-file> [more...] "
                             "[--rotated <file>] [--sound-only <file>]\n", argv[0]);
        return 2;
    }

    ffmpegbro::registerFfmpegBackend();

    // The version/probe surface the UI reads.
    std::printf("%s\n", ffmpegbro::libavVersion().c_str());
    auto hw = ffmpegbro::availableHwAccels();
    std::printf("hwaccels:");
    for (const auto& h : hw) std::printf(" %s", h.c_str());
    std::printf("%s\n", hw.empty() ? " (none)" : "");

    std::vector<std::string> plain;
    std::string rotated, soundOnly;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--rotated" && i + 1 < argc) rotated = argv[++i];
        else if (arg == "--sound-only" && i + 1 < argc) soundOnly = argv[++i];
        else plain.push_back(arg);
    }

    for (const auto& path : plain) {
        testFile(path);

        // probe() must agree with what the pipeline actually opened.
        auto p = ffmpegbro::probeMedia(path);
        checkf(p.ok, "probe succeeded (%s)", p.ok ? p.formatName.c_str() : p.error.c_str());
        checkf(p.durationSec > 0, "probe duration %.3f s", p.durationSec);
        checkf(!p.streams.empty(), "probe found %zu streams", p.streams.size());
    }

    if (!rotated.empty()) testRotated(rotated);
    if (!soundOnly.empty()) testSoundOnly(soundOnly);

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
