// The word-by-word transcription loop. The reasoning, and every decision it
// embodies, is at the top of spoken_words.h; this file is the mechanism.

#include "spoken_words.h"

#include "analysis_device.h"
#include "async_open.h"
#include "export_source.h"
#include "sound_marks.h"     // analysisLock()

#include <brolm/tokenizer_t5.h>
#include <brosoundml/audio.h>
#include <brosoundml/parakeet.h>
#include <brotensor/runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ffmpegbro {
namespace {

/// A model directory, loaded once and kept. Parakeet-0.6b is about 2.4 GB on the
/// card and several seconds to place there, so reloading per recording would be
/// that again for every VOD in a channel — which is exactly the shape of the
/// batch this exists for. Keyed by directory so two model sizes can be held at
/// once. Never evicted, for `transcribe.cpp`'s reason: the alternative is a
/// policy about when VRAM stops being wanted, and the user who loaded a model is
/// the one who knows.
struct Loaded {
    std::shared_ptr<brosoundml::Parakeet> model;
    std::shared_ptr<brolm::t5::Tokenizer> tok;
    double frameSeconds = 0.08;
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
Loaded loadModel(const SpokenWordsOptions& opts, std::string& err) {
    if (opts.modelDir.empty()) {
        err = "no model directory was given";
        return {};
    }

    std::lock_guard<std::mutex> guard(modelsLock());
    auto it = models().find(opts.modelDir);
    if (it != models().end()) return it->second;

    // Named individually. "could not load the model" sends somebody to the wrong
    // place four times out of five.
    const std::string cfg = opts.modelDir + "/config.json";
    const std::string wts = opts.modelDir + "/model.safetensors";
    const std::string tkn = opts.modelDir + "/tokenizer.json";
    for (const auto* p : {&cfg, &wts, &tkn}) {
        if (!fileThere(*p)) {
            err = "there is no '" + *p + "' — run brosoundml's "
                  "scripts/download-parakeet.sh to put a model there";
            return {};
        }
    }

    Loaded out;
    try {
        brotensor::init();
        // **The file, not the directory.** `Tokenizer::load` takes
        // `tokenizer.json` itself where `Parakeet::load` takes the directory
        // holding it — a real asymmetry in the API that reads as a typo until it
        // throws, and `tools/speech.js` says the same thing about the JS pair.
        out.tok = std::make_shared<brolm::t5::Tokenizer>(
            brolm::t5::Tokenizer::load(tkn));
        out.model = std::make_shared<brosoundml::Parakeet>();
        out.model->load(opts.modelDir, analysisDeviceFor(opts.device));
    } catch (const std::exception& e) {
        err = std::string("the model would not load: ") + e.what();
        return {};
    }
    out.frameSeconds = out.model->config().frame_seconds();

    models()[opts.modelDir] = out;
    return out;
}

/// Where a word begins is only visible to the tokenizer, so ask it.
///
/// **Parakeet's vocabulary is SentencePiece and the obvious reading does not
/// work.** Decoding each id on its own and splitting on the leading `▁` fails
/// because decoding *one* id strips the marker: "And" and "so" come back bare
/// and are indistinguishable from "coun" and "try". The boundary survives only in
/// the detokenization of a *run*, where `decode([And, so])` is "And so" and
/// `decode([coun, try])` is "country".
///
/// So the sequence is decoded prefix by prefix and each token is credited with
/// whatever it *appended*: a piece arriving with a leading space starts a word,
/// one that does not continues the word before it. That is the tokenizer's own
/// rule rather than a second implementation of it, which is the only way this
/// cannot drift from the model. Getting it wrong is not subtle in its effect and
/// is very subtle to see: every token joined into one "word", and ten minutes of
/// speech coming out as two of them. `tools/speech.js` learned this the same way
/// and its `wordsOf` is where this walk came from.
///
/// `base` is where the decoded buffer starts on the input's clock. Only words
/// whose *start* lands in [`keepFrom`, `keepTo`) are kept, which is what makes a
/// word straddling a window boundary whole in exactly one window and counted
/// once.
void wordsFrom(const brosoundml::Parakeet::Transcription& res,
               const brolm::t5::Tokenizer& tok, double frameSeconds,
               double base, double keepFrom, double keepTo, SpokenWords& into) {
    const size_t n = std::min(res.token_ids.size(), res.token_frames.size());

    std::vector<int32_t> prefix;
    std::string sofar;
    std::string word;
    double wordAt = 0.0;

    /// Close the word being built and keep it if it began in this window.
    auto flush = [&](double endsAt) {
        if (word.empty()) return;
        std::string text;
        text.swap(word);
        if (!(wordAt >= keepFrom && wordAt < keepTo)) return;
        if (static_cast<int>(into.words.size()) >= kMaxWords) {
            into.truncated = true;
            ++into.total;
            return;
        }
        SpokenWord w;
        w.start = wordAt;
        w.end = std::max(endsAt, wordAt);
        w.text = std::move(text);
        into.words.push_back(std::move(w));
        ++into.total;
    };

    for (size_t i = 0; i < n; i++) {
        prefix.push_back(res.token_ids[i]);
        const std::string grown = tok.decode(prefix);
        // A decode that came back shorter than the one before it is not a thing
        // the tokenizer should do; treated as "this token appended nothing"
        // rather than trusted into a substr that would throw.
        if (grown.size() < sofar.size()) { sofar = grown; continue; }
        const std::string piece = grown.substr(sofar.size());
        sofar = grown;
        if (piece.empty()) continue;

        const double at = base + res.token_frames[i] * frameSeconds;
        const bool starts = piece[0] == ' ' || piece[0] == '\t' ||
                            piece[0] == '\r' || piece[0] == '\n';
        if (starts || word.empty()) {
            flush(at);
            wordAt = at;
            const size_t a = piece.find_first_not_of(" \t\r\n");
            const size_t b = piece.find_last_not_of(" \t\r\n");
            word = a == std::string::npos ? std::string() : piece.substr(a, b - a + 1);
        } else {
            word += piece;
        }
    }
    flush(base + (n ? res.token_frames[n - 1] * frameSeconds : 0.0));
}

/// The partial transcript a running entry publishes. Held by the worker and by
/// `spokenWordsProgress` both, which is why it is separate from `AsyncOpens`'
/// result: that only becomes readable once the thread is done, and words nobody
/// may read until the end are words nobody can search while they are being made.
struct Live {
    std::mutex m;
    SpokenWords t;
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

AsyncOpens<SpokenWords>& runs() {
    static AsyncOpens<SpokenWords> t;
    return t;
}

/// The work itself. One forward walk of the soundtrack, one window at a time.
SpokenWords runWords(const MediaInput& in, const SpokenWordsOptions& opts,
                     const std::shared_ptr<Live>& live, OpenWatch* watch) {
    auto fail = [&](const std::string& why) {
        std::lock_guard<std::mutex> g(live->m);
        live->err = why;
        return live->t;
    };

    // **The soundtrack is opened before the model is loaded**, which is the
    // opposite order to `transcribe.cpp` and is the right one: placing 2.4 GB of
    // weights on the card is seconds, and a file with nothing to transcribe can
    // be refused in milliseconds. Whichever comes first is what a caller hears
    // about, and "there is no sound in this" is the more immediate truth about a
    // file somebody just pointed at.
    //
    // Speed is 1.0 and is not a parameter, for `sound_marks.cpp`'s reason: a
    // word belongs to the *input*, and a clip's speed is applied on the way to
    // the timeline by `timelineTime`, once, in `ui/project.js`.
    SourceAudio src;
    if (!src.open(in, kWordsRate, 1, 1.0))
        return fail("there is no sound in this input to transcribe");

    {
        std::lock_guard<std::mutex> g(live->m);
        live->t.streamIndex = src.stream();
    }

    std::string err;
    const Loaded loaded = loadModel(opts, err);
    if (!loaded.model) return fail(err);

    // Taken here rather than around the whole run, exactly as `transcribe.cpp`
    // does: the decode that feeds the model is libav's and contends with
    // nothing, and a marks read queued behind half an hour of this must not wait
    // on its demuxer too. See `analysisLock`.
    std::lock_guard<std::mutex> serialise(analysisLock());
    // The deadline covers this run's own work, not its wait behind another.
    if (watch) watch->expireIn(kWordsTimeoutSec);

    const double dur = src.duration();
    if (!(dur > 0.0))
        return fail("this input does not say how long its sound is, so it cannot "
                    "be walked a window at a time");
    {
        std::lock_guard<std::mutex> g(live->m);
        live->t.duration = dur;
    }

    brosoundml::Parakeet::TranscribeOptions popts;
    popts.max_new_tokens = 0;   // decode the whole window
    // Polled once per encoder frame advance by Parakeet's own greedy loop, so a
    // cancel is real inside the decode and not only between windows.
    popts.cancel = [watch] { return watch && (watch->stopped() || watch->expired()); };

    // **A rolling buffer rather than a seek per window.** The windows advance by
    // `kWordsWindowSec` and each is decoded with `kWordsOverlapSec` of its
    // neighbours, so consecutive reads overlap by twice the padding and every
    // ask is forward. Keeping the tail costs 3 s of mono 16 kHz — 192 kB — and
    // saves one seek per window, which over five hours is 1200 of them.
    //
    // `held` is where `buf` begins, in frames from the start of the soundtrack.
    std::vector<float> buf;
    size_t held = 0;
    bool ended = false;
    const auto frameAt = [](double seconds) {
        return static_cast<size_t>(std::max(0.0, seconds) * kWordsRate);
    };
    const auto pullTo = [&](size_t want) {
        while (!ended && held + buf.size() < want) {
            const size_t before = buf.size();
            buf.resize(before + kWordsRate);        // a second at a time
            const int got = src.mixInto(buf.data() + before, kWordsRate, 1.0f);
            if (got <= 0) { buf.resize(before); ended = true; break; }
            buf.resize(before + static_cast<size_t>(got));
        }
    };

    const auto gaveUp = [&] { return watch && (watch->stopped() || watch->expired()); };

    for (double winAt = 0.0; winAt < dur; winAt += kWordsWindowSec) {
        if (gaveUp()) break;

        const double winTo = std::min(dur, winAt + kWordsWindowSec);
        const double from = std::max(0.0, winAt - kWordsOverlapSec);
        const double to = std::min(dur, winTo + kWordsOverlapSec);

        pullTo(frameAt(to));
        const size_t a = std::max(frameAt(from), held);
        const size_t b = std::min(frameAt(to), held + buf.size());
        // The soundtrack ran out before the container said it would. Not an
        // error — a file's declared duration is a report — and the words read so
        // far are kept, with `read` saying how far this actually got.
        if (b <= a) break;

        brosoundml::AudioBuffer audio(
            std::vector<float>(buf.begin() + static_cast<ptrdiff_t>(a - held),
                               buf.begin() + static_cast<ptrdiff_t>(b - held)),
            kWordsRate);

        brosoundml::Parakeet::Transcription res;
        try {
            res = loaded.model->transcribe(audio, popts);
        } catch (const std::exception& e) {
            return fail(std::string("the transcription failed: ") + e.what());
        }

        {
            std::lock_guard<std::mutex> g(live->m);
            wordsFrom(res, *loaded.tok, loaded.frameSeconds,
                      static_cast<double>(a) / kWordsRate, winAt, winTo, live->t);
            // **Published per window, which is the whole point of the feature.**
            // A caller polling this draws the bar from `read`/`duration` and can
            // search what has landed while the rest is still being read.
            if (!gaveUp()) live->t.read = std::max(live->t.read, winTo);
        }

        // Everything before the next window's own padding is never asked for
        // again, so it is dropped rather than grown into a buffer the length of
        // the recording.
        const size_t keep = frameAt(winAt + kWordsWindowSec - kWordsOverlapSec);
        if (keep > held) {
            const size_t drop = std::min(keep - held, buf.size());
            buf.erase(buf.begin(), buf.begin() + static_cast<ptrdiff_t>(drop));
            held += drop;
        }
        if (ended && held + buf.size() <= frameAt(winTo)) break;
    }

    // **A stopped run does not claim to have read to the end.** `read` is what a
    // search over these words is honest about — a caller says "only the first
    // twelve minutes of six hours" from it — so rounding it up to the duration
    // because the loop returned would turn a partial answer into a
    // complete-looking one. `transcribe.cpp` states the same rule.
    std::lock_guard<std::mutex> g(live->m);
    if (!gaveUp()) live->t.read = dur;
    return live->t;
}

} // namespace

uint64_t startSpokenWords(const MediaInput& in, const SpokenWordsOptions& opts) {
    auto live = std::make_shared<Live>();
    const uint64_t id = runs().start(
        [in, opts, live](OpenWatch* watch) { return runWords(in, opts, live, watch); },
        kWordsTimeoutSec);
    if (!id) return 0;

    std::lock_guard<std::mutex> guard(livesLock());
    lives()[id] = live;
    return id;
}

bool spokenWordsProgress(uint64_t id, SpokenWordsProgress& out) {
    std::shared_ptr<Live> live;
    {
        std::lock_guard<std::mutex> guard(livesLock());
        auto it = lives().find(id);
        if (it != lives().end()) live = it->second;
    }

    AsyncOpens<SpokenWords>::Slot slot;
    if (!runs().look(id, &slot)) {
        // `look` erases a finished entry, so an id polled twice past the end is
        // unknown to `runs()` while its words are still here. Answering with them
        // is what a caller polling on a frame loop needs; the alternative is a
        // completed read that vanishes on the frame after it completed. `forget`
        // is therefore required rather than tidy.
        if (!live) return false;
        std::lock_guard<std::mutex> g(live->m);
        out.state = live->err.empty() ? SpokenWordsProgress::State::Done
                                      : SpokenWordsProgress::State::Failed;
        out.error = live->err;
        out.result = live->t;
        return true;
    }

    out.elapsed = slot.elapsed;
    out.timeout = slot.timeout;
    if (live) {
        std::lock_guard<std::mutex> g(live->m);
        out.result = live->t;
        out.error = live->err;
    }

    if (!slot.finished) {
        out.state = SpokenWordsProgress::State::Reading;
        return true;
    }
    out.result = slot.result;
    out.state = slot.stopped        ? SpokenWordsProgress::State::Stopped
                : out.error.empty() ? SpokenWordsProgress::State::Done
                                    : SpokenWordsProgress::State::Failed;
    return true;
}

void stopSpokenWords(uint64_t id) { runs().stop(id); }

void abandonSpokenWords(uint64_t id) {
    runs().abandon(id);
    std::lock_guard<std::mutex> guard(livesLock());
    lives().erase(id);
}

} // namespace ffmpegbro
