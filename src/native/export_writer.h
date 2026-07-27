// The output file: encoders, and the muxer they feed.
//
// Everything past the compositor. The canvas arrives as RGBA and leaves as
// packets in a container, and the two interesting properties of that journey
// are both about honesty:
//
//   - **Capabilities are queried, never assumed.** Which pixel format, which
//     sample format, which sample rate: asked of the encoder, because a build
//     without an encoder should say so rather than fail at the last step.
//   - **An option the encoder does not have is an error, not a shrug.** The
//     settings past the codec are `-key value` pairs applied with av_opt_set
//     and AV_OPT_SEARCH_CHILDREN — the same path the ffmpeg command line uses
//     — so anything documented for `ffmpeg -c:v libx265 -x265-params …` works
//     here unchanged, and a render that succeeds while ignoring half of what
//     it was told is the worst of the three outcomes.
//
// One writer is one output file. Two outputs from one render — the thing a
// graph with two encoder nodes describes — is two of these, which is why the
// job owns it rather than the other way round.
#pragma once

#include "export_frame.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <string>

namespace ffmpegbro {

class Writer {
public:
    ~Writer();

    bool open(const ExportSettings& s, bool wantAudio, std::string* err);

    /// Encode one composited canvas. `index` is the output frame number, which
    /// is the whole timestamp: a fixed frame rate is what makes the result a
    /// file every editor will accept.
    bool writeVideo(const Rgba& canvas, int64_t index, std::string* err);

    /// Take mixed interleaved float samples. They are buffered and handed to
    /// the encoder in exactly the frame size it asked for, because AAC wants
    /// 1024 samples at a time and the video loop produces however many one
    /// frame covers.
    bool writeAudio(const float* interleaved, int frames, std::string* err);

    /// Flush both encoders and write the trailer. Called even on a cancelled
    /// render: an mp4 whose trailer never went down has no index and plays
    /// nowhere, so stopping half way still has to leave the part that was
    /// rendered watchable.
    bool finish(std::string* err);

    /// The size on disk, stat'd once the file is closed rather than taken from
    /// the write position: +faststart rewrites an mp4 after the trailer, and
    /// the position left behind reported three kilobytes for a file of three
    /// quarters of a megabyte.
    int64_t bytesSoFar() const;

    int audioSampleRate() const { return aenc_ ? settings_.audioSampleRate : 0; }
    bool hasAudio() const { return aenc_ != nullptr; }

private:
    void close();
    bool openVideo(std::string* err);
    bool openAudio(std::string* err);
    /// Hand the encoder every whole frame the fifo can fill. At the end of the
    /// job `flushTail` takes the short one too.
    bool drainFifo(bool flushTail, std::string* err);
    bool encode(AVCodecContext* ctx, AVStream* st, AVFrame* frame, std::string* err);

    ExportSettings settings_;
    AVFormatContext* oc_ = nullptr;
    AVStream* vstream_ = nullptr;
    AVStream* astream_ = nullptr;
    AVCodecContext* venc_ = nullptr;
    AVCodecContext* aenc_ = nullptr;
    AVFrame* vframe_ = nullptr;
    AVFrame* aframe_ = nullptr;
    AVFrame* aconv_ = nullptr;
    AVPacket* pkt_ = nullptr;
    SwsContext* toEncoder_ = nullptr;
    SwrContext* aswr_ = nullptr;
    AVAudioFifo* afifo_ = nullptr;
    int frameSize_ = 1024;
    int64_t audioPts_ = 0;
    int64_t bytes_ = 0;
    bool headerWritten_ = false;
    bool finished_ = false;
};

} // namespace ffmpegbro
