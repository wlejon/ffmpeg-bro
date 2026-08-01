// Where something happens in a soundtrack — read once, off the UI thread, as a
// list of moments rather than as a curve.
//
// Reviewing an hour of wildlife footage, the birds are audible long before
// anything is visible, and a waveform does not help: at a lane's zoom a call and
// the wind under it are the same two pixels. What is wanted is a *place* to jump
// to. bro carries the parts already — `brosoundml::SensorHub`, the tier-0
// acoustic sensor bus behind `bro.sense`: a streaming PCEN mel front-end driving
// spectral-flux onset detection, autocorrelation tonality and an energy VAD, no
// model and no weights. This file drives that hub over a decoded soundtrack and
// keeps the moments its sensors fired on.
//
// **What a mark claims, and what it does not.** This is the one thing about this
// file that matters more than any of the mechanics, because the failure mode is
// a label that sounds like a classification the DSP never made:
//
//   - An **onset** is a spectral-flux transient. Something in the spectrum
//     changed sharply between two 25 ms windows. It is not a bird, a word, a
//     door or a gunshot; it is "something happened here".
//   - A **tonal** run is sustained normalized-autocorrelation periodicity, and
//     the dominant frequency of the winning period is a real number in hertz.
//     A whistle, a hum, an engine and a bird call all read as one. It is not a
//     note, a pitch track or a species.
//   - A **sound** run is bro's energy VAD: frames that beat an adaptive noise
//     floor by an SNR margin. bro's own snapshot calls the flag `voice`; it is
//     named `Sound` here **deliberately**, because nothing in the sensor
//     decided anything was a voice — it is a gate on loudness against the room,
//     and calling it voice would be this file inventing a claim the DSP does
//     not make.
//
// Everything downstream — the binding, `ui/marks.js`, the lane, the manual —
// holds that line, and a change here that widens what a mark is called has to
// widen what it is *measured* by first.
//
// **The DSP runs here rather than in JS, and that is the whole reason this file
// is native.** `bro.sense.analyze()` does exactly this reduction and is a
// perfectly good call — but it is synchronous on the UI thread, and it was
// measured at ~58x realtime (16 kHz, hop 160, win 400: 10 s -> 173 ms, 60 s ->
// 1033 ms, 300 s -> 5434 ms). Five minutes of footage is therefore a 5.4-second
// frozen window and half an hour is about thirty-one seconds of one, for exactly
// the long recordings this feature exists for. It also takes the whole clip as
// one `Float32Array` — about 230 MB per hour of mono 16 kHz — inside the JS
// realm. Chunking it is not the fix and must not be tried: `analyze` builds a
// private `SensorHub` per call, so a chunk boundary resets the flux EMA and the
// VAD's noise floor and *manufactures* an onset at every boundary. So the whole
// track is decoded and fed on one worker thread and only the marks come back.
// `bro.sense` is not installed in worker realms either (bro's `worker.cpp` builds
// its context from an explicit list and `installSenseBindings` is called only
// from `Engine::initAppRealm`), so `ui/analyze-worker.js` was never an option —
// the choice was between this thread and blocking.
//
// **The framing loop in sound_marks.cpp is a second home for a fact bro owns.**
// See the comment on it there; it names bro's `js_analyze` and the three
// parameters the two must agree on. It is duplicated rather than shared because
// bro's copy is inside a QuickJS callback that wants a `Float32Array`, and there
// is no `Float32Array` on this side of the seam.
//
// **Only one of these may run at a time, and that is brotensor's rule rather
// than a choice here.** The hub's mel front-end is composed of brotensor ops,
// `matmul` among them, and brotensor's CPU thread pool
// (`brotensor/detail/cpu/thread_pool.h`) is a process-wide singleton whose
// `run()` "assumes it is not re-entered from a second concurrent application
// thread while a call is outstanding". So the analysis takes a lock; see
// `readSoundMarks`.
//
// **The first half-second of any file carries a mark or two that are not in it,
// and they are not filtered out.** The onset sensor compares each frame's flux
// against a slow EMA of it, and that EMA starts at zero with a ~0.5 s time
// constant, so the earliest frames beat "2.5x the baseline" trivially and only
// the absolute floor (`onset_abs`) holds most of them back. Measured on
// `marks.m4a`: two onsets in the first quarter-second at flux 0.055 and 0.077,
// against 3.4-3.5 for each of the real transients. A warm-up window applied here
// would suppress them — and would make this and `bro.sense.analyze` disagree
// about the same file, which is the one divergence this feature must not have.
// So the flux is *reported* on every onset instead, and the interface can say
// how strong a mark's evidence was.
//
// **A mark is a measurement, not part of the edit.** It is derived from a file
// and a second read of the same file gives the same answer, so it is not in
// `ui/document.js`'s snapshot, not in `ui/.storage.json` and not in the undo
// track — for exactly the reasons `peaks` and a telemetry reading are not.
#pragma once

#include "ffmpeg_input.h"

#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace ffmpegbro {

// ── what a mark is ────────────────────────────────────────────────────────

/// Which sensor fired. Three, because the hub has three that answer a question
/// about *when*; `level` and `centroid` are per-frame numbers with no event in
/// them and belong to a curve rather than to a list of places.
enum class MarkKind {
    Onset,   ///< a spectral-flux transient: something happened here
    Tonal,   ///< a run of sustained periodicity, with a dominant frequency
    Sound,   ///< a run above the measured noise floor. NOT "voice" — see the top
};

/// One moment worth jumping to.
struct SoundMark {
    MarkKind kind = MarkKind::Onset;

    /// Seconds on the **input's own clock** — counted from the input's zero,
    /// which is after its `-ss`, which is the clock `clip.inPoint` is on. That
    /// is what lets `timelineTime(clip, mark.at)` in `ui/project.js` put a mark
    /// under a clip that was trimmed, moved and sped up, without the file being
    /// read a second time.
    ///
    /// **The start of the analysis window the sensor fired on**, not its end.
    /// A frame is 25 ms of audio and the hub timestamps the end of it, so this
    /// subtracts the window: a jump then lands up to 25 ms *early*, which plays
    /// the whole of what was detected. Landing late would clip its front, and
    /// the front is the part an onset is about.
    double at = 0.0;

    /// How long it lasted. Zero for an onset, which is an instant by
    /// construction (the hub's `onset` is true on one frame only, with a
    /// refractory period after it); the run's length for the other two.
    double length = 0.0;

    /// The loudest frame in the mark, in dBFS as the hub measured it — over raw
    /// PCM, not over the PCEN mel, so it is an absolute loudness and comparable
    /// between two files.
    float db = -120.0f;

    /// `Tonal` only: the mean dominant frequency over the run, in hertz. Zero
    /// for the other kinds, where the hub's `dominant_hz` is whatever the
    /// autocorrelation last liked and means nothing.
    float hz = 0.0f;

    /// `Tonal` only: the mean normalized-autocorrelation peak over the run,
    /// in [0,1]. Reported because it is the run's own evidence — a run at 0.62
    /// scraped past the threshold and a run at 0.97 is a clean tone, and a UI
    /// that cannot tell those apart is offering the same confidence for both.
    float periodicity = 0.0f;

    /// `Onset` only: the positive PCEN flux on the triggering frame. The
    /// measurement the mark *is*, kept so that "this is a flux transient" is
    /// something the interface can show rather than only assert.
    float flux = 0.0f;
};

/// The sensor policy, as far as it is worth exposing.
///
/// **bro's own key names and bro's own defaults.** Every field is a
/// `std::optional` and an unset one is left exactly as `SensorHubConfig`
/// constructs it, so the defaults have one home and it is in brosoundml. The
/// names are the ones `bro.sense.start({...})` already takes, so a person who
/// has read bro's docs does not have to learn a second vocabulary for the same
/// knob.
///
/// The VAD's four knobs are deliberately *not* here. They are absolute-loudness
/// policy, they interact (a floor, an SNR, a release rate and a hangover), and
/// nothing in this application has a reason to move one — a run of sound is
/// wanted where the room stops being the loudest thing, which is what the
/// defaults say.
struct SoundMarkOptions {
    /// Flux must beat its slow EMA by this factor. Lower finds more.
    std::optional<float> onsetRatio;
    /// ...and this absolute PCEN-flux floor, which is what stops near-silence
    /// micro-flux from being a transient.
    std::optional<float> onsetAbs;
    /// The normalized-autocorrelation peak a frame needs to count as tonal.
    std::optional<float> tonalMinPeriodicity;
    /// The pitch search range. Narrowing it is the one genuinely content-shaped
    /// control here: birdsong lives well above a generator hum, and a search
    /// that starts at 1 kHz will not lock onto the room.
    std::optional<float> tonalFminHz;
    std::optional<float> tonalFmaxHz;

    /// The shortest run that becomes a mark, in seconds.
    ///
    /// A run of one 10 ms frame is a flicker rather than a place, and a lane of
    /// them is a smear nothing can be jumped between. A tenth of a second is
    /// under the shortest thing anybody calls a sound and over the longest thing
    /// that is only a frame of noise. Onsets are not filtered by it: an onset is
    /// an instant, and the hub's own refractory period (one per 50 ms) is
    /// already the spacing rule for those.
    double minRunSec = 0.1;

    /// Which sensors to keep. All three by default. A caller that only wants
    /// transients pays the same DSP either way — the hub computes every sensor
    /// per frame — but gets a list it does not have to filter, and a cap that is
    /// not spent on marks it was going to throw away.
    bool wantOnsets = true;
    bool wantTonal = true;
    bool wantSound = true;
};

/// The most marks one read will hand back.
///
/// A cap because the count comes from the *file*: the hub's refractory period
/// allows twenty onsets a second, so an hour of continuous transients is 72 000
/// of them, and each is an object on the JS side. Twenty thousand is about
/// seventeen minutes of that worst case and far past any real recording — a
/// dawn chorus measured at a few hundred. Reaching it truncates the list and
/// says so; the exact totals are still reported, because "there were more marks
/// than this" and "the file had this many" are different facts and a truncated
/// list must not be able to lie about the second.
inline constexpr int kMaxSoundMarks = 20000;

/// What one soundtrack turned out to hold.
struct SoundMarks {
    bool ok = false;
    std::string error;

    int streamIndex = -1;   ///< the audio stream that was read, or -1

    /// The span analysed, on the input's own clock. `t1` is where the frames
    /// ran out, which is the end of the file or of the input's `-t`, whichever
    /// came first — minus the tail shorter than one hop, which is not a frame.
    double t0 = 0.0;
    double t1 = 0.0;

    /// The front-end the marks were measured with. Reported rather than assumed
    /// by the reader, because it is bro's number and not this file's: if
    /// brosoundml's default recipe changes, a mark's 25 ms window changes with
    /// it and anything drawing an error bar has to be told.
    int rate = 0;           ///< 16000
    int win = 0;            ///< 400 samples, 25 ms
    int hop = 0;            ///< 160 samples, 10 ms
    int64_t frames = 0;     ///< mel frames the hub processed

    /// Exact totals over the whole track, counted before `minRunSec` and before
    /// the cap. What was *kept* is `marks.size()`.
    int64_t onsets = 0;
    int64_t tonalRuns = 0;
    int64_t soundRuns = 0;

    /// True when `kMaxSoundMarks` stopped the list short. The totals above are
    /// still exact.
    bool truncated = false;

    /// In time order, every kind interleaved — which is the order a jump
    /// between them wants and the order they were detected in, so nothing
    /// sorts.
    std::vector<SoundMark> marks;
};

/// Decode one input's best audio stream to mono 16 kHz and read the sensors
/// over it.
///
/// Synchronous, and **not the call the UI makes** — see `startMarksRead`. Public
/// because it is what the tests exercise and because a headless script with
/// nothing to freeze may as well call it directly.
///
/// `watch` is polled between frames as well as being handed to libav, so a
/// cancel is real during the DSP and not only during I/O. Null when nobody is
/// going to press anything.
///
/// **Takes a process-wide lock for the duration.** brotensor's CPU thread pool
/// is a single-caller singleton (see the top of this file), so two reads at once
/// would re-enter it; the second waits.
///
/// `timeoutSec` above zero re-arms `watch`'s deadline once the lock is held, so
/// a read that queued behind another is given its whole allowance to do its own
/// work — a deadline that ran down while nothing was happening would fail the
/// wrong read. It is a parameter rather than the constant below because only
/// `startMarksRead` knows what the caller asked for, and re-arming with a
/// default would quietly extend a deadline somebody shortened on purpose. Zero
/// leaves whatever deadline is already on the watch, which is what a
/// synchronous caller wants.
SoundMarks readSoundMarks(const MediaInput& in, const SoundMarkOptions& opts,
                          OpenWatch* watch = nullptr, double timeoutSec = 0.0);

/// That process-wide lock, by name, because it stopped being one file's.
///
/// It lives here because this is where the rule it enforces is written down (see
/// the top of this file), but the rule is brotensor's and it binds *every*
/// analysis this application runs, not the marks alone. `src/native/transcribe.cpp`
/// is the second holder: a transcription's mel front-end reaches the same
/// `matmul` and the same singleton pool, and a user can plausibly start a marks
/// read and a transcription over the same recording within a second of each
/// other. Two locks would be no lock.
///
/// Hold it around the analysis, not around the decode that feeds it — a
/// transcription holds it for an hour and a half, and a marks read queued behind
/// one must not also be sitting on a demuxer while it waits.
std::mutex& analysisLock();

// ── the same read, on a thread ────────────────────────────────────────────
//
// `ffmpeg_data.h`'s reasoning, unchanged and more so: the UI thread is the whole
// application, and this one is *seconds* rather than a fifth of a second. It is
// not `ffmpeg_job.h`'s slot — several may be outstanding, one must be possible
// while a render runs, and it writes nothing — so the table is `async_open.h`'s,
// the same one probes and data reads use, which is why "a terminal answer is
// handed over exactly once" means the same thing in all three.

/// How long a read is given when the caller does not say.
///
/// Ten minutes. The arithmetic, rather than a round number picked to look safe:
/// the DSP is ~58x realtime and the decode of an already-open local file is far
/// faster than that, so an hour of sound is about a minute of work and eight
/// hours is about eight. Ten minutes covers a day's dawn chorus off a slow disk
/// and still ends a read of something that has gone wrong. Longer than
/// `kDataReadTimeoutSec` because that one is bounded by I/O and this one is
/// bounded by arithmetic over the whole file.
inline constexpr double kMarksReadTimeoutSec = 600.0;

/// Where one read has got to. The four states a probe and a data read have, for
/// the same reason: a stop that was asked for is not a failure, and the caller
/// that pressed the button has to be able to tell.
struct MarksProgress {
    enum class State { Reading, Done, Failed, Stopped };
    State state = State::Reading;
    double elapsed = 0.0;
    double timeout = 0.0;
    SoundMarks result;
};

/// Start one. Returns the id to poll, never zero.
uint64_t startMarksRead(const MediaInput& in, const SoundMarkOptions& opts,
                        double timeoutSec);

/// Where it has got to. False for an id nothing knows about — which, after a
/// terminal answer, is the ordinary case: the answer is handed over once and the
/// entry is forgotten with it.
bool marksReadProgress(uint64_t id, MarksProgress* out);

/// Ask it to give up. Real rather than a hidden spinner: the flag is read
/// between frames of the analysis as well as by libav's interrupt callback.
void stopMarksRead(uint64_t id);

/// Stop it and stop caring — an input removed while its sound was still being
/// read. The thread is reaped by whichever call notices it has finished.
void abandonMarksRead(uint64_t id);

} // namespace ffmpegbro
