// A probe on a thread of its own. See probe_async.h for why, and async_open.h
// for the table underneath — which is shared with the data-track read, because
// "handed over exactly once, reaped by whoever notices" is one set of rules and
// wants one implementation.

#include "probe_async.h"

#include "async_open.h"
#include "ffmpeg_capabilities.h"

#include <map>
#include <mutex>

namespace ffmpegbro {

namespace {

AsyncOpens<ProbeResult>& opens() {
    static AsyncOpens<ProbeResult> t;
    return t;
}

/// `stoppable` is settled when the probe starts, because it is a fact about the
/// input and not about where the open has got to — see probe_async.h. It is
/// this file's own vocabulary rather than the table's, so it is kept beside it.
std::mutex& stoppableLock() {
    static std::mutex m;
    return m;
}
std::map<uint64_t, bool>& stoppableTable() {
    static std::map<uint64_t, bool> t;
    return t;
}

bool stoppableOf(uint64_t id) {
    std::lock_guard<std::mutex> guard(stoppableLock());
    auto it = stoppableTable().find(id);
    return it == stoppableTable().end() ? true : it->second;
}

void forgetStoppable(uint64_t id) {
    std::lock_guard<std::mutex> guard(stoppableLock());
    stoppableTable().erase(id);
}

} // namespace

uint64_t startProbe(const MediaInput& in, double timeoutSec) {
    const uint64_t id = opens().start(
        [in](OpenWatch* watch) { return probeMedia(in, watch); },
        timeoutSec > 0 ? timeoutSec : kProbeTimeoutSec);
    {
        std::lock_guard<std::mutex> guard(stoppableLock());
        // Asked of libavdevice's own registry rather than matched against a
        // list of device names, so a build with `v4l2` or `avfoundation` in it
        // needs no edit here — and so this cannot disagree with `kindOf()` on
        // the JS side, which walks the same registry to decide the same thing.
        stoppableTable()[id] = !isInputDevice(in.format);
    }
    return id;
}

bool probeProgress(uint64_t id, ProbeProgress* out) {
    if (!out) return false;
    AsyncOpens<ProbeResult>::Slot slot;
    if (!opens().look(id, &slot)) {
        forgetStoppable(id);
        return false;
    }

    out->elapsed = slot.elapsed;
    out->timeout = slot.timeout;
    out->stoppable = stoppableOf(id);
    if (!slot.finished) {
        out->state = ProbeProgress::State::Opening;
        return true;
    }

    out->result = slot.result;
    // Stopped and failed are the same libav return and different answers: one
    // was asked for and one was not, so a UI that says "could not open" for a
    // press of Stop would be reporting a fault nobody had.
    out->state = slot.stopped     ? ProbeProgress::State::Stopped
                 : out->result.ok ? ProbeProgress::State::Done
                                  : ProbeProgress::State::Failed;
    forgetStoppable(id);
    return true;
}

void stopProbe(uint64_t id) { opens().stop(id); }

void abandonProbe(uint64_t id) {
    opens().abandon(id);
    forgetStoppable(id);
}

} // namespace ffmpegbro
