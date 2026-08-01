// The render, on playback. See playback_output.h — in particular why the caller
// owns the seek, why the sound is the authoritative half, and why a run is shared
// by token rather than built per open.

#include "playback_output.h"

#include "export_frame.h"
#include "export_graph.h"
#include "export_timeline.h"
#include "live_tap.h"

#include "util/log.h"

extern "C" {
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <thread>

namespace ffmpegbro {
namespace {

/// A token, not a path. Starts with a slash for the reason `defineInput`'s and
/// `viewToken`'s do — bro resolves anything that does not against the document —
/// and says what it is, because it turns up in logs beside real filenames.
const char* kPrefix = "/@out/";

std::mutex& lock() {
    static std::mutex m;
    return m;
}

/// One registered render: the view, and which definition of it this is.
///
/// **The version is what makes a shared run safe.** Two opens of one element —
/// the pipeline's and the audio ring's — have to reach the same run or the edit is
/// rendered twice; two opens either side of a *redefinition* must not, or the
/// second element plays the render as it used to be. A counter answers both: it is
/// the same number for opens a millisecond apart and a different one the moment
/// anything is defined, which is exactly the line between those two cases.
struct Entry {
    OutputView view;
    uint64_t version = 0;
};

std::map<std::string, Entry>& table() {
    static std::map<std::string, Entry> t;
    return t;
}

uint64_t& defineSeq() {
    static uint64_t n = 0;
    return n;
}

/// The id inside a token. The range after it is there to make a moved playhead a
/// different string and is no part of the lookup — see `resolveOutput`.
bool idOf(const std::string& src, std::string* id) {
    const std::string prefix(kPrefix);
    if (src.compare(0, prefix.size(), prefix) != 0) return false;
    const std::string rest = src.substr(prefix.size());
    const size_t slash = rest.find('/');
    *id = slash == std::string::npos ? rest : rest.substr(0, slash);
    return true;
}

/// The range, as the part of the token that makes a moved playhead a new src.
///
/// Milliseconds and not seconds: a token is a string that has to compare equal
/// to itself, and printing a double at full precision to get that would put
/// `1.2999999999999998` in a log. A millisecond is two orders of magnitude
/// finer than the frame this addresses.
std::string rangePart(const ExportSettings& s) {
    const long long from = std::llround(s.startTime * 1000.0);
    const long long to = std::llround(s.endTime * 1000.0);
    return std::to_string(from) + "-" + std::to_string(to);
}

/// The source this spec renders through — the same choice `runExport` makes, and
/// the whole of what makes a preview the render rather than a resemblance of it.
///
/// **`includeAudio` is the caller's**, and it has to be settled before the source
/// is constructed rather than after: `TimelineSource`'s constructor opens a
/// `SourceAudio` per clip to answer `hasAudio()`, so a preview built with sound
/// opens every file on the timeline for its samples and one built without opens
/// none of them. That is why settling says false and a run says true — see the
/// header.
std::unique_ptr<FrameSource> sourceFor(ExportSettings s, std::vector<ExportClip> clips,
                                       bool wantSound, int* width, int* height,
                                       bool* isGraph, std::string* err) {
    s.includeAudio = s.includeAudio && wantSound;
    if (!s.filterGraph.empty()) {
        auto g = std::make_unique<GraphSource>(s);
        if (!g->build(err)) return nullptr;
        // What the graph turned out to be. `sizeFromGraph` is a render with no
        // opinion of its own — a node half-way down a graph is whatever size
        // libavfilter made it — and the picture on the screen has to be that
        // size for the same reason the writer would have to be opened for it.
        *width = s.sizeFromGraph ? g->outWidth() : s.width;
        *height = s.sizeFromGraph ? g->outHeight() : s.height;
        *isGraph = true;
        return g;
    }
    *width = s.width;
    *height = s.height;
    *isGraph = false;
    return std::make_unique<TimelineSource>(s, std::move(clips));
}

/// One RGBA canvas, as a frame of its own to hand over.
///
/// Copied rather than referenced, because the compositor owns one buffer and
/// paints the next frame into it — see `OutputReader::next`. `av_frame_get_buffer`
/// rather than a plain allocation so the picture is refcounted the way every
/// other frame in this binary is, which is what lets the packet path hold it.
AVFrame* frameOf(const Rgba& canvas, double at, double fps) {
    if (canvas.empty()) return nullptr;
    AVFrame* f = av_frame_alloc();
    if (!f) return nullptr;
    f->format = AV_PIX_FMT_RGBA;
    f->width = canvas.width;
    f->height = canvas.height;
    if (av_frame_get_buffer(f, 0) < 0) { av_frame_free(&f); return nullptr; }

    const uint8_t* src = canvas.data.data();
    av_image_copy_plane(f->data[0], f->linesize[0], src, canvas.stride,
                        canvas.width * 4, canvas.height);

    // Microseconds, which is what the track is described in — one clock for the
    // whole of this path, so nothing has to convert between two of them.
    f->pts = std::llround(at * 1000000.0);
    f->time_base = AVRational{1, 1000000};
    if (fps > 0.0) f->duration = std::llround(1000000.0 / fps);
    return f;
}

/// One tick's worth of the mix, as a frame of its own to hand over.
///
/// Packed float at the render's own rate and channel count, which is what
/// `mixInto` produces and what bro's audio decoder resamples from — the same
/// crossing a `-f lavfi -i sine` already makes, so there is nothing here that
/// knows it is a preview. A named layout rather than a bare count, because
/// swresample needs one to build a downmix matrix that folds a centre channel in
/// at the right level instead of dropping it.
AVFrame* soundOf(const float* mix, int frames, int rate, int channels, double at) {
    if (!mix || frames <= 0 || rate <= 0 || channels <= 0) return nullptr;
    AVFrame* f = av_frame_alloc();
    if (!f) return nullptr;
    f->format = AV_SAMPLE_FMT_FLT;
    f->nb_samples = frames;
    f->sample_rate = rate;
    av_channel_layout_default(&f->ch_layout, channels);
    if (av_frame_get_buffer(f, 0) < 0) { av_frame_free(&f); return nullptr; }
    std::memcpy(f->data[0], mix, sizeof(float) * static_cast<size_t>(frames) * channels);
    f->pts = std::llround(at * 1000000.0);
    f->time_base = AVRational{1, 1000000};
    return f;
}

/// Milliseconds on the steady clock, for the demand window and the pacing.
int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

/// How long the run keeps producing after the last reader asked.
///
/// A quarter of a second: long enough that a reader which asks once per element
/// frame never lets it lapse, and short enough that a preview paused on screen
/// stops rendering within a frame or two of being paused. The alternative — a
/// reader that says when it *stops* — is a message that never arrives when an
/// element is torn down, and a render left running for the life of the process is
/// the failure worth designing against.
constexpr int64_t kDemandMs = 250;

/// How much sound the run keeps queued ahead of a listener.
///
/// The queue's room is the pacing while anybody is listening, so this number is
/// the whole of the run's rate control: at 0.4 s it is under bro's own half-second
/// playback ring — so the ring is what runs dry first if the render cannot keep up,
/// which is where the gap belongs — and it is far enough ahead that a frame taking
/// three times its share does not produce one.
constexpr double kSoundAhead = 0.4;

}  // namespace

// ── The registry ───────────────────────────────────────────────────────────

std::string defineOutput(const std::string& id, const OutputView& v) {
    {
        std::lock_guard<std::mutex> g(lock());
        table()[id] = Entry{v, ++defineSeq()};
    }
    return std::string(kPrefix) + id + "/" + rangePart(v.settings);
}

void forgetOutput(const std::string& id) {
    std::lock_guard<std::mutex> g(lock());
    table().erase(id);
}

bool resolveOutput(const std::string& src, OutputView* out) {
    const std::string prefix(kPrefix);
    if (src.compare(0, prefix.size(), prefix) != 0) return false;
    // The range is part of the token and not part of the lookup: it is there to
    // make a moved playhead a different string, and what it names is whatever
    // that id is registered as *now*. A src held by an element that has been
    // superseded therefore opens the current view, which is the same answer as
    // re-pointing it would have given.
    std::string id;
    if (!idOf(src, &id)) return false;
    std::lock_guard<std::mutex> g(lock());
    auto it = table().find(id);
    if (it == table().end()) return false;
    if (out) *out = it->second.view;
    return true;
}

/// Which definition of that token is current, or 0 for one nothing is registered
/// under. Not public: it exists to key a run, and a caller that had it would be a
/// caller deciding when two elements share a render.
static uint64_t versionOf(const std::string& src) {
    std::string id;
    if (!idOf(src, &id)) return 0;
    std::lock_guard<std::mutex> g(lock());
    auto it = table().find(id);
    return it == table().end() ? 0 : it->second.version;
}

// ── What the render turns out to be ────────────────────────────────────────

bool settleOutput(const OutputView& v, OutputFacts* facts, std::string* err) {
    OutputReader reader;
    if (!reader.open(v, /*wantSound=*/false, err)) return false;
    // Settling asks what the render *is*, not what it looks like at a moment, so
    // no tick is taken and the lag never comes into it.
    if (facts) *facts = reader.facts();
    return true;
}

// ── One render, read a frame at a time ─────────────────────────────────────

OutputReader::OutputReader() = default;
OutputReader::~OutputReader() = default;

bool OutputReader::open(const OutputView& v, bool wantSound, std::string* err) {
    ExportSettings s = v.settings;
    if (!(s.fps > 0.0)) s.fps = 25.0;

    // The same refusal `startExport` makes, in the same words, because this is
    // that render with the writer taken off the end — and it arrives *earlier*
    // here, which is the point: `settleOutput` is called the moment somebody
    // asks for the picture, so a clip the render would refuse is refused before
    // an element is pointed at anything. See `deviceClip` in ffmpeg_export.h.
    if (const int at = deviceClip(s, v.clips); at >= 0) {
        if (err) *err = deviceClipRefusal(s, v.clips, at);
        return false;
    }

    int w = 0, h = 0;
    bool graph = false;
    source_ = sourceFor(s, v.clips, wantSound, &w, &h, &graph, err);
    if (!source_) return false;

    facts_.width = w;
    facts_.height = h;
    facts_.fps = s.fps;
    facts_.start = s.startTime;
    facts_.length = std::max(0.0, s.endTime - s.startTime);
    facts_.graph = graph;
    // **Asked once, here.** `hasAudio()` is the source's answer and it is settled
    // by the time the constructor has run, so a reader that asked again per tick
    // would be asking a question that cannot change. Zero on both when there is
    // no soundtrack, which is what stops a pad being published for one.
    if (wantSound && source_->hasAudio()) {
        facts_.audioRate = s.audioSampleRate > 0 ? s.audioSampleRate : 48000;
        facts_.audioChannels = s.audioChannels > 0 ? s.audioChannels : 2;
    }

    // Zero means "until it stops", which is the honest answer for a range with
    // no end rather than a reason to refuse: a graph ends when its inputs do and
    // the canvas goes black past the end of the track stack, so an element
    // watching one has something to show either way.
    total_ = facts_.length > 0.0 ? std::max<int64_t>(1, std::llround(facts_.length * s.fps))
                                 : 0;
    n_ = 0;
    return true;
}

OutputReader::Tick OutputReader::next(bool wantPicture, double screen) {
    Tick out;
    if (!source_) {
        out.done = true;
        return out;
    }

    // The two moments of one tick. The sound is made at the frontier, because
    // that is what fills the element's ring; the picture is made one frame after
    // where the screen is, which is about a second behind it. See the note at the
    // top of the header.
    const double into = double(n_) / facts_.fps;
    const double step = 1.0 / facts_.fps;
    // A graph gets none of this: `GraphSource::canvasAt` takes no `t`, so asking
    // for an earlier instant would produce the next frame either way and label it
    // with a moment it is not.
    //
    // **One frame after the screen, and never past the frontier.** The two halves
    // are the two things that can be true of a preview, and leaving either out
    // brings the slideshow back in one of them:
    //
    //   - while the render is keeping up, the frontier is a second ahead of the
    //     screen and the first half binds: each picture is the one the element is
    //     about to want, so every one of them is seen;
    //   - while it is *not* keeping up — a render slower than real time, or the
    //     headless engine, whose mixer runs on `advanceTime` rather than on a
    //     device and drains a fifth as fast — the element's clock outruns the
    //     frontier and the second half binds: the newest thing made is the best
    //     answer there is, which is what this always used to publish.
    double back = facts_.graph ? into
                              : std::max(0.0, std::min((screen < 0.0 ? into : screen) + step,
                                                       into));
    // Never backwards. The screen is read afresh every tick and a reading that
    // arrived out of order would be a seek in every clip under the playhead
    // rather than the frame after it.
    if (back < shown_) back = shown_;
    // **And a composite only where there is a new moment to make.** A pad holds
    // one picture, so a second made for a moment the element has not reached only
    // replaces the first — the work of a decode and a scale, thrown away. Between
    // two asks there is nothing new to make, and this is what says so.
    const bool fresh = back > shown_ || n_ == 0;
    shown_ = back;

    // **The range has run out when the *picture* has covered it**, not when the
    // sound has. The sound is made a lag ahead and therefore finishes that much
    // earlier; stopping there would take the last second off the thing being
    // watched and hand the transport an end that had not come.
    if (total_ > 0 && back >= facts_.length - 1e-9) {
        out.done = true;
        return out;
    }

    const double t = facts_.start + back;
    out.at = into;
    out.pictureAt = back;

    // **A graph is pulled whether or not the picture is wanted.** libavfilter
    // holds every frame it has pushed at a sink until somebody takes it, so a
    // pull skipped is a frame accumulated rather than work saved — which is the
    // same reason `GraphSource::tick` drains sinks nobody reads. The compositor is
    // the opposite: it is asked what the output looks like at an instant, and an
    // instant nobody asked about costs nothing.
    const bool composite = (wantPicture && fresh) || facts_.graph;
    const Rgba* canvas = composite ? &source_->canvasAt(t) : nullptr;
    // The track stack says when it has run out; a graph does not, and past the
    // end of one the canvas is black — which is the convention `canvasAt`
    // already follows and the same picture the render would write. Only asked
    // for a range with no end, where there is nothing else to stop on.
    if (total_ == 0 && composite && source_->exhausted(t)) {
        out.done = true;
        return out;
    }

    // The samples this frame covers, counted from the start of the range so that
    // rounding never loses or repeats one at a frame boundary — which is the same
    // count `runExport` keeps for the writer, and has to be, or a preview and a
    // render would disagree about which samples belong to which frame.
    //
    // Only while the frontier is still inside the range: the ticks past it exist
    // to let the picture catch up, and there is no sound left for them to make.
    if (facts_.audioRate > 0 && (total_ <= 0 || into < facts_.length)) {
        const int rate = facts_.audioRate;
        const int channels = facts_.audioChannels;
        const int64_t upTo = std::llround((double(n_ + 1) / facts_.fps) * rate);
        const int frames = static_cast<int>(std::max<int64_t>(0, upTo - samplesDone_));
        if (frames > 0) {
            mix_.assign(static_cast<size_t>(frames) * channels, 0.0f);
            source_->mixInto(mix_.data(), facts_.start + double(samplesDone_) / rate,
                             frames, rate, channels);
            out.sound = soundOf(mix_.data(), frames, rate, channels, into);
            samplesDone_ = upTo;
        }
    }

    if (composite && canvas) out.picture = frameOf(*canvas, back, facts_.fps);
    ++n_;
    return out;
}

// ── One render, shared by everything playing it ────────────────────────────

namespace {

std::mutex& runLock() {
    static std::mutex m;
    return m;
}

/// Every run there is, by token. **Weak**, so that the last reader letting go is
/// what stops a render and this table is a way of *finding* one rather than a
/// thing that keeps one alive.
std::map<std::string, std::weak_ptr<OutputRun>>& runs() {
    static std::map<std::string, std::weak_ptr<OutputRun>> t;
    return t;
}

}  // namespace

OutputRun::~OutputRun() {
    {
        std::lock_guard<std::mutex> g(m_);
        quit_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
    // Whoever is still reading a pad is told, rather than left waiting out its
    // timeout on a render that has gone. The tap outlives this by however long
    // that reader takes to notice — the rule `LiveTap` is built around.
    if (tap_) tap_->finishAll();
}

void OutputRun::wake() {
    {
        std::lock_guard<std::mutex> g(m_);
        until_ = nowMs() + kDemandMs;
    }
    cv_.notify_all();
}

void OutputRun::sawPicture(double at) {
    screenFrontier_.store(frontier_.load(std::memory_order_relaxed),
                          std::memory_order_relaxed);
    screenAt_.store(at, std::memory_order_relaxed);
    // A reader that has taken a picture is a reader that wants the next one, and
    // the loop may be idling a quarter of a second out.
    wake();
}

double OutputRun::screenNow() const {
    const double at = screenAt_.load(std::memory_order_relaxed);
    if (at < 0.0) return -1.0;
    // **Carried forward by what this run has made since the reading was taken —
    // and by no more than a frame.**
    //
    // Carried forward at all because the reading goes stale the moment it is
    // taken, and an element drawing more slowly than the output rate would
    // otherwise be offered one frame per ask and crawl behind its own soundtrack.
    // On the *render's* clock rather than the wall, because the wall is neither
    // bro's clock in the headless engine, where `advanceTime` is, nor the
    // render's when the render cannot keep up.
    //
    // By no more than a frame because a long gap between asks means the element
    // was *waiting* on a picture from too far ahead, and carrying forward across
    // that gap answers a run that is already ahead by getting further ahead.
    // Unbounded, that is a runaway with only the frontier to stop it, and the
    // frontier is exactly where the slideshow was: measured, it took a preview
    // from sixty pictures a second to seven. The bound is what makes this a
    // mechanism rather than a tuning — whatever either clock is doing, the
    // picture offered is at most two frames past the screen, so the longest the
    // element can sit staging one is two frames.
    const double step = facts_.fps > 0.0 ? 1.0 / facts_.fps : 1.0 / 30.0;
    const double made = frontier_.load(std::memory_order_relaxed) -
                        screenFrontier_.load(std::memory_order_relaxed);
    return at + std::min(std::max(0.0, made), step);
}

void OutputRun::loop() {
    auto picture = tap_->ensure("vout", false);
    auto sound = facts_.audioRate > 0 ? tap_->ensure("aout", false) : nullptr;

    // Where the range's clock is pinned to the wall clock. Re-anchored every time
    // this thread sleeps, which is what makes "late" mean *late while working*: a
    // run that has been idle for a minute, or held back by a full queue, has not
    // fallen behind anything.
    int64_t anchor = nowMs();
    int64_t n = 0;

    for (;;) {
        {
            std::unique_lock<std::mutex> g(m_);
            if (quit_) break;
            if (nowMs() >= until_) {
                // Nobody has asked for a quarter of a second. Wait to be woken
                // rather than spinning, and come back with the clock re-pinned.
                cv_.wait_for(g, std::chrono::milliseconds(200));
                anchor = nowMs() - static_cast<int64_t>(1000.0 * n / facts_.fps);
                continue;
            }
        }

        // **The queue's room is the pacing, when there is a queue.** A monitor
        // drains at real time, so waiting for room *is* running at real time and
        // no clock is consulted to arrange it. With nobody listening there is no
        // regulator, so the tick is paced against the wall clock instead — a run
        // producing pictures faster than they can be looked at is a render
        // burning a core to be thrown away.
        const double backlog = sound ? sound->soundBacklog() : -1.0;
        if (backlog >= kSoundAhead) {
            std::this_thread::sleep_for(std::chrono::milliseconds(4));
            anchor = nowMs() - static_cast<int64_t>(1000.0 * n / facts_.fps);
            continue;
        }
        if (backlog < 0.0) {
            const int64_t due = anchor + static_cast<int64_t>(1000.0 * n / facts_.fps);
            if (nowMs() < due) {
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                continue;
            }
        }

        // **Late by more than a frame and a half, so this one's picture goes.**
        // Half a frame of slack would make a skip out of ordinary jitter and a
        // whole frame is the boundary itself; past that the render is genuinely
        // not keeping up, and the picture is where nearly all of its cost is. The
        // reader honours this only for the compositor — see `next`.
        const int64_t late = nowMs() - (anchor + static_cast<int64_t>(1000.0 * n / facts_.fps));
        const bool skip = late > static_cast<int64_t>(1500.0 / facts_.fps);

        // Published so `screenNow` can carry its reading forward against it.
        frontier_.store(double(n) / facts_.fps, std::memory_order_relaxed);

        OutputReader::Tick tick = reader_->next(!skip, screenNow());
        if (tick.done) {
            if (tick.picture) av_frame_free(&tick.picture);
            if (tick.sound) av_frame_free(&tick.sound);
            break;
        }
        // Each published with where *it* sits in the range, which is the clock
        // the element reads its two tracks back on — and they are two different
        // moments now, which is the whole of the correction at the top.
        if (tick.picture) {
            picture->put(tick.picture, tick.pictureAt);
            av_frame_free(&tick.picture);
        }
        if (tick.sound && sound) {
            // **Measured whether or not anybody is listening, and that is what
            // makes a meter beside the viewer possible at all.** `putSound` queues
            // the block only while an element is playing this pad; `heard` reads it
            // every time, on the thread that made it, so the level exists for the
            // same reason a capture session's does — see `LivePadTap::heard`. This
            // is the render's own mix at the output's own channel count, which is
            // the one place in this application that number can be read off
            // something rather than assumed.
            sound->heard(tick.sound);
            sound->putSound(tick.sound, tick.at);
            av_frame_free(&tick.sound);
        }
        ++n;
    }

    tap_->finishAll();
}

OutputLevels outputLevels(const std::string& id) {
    OutputLevels out;
    // **Found by scanning for the id rather than by rebuilding the token, and the
    // newest definition wins.** The key a run is filed under carries the range and
    // the definition number, and both of those change a frame before the element is
    // re-pointed — so a lookup that reconstructed the current token would go dark
    // for one frame on every rebuild, which under a dragged slider is a meter that
    // flickers. What is wanted is "whatever render of this id is running".
    //
    // The definition number is what makes that unambiguous, and taking the highest
    // is the whole of it: a run lives while something holds it, so the *previous*
    // render of an id can still be alive for a moment after the element let go of
    // it — and reading a spec's levels off the render it superseded is exactly the
    // kind of wrong that looks like the meter working. Ordering the map's keys as
    // strings would not do it either: `@9` sorts after `@10`.
    const std::string want = std::string(kPrefix) + id + "/";
    std::shared_ptr<OutputRun> run;
    uint64_t newest = 0;
    {
        std::lock_guard<std::mutex> g(runLock());
        for (auto it = runs().begin(); it != runs().end();) {
            const std::string key = it->first;
            if (key.compare(0, want.size(), want) != 0) { ++it; continue; }
            auto have = it->second.lock();
            if (!have) { it = runs().erase(it); continue; }
            ++it;
            const size_t mark = key.rfind('@');
            const uint64_t version =
                mark == std::string::npos
                    ? 0
                    : std::strtoull(key.c_str() + mark + 1, nullptr, 10);
            if (version < newest) continue;
            auto pad = have->tap()->pad("vout");
            if (pad && pad->ended()) continue;
            newest = version;
            run = std::move(have);
        }
    }
    if (!run) return out;
    out.running = true;
    out.rate = run->facts().audioRate;
    if (out.rate <= 0) return out;   // a render with no soundtrack, said as one
    if (auto pad = run->tap()->pad("aout")) out.heard = pad->level(&out.channels);
    return out;
}

std::shared_ptr<OutputRun> attachOutput(const std::string& src, std::string* err) {
    OutputView view;
    if (!resolveOutput(src, &view)) {
        if (err) *err = "no render is registered under " + src;
        return nullptr;
    }

    // **Keyed by the definition and not merely by the token**, which is the whole
    // of what keeps a shared run honest: see `Entry`. A run that has already
    // reached the end of its range is not offered either — the element that
    // arrives after one has finished would open a source with nothing left in it
    // and report itself ended, which looks exactly like a preview that will not
    // play.
    const std::string key = src + "@" + std::to_string(versionOf(src));
    std::lock_guard<std::mutex> g(runLock());
    auto it = runs().find(key);
    if (it != runs().end()) {
        if (auto have = it->second.lock()) {
            auto pad = have->tap()->pad("vout");
            if (pad && !pad->ended()) return have;
        }
        runs().erase(it);
    }

    std::shared_ptr<OutputRun> run(new OutputRun());
    run->reader_ = std::make_unique<OutputReader>();
    // **With sound**, which is the one place that decision is made: a run exists
    // because something is going to play this, and what a preview is for is
    // hearing the half of the render no clip element can play.
    if (!run->reader_->open(view, /*wantSound=*/true, err)) return nullptr;
    run->facts_ = run->reader_->facts();
    run->tap_ = std::make_shared<LiveTap>();
    // **The pads exist before the thread does**, for the reason a live session's
    // device pads do: a reader is built the instant this returns and looks for its
    // pad by name, so making them on the far thread would be a race the caller
    // could only lose by being quick.
    run->tap_->ensure("vout", false);
    if (run->facts_.audioRate > 0) run->tap_->ensure("aout", false);
    // Demanded to begin with: whoever attached is about to read.
    run->until_ = nowMs() + kDemandMs;
    OutputRun* raw = run.get();
    run->thread_ = std::thread([raw] { raw->loop(); });
    runs()[key] = run;
    LOG_INFO("ffmpeg: output preview %s: %dx%d at %.3f fps%s", src.c_str(),
             run->facts_.width, run->facts_.height, run->facts_.fps,
             run->facts_.audioRate > 0 ? ", with sound" : "");
    return run;
}

} // namespace ffmpegbro
