// The output file: encoders, and the muxer they feed. See export_writer.h.

#include "export_writer.h"

#include "ffmpeg_capabilities.h"

#include "util/log.h"

extern "C" {
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>

namespace ffmpegbro {
namespace {

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

} // namespace

Writer::~Writer() { close(); }

bool Writer::open(const ExportSettings& s, bool wantAudio, std::string* err) {
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

bool Writer::writeVideo(const Rgba& canvas, int64_t index, std::string* err) {
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

bool Writer::writeAudio(const float* interleaved, int frames, std::string* err) {
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

bool Writer::finish(std::string* err) {
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

int64_t Writer::bytesSoFar() const {
    if (bytes_) return bytes_;
    return oc_ && oc_->pb ? avio_tell(oc_->pb) : 0;
}

void Writer::close() {
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

bool Writer::openVideo(std::string* err) {
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

bool Writer::openAudio(std::string* err) {
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

bool Writer::drainFifo(bool flushTail, std::string* err) {
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

bool Writer::encode(AVCodecContext* ctx, AVStream* st, AVFrame* frame,
                    std::string* err) {
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

} // namespace ffmpegbro
