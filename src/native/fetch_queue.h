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
// ── How many at once, and of what ──────────────────────────────────────────
//
// **Two lanes, because there are two constraints and they are not the same
// constraint.** A pull of a VOD is limited by the link: three concurrent pulls
// of the same recording finish later in total than two do, so `LINK_WORKERS` is
// small and splitting the bandwidth further only delays every one of them. A cut
// taken out of a recording already on this disk shares no link with anything —
// it is a seek and twenty seconds of packets, measured at 70 ms — and counting
// it against the downloads was counting the wrong thing.
//
// It was counting it so hard that the feature stopped working. With one pool of
// two and two multi-hour pulls running, **thirty-four cuts sat queued at 0% for
// hours** and the window had nothing to say about why: `soon` jumps the
// **queue** and nothing here preempts (a half-written file is worse than a
// wait), so a flag that only reorders the waiting is worth nothing when every
// worker is busy. The fix is not a third worker — a third pull would starve them
// again next time — it is that a fetch reading a local file was never what the
// pool existed to limit.
//
// So a fetch is admitted against `LINK_WORKERS` if any of its inputs is read
// over a link and against `DISK_WORKERS` if none is, `isLocalPath` decides
// which (one home for it, in `export_writer.h`), and `soon` orders the waiting
// within whichever lane it is in. `DISK_WORKERS` is two rather than one because
// a cut spends much of its short life in `avformat_find_stream_info` on a file
// nobody else is reading, and rather than more because the proxy encoder is
// already running beside it on the same disk.

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
    /// Whether this one is competing for the link — which lane it waits in, and
    /// the honest answer to "what is it queued behind". Settled from the inputs
    /// when it is queued; see "How many at once, and of what" above.
    bool overLink = false;
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
