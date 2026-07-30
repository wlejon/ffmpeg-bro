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

#include <quickjs.h>

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

JSValue js_inputsDefine(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsObject(argv[1]))
        return JS_ThrowTypeError(ctx, "inputs.define(id, input) requires an id and an input");
    const char* id = JS_ToCString(ctx, argv[0]);
    if (!id) return JS_EXCEPTION;
    const MediaInput in = inputFromJs(ctx, argv[1]);
    if (in.path.empty()) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx, "inputs.define() needs a path or a URL");
    }
    const std::string token = defineInput(id, in);
    JS_FreeCString(ctx, id);
    return JS_NewStringLen(ctx, token.data(), token.size());
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

JSValue js_viewsDefine(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsObject(argv[1]))
        return JS_ThrowTypeError(ctx, "views.define(id, view) requires an id and a view");
    const char* id = JS_ToCString(ctx, argv[0]);
    if (!id) return JS_EXCEPTION;

    PlaybackView v;
    JSValue input = JS_GetPropertyStr(ctx, argv[1], "input");
    v.input = inputFromJs(ctx, input);
    JS_FreeValue(ctx, input);
    v.video = strProp(ctx, argv[1], "video", "");
    v.audio = strProp(ctx, argv[1], "audio", "");
    v.shift = numProp(ctx, argv[1], "shift", 0);
    if (v.input.path.empty()) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx, "views.define() needs an input with a path in it");
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
    JS_FreeCString(ctx, id);
    if (!ok) return JS_ThrowTypeError(ctx, "%s", err.c_str());

    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "src", JS_NewStringLen(ctx, token.data(), token.size()));
    JS_SetPropertyStr(ctx, o, "video", JS_NewBool(ctx, facts.video));
    JS_SetPropertyStr(ctx, o, "width", JS_NewInt32(ctx, facts.width));
    JS_SetPropertyStr(ctx, o, "height", JS_NewInt32(ctx, facts.height));
    // What went in, so a caller can ask whether the chain changed the shape of
    // the picture without probing the file a second time and applying the
    // display matrix itself.
    JS_SetPropertyStr(ctx, o, "sourceWidth", JS_NewInt32(ctx, facts.sourceWidth));
    JS_SetPropertyStr(ctx, o, "sourceHeight", JS_NewInt32(ctx, facts.sourceHeight));
    JS_SetPropertyStr(ctx, o, "audio", JS_NewBool(ctx, facts.audio));
    JS_SetPropertyStr(ctx, o, "sampleRate", JS_NewInt32(ctx, facts.sampleRate));
    JS_SetPropertyStr(ctx, o, "channels", JS_NewInt32(ctx, facts.channels));
    return o;
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
bool outputViewFromJs(JSContext* ctx, JSValueConst spec, OutputView* v, std::string* err) {
    if (!outputFromJs(ctx, spec, &v->settings, err)) return false;
    v->clips = clipsFromJs(ctx, spec);
    return true;
}

JSValue js_outputDefine(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsObject(argv[1]))
        return JS_ThrowTypeError(ctx, "output.define(id, spec) requires an id and a spec");
    const char* id = JS_ToCString(ctx, argv[0]);
    if (!id) return JS_EXCEPTION;

    OutputView v;
    std::string bad;
    if (!outputViewFromJs(ctx, argv[1], &v, &bad)) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx, "%s", bad.c_str());
    }
    const std::string token = defineOutput(id, v);
    JS_FreeCString(ctx, id);
    return JS_NewStringLen(ctx, token.data(), token.size());
}

/// Build the render's source, say what it produces, and throw it away — so that
/// a graph libavfilter refuses is a sentence the moment somebody wires it rather
/// than a black rectangle and a line in a log.
JSValue js_outputSettle(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "output.settle(spec) requires a spec object");

    OutputView v;
    std::string bad;
    if (!outputViewFromJs(ctx, argv[0], &v, &bad))
        return JS_ThrowTypeError(ctx, "%s", bad.c_str());

    OutputFacts facts;
    std::string err;
    if (!settleOutput(v, &facts, &err))
        return JS_ThrowTypeError(ctx, "%s", err.c_str());

    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "width", JS_NewInt32(ctx, facts.width));
    JS_SetPropertyStr(ctx, o, "height", JS_NewInt32(ctx, facts.height));
    JS_SetPropertyStr(ctx, o, "fps", JS_NewFloat64(ctx, facts.fps));
    JS_SetPropertyStr(ctx, o, "start", JS_NewFloat64(ctx, facts.start));
    JS_SetPropertyStr(ctx, o, "length", JS_NewFloat64(ctx, facts.length));
    // Which of the two renderers this preview is of. The compositor and
    // libavfilter agree to 43 dB and are still not the same thing to look at —
    // and it is the one fact a caller cannot work out from the spec without
    // knowing the rule `runExport` decides by.
    JS_SetPropertyStr(ctx, o, "graph", JS_NewBool(ctx, facts.graph));
    return o;
}

/// How loud the render being previewed is, right now — per channel of the
/// *output*, with a true peak in each.
///
/// **Clears as it reads**, which is the rule every level in this binary follows
/// and the reason this is a call rather than a field on `settle`: a peak left
/// standing would make one moment of clipping look permanent, and two callers
/// would halve each other's windows and draw two meters that disagree. So there is
/// one caller — the meter beside the viewer, once a frame.
JSValue js_outputLevels(JSContext* ctx, JSValue idArg) {
    std::string name;
    if (!takeName(ctx, idArg, &name))
        return JS_ThrowTypeError(ctx, "output.levels(id) requires an id");
    const OutputLevels l = outputLevels(name);
    JSValue o = JS_NewObject(ctx);
    // Three states and not two: no render behind this id, a render with no
    // soundtrack at all, and a render whose sound is being measured. A meter that
    // could not tell the first two apart would draw silence where it should be
    // saying there is nothing to draw.
    JS_SetPropertyStr(ctx, o, "running", JS_NewBool(ctx, l.running));
    JS_SetPropertyStr(ctx, o, "heard", JS_NewBool(ctx, l.heard));
    JS_SetPropertyStr(ctx, o, "rate", JS_NewInt32(ctx, l.rate));
    JS_SetPropertyStr(ctx, o, "channels", channelsToJs(ctx, l.channels));
    return o;
}

} // namespace

void installPlayback(Table& ns) {
    // The inputs playback knows about. Registered rather than passed, because
    // `<video src>` is a string — see the note above these functions.
    {
        Table inputs(ns, "inputs");
        inputs.function("define", js_inputsDefine, 2);
        inputs.function("forget", [](JSContext* ctx, JSValue id) {
            std::string name;
            if (!takeName(ctx, id, &name))
                return JS_ThrowTypeError(ctx, "inputs.forget(id) requires an id");
            forgetInput(name);
            return JS_UNDEFINED;
        });
        inputs.function("token", [](JSContext* ctx, JSValue id) {
            std::string name;
            if (!takeName(ctx, id, &name))
                return JS_ThrowTypeError(ctx, "inputs.token(id) requires an id");
            const std::string token = inputToken(name);
            return JS_NewStringLen(ctx, token.data(), token.size());
        });
    }

    // The same registry one turn further on: an input with filters on it, which
    // is how a filter reaches playback at all.
    {
        Table views(ns, "views");
        views.function("define", js_viewsDefine, 2);
        views.function("forget", [](JSContext* ctx, JSValue id) {
            std::string name;
            if (!takeName(ctx, id, &name))
                return JS_ThrowTypeError(ctx, "views.forget(id) requires an id");
            forgetView(name);
            return JS_UNDEFINED;
        });
    }

    {
        Table output(ns, "output");
        output.function("define", js_outputDefine, 2);
        output.function("settle", js_outputSettle, 1);
        output.function("levels",
                        [](JSContext* ctx, JSValue id) { return js_outputLevels(ctx, id); });
        output.function("forget", [](JSContext* ctx, JSValue id) {
            std::string name;
            if (!takeName(ctx, id, &name))
                return JS_ThrowTypeError(ctx, "output.forget(id) requires an id");
            forgetOutput(name);
            return JS_UNDEFINED;
        });
    }
}

} // namespace ffmpegbro
