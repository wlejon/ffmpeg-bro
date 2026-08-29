// `bro.ffmpeg.proxy` — making a small all-keyframe copy of an input, so that a
// hand dragging over it gets a picture inside a frame.
//
// The same five calls `fetch` has next door, and for the same reason: there can
// be several, so `start` hands back a number, `list` answers with all of them
// rather than with "the current one", and `stop` takes that number. What is
// different is the argument. A fetch is given a **render spec**, because a copy
// is describable in the object `ui/export/spec.js` already builds; a proxy is
// given four fields, because nothing in a render spec describes one. There is
// no composite here, no canvas, no range, no stream list and no muxer choice —
// the picture, smaller, with every frame a keyframe, is the whole of it, and a
// spec that had to be handed over with most of it ignored would be an invitation
// to hand this the render somebody meant to press Render on.
//
// proxy_queue.h is the measurement that made this exist and the reason it is
// neither a render nor a fetch.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "proxy_queue.h"

#include <quickjs.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

const char* proxyStateName(ProxyStatus::State s) {
    switch (s) {
        case ProxyStatus::State::Queued:    return "queued";
        case ProxyStatus::State::Running:   return "running";
        case ProxyStatus::State::Done:      return "done";
        case ProxyStatus::State::Failed:    return "failed";
        case ProxyStatus::State::Cancelled: return "cancelled";
    }
    return "queued";
}

JSValue proxyToJs(JSContext* ctx, const ProxyStatus& p) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "id", JS_NewInt64(ctx, static_cast<int64_t>(p.id)));
    setStr(ctx, o, "label", p.label);
    setStr(ctx, o, "path", p.path);
    setStr(ctx, o, "state", proxyStateName(p.state));
    JS_SetPropertyStr(ctx, o, "progress", JS_NewFloat64(ctx, p.progress));
    JS_SetPropertyStr(ctx, o, "position", JS_NewFloat64(ctx, p.position));
    JS_SetPropertyStr(ctx, o, "span", JS_NewFloat64(ctx, p.span));
    JS_SetPropertyStr(ctx, o, "elapsedSec", JS_NewFloat64(ctx, p.elapsedSec));
    JS_SetPropertyStr(ctx, o, "frames", JS_NewInt64(ctx, p.frames));
    JS_SetPropertyStr(ctx, o, "bytes", JS_NewInt64(ctx, p.bytes));
    setStr(ctx, o, "error", p.error);
    return o;
}

/// bro.ffmpeg.proxy.start({ path, input, height, label }) → its number.
///
/// `input` is a path or the same input object every other call here takes, so a
/// proxy of a windowed or force-demuxed input is describable — read through
/// `inputFromJs`, which is the one reader of that shape.
JSValue js_proxyStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "proxy.start(request) requires an object");

    ProxyRequest r;
    r.path = strProp(ctx, argv[0], "path", "");
    r.label = strProp(ctx, argv[0], "label", "");
    r.height = static_cast<int>(numProp(ctx, argv[0], "height", 720));

    JSValue in = JS_GetPropertyStr(ctx, argv[0], "input");
    if (JS_IsObject(in)) {
        r.input = inputFromJs(ctx, in);
    } else if (JS_IsString(in)) {
        const char* path = JS_ToCString(ctx, in);
        if (path) { r.input.path = path; JS_FreeCString(ctx, path); }
    }
    JS_FreeValue(ctx, in);

    std::string err;
    const uint64_t id = startProxy(r, &err);
    if (!id) return JS_ThrowTypeError(ctx, "cannot make a proxy: %s", err.c_str());
    return JS_NewInt64(ctx, static_cast<int64_t>(id));
}

} // namespace

void installProxy(Table& ns) {
    Table proxy(ns, "proxy");
    proxy.function("start", js_proxyStart, 1);
    proxy.function("list", [](JSContext* ctx) {
        const std::vector<ProxyStatus> all = proxyList();
        JSValue arr = JS_NewArray(ctx);
        uint32_t i = 0;
        for (const ProxyStatus& p : all) JS_SetPropertyUint32(ctx, arr, i++, proxyToJs(ctx, p));
        return arr;
    });
    proxy.function("status", [](JSContext* ctx, int64_t id) {
        return proxyToJs(ctx, proxyStatus(static_cast<uint64_t>(id)));
    });
    proxy.function("stop", [](JSContext*, int64_t id) {
        stopProxy(static_cast<uint64_t>(id));
        return JS_UNDEFINED;
    });
    proxy.function("clearFinished", [](JSContext*) {
        clearFinishedProxies();
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
