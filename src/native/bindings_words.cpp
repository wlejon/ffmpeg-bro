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

#include <quickjs.h>

#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

JSValue wordToJs(JSContext* ctx, const SpokenWord& w) {
    JSValue o = JS_NewObject(ctx);
    // On the INPUT's clock, in seconds — the same clock `clip.inPoint` is
    // written against, so `timelineTime` in `ui/project.js` carries it onto the
    // timeline through a trim. The same rule a mark, a segment and a telemetry
    // sample obey.
    JS_SetPropertyStr(ctx, o, "start", JS_NewFloat64(ctx, w.start));
    // Where the *next* token arrived rather than where the speaker stopped. See
    // spoken_words.h: the start is a measurement and this is a bound.
    JS_SetPropertyStr(ctx, o, "end", JS_NewFloat64(ctx, w.end));
    JS_SetPropertyStr(ctx, o, "text", JS_NewString(ctx, w.text.c_str()));
    return o;
}

JSValue resultToJs(JSContext* ctx, const SpokenWords& t) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "streamIndex", JS_NewInt32(ctx, t.streamIndex));
    JS_SetPropertyStr(ctx, o, "duration", JS_NewFloat64(ctx, t.duration));
    // How far down the recording the reading has got. The one number that makes
    // a partial transcript honest: without it a caller cannot tell "nothing was
    // said in the last hour" from "the last hour has not been read".
    JS_SetPropertyStr(ctx, o, "read", JS_NewFloat64(ctx, t.read));
    // Exact even when the list is capped, so a truncated transcript cannot
    // understate what the recording held. `words.length` is what was kept.
    JS_SetPropertyStr(ctx, o, "total", JS_NewInt64(ctx, t.total));
    JS_SetPropertyStr(ctx, o, "truncated", JS_NewBool(ctx, t.truncated));

    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (const SpokenWord& w : t.words)
        JS_SetPropertyUint32(ctx, arr, n++, wordToJs(ctx, w));
    JS_SetPropertyStr(ctx, o, "words", arr);
    return o;
}

/// The `-i` and the policy, out of whatever the caller passed. The same reader
/// `probes.start`, `data.reads.start`, `marks.reads.start` and
/// `transcribe.reads.start` use, for the same reason: a soundtrack read out of a
/// file opened with a forced demuxer or an `-ss` is a different soundtrack from
/// the same file opened with the defaults.
bool readArgs(JSContext* ctx, int argc, JSValueConst* argv, MediaInput* in,
              SpokenWordsOptions* opts) {
    if (argc < 1) {
        JS_ThrowTypeError(ctx,
            "words.reads.start(input, opts) needs a path or an input");
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
        JS_ThrowTypeError(ctx, "words.reads.start() needs a path or an input");
        return false;
    }

    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValueConst o = argv[1];
        opts->modelDir = strProp(ctx, o, "model", "");
        opts->device = strProp(ctx, o, "device", "");
    }
    if (opts->modelDir.empty()) {
        // Named here rather than discovered on the thread, because this one is a
        // programming mistake rather than a missing file and a caller should hear
        // about it at the call.
        JS_ThrowTypeError(ctx,
            "words.reads.start() needs opts.model — a directory holding a "
            "Parakeet checkpoint (brosoundml's scripts/download-parakeet.sh puts "
            "one there)");
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
JSValue js_wordsStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    MediaInput in;
    SpokenWordsOptions opts;
    if (!readArgs(ctx, argc, argv, &in, &opts)) return JS_EXCEPTION;
    return JS_NewInt64(ctx, int64_t(startSpokenWords(in, opts)));
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

// bro.ffmpeg.words.reads.poll(id) — where it has got to, and the words so far.
//
// `null` only for an id nothing knows about, which here means one that was never
// started or has been forgotten. Unlike every read on this surface but
// `transcribe`, a finished one keeps answering.
JSValue js_wordsPoll(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "words.reads.poll(id) requires an id");
    int64_t id = 0;
    if (JS_ToInt64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;

    SpokenWordsProgress p;
    if (!spokenWordsProgress(uint64_t(id), p)) return JS_NULL;

    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "state", stateName(p.state));
    JS_SetPropertyStr(ctx, o, "reading",
                      JS_NewBool(ctx, p.state == SpokenWordsProgress::State::Reading));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, p.elapsed));
    JS_SetPropertyStr(ctx, o, "timeout", JS_NewFloat64(ctx, p.timeout));
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(ctx, o, "error", p.error);
    // Always, including while reading and including after a failure — a run that
    // died an hour in still transcribed an hour, and throwing that away would
    // make a failure cost more than it has to.
    JS_SetPropertyStr(ctx, o, "result", resultToJs(ctx, p.result));
    return o;
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
    reads.function("cancel", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        stopSpokenWords(uint64_t(id));
        return JS_UNDEFINED;
    });
    /// Stop it and drop the words. **Required**, unlike most reads on this
    /// surface: because a finished read keeps answering, nothing else releases it.
    reads.function("forget", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        abandonSpokenWords(uint64_t(id));
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
