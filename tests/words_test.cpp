// Reading speech word by word: does it refuse the right things, and are the
// words where they were said.
//
// **Most of this suite runs without a model on the disk, and that is deliberate.**
// The weights are not shipped (`spoken_words.h` says why) so a suite that needed
// them would be a suite nobody runs. What can be asserted with no model at all
// turns out to be most of what goes wrong: the recipe, and the two refusals.
//
// **The recipe is asserted so that changing it fails loudly.** `marks_test.cpp`
// does the same for bro's framing numbers and for the same reason. The window
// length, the padding and the rate decide where every word in every future
// transcript lands; a store built with one recipe and searched with another
// would not report an error, it would report the wrong second. These three
// numbers were measured — the block on `kWordsWindowSec` shows the working —
// so a change to them should be a change somebody made on purpose.
//
// **Both refusals are by name, and which one comes first is a decision.** A file
// with no soundtrack is refused before the model is loaded, because placing two
// and a half gigabytes on a card takes seconds and finding out there was nothing
// to read takes milliseconds. So pointing this at a picture-only file with a
// nonsense model path must complain about the *sound*, and pointing it at a real
// soundtrack with the same nonsense path must complain about the *model*. Get
// that order backwards and a user waits six seconds to be told something that
// was knowable at once.
//
// With a model and a recording, four more things are checked, and they are the
// ones only a real run can answer: that the words come out in order, that they
// land inside the recording, that `read` reaches the end, and that a cancelled
// run keeps what it read and says how far it got. That last one is the whole
// difference between this and a read that answers only at the end.
//
// Everything is skipped rather than failed when its fixture is absent, which is
// the property every suite here has.
//
// Usage: ffmpeg-bro-wordstest <silent.mp4> [<sound.m4a>] [<model-dir>] [<speech-file>]

#include "spoken_words.h"
#include "ffmpeg_input.h"

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

using namespace ffmpegbro;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
    ++checks;
    if (!ok) ++failures;
    std::printf("  %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
}

void checkf(bool ok, const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    check(ok, buf);
}

void section(const char* name) { std::printf("\n== %s ==\n", name); }

bool have(const std::string& p) {
    return !p.empty() && std::filesystem::exists(p);
}

MediaInput inputFor(const std::string& path) {
    MediaInput in;
    in.path = path;
    return in;
}

bool says(const std::string& haystack, const char* needle) {
    return haystack.find(needle) != std::string::npos;
}

/// Poll until the run is no longer reading, or until `limitSec` runs out.
///
/// A blocking wait is right here and nowhere in the application: this is the one
/// caller that has nothing to draw while it waits.
SpokenWordsProgress settle(uint64_t id, double limitSec) {
    const auto began = std::chrono::steady_clock::now();
    SpokenWordsProgress p;
    for (;;) {
        if (!spokenWordsProgress(id, p)) {
            p.state = SpokenWordsProgress::State::Failed;
            p.error = "the read was forgotten while it was being polled";
            return p;
        }
        if (p.state != SpokenWordsProgress::State::Reading) return p;
        const double waited = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - began).count();
        if (waited > limitSec) return p;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
                     "usage: %s <silent.mp4> [<sound.m4a>] [<model-dir>] "
                     "[<speech-file>]\n", argv[0]);
        return 2;
    }
    const std::string silent = argv[1];
    const std::string sound = argc > 2 ? argv[2] : "";
    const std::string modelDir = argc > 3 ? argv[3] : "";
    const std::string speech = argc > 4 ? argv[4] : "";

    section("the recipe");
    // Asserted, not described. See the top of this file.
    checkf(kWordsRate == 16000, "the model is fed 16 kHz (%d)", kWordsRate);
    checkf(kWordsWindowSec == 15.0,
           "a window is fifteen seconds (%.2f) — the length that was both "
           "fastest per second of audio and found the most words",
           kWordsWindowSec);
    checkf(kWordsOverlapSec == 1.5,
           "with one and a half seconds of padding either side (%.2f), so no "
           "word is cut in half by a boundary", kWordsOverlapSec);

    section("a file with no soundtrack is refused, before any model is loaded");
    if (!have(silent)) {
        std::printf("  -- skipped: no %s\n", silent.c_str());
    } else {
        SpokenWordsOptions opts;
        // Deliberately nonsense. The point of this section is that the sound is
        // what gets complained about even so.
        opts.modelDir = "no/such/model/on/this/disk";
        const uint64_t id = startSpokenWords(inputFor(silent), opts);
        checkf(id != 0, "the read starts (id %llu)", (unsigned long long)id);
        const SpokenWordsProgress p = settle(id, 30.0);
        check(p.state == SpokenWordsProgress::State::Failed,
              "and fails rather than answering with an empty list");
        checkf(says(p.error, "no sound"),
               "naming the sound and not the model: \"%s\"", p.error.c_str());
        abandonSpokenWords(id);
    }

    section("an absent model is refused by name");
    if (!have(sound)) {
        std::printf("  -- skipped: no %s\n", sound.c_str());
    } else {
        SpokenWordsOptions opts;
        opts.modelDir = "no/such/model/on/this/disk";
        const uint64_t id = startSpokenWords(inputFor(sound), opts);
        checkf(id != 0, "the read starts (id %llu)", (unsigned long long)id);
        const SpokenWordsProgress p = settle(id, 60.0);
        check(p.state == SpokenWordsProgress::State::Failed,
              "and fails once it has found the soundtrack it was asked to read");
        checkf(says(p.error, "no such/model") || says(p.error, "no/such/model"),
               "naming the file that is missing: \"%s\"", p.error.c_str());
        check(says(p.error, "download-parakeet"),
              "and saying what would put one there");
        abandonSpokenWords(id);
    }

    section("a poll after the end still answers");
    if (!have(silent)) {
        std::printf("  -- skipped: no %s\n", silent.c_str());
    } else {
        SpokenWordsOptions opts;
        opts.modelDir = "no/such/model/on/this/disk";
        const uint64_t id = startSpokenWords(inputFor(silent), opts);
        settle(id, 30.0);
        SpokenWordsProgress again;
        // The rule this surface breaks everywhere else, and the reason `forget`
        // is required rather than tidy: a caller polling on a frame loop must not
        // watch the answer vanish on the frame after it arrived.
        check(spokenWordsProgress(id, again),
              "a second poll of a finished read still answers");
        abandonSpokenWords(id);
        SpokenWordsProgress gone;
        check(!spokenWordsProgress(id, gone), "and nothing answers after forget");
    }

    section("a real recording, read to the end");
    if (!have(modelDir) || !have(speech)) {
        std::printf("  -- skipped: needs a Parakeet model directory and a "
                    "recording with speech in it\n");
    } else {
        SpokenWordsOptions opts;
        opts.modelDir = modelDir;
        const uint64_t id = startSpokenWords(inputFor(speech), opts);
        checkf(id != 0, "the read starts (id %llu)", (unsigned long long)id);
        // Generous: this is measured in the length of whatever file somebody
        // pointed at, at about 11x realtime with a card and far less without one.
        const SpokenWordsProgress p = settle(id, 3600.0);
        checkf(p.state == SpokenWordsProgress::State::Done,
               "and finishes (%s%s)",
               p.state == SpokenWordsProgress::State::Done ? "done" : "not done",
               p.error.empty() ? "" : (": " + p.error).c_str());

        const SpokenWords& t = p.result;
        checkf(!t.words.empty(), "with words in it (%zu)", t.words.size());
        checkf(t.duration > 0.0, "and a duration (%.1f s)", t.duration);
        checkf(t.read >= t.duration - 0.001,
               "and `read` reaching the end (%.1f of %.1f)", t.read, t.duration);

        // **In order, and inside the recording.** The windowing is the part of
        // this that could silently go wrong: a word kept by two windows, or one
        // credited to the buffer's start rather than the window's, would put a
        // word out of order or past the end while everything still looked like a
        // transcript.
        bool ordered = true;
        bool inside = true;
        double last = -1.0;
        for (const SpokenWord& w : t.words) {
            if (w.start < last - 0.001) ordered = false;
            if (w.start < -0.001 || w.start > t.duration + 0.001) inside = false;
            if (w.end < w.start - 0.001) inside = false;
            last = w.start;
        }
        check(ordered, "the words come out in order");
        check(inside, "and every one of them lands inside the recording");
        checkf(t.truncated || t.total == (int64_t)t.words.size(),
               "the count is the list when nothing was capped (%lld / %zu)",
               (long long)t.total, t.words.size());

        // **The tail, which is how a frame loop asks.** Whole-answer polling
        // costs more the longer the recording is — the list is copied and
        // rebuilt every time — so a caller says how many it holds. What must be
        // true of the answer: it begins where it says it begins, it is the same
        // words the whole answer had at those positions, and asking from past
        // the end is empty rather than an error.
        const std::size_t n = t.words.size();
        const std::vector<SpokenWord> whole = t.words;
        if (n >= 2) {
            const int64_t half = (int64_t)(n / 2);
            SpokenWordsProgress tail;
            check(spokenWordsProgress(id, tail, half), "a poll from a count answers");
            checkf(tail.from == half, "starting where it was asked (%lld)",
                   (long long)tail.from);
            checkf(tail.result.words.size() == n - (std::size_t)half,
                   "with the rest of the words (%zu of %zu)",
                   tail.result.words.size(), n);
            bool same = tail.result.words.size() == n - (std::size_t)half;
            for (std::size_t i = 0; same && i < tail.result.words.size(); ++i)
                same = tail.result.words[i].text == whole[(std::size_t)half + i].text;
            check(same, "and they are the words the whole answer had there");
            checkf(tail.result.read >= t.read - 0.001,
                   "the scalars are the whole read's, not the tail's (%.1f)",
                   tail.result.read);

            SpokenWordsProgress past;
            check(spokenWordsProgress(id, past, (int64_t)n + 1000),
                  "a poll from past the end answers");
            check(past.result.words.empty(), "with no words");
            checkf(past.from == (int64_t)n, "and `from` at the end (%lld / %zu)",
                   (long long)past.from, n);
        }
        abandonSpokenWords(id);
    }

    section("a cancelled read keeps what it read");
    if (!have(modelDir) || !have(speech)) {
        std::printf("  -- skipped: needs a Parakeet model directory and a "
                    "recording with speech in it\n");
    } else {
        SpokenWordsOptions opts;
        opts.modelDir = modelDir;
        const uint64_t id = startSpokenWords(inputFor(speech), opts);
        // Long enough for a window or two to land — the weights are resident
        // from the section above, so this is the decode rather than the load.
        // Short enough that a recording of any length is still being read.
        std::this_thread::sleep_for(std::chrono::milliseconds(1200));
        stopSpokenWords(id);
        const SpokenWordsProgress p = settle(id, 300.0);
        check(p.state == SpokenWordsProgress::State::Stopped ||
              p.state == SpokenWordsProgress::State::Done,
              "the run ends when it is asked to");

        // **Nothing beyond `read` is claimed, and that is the invariant rather
        // than "it stopped early".** A short enough file finishes every window
        // before the stop arrives and is then honestly complete — asserting that
        // a cancelled run must be *partial* would be asserting something about
        // the fixture rather than about the code. What has to hold either way is
        // that `read` bounds the answer: a caller says "only the first twelve
        // minutes of six hours" from it, and a word past that line would make
        // that sentence a lie.
        const SpokenWords& t = p.result;
        checkf(t.read <= t.duration + 0.001,
               "`read` never runs past the recording (%.1f of %.1f)",
               t.read, t.duration);
        bool within = true;
        for (const SpokenWord& w : t.words)
            if (w.start > t.read + 0.001) within = false;
        check(within, "and every word kept began at or before it");
        if (t.read < t.duration - 0.001)
            std::printf("  -- stopped %.1f s into %.1f s\n", t.read, t.duration);
        else
            std::printf("  -- the file was short enough to finish first\n");
        abandonSpokenWords(id);
    }

    std::printf("\n%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
