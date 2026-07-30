// A probe on a thread of its own, so that a URL that does not answer costs
// nothing but the waiting.
//
// `probeMedia` is a few hundred microseconds on a path and can be four seconds
// — or forever — on a URL, and the UI thread is the whole application: stage
// views are never unmounted and the viewer's `<video>` elements *are* the
// decoders, so a blocked frame loop is a frozen window rather than a busy
// panel. This is the way off it.
//
// **It is not `ffmpeg_job.h`'s slot, and must not become one.** That slot holds
// the one long job this binary runs — a render or a recording — and its whole
// meaning is that there is exactly one. A probe is the opposite of all three of
// those facts: several may be outstanding at once (a drop of six URLs is six
// opens), one must be possible *while* a render runs, and it writes nothing.
// Taking the slot would make dropping a file during a render either fail or
// cancel the render.
//
// **The answer is polled, not called back.** The same decision `render.poll()`
// embodies and for the same reason: QuickJS has one thread, so a callback would
// have to be marshalled onto it and looked at from the animation frame — which
// is where the caller already is. See bindings_probe.cpp.
//
// **Stopping is real.** `OpenWatch` (ffmpeg_input.h) is an `AVIOInterruptCB`,
// which is the only thing that aborts an open in progress; `stopProbe` sets it
// and libav abandons the connect, the handshake or the read it was inside. The
// one thing it cannot cut short is `getaddrinfo`, which has no callback in it —
// a name that resolves slowly holds the *probe thread* until the resolver gives
// up, which is exactly why there is a thread for it to hold.
#pragma once

#include "ffmpeg_backend.h"
#include "ffmpeg_input.h"

#include <cstdint>

namespace ffmpegbro {

/// How long an open is given when the caller does not say. Ten seconds is long
/// enough for a TLS handshake to a slow host on a poor connection and short
/// enough that a wrong URL is answered while somebody is still looking at it;
/// it is the number the UI passes nothing to get, and it lives here so there is
/// one of it.
inline constexpr double kProbeTimeoutSec = 10.0;

/// Where one probe has got to.
struct ProbeProgress {
    enum class State {
        Opening,   ///< the thread is inside libav
        Done,      ///< `result` is the answer
        Failed,    ///< `result.error` says why, including "no answer in time"
        Stopped,   ///< somebody asked it to give up
    };
    State state = State::Opening;
    double elapsed = 0.0;   ///< seconds since `startProbe`, still counting while Opening
    double timeout = 0.0;   ///< what it was given, so a caller can draw against it
    ProbeResult result;
};

/// Open this input on a thread of its own. Returns the id to poll, never zero.
///
/// `timeoutSec` of zero or less means `kProbeTimeoutSec`. There is no way to
/// ask for no deadline at all, and that is deliberate: an open with no timeout
/// is the hang this exists to remove, and a caller that genuinely wants to wait
/// forever wants a very large number and should have to write one.
uint64_t startProbe(const MediaInput& in, double timeoutSec);

/// Where it has got to. False when no probe has that id — which is the ordinary
/// answer after a terminal state has been read, since reading one forgets it.
///
/// **A terminal state is handed over exactly once.** The thread is joined and
/// the entry erased on the poll that reports Done, Failed or Stopped, so an id
/// is good for one answer and nothing accumulates behind a caller that walked
/// away. That is also why `*out` carries the whole `ProbeResult` by value: the
/// caller has one chance at it.
bool probeProgress(uint64_t id, ProbeProgress* out);

/// Ask it to give up. The interrupt callback aborts whatever libav is inside;
/// the entry stays pollable and reports Stopped, so a caller that pressed Stop
/// still learns that its press landed. A caller that will never poll again
/// should say so with `abandonProbe`.
void stopProbe(uint64_t id);

/// Stop it and stop caring. The thread is reaped by whichever call notices it
/// has finished, so an input removed mid-open leaves nothing behind.
void abandonProbe(uint64_t id);

} // namespace ffmpegbro
