// `bro.ffmpeg.transcribe` — what was said in a soundtrack.
//
// The seventh question this surface answers about a particular file, and the
// second one that is not a part of ffmpeg's own model. It is here for exactly
// `bindings_marks.cpp`'s reason: the seam it needs is libav's — an `-i` with its
// forced demuxer, its option bag and its window, read the way this application
// reads every other input and resampled by `swr` — and a second namespace for
// one call whose whole argument is a `MediaInput` would be a second vocabulary
// for the same object. What reads the samples once they are decoded is Whisper,
// through brosoundml; `src/native/transcribe.h` carries that reasoning.
//
// **A poll of a running read answers with the words so far, and that is the
// feature rather than a convenience.** `marks.reads.poll` and `data.reads.poll`
// answer `null` for a result until they are done, because a list of onsets is
// worth nothing until it is the whole list. A transcript is not like that: at
// 4x realtime a six-hour recording is ninety minutes, and one that could only be
// read at the end would be one nobody waits for. So `result` is filled in from
// the first window and grows, `read` says how far down the recording it has got,
// and a search over it is a search over what has arrived.
//
// That makes one rule here different from every other read on this surface, and
// it is worth stating because it looks like a bug: **a terminal answer is NOT
// handed over exactly once.** `async_open.h` forgets an entry the moment its
// result is taken, which is right for a caller that polls until it gets
// something; a caller that polls a *growing* answer on the frame loop would
// otherwise watch the finished transcript vanish on the frame after it finished.
// So the transcript outlives the entry and `poll` keeps answering with it until
// `forget`. The id is the caller's to release, and `ui/transcript.js` releases it.
//
// **Segments rather than columns**, for `bindings_marks.cpp`'s reason and more
// strongly. A segment is a *place with words on it*: read one at a time by a
// search, a list and a jump. Six hours of speech is on the order of seven
// thousand of them, not the hundreds of thousands a waveform bucket array holds,
// so there is nothing here that a typed array would make smaller — only three
// parallel arrays a consumer would have to index in step to describe one thing
// somebody said.
//
// **The weights are not shipped and their absence is refused by name.** There is
// no `available()`: the question a caller actually has is not "was this binary
// built with speech" — it always was — but "is there a model on this disk", and
// that is a property of a *path* the caller supplies. So it is answered where it
// is asked, by the read, with the missing file named. See transcribe.h.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_input.h"
#include "transcribe.h"

#include <embed/embed.h>

#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

bronze::Value segmentToJs(const TranscriptSegment& s) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    // On the INPUT's clock, in seconds — the same clock `clip.inPoint` is
    // written against, so `timelineTime` in `ui/project.js` carries it onto the
    // timeline through a trim. The same rule a mark and a telemetry sample obey.
    setNum(o.get(), "start", s.start);
    setNum(o.get(), "end", s.end);
    setStr(o.get(), "text", s.text);
    return o.get();
}

bronze::Value transcriptToJs(const Transcript& t) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setNum(o.get(), "streamIndex", t.streamIndex);
    setNum(o.get(), "duration", t.duration);
    // How far down the recording the reading has got. The one number that makes
    // a partial transcript honest: without it a caller cannot tell "nothing was
    // said in the last hour" from "the last hour has not been read".
    setNum(o.get(), "read", t.read);
    // Exact even when the list is capped, so a truncated transcript cannot
    // understate what the recording held. `segments.length` is what was kept.
    setNum(o.get(), "total", static_cast<double>(t.total));
    setBool(o.get(), "truncated", t.truncated);

    ev::Persistent arr(createArray());
    uint32_t n = 0;
    for (const TranscriptSegment& s : t.segments) {
        ev::Persistent item(segmentToJs(s));
        arr.set(ev::setElement(arr.get(), n++, item.get()));
    }
    o.set(ev::setProperty(o.get(), "segments", arr.get()));
    return o.get();
}

/// The `-i` and the policy, out of whatever the caller passed. The same reader
/// `probes.start`, `data.reads.start` and `marks.reads.start` use, for the same
/// reason: a soundtrack read out of a file opened with a forced demuxer or an
/// `-ss` is a different soundtrack from the same file opened with the defaults.
bool readArgs(std::span<const bronze::Value> args, MediaInput* in,
              TranscribeOptions* opts, std::string* err) {
    namespace ev = bronze::embed;
    if (args.empty()) {
        *err = "transcribe.reads.start(input, opts) needs a path or an input";
        return false;
    }
    if (ev::isObject(args[0])) {
        *in = inputFromJs(args[0]);
    } else if (ev::isString(args[0])) {
        in->path = ev::toUtf8(args[0]);
    } else {
        *err = "transcribe.reads.start(input, opts) needs a path or an input";
        return false;
    }
    if (in->path.empty()) {
        *err = "transcribe.reads.start() needs a path or an input";
        return false;
    }

    if (args.size() >= 2 && ev::isObject(args[1])) {
        bronze::Value o = args[1];
        opts->modelDir = strProp(o, "model", "");
        opts->language = strProp(o, "language", opts->language);
        opts->translate = boolProp(o, "translate", opts->translate);
        opts->device = strProp(o, "device", "");
    }
    if (opts->modelDir.empty()) {
        // Named here rather than discovered on the thread, because this one is
        // a programming mistake rather than a missing file and a caller should
        // hear about it at the call.
        *err = "transcribe.reads.start() needs opts.model — a directory holding a "
               "Whisper checkpoint (brosoundml's scripts/download-whisper.sh puts "
               "one there)";
        return false;
    }
    return true;
}

// bro.ffmpeg.transcribe.reads.start(path | input, opts)
//
// `opts.model` is a directory holding config.json, model.safetensors,
// vocab.json and merges.txt. `opts.language` is ISO-639-1 and defaults to "en" —
// Whisper is told rather than detecting here. `opts.translate` renders
// non-English speech as English, which is the model's own task and not a second
// pass. `opts.device` is 'cuda' | 'cpu' | 'metal', or absent for the best
// available; it is the same vocabulary `bro.stt`'s loaders take, so nobody
// learns a second one.
bronze::Value js_transcribeStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    MediaInput in;
    TranscribeOptions opts;
    std::string err;
    if (!readArgs(args, &in, &opts, &err)) return ev::throwTypeError(err);
    return ev::fromDouble(static_cast<double>(startTranscribe(in, opts)));
}

const char* stateName(TranscribeProgress::State s) {
    switch (s) {
        case TranscribeProgress::State::Reading: return "reading";
        case TranscribeProgress::State::Done:    return "done";
        case TranscribeProgress::State::Failed:  return "failed";
        case TranscribeProgress::State::Stopped: return "stopped";
    }
    return "reading";
}

// bro.ffmpeg.transcribe.reads.poll(id) — where it has got to, and the words so
// far.
//
// `null` only for an id nothing knows about, which here means one that was never
// started or has been forgotten. Unlike every other read on this surface a
// finished one keeps answering — see the top of this file.
bronze::Value js_transcribePoll(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty() || !ev::isNumber(args[0]))
        return ev::throwTypeError("transcribe.reads.poll(id) requires an id");
    uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));

    TranscribeProgress p;
    if (!transcribeProgress(id, p)) return ev::null();

    ev::Persistent o(ev::createObject());
    setStr(o.get(), "state", stateName(p.state));
    setBool(o.get(), "reading", p.state == TranscribeProgress::State::Reading);
    setNum(o.get(), "elapsed", p.elapsed);
    setNum(o.get(), "timeout", p.timeout);
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(o.get(), "error", p.error);
    // Always, including while reading and including after a failure — a run that
    // died an hour in still transcribed an hour, and throwing that away would
    // make a failure cost more than it has to.
    ev::Persistent res(transcriptToJs(p.transcript));
    o.set(ev::setProperty(o.get(), "result", res.get()));
    return o.get();
}

} // namespace

void installTranscribe(Table& ns) {
    Table transcribe(ns, "transcribe");

    Table reads(transcribe, "reads");
    reads.function("start", js_transcribeStart, 2);
    reads.function("poll", js_transcribePoll, 1);
    /// Stop at the next window boundary, keeping what has been read. Real: the
    /// flag is polled per decoded token by Whisper's own greedy loop as well as
    /// by libav's interrupt callback, so a press lands inside the decode rather
    /// than at the end of it.
    reads.function("cancel", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("transcribe.reads.cancel(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopTranscribe(id);
        return ev::undefined();
    }, 1);
    /// Stop it and drop the transcript. **Required**, unlike the other reads on
    /// this surface: because a finished read keeps answering, nothing else ever
    /// releases it.
    reads.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("transcribe.reads.forget(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        abandonTranscribe(id);
        return ev::undefined();
    }, 1);
}

} // namespace ffmpegbro
