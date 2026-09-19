// `inputs`, `views` and `output` — the three registries that let a `<video src>`
// name something this binary made.
//
// One file, because they are one idea arrived at three times. bro's `<video>`
// takes a **string**, and this binary's media backend is registered generically,
// so nothing this application builds can be *passed* to an element: it has to be
// named. Each call here registers a thing under an id and hands back a token to
// use as a src, and each of the three is one turn further from the file on disk
// — `/@input/` is an `-i` with its forced demuxer and its options, `/@fx/` is
// that input with a filter chain on each of its streams, and `/@out/` is the
// whole render, the picture the export would write. The section comments below
// carry the detail; playback_filter.h and playback_output.h carry the argument
// for the second and the third and are not repeated here.
//
// What differs between them is *when the expensive half happens*, and that is
// the one thing worth keeping straight while reading: `views.define` settles,
// because settling a view is opening one file, while `output.define` only
// registers and `output.settle` is asked for separately, because settling a
// render opens every input its graph reads and the caller redefines one every
// time the playhead moves.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_input.h"
#include "playback_filter.h"
#include "playback_output.h"

#include <embed/embed.h>

#include <string>

namespace ffmpegbro {

namespace {

// ── bro.ffmpeg.inputs ──────────────────────────────────────────────────────
//
// How an input's options reach *playback*, which the render spec cannot do:
// bro's `<video>` takes a src string and this binary's media backend is
// registered generically, so the string has to name the input. `define` hands
// back a token to use as a src (or as a `bro.media` path, which is the same
// registry one level down); the backend swaps it for the URL, the forced
// demuxer and the option bag on the way into libavformat.
//
// The token is also why a URL can be played at all. bro resolves a src that
// does not start with `/` or `x:` against the document, so `https://…` would
// become a path under `ui/`; a token starts with a slash and survives.

bronze::Value js_inputsDefine(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.size() < 2 || !ev::isString(args[0]) || !ev::isObject(args[1]))
        return ev::throwTypeError("inputs.define(id, input) requires an id and an input");
    const std::string id = ev::toUtf8(args[0]);
    const MediaInput in = inputFromJs(args[1]);
    if (in.path.empty()) {
        return ev::throwTypeError("inputs.define() needs a path or a URL");
    }
    const std::string token = defineInput(id, in);
    return ev::fromUtf8(token);
}

// ── bro.ffmpeg.views ───────────────────────────────────────────────────────
//
// A view is an input plus the filters its streams go through on the way to the
// screen — what makes the program monitor show the picture the render will make
// rather than the one the file holds. The registry is the input registry's
// shape and exists for the same reason: `<video src>` is a string, so a filter
// on playback has to be part of what is being played.
//
// **`define` does the work rather than merely remembering.** It opens the
// input, builds the chains and reports what they turned out to produce, because
// the answer decides what the caller does with it: a chain that will not parse
// is a message worth showing the moment it is typed, and a chain that changes
// the size of the picture is one the viewer says it cannot show rather than
// showing at a size the render never puts it at. An element pointed at a token
// that fails is a black rectangle and a line in a log.
//
// See playback_filter.h for what is and is not in a view, and docs/api.md.

bronze::Value js_viewsDefine(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.size() < 2 || !ev::isString(args[0]) || !ev::isObject(args[1]))
        return ev::throwTypeError("views.define(id, view) requires an id and a view");
    const std::string id = ev::toUtf8(args[0]);

    PlaybackView v;
    bronze::Value inputVal = ev::getProperty(args[1], "input");
    v.input = inputFromJs(inputVal);
    v.video = strProp(args[1], "video", "");
    v.audio = strProp(args[1], "audio", "");
    v.shift = numProp(args[1], "shift", 0);
    if (v.input.path.empty()) {
        return ev::throwTypeError("views.define() needs an input with a path in it");
    }

    ViewFacts facts;
    std::string token;
    std::string err;
    // One call, because settling and registering are one act: a token that
    // resolves to a view nothing has ever built is a `<video>` that fails at
    // the open. It settles only when the input or the chains changed — see
    // `defineSettled`, which is what makes re-registering on every frame of a
    // drag cost nothing.
    const bool ok = defineSettled(id, v, &facts, &token, &err);
    if (!ok) return ev::throwTypeError(err);

    ev::Persistent o(ev::createObject());
    setStr(o.get(), "src", token);
    setBool(o.get(), "video", facts.video);
    setNum(o.get(), "width", facts.width);
    setNum(o.get(), "height", facts.height);
    // What went in, so a caller can ask whether the chain changed the shape of
    // the picture without probing the file a second time and applying the
    // display matrix itself.
    setNum(o.get(), "sourceWidth", facts.sourceWidth);
    setNum(o.get(), "sourceHeight", facts.sourceHeight);
    setBool(o.get(), "audio", facts.audio);
    setNum(o.get(), "sampleRate", facts.sampleRate);
    setNum(o.get(), "channels", facts.channels);
    return o.get();
}

// ── bro.ffmpeg.output ──────────────────────────────────────────────────────
//
// A render, registered so that a `<video>` can play it — the program monitor
// showing what the export would write rather than one element per clip. The spec
// is the one `render.start` is given, so a preview cannot describe a render this
// application would not perform.
//
// **`define` registers and `settle` builds**, which is the opposite split from
// `views.define` and is deliberate. A view is settled on definition because
// settling one is opening a file, and the caller redefines a view on every
// gesture; an output view is a whole render — every input the graph reads — and
// the caller redefines one every time the playhead moves. So building is asked
// for separately, at the moment something is about to be pointed at it.
//
// See playback_output.h for what is and is not in one, and docs/api.md.

/// The two halves of a spec, read exactly as `render.start` reads them. One
/// place, so a preview cannot be built out of a differently-read spec.
bool outputViewFromJs(bronze::Value spec, OutputView* v, std::string* err) {
    if (!outputFromJs(spec, &v->settings, err)) return false;
    v->clips = clipsFromJs(spec);
    return true;
}

bronze::Value js_outputDefine(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.size() < 2 || !ev::isString(args[0]) || !ev::isObject(args[1]))
        return ev::throwTypeError("output.define(id, spec) requires an id and a spec");
    const std::string id = ev::toUtf8(args[0]);

    OutputView v;
    std::string bad;
    if (!outputViewFromJs(args[1], &v, &bad)) {
        return ev::throwTypeError(bad);
    }
    const std::string token = defineOutput(id, v);
    return ev::fromUtf8(token);
}

/// Build the render's source, say what it produces, and throw it away — so that
/// a graph libavfilter refuses is a sentence the moment somebody wires it rather
/// than a black rectangle and a line in a log.
bronze::Value js_outputSettle(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty() || !ev::isObject(args[0]))
        return ev::throwTypeError("output.settle(spec) requires a spec object");

    OutputView v;
    std::string bad;
    if (!outputViewFromJs(args[0], &v, &bad))
        return ev::throwTypeError(bad);

    OutputFacts facts;
    std::string err;
    if (!settleOutput(v, &facts, &err))
        return ev::throwTypeError(err);

    ev::Persistent o(ev::createObject());
    setNum(o.get(), "width", facts.width);
    setNum(o.get(), "height", facts.height);
    setNum(o.get(), "fps", facts.fps);
    setNum(o.get(), "start", facts.start);
    setNum(o.get(), "length", facts.length);
    // Which of the two renderers this preview is of. The compositor and
    // libavfilter agree to 43 dB and are still not the same thing to look at —
    // and it is the one fact a caller cannot work out from the spec without
    // knowing the rule `runExport` decides by.
    setBool(o.get(), "graph", facts.graph);
    return o.get();
}

/// How loud the render being previewed is, right now — per channel of the
/// *output*, with a true peak in each.
///
/// **Clears as it reads**, which is the rule every level in this binary follows
/// and the reason this is a call rather than a field on `settle`: a peak left
/// standing would make one moment of clipping look permanent, and two callers
/// would halve each other's windows and draw two meters that disagree. So there is
/// one caller — the meter beside the viewer, once a frame.
bronze::Value js_outputLevels(bronze::Value idArg) {
    namespace ev = bronze::embed;
    std::string name;
    if (!takeName(idArg, &name))
        return ev::throwTypeError("output.levels(id) requires an id");
    const OutputLevels l = outputLevels(name);
    ev::Persistent o(ev::createObject());
    // Three states and not two: no render behind this id, a render with no
    // soundtrack at all, and a render whose sound is being measured. A meter that
    // could not tell the first two apart would draw silence where it should be
    // saying there is nothing to draw.
    setBool(o.get(), "running", l.running);
    setBool(o.get(), "heard", l.heard);
    setNum(o.get(), "rate", l.rate);
    ev::Persistent ch(channelsToJs(l.channels));
    o.set(ev::setProperty(o.get(), "channels", ch.get()));
    return o.get();
}

} // namespace

void installPlayback(Table& ns) {
    // The inputs playback knows about. Registered rather than passed, because
    // `<video src>` is a string — see the note above these functions.
    {
        Table inputs(ns, "inputs");
        inputs.function("define", js_inputsDefine, 2);
        inputs.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
            namespace ev = bronze::embed;
            std::string name;
            if (args.empty() || !takeName(args[0], &name))
                return ev::throwTypeError("inputs.forget(id) requires an id");
            forgetInput(name);
            return ev::undefined();
        }, 1);
        inputs.function("token", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
            namespace ev = bronze::embed;
            std::string name;
            if (args.empty() || !takeName(args[0], &name))
                return ev::throwTypeError("inputs.token(id) requires an id");
            const std::string token = inputToken(name);
            return ev::fromUtf8(token);
        }, 1);
    }

    // The same registry one turn further on: an input with filters on it, which
    // is how a filter reaches playback at all.
    {
        Table views(ns, "views");
        views.function("define", js_viewsDefine, 2);
        views.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
            namespace ev = bronze::embed;
            std::string name;
            if (args.empty() || !takeName(args[0], &name))
                return ev::throwTypeError("views.forget(id) requires an id");
            forgetView(name);
            return ev::undefined();
        }, 1);
    }

    {
        Table output(ns, "output");
        output.function("define", js_outputDefine, 2);
        output.function("settle", js_outputSettle, 1);
        output.function("levels", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
            namespace ev = bronze::embed;
            if (args.empty()) return ev::throwTypeError("output.levels(id) requires an id");
            return js_outputLevels(args[0]);
        }, 1);
        output.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
            namespace ev = bronze::embed;
            std::string name;
            if (args.empty() || !takeName(args[0], &name))
                return ev::throwTypeError("output.forget(id) requires an id");
            forgetOutput(name);
            return ev::undefined();
        }, 1);
    }
}

} // namespace ffmpegbro
