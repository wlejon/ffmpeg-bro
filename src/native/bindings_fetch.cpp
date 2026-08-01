// `bro.ffmpeg.fetch` — pulling a run of packets into a local file while the
// application goes on being used.
//
// The same shape as `render` next door and deliberately not the same thing.
// Both are given a spec — `bindings_spec.h` reads one, and there is one reader
// because a render, a recording, a preview and now a fetch are all described by
// the object `ui/export/spec.js` builds. What differs is what happens to it:
// `render.start` claims the one job slot and composites, encodes and writes,
// and `fetch.start` queues a copy that touches no encoder and no slot at all.
// fetch_queue.h is where the reasoning for that separation lives.
//
// Three calls, and the shape of them says what a fetch is. `start` hands back a
// number because there can be several and a caller has to be able to name its
// own — the same argument `render.start` makes about a job number, with more
// force, since here it is genuinely ambiguous. `list` answers with all of them
// rather than with "the current one", which is the whole difference from
// `render.poll()`. And `stop` takes that number, because "cancel" with no
// argument would have to mean all of them and that is not a press anybody makes.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "fetch_queue.h"

#include <quickjs.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

const char* fetchStateName(FetchStatus::State s) {
    switch (s) {
        case FetchStatus::State::Queued:    return "queued";
        case FetchStatus::State::Running:   return "running";
        case FetchStatus::State::Done:      return "done";
        case FetchStatus::State::Failed:    return "failed";
        case FetchStatus::State::Cancelled: return "cancelled";
    }
    return "queued";
}

JSValue fetchToJs(JSContext* ctx, const FetchStatus& f) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "id", JS_NewInt64(ctx, static_cast<int64_t>(f.id)));
    setStr(ctx, o, "label", f.label);
    setStr(ctx, o, "path", f.path);
    setStr(ctx, o, "state", fetchStateName(f.state));
    JS_SetPropertyStr(ctx, o, "progress", JS_NewFloat64(ctx, f.progress));
    JS_SetPropertyStr(ctx, o, "position", JS_NewFloat64(ctx, f.position));
    JS_SetPropertyStr(ctx, o, "span", JS_NewFloat64(ctx, f.span));
    JS_SetPropertyStr(ctx, o, "elapsedSec", JS_NewFloat64(ctx, f.elapsedSec));
    JS_SetPropertyStr(ctx, o, "packets", JS_NewInt64(ctx, f.packets));
    JS_SetPropertyStr(ctx, o, "bytes", JS_NewInt64(ctx, f.bytes));
    setStr(ctx, o, "error", f.error);
    return o;
}

/// bro.ffmpeg.fetch.start(spec, { label, soon }) → the number it will be known by.
///
/// QuickJS's own signature rather than a typed lambda, for `render.start`'s
/// reason exactly: there is nothing for `Convert<T>` to do with a render spec,
/// and this is given the same one.
JSValue js_fetchStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "fetch.start(spec) requires a spec object");

    ExportSettings s;
    std::string bad;
    if (!outputFromJs(ctx, argv[0], &s, &bad))
        return JS_ThrowTypeError(ctx, "%s", bad.c_str());

    std::string label;
    bool soon = false;
    if (argc >= 2 && JS_IsObject(argv[1])) {
        label = strProp(ctx, argv[1], "label", "");
        soon = boolProp(ctx, argv[1], "soon", false);
    }

    std::string err;
    const uint64_t id = startFetch(s, label, soon, &err);
    // **Refused rather than queued to fail.** A spec this loop cannot perform is
    // a mistake at the call site, and finding out about it a minute later on a
    // worker thread is finding out from a download that never started.
    if (!id) return JS_ThrowTypeError(ctx, "cannot fetch: %s", err.c_str());
    return JS_NewInt64(ctx, static_cast<int64_t>(id));
}

} // namespace

void installFetch(Table& ns) {
    Table fetch(ns, "fetch");
    fetch.function("start", js_fetchStart, 2);
    fetch.function("list", [](JSContext* ctx) {
        const std::vector<FetchStatus> all = fetchList();
        JSValue arr = JS_NewArray(ctx);
        uint32_t i = 0;
        for (const FetchStatus& f : all) JS_SetPropertyUint32(ctx, arr, i++, fetchToJs(ctx, f));
        return arr;
    });
    fetch.function("status", [](JSContext* ctx, int64_t id) {
        return fetchToJs(ctx, fetchStatus(static_cast<uint64_t>(id)));
    });
    fetch.function("stop", [](JSContext*, int64_t id) {
        stopFetch(static_cast<uint64_t>(id));
        return JS_UNDEFINED;
    });
    fetch.function("clearFinished", [](JSContext*) {
        clearFinishedFetches();
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
