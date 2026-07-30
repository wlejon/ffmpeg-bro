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

#include "ffmpeg_input.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// One `-key value` pair, exactly as the ffmpeg command line would take it.
/// The same struct a demuxer's options are written with — see ffmpeg_input.h —
/// because they are the same kind of thing applied the same way.
using ExportOption = KeyValue;

/// One clip, as the renderer needs it: when it appears, what part of its file
/// it shows, and where its picture lands in the canvas.
struct ExportClip {
    /// Which of `ExportSettings::inputs` this clip is cut from, or -1.
    ///
    /// -1 is not "no input": it means the input this clip *is*, synthesised
    /// from `path` alone with everything left at libavformat's defaults — which
    /// is the render every caller wrote before inputs existed, and what the
    /// fixture generator and the node previews still write. `resolveInput()`
    /// is the one place that turns either shape into an input.
    int input = -1;

    /// The file, when `input` is -1. With an input it is carried for the log
    /// and ignored: the input says what is opened.
    std::string path;

    // Timeline, in seconds.
    double start = 0.0;
    double length = 0.0;     // on the TIMELINE; the source span is length*speed
    double inPoint = 0.0;    // where in the file `start` is

    /// How fast the source runs through that window. 1 is the file's own rate.
    ///
    /// **`length` is the timeline length and this is the slope**, which is the
    /// model's rounding carried verbatim — see `ui/project.js`'s speed section. So
    /// the source time for an output time is `inPoint + (t - start) * speed`, and
    /// that is stated in exactly one place (`TimelineSource::canvasAt`) plus the
    /// one seek that lines the sound up.
    ///
    /// **The sound is resampled, so the pitch moves with it.** `SourceAudio::open`
    /// multiplies the *input* rate handed to `swr` by this, which is what
    /// `asetrate=<rate>*<speed>,aresample=<rate>` means in a filtergraph — the
    /// same statement `ui/graph/derive.js` prints, deliberately, because the two
    /// paths must describe one render. Preserving the pitch is `atempo`, a
    /// libavfilter filter, and there is no graph here to put one in.
    double speed = 1.0;

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

/// One bitstream filter on one stream — `-bsf:v h264_mp4toannexb`.
///
/// **A bitstream filter is not an encoder option and not a muxer option.** It
/// sits between the two, working on packets that have already been encoded:
/// `h264_mp4toannexb` rewrites length-prefixed NAL units as start codes,
/// `hevc_metadata` edits the VUI without re-encoding a pixel, `dump_extra`
/// puts the parameter sets in front of every keyframe so a stream can be joined
/// mid-flight, `setts` rewrites timestamps. None of them can be reached by any
/// of the option bags above, because none of them belongs to an encoder or to a
/// muxer.
///
/// It is a **chain, in order**, per stream. `-bsf:v a,b` runs `a` and then `b`,
/// and the order is the whole of the meaning — which is why this is a list of
/// named things with their own arguments rather than a string to be parsed
/// somewhere. libavcodec's own `av_bsf_list_*` joins them into one context, so
/// what runs is what a command line would run.
struct ExportBsf {
    std::string name;                   ///< `av_bsf_get_by_name`; unknown is an error
    std::vector<ExportOption> options;  ///< out of the filter's own AVClass
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
    /// "video", "audio", "subtitle" or "attachment". A string and not an enum,
    /// which is what let the fourth kind arrive without touching this struct:
    /// a kind and a source were all subtitles needed from here, and `source`
    /// grew one form (`decode:<input>:<stream>`) rather than the list growing
    /// a parallel field.
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
    /// **This is the seam the packet path attaches at**, and does. A copied
    /// stream says `copy:0:1` — an input file and a stream in it, exactly what
    /// `-map 0:1` names — and the writer branches on the prefix rather than
    /// growing a second list beside this one. Such a stream reaches no encoder
    /// at all: its packets come out of a demuxer and go into the muxer, which
    /// is what makes a rewrap instant and a cut lossless. See export_copy.h.
    ///
    /// **And `pad:<label>` is a named output pad of the filter graph**, which is
    /// how one render comes to produce several different pictures: a wide screen
    /// grab cut in two by `crop`, a proxy beside a master, a waveform beside the
    /// sound it is of. It is `-map [left]` written down, and the label is
    /// libavfilter's own — the text between the brackets at the end of a chain,
    /// verbatim, because inventing a second vocabulary for it would be a name to
    /// keep in step with the graph.
    ///
    /// The composite and the mix are the pads the graph did not have to name:
    /// with one picture pad it *is* the composite whatever it is labelled, and
    /// with several it is the one labelled `vout` (`aout` for sound). So a graph
    /// with two pads and a render that wants the canvas has to say which, and a
    /// spec that does not is refused naming the labels there were. Nothing that
    /// predates this changes: one pad in, one pad out, and `composite` still
    /// means it.
    std::string source;

    /// The span of the input a copied stream takes, in the input's own seconds.
    /// Ignored by anything fed from the composite or the mix.
    ///
    /// **A copy can only start at a keyframe**, so `copyFrom` is where the
    /// input is *seeked* to and not necessarily where the output begins: the
    /// seek is `AVSEEK_FLAG_BACKWARD` and lands at or before it, because
    /// landing after it would drop frames the copy was asked for. The
    /// difference is a real cost and it is the caller's job to show it —
    /// `keyframesOf()` in export_copy.h is what a UI asks so that the in-point
    /// can be snapped to one before the render rather than explained after it.
    ///
    /// `copyTo` is 0 for the end of the input.
    double copyFrom = 0.0;
    double copyTo = 0.0;

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

    /// How big this stream's picture is. 0 is the render's, which is what every
    /// stream fed from the composite has always been.
    ///
    /// Two things want it. A stream fed from a graph pad is whatever size that
    /// pad settled on and nothing outside libavfilter knows what that is, so the
    /// job fills these in from the sink once the graph is configured — leaving
    /// them at 0 for a `pad:` stream means "ask the graph", not "the render's".
    /// And a second composite-fed stream at half the size is a proxy beside the
    /// master, which is the same one canvas through two encoders and costs
    /// nothing but the scale it was already doing.
    int width = 0;
    int height = 0;
    std::string preset;             // empty takes the render's
    std::string pixelFormat;        // empty takes the render's
    int sampleRate = 0;             // audio: 0 takes the render's
    int channels = 0;

    /// `-force_key_frames:v`, exactly as ffmpeg spells it: a comma-separated
    /// list of times, or `expr:` and one of libavutil's expressions evaluated
    /// per frame against `n`, `t`, `n_forced`, `prev_forced_n`, `prev_forced_t`.
    ///
    /// **The times are seconds into the output**, not into the timeline, which
    /// is what ffmpeg means by them and what makes a printed command run
    /// elsewhere and produce the same file. Whoever knows where the cuts are
    /// subtracts the range's start; nothing here can, because nothing here
    /// knows there was a range.
    ///
    /// Empty takes `ExportSettings::forceKeyFrames`.
    std::string forceKeyFrames;

    /// "progressive", "tt" (top field first) or "bb". Empty takes the render's.
    ///
    /// Two things at once, and they have to travel together: the encoder is put
    /// into interlaced mode (`-flags +ildct+ilme`, and `field_order` written
    /// into the stream so a player knows) *and* every frame handed to it is
    /// marked interlaced with the field order it was told. Setting only the
    /// first writes a file that claims to be interlaced and is not; setting
    /// only the second is a claim nothing downstream can read.
    std::string fieldOrder;

    /// `-threads` and `-thread_type`. 0 is `auto`, which is what every encoder
    /// in this binary has always been opened with and remains the right default
    /// — this exists for the render that has to leave a core alone.
    int threads = -1;               ///< <0 takes the render's
    std::string threadType;         ///< "frame", "slice", "frame+slice"; empty is the render's

    /// The packet chain this stream goes through on the way to the muxer.
    ///
    /// Per stream and not per render, because that is what a bitstream filter
    /// is: `-bsf:v` and `-bsf:a` are different chains on different packets, and
    /// two video streams in one file are routinely two different trades.
    std::vector<ExportBsf> bitstreamFilters;

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
    /// "v" for pictures, "a" for sound, "s" for cues.
    ///
    /// The third is not a third kind of pad to libavfilter — there is no such
    /// thing as a subtitle input there — it is a picture pad whose frames this
    /// renderer paints out of a bitmap subtitle track, which is what ffmpeg's own
    /// CLI does for `[0:s]`. See export_sub2video.h. Anything else is an error
    /// naming the letter, rather than being read as video.
    std::string stream;

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

    /// Which of `ExportSettings::inputs` feeds this pad, or -1 for `path`
    /// opened plainly. Two pads of one input — `[0:v]` and `[0:a]` — carry the
    /// same index, which is what says they are one `-i` and one demuxer.
    ///
    /// Last rather than beside `path`, where it belongs, so that the positional
    /// initialisers in tests/export_test.cpp — `{"0:v", file, "v"}` — still say
    /// what they said. A field order is not worth that churn.
    int input = -1;
};

/// One run over the frames, as a set of overrides on the render it belongs to.
///
/// **A pass is not a job.** There is one run slot in this binary (ffmpeg_job.h)
/// and a two-pass render is one thing to the person who started it: one Stop
/// button, one terminal status, one file at the end. What it is to the machine
/// is two walks over the same range, and the only honest way to say so is for
/// the status to name the pass it is in — which is why `ExportStatus` carries
/// `pass`, `passCount` and `passLabel` rather than this inventing a second slot
/// and a second progress bar.
///
/// Every field is "the render's unless this says otherwise". A pass that
/// overrides nothing renders exactly what the settings describe, which is what
/// makes an empty `passes` list and a one-entry list the same render.
struct ExportPass {
    /// What to say while this pass runs — "analysing", "pass 1". It goes into
    /// `ExportStatus::passLabel`, beside the stage, because "43%" of a render
    /// that is going to do the whole thing again is a lie by omission.
    std::string label;

    std::string filterGraph;                    ///< empty: the render's
    std::vector<ExportGraphInput> filterInputs; ///< empty: the render's
    std::string path;                           ///< empty: the render's
    std::string format;                         ///< empty: the render's

    /// The encoder for this pass. Empty is the render's.
    ///
    /// A detection pass does not care what the pictures are encoded as and the
    /// cheapest answer is `wrapped_avframe` through the `null` muxer, which
    /// encodes nothing at all. A two-pass *encoder* is the opposite case and
    /// must stay on the real encoder, because the statistics file is that
    /// encoder's. Both are said here rather than inferred from `discard`.
    std::string videoCodec;

    /// `-key value` for this pass, **merged on top of the render's** — so a
    /// pass adds `pass=1` and keeps everything else the render is set to, which
    /// is what a two-pass encode means.
    ///
    /// **A pass that names its own encoder starts from an empty bag instead.**
    /// An option table belongs to an encoder: carrying x264's `preset` onto
    /// `wrapped_avframe` would be an unknown option, and an unknown option is
    /// an error here rather than a shrug. So changing the encoder is also
    /// saying that what was set on the old one does not apply.
    std::vector<ExportOption> videoOptions;
    std::vector<ExportOption> audioOptions;

    /// The frame this pass is encoded at. Zero is the render's.
    ///
    /// **A pass at a different size is the second thing `passes` is for**, and
    /// it is not a two-pass encode: a 1080p master and a 720p proxy are two
    /// encodes of one edit, which is what `tee` is *not* — `tee` is one encode
    /// to several places, and two sizes cannot come out of one encoder.
    ///
    /// The rectangles go with it, in `clips`, rather than the composite being
    /// made at the render's size and scaled down here. One resample instead of
    /// two: each picture goes from its source straight to the size it is shown
    /// at, which is what the render already does for the master. Handing over
    /// only a size and letting the writer's scaler take the difference would
    /// have been a smaller change and a softer picture.
    int width = 0;
    int height = 0;

    /// The stack this pass composites, in its own pixels. Empty is the render's.
    ///
    /// The list has to travel with the size because a rectangle is in output
    /// pixels: a clip filling a 1920-wide canvas is `w: 1920`, and composited
    /// unchanged onto a 1280-wide one it would be cropped rather than fitted.
    /// Scaling them here instead of in the caller was the alternative, and it
    /// would have put a second implementation of `buildSpec`'s `sx`/`sy` where
    /// nothing could compare the two.
    std::vector<ExportClip> clips;

    /// Write through the `null` muxer: run everything, keep nothing.
    ///
    /// This is `-f null -` and it is what an analysis pass wants — the point of
    /// it is the file a filter wrote beside the output, or the statistics log
    /// the encoder kept, not the pictures. `path` and `format` are ignored when
    /// it is set, and the null muxer is `AVFMT_NOFILE`, so nothing is opened
    /// and nothing is left behind.
    bool discard = false;
};

struct ExportSettings {
    std::string path;               // output file

    /// The `-i`s. Every clip and every graph input pad names one by index.
    ///
    /// A list rather than a path per clip because that is what an input is: two
    /// clips cut from one file are one `-i`, one demuxer, one seek and one set
    /// of options, and a render that opened it twice with two different option
    /// bags would be describing two files. Empty is ordinary — a spec whose
    /// clips carry paths and nothing else renders exactly as it always did.
    std::vector<MediaInput> inputs;

    /// The muxer, by the name `-f` takes: "mp4", "matroska", "mpegts". Empty
    /// falls back to guessing from the extension, which is what every render
    /// before there was a muxer picker did.
    ///
    /// Named rather than derived because a muxer's identity *is* its name: a
    /// hundred and eighty of them share about forty extensions, plenty have
    /// none at all, and "mkv" is not the name of anything — the muxer behind it
    /// is called `matroska`.
    std::string format;

    /// `-f fifo` in front of `format`: keep trying when the destination drops.
    ///
    /// **This is a decision, not a bag of options.** "Keep going if the stream
    /// drops" means, in ffmpeg, wrapping the muxer in the `fifo` pseudo-muxer —
    /// a queue, a thread, and a reconnect loop around whatever it is told to
    /// wrap. There is one such muxer and it is named here for the reason `tee`
    /// is named in ui/export/destination.js: it *is* the mechanism, and asking a
    /// question to discover it would be asking a question with one possible
    /// answer. Everything about *what one takes* is still libav's — the option
    /// table, the ranges and the defaults are read out of `muxerOptions("fifo")`
    /// and nothing here writes one down.
    ///
    /// **Three things follow from the wrapping and none of them is optional.**
    /// The destination is opened on fifo's own thread, so a URL that cannot be
    /// reached at all is no longer a refusal at start — it is the first thing to
    /// recover from, which is what was asked for. Everything the writer records
    /// about the files it opened is therefore written from two threads and
    /// guarded (`Writer::piecesMu_`). And the muxer that decides *what the file
    /// is* stops being `oc_->oformat`; see `Writer::format_`.
    struct FifoSettings {
        bool on = false;

        /// Every one of these means "leave it to the muxer" at its sentinel, so
        /// that libav's own default is the only default there is. A number
        /// written down here would be a second answer to a question
        /// `muxerOptions("fifo")` already reports.
        int queueSize = 0;              ///< 0: fifo's own `queue_size`
        double waitSeconds = -1;        ///< <0: fifo's own `recovery_wait_time`
        int maxAttempts = 0;            ///< 0 is fifo's own "keep trying forever"

        /// Drop rather than block when the queue fills.
        ///
        /// **False is fifo's own default and this application never asks for
        /// it**, which is a refusal with a measured reason rather than a
        /// preference. `fifo_thread_recover` loops on `AVERROR(EAGAIN)` while
        /// `!drop_pkts_on_overflow`, so a destination that never comes up leaves
        /// the consumer thread retrying for ever while the render thread blocks
        /// inside `av_interleaved_write_frame` on a full queue — and `Stop` is
        /// checked once per *output frame*, so it never arrives. Measured: a
        /// four-second render to a closed port with `max_recovery_attempts 2`
        /// ran for twenty seconds without ending and was still running after a
        /// cancel. Blocking is right for a destination that is merely slow and
        /// is left reachable for a spec written by hand; the Write stage offers
        /// only the two dropping modes and says so.
        bool dropOnOverflow = false;
        bool restartWithKeyframe = false;
    };
    FifoSettings fifo;

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

    /// The defaults every video stream takes when its own field is empty. See
    /// `ExportStream` for what each means; they live in both places for the
    /// reason `crf` and `preset` do — a stream list that had to repeat every
    /// setting to say nothing new about it is a list nobody would write.
    std::string forceKeyFrames;
    std::string fieldOrder;
    int threads = 0;                ///< 0 is libavcodec's `auto`
    std::string threadType;

    /// `-shortest`: stop when there is nothing left to render.
    ///
    /// The render's range says how long the output is, and past the end of the
    /// content both `FrameSource`s answer honestly — the track stack with an
    /// empty canvas, the graph with black once its last input has ended. This
    /// says to stop there instead of writing those frames out, which is exactly
    /// what ffmpeg's `-shortest` means one level down: finish the file when the
    /// thing feeding it has finished.
    ///
    /// Off by default, because a range is a decision somebody made and silently
    /// writing less of it than was asked for is the wrong half of the trade.
    bool shortest = false;

    /// `-fps_mode:v`. **Two values, and each of them is a different walk.**
    ///
    ///   - `cfr` (the default, and what every render before this was): the range
    ///     is walked forward at `fps` and each frame is stamped with its number.
    ///     The result is a file every editor accepts, and it is the only thing a
    ///     composited render can honestly claim — `TimelineSource` answers for
    ///     any instant it is asked about, so it has no frame times of its own to
    ///     keep.
    ///   - `vfr`: the frames leave the filter graph with the timestamps
    ///     libavfilter gave them and those timestamps reach the file, on the
    ///     graph's own time base. A frame whose timestamp does not advance is
    ///     **dropped**, which is exactly what ffmpeg's `vfr` means and is what
    ///     separates it from `passthrough` — the difference between the two is
    ///     handing libavcodec a pts that does not move, and that is an encode
    ///     that fails rather than a mode. So `passthrough` is not offered, nor
    ///     `drop` (which throws the timestamps away for the muxer to regenerate
    ///     from the frame rate — `cfr` by another route) nor `auto` (the muxer's
    ///     choice, and there is no CLI here to make it).
    ///
    /// Empty is `cfr`. `vfr` is refused, by name and before a file is opened,
    /// for a render with no filter graph in it, for one that composes nothing,
    /// and for one whose video streams read named pads — several pads leave the
    /// graph at their own moments and one walk has no timestamp to give them all.
    std::string fpsMode;

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

    /// `-filter_hw_device cuda`: the device the *filters* run on.
    ///
    /// Separate from `MediaInput::hwaccel`, and not derivable from it, because
    /// they are different decisions about different objects. An input says
    /// where its packets are decoded; this says which device `hwupload`,
    /// `scale_cuda` and `overlay_cuda` get when they ask the graph for one —
    /// and a graph can perfectly well upload software-decoded pictures, which
    /// is the arrangement where the GPU wins without a hardware decoder being
    /// involved at all. `hwupload` has no argument that could name a device;
    /// libavfilter's answer is the graph's, so this is the only place it can be
    /// said.
    std::string filterHwDevice;

    /// Which one — `-filter_hw_device cuda:1`. The same string
    /// `av_hwdevice_ctx_create` takes and the same one `MediaInput::
    /// hwaccelDevice` is.
    std::string filterHwDeviceIndex;

    /// A render that is more than one render.
    ///
    /// **Empty is one pass, which is every render this application wrote before
    /// there were passes** — the loop runs `passes.size()` times and an empty
    /// list is treated as one entry that overrides nothing, so nothing that
    /// predates this changes shape or behaviour.
    ///
    /// Two things in ffmpeg genuinely need a second run over the same frames
    /// and neither is a feature of this application:
    ///
    ///   - **A two-pass filter.** `vidstabdetect` writes a `.trf` of camera
    ///     motion and `vidstabtransform` reads it; the handoff is a file on
    ///     disk, so the only thing the machinery has to provide is *running the
    ///     graph twice with the file named both times*.
    ///   - **A two-pass encoder.** `-pass 1` writes a statistics log and
    ///     `-pass 2` spends the bitrate knowing where it is needed. The handoff
    ///     is again a file (`-passlogfile`), and what differs between the runs
    ///     is two entries in the option bag.
    ///
    /// So a pass is a *render with overrides*, not a new kind of job: one slot,
    /// one thread, one terminal status, published once when the last pass has
    /// closed its file. Everything the two cases above need is here and nothing
    /// else is, which is what stops this from becoming a second spec format.
    std::vector<ExportPass> passes;

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

/// Is this stream fed by a named output pad of the filter graph, and which?
///
/// Here rather than beside the graph because it is a fact about the *spec* —
/// three files ask it and none of them wants libavfilter's headers for the
/// question. `isCopySource` and `isDecodeSource` live with the machinery that
/// answers them because each of those has machinery; this one is a prefix.
inline bool isPadSource(const std::string& source) {
    return source.rfind("pad:", 0) == 0;
}

/// The label between the brackets, or "" for anything that is not a pad source.
inline std::string padLabelOf(const std::string& source) {
    return isPadSource(source) ? source.substr(4) : std::string();
}

/// What a filter graph can be asked about the pads it ends in.
///
/// Narrow on purpose, and free of libavfilter: what `resolvePads()` below needs
/// to know is which labels exist, which kind each one is, how big a picture pad
/// turned out to be, and which pad — if any — is the one nobody had to name.
/// None of that is a question about *when* frames arrive, which is the whole of
/// what separates the two graphs in this binary: `GraphSource` is pulled by a
/// render walking a range and `CaptureGraph` is pushed by a device that decides
/// for itself when a frame exists. They answer this identically, so `pad:` works
/// in a recording for exactly the reasons it works in a render.
class PadProvider {
public:
    virtual ~PadProvider() = default;

    virtual bool hasPad(const std::string& label) const = 0;
    virtual bool padIsAudio(const std::string& label) const = 0;
    virtual int padWidth(const std::string& label) const = 0;
    virtual int padHeight(const std::string& label) const = 0;

    /// Whether anything says which pad is the composite (or the mix). False
    /// only where the honest answer is that nobody said — several pads of that
    /// kind and none of them labelled `vout` (or `aout`) — in which case a
    /// stream asking for the composite has to be refused by name.
    virtual bool hasComposite() const = 0;
    virtual bool hasMix() const = 0;

    /// Every output pad of a kind, in the order the graph declared them, for a
    /// refusal that has to say what there was instead.
    virtual std::vector<std::string> padLabels(bool audio) const = 0;

    /// Which pads something is going to read by name. Told rather than
    /// discovered, because the difference matters before the first frame: a
    /// sound pad nobody is writing is drained and thrown away as it arrives,
    /// and finding out afterwards that somebody wanted it is too late.
    virtual void readPads(const std::vector<std::string>& labels) = 0;
};

/// Everything about `pad:<label>` that has to be settled before a file is
/// opened: which pad each stream reads, how big it is, and every way of asking
/// for one that cannot work.
///
/// **Here rather than in the writer, because it is the one place that has both
/// halves.** The writer has never heard of a filter graph and the graph has
/// never heard of the stream list; the job holds both, and a refusal belongs
/// where the decision is — which for a label that names no pad means before a
/// muxer has been opened and a header written, not at the first frame.
///
/// It fills in the sizes as well as refusing, and it fills them into
/// `s.streams` rather than into the resolved list: the writer resolves the list
/// again out of the settings, and a size written only into the copy would be a
/// size the encoder is never opened with. Filled by *label* and not by position,
/// so nothing has to know which entries `outputStreams()` dropped.
///
/// **Both jobs call it and the sentences are therefore one set.** A render knows
/// its pad sizes before it starts and a recording does not — the graph is
/// configured from the first frame the device hands over — so the moment differs
/// and the answers must not.
bool resolvePads(ExportSettings& s, PadProvider* graph,
                 const std::vector<ExportStream>& resolved,
                 std::vector<std::string>* reads, std::string* err);

/// The streams this render will actually write, with every default filled in.
///
/// One place, so that nothing downstream has to know whether the caller gave a
/// list or left it to the named fields, and so that "what will be in the file"
/// is a question with an answer before the file is opened. `wantAudio` is the
/// edit's — a timeline with no sound in it gets no audio stream however many
/// the list asks for, which is the rule the writer has always followed.
std::vector<ExportStream> outputStreams(const ExportSettings& s, bool wantAudio);

/// The input an index names, or the one a bare path amounts to.
///
/// One place, for the reason `outputStreams()` is one place: nothing that opens
/// a file should have to know whether the caller wrote an input list or left a
/// path on a clip. An index past the end of the list is a caller's mistake and
/// resolves to the path, which fails the same way a missing file does rather
/// than reading out of bounds.
MediaInput resolveInput(const ExportSettings& s, int index, const std::string& path);

/// The first clip in this render whose `-i` is a **live device**, or -1.
///
/// `TimelineSource` asks a source what it looks like at `inPoint + (t - start) *
/// speed`, and `SourceVideo::rgbaAt` answers by seeking and walking. A device
/// answers neither half of that question: `av_seek_frame` on a libavdevice
/// demuxer returns `Invalid argument` — there is no `read_seek` — and the moment
/// a trim asks for has not happened yet or has gone.
///
/// **Pacing is not the reason, which is worth writing down because it is the
/// obvious guess.** A compositor walk over a device is already on the wall
/// clock, because `av_read_frame` blocks until the device has a frame: measured
/// here with `-f lavfi -i testsrc=…,realtime`, three seconds of output take 3043
/// ms against 80 ms off the same device without the `realtime`, and a clip
/// starting two seconds along the timeline costs 2096 ms for four seconds of
/// output because the reader is opened lazily at the frame the clip appears. So
/// there is no clock to add. What is wrong is the *seek*: the same walk with the
/// clip trimmed one second in takes 3040 ms for two seconds of output, and
/// trimmed three seconds in takes 5061 ms — a trim on a device is a **wait**,
/// exactly its own length, and nothing is written during it. Two seconds of
/// output either way, so the file says nothing about what it cost.
///
/// Refused here rather than approximated, for the reason every refusal in this
/// renderer is: the failure would be a file that plays. A device *feeding the
/// graph* is a different thing and is not this — a `filterInputs` pad is pulled
/// forward and never asked for an instant — so this asks about `clips` alone.
int deviceClip(const ExportSettings& s, const std::vector<ExportClip>& clips);

/// What to say about the clip `deviceClip` found. One sentence for both callers
/// — the render and the preview of it — because two wordings for one clip would
/// read as two different faults.
std::string deviceClipRefusal(const ExportSettings& s, const std::vector<ExportClip>& clips,
                              int at);

/// A snapshot of the running job. Copied under the lock, so the caller can
/// read it at leisure.
struct ExportStatus {
    enum class State { Idle, Running, Done, Failed, Cancelled };

    State state = State::Idle;
    double progress = 0.0;          // 0..1, and meaningless when `openEnded`
    int64_t framesDone = 0;

    /// How many frames this job will write, or **0 for "nobody knows"**.
    ///
    /// The same rule `inputDuration` follows, and for the same reason: zero is
    /// the honest answer for a job with no end, not a number to be papered
    /// over further up. A render always knows; a recording only knows when the
    /// device was given a `-t`.
    int64_t framesTotal = 0;

    /// This job runs until somebody stops it.
    ///
    /// True for a recording with no `-t` — see ffmpeg_capture.h — and true for
    /// nothing else. A render to a URL is *not* open-ended: it walks a range it
    /// knows the length of, and only the destination is a socket, so it sets a
    /// real `framesTotal` like any other render. What a stream cannot say is how
    /// big the result is, which is why `ui/export/progress.js` draws bytes sent
    /// and a bitrate for one rather than reading this field. Anything drawing a
    /// progress bar has to read it: a fraction of an unknown total is zero, and
    /// a bar sitting at zero for ten minutes says the job is stuck.
    bool openEnded = false;

    /// What `framesDone` is counting: **packets of a copy** rather than output
    /// frames.
    ///
    /// It used to be inferable and is not any more, which is the whole reason it
    /// is written down. `framesTotal == 0` meant "this is a copy", because a
    /// render always knew how long it was in frames — and a paced walk
    /// (`fpsMode == "vfr"`) does not: it counts frames it cannot say the number
    /// of in advance. So the two zeroes now mean different things, and a progress
    /// readout reading one as the other says "40 packets copied" about a render
    /// that is encoding pictures.
    bool countingPackets = false;

    double elapsedSec = 0.0;
    double encodeFps = 0.0;         // output frames per second of wall clock

    /// How big it has got. **On disk for a file and sent for a stream**, which
    /// are different facts and the only two available: a socket cannot be
    /// stat'd, and an mp4 that +faststart rewrote is not the write position.
    /// Whoever chose the destination knows which of the two this is.
    int64_t bytesWritten = 0;

    /// How many files the muxer opened **beside** the one it was named with.
    ///
    /// Zero for the render this application has always done — one muxer, one
    /// file, and the file is `path`. It is the segments of an `hls` or a
    /// `segment` render, the chunks of a `dash` one, the numbered pictures of
    /// an `image2` one and the destinations of a `tee`, counted as libavformat
    /// opens them rather than guessed from the filename. A progress readout for
    /// a segmented render has nothing else to count: the frames are the frames,
    /// but what is arriving on disk is files.
    int64_t piecesWritten = 0;

    std::string path;
    std::string error;              // set when state == Failed
    std::string stage;              // what it is doing, for the progress line

    /// Which pass this is, of how many, and what that pass is called.
    ///
    /// One for an ordinary render, which is what makes "pass 1 of 1" the thing
    /// nobody has to draw. `progress` spans the whole job — `((pass - 1) +
    /// this pass's fraction) / passCount` — because the person watching started
    /// one render; `framesDone` and `framesTotal` are this pass's, because they
    /// are what the encoder is actually doing and a count that restarted
    /// halfway would be the confusing one.
    int pass = 1;
    int passCount = 1;
    std::string passLabel;
};

/// Start rendering on a background thread. Returns false — with a reason in
/// `error` — if a job is already running or the settings cannot work.
///
/// The clips are copied: the caller's model is free to change underneath.
///
/// `jobNumber` is which render this one is in the report channel, for a caller
/// that means to read back what it said. It is handed over here because this is
/// the only moment it is unambiguous: `exportStatus().job` is the render running
/// *now*, so it is already zero by the time a caller sees a terminal state.
bool startExport(const ExportSettings& settings,
                 const std::vector<ExportClip>& clips,
                 std::string* error,
                 uint64_t* jobNumber = nullptr);

/// Where the job has got to. Safe to call from any thread, any time.
ExportStatus exportStatus();

/// Ask the job to stop. It finishes the frame it is on, closes the file it
/// was writing and reports Cancelled. Returns immediately.
void cancelExport();

/// Block until the running job has finished, whatever its outcome. For
/// shutdown and for tests; the UI polls instead.
void waitForExport();

} // namespace ffmpegbro
