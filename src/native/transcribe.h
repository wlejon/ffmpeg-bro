// What was *said* in a soundtrack — read once, off the UI thread, as text with
// times on it, arriving while it is still being read.
//
// A six-hour Twitch VOD is the case this exists for. The waveform says where
// something is loud and `sound_marks.h` says where something happened, and
// neither helps you find the moment somebody said a word. A transcript does,
// and the reason it is worth the compute is that it turns a recording nobody
// will scrub through into one you can search.
//
// **A transcript is a search hint. It is never the cut.** Everything downstream
// holds this line and it is not a matter of taste. The audio-only and the video
// renditions of a Twitch VOD do not share a zero — measured at +0.80 s, +2.21 s
// and +2.57 s at three points of one recording, and a *step* rather than a
// drift, because an ad break is discontinuous in one rendition and not the
// other. A transcript read from the cheap audio-only copy therefore carries
// that rendition's clock, and a cut placed on its word boundaries would be
// placed on the wrong file's seconds. So a hit is a *place to look*, the
// playhead goes there, and a human agrees. `ui/inputs.js` carries `sameClock`
// for exactly this and it must keep reaching this far.
//
// **What a segment claims.** The same discipline `sound_marks.h` writes down:
// a segment is what the decoder emitted for a 30 s window of audio and the
// times on it are Whisper's own timestamp tokens, on a 0.02 s grid. It is not
// a diarisation — nothing here decided *who* spoke — and it is not a caption,
// because nothing measured whether it is readable at that length. Words come
// back cased and punctuated because the model emits them that way, and that is
// a property of the model rather than a claim by this file.
//
// ── Why this is native, which is NOT sound_marks.h's reason ─────────────────
//
// `sound_marks.h` is native because `bro.sense.analyze()` is synchronous on the
// UI thread. That argument does not transfer: `bro.stt.transcribe()` is already
// asynchronous, already runs on a thread of bro's own and already streams
// tokens back as they are decoded. Reimplementing that would be duplication.
//
// Two other things forced it, and they are worth stating because the obvious
// reading of the paragraph above is that this file should not exist.
//
//   - **The samples.** Whisper wants mono 16 kHz float and the conversion is
//     `swr`'s. bro must never learn about ffmpeg — that is the whole reason for
//     the repo split — so `bro.media` hands back a file's own rate and there is
//     nothing in a worker realm that can resample it. `SourceAudio` is the
//     reader that already does this, on this side, the way this application
//     opens every other input. Driving it from JS would mean a Float32Array of
//     every window crossing the boundary and a protocol to ask for the next one.
//   - **brotensor's pool is a singleton.** `sound_marks.h` says why: its `run()`
//     "assumes it is not re-entered from a second concurrent application
//     thread". A transcription and a marks read are two long analyses a user can
//     plausibly start together, so they take the *same* `analysisLock()`, which
//     is only possible with both on this side of the seam.
//
// ── What this file does NOT do, and why that took three engine fixes ────────
//
// It does not window the audio, and it does not place the timestamps. Both were
// tempting to do here and both would have been this application quietly routing
// around a broken engine, which is the one thing a seam like this must not
// become. brosoundml owns Whisper's decode loop, so all three fixes are there:
//
//   - A decoder asked for timestamps could answer `<|notimestamps|>` and produce
//     none at all — a prompt built `with_timestamps=true` only *omits* the token
//     from the prefix, it cannot stop the model generating it, which whisper-tiny
//     does on a clean 11 s clip. `TranscribeOptions::no_timestamps_id` forbids
//     it. Measured on large-v3: 0 timestamps without, `<|0.00|>…<|11.00|>` with.
//   - A long-form run's timestamps restart at `<|0.00|>` every window and the
//     token stream said nothing about where a window began, so `[10.38]` was
//     10.38 s into *some* half-minute of a six-hour recording and unplaceable.
//     `Transcription::windows` and `TranscribeOptions::on_window` answer it.
//     The same 66 s input read back monotonic afterwards, none backwards.
//   - Long-form took the whole input as one `AudioBuffer` — 690 MB for six
//     hours — so it could not actually do anything long. It takes an
//     `AudioReader` now, and holds one 30 s window (1.9 MB) at a time.
//
// What is left here is the reader itself, over `SourceAudio`, and the walk from
// token ids to segments on the input's clock. That is the right amount for an
// application to own.
//
// ── The weights are not shipped ─────────────────────────────────────────────
//
// Nothing here downloads anything. A model directory is a path the caller gives
// and an absent one is refused **by name**, because the alternative — a feature
// that silently does nothing — is the failure mode this application does not
// have. `brosoundml/scripts/download-whisper.sh --size large-v3` is what puts
// one on disk. Measured on an RTX 4090: large-v3 at 4.0x realtime (a six-hour
// recording in about ninety minutes, searchable from the first window), against
// 2.7x on the same GPU for a run whose timings were suppressed and 1.2x for
// whisper-tiny on the CPU. The CPU path is left working and is not recommended:
// large-v3 without a GPU is days.

#pragma once

#include "ffmpeg_input.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// One run of speech, on the **input's** own clock in seconds — the same clock
/// `clip.inPoint` is written against, which is what lets `timelineTime` in
/// `ui/project.js` carry it onto the timeline through a trim without anything
/// here knowing a timeline exists. `sound_marks.h` states the same rule.
struct TranscriptSegment {
    double start = 0.0;
    double end = 0.0;
    std::string text;
};

/// A transcript is derived, exactly as marks and peaks are: it is not in the
/// document, not in `ui/.storage.json` and not on the undo track.
struct Transcript {
    int streamIndex = -1;       ///< which audio stream was read
    double duration = 0.0;      ///< of the soundtrack, seconds
    double read = 0.0;          ///< how much of it has been transcribed
    std::vector<TranscriptSegment> segments;
    /// Hit `kMaxSegments`. The count is still exact — a truncated list cannot
    /// understate what the recording held.
    bool truncated = false;
    int64_t total = 0;
};

struct TranscribeOptions {
    /// A directory holding config.json, model.safetensors, vocab.json,
    /// merges.txt and (upstream layout) added_tokens.json. Required.
    std::string modelDir;
    /// ISO-639-1. Whisper needs to be told; it does not detect here.
    std::string language = "en";
    /// `translate` renders non-English speech as English. The task is the
    /// model's, not a second pass.
    bool translate = false;
    /// 'cuda', 'cpu', or empty for the best available.
    std::string device;
};

/// A transcript stops growing at this many segments. Chosen against the case
/// this exists for: six hours of continuous speech is on the order of 7000
/// segments, so this is comfortably above a real recording and still a bound.
inline constexpr int kMaxSegments = 40000;

/// Long, because it is measured in the length of the recording rather than in
/// anybody's patience: at 4x realtime a six-hour VOD is ninety minutes. A run
/// that hits this has its partial transcript kept, not discarded.
inline constexpr double kTranscribeTimeoutSec = 6.0 * 60.0 * 60.0;

/// Where a run has got to. `transcript` is filled in **while it runs**, which
/// is the whole point — a caller polls this and shows the words as they land.
struct TranscribeProgress {
    enum class State { Reading, Done, Failed, Stopped };
    State state = State::Reading;
    double elapsed = 0.0;
    double timeout = 0.0;
    std::string error;      ///< only when Failed
    Transcript transcript;  ///< partial while Reading, whole once Done
};

/// Begin reading `in`'s soundtrack. Returns an id to poll, or 0 when the run
/// could not be started at all. Never blocks.
uint64_t startTranscribe(const MediaInput& in, const TranscribeOptions& opts);

/// What `id` has produced so far. False for an id nothing knows about.
///
/// Unlike `marksReadProgress`, a *running* entry answers with everything
/// decoded up to now rather than with nothing: the transcript of a six-hour
/// recording is useful ninety minutes before it is finished, and a caller that
/// could only see the end would be a caller that waits.
bool transcribeProgress(uint64_t id, TranscribeProgress& out);

/// Ask a run to give up. It stops at the next window boundary and keeps what it
/// has, so the press that asked still gets a transcript of what was read.
void stopTranscribe(uint64_t id);

/// Give up on ever looking again — the entry is dropped when its thread ends.
void abandonTranscribe(uint64_t id);

} // namespace ffmpegbro
