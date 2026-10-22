// Multi-device capture sessions and live preview sessions. See ffmpeg_capture.h
// and capture_internal.h.

#include "ffmpeg_capture.h"
#include "capture_internal.h"

#include "ffmpeg_job.h"
#include "ffmpeg_report.h"
#include "live_tap.h"

extern "C" {
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libavutil/rational.h>
#include <libavutil/samplefmt.h>
}

#include "util/log.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ffmpegbro {
namespace capture_detail {

// ── The session: several devices, on the wall clock ─────────────────────────

namespace {

/// One device, read and decoded, until somebody says stop.
///
/// It does nothing but deposit: the graph, the writer and the clock are the job
/// thread's, so this thread never touches anything another one might. A read
/// that has genuinely hung delays this thread's own join and nothing else,
/// which is the single-device loop's limitation now held per input — the check
/// is between reads, exactly as it always was.
/// `alsoStop` is the *other* reason to give up, and it is a parameter because
/// there are two callers with different ones. A recording's readers stop when
/// the job slot is stopping; a live session's have no job — the whole point of
/// one is to be running while no job is — and would otherwise be torn down by
/// somebody else's recording ending.
void readDevice(Device& d, Hand& h, const std::atomic<bool>& quit,
                const std::function<double()>& secondsSince,
                const std::function<bool()>& alsoStop) {
    while (!quit.load(std::memory_order_relaxed) && !(alsoStop && alsoStop())) {
        av_packet_unref(d.pkt);
        const int rc = av_read_frame(d.fmt, d.pkt);
        if (rc == AVERROR(EAGAIN)) continue;
        if (rc < 0) {
            if (rc != AVERROR_EOF) {
                LOG_WARN("capture: %s: %s", d.name().c_str(), avErr(rc).c_str());
                reportNote(AV_LOG_WARNING, "capture",
                           d.name() + " stopped: " + avErr(rc));
            }
            break;
        }

        const bool isVideo = d.pkt->stream_index == d.videoStream && d.vdec;
        const bool isAudio = d.pkt->stream_index == d.audioStream && d.adec;
        if (!isVideo && !isAudio) continue;

        AVCodecContext* dec = isVideo ? d.vdec : d.adec;
        if (avcodec_send_packet(dec, d.pkt) < 0) continue;

        while (avcodec_receive_frame(dec, d.frame) >= 0) {
            AVFrame* owned = av_frame_alloc();
            if (!owned) break;
            if (av_frame_ref(owned, d.frame) < 0) { av_frame_free(&owned); break; }
            const double arrived = secondsSince();

            std::lock_guard<std::mutex> lock(h.m);
            if (isVideo) {
                if (h.latest) av_frame_free(&h.latest);
                h.latest = owned;
                h.sawPicture = true;
            } else {
                if (h.sound.size() >= kSoundQueue) {
                    AVFrame* oldest = h.sound.front().first;
                    av_frame_free(&oldest);
                    h.sound.pop_front();
                    if (!h.warnedSound) {
                        h.warnedSound = true;
                        reportNote(AV_LOG_WARNING, "capture",
                                   d.name() + ": sound is arriving faster than the render can "
                                              "take it, and the oldest of it is being dropped");
                    }
                }
                h.sound.push_back({owned, arrived});
            }
        }
    }
    std::lock_guard<std::mutex> lock(h.m);
    h.ended = true;
}

/// Drop `skip` samples off the front of a decoded block, in place.
///
/// Pointer arithmetic rather than a copy: the frame's buffer reference still
/// owns the whole allocation and offsetting into it is what libavfilter itself
/// does. It is here because **sound arriving before the session's zero is
/// dropped to the sample**, per feed — a whole block of it is twenty
/// milliseconds, which is audible as a lip-sync error.
void dropFront(AVFrame* f, int skip) {
    if (skip <= 0 || skip >= f->nb_samples) return;
    const auto fmt = static_cast<AVSampleFormat>(f->format);
    const int bytes = av_get_bytes_per_sample(fmt);
    if (bytes <= 0) return;
    const int channels = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : 1;
    if (av_sample_fmt_is_planar(fmt)) {
        for (int p = 0; p < channels; ++p) {
            if (f->extended_data && f->extended_data[p]) f->extended_data[p] += skip * bytes;
            if (p < AV_NUM_DATA_POINTERS && f->data[p] && f->extended_data != f->data)
                f->data[p] += skip * bytes;
        }
    } else if (f->extended_data && f->extended_data[0]) {
        f->extended_data[0] += static_cast<size_t>(skip) * bytes * channels;
        if (f->extended_data != f->data && f->data[0])
            f->data[0] += static_cast<size_t>(skip) * bytes * channels;
    }
    // `linesize[0]` is the size of a plane, so it moves with the pointers. Left
    // behind it describes a buffer that is longer than what is now in front of
    // the pointer, which is the shape of an overrun waiting for whichever
    // filter reads it rather than `nb_samples`.
    f->linesize[0] -= av_sample_fmt_is_planar(fmt) ? skip * bytes : skip * bytes * channels;
    f->nb_samples -= skip;
}

} // namespace

/// Several live inputs, composited by the graph, written as one file.
///
/// **The session runs on the wall clock, and that is the one thing this loop
/// does that the single-device one does not.** With several inputs no input's
/// clock can be the master: driving off one device's frames means the others
/// are read only when it produces, so a camera that goes quiet stops the screen
/// grab beside it. So there is a tick per output frame at the settled rate, and
/// each video feed is *sampled* at the tick — the newest picture its reader has
/// put down, or the one before it again where nothing arrived. Every feed
/// therefore reaches the graph constant rate and aligned, `overlay`'s framesync
/// has nothing to wait for, and a stall freezes one picture rather than the
/// session. That is the "a stall holds the last picture" rule the writer end
/// already had, moved in front of the graph, which is where N inputs need it.
///
/// Sound is not sampled — see `CaptureGraph::setSession` and decision six.
void runSession(CaptureSettings& s, const std::vector<char>& sizeAsked, ExportStatus& st,
                const DeviceList& devs,
                const std::function<double()>& secondsSince,
                const std::function<void(const std::string&)>& refuse) {
    std::string err;

    // The tick rate. Read before the graph can change `s.output.fps` — a graph
    // ending in `fps=10` decimates what it is *given*, and what it is given is
    // the rate the devices are being sampled at.
    const double tickRate = s.output.fps > 0.0 ? s.output.fps : 30.0;
    const AVRational tickHz = av_d2q(tickRate, 1000000);
    const AVRational tickTb = av_inv_q(tickHz);

    auto graph = std::make_unique<CaptureGraph>(s.output.filterGraph, s.output.audioSampleRate,
                                                s.output.audioChannels, s.output.scaler);
    graph->setSession(tickHz);
    if (!graph->open(feedsOf(devs), &err)) { refuse(err); return; }

    Files out(st);
    out.limit = limitOf(sourcesOf(s));
    // A picture will arrive if any device has one: `open()` refuses a graph
    // that reads the pictures and produces none, and every stream of every
    // input goes through the graph in a session. A session of microphones has
    // no picture for its sound to be measured against and must not wait for one.
    bool anyPicture = false;
    for (const auto& d : devs) if (d->hasVideo()) anyPicture = true;
    out.build(s.outputs, sizeAsked, graph.get(), anyPicture, false);
    const auto emit = [&out](const CaptureGraph::Taken& tk) { return out.emit(tk); };

    Readers readers;
    for (size_t i = 0; i < devs.size(); ++i) readers.hands.push_back(std::make_unique<Hand>());
    for (size_t i = 0; i < devs.size(); ++i) {
        Device* d = devs[i].get();
        Hand* h = readers.hands[i].get();
        readers.threads.emplace_back([d, h, &readers, &secondsSince] {
            readDevice(*d, *h, readers.quit, secondsSince, [] { return job::stopping(); });
        });
    }

    // **The session's zero is the first tick at which every video feed has
    // offered a picture.** It is the generalisation of "the recording's zero is
    // the first picture": a session that started before the second camera had
    // woken up would open with that camera black for however long it took, and
    // the black is not something anybody can get back. A feed that is sound
    // only does not gate it — it has no picture to be waited for.
    //
    // Bounded, because the failure worth refusing is the other one: a session
    // sitting for ever on a device that is never going to answer, with
    // "recording" on the screen and nothing on disk.
    constexpr double kWakeUp = 5.0;
    st.stage = "waiting for the devices";
    job::publish(st);
    for (;;) {
        const Device* missing = nullptr;
        bool dead = false;
        for (size_t i = 0; i < devs.size() && !missing; ++i) {
            if (!devs[i]->hasVideo()) continue;
            std::lock_guard<std::mutex> lock(readers.hands[i]->m);
            if (!readers.hands[i]->sawPicture) {
                missing = devs[i].get();
                dead = readers.hands[i]->ended;
            }
        }
        if (!missing) break;
        if (job::stopping()) {
            refuse("stopped before " + missing->name() +
                   " had produced a picture — nothing was recorded");
            return;
        }
        if (dead || secondsSince() > kWakeUp) {
            refuse(missing->name() + " produced no pictures" +
                   (dead ? " and stopped" : " in the first few seconds") +
                   ", so there is nothing for the graph to composite");
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    const auto zero = Clock::now();
    const double zeroSec = secondsSince();
    st.stage = "recording";
    job::publish(st);

    // The last picture taken off each feed, held so that a feed with nothing
    // new is pushed again at the tick rather than leaving a hole for framesync
    // to wait on. Not cloned: the buffersrc keeps a reference of its own
    // (`AV_BUFFERSRC_FLAG_KEEP_REF`), so re-stamping this one next tick cannot
    // reach what was already queued.
    std::vector<AVFrame*> held(devs.size(), nullptr);

    int64_t tick = 0;
    while (!out.stop) {
        if (job::stopping()) break;
        std::this_thread::sleep_until(
            zero + std::chrono::duration_cast<Clock::duration>(
                       std::chrono::duration<double>(double(tick) / tickRate)));
        if (job::stopping()) break;

        bool anyLive = false;
        for (size_t i = 0; i < devs.size() && !out.stop; ++i) {
            Hand& h = *readers.hands[i];
            const int vFeed = devs[i]->hasVideo() ? graph->feedFor(devs[i]->index, false) : -1;
            const int aFeed = devs[i]->hasAudio() ? graph->feedFor(devs[i]->index, true) : -1;

            AVFrame* fresh = nullptr;
            std::deque<std::pair<AVFrame*, double>> sound;
            {
                std::lock_guard<std::mutex> lock(h.m);
                fresh = h.latest;
                h.latest = nullptr;
                sound.swap(h.sound);
                if (!h.ended) anyLive = true;
            }

            if (fresh) {
                if (held[i]) av_frame_free(&held[i]);
                held[i] = fresh;
            }
            if (vFeed >= 0 && held[i]) {
                held[i]->pts = tick;
                if (!graph->push(vFeed, held[i], tickTb, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    out.stop = true;
                }
            }

            for (auto& block : sound) {
                AVFrame* f = block.first;
                const int sr = f->sample_rate > 0 ? f->sample_rate : s.output.audioSampleRate;
                // A block arrived at the moment its *last* sample did, so where
                // it starts is that moment less its own length. Sound from
                // before the session's zero is dropped, to the sample.
                const double start = block.second - zeroSec - double(f->nb_samples) / sr;
                if (aFeed >= 0 && f->nb_samples > 0) {
                    double at = start;
                    if (at < 0.0) {
                        dropFront(f, static_cast<int>(std::llround(-at * sr)));
                        at = 0.0;
                    }
                    if (f->nb_samples > 0) {
                        f->pts = std::llround(at * sr);
                        AVRational tb{1, sr};
                        if (!graph->push(aFeed, f, tb, &err)) {
                            st.state = ExportStatus::State::Failed;
                            st.error = err;
                            out.stop = true;
                        }
                    }
                }
                av_frame_free(&f);
            }
        }

        if (!out.stop && graph->ready() && !out.opened && !out.open(&err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            out.stop = true;
        }
        // `emit` refuses when the recording is over, and it has already said
        // which of the two reasons it was.
        if (!out.stop && out.opened && !graph->drain(emit, &err)) out.stop = true;

        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        if (out.opened) {
            st.bytesWritten = out.bytesSoFar();
            st.piecesWritten = out.piecesWritten();
        }
        if (out.limit > 0.0) {
            st.framesTotal = std::max<int64_t>(1, std::llround(out.limit * s.outputs[0].fps));
            st.progress = std::min(1.0, double(st.framesDone) / double(st.framesTotal));
        }
        job::publish(st);

        // Every device has ended. There is nothing further to sample and
        // re-pushing what was held would be recording a still life.
        if (!anyLive) break;
        tick++;
    }

    for (AVFrame*& f : held) if (f) av_frame_free(&f);
    readers.stopAll();

    // Whatever the filters were still holding.
    if (out.opened && st.state == ExportStatus::State::Running) {
        graph->endAll();
        graph->drain(emit, &err);
    }
    if (!out.opened && st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Failed;
        st.error = "the devices produced nothing for the filter graph to run on";
    }

    const bool failed = st.state == ExportStatus::State::Failed;
    if (out.opened) {
        if (!failed) { st.stage = "finishing"; job::publish(st); }
        // The trailer goes down whatever happened. A recording that lost its
        // index has lost the only copy of something that happened once.
        std::string finishErr;
        if (!out.finish(&finishErr)) {
            if (failed) {
                LOG_WARN("capture: %s (while finishing a failed recording)", finishErr.c_str());
                reportNote(AV_LOG_WARNING, "capture",
                           finishErr + " (while finishing a failed recording)");
            } else {
                st.state = ExportStatus::State::Failed;
                st.error = finishErr;
            }
        }
        st.bytesWritten = out.bytesSoFar();
        st.piecesWritten = out.piecesWritten();
    }
}

// ── The job ────────────────────────────────────────────────────────────────

/// **Which of the two loops runs is the number of inputs**, and nothing else.
///
/// One device has no second clock to be lined up with, so it keeps the media
/// timestamps it always had — which is what lets a `-f lavfi` input record
/// faster than real time and what every existing recording in this application
/// still means. Several devices have no shared clock at all, so they get one:
/// see `runSession`.
void runCapture(CaptureSettings s, DeviceList devs, std::vector<char> sizeAsked) {
    job::Held slot;

    const auto began = Clock::now();
    const std::function<double()> secondsSince = [&began] {
        return std::chrono::duration<double>(Clock::now() - began).count();
    };

    ExportStatus st = job::status();
    st.state = ExportStatus::State::Running;
    st.path = s.output.path;
    st.stage = "opening";
    job::publish(st);

    // A loop that gives up says so and leaves; the terminal state is still
    // published once, at the bottom, after whatever file there was has been
    // closed — which is the slot's rule and not either loop's.
    const std::function<void(const std::string&)> refuse = [&st](const std::string& why) {
        st.state = ExportStatus::State::Failed;
        st.error = why;
    };

    if (devs.size() == 1) runDirect(s, sizeAsked, st, devs.front(), secondsSince, refuse);
    else runSession(s, sizeAsked, st, devs, secondsSince, refuse);

    // **Stopping a recording is how a recording ends.** It is not a
    // cancellation: nothing was abandoned and nothing was lost, and the length
    // was the open question that pressing stop answered. Reporting Cancelled
    // would make every successful recording look like a mistake, and would make
    // the one thing worth distinguishing — a recording that failed —
    // indistinguishable from the ordinary case.
    if (st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Done;
        st.stage = "done";
        st.progress = 1.0;
    }
    st.elapsedSec = secondsSince();

    job::release();
    job::publish(st);

    // Every file by name, because the second one is the one nobody sees on the
    // stage and the report is where a recording says what it left behind. The
    // frames and the megabytes are the recording's — the count is the primary's
    // clock and the size is the sum of all of them.
    std::string wrote = s.outputs.front().path;
    for (size_t i = 1; i < s.outputs.size(); ++i) wrote += " + " + s.outputs[i].path;

    char said[1024];
    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("capture: wrote %s (%lld frames, %.1f s, %.1f MB)", wrote.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
        std::snprintf(said, sizeof(said), "recorded %s — %lld frames in %.1f s, %.1f MB",
                      wrote.c_str(), static_cast<long long>(st.framesDone),
                      st.elapsedSec, st.bytesWritten / 1048576.0);
        reportNote(AV_LOG_INFO, "capture", said);
    } else {
        LOG_ERROR("capture failed: %s", st.error.c_str());
        reportNote(AV_LOG_ERROR, "capture", st.error);
    }
}

// ── Watching: the same reading, published instead of written ───────────────
//
// What this shares with the loop above is everything about *getting hold of* a
// frame — `Device`, `openDevice`, `Hand`, `readDevice`, the sample-at-the-tick
// rule and `CaptureGraph` — and that sharing is the point of it being here.
// What it does not share is the loop itself, because the two answer different
// questions. A recording places frames on an output timeline, owes every
// interval a picture, and has `-t` to judge; a preview shows the newest thing
// there is and owes nothing. Merging them would mean a writer that is
// sometimes absent and a limit that is sometimes infinite, threaded through
// every line — which is a worse fact to hold than two short loops with one
// device reader underneath them.

namespace {

struct LiveRun {
    uint64_t id = 0;
    LiveSettings settings;
    DeviceList devs;
    std::shared_ptr<LiveTap> tap = std::make_shared<LiveTap>();
    std::atomic<bool> quit{false};
    std::thread thread;

    /// Joined here rather than left to the thread, because everything the
    /// thread touches is in this object. Same rule as `Readers`.
    ~LiveRun() {
        quit.store(true);
        if (thread.joinable()) thread.join();
        tap->finishAll();
    }
};

std::mutex liveLock;
std::vector<std::shared_ptr<LiveRun>> liveRuns;
uint64_t liveSeq = 0;

/// One session: read every device, sample at the tick, publish what there is.
void runLive(LiveRun& run) {
    const auto began = Clock::now();
    const auto secondsSince = [&began] {
        return std::chrono::duration<double>(Clock::now() - began).count();
    };

    const double tickRate = run.settings.fps > 0.0 ? run.settings.fps : 30.0;
    const AVRational tickHz = av_d2q(tickRate, 1000000);
    const AVRational tickTb = av_inv_q(tickHz);

    // No graph is the ordinary case: with nothing composited there is nothing
    // to show beyond the devices themselves, and building a pass-through graph
    // to say so would be a filtergraph nobody asked for on every camera.
    std::unique_ptr<CaptureGraph> graph;
    if (!run.settings.filterGraph.empty()) {
        graph = std::make_unique<CaptureGraph>(run.settings.filterGraph,
                                               run.settings.audioSampleRate,
                                               run.settings.audioChannels,
                                               run.settings.scaler);
        graph->setSession(tickHz);
        // The frames go to a decoder, which would only have to undo an RGBA
        // conversion done here. See `CaptureGraph::setConverted`.
        graph->setConverted(false);
        std::string err;
        if (!graph->open(feedsOf(run.devs), &err)) {
            // A graph that will not parse is not a reason to show nothing: the
            // devices are open and their own pads are what a card wants. The
            // Graph stage is already saying the same thing against the node it
            // is about, so this is a line in the log and not a second refusal.
            LOG_WARN("live: %s — showing the devices without it", err.c_str());
            graph.reset();
        }
    }

    Readers readers;
    for (size_t i = 0; i < run.devs.size(); ++i) readers.hands.push_back(std::make_unique<Hand>());
    for (size_t i = 0; i < run.devs.size(); ++i) {
        Device* d = run.devs[i].get();
        Hand* h = readers.hands[i].get();
        readers.threads.emplace_back([d, h, &readers, &secondsSince] {
            readDevice(*d, *h, readers.quit, secondsSince, nullptr);
        });
    }

    std::vector<AVFrame*> held(run.devs.size(), nullptr);
    std::string err;
    int64_t tick = 0;
    while (!run.quit.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_until(
            began + std::chrono::duration_cast<Clock::duration>(
                        std::chrono::duration<double>(double(tick) / tickRate)));
        if (run.quit.load(std::memory_order_relaxed)) break;

        bool anyLive = false;
        for (size_t i = 0; i < run.devs.size(); ++i) {
            Hand& h = *readers.hands[i];
            AVFrame* fresh = nullptr;
            std::deque<std::pair<AVFrame*, double>> sound;
            {
                std::lock_guard<std::mutex> lock(h.m);
                fresh = h.latest;
                h.latest = nullptr;
                sound.swap(h.sound);
                if (!h.ended) anyLive = true;
            }
            if (fresh) {
                if (held[i]) av_frame_free(&held[i]);
                held[i] = fresh;
            }

            // **Published before the graph, and stamped with the tick.** A card
            // shows the device as it arrived; the timestamp is the session's,
            // because an element's clock starts when it starts playing and a
            // camera's own timestamps are whatever its driver felt like.
            const double at = double(tick) / tickRate;
            if (held[i]) {
                if (auto pad = run.tap->pad("in" + std::to_string(i))) pad->put(held[i], at);
                if (graph) {
                    const int vFeed = graph->feedFor(run.devs[i]->index, false);
                    if (vFeed >= 0) {
                        held[i]->pts = tick;
                        if (!graph->push(vFeed, held[i], tickTb, &err))
                            LOG_WARN("live: %s", err.c_str());
                    }
                }
            }

            // Sound reaches the graph — a composition whose sound decides
            // something about its picture is an ordinary graph, and `sidechain`
            // filters exist. **Its level is published here**, on a pad of its
            // own, and that is the meter that matters most: "is the microphone
            // clipping" is a question about the device, before anything the
            // graph does to it, and it has an answer whether or not there is a
            // graph at all. The mix's own level is taken off the sink below.
            //
            // `in<N>:a` is ffmpeg's own way of naming that stream — `0:a` is
            // the sound of input 0 — and it cannot be confused with `in<N>`,
            // which is the picture and is a `<video>` src.
            for (auto& block : sound) {
                AVFrame* f = block.first;
                {
                    auto pad = run.tap->ensure("in" + std::to_string(i) + ":a", true);
                    // The pad measures it — see `LivePadTap::heard`, which is where
                    // the one measurement in this binary lives now that the output
                    // preview publishes a mix into one of these too.
                    pad->heard(f);
                    // **And the block itself, to whoever is monitoring.** The
                    // level is measured whatever happens; the frame is only
                    // referenced when something is listening — see `putSound`.
                    // The device's own sound, before the graph, is what somebody
                    // checking a microphone wants to hear, for the same reason
                    // its level is the one that answers "is it clipping".
                    pad->putSound(f, block.second);
                }
                const int aFeed = graph && run.devs[i]->hasAudio()
                                      ? graph->feedFor(run.devs[i]->index, true) : -1;
                const int sr = f->sample_rate > 0 ? f->sample_rate
                                                  : run.settings.audioSampleRate;
                if (aFeed >= 0 && f->nb_samples > 0 && sr > 0) {
                    f->pts = std::llround(std::max(0.0, block.second) * sr);
                    AVRational tb{1, sr};
                    if (!graph->push(aFeed, f, tb, &err)) LOG_WARN("live: %s", err.c_str());
                }
                av_frame_free(&f);
            }
        }

        if (graph && graph->ready()) {
            graph->drain([&run](const CaptureGraph::Taken& t) {
                if (!t.raw) return true;
                // **Sound is measured here and published as a level.** It used
                // to be dropped on this line, which left a session with a
                // microphone in it saying nothing at all about the microphone —
                // and the levels are the reading somebody wants *before* a take
                // rather than the recording afterwards. Playing the mix is a
                // different thing again and is not this.
                if (t.audio) {
                    const std::string name =
                        t.label.empty() || t.primary ? "aout" : t.label;
                    auto pad = run.tap->ensure(name, false);
                    pad->heard(t.raw);
                    // The mix, for whoever is listening to it. This is the
                    // pad worth hearing rather than measuring: what two
                    // microphones and an `amix` make together is the thing
                    // that only existed in the file afterwards, which is
                    // exactly what the picture side of this stage already
                    // says about `vout`.
                    pad->putSound(t.raw, t.at >= 0.0 ? t.at : 0.0);
                    return true;
                }
                // The composite is the pad nobody had to name, and `vout` is
                // what it is called everywhere else in this application —
                // `resolvePads` maps it, `graph/record.js` writes it. A pad
                // with a name of its own keeps it.
                const std::string name = t.label.empty() || t.primary ? "vout" : t.label;
                run.tap->ensure(name, false)->put(t.raw, t.at);
                return true;
            }, &err);
        }

        if (!anyLive) break;
        tick++;
    }

    for (AVFrame*& f : held) if (f) av_frame_free(&f);
    readers.stopAll();
    run.tap->finishAll();
}

} // namespace
} // namespace capture_detail

// ── Sessions ───────────────────────────────────────────────────────────────

uint64_t openLive(const LiveSettings& settings, std::string* error) {
    using namespace capture_detail;
    if (settings.sources.empty()) {
        if (error) *error = "no device to watch";
        return 0;
    }

    // `openDevice` asks a `CaptureSettings` what sound it wants, because that
    // is the question it has always been asked. Built here rather than
    // widening its signature: a session and a recording want a device opened
    // in exactly the same way, and that is worth keeping obvious.
    CaptureSettings as;
    as.output.includeAudio = settings.includeAudio;
    as.output.audioSampleRate = settings.audioSampleRate;
    as.output.audioChannels = settings.audioChannels;
    as.output.scaler = settings.scaler;

    auto run = std::make_shared<LiveRun>();
    run->settings = settings;
    for (size_t i = 0; i < settings.sources.size(); ++i) {
        auto d = std::make_shared<Device>();
        std::string why;
        // **On this thread**, for the reason a recording opens its devices on
        // the caller's: "there is no camera called that" belongs to the call
        // that asked, while the name that was wrong is still on screen.
        if (!openDevice(*d, settings.sources[i], static_cast<int>(i), as, &why)) {
            if (error) *error = why;
            return 0;
        }
        run->devs.push_back(std::move(d));
    }

    // **The device pads exist before the thread does.** A caller asks what a
    // session publishes the instant `openLive` returns, and "one per input
    // that has a picture" is knowable from the devices that were just opened —
    // so making them on the session thread would be a race the caller could
    // only lose by being quick. The *graph's* pads cannot be settled here: their
    // names are the graph's and their sizes are not known until libavfilter has
    // configured it, which needs a frame.
    for (size_t i = 0; i < run->devs.size(); ++i)
        if (run->devs[i]->hasVideo()) run->tap->ensure("in" + std::to_string(i), true);

    {
        std::lock_guard<std::mutex> lock(liveLock);
        run->id = ++liveSeq;
        liveRuns.push_back(run);
    }
    LiveRun* raw = run.get();
    run->thread = std::thread([raw] { runLive(*raw); });
    LOG_INFO("live: session %llu watching %zu device%s",
             static_cast<unsigned long long>(run->id), run->devs.size(),
             run->devs.size() == 1 ? "" : "s");
    return run->id;
}

std::vector<LivePad> livePads(uint64_t id) {
    using namespace capture_detail;
    std::shared_ptr<LiveRun> run;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        for (const auto& r : liveRuns) if (r->id == id) { run = r; break; }
    }
    std::vector<LivePad> out;
    if (!run) return out;
    for (const auto& p : run->tap->all()) {
        LivePad pad;
        pad.name = p->name();
        pad.device = p->isDevice();
        p->size(&pad.width, &pad.height);
        // What it carries, but **not** what it is doing: reading a level clears
        // it, and this call is made several times a frame by whatever is
        // looking for a pad by name. See `liveLevels`.
        pad.sound = p->isSound();
        out.push_back(std::move(pad));
    }
    return out;
}

std::vector<LiveLevel> liveLevels(uint64_t id) {
    using namespace capture_detail;
    std::shared_ptr<LiveRun> run;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        for (const auto& r : liveRuns) if (r->id == id) { run = r; break; }
    }
    std::vector<LiveLevel> out;
    if (!run) return out;
    for (const auto& p : run->tap->all()) {
        if (!p->isSound()) continue;
        LiveLevel l;
        l.name = p->name();
        l.heard = p->level(&l.channels);
        out.push_back(std::move(l));
    }
    return out;
}

void closeLive(uint64_t id) {
    using namespace capture_detail;
    std::shared_ptr<LiveRun> run;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        for (auto it = liveRuns.begin(); it != liveRuns.end(); ++it)
            if ((*it)->id == id) { run = *it; liveRuns.erase(it); break; }
    }
    // Dropped outside the lock: the destructor joins the session thread, and
    // that thread's last act is to touch the tap. Holding `liveLock` across it
    // would be holding a lock across a join for no reason.
    if (run) LOG_INFO("live: session %llu closed", static_cast<unsigned long long>(id));
}

void closeAllLive() {
    using namespace capture_detail;
    std::vector<std::shared_ptr<LiveRun>> going;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        going.swap(liveRuns);
    }
}

std::shared_ptr<LiveTap> liveTapFor(uint64_t id) {
    using namespace capture_detail;
    std::lock_guard<std::mutex> lock(liveLock);
    for (const auto& r : liveRuns) if (r->id == id) return r->tap;
    return nullptr;
}

} // namespace ffmpegbro
