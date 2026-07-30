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
// **A device is opened through here too, and for the same reason.** A camera
// another application already holds, or a capture card mid-reset, blocks inside
// libav exactly as a slow URL does — `dshow` opening a working audio device is
// 920 ms on this machine with nothing wrong — and it blocks on the thread that
// draws the window. Nothing was widened to carry one: a device is `-f dshow -i
// video=…`, which is a `MediaInput` and always was, so `startProbe` already
// took it. What decides whether an open comes through here is a *lookup* — a
// scheme parsed out of the path, or a format name found in libavdevice's own
// registry — and neither opens anything, which is what keeps the thing that
// chooses from being the thing that blocks.
//
// **Stopping is real for a URL and only half real for a device**, and that
// difference is reported rather than hidden. `OpenWatch` (ffmpeg_input.h) is an
// `AVIOInterruptCB`, which is the only thing that aborts an open in progress;
// `stopProbe` sets it and libav abandons the connect, the handshake or the read
// it was inside. It reaches every part of a URL's open except `getaddrinfo`,
// which has no callback in it. It reaches **none** of a device's `read_header`
// — measured, zero polls across a 400 ms `dshow` open — and all of the
// `find_stream_info` that follows. `ProbeProgress::stoppable` says which of the
// two is in flight, so a `Stop` on screen can say what its press will do; a
// button claiming to abort an open it cannot reach would be worse than no
// button, because it would be a lie about what the machine is doing.
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

    /// Can `stopProbe` reach the open, or only the waiting?
    ///
    /// True for everything libavformat opens through its AVIO layer, which is
    /// every path and every URL: the interrupt callback is polled inside the
    /// connect, the handshake and the read. False for a libavdevice demuxer,
    /// whose `read_header` never consults it — see `OpenWatch` for the
    /// measurement. A false one still ends by itself when the deadline is
    /// reached in `avformat_find_stream_info`, and a Stop still stops the
    /// *waiting*; what it cannot do is shorten the device's own open.
    ///
    /// **A fact about the input, so it is settled when the probe starts** and
    /// not re-derived by whoever draws the button. Two answers to "will this
    /// press land" is exactly the disagreement this field exists to prevent.
    bool stoppable = true;

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
///
/// **On a probe whose `stoppable` is false this is not the call to make.** It
/// is not wrong — the flag is set and `find_stream_info` will honour it — but
/// the entry then stays Opening for as long as the device's own `read_header`
/// takes, which is the state a press is supposed to end. `abandonProbe` is
/// what a device's Stop means.
void stopProbe(uint64_t id);

/// Stop it and stop caring. The thread is reaped by whichever call notices it
/// has finished, so an input removed mid-open leaves nothing behind.
void abandonProbe(uint64_t id);

} // namespace ffmpegbro
