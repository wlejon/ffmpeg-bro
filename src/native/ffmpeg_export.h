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
//
// What is here is the *job*: the description a render is given, and the four
// calls that start one and watch it. The parts it is made of are their own
// files — export_timeline.h answers what the output looks like at an instant,
// export_writer.h puts that in a file, and ffmpeg_capabilities.h says what
// this build can write at all.
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

/// One named input pad of a filter graph: what feeds `[0:v]`.
///
/// The mapping is given rather than inferred from the clip array, because a
/// graph names its own inputs and an index that happens to line up today is a
/// correspondence nothing enforces. Whoever wrote `[2:a]` knows which file it
/// meant; nothing downstream can work it out.
struct ExportGraphInput {
    std::string label;      // "0:v", exactly as the graph text writes it
    std::string path;
    std::string stream;     // "v" for pictures, "a" for sound

    // The earliest source time the graph will use from this pad, in seconds.
    //
    // `-filter_complex` without `-ss` decodes every input from the start of
    // its file and lets `trim` throw the rest away, which is right and is
    // ruinous for a clip an hour in. This is where the seek goes, and it is
    // safe by construction rather than by care: the seek is
    // `AVSEEK_FLAG_BACKWARD`, so it lands at or *before* what it is given and
    // can never skip a frame the graph still wants. Too small only costs
    // decoding; too large is not reachable.
    double from = 0.0;
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

    // Render through libavfilter instead of the internal compositor.
    //
    // `-filter_complex` syntax, run by libavfilter itself — so a filter the UI
    // put in the graph is a filter that reaches the picture, which is the whole
    // reason this exists. Empty is the usual case and renders through the track
    // stack, which is faster and, for an edit with nothing in the graph but the
    // compositing, the same picture. Both paths are measured against each other
    // in tests/export_test.cpp; do not let them drift apart silently.
    //
    // **The graph ends in the compositing space, not the encoder's.** What
    // leaves the last pad is a picture, and the conversion into the encoder's
    // format and colour is the writer's, exactly as it is for the other path.
    // A graph that ends with its own `scale=out_color_matrix=…` is converted
    // twice and comes out slightly worse than the command bar's, which prints
    // that tail because a standalone ffmpeg has no writer to do it.
    std::string filterGraph;
    std::vector<ExportGraphInput> filterInputs;

    // Take the frame size from the graph rather than from `width`/`height`.
    //
    // Off, a graph whose last pad is a different size from the render is an
    // error — the writer was opened for one size and would be handed another,
    // and saying so plainly beats a scaler quietly resizing every frame. On,
    // there is nothing to disagree with: the graph is asked what it produces
    // and the writer is opened for that.
    //
    // Which is exactly what previewing a node in the middle of a graph needs,
    // since nothing outside libavfilter knows how big the picture is
    // half-way through. It is opt-in because for a real export the size is a
    // decision somebody made, and silently following the graph away from it
    // would write a file of the wrong size rather than refusing to.
    bool sizeFromGraph = false;
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

} // namespace ffmpegbro
