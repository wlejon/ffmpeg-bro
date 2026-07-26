// Rendering the timeline to a file — the encode half of ffmpeg-bro.
//
// Everything the viewer shows is a description of an output frame: each clip
// has a rectangle in the output canvas, a crop, an opacity and a place in the
// track stack. Playing that description is what the viewer does. Writing it
// down is what this does, and the two have to agree, which is why the caller
// hands over placement rectangles *already computed in canvas pixels* rather
// than the fit/zoom/pan/grid inputs they came from. One layout implementation,
// in ui/viewer.js, and no second one here to drift away from it.
//
// This is the GPL half of the GPL half: x264, x265 and the rest of the good
// encoders are why this repo takes the license it does.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// One clip, as the renderer needs it: when it appears, what part of its file
/// it shows, and where its picture lands in the canvas.
struct ExportClip {
    std::string path;

    // Timeline, in seconds.
    double start = 0.0;
    double length = 0.0;
    double inPoint = 0.0;    // where in the file `start` is

    // Where the WHOLE picture would land in the output canvas, in canvas
    // pixels, before cropping — exactly what ui/viewer.js `placement()`
    // returns. May hang off any edge; may be larger than the canvas.
    double x = 0.0, y = 0.0, w = 0.0, h = 0.0;

    // Fractions of that rectangle cut off each edge, as in viewer.js: the
    // window is the kept part and the picture inside it stays whole.
    double cropL = 0.0, cropT = 0.0, cropR = 0.0, cropB = 0.0;

    double opacity = 1.0;
    double volume = 1.0;
    bool muted = false;

    // Paint order, low to high. Clips are composited in this order, so a
    // higher one covers a lower one — the track stack, flattened.
    int z = 0;
};

/// One `-key value` pair, exactly as the ffmpeg command line would take it.
struct ExportOption {
    std::string key;
    std::string value;
};

struct ExportSettings {
    std::string path;               // output file; the extension picks the muxer

    int width = 1920;
    int height = 1080;
    double fps = 30.0;

    // The slice of timeline to render.
    double startTime = 0.0;
    double endTime = 0.0;

    // Encoder names as libavcodec knows them: "libx264", "libx265",
    // "libvpx-vp9", "prores_ks", "mpeg4"... Empty asks the muxer for its
    // default. An unavailable name is an error rather than a silent
    // substitution: a build without x264 should say so.
    std::string videoCodec = "libx264";
    std::string audioCodec = "aac";

    // Quality. CRF is the useful control for x264/x265/VP9 — constant
    // quality, bitrate wherever it lands. A bitrate, when given, wins.
    // These stay as named fields because they are what nearly every render
    // sets; anything they cannot say goes in `videoOptions` below, which is
    // applied afterwards and therefore wins.
    int crf = 20;
    int videoBitrateKbps = 0;
    std::string preset = "medium";  // x264/x265 speed/size trade

    bool includeAudio = true;
    int audioBitrateKbps = 192;
    int audioSampleRate = 48000;
    int audioChannels = 2;

    // The pixel format written, by name ("yuv420p", "yuv422p10le"). Empty
    // takes the encoder's preference, which is yuv420p wherever that is legal
    // because everything plays it.
    std::string pixelFormat;

    // How the canvas is resampled on the way to the encoder and on the way in
    // from each source: "bicubic" (the default), "bilinear", "lanczos",
    // "spline", "neighbor", "area", "gauss", "fast_bilinear".
    std::string scaler;

    // "auto" — BT.709 above 720p, BT.601 below — or "bt709"/"bt601"/"bt2020".
    // Drives the conversion *and* the tag written into the stream, which have
    // to agree or the file looks right in one player and wrong in the next.
    std::string colorspace;
    std::string colorRange;         // "tv" (the default) or "pc"

    bool faststart = true;          // mp4/mov: index at the front
    std::string title;              // written as the container's title tag

    // Everything else libav will take.
    //
    // Applied with av_opt_set(ctx, key, value, AV_OPT_SEARCH_CHILDREN) on the
    // encoder context, which is how the ffmpeg command line applies its own
    // `-key value` arguments: it reaches both the generic AVCodecContext
    // options ("g", "bf", "maxrate", "profile", "level") and every private
    // option of the specific encoder ("x264-params", "rc", "spatial-aq",
    // "tiles"…). That is the whole of ffmpeg's writing surface rather than the
    // subset someone thought to add a named field for, and it means the UI's
    // friendly controls and its raw option editor produce the same thing.
    //
    // A key the encoder does not have is an error, not a shrug: a silently
    // ignored setting is worse than a refused one.
    std::vector<ExportOption> videoOptions;
    std::vector<ExportOption> audioOptions;
    std::vector<ExportOption> formatOptions;   // handed to the muxer
};

/// A snapshot of the running job. Copied under the lock, so the caller can
/// read it at leisure.
struct ExportStatus {
    enum class State { Idle, Running, Done, Failed, Cancelled };

    State state = State::Idle;
    double progress = 0.0;          // 0..1
    int64_t framesDone = 0;
    int64_t framesTotal = 0;
    double elapsedSec = 0.0;
    double encodeFps = 0.0;         // output frames per second of wall clock
    int64_t bytesWritten = 0;
    std::string path;
    std::string error;              // set when state == Failed
    std::string stage;              // what it is doing, for the progress line
};

/// Start rendering on a background thread. Returns false — with a reason in
/// `error` — if a job is already running or the settings cannot work.
///
/// The clips are copied: the caller's model is free to change underneath.
bool startExport(const ExportSettings& settings,
                 const std::vector<ExportClip>& clips,
                 std::string* error);

/// Where the job has got to. Safe to call from any thread, any time.
ExportStatus exportStatus();

/// Ask the job to stop. It finishes the frame it is on, closes the file it
/// was writing and reports Cancelled. Returns immediately.
void cancelExport();

/// Block until the running job has finished, whatever its outcome. For
/// shutdown and for tests; the UI polls instead.
void waitForExport();

// ── What this build can actually write ─────────────────────────────────────
//
// Asked of libavcodec rather than hardcoded, because the answer depends on
// how ffmpeg was configured: a build without --enable-libx264 has no libx264
// no matter what a menu claims.

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
/// dialog throws away. Deterministic for a given name so a preview overwrites
/// the last one rather than filling the disk with them; the directory is
/// created if it is not there.
std::string tempPath(const std::string& name);

} // namespace ffmpegbro
