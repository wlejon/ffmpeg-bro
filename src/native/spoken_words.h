// What was said in a soundtrack, **word by word**, read off the UI thread and
// arriving while it is still being read.
//
// ── Why this exists beside transcribe.h ─────────────────────────────────────
//
// `transcribe.h` already reads speech, and it is not a substitute for this one.
// Whisper times a *segment* — a phrase of several seconds — and that file says
// so deliberately: "claiming one inside a six-second phrase would be a
// measurement nothing made". It is right, and it is the wrong shape for what
// this application does with speech.
//
// Everything downstream of a transcript here is built on a **word**: `WORD_PAD`
// in `ui/library.js` is a second and a half either side of one, `ui/phrase.js`
// answers `at` as the first word's start and `says` as the last word's end, and
// `supercut/cuts.js` cuts a moment around it. A segment-timed hit would put the
// found moment back to plus or minus several seconds — which is, to within a
// factor of one, the centring error that made a cut land two seconds before the
// word somebody searched for. So the corpus is word-timed and stays word-timed.
//
// Parakeet-TDT gives that: `Transcription::token_frames` is the encoder frame
// each token was emitted at, and an encoder frame is 0.08 s
// (`ParakeetConfig::frame_seconds`, subsampling 8 × hop 160 ÷ 16 kHz). It is
// also the model every `words.srt` already in a store was written by, so this
// reads the same words as the corpus it is extending rather than a second
// opinion about them.
//
// ── Why it is native, which IS transcribe.h's reason and one more ───────────
//
// The same two hold: `SourceAudio` is the only reader on this side that can hand
// over mono 16 kHz — the conversion is `swr`'s and bro must never learn about
// ffmpeg — and brotensor's CPU pool is a process-wide singleton whose `run()`
// "assumes it is not re-entered from a second concurrent application thread", so
// a marks read, a Whisper read and this take the **same** `analysisLock()`.
//
// The third is this model's own. `bro.stt`'s Parakeet call is **synchronous on
// the calling thread** — `tools/speech.js` runs it in a loop from the command
// line, where a frozen process is nobody's problem. In a window it is a 1.4 s
// freeze per window at the measured 11× realtime, 1260 times for a five-hour
// recording. That is `sound_marks.h`'s argument exactly, and it is why the
// windowing loop below is here rather than in JS.
//
// ── Why the windowing loop is in this file ─────────────────────────────────
//
// brosoundml owns Whisper's long-form path — `AudioReader`, `windows`,
// `on_window` — and `transcribe.cpp` correctly does not reimplement it. There is
// no such path for Parakeet: `Parakeet::transcribe` takes one `AudioBuffer` and
// decodes it. So somebody has to say how a six-hour recording is divided, and
// until brosoundml grows the same long-form API for this model that is here.
// **If it ever does, this loop moves there**, exactly as Whisper's did.
//
// The three lengths below came out of `tools/speech.js`, which measured them,
// and they live here now so there is one home for them. `tests/words_test.cpp`
// asserts them for `marks_test.cpp`'s reason: a change to the recipe should fail
// loudly rather than move every word in every future transcript quietly.
//
// ── What a word claims ─────────────────────────────────────────────────────
//
// `sound_marks.h`'s discipline, one model along. A word is what the greedy TDT
// decode emitted and its time is the encoder frame it was emitted at — so the
// start is a real measurement on a 0.08 s grid and the **end is not**: it is
// where the next token arrived, which is the last frame this word could still
// have been being said in and not a measurement of when the speaker stopped.
// Nothing here decided who spoke, and nothing here decided that a run of words
// was a sentence.
//
// **A transcript is a search hint and never the cut.** `transcribe.h` states the
// measurement behind that at length — two renditions of one Twitch VOD do not
// share a zero, by up to 2.57 s, as a step rather than a drift — and it reaches
// exactly as far here. A hit moves the playhead; a human agrees.
//
// ── The weights are not shipped ────────────────────────────────────────────
//
// Nothing here downloads anything, and an absent model is refused **by name**.
// `brosoundml/scripts/download-parakeet.sh` puts one on disk. Measured on an
// RTX 4090 at 11.3× realtime, so a six-hour recording is about half an hour and
// is searchable from the first window.

#pragma once

#include "ffmpeg_input.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// One word, on the **input's** own clock in seconds — the clock `clip.inPoint`
/// is written against, which is what lets `timelineTime` in `ui/project.js`
/// carry it onto a timeline through a trim without anything here knowing a
/// timeline exists. `sound_marks.h` and `transcribe.h` state the same rule.
struct SpokenWord {
    double start = 0.0;
    /// Where the *next* token arrived. See the header: not a measurement of
    /// when the speaker stopped saying this word.
    double end = 0.0;
    std::string text;
};

/// Derived, exactly as marks, peaks and a Whisper transcript are: not in the
/// document, not in `ui/.storage.json`, not on the undo track. What makes it
/// durable is a caller writing it out — `corpus/` writes an `.srt`.
struct SpokenWords {
    int streamIndex = -1;       ///< which audio stream was read
    double duration = 0.0;      ///< of the soundtrack, seconds
    double read = 0.0;          ///< how much of it has been transcribed
    std::vector<SpokenWord> words;
    /// Hit `kMaxWords`. `total` stays exact — a truncated list cannot
    /// understate what the recording held.
    bool truncated = false;
    int64_t total = 0;
};

struct SpokenWordsOptions {
    /// A directory holding config.json, model.safetensors and tokenizer.json.
    /// Required.
    std::string modelDir;
    /// 'cuda', 'cpu', 'metal', or empty for the best available.
    std::string device;
};

/// Parakeet's input rate, and not a parameter: the front-end's 16 kHz recipe is
/// fixed by the model (`ParakeetConfig::sample_rate`), and handing `SourceAudio`
/// anything else would be resampling into a front-end that resamples again.
inline constexpr int kWordsRate = 16000;

/// **The window the model listens to is not the window that gets read, and
/// conflating them is the difference between half an hour and most of a day.**
/// The encoder's self-attention is quadratic in what it is handed — measured on
/// a 4090 at about 2.3 ms per second²:
///
///     10 s →    543 ms      120 s → 30 064 ms
///     30 s →  2 472 ms      180 s → 73 681 ms
///     60 s →  9 113 ms
///
/// which is 18.4× realtime at ten seconds and 2.4× at three minutes, so the cost
/// per second of audio is `2.3·n + 300/n` and starts climbing past about 11 s.
///
/// **Fifteen seconds, because it is also the most accurate**, which was the
/// surprise. The same two minutes of a VOD, by window length:
///
///     15 s → 11.3× realtime, 82 words      30 s → 7.1×, 73 words
///     20 s → 11.0× realtime, 78 words      45 s → 7.1×, 61 words
///
/// A longer window does not merely cost more, it *finds less* — the 45-second
/// run loses a fifth of the words and the 30-second run drops a whole closing
/// sentence the 15-second one hears. Parakeet is a TDT transducer trained on
/// short segments, so nothing is being traded here: this is both ends at once.
inline constexpr double kWordsWindowSec = 15.0;

/// **Padding, so no word is cut in half by a boundary.** Each window is decoded
/// with this much of its neighbours on both sides as pure context and keeps only
/// the words whose *start* lands in its own span — so a word straddling a
/// boundary is whole in exactly one window and counted once. Without it, five
/// hours at these windows is 1200 chances to lose the word being searched for,
/// which for a corpus built by searching is the failure that matters.
inline constexpr double kWordsOverlapSec = 1.5;

/// A transcript stops growing at this many words. Six hours of continuous speech
/// is on the order of 54 000 words at conversational rate, so this is well above
/// a real recording and still a bound on a file that lies about its length.
inline constexpr int kMaxWords = 500000;

/// Long, because it is measured in the length of the recording rather than in
/// anybody's patience: at 11× realtime a six-hour VOD is about half an hour, and
/// the same run on a CPU is not. A run that hits this keeps its partial words.
inline constexpr double kWordsTimeoutSec = 12.0 * 60.0 * 60.0;

/// Where a run has got to. `words` is filled in **while it runs**, which is the
/// whole point — a caller polls this and draws the bar from `read`/`duration`.
struct SpokenWordsProgress {
    enum class State { Reading, Done, Failed, Stopped };
    State state = State::Reading;
    double elapsed = 0.0;
    double timeout = 0.0;
    std::string error;      ///< only when Failed
    SpokenWords result;     ///< partial while Reading, whole once Done
};

/// Begin reading `in`'s soundtrack. Returns an id to poll, or 0 when the run
/// could not be started at all. Never blocks.
uint64_t startSpokenWords(const MediaInput& in, const SpokenWordsOptions& opts);

/// What `id` has produced so far. False for an id nothing knows about.
///
/// Like `transcribeProgress` and unlike `marksReadProgress`, a *running* entry
/// answers with every word decoded up to now rather than with nothing: half a
/// list of onsets is worth nothing, and half a transcript of a six-hour
/// recording is worth half an hour of somebody's afternoon.
bool spokenWordsProgress(uint64_t id, SpokenWordsProgress& out);

/// Ask a run to give up. It stops at the next window boundary and keeps what it
/// has, so the press that asked still gets the words that were read.
void stopSpokenWords(uint64_t id);

/// Give up on ever looking again — the entry is dropped when its thread ends.
void abandonSpokenWords(uint64_t id);

} // namespace ffmpegbro
