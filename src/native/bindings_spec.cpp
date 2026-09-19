// The spec readers declared in bindings_spec.h: `ui/export/spec.js`'s object
// turned into `ExportSettings`, `MediaInput` and the vectors that hang off
// them. The argument for why this is one file with these callers is in the
// header; what is here is the reading itself.

#include "bindings_spec.h"

#include "bindings_value.h"
#include "export_copy.h"
#include "export_subtitle.h"

#include <embed/embed.h>

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
std::vector<ExportOption> optionsFromJs(bronze::Value owner, const char* key) {
    namespace ev = bronze::embed;
    std::vector<ExportOption> out;
    if (!ev::isObject(owner)) return out;

    ev::Persistent ownerP(owner);
    bronze::Value obj = ev::getProperty(ownerP.get(), key);
    if (!ev::isObject(obj)) return out;

    ev::Persistent objP(obj);
    ev::GlobalValue objCtor = ev::globalValue("Object");
    if (!objCtor.found || !ev::isObject(objCtor.value)) return out;

    ev::Persistent ctorP(objCtor.value);
    bronze::Value entriesFn = ev::getProperty(ctorP.get(), "entries");
    if (!ev::isFunction(entriesFn)) return out;

    ev::Persistent entriesFnP(entriesFn);
    bronze::Value target = objP.get();
    ev::CallResult res = ev::call(entriesFnP.get(), ev::undefined(), std::span<const bronze::Value>(&target, 1));
    if (res.thrown || !ev::isObject(res.value)) return out;

    ev::Persistent entriesP(res.value);
    const uint32_t len = arrayLength(entriesP.get());
    for (uint32_t i = 0; i < len; ++i) {
        bronze::Value pair = ev::getElement(entriesP.get(), i);
        if (!ev::isObject(pair)) continue;
        ev::Persistent pairP(pair);
        ev::Persistent kP(ev::getElement(pairP.get(), 0));
        bronze::Value v = ev::getElement(pairP.get(), 1);
        // An option deliberately left unset is absent, not empty: null and
        // undefined mean "do not pass this", which is what lets the UI keep
        // a blank field in its model without it reaching the encoder.
        if (ev::isUndefined(v) || ev::isNull(v)) continue;

        std::string name;
        if (ev::isString(kP.get())) {
            name = ev::toUtf8(kP.get());
        }
        std::string val;
        if (ev::isString(v) || ev::isNumber(v) || ev::isBool(v)) {
            val = ev::toUtf8(v);
        }
        if (!name.empty()) {
            out.push_back({std::move(name), std::move(val)});
        }
    }
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
MediaInput inputFromJs(bronze::Value o) {
    namespace ev = bronze::embed;
    MediaInput in;
    if (!ev::isObject(o)) return in;
    ev::Persistent op(o);
    in.path = strProp(op.get(), "path", "");
    in.format = strProp(op.get(), "format", "");
    in.options = optionsFromJs(op.get(), "options");
    // The decoders reading this input, as against the demuxer opening it.
    // Separate bags because they are separate objects with separate option
    // tables — `-probesize` is libavformat's and `-skip_frame` is libavcodec's,
    // and ffmpeg writes both in front of the same `-i` because both are
    // decisions about this input.
    in.decoderOptions = optionsFromJs(op.get(), "decoderOptions");
    // The device this input's pictures are decoded on, and whether they come
    // back down. `-hwaccel`, `-hwaccel_device` and `-hwaccel_output_format`,
    // all three of which ffmpeg writes in front of the `-i` because all three
    // configure the decoder that this input's packets go through.
    in.hwaccel = strProp(op.get(), "hwaccel", "");
    in.hwaccelDevice = strProp(op.get(), "hwaccelDevice", "");
    in.hwaccelOutputFormat = strProp(op.get(), "hwaccelOutputFormat", "");
    in.ss = std::max(0.0, numProp(op.get(), "ss", 0));
    in.duration = std::max(0.0, numProp(op.get(), "t", 0));
    const double to = numProp(op.get(), "to", 0);
    if (to > 0.0) in.duration = std::max(0.0, to - in.ss);
    in.itsoffset = numProp(op.get(), "itsoffset", 0);
    // `-stream_loop`, the one thing here libavformat has never heard of.
    // Everything an image sequence or a still needs — `-framerate`,
    // `-start_number`, `-pattern_type`, `-loop` — is an `image2` demuxer
    // option and arrives in `options` above, unchanged from what a command
    // line would say.
    in.streamLoop = static_cast<int>(numProp(op.get(), "streamLoop", 0));
    return in;
}

/// One clip out of `spec.clips`. The placement rectangle arrives in canvas
/// pixels: ui/viewer.js already knows how to work it out and there is no
/// second implementation here to disagree with it.
ExportClip clipFromJs(bronze::Value o) {
    namespace ev = bronze::embed;
    ExportClip c;
    if (!ev::isObject(o)) return c;
    ev::Persistent op(o);
    // Which `-i` this clip is cut from. A spec that says nothing carries a path
    // instead and renders exactly as it always did, which is what keeps the
    // fixture generator and every hand-written spec in the tests working.
    c.input = static_cast<int>(numProp(op.get(), "input", -1));
    c.path = strProp(op.get(), "path", "");
    c.start = numProp(op.get(), "start", 0);
    c.length = numProp(op.get(), "length", 0);
    c.inPoint = numProp(op.get(), "inPoint", 0);
    // **One is the default and anything not positive reads as one**, which is the
    // same sentence `ui/project.js`'s `speedOf` and `graph/derive.js`'s copy of it
    // say: zero would be a freeze frame and negative would be reverse, and neither
    // is expressible on this path — a negative slope here would ask the readers to
    // walk backwards, which is precisely what they cannot do. So a spec written
    // before speed existed, and every hand-written one in `tests/`, renders exactly
    // as it did.
    c.speed = numProp(op.get(), "speed", 1.0);
    if (!(c.speed > 0.0)) c.speed = 1.0;
    c.x = numProp(op.get(), "x", 0);
    c.y = numProp(op.get(), "y", 0);
    c.w = numProp(op.get(), "w", 0);
    c.h = numProp(op.get(), "h", 0);
    c.opacity = numProp(op.get(), "opacity", 1.0);
    c.volume = numProp(op.get(), "volume", 1.0);
    c.muted = boolProp(op.get(), "muted", false);
    c.z = static_cast<int>(numProp(op.get(), "z", 0));

    bronze::Value crop = ev::getProperty(op.get(), "crop");
    if (ev::isObject(crop)) {
        c.cropL = numProp(crop, "l", 0);
        c.cropT = numProp(crop, "t", 0);
        c.cropR = numProp(crop, "r", 0);
        c.cropB = numProp(crop, "b", 0);
    }
    return c;
}

/// `stream.bsf` — `[{ name, options }, …]`, in the order they run.
///
/// A list rather than the comma-separated string `-bsf:v` takes, because it is
/// a list: the order is the whole of the meaning, each entry has its own option
/// table, and a string would have to be parsed back out to say either of those
/// in a UI. The string is what gets *printed*; this is what gets built.
bool bsfFromJs(bronze::Value item, const std::string& where,
               std::vector<ExportBsf>* out, std::string* err) {
    namespace ev = bronze::embed;
    if (!ev::isObject(item)) return true;
    ev::Persistent itemP(item);
    bronze::Value arr = ev::getProperty(itemP.get(), "bsf");
    if (ev::isUndefined(arr) || ev::isNull(arr)) return true;
    if (!isArray(arr)) {
        *err = where + ".bsf has to be an array of bitstream filters";
        return false;
    }
    ev::Persistent arrP(arr);
    const uint32_t len = arrayLength(arrP.get());
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        bronze::Value e = ev::getElement(arrP.get(), i);
        ExportBsf b;
        if (ev::isString(e)) {
            // `bsf: ["dump_extra"]` — the common case, where the filter takes
            // nothing and naming it is the whole instruction.
            b.name = ev::toUtf8(e);
        } else if (ev::isObject(e)) {
            ev::Persistent ep(e);
            b.name = strProp(ep.get(), "name", "");
            b.options = optionsFromJs(ep.get(), "options");
        }
        if (b.name.empty()) {
            *err = where + ".bsf[" + std::to_string(i) + "] has no filter name";
            ok = false;
        } else {
            out->push_back(std::move(b));
        }
    }
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
bool streamsFromJs(bronze::Value spec, std::vector<ExportStream>* out,
                   std::string* err) {
    namespace ev = bronze::embed;
    if (!ev::isObject(spec)) return true;
    ev::Persistent specP(spec);
    bronze::Value arr = ev::getProperty(specP.get(), "streams");
    if (ev::isUndefined(arr) || ev::isNull(arr)) return true;
    if (!isArray(arr)) {
        *err = "spec.streams has to be an array of streams";
        return false;
    }

    ev::Persistent arrP(arr);
    const uint32_t len = arrayLength(arrP.get());
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        bronze::Value item = ev::getElement(arrP.get(), i);
        const std::string where = "streams[" + std::to_string(i) + "]";
        if (!ev::isObject(item)) {
            *err = where + " is not a stream";
            ok = false;
        } else {
            ev::Persistent itemP(item);
            ExportStream st;
            st.kind = strProp(itemP.get(), "kind", "");
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
                st.source = strProp(itemP.get(), "source", "");
                st.codec = strProp(itemP.get(), "codec", "");
                // The span a copied stream takes out of its input, on the
                // input's own clock. Meaningless on a composed stream and
                // simply unread there, which is why they are not guarded: a
                // `composite` carrying a `copyFrom` is a caller's leftover
                // field and not a decision anything acts on.
                st.copyFrom = numProp(itemP.get(), "copyFrom", 0);
                st.copyTo = numProp(itemP.get(), "copyTo", 0);
                st.options = optionsFromJs(itemP.get(), "options");
                st.metadata = optionsFromJs(itemP.get(), "metadata");
                st.language = strProp(itemP.get(), "language", "");
                st.disposition = strProp(itemP.get(), "disposition", "");
                st.tag = strProp(itemP.get(), "tag", "");
                // Every one of these has a sentinel meaning "take the render's",
                // so a list that says nothing new about them is a list somebody
                // would write by hand.
                st.crf = static_cast<int>(numProp(itemP.get(), "crf", -1));
                st.bitrateKbps = static_cast<int>(numProp(itemP.get(), "bitrate", 0));
                // 0 is "the render's" for a composite-fed stream and "ask the
                // graph" for one fed from a pad — see ExportStream. A stream
                // that says nothing about its size is by far the usual one.
                st.width = static_cast<int>(numProp(itemP.get(), "width", 0));
                st.height = static_cast<int>(numProp(itemP.get(), "height", 0));
                st.preset = strProp(itemP.get(), "preset", "");
                st.pixelFormat = strProp(itemP.get(), "pixelFormat", "");
                st.sampleRate = static_cast<int>(numProp(itemP.get(), "sampleRate", 0));
                st.channels = static_cast<int>(numProp(itemP.get(), "channels", 0));
                st.forceKeyFrames = strProp(itemP.get(), "forceKeyFrames", "");
                st.fieldOrder = strProp(itemP.get(), "fieldOrder", "");
                st.threads = static_cast<int>(numProp(itemP.get(), "threads", -1));
                st.threadType = strProp(itemP.get(), "threadType", "");
                st.path = strProp(itemP.get(), "path", "");
                st.mimeType = strProp(itemP.get(), "mimeType", "");
                if (!bsfFromJs(itemP.get(), where, &st.bitstreamFilters, err)) {
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
    }
    return ok;
}

/// `spec.chapters` — `[{ start, end, title }, …]`, in output-timeline seconds.
///
/// Beside the streams rather than among them, because that is what a chapter
/// is: a table in the container with no index, nothing mapped to it and no
/// packets of its own.
bool chaptersFromJs(bronze::Value spec, std::vector<ExportChapter>* out,
                    std::string* err) {
    namespace ev = bronze::embed;
    if (!ev::isObject(spec)) return true;
    ev::Persistent specP(spec);
    bronze::Value arr = ev::getProperty(specP.get(), "chapters");
    if (ev::isUndefined(arr) || ev::isNull(arr)) return true;
    if (!isArray(arr)) {
        *err = "spec.chapters has to be an array of chapter marks";
        return false;
    }

    ev::Persistent arrP(arr);
    const uint32_t len = arrayLength(arrP.get());
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        bronze::Value item = ev::getElement(arrP.get(), i);
        const std::string where = "chapters[" + std::to_string(i) + "]";
        if (!ev::isObject(item)) {
            *err = where + " is not a chapter mark";
            ok = false;
        } else {
            ev::Persistent itemP(item);
            ExportChapter c;
            c.start = numProp(itemP.get(), "start", 0);
            c.end = numProp(itemP.get(), "end", 0);
            c.title = strProp(itemP.get(), "title", "");
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
    }
    return ok;
}

/// `spec.filterInputs` — `[{ label: "0:v", path: "…", stream: "v" }, …]`, which
/// is what the graph's own input nodes carry. Given rather than inferred from
/// the clip order, for the reason ExportGraphInput states.
std::vector<ExportGraphInput> graphInputsFromJs(bronze::Value spec) {
    namespace ev = bronze::embed;
    std::vector<ExportGraphInput> out;
    if (!ev::isObject(spec)) return out;
    ev::Persistent specP(spec);
    bronze::Value arr = ev::getProperty(specP.get(), "filterInputs");
    if (isArray(arr)) {
        ev::Persistent arrP(arr);
        const uint32_t len = arrayLength(arrP.get());
        for (uint32_t i = 0; i < len; ++i) {
            bronze::Value item = ev::getElement(arrP.get(), i);
            if (ev::isObject(item)) {
                ev::Persistent itemP(item);
                ExportGraphInput g;
                g.label = strProp(itemP.get(), "label", "");
                g.input = static_cast<int>(numProp(itemP.get(), "input", -1));
                g.path = strProp(itemP.get(), "path", "");
                g.stream = strProp(itemP.get(), "stream", "v");
                g.from = numProp(itemP.get(), "from", 0.0);
                out.push_back(std::move(g));
            }
        }
    }
    return out;
}

/// A `clips` array off whatever object carries one — the spec, or one of its
/// passes. Absent and empty read the same, which is what lets a pass say
/// nothing about the stack and get the render's.
std::vector<ExportClip> clipsFromJs(bronze::Value o) {
    namespace ev = bronze::embed;
    std::vector<ExportClip> out;
    if (!ev::isObject(o)) return out;
    ev::Persistent op(o);
    bronze::Value arr = ev::getProperty(op.get(), "clips");
    if (isArray(arr)) {
        ev::Persistent arrP(arr);
        const uint32_t len = arrayLength(arrP.get());
        for (uint32_t i = 0; i < len; ++i) {
            bronze::Value item = ev::getElement(arrP.get(), i);
            if (ev::isObject(item)) out.push_back(clipFromJs(item));
        }
    }
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
std::vector<ExportPass> passesFromJs(bronze::Value spec) {
    namespace ev = bronze::embed;
    std::vector<ExportPass> out;
    if (!ev::isObject(spec)) return out;
    ev::Persistent specP(spec);
    bronze::Value arr = ev::getProperty(specP.get(), "passes");
    if (isArray(arr)) {
        ev::Persistent arrP(arr);
        const uint32_t len = arrayLength(arrP.get());
        for (uint32_t i = 0; i < len; ++i) {
            bronze::Value item = ev::getElement(arrP.get(), i);
            if (ev::isObject(item)) {
                ev::Persistent itemP(item);
                ExportPass p;
                p.label = strProp(itemP.get(), "label", "");
                p.filterGraph = strProp(itemP.get(), "filterGraph", "");
                p.filterInputs = graphInputsFromJs(itemP.get());
                p.path = strProp(itemP.get(), "path", "");
                p.format = strProp(itemP.get(), "format", "");
                p.videoCodec = strProp(itemP.get(), "videoCodec", "");
                p.videoOptions = optionsFromJs(itemP.get(), "videoOptions");
                p.audioOptions = optionsFromJs(itemP.get(), "audioOptions");
                // A size and the rectangles that go with it: the other thing a
                // pass is for, which is a second encode of the same edit rather
                // than a second walk of the same encode.
                p.width = static_cast<int>(numProp(itemP.get(), "width", 0));
                p.height = static_cast<int>(numProp(itemP.get(), "height", 0));
                p.clips = clipsFromJs(itemP.get());
                p.discard = boolProp(itemP.get(), "discard", false);
                out.push_back(std::move(p));
            }
        }
    }
    return out;
}

/// `spec.inputs` — the `-i`s, in the order the graph's labels number them.
///
/// Read before anything else in the spec, because a clip's `input` is an index
/// into this and an index into a list that was not given is a mistake worth
/// naming: a render that silently fell back to opening the path with default
/// options would be the "succeeded while ignoring what it was told" failure one
/// level up from an unknown option.
bool inputsFromJs(bronze::Value spec, std::vector<MediaInput>* out,
                  std::string* err) {
    namespace ev = bronze::embed;
    if (!ev::isObject(spec)) return true;
    ev::Persistent specP(spec);
    bronze::Value arr = ev::getProperty(specP.get(), "inputs");
    if (ev::isUndefined(arr) || ev::isNull(arr)) return true;
    if (!isArray(arr)) {
        *err = "spec.inputs has to be an array of inputs";
        return false;
    }
    ev::Persistent arrP(arr);
    const uint32_t len = arrayLength(arrP.get());
    bool ok = true;
    for (uint32_t i = 0; i < len && ok; ++i) {
        bronze::Value item = ev::getElement(arrP.get(), i);
        const std::string where = "inputs[" + std::to_string(i) + "]";
        if (!ev::isObject(item)) {
            *err = where + " is not an input";
            ok = false;
        } else {
            MediaInput in = inputFromJs(item);
            if (in.path.empty()) {
                *err = where + " has no path or URL to open";
                ok = false;
            } else {
                out->push_back(std::move(in));
            }
        }
    }
    return ok;
}

/// Everything about the *output* of a job: the file, the muxer, the encoders,
/// their options and the stream list.
///
/// One reader for two callers, because a recording writes its file exactly the
/// way a render writes one — same encoders, same muxer, same `-key value` bags,
/// same stream list — and a second copy of this would be a second set of
/// defaults for a capture to quietly disagree with an export about.
bool outputFromJs(bronze::Value spec, ExportSettings* out, std::string* err) {
    namespace ev = bronze::embed;
    if (!ev::isObject(spec)) return false;
    ev::Persistent specP(spec);
    ExportSettings& s = *out;
    s.path = strProp(specP.get(), "path", "");
    s.format = strProp(specP.get(), "format", "");
    s.width = static_cast<int>(numProp(specP.get(), "width", 1920));
    s.height = static_cast<int>(numProp(specP.get(), "height", 1080));
    s.fps = numProp(specP.get(), "fps", 30);
    s.startTime = numProp(specP.get(), "start", 0);
    s.endTime = numProp(specP.get(), "end", 0);
    s.videoCodec = strProp(specP.get(), "videoCodec", "libx264");
    s.audioCodec = strProp(specP.get(), "audioCodec", "aac");
    s.crf = static_cast<int>(numProp(specP.get(), "crf", 20));
    s.videoBitrateKbps = static_cast<int>(numProp(specP.get(), "videoBitrate", 0));
    s.preset = strProp(specP.get(), "preset", "medium");
    s.includeAudio = boolProp(specP.get(), "audio", true);
    s.audioBitrateKbps = static_cast<int>(numProp(specP.get(), "audioBitrate", 192));
    s.audioSampleRate = static_cast<int>(numProp(specP.get(), "sampleRate", 48000));
    s.audioChannels = static_cast<int>(numProp(specP.get(), "channels", 2));
    s.pixelFormat = strProp(specP.get(), "pixelFormat", "");
    s.scaler = strProp(specP.get(), "scaler", "");
    s.colorspace = strProp(specP.get(), "colorspace", "");
    s.colorRange = strProp(specP.get(), "colorRange", "");
    s.faststart = boolProp(specP.get(), "faststart", true);
    s.title = strProp(specP.get(), "title", "");
    // `keepTrying` — one decision, read here as one object, because "keep going
    // if the destination drops" is a thing somebody asks for and `-f fifo
    // -fifo_format flv -attempt_recovery 1 -recovery_wait_time 2` is what it
    // means. Every number defaults to a sentinel meaning "leave it to libav",
    // so a spec that says nothing but `on` gets the `fifo` muxer's own answers
    // and this file writes none of them down. See `ExportSettings::FifoSettings`.
    {
        bronze::Value f = ev::getProperty(specP.get(), "keepTrying");
        if (ev::isObject(f)) {
            s.fifo.on = boolProp(f, "on", false);
            s.fifo.queueSize = static_cast<int>(numProp(f, "queueSize", 0));
            s.fifo.waitSeconds = numProp(f, "waitSeconds", -1);
            s.fifo.maxAttempts = static_cast<int>(numProp(f, "maxAttempts", 0));
            s.fifo.dropOnOverflow = boolProp(f, "dropOnOverflow", false);
            s.fifo.restartWithKeyframe = boolProp(f, "restartWithKeyframe", false);
        }
    }
    // The defaults every video stream takes. Named fields rather than option
    // bag entries because none of them is an encoder option: `-force_key_frames`
    // sets a frame's picture type, `-shortest` ends the loop, and the field
    // order has to reach the frames as well as the encoder.
    s.forceKeyFrames = strProp(specP.get(), "forceKeyFrames", "");
    s.fieldOrder = strProp(specP.get(), "fieldOrder", "");
    s.threads = static_cast<int>(numProp(specP.get(), "threads", 0));
    s.threadType = strProp(specP.get(), "threadType", "");
    s.shortest = boolProp(specP.get(), "shortest", false);
    // `-fps_mode:v`, which is not an encoder option either: it decides how the
    // range is *walked*, and the two answers are two loops. Empty is `cfr`, and
    // anything but `cfr` or `vfr` is refused by `startExport` naming the word —
    // the check is there rather than here because the recording and the output
    // preview read this same object and each has its own answer about it.
    s.fpsMode = strProp(specP.get(), "fpsMode", "");
    s.videoOptions = optionsFromJs(specP.get(), "videoOptions");
    s.audioOptions = optionsFromJs(specP.get(), "audioOptions");
    s.formatOptions = optionsFromJs(specP.get(), "formatOptions");
    s.filterGraph = strProp(specP.get(), "filterGraph", "");
    s.filterInputs = graphInputsFromJs(specP.get());
    s.sizeFromGraph = boolProp(specP.get(), "sizeFromGraph", false);
    // `-filter_hw_device`: which device `hwupload` and the `_cuda`/`_qsv`
    // filters get. A decision about the graph rather than about any input,
    // which is why it is here and not on one.
    s.filterHwDevice = strProp(specP.get(), "filterHwDevice", "");
    s.filterHwDeviceIndex = strProp(specP.get(), "filterHwDeviceIndex", "");
    s.passes = passesFromJs(specP.get());
    s.metadata = optionsFromJs(specP.get(), "metadata");

    // Read before anything is started, so a list that cannot be honoured is a
    // thrown TypeError with the offending entry named rather than a job that
    // fails a second later with the index long gone.
    return inputsFromJs(specP.get(), &s.inputs, err) &&
           streamsFromJs(specP.get(), &s.streams, err) &&
           chaptersFromJs(specP.get(), &s.chapters, err);
}

} // namespace ffmpegbro
