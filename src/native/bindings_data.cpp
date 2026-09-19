// `bro.ffmpeg.data` — what a data stream carries, for the streams something
// here knows how to read.
//
// The fifth question this surface answers about a particular file, beside
// `probe`, and it is deliberately not part of it: a probe opens a container and
// reads its headers, which is a few hundred microseconds and describes every
// stream; this reads a whole track end to end, which is 32 ms for a 4 GB file
// and describes one. Folding it into `probe()` would make opening any file with
// telemetry in it cost the telemetry.
//
// **`parsers()` is the affordance's whole basis.** The UI has to know where a
// `Read` button can go before it offers one, and the answer is a list of
// fourccs asked of the registry (ffmpeg_data.cpp) rather than written down in
// JS — the same rule as every other list on this surface, and for the same
// reason: a second parser registered natively must not need an edit in `ui/`.
//
// **The read is `start`/`poll`/`cancel`/`forget`, shaped exactly like
// `probes.*`,** because it is the same problem: work that may take long enough
// to be seen, on a thread, polled from the frame loop the caller is already in.
// The two share `async_open.h`, so "a terminal answer is handed over exactly
// once" means the same thing in both. There is no synchronous twin, and that is
// the difference from `probe()`: a local container's headers are always quick
// and a whole track never reliably is.
//
// **The buckets come back as typed arrays.** A reading is three floats and a
// flag per bucket per series — forty series of two thousand buckets is 320 000
// numbers — and as plain JS arrays that is an object header each. `Float32Array`
// is what the lane indexes anyway, and it is the same shape `bro.media.peaks`
// hands the waveform.

#include "bindings_install.h"

#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"
#include "ffmpeg_data.h"
#include "ffmpeg_input.h"

#include <embed/embed.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

bronze::Value floatArray(const std::vector<float>& v) {
    namespace ev = bronze::embed;
    bronze::Value arr = ev::createTypedArray(ev::elements::Float32, static_cast<uint32_t>(v.size()));
    if (!v.empty()) {
        std::span<const uint8_t> bytes(reinterpret_cast<const uint8_t*>(v.data()),
                                       v.size() * sizeof(float));
        ev::fillTypedArray(arr, bytes);
    }
    return arr;
}

bronze::Value byteArray(const std::vector<uint8_t>& v) {
    namespace ev = bronze::embed;
    bronze::Value arr = ev::createTypedArray(ev::elements::Uint8, static_cast<uint32_t>(v.size()));
    if (!v.empty()) {
        ev::fillTypedArray(arr, std::span<const uint8_t>(v.data(), v.size()));
    }
    return arr;
}

bronze::Value seriesToJs(const DataSeries& s) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setStr(o.get(), "key", s.key);
    setStr(o.get(), "name", s.name);
    setStr(o.get(), "units", s.units);
    setNum(o.get(), "component", s.component);
    setNum(o.get(), "components", s.components);
    setNum(o.get(), "samples", static_cast<double>(s.samples));
    setNum(o.get(), "min", s.min);
    setNum(o.get(), "max", s.max);
    setNum(o.get(), "rate", s.rate);
    // Whether the format's own divisor was found. Reported rather than assumed,
    // because a value that should have been divided and was not is the failure
    // that still looks plausible — a UI that draws one has to be able to say so.
    setBool(o.get(), "scaled", s.scaled);
    ev::Persistent lo(floatArray(s.lo));
    o.set(ev::setProperty(o.get(), "lo", lo.get()));
    ev::Persistent hi(floatArray(s.hi));
    o.set(ev::setProperty(o.get(), "hi", hi.get()));
    ev::Persistent mean(floatArray(s.mean));
    o.set(ev::setProperty(o.get(), "mean", mean.get()));
    // 0 where no sample landed. A gap in a recording is a gap in the line, and
    // a zero drawn in its place is a measurement nobody made.
    ev::Persistent filled(byteArray(s.filled));
    o.set(ev::setProperty(o.get(), "filled", filled.get()));
    return o.get();
}

bronze::Value readingToJs(const DataReading& r) {
    namespace ev = bronze::embed;
    ev::Persistent o(ev::createObject());
    setStr(o.get(), "tag", r.tag);
    setStr(o.get(), "device", r.device);
    setNum(o.get(), "streamIndex", r.streamIndex);
    setNum(o.get(), "t0", r.t0);
    setNum(o.get(), "t1", r.t1);
    setNum(o.get(), "buckets", r.buckets);
    setNum(o.get(), "packets", static_cast<double>(r.packets));
    // How many packets the parser would not finish, and the first reason. A
    // damaged track is drawn with what survived and *says* that it is a damaged
    // track — the alternative, an empty plot, cannot be told from a file with
    // nothing in it.
    setNum(o.get(), "refused", static_cast<double>(r.refused));
    setStr(o.get(), "refusal", r.refusal);

    ev::Persistent arr(createArray());
    uint32_t n = 0;
    for (const DataSeries& s : r.series) {
        ev::Persistent ser(seriesToJs(s));
        arr.set(ev::setElement(arr.get(), n++, ser.get()));
    }
    o.set(ev::setProperty(o.get(), "series", arr.get()));
    return o.get();
}

/// The `-i` and the stream, out of whatever the caller passed. The same reader
/// `probes.start` uses, for the same reason: a track read from a file opened
/// with different demuxer options is a different track.
bool readArgs(std::span<const bronze::Value> args, MediaInput* in,
              int* streamIndex, int* buckets, double* timeout, std::string* err) {
    namespace ev = bronze::embed;
    if (args.size() < 2) {
        *err = "data.reads.start(input, streamIndex) needs both";
        return false;
    }
    if (ev::isObject(args[0])) {
        *in = inputFromJs(args[0]);
    } else if (ev::isString(args[0])) {
        in->path = ev::toUtf8(args[0]);
    } else {
        *err = "data.reads.start() needs a path or an input";
        return false;
    }
    if (in->path.empty()) {
        *err = "data.reads.start() needs a path or an input";
        return false;
    }
    if (!ev::isNumber(args[1])) {
        *err = "data.reads.start() needs a numeric streamIndex";
        return false;
    }
    *streamIndex = static_cast<int>(ev::toDouble(args[1]));

    if (args.size() >= 3 && ev::isObject(args[2])) {
        *buckets = static_cast<int>(numProp(args[2], "buckets", 0));
        *timeout = numProp(args[2], "timeout", 0);
    }
    return true;
}

// bro.ffmpeg.data.reads.start(path | input, streamIndex, { buckets, timeout })
//
// `buckets` is the resolution of the answer and the whole of what bounds its
// size: the reading is the same shape for twenty seconds of telemetry and two
// hours of it. Zero means the default; more than the cap is refused rather than
// clamped, because a caller asking for a million has a bug.
//
// `timeout` is not a demuxer option and never reaches libav — it is the
// deadline on the interrupt callback, the one mechanism that covers every
// protocol. See `OpenWatch` in ffmpeg_input.h.
bronze::Value js_dataStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    MediaInput in;
    int streamIndex = 0, buckets = 0;
    double timeout = 0;
    std::string err;
    if (!readArgs(args, &in, &streamIndex, &buckets, &timeout, &err))
        return ev::throwTypeError(err);
    return ev::fromDouble(static_cast<double>(startDataRead(in, streamIndex, buckets, timeout)));
}

const char* stateName(DataProgress::State s) {
    switch (s) {
        case DataProgress::State::Reading: return "reading";
        case DataProgress::State::Done:    return "done";
        case DataProgress::State::Failed:  return "failed";
        case DataProgress::State::Stopped: return "stopped";
    }
    return "reading";
}

// bro.ffmpeg.data.reads.poll(id) — where it has got to.
//
// `null` for an id nothing knows about, which after a terminal answer is the
// ordinary case: the answer is handed over once and the entry is forgotten with
// it, so a caller that polls a finished read twice is a caller that dropped the
// answer.
bronze::Value js_dataPoll(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty()) return ev::throwTypeError("data.reads.poll(id) requires an id");
    if (!ev::isNumber(args[0])) return ev::throwTypeError("data.reads.poll(id) requires a numeric id");
    uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));

    DataProgress p;
    if (!dataReadProgress(id, &p)) return ev::null();

    ev::Persistent o(ev::createObject());
    setStr(o.get(), "state", stateName(p.state));
    setBool(o.get(), "reading", p.state == DataProgress::State::Reading);
    setNum(o.get(), "elapsed", p.elapsed);
    setNum(o.get(), "timeout", p.timeout);
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(o.get(), "error", p.result.error);
    if (p.state == DataProgress::State::Done) {
        ev::Persistent res(readingToJs(p.result));
        o.set(ev::setProperty(o.get(), "result", res.get()));
    } else {
        o.set(ev::setProperty(o.get(), "result", ev::null()));
    }
    return o.get();
}

} // namespace

void installData(Table& ns) {
    Table data(ns, "data");

    /// Which container fourccs have a parser here, asked of the registry.
    ///
    /// The list a UI decides where to put a `Read` control from. It is one entry
    /// long today (`gpmd`) and a real GoPro file carries three data tracks, so
    /// the answer is genuinely a filter rather than a formality: `tmcd` and
    /// `fdsc` are told apart from `gpmd` here and nowhere else.
    data.function("parsers", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        const std::vector<std::string> tags = dataParserTags();
        return stringsToJs(tags);
    });

    Table reads(data, "reads");
    reads.function("start", js_dataStart, 3);
    reads.function("poll", js_dataPoll, 1);
    /// Abort the read. Real rather than a hidden spinner: the interrupt
    /// callback reaches libav's own read, so the poll after it says `stopped`.
    reads.function("cancel", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("data.reads.cancel(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        stopDataRead(id);
        return ev::undefined();
    }, 1);
    /// Stop it and never poll again — an input removed while its track was
    /// still being read. Separate from `cancel` for `probes.forget`'s reason:
    /// the two differ in whether anybody is going to be told.
    reads.function("forget", [](bronze::Value, std::span<const bronze::Value> args) -> bronze::Value {
        namespace ev = bronze::embed;
        if (args.empty() || !ev::isNumber(args[0]))
            return ev::throwTypeError("data.reads.forget(id) requires a numeric id");
        uint64_t id = static_cast<uint64_t>(ev::toDouble(args[0]));
        abandonDataRead(id);
        return ev::undefined();
    }, 1);
}

} // namespace ffmpegbro
