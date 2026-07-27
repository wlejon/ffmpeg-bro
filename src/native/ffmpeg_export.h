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

/// One stream in the output file.
///
/// The renderer used to write exactly one video stream and one audio stream,
/// and everything downstream of `avformat_new_stream` assumed that shape. It
/// is the assumption that stood between this application and subtitles,
/// multi-track audio, attachments and `-map`, so what a render is given now is
/// a *list* of these — and the old one-video-one-audio render is that list with
/// two entries in it, synthesised by `outputStreams()` when nobody said
/// otherwise.
struct ExportStream {
    /// "video", "audio" or "attachment". A subtitle stream is a later chunk's;
    /// what it will need from here is a kind and a source, which is why this is
    /// a string rather than an enum of the two things that exist today.
    std::string kind = "video";

    /// Where this stream's content comes from — ffmpeg's `-map`, made explicit.
    ///
    /// Today the answer was implicit: the composite fed the video stream and
    /// the mix fed the audio one. Written down, it is "composite" (the canvas
    /// the compositor or the graph's last video pad produces) and "mix" (the
    /// whole soundtrack, summed). Both are *composed* sources rather than input
    /// streams, which is why they are named rather than numbered: no input
    /// index means "everything, stacked".
    ///
    /// **This is the seam the packet path attaches at.** A copied stream will
    /// say `copy:0:1` — an input file and a stream in it — and the writer will
    /// branch on the prefix rather than grow a second list beside this one.
    /// Nothing here builds that; it is left as a vocabulary with room in it.
    std::string source;

    /// The encoder, as libavcodec knows it. Empty asks the muxer for its
    /// default, which is what an unset `videoCodec` has always meant.
    std::string codec;

    /// `-key value` pairs for this stream's encoder, applied exactly as
    /// `ExportSettings::videoOptions` is. Per stream because two audio streams
    /// in one file are routinely two different trades.
    std::vector<ExportOption> options;

    /// `-metadata:s:a:1 key=value`. Written into the stream's own dictionary,
    /// which is where a player looks for a track name.
    std::vector<ExportOption> metadata;

    /// The one metadata key every player reads, named separately because it is
    /// the one anybody sets. ISO 639-2, "eng"/"fra"/"jpn".
    std::string language;

    /// `-disposition:a:1 default`, or `+default+forced`, or `0` for none.
    /// Parsed with `av_disposition_from_string`, never against a table here:
    /// libavformat already owns that vocabulary and a copy of it would go
    /// stale the first time one was added.
    std::string disposition;

    /// `-tag:v hvc1`. Four characters, written into the stream's `codec_tag`.
    ///
    /// This one matters out of proportion to its size: `hvc1` and `hev1` are
    /// the same HEVC bitstream and only the first plays on Apple hardware. It
    /// is not an encoder option, so before there was a stream list there was
    /// nothing in this application that could reach it.
    std::string tag;

    // ── Per-stream encoder settings ────────────────────────────────────────
    //
    // Each of these has a sentinel meaning "take the render's". A stream list
    // that has to repeat every setting to say nothing new about them is a
    // stream list nobody would write by hand, and `outputStreams()` fills them
    // in once so that nothing past it has to know there was a default.

    int crf = -1;                   // video: <0 takes ExportSettings::crf
    int bitrateKbps = 0;            // 0 takes the render's, per kind
    std::string preset;             // empty takes the render's
    std::string pixelFormat;        // empty takes the render's
    int sampleRate = 0;             // audio: 0 takes the render's
    int channels = 0;

    // ── Attachment ─────────────────────────────────────────────────────────
    //
    // An attachment *is* a stream — it has an index, it is what `-attach`
    // produces, and the muxer writes its whole content out of the stream's
    // extradata at header time. It carries no packets, which is the only way it
    // differs from the two above.

    std::string path;               // the file to embed
    std::string mimeType;           // "font/ttf"; guessed from the name if empty
};

/// One chapter mark in the output, in output-timeline seconds.
///
/// Container-level rather than per-stream, because that is what a chapter is:
/// a table beside the streams, not a track among them.
struct ExportChapter {
    double start = 0.0;
    double end = 0.0;
    std::string title;
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
    std::string path;               // output file

    /// The muxer, by the name `-f` takes: "mp4", "matroska", "mpegts". Empty
    /// falls back to guessing from the extension, which is what every render
    /// before there was a muxer picker did.
    ///
    /// Named rather than derived because a muxer's identity *is* its name: a
    /// hundred and eighty of them share about forty extensions, plenty have
    /// none at all, and "mkv" is not the name of anything — the muxer behind it
    /// is called `matroska`.
    std::string format;

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

    /// Everything else written into the container's own metadata dictionary.
    /// `title` above stays a named field because it is the one every caller
    /// sets; these are `-metadata key=value` for the rest.
    std::vector<ExportOption> metadata;

    /// What the file is made of, stream by stream.
    ///
    /// **Empty is not "no streams" — it is "the usual two".** `outputStreams()`
    /// synthesises one video stream from the composite and one audio stream
    /// from the mix out of the named fields above, which is exactly the file
    /// this renderer wrote before there was a list at all. Every caller that
    /// only ever wanted a picture and a soundtrack — the fixture generator, the
    /// node previews on the Graph stage, every test that predates this — keeps
    /// working untouched, and the named fields keep meaning what they meant.
    ///
    /// A list that *is* given is authoritative: it says how many streams there
    /// are, in what order the muxer numbers them, and what each is for. The
    /// named fields then serve as the defaults an entry does not override.
    std::vector<ExportStream> streams;

    /// Chapter marks. Written into the container before the header goes down,
    /// so a muxer that cannot hold them (mp4 can, WebM can) simply drops them.
    std::vector<ExportChapter> chapters;

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

/// The streams this render will actually write, with every default filled in.
///
/// One place, so that nothing downstream has to know whether the caller gave a
/// list or left it to the named fields, and so that "what will be in the file"
/// is a question with an answer before the file is opened. `wantAudio` is the
/// edit's — a timeline with no sound in it gets no audio stream however many
/// the list asks for, which is the rule the writer has always followed.
std::vector<ExportStream> outputStreams(const ExportSettings& s, bool wantAudio);

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
