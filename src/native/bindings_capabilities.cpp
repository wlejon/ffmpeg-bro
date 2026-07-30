// What this build can do, asked of libav — the registries `bro.ffmpeg` reports
// and the option tables behind them.
//
// **Nothing in this file is a list.** Every answer here is a walk over one of
// libav's own registries or a read of an AVClass's option table, which is why a
// build that gains a muxer, a filter or a tune gains it in the application and
// nobody edits anything. "The four containers we support" is how MPEG-TS, MXF,
// AVI, FLV, GIF and image2 came to be compiled in and unreachable.
//
// The second decision is *when* to ask, and it is the reason half of this
// surface is a property and half of it is a call. A registry walk is cheap and
// its answer cannot change while the process runs, so the lists — encoders,
// muxers, demuxers, decoders, protocols, devices, filters, bitstream filters —
// are built once at startup. An option table is not cheap: there are five
// hundred filters and as many demuxers, building every table would be most of a
// second before the window opened, and a form only ever shows one. So each
// `…Options` is a function of a name, and so is everything that *measures*
// rather than enumerates — `hardware()` creates a device of every type,
// `deviceSources()` asks every camera driver on the machine.
//
// `keyframes`, `cueTimes` and `cueText` are the three calls here that are about
// a particular *file* rather than about the build. They live with the
// capabilities because they are the same kind of question asked the same way:
// something the UI has to know before a render rather than discover from one.
// `cueText` is the dearest of the three by a long way — it opens a decoder,
// where the other two read an index or a run of packets — which is why it is a
// call of its own rather than a field on `cueTimes`'s answer.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "export_copy.h"
#include "export_subtitle.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_hardware.h"
#include "ffmpeg_input.h"

extern "C" {
#include <libavutil/pixdesc.h>
}

#include <quickjs.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

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

/// The arguments the three file queries here share: an input (or a bare path)
/// and a window in it.
///
/// One reader because there are three of them now and the fourth line of it is
/// the one that matters — `stream` defaults to −1 and not to 0, which is "the
/// best stream of the kind I am about" rather than "the first stream of the
/// file". Written out three times, that is the default one of the three
/// eventually gets wrong. `*in` is left alone on failure, which only happens
/// when a path will not convert.
struct FileQuery {
    MediaInput in;
    int stream = -1;
    double from = 0, to = 0;
    int max = 0;
};

bool fileQuery(JSContext* ctx, int argc, JSValueConst* argv, FileQuery* q) {
    if (JS_IsObject(argv[0])) {
        q->in = inputFromJs(ctx, argv[0]);
    } else {
        const char* path = JS_ToCString(ctx, argv[0]);
        if (!path) return false;
        q->in.path = path;
        JS_FreeCString(ctx, path);
    }
    JSValueConst opts = argc >= 2 ? argv[1] : JS_UNDEFINED;
    if (JS_IsObject(opts)) {
        q->stream = static_cast<int>(numProp(ctx, opts, "stream", -1));
        q->from = numProp(ctx, opts, "from", 0);
        q->to = numProp(ctx, opts, "to", 0);
        q->max = static_cast<int>(numProp(ctx, opts, "max", 0));
    }
    return true;
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

    FileQuery q;
    if (!fileQuery(ctx, argc, argv, &q)) return JS_EXCEPTION;

    KeyframeList list;
    std::string err;
    if (!keyframesOf(q.in, q.stream, q.from, q.to, q.max, &list, &err))
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

/// bro.ffmpeg.cueTimes(path | input, { stream, from, to, max }) — when a
/// subtitle track's cues are on screen.
///
/// The same shape of query as `keyframes` above and for the same reason: a
/// window is typed into two fields on the Write stage, and what that window
/// does to the cues is a fact about the input which nothing should have to
/// render to find out.
///
/// **Times, not text**, which the name says so that nothing is disappointed by
/// it: this reads packets and never opens a decoder, so it answers for a
/// `dvdsub` track exactly as it answers for an `.srt` — and when a picture
/// track is on screen is the only thing about it anybody can say. What a cue
/// *says* is a different question with a different cost.
JSValue js_cueTimes(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "cueTimes(path) requires a path or an input");

    FileQuery q;
    if (!fileQuery(ctx, argc, argv, &q)) return JS_EXCEPTION;

    CueTimes list;
    std::string err;
    if (!cueTimesOf(q.in, q.stream, q.from, q.to, q.max, &list, &err))
        return JS_ThrowTypeError(ctx, "%s", err.c_str());

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "stream", JS_NewInt32(ctx, list.stream));
    JS_SetPropertyStr(ctx, out, "complete", JS_NewBool(ctx, list.complete));
    JS_SetPropertyStr(ctx, out, "from", JS_NewFloat64(ctx, list.from));
    JS_SetPropertyStr(ctx, out, "to", JS_NewFloat64(ctx, list.to));
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const Cue& c : list.cues) {
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "start", JS_NewFloat64(ctx, c.start));
        JS_SetPropertyStr(ctx, o, "end", JS_NewFloat64(ctx, c.end));
        JS_SetPropertyStr(ctx, o, "bytes", JS_NewInt32(ctx, c.bytes));
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    JS_SetPropertyStr(ctx, out, "cues", arr);
    return out;
}

/// bro.ffmpeg.cueText(path | input, { stream, from, to, max }) — what a
/// subtitle track's cues *say*.
///
/// The other half of `cueTimes` above, and a second call rather than two more
/// fields on that one because it is a second cost: this opens a decoder per
/// track, which is the only way the words come out of a payload. It closes it
/// again before answering — nothing in this binary holds a subtitle decoder —
/// so the cost is paid by whoever asks and by nobody else. `probe()`
/// deliberately does not ask.
///
/// **A bitmap track answers `text: false` and its codec's name, not an empty
/// list.** `dvdsub` and `hdmv_pgs_subtitle` carry pictures of characters and
/// there is nothing in them to read, which is a different answer from "this
/// track has no cues" and has to reach the panel as one — an absence with a
/// reason beats a blank column. No decoder is opened for such a track at all.
///
/// **Each cue comes back twice, and `header` beside them, because there are two
/// readers now.** The Write stage's cue list wants `text` — the words, with the
/// dialogue fields and the override codes taken out, which is all a column has
/// room for. `ui/cues.js` wants to be able to write the track out *again*, and
/// for that the lossy answer is the one that loses somebody's styling: so `raw`
/// is the dialogue line as it arrived and `header` is the decoder's
/// `subtitle_header`. Both are on the same answer rather than behind a flag,
/// because the cost of this call is the decoder and the walk — the strings are
/// already in hand by the time either question is asked.
JSValue js_cueText(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "cueText(path) requires a path or an input");

    FileQuery q;
    if (!fileQuery(ctx, argc, argv, &q)) return JS_EXCEPTION;

    CueText list;
    std::string err;
    if (!cueTextOf(q.in, q.stream, q.from, q.to, q.max, &list, &err))
        return JS_ThrowTypeError(ctx, "%s", err.c_str());

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "stream", JS_NewInt32(ctx, list.stream));
    setStr(ctx, out, "codec", list.codec);
    // Whether there are words in this track at all — libavcodec's
    // `AV_CODEC_PROP_TEXT_SUB`, under the name `probe()` reports it per stream
    // by, so the two cannot come to be read as different questions.
    JS_SetPropertyStr(ctx, out, "textSub", JS_NewBool(ctx, list.text));
    JS_SetPropertyStr(ctx, out, "complete", JS_NewBool(ctx, list.complete));
    JS_SetPropertyStr(ctx, out, "from", JS_NewFloat64(ctx, list.from));
    JS_SetPropertyStr(ctx, out, "to", JS_NewFloat64(ctx, list.to));
    // Everything the cues are written *against* — the styles, the resolution
    // the positions are in, and the `Format:` line their fields are ordered by.
    setStr(ctx, out, "header", list.header);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (const CueLine& c : list.cues) {
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "start", JS_NewFloat64(ctx, c.start));
        JS_SetPropertyStr(ctx, o, "end", JS_NewFloat64(ctx, c.end));
        setStr(ctx, o, "text", c.text);
        setStr(ctx, o, "raw", c.raw);
        JS_SetPropertyUint32(ctx, arr, i++, o);
    }
    JS_SetPropertyStr(ctx, out, "cues", arr);
    return out;
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

/// `name(string)` → that thing's option table. Seven calls are this function
/// with a different noun in front of them — an encoder's, a filter's, a muxer's,
/// a demuxer's, a decoder's, a bitstream filter's, a protocol's — because
/// libavutil describes all seven with an AVClass and `optionsToJs` reads all
/// seven the same way. `wants` is the tail of the message, so a caller that
/// passed nothing is still told what kind of name was missing.
void optionTable(Table& ns, const char* name, const char* wants,
                 std::vector<OptionInfo> (*lookup)(const std::string&)) {
    ns.function(name, [name, wants, lookup](JSContext* ctx, JSValue nameArg) {
        std::string n;
        if (!takeName(ctx, nameArg, &n))
            return JS_ThrowTypeError(ctx, "%s(name) requires %s", name, wants);
        return optionsToJs(ctx, lookup(n));
    });
}

} // namespace

void installCapabilities(Table& ns) {
    JSContext* ctx = ns.context();

    ns.value("version", libavVersion());
    ns.value("configuration", libavConfiguration());

    ns.value("hwaccels", stringsToJs(ctx, availableHwAccels()));

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
    ns.function("hardware", [](JSContext* ctx) {
        JSValue arr = JS_NewArray(ctx);
        uint32_t n = 0;
        for (const auto& d : hwDevices()) {
            JSValue o = JS_NewObject(ctx);
            setStr(ctx, o, "name", d.name);
            JS_SetPropertyStr(ctx, o, "present", JS_NewBool(ctx, d.present));
            if (!d.error.empty()) setStr(ctx, o, "error", d.error);
            // How many of them there are, by the string `-hwaccel_device`
            // takes. `present` says a card answered; this says whether there
            // is a second one, which is the difference between "which one" as
            // a picker and "which one" as a number typed into a box nothing
            // could check. Empty for a type whose devices are not indices.
            JS_SetPropertyStr(ctx, o, "devices", stringsToJs(ctx, d.devices));
            const char* fmt = d.pixelFormat != AV_PIX_FMT_NONE
                                  ? av_get_pix_fmt_name(d.pixelFormat) : nullptr;
            setStr(ctx, o, "pixelFormat", fmt ? fmt : "");
            JS_SetPropertyStr(ctx, o, "decoders", stringsToJs(ctx, d.decoders));
            JS_SetPropertyStr(ctx, o, "encoders", stringsToJs(ctx, d.encoders));
            JS_SetPropertyStr(ctx, o, "filters", stringsToJs(ctx, d.filters));
            JS_SetPropertyUint32(ctx, arr, n++, o);
        }
        return arr;
    });

    // What this build can write, asked of libavcodec rather than assumed: a
    // menu offering H.265 on a build without x265 is a menu that fails at the
    // last step.
    ns.value("encoders", codecListToJs(ctx, availableVideoEncoders()));
    ns.value("audioEncoders", codecListToJs(ctx, availableAudioEncoders()));
    // The third list, and the first one that is not a judgement about which
    // entries are worth offering: there are nine subtitle encoders and each is
    // an interchange format asked for by name, so this is the registry walk
    // rather than a candidate list checked against the build.
    ns.value("subtitleEncoders", codecListToJs(ctx, availableSubtitleEncoders()));

    // Every muxer this build links, by the name `-f` takes. This was four
    // extensions in a table — mp4, mkv, mov, webm — and everything else the
    // build could write was compiled in and unreachable because of it. Built at
    // startup because the entries are small: a hundred and eighty names, long
    // names, extensions and flags. Their *option tables* are the expensive part
    // and are asked for one muxer at a time, exactly as a filter's are.
    ns.value("muxers", muxersToJs(ctx));
    ns.value("demuxers", demuxersToJs(ctx));
    ns.value("decoders", decodersToJs(ctx));
    ns.value("protocols", protocolsToJs(ctx));
    ns.value("devices", devicesToJs(ctx));

    /// bro.ffmpeg.encoderOptions(name) — every private option of one encoder.
    /// Looked up on demand rather than built for all of them at startup: x265
    /// alone has some eighty, and the dialog only ever shows one encoder's.
    optionTable(ns, "encoderOptions", "an encoder name", encoderOptions);
    /// bro.ffmpeg.muxerOptions(name) / demuxerOptions(name) / decoderOptions(name)
    /// / protocolOptions(name) — the same walk `encoderOptions` does, over the
    /// other four kinds of thing in libav that carry an AVClass.
    ///
    /// All on demand. There are a hundred and eighty muxers, three hundred and
    /// fifty demuxers and as many decoders, and their option tables are the
    /// expensive part of describing any of them — which is precisely why
    /// `filterOptions` is asked one filter at a time.
    optionTable(ns, "muxerOptions", "a muxer name", muxerOptions);
    optionTable(ns, "demuxerOptions", "a demuxer name", demuxerOptions);
    optionTable(ns, "decoderOptions", "a decoder name", decoderOptions);
    optionTable(ns, "protocolOptions", "a protocol name", protocolOptions);
    ns.value("bitstreamFilters", bsfsToJs(ctx));
    optionTable(ns, "bsfOptions", "a bitstream filter name", bsfOptions);

    /// bro.ffmpeg.deviceSources(name) — what one capture device can see now.
    ///
    /// The one query in this file that talks to hardware, which is why it is a
    /// function rather than a list built at startup: enumerating DirectShow asks
    /// every camera driver on the machine. A device with nothing to enumerate
    /// answers with `ok: false` and a reason, because an empty list reads as a
    /// machine with no cameras in it.
    ns.function("deviceSources", [](JSContext* ctx, JSValue nameArg) {
        std::string name;
        if (!takeName(ctx, nameArg, &name))
            return JS_ThrowTypeError(ctx, "deviceSources(name) requires a device name");
        const DeviceSourceList list = deviceSources(name);

        JSValue out = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, out, "ok", JS_NewBool(ctx, list.ok));
        setStr(ctx, out, "error", list.error);
        JSValue arr = JS_NewArray(ctx);
        uint32_t n = 0;
        for (const auto& s : list.sources) {
            JSValue o = JS_NewObject(ctx);
            setStr(ctx, o, "name", s.name);
            setStr(ctx, o, "description", s.description);
            JS_SetPropertyStr(ctx, o, "mediaTypes", stringsToJs(ctx, s.mediaTypes));
            JS_SetPropertyUint32(ctx, arr, n++, o);
        }
        JS_SetPropertyStr(ctx, out, "sources", arr);
        return out;
    });

    // Where a copy can start. A query about an input rather than a capability
    // of the build, and the one thing that makes a lossless cut a decision
    // somebody takes rather than one they discover.
    ns.function("keyframes", js_keyframes, 2);
    ns.function("cueTimes", js_cueTimes, 2);
    ns.function("cueText", js_cueText, 2);
    /// bro.ffmpeg.codecTags(container, codec) — the fourccs this muxer will take
    /// for this codec, first being what it writes by itself. The `-tag:v hvc1`
    /// control is drawn from this rather than being a four-character text box: a
    /// tag nobody has seen before is a tag nobody types.
    ns.function("codecTags", [](JSContext* ctx, JSValue containerArg, JSValue codecArg) {
        if (!JS_IsString(containerArg) || !JS_IsString(codecArg))
            return JS_ThrowTypeError(ctx, "codecTags(container, codec) requires both names");
        // Named `container` and not `ext`: this is the muxer's own name, the thing
        // `-f` takes. Calling it an extension is how a caller comes to pass "mkv"
        // to a function that only knows "matroska".
        const char* container = JS_ToCString(ctx, containerArg);
        const char* codec = JS_ToCString(ctx, codecArg);
        JSValue out = JS_NULL;
        if (container && codec) out = stringsToJs(ctx, codecTags(container, codec));
        if (container) JS_FreeCString(ctx, container);
        if (codec) JS_FreeCString(ctx, codec);
        return JS_IsNull(out) ? JS_NewArray(ctx) : out;
    });
    ns.function("guessCodec", js_guessCodec, 3);
    // Small enough to build once: thirty-odd names, and every stream row on
    // the Write stage draws a toggle per entry.
    ns.value("dispositions", stringsToJs(ctx, streamDispositions()));

    // What this build can put a picture *through*, which is the palette the
    // graph stage picks from. A list of names and pad shapes is small; the
    // options behind each are asked for one filter at a time.
    ns.value("filters", filtersToJs(ctx));
    /// bro.ffmpeg.filterOptions(name) — one filter's arguments, for the same
    /// reason and drawn the same way. On demand for a stronger reason than the
    /// encoders': there are some five hundred filters, and building every option
    /// table at startup would be most of a second before the window opened.
    optionTable(ns, "filterOptions", "a filter name", filterOptions);
}

} // namespace ffmpegbro
