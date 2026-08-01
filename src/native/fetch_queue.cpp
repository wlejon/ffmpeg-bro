// The fetch queue. See fetch_queue.h.

#include "fetch_queue.h"

#include "export_copy.h"
#include "export_writer.h"

#include "util/log.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace ffmpegbro {
namespace {

/// See the header for why this is small. Changing it changes how a shared link
/// is divided and nothing else — no rule below depends on the number.
constexpr int WORKERS = 2;

/// How much of the output to ask the copy for before looking up.
///
/// The same half second `runPass`'s copy-only loop uses and for the same two
/// reasons: it is how promptly a Stop is answered, and it is a *local* clock
/// rather than an offset from wherever the copy has reached — a stream with a
/// gap in it never advances its own position, and a window measured from that
/// asks the same question for ever.
constexpr double PUMP_SECONDS = 0.5;

struct Entry {
    FetchStatus st;
    ExportSettings settings;
    std::atomic<bool> stop{false};
    bool soon = false;
};

struct Queue {
    std::mutex m;
    std::condition_variable wake;
    std::vector<std::shared_ptr<Entry>> all;      ///< every entry, in arrival order
    std::deque<std::shared_ptr<Entry>> pending;   ///< what is waiting, in run order
    std::vector<std::thread> workers;
    int busy = 0;
    bool closing = false;
    uint64_t nextId = 1;

    /// `job::Slot`'s rule, for `job::Slot`'s reason and with more threads to get
    /// it wrong with. A `std::thread` still joinable when it is destroyed calls
    /// `std::terminate`, and these live in a function-local static — so a window
    /// closed while a download is running would take the process down with
    /// 0xC0000409 *after* everything had been printed, which reads as "the last
    /// thing it did crashed" and is nothing of the kind.
    ///
    /// The stop goes in before the join for the same reason it does there: a
    /// worker inside `av_read_frame` on a stalled socket must leave at the top
    /// of its loop rather than be waited on for the length of the download.
    ~Queue() {
        {
            std::lock_guard<std::mutex> lock(m);
            for (const auto& e : all) e->stop.store(true);
            pending.clear();
            closing = true;
        }
        wake.notify_all();
        for (auto& t : workers) if (t.joinable()) t.join();
    }
};

Queue& q() {
    static Queue instance;
    return instance;
}

bool terminal(FetchStatus::State s) {
    return s == FetchStatus::State::Done || s == FetchStatus::State::Failed ||
           s == FetchStatus::State::Cancelled;
}

/// One fetch, start to finish, on a worker thread.
///
/// **This is `runPass`'s copy-only loop with everything that is not a copy taken
/// out**, and the parts that decide anything are the same objects rather than
/// the same code written twice: `CopyStreams` knows where a copy starts, what a
/// packet's time in the output is and when a tap has run out, and `Writer` knows
/// how to describe a copied stream to a muxer. What is written here is the walk
/// between them, which is a loop and a progress fraction.
void runOne(const std::shared_ptr<Entry>& e) {
    const auto began = std::chrono::steady_clock::now();
    const auto elapsed = [&began] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
    };

    // A snapshot the thread owns. Nothing below touches the shared status
    // except through `publish`, so the loop never holds the lock while libav is
    // reading a socket.
    FetchStatus st;
    {
        std::lock_guard<std::mutex> lock(q().m);
        e->st.state = FetchStatus::State::Running;
        st = e->st;
    }
    const auto publish = [&e, &st] {
        std::lock_guard<std::mutex> lock(q().m);
        e->st = st;
    };
    publish();

    std::string err;
    const ExportSettings& s = e->settings;
    // `false`, because a fetch has no mix: every stream in it is copied and
    // `wantAudio` is what asks the resolver to synthesise a soundtrack out of
    // the composite for a render that did not describe one.
    const std::vector<ExportStream> resolved = outputStreams(s, false);

    CopyStreams copies;
    Writer writer;
    const auto fail = [&](const std::string& why) {
        st.state = FetchStatus::State::Failed;
        st.error = why;
        st.elapsedSec = elapsed();
        publish();
        LOG_ERROR("fetch failed: %s", why.c_str());
    };

    if (!copies.build(s, resolved, &err)) { fail(err); return; }
    if (copies.empty()) { fail("there is nothing in it to copy"); return; }
    if (!writer.open(s, false, &err, &copies, nullptr)) { fail(err); return; }

    st.span = copies.span();
    double upTo = 0.0;
    while (!copies.done()) {
        if (e->stop.load()) {
            st.state = FetchStatus::State::Cancelled;
            break;
        }
        upTo += PUMP_SECONDS;
        if (!copies.pumpTo(upTo, writer, &err)) { fail(err); return; }
        st.position = copies.position();
        st.span = copies.span();
        st.packets = copies.packets();
        st.bytes = writer.bytesSoFar();
        st.progress = st.span > 0.0
                          ? std::min(1.0, std::max(0.0, st.position / st.span))
                          : 0.0;
        st.elapsedSec = elapsed();
        publish();
    }

    // **A cancelled fetch still closes the file.** The trailer is what makes
    // what was pulled playable, and the whole point of stopping a download of a
    // six-hour recording after ten minutes is to have the ten minutes. So the
    // difference between finishing and stopping is where the packets end, not
    // whether the container was ever completed.
    if (st.state == FetchStatus::State::Running && !copies.pumpTo(0, writer, &err)) {
        fail(err);
        return;
    }
    if (!writer.finish(&err)) { fail(err); return; }

    st.bytes = writer.bytesSoFar();
    st.packets = copies.packets();
    st.position = copies.position();
    if (st.state == FetchStatus::State::Running) {
        st.state = FetchStatus::State::Done;
        st.progress = 1.0;
    }
    st.elapsedSec = elapsed();
    publish();
    LOG_INFO("fetch %s %s (%lld packets, %.1f MB, %.1f s)",
             st.state == FetchStatus::State::Done ? "wrote" : "stopped at",
             st.path.c_str(), static_cast<long long>(st.packets),
             st.bytes / 1048576.0, st.elapsedSec);
}

void worker() {
    for (;;) {
        std::shared_ptr<Entry> mine;
        {
            std::unique_lock<std::mutex> lock(q().m);
            q().wake.wait(lock, [] { return q().closing || !q().pending.empty(); });
            if (q().closing && q().pending.empty()) return;
            if (q().pending.empty()) continue;
            mine = q().pending.front();
            q().pending.pop_front();
            // Cancelled while it was waiting: dropped where it stands, with the
            // state it was given, and no file is opened for it at all.
            if (mine->stop.load()) {
                mine->st.state = FetchStatus::State::Cancelled;
                continue;
            }
            q().busy++;
        }
        runOne(mine);
        {
            std::lock_guard<std::mutex> lock(q().m);
            q().busy--;
        }
        q().wake.notify_all();
    }
}

/// Started on the first fetch rather than at boot, because a session that never
/// pulls anything off a page should not be paying for threads that never wake.
void ensureWorkers() {
    if (!q().workers.empty()) return;
    for (int i = 0; i < WORKERS; ++i) q().workers.emplace_back(worker);
}

/// What this loop can and cannot perform, said before anything is queued.
///
/// The refusals are by name because each of them is a different mistake: a
/// composite means somebody handed a fetch the render they meant to press
/// Render on, a `decode:` stream means a conversion, and a pad means the filter
/// graph — none of which exist here, and all of which have a home one stage away.
bool copyOnly(const ExportSettings& s, std::string* err) {
    if (s.path.empty()) { *err = "a fetch needs somewhere to write"; return false; }
    if (s.inputs.empty()) { *err = "a fetch needs an input to read"; return false; }
    if (s.streams.empty()) {
        *err = "a fetch needs a stream list — the usual two are composited, and a "
               "fetch composites nothing";
        return false;
    }
    for (const ExportStream& st : s.streams) {
        if (isCopySource(st.source)) continue;
        *err = "a fetch copies packets and this one asks for '" + st.source +
               "' — a composited or decoded stream is a render, which is the Write "
               "stage and the job slot";
        return false;
    }
    return true;
}

} // namespace

uint64_t startFetch(const ExportSettings& s, const std::string& label, bool soon,
                    std::string* err) {
    if (!copyOnly(s, err)) return 0;

    std::lock_guard<std::mutex> lock(q().m);
    ensureWorkers();
    auto e = std::make_shared<Entry>();
    e->settings = s;
    e->soon = soon;
    e->st.id = q().nextId++;
    e->st.label = label.empty() ? s.path : label;
    e->st.path = s.path;
    e->st.state = FetchStatus::State::Queued;
    q().all.push_back(e);
    // In front of the ordinary ones and behind any other `soon`, so two urgent
    // fetches still run in the order they were asked for.
    if (soon) {
        auto at = std::find_if(q().pending.begin(), q().pending.end(),
                               [](const std::shared_ptr<Entry>& p) { return !p->soon; });
        q().pending.insert(at, e);
    } else {
        q().pending.push_back(e);
    }
    q().wake.notify_one();
    return e->st.id;
}

std::vector<FetchStatus> fetchList() {
    std::lock_guard<std::mutex> lock(q().m);
    std::vector<FetchStatus> out;
    out.reserve(q().all.size());
    for (const auto& e : q().all) out.push_back(e->st);
    return out;
}

FetchStatus fetchStatus(uint64_t id) {
    std::lock_guard<std::mutex> lock(q().m);
    for (const auto& e : q().all) if (e->st.id == id) return e->st;
    return FetchStatus{};
}

void stopFetch(uint64_t id) {
    std::lock_guard<std::mutex> lock(q().m);
    for (const auto& e : q().all) {
        if (e->st.id != id) continue;
        if (terminal(e->st.state)) return;
        e->stop.store(true);
        // A queued one answers immediately: nothing has opened, so there is
        // nothing to notice the flag later.
        if (e->st.state == FetchStatus::State::Queued) {
            e->st.state = FetchStatus::State::Cancelled;
            q().pending.erase(std::remove(q().pending.begin(), q().pending.end(), e),
                              q().pending.end());
        }
        return;
    }
}

void clearFinishedFetches() {
    std::lock_guard<std::mutex> lock(q().m);
    q().all.erase(std::remove_if(q().all.begin(), q().all.end(),
                                 [](const std::shared_ptr<Entry>& e) {
                                     return terminal(e->st.state);
                                 }),
                  q().all.end());
}

void waitForFetches() {
    std::unique_lock<std::mutex> lock(q().m);
    q().wake.wait(lock, [] { return q().pending.empty() && q().busy == 0; });
}

void stopAllFetches() {
    std::vector<std::thread> threads;
    {
        std::lock_guard<std::mutex> lock(q().m);
        for (const auto& e : q().all) {
            if (terminal(e->st.state)) continue;
            e->stop.store(true);
            if (e->st.state == FetchStatus::State::Queued)
                e->st.state = FetchStatus::State::Cancelled;
        }
        q().pending.clear();
        q().closing = true;
        threads.swap(q().workers);
    }
    q().wake.notify_all();
    for (auto& t : threads) if (t.joinable()) t.join();
    // Re-armed, so a test that shut the queue down can start another. The
    // workers are gone and `ensureWorkers` makes new ones on the next fetch.
    std::lock_guard<std::mutex> lock(q().m);
    q().closing = false;
}

} // namespace ffmpegbro
