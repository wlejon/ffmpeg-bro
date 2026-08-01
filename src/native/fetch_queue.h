// Pulling a run of packets into a local file, while the application goes on
// being used.
//
// **A fetch is a stream copy that is not a render**, and the distinction is the
// whole reason this file exists rather than another caller of `startExport`.
// `ffmpeg_job.h` owns one slot, deliberately: a render composites, encodes and
// writes, it is the thing you came to the application to do, and two of them at
// once is two answers to "is something running?". A fetch is none of that. It
// opens a demuxer, copies packets it never decodes into a muxer, and closes
// both — no compositor, no encoder, no filter graph, no report channel, and no
// opinion about the edit. Putting one in the job slot would mean that saving a
// six-hour VOD locked out the Render button for forty minutes, which is exactly
// backwards: the download is the thing you start *so that* you can get on.
//
// So fetches have their own queue, their own threads and their own cancel, and
// the two mechanisms do not know about each other. A render and a fetch can run
// at the same time and neither is aware of it.
//
// ── What it takes ──────────────────────────────────────────────────────────
//
// **A render spec, and it refuses one that is not a copy.** `ui/export/spec.js`
// already builds the object that describes a run and three things already
// consume it (`bindings_spec.h` reads it, `ui/graph/derive.js` draws it,
// `ui/command.js` prints it) — a fetch is a fourth reader of the same seam, not
// a fifth kind of description. What it will not accept is a spec with anything
// in it this loop cannot perform: a composite, a decoded stream, a pad off the
// filter graph. Those are refused **by name** rather than quietly composited by
// some other path, because a fetch that silently became a render would take the
// job slot and the encoder somebody was avoiding.
//
// ── How many at once ───────────────────────────────────────────────────────
//
// `WORKERS` of them, and the number is small on purpose. Every fetch here is a
// download, they share one link, and three concurrent pulls of the same VOD
// finish later in total than two do — the bandwidth is the constraint and
// splitting it further only delays every one of them. Two is enough for the
// shape of work this exists for: the soundtrack of a recording and its picture
// are queued together and the soundtrack, being a few percent of the bytes,
// lands long before the picture whether or not it had a lane to itself.
//
// `soon` is the one departure from first-in-first-out, and it is for the case
// the whole feature is about: a cut taken against a transcript needs a few
// seconds of video *now*, and making it wait behind the forty-minute pull of
// the same recording would defeat the reason the transcript was made first. It
// jumps the **queue**, not a running fetch; nothing here preempts, because a
// half-written file is worse than a wait.

#pragma once

#include "ffmpeg_export.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// One fetch, as everything watching sees it.
///
/// `position` and `span` are seconds on the *output's* clock — what has been
/// written and how much was asked for — which is what makes a progress bar
/// honest for a windowed pull: a two-minute section of a six-hour recording is
/// finished at two minutes and not at 0.5%.
struct FetchStatus {
    uint64_t id = 0;
    std::string label;   ///< what the UI calls it; never a signed URL
    std::string path;    ///< where it is going
    enum class State { Queued, Running, Done, Failed, Cancelled };
    State state = State::Queued;
    double progress = 0.0;      ///< 0…1, or 0 when the span is unknown
    double position = 0.0;
    double span = 0.0;          ///< 0 when nobody knows how long it is
    double elapsedSec = 0.0;
    int64_t packets = 0;
    int64_t bytes = 0;
    std::string error;
};

/// Queue one. Returns the number it will be known by, or 0 with a reason.
///
/// Refused before anything is queued when the spec is not a copy, when there is
/// no stream in it, or when there is no path to write — a fetch that failed for
/// one of those a minute later, on a thread, would be a download somebody
/// watched not happen.
uint64_t startFetch(const ExportSettings& s, const std::string& label, bool soon,
                    std::string* err);

/// Every fetch this process knows about, queued first and in the order they
/// will run, then the running ones, then the finished. Terminal entries stay
/// until `clearFinishedFetches()`, because "it is done" is an answer somebody
/// has to be able to read after the fact.
std::vector<FetchStatus> fetchList();

/// One of them by number. A `state` of `Queued` with a zero `id` is "no such
/// fetch", which is what a caller holding a number from a previous session
/// gets.
FetchStatus fetchStatus(uint64_t id);

/// Ask one to stop. A queued fetch is dropped where it stands; a running one is
/// asked and answers `Cancelled` when it notices, which is at most half a second
/// away. **What is on disk is left there** — a partial file is a partial file
/// and deleting somebody's half-finished download because they pressed Stop is
/// a decision this is not entitled to take.
void stopFetch(uint64_t id);

/// Every one of them, and wait for the threads. For shutdown and for tests.
void stopAllFetches();

/// Forget the terminal entries. The running and queued ones stay.
void clearFinishedFetches();

/// Block until nothing is queued or running. Tests; the UI polls.
void waitForFetches();

} // namespace ffmpegbro
