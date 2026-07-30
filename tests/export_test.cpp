// Renders a timeline to a file and then opens what it wrote.
//
// Export is the one operation whose output nobody sees until it is finished,
// so the checks here are the ones a person cannot make by looking: that the
// canvas is the size that was asked for, that a clip lands in the rectangle it
// was given and nowhere else, that opacity is honoured, that the sound of two
// overlapping clips is actually mixed, and that the result is a file this
// application can open again.
//
// Nearly every assertion is content-independent — the pass/fail does not depend
// on what the media happens to show — and the handful that are not need the
// source to have a picture in it and, in places, a sound. They are:
//
//   - the brightest-pixel checks, which require the source not to be black at
//     the instant sampled (`filledPeak`, `coveredPeak`, and the two halves of
//     the `hstack`, each of which would read as a dropped input if the picture
//     were black anyway);
//   - the mixer's peak-RMS checks, which require the source to have audible
//     sound. These test themselves first — `srcAudible` — and print a SKIP
//     rather than failing, because "the mixer produced silence" and "the source
//     was silent" are the two answers that must not be confused;
//   - the burn-in comparison, which requires the cue fixtures to exist and is
//     skipped by name when they do not.
//
// This is why the fixtures are *generated* with known content (a moving bar
// over a gradient, a 440/660 Hz tone at -6 dBFS) rather than checked in: a
// mostly-black source makes a picture check pass for the wrong reason, and a
// digitally silent one turns the mixer check into a failure that reads as a
// broken mixer. See tests/make_fixture.cpp.
//
// Two Windows notes for whoever moves this file: it needs `NOMINMAX` (windows.h
// defines `min`/`max` as macros, which `std::max` will not survive) and it
// `#undef`s `near` and `far`, which are empty macros left over from segmented
// memory and which collide with ordinary local names here.
//
// Usage: ffmpeg-bro-exporttest <media-file> [<second-file>]

#include "export_copy.h"
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
// A file with several pictures or several soundtracks in it has to be read one
// stream at a time, which means decoding and converting here rather than
// through probeMedia() or VideoPipeline — both of which answer for the *file*
// and pick the best stream of a kind.
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

// NOMINMAX because windows.h's `min`/`max` macros eat every std::min in the
// file below, with an error that says nothing about where they came from.
#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#pragma comment(lib, "psapi.lib")
// windef.h still defines `near` and `far` — sixteen-bit memory models, thirty
// years on — and this file has a lambda called `near`.
#undef near
#undef far
#endif

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

/// How much memory this process is holding, or 0 where nobody will say.
///
/// There is no way to ask libav how many contexts are open, and a leaked
/// `AVCodecContext` is invisible to every other kind of check — so the one
/// thing a test can do about it is watch the process. Zero means "not
/// measurable here", and every caller treats that as a skip rather than as a
/// pass, because a leak check that quietly stopped checking is worse than none.
size_t residentBytes() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS pmc{};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
        return pmc.WorkingSetSize;
#endif
    return 0;
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
    const ExportStatus st = exportStatus();
    // **A render that failed says why**, everywhere, and this is the one place
    // that can hold the whole suite to it. Six paths in the writer used to
    // `return false` without writing anything into `err`, and what a person got
    // for one of those was a red bar with no sentence on it and an empty report
    // drawer — `reportNote(AV_LOG_ERROR, "render", "")` commits nothing. Silent
    // unless it is broken, because every render in this file goes through here
    // and a PASS line per render would say nothing fifty times.
    if (st.state == ExportStatus::State::Failed && st.error.empty())
        check(false, "a failed render published a reason (this one published none)");
    return st;
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

/// One packet, kept whole. A rewrap's entire claim is that the bytes did not
/// change, and the only way to assert that is to hold both sets and compare
/// them — a count, or a size, or a duration would all pass for a file that had
/// been re-encoded to the same length.
struct Pkt {
    std::vector<uint8_t> data;
    int64_t pts = 0, dts = 0;
    int flags = 0;
    AVRational timeBase{1, 1};
};

std::vector<Pkt> packetsOf(const std::string& path, int stream) {
    std::vector<Pkt> out;
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0) return out;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return out; }
    AVPacket* pkt = av_packet_alloc();
    while (pkt && av_read_frame(fc, pkt) >= 0) {
        if (pkt->stream_index == stream) {
            Pkt p;
            p.data.assign(pkt->data, pkt->data + pkt->size);
            p.pts = pkt->pts;
            p.dts = pkt->dts;
            p.flags = pkt->flags;
            p.timeBase = fc->streams[stream]->time_base;
            out.push_back(std::move(p));
        }
        av_packet_unref(pkt);
    }
    if (pkt) av_packet_free(&pkt);
    avformat_close_input(&fc);
    return out;
}

/// The first stream of a kind, as `-map 0:v:0` would find it.
int streamIndexOf(const std::string& path, AVMediaType kind) {
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0) return -1;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return -1; }
    const int idx = av_find_best_stream(fc, kind, -1, -1, nullptr, 0);
    avformat_close_input(&fc);
    return idx;
}

/// Every stream of a kind, in the order the muxer numbered them — which is the
/// order the stream list was written in, and the whole of what "the list is the
/// numbering" means.
std::vector<int> streamsOfKind(const AVFormatContext* fc, AVMediaType kind) {
    std::vector<int> out;
    for (unsigned i = 0; i < fc->nb_streams; ++i)
        if (fc->streams[i]->codecpar->codec_type == kind) out.push_back(static_cast<int>(i));
    return out;
}

/// One frame of one *named* stream, as RGBA.
///
/// `VideoPipeline` answers for a file — the best video stream in it — and a
/// render that writes three pictures has to be asked about each of them, so
/// this opens a stream by index and decodes to the frame covering `at`. The
/// buffer carries the slack every buffer libswscale writes into needs: a row
/// writer emits a whole SIMD block per store and the last one goes past the
/// width however carefully the width was worked out.
struct Picture {
    std::vector<uint8_t> rgba;
    int width = 0, height = 0;
    bool ok() const { return width > 0 && height > 0; }
};

Picture frameOf(const std::string& path, int stream, double at) {
    Picture out;
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0) return out;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return out; }
    if (stream < 0 || stream >= static_cast<int>(fc->nb_streams)) {
        avformat_close_input(&fc);
        return out;
    }

    AVStream* st = fc->streams[stream];
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    AVCodecContext* ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!ctx || avcodec_parameters_to_context(ctx, st->codecpar) < 0 ||
        avcodec_open2(ctx, dec, nullptr) < 0) {
        if (ctx) avcodec_free_context(&ctx);
        avformat_close_input(&fc);
        return out;
    }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    AVFrame* kept = av_frame_alloc();
    double bestT = -1;
    bool have = false;
    const auto consider = [&] {
        const double t = frame->pts == AV_NOPTS_VALUE ? 0.0
                                                      : frame->pts * av_q2d(st->time_base);
        // The last frame at or before the moment asked for, and failing that
        // the first there is — a stream whose every frame is later than `at`
        // still has a picture and answering with none would read as a stream
        // that produced nothing.
        if (!have || (t <= at + 1e-9 && t > bestT)) {
            av_frame_unref(kept);
            av_frame_ref(kept, frame);
            bestT = t;
            have = true;
        }
        av_frame_unref(frame);
    };
    while (pkt && frame && kept && av_read_frame(fc, pkt) >= 0) {
        if (pkt->stream_index == stream && avcodec_send_packet(ctx, pkt) >= 0)
            while (avcodec_receive_frame(ctx, frame) >= 0) consider();
        av_packet_unref(pkt);
    }
    if (frame && kept && avcodec_send_packet(ctx, nullptr) >= 0)
        while (avcodec_receive_frame(ctx, frame) >= 0) consider();

    if (have) {
        out.width = kept->width;
        out.height = kept->height;
        out.rgba.assign(static_cast<size_t>(out.width) * out.height * 4 + 256, 0);
        SwsContext* sws = sws_getContext(kept->width, kept->height,
                                         static_cast<AVPixelFormat>(kept->format), out.width,
                                         out.height, AV_PIX_FMT_RGBA, SWS_BICUBIC, nullptr,
                                         nullptr, nullptr);
        if (sws) {
            uint8_t* dst[4] = {out.rgba.data(), nullptr, nullptr, nullptr};
            int stride[4] = {out.width * 4, 0, 0, 0};
            sws_scale(sws, kept->data, kept->linesize, 0, kept->height, dst, stride);
            sws_freeContext(sws);
        } else {
            out.width = out.height = 0;
        }
    }
    if (pkt) av_packet_free(&pkt);
    if (frame) av_frame_free(&frame);
    if (kept) av_frame_free(&kept);
    avcodec_free_context(&ctx);
    avformat_close_input(&fc);
    return out;
}

/// How alike a picture and a rectangle of another picture are, in dB.
///
/// What a graph that cuts one picture into pieces needs: the left-hand stream
/// is a claim about the left half of the composite, and only comparing the two
/// says whether the pads came out in the order they were mapped. `psnr()` above
/// wants two buffers of one size.
double psnrOfRegion(const Picture& part, const Picture& whole, int x0, int y0) {
    if (!part.ok() || !whole.ok()) return -1.0;
    if (x0 + part.width > whole.width || y0 + part.height > whole.height) return -1.0;
    double se = 0;
    size_t n = 0;
    for (int y = 0; y < part.height; ++y)
        for (int x = 0; x < part.width; ++x) {
            const size_t a = (static_cast<size_t>(y) * part.width + x) * 4;
            const size_t b = (static_cast<size_t>(y + y0) * whole.width + (x + x0)) * 4;
            for (int c = 0; c < 3; ++c, ++n) {
                const double d = static_cast<double>(part.rgba[a + c]) - whole.rgba[b + c];
                se += d * d;
            }
        }
    if (!n) return -1.0;
    const double mse = se / static_cast<double>(n);
    return mse <= 0 ? 99.0 : 10.0 * std::log10(255.0 * 255.0 / mse);
}

/// How loud one *named* audio stream is, over the whole of it.
///
/// `analyzeAudioPeaks` answers for a file, and a file with two soundtracks in
/// it is exactly the case where that is the wrong question: two streams that
/// are meant to differ by a `volume=0.5` are indistinguishable unless each is
/// measured on its own.
double rmsOfStream(const std::string& path, int stream) {
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0) return -1.0;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return -1.0; }
    if (stream < 0 || stream >= static_cast<int>(fc->nb_streams)) {
        avformat_close_input(&fc);
        return -1.0;
    }
    AVStream* st = fc->streams[stream];
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    AVCodecContext* ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!ctx || avcodec_parameters_to_context(ctx, st->codecpar) < 0 ||
        avcodec_open2(ctx, dec, nullptr) < 0) {
        if (ctx) avcodec_free_context(&ctx);
        avformat_close_input(&fc);
        return -1.0;
    }

    SwrContext* swr = nullptr;
    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    std::vector<float> buf;
    double sum = 0;
    size_t n = 0;
    const auto take = [&] {
        const int channels = std::max(1, frame->ch_layout.nb_channels);
        if (!swr) {
            if (swr_alloc_set_opts2(&swr, &frame->ch_layout, AV_SAMPLE_FMT_FLT,
                                    frame->sample_rate, &frame->ch_layout,
                                    static_cast<AVSampleFormat>(frame->format),
                                    frame->sample_rate, 0, nullptr) < 0 ||
                !swr || swr_init(swr) < 0)
                return;
        }
        // Slack past what the resample can produce, for the reason every other
        // buffer handed to libswresample in this repo has it.
        buf.assign(static_cast<size_t>(frame->nb_samples + 256) * channels + 256, 0.0f);
        auto* dst = reinterpret_cast<uint8_t*>(buf.data());
        const int got = swr_convert(swr, &dst, frame->nb_samples + 256,
                                    const_cast<const uint8_t**>(frame->extended_data),
                                    frame->nb_samples);
        for (int i = 0; i < got * channels; ++i, ++n) sum += double(buf[i]) * buf[i];
    };
    while (pkt && frame && av_read_frame(fc, pkt) >= 0) {
        if (pkt->stream_index == stream && avcodec_send_packet(ctx, pkt) >= 0)
            while (avcodec_receive_frame(ctx, frame) >= 0) { take(); av_frame_unref(frame); }
        av_packet_unref(pkt);
    }
    if (swr) swr_free(&swr);
    if (pkt) av_packet_free(&pkt);
    if (frame) av_frame_free(&frame);
    avcodec_free_context(&ctx);
    avformat_close_input(&fc);
    return n ? std::sqrt(sum / double(n)) : -1.0;
}

/// One subtitle cue, read back out of a file.
///
/// **The only check worth making about a subtitle track is what it says and
/// when.** A stream that exists, a codec that is the right one and a byte count
/// that is not zero all pass for a track full of the wrong words at the wrong
/// moments, which is exactly the failure a conversion has. So the file is
/// decoded and the cues come back as times and text.
struct Cue {
    double from = 0, to = 0;
    std::string text;
};

std::vector<Cue> cuesOf(const std::string& path) {
    std::vector<Cue> out;
    AVFormatContext* fc = nullptr;
    if (avformat_open_input(&fc, path.c_str(), nullptr, nullptr) < 0) return out;
    if (avformat_find_stream_info(fc, nullptr) < 0) { avformat_close_input(&fc); return out; }
    const int idx = av_find_best_stream(fc, AVMEDIA_TYPE_SUBTITLE, -1, -1, nullptr, 0);
    if (idx < 0) { avformat_close_input(&fc); return out; }

    AVStream* st = fc->streams[idx];
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    AVCodecContext* ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (ctx) {
        avcodec_parameters_to_context(ctx, st->codecpar);
        ctx->pkt_timebase = st->time_base;
        if (avcodec_open2(ctx, dec, nullptr) < 0) avcodec_free_context(&ctx);
    }
    AVPacket* pkt = av_packet_alloc();
    while (ctx && pkt && av_read_frame(fc, pkt) >= 0) {
        if (pkt->stream_index == idx) {
            AVSubtitle sub{};
            int got = 0;
            if (avcodec_decode_subtitle2(ctx, &sub, &got, pkt) >= 0 && got) {
                const double base =
                    sub.pts != AV_NOPTS_VALUE ? sub.pts / double(AV_TIME_BASE) : 0.0;
                Cue c;
                c.from = base + sub.start_display_time / 1000.0;
                c.to = base + sub.end_display_time / 1000.0;
                for (unsigned r = 0; r < sub.num_rects; ++r) {
                    if (sub.rects[r]->ass) c.text += sub.rects[r]->ass;
                    else if (sub.rects[r]->text) c.text += sub.rects[r]->text;
                }
                out.push_back(std::move(c));
                avsubtitle_free(&sub);
            }
        }
        av_packet_unref(pkt);
    }
    if (pkt) av_packet_free(&pkt);
    if (ctx) avcodec_free_context(&ctx);
    avformat_close_input(&fc);
    return out;
}

std::string fileText(const std::string& path) {
    std::ifstream in(std::filesystem::path(path), std::ios::binary);
    if (!in) return "";
    return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

bool mentions(const std::string& haystack, const char* needle) {
    return haystack.find(needle) != std::string::npos;
}

/// A path as a filter argument wants to hear it.
///
/// **A colon separates a filter's arguments**, so a Windows path with a drive
/// letter in it goes into `subtitles=` unusable unless the colon is escaped —
/// which is a trap rather than a detail: the render fails with libavfilter
/// complaining about an option called `/fixtures/cues`, and nothing in that
/// message mentions the drive letter. Quoted as well, because a path is also
/// free to contain a comma, and a comma is what separates two filters.
std::string filterPath(const std::filesystem::path& p) {
    std::string out;
    for (char c : p.generic_string()) {
        if (c == ':' || c == '\'' || c == '\\') out += '\\';
        out += c;
    }
    return "'" + out + "'";
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
    // One of the file's few content-dependent checks (see the header): a source
    // that is entirely black at this instant would fail it, and the number
    // printed says so.
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

    // ── the sound, resampled ───────────────────────────────────────────────
    //
    // Every other render here asks for the rate the source already has, so
    // libswresample has nothing to do and the buffers it writes into are never
    // asked for an awkward number of samples. 48000 → 44100 is 147/160, so no
    // frame's output count is a whole number of SIMD blocks and every one of
    // them makes the resampler's last store go past the count it was given.
    //
    // That overrun is what `kSwrSlack` is padding for, and it is worth being
    // plain about what this check does and does not do: it exercises the two
    // buffers that used to be sized exactly (`SourceAudio`'s fifo and the
    // writer's `aconv`), but a few bytes written past a `std::vector` usually
    // land in capacity the allocator left behind, so a render that is missing
    // the slack still finishes. The assertion here is about the resampling
    // being right; the guard against the overrun is the constant.
    if (srcHasAudio) {
        std::printf("\nthe sound at a rate the source is not\n");
        const std::string outR = "out/export-resampled.mp4";
        ExportSettings sr = baseSettings(outR);
        sr.audioSampleRate = 44100;
        const ExportStatus rst = render(sr, {leftHalf(first, srcDuration)});
        checkf(rst.state == ExportStatus::State::Done, "a render at 44.1 kHz finishes (%s)",
               rst.error.empty() ? "no error" : rst.error.c_str());
        if (rst.state == ExportStatus::State::Done) {
            const ProbeResult ri = probeMedia(outR);
            check(ri.ok, "and the file opens");
            const StreamSummary* ra = nullptr;
            for (const auto& s : ri.streams) if (s.kind == "audio" && !ra) ra = &s;
            check(ra != nullptr, "with a soundtrack in it");
            if (ra) checkf(ra->sampleRate == 44100, "at 44.1 kHz (%d)", ra->sampleRate);
            AudioPeaks rp;
            check(analyzeAudioPeaks(outR, 64, rp), "the resampled audio decodes");
            double loudest = 0;
            for (float v : rp.rms) loudest = std::max(loudest, double(v));
            if (srcAudible)
                checkf(loudest > 0.0005,
                       "and came through the rate change (peak rms %.4f)", loudest);
        }
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

            // **A refusal has to give back what it had already opened.** This
            // one is refused in `describeStream`, which runs *after* the
            // encoder is open — so by the time the tag is looked at there is a
            // live libx264 context, a scaler, a frame and possibly a chain of
            // bitstream filters, and the stream they belong to had not yet been
            // put in the list `close()` walks. Every retry leaked another one,
            // and this is two clicks away: the fourcc is a field on the Write
            // stage and a person who typed five characters will fix them and
            // press Render again.
            //
            // The ceiling comes from measuring both sides rather than from
            // taste. Thirty-two refusals over this fixture on the machine this
            // was written on: **87.6 MB with the leak and 1.8 MB without it**,
            // and the baseline is taken after one has already run so the
            // allocator is warm. 12 MB sits an order of magnitude clear of
            // both. What a leaked encoder costs is a fact about the machine —
            // x264 sizes its frame pool by the core count — so the numbers are
            // printed, and a machine whose encoder is a quarter the size of
            // this one still lands well the wrong side of the line.
            {
                const size_t settled = residentBytes();
                bool same = true;
                for (int i = 0; i < 32 && same; ++i)
                    same = render(bad3, clipsA).state == ExportStatus::State::Failed;
                check(same, "the refusal is the same every time");
                const size_t after = residentBytes();
                const double grewMb = double(after > settled ? after - settled : 0) / 1048576.0;
                if (!settled)
                    std::printf("  SKIP  whether they leak — this platform will not "
                                "say how much memory the process is holding\n");
                else
                    checkf(grewMb < 12.0,
                           "and thirty-two more of them do not grow the process "
                           "(%.1f MB on top of %.1f MB)", grewMb, settled / 1048576.0);
            }

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
            // **43 dB, which is the number the documents quote and the number
            // this measures.** Over these three instants the fixture scores
            // 43.8, 43.7 and 43.6 dB, repeatably — what is left at that level
            // is two independent x264 passes over near-identical pictures and
            // not any disagreement about the edit. The threshold used to be 34,
            // which had absorbed nine decibels of slack nobody could account
            // for: the whole value of a second render path is that it is the
            // same render, and a check with that much room in it would sit
            // green through a real regression. What a real one looks like is
            // well under twenty — a frame out of step, a crop taken from the
            // wrong edge, a source decoded through the wrong matrix — so the
            // gap under this is still enormous. Raise it if it measures higher;
            // do not lower it to make something pass.
            checkf(worst > 43.0,
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
                    const double db = psnr(a.currentRgba(), b.currentRgba(), kW, kH);
                    std::printf("        %.1fs: %.1f dB\n", at, db);
                    worst = std::min(worst, db);
                }
                // **Identical, not merely close**, which is what the documents
                // say and what this measures: 99.0 is `psnr()`'s answer for a
                // squared error of zero, and all three instants give it. These
                // two renders composited the very same frames and encoded them
                // with the same encoder at the same settings, so there is
                // nothing left for them to differ by — the threshold was 40,
                // which is what you would write if you expected two x264 passes
                // and would therefore have accepted a seek that changed the
                // picture by a little.
                checkf(worst >= 99.0,
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

        // ── a clip that plays at twice its own rate ────────────────────────
        //
        // **This is the check the whole speed decision rests on.** A clip's speed
        // is performed two ways and they must not diverge: the track stack asks
        // `swr` for the file's rate multiplied by the speed and steps `srcTime`
        // forward twice as fast, and the graph divides the `setpts` and writes
        // `asetrate,aresample`. If those are two different renders then
        // `ui/graph/derive.js` describes something this application would not
        // perform, which is the one claim that file exists to make.
        //
        // The source window is *the same window* as every render above — the
        // clip covers `inPoint`…`inPoint+kSpan` of the file either way — and only
        // the output is half as long, because that is what "the source span is
        // preserved" means. So the picture at output second `t` here is the picture
        // at `2t` there, which is a third thing this catches for free.
        {
            const double kSpeed = 2.0;
            ExportClip fast = c;
            fast.speed = kSpeed;
            fast.length = c.length / kSpeed;

            ExportSettings sf = baseSettings("out/export-speed-stack.mp4");
            sf.endTime = fast.length;
            const ExportStatus fst = render(sf, {fast});
            checkf(fst.state == ExportStatus::State::Done,
                   "the track stack renders a clip at %g× (%s)", kSpeed,
                   fst.error.empty() ? "no error" : fst.error.c_str());

            // What the file's sound is at, because `asetrate` takes a number and
            // not an expression over the input's rate — which is exactly why
            // `specInputInfo()` carries it to the derivation. Asked of the probe
            // here for the same reason.
            int rate = 0;
            for (const auto& s : src.streams) if (s.kind == "audio") { rate = s.sampleRate; break; }

            char fastText[1400];
            std::snprintf(fastText, sizeof(fastText),
                "color=c=black:s=%dx%d:r=%g:d=%g[base];"
                "[0:v]trim=start=%g:end=%g,setpts=(PTS-STARTPTS)/%g+0/TB,"
                "scale=%d:%d:in_color_matrix=%s:in_range=%s:out_range=full,format=rgba[v0];"
                "[base][v0]overlay=0:0:eof_action=pass[vout]"
                "%s",
                kW, kH, kFps, fast.length,
                fast.inPoint, fast.inPoint + fast.length * kSpeed, kSpeed,
                static_cast<int>(c.w), static_cast<int>(c.h), matrix.c_str(), range.c_str(),
                "");
            std::string fastGraph = fastText;
            const bool sound = srcHasAudio && rate > 0;
            if (sound) {
                char audio[400];
                std::snprintf(audio, sizeof(audio),
                    ";[0:a]atrim=start=%g:end=%g,asetrate=%d,aresample=%d,"
                    "asetpts=PTS-STARTPTS[a0]",
                    fast.inPoint, fast.inPoint + fast.length * kSpeed,
                    int(rate * kSpeed + 0.5), rate);
                fastGraph += audio;
            }

            ExportSettings gf = baseSettings("out/export-speed-graph.mp4");
            gf.endTime = fast.length;
            gf.filterGraph = fastGraph;
            gf.filterInputs = {{"0:v", first, "v"}};
            if (sound) gf.filterInputs.push_back({"0:a", first, "a"});
            gf.includeAudio = sound;
            const ExportStatus gst = render(gf, {fast});
            checkf(gst.state == ExportStatus::State::Done,
                   "and libavfilter renders the chain the app prints for it (%s)",
                   gst.error.empty() ? "no error" : gst.error.c_str());

            if (fst.state == ExportStatus::State::Done &&
                gst.state == ExportStatus::State::Done) {
                // One source frame, which is the unit the two paths differ by —
                // see below. Falls back to an output frame for a file whose rate
                // the container does not state.
                const double srcFrame = 1.0 / ((sv && sv->fps > 0.1) ? sv->fps : kFps);
                VideoPipeline a, b, plain;
                if (a.open("out/export-speed-stack.mp4") &&
                    b.open("out/export-speed-graph.mp4") && plain.open(outG)) {
                    double exact = 99.0;
                    double nearest = 99.0;
                    double wrongRate = 99.0;
                    // On output frame boundaries at *both* rates, so that neither
                    // side is being asked for a moment between two pictures: at
                    // 25 fps these are frames 4, 10 and 16 of the 2× render and 8,
                    // 20 and 32 of the 1× render. Sampling at 0.15 asked the two
                    // for different source frames and measured nothing but that.
                    for (double at : {0.16, 0.40, 0.64}) {
                        a.advanceTo(static_cast<TimeNs>(at * 1e9));
                        b.advanceTo(static_cast<TimeNs>(at * 1e9));
                        plain.advanceTo(static_cast<TimeNs>(at * kSpeed * 1e9));
                        if (!a.hasFrame() || !b.hasFrame() || !plain.hasFrame()) {
                            exact = nearest = wrongRate = -1.0;
                            break;
                        }
                        // The compositor against the same edit at 1×, and the graph
                        // against the closest source frame either side of it.
                        const double stack = psnr(a.currentRgba(), plain.currentRgba(), kW, kH);
                        double best = psnr(b.currentRgba(), plain.currentRgba(), kW, kH);
                        for (double o : {-srcFrame, srcFrame}) {
                            VideoPipeline p;
                            if (!p.open(outG)) break;
                            p.advanceTo(static_cast<TimeNs>((at * kSpeed + o) * 1e9));
                            if (p.hasFrame())
                                best = std::max(best,
                                                psnr(b.currentRgba(), p.currentRgba(), kW, kH));
                        }
                        // And the graph against the picture it would show if the
                        // speed had never reached it, which is the failure this
                        // whole section is here to catch.
                        VideoPipeline unsped;
                        double dropped = -1.0;
                        if (unsped.open(outG)) {
                            unsped.advanceTo(static_cast<TimeNs>(at * 1e9));
                            if (unsped.hasFrame())
                                dropped = psnr(b.currentRgba(), unsped.currentRgba(), kW, kH);
                        }
                        std::printf("        %.2fs: stack vs 1×@%.2f %.1f dB, graph within a "
                                    "source frame %.1f dB, graph vs 1×@%.2f %.1f dB\n",
                                    at, at * kSpeed, stack, best, at, dropped);
                        exact = std::min(exact, stack);
                        nearest = std::min(nearest, best);
                        wrongRate = std::min(wrongRate, dropped < 0 ? 99.0 : dropped);
                    }
                    // **The compositor's speed is exact**, and this is what "the
                    // source span is preserved" means as a picture rather than as
                    // arithmetic: second t of the 2× render is second 2t of the
                    // same edit at its own rate, out of the same window of the same
                    // file. 43 dB is the same floor the unsped comparison uses —
                    // two independent x264 passes over identical pictures.
                    checkf(exact > 43.0,
                           "second t of a %g× render is second %g×t of the same edit at 1× "
                           "(%.1f dB)", kSpeed, kSpeed, exact);
                    // **And libavfilter's is the same picture to within the frame
                    // its frame-sync chose**, which is a real and measured
                    // difference rather than slack: at 2× the divided `setpts` puts
                    // the clip's frames on *half* the base's frame interval, and
                    // `overlay` rescales them into the base's time base before
                    // comparing — so where the compositor takes source frame 2m for
                    // output frame m, framesync can take 2m-1. Measured over this
                    // fixture: 27 dB against the compositor's own frame and 50 dB
                    // against the one either side of it, so it is exactly one frame
                    // and never more.
                    //
                    // This is the same disagreement `graph/derive.js` already
                    // raises a caveat for when a source's rate differs from the
                    // output's — "a fixed-rate walk and a frame-sync do not choose
                    // the same frames" — and a speed is precisely a source arriving
                    // at another rate, which is why that caveat's condition divides
                    // by the speed.
                    checkf(nearest > 43.0,
                           "and libavfilter's is the same picture to within the frame its "
                           "frame-sync chose (%.1f dB)", nearest);
                    // Which is nothing like a speed that failed to reach the graph:
                    // that is the picture from half as far into the file, tens of
                    // frames away, and it measures 17 dB on this fixture.
                    checkf(wrongRate < nearest - 10.0,
                           "and nowhere near the picture it would show if the speed had not "
                           "reached the chain at all (%.1f dB against %.1f)",
                           wrongRate, nearest);
                } else {
                    check(false, "all three renders open for comparison");
                }
            }

            // The sound is half as long and no quieter. A resample that had been
            // written as a *rate* change on the way out — `aresample` without the
            // `asetrate` — would come out the right length and silent past the
            // half way point, which is invisible in the picture checks.
            if (sound && srcAudible && gst.state == ExportStatus::State::Done) {
                AudioPeaks pa, pg;
                if (analyzeAudioPeaks("out/export-speed-stack.mp4", 32, pa) &&
                    analyzeAudioPeaks("out/export-speed-graph.mp4", 32, pg) &&
                    pa.rms.size() == pg.rms.size() && !pa.rms.empty()) {
                    double worstDiff = 0, loudest = 0;
                    for (size_t i = 0; i < pa.rms.size(); ++i) {
                        worstDiff = std::max(worstDiff, std::fabs(double(pa.rms[i]) - pg.rms[i]));
                        loudest = std::max(loudest, double(pa.rms[i]));
                    }
                    // Looser than the 15% the unsped comparison allows: one path
                    // resamples through `swr` directly and the other through
                    // `asetrate` into `aresample`, which is two resamplers where
                    // the first has one, and the block boundaries a 32-bucket
                    // envelope is measured on do not fall in the same places. What
                    // this is asserting is that both paths made *sound of the same
                    // shape*; a path that had dropped the resample entirely comes
                    // out an octave and a length apart, which is nowhere near this.
                    checkf(loudest > 0.0005 && worstDiff < loudest * 0.35,
                           "and both paths make the same sped-up sound "
                           "(worst rms difference %.4f of %.4f)", worstDiff, loudest);
                } else {
                    check(false, "both sped-up renders' audio decodes for comparison");
                }
            }
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

    // **And the other half of that switch, which is the export's half.** With
    // `sizeFromGraph` off, a last pad that is a different size from the render
    // is an *error*: the writer has already been opened for one size, and
    // saying so plainly beats a scaler quietly resizing every frame of a render
    // somebody is about to keep. Nothing asserted it, and the failure it guards
    // against is invisible — a file that opens, plays, and is the wrong shape.
    {
        ExportSettings mismatch = baseSettings("out/export-graph-mismatch.mp4");
        mismatch.endTime = 0.4;
        mismatch.includeAudio = false;
        mismatch.filterInputs = {};
        mismatch.filterGraph = "color=c=red:s=64x64:r=25,format=rgba[vout]";
        const ExportStatus mm = render(mismatch, {});
        checkf(mm.state == ExportStatus::State::Failed &&
                   mm.error.find("64x64") != std::string::npos,
               "a graph that is not the size of the render is refused, with both sizes (%s)",
               mm.error.empty() ? "it rendered, which it must not" : mm.error.c_str());
    }

    // **A last pad smaller than the canvas the writer was opened for.**
    // `sizeFromGraph` takes the sink's size and then puts a sixteen-pixel floor
    // under it, because yuv420p has no half pixels and no encoder here will
    // take an 8x8 picture. So the canvas can legitimately be *bigger* than the
    // frame arriving from the graph, and the RGBA fast path — a row-by-row
    // memcpy sized from the canvas — read past the end of that frame. Reachable
    // from a node preview of anything tiny, which is the one place in this
    // application that turns `sizeFromGraph` on.
    //
    // A flat colour is what makes it assertable: upscaled, every pixel of the
    // 16x16 output is that colour, and a copy that ran off the end of an 8x8
    // frame fills the bottom two thirds of the canvas with whatever followed it
    // in the heap.
    {
        std::printf("\na graph smaller than the smallest picture\n");
        const std::string outTiny = "out/export-graph-tiny.mp4";
        ExportSettings ts = baseSettings(outTiny);
        ts.endTime = 0.4;
        ts.sizeFromGraph = true;
        ts.includeAudio = false;
        ts.filterInputs = {};
        ts.filterGraph = "color=c=green:s=8x8:r=25,format=rgba[vout]";
        st = render(ts, {});
        checkf(st.state == ExportStatus::State::Done,
               "a graph whose last pad is 8x8 renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        if (st.state == ExportStatus::State::Done) {
            const ProbeResult ot = probeMedia(outTiny);
            const StreamSummary* tv = nullptr;
            for (const auto& s2 : ot.streams) if (s2.kind == "video") { tv = &s2; break; }
            checkf(tv && tv->width == 16 && tv->height == 16,
                   "at the sixteen-pixel floor (%dx%d)", tv ? tv->width : 0,
                   tv ? tv->height : 0);
            VideoPipeline v;
            if (v.open(outTiny)) {
                v.advanceTo(static_cast<TimeNs>(0.2 * 1e9));
                if (v.hasFrame()) {
                    const auto& rgba = v.currentRgba();
                    // Green all the way down, not green over rubbish. The rows
                    // past the eighth are the ones the copy invented.
                    int wrong = 0, seen = 0;
                    for (int y = 0; y < 16; ++y)
                        for (int x = 0; x < 16; ++x) {
                            const size_t i = (size_t(y) * 16 + x) * 4;
                            if (i + 2 >= rgba.size()) continue;
                            ++seen;
                            if (rgba[i + 1] < 90 || rgba[i] > 90 || rgba[i + 2] > 90) ++wrong;
                        }
                    checkf(seen > 0 && wrong == 0,
                           "and every pixel of it is the colour the graph made "
                           "(%d of %d are not)", wrong, seen);
                } else {
                    check(false, "the tiny render has a frame in it");
                }
            } else {
                check(false, "the tiny render opens");
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

    // ── a device where a clip goes, and a device where an input goes ───────
    //
    // These two sit together because the difference between them is the whole
    // of what "a live device on the timeline" turned out to mean.
    //
    // A **clip** is refused. `TimelineSource` asks a source for the picture at
    // `inPoint + (t − start) × speed`, and `SourceVideo::rgbaAt` answers by
    // seeking and walking — a libavdevice demuxer has no `read_seek`, so the
    // seek is `Invalid argument`, and the moment a trim names has either not
    // happened or has gone. Measured before it was refused, on `-f lavfi -i
    // testsrc=…,realtime`, which is a device that produces at the wall clock:
    // two seconds of output cost 2038 ms untrimmed, **3040 ms trimmed one
    // second in and 5061 ms trimmed three seconds in** — a trim is a wait of
    // exactly its own length with nothing written during it, and the file that
    // comes out is two seconds long either way and says nothing about it.
    //
    // A device **feeding the graph** is not that and is not refused. A
    // `filterInputs` pad is pulled forward and never asked for an instant, so a
    // graph render off a device is an ordinary render that happens to be paced
    // by its source: measured at 2024 ms for two seconds off the `realtime`
    // device against 65 ms off the same device without it. There is no wall
    // clock to add here — `av_read_frame` is the clock.
    //
    // `lavfi` is a device on every machine, which is what makes both halves
    // testable with no camera.
    {
        std::printf("\na device where a clip goes\n");

        // At the render's own size, so that the graph half below is about the
        // device and not about a scaler nobody asked for.
        char devText[128];
        std::snprintf(devText, sizeof(devText), "testsrc=size=%dx%d:rate=%g", kW, kH, kFps);
        const std::string devArgs = devText;
        MediaInput dev;
        dev.format = "lavfi";
        dev.path = devArgs;
        dev.duration = 1.0;   // `-t`, which is what gives an endless input a length

        ExportSettings asClip = baseSettings("out/export-device-clip.mp4");
        asClip.endTime = 0.4;
        asClip.inputs = {dev};
        ExportClip c;
        c.input = 0;
        c.start = 0;
        c.length = 1.0;
        c.w = kW;
        c.h = kH;
        st = render(asClip, {c});
        checkf(st.state == ExportStatus::State::Failed,
               "a clip of a live device is refused (%s)", st.error.c_str());
        checkf(st.error.find("live device") != std::string::npos &&
                   st.error.find(devArgs) != std::string::npos,
               "naming the device rather than failing at the first seek (%s)",
               st.error.c_str());
        checkf(st.error.find("wait") != std::string::npos,
               "and saying what a trim on one would cost (%s)", st.error.c_str());

        // **A `-t` is not the missing half.** The refusal above has one on it;
        // this is the same clip with none, to say that the answer does not
        // change — the length question and the seek question are different
        // questions and only one of them a number can settle.
        MediaInput noEnd = dev;
        noEnd.duration = 0.0;
        ExportSettings without = asClip;
        without.inputs = {noEnd};
        st = render(without, {c});
        checkf(st.state == ExportStatus::State::Failed,
               "and so is one with no -t, which is the same refusal and not a length (%s)",
               st.error.c_str());

        // The other half: the same device, feeding the graph. Nothing is
        // refused, because nothing asks it for an instant.
        ExportSettings asFeed = baseSettings("out/export-device-graph.mp4");
        asFeed.endTime = 0.4;
        asFeed.inputs = {dev};
        asFeed.filterGraph = "[0:v]null[vout]";
        asFeed.filterInputs = {{"0:v", devArgs, "v", 0.0, 0}};
        asFeed.includeAudio = false;
        st = render(asFeed, {});
        checkf(st.state == ExportStatus::State::Done,
               "the same device feeding the graph renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
    }

    // ── the graph's own frame times, kept ──────────────────────────────────
    //
    // `-fps_mode vfr`. Both render paths used to stamp every frame with its
    // number, which is `cfr` and is the only thing a composited render can
    // honestly claim — but a filter graph's frames arrive carrying timestamps of
    // their own, and numbering them is what made a graph at another rate come
    // out fast or slow.
    //
    // **The graph here is genuinely uneven and that is the whole design of the
    // check.** A source at 50 fps with `select` keeping two frames out of every
    // four leaves timestamps at 0, 1, 4, 5, 8, 9… fiftieths of a second: spacing
    // no frame number can express, so a walk that had gone on numbering them
    // would show up as evenly spaced packets whatever else it got right.
    // Anything constant — `fps=`, `framestep` — would pass this under either
    // mode and prove nothing.
    {
        std::printf("\nthe graph's own frame times\n");

        // The sound is here because the *sound* is the half that had to change
        // shape: the sample count is accumulated from the start of the render so
        // that no sample is lost or repeated at a frame boundary, and on this
        // walk a frame does not know where it ends — so each covers up to its own
        // moment and a tail block covers the last frame's own duration. The check
        // below is that the two walks write the same length of sound.
        char text[512];
        std::snprintf(text, sizeof(text),
                      "color=c=red:s=%dx%d:r=50,select='lt(mod(n,4),2)',format=rgba[vout];"
                      "sine=frequency=440:sample_rate=48000[aout]",
                      kW, kH);

        /// The last packet of a stream, in seconds — which for the sound is how
        /// far the soundtrack reaches.
        const auto endOf = [](const std::string& path, AVMediaType kind) {
            const int idx = streamIndexOf(path, kind);
            double last = -1.0;
            if (idx < 0) return last;
            for (const auto& p : packetsOf(path, idx))
                if (p.pts != AV_NOPTS_VALUE)
                    last = std::max(last, p.pts * av_q2d(p.timeBase));
            return last;
        };

        const std::string outV = "out/export-vfr.mp4";
        ExportSettings sv = baseSettings(outV);
        sv.endTime = 0.4;
        sv.filterInputs = {};
        sv.filterGraph = text;
        sv.fpsMode = "vfr";
        st = render(sv, {});
        checkf(st.state == ExportStatus::State::Done,
               "a graph whose frames are unevenly spaced renders with -fps_mode vfr (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            const int vs = streamIndexOf(outV, AVMEDIA_TYPE_VIDEO);
            const std::vector<Pkt> pk = vs >= 0 ? packetsOf(outV, vs) : std::vector<Pkt>();
            // In seconds, out of the container's own time base — the point being
            // that the base has to be fine enough to hold 1/50ths, which a
            // `1/fps` one is not.
            std::vector<double> times;
            for (const auto& p : pk)
                if (p.pts != AV_NOPTS_VALUE) times.push_back(p.pts * av_q2d(p.timeBase));
            std::sort(times.begin(), times.end());
            checkf(times.size() >= 6, "and writes the frames the graph made (%d)",
                   static_cast<int>(times.size()));
            if (times.size() >= 6) {
                // 0, .02, .08, .10 … so the first gap is a fiftieth and the
                // second is three of them. Equal gaps here would be the frame
                // numbers coming back.
                const double g1 = times[1] - times[0];
                const double g2 = times[2] - times[1];
                checkf(std::abs(g1 - 0.02) < 0.005 && std::abs(g2 - 0.06) < 0.01,
                       "spaced as the graph spaced them rather than on a grid "
                       "(%.4f s then %.4f s)", g1, g2);
                checkf(times.back() < 0.4 + 1e-6,
                       "and the range still ends the file (%.4f s)", times.back());
            }
        }

        // The same graph on the fixed-rate walk, for the contrast: every gap the
        // same, because a frame number is the whole timestamp there. This is the
        // behaviour every render in this file relies on, so it is worth one
        // assertion that it did not change.
        const std::string outC = "out/export-cfr.mp4";
        ExportSettings sc = sv;
        sc.path = outC;
        sc.fpsMode = "cfr";
        st = render(sc, {});
        if (st.state == ExportStatus::State::Done) {
            const int cs = streamIndexOf(outC, AVMEDIA_TYPE_VIDEO);
            const std::vector<Pkt> pk = cs >= 0 ? packetsOf(outC, cs) : std::vector<Pkt>();
            std::vector<double> times;
            for (const auto& p : pk)
                if (p.pts != AV_NOPTS_VALUE) times.push_back(p.pts * av_q2d(p.timeBase));
            std::sort(times.begin(), times.end());
            bool even = times.size() >= 3;
            for (size_t i = 2; i < times.size(); ++i)
                if (std::abs((times[i] - times[i - 1]) - (times[1] - times[0])) > 0.002)
                    even = false;
            checkf(even, "and cfr puts the same pictures on an even grid (%d frames)",
                   static_cast<int>(times.size()));

            // **The soundtrack is the same length either way**, which is the one
            // thing the paced walk could have got wrong and would not have shown
            // in the picture: the fixed-rate walk covers up to the *next* frame
            // and so reaches the end of the range on its own, while the paced one
            // covers up to each frame's own moment and owes the last frame's
            // duration. Compared against the other walk rather than against a
            // number, because 0.4 s of AAC is nineteen packets and a bit and the
            // "and a bit" is the encoder's business. One packet of tolerance,
            // which is 1024 samples at 48 kHz.
            const double av = endOf(outV, AVMEDIA_TYPE_AUDIO);
            const double ac = endOf(outC, AVMEDIA_TYPE_AUDIO);
            const double vv = endOf(outV, AVMEDIA_TYPE_VIDEO);
            checkf(av > 0 && ac > 0 && std::abs(av - ac) <= 1024.0 / 48000.0 + 1e-6,
                   "and the sound of the two is the same length (%.4f s against %.4f s)",
                   av, ac);
            // And it goes past the last picture, which is where it would have
            // stopped if the tail block were missing — the last frame is at
            // 0.34 s and the range ends at 0.40.
            checkf(av > vv, "reaching the end of the range rather than the last picture "
                            "(%.4f s of sound against %.4f s of picture)", av, vv);
        }

        // ── and the three renders that cannot keep anybody's frame times ────
        //
        // Each refused before a file is opened, and each naming the reason
        // rather than being silently ignored: a file that plays and is timed
        // wrong is the failure that looks like it worked.
        ExportSettings noGraph = baseSettings("out/export-vfr-refused.mp4");
        noGraph.endTime = 0.4;
        noGraph.fpsMode = "vfr";
        ExportClip one;
        one.path = first;
        one.start = 0;
        one.length = 0.4;
        one.w = kW;
        one.h = kH;
        ExportStatus r1 = render(noGraph, {one});
        checkf(r1.state == ExportStatus::State::Failed &&
                   r1.error.find("composites the timeline") != std::string::npos,
               "a composited render is refused vfr, saying the compositor has no times of its "
               "own (%s)", r1.error.empty() ? "it rendered, which it must not" : r1.error.c_str());

        ExportSettings padded = sv;
        padded.path = "out/export-vfr-pad.mp4";
        padded.streams = {{"video", "pad:vout"}};
        ExportStatus r2 = render(padded, {});
        checkf(r2.state == ExportStatus::State::Failed &&
                   r2.error.find("own moments") != std::string::npos,
               "and a render that maps a graph pad is refused too (%s)",
               r2.error.empty() ? "it rendered, which it must not" : r2.error.c_str());

        ExportSettings named = sv;
        named.path = "out/export-vfr-named.mp4";
        named.fpsMode = "passthrough";
        ExportStatus r3 = render(named, {});
        checkf(r3.state == ExportStatus::State::Failed &&
                   r3.error.find("passthrough") != std::string::npos,
               "and a mode this renderer does not perform is refused by name rather than "
               "mapped onto one it does (%s)",
               r3.error.empty() ? "it rendered, which it must not" : r3.error.c_str());
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

    // ── a graph that produces more than one thing ──────────────────────────
    //
    // Everything above this point renders a graph that ends in one picture and
    // at most one sound, because that is what a render was: a composite and a
    // mix. A filter graph does not have to end that way and neither does a
    // file — `[0:v]split=3` and three `crop`s is a wide screen grab becoming
    // three streams of one mp4 — so `ExportStream::source` takes `pad:<label>`
    // and the renderer opens a sink per output pad.
    //
    // What is worth asserting about it is not that the streams exist. Three
    // video streams of the right sizes pass for a file where every one of them
    // is the same picture, or where the two halves came out the wrong way
    // round, which are exactly the mistakes this mechanism can make. So the
    // pads are compared against the *composite* they were cut from: the left
    // stream against the left half of the canvas, pixel for pixel through the
    // same encoder.
    {
        std::printf("\na graph whose pads are streams of their own\n");

        const ExportClip c = leftHalf(first, srcDuration);
        const int half = kW / 2;                 // even, because yuv420p is
        char text[1024];
        std::snprintf(text, sizeof(text),
            "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,format=rgba,"
            "split=3[m][b][cc];"
            "[m]null[vout];"
            "[b]crop=%d:%d:0:0[left];"
            "[cc]crop=%d:%d:%d:0[right]",
            c.inPoint, c.inPoint + c.length, kW, kH,
            half, kH,
            half, kH, half);

        const std::string outP = "out/export-pads.mp4";
        ExportSettings sp = baseSettings(outP);
        sp.endTime = 1.0;
        sp.includeAudio = false;
        sp.filterGraph = text;
        sp.filterInputs = {{"0:v", first, "v"}};
        sp.filterInputs[0].from = c.inPoint;

        ExportStream whole;
        whole.kind = "video";
        whole.source = "composite";
        whole.codec = "libx264";
        ExportStream left = whole;
        left.source = "pad:left";
        ExportStream right = whole;
        right.source = "pad:right";
        sp.streams = {whole, left, right};

        st = render(sp, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a graph split into three pictures renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            std::vector<int> vs;
            {
                Opened f(outP);
                check(!!f, "and the result opens");
                if (f) vs = streamsOfKind(f.fc, AVMEDIA_TYPE_VIDEO);
                checkf(vs.size() == 3, "with three video streams in it (%zu)", vs.size());
                if (vs.size() == 3) {
                    // The list order is the muxer's numbering, so the halves
                    // are streams 1 and 2 and their size is the pad's rather
                    // than the render's — asked of the sink after the graph was
                    // configured, because nothing outside libavfilter knew it.
                    const AVCodecParameters* p0 = f.fc->streams[vs[0]]->codecpar;
                    const AVCodecParameters* p1 = f.fc->streams[vs[1]]->codecpar;
                    const AVCodecParameters* p2 = f.fc->streams[vs[2]]->codecpar;
                    checkf(p0->width == kW && p0->height == kH,
                           "the composite at the render's size (%dx%d)", p0->width,
                           p0->height);
                    checkf(p1->width == half && p1->height == kH && p2->width == half &&
                               p2->height == kH,
                           "and each pad at the size its own pad settled on (%dx%d, %dx%d)",
                           p1->width, p1->height, p2->width, p2->height);
                }
            }

            if (vs.size() == 3) {
                // The picture, not the plumbing. Both halves went through the
                // same encoder as the composite they were cut from, so what is
                // left between them is two x264 passes over the same pixels —
                // and every real mistake here (the crop taken from the wrong
                // edge, the two pads swapped, one stream fed the canvas)
                // scores far below this.
                const double at = 0.6;
                const Picture whole0 = frameOf(outP, vs[0], at);
                const Picture left0 = frameOf(outP, vs[1], at);
                const Picture right0 = frameOf(outP, vs[2], at);
                const double dl = psnrOfRegion(left0, whole0, 0, 0);
                const double dr = psnrOfRegion(right0, whole0, half, 0);
                std::printf("        left %.1f dB, right %.1f dB\n", dl, dr);
                checkf(dl > 35.0, "the left stream is the left of the composite (%.1f dB)", dl);
                checkf(dr > 35.0, "and the right stream is the right of it (%.1f dB)", dr);
                // And they are not each other, which is what says the two pads
                // are two pictures rather than one read twice. A moving bar
                // over a gradient is different down its two halves; if a
                // future fixture is not, this is the check that will say so.
                const double swapped = psnrOfRegion(left0, whole0, half, 0);
                checkf(swapped < dl - 3.0,
                       "and the halves are not interchangeable (%.1f dB the wrong way round)",
                       swapped);
            }
        }
    }

    // **A sound pad beside the mix**, which is the half of this that cannot be
    // faked. Two pictures can share one buffer and still come out right,
    // because a picture is read where it lies; two soundtracks cannot, because
    // a fifo is *consumed*. One buffer between them hands each stream alternate
    // blocks of the other's samples and writes two tracks that are each half of
    // both — which is a file that plays, at about the right length, and is
    // wrong. So the pad is `volume=0.5` of the very samples the mix gets, and
    // what is measured is that it came out half as loud.
    if (srcHasAudio && srcAudible) {
        std::printf("\na second soundtrack off a pad\n");

        const ExportClip c = leftHalf(first, srcDuration);
        char text[1024];
        std::snprintf(text, sizeof(text),
            "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,format=rgba[vout];"
            "[0:a]atrim=start=%g:end=%g,asetpts=PTS-STARTPTS,asplit[aout][d];"
            "[d]volume=0.5[quiet]",
            c.inPoint, c.inPoint + c.length, kW, kH,
            c.inPoint, c.inPoint + c.length);

        const std::string outQ = "out/export-pad-audio.mkv";
        ExportSettings sq = baseSettings(outQ);
        sq.endTime = 1.0;
        sq.format = "matroska";
        sq.filterGraph = text;
        sq.filterInputs = {{"0:v", first, "v"}, {"0:a", first, "a"}};
        for (auto& in : sq.filterInputs) in.from = c.inPoint;

        ExportStream v;
        v.kind = "video";
        v.source = "composite";
        v.codec = "libx264";
        ExportStream loud;
        loud.kind = "audio";
        loud.source = "mix";
        loud.codec = "aac";
        loud.bitrateKbps = 192;
        ExportStream quiet = loud;
        quiet.source = "pad:quiet";
        sq.streams = {v, loud, quiet};

        st = render(sq, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a graph with two soundtracks renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        if (st.state == ExportStatus::State::Done) {
            std::vector<int> as;
            {
                Opened f(outQ);
                check(!!f, "and the result opens");
                if (f) as = streamsOfKind(f.fc, AVMEDIA_TYPE_AUDIO);
            }
            checkf(as.size() == 2, "with two audio streams in it (%zu)", as.size());
            if (as.size() == 2) {
                const double loudRms = rmsOfStream(outQ, as[0]);
                const double quietRms = rmsOfStream(outQ, as[1]);
                const double ratio = loudRms > 0 ? quietRms / loudRms : -1.0;
                std::printf("        mix %.4f, pad %.4f, ratio %.3f\n", loudRms, quietRms,
                            ratio);
                checkf(loudRms > 0.005, "the mix is audible (%.4f rms)", loudRms);
                // Half, within what an encode at 192 kbps and a decode either
                // side of it move it by. A shared fifo puts this at about 0.75
                // and a pad reading the mix's own buffer puts it at 1.0, so the
                // window is wide enough to be stable and nowhere near either.
                checkf(ratio > 0.42 && ratio < 0.58,
                       "and the pad is half as loud, sample for sample (%.3f)", ratio);
            }
        }
    }

    // **A render whose every picture comes from a pad**, which is the case
    // there is no composite at all: nothing is labelled `vout`, so nothing says
    // which pad is the canvas, and that is not an error — it is a file made of
    // two halves and no whole.
    {
        std::printf("\na render with no composite in it\n");

        const ExportClip c = leftHalf(first, srcDuration);
        const int half = kW / 2;
        char text[1024];
        std::snprintf(text, sizeof(text),
            "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,format=rgba,"
            "split=2[b][cc];"
            "[b]crop=%d:%d:0:0[left];"
            "[cc]crop=%d:%d:%d:0[right]",
            c.inPoint, c.inPoint + c.length, kW, kH,
            half, kH,
            half, kH, half);

        const std::string outN = "out/export-pads-only.mp4";
        ExportSettings sn = baseSettings(outN);
        sn.endTime = 0.8;
        sn.includeAudio = false;
        sn.filterGraph = text;
        sn.filterInputs = {{"0:v", first, "v"}};
        sn.filterInputs[0].from = c.inPoint;

        ExportStream left;
        left.kind = "video";
        left.source = "pad:left";
        left.codec = "libx264";
        ExportStream right = left;
        right.source = "pad:right";
        sn.streams = {left, right};

        st = render(sn, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a render whose every picture is a pad finishes (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        if (st.state == ExportStatus::State::Done) {
            Opened f(outN);
            const std::vector<int> vs = f ? streamsOfKind(f.fc, AVMEDIA_TYPE_VIDEO)
                                          : std::vector<int>();
            checkf(vs.size() == 2, "with two video streams and no third (%zu)", vs.size());
            if (vs.size() == 2)
                checkf(f.fc->streams[vs[0]]->codecpar->width == half,
                       "each at its pad's size (%d)", f.fc->streams[vs[0]]->codecpar->width);
        }

        // And the other half of that: the same graph, asked for the composite.
        // With two pads and neither of them labelled, nothing says which is the
        // picture — so it is refused, naming the labels there *were*, because
        // the fix is to label one of them or to map them.
        ExportSettings sc = sn;
        sc.path = "out/export-pads-nocomposite.mp4";
        ExportStream whole;
        whole.kind = "video";
        whole.source = "composite";
        whole.codec = "libx264";
        sc.streams = {whole};
        const ExportStatus cs = render(sc, clipsA);
        checkf(cs.state == ExportStatus::State::Failed &&
                   mentions(cs.error, "[left]") && mentions(cs.error, "vout"),
               "and asking such a graph for the composite is refused, with the labels (%s)",
               cs.error.empty() ? "it rendered, which it must not" : cs.error.c_str());
    }

    // **A second stream of the same picture at half the size**, which is a
    // proxy beside the master and needed no graph at all: one canvas, two
    // encoders, and the scaler each stream already had doing the resize as well
    // as the colour. It is here because it is the other thing a per-stream size
    // buys, and because it is the cheapest possible check that the size on a
    // stream is not quietly the render's.
    {
        std::printf("\na proxy stream beside the master\n");

        const std::string outX = "out/export-proxy.mp4";
        ExportSettings sx = baseSettings(outX);
        sx.endTime = 0.8;
        sx.includeAudio = false;

        ExportStream master;
        master.kind = "video";
        master.source = "composite";
        master.codec = "libx264";
        ExportStream proxy = master;
        proxy.width = kW / 2;
        proxy.height = kH / 2;
        sx.streams = {master, proxy};

        st = render(sx, clipsA);
        checkf(st.state == ExportStatus::State::Done,
               "a render with a proxy stream finishes (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        if (st.state == ExportStatus::State::Done) {
            Opened f(outX);
            const std::vector<int> vs = f ? streamsOfKind(f.fc, AVMEDIA_TYPE_VIDEO)
                                          : std::vector<int>();
            checkf(vs.size() == 2, "with two video streams (%zu)", vs.size());
            if (vs.size() == 2)
                checkf(f.fc->streams[vs[0]]->codecpar->width == kW &&
                           f.fc->streams[vs[1]]->codecpar->width == kW / 2 &&
                           f.fc->streams[vs[1]]->codecpar->height == kH / 2,
                       "one the size of the render and one half of it (%d, %dx%d)",
                       f.fc->streams[vs[0]]->codecpar->width,
                       f.fc->streams[vs[1]]->codecpar->width,
                       f.fc->streams[vs[1]]->codecpar->height);
        }
    }

    // Every way of asking for a pad that cannot work, refused where the
    // decision was made rather than at the first frame — which for a label
    // nobody can resolve means before a muxer has opened a file.
    {
        std::printf("\npads that are not there\n");

        const ExportClip c = leftHalf(first, srcDuration);
        char text[1024];
        std::snprintf(text, sizeof(text),
            "[0:v]trim=start=%g:end=%g,setpts=PTS-STARTPTS,scale=%d:%d,format=rgba,"
            "split=2[m][b];[m]null[vout];[b]crop=%d:%d:0:0[left]",
            c.inPoint, c.inPoint + c.length, kW, kH, kW / 2, kH);

        ExportStream whole;
        whole.kind = "video";
        whole.source = "composite";
        whole.codec = "libx264";

        ExportSettings sb = baseSettings("out/export-pad-unknown.mp4");
        sb.endTime = 0.4;
        sb.includeAudio = false;
        sb.filterGraph = text;
        sb.filterInputs = {{"0:v", first, "v"}};
        ExportStream nope;
        nope.kind = "video";
        nope.source = "pad:nope";
        nope.codec = "libx264";
        sb.streams = {whole, nope};
        ExportStatus bs = render(sb, clipsA);
        checkf(bs.state == ExportStatus::State::Failed && mentions(bs.error, "[nope]") &&
                   mentions(bs.error, "[left]"),
               "a pad nothing is called is refused, saying what there was (%s)",
               bs.error.empty() ? "it rendered, which it must not" : bs.error.c_str());

        // The same stream with no graph behind it at all. The picture comes
        // from the timeline, so there are no pads to name and saying which is
        // the whole of the answer.
        ExportSettings sg2 = baseSettings("out/export-pad-nograph.mp4");
        sg2.endTime = 0.4;
        sg2.includeAudio = false;
        ExportStream stray;
        stray.kind = "video";
        stray.source = "pad:left";
        stray.codec = "libx264";
        sg2.streams = {whole, stray};
        bs = render(sg2, clipsA);
        checkf(bs.state == ExportStatus::State::Failed && mentions(bs.error, "no graph"),
               "and so is a pad on a render that has no graph (%s)",
               bs.error.empty() ? "it rendered, which it must not" : bs.error.c_str());

        // And a pad on a subtitle stream, which is not a narrower version of
        // the same mistake: nothing in this binary turns a picture into cues,
        // so there is no pad that could ever feed one.
        ExportSettings ss2 = baseSettings("out/export-pad-subtitle.mkv");
        ss2.endTime = 0.4;
        ss2.format = "matroska";
        ss2.includeAudio = false;
        ss2.filterGraph = text;
        ss2.filterInputs = {{"0:v", first, "v"}};
        ExportStream cue;
        cue.kind = "subtitle";
        cue.source = "pad:left";
        ss2.streams = {whole, cue};
        bs = render(ss2, clipsA);
        checkf(bs.state == ExportStatus::State::Failed && mentions(bs.error, "subtitle"),
               "and a subtitle stream cannot be fed from one at all (%s)",
               bs.error.empty() ? "it rendered, which it must not" : bs.error.c_str());
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

        // **A question the application put to itself is not something a render
        // said.** Two places in this binary ask libav something by trying it
        // and letting it fail — whether this build's image2 can glob, and which
        // hardware device types can be created — and both of those failures are
        // logged at AV_LOG_ERROR by code that has no idea it is being
        // interrogated. Left in the channel they colour a perfectly good
        // render's report drawer red before anybody has pressed anything.
        // `LogQuiet` is the guard, it is thread-local so that asking on the UI
        // thread cannot cost the render thread its words, and until now nothing
        // checked that it mutes anything at all.
        {
            const uint64_t quietFrom = d.logCursor;
            {
                LogQuiet quiet;
                av_log(nullptr, AV_LOG_ERROR, "exporttest: asked and answered\n");
            }
            av_log(nullptr, AV_LOG_ERROR, "exporttest: said out loud\n");
            const ReportDrain q = drainReport(quietFrom, metaFrom, kAll);
            bool heardQuiet = false, heardLoud = false;
            for (const auto& m : q.logs) {
                if (m.text.find("asked and answered") != std::string::npos) heardQuiet = true;
                if (m.text.find("said out loud") != std::string::npos) heardLoud = true;
            }
            check(!heardQuiet, "a line said inside a LogQuiet does not reach the channel");
            check(heardLoud, "and the guard is over the moment it goes out of scope");
            d = drainReport(quietFrom, metaFrom, kAll);
        }

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

        // ── the clock a measurement is sampled against ─────────────────────
        //
        // A series is a named quantity sampled *over the render*, and the
        // timestamps are the whole of what makes it one. Every derived chain
        // begins `setpts=PTS-STARTPTS+offset/TB`, where the offset is where the
        // window sits on the render's clock (`spec.origin` in graph/derive.js)
        // — so a preview of two seconds out of the middle of a render carries
        // the render's seconds, not the window's. That is what lets a plot of
        // `cropdetect` drawn from a preview line up with the timeline, and a
        // series measured against the wrong zero is worse than none: it points
        // at the wrong frame with complete confidence.
        const uint64_t shiftFrom = drainReport(0, 0, kAll).metaCursor;
        constexpr double kOrigin = 4.0;
        std::snprintf(text, sizeof(text),
            "[0:v]setpts=PTS-STARTPTS+%g/TB,cropdetect=limit=24:round=2:reset=1,"
            "scale=%d:%d[vout]", kOrigin, kW, kH);
        ExportSettings so = baseSettings("out/export-measure-shifted.mp4");
        so.endTime = 0.6;
        so.filterGraph = text;
        so.filterInputs = {{"0:v", first, "v"}};
        st = render(so, clipsA);
        checkf(st.state == ExportStatus::State::Done, "a graph shifted onto the render's clock renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        const ReportDrain ds = drainReport(0, shiftFrom, kAll);
        double shiftedFirst = -1, shiftedLast = -1;
        int shiftedSamples = 0;
        for (const auto& m : ds.meta) {
            if (m.key.rfind("lavfi.cropdetect.", 0) != 0) continue;
            if (shiftedFirst < 0) shiftedFirst = m.at;
            shiftedLast = m.at;
            ++shiftedSamples;
        }
        checkf(shiftedSamples > 0 && shiftedFirst >= kOrigin - 0.05 &&
               shiftedLast <= kOrigin + so.endTime + 0.1,
               "and what it measured is stamped on the render's clock, not the window's "
               "(%.2f to %.2f s, expected around %.1f)", shiftedFirst, shiftedLast, kOrigin);
    }

    // ── a render that is two renders ───────────────────────────────────────
    //
    // Two things in ffmpeg genuinely need a second walk over the same frames,
    // and both hand off through a file on disk: a two-pass filter
    // (`vidstabdetect` writes a `.trf`, `vidstabtransform` reads it) and a
    // two-pass encoder (`-pass 1` writes a statistics log, `-pass 2` spends the
    // bitrate knowing where it is needed). What the machinery has to provide is
    // therefore small — run the range twice with overrides — and what it must
    // not do is invent a second job slot, because a two-pass render is one
    // thing to whoever pressed the button.
    //
    // The shape is checked rather than vidstab itself, which is a `--enable-`
    // this build does not have: pass one writes an intermediate file, pass two
    // reads it, and what comes out has to be the second pass's answer.
    {
        std::printf("\ntwo passes, one job\n");
        char text[512];
        constexpr int kAll = 1 << 20;

        const std::string mid = "out/export-pass1.mkv";
        const std::string outP = "out/export-two-pass.mp4";
        ExportSettings sp = baseSettings(outP);
        sp.endTime = 0.6;
        std::snprintf(text, sizeof(text), "[0:v]scale=%d:%d[vout]", kW, kH);
        sp.filterGraph = text;
        sp.filterInputs = {{"0:v", first, "v"}};

        ExportPass detect;
        detect.label = "writing what the second pass reads";
        detect.path = mid;
        detect.format = "matroska";
        std::snprintf(text, sizeof(text), "[0:v]scale=%d:%d,hflip[vout]", kW, kH);
        detect.filterGraph = text;
        detect.filterInputs = {{"0:v", first, "v"}};

        ExportPass apply;
        apply.label = "the render itself";
        // Nothing overridden but the pad the graph reads: the second pass is
        // the render's own settings, fed from what the first pass left behind.
        apply.filterInputs = {{"0:v", mid, "v"}};

        sp.passes = {detect, apply};
        st = render(sp, clipsA);
        checkf(st.state == ExportStatus::State::Done, "both passes ran as one job (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        checkf(st.passCount == 2 && st.pass == 2,
               "and the status says which pass it ended on (%d of %d)", st.pass, st.passCount);
        checkf(st.path == outP,
               "with the file it left being the last pass's, not the first's (%s)",
               st.path.c_str());

        // The picture. Pass one flipped it and pass two only copied, so the
        // output has to match a single-pass flip and *not* the unflipped
        // render — which is the whole assertion: a mechanism that quietly ran
        // only the first pass, or only the last, fails one of these two.
        ExportSettings sf = baseSettings("out/export-one-pass-flipped.mp4");
        sf.endTime = 0.6;
        std::snprintf(text, sizeof(text), "[0:v]scale=%d:%d,hflip[vout]", kW, kH);
        sf.filterGraph = text;
        sf.filterInputs = {{"0:v", first, "v"}};
        check(render(sf, clipsA).state == ExportStatus::State::Done,
              "the same edit renders in one pass for comparison");

        ExportSettings su = baseSettings("out/export-one-pass-plain.mp4");
        su.endTime = 0.6;
        std::snprintf(text, sizeof(text), "[0:v]scale=%d:%d[vout]", kW, kH);
        su.filterGraph = text;
        su.filterInputs = {{"0:v", first, "v"}};
        check(render(su, clipsA).state == ExportStatus::State::Done,
              "and so does the version the first pass did not touch");

        {
            VideoPipeline two, flipped, plain;
            if (two.open(outP) && flipped.open(sf.path) && plain.open(su.path)) {
                const TimeNs at = static_cast<TimeNs>(0.3 * 1e9);
                two.advanceTo(at); flipped.advanceTo(at); plain.advanceTo(at);
                if (two.hasFrame() && flipped.hasFrame() && plain.hasFrame()) {
                    const double same = psnr(two.currentRgba(), flipped.currentRgba(), kW, kH);
                    const double other = psnr(two.currentRgba(), plain.currentRgba(), kW, kH);
                    checkf(same > 30.0,
                           "what came out is the second pass reading the first's file (%.1f dB)",
                           same);
                    checkf(other < same - 6.0,
                           "and is not the render the passes were never asked for (%.1f dB)",
                           other);
                } else {
                    check(false, "all three renders decode for comparison");
                }
            } else {
                check(false, "all three renders open for comparison");
            }
        }

        // An analysis pass keeps nothing. `-f null -` is what ffmpeg writes for
        // this and it is `AVFMT_NOFILE`, so there is no file to delete
        // afterwards — while everything a filter measured on the way past is
        // still in the channel, which is the entire point of running it.
        const uint64_t nullFrom = drainReport(0, 0, kAll).metaCursor;
        const std::string nothing = "out/export-discarded.mp4";
        std::remove(nothing.c_str());
        ExportSettings sd = baseSettings(outP);
        sd.endTime = 0.4;
        std::snprintf(text, sizeof(text),
            "[0:v]cropdetect=limit=24:round=2:reset=1,scale=%d:%d[vout]", kW, kH);
        sd.filterGraph = text;
        sd.filterInputs = {{"0:v", first, "v"}};
        ExportPass analyse;
        analyse.label = "analysing";
        analyse.path = nothing;
        analyse.discard = true;
        analyse.videoCodec = "wrapped_avframe";
        sd.passes = {analyse, ExportPass{}};
        st = render(sd, clipsA);
        checkf(st.state == ExportStatus::State::Done, "an analysis pass runs and writes nothing (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        std::FILE* left = std::fopen(nothing.c_str(), "rb");
        if (left) std::fclose(left);
        check(!left, "the discarded pass left no file behind");
        int measured = 0;
        for (const auto& m : drainReport(0, nullFrom, kAll).meta)
            if (m.key.rfind("lavfi.cropdetect.", 0) == 0) ++measured;
        checkf(measured > 0, "and what it measured is in the channel anyway (%d samples)",
               measured);
    }

    // ── the rest of what an encoder is told ────────────────────────────────
    //
    // Four things that are not encoder options and could not be reached
    // through the option bag: two-pass rate control, a bitstream filter,
    // forced keyframes and the field order. Each is checked against the file
    // that came out rather than against what the settings said, because every
    // one of them is a claim about bytes nobody sees until the render is over.
    {
        std::printf("\ntwo-pass encoding\n");
        char text[512];

        // A bitrate low enough that the encoder has to make decisions about
        // where to spend it, which is the whole difference the second pass
        // makes. Short, because two runs of x264 is two runs of x264.
        constexpr int kTargetKbps = 260;
        const std::string logPrefix = "out/export-2pass";
        std::remove((logPrefix + "-0.log").c_str());
        std::remove((logPrefix + "-0.log.mbtree").c_str());

        // Through the *option bag*, which is what the UI sends: a friendly
        // control produces `-key value` pairs and there is no private path from
        // it to the encoder. That matters more here than it looks — the writer
        // also has convenience fields for the rate, and `crf` is a private
        // option while `b` is a generic one, so they do not overwrite each
        // other. Set both and x264 picks CRF, and a render told to hit a
        // bitrate comes out byte for byte identical to the quality one with the
        // command bar printing `-b:v` throughout. The check below is the one
        // that says it does not.
        ExportSettings quality = baseSettings("out/export-abr-crf.mp4");
        quality.includeAudio = false;
        check(render(quality, clipsA).state == ExportStatus::State::Done,
              "the same edit renders at constant quality for comparison");
        const int64_t crfBytes = exportStatus().bytesWritten;

        ExportSettings one = baseSettings("out/export-abr-1pass.mp4");
        one.videoOptions = {{"b", std::to_string(kTargetKbps) + "k"}};
        one.includeAudio = false;
        st = render(one, clipsA);
        checkf(st.state == ExportStatus::State::Done, "one pass at a bitrate target renders (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        const int64_t oneBytes = st.bytesWritten;
        checkf(oneBytes != crfBytes,
               "a bitrate in the option bag is what the encoder spends, not the crf the "
               "writer would otherwise have set (%lld bytes against %lld)",
               static_cast<long long>(oneBytes), static_cast<long long>(crfBytes));

        ExportSettings two = baseSettings("out/export-abr-2pass.mp4");
        two.videoOptions = {{"b", std::to_string(kTargetKbps) + "k"}};
        two.includeAudio = false;
        ExportPass p1;
        p1.label = "pass 1";
        p1.discard = true;
        p1.videoOptions = {{"pass", "1"}, {"passlogfile", logPrefix}};
        ExportPass p2;
        p2.label = "pass 2";
        p2.videoOptions = {{"pass", "2"}, {"passlogfile", logPrefix}};
        two.passes = {p1, p2};
        st = render(two, clipsA);
        checkf(st.state == ExportStatus::State::Done, "and so does the same target in two (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        const int64_t twoBytes = st.bytesWritten;

        // The handoff is a file, and the file is the proof. `-passlogfile` is
        // ffmpeg's own option rather than any encoder's, so the whole question
        // is whether it reached the place the encoder keeps its statistics —
        // and an empty log is what a two-pass render that silently did two
        // first passes leaves behind.
        std::error_code sec;
        const auto logSize = std::filesystem::file_size(
            std::filesystem::path(logPrefix + "-0.log"), sec);
        checkf(!sec && logSize > 0,
               "pass 1 wrote its statistics where -passlogfile said (%s-0.log, %lld bytes)",
               logPrefix.c_str(), sec ? 0LL : static_cast<long long>(logSize));

        // Two passes at the same target is not one pass at the same target.
        // Identical output would mean the second pass had nothing to read.
        checkf(twoBytes != oneBytes,
               "the second pass spent the bitrate differently (%lld bytes against %lld)",
               static_cast<long long>(twoBytes), static_cast<long long>(oneBytes));

        const double span = two.endTime - two.startTime;
        const double target = kTargetKbps * 1000.0 / 8.0 * span;
        const double offOne = std::fabs(oneBytes - target) / target;
        const double offTwo = std::fabs(twoBytes - target) / target;
        checkf(offTwo <= offOne,
               "and hit the target more closely (%.1f%% out against %.1f%%)",
               offTwo * 100, offOne * 100);

        // A second pass with nothing to read is a refusal with the reason,
        // never a render that quietly falls back to one pass — the file would
        // be plausible and would not be what was asked for.
        ExportSettings orphan = baseSettings("out/export-never.mp4");
        orphan.endTime = 0.4;
        orphan.videoBitrateKbps = kTargetKbps;
        ExportPass alone;
        alone.videoOptions = {{"pass", "2"}, {"passlogfile", "out/no-such-pass-log"}};
        orphan.passes = {alone};
        st = render(orphan, clipsA);
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("pass 2") != std::string::npos,
               "pass 2 with no statistics to read is refused (%s)", st.error.c_str());

        std::printf("\nbitstream filters\n");

        // `h264_metadata` rewrites the SPS without touching a pixel, which is
        // exactly what a bitstream filter is for and is why it is the one to
        // test with: the level in the file is a number that can only have come
        // from the filter, since the encoder chose a different one.
        ExportSettings plain = baseSettings("out/export-bsf-none.mp4");
        plain.endTime = 0.4;
        plain.includeAudio = false;
        check(render(plain, clipsA).state == ExportStatus::State::Done,
              "a stream renders with no bitstream filter on it");
        int levelBefore = 0;
        { Opened o(plain.path); if (o) levelBefore = o.fc->streams[0]->codecpar->level; }

        ExportSettings filtered = baseSettings("out/export-bsf-level.mp4");
        filtered.endTime = 0.4;
        filtered.includeAudio = false;
        ExportStream vs;
        vs.kind = "video";
        vs.source = "composite";
        vs.codec = "libx264";
        vs.bitstreamFilters = {{"h264_metadata", {{"level", "5.1"}}}};
        filtered.streams = {vs};
        st = render(filtered, clipsA);
        checkf(st.state == ExportStatus::State::Done, "and renders through one (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        int levelAfter = 0;
        { Opened o(filtered.path); if (o) levelAfter = o.fc->streams[0]->codecpar->level; }
        checkf(levelAfter == 51 && levelBefore != 51,
               "which changed the bitstream itself — the SPS says level %d where the "
               "encoder wrote %d", levelAfter, levelBefore);

        ExportSettings badBsf = filtered;
        badBsf.path = "out/export-never.mp4";
        badBsf.streams[0].bitstreamFilters = {{"no_such_bsf", {}}};
        st = render(badBsf, clipsA);
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("no_such_bsf") != std::string::npos,
               "a bitstream filter this build lacks is refused by name (%s)", st.error.c_str());

        badBsf.streams[0].bitstreamFilters = {{"h264_metadata", {{"nonsense", "1"}}}};
        st = render(badBsf, clipsA);
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("nonsense") != std::string::npos,
               "and an option it does not have is too (%s)", st.error.c_str());

        std::printf("\nforced keyframes\n");

        // Read out of the file, not asked of the encoder. Whether a packet is
        // a keyframe is what a player will act on when it seeks, and the
        // encoder's own opinion is one indirection away from that.
        const auto keyTimes = [](const std::string& path) {
            std::vector<double> out;
            Opened o(path);
            if (!o) return out;
            int vs2 = -1;
            for (unsigned i = 0; i < o.fc->nb_streams; ++i)
                if (o.fc->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
                    { vs2 = static_cast<int>(i); break; }
            if (vs2 < 0) return out;
            AVPacket* pkt = av_packet_alloc();
            while (av_read_frame(o.fc, pkt) >= 0) {
                if (pkt->stream_index == vs2 && (pkt->flags & AV_PKT_FLAG_KEY) &&
                    pkt->pts != AV_NOPTS_VALUE)
                    out.push_back(pkt->pts * av_q2d(o.fc->streams[vs2]->time_base));
                av_packet_unref(pkt);
            }
            av_packet_free(&pkt);
            std::sort(out.begin(), out.end());
            return out;
        };

        ExportSettings kf = baseSettings("out/export-keyframes.mp4");
        kf.includeAudio = false;
        // A GOP longer than the render, so every keyframe past the first is
        // one that was asked for and not one the encoder would have written
        // anyway. Without this the check passes for the wrong reason.
        kf.videoOptions = {{"g", "1000"}, {"sc_threshold", "0"}};
        kf.forceKeyFrames = "0.4,0.8,1.2";
        st = render(kf, clipsA);
        checkf(st.state == ExportStatus::State::Done, "a render with forced keyframes runs (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        const auto keys = keyTimes(kf.path);
        std::string where;
        for (double k : keys) {
            std::snprintf(text, sizeof(text), "%s%.2f", where.empty() ? "" : " ", k);
            where += text;
        }
        // One frame of tolerance: a forced keyframe lands on the first output
        // frame at or past the moment asked for, which at 25 fps is up to 40 ms
        // later and never earlier.
        const double tol = 1.0 / kFps + 1e-3;
        const auto near = [&](double want) {
            for (double k : keys) if (k >= want - 1e-3 && k <= want + tol) return true;
            return false;
        };
        checkf(near(0.4) && near(0.8) && near(1.2),
               "and the file has a keyframe at each of them (%s)", where.c_str());
        checkf(keys.size() <= 5,
               "and not simply at every frame (%zu keyframes in %.1f s)", keys.size(),
               kf.endTime - kf.startTime);

        ExportSettings kfe = baseSettings("out/export-keyframes-expr.mp4");
        kfe.includeAudio = false;
        kfe.videoOptions = {{"g", "1000"}, {"sc_threshold", "0"}};
        kfe.forceKeyFrames = "expr:gte(t,n_forced*0.5)";
        st = render(kfe, clipsA);
        check(st.state == ExportStatus::State::Done, "an expression is accepted too");
        const auto ekeys = keyTimes(kfe.path);
        checkf(ekeys.size() >= 3, "and puts one every half second (%zu in %.1f s)",
               ekeys.size(), kfe.endTime - kfe.startTime);

        ExportSettings kfb = baseSettings("out/export-never.mp4");
        kfb.endTime = 0.4;
        kfb.forceKeyFrames = "expr:this is not an expression";
        st = render(kfb, clipsA);
        check(st.state == ExportStatus::State::Failed,
              "and an expression that will not parse is refused rather than ignored");

        std::printf("\nfield order, threads, -shortest\n");

        ExportSettings fo = baseSettings("out/export-interlaced.mp4");
        fo.endTime = 0.4;
        fo.includeAudio = false;
        fo.fieldOrder = "tt";
        fo.threads = 2;
        fo.threadType = "frame";
        st = render(fo, clipsA);
        checkf(st.state == ExportStatus::State::Done, "an interlaced render runs (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        {
            Opened o(fo.path);
            checkf(o && o.fc->streams[0]->codecpar->field_order == AV_FIELD_TT,
                   "and the file says top field first (%d)",
                   o ? int(o.fc->streams[0]->codecpar->field_order) : -1);
        }
        ExportSettings badThreads = baseSettings("out/export-never.mp4");
        badThreads.endTime = 0.4;
        badThreads.threadType = "sideways";
        st = render(badThreads, clipsA);
        check(st.state == ExportStatus::State::Failed,
              "a thread type that is not one is refused");

        // The range asks for a second and a half; the clip stops at half a
        // second. Without -shortest the rest is written as black, which is the
        // right default — the range is a decision somebody made — and with it
        // the file ends where the content does.
        std::vector<ExportClip> shortClip{leftHalf(first, srcDuration)};
        shortClip[0].length = 0.5;
        ExportSettings padded = baseSettings("out/export-padded.mp4");
        padded.includeAudio = false;
        const ExportStatus padSt = render(padded, shortClip);
        ExportSettings cut = baseSettings("out/export-shortest.mp4");
        cut.includeAudio = false;
        cut.shortest = true;
        const ExportStatus cutSt = render(cut, shortClip);
        checkf(padSt.state == ExportStatus::State::Done &&
                   cutSt.state == ExportStatus::State::Done,
               "a range longer than the content renders both ways");
        checkf(cutSt.framesDone < padSt.framesDone && cutSt.framesDone >= 12,
               "-shortest stopped where the content did (%lld frames against %lld)",
               static_cast<long long>(cutSt.framesDone),
               static_cast<long long>(padSt.framesDone));

        std::printf("\ndecoder options\n");

        // A decoder belongs to an input, which is why these travel on the `-i`
        // and not on the render. The refusal is the interesting half: an
        // unknown key here is the same error an unknown demuxer option is, and
        // a render that ignored it would be a render that decoded differently
        // from what it was told to.
        MediaInput skip;
        skip.path = first;
        skip.decoderOptions = {{"skip_frame", "nokey"}};
        ExportSettings dec = baseSettings("out/export-skipframe.mp4");
        dec.endTime = 0.4;
        dec.includeAudio = false;
        dec.inputs = {skip};
        std::vector<ExportClip> viaInput{leftHalf(first, srcDuration)};
        viaInput[0].input = 0;
        st = render(dec, viaInput);
        checkf(st.state == ExportStatus::State::Done,
               "a decoder option on an input reaches the decoder (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        MediaInput wrong = skip;
        wrong.decoderOptions = {{"not_a_decoder_option", "1"}};
        ExportSettings decBad = baseSettings("out/export-never.mp4");
        decBad.endTime = 0.4;
        decBad.inputs = {wrong};
        st = render(decBad, viaInput);
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("not_a_decoder_option") != std::string::npos,
               "and one it does not have stops the render by name (%s)", st.error.c_str());
    }

    // ── the packet path ────────────────────────────────────────────────────
    //
    // A copied stream is the one thing in this renderer that never decodes.
    // Everything below is about that being literally true: the bytes that come
    // out are the bytes that went in, the cut lands on a keyframe, and a copied
    // picture sits happily beside an encoded soundtrack in one file.
    {
        std::printf("\nstream copy\n");

        const int srcVideo = streamIndexOf(first, AVMEDIA_TYPE_VIDEO);
        const int srcAudio = streamIndexOf(first, AVMEDIA_TYPE_AUDIO);
        checkf(srcVideo >= 0, "the fixture has a video stream to copy (index %d)", srcVideo);

        MediaInput in;
        in.path = first;

        // Where a copy can start, asked of the input. The index answers for an
        // mp4, which is what makes this instant rather than a read of the file.
        KeyframeList keys;
        std::string kerr;
        const bool gotKeys = keyframesOf(in, srcVideo, 0, 0, 0, &keys, &kerr);
        checkf(gotKeys && !keys.times.empty(),
               "the keyframes are reported (%zu, from the %s, %s)", keys.times.size(),
               keys.how.c_str(), keys.complete ? "complete" : "cut short");
        bool ascending = true;
        for (size_t i = 1; i < keys.times.size(); ++i)
            if (keys.times[i] <= keys.times[i - 1]) ascending = false;
        check(ascending, "in order, on the input's own clock");
        checkf(keys.times.empty() || keys.times[0] < 0.001,
               "and the first is the start of the file (%.3f s)",
               keys.times.empty() ? -1.0 : keys.times[0]);
        {
            KeyframeList none;
            std::string why;
            MediaInput missing;
            missing.path = "no-such-file.mp4";
            check(!keyframesOf(missing, -1, 0, 0, 0, &none, &why),
                  "a file that is not there is refused rather than answered for");
        }

        // A rewrap: the same packets, a different container. This is the whole
        // claim of the packet path and it is asserted rather than approximated
        // — every byte of every packet, in order.
        ExportSettings rw;
        rw.path = "out/copy-rewrap.mp4";
        rw.format = "mp4";
        rw.inputs = {in};
        rw.startTime = 0;
        rw.endTime = 1.0;   // ignored: a copy's length is its own span
        rw.faststart = false;
        {
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:" + std::to_string(srcVideo);
            rw.streams.push_back(v);
        }
        st = render(rw, {});
        checkf(st.state == ExportStatus::State::Done, "a rewrap runs with nothing decoded (%s)",
               st.error.empty() ? "no error" : st.error.c_str());

        const auto before = packetsOf(first, srcVideo);
        const auto after = packetsOf(rw.path, 0);
        checkf(!before.empty() && before.size() == after.size(),
               "and writes exactly as many packets as it read (%zu against %zu)",
               after.size(), before.size());
        size_t identical = 0;
        for (size_t i = 0; i < after.size() && i < before.size(); ++i)
            if (before[i].data == after[i].data) ++identical;
        checkf(identical == before.size(),
               "every one of them byte for byte (%zu of %zu)", identical, before.size());
        {
            Opened o(rw.path);
            checkf(o && o.fc->nb_streams == 1 &&
                       o.fc->streams[0]->codecpar->codec_id ==
                           avcodec_find_decoder_by_name("h264")->id,
                   "and the result is one stream of the codec that went in");
        }

        // A lossless cut. The in-point is a keyframe, so what comes out starts
        // exactly there — which is the whole reason the keyframes are asked for
        // rather than a cut being taken wherever the playhead was.
        if (keys.times.size() >= 2) {
            const double at = keys.times[1];
            ExportSettings cut;
            cut.path = "out/copy-cut.mp4";
            cut.format = "mp4";
            cut.inputs = {in};
            cut.startTime = 0;
            cut.endTime = 1.0;
            cut.faststart = true;
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:" + std::to_string(srcVideo);
            v.copyFrom = at;
            cut.streams.push_back(v);
            st = render(cut, {});
            checkf(st.state == ExportStatus::State::Done,
                   "a cut from a keyframe at %.3f s runs (%s)", at,
                   st.error.empty() ? "no error" : st.error.c_str());

            const auto cutPkts = packetsOf(cut.path, 0);
            checkf(!cutPkts.empty() && (cutPkts[0].flags & AV_PKT_FLAG_KEY),
                   "and the file begins on a keyframe");
            checkf(!cutPkts.empty() && cutPkts[0].dts <= 0,
                   "with the copy's own zero at the front of the file (dts %lld)",
                   cutPkts.empty() ? -1LL : static_cast<long long>(cutPkts[0].dts));
            checkf(cutPkts.size() < before.size(),
                   "and it is shorter than the whole file (%zu packets against %zu)",
                   cutPkts.size(), before.size());
            // Every one of them is still a packet out of the source, at the
            // same offset into it: a cut that re-encoded would match nothing.
            size_t matched = 0;
            const size_t offset = before.size() - cutPkts.size();
            for (size_t i = 0; i < cutPkts.size(); ++i)
                if (before[offset + i].data == cutPkts[i].data) ++matched;
            checkf(matched == cutPkts.size(),
                   "byte for byte with the tail of the source (%zu of %zu)", matched,
                   cutPkts.size());
            {
                Opened o(cut.path);
                checkf(o && o.fc->duration > 0 &&
                           av_seek_frame(o.fc, -1, 0, AVSEEK_FLAG_BACKWARD) >= 0,
                       "and what was written seeks back to its start (%.2f s long)",
                       o ? o.fc->duration / double(AV_TIME_BASE) : 0.0);
            }
        }

        // **Both streams of one input, copied.** Two load-bearing rules meet in
        // this one render and nothing else in the suite touches either of them,
        // because every other `copy:` here is a picture:
        //
        //  - **A copied audio stream is not the mix.** `outputStreams()` drops
        //    audio on a silent timeline, and there is no timeline at all here —
        //    so the one-line exception for a copied source is the only thing
        //    keeping the soundtrack in the file. Take it out and "extract the
        //    soundtrack" and "replace the audio" become quietly impossible,
        //    which is what this catches: the file comes back with one stream.
        //  - **The first packet decides the file's zero, one zero per input.**
        //    Two streams out of one file keep the offset they had between them,
        //    which is the whole of A/V sync; a zero taken per stream would move
        //    the soundtrack by however far the picture's first keyframe was
        //    from it, and both files would still open and still be valid.
        //
        // The third rule of that group — `Writer::hasAudio()` counting only
        // mix-fed streams — is deliberately *not* asserted here, because it
        // turns out not to be assertable from the outside at all:
        // `Writer::writeAudio` skips a copied stream itself, so counting one in
        // `hasAudio()` costs a render the decode of every clip's soundtrack and
        // changes nothing about what is written. It is a cost rather than a
        // wrong file, and a check that claimed otherwise would be describing
        // something this suite cannot see.
        if (srcAudio >= 0) {
            ExportSettings both;
            both.path = "out/copy-both.mkv";
            both.format = "matroska";
            both.inputs = {in};
            both.startTime = 0;
            both.endTime = 1.0;   // ignored: a copy's length is its own span
            both.faststart = false;
            {
                ExportStream v;
                v.kind = "video";
                v.source = "copy:0:" + std::to_string(srcVideo);
                both.streams.push_back(v);
                ExportStream a;
                a.kind = "audio";
                a.source = "copy:0:" + std::to_string(srcAudio);
                both.streams.push_back(a);
            }
            st = render(both, {});
            checkf(st.state == ExportStatus::State::Done,
                   "a render whose picture and sound are both copied runs (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());

            const auto srcA = packetsOf(first, srcAudio);
            const auto outA2 = packetsOf(both.path, 1);
            {
                Opened o(both.path);
                checkf(o && o.fc->nb_streams == 2,
                       "with the soundtrack still in it on a timeline that has no sound "
                       "to mix (%u streams)", o ? o.fc->nb_streams : 0u);
                if (o && o.fc->nb_streams == 2)
                    check(o.fc->streams[0]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO &&
                              o.fc->streams[1]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO,
                          "in the order the list asked for");
            }
            size_t sameA = 0;
            for (size_t i = 0; i < outA2.size() && i < srcA.size(); ++i)
                if (srcA[i].data == outA2[i].data) ++sameA;
            checkf(!srcA.empty() && outA2.size() == srcA.size() && sameA == srcA.size(),
                   "every audio packet byte for byte, so nothing encoded it (%zu of %zu)",
                   sameA, srcA.size());

            // The offset between the two, in seconds, on each side. One zero
            // per input means it survives; a zero per stream means it does not.
            const auto srcV = packetsOf(first, srcVideo);
            const auto outV = packetsOf(both.path, 0);
            // Presentation timestamps, and a fall back to decode ones where a
            // container keeps only the one it needs: matroska leaves an audio
            // packet's dts unset, which is not a missing timestamp so much as a
            // container saying it has no reordering to describe.
            const auto when = [](const Pkt& p) {
                const int64_t t = p.pts != AV_NOPTS_VALUE ? p.pts : p.dts;
                return t == AV_NOPTS_VALUE ? 0.0 : t * av_q2d(p.timeBase);
            };
            if (!srcV.empty() && !srcA.empty() && !outV.empty() && !outA2.empty()) {
                const double wasV = when(srcV[0]);
                const double wasA = when(srcA[0]);
                const double isV = when(outV[0]);
                const double isA = when(outA2[0]);
                checkf(std::fabs((isV - isA) - (wasV - wasA)) < 0.005,
                       "and the picture and the sound keep the offset they had "
                       "(%.3f s in, %.3f s out)", wasV - wasA, isV - isA);
            } else {
                check(false, "both streams read back for the sync comparison");
            }
        }

        // A copied picture beside an encoded soundtrack: two paths into one
        // muxer, interleaved by the writer that was already there.
        if (srcAudio >= 0) {
            ExportSettings mixed = baseSettings("out/copy-plus-encode.mp4");
            mixed.inputs = {in};
            mixed.faststart = false;
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:" + std::to_string(srcVideo);
            v.copyTo = kSpan;
            ExportStream a;
            a.kind = "audio";
            a.source = "mix";
            mixed.streams = {v, a};
            std::vector<ExportClip> one{leftHalf(first, srcDuration)};
            one[0].input = 0;
            st = render(mixed, one);
            checkf(st.state == ExportStatus::State::Done,
                   "a copied picture and an encoded soundtrack write one file (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());
            {
                Opened o(mixed.path);
                const bool two = o && o.fc->nb_streams == 2;
                checkf(two, "with both streams in it");
                if (two) {
                    check(o.fc->streams[0]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO &&
                              o.fc->streams[1]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO,
                          "in the order the list asked for");
                    check(o.fc->streams[1]->codecpar->codec_id == AV_CODEC_ID_AAC,
                          "the sound encoded as aac");
                }
                const auto copied = packetsOf(mixed.path, 0);
                size_t same = 0;
                for (size_t i = 0; i < copied.size() && i < before.size(); ++i)
                    if (before[i].data == copied[i].data) ++same;
                checkf(!copied.empty() && same == copied.size(),
                       "and the picture still byte for byte what it was (%zu packets)",
                       copied.size());
            }
        }

        // The refusals. Every one of these produces a file that is technically
        // valid and not what was asked for if it is allowed through.
        ExportSettings bad;
        bad.path = "out/copy-never.mp4";
        bad.format = "mp4";
        bad.inputs = {in};
        bad.startTime = 0;
        bad.endTime = 1.0;

        // **One input stream copied into two output streams.** `-map 0:1 -map
        // 0:1` is a legal thing to ask ffmpeg for, and two rows differing only
        // in their disposition is the reason somebody would — a track that is
        // default and a duplicate of it that is not. Nothing in the UI produces
        // it today, which is why the tap search giving every packet to the
        // *last* matching tap had never been noticed: the first output stream
        // came out empty and the file was valid.
        {
            ExportSettings twice = bad;
            twice.path = "out/copy-twice.mp4";
            twice.endTime = 1.0;
            ExportStream a1;
            a1.kind = "video";
            a1.source = "copy:0:" + std::to_string(srcVideo);
            a1.copyTo = kSpan;
            a1.disposition = "+default";
            ExportStream a2 = a1;
            a2.disposition = "0";
            twice.streams = {a1, a2};
            st = render(twice, {});
            checkf(st.state == ExportStatus::State::Done,
                   "one input stream copied into two output streams runs (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());
            if (st.state == ExportStatus::State::Done) {
                const auto one = packetsOf(twice.path, 0);
                const auto two = packetsOf(twice.path, 1);
                checkf(!one.empty() && one.size() == two.size(),
                       "and both of them have the packets (%zu and %zu)", one.size(),
                       two.size());
                size_t alike = 0;
                for (size_t i = 0; i < one.size() && i < two.size(); ++i)
                    if (one[i].data == two[i].data) ++alike;
                checkf(!one.empty() && alike == one.size(),
                       "byte for byte the same packets (%zu of %zu)", alike, one.size());
            }
        }

        ExportSettings noStream = bad;
        {
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:99";
            noStream.streams.push_back(v);
        }
        st = render(noStream, {});
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("99") != std::string::npos,
               "a stream the input does not have is refused by number (%s)", st.error.c_str());

        if (srcAudio >= 0) {
            ExportSettings wrongKind = bad;
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:" + std::to_string(srcAudio);
            wrongKind.streams.push_back(v);
            st = render(wrongKind, {});
            checkf(st.state == ExportStatus::State::Failed &&
                       st.error.find("audio") != std::string::npos,
                   "a sound stream copied into a video row is refused (%s)", st.error.c_str());
        }

        ExportSettings withCodec = bad;
        {
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:" + std::to_string(srcVideo);
            v.codec = "libx264";
            withCodec.streams.push_back(v);
        }
        st = render(withCodec, {});
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("libx264") != std::string::npos,
               "and an encoder named on a copied stream is refused rather than ignored (%s)",
               st.error.c_str());

        ExportSettings junkSource = bad;
        {
            ExportStream v;
            v.kind = "video";
            v.source = "copy:nonsense";
            junkSource.streams.push_back(v);
        }
        st = render(junkSource, {});
        check(st.state == ExportStatus::State::Failed,
              "a copy source that is not one is refused");

        // A container that will not hold the codec, said where the decision is
        // rather than at write_header. WebM holds VP8/VP9/AV1 and not H.264.
        ExportSettings wrongBox = bad;
        wrongBox.path = "out/copy-never.webm";
        wrongBox.format = "webm";
        {
            ExportStream v;
            v.kind = "video";
            v.source = "copy:0:" + std::to_string(srcVideo);
            wrongBox.streams.push_back(v);
        }
        st = render(wrongBox, {});
        checkf(st.state == ExportStatus::State::Failed &&
                   st.error.find("webm") != std::string::npos,
               "a container that will not hold the copied codec says so (%s)",
               st.error.c_str());
    }

    // ── where the render goes ──────────────────────────────────────────────
    //
    // A destination stopped being one file. Four muxers here write something
    // else and each is a different shape of "else": `segment` and `image2`
    // write a numbered run, `hls` writes a run and a playlist that names it,
    // `tee` writes the same packets to several places at once. None of them is
    // a second kind of render — they are muxers, chosen by name like any other
    // — so what is checked is that the *reporting* follows: how many files
    // arrived, how big they came to, and whether what came out opens.

    std::printf("\na destination that is a set of files, and a playlist that names them\n");
    {
        std::error_code fec;
        for (int i = 0; i < 64; ++i) {
            char n[64];
            std::snprintf(n, sizeof(n), "out/seg-%03d.ts", i);
            std::filesystem::remove(n, fec);
        }
        std::filesystem::remove("out/seg.m3u8", fec);

        ExportSettings sg = baseSettings("out/seg-%03d.ts");
        sg.format = "segment";
        sg.faststart = false;
        // A segment can only start on a keyframe, and this renderer's default
        // GOP is two seconds — longer than the whole test render, so without
        // this the segmenter has exactly one place it is allowed to cut.
        sg.videoOptions.push_back({"g", "10"});
        sg.formatOptions.push_back({"segment_time", "0.4"});
        sg.formatOptions.push_back({"segment_format", "mpegts"});
        sg.formatOptions.push_back({"segment_list", "out/seg.m3u8"});
        sg.formatOptions.push_back({"segment_list_type", "m3u8"});
        const ExportStatus seg = render(sg, {leftHalf(first, srcDuration)});
        checkf(seg.state == ExportStatus::State::Done, "a segmented render finishes (%s)",
               seg.error.empty() ? "no error" : seg.error.c_str());

        // Four segments of 0.4 s over 1.6 s, plus the playlist. Counted as
        // libavformat opened them, which is the only count that does not have
        // to know how this muxer numbers anything.
        checkf(seg.piecesWritten >= 4, "it says how many files it opened (%lld)",
               (long long)seg.piecesWritten);
        checkf(seg.bytesWritten > 4096,
               "and how big the run came to, which stat'ing the path could not answer (%lld)",
               (long long)seg.bytesWritten);

        std::ifstream listIn(std::filesystem::path("out/seg.m3u8"));
        const std::string list((std::istreambuf_iterator<char>(listIn)),
                               std::istreambuf_iterator<char>());
        check(list.rfind("#EXTM3U", 0) == 0, "the playlist is a playlist");
        check(list.find("seg-000.ts") != std::string::npos &&
              list.find("seg-001.ts") != std::string::npos,
              "and it names the segments that were written");

        int named = 0, onDisk = 0;
        size_t at = 0;
        while ((at = list.find("seg-", at)) != std::string::npos) {
            const size_t end = list.find(".ts", at);
            if (end == std::string::npos) break;
            const std::string name = list.substr(at, end - at + 3);
            ++named;
            if (std::filesystem::exists(std::filesystem::path("out/" + name))) ++onDisk;
            at = end;
        }
        checkf(named > 1 && named == onDisk,
               "every segment the playlist names is on disk (%d of %d)", onDisk, named);
        checkf(seg.piecesWritten == named + 1,
               "and the count is the segments plus the playlist (%lld for %d)",
               (long long)seg.piecesWritten, named);

        // Opened back through the playlist, which is what "open the result"
        // means for a segmented render: the segments are pieces of one thing
        // and only the playlist says which order they go in.
        const Opened back("out/seg.m3u8");
        check(!!back, "the playlist opens as media");
        if (back) {
            const int v = av_find_best_stream(back.fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            checkf(v >= 0, "with a video stream in it (%u streams)", back.fc->nb_streams);
            const double dur = back.fc->duration > 0
                                   ? back.fc->duration / double(AV_TIME_BASE) : 0.0;
            checkf(dur > kSpan * 0.5,
                   "and the whole render's length rather than one segment's (%.2fs of %.2fs)",
                   dur, kSpan);
        }
        // The first segment on its own is also a file — which is the other
        // half of what a segmenter is for, and the reason the count matters.
        const Opened one("out/seg-000.ts");
        check(!!one, "and one segment opens on its own");
    }

    std::printf("\nhls: the same again, with the playlist as the thing you name\n");
    {
        std::error_code fec;
        std::filesystem::remove("out/hls.m3u8", fec);
        for (int i = 0; i < 32; ++i) {
            char n[64];
            std::snprintf(n, sizeof(n), "out/hls%d.ts", i);
            std::filesystem::remove(n, fec);
        }

        ExportSettings sh = baseSettings("out/hls.m3u8");
        sh.format = "hls";
        sh.faststart = false;
        sh.videoOptions.push_back({"g", "10"});
        sh.formatOptions.push_back({"hls_time", "0.4"});
        sh.formatOptions.push_back({"hls_list_size", "0"});
        const ExportStatus h = render(sh, {leftHalf(first, srcDuration)});
        checkf(h.state == ExportStatus::State::Done, "an hls render finishes (%s)",
               h.error.empty() ? "no error" : h.error.c_str());
        checkf(h.bytesWritten > 4096, "the run has bytes in it (%lld)",
               (long long)h.bytesWritten);

        // **Counted against the playlist, exactly.** What this has to catch is
        // `hls` rewriting its playlist on every segment: `>= 2` passes at forty,
        // and forty is exactly what an `io_open` hook that did not treat a file
        // opened twice as one file would report for four segments.
        //
        // It is the segments and not the segments plus one, and that one is a
        // fact about hlsenc worth knowing: **it writes the playlist through a
        // temporary name and renames it**, so the file that *is* `path` — and is
        // therefore not a piece — reaches `io_open` as `out/hls.m3u8.tmp`, which
        // is not `path` and used to be counted as an extra segment. `finish()`
        // folds a working name onto the file it became by asking the filesystem
        // which of them is still there, so a build whose hlsenc writes the
        // playlist in place answers the same number with nothing to fold.
        {
            std::ifstream listIn(std::filesystem::path("out/hls.m3u8"));
            const std::string list((std::istreambuf_iterator<char>(listIn)),
                                   std::istreambuf_iterator<char>());
            int named = 0;
            size_t at = 0;
            while ((at = list.find("hls", at)) != std::string::npos) {
                const size_t end = list.find(".ts", at);
                if (end == std::string::npos) break;
                ++named;
                at = end + 3;
            }
            checkf(named > 1 && h.piecesWritten == named,
                   "each segment is counted once and the playlist not at all "
                   "(%lld pieces for %d segments)",
                   (long long)h.piecesWritten, named);
        }
        const Opened back("out/hls.m3u8");
        check(!!back, "and what it wrote opens through the playlist it named");
        if (back)
            check(av_find_best_stream(back.fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0) >= 0,
                  "with a video stream in it");
    }

    std::printf("\none render, several destinations\n");
    {
        std::error_code fec;
        std::filesystem::remove("out/tee-a.mkv", fec);
        std::filesystem::remove("out/tee-b.ts", fec);

        // **`tee` is one encode to several places, which is why it is the
        // muxer and not two writers.** Two writers would be two encoders on the
        // same frames: twice the work for a file that is supposed to be the
        // same bytes in a different wrapper.
        ExportSettings te = baseSettings("[f=matroska]out/tee-a.mkv|[f=mpegts]out/tee-b.ts");
        te.format = "tee";
        te.faststart = false;
        const ExportStatus t = render(te, {leftHalf(first, srcDuration)});
        checkf(t.state == ExportStatus::State::Done, "a tee render finishes (%s)",
               t.error.empty() ? "no error" : t.error.c_str());
        checkf(t.piecesWritten == 2, "both destinations are counted (%lld)",
               (long long)t.piecesWritten);
        check(std::filesystem::exists(std::filesystem::path("out/tee-a.mkv")) &&
              std::filesystem::exists(std::filesystem::path("out/tee-b.ts")),
              "and both are on disk");

        const Opened a("out/tee-a.mkv");
        const Opened b("out/tee-b.ts");
        check(!!a && !!b, "both open");
        if (a && b) {
            const int av = av_find_best_stream(a.fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            const int bv = av_find_best_stream(b.fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            check(av >= 0 && bv >= 0, "both carry the picture");
            if (av >= 0 && bv >= 0) {
                const auto pa = packetsOf("out/tee-a.mkv", av);
                const auto pb = packetsOf("out/tee-b.ts", bv);
                checkf(!pa.empty() && pa.size() == pb.size(),
                       "and the same packets reached both (%zu and %zu)", pa.size(), pb.size());
            }
        }

        // The picture, not just the plumbing: a tee destination has to be the
        // render, and the cheapest way to say so is to decode one and look.
        VideoPipeline teePipe;
        check(teePipe.open("out/tee-a.mkv"), "ffmpeg-bro can open a tee destination");
        teePipe.advanceTo(static_cast<TimeNs>(kSpan * 0.5 * 1e9));
        if (teePipe.hasFrame()) {
            const auto& tpx = teePipe.currentRgba();
            const double empty = meanLuma(tpx, kW, kH, kW / 2 + 8, 0, kW, kH);
            const double filled = brightestIn(tpx, kW, kH, 0, 0, kW / 2 - 8, kH);
            checkf(empty >= 0 && empty < 6.0 && filled > 24.0,
                   "and it is the render, in the rectangle the clip was given "
                   "(empty %.2f, filled %.0f)", empty, filled);
        } else {
            check(false, "a frame decodes out of a tee destination");
        }
    }

    std::printf("\na destination that is not on this machine\n");
    {
        // **Against a real listener, in this process.** A UDP socket bound
        // before the render starts is the only version of this check that
        // proves anything: writing to a port nobody is on succeeds, silently,
        // whatever is wrong with the protocol plumbing.
        bool haveUdp = false;
        {
            void* it = nullptr;
            const char* name = nullptr;
            while ((name = avio_enum_protocols(&it, 1)))
                if (std::string(name) == "udp") haveUdp = true;
        }
        checkf(haveUdp, "this build has the udp output protocol");

        if (haveUdp) {
            const std::string url = "udp://127.0.0.1:45231";
            AVIOContext* rx = nullptr;
            AVDictionary* ropt = nullptr;
            // Microseconds, and it is what stops the reader thread from
            // outliving the render: there is no end-of-stream on a datagram
            // socket, so the read has to give up on its own.
            av_dict_set(&ropt, "timeout", "2000000", 0);
            av_dict_set(&ropt, "buffer_size", "1048576", 0);
            const int ro = avio_open2(&rx, url.c_str(), AVIO_FLAG_READ, nullptr, &ropt);
            av_dict_free(&ropt);
            checkf(ro >= 0, "a listener binds on the loopback (%s)",
                   ro >= 0 ? "bound" : "could not bind");

            if (ro >= 0) {
                std::vector<uint8_t> got;
                std::thread reader([&] {
                    uint8_t buf[4096];
                    for (;;) {
                        const int n = avio_read(rx, buf, sizeof(buf));
                        if (n <= 0) break;
                        if (got.size() < (1u << 20)) got.insert(got.end(), buf, buf + n);
                    }
                });

                ExportSettings sn = baseSettings(url);
                sn.format = "mpegts";
                sn.faststart = false;
                // A protocol option, in the same bag the muxer's travel in —
                // which is what the reading end already does, and the reason
                // the bag is split by asking the muxer which keys are its own.
                sn.formatOptions.push_back({"pkt_size", "1316"});
                const ExportStatus n = render(sn, {leftHalf(first, srcDuration)});
                checkf(n.state == ExportStatus::State::Done,
                       "a render to udp:// finishes (%s)",
                       n.error.empty() ? "no error" : n.error.c_str());
                // There is no file, so there is nothing to stat: what a socket
                // can say is what went through it.
                checkf(n.bytesWritten > 4096, "and reports what it sent (%lld bytes)",
                       (long long)n.bytesWritten);
                checkf(n.piecesWritten == 0,
                       "one destination, so nothing beside it was opened (%lld)",
                       (long long)n.piecesWritten);

                reader.join();
                avio_closep(&rx);
                checkf(got.size() > 4096, "and the listener received it (%zu bytes)", got.size());
                check(!got.empty() && got[0] == 0x47,
                      "starting with an MPEG-TS sync byte, which is what was asked for");
            }
        }

        // A destination that is not there. This is the failure a file cannot
        // have, and the only thing worth checking about it here is that it
        // arrives as a refusal naming the URL rather than as a message about a
        // filename — which is what `avio_open` gives you and is the least
        // useful place to find out that a protocol is missing or a port is
        // closed. What happens *after* a connection drops mid-render is the
        // protocol's business and is reported, not handled: there is no
        // reconnect here, and `-reconnect`/`-rw_timeout` are ordinary options.
        {
            ExportSettings gone = baseSettings("tcp://127.0.0.1:45999");
            gone.format = "mpegts";
            gone.faststart = false;
            const ExportStatus g = render(gone, {leftHalf(first, srcDuration)});
            checkf(g.state == ExportStatus::State::Failed &&
                       g.error.find("tcp://127.0.0.1:45999") != std::string::npos,
                   "a destination nothing is listening on is refused, naming it (%s)",
                   g.error.c_str());
            check(g.error.find("cannot reach") != std::string::npos,
                  "and says it could not be reached rather than could not be opened");
        }

        // **A destination that is allowed to go away.** The same closed port,
        // with the muxer wrapped in a `fifo` — which is a real test of the
        // recovery loop and needs nothing listening anywhere, because what is
        // asserted is what happens while the far end is *not* there.
        //
        // Bounded on purpose, and both bounds matter. **`dropOnOverflow` is
        // what makes this end at all**, and it is the only mode the Write stage
        // offers for exactly this reason: `fifo_thread_recover` loops on
        // `AVERROR(EAGAIN)` while it is off, so a blocking fifo whose
        // destination never comes up retries for ever while the render thread
        // waits inside `av_interleaved_write_frame` on a full queue — and Stop
        // is checked once per output frame, so it never arrives. Measured at
        // twenty seconds of a four-second render, with a cancel that did
        // nothing. And the protocol's own `timeout` is set because on this
        // platform libav does not learn quickly that a port is closed:
        // `ff_poll_interrupt` sits until tcp's own `open_timeout`, five seconds.
        {
            ExportSettings keep = baseSettings("tcp://127.0.0.1:45999");
            keep.format = "mpegts";
            keep.faststart = false;
            keep.fifo.on = true;
            keep.fifo.maxAttempts = 2;
            keep.fifo.waitSeconds = 0.1;
            keep.fifo.dropOnOverflow = true;
            keep.formatOptions.push_back({"timeout", "300000"});   // µs, tcp's own
            const ExportStatus k = render(keep, {leftHalf(first, srcDuration)});
            // It fails — nothing was ever there — but not at the *start*: the
            // fifo opens the destination on its own thread, so the render runs,
            // queues, retries and reports at the end. That change of moment is
            // the trade the setting asks for and is stated in the manual.
            //
            // **libav will not say this on its own.** `fifo_write_trailer` hands
            // back whatever its consumer thread's trailer returned, which for a
            // header that was never written is zero — so without the writer's
            // own account of what it opened, a render that reached nothing at all
            // comes back `Done`. That is the exact failure this whole setting is
            // arranged against, which is why it is asserted rather than assumed.
            checkf(k.state == ExportStatus::State::Failed,
                   "a wrapped render to a closed port still fails in the end (%s)",
                   k.error.c_str());
            checkf(k.error.find("never reached") != std::string::npos,
                   "and says it never reached the destination rather than reporting success");
            // **The recovery loop ran**, which is the whole claim, and it is
            // counted out of what the muxer said rather than out of anything
            // libav publishes — see `WriteRecovery` in ffmpeg_report.h. Nothing
            // else in this binary says those words, so a non-zero count here
            // cannot have come from anywhere but the fifo.
            const WriteRecovery r = writeRecovery();
            checkf(r.failed >= 1,
                   "and the fifo's own attempts are counted: %lld failed, %lld recovered",
                   (long long)r.failed, (long long)r.recovered);
            // The unwrapped render of the same URL above was refused before a
            // frame was made; this one was not, and that difference is the
            // feature rather than a detail of it.
            checkf(k.error.find("no_such") == std::string::npos,
                   "and the failure is about the destination rather than about an option (%s)",
                   k.error.c_str());
        }

        // An option nothing takes is an error, at this end too. The muxer did
        // not know it and neither did the protocol, and a render that wrote a
        // file while ignoring what it was told is the outcome every option bag
        // in this binary is arranged to prevent.
        ExportSettings junk = baseSettings("out/dest-never.mkv");
        junk.format = "matroska";
        junk.formatOptions.push_back({"no_such_protocol_option", "1"});
        const ExportStatus jr = render(junk, {leftHalf(first, srcDuration)});
        checkf(jr.state == ExportStatus::State::Failed &&
                   jr.error.find("no_such_protocol_option") != std::string::npos,
               "an option neither the muxer nor the protocol has is refused, named (%s)",
               jr.error.c_str());
    }

    // ── subtitles ───────────────────────────────────────────────────────────
    //
    // Three separate claims, and the second is the one that is easy to fake.
    // A soft track has to arrive in the file with the words and the moments it
    // went in with; a burn-in has to change the picture *at the cue and nowhere
    // else*, which is the only measurement that distinguishes "the filter ran"
    // from "the filter drew something"; and a conversion has to produce the
    // other format's syntax rather than its input again.
    {
        std::printf("\nsubtitles\n");
        const std::filesystem::path fixtures = std::filesystem::path(first).parent_path();
        const std::filesystem::path srt = fixtures / "cues.srt";
        const std::filesystem::path ass = fixtures / "cues.ass";
        // **A skip, not a failure.** Every suite here runs standalone against
        // any real file — that is what the standalone command lines in
        // CLAUDE.md and docs/manual/testing.md are for — and a real file is not
        // sitting beside a `cues.srt` this repository generated. Under `ctest`
        // the fixtures are always there and the whole section runs; pointed at
        // somebody's footage it says what it is not doing rather than failing
        // at it.
        const bool haveCues = std::filesystem::exists(srt) && std::filesystem::exists(ass);
        if (!haveCues)
            std::printf("  SKIP  no cues.srt/cues.ass beside %s — the subtitle sections "
                        "want the generated fixtures\n", first.c_str());

        const auto sencs = availableSubtitleEncoders();
        std::string names;
        for (const auto& e : sencs) names += (names.empty() ? "" : " ") + e.id;
        checkf(!sencs.empty(), "%zu subtitle encoders, discovered: %s", sencs.size(),
               names.c_str());
        auto encoderNamed = [&](const char* want) {
            for (const auto& e : sencs) if (e.id == want) return true;
            return false;
        };
        check(encoderNamed("mov_text") && encoderNamed("ass") && encoderNamed("webvtt") &&
                  encoderNamed("srt"),
              "including the four formats everything else converts between");
        for (const auto& e : sencs) {
            if (e.id == "ass")
                check(e.textSub, "ass is reported as text");
            if (e.id == "dvdsub")
                check(!e.textSub, "and dvdsub as pictures of it");
        }
        // What the muxer *declares* and what it *answers* are different facts,
        // and mp4 is the whole reason this matters: it declares no subtitle
        // codec at all in this build.
        for (const auto& m : availableMuxers()) {
            if (m.name == "mp4") {
                checkf(m.subtitleCodec == "mov_text",
                       "mp4's subtitle codec is worked out from what it answers, not from "
                       "what it declares (declares '%s', answers '%s')",
                       m.defaultSubtitle.c_str(), m.subtitleCodec.c_str());
            }
            // `ssa` and `ass` are one codec under two encoder names — both are
            // `AV_CODEC_ID_ASS` and both are `assenc.c` — so which of the two
            // `avcodec_find_encoder` hands back is registry order and not a
            // decision. Either is the right answer; a third would not be.
            if (m.name == "matroska")
                checkf(m.subtitleCodec == "ass" || m.subtitleCodec == "ssa",
                       "matroska declares the ASS encoder (%s)", m.subtitleCodec.c_str());
            if (m.name == "webm")
                checkf(std::find(m.subtitleCodecs.begin(), m.subtitleCodecs.end(), "webvtt") !=
                           m.subtitleCodecs.end(),
                       "and WebM holds webvtt");
        }

        if (haveCues) {
            const double srcDur = srcDuration;

            // A soft track beside the picture, out of a file that is not the
            // video. Two inputs, one of them a subtitle file, which is the
            // ordinary shape: `ffmpeg -i clip.mp4 -i cues.srt -c:s mov_text`.
            const std::string outSub = "out/export-subs.mp4";
            ExportSettings ss = baseSettings(outSub);
            ss.format = "mp4";
            ss.inputs = {MediaInput{}, MediaInput{}};
            ss.inputs[0].path = first;
            ss.inputs[1].path = srt.string();
            ss.endTime = 9.0;
            ExportStream sv;
            sv.kind = "video";
            sv.source = "composite";
            ExportStream sst;
            sst.kind = "subtitle";
            sst.source = "decode:1:0";
            sst.language = "eng";
            sst.disposition = "+default";
            ss.streams = {sv, sst};
            ExportClip whole = leftHalf(first, srcDur);
            whole.input = 0;
            whole.length = 9.0;
            whole.w = kW;
            st = render(ss, {whole});
            checkf(st.state == ExportStatus::State::Done,
                   "an .srt beside the picture writes a soft subtitle track (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());

            if (st.state == ExportStatus::State::Done) {
                Opened f(outSub);
                check(!!f, "and the result opens");
                int subIdx = -1;
                if (f)
                    for (unsigned i = 0; i < f.fc->nb_streams; ++i)
                        if (f.fc->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE)
                            subIdx = int(i);
                checkf(subIdx >= 0, "with a subtitle stream in it (index %d)", subIdx);
                if (subIdx >= 0) {
                    AVStream* sst2 = f.fc->streams[subIdx];
                    checkf(sst2->codecpar->codec_id == AV_CODEC_ID_MOV_TEXT,
                           "encoded as mov_text, which is what mp4 holds (%s)",
                           avcodec_get_name(sst2->codecpar->codec_id));
                    checkf(meta(sst2, "language") == "eng", "carrying its language (%s)",
                           meta(sst2, "language").c_str());
                    check((sst2->disposition & AV_DISPOSITION_DEFAULT) != 0,
                          "and the default flag it was given");
                }

                const auto cues = cuesOf(outSub);
                checkf(cues.size() == 3, "all three cues are in the file (%zu)", cues.size());
                if (cues.size() == 3) {
                    // The times the fixture was written with, to a frame.
                    // Anything that lost the offset — an output zero taken from
                    // the wrong end, a millisecond/second mix-up — lands
                    // nowhere near these.
                    checkf(std::fabs(cues[0].from - 1.0) < 0.05 &&
                               std::fabs(cues[0].to - 2.0) < 0.05,
                           "the first at 1.00→2.00 s (%.2f→%.2f)", cues[0].from, cues[0].to);
                    checkf(std::fabs(cues[1].from - 4.0) < 0.05 &&
                               std::fabs(cues[1].to - 5.5) < 0.05,
                           "the second at 4.00→5.50 s (%.2f→%.2f)", cues[1].from, cues[1].to);
                    checkf(std::fabs(cues[2].from - 7.0) < 0.05,
                           "the third at 7.00 s (%.2f)", cues[2].from);
                    check(mentions(cues[0].text, "first cue") &&
                              mentions(cues[1].text, "second cue") &&
                              mentions(cues[2].text, "third cue"),
                          "and each says what it said in the .srt");
                    check(mentions(cues[1].text, "and its second line"),
                          "including the cue that is two lines long");
                }
            }

            // The same file into Matroska as ASS, which is the conversion that
            // has a header: the styles live in the encoder's `subtitle_header`
            // and not in the cues, so a stream whose extradata is empty is one
            // that kept every line of dialogue and lost how all of it looks.
            const std::string outMkv = "out/export-subs.mkv";
            ExportSettings ms = ss;
            ms.path = outMkv;
            ms.format = "matroska";
            ms.faststart = false;
            ms.streams[1].codec = "ass";
            ms.streams[1].language = "fra";
            st = render(ms, {whole});
            checkf(st.state == ExportStatus::State::Done,
                   "the same cues go into Matroska as ass (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());
            if (st.state == ExportStatus::State::Done) {
                Opened f(outMkv);
                int subIdx = -1;
                if (f)
                    for (unsigned i = 0; i < f.fc->nb_streams; ++i)
                        if (f.fc->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE)
                            subIdx = int(i);
                if (subIdx >= 0) {
                    AVStream* a = f.fc->streams[subIdx];
                    checkf(a->codecpar->codec_id == AV_CODEC_ID_ASS, "as ass (%s)",
                           avcodec_get_name(a->codecpar->codec_id));
                    const std::string header(
                        reinterpret_cast<const char*>(a->codecpar->extradata
                                                          ? a->codecpar->extradata
                                                          : reinterpret_cast<const uint8_t*>("")),
                        a->codecpar->extradata_size > 0 ? size_t(a->codecpar->extradata_size) : 0);
                    checkf(mentions(header, "[Script Info]") && mentions(header, "Style:"),
                           "with the style header the decoder handed over (%d bytes)",
                           a->codecpar->extradata_size);
                    checkf(meta(a, "language") == "fre" || meta(a, "language") == "fra",
                           "and its language (%s)", meta(a, "language").c_str());
                }
                const auto cues = cuesOf(outMkv);
                checkf(cues.size() == 3 && mentions(cues[1].text, "second cue"),
                       "and all three cues (%zu)", cues.size());
            }

            // **A styled track and the font it names, in one file.** This is
            // the whole reason an attachment stream exists: an ASS style says
            // `Arial` and carries nothing of it, so a player without that font
            // substitutes and every line moves. The two are written together
            // here because that is the only arrangement worth checking —
            // either alone already worked and neither alone is useful.
            {
                const std::string fontPath = "out/export-subs-font.ttf";
                {
                    std::ofstream f(fontPath, std::ios::binary);
                    f << "not a real font, but a real attachment";
                }
                const std::string outFont = "out/export-subs-font.mkv";
                ExportSettings fs = ms;
                fs.path = outFont;
                ExportStream att;
                att.kind = "attachment";
                att.path = fontPath;
                att.mimeType = "font/ttf";
                fs.streams.push_back(att);
                st = render(fs, {whole});
                checkf(st.state == ExportStatus::State::Done,
                       "an ass track travels with the font it names (%s)",
                       st.error.empty() ? "no error" : st.error.c_str());
                Opened f(outFont);
                int nSub = 0, nAtt = 0;
                if (f)
                    for (unsigned i = 0; i < f.fc->nb_streams; ++i) {
                        const AVMediaType t = f.fc->streams[i]->codecpar->codec_type;
                        if (t == AVMEDIA_TYPE_SUBTITLE) ++nSub;
                        if (t == AVMEDIA_TYPE_ATTACHMENT) ++nAtt;
                    }
                checkf(nSub == 1 && nAtt == 1,
                       "and both are streams the muxer numbered (%d subtitle, %d attachment)",
                       nSub, nAtt);
            }

            // A sidecar: a render whose only stream is a subtitle track. There
            // is no canvas, no mix, no encoder and no frame clock — the cues
            // drive the job — and this is what "extract the subtitles" is.
            const std::string outVtt = "out/export-subs.vtt";
            ExportSettings vs;
            vs.path = outVtt;
            vs.format = "webvtt";
            vs.inputs = {MediaInput{}};
            vs.inputs[0].path = srt.string();
            ExportStream vst;
            vst.kind = "subtitle";
            vst.source = "decode:0:0";
            vs.streams = {vst};
            st = render(vs, {});
            checkf(st.state == ExportStatus::State::Done,
                   "a subtitle track on its own writes a sidecar with no picture in it (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());
            const std::string vtt = fileText(outVtt);
            checkf(mentions(vtt, "WEBVTT") && mentions(vtt, "00:01.000 --> 00:02.000") &&
                       mentions(vtt, "first cue") && mentions(vtt, "third cue"),
                   "in WebVTT's own syntax, with the times it went in with (%zu bytes)",
                   vtt.size());
            // The round trip: what came out is a file that opens as subtitles
            // and says the same three things. A conversion that wrote its input
            // back out unchanged would pass every check above and fail this one
            // — `.vtt` read as SubRip would not parse at all.
            const auto back = cuesOf(outVtt);
            checkf(back.size() == 3 && std::fabs(back[1].from - 4.0) < 0.05,
                   "and reads back as three cues on the same clock (%zu)", back.size());

            // **An input's window moves the cues with it.** `-ss 3` on the
            // subtitle input makes three seconds in the input's zero, so the
            // cue written at 00:00:04 is one second into the output and the one
            // at 00:00:01 is not in the input at all.
            //
            // Two clocks meet here and they used to be different ones: the seek
            // was made in the input's own seconds and the comparison that
            // decides whether a cue is inside the window was made against the
            // container's raw presentation time. Nothing showed it because
            // every other render in this suite leaves the window alone, where
            // the two agree — which is precisely the shape of bug that reaches
            // a person as "the subtitles are late by however far I trimmed".
            {
                const std::string outWin = "out/export-subs-window.vtt";
                ExportSettings ws = vs;
                ws.path = outWin;
                ws.inputs[0].ss = 3.0;
                st = render(ws, {});
                checkf(st.state == ExportStatus::State::Done,
                       "an -ss on a subtitle input renders (%s)",
                       st.error.empty() ? "no error" : st.error.c_str());
                const auto win = cuesOf(outWin);
                checkf(win.size() == 2,
                       "and drops the cue that is before the window (%zu of 3 cues)",
                       win.size());
                if (win.size() == 2) {
                    checkf(std::fabs(win[0].from - 1.0) < 0.05,
                           "with the 4 s cue one second into the output (%.2f)", win[0].from);
                    checkf(std::fabs(win[0].to - 2.5) < 0.05,
                           "for as long as it was on screen (%.2f)", win[0].to);
                    checkf(std::fabs(win[1].from - 4.0) < 0.05,
                           "and the 7 s cue four seconds in (%.2f)", win[1].from);
                }
            }

            // `-itsoffset` is the same arithmetic with the other sign: it
            // delays the input, so every cue arrives later by exactly it.
            {
                const std::string outLate = "out/export-subs-late.vtt";
                ExportSettings ls = vs;
                ls.path = outLate;
                ls.inputs[0].itsoffset = 2.0;
                st = render(ls, {});
                checkf(st.state == ExportStatus::State::Done,
                       "an -itsoffset on a subtitle input renders (%s)",
                       st.error.empty() ? "no error" : st.error.c_str());
                const auto late = cuesOf(outLate);
                checkf(late.size() == 3 && std::fabs(late[0].from - 3.0) < 0.05,
                       "and every cue is two seconds later (%zu cues, first at %.2f)",
                       late.size(), late.empty() ? -1.0 : late[0].from);
            }

            // The other direction, from the .ass fixture rather than from a
            // conversion of the .srt: the words differ between the two files
            // on purpose, so a render that read the wrong one is visible here.
            const std::string outSrt = "out/export-subs.srt";
            ExportSettings as = vs;
            as.path = outSrt;
            as.format = "srt";
            as.inputs[0].path = ass.string();
            st = render(as, {});
            checkf(st.state == ExportStatus::State::Done, "and .ass converts to .srt (%s)",
                   st.error.empty() ? "no error" : st.error.c_str());
            const std::string srtOut = fileText(outSrt);
            checkf(mentions(srtOut, "00:00:01,000 --> 00:00:02,000") &&
                       mentions(srtOut, "styled one") && mentions(srtOut, "styled three"),
                   "carrying the .ass file's own words rather than the .srt's (%zu bytes)",
                   srtOut.size());

            // A subtitle track carried through as packets. Nothing is decoded,
            // so this is the path that needed no encoder at all — and the only
            // thing worth asserting is that what came out is what went in.
            if (std::filesystem::exists(outMkv)) {
                const std::string outCopy = "out/export-subs-copy.mkv";
                ExportSettings cs;
                cs.path = outCopy;
                cs.format = "matroska";
                cs.faststart = false;
                cs.inputs = {MediaInput{}};
                cs.inputs[0].path = outMkv;
                const int wasAt = streamIndexOf(outMkv, AVMEDIA_TYPE_SUBTITLE);
                ExportStream cst;
                cst.kind = "subtitle";
                cst.source = "copy:0:" + std::to_string(wasAt);
                cs.streams = {cst};
                st = render(cs, {});
                checkf(st.state == ExportStatus::State::Done,
                       "an existing subtitle track is copied through with no encoder (%s)",
                       st.error.empty() ? "no error" : st.error.c_str());
                const auto before = cuesOf(outMkv);
                const auto after = cuesOf(outCopy);
                checkf(before.size() == after.size() && !after.empty() &&
                           before.front().text == after.front().text,
                       "with the same cues (%zu → %zu)", before.size(), after.size());
                // **And at the times they had.** A copy took its input's zero
                // from the first packet it read, which for a picture is the
                // start of the file and for a track of cues is the first thing
                // anybody says — so carrying an untrimmed subtitle track moved
                // every cue a second early here, and by a minute in a
                // programme where nobody speaks for a minute. Against a picture
                // that is encoded rather than copied, and so has no say in this
                // input's epoch, that is a desync out of the most ordinary
                // render there is: keep the video, keep the subtitles.
                checkf(!before.empty() && !after.empty() &&
                           std::fabs(before.front().from - after.front().from) < 0.05,
                       "and at the times they had, not rebased onto the first cue "
                       "(%.2f → %.2f)", before.empty() ? -1.0 : before.front().from,
                       after.empty() ? -1.0 : after.front().from);
            }

            // ── where the cues are, without decoding one ────────────────────
            //
            // The packet path's own answer, which is what a Write stage draws a
            // window against. Checked against times that were typed into
            // `make_fixture.cpp` rather than read out of anything, so a
            // conversion of the file cannot make this pass.
            {
                MediaInput sub;
                sub.path = srt.string();
                CueTimes ct;
                std::string cerr;
                const bool got = cueTimesOf(sub, -1, 0, 0, 0, &ct, &cerr);
                checkf(got && ct.cues.size() == 3,
                       "the cues are read off the packets, no decoder opened (%zu, %s)",
                       ct.cues.size(), got ? (ct.complete ? "complete" : "cut short")
                                           : cerr.c_str());
                if (ct.cues.size() == 3) {
                    checkf(std::fabs(ct.cues[1].start - 4.0) < 0.01 &&
                               std::fabs(ct.cues[1].end - 5.5) < 0.01,
                           "with the times the fixture was written with (%.2f → %.2f)",
                           ct.cues[1].start, ct.cues[1].end);
                    checkf(ct.cues[1].bytes > ct.cues[0].bytes,
                           "and the payload's size, which is how an empty sample is told "
                           "from a line (%d against %d)", ct.cues[1].bytes, ct.cues[0].bytes);
                }
                // A window bounds what is listed. It is deliberately *not* what
                // a copy would take — see below — and the difference is the
                // whole reason the UI asks for the track and not for a window.
                CueTimes win;
                // Filled before it is reported: the order the arguments of a
                // variadic call are evaluated in is unspecified, so a size read
                // in the message alongside the call that fills it printed the
                // empty list this had before it ran.
                const bool gotWin = cueTimesOf(sub, -1, 4.5, 0, 0, &win, &cerr);
                checkf(gotWin && win.cues.size() == 1,
                       "a window lists the cues inside it (%zu from 4.5 s)", win.cues.size());
                CueTimes none;
                MediaInput noSubs;
                noSubs.path = first;
                check(!cueTimesOf(noSubs, -1, 0, 0, 0, &none, &cerr),
                      "and a file with no subtitle stream is refused rather than answered "
                      "with an empty list");
            }

            // **A copied subtitle window starts at the cue, not at the moment.**
            // This is the keyframe story in subtitle vocabulary and it took a
            // render to establish: the copy seeks backward, so a track asked to
            // begin at 4.5 s begins at the cue that was on screen then — and
            // that cue's stamp, not 4.5, is what the output's zero becomes. A
            // *conversion* of the same two numbers drops it and zeroes at 4.5
            // exactly, which is a different file out of the same window and is
            // why the Write stage says which of the two a row is doing.
            if (std::filesystem::exists(outMkv)) {
                const std::string outMid = "out/export-subs-copy-mid.mkv";
                ExportSettings cs;
                cs.path = outMid;
                cs.format = "matroska";
                cs.faststart = false;
                cs.inputs = {MediaInput{}};
                cs.inputs[0].path = outMkv;
                ExportStream cst;
                cst.kind = "subtitle";
                cst.source = "copy:0:" +
                             std::to_string(streamIndexOf(outMkv, AVMEDIA_TYPE_SUBTITLE));
                cst.copyFrom = 4.5;
                cs.streams = {cst};
                st = render(cs, {});
                checkf(st.state == ExportStatus::State::Done,
                       "a copied subtitle track cut at 4.5 s renders (%s)",
                       st.error.empty() ? "no error" : st.error.c_str());
                const auto mid = cuesOf(outMid);
                checkf(mid.size() == 2,
                       "keeping the cue that was on screen at 4.5 s as well as the one "
                       "after it (%zu cues)", mid.size());
                if (mid.size() == 2)
                    checkf(std::fabs(mid[0].from) < 0.05,
                           "and that cue, not the moment asked for, is the output's zero "
                           "(%.2f s)", mid[0].from);
            }

            // ── burned in ──────────────────────────────────────────────────
            //
            // The one measurement that says a subtitle was *drawn*. Two renders
            // of the same seconds, one through `subtitles=` and one without, at
            // an instant the cue does not cover and at one it does: identical
            // outside it, and visibly different inside it. Either half alone
            // proves nothing — a filter that did nothing passes the first, and
            // a filter that changed every frame passes the second.
            const std::string outPlain = "out/export-burn-off.mp4";
            const std::string outBurn = "out/export-burn-on.mp4";
            ExportSettings bs = baseSettings(outPlain);
            bs.format = "mp4";
            bs.endTime = 3.0;
            bs.inputs = {MediaInput{}};
            bs.inputs[0].path = first;
            bs.includeAudio = false;
            bs.filterInputs = {{"0:v", first, "v", 0.0, 0}};
            char graph[1024];
            std::snprintf(graph, sizeof(graph),
                          "[0:v]scale=%d:%d,setsar=1[vout]", kW, kH);
            bs.filterGraph = graph;
            const ExportStatus plain = render(bs, {});
            std::snprintf(graph, sizeof(graph), "[0:v]scale=%d:%d,setsar=1,subtitles=%s[vout]",
                          kW, kH, filterPath(srt).c_str());
            bs.path = outBurn;
            bs.filterGraph = graph;
            const ExportStatus burned = render(bs, {});
            checkf(plain.state == ExportStatus::State::Done &&
                       burned.state == ExportStatus::State::Done,
                   "a subtitles filter is an ordinary node on the graph and renders (%s)",
                   burned.error.empty() ? "no error" : burned.error.c_str());

            if (plain.state == ExportStatus::State::Done &&
                burned.state == ExportStatus::State::Done) {
                VideoPipeline a, b;
                if (a.open(outPlain) && b.open(outBurn)) {
                    auto at = [&](double t) {
                        a.advanceTo(static_cast<TimeNs>(t * 1e9));
                        b.advanceTo(static_cast<TimeNs>(t * 1e9));
                        if (!a.hasFrame() || !b.hasFrame()) return -1.0;
                        return psnr(a.currentRgba(), b.currentRgba(), kW, kH);
                    };
                    const double before = at(0.4);
                    const double during = at(1.5);
                    std::printf("        0.4s: %.1f dB   1.5s: %.1f dB\n", before, during);
                    checkf(before > 38.0,
                           "and changes nothing before the cue begins (%.1f dB)", before);
                    checkf(during > 0 && during < 34.0,
                           "and draws over the picture while it is on (%.1f dB)", during);
                    checkf(before - during > 4.0,
                           "so the difference is the cue and not the encoder (%.1f dB apart)",
                           before - during);
                } else {
                    check(false, "both burn-in renders open for comparison");
                }
            }

            // ── what is refused ────────────────────────────────────────────
            //
            // There is no composed subtitle track, there is no OCR, and a
            // container that will not hold a codec says so before the file is
            // described rather than at `write_header`.
            ExportSettings ns = ss;
            ns.path = "out/export-subs-never.mp4";
            ns.streams[1].source = "composite";
            st = render(ns, {whole});
            checkf(st.state == ExportStatus::State::Failed &&
                       mentions(st.error, "decode:"),
                   "a subtitle stream fed from the composite is refused, saying what one is "
                   "fed from (%s)", st.error.c_str());

            ns = ss;
            ns.path = "out/export-subs-never.mp4";
            ns.streams[1].codec = "subrip";
            st = render(ns, {whole});
            checkf(st.state == ExportStatus::State::Failed &&
                       mentions(st.error, "subrip") && mentions(st.error, "mp4") &&
                       mentions(st.error, "mov_text"),
                   "and a codec the container will not hold is refused, saying what it does "
                   "hold (%s)", st.error.c_str());

            ns = ss;
            ns.path = "out/export-subs-never.mp4";
            ns.streams[1].source = "decode:0:0";
            st = render(ns, {whole});
            checkf(st.state == ExportStatus::State::Failed && mentions(st.error, "subtitle"),
                   "and a picture stream asked to be a subtitle track is refused (%s)",
                   st.error.c_str());
        }
    }

    // ── picture subtitles, drawn ────────────────────────────────────────────
    //
    // A `dvdsub` track cannot become text and cannot go through libass, and both
    // of those are refused by name elsewhere in this file. What it *can* do is be
    // drawn, because its cues are pictures and `overlay` draws pictures — and the
    // thing to know before reading any of this is that **libavfilter has no
    // subtitle input**. `[0:s]` reaching an overlay is ffmpeg's own sub2video
    // mechanism, and export_sub2video.h is that mechanism here.
    //
    // Three measurements, and the third is the one nothing else in this suite
    // would catch: identical before the cue, different while it is on, and
    // **identical again after it expires**. A graph that is never told the cue
    // ended goes on drawing it for the rest of the render, which passes the first
    // two checks and is the ordinary way this is got wrong.
    {
        std::printf("\npicture subtitles, drawn\n");
        const std::filesystem::path fixtures = std::filesystem::path(first).parent_path();
        const std::filesystem::path pictures = fixtures / "picture-cues.mkv";
        if (!std::filesystem::exists(pictures)) {
            std::printf("  SKIP  no picture-cues.mkv beside %s — drawing a bitmap cue wants "
                        "a bitmap track, which cannot be faked with content\n", first.c_str());
        } else {
            const std::string plainPath = "out/export-sub2video-off.mp4";
            const std::string drawnPath = "out/export-sub2video-on.mp4";
            ExportSettings ds = baseSettings(plainPath);
            ds.format = "mp4";
            ds.endTime = 3.0;
            ds.includeAudio = false;
            ds.inputs = {MediaInput{}};
            ds.inputs[0].path = pictures.string();
            ds.filterInputs = {{"0:v", pictures.string(), "v", 0.0, 0}};
            char graph[1024];
            std::snprintf(graph, sizeof(graph), "[0:v]scale=%d:%d,setsar=1[vout]", kW, kH);
            ds.filterGraph = graph;
            const ExportStatus without = render(ds, {});

            // The cue pad, wired the way a person would wire it on the Graph
            // stage and the way the command bar prints it. Two `filterInputs`
            // entries and one `-i`: the picture and the cues are two pads of one
            // input, which is what carrying the same index says.
            ds.path = drawnPath;
            ds.filterInputs.push_back({"0:s", pictures.string(), "s", 0.0, 0});
            std::snprintf(graph, sizeof(graph),
                          "[0:v]scale=%d:%d,setsar=1[base];[base][0:s]overlay[vout]", kW, kH);
            ds.filterGraph = graph;
            const ExportStatus withCues = render(ds, {});

            checkf(withCues.state == ExportStatus::State::Done,
                   "an input's subtitle pad feeds an overlay and the render goes through (%s)",
                   withCues.error.empty() ? "no error" : withCues.error.c_str());

            if (without.state == ExportStatus::State::Done &&
                withCues.state == ExportStatus::State::Done) {
                VideoPipeline a, b;
                if (a.open(plainPath) && b.open(drawnPath)) {
                    auto at = [&](double t) {
                        a.advanceTo(static_cast<TimeNs>(t * 1e9));
                        b.advanceTo(static_cast<TimeNs>(t * 1e9));
                        if (!a.hasFrame() || !b.hasFrame()) return -1.0;
                        return psnr(a.currentRgba(), b.currentRgba(), kW, kH);
                    };
                    // The fixture's cues are at 1–2, 4–5.5 and 7–8 s, so a
                    // three-second render has exactly one of them in it with
                    // clear air on both sides.
                    const double before = at(0.4);
                    const double during = at(1.5);
                    const double after = at(2.6);
                    std::printf("        0.4s: %.1f dB   1.5s: %.1f dB   2.6s: %.1f dB\n",
                                before, during, after);
                    checkf(before > 38.0,
                           "nothing is drawn before the cue begins (%.1f dB)", before);
                    checkf(during > 0 && during < 34.0,
                           "the cue's own picture is drawn while it is on (%.1f dB)", during);
                    checkf(after > 38.0,
                           "and the cue comes *off* when it expires, which is the frame a "
                           "sub2video that forgot would never send (%.1f dB)", after);
                } else {
                    check(false, "both sub2video renders open for comparison");
                }
            }

            // **A text track on a subtitle pad is refused, by name.** ffmpeg's
            // own sub2video takes one, warns per cue and paints nothing, which is
            // a render that succeeds with no subtitles in it; painting characters
            // is libass's job and the answer is the `subtitles` filter.
            const std::filesystem::path srtHere = fixtures / "cues.srt";
            if (std::filesystem::exists(srtHere)) {
                ExportSettings ts = ds;
                ts.path = "out/export-sub2video-never.mp4";
                ts.filterInputs.back() = {"0:s", srtHere.string(), "s", 0.0, -1};
                const ExportStatus text = render(ts, {});
                checkf(text.state == ExportStatus::State::Failed &&
                           mentions(text.error, "subrip") && mentions(text.error, "subtitles"),
                       "a text track on a subtitle pad is refused, naming the filter that "
                       "does draw one (%s)", text.error.c_str());
            }

            // And an unknown letter, because a pad is fed v, a or s and anything
            // else is a spec nothing can honour.
            ExportSettings us = ds;
            us.path = "out/export-sub2video-never.mp4";
            us.filterInputs.back().stream = "x";
            const ExportStatus unknown = render(us, {});
            checkf(unknown.state == ExportStatus::State::Failed &&
                       mentions(unknown.error, "0:s"),
                   "and a pad fed something that is not v, a or s is refused, naming it (%s)",
                   unknown.error.c_str());
        }
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
