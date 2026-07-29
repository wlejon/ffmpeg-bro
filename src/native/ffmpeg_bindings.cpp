#include "ffmpeg_bindings.h"

#include "export_copy.h"
#include "export_subtitle.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_capture.h"
#include "ffmpeg_export.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_hardware.h"
#include "ffmpeg_report.h"

extern "C" {
#include <libavutil/pixdesc.h>
}
#include "ffmpeg_sequence.h"

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

/// `{ g: 60, bf: 2, "x264-params": "aq-mode=3" }` — the natural JS shape for a
/// bag of ffmpeg arguments. Numbers are stringified here rather than in the UI
/// so that a control emitting 23 and one emitting "23" mean the same thing.
///
/// `owner` is whatever object the bag hangs off: the spec for the render's own
/// options and metadata, a stream for its own, an input for its demuxer's.
/// Same shape, same rules — which is why one reader serves
/// `-metadata:s:a:1 title=…`, `-x264-params …` and `-probesize`.
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


/// `{ path, format, options, ss, t, to, itsoffset }` — one `-i`, as JS writes
/// one. Used by `probe`, by `inputs.define` and by `spec.inputs`, so that the
/// thing the Sources stage probes and the thing the render opens cannot come to
/// be described differently.
///
/// `to` is `-to`: the same decision as `t` stated as an end time. Converted
/// here rather than in the UI because there is one right answer — a window that
/// ends before it starts is empty, not negative — and three callers.
MediaInput inputFromJs(JSContext* ctx, JSValueConst o) {
    MediaInput in;
    if (!JS_IsObject(o)) return in;
    in.path = strProp(ctx, o, "path", "");
    in.format = strProp(ctx, o, "format", "");
    in.options = optionsFromJs(ctx, o, "options");
    // The decoders reading this input, as against the demuxer opening it.
    // Separate bags because they are separate objects with separate option
    // tables — `-probesize` is libavformat's and `-skip_frame` is libavcodec's,
    // and ffmpeg writes both in front of the same `-i` because both are
    // decisions about this input.
    in.decoderOptions = optionsFromJs(ctx, o, "decoderOptions");
    // The device this input's pictures are decoded on, and whether they come
    // back down. `-hwaccel`, `-hwaccel_device` and `-hwaccel_output_format`,
    // all three of which ffmpeg writes in front of the `-i` because all three
    // configure the decoder that this input's packets go through.
    in.hwaccel = strProp(ctx, o, "hwaccel", "");
    in.hwaccelDevice = strProp(ctx, o, "hwaccelDevice", "");
    in.hwaccelOutputFormat = strProp(ctx, o, "hwaccelOutputFormat", "");
    in.ss = std::max(0.0, numProp(ctx, o, "ss", 0));
    in.duration = std::max(0.0, numProp(ctx, o, "t", 0));
    const double to = numProp(ctx, o, "to", 0);
    if (to > 0.0) in.duration = std::max(0.0, to - in.ss);
    in.itsoffset = numProp(ctx, o, "itsoffset", 0);
    // `-stream_loop`, the one thing here libavformat has never heard of.
    // Everything an image sequence or a still needs — `-framerate`,
    // `-start_number`, `-pattern_type`, `-loop` — is an `image2` demuxer
    // option and arrives in `options` above, unchanged from what a command
    // line would say.
    in.streamLoop = static_cast<int>(numProp(ctx, o, "streamLoop", 0));
    return in;
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
    // Which `-i` this clip is cut from. A spec that says nothing carries a path
    // instead and renders exactly as it always did, which is what keeps the
    // fixture generator and every hand-written spec in the tests working.
    c.input = static_cast<int>(numProp(ctx, o, "input", -1));
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

/// How long a JS array says it is. Three copies of these four lines were
/// enough.
uint32_t arrayLength(JSContext* ctx, JSValueConst arr) {
    JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, lenv);
    JS_FreeValue(ctx, lenv);
    return len;
}

/// `stream.bsf` — `[{ name, options }, …]`, in the order they run.
///
/// A list rather than the comma-separated string `-bsf:v` takes, because it is
/// a list: the order is the whole of the meaning, each entry has its own option
/// table, and a string would have to be parsed back out to say either of those
/// in a UI. The string is what gets *printed*; this is what gets built.
bool bsfFromJs(JSContext* ctx, JSValueConst item, const std::string& where,
               std::vector<ExportBsf>* out, std::string* err) {
    JSValue arr = JS_GetPropertyStr(ctx, item, "bsf");
    if (JS_IsUndefined(arr) || JS_IsNull(arr)) { JS_FreeValue(ctx, arr); return true; }
    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        *err = where + ".bsf has to be an array of bitstream filters";
        return false;
    }
    const uint32_t len = arrayLength(ctx, arr);
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        JSValue e = JS_GetPropertyUint32(ctx, arr, i);
        ExportBsf b;
        if (JS_IsString(e)) {
            // `bsf: ["dump_extra"]` — the common case, where the filter takes
            // nothing and naming it is the whole instruction.
            const char* s = JS_ToCString(ctx, e);
            if (s) { b.name = s; JS_FreeCString(ctx, s); }
        } else if (JS_IsObject(e)) {
            b.name = strProp(ctx, e, "name", "");
            b.options = optionsFromJs(ctx, e, "options");
        }
        if (b.name.empty()) {
            *err = where + ".bsf[" + std::to_string(i) + "] has no filter name";
            ok = false;
        } else {
            out->push_back(std::move(b));
        }
        JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, arr);
    return ok;
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
            // 'data'" says where to look and "there is no such thing as a
            // 'data' output stream" does not.
            if (st.kind != "video" && st.kind != "audio" && st.kind != "attachment" &&
                st.kind != "subtitle") {
                *err = where + " is a '" + st.kind +
                       "', and this build writes video, audio, subtitle and attachment "
                       "streams";
                ok = false;
            } else {
                st.source = strProp(ctx, item, "source", "");
                st.codec = strProp(ctx, item, "codec", "");
                // The span a copied stream takes out of its input, on the
                // input's own clock. Meaningless on a composed stream and
                // simply unread there, which is why they are not guarded: a
                // `composite` carrying a `copyFrom` is a caller's leftover
                // field and not a decision anything acts on.
                st.copyFrom = numProp(ctx, item, "copyFrom", 0);
                st.copyTo = numProp(ctx, item, "copyTo", 0);
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
                // 0 is "the render's" for a composite-fed stream and "ask the
                // graph" for one fed from a pad — see ExportStream. A stream
                // that says nothing about its size is by far the usual one.
                st.width = static_cast<int>(numProp(ctx, item, "width", 0));
                st.height = static_cast<int>(numProp(ctx, item, "height", 0));
                st.preset = strProp(ctx, item, "preset", "");
                st.pixelFormat = strProp(ctx, item, "pixelFormat", "");
                st.sampleRate = static_cast<int>(numProp(ctx, item, "sampleRate", 0));
                st.channels = static_cast<int>(numProp(ctx, item, "channels", 0));
                st.forceKeyFrames = strProp(ctx, item, "forceKeyFrames", "");
                st.fieldOrder = strProp(ctx, item, "fieldOrder", "");
                st.threads = static_cast<int>(numProp(ctx, item, "threads", -1));
                st.threadType = strProp(ctx, item, "threadType", "");
                st.path = strProp(ctx, item, "path", "");
                st.mimeType = strProp(ctx, item, "mimeType", "");
                if (!bsfFromJs(ctx, item, where, &st.bitstreamFilters, err)) {
                    ok = false;
                } else if (st.kind == "attachment" && st.path.empty()) {
                    *err = where + " is an attachment with no file to attach";
                    ok = false;
                } else if (st.kind == "subtitle" && !isCopySource(st.source) &&
                           !isDecodeSource(st.source)) {
                    // There is no composed subtitle track. A subtitle stream is
                    // one that was already in a file — carried through as
                    // packets, or decoded and written again in the codec this
                    // container holds — and a row that says neither is a row
                    // that would produce an empty track rather than an error.
                    *err = where + " is a subtitle stream fed from '" + st.source +
                           "', and a subtitle stream comes from copy:<input>:<stream> or "
                           "decode:<input>:<stream>";
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
                g.input = static_cast<int>(numProp(ctx, item, "input", -1));
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

/// `spec.passes` — a render that is more than one render.
///
/// Every field is "the render's unless this says otherwise", so an entry of
/// `{}` is a pass that renders exactly the spec around it. The two things that
/// need this are a two-pass *filter* (`vidstabdetect` writes a file,
/// `vidstabtransform` reads it) and a two-pass *encoder* (`-pass 1` writes a
/// statistics log, `-pass 2` spends the bitrate knowing where it is needed) —
/// both of which hand off through a file on disk, which is why nothing here
/// carries anything between the passes.
std::vector<ExportPass> passesFromJs(JSContext* ctx, JSValueConst spec) {
    std::vector<ExportPass> out;
    JSValue arr = JS_GetPropertyStr(ctx, spec, "passes");
    if (JS_IsArray(arr)) {
        const uint32_t len = arrayLength(ctx, arr);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, arr, i);
            if (JS_IsObject(item)) {
                ExportPass p;
                p.label = strProp(ctx, item, "label", "");
                p.filterGraph = strProp(ctx, item, "filterGraph", "");
                p.filterInputs = graphInputsFromJs(ctx, item);
                p.path = strProp(ctx, item, "path", "");
                p.format = strProp(ctx, item, "format", "");
                p.videoCodec = strProp(ctx, item, "videoCodec", "");
                p.videoOptions = optionsFromJs(ctx, item, "videoOptions");
                p.audioOptions = optionsFromJs(ctx, item, "audioOptions");
                p.discard = boolProp(ctx, item, "discard", false);
                out.push_back(std::move(p));
            }
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, arr);
    return out;
}

/// `spec.inputs` — the `-i`s, in the order the graph's labels number them.
///
/// Read before anything else in the spec, because a clip's `input` is an index
/// into this and an index into a list that was not given is a mistake worth
/// naming: a render that silently fell back to opening the path with default
/// options would be the "succeeded while ignoring what it was told" failure one
/// level up from an unknown option.
bool inputsFromJs(JSContext* ctx, JSValueConst spec, std::vector<MediaInput>* out,
                  std::string* err) {
    JSValue arr = JS_GetPropertyStr(ctx, spec, "inputs");
    if (JS_IsUndefined(arr) || JS_IsNull(arr)) { JS_FreeValue(ctx, arr); return true; }
    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        *err = "spec.inputs has to be an array of inputs";
        return false;
    }
    const uint32_t len = arrayLength(ctx, arr);
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        JSValue item = JS_GetPropertyUint32(ctx, arr, i);
        const std::string where = "inputs[" + std::to_string(i) + "]";
        if (!JS_IsObject(item)) {
            *err = where + " is not an input";
            ok = false;
        } else {
            MediaInput in = inputFromJs(ctx, item);
            if (in.path.empty()) {
                *err = where + " has no path or URL to open";
                ok = false;
            } else {
                out->push_back(std::move(in));
            }
        }
        JS_FreeValue(ctx, item);
    }
    JS_FreeValue(ctx, arr);
    return ok;
}

/// Everything about the *output* of a job: the file, the muxer, the encoders,
/// their options and the stream list.
///
/// One reader for two callers, because a recording writes its file exactly the
/// way a render writes one — same encoders, same muxer, same `-key value` bags,
/// same stream list — and a second copy of this would be a second set of
/// defaults for a capture to quietly disagree with an export about.
bool outputFromJs(JSContext* ctx, JSValueConst spec, ExportSettings* out, std::string* err) {
    ExportSettings& s = *out;
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
    // The defaults every video stream takes. Named fields rather than option
    // bag entries because none of them is an encoder option: `-force_key_frames`
    // sets a frame's picture type, `-shortest` ends the loop, and the field
    // order has to reach the frames as well as the encoder.
    s.forceKeyFrames = strProp(ctx, spec, "forceKeyFrames", "");
    s.fieldOrder = strProp(ctx, spec, "fieldOrder", "");
    s.threads = static_cast<int>(numProp(ctx, spec, "threads", 0));
    s.threadType = strProp(ctx, spec, "threadType", "");
    s.shortest = boolProp(ctx, spec, "shortest", false);
    s.videoOptions = optionsFromJs(ctx, spec, "videoOptions");
    s.audioOptions = optionsFromJs(ctx, spec, "audioOptions");
    s.formatOptions = optionsFromJs(ctx, spec, "formatOptions");
    s.filterGraph = strProp(ctx, spec, "filterGraph", "");
    s.filterInputs = graphInputsFromJs(ctx, spec);
    s.sizeFromGraph = boolProp(ctx, spec, "sizeFromGraph", false);
    // `-filter_hw_device`: which device `hwupload` and the `_cuda`/`_qsv`
    // filters get. A decision about the graph rather than about any input,
    // which is why it is here and not on one.
    s.filterHwDevice = strProp(ctx, spec, "filterHwDevice", "");
    s.filterHwDeviceIndex = strProp(ctx, spec, "filterHwDeviceIndex", "");
    s.passes = passesFromJs(ctx, spec);
    s.metadata = optionsFromJs(ctx, spec, "metadata");

    // Read before anything is started, so a list that cannot be honoured is a
    // thrown TypeError with the offending entry named rather than a job that
    // fails a second later with the index long gone.
    return inputsFromJs(ctx, spec, &s.inputs, err) &&
           streamsFromJs(ctx, spec, &s.streams, err) &&
           chaptersFromJs(ctx, spec, &s.chapters, err);
}

JSValue js_renderStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "render.start(spec) requires a spec object");
    JSValueConst spec = argv[0];

    ExportSettings s;
    std::string bad;
    if (!outputFromJs(ctx, spec, &s, &bad))
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
    uint64_t jobNumber = 0;
    if (!startExport(s, clips, &err, &jobNumber))
        return JS_ThrowTypeError(ctx, "cannot start the render: %s", err.c_str());
    // **Which render this is**, rather than `true`. Every record in the channel
    // below says which render it was said during, and a caller that means to
    // read its own render's measurements back has nowhere else to learn the
    // number: `poll()`'s `job` is the render running *now*, so it is already
    // zero by the frame a caller sees `done` — which is precisely the frame it
    // comes to read. A positive integer is truthy, so nothing that only checked
    // for success notices.
    return JS_NewInt64(ctx, static_cast<int64_t>(jobNumber));
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
    // This job runs until somebody stops it, so `progress` and `totalFrames`
    // are not answers. Read it before drawing a bar: a fraction of an unknown
    // total is zero, and a bar at zero for ten minutes says "stuck" rather
    // than "recording". See ffmpeg_capture.h.
    JS_SetPropertyStr(ctx, o, "openEnded", JS_NewBool(ctx, st.openEnded));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, st.elapsedSec));
    JS_SetPropertyStr(ctx, o, "fps", JS_NewFloat64(ctx, st.encodeFps));
    JS_SetPropertyStr(ctx, o, "bytes", JS_NewInt64(ctx, st.bytesWritten));
    // How many files the muxer opened beside the one it was named with. Zero
    // for an ordinary render, so nothing has to know segmenters exist; the
    // segments of an hls or a segment render, the chunks of a dash one, the
    // pictures of an image2 one and the destinations of a tee otherwise. It is
    // what a progress readout for a segmented render counts, because "43% of
    // the frames" says nothing about how many files have arrived.
    JS_SetPropertyStr(ctx, o, "pieces", JS_NewInt64(ctx, st.piecesWritten));
    setStr(ctx, o, "path", st.path);
    setStr(ctx, o, "stage", st.stage);
    // Which pass of how many, and what it is called. One of one for an
    // ordinary render, so nothing has to know there is such a thing as a pass
    // — but a job that is going to walk the range again must not report "43%"
    // and leave the rest to be discovered.
    JS_SetPropertyStr(ctx, o, "pass", JS_NewInt32(ctx, st.pass));
    JS_SetPropertyStr(ctx, o, "passes", JS_NewInt32(ctx, st.passCount));
    setStr(ctx, o, "passLabel", st.passLabel);
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

JSValue js_recordStop(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    stopCapture();
    return JS_UNDEFINED;
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

JSValue js_livePads(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    int64_t id = 0;
    if (argc >= 1) JS_ToInt64(ctx, &id, argv[0]);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& p : livePads(static_cast<uint64_t>(id))) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", p.name);
        JS_SetPropertyStr(ctx, o, "device", JS_NewBool(ctx, p.device));
        JS_SetPropertyStr(ctx, o, "width", JS_NewInt32(ctx, p.width));
        JS_SetPropertyStr(ctx, o, "height", JS_NewInt32(ctx, p.height));
        // The src an element takes, made here rather than spelled out in the
        // UI: the token's shape is this binary's and a second place that knew
        // it would be a second place to change.
        setStr(ctx, o, "src", "/@live/" + std::to_string(id) + "/" + p.name);
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    return arr;
}

JSValue js_liveClose(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    int64_t id = 0;
    if (argc >= 1 && JS_ToInt64(ctx, &id, argv[0]) == 0 && id > 0)
        closeLive(static_cast<uint64_t>(id));
    else
        closeAllLive();
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
        // The codec, as against the encoder: `libx264` writes `h264`. Anything
        // that talks about codecs rather than encoders — a bitstream filter's
        // list of what it runs on — needs this and cannot derive it.
        setStr(ctx, o, "codecName", c.codecName);
        JS_SetPropertyStr(ctx, o, "crf", JS_NewBool(ctx, c.supportsCrf));
        JS_SetPropertyStr(ctx, o, "preset", JS_NewBool(ctx, c.supportsPreset));
        JS_SetPropertyStr(ctx, o, "qp", JS_NewBool(ctx, c.supportsQp));
        JS_SetPropertyStr(ctx, o, "tune", JS_NewBool(ctx, c.supportsTune));
        JS_SetPropertyStr(ctx, o, "hardware", JS_NewBool(ctx, c.hardware));
        JS_SetPropertyStr(ctx, o, "intraOnly", JS_NewBool(ctx, c.intraOnly));
        // Subtitles: text rather than pictures. The one fact that decides
        // whether a conversion is possible at all, so it travels with the
        // codec rather than being worked out from its name.
        JS_SetPropertyStr(ctx, o, "textSub", JS_NewBool(ctx, c.textSub));
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

/// bro.ffmpeg.hardware() — what this *machine* has, as against what this build
/// could use.
///
/// A function rather than a property beside `hwaccels`, and that difference is
/// the whole of what this chunk added at this level. `hwaccels` is
/// `av_hwdevice_iterate_types` — a registry walk, free, and an answer about the
/// build: on a machine with no graphics card at all it still says cuda, qsv,
/// vulkan and d3d11va, because every one of them is compiled in. This is the
/// measurement: each type has a device *created* of it and reports whether that
/// worked. Creating a CUDA context is tens of milliseconds and creating one of
/// every type is the better part of a second, so it is asked for rather than
/// built at startup — the same reason `filterOptions(name)` is a call.
///
/// Cached in the native half, so a UI that asks on every redraw pays once.
JSValue js_hardware(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (const auto& d : hwDevices()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", d.name);
        JS_SetPropertyStr(ctx, o, "present", JS_NewBool(ctx, d.present));
        if (!d.error.empty()) setStr(ctx, o, "error", d.error);
        const char* fmt = d.pixelFormat != AV_PIX_FMT_NONE
                              ? av_get_pix_fmt_name(d.pixelFormat) : nullptr;
        setStr(ctx, o, "pixelFormat", fmt ? fmt : "");
        JS_SetPropertyStr(ctx, o, "decoders", stringsToJs(ctx, d.decoders));
        JS_SetPropertyStr(ctx, o, "encoders", stringsToJs(ctx, d.encoders));
        JS_SetPropertyStr(ctx, o, "filters", stringsToJs(ctx, d.filters));
        JS_SetPropertyUint32(ctx, arr, n++, o);
    }
    return arr;
}

JSValue js_bsfOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "bsfOptions(name) requires a bitstream filter name");
    return optionsToJs(ctx, bsfOptions(name));
}

JSValue js_protocolOptions(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string name;
    if (!takeName(ctx, argc, argv, &name))
        return JS_ThrowTypeError(ctx, "protocolOptions(name) requires a protocol name");
    return optionsToJs(ctx, protocolOptions(name));
}

/// bro.ffmpeg.keyframes(path | input, { stream, from, to, max }) — where a copy
/// can start.
///
/// **A copied stream can only begin at a keyframe**, and where they are is a
/// fact about the input rather than about the render. It is here as a query
/// rather than as something a render hands back, because the whole point is to
/// know before the render: an in-point that lands between two keyframes costs
/// exactly the difference, and discovering that afterwards is discovering it
/// from a file that starts in the wrong place.
///
/// `how` says where the answer came from — the demuxer's own index, which is
/// instant and exact, or a scan of the window for a container that has none —
/// and `complete` is false when the walk was cut short, because a list of
/// keyframes that quietly stops is a list somebody would snap to the wrong end
/// of.
JSValue js_keyframes(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "keyframes(path) requires a path or an input");

    MediaInput in;
    JSValueConst opts = argc >= 2 ? argv[1] : JS_UNDEFINED;
    if (JS_IsObject(argv[0])) {
        in = inputFromJs(ctx, argv[0]);
    } else {
        const char* path = JS_ToCString(ctx, argv[0]);
        if (!path) return JS_EXCEPTION;
        in.path = path;
        JS_FreeCString(ctx, path);
    }
    int stream = -1;
    double from = 0, to = 0;
    int max = 0;
    if (JS_IsObject(opts)) {
        stream = static_cast<int>(numProp(ctx, opts, "stream", -1));
        from = numProp(ctx, opts, "from", 0);
        to = numProp(ctx, opts, "to", 0);
        max = static_cast<int>(numProp(ctx, opts, "max", 0));
    }

    KeyframeList list;
    std::string err;
    if (!keyframesOf(in, stream, from, to, max, &list, &err))
        return JS_ThrowTypeError(ctx, "%s", err.c_str());

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "stream", JS_NewInt32(ctx, list.stream));
    setStr(ctx, out, "how", list.how);
    JS_SetPropertyStr(ctx, out, "complete", JS_NewBool(ctx, list.complete));
    JS_SetPropertyStr(ctx, out, "from", JS_NewFloat64(ctx, list.from));
    JS_SetPropertyStr(ctx, out, "to", JS_NewFloat64(ctx, list.to));
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (double t : list.times) JS_SetPropertyUint32(ctx, arr, i++, JS_NewFloat64(ctx, t));
    JS_SetPropertyStr(ctx, out, "times", arr);
    return out;
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
        JS_SetPropertyStr(ctx, o, "mediaTypes", stringsToJs(ctx, s.mediaTypes));
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
    // Named `container` and not `ext`: this is the muxer's own name, the thing
    // `-f` takes. Calling it an extension is how a caller comes to pass "mkv"
    // to a function that only knows "matroska".
    const char* container = JS_ToCString(ctx, argv[0]);
    const char* codec = JS_ToCString(ctx, argv[1]);
    JSValue out = JS_NULL;
    if (container && codec) out = stringsToJs(ctx, codecTags(container, codec));
    if (container) JS_FreeCString(ctx, container);
    if (codec) JS_FreeCString(ctx, codec);
    return JS_IsNull(out) ? JS_NewArray(ctx) : out;
}

// The encoder libavformat itself would reach for. `image2`'s extension names a
// codec rather than a container, so this is what decides whether `out%04d.png`
// is PNG or the mjpeg its muxer declares as a default.
JSValue js_guessCodec(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "guessCodec(muxer, path) requires both");
    const char* muxer = JS_ToCString(ctx, argv[0]);
    const char* path = JS_ToCString(ctx, argv[1]);
    const bool audio = argc >= 3 && JS_ToBool(ctx, argv[2]);
    std::string name;
    if (muxer && path) name = guessEncoder(muxer, path, audio);
    if (muxer) JS_FreeCString(ctx, muxer);
    if (path) JS_FreeCString(ctx, path);
    return JS_NewStringLen(ctx, name.data(), name.size());
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
        setStr(ctx, o, "subtitleCodec", m.subtitleCodec);
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
        JS_SetPropertyStr(ctx, o, "subtitleCodecs", stringsToJs(ctx, m.subtitleCodecs));
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

/// bro.ffmpeg.bitstreamFilters — the stage between the encoder and the muxer.
///
/// Small enough to build once: thirty-odd names and the codecs each will run
/// on. The option tables behind them are asked for one at a time, exactly as a
/// filter's are, because a chain editor only ever shows one.
JSValue bsfsToJs(JSContext* ctx) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& b : availableBitstreamFilters()) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "name", b.name);
        // Empty is "any codec" and is a real answer — `setts` and `noise`
        // declare no list at all — so a caller narrowing a menu has to read it
        // as "all of them" rather than as "none".
        JS_SetPropertyStr(ctx, o, "codecs", stringsToJs(ctx, b.codecs));
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

JSValue js_inputsForget(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string id;
    if (!takeName(ctx, argc, argv, &id))
        return JS_ThrowTypeError(ctx, "inputs.forget(id) requires an id");
    forgetInput(id);
    return JS_UNDEFINED;
}

JSValue js_inputsToken(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string id;
    if (!takeName(ctx, argc, argv, &id))
        return JS_ThrowTypeError(ctx, "inputs.token(id) requires an id");
    const std::string token = inputToken(id);
    return JS_NewStringLen(ctx, token.data(), token.size());
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

// ── files that are one input ───────────────────────────────────────────────
//
// A drop of three hundred numbered PNGs is one `-i`, not three hundred, and
// working that out is the single most-used path into image sequences. What is
// exposed is the *scan* rather than a directory listing, because the guess and
// its refusals belong in one place: see ffmpeg_sequence.h for the rules.

JSValue js_sequences(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "sequences(paths) requires paths");
    std::vector<std::string> paths;
    if (JS_IsString(argv[0])) {
        const char* one = JS_ToCString(ctx, argv[0]);
        if (!one) return JS_EXCEPTION;
        paths.emplace_back(one);
        JS_FreeCString(ctx, one);
    } else {
        uint32_t n = 0;
        JSValue len = JS_GetPropertyStr(ctx, argv[0], "length");
        JS_ToUint32(ctx, &n, len);
        JS_FreeValue(ctx, len);
        for (uint32_t i = 0; i < n; ++i) {
            JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
            const char* one = JS_ToCString(ctx, v);
            if (one) { paths.emplace_back(one); JS_FreeCString(ctx, one); }
            JS_FreeValue(ctx, v);
        }
    }

    const SequenceScan scan = scanForSequences(paths);
    JSValue out = JS_NewObject(ctx);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& q : scan.sequences) {
        JSValue o = JS_NewObject(ctx);
        setStr(ctx, o, "dir", q.dir);
        setStr(ctx, o, "pattern", q.pattern);
        setStr(ctx, o, "prefix", q.prefix);
        setStr(ctx, o, "suffix", q.suffix);
        setStr(ctx, o, "first", q.first);
        JS_SetPropertyStr(ctx, o, "digits", JS_NewInt32(ctx, q.digits));
        JS_SetPropertyStr(ctx, o, "start", JS_NewInt64(ctx, q.start));
        JS_SetPropertyStr(ctx, o, "end", JS_NewInt64(ctx, q.end));
        JS_SetPropertyStr(ctx, o, "count", JS_NewInt32(ctx, q.count));
        JS_SetPropertyStr(ctx, o, "missing", JS_NewInt32(ctx, q.missing));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    JS_SetPropertyStr(ctx, out, "sequences", arr);
    JSValue singles = JS_NewArray(ctx);
    i = 0;
    for (const auto& one : scan.singles)
        JS_SetPropertyUint32(ctx, singles, i++,
                             JS_NewStringLen(ctx, one.data(), one.size()));
    JS_SetPropertyStr(ctx, out, "singles", singles);
    return out;
}

JSValue js_frameNames(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "frameNames(pattern, start, count) requires a pattern");
    const char* pattern = JS_ToCString(ctx, argv[0]);
    if (!pattern) return JS_EXCEPTION;
    int64_t start = 1;
    int32_t count = 3;
    if (argc >= 2) JS_ToInt64(ctx, &start, argv[1]);
    if (argc >= 3) JS_ToInt32(ctx, &count, argv[2]);
    std::string err;
    const auto names = frameFilenames(pattern, start, std::max(0, std::min(count, 4096)), &err);
    JS_FreeCString(ctx, pattern);
    if (names.empty() && !err.empty()) return JS_ThrowTypeError(ctx, "%s", err.c_str());
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const auto& n : names)
        JS_SetPropertyUint32(ctx, arr, i++, JS_NewStringLen(ctx, n.data(), n.size()));
    return arr;
}

JSValue js_hasFramePattern(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString(argv[0])) return JS_FALSE;
    const char* path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    const bool yes = hasFramePattern(path);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, yes);
}

JSValue js_concatList(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "concatList(path, files) requires a path and files");
    const char* path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    // Either a path or `{ path, duration }`. The duration is worth having and
    // is not decoration: without one the concat demuxer reports no length at
    // all until something has read to the end of the last file — see
    // ffmpeg_sequence.h.
    std::vector<ConcatEntry> files;
    uint32_t n = 0;
    JSValue len = JS_GetPropertyStr(ctx, argv[1], "length");
    JS_ToUint32(ctx, &n, len);
    JS_FreeValue(ctx, len);
    for (uint32_t i = 0; i < n; ++i) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[1], i);
        ConcatEntry entry;
        if (JS_IsObject(v)) {
            entry.path = strProp(ctx, v, "path", "");
            entry.duration = numProp(ctx, v, "duration", 0);
        } else if (const char* one = JS_ToCString(ctx, v)) {
            entry.path = one;
            JS_FreeCString(ctx, one);
        }
        if (!entry.path.empty()) files.push_back(std::move(entry));
        JS_FreeValue(ctx, v);
    }
    std::string err;
    const bool ok = writeConcatList(path, files, &err);
    const std::string written = path;
    JS_FreeCString(ctx, path);
    if (!ok) return JS_ThrowTypeError(ctx, "%s", err.c_str());
    return JS_NewStringLen(ctx, written.data(), written.size());
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
    // The list above is what this *build* has. This is what this *machine* has,
    // and it is a call rather than a property because finding out means
    // creating a device of every type and seeing which ones work — see
    // js_hardware.
    JS_SetPropertyStr(ctx, ns, "hardware", JS_NewCFunction(ctx, js_hardware, "hardware", 0));

    JS_SetPropertyStr(ctx, ns, "probe", JS_NewCFunction(ctx, js_probe, "probe", 1));

    // What this build can write, asked of libavcodec rather than assumed: a
    // menu offering H.265 on a build without x265 is a menu that fails at the
    // last step.
    JS_SetPropertyStr(ctx, ns, "encoders", codecListToJs(ctx, availableVideoEncoders()));
    JS_SetPropertyStr(ctx, ns, "audioEncoders", codecListToJs(ctx, availableAudioEncoders()));
    // The third list, and the first one that is not a judgement about which
    // entries are worth offering: there are nine subtitle encoders and each is
    // an interchange format asked for by name, so this is the registry walk
    // rather than a candidate list checked against the build.
    JS_SetPropertyStr(ctx, ns, "subtitleEncoders",
                      codecListToJs(ctx, availableSubtitleEncoders()));

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
    JS_SetPropertyStr(ctx, ns, "bitstreamFilters", bsfsToJs(ctx));
    JS_SetPropertyStr(ctx, ns, "bsfOptions",
                      JS_NewCFunction(ctx, js_bsfOptions, "bsfOptions", 1));
    JS_SetPropertyStr(ctx, ns, "deviceSources",
                      JS_NewCFunction(ctx, js_deviceSources, "deviceSources", 1));
    // Where a copy can start. A query about an input rather than a capability
    // of the build, and the one thing that makes a lossless cut a decision
    // somebody takes rather than one they discover.
    JS_SetPropertyStr(ctx, ns, "keyframes",
                      JS_NewCFunction(ctx, js_keyframes, "keyframes", 2));
    JS_SetPropertyStr(ctx, ns, "codecTags",
                      JS_NewCFunction(ctx, js_codecTags, "codecTags", 2));
    JS_SetPropertyStr(ctx, ns, "guessCodec",
                      JS_NewCFunction(ctx, js_guessCodec, "guessCodec", 3));
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

    // What a drop of files and folders amounts to, and the two things that
    // make an assembled input out of the answer. `globPatterns` is the one
    // capability here that cannot be enumerated and is asked by trying — see
    // ffmpeg_sequence.h.
    JS_SetPropertyStr(ctx, ns, "sequences",
                      JS_NewCFunction(ctx, js_sequences, "sequences", 1));
    JS_SetPropertyStr(ctx, ns, "frameNames",
                      JS_NewCFunction(ctx, js_frameNames, "frameNames", 3));
    JS_SetPropertyStr(ctx, ns, "hasFramePattern",
                      JS_NewCFunction(ctx, js_hasFramePattern, "hasFramePattern", 1));
    JS_SetPropertyStr(ctx, ns, "concatList",
                      JS_NewCFunction(ctx, js_concatList, "concatList", 2));
    JS_SetPropertyStr(ctx, ns, "imageExtensions", stringsToJs(ctx, imageExtensions()));
    JS_SetPropertyStr(ctx, ns, "globPatterns",
                      JS_NewBool(ctx, globPatternsSupported()));

    // The inputs playback knows about. Registered rather than passed, because
    // `<video src>` is a string — see the note above these functions.
    JSValue inputs = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, inputs, "define",
                      JS_NewCFunction(ctx, js_inputsDefine, "define", 2));
    JS_SetPropertyStr(ctx, inputs, "forget",
                      JS_NewCFunction(ctx, js_inputsForget, "forget", 1));
    JS_SetPropertyStr(ctx, inputs, "token",
                      JS_NewCFunction(ctx, js_inputsToken, "token", 1));
    JS_SetPropertyStr(ctx, ns, "inputs", inputs);

    JSValue render = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, render, "start", JS_NewCFunction(ctx, js_renderStart, "start", 1));
    JS_SetPropertyStr(ctx, render, "poll", JS_NewCFunction(ctx, js_renderPoll, "poll", 1));
    JS_SetPropertyStr(ctx, render, "cancel", JS_NewCFunction(ctx, js_renderCancel, "cancel", 0));
    JS_SetPropertyStr(ctx, ns, "render", render);

    // Recording shares `render.poll()` on purpose: there is one job slot and
    // one status, and a second poll would be a second answer to "is something
    // running?" — which is the question every door in the UI asks.
    JSValue record = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, record, "start", JS_NewCFunction(ctx, js_recordStart, "start", 1));
    JS_SetPropertyStr(ctx, record, "stop", JS_NewCFunction(ctx, js_recordStop, "stop", 0));
    JS_SetPropertyStr(ctx, ns, "record", record);

    // Watching is *not* under `record`, and not under `render` either: a
    // session writes nothing, holds no job slot and shares no status with
    // either of them. What it shares with a recording is how a device is read,
    // and that is in the C++ rather than in this surface.
    JSValue live = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, live, "open", JS_NewCFunction(ctx, js_liveOpen, "open", 1));
    JS_SetPropertyStr(ctx, live, "pads", JS_NewCFunction(ctx, js_livePads, "pads", 1));
    JS_SetPropertyStr(ctx, live, "close", JS_NewCFunction(ctx, js_liveClose, "close", 1));
    JS_SetPropertyStr(ctx, ns, "live", live);

    JS_SetPropertyStr(ctx, ns, "openOnStart",
                      g_initialMedia.empty()
                          ? JS_NULL
                          : JS_NewStringLen(ctx, g_initialMedia.data(), g_initialMedia.size()));

    JS_SetPropertyStr(ctx, broObj, "ffmpeg", ns);
    JS_FreeValue(ctx, broObj);
    JS_FreeValue(ctx, global);
}

} // namespace ffmpegbro
