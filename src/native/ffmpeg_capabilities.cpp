// What this build can actually write, asked of libavcodec. See
// ffmpeg_capabilities.h for why none of it is written down.

#include "ffmpeg_capabilities.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavdevice/avdevice.h>
#include <libavfilter/avfilter.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

#include <algorithm>
#include <cctype>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <string>
#include <vector>

namespace ffmpegbro {

bool hasOption(const AVCodec* codec, const char* name) {
    if (!codec || !codec->priv_class) return false;
    // AV_OPT_SEARCH_FAKE_OBJ means "this is a class pointer, not an instance",
    // which is the documented way to ask what an encoder takes before there is
    // a context to ask about.
    void* fakeObj = const_cast<void*>(static_cast<const void*>(&codec->priv_class));
    return av_opt_find(fakeObj, name, nullptr, 0, AV_OPT_SEARCH_FAKE_OBJ) != nullptr;
}

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

/// Every muxer this build links that will accept this codec, by name.
///
/// This was four extensions in an array — mp4, mkv, mov, webm — which is the
/// one thing in this file that was written down rather than asked, and it made
/// every other muxer in the build unreachable. It is `av_muxer_iterate` now,
/// and the question asked of each is the one that matters: VP9 in an mp4 is
/// legal and plays nowhere, AAC in a WebM is not legal at all, and either way
/// the complaint arrives at write_header — long after the menu offered it.
/// A muxer that never said no. Yes, and *did not say*, are both here — see
/// `MuxerOption::answersCodecs` for why the third answer exists and why reading
/// it as a refusal is the wrong way round. `availableMuxers()` asks the same
/// question the same way, so the two lists cannot come to disagree about
/// whether MPEG-TS will take H.264.
std::vector<std::string> containersFor(const AVCodec* codec) {
    std::vector<std::string> out;
    void* opaque = nullptr;
    while (const AVOutputFormat* ofmt = av_muxer_iterate(&opaque)) {
        if (!ofmt->name) continue;
        if (avformat_query_codec(ofmt, codec->id, FF_COMPLIANCE_NORMAL) != 0)
            out.push_back(ofmt->name);
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
    o.codecName = avcodec_get_name(codec->id);
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

/// One AVClass's whole option table, in the shape a form control needs.
///
/// `require` is the flag that says the option is one this kind of object
/// actually takes — AV_OPT_FLAG_ENCODING_PARAM for an encoder,
/// AV_OPT_FLAG_FILTERING_PARAM for a filter. Without it the walk would offer a
/// decoder-only option on an encoder, which is a control that does nothing.
std::vector<OptionInfo> optionsOfClass(const void* rawCls, int require) {
    const auto* cls = static_cast<const AVClass*>(rawCls);
    std::vector<OptionInfo> out;
    if (!cls) return out;
    for (const AVOption* o = nextOption(cls, nullptr); o; o = nextOption(cls, o)) {
        if (o->type == AV_OPT_TYPE_CONST) continue;   // listed under their option
        if (require && !(o->flags & require)) continue;
        if (o->flags & AV_OPT_FLAG_DEPRECATED) continue;

        OptionInfo e;
        e.name = o->name ? o->name : "";
        e.help = o->help ? o->help : "";
        e.type = optionTypeName(o);
        e.unit = o->unit ? o->unit : "";
        e.min = o->min;
        e.max = o->max;
        e.hasRange = o->max > o->min;
        e.defaultValue = optionDefault(o);
        if (o->unit) e.values = constantsOf(cls, o->unit);
        out.push_back(std::move(e));
    }
    return out;
}

namespace {

/// The pad types of one side of a filter, as one character each. A filter with
/// dynamic pads has none to report: how many there are is decided by the
/// arguments it is given, which is why the flag is reported alongside.
std::string padsOf(const AVFilter* f, int isOutput) {
    std::string out;
    const unsigned n = avfilter_filter_pad_count(f, isOutput);
    for (unsigned i = 0; i < n; ++i) {
        const AVFilterPad* pads = isOutput ? f->outputs : f->inputs;
        out.push_back(avfilter_pad_get_type(pads, static_cast<int>(i)) == AVMEDIA_TYPE_AUDIO
                          ? 'a' : 'v');
    }
    return out;
}

/// What an audio encoder will take, asked of libavcodec. Factored out because
/// the named list and the muxer defaults both need it and a second copy would
/// be a second answer.
void describeAudioCodec(const AVCodec* codec, CodecOption& o) {
    o.longName = codec->long_name ? codec->long_name : "";
    o.codecName = avcodec_get_name(codec->id);
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
}

/// Every codec a muxer names as its own default, as encoders this build has.
///
/// The named lists below are a menu — libavcodec has two hundred encoders with
/// names like `vc2` and nobody picks from that. But a menu of seventeen video
/// encoders is also the reason picking `gif` or `image2` offers nothing that
/// can go in it, and a container with an empty codec list is a container you
/// cannot write. So every muxer's own `video_codec`/`audio_codec` joins the
/// menu: asked of libavformat, one per format, and exactly the set that makes
/// every muxer in the build reachable and no larger.
void addMuxerDefaults(std::vector<CodecOption>& list, AVMediaType type) {
    registerDevices();
    std::vector<const AVCodec*> encoders;
    void* opaque = nullptr;
    while (const AVOutputFormat* ofmt = av_muxer_iterate(&opaque)) {
        const AVCodecID id = type == AVMEDIA_TYPE_VIDEO ? ofmt->video_codec : ofmt->audio_codec;
        if (id == AV_CODEC_ID_NONE) continue;
        const AVCodec* enc = avcodec_find_encoder(id);
        if (!enc || !enc->name) continue;
        if (std::find(encoders.begin(), encoders.end(), enc) == encoders.end())
            encoders.push_back(enc);
    }

    for (const AVCodec* enc : encoders) {
        if (std::find_if(list.begin(), list.end(),
                         [&](const CodecOption& c) { return c.id == enc->name; }) != list.end())
            continue;
        CodecOption o;
        o.id = enc->name;
        o.label = enc->long_name ? enc->long_name : enc->name;
        if (type == AVMEDIA_TYPE_AUDIO) describeAudioCodec(enc, o);
        else describeCodec(enc, o);
        list.push_back(std::move(o));
    }
}

} // namespace

std::vector<OptionInfo> encoderOptions(const std::string& codecName) {
    const AVCodec* codec = avcodec_find_encoder_by_name(codecName.c_str());
    if (!codec) return {};
    // The encoder's own options, then the generic AVCodecContext ones it has
    // not shadowed — the same two halves `muxerOptions`, `demuxerOptions` and
    // `decoderOptions` have always reported, and for the same reason: both
    // reach the encoder, because `av_opt_set(ctx, …, AV_OPT_SEARCH_CHILDREN)`
    // is one call that finds either.
    //
    // This half was missing, and what was missing with it was most of what the
    // command line reaches for outside a codec's own vocabulary: `flags`
    // (which is where `+ildct`, `+ilme` and `+cgop` live), `g`, `bf`, `maxrate`,
    // `bufsize`, `threads`, `thread_type`, `field_order`. A column claiming to
    // be every option the encoder has was short by ninety of them.
    std::vector<OptionInfo> out = optionsOfClass(codec->priv_class, AV_OPT_FLAG_ENCODING_PARAM);
    for (auto& o : optionsOfClass(avcodec_get_class(), AV_OPT_FLAG_ENCODING_PARAM)) {
        if (std::find_if(out.begin(), out.end(),
                         [&](const OptionInfo& e) { return e.name == o.name; }) != out.end())
            continue;
        out.push_back(std::move(o));
    }
    return out;
}

std::vector<FilterInfo> availableFilters() {
    std::vector<FilterInfo> out;
    void* opaque = nullptr;
    while (const AVFilter* f = av_filter_iterate(&opaque)) {
        if (!f->name) continue;
        FilterInfo info;
        info.name = f->name;
        info.description = f->description ? f->description : "";
        info.inputs = padsOf(f, 0);
        info.outputs = padsOf(f, 1);
        info.dynamicInputs = (f->flags & AVFILTER_FLAG_DYNAMIC_INPUTS) != 0;
        info.dynamicOutputs = (f->flags & AVFILTER_FLAG_DYNAMIC_OUTPUTS) != 0;
        info.timeline = (f->flags & AVFILTER_FLAG_SUPPORT_TIMELINE) != 0;
        out.push_back(std::move(info));
    }
    return out;
}

std::vector<OptionInfo> filterOptions(const std::string& name) {
    const AVFilter* f = avfilter_get_by_name(name.c_str());
    return f ? optionsOfClass(f->priv_class, AV_OPT_FLAG_FILTERING_PARAM)
             : std::vector<OptionInfo>{};
}

// ── encoders ───────────────────────────────────────────────────────────────
//
// Cached rather than rebuilt per call. `installHostBindings` runs in every
// realm including workers, `availableMuxers()` asks for both lists, and
// describing an encoder means walking its option table — so a list built four
// times is four walks of eighty options for nothing.

std::vector<CodecOption> availableVideoEncoders() {
    static const std::vector<CodecOption> cached = [] {
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
        addMuxerDefaults(out, AVMEDIA_TYPE_VIDEO);
        return out;
    }();
    return cached;
}

std::vector<CodecOption> availableAudioEncoders() {
    static const std::vector<CodecOption> cached = [] {
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
            describeAudioCodec(codec, o);
            out.push_back(std::move(o));
        }
        addMuxerDefaults(out, AVMEDIA_TYPE_AUDIO);
        return out;
    }();
    return cached;
}

// ── subtitles ──────────────────────────────────────────────────────────────

/// Every subtitle encoder this build links, in libavcodec's own order.
///
/// **Discovered rather than named**, which the two lists above are not: they
/// start from a candidate list because "the useful video encoders" is a
/// judgement nobody can ask libavcodec for. There is no such judgement here —
/// there are nine subtitle encoders and each one is a named interchange format
/// somebody asks for by name, so writing them down would be copying the
/// registry into this file.
///
/// A *text* subtitle and a *bitmap* one are not interchangeable, and the
/// distinction is libavcodec's own (`AV_CODEC_PROP_TEXT_SUB`) rather than
/// anything invented here: converting `dvdsub` into `subrip` is optical
/// character recognition, which is not something this or any ffmpeg does, and
/// the refusal has to be able to name the reason.
std::vector<CodecOption> availableSubtitleEncoders() {
    static const std::vector<CodecOption> cached = [] {
        std::vector<CodecOption> out;
        void* opaque = nullptr;
        while (const AVCodec* codec = av_codec_iterate(&opaque)) {
            if (codec->type != AVMEDIA_TYPE_SUBTITLE) continue;
            if (!av_codec_is_encoder(codec)) continue;
            CodecOption o;
            o.id = codec->name;
            o.longName = codec->long_name ? codec->long_name : "";
            o.label = o.longName.empty() ? o.id : o.longName;
            o.codecName = avcodec_get_name(codec->id);
            o.containers = containersFor(codec);
            if (const AVCodecDescriptor* d = avcodec_descriptor_get(codec->id))
                o.textSub = (d->props & AV_CODEC_PROP_TEXT_SUB) != 0;
            out.push_back(std::move(o));
        }
        return out;
    }();
    return cached;
}

} // namespace ffmpegbro
