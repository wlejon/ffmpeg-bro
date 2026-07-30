// Where a live session puts its pictures, and where a `<video>` finds them.
//
// One small object with a lock, in a header of its own because it is the one
// fact two halves of this binary have to agree about: `ffmpeg_capture.cpp`
// publishes into it from a session thread, and `ffmpeg_backend.cpp` reads out
// of it on whichever thread is driving an element. Neither knows anything else
// about the other, which is what keeps a live session out of the media backend
// and the media backend out of the capture loop.
//
// **Newest wins, and there is no queue.** A pad holds one picture: the one the
// session most recently produced. A reader that was busy missed the ones in
// between, which is right — they had a moment to be shown in and it has gone,
// and the alternative is a preview that runs further behind the camera the
// longer you watch it. It is the same rule `Hand` applies in front of the
// graph, for the same reason, and the two are the only places in this
// application where dropping a frame is correct.
//
// **A reader waits, and that is what makes it a media source at all.** bro
// pumps a `MediaSource` until it has a picture whose time has not yet come, so
// "nothing yet" cannot be answered with "the stream ended" — the element would
// stop. So `take` blocks on a condition variable until a frame arrives or the
// wait runs out, exactly as `av_read_frame` on a camera blocks, and a preview
// that has genuinely stopped is reported as an end rather than as a stall.
//
// **A sound pad keeps a level, and the level is not a queue.** Playing a
// session's mix is monitoring, and monitoring asks questions a preview does not
// — whose speakers, and what happens when the microphone can hear them. What
// can be answered without asking any of them is *how loud is it*, which is the
// reading somebody wants before a take rather than after it. So a sound pad
// holds a reading per channel, accumulated rather than replaced: see `heard`.
//
// **The pad measures its own sound, which is why `heard` takes the frame.** It
// used to be handed a peak and a power somebody else had worked out, and the
// somebody else was a static in ffmpeg_capture.cpp — right for as long as a
// capture session was the only thing with sound to measure. The output preview
// publishes a mix into one of these too now (playback_output.h), so there would
// have been two measurements of the same kind of thing, and a meter beside the
// viewer that disagreed with the one on the Capture stage by a decibel would be a
// lie told quietly. So the block goes in and the reading comes out, `SoundMeter`
// (sound_meter.h) does it, and it happens **under this lock** — twenty
// microseconds of interpolation per block, on the thread that was going to publish
// the frame anyway, against a lock nobody holds for longer than a `push_back`.
//
// **And it now carries frames as well, without the level changing at all.** The
// two questions monitoring asks have been answered where they belong — whose
// speakers is the system's own output, chosen nowhere until somebody asks for
// another (`ui/capture.js`), and feedback is *said* rather than suppressed,
// because guessing that a microphone and a pair of speakers are in the same room
// is exactly the kind of guess this application refuses. Neither answer changes
// what a meter needs, so `level` is untouched: it is still read-and-clear, still
// one caller, and a session with no monitor on it costs what it always cost.
//
// **The frames are a separate queue, and it only exists while something is
// listening.** Three decisions in that sentence:
//
//   - *Separate*, because the rules are opposite. `put` replaces (a picture that
//     was missed had its moment) and `heard` accumulates (a peak that was missed
//     is the one thing a meter is for); a monitor needs *every* block, in order,
//     because a gap in sound is audible in a way a repeated picture is not.
//   - *Bounded*, because a reader that stops taking must not become a leak. A
//     second of sound is the ceiling — see `kSoundHoldSeconds` — and past it the
//     oldest block goes, since a monitor that has fallen a second behind wants
//     the newest sound and not a growing delay.
//   - *Only while listening*, because a tap that queued sound nobody plays would
//     be a copy of every microphone in the session made for nobody. With no
//     listener `putSound` returns before it takes a reference, which is what
//     keeps monitoring genuinely off by default rather than merely quiet.
//
// **A queue per listener, not one queue with several readers.** A picture pad
// serves N elements from one slot with a sequence number each — see `take` —
// and the same trick cannot work for sound: two readers popping one queue would
// each get half the blocks and both would play a stutter. bro opens a source
// twice for a media element (once for the pipeline, once for the audio ring), so
// two readers on one pad is the ordinary case rather than the exotic one.
#pragma once

extern "C" {
#include <libavutil/frame.h>
}

#include "sound_meter.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace ffmpegbro {

/// How much sound one monitor may fall behind by before the oldest block is
/// dropped, in seconds.
///
/// One second, which is two decisions at once. It is *long* enough that nothing
/// short of a stall loses a block: bro tops its playback ring up to half a
/// second once a UI frame, so a monitor that gets one look every 16 ms is never
/// within sight of it. And it is *short* enough to be a bound worth having — at
/// 48 kHz stereo a second of held frames is about 400 kB per listener, so a
/// paused element in front of a running session costs that and stops, rather
/// than growing for as long as the session lives.
///
/// The alternative measured against was a block count (64, which was 1.4 s at
/// the 1024-sample blocks libavfilter happened to produce): a graph with
/// `asetnsamples` in it changes the block size, and a bound in blocks would then
/// silently be a bound of a different duration.
constexpr double kSoundHoldSeconds = 1.0;

/// One monitor's own queue of a sound pad's blocks.
///
/// Made by `LivePadTap::listen` and held by whoever is listening; the pad keeps
/// only a `weak_ptr`, so letting go of this is the whole of stopping — the pad
/// prunes what has expired on its next block and goes back to queueing nothing.
///
/// Its contents are touched only under the pad's lock, which is why there is
/// nothing to see here: a queue of its own with no lock of its own is the shape
/// that makes "publish to every listener" one critical section rather than N.
/// The destructor is the one exception and needs no lock — it runs when the last
/// reference goes, and the pad holds none.
class LiveSoundQueue {
public:
    LiveSoundQueue() = default;
    ~LiveSoundQueue() { for (auto& b : blocks_) av_frame_free(&b.first); }
    LiveSoundQueue(const LiveSoundQueue&) = delete;
    LiveSoundQueue& operator=(const LiveSoundQueue&) = delete;

private:
    friend class LivePadTap;
    /// Blocks in the order they arrived, each with the moment it did.
    std::deque<std::pair<AVFrame*, double>> blocks_;
    int64_t samples_ = 0;   ///< how many are queued, for the bound above
};

/// One published pad. Shared between the session that fills it and however many
/// elements are watching it.
class LivePadTap {
public:
    LivePadTap(std::string name, bool device) : name_(std::move(name)), device_(device) {}
    ~LivePadTap() { if (latest_) av_frame_free(&latest_); }

    LivePadTap(const LivePadTap&) = delete;
    LivePadTap& operator=(const LivePadTap&) = delete;

    const std::string& name() const { return name_; }
    bool isDevice() const { return device_; }

    /// The newest picture, referenced rather than copied. `at` is seconds on
    /// the session's own clock, which is what a reader turns into a timestamp.
    void put(const AVFrame* f, double at) {
        AVFrame* owned = av_frame_alloc();
        if (!owned) return;
        if (av_frame_ref(owned, f) < 0) { av_frame_free(&owned); return; }
        {
            std::lock_guard<std::mutex> lock(m_);
            if (latest_) av_frame_free(&latest_);
            latest_ = owned;
            at_ = at;
            ++seq_;
            width_ = f->width;
            height_ = f->height;
        }
        cv_.notify_all();
    }

    /// Nothing further will arrive. Every waiting reader is released and told.
    void finish() {
        { std::lock_guard<std::mutex> lock(m_); ended_ = true; }
        cv_.notify_all();
    }

    /// Wait for a picture this reader has not had yet.
    ///
    /// `since` is the reader's own high-water mark, updated on the way out —
    /// which is what makes several elements on one pad independent rather than
    /// racing for the same frame. Null back means the wait ran out (try again)
    /// or the session ended, told apart by `ended()`.
    ///
    /// The frame comes back **owned by the caller**, because the session is
    /// free to replace `latest_` the instant this returns.
    AVFrame* take(uint64_t* since, double* at, int waitMs) {
        std::unique_lock<std::mutex> lock(m_);
        if (!cv_.wait_for(lock, std::chrono::milliseconds(waitMs),
                          [&] { return ended_ || (latest_ && seq_ != *since); }))
            return nullptr;
        if (!latest_ || seq_ == *since) return nullptr;
        AVFrame* copy = av_frame_alloc();
        if (!copy) return nullptr;
        if (av_frame_ref(copy, latest_) < 0) { av_frame_free(&copy); return nullptr; }
        *since = seq_;
        *at = at_;
        return copy;
    }

    /// One block of sound went through this pad. Measure it.
    ///
    /// **Accumulated, not replaced — and this is the opposite rule to `put`.**
    /// A picture the reader missed had its moment and it has gone; a peak it
    /// missed is the one thing a meter exists to catch. Sound arrives in blocks
    /// of about a thousand samples and the UI looks sixty times a second, so
    /// several blocks pass between readings and the loudest of them is the
    /// answer. Power is summed over samples so that the RMS covers the same
    /// stretch the peak does, rather than being the last block's alone.
    ///
    /// **Called for every block whether or not anybody is listening**, which is
    /// the whole of what separates a meter from a monitor: `putSound` beside it
    /// takes a reference only when something is playing this pad, and a reading is
    /// what you can have without deciding anything.
    ///
    /// A pad that has only ever been given sound reports itself as sound: what
    /// a pad carries is a fact about the graph, and asking libavfilter for it
    /// again here would be a second answer to a question the drain has already
    /// answered by which of the two it called.
    void heard(const AVFrame* f) {
        if (!f || f->nb_samples <= 0) return;
        std::lock_guard<std::mutex> lock(m_);
        sound_ = true;
        meter_.add(f);
        // `seq_` is deliberately untouched: it exists to tell a picture reader
        // there is a frame it has not had, and a sound pad has no *picture*
        // reader — a monitor reads a queue of its own and never looks at this.
        // Bumping it would be inert — `take` needs `latest_` too — and inert is
        // the worst kind of wrong to leave in a counter two things share.
    }

    /// What each channel has done since this was last asked, and **the ask clears
    /// it**: a meter reads what has happened since it last looked, and a peak left
    /// standing would make a moment of clipping look permanent.
    ///
    /// False where no sound has been through since — which is not the same as
    /// silence, and is why the caller is told rather than handed a zero. A
    /// device that has stopped delivering would otherwise read as one delivering
    /// quiet.
    ///
    /// **A reading per channel and not one for the pad**, because the fault a
    /// meter catches that nothing else does is one channel of several: a mono
    /// summary of a stereo pair with a dead side is a perfectly healthy-looking
    /// number. See `ChannelLevel`.
    bool level(std::vector<ChannelLevel>* out) {
        std::lock_guard<std::mutex> lock(m_);
        return meter_.take(out);
    }

    bool isSound() const { std::lock_guard<std::mutex> lock(m_); return sound_; }

    // ── monitoring ─────────────────────────────────────────────────────────

    /// Start listening to this pad, with a queue of this listener's own.
    ///
    /// **Registering is what makes the pad carry sound at all** — see the note at
    /// the top — so this is not a subscription to something already happening.
    /// Nothing is queued before the first call and nothing after the last handle
    /// is dropped, which is what "monitoring is off by default" means down here.
    ///
    /// Kept as a `weak_ptr`, so a listener that goes away needs to say nothing:
    /// there is no `unlisten` to be forgotten in a destructor, and an element
    /// whose realm was torn down cannot leave a queue growing behind it.
    std::shared_ptr<LiveSoundQueue> listen() {
        auto q = std::make_shared<LiveSoundQueue>();
        std::lock_guard<std::mutex> lock(m_);
        ears_.push_back(q);
        return q;
    }

    /// One block of sound, for whoever is listening — and for nobody else.
    ///
    /// Called from the session's own loop beside `heard`, and the pair is
    /// deliberate: the level is measured whether or not anybody is monitoring,
    /// and the frame is referenced only if somebody is. `at` is seconds on the
    /// session's clock, which is what the reader turns into a timestamp.
    ///
    /// A reference per listener rather than one shared frame, because each queue
    /// hands its blocks out as owned frames and libav's refcount is what makes
    /// that free — two listeners on one microphone copy no samples.
    void putSound(const AVFrame* f, double at) {
        if (!f || f->nb_samples <= 0) return;
        bool any = false;
        {
            std::lock_guard<std::mutex> lock(m_);
            // Said here as well as in `heard` because either one alone is enough
            // to make this a sound pad, and `isSound` is what decides whether a
            // reader looks for frames or for a level.
            if (!ears_.empty()) sound_ = true;
            const int rate = f->sample_rate > 0 ? f->sample_rate : 48000;
            rate_ = rate;   // so a backlog can be quoted in seconds
            const int64_t hold = static_cast<int64_t>(kSoundHoldSeconds * rate);
            for (auto it = ears_.begin(); it != ears_.end();) {
                std::shared_ptr<LiveSoundQueue> q = it->lock();
                if (!q) { it = ears_.erase(it); continue; }
                ++it;
                AVFrame* owned = av_frame_alloc();
                if (!owned) continue;
                if (av_frame_ref(owned, f) < 0) { av_frame_free(&owned); continue; }
                q->blocks_.push_back({owned, at});
                q->samples_ += f->nb_samples;
                any = true;
                // The oldest goes, not the newest: a monitor a second behind
                // wants the sound that is happening, and dropping what has just
                // arrived would hold it there for ever. One block always stays,
                // so a reader that looks after a very long pause finds sound
                // rather than an empty queue it cannot tell from a stall.
                while (q->samples_ > hold && q->blocks_.size() > 1) {
                    AVFrame* old = q->blocks_.front().first;
                    q->samples_ -= old->nb_samples;
                    av_frame_free(&old);
                    q->blocks_.pop_front();
                }
            }
        }
        if (any) cv_.notify_all();
    }

    /// How much sound the fullest listener is holding, in seconds — and **−1
    /// when nobody is listening at all**, which is a different answer rather than
    /// a zero.
    ///
    /// One call for the two questions because a producer needs them together: it
    /// is what a source of sound reads to decide whether to make more. With a
    /// listener that is falling behind, the room in the queue *is* the pacing —
    /// a render feeding a monitor runs at exactly the rate the monitor drains it,
    /// which is real time, and no clock has to be consulted to arrange that. With
    /// nobody listening there is no such regulator and the caller has to pace
    /// itself; see `playback_output.h`.
    double soundBacklog() const {
        std::lock_guard<std::mutex> lock(m_);
        const int rate = rate_ > 0 ? rate_ : 48000;
        double most = -1.0;
        for (const auto& w : ears_) {
            if (auto q = w.lock())
                most = std::max(most, static_cast<double>(q->samples_) / rate);
        }
        return most;
    }

    /// The next block this listener has not had, **owned by the caller**, or null
    /// when the wait ran out (try again) or the session ended (`ended()`).
    ///
    /// The same shape as `take` and for the same reason: bro pumps a source until
    /// it has something whose time has not come, so "nothing yet" cannot be
    /// answered with "the stream ended". What differs is that this pops — a
    /// picture reader has a high-water mark into one slot, and a monitor has a
    /// queue that empties, because it owes every block.
    AVFrame* takeSound(LiveSoundQueue& q, double* at, int waitMs) {
        std::unique_lock<std::mutex> lock(m_);
        if (!cv_.wait_for(lock, std::chrono::milliseconds(waitMs),
                          [&] { return ended_ || !q.blocks_.empty(); }))
            return nullptr;
        if (q.blocks_.empty()) return nullptr;
        AVFrame* f = q.blocks_.front().first;
        if (at) *at = q.blocks_.front().second;
        q.samples_ -= f->nb_samples;
        q.blocks_.pop_front();
        return f;
    }

    bool ended() const { std::lock_guard<std::mutex> lock(m_); return ended_; }
    /// What this pad turned out to be, once a frame has been through it.
    void size(int* w, int* h) const {
        std::lock_guard<std::mutex> lock(m_);
        *w = width_;
        *h = height_;
    }

private:
    const std::string name_;
    const bool device_;
    mutable std::mutex m_;
    std::condition_variable cv_;
    AVFrame* latest_ = nullptr;
    double at_ = 0.0;
    uint64_t seq_ = 0;
    bool ended_ = false;
    int width_ = 0;
    int height_ = 0;
    bool sound_ = false;
    /// What this pad's sound has been doing since somebody last asked. Guarded by
    /// `m_` like everything else here — see the note at the top about measuring
    /// under the lock.
    SoundMeter meter_;
    /// Everyone monitoring this pad. Weak, so that stopping is letting go — see
    /// `listen` — and pruned by `putSound` rather than by anybody's destructor.
    std::vector<std::weak_ptr<LiveSoundQueue>> ears_;
    int rate_ = 0;   ///< of the last block through, for `soundBacklog`
};

/// Every pad of one session.
///
/// Held by `shared_ptr` from both ends, so that closing a session while an
/// element is still reading one of its pads leaves that element with a tap that
/// says "ended" rather than with a dangling pointer. The session's *devices*
/// are released the moment it is closed; this outlives it by however long the
/// last reader takes to notice.
class LiveTap {
public:
    /// The pad by that name, or null. Pads are made when the session starts and
    /// never removed, so this needs no lock beyond the one guarding the list
    /// while the graph is still settling.
    std::shared_ptr<LivePadTap> pad(const std::string& name) const {
        std::lock_guard<std::mutex> lock(m_);
        for (const auto& p : pads_) if (p->name() == name) return p;
        return nullptr;
    }

    std::vector<std::shared_ptr<LivePadTap>> all() const {
        std::lock_guard<std::mutex> lock(m_);
        return pads_;
    }

    /// The pad by that name, made if it is not there yet. The graph's own pads
    /// are not known until libavfilter has configured it, which is why this
    /// exists rather than a list settled up front.
    std::shared_ptr<LivePadTap> ensure(const std::string& name, bool device) {
        std::lock_guard<std::mutex> lock(m_);
        for (const auto& p : pads_) if (p->name() == name) return p;
        pads_.push_back(std::make_shared<LivePadTap>(name, device));
        return pads_.back();
    }

    void finishAll() {
        for (const auto& p : all()) p->finish();
    }

private:
    mutable std::mutex m_;
    std::vector<std::shared_ptr<LivePadTap>> pads_;
};

/// The tap of an open session, for the media backend to find by id. Null for an
/// id nothing is open under — which is the ordinary answer a moment after a
/// session is closed, and what makes `/@live/…` a token rather than a handle.
std::shared_ptr<LiveTap> liveTapFor(uint64_t id);

} // namespace ffmpegbro
