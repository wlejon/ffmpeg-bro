// `bro.ffmpeg.probe` — what libavformat makes of one input, and the shape that
// answer arrives in.
//
// One call and one helper is the whole of this file, because a probe is the
// only question this surface answers about a *particular* file: everything else
// in `bro.ffmpeg` either describes what this build can do or acts on a spec.
// Keeping them apart is the decision — a list of encoders is the same on every
// call for the life of the process and is built once at startup, while this
// opens a container every time and has to be told how.
//
// `streamToJs` lives here rather than beside `StreamSummary` for the same
// reason: it is this answer's shape and not the struct's, and the fields a
// caller lays out with are worked out for a probe's caller and mean nothing to
// the encode half, which counts pixels in output space.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_input.h"

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
JSValue js_probe(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "probe(path) requires a path or an input");

    MediaInput in;
    if (JS_IsObject(argv[0])) {
        in = inputFromJs(ctx, argv[0]);
    } else {
        const char* path = JS_ToCString(ctx, argv[0]);
        if (!path) return JS_EXCEPTION;
        in.path = path;
        JS_FreeCString(ctx, path);
        // The second argument is the rest of the `-i`, for a caller that has a
        // path in hand rather than an input record.
        if (argc >= 2 && JS_IsObject(argv[1])) {
            const std::string path0 = in.path;
            in = inputFromJs(ctx, argv[1]);
            in.path = path0;
        }
    }
    if (in.path.empty()) return JS_ThrowTypeError(ctx, "probe() needs a path or a URL");

    ProbeResult r = probeMedia(in);

    if (!r.ok) {
        return JS_ThrowTypeError(ctx, "cannot open '%s': %s", r.path.c_str(),
                                 r.error.c_str());
    }

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

} // namespace

void installProbe(Table& ns) {
    ns.function("probe", js_probe, 1);
}

} // namespace ffmpegbro
