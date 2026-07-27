#include "ffmpeg_bindings.h"

#include "ffmpeg_backend.h"
#include "ffmpeg_export.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_report.h"

#include <algorithm>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

void setStr(JSContext* ctx, JSValue obj, const char* key, const std::string& v) {
    JS_SetPropertyStr(ctx, obj, key, JS_NewStringLen(ctx, v.data(), v.size()));
}

// ── Reading a plain JS object ──────────────────────────────────────────────
//
// The render spec is a JS object literal built by the UI, so every field is
// optional and every default lives here rather than being repeated in the
// caller.

double numProp(JSContext* ctx, JSValueConst obj, const char* key, double fallback) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    double out = fallback;
    if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
        double d = 0;
        if (JS_ToFloat64(ctx, &d, v) == 0 && d == d) out = d;
    }
    JS_FreeValue(ctx, v);
    return out;
}

bool boolProp(JSContext* ctx, JSValueConst obj, const char* key, bool fallback) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    const bool out = (JS_IsUndefined(v) || JS_IsNull(v)) ? fallback : JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    return out;
}

std::string strProp(JSContext* ctx, JSValueConst obj, const char* key,
                    const std::string& fallback) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    std::string out = fallback;
    if (JS_IsString(v)) {
        size_t len = 0;
        if (const char* s = JS_ToCStringLen(ctx, &len, v)) {
            out.assign(s, len);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, v);
    return out;
}

JSValue streamToJs(JSContext* ctx, const StreamSummary& s) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "index", JS_NewInt32(ctx, s.index));
    setStr(ctx, o, "kind", s.kind);
    setStr(ctx, o, "codec", s.codec);
    setStr(ctx, o, "codecLong", s.codecLong);
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

// ── bro.ffmpeg.render ──────────────────────────────────────────────────────
//
// Rendering runs on its own thread and the UI polls it, rather than the render
// calling back into JS. A callback would have to be marshalled onto the JS
// thread anyway — QuickJS has one — and polling costs a lock per animation
// frame, which is nothing next to encoding one.

/// One clip out of `spec.clips`. The placement rectangle arrives in canvas
/// pixels: ui/viewer.js already knows how to work it out and there is no
/// second implementation here to disagree with it.
ExportClip clipFromJs(JSContext* ctx, JSValueConst o) {
    ExportClip c;
    c.path = strProp(ctx, o, "path", "");
    c.start = numProp(ctx, o, "start", 0);
    c.length = numProp(ctx, o, "length", 0);
    c.inPoint = numProp(ctx, o, "inPoint", 0);
    c.x = numProp(ctx, o, "x", 0);
    c.y = numProp(ctx, o, "y", 0);
    c.w = numProp(ctx, o, "w", 0);
    c.h = numProp(ctx, o, "h", 0);
    c.opacity = numProp(ctx, o, "opacity", 1.0);
    c.volume = numProp(ctx, o, "volume", 1.0);
    c.muted = boolProp(ctx, o, "muted", false);
    c.z = static_cast<int>(numProp(ctx, o, "z", 0));

    JSValue crop = JS_GetPropertyStr(ctx, o, "crop");
    if (JS_IsObject(crop)) {
        c.cropL = numProp(ctx, crop, "l", 0);
        c.cropT = numProp(ctx, crop, "t", 0);
        c.cropR = numProp(ctx, crop, "r", 0);
        c.cropB = numProp(ctx, crop, "b", 0);
    }
    JS_FreeValue(ctx, crop);
    return c;
}

/// `{ g: 60, bf: 2, "x264-params": "aq-mode=3" }` — the natural JS shape for a
/// bag of ffmpeg arguments. Numbers are stringified here rather than in the UI
/// so that a control emitting 23 and one emitting "23" mean the same thing.
///
/// `owner` is whatever object the bag hangs off: the spec for the render's own
/// options and metadata, and a stream for its own. Same shape, same rules —
/// which is why the writer can apply `-metadata:s:a:1 title=…` and
/// `-x264-params …` through one reader.
std::vector<ExportOption> optionsFromJs(JSContext* ctx, JSValueConst owner, const char* key) {
    std::vector<ExportOption> out;
    JSValue obj = JS_GetPropertyStr(ctx, owner, key);
    if (!JS_IsObject(obj)) { JS_FreeValue(ctx, obj); return out; }

    JSPropertyEnum* props = nullptr;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &props, &count, obj, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < count; ++i) {
            JSValue v = JS_GetProperty(ctx, obj, props[i].atom);
            // An option deliberately left unset is absent, not empty: null and
            // undefined mean "do not pass this", which is what lets the UI keep
            // a blank field in its model without it reaching the encoder.
            if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
                const char* name = JS_AtomToCString(ctx, props[i].atom);
                size_t len = 0;
                const char* val = JS_ToCStringLen(ctx, &len, v);
                if (name && val && *name) out.push_back({name, std::string(val, len)});
                if (name) JS_FreeCString(ctx, name);
                if (val) JS_FreeCString(ctx, val);
            }
            JS_FreeValue(ctx, v);
            JS_FreeAtom(ctx, props[i].atom);
        }
        js_free(ctx, props);
    }
    JS_FreeValue(ctx, obj);
    return out;
}

/// How long a JS array says it is. Three copies of these four lines were
/// enough.
uint32_t arrayLength(JSContext* ctx, JSValueConst arr) {
    JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, lenv);
    JS_FreeValue(ctx, lenv);
    return len;
}

/// `spec.streams` — what the file is made of, one entry per stream the muxer
/// will number.
///
/// Absent is not "no streams": it means the render this application wrote
/// before there was a list at all, and `outputStreams()` synthesises one video
/// stream from the composite and one audio stream from the mix out of the named
/// fields. Present, it is authoritative — the order here is the order a player
/// shows in its track menu.
///
/// **A malformed entry is an error with a reason, never a stream quietly left
/// out.** The whole value of writing down what is in the output is that the
/// output is what was written down, and a render that succeeded while dropping
/// the second audio track is the one outcome worse than a refusal.
bool streamsFromJs(JSContext* ctx, JSValueConst spec, std::vector<ExportStream>* out,
                   std::string* err) {
    JSValue arr = JS_GetPropertyStr(ctx, spec, "streams");
    if (JS_IsUndefined(arr) || JS_IsNull(arr)) { JS_FreeValue(ctx, arr); return true; }
    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        *err = "spec.streams has to be an array of streams";
        return false;
    }

    const uint32_t len = arrayLength(ctx, arr);
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        JSValue item = JS_GetPropertyUint32(ctx, arr, i);
        const std::string where = "streams[" + std::to_string(i) + "]";
        if (!JS_IsObject(item)) {
            *err = where + " is not a stream";
            ok = false;
        } else {
            ExportStream st;
            st.kind = strProp(ctx, item, "kind", "");
            // Checked here as well as in the writer, because this is where the
            // index of the offending entry is still in hand: "streams[3] is a
            // 'subtitle'" says where to look and "there is no such thing as a
            // 'subtitle' output stream" does not.
            if (st.kind != "video" && st.kind != "audio" && st.kind != "attachment") {
                *err = where + " is a '" + st.kind +
                       "', and this build writes video, audio and attachment streams";
                ok = false;
            } else {
                st.source = strProp(ctx, item, "source", "");
                st.codec = strProp(ctx, item, "codec", "");
                st.options = optionsFromJs(ctx, item, "options");
                st.metadata = optionsFromJs(ctx, item, "metadata");
                st.language = strProp(ctx, item, "language", "");
                st.disposition = strProp(ctx, item, "disposition", "");
                st.tag = strProp(ctx, item, "tag", "");
                // Every one of these has a sentinel meaning "take the render's",
                // so a list that says nothing new about them is a list somebody
                // would write by hand.
                st.crf = static_cast<int>(numProp(ctx, item, "crf", -1));
                st.bitrateKbps = static_cast<int>(numProp(ctx, item, "bitrate", 0));
                st.preset = strProp(ctx, item, "preset", "");
                st.pixelFormat = strProp(ctx, item, "pixelFormat", "");
                st.sampleRate = static_cast<int>(numProp(ctx, item, "sampleRate", 0));
                st.channels = static_cast<int>(numProp(ctx, item, "channels", 0));
                st.path = strProp(ctx, item, "path", "");
                st.mimeType = strProp(ctx, item, "mimeType", "");
                if (st.kind == "attachment" && st.path.empty()) {
                    *err = where + " is an attachment with no file to attach";
                    ok = false;
                } else {
                    out->push_back(std::move(st));
                }
            }
        }
        JS_FreeValue(ctx, item);
    }
    JS_FreeValue(ctx, arr);
    return ok;
}

/// `spec.chapters` — `[{ start, end, title }, …]`, in output-timeline seconds.
///
/// Beside the streams rather than among them, because that is what a chapter
/// is: a table in the container with no index, nothing mapped to it and no
/// packets of its own.
bool chaptersFromJs(JSContext* ctx, JSValueConst spec, std::vector<ExportChapter>* out,
                    std::string* err) {
    JSValue arr = JS_GetPropertyStr(ctx, spec, "chapters");
    if (JS_IsUndefined(arr) || JS_IsNull(arr)) { JS_FreeValue(ctx, arr); return true; }
    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        *err = "spec.chapters has to be an array of chapter marks";
        return false;
    }

    const uint32_t len = arrayLength(ctx, arr);
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        JSValue item = JS_GetPropertyUint32(ctx, arr, i);
        const std::string where = "chapters[" + std::to_string(i) + "]";
        if (!JS_IsObject(item)) {
            *err = where + " is not a chapter mark";
            ok = false;
        } else {
            ExportChapter c;
            c.start = numProp(ctx, item, "start", 0);
            c.end = numProp(ctx, item, "end", 0);
            c.title = strProp(ctx, item, "title", "");
            // A mark that ends before it begins is a mistake somewhere above,
            // and a muxer asked to write one produces a file whose chapter list
            // no player agrees about.
            if (!(c.end > c.start)) {
                *err = where + " ends at or before it starts";
                ok = false;
            } else {
                out->push_back(std::move(c));
            }
        }
        JS_FreeValue(ctx, item);
    }
    JS_FreeValue(ctx, arr);
    return ok;
}

/// `spec.filterInputs` — `[{ label: "0:v", path: "…", stream: "v" }, …]`, which
/// is what the graph's own input nodes carry. Given rather than inferred from
/// the clip order, for the reason ExportGraphInput states.
std::vector<ExportGraphInput> graphInputsFromJs(JSContext* ctx, JSValueConst spec) {
    std::vector<ExportGraphInput> out;
    JSValue arr = JS_GetPropertyStr(ctx, spec, "filterInputs");
    if (JS_IsArray(arr)) {
        const uint32_t len = arrayLength(ctx, arr);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, arr, i);
            if (JS_IsObject(item)) {
                ExportGraphInput g;
                g.label = strProp(ctx, item, "label", "");
                g.path = strProp(ctx, item, "path", "");
                g.stream = strProp(ctx, item, "stream", "v");
                g.from = numProp(ctx, item, "from", 0.0);
                out.push_back(std::move(g));
            }
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, arr);
    return out;
}

JSValue js_renderStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "render.start(spec) requires a spec object");
    JSValueConst spec = argv[0];

    ExportSettings s;
    s.path = strProp(ctx, spec, "path", "");
    s.format = strProp(ctx, spec, "format", "");
    s.width = static_cast<int>(numProp(ctx, spec, "width", 1920));
    s.height = static_cast<int>(numProp(ctx, spec, "height", 1080));
    s.fps = numProp(ctx, spec, "fps", 30);
    s.startTime = numProp(ctx, spec, "start", 0);
    s.endTime = numProp(ctx, spec, "end", 0);
    s.videoCodec = strProp(ctx, spec, "videoCodec", "libx264");
    s.audioCodec = strProp(ctx, spec, "audioCodec", "aac");
    s.crf = static_cast<int>(numProp(ctx, spec, "crf", 20));
    s.videoBitrateKbps = static_cast<int>(numProp(ctx, spec, "videoBitrate", 0));
    s.preset = strProp(ctx, spec, "preset", "medium");
    s.includeAudio = boolProp(ctx, spec, "audio", true);
    s.audioBitrateKbps = static_cast<int>(numProp(ctx, spec, "audioBitrate", 192));
    s.audioSampleRate = static_cast<int>(numProp(ctx, spec, "sampleRate", 48000));
    s.audioChannels = static_cast<int>(numProp(ctx, spec, "channels", 2));
    s.pixelFormat = strProp(ctx, spec, "pixelFormat", "");
    s.scaler = strProp(ctx, spec, "scaler", "");
    s.colorspace = strProp(ctx, spec, "colorspace", "");
    s.colorRange = strProp(ctx, spec, "colorRange", "");
    s.faststart = boolProp(ctx, spec, "faststart", true);
    s.title = strProp(ctx, spec, "title", "");
    s.videoOptions = optionsFromJs(ctx, spec, "videoOptions");
    s.audioOptions = optionsFromJs(ctx, spec, "audioOptions");
    s.formatOptions = optionsFromJs(ctx, spec, "formatOptions");
    s.filterGraph = strProp(ctx, spec, "filterGraph", "");
    s.filterInputs = graphInputsFromJs(ctx, spec);
    s.sizeFromGraph = boolProp(ctx, spec, "sizeFromGraph", false);
    s.metadata = optionsFromJs(ctx, spec, "metadata");

    // Read before anything is started, so a list that cannot be honoured is a
    // thrown TypeError with the offending entry named rather than a job that
    // fails a second later with the index long gone.
    std::string bad;
    if (!streamsFromJs(ctx, spec, &s.streams, &bad) ||
        !chaptersFromJs(ctx, spec, &s.chapters, &bad))
        return JS_ThrowTypeError(ctx, "%s", bad.c_str());

    std::vector<ExportClip> clips;
    JSValue arr = JS_GetPropertyStr(ctx, spec, "clips");
    if (JS_IsArray(arr)) {
        const uint32_t len = arrayLength(ctx, arr);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, arr, i);
            if (JS_IsObject(item)) clips.push_back(clipFromJs(ctx, item));
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, arr);

    std::string err;
    if (!startExport(s, clips, &err))
        return JS_ThrowTypeError(ctx, "cannot start the render: %s", err.c_str());
    return JS_TRUE;
}

const char* stateName(ExportStatus::State s) {
    switch (s) {
        case ExportStatus::State::Running:   return "running";
        case ExportStatus::State::Done:      return "done";
        case ExportStatus::State::Failed:    return "failed";
        case ExportStatus::State::Cancelled: return "cancelled";
        case ExportStatus::State::Idle:      break;
    }
    return "idle";
}

/// What a render said, drained onto the object `poll()` already returns.
///
/// `poll()` is the marshalling point for the same reason it is the only way to
/// watch a render at all: the job runs on its own thread and QuickJS has one, so
/// a callback would have to be posted onto this thread and looked at from the
/// animation frame — which is where the caller already is. Draining here costs
/// the poll it was going to make anyway.
///
/// **A cursor rather than a flush.** The caller says what it has already seen
/// and gets what it has not, so two consumers cannot take each other's messages
/// and a poll that is dropped on the floor loses nothing. It is also why a
/// render's last words survive the job: the rings belong to the process, and
/// draining them after the thread has gone is an ordinary read.
void attachReport(JSContext* ctx, JSValue o, JSValueConst since) {
    uint64_t log = 0, meta = 0;
    int max = 512;
    if (JS_IsObject(since)) {
        log = static_cast<uint64_t>(std::max(0.0, numProp(ctx, since, "log", 0)));
        meta = static_cast<uint64_t>(std::max(0.0, numProp(ctx, since, "meta", 0)));
        max = static_cast<int>(numProp(ctx, since, "max", 512));
    }
    const ReportDrain d = drainReport(log, meta, max);

    JSValue logs = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& r : d.logs) {
        JSValue m = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, m, "seq", JS_NewInt64(ctx, static_cast<int64_t>(r.seq)));
        JS_SetPropertyStr(ctx, m, "job", JS_NewInt64(ctx, static_cast<int64_t>(r.job)));
        JS_SetPropertyStr(ctx, m, "at", JS_NewFloat64(ctx, r.at));
        setStr(ctx, m, "level", logLevelName(r.level));
        JS_SetPropertyStr(ctx, m, "severity", JS_NewInt32(ctx, r.level));
        setStr(ctx, m, "source", r.source);
        setStr(ctx, m, "text", r.text);
        JS_SetPropertyUint32(ctx, logs, i++, m);
    }
    JS_SetPropertyStr(ctx, o, "log", logs);

    JSValue series = JS_NewArray(ctx);
    i = 0;
    for (const auto& r : d.meta) {
        JSValue m = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, m, "seq", JS_NewInt64(ctx, static_cast<int64_t>(r.seq)));
        JS_SetPropertyStr(ctx, m, "job", JS_NewInt64(ctx, static_cast<int64_t>(r.job)));
        JS_SetPropertyStr(ctx, m, "at", JS_NewFloat64(ctx, r.at));
        setStr(ctx, m, "stream", r.stream);
        setStr(ctx, m, "key", r.key);
        setStr(ctx, m, "value", r.value);
        JS_SetPropertyUint32(ctx, series, i++, m);
    }
    JS_SetPropertyStr(ctx, o, "meta", series);

    JSValue cur = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, cur, "log", JS_NewInt64(ctx, static_cast<int64_t>(d.logCursor)));
    JS_SetPropertyStr(ctx, cur, "meta", JS_NewInt64(ctx, static_cast<int64_t>(d.metaCursor)));
    JS_SetPropertyStr(ctx, cur, "logDropped",
                      JS_NewInt64(ctx, static_cast<int64_t>(d.logsDropped)));
    JS_SetPropertyStr(ctx, cur, "metaDropped",
                      JS_NewInt64(ctx, static_cast<int64_t>(d.metaDropped)));
    JS_SetPropertyStr(ctx, o, "cursor", cur);
}

JSValue js_renderPoll(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    const ExportStatus st = exportStatus();
    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "state", stateName(st.state));
    JS_SetPropertyStr(ctx, o, "running",
                      JS_NewBool(ctx, st.state == ExportStatus::State::Running));
    JS_SetPropertyStr(ctx, o, "progress", JS_NewFloat64(ctx, st.progress));
    JS_SetPropertyStr(ctx, o, "frames", JS_NewInt64(ctx, st.framesDone));
    JS_SetPropertyStr(ctx, o, "totalFrames", JS_NewInt64(ctx, st.framesTotal));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, st.elapsedSec));
    JS_SetPropertyStr(ctx, o, "fps", JS_NewFloat64(ctx, st.encodeFps));
    JS_SetPropertyStr(ctx, o, "bytes", JS_NewInt64(ctx, st.bytesWritten));
    setStr(ctx, o, "path", st.path);
    setStr(ctx, o, "stage", st.stage);
    setStr(ctx, o, "error", st.error);
    // Which render this is, so that what the channel below says can be pinned
    // to it. Zero while nothing is running — a probe and a decoder warning are
    // worth reading too, and they belong to no render.
    JS_SetPropertyStr(ctx, o, "job",
                      JS_NewInt64(ctx, static_cast<int64_t>(currentRenderJob())));
    // Only when asked. Every caller that wants a progress bar and nothing else
    // — and there are three of them — should not pay for building two arrays
    // sixty times a second.
    if (argc >= 1) attachReport(ctx, o, argv[0]);
    return o;
}

JSValue js_renderCancel(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    cancelExport();
    return JS_UNDEFINED;
}

JSValue stringsToJs(JSContext* ctx, const std::vector<std::string>& v) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& s : v)
        JS_SetPropertyUint32(ctx, arr, i++, JS_NewStringLen(ctx, s.data(), s.size()));
    return arr;
}

JSValue intsToJs(JSContext* ctx, const std::vector<int>& v) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (int n : v) JS_SetPropertyUint32(ctx, arr, i++, JS_NewInt32(ctx, n));
    return arr;
}

JSValue codecListToJs(JSContext* ctx, const std::vector<CodecOption>& list) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& c : list) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "id", c.id);
        setStr(ctx, o, "label", c.label);
        setStr(ctx, o, "longName", c.longName);
        JS_SetPropertyStr(ctx, o, "crf", JS_NewBool(ctx, c.supportsCrf));
        JS_SetPropertyStr(ctx, o, "preset", JS_NewBool(ctx, c.supportsPreset));
        JS_SetPropertyStr(ctx, o, "qp", JS_NewBool(ctx, c.supportsQp));
        JS_SetPropertyStr(ctx, o, "tune", JS_NewBool(ctx, c.supportsTune));
        JS_SetPropertyStr(ctx, o, "hardware", JS_NewBool(ctx, c.hardware));
        JS_SetPropertyStr(ctx, o, "intraOnly", JS_NewBool(ctx, c.intraOnly));
        JS_SetPropertyStr(ctx, o, "lossless", JS_NewBool(ctx, c.lossless));
        JS_SetPropertyStr(ctx, o, "alwaysLossless", JS_NewBool(ctx, c.alwaysLossless));
        JS_SetPropertyStr(ctx, o, "losslessOption", JS_NewBool(ctx, c.losslessOption));
        JS_SetPropertyStr(ctx, o, "crfMin", JS_NewFloat64(ctx, c.crfMin));
        JS_SetPropertyStr(ctx, o, "crfMax", JS_NewFloat64(ctx, c.crfMax));
        JS_SetPropertyStr(ctx, o, "crfDefault", JS_NewFloat64(ctx, c.crfDefault));
        JS_SetPropertyStr(ctx, o, "pixelFormats", stringsToJs(ctx, c.pixelFormats));
        JS_SetPropertyStr(ctx, o, "presets", stringsToJs(ctx, c.presets));
        JS_SetPropertyStr(ctx, o, "tunes", stringsToJs(ctx, c.tunes));
        JS_SetPropertyStr(ctx, o, "profiles", stringsToJs(ctx, c.profiles));
        JS_SetPropertyStr(ctx, o, "profileLabels", stringsToJs(ctx, c.profileLabels));
        JS_SetPropertyStr(ctx, o, "sampleRates", intsToJs(ctx, c.sampleRates));
        JS_SetPropertyStr(ctx, o, "channelCounts", intsToJs(ctx, c.channelCounts));
        JS_SetPropertyStr(ctx, o, "containers", stringsToJs(ctx, c.containers));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue optionsToJs(JSContext* ctx, const std::vector<OptionInfo>& opts) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& o : opts) {
        JSValue e = JS_NewObject(ctx);
        setStr(ctx, e, "name", o.name);
        setStr(ctx, e, "help", o.help);
        setStr(ctx, e, "type", o.type);
        setStr(ctx, e, "unit", o.unit);
        setStr(ctx, e, "default", o.defaultValue);
        JS_SetPropertyStr(ctx, e, "min", JS_NewFloat64(ctx, o.min));
        JS_SetPropertyStr(ctx, e, "max", JS_NewFloat64(ctx, o.max));
        JS_SetPropertyStr(ctx, e, "hasRange", JS_NewBool(ctx, o.hasRange));

        JSValue vals = JS_NewArray(ctx);
        uint32_t vi = 0;
        for (const auto& v : o.values) {
            JSValue vo = JS_NewObject(ctx);
            setStr(ctx, vo, "name", v.name);
            setStr(ctx, vo, "help", v.help);
            JS_SetPropertyStr(ctx, vo, "value", JS_NewInt64(ctx, v.value));
            JS_SetPropertyUint32(ctx, vals, vi++, vo);
        }
        JS_SetPropertyStr(ctx, e, "values", vals);
        JS_SetPropertyUint32(ctx, arr, i++, e);
    }
    return arr;
}

/// A name argument, or an exception. Both option lookups take one and neither
/// should answer for the empty string.
bool takeName(JSContext* ctx, int argc, JSValueConst* argv, std::string* out) {
    if (argc < 1 || !JS_IsString(argv[0])) return false;
    const char* s = JS_ToCString(ctx, argv[0]);
    if (!s) return false;
    *out = s;
    JS_FreeCString(ctx, s);
    return true;
}

/// bro.ffmpeg.encoderOptions(name) — every private option of one encoder.
/// Looked up on demand rather than built for all of them at startup: x265
/// alone has some eighty, and the dialog only ever shows one encoder's.
JSValue js_encoderOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "encoderOptions(name) requires an encoder name");
    return optionsToJs(ctx, encoderOptions(name));
}

/// bro.ffmpeg.filterOptions(name) — one filter's arguments, for the same
/// reason and drawn the same way. On demand for a stronger reason than the
/// encoders': there are some five hundred filters, and building every option
/// table at startup would be most of a second before the window opened.
JSValue js_filterOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "filterOptions(name) requires a filter name");
    return optionsToJs(ctx, filterOptions(name));
}

/// bro.ffmpeg.muxerOptions(name) / demuxerOptions(name) / decoderOptions(name)
/// / protocolOptions(name) — the same walk `encoderOptions` does, over the
/// other four kinds of thing in libav that carry an AVClass.
///
/// All on demand. There are a hundred and eighty muxers, three hundred and
/// fifty demuxers and as many decoders, and their option tables are the
/// expensive part of describing any of them — which is precisely why
/// `filterOptions` is asked one filter at a time.
JSValue js_muxerOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "muxerOptions(name) requires a muxer name");
    return optionsToJs(ctx, muxerOptions(name));
}

JSValue js_demuxerOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "demuxerOptions(name) requires a demuxer name");
    return optionsToJs(ctx, demuxerOptions(name));
}

JSValue js_decoderOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "decoderOptions(name) requires a decoder name");
    return optionsToJs(ctx, decoderOptions(name));
}

JSValue js_protocolOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "protocolOptions(name) requires a protocol name");
    return optionsToJs(ctx, protocolOptions(name));
}

/// bro.ffmpeg.deviceSources(name) — what one capture device can see now.
///
/// The one query in this file that talks to hardware, which is why it is a
/// function rather than a list built at startup: enumerating DirectShow asks
/// every camera driver on the machine. A device with nothing to enumerate
/// answers with `ok: false` and a reason, because an empty list reads as a
/// machine with no cameras in it.
JSValue js_deviceSources(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "deviceSources(name) requires a device name");
    const DeviceSourceList list = deviceSources(name);

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "ok", JS_NewBool(ctx, list.ok));
    setStr(ctx, out, "error", list.error);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& s : list.sources) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", s.name);
        setStr(ctx, o, "description", s.description);
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    JS_SetPropertyStr(ctx, out, "sources", arr);
    return out;
}

/// bro.ffmpeg.codecTags(container, codec) — the fourccs this muxer will take
/// for this codec, first being what it writes by itself. The `-tag:v hvc1`
/// control is drawn from this rather than being a four-character text box: a
/// tag nobody has seen before is a tag nobody types.
JSValue js_codecTags(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "codecTags(container, codec) requires both names");
    const char* ext = JS_ToCString(ctx, argv[0]);
    const char* codec = JS_ToCString(ctx, argv[1]);
    JSValue out = JS_NULL;
    if (ext && codec) out = stringsToJs(ctx, codecTags(ext, codec));
    if (ext) JS_FreeCString(ctx, ext);
    if (codec) JS_FreeCString(ctx, codec);
    return JS_IsNull(out) ? JS_NewArray(ctx) : out;
}

/// The four registries, in the shape a picker wants. One function each rather
/// than one generic one: they answer different questions, and the fields are
/// what makes each list navigable — a muxer's are what a picker groups by, a
/// device's are which half of libavdevice it came from.
JSValue muxersToJs(JSContext* ctx) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& m : availableMuxers()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", m.name);
        setStr(ctx, o, "label", m.label);
        setStr(ctx, o, "longName", m.longName);
        setStr(ctx, o, "ext", m.ext);
        JS_SetPropertyStr(ctx, o, "extensions", stringsToJs(ctx, m.extensions));
        setStr(ctx, o, "mimeType", m.mimeType);
        setStr(ctx, o, "videoCodec", m.videoCodec);
        setStr(ctx, o, "audioCodec", m.audioCodec);
        setStr(ctx, o, "defaultVideo", m.defaultVideo);
        setStr(ctx, o, "defaultAudio", m.defaultAudio);
        setStr(ctx, o, "defaultSubtitle", m.defaultSubtitle);
        JS_SetPropertyStr(ctx, o, "noFile", JS_NewBool(ctx, m.noFile));
        JS_SetPropertyStr(ctx, o, "globalHeader", JS_NewBool(ctx, m.globalHeader));
        JS_SetPropertyStr(ctx, o, "noTimestamps", JS_NewBool(ctx, m.noTimestamps));
        JS_SetPropertyStr(ctx, o, "stills", JS_NewBool(ctx, m.stills));
        JS_SetPropertyStr(ctx, o, "device", JS_NewBool(ctx, m.device));
        JS_SetPropertyStr(ctx, o, "videoCodecs", stringsToJs(ctx, m.videoCodecs));
        JS_SetPropertyStr(ctx, o, "audioCodecs", stringsToJs(ctx, m.audioCodecs));
        JS_SetPropertyStr(ctx, o, "answersCodecs", JS_NewBool(ctx, m.answersCodecs));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue demuxersToJs(JSContext* ctx) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& d : availableDemuxers()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", d.name);
        setStr(ctx, o, "longName", d.longName);
        JS_SetPropertyStr(ctx, o, "extensions", stringsToJs(ctx, d.extensions));
        setStr(ctx, o, "mimeType", d.mimeType);
        JS_SetPropertyStr(ctx, o, "noFile", JS_NewBool(ctx, d.noFile));
        JS_SetPropertyStr(ctx, o, "device", JS_NewBool(ctx, d.device));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue decodersToJs(JSContext* ctx) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& d : availableDecoders()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", d.name);
        setStr(ctx, o, "longName", d.longName);
        setStr(ctx, o, "type", d.type);
        JS_SetPropertyStr(ctx, o, "hardware", JS_NewBool(ctx, d.hardware));
        JS_SetPropertyStr(ctx, o, "experimental", JS_NewBool(ctx, d.experimental));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue protocolsToJs(JSContext* ctx) {
    const ProtocolList p = availableProtocols();
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "input", stringsToJs(ctx, p.input));
    JS_SetPropertyStr(ctx, o, "output", stringsToJs(ctx, p.output));
    return o;
}

JSValue devicesToJs(JSContext* ctx) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& d : availableDevices()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", d.name);
        setStr(ctx, o, "longName", d.longName);
        setStr(ctx, o, "kind", d.kind);
        setStr(ctx, o, "direction", d.direction);
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue filtersToJs(JSContext* ctx) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& f : availableFilters()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", f.name);
        setStr(ctx, o, "description", f.description);
        setStr(ctx, o, "inputs", f.inputs);
        setStr(ctx, o, "outputs", f.outputs);
        JS_SetPropertyStr(ctx, o, "dynamicInputs", JS_NewBool(ctx, f.dynamicInputs));
        JS_SetPropertyStr(ctx, o, "dynamicOutputs", JS_NewBool(ctx, f.dynamicOutputs));
        JS_SetPropertyStr(ctx, o, "timeline", JS_NewBool(ctx, f.timeline));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue js_tempPath(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "tempPath(name) requires a name");
    const char* name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    const std::string out = tempPath(name);
    JS_FreeCString(ctx, name);
    return JS_NewStringLen(ctx, out.data(), out.size());
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

    // What this build can write, asked of libavcodec rather than assumed: a
    // menu offering H.265 on a build without x265 is a menu that fails at the
    // last step.
    JS_SetPropertyStr(ctx, ns, "encoders", codecListToJs(ctx, availableVideoEncoders()));
    JS_SetPropertyStr(ctx, ns, "audioEncoders", codecListToJs(ctx, availableAudioEncoders()));

    // Every muxer this build links, by the name `-f` takes. This was four
    // extensions in a table — mp4, mkv, mov, webm — and everything else the
    // build could write was compiled in and unreachable because of it. Built at
    // startup because the entries are small: a hundred and eighty names, long
    // names, extensions and flags. Their *option tables* are the expensive part
    // and are asked for one muxer at a time, exactly as a filter's are.
    JS_SetPropertyStr(ctx, ns, "muxers", muxersToJs(ctx));
    JS_SetPropertyStr(ctx, ns, "demuxers", demuxersToJs(ctx));
    JS_SetPropertyStr(ctx, ns, "decoders", decodersToJs(ctx));
    JS_SetPropertyStr(ctx, ns, "protocols", protocolsToJs(ctx));
    JS_SetPropertyStr(ctx, ns, "devices", devicesToJs(ctx));

    JS_SetPropertyStr(ctx, ns, "encoderOptions",
                      JS_NewCFunction(ctx, js_encoderOptions, "encoderOptions", 1));
    JS_SetPropertyStr(ctx, ns, "muxerOptions",
                      JS_NewCFunction(ctx, js_muxerOptions, "muxerOptions", 1));
    JS_SetPropertyStr(ctx, ns, "demuxerOptions",
                      JS_NewCFunction(ctx, js_demuxerOptions, "demuxerOptions", 1));
    JS_SetPropertyStr(ctx, ns, "decoderOptions",
                      JS_NewCFunction(ctx, js_decoderOptions, "decoderOptions", 1));
    JS_SetPropertyStr(ctx, ns, "protocolOptions",
                      JS_NewCFunction(ctx, js_protocolOptions, "protocolOptions", 1));
    JS_SetPropertyStr(ctx, ns, "deviceSources",
                      JS_NewCFunction(ctx, js_deviceSources, "deviceSources", 1));
    JS_SetPropertyStr(ctx, ns, "codecTags",
                      JS_NewCFunction(ctx, js_codecTags, "codecTags", 2));
    // Small enough to build once: thirty-odd names, and every stream row on
    // the Write stage draws a toggle per entry.
    JS_SetPropertyStr(ctx, ns, "dispositions", stringsToJs(ctx, streamDispositions()));

    // What this build can put a picture *through*, which is the palette the
    // graph stage picks from. A list of names and pad shapes is small; the
    // options behind each are asked for one filter at a time.
    JS_SetPropertyStr(ctx, ns, "filters", filtersToJs(ctx));
    JS_SetPropertyStr(ctx, ns, "filterOptions",
                      JS_NewCFunction(ctx, js_filterOptions, "filterOptions", 1));
    JS_SetPropertyStr(ctx, ns, "tempPath", JS_NewCFunction(ctx, js_tempPath, "tempPath", 1));

    JSValue render = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, render, "start", JS_NewCFunction(ctx, js_renderStart, "start", 1));
    JS_SetPropertyStr(ctx, render, "poll", JS_NewCFunction(ctx, js_renderPoll, "poll", 1));
    JS_SetPropertyStr(ctx, render, "cancel", JS_NewCFunction(ctx, js_renderCancel, "cancel", 0));
    JS_SetPropertyStr(ctx, ns, "render", render);
    JS_SetPropertyStr(ctx, ns, "openOnStart",
                      g_initialMedia.empty()
                          ? JS_NULL
                          : JS_NewStringLen(ctx, g_initialMedia.data(), g_initialMedia.size()));

    JS_SetPropertyStr(ctx, broObj, "ffmpeg", ns);
    JS_FreeValue(ctx, broObj);
    JS_FreeValue(ctx, global);
}

} // namespace ffmpegbro
