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
// **A sound pad keeps a level and not a queue.** Playing a session's mix is
// monitoring, and monitoring asks questions a preview does not — whose
// speakers, and what happens when the microphone can hear them. What can be
// answered without asking any of them is *how loud is it*, which is the reading
// somebody wants before a take rather than after it. So a sound pad holds two
// numbers instead of a frame, and they are accumulated rather than replaced:
// see `heard`.
#pragma once

extern "C" {
#include <libavutil/frame.h>
}

#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ffmpegbro {

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

    /// One block of sound went through this pad, already measured.
    ///
    /// **Accumulated, not replaced — and this is the opposite rule to `put`.**
    /// A picture the reader missed had its moment and it has gone; a peak it
    /// missed is the one thing a meter exists to catch. Sound arrives in blocks
    /// of about a thousand samples and the UI looks sixty times a second, so
    /// several blocks pass between readings and the loudest of them is the
    /// answer. Power is summed over samples so that the RMS covers the same
    /// stretch the peak does, rather than being the last block's alone.
    ///
    /// A pad that has only ever been given sound reports itself as sound: what
    /// a pad carries is a fact about the graph, and asking libavfilter for it
    /// again here would be a second answer to a question the drain has already
    /// answered by which of the two it called.
    void heard(float peak, double power, int samples) {
        std::lock_guard<std::mutex> lock(m_);
        sound_ = true;
        if (peak > peak_) peak_ = peak;
        power_ += power;
        samples_ += samples;
        // `seq_` is deliberately untouched: it exists to tell a picture reader
        // there is a frame it has not had, and a sound pad has no such reader.
        // Bumping it would be inert — `take` needs `latest_` too — and inert is
        // the worst kind of wrong to leave in a counter two things share.
    }

    /// The loudest sample and the RMS since this was last asked, and **the ask
    /// clears them**: a meter reads what has happened since it last looked, and
    /// a peak left standing would make a moment of clipping look permanent.
    ///
    /// False where no sound has been through since — which is not the same as
    /// silence, and is why the caller is told rather than handed a zero. A
    /// device that has stopped delivering would otherwise read as one delivering
    /// quiet.
    bool level(float* peak, float* rms) {
        std::lock_guard<std::mutex> lock(m_);
        if (samples_ <= 0) return false;
        *peak = peak_;
        *rms = static_cast<float>(std::sqrt(power_ / static_cast<double>(samples_)));
        peak_ = 0.0f;
        power_ = 0.0;
        samples_ = 0;
        return true;
    }

    bool isSound() const { std::lock_guard<std::mutex> lock(m_); return sound_; }

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
    float peak_ = 0.0f;
    double power_ = 0.0;   ///< sum of sample², over `samples_` samples
    int64_t samples_ = 0;
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
