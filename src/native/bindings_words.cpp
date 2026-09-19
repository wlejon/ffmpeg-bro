// `bro.ffmpeg.words` — what was said in a soundtrack, one word at a time.
//
// The third question on this surface that is not a part of ffmpeg's own model,
// and it is here for `bindings_marks.cpp`'s reason: the seam it needs is libav's
// — an `-i` with its forced demuxer, its option bag and its window, read the way
// this application reads every other input and resampled by `swr`. What reads
// the samples once they are decoded is Parakeet, through brosoundml;
// `src/native/spoken_words.h` carries that reasoning.
//
// **Why this is not `transcribe` with an option.** Two models on one surface
// looks like duplication and is not, because the two answer differently shaped
// questions and a flag would hide that. Whisper times a *segment* — a phrase of
// several seconds, deliberately, because "claiming one inside a six-second
// phrase would be a measurement nothing made" — and this times a **word**.
// Everything this application does with speech is built on the second:
// `WORD_PAD` in `ui/library.js`, `at` and `says` in `ui/phrase.js`, the moment
// `supercut/cuts.js` cuts around. A single call whose result shape changed with
// a string option would be one call making two different promises about how well
// a time is known. So there are two, named after what each produces.
//
// Everything else about this table is `bindings_transcribe.cpp`'s, including the
// rule that looks like a bug: **a poll of a running read answers with the words
// so far**, so a terminal answer is not handed over exactly once and `forget` is
// required rather than tidy. That file states why at length.
//
// **The weights are not shipped and their absence is refused by name.** There is
// no `available()`, for the same reason there is none on `transcribe`: the
// question is not "was this binary built with speech" but "is there a model on
// this disk", which is a property of a path the caller supplies and is answered
// where it is asked.

#include "bindings_install.h"

#include "bindings_spec.h"      // inputFromJs
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_input.h"
#include "spoken_words.h"

#include <embed/embed.h>

#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

bronze::Value wordToJs(const SpokenWord& w) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    // On the INPUT's clock, in seconds — the same clock `clip.inPoint` is
    // written against, so `timelineTime` in `ui/project.js` carries it onto the
    // timeline through a trim. The same rule a mark, a segment and a telemetry
    // sample obey.
    setNum(o.get(), "start", w.start);
    // Where the *next* token arrived rather than where the speaker stopped. See
    // spoken_words.h: the start is a measurement and this is a bound.
    setNum(o.get(), "end", w.end);
    setStr(o.get(), "text", w.text);
    return o.get();
}

bronze::Value resultToJs(const SpokenWords& t, int64_t from) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    // Where `words` starts in the whole transcript, which is 0 unless the caller
    // asked for a tail. Answered always, so a caller that adds `since` later does
    // not have to find out that the shape changed under it.
    setNum(o.get(), "from", static_cast<double>(from));
    setNum(o.get(), "streamIndex", t.streamIndex);
    setNum(o.get(), "duration", t.duration);
    // How far down the recording the reading has got. The one number that makes
    // a partial transcript honest: without it a caller cannot tell "nothing was
    // said in the last hour" from "the last hour has not been read".
    setNum(o.get(), "read", t.read);
    // Exact even when the list is capped, so a truncated transcript cannot
    // understate what the recording held. `words.length` is what was kept.
    setNum(o.get(), "total", static_cast<double>(t.total));
    setBool(o.get(), "truncated", t.truncated);

    ev::Persistent arr(createArray());
    uint32_t n = 0;
    for (const SpokenWord& w : t.words) {
        ev::Persistent item(wordToJs(w));
        arr.set(ev::setElement(arr.get(), n++, item.get()));
    }
    o.set(ev::setProperty(o.get(), "words", arr.get()));
    return o.get();
}

/// The `-i` and the policy, out of whatever the caller passed. The same reader
/// `probes.start`, `data.reads.start`, `marks.reads.start` and
/// `transcribe.reads.start` use, for the same reason: a soundtrack read out of a
/// file opened with a forced demuxer or an `-ss` is a different soundtrack from
/// the same file opened with the defaults.
bool readArgs(std::span<const bronze::Value> args, MediaInput* in,
              SpokenWordsOptions* opts, std::string* err) {
    namespace ev = bronze::embed;
    if (args.empty()) {
        *err = "words.reads.start(input, opts) needs a path or an input";
        return false;
    }
    if (ev::isObject(args[0])) {
        *in = inputFromJs(args[0]);
    } else if (ev::isString(args[0])) {
        in->path = ev::toUtf8(args[0]);
    } else {
        *err = "words.reads.start(input, opts) needs a path or an input";
        return false;
    }
    if (in->path.empty()) {
        *err = "words.reads.start() needs a path or an input";
        return false;
    }

    if (args.size() >= 2 && ev::isObject(args[1])) {
        bronze::Value o = args[1];
        opts->modelDir = strProp(o, "model", "");
        opts->device = strProp(o, "device", "");
    }
    if (opts->modelDir.empty()) {
        // Named here rather than discovered on the thread, because this one is a
        // programming mistake rather than a missing file and a caller should hear
        // about it at the call.
        *err = "words.reads.start() needs opts.model — a directory holding a "
               "Parakeet checkpoint (brosoundml's scripts/download-parakeet.sh puts "
               "one there)";
        return false;
    }
    return true;
}

// bro.ffmpeg.words.reads.start(path | input, opts)
//
// `opts.model` is a directory holding config.json, model.safetensors and
// tokenizer.json. `opts.device` is 'cuda' | 'cpu' | 'metal', or absent for the
// best available; it is the same vocabulary `bro.stt`'s loaders take, so nobody
// learns a second one. There is no language here — Parakeet is English and has
// nothing to be told.
bronze::Value js_wordsStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    MediaInput in;
    SpokenWordsOptions opts;
    std::string err;
    if (!readArgs(args, &in, &opts, &err)) return ev::throwTypeError(err);
    return ev::fromDouble(static_cast<double>(startSpokenWords(in, opts)));
}

const char* stateName(SpokenWordsProgress::State s) {
    switch (s) {
        case SpokenWordsProgress::State::Reading: return "reading";
        case SpokenWordsProgress::State::Done:    return "done";
        case SpokenWordsProgress::State::Failed:  return "failed";
        case SpokenWordsProgress::State::Stopped: return "stopped";
    }
    return "reading";
}

// bro.ffmpeg.words.reads.poll(id, opts) — where it has got to, and the words.
//
// `null` only for an id nothing knows about, which here means one that was never
// started or has been forgotten. Unlike every read on this surface but
// `transcribe`, a finished one keeps answering.
//
// **`opts.since` is how a frame loop polls this.** Without it the answer carries
// every word decoded so far, which costs more the longer the read runs — 5.7 ms
// a poll at the twenty-four thousand words a six-hour recording ends with, sixty
// times a second, for words the caller already has. Pass the number already held
// and the answer is the ones after it, with `result.from` saying where it starts
// and `result.total` giving the count either way. `spoken_words.h` has the
// measurements.
bronze::Value js_wordsPoll(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty() || !ev::isNumber(args[0]))
        return ev::throwTypeError("words.reads.poll(id) requires an id");
    uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));

    int64_t since = 0;
    if (args.size() >= 2 && ev::isObject(args[1]))
        since = static_cast<int64_t>(numProp(args[1], "since", 0.0));

    SpokenWordsProgress p;
    if (!spokenWordsProgress(id, p, since)) return ev::null();

    ev::Persistent o(ev::createObject());
    setStr(o.get(), "state", stateName(p.state));
    setBool(o.get(), "reading", p.state == SpokenWordsProgress::State::Reading);
    setNum(o.get(), "elapsed", p.elapsed);
    setNum(o.get(), "timeout", p.timeout);
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(o.get(), "error", p.error);
    // Always, including while reading and including after a failure — a run that
    // died an hour in still transcribed an hour, and throwing that away would
    // make a failure cost more than it has to.
    ev::Persistent res(resultToJs(p.result, p.from));
    o.set(ev::setProperty(o.get(), "result", res.get()));
    return o.get();
}

} // namespace

void installWords(Table& ns) {
    Table words(ns, "words");

    Table reads(words, "reads");
    reads.function("start", js_wordsStart, 2);
    reads.function("poll", js_wordsPoll, 1);
    /// Stop at the next window boundary, keeping what has been read. Real: the
    /// flag is polled per encoder frame by Parakeet's own greedy loop as well as
    /// by libav's interrupt callback, so a press lands inside the decode rather
    /// than at the end of it.
    reads.function("cancel", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("words.reads.cancel(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopSpokenWords(id);
        return ev::undefined();
    }, 1);
    /// Stop it and drop the words. **Required**, unlike most reads on this
    /// surface: because a finished read keeps answering, nothing else releases it.
    reads.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("words.reads.forget(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        abandonSpokenWords(id);
        return ev::undefined();
    }, 1);
}

} // namespace ffmpegbro
