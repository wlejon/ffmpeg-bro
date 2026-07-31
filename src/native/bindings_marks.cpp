// `bro.ffmpeg.marks` — where something happens in a soundtrack.
//
// The sixth question this surface answers about a particular file, and it is
// shaped like the fifth on purpose: `data.reads.*` reads a whole track on a
// thread and is polled from the frame loop, and this reads a whole *soundtrack*
// the same way. They share `async_open.h`, so "a terminal answer is handed over
// exactly once" means the same thing in both, and a UI that has written the poll
// for one has written it for the other.
//
// **There is no `available()` here, and there was.** It answered one question —
// was this binary configured with `-DBRO_WITH_SOUNDML=OFF` — and that
// configuration is now refused at configure time (see CMakeLists.txt), so the
// answer was the constant `true`. A call whose answer cannot vary is a call
// every consumer has to make and none can learn anything from, and a UI that
// asked it was written as though the control might not be drawable. The sensors
// are linked into this binary unconditionally; nothing has to ask.
//
// What survives is the distinction that was always the point, and it is a fact
// about the *file* rather than about the build: a soundtrack in which nothing
// happens answers with an empty list, and an input with no soundtrack at all is
// refused by name on the read. Those must not be the same answer.
//
// **This is not ffmpeg.** Every other file in this family is a part of ffmpeg's
// own model — probe, data, render, capture, capabilities, playback, sequences,
// expressions — and this one is libav decoding a soundtrack so that *bro's*
// sensors can read it. It lives here anyway because the seam it needs is
// libav's: an `-i` with its forced demuxer, its option bag and its window, read
// exactly as this application reads every other input, resampled by `swr`. A
// second namespace for one call, whose whole argument is a `MediaInput`, would
// be a second vocabulary for the same object.
//
// **The marks come back as objects, not as typed arrays** — which is the
// opposite of `data.reads`, and the difference is what the answer *is*. A
// reading is three floats per bucket per series, hundreds of thousands of
// numbers indexed by a draw loop, so a `Float32Array` is both smaller and the
// shape the lane wants. A mark is a *place*: a handful of properties that are
// read together, one at a time, by a tooltip and by a jump. The count is bounded
// by the sensor's own refractory period rather than by the file's length, and a
// real recording yields hundreds. Columns would make every consumer index five
// arrays in step to describe one moment.
//
// What is deliberately *not* here is a per-frame curve. The hub measures a level
// and a spectral centroid on every 10 ms frame and `bro.sense.analyze` hands
// those back; this call answers "where", and a second answer shaped like a
// waveform would be a worse waveform than the one `bro.media.peaks` already
// draws.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_input.h"
#include "sound_marks.h"

#include <quickjs.h>

#include <cmath>
#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

/// What a kind is called in JS. Words rather than numbers, because these names
/// are the whole of what a mark claims and a `kind: 2` would push the meaning
/// into a lookup table somebody has to keep in step.
///
/// `sound` is bro's `voice` flag and is **not** called that here. See the top of
/// sound_marks.h: the sensor is an energy gate against an adaptive noise floor,
/// nothing in it decided anything was a voice, and a name that said so would be
/// this surface inventing a claim the DSP never made.
const char* kindName(MarkKind k) {
    switch (k) {
        case MarkKind::Onset: return "onset";
        case MarkKind::Tonal: return "tonal";
        case MarkKind::Sound: return "sound";
    }
    return "onset";
}

JSValue markToJs(JSContext* ctx, const SoundMark& m) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, kindName(m.kind)));
    JS_SetPropertyStr(ctx, o, "at", JS_NewFloat64(ctx, m.at));
    JS_SetPropertyStr(ctx, o, "length", JS_NewFloat64(ctx, m.length));
    JS_SetPropertyStr(ctx, o, "db", JS_NewFloat64(ctx, m.db));
    // Zero on the kinds where the underlying number means nothing, rather than
    // absent: a consumer reading `m.hz` on an onset gets 0 either way, and a
    // shape that changed per kind would make every reader test for the key.
    JS_SetPropertyStr(ctx, o, "hz", JS_NewFloat64(ctx, m.hz));
    JS_SetPropertyStr(ctx, o, "periodicity", JS_NewFloat64(ctx, m.periodicity));
    JS_SetPropertyStr(ctx, o, "flux", JS_NewFloat64(ctx, m.flux));
    return o;
}

JSValue marksToJs(JSContext* ctx, const SoundMarks& r) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "streamIndex", JS_NewInt32(ctx, r.streamIndex));
    JS_SetPropertyStr(ctx, o, "t0", JS_NewFloat64(ctx, r.t0));
    JS_SetPropertyStr(ctx, o, "t1", JS_NewFloat64(ctx, r.t1));
    // The front-end the marks were measured with, reported rather than assumed:
    // a 25 ms window is the error bar on every `at` in the list, and it is
    // brosoundml's number rather than this application's.
    JS_SetPropertyStr(ctx, o, "rate", JS_NewInt32(ctx, r.rate));
    JS_SetPropertyStr(ctx, o, "win", JS_NewInt32(ctx, r.win));
    JS_SetPropertyStr(ctx, o, "hop", JS_NewInt32(ctx, r.hop));
    JS_SetPropertyStr(ctx, o, "frames", JS_NewInt64(ctx, r.frames));
    // Exact over the whole track, before the minimum run length and before the
    // cap. `marks.length` is what was kept, and the two differ for a reason a
    // caller is entitled to show.
    JS_SetPropertyStr(ctx, o, "onsets", JS_NewInt64(ctx, r.onsets));
    JS_SetPropertyStr(ctx, o, "tonalRuns", JS_NewInt64(ctx, r.tonalRuns));
    JS_SetPropertyStr(ctx, o, "soundRuns", JS_NewInt64(ctx, r.soundRuns));
    JS_SetPropertyStr(ctx, o, "truncated", JS_NewBool(ctx, r.truncated));

    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (const SoundMark& m : r.marks)
        JS_SetPropertyUint32(ctx, arr, n++, markToJs(ctx, m));
    JS_SetPropertyStr(ctx, o, "marks", arr);
    return o;
}

/// A sensor knob, or unset.
///
/// NaN as the sentinel and `numProp`'s own rule as the test: absent, `null`,
/// `undefined` and a string nobody meant as a number all come back as the
/// fallback, and NaN is the one value no caller can have meant. An unset knob is
/// then left exactly as `SensorHubConfig` constructs it, so brosoundml keeps the
/// only copy of its own defaults.
std::optional<float> knob(JSContext* ctx, JSValueConst o, const char* key) {
    const double v = numProp(ctx, o, key, std::nan(""));
    if (!std::isfinite(v)) return std::nullopt;
    return static_cast<float>(v);
}

/// The `-i` and the policy, out of whatever the caller passed.
///
/// The same reader `probes.start` and `data.reads.start` use, for the same
/// reason: a soundtrack read out of a file opened with a forced demuxer, a
/// `-probesize` or an `-ss` is a different soundtrack from the same file opened
/// with libavformat's defaults.
bool readArgs(JSContext* ctx, int argc, JSValueConst* argv, MediaInput* in,
              SoundMarkOptions* opts, double* timeout) {
    if (argc < 1) {
        JS_ThrowTypeError(ctx, "marks.reads.start(input) needs a path or an input");
        return false;
    }
    if (JS_IsObject(argv[0])) {
        *in = inputFromJs(ctx, argv[0]);
    } else {
        const char* path = JS_ToCString(ctx, argv[0]);
        if (!path) return false;
        in->path = path;
        JS_FreeCString(ctx, path);
    }
    if (in->path.empty()) {
        JS_ThrowTypeError(ctx, "marks.reads.start() needs a path or an input");
        return false;
    }

    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValueConst o = argv[1];
        opts->onsetRatio = knob(ctx, o, "onsetRatio");
        opts->onsetAbs = knob(ctx, o, "onsetAbs");
        opts->tonalMinPeriodicity = knob(ctx, o, "tonalMinPeriodicity");
        opts->tonalFminHz = knob(ctx, o, "tonalFminHz");
        opts->tonalFmaxHz = knob(ctx, o, "tonalFmaxHz");
        opts->minRunSec = numProp(ctx, o, "minRunSec", opts->minRunSec);
        opts->wantOnsets = boolProp(ctx, o, "onsets", opts->wantOnsets);
        opts->wantTonal = boolProp(ctx, o, "tonal", opts->wantTonal);
        opts->wantSound = boolProp(ctx, o, "sound", opts->wantSound);
        *timeout = numProp(ctx, o, "timeout", 0);
    }
    return true;
}

// bro.ffmpeg.marks.reads.start(path | input, opts?)
//
// `opts` carries bro's own key names for the sensor knobs it exposes —
// `onsetRatio`, `onsetAbs`, `tonalMinPeriodicity`, `tonalFminHz`, `tonalFmaxHz`
// — so that somebody who has read bro's `bro.sense.start({...})` does not learn
// a second vocabulary for the same number. Beside them: `minRunSec`, the
// shortest run that becomes a mark; `onsets` / `tonal` / `sound`, which sensors
// to keep; and `timeout`, which is not a demuxer option and never reaches libav
// — it is the deadline on the interrupt callback, the one mechanism that covers
// every protocol.
JSValue js_marksStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    MediaInput in;
    SoundMarkOptions opts;
    double timeout = 0;
    if (!readArgs(ctx, argc, argv, &in, &opts, &timeout)) return JS_EXCEPTION;
    return JS_NewInt64(ctx, int64_t(startMarksRead(in, opts, timeout)));
}

const char* stateName(MarksProgress::State s) {
    switch (s) {
        case MarksProgress::State::Reading: return "reading";
        case MarksProgress::State::Done:    return "done";
        case MarksProgress::State::Failed:  return "failed";
        case MarksProgress::State::Stopped: return "stopped";
    }
    return "reading";
}

// bro.ffmpeg.marks.reads.poll(id) — where it has got to.
//
// `null` for an id nothing knows about, which after a terminal answer is the
// ordinary case: the answer is handed over once and the entry is forgotten with
// it, so a caller that polls a finished read twice is a caller that dropped the
// answer.
JSValue js_marksPoll(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "marks.reads.poll(id) requires an id");
    int64_t id = 0;
    if (JS_ToInt64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;

    MarksProgress p;
    if (!marksReadProgress(uint64_t(id), &p)) return JS_NULL;

    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "state", stateName(p.state));
    JS_SetPropertyStr(ctx, o, "reading",
                      JS_NewBool(ctx, p.state == MarksProgress::State::Reading));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, p.elapsed));
    JS_SetPropertyStr(ctx, o, "timeout", JS_NewFloat64(ctx, p.timeout));
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(ctx, o, "error", p.result.error);
    JS_SetPropertyStr(ctx, o, "result",
                      p.state == MarksProgress::State::Done ? marksToJs(ctx, p.result)
                                                            : JS_NULL);
    return o;
}

} // namespace

void installMarks(Table& ns) {
    Table marks(ns, "marks");

    Table reads(marks, "reads");
    reads.function("start", js_marksStart, 2);
    reads.function("poll", js_marksPoll, 1);
    /// Abort the read. Real rather than a hidden spinner: the flag is checked
    /// between frames of the analysis as well as by libav's own interrupt
    /// callback, so a press lands inside the arithmetic and not only inside the
    /// decode.
    reads.function("cancel", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        stopMarksRead(uint64_t(id));
        return JS_UNDEFINED;
    });
    /// Stop it and never poll again — an input removed while its sound was
    /// still being read. Separate from `cancel` for `probes.forget`'s reason:
    /// the two differ in whether anybody is going to be told.
    reads.function("forget", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        abandonMarksRead(uint64_t(id));
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
