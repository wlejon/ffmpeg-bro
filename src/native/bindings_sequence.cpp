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

#include <embed/embed.h>

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

bronze::Value js_sequences(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty()) return ev::throwTypeError("sequences(paths) requires paths");
    std::vector<std::string> paths;
    if (ev::isString(args[0])) {
        paths.push_back(ev::toUtf8(args[0]));
    } else if (isArray(args[0])) {
        const uint32_t n = arrayLength(args[0]);
        for (uint32_t i = 0; i < n; ++i) {
            bronze::Value v = ev::getElement(args[0], i);
            if (ev::isString(v)) {
                paths.push_back(ev::toUtf8(v));
            }
        }
    }

    const SequenceScan scan = scanForSequences(paths);
    ev::Persistent out(ev::createObject());
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& q : scan.sequences) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "dir", q.dir);
        setStr(o.get(), "pattern", q.pattern);
        setStr(o.get(), "prefix", q.prefix);
        setStr(o.get(), "suffix", q.suffix);
        setStr(o.get(), "first", q.first);
        setNum(o.get(), "digits", q.digits);
        setNum(o.get(), "start", static_cast<double>(q.start));
        setNum(o.get(), "end", static_cast<double>(q.end));
        setNum(o.get(), "count", q.count);
        setNum(o.get(), "missing", q.missing);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    out.set(ev::setProperty(out.get(), "sequences", arr.get()));
    ev::Persistent singles(stringsToJs(scan.singles));
    out.set(ev::setProperty(out.get(), "singles", singles.get()));
    return out.get();
}

bronze::Value js_concatList(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.size() < 2 || !ev::isString(args[0]))
        return ev::throwTypeError("concatList(path, files) requires a path and files");
    const std::string path = ev::toUtf8(args[0]);
    // Either a path or `{ path, duration }`. The duration is worth having and
    // is not decoration: without one the concat demuxer reports no length at
    // all until something has read to the end of the last file — see
    // ffmpeg_sequence.h.
    std::vector<ConcatEntry> files;
    if (isArray(args[1])) {
        const uint32_t n = arrayLength(args[1]);
        for (uint32_t i = 0; i < n; ++i) {
            bronze::Value v = ev::getElement(args[1], i);
            ConcatEntry entry;
            if (ev::isObject(v)) {
                entry.path = strProp(v, "path", "");
                entry.duration = numProp(v, "duration", 0);
            } else if (ev::isString(v)) {
                entry.path = ev::toUtf8(v);
            }
            if (!entry.path.empty()) files.push_back(std::move(entry));
        }
    }
    std::string err;
    const bool ok = writeConcatList(path, files, &err);
    if (!ok) return ev::throwTypeError(err);
    return ev::fromUtf8(path);
}

} // namespace

void installSequences(Table& ns) {
    ns.function("tempPath", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isString(args[0]))
            return ev::throwTypeError("tempPath(name) requires a name");
        const std::string out = tempPath(ev::toUtf8(args[0]));
        return ev::fromUtf8(out);
    }, 1);

    // What a drop of files and folders amounts to, and the two things that
    // make an assembled input out of the answer. `globPatterns` is the one
    // capability here that cannot be enumerated and is asked by trying — see
    // ffmpeg_sequence.h.
    ns.function("sequences", js_sequences, 1);
    ns.function("frameNames", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isString(args[0]))
            return ev::throwTypeError("frameNames(pattern, start, count) requires a pattern");
        const std::string p = ev::toUtf8(args[0]);
        int64_t start = 1;
        int32_t count = 3;
        // Absent and `undefined` are the same thing here, which is the rule the
        // rest of this surface reads its arguments by. It used to be `argc`,
        // and an explicit `undefined` therefore used to convert to zero rather
        // than take the default — a difference no caller has ever asked for and
        // the wrong answer of the two.
        if (args.size() >= 2 && !ev::isUndefined(args[1]) && !ev::isNull(args[1])) {
            if (ev::isNumber(args[1])) start = static_cast<int64_t>(ev::toDouble(args[1]));
        }
        if (args.size() >= 3 && !ev::isUndefined(args[2]) && !ev::isNull(args[2])) {
            if (ev::isNumber(args[2])) count = static_cast<int32_t>(ev::toDouble(args[2]));
        }
        std::string err;
        const auto names = frameFilenames(p, start, std::max(0, std::min(count, 4096)), &err);
        if (names.empty() && !err.empty()) return ev::throwTypeError(err);
        return stringsToJs(names);
    }, 3);
    ns.function("hasFramePattern", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isString(args[0])) return ev::fromBool(false);
        const bool yes = hasFramePattern(ev::toUtf8(args[0]));
        return ev::fromBool(yes);
    }, 1);
    ns.function("concatList", js_concatList, 2);
    ns.value("imageExtensions", stringsToJs(imageExtensions()));
    ns.value("globPatterns", globPatternsSupported());
}

} // namespace ffmpegbro
