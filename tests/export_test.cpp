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
#include "ffmpeg_capabilities.h"
#include "ffmpeg_report.h"

#include "video/media_analysis.h"
#include "video/video_pipeline.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
#include <libavutil/log.h>
}

#include <algorithm>
#include <fstream>
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

/// How alike two decoded frames are, in dB. The comparison the two render
/// paths need: "the same picture" is not a thing that can be asserted exactly
/// once two encoders have been through it, and a threshold on a mean squared
/// error is what everyone else measures a codec with.
///
/// Alpha is skipped — it comes back constant out of a decoded video and would
/// only inflate the number.
double psnr(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b, int w, int h) {
    const size_t want = static_cast<size_t>(w) * h * 4;
    if (a.size() < want || b.size() < want) return -1.0;
    double se = 0;
    size_t n = 0;
    for (size_t i = 0; i < want; i += 4)
        for (int c = 0; c < 3; ++c, ++n) {
            const double d = static_cast<double>(a[i + c]) - b[i + c];
            se += d * d;
        }
    if (!n) return -1.0;
    const double mse = se / static_cast<double>(n);
    return mse <= 0 ? 99.0 : 10.0 * std::log10(255.0 * 255.0 / mse);
}

/// The matrix a source will be decoded through, named the way the `scale`
/// filter wants to hear it.
///
/// This is `swsSpaceFor()` in export_frame.cpp and `sourceColor()` in
/// ui/graph/derive.js written a third time, which is the point: if the three
/// ever disagree, the two render paths produce different colours and the check
/// below is what says so.
std::string matrixName(const std::string& tag, int height) {
    if (tag == "bt709") return "bt709";
    if (tag == "bt470bg") return "bt601";
    if (tag == "smpte170m") return "smpte170m";
    if (tag == "smpte240m") return "smpte240m";
    if (tag == "bt2020nc" || tag == "bt2020_ncl") return "bt2020";
    return height >= 720 ? "bt709" : "bt601";
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

/// A file opened with libavformat, closed when it goes out of scope.
///
/// probeMedia() answers the questions playback asks, and a stream list has to
/// be checked against the ones it does not: a disposition beyond "default", the
/// fourcc in codecpar, the attachment's mimetype, the chapter table. Those are
/// what the writer was told to put in the file, so they are what reading it
/// back has to look at.
struct Opened {
    AVFormatContext* fc = nullptr;
    explicit Opened(const std::string& path) {
        if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0) { fc = nullptr; return; }
        if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); fc = nullptr; }
    }
    ~Opened() { if (fc) avformat_close_input(&fc); }
    Opened(const Opened&) = delete;
    Opened& operator=(const Opened&) = delete;
    explicit operator bool() const { return fc != nullptr; }
};

/// One metadata value off a stream, or "" — the shape every check below wants.
std::string meta(const AVStream* st, const char* key) {
    const AVDictionaryEntry* e = st ? av_dict_get(st->metadata, key, nullptr, 0) : nullptr;
    return e && e->value ? e->value : "";
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
    // Unbuffered, because a test that dies mid-run has to have said how far it
    // got. Through a pipe stdout is fully buffered, so a crash discards every
    // line printed before it and the failure reads as "nothing ran".
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    // Before anything logs, exactly as main.cpp does it. The report is checked
    // below, and a capture installed half way through would only ever hold the
    // second half of the story.
    installLogCapture();
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
    const auto containers = availableMuxers();
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

    // The filter list is the palette the graph stage picks from, and the same
    // argument applies: offering a filter this build does not link is a menu
    // entry that fails at the last step.
    {
        const auto filters = availableFilters();
        checkf(filters.size() > 100, "libavfilter reports its filters (%zu)", filters.size());
        const FilterInfo* overlay = nullptr;
        const FilterInfo* amix = nullptr;
        const FilterInfo* color = nullptr;
        for (const auto& f : filters) {
            if (f.name == "overlay") overlay = &f;
            if (f.name == "amix") amix = &f;
            if (f.name == "color") color = &f;
        }
        check(overlay && overlay->inputs == "vv" && overlay->outputs == "v",
              "overlay is reported as two pictures in and one out");
        check(amix && amix->dynamicInputs && amix->outputs == "a",
              "amix is reported as taking as many inputs as it is given");
        check(color && color->inputs.empty() && !color->dynamicInputs,
              "color is reported as a source that takes nothing");

        const auto scaleOpts = filterOptions("scale");
        bool sawWidth = false, sawMatrix = false;
        for (const auto& o : scaleOpts) {
            if (o.name == "width" || o.name == "w") sawWidth = true;
            if (o.name == "in_color_matrix") sawMatrix = true;
        }
        checkf(sawWidth && sawMatrix, "scale's own options are readable (%zu, with the "
               "colour ones the graph depends on)", scaleOpts.size());
        check(filterOptions("no_such_filter").empty(),
              "a filter that does not exist has no options rather than crashing");
    }

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
    // An audio *track* is not sound. Plenty of files carry a track that is
    // digitally silent — anything rendered from stills, anything a tool wrote
    // to keep a muxer happy — and the mixer check below reads "silence came
    // out" as a broken mixer when it is a faithful render of nothing. So the
    // source is measured once, here, and the check that cannot mean anything
    // is skipped out loud rather than failed.
    bool srcAudible = false;
    if (srcHasAudio) {
        AudioPeaks srcPeaks;
        if (analyzeAudioPeaks(first, 64, srcPeaks))
            for (float v : srcPeaks.rms)
                if (v > 0.0005f) { srcAudible = true; break; }
    }
    std::printf("\nsource: %s  %.2fs  %s\n", first.c_str(), srcDuration,
                !srcHasAudio ? "no audio track"
                             : srcAudible ? "with audio" : "audio track, but silent");
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
        if (srcAudible)
            checkf(loudest > 0.0005, "and is not silence (peak rms %.4f)", loudest);
        else
            std::printf("  SKIP  whether it is silence — the source is "
                        "(pass a file with sound to check the mixer)\n");
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

    // ── a file that is a list of streams ───────────────────────────────────
    //
    // The renderer used to write exactly one video stream and one audio
    // stream. What it writes now is whatever the list says, so the checks are
    // the ones nobody can make by looking at a picture: that a second audio
    // track exists at all, that each carries the language and the disposition
    // it was given, that an attachment travels as a stream with the muxer's two
    // naming tags on it, and that a chapter table came out the other side.
    //
    // Matroska rather than mp4, because mp4 cannot hold an attachment and does
    // not round-trip a forced flag. The list is the same either way; what a
    // container will keep of it is the container's business, and this is the
    // one that keeps all of it.
    if (srcHasAudio) {
        std::printf("\na file that is a list of streams\n");

        // Something to attach. Written rather than found: an attachment test
        // that depends on a font being installed passes on one machine.
        const std::string attachPath = "out/export-attachment.txt";
        {
            std::ofstream f(attachPath, std::ios::binary);
            f << "ffmpeg-bro attachment fixture\n";
        }

        const std::string outM = "out/export-streams.mkv";
        ExportSettings sm = baseSettings(outM);
        sm.endTime = sm.startTime + 0.6;
        sm.title = "a multi-stream render";
        sm.metadata = {{"comment", "written by the export test"}};

        ExportStream v;
        v.kind = "video";
        v.source = "composite";
        v.codec = "libx264";
        v.language = "eng";
        v.metadata = {{"title", "programme"}};
        v.disposition = "default";

        // Two audio streams that disagree about everything a track menu shows.
        ExportStream a1;
        a1.kind = "audio";
        a1.source = "mix";
        a1.codec = "aac";
        a1.language = "eng";
        a1.disposition = "default";
        a1.bitrateKbps = 128;
        a1.metadata = {{"title", "English"}};

        ExportStream a2 = a1;
        a2.language = "fra";
        // Two flags at once, parsed by av_disposition_from_string rather than
        // against any table here.
        a2.disposition = "+forced+comment";
        a2.bitrateKbps = 64;
        a2.metadata = {{"title", "Français"}};

        ExportStream att;
        att.kind = "attachment";
        att.path = attachPath;
        att.mimeType = "text/plain";

        sm.streams = {v, a1, a2, att};
        sm.chapters = {{0.0, 0.3, "first"}, {0.3, 0.6, "second"}};

        st = render(sm, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a four-stream render finishes (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            Opened m(outM);
            check(!!m, "and the file opens");
            if (m) {
                std::vector<const AVStream*> audio;
                const AVStream* video = nullptr;
                const AVStream* attached = nullptr;
                for (unsigned i = 0; i < m.fc->nb_streams; ++i) {
                    const AVStream* s = m.fc->streams[i];
                    if (s->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) video = s;
                    if (s->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) audio.push_back(s);
                    if (s->codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) attached = s;
                }
                checkf(m.fc->nb_streams == 4, "with four streams in it (%u)", m.fc->nb_streams);
                checkf(audio.size() == 2, "two of them audio (%zu)", audio.size());
                check(video != nullptr, "one of them the picture");

                if (audio.size() == 2) {
                    // The order the list was written in is the order the muxer
                    // numbered them, which is what makes -metadata:s:a:1 mean
                    // the stream the UI drew second.
                    checkf(meta(audio[0], "language") == "eng" &&
                               meta(audio[1], "language") == "fra",
                           "each audio track carries its own language (%s, %s)",
                           meta(audio[0], "language").c_str(),
                           meta(audio[1], "language").c_str());
                    checkf(meta(audio[0], "title") == "English",
                           "and its own name (%s)", meta(audio[0], "title").c_str());
                    check((audio[0]->disposition & AV_DISPOSITION_DEFAULT) != 0,
                          "the first is the default track");
                    check((audio[1]->disposition & AV_DISPOSITION_FORCED) != 0 &&
                              (audio[1]->disposition & AV_DISPOSITION_COMMENT) != 0,
                          "and the second is forced and a commentary, both flags at once");
                    check((audio[1]->disposition & AV_DISPOSITION_DEFAULT) == 0,
                          "which is not also the default, because it did not say so");
                    check(audio[0]->codecpar->bit_rate != audio[1]->codecpar->bit_rate ||
                              audio[0]->codecpar->bit_rate == 0,
                          "and they were encoded to their own bitrates");
                }
                check(attached != nullptr, "the attachment is a stream of its own");
                if (attached) {
                    checkf(meta(attached, "filename") == "export-attachment.txt",
                           "named for the file it came from (%s)",
                           meta(attached, "filename").c_str());
                    checkf(meta(attached, "mimetype") == "text/plain",
                           "with the mime type it was given (%s)",
                           meta(attached, "mimetype").c_str());
                    check(attached->codecpar->extradata_size > 0,
                          "and the bytes themselves travelled with it");
                }
                checkf(m.fc->nb_chapters == 2, "the chapter table came out too (%u)",
                       m.fc->nb_chapters);
                if (m.fc->nb_chapters == 2) {
                    const AVDictionaryEntry* t =
                        av_dict_get(m.fc->chapters[1]->metadata, "title", nullptr, 0);
                    check(t && std::string(t->value) == "second", "with its marks named");
                }
                const AVDictionaryEntry* c =
                    av_dict_get(m.fc->metadata, "comment", nullptr, 0);
                check(c && std::string(c->value) == "written by the export test",
                      "and the container's own metadata is there");
            }
        }

        // A fourcc is not an encoder option and there was nowhere to say it
        // before there was a stream list. mp4, because that is where it
        // matters: hvc1 and hev1 are the same HEVC bitstream and only the first
        // plays on Apple hardware.
        {
            const auto tags = codecTags("mp4", "libx264");
            checkf(!tags.empty(), "the mp4 muxer names the tags it takes for h264 (%s)",
                   tags.empty() ? "none" : tags.front().c_str());
            const bool hasAvc3 = std::find(tags.begin(), tags.end(), "avc3") != tags.end();

            const std::string outT = "out/export-tagged.mp4";
            ExportSettings sT = baseSettings(outT);
            sT.endTime = sT.startTime + 0.4;
            ExportStream tv;
            tv.kind = "video";
            tv.source = "composite";
            tv.codec = "libx264";
            tv.tag = hasAvc3 ? "avc3" : (tags.empty() ? "avc1" : tags.front());
            sT.streams = {tv};
            const ExportStatus tst = render(sT, clipsA);
            checkf(tst.state == ExportStatus::State::Done, "a tagged render finishes (%s)",
                   tst.error.empty() ? "no error" : tst.error.c_str());
            Opened t(outT);
            if (t && t.fc->nb_streams >= 1) {
                char buf[AV_FOURCC_MAX_STRING_SIZE] = {0};
                av_fourcc_make_string(buf, t.fc->streams[0]->codecpar->codec_tag);
                checkf(std::string(buf) == tv.tag,
                       "and the fourcc in the file is the one that was asked for (%s)", buf);
            } else {
                check(false, "the tagged file opens");
            }
            // The list said one stream, so one stream is what there is — even
            // though the source has sound and every other render here mixes it.
            checkf(t && t.fc->nb_streams == 1,
                   "a list with no audio in it writes no audio (%u streams)",
                   t ? t.fc->nb_streams : 0);
        }

        // Taking the *video* out is the other half of the same claim, and the
        // one a sound-only export needs.
        {
            const std::string outAo = "out/export-audio-only.mkv";
            ExportSettings sAo = baseSettings(outAo);
            sAo.endTime = sAo.startTime + 0.4;
            ExportStream only;
            only.kind = "audio";
            only.source = "mix";
            only.codec = "aac";
            sAo.streams = {only};
            const ExportStatus ast = render(sAo, clipsA);
            checkf(ast.state == ExportStatus::State::Done,
                   "a list with no picture in it renders (%s)",
                   ast.error.empty() ? "no error" : ast.error.c_str());
            Opened ao(outAo);
            if (ao) {
                checkf(ao.fc->nb_streams == 1 &&
                           ao.fc->streams[0]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO,
                       "and writes sound and nothing else (%u streams)", ao.fc->nb_streams);
            } else {
                check(false, "the audio-only file opens");
            }
        }

        // Every way of getting the list wrong arrives as a sentence. A render
        // that succeeded while dropping a stream it was told to write is the
        // one outcome worse than a refusal.
        {
            ExportSettings bad1 = baseSettings("out/export-streams-bad.mkv");
            bad1.endTime = bad1.startTime + 0.3;
            ExportStream junk;
            junk.kind = "subtitle";
            bad1.streams = {junk};
            ExportStatus b = render(bad1, clipsA);
            checkf(b.state == ExportStatus::State::Failed,
                   "a kind this build cannot write is refused (%s)", b.error.c_str());

            ExportSettings bad2 = baseSettings("out/export-streams-bad.mkv");
            bad2.endTime = bad2.startTime + 0.3;
            ExportStream d;
            d.kind = "video";
            d.source = "composite";
            d.codec = "libx264";
            d.disposition = "not-a-disposition";
            bad2.streams = {d};
            b = render(bad2, clipsA);
            checkf(b.state == ExportStatus::State::Failed,
                   "and so is a disposition libavformat does not know (%s)", b.error.c_str());

            ExportSettings bad3 = baseSettings("out/export-streams-bad.mkv");
            bad3.endTime = bad3.startTime + 0.3;
            ExportStream t;
            t.kind = "video";
            t.source = "composite";
            t.codec = "libx264";
            t.tag = "toolong";
            bad3.streams = {t};
            b = render(bad3, clipsA);
            checkf(b.state == ExportStatus::State::Failed,
                   "and a fourcc that is not four characters (%s)", b.error.c_str());

            ExportSettings bad4 = baseSettings("out/export-streams-bad.mkv");
            bad4.endTime = bad4.startTime + 0.3;
            ExportStream miss;
            miss.kind = "attachment";
            miss.path = "out/there-is-no-such-file.ttf";
            bad4.streams = {miss};
            b = render(bad4, clipsA);
            checkf(b.state == ExportStatus::State::Failed,
                   "and an attachment that is not there (%s)", b.error.c_str());
        }
    }

    // ── the same edit, rendered through libavfilter ────────────────────────
    //
    // Two implementations of "what does the output look like at t" — the track
    // stack and a parsed filter graph — and the only useful assertion about a
    // second implementation is that it agrees with the first. The graph below
    // is what ui/graph/derive.js writes for `leftHalf`, minus the tail that
    // converts into the encoder's colour: on this path that conversion is the
    // writer's, and doing it in both places is doing it twice.
    //
    // What this catches is everything the two paths could quietly disagree
    // about — which source frame belongs at an output instant, what a crop
    // means, which matrix a source is decoded through, where the picture is
    // placed. Any of those is worth a few dB, and none of them is visible in a
    // render you only ever look at one of.
    {
        std::printf("\nthe same edit through libavfilter\n");

        const StreamSummary* sv = nullptr;
        for (const auto& s : src.streams) if (s.kind == "video") { sv = &s; break; }

        const ExportClip c = leftHalf(first, srcDuration);
        const std::string matrix =
            matrixName(sv ? sv->colorSpace : "", sv ? sv->height : kH);
        const std::string range = (sv && sv->colorRange == "pc") ? "full" : "tv";

        char text[1024];
        std::snprintf(text, sizeof(text),
            "color=c=black:s=%dx%d:r=%g:d=%g[base];"
            "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS+0/TB,"
            "scale=%d:%d:in_color_matrix=%s:in_range=%s:out_range=full,format=rgba[v0];"
            "[base][v0]overlay=0:0:eof_action=pass[vout]"
            "%s",
            kW, kH, kFps, kSpan,
            c.inPoint, c.inPoint + c.length,
            static_cast<int>(c.w), static_cast<int>(c.h), matrix.c_str(), range.c_str(),
            srcHasAudio ? ";[0:a]atrim=start=1:end=2.6,asetpts=PTS-STARTPTS[a0]" : "");

        const std::string outG = "out/export-graph.mp4";
        ExportSettings sg = baseSettings(outG);
        sg.filterGraph = text;
        sg.filterInputs = {{"0:v", first, "v"}};
        if (srcHasAudio) sg.filterInputs.push_back({"0:a", first, "a"});

        // The clip list is passed as well and deliberately ignored: a graph
        // names its own inputs, and a path that silently used the clips too
        // would render something the graph does not describe.
        st = render(sg, clipsA);
        checkf(st.state == ExportStatus::State::Done, "a filter graph renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            const ProbeResult og = probeMedia(outG);
            check(og.ok, "and the result opens as media");
            checkf(st.framesDone == std::llround(kSpan * kFps),
                   "with every frame written (%lld)", (long long)st.framesDone);

            VideoPipeline a, b;
            check(a.open(outA) && b.open(outG), "both renders open for comparison");
            // Three instants rather than one: a single frame can agree by
            // accident, and a path that is one frame out agrees at none of
            // them for the same reason.
            double worst = 99.0;
            for (double at : {0.3, 0.8, 1.3}) {
                a.advanceTo(static_cast<TimeNs>(at * 1e9));
                b.advanceTo(static_cast<TimeNs>(at * 1e9));
                if (!a.hasFrame() || !b.hasFrame()) { worst = -1.0; break; }
                const double db = psnr(a.currentRgba(), b.currentRgba(), kW, kH);
                std::printf("        %.1fs: %.1f dB\n", at, db);
                worst = std::min(worst, db);
            }
            // Comfortably over forty when the two agree, and what is left is
            // two independent x264 passes over near-identical pictures rather
            // than any disagreement about the edit. What a real one looks like
            // is well under twenty: a frame out of step, a crop taken from the
            // wrong edge, or a source decoded through the wrong matrix all land
            // there, which is why the threshold has room under it and is still
            // nowhere near what a mistake would score.
            checkf(worst > 34.0,
                   "the graph renders the same picture as the track stack (%.1f dB)", worst);

            // And the same sound. A graph whose `atrim` starts a beat late, or
            // whose `amix` normalised, is inaudible in the picture check and
            // obvious here.
            if (srcHasAudio && srcAudible) {
                AudioPeaks pa, pg;
                if (analyzeAudioPeaks(outA, 64, pa) && analyzeAudioPeaks(outG, 64, pg) &&
                    pa.rms.size() == pg.rms.size() && !pa.rms.empty()) {
                    double worstDiff = 0, loudest = 0;
                    for (size_t i = 0; i < pa.rms.size(); ++i) {
                        worstDiff = std::max(worstDiff, std::fabs(double(pa.rms[i]) - pg.rms[i]));
                        loudest = std::max(loudest, double(pa.rms[i]));
                    }
                    checkf(loudest > 0.0005 && worstDiff < loudest * 0.15,
                           "and the same sound (worst rms difference %.4f of %.4f)",
                           worstDiff, loudest);
                } else {
                    check(false, "both renders' audio decodes for comparison");
                }
            }
        }

        // The same graph again, with each input told where its window begins.
        //
        // `-filter_complex` without `-ss` decodes every input from the start of
        // its file and lets `trim` throw the rest away, which is correct and is
        // ruinous for a clip an hour in. `ExportGraphInput::from` is where the
        // seek goes. It has to make no difference to the picture at all, which
        // is what this checks — against the render that did not seek, not
        // against the track stack, so that a frame lost to the seek shows up as
        // a disagreement and not as one more decibel of x264.
        {
            const std::string outS = "out/export-graph-seek.mp4";
            ExportSettings ss = sg;
            ss.path = outS;
            for (auto& in : ss.filterInputs) in.from = c.inPoint;
            const ExportStatus sst = render(ss, clipsA);
            checkf(sst.state == ExportStatus::State::Done,
                   "a graph whose inputs seek to their window renders (%s)",
                   sst.error.empty() ? "no error" : sst.error.c_str());

            VideoPipeline a, b;
            if (sst.state == ExportStatus::State::Done && a.open(outG) && b.open(outS)) {
                double worst = 99.0;
                for (double at : {0.3, 0.8, 1.3}) {
                    a.advanceTo(static_cast<TimeNs>(at * 1e9));
                    b.advanceTo(static_cast<TimeNs>(at * 1e9));
                    if (!a.hasFrame() || !b.hasFrame()) { worst = -1.0; break; }
                    worst = std::min(worst, psnr(a.currentRgba(), b.currentRgba(), kW, kH));
                }
                // Higher than the cross-path threshold on purpose: these two
                // renders composited identical frames, so the only difference
                // left is two x264 passes over the same pictures. Anything the
                // seek got wrong — a frame late, a keyframe short — is a
                // different picture and lands far below.
                checkf(worst > 40.0,
                       "and produces the same frames as decoding from zero (%.1f dB)", worst);
            } else {
                check(false, "both graph renders open for comparison");
            }
        }

        // ── a filter that is on for part of the render ─────────────────────
        //
        // `enable=` is libavfilter's timeline support and it is the nearest
        // thing ffmpeg has to a keyframe: the filter is stepped over on frames
        // whose timestamp the expression says no to. The whole claim the UI
        // makes about it is that it changes *those frames and no others*, and
        // the only way to know that is to render one and look at both sides of
        // the boundary in the written file.
        //
        // Measured against the plain graph render rather than against a
        // threshold of its own: inside the span the two must be visibly
        // different pictures, outside it they must be the same picture twice.
        // A filter that was applied to everything passes neither check, and one
        // that was silently dropped — which is what libavfilter does to
        // `enable` on a filter without the flag — passes only the second.
        {
            const std::string outE = "out/export-graph-enable.mp4";
            const double kOn = 0.6;                 // the span, in output seconds
            char enabled[1200];
            std::snprintf(enabled, sizeof(enabled),
                "color=c=black:s=%dx%d:r=%g:d=%g[base];"
                "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS+0/TB,"
                "scale=%d:%d:in_color_matrix=%s:in_range=%s:out_range=full,format=rgba,"
                "negate=enable='between(t,0,%g)'[v0];"
                "[base][v0]overlay=0:0:eof_action=pass[vout]",
                kW, kH, kFps, kSpan,
                c.inPoint, c.inPoint + c.length,
                static_cast<int>(c.w), static_cast<int>(c.h), matrix.c_str(), range.c_str(),
                kOn);

            ExportSettings se = sg;
            se.path = outE;
            se.filterGraph = enabled;
            // Only the picture: the sound is the same on both sides of the
            // boundary and an audio pad here would only be a second thing to
            // keep in step.
            se.filterInputs = {{"0:v", first, "v"}};
            se.includeAudio = false;
            const ExportStatus est = render(se, clipsA);
            checkf(est.state == ExportStatus::State::Done,
                   "a graph with a filter enabled for part of the range renders (%s)",
                   est.error.empty() ? "no error" : est.error.c_str());

            VideoPipeline a, b;
            if (est.state == ExportStatus::State::Done && a.open(outG) && b.open(outE)) {
                const auto at = [&](double t) {
                    a.advanceTo(static_cast<TimeNs>(t * 1e9));
                    b.advanceTo(static_cast<TimeNs>(t * 1e9));
                    return (a.hasFrame() && b.hasFrame())
                        ? psnr(a.currentRgba(), b.currentRgba(), kW, kH) : -1.0;
                };
                const double inside = at(0.25);
                const double outside = at(kSpan - 0.2);
                checkf(inside >= 0 && inside < 15.0,
                       "the frames inside the span are a different picture (%.1f dB)", inside);
                checkf(outside > 40.0,
                       "and the frames outside it are the same picture (%.1f dB)", outside);
            } else {
                check(false, "both renders open for comparison");
            }

            // And a filter without AVFILTER_FLAG_SUPPORT_TIMELINE is *refused*,
            // not quietly ignored: `set_enable_expr` checks the flag and hands
            // back AVERROR_PATCHWELCOME, so the graph never builds. Worth an
            // assertion because the whole UI rule — do not offer a strip where
            // there is no timeline support — rests on which of the two it is.
            char refused[400];
            std::snprintf(refused, sizeof(refused),
                          "[0:v]scale=%d:%d:enable='between(t,0,1)'[vout]", kW, kH);
            ExportSettings sn = baseSettings("out/export-graph-enable-refused.mp4");
            sn.endTime = 0.4;
            sn.filterGraph = refused;
            sn.filterInputs = {{"0:v", first, "v"}};
            sn.includeAudio = false;
            const ExportStatus nst = render(sn, clipsA);
            checkf(nst.state == ExportStatus::State::Failed,
                   "and enable= on a filter with no timeline support is refused (%s)",
                   nst.error.empty() ? "no error" : nst.error.c_str());
        }

        // The graph is text the user can edit, so every way of getting it wrong
        // has to arrive as a sentence rather than as a render that produces
        // nothing.
        ExportSettings broken = baseSettings("out/export-graph-bad.mp4");
        broken.endTime = 0.4;
        broken.filterGraph = "[0:v]not_a_filter=1[vout]";
        broken.filterInputs = {{"0:v", first, "v"}};
        st = render(broken, clipsA);
        checkf(st.state == ExportStatus::State::Failed,
               "a graph that will not parse is refused with a reason (%s)", st.error.c_str());

        ExportSettings unfed = baseSettings("out/export-graph-unfed.mp4");
        unfed.endTime = 0.4;
        unfed.filterGraph = "[7:v]null[vout]";
        unfed.filterInputs = {{"0:v", first, "v"}};
        st = render(unfed, clipsA);
        checkf(st.state == ExportStatus::State::Failed,
               "and so is an input nothing feeds (%s)", st.error.c_str());
    }

    // ── a graph nothing derived ────────────────────────────────────────────
    //
    // Everything above renders a graph the *derivation* wrote: one shape, with
    // every pad wired the moment it was made. The Graph stage can now be wired
    // by hand, which means the renderer is going to be handed shapes nothing in
    // this application has ever produced — several inputs meeting at a filter
    // that is not `overlay`, a picture and a sound arriving at different
    // multi-input filters, and an output whose size no clip and no setting
    // decides.
    //
    // So: two reads of one file, stacked side by side and mixed together,
    // written as a person would wire it. The picture is twice as wide as
    // anything the settings say, which is the whole reason `sizeFromGraph`
    // exists — nothing outside libavfilter knows how big the picture is half
    // way through a graph, and a writer opened for the wrong size is a scaler
    // quietly resizing every frame.
    {
        std::printf("\na multi-input graph nobody derived\n");

        const std::string outH = "out/export-graph-stack.mp4";
        char text[1024];
        std::snprintf(text, sizeof(text),
            "[0:v]trim=start=0:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,format=rgba[l];"
            "[1:v]trim=start=0:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,hflip,format=rgba[r];"
            "[l][r]hstack=inputs=2[vout]"
            "%s",
            kSpan, kW / 2, kH,
            kSpan, kW / 2, kH,
            srcHasAudio
                ? ";[0:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS[a1];"
                  "[1:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS,volume=0.5[a2];"
                  "[a1][a2]amix=inputs=2:normalize=0[aout]"
                : "");

        ExportSettings sh = baseSettings(outH);
        sh.endTime = 1.0;
        // The size is the graph's, not the settings'. Asked of the sink after
        // the graph is configured, which is the only thing that knows.
        sh.sizeFromGraph = true;
        // One file, read twice, as two inputs. That is what two `-i` of the
        // same path means to ffmpeg and it is what a person wiring two reads of
        // one clip into an `hstack` is asking for.
        sh.filterInputs = {{"0:v", first, "v"}, {"1:v", first, "v"}};
        if (srcHasAudio) {
            sh.filterInputs.push_back({"0:a", first, "a"});
            sh.filterInputs.push_back({"1:a", first, "a"});
        }
        sh.filterGraph = text;

        st = render(sh, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a hand-wired multi-input graph renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            const ProbeResult oh = probeMedia(outH);
            const StreamSummary* ov = nullptr;
            for (const auto& s2 : oh.streams) if (s2.kind == "video") { ov = &s2; break; }
            check(oh.ok && ov, "and the result opens as media");
            if (ov) {
                // Twice as wide as the render was configured for, because the
                // graph said so and was asked. An `hstack` whose answer was not
                // asked for comes out squeezed into the settings' width, which
                // is a picture rather than an error.
                checkf(ov->width == (kW / 2) * 2 && ov->height == kH,
                       "at the size the graph produces rather than the size the "
                       "settings asked for (%dx%d)", ov->width, ov->height);
            }
            // Both halves are real pictures. The right one is the same frame
            // flipped, so a stack that dropped one input would be black down
            // one side — which the size check above cannot see.
            VideoPipeline v;
            if (v.open(outH)) {
                v.advanceTo(static_cast<TimeNs>(0.5 * 1e9));
                if (v.hasFrame()) {
                    const auto& rgba = v.currentRgba();
                    const int w = ov ? ov->width : 0;
                    double left = 0, right = 0;
                    int lit = 0;
                    for (int y = 8; y < kH; y += 16)
                        for (int x = 4; x < w / 2; x += 8) {
                            const size_t a = (size_t(y) * w + x) * 4;
                            const size_t b = (size_t(y) * w + (w - 1 - x)) * 4;
                            if (a + 2 >= rgba.size() || b + 2 >= rgba.size()) continue;
                            left += rgba[a] + rgba[a + 1] + rgba[a + 2];
                            right += rgba[b] + rgba[b + 1] + rgba[b + 2];
                            lit++;
                        }
                    // `hflip` on the right half means the mirrored sample is the
                    // same source pixel, so the two sides agree closely — and
                    // both being lit at all is what says two inputs arrived.
                    const double avg = lit ? (left + right) / (2 * lit) : 0;
                    checkf(lit > 0 && avg > 6.0,
                           "with a picture in both halves (mean %.1f over %d samples)",
                           avg, lit);
                    checkf(lit > 0 && std::fabs(left - right) < std::max(left, right) * 0.35,
                           "and the flipped half is the same picture (%.0f vs %.0f)",
                           left, right);
                }
            } else {
                check(false, "the stacked render opens for comparison");
            }

            if (srcHasAudio && srcAudible) {
                AudioPeaks pk;
                bool loud = false;
                if (analyzeAudioPeaks(outH, 32, pk))
                    for (float v2 : pk.rms) if (v2 > 0.0005f) { loud = true; break; }
                check(loud, "and the two sounds the amix was handed are in it");
            }
        }
    }

    // ── a graph that produces something out of nothing ─────────────────────
    //
    // Every render above starts from a file on a timeline. libavfilter has
    // thirty filters that read nothing at all — `color`, `testsrc`,
    // `smptebars`, `sine`, `anullsrc` — and `ffmpeg -f lavfi -i testsrc -t 5
    // out.mp4` is a thing people do every day, so a render with no clip in it
    // is a render this application has to be able to perform. Nothing in the
    // job needs to change for that: `startExport` already treats a graph as a
    // render on its own account, and a buffersink asked for a frame gets one
    // without anything having been pushed in. What is checked here is that it
    // is true, because it is the sort of thing that stops being true silently.
    {
        std::printf("\na render nothing on the timeline accounts for\n");

        const std::string outS = "out/export-graph-source.mp4";
        char text[512];
        std::snprintf(text, sizeof(text),
            "color=c=red:s=%dx%d:r=%g,format=rgba[vout];"
            "sine=frequency=440:sample_rate=48000[aout]",
            kW, kH, kFps);

        ExportSettings ss2 = baseSettings(outS);
        ss2.endTime = 0.8;
        ss2.filterGraph = text;
        // No `filterInputs` and no clips: nothing here opens a file.
        st = render(ss2, {});
        checkf(st.state == ExportStatus::State::Done,
               "a graph rooted only in generators renders with no clips at all (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            const ProbeResult os = probeMedia(outS);
            const StreamSummary* ov = nullptr;
            bool hasSound = false;
            for (const auto& s2 : os.streams) {
                if (s2.kind == "video" && !ov) ov = &s2;
                if (s2.kind == "audio") hasSound = true;
            }
            check(os.ok && ov, "and the result opens as media");
            if (ov)
                checkf(ov->width == kW && ov->height == kH,
                       "at the size the render asked for (%dx%d)", ov->width, ov->height);
            check(hasSound, "with the sound the graph made as well as the picture");

            // Red, which no `color=c=red` can fail to be — this is the one
            // check in the file whose expected value is known exactly, because
            // for once the content is not somebody's footage.
            VideoPipeline v;
            if (v.open(outS)) {
                v.advanceTo(static_cast<TimeNs>(0.4 * 1e9));
                if (v.hasFrame()) {
                    const auto& rgba = v.currentRgba();
                    const size_t at = (size_t(kH / 2) * kW + kW / 2) * 4;
                    if (at + 2 < rgba.size())
                        checkf(rgba[at] > 180 && rgba[at + 1] < 80 && rgba[at + 2] < 80,
                               "and it is the colour it was told to be (%d,%d,%d)",
                               rgba[at], rgba[at + 1], rgba[at + 2]);
                    else
                        check(false, "the generated frame has pixels in it");
                } else {
                    check(false, "the generated render decodes");
                }
            } else {
                check(false, "the generated render opens for decoding");
            }

            AudioPeaks tone;
            if (analyzeAudioPeaks(outS, 32, tone)) {
                bool loud = false;
                for (float v2 : tone.rms) if (v2 > 0.0005f) { loud = true; break; }
                check(loud, "and the tone the graph generated is audible in it");
            }
        }
    }

    // ── a second picture the graph opened for itself ───────────────────────
    //
    // A watermark, a logo bug and an insert are all one shape: a file the graph
    // reads that nothing on the timeline is cut from, scaled and laid over the
    // composite. In this application that is a second `-i` rather than a
    // `movie=` — see ui/graph/derive.js for the argument — so what arrives here
    // is an extra `ExportGraphInput` and a chain that reads its pad.
    //
    // The check is the same edit rendered twice, with and without the mark: the
    // corner it was placed in has to differ and everything else has to be the
    // same picture. That is content-independent in the way this whole file
    // insists on, and it is a stronger statement than "the corner is a
    // particular colour" — it says the overlay landed exactly where it was told
    // and nowhere else. `negate` is on the mark's chain so that the two renders
    // differ even if the two files happen to look alike there.
    {
        std::printf("\na second picture the graph opened for itself\n");

        const int markW = kW / 4, markH = kH / 4;
        const int markX = 16, markY = 16;
        char body[1024];
        std::snprintf(body, sizeof(body),
            "color=c=black:s=%dx%d:r=%g:d=%g[base];"
            "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,format=rgba[main];"
            "[base][main]overlay=0:0:eof_action=pass",
            kW, kH, kFps, 0.8,
            clipsA[0].inPoint, clipsA[0].inPoint + 0.8, kW, kH);

        char plain[1200];
        std::snprintf(plain, sizeof(plain), "%s[vout]", body);

        char marked[1600];
        std::snprintf(marked, sizeof(marked),
            "%s[canvas];"
            "[1:v]trim=start=0:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,negate,format=rgba[mark];"
            "[canvas][mark]overlay=%d:%d:eof_action=pass[vout]",
            body, 0.8, markW, markH, markX, markY);

        const std::string outP = "out/export-graph-plain.mp4";
        const std::string outM = "out/export-graph-mark.mp4";

        ExportSettings sp = baseSettings(outP);
        sp.endTime = 0.8;
        sp.includeAudio = false;
        sp.filterGraph = plain;
        sp.filterInputs = {{"0:v", first, "v"}};
        sp.filterInputs[0].from = clipsA[0].inPoint;
        st = render(sp, {});
        checkf(st.state == ExportStatus::State::Done,
               "the composite renders on its own (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        ExportSettings sm2 = baseSettings(outM);
        sm2.endTime = 0.8;
        sm2.includeAudio = false;
        sm2.filterGraph = marked;
        // Two inputs, and the second is a file no clip is cut from — which is
        // the whole point: `filterInputs` is one entry per pad that is read,
        // and nothing but the graph says this file is opened at all.
        sm2.filterInputs = {{"0:v", first, "v"}, {"1:v", second, "v"}};
        sm2.filterInputs[0].from = clipsA[0].inPoint;
        st = render(sm2, {});
        checkf(st.state == ExportStatus::State::Done,
               "and so does the same graph with a second file laid over it (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            VideoPipeline a, b;
            if (a.open(outP) && b.open(outM)) {
                a.advanceTo(static_cast<TimeNs>(0.4 * 1e9));
                b.advanceTo(static_cast<TimeNs>(0.4 * 1e9));
                if (a.hasFrame() && b.hasFrame()) {
                    const auto& fa = a.currentRgba();
                    const auto& fb = b.currentRgba();
                    // Mean absolute difference per channel, inside the mark and
                    // outside it. Two x264 passes over near-identical pictures
                    // are not bit-identical, so "outside" is a small number
                    // rather than zero and the check is on the gap.
                    const auto diff = [&](int x0, int y0, int x1, int y1, bool inside) {
                        double sum = 0;
                        int n = 0;
                        for (int y = 0; y < kH; ++y)
                            for (int x = 0; x < kW; ++x) {
                                const bool in = x >= x0 && x < x1 && y >= y0 && y < y1;
                                if (in != inside) continue;
                                const size_t i = (size_t(y) * kW + x) * 4;
                                if (i + 2 >= fa.size() || i + 2 >= fb.size()) continue;
                                for (int c = 0; c < 3; ++c, ++n)
                                    sum += std::fabs(double(fa[i + c]) - fb[i + c]);
                            }
                        return n ? sum / n : -1.0;
                    };
                    const double in = diff(markX, markY, markX + markW, markY + markH, true);
                    const double out = diff(markX, markY, markX + markW, markY + markH, false);
                    checkf(in > 12.0 && in > out * 3.0,
                           "the corner the mark was placed in is a different picture "
                           "(%.1f vs %.1f per channel)", in, out);
                    checkf(out < 12.0,
                           "and the rest of the canvas is the picture it was without it "
                           "(%.1f per channel)", out);
                } else {
                    check(false, "both renders decode for comparison");
                }
            } else {
                check(false, "both renders open for comparison");
            }
        }
    }

    // ── what the render said ───────────────────────────────────────────────
    //
    // A render used to be able to report four numbers and, on failure, one
    // string. Everything libav* had to say went to stderr and nowhere an
    // application could reach, and the whole family of filters that measures
    // rather than changes a picture had nowhere to put its answer at all.
    //
    // Both halves are checked here, and the second is the one that matters:
    // frame metadata is a *time series*, and a series that arrives without
    // timestamps, or with somebody else's, is worse than no series.
    {
        std::printf("\nthe render's back-channel\n");

        // Where the rings are now. Everything below is measured from here, so
        // that the checks do not depend on what the eight hundred lines above
        // happened to log.
        constexpr int kAll = 1 << 20;
        ReportDrain d = drainReport(0, 0, kAll);
        const uint64_t logFrom = d.logCursor, metaFrom = d.metaCursor;

        // The callback, round-tripped. A message with a context attached has to
        // come back attributed: "a warning" and "a warning from libx264" are
        // not the same fact, and the second is the one worth having.
        av_log(nullptr, AV_LOG_WARNING, "exporttest: a warning with nobody behind it\n");
        const AVCodec* x264 = avcodec_find_encoder_by_name("libx264");
        if (x264) {
            AVCodecContext* cc = avcodec_alloc_context3(x264);
            av_log(cc, AV_LOG_ERROR, "exporttest: %s\n", "an error from an encoder");
            avcodec_free_context(&cc);
        }
        // libav writes some lines in pieces. A channel that committed a record
        // per call would split them, so it joins on the newline instead.
        av_log(nullptr, AV_LOG_WARNING, "exporttest: split ");
        av_log(nullptr, AV_LOG_WARNING, "across two calls\n");
        // Below the capture threshold, and the level check has to be ours: a
        // custom callback is handed every level libav ever emits, because the
        // check against av_log_get_level() lives in the default callback that
        // has just been replaced.
        av_log(nullptr, AV_LOG_DEBUG, "exporttest: a debug line nobody asked for\n");

        d = drainReport(logFrom, metaFrom, kAll);
        bool sawPlain = false, sawAttributed = false, sawJoined = false, sawDebug = false;
        for (const auto& m : d.logs) {
            if (m.text.find("nobody behind it") != std::string::npos)
                sawPlain = m.level == AV_LOG_WARNING && m.source.empty();
            if (m.text.find("an error from an encoder") != std::string::npos)
                sawAttributed = m.level == AV_LOG_ERROR && m.source == "libx264";
            if (m.text == "exporttest: split across two calls") sawJoined = true;
            if (m.text.find("nobody asked for") != std::string::npos) sawDebug = true;
        }
        check(sawPlain, "a libav message reaches the report with its level");
        if (x264) check(sawAttributed, "and one with a context on it is labelled libx264");
        check(sawJoined, "a line written in pieces arrives as one message");
        check(!sawDebug, "and a debug line is dropped before it is even formatted");

        // Bounded, and honest about it. A long render with a chatty filter will
        // outrun any buffer; the only wrong answer is to grow forever or to
        // lose records without saying so.
        const uint64_t floodFrom = d.logCursor;
        const int flood = logCapacity() + 8;
        for (int i = 0; i < flood; ++i) av_log(nullptr, AV_LOG_WARNING, "exporttest: %d\n", i);
        d = drainReport(floodFrom, metaFrom, kAll);
        checkf(static_cast<int>(d.logs.size()) == logCapacity() && d.logsDropped == 8,
               "the log ring is bounded and says what it dropped (%d kept, %llu dropped)",
               static_cast<int>(d.logs.size()), (unsigned long long)d.logsDropped);
        bool ordered = true;
        for (size_t i = 1; i < d.logs.size(); ++i)
            if (d.logs[i].seq != d.logs[i - 1].seq + 1) ordered = false;
        check(ordered, "and what survives is still consecutively numbered");

        // The half chunk 10 is built on: a filter that measures rather than
        // paints, and the numbers it hangs on every frame that goes past.
        const uint64_t measureLog = d.logCursor;
        const uint64_t measureMeta = d.metaCursor;
        char text[512];
        std::snprintf(text, sizeof(text),
            "[0:v]cropdetect=limit=24:round=2:reset=1,scale=%d:%d[vout]", kW, kH);
        ExportSettings sm = baseSettings("out/export-measure.mp4");
        sm.endTime = 1.0;
        sm.filterGraph = text;
        sm.filterInputs = {{"0:v", first, "v"}};
        st = render(sm, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a graph with a measuring filter in it renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        d = drainReport(measureLog, measureMeta, kAll);
        int samples = 0;
        double firstAt = -1, lastAt = -1;
        bool ascending = true, allVideo = true, oneJob = true, keyed = true;
        uint64_t job = 0;
        for (const auto& m : d.meta) {
            if (m.key.rfind("lavfi.cropdetect.", 0) != 0) { keyed = false; continue; }
            ++samples;
            if (firstAt < 0) { firstAt = m.at; job = m.job; }
            if (m.at + 1e-6 < lastAt) ascending = false;
            lastAt = m.at;
            if (m.stream != "video") allVideo = false;
            if (m.job == 0 || m.job != job) oneJob = false;
        }
        checkf(samples > 0, "and every value it measured arrives as a series (%d samples)",
               samples);
        check(keyed, "under libavfilter's own names, verbatim");
        checkf(firstAt >= -1e-9 && lastAt <= sm.endTime + 0.5 && ascending,
               "sampled at the timestamps of the frames they came off (%.3f to %.3f s)",
               firstAt, lastAt);
        check(allVideo, "on the stream they left by");
        check(oneJob, "and pinned to the render that produced them");

        // The render is a speaker too, and it says the same things into this
        // channel that it says to the console — including the ones that are
        // only explicable if somebody wrote them down while they happened.
        bool wrote = false;
        for (const auto& m : d.logs)
            if (m.source == "render" && m.text.find("wrote") != std::string::npos &&
                m.job == job && job != 0)
                wrote = true;
        check(wrote, "the render's own last word is in the channel, under this render");

        // Draining after the job has gone is an ordinary read: the rings belong
        // to the process, not to the thread. A render's last messages are
        // exactly the ones somebody wants, and they arrive after it is over.
        const ReportDrain again = drainReport(measureLog, measureMeta, kAll);
        checkf(again.logs.size() == d.logs.size() && again.meta.size() == d.meta.size(),
               "and a second reader gets the same records after the job is gone (%d, %d)",
               static_cast<int>(again.logs.size()), static_cast<int>(again.meta.size()));

        // A graph that disagrees with the render about how many frames a second
        // is: not fatal, invisible until the file plays fast, and now said.
        const uint64_t rateFrom = drainReport(0, 0, kAll).logCursor;
        std::snprintf(text, sizeof(text), "[0:v]fps=%g,scale=%d:%d[vout]", kFps / 2, kW, kH);
        ExportSettings sr = baseSettings("out/export-rate-warning.mp4");
        sr.endTime = 0.4;
        sr.filterGraph = text;
        sr.filterInputs = {{"0:v", first, "v"}};
        render(sr, clipsA);
        d = drainReport(rateFrom, 0, kAll);
        bool warned = false;
        for (const auto& m : d.logs)
            if (m.source == "graph" && m.level == AV_LOG_WARNING &&
                m.text.find("fps") != std::string::npos && m.job != 0)
                warned = true;
        check(warned, "a graph running at a different rate from the render says so");
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
