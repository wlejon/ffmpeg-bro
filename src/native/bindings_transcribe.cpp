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

#include <quickjs.h>

#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

JSValue segmentToJs(JSContext* ctx, const TranscriptSegment& s) {
    JSValue o = JS_NewObject(ctx);
    // On the INPUT's clock, in seconds — the same clock `clip.inPoint` is
    // written against, so `timelineTime` in `ui/project.js` carries it onto the
    // timeline through a trim. The same rule a mark and a telemetry sample obey.
    JS_SetPropertyStr(ctx, o, "start", JS_NewFloat64(ctx, s.start));
    JS_SetPropertyStr(ctx, o, "end", JS_NewFloat64(ctx, s.end));
    JS_SetPropertyStr(ctx, o, "text", JS_NewString(ctx, s.text.c_str()));
    return o;
}

JSValue transcriptToJs(JSContext* ctx, const Transcript& t) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "streamIndex", JS_NewInt32(ctx, t.streamIndex));
    JS_SetPropertyStr(ctx, o, "duration", JS_NewFloat64(ctx, t.duration));
    // How far down the recording the reading has got. The one number that makes
    // a partial transcript honest: without it a caller cannot tell "nothing was
    // said in the last hour" from "the last hour has not been read".
    JS_SetPropertyStr(ctx, o, "read", JS_NewFloat64(ctx, t.read));
    // Exact even when the list is capped, so a truncated transcript cannot
    // understate what the recording held. `segments.length` is what was kept.
    JS_SetPropertyStr(ctx, o, "total", JS_NewInt64(ctx, t.total));
    JS_SetPropertyStr(ctx, o, "truncated", JS_NewBool(ctx, t.truncated));

    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (const TranscriptSegment& s : t.segments)
        JS_SetPropertyUint32(ctx, arr, n++, segmentToJs(ctx, s));
    JS_SetPropertyStr(ctx, o, "segments", arr);
    return o;
}

/// The `-i` and the policy, out of whatever the caller passed. The same reader
/// `probes.start`, `data.reads.start` and `marks.reads.start` use, for the same
/// reason: a soundtrack read out of a file opened with a forced demuxer or an
/// `-ss` is a different soundtrack from the same file opened with the defaults.
bool readArgs(JSContext* ctx, int argc, JSValueConst* argv, MediaInput* in,
              TranscribeOptions* opts) {
    if (argc < 1) {
        JS_ThrowTypeError(ctx,
            "transcribe.reads.start(input, opts) needs a path or an input");
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
        JS_ThrowTypeError(ctx, "transcribe.reads.start() needs a path or an input");
        return false;
    }

    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValueConst o = argv[1];
        opts->modelDir = strProp(ctx, o, "model", "");
        opts->language = strProp(ctx, o, "language", opts->language);
        opts->translate = boolProp(ctx, o, "translate", opts->translate);
        opts->device = strProp(ctx, o, "device", "");
    }
    if (opts->modelDir.empty()) {
        // Named here rather than discovered on the thread, because this one is
        // a programming mistake rather than a missing file and a caller should
        // hear about it at the call.
        JS_ThrowTypeError(ctx,
            "transcribe.reads.start() needs opts.model — a directory holding a "
            "Whisper checkpoint (brosoundml's scripts/download-whisper.sh puts "
            "one there)");
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
JSValue js_transcribeStart(JSContext* ctx, JSValueConst, int argc,
                           JSValueConst* argv) {
    MediaInput in;
    TranscribeOptions opts;
    if (!readArgs(ctx, argc, argv, &in, &opts)) return JS_EXCEPTION;
    return JS_NewInt64(ctx, int64_t(startTranscribe(in, opts)));
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
JSValue js_transcribePoll(JSContext* ctx, JSValueConst, int argc,
                          JSValueConst* argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "transcribe.reads.poll(id) requires an id");
    int64_t id = 0;
    if (JS_ToInt64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;

    TranscribeProgress p;
    if (!transcribeProgress(uint64_t(id), p)) return JS_NULL;

    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "state", stateName(p.state));
    JS_SetPropertyStr(ctx, o, "reading",
                      JS_NewBool(ctx, p.state == TranscribeProgress::State::Reading));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, p.elapsed));
    JS_SetPropertyStr(ctx, o, "timeout", JS_NewFloat64(ctx, p.timeout));
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(ctx, o, "error", p.error);
    // Always, including while reading and including after a failure — a run that
    // died an hour in still transcribed an hour, and throwing that away would
    // make a failure cost more than it has to.
    JS_SetPropertyStr(ctx, o, "result", transcriptToJs(ctx, p.transcript));
    return o;
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
    reads.function("cancel", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        stopTranscribe(uint64_t(id));
        return JS_UNDEFINED;
    });
    /// Stop it and drop the transcript. **Required**, unlike the other reads on
    /// this surface: because a finished read keeps answering, nothing else ever
    /// releases it.
    reads.function("forget", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        abandonTranscribe(uint64_t(id));
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
