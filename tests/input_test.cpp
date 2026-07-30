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
//     options reach playback through a `<video src>` that is only a string;
//   - an open that is going nowhere **ends by itself and can be stopped**,
//     which is the one thing a synchronous probe could never do. Both halves
//     are checked against a closed port on the loopback address, so the test
//     needs no network and cannot reach one: what it asserts is the *deadline*
//     and the *refusal*, which are facts about this code, and never that
//     something answered.
//
// Usage: ffmpeg-bro-inputtest <media-file>

#include "ffmpeg_backend.h"
#include "ffmpeg_export.h"
#include "ffmpeg_input.h"
#include "probe_async.h"
#include "export_frame.h"
#include "export_source.h"
#include "playback_filter.h"

#include "video/audio_decoder.h"
#include "video/media_backend.h"
#include "video/media_source.h"
#include "video/video_decoder.h"

extern "C" {
#include <libavformat/avformat.h>
}

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
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

/// What one picture and one soundtrack look like coming out of `src`, played
/// the way an element plays them.
///
/// Through **bro's own registry, decoder and all**, because that is the claim:
/// a view is a src string, and everything downstream of the string has to be
/// the path a `<video>` takes or the test is about something else. The frames
/// arrive as `wrapped_avframe` for a filtered stream and as ordinary packets
/// for one with no chain on it, and nothing here knows which — which is itself
/// the point of that mechanism.
struct Played {
    bool opened = false;
    int width = 0, height = 0;
    double meanY = -1;   ///< the first picture at or after `at`, 0..255
    double at = -1;      ///< when that picture said it was, in seconds
    double peak = -1;    ///< the largest sample seen, or -1 for a file with no sound
    int frames = 0;
    int rotation = -1;   ///< what the track tells bro to turn the picture by
};

Played play(const std::string& src, double at) {
    using namespace bro::video;
    Played out;
    const MediaBackend* be = nullptr;
    std::unique_ptr<MediaSource> s;
    for (const auto& b : mediaBackends()) {
        if (b.name != "ffmpeg" || !b.open) continue;
        s = b.open(src);
        be = &b;
        break;
    }
    if (!s || !be) return out;
    out.opened = true;

    uint32_t vid = 0, aid = 0;
    std::unique_ptr<VideoDecoder> vdec;
    std::unique_ptr<AudioDecoder> adec;
    for (const auto& t : s->tracks()) {
        if (t.kind == TrackKind::Video && !vdec) {
            vdec = be->makeVideoDecoder(t);
            vid = t.id;
            out.width = static_cast<int>(t.width);
            out.height = static_cast<int>(t.height);
            out.rotation = t.rotationDegrees;
        } else if (t.kind == TrackKind::Audio && !adec) {
            adec = be->makeAudioDecoder(t);
            aid = t.id;
        }
    }
    const TimeNs target = static_cast<TimeNs>(llround(at * 1e9));
    if (at > 0) s->seekTo(target);

    MediaPacket pkt;
    VideoFrame vf;
    AudioFrame af;
    for (int guard = 0; guard < 4000 && s->readPacket(pkt); ++guard) {
        if (vdec && pkt.trackId == vid) {
            if (!vdec->decode(pkt)) continue;
            while (vdec->nextFrame(vf)) {
                out.frames++;
                if (out.meanY >= 0 || vf.pts < target || !vf.y) continue;
                double sum = 0;
                size_t n = 0;
                for (uint32_t y = 0; y < vf.height; ++y) {
                    const uint8_t* p = vf.y + size_t(y) * size_t(vf.strideY);
                    for (uint32_t x = 0; x < vf.width; ++x) { sum += p[x]; ++n; }
                }
                if (n) {
                    out.meanY = sum / double(n);
                    out.at = double(vf.pts) / 1e9;
                    out.width = static_cast<int>(vf.width);
                    out.height = static_cast<int>(vf.height);
                }
            }
        } else if (adec && pkt.trackId == aid) {
            if (!adec->decode(pkt, af)) continue;
            if (out.peak < 0) out.peak = 0;
            for (float v : af.samples) out.peak = std::max(out.peak, double(std::fabs(v)));
        }
        // Enough to be sure of both, and not the whole file: a mean over the
        // first picture and a peak over the first second of sound answer every
        // question below.
        if (out.meanY >= 0 && out.frames > 3 && (!adec || out.peak >= 0)) break;
    }
    return out;
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
        std::printf("usage: ffmpeg-bro-inputtest <media-file> [<rotated-file>] "
                    "[<subtitle-file>]\n");
        return 2;
    }
    const std::string file = argv[1];
    // Optional, and skipped rather than failed when it is absent: a display
    // matrix cannot be faked with content, and every suite here runs against
    // any real file.
    const std::string rotated = argc > 2 ? argv[2] : std::string();
    // A file of cues written against `file`'s own clock. Optional for the same
    // reason: what it proves is that a *time-dependent* filter draws the right
    // thing at the right moment, and that needs a fixture whose contents are
    // known before the render.
    const std::string cues = argc > 3 ? argv[3] : std::string();
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

    // ── a filter, on the way to the screen ─────────────────────────────────
    //
    // The same registry one turn further on, and the same claim: what a
    // `<video src>` names decides what libav does. Here it decides that a
    // filtergraph runs, which is what makes the program monitor show the
    // picture the render will make.
    //
    // Everything below is asserted by **decoding the frames back**, because a
    // size is not evidence: a chain that quietly did nothing would report the
    // same width as one that worked, and the whole failure mode this path
    // exists against is a filter that looks like it is running and is not.
    std::printf("\na filter, on playback\n");
    {
        const Played plain = play(file, 0);
        checkf(plain.opened && plain.meanY >= 0,
               "the file plays unfiltered, and its first picture is %.1f mean luma "
               "at %dx%d", plain.meanY, plain.width, plain.height);

        // `negate` because it is the one filter whose effect can be *predicted*
        // rather than merely noticed: it inverts each component, so the picture
        // that comes back has to be 255 minus the one that went in. A chain
        // that ran the wrong filter, or ran none, cannot land there by accident.
        PlaybackView v;
        v.input = of(file);
        v.video = "negate";
        ViewFacts facts;
        std::string err;
        const bool settled = settleView(v, &facts, &err);
        checkf(settled, "a view settles and says what it produces (%s)",
               settled ? "ok" : err.c_str());
        checkf(facts.video && facts.width == plain.width && facts.height == plain.height,
               "a filter that keeps the size reports the size it kept (%dx%d)",
               facts.width, facts.height);

        const std::string token = defineView("fx-1", v);
        checkf(!token.empty() && token[0] == '/',
               "a view's token starts with a slash, so bro leaves it alone: %s",
               token.c_str());
        check(token == viewToken("fx-1"), "and the token is the id's, spelled one way");

        const Played negated = play(token, 0);
        check(negated.opened, "the media backend opens a view token");
        checkf(negated.meanY >= 0 && std::fabs(negated.meanY - (255.0 - plain.meanY)) < 6.0,
               "and the picture that comes out is the negative of the one that went in "
               "(%.1f, against %.1f expected)", negated.meanY, 255.0 - plain.meanY);
        checkf(negated.width == plain.width && negated.height == plain.height,
               "at the same size (%dx%d)", negated.width, negated.height);

        // A seek, because a graph is *rebuilt* across one — libavfilter has no
        // flush — and the cheapest way for that to be wrong is for the second
        // build to fail silently and the element to go black half way through
        // a scrub.
        const Played later = play(token, 0.5);
        checkf(later.meanY >= 0, "and it survives a seek: %.1f mean luma half a second in",
               later.meanY);
    }

    std::printf("\nthe clock the filters are on\n");
    {
        // **`enable=` names a moment on the render's clock and playback runs on
        // the file's.** A clip half an hour into a recording would otherwise
        // switch its filter on half an hour late, which is the sort of wrong
        // that looks like the filter not working. The chain says so itself, with
        // a `setpts` where the render's graph has one, and `shift` is how much
        // of that to take back off at the end — so the only way to see it from
        // outside is to hold everything else still and move it: the same filter,
        // the same frame of the same file, on and off.
        const Played plain = play(file, 0);
        PlaybackView v;
        v.input = of(file);
        v.video = "negate=enable='gt(t,10)'";

        v.shift = 0.0;
        const Played before = play(defineView("fx-5", v), 0);
        checkf(before.meanY >= 0 && std::fabs(before.meanY - plain.meanY) < 1.0,
               "on the file's own clock the first frame is before the span, so nothing "
               "happens to it (%.1f against %.1f)", before.meanY, plain.meanY);

        // Twenty seconds along the timeline: the file's first frame is now the
        // render's twentieth second, which is inside the span.
        v.video = "setpts=PTS+20/TB,negate=enable='gt(t,10)'";
        v.shift = 20.0;
        const Played after = play(defineView("fx-5", v), 0);
        checkf(after.meanY >= 0 && std::fabs(after.meanY - (255.0 - plain.meanY)) < 6.0,
               "and moved twenty seconds along the render's clock, the same frame is "
               "inside it (%.1f, against %.1f expected)", after.meanY, 255.0 - plain.meanY);
        // And it is still the *first* frame: `shift` took the twenty seconds
        // back off, so the element's playhead never learned about them. Without
        // that half, `play(..., 0)` would be answered by a frame stamped 20s and
        // everything the viewer does with a clock would be out by the clip's
        // position on the timeline.
        checkf(after.at >= 0 && after.at < 0.2,
               "and comes back on the stream's own clock, not the render's (%.3fs)",
               after.at);

        // A filter *in front of* that `setpts` sees the file's timestamps —
        // which is what the render shows one inserted after the decode, because
        // the derivation's `setpts` is below that insert point and above the
        // other. Same span, same shift, and now nothing happens to the frame.
        v.video = "negate=enable='gt(t,10)',setpts=PTS+20/TB";
        const Played ahead = play(defineView("fx-5", v), 0);
        checkf(ahead.meanY >= 0 && std::fabs(ahead.meanY - plain.meanY) < 1.0,
               "a filter in front of the setpts is on the file's clock, where the render "
               "puts it (%.1f against %.1f)", ahead.meanY, plain.meanY);
        forgetView("fx-5");
    }

    std::printf("\na filter that changes the shape of the picture\n");
    {
        // Structural, and reported before anything is pointed at it: the viewer
        // places a clip by the rectangle its *source* has, so a caller has to be
        // able to ask "did this chain resize the picture" without rendering
        // anything. Both numbers come back from one settle.
        PlaybackView v;
        v.input = of(file);
        v.video = "crop=iw/2:ih:0:0";
        ViewFacts facts;
        std::string err;
        const bool settled = settleView(v, &facts, &err);
        checkf(settled, "a crop settles (%s)", settled ? "ok" : err.c_str());
        checkf(facts.sourceWidth > 0 && facts.width == facts.sourceWidth / 2,
               "and reports both sizes: %dx%d out of %dx%d", facts.width, facts.height,
               facts.sourceWidth, facts.sourceHeight);

        const std::string token = defineView("fx-2", v);
        const Played cropped = play(token, 0);
        checkf(cropped.width == facts.width && cropped.height == facts.height,
               "and the frames that arrive are that size (%dx%d)",
               cropped.width, cropped.height);
        forgetView("fx-2");
    }

    std::printf("\na chain that will not run\n");
    {
        // **An unknown option is an error, not a shrug** — the same rule the
        // demuxer's bag is held to, at the other end of the same open. And the
        // message has to be libavfilter's own, because a typo in a filter
        // argument is the ordinary case and "invalid argument" names nothing.
        PlaybackView v;
        v.input = of(file);
        v.video = "eq=nosuchoption=3";
        std::string err;
        check(!settleView(v, nullptr, &err), "a filter option nothing has is refused");
        checkf(!err.empty(), "and the refusal says something: %s", err.c_str());

        v.video = "no_such_filter_exists";
        err.clear();
        check(!settleView(v, nullptr, &err), "so is a filter this build does not have");

        // A view with nothing in it is the input, and saying so is better than
        // registering a token that means "the file, again".
        v.video.clear();
        v.audio.clear();
        check(!settleView(v, nullptr, &err), "and a view with no filters in it is refused");
    }

    std::printf("\na filter on the sound\n");
    {
        const Played plain = play(file, 0);
        if (plain.peak <= 0) {
            std::printf("  ----  no audio in this file\n");
        } else {
            PlaybackView v;
            v.input = of(file);
            v.audio = "volume=0";
            ViewFacts facts;
            std::string err;
            const bool settled = settleView(v, &facts, &err);
            checkf(settled, "a chain on the sound alone settles (%s)",
                   settled ? "ok" : err.c_str());
            checkf(settled && facts.audio && !facts.video,
                   "and settles the sound only: %d Hz, %d channels, no picture chain",
                   facts.sampleRate, facts.channels);

            const std::string token = defineView("fx-3", v);
            const Played silenced = play(token, 0);
            checkf(silenced.peak == 0.0,
                   "what comes out is silent, where the file peaks at %.3f", plain.peak);
            // The picture is untouched *and undecoded*: a stream with no chain
            // on it reaches the element as the packets it always was, which is
            // what keeps a filter on the sound from costing a video decode.
            checkf(silenced.meanY >= 0 && std::fabs(silenced.meanY - plain.meanY) < 1.0,
                   "and the picture is the file's own, unfiltered (%.1f against %.1f)",
                   silenced.meanY, plain.meanY);
            forgetView("fx-3");
        }
    }

    std::printf("\nsubtitles, drawn into the picture\n");
    if (cues.empty()) {
        std::printf("  ----  no subtitle file given\n");
    } else {
        // **The one filter whose whole job is to be different at different
        // moments.** A `negate` proves a chain ran; a `subtitles` proves the
        // chain ran *and* was handed the clock the cues were written against,
        // which is the thing this playback path had to get right and the thing
        // a size or an "it opened" says nothing about.
        //
        // The fixture places its cues to make exactly that measurable: a line
        // between one and two seconds, and nothing between two and four. So the
        // same view is checked twice — different from the file inside the cue,
        // identical to it outside — and either check alone passes for a bug. A
        // burn-in that never drew passes the second; one whose clock is wrong
        // by seconds passes neither, and one hard-wired to draw always fails it.
        //
        // The path is escaped here by hand rather than by calling the UI's
        // `filterPath`, which is JavaScript: a colon separates a filter's
        // arguments and a Windows drive letter has one, and stating the rule in
        // both languages is how the two are known to agree.
        std::string arg = "'";
        for (char ch : cues) {
            if (ch == '\\') { arg += '/'; continue; }
            if (ch == ':' || ch == '\'') arg += '\\';
            arg += ch;
        }
        arg += "'";

        PlaybackView v;
        v.input = of(file);
        v.video = "subtitles=filename=" + arg;
        ViewFacts facts;
        std::string err;
        const bool settled = settleView(v, &facts, &err);
        checkf(settled, "a subtitles chain settles (%s)", settled ? "ok" : err.c_str());
        if (settled) {
            checkf(facts.width == facts.sourceWidth && facts.height == facts.sourceHeight,
                   "and draws into the picture rather than resizing it (%dx%d)",
                   facts.width, facts.height);

            const std::string token = defineView("fx-6", v);
            const Played onCue = play(token, 1.4);
            const Played plainOnCue = play(file, 1.4);
            checkf(onCue.meanY >= 0 && plainOnCue.meanY >= 0 &&
                       std::fabs(onCue.meanY - plainOnCue.meanY) > 0.05,
                   "inside a cue the picture is not the file's any more (%.3f against %.3f)",
                   onCue.meanY, plainOnCue.meanY);

            const Played offCue = play(token, 3.0);
            const Played plainOffCue = play(file, 3.0);
            checkf(offCue.meanY >= 0 && plainOffCue.meanY >= 0 &&
                       std::fabs(offCue.meanY - plainOffCue.meanY) < 0.001,
                   "and between cues it is the file's exactly (%.3f against %.3f)",
                   offCue.meanY, plainOffCue.meanY);
            forgetView("fx-6");
        }
    }

    // ── a clip shot sideways ───────────────────────────────────────────────
    //
    // Rotation is metadata, and playback normally hands it to bro to apply.
    // A filtered track cannot: `crop=iw/2` means one thing on a portrait
    // picture and another on the landscape frames the decoder produces, so the
    // turn goes into the chain — which is exactly where the render puts it —
    // and the track then has to report *none*, or the picture is turned twice.
    // Both halves of that are asserted, because either alone passes for a bug.
    if (!rotated.empty()) {
        std::printf("\na filter on a clip shot sideways\n");
        const Played plain = play(rotated, 0);
        checkf(plain.rotation == 90, "the file asks bro to turn the picture (%d degrees)",
               plain.rotation);
        checkf(plain.width > plain.height, "and the frames arrive as coded: %dx%d",
               plain.width, plain.height);

        PlaybackView v;
        v.input = of(rotated);
        v.video = "negate";
        ViewFacts facts;
        std::string err;
        const bool settled = settleView(v, &facts, &err);
        checkf(settled && facts.sourceWidth == plain.height &&
                   facts.sourceHeight == plain.width,
               "a view over it reports the size it is *shown* at: %dx%d (%s)",
               facts.sourceWidth, facts.sourceHeight, settled ? "ok" : err.c_str());

        const Played turned = play(defineView("fx-4", v), 0);
        checkf(turned.rotation == 0,
               "the filtered track asks for no further turn (%d degrees)", turned.rotation);
        checkf(turned.width == plain.height && turned.height == plain.width,
               "because the frames come out already turned: %dx%d", turned.width,
               turned.height);
        forgetView("fx-4");
    }

    // ── an open that is going nowhere ──────────────────────────────────────
    //
    // Port 9 on the loopback address: nothing is listening and nothing can be.
    // On this platform libav does not learn that quickly — a refused connect
    // sits in the poll until the protocol's own `open_timeout` — so this is a
    // genuine blocking open, which is exactly the thing being tested. It is
    // also why nothing here needs a server: what is asserted is that the
    // deadline fires and that a stop lands, not that anything answered.
    std::printf("\nan open that goes nowhere ends by itself, and can be stopped\n");
    {
        MediaInput nowhere;
        nowhere.path = "tcp://127.0.0.1:9";

        const auto began = std::chrono::steady_clock::now();
        const uint64_t id = startProbe(nowhere, 1.0);
        const double startCost =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        checkf(startCost < 0.25,
               "starting one returns at once (%.0f ms) — the open is on a thread of its own",
               startCost * 1000);

        ProbeProgress p;
        while (probeProgress(id, &p) && p.state == ProbeProgress::State::Opening)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        const double waited =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        checkf(p.state == ProbeProgress::State::Failed && waited < 4.0,
               "a deadline of one second ends it in %.2fs, not when libav gives up", waited);
        // The message says which of the two interruptions it was. Both come
        // back from libav as AVERROR_EXIT — "Immediate exit requested" — which
        // names the mechanism and not the reason.
        checkf(p.result.error == "no answer in time",
               "and says the far end did not answer rather than quoting libav: '%s'",
               p.result.error.c_str());
        check(!probeProgress(id, &p), "a terminal answer is handed over once, then forgotten");

        const auto pressed = std::chrono::steady_clock::now();
        const uint64_t id2 = startProbe(nowhere, 60.0);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        stopProbe(id2);
        while (probeProgress(id2, &p) && p.state == ProbeProgress::State::Opening)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        const double toStop =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - pressed).count();
        // **The stop reaches the open**, which is the whole claim: libav polls
        // the interrupt callback roughly every 100ms while it is inside a
        // connect, so a press lands in a fraction of a second against a
        // deadline of a minute. A cancel that only hid a spinner would time out
        // here at sixty seconds.
        checkf(p.state == ProbeProgress::State::Stopped && toStop < 3.0,
               "a stop aborts the connect in %.2fs, against a deadline of 60s", toStop);
        checkf(p.result.error == "stopped", "and is reported as a stop, not as a fault: '%s'",
               p.result.error.c_str());

        // A local file is not routed through any of this — it is the same
        // synchronous call it always was — but the machinery has to work for
        // one anyway, or the split would be the only thing keeping it correct.
        MediaInput here = of(file);
        const uint64_t id3 = startProbe(here, 10.0);
        while (probeProgress(id3, &p) && p.state == ProbeProgress::State::Opening)
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        checkf(p.state == ProbeProgress::State::Done && p.result.ok,
               "and an ordinary file probed this way answers with the same result");
    }

    {
        PlaybackView back;
        check(resolveView(viewToken("fx-1"), &back), "a defined view resolves");
        forgetView("fx-1");
        check(!resolveView(viewToken("fx-1"), &back),
              "a forgotten view's token stops resolving");
        check(!resolveView(file, &back), "and a plain path is not a view");
    }

    std::printf("\n%s\n", g_failures ? "FAILED" : "all input checks passed");
    return g_failures ? 1 : 0;
}
