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

#include <embed/embed.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

bronze::Value codecListToJs(const std::vector<CodecOption>& list) {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& c : list) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "id", c.id);
        setStr(o.get(), "label", c.label);
        setStr(o.get(), "longName", c.longName);
        // The codec, as against the encoder: `libx264` writes `h264`. Anything
        // that talks about codecs rather than encoders — a bitstream filter's
        // list of what it runs on — needs this and cannot derive it.
        setStr(o.get(), "codecName", c.codecName);
        setBool(o.get(), "crf", c.supportsCrf);
        setBool(o.get(), "preset", c.supportsPreset);
        setBool(o.get(), "qp", c.supportsQp);
        setBool(o.get(), "tune", c.supportsTune);
        setBool(o.get(), "hardware", c.hardware);
        setBool(o.get(), "intraOnly", c.intraOnly);
        // Subtitles: text rather than pictures. The one fact that decides
        // whether a conversion is possible at all, so it travels with the
        // codec rather than being worked out from its name.
        setBool(o.get(), "textSub", c.textSub);
        setBool(o.get(), "lossless", c.lossless);
        setBool(o.get(), "alwaysLossless", c.alwaysLossless);
        setBool(o.get(), "losslessOption", c.losslessOption);
        setNum(o.get(), "crfMin", c.crfMin);
        setNum(o.get(), "crfMax", c.crfMax);
        setNum(o.get(), "crfDefault", c.crfDefault);
        ev::Persistent pf(stringsToJs(c.pixelFormats));
        o.set(ev::setProperty(o.get(), "pixelFormats", pf.get()));
        ev::Persistent pr(stringsToJs(c.presets));
        o.set(ev::setProperty(o.get(), "presets", pr.get()));
        ev::Persistent tu(stringsToJs(c.tunes));
        o.set(ev::setProperty(o.get(), "tunes", tu.get()));
        ev::Persistent prof(stringsToJs(c.profiles));
        o.set(ev::setProperty(o.get(), "profiles", prof.get()));
        ev::Persistent profl(stringsToJs(c.profileLabels));
        o.set(ev::setProperty(o.get(), "profileLabels", profl.get()));
        ev::Persistent sr(intsToJs(c.sampleRates));
        o.set(ev::setProperty(o.get(), "sampleRates", sr.get()));
        ev::Persistent cc(intsToJs(c.channelCounts));
        o.set(ev::setProperty(o.get(), "channelCounts", cc.get()));
        ev::Persistent co(stringsToJs(c.containers));
        o.set(ev::setProperty(o.get(), "containers", co.get()));
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

bronze::Value optionsToJs(const std::vector<OptionInfo>& opts) {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& o : opts) {
        ev::Persistent e(ev::createObject());
        setStr(e.get(), "name", o.name);
        setStr(e.get(), "help", o.help);
        setStr(e.get(), "type", o.type);
        setStr(e.get(), "unit", o.unit);
        setStr(e.get(), "default", o.defaultValue);
        setNum(e.get(), "min", o.min);
        setNum(e.get(), "max", o.max);
        setBool(e.get(), "hasRange", o.hasRange);

        ev::Persistent vals(createArray());
        uint32_t vi = 0;
        for (const auto& v : o.values) {
            ev::Persistent vo(ev::createObject());
            setStr(vo.get(), "name", v.name);
            setStr(vo.get(), "help", v.help);
            setNum(vo.get(), "value", static_cast<double>(v.value));
            vals.set(ev::setElement(vals.get(), vi++, vo.get()));
        }
        e.set(ev::setProperty(e.get(), "values", vals.get()));
        arr.set(ev::setElement(arr.get(), i++, e.get()));
    }
    return arr.get();
}

/// How long a packet walk may take before it gives back what it has.
///
/// **Every one of these calls is synchronous on the JS thread, and two of them
/// are made while the Write stage is drawing.** `max` bounds the answer and
/// bounds nothing a person can feel: a six-hour Twitch VOD asked for its 4000
/// keyframes is two and a quarter hours of video fetched over HTTPS, measured at
/// **158 seconds** with the window not responding for all of them. So the walk
/// carries a deadline and the answer says it was cut short — the `complete`
/// field these three already have, meaning exactly what it always meant.
///
/// Half a second because that is roughly the longest a single redraw may take
/// and still be a redraw rather than a hang, and because a local file with no
/// index reaches the end of itself well inside it. A caller who genuinely wants
/// the whole file passes `ms: 0`, which is what the native callers and the tests
/// do — they are not on this thread.
constexpr int DEFAULT_WALK_MS = 500;

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
    int ms = DEFAULT_WALK_MS;
};

bool fileQuery(std::span<const bronze::Value> args, FileQuery* q) {
    namespace ev = bronze::embed;
    if (args.empty()) return false;
    if (ev::isObject(args[0])) {
        q->in = inputFromJs(args[0]);
    } else if (ev::isString(args[0])) {
        q->in.path = ev::toUtf8(args[0]);
    } else {
        return false;
    }
    if (args.size() >= 2 && ev::isObject(args[1])) {
        q->stream = static_cast<int>(numProp(args[1], "stream", -1));
        q->from = numProp(args[1], "from", 0);
        q->to = numProp(args[1], "to", 0);
        q->max = static_cast<int>(numProp(args[1], "max", 0));
        q->ms = static_cast<int>(numProp(args[1], "ms", DEFAULT_WALK_MS));
    }
    return true;
}

/// bro.ffmpeg.keyframes(path | input, { stream, from, to, max, ms }) — where a
/// copy can start.
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
/// of — which is now also what a scan says when it ran out of the `ms` it was
/// given, and `DEFAULT_WALK_MS` is why it has one.
bronze::Value js_keyframes(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty())
        return ev::throwTypeError("keyframes(path) requires a path or an input");

    FileQuery q;
    if (!fileQuery(args, &q)) return ev::throwTypeError("keyframes(path) invalid arguments");

    KeyframeList list;
    std::string err;
    if (!keyframesOf(q.in, q.stream, q.from, q.to, q.max, q.ms, &list, &err))
        return ev::throwTypeError(err);

    ev::Persistent out(ev::createObject());
    setNum(out.get(), "stream", list.stream);
    setStr(out.get(), "how", list.how);
    setBool(out.get(), "complete", list.complete);
    setNum(out.get(), "from", list.from);
    setNum(out.get(), "to", list.to);
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (double t : list.times) arr.set(ev::setElement(arr.get(), i++, ev::fromDouble(t)));
    out.set(ev::setProperty(out.get(), "times", arr.get()));
    return out.get();
}

/// bro.ffmpeg.cueTimes(path | input, { stream, from, to, max, ms }) — when a
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
bronze::Value js_cueTimes(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty())
        return ev::throwTypeError("cueTimes(path) requires a path or an input");

    FileQuery q;
    if (!fileQuery(args, &q)) return ev::throwTypeError("cueTimes(path) invalid arguments");

    CueTimes list;
    std::string err;
    if (!cueTimesOf(q.in, q.stream, q.from, q.to, q.max, q.ms, &list, &err))
        return ev::throwTypeError(err);

    ev::Persistent out(ev::createObject());
    setNum(out.get(), "stream", list.stream);
    setBool(out.get(), "complete", list.complete);
    setNum(out.get(), "from", list.from);
    setNum(out.get(), "to", list.to);
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const Cue& c : list.cues) {
        ev::Persistent o(ev::createObject());
        setNum(o.get(), "start", c.start);
        setNum(o.get(), "end", c.end);
        setNum(o.get(), "bytes", c.bytes);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    out.set(ev::setProperty(out.get(), "cues", arr.get()));
    return out.get();
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
/// room for. The cue reader wants to be able to write the track out *again*, and
/// for that the lossy answer is the one that loses somebody's styling: so `raw`
/// is the dialogue line as it arrived and `header` is the decoder's
/// `subtitle_header`. Both are on the same answer rather than behind a flag,
/// because the cost of this call is the decoder and the walk — the strings are
/// already in hand by the time either question is asked.
bronze::Value js_cueText(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty())
        return ev::throwTypeError("cueText(path) requires a path or an input");

    FileQuery q;
    if (!fileQuery(args, &q)) return ev::throwTypeError("cueText(path) invalid arguments");

    CueText list;
    std::string err;
    if (!cueTextOf(q.in, q.stream, q.from, q.to, q.max, &list, &err))
        return ev::throwTypeError(err);

    ev::Persistent out(ev::createObject());
    setNum(out.get(), "stream", list.stream);
    setStr(out.get(), "codec", list.codec);
    // Whether there are words in this track at all — libavcodec's
    // `AV_CODEC_PROP_TEXT_SUB`, under the name `probe()` reports it per stream
    // by, so the two cannot come to be read as different questions.
    setBool(out.get(), "textSub", list.text);
    setBool(out.get(), "complete", list.complete);
    setNum(out.get(), "from", list.from);
    setNum(out.get(), "to", list.to);
    // Everything the cues are written *against* — the styles, the resolution
    // the positions are in, and the `Format:` line their fields are ordered by.
    setStr(out.get(), "header", list.header);
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const CueLine& c : list.cues) {
        ev::Persistent o(ev::createObject());
        setNum(o.get(), "start", c.start);
        setNum(o.get(), "end", c.end);
        setStr(o.get(), "text", c.text);
        setStr(o.get(), "raw", c.raw);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    out.set(ev::setProperty(out.get(), "cues", arr.get()));
    return out.get();
}

// The encoder libavformat itself would reach for. `image2`'s extension names a
// codec rather than a container, so this is what decides whether `out%04d.png`
// is PNG or the mjpeg its muxer declares as a default.
bronze::Value js_guessCodec(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.size() < 2 || !ev::isString(args[0]) || !ev::isString(args[1]))
        return ev::throwTypeError("guessCodec(muxer, path) requires both");
    std::string muxer = ev::toUtf8(args[0]);
    std::string path = ev::toUtf8(args[1]);
    const bool audio = args.size() >= 3 && ev::toBool(args[2]);
    std::string name;
    if (!muxer.empty() && !path.empty()) name = guessEncoder(muxer, path, audio);
    return ev::fromUtf8(name);
}

/// The four registries, in the shape a picker wants. One function each rather
/// than one generic one: they answer different questions, and the fields are
/// what makes each list navigable — a muxer's are what a picker groups by, a
/// device's are which half of libavdevice it came from.
bronze::Value muxersToJs() {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& m : availableMuxers()) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "name", m.name);
        setStr(o.get(), "label", m.label);
        setStr(o.get(), "longName", m.longName);
        setStr(o.get(), "ext", m.ext);
        ev::Persistent exts(stringsToJs(m.extensions));
        o.set(ev::setProperty(o.get(), "extensions", exts.get()));
        setStr(o.get(), "mimeType", m.mimeType);
        setStr(o.get(), "videoCodec", m.videoCodec);
        setStr(o.get(), "audioCodec", m.audioCodec);
        setStr(o.get(), "subtitleCodec", m.subtitleCodec);
        setStr(o.get(), "defaultVideo", m.defaultVideo);
        setStr(o.get(), "defaultAudio", m.defaultAudio);
        setStr(o.get(), "defaultSubtitle", m.defaultSubtitle);
        setBool(o.get(), "noFile", m.noFile);
        setBool(o.get(), "globalHeader", m.globalHeader);
        setBool(o.get(), "noTimestamps", m.noTimestamps);
        setBool(o.get(), "stills", m.stills);
        setBool(o.get(), "device", m.device);
        ev::Persistent vc(stringsToJs(m.videoCodecs));
        o.set(ev::setProperty(o.get(), "videoCodecs", vc.get()));
        ev::Persistent ac(stringsToJs(m.audioCodecs));
        o.set(ev::setProperty(o.get(), "audioCodecs", ac.get()));
        ev::Persistent sc(stringsToJs(m.subtitleCodecs));
        o.set(ev::setProperty(o.get(), "subtitleCodecs", sc.get()));
        setBool(o.get(), "answersCodecs", m.answersCodecs);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

bronze::Value demuxersToJs() {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& d : availableDemuxers()) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "name", d.name);
        setStr(o.get(), "longName", d.longName);
        ev::Persistent exts(stringsToJs(d.extensions));
        o.set(ev::setProperty(o.get(), "extensions", exts.get()));
        setStr(o.get(), "mimeType", d.mimeType);
        setBool(o.get(), "noFile", d.noFile);
        setBool(o.get(), "device", d.device);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

bronze::Value decodersToJs() {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& d : availableDecoders()) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "name", d.name);
        setStr(o.get(), "longName", d.longName);
        setStr(o.get(), "type", d.type);
        setBool(o.get(), "hardware", d.hardware);
        setBool(o.get(), "experimental", d.experimental);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

/// bro.ffmpeg.bitstreamFilters — the stage between the encoder and the muxer.
///
/// Small enough to build once: thirty-odd names and the codecs each will run
/// on. The option tables behind them are asked for one at a time, exactly as a
/// filter's are, because a chain editor only ever shows one.
bronze::Value bsfsToJs() {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& b : availableBitstreamFilters()) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "name", b.name);
        // Empty is "any codec" and is a real answer — `setts` and `noise`
        // declare no list at all — so a caller narrowing a menu has to read it
        // as "all of them" rather than as "none".
        ev::Persistent codecs(stringsToJs(b.codecs));
        o.set(ev::setProperty(o.get(), "codecs", codecs.get()));
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

bronze::Value protocolsToJs() {
    namespace ev = bronze::embed;
    const ProtocolList p = availableProtocols();
    ev::Persistent o(ev::createObject());
    ev::Persistent inp(stringsToJs(p.input));
    o.set(ev::setProperty(o.get(), "input", inp.get()));
    ev::Persistent outp(stringsToJs(p.output));
    o.set(ev::setProperty(o.get(), "output", outp.get()));
    return o.get();
}

bronze::Value devicesToJs() {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& d : availableDevices()) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "name", d.name);
        setStr(o.get(), "longName", d.longName);
        setStr(o.get(), "kind", d.kind);
        setStr(o.get(), "direction", d.direction);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

bronze::Value filtersToJs() {
    namespace ev = bronze::embed;
    ev::Persistent arr(createArray());
    uint32_t i = 0;
    for (const auto& f : availableFilters()) {
        ev::Persistent o(ev::createObject());
        setStr(o.get(), "name", f.name);
        setStr(o.get(), "description", f.description);
        setStr(o.get(), "inputs", f.inputs);
        setStr(o.get(), "outputs", f.outputs);
        setBool(o.get(), "dynamicInputs", f.dynamicInputs);
        setBool(o.get(), "dynamicOutputs", f.dynamicOutputs);
        setBool(o.get(), "timeline", f.timeline);
        arr.set(ev::setElement(arr.get(), i++, o.get()));
    }
    return arr.get();
}

/// `name(string)` → that thing's option table. Seven calls are this function
/// with a different noun in front of them — an encoder's, a filter's, a muxer's,
/// a demuxer's, a decoder's, a bitstream filter's, a protocol's — because
/// libavutil describes all seven with an AVClass and `optionsToJs` reads all
/// seven the same way. `wants` is the tail of the message, so a caller that
/// passed nothing is still told what kind of name was missing.
void optionTable(Table& ns, const char* name, const char* wants,
                 std::vector<OptionInfo> (*lookup)(const std::string&)) {
    ns.function(name, [name, wants, lookup](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        std::string n;
        if (args.empty() || !takeName(args[0], &n))
            return ev::throwTypeError(std::string(name) + "(name) requires " + wants);
        return optionsToJs(lookup(n));
    }, 1);
}

} // namespace

void installCapabilities(Table& ns) {
    namespace ev = bronze::embed;

    ns.value("version", libavVersion());
    ns.value("configuration", libavConfiguration());

    ns.value("hwaccels", stringsToJs(availableHwAccels()));

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
    ns.function("hardware", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        namespace ev = bronze::embed;
        ev::Persistent arr(createArray());
        uint32_t n = 0;
        for (const auto& d : hwDevices()) {
            ev::Persistent o(ev::createObject());
            setStr(o.get(), "name", d.name);
            setBool(o.get(), "present", d.present);
            if (!d.error.empty()) setStr(o.get(), "error", d.error);
            // How many of them there are, by the string `-hwaccel_device`
            // takes. `present` says a card answered; this says whether there
            // is a second one, which is the difference between "which one" as
            // a picker and "which one" as a number typed into a box nothing
            // could check. Empty for a type whose devices are not indices.
            ev::Persistent devs(stringsToJs(d.devices));
            o.set(ev::setProperty(o.get(), "devices", devs.get()));
            const char* fmt = d.pixelFormat != AV_PIX_FMT_NONE
                                  ? av_get_pix_fmt_name(d.pixelFormat) : nullptr;
            setStr(o.get(), "pixelFormat", fmt ? fmt : "");
            ev::Persistent decs(stringsToJs(d.decoders));
            o.set(ev::setProperty(o.get(), "decoders", decs.get()));
            ev::Persistent encs(stringsToJs(d.encoders));
            o.set(ev::setProperty(o.get(), "encoders", encs.get()));
            ev::Persistent fils(stringsToJs(d.filters));
            o.set(ev::setProperty(o.get(), "filters", fils.get()));
            arr.set(ev::setElement(arr.get(), n++, o.get()));
        }
        return arr.get();
    });

    // What this build can write, asked of libavcodec rather than assumed: a
    // menu offering H.265 on a build without x265 is a menu that fails at the
    // last step.
    ns.value("encoders", codecListToJs(availableVideoEncoders()));
    ns.value("audioEncoders", codecListToJs(availableAudioEncoders()));
    // The third list, and the first one that is not a judgement about which
    // entries are worth offering: there are nine subtitle encoders and each is
    // an interchange format asked for by name, so this is the registry walk
    // rather than a candidate list checked against the build.
    ns.value("subtitleEncoders", codecListToJs(availableSubtitleEncoders()));

    // Every muxer this build links, by the name `-f` takes. This was four
    // extensions in a table — mp4, mkv, mov, webm — and everything else the
    // build could write was compiled in and unreachable because of it. Built at
    // startup because the entries are small: a hundred and eighty names, long
    // names, extensions and flags. Their *option tables* are the expensive part
    // and are asked for one muxer at a time, exactly as a filter's are.
    ns.value("muxers", muxersToJs());
    ns.value("demuxers", demuxersToJs());
    ns.value("decoders", decodersToJs());
    ns.value("protocols", protocolsToJs());
    ns.value("devices", devicesToJs());

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
    ns.value("bitstreamFilters", bsfsToJs());
    optionTable(ns, "bsfOptions", "a bitstream filter name", bsfOptions);

    /// bro.ffmpeg.deviceSources(name) — what one capture device can see now.
    ///
    /// The one query in this file that talks to hardware, which is why it is a
    /// function rather than a list built at startup: enumerating DirectShow asks
    /// every camera driver on the machine. A device with nothing to enumerate
    /// answers with `ok: false` and a reason, because an empty list reads as a
    /// machine with no cameras in it.
    ns.function("deviceSources", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        std::string name;
        if (args.empty() || !takeName(args[0], &name))
            return ev::throwTypeError("deviceSources(name) requires a device name");
        const DeviceSourceList list = deviceSources(name);

        ev::Persistent out(ev::createObject());
        setBool(out.get(), "ok", list.ok);
        setStr(out.get(), "error", list.error);
        ev::Persistent arr(createArray());
        uint32_t n = 0;
        for (const auto& s : list.sources) {
            ev::Persistent o(ev::createObject());
            setStr(o.get(), "name", s.name);
            setStr(o.get(), "description", s.description);
            ev::Persistent mt(stringsToJs(s.mediaTypes));
            o.set(ev::setProperty(o.get(), "mediaTypes", mt.get()));
            arr.set(ev::setElement(arr.get(), n++, o.get()));
        }
        out.set(ev::setProperty(out.get(), "sources", arr.get()));
        return out.get();
    }, 1);

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
    ns.function("codecTags", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.size() < 2 || !ev::isString(args[0]) || !ev::isString(args[1]))
            return ev::throwTypeError("codecTags(container, codec) requires both names");
        // Named `container` and not `ext`: this is the muxer's own name, the thing
        // `-f` takes. Calling it an extension is how a caller comes to pass "mkv"
        // to a function that only knows "matroska".
        std::string container = ev::toUtf8(args[0]);
        std::string codec = ev::toUtf8(args[1]);
        return stringsToJs(codecTags(container, codec));
    }, 2);
    ns.function("guessCodec", js_guessCodec, 3);
    // Small enough to build once: thirty-odd names, and every stream row on
    // the Write stage draws a toggle per entry.
    ns.value("dispositions", stringsToJs(streamDispositions()));

    // What this build can put a picture *through*, which is the palette the
    // graph stage picks from. A list of names and pad shapes is small; the
    // options behind each are asked for one filter at a time.
    ns.value("filters", filtersToJs());
    /// bro.ffmpeg.filterOptions(name) — one filter's arguments, for the same
    /// reason and drawn the same way. On demand for a stronger reason than the
    /// encoders': there are some five hundred filters, and building every option
    /// table at startup would be most of a second before the window opened.
    optionTable(ns, "filterOptions", "a filter name", filterOptions);
}

} // namespace ffmpegbro
