#include "ffmpeg_backend.h"

#include "ffmpeg_capture.h"
#include "live_tap.h"
#include "playback_filter.h"
#include "playback_output.h"

#include "ffmpeg_capabilities.h"
#include "ffmpeg_report.h"
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
#include "video/audio_decoder.h"
#include "video/media_backend.h"
#include "video/media_source.h"
#include "video/video_decoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace ffmpegbro {

using bro::video::AudioDecoder;
using bro::video::AudioFrame;
using bro::video::Codec;
using bro::video::MediaBackend;
using bro::video::MediaPacket;
using bro::video::MediaSource;
using bro::video::TimeNs;
using bro::video::TrackInfo;
using bro::video::TrackKind;
using bro::video::VideoDecoder;
using bro::video::VideoFrame;

namespace {

// bro's timestamps are nanoseconds from the start of the stream.
constexpr AVRational kNsTimeBase{1, 1000000000};

/// Slack to leave past the end of anything libav* is asked to write into.
///
/// Both libswscale and libswresample work a whole SIMD block at a time, so the
/// last store of a row — or of a run of samples — can go past the end of what
/// was asked for. A buffer sized to exactly width*height, or to exactly the
/// sample count, is therefore too small however carefully the count was worked
/// out. This is the padding av_image_alloc and av_samples_alloc would have
/// added, and it is not optional: a 640-wide file is a whole number of blocks
/// and never showed it, while a 360-wide one corrupted the heap on the first
/// frame — far enough from the write that it surfaced at process shutdown,
/// which is where this cost two afternoons.
///
/// **Two names for one number, and the names are not decoration.** This file
/// writes into both kinds of buffer, and there was one constant called
/// `kSwsSlack` sizing the audio one — a scaler's name on a resampler's buffer,
/// which is precisely the misreading that produced the corruption above. The
/// value is the same because the block sizes are; whether it is *needed* is a
/// separate fact per library, and a reader checking one of these sites has to
/// be able to see which question it is looking at. The resampler's half is
/// `kSwrSlack` in `export_frame.h`, which this file now includes; this one
/// stays here because it sizes three YUV planes packed into one allocation,
/// which is a shape that exists nowhere on the encode side.
constexpr size_t kSwsSlack = 256;

TimeNs toNs(int64_t ts, AVRational tb) {
    if (ts == AV_NOPTS_VALUE) return AV_NOPTS_VALUE;
    return av_rescale_q(ts, tb, kNsTimeBase);
}

int64_t fromNs(TimeNs ns, AVRational tb) {
    return av_rescale_q(ns, kNsTimeBase, tb);
}

Codec toBroCodec(AVCodecID id) {
    switch (id) {
        case AV_CODEC_ID_VP8:        return Codec::VP8;
        case AV_CODEC_ID_VP9:        return Codec::VP9;
        case AV_CODEC_ID_AV1:        return Codec::AV1;
        case AV_CODEC_ID_H264:       return Codec::H264;
        case AV_CODEC_ID_HEVC:       return Codec::H265;
        case AV_CODEC_ID_MPEG2VIDEO: return Codec::MPEG2Video;
        case AV_CODEC_ID_MPEG4:      return Codec::MPEG4;
        case AV_CODEC_ID_PRORES:     return Codec::ProRes;
        case AV_CODEC_ID_OPUS:       return Codec::Opus;
        case AV_CODEC_ID_VORBIS:     return Codec::Vorbis;
        case AV_CODEC_ID_AAC:        return Codec::AAC;
        case AV_CODEC_ID_MP3:        return Codec::MP3;
        case AV_CODEC_ID_FLAC:       return Codec::FLAC;
        case AV_CODEC_ID_AC3:        return Codec::AC3;
        case AV_CODEC_ID_EAC3:       return Codec::EAC3;
        default: break;
    }
    // Every flavour of raw PCM maps to one bro codec id.
    const AVCodecDescriptor* d = avcodec_descriptor_get(id);
    if (d && (d->props & AV_CODEC_PROP_LOSSLESS) && d->name &&
        std::strncmp(d->name, "pcm_", 4) == 0) {
        return Codec::PCM;
    }
    return Codec::Other;
}

// ── A stream whose packets are already frames ──────────────────────────────
//
// `wrapped_avframe` is not a codec: it is libav's way of handing a decoded
// AVFrame through something whose shape is a packet. lavfi uses it, because a
// filtergraph read as an input has nothing to compress — `-f lavfi -i testsrc`
// produces pictures, and inventing an encode to undo it would be absurd.
//
// The trouble is that the packet is a *pointer*. `wrapped_avframe_encode` sets
// `pkt->data = (uint8_t*)frame` with `pkt->size = sizeof(AVFrame)`, and the
// decoder at the far end refuses anything where `pkt->data != pkt->buf->data`
// — the identity check is the only thing standing between it and reading an
// arbitrary buffer as a frame. bro's `MediaPacket` carries *bytes*, quite
// rightly: bro is codec-agnostic and a pointer means nothing to it. So copying
// the eight bytes at `pkt->data` into a `vector<uint8_t>` and handing that over
// produced a packet whose pointer no longer matched its buffer and whose frame
// had been freed by `av_packet_unref` on the way past. That is the whole of why
// a `-f lavfi` device could be recorded but never played.
//
// **So the frame travels as itself, and the bytes are a token this backend
// wrote and only this backend reads.** `MediaPacket::data` is a `shared_ptr`,
// which is an ownership handle and not merely a buffer: the vector holds a
// `Wrapped*` and the deleter frees the AVFrame with it, so a packet dropped
// undecoded releases its picture and one that reaches the decoder still has it.
// The pairing is `TrackPrivate::wrapped`, set by the source that produced the
// track and read by the decoder built from it — the same guarantee
// `backendPrivate` itself rests on, and the reason this is not a hole in bro's
// byte-buffer contract: nothing outside these two classes ever looks inside.
//
// What would break it is a packet crossing a *process* boundary, where a
// pointer means nothing. Nothing in bro does that — packets are moved between
// threads, which a `shared_ptr` is exactly right for — and if anything ever
// did, this token would have to become a frame pool with an index in it. The
// check that catches it early is `Wrapped::magic`.
struct Wrapped {
    static constexpr uint64_t kMagic = 0x66666d70'77726170ull;   // "ffmpwrap"
    uint64_t magic = kMagic;
    AVFrame* frame = nullptr;
};

/// Take the frame out of a `wrapped_avframe` packet, as a `MediaPacket` payload
/// that owns it.
///
/// Cloned rather than moved: the packet the demuxer handed over is unreferenced
/// on the next read, and `av_frame_clone` is a new frame referencing the same
/// buffers rather than a copy of any pixels.
/// A payload that owns `frame` — the reference is taken, not copied.
std::shared_ptr<std::vector<uint8_t>> wrapOwnedFrame(AVFrame* frame) {
    if (!frame) return nullptr;
    auto* holder = new std::vector<uint8_t>(sizeof(Wrapped));
    Wrapped w{Wrapped::kMagic, frame};
    std::memcpy(holder->data(), &w, sizeof(w));
    return std::shared_ptr<std::vector<uint8_t>>(
        holder, [](std::vector<uint8_t>* v) {
            Wrapped w{};
            if (v->size() == sizeof(w)) {
                std::memcpy(&w, v->data(), sizeof(w));
                if (w.magic == Wrapped::kMagic && w.frame) av_frame_free(&w.frame);
            }
            delete v;
        });
}

std::shared_ptr<std::vector<uint8_t>> wrapFrame(const AVPacket* pkt) {
    if (!pkt->data || pkt->size != static_cast<int>(sizeof(AVFrame))) return nullptr;
    // Cloned: the packet the demuxer handed over is unreferenced on the next
    // read, and a clone is a new frame referencing the same buffers rather than
    // a copy of any pixels.
    return wrapOwnedFrame(av_frame_clone(reinterpret_cast<const AVFrame*>(pkt->data)));
}

/// The frame inside such a payload, still owned by it. Null for anything this
/// backend did not write, which is what makes reading it safe.
AVFrame* unwrapFrame(const std::vector<uint8_t>* data) {
    if (!data || data->size() != sizeof(Wrapped)) return nullptr;
    Wrapped w{};
    std::memcpy(&w, data->data(), sizeof(w));
    return w.magic == Wrapped::kMagic ? w.frame : nullptr;
}

// Carried from the demuxer to the decoder through TrackInfo::backendPrivate.
// AVCodecParameters is the whole point: flattening it into codecPrivate would
// drop the extradata framing, pixel format and colour description that make an
// H.264 or HEVC stream decodable at all.
struct TrackPrivate {
    AVCodecParameters* par = nullptr;
    AVRational timeBase{1, 1000};
    int streamIndex = 0;

    /// This stream's packets are `wrapped_avframe` — see above. The decoder
    /// built from this track opens no codec and unwraps instead.
    bool wrapped = false;

    /// The input this track came out of, carried so the decoder can be opened
    /// with the input's own decoder options. A decoder belongs to an `-i` —
    /// `-skip_frame nokey` before the `-i` is a decision about *that* file —
    /// and the decoder here is built from a `TrackInfo` long after the source
    /// has stopped being on the stack, so the input has to travel with it.
    MediaInput input;

    ~TrackPrivate() {
        if (par) avcodec_parameters_free(&par);
    }
};

std::shared_ptr<TrackPrivate> privateOf(const TrackInfo& t) {
    return std::static_pointer_cast<TrackPrivate>(t.backendPrivate);
}

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

// ── A render, as a media source ────────────────────────────────────────────
//
// `<video src="/@out/edit/0-8000">` plays what the export would write — its
// picture and its soundtrack both, made while you watch it. See
// playback_output.h for what a view is, why the caller owns the seek, and why
// the sound is the authoritative half; this is what turns a run into something
// bro can play.
//
// It is the second source in this backend with no demuxer behind it, and it
// shares the mechanism with the first: what would be a compressed packet is a
// picture — or a block of samples — that was never compressed, carried as
// `wrapped_avframe` exactly as a live pad's is and as a `-f lavfi` input's is.
// There is no output decoder for the same reason there is no live one.
//
// **It reads pads rather than driving the render**, which is the whole reason
// there is an `OutputRun`: bro opens a media element's source *twice* — once for
// the pipeline and once for the audio ring it keeps ahead of the mixer — and a
// source that built a render per open would build two renders of one edit and
// race them for the same files. So both opens attach to one run and read its tap:
// the picture from `vout`, newest wins, and the sound from `aout`, a queue per
// listener. Each object holds both readers and `setActiveTracks` says which of
// them is wanted, which is bro telling us plainly rather than us guessing.
//
// **It waits, where it used to make.** A pull that rendered inside `readPacket`
// could not be shared and could not be paced; what waits here is a reader in
// front of a producer that is being paced by the sound, so a preview which cannot
// keep up drops pictures instead of playing slowly. That is the trade the header
// argues for, and this class is where it is felt: `take` hands back the newest
// picture there is and no older one.
class OutputSource : public MediaSource {
public:
    bool open(const std::string& src) {
        std::string err;
        run_ = attachOutput(src, &err);
        if (!run_) {
            // The graph would not parse, in libavfilter's own words, or the token
            // names nothing. Logged rather than swallowed because the caller
            // settles a view before it points anything at one — see
            // `settleOutput` — so arriving here means the graph changed under a
            // token that was good a moment ago.
            LOG_WARN("ffmpeg: output preview: %s", err.c_str());
            return false;
        }

        // **Described from the facts and not from a frame.** A live pad has to
        // produce one before it knows how big it is; a render's canvas is the
        // size the spec says, or the size the graph settled on, and both are
        // known before a picture is made. So opening costs no frame, and an
        // element pointed at an empty timeline opens rather than failing.
        const OutputFacts& f = run_->facts();
        if (f.width <= 0 || f.height <= 0) return false;
        picture_ = run_->tap()->pad("vout");
        if (!picture_) return false;

        TrackInfo t;
        t.id = kVideoTrack;
        t.kind = TrackKind::Video;
        t.codec = Codec::Other;
        t.width = static_cast<uint32_t>(f.width);
        t.height = static_cast<uint32_t>(f.height);
        t.frameRate = f.fps;
        t.durationNs = static_cast<TimeNs>(llround(f.length * 1e9));

        auto priv = std::make_shared<TrackPrivate>();
        priv->par = avcodec_parameters_alloc();
        if (!priv->par) return false;
        priv->par->codec_type = AVMEDIA_TYPE_VIDEO;
        priv->par->codec_id = AV_CODEC_ID_WRAPPED_AVFRAME;
        priv->par->width = f.width;
        priv->par->height = f.height;
        priv->par->format = AV_PIX_FMT_RGBA;
        priv->timeBase = AVRational{1, 1000000};
        priv->wrapped = true;
        t.backendPrivate = priv;
        tracks_.push_back(std::move(t));

        // The soundtrack, if this render has one. Described from the facts as
        // well — a track has to say its rate and its layout before a sample of it
        // exists, and `mixInto` produces exactly what the spec asked for.
        soundPad_ = f.audioRate > 0 ? run_->tap()->pad("aout") : nullptr;
        if (soundPad_) {
            TrackInfo a;
            a.id = kAudioTrack;
            a.kind = TrackKind::Audio;
            a.codec = Codec::Other;
            a.sampleRate = static_cast<uint32_t>(f.audioRate);
            a.channels = static_cast<uint32_t>(f.audioChannels);
            a.durationNs = static_cast<TimeNs>(llround(f.length * 1e9));

            auto ap = std::make_shared<TrackPrivate>();
            ap->par = avcodec_parameters_alloc();
            if (!ap->par) return false;
            ap->par->codec_type = AVMEDIA_TYPE_AUDIO;
            ap->par->codec_id = AV_CODEC_ID_WRAPPED_AVFRAME;
            ap->par->format = AV_SAMPLE_FMT_FLT;
            ap->par->sample_rate = f.audioRate;
            av_channel_layout_default(&ap->par->ch_layout, f.audioChannels);
            ap->timeBase = AVRational{1, 1000000};
            ap->wrapped = true;
            a.backendPrivate = ap;
            tracks_.push_back(std::move(a));
        }
        return true;
    }

    const std::vector<TrackInfo>& tracks() const override { return tracks_; }

    /// Is there a block for the ring right now — and, because asking is what
    /// makes one, the ask itself.
    ///
    /// **The wake is not a side effect to be tidied away.** The run idles a
    /// quarter of a second after the asking stops, and the only asking there is
    /// happens in `readPacket`. A caller that checked this, was told "not yet"
    /// and went away would be the reason it stayed "not yet" for ever.
    bool packetReady() const override {
        if (!run_) return true;   // gone: readPacket says so at once
        if (!wantSound_ || !soundPad_) return true;   // the picture has its own thread
        run_->wake();
        if (!ears_) ears_ = soundPad_->listen();
        return soundPad_->soundReady(*ears_);
    }

    bool readPacket(MediaPacket& out) override {
        if (!run_) return false;
        // **Asked for, every time.** The run produces while it is being asked and
        // idles a quarter of a second after the asking stops, which is what makes
        // a paused preview cost nothing — so a reader that woke it once at the
        // start would get one frame and then a stall.
        run_->wake();

        // Sound first where it is wanted, and by a whole packet rather than by a
        // comparison of timestamps: the two are read by two different objects in
        // the ordinary case, and where one object reads both, a block that is
        // already made is a block the ring is waiting for.
        if (wantSound_ && soundPad_) {
            if (!ears_) ears_ = soundPad_->listen();
            for (int waited = 0; waited < kReadWaitMs; waited += kSliceMs) {
                double at = 0.0;
                if (AVFrame* f = soundPad_->takeSound(*ears_, &at, kSliceMs))
                    return hand(out, f, at, kAudioTrack, TrackKind::Audio);
                if (soundPad_->ended()) break;
                if (wantPicture_) break;   // the picture is what this reader is for
                run_->wake();
            }
            if (!wantPicture_) return false;
        }

        if (!wantPicture_) return false;
        for (int waited = 0; waited < kReadWaitMs; waited += kSliceMs) {
            double at = 0.0;
            if (AVFrame* f = picture_->take(&seen_, &at, kSliceMs)) {
                // Where the screen is, told to the run before the frame is handed
                // over rather than after: the answer is what the *next* canvas is
                // made from, and a tick of the loop can fall between the two.
                run_->sawPicture(at);
                return hand(out, f, at, kVideoTrack, TrackKind::Video);
            }
            // Ended *and* empty is the only false this returns: the range has run
            // out, which is the element ending.
            if (picture_->ended()) return false;
            run_->wake();
        }
        return false;
    }

    /// Which half of the render this object is reading — and for the sound it is
    /// also whether anything is listening at all.
    ///
    /// bro asks the pipeline's source for the video track alone and the ring's
    /// source for the audio track alone, so this is not a hint: dropping the
    /// listener when sound is not wanted is what stops the run queueing blocks
    /// for a reader that will never take one. See `LivePadTap::listen`.
    void setActiveTracks(const std::vector<uint32_t>& trackIds) override {
        wantPicture_ = false;
        wantSound_ = false;
        for (uint32_t id : trackIds) {
            if (id == kVideoTrack) wantPicture_ = true;
            if (id == kAudioTrack) wantSound_ = true;
        }
        if (!wantSound_) ears_.reset();
    }

    /// Refused, and the caller knows: a graph produces the frames it produces in
    /// order, so there is no seeking inside one — only building one whose inputs
    /// begin where you want to start. Moving the playhead is a redefinition and
    /// therefore a new src. See playback_output.h.
    bool seekTo(TimeNs) override { return false; }

private:
    static constexpr uint32_t kVideoTrack = 1;
    static constexpr uint32_t kAudioTrack = 2;
    static constexpr int kSliceMs = 100;
    static constexpr int kReadWaitMs = 4000;

    /// One frame off a pad, as the packet that carries it.
    ///
    /// `at` is where the run said this one sits in the range — the picture's own
    /// moment, which is `lead` behind the sound's. That is what the element reads
    /// back as `currentTime` and therefore what the playhead follows, so it has
    /// to be the moment being watched rather than the moment being made.
    bool hand(MediaPacket& out, AVFrame* f, double at, uint32_t track, TrackKind kind) {
        out.trackId = track;
        out.codec = Codec::Other;
        out.kind = kind;
        out.keyframe = true;         // every one of them is
        out.pts = static_cast<TimeNs>(llround(std::max(0.0, at) * 1e9));
        out.duration = 0;
        out.data = wrapOwnedFrame(f);   // takes the reference this holds
        return out.data != nullptr;
    }

    std::shared_ptr<OutputRun> run_;
    std::shared_ptr<LivePadTap> picture_;
    std::shared_ptr<LivePadTap> soundPad_;
    /// This reader's queue of the mix, made on the first read that wants it — so
    /// a reader that only ever wanted the picture never causes a block to be
    /// queued at all. Mutable because `packetReady` is the first read now: it
    /// asks whether there is a block, and there can be none until something is
    /// listening for one.
    mutable std::shared_ptr<LiveSoundQueue> ears_;
    std::vector<TrackInfo> tracks_;
    uint64_t seen_ = 0;
    bool wantPicture_ = true;
    bool wantSound_ = true;
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

// ── VideoDecoder ───────────────────────────────────────────────────────────

class FFmpegVideoDecoder : public VideoDecoder {
public:
    ~FFmpegVideoDecoder() override {
        if (sws_) sws_freeContext(sws_);
        if (frame_) av_frame_free(&frame_);
        if (swap_) av_frame_free(&swap_);
        if (avpkt_) av_packet_free(&avpkt_);
        if (ctx_) avcodec_free_context(&ctx_);
    }

    bool init(const TrackInfo& t) {
        auto priv = privateOf(t);
        if (!priv || !priv->par) return false;
        timeBase_ = priv->timeBase;

        // Nothing to open: the pictures arrive decoded. `avcodec_open2` on the
        // wrapped_avframe decoder would work and would then refuse every packet
        // — its first act is to check that the pointer still matches its own
        // buffer, which is exactly what a crossing cannot preserve — so the
        // codec is skipped rather than opened and worked around.
        if (priv->wrapped) {
            wrapped_ = true;
            frame_ = av_frame_alloc();
            swap_ = av_frame_alloc();
            return frame_ && swap_;
        }

        // Frame + slice threading across all cores. For H.264/HEVC/AV1 this is
        // what makes software decode keep up with 4K, and unlike a hardware
        // decoder it costs no GPU->CPU readback — which matters here more than
        // anywhere, because bro's renderer wants planes in system memory and
        // playback has no way to keep a picture on the card. An input that
        // asks for `-hwaccel` still gets it (the decision belongs to the input
        // and the same decision has to reach the timeline and the render), and
        // every frame is brought back down in `nextFrame`. The input's own
        // decoder options are applied after this and therefore win.
        //
        // **Deciding it automatically was measured and refused, and AV1 is why
        // it was measured again.** The argument above was made against 4K AVC,
        // and the case that should have broken it is a long recording of AV1 —
        // the codec whose software decode is supposed to be at realtime, which
        // is the one condition a pipeline cannot recover a seek's head start
        // from. On this machine (RTX 4090, Windows 11) it is not, and the card
        // is slower at everything measured. One pass per row, decode plus the
        // readback playback always pays, in ms per picture:
        //
        //     1440p60 AV1  (mandelbrot, 63 Mbps)   software 2.11   [1]
        //     1440p60 AV1  (+ film grain)          software 2.23   [1]
        //     4K AVC                               software 1.47   cuda 4.37
        //                                                          dxva2 4.84
        //                                                          d3d11va 5.28
        //     640x360 AVC                          software 0.06   cuda 0.30
        //
        //     [1] no hardware column: every AV1 *decoder* in this build that
        //         takes a device is reachable only by asking for one by name —
        //         see `hwDecoderFor`. Through ffmpeg's CLI, which can, d3d11va
        //         and libdav1d decode this file in the same wall clock and the
        //         card uses 4.6x less CPU (1.4 s against 6.3 s for ten seconds).
        //
        // And the many-streams case, which is the one this application is,
        // does not reverse it either: eight 4K AVC decoders at once are 2.7 s
        // of wall clock in software against 8.2 s on cuda and 10.1 s on
        // d3d11va, because a card has two decode engines and a CPU here has
        // thirty-two threads. Twelve 640x360 decoders are 0.17 s against 0.86 s.
        //
        // So the automatic choice is the CPU, which is what it already was, and
        // the numbers are here rather than in a commit message because the next
        // person to think "surely the GPU" should be able to see what was run.
        // What the measurements did change is one layer down: an input that
        // *asks* for a device now gets one for AV1 too, which it could not
        // before — the saving there is CPU rather than time, and it is the
        // caller's decision to make.
        std::string why;
        if (!openDecoder(&ctx_, priv->par, timeBase_, priv->input,
                         /*threaded=*/true, &why)) {
            LOG_WARN("ffmpeg: %s", why.c_str());
            return false;
        }

        frame_ = av_frame_alloc();
        swap_ = av_frame_alloc();
        avpkt_ = av_packet_alloc();
        return frame_ && swap_ && avpkt_;
    }

    bool decode(const MediaPacket& pkt) override {
        if (wrapped_) {
            AVFrame* f = unwrapFrame(pkt.data.get());
            if (!f) return true;   // not one of ours; nothing to show for it
            av_frame_unref(frame_);
            // Referenced, not stolen: the packet owns the frame and may still
            // be held by whoever routed it. This is one refcount, not a copy
            // of a picture.
            if (av_frame_ref(frame_, f) < 0) return true;
            // The pts on the frame is the graph's; the one on the packet has
            // already been through `-ss`/`-itsoffset` and the container's start
            // time, which is the clock everything above here is on.
            wrappedPts_ = pkt.pts;
            haveWrapped_ = true;
            return true;
        }
        if (!ctx_ || !pkt.data) return false;
        av_packet_unref(avpkt_);
        // Reference the caller's buffer rather than copying: the packet's
        // shared_ptr keeps it alive, and libavcodec is done with it by the
        // time send_packet returns for every decoder we use.
        avpkt_->data = const_cast<uint8_t*>(pkt.data->data());
        avpkt_->size = static_cast<int>(pkt.data->size());
        avpkt_->pts = fromNs(pkt.pts, timeBase_);
        avpkt_->dts = avpkt_->pts;
        avpkt_->flags = pkt.keyframe ? AV_PKT_FLAG_KEY : 0;

        int rc = avcodec_send_packet(ctx_, avpkt_);
        avpkt_->data = nullptr;
        avpkt_->size = 0;
        if (rc == AVERROR(EAGAIN)) return true;   // drain first, then re-send
        if (rc < 0) {
            // A corrupt or unreferenced packet is not a reason to tear the
            // pipeline down — the next keyframe recovers.
            LOG_WARN("ffmpeg: video decode error: %s", avErr(rc).c_str());
            return true;
        }
        return true;
    }

    bool nextFrame(VideoFrame& out) override {
        if (wrapped_) {
            // One packet is one picture, so there is no reorder buffer to
            // empty and nothing to hand back on a second call.
            if (!haveWrapped_) return false;
            haveWrapped_ = false;
            return handOver(out, wrappedPts_);
        }
        if (!ctx_) return false;
        av_frame_unref(frame_);
        int rc = avcodec_receive_frame(ctx_, frame_);
        if (rc < 0) return false;   // EAGAIN/EOF: nothing more this round
        return handOver(out, -1);
    }

    /// The picture in `frame_`, as bro takes one. `ptsNs` at or above zero is
    /// the timestamp to use — a wrapped frame carries the graph's own clock and
    /// the packet's has already been through the input's `-ss` and the
    /// container's start time — and below zero asks the frame.
    bool handOver(VideoFrame& out, int64_t ptsNs) {
        // A hardware decode still has to arrive here as pixels: what bro's
        // renderer takes is three planes it can read, and there is no path in
        // playback that could hand it a device handle. So the picture comes
        // down, unconditionally.
        //
        // The download is cheap — 3–4% of a CUDA decode, measured — and it is
        // the *decode* that makes `-hwaccel` a loss on the timeline, because
        // libavcodec threaded across every core is several times faster than
        // one NVDEC stream pulled a frame at a time. The UI says so where the
        // choice is made.
        if (frame_->hw_frames_ctx) {
            std::string why;
            if (!downloadFrame(&frame_, &swap_, &why)) {
                LOG_WARN("ffmpeg: %s", why.c_str());
                return false;
            }
        }

        const int w = frame_->width;
        const int h = frame_->height;
        if (w <= 0 || h <= 0) return false;

        int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                         ? frame_->best_effort_timestamp
                         : frame_->pts;
        out.pts = ptsNs >= 0 ? ptsNs
                             : (ts != AV_NOPTS_VALUE ? toNs(ts, timeBase_) : 0);
        out.width = static_cast<uint32_t>(w);
        out.height = static_cast<uint32_t>(h);

        const auto fmt = static_cast<AVPixelFormat>(frame_->format);
        if (fmt == AV_PIX_FMT_YUV420P || fmt == AV_PIX_FMT_YUVJ420P) {
            // Already what bro wants. Plane pointers stay valid until the next
            // nextFrame() call, which is exactly libvpx's contract too.
            out.y = frame_->data[0];
            out.u = frame_->data[1];
            out.v = frame_->data[2];
            out.strideY = frame_->linesize[0];
            out.strideU = frame_->linesize[1];
            out.strideV = frame_->linesize[2];
            out.storage.reset();
            return true;
        }

        // Anything else — 10-bit HDR, 4:2:2 broadcast, 4:4:4 ProRes, RGB
        // screen captures — goes through swscale into I420.
        return convertToI420(fmt, w, h, out);
    }

    // A null packet is how libavcodec is told the stream ended: receive_frame
    // then hands back the reorder buffer instead of returning EAGAIN. HEVC
    // with a full DPB holds sixteen pictures there, which is a full second of
    // a 15 fps file that would otherwise never be seen.
    void drain() override {
        if (ctx_) avcodec_send_packet(ctx_, nullptr);
    }

    void flush() override {
        // Also clears the drained state, so the decoder accepts packets again
        // after a seek away from the end.
        if (ctx_) avcodec_flush_buffers(ctx_);
        // A wrapped frame from before the seek belongs where it came from, and
        // there is no codec here holding anything else.
        haveWrapped_ = false;
    }

private:
    bool convertToI420(AVPixelFormat fmt, int w, int h, VideoFrame& out) {
        sws_ = sws_getCachedContext(sws_, w, h, fmt, w, h, AV_PIX_FMT_YUV420P,
                                    SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!sws_) return false;

        const size_t ySize = static_cast<size_t>(w) * h;
        const int cw = (w + 1) / 2, ch = (h + 1) / 2;
        const size_t cSize = static_cast<size_t>(cw) * ch;

        // Every plane gets slack after it, not just the last: three planes
        // packed back to back means one plane's spill lands in the next, and
        // the last one's lands outside the allocation. See kSwsSlack.
        const size_t yPlane = ySize + kSwsSlack;
        const size_t cPlane = cSize + kSwsSlack;
        auto buf = std::make_shared<std::vector<uint8_t>>(yPlane + cPlane * 2);

        uint8_t* dst[4] = {buf->data(), buf->data() + yPlane,
                           buf->data() + yPlane + cPlane, nullptr};
        int dstStride[4] = {w, cw, cw, 0};
        int rc = sws_scale(sws_, frame_->data, frame_->linesize, 0, h, dst, dstStride);
        if (rc <= 0) return false;

        out.storage = buf;
        out.y = dst[0];
        out.u = dst[1];
        out.v = dst[2];
        out.strideY = w;
        out.strideU = cw;
        out.strideV = cw;
        return true;
    }

    AVCodecContext* ctx_ = nullptr;
    AVFrame* frame_ = nullptr;
    /// The spare a hardware frame is brought down into; swapped with `frame_`
    /// rather than copied, so a hardware decode allocates once and not once a
    /// picture.
    AVFrame* swap_ = nullptr;
    AVPacket* avpkt_ = nullptr;
    SwsContext* sws_ = nullptr;
    AVRational timeBase_{1, 1000};

    /// This track's packets are frames already — no codec is open and
    /// `frame_`/`swap_` are the only things allocated. See `Wrapped`.
    bool wrapped_ = false;
    bool haveWrapped_ = false;
    int64_t wrappedPts_ = 0;
};

// ── AudioDecoder ───────────────────────────────────────────────────────────

class FFmpegAudioDecoder : public AudioDecoder {
public:
    ~FFmpegAudioDecoder() override {
        if (swr_) swr_free(&swr_);
        if (frame_) av_frame_free(&frame_);
        if (avpkt_) av_packet_free(&avpkt_);
        if (ctx_) avcodec_free_context(&ctx_);
        av_channel_layout_uninit(&outLayout_);
    }

    bool init(const TrackInfo& t) {
        auto priv = privateOf(t);
        if (!priv || !priv->par) return false;
        timeBase_ = priv->timeBase;

        // Sound arriving already decoded — `-f lavfi -i sine=1000`. The same
        // crossing and the same answer as the picture side; see `Wrapped`.
        // What comes out still goes through swresample, because the layout and
        // rate a filter produces are its own and the caller asked for theirs.
        if (priv->wrapped) {
            wrapped_ = true;
            rate_ = priv->par->sample_rate;
            channels_ = priv->par->ch_layout.nb_channels;
            if (rate_ <= 0 || channels_ <= 0) return false;
            if (av_channel_layout_copy(&outLayout_, &priv->par->ch_layout) < 0) return false;
            frame_ = av_frame_alloc();
            return frame_ != nullptr;
        }

        std::string why;
        if (!openDecoder(&ctx_, priv->par, timeBase_, priv->input,
                         /*threaded=*/false, &why)) {
            LOG_WARN("ffmpeg: %s", why.c_str());
            return false;
        }

        rate_ = ctx_->sample_rate;
        channels_ = ctx_->ch_layout.nb_channels;
        if (rate_ <= 0 || channels_ <= 0) return false;
        // Default to the source's own layout; setOutputFormat overrides.
        if (av_channel_layout_copy(&outLayout_, &ctx_->ch_layout) < 0) return false;

        frame_ = av_frame_alloc();
        avpkt_ = av_packet_alloc();
        return frame_ && avpkt_;
    }

    bool setOutputFormat(uint32_t sampleRate, uint32_t channels) override {
        if (sampleRate == 0 || channels == 0 || channels > 8) return false;

        AVChannelLayout want{};
        // A named layout gives swresample a real downmix matrix (5.1 → stereo
        // folds the centre and surrounds in at the right levels); an unnamed
        // one would just truncate channels and lose the dialogue.
        av_channel_layout_default(&want, static_cast<int>(channels));
        av_channel_layout_uninit(&outLayout_);
        if (av_channel_layout_copy(&outLayout_, &want) < 0) {
            av_channel_layout_uninit(&want);
            return false;
        }
        av_channel_layout_uninit(&want);

        rate_ = static_cast<int>(sampleRate);
        channels_ = static_cast<int>(channels);
        // Force the resampler to be rebuilt against the new target.
        if (swr_) swr_free(&swr_);
        swrInFmt_ = AV_SAMPLE_FMT_NONE;
        swrInRate_ = 0;
        return true;
    }

    bool decode(const MediaPacket& pkt, AudioFrame& out) override {
        if (!pkt.data) return false;

        out.sampleRate = static_cast<uint32_t>(rate_);
        out.channels = static_cast<uint32_t>(channels_);
        out.pts = pkt.pts;
        out.samples.clear();

        if (wrapped_) {
            AVFrame* f = unwrapFrame(pkt.data.get());
            if (!f) return false;
            av_frame_unref(frame_);
            if (av_frame_ref(frame_, f) < 0) return false;
            return appendFrame(out);
        }

        if (!ctx_) return false;
        av_packet_unref(avpkt_);
        avpkt_->data = const_cast<uint8_t*>(pkt.data->data());
        avpkt_->size = static_cast<int>(pkt.data->size());
        avpkt_->pts = fromNs(pkt.pts, timeBase_);
        avpkt_->dts = avpkt_->pts;

        int rc = avcodec_send_packet(ctx_, avpkt_);
        avpkt_->data = nullptr;
        avpkt_->size = 0;
        if (rc < 0 && rc != AVERROR(EAGAIN)) {
            LOG_WARN("ffmpeg: audio decode error: %s", avErr(rc).c_str());
            return false;
        }

        // One packet can yield several frames (and, for codecs with a decoder
        // delay, none at all on the first calls). Append everything available.
        bool got = false;
        for (;;) {
            av_frame_unref(frame_);
            rc = avcodec_receive_frame(ctx_, frame_);
            if (rc < 0) break;
            if (!appendFrame(out)) break;
            if (!got) {
                // The frame's own timestamp beats the packet's once we have it.
                int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                                 ? frame_->best_effort_timestamp
                                 : frame_->pts;
                if (ts != AV_NOPTS_VALUE) out.pts = toNs(ts, timeBase_);
            }
            got = true;
        }
        return got;
    }

    void flush() override {
        if (ctx_) avcodec_flush_buffers(ctx_);
        // The resampler holds a filter tail from before the seek; emitting it
        // after would splice a few ms of the old position onto the new one.
        if (swr_) swr_free(&swr_);
        swrInFmt_ = AV_SAMPLE_FMT_NONE;
        swrInRate_ = 0;
    }

private:
    // Resample/interleave one AVFrame onto the end of `out.samples`.
    bool appendFrame(AudioFrame& out) {
        const auto inFmt = static_cast<AVSampleFormat>(frame_->format);
        if (!swr_ || inFmt != swrInFmt_ || frame_->sample_rate != swrInRate_) {
            if (swr_) swr_free(&swr_);
            int rc = swr_alloc_set_opts2(&swr_, &outLayout_, AV_SAMPLE_FMT_FLT, rate_,
                                         &frame_->ch_layout, inFmt, frame_->sample_rate,
                                         0, nullptr);
            if (rc < 0 || !swr_ || swr_init(swr_) < 0) {
                LOG_WARN("ffmpeg: cannot build audio resampler");
                return false;
            }
            swrInFmt_ = inFmt;
            swrInRate_ = frame_->sample_rate;
        }

        // Account for whatever swr is holding back, so nothing is dropped.
        const int64_t delay = swr_get_delay(swr_, rate_);
        const int maxOut = static_cast<int>(
            av_rescale_rnd(delay + frame_->nb_samples, rate_, frame_->sample_rate, AV_ROUND_UP));
        if (maxOut <= 0) return true;

        // Grown with slack, converted into, then shrunk to what was actually
        // written — so the buffer libswresample writes into is bigger than the
        // sample count while `samples.size()` stays honest about how many there
        // are. Shrinking a vector never reallocates, so the slack survives as
        // spare capacity. See kSwrSlack — this is libswresample, not libswscale.
        const size_t base = out.samples.size();
        out.samples.resize(base + static_cast<size_t>(maxOut) * channels_ + kSwrSlack);
        auto* dst = reinterpret_cast<uint8_t*>(out.samples.data() + base);
        int written = swr_convert(swr_, &dst, maxOut,
                                  const_cast<const uint8_t**>(frame_->extended_data),
                                  frame_->nb_samples);
        if (written < 0) {
            out.samples.resize(base);
            return false;
        }
        out.samples.resize(base + static_cast<size_t>(written) * channels_);
        return true;
    }

    AVCodecContext* ctx_ = nullptr;
    AVFrame* frame_ = nullptr;
    AVPacket* avpkt_ = nullptr;
    SwrContext* swr_ = nullptr;
    AVChannelLayout outLayout_{};
    AVSampleFormat swrInFmt_ = AV_SAMPLE_FMT_NONE;
    int swrInRate_ = 0;
    int rate_ = 0;
    int channels_ = 0;
    AVRational timeBase_{1, 1000};

    /// Sound that arrives already decoded — no codec is open. See `Wrapped`.
    bool wrapped_ = false;
};

} // namespace

// ── Registration ───────────────────────────────────────────────────────────

void registerFfmpegBackend() {
    static bool done = false;
    if (done) return;
    done = true;

    // libav writes to stderr by default, which for a windowed build goes
    // nowhere. Route it into bro.log with everything else, at a level that
    // reports real problems without narrating every packet.
    //
    // There is exactly one `av_log` callback in the process and it lives in
    // ffmpeg_report.cpp, because the console and the report want different
    // amounts of the same stream: this level governs what is *printed*, while
    // the report keeps everything down to AV_LOG_INFO whether or not it is on
    // screen. Installed here as well as from `main` so that no order of the two
    // can leave the callback un-installed — it is idempotent.
    av_log_set_level(AV_LOG_WARNING);
    installLogCapture();

    // libavdevice's formats do not exist until this has run — not merely
    // unlisted: `av_find_input_format("gdigrab")` would not find one either, so
    // a screen grab was unreachable from every direction. Done here rather than
    // where something enumerates, because this runs before the engine is
    // constructed and a device is a source like any other.
    registerDevices();

    MediaBackend backend;
    backend.name = "ffmpeg";
    // Above bro's built-in WebM backend: libavcodec decodes VP8/VP9/Opus too,
    // and keeping one code path for every container means one set of seek,
    // timestamp and reordering semantics instead of two.
    backend.priority = 100;

    // A src that names a registered input is opened as that input, options and
    // all; anything else is a path, opened the way it always was.
    //
    // This is the whole of how an input's options reach *playback*. bro's
    // `<video>` takes a string and this backend is registered generically, so
    // there is nowhere else to put them — and a token that names the input
    // rather than repeating its path is what lets two inputs on one file carry
    // two different option bags, and what lets a URL be a src at all (bro
    // resolves anything that does not start with `/` or `x:` against the
    // document, which turns `https://…` into a path under ui/).
    backend.open = [](const std::string& path) -> std::unique_ptr<MediaSource> {
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
    };
    backend.makeVideoDecoder = [](const TrackInfo& t) -> std::unique_ptr<VideoDecoder> {
        auto dec = std::make_unique<FFmpegVideoDecoder>();
        if (!dec->init(t)) return nullptr;
        return dec;
    };
    backend.makeAudioDecoder = [](const TrackInfo& t) -> std::unique_ptr<AudioDecoder> {
        auto dec = std::make_unique<FFmpegAudioDecoder>();
        if (!dec->init(t)) return nullptr;
        return dec;
    };

    bro::video::registerMediaBackend(std::move(backend));
    LOG_INFO("ffmpeg: media backend registered (%s)", libavVersion().c_str());
}

// ── Probe ──────────────────────────────────────────────────────────────────

ProbeResult probeMedia(const std::string& path) {
    MediaInput in;
    in.path = path;
    return probeMedia(in);
}

ProbeResult probeMedia(const MediaInput& in, OpenWatch* watch) {
    ProbeResult r;
    r.path = in.path;

    AVFormatContext* fmt = nullptr;
    std::string why;
    if (!openInput(&fmt, in, &why, watch)) {
        // Without the path in front of it, because the caller already knows
        // which file it asked about and `openInput` prefixes it for the log.
        const std::string prefix = in.path + ": ";
        r.error = why.compare(0, prefix.size(), prefix) == 0 ? why.substr(prefix.size()) : why;
        return r;
    }

    r.ok = true;
    r.formatName = fmt->iformat && fmt->iformat->name ? fmt->iformat->name : "";
    r.formatLongName = fmt->iformat && fmt->iformat->long_name ? fmt->iformat->long_name : "";

    // How long the *input* is, which is how long the file is only when nothing
    // has been said about a window. A clip's length comes from this, so an
    // input trimmed with `-ss`/`-t` has to report the trimmed length here or
    // the timeline would lay out a clip running past the end of its own input
    // — and an input that loops has no measured length at all, so `-t` is the
    // whole of the answer. Both rules live in `inputDuration`.
    const auto window = [&](double d) { return inputDuration(in, d); };

    const double rawDuration =
        fmt->duration != AV_NOPTS_VALUE ? fmt->duration / double(AV_TIME_BASE) : 0.0;
    r.durationSec = window(rawDuration);
    r.bitRate = fmt->bit_rate;
    if (fmt->pb) r.sizeBytes = avio_size(fmt->pb);

    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        AVStream* st = fmt->streams[i];
        AVCodecParameters* par = st->codecpar;

        StreamSummary s;
        s.index = static_cast<int>(i);
        switch (par->codec_type) {
            case AVMEDIA_TYPE_VIDEO:    s.kind = "video"; break;
            case AVMEDIA_TYPE_AUDIO:    s.kind = "audio"; break;
            case AVMEDIA_TYPE_SUBTITLE: s.kind = "subtitle"; break;
            default:                    s.kind = "data"; break;
        }
        s.codec = avcodec_get_name(par->codec_id);
        if (par->codec_tag) {
            char fourcc[AV_FOURCC_MAX_STRING_SIZE] = {0};
            s.tag = av_fourcc_make_string(fourcc, par->codec_tag);
        }
        if (const AVCodecDescriptor* d = avcodec_descriptor_get(par->codec_id)) {
            s.codecLong = d->long_name ? d->long_name : "";
            s.textSub = par->codec_type == AVMEDIA_TYPE_SUBTITLE &&
                        (d->props & AV_CODEC_PROP_TEXT_SUB) != 0;
        }
        if (const char* p = avcodec_profile_name(par->codec_id, par->profile))
            s.profile = p;
        s.bitRate = par->bit_rate;
        // Matroska keeps one duration for the whole file and none per track,
        // so falling back to the container's is the best answer available
        // rather than reporting a clip of length zero.
        s.duration = st->duration != AV_NOPTS_VALUE
                         ? window(st->duration * av_q2d(st->time_base))
                         : r.durationSec;
        s.isDefault = (st->disposition & AV_DISPOSITION_DEFAULT) != 0;

        if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
            s.width = par->width;
            s.height = par->height;
            AVRational fr = av_guess_frame_rate(fmt, st, nullptr);
            s.fps = fr.den > 0 ? av_q2d(fr) : 0.0;
            if (const char* pf = av_get_pix_fmt_name(static_cast<AVPixelFormat>(par->format)))
                s.pixFmt = pf;
            if (par->sample_aspect_ratio.num > 0 && par->sample_aspect_ratio.den > 0)
                s.sampleAspect = av_q2d(par->sample_aspect_ratio);
            // Left empty when the file is untagged. av_color_*_name answers
            // "unspecified"/"unknown" for those, which reads like a value and
            // is not one.
            if (par->color_space != AVCOL_SPC_UNSPECIFIED)
                if (const char* v = av_color_space_name(par->color_space)) s.colorSpace = v;
            if (par->color_range != AVCOL_RANGE_UNSPECIFIED)
                if (const char* v = av_color_range_name(par->color_range)) s.colorRange = v;
            if (par->color_primaries != AVCOL_PRI_UNSPECIFIED)
                if (const char* v = av_color_primaries_name(par->color_primaries))
                    s.colorPrimaries = v;
            if (par->color_trc != AVCOL_TRC_UNSPECIFIED)
                if (const char* v = av_color_transfer_name(par->color_trc)) s.colorTransfer = v;
            // Rotation lives in a display matrix side-datum; a phone video is
            // 1920x1080 on disk and 1080x1920 on screen, and only this says so.
            //
            // **There is one answer to it in this binary, and this is not a
            // second reading of the matrix.** There used to be: this block
            // truncated where `rotationOf` rounds (an 89.9999° matrix reported
            // 271) and accepted angles that are not quarter turns, which no
            // path here can apply — so the Sources stage could report a
            // rotation the render would not honour and the player could not
            // express. The export reader turns the picture with `rotationOf`
            // and the playback backend above reports it to bro with
            // `rotationOf`; a probe that disagreed with either would lay a clip
            // out at a size nothing produces.
            s.rotation = rotationOf(st);
        } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
            s.sampleRate = par->sample_rate;
            s.channels = par->ch_layout.nb_channels;
            char layout[64] = {0};
            if (av_channel_layout_describe(&par->ch_layout, layout, sizeof(layout)) > 0)
                s.channelLayout = layout;
            if (const char* sf = av_get_sample_fmt_name(static_cast<AVSampleFormat>(par->format)))
                s.sampleFmt = sf;
        }

        if (const AVDictionaryEntry* e = av_dict_get(st->metadata, "language", nullptr, 0))
            s.language = e->value;
        if (const AVDictionaryEntry* e = av_dict_get(st->metadata, "title", nullptr, 0))
            s.title = e->value;

        r.streams.push_back(std::move(s));
    }

    avformat_close_input(&fmt);
    return r;
}

std::string libavVersion() {
    char buf[128];
    std::snprintf(buf, sizeof(buf), "libavformat %u.%u.%u, libavcodec %u.%u.%u",
                  LIBAVFORMAT_VERSION_MAJOR, LIBAVFORMAT_VERSION_MINOR,
                  LIBAVFORMAT_VERSION_MICRO, LIBAVCODEC_VERSION_MAJOR,
                  LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO);
    return buf;
}

std::string libavConfiguration() {
    const char* c = avcodec_configuration();
    return c ? c : "";
}

std::vector<std::string> availableHwAccels() {
    std::vector<std::string> out;
    AVHWDeviceType t = AV_HWDEVICE_TYPE_NONE;
    while ((t = av_hwdevice_iterate_types(t)) != AV_HWDEVICE_TYPE_NONE) {
        if (const char* name = av_hwdevice_get_type_name(t)) out.emplace_back(name);
    }
    return out;
}

} // namespace ffmpegbro
