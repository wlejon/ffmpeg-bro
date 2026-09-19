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

#include <embed/embed.h>

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

bronze::Value fetchToJs(const FetchStatus& f) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setNum(o.get(), "id", static_cast<double>(f.id));
    setStr(o.get(), "label", f.label);
    setStr(o.get(), "path", f.path);
    setStr(o.get(), "state", fetchStateName(f.state));
    setNum(o.get(), "progress", f.progress);
    setNum(o.get(), "position", f.position);
    setNum(o.get(), "span", f.span);
    setNum(o.get(), "elapsedSec", f.elapsedSec);
    setNum(o.get(), "packets", static_cast<double>(f.packets));
    setNum(o.get(), "bytes", static_cast<double>(f.bytes));
    setStr(o.get(), "error", f.error);
    return o.get();
}

/// bro.ffmpeg.fetch.start(spec, { label, soon }) → the number it will be known by.
///
/// QuickJS's own signature rather than a typed lambda, for `render.start`'s
/// reason exactly: there is nothing for `Convert<T>` to do with a render spec,
/// and this is given the same one.
bronze::Value js_fetchStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty() || !ev::isObject(args[0]))
        return ev::throwTypeError("fetch.start(spec) requires a spec object");

    ExportSettings s;
    std::string bad;
    if (!outputFromJs(args[0], &s, &bad))
        return ev::throwTypeError(bad);

    std::string label;
    bool soon = false;
    if (args.size() >= 2 && ev::isObject(args[1])) {
        label = strProp(args[1], "label", "");
        soon = boolProp(args[1], "soon", false);
    }

    std::string err;
    const uint64_t id = startFetch(s, label, soon, &err);
    // **Refused rather than queued to fail.** A spec this loop cannot perform is
    // a mistake at the call site, and finding out about it a minute later on a
    // worker thread is finding out from a download that never started.
    if (!id) return ev::throwTypeError("cannot fetch: " + err);
    return ev::fromDouble(static_cast<double>(id));
}

} // namespace

void installFetch(Table& ns) {
    Table fetch(ns, "fetch");
    fetch.function("start", js_fetchStart, 2);
    fetch.function("list", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        namespace ev = bronze::embed;
        const std::vector<FetchStatus> all = fetchList();
        ev::Persistent arr(createArray());
        uint32_t i = 0;
        for (const FetchStatus& f : all) {
            ev::Persistent o(fetchToJs(f));
            arr.set(ev::setElement(arr.get(), i++, o.get()));
        }
        return arr.get();
    });
    fetch.function("status", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        uint64_t id = 0;
        if (!args.empty() && ev::isNumber(args[0])) id = static_cast<uint64_t>(ev::toDouble(args[0]));
        return fetchToJs(fetchStatus(id));
    }, 1);
    fetch.function("stop", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        uint64_t id = 0;
        if (!args.empty() && ev::isNumber(args[0])) id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopFetch(id);
        return ev::undefined();
    }, 1);
    fetch.function("clearFinished", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        clearFinishedFetches();
        return bronze::embed::undefined();
    });
}

} // namespace ffmpegbro
