// Reading a device: `bro.ffmpeg.record` and `bro.ffmpeg.live`.
//
// One act, split in two by what is on the end of it. A recording puts a writer
// there and takes the single job slot, so it is polled, reported and stopped
// through the same status a render is; a session puts a `LiveTap` there and
// takes no slot, so it can be running while nothing else is. Everything before
// that end — opening the devices, the graph over them, placing a frame by the
// moment it arrived — is one piece of code in ffmpeg_capture.h, which is why
// the two live in one file here even though the surface keeps them apart.
//
// The section comments below carry the rest of each argument, and the notes in
// `installCapture` say why the tables are shaped as they are.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_capture.h"
#include "ffmpeg_export.h"
#include "ffmpeg_input.h"

#include <quickjs.h>

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace ffmpegbro {

namespace {

// ── bro.ffmpeg.record ──────────────────────────────────────────────────────
//
// A recording is a second kind of job in the same slot: it is polled through
// `render.poll()`, it is refused while a render holds the slot, and it reports
// through the same status. It is a separate pair of calls rather than a flag on
// `render.start` because what it is given is different — one device and no
// timeline — and because **stop is the normal end of a recording**, which is a
// different act from cancelling a render even though it is the same signal.
// See ffmpeg_capture.h.

JSValue js_recordStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "record.start(spec) requires a spec object");
    JSValueConst spec = argv[0];

    CaptureSettings c;
    std::string bad;
    if (!outputFromJs(ctx, spec, &c.output, &bad))
        return JS_ThrowTypeError(ctx, "%s", bad.c_str());

    // Zero rather than 1920×1080 and 30: a capture is not composited into a
    // canvas, so the device's own picture and rate are the answer unless
    // somebody has said otherwise, and only the device knows them.
    c.output.width = static_cast<int>(numProp(ctx, spec, "width", 0));
    c.output.height = static_cast<int>(numProp(ctx, spec, "height", 0));
    c.output.fps = numProp(ctx, spec, "fps", 0);

    // **`also` is the other files, and each of them is a whole output spec.**
    // Read through `outputFromJs` — the same reader `render.start` uses and the
    // same one the recording's own output went through two lines up — so a
    // second file names its muxer, its encoders, its options and its `streams`
    // exactly as the first does, and an unknown key is the same error in both.
    // What it is *not* given is a graph: the graph belongs to the session and
    // one file cannot have another, so `filterGraph` on an `also` entry is
    // simply never read. See `CaptureSettings::outputs`.
    JSValue also = JS_GetPropertyStr(ctx, spec, "also");
    if (JS_IsArray(also)) {
        c.outputs.push_back(c.output);
        const uint32_t len = arrayLength(ctx, also);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, also, i);
            if (!JS_IsObject(item)) {
                JS_FreeValue(ctx, item);
                JS_FreeValue(ctx, also);
                return JS_ThrowTypeError(
                    ctx, "record.start(spec).also[%u] is not a file to write", i);
            }
            ExportSettings out;
            const bool ok = outputFromJs(ctx, item, &out, &bad);
            if (ok) {
                out.width = static_cast<int>(numProp(ctx, item, "width", 0));
                out.height = static_cast<int>(numProp(ctx, item, "height", 0));
                // Zero, and not read from the entry: **the rate is the
                // recording's**. Placing a frame is turning the moment it
                // arrived into an output frame number, and two files answering
                // that differently would be two files disagreeing about when
                // the recording started. A file that wants another rate puts
                // `fps=` in the graph and maps that pad.
                out.fps = 0.0;
                c.outputs.push_back(std::move(out));
            }
            JS_FreeValue(ctx, item);
            if (!ok) {
                JS_FreeValue(ctx, also);
                return JS_ThrowTypeError(ctx, "record.start(spec).also[%u]: %s", i,
                                         bad.c_str());
            }
        }
    }
    JS_FreeValue(ctx, also);

    // `sources` is the list and `source` is the one-input spelling of it, read
    // the way `CaptureSettings` reads them: a list wins, and an absent list is
    // `{source}`. Two spellings rather than one because every caller that has
    // ever asked for a recording asked for one device, and a session is the new
    // thing rather than the only thing.
    JSValue list = JS_GetPropertyStr(ctx, spec, "sources");
    if (JS_IsArray(list)) {
        const uint32_t len = arrayLength(ctx, list);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, list, i);
            if (!JS_IsObject(item)) {
                JS_FreeValue(ctx, item);
                JS_FreeValue(ctx, list);
                return JS_ThrowTypeError(
                    ctx, "record.start(spec).sources[%u] is not a device as an -i", i);
            }
            MediaInput in = inputFromJs(ctx, item);
            JS_FreeValue(ctx, item);
            if (in.path.empty()) {
                JS_FreeValue(ctx, list);
                return JS_ThrowTypeError(
                    ctx, "record.start(spec).sources[%u] has no device to open", i);
            }
            c.sources.push_back(std::move(in));
        }
    }
    JS_FreeValue(ctx, list);

    JSValue src = JS_GetPropertyStr(ctx, spec, "source");
    if (JS_IsObject(src)) {
        c.source = inputFromJs(ctx, src);
    } else if (c.sources.empty()) {
        JS_FreeValue(ctx, src);
        return JS_ThrowTypeError(ctx,
                                 "record.start(spec) needs a source, or a sources list: the "
                                 "device (or devices) as -i");
    }
    JS_FreeValue(ctx, src);

    std::string err;
    uint64_t jobNumber = 0;
    if (!startCapture(c, &err, &jobNumber))
        return JS_ThrowTypeError(ctx, "cannot start recording: %s", err.c_str());
    // The job number, as `render.start` hands it back and for the same reason:
    // a recording shares the slot, the status and the channel, so it shares how
    // what it said is found again.
    return JS_NewInt64(ctx, static_cast<int64_t>(jobNumber));
}

// ── bro.ffmpeg.live ────────────────────────────────────────────────────────
//
// Watching without writing. `live.open(spec)` hands back an id, `live.pads(id)`
// says what it is publishing, and a `<video src="/@live/<id>/<pad>">` plays one
// of them. It is deliberately *not* part of `record`: a session produces no
// file, takes no job slot, and its whole purpose is to be running while nothing
// else is. See the note above `LiveSettings` in ffmpeg_capture.h.

JSValue js_liveOpen(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "live.open(spec) requires a spec object");
    JSValueConst spec = argv[0];

    LiveSettings s;
    s.filterGraph = strProp(ctx, spec, "filterGraph", "");
    s.fps = numProp(ctx, spec, "fps", 0);
    s.audioSampleRate = static_cast<int>(numProp(ctx, spec, "audioSampleRate", 48000));
    s.audioChannels = static_cast<int>(numProp(ctx, spec, "audioChannels", 2));
    s.includeAudio = boolProp(ctx, spec, "includeAudio", true);
    s.scaler = strProp(ctx, spec, "scaler", "");

    JSValue list = JS_GetPropertyStr(ctx, spec, "sources");
    if (JS_IsArray(list)) {
        const uint32_t len = arrayLength(ctx, list);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, list, i);
            if (JS_IsObject(item)) {
                MediaInput in = inputFromJs(ctx, item);
                if (!in.path.empty()) s.sources.push_back(std::move(in));
            }
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, list);
    if (s.sources.empty())
        return JS_ThrowTypeError(ctx, "live.open(spec).sources needs at least one device");

    std::string err;
    const uint64_t id = openLive(s, &err);
    if (!id) return JS_ThrowTypeError(ctx, "cannot watch: %s", err.c_str());
    return JS_NewInt64(ctx, static_cast<int64_t>(id));
}

JSValue js_livePads(JSContext* ctx, JSValue idArg) {
    int64_t id = 0;
    JS_ToInt64(ctx, &id, idArg);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& p : livePads(static_cast<uint64_t>(id))) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", p.name);
        JS_SetPropertyStr(ctx, o, "device", JS_NewBool(ctx, p.device));
        JS_SetPropertyStr(ctx, o, "width", JS_NewInt32(ctx, p.width));
        JS_SetPropertyStr(ctx, o, "height", JS_NewInt32(ctx, p.height));
        // Which kind it is, which decides what a caller *does* with it rather
        // than whether it can be played: a sound pad has a level as well, asked
        // for by `live.levels` because asking clears it, and it is drawn as a
        // meter rather than laid out as a picture.
        JS_SetPropertyStr(ctx, o, "sound", JS_NewBool(ctx, p.sound));
        // The src an element takes, made here rather than spelled out in the
        // UI: the token's shape is this binary's and a second place that knew
        // it would be a second place to change.
        //
        // **Every pad has one now, sound included.** Pointing an element at a
        // sound pad is what starts monitoring — the session queues nothing until
        // something listens — so this string is not a capability the UI may use
        // freely: it is the decision, and `ui/capture.js` only ever sets it on
        // the pad somebody asked to hear.
        setStr(ctx, o, "src", "/@live/" + std::to_string(id) + "/" + p.name);
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

/// What each sound pad has been doing since the last call. **Clears as it
/// reads** — see `liveLevels` — so this is called once a frame by the meter and
/// by nothing else.
///
/// A reading per *channel* of each pad, in the shape `bro.ffmpeg.output.levels`
/// hands back its own — one meter draws both, so one shape.
JSValue js_liveLevels(JSContext* ctx, JSValue idArg) {
    int64_t id = 0;
    JS_ToInt64(ctx, &id, idArg);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& l : liveLevels(static_cast<uint64_t>(id))) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", l.name);
        JS_SetPropertyStr(ctx, o, "heard", JS_NewBool(ctx, l.heard));
        JS_SetPropertyStr(ctx, o, "channels", channelsToJs(ctx, l.channels));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

} // namespace

void installCapture(Table& ns) {
    // Recording shares `render.poll()` on purpose: there is one job slot and
    // one status, and a second poll would be a second answer to "is something
    // running?" — which is the question every door in the UI asks.
    {
        Table record(ns, "record");
        record.function("start", js_recordStart, 1);
        record.function("stop", [] { stopCapture(); });
    }

    // Watching is *not* under `record`, and not under `render` either: a
    // session writes nothing, holds no job slot and shares no status with
    // either of them. What it shares with a recording is how a device is read,
    // and that is in the C++ rather than in this surface.
    {
        Table live(ns, "live");
        live.function("open", js_liveOpen, 1);
        live.function("pads", [](JSContext* ctx, JSValue id) { return js_livePads(ctx, id); });
        live.function("levels",
                      [](JSContext* ctx, JSValue id) { return js_liveLevels(ctx, id); });
        // An id closes that session; anything else — no argument, or a zero —
        // closes them all, which is what shutting the stage down asks for.
        live.function("close", [](JSContext* ctx, JSValue idArg) {
            int64_t id = 0;
            if (JS_ToInt64(ctx, &id, idArg) == 0 && id > 0)
                closeLive(static_cast<uint64_t>(id));
            else
                closeAllLive();
        });
    }
}

} // namespace ffmpegbro
