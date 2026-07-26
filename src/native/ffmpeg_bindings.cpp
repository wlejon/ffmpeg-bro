#include "ffmpeg_bindings.h"

#include "ffmpeg_backend.h"

#include <string>

namespace ffmpegbro {

namespace {

void setStr(JSContext* ctx, JSValue obj, const char* key, const std::string& v) {
    JS_SetPropertyStr(ctx, obj, key, JS_NewStringLen(ctx, v.data(), v.size()));
}

JSValue streamToJs(JSContext* ctx, const StreamSummary& s) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "index", JS_NewInt32(ctx, s.index));
    setStr(ctx, o, "kind", s.kind);
    setStr(ctx, o, "codec", s.codec);
    setStr(ctx, o, "codecLong", s.codecLong);
    setStr(ctx, o, "profile", s.profile);
    JS_SetPropertyStr(ctx, o, "bitRate", JS_NewInt64(ctx, s.bitRate));
    JS_SetPropertyStr(ctx, o, "default", JS_NewBool(ctx, s.isDefault));
    setStr(ctx, o, "language", s.language);
    setStr(ctx, o, "title", s.title);

    if (s.kind == "video") {
        JS_SetPropertyStr(ctx, o, "width", JS_NewInt32(ctx, s.width));
        JS_SetPropertyStr(ctx, o, "height", JS_NewInt32(ctx, s.height));
        JS_SetPropertyStr(ctx, o, "fps", JS_NewFloat64(ctx, s.fps));
        setStr(ctx, o, "pixFmt", s.pixFmt);
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
    }
    return o;
}

// bro.ffmpeg.probe(path) — a file's structure, read in-process by
// libavformat. Synchronous: opening a local container reads a few hundred KB
// of headers, and every caller wants the answer before it can lay anything
// out.
JSValue js_probe(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "probe(path) requires a path");
    const char* path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    ProbeResult r = probeMedia(path);
    JS_FreeCString(ctx, path);

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

std::string g_initialMedia;

} // namespace

void setInitialMedia(const std::string& path) { g_initialMedia = path; }

void installFfmpegBindings(JSContext* ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue broObj = JS_GetPropertyStr(ctx, global, "bro");
    if (JS_IsUndefined(broObj) || JS_IsNull(broObj)) {
        JS_FreeValue(ctx, broObj);
        broObj = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, global, "bro", JS_DupValue(ctx, broObj));
    }

    JSValue ns = JS_NewObject(ctx);
    // Linked in, not looked up on PATH: if this binary runs, ffmpeg is here.
    JS_SetPropertyStr(ctx, ns, "available", JS_TRUE);
    JS_SetPropertyStr(ctx, ns, "linked", JS_TRUE);
    setStr(ctx, ns, "version", libavVersion());
    setStr(ctx, ns, "configuration", libavConfiguration());

    JSValue hw = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& name : availableHwAccels())
        JS_SetPropertyUint32(ctx, hw, i++, JS_NewStringLen(ctx, name.data(), name.size()));
    JS_SetPropertyStr(ctx, ns, "hwaccels", hw);

    JS_SetPropertyStr(ctx, ns, "probe", JS_NewCFunction(ctx, js_probe, "probe", 1));
    JS_SetPropertyStr(ctx, ns, "openOnStart",
                      g_initialMedia.empty()
                          ? JS_NULL
                          : JS_NewStringLen(ctx, g_initialMedia.data(), g_initialMedia.size()));

    JS_SetPropertyStr(ctx, broObj, "ffmpeg", ns);
    JS_FreeValue(ctx, broObj);
    JS_FreeValue(ctx, global);
}

} // namespace ffmpegbro
