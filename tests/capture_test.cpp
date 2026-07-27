// A device is an input, and recording is a job. Checked here against a device
// that exists on every machine.
//
// **CI has no camera**, which is the whole difficulty with testing this. The
// vehicle is `lavfi` — libavfilter's *input device*, `-f lavfi -i
// testsrc=size=320x240:rate=25` — because it is registered by
// `avdevice_register_all()` like every other device, it is openable anywhere,
// and it produces exactly the frames it says it will. Everything about the
// shape of a device holds for it: it reports no duration, it never ends, `-t`
// is the only thing that can say how long it is, and it is opened by a forced
// `-f` naming a libavdevice demuxer.
//
// **`-f lavfi` is not the same mechanism as a source filter on the graph.**
// Chunk 8 will put `color`, `testsrc`, `sine` and `movie` into the *filter
// graph*, where they are nodes with no input pad and the graph is what runs
// them. The lavfi *device* wraps a whole filtergraph up as a demuxer so that
// libavformat can read it as an `-i`. They look alike, they are spelled almost
// alike, and they are two different places in the pipeline: one is an input and
// the other is part of the filter chain applied to inputs. Do not let a test of
// one be read as coverage of the other.
//
// The machine's real devices are asked about too, and what is asserted is the
// *answer*, whatever it is: this build must list `gdigrab` and `dshow`, opening
// gdigrab must either work (and then produce frames) or fail with a reason.
// A test that quietly passed because it found no device would be worse than no
// test, so there is no branch here that asserts nothing.
//
// Usage: ffmpeg-bro-captest is the capability one; this is
//        ffmpeg-bro-capturetest [<dir-for-output>]

#include "ffmpeg_capabilities.h"
#include "ffmpeg_capture.h"
#include "ffmpeg_export.h"
#include "ffmpeg_input.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

#include <algorithm>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

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

bool haveDevice(const std::string& name) {
    for (const auto& d : availableDevices())
        if (d.name == name && d.direction == "input") return true;
    return false;
}

/// A `lavfi` device input. The graph goes where the filename goes, which is
/// what makes this a device and not a filter: libavformat is handed a URL and
/// the demuxer decides what it means.
MediaInput lavfi(const std::string& graph, double seconds = 0.0) {
    MediaInput in;
    in.format = "lavfi";
    in.path = graph;
    in.duration = seconds;
    return in;
}

/// How many frames come out of an input before it stops or `cap` is reached.
/// Also reports whether it stopped at all, which for a device is the question.
int readFrames(const MediaInput& in, int cap, std::string* err) {
    AVFormatContext* fmt = nullptr;
    if (!openInput(&fmt, in, err)) return -1;
    const int stream = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (stream < 0) { *err = "no video stream"; avformat_close_input(&fmt); return -1; }

    AVPacket* pkt = av_packet_alloc();
    int n = 0;
    while (n < cap) {
        const int rc = av_read_frame(fmt, pkt);
        // Why it stopped short is the whole answer for a screen grabber: a
        // device can open and then be refused every frame, which is a fact
        // about the session rather than about the device. Reported through
        // `err` with `n` still >= 0, so the caller can tell that apart from an
        // open that never happened.
        if (rc < 0) {
            char msg[AV_ERROR_MAX_STRING_SIZE] = {0};
            av_strerror(rc, msg, sizeof msg);
            *err = msg;
            break;
        }
        if (pkt->stream_index == stream) n++;
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    avformat_close_input(&fmt);
    return n;
}

/// Open what was written and say what is in it.
struct Opened {
    bool ok = false;
    std::string format;
    int streams = 0;
    double duration = 0;
    int width = 0, height = 0;
    bool indexed = false;   // seekable back to the start: there is a moov
};

Opened openResult(const std::string& path) {
    Opened o;
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0 || !fc) return o;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return o; }
    o.ok = true;
    o.format = fc->iformat && fc->iformat->name ? fc->iformat->name : "";
    o.streams = static_cast<int>(fc->nb_streams);
    o.duration = fc->duration != AV_NOPTS_VALUE ? fc->duration / double(AV_TIME_BASE) : 0.0;
    for (unsigned i = 0; i < fc->nb_streams; ++i) {
        if (fc->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            o.width = fc->streams[i]->codecpar->width;
            o.height = fc->streams[i]->codecpar->height;
        }
    }
    // A file with no index is a file that cannot be seeked. That is exactly
    // what a recording whose trailer never went down looks like, and it is the
    // one failure this whole job is arranged around.
    o.indexed = av_seek_frame(fc, -1, 0, AVSEEK_FLAG_BACKWARD) >= 0;
    avformat_close_input(&fc);
    return o;
}

/// Poll to a terminal state, and then join.
///
/// The join is not optional. The slot frees itself *before* it publishes the
/// terminal status — so that the next job can start the instant something sees
/// it — which means the thread is still running for a moment after this loop
/// would otherwise return, and a process that exits in that moment destroys a
/// joinable `std::thread` and terminates.
ExportStatus waitForJob(double limitSeconds) {
    const auto began = std::chrono::steady_clock::now();
    for (;;) {
        const ExportStatus st = exportStatus();
        if (st.state != ExportStatus::State::Running) { waitForExport(); return st; }
        if (std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count()
            > limitSeconds) {
            cancelExport();
            waitForExport();
            return exportStatus();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
}

} // namespace

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IONBF, 0);
    av_log_set_level(AV_LOG_ERROR);

    const std::string dir = argc > 1 ? argv[1] : "out";
    std::filesystem::create_directories(dir);

    // ── what this build has ────────────────────────────────────────────────
    std::printf("\nDevices\n");
    {
        const auto devices = availableDevices();
        std::string names;
        for (const auto& d : devices)
            names += (names.empty() ? "" : " ") + d.name + "/" + d.kind + "/" + d.direction;
        std::printf("  %zu registered: %s\n", devices.size(), names.c_str());
        checkf(!devices.empty(),
               "avdevice_register_all() has run — there are %zu", devices.size());
        check(haveDevice("lavfi"), "lavfi is an input device in this build");
#ifdef _WIN32
        check(haveDevice("gdigrab"), "gdigrab is an input device on this platform");
        check(haveDevice("dshow"), "dshow is an input device on this platform");
#endif
        check(isInputDevice("lavfi"), "isInputDevice knows one");
        check(!isInputDevice("mp4"), "and knows an ordinary demuxer is not one");
        check(!isInputDevice(""), "an input with no forced demuxer is not a device");
        check(!isInputDevice("not-a-format"), "and neither is a name this build has not got");
    }

    // ── an endless input ───────────────────────────────────────────────────
    //
    // The model half of this chunk is one line, and this is it: a device is
    // endless, so `-t` is the whole of how long it is and with no `-t` the
    // answer is zero, meaning nobody knows.
    std::printf("\nA device has no length\n");
    {
        const MediaInput live = lavfi("testsrc=size=320x240:rate=25");
        check(inputIsEndless(live), "a device input is endless");
        checkf(inputDuration(live, 0.0) == 0.0,
               "with no -t its duration is 0 — nobody knows (%g)", inputDuration(live, 0.0));

        const MediaInput bounded = lavfi("testsrc=size=320x240:rate=25", 2.0);
        check(inputIsEndless(bounded), "it is still endless with a -t on it");
        checkf(inputDuration(bounded, 0.0) == 2.0,
               "and -t is the whole of its length (%g)", inputDuration(bounded, 0.0));

        // A container that *did* report a duration must not have it believed
        // over the `-t`, because a device's reported duration is meaningless.
        checkf(inputDuration(bounded, 3600.0) == 2.0,
               "a duration the device claimed does not outrank -t (%g)",
               inputDuration(bounded, 3600.0));
    }

    // ── it opens, and it goes on producing ─────────────────────────────────
    std::printf("\nOpening a device\n");
    {
        std::string err;
        const int n = readFrames(lavfi("testsrc=size=320x240:rate=25"), 40, &err);
        checkf(n == 40, "a lavfi device hands over frames for as long as it is asked (%d, %s)",
               n, err.c_str());

        // Bounded by the graph rather than by `-t`: this one really does end,
        // which is how the read loop's end-of-input path gets exercised at all.
        const int m = readFrames(lavfi("testsrc=size=320x240:rate=25:duration=1"), 200, &err);
        checkf(m > 0 && m < 200, "a lavfi graph that ends, ends (%d frames)", m);

        AVFormatContext* fmt = nullptr;
        const bool refused = !openInput(&fmt, lavfi("not_a_filter=nonsense"), &err);
        checkf(refused, "a graph the device cannot parse is a refusal with a reason (%s)",
               err.c_str());
        if (fmt) avformat_close_input(&fmt);
    }

    // ── recording ──────────────────────────────────────────────────────────
    //
    // A bounded capture, so it ends by itself, and then the result is opened:
    // the point of the whole trailer discipline is that what comes out is a
    // file with an index in it.
    std::printf("\nRecording\n");
    if (!avcodec_find_encoder_by_name("libx264")) {
        std::printf("  SKIP  no libx264 in this build\n");
    } else {
        const std::string path = dir + "/capture-lavfi.mp4";
        std::filesystem::remove(path);

        CaptureSettings c;
        c.source = lavfi("testsrc=size=320x240:rate=25", 1.5);
        c.output.path = path;
        c.output.format = "mp4";
        c.output.videoCodec = "libx264";
        c.output.preset = "ultrafast";
        c.output.crf = 30;
        c.output.includeAudio = false;

        std::string err;
        const bool started = startCapture(c, &err);
        checkf(started, "a bounded recording starts%s%s", started ? "" : ": ", err.c_str());
        if (started) {
            // A `-t` gives a recording an end, so it *does* have a total and a
            // percentage — which is the other half of the rule that without one
            // it has neither.
            const ExportStatus mid = exportStatus();
            checkf(!mid.openEnded, "a recording with a -t is not open-ended");
            checkf(mid.framesTotal > 0, "and it has a frame total (%lld)",
                   static_cast<long long>(mid.framesTotal));

            const ExportStatus st = waitForJob(30.0);
            checkf(st.state == ExportStatus::State::Done, "it finishes on its own%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            checkf(st.framesDone > 20, "and wrote about a second and a half of frames (%lld)",
                   static_cast<long long>(st.framesDone));

            const Opened o = openResult(path);
            check(o.ok, "what it wrote opens");
            checkf(o.width == 320 && o.height == 240,
                   "at the device's own picture size (%dx%d)", o.width, o.height);
            check(o.indexed, "and it has an index — the trailer went down");
            checkf(o.duration > 1.0 && o.duration < 2.5, "about as long as asked (%.2f s)",
                   o.duration);
        }
    }

    // ── stopping is how a recording ends ───────────────────────────────────
    //
    // The rule this whole job is arranged around. A render that is stopped is
    // Cancelled because something was abandoned; a recording that is stopped is
    // Done, because the length was the open question and stopping answered it.
    std::printf("\nStopping\n");
    if (!avcodec_find_encoder_by_name("libx264")) {
        std::printf("  SKIP  no libx264 in this build\n");
    } else {
        const std::string path = dir + "/capture-stopped.mp4";
        std::filesystem::remove(path);

        CaptureSettings c;
        c.source = lavfi("testsrc=size=320x240:rate=25");   // no -t: until stopped
        c.output.path = path;
        c.output.format = "mp4";
        c.output.videoCodec = "libx264";
        c.output.preset = "ultrafast";
        c.output.crf = 30;
        c.output.includeAudio = false;

        std::string err;
        const bool started = startCapture(c, &err);
        checkf(started, "an open-ended recording starts%s%s", started ? "" : ": ", err.c_str());
        if (started) {
            const ExportStatus mid = exportStatus();
            check(mid.openEnded, "and says it is open-ended");
            checkf(mid.framesTotal == 0,
                   "with no frame total, because nobody knows (%lld)",
                   static_cast<long long>(mid.framesTotal));

            // A second job while one holds the slot is refused, which is what
            // "no preview and no export while recording" is made of.
            CaptureSettings again = c;
            again.output.path = dir + "/capture-second.mp4";
            std::string busy;
            // Called on its own line: argument evaluation order is
            // unspecified, and `busy.c_str()` beside the call that fills it
            // printed uninitialised bytes half the time.
            const bool second = startCapture(again, &busy);
            checkf(!second, "a second job is refused (%s)", busy.c_str());

            // Long enough to have written something worth keeping.
            for (int i = 0; i < 200 && exportStatus().framesDone < 12; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            const int64_t caught = exportStatus().framesDone;
            stopCapture();
            const ExportStatus st = waitForJob(30.0);

            checkf(st.state == ExportStatus::State::Done,
                   "stopping a recording is Done, not Cancelled (%s)", st.stage.c_str());
            checkf(st.framesDone >= caught,
                   "the frame it was on was finished (%lld caught, %lld written)",
                   static_cast<long long>(caught), static_cast<long long>(st.framesDone));
            checkf(st.bytesWritten > 0, "and the file has bytes in it (%lld)",
                   static_cast<long long>(st.bytesWritten));

            const Opened o = openResult(path);
            check(o.ok, "a stopped recording opens");
            check(o.indexed, "and it has an index — this is the whole point");
            checkf(o.duration > 0.1, "with the part that was recorded in it (%.2f s)",
                   o.duration);
        }
    }

    // ── sound ──────────────────────────────────────────────────────────────
    //
    // The lavfi device can produce a tone, so the audio path of the capture
    // loop is reachable without a microphone.
    std::printf("\nRecording sound\n");
    if (!avcodec_find_encoder_by_name("libx264") || !avcodec_find_encoder_by_name("aac")) {
        std::printf("  SKIP  no libx264/aac in this build\n");
    } else {
        const std::string path = dir + "/capture-av.mp4";
        std::filesystem::remove(path);

        CaptureSettings c;
        // Two pads out of one lavfi graph is one `-i` with two streams in it,
        // which is exactly the shape `-f dshow -i "video=Cam:audio=Mic"` has.
        c.source = lavfi("testsrc=size=320x240:rate=25[out0];sine=frequency=440[out1]", 1.5);
        c.output.path = path;
        c.output.format = "mp4";
        c.output.videoCodec = "libx264";
        c.output.audioCodec = "aac";
        c.output.preset = "ultrafast";
        c.output.crf = 30;

        std::string err;
        if (!startCapture(c, &err)) {
            checkf(false, "a device with sound records: %s", err.c_str());
        } else {
            const ExportStatus st = waitForJob(30.0);
            checkf(st.state == ExportStatus::State::Done, "a device with sound records%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            const Opened o = openResult(path);
            check(o.ok, "and what it wrote opens");
            checkf(o.streams == 2, "with both streams in it (%d)", o.streams);
        }
    }

    // ── recording to more than one place ───────────────────────────────────
    //
    // A recording is a device into a `Writer`, and a `Writer` is a muxer — so a
    // recording that goes to several destinations is `-f tee` and nothing else
    // new. This is the check that says so, because "recording *and* streaming
    // the same capture" is the case the whole tee decision was taken for: one
    // encode, one real-time deadline, and a file kept while the same packets go
    // somewhere else.
    std::printf("\nRecording to several destinations\n");
    if (!avcodec_find_encoder_by_name("libx264")) {
        std::printf("  SKIP  no libx264 in this build\n");
    } else {
        const std::string keep = dir + "/capture-tee.mkv";
        const std::string also = dir + "/capture-tee.ts";
        std::filesystem::remove(keep);
        std::filesystem::remove(also);

        CaptureSettings c;
        c.source = lavfi("testsrc=size=320x240:rate=25", 1.0);
        c.output.path = "[f=matroska]" + keep + "|[f=mpegts]" + also;
        c.output.format = "tee";
        c.output.videoCodec = "libx264";
        c.output.preset = "ultrafast";
        c.output.crf = 30;
        c.output.includeAudio = false;
        c.output.faststart = false;

        std::string err;
        if (!startCapture(c, &err)) {
            checkf(false, "a recording through tee starts: %s", err.c_str());
        } else {
            const ExportStatus st = waitForJob(30.0);
            checkf(st.state == ExportStatus::State::Done,
                   "a recording through tee finishes%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            checkf(st.piecesWritten == 2, "and reports both destinations (%lld)",
                   static_cast<long long>(st.piecesWritten));
            const Opened a = openResult(keep);
            const Opened b = openResult(also);
            check(a.ok && b.ok, "both of them open");
            checkf(a.width == 320 && b.width == 320,
                   "at the device's own size (%dx%d and %dx%d)", a.width, a.height,
                   b.width, b.height);
            check(a.indexed, "and the one that is a file has an index — the trailer went down");
        }
    }

    // ── what this machine actually has ─────────────────────────────────────
    //
    // Whatever the answer is, it is asserted, and there are three of them
    // rather than two. gdigrab opens and hands over frames; or it does not
    // open, and says why; or it opens and Windows refuses every grab, which is
    // what a locked workstation or a disconnected session looks like from here
    // — `Failed to capture image (error 5)` is ERROR_ACCESS_DENIED, and no
    // amount of correctness in this binary earns a picture of a desktop it is
    // not allowed to see.
    //
    // The third branch is stated loudly and does not fail, because the machine
    // being locked is not a defect in ffmpeg-bro. It is not a silent skip
    // either: it must still have opened, and it must still say what stopped it.
    // What is refused in every branch is a short read — one frame out of three
    // means the reader is wrong, and that is this test's job to catch.
    std::printf("\nThis machine\n");
#ifdef _WIN32
    {
        MediaInput screen;
        screen.format = "gdigrab";
        screen.path = "desktop";
        screen.options.push_back({"framerate", "10"});
        screen.options.push_back({"video_size", "320x240"});
        std::string err;
        const int n = readFrames(screen, 3, &err);
        if (n < 0) {
            checkf(!err.empty(), "gdigrab did not open here, and said why: %s", err.c_str());
        } else if (n == 0) {
            checkf(!err.empty(),
                   "gdigrab opened, and this session would not be grabbed: %s", err.c_str());
        } else {
            checkf(n == 3, "gdigrab opened and grabbed the screen (%d frames)", n);
        }

        const DeviceSourceList cams = deviceSources("dshow");
        if (cams.ok) {
            std::printf("  dshow lists %zu source(s)\n", cams.sources.size());
            bool typed = true;
            for (const auto& s : cams.sources) if (s.name.empty()) typed = false;
            check(typed, "every dshow source has the exact name -i takes");
        } else {
            checkf(!cams.error.empty(), "dshow could not be enumerated, and said why: %s",
                   cams.error.c_str());
        }

        // gdigrab has nothing to enumerate and says so, which is a different
        // answer from an empty list.
        const DeviceSourceList none = deviceSources("gdigrab");
        checkf(!none.ok && !none.error.empty(),
               "gdigrab is named directly rather than listed (%s)", none.error.c_str());
    }
#else
    std::printf("  not Windows: gdigrab and dshow are not this platform's\n");
#endif

    std::printf("\n%d/%d checks passed\n", g_checks - g_failures, g_checks);
    return g_failures == 0 ? 0 : 1;
}
