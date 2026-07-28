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
// The Graph stage puts `color`, `testsrc`, `sine` and `movie` into the *filter
// graph*, where they are nodes with no input pad and the graph is what runs
// them — `tests/ui_graph.js` is where that is covered. The lavfi *device* wraps
// a whole filtergraph up as a demuxer so that
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
#include "ffmpeg_report.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <utility>
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

bool haveFilter(const std::string& name) {
    for (const auto& f : availableFilters())
        if (f.name == name) return true;
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
    /// Every picture stream's size, in the order the muxer numbered them —
    /// which is the order the stream list was written in, and therefore the
    /// only way to check that `pad:left` went to the stream it was asked for.
    std::vector<std::pair<int, int>> pictures;
    int sounds = 0;
    double rate = 0;        // the first picture stream's declared frame rate
    int64_t packets = 0;    // packets on the first picture stream
    /// Each stream's own length, in the order the muxer numbered them. The
    /// container's duration is the longest of them, which says nothing about
    /// whether a picture and a soundtrack recorded together came out the same
    /// length — and that is the whole question about a session.
    std::vector<double> seconds;
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
    int first = -1;
    for (unsigned i = 0; i < fc->nb_streams; ++i) {
        o.seconds.push_back(fc->streams[i]->duration != AV_NOPTS_VALUE
                                ? fc->streams[i]->duration * av_q2d(fc->streams[i]->time_base)
                                : 0.0);
        const AVCodecParameters* p = fc->streams[i]->codecpar;
        if (p->codec_type == AVMEDIA_TYPE_VIDEO) {
            o.width = p->width;
            o.height = p->height;
            o.pictures.push_back({p->width, p->height});
            if (first < 0) {
                first = static_cast<int>(i);
                const AVRational r = fc->streams[i]->avg_frame_rate.num
                                         ? fc->streams[i]->avg_frame_rate
                                         : fc->streams[i]->r_frame_rate;
                o.rate = r.num > 0 && r.den > 0 ? av_q2d(r) : 0.0;
            }
        } else if (p->codec_type == AVMEDIA_TYPE_AUDIO) {
            o.sounds++;
        }
    }
    if (first >= 0) {
        AVPacket* pkt = av_packet_alloc();
        while (av_read_frame(fc, pkt) >= 0) {
            if (pkt->stream_index == first) o.packets++;
            av_packet_unref(pkt);
        }
        av_packet_free(&pkt);
        av_seek_frame(fc, -1, 0, AVSEEK_FLAG_BACKWARD);
    }
    // A file with no index is a file that cannot be seeked. That is exactly
    // what a recording whose trailer never went down looks like, and it is the
    // one failure this whole job is arranged around.
    o.indexed = av_seek_frame(fc, -1, 0, AVSEEK_FLAG_BACKWARD) >= 0;
    avformat_close_input(&fc);
    return o;
}

/// What one picture stream of a file averages to, per channel.
///
/// A size is not content: a crop of the left of a picture and a crop of the
/// right are the same size and different pictures, and a swapped-crop mistake
/// is exactly the one a dimension check passes. `testsrc` differs left from
/// right, so the mean colour is enough to tell one from the other and it needs
/// no reference file to compare against.
struct Mean {
    bool ok = false;
    double r = 0, g = 0, b = 0;
};

double away(const Mean& a, const Mean& b) {
    const double dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return std::sqrt(dr * dr + dg * dg + db * db);
}

/// The mean over the whole picture, or — given a rectangle — over that part of
/// it. A session's second input arrives *somewhere in particular*, so the check
/// that it arrived at all is a reading of the corner it was overlaid into and
/// not of the average of a picture it is a sixteenth of.
Mean meanOf(const std::string& path, int nthPicture, int skip, int rx = 0, int ry = 0,
            int rw = 0, int rh = 0) {
    Mean m;
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0 || !fc) return m;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return m; }

    int idx = -1, seen = 0;
    for (unsigned i = 0; i < fc->nb_streams; ++i)
        if (fc->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && seen++ == nthPicture) {
            idx = static_cast<int>(i);
            break;
        }
    if (idx < 0) { avformat_close_input(&fc); return m; }

    const AVCodec* dec = avcodec_find_decoder(fc->streams[idx]->codecpar->codec_id);
    AVCodecContext* c = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!c || avcodec_parameters_to_context(c, fc->streams[idx]->codecpar) < 0 ||
        avcodec_open2(c, dec, nullptr) < 0) {
        if (c) avcodec_free_context(&c);
        avformat_close_input(&fc);
        return m;
    }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* f = av_frame_alloc();
    SwsContext* sws = nullptr;
    std::vector<uint8_t> buf;
    int got = 0;
    while (!m.ok && av_read_frame(fc, pkt) >= 0) {
        if (pkt->stream_index == idx && avcodec_send_packet(c, pkt) >= 0) {
            while (avcodec_receive_frame(c, f) >= 0) {
                if (got++ < skip) { av_frame_unref(f); continue; }
                const int w = f->width, h = f->height;
                // Slack past the last row, for the reason Rgba::kSwsSlack exists.
                buf.assign(static_cast<size_t>(w) * 4 * h + 256, 0);
                sws = sws_getCachedContext(sws, w, h, static_cast<AVPixelFormat>(f->format), w,
                                           h, AV_PIX_FMT_RGBA, SWS_BILINEAR, nullptr, nullptr,
                                           nullptr);
                uint8_t* dst[4] = {buf.data(), nullptr, nullptr, nullptr};
                int stride[4] = {w * 4, 0, 0, 0};
                if (sws && sws_scale(sws, f->data, f->linesize, 0, h, dst, stride) > 0) {
                    const int x0 = std::max(0, std::min(rx, w));
                    const int y0 = std::max(0, std::min(ry, h));
                    const int x1 = rw > 0 ? std::min(w, x0 + rw) : w;
                    const int y1 = rh > 0 ? std::min(h, y0 + rh) : h;
                    double sr = 0, sg = 0, sb = 0;
                    size_t n = 0;
                    for (int y = y0; y < y1; ++y)
                        for (int x = x0; x < x1; ++x) {
                            const size_t i = (static_cast<size_t>(y) * w + x) * 4;
                            sr += buf[i];
                            sg += buf[i + 1];
                            sb += buf[i + 2];
                            n++;
                        }
                    if (n > 0) {
                        m.r = sr / n;
                        m.g = sg / n;
                        m.b = sb / n;
                        m.ok = true;
                    }
                }
                av_frame_unref(f);
                break;
            }
        }
        av_packet_unref(pkt);
    }
    if (sws) sws_freeContext(sws);
    av_frame_free(&f);
    av_packet_free(&pkt);
    avcodec_free_context(&c);
    avformat_close_input(&fc);
    return m;
}

/// How loud a file's soundtrack is, as one number. `volume=0.5` in the graph
/// has to come out as half of this and nothing else can say so.
double rmsOf(const std::string& path) {
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0 || !fc) return -1.0;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return -1.0; }
    const int idx = av_find_best_stream(fc, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (idx < 0) { avformat_close_input(&fc); return -1.0; }

    const AVCodec* dec = avcodec_find_decoder(fc->streams[idx]->codecpar->codec_id);
    AVCodecContext* c = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!c || avcodec_parameters_to_context(c, fc->streams[idx]->codecpar) < 0 ||
        avcodec_open2(c, dec, nullptr) < 0) {
        if (c) avcodec_free_context(&c);
        avformat_close_input(&fc);
        return -1.0;
    }

    SwrContext* swr = nullptr;
    AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
    if (swr_alloc_set_opts2(&swr, &mono, AV_SAMPLE_FMT_FLT, c->sample_rate, &c->ch_layout,
                            c->sample_fmt, c->sample_rate, 0, nullptr) < 0 ||
        swr_init(swr) < 0) {
        if (swr) swr_free(&swr);
        avcodec_free_context(&c);
        avformat_close_input(&fc);
        return -1.0;
    }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* f = av_frame_alloc();
    std::vector<float> out;
    double sum = 0;
    int64_t n = 0;
    while (av_read_frame(fc, pkt) >= 0) {
        if (pkt->stream_index == idx && avcodec_send_packet(c, pkt) >= 0) {
            while (avcodec_receive_frame(c, f) >= 0) {
                out.assign(static_cast<size_t>(f->nb_samples) + 256, 0.0f);
                auto* dst = reinterpret_cast<uint8_t*>(out.data());
                const int got = swr_convert(swr, &dst, f->nb_samples,
                                            const_cast<const uint8_t**>(f->extended_data),
                                            f->nb_samples);
                for (int i = 0; i < got; ++i) { sum += out[i] * out[i]; n++; }
                av_frame_unref(f);
            }
        }
        av_packet_unref(pkt);
    }
    av_frame_free(&f);
    av_packet_free(&pkt);
    swr_free(&swr);
    avcodec_free_context(&c);
    avformat_close_input(&fc);
    return n > 0 ? std::sqrt(sum / double(n)) : -1.0;
}

/// A recording of the device, through `graph`, into `path`. Everything these
/// sections have in common, so that what each of them says is the one thing it
/// is about.
CaptureSettings recording(const MediaInput& source, const std::string& path,
                          const std::string& graph) {
    CaptureSettings c;
    c.source = source;
    c.output.path = path;
    c.output.format = "mp4";
    c.output.videoCodec = "libx264";
    c.output.audioCodec = "aac";
    c.output.preset = "ultrafast";
    c.output.crf = 30;
    c.output.filterGraph = graph;
    return c;
}

/// The same, reading several live inputs at once. `sources` is what numbers
/// them for the graph: the first is `[0:v]`/`[0:a]`, the second `[1:…]`.
CaptureSettings session(const std::vector<MediaInput>& sources, const std::string& path,
                        const std::string& graph) {
    CaptureSettings c = recording(sources.front(), path, graph);
    c.sources = sources;
    return c;
}

/// One audio stream out of `[aout]` and nothing else.
///
/// A recording with no picture in it has to say so, because an empty stream
/// list means "the usual two" and the usual two include a composite the graph
/// has no pad for — which is refused, correctly, by the same `resolvePads` a
/// render goes through.
void soundOnly(CaptureSettings& c) {
    ExportStream a;
    a.kind = "audio";
    a.source = "pad:aout";
    a.codec = "aac";
    c.output.streams.push_back(a);
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
            checkf(st.bytesWritten > 0, "and the file has bytes in it (%lld)",
                   static_cast<long long>(st.bytesWritten));

            const Opened o = openResult(path);
            check(o.ok, "a stopped recording opens");
            check(o.indexed, "and it has an index — this is the whole point");
            checkf(o.duration > 0.1, "with the part that was recorded in it (%.2f s)",
                   o.duration);
            // **Against the file, not against the counter.** `framesDone` only
            // ever goes up, so comparing it with a value read out of it a
            // moment earlier is a comparison of a number with itself and passes
            // whatever the stop did. What the claim is about is whether the
            // frames the status counted are on disk, and only the file can
            // answer that: at 25 fps a recording of `framesDone` pictures is
            // that many twenty-fifths long, give or take the last one.
            const double wanted = (st.framesDone - 1) / 25.0;
            checkf(o.duration >= wanted && st.framesDone >= caught,
                   "and every frame it counted is in it (%lld caught, %lld written, "
                   "%.2f s on disk against %.2f s of frames)",
                   static_cast<long long>(caught), static_cast<long long>(st.framesDone),
                   o.duration, wanted);
        }
    }

    // ── a recording that never starts ──────────────────────────────────────
    //
    // `startCapture` opens the device before it starts a thread, so that "there
    // is no camera called that" arrives as a refusal from the call rather than
    // as a job that fails a moment later. What that path has to do is give back
    // everything the claim took — and the claim takes two things, not one: the
    // run slot, and a number in the report channel that every `av_log` line
    // said from here on is stamped with. `job::Held` closes both, and it lives
    // inside the job body, which this path never reaches.
    //
    // With only the slot given back, the channel's job number stayed set for
    // the rest of the process: a probe, a decoder complaining during playback
    // and the next render's own messages were all attributed to a recording
    // that never happened. Nothing fails, nothing is slow, and every surface
    // reading the report is quietly wrong — which is why it is asserted here
    // rather than left to be noticed.
    std::printf("\nA recording that never starts\n");
    {
        const uint64_t before = currentRenderJob();
        checkf(before == 0, "nothing is being said for, before this (%llu)",
               static_cast<unsigned long long>(before));

        CaptureSettings bad;
        bad.source.path = "video=there-is-no-such-device";
        bad.source.format = "dshow";
        bad.output.path = dir + "/capture-never.mp4";
        bad.output.format = "mp4";
        bad.output.videoCodec = "libx264";
        std::string err;
        const bool started = startCapture(bad, &err);
        checkf(!started, "a device that is not there is refused (%s)", err.c_str());
        checkf(!err.empty(), "with a reason on it");

        const uint64_t after = currentRenderJob();
        checkf(after == 0,
               "and the report channel is not left attributing every later line to it "
               "(job %llu)", static_cast<unsigned long long>(after));

        // And the slot itself is free, which was already true and is the other
        // half of the same sentence: one of the two being given back is the
        // state this exists to make unreachable.
        CaptureSettings ok = bad;
        ok.source = lavfi("testsrc=size=160x120:rate=25", 0.4);
        ok.output.path = dir + "/capture-after-failure.mp4";
        ok.output.preset = "ultrafast";
        ok.output.crf = 30;
        ok.output.includeAudio = false;
        std::string why;
        const bool again = avcodec_find_encoder_by_name("libx264")
                               ? startCapture(ok, &why) : false;
        if (avcodec_find_encoder_by_name("libx264")) {
            checkf(again, "and the next recording still gets the slot (%s)", why.c_str());
            if (again) waitForJob(30.0);
        } else {
            std::printf("  SKIP  the slot is still free — no libx264 to record with\n");
        }
        checkf(currentRenderJob() == 0, "with the channel closed again after it");
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

    // ── a filter graph in the middle of a recording ────────────────────────
    //
    // The device's decoder into libavfilter into the writer, **pushed**: a frame
    // goes in with the device's own timestamp on it and whatever falls out of
    // the sinks is placed on the output's frame grid. Everything below is about
    // what that buys and what it must not quietly get wrong.
    //
    // Note that lavfi runs as fast as it can rather than in real time, and that
    // it does not matter: what places a frame is its *media* timestamp, so a two
    // second recording is two seconds of pictures however long the wall clock
    // took over it.
    std::printf("\nRecording through a filter graph\n");
    if (!avcodec_find_encoder_by_name("libx264")) {
        std::printf("  SKIP  no libx264 in this build\n");
    } else {
        // ── a crop, which is what "record one monitor" is ──────────────────
        const std::string left = dir + "/capture-crop-left.mp4";
        const std::string right = dir + "/capture-crop-right.mp4";
        std::filesystem::remove(left);
        std::filesystem::remove(right);

        CaptureSettings c = recording(lavfi("testsrc=size=320x240:rate=25", 2.0), left,
                                      "[0:v]crop=160:240:0:0[vout]");
        c.output.includeAudio = false;
        std::string err;
        if (!startCapture(c, &err)) {
            checkf(false, "a recording with a filter graph starts: %s", err.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "a cropped recording finishes%s%s", st.error.empty() ? "" : ": ",
                   st.error.c_str());
            const Opened o = openResult(left);
            check(o.ok, "and what it wrote opens");
            checkf(o.width == 160 && o.height == 240,
                   "at the size the graph produces, not the device's (%dx%d)", o.width,
                   o.height);
            check(o.indexed, "with an index — the trailer went down");
            // The `-t` on the device is judged on *output* time, so the graph
            // does not change how long the recording is.
            checkf(o.duration > 1.4 && o.duration < 2.6,
                   "and -t still bounds a graphed capture (%.2f s)", o.duration);
        }

        // ── the content, not the size ─────────────────────────────────────
        //
        // Two recordings of the same device differing only in which half of the
        // picture the crop takes. A swapped crop is the mistake a dimension
        // check cannot see, and testsrc's two halves do not look alike.
        CaptureSettings r = recording(lavfi("testsrc=size=320x240:rate=25", 1.0), right,
                                      "[0:v]crop=160:240:160:0[vout]");
        r.output.includeAudio = false;
        std::string rerr;
        if (!startCapture(r, &rerr)) {
            checkf(false, "the other half records: %s", rerr.c_str());
        } else {
            waitForJob(60.0);
            const Mean a = meanOf(left, 0, 5);
            const Mean b = meanOf(right, 0, 5);
            checkf(a.ok && b.ok, "both crops decode back");
            if (a.ok && b.ok)
                checkf(away(a, b) > 10.0,
                       "and they are different pictures, not the same one twice "
                       "(left %.1f/%.1f/%.1f, right %.1f/%.1f/%.1f, apart by %.1f)",
                       a.r, a.g, a.b, b.r, b.g, b.b, away(a, b));
        }

        // ── two pads, one file ────────────────────────────────────────────
        //
        // The whole reason the pad machinery is worth having in a recording: one
        // encode of a wide grab into two streams that are each part of it. There
        // is no composite row at all here, which is the case where nothing says
        // which pad the canvas is and nothing has to.
        const std::string both = dir + "/capture-pads.mp4";
        std::filesystem::remove(both);
        CaptureSettings p = recording(
            lavfi("testsrc=size=320x240:rate=25", 1.0), both,
            "[0:v]split[l0][r0];[l0]crop=160:240:0:0[left];[r0]crop=160:240:160:0[right]");
        p.output.includeAudio = false;
        for (const char* label : {"pad:left", "pad:right"}) {
            ExportStream st;
            st.kind = "video";
            st.source = label;
            st.codec = "libx264";
            p.output.streams.push_back(st);
        }
        std::string perr;
        if (!startCapture(p, &perr)) {
            checkf(false, "a recording mapped to two pads starts: %s", perr.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "two pads out of one recording finishes%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            const Opened o = openResult(both);
            check(o.ok, "and one file came out");
            checkf(o.pictures.size() == 2, "with two picture streams in it (%zu)",
                   o.pictures.size());
            if (o.pictures.size() == 2)
                checkf(o.pictures[0].first == 160 && o.pictures[1].first == 160,
                       "each of them the pad's own size (%dx%d and %dx%d)",
                       o.pictures[0].first, o.pictures[0].second, o.pictures[1].first,
                       o.pictures[1].second);
            const Mean a = meanOf(both, 0, 5);
            const Mean b = meanOf(both, 1, 5);
            if (a.ok && b.ok)
                checkf(away(a, b) > 10.0,
                       "and the streams are the two halves rather than one twice "
                       "(apart by %.1f)", away(a, b));
            else
                check(false, "and both streams decode back");
        }

        // ── a rate change is an ordinary filter ───────────────────────────
        //
        // Placement happens after the graph, so nothing here knows `fps` is
        // special: the frames arrive stamped ten to the second and are put where
        // they fall.
        const std::string slow = dir + "/capture-fps.mp4";
        std::filesystem::remove(slow);
        CaptureSettings f = recording(lavfi("testsrc=size=320x240:rate=25", 2.0), slow,
                                      "[0:v]fps=10[vout]");
        f.output.includeAudio = false;
        std::string ferr;
        if (!startCapture(f, &ferr)) {
            checkf(false, "a recording that changes rate starts: %s", ferr.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done, "a rate-changed recording finishes%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            const Opened o = openResult(slow);
            check(o.ok, "and what it wrote opens");
            checkf(o.rate > 9.0 && o.rate < 11.0,
                   "at the rate the graph produces, not the device's (%.2f fps)", o.rate);
            checkf(o.packets >= 15 && o.packets <= 25,
                   "with about two seconds of frames at that rate (%lld)",
                   static_cast<long long>(o.packets));
        }
    }

    // ── sound through the graph, and sound that goes round it ──────────────
    std::printf("\nA recording's sound, filtered and not\n");
    if (!avcodec_find_encoder_by_name("libx264") || !avcodec_find_encoder_by_name("aac")) {
        std::printf("  SKIP  no libx264/aac in this build\n");
    } else {
        const std::string plain = dir + "/capture-tone.mp4";
        const std::string quiet = dir + "/capture-tone-half.mp4";
        std::filesystem::remove(plain);
        std::filesystem::remove(quiet);
        const MediaInput tone =
            lavfi("testsrc=size=320x240:rate=25[out0];sine=frequency=440[out1]", 1.5);

        // No graph at all: the reference the filtered one is measured against.
        CaptureSettings a = recording(tone, plain, "");
        std::string aerr;
        double loud = -1.0;
        if (!startCapture(a, &aerr)) {
            checkf(false, "the unfiltered tone records: %s", aerr.c_str());
        } else {
            waitForJob(60.0);
            loud = rmsOf(plain);
            checkf(loud > 0.0, "an unfiltered recording of a tone has sound in it (rms %.4f)",
                   loud);
        }

        // The graph reads only the sound, so the *picture* goes straight to the
        // writer — which is the bypass, and is what makes "normalise the
        // microphone while recording the screen" one filter rather than a
        // second pipeline.
        CaptureSettings b = recording(tone, quiet, "[0:a]volume=0.5[aout]");
        std::string berr;
        if (!startCapture(b, &berr)) {
            checkf(false, "a graph on the sound alone records: %s", berr.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done, "a filtered soundtrack finishes%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            const Opened o = openResult(quiet);
            check(o.ok, "and what it wrote opens");
            checkf(o.pictures.size() == 1 && o.sounds == 1,
                   "with both streams in it — the picture went round the graph (%zu picture, "
                   "%d sound)", o.pictures.size(), o.sounds);
            checkf(o.width == 320 && o.height == 240,
                   "the picture still the device's own (%dx%d)", o.width, o.height);
            const double half = rmsOf(quiet);
            if (loud > 0.0 && half > 0.0)
                checkf(half / loud > 0.42 && half / loud < 0.58,
                       "and volume=0.5 halved the sound (%.4f against %.4f, ratio %.3f)", half,
                       loud, half / loud);
            else
                check(false, "and the filtered soundtrack decodes back");
        }

        // The other way round: the graph takes the picture and the sound goes
        // round it. A file missing its soundtrack is the failure.
        const std::string kept = dir + "/capture-sound-direct.mp4";
        std::filesystem::remove(kept);
        CaptureSettings v = recording(tone, kept, "[0:v]crop=160:240:0:0[vout]");
        std::string verr;
        if (!startCapture(v, &verr)) {
            checkf(false, "a graph on the picture alone records: %s", verr.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "a video-only graph finishes%s%s", st.error.empty() ? "" : ": ",
                   st.error.c_str());
            const Opened o = openResult(kept);
            checkf(o.ok && o.sounds == 1,
                   "and the soundtrack is still in the file (%d sound streams)", o.sounds);
            checkf(o.width == 160, "with the picture cropped (%dx%d)", o.width, o.height);
        }
    }

    // ── stopping a graphed recording ───────────────────────────────────────
    //
    // The rule the whole job is arranged around does not change because there
    // are filters in the middle: stop is the normal end, so it is Done, and what
    // was recorded is a file with an index in it.
    std::printf("\nStopping a graphed recording\n");
    if (!avcodec_find_encoder_by_name("libx264")) {
        std::printf("  SKIP  no libx264 in this build\n");
    } else {
        const std::string path = dir + "/capture-graph-stopped.mp4";
        std::filesystem::remove(path);
        CaptureSettings c = recording(lavfi("testsrc=size=320x240:rate=25"), path,
                                      "[0:v]hflip[vout]");
        c.output.includeAudio = false;
        std::string err;
        if (!startCapture(c, &err)) {
            checkf(false, "an open-ended graphed recording starts: %s", err.c_str());
        } else {
            for (int i = 0; i < 400 && exportStatus().framesDone < 12; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            stopCapture();
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "stopping one is still Done, not Cancelled (%s)", st.stage.c_str());
            const Opened o = openResult(path);
            check(o.ok && o.indexed, "and what it wrote opens and has an index");
        }
    }

    // ── what a recording's graph refuses, and in what words ────────────────
    //
    // Every one of these is a decision somebody made that cannot work, and the
    // rule this repo follows is that a refusal arrives where the decision was
    // made. Three of the four therefore come back from `startCapture` itself,
    // with the graph still on the screen; the fourth cannot, because a pad's
    // existence is only known once the graph is configured and the graph is only
    // configured once the device has handed over a frame.
    std::printf("\nWhat a graphed recording refuses\n");
    {
        std::string err;
        CaptureSettings noSound = recording(lavfi("testsrc=size=320x240:rate=25", 1.0),
                                            dir + "/capture-refused.mp4",
                                            "[0:a]volume=0.5[aout]");
        checkf(!startCapture(noSound, &err), "sound asked of a device that has none is refused");
        checkf(err.find("no sound") != std::string::npos, "naming the pad and the reason (%s)",
               err.c_str());

        err.clear();
        CaptureSettings files = recording(lavfi("testsrc=size=320x240:rate=25", 1.0),
                                          dir + "/capture-refused.mp4", "[0:v]hflip[vout]");
        ExportGraphInput in;
        in.label = "0:v";
        in.path = "somewhere.mp4";
        in.stream = "v";
        files.output.filterInputs.push_back(in);
        checkf(!startCapture(files, &err), "a graph given input files of its own is refused");
        checkf(err.find("fed by the device") != std::string::npos,
               "saying what feeds a recording's graph (%s)", err.c_str());

        err.clear();
        CaptureSettings missing = recording(lavfi("testsrc=size=320x240:rate=25", 1.0),
                                            dir + "/capture-refused.mp4",
                                            "[0:v]no_such_filter_here[vout]");
        checkf(!startCapture(missing, &err), "a filter this build has not got is refused");
        checkf(err.find("will not parse") != std::string::npos, "before anything starts (%s)",
               err.c_str());

        // The one that cannot be refused up front. The sentence is the render's,
        // out of the shared `resolvePads`, and it lists the pads there were —
        // which is the whole difference between a refusal and a complaint.
        if (avcodec_find_encoder_by_name("libx264")) {
            err.clear();
            CaptureSettings pad = recording(lavfi("testsrc=size=320x240:rate=25", 1.0),
                                            dir + "/capture-nopad.mp4",
                                            "[0:v]crop=160:240:0:0[left]");
            pad.output.includeAudio = false;
            ExportStream row;
            row.kind = "video";
            row.source = "pad:right";
            row.codec = "libx264";
            pad.output.streams.push_back(row);
            if (!startCapture(pad, &err)) {
                checkf(false, "a pad naming nothing gets as far as the job: %s", err.c_str());
            } else {
                const ExportStatus st = waitForJob(60.0);
                checkf(st.state == ExportStatus::State::Failed,
                       "a pad that names no pad fails the recording (%s)", st.stage.c_str());
                checkf(st.error.find("[right]") != std::string::npos &&
                           st.error.find("[left]") != std::string::npos,
                       "naming what was asked for and what there was (%s)", st.error.c_str());
            }
        } else {
            std::printf("  SKIP  no libx264 to reach the pad refusal with\n");
        }
    }

    // ── several live inputs, one file ──────────────────────────────────────
    //
    // A screen grab and a camera composited into one recording. Two things are
    // genuinely new and both are about there being more than one clock in the
    // room: every device is read on a thread of its own, because
    // `av_read_frame` blocks and a camera that has gone quiet must not starve
    // the grab beside it; and the session runs on the **wall clock**, sampling
    // each video feed at a tick per output frame, because no input's clock can
    // be the master without starving the others.
    //
    // **lavfi is the wrong shape for a wall clock until it is paced.** It
    // produces frames as fast as it can, so a two-second session would sample a
    // burst that was over in a fiftieth of a second down to almost nothing.
    // `realtime` (and `arealtime` for sound) is libavfilter's own answer and is
    // what makes a lavfi input behave like a device: it holds each frame back
    // until its timestamp is due. Everything below is paced with it, which is
    // also why these sections are the only ones in this file that cost real
    // seconds.
    std::printf("\nSeveral live inputs\n");
    if (!avcodec_find_encoder_by_name("libx264")) {
        std::printf("  SKIP  no libx264 in this build\n");
    } else if (!haveFilter("realtime")) {
        std::printf("  SKIP  this build has no realtime filter to pace a lavfi input with\n");
    } else {
        // ── two pictures, one file ────────────────────────────────────────
        //
        // The second input is scaled small and overlaid on the corner of the
        // first. What decides it is the *content of that corner*: a session
        // that read only `[0:v]` would produce a file of exactly the right
        // size, the right length and the right rate with the second device
        // nowhere in it, and only the picture says otherwise.
        const std::string base = dir + "/session-base.mp4";
        const std::string over = dir + "/session-overlay.mp4";
        std::filesystem::remove(base);
        std::filesystem::remove(over);

        // The reference runs on its own media clock — one input, so nothing has
        // changed for it and it need not be paced or take two real seconds.
        CaptureSettings a = recording(lavfi("testsrc=size=320x240:rate=25", 1.0), base,
                                      "[0:v]null[vout]");
        a.output.includeAudio = false;
        std::string aerr;
        if (!startCapture(a, &aerr)) checkf(false, "the base picture records: %s", aerr.c_str());
        else waitForJob(60.0);

        CaptureSettings b = session(
            {lavfi("testsrc=size=320x240:rate=25,realtime", 2.0),
             lavfi("color=c=red:s=160x120:r=25,realtime", 2.0)},
            over, "[1:v]scale=80:60[small];[0:v][small]overlay=0:0[vout]");
        b.output.includeAudio = false;
        std::string berr;
        if (!startCapture(b, &berr)) {
            checkf(false, "a session of two live pictures starts: %s", berr.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "a session of two live pictures finishes%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            const Opened o = openResult(over);
            check(o.ok, "and what it wrote opens");
            checkf(o.pictures.size() == 1, "as one picture stream (%zu)", o.pictures.size());
            checkf(o.width == 320 && o.height == 240,
                   "the size of the input it was composited onto (%dx%d)", o.width, o.height);
            check(o.indexed, "with an index — the trailer went down");
            checkf(o.duration > 1.2 && o.duration < 2.8,
                   "about as long as the shortest -t on it (%.2f s)", o.duration);

            const Mean corner = meanOf(over, 0, 10, 0, 0, 80, 60);
            const Mean was = meanOf(base, 0, 10, 0, 0, 80, 60);
            checkf(corner.ok && was.ok, "both corners decode back");
            if (corner.ok && was.ok) {
                checkf(away(corner, was) > 20.0,
                       "and the corner is not what the first input alone put there "
                       "(%.1f/%.1f/%.1f against %.1f/%.1f/%.1f, apart by %.1f)",
                       corner.r, corner.g, corner.b, was.r, was.g, was.b, away(corner, was));
                // Red, unambiguously: a difference could be a moving bar, and a
                // red patch could only have come from the second device.
                checkf(corner.r > 140.0 && corner.r - corner.g > 60.0 &&
                           corner.r - corner.b > 60.0,
                       "and it is the second input's red (%.1f/%.1f/%.1f)", corner.r, corner.g,
                       corner.b);
            }
        }
    }

    // ── two sounds, mixed ──────────────────────────────────────────────────
    //
    // The sound half of the same claim, and it is a different mechanism: sound
    // is not sampled at the tick — dropping or repeating a block of samples is
    // audible in a way a repeated picture is not — but stamped with when it
    // arrived and smoothed by `aresample=async` in front of the graph. What is
    // asserted is only that the second input reached the mix: two tones summed
    // are louder than either alone, and this is not a calibration.
    std::printf("\nTwo sounds, mixed\n");
    if (!avcodec_find_encoder_by_name("aac")) {
        std::printf("  SKIP  no aac in this build\n");
    } else if (!haveFilter("arealtime")) {
        std::printf("  SKIP  this build has no arealtime filter to pace a lavfi input with\n");
    } else {
        const std::string one = dir + "/session-tone-a.m4a";
        const std::string two = dir + "/session-tone-b.m4a";
        const std::string mix = dir + "/session-tone-mix.m4a";
        for (const std::string& p : {one, two, mix}) std::filesystem::remove(p);

        // 0.4 apiece rather than full scale: two full-scale tones summed peak
        // at 2.0 and the encoder clips them, which would measure the clipping
        // rather than the mix.
        double solo[2] = {-1.0, -1.0};
        const char* freqs[2] = {"440", "660"};
        const std::string* paths[2] = {&one, &two};
        for (int i = 0; i < 2; ++i) {
            CaptureSettings s = recording(
                lavfi(std::string("sine=frequency=") + freqs[i] + ":sample_rate=48000", 1.0),
                *paths[i], "[0:a]volume=0.4[aout]");
            s.output.format = "mp4";
            soundOnly(s);
            std::string err;
            if (!startCapture(s, &err)) {
                checkf(false, "a tone on its own records: %s", err.c_str());
            } else {
                waitForJob(60.0);
                solo[i] = rmsOf(*paths[i]);
            }
        }
        checkf(solo[0] > 0.0 && solo[1] > 0.0, "each tone alone has sound in it (%.4f, %.4f)",
               solo[0], solo[1]);

        CaptureSettings m = session(
            {lavfi("sine=frequency=440:sample_rate=48000,arealtime", 2.0),
             lavfi("sine=frequency=660:sample_rate=48000,arealtime", 2.0)},
            mix,
            "[0:a]volume=0.4[a0];[1:a]volume=0.4[a1];[a0][a1]amix=inputs=2:normalize=0[aout]");
        m.output.format = "mp4";
        soundOnly(m);
        std::string merr;
        if (!startCapture(m, &merr)) {
            checkf(false, "a session of two live sounds starts: %s", merr.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "a session of two live sounds finishes%s%s", st.error.empty() ? "" : ": ",
                   st.error.c_str());
            const double together = rmsOf(mix);
            const double loudest = std::max(solo[0], solo[1]);
            checkf(together > 0.0, "and there is sound in the result (rms %.4f)", together);
            if (together > 0.0 && loudest > 0.0)
                checkf(together > loudest * 1.15,
                       "louder than either alone — the second input reached the mix "
                       "(%.4f against %.4f and %.4f, ratio %.2f)", together, solo[0], solo[1],
                       together / loudest);
        }
    }

    // ── a picture and a sound, and a second picture over it ────────────────
    //
    // The two halves at once, which is the shape a screen grab with the desktop
    // audio plus a webcam actually has. The durations are the check worth
    // having: sound stamped on arrival and pictures placed on the tick are two
    // different clocks agreeing, and a file whose soundtrack is half a second
    // longer than its picture is what disagreeing looks like.
    std::printf("\nA session's picture and sound together\n");
    if (!avcodec_find_encoder_by_name("libx264") || !avcodec_find_encoder_by_name("aac")) {
        std::printf("  SKIP  no libx264/aac in this build\n");
    } else if (!haveFilter("realtime") || !haveFilter("arealtime")) {
        std::printf("  SKIP  this build has no realtime/arealtime to pace a lavfi input with\n");
    } else {
        const std::string path = dir + "/session-av.mp4";
        std::filesystem::remove(path);
        CaptureSettings c = session(
            {lavfi("testsrc=size=320x240:rate=25,realtime[out0];"
                   "sine=frequency=440:sample_rate=48000,arealtime[out1]", 2.0),
             lavfi("color=c=blue:s=160x120:r=25,realtime", 2.0)},
            path,
            "[1:v]scale=80:60[small];[0:v][small]overlay=W-w:0[vout];[0:a]volume=0.4[aout]");
        std::string err;
        if (!startCapture(c, &err)) {
            checkf(false, "a session with sound and two pictures starts: %s", err.c_str());
        } else {
            const ExportStatus st = waitForJob(60.0);
            checkf(st.state == ExportStatus::State::Done,
                   "a session with sound and two pictures finishes%s%s",
                   st.error.empty() ? "" : ": ", st.error.c_str());
            const Opened o = openResult(path);
            check(o.ok, "and what it wrote opens");
            checkf(o.pictures.size() == 1 && o.sounds == 1,
                   "with both streams in it (%zu picture, %d sound)", o.pictures.size(),
                   o.sounds);
            if (o.seconds.size() == 2)
                checkf(std::fabs(o.seconds[0] - o.seconds[1]) < 0.5,
                       "and they are the same length (%.2f s of picture, %.2f s of sound)",
                       o.seconds[0], o.seconds[1]);
            else
                checkf(false, "and both streams report a length (%zu)", o.seconds.size());
            const Mean corner = meanOf(path, 0, 10, 240, 0, 80, 60);
            if (corner.ok)
                checkf(corner.b > 120.0 && corner.b - corner.r > 60.0,
                       "with the second input's blue in the corner it was put in "
                       "(%.1f/%.1f/%.1f)", corner.r, corner.g, corner.b);
            else
                check(false, "and the corner decodes back");
        }
    }

    // ── what a session refuses, and in what words ──────────────────────────
    std::printf("\nWhat a session refuses\n");
    {
        std::string err;
        CaptureSettings noGraph = session({lavfi("testsrc=size=64x48:rate=25", 0.5),
                                           lavfi("testsrc=size=64x48:rate=25", 0.5)},
                                          dir + "/session-refused.mp4", "");
        checkf(!startCapture(noGraph, &err), "two inputs with no graph are refused");
        checkf(err.find("no filter graph") != std::string::npos,
               "saying that the graph is what says how they combine (%s)", err.c_str());

        err.clear();
        CaptureSettings absent = recording(lavfi("testsrc=size=64x48:rate=25", 0.5),
                                           dir + "/session-refused.mp4",
                                           "[0:v][1:v]overlay[vout]");
        absent.output.includeAudio = false;
        checkf(!startCapture(absent, &err),
               "a graph reading an input that was not given is refused");
        checkf(err.find("[1:v]") != std::string::npos &&
                   err.find("no input 1") != std::string::npos,
               "naming the index that is missing (%s)", err.c_str());

        // A device that opens, reports a picture stream, and never produces a
        // frame. Without the bound, a session sits on it for ever with
        // "recording" on the screen and nothing on disk.
        err.clear();
        CaptureSettings dead = session(
            {lavfi("testsrc=size=64x48:rate=25,realtime", 3.0),
             lavfi("testsrc=size=64x48:rate=25:duration=1,trim=end=0", 3.0)},
            dir + "/session-dead.mp4", "[0:v][1:v]overlay[vout]");
        dead.output.includeAudio = false;
        if (!avcodec_find_encoder_by_name("libx264")) {
            std::printf("  SKIP  no libx264 to reach the never-produced refusal with\n");
        } else if (!startCapture(dead, &err)) {
            // Refused before the job — the device would not open at all, which
            // is a different (and earlier) answer than the one under test.
            checkf(!err.empty(),
                   "a device with nothing in it was refused at the open instead (%s)",
                   err.c_str());
        } else {
            const ExportStatus st = waitForJob(30.0);
            checkf(st.state == ExportStatus::State::Failed,
                   "a device that never produces a picture fails the session (%s)",
                   st.stage.c_str());
            checkf(st.error.find("no pictures") != std::string::npos,
                   "naming the device rather than waiting for ever (%s)", st.error.c_str());
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
