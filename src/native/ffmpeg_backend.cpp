#include "ffmpeg_backend.h"
#include "backend_internal.h"

#include "ffmpeg_capture.h"
#include "playback_filter.h"

// For `rotationOf` and `avErr`. This file is the MIT-facing half and used to
// include none of the encode headers, keeping its own copy of both — which was
// tolerable while they were four lines each and stopped being so when a display
// matrix had to be read the same way at both ends. **Rotation has one answer in
// this binary**: the export reader turns the picture with it, the playback
// backend reports it to bro, and the probe tells the UI, and two of those
// reading the side datum with arithmetic of their own is how a file comes to be
// laid out at one size and rendered at another. `export_frame.cpp` is in the
// same static library, so this costs nothing but the include.
#include "export_frame.h"

#include "util/log.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace ffmpegbro {
namespace backend_detail {
namespace {

// ── A pad of a live session, as a media source ─────────────────────────────
//
// `<video src="/@live/7/vout">` plays what session 7's graph is making of its
// devices, right now. It is the only source in this backend with no demuxer
// behind it: what would be `av_read_frame` is a wait on a condition variable,
// and what would be a compressed packet is a picture that was never compressed.
//
// **It reaches the element as `wrapped_avframe`**, which is not a trick — it is
// the same thing lavfi does and the same thing this backend already carries for
// it. A live pad and a lavfi device are the same shape of problem (frames that
// were never bytes) and there is one answer to it in this file, which is why
// there is no live decoder: `FFmpegVideoDecoder` unwraps this exactly as it
// unwraps a `-f lavfi -i testsrc`.
//
// **A sound pad is the same source with one track of the other kind.** `/@live/
// <id>/aout` opens as a single audio track and the sound goes to bro's mixer
// through `FFmpegAudioDecoder`'s wrapped path, which already existed for
// `-f lavfi -i sine`. Two things make it a different reader rather than the same
// one with a flag: it takes from a queue of its own rather than from a
// latest-frame slot (see `LivePadTap::takeSound` for why sound cannot share one),
// and it registers as a listener, which is what makes the session queue anything
// at all. So an element pointed at a sound pad *is* the monitoring decision, and
// letting go of it is the whole of switching it off.
//
// Sound-only is a shape bro plays: `VideoPipeline` opens a source with no video
// track, keeps the clock and the length, asks it for no packets at all, and the
// element's sound comes from a *second* open of the same src feeding a broaudio
// ring. Both of those opens land here, which is why a pad hands each listener its
// own queue and why the pipeline's copy drops its listener the moment it is told
// it wants no tracks — see `setActiveTracks`.
//
// Three things about the clock, and each of them is what makes an element play
// rather than stall:
//
//   - **The source's zero is its own first frame**, not the session's start. An
//     element's clock begins when it begins, and a session that has been
//     running for ten minutes would otherwise hand it timestamps ten minutes in
//     the future and never show a picture.
//   - **A frame is published one tick ahead.** bro pumps a source until it holds
//     a picture whose time has *not yet come* — that is how it knows the one on
//     screen is the right one — so a frame stamped exactly now would be
//     consumed and pumped past, and the loop would ask again immediately.
//   - **`readPacket` blocks, and must.** "Nothing yet" cannot be answered with
//     false: bro reads that as the end of the stream and stops the element for
//     good. So it waits, the way reading a camera waits, and answers false only
//     when the session has genuinely finished.
class LiveSource : public MediaSource {
public:
    /// `/@live/<id>/<pad>`. False for anything that is not one, which is how
    /// the backend's `open` falls through to a path or an input token.
    static bool parse(const std::string& src, uint64_t* id, std::string* pad) {
        constexpr const char* kPrefix = "/@live/";
        if (src.compare(0, std::strlen(kPrefix), kPrefix) != 0) return false;
        const size_t at = src.find('/', std::strlen(kPrefix));
        if (at == std::string::npos) return false;
        const std::string num = src.substr(std::strlen(kPrefix),
                                           at - std::strlen(kPrefix));
        if (num.empty() || num.find_first_not_of("0123456789") != std::string::npos)
            return false;
        *id = std::strtoull(num.c_str(), nullptr, 10);
        *pad = src.substr(at + 1);
        return !pad->empty();
    }

    bool open(const std::string& src) {
        uint64_t id = 0;
        std::string name;
        if (!parse(src, &id, &name)) return false;
        auto tap = liveTapFor(id);
        if (!tap) return false;
        // Held as well as the pad, so that closing the session while this is
        // playing leaves a tap that says "ended" rather than a freed one.
        tap_ = tap;

        // **Waited for, not merely looked up.** A session's device pads exist
        // the instant it opens, but the graph's do not: their names are the
        // graph's and libavfilter cannot configure until a camera has handed
        // over a frame. An element pointed at `vout` a moment too early would
        // otherwise fail for good — bro opens a source once — which would make
        // this API's correctness a matter of the caller's timing.
        for (int waited = 0; !pad_ && waited < kPadWaitMs; waited += kSliceMs) {
            pad_ = tap->pad(name);
            if (!pad_)
                std::this_thread::sleep_for(std::chrono::milliseconds(kSliceMs));
        }
        if (!pad_) {
            LOG_WARN("ffmpeg: live session %llu publishes no pad called %s",
                     static_cast<unsigned long long>(id), name.c_str());
            return false;
        }

        if (pad_->isSound()) return openSound(src);

        // **Described from a real frame**, because a track has to say how big
        // it is and a pad does not know until the graph has configured and the
        // camera has woken up. Bounded: a pad nothing ever reaches is a black
        // element, not a hung one. Normally instant — the session is started
        // before anything is pointed at it.
        double at = 0.0;
        AVFrame* first = nullptr;
        for (int waited = 0; waited < kOpenWaitMs && !first; waited += kSliceMs) {
            first = pad_->take(&seen_, &at, kSliceMs);
            if (!first && pad_->ended()) break;
        }
        if (!first) {
            LOG_WARN("ffmpeg: live pad %s produced no picture to open with", src.c_str());
            return false;
        }

        TrackInfo t;
        t.id = 1;
        t.kind = TrackKind::Video;
        t.codec = Codec::Other;
        t.width = static_cast<uint32_t>(first->width);
        t.height = static_cast<uint32_t>(first->height);
        t.frameRate = 0.0;   // whatever the session ticks at; nothing here counts
        t.durationNs = 0;    // live: there is no end to seek to

        auto priv = std::make_shared<TrackPrivate>();
        priv->par = avcodec_parameters_alloc();
        if (!priv->par) { av_frame_free(&first); return false; }
        priv->par->codec_type = AVMEDIA_TYPE_VIDEO;
        priv->par->codec_id = AV_CODEC_ID_WRAPPED_AVFRAME;
        priv->par->width = first->width;
        priv->par->height = first->height;
        priv->par->format = first->format;
        priv->timeBase = AVRational{1, 1000000};
        priv->wrapped = true;
        t.backendPrivate = priv;
        tracks_.push_back(std::move(t));

        zero_ = at;
        pending_ = first;
        pendingAt_ = at;
        return true;
    }

    const std::vector<TrackInfo>& tracks() const override { return tracks_; }

    /// A camera produces in real time, so there is a stretch of every frame in
    /// which the next block genuinely does not exist yet — and the caller that
    /// asks this is the one that must not stand still for it.
    bool packetReady() const override {
        if (!pad_) return true;   // gone: readPacket says so at once
        if (pending_) return true;
        if (ears_) return pad_->soundReady(*ears_);
        return true;   // the picture is read on the pipeline's own thread
    }

    bool readPacket(MediaPacket& out) override {
        if (!pad_) return false;
        AVFrame* f = pending_;
        double at = pendingAt_;
        pending_ = nullptr;
        for (int waited = 0; !f && waited < kReadWaitMs; waited += kSliceMs) {
            f = ears_ ? pad_->takeSound(*ears_, &at, kSliceMs)
                      : pad_->take(&seen_, &at, kSliceMs);
            // Ended *and* empty is the only false this returns. A session torn
            // down mid-watch stops the element, which is what has happened.
            if (!f && pad_->ended()) return false;
        }
        if (!f) return false;

        // One tick of lead, so the picture stages rather than being consumed
        // and pumped straight past. See the note at the top.
        //
        // **Sound gets none of it**, and that is not an omission: the lead exists
        // because bro decides which picture is current by finding one whose time
        // has not come, and there is no such comparison for samples — the ring
        // takes every block in order and plays it when it reaches it. A lead here
        // would be a block of silence at the front of the monitor.
        const double lead = ears_ ? 0.0 : 1.0 / 30.0;
        const double secs = std::max(0.0, at - zero_) + lead;
        out.trackId = 1;
        out.codec = Codec::Other;
        out.kind = ears_ ? TrackKind::Audio : TrackKind::Video;
        out.keyframe = true;         // every one of them is
        out.pts = static_cast<TimeNs>(llround(secs * 1e9));
        out.duration = 0;
        out.data = wrapOwnedFrame(f);   // takes the reference this holds
        return out.data != nullptr;
    }

    /// Which of this source's tracks the caller still wants — and for a sound pad
    /// it is how monitoring stops.
    ///
    /// bro opens a sound-only source twice: `VideoPipeline` takes one for the
    /// clock and immediately says it wants *no* tracks (there are no pictures for
    /// it to pump), and `ElVideo` opens a second for the audio ring. Dropping the
    /// listener when the answer is "none" is what keeps the first of those from
    /// holding a queue the session fills for nobody — a bounded leak, but a
    /// pointless one, and this is the moment the engine tells us it is pointless.
    void setActiveTracks(const std::vector<uint32_t>& trackIds) override {
        if (!ears_) return;
        for (uint32_t id : trackIds) if (id == 1) return;
        ears_.reset();
    }

    // Live: there is nowhere to go but now.
    bool seekTo(TimeNs) override { return false; }

    ~LiveSource() override { if (pending_) av_frame_free(&pending_); }

private:
    /// A sound pad, as one audio track. Called by `open` once the pad turns out
    /// to be one; everything before this point is the same lookup.
    ///
    /// **Listening starts before the first block is waited for**, in that order
    /// and not the other: a pad queues nothing until it has a listener, so a wait
    /// that came first would be a wait for sound that was being thrown away.
    ///
    /// Described from a real block for the reason the picture path is: the rate
    /// and the layout are the *graph's*, settled when libavfilter configured
    /// itself, and the session's own settings are what it was asked for rather
    /// than what came out. Asking the frame is one answer instead of two.
    bool openSound(const std::string& src) {
        ears_ = pad_->listen();

        double at = 0.0;
        AVFrame* first = nullptr;
        for (int waited = 0; waited < kOpenWaitMs && !first; waited += kSliceMs) {
            first = pad_->takeSound(*ears_, &at, kSliceMs);
            if (!first && pad_->ended()) break;
        }
        if (!first) {
            LOG_WARN("ffmpeg: live pad %s produced no sound to open with", src.c_str());
            return false;
        }
        if (first->sample_rate <= 0 || first->ch_layout.nb_channels <= 0) {
            av_frame_free(&first);
            return false;
        }

        TrackInfo t;
        t.id = 1;
        t.kind = TrackKind::Audio;
        t.codec = Codec::Other;
        t.sampleRate = static_cast<uint32_t>(first->sample_rate);
        t.channels = static_cast<uint32_t>(first->ch_layout.nb_channels);
        t.durationNs = 0;    // live: there is no end to seek to

        auto priv = std::make_shared<TrackPrivate>();
        priv->par = avcodec_parameters_alloc();
        if (!priv->par) { av_frame_free(&first); return false; }
        priv->par->codec_type = AVMEDIA_TYPE_AUDIO;
        priv->par->codec_id = AV_CODEC_ID_WRAPPED_AVFRAME;
        priv->par->format = first->format;
        priv->par->sample_rate = first->sample_rate;
        if (av_channel_layout_copy(&priv->par->ch_layout, &first->ch_layout) < 0) {
            av_frame_free(&first);
            return false;
        }
        priv->timeBase = AVRational{1, 1000000};
        priv->wrapped = true;
        t.backendPrivate = priv;
        tracks_.push_back(std::move(t));

        zero_ = at;
        pending_ = first;
        pendingAt_ = at;
        return true;
    }

    static constexpr int kSliceMs = 100;
    /// How long a pad that is not there yet is waited for. Shorter than the
    /// frame wait below and deliberately so: this is `open`, which is called on
    /// whichever thread set the `src`, and a *name* that never appears is a
    /// mistake rather than a slow camera. The caller that has just listed the
    /// pads never spends any of it.
    static constexpr int kPadWaitMs = 1500;
    static constexpr int kOpenWaitMs = 4000;
    static constexpr int kReadWaitMs = 4000;

    std::shared_ptr<LiveTap> tap_;
    std::shared_ptr<LivePadTap> pad_;
    /// This reader's queue of sound, and — being the pad's only strong reference
    /// to it — the monitoring itself: null for a picture pad, and dropping it
    /// stops the session queueing for this reader.
    std::shared_ptr<LiveSoundQueue> ears_;
    std::vector<TrackInfo> tracks_;
    uint64_t seen_ = 0;
    double zero_ = 0.0;
    AVFrame* pending_ = nullptr;   ///< the frame `open` described the track with
    double pendingAt_ = 0.0;
};

// ── MediaSource ────────────────────────────────────────────────────────────

class FFmpegSource : public MediaSource {
public:
    ~FFmpegSource() override {
        if (pkt_) av_packet_free(&pkt_);
        if (fmt_) avformat_close_input(&fmt_);
    }

    bool open(const MediaInput& in, const PlaybackView* view = nullptr) {
        std::string why;
        if (!openInput(&fmt_, in, &why)) {
            // Not this backend's file, unreadable, or opened with an option
            // nothing took. The first is the registry's ordinary "no thanks"
            // and says nothing; the other two are worth a line, because a
            // `<video>` that stays black over a typo in an option is the
            // failure this whole chunk is against — and libav's own message
            // already went to the report channel from av_log.
            if (!in.format.empty() || !in.options.empty())
                LOG_WARN("ffmpeg: %s", why.c_str());
            fmt_ = nullptr;
            return false;
        }

        pkt_ = av_packet_alloc();
        if (!pkt_) return false;

        // Where this input's zero is: the container's own start time, which
        // was always subtracted so the stream begins at 0 the way bro's clock
        // expects, plus whatever `-ss` and `-itsoffset` say. Taken once and
        // applied to all tracks so a/v stay in sync relative to each other.
        startOffsetNs_ = static_cast<TimeNs>(
            llround(inputEpoch(in, fmt_->start_time != AV_NOPTS_VALUE
                                       ? fmt_->start_time / double(AV_TIME_BASE) : 0.0) * 1e9));
        limitNs_ = static_cast<TimeNs>(llround(inputLimit(in) * 1e9));
        loop_.configure(fmt_, in);
        // `-stream_loop` and `-loop 1` both make an input that outlives what
        // the container says it is, so the cut at `-t` is the only thing that
        // ends it — and without a `-t` there is nothing to end it at, which is
        // reported as a duration of zero rather than papered over.
        endless_ = inputIsEndless(in);

        // A window makes the tracks as long as the window, because a clip's
        // length comes from its video track's duration and an input cut down
        // by `-t` is not as long as its file. Seeking is left to land where it
        // lands: the pipeline asks for times on this clock and `seekTo` puts
        // the offset back.
        const double formatSeconds =
            fmt_->duration != AV_NOPTS_VALUE
                ? fmt_->duration / double(AV_TIME_BASE)
                : 0.0;
        const TimeNs formatDuration =
            static_cast<TimeNs>(llround(inputDuration(in, formatSeconds) * 1e9));

        // **Filters before tracks**, because a filtered track is described by
        // what its chain produces and nothing outside libavfilter knows that
        // until the graph has been configured with real formats at the top. So
        // the first frame is decoded here, the sink is asked how big it is, and
        // the track that goes to bro is the *output* of the chain — which is
        // what makes a `crop` play as a cropped picture rather than as a full
        // one with a hole in it.
        if (view && !attachFilters(*view, in, &why)) {
            // Not fallen back to the unfiltered stream. A chain that will not
            // run and a picture that plays anyway is the exact failure this
            // whole path exists against: it would look like the filter doing
            // nothing. `settleView` is what a caller asks *before* pointing an
            // element here, so this is the unexpected half and it says so.
            LOG_WARN("ffmpeg: %s", why.c_str());
            return false;
        }

        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            AVStream* st = fmt_->streams[i];
            AVCodecParameters* par = st->codecpar;
            const bool isVideo = par->codec_type == AVMEDIA_TYPE_VIDEO;
            const bool isAudio = par->codec_type == AVMEDIA_TYPE_AUDIO;
            if (!isVideo && !isAudio) continue;
            // Cover art and thumbnails are single still frames stapled into an
            // audio file; treating one as the video track would "play" a JPEG.
            if (isVideo && (st->disposition & AV_DISPOSITION_ATTACHED_PIC)) continue;

            // The chain on this stream, if it has one. Everything below asks it
            // rather than the container wherever the two can disagree.
            const StreamFilter* fx = filterFor(static_cast<int>(i));

            TrackInfo t;
            // bro treats track id 0 as "unset", and stream 0 is a perfectly
            // ordinary stream, so shift by one.
            t.id = static_cast<uint32_t>(i) + 1;
            t.kind = isVideo ? TrackKind::Video : TrackKind::Audio;
            t.codec = fx ? Codec::Other : toBroCodec(par->codec_id);
            if (isVideo) {
                t.width = static_cast<uint32_t>(fx ? fx->width() : par->width);
                t.height = static_cast<uint32_t>(fx ? fx->height() : par->height);
                // Phones record landscape frames and write the correction into
                // the container rather than turning the pixels, so this is the
                // only thing that says a 1920x1080 clip is shown 1080x1920.
                // `width`/`height` stay the size of what the decoder produces —
                // the swap is bro's, in `VideoPipeline::displayWidth` — because
                // this is metadata about the picture and not a property of it.
                //
                // **A filtered track reports none**, because its turn has
                // already happened: the filters have to see the picture the
                // right way up (`crop=iw/2` means one thing on a portrait
                // picture and another on the landscape frames the decoder
                // produces), so the transpose is at the top of the chain and
                // saying it again here would turn it twice.
                t.rotationDegrees = fx ? 0 : rotationOf(st);
                // Prefers the container's declared rate and falls back to one
                // measured from the timestamps, which is what makes this
                // sensible for a variable-frame-rate phone capture.
                const AVRational fr = av_guess_frame_rate(fmt_, st, nullptr);
                if (fr.num > 0 && fr.den > 0) t.frameRate = av_q2d(fr);
            } else {
                t.sampleRate = static_cast<uint32_t>(fx ? fx->sampleRate() : par->sample_rate);
                t.channels =
                    static_cast<uint32_t>(fx ? fx->channels() : par->ch_layout.nb_channels);
            }
            if (par->extradata && par->extradata_size > 0) {
                t.codecPrivate.assign(par->extradata,
                                      par->extradata + par->extradata_size);
            }
            t.durationNs = st->duration != AV_NOPTS_VALUE && !endless_
                               ? static_cast<TimeNs>(llround(
                                     inputDuration(in, st->duration * av_q2d(st->time_base)) * 1e9))
                               : formatDuration;

            auto priv = std::make_shared<TrackPrivate>();
            priv->par = avcodec_parameters_alloc();
            if (!priv->par || avcodec_parameters_copy(priv->par, par) < 0) return false;
            priv->timeBase = st->time_base;
            priv->streamIndex = static_cast<int>(i);
            priv->input = in;
            priv->wrapped = par->codec_id == AV_CODEC_ID_WRAPPED_AVFRAME;
            // A filtered stream arrives as frames, so the decoder built from
            // this track opens no codec and unwraps — the same crossing lavfi
            // and a live pad already use. What the parameters have to say is
            // therefore what the *chain* produces, since that is what the
            // frames are: the codec id is the marker and the formats beside it
            // are what the far end describes its output with.
            if (fx) {
                priv->wrapped = true;
                priv->par->codec_id = AV_CODEC_ID_WRAPPED_AVFRAME;
                priv->par->format = fx->format();
                if (isVideo) {
                    priv->par->width = fx->width();
                    priv->par->height = fx->height();
                } else {
                    priv->par->sample_rate = fx->sampleRate();
                    if (fx->layout())
                        av_channel_layout_copy(&priv->par->ch_layout, fx->layout());
                }
            }
            t.backendPrivate = priv;

            if (isVideo && videoStreamIndex_ < 0) videoStreamIndex_ = static_cast<int>(i);
            tracks_.push_back(std::move(t));
        }

        return !tracks_.empty();
    }

    const std::vector<TrackInfo>& tracks() const override { return tracks_; }

    bool readPacket(MediaPacket& out) override {
        if (!fmt_ || !pkt_) return false;
        for (;;) {
            // **What the graph is already holding comes out first.** A filter
            // can answer one packet with several frames — or with none, and
            // then with two — so the frames it has produced have to be drained
            // before another packet goes in, or the element is handed pictures
            // in the wrong order.
            if (emitFiltered(out)) return true;
            if (drained_) return false;

            av_packet_unref(pkt_);
            int rc = loop_.read(fmt_, pkt_);
            if (rc < 0) {
                // The end of the file is not the end of a filter: `tpad`,
                // `tblend` and anything with a delay in it hold frames back
                // until they are told there is no more. So the chains are
                // flushed and drained, and only then is this stream over.
                if (filtered_.empty()) return false;
                drained_ = true;
                for (auto& f : filtered_) {
                    std::string why;
                    f->filter->push(nullptr, &why);
                }
                continue;
            }

            if (StreamFilter* f = filterFor(pkt_->stream_index)) {
                std::string why;
                if (!f->push(pkt_, &why)) {
                    LOG_WARN("ffmpeg: %s", why.c_str());
                    return false;
                }
                continue;
            }

            const uint32_t trackId = static_cast<uint32_t>(pkt_->stream_index) + 1;
            auto it = std::find_if(tracks_.begin(), tracks_.end(),
                                   [&](const TrackInfo& t) { return t.id == trackId; });
            if (it == tracks_.end()) continue;   // a stream we don't expose

            AVStream* st = fmt_->streams[pkt_->stream_index];
            int64_t ts = pkt_->pts != AV_NOPTS_VALUE ? pkt_->pts : pkt_->dts;
            TimeNs pts = ts != AV_NOPTS_VALUE ? toNs(ts, st->time_base) - startOffsetNs_ : 0;
            // Past `-t` this input has ended, and the end of an input is the
            // end of the stream as far as everything above here is concerned.
            if (limitNs_ > 0 && pts >= limitNs_) return false;
            if (pts < 0) pts = 0;

            // After a seek, skip audio packets that arrived before the
            // target. The seek lands on a video keyframe, which can be
            // seconds before the requested time; the video pipeline decodes
            // from the keyframe and drops pre-target frames itself, but
            // audio has no such mechanism — the ring fills from wherever
            // the demuxer landed. Without this, a seek into a file with
            // 2 s keyframe spacing plays up to 2 s of audio from before
            // the moment that is on screen.
            if (seekFloorNs_ > 0 && it->kind == TrackKind::Audio) {
                if (pts < seekFloorNs_) continue;
                seekFloorNs_ = 0;
            }

            out.trackId = trackId;
            out.codec = it->codec;
            out.kind = it->kind;
            out.keyframe = (pkt_->flags & AV_PKT_FLAG_KEY) != 0;
            out.pts = pts;
            out.duration = pkt_->duration > 0 ? toNs(pkt_->duration, st->time_base) : 0;
            // A `wrapped_avframe` packet is a pointer to a decoded frame, and
            // its bytes are meaningless once this packet is unreferenced. See
            // `Wrapped` above: the frame travels as itself, owned by the
            // payload, and the paired decoder is the only thing that looks.
            if (st->codecpar->codec_id == AV_CODEC_ID_WRAPPED_AVFRAME) {
                out.data = wrapFrame(pkt_);
                if (!out.data) continue;   // not the shape it claimed; skip it
            } else {
                out.data = std::make_shared<std::vector<uint8_t>>(
                    pkt_->data, pkt_->data + pkt_->size);
            }
            return true;
        }
    }

    void setActiveTracks(const std::vector<uint32_t>& trackIds) override {
        if (!fmt_) return;
        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            const uint32_t id = i + 1;
            const bool keep = std::find(trackIds.begin(), trackIds.end(), id) != trackIds.end();
            // AVDISCARD_ALL stops the demuxer handing us the packet at all,
            // so an unwanted 1080p video track costs nothing to skip past.
            fmt_->streams[i]->discard = keep ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
        }
    }

    bool seekTo(TimeNs pts) override {
        if (!fmt_) return false;
        const int idx = videoStreamIndex_;
        // With `-stream_loop` the clock above here is continuous across the
        // passes and the file's is not, so the loop is told first which pass
        // the target is in and the demuxer is only ever asked for a moment
        // inside one.
        if (loop_.looping()) {
            double within = 0;
            loop_.seekTo(pts / 1e9, &within);
            pts = static_cast<TimeNs>(llround(within * 1e9));
        }
        // Rounded DOWN, not to nearest. The contract is "at or before", and a
        // container tick is tens of microseconds wide — rounding to nearest
        // can carry a target that sits just below a frame up onto it, and a
        // seek meant to land before a keyframe lands on it instead.
        const AVRational tb = idx >= 0 ? fmt_->streams[idx]->time_base : AV_TIME_BASE_Q;
        const int64_t target =
            av_rescale_q_rnd(pts + startOffsetNs_, kNsTimeBase, tb, AV_ROUND_DOWN);
        // BACKWARD lands on the keyframe at or before the target; the pipeline
        // decodes forward from there and drops what it doesn't need.
        int rc = av_seek_frame(fmt_, idx, target, AVSEEK_FLAG_BACKWARD);
        if (rc < 0) {
            LOG_WARN("ffmpeg: seek to %.3fs failed: %s", pts / 1e9, avErr(rc).c_str());
            return false;
        }
        // Every chain starts again from where the seek landed, decoder and
        // graph both — see `StreamFilter::reset`. A frame from before the seek
        // is a frame from somewhere else.
        // Audio packets between the keyframe and the target are skipped
        // in `readPacket` and `emitFiltered` — see the floor logic there.
        seekFloorNs_ = pts;
        drained_ = false;
        for (auto& f : filtered_) {
            f->filter->reset();
            if (f->pending) av_frame_free(&f->pending);
        }
        return true;
    }

private:
    /// One filtered stream: the chain, which track it feeds, and the frame that
    /// has come out of it and is waiting its turn.
    ///
    /// A `pending` per chain and not one queue between them, because the two
    /// are pulled independently and picking which to hand over is a comparison
    /// of two timestamps — see `emitFiltered`.
    struct Filtered {
        std::unique_ptr<StreamFilter> filter;
        uint32_t trackId = 0;
        TrackKind kind = TrackKind::Video;
        AVRational timeBase{1, 1000};
        AVFrame* pending = nullptr;
        ~Filtered() { if (pending) av_frame_free(&pending); }
    };

    /// Build the chains this view asks for, one per kind, and settle them.
    ///
    /// The first stream of each kind, which is the one playback shows: a view
    /// is a clip's filters and a clip is a picture and a sound, not a container
    /// full of alternate angles.
    bool attachFilters(const PlaybackView& view, const MediaInput& in, std::string* err) {
        for (int pass = 0; pass < 2; ++pass) {
            const bool audio = pass == 1;
            const std::string& chain = audio ? view.audio : view.video;
            if (chain.empty()) continue;
            const AVMediaType want = audio ? AVMEDIA_TYPE_AUDIO : AVMEDIA_TYPE_VIDEO;
            int index = -1;
            for (unsigned i = 0; i < fmt_->nb_streams && index < 0; ++i) {
                if (fmt_->streams[i]->codecpar->codec_type != want) continue;
                if (!audio && (fmt_->streams[i]->disposition & AV_DISPOSITION_ATTACHED_PIC))
                    continue;
                index = static_cast<int>(i);
            }
            // A filter on a stream the file does not have is not an error and
            // not something to refuse the whole view over: a silent clip with a
            // `volume` on it is a silent clip.
            if (index < 0) continue;

            auto f = std::make_unique<Filtered>();
            f->filter = std::make_unique<StreamFilter>();
            f->trackId = static_cast<uint32_t>(index) + 1;
            f->kind = audio ? TrackKind::Audio : TrackKind::Video;
            f->timeBase = fmt_->streams[index]->time_base;
            // The two clock corrections, kept apart because they happen at
            // opposite ends of the chain: this input's own zero comes off every
            // frame going in, so the filters start on the clock the rest of this
            // class counts in, and whatever the chain's own `setpts` then did
            // comes off on the way out. See `PlaybackView::shift`.
            if (!f->filter->open(fmt_, index, in, chain,
                                 audio ? 0 : rotationOf(fmt_->streams[index]),
                                 startOffsetNs_ / 1e9, view.shift, err))
                return false;
            if (!settleFilter(fmt_, *f->filter, err)) return false;
            filtered_.push_back(std::move(f));
        }
        if (filtered_.empty()) return true;
        // Settling read as far into the file as it took to decode a frame, so
        // the demuxer goes back to the top and every chain starts again — the
        // frames pushed to get the formats belong to the settle and not to the
        // playback that follows it.
        avformat_seek_file(fmt_, -1, INT64_MIN, 0, INT64_MAX, 0);
        for (auto& f : filtered_) f->filter->reset();
        return true;
    }

    StreamFilter* filterFor(int streamIndex) {
        for (auto& f : filtered_)
            if (f->filter->index() == streamIndex) return f->filter.get();
        return nullptr;
    }
    const StreamFilter* filterFor(int streamIndex) const {
        for (const auto& f : filtered_)
            if (f->filter->index() == streamIndex) return f->filter.get();
        return nullptr;
    }

    /// The next filtered frame due, as a packet — or false when every chain is
    /// empty and wants feeding.
    ///
    /// **Whichever is earliest**, because two chains are two clocks running at
    /// their own pace: a video filter holding three frames while the sound runs
    /// ahead would otherwise hand the element a second of audio before the
    /// picture that goes under it.
    bool emitFiltered(MediaPacket& out) {
        Filtered* pick = nullptr;
        for (auto& f : filtered_) {
            if (!f->pending) f->pending = f->filter->take();
            if (!f->pending) continue;
            if (!pick || f->pending->pts < pick->pending->pts) pick = f.get();
        }
        if (!pick) return false;

        AVFrame* f = pick->pending;
        pick->pending = nullptr;
        TimeNs pts = f->pts != AV_NOPTS_VALUE ? toNs(f->pts, pick->timeBase) - startOffsetNs_ : 0;
        // Past `-t` this input has ended, and the end of an input is the end of
        // the stream — the same rule the unfiltered path applies below, said
        // here because a filtered frame never reaches it. `drained_` is what
        // turns "nothing to hand over" into "there will be nothing".
        if (limitNs_ > 0 && pts >= limitNs_) {
            av_frame_free(&f);
            drained_ = true;
            return false;
        }
        if (pts < 0) pts = 0;

        // Same floor as the unfiltered path: see seekTo.
        if (seekFloorNs_ > 0 && pick->kind == TrackKind::Audio) {
            if (pts < seekFloorNs_) {
                av_frame_free(&f);
                return false;
            }
            seekFloorNs_ = 0;
        }

        out.trackId = pick->trackId;
        out.codec = Codec::Other;
        out.kind = pick->kind;
        out.keyframe = true;          // every one of them is
        out.pts = pts;
        out.duration = 0;
        out.data = wrapOwnedFrame(f); // takes the reference this holds
        return out.data != nullptr;
    }

    AVFormatContext* fmt_ = nullptr;
    AVPacket* pkt_ = nullptr;
    std::vector<TrackInfo> tracks_;
    InputLoop loop_;
    /// The chains this source runs, none for an ordinary src. See
    /// playback_filter.h for what one is and why it is not part of the input.
    std::vector<std::unique_ptr<Filtered>> filtered_;
    /// The file has ended and the chains have been told so. Set once, because
    /// telling a buffersrc twice is an error, and cleared by a seek.
    bool drained_ = false;
    int videoStreamIndex_ = -1;
    TimeNs startOffsetNs_ = 0;
    TimeNs limitNs_ = 0;
    /// Audio packets before this PTS are skipped after a seek. The seek
    /// lands on a video keyframe, which can be seconds before the target;
    /// the video pipeline drops pre-target frames itself, but the audio
    /// ring has no equivalent mechanism and would fill from the keyframe
    /// position, playing content from before the moment on screen. Set
    /// in `seekTo`, cleared on the first audio packet at or past it.
    TimeNs seekFloorNs_ = 0;
    bool endless_ = false;
};

} // namespace

std::unique_ptr<MediaSource> openBackendSource(const std::string& path) {
    // A pad of a running session, which has no demuxer behind it at all.
    // Tried first because the token is unambiguous and opening it is a
    // lookup rather than an attempt.
    uint64_t liveId = 0;
    std::string livePad;
    if (LiveSource::parse(path, &liveId, &livePad)) {
        auto live = std::make_unique<LiveSource>();
        if (!live->open(path)) return nullptr;
        return live;
    }
    // A render, made as it is watched. Like a live pad it is a lookup
    // rather than an attempt, and it names inputs rather than being one.
    if (resolveOutput(path, nullptr)) {
        auto out = std::make_unique<OutputSource>();
        if (!out->open(path)) return nullptr;
        return out;
    }
    // A view: an input, plus the filters its streams go through on the way
    // to the screen. Tried before an input token because a view *names* an
    // input and the two prefixes are distinct — see playback_filter.h.
    PlaybackView view;
    if (resolveView(path, &view)) {
        auto src = std::make_unique<FFmpegSource>();
        if (!src->open(view.input, &view)) return nullptr;
        return src;
    }
    MediaInput in;
    if (!resolveToken(path, &in)) in.path = path;
    auto src = std::make_unique<FFmpegSource>();
    if (!src->open(in)) return nullptr;
    return src;
}

} // namespace backend_detail
} // namespace ffmpegbro
