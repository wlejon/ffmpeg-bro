// What this build can actually write, asked of libavcodec. See
// ffmpeg_capabilities.h for why none of it is written down.

#include "ffmpeg_capabilities.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

#include <algorithm>
#include <cctype>
#include <cstring>
#include <filesystem>
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
