// A subtitle stream, drawn — cues painted into pictures so a filter graph can
// have them.
//
// **libavfilter has no subtitle input, and that is the whole reason this file
// exists.** `overlay` cannot consume a subtitle stream, `buffer` takes video
// frames and there is no third source that takes cues. When
// `ffmpeg -filter_complex "[0:v][0:s]overlay"` appears to burn a bitmap track
// into the picture, libavfilter is not the thing doing it: ffmpeg's *CLI* carries
// a mechanism called sub2video (`fftools/ffmpeg_filter.c`) which decodes the
// subtitle packets itself, paints each `AVSubtitleRect`'s palettised bitmap into
// an RGBA frame the size of the video, and feeds those frames to an ordinary
// `buffer` source. This is that mechanism, here, so that a pad on an input node
// can be wired to an `overlay` and the render does what the printed command
// does.
//
// Five things about it are load-bearing.
//
// **A cue is not a frame, so the frames are made up.** A subtitle stream is a
// sparse list of moments; a `buffer` source has to be fed pictures with
// timestamps. So this produces exactly two frames per cue — one painted at the
// moment it appears, one **cleared at the moment it expires** — plus a cleared
// frame at zero, because before the first cue there is nothing on the screen and
// `framesync` needs something at or before the first picture it is syncing
// against. The expiry frame is the part everybody forgets: a graph that is never
// told the cue ended goes on drawing the last picture it was given for the rest
// of the render.
//
// **Nothing is emitted for the gap between cues.** Two frames per cue is
// `overlay`'s own arrangement rather than an economy — `framesync` holds the
// most recent frame of the secondary input and reuses it for every main frame
// until a later one arrives — so a cue that is on screen for a minute is one
// frame and not fifteen hundred. When the cues run out the feed ends, and
// `overlay`'s default `eof_action=repeat` repeats the last frame, which is the
// cleared one.
//
// **The canvas is ffmpeg's rule, not a choice.** A rect's coordinates mean
// nothing without the size they were authored against: the subtitle codec's own
// dimensions where the container recorded them, the largest video stream of the
// *same input* where it did not, and 720×576 where there is neither — which is
// `sub2video_prepare`'s rule written out. Choosing the render's output size
// instead would put a DVD's cues in the wrong place on every render at a
// different size, and the printed command would then be describing a different
// picture from the one produced.
//
// **A text track is refused by name.** `subrip`, `ass` and their family carry
// characters, and painting characters is a text renderer's job — libass's, which
// is what the `subtitles` filter is for. ffmpeg's own sub2video logs "non-bitmap
// subtitle" per cue and draws nothing, which is a render that succeeds and
// produces a picture with no subtitles in it; this refuses when the input is
// opened and says which filter to use instead.
//
// **The clock is the input's, exactly as `SourceVideo`'s is.** A frame leaves
// here stamped in `AV_TIME_BASE` units counted from the input's own zero — after
// its `-ss` — because the pictures it will be overlaid onto are on that clock and
// `framesync` compares the two.
#pragma once

#include "ffmpeg_input.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

#include <string>

namespace ffmpegbro {

/// One input's subtitle stream, as a run of pictures.
///
/// Deliberately not a third branch inside `SourceVideo`: it shares none of that
/// class's machinery — no scaler, no rotation, no `rgbaAt`, no seek-and-walk to
/// a moment — and everything it does have is about cues. What it shares is the
/// *shape* `GraphSource::Feed` reads it through (`open`, `next`, `timeBase`,
/// `seekTo`), which is what makes a subtitle pad one more feed rather than a
/// second kind of graph input.
class SubtitleSource {
public:
    ~SubtitleSource();

    /// Open the input's best subtitle stream — which is what `[0:s]` means on a
    /// command line — and work out the canvas its cues are painted onto.
    ///
    /// False with `*err` set for an input with no subtitle stream and for a
    /// **text** one, which is refused here rather than drawn as nothing. See the
    /// note at the top of this file.
    bool open(const MediaInput& in, std::string* err);

    /// The size of the frames this hands over. Known after `open` and fixed for
    /// the life of the source, because a `buffer` source is configured once.
    int width() const { return width_; }
    int height() const { return height_; }

    /// `AV_TIME_BASE`, which is the unit `AVSubtitle::pts` already arrives in —
    /// so there is one rescale in this file instead of two.
    AVRational timeBase() const { return AVRational{1, AV_TIME_BASE}; }

    /// The next picture: a cue painted, the clear that ends one, or null when
    /// the stream is done with.
    ///
    /// The frame belongs to this source and its buffer is replaced on the next
    /// call, so a caller that keeps it takes its own reference —
    /// `av_buffersrc_add_frame_flags` with `AV_BUFFERSRC_FLAG_KEEP_REF`, which
    /// is what the graph does with every other feed.
    const AVFrame* next();

    /// Skip to the cues at or before `t` seconds on the input's clock. Backward,
    /// like every seek in this renderer, so it can land early and never late.
    void seekTo(double t);

    /// How many cues have been painted. For the report, and for a test that has
    /// to tell "drew nothing" from "there was nothing to draw".
    int64_t painted() const { return painted_; }

private:
    void close();
    /// Decode forward until a cue is painted into `held_`. False at the end.
    bool decodeAhead();
    /// `f` becomes a fully transparent frame of the canvas size, stamped at `at`
    /// seconds. A fresh buffer every time, because the graph is holding a
    /// reference to the last one.
    bool blank(AVFrame* f, double at);
    /// One rect into the frame, clipped to the canvas. This is
    /// `sub2video_copy_rect`: the bitmap is `PAL8` and the palette entries are
    /// already `AV_PIX_FMT_RGB32` words, so a pixel is a lookup and a store.
    void paintRect(AVFrame* f, const AVSubtitleRect* r);

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    /// The `-i` this reads. Kept because a seek is arithmetic on the input's own
    /// window — `inputSeekTarget` needs the `-ss` and the `-itsoffset`, and a
    /// demuxer's seek clock is not its index's clock.
    MediaInput in_;
    int stream_ = -1;
    int width_ = 0, height_ = 0;
    double epoch_ = 0.0;        ///< what to take off a cue's timestamp
    double limit_ = 0.0;        ///< where `-t` ends this input, 0 for the file's end

    AVFrame* cur_ = nullptr;    ///< what `next()` last handed over
    AVFrame* held_ = nullptr;   ///< a cue painted before its turn came
    bool haveHeld_ = false;
    double heldStart_ = 0.0, heldEnd_ = 0.0;
    /// When the cue now on screen expires, or `HUGE_VAL` for one the format did
    /// not time — a `dvdsub` cue with no stop-display command stays until the
    /// next cue replaces it, which is what the format means and not a guess.
    double clearAt_ = 0.0;
    bool clearPending_ = false;
    bool primed_ = false;       ///< the frame at zero has gone
    bool ended_ = false;
    bool warnedOutside_ = false;
    int64_t painted_ = 0;
};

} // namespace ffmpegbro
