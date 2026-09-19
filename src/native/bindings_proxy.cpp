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

#include <embed/embed.h>

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

bronze::Value proxyToJs(const ProxyStatus& p) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setNum(o.get(), "id", static_cast<double>(p.id));
    setStr(o.get(), "label", p.label);
    setStr(o.get(), "path", p.path);
    setStr(o.get(), "state", proxyStateName(p.state));
    setNum(o.get(), "progress", p.progress);
    setNum(o.get(), "position", p.position);
    setNum(o.get(), "span", p.span);
    setNum(o.get(), "elapsedSec", p.elapsedSec);
    setNum(o.get(), "frames", static_cast<double>(p.frames));
    setNum(o.get(), "bytes", static_cast<double>(p.bytes));
    setStr(o.get(), "error", p.error);
    return o.get();
}

/// bro.ffmpeg.proxy.start({ path, input, height, label }) → its number.
///
/// `input` is a path or the same input object every other call here takes, so a
/// proxy of a windowed or force-demuxed input is describable — read through
/// `inputFromJs`, which is the one reader of that shape.
bronze::Value js_proxyStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty() || !ev::isObject(args[0]))
        return ev::throwTypeError("proxy.start(request) requires an object");

    ProxyRequest r;
    r.path = strProp(args[0], "path", "");
    r.label = strProp(args[0], "label", "");
    r.height = static_cast<int>(numProp(args[0], "height", 720));

    bronze::Value in = ev::getProperty(args[0], "input");
    if (ev::isObject(in)) {
        r.input = inputFromJs(in);
    } else if (ev::isString(in)) {
        r.input.path = ev::toUtf8(in);
    }

    std::string err;
    const uint64_t id = startProxy(r, &err);
    if (!id) return ev::throwTypeError("cannot make a proxy: " + err);
    return ev::fromDouble(static_cast<double>(id));
}

} // namespace

void installProxy(Table& ns) {
    Table proxy(ns, "proxy");
    proxy.function("start", js_proxyStart, 1);
    proxy.function("list", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        namespace ev = bronze::embed;
        const std::vector<ProxyStatus> all = proxyList();
        ev::Persistent arr(createArray());
        uint32_t i = 0;
        for (const ProxyStatus& p : all) {
            ev::Persistent o(proxyToJs(p));
            arr.set(ev::setElement(arr.get(), i++, o.get()));
        }
        return arr.get();
    });
    proxy.function("status", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        uint64_t id = 0;
        if (!args.empty() && ev::isNumber(args[0])) id = static_cast<uint64_t>(ev::toDouble(args[0]));
        return proxyToJs(proxyStatus(id));
    }, 1);
    proxy.function("stop", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        uint64_t id = 0;
        if (!args.empty() && ev::isNumber(args[0])) id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopProxy(id);
        return ev::undefined();
    }, 1);
    proxy.function("clearFinished", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        clearFinishedProxies();
        return bronze::embed::undefined();
    });
}

} // namespace ffmpegbro
