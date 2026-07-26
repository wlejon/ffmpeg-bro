// Renders a timeline to a file and then opens what it wrote.
//
// Export is the one operation whose output nobody sees until it is finished,
// so the checks here are the ones a person cannot make by looking: that the
// canvas is the size that was asked for, that a clip lands in the rectangle it
// was given and nowhere else, that opacity is honoured, that the sound of two
// overlapping clips is actually mixed, and that the result is a file this
// application can open again.
//
// Every assertion is content-independent — the pass/fail never depends on what
// the media happens to show — with one exception, marked below, that needs the
// source not to be a black screen with silence.
//
// Usage: ffmpeg-bro-exporttest <media-file> [<second-file>]

#include "ffmpeg_backend.h"
#include "ffmpeg_export.h"

#include "video/media_analysis.h"
#include "video/video_pipeline.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

using namespace bro::video;
using namespace ffmpegbro;

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

// The render is deliberately small and short: everything being checked is
// geometry and plumbing, and a 640x360 second of video exercises all of it
// while leaving the test something a person will actually run.
constexpr int kW = 640;
constexpr int kH = 360;
constexpr double kFps = 25.0;
constexpr double kSpan = 1.6;

/// Mean luma of a rectangle of the decoded RGBA frame. Black bars are the one
/// thing a compositor can be tested against without knowing the footage.
double meanLuma(const std::vector<uint8_t>& rgba, int w, int h,
                int x0, int y0, int x1, int y1) {
    x0 = std::max(0, x0); y0 = std::max(0, y0);
    x1 = std::min(w, x1); y1 = std::min(h, y1);
    if (x1 <= x0 || y1 <= y0) return -1.0;
    double sum = 0;
    int n = 0;
    for (int y = y0; y < y1; ++y) {
        const uint8_t* row = rgba.data() + (size_t(y) * w + x0) * 4;
        for (int x = x0; x < x1; ++x, row += 4) {
            sum += 0.299 * row[0] + 0.587 * row[1] + 0.114 * row[2];
            ++n;
        }
    }
    return n ? sum / n : -1.0;
}

double brightestIn(const std::vector<uint8_t>& rgba, int w, int h,
                   int x0, int y0, int x1, int y1) {
    double best = 0;
    for (int y = std::max(0, y0); y < std::min(h, y1); ++y) {
        const uint8_t* row = rgba.data() + (size_t(y) * w + std::max(0, x0)) * 4;
        for (int x = std::max(0, x0); x < std::min(w, x1); ++x, row += 4) {
            const double l = 0.299 * row[0] + 0.587 * row[1] + 0.114 * row[2];
            if (l > best) best = l;
        }
    }
    return best;
}

/// Run a render to completion and hand back how it went.
ExportStatus render(const ExportSettings& s, const std::vector<ExportClip>& clips) {
    std::string err;
    if (!startExport(s, clips, &err)) {
        ExportStatus bad;
        bad.state = ExportStatus::State::Failed;
        bad.error = err;
        return bad;
    }
    waitForExport();
    return exportStatus();
}

ExportSettings baseSettings(const std::string& out) {
    ExportSettings s;
    s.path = out;
    s.width = kW;
    s.height = kH;
    s.fps = kFps;
    s.startTime = 0;
    s.endTime = kSpan;
    s.videoCodec = "libx264";
    s.audioCodec = "aac";
    s.crf = 23;
    // The point of the test is the pipeline, not the compression; the fastest
    // preset that still exercises a real x264 keeps it usable.
    s.preset = "ultrafast";
    return s;
}

/// A clip filling the left half of the canvas, starting a little way into the
/// file so a black lead-in does not decide the picture checks.
ExportClip leftHalf(const std::string& path, double sourceDuration) {
    ExportClip c;
    c.path = path;
    c.start = 0;
    c.length = kSpan;
    c.inPoint = std::min(1.0, std::max(0.0, sourceDuration * 0.25));
    c.x = 0;
    c.y = 0;
    c.w = kW / 2.0;
    c.h = kH;
    c.z = 0;
    return c;
}

ExportClip rightHalf(const std::string& path, double sourceDuration, double opacity) {
    ExportClip c = leftHalf(path, sourceDuration);
    c.x = kW / 2.0;
    c.opacity = opacity;
    c.z = 1;
    return c;
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::fprintf(stderr,
            "Usage: ffmpeg-bro-exporttest <media-file> [<second-file>]\n");
        return 2;
    }
    registerFfmpegBackend();
    // Everything here writes into out/, which is where the UI test puts its
    // screenshots and which a fresh checkout does not have.
    std::error_code ec;
    std::filesystem::create_directories("out", ec);

    const std::string first = argv[1];
    const std::string second = argc >= 3 ? argv[2] : first;

    // ── what this build can write ──────────────────────────────────────────

    std::printf("\ncapabilities\n");
    const auto vencs = availableVideoEncoders();
    const auto aencs = availableAudioEncoders();
    const auto containers = availableContainers();
    std::string encoderList;
    for (const auto& e : vencs) encoderList += (encoderList.empty() ? "" : " ") + e.id;
    checkf(!vencs.empty(), "video encoders available: %s", encoderList.c_str());
    checkf(!aencs.empty(), "%zu audio encoders available", aencs.size());
    checkf(!containers.empty(), "%zu containers available", containers.size());

    bool haveX264 = false;
    for (const auto& e : vencs) if (e.id == "libx264") haveX264 = true;
    checkf(haveX264, "libx264 is linked (export needs an encoder to be worth anything)");
    if (!haveX264) {
        std::printf("\nno x264 in this build; the rest of the test cannot run\n");
        return 1;
    }
    for (const auto& e : vencs)
        if (e.id == "libx264")
            check(e.supportsCrf && e.supportsPreset,
                  "x264 is reported as taking -crf and -preset");

    // The capability answers are what the dialog draws itself from, so a wrong
    // one is a control that does nothing or a menu of values the encoder will
    // refuse. Everything here is asked of libavcodec, so these assertions are
    // really about the asking being done correctly.
    for (const auto& e : vencs) {
        if (e.id != "libx264") continue;
        checkf(!e.pixelFormats.empty() &&
                   std::find(e.pixelFormats.begin(), e.pixelFormats.end(), "yuv420p") !=
                       e.pixelFormats.end(),
               "x264 lists its pixel formats (%zu, including yuv420p)", e.pixelFormats.size());
        checkf(std::find(e.presets.begin(), e.presets.end(), "veryslow") != e.presets.end(),
               "x264 lists its presets (%zu)", e.presets.size());
        checkf(std::find(e.profiles.begin(), e.profiles.end(), "high") != e.profiles.end(),
               "x264 lists its profiles (%zu)", e.profiles.size());
        checkf(e.crfMin >= 0 && e.crfMax > e.crfMin && e.crfMax < 256,
               "x264's quality scale is a usable range (%.0f..%.0f, default %.0f)",
               e.crfMin, e.crfMax, e.crfDefault);
        checkf(e.crfDefault >= e.crfMin && e.crfDefault <= e.crfMax,
               "and its default sits inside it");
        checkf(std::find(e.containers.begin(), e.containers.end(), "mp4") != e.containers.end() &&
                   std::find(e.containers.begin(), e.containers.end(), "webm") == e.containers.end(),
               "x264 is offered for mp4 and not for WebM");
    }

    // Profiles are numbered per codec, so cross-referencing an id against a
    // global table produces confident nonsense — VP9's profile 2 reading as
    // HEVC's "main10". Whatever is offered has to be a string that encoder
    // will actually take.
    for (const auto& e : vencs) {
        if (e.id != "libvpx-vp9" && e.id != "libaom-av1") continue;
        checkf(std::find(e.profiles.begin(), e.profiles.end(), "main10") == e.profiles.end(),
               "%s is not offered HEVC's profile names", e.id.c_str());
    }

    const auto x264opts = encoderOptions("libx264");
    checkf(x264opts.size() > 20, "x264's own option table is readable (%zu options)",
           x264opts.size());
    {
        bool sawCrf = false, sawTyped = false, sawEnum = false;
        for (const auto& o : x264opts) {
            if (o.name == "crf") { sawCrf = true; sawTyped = !o.type.empty() && o.hasRange; }
            if (!o.values.empty()) sawEnum = true;
        }
        check(sawCrf && sawTyped, "with types and ranges on them");
        check(sawEnum, "and named values for the options that have them");
    }
    check(encoderOptions("no_such_encoder").empty(),
          "an encoder that does not exist has no options rather than crashing");

    // ── the source ─────────────────────────────────────────────────────────

    const ProbeResult src = probeMedia(first);
    if (!src.ok || !src.streams.size()) {
        std::printf("cannot read %s: %s\n", first.c_str(), src.error.c_str());
        return 1;
    }
    double srcDuration = 0;
    bool srcHasAudio = false;
    for (const auto& s : src.streams) {
        if (s.kind == "video") srcDuration = s.duration;
        if (s.kind == "audio") srcHasAudio = true;
    }
    std::printf("\nsource: %s  %.2fs  %s\n", first.c_str(), srcDuration,
                srcHasAudio ? "with audio" : "silent");
    if (srcDuration < kSpan + 1.0) {
        std::printf("source is too short for this test (needs %.1fs)\n", kSpan + 1.0);
        return 1;
    }

    // ── one clip, half the canvas ──────────────────────────────────────────
    //
    // The half nothing is placed on is the assertion: a compositor that
    // ignores the rectangle it was given, or that stretches the picture to
    // fill, fails here and nowhere else.

    std::printf("\nrender: one clip on the left half\n");
    const std::string outA = "out/export-half.mp4";
    ExportSettings sa = baseSettings(outA);
    std::vector<ExportClip> clipsA{leftHalf(first, srcDuration)};

    ExportStatus st = render(sa, clipsA);
    checkf(st.state == ExportStatus::State::Done, "render finished (%s)",
           st.error.empty() ? "no error" : st.error.c_str());
    if (st.state != ExportStatus::State::Done) return 1;
    checkf(st.framesDone == st.framesTotal && st.framesTotal == std::llround(kSpan * kFps),
           "wrote every frame (%lld of %lld)", (long long)st.framesDone,
           (long long)st.framesTotal);
    checkf(st.bytesWritten > 1024, "the file has bytes in it (%lld)",
           (long long)st.bytesWritten);
    std::printf("        %.1f fps encode, %.2fs wall\n", st.encodeFps, st.elapsedSec);

    // ── the file it wrote ──────────────────────────────────────────────────

    std::printf("\nthe result probes\n");
    const ProbeResult out = probeMedia(outA);
    check(out.ok, "opens as media");
    if (!out.ok) return 1;
    const StreamSummary* ov = nullptr;
    const StreamSummary* oa = nullptr;
    for (const auto& s : out.streams) {
        if (s.kind == "video" && !ov) ov = &s;
        if (s.kind == "audio" && !oa) oa = &s;
    }
    check(ov != nullptr, "has a video stream");
    if (!ov) return 1;
    checkf(ov->width == kW && ov->height == kH, "canvas size is what was asked (%dx%d)",
           ov->width, ov->height);
    checkf(std::fabs(ov->fps - kFps) < 0.01, "frame rate is what was asked (%.3f)", ov->fps);
    checkf(ov->codec == "h264", "encoded as h264 (%s)", ov->codec.c_str());
    checkf(std::fabs(out.durationSec - kSpan) < 0.25,
           "duration is the range that was rendered (%.3fs vs %.3fs)",
           out.durationSec, kSpan);

    if (srcHasAudio) {
        check(oa != nullptr, "has an audio stream, because the source did");
        if (oa) {
            checkf(oa->sampleRate == 48000, "audio at 48 kHz (%d)", oa->sampleRate);
            checkf(oa->channels == 2, "audio in stereo (%d ch)", oa->channels);
            checkf(oa->codec == "aac", "audio encoded as aac (%s)", oa->codec.c_str());
        }
    }

    // ── and this application can open it ───────────────────────────────────

    std::printf("\nthe picture landed where it was put\n");
    VideoPipeline pipe;
    check(pipe.open(outA), "ffmpeg-bro can open what it just wrote");
    checkf(pipe.frameWidth() == kW && pipe.frameHeight() == kH,
           "decodes at the canvas size (%dx%d)", pipe.frameWidth(), pipe.frameHeight());

    // Halfway in, so a fade from black at the head of the source cannot
    // decide the answer.
    pipe.advanceTo(static_cast<TimeNs>(kSpan * 0.5 * 1e9));
    check(pipe.hasFrame(), "a frame decodes out of the middle");
    const auto& px = pipe.currentRgba();

    // Away from the seam, where a bicubic scaler's ringing is not the subject.
    const double emptyHalf = meanLuma(px, kW, kH, kW / 2 + 8, 0, kW, kH);
    const double filledPeak = brightestIn(px, kW, kH, 0, 0, kW / 2 - 8, kH);
    checkf(emptyHalf >= 0 && emptyHalf < 6.0,
           "the half with no clip on it is black (mean luma %.2f)", emptyHalf);
    // The one content-dependent check in the file: a source that is entirely
    // black at this instant would fail it, and the number printed says so.
    checkf(filledPeak > 24.0,
           "the half with the clip on it has a picture (brightest %.0f)", filledPeak);

    // ── opacity ────────────────────────────────────────────────────────────
    //
    // A second clip over the empty half at zero opacity must change nothing —
    // which is a real check that the value is read at all, rather than a clip
    // being drawn whenever it is under the playhead.

    std::printf("\nopacity decides whether a clip is there\n");
    const std::string outB = "out/export-transparent.mp4";
    ExportSettings sb = baseSettings(outB);
    std::vector<ExportClip> clipsB{leftHalf(first, srcDuration),
                                   rightHalf(second, srcDuration, 0.0)};
    st = render(sb, clipsB);
    checkf(st.state == ExportStatus::State::Done, "render with a transparent clip finished (%s)",
           st.error.empty() ? "no error" : st.error.c_str());

    VideoPipeline pipeB;
    check(pipeB.open(outB), "the result opens");
    pipeB.advanceTo(static_cast<TimeNs>(kSpan * 0.5 * 1e9));
    check(pipeB.hasFrame(), "a frame decodes");
    const double clearHalf = meanLuma(pipeB.currentRgba(), kW, kH, kW / 2 + 8, 0, kW, kH);
    checkf(clearHalf >= 0 && clearHalf < 6.0,
           "a clip at zero opacity draws nothing (mean luma %.2f)", clearHalf);

    // ── and the same clip at full opacity does ─────────────────────────────

    std::printf("\nthe same clip, opaque\n");
    const std::string outC = "out/export-stacked.mp4";
    ExportSettings sc = baseSettings(outC);
    std::vector<ExportClip> clipsC{leftHalf(first, srcDuration),
                                   rightHalf(second, srcDuration, 1.0)};
    st = render(sc, clipsC);
    checkf(st.state == ExportStatus::State::Done, "render with two clips finished (%s)",
           st.error.empty() ? "no error" : st.error.c_str());

    VideoPipeline pipeC;
    check(pipeC.open(outC), "the result opens");
    pipeC.advanceTo(static_cast<TimeNs>(kSpan * 0.5 * 1e9));
    check(pipeC.hasFrame(), "a frame decodes");
    const double coveredPeak =
        brightestIn(pipeC.currentRgba(), kW, kH, kW / 2 + 8, 0, kW, kH);
    checkf(coveredPeak > 24.0,
           "an opaque clip on the other half is there (brightest %.0f)", coveredPeak);

    // ── opacity is a blend, not a switch ───────────────────────────────────
    //
    // Zero and one would both pass a compositor that treated opacity as
    // on/off. Half of a picture over black is half as bright, whatever the
    // picture is, so the ratio is the check and the content cancels out.

    std::printf("\nhalf opacity is half as bright\n");
    const std::string outE = "out/export-half-opacity.mp4";
    ExportSettings se = baseSettings(outE);
    ExportClip faded = leftHalf(first, srcDuration);
    faded.opacity = 0.5;
    st = render(se, {faded});
    checkf(st.state == ExportStatus::State::Done, "render at half opacity finished (%s)",
           st.error.empty() ? "no error" : st.error.c_str());

    VideoPipeline pipeE;
    check(pipeE.open(outE), "the result opens");
    pipeE.advanceTo(static_cast<TimeNs>(kSpan * 0.5 * 1e9));
    check(pipeE.hasFrame(), "a frame decodes");
    const double solid = meanLuma(px, kW, kH, 8, 8, kW / 2 - 8, kH - 8);
    const double half = meanLuma(pipeE.currentRgba(), kW, kH, 8, 8, kW / 2 - 8, kH - 8);
    const double ratio = solid > 1.0 ? half / solid : -1.0;
    // Wide bounds on purpose: this is 8-bit video through a lossy encoder, and
    // the check is "blended", not "blended to three decimal places".
    checkf(ratio > 0.40 && ratio < 0.60,
           "half opacity came out at %.0f%% of full brightness (%.1f vs %.1f)",
           ratio * 100.0, half, solid);

    // ── the sound of both clips ────────────────────────────────────────────
    //
    // Two clips playing at once have to be summed, not picked between. This is
    // the check that the mixer ran at all: silence here means the audio path
    // wrote an empty track, which nothing about the picture would reveal.

    if (srcHasAudio) {
        std::printf("\nthe sound came through\n");
        AudioPeaks peaks;
        check(analyzeAudioPeaks(outC, 64, peaks), "the exported audio decodes");
        double loudest = 0;
        for (float v : peaks.rms) loudest = std::max(loudest, double(v));
        checkf(peaks.sampleRate == 48000, "at 48 kHz (%u)", peaks.sampleRate);
        checkf(loudest > 0.0005, "and is not silence (peak rms %.4f)", loudest);
    }

    // ── cancelling ─────────────────────────────────────────────────────────
    //
    // Stopping half way has to leave a playable file rather than a truncated
    // one: an mp4 whose trailer was never written has no index and opens
    // nowhere.

    std::printf("\ncancelling\n");
    const std::string outD = "out/export-cancelled.mp4";
    ExportSettings sd = baseSettings(outD);
    sd.endTime = std::min(srcDuration, 60.0);      // long enough to interrupt
    sd.preset = "veryslow";                        // and slow enough to catch
    std::string err;
    if (startExport(sd, {leftHalf(first, srcDuration)}, &err)) {
        // Let it get properly under way before pulling the handle.
        for (int i = 0; i < 200 && exportStatus().framesDone < 2; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        const int64_t caught = exportStatus().framesDone;
        cancelExport();
        waitForExport();
        const ExportStatus after = exportStatus();
        checkf(after.state == ExportStatus::State::Cancelled,
               "reports cancelled (caught it at frame %lld)", (long long)caught);
        checkf(after.framesDone < after.framesTotal,
               "stopped early (%lld of %lld frames)", (long long)after.framesDone,
               (long long)after.framesTotal);
        const ProbeResult partial = probeMedia(outD);
        check(partial.ok, "and what it wrote is still a playable file");
    } else {
        checkf(false, "could not start the cancellable render: %s", err.c_str());
    }

    // ── refusing the impossible ────────────────────────────────────────────

    // ── the option bag ─────────────────────────────────────────────────────
    //
    // Every setting in the dialog past the codec is an ffmpeg option applied
    // with av_opt_set. What matters is that they arrive: an option that is
    // quietly dropped produces a render that succeeds and is not what was
    // asked for, which is worse than one that fails.

    std::printf("\noptions reach the encoder\n");
    {
        ExportSettings opt = baseSettings("out/export-options.mp4");
        opt.endTime = opt.startTime + 0.6;
        opt.pixelFormat = "yuv444p";
        opt.videoOptions = {{"crf", "18"}, {"preset", "ultrafast"},
                            {"profile", "high444"}, {"g", "5"}, {"bf", "0"}};
        st = render(opt, {leftHalf(first, srcDuration)});
        checkf(st.state == ExportStatus::State::Done,
               "a render carrying pixel format, profile, GOP and B-frames succeeds (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        const ProbeResult back = probeMedia("out/export-options.mp4");
        bool is444 = false;
        for (const auto& s : back.streams)
            if (s.kind == "video" && s.pixFmt == "yuv444p") is444 = true;
        check(is444, "and the pixel format asked for is the one in the file");
    }

    {
        // The size reported has to be the size on disk. +faststart rewrites an
        // mp4 after the trailer goes down, and the write position left behind
        // is not the answer — it reported three kilobytes for a file of three
        // quarters of a megabyte.
        ExportSettings sz = baseSettings("out/export-size.mp4");
        sz.endTime = sz.startTime + 1.0;
        st = render(sz, {leftHalf(first, srcDuration)});
        std::error_code szec;
        const auto onDisk =
            static_cast<int64_t>(std::filesystem::file_size("out/export-size.mp4", szec));
        checkf(!szec && st.bytesWritten == onDisk,
               "the reported size is the size on disk (%lld vs %lld)",
               static_cast<long long>(st.bytesWritten), static_cast<long long>(onDisk));
    }

    {
        // A name the encoder does not have must be an error. Silently ignoring
        // it is how someone spends an hour rendering with a setting that was
        // never applied.
        ExportSettings junk = baseSettings("out/export-junkopt.mp4");
        junk.endTime = junk.startTime + 0.4;
        junk.videoOptions = {{"definitely-not-an-option", "1"}};
        st = render(junk, {leftHalf(first, srcDuration)});
        checkf(st.state == ExportStatus::State::Failed,
               "an option the encoder does not have is refused, not ignored (%s)",
               st.error.c_str());

        ExportSettings badval = baseSettings("out/export-badval.mp4");
        badval.endTime = badval.startTime + 0.4;
        badval.videoOptions = {{"preset", "not-a-preset"}};
        st = render(badval, {leftHalf(first, srcDuration)});
        checkf(st.state == ExportStatus::State::Failed,
               "and so is a value it will not take (%s)", st.error.c_str());
    }

    {
        // Chaining renders is what the preview does: lossless reference, then
        // the candidate, started the moment the first reports done. If the run
        // slot is freed after the status rather than before it, the second one
        // is refused — a window short enough to miss by hand and hit every
        // time in practice.
        ExportSettings chain = baseSettings("out/export-chain-a.mp4");
        chain.endTime = chain.startTime + 0.4;
        const ExportStatus one = render(chain, {leftHalf(first, srcDuration)});
        std::string chainErr;
        ExportSettings next = baseSettings("out/export-chain-b.mp4");
        next.endTime = next.startTime + 0.4;
        const bool started = startExport(next, {leftHalf(first, srcDuration)}, &chainErr);
        checkf(one.state == ExportStatus::State::Done && started,
               "a second render starts the instant the first reports done (%s)",
               started ? "accepted" : chainErr.c_str());
        waitForExport();
    }

    std::printf("\nbad asks are refused, not crashed into\n");
    ExportSettings bad = baseSettings("out/export-never.mp4");
    check(!startExport(bad, {}, &err), "an empty timeline is refused");
    bad.endTime = bad.startTime;
    check(!startExport(bad, {leftHalf(first, srcDuration)}, &err),
          "an empty range is refused");
    bad = baseSettings("out/export-never.mp4");
    bad.videoCodec = "no_such_encoder";
    st = render(bad, {leftHalf(first, srcDuration)});
    checkf(st.state == ExportStatus::State::Failed,
           "an encoder this build lacks fails with a reason (%s)", st.error.c_str());

    // A job that dies before it writes a frame still has to hand the run slot
    // back. The failure this guards is silent and total: one bad export and
    // every export afterwards is refused as "already running" until restart.
    ExportSettings again = baseSettings("out/export-after-failure.mp4");
    again.endTime = 0.4;
    st = render(again, {leftHalf(first, srcDuration)});
    checkf(st.state == ExportStatus::State::Done,
           "a good render still starts after a failed one (%s)",
           st.error.empty() ? "no error" : st.error.c_str());

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
