// The GPU: what this machine has, whether it helps, and by how much.
//
// This suite is unlike the others here in that most of what it does is
// *measure*. Hardware acceleration is the corner of ffmpeg with the most
// folklore attached to it, and the only defensible way to decide whether this
// application should offer a path is to run it and compare. So the checks split
// in two:
//
//   - **Assertions**, which run everywhere and must pass on a machine with no
//     graphics card at all. Enumeration answers something; a device that is
//     reported present can actually be created and is shared rather than
//     remade; a device that does not exist refuses with a sentence rather than
//     failing obscurely; a codec the device cannot decode is refused at open
//     rather than at the first frame; and a hardware-decoded render produces
//     the same picture as the software one.
//   - **Measurements**, printed and never asserted on. A number that is a fact
//     about this machine is not a pass/fail — a build on a laptop with an
//     integrated GPU would fail a threshold that a workstation passes, and the
//     threshold would then be about the machine and not about the code. What
//     the numbers are for is README, and README names the machine they came
//     from.
//
// The equivalence check is the interesting assertion. **A hardware decoder is
// not bit-exact with a software one and is not required to be**: NVDEC, QSV and
// the CPU implement the same standard and differ in rounding, in deblocking
// arithmetic and in chroma siting, and every one of those is within what H.264
// permits. What is asserted is therefore a PSNR floor, and the floor is set
// where a *mistake* cannot reach: a frame out of step, a picture decoded
// upside-down or a chroma plane swapped all land well under 20 dB, while two
// conformant decoders of the same bitstream land in the fifties. The threshold
// here is 40 dB — far enough above a mistake to be meaningful, far enough below
// a perfect match to leave the arithmetic room it is entitled to.
//
// Usage: ffmpeg-bro-hwtest <media-file>

#include "export_source.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_export.h"
#include "ffmpeg_hardware.h"
#include "ffmpeg_input.h"

#include "video/video_pipeline.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavformat/avformat.h>
#include <libavutil/log.h>
#include <libavutil/pixdesc.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
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
    char buf[600];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    check(ok, buf);
}

/// A measurement. Printed, never asserted on — see the note at the top.
void measured(const char* what, double ms, int n) {
    std::printf("        %-46s %8.2f ms  (%d)\n", what, n ? ms / n : 0.0, n);
}

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

constexpr int kW = 640;
constexpr int kH = 360;
constexpr double kFps = 25.0;
constexpr double kSpan = 1.6;

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
    s.preset = "ultrafast";
    return s;
}

ExportClip wholeCanvas(int input) {
    ExportClip c;
    c.input = input;
    c.start = 0;
    c.length = kSpan;
    c.inPoint = 0;
    c.x = 0;
    c.y = 0;
    c.w = kW;
    c.h = kH;
    c.z = 0;
    return c;
}

/// The first device that can decode this file, or null.
///
/// Asked as two questions, because they fail differently and the second one is
/// the one people are surprised by: is there a working device of this type at
/// all, and does *this* build's decoder for *this* codec have a configuration
/// for it. A machine with two RTX 4090s still has no CUDA ProRes decoder.
const HwDevice* deviceThatDecodes(AVCodecID codec) {
    const AVCodec* dec = avcodec_find_decoder(codec);
    if (!dec) return nullptr;
    for (const auto& d : hwDevices()) {
        if (!d.present) continue;
        if (decoderTakesDevice(dec, hwTypeNamed(d.name), nullptr)) return &d;
    }
    return nullptr;
}

/// How long the whole of `in` takes to decode, and how far it got.
///
/// The measurement that decides the question. It walks the reader the way a
/// render does — `nextRaw`, forward, every frame — so what is being compared is
/// the decode and the readback and nothing else: no compositing, no scaling, no
/// encoder. `pictures` is handed back so that a run that decoded nothing cannot
/// look fast.
double timeDecode(const MediaInput& in, int* pictures) {
    SourceVideo v;
    std::string err;
    *pictures = 0;
    if (!v.open(in, &err)) {
        std::printf("        (cannot open: %s)\n", err.c_str());
        return -1.0;
    }
    const auto t0 = Clock::now();
    while (v.nextRaw()) ++*pictures;
    return msSince(t0);
}

} // namespace

int main(int argc, char* argv[]) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    av_log_set_level(AV_LOG_ERROR);

    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <media-file>\n", argv[0]);
        return 2;
    }
    registerFfmpegBackend();
    const std::string file = argv[1];
    std::filesystem::create_directories("out");

    // ── what this machine has ──────────────────────────────────────────────

    std::printf("\nHardware\n");
    const auto& devices = hwDevices();
    checkf(!devices.empty(), "this build reports hardware device types (%zu)", devices.size());

    int present = 0;
    for (const auto& d : devices) {
        const char* fmt = d.pixelFormat != AV_PIX_FMT_NONE
                              ? av_get_pix_fmt_name(d.pixelFormat) : "-";
        std::printf("        %-10s %-9s %-8s %2zu decoders  %2zu encoders  %2zu filters%s%s\n",
                    d.name.c_str(), d.present ? "present" : "absent", fmt,
                    d.decoders.size(), d.encoders.size(), d.filters.size(),
                    d.error.empty() ? "" : "  — ", d.error.c_str());
        if (d.present) ++present;
    }
    // **Not asserted to be non-zero.** A machine with no graphics card is a
    // machine this application has to work on, and a suite that failed there
    // would be asserting something about the hardware rather than about the
    // code. What *is* asserted is that a type reported present can be used and
    // a type reported absent refuses.
    std::printf("        %d of %zu types work on this machine\n", present, devices.size());

    for (const auto& d : devices) {
        if (!d.present) continue;
        std::string why;
        AVBufferRef* a = hwDeviceRef(d.name, "", &why);
        checkf(a != nullptr, "a %s device can be created (%s)", d.name.c_str(),
               a ? "yes" : why.c_str());
        AVBufferRef* b = hwDeviceRef(d.name, "", &why);
        // Two references to one context, not two contexts. A render with four
        // inputs and a filter graph would otherwise make six CUDA contexts, at
        // tens of milliseconds and a slab of card memory each.
        checkf(a && b && a->data == b->data,
               "and asking twice hands back the same %s device", d.name.c_str());
        if (a) av_buffer_unref(&a);
        if (b) av_buffer_unref(&b);
        checkf(d.pixelFormat != AV_PIX_FMT_NONE && isHwPixelFormat(d.pixelFormat),
               "%s frames are a device handle rather than pixels", d.name.c_str());
    }

    {
        std::string why;
        AVBufferRef* none = hwDeviceRef("no_such_device", "", &why);
        checkf(none == nullptr && why.find("no_such_device") != std::string::npos,
               "a device that does not exist refuses and names itself (%s)", why.c_str());
        if (none) av_buffer_unref(&none);
    }

    // ── a decode that asks for the impossible ──────────────────────────────
    //
    // The failure mode that matters: a hardware path that is unavailable at
    // runtime must refuse with a reason, at the moment of opening, not fail
    // obscurely half way through a render. Both shapes are checked, and both
    // are checkable on a machine with no card at all.

    std::printf("\nRefusals\n");
    {
        MediaInput in;
        in.path = file;
        in.hwaccel = "no_such_accel";
        SourceVideo v;
        std::string err;
        const bool opened = v.open(in, &err);
        checkf(!opened && err.find("no_such_accel") != std::string::npos,
               "an -hwaccel this build has never heard of refuses, naming it (%s)",
               err.c_str());
    }
    {
        // A type that is compiled in and absent. Every build here has more of
        // these than it has cards, so this is the ordinary case rather than a
        // contrived one — and on a machine where every type happens to work
        // there is nothing to check, which is why it is guarded.
        const HwDevice* missing = nullptr;
        for (const auto& d : devices) if (!d.present) { missing = &d; break; }
        if (missing) {
            MediaInput in;
            in.path = file;
            in.hwaccel = missing->name;
            SourceVideo v;
            std::string err;
            const bool opened = v.open(in, &err);
            // Naming it, for the reason the line above names its own: an empty
            // check on a non-empty string passes for "no such file", which is
            // what it did while the fixture path was wrong.
            checkf(!opened && err.find(missing->name) != std::string::npos,
                   "an -hwaccel %s this machine does not have refuses, naming it (%s)",
                   missing->name.c_str(), err.c_str());
        } else {
            std::printf("        (every compiled-in type works here; nothing absent to try)\n");
        }
    }

    // ── the picture, decoded on the card ───────────────────────────────────

    int videoCodec = AV_CODEC_ID_NONE, srcW = kW, srcH = kH;
    {
        AVFormatContext* fc = nullptr;
        if (avformat_open_input(&fc, file.c_str(), nullptr, nullptr) >= 0) {
            if (avformat_find_stream_info(fc, nullptr) >= 0) {
                const int i = av_find_best_stream(fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
                if (i >= 0) {
                    videoCodec = fc->streams[i]->codecpar->codec_id;
                    srcW = fc->streams[i]->codecpar->width;
                    srcH = fc->streams[i]->codecpar->height;
                }
            }
            avformat_close_input(&fc);
        }
    }
    const HwDevice* dev = deviceThatDecodes(static_cast<AVCodecID>(videoCodec));

    if (!dev) {
        std::printf("\nNo device on this machine decodes %s — the rest is skipped, "
                    "which is the whole point of it being a runtime question.\n",
                    avcodec_get_name(static_cast<AVCodecID>(videoCodec)));
        std::printf("\n%d checks, %d failures\n\n", g_checks, g_failures);
        return g_failures ? 1 : 0;
    }

    std::printf("\nDecoding %s on %s\n",
                avcodec_get_name(static_cast<AVCodecID>(videoCodec)), dev->name.c_str());

    // **A codec the device cannot decode is refused before a packet is read**,
    // which is the third of this file's refusals and the one people are
    // surprised by: two RTX 4090s still do not give you a CUDA FFV1 decoder.
    //
    // Asserting it needs a file in a codec nothing here decodes on a card, and
    // the fixtures are deliberately not that — they are H.264 so the rest of
    // this suite has something to measure. So one is written. FFV1 is native to
    // libavcodec, is in every build, and no vendor has ever shipped hardware
    // for it; the others are there in case a build somehow lacks the encoder.
    // Which of them qualifies is *asked* rather than assumed, because the whole
    // argument of this file is that capabilities are measured and not tabled.
    {
        const AVCodec* enc = nullptr;
        for (const char* name : {"ffv1", "prores", "mjpeg"}) {
            const AVCodec* c = avcodec_find_encoder_by_name(name);
            if (c && !deviceThatDecodes(c->id)) { enc = c; break; }
        }
        if (!enc) {
            std::printf("        (every codec tried decodes on a card here — "
                        "nothing for the refusal to be about)\n");
        } else {
            ExportSettings s = baseSettings("out/hw_nodecode.mkv");
            s.format = "matroska";
            s.videoCodec = enc->name;
            s.endTime = 0.4;
            {
                MediaInput in;
                in.path = file;
                s.inputs.push_back(in);
            }
            ExportClip c = wholeCanvas(0);
            c.length = s.endTime;
            const ExportStatus made = render(s, {c});
            checkf(made.state == ExportStatus::State::Done,
                   "a few frames of %s are written to compare against (%s)", enc->name,
                   made.error.empty() ? "no error" : made.error.c_str());

            MediaInput in;
            in.path = s.path;
            in.hwaccel = dev->name;
            SourceVideo v;
            std::string err;
            const bool opened = v.open(in, &err);
            // Named twice on purpose: the device and the codec are the two
            // halves of the answer, and "cannot decode" without either of them
            // is the message this refusal exists to be better than.
            checkf(!opened && err.find(dev->name) != std::string::npos &&
                       err.find(enc->name) != std::string::npos,
                   "and -hwaccel %s on a %s file refuses at open, naming both (%s)",
                   dev->name.c_str(), enc->name,
                   err.empty() ? "it opened, which it must not" : err.c_str());
        }
    }

    // ── the render, both ways ──────────────────────────────────────────────

    ExportSettings sw = baseSettings("out/hw_software.mp4");
    {
        MediaInput in;
        in.path = file;
        sw.inputs.push_back(in);
    }
    ExportStatus st = render(sw, {wholeCanvas(0)});
    checkf(st.state == ExportStatus::State::Done, "a software render finishes (%s)",
           st.error.empty() ? "no error" : st.error.c_str());

    ExportSettings hw = baseSettings("out/hw_hardware.mp4");
    {
        MediaInput in;
        in.path = file;
        in.hwaccel = dev->name;
        hw.inputs.push_back(in);
    }
    st = render(hw, {wholeCanvas(0)});
    checkf(st.state == ExportStatus::State::Done,
           "the same render with -hwaccel %s finishes (%s)", dev->name.c_str(),
           st.error.empty() ? "no error" : st.error.c_str());

    if (st.state == ExportStatus::State::Done) {
        VideoPipeline a, b;
        check(a.open("out/hw_software.mp4") && b.open("out/hw_hardware.mp4"),
              "both renders open for comparison");
        double worst = 99.0;
        for (double at : {0.3, 0.8, 1.3}) {
            a.advanceTo(static_cast<TimeNs>(at * 1e9));
            b.advanceTo(static_cast<TimeNs>(at * 1e9));
            if (!a.hasFrame() || !b.hasFrame()) { worst = -1.0; break; }
            const double db = psnr(a.currentRgba(), b.currentRgba(), kW, kH);
            std::printf("        %.1fs: %.1f dB\n", at, db);
            worst = std::min(worst, db);
        }
        // 40 dB, and the reasoning is at the top of this file: a hardware
        // decoder is entitled to differ from a software one in rounding and is
        // not entitled to differ in what the picture *is*. Every mistake that
        // could be made here — an off-by-one frame, a plane swapped, a
        // download that lost the colour tags — scores under twenty.
        checkf(worst > 40.0,
               "a %s decode produces the same picture as the CPU (%.1f dB)",
               dev->name.c_str(), worst);
    }

    // ── how much it costs ──────────────────────────────────────────────────
    //
    // Three walks over the same file, timed. This is the measurement README
    // reports, and it is the reason this chunk exists in the shape it does: the
    // interesting number is not "is the GPU fast" but "what does getting the
    // picture back cost", because everything downstream of a decode in this
    // application — the compositor, a software filter, bro's renderer — wants
    // pixels in system memory.

    std::printf("\nDecode, one pass over the file\n");
    {
        MediaInput soft;
        soft.path = file;
        int nSoft = 0;
        const double msSoft = timeDecode(soft, &nSoft);
        measured("software, threaded across all cores", msSoft, nSoft);

        MediaInput down;
        down.path = file;
        down.hwaccel = dev->name;
        int nDown = 0;
        const double msDown = timeDecode(down, &nDown);
        measured((dev->name + ", brought back to system memory").c_str(), msDown, nDown);

        MediaInput up;
        up.path = file;
        up.hwaccel = dev->name;
        up.hwaccelOutputFormat = dev->pixelFormat != AV_PIX_FMT_NONE
                                     ? av_get_pix_fmt_name(dev->pixelFormat) : "";
        int nUp = 0;
        const double msUp = timeDecode(up, &nUp);
        measured((dev->name + ", left on the card").c_str(), msUp, nUp);

        checkf(nSoft > 0 && nDown == nSoft,
               "every path decodes the same number of pictures (%d)", nSoft);
        checkf(nUp == nSoft, "including the one that never brings them down (%d)", nUp);
        if (msSoft > 0 && msDown > 0 && msUp > 0)
            std::printf("        readback is %.0f%% of the hardware decode's wall clock\n",
                        100.0 * (msDown - msUp) / msDown);
    }

    // ── the graph path, and the render that never comes down ───────────────
    //
    // The arrangement the whole chunk is about: decode on the card, filter on
    // the card, encode on the card. Only reachable where this build has the
    // filters and an encoder for this device, which is a runtime question and
    // therefore guarded.

    const bool haveUpload = std::find(dev->filters.begin(), dev->filters.end(),
                                      "hwupload") != dev->filters.end();
    std::string hwEncoder;
    for (const auto& e : dev->encoders)
        if (e.rfind("h264", 0) == 0) { hwEncoder = e; break; }
    if (hwEncoder.empty() && !dev->encoders.empty()) hwEncoder = dev->encoders.front();

    std::printf("\nThe graph, on the card\n");
    if (!haveUpload || hwEncoder.empty()) {
        std::printf("        (this build has no %s upload or no %s encoder — skipped)\n",
                    dev->name.c_str(), dev->name.c_str());
    } else {
        const std::string suffix = dev->name == "d3d11va" ? "d3d11" : dev->name;
        const std::string scaler = "scale_" + suffix;
        const bool haveScale = avfilter_get_by_name(scaler.c_str()) != nullptr;
        // **Not a failure, and worth printing rather than asserting.** A vcpkg
        // ffmpeg built with `nvcodec` gets NVDEC and NVENC and *not* the
        // `scale_cuda`/`overlay_cuda` family, which needs the CUDA compiler at
        // configure time. So a build can have a hardware decoder and a hardware
        // encoder and nothing at all to put between them, and the picture still
        // never has to come down: `trim` and `setpts` are arithmetic on
        // timestamps and pass any format through.
        std::printf("        %s: %s\n", scaler.c_str(),
                    haveScale ? "linked in" : "not in this build — nothing to resize with, "
                                              "so the chain is timestamps only");

        char graph[512];
        if (haveScale)
            std::snprintf(graph, sizeof(graph),
                          "[0:v]trim=0:%.3f,setpts=PTS-STARTPTS,%s=%d:%d[vout]",
                          kSpan, scaler.c_str(), kW, kH);
        else
            std::snprintf(graph, sizeof(graph),
                          "[0:v]trim=0:%.3f,setpts=PTS-STARTPTS[vout]", kSpan);

        ExportSettings g = baseSettings("out/hw_graph.mp4");
        // The graph says how big the picture is. It has to: nothing outside
        // libavfilter knows what size a chain of hardware frames comes out at,
        // and with no scaler in the build it is whatever the file was.
        g.sizeFromGraph = true;
        g.videoCodec = hwEncoder;
        // `preset` and `crf` are x264's words and NVENC has neither, so they
        // are cleared: an option an encoder does not have is an error here.
        g.preset.clear();
        g.crf = -1;
        g.includeAudio = false;
        MediaInput in;
        in.path = file;
        in.hwaccel = dev->name;
        in.hwaccelOutputFormat = dev->pixelFormat != AV_PIX_FMT_NONE
                                     ? av_get_pix_fmt_name(dev->pixelFormat) : "";
        g.inputs.push_back(in);
        g.filterGraph = graph;
        ExportGraphInput pad;
        pad.label = "0:v";
        pad.path = file;
        pad.stream = "v";
        pad.input = 0;
        g.filterInputs.push_back(pad);
        g.filterHwDevice = dev->name;

        const auto t0 = Clock::now();
        st = render(g, {});
        const double msGraph = msSince(t0);
        checkf(st.state == ExportStatus::State::Done,
               "a render that decodes, filters and encodes on the card finishes (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        if (st.state == ExportStatus::State::Done) {
            checkf(st.bytesWritten > 0, "and wrote %lld bytes",
                   (long long)st.bytesWritten);
            VideoPipeline p;
            checkf(p.open("out/hw_graph.mp4"), "and the result opens as media");
            measured("decode + scale + encode, never leaving the card", msGraph, 1);
        }

        // The same seconds, the same size, through the compositor and x264 —
        // which is the comparison the whole chunk turns on. It has to be the
        // *same size*: the graph above took its size from the source, so a
        // control render left at 640x360 would be the hardware path doing more
        // work and looking faster for it.
        ExportSettings cpu = baseSettings("out/hw_cpu.mp4");
        cpu.includeAudio = false;
        cpu.width = srcW;
        cpu.height = srcH;
        MediaInput plain;
        plain.path = file;
        cpu.inputs.push_back(plain);
        ExportClip whole = wholeCanvas(0);
        whole.w = srcW;
        whole.h = srcH;
        const auto t1 = Clock::now();
        st = render(cpu, {whole});
        const double msCpu = msSince(t1);
        checkf(st.state == ExportStatus::State::Done, "the same seconds through x264 (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
        measured("decode + composite + x264, all in system memory", msCpu, 1);

        // The third arrangement, and on this machine the interesting one:
        // decode on the CPU — where libavcodec's threaded decoder is faster
        // than NVDEC — and *upload* to the encoder. The picture crosses the bus
        // once, in the direction that is not the readback, and the encoder
        // still never sees system memory.
        ExportSettings mix = baseSettings("out/hw_upload.mp4");
        mix.videoCodec = hwEncoder;
        mix.preset.clear();
        mix.crf = -1;
        mix.includeAudio = false;
        mix.sizeFromGraph = true;
        MediaInput soft;
        soft.path = file;
        mix.inputs.push_back(soft);
        char up[512];
        std::snprintf(up, sizeof(up),
                      "[0:v]trim=0:%.3f,setpts=PTS-STARTPTS,format=nv12,hwupload[vout]", kSpan);
        mix.filterGraph = up;
        mix.filterInputs.push_back(pad);
        mix.filterHwDevice = dev->name;
        const auto t2 = Clock::now();
        st = render(mix, {});
        const double msUpload = msSince(t2);
        checkf(st.state == ExportStatus::State::Done,
               "a software decode uploaded straight into %s finishes (%s)", hwEncoder.c_str(),
               st.error.empty() ? "no error" : st.error.c_str());
        measured("decode on the CPU, upload, encode on the card", msUpload, 1);

        if (msCpu > 0 && msGraph > 0 && msUpload > 0)
            std::printf("        %dx%d, %.1f s of output — against x264: on the card %.2fx, "
                        "uploaded %.2fx\n",
                        srcW, srcH, kSpan, msCpu / msGraph, msCpu / msUpload);
    }

    // ── the arrangement that must refuse ───────────────────────────────────
    //
    // A picture that stays on the card and a software encoder is a download per
    // frame done quietly on behalf of a render that asked for the opposite.
    // What it does instead is bring the picture down through the graph's own
    // path and encode it normally — which is slower and *correct*, and the
    // check is that it still produces a file rather than an error.

    if (haveUpload) {
        std::printf("\nA hardware graph into a software encoder\n");
        char graph[512];
        // `format=nv12` on both sides, and neither is decoration. A device's
        // surfaces hold one of a short list of layouts and `hwupload` will not
        // negotiate its way to one, so the picture has to be in it before it
        // goes up; coming back down, `hwdownload` produces whatever the surface
        // held and the next filter has to be told to expect it. libavfilter's
        // own message for missing either names a pixel format and no filter.
        std::snprintf(graph, sizeof(graph),
                      "[0:v]trim=0:%.3f,setpts=PTS-STARTPTS,format=nv12,hwupload,"
                      "hwdownload,format=nv12,scale=%d:%d[vout]", kSpan, kW, kH);
        ExportSettings g = baseSettings("out/hw_mixed.mp4");
        g.includeAudio = false;
        MediaInput in;
        in.path = file;
        g.inputs.push_back(in);
        g.filterGraph = graph;
        ExportGraphInput pad;
        pad.label = "0:v";
        pad.path = file;
        pad.stream = "v";
        pad.input = 0;
        g.filterInputs.push_back(pad);
        g.filterHwDevice = dev->name;
        st = render(g, {});
        checkf(st.state == ExportStatus::State::Done,
               "a graph that uploads and downloads again renders through x264 (%s)",
               st.error.empty() ? "no error" : st.error.c_str());
    }

    std::printf("\n%d checks, %d failures\n\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
