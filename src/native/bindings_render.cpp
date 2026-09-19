// `bro.ffmpeg.render` — starting the job that writes a file, watching it, and
// stopping it.
//
// Rendering runs on its own thread and the UI polls it, rather than the render
// calling back into JS. A callback would have to be marshalled onto the JS
// thread anyway — QuickJS has one — and polling costs a lock per animation
// frame, which is nothing next to encoding one.
//
// The spec these calls are given is read in bindings_spec.h, because a
// recording and a preview are given the same one. What is here is the job.

#include "bindings_install.h"
#include "bindings_spec.h"
#include "bindings_table.h"
#include "bindings_value.h"

#include "ffmpeg_export.h"
#include "ffmpeg_report.h"

#include <embed/embed.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

bronze::Value js_renderStart(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    if (args.empty() || !ev::isObject(args[0]))
        return ev::throwTypeError("render.start(spec) requires a spec object");
    bronze::Value spec = args[0];

    ExportSettings s;
    std::string bad;
    if (!outputFromJs(spec, &s, &bad))
        return ev::throwTypeError(bad);

    const std::vector<ExportClip> clips = clipsFromJs(spec);

    std::string err;
    uint64_t jobNumber = 0;
    if (!startExport(s, clips, &err, &jobNumber))
        return ev::throwTypeError("cannot start the render: " + err);
    // **Which render this is**, rather than `true`. Every record in the channel
    // below says which render it was said during, and a caller that means to
    // read its own render's measurements back has nowhere else to learn the
    // number: `poll()`'s `job` is the render running *now*, so it is already
    // zero by the frame a caller sees `done` — which is precisely the frame it
    // comes to read. A positive integer is truthy, so nothing that only checked
    // for success notices.
    return ev::fromDouble(static_cast<double>(jobNumber));
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
void attachReport(bronze::Value o, bronze::Value since) {
    namespace ev = bronze::embed;
    ev::Persistent out(o);
    uint64_t log = 0, meta = 0;
    int max = 512;
    if (ev::isObject(since)) {
        log = static_cast<uint64_t>(std::max(0.0, numProp(since, "log", 0)));
        meta = static_cast<uint64_t>(std::max(0.0, numProp(since, "meta", 0)));
        max = static_cast<int>(numProp(since, "max", 512));
    }
    const ReportDrain d = drainReport(log, meta, max);

    ev::Persistent logs(createArray());
    uint32_t i = 0;
    for (const auto& r : d.logs) {
        ev::Persistent m(ev::createObject());
        setNum(m.get(), "seq", static_cast<double>(r.seq));
        setNum(m.get(), "job", static_cast<double>(r.job));
        setNum(m.get(), "at", r.at);
        setStr(m.get(), "level", logLevelName(r.level));
        setNum(m.get(), "severity", r.level);
        setStr(m.get(), "source", r.source);
        setStr(m.get(), "text", r.text);
        logs.set(ev::setElement(logs.get(), i++, m.get()));
    }
    out.set(ev::setProperty(out.get(), "log", logs.get()));

    ev::Persistent series(createArray());
    i = 0;
    for (const auto& r : d.meta) {
        ev::Persistent m(ev::createObject());
        setNum(m.get(), "seq", static_cast<double>(r.seq));
        setNum(m.get(), "job", static_cast<double>(r.job));
        setNum(m.get(), "at", r.at);
        setStr(m.get(), "stream", r.stream);
        setStr(m.get(), "key", r.key);
        setStr(m.get(), "value", r.value);
        series.set(ev::setElement(series.get(), i++, m.get()));
    }
    out.set(ev::setProperty(out.get(), "meta", series.get()));

    ev::Persistent cur(ev::createObject());
    setNum(cur.get(), "log", static_cast<double>(d.logCursor));
    setNum(cur.get(), "meta", static_cast<double>(d.metaCursor));
    setNum(cur.get(), "logDropped", static_cast<double>(d.logsDropped));
    setNum(cur.get(), "metaDropped", static_cast<double>(d.metaDropped));
    out.set(ev::setProperty(out.get(), "cursor", cur.get()));
}

bronze::Value js_renderPoll(bronze::Value, std::span<const bronze::Value> args) {
    namespace ev = bronze::embed;
    const ExportStatus st = exportStatus();
    ev::Persistent o(ev::createObject());
    setStr(o.get(), "state", stateName(st.state));
    setBool(o.get(), "running", st.state == ExportStatus::State::Running);
    setNum(o.get(), "progress", st.progress);
    setNum(o.get(), "frames", static_cast<double>(st.framesDone));
    setNum(o.get(), "totalFrames", static_cast<double>(st.framesTotal));
    // This job runs until somebody stops it, so `progress` and `totalFrames`
    // are not answers. Read it before drawing a bar: a fraction of an unknown
    // total is zero, and a bar at zero for ten minutes says "stuck" rather
    // than "recording". See ffmpeg_capture.h.
    setBool(o.get(), "openEnded", st.openEnded);
    // What `frames` counts. `totalFrames == 0` used to say "packets" on its own,
    // and stopped: a `-fps_mode vfr` render counts frames and cannot say how many
    // there will be either. Read it before naming the unit, or a render encoding
    // pictures is reported as a copy. See ExportStatus::countingPackets.
    setBool(o.get(), "packets", st.countingPackets);
    setNum(o.get(), "elapsed", st.elapsedSec);
    setNum(o.get(), "fps", st.encodeFps);
    setNum(o.get(), "bytes", static_cast<double>(st.bytesWritten));
    // How many files the muxer opened beside the one it was named with. Zero
    // for an ordinary render, so nothing has to know segmenters exist; the
    // segments of an hls or a segment render, the chunks of a dash one, the
    // pictures of an image2 one and the destinations of a tee otherwise. It is
    // what a progress readout for a segmented render counts, because "43% of
    // the frames" says nothing about how many files have arrived.
    setNum(o.get(), "pieces", static_cast<double>(st.piecesWritten));
    setStr(o.get(), "path", st.path);
    setStr(o.get(), "stage", st.stage);
    // Which pass of how many, and what it is called. One of one for an
    // ordinary render, so nothing has to know there is such a thing as a pass
    // — but a job that is going to walk the range again must not report "43%"
    // and leave the rest to be discovered.
    setNum(o.get(), "pass", st.pass);
    setNum(o.get(), "passes", st.passCount);
    setStr(o.get(), "passLabel", st.passLabel);
    setStr(o.get(), "error", st.error);
    // Which render this is, so that what the channel below says can be pinned
    // to it. Zero while nothing is running — a probe and a decoder warning are
    // worth reading too, and they belong to no render.
    setNum(o.get(), "job", static_cast<double>(currentRenderJob()));
    // Only when asked. Every caller that wants a progress bar and nothing else
    // — and there are three of them — should not pay for building two arrays
    // sixty times a second.
    if (!args.empty()) attachReport(o.get(), args[0]);
    return o.get();
}

} // namespace

void installRender(Table& ns) {
    Table render(ns, "render");
    render.function("start", js_renderStart, 1);
    render.function("poll", js_renderPoll, 1);
    render.function("cancel", [](bronze::Value, std::span<const bronze::Value>) -> bronze::Value {
        cancelExport();
        return bronze::embed::undefined();
    });
}

} // namespace ffmpegbro
