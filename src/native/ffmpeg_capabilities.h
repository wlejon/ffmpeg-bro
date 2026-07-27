// What this build can actually write, asked of libavcodec.
//
// Which encoders are *offered* is a curated list, checked against the build:
// libavcodec has two hundred of them with names like "vc2" and nobody wants to
// pick from that. What each offered encoder can *do* is asked of libavcodec and
// never written down here — the pixel formats it accepts, the presets and
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

/// One AVOption of an encoder, in the shape a form control needs.
struct EncoderOption {
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
std::vector<EncoderOption> encoderOptions(const std::string& codecName);

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

    std::vector<std::string> containers;     // extensions that will hold it
};

std::vector<CodecOption> availableVideoEncoders();
std::vector<CodecOption> availableAudioEncoders();

struct ContainerOption {
    std::string ext;        // "mp4"
    std::string label;      // "MP4 (H.264/AAC)"
    std::string videoCodec; // what to default to inside it
    std::string audioCodec;
    std::string longName;

    // Which of the offered encoders this muxer will actually accept, asked of
    // avformat_query_codec. Putting VP9 in an mp4 is legal and plays nowhere;
    // putting AAC in a WebM is not legal at all, and the failure arrives at
    // write_header, long after the choice was made.
    std::vector<std::string> videoCodecs;
    std::vector<std::string> audioCodecs;
};

std::vector<ContainerOption> availableContainers();

/// A path under the OS temp directory, for the preview renders the export
/// workspace throws away. Deterministic for a given name so a preview
/// overwrites the last one rather than filling the disk with them; the
/// directory is created if it is not there. Here because it is the other
/// question the UI asks about the machine rather than about the edit.
std::string tempPath(const std::string& name);

} // namespace ffmpegbro
