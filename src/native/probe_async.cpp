// A probe on a thread of its own. See probe_async.h.

#include "probe_async.h"

#include "ffmpeg_capabilities.h"

#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

namespace ffmpegbro {

namespace {

using Clock = std::chrono::steady_clock;

/// One outstanding probe.
///
/// The watch and the answer are held by `shared_ptr` and captured by the
/// thread, so a stop that arrives at the same moment the thread finishes cannot
/// touch a freed object — the entry is erased under the lock while the thread
/// still holds its own reference to what it was writing into.
struct Entry {
    std::shared_ptr<OpenWatch> watch = std::make_shared<OpenWatch>();
    std::thread th;
    Clock::time_point began = Clock::now();
    double timeout = kProbeTimeoutSec;
    /// Settled once, when the probe starts, because it is a fact about the
    /// input and not about where the open has got to.
    bool stoppable = true;

    // Written by the thread, read under the lock.
    std::shared_ptr<ProbeResult> result = std::make_shared<ProbeResult>();
    std::shared_ptr<std::atomic<bool>> finished = std::make_shared<std::atomic<bool>>(false);

    bool abandoned = false;
};

std::mutex& lock() {
    static std::mutex m;
    return m;
}

std::map<uint64_t, std::unique_ptr<Entry>>& table() {
    static std::map<uint64_t, std::unique_ptr<Entry>> t;
    return t;
}

/// Reap whatever nobody is coming back for. Called with the lock held, at the
/// top of everything: a probe abandoned mid-open holds a thread until libav
/// gives up, and there is no other moment at which anything would notice it
/// had.
void sweep() {
    for (auto it = table().begin(); it != table().end();) {
        Entry& e = *it->second;
        if (e.abandoned && e.finished->load(std::memory_order_acquire)) {
            if (e.th.joinable()) e.th.join();
            it = table().erase(it);
        } else {
            ++it;
        }
    }
}

double secondsSince(Clock::time_point t) {
    return std::chrono::duration<double>(Clock::now() - t).count();
}

} // namespace

uint64_t startProbe(const MediaInput& in, double timeoutSec) {
    static uint64_t next = 0;

    auto entry = std::make_unique<Entry>();
    entry->timeout = timeoutSec > 0 ? timeoutSec : kProbeTimeoutSec;
    // Asked of libavdevice's own registry rather than matched against a list of
    // device names, so a build with `v4l2` or `avfoundation` in it needs no
    // edit here — and so this cannot disagree with `kindOf()` on the JS side,
    // which walks the same registry to decide the same thing.
    entry->stoppable = !isInputDevice(in.format);
    // Set before the thread starts, so an open that blocks on its very first
    // syscall is already on the clock.
    entry->watch->expireIn(entry->timeout);

    auto watch = entry->watch;
    auto result = entry->result;
    auto finished = entry->finished;
    entry->th = std::thread([in, watch, result, finished] {
        *result = probeMedia(in, watch.get());
        // Last, and with a release: the poll that sees this reads `*result`,
        // and it must see everything written into it.
        finished->store(true, std::memory_order_release);
    });

    std::lock_guard<std::mutex> guard(lock());
    sweep();
    const uint64_t id = ++next;
    table().emplace(id, std::move(entry));
    return id;
}

bool probeProgress(uint64_t id, ProbeProgress* out) {
    if (!out) return false;
    std::lock_guard<std::mutex> guard(lock());
    sweep();
    auto it = table().find(id);
    if (it == table().end()) return false;
    Entry& e = *it->second;

    out->elapsed = secondsSince(e.began);
    out->timeout = e.timeout;
    out->stoppable = e.stoppable;
    if (!e.finished->load(std::memory_order_acquire)) {
        out->state = ProbeProgress::State::Opening;
        return true;
    }

    out->result = *e.result;
    // Stopped and failed are the same libav return and different answers: one
    // was asked for and one was not, so a UI that says "could not open" for a
    // press of Stop would be reporting a fault nobody had.
    out->state = e.watch->stopped()    ? ProbeProgress::State::Stopped
                 : out->result.ok      ? ProbeProgress::State::Done
                                       : ProbeProgress::State::Failed;
    if (e.th.joinable()) e.th.join();
    table().erase(it);
    return true;
}

void stopProbe(uint64_t id) {
    std::lock_guard<std::mutex> guard(lock());
    sweep();
    auto it = table().find(id);
    if (it != table().end()) it->second->watch->stop();
}

void abandonProbe(uint64_t id) {
    std::lock_guard<std::mutex> guard(lock());
    auto it = table().find(id);
    if (it != table().end()) {
        it->second->watch->stop();
        it->second->abandoned = true;
    }
    sweep();
}

} // namespace ffmpegbro
