// One clip's pictures, and one clip's sound. See export_source.h.

#include "export_source.h"

extern "C" {
#include <libavutil/opt.h>
}

#include <algorithm>
#include <cmath>

namespace ffmpegbro {

SourceVideo::~SourceVideo() { close(); }

bool SourceVideo::open(const MediaInput& in, std::string* err) {
    if (!openInput(&fmt_, in, err)) return false;
    const std::string& path = in.path;

    stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (stream_ < 0) { if (err) *err = path + ": no video track"; return false; }

    AVStream* st = fmt_->streams[stream_];
    rotation_ = rotationOf(st);
    timeBase_ = st->time_base;
    // Where this input's zero is. The container's own start time is part of it
    // and always was; `-ss` and `-itsoffset` are the rest, which is why they
    // are one number here rather than a special case at every point of use.
    startOffset_ = inputEpoch(in, fmt_->start_time != AV_NOPTS_VALUE
                                      ? fmt_->start_time / double(AV_TIME_BASE) : 0.0);
    limit_ = inputLimit(in);
    loop_.configure(fmt_, in);

    // The input's own decoder options go on here — `-skip_frame`,
    // `-skip_loop_filter` and the rest — through the one place that applies
    // them, so a render and playback open the same decoder the same way.
    if (!openDecoder(&dec_, st->codecpar, timeBase_, in, /*threaded=*/true, err))
        return false;

    // Every stream on the file except this one is skipped in the demuxer,
    // so a 1080p sibling track costs nothing to walk past.
    for (unsigned i = 0; i < fmt_->nb_streams; ++i)
        fmt_->streams[i]->discard =
            (static_cast<int>(i) == stream_) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;

    // Whether this reader's pictures come off the device or stay on it. The
    // input decides — see `hwFramesStayUp` — and everything downstream reads it
    // off the frame rather than off a flag, so a reader that downloads is
    // indistinguishable from a software one.
    keepHw_ = hwFramesStayUp(in);

    pkt_ = av_packet_alloc();
    cur_ = av_frame_alloc();
    pending_ = av_frame_alloc();
    swap_ = av_frame_alloc();
    return pkt_ && cur_ && pending_ && swap_;
}

AVBufferRef* SourceVideo::hwFrames() const {
    return dec_ ? dec_->hw_frames_ctx : nullptr;
}

const Rgba* SourceVideo::rgbaAt(double t) {
    // `-t` on an input ends it, so past the window there is no picture — the
    // same answer the end of the file gives, which is what the compositor
    // already knows how to draw (a hole).
    if (limit_ > 0.0 && t >= limit_) return nullptr;
    if (!advanceTo(t)) return nullptr;
    if (haveRgba_ && rgbaPts_ == curPts_) return result_;

    // **`rgbaAt` means pixels**, so a reader told to keep its pictures on the
    // card still brings this one down. The two questions are asked by different
    // callers — the compositor asks this, a filter graph asks `nextRaw` — and
    // an input configured for the graph would otherwise make every clip on the
    // timeline render as a hole. Once per picture and cached like the
    // conversion below it, so a 30 fps render off a 60 fps source downloads
    // each frame once.
    if (cur_->hw_frames_ctx) {
        std::string why;
        if (!downloadFrame(&cur_, &swap_, &why)) return nullptr;
    }

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

const AVFrame* SourceVideo::nextRaw() {
    if (!havePending_ && !decodeOne()) return nullptr;
    // The graph is fed frames, not asked for moments, so the window has to end
    // the feed: a `-t` that only the compositor honoured would mean the two
    // render paths were rendering different inputs.
    if (limit_ > 0.0 && pendingPts_ >= limit_) return nullptr;
    havePending_ = false;
    started_ = true;
    // Every clock this application writes down — a clip's in-point, a graph's
    // `trim` — counts from the first picture, not from whatever the container
    // decided the epoch was. `ptsOf` already takes the start offset off; this
    // puts the answer back in the stream's own units, which is what a buffersrc
    // configured with `timeBase()` will read it as.
    pending_->pts = static_cast<int64_t>(std::llround(pendingPts_ / av_q2d(timeBase_)));
    return pending_;
}

void SourceVideo::close() {
    if (toRgba_) sws_freeContext(toRgba_);
    if (cur_) av_frame_free(&cur_);
    if (pending_) av_frame_free(&pending_);
    if (swap_) av_frame_free(&swap_);
    if (pkt_) av_packet_free(&pkt_);
    if (dec_) avcodec_free_context(&dec_);
    if (fmt_) avformat_close_input(&fmt_);
}

double SourceVideo::ptsOf(const AVFrame* f) const {
    int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE ? f->best_effort_timestamp
                                                            : f->pts;
    if (ts == AV_NOPTS_VALUE) return 0.0;
    return ts * av_q2d(timeBase_) - startOffset_;
}

void SourceVideo::seekTo(double t) {
    // With `-stream_loop` the clock this reader answers on is continuous
    // across the passes and the file's is not, so the loop is asked which pass
    // the target is in and the demuxer is only ever given a moment inside one.
    loop_.seekTo(t, &t);
    const int64_t target = static_cast<int64_t>(
        std::llround(std::max(0.0, t + startOffset_) / av_q2d(timeBase_)));
    av_seek_frame(fmt_, stream_, target, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(dec_);
    haveCur_ = havePending_ = haveRgba_ = false;
    drained_ = eof_ = false;
    started_ = true;
}

bool SourceVideo::advanceTo(double t) {
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

bool SourceVideo::decodeOne() {
    for (;;) {
        av_frame_unref(pending_);
        int rc = avcodec_receive_frame(dec_, pending_);
        if (rc == 0) {
            // The readback. A reader whose input did not ask for
            // `-hwaccel_output_format` hands back pictures in system memory
            // however they were decoded, because that is what the compositor, a
            // software filter and bro's renderer all want.
            //
            // **It is not what makes hardware decode expensive here**, which is
            // worth writing down because everybody assumes it is: measured, the
            // transfer is 3–4% of the wall clock of a CUDA decode, and the
            // decode itself is several times a threaded software one. See
            // tests/hardware_test.cpp and docs/manual/card.md.
            if (!keepHw_ && pending_->hw_frames_ctx) {
                std::string why;
                if (!downloadFrame(&pending_, &swap_, &why)) return false;
            }
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
        rc = loop_.read(fmt_, pkt_);
        if (rc < 0) { eof_ = true; continue; }
        if (pkt_->stream_index != stream_) continue;
        if (avcodec_send_packet(dec_, pkt_) < 0) {
            // A damaged packet is not the end of the clip; the next
            // keyframe picks the picture back up.
            continue;
        }
    }
}

SourceAudio::~SourceAudio() { close(); }

bool SourceAudio::open(const MediaInput& in, int outRate, int outChannels, double speed) {
    outRate_ = outRate;
    outChannels_ = outChannels;
    speed_ = speed > 0.0 ? speed : 1.0;
    // The error is dropped rather than reported, as it always was: a file with
    // no sound in it is not a failed render, and the picture side has already
    // said anything worth saying about a file that cannot be opened at all.
    std::string why;
    if (!openInput(&fmt_, in, &why)) return false;

    stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (stream_ < 0) return false;

    AVStream* st = fmt_->streams[stream_];
    timeBase_ = st->time_base;
    startOffset_ = inputEpoch(in, fmt_->start_time != AV_NOPTS_VALUE
                                      ? fmt_->start_time / double(AV_TIME_BASE) : 0.0);
    limit_ = inputLimit(in);
    loop_.configure(fmt_, in);

    if (!openDecoder(&dec_, st->codecpar, timeBase_, in, /*threaded=*/false, &why))
        return false;

    for (unsigned i = 0; i < fmt_->nb_streams; ++i)
        fmt_->streams[i]->discard =
            (static_cast<int>(i) == stream_) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;

    av_channel_layout_default(&outLayout_, outChannels_);
    pkt_ = av_packet_alloc();
    frame_ = av_frame_alloc();
    return pkt_ && frame_;
}

void SourceAudio::seekTo(double srcSeconds) {
    const double asked = srcSeconds;
    loop_.seekTo(srcSeconds, &srcSeconds);
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
    // once we see where the seek actually landed — and it is measured against
    // the clock this reader answers on, which `InputLoop` keeps continuous
    // across the passes, not against the moment inside one that the demuxer
    // was given.
    seekTarget_ = asked;
    awaitingSeek_ = true;
}

int SourceAudio::mixInto(float* dst, int frames, float gain) {
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
    return done;
}

void SourceAudio::close() {
    if (swr_) swr_free(&swr_);
    if (frame_) av_frame_free(&frame_);
    if (pkt_) av_packet_free(&pkt_);
    if (dec_) avcodec_free_context(&dec_);
    if (fmt_) avformat_close_input(&fmt_);
    av_channel_layout_uninit(&outLayout_);
}

int SourceAudio::available() const {
    return static_cast<int>((fifo_.size() - head_) / outChannels_);
}

void SourceAudio::compact() {
    // Drop the consumed front once it is worth the memmove.
    if (head_ >= 65536) {
        fifo_.erase(fifo_.begin(), fifo_.begin() + static_cast<long>(head_));
        head_ = 0;
    }
}

bool SourceAudio::fill() {
    while (decodeOne()) {
        append();
        av_frame_unref(frame_);
        if (available() > 0) return true;
        // else the whole frame was skipped past; keep going
    }
    return false;
}

const AVFrame* SourceAudio::nextRaw() {
    if (!decodeOne()) return nullptr;
    const int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                           ? frame_->best_effort_timestamp : frame_->pts;
    if (ts != AV_NOPTS_VALUE)
        frame_->pts = ts - static_cast<int64_t>(
                               std::llround(startOffset_ / av_q2d(timeBase_)));
    return frame_;
}

bool SourceAudio::decodeOne() {
    for (;;) {
        int rc = avcodec_receive_frame(dec_, frame_);
        if (rc == 0) {
            // Past `-t` this input has ended, which for a reader is the same
            // thing as the end of the file. Whole frames, because a packet of
            // sound is what a decoder hands over — the last twenty
            // milliseconds of an input window are not worth a second resampler
            // pass to shave.
            if (limit_ > 0.0) {
                const int64_t ts = frame_->best_effort_timestamp != AV_NOPTS_VALUE
                                       ? frame_->best_effort_timestamp : frame_->pts;
                if (ts != AV_NOPTS_VALUE &&
                    ts * av_q2d(timeBase_) - startOffset_ >= limit_) return false;
            }
            return true;
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
        rc = loop_.read(fmt_, pkt_);
        if (rc < 0) { eof_ = true; continue; }
        if (pkt_->stream_index != stream_) continue;
        if (avcodec_send_packet(dec_, pkt_) < 0) continue;
    }
}

void SourceAudio::append() {
    const auto inFmt = static_cast<AVSampleFormat>(frame_->format);
    if (!swr_ || inFmt != swrFmt_ || frame_->sample_rate != swrRate_) {
        if (swr_) swr_free(&swr_);
        // **The clip's speed is the input rate multiplied**, which is the whole of
        // how a speed is performed on this path: telling the resampler the samples
        // arrived faster than they did is `asetrate`, and converting to `outRate_`
        // afterwards is `aresample`. So the pitch moves with the speed, exactly as
        // it does in the chain `ui/graph/derive.js` prints for the same clip. One
        // multiplication and libav does the work — the alternative, a WSOLA
        // time-stretcher written here, would be a second home for `atempo`.
        int rc = swr_alloc_set_opts2(&swr_, &outLayout_, AV_SAMPLE_FMT_FLT, outRate_,
                                     &frame_->ch_layout, inFmt,
                                     inRate(frame_->sample_rate), 0, nullptr);
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
        //
        // Divided by the speed, because `seekTarget_ - at` is a distance in the
        // *file's* seconds and what is being skipped is *output* samples: at 2× a
        // second of overshoot is half a second of the mix. Without the term a
        // sped-up clip's in-point was out by the seek's error times the speed,
        // which is a fraction of a packet and therefore invisible until it is not.
        skip = clampi(static_cast<int>(
                          std::llround((seekTarget_ - at) / speed_ * outRate_)),
                      0, 1 << 24);
    }

    const int64_t delay = swr_get_delay(swr_, outRate_);
    const int maxOut = static_cast<int>(av_rescale_rnd(
        delay + frame_->nb_samples, outRate_, inRate(frame_->sample_rate), AV_ROUND_UP));
    if (maxOut <= 0) return;

    // Sized past what was asked for — see kSwrSlack in export_frame.h. The
    // count handed to `swr_convert` stays the unpadded one, because the slack
    // is somewhere for the last SIMD store to land and not room for more
    // samples. This buffer was sized exactly for a long time and never fell
    // over, which is the whole hazard: a `std::vector` that has grown
    // geometrically usually has spare capacity behind it, so the overrun lands
    // in slack the allocator happened to leave and the mistake is invisible
    // until the one call where it does not.
    const size_t base = fifo_.size();
    fifo_.resize(base + static_cast<size_t>(maxOut) * outChannels_ + kSwrSlack);
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

} // namespace ffmpegbro
