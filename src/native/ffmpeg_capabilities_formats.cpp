// Muxer, demuxer, protocol, device, decoder, bitstream-filter, and codec-tag
// capability queries. See ffmpeg_capabilities.h.

#include "ffmpeg_capabilities.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavdevice/avdevice.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
}

#include <algorithm>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace ffmpegbro {

std::vector<OptionInfo> optionsOfClass(const void* rawCls, int require);

// ── The rest of the library, asked the same way ────────────────────────────
//
// Muxers, demuxers, protocols, devices and decoders. Everything below is an
// iteration over one of libav's registries and a walk of an AVClass, which is
// the same two operations the encoder and filter surfaces above are built out
// of. Nothing here is a list of the good ones.

namespace {

/// `avdevice_register_all()`, once, before anything enumerates.
///
/// It has to run before `av_muxer_iterate` and `av_demuxer_iterate` for the
/// devices to be in those lists at all — libavdevice registers gdigrab and
/// dshow *as* formats — so every entry point below calls this first rather
/// than trusting that something else already did.
void ensureDevices() {
    static std::once_flag once;
    std::call_once(once, [] { avdevice_register_all(); });
}

std::vector<std::string> splitCommas(const char* text) {
    std::vector<std::string> out;
    if (!text) return out;
    std::string cur;
    for (const char* p = text; ; ++p) {
        if (*p == ',' || *p == '\0') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
            if (*p == '\0') break;
        } else {
            cur.push_back(*p);
        }
    }
    return out;
}

/// A muxer by the name `-f` would take, falling back to guessing from an
/// extension. Both because this is reached from a UI that used to hold
/// extensions and now holds names, and a stored setting outlives the shape it
/// was stored in.
const AVOutputFormat* muxerNamed(const std::string& name) {
    if (name.empty()) return nullptr;
    ensureDevices();
    if (const AVOutputFormat* f = av_guess_format(name.c_str(), nullptr, nullptr)) return f;
    const std::string probe = "x." + name;
    return av_guess_format(nullptr, probe.c_str(), nullptr);
}

/// Every format libavdevice registered, as pointers, so the two lists above
/// can say which of their entries is a device without a second registry walk
/// per entry.
const std::vector<const void*>& outputDeviceFormats() {
    static const std::vector<const void*> cached = [] {
        ensureDevices();
        std::vector<const void*> out;
        for (const AVOutputFormat* f = av_output_video_device_next(nullptr); f;
             f = av_output_video_device_next(f))
            out.push_back(f);
        for (const AVOutputFormat* f = av_output_audio_device_next(nullptr); f;
             f = av_output_audio_device_next(f))
            out.push_back(f);
        return out;
    }();
    return cached;
}

const std::vector<const void*>& inputDeviceFormats() {
    static const std::vector<const void*> cached = [] {
        ensureDevices();
        std::vector<const void*> out;
        for (const AVInputFormat* f = av_input_video_device_next(nullptr); f;
             f = av_input_video_device_next(f))
            out.push_back(f);
        for (const AVInputFormat* f = av_input_audio_device_next(nullptr); f;
             f = av_input_audio_device_next(f))
            out.push_back(f);
        return out;
    }();
    return cached;
}

bool isKnownDevice(const std::vector<const void*>& set, const void* f) {
    return std::find(set.begin(), set.end(), f) != set.end();
}

const char* codecName(AVCodecID id) {
    if (id == AV_CODEC_ID_NONE) return "";
    const AVCodecDescriptor* d = avcodec_descriptor_get(id);
    return d && d->name ? d->name : "";
}

} // namespace

void registerDevices() { ensureDevices(); }

const AVCodec* defaultSubtitleEncoder(const std::string& muxerName) {
    const AVOutputFormat* ofmt = muxerNamed(muxerName);
    if (!ofmt) return nullptr;
    const AVCodec* fallback = nullptr;
    // **Only an actual no is a no.** `avformat_query_codec` has three answers
    // and the third — `AVERROR_PATCHWELCOME` — means the muxer was never taught
    // to answer, which is not the same as refusing. `Writer::openSubtitleStream`
    // has always read it that way and this read it as a refusal, so the two
    // halves of one question could disagree: the picker would offer nothing for
    // a muxer that shrugs while the writer would happily open it. No muxer
    // reaching here shrugs today, which is why nothing showed it.
    for (const auto& c : availableSubtitleEncoders()) {
        const AVCodec* e = avcodec_find_encoder_by_name(c.id.c_str());
        if (!e || avformat_query_codec(ofmt, e->id, FF_COMPLIANCE_NORMAL) == 0) continue;
        if (c.textSub) return e;
        if (!fallback) fallback = e;
    }
    return fallback;
}

// ── muxers ─────────────────────────────────────────────────────────────────

std::vector<MuxerOption> availableMuxers() {
    static const std::vector<MuxerOption> cached = [] {
        ensureDevices();
        const auto& devices = outputDeviceFormats();
        const auto video = availableVideoEncoders();
        const auto audio = availableAudioEncoders();
        const auto subtitle = availableSubtitleEncoders();

        std::vector<MuxerOption> out;
        void* opaque = nullptr;
        while (const AVOutputFormat* ofmt = av_muxer_iterate(&opaque)) {
            if (!ofmt->name) continue;
            // Two muxers can share a name — "matroska" is both the Matroska
            // muxer and the Matroska Audio one — and `-f matroska` reaches the
            // first, because that is what `av_guess_format` returns. So the
            // second is not merely a duplicate row in a picker, it is a row
            // that cannot be chosen: naming it selects the other. Dropped
            // rather than shown, since offering something unreachable is worse
            // than not offering it.
            if (std::find_if(out.begin(), out.end(), [&](const MuxerOption& e) {
                    return e.name == ofmt->name;
                }) != out.end())
                continue;

            MuxerOption o;
            o.name = ofmt->name;
            o.longName = ofmt->long_name ? ofmt->long_name : "";
            o.label = o.longName.empty() ? o.name : o.longName;
            o.extensions = splitCommas(ofmt->extensions);
            o.ext = o.extensions.empty() ? "" : o.extensions.front();
            o.mimeType = ofmt->mime_type ? ofmt->mime_type : "";
            o.defaultVideo = codecName(ofmt->video_codec);
            o.defaultAudio = codecName(ofmt->audio_codec);
            o.defaultSubtitle = codecName(ofmt->subtitle_codec);
            o.noFile = (ofmt->flags & AVFMT_NOFILE) != 0;
            o.globalHeader = (ofmt->flags & AVFMT_GLOBALHEADER) != 0;
            o.noTimestamps = (ofmt->flags & AVFMT_NOTIMESTAMPS) != 0;
            o.device = isKnownDevice(devices, ofmt);

            // A picture writer: an intra-only video codec by default and no
            // sound at all. image2, gif and the single-frame writers answer
            // yes; that is a fact about the muxer rather than a name anyone
            // recognised.
            if (ofmt->video_codec != AV_CODEC_ID_NONE &&
                ofmt->audio_codec == AV_CODEC_ID_NONE) {
                const AVCodecDescriptor* d = avcodec_descriptor_get(ofmt->video_codec);
                o.stills = d && (d->props & AV_CODEC_PROP_INTRA_ONLY) != 0;
            }

            // **`avformat_query_codec` has three answers, not two**, and over
            // a hundred and eighty muxers the third one matters. Yes and no
            // come from the muxer's `query_codec` or its tag table; a muxer
            // with neither — mpegts is one — returns AVERROR_PATCHWELCOME for
            // everything except the three codecs it names as its defaults,
            // which means *not taught to answer* and not *no*. Reading that as
            // "no" is how a picker comes to insist that MPEG-TS will not hold
            // H.264.
            //
            // So a muxer that does not answer is recorded as not answering and
            // offered everything: ffmpeg would let you try, and the muxer's own
            // refusal at write_header is a better place to be told than a menu
            // that was wrong. Anything drawing this can say which kind of
            // answer it has.
            auto fill = [&](const std::vector<CodecOption>& from,
                            std::vector<std::string>* into) {
                bool answered = true;
                for (const auto& c : from) {
                    const AVCodec* enc = avcodec_find_encoder_by_name(c.id.c_str());
                    if (!enc) continue;
                    const int rc = avformat_query_codec(ofmt, enc->id, FF_COMPLIANCE_NORMAL);
                    if (rc == 1) into->push_back(c.id);
                    else if (rc < 0) answered = false;
                }
                if (!answered) {
                    into->clear();
                    for (const auto& c : from) into->push_back(c.id);
                }
                return answered;
            };
            const bool answeredVideo = fill(video, &o.videoCodecs);
            const bool answeredAudio = fill(audio, &o.audioCodecs);
            // The subtitle list is asked the same question and treated
            // differently in one respect: only a *yes* gets in. `fill` above
            // turns "not taught to answer" into "everything offered", on the
            // grounds that ffmpeg would let you try — which is right for a
            // picture codec in mpegts and wrong here, because a subtitle codec
            // in a container that holds none is a refusal at `write_header`
            // rather than a shrug, and almost every muxer holds none.
            for (const auto& c : subtitle) {
                const AVCodec* enc = avcodec_find_encoder_by_name(c.id.c_str());
                if (enc && avformat_query_codec(ofmt, enc->id, FF_COMPLIANCE_NORMAL) == 1)
                    o.subtitleCodecs.push_back(c.id);
            }
            o.answersCodecs = answeredVideo && answeredAudio;

            // What to default to: the muxer's own choice where this build can
            // encode it and the muxer will take it, and otherwise the first
            // thing on the menu that fits. `webm` asks for VP9 and gets it;
            // `bin` asks for nothing this build can encode, and answering with
            // nothing there is right — it is a container you cannot write, and
            // the UI says so rather than inventing a codec for it.
            auto prefer = [](const std::vector<std::string>& fits, const char* want) {
                if (want && *want) {
                    const AVCodec* enc = avcodec_find_encoder_by_name(want);
                    if (enc && std::find(fits.begin(), fits.end(), want) != fits.end())
                        return std::string(want);
                }
                return fits.empty() ? std::string() : fits.front();
            };
            const AVCodec* dv = avcodec_find_encoder(ofmt->video_codec);
            const AVCodec* da = avcodec_find_encoder(ofmt->audio_codec);
            const AVCodec* ds = avcodec_find_encoder(ofmt->subtitle_codec);
            o.videoCodec = prefer(o.videoCodecs, dv ? dv->name : nullptr);
            o.audioCodec = prefer(o.audioCodecs, da ? da->name : nullptr);
            // The declaration where there is one; otherwise the first codec
            // the muxer *answers* for, preferring text over pictures — see
            // `defaultSubtitleEncoder`, which the writer asks the same
            // question of so the picker and the render cannot disagree.
            if (ds && std::find(o.subtitleCodecs.begin(), o.subtitleCodecs.end(), ds->name) !=
                          o.subtitleCodecs.end()) {
                o.subtitleCodec = ds->name;
            } else if (const AVCodec* pick = defaultSubtitleEncoder(o.name)) {
                o.subtitleCodec = pick->name;
            }

            out.push_back(std::move(o));
        }
        return out;
    }();
    return cached;
}

std::vector<OptionInfo> muxerOptions(const std::string& name) {
    const AVOutputFormat* ofmt = muxerNamed(name);
    if (!ofmt) return {};
    // The muxer's own options first, then the generic AVFormatContext ones
    // that it has not shadowed. Both reach it: avformat_write_header applies
    // its dictionary with AV_OPT_SEARCH_CHILDREN, so `movflags` (movenc's) and
    // `avoid_negative_ts` (libavformat's) travel by the same route and a
    // column showing only one half would be a column that cannot say what the
    // command line can.
    std::vector<OptionInfo> out = optionsOfClass(ofmt->priv_class, AV_OPT_FLAG_ENCODING_PARAM);
    for (auto& o : optionsOfClass(avformat_get_class(), AV_OPT_FLAG_ENCODING_PARAM)) {
        if (std::find_if(out.begin(), out.end(),
                         [&](const OptionInfo& e) { return e.name == o.name; }) != out.end())
            continue;
        out.push_back(std::move(o));
    }
    return out;
}

// ── demuxers ───────────────────────────────────────────────────────────────

std::vector<DemuxerOption> availableDemuxers() {
    static const std::vector<DemuxerOption> cached = [] {
        ensureDevices();
        const auto& devices = inputDeviceFormats();
        std::vector<DemuxerOption> out;
        void* opaque = nullptr;
        while (const AVInputFormat* ifmt = av_demuxer_iterate(&opaque)) {
            if (!ifmt->name) continue;
            DemuxerOption o;
            o.name = ifmt->name;
            o.longName = ifmt->long_name ? ifmt->long_name : "";
            o.extensions = splitCommas(ifmt->extensions);
            o.mimeType = ifmt->mime_type ? ifmt->mime_type : "";
            o.noFile = (ifmt->flags & AVFMT_NOFILE) != 0;
            o.device = isKnownDevice(devices, ifmt);
            out.push_back(std::move(o));
        }
        return out;
    }();
    return cached;
}

std::vector<OptionInfo> demuxerOptions(const std::string& name) {
    ensureDevices();
    const AVInputFormat* ifmt = av_find_input_format(name.c_str());
    if (!ifmt) return {};
    std::vector<OptionInfo> out = optionsOfClass(ifmt->priv_class, AV_OPT_FLAG_DECODING_PARAM);
    for (auto& o : optionsOfClass(avformat_get_class(), AV_OPT_FLAG_DECODING_PARAM)) {
        if (std::find_if(out.begin(), out.end(),
                         [&](const OptionInfo& e) { return e.name == o.name; }) != out.end())
            continue;
        out.push_back(std::move(o));
    }
    return out;
}

// ── protocols ──────────────────────────────────────────────────────────────

ProtocolList availableProtocols() {
    ProtocolList out;
    void* opaque = nullptr;
    while (const char* name = avio_enum_protocols(&opaque, 0)) out.input.push_back(name);
    opaque = nullptr;
    while (const char* name = avio_enum_protocols(&opaque, 1)) out.output.push_back(name);
    return out;
}

std::vector<OptionInfo> protocolOptions(const std::string& name) {
    const AVClass* cls = avio_protocol_get_class(name.c_str());
    // No flag to require: a protocol's options are not split into reading and
    // writing the way a codec's are, and `rw_timeout` applies to both.
    return cls ? optionsOfClass(cls, 0) : std::vector<OptionInfo>{};
}

// ── devices ────────────────────────────────────────────────────────────────

std::vector<DeviceInfo> availableDevices() {
    static const std::vector<DeviceInfo> cached = [] {
        ensureDevices();
        std::vector<DeviceInfo> out;
        auto addIn = [&out](const AVInputFormat* f, const char* kind) {
            if (!f || !f->name) return;
            DeviceInfo d;
            d.name = f->name;
            d.longName = f->long_name ? f->long_name : "";
            d.kind = kind;
            d.direction = "input";
            out.push_back(std::move(d));
        };
        auto addOut = [&out](const AVOutputFormat* f, const char* kind) {
            if (!f || !f->name) return;
            DeviceInfo d;
            d.name = f->name;
            d.longName = f->long_name ? f->long_name : "";
            d.kind = kind;
            d.direction = "output";
            out.push_back(std::move(d));
        };
        for (const AVInputFormat* f = av_input_video_device_next(nullptr); f;
             f = av_input_video_device_next(f)) addIn(f, "video");
        for (const AVInputFormat* f = av_input_audio_device_next(nullptr); f;
             f = av_input_audio_device_next(f)) addIn(f, "audio");
        for (const AVOutputFormat* f = av_output_video_device_next(nullptr); f;
             f = av_output_video_device_next(f)) addOut(f, "video");
        for (const AVOutputFormat* f = av_output_audio_device_next(nullptr); f;
             f = av_output_audio_device_next(f)) addOut(f, "audio");
        return out;
    }();
    return cached;
}

bool isInputDevice(const std::string& name) {
    if (name.empty()) return false;
    // Against the registered input-device formats rather than against a list of
    // names, so a build with more of them (v4l2, avfoundation, x11grab) needs no
    // edit here. `av_find_input_format` first because a demuxer's name is a
    // comma-separated set of alternatives and only the format itself knows
    // which names answer to it.
    const AVInputFormat* ifmt = av_find_input_format(name.c_str());
    if (!ifmt) return false;
    return isKnownDevice(inputDeviceFormats(), ifmt);
}

DeviceSourceList deviceSources(const std::string& name) {
    ensureDevices();
    DeviceSourceList out;
    const AVInputFormat* ifmt = av_find_input_format(name.c_str());
    if (!ifmt) {
        out.error = "there is no input device called '" + name + "' in this build";
        return out;
    }

    AVDeviceInfoList* list = nullptr;
    const int rc = avdevice_list_input_sources(ifmt, nullptr, nullptr, &list);
    if (rc < 0 || !list) {
        // ENOSYS is the ordinary answer from a device with nothing to
        // enumerate — gdigrab takes a rectangle rather than a device name —
        // and reporting it as a reason beats an empty list, which reads as a
        // machine with no cameras in it.
        out.error = rc == AVERROR(ENOSYS)
            ? name + " does not list its sources; it is named directly"
            : name + " could not be asked what it can see (" + std::to_string(rc) + ")";
        if (list) avdevice_free_list_devices(&list);
        return out;
    }

    out.ok = true;
    for (int i = 0; i < list->nb_devices; ++i) {
        const AVDeviceInfo* d = list->devices[i];
        if (!d) continue;
        DeviceSource s;
        s.name = d->device_name ? d->device_name : "";
        s.description = d->device_description ? d->device_description : "";
        for (int k = 0; k < d->nb_media_types; ++k) {
            const char* t = av_get_media_type_string(d->media_types[k]);
            if (t) s.mediaTypes.push_back(t);
        }
        out.sources.push_back(std::move(s));
    }
    avdevice_free_list_devices(&list);
    return out;
}

// ── decoders ───────────────────────────────────────────────────────────────

std::vector<DecoderInfo> availableDecoders() {
    static const std::vector<DecoderInfo> cached = [] {
        std::vector<DecoderInfo> out;
        void* opaque = nullptr;
        while (const AVCodec* c = av_codec_iterate(&opaque)) {
            if (!av_codec_is_decoder(c) || !c->name) continue;
            DecoderInfo d;
            d.name = c->name;
            d.longName = c->long_name ? c->long_name : "";
            d.type = c->type == AVMEDIA_TYPE_VIDEO ? "video"
                   : c->type == AVMEDIA_TYPE_AUDIO ? "audio"
                   : c->type == AVMEDIA_TYPE_SUBTITLE ? "subtitle" : "data";
            d.hardware = (c->capabilities & AV_CODEC_CAP_HARDWARE) != 0;
            d.experimental = (c->capabilities & AV_CODEC_CAP_EXPERIMENTAL) != 0;
            out.push_back(std::move(d));
        }
        return out;
    }();
    return cached;
}

std::vector<OptionInfo> decoderOptions(const std::string& name) {
    const AVCodec* codec = avcodec_find_decoder_by_name(name.c_str());
    if (!codec) return {};
    // The decoder's own options, then the generic AVCodecContext ones it has
    // not shadowed — which is where `skip_frame`, `skip_loop_filter` and
    // `thread_type` live, and those are most of the reason to want this at all.
    std::vector<OptionInfo> out = optionsOfClass(codec->priv_class, AV_OPT_FLAG_DECODING_PARAM);
    for (auto& o : optionsOfClass(avcodec_get_class(), AV_OPT_FLAG_DECODING_PARAM)) {
        if (std::find_if(out.begin(), out.end(),
                         [&](const OptionInfo& e) { return e.name == o.name; }) != out.end())
            continue;
        out.push_back(std::move(o));
    }
    return out;
}

// ── bitstream filters ──────────────────────────────────────────────────────

std::vector<BsfInfo> availableBitstreamFilters() {
    static const std::vector<BsfInfo> cached = [] {
        std::vector<BsfInfo> out;
        void* opaque = nullptr;
        while (const AVBitStreamFilter* f = av_bsf_iterate(&opaque)) {
            if (!f->name) continue;
            BsfInfo b;
            b.name = f->name;
            // A null list is "any codec", which is what `setts` and `noise`
            // declare. Reported as an empty list because that is the same fact
            // said once, and the caller that offers a menu has to know the
            // difference between "these" and "all of them" either way.
            if (f->codec_ids)
                for (const AVCodecID* id = f->codec_ids; *id != AV_CODEC_ID_NONE; ++id)
                    b.codecs.push_back(avcodec_get_name(*id));
            out.push_back(std::move(b));
        }
        return out;
    }();
    return cached;
}

std::vector<OptionInfo> bsfOptions(const std::string& name) {
    const AVBitStreamFilter* f = av_bsf_get_by_name(name.c_str());
    // No `require` flag: a bitstream filter's options carry none of
    // libavutil's direction bits, so asking for one would return nothing at
    // all. The whole table belongs to the filter, which is the case the flag
    // exists to narrow away from and does not apply here.
    return f ? optionsOfClass(f->priv_class, 0) : std::vector<OptionInfo>{};
}

// ── tags and dispositions ──────────────────────────────────────────────────

std::string guessEncoder(const std::string& format, const std::string& path, bool audio) {
    const AVOutputFormat* ofmt = muxerNamed(format);
    if (!ofmt) return "";
    const AVCodecID id = av_guess_codec(ofmt, nullptr, path.c_str(), nullptr,
                                        audio ? AVMEDIA_TYPE_AUDIO : AVMEDIA_TYPE_VIDEO);
    if (id == AV_CODEC_ID_NONE) return "";
    // Named rather than numbered, because everything above this speaks in
    // encoder names — and asked for by id, so a build without that encoder
    // says so instead of offering something that fails at the last step.
    const AVCodec* enc = avcodec_find_encoder(id);
    return enc && enc->name ? enc->name : "";
}

std::vector<std::string> codecTags(const std::string& format,
                                   const std::string& codecName) {
    std::vector<std::string> out;
    const AVOutputFormat* ofmt = muxerNamed(format);
    const AVCodec* codec = avcodec_find_encoder_by_name(codecName.c_str());
    if (!ofmt || !codec || !ofmt->codec_tag) return out;

    auto add = [&out](unsigned int tag) {
        char buf[AV_FOURCC_MAX_STRING_SIZE] = {0};
        av_fourcc_make_string(buf, tag);
        std::string s(buf);
        for (char ch : s)
            if (static_cast<unsigned char>(ch) < 0x21 ||
                static_cast<unsigned char>(ch) > 0x7e) return;
        if (std::find(out.begin(), out.end(), s) == out.end()) out.push_back(std::move(s));
    };

    // What the muxer writes when nobody says otherwise, first, because that is
    // what "auto" comes to and a menu whose first entry is not the current
    // behaviour is a menu that misreports the file.
    unsigned int fallback = 0;
    if (av_codec_get_tag2(ofmt->codec_tag, codec->id, &fallback) && fallback) add(fallback);

    // The alternates worth taking a decision about. Every one is checked back
    // against *this* muxer's tables below, so this is a list of things to ask
    // rather than a list of answers: `hvc1` appears for HEVC in mp4 and mov and
    // is absent from Matroska, without any of that being written down here.
    static const char* kCandidates[] = {
        "hvc1", "hev1", "avc1", "avc3", "av01", "vp09", "mp4v", "jpeg", "mjpa",
        "dvh1", "dvhe", "apch", "apcn", "apcs", "apco", "ap4h", "ap4x", "s263",
    };
    for (const char* c : kCandidates) {
        const unsigned int tag = MKTAG(c[0], c[1], c[2], c[3]);
        if (av_codec_get_id(ofmt->codec_tag, tag) == codec->id) add(tag);
    }
    return out;
}

std::vector<std::string> streamDispositions() {
    std::vector<std::string> out;
    for (int bit = 0; bit < 32; ++bit) {
        const char* name = av_disposition_to_string(1 << bit);
        if (name && *name) out.push_back(name);
    }
    return out;
}

} // namespace ffmpegbro
