// `bro.ffmpeg.probe` — what libavformat makes of one input, and the shape that
// answer arrives in.
//
// A probe is the only question this surface answers about a *particular* file;
// everything else in `bro.ffmpeg` either describes what this build can do or
// acts on a spec. Keeping them apart is the decision — a list of encoders is
// the same on every call for the life of the process and is built once at
// startup, while this opens a container every time and has to be told how.
//
// **There are two calls and they are the same probe.** `probe()` is
// synchronous, because opening a local container reads a few hundred KB of
// headers and every caller wants the answer before it can lay anything out —
// routing a path on disk through a thread and a poll would cost every user a
// round trip to fix a case few hit. `probes.start`/`poll`/`cancel` is the same
// open on a thread of its own, for the two cases where the wait is not measured
// in microseconds: a URL, and a **device**. **The decision of which is which is
// a lookup that opens nothing** — `schemeOf` parses a scheme out of the path,
// `isDeviceFormat` finds the `-f` in libavdevice's registry (both in
// ui/inputs.js) — so the thing that chooses cannot itself block, which was the
// other way of getting this wrong.
//
// A device needed nothing added to these calls: it is `-f dshow -i video=…`,
// which is a `MediaInput`, and `inputArg` below has always read one whole. A
// `devices.start`/`poll`/`cancel` of the same shape beside this one would have
// been two homes for "an open that can be waited on and stopped".
//
// `streamToJs` and `probeToJs` live here rather than beside `StreamSummary` for
// the same reason: they are this answer's shape and not the struct's, and the
// fields a caller lays out with are worked out for a probe's caller and mean
// nothing to the encode half, which counts pixels in output space. Both calls
// go through `probeToJs`, so a URL and a path cannot come back described
// differently.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_input.h"
#include "probe_async.h"

#include <quickjs.h>

#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

JSValue streamToJs(JSContext* ctx, const StreamSummary& s) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "index", JS_NewInt32(ctx, s.index));
    setStr(ctx, o, "kind", s.kind);
    setStr(ctx, o, "codec", s.codec);
    setStr(ctx, o, "codecLong", s.codecLong);
    setStr(ctx, o, "tag", s.tag);
    setStr(ctx, o, "profile", s.profile);
    JS_SetPropertyStr(ctx, o, "bitRate", JS_NewInt64(ctx, s.bitRate));
    JS_SetPropertyStr(ctx, o, "duration", JS_NewFloat64(ctx, s.duration));
    JS_SetPropertyStr(ctx, o, "default", JS_NewBool(ctx, s.isDefault));
    setStr(ctx, o, "language", s.language);
    setStr(ctx, o, "title", s.title);

    if (s.kind == "video") {
        JS_SetPropertyStr(ctx, o, "width", JS_NewInt32(ctx, s.width));
        JS_SetPropertyStr(ctx, o, "height", JS_NewInt32(ctx, s.height));
        JS_SetPropertyStr(ctx, o, "fps", JS_NewFloat64(ctx, s.fps));
        setStr(ctx, o, "pixFmt", s.pixFmt);
        setStr(ctx, o, "colorSpace", s.colorSpace);
        setStr(ctx, o, "colorRange", s.colorRange);
        setStr(ctx, o, "colorPrimaries", s.colorPrimaries);
        setStr(ctx, o, "colorTransfer", s.colorTransfer);
        JS_SetPropertyStr(ctx, o, "sampleAspect", JS_NewFloat64(ctx, s.sampleAspect));
        JS_SetPropertyStr(ctx, o, "rotation", JS_NewInt32(ctx, s.rotation));
        // What the frame measures once rotation is applied — the size a UI
        // should actually lay out for.
        const bool swapped = (s.rotation == 90 || s.rotation == 270);
        JS_SetPropertyStr(ctx, o, "displayWidth",
                          JS_NewInt32(ctx, swapped ? s.height : s.width));
        JS_SetPropertyStr(ctx, o, "displayHeight",
                          JS_NewInt32(ctx, swapped ? s.width : s.height));
    } else if (s.kind == "audio") {
        JS_SetPropertyStr(ctx, o, "sampleRate", JS_NewInt32(ctx, s.sampleRate));
        JS_SetPropertyStr(ctx, o, "channels", JS_NewInt32(ctx, s.channels));
        setStr(ctx, o, "channelLayout", s.channelLayout);
        setStr(ctx, o, "sampleFmt", s.sampleFmt);
    } else if (s.kind == "subtitle") {
        JS_SetPropertyStr(ctx, o, "textSub", JS_NewBool(ctx, s.textSub));
    }
    return o;
}

/// A successful probe, as the UI reads one. One builder, two callers — the
/// synchronous call and the poll — because a URL and a path have to arrive
/// described identically or every reader of a probe would grow a second branch.
JSValue probeToJs(JSContext* ctx, const ProbeResult& r) {
    JSValue out = JS_NewObject(ctx);
    setStr(ctx, out, "path", r.path);

    JSValue fmt = JS_NewObject(ctx);
    setStr(ctx, fmt, "name", r.formatName);
    setStr(ctx, fmt, "longName", r.formatLongName);
    JS_SetPropertyStr(ctx, fmt, "duration", JS_NewFloat64(ctx, r.durationSec));
    JS_SetPropertyStr(ctx, fmt, "bitRate", JS_NewInt64(ctx, r.bitRate));
    JS_SetPropertyStr(ctx, fmt, "size", JS_NewInt64(ctx, r.sizeBytes));
    JS_SetPropertyStr(ctx, out, "format", fmt);

    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    int firstVideo = -1, firstAudio = -1;
    for (const auto& s : r.streams) {
        if (firstVideo < 0 && s.kind == "video") firstVideo = static_cast<int>(n);
        if (firstAudio < 0 && s.kind == "audio") firstAudio = static_cast<int>(n);
        JS_SetPropertyUint32(ctx, arr, n++, streamToJs(ctx, s));
    }
    JS_SetPropertyStr(ctx, out, "streams", arr);

    // Shortcuts to the streams a player actually plays, so callers don't
    // re-scan the array for the common case.
    JS_SetPropertyStr(ctx, out, "video",
                      firstVideo >= 0 ? JS_GetPropertyUint32(ctx, arr, firstVideo)
                                      : JS_NULL);
    JS_SetPropertyStr(ctx, out, "audio",
                      firstAudio >= 0 ? JS_GetPropertyUint32(ctx, arr, firstAudio)
                                      : JS_NULL);
    return out;
}

/// The `-i` these calls are about, out of whatever the caller passed.
///
/// One reader, because `probe()` and `probes.start()` take the same two shapes
/// and a second copy would be the place one of them stopped honouring a forced
/// demuxer. False leaves `*in` alone and an exception pending.
bool inputArg(JSContext* ctx, int argc, JSValueConst* argv, MediaInput* in) {
    if (JS_IsObject(argv[0])) {
        *in = inputFromJs(ctx, argv[0]);
        return true;
    }
    const char* path = JS_ToCString(ctx, argv[0]);
    if (!path) return false;
    MediaInput built;
    built.path = path;
    JS_FreeCString(ctx, path);
    // The second argument is the rest of the `-i`, for a caller that has a
    // path in hand rather than an input record.
    if (argc >= 2 && JS_IsObject(argv[1])) {
        const std::string path0 = built.path;
        built = inputFromJs(ctx, argv[1]);
        built.path = path0;
    }
    *in = built;
    return true;
}

// bro.ffmpeg.probe(path | input, [{ format, options }]) — a file's structure,
// read in-process by libavformat. Synchronous: opening a local container reads
// a few hundred KB of headers, and every caller wants the answer before it can
// lay anything out.
//
// It takes an input and not only a path because probing wrong is the reason
// demuxer options exist: a Sources stage that showed what libavformat's
// defaults made of a file, while the render opened it with `-f` and a
// `-probesize`, would be describing a different file from the one about to be
// rendered.
//
// **It has no deadline and no way to stop it, and that is not an oversight.**
// A synchronous call cannot have either — there is nobody to press the button
// and nowhere for the answer to arrive — which is precisely why anything that
// might wait on a network goes through `probes.start` instead.
JSValue js_probe(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "probe(path) requires a path or an input");

    MediaInput in;
    if (!inputArg(ctx, argc, argv, &in)) return JS_EXCEPTION;
    if (in.path.empty()) return JS_ThrowTypeError(ctx, "probe() needs a path or a URL");

    const ProbeResult r = probeMedia(in);
    if (!r.ok) {
        return JS_ThrowTypeError(ctx, "cannot open '%s': %s", r.path.c_str(),
                                 r.error.c_str());
    }
    return probeToJs(ctx, r);
}

// bro.ffmpeg.probes.start(path | input, [{ timeout }]) — the same probe, on a
// thread of its own, answered by `poll`.
//
// The options object is the input's when a path was passed, exactly as
// `probe()`'s second argument is, plus `timeout` in seconds. `timeout` is not
// a demuxer option and never reaches libav: it is the deadline on the interrupt
// callback, which is one mechanism covering every protocol — see `OpenWatch`
// in ffmpeg_input.h for what libav's own timeout options do and do not cover.
JSValue js_probeStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "probes.start(path) requires a path or an input");

    MediaInput in;
    if (!inputArg(ctx, argc, argv, &in)) return JS_EXCEPTION;
    if (in.path.empty())
        return JS_ThrowTypeError(ctx, "probes.start() needs a path or a URL");

    double timeout = 0;
    for (int i = 0; i < argc; ++i)
        if (JS_IsObject(argv[i])) timeout = numProp(ctx, argv[i], "timeout", timeout);

    return JS_NewInt64(ctx, static_cast<int64_t>(startProbe(in, timeout)));
}

const char* probeStateName(ProbeProgress::State s) {
    switch (s) {
        case ProbeProgress::State::Opening: return "opening";
        case ProbeProgress::State::Done:    return "done";
        case ProbeProgress::State::Failed:  return "failed";
        case ProbeProgress::State::Stopped: return "stopped";
    }
    return "opening";
}

// bro.ffmpeg.probes.poll(id) — where it has got to.
//
// `null` for an id nothing knows about, which after a terminal answer is the
// ordinary case: a terminal state is handed over once and the entry is
// forgotten with it, so a caller that polls a finished probe twice is a caller
// that dropped the answer.
//
// **`elapsed` and `timeout` are both here** so that "connecting, 3 of 10
// seconds" can be drawn without the UI keeping a clock of its own — a second
// clock would drift from the one the deadline is actually measured against,
// which is libav's monotonic one.
JSValue js_probePoll(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "probes.poll(id) requires an id");
    int64_t id = 0;
    if (JS_ToInt64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;

    ProbeProgress p;
    if (!probeProgress(static_cast<uint64_t>(id), &p)) return JS_NULL;

    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "state", probeStateName(p.state));
    JS_SetPropertyStr(ctx, o, "opening",
                      JS_NewBool(ctx, p.state == ProbeProgress::State::Opening));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, p.elapsed));
    JS_SetPropertyStr(ctx, o, "timeout", JS_NewFloat64(ctx, p.timeout));
    // **What a `Stop` beside this will actually do.** False for a device,
    // whose `read_header` never polls the interrupt callback — see `OpenWatch`
    // in ffmpeg_input.h for the measurement. Reported rather than worked out
    // by the caller, because a button that claimed to abort an open it cannot
    // reach would be a lie about what the machine is doing, and the fact
    // belongs to the open rather than to whoever is drawing it.
    JS_SetPropertyStr(ctx, o, "stoppable", JS_NewBool(ctx, p.stoppable));
    // The failure is a string here rather than an exception, which is the one
    // place these two calls differ in more than timing: `probe()` throws
    // because a caller that ignored the failure would lay out a file it never
    // read, and a poll is read every frame by something that has to keep
    // drawing either way.
    setStr(ctx, o, "error", p.result.error);
    JS_SetPropertyStr(ctx, o, "result",
                      p.state == ProbeProgress::State::Done ? probeToJs(ctx, p.result)
                                                            : JS_NULL);
    return o;
}

} // namespace

void installProbe(Table& ns) {
    ns.function("probe", js_probe, 1);

    Table probes(ns, "probes");
    probes.function("start", js_probeStart, 2);
    probes.function("poll", js_probePoll, 1);
    /// Abort the open. The interrupt callback is what reaches libav, so this is
    /// a real stop and not a hidden spinner: the connect, the handshake or the
    /// read in progress is abandoned and the poll after it says `stopped`.
    ///
    /// **Only where `poll().stoppable` said so.** A device's own `read_header`
    /// never polls the callback, so this would set a flag and leave the entry
    /// Opening until the driver answered — which is the state the press was
    /// meant to end. `forget` is what a device's Stop is.
    probes.function("cancel", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        stopProbe(static_cast<uint64_t>(id));
        return JS_UNDEFINED;
    });
    /// Stop it and never poll again — an input removed while it was still
    /// opening. Separate from `cancel` because the two differ in whether
    /// anybody is going to be told: `cancel` keeps the answer for the press
    /// that asked for it, this one throws it away and reaps the thread.
    probes.function("forget", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        abandonProbe(static_cast<uint64_t>(id));
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
