// The output file: encoders, and the muxer they feed. See export_writer.h.

#include "export_writer.h"

#include "ffmpeg_capabilities.h"

#include "util/log.h"

extern "C" {
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
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

/// `+default+forced`, `default`, or `0` — as an AV_DISPOSITION_* mask.
///
/// Every name is resolved by `av_disposition_from_string`, which is
/// libavformat's own vocabulary. A table here would be a copy of a list that
/// already exists, and it would be a stale copy the first time ffmpeg gained a
/// disposition — which is the same argument the encoder and filter option
/// tables are built on.
bool dispositionMask(const std::string& text, int* out, std::string* err) {
    *out = 0;
    if (text == "0" || text == "none") return true;

    size_t i = 0;
    while (i < text.size()) {
        while (i < text.size() && (text[i] == '+' || text[i] == ',' || text[i] == ' ')) ++i;
        const size_t start = i;
        while (i < text.size() && text[i] != '+' && text[i] != ',' && text[i] != ' ') ++i;
        if (i == start) break;
        const std::string name = text.substr(start, i - start);
        const int bit = av_disposition_from_string(name.c_str());
        if (bit < 0) {
            *err = "there is no stream disposition called '" + name + "'";
            return false;
        }
        *out |= bit;
    }
    return true;
}

/// A four-character code as libav stores one. Short tags are padded with
/// spaces, which is how every three-letter fourcc in the wild is written.
bool codecTag(const std::string& text, uint32_t* out, std::string* err) {
    if (text.empty() || text.size() > 4) {
        *err = "'" + text + "' is not a codec tag — a tag is one to four characters";
        return false;
    }
    char c[4] = {' ', ' ', ' ', ' '};
    for (size_t i = 0; i < text.size(); ++i) c[i] = text[i];
    *out = MKTAG(c[0], c[1], c[2], c[3]);
    return true;
}

/// What libavcodec calls an embedded file of this name.
///
/// The mapping is ffmpeg's own, from `-attach`: a font is a font stream and
/// everything else is opaque bytes. There is no library call that answers this
/// — cmdutils does it by extension too — so it is three lines rather than a
/// list of formats.
AVCodecID attachmentCodec(const std::string& path) {
    const size_t dot = path.find_last_of('.');
    std::string ext = dot == std::string::npos ? "" : path.substr(dot + 1);
    for (auto& ch : ext) ch = static_cast<char>(::tolower(static_cast<unsigned char>(ch)));
    if (ext == "ttf") return AV_CODEC_ID_TTF;
    if (ext == "otf") return AV_CODEC_ID_OTF;
    return AV_CODEC_ID_BIN_DATA;
}

std::string defaultMimeType(AVCodecID id) {
    if (id == AV_CODEC_ID_TTF) return "font/ttf";
    if (id == AV_CODEC_ID_OTF) return "font/otf";
    return "application/octet-stream";
}

std::string fileName(const std::string& path) {
    const size_t cut = path.find_last_of("/\\");
    return cut == std::string::npos ? path : path.substr(cut + 1);
}

} // namespace

// ── What the file is made of ───────────────────────────────────────────────

std::vector<ExportStream> outputStreams(const ExportSettings& s, bool wantAudio) {
    std::vector<ExportStream> list;

    if (s.streams.empty()) {
        // The render this application wrote before there was a list: the
        // composite through one video encoder, the mix through one audio
        // encoder, in that order, so the muxer numbers them the way it always
        // did and the bytes come out the same.
        ExportStream v;
        v.kind = "video";
        v.source = "composite";
        v.codec = s.videoCodec;
        v.options = s.videoOptions;
        list.push_back(std::move(v));

        ExportStream a;
        a.kind = "audio";
        a.source = "mix";
        a.codec = s.audioCodec;
        a.options = s.audioOptions;
        list.push_back(std::move(a));
    } else {
        list = s.streams;
    }

    std::vector<ExportStream> out;
    out.reserve(list.size());
    for (auto& st : list) {
        // A silent timeline gets no audio stream however many were asked for.
        // The decision is the edit's, not the settings', which is why it is
        // made here with `wantAudio` in hand rather than by whoever built the
        // list without one.
        if (st.kind == "audio" && (!wantAudio || !s.includeAudio)) continue;

        if (st.source.empty())
            st.source = st.kind == "audio" ? "mix"
                      : st.kind == "video" ? "composite" : "";
        if (st.crf < 0) st.crf = s.crf;
        if (st.bitrateKbps <= 0)
            st.bitrateKbps = st.kind == "audio" ? s.audioBitrateKbps : s.videoBitrateKbps;
        if (st.preset.empty()) st.preset = s.preset;
        if (st.pixelFormat.empty()) st.pixelFormat = s.pixelFormat;
        if (st.sampleRate <= 0) st.sampleRate = s.audioSampleRate;
        if (st.channels <= 0) st.channels = s.audioChannels;
        out.push_back(std::move(st));
    }
    return out;
}

// ── Writer ─────────────────────────────────────────────────────────────────

Writer::~Writer() { close(); }

bool Writer::hasAudio() const {
    for (const auto& o : outs_) if (o->desc.kind == "audio") return true;
    return false;
}

bool Writer::open(const ExportSettings& s, bool wantAudio, std::string* err) {
    settings_ = s;

    // `-f`, when the render says which muxer it means. Named rather than left
    // to the extension because that is the only choice that works: a muxer's
    // identity is its name, plenty of them have no extension at all (rtp, tee,
    // every device), and several share one. Empty falls back to guessing from
    // the filename, which is what every render before there was a muxer picker
    // did and what a spec written by hand still expects.
    int rc = avformat_alloc_output_context2(&oc_, nullptr,
                                            s.format.empty() ? nullptr : s.format.c_str(),
                                            s.path.c_str());
    if (rc < 0 || !oc_) {
        *err = s.format.empty()
                   ? "cannot work out what to write '" + s.path + "' as: " + avErr(rc)
                   : "this build has no '" + s.format + "' muxer: " + avErr(rc);
        return false;
    }

    pkt_ = av_packet_alloc();
    if (!pkt_) { *err = "out of memory"; return false; }

    // Streams are created in list order, so the list *is* the muxer's
    // numbering: `-map` order, `-metadata:s:a:1`, and what a player shows in
    // its track menu are all the same order, and there is no second sorting
    // pass anywhere to disagree with it.
    for (const auto& desc : outputStreams(s, wantAudio)) {
        auto out = std::make_unique<Out>();
        out->desc = desc;

        bool skipped = false;
        if (desc.kind == "video") {
            if (!openVideoStream(*out, err)) return false;
        } else if (desc.kind == "audio") {
            if (!openAudioStream(*out, &skipped, err)) return false;
        } else if (desc.kind == "attachment") {
            if (!openAttachment(*out, err)) return false;
        } else {
            *err = "there is no such thing as a '" + desc.kind + "' output stream";
            return false;
        }
        if (skipped) continue;

        if (!describeStream(*out, err)) return false;
        described_.push_back(out->desc);
        outs_.push_back(std::move(out));
    }

    if (outs_.empty()) { *err = "this render would write no streams at all"; return false; }

    if (!(oc_->oformat->flags & AVFMT_NOFILE)) {
        rc = avio_open(&oc_->pb, s.path.c_str(), AVIO_FLAG_WRITE);
        if (rc < 0) { *err = "cannot open '" + s.path + "': " + avErr(rc); return false; }
    }
    if (!s.title.empty())
        av_dict_set(&oc_->metadata, "title", s.title.c_str(), 0);
    for (const auto& m : s.metadata)
        if (!m.key.empty()) av_dict_set(&oc_->metadata, m.key.c_str(), m.value.c_str(), 0);
    if (!addChapters(err)) return false;

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
    for (auto& out : outs_) {
        Out& o = *out;
        if (o.desc.kind != "video") continue;
        if (av_frame_make_writable(o.vframe) < 0) return false;

        const uint8_t* src[4] = {canvas.data.data(), nullptr, nullptr, nullptr};
        const int srcStride[4] = {canvas.stride, 0, 0, 0};
        if (sws_scale(o.toEncoder, src, srcStride, 0, canvas.height,
                      o.vframe->data, o.vframe->linesize) <= 0) {
            *err = "colour conversion failed";
            return false;
        }
        o.vframe->pts = index;
        if (!encode(o, o.vframe, err)) return false;
    }
    return true;
}

bool Writer::writeAudio(const float* interleaved, int frames, std::string* err) {
    if (frames <= 0) return true;

    for (auto& out : outs_) {
        Out& o = *out;
        if (o.desc.kind != "audio") continue;

        const int maxOut = static_cast<int>(av_rescale_rnd(
            swr_get_delay(o.swr, o.enc->sample_rate) + frames,
            o.enc->sample_rate, settings_.audioSampleRate, AV_ROUND_UP));
        if (av_frame_make_writable(o.aconv) < 0) return false;
        if (maxOut > o.aconv->nb_samples) {
            av_frame_unref(o.aconv);
            o.aconv->format = o.enc->sample_fmt;
            o.aconv->sample_rate = o.enc->sample_rate;
            av_channel_layout_copy(&o.aconv->ch_layout, &o.enc->ch_layout);
            o.aconv->nb_samples = maxOut + 64;
            if (av_frame_get_buffer(o.aconv, 0) < 0) return false;
        }

        const auto* in = reinterpret_cast<const uint8_t*>(interleaved);
        const int written = swr_convert(o.swr, o.aconv->extended_data, o.aconv->nb_samples,
                                        &in, frames);
        if (written < 0) { *err = "audio resample failed"; return false; }
        if (written == 0) continue;

        if (av_audio_fifo_write(o.fifo, reinterpret_cast<void* const*>(o.aconv->extended_data),
                                written) < written) {
            *err = "audio buffer full";
            return false;
        }
        if (!drainFifo(o, false, err)) return false;
    }
    return true;
}

bool Writer::finish(std::string* err) {
    if (finished_) return true;
    finished_ = true;

    // **Every step runs, and the trailer goes down whatever happened before
    // it.** Returning at the first failure was the obvious shape and it is the
    // wrong one: a render stopped after a second or two has an audio FIFO
    // holding less than one encoder frame, draining it can fail, and the file
    // was then closed with no moov at all — so "I stopped it" left an mp4 that
    // opens nowhere, losing the whole of what had been rendered to save the
    // last few milliseconds of sound. Whichever step failed is still reported;
    // it just no longer takes the index with it.
    std::string failure;
    auto note = [&failure](const std::string& e) {
        if (failure.empty()) failure = e.empty() ? "the file could not be finished" : e;
    };

    // Audio first, then video, which is the order this did when there was one
    // of each. It matters only in that changing it for no reason would change
    // the interleaving of a file that is otherwise byte for byte what it was.
    std::string step;
    for (auto& out : outs_) {
        if (out->desc.kind != "audio") continue;
        step.clear();
        // Whatever is left is shorter than a full encoder frame; the encoder
        // pads it rather than dropping the last few milliseconds.
        if (!drainFifo(*out, true, &step)) note(step);
        else if (!encode(*out, nullptr, &step)) note(step);
    }
    for (auto& out : outs_) {
        if (out->desc.kind != "video") continue;
        step.clear();
        if (!encode(*out, nullptr, &step)) note(step);
    }

    if (headerWritten_) {
        int rc = av_write_trailer(oc_);
        if (rc < 0) note(std::string("cannot finish the file: ") + avErr(rc));
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

    if (!failure.empty()) { *err = failure; return false; }
    return true;
}

int64_t Writer::bytesSoFar() const {
    if (bytes_) return bytes_;
    return oc_ && oc_->pb ? avio_tell(oc_->pb) : 0;
}

void Writer::close() {
    for (auto& out : outs_) {
        Out& o = *out;
        if (o.toEncoder) { sws_freeContext(o.toEncoder); o.toEncoder = nullptr; }
        if (o.swr) swr_free(&o.swr);
        if (o.fifo) { av_audio_fifo_free(o.fifo); o.fifo = nullptr; }
        if (o.vframe) av_frame_free(&o.vframe);
        if (o.aconv) av_frame_free(&o.aconv);
        if (o.aframe) av_frame_free(&o.aframe);
        if (o.enc) avcodec_free_context(&o.enc);
    }
    outs_.clear();
    if (pkt_) av_packet_free(&pkt_);
    if (oc_) {
        if (oc_->pb && !(oc_->oformat->flags & AVFMT_NOFILE)) avio_closep(&oc_->pb);
        avformat_free_context(oc_);
        oc_ = nullptr;
    }
}

bool Writer::openVideoStream(Out& o, std::string* err) {
    // The only two things a video stream can be fed from today. A stream copy
    // says `copy:0:1` and never reaches an encoder at all, which is the branch
    // this refusal is holding the place of — see ExportStream::source.
    if (o.desc.source != "composite" && !o.desc.source.empty()) {
        *err = "a video stream cannot be fed from '" + o.desc.source +
               "' — this render composites, and stream copy is not here yet";
        return false;
    }

    const AVCodec* codec = o.desc.codec.empty()
                               ? avcodec_find_encoder(oc_->oformat->video_codec)
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
    o.enc->width = settings_.width;
    o.enc->height = settings_.height;
    o.enc->time_base = av_inv_q(fps);
    o.enc->framerate = fps;
    o.enc->pix_fmt = pickPixelFormat(codec);
    if (!o.desc.pixelFormat.empty()) {
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
    o.enc->thread_count = 0;

    // Tagged to match what the compositor actually produced, so a player
    // does not have to guess and guess differently. "auto" is the guess
    // every player makes — by frame height — which is why it is the
    // default rather than a fixed choice.
    const bool wide = settings_.colorspace == "bt2020";
    const bool hd = settings_.colorspace == "bt709" ||
                    (settings_.colorspace.empty() || settings_.colorspace == "auto"
                         ? settings_.height >= 720 : false);
    if (wide) {
        o.enc->colorspace = AVCOL_SPC_BT2020_NCL;
        o.enc->color_primaries = AVCOL_PRI_BT2020;
        o.enc->color_trc = AVCOL_TRC_BT2020_10;
    } else {
        o.enc->colorspace = hd ? AVCOL_SPC_BT709 : AVCOL_SPC_SMPTE170M;
        o.enc->color_primaries = hd ? AVCOL_PRI_BT709 : AVCOL_PRI_SMPTE170M;
        o.enc->color_trc = hd ? AVCOL_TRC_BT709 : AVCOL_TRC_SMPTE170M;
    }
    const bool fullRange = settings_.colorRange == "pc";
    o.enc->color_range = fullRange ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;

    if (o.desc.bitrateKbps > 0) {
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
        o.enc->bit_rate = static_cast<int64_t>(
            settings_.width * settings_.height * settings_.fps * bpp);
    }
    if (!o.desc.preset.empty() && hasOption(codec, "preset"))
        av_opt_set(o.enc->priv_data, "preset", o.desc.preset.c_str(), 0);

    if (oc_->oformat->flags & AVFMT_GLOBALHEADER)
        o.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

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
    if (avcodec_parameters_from_context(o.st->codecpar, o.enc) < 0) return false;
    o.st->time_base = o.enc->time_base;
    o.st->avg_frame_rate = fps;

    o.vframe = av_frame_alloc();
    if (!o.vframe) { *err = "out of memory"; return false; }
    o.vframe->format = o.enc->pix_fmt;
    o.vframe->width = o.enc->width;
    o.vframe->height = o.enc->height;
    if (av_frame_get_buffer(o.vframe, 0) < 0) { *err = "out of memory"; return false; }

    o.toEncoder = sws_getCachedContext(nullptr, settings_.width, settings_.height,
                                       AV_PIX_FMT_RGBA, settings_.width, settings_.height,
                                       o.enc->pix_fmt, scalerFlag(settings_.scaler),
                                       nullptr, nullptr, nullptr);
    if (!o.toEncoder) { *err = "cannot build the output colour converter"; return false; }
    setColorspace(o.toEncoder, SWS_CS_ITU709, 1,
                  wide ? SWS_CS_BT2020 : (hd ? SWS_CS_ITU709 : SWS_CS_ITU601),
                  fullRange ? 1 : 0);
    return true;
}

bool Writer::openAudioStream(Out& o, bool* skipped, std::string* err) {
    if (o.desc.source != "mix" && !o.desc.source.empty()) {
        *err = "an audio stream cannot be fed from '" + o.desc.source +
               "' — this render mixes, and stream copy is not here yet";
        return false;
    }

    const AVCodec* codec = o.desc.codec.empty()
                               ? avcodec_find_encoder(oc_->oformat->audio_codec)
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
    if (oc_->oformat->flags & AVFMT_GLOBALHEADER)
        o.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    if (!applyOptions(o.enc, o.desc.options, "audio", err)) return false;

    int rc = avcodec_open2(o.enc, codec, nullptr);
    if (rc < 0) {
        *err = std::string("cannot open the ") + codec->name + " encoder: " + avErr(rc);
        return false;
    }
    if (avcodec_parameters_from_context(o.st->codecpar, o.enc) < 0) return false;
    o.st->time_base = o.enc->time_base;

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

bool Writer::openAttachment(Out& o, std::string* err) {
    // An attachment is a stream with no packets in it: the muxer writes the
    // whole file out of the stream's extradata when the header goes down. That
    // is exactly what `ffmpeg -attach` produces, and it is why a font
    // travelling with an ASS subtitle is a stream rather than a side file.
    if (o.desc.path.empty()) { *err = "an attachment needs a file to attach"; return false; }

    std::ifstream in(std::filesystem::path(o.desc.path), std::ios::binary);
    if (!in) { *err = "cannot read the attachment '" + o.desc.path + "'"; return false; }
    const std::string blob((std::istreambuf_iterator<char>(in)),
                           std::istreambuf_iterator<char>());
    if (blob.empty()) { *err = "the attachment '" + o.desc.path + "' is empty"; return false; }
    if (blob.size() > size_t(INT32_MAX) - AV_INPUT_BUFFER_PADDING_SIZE) {
        *err = "the attachment '" + o.desc.path + "' is too large to embed";
        return false;
    }

    o.st = avformat_new_stream(oc_, nullptr);
    if (!o.st) { *err = "out of memory"; return false; }

    const AVCodecID id = attachmentCodec(o.desc.path);
    o.st->codecpar->codec_type = AVMEDIA_TYPE_ATTACHMENT;
    o.st->codecpar->codec_id = id;
    o.st->codecpar->extradata = static_cast<uint8_t*>(
        av_mallocz(blob.size() + AV_INPUT_BUFFER_PADDING_SIZE));
    if (!o.st->codecpar->extradata) { *err = "out of memory"; return false; }
    std::memcpy(o.st->codecpar->extradata, blob.data(), blob.size());
    o.st->codecpar->extradata_size = static_cast<int>(blob.size());

    // The two tags a muxer needs to hand the file back with the name it came
    // in under. Set before the caller's own metadata, so naming them
    // explicitly wins.
    av_dict_set(&o.st->metadata, "filename", fileName(o.desc.path).c_str(), 0);
    av_dict_set(&o.st->metadata, "mimetype",
                (o.desc.mimeType.empty() ? defaultMimeType(id) : o.desc.mimeType).c_str(), 0);
    return true;
}

bool Writer::describeStream(Out& o, std::string* err) {
    if (!o.st) return true;

    if (!o.desc.language.empty())
        av_dict_set(&o.st->metadata, "language", o.desc.language.c_str(), 0);
    for (const auto& m : o.desc.metadata)
        if (!m.key.empty()) av_dict_set(&o.st->metadata, m.key.c_str(), m.value.c_str(), 0);

    if (!o.desc.disposition.empty()) {
        int mask = 0;
        if (!dispositionMask(o.desc.disposition, &mask, err)) return false;
        o.st->disposition = mask;
    }
    if (!o.desc.tag.empty()) {
        uint32_t tag = 0;
        if (!codecTag(o.desc.tag, &tag, err)) return false;
        o.st->codecpar->codec_tag = tag;
    }
    return true;
}

bool Writer::addChapters(std::string* err) {
    for (const auto& c : settings_.chapters) {
        auto* ch = static_cast<AVChapter*>(av_mallocz(sizeof(AVChapter)));
        if (!ch) { *err = "out of memory"; return false; }
        ch->id = static_cast<int64_t>(oc_->nb_chapters);
        // Milliseconds: fine enough for a chapter mark, and coarse enough that
        // the number in the file is the number a person typed.
        ch->time_base = AVRational{1, 1000};
        ch->start = std::llround(c.start * 1000.0);
        ch->end = std::llround(c.end * 1000.0);
        if (!c.title.empty()) av_dict_set(&ch->metadata, "title", c.title.c_str(), 0);

        auto** grown = static_cast<AVChapter**>(
            av_realloc_array(oc_->chapters, oc_->nb_chapters + 1, sizeof(*oc_->chapters)));
        if (!grown) {
            av_dict_free(&ch->metadata);
            av_free(ch);
            *err = "out of memory";
            return false;
        }
        oc_->chapters = grown;
        oc_->chapters[oc_->nb_chapters++] = ch;
    }
    return true;
}

bool Writer::drainFifo(Out& o, bool flushTail, std::string* err) {
    while (av_audio_fifo_size(o.fifo) >= o.frameSize ||
           (flushTail && av_audio_fifo_size(o.fifo) > 0)) {
        const int want = std::min(o.frameSize, av_audio_fifo_size(o.fifo));
        if (av_frame_make_writable(o.aframe) < 0) return false;
        if (av_audio_fifo_read(o.fifo, reinterpret_cast<void* const*>(o.aframe->data),
                               want) < want) {
            *err = "audio buffer underrun";
            return false;
        }
        // A short final frame is legal; the encoder pads it itself.
        o.aframe->nb_samples = want;
        o.aframe->pts = o.audioPts;
        o.audioPts += want;
        if (!encode(o, o.aframe, err)) return false;
        o.aframe->nb_samples = o.frameSize;
    }
    return true;
}

bool Writer::encode(Out& o, AVFrame* frame, std::string* err) {
    if (!o.enc) return true;
    int rc = avcodec_send_frame(o.enc, frame);
    if (rc < 0 && rc != AVERROR_EOF) {
        *err = std::string("encode failed: ") + avErr(rc);
        return false;
    }
    for (;;) {
        av_packet_unref(pkt_);
        rc = avcodec_receive_packet(o.enc, pkt_);
        if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
        if (rc < 0) { *err = std::string("encode failed: ") + avErr(rc); return false; }

        av_packet_rescale_ts(pkt_, o.enc->time_base, o.st->time_base);
        pkt_->stream_index = o.st->index;
        rc = av_interleaved_write_frame(oc_, pkt_);
        if (rc < 0) { *err = std::string("cannot write to the file: ") + avErr(rc); return false; }
    }
}

} // namespace ffmpegbro
