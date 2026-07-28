// The one slot a long-running job runs in, and what it means to be in it.
//
// There has only ever been one job at a time in this binary, and until now
// there was only one *kind* of job, so the slot lived inside ffmpeg_export.cpp
// as a file-static. A recording is a second kind — same thread, same status,
// same stop, a completely different loop — and the moment there are two the
// slot has to be somewhere neither of them owns, or the second one grows a
// copy and "is something running?" starts having two answers.
//
// Three rules travel with the slot rather than with either job, because both
// of them get them wrong in the same way if they are left to remember:
//
//   - **The slot is freed before the terminal status is published.** Anything
//     polling acts the instant it sees a terminal state, and the obvious next
//     act is another job — which is what the export preview does, chaining a
//     lossless reference into the candidate. Freed afterwards there is a short
//     and perfectly reachable window where the status says finished and the
//     next start is refused as "already running".
//   - **A terminal state is published once, at the bottom, after the file has
//     been closed.** Saying "stopped" while a trailer has yet to go down is a
//     window as long as finishing takes, and the obvious act on seeing
//     "stopped" is to open what was made.
//   - **`Held` frees the slot however the job leaves**, including the early
//     return when a file cannot be opened at all. Without that, one failed
//     render leaves the flag set and every job after it is refused.
//
// Nothing here knows what a job *is*. `ffmpeg_export.cpp` renders a timeline
// and `ffmpeg_capture.cpp` records a device; chunk 13's streaming output will
// be a third, and it wants exactly this shape — an open-ended job whose end is
// somebody pressing stop.
#pragma once

#include "ffmpeg_export.h"

#include <functional>
#include <string>

namespace ffmpegbro {
namespace job {

/// Take the slot, and reset the status to a fresh Running one. Returns the
/// number this job will be known by in the report channel — 0, with a reason in
/// `err`, when something already has it.
///
/// The status is seeded here rather than by the caller so that a `poll()`
/// between `claim()` and the job thread's first `publish()` sees a job that has
/// started, not the previous job's terminal state.
///
/// **The number is handed back and not merely recorded.** Every record in the
/// report channel says which render it was said during, which is only useful to
/// somebody who knows which render they started — and `exportStatus().job` is
/// the render running *now*, so it is zero from the instant a job ends, which
/// is exactly the moment whatever started it comes to read what it measured.
/// The one place the number is unambiguous is here.
uint64_t claim(const std::string& path, std::string* err);

/// Hand the work to the job thread. Only after a successful `claim`.
void run(std::function<void()> fn);

/// Publish a snapshot. Copied under the lock; the caller may read it at leisure.
void publish(const ExportStatus& s);

/// The last snapshot published.
ExportStatus status();

/// Has a stop been asked for? Both jobs check this once per output frame.
bool stopping();

/// Ask the running job to stop. Returns immediately; what stopping *means* is
/// the job's — a render calls it Cancelled and a recording calls it Done.
void stop();

/// Free the slot. Called explicitly before the terminal status is published,
/// and again by `Held` on the way out; storing false twice costs nothing.
void release();

/// Block until the running job has finished, whatever its outcome. For
/// shutdown and for tests; the UI polls instead.
void wait();

/// Frees the slot however the job leaves, and closes the report's job number
/// with it.
///
/// Declare it *first* in the job body so that it runs *last*: the writer is
/// torn down before it, and what libav says while a muxer closes a file
/// belongs to the job that opened it.
struct Held {
    ~Held();
};

} // namespace job
} // namespace ffmpegbro
