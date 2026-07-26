#include "ffmpeg_export.h"

#include "util/log.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/avutil.h>
#include <libavutil/display.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ffmpegbro {
namespace {

std::string avErr(int code) {
    char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(code, buf, sizeof(buf));
    return buf;
}

int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/// Rotation from a stream's display matrix, in degrees clockwise. The decoder
/// hands back the picture as it was coded; only this side-datum says a phone
/// held upright wrote a landscape frame.
int rotationOf(const AVStream* st) {
    const AVPacketSideData* sd =
        av_packet_side_data_get(st->codecpar->coded_side_data,
                                st->codecpar->nb_coded_side_data,
                                AV_PKT_DATA_DISPLAYMATRIX);
    if (!sd) return 0;
    double deg = av_display_rotation_get(reinterpret_cast<const int32_t*>(sd->data));
    if (deg != deg) return 0;   // NaN
    int d = static_cast<int>(std::lround(-deg)) % 360;
    if (d < 0) d += 360;
    // Only the right angles can be done by moving pixels around; anything else
    // would need a real resampling pass and does not occur in the wild.
    return (d == 90 || d == 180 || d == 270) ? d : 0;
}

/// Tell swscale which matrix the two sides are in. Without this every
/// conversion runs on libswscale's default — BT.601 — and an HD source
/// decoded with SD coefficients comes out visibly green-shifted in the
/// shadows. Best effort: a scaler that will not take the details still works,
/// it just works the way it always did.
void setColorspace(SwsContext* sws, int srcSpace, int srcFullRange,
                   int dstSpace, int dstFullRange) {
    if (!sws) return;
    int *invTable = nullptr, *table = nullptr;
    int srcRange = 0, dstRange = 0, brightness = 0, contrast = 0, saturation = 0;
    if (sws_getColorspaceDetails(sws, &invTable, &srcRange, &table, &dstRange,
                                 &brightness, &contrast, &saturation) < 0) {
        return;
    }
    sws_setColorspaceDetails(sws, sws_getCoefficients(srcSpace), srcFullRange,
                             sws_getCoefficients(dstSpace), dstFullRange,
                             brightness, contrast, saturation);
}

/// The swscale colour-matrix id for a frame, from its tag and, failing that,
/// its size — which is the same guess every player makes.
int swsSpaceFor(AVColorSpace space, int height) {
    switch (space) {
        case AVCOL_SPC_BT709:       return SWS_CS_ITU709;
        case AVCOL_SPC_BT470BG:     return SWS_CS_ITU601;
        case AVCOL_SPC_SMPTE170M:   return SWS_CS_SMPTE170M;
        case AVCOL_SPC_SMPTE240M:   return SWS_CS_SMPTE240M;
        case AVCOL_SPC_FCC:         return SWS_CS_FCC;
        case AVCOL_SPC_BT2020_NCL:
        case AVCOL_SPC_BT2020_CL:   return SWS_CS_BT2020;
        default: break;
    }
    return height >= 720 ? SWS_CS_ITU709 : SWS_CS_ITU601;
}

// ── An RGBA picture, however it was stored on the way in ───────────────────

struct Rgba {
    std::vector<uint8_t> data;
    int width = 0;
    int height = 0;
    int stride = 0;

    void resize(int w, int h) {
        width = w;
        height = h;
        stride = w * 4;
        data.resize(static_cast<size_t>(stride) * h);
    }
    bool empty() const { return width <= 0 || height <= 0; }
};

/// Turn the picture a quarter, a half or three quarters. Done on RGBA rather
/// than on the decoded planes because at four bytes a pixel it is one loop
/// with no chroma siting to get wrong.
void rotateRgba(const Rgba& src, int degrees, Rgba& dst) {
    if (degrees == 0) return;
    const bool swap = (degrees == 90 || degrees == 270);
    dst.resize(swap ? src.height : src.width, swap ? src.width : src.height);
    const auto* s = reinterpret_cast<const uint32_t*>(src.data.data());
    auto* d = reinterpret_cast<uint32_t*>(dst.data.data());
    const int sw = src.width, sh = src.height;
    const int sStride = src.stride / 4, dStride = dst.stride / 4;

    for (int y = 0; y < sh; ++y) {
        const uint32_t* row = s + static_cast<size_t>(y) * sStride;
        for (int x = 0; x < sw; ++x) {
            int dx, dy;
            if (degrees == 90)       { dx = sh - 1 - y; dy = x; }
            else if (degrees == 180) { dx = sw - 1 - x; dy = sh - 1 - y; }
            else                     { dx = y;          dy = sw - 1 - x; }
            d[static_cast<size_t>(dy) * dStride + dx] = row[x];
        }
    }
}

// ── One clip's pictures ────────────────────────────────────────────────────
//
// Walks a file forward, handing back the frame that covers a requested time.
// Export runs strictly forward at the output frame rate, so the common case is
// "decode a frame or two and hand it over"; a seek only happens at the start
// and if the caller jumps.

class SourceVideo {
public:
    ~SourceVideo() { close(); }

    bool open(const std::string& path, std::string* err) {
        int rc = avformat_open_input(&fmt_, path.c_str(), nullptr, nullptr);
        if (rc < 0) { if (err) *err = path + ": " + avErr(rc); return false; }
        rc = avformat_find_stream_info(fmt_, nullptr);
        if (rc < 0) { if (err) *err = path + ": " + avErr(rc); return false; }

        stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        if (stream_ < 0) { if (err) *err = path + ": no video track"; return false; }

        AVStream* st = fmt_->streams[stream_];
        rotation_ = rotationOf(st);
        timeBase_ = st->time_base;
        startOffset_ = fmt_->start_time != AV_NOPTS_VALUE
                           ? fmt_->start_time / double(AV_TIME_BASE) : 0.0;

        const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
        if (!codec) { if (err) *err = path + ": no decoder for this video"; return false; }
        dec_ = avcodec_alloc_context3(codec);
        if (!dec_ || avcodec_parameters_to_context(dec_, st->codecpar) < 0) return false;
        dec_->thread_count = 0;
        dec_->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
        dec_->pkt_timebase = timeBase_;
        rc = avcodec_open2(dec_, codec, nullptr);
        if (rc < 0) { if (err) *err = path + ": " + avErr(rc); return false; }

        // Every stream on the file except this one is skipped in the demuxer,
        // so a 1080p sibling track costs nothing to walk past.
        for (unsigned i = 0; i < fmt_->nb_streams; ++i)
            fmt_->streams[i]->discard =
                (static_cast<int>(i) == stream_) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;

        pkt_ = av_packet_alloc();
        cur_ = av_frame_alloc();
        pending_ = av_frame_alloc();
        return pkt_ && cur_ && pending_;
    }

    /// The picture on screen at `t` seconds into the file, as RGBA in display
    /// orientation. Null past the end of the file.
    ///
    /// The conversion is cached against the decoded frame, not the request:
    /// exporting 30 fps from a 60 fps source asks for the same picture twice
    /// and converts it once.
    const Rgba* rgbaAt(double t) {
        if (!advanceTo(t)) return nullptr;
        if (haveRgba_ && rgbaPts_ == curPts_) return result_;

        const int w = cur_->width, h = cur_->height;
        if (w <= 0 || h <= 0) return nullptr;

        const auto fmt = static_cast<AVPixelFormat>(cur_->format);
        toRgba_ = sws_getCachedContext(toRgba_, w, h, fmt, w, h, AV_PIX_FMT_RGBA,
                                       SWS_BICUBIC, nullptr, nullptr, nullptr);
        if (!toRgba_) return nullptr;
        if (fmt != swsFmt_) {
            // Only worth redoing when the format changes; the details stick to
            // the context otherwise.
            setColorspace(toRgba_, swsSpaceFor(cur_->colorspace, h),
                          cur_->color_range == AVCOL_RANGE_JPEG ? 1 : 0,
                          SWS_CS_ITU709, 1);
            swsFmt_ = fmt;
        }

        raw_.resize(w, h);
        uint8_t* dst[4] = {raw_.data.data(), nullptr, nullptr, nullptr};
        int dstStride[4] = {raw_.stride, 0, 0, 0};
        if (sws_scale(toRgba_, cur_->data, cur_->linesize, 0, h, dst, dstStride) <= 0)
            return nullptr;

        // Upright media is handed back where it was converted; only a rotated
        // clip pays for the second buffer.
        if (rotation_) { rotateRgba(raw_, rotation_, rotated_); result_ = &rotated_; }
        else result_ = &raw_;

        haveRgba_ = true;
        rgbaPts_ = curPts_;
        return result_;
    }

private:
    void close() {
        if (toRgba_) sws_freeContext(toRgba_);
        if (cur_) av_frame_free(&cur_);
        if (pending_) av_frame_free(&pending_);
        if (pkt_) av_packet_free(&pkt_);
        if (dec_) avcodec_free_context(&dec_);
        if (fmt_) avformat_close_input(&fmt_);
    }

    double ptsOf(const AVFrame* f) const {
        int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE ? f->best_effort_timestamp
                                                                : f->pts;
        if (ts == AV_NOPTS_VALUE) return 0.0;
        return ts * av_q2d(timeBase_) - startOffset_;
    }

    void seekTo(double t) {
        const int64_t target = static_cast<int64_t>(
            std::llround(std::max(0.0, t + startOffset_) / av_q2d(timeBase_)));
        av_seek_frame(fmt_, stream_, target, AVSEEK_FLAG_BACKWARD);
        avcodec_flush_buffers(dec_);
        haveCur_ = havePending_ = haveRgba_ = false;
        drained_ = eof_ = false;
        started_ = true;
    }

    /// Leave `cur_` holding the last frame at or before `t`.
    bool advanceTo(double t) {
        // A backward jump, or the very first call, needs the demuxer moved.
        // A long forward jump is cheaper as a seek than as a decode of
        // everything in between — a clip whose in-point is minutes into a file
        // would otherwise decode those minutes.
        if (!started_ || t < curPts_ - 0.001 || (haveCur_ && t > curPts_ + 5.0))
            seekTo(t);

        for (;;) {
            if (havePending_) {
                if (pendingPts_ <= t + 1e-6 || !haveCur_) {
                    std::swap(cur_, pending_);
                    curPts_ = pendingPts_;
                    haveCur_ = true;
                    havePending_ = false;
                    continue;
                }
                break;      // the next picture belongs to a later moment
            }
            if (!decodeOne()) break;
        }
        return haveCur_;
    }

    /// Fill `pending_` with the next decoded frame. False at end of file.
    bool decodeOne() {
        for (;;) {
            av_frame_unref(pending_);
            int rc = avcodec_receive_frame(dec_, pending_);
            if (rc == 0) {
                pendingPts_ = ptsOf(pending_);
                havePending_ = true;
                return true;
            }
            if (rc == AVERROR_EOF) return false;
            if (rc != AVERROR(EAGAIN)) return false;
            if (eof_) {
                if (drained_) return false;
                // The reorder buffer still holds pictures; a null packet is
                // how libavcodec is asked for them.
                avcodec_send_packet(dec_, nullptr);
                drained_ = true;
                continue;
            }

            av_packet_unref(pkt_);
            rc = av_read_frame(fmt_, pkt_);
            if (rc < 0) { eof_ = true; continue; }
            if (pkt_->stream_index != stream_) continue;
            if (avcodec_send_packet(dec_, pkt_) < 0) {
                // A damaged packet is not the end of the clip; the next
                // keyframe picks the picture back up.
                continue;
            }
        }
    }

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    AVFrame* cur_ = nullptr;
    AVFrame* pending_ = nullptr;
    SwsContext* toRgba_ = nullptr;
    AVPixelFormat swsFmt_ = AV_PIX_FMT_NONE;
    Rgba raw_, rotated_;
    const Rgba* result_ = nullptr;

    int stream_ = -1;
    int rotation_ = 0;
    AVRational timeBase_{1, 1000};
    double startOffset_ = 0.0;
    double curPts_ = 0.0, pendingPts_ = 0.0, rgbaPts_ = -1.0;
    bool haveCur_ = false, havePending_ = false, haveRgba_ = false;
    bool started_ = false, eof_ = false, drained_ = false;
};

// ── One clip's sound ───────────────────────────────────────────────────────
//
// Pulled a block at a time at the output rate, so the mixer can ask for
// exactly the samples one output frame covers and get them sample-accurately
// from wherever in the file the clip's in-point is.

class SourceAudio {
public:
    ~SourceAudio() { close(); }

    /// False when the file simply has no audio, which is not an error — a
    /// silent clip is a clip.
    bool open(const std::string& path, int outRate, int outChannels) {
        outRate_ = outRate;
        outChannels_ = outChannels;
        if (avformat_open_input(&fmt_, path.c_str(), nullptr, nullptr) < 0) return false;
        if (avformat_find_stream_info(fmt_, nullptr) < 0) return false;

        stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
        if (stream_ < 0) return false;

        AVStream* st = fmt_->streams[stream_];
        timeBase_ = st->time_base;
        startOffset_ = fmt_->start_time != AV_NOPTS_VALUE
                           ? fmt_->start_time / double(AV_TIME_BASE) : 0.0;

        const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
        if (!codec) return false;
        dec_ = avcodec_alloc_context3(codec);
        if (!dec_ || avcodec_parameters_to_context(dec_, st->codecpar) < 0) return false;
        dec_->pkt_timebase = timeBase_;
        if (avcodec_open2(dec_, codec, nullptr) < 0) return false;

        for (unsigned i = 0; i < fmt_->nb_streams; ++i)
            fmt_->streams[i]->discard =
                (static_cast<int>(i) == stream_) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;

        av_channel_layout_default(&outLayout_, outChannels_);
        pkt_ = av_packet_alloc();
        frame_ = av_frame_alloc();
        ok_ = pkt_ && frame_;
        return ok_;
    }

    bool ok() const { return ok_; }

    void seekTo(double srcSeconds) {
        const int64_t target = static_cast<int64_t>(
            std::llround(std::max(0.0, srcSeconds + startOffset_) / av_q2d(timeBase_)));
        av_seek_frame(fmt_, stream_, target, AVSEEK_FLAG_BACKWARD);
        avcodec_flush_buffers(dec_);
        // The resampler holds a tail from before the seek; emitting it after
        // would splice a few milliseconds of the old position onto the new one.
        if (swr_) { swr_free(&swr_); swrRate_ = 0; swrFmt_ = AV_SAMPLE_FMT_NONE; }
        fifo_.clear();
        head_ = 0;
        eof_ = drained_ = false;
        // How much of the first decoded frame to throw away is only knowable
        // once we see where the seek actually landed.
        seekTarget_ = srcSeconds;
        awaitingSeek_ = true;
    }

    /// Add `frames` samples of this clip, scaled by `gain`, into `dst`.
    /// Past the end of the file it adds nothing, which is silence.
    void mixInto(float* dst, int frames, float gain) {
        int done = 0;
        while (done < frames) {
            if (available() == 0 && !fill()) break;
            const int n = std::min(frames - done, available());
            if (n <= 0) break;
            const float* src = fifo_.data() + head_;
            const int count = n * outChannels_;
            for (int i = 0; i < count; ++i) dst[done * outChannels_ + i] += src[i] * gain;
            head_ += static_cast<size_t>(count);
            done += n;
            compact();
        }
    }

    /// Move past `frames` samples without mixing them — what a muted clip
    /// needs so an unmuted one after it in the same file stays lined up.
    void skip(int frames) {
        int done = 0;
        while (done < frames) {
            if (available() == 0 && !fill()) break;
            const int n = std::min(frames - done, available());
            if (n <= 0) break;
            head_ += static_cast<size_t>(n) * outChannels_;
            done += n;
            compact();
        }
    }

private:
    void close() {
        if (swr_) swr_free(&swr_);
        if (frame_) av_frame_free(&frame_);
        if (pkt_) av_packet_free(&pkt_);
        if (dec_) avcodec_free_context(&dec_);
        if (fmt_) avformat_close_input(&fmt_);
        av_channel_layout_uninit(&outLayout_);
    }

    int available() const {
        return static_cast<int>((fifo_.size() - head_) / outChannels_);
    }

    void compact() {
        // Drop the consumed front once it is worth the memmove.
        if (head_ >= 65536) {
            fifo_.erase(fifo_.begin(), fifo_.begin() + static_cast<long>(head_));
            head_ = 0;
        }
    }

    /// Decode one packet's worth into the fifo. False at end of file.
    bool fill() {
        for (;;) {
            int rc = avcodec_receive_frame(dec_, frame_);
            if (rc == 0) {
                append();
                av_frame_unref(frame_);
                if (available() > 0) return true;
                continue;       // the whole frame was skipped past
            }
            if (rc == AVERROR_EOF) return false;
            if (rc != AVERROR(EAGAIN)) return false;
            if (eof_) {
                if (drained_) return false;
                avcodec_send_packet(dec_, nullptr);
                drained_ = true;
                continue;
            }

            av_packet_unref(pkt_);
            rc = av_read_frame(fmt_, pkt_);
            if (rc < 0) { eof_ = true; continue; }
            if (pkt_->stream_index != stream_) continue;
            if (avcodec_send_packet(dec_, pkt_) < 0) continue;
        }
    }

    /// Resample the decoded frame to the output rate and layout and append it,
    /// dropping whatever sits before the point the last seek asked for.
    void append() {
        const auto inFmt = static_cast<AVSampleFormat>(frame_->format);
        if (!swr_ || inFmt != swrFmt_ || frame_->sample_rate != swrRate_) {
            if (swr_) swr_free(&swr_);
            int rc = swr_alloc_set_opts2(&swr_, &outLayout_, AV_SAMPLE_FMT_FLT, outRate_,
                                         &frame_->ch_layout, inFmt, frame_->sample_rate,
                                         0, nullptr);
            if (rc < 0 || !swr_ || swr_init(swr_) < 0) return;
            swrFmt_ = inFmt;
            swrRate_ = frame_->sample_rate;
        }

        int skip = 0;
        if (awaitingSeek_) {
            awaitingSeek_ = false;
            int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                             ? frame_->best_effort_timestamp : frame_->pts;
            const double at = ts != AV_NOPTS_VALUE
                                  ? ts * av_q2d(timeBase_) - startOffset_ : 0.0;
            // A seek lands on a packet boundary at or before the target; the
            // difference is what makes an in-point sample-accurate instead of
            // up to a packet early.
            skip = clampi(static_cast<int>(std::llround((seekTarget_ - at) * outRate_)),
                          0, 1 << 24);
        }

        const int64_t delay = swr_get_delay(swr_, outRate_);
        const int maxOut = static_cast<int>(av_rescale_rnd(
            delay + frame_->nb_samples, outRate_, frame_->sample_rate, AV_ROUND_UP));
        if (maxOut <= 0) return;

        const size_t base = fifo_.size();
        fifo_.resize(base + static_cast<size_t>(maxOut) * outChannels_);
        auto* dst = reinterpret_cast<uint8_t*>(fifo_.data() + base);
        const int written = swr_convert(swr_, &dst, maxOut,
                                        const_cast<const uint8_t**>(frame_->extended_data),
                                        frame_->nb_samples);
        if (written < 0) { fifo_.resize(base); return; }
        fifo_.resize(base + static_cast<size_t>(written) * outChannels_);

        if (skip > 0) {
            const size_t drop = std::min(static_cast<size_t>(skip) * outChannels_,
                                         fifo_.size() - head_);
            head_ += drop;
        }
    }

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    AVFrame* frame_ = nullptr;
    SwrContext* swr_ = nullptr;
    AVChannelLayout outLayout_{};
    AVSampleFormat swrFmt_ = AV_SAMPLE_FMT_NONE;
    std::vector<float> fifo_;
    size_t head_ = 0;

    int stream_ = -1;
    int outRate_ = 48000, outChannels_ = 2, swrRate_ = 0;
    AVRational timeBase_{1, 1000};
    double startOffset_ = 0.0;
    double seekTarget_ = 0.0;
    bool awaitingSeek_ = false, eof_ = false, drained_ = false, ok_ = false;
};

// ── The compositor ─────────────────────────────────────────────────────────
//
// The same arithmetic ui/viewer.js does with a div and overflow:hidden: the
// window is the kept part of the placed rectangle, and the picture inside it
// stays whole. Doing it here on pixels rather than on style properties is the
// only difference between what you are looking at and what gets written.

class Compositor {
public:
    Compositor(int w, int h, int swsFlags = SWS_BICUBIC) : flags_(swsFlags) {
        canvas_.resize(w, h);
    }

    void clear() {
        // Opaque black, so a canvas nothing covers exports as letterbox rather
        // than as whatever the encoder makes of zero alpha.
        auto* p = reinterpret_cast<uint32_t*>(canvas_.data.data());
        const size_t n = canvas_.data.size() / 4;
        const uint32_t black = 0xFF000000u;      // little-endian RGBA: A=255
        for (size_t i = 0; i < n; ++i) p[i] = black;
    }

    /// Place one clip's picture. `src` is in display orientation.
    void draw(const Rgba& src, const ExportClip& c, SwsContext*& sws) {
        if (src.empty() || c.opacity <= 0.001) return;

        const double keepW = 1.0 - c.cropL - c.cropR;
        const double keepH = 1.0 - c.cropT - c.cropB;
        if (keepW <= 0.0 || keepH <= 0.0) return;

        // Where the kept part lands, and which part of the source it is.
        const int dstX = static_cast<int>(std::lround(c.x + c.w * c.cropL));
        const int dstY = static_cast<int>(std::lround(c.y + c.h * c.cropT));
        const int dstW = std::max(1, static_cast<int>(std::lround(c.w * keepW)));
        const int dstH = std::max(1, static_cast<int>(std::lround(c.h * keepH)));

        // Wholly off the canvas: nothing to do, and no scaler to build.
        if (dstX >= canvas_.width || dstY >= canvas_.height ||
            dstX + dstW <= 0 || dstY + dstH <= 0) {
            return;
        }

        const int srcX = clampi(static_cast<int>(std::lround(src.width * c.cropL)),
                                0, src.width - 1);
        const int srcY = clampi(static_cast<int>(std::lround(src.height * c.cropT)),
                                0, src.height - 1);
        const int srcW = clampi(static_cast<int>(std::lround(src.width * keepW)),
                                1, src.width - srcX);
        const int srcH = clampi(static_cast<int>(std::lround(src.height * keepH)),
                                1, src.height - srcY);

        // Cropping is a pointer offset, exactly, because RGBA has no chroma
        // plane to keep aligned — which is the whole reason the source is
        // converted before it is cropped rather than after.
        const uint8_t* srcData[4] = {
            src.data.data() + static_cast<size_t>(srcY) * src.stride + srcX * 4,
            nullptr, nullptr, nullptr};
        const int srcStride[4] = {src.stride, 0, 0, 0};

        sws = sws_getCachedContext(sws, srcW, srcH, AV_PIX_FMT_RGBA,
                                   dstW, dstH, AV_PIX_FMT_RGBA,
                                   flags_, nullptr, nullptr, nullptr);
        if (!sws) return;

        scratch_.resize(dstW, dstH);
        uint8_t* dstData[4] = {scratch_.data.data(), nullptr, nullptr, nullptr};
        int dstStride[4] = {scratch_.stride, 0, 0, 0};
        if (sws_scale(sws, srcData, srcStride, 0, srcH, dstData, dstStride) <= 0) return;

        blend(scratch_, dstX, dstY, c.opacity);
    }

    const Rgba& canvas() const { return canvas_; }

private:
    /// Alpha-composite `img` at (ox, oy), clipped to the canvas. The source's
    /// own alpha and the clip's opacity multiply, so a ProRes 4444 with a real
    /// alpha channel at 50% behaves the way both say it should.
    void blend(const Rgba& img, int ox, int oy, double opacity) {
        const int x0 = std::max(0, ox), y0 = std::max(0, oy);
        const int x1 = std::min(canvas_.width, ox + img.width);
        const int y1 = std::min(canvas_.height, oy + img.height);
        if (x1 <= x0 || y1 <= y0) return;

        const int op = clampi(static_cast<int>(std::lround(opacity * 255.0)), 0, 255);
        for (int y = y0; y < y1; ++y) {
            const uint8_t* s = img.data.data() +
                               static_cast<size_t>(y - oy) * img.stride + (x0 - ox) * 4;
            uint8_t* d = canvas_.data.data() +
                         static_cast<size_t>(y) * canvas_.stride + x0 * 4;
            for (int x = x0; x < x1; ++x, s += 4, d += 4) {
                const int a = (s[3] * op + 127) / 255;
                if (a == 0) continue;
                if (a == 255) {
                    d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
                } else {
                    const int ia = 255 - a;
                    d[0] = static_cast<uint8_t>((s[0] * a + d[0] * ia + 127) / 255);
                    d[1] = static_cast<uint8_t>((s[1] * a + d[1] * ia + 127) / 255);
                    d[2] = static_cast<uint8_t>((s[2] * a + d[2] * ia + 127) / 255);
                }
                d[3] = 255;
            }
        }
    }

    Rgba canvas_, scratch_;
    int flags_ = SWS_BICUBIC;
};

// ── The output file ────────────────────────────────────────────────────────

/// Does this encoder take -crf? Asking libavcodec directly rather than keeping
/// a list: the option exists on the private context of the encoders that have
/// it, and nowhere else.
bool hasOption(const AVCodec* codec, const char* name) {
    if (!codec || !codec->priv_class) return false;
    // AV_OPT_SEARCH_FAKE_OBJ means "this is a class pointer, not an instance",
    // which is the documented way to ask what an encoder takes before there is
    // a context to ask about.
    void* fakeObj = const_cast<void*>(static_cast<const void*>(&codec->priv_class));
    return av_opt_find(fakeObj, name, nullptr, 0, AV_OPT_SEARCH_FAKE_OBJ) != nullptr;
}

/// The pixel format an encoder would rather have. yuv420p when it will take
/// it — everything plays that — and its own first choice when it will not.
AVPixelFormat pickPixelFormat(const AVCodec* codec) {
    const void* list = nullptr;
    int n = 0;
    if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0,
                                     &list, &n) < 0 || !list) {
        return AV_PIX_FMT_YUV420P;      // no list means anything goes
    }
    const auto* fmts = static_cast<const AVPixelFormat*>(list);
    for (int i = 0; i < n; ++i) if (fmts[i] == AV_PIX_FMT_YUV420P) return AV_PIX_FMT_YUV420P;
    return n > 0 ? fmts[0] : AV_PIX_FMT_YUV420P;
}

/// Would this encoder accept that pixel format? An encoder with no advertised
/// list takes whatever it is given, so an empty answer is yes.
bool encoderTakesPixelFormat(const AVCodec* codec, AVPixelFormat want) {
    const void* list = nullptr;
    int n = 0;
    if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0,
                                     &list, &n) < 0 || !list) {
        return true;
    }
    const auto* fmts = static_cast<const AVPixelFormat*>(list);
    for (int i = 0; i < n; ++i) if (fmts[i] == want) return true;
    return false;
}

AVSampleFormat pickSampleFormat(const AVCodec* codec) {
    const void* list = nullptr;
    int n = 0;
    if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
                                     &list, &n) < 0 || !list) {
        return AV_SAMPLE_FMT_FLTP;
    }
    const auto* fmts = static_cast<const AVSampleFormat*>(list);
    for (int i = 0; i < n; ++i) if (fmts[i] == AV_SAMPLE_FMT_FLTP) return AV_SAMPLE_FMT_FLTP;
    return n > 0 ? fmts[0] : AV_SAMPLE_FMT_FLTP;
}

/// The nearest sample rate an encoder will accept. Opus only does 48/24/16/12/8
/// kHz, and handing it 44100 fails at open with nothing useful said.
int pickSampleRate(const AVCodec* codec, int want) {
    const void* list = nullptr;
    int n = 0;
    if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_SAMPLE_RATE, 0,
                                     &list, &n) < 0 || !list) {
        return want;
    }
    const int* rates = static_cast<const int*>(list);
    int best = want, bestDist = INT32_MAX;
    for (int i = 0; i < n; ++i) {
        const int d = std::abs(rates[i] - want);
        if (d < bestDist) { bestDist = d; best = rates[i]; }
    }
    return best;
}

/// The swscale algorithm named. Bicubic is the default because it is what a
/// scale down from 4K wants; lanczos is sharper and ringier, and point is there
/// for the person who is testing whether a resample happened at all.
int scalerFlag(const std::string& name) {
    if (name == "fast_bilinear") return SWS_FAST_BILINEAR;
    if (name == "bilinear")      return SWS_BILINEAR;
    if (name == "neighbor" || name == "point") return SWS_POINT;
    if (name == "area")          return SWS_AREA;
    if (name == "gauss")         return SWS_GAUSS;
    if (name == "sinc")          return SWS_SINC;
    if (name == "lanczos")       return SWS_LANCZOS;
    if (name == "spline")        return SWS_SPLINE;
    return SWS_BICUBIC;
}

/// Apply `-key value` pairs to an AVOption-carrying object.
///
/// AV_OPT_SEARCH_CHILDREN is what makes one call reach both the generic
/// AVCodecContext options and the encoder's own private ones, which is exactly
/// how the ffmpeg command line applies its arguments — so anything documented
/// for `ffmpeg -c:v libx265 -x265-params …` works here, unchanged.
///
/// A key the encoder does not have is reported rather than dropped. A setting
/// that silently does nothing is the worst outcome of the three: the render
/// succeeds, the file is wrong, and nothing said so.
bool applyOptions(void* obj, const std::vector<ExportOption>& opts,
                  const char* what, std::string* err) {
    for (const auto& o : opts) {
        if (o.key.empty()) continue;
        const int rc = av_opt_set(obj, o.key.c_str(), o.value.c_str(),
                                  AV_OPT_SEARCH_CHILDREN);
        if (rc == AVERROR_OPTION_NOT_FOUND) {
            *err = std::string("the ") + what + " encoder has no option '" + o.key + "'";
            return false;
        }
        if (rc < 0) {
            *err = std::string("the ") + what + " option '" + o.key + "' will not take '" +
                   o.value + "': " + avErr(rc);
            return false;
        }
    }
    return true;
}

class Writer {
public:
    ~Writer() { close(); }

    bool open(const ExportSettings& s, bool wantAudio, std::string* err) {
        settings_ = s;

        int rc = avformat_alloc_output_context2(&oc_, nullptr, nullptr, s.path.c_str());
        if (rc < 0 || !oc_) {
            *err = "cannot write '" + s.path + "': " + avErr(rc);
            return false;
        }

        if (!openVideo(err)) return false;
        if (wantAudio && s.includeAudio && !openAudio(err)) return false;

        if (!(oc_->oformat->flags & AVFMT_NOFILE)) {
            rc = avio_open(&oc_->pb, s.path.c_str(), AVIO_FLAG_WRITE);
            if (rc < 0) { *err = "cannot open '" + s.path + "': " + avErr(rc); return false; }
        }
        if (!s.title.empty())
            av_dict_set(&oc_->metadata, "title", s.title.c_str(), 0);

        AVDictionary* opts = nullptr;
        // Put the index at the front so the result starts playing before it has
        // finished downloading, and so this app can open it while it is still
        // the thing you just made. It costs a second pass over the file at the
        // end, which is why it can be turned off.
        if (s.faststart && oc_->oformat->name && std::strstr(oc_->oformat->name, "mp4"))
            av_dict_set(&opts, "movflags", "+faststart", 0);
        for (const auto& o : s.formatOptions)
            if (!o.key.empty()) av_dict_set(&opts, o.key.c_str(), o.value.c_str(), 0);
        rc = avformat_write_header(oc_, &opts);
        // Whatever the muxer did not consume, it did not understand. Saying so
        // beats writing a file that quietly ignored half the request.
        if (rc >= 0 && av_dict_count(opts) > 0) {
            const AVDictionaryEntry* e = av_dict_iterate(opts, nullptr);
            *err = std::string("the ") + oc_->oformat->name + " muxer has no option '" +
                   e->key + "'";
            av_dict_free(&opts);
            return false;
        }
        av_dict_free(&opts);
        if (rc < 0) { *err = std::string("cannot write header: ") + avErr(rc); return false; }

        headerWritten_ = true;
        return true;
    }

    /// Encode one composited canvas. `index` is the output frame number, which
    /// is the whole timestamp: a fixed frame rate is what makes the result a
    /// file every editor will accept.
    bool writeVideo(const Rgba& canvas, int64_t index, std::string* err) {
        if (av_frame_make_writable(vframe_) < 0) return false;

        const uint8_t* src[4] = {canvas.data.data(), nullptr, nullptr, nullptr};
        const int srcStride[4] = {canvas.stride, 0, 0, 0};
        if (sws_scale(toEncoder_, src, srcStride, 0, canvas.height,
                      vframe_->data, vframe_->linesize) <= 0) {
            *err = "colour conversion failed";
            return false;
        }
        vframe_->pts = index;
        return encode(venc_, vstream_, vframe_, err);
    }

    /// Take mixed interleaved float samples. They are buffered and handed to
    /// the encoder in exactly the frame size it asked for, because AAC wants
    /// 1024 samples at a time and the video loop produces however many one
    /// frame covers.
    bool writeAudio(const float* interleaved, int frames, std::string* err) {
        if (!aenc_ || frames <= 0) return true;

        const int maxOut = static_cast<int>(av_rescale_rnd(
            swr_get_delay(aswr_, aenc_->sample_rate) + frames,
            aenc_->sample_rate, settings_.audioSampleRate, AV_ROUND_UP));
        if (av_frame_make_writable(aconv_) < 0) return false;
        if (maxOut > aconv_->nb_samples) {
            av_frame_unref(aconv_);
            aconv_->format = aenc_->sample_fmt;
            aconv_->sample_rate = aenc_->sample_rate;
            av_channel_layout_copy(&aconv_->ch_layout, &aenc_->ch_layout);
            aconv_->nb_samples = maxOut + 64;
            if (av_frame_get_buffer(aconv_, 0) < 0) return false;
        }

        const auto* in = reinterpret_cast<const uint8_t*>(interleaved);
        const int written = swr_convert(aswr_, aconv_->extended_data, aconv_->nb_samples,
                                        &in, frames);
        if (written < 0) { *err = "audio resample failed"; return false; }
        if (written == 0) return true;

        if (av_audio_fifo_write(afifo_, reinterpret_cast<void* const*>(aconv_->extended_data),
                                written) < written) {
            *err = "audio buffer full";
            return false;
        }
        return drainFifo(false, err);
    }

    bool finish(std::string* err) {
        if (finished_) return true;
        finished_ = true;

        if (aenc_) {
            // Whatever is left is shorter than a full encoder frame; the
            // encoder pads it rather than dropping the last few milliseconds.
            if (!drainFifo(true, err)) return false;
            if (!encode(aenc_, astream_, nullptr, err)) return false;
        }
        if (venc_ && !encode(venc_, vstream_, nullptr, err)) return false;

        if (headerWritten_) {
            int rc = av_write_trailer(oc_);
            if (rc < 0) { *err = std::string("cannot finish the file: ") + avErr(rc); return false; }
        }
        const std::string path = settings_.path;
        close();

        // How big it came out is asked of the file, not of avio_tell.
        // +faststart rewrites the whole file after the trailer goes down, so
        // the position left behind bears no relation to the result — an mp4
        // that is three quarters of a megabyte on disk reported itself as
        // three kilobytes.
        std::error_code ec;
        const auto size = std::filesystem::file_size(std::filesystem::path(path), ec);
        bytes_ = ec ? 0 : static_cast<int64_t>(size);
        return true;
    }

    int64_t bytesSoFar() const {
        if (bytes_) return bytes_;
        return oc_ && oc_->pb ? avio_tell(oc_->pb) : 0;
    }

    /// How many samples one output frame covers, which is what the mixer
    /// works in.
    int audioSampleRate() const { return aenc_ ? settings_.audioSampleRate : 0; }
    bool hasAudio() const { return aenc_ != nullptr; }

private:
    void close() {
        if (toEncoder_) { sws_freeContext(toEncoder_); toEncoder_ = nullptr; }
        if (aswr_) swr_free(&aswr_);
        if (afifo_) { av_audio_fifo_free(afifo_); afifo_ = nullptr; }
        if (vframe_) av_frame_free(&vframe_);
        if (aconv_) av_frame_free(&aconv_);
        if (aframe_) av_frame_free(&aframe_);
        if (pkt_) av_packet_free(&pkt_);
        if (venc_) avcodec_free_context(&venc_);
        if (aenc_) avcodec_free_context(&aenc_);
        if (oc_) {
            if (oc_->pb && !(oc_->oformat->flags & AVFMT_NOFILE)) avio_closep(&oc_->pb);
            avformat_free_context(oc_);
            oc_ = nullptr;
        }
    }

    bool openVideo(std::string* err) {
        const AVCodec* codec = settings_.videoCodec.empty()
                                   ? avcodec_find_encoder(oc_->oformat->video_codec)
                                   : avcodec_find_encoder_by_name(settings_.videoCodec.c_str());
        if (!codec) {
            *err = "this build has no '" + settings_.videoCodec + "' encoder";
            return false;
        }

        vstream_ = avformat_new_stream(oc_, nullptr);
        venc_ = avcodec_alloc_context3(codec);
        if (!vstream_ || !venc_) { *err = "out of memory"; return false; }

        // A rational frame rate, not a double: 30000/1001 has to survive into
        // the container as itself or every timestamp downstream drifts.
        const AVRational fps = av_d2q(settings_.fps, 1000000);
        venc_->width = settings_.width;
        venc_->height = settings_.height;
        venc_->time_base = av_inv_q(fps);
        venc_->framerate = fps;
        venc_->pix_fmt = pickPixelFormat(codec);
        if (!settings_.pixelFormat.empty()) {
            const AVPixelFormat want = av_get_pix_fmt(settings_.pixelFormat.c_str());
            if (want == AV_PIX_FMT_NONE) {
                *err = "there is no pixel format called '" + settings_.pixelFormat + "'";
                return false;
            }
            if (!encoderTakesPixelFormat(codec, want)) {
                *err = std::string(codec->name) + " cannot write " + settings_.pixelFormat;
                return false;
            }
            venc_->pix_fmt = want;
        }
        venc_->gop_size = std::max(1, static_cast<int>(std::lround(settings_.fps * 2)));
        venc_->thread_count = 0;

        // Tagged to match what the compositor actually produced, so a player
        // does not have to guess and guess differently. "auto" is the guess
        // every player makes — by frame height — which is why it is the
        // default rather than a fixed choice.
        const bool wide = settings_.colorspace == "bt2020";
        const bool hd = settings_.colorspace == "bt709" ||
                        (settings_.colorspace.empty() || settings_.colorspace == "auto"
                             ? settings_.height >= 720 : false);
        if (wide) {
            venc_->colorspace = AVCOL_SPC_BT2020_NCL;
            venc_->color_primaries = AVCOL_PRI_BT2020;
            venc_->color_trc = AVCOL_TRC_BT2020_10;
        } else {
            venc_->colorspace = hd ? AVCOL_SPC_BT709 : AVCOL_SPC_SMPTE170M;
            venc_->color_primaries = hd ? AVCOL_PRI_BT709 : AVCOL_PRI_SMPTE170M;
            venc_->color_trc = hd ? AVCOL_TRC_BT709 : AVCOL_TRC_SMPTE170M;
        }
        const bool fullRange = settings_.colorRange == "pc";
        venc_->color_range = fullRange ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;

        if (settings_.videoBitrateKbps > 0) {
            venc_->bit_rate = int64_t(settings_.videoBitrateKbps) * 1000;
        } else if (hasOption(codec, "crf")) {
            av_opt_set_int(venc_->priv_data, "crf", settings_.crf, 0);
            // libvpx reads a bitrate of 0 as "constant quality"; leaving the
            // default in makes -crf a ceiling instead of the target.
            venc_->bit_rate = 0;
        } else {
            // No constant-quality control: pick a bitrate from the picture
            // rather than let the encoder's 200 kbps default ruin it.
            const double bpp = 0.07;
            venc_->bit_rate = static_cast<int64_t>(
                settings_.width * settings_.height * settings_.fps * bpp);
        }
        if (!settings_.preset.empty() && hasOption(codec, "preset"))
            av_opt_set(venc_->priv_data, "preset", settings_.preset.c_str(), 0);

        if (oc_->oformat->flags & AVFMT_GLOBALHEADER)
            venc_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

        // Last, so anything the caller asked for explicitly beats what was
        // worked out above. A UI that offers both a Quality slider and a raw
        // option editor has to have one of them win, and it should be the one
        // where the user typed the name of the thing.
        if (!applyOptions(venc_, settings_.videoOptions, "video", err)) return false;

        int rc = avcodec_open2(venc_, codec, nullptr);
        if (rc < 0) {
            *err = std::string("cannot open the ") + codec->name + " encoder: " + avErr(rc);
            return false;
        }
        if (avcodec_parameters_from_context(vstream_->codecpar, venc_) < 0) return false;
        vstream_->time_base = venc_->time_base;
        vstream_->avg_frame_rate = fps;

        vframe_ = av_frame_alloc();
        pkt_ = av_packet_alloc();
        if (!vframe_ || !pkt_) return false;
        vframe_->format = venc_->pix_fmt;
        vframe_->width = venc_->width;
        vframe_->height = venc_->height;
        if (av_frame_get_buffer(vframe_, 0) < 0) { *err = "out of memory"; return false; }

        toEncoder_ = sws_getCachedContext(nullptr, settings_.width, settings_.height,
                                          AV_PIX_FMT_RGBA, settings_.width, settings_.height,
                                          venc_->pix_fmt, scalerFlag(settings_.scaler),
                                          nullptr, nullptr, nullptr);
        if (!toEncoder_) { *err = "cannot build the output colour converter"; return false; }
        setColorspace(toEncoder_, SWS_CS_ITU709, 1,
                      wide ? SWS_CS_BT2020 : (hd ? SWS_CS_ITU709 : SWS_CS_ITU601),
                      fullRange ? 1 : 0);
        return true;
    }

    bool openAudio(std::string* err) {
        const AVCodec* codec = settings_.audioCodec.empty()
                                   ? avcodec_find_encoder(oc_->oformat->audio_codec)
                                   : avcodec_find_encoder_by_name(settings_.audioCodec.c_str());
        if (!codec) {
            // A container that cannot hold sound, or a name this build lacks:
            // say so, but a silent video is still worth writing.
            LOG_WARN("ffmpeg: no '%s' audio encoder; writing video only",
                     settings_.audioCodec.c_str());
            return true;
        }

        astream_ = avformat_new_stream(oc_, nullptr);
        aenc_ = avcodec_alloc_context3(codec);
        if (!astream_ || !aenc_) { *err = "out of memory"; return false; }

        aenc_->sample_fmt = pickSampleFormat(codec);
        aenc_->sample_rate = pickSampleRate(codec, settings_.audioSampleRate);
        aenc_->bit_rate = int64_t(settings_.audioBitrateKbps) * 1000;
        av_channel_layout_default(&aenc_->ch_layout, settings_.audioChannels);
        aenc_->time_base = AVRational{1, aenc_->sample_rate};
        if (oc_->oformat->flags & AVFMT_GLOBALHEADER)
            aenc_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

        if (!applyOptions(aenc_, settings_.audioOptions, "audio", err)) return false;

        int rc = avcodec_open2(aenc_, codec, nullptr);
        if (rc < 0) {
            *err = std::string("cannot open the ") + codec->name + " encoder: " + avErr(rc);
            return false;
        }
        if (avcodec_parameters_from_context(astream_->codecpar, aenc_) < 0) return false;
        astream_->time_base = aenc_->time_base;

        // Some encoders take any number of samples; 1024 is a sane block for
        // the ones that do.
        frameSize_ = aenc_->frame_size > 0 ? aenc_->frame_size : 1024;

        AVChannelLayout inLayout;
        av_channel_layout_default(&inLayout, settings_.audioChannels);
        rc = swr_alloc_set_opts2(&aswr_, &aenc_->ch_layout, aenc_->sample_fmt,
                                 aenc_->sample_rate, &inLayout, AV_SAMPLE_FMT_FLT,
                                 settings_.audioSampleRate, 0, nullptr);
        av_channel_layout_uninit(&inLayout);
        if (rc < 0 || !aswr_ || swr_init(aswr_) < 0) {
            *err = "cannot build the audio resampler";
            return false;
        }

        afifo_ = av_audio_fifo_alloc(aenc_->sample_fmt, aenc_->ch_layout.nb_channels,
                                     frameSize_ * 8);
        aconv_ = av_frame_alloc();
        aframe_ = av_frame_alloc();
        if (!afifo_ || !aconv_ || !aframe_) { *err = "out of memory"; return false; }

        aconv_->format = aenc_->sample_fmt;
        aconv_->sample_rate = aenc_->sample_rate;
        av_channel_layout_copy(&aconv_->ch_layout, &aenc_->ch_layout);
        aconv_->nb_samples = frameSize_ * 4;
        if (av_frame_get_buffer(aconv_, 0) < 0) { *err = "out of memory"; return false; }

        aframe_->format = aenc_->sample_fmt;
        aframe_->sample_rate = aenc_->sample_rate;
        av_channel_layout_copy(&aframe_->ch_layout, &aenc_->ch_layout);
        aframe_->nb_samples = frameSize_;
        if (av_frame_get_buffer(aframe_, 0) < 0) { *err = "out of memory"; return false; }
        return true;
    }

    /// Hand the encoder every whole frame the fifo can fill. At the end of the
    /// job `flushTail` takes the short one too.
    bool drainFifo(bool flushTail, std::string* err) {
        while (av_audio_fifo_size(afifo_) >= frameSize_ ||
               (flushTail && av_audio_fifo_size(afifo_) > 0)) {
            const int want = std::min(frameSize_, av_audio_fifo_size(afifo_));
            if (av_frame_make_writable(aframe_) < 0) return false;
            if (av_audio_fifo_read(afifo_, reinterpret_cast<void* const*>(aframe_->data),
                                   want) < want) {
                *err = "audio buffer underrun";
                return false;
            }
            // A short final frame is legal; the encoder pads it itself.
            aframe_->nb_samples = want;
            aframe_->pts = audioPts_;
            audioPts_ += want;
            if (!encode(aenc_, astream_, aframe_, err)) return false;
            aframe_->nb_samples = frameSize_;
        }
        return true;
    }

    bool encode(AVCodecContext* ctx, AVStream* st, AVFrame* frame, std::string* err) {
        int rc = avcodec_send_frame(ctx, frame);
        if (rc < 0 && rc != AVERROR_EOF) {
            *err = std::string("encode failed: ") + avErr(rc);
            return false;
        }
        for (;;) {
            av_packet_unref(pkt_);
            rc = avcodec_receive_packet(ctx, pkt_);
            if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
            if (rc < 0) { *err = std::string("encode failed: ") + avErr(rc); return false; }

            av_packet_rescale_ts(pkt_, ctx->time_base, st->time_base);
            pkt_->stream_index = st->index;
            rc = av_interleaved_write_frame(oc_, pkt_);
            if (rc < 0) { *err = std::string("cannot write to the file: ") + avErr(rc); return false; }
        }
    }

    ExportSettings settings_;
    AVFormatContext* oc_ = nullptr;
    AVStream* vstream_ = nullptr;
    AVStream* astream_ = nullptr;
    AVCodecContext* venc_ = nullptr;
    AVCodecContext* aenc_ = nullptr;
    AVFrame* vframe_ = nullptr;
    AVFrame* aframe_ = nullptr;
    AVFrame* aconv_ = nullptr;
    AVPacket* pkt_ = nullptr;
    SwsContext* toEncoder_ = nullptr;
    SwrContext* aswr_ = nullptr;
    AVAudioFifo* afifo_ = nullptr;
    int frameSize_ = 1024;
    int64_t audioPts_ = 0;
    int64_t bytes_ = 0;
    bool headerWritten_ = false;
    bool finished_ = false;
};

// ── The job ────────────────────────────────────────────────────────────────

struct Job {
    std::mutex mu;
    ExportStatus status;
    std::atomic<bool> cancel{false};
    std::atomic<bool> running{false};
    std::thread thread;
};

Job& job() {
    static Job j;
    return j;
}

void setStatus(const ExportStatus& s) {
    Job& j = job();
    std::lock_guard<std::mutex> lock(j.mu);
    j.status = s;
}

/// Everything one clip needs open at once. Built lazily: a two-hour timeline
/// of a hundred clips would otherwise open a hundred files, and their
/// decoders, before writing a frame.
struct ClipState {
    ExportClip spec;
    std::unique_ptr<SourceVideo> video;
    std::unique_ptr<SourceAudio> audio;
    SwsContext* scaler = nullptr;
    bool videoFailed = false;
    bool audioPrimed = false;
    ~ClipState() { if (scaler) sws_freeContext(scaler); }
};

/// Clears the running flag however the job leaves — including the early return
/// when the file cannot be opened at all. Without this, one failed render (a
/// codec this build lacks, a path that cannot be written) leaves the flag set
/// and every export after it is refused with "already running".
struct RunningFlag {
    ~RunningFlag() { job().running.store(false); }
};

void runExport(ExportSettings s, std::vector<ExportClip> clips) {
    RunningFlag clearOnExit;
    const auto began = std::chrono::steady_clock::now();
    ExportStatus st;
    st.state = ExportStatus::State::Running;
    st.path = s.path;
    st.stage = "opening";

    const double span = std::max(0.0, s.endTime - s.startTime);
    const int64_t total = std::max<int64_t>(1, std::llround(span * s.fps));
    st.framesTotal = total;
    setStatus(st);

    // Bottom of the stack first, so a higher track paints over a lower one —
    // the same order the viewer shows and for the same reason.
    std::stable_sort(clips.begin(), clips.end(),
                     [](const ExportClip& a, const ExportClip& b) { return a.z < b.z; });

    std::vector<std::unique_ptr<ClipState>> states;
    states.reserve(clips.size());
    bool anyAudio = false;
    for (const auto& c : clips) {
        auto cs = std::make_unique<ClipState>();
        cs->spec = c;
        // Cheap enough to ask now — it is a header read, and knowing whether
        // any clip has sound decides whether the file gets an audio track at
        // all, which has to be settled before the header is written.
        if (s.includeAudio && !c.muted && c.volume > 0.0) {
            cs->audio = std::make_unique<SourceAudio>();
            if (cs->audio->open(c.path, s.audioSampleRate, s.audioChannels)) anyAudio = true;
            else cs->audio.reset();
        }
        states.push_back(std::move(cs));
    }

    Writer writer;
    std::string err;
    if (!writer.open(s, anyAudio, &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        return;
    }

    Compositor comp(s.width, s.height, scalerFlag(s.scaler));
    std::vector<float> mix;
    const int rate = s.audioSampleRate;
    const int channels = s.audioChannels;
    int64_t samplesWritten = 0;

    st.stage = "rendering";
    setStatus(st);

    for (int64_t n = 0; n < total; ++n) {
        if (job().cancel.load()) {
            st.state = ExportStatus::State::Cancelled;
            st.stage = "cancelled";
            break;
        }

        const double t = s.startTime + double(n) / s.fps;

        // ── picture ────────────────────────────────────────────────────────
        comp.clear();
        for (auto& cs : states) {
            const ExportClip& c = cs->spec;
            if (t < c.start - 1e-9 || t >= c.start + c.length - 1e-9) continue;
            if (cs->videoFailed) continue;
            if (!cs->video) {
                cs->video = std::make_unique<SourceVideo>();
                std::string open;
                if (!cs->video->open(c.path, &open)) {
                    // One unreadable clip should not throw away the render;
                    // it exports as the hole it is, and the log says why.
                    LOG_WARN("export: %s", open.c_str());
                    cs->video.reset();
                    cs->videoFailed = true;
                    continue;
                }
            }
            const double srcTime = c.inPoint + (t - c.start);
            if (const Rgba* pic = cs->video->rgbaAt(srcTime))
                comp.draw(*pic, c, cs->scaler);
        }

        if (!writer.writeVideo(comp.canvas(), n, &err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            break;
        }

        // ── sound ──────────────────────────────────────────────────────────
        //
        // The samples this frame covers, counted from the start of the render
        // so rounding never loses or repeats one at a frame boundary.
        if (writer.hasAudio()) {
            const int64_t upTo = std::llround((double(n + 1) / s.fps) * rate);
            const int frames = static_cast<int>(std::max<int64_t>(0, upTo - samplesWritten));
            if (frames > 0) {
                mix.assign(static_cast<size_t>(frames) * channels, 0.0f);
                const double blockStart = s.startTime + double(samplesWritten) / rate;
                const double blockEnd = blockStart + double(frames) / rate;

                for (auto& cs : states) {
                    if (!cs->audio) continue;
                    const ExportClip& c = cs->spec;
                    const double from = std::max(blockStart, c.start);
                    const double to = std::min(blockEnd, c.start + c.length);
                    if (to <= from) continue;

                    const int offset = clampi(
                        static_cast<int>(std::llround((from - blockStart) * rate)), 0, frames);
                    const int count = clampi(
                        static_cast<int>(std::llround((to - from) * rate)), 0, frames - offset);
                    if (count <= 0) continue;

                    if (!cs->audioPrimed) {
                        // First sound this clip contributes: line its file up
                        // with the timeline. After this the reader is pulled
                        // strictly forward, which is what keeps it in sync
                        // without a seek per block.
                        cs->audio->seekTo(c.inPoint + (from - c.start));
                        cs->audioPrimed = true;
                    }
                    cs->audio->mixInto(mix.data() + size_t(offset) * channels, count,
                                       static_cast<float>(c.volume));
                }

                // Several clips summed can leave the range; clamping is what a
                // mixer does, and it beats the wrap a conversion would do.
                for (float& v : mix) v = v < -1.0f ? -1.0f : (v > 1.0f ? 1.0f : v);

                if (!writer.writeAudio(mix.data(), frames, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    break;
                }
                samplesWritten = upTo;
            }
        }

        st.framesDone = n + 1;
        st.progress = double(n + 1) / double(total);
        st.elapsedSec =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        // Polled by the UI at frame rate; a lock per output frame is nothing
        // next to encoding one.
        if ((n & 3) == 0 || n + 1 == total) {
            st.bytesWritten = writer.bytesSoFar();
            setStatus(st);
        }
    }

    const bool aborted = st.state == ExportStatus::State::Failed ||
                         st.state == ExportStatus::State::Cancelled;
    st.stage = aborted ? st.stage : "finishing";
    setStatus(st);

    // Finish the file even when cancelled: a half-written mp4 with no index is
    // not playable, and "I stopped it" should still leave the part that was
    // rendered watchable.
    std::string finishErr;
    if (!writer.finish(&finishErr) && !aborted) {
        st.state = ExportStatus::State::Failed;
        st.error = finishErr;
    }
    st.bytesWritten = writer.bytesSoFar();

    if (st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Done;
        st.stage = "done";
        st.progress = 1.0;
    }
    st.elapsedSec =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();

    // Free the slot *before* publishing the terminal status, not after.
    //
    // Anything watching poll() will act the instant it sees "done", and the
    // obvious thing to do next is start another render — which the export
    // dialog's preview does, chaining a lossless reference into the candidate.
    // With the flag cleared afterwards there is a window, short but perfectly
    // reachable, where the status says finished and the next start is refused
    // with "an export is already running". The RunningFlag guard below still
    // covers every path that leaves without getting here; storing false twice
    // costs nothing.
    job().running.store(false);
    setStatus(st);

    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("export: wrote %s (%lld frames, %.1f s, %.1f MB)", s.path.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
    } else if (st.state == ExportStatus::State::Failed) {
        LOG_ERROR("export failed: %s", st.error.c_str());
    }
}

} // namespace

// ── Public surface ─────────────────────────────────────────────────────────

bool startExport(const ExportSettings& settings, const std::vector<ExportClip>& clips,
                 std::string* error) {
    Job& j = job();
    if (j.running.load()) {
        if (error) *error = "an export is already running";
        return false;
    }
    // The previous thread has set running=false but may not have returned yet.
    if (j.thread.joinable()) j.thread.join();

    ExportSettings s = settings;
    // yuv420p has no half pixels, and an odd canvas is a failure at
    // avcodec_open2 with an unhelpful message. Round rather than refuse.
    s.width = std::max(16, s.width & ~1);
    s.height = std::max(16, s.height & ~1);
    if (s.fps < 1.0 || s.fps > 1000.0) s.fps = 30.0;

    if (s.path.empty()) {
        if (error) *error = "no output file";
        return false;
    }
    if (clips.empty()) {
        if (error) *error = "nothing on the timeline to render";
        return false;
    }
    if (s.endTime <= s.startTime) {
        if (error) *error = "the range to render is empty";
        return false;
    }

    j.cancel.store(false);
    j.running.store(true);
    {
        std::lock_guard<std::mutex> lock(j.mu);
        j.status = ExportStatus{};
        j.status.state = ExportStatus::State::Running;
        j.status.path = s.path;
        j.status.stage = "starting";
        j.status.framesTotal = std::max<int64_t>(1, std::llround((s.endTime - s.startTime) * s.fps));
    }
    j.thread = std::thread(runExport, s, clips);
    return true;
}

ExportStatus exportStatus() {
    Job& j = job();
    std::lock_guard<std::mutex> lock(j.mu);
    return j.status;
}

void cancelExport() { job().cancel.store(true); }

void waitForExport() {
    Job& j = job();
    if (j.thread.joinable()) j.thread.join();
}

// ── Capabilities ───────────────────────────────────────────────────────────
//
// Which encoders are *offered* is a curated list, checked against the build:
// libavcodec has two hundred of them with names like "vc2" and nobody wants to
// pick from that. What each offered encoder can *do* is asked of libavcodec
// and never written down here — the pixel formats it accepts, the presets and
// profiles it names, the range of its quality control. An ffmpeg upgrade that
// gives x265 a new tune gives this app the new tune.

namespace {

/// Walk an AVClass's options without needing an instance of it. av_opt_next
/// wants an object whose first member is the class pointer, and a pointer to
/// the pointer is exactly that.
const AVOption* nextOption(const AVClass* cls, const AVOption* prev) {
    if (!cls) return nullptr;
    return av_opt_next(&cls, prev);
}

const AVOption* findOption(const AVClass* cls, const char* name) {
    for (const AVOption* o = nextOption(cls, nullptr); o; o = nextOption(cls, o))
        if (o->type != AV_OPT_TYPE_CONST && o->name && std::strcmp(o->name, name) == 0)
            return o;
    return nullptr;
}

/// The named values of an enum option: AVOption groups them by sharing the
/// option's `unit` string, which is how `-preset p7` on nvenc turns into an
/// integer.
std::vector<OptionValue> constantsOf(const AVClass* cls, const char* unit) {
    std::vector<OptionValue> out;
    if (!unit) return out;
    for (const AVOption* o = nextOption(cls, nullptr); o; o = nextOption(cls, o)) {
        if (o->type != AV_OPT_TYPE_CONST || !o->unit) continue;
        if (std::strcmp(o->unit, unit) != 0) continue;
        OptionValue v;
        v.name = o->name ? o->name : "";
        v.help = o->help ? o->help : "";
        v.value = o->default_val.i64;
        out.push_back(std::move(v));
    }
    return out;
}

/// The values an option will take, as strings for a menu.
///
/// Enum options answer for themselves. x264 and x265 take their preset, tune
/// and profile as free-form strings handed straight to the library, so there
/// is no list in libavcodec to read — those come from the encoders' own
/// documented vocabularies, which is the one place a hardcoded list is the
/// only truthful option.
std::vector<std::string> valuesFor(const AVCodec* codec, const char* option) {
    std::vector<std::string> out;
    if (!codec || !codec->priv_class) return out;
    const AVOption* o = findOption(codec->priv_class, option);
    if (!o) return out;

    if (o->unit) {
        for (const auto& c : constantsOf(codec->priv_class, o->unit))
            out.push_back(c.name);
        if (!out.empty()) return out;
    }

    const std::string name = codec->name;
    const bool x26x = name == "libx264" || name == "libx265" ||
                      name == "libx264rgb";
    if (x26x && std::strcmp(option, "preset") == 0) {
        return {"ultrafast", "superfast", "veryfast", "faster", "fast",
                "medium", "slow", "slower", "veryslow", "placebo"};
    }
    if (std::strcmp(option, "tune") == 0) {
        if (name == "libx264")
            return {"film", "animation", "grain", "stillimage",
                    "fastdecode", "zerolatency"};
        if (name == "libx265")
            return {"psnr", "ssim", "grain", "zerolatency", "fastdecode", "animation"};
    }
    return out;
}

/// What -profile will take, named the way the encoder wants to hear it.
///
/// Most encoders make `profile` a private enum and so answer for themselves —
/// nvenc, AMF, ProRes. x264 and x265 take a bare string handed to the library,
/// so those two come from their own documented vocabularies.
///
/// There is deliberately no fallback to codec->profiles here. Those are
/// display names ("Profile 0"), not option strings, and the obvious way to
/// turn one into the other — matching its numeric id against the generic
/// `profile` option's constants — is wrong: profile ids are numbered per
/// codec and collide across them. VP9's profile 2 and HEVC's Main 10 are both
/// 2, and that fallback confidently offered "main10" as a VP9 profile. An
/// encoder whose accepted strings cannot be established offers no profile
/// control, and the raw option editor is still there for anyone who knows what
/// their encoder wants.
void profilesOf(const AVCodec* codec, CodecOption& out) {
    if (!codec) return;

    const auto priv = valuesFor(codec, "profile");
    if (!priv.empty()) {
        out.profiles = priv;
        out.profileLabels = priv;
        return;
    }

    const std::string name = codec->name;
    if (name == "libx264") {
        out.profiles = {"baseline", "main", "high", "high10", "high422", "high444"};
    } else if (name == "libx265") {
        out.profiles = {"main", "main10", "main12", "main422-10", "main444-8", "main444-10"};
    }
    out.profileLabels = out.profiles;
}

/// The extensions whose muxer will accept this codec. Asked rather than
/// assumed: VP9 in an mp4 is legal and plays nowhere, AAC in a WebM is not
/// legal at all, and either way the complaint arrives at write_header — long
/// after the menu offered it.
const char* const kContainerExts[] = {"mp4", "mkv", "mov", "webm"};

std::vector<std::string> containersFor(const AVCodec* codec) {
    std::vector<std::string> out;
    for (const char* ext : kContainerExts) {
        const std::string probe = std::string("x.") + ext;
        const AVOutputFormat* ofmt = av_guess_format(nullptr, probe.c_str(), nullptr);
        if (!ofmt) continue;
        if (avformat_query_codec(ofmt, codec->id, FF_COMPLIANCE_NORMAL) == 1)
            out.push_back(ext);
    }
    return out;
}

std::string optionDefault(const AVOption* o) {
    if (!o) return "";
    char buf[128] = {0};
    switch (o->type) {
        case AV_OPT_TYPE_FLAGS:
        case AV_OPT_TYPE_INT:
        case AV_OPT_TYPE_INT64:
        case AV_OPT_TYPE_UINT64:
        case AV_OPT_TYPE_BOOL:
            std::snprintf(buf, sizeof(buf), "%lld",
                          static_cast<long long>(o->default_val.i64));
            return buf;
        case AV_OPT_TYPE_DOUBLE:
        case AV_OPT_TYPE_FLOAT:
            std::snprintf(buf, sizeof(buf), "%g", o->default_val.dbl);
            return buf;
        case AV_OPT_TYPE_STRING:
            return o->default_val.str ? o->default_val.str : "";
        case AV_OPT_TYPE_RATIONAL:
            std::snprintf(buf, sizeof(buf), "%d/%d",
                          o->default_val.q.num, o->default_val.q.den);
            return buf;
        default:
            return "";
    }
}

const char* optionTypeName(const AVOption* o) {
    switch (o->type) {
        case AV_OPT_TYPE_FLAGS:         return "flags";
        case AV_OPT_TYPE_INT:
        case AV_OPT_TYPE_INT64:
        case AV_OPT_TYPE_UINT64:        return o->unit ? "enum" : "int";
        case AV_OPT_TYPE_DOUBLE:
        case AV_OPT_TYPE_FLOAT:         return "double";
        case AV_OPT_TYPE_STRING:        return "string";
        case AV_OPT_TYPE_RATIONAL:      return "rational";
        case AV_OPT_TYPE_BINARY:        return "binary";
        case AV_OPT_TYPE_DICT:          return "dict";
        case AV_OPT_TYPE_BOOL:          return "bool";
        case AV_OPT_TYPE_IMAGE_SIZE:    return "size";
        case AV_OPT_TYPE_PIXEL_FMT:     return "pix_fmt";
        case AV_OPT_TYPE_SAMPLE_FMT:    return "sample_fmt";
        case AV_OPT_TYPE_VIDEO_RATE:    return "rate";
        case AV_OPT_TYPE_DURATION:      return "duration";
        case AV_OPT_TYPE_COLOR:         return "color";
        case AV_OPT_TYPE_CHLAYOUT:      return "layout";
        default:                        return "other";
    }
}

/// Fill in everything about one encoder that a form needs to draw itself.
void describeCodec(const AVCodec* codec, CodecOption& o) {
    o.longName = codec->long_name ? codec->long_name : "";
    o.supportsCrf = hasOption(codec, "crf");
    o.supportsQp = hasOption(codec, "qp");
    o.supportsPreset = hasOption(codec, "preset");
    o.supportsTune = hasOption(codec, "tune");
    o.hardware = (codec->capabilities & AV_CODEC_CAP_HARDWARE) != 0;
    o.losslessOption = hasOption(codec, "lossless");

    if (const AVCodecDescriptor* d = avcodec_descriptor_get(codec->id)) {
        o.intraOnly = (d->props & AV_CODEC_PROP_INTRA_ONLY) != 0;
        o.lossless = (d->props & AV_CODEC_PROP_LOSSLESS) != 0;
        // FFV1 and HuffYUV have no lossy mode at all, so there is no quality
        // to offer and a slider would be a lie.
        o.alwaysLossless = o.lossless && !(d->props & AV_CODEC_PROP_LOSSY);
    }

    // The quality scale differs per encoder — x264 stops at 51, VP9 and AV1 at
    // 63 — and a slider that goes to the wrong number silently clamps at the
    // encoder instead.
    if (codec->priv_class) {
        if (const AVOption* crf = findOption(codec->priv_class, "crf")) {
            // Whether the default reads from .dbl or .i64 depends on how the
            // encoder declared the option; reading the wrong arm of the union
            // gives a number that is not merely wrong but NaN.
            const bool real = crf->type == AV_OPT_TYPE_DOUBLE ||
                              crf->type == AV_OPT_TYPE_FLOAT;
            o.crfDefault = real ? crf->default_val.dbl
                                : double(crf->default_val.i64);
            o.crfMin = crf->min;
            o.crfMax = crf->max;
            // -1 as a minimum means "unset", not a quality one better than
            // lossless; the usable scale starts at zero.
            if (o.crfMin < 0.0) o.crfMin = 0.0;
            if (o.crfDefault < o.crfMin) o.crfDefault = o.crfMin + 23.0;
            if (o.crfMax > 255.0 || o.crfMax <= o.crfMin) { o.crfMin = 0; o.crfMax = 51; }
        }
    }

    const void* list = nullptr;
    int n = 0;
    if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0,
                                     &list, &n) >= 0 && list) {
        const auto* fmts = static_cast<const AVPixelFormat*>(list);
        for (int i = 0; i < n; ++i)
            if (const char* nm = av_get_pix_fmt_name(fmts[i])) o.pixelFormats.push_back(nm);
    }

    o.presets = valuesFor(codec, "preset");
    o.tunes = valuesFor(codec, "tune");
    profilesOf(codec, o);
    o.containers = containersFor(codec);
}

} // namespace

std::string tempPath(const std::string& name) {
    std::error_code ec;
    std::filesystem::path dir = std::filesystem::temp_directory_path(ec) / "ffmpeg-bro";
    if (ec) return name;
    std::filesystem::create_directories(dir, ec);
    // Only the last component, and only the safe part of it: this is handed a
    // name the UI made up, and it should not be able to name a file anywhere
    // else on the disk.
    std::string leaf;
    for (char ch : name) {
        if (std::isalnum(static_cast<unsigned char>(ch)) || ch == '-' || ch == '_' || ch == '.')
            leaf.push_back(ch);
    }
    if (leaf.empty() || leaf.front() == '.') leaf = "preview" + leaf;
    return (dir / leaf).string();
}

std::vector<EncoderOption> encoderOptions(const std::string& codecName) {
    std::vector<EncoderOption> out;
    const AVCodec* codec = avcodec_find_encoder_by_name(codecName.c_str());
    if (!codec || !codec->priv_class) return out;

    for (const AVOption* o = nextOption(codec->priv_class, nullptr); o;
         o = nextOption(codec->priv_class, o)) {
        if (o->type == AV_OPT_TYPE_CONST) continue;   // listed under their option
        if (!(o->flags & AV_OPT_FLAG_ENCODING_PARAM)) continue;
        if (o->flags & AV_OPT_FLAG_DEPRECATED) continue;

        EncoderOption e;
        e.name = o->name ? o->name : "";
        e.help = o->help ? o->help : "";
        e.type = optionTypeName(o);
        e.unit = o->unit ? o->unit : "";
        e.min = o->min;
        e.max = o->max;
        e.hasRange = o->max > o->min;
        e.defaultValue = optionDefault(o);
        if (o->unit) e.values = constantsOf(codec->priv_class, o->unit);
        out.push_back(std::move(e));
    }
    return out;
}

std::vector<CodecOption> availableVideoEncoders() {
    struct Candidate { const char* id; const char* label; };
    static const Candidate kCandidates[] = {
        {"libx264",     "H.264 (x264)"},
        {"libx265",     "H.265 / HEVC (x265)"},
        {"libsvtav1",   "AV1 (SVT-AV1)"},
        {"libaom-av1",  "AV1 (libaom)"},
        {"libvpx-vp9",  "VP9"},
        {"prores_ks",   "Apple ProRes"},
        {"mjpeg",       "Motion JPEG"},
        {"mpeg4",       "MPEG-4 Part 2"},
        {"h264_nvenc",  "H.264 (NVIDIA)"},
        {"hevc_nvenc",  "H.265 (NVIDIA)"},
        {"h264_amf",    "H.264 (AMD)"},
        {"h264_qsv",    "H.264 (Intel QSV)"},
        {"hevc_qsv",    "H.265 (Intel QSV)"},
        {"hevc_amf",    "H.265 (AMD)"},
        {"av1_nvenc",   "AV1 (NVIDIA)"},
        {"ffv1",        "FFV1 (lossless)"},
        {"huffyuv",     "HuffYUV (lossless)"},
    };

    std::vector<CodecOption> out;
    for (const auto& c : kCandidates) {
        const AVCodec* codec = avcodec_find_encoder_by_name(c.id);
        if (!codec) continue;
        CodecOption o;
        o.id = c.id;
        o.label = c.label;
        describeCodec(codec, o);
        out.push_back(std::move(o));
    }
    return out;
}

std::vector<CodecOption> availableAudioEncoders() {
    struct Candidate { const char* id; const char* label; };
    static const Candidate kCandidates[] = {
        {"aac",         "AAC"},
        {"libopus",     "Opus"},
        {"libmp3lame",  "MP3"},
        {"libvorbis",   "Vorbis"},
        {"flac",        "FLAC (lossless)"},
        {"pcm_s16le",   "PCM 16-bit (uncompressed)"},
        {"pcm_s24le",   "PCM 24-bit (uncompressed)"},
        {"alac",        "ALAC (lossless)"},
        {"ac3",         "Dolby Digital (AC-3)"},
        {"eac3",        "Dolby Digital Plus (E-AC-3)"},
    };

    std::vector<CodecOption> out;
    for (const auto& c : kCandidates) {
        const AVCodec* codec = avcodec_find_encoder_by_name(c.id);
        if (!codec) continue;
        CodecOption o;
        o.id = c.id;
        o.label = c.label;
        o.longName = codec->long_name ? codec->long_name : "";
        o.containers = containersFor(codec);
        if (const AVCodecDescriptor* d = avcodec_descriptor_get(codec->id))
            o.lossless = (d->props & AV_CODEC_PROP_LOSSLESS) != 0;

        const void* list = nullptr;
        int n = 0;
        if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_SAMPLE_RATE, 0,
                                         &list, &n) >= 0 && list) {
            const int* rates = static_cast<const int*>(list);
            for (int i = 0; i < n; ++i) o.sampleRates.push_back(rates[i]);
        }
        // No advertised list means the encoder takes what it is given; offer
        // the rates anything downstream is likely to want rather than nothing.
        if (o.sampleRates.empty()) o.sampleRates = {44100, 48000, 96000};

        list = nullptr;
        n = 0;
        if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_CHANNEL_LAYOUT, 0,
                                         &list, &n) >= 0 && list) {
            const auto* layouts = static_cast<const AVChannelLayout*>(list);
            for (int i = 0; i < n; ++i) {
                const int ch = layouts[i].nb_channels;
                if (std::find(o.channelCounts.begin(), o.channelCounts.end(), ch) ==
                    o.channelCounts.end()) {
                    o.channelCounts.push_back(ch);
                }
            }
        }
        if (o.channelCounts.empty()) o.channelCounts = {1, 2, 6};
        std::sort(o.channelCounts.begin(), o.channelCounts.end());

        out.push_back(std::move(o));
    }
    return out;
}

std::vector<ContainerOption> availableContainers() {
    struct Candidate {
        const char* ext; const char* label; const char* video; const char* audio;
    };
    static const Candidate kCandidates[] = {
        {"mp4",  "MP4",            "libx264",    "aac"},
        {"mkv",  "Matroska",       "libx264",    "aac"},
        {"mov",  "QuickTime",      "libx264",    "aac"},
        {"webm", "WebM",           "libvpx-vp9", "libopus"},
    };

    const auto video = availableVideoEncoders();
    const auto audio = availableAudioEncoders();

    std::vector<ContainerOption> out;
    for (const auto& c : kCandidates) {
        const std::string probe = std::string("x.") + c.ext;
        const AVOutputFormat* ofmt = av_guess_format(nullptr, probe.c_str(), nullptr);
        if (!ofmt) continue;
        ContainerOption o;
        o.ext = c.ext;
        o.label = c.label;
        o.longName = ofmt->long_name ? ofmt->long_name : "";
        // Fall back to something this build actually has, so a WebM entry on a
        // build without libvpx still writes a file instead of failing at open.
        o.videoCodec = avcodec_find_encoder_by_name(c.video) ? c.video : "";
        o.audioCodec = avcodec_find_encoder_by_name(c.audio) ? c.audio : "";

        // Each codec already worked out which containers will hold it; reading
        // it back from there keeps the two answers from disagreeing.
        for (const auto& v : video)
            if (std::find(v.containers.begin(), v.containers.end(), o.ext) != v.containers.end())
                o.videoCodecs.push_back(v.id);
        for (const auto& a : audio)
            if (std::find(a.containers.begin(), a.containers.end(), o.ext) != a.containers.end())
                o.audioCodecs.push_back(a.id);

        out.push_back(std::move(o));
    }
    return out;
}

} // namespace ffmpegbro
