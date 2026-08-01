// The preview's cadence: when the render makes a picture, and for which moment.
//
// `OutputRun` publishes a picture only where there is a *new moment* to make one
// for, and the moment comes from the reader — the element says where its screen
// is by taking a picture, and the next canvas is made one frame after it
// (playback_output.h). That rule is what stops a preview compositing frames
// nobody will see, and it is also a pair of things pointing at each other: no
// picture without a take, no take without a picture. Every failure this file is
// about is that pair getting stuck, and each one showed up as the same symptom —
// the sound playing on perfectly over a picture that never changed again.
//
// So what is asserted here is the *cadence*, not the pixels: which calls produce
// a picture and which moment it is for. There is nothing timing-dependent in it —
// `OutputReader` is driven by hand, with the screen readings a real element would
// have produced, so a machine that renders at a tenth of the speed asserts the
// same things.
//
// Usage: ffmpeg-bro-playbacktest <media-file>

#include "ffmpeg_export.h"
#include "playback_output.h"

extern "C" {
#include <libavutil/frame.h>
}

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <string>
#include <vector>

using namespace ffmpegbro;

namespace {

int g_failures = 0;

void check(bool ok, const char* fmt, ...) {
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);
    std::printf("  %s  %s\n", ok ? "PASS" : "FAIL", msg);
    if (!ok) ++g_failures;
}

constexpr double kFps = 25.0;
constexpr double kStep = 1.0 / kFps;

/// The whole of a view: a small canvas, a few seconds of one file, sound on.
///
/// Sound is the half that paces a run and therefore the half every one of these
/// failures needed to happen at all — a preview with none of it has nothing to
/// wait for.
OutputView viewOf(const std::string& path) {
    OutputView v;
    v.settings.width = 320;
    v.settings.height = 180;
    v.settings.fps = kFps;
    v.settings.startTime = 0.0;
    v.settings.endTime = 4.0;
    v.settings.includeAudio = true;

    ExportClip c;
    c.path = path;
    c.start = 0.0;
    c.length = 4.0;
    c.inPoint = 0.0;
    c.x = 0;
    c.y = 0;
    c.w = 320;
    c.h = 180;
    c.z = 0;
    v.clips.push_back(c);
    return v;
}

/// One tick, with the frame it produced released again. The moment it was made
/// for comes back, or −1 where nothing was.
double madeAt(OutputReader::Tick& t) {
    const double at = t.picture ? t.pictureAt : -1.0;
    if (t.picture) av_frame_free(&t.picture);
    if (t.sound) av_frame_free(&t.sound);
    return at;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("usage: ffmpeg-bro-playbacktest <media-file>\n");
        return 2;
    }
    const std::string media = argv[1];
    const OutputView view = viewOf(media);

    // ── a skipped composite is not a composite ─────────────────────────────
    //
    // A tick the render arrived at late produces its sound and no picture, which
    // is how the sound keeps up. What it must not do is take the moment with it:
    // the picture was not made, so the next tick still has one to make. Moving
    // the mark on a tick that drew nothing says the moment has been answered, and
    // then nothing is ever fresh again.
    std::printf("\na skipped composite\n");
    {
        OutputReader r;
        std::string err;
        check(r.open(view, true, &err), "the reader opens (%s)", err.empty() ? "ok" : err.c_str());

        OutputReader::Tick first = r.next(true, -1.0);
        const double at0 = madeAt(first);
        check(at0 >= 0.0, "the first tick makes a picture (at %.3f s)", at0);

        // The element took it, so this is where its screen is.
        OutputReader::Tick late = r.next(false, at0);
        check(late.picture == nullptr, "a tick that skips its composite makes no picture");
        check(late.sound != nullptr, "and makes its sound anyway, which is the point of skipping");
        const double none = madeAt(late);
        check(none < 0.0, "so there is nothing to publish for it");

        OutputReader::Tick after = r.next(true, at0);
        const double at1 = madeAt(after);
        check(at1 > at0, "and the moment it skipped is still there to make (%.3f s)", at1);
    }

    // ── the frontier is not a reason to withhold a picture ─────────────────
    //
    // The picture is made one frame after the screen and not past the frontier —
    // the moment the sound has reached — because there is nothing to show for a
    // moment nothing has been made for. But with the frontier at or behind the
    // screen, that clamp names the moment the element has already been given,
    // which is no picture at all: it stops the pair, and a render that cannot
    // make its own frame rate lives in exactly that state. `catchUp` is the same
    // question asked with no tick behind it, which is the case that deadlocked —
    // the loop was waiting for room in the sound queue, and the thread that
    // drains that queue was the one waiting for this picture.
    std::printf("\nthe screen ahead of the frontier\n");
    {
        OutputReader r;
        std::string err;
        check(r.open(view, true, &err), "the reader opens (%s)", err.empty() ? "ok" : err.c_str());

        OutputReader::Tick first = r.next(true, -1.0);
        double screen = madeAt(first);
        check(screen >= 0.0, "one tick, to have a screen at all");

        // No ticks from here on: the run is asleep on sound room, and every
        // picture below is one the reader is waiting for.
        double last = screen;
        int made = 0;
        for (int i = 0; i < 8; ++i) {
            OutputReader::Tick t = r.catchUp(screen);
            const double at = madeAt(t);
            if (at < 0.0) break;
            check(at > last, "a picture past the last one without a tick (%.3f s)", at);
            last = at;
            ++made;
            screen = at;   // the element took it
        }
        check(made == 8, "the picture goes on being made while the screen moves (%d of 8)", made);

        // And costs nothing while one is waiting to be taken: the pad holds a
        // single picture, so a second made for a moment the reader has not
        // reached only replaces the first — a decode and a scale, thrown away.
        // This is the reading with the last one *not* taken, which is the state
        // between a publish and an ask.
        OutputReader::Tick spare = r.catchUp(screen);
        check(madeAt(spare) > screen, "one picture ahead of the screen is made");
        OutputReader::Tick idle = r.catchUp(screen);
        check(madeAt(idle) < 0.0, "and no second one until it has been taken");
    }

    // ── the range still ends ───────────────────────────────────────────────
    //
    // The picture may now be made past the moment the sound has reached, so the
    // end has to be the same end it always was: where the *range* stops.
    std::printf("\nthe end of the range\n");
    {
        OutputReader r;
        std::string err;
        check(r.open(view, true, &err), "the reader opens (%s)", err.empty() ? "ok" : err.c_str());

        double screen = -1.0;
        int pictures = 0;
        double past = -1.0;
        bool done = false;
        for (int i = 0; i < 4000 && !done; ++i) {
            OutputReader::Tick t = r.next(true, screen);
            done = t.done;
            const double at = madeAt(t);
            if (at < 0.0) continue;
            ++pictures;
            if (at > view.settings.endTime - kStep + 1e-6 && past < 0.0) past = at;
            screen = at;   // a reader that takes every one of them
        }
        check(done, "the reader says when the range has run out");
        check(past < 0.0, "and made nothing past the last frame of it (%.3f s)", past);
        const int expected = static_cast<int>(view.settings.endTime * kFps);
        check(pictures > expected / 2 && pictures <= expected + 1,
              "and made a picture for about every frame of it (%d of %d)", pictures, expected);
        check(std::fabs(screen - (view.settings.endTime - kStep)) < 2 * kStep,
              "the last one landing on the last frame (%.3f s)", screen);
    }

    std::printf("\n%s\n", g_failures ? "FAILED" : "all good");
    return g_failures ? 1 : 0;
}
