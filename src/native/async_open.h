// One table, for every "started on a thread, polled for an answer" call in this
// binary.
//
// There are two of them and there will be more: `probe_async.h` opens a URL or
// a device, `ffmpeg_data.h` reads a whole data track. They differ in what they
// answer with and in nothing else — the same thread, the same `OpenWatch`, the
// same deadline, the same four states, and the same three rules that are easy
// to get subtly wrong and would then be wrong in two places:
//
//   - **A terminal answer is handed over exactly once.** The thread is joined
//     and the entry erased on the look that reports it, so an id is good for
//     one answer and nothing accumulates behind a caller that walked away. That
//     is also why the answer comes back by value: the caller has one chance at
//     it.
//   - **The answer and the watch are held by `shared_ptr` and captured by the
//     thread**, so a stop arriving at the same moment the thread finishes
//     cannot touch a freed object — the entry is erased under the lock while
//     the thread still holds its own reference to what it was writing into.
//   - **Whatever nobody is coming back for is reaped by whoever next takes the
//     lock.** An abandoned call holds a thread until libav gives up, and there
//     is no other moment at which anything would notice it had.
//
// What is *not* here is anything either caller means by its own words: a probe's
// `stoppable`, which is a fact about libavdevice; a reading's refusal count.
// Those stay where they are explained, and each caller maps a `Slot` into its
// own progress struct. The mechanism has one home; the vocabulary has two.
//
// **This is not `ffmpeg_job.h`'s slot and must not become one.** That slot holds
// the one long job this binary runs — a render or a recording — and its whole
// meaning is that there is exactly one of it. Everything here is the opposite of
// all three of those facts: several may be outstanding, one must be possible
// while a render runs, and none of them writes anything.
#pragma once

#include "ffmpeg_input.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

namespace ffmpegbro {

/// The table for one kind of answer.
///
/// A class rather than a set of free functions because each kind needs its own
/// map and its own id counter: a probe id and a data-read id are different
/// namespaces, and one shared counter would let a caller poll the wrong table
/// and be told "no such id" for something that exists.
///
/// One instance per kind, as a function-local static in the .cpp that owns that
/// kind — never two, or the ids would collide with themselves.
template <class T>
class AsyncOpens {
public:
    /// What one look at an entry finds. Deliberately flat and deliberately not
    /// an enum: the caller turns `finished`/`stopped` into whatever it calls
    /// those states, because "stopped" and "failed" are the same libav return
    /// and different answers, and only the caller knows which of its own words
    /// to use.
    struct Slot {
        double elapsed = 0.0;
        double timeout = 0.0;
        bool finished = false;
        bool stopped = false;   ///< somebody asked it to give up
        T result;               ///< only meaningful once `finished`
    };

    /// Run `work` on a thread of its own. Returns the id to look up, never zero.
    ///
    /// `work` is handed the watch rather than capturing it, so there is exactly
    /// one of them and the caller cannot accidentally hold the entry alive.
    /// The deadline is armed **before** the thread starts, so work that blocks
    /// on its very first syscall is already on the clock.
    uint64_t start(std::function<T(OpenWatch*)> work, double timeoutSec) {
        auto entry = std::make_unique<Entry>();
        entry->timeout = timeoutSec;
        entry->watch->expireIn(timeoutSec);

        auto watch = entry->watch;
        auto result = entry->result;
        auto finished = entry->finished;
        entry->th = std::thread([work = std::move(work), watch, result, finished] {
            *result = work(watch.get());
            // Last, and with a release: whoever sees this reads `*result`, and
            // must see everything written into it.
            finished->store(true, std::memory_order_release);
        });

        std::lock_guard<std::mutex> guard(m_);
        sweep();
        const uint64_t id = ++next_;
        table_.emplace(id, std::move(entry));
        return id;
    }

    /// Where it has got to. False for an id nothing knows about. A finished
    /// entry is filled in, joined and erased, so this returns true for a given
    /// id at most once with `finished` set.
    bool look(uint64_t id, Slot* out) {
        if (!out) return false;
        std::lock_guard<std::mutex> guard(m_);
        sweep();
        auto it = table_.find(id);
        if (it == table_.end()) return false;
        Entry& e = *it->second;

        out->elapsed = std::chrono::duration<double>(Clock::now() - e.began).count();
        out->timeout = e.timeout;
        if (!e.finished->load(std::memory_order_acquire)) {
            out->finished = false;
            return true;
        }
        out->finished = true;
        out->stopped = e.watch->stopped();
        out->result = *e.result;
        if (e.th.joinable()) e.th.join();
        table_.erase(it);
        return true;
    }

    /// Ask it to give up, keeping the answer for the press that asked.
    void stop(uint64_t id) {
        std::lock_guard<std::mutex> guard(m_);
        sweep();
        auto it = table_.find(id);
        if (it != table_.end()) it->second->watch->stop();
    }

    /// Stop it and throw the answer away. Separate from `stop` because the two
    /// differ in whether anybody is going to be told.
    void abandon(uint64_t id) {
        std::lock_guard<std::mutex> guard(m_);
        auto it = table_.find(id);
        if (it != table_.end()) {
            it->second->watch->stop();
            it->second->abandoned = true;
        }
        sweep();
    }

private:
    using Clock = std::chrono::steady_clock;

    struct Entry {
        std::shared_ptr<OpenWatch> watch = std::make_shared<OpenWatch>();
        std::thread th;
        Clock::time_point began = Clock::now();
        double timeout = 0.0;
        std::shared_ptr<T> result = std::make_shared<T>();
        std::shared_ptr<std::atomic<bool>> finished =
            std::make_shared<std::atomic<bool>>(false);
        bool abandoned = false;
    };

    /// Called with the lock held, at the top of everything.
    void sweep() {
        for (auto it = table_.begin(); it != table_.end();) {
            Entry& e = *it->second;
            if (e.abandoned && e.finished->load(std::memory_order_acquire)) {
                if (e.th.joinable()) e.th.join();
                it = table_.erase(it);
            } else {
                ++it;
            }
        }
    }

    std::mutex m_;
    std::map<uint64_t, std::unique_ptr<Entry>> table_;
    uint64_t next_ = 0;
};

} // namespace ffmpegbro
