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

#include <quickjs.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

JSValue floatArray(JSContext* ctx, const std::vector<float>& v) {
    JSValue buf = JS_NewArrayBufferCopy(ctx, reinterpret_cast<const uint8_t*>(v.data()),
                                        v.size() * sizeof(float));
    JSValue args[3] = { buf, JS_UNDEFINED, JS_UNDEFINED };
    JSValue arr = JS_NewTypedArray(ctx, 1, args, JS_TYPED_ARRAY_FLOAT32);
    JS_FreeValue(ctx, buf);
    return arr;
}

JSValue byteArray(JSContext* ctx, const std::vector<uint8_t>& v) {
    JSValue buf = JS_NewArrayBufferCopy(ctx, v.data(), v.size());
    JSValue args[3] = { buf, JS_UNDEFINED, JS_UNDEFINED };
    JSValue arr = JS_NewTypedArray(ctx, 1, args, JS_TYPED_ARRAY_UINT8);
    JS_FreeValue(ctx, buf);
    return arr;
}

JSValue seriesToJs(JSContext* ctx, const DataSeries& s) {
    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "key", s.key);
    setStr(ctx, o, "name", s.name);
    setStr(ctx, o, "units", s.units);
    JS_SetPropertyStr(ctx, o, "component", JS_NewInt32(ctx, s.component));
    JS_SetPropertyStr(ctx, o, "components", JS_NewInt32(ctx, s.components));
    JS_SetPropertyStr(ctx, o, "samples", JS_NewInt64(ctx, s.samples));
    JS_SetPropertyStr(ctx, o, "min", JS_NewFloat64(ctx, s.min));
    JS_SetPropertyStr(ctx, o, "max", JS_NewFloat64(ctx, s.max));
    JS_SetPropertyStr(ctx, o, "rate", JS_NewFloat64(ctx, s.rate));
    // Whether the format's own divisor was found. Reported rather than assumed,
    // because a value that should have been divided and was not is the failure
    // that still looks plausible — a UI that draws one has to be able to say so.
    JS_SetPropertyStr(ctx, o, "scaled", JS_NewBool(ctx, s.scaled));
    JS_SetPropertyStr(ctx, o, "lo", floatArray(ctx, s.lo));
    JS_SetPropertyStr(ctx, o, "hi", floatArray(ctx, s.hi));
    JS_SetPropertyStr(ctx, o, "mean", floatArray(ctx, s.mean));
    // 0 where no sample landed. A gap in a recording is a gap in the line, and
    // a zero drawn in its place is a measurement nobody made.
    JS_SetPropertyStr(ctx, o, "filled", byteArray(ctx, s.filled));
    return o;
}

JSValue readingToJs(JSContext* ctx, const DataReading& r) {
    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "tag", r.tag);
    setStr(ctx, o, "device", r.device);
    JS_SetPropertyStr(ctx, o, "streamIndex", JS_NewInt32(ctx, r.streamIndex));
    JS_SetPropertyStr(ctx, o, "t0", JS_NewFloat64(ctx, r.t0));
    JS_SetPropertyStr(ctx, o, "t1", JS_NewFloat64(ctx, r.t1));
    JS_SetPropertyStr(ctx, o, "buckets", JS_NewInt32(ctx, r.buckets));
    JS_SetPropertyStr(ctx, o, "packets", JS_NewInt64(ctx, r.packets));
    // How many packets the parser would not finish, and the first reason. A
    // damaged track is drawn with what survived and *says* that it is a damaged
    // track — the alternative, an empty plot, cannot be told from a file with
    // nothing in it.
    JS_SetPropertyStr(ctx, o, "refused", JS_NewInt64(ctx, r.refused));
    setStr(ctx, o, "refusal", r.refusal);

    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (const DataSeries& s : r.series)
        JS_SetPropertyUint32(ctx, arr, n++, seriesToJs(ctx, s));
    JS_SetPropertyStr(ctx, o, "series", arr);
    return o;
}

/// The `-i` and the stream, out of whatever the caller passed. The same reader
/// `probes.start` uses, for the same reason: a track read from a file opened
/// with different demuxer options is a different track.
bool readArgs(JSContext* ctx, int argc, JSValueConst* argv, MediaInput* in,
              int* streamIndex, int* buckets, double* timeout) {
    if (argc < 2) {
        JS_ThrowTypeError(ctx, "data.reads.start(input, streamIndex) needs both");
        return false;
    }
    if (JS_IsObject(argv[0])) {
        *in = inputFromJs(ctx, argv[0]);
    } else {
        const char* path = JS_ToCString(ctx, argv[0]);
        if (!path) return false;
        in->path = path;
        JS_FreeCString(ctx, path);
    }
    if (in->path.empty()) {
        JS_ThrowTypeError(ctx, "data.reads.start() needs a path or an input");
        return false;
    }
    int32_t idx = 0;
    if (JS_ToInt32(ctx, &idx, argv[1]) < 0) return false;
    *streamIndex = idx;

    if (argc >= 3 && JS_IsObject(argv[2])) {
        *buckets = int(numProp(ctx, argv[2], "buckets", 0));
        *timeout = numProp(ctx, argv[2], "timeout", 0);
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
JSValue js_dataStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    MediaInput in;
    int streamIndex = 0, buckets = 0;
    double timeout = 0;
    if (!readArgs(ctx, argc, argv, &in, &streamIndex, &buckets, &timeout))
        return JS_EXCEPTION;
    return JS_NewInt64(ctx,
                       int64_t(startDataRead(in, streamIndex, buckets, timeout)));
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
JSValue js_dataPoll(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "data.reads.poll(id) requires an id");
    int64_t id = 0;
    if (JS_ToInt64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;

    DataProgress p;
    if (!dataReadProgress(uint64_t(id), &p)) return JS_NULL;

    JSValue o = JS_NewObject(ctx);
    setStr(ctx, o, "state", stateName(p.state));
    JS_SetPropertyStr(ctx, o, "reading",
                      JS_NewBool(ctx, p.state == DataProgress::State::Reading));
    JS_SetPropertyStr(ctx, o, "elapsed", JS_NewFloat64(ctx, p.elapsed));
    JS_SetPropertyStr(ctx, o, "timeout", JS_NewFloat64(ctx, p.timeout));
    // A string rather than an exception, for `probes.poll`'s reason: a poll is
    // read every frame by something that has to keep drawing either way.
    setStr(ctx, o, "error", p.result.error);
    JS_SetPropertyStr(ctx, o, "result",
                      p.state == DataProgress::State::Done ? readingToJs(ctx, p.result)
                                                           : JS_NULL);
    return o;
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
    data.function("parsers", [](JSContext* ctx) {
        const std::vector<std::string> tags = dataParserTags();
        JSValue arr = JS_NewArray(ctx);
        uint32_t n = 0;
        for (const std::string& t : tags)
            JS_SetPropertyUint32(ctx, arr, n++, JS_NewStringLen(ctx, t.data(), t.size()));
        return arr;
    });

    Table reads(data, "reads");
    reads.function("start", js_dataStart, 3);
    reads.function("poll", js_dataPoll, 1);
    /// Abort the read. Real rather than a hidden spinner: the interrupt
    /// callback reaches libav's own read, so the poll after it says `stopped`.
    reads.function("cancel", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        stopDataRead(uint64_t(id));
        return JS_UNDEFINED;
    });
    /// Stop it and never poll again — an input removed while its track was
    /// still being read. Separate from `cancel` for `probes.forget`'s reason:
    /// the two differ in whether anybody is going to be told.
    reads.function("forget", [](JSContext* ctx, JSValue idArg) {
        int64_t id = 0;
        if (JS_ToInt64(ctx, &id, idArg) < 0) return JS_EXCEPTION;
        abandonDataRead(uint64_t(id));
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
