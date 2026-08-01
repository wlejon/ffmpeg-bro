// Decoding a soundtrack to the front-end's own rate, driving bro's sensor bus
// over it, and keeping the moments something fired. See sound_marks.h for what a
// mark claims and — more importantly — what it does not.

#include "sound_marks.h"

#include "async_open.h"
#include "export_source.h"

#include <brosoundml/sensor_hub.h>
#include <brotensor/runtime.h>

#include <algorithm>
#include <exception>
#include <mutex>
#include <vector>

namespace ffmpegbro {

namespace {

SoundMarks fail(const std::string& why) {
    SoundMarks m;
    m.error = why;
    return m;
}

/// A run of frames one sensor held true for, being accumulated.
///
/// One struct for both runs because they differ only in which flag opens them
/// and which numbers are worth averaging — two nearly identical trackers would
/// be two places for "when does a run end" to disagree.
struct Run {
    bool open = false;
    double start = 0.0;     ///< window start of the first frame
    double end = 0.0;       ///< window end of the latest frame
    float db = -120.0f;     ///< loudest frame in it
    /// Only the tonal run averages anything, so only the tonal run accumulates
    /// these — `n` is the divisor for the two above rather than a frame count,
    /// and a sound run leaves all three at zero because there is nothing about
    /// a run of loudness that a mean of a frequency would mean.
    double hzSum = 0.0;
    double perSum = 0.0;
    int64_t n = 0;
};

/// Whether a run is long enough to be a place. See `SoundMarkOptions::minRunSec`.
bool longEnough(const Run& r, double minRunSec) {
    return (r.end - r.start) >= minRunSec;
}

} // namespace

/// Only one analysis at a time, process-wide.
///
/// Not a choice: `brotensor/detail/cpu/thread_pool.h` says its pool is a
/// process-wide singleton and that `run()` "assumes it is not re-entered from a
/// second concurrent application thread while a call is outstanding". The hub's
/// mel front-end reaches it — the `matmul` that projects a magnitude spectrum
/// onto the mel filterbank calls `parallel_for` over its rows — so two reads on
/// two threads would share one job cursor. A transcription's mel front-end is
/// the same shape and takes the same lock (`src/native/transcribe.cpp`), which
/// is why this is declared in the header rather than being local to this file.
///
/// What this does *not* cover, and cannot: bro's own audio inference thread
/// running `bro.sense` or `bro.kws` over a live microphone hits the same pool
/// through the same ops. Nothing in `ui/` starts one, and if something did, the
/// hazard would be bro's to arbitrate rather than a lock in this file's to hold.
std::mutex& analysisLock() {
    static std::mutex m;
    return m;
}

SoundMarks readSoundMarks(const MediaInput& in, const SoundMarkOptions& opts,
                          OpenWatch* watch, double timeoutSec) {
    // The pool is single-caller, so the analysis is single-caller. Taken before
    // the decoder is opened, so that a queued read is not also holding a
    // demuxer open while it waits.
    std::lock_guard<std::mutex> serialise(analysisLock());
    // The deadline covers this read's own work, not its wait. `AsyncOpens` arms
    // it before the thread starts — which is right, because work that blocks on
    // its first syscall should already be on the clock — and a read that queued
    // for four minutes behind another would otherwise be killed for somebody
    // else's file.
    if (watch && timeoutSec > 0) watch->expireIn(timeoutSec);

    // The hub's mel front-end is composed of brotensor ops. `init()` is
    // idempotent, mutex-guarded and, in a build with no GPU backend compiled in,
    // does nothing but settle the default device — bro's own `js_analyze` calls
    // it in the same position for the same reason.
    try {
        brotensor::init();
    } catch (const std::exception& e) {
        return fail(std::string("the tensor runtime would not start: ") + e.what());
    }

    brosoundml::SensorHubConfig cfg;
    if (opts.onsetRatio) cfg.onset_ratio = *opts.onsetRatio;
    if (opts.onsetAbs) cfg.onset_abs = *opts.onsetAbs;
    if (opts.tonalMinPeriodicity) cfg.tonal_min_periodicity = *opts.tonalMinPeriodicity;
    if (opts.tonalFminHz) cfg.tonal_fmin_hz = *opts.tonalFminHz;
    if (opts.tonalFmaxHz) cfg.tonal_fmax_hz = *opts.tonalFmaxHz;

    const int rate = cfg.mel.sample_rate;
    const int win = cfg.mel.win_length;
    const int hop = cfg.mel.hop_length;
    if (rate <= 0 || win <= 0 || hop <= 0 || hop > win)
        return fail("brosoundml's front-end recipe is not one this can frame");

    // **Ask libav for the conversion.** The hub wants mono float at its own
    // rate; `SourceAudio` is already the reader that opens an input the way this
    // application opens every other one — the same `-f`, the same option bag,
    // the same window — and hands over `swr`-converted samples. Decoding and
    // resampling by hand here would be a second answer to what an `-i` means.
    //
    // Speed is 1.0 and is not a parameter: a mark belongs to the *input*, and a
    // clip's speed is applied on the way from a mark to the timeline by
    // `timelineTime`, once, in `ui/project.js`.
    SourceAudio src;
    if (!src.open(in, rate, 1, 1.0))
        return fail("there is no sound in this input to read");

    SoundMarks out;
    out.streamIndex = src.stream();
    out.rate = rate;
    out.win = win;
    out.hop = hop;
    // The input's own zero. `SourceAudio` has already taken the container's
    // start time and the input's `-ss` off everything it hands over, so the
    // first sample is at zero on the clock `clip.inPoint` is written against.
    out.t0 = 0.0;

    // A second of audio per pull. Big enough that the decode is not one call per
    // 10 ms frame, small enough that a cancel is noticed within a second and
    // that the buffer is 64 kB rather than a copy of the file.
    const int kPull = rate;
    std::vector<float> pcm;
    size_t head = 0;
    bool ended = false;

    /// Make sure `need` samples sit at `head`, pulling more if there are more.
    /// False when the file ran out first — the tail shorter than a hop is
    /// dropped, exactly as `js_analyze` drops it.
    auto ensure = [&](int need) {
        while (static_cast<int>(pcm.size() - head) < need) {
            if (ended) return false;
            const size_t at = pcm.size();
            pcm.resize(at + kPull, 0.0f);
            const int got = src.mixInto(pcm.data() + at, kPull, 1.0f);
            if (got < kPull) {
                pcm.resize(at + static_cast<size_t>(got < 0 ? 0 : got));
                ended = true;
            }
        }
        return true;
    };

    /// Drop what has been fed. `feed` copies into the hub's own ring, so nothing
    /// downstream holds a pointer into this and the front can go whenever it is
    /// worth the memmove — `SourceAudio::compact`'s threshold, for its reason.
    auto compact = [&] {
        if (head >= 65536) {
            pcm.erase(pcm.begin(), pcm.begin() + static_cast<long>(head));
            head = 0;
        }
    };

    brosoundml::SensorHub hub(cfg);
    Run tonal, sound;

    /// One mark, if there is room for it. The totals are counted by the caller
    /// either way, so a truncated list cannot understate what the file held.
    auto keep = [&](const SoundMark& m) {
        if (static_cast<int>(out.marks.size()) >= kMaxSoundMarks) {
            out.truncated = true;
            return;
        }
        out.marks.push_back(m);
    };

    /// Close a run and keep it, if it was long enough and wanted.
    auto close = [&](Run& r, MarkKind kind, bool want) {
        if (!r.open) return;
        r.open = false;
        if (!want || !longEnough(r, opts.minRunSec)) return;
        SoundMark m;
        m.kind = kind;
        m.at = r.start;
        m.length = r.end - r.start;
        m.db = r.db;
        if (kind == MarkKind::Tonal && r.n > 0) {
            m.hz = static_cast<float>(r.hzSum / double(r.n));
            m.periodicity = static_cast<float>(r.perSum / double(r.n));
        }
        keep(m);
    };

    /// One frame's worth of every sensor, turned into events.
    ///
    /// `s.t` is the stream time at the **end** of the frame the hub just
    /// processed, so the window it saw is `[s.t - win/rate, s.t)`. Everything
    /// below is written against the start of that window; see `SoundMark::at`.
    auto take = [&](const brosoundml::SensorSnapshot& s) {
        const double frameEnd = s.t;
        const double frameStart = s.t - double(win) / double(rate);
        out.frames = s.frames;
        out.t1 = frameEnd;

        if (s.onset) {
            ++out.onsets;
            if (opts.wantOnsets) {
                SoundMark m;
                m.kind = MarkKind::Onset;
                m.at = frameStart;
                m.db = s.db;
                m.flux = s.flux;
                keep(m);
            }
        }

        if (s.tonal) {
            if (!tonal.open) {
                tonal = Run{};
                tonal.open = true;
                tonal.start = frameStart;
                ++out.tonalRuns;
            }
            tonal.end = frameEnd;
            tonal.db = std::max(tonal.db, s.db);
            tonal.hzSum += s.dominant_hz;
            tonal.perSum += s.periodicity;
            ++tonal.n;
        } else {
            close(tonal, MarkKind::Tonal, opts.wantTonal);
        }

        if (s.voice) {
            if (!sound.open) {
                sound = Run{};
                sound.open = true;
                sound.start = frameStart;
                ++out.soundRuns;
            }
            sound.end = frameEnd;
            sound.db = std::max(sound.db, s.db);
        } else {
            close(sound, MarkKind::Sound, opts.wantSound);
        }
    };

    // ── the framing loop ──────────────────────────────────────────────────
    //
    // **This is a second home for a fact bro owns.** The other one is
    // `js_analyze` in bro's `src/js/sense_bindings.cpp`: prime the hub with one
    // whole `win_length` window, then advance exactly one `hop_length` per
    // frame, taking a snapshot after each `feed` because a snapshot is the only
    // way out of the hub and it holds one frame. The two must agree on three
    // numbers — `cfg.mel.sample_rate`, `cfg.mel.win_length` and
    // `cfg.mel.hop_length` — and on the *shape*: prime with a window, hop
    // thereafter, drop the tail shorter than a hop. If bro's framing changes,
    // this must change with it, or a mark here and a frame index from
    // `bro.sense.analyze` over the same file will name different moments.
    //
    // It is duplicated rather than shared because bro's copy lives inside a
    // QuickJS callback and is written against a `Float32Array` this side of the
    // seam does not have — and because the samples here arrive a second at a
    // time out of a decoder rather than all at once out of the JS realm. Feeding
    // the whole track in one `feed()` would be simpler and is not equivalent: it
    // produces every frame and lets you see only the last one's snapshot.
    if (ensure(win)) {
        hub.feed(pcm.data() + head, win);
        head += static_cast<size_t>(win);
        take(hub.snapshot());
        compact();

        int sinceCheck = 0;
        while (ensure(hop)) {
            hub.feed(pcm.data() + head, hop);
            head += static_cast<size_t>(hop);
            take(hub.snapshot());
            compact();
            // A cancel is real during the arithmetic, not only during I/O.
            // libav's interrupt callback is polled while packets are read, and
            // between two reads this loop is minutes of pure DSP that would
            // otherwise ignore the button. Every hundred frames is once a
            // second of audio, which is far under a press.
            if (watch && ++sinceCheck >= 100) {
                sinceCheck = 0;
                if (watch->stopped()) break;
            }
        }
    }

    // A run still open at the end of the file ended with the file.
    close(tonal, MarkKind::Tonal, opts.wantTonal);
    close(sound, MarkKind::Sound, opts.wantSound);

    // In time order, every kind interleaved. Onsets and run-ends are appended as
    // they are detected, so a run that opened before an onset is appended after
    // it — a stable sort by `at` is the whole of putting that right, and stable
    // so two marks at one moment keep the order they were found in.
    std::stable_sort(out.marks.begin(), out.marks.end(),
                     [](const SoundMark& a, const SoundMark& b) { return a.at < b.at; });

    if (watch && watch->stopped()) {
        // Not `ok`. The list is whatever was reached, and the caller turns a
        // stopped read into its own word rather than into a failure — see
        // `marksReadProgress`.
        out.error = "stopped";
        return out;
    }
    if (watch && watch->expired()) {
        // The deadline reached libav's own interrupt callback, which ended the
        // decode early — so the loop above finished tidily over a soundtrack
        // that stopped short. Reported as a failure rather than as a shorter
        // answer, because a list of marks covering the first four minutes of an
        // hour is indistinguishable from an hour in which nothing else happened.
        out.error = "gave up before the end of the sound: this read ran out of "
                    "the time it was given";
        return out;
    }

    out.ok = true;
    return out;
}

// ── the same read, on a thread ────────────────────────────────────────────

namespace {

AsyncOpens<SoundMarks>& reads() {
    static AsyncOpens<SoundMarks> t;
    return t;
}

} // namespace

uint64_t startMarksRead(const MediaInput& in, const SoundMarkOptions& opts,
                        double timeoutSec) {
    const double t = timeoutSec > 0 ? timeoutSec : kMarksReadTimeoutSec;
    // The same number twice, deliberately: `AsyncOpens` arms it now, and the
    // work re-arms it once it has the analysis lock. See `readSoundMarks`.
    return reads().start(
        [in, opts, t](OpenWatch* watch) { return readSoundMarks(in, opts, watch, t); },
        t);
}

bool marksReadProgress(uint64_t id, MarksProgress* out) {
    if (!out) return false;
    AsyncOpens<SoundMarks>::Slot slot;
    if (!reads().look(id, &slot)) return false;

    out->elapsed = slot.elapsed;
    out->timeout = slot.timeout;
    if (!slot.finished) {
        out->state = MarksProgress::State::Reading;
        return true;
    }
    out->result = slot.result;
    out->state = slot.stopped     ? MarksProgress::State::Stopped
                 : out->result.ok ? MarksProgress::State::Done
                                  : MarksProgress::State::Failed;
    return true;
}

void stopMarksRead(uint64_t id) { reads().stop(id); }

void abandonMarksRead(uint64_t id) { reads().abandon(id); }

} // namespace ffmpegbro
