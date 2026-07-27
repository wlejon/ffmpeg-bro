// What this build can actually write, asked of libavcodec.
//
// Which encoders are *offered* is a named list checked against the build, plus
// the default encoder of every muxer this build links — so picking `gif` or
// `image2` or `mpegts` offers something that can go in it, and that half of the
// list is asked rather than typed. What each offered encoder can *do* is asked
// of libavcodec and never written down here — the pixel formats it accepts, the presets and
// profiles it names, the range of its quality control. An ffmpeg upgrade that
// gives x265 a new tune gives this app the new tune, and nobody edits anything.
//
// This is the surface the UI's form and its advanced option editor are drawn
// from, which is why it cannot offer a control the encoder does not have. It is
// also what a graph's encoder node will be drawn from, for the same reason.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Declared, not included: this header is read by the tests and by the JS
// bindings, neither of which should need libav's include path to ask what this
// build can write.
struct AVCodec;

namespace ffmpegbro {

/// Does this encoder take `-crf`, `-preset`, `-cq`…? Asked of libavcodec
/// directly rather than kept as a list: the option exists on the private
/// context of the encoders that have it, and nowhere else.
bool hasOption(const AVCodec* codec, const char* name);

/// A named value an option will accept — the AV_OPT_TYPE_CONST children that
/// make an int option an enum. `preset` on nvenc has these; `preset` on x264
/// is a bare string and has none, which is why the caller has to cope with an
/// empty list rather than assume a menu is always possible.
struct OptionValue {
    std::string name;
    std::string help;
    int64_t value = 0;
};

/// One AVOption, in the shape a form control needs.
///
/// Encoders and filters are described by the same structure because libavutil
/// describes them with the same structure: an AVClass with an option table. A
/// second copy of this for filters would be a second set of type names to keep
/// in step with the first.
struct OptionInfo {
    std::string name;
    std::string help;
    std::string type;           // "int", "double", "string", "bool", "enum",
                                // "flags", "rational", "duration", "dict"…
    std::string unit;           // groups an enum with its constants
    double min = 0.0;
    double max = 0.0;
    std::string defaultValue;   // rendered as text, whatever the type
    bool hasRange = false;
    std::vector<OptionValue> values;
};

/// Every private option of one encoder, straight out of its AVClass. This is
/// the surface the UI's advanced editor is drawn from — nothing here is a list
/// maintained by hand, so an ffmpeg upgrade that adds an option to x265 adds it
/// to the app.
std::vector<OptionInfo> encoderOptions(const std::string& codecName);

// ── What this build can put a picture through ──────────────────────────────
//
// The same argument as the encoder list, one stage earlier. A filter palette
// written down here would be a list of what libavfilter had on the day it was
// typed; asked of libavfilter it is what this build actually links, which is
// the only list that cannot offer a filter the render will then refuse.

/// One filter, in the shape a palette needs: what it is called, what it does,
/// and what it can be wired to.
struct FilterInfo {
    std::string name;
    std::string description;

    /// One character per pad, in order: 'v' or 'a'. Empty with `dynamicInputs`
    /// means "as many as you ask for" (amix, concat); empty without it means a
    /// source that takes nothing (color, sine).
    std::string inputs;
    std::string outputs;

    bool dynamicInputs = false;
    bool dynamicOutputs = false;
    /// Takes `enable=`: it can be switched on and off over time.
    bool timeline = false;
};

/// Every filter this build links, in libavfilter's own order.
std::vector<FilterInfo> availableFilters();

/// One filter's options, straight out of its AVClass — the same walk
/// `encoderOptions` does, and drawn by the UI in the same way. A filter with
/// no private class (`null`, `copy`) has none, which is not an error.
std::vector<OptionInfo> filterOptions(const std::string& name);

struct CodecOption {
    std::string id;         // what to put in ExportSettings
    std::string label;      // for a menu
    std::string longName;   // libavcodec's own description
    bool supportsCrf = false;
    bool supportsPreset = false;
    bool supportsQp = false;
    bool supportsTune = false;
    bool hardware = false;  // encodes on the GPU: fast, and quality per bit is
                            // not comparable with a software encoder's
    bool intraOnly = false; // every frame a keyframe (ProRes, MJPEG)
    bool lossless = false;  // can be told to write losslessly
    bool alwaysLossless = false;  // has no lossy mode: FFV1, HuffYUV
    bool losslessOption = false;  // asks for it with -lossless 1 rather than a
                                  // quality of zero
    double crfMin = 0.0;
    double crfMax = 51.0;
    double crfDefault = 23.0;

    std::vector<std::string> pixelFormats;   // names, encoder's own order
    std::vector<std::string> presets;
    std::vector<std::string> tunes;
    std::vector<std::string> profiles;       // what to pass to -profile
    std::vector<std::string> profileLabels;  // human names, same order

    std::vector<int> sampleRates;            // audio: what it will take
    std::vector<int> channelCounts;

    /// The muxers that will hold this codec, by name, asked of
    /// `avformat_query_codec` over every muxer this build links. Names rather
    /// than extensions because a muxer is chosen by name — see MuxerOption.
    std::vector<std::string> containers;
};

std::vector<CodecOption> availableVideoEncoders();
std::vector<CodecOption> availableAudioEncoders();

// ── What this build can write the result *into* ────────────────────────────
//
// This used to be four extensions in an array — mp4, mkv, mov, webm — sitting
// next to a codec list that was genuinely asked of libavcodec. Every other
// muxer this build links (MPEG-TS, MXF, AVI, FLV, GIF, image2, WAV, ADTS, and
// a hundred and seventy more) was compiled in and unreachable because of that
// line, and four of the things this application still cannot do needed one of
// them. So the list is `av_muxer_iterate`, and what distinguishes one entry
// from another is asked of the muxer rather than decided here.
//
// **A muxer is chosen by name, not by extension.** That is what `-f mpegts`
// means, and it is the only choice that works for the muxers with no extension
// at all (rtp, tee, every device) and for the ones that share theirs. The
// extension is then a *consequence* — what to call the file — rather than the
// identity of the format.

/// One muxer, in the shape a picker needs.
struct MuxerOption {
    std::string name;       // "matroska" — literally what `-f` takes
    std::string label;      // for a menu: the long name where there is one
    std::string longName;
    std::string ext;        // the first extension, or "" — plenty have none
    std::vector<std::string> extensions;
    std::string mimeType;

    /// An encoder to default to, chosen from what this build offers. Not the
    /// same question as `defaultVideo` below: `mpegts` says MPEG-2 video and
    /// this build's list has no MPEG-2 encoder, so the answer is the first
    /// offered encoder the muxer will hold rather than nothing.
    std::string videoCodec;
    std::string audioCodec;

    /// What the muxer itself says it writes when nobody says otherwise, as
    /// codec names. A fact about the format even where this build cannot
    /// encode it, which is why it is reported separately from the two above.
    std::string defaultVideo;
    std::string defaultAudio;
    std::string defaultSubtitle;

    // The facts a picker can group a hundred and eighty entries by. Every one
    // of them is read off the AVOutputFormat or asked of it — there is no
    // list of "the good ones" anywhere, because a list like that is exactly
    // what this file exists to be the opposite of.
    bool noFile = false;        // AVFMT_NOFILE: writes through a protocol or a
                                // device rather than to a file it opens
    bool globalHeader = false;
    bool noTimestamps = false;
    /// Writes pictures and nothing else — an intra-only video codec by
    /// default and no audio codec at all. That is image2, gif, apng, webp and
    /// the single-frame writers, and it is a property of the muxer rather
    /// than a name anybody typed.
    bool stills = false;
    /// Came out of libavdevice rather than libavformat: a screen grabber, a
    /// sound card, a window.
    bool device = false;

    // Which of the offered encoders this muxer will actually accept, asked of
    // avformat_query_codec. Putting VP9 in an mp4 is legal and plays nowhere;
    // putting AAC in a WebM is not legal at all, and the failure arrives at
    // write_header, long after the choice was made.
    std::vector<std::string> videoCodecs;
    std::vector<std::string> audioCodecs;

    /// Whether the two lists above are an *answer*.
    ///
    /// `avformat_query_codec` has three outcomes and only two of them are yes
    /// and no: a muxer with neither a `query_codec` function nor a codec tag
    /// table returns AVERROR_PATCHWELCOME, which means "not taught to answer".
    /// Over four well-known containers that never came up; over a hundred and
    /// eighty it does — mpegts answers for the three codecs it names as
    /// defaults and shrugs at everything else, so reading the shrug as "no" is
    /// how a picker comes to insist MPEG-TS will not hold H.264.
    ///
    /// False means the lists above are *everything offered* rather than a
    /// filtered set, because ffmpeg would let you try and the muxer's own
    /// refusal at write_header is a better place to find out than a menu that
    /// was wrong. Anything drawing this should say which kind of answer it has.
    bool answersCodecs = true;
};

/// Every muxer this build links, libavformat's own order. Includes libavdevice's
/// output devices, which only exist once `avdevice_register_all()` has run —
/// see `registerDevices()`.
std::vector<MuxerOption> availableMuxers();

/// One muxer's option table, out of its `priv_class`, followed by the generic
/// `AVFormatContext` options that are not shadowed by one.
///
/// Both halves reach the muxer: `avformat_write_header` applies its dictionary
/// with `AV_OPT_SEARCH_CHILDREN`, so `movflags` (private to movenc) and
/// `avoid_negative_ts` (generic) travel the same way — which is the same
/// argument the encoder's advanced column is built on. On demand rather than at
/// startup for the same reason `filterOptions` is: there are a hundred and
/// eighty of them and a form only ever shows one.
std::vector<OptionInfo> muxerOptions(const std::string& name);

/// One demuxer, and its option table. The mirror of the two above, for the
/// other end of the pipeline: a source is an `-i`, and `-f`/`-fflags`/a
/// demuxer's own private options are how you say what it is and how to read it.
struct DemuxerOption {
    std::string name;       // "mov,mp4,m4a,3gp,3g2,mj2" — demuxer names are
                            // comma-separated alternatives, and `-f` takes any
    std::string longName;
    std::vector<std::string> extensions;
    std::string mimeType;
    bool noFile = false;
    bool device = false;
};

std::vector<DemuxerOption> availableDemuxers();
std::vector<OptionInfo> demuxerOptions(const std::string& name);

// ── What this build can reach, and what it can read ────────────────────────

/// The URL schemes compiled in, input and output separately — they are not the
/// same set, and a picker that offered `https` as a destination would be
/// offering something that cannot work. This build links openssl and srt, so
/// the answer here is considerably longer than "file".
struct ProtocolList {
    std::vector<std::string> input;
    std::vector<std::string> output;
};

ProtocolList availableProtocols();

/// One protocol's options, out of `avio_protocol_get_class`. `rtmp_live`,
/// `srt_maxbw`, `http_persistent` — the things a destination is configured
/// with, and the reason a network output is more than a URL.
std::vector<OptionInfo> protocolOptions(const std::string& name);

/// One capture or playback device. libavdevice registers these as ordinary
/// muxers and demuxers, so they also appear in the two lists above; this is
/// the same set asked the other way round, which is what a capture UI wants.
struct DeviceInfo {
    std::string name;       // "gdigrab", "dshow"
    std::string longName;
    std::string kind;       // "video" | "audio"
    std::string direction;  // "input" | "output"
};

std::vector<DeviceInfo> availableDevices();

/// What one device can actually see right now: the cameras plugged in, the
/// windows on the screen, the sound cards.
///
/// On demand and never at startup, because this is the one capability query in
/// this file that talks to hardware — `dshow` enumerates every camera driver on
/// the machine and can take a noticeable fraction of a second. A device with no
/// `get_device_list` answers `ENOSYS`, which is an answer and not a failure, so
/// `ok` is false with a reason rather than an empty list that reads as "no
/// cameras".
struct DeviceSource {
    std::string name;        // what to put after -i
    std::string description; // what to show
};

struct DeviceSourceList {
    bool ok = false;
    std::string error;
    std::vector<DeviceSource> sources;
};

DeviceSourceList deviceSources(const std::string& name);

/// `avdevice_register_all()`, once. Nothing in this repo called it, so gdigrab
/// and dshow were linked and unreachable — not merely unlisted: an
/// `avformat_open_input` naming one would not have found it either. Called from
/// `registerFfmpegBackend()` and from every enumeration below, because a device
/// missing from a list is a device missing from the application.
void registerDevices();

// ── What this build can read ───────────────────────────────────────────────

/// One decoder. The counterpart of the encoder list, and the surface `-skip_frame`,
/// `-discard` and every decoder private option are reachable through.
struct DecoderInfo {
    std::string name;
    std::string longName;
    std::string type;       // "video" | "audio" | "subtitle" | "data"
    bool hardware = false;
    bool experimental = false;
};

std::vector<DecoderInfo> availableDecoders();

/// One decoder's private options, the same walk `encoderOptions` does with the
/// other flag. There has been no way to reach these at all.
std::vector<OptionInfo> decoderOptions(const std::string& name);

/// The four-character codes this muxer will accept for this codec — the
/// vocabulary a `-tag:v` control can offer instead of a blank box.
///
/// `hvc1` and `hev1` are the same HEVC bitstream and only the first plays on
/// Apple hardware, so a tag is a decision somebody has to be able to take; and
/// nobody types a fourcc they have not seen before. The first entry is what the
/// muxer writes when nothing is set.
///
/// **This is the one capability libavformat will not enumerate.** `AVCodecTag`
/// is an opaque struct — `av_codec_get_tag2` asks "what is this codec's tag
/// here" and `av_codec_get_id` asks "what codec is this tag here", and there is
/// no way to walk a muxer's table. So the alternates are *candidates*, and
/// every one of them is put back through `av_codec_get_id` against this
/// muxer's own tables before it is offered: nothing reaches the caller that the
/// container does not agree means this codec, and a candidate that is wrong for
/// a format simply does not appear in it.
std::vector<std::string> codecTags(const std::string& format,
                                   const std::string& codecName);

/// Every flag a stream can be given — `default`, `forced`, `comment`,
/// `hearing_impaired`, and the rest — in libavformat's own words.
///
/// This one *is* enumerable: a disposition is a single bit and
/// `av_disposition_to_string` names it, so the whole vocabulary comes out of
/// asking for every bit in turn. Which means the row of toggles a UI draws is
/// libavformat's list and gains whatever the next ffmpeg adds.
std::vector<std::string> streamDispositions();

/// A path under the OS temp directory, for the preview renders the export
/// workspace throws away. Deterministic for a given name so a preview
/// overwrites the last one rather than filling the disk with them; the
/// directory is created if it is not there. Here because it is the other
/// question the UI asks about the machine rather than about the edit.
std::string tempPath(const std::string& name);

} // namespace ffmpegbro
