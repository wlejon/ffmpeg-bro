// One clip's pictures, and one clip's sound.
//
// These own their own demuxers and decoders rather than going through
// bro::video, because export is a different access pattern from playback: it
// walks strictly forward at a fixed output rate, and it needs every clip's
// audio at once to mix. Playback needs neither and needs seeking that playback
// cares about.
//
// A source is per *file* today, taking the best video and the best audio
// stream in it. Choosing a stream — the thing `-map` does, and the thing a
// graph's input node will want to say — is the obvious next parameter on
// open(), and the reason these are one class each rather than one class for
// both: an input with two audio tracks is two SourceAudio, not one that has
// learned about tracks.
//
// **Each of these is walked one way or the other, never both.** `rgbaAt` and
// `mixInto` are the compositor's way: ask for a moment, get what belongs at
// it, already converted. `nextRaw` is a filter graph's: hand over every frame
// as decoded and let the graph do its own converting, because a conversion
// done here would be one the graph then has to undo. The two share a decoder
// and a position in the file, so mixing them within one instance would have
// each stealing frames from the other.
#pragma once

#include "export_frame.h"
#include "ffmpeg_input.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <string>
#include <vector>

namespace ffmpegbro {

/// Walks a file forward, handing back the frame that covers a requested time.
/// Export runs strictly forward at the output frame rate, so the common case
/// is "decode a frame or two and hand it over"; a seek only happens at the
/// start and if the caller jumps.
class SourceVideo {
public:
    ~SourceVideo();

    /// Open an input — a path with a forced demuxer, an option bag and a
    /// window, all of which reach libavformat through `openInput()`.
    ///
    /// `ss` and `-t` are not demuxer options and cannot be: they are arithmetic
    /// on this reader's clock. The input's zero moves to `ss` (so a clip's
    /// in-point is measured from there, which is what makes an input seek a
    /// different thing from a trim), and past `duration` this reader is simply
    /// at the end of the file.
    bool open(const MediaInput& in, std::string* err);

    /// The picture on screen at `t` seconds into the file, as RGBA in display
    /// orientation. Null past the end of the file.
    ///
    /// The conversion is cached against the decoded frame, not the request:
    /// exporting 30 fps from a 60 fps source asks for the same picture twice
    /// and converts it once.
    const Rgba* rgbaAt(double t);

    /// The next frame as it was decoded, in the stream's own pixel format,
    /// with its timestamp rewritten into `timeBase()` units counted from zero
    /// — the clock a clip's in-point and a graph's `trim` are both written
    /// against. Null at the end of the file.
    ///
    /// The frame belongs to this reader and is reused on the next call, so
    /// anything that keeps it has to take its own reference.
    ///
    /// Rotation is *not* applied: the display matrix is reported by
    /// `rotation()` and belongs in the graph, the way `ffmpeg`'s own autorotate
    /// puts it there, so that what runs and what is printed are the same
    /// picture.
    const AVFrame* nextRaw();

    AVRational timeBase() const { return timeBase_; }
    int rotation() const { return rotation_; }

    /// The pool this reader's frames come out of, or null for an ordinary
    /// software decode.
    ///
    /// Only non-null when the input asked for `-hwaccel_output_format`, and
    /// only interesting to the graph path: a buffersrc fed hardware frames has
    /// to be told which pool they belong to before the graph is configured, or
    /// libavfilter negotiates formats for a picture it has never seen. The
    /// compositor never asks, because `rgbaAt` has already brought the picture
    /// down by the time anybody could.
    AVBufferRef* hwFrames() const;

    /// True while frames leave this reader on the device.
    bool onDevice() const { return keepHw_; }

    /// Move the demuxer to `t`, or to the keyframe before it.
    ///
    /// Public because the graph path needs it and `rgbaAt` does not: walking
    /// forward, the reader seeks for itself. A graph is fed raw frames from
    /// wherever they start, so the only thing that knows the window can begin
    /// an hour in is the graph's own `trim`, and only the caller has read it.
    /// It is backward-seeking, so it can land early and never late.
    void seekTo(double t);

private:
    void close();
    double ptsOf(const AVFrame* f) const;
    /// Leave `cur_` holding the last frame at or before `t`.
    bool advanceTo(double t);
    /// Fill `pending_` with the next decoded frame. False at end of file.
    bool decodeOne();

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    InputLoop loop_;
    AVFrame* cur_ = nullptr;
    AVFrame* pending_ = nullptr;
    /// The spare a hardware frame is brought down into. `downloadFrame` swaps
    /// it with `pending_` rather than copying, so one allocation serves the
    /// whole file.
    AVFrame* swap_ = nullptr;
    bool keepHw_ = false;
    SwsContext* toRgba_ = nullptr;
    AVPixelFormat swsFmt_ = AV_PIX_FMT_NONE;
    Rgba raw_, rotated_;
    const Rgba* result_ = nullptr;

    int stream_ = -1;
    int rotation_ = 0;
    AVRational timeBase_{1, 1000};
    double startOffset_ = 0.0;
    double limit_ = 0.0;        // where `-t` ends this input, 0 for the file's end
    double curPts_ = 0.0, pendingPts_ = 0.0, rgbaPts_ = -1.0;
    bool haveCur_ = false, havePending_ = false, haveRgba_ = false;
    bool started_ = false, eof_ = false, drained_ = false;
};

/// Pulled a block at a time at the output rate, so the mixer can ask for
/// exactly the samples one output frame covers and get them sample-accurately
/// from wherever in the file the clip's in-point is.
class SourceAudio {
public:
    ~SourceAudio();

    /// False when the file simply has no audio, which is not an error — a
    /// silent clip is a clip. The input's window applies exactly as it does to
    /// the picture; see SourceVideo::open.
    ///
    /// `speed` is how fast the clip plays, and it is applied by handing `swr` the
    /// file's rate **multiplied by it** as the input rate. That is `asetrate`'s
    /// semantics exactly — the samples are reinterpreted as having been recorded
    /// faster and then resampled back — which is what `ui/graph/derive.js` prints
    /// for the same clip, and why the two paths cannot come to describe different
    /// renders. **It moves the pitch**, because a resample does; the
    /// pitch-preserving answer is `atempo` and there is no graph here to hold one.
    /// Asking libav's resampler for it rather than writing a time-stretcher by hand
    /// is the other half of that: WSOLA is hundreds of lines of DSP libavfilter
    /// already has.
    bool open(const MediaInput& in, int outRate, int outChannels, double speed = 1.0);

    void seekTo(double srcSeconds);

    /// Add `frames` samples of this clip, scaled by `gain`, into `dst`.
    /// Past the end of the file it adds nothing, which is silence.
    ///
    /// There is no `skip()` beside this and there does not need to be: a muted
    /// clip is never given a `SourceAudio` at all (see `TimelineSource`), and
    /// every clip that is given one has its own reader — so there is no second
    /// clip in the same file whose position a skipped run would have to keep.
    void mixInto(float* dst, int frames, float gain);

    /// The next frame as decoded, in the file's own sample format and rate,
    /// timestamped in `timeBase()` units from zero. See the note at the top of
    /// this file: a reader walked this way is not also mixed from.
    const AVFrame* nextRaw();

    AVRational timeBase() const { return timeBase_; }

private:
    /// What rate to tell `swr` the samples arrived at: the file's, times the clip's
    /// speed. One home because `append()` asks twice — once to build the context
    /// and once to size the buffer for what will come out of it — and two answers
    /// there would size a buffer for a different conversion from the one performed.
    ///
    /// **An integer, deliberately.** `asetrate`'s `sample_rate` is an `int`, so the
    /// filtergraph this application prints for the same clip rounds the same way;
    /// an exact rational here would be a render the printed command could not
    /// reproduce, which is the one difference between the two paths that is never
    /// acceptable. The error is under one part in the sample rate.
    int inRate(int fileRate) const {
        const int r = static_cast<int>(fileRate * speed_ + 0.5);
        return r > 0 ? r : (fileRate > 0 ? fileRate : 1);
    }

    void close();
    int available() const;
    void compact();
    /// Leave the next decoded frame in `frame_`. False at end of file.
    bool decodeOne();
    /// Decode one packet's worth into the fifo. False at end of file.
    bool fill();
    /// Resample the decoded frame to the output rate and layout and append it,
    /// dropping whatever sits before the point the last seek asked for.
    void append();

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    InputLoop loop_;
    AVFrame* frame_ = nullptr;
    SwrContext* swr_ = nullptr;
    AVChannelLayout outLayout_{};
    AVSampleFormat swrFmt_ = AV_SAMPLE_FMT_NONE;
    std::vector<float> fifo_;
    size_t head_ = 0;

    int stream_ = -1;
    int outRate_ = 48000, outChannels_ = 2, swrRate_ = 0;
    /// The clip's speed. `swrRate_` stays the *file's* rate — what the decoder
    /// hands over, which is what a resampler has to be rebuilt for when it changes
    /// — and this is the factor applied to it on the way in.
    double speed_ = 1.0;
    AVRational timeBase_{1, 1000};
    double startOffset_ = 0.0;
    double limit_ = 0.0;
    double seekTarget_ = 0.0;
    bool awaitingSeek_ = false, eof_ = false, drained_ = false;
};

} // namespace ffmpegbro
