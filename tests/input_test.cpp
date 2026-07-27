// An input is an `-i`: what is opened, how it is opened, and which part of it
// is used.
//
// Everything in this binary that opens a demuxer goes through `openInput()`,
// which is the point: there is one place a forced format is looked up, one
// place an option bag becomes an `AVDictionary`, and one place an option
// nothing consumed becomes a refusal. So what is asserted here is that opening
// is *told* rather than assumed —
//
//   - a demuxer can be forced, and a name this build does not have is an error
//     rather than a quiet fall back to probing;
//   - an option reaches the demuxer, and **an unknown one stops the open and
//     names itself**, which is the whole of why options are worth having: a
//     probe that succeeded while ignoring what it was told would be worse than
//     one that failed;
//   - `-ss` and `-t` move the input's own clock, so what a reader calls zero is
//     where the input starts and not where the file does — the difference
//     between an input seek and a clip's in-point, made in pixels;
//   - a registered input resolves through a token, which is how the same
//     options reach playback through a `<video src>` that is only a string.
//
// Usage: ffmpeg-bro-inputtest <media-file>

#include "ffmpeg_backend.h"
#include "ffmpeg_export.h"
#include "ffmpeg_input.h"
#include "export_frame.h"
#include "export_source.h"

#include "video/media_backend.h"
#include "video/media_source.h"

extern "C" {
#include <libavformat/avformat.h>
}

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace ffmpegbro;

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
    std::printf("  %s  %s\n", ok ? "PASS" : "FAIL", what.c_str());
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

MediaInput of(const std::string& path) {
    MediaInput in;
    in.path = path;
    return in;
}

/// The mean absolute difference between two RGBA pictures, 0..255. Zero is the
/// same picture; the fixture is a bar moving over a gradient, so two moments a
/// second apart are nowhere near it.
double differ(const Rgba& a, const Rgba& b) {
    if (a.width != b.width || a.height != b.height) return 255.0;
    double sum = 0;
    size_t n = 0;
    for (int y = 0; y < a.height; ++y) {
        const uint8_t* pa = a.data.data() + size_t(y) * a.stride;
        const uint8_t* pb = b.data.data() + size_t(y) * b.stride;
        for (int x = 0; x < a.width * 4; ++x) {
            sum += std::abs(int(pa[x]) - int(pb[x]));
            n++;
        }
    }
    return n ? sum / double(n) : 255.0;
}

Rgba copyOf(const Rgba* p) {
    Rgba out;
    if (!p) return out;
    out.resize(p->width, p->height);
    std::memcpy(out.data.data(), p->data.data(), p->data.size());
    return out;
}

} // namespace

int main(int argc, char* argv[]) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) {
        std::printf("usage: ffmpeg-bro-inputtest <media-file>\n");
        return 2;
    }
    const std::string file = argv[1];
    registerFfmpegBackend();

    std::printf("\nopening one, plainly\n");
    {
        AVFormatContext* fmt = nullptr;
        std::string err;
        const bool ok = openInput(&fmt, of(file), &err);
        checkf(ok, "a path with nothing said about it opens (%s)",
               ok ? "ok" : err.c_str());
        if (ok) {
            checkf(fmt->nb_streams > 0, "and find_stream_info has run: %u streams",
                   fmt->nb_streams);
            avformat_close_input(&fmt);
        }
    }

    std::printf("\nthe demuxer, forced\n");
    {
        // What the file probes as, so the forced name below is this build's own
        // rather than one written down here.
        const ProbeResult probed = probeMedia(file);
        check(probed.ok && !probed.formatName.empty(),
              "the file probes as '" + probed.formatName + "'");

        // libavformat reports several names for one demuxer — "mov,mp4,m4a,…"
        // — and `-f` takes the whole string, which is what a picker offers.
        MediaInput forced = of(file);
        forced.format = probed.formatName;
        AVFormatContext* fmt = nullptr;
        std::string err;
        const bool ok = openInput(&fmt, forced, &err);
        checkf(ok, "forcing that demuxer opens the same file (%s)", ok ? "ok" : err.c_str());
        if (ok) {
            check(fmt->iformat && probed.formatName == fmt->iformat->name,
                  "and it is the demuxer that was asked for");
            avformat_close_input(&fmt);
        }

        MediaInput missing = of(file);
        missing.format = "no-such-demuxer";
        fmt = nullptr;
        err.clear();
        check(!openInput(&fmt, missing, &err),
              "a demuxer name this build does not have is refused");
        check(err.find("no-such-demuxer") != std::string::npos,
              "and the refusal names it: " + err);
        check(fmt == nullptr, "and leaves nothing open behind it");

        // A demuxer that is real and is not this file's. Forcing it means
        // "read it as this", and the header does not agree — which is a
        // failure and not a silent fall back to probing.
        MediaInput wrong = of(file);
        wrong.format = "wav";
        fmt = nullptr;
        err.clear();
        const bool opened = openInput(&fmt, wrong, &err);
        checkf(!opened, "forcing the wrong demuxer fails rather than probing anyway (%s)",
               opened ? "it opened" : err.c_str());
        if (fmt) avformat_close_input(&fmt);
    }

    std::printf("\noptions reach the demuxer, and an unknown one is an error\n");
    {
        // `probesize` is libavformat's own generic option, so it is there
        // whatever this build's demuxer set is — which is what makes it the
        // right one to check the route with.
        MediaInput sized = of(file);
        sized.options.push_back({"probesize", "5000000"});
        sized.options.push_back({"analyzeduration", "5000000"});
        AVFormatContext* fmt = nullptr;
        std::string err;
        const bool ok = openInput(&fmt, sized, &err);
        checkf(ok, "-probesize and -analyzeduration are taken (%s)", ok ? "ok" : err.c_str());
        if (fmt) avformat_close_input(&fmt);

        MediaInput bogus = of(file);
        bogus.options.push_back({"probesize", "5000000"});
        bogus.options.push_back({"no_such_option", "1"});
        fmt = nullptr;
        err.clear();
        check(!openInput(&fmt, bogus, &err), "an option nothing consumed stops the open");
        check(err.find("no_such_option") != std::string::npos,
              "and the refusal names the key, not the file: " + err);
        check(err.find("probesize") == std::string::npos,
              "and names only the key nothing took");
        check(fmt == nullptr, "and nothing is left open");

        // The same rule one level up: probe() is what the Sources stage shows,
        // so it has to refuse the same thing rather than quietly describing the
        // file as libavformat's defaults see it.
        MediaInput probeBogus = of(file);
        probeBogus.options.push_back({"no_such_option", "1"});
        const ProbeResult r = probeMedia(probeBogus);
        check(!r.ok && r.error.find("no_such_option") != std::string::npos,
              "probe() refuses it too: " + r.error);
    }

    std::printf("\nthe window: -ss, -t and -itsoffset\n");
    {
        const ProbeResult whole = probeMedia(file);
        check(whole.ok && whole.durationSec > 3.0,
              "the fixture is long enough to cut a window out of");

        MediaInput cut = of(file);
        cut.ss = 1.0;
        cut.duration = 2.0;
        const ProbeResult windowed = probeMedia(cut);
        checkf(windowed.ok && std::abs(windowed.durationSec - 2.0) < 0.05,
               "-ss 1 -t 2 makes the input two seconds long, not %.2f (whole file: %.2f)",
               windowed.durationSec, whole.durationSec);
        // A clip's length comes from its video stream's own duration, never the
        // container's, so the window has to reach that number too.
        bool videoWindowed = false;
        for (const auto& s : windowed.streams)
            if (s.kind == "video") videoWindowed = std::abs(s.duration - 2.0) < 0.05;
        check(videoWindowed, "and the video stream reports the window, not the file");

        // What the window *is*, in pixels: the input's zero is where `-ss` put
        // it. The reader is asked for 0 and hands back the picture the plain
        // reader hands back at 2 seconds.
        SourceVideo plain, shifted;
        std::string err;
        const bool bothOpen = plain.open(of(file), &err) &&
                              shifted.open([&] { MediaInput i = of(file); i.ss = 2.0; return i; }(),
                                           &err);
        checkf(bothOpen, "two readers on one file, one of them seeked (%s)",
               bothOpen ? "ok" : err.c_str());
        if (bothOpen) {
            const Rgba at0 = copyOf(plain.rgbaAt(0.0));
            const Rgba at2 = copyOf(plain.rgbaAt(2.0));
            const Rgba shiftedAt0 = copyOf(shifted.rgbaAt(0.0));
            checkf(differ(at0, at2) > 1.0,
                   "the fixture moves, so 0s and 2s are different pictures (%.1f)",
                   differ(at0, at2));
            checkf(differ(at2, shiftedAt0) < 0.5,
                   "-ss 2 makes the input's zero the file's two seconds (%.2f apart)",
                   differ(at2, shiftedAt0));
        }

        // `-t` ends the input, which for a reader is the end of the file.
        SourceVideo brief;
        MediaInput oneSecond = of(file);
        oneSecond.duration = 1.0;
        if (brief.open(oneSecond, &err)) {
            check(brief.rgbaAt(0.5) != nullptr, "inside -t there is a picture");
            check(brief.rgbaAt(1.5) == nullptr, "past -t the input has ended");
        }

        // `-itsoffset` delays the content: what was at zero is now at the
        // offset, which is how a camera and a separate recorder are lined up.
        SourceVideo delayed;
        MediaInput late = of(file);
        late.itsoffset = 1.0;
        SourceVideo plain2;
        if (delayed.open(late, &err) && plain2.open(of(file), &err)) {
            const Rgba plainAt0 = copyOf(plain2.rgbaAt(0.0));
            const Rgba lateAt1 = copyOf(delayed.rgbaAt(1.0));
            checkf(differ(plainAt0, lateAt1) < 0.5,
                   "-itsoffset 1 puts the first picture one second in (%.2f apart)",
                   differ(plainAt0, lateAt1));
        }
    }

    std::printf("\nan input a clip names, and one it does not\n");
    {
        ExportSettings s;
        MediaInput one = of(file);
        one.ss = 3.0;
        s.inputs.push_back(one);

        const MediaInput byIndex = resolveInput(s, 0, "");
        check(byIndex.path == file && byIndex.ss == 3.0,
              "a clip's input index resolves to the input it names");
        const MediaInput byPath = resolveInput(s, -1, file);
        check(byPath.path == file && byPath.ss == 0.0,
              "and a clip with no index is its own path, opened plainly");
        const MediaInput past = resolveInput(s, 7, file);
        check(past.path == file && past.ss == 0.0,
              "an index past the end falls back rather than reading out of bounds");
    }

    std::printf("\nthe token playback opens an input by\n");
    {
        MediaInput registered = of(file);
        registered.duration = 1.5;
        const std::string token = defineInput("test-1", registered);
        checkf(!token.empty() && token[0] == '/',
               "a registered input's token starts with a slash, so bro leaves it alone: %s",
               token.c_str());
        check(token == inputToken("test-1"), "and the token is the id's, spelled one way");

        MediaInput back;
        check(resolveToken(token, &back), "the token resolves");
        check(back.path == file && back.duration == 1.5,
              "to the input that was registered, window and all");
        check(!resolveToken(file, &back), "and a plain path is not a token");

        // The whole point: bro's media backend opens the token as that input.
        // This is the path `<video src>` takes, one call down.
        bool opened = false;
        double reported = 0;
        for (const auto& be : bro::video::mediaBackends()) {
            if (be.name != "ffmpeg" || !be.open) continue;
            auto src = be.open(token);
            if (!src) break;
            opened = true;
            for (const auto& t : src->tracks())
                if (t.kind == bro::video::TrackKind::Video) reported = t.durationNs / 1e9;
        }
        check(opened, "the media backend opens a token as the input it names");
        checkf(reported > 0 && reported <= 1.6,
               "and the track it reports is as long as the input's window, not the file's "
               "(%.2fs)", reported);

        forgetInput("test-1");
        check(!resolveToken(token, &back), "a forgotten input's token stops resolving");
    }

    std::printf("\n%s\n", g_failures ? "FAILED" : "all input checks passed");
    return g_failures ? 1 : 0;
}
