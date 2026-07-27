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
#pragma once

#include "export_frame.h"

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

    bool open(const std::string& path, std::string* err);

    /// The picture on screen at `t` seconds into the file, as RGBA in display
    /// orientation. Null past the end of the file.
    ///
    /// The conversion is cached against the decoded frame, not the request:
    /// exporting 30 fps from a 60 fps source asks for the same picture twice
    /// and converts it once.
    const Rgba* rgbaAt(double t);

private:
    void close();
    double ptsOf(const AVFrame* f) const;
    void seekTo(double t);
    /// Leave `cur_` holding the last frame at or before `t`.
    bool advanceTo(double t);
    /// Fill `pending_` with the next decoded frame. False at end of file.
    bool decodeOne();

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    AVFrame* cur_ = nullptr;
    AVFrame* pending_ = nullptr;
    SwsContext* toRgba_ = nullptr;
    AVPixelFormat swsFmt_ = AV_PIX_FMT_NONE;
    Rgba raw_, rotated_;
    const Rgba* result_ = nullptr;

    int stream_ = -1;
    int rotation_ = 0;
    AVRational timeBase_{1, 1000};
    double startOffset_ = 0.0;
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
    /// silent clip is a clip.
    bool open(const std::string& path, int outRate, int outChannels);

    bool ok() const { return ok_; }

    void seekTo(double srcSeconds);

    /// Add `frames` samples of this clip, scaled by `gain`, into `dst`.
    /// Past the end of the file it adds nothing, which is silence.
    void mixInto(float* dst, int frames, float gain);

    /// Move past `frames` samples without mixing them — what a muted clip
    /// needs so an unmuted one after it in the same file stays lined up.
    void skip(int frames);

private:
    void close();
    int available() const;
    void compact();
    /// Decode one packet's worth into the fifo. False at end of file.
    bool fill();
    /// Resample the decoded frame to the output rate and layout and append it,
    /// dropping whatever sits before the point the last seek asked for.
    void append();

    AVFormatContext* fmt_ = nullptr;
    AVCodecContext* dec_ = nullptr;
    AVPacket* pkt_ = nullptr;
    AVFrame* frame_ = nullptr;
    SwrContext* swr_ = nullptr;
    AVChannelLayout outLayout_{};
    AVSampleFormat swrFmt_ = AV_SAMPLE_FMT_NONE;
    std::vector<float> fifo_;
    size_t head_ = 0;

    int stream_ = -1;
    int outRate_ = 48000, outChannels_ = 2, swrRate_ = 0;
    AVRational timeBase_{1, 1000};
    double startOffset_ = 0.0;
    double seekTarget_ = 0.0;
    bool awaitingSeek_ = false, eof_ = false, drained_ = false, ok_ = false;
};

} // namespace ffmpegbro
