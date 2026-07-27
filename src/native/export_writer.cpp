// The output file: encoders, and the muxer they feed. See export_writer.h.

#include "export_writer.h"

#include "ffmpeg_capabilities.h"
#include "ffmpeg_sequence.h"

#include "util/log.h"

extern "C" {
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/parseutils.h>
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

// ── Forced keyframes ───────────────────────────────────────────────────────

Writer::KeyFrames::~KeyFrames() { if (expr) av_expr_free(expr); }

bool Writer::KeyFrames::parse(const std::string& text, std::string* err) {
    if (text.empty()) return true;

    if (text.rfind("expr:", 0) == 0) {
        // libavutil's own evaluator, with libavutil's own variable names, so an
        // expression copied out of ffmpeg's documentation means here what it
        // means there. Anything else would be a second expression language
        // spelt like the first.
        static const char* const vars[] = {"n", "n_forced", "prev_forced_n",
                                           "prev_forced_t", "t", nullptr};
        const std::string body = text.substr(5);
        const int rc = av_expr_parse(&expr, body.c_str(), vars, nullptr, nullptr,
                                     nullptr, nullptr, 0, nullptr);
        if (rc < 0) {
            *err = "the forced-keyframe expression '" + body + "' will not parse";
            return false;
        }
        on = true;
        return true;
    }
    if (text.rfind("source", 0) == 0 || text.rfind("chapters", 0) == 0) {
        // Both mean "wherever the *input* has one", and this render has no
        // input packets and no chapters read from one — it composites. Said
        // rather than silently producing an unforced file.
        *err = "-force_key_frames " + text +
               " asks for the input's own keyframes, and this render composites "
               "rather than copying packets — give it times or an expr:";
        return false;
    }

    size_t i = 0;
    while (i <= text.size()) {
        const size_t comma = text.find(',', i);
        const std::string piece =
            text.substr(i, comma == std::string::npos ? std::string::npos : comma - i);
        if (!piece.empty()) {
            // av_parse_time in duration mode, so "90", "1:30" and "0:01:30.5"
            // all mean the same thing they mean on a command line.
            int64_t us = 0;
            if (av_parse_time(&us, piece.c_str(), 1) < 0) {
                *err = "'" + piece + "' is not a time to force a keyframe at";
                return false;
            }
            times.push_back(us / 1000000.0);
        }
        if (comma == std::string::npos) break;
        i = comma + 1;
    }
    std::sort(times.begin(), times.end());
    on = !times.empty();
    return true;
}

bool Writer::KeyFrames::wants(int64_t n, double t) {
    if (!on) return false;

    bool force = false;
    if (expr) {
        double vars[5] = {double(n), nForced, prevForcedN, prevForcedT, t};
        force = av_expr_eval(expr, vars, nullptr) > 0.5;
    } else {
        // The first frame at or past the next asked-for moment, which is what
        // ffmpeg does: a time between two frames lands on the one after it,
        // never on the one before, so a cut point is never inside the GOP that
        // was supposed to start at it. Several moments falling inside one frame
        // are one keyframe rather than one each on the frames that follow.
        if (next < times.size() && t >= times[next] - 1e-9) {
            force = true;
            while (next < times.size() && t >= times[next] - 1e-9) ++next;
        }
    }
    if (force) {
        nForced += 1;
        prevForcedN = double(n);
        prevForcedT = t;
    }
    return force;
}

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
        if (st.forceKeyFrames.empty()) st.forceKeyFrames = s.forceKeyFrames;
        if (st.fieldOrder.empty()) st.fieldOrder = s.fieldOrder;
        if (st.threads < 0) st.threads = s.threads;
        if (st.threadType.empty()) st.threadType = s.threadType;
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
        // Where the picture *is* in the output, which is what
        // `-force_key_frames` is written against: seconds from the start of the
        // file, not from the start of the timeline. Whoever knows the range
        // subtracted its start before the times got here.
        const double t = settings_.fps > 0 ? double(index) / settings_.fps : 0.0;
        o.vframe->pict_type =
            o.keys.wants(index, t) ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
        o.vframe->flags = (o.vframe->flags & ~(AV_FRAME_FLAG_INTERLACED |
                                               AV_FRAME_FLAG_TOP_FIELD_FIRST)) |
                          o.frameFlags;
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
        // A pass-1 log that nothing was written to means this encoder does not
        // use libavcodec's statistics pair and keeps its own file somewhere of
        // its choosing — so `-passlogfile` did not reach it and pass 2 will
        // read an empty log. Said out loud rather than discovered as a pass 2
        // that refuses, because the fix is the encoder's own option and only
        // the name of the encoder points at it.
        if (out->statsLog && !out->statsWritten && out->enc)
            LOG_WARN("export: %s keeps its own two-pass statistics file, so "
                     "-passlogfile did not reach it", out->enc->codec->name);
    }

    if (headerWritten_) {
        int rc = av_write_trailer(oc_);
        if (rc < 0) note(std::string("cannot finish the file: ") + avErr(rc));
    }
    const std::string path = settings_.path;
    // Asked of the muxer while it still exists, because a numbered output does
    // not have to start at one and only image2 knows what it was told.
    int64_t startNumber = 1;
    if (oc_ && oc_->priv_data)
        av_opt_get_int(oc_->priv_data, "start_number", 0, &startNumber);
    close();

    // How big it came out is asked of the files, not of avio_tell.
    // +faststart rewrites the whole file after the trailer goes down, so
    // the position left behind bears no relation to the result — an mp4
    // that is three quarters of a megabyte on disk reported itself as
    // three kilobytes. A render into `out%04d.png` has the opposite problem:
    // there is no file called that, so it reported nothing at all. What is on
    // disk is a run of files, and a run is what is measured.
    bytes_ = sizeOnDisk(path, startNumber);

    if (!failure.empty()) { *err = failure; return false; }
    return true;
}

int64_t Writer::sizeOnDisk(const std::string& path, int64_t startNumber) {
    std::error_code ec;
    if (!hasFramePattern(path)) {
        const auto size = std::filesystem::file_size(std::filesystem::path(path), ec);
        return ec ? 0 : static_cast<int64_t>(size);
    }
    // image2 numbers contiguously from wherever it was told to start, so the
    // first name that is not there is the end of what was written.
    int64_t total = 0;
    std::string err;
    for (int64_t n = startNumber;; ++n) {
        const auto names = frameFilenames(path, n, 1, &err);
        if (names.empty()) break;
        const auto size = std::filesystem::file_size(std::filesystem::path(names[0]), ec);
        if (ec) break;
        total += static_cast<int64_t>(size);
    }
    return total;
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
        if (o.bsf) av_bsf_free(&o.bsf);
        if (o.bsfPkt) av_packet_free(&o.bsfPkt);
        if (o.statsLog) { std::fclose(o.statsLog); o.statsLog = nullptr; }
        // Detached before the context goes, because the buffer is this
        // object's: `stats_in` is documented as caller-allocated and nothing
        // should have to work out whether libavcodec would have freed it.
        if (o.enc) { o.enc->stats_in = nullptr; avcodec_free_context(&o.enc); }
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
        o.enc->bit_rate = static_cast<int64_t>(
            settings_.width * settings_.height * settings_.fps * bpp);
    }
    if (!o.desc.preset.empty() && hasOption(codec, "preset"))
        av_opt_set(o.enc->priv_data, "preset", o.desc.preset.c_str(), 0);

    if (oc_->oformat->flags & AVFMT_GLOBALHEADER)
        o.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

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
    if (avcodec_parameters_from_context(o.st->codecpar, o.enc) < 0) return false;
    o.st->time_base = o.enc->time_base;
    o.st->avg_frame_rate = fps;

    // After the encoder, because a bitstream filter is configured from what the
    // encoder settled on and may then change it — h264_mp4toannexb rewrites the
    // extradata, hevc_metadata rewrites the VUI — and the muxer has to be told
    // about the far end of the chain rather than the near one.
    if (!openBitstreamFilters(o, err)) return false;

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
        o.ownStatsFile = true;
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
    if (o.desc.bitstreamFilters.empty() || !o.st || !o.enc) return true;

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

    rc = avcodec_parameters_from_context(o.bsf->par_in, o.enc);
    if (rc < 0) { *err = "cannot describe the stream to its bitstream filters"; return false; }
    o.bsf->time_base_in = o.enc->time_base;
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
        if (rc == AVERROR(EAGAIN)) return true;
        // The encoder has nothing more, ever. Its bitstream filters may still
        // be holding a packet, so the chain gets its end-of-stream here — a
        // filter that buffers would otherwise lose its last packet, which for
        // `dump_extra` is the difference between a file that plays and a file
        // that plays with the last GOP missing.
        if (rc == AVERROR_EOF) {
            if (!o.bsf) return true;
            av_bsf_send_packet(o.bsf, nullptr);
            return drainBsf(o, err);
        }
        if (rc < 0) { *err = std::string("encode failed: ") + avErr(rc); return false; }

        // Pass 1's statistics, appended as the encoder produces them. This is
        // the whole of the handoff to pass 2 for every encoder that does not
        // keep a log of its own.
        if (o.statsLog && o.enc->stats_out) {
            std::fputs(o.enc->stats_out, o.statsLog);
            o.statsWritten = true;
        }

        if (!writePacket(o, pkt_, err)) return false;
    }
}

bool Writer::writePacket(Out& o, AVPacket* pkt, std::string* err) {
    if (!o.bsf) {
        av_packet_rescale_ts(pkt, o.enc->time_base, o.st->time_base);
        pkt->stream_index = o.st->index;
        const int rc = av_interleaved_write_frame(oc_, pkt);
        if (rc < 0) { *err = std::string("cannot write to the file: ") + avErr(rc); return false; }
        return true;
    }

    // Fed in the encoder's time base, which is what `time_base_in` was set to,
    // and what comes out is in `time_base_out` — a `setts` that changes the
    // rate changes that, so the rescale on the far side reads it rather than
    // assuming.
    const int rc = av_bsf_send_packet(o.bsf, pkt);
    if (rc < 0) {
        *err = std::string("the bitstream filter would not take a packet: ") + avErr(rc);
        return false;
    }
    return drainBsf(o, err);
}

bool Writer::drainBsf(Out& o, std::string* err) {
    if (!o.bsf || !o.bsfPkt) return true;
    for (;;) {
        av_packet_unref(o.bsfPkt);
        const int rc = av_bsf_receive_packet(o.bsf, o.bsfPkt);
        if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
        if (rc < 0) {
            *err = std::string("a bitstream filter failed: ") + avErr(rc);
            return false;
        }
        av_packet_rescale_ts(o.bsfPkt, o.bsf->time_base_out, o.st->time_base);
        o.bsfPkt->stream_index = o.st->index;
        const int w = av_interleaved_write_frame(oc_, o.bsfPkt);
        if (w < 0) { *err = std::string("cannot write to the file: ") + avErr(w); return false; }
    }
}

} // namespace ffmpegbro
