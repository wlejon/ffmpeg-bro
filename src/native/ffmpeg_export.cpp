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
// terminal status is published, and not after.

#include "ffmpeg_export.h"

#include "export_frame.h"
#include "export_graph.h"
#include "export_timeline.h"
#include "export_writer.h"

#include "util/log.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ffmpegbro {
namespace {

struct Job {
    std::mutex mu;
    ExportStatus status;
    std::atomic<bool> cancel{false};
    std::atomic<bool> running{false};
    std::thread thread;
};

Job& job() {
    static Job j;
    return j;
}

void setStatus(const ExportStatus& s) {
    Job& j = job();
    std::lock_guard<std::mutex> lock(j.mu);
    j.status = s;
}

/// Clears the running flag however the job leaves — including the early return
/// when the file cannot be opened at all. Without this, one failed render (a
/// codec this build lacks, a path that cannot be written) leaves the flag set
/// and every export after it is refused with "already running".
struct RunningFlag {
    ~RunningFlag() { job().running.store(false); }
};

/// The whole render, as a walk: ask the edit what the output looks like at
/// this instant, hand it to the writer, say how far along it is. Every step
/// past "how far along" belongs to something else, which is what keeps this
/// readable as the sequence it is.
void runExport(ExportSettings s, std::vector<ExportClip> clips) {
    RunningFlag clearOnExit;
    const auto began = std::chrono::steady_clock::now();
    const auto secondsSince = [&began] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
    };

    ExportStatus st;
    st.state = ExportStatus::State::Running;
    st.path = s.path;
    st.stage = "opening";
    const double span = std::max(0.0, s.endTime - s.startTime);
    const int64_t total = std::max<int64_t>(1, std::llround(span * s.fps));
    st.framesTotal = total;
    setStatus(st);

    // Which of the two answers to "what does the output look like at t" this
    // render uses, and the only line in the job that knows there are two.
    std::string err;
    std::unique_ptr<FrameSource> source;
    if (!s.filterGraph.empty()) {
        auto g = std::make_unique<GraphSource>(s);
        if (!g->build(&err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            st.elapsedSec = secondsSince();
            setStatus(st);
            LOG_ERROR("export failed: %s", err.c_str());
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
    FrameSource& timeline = *source;

    Writer writer;
    if (!writer.open(s, timeline.hasAudio(), &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        return;
    }

    std::vector<float> mix;
    const int rate = s.audioSampleRate;
    const int channels = s.audioChannels;
    int64_t samplesWritten = 0;

    st.stage = "rendering";
    setStatus(st);

    for (int64_t n = 0; n < total; ++n) {
        if (job().cancel.load()) {
            st.state = ExportStatus::State::Cancelled;
            st.stage = "cancelled";
            break;
        }

        const double t = s.startTime + double(n) / s.fps;
        if (!writer.writeVideo(timeline.canvasAt(t), n, &err)) {
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

        st.framesDone = n + 1;
        st.progress = double(n + 1) / double(total);
        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        // Polled by the UI at frame rate; a lock per output frame is nothing
        // next to encoding one.
        if ((n & 3) == 0 || n + 1 == total) {
            st.bytesWritten = writer.bytesSoFar();
            setStatus(st);
        }
    }

    const bool aborted = st.state == ExportStatus::State::Failed ||
                         st.state == ExportStatus::State::Cancelled;
    st.stage = aborted ? st.stage : "finishing";
    setStatus(st);

    // Finish the file even when cancelled: a half-written mp4 with no index is
    // not playable, and "I stopped it" should still leave the part that was
    // rendered watchable.
    std::string finishErr;
    if (!writer.finish(&finishErr) && !aborted) {
        st.state = ExportStatus::State::Failed;
        st.error = finishErr;
    }
    st.bytesWritten = writer.bytesSoFar();

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
    // refused with "an export is already running". The RunningFlag guard still
    // covers every path that leaves without getting here; storing false twice
    // costs nothing.
    job().running.store(false);
    setStatus(st);

    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("export: wrote %s (%lld frames, %.1f s, %.1f MB)", s.path.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
    } else if (st.state == ExportStatus::State::Failed) {
        LOG_ERROR("export failed: %s", st.error.c_str());
    }
}

} // namespace

// ── Public surface ─────────────────────────────────────────────────────────

bool startExport(const ExportSettings& settings, const std::vector<ExportClip>& clips,
                 std::string* error) {
    Job& j = job();
    if (j.running.load()) {
        if (error) *error = "an export is already running";
        return false;
    }
    // The previous thread has set running=false but may not have returned yet.
    if (j.thread.joinable()) j.thread.join();

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
    // A graph names its own inputs, so it is a render on its own; the clip list
    // is what the *other* path is made of.
    if (clips.empty() && s.filterGraph.empty()) {
        if (error) *error = "nothing on the timeline to render";
        return false;
    }
    if (s.endTime <= s.startTime) {
        if (error) *error = "the range to render is empty";
        return false;
    }

    j.cancel.store(false);
    j.running.store(true);
    {
        std::lock_guard<std::mutex> lock(j.mu);
        j.status = ExportStatus{};
        j.status.state = ExportStatus::State::Running;
        j.status.path = s.path;
        j.status.stage = "starting";
        j.status.framesTotal = std::max<int64_t>(1, std::llround((s.endTime - s.startTime) * s.fps));
    }
    j.thread = std::thread(runExport, s, clips);
    return true;
}

ExportStatus exportStatus() {
    Job& j = job();
    std::lock_guard<std::mutex> lock(j.mu);
    return j.status;
}

void cancelExport() { job().cancel.store(true); }

void waitForExport() {
    Job& j = job();
    if (j.thread.joinable()) j.thread.join();
}

} // namespace ffmpegbro
