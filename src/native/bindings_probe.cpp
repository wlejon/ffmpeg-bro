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

#include <embed/embed.h>

#include <cstdint>
#include <string>

namespace ffmpegbro {

namespace {

bronze::Value streamToJs(const StreamSummary& s) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setNum(o.get(), "index", s.index);
    setStr(o.get(), "kind", s.kind);
    setStr(o.get(), "codec", s.codec);
    setStr(o.get(), "codecLong", s.codecLong);
    setStr(o.get(), "tag", s.tag);
    setStr(o.get(), "profile", s.profile);
    setNum(o.get(), "bitRate", static_cast<double>(s.bitRate));
    setNum(o.get(), "duration", s.duration);
    setBool(o.get(), "default", s.isDefault);
    setStr(o.get(), "language", s.language);
    setStr(o.get(), "title", s.title);

    if (s.kind == "video") {
        setNum(o.get(), "width", s.width);
        setNum(o.get(), "height", s.height);
        setNum(o.get(), "fps", s.fps);
        setStr(o.get(), "pixFmt", s.pixFmt);
        setStr(o.get(), "colorSpace", s.colorSpace);
        setStr(o.get(), "colorRange", s.colorRange);
        setStr(o.get(), "colorPrimaries", s.colorPrimaries);
        setStr(o.get(), "colorTransfer", s.colorTransfer);
        setNum(o.get(), "sampleAspect", s.sampleAspect);
        setNum(o.get(), "rotation", s.rotation);
        // What the frame measures once rotation is applied — the size a UI
        // should actually lay out for.
        const bool swapped = (s.rotation == 90 || s.rotation == 270);
        setNum(o.get(), "displayWidth", swapped ? s.height : s.width);
        setNum(o.get(), "displayHeight", swapped ? s.width : s.height);
    } else if (s.kind == "audio") {
        setNum(o.get(), "sampleRate", s.sampleRate);
        setNum(o.get(), "channels", s.channels);
        setStr(o.get(), "channelLayout", s.channelLayout);
        setStr(o.get(), "sampleFmt", s.sampleFmt);
    } else if (s.kind == "subtitle") {
        setBool(o.get(), "textSub", s.textSub);
    }
    return o.get();
}

/// A successful probe, as the UI reads one. One builder, two callers — the
/// synchronous call and the poll — because a URL and a path have to arrive
/// described identically or every reader of a probe would grow a second branch.
bronze::Value probeToJs(const ProbeResult& r) {
    namespace ev = bronze::embed;
    ev::Persistent out(ev::createObject());
    setStr(out.get(), "path", r.path);

    ev::Persistent fmt(ev::createObject());
    setStr(fmt.get(), "name", r.formatName);
    setStr(fmt.get(), "longName", r.formatLongName);
    setNum(fmt.get(), "duration", r.durationSec);
    setNum(fmt.get(), "bitRate", static_cast<double>(r.bitRate));
    setNum(fmt.get(), "size", static_cast<double>(r.sizeBytes));
    out.set(ev::setProperty(out.get(), "format", fmt.get()));

    ev::Persistent arr(createArray());
    uint32_t n = 0;
    int firstVideo = -1, firstAudio = -1;
    for (const auto& s : r.streams) {
        if (firstVideo < 0 && s.kind == "video") firstVideo = static_cast<int>(n);
        if (firstAudio < 0 && s.kind == "audio") firstAudio = static_cast<int>(n);
        ev::Persistent item(streamToJs(s));
        arr.set(ev::setElement(arr.get(), n++, item.get()));
    }
    out.set(ev::setProperty(out.get(), "streams", arr.get()));

    // Shortcuts to the streams a player actually plays, so callers don't
    // re-scan the array for the common case.
    out.set(ev::setProperty(out.get(), "video",
                            firstVideo >= 0 ? ev::getElement(arr.get(), firstVideo)
                                            : ev::null()));
    out.set(ev::setProperty(out.get(), "audio",
                            firstAudio >= 0 ? ev::getElement(arr.get(), firstAudio)
                                            : ev::null()));
    return out.get();
}

/// The `-i` these calls are about, out of whatever the caller passed.
///
/// One reader, because `probe()` and `probes.start()` take the same two shapes
/// and a second copy would be the place one of them stopped honouring a forced
/// demuxer. False leaves `*in` alone and an exception pending.
bool inputArg(std::span<const bronze::Value> args, MediaInput* in) {
    namespace ev = bronze::embed;
    if (args.empty()) return false;
    if (ev::isObject(args[0])) {
        *in = inputFromJs(args[0]);
        return true;
    }
    if (!ev::isString(args[0])) return false;
    MediaInput built;
    built.path = ev::toUtf8(args[0]);
    // The second argument is the rest of the `-i`, for a caller that has a
    // path in hand rather than an input record.
    if (args.size() >= 2 && ev::isObject(args[1])) {
        const std::string path0 = built.path;
        built = inputFromJs(args[1]);
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
bronze::Value js_probe(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty()) return ev::throwTypeError("probe(path) requires a path or an input");

    MediaInput in;
    if (!inputArg(args, &in)) return ev::throwTypeError("probe(path) requires a valid path or input");
    if (in.path.empty()) return ev::throwTypeError("probe() needs a path or a URL");

    const ProbeResult r = probeMedia(in);
    if (!r.ok) {
        return ev::throwTypeError("cannot open '" + r.path + "': " + r.error);
    }
    return probeToJs(r);
}

// bro.ffmpeg.probes.start(path | input, [{ timeout }]) — the same probe, on a
// thread of its own, answered by `poll`.
//
// The options object is the input's when a path was passed, exactly as
// `probe()`'s second argument is, plus `timeout` in seconds. `timeout` is not
// a demuxer option and never reaches libav: it is the deadline on the interrupt
// callback, which is one mechanism covering every protocol — see `OpenWatch`
// in ffmpeg_input.h for what libav's own timeout options do and do not cover.
bronze::Value js_probeStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty())
        return ev::throwTypeError("probes.start(path) requires a path or an input");

    MediaInput in;
    if (!inputArg(args, &in)) return ev::throwTypeError("probes.start() requires a valid path or input");
    if (in.path.empty())
        return ev::throwTypeError("probes.start() needs a path or a URL");

    double timeout = 0;
    for (size_t i = 0; i < args.size(); ++i)
        if (ev::isObject(args[i])) timeout = numProp(args[i], "timeout", timeout);

    return ev::fromDouble(static_cast<double>(startProbe(in, timeout)));
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
bronze::Value js_probePoll(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty()) return ev::throwTypeError("probes.poll(id) requires an id");
    if (!ev::isNumber(args[0])) return ev::throwTypeError("probes.poll(id) requires a numeric id");
    uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));

    ProbeProgress p;
    if (!probeProgress(id, &p)) return ev::null();

    ev::Persistent o(ev::createObject());
    setStr(o.get(), "state", probeStateName(p.state));
    setBool(o.get(), "opening", p.state == ProbeProgress::State::Opening);
    setNum(o.get(), "elapsed", p.elapsed);
    setNum(o.get(), "timeout", p.timeout);
    // **What a `Stop` beside this will actually do.** False for a device,
    // whose `read_header` never polls the interrupt callback — see `OpenWatch`
    // in ffmpeg_input.h for the measurement. Reported rather than worked out
    // by the caller, because a button that claimed to abort an open it cannot
    // reach would be a lie about what the machine is doing, and the fact
    // belongs to the open rather than to whoever is drawing it.
    setBool(o.get(), "stoppable", p.stoppable);
    // The failure is a string here rather than an exception, which is the one
    // place these two calls differ in more than timing: `probe()` throws
    // because a caller that ignored the failure would lay out a file it never
    // read, and a poll is read every frame by something that has to keep
    // drawing either way.
    setStr(o.get(), "error", p.result.error);
    if (p.state == ProbeProgress::State::Done) {
        ev::Persistent res(probeToJs(p.result));
        o.set(ev::setProperty(o.get(), "result", res.get()));
    } else {
        o.set(ev::setProperty(o.get(), "result", ev::null()));
    }
    return o.get();
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
    probes.function("cancel", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("probes.cancel(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopProbe(id);
        return ev::undefined();
    }, 1);
    /// Stop it and never poll again — an input removed while it was still
    /// opening. Separate from `cancel` because the two differ in whether
    /// anybody is going to be told: `cancel` keeps the answer for the press
    /// that asked for it, this one throws it away and reaps the thread.
    probes.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("probes.forget(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        abandonProbe(id);
        return ev::undefined();
    }, 1);
}

} // namespace ffmpegbro
