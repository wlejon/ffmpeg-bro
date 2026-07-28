// The one job slot. See ffmpeg_job.h.

#include "ffmpeg_job.h"

#include "ffmpeg_report.h"

#include <atomic>
#include <mutex>
#include <thread>

namespace ffmpegbro {
namespace job {

namespace {

struct Slot {
    std::mutex mu;
    ExportStatus status;
    std::atomic<bool> cancel{false};
    std::atomic<bool> running{false};
    std::thread thread;

    /// A `std::thread` that is still joinable when it is destroyed calls
    /// `std::terminate`, and this one lives in a function-local static — so a
    /// process that exits without joining dies with 0xC0000409 *after* it has
    /// printed everything it had to say, which reads as "the last thing it did
    /// crashed" and is nothing of the kind.
    ///
    /// Callers are expected to `wait()`; this is the backstop for the one that
    /// forgot, and for a window closed while something is still running. The
    /// stop is set first so a job blocked on a device's next frame leaves at
    /// the top of its loop rather than being waited on for the length of the
    /// recording.
    ~Slot() {
        cancel.store(true);
        if (thread.joinable()) thread.join();
    }
};

Slot& slot() {
    static Slot s;
    return s;
}

} // namespace

uint64_t claim(const std::string& path, std::string* err) {
    Slot& s = slot();
    if (s.running.load()) {
        // Named for the slot rather than for either job: what is in it may be
        // a render or a recording, and a recording refused because "an export
        // is already running" would send somebody looking for an export.
        if (err) *err = "a job is already running";
        return 0;
    }
    // The previous thread has set running=false but may not have returned yet.
    if (s.thread.joinable()) s.thread.join();

    s.cancel.store(false);
    s.running.store(true);
    // Numbered before the thread exists, so that the first thing the job says
    // — which is often the reason it will not start — already carries the job
    // it belongs to.
    const uint64_t number = beginRenderReport();
    {
        std::lock_guard<std::mutex> lock(s.mu);
        s.status = ExportStatus{};
        s.status.state = ExportStatus::State::Running;
        s.status.path = path;
        s.status.stage = "starting";
    }
    return number;
}

void run(std::function<void()> fn) {
    slot().thread = std::thread(std::move(fn));
}

void publish(const ExportStatus& st) {
    Slot& s = slot();
    std::lock_guard<std::mutex> lock(s.mu);
    s.status = st;
}

ExportStatus status() {
    Slot& s = slot();
    std::lock_guard<std::mutex> lock(s.mu);
    return s.status;
}

bool stopping() { return slot().cancel.load(); }

void stop() { slot().cancel.store(true); }

void release() { slot().running.store(false); }

void wait() {
    Slot& s = slot();
    if (s.thread.joinable()) s.thread.join();
}

Held::~Held() {
    endRenderReport();
    release();
}

} // namespace job
} // namespace ffmpegbro
