// Rendering the timeline to a file — the job, and the one slot it runs in.
//
// What to render is ui/viewer.js's answer, arriving as rectangles already
// computed in canvas pixels (see ffmpeg_export.h). How to produce a frame from
// it is export_timeline.h. How to write one is export_writer.h. What is left
// here is the job: one at a time, on a thread, with a status the UI polls.
//
// **One job at a time** because the UI polls a single slot and chains renders
// off it — the preview runs a lossless reference into a candidate the instant
// the first reports done. That chaining is why the slot is freed *before* the
// terminal status is published, and not after. The slot itself is
// ffmpeg_job.h's, because a recording is a second kind of job in the same one.

#include "ffmpeg_export.h"

#include "export_copy.h"
#include "export_frame.h"
#include "export_graph.h"
#include "export_timeline.h"
#include "export_writer.h"

#include "ffmpeg_job.h"
#include "ffmpeg_report.h"

#include "util/log.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

MediaInput resolveInput(const ExportSettings& s, int index, const std::string& path) {
    if (index >= 0 && static_cast<size_t>(index) < s.inputs.size()) return s.inputs[index];
    MediaInput in;
    in.path = path;
    return in;
}

namespace {

void setStatus(const ExportStatus& s) { job::publish(s); }

/// One entry of `ExportSettings::passes` applied to the settings it belongs to.
///
/// Every field of a pass is "the render's unless this says otherwise", so this
/// is the whole of what a pass *is* — there is no second spec format and
/// nothing downstream of here can tell it is running inside a multi-pass job.
ExportSettings settingsForPass(const ExportSettings& base, const ExportPass& p) {
    ExportSettings s = base;
    if (!p.filterGraph.empty()) {
        s.filterGraph = p.filterGraph;
        // The inputs travel with the graph they feed. A pass that changes the
        // graph and inherited the old pad list would be naming `[1:v]` at a
        // file the new chains never mention.
        s.filterInputs = p.filterInputs;
    } else if (!p.filterInputs.empty()) {
        s.filterInputs = p.filterInputs;
    }
    if (!p.path.empty()) s.path = p.path;
    if (!p.format.empty()) s.format = p.format;

    // A pass that names its own encoder starts from an empty option bag: an
    // option table belongs to an encoder, and carrying x264's `preset` onto
    // `wrapped_avframe` is an unknown option — which is an error here, and
    // rightly. A pass that keeps the encoder is adding to what it was set to.
    if (!p.videoCodec.empty() && p.videoCodec != s.videoCodec) {
        s.videoCodec = p.videoCodec;
        s.videoOptions.clear();
        // The named fields are guarded by `hasOption` in the writer, so they
        // are simply ignored by an encoder that has no such control; only the
        // explicit bag can fail, and that is the one being emptied.
    }
    for (const auto& o : p.videoOptions) s.videoOptions.push_back(o);
    for (const auto& o : p.audioOptions) s.audioOptions.push_back(o);

    // `-f null -`: run everything, keep nothing. The null muxer is
    // AVFMT_NOFILE, so no file is opened and none is left behind — which is
    // what an analysis pass wants, since what it produces is the file a filter
    // wrote beside the output or the log the encoder kept.
    if (p.discard) {
        s.format = "null";
        s.faststart = false;
        // The `streams` list, if there is one, names encoders and dispositions
        // for a file that is not being written. Cleared so the pass writes the
        // renderer's ordinary one video stream and one audio stream, which is
        // the smallest thing that can carry the frames past the filters.
        s.streams.clear();
        s.chapters.clear();
    }
    return s;
}

/// Every decoder option this render was given, checked before a frame is
/// written.
///
/// **An unknown option is an error, not a shrug** — but the compositor path
/// deliberately renders an unopenable clip as the hole it is, so a mistyped
/// `-skip_frame` would have come out as a black rectangle and a line in the
/// log. That is right for a file that has gone missing and wrong for a setting
/// somebody typed, and the difference cannot be told apart down where the clip
/// is opened.
///
/// So the inputs that carry decoder options are opened here, once, and their
/// decoders with them. It costs a header read per configured input and nothing
/// whatever for every render that sets none, which is all of them until
/// somebody sets one.
bool checkDecoderOptions(const ExportSettings& s, std::string* err) {
    for (const auto& in : s.inputs) {
        if (in.decoderOptions.empty()) continue;
        AVFormatContext* fmt = nullptr;
        if (!openInput(&fmt, in, err)) return false;
        bool ok = true;
        for (unsigned i = 0; i < fmt->nb_streams && ok; ++i) {
            AVStream* st = fmt->streams[i];
            const AVMediaType kind = st->codecpar->codec_type;
            if (kind != AVMEDIA_TYPE_VIDEO && kind != AVMEDIA_TYPE_AUDIO) continue;
            AVCodecContext* dec = nullptr;
            // A stream this build cannot decode at all is not this check's
            // business — the render will say so where it tries to read it —
            // so only an option failure stops anything here.
            std::string why;
            if (!openDecoder(&dec, st->codecpar, st->time_base, in, false, &why)) {
                if (why.find("has no option") != std::string::npos) { *err = why; ok = false; }
            }
            if (dec) avcodec_free_context(&dec);
        }
        avformat_close_input(&fmt);
        if (!ok) return false;
    }
    return true;
}

/// Does this render have to make pictures and sound at all?
///
/// A file whose every stream is copied is a rewrap or a lossless cut: there is
/// no canvas, no mix, no encoder and no frame clock, and building a
/// `FrameSource` for it would open and decode every clip on the timeline in
/// order to hand the result to nobody. An empty stream list is the renderer's
/// usual two, so it composes.
bool composesAnything(const ExportSettings& s) {
    if (s.streams.empty()) return true;
    for (const auto& st : s.streams)
        if ((st.kind == "video" || st.kind == "audio") && !isCopySource(st.source)) return true;
    return false;
}

/// One walk over the range: ask the edit what the output looks like at this
/// instant, hand it to the writer, say how far along it is. Every step past
/// "how far along" belongs to something else, which is what keeps this readable
/// as the sequence it is.
///
/// **There are two loops here and only one of them is about frames.** A copied
/// stream is not fed per output frame — it is packets arriving on the input's
/// own clock — so it is pumped *beside* the frame loop, up to the time of the
/// frame just written, which is what keeps the muxer's interleaving sane
/// without a second sorting stage. A render with nothing composed in it has no
/// frame loop at all and the packets drive the job.
///
/// It leaves `st` carrying a terminal state only when the *job* is over —
/// failure or cancellation. A pass that finished cleanly leaves it Running, so
/// the next one carries on and the terminal status is published once, at the
/// bottom of `runExport`, after the last file has been closed.
void runPass(ExportSettings s, std::vector<ExportClip> clips, ExportStatus& st,
             const std::function<double()>& secondsSince) {
    const double base = double(st.pass - 1) / double(std::max(1, st.passCount));
    const double share = 1.0 / double(std::max(1, st.passCount));

    st.path = s.path;
    st.stage = "opening";
    st.framesDone = 0;
    st.progress = base;
    const double span = std::max(0.0, s.endTime - s.startTime);
    const int64_t total = std::max<int64_t>(1, std::llround(span * s.fps));
    st.framesTotal = total;
    setStatus(st);

    std::string err;
    if (!checkDecoderOptions(s, &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "render", err);
        return;
    }

    const bool composes = composesAnything(s);

    // Which of the two answers to "what does the output look like at t" this
    // render uses, and the only line in the job that knows there are two.
    std::unique_ptr<FrameSource> source;
    if (!composes) {
        // Nothing to compose: every stream is packets. The frame source is not
        // built at all, so a rewrap of a two-hour file does not open a decoder.
    } else if (!s.filterGraph.empty()) {
        auto g = std::make_unique<GraphSource>(s);
        if (!g->build(&err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            st.elapsedSec = secondsSince();
            setStatus(st);
            LOG_ERROR("export failed: %s", err.c_str());
            reportNote(AV_LOG_ERROR, "render", err);
            return;
        }
        // What the graph turned out to be. The writer is opened next and has
        // to be opened for the picture it will actually be handed, which for a
        // node half-way down a graph is not something anything outside
        // libavfilter could have said before it was configured.
        if (s.sizeFromGraph) { s.width = g->outWidth(); s.height = g->outHeight(); }
        source = std::move(g);
    } else {
        source = std::make_unique<TimelineSource>(s, std::move(clips));
    }
    const bool wantAudio = source && source->hasAudio();

    // The packet path, opened before the writer because a copied stream is
    // described to the muxer out of its input stream's own parameters and there
    // is nowhere else to get them from. `outputStreams` is asked with the same
    // `wantAudio` on both sides, so a copy's index means the same stream here
    // and in the writer.
    CopyStreams copies;
    if (!copies.build(s, outputStreams(s, wantAudio), &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "render", err);
        return;
    }

    Writer writer;
    if (!writer.open(s, wantAudio, &err, &copies)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "render", err);
        return;
    }

    std::vector<float> mix;
    const int rate = s.audioSampleRate;
    const int channels = s.audioChannels;
    int64_t samplesWritten = 0;

    st.stage = composes ? "rendering" : "copying";
    // A copy is not measured in output frames: what it writes is packets, and
    // how many there are is not a thing anybody knows before reading them. Zero
    // is the honest answer, the same one an endless input gives — the progress
    // below comes from the copy's own clock instead.
    if (!composes) { st.framesTotal = 0; }
    setStatus(st);

    for (int64_t n = 0; composes && n < total; ++n) {
        if (job::stopping()) {
            st.state = ExportStatus::State::Cancelled;
            st.stage = "cancelled";
            break;
        }

        const double t = s.startTime + double(n) / s.fps;
        FrameSource& timeline = *source;
        const Rgba& canvas = timeline.canvasAt(t);
        // `-shortest`: the range said how long to write for and the content has
        // run out first. Asked after the canvas rather than before it because
        // the graph does not know its last input has ended until it has tried
        // to pull — so this is the frame that discovered it, and not writing it
        // is the whole of what `-shortest` does.
        if (s.shortest && timeline.exhausted(t)) break;
        if (!writer.writeVideo(canvas, n, &err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            break;
        }

        // The samples this frame covers, counted from the start of the render
        // so rounding never loses or repeats one at a frame boundary.
        if (writer.hasAudio()) {
            const int64_t upTo = std::llround((double(n + 1) / s.fps) * rate);
            const int frames = static_cast<int>(std::max<int64_t>(0, upTo - samplesWritten));
            if (frames > 0) {
                mix.assign(static_cast<size_t>(frames) * channels, 0.0f);
                timeline.mixInto(mix.data(), s.startTime + double(samplesWritten) / rate,
                                 frames, rate, channels);
                if (!writer.writeAudio(mix.data(), frames, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    break;
                }
                samplesWritten = upTo;
            }
        }

        // The copied streams, caught up to the frame just written. Beside the
        // frame loop rather than after it: `av_interleaved_write_frame` queues
        // a stream that runs ahead of its neighbours, so writing a whole copied
        // track first would hold an hour of packets in memory before the first
        // encoded frame went down.
        if (!copies.empty() && !copies.pumpTo(double(n + 1) / s.fps, writer, &err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            break;
        }

        st.framesDone = n + 1;
        // Across the whole job, not across this pass. The person watching
        // started one render; a bar that reached the end and went back to zero
        // would be reporting the machine's business rather than theirs.
        st.progress = base + share * (double(n + 1) / double(total));
        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        // Polled by the UI at frame rate; a lock per output frame is nothing
        // next to encoding one.
        if ((n & 3) == 0 || n + 1 == total) {
            st.bytesWritten = writer.bytesSoFar();
            setStatus(st);
        }
    }

    // The other loop: a render with nothing composed in it is driven by the
    // packets themselves. There is no output frame rate to walk, no canvas and
    // no encoder — the job is over when every copied stream has reached the end
    // of what it was asked for.
    if (!composes && st.state == ExportStatus::State::Running) {
        while (!copies.done()) {
            if (job::stopping()) {
                st.state = ExportStatus::State::Cancelled;
                st.stage = "cancelled";
                break;
            }
            // Half a second at a time, so a Stop is answered promptly and the
            // status moves; the number is a polling interval and nothing else
            // depends on it.
            if (!copies.pumpTo(copies.position() + 0.5, writer, &err)) {
                st.state = ExportStatus::State::Failed;
                st.error = err;
                break;
            }
            st.framesDone = copies.packets();
            const double span = copies.span();
            st.progress = base + share *
                (span > 0 ? std::min(1.0, std::max(0.0, copies.position() / span)) : 0.0);
            st.elapsedSec = secondsSince();
            st.bytesWritten = writer.bytesSoFar();
            setStatus(st);
        }
    }

    // Whatever the copy still owes. The frame loop stops at the range's last
    // frame and a copied stream's own `copyTo` is what says where it ends, so
    // the two need not agree — and a rewrap whose tail was silently dropped
    // because the encoded half ran out first would be a file that is short.
    if (st.state == ExportStatus::State::Running && !copies.empty() &&
        !copies.pumpTo(0, writer, &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
    }

    const bool aborted = st.state == ExportStatus::State::Failed ||
                         st.state == ExportStatus::State::Cancelled;
    // Published only while the job is still *running*.
    //
    // A cancelled or failed render already carries its terminal state by the
    // time it gets here, and saying so before the trailer has been written
    // tells everything watching that the job is over while the file is not —
    // for however long finishing takes, which for an mp4 with `+faststart` is
    // a whole second pass over it. The obvious next act on seeing "stopped" is
    // to open what was made, and it opens a file with no moov in it: the
    // failure reads as a cancelled render having skipped the index, which is
    // the one thing this code goes out of its way to do. Anything terminal is
    // announced once, at the bottom, after the writer has closed the file.
    if (!aborted) { st.stage = "finishing"; setStatus(st); }

    // Finish the file even when cancelled: a half-written mp4 with no index is
    // not playable, and "I stopped it" should still leave the part that was
    // rendered watchable.
    std::string finishErr;
    if (!writer.finish(&finishErr)) {
        // A stopped render is not a failed one, so this does not change the
        // status it reports — but it is not nothing either, and swallowing it
        // entirely is how a file that came out unopenable came to look like a
        // clean cancellation.
        if (aborted) {
            LOG_WARN("export: %s (while finishing a stopped render)", finishErr.c_str());
            reportNote(AV_LOG_WARNING, "render",
                       finishErr + " (while finishing a stopped render)");
        } else {
            st.state = ExportStatus::State::Failed;
            st.error = finishErr;
        }
    }
    st.bytesWritten = writer.bytesSoFar();
    if (!aborted) st.progress = base + share;
    st.elapsedSec = secondsSince();
}

/// The job: every pass in turn, and one terminal status at the bottom.
///
/// **The passes share the slot rather than taking one each.** A two-pass render
/// is one thing to whoever started it — one Stop, one status, one file — and
/// giving the second pass its own claim would mean a window between them where
/// `render.start` would be accepted, which is exactly the race the export
/// preview's chaining already lives in.
void runExport(ExportSettings s, std::vector<ExportClip> clips) {
    job::Held slot;
    const auto began = std::chrono::steady_clock::now();
    const std::function<double()> secondsSince = [&began] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
    };

    // An empty list is one pass that overrides nothing, which is every render
    // written before passes existed — so there is one loop here rather than a
    // fast path and a slow one that could come to disagree.
    std::vector<ExportPass> passes = s.passes;
    if (passes.empty()) passes.push_back(ExportPass{});

    ExportStatus st;
    st.state = ExportStatus::State::Running;
    st.path = s.path;
    st.passCount = static_cast<int>(passes.size());

    std::string lastPath = s.path;
    for (size_t i = 0; i < passes.size(); ++i) {
        st.pass = static_cast<int>(i) + 1;
        st.passLabel = passes[i].label;
        const ExportSettings ps = settingsForPass(s, passes[i]);
        lastPath = ps.path;
        runPass(ps, clips, st, secondsSince);
        if (st.state != ExportStatus::State::Running) break;
    }
    // What the file is called is the last pass's, not the first's: an analysis
    // pass that wrote nothing must not leave the status pointing at a path
    // nothing was written to.
    st.path = lastPath;

    if (st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Done;
        st.stage = "done";
        st.progress = 1.0;
    }
    st.elapsedSec = secondsSince();

    // Free the slot *before* publishing the terminal status, not after.
    //
    // Anything watching poll() will act the instant it sees "done", and the
    // obvious thing to do next is start another render — which the export
    // workspace's preview does, chaining a lossless reference into the
    // candidate. With the flag cleared afterwards there is a window, short but
    // perfectly reachable, where the status says finished and the next start is
    // refused with "an export is already running". The `job::Held` guard still
    // covers every path that leaves without getting here; storing false twice
    // costs nothing.
    job::release();
    setStatus(st);

    // The report's last word about this render, said after the file is closed
    // and the slot is free, so that a surface reading the channel sees the same
    // ordering a surface reading the status does.
    char said[512];
    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("export: wrote %s (%lld frames, %.1f s, %.1f MB)", st.path.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
        std::snprintf(said, sizeof(said), "wrote %s — %lld frames in %.1f s, %.1f MB%s",
                      st.path.c_str(), static_cast<long long>(st.framesDone), st.elapsedSec,
                      st.bytesWritten / 1048576.0,
                      st.passCount > 1 ? " (the last of its passes)" : "");
        reportNote(AV_LOG_INFO, "render", said);
    } else if (st.state == ExportStatus::State::Failed) {
        LOG_ERROR("export failed: %s", st.error.c_str());
        reportNote(AV_LOG_ERROR, "render", st.error);
    } else if (st.state == ExportStatus::State::Cancelled) {
        std::snprintf(said, sizeof(said),
                      "stopped after %lld of %lld frames; %s was closed properly and plays",
                      static_cast<long long>(st.framesDone),
                      static_cast<long long>(st.framesTotal), st.path.c_str());
        reportNote(AV_LOG_WARNING, "render", said);
    }
}

} // namespace

// ── Public surface ─────────────────────────────────────────────────────────

bool startExport(const ExportSettings& settings, const std::vector<ExportClip>& clips,
                 std::string* error) {
    ExportSettings s = settings;
    // yuv420p has no half pixels, and an odd canvas is a failure at
    // avcodec_open2 with an unhelpful message. Round rather than refuse —
    // except where the size is the graph's to say, in which case there is
    // nothing here yet to round and `GraphSource::build` does it once it knows.
    if (!s.sizeFromGraph) {
        s.width = std::max(16, s.width & ~1);
        s.height = std::max(16, s.height & ~1);
    }
    if (s.fps < 1.0 || s.fps > 1000.0) s.fps = 30.0;

    if (s.path.empty()) {
        if (error) *error = "no output file";
        return false;
    }
    // A render that copies packets has neither a timeline nor a graph behind
    // it — a rewrap is one input and one muxer — so neither of the two checks
    // below is about it. Its length is the span of what it copies, which is on
    // the input's clock and not on the range's.
    bool copiesAnything = false;
    for (const auto& st : s.streams) if (isCopySource(st.source)) copiesAnything = true;

    // A graph names its own inputs, so it is a render on its own; the clip list
    // is what the *other* path is made of.
    if (clips.empty() && s.filterGraph.empty() && !copiesAnything) {
        if (error) *error = "nothing on the timeline to render";
        return false;
    }
    if (s.endTime <= s.startTime && !copiesAnything) {
        if (error) *error = "the range to render is empty";
        return false;
    }

    if (!job::claim(s.path, error)) return false;
    {
        // A render knows how long it is before it starts, which is the whole
        // difference between it and a recording: this number is what makes a
        // percentage and an estimate mean anything, and a job with no end
        // leaves it at zero rather than inventing one. See ffmpeg_capture.h.
        ExportStatus st = job::status();
        st.framesTotal = std::max<int64_t>(1, std::llround((s.endTime - s.startTime) * s.fps));
        job::publish(st);
    }
    job::run([s, clips] { runExport(s, clips); });
    return true;
}

ExportStatus exportStatus() { return job::status(); }

void cancelExport() { job::stop(); }

void waitForExport() { job::wait(); }

} // namespace ffmpegbro
