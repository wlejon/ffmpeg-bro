// The spec readers declared in bindings_spec.h: `ui/export/spec.js`'s object
// turned into `ExportSettings`, `MediaInput` and the vectors that hang off
// them. The argument for why this is one file with these callers is in the
// header; what is here is the reading itself.

#include "bindings_spec.h"

#include "bindings_value.h"
#include "export_copy.h"
#include "export_subtitle.h"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

namespace ffmpegbro {

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
    // **One is the default and anything not positive reads as one**, which is the
    // same sentence `ui/project.js`'s `speedOf` and `graph/derive.js`'s copy of it
    // say: zero would be a freeze frame and negative would be reverse, and neither
    // is expressible on this path — a negative slope here would ask the readers to
    // walk backwards, which is precisely what they cannot do. So a spec written
    // before speed existed, and every hand-written one in `tests/`, renders exactly
    // as it did.
    c.speed = numProp(ctx, o, "speed", 1.0);
    if (!(c.speed > 0.0)) c.speed = 1.0;
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
            // 'chapter'" says where to look and "there is no such thing as a
            // 'chapter' output stream" does not.
            if (st.kind != "video" && st.kind != "audio" && st.kind != "attachment" &&
                st.kind != "subtitle" && st.kind != "data") {
                *err = where + " is a '" + st.kind +
                       "', and this build writes video, audio, subtitle, data and "
                       "attachment streams";
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
                } else if (st.kind == "data" && !isCopySource(st.source)) {
                    // **A data stream is only ever a copy**, and unlike the
                    // subtitle rule above that is not a gap waiting to be
                    // filled. Timed metadata, a camera's timecode track, a
                    // GoPro's telemetry — nothing in this binary composes any
                    // of it, and there is no `decode:` half either, because
                    // there is nothing to decode one *into*. What the bytes
                    // mean is the reading application's business, which is
                    // exactly why carrying them through is worth doing and
                    // interpreting them is not.
                    *err = where + " is a data stream fed from '" + st.source +
                           "', and a data stream can only be copied — nothing here makes "
                           "one, so it comes from copy:<input>:<stream>";
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

/// A `clips` array off whatever object carries one — the spec, or one of its
/// passes. Absent and empty read the same, which is what lets a pass say
/// nothing about the stack and get the render's.
std::vector<ExportClip> clipsFromJs(JSContext* ctx, JSValueConst o) {
    std::vector<ExportClip> out;
    JSValue arr = JS_GetPropertyStr(ctx, o, "clips");
    if (JS_IsArray(arr)) {
        const uint32_t len = arrayLength(ctx, arr);
        for (uint32_t i = 0; i < len; ++i) {
            JSValue item = JS_GetPropertyUint32(ctx, arr, i);
            if (JS_IsObject(item)) out.push_back(clipFromJs(ctx, item));
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
                // A size and the rectangles that go with it: the other thing a
                // pass is for, which is a second encode of the same edit rather
                // than a second walk of the same encode.
                p.width = static_cast<int>(numProp(ctx, item, "width", 0));
                p.height = static_cast<int>(numProp(ctx, item, "height", 0));
                p.clips = clipsFromJs(ctx, item);
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
    // `keepTrying` — one decision, read here as one object, because "keep going
    // if the destination drops" is a thing somebody asks for and `-f fifo
    // -fifo_format flv -attempt_recovery 1 -recovery_wait_time 2` is what it
    // means. Every number defaults to a sentinel meaning "leave it to libav",
    // so a spec that says nothing but `on` gets the `fifo` muxer's own answers
    // and this file writes none of them down. See `ExportSettings::FifoSettings`.
    {
        JSValue f = JS_GetPropertyStr(ctx, spec, "keepTrying");
        if (JS_IsObject(f)) {
            s.fifo.on = boolProp(ctx, f, "on", false);
            s.fifo.queueSize = static_cast<int>(numProp(ctx, f, "queueSize", 0));
            s.fifo.waitSeconds = numProp(ctx, f, "waitSeconds", -1);
            s.fifo.maxAttempts = static_cast<int>(numProp(ctx, f, "maxAttempts", 0));
            s.fifo.dropOnOverflow = boolProp(ctx, f, "dropOnOverflow", false);
            s.fifo.restartWithKeyframe = boolProp(ctx, f, "restartWithKeyframe", false);
        }
        JS_FreeValue(ctx, f);
    }
    // The defaults every video stream takes. Named fields rather than option
    // bag entries because none of them is an encoder option: `-force_key_frames`
    // sets a frame's picture type, `-shortest` ends the loop, and the field
    // order has to reach the frames as well as the encoder.
    s.forceKeyFrames = strProp(ctx, spec, "forceKeyFrames", "");
    s.fieldOrder = strProp(ctx, spec, "fieldOrder", "");
    s.threads = static_cast<int>(numProp(ctx, spec, "threads", 0));
    s.threadType = strProp(ctx, spec, "threadType", "");
    s.shortest = boolProp(ctx, spec, "shortest", false);
    // `-fps_mode:v`, which is not an encoder option either: it decides how the
    // range is *walked*, and the two answers are two loops. Empty is `cfr`, and
    // anything but `cfr` or `vfr` is refused by `startExport` naming the word —
    // the check is there rather than here because the recording and the output
    // preview read this same object and each has its own answer about it.
    s.fpsMode = strProp(ctx, spec, "fpsMode", "");
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

} // namespace ffmpegbro
