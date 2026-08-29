// The transcription loop. The reasoning, and every decision it embodies, is at
// the top of transcribe.h; this file is the mechanism.

#include "transcribe.h"

#include "analysis_device.h"
#include "async_open.h"
#include "export_source.h"
#include "sound_marks.h"     // analysisLock()

#include <brolm/whisper_tokenizer.h>
#include <brosoundml/whisper.h>
#include <brotensor/runtime.h>
#include <brotensor/tensor.h>

#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace ffmpegbro {
namespace {

/// Whisper's input rate, and not a parameter. The log-mel front-end's 16 kHz /
/// 25 ms / 10 ms recipe is fixed by the model — brosoundml's header says so —
/// and handing `SourceAudio` anything else would be resampling into a front-end
/// that then resamples again.
constexpr int kRate = 16000;

/// One encoder window, in seconds. Also fixed by the model: the encoder takes
/// exactly 3000 log-mel frames, so a shorter span is padded and a longer one is
/// truncated. This being the model's own unit is what makes windowing here a
/// natural division rather than a chunking compromise — there is no boundary
/// artefact to trade against, because the boundary is where the model's is.
constexpr double kWindowSec = 30.0;

/// Timestamp tokens are on a 0.02 s grid — `0.02 * (id - firstTimestampId)`.
/// Whisper's own resolution, stated once.
constexpr double kStampStep = 0.02;

/// A model directory, loaded once and kept. large-v3 is 3 GB of weights and
/// about six seconds to place on the GPU, so reloading per run would be six
/// seconds and a 3 GB churn every time somebody transcribed a second clip.
///
/// Keyed by directory so two model sizes can be held at once, which is what a
/// user comparing them does. Never evicted: the alternative is a policy about
/// when 3 GB of VRAM stops being wanted, and the honest answer is that the user
/// who loaded a model is the one who knows.
struct Loaded {
    std::shared_ptr<brosoundml::Whisper> model;
    std::shared_ptr<brolm::whisper::Tokenizer> tok;
};

std::mutex& modelsLock() {
    static std::mutex m;
    return m;
}

std::map<std::string, Loaded>& models() {
    static std::map<std::string, Loaded> m;
    return m;
}

bool fileThere(const std::string& p) {
    FILE* f = std::fopen(p.c_str(), "rb");
    if (!f) return false;
    std::fclose(f);
    return true;
}

/// Load, or hand back what is already loaded. `err` is filled in and the result
/// is empty on failure — **by name**, because a transcription that quietly does
/// nothing is worse than one that says the weights are not there.
Loaded loadModel(const TranscribeOptions& opts, std::string& err) {
    if (opts.modelDir.empty()) {
        err = "no model directory was given";
        return {};
    }

    std::lock_guard<std::mutex> guard(modelsLock());
    auto it = models().find(opts.modelDir);
    if (it != models().end()) return it->second;

    // Named individually. "could not load the model" sends somebody to the
    // wrong place four times out of five.
    const std::string cfg = opts.modelDir + "/config.json";
    const std::string wts = opts.modelDir + "/model.safetensors";
    const std::string voc = opts.modelDir + "/vocab.json";
    const std::string mrg = opts.modelDir + "/merges.txt";
    for (const auto* p : {&cfg, &wts, &voc, &mrg}) {
        if (!fileThere(*p)) {
            err = "there is no '" + *p + "' — run brosoundml's "
                  "scripts/download-whisper.sh to put a model there";
            return {};
        }
    }
    // Upstream openai/whisper-* keeps the ~1600 "<|...|>" specials out of
    // vocab.json; brolm merges them when told where they are. Optional, because
    // an already-merged vocab is the older converted layout.
    std::string added = opts.modelDir + "/added_tokens.json";
    if (!fileThere(added)) added.clear();

    Loaded out;
    try {
        brotensor::init();
        out.tok = std::make_shared<brolm::whisper::Tokenizer>(
            brolm::whisper::Tokenizer::load(voc, mrg, added));
        out.model = std::make_shared<brosoundml::Whisper>();
        out.model->load(opts.modelDir, analysisDeviceFor(opts.device));
    } catch (const std::exception& e) {
        err = std::string("the model would not load: ") + e.what();
        return {};
    }
    if (out.tok->first_timestamp_id() < 0) {
        err = "this vocabulary has no timestamp tokens, so nothing read from it "
              "could be placed in time";
        return {};
    }

    models()[opts.modelDir] = out;
    return out;
}

/// Turn one window's token ids into segments on the **input's** clock.
///
/// Whisper's shape here is `<|start|> words <|end|> <|start|> words <|end|>`,
/// and it is not reliably paired — a window can end mid-phrase with an opening
/// stamp and no closing one. So a stamp opens a segment when none is open and
/// closes the open one otherwise, and an unclosed segment at the end of a window
/// is closed at the window's end rather than dropped. Dropping it would lose the
/// last phrase of every window, which is one in every thirty seconds.
void segmentsFrom(const std::vector<int32_t>& ids,
                  const brolm::whisper::Tokenizer& tok,
                  double windowStart, double windowEnd,
                  Transcript& into) {
    const int firstTs = tok.first_timestamp_id();
    const int eos = tok.eos_id();

    bool open = false;
    double start = windowStart;
    std::vector<int32_t> words;

    /// Close what is open, if it says anything. A segment of pure whitespace is
    /// what a window of silence produces and is not worth a row.
    auto close = [&](double end) {
        if (!open) return;
        open = false;
        if (words.empty()) return;
        std::string text = tok.decode(words, /*skip_special=*/true);
        words.clear();
        const size_t a = text.find_first_not_of(" \t\r\n");
        if (a == std::string::npos) return;
        const size_t b = text.find_last_not_of(" \t\r\n");
        text = text.substr(a, b - a + 1);

        if (static_cast<int>(into.segments.size()) >= kMaxSegments) {
            into.truncated = true;
            ++into.total;
            return;
        }
        TranscriptSegment seg;
        seg.start = start;
        // Clamped, because a decoder that emits a stamp past its own window is
        // describing audio it was not given.
        seg.end = std::min(std::max(end, start), windowEnd);
        seg.text = std::move(text);
        into.segments.push_back(std::move(seg));
        ++into.total;
    };

    for (const int32_t id : ids) {
        if (firstTs >= 0 && id >= firstTs) {
            const double at = std::min(windowStart + kStampStep * (id - firstTs),
                                       windowEnd);
            if (open) close(at);
            else { start = at; open = true; }
            continue;
        }
        // Every Whisper special sits at or above <|endoftext|> — the regular
        // byte-level BPE occupies [0, eos_id) and the specials are appended
        // above it in one block (eos, sot, the 99 language tags, the two tasks,
        // <|notimestamps|>, then the 1501 timestamps). So this is the whole
        // test, and it is why nothing here enumerates a language tag. A special
        // that is not a timestamp — the prompt prefix, a <|nospeech|> — has
        // nothing to say and nothing to time.
        if (eos >= 0 && id >= eos) continue;
        if (!open) { start = windowStart; open = true; }
        words.push_back(id);
    }
    close(windowEnd);
}

/// The partial transcript a running entry publishes. Held by the worker and by
/// `transcribeProgress` both, which is the whole reason it is separate from
/// `AsyncOpens`' result: that only becomes readable once the thread is done, and
/// a transcript nobody may read until the end is a transcript nobody can search
/// while it is being made.
struct Live {
    std::mutex m;
    Transcript t;
    std::string err;
};

std::mutex& livesLock() {
    static std::mutex m;
    return m;
}

std::map<uint64_t, std::shared_ptr<Live>>& lives() {
    static std::map<uint64_t, std::shared_ptr<Live>> m;
    return m;
}

AsyncOpens<Transcript>& runs() {
    static AsyncOpens<Transcript> t;
    return t;
}

/// The work itself. One sequential walk of the soundtrack, one window at a time.
Transcript runTranscribe(const MediaInput& in, const TranscribeOptions& opts,
                         const std::shared_ptr<Live>& live, OpenWatch* watch) {
    auto fail = [&](const std::string& why) {
        std::lock_guard<std::mutex> g(live->m);
        live->err = why;
        return live->t;
    };

    std::string err;
    const Loaded loaded = loadModel(opts, err);
    if (!loaded.model) return fail(err);

    // Speed is 1.0 and is not a parameter, for `sound_marks.cpp`'s reason: a
    // segment belongs to the *input*, and a clip's speed is applied on the way
    // to the timeline by `timelineTime`, once, in `ui/project.js`.
    SourceAudio src;
    if (!src.open(in, kRate, 1, 1.0))
        return fail("there is no sound in this input to transcribe");

    {
        std::lock_guard<std::mutex> g(live->m);
        live->t.streamIndex = src.stream();
    }

    // Taken here rather than around the whole run: the decode that feeds the
    // model is libav's and contends with nothing, and a marks read queued behind
    // a ninety-minute transcription must not wait on its demuxer too. See
    // `analysisLock`.
    std::lock_guard<std::mutex> serialise(analysisLock());
    // The deadline covers this run's own work, not its wait behind another —
    // `readSoundMarks` re-arms for the same reason.
    if (watch) watch->expireIn(kTranscribeTimeoutSec);

    std::vector<int32_t> prompt;
    try {
        prompt = loaded.tok->build_prompt(opts.language,
                                          opts.translate ? "translate" : "transcribe",
                                          /*with_timestamps=*/true);
    } catch (const std::exception& e) {
        return fail(std::string("that is not a language this model knows: ") + e.what());
    }

    brosoundml::Whisper::TranscribeOptions wopts;
    // Not optional. Without it the decoder may answer <|notimestamps|> and the
    // whole window loses its timings — transcribe.h says why at length.
    wopts.no_timestamps_id = loaded.tok->no_timestamps_id();
    wopts.cancel = [watch] { return watch && (watch->stopped() || watch->expired()); };

    // The engine drives the windows and asks this for the samples of each.
    //
    // **Whisper's windows overlap**, and that is the shape this has to serve:
    // each one begins at the last timestamp the window before it emitted, which
    // is normally a few seconds short of a full thirty. So a *backward* ask is
    // the ordinary case rather than the exception, and the seek is real — about
    // one per window, six or seven hundred over a six-hour recording. That is
    // cheap against seven seconds of GPU per window, and it is why the reader
    // handed to brosoundml has to be seekable at all.
    //
    // `pos` is where the decoder actually is, so an ask that happens to be
    // exactly there costs nothing, and a *forward* ask is read through and
    // discarded rather than seeked — a short skip is one decode of a second or
    // two, where a seek would throw away the resampler's tail for the same span.
    size_t pos = 0;
    std::vector<float> skip;
    auto reader = [&](size_t from, float* dst, size_t frames) -> size_t {
        if (from != pos) {
            if (from < pos) {
                src.seekTo(static_cast<double>(from) / kRate);
                pos = from;
            } else {
                skip.resize(static_cast<size_t>(kRate));   // a second at a time
                while (pos < from) {
                    const size_t want = std::min<size_t>(skip.size(), from - pos);
                    const int got = src.mixInto(skip.data(), static_cast<int>(want), 1.0f);
                    if (got <= 0) return 0;
                    pos += static_cast<size_t>(got);
                }
            }
        }
        const int got = src.mixInto(dst, static_cast<int>(frames), 1.0f);
        if (got <= 0) return 0;
        pos += static_cast<size_t>(got);
        return static_cast<size_t>(got);
    };

    const double dur = src.duration();
    if (!(dur > 0.0))
        return fail("this input does not say how long its sound is, so it cannot "
                    "be walked a window at a time");
    const size_t totalSamples = static_cast<size_t>(dur * kRate);
    {
        std::lock_guard<std::mutex> g(live->m);
        live->t.duration = dur;
    }

    // Progressive completion, which is the whole point of the feature: a window
    // mark lands before that window's tokens, so the segments of everything read
    // so far are published as each window finishes rather than at the end. A
    // six-hour recording is searchable seconds after it starts.
    double windowStart = 0.0;
    std::vector<int32_t> pending;
    auto flush = [&](double end) {
        if (pending.empty()) return;
        std::lock_guard<std::mutex> g(live->m);
        segmentsFrom(pending, *loaded.tok, windowStart, end, live->t);
        live->t.read = std::max(live->t.read, std::min(end, dur));
        pending.clear();
    };
    wopts.timestamp_begin_id = loaded.tok->first_timestamp_id();
    wopts.on_window = [&](double start) {
        flush(std::min(start, dur));
        windowStart = start;
    };
    wopts.on_token = [&](int32_t id) { pending.push_back(id); };

    try {
        loaded.model->transcribe(reader, totalSamples, kRate, prompt, wopts);
    } catch (const std::exception& e) {
        return fail(std::string("the transcription failed: ") + e.what());
    }

    // **A stopped run does not claim to have read to the end**, and this is the
    // one place that could quietly say otherwise. `read` is what a search over
    // this transcript is honest about — a caller shows "only the first 12 min of
    // 6 h" from it — so rounding it up to the duration because the call returned
    // would turn a partial answer into a complete-looking one. The last window
    // that actually decoded is as far as this got.
    const bool gaveUp = watch && (watch->stopped() || watch->expired());
    flush(gaveUp ? std::max(windowStart, live->t.read) : dur);

    std::lock_guard<std::mutex> g(live->m);
    if (!gaveUp) live->t.read = dur;
    return live->t;
}

} // namespace

uint64_t startTranscribe(const MediaInput& in, const TranscribeOptions& opts) {
    auto live = std::make_shared<Live>();
    const uint64_t id = runs().start(
        [in, opts, live](OpenWatch* watch) {
            return runTranscribe(in, opts, live, watch);
        },
        kTranscribeTimeoutSec);
    if (!id) return 0;

    std::lock_guard<std::mutex> guard(livesLock());
    lives()[id] = live;
    return id;
}

bool transcribeProgress(uint64_t id, TranscribeProgress& out) {
    std::shared_ptr<Live> live;
    {
        std::lock_guard<std::mutex> guard(livesLock());
        auto it = lives().find(id);
        if (it != lives().end()) live = it->second;
    }

    AsyncOpens<Transcript>::Slot slot;
    if (!runs().look(id, &slot)) {
        // `look` erases a finished entry, so an id polled twice past the end is
        // unknown to `runs()` while its transcript is still here. Answering with
        // the transcript is what a caller that polls on a frame loop needs; the
        // alternative is a completed read that vanishes on the frame after it
        // completed.
        if (!live) return false;
        std::lock_guard<std::mutex> g(live->m);
        out.state = live->err.empty() ? TranscribeProgress::State::Done
                                      : TranscribeProgress::State::Failed;
        out.error = live->err;
        out.transcript = live->t;
        return true;
    }

    out.elapsed = slot.elapsed;
    out.timeout = slot.timeout;
    if (live) {
        std::lock_guard<std::mutex> g(live->m);
        out.transcript = live->t;
        out.error = live->err;
    }

    if (!slot.finished) {
        out.state = TranscribeProgress::State::Reading;
        return true;
    }
    out.transcript = slot.result;
    out.state = slot.stopped        ? TranscribeProgress::State::Stopped
                : out.error.empty() ? TranscribeProgress::State::Done
                                    : TranscribeProgress::State::Failed;
    return true;
}

void stopTranscribe(uint64_t id) { runs().stop(id); }

void abandonTranscribe(uint64_t id) {
    runs().abandon(id);
    std::lock_guard<std::mutex> guard(livesLock());
    lives().erase(id);
}

} // namespace ffmpegbro
