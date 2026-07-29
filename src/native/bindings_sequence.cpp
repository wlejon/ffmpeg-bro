// `bro.ffmpeg.sequences`, `frameNames`, `hasFramePattern`, `concatList` and
// `tempPath` — turning a drop of paths into inputs.
//
// Five calls and two properties over ffmpeg_sequence.h, which is where the
// decision they are the surface of is argued: a folder of numbered stills is
// one `-i` with a pattern in it, and a run of files read end to end is one `-i`
// with a list file behind it. Both are *assembled* before libavformat can be
// asked anything, so the assembling is native and the UI only ever sees the
// answer — which is what keeps the rules about where the number is, what a gap
// means and when padding matters in one place, rather than half of them here
// and half in JavaScript.
//
// `tempPath` shares the file because the assembling is what mostly wants one: a
// `concat` list has to be on disk before it can be an input, and ui/sequence.js
// writes one as `concatList(tempPath(…), entries)`. Its other callers are
// preview renders that are thrown away.

#include "bindings_install.h"

#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_sequence.h"

#include <quickjs.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

// ── files that are one input ───────────────────────────────────────────────
//
// A drop of three hundred numbered PNGs is one `-i`, not three hundred, and
// working that out is the single most-used path into image sequences. What is
// exposed is the *scan* rather than a directory listing, because the guess and
// its refusals belong in one place: see ffmpeg_sequence.h for the rules.

JSValue js_sequences(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "sequences(paths) requires paths");
    std::vector<std::string> paths;
    if (JS_IsString(argv[0])) {
        const char* one = JS_ToCString(ctx, argv[0]);
        if (!one) return JS_EXCEPTION;
        paths.emplace_back(one);
        JS_FreeCString(ctx, one);
    } else {
        const uint32_t n = arrayLength(ctx, argv[0]);
        for (uint32_t i = 0; i < n; ++i) {
            JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
            const char* one = JS_ToCString(ctx, v);
            if (one) { paths.emplace_back(one); JS_FreeCString(ctx, one); }
            JS_FreeValue(ctx, v);
        }
    }

    const SequenceScan scan = scanForSequences(paths);
    JSValue out = JS_NewObject(ctx);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& q : scan.sequences) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "dir", q.dir);
        setStr(ctx, o, "pattern", q.pattern);
        setStr(ctx, o, "prefix", q.prefix);
        setStr(ctx, o, "suffix", q.suffix);
        setStr(ctx, o, "first", q.first);
        JS_SetPropertyStr(ctx, o, "digits", JS_NewInt32(ctx, q.digits));
        JS_SetPropertyStr(ctx, o, "start", JS_NewInt64(ctx, q.start));
        JS_SetPropertyStr(ctx, o, "end", JS_NewInt64(ctx, q.end));
        JS_SetPropertyStr(ctx, o, "count", JS_NewInt32(ctx, q.count));
        JS_SetPropertyStr(ctx, o, "missing", JS_NewInt32(ctx, q.missing));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    JS_SetPropertyStr(ctx, out, "sequences", arr);
    JSValue singles = JS_NewArray(ctx);
    i = 0;
    for (const auto& one : scan.singles)
        JS_SetPropertyUint32(ctx, singles, i++,
                             JS_NewStringLen(ctx, one.data(), one.size()));
    JS_SetPropertyStr(ctx, out, "singles", singles);
    return out;
}

JSValue js_concatList(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "concatList(path, files) requires a path and files");
    const char* path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    // Either a path or `{ path, duration }`. The duration is worth having and
    // is not decoration: without one the concat demuxer reports no length at
    // all until something has read to the end of the last file — see
    // ffmpeg_sequence.h.
    std::vector<ConcatEntry> files;
    const uint32_t n = arrayLength(ctx, argv[1]);
    for (uint32_t i = 0; i < n; ++i) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[1], i);
        ConcatEntry entry;
        if (JS_IsObject(v)) {
            entry.path = strProp(ctx, v, "path", "");
            entry.duration = numProp(ctx, v, "duration", 0);
        } else if (const char* one = JS_ToCString(ctx, v)) {
            entry.path = one;
            JS_FreeCString(ctx, one);
        }
        if (!entry.path.empty()) files.push_back(std::move(entry));
        JS_FreeValue(ctx, v);
    }
    std::string err;
    const bool ok = writeConcatList(path, files, &err);
    const std::string written = path;
    JS_FreeCString(ctx, path);
    if (!ok) return JS_ThrowTypeError(ctx, "%s", err.c_str());
    return JS_NewStringLen(ctx, written.data(), written.size());
}

} // namespace

void installSequences(Table& ns) {
    ns.function("tempPath", [](JSContext* ctx, JSValue name) {
        if (!JS_IsString(name))
            return JS_ThrowTypeError(ctx, "tempPath(name) requires a name");
        const char* s = JS_ToCString(ctx, name);
        if (!s) return JS_EXCEPTION;
        const std::string out = tempPath(s);
        JS_FreeCString(ctx, s);
        return JS_NewStringLen(ctx, out.data(), out.size());
    });

    // What a drop of files and folders amounts to, and the two things that
    // make an assembled input out of the answer. `globPatterns` is the one
    // capability here that cannot be enumerated and is asked by trying — see
    // ffmpeg_sequence.h.
    ns.function("sequences", js_sequences, 1);
    ns.function("frameNames", [](JSContext* ctx, JSValue pattern, JSValue startArg,
                                 JSValue countArg) {
        if (!JS_IsString(pattern))
            return JS_ThrowTypeError(ctx,
                                     "frameNames(pattern, start, count) requires a pattern");
        const char* p = JS_ToCString(ctx, pattern);
        if (!p) return JS_EXCEPTION;
        int64_t start = 1;
        int32_t count = 3;
        // Absent and `undefined` are the same thing here, which is the rule the
        // rest of this surface reads its arguments by. It used to be `argc`,
        // and an explicit `undefined` therefore used to convert to zero rather
        // than take the default — a difference no caller has ever asked for and
        // the wrong answer of the two.
        if (!JS_IsUndefined(startArg)) JS_ToInt64(ctx, &start, startArg);
        if (!JS_IsUndefined(countArg)) JS_ToInt32(ctx, &count, countArg);
        std::string err;
        const auto names = frameFilenames(p, start, std::max(0, std::min(count, 4096)), &err);
        JS_FreeCString(ctx, p);
        if (names.empty() && !err.empty()) return JS_ThrowTypeError(ctx, "%s", err.c_str());
        JSValue arr = JS_NewArray(ctx);
        uint32_t i = 0;
        for (const auto& n : names)
            JS_SetPropertyUint32(ctx, arr, i++, JS_NewStringLen(ctx, n.data(), n.size()));
        return arr;
    });
    ns.function("hasFramePattern", [](JSContext* ctx, JSValue path) {
        if (!JS_IsString(path)) return JS_FALSE;
        const char* s = JS_ToCString(ctx, path);
        if (!s) return JS_EXCEPTION;
        const bool yes = hasFramePattern(s);
        JS_FreeCString(ctx, s);
        return JS_NewBool(ctx, yes);
    });
    ns.function("concatList", js_concatList, 2);
    ns.value("imageExtensions", stringsToJs(ns.context(), imageExtensions()));
    ns.value("globPatterns", globPatternsSupported());
}

} // namespace ffmpegbro
