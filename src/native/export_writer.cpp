// The output file: encoders, and the muxer they feed. See export_writer.h.

#include "export_writer.h"

#include "export_copy.h"
#include "export_subtitle.h"
#include "ffmpeg_capabilities.h"

#include "util/log.h"

extern "C" {
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/parseutils.h>
}

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>

namespace ffmpegbro {
namespace {

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

// Out of the anonymous namespace above because the fetch queue asks the same
// question of a fetch's *source*. See the declaration in the header.
bool isLocalPath(const std::string& url) {
    const size_t colon = url.find(':');
    if (colon == std::string::npos) return true;
    if (colon <= 1) return true;                       // C:\ — a drive, not a scheme
    const std::string scheme = url.substr(0, colon);
    for (char c : scheme)
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '+' && c != '-' && c != '.')
            return true;                               // not a scheme at all
    return scheme == "file";
}

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
        //
        // **A copied audio stream is not the mix and is not covered by this.**
        // Its sound comes out of a demuxer, so a timeline with nothing on it
        // still writes one — which is exactly what "replace the audio" and
        // "extract the soundtrack" are, and dropping it here would have made
        // both of them silently impossible.
        //
        // **Nor is a stream fed from a graph pad**, and it is the same kind of
        // claim: this exception is *correctness*, not thrift. `wantAudio` is
        // "the mix has something feeding it", and a `pad:` stream's sound is
        // made inside libavfilter out of whatever that chain reads — a `sine`,
        // a second file, the same clips through an `amix` this render is not
        // the mix of. Dropped here, a graph that produces two soundtracks and
        // maps neither to the mix would write a file with no sound in it and
        // say nothing. (The thrift guard is `Writer::hasAudio()`, which counts
        // only the mix-fed streams so that nothing decodes a clip's sound for
        // a stream that will never ask for a sample.)
        if (st.kind == "audio" && !isCopySource(st.source) && !isPadSource(st.source) &&
            (!wantAudio || !s.includeAudio))
            continue;

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
    // Only the streams the *mixer* feeds. A copied soundtrack has an encoder
    // nowhere in it, and a render that started mixing for one would be decoding
    // every clip's audio to hand it to nothing.
    for (const auto& o : outs_) if (o->desc.kind == "audio" && !o->copied) return true;
    return false;
}

// ── every destination the muxer opens ──────────────────────────────────────

/// Should the parameter sets be in the stream's `extradata` rather than in the
/// packets?
///
/// `AVFMT_GLOBALHEADER` is the muxer saying its file format keeps them up
/// front, and for a hundred and seventy-five muxers that is the whole answer.
/// The other five do not write the file they were named with at all: `tee`
/// hands its packets to several muxers, `segment`, `hls` and `dash` hand them
/// to a new one every few seconds, and `rtp` describes them in an SDP. None of
/// them can answer for the format that eventually receives the packets, and
/// **the flag they carry instead is `AVFMT_NOFILE`** — which is exactly the
/// question "do you write what you were named?".
///
/// So the answer for those is the safe one: have the extradata. A muxer that
/// wants the parameter sets in-band gets them from its own automatic bitstream
/// filter, which is what an mpegts slave of a `tee` does; a muxer that wants
/// them up front has nowhere else to look, and matroska behind a `tee` fails
/// at `write_header` with "Invalid data found when processing input" and no
/// mention of extradata anywhere in it.
bool Writer::wantsGlobalHeader() const {
    return format_ && (format_->flags & (AVFMT_GLOBALHEADER | AVFMT_NOFILE)) != 0;
}

bool Writer::open(const ExportSettings& s, bool wantAudio, std::string* err,
                  CopyStreams* copies, SubtitleStreams* subs, AVBufferRef* hwFrames,
                  AVRational frameClock) {
    settings_ = s;
    hwFrames_ = hwFrames;
    frameClock_ = frameClock.num > 0 && frameClock.den > 0 ? frameClock : AVRational{0, 1};

    // `-f`, when the render says which muxer it means. Named rather than left
    // to the extension because that is the only choice that works: a muxer's
    // identity is its name, plenty of them have no extension at all (rtp, tee,
    // every device), and several share one. Empty falls back to guessing from
    // the filename, which is what every render before there was a muxer picker
    // did and what a spec written by hand still expects.
    wrapped_ = s.fifo.on;
    int rc = avformat_alloc_output_context2(
        &oc_, nullptr,
        wrapped_ ? "fifo" : (s.format.empty() ? nullptr : s.format.c_str()),
        s.path.c_str());
    if (rc < 0 || !oc_) {
        *err = s.format.empty()
                   ? "cannot work out what to write '" + s.path + "' as: " + avErr(rc)
                   : "this build has no '" + s.format + "' muxer: " + avErr(rc);
        return false;
    }

    // **Which muxer decides what the file is.** Without a wrapping the two are
    // the same object; with one, `oc_->oformat` is `fifo` and this is what is
    // actually being written — see `Writer::format_`. `av_guess_format` is
    // exactly what `fifo_init` itself calls to work the same thing out, so the
    // two cannot disagree about what an empty `-f` and a filename mean.
    format_ = wrapped_ ? av_guess_format(s.format.empty() ? nullptr : s.format.c_str(),
                                         s.path.c_str(), nullptr)
                       : oc_->oformat;
    if (!format_) {
        *err = s.format.empty()
                   ? "cannot work out what to write '" + s.path + "' as"
                   : "this build has no '" + s.format + "' muxer";
        return false;
    }
    if (wrapped_ && !applyFifo(s, err)) return false;

    // Everything libavformat opens goes through this pair, from now until the
    // context is freed. Installed here rather than at the first write because
    // an AVFMT_NOFILE muxer opens its first file inside `avformat_write_header`
    // — `hls` writes a segment and a playlist before the header call returns —
    // and a hook installed afterwards would have missed them.
    oc_->opaque = this;
    oc_->io_open = &Writer::ioOpen;
    oc_->io_close2 = &Writer::ioClose;

    pkt_ = av_packet_alloc();
    if (!pkt_) { *err = "out of memory"; return false; }

    // **One bag, split in two, because there are two objects behind it.**
    //
    // The Sources stage puts a demuxer's options and a protocol's in one bag
    // because that is what libavformat does at the reading end: whatever the
    // demuxer does not recognise goes down to the AVIO layer. Writing cannot
    // work that way, because the order is reversed — `avio_open2` happens
    // *before* `avformat_write_header`, and an AVFMT_NOFILE muxer opens its
    // files later still, from inside libavformat. So the split is made here,
    // once, by asking the format context which keys it has: `av_opt_find` with
    // AV_OPT_SEARCH_CHILDREN reaches libavformat's generic table and the
    // muxer's own private one, and what it does not know is the protocol's.
    //
    // **The question is put to `format_` and not to `oc_`**, which are the same
    // object unless there is a `fifo` in front. `movflags` is not an option of
    // the fifo muxer and is very much an option of the render, so asking the
    // context would send every one of the real muxer's own options down to the
    // protocol and refuse the render naming the first of them.
    AVFormatContext* asker = oc_;
    AVFormatContext* probe = nullptr;
    if (wrapped_) {
        if (avformat_alloc_output_context2(&probe, format_, nullptr, s.path.c_str()) < 0 ||
            !probe) {
            *err = std::string("cannot ask the ") + format_->name + " muxer what it takes";
            return false;
        }
        asker = probe;
    }
    for (const auto& o : s.formatOptions) {
        if (o.key.empty()) continue;
        const bool muxers = av_opt_find(asker, o.key.c_str(), nullptr, 0,
                                        AV_OPT_SEARCH_CHILDREN) != nullptr;
        if (!muxers) av_dict_set(&protocolOpts_, o.key.c_str(), o.value.c_str(), 0);
    }
    if (probe) avformat_free_context(probe);

    // Streams are created in list order, so the list *is* the muxer's
    // numbering: `-map` order, `-metadata:s:a:1`, and what a player shows in
    // its track menu are all the same order, and there is no second sorting
    // pass anywhere to disagree with it.
    const std::vector<ExportStream> resolved = outputStreams(s, wantAudio);
    for (size_t i = 0; i < resolved.size(); ++i) {
        const ExportStream& desc = resolved[i];
        auto out = std::make_unique<Out>();
        out->desc = desc;
        out->descIndex = i;

        bool skipped = false;
        if (isCopySource(desc.source)) {
            // The packet path. It reaches no encoder, so nothing below this
            // branch — the pixel format, the rate control, the colour tags —
            // applies to it: what goes in the file is what was already in the
            // input.
            if (!copies) {
                *err = "this render has a copied stream and nothing opened to copy from";
                return false;
            }
            if (!openCopyStream(*out, *copies, err)) return false;
        } else if (desc.kind == "video") {
            if (!openVideoStream(*out, err)) return false;
        } else if (desc.kind == "audio") {
            if (!openAudioStream(*out, &skipped, err)) return false;
        } else if (desc.kind == "attachment") {
            if (!openAttachment(*out, err)) return false;
        } else if (desc.kind == "subtitle") {
            if (!openSubtitleStream(*out, subs, err)) return false;
        } else if (desc.kind == "data") {
            // Reachable only past the copy branch above, so this is a data
            // stream nothing feeds. There is no encoder to open for one and no
            // canvas it could be made from: a data stream is packets whose
            // meaning belongs to whatever reads them, and the only honest thing
            // this can do with one is carry it.
            *err = "a data stream is packets nothing here can make — feed it from an "
                   "input with copy:<input>:<stream>, or take the row off the list";
            return false;
        } else {
            *err = "there is no such thing as a '" + desc.kind + "' output stream";
            return false;
        }
        if (skipped) continue;

        if (!describeStream(*out, err)) return false;
        outs_.push_back(std::move(out));
    }

    if (outs_.empty()) { *err = "this render would write no streams at all"; return false; }

    // All of them or none. A picture that stays on the card can be handed to
    // every encoder that was opened against the pool it lives in and to no
    // other; a file wanting both would need a download per frame, done quietly
    // on behalf of a render that asked for the opposite. Said here, naming the
    // stream, rather than discovered at the first frame.
    {
        int nativeStreams = 0, softwareStreams = 0;
        std::string oddOne, padOne;
        for (const auto& out : outs_) {
            if (out->desc.kind != "video" || out->copied) continue;
            if (out->native) ++nativeStreams;
            else { ++softwareStreams; if (oddOne.empty()) oddOne = out->desc.codec; }
            if (isPadSource(out->desc.source) && padOne.empty()) padOne = out->desc.source;
        }
        // A pad-fed stream first, because it is the specific answer and the
        // mixture below is the general one. Reading a pad means reading pixels,
        // and this render's pictures are on a card by the render's own request
        // — bringing one down per frame on its behalf is the readback the whole
        // path exists to avoid, done quietly for somebody who asked for the
        // opposite.
        if (nativeStreams && !padOne.empty()) {
            *err = "'" + padOne + "' reads pixels and this render's pictures never come "
                   "down — take the hardware filters off the graph, or drop the pad-fed "
                   "stream";
            return false;
        }
        if (nativeStreams && softwareStreams) {
            *err = "this render keeps its pictures on the card, and '" +
                   (oddOne.empty() ? std::string("one of its video streams") : oddOne) +
                   "' would have to have them brought back down — give every video "
                   "stream a hardware encoder, or take the hardware filters off the graph";
            return false;
        }
        native_ = nativeStreams > 0;
    }

    if (!(oc_->oformat->flags & AVFMT_NOFILE)) {
        // Through the hook rather than around it, so that the one file an
        // ordinary render writes is accounted for exactly as the forty a
        // segmenter writes are — and so that a destination that is a URL gets
        // the protocol's options, which `avio_open` has nowhere to put.
        rc = oc_->io_open(oc_, &oc_->pb, s.path.c_str(), AVIO_FLAG_WRITE, nullptr);
        if (rc < 0) {
            *err = (isLocalPath(s.path) ? "cannot open '" : "cannot reach '") + s.path +
                   "': " + avErr(rc);
            return false;
        }
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
    if (s.faststart && format_->name && std::strstr(format_->name, "mp4"))
        av_dict_set(&opts, "movflags", "+faststart", 0);
    // The muxer's half only. The other half went to `protocolOpts_` at the top
    // and has already been handed to every `avio_open2` this render did; left
    // in here as well it would come back out of `write_header` unconsumed and
    // be reported as an option the muxer does not have, which is true and
    // useless.
    for (const auto& o : s.formatOptions)
        if (!o.key.empty() && !av_dict_get(protocolOpts_, o.key.c_str(), nullptr, 0))
            av_dict_set(&opts, o.key.c_str(), o.value.c_str(), 0);
    if (wrapped_) {
        // Wrapped, those are the *wrapped* muxer's and the context has never
        // heard of them: they travel in fifo's `format_opts`, which is an
        // AV_OPT_TYPE_DICT and takes a dictionary directly. Set as a value and
        // not as a `k=v:k=v` string on purpose — that string has its own
        // escaping rules for `:` and `=`, and a second escaper here would be a
        // second answer to a question `tee`'s argument already asks in the UI.
        if (av_opt_set_dict_val(oc_, "format_opts", opts, AV_OPT_SEARCH_CHILDREN) < 0) {
            *err = "cannot hand the " + std::string(format_->name) +
                   " muxer's options to the fifo in front of it";
            av_dict_free(&opts);
            return false;
        }
        av_dict_free(&opts);
        opts = nullptr;
    }
    rc = avformat_write_header(oc_, &opts);
    // Whatever the muxer did not consume, it did not understand. Saying so
    // beats writing a file that quietly ignored half the request.
    //
    // Wrapped, this bag is empty and the refusal has already happened one step
    // earlier: every key was found on the real muxer's own class by `av_opt_find`
    // above, and a key that was not went to `protocolOpts_` like any other. The
    // *check* on that half moves to `finish()`, because a fifo opens its
    // destination on its own thread and nothing has been tried yet by here.
    if (rc >= 0 && av_dict_count(opts) > 0) {
        const AVDictionaryEntry* e = av_dict_iterate(opts, nullptr);
        *err = std::string("the ") + oc_->oformat->name + " muxer has no option '" +
               e->key + "'";
        av_dict_free(&opts);
        return false;
    }
    av_dict_free(&opts);
    if (rc < 0) {
        *err = std::string("cannot write header: ") + avErr(rc);
        // **The one refusal this can name, because nothing upstream can.**
        // Whether a container holds a data track is not a question libav
        // answers before the fact — see `openCopyStream` — so the muxer saying
        // no arrives here as `EINVAL`, which is the same integer as a dozen
        // other things. A data stream on the list is the one of those with a
        // fix somebody can act on, and matroskaenc's own message ("Only audio,
        // video, and subtitles are supported for Matroska") is in the log
        // beside this rather than in the error a person actually reads.
        for (const auto& out : outs_)
            if (out->desc.kind == "data") {
                *err += " — the " + std::string(format_->name) + " muxer may hold no " +
                        "data stream, which '" + out->desc.source + "' is: mp4, mov and " +
                        "MPEG-TS carry one and Matroska does not";
                break;
            }
        return false;
    }

    // The other half of the bag, checked now that something has actually been
    // opened. A segmenter opens its first file during `write_header`, so by
    // here every destination this render is going to have has been tried at
    // least once and a key nothing took is a key nothing will ever take.
    //
    // **Except behind a fifo, where nothing has been tried yet.**
    // `fifo_write_header` starts a thread and returns; the destination is
    // opened on that thread, which is the whole point — a URL that is not there
    // yet is the first thing to recover from rather than a refusal. So both
    // checks move to `finish()`, which runs after `av_write_trailer` has joined
    // that thread. The option is still an error and still names itself; it is
    // reported at the end of the render instead of before it, which is the
    // honest cost of asking for a destination that is allowed to be absent.
    if (!wrapped_ && !checkProtocolOptions(err)) return false;

    headerWritten_ = true;
    return true;
}

Writer::Out::~Out() {
    if (toEncoder) { sws_freeContext(toEncoder); toEncoder = nullptr; }
    if (swr) swr_free(&swr);
    if (fifo) { av_audio_fifo_free(fifo); fifo = nullptr; }
    if (vframe) av_frame_free(&vframe);
    if (aconv) av_frame_free(&aconv);
    if (aframe) av_frame_free(&aframe);
    if (bsf) av_bsf_free(&bsf);
    if (bsfPkt) av_packet_free(&bsfPkt);
    if (statsLog) { std::fclose(statsLog); statsLog = nullptr; }
    // Detached before the context goes, because the buffer is this object's:
    // `stats_in` is documented as caller-allocated and nothing should have to
    // work out whether libavcodec would have freed it.
    if (enc) { enc->stats_in = nullptr; avcodec_free_context(&enc); }
    // `st` is the muxer's and goes with `oc_`.
}

void Writer::close() {
    outs_.clear();
    if (pkt_) av_packet_free(&pkt_);
    if (oc_) {
        // Closed through the hook, not around it, so the primary output is
        // measured the same way every segment and every `tee` slave is — and
        // so that an mp4 rewritten by +faststart is stat'd after the rewrite
        // rather than remembered from the write position before it.
        if (oc_->pb && !(oc_->oformat->flags & AVFMT_NOFILE)) {
            AVIOContext* pb = oc_->pb;
            oc_->pb = nullptr;
            ioClose(oc_, pb);
        }
        avformat_free_context(oc_);
        oc_ = nullptr;
    }
    live_.clear();
    if (protocolOpts_) av_dict_free(&protocolOpts_);
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

// ── subtitles ──────────────────────────────────────────────────────────────
//
// The third kind of encoded stream, and the one whose apparatus is smallest:
// no scaler, no fifo, no rate control, no frame clock. A subtitle encoder takes
// an `AVSubtitle` and a caller's buffer and hands back a length — the one place
// in libavcodec that still works that way — and everything about *when* a line
// is on screen travels on the packet.
//
// Two things it needs that no other stream does:
//
//   - **The decoder's `subtitle_header`.** An ASS file's styles live there and
//     not in the cues: the fonts, the colours, the margins and the resolution
//     every position is measured against. An `ass`→`ass` pass that opened a
//     fresh encoder keeps every line of dialogue and silently loses how all of
//     it looks, which is the worst shape a conversion can have.
//   - **A frame size.** `mov_text` writes a `tx3g` box positioned inside a
//     rectangle, and with no rectangle it lands where the encoder's defaults
//     put it. The input stream's own size is the right answer where it has one
//     — an mp4's text track carries it — and the render's canvas is the right
//     answer where it does not, because that is the picture the text will be
//     drawn over.

bool Writer::openSubtitleStream(Out& o, SubtitleStreams* subs, std::string* err) {
    if (!isDecodeSource(o.desc.source)) {
        *err = "a subtitle stream is copied from an input (copy:<input>:<stream>) or "
               "decoded out of one (decode:<input>:<stream>) — there is no composed "
               "subtitle track for it to be made of";
        return false;
    }

    // The encoder, or the muxer's own default. `-c:s` unset means "whatever
    // this container writes", which is what the ffmpeg command line means by
    // it, and it is the answer nearly every render wants: Matroska says `ass`,
    // WebM says `webvtt`.
    //
    // **Not every muxer declares one, and mp4 is the one that matters.** Its
    // `subtitle_codec` is `AV_CODEC_ID_NONE` in this build, yet
    // `avformat_query_codec` says it holds `mov_text` — which is to say the
    // container's answer and the container's *declaration* are different facts,
    // and only the first is worth acting on. So the fallback is the same
    // question asked of the registry: the first subtitle encoder this build has
    // that this muxer will actually take. That is the shape `MuxerOption`
    // already uses to pick a video and an audio encoder, and it means nothing
    // here is a list of which container holds what.
    const AVCodec* codec = nullptr;
    if (!o.desc.codec.empty()) {
        codec = avcodec_find_encoder_by_name(o.desc.codec.c_str());
        if (!codec) {
            *err = "this build has no subtitle encoder called '" + o.desc.codec + "'";
            return false;
        }
    } else {
        codec = avcodec_find_encoder(format_->subtitle_codec);
        if (!codec) codec = defaultSubtitleEncoder(format_->name);
        if (!codec) {
            *err = std::string("the ") + format_->name +
                   " muxer will not hold any subtitle codec this build can write";
            return false;
        }
    }
    if (codec->type != AVMEDIA_TYPE_SUBTITLE) {
        *err = "'" + std::string(codec->name) + "' is not a subtitle encoder";
        return false;
    }
    // Asked before anything is opened, because the alternative is being told at
    // `write_header` — after the whole file has been described — that mp4 does
    // not hold `subrip`. Only an actual no stops it: the third answer,
    // AVERROR_PATCHWELCOME, means the muxer was never taught to answer.
    if (avformat_query_codec(format_, codec->id, FF_COMPLIANCE_NORMAL) == 0) {
        // What it *does* hold, asked rather than read off the declaration —
        // "mp4 will not hold subrip, it holds no subtitles at all" is what the
        // declaration says and it is false: what mp4 holds is `mov_text`, and
        // naming that is the difference between a refusal and a dead end.
        const AVCodec* instead = defaultSubtitleEncoder(format_->name);
        *err = std::string("the ") + format_->name + " muxer will not hold " +
               codec->name + " subtitles" +
               (instead ? std::string(" — it holds ") + instead->name
                        : std::string(" — it holds no subtitles at all"));
        return false;
    }

    o.st = avformat_new_stream(oc_, nullptr);
    if (!o.st) { *err = "out of memory"; return false; }
    o.enc = avcodec_alloc_context3(codec);
    if (!o.enc) { *err = "out of memory"; return false; }

    // Milliseconds, which is the clock a subtitle is written on everywhere in
    // ffmpeg: the display times inside an AVSubtitle are milliseconds and every
    // text format's own syntax counts in hundredths or thousandths of a second.
    o.enc->time_base = AVRational{1, 1000};

    const AVCodecContext* dec = subs ? subs->decoderFor(o.descIndex) : nullptr;
    if (dec && dec->subtitle_header && dec->subtitle_header_size > 0) {
        o.enc->subtitle_header = static_cast<uint8_t*>(
            av_mallocz(size_t(dec->subtitle_header_size) + 1));
        if (!o.enc->subtitle_header) { *err = "out of memory"; return false; }
        std::memcpy(o.enc->subtitle_header, dec->subtitle_header,
                    size_t(dec->subtitle_header_size));
        o.enc->subtitle_header_size = dec->subtitle_header_size;
    }
    o.enc->width = dec && dec->width > 0 ? dec->width : settings_.width;
    o.enc->height = dec && dec->height > 0 ? dec->height : settings_.height;

    if (wantsGlobalHeader()) o.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (!applyOptions(o.enc, o.desc.options, "subtitle", err)) return false;

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
    // A megabyte, which is what ffmpeg's own muxer allocates for the same call:
    // a cue is a few hundred bytes of text and a bitmap one is bounded by the
    // picture, and `avcodec_encode_subtitle` has no way to ask for more.
    o.subBuf.assign(1 << 20, 0);
    if (!openBitstreamFilters(o, err)) return false;
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

} // namespace ffmpegbro
