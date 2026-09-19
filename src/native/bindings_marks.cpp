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

#include <embed/embed.h>

#include <cmath>
#include <cstdint>
#include <optional>
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

bronze::Value markToJs(const SoundMark& m) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setStr(o.get(), "kind", kindName(m.kind));
    setNum(o.get(), "at", m.at);
    setNum(o.get(), "length", m.length);
    setNum(o.get(), "db", m.db);
    // Zero on the kinds where the underlying number means nothing, rather than
    // absent: a consumer reading `m.hz` on an onset gets 0 either way, and a
    // shape that changed per kind would make every reader test for the key.
    setNum(o.get(), "hz", m.hz);
    setNum(o.get(), "periodicity", m.periodicity);
    setNum(o.get(), "flux", m.flux);
    return o.get();
}

bronze::Value marksToJs(const SoundMarks& r) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setNum(o.get(), "streamIndex", r.streamIndex);
    setNum(o.get(), "t0", r.t0);
    setNum(o.get(), "t1", r.t1);
    // The front-end the marks were measured with, reported rather than assumed:
    // a 25 ms window is the error bar on every `at` in the list, and it is
    // brosoundml's number rather than this application's.
    setNum(o.get(), "rate", r.rate);
    setNum(o.get(), "win", r.win);
    setNum(o.get(), "hop", r.hop);
    setNum(o.get(), "frames", static_cast<double>(r.frames));
    // Exact over the whole track, before the minimum run length and before the
    // cap. `marks.length` is what was kept, and the two differ for a reason a
    // caller is entitled to show.
    setNum(o.get(), "onsets", static_cast<double>(r.onsets));
    setNum(o.get(), "tonalRuns", static_cast<double>(r.tonalRuns));
    setNum(o.get(), "soundRuns", static_cast<double>(r.soundRuns));
    setBool(o.get(), "truncated", r.truncated);

    ev::Persistent arr(createArray());
    uint32_t n = 0;
    for (const SoundMark& m : r.marks) {
        ev::Persistent item(markToJs(m));
        arr.set(ev::setElement(arr.get(), n++, item.get()));
    }
    o.set(ev::setProperty(o.get(), "marks", arr.get()));
    return o.get();
}

/// A sensor knob, or unset.
///
/// NaN as the sentinel and `numProp`'s own rule as the test: absent, `null`,
/// `undefined` and a string nobody meant as a number all come back as the
/// fallback, and NaN is the one value no caller can have meant. An unset knob is
/// then left exactly as `SensorHubConfig` constructs it, so brosoundml keeps the
/// only copy of its own defaults.
std::optional<float> knob(bronze::Value o, const char* key) {
    const double v = numProp(o, key, std::nan(""));
    if (!std::isfinite(v)) return std::nullopt;
    return static_cast<float>(v);
}

/// The `-i` and the policy, out of whatever the caller passed.
///
/// The same reader `probes.start` and `data.reads.start` use, for the same
/// reason: a soundtrack read out of a file opened with a forced demuxer, a
/// `-probesize` or an `-ss` is a different soundtrack from the same file opened
/// with libavformat's defaults.
bool readArgs(std::span<const bronze::Value> args, MediaInput* in,
              SoundMarkOptions* opts, double* timeout, std::string* err) {
    namespace ev = bronze::embed;
    if (args.empty()) {
        *err = "marks.reads.start(input) needs a path or an input";
        return false;
    }
    if (ev::isObject(args[0])) {
        *in = inputFromJs(args[0]);
    } else if (ev::isString(args[0])) {
        in->path = ev::toUtf8(args[0]);
    } else {
        *err = "marks.reads.start(input) needs a path or an input";
        return false;
    }
    if (in->path.empty()) {
        *err = "marks.reads.start() needs a path or an input";
        return false;
    }

    if (args.size() >= 2 && ev::isObject(args[1])) {
        bronze::Value o = args[1];
        opts->onsetRatio = knob(o, "onsetRatio");
        opts->onsetAbs = knob(o, "onsetAbs");
        opts->tonalMinPeriodicity = knob(o, "tonalMinPeriodicity");
        opts->tonalFminHz = knob(o, "tonalFminHz");
        opts->tonalFmaxHz = knob(o, "tonalFmaxHz");
        opts->minRunSec = numProp(o, "minRunSec", opts->minRunSec);
        opts->wantOnsets = boolProp(o, "onsets", opts->wantOnsets);
        opts->wantTonal = boolProp(o, "tonal", opts->wantTonal);
        opts->wantSound = boolProp(o, "sound", opts->wantSound);
        *timeout = numProp(o, "timeout", 0);
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
bronze::Value js_marksStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    MediaInput in;
    SoundMarkOptions opts;
    double timeout = 0;
    std::string err;
    if (!readArgs(args, &in, &opts, &timeout, &err))
        return ev::throwTypeError(err);
    return ev::fromDouble(static_cast<double>(startMarksRead(in, opts, timeout)));
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
bronze::Value js_marksPoll(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty()) return ev::throwTypeError("marks.reads.poll(id) requires an id");
    if (!ev::isNumber(args[0])) return ev::throwTypeError("marks.reads.poll(id) requires an id");
    uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));

    MarksProgress p;
    if (!marksReadProgress(id, &p)) return ev::null();

    ev::Persistent o(ev::createObject());
    setStr(o.get(), "state", stateName(p.state));
    setBool(o.get(), "reading", p.state == MarksProgress::State::Reading);
    setNum(o.get(), "elapsed", p.elapsed);
    setNum(o.get(), "timeout", p.timeout);
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(o.get(), "error", p.result.error);
    if (p.state == MarksProgress::State::Done) {
        ev::Persistent res(marksToJs(p.result));
        o.set(ev::setProperty(o.get(), "result", res.get()));
    } else {
        o.set(ev::setProperty(o.get(), "result", ev::null()));
    }
    return o.get();
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
    reads.function("cancel", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("marks.reads.cancel(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopMarksRead(id);
        return ev::undefined();
    }, 1);
    /// Stop it and never poll again — an input removed while its sound was
    /// still being read. Separate from `cancel` for `probes.forget`'s reason:
    /// the two differ in whether anybody is going to be told.
    reads.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("marks.reads.forget(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        abandonMarksRead(id);
        return ev::undefined();
    }, 1);
}

} // namespace ffmpegbro
