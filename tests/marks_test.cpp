// Finding things by sound: does it find the moment, and is it the right moment.
//
// The feature's whole value is that a mark is *where something is*, so almost
// everything here is an assertion about a number of seconds. The fixture
// (`writeMarkable` in tests/make_fixture.cpp) is the only soundtrack in this
// repository in which anything happens: transients at 1, 3 and 5 seconds and a
// 1000 Hz tone from 6.0 to 7.5, over a bed too quiet to be either. Against a
// continuous tone — which is every other fixture here — a detector that reported
// nothing and a detector that was never called would be the same result.
//
// Four things are asserted, and they are of different kinds.
//
// **The events are where they were put.** Each of the three transients has an
// onset within a tolerance, and the tolerance is stated rather than tuned: the
// analysis window is 25 ms and `SoundMark::at` is deliberately its *start*, and
// the fixture goes through an AAC encoder whose own transform is 1024 samples,
// so 120 ms is generous over both and still an order of magnitude under the two
// seconds between the clicks. A detector off by a whole click would pass a
// looser check and fail this one.
//
// **The tone is a tone, and it is 1000 Hz.** The dominant frequency is the one
// number here that is a real physical measurement rather than a flag, and it is
// the one an over-claiming implementation would get wrong while still producing
// a plausible-looking run.
//
// **The bed is not an event.** Two seconds of near-silence after the tone, and
// nothing may be reported in it. A detector that marks everything is useless in
// exactly the way a detector that marks nothing is, and only a file with a known
// quiet stretch can tell those apart.
//
// **A file with no sound in it is a refusal, not an empty answer.** The same
// distinction the whole surface draws: nothing found and nothing to look at are
// different facts.
//
// Everything is skipped rather than failed when its fixture is absent, which is
// the property every suite here has.
//
// Usage: ffmpeg-bro-markstest <marks.m4a> [<silent.mp4>] [<sound.m4a>]

#include "sound_marks.h"
#include "ffmpeg_input.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <string>
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

std::vector<SoundMark> ofKind(const SoundMarks& m, MarkKind k) {
    std::vector<SoundMark> out;
    for (const SoundMark& x : m.marks)
        if (x.kind == k) out.push_back(x);
    return out;
}

/// The mark of this kind nearest `t`, or null. What "found it" means: not that
/// the list is exactly three long — an encoder's pre-echo may legitimately ring
/// a second time — but that each thing put in the file has a mark near it.
const SoundMark* nearest(const std::vector<SoundMark>& v, double t) {
    const SoundMark* best = nullptr;
    for (const SoundMark& m : v)
        if (!best || std::fabs(m.at - t) < std::fabs(best->at - t)) best = &m;
    return best;
}

/// How far a mark may be from the moment it is about.
///
/// 120 ms, and the number is arithmetic rather than a tuning: the sensor's
/// analysis window is 25 ms (`win` 400 at 16 kHz), a mark is stamped at the
/// window's start so it can land early rather than late, and the fixture is
/// AAC — a 1024-sample transform at 48 kHz is another 21 ms, with the encoder's
/// own priming on top. Everything here is spaced two seconds apart, so this is
/// a sixteenth of the distance to the wrong answer.
constexpr double kNear = 0.12;

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
                     "usage: %s <marks.m4a> [<silent.mp4>] [<sound.m4a>]\n", argv[0]);
        return 2;
    }
    const std::string fixture = argv[1];
    const std::string silent = argc >= 3 ? argv[2] : std::string();
    const std::string tone = argc >= 4 ? argv[3] : std::string();

    if (!have(fixture)) {
        std::printf("  %s is not there — skipping everything about a soundtrack\n",
                    fixture.c_str());
        std::printf("\n%d checks, %d failed\n", checks, failures);
        return failures == 0 ? 0 : 1;
    }

    section("reading a whole soundtrack");
    const auto began = std::chrono::steady_clock::now();
    const SoundMarks m = readSoundMarks(inputFor(fixture), {});
    const double took =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();

    check(m.ok, "the read finished: " + (m.ok ? std::string("yes") : m.error));
    if (!m.ok) {
        std::printf("\n%d checks, %d failed\n", checks, failures);
        return 1;
    }

    // Reported rather than asserted. The measurement that decided this feature
    // is native — ~58x realtime for the DSP alone — is bro's, taken through
    // `bro.sense.analyze`; what this prints is the whole thing including the
    // decode, on this machine, so that a change that made it ten times slower
    // is visible in the log even though no threshold could be portable.
    std::printf("  %.1f s of sound in %.0f ms (%.0fx realtime, decode included)\n",
                m.t1 - m.t0, took * 1000.0, took > 0 ? (m.t1 - m.t0) / took : 0.0);

    // The front-end is brosoundml's and is reported rather than assumed, so a
    // change to bro's default recipe shows up here as a failing assertion
    // rather than as marks that quietly moved. These three numbers are the ones
    // the framing loop in sound_marks.cpp shares with bro's `js_analyze`.
    checkf(m.rate == 16000 && m.win == 400 && m.hop == 160,
           "the front-end is %d Hz, win %d, hop %d — the recipe the framing loop "
           "is written against", m.rate, m.win, m.hop);
    checkf(m.t1 > 9.0 && m.t1 < 10.0,
           "and it reached %.2f s, which is the length of the fixture", m.t1);
    checkf(m.streamIndex >= 0, "it says which stream it read: %d", m.streamIndex);

    // The whole list, in the log. A failure below is usually about *which* mark
    // was nearest something, and that is unreadable without seeing them all.
    for (const SoundMark& x : m.marks)
        std::printf("      %-5s at %6.3f  len %5.3f  %6.1f dB  %6.1f Hz  per %.2f  "
                    "flux %.3f\n",
                    x.kind == MarkKind::Onset   ? "onset"
                    : x.kind == MarkKind::Tonal ? "tonal"
                                                : "sound",
                    x.at, x.length, double(x.db), double(x.hz),
                    double(x.periodicity), double(x.flux));

    section("the transients are where they were put");
    const std::vector<SoundMark> onsets = ofKind(m, MarkKind::Onset);
    checkf(!onsets.empty(), "there are onsets at all: %d of them", int(onsets.size()));
    for (double at : { 1.0, 3.0, 5.0 }) {
        const SoundMark* n = nearest(onsets, at);
        if (!n) {
            checkf(false, "nothing at all near the transient at %.0f s", at);
            continue;
        }
        checkf(std::fabs(n->at - at) <= kNear,
               "the transient at %.0f s is marked at %.3f s (%.0f ms out, %.0f ms "
               "allowed)", at, n->at, (n->at - at) * 1000.0, kNear * 1000.0);
        // An onset carries the measurement it *is*. Reported so that "this is a
        // spectral-flux transient" is something an interface can show rather
        // than only assert.
        checkf(n->flux > 1.0,
               "and it carries the flux that made it: %.3f — an order of magnitude "
               "over the start-up marks below", double(n->flux));
        checkf(n->length == 0.0, "and it is an instant, not a run");
    }

    section("the first half-second is where the flux baseline is being built");
    // Not a bug and not filtered out. The onset sensor compares each frame's
    // flux to a slow EMA of it, and that EMA is initialised at zero with a
    // ~0.5 s time constant — so early frames beat "2.5x the baseline" trivially
    // and only `onset_abs` holds them back. This is bro's detector run exactly
    // as `bro.sense.analyze` runs it, and a warm-up window applied here would
    // make the two disagree about the same file, which is the one divergence
    // this feature must not have. What is asserted is that the marks it
    // produces are *distinguishable*: they carry a flux near the floor, and
    // nothing here is going to mistake one for a gunshot.
    int early = 0;
    double earlyMax = 0.0;
    for (const SoundMark& x : onsets)
        if (x.at < 0.5) { ++early; earlyMax = std::max(earlyMax, double(x.flux)); }
    checkf(earlyMax < 1.0,
           "the %d start-up onset(s) peak at flux %.3f, against the ~3.5 of a real "
           "transient", early, earlyMax);

    section("the tone is a tone, and it is the frequency it was written at");
    const std::vector<SoundMark> tonal = ofKind(m, MarkKind::Tonal);
    checkf(!tonal.empty(), "there is a tonal run: %d of them", int(tonal.size()));
    const SoundMark* run = nearest(tonal, 6.0);
    if (run) {
        checkf(std::fabs(run->at - 6.0) <= kNear,
               "it starts at %.3f s against 6.000", run->at);
        checkf(run->length > 1.0 && run->length < 1.9,
               "and lasts %.3f s against the 1.5 it was written for", run->length);
        // The one number here that is a physical measurement rather than a
        // flag. 5%% of 1000 Hz is 50 Hz, which is far under the distance to any
        // harmonic or subharmonic of anything else in the file — so this
        // separates "found the tone" from "locked onto something".
        checkf(std::fabs(run->hz - 1000.0) <= 50.0,
               "and its dominant frequency is %.0f Hz against the 1000 written",
               double(run->hz));
        checkf(run->periodicity >= 0.6 && run->periodicity <= 1.0,
               "and its periodicity is %.2f, which is the run's own evidence",
               double(run->periodicity));
    }

    section("the quiet bed is not an event");
    // Everything in the file is over by 7.5 s and there are two seconds of bed
    // after it. A detector that marks everything is as useless as one that marks
    // nothing, and only a known-quiet stretch tells the two apart.
    int inTheQuiet = 0;
    for (const SoundMark& x : m.marks)
        if (x.at > 7.7) ++inTheQuiet;
    checkf(inTheQuiet == 0,
           "nothing is reported after 7.7 s, where the file is a -60 dBFS bed "
           "(found %d)", inTheQuiet);

    section("the totals are exact even when the list is not");
    checkf(m.onsets >= int64_t(onsets.size()),
           "the onset total (%lld) is at least what was kept (%d) — it is counted "
           "before the minimum run length and before the cap",
           static_cast<long long>(m.onsets), int(onsets.size()));
    check(!m.truncated, "and nothing was truncated at this length");

    section("marks come back in time order");
    bool ordered = true;
    for (size_t i = 1; i < m.marks.size(); ++i)
        if (m.marks[i].at < m.marks[i - 1].at) ordered = false;
    check(ordered, "every mark is at or after the one before it, whatever kind it is");

    section("the knobs reach the sensors");
    // Not "more marks appear", which would be a claim about a particular file's
    // content: what is asserted is that the option is *carried* — a pitch search
    // that starts above the tone cannot report it, which is a consequence the
    // file guarantees.
    SoundMarkOptions narrow;
    narrow.tonalFminHz = 2000.0f;
    narrow.tonalFmaxHz = 4000.0f;
    const SoundMarks above = readSoundMarks(inputFor(fixture), narrow);
    if (above.ok) {
        const std::vector<SoundMark> t2 = ofKind(above, MarkKind::Tonal);
        const SoundMark* r2 = nearest(t2, 6.0);
        const std::string what = r2 ? std::to_string(int(r2->hz)) + " Hz instead"
                                    : std::string("nothing at all");
        checkf(!r2 || std::fabs(r2->hz - 1000.0) > 50.0,
               "a pitch search starting at 2000 Hz does not report the 1000 Hz "
               "tone (%s)", what.c_str());
    }

    SoundMarkOptions onlyOnsets;
    onlyOnsets.wantTonal = false;
    onlyOnsets.wantSound = false;
    const SoundMarks justClicks = readSoundMarks(inputFor(fixture), onlyOnsets);
    if (justClicks.ok) {
        check(ofKind(justClicks, MarkKind::Tonal).empty() &&
                  ofKind(justClicks, MarkKind::Sound).empty(),
              "asking for onsets alone gives back onsets alone");
        checkf(justClicks.tonalRuns == m.tonalRuns,
               "and the tonal total is still counted (%lld), because what was "
               "turned off is what is *kept*",
               static_cast<long long>(justClicks.tonalRuns));
    }

    section("a window is a window");
    // **The input's `-ss` is a seek, and for this reader it was only ever a
    // subtraction.** `SourceAudio::open` moved the clock and left the demuxer at
    // the start of the file, and this reader walks a soundtrack from wherever the
    // reader is — so a window asked for at 2.4 s analysed everything from zero,
    // reported `t1` as `ss + t`, and put every `at` on the file's clock while
    // `t0` said nothing had been skipped. It was invisible for as long as
    // nothing asked for a window; `supercut/rhythm.js` asks for one per word, and
    // on a six-hour recording the old behaviour is hours of DSP for a second of
    // sound.
    //
    // The fixture's transients are at 1, 3 and 5 s, so a window over the middle
    // one distinguishes the two behaviours completely: right, it holds one
    // transient at 0.6 s of the window; wrong, it holds the 1 s one as well and
    // runs four times as long.
    MediaInput windowed = inputFor(fixture);
    windowed.ss = 2.4;
    windowed.duration = 0.8;
    SoundMarkOptions clicks;
    clicks.wantTonal = false;
    clicks.wantSound = false;
    const SoundMarks win = readSoundMarks(windowed, clicks);
    if (win.ok) {
        checkf(win.t1 < 1.0,
               "a 0.8 s window reads 0.8 s and not the file up to it (%.3f s)", win.t1);
        const std::vector<SoundMark> hits = ofKind(win, MarkKind::Onset);
        const SoundMark* mid = nearest(hits, 0.6);
        checkf(mid && std::fabs(mid->at - 0.6) < kNear,
               "the transient at 3 s of the file is 0.6 s into a window "
               "beginning at 2.4 (%.3f s)",
               mid ? mid->at : -1.0);
        // The one that would be there if the window's start were being ignored.
        bool early = false;
        for (const SoundMark& x : hits)
            if (x.flux > 1.0 && std::fabs(x.at - (1.0 - 2.4)) < kNear) early = true;
        check(!early, "and the transient at 1 s of the file is not in it at all");
    } else {
        checkf(false, "a windowed read failed: %s", win.error.c_str());
    }

    SoundMarkOptions longRuns;
    longRuns.minRunSec = 5.0;
    const SoundMarks few = readSoundMarks(inputFor(fixture), longRuns);
    if (few.ok)
        check(ofKind(few, MarkKind::Tonal).empty(),
              "a five-second minimum drops a one-and-a-half-second run");

    if (have(silent)) {
        section("a file with no sound in it");
        const SoundMarks none = readSoundMarks(inputFor(silent), {});
        check(!none.ok, "is refused rather than answered with an empty list");
        checkf(!none.error.empty(), "and says why: \"%s\"", none.error.c_str());
    } else {
        std::printf("\n  no silent fixture — skipping the no-audio refusal\n");
    }

    if (have(tone)) {
        section("a continuous tone is one long run and nothing else");
        // The other sound fixture, which is 330 Hz for six seconds. It is the
        // control: a file in which nothing *happens* must produce a run and
        // essentially no transients, and it checks the frequency reading a
        // second time against a different number.
        const SoundMarks t = readSoundMarks(inputFor(tone), {});
        if (t.ok) {
            const std::vector<SoundMark> runs = ofKind(t, MarkKind::Tonal);
            const SoundMark* longest = nullptr;
            for (const SoundMark& r : runs)
                if (!longest || r.length > longest->length) longest = &r;
            if (longest) {
                checkf(longest->length > 4.0,
                       "the run covers %.2f s of the six-second tone", longest->length);
                checkf(std::fabs(longest->hz - 330.0) <= 20.0,
                       "and reads %.0f Hz against the 330 it was written at",
                       double(longest->hz));
            } else {
                check(false, "a six-second tone produced no tonal run at all");
            }
            checkf(ofKind(t, MarkKind::Onset).size() <= 2,
                   "and a tone that never changes has at most the transient of its "
                   "own beginning (%d)", int(ofKind(t, MarkKind::Onset).size()));
        }
    } else {
        std::printf("\n  no tone fixture — skipping the continuous-tone control\n");
    }

    std::printf("\n%d checks, %d failed\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
