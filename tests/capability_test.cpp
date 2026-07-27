// What this build can write, read, reach and capture — asked of libav, and
// checked here for shape rather than for content.
//
// Every list below comes out of a registry walk, so what these assertions are
// really about is the walk being done correctly: that a muxer's extensions are
// split rather than handed over as one string, that a name a picker will put in
// `-f` is the name libavformat answers to, that the flags a picker groups by
// are read off the right bits, and that the option tables are the muxer's own
// and not the last thing that happened to be asked for.
//
// **The numbers are printed, not asserted.** How many muxers a build has
// depends on how it was configured, and a test that demanded a hundred and
// eighty would fail on a smaller build for no reason worth failing over. What
// is asserted is that the things this application needs are there and that
// nothing came back malformed.
//
// The last section renders into a muxer that is not mp4 and opens the result,
// because the whole value of a picker over a hundred and eighty of them is that
// what it offers can actually be written — and until this chunk the renderer
// picked its muxer from the filename, so "which muxer" was not a thing a render
// could be told at all.
//
// Usage: ffmpeg-bro-captest [<media-file>]

#include "ffmpeg_backend.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavformat/avformat.h>
}

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <set>
#include <string>
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

const MuxerOption* muxer(const std::vector<MuxerOption>& list, const std::string& name) {
    for (const auto& m : list) if (m.name == name) return &m;
    return nullptr;
}

bool has(const std::vector<std::string>& list, const std::string& what) {
    return std::find(list.begin(), list.end(), what) != list.end();
}

bool hasOption(const std::vector<OptionInfo>& list, const std::string& name) {
    for (const auto& o : list) if (o.name == name) return true;
    return false;
}

/// A short line naming a few entries, so a failure on another build says what
/// that build actually had rather than only that it disagreed.
std::string few(const std::vector<std::string>& list, size_t n = 8) {
    std::string out;
    for (size_t i = 0; i < list.size() && i < n; ++i) out += (i ? " " : "") + list[i];
    if (list.size() > n) out += " …";
    return out;
}

} // namespace

int main(int argc, char** argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    // Through the same call the application makes, because that is what
    // registers libavdevice — and a device missing from the list here would be
    // a device missing from the app for exactly the same reason.
    registerFfmpegBackend();

    // ── muxers ─────────────────────────────────────────────────────────────

    std::printf("\nmuxers\n");
    const auto muxers = availableMuxers();
    checkf(muxers.size() > 20, "%zu muxers reported", muxers.size());

    std::set<std::string> names;
    bool wellFormed = true;
    for (const auto& m : muxers) {
        // Named, so a failure says which entry is wrong. A registry walk that
        // has gone astray goes astray on one format, and "some muxer is
        // malformed" is not something anybody can act on.
        auto wrong = [&](const char* why) {
            wellFormed = false;
            std::printf("        %-16s %s\n", m.name.empty() ? "(unnamed)" : m.name.c_str(), why);
        };
        if (m.name.empty() || m.label.empty()) wrong("has no name or no label");
        if (!names.insert(m.name).second) wrong("appears twice");
        // The first extension is the one a filename gets, so a muxer with
        // extensions and no `ext` would silently name every file after the
        // format before it.
        if (!m.extensions.empty() && m.ext != m.extensions.front()) wrong("ext is not the first one");
        for (const auto& e : m.extensions)
            if (e.empty() || e.find(',') != std::string::npos) wrong("extensions were not split");
    }
    check(wellFormed, "every muxer has a unique name, a label and split extensions");

    const MuxerOption* mp4 = muxer(muxers, "mp4");
    const MuxerOption* mkv = muxer(muxers, "matroska");
    const MuxerOption* ts = muxer(muxers, "mpegts");
    checkf(mp4 && mkv && ts, "mp4, matroska and mpegts are all in the list");
    if (!mp4 || !mkv || !ts) {
        std::printf("\nthis build cannot be tested further\n");
        return 1;
    }

    checkf(mp4->ext == "mp4" && mkv->ext == "mkv",
           "the muxer's first extension is what a file should be called (mp4 → .%s, "
           "matroska → .%s)", mp4->ext.c_str(), mkv->ext.c_str());
    // The four-entry table this replaced said "mkv"; nothing in libavformat is
    // called that, which is the shortest statement of why a muxer is chosen by
    // name and not by extension.
    check(!muxer(muxers, "mkv"), "there is no muxer called 'mkv' — the name is 'matroska'");

    checkf(has(mp4->videoCodecs, "libx264"),
           "mp4 holds x264, asked of avformat_query_codec (%zu of the offered video codecs)",
           mp4->videoCodecs.size());
    checkf(mkv->videoCodecs.size() > mp4->videoCodecs.size(),
           "matroska holds more of them than mp4 does (%zu vs %zu) — the question is being "
           "asked per muxer rather than answered once",
           mkv->videoCodecs.size(), mp4->videoCodecs.size());
    const MuxerOption* webm = muxer(muxers, "webm");
    if (webm)
        check(!has(webm->audioCodecs, "aac") && has(webm->audioCodecs, "libopus") &&
                  !has(webm->videoCodecs, "libx264"),
              "WebM holds Opus and VP9 and refuses AAC and x264");

    checkf(!ts->videoCodecs.empty() && !ts->videoCodec.empty(),
           "mpegts offers an encoder this build has (%s), though it asks for %s by default",
           ts->videoCodec.c_str(), ts->defaultVideo.c_str());

    // The facts a picker groups by. Asserting they are non-empty rather than
    // naming members: which muxers are devices depends on the platform.
    size_t stills = 0, noFile = 0, devices = 0, extensionless = 0;
    std::vector<std::string> stillNames, deviceNames;
    for (const auto& m : muxers) {
        if (m.stills) { stills++; stillNames.push_back(m.name); }
        if (m.noFile) noFile++;
        if (m.device) { devices++; deviceNames.push_back(m.name); }
        if (m.extensions.empty()) extensionless++;
    }
    checkf(stills > 0, "%zu muxers write pictures and no sound: %s", stills,
           few(stillNames).c_str());
    checkf(noFile > 0, "%zu write through a protocol rather than a file they open", noFile);
    checkf(extensionless > 0, "%zu have no extension at all — which is why the picker "
                              "cannot be a list of extensions", extensionless);
    std::printf("       output devices: %s\n",
                deviceNames.empty() ? "(none on this platform)" : few(deviceNames).c_str());

    std::printf("\nmuxer options\n");
    const auto mp4Opts = muxerOptions("mp4");
    checkf(hasOption(mp4Opts, "movflags"), "mp4 reports its own options (%zu, movflags among them)",
           mp4Opts.size());
    check(hasOption(mp4Opts, "avoid_negative_ts"),
          "and the generic AVFormatContext ones, which reach it the same way");
    const auto tsOpts = muxerOptions("mpegts");
    checkf(!tsOpts.empty() && hasOption(tsOpts, "mpegts_service_id"),
           "mpegts reports a different table (%zu), so the walk is the muxer's and not a cache",
           tsOpts.size());
    check(muxerOptions("no-such-muxer").empty(), "a muxer that is not there has no options");

    // ── demuxers ───────────────────────────────────────────────────────────

    std::printf("\ndemuxers\n");
    const auto demuxers = availableDemuxers();
    checkf(demuxers.size() > 20, "%zu demuxers reported", demuxers.size());
    bool demuxersWellFormed = true;
    for (const auto& d : demuxers)
        if (d.name.empty()) demuxersWellFormed = false;
    check(demuxersWellFormed, "every demuxer has a name");

    const auto movOpts = demuxerOptions("mp4");
    // Demuxer names are comma-separated alternatives — the mov demuxer answers
    // to "mp4", "mov" and four more — which is exactly what `-f` accepts, so
    // asking by any of them has to work.
    checkf(!movOpts.empty(), "the mov/mp4 demuxer answers to 'mp4' and reports %zu options",
           movOpts.size());
    check(hasOption(movOpts, "fflags"),
          "including the generic ones, which is where -fflags +genpts lives");

    // ── protocols ──────────────────────────────────────────────────────────

    std::printf("\nprotocols\n");
    const auto protocols = availableProtocols();
    checkf(has(protocols.input, "file"), "%zu input protocols: %s",
           protocols.input.size(), few(protocols.input, 12).c_str());
    checkf(has(protocols.output, "file"), "%zu output protocols: %s",
           protocols.output.size(), few(protocols.output, 12).c_str());
    check(protocols.input.size() > protocols.output.size(),
          "there are more ways in than out, which is why they are asked for separately");
    for (const char* net : {"https", "rtmp", "srt", "tcp", "udp"})
        std::printf("       %-6s in:%s out:%s\n", net,
                    has(protocols.input, net) ? "yes" : "no ",
                    has(protocols.output, net) ? "yes" : "no");

    const auto fileOpts = protocolOptions("file");
    checkf(!fileOpts.empty(), "even 'file' has options (%zu)", fileOpts.size());
    check(protocolOptions("no-such-protocol").empty(), "an unknown protocol has none");

    // ── devices ────────────────────────────────────────────────────────────

    std::printf("\ndevices\n");
    const auto devs = availableDevices();
    // avdevice_register_all() was never called anywhere in this repo, so this
    // list was empty by construction and gdigrab was linked and unreachable.
    checkf(!devs.empty(), "%zu capture/playback devices", devs.size());
    for (const auto& d : devs)
        std::printf("       %-10s %-6s %-6s %s\n", d.name.c_str(), d.kind.c_str(),
                    d.direction.c_str(), d.longName.c_str());

    bool devicesConsistent = true;
    for (const auto& d : devs) {
        if (d.direction != "input") continue;
        const auto it = std::find_if(demuxers.begin(), demuxers.end(),
                                     [&](const DemuxerOption& x) { return x.name == d.name; });
        if (it == demuxers.end() || !it->device) devicesConsistent = false;
    }
    check(devicesConsistent,
          "every input device is also in the demuxer list, flagged as one");

    const auto bogus = deviceSources("no-such-device");
    check(!bogus.ok && !bogus.error.empty(),
          "asking a device that is not there for its sources is a reason, not an empty list");

    // Asked for real, because this is the one query in the file that talks to
    // hardware and the failure mode is a driver rather than a mistake here.
    // What is asserted is coherence, never that anything is plugged in: a
    // machine with no camera is not a broken build.
    bool sourcesCoherent = true;
    for (const auto& d : devs) {
        if (d.direction != "input") continue;
        const auto list = deviceSources(d.name);
        if (!list.ok) {
            // ENOSYS is the ordinary answer — gdigrab takes a rectangle, not a
            // device name — and it has to arrive as a reason.
            if (list.error.empty() || !list.sources.empty()) sourcesCoherent = false;
            std::printf("       %-10s %s\n", d.name.c_str(), list.error.c_str());
            continue;
        }
        for (const auto& s : list.sources) if (s.name.empty()) sourcesCoherent = false;
        std::printf("       %-10s lists %zu source%s\n", d.name.c_str(), list.sources.size(),
                    list.sources.size() == 1 ? "" : "s");
    }
    check(sourcesCoherent,
          "and every device either lists sources that can be named, or says why not");

    // ── decoders ───────────────────────────────────────────────────────────

    std::printf("\ndecoders\n");
    const auto decoders = availableDecoders();
    checkf(decoders.size() > 50, "%zu decoders reported", decoders.size());
    size_t video = 0, audio = 0, subtitle = 0, hw = 0;
    bool haveH264 = false;
    for (const auto& d : decoders) {
        if (d.type == "video") video++;
        else if (d.type == "audio") audio++;
        else if (d.type == "subtitle") subtitle++;
        if (d.hardware) hw++;
        if (d.name == "h264") haveH264 = true;
    }
    checkf(haveH264, "h264 among them; %zu video, %zu audio, %zu subtitle, %zu hardware",
           video, audio, subtitle, hw);
    checkf(subtitle > 0, "subtitle decoders are reported too, which is chunk 14's list");

    const auto h264Opts = decoderOptions("h264");
    checkf(hasOption(h264Opts, "skip_frame"),
           "h264 reports %zu decoder options, -skip_frame among them", h264Opts.size());
    check(!hasOption(h264Opts, "crf"),
          "and not the encoder's, because the walk requires the decoding flag");
    check(decoderOptions("libx264").empty(),
          "an encoder name is not a decoder name");

    // ── writing into one of them ───────────────────────────────────────────
    //
    // The point of the whole chunk: a muxer chosen by name, written, and opened
    // again. Two of them, because one file that happens to work says nothing
    // about the choice being honoured — an mpegts written to a path called
    // `.ts` would look identical whether or not `-f` reached the writer.

    if (argc < 2) {
        std::printf("\nno media given; the render section needs a file\n");
        std::printf("\n%d/%d checks passed\n", g_checks - g_failures, g_checks);
        return g_failures == 0 ? 0 : 1;
    }

    std::printf("\nrendering into a muxer that is not mp4\n");
    std::error_code ec;
    std::filesystem::create_directories("out", ec);

    struct Target { const char* format; const char* path; const char* vcodec; const char* acodec; };
    const Target targets[] = {
        // Matroska with a codec pair mp4 will not take, so the file is
        // unambiguously the muxer that was asked for.
        {"matroska", "out/cap-matroska.mkv", "libx264", "libopus"},
        {"mpegts",   "out/cap-mpegts.ts",    "libx264", "ac3"},
    };

    for (const auto& t : targets) {
        if (!avcodec_find_encoder_by_name(t.vcodec) || !avcodec_find_encoder_by_name(t.acodec)) {
            std::printf("  SKIP  %s: this build has no %s/%s\n", t.format, t.vcodec, t.acodec);
            continue;
        }
        ExportSettings s;
        s.path = t.path;
        s.format = t.format;
        s.width = 320;
        s.height = 180;
        s.fps = 25;
        s.startTime = 0;
        s.endTime = 1.0;
        s.videoCodec = t.vcodec;
        s.audioCodec = t.acodec;
        s.crf = 30;
        s.preset = "ultrafast";

        ExportClip c;
        c.path = argv[1];
        c.start = 0;
        c.length = 1.0;
        c.w = 320;
        c.h = 180;

        std::string err;
        if (!startExport(s, {c}, &err)) {
            checkf(false, "%s render refused: %s", t.format, err.c_str());
            continue;
        }
        waitForExport();
        const ExportStatus st = exportStatus();
        checkf(st.state == ExportStatus::State::Done, "%s render finished%s%s", t.format,
               st.error.empty() ? "" : ": ", st.error.c_str());
        if (st.state != ExportStatus::State::Done) continue;

        AVFormatContext* fc = nullptr;
        if (avformat_open_input(&fc, t.path, nullptr, nullptr) < 0 || !fc) {
            checkf(false, "%s: what was written will not open", t.format);
            continue;
        }
        const std::string got = fc->iformat && fc->iformat->name ? fc->iformat->name : "";
        // The demuxer's name is a comma-separated list of what it answers to,
        // so a substring is the honest test: matroska's demuxer is called
        // "matroska,webm".
        checkf(got.find(t.format) != std::string::npos,
               "%s: opened again and libavformat calls it '%s'", t.format, got.c_str());
        checkf(fc->nb_streams == 2, "%s: both streams are in it", t.format);
        avformat_close_input(&fc);
    }

    // A muxer this build does not have is a refusal with the name in it, not a
    // file quietly written as something else.
    {
        ExportSettings s;
        s.path = "out/cap-nonsense.bin";
        s.format = "not-a-muxer";
        s.width = 320; s.height = 180; s.fps = 25; s.endTime = 0.4;
        ExportClip c;
        c.path = argv[1]; c.length = 0.4; c.w = 320; c.h = 180;
        std::string err;
        bool refused = false;
        if (startExport(s, {c}, &err)) {
            waitForExport();
            const ExportStatus st = exportStatus();
            refused = st.state == ExportStatus::State::Failed &&
                      st.error.find("not-a-muxer") != std::string::npos;
            err = st.error;
        } else {
            refused = err.find("not-a-muxer") != std::string::npos;
        }
        checkf(refused, "a muxer this build has not got is refused by name (%s)", err.c_str());
    }

    std::printf("\n%d/%d checks passed\n", g_checks - g_failures, g_checks);
    return g_failures == 0 ? 0 : 1;
}
