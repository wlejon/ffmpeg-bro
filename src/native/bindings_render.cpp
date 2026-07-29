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

#include <quickjs.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

JSValue js_renderStart(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "render.start(spec) requires a spec object");
    JSValueConst spec = argv[0];

    ExportSettings s;
    std::string bad;
    if (!outputFromJs(ctx, spec, &s, &bad))
        return JS_ThrowTypeError(ctx, "%s", bad.c_str());

    const std::vector<ExportClip> clips = clipsFromJs(ctx, spec);

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

} // namespace

void installRender(Table& ns) {
    Table render(ns, "render");
    render.function("start", js_renderStart, 1);
    render.function("poll", js_renderPoll, 1);
    render.function("cancel", [](JSContext*) {
        cancelExport();
        return JS_UNDEFINED;
    });
}

} // namespace ffmpegbro
