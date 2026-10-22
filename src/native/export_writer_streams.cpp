// Video, audio, copy, two-pass, and bitstream filter setup for Writer. See export_writer.h.

#include "export_writer.h"

#include "export_copy.h"
#include "ffmpeg_capabilities.h"
#include "ffmpeg_hardware.h"

#include "util/log.h"

extern "C" {
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>

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

/// Apply `-key value` pairs to an AVOption-carrying object.
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

/// Pull one key out of an option bag, leaving the rest.
///
/// For the two options in this file that are **not the encoder's**: `pass` and
/// `passlogfile` are ffmpeg's own, exactly as `-map` and `-shortest` are, and
/// handing either to `av_opt_set` would be an unknown option — which is an
/// error here, and rightly. The ffmpeg command line treats them the same way,
/// which is why they travel in the same bag as `-crf` and are taken out of it
/// here rather than being named fields nobody would find.
bool takeOption(std::vector<ExportOption>& opts, const char* key, std::string* value) {
    for (auto it = opts.begin(); it != opts.end(); ++it) {
        if (it->key != key) continue;
        *value = it->value;
        opts.erase(it);
        return true;
    }
    return false;
}

/// Has the caller said, in its own words, what the encoder should spend?
///
/// **The convenience fields have to stand down when it has**, and this is not
/// the same thing as the option bag being applied last. `crf` is a *private*
/// option and `b` is a generic one, so they do not overwrite each other:
/// setting `crf` from `ExportStream::crf` and then applying `b` from the bag
/// leaves x264 with both, and x264 picks CRF — which is how a render told to
/// hit 200 kbps came out byte for byte identical to the constant-quality one,
/// silently, with the command bar printing `-b:v 200k` the whole time. That is
/// the "succeeded while ignoring what it was told" failure the option bag
/// exists to prevent, arriving through the option bag.
///
/// The names are the ones a rate control is asked for by, across the encoders
/// this build has. Split in two because the two answers differ by one line:
/// a bitrate is the whole instruction and needs nothing added, and a quality
/// still needs `bit_rate` cleared — libvpx reads a bitrate as the target and a
/// zero as "quality only", so `-crf` on top of a default bitrate is a ceiling
/// rather than the thing that was asked for.
bool bagNames(const std::vector<ExportOption>& opts,
              std::initializer_list<const char*> keys) {
    for (const auto& o : opts)
        for (const char* k : keys)
            if (o.key == k) return true;
    return false;
}

bool bagSetsBitrate(const std::vector<ExportOption>& opts) {
    return bagNames(opts, {"b", "rc"});
}

bool bagSetsQuality(const std::vector<ExportOption>& opts) {
    return bagNames(opts, {"crf", "qp", "cq", "q", "qscale", "lossless", "global_quality"});
}

/// The whole of a file, or empty. `stats_in` wants the pass-1 log as one
/// NUL-terminated string, which is exactly what a text read gives.
std::string readWholeFile(const std::string& path) {
    std::ifstream in(std::filesystem::path(path), std::ios::binary);
    if (!in) return {};
    return std::string((std::istreambuf_iterator<char>(in)),
                       std::istreambuf_iterator<char>());
}

/// `-passlogfile x` becomes `x-0.log`, which is what ffmpeg writes and
/// therefore what somebody who ran the printed command already has on disk.
/// The number is the video stream's ordinal, so two video streams in one file
/// keep two sets of statistics.
std::string passLogName(const std::string& prefix, int videoOrdinal) {
    const std::string base = prefix.empty() ? std::string("ffmpeg2pass") : prefix;
    return base + "-" + std::to_string(videoOrdinal) + ".log";
}

/// "tt"/"bb"/"progressive" as libavcodec's field order, or UNKNOWN for "say
/// nothing". Two names because ffmpeg takes both spellings.
AVFieldOrder fieldOrderNamed(const std::string& s) {
    if (s == "tt" || s == "tff" || s == "top") return AV_FIELD_TT;
    if (s == "bb" || s == "bff" || s == "bottom") return AV_FIELD_BB;
    if (s == "tb") return AV_FIELD_TB;
    if (s == "bt") return AV_FIELD_BT;
    if (s == "progressive") return AV_FIELD_PROGRESSIVE;
    return AV_FIELD_UNKNOWN;
}

int threadTypeNamed(const std::string& s, bool* ok) {
    *ok = true;
    int out = 0;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && (s[i] == '+' || s[i] == ',' || s[i] == ' ')) ++i;
        const size_t start = i;
        while (i < s.size() && s[i] != '+' && s[i] != ',' && s[i] != ' ') ++i;
        if (i == start) break;
        const std::string name = s.substr(start, i - start);
        if (name == "frame") out |= FF_THREAD_FRAME;
        else if (name == "slice") out |= FF_THREAD_SLICE;
        else { *ok = false; return 0; }
    }
    return out;
}

} // namespace

bool Writer::openVideoStream(Out& o, std::string* err) {
    // `composite` is the canvas, `pad:<label>` is one of the graph's other
    // outputs, and `copy:0:1` was taken by the branch above. Anything else is a
    // caller naming a source that does not exist. There is no empty case to
    // allow for: `outputStreams()` resolves every default before anything gets
    // here, which is what it exists to do.
    //
    // Whether the label names a pad this graph has is not asked here and cannot
    // be: the writer has never heard of the graph, and the job — which has both
    // — refuses an unknown label by name before this is called.
    const bool padFed = isPadSource(o.desc.source);
    if (o.desc.source != "composite" && !padFed) {
        *err = "a video stream cannot be fed from '" + o.desc.source +
               "' — it is the composite, a graph pad (pad:<label>), or "
               "copy:<input>:<stream>";
        return false;
    }

    const AVCodec* codec = o.desc.codec.empty()
                               ? avcodec_find_encoder(format_->video_codec)
                               : avcodec_find_encoder_by_name(o.desc.codec.c_str());
    if (!codec) {
        *err = "this build has no '" + o.desc.codec + "' encoder";
        return false;
    }

    o.st = avformat_new_stream(oc_, nullptr);
    o.enc = avcodec_alloc_context3(codec);
    if (!o.st || !o.enc) { *err = "out of memory"; return false; }

    // A rational frame rate, not a double: 30000/1001 has to survive into
    // the container as itself or every timestamp downstream drifts.
    const AVRational fps = av_d2q(settings_.fps, 1000000);
    // This stream's own size where it was given one, which for a `pad:` stream
    // the job has already filled in from the sink. Everything below that used
    // to read the settings' two numbers reads these instead — the gop, the
    // fallback bitrate, the colour tags and the scaler — because they are all
    // statements about *this* picture, and a proxy stream half the size of the
    // master crossing the 720-line boundary is a real case of them differing.
    const int outW = o.desc.width > 0 ? o.desc.width : settings_.width;
    const int outH = o.desc.height > 0 ? o.desc.height : settings_.height;
    o.enc->width = outW;
    o.enc->height = outH;
    // **The clock the timestamps are in, which is not always `1/fps`.** A render
    // that keeps its source's own frame times has to express them exactly, and
    // the base they are exact in is the one they arrived on — libavfilter's, for
    // the sink the pictures leave by. Rounded into `1/fps` instead, every one of
    // them would land back on the output grid: the file would be constant rate
    // and say `-fps_mode vfr`, which is worse than refusing. `framerate` stays
    // the render's either way, because it is the *nominal* rate the encoder's
    // rate control plans against and ffmpeg passes the same thing here.
    o.enc->time_base = frameClock_.num > 0 ? frameClock_ : av_inv_q(fps);
    o.enc->framerate = fps;
    o.enc->pix_fmt = pickPixelFormat(codec);

    // **The picture that never comes down.** The composite is arriving in a
    // device pool and this encoder lives on the same kind of device, so it is
    // opened against the pool itself: `pix_fmt` becomes the device's handle
    // format, `sw_pix_fmt` says what the surfaces really hold, and
    // `avcodec_open2` builds its own surfaces out of the frames context rather
    // than allocating any. Nothing after this — no `vframe`, no scaler, no
    // colour conversion — applies to such a stream.
    //
    // The two halves have to *agree*: a CUDA pool and an AMF encoder are both
    // hardware and are not the same hardware, and handing one the other's
    // frames fails inside the encoder with a message about surfaces. Where they
    // do not agree this quietly stays on the ordinary path and the graph brings
    // the picture down, which is slower and correct.
    //
    // Never for a pad-fed stream: the pool is the *composite's*, and a pad is a
    // different picture that this render is going to read as pixels anyway.
    // `open()` refuses the combination outright a few lines further on, with a
    // sentence, rather than letting it come out as a stream encoded from the
    // wrong pad's surfaces.
    if (hwFrames_ && !padFed && isHardwareEncoder(codec)) {
        auto* pool = reinterpret_cast<AVHWFramesContext*>(hwFrames_->data);
        auto* dev = reinterpret_cast<AVHWDeviceContext*>(pool->device_ref->data);
        if (encoderDeviceType(codec) == dev->type) {
            o.enc->pix_fmt = pool->format;
            o.enc->sw_pix_fmt = pool->sw_format;
            o.enc->hw_frames_ctx = av_buffer_ref(hwFrames_);
            if (!o.enc->hw_frames_ctx) { *err = "out of memory"; return false; }
            // **The pool's size, not the render's, and they are not always the
            // same two numbers.** With `sizeFromGraph` off they agree, because
            // `GraphSource::build` refuses a sink that disagrees with the
            // settings. With it on, `build` *takes* the sink's answer through
            // `max(16, n & ~1)` — a floor and a round down to even — so a graph
            // whose last pad is 15 or 21 pixels wide leaves the render at 16 or
            // 20 while the frames in the pool are still 15 or 21. Opening a
            // hardware encoder for a size its surfaces are not is the kind of
            // mismatch that surfaces as corrupt output rather than as an error,
            // so these two lines are load-bearing and are not a restatement of
            // anything. (An earlier comment here said they were, which is how a
            // cleanup sweep comes to delete working code.)
            o.enc->width = pool->width;
            o.enc->height = pool->height;
            o.native = true;
        }
    }

    if (!o.native && !o.desc.pixelFormat.empty()) {
        const AVPixelFormat want = av_get_pix_fmt(o.desc.pixelFormat.c_str());
        if (want == AV_PIX_FMT_NONE) {
            *err = "there is no pixel format called '" + o.desc.pixelFormat + "'";
            return false;
        }
        if (!encoderTakesPixelFormat(codec, want)) {
            *err = std::string(codec->name) + " cannot write " + o.desc.pixelFormat;
            return false;
        }
        o.enc->pix_fmt = want;
    }
    o.enc->gop_size = std::max(1, static_cast<int>(std::lround(settings_.fps * 2)));
    o.enc->thread_count = std::max(0, o.desc.threads);
    if (!o.desc.threadType.empty()) {
        bool ok = false;
        const int mask = threadTypeNamed(o.desc.threadType, &ok);
        if (!ok) {
            *err = "there is no thread type called '" + o.desc.threadType +
                   "' — it is frame, slice, or both";
            return false;
        }
        o.enc->thread_type = mask;
    }

    // Interlaced encoding is two statements that have to agree: the encoder is
    // put into field mode and the stream says which field is first, *and* every
    // frame handed over is marked the same way. Only the first and the file
    // claims to be interlaced without being coded that way; only the second and
    // nothing downstream can read it. `frameFlags` is the second half, applied
    // in writeVideo.
    const AVFieldOrder order = fieldOrderNamed(o.desc.fieldOrder);
    if (order != AV_FIELD_UNKNOWN) o.enc->field_order = order;
    if (order == AV_FIELD_TT || order == AV_FIELD_BB || order == AV_FIELD_TB ||
        order == AV_FIELD_BT) {
        o.enc->flags |= AV_CODEC_FLAG_INTERLACED_DCT | AV_CODEC_FLAG_INTERLACED_ME;
        o.frameFlags = AV_FRAME_FLAG_INTERLACED;
        if (order == AV_FIELD_TT || order == AV_FIELD_TB)
            o.frameFlags |= AV_FRAME_FLAG_TOP_FIELD_FIRST;
    }

    if (!o.keys.parse(o.desc.forceKeyFrames, err)) return false;

    // Tagged to match what the compositor actually produced, so a player
    // does not have to guess and guess differently. "auto" is the guess
    // every player makes — by frame height — which is why it is the
    // default rather than a fixed choice.
    const bool wide = settings_.colorspace == "bt2020";
    const bool hd = settings_.colorspace == "bt709" ||
                    (settings_.colorspace.empty() || settings_.colorspace == "auto"
                         ? outH >= 720 : false);
    if (wide) {
        o.enc->colorspace = AVCOL_SPC_BT2020_NCL;
        o.enc->color_primaries = AVCOL_PRI_BT2020;
        o.enc->color_trc = AVCOL_TRC_BT2020_10;
    } else {
        o.enc->colorspace = hd ? AVCOL_SPC_BT709 : AVCOL_SPC_SMPTE170M;
        o.enc->color_primaries = hd ? AVCOL_PRI_BT709 : AVCOL_PRI_SMPTE170M;
        o.enc->color_trc = hd ? AVCOL_TRC_BT709 : AVCOL_TRC_SMPTE170M;
    }
    // A `yuvj*` pixel format *is* the statement that the picture is full
    // range — that is the whole of what the J means — so telling the encoder
    // limited range alongside one is a contradiction, and mjpeg is the encoder
    // that refuses it: `avcodec_open2` returns EINVAL and the render fails with
    // "Invalid argument" and no mention of colour. Picking image2 lands on
    // mjpeg by default, so this was reachable in two clicks.
    const AVPixFmtDescriptor* pixDesc = av_pix_fmt_desc_get(o.enc->pix_fmt);
    const bool impliedFull = pixDesc && pixDesc->name &&
                             std::strncmp(pixDesc->name, "yuvj", 4) == 0;
    const bool fullRange = impliedFull || settings_.colorRange == "pc";
    o.enc->color_range = fullRange ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;

    if (bagSetsBitrate(o.desc.options)) {
        // The caller's own words, applied below, are the whole of it.
    } else if (bagSetsQuality(o.desc.options)) {
        o.enc->bit_rate = 0;
    } else if (o.desc.bitrateKbps > 0) {
        o.enc->bit_rate = int64_t(o.desc.bitrateKbps) * 1000;
    } else if (hasOption(codec, "crf")) {
        av_opt_set_int(o.enc->priv_data, "crf", o.desc.crf, 0);
        // libvpx reads a bitrate of 0 as "constant quality"; leaving the
        // default in makes -crf a ceiling instead of the target.
        o.enc->bit_rate = 0;
    } else {
        // No constant-quality control: pick a bitrate from the picture
        // rather than let the encoder's 200 kbps default ruin it.
        const double bpp = 0.07;
        o.enc->bit_rate = static_cast<int64_t>(outW * outH * settings_.fps * bpp);
    }
    if (!o.desc.preset.empty() && hasOption(codec, "preset"))
        av_opt_set(o.enc->priv_data, "preset", o.desc.preset.c_str(), 0);

    if (wantsGlobalHeader()) o.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    // `-pass` and `-passlogfile` come out of the bag before it is applied,
    // because neither is an option of any encoder. See setUpPasses.
    if (!setUpPasses(o, codec, err)) return false;

    // Last, so anything the caller asked for explicitly beats what was
    // worked out above. A UI that offers both a Quality slider and a raw
    // option editor has to have one of them win, and it should be the one
    // where the user typed the name of the thing.
    if (!applyOptions(o.enc, o.desc.options, "video", err)) return false;

    int rc = avcodec_open2(o.enc, codec, nullptr);
    if (rc < 0) {
        *err = std::string("cannot open the ") + codec->name + " encoder: " + avErr(rc);
        return false;
    }
    if (avcodec_parameters_from_context(o.st->codecpar, o.enc) < 0) {
        *err = std::string("cannot describe the ") + codec->name +
               " encoder to the muxer";
        return false;
    }
    o.st->time_base = o.enc->time_base;
    // **Unknown for a variable-rate stream, and that is the honest tag.**
    // Matroska writes `avg_frame_rate` out as a DefaultDuration, so a stream
    // whose frames are not evenly spaced would carry a per-frame duration that
    // is true of none of them; mp4 uses it for nothing. Zero is libavformat's
    // "nobody said", which is what a player then works out from the timestamps
    // themselves.
    o.st->avg_frame_rate = frameClock_.num > 0 ? AVRational{0, 1} : fps;
    o.srcTimeBase = o.enc->time_base;

    // After the encoder, because a bitstream filter is configured from what the
    // encoder settled on and may then change it — h264_mp4toannexb rewrites the
    // extradata, hevc_metadata rewrites the VUI — and the muxer has to be told
    // about the far end of the chain rather than the near one.
    if (!openBitstreamFilters(o, err)) return false;

    // A stream fed straight off the card needs neither: the picture it encodes
    // is the one the graph made, and allocating a frame to copy it into is the
    // readback this path exists to avoid.
    if (o.native) return true;

    o.vframe = av_frame_alloc();
    if (!o.vframe) { *err = "out of memory"; return false; }
    o.vframe->format = o.enc->pix_fmt;
    o.vframe->width = o.enc->width;
    o.vframe->height = o.enc->height;
    if (av_frame_get_buffer(o.vframe, 0) < 0) { *err = "out of memory"; return false; }

    // The colour, kept beside the scaler because the scaler is rebuilt whenever
    // a picture of a size it was not expecting arrives and the two statements
    // have to travel together — a context remade without the details converts
    // through libswscale's BT.601 default and the stream goes green in the
    // shadows for the rest of the render.
    o.dstSpace = wide ? SWS_CS_BT2020 : (hd ? SWS_CS_ITU709 : SWS_CS_ITU601);
    o.dstFullRange = fullRange;
    // What size of picture this stream expects to be handed: the canvas for a
    // composite-fed stream, the pad's own for one fed from the graph. It is a
    // starting guess and not a promise — `ensureScaler` remakes the context if
    // what turns up is a different size, which is what makes a stream whose
    // size the caller *named* work as well as one whose size was asked of the
    // sink.
    if (!ensureScaler(o, padFed ? outW : settings_.width, padFed ? outH : settings_.height,
                      err))
        return false;
    return true;
}

/// The conversion from whatever picture arrives into what the encoder takes.
///
/// **swscale does the size and the format in one**, which is what makes a proxy
/// stream and a pad-fed stream the same mechanism as the plain one: the source
/// is an RGBA buffer of some size and the destination is the encoder's format at
/// the encoder's size, and there is nothing else to arrange. Rebuilt only when
/// the incoming size changes, which in a steady render is never —
/// `sws_getCachedContext` hands back the same context for the same parameters,
/// so the check is here to catch the first frame rather than to be paid for on
/// every one.
bool Writer::ensureScaler(Out& o, int srcW, int srcH, std::string* err) {
    if (o.toEncoder && srcW == o.srcW && srcH == o.srcH) return true;
    o.toEncoder = sws_getCachedContext(o.toEncoder, srcW, srcH, AV_PIX_FMT_RGBA,
                                       o.enc->width, o.enc->height, o.enc->pix_fmt,
                                       scalerFlag(settings_.scaler), nullptr, nullptr,
                                       nullptr);
    if (!o.toEncoder) { *err = "cannot build the output colour converter"; return false; }
    setColorspace(o.toEncoder, SWS_CS_ITU709, 1, o.dstSpace, o.dstFullRange ? 1 : 0);
    o.srcW = srcW;
    o.srcH = srcH;
    return true;
}

bool Writer::openAudioStream(Out& o, bool* skipped, std::string* err) {
    // The mix, or one of the graph's other sound pads. Whether the label names
    // a pad this graph has is the job's question, for the reason it is the
    // job's on the picture side: this has never heard of a filter graph.
    if (o.desc.source != "mix" && !isPadSource(o.desc.source)) {
        *err = "an audio stream cannot be fed from '" + o.desc.source +
               "' — it is the mix, a graph pad (pad:<label>), or copy:<input>:<stream>";
        return false;
    }

    const AVCodec* codec = o.desc.codec.empty()
                               ? avcodec_find_encoder(format_->audio_codec)
                               : avcodec_find_encoder_by_name(o.desc.codec.c_str());
    if (!codec) {
        // A container that cannot hold sound, or a name this build lacks:
        // say so, but a silent video is still worth writing.
        LOG_WARN("ffmpeg: no '%s' audio encoder; writing without that stream",
                 o.desc.codec.c_str());
        *skipped = true;
        return true;
    }

    o.st = avformat_new_stream(oc_, nullptr);
    o.enc = avcodec_alloc_context3(codec);
    if (!o.st || !o.enc) { *err = "out of memory"; return false; }

    o.enc->sample_fmt = pickSampleFormat(codec);
    o.enc->sample_rate = pickSampleRate(codec, o.desc.sampleRate);
    o.enc->bit_rate = int64_t(o.desc.bitrateKbps) * 1000;
    av_channel_layout_default(&o.enc->ch_layout, o.desc.channels);
    o.enc->time_base = AVRational{1, o.enc->sample_rate};
    if (wantsGlobalHeader()) o.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    if (!applyOptions(o.enc, o.desc.options, "audio", err)) return false;

    int rc = avcodec_open2(o.enc, codec, nullptr);
    if (rc < 0) {
        *err = std::string("cannot open the ") + codec->name + " encoder: " + avErr(rc);
        return false;
    }
    if (avcodec_parameters_from_context(o.st->codecpar, o.enc) < 0) {
        *err = std::string("cannot describe the ") + codec->name +
               " encoder to the muxer";
        return false;
    }
    o.st->time_base = o.enc->time_base;
    o.srcTimeBase = o.enc->time_base;
    if (!openBitstreamFilters(o, err)) return false;

    // Some encoders take any number of samples; 1024 is a sane block for
    // the ones that do.
    o.frameSize = o.enc->frame_size > 0 ? o.enc->frame_size : 1024;

    // The mixer produces one thing — interleaved float at the render's rate and
    // channel count — and every stream resamples out of it into whatever its
    // own encoder will take. That is why the rate and the layout in hand here
    // are the *settings'* and not this stream's: this stream's are the far end
    // of the conversion, not the near one.
    AVChannelLayout inLayout;
    av_channel_layout_default(&inLayout, settings_.audioChannels);
    rc = swr_alloc_set_opts2(&o.swr, &o.enc->ch_layout, o.enc->sample_fmt,
                             o.enc->sample_rate, &inLayout, AV_SAMPLE_FMT_FLT,
                             settings_.audioSampleRate, 0, nullptr);
    av_channel_layout_uninit(&inLayout);
    if (rc < 0 || !o.swr || swr_init(o.swr) < 0) {
        *err = "cannot build the audio resampler";
        return false;
    }

    o.fifo = av_audio_fifo_alloc(o.enc->sample_fmt, o.enc->ch_layout.nb_channels,
                                 o.frameSize * 8);
    o.aconv = av_frame_alloc();
    o.aframe = av_frame_alloc();
    if (!o.fifo || !o.aconv || !o.aframe) { *err = "out of memory"; return false; }

    o.aconv->format = o.enc->sample_fmt;
    o.aconv->sample_rate = o.enc->sample_rate;
    av_channel_layout_copy(&o.aconv->ch_layout, &o.enc->ch_layout);
    o.aconv->nb_samples = o.frameSize * 4;
    if (av_frame_get_buffer(o.aconv, 0) < 0) { *err = "out of memory"; return false; }

    o.aframe->format = o.enc->sample_fmt;
    o.aframe->sample_rate = o.enc->sample_rate;
    av_channel_layout_copy(&o.aframe->ch_layout, &o.enc->ch_layout);
    o.aframe->nb_samples = o.frameSize;
    if (av_frame_get_buffer(o.aframe, 0) < 0) { *err = "out of memory"; return false; }
    return true;
}

// ── A stream that is not encoded ────────────────────────────────────────────

bool Writer::openCopyStream(Out& o, CopyStreams& copies, std::string* err) {
    const AVStream* src = copies.streamFor(o.descIndex);
    if (!src) { *err = "nothing was opened to copy this stream from"; return false; }

    const AVMediaType want = o.desc.kind == "video" ? AVMEDIA_TYPE_VIDEO
                           : o.desc.kind == "audio" ? AVMEDIA_TYPE_AUDIO
                           : o.desc.kind == "subtitle" ? AVMEDIA_TYPE_SUBTITLE
                           : o.desc.kind == "data" ? AVMEDIA_TYPE_DATA
                                                    : AVMEDIA_TYPE_UNKNOWN;
    if (src->codecpar->codec_type != want) {
        const char* got = av_get_media_type_string(src->codecpar->codec_type);
        *err = "'" + o.desc.source + "' is " + (got ? got : "not a stream this build writes") +
               ", and this row is a " + o.desc.kind + " stream";
        return false;
    }
    // **A copied stream is not encoded, so it has no encoder to configure.**
    // Naming one would be a setting that silently does nothing, which is the
    // failure every option bag in this file is written against.
    if (!o.desc.codec.empty()) {
        *err = "a copied stream carries the bytes that were already there, so '" +
               o.desc.codec + "' would encode nothing — take the codec off it, or feed " +
               "the stream from the composite";
        return false;
    }

    o.copied = true;
    o.st = avformat_new_stream(oc_, nullptr);
    if (!o.st) { *err = "out of memory"; return false; }

    int rc = avcodec_parameters_copy(o.st->codecpar, src->codecpar);
    if (rc < 0) { *err = "cannot describe the copied stream to the muxer"; return false; }
    o.st->codecpar->codec_tag = 0;
    // The fourcc travels only where the output container has a name for it.
    // Carried blindly, an mp4's `avc1` lands in Matroska as a tag it has never
    // heard of and `write_header` refuses the file with a message about invalid
    // data. This is the same test ffmpeg's own stream copy makes, and an
    // explicit `-tag:v` still wins because `describeStream` runs afterwards.
    //
    // **A data stream is the exception, and it is the fourcc that makes it
    // one.** `gpmd`, `tmcd`, `mebx` all decode to the same `bin_data` — the
    // tag is the entire identity of the track, and the muxer's tag tables are
    // video, audio and subtitle, so the test above can only ever answer no for
    // one. Dropped, the track still writes and arrives as an anonymous blob
    // that the reader it was carried for no longer recognises, which is a
    // worse outcome than either carrying it or refusing.
    const bool isData = src->codecpar->codec_type == AVMEDIA_TYPE_DATA;
    if (src->codecpar->codec_tag &&
        (isData || (format_->codec_tag &&
                    av_codec_get_id(format_->codec_tag, src->codecpar->codec_tag) ==
                        src->codecpar->codec_id)))
        o.st->codecpar->codec_tag = src->codecpar->codec_tag;

    o.st->time_base = src->time_base;
    o.st->avg_frame_rate = src->avg_frame_rate;
    o.st->r_frame_rate = src->r_frame_rate;
    o.st->sample_aspect_ratio = src->sample_aspect_ratio;
    // The input's own flags travel with the stream — a commentary track stays a
    // commentary track — and `describeStream` overwrites them when the caller
    // said something, which is the same "explicit wins" rule as everywhere else.
    o.st->disposition = src->disposition;
    o.srcTimeBase = src->time_base;

    // Whether the container will hold it, asked rather than assumed — and the
    // three answers `avformat_query_codec` has are all kept: a muxer that has
    // not been taught to answer returns AVERROR_PATCHWELCOME, and reading that
    // shrug as a refusal is how a picker comes to insist MPEG-TS will not hold
    // H.264. Only an actual no stops the render.
    //
    // **A data stream is not asked, because the question has no honest form.**
    // `avformat_query_codec` answers out of the muxer's own callback where it
    // has one and out of its codec_tag tables otherwise, and those tables are
    // video, audio and subtitle — so `bin_data` comes back a flat no from mp4,
    // mov and MPEG-TS, which are exactly the containers telemetry lives in.
    // The two cases cannot be told apart from out here: `query_codec` left
    // libavformat's public struct, so "the muxer said no" and "nobody asked
    // the muxer" are the same integer.
    //
    // So this does what ffmpeg's own stream copy does and leaves `write_header`
    // as the authority. It is a real one — matroskaenc refuses a data track by
    // name — and the `write_header` failure path in `open()` above names the
    // row, because what reaches it from libav is only `EINVAL`.
    const int holds = isData ? 1
                             : avformat_query_codec(format_, o.st->codecpar->codec_id,
                                                    FF_COMPLIANCE_NORMAL);
    if (holds == 0) {
        const AVCodecDescriptor* d = avcodec_descriptor_get(o.st->codecpar->codec_id);
        *err = std::string("the ") + format_->name + " muxer will not hold " +
               (d && d->name ? d->name : "that codec") +
               ", so this stream cannot be copied into it — encode it, or write " +
               "another container";
        return false;
    }

    // After the parameters, because a bitstream filter is configured from them
    // and may then change them: `h264_mp4toannexb` between an mp4 and MPEG-TS
    // is the whole reason `-bsf` and stream copy belong to each other.
    if (!openBitstreamFilters(o, err)) return false;
    return true;
}

// ── Two passes ─────────────────────────────────────────────────────────────

bool Writer::setUpPasses(Out& o, const AVCodec* codec, std::string* err) {
    std::string passText, logPrefix;
    const bool hasPass = takeOption(o.desc.options, "pass", &passText);
    const bool hasLog = takeOption(o.desc.options, "passlogfile", &logPrefix);
    if (!hasPass) {
        if (hasLog)
            LOG_WARN("export: -passlogfile with no -pass does nothing");
        return true;
    }

    const int which = std::atoi(passText.c_str());
    if (which < 1 || which > 3) {
        *err = "-pass takes 1, 2 or 3 (both), not '" + passText + "'";
        return false;
    }
    if (which & 1) o.enc->flags |= AV_CODEC_FLAG_PASS1;
    if (which & 2) o.enc->flags |= AV_CODEC_FLAG_PASS2;

    // Which video stream this is, so two of them in one file keep two logs —
    // the same numbering ffmpeg uses, so the file a printed command leaves
    // behind is the file this reads.
    int ordinal = 0;
    for (const auto& other : outs_)
        if (other->desc.kind == "video") ++ordinal;
    const std::string log = passLogName(logPrefix, ordinal);

    // **Which mechanism carries the statistics is asked of the encoder, never
    // listed.** x264 keeps its own log and takes the filename as a private
    // `stats` option; everything else uses libavcodec's generic pair —
    // `stats_out` filled per packet in pass one, `stats_in` handed over before
    // `avcodec_open2` in pass two. Asking `hasOption` is the same query the
    // `crf`/`preset` guards above already make, so a build that gains an
    // encoder with its own log gains the right behaviour without an edit.
    if (hasOption(codec, "stats")) {
        // Not if the caller named one: somebody who typed `stats` knows what
        // they meant, and this is the same "explicit wins" rule the option bag
        // is applied under.
        bool already = false;
        for (const auto& kv : o.desc.options) if (kv.key == "stats") already = true;
        if (!already) av_opt_set(o.enc->priv_data, "stats", log.c_str(), 0);
        // The same check as below, and it belongs on both branches: x264 opens
        // its own log and fails with "Generic error in an external library",
        // which says nothing about a missing statistics file and nothing at all
        // about the pass that should have written it.
        if ((which & 2) && !already && readWholeFile(log).empty()) {
            *err = "pass 2 has no statistics to spend: '" + log +
                   "' is missing or empty, so pass 1 either did not run or wrote "
                   "somewhere else";
            return false;
        }
        return true;
    }

    if (which & 2) {
        o.statsIn = readWholeFile(log);
        if (o.statsIn.empty()) {
            *err = "pass 2 has no statistics to spend: '" + log +
                   "' is missing or empty, so pass 1 either did not run or wrote "
                   "somewhere else";
            return false;
        }
        // Owned here and detached before the context is freed, so nothing has
        // to know whether libavcodec would have freed it.
        o.enc->stats_in = o.statsIn.data();
    }
    if (which & 1) {
        o.statsLog = std::fopen(log.c_str(), "wb");
        if (!o.statsLog) {
            *err = "cannot write the pass-1 statistics to '" + log + "'";
            return false;
        }
    }
    return true;
}

// ── Bitstream filters ──────────────────────────────────────────────────────

bool Writer::openBitstreamFilters(Out& o, std::string* err) {
    if (o.desc.bitstreamFilters.empty() || !o.st) return true;
    if (!o.enc && !o.copied) return true;

    AVBSFList* list = av_bsf_list_alloc();
    if (!list) { *err = "out of memory"; return false; }

    for (const auto& want : o.desc.bitstreamFilters) {
        const AVBitStreamFilter* f = av_bsf_get_by_name(want.name.c_str());
        if (!f) {
            av_bsf_list_free(&list);
            *err = "this build has no bitstream filter called '" + want.name + "'";
            return false;
        }
        AVBSFContext* ctx = nullptr;
        int rc = av_bsf_alloc(f, &ctx);
        if (rc < 0) { av_bsf_list_free(&list); *err = "out of memory"; return false; }
        for (const auto& kv : want.options) {
            if (kv.key.empty()) continue;
            rc = av_opt_set(ctx, kv.key.c_str(), kv.value.c_str(), AV_OPT_SEARCH_CHILDREN);
            if (rc < 0) {
                const std::string why =
                    rc == AVERROR_OPTION_NOT_FOUND
                        ? "the " + want.name + " bitstream filter has no option '" +
                              kv.key + "'"
                        : "the " + want.name + " option '" + kv.key +
                              "' will not take '" + kv.value + "': " + avErr(rc);
                av_bsf_free(&ctx);
                av_bsf_list_free(&list);
                *err = why;
                return false;
            }
        }
        rc = av_bsf_list_append(list, ctx);
        if (rc < 0) {
            av_bsf_free(&ctx);
            av_bsf_list_free(&list);
            *err = "cannot build the bitstream filter chain: " + avErr(rc);
            return false;
        }
    }

    // One context for the whole chain: with a single entry this hands back that
    // entry, and with several it hands back libavcodec's own list filter. Either
    // way the rest of this file has one thing to feed.
    int rc = av_bsf_list_finalize(&list, &o.bsf);
    if (rc < 0) { *err = "cannot build the bitstream filter chain: " + avErr(rc); return false; }

    // Where the chain's input is described from: the encoder that will produce
    // the packets, or — for a copy, which has no encoder — the input stream's
    // own parameters, already copied into `codecpar` above.
    rc = o.enc ? avcodec_parameters_from_context(o.bsf->par_in, o.enc)
               : avcodec_parameters_copy(o.bsf->par_in, o.st->codecpar);
    if (rc < 0) { *err = "cannot describe the stream to its bitstream filters"; return false; }
    o.bsf->time_base_in = o.srcTimeBase;
    rc = av_bsf_init(o.bsf);
    if (rc < 0) {
        *err = "the bitstream filter chain will not run on this stream: " + avErr(rc);
        return false;
    }

    // The muxer is told about the *filtered* stream. h264_mp4toannexb changes
    // the extradata out of all recognition and hevc_metadata can change the
    // profile; a header written from the encoder's parameters would describe
    // something that is not in the file.
    rc = avcodec_parameters_copy(o.st->codecpar, o.bsf->par_out);
    if (rc < 0) { *err = "cannot describe the filtered stream to the muxer"; return false; }
    o.st->time_base = o.bsf->time_base_out;

    o.bsfPkt = av_packet_alloc();
    if (!o.bsfPkt) { *err = "out of memory"; return false; }
    return true;
}

} // namespace ffmpegbro
