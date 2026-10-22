// Shared helpers, TrackPrivate, Wrapped frame payload, and OutputSource for
// ffmpeg_backend.cpp and ffmpeg_backend_decoders.cpp. See ffmpeg_backend.h.
#pragma once

#include "ffmpeg_backend.h"

#include "export_frame.h"
#include "live_tap.h"
#include "playback_output.h"

#include "util/log.h"
#include "video/audio_decoder.h"
#include "video/media_backend.h"
#include "video/media_source.h"
#include "video/video_decoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
}

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {
namespace backend_detail {

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

inline TimeNs toNs(int64_t ts, AVRational tb) {
    if (ts == AV_NOPTS_VALUE) return AV_NOPTS_VALUE;
    return av_rescale_q(ts, tb, kNsTimeBase);
}

inline int64_t fromNs(TimeNs ns, AVRational tb) {
    return av_rescale_q(ns, kNsTimeBase, tb);
}

inline Codec toBroCodec(AVCodecID id) {
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
inline std::shared_ptr<std::vector<uint8_t>> wrapOwnedFrame(AVFrame* frame) {
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

inline std::shared_ptr<std::vector<uint8_t>> wrapFrame(const AVPacket* pkt) {
    if (!pkt->data || pkt->size != static_cast<int>(sizeof(AVFrame))) return nullptr;
    // Cloned: the packet the demuxer handed over is unreferenced on the next
    // read, and a clone is a new frame referencing the same buffers rather than
    // a copy of any pixels.
    return wrapOwnedFrame(av_frame_clone(reinterpret_cast<const AVFrame*>(pkt->data)));
}

/// The frame inside such a payload, still owned by it. Null for anything this
/// backend did not write, which is what makes reading it safe.
inline AVFrame* unwrapFrame(const std::vector<uint8_t>* data) {
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

inline std::shared_ptr<TrackPrivate> privateOf(const TrackInfo& t) {
    return std::static_pointer_cast<TrackPrivate>(t.backendPrivate);
}

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

std::unique_ptr<MediaSource> openBackendSource(const std::string& path);

} // namespace backend_detail
} // namespace ffmpegbro
