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
//
// **One file is N streams.** It used to be exactly one video stream and one
// audio stream, with two members for each and `avformat_new_stream` called
// twice in two functions that were nearly the same function. Everything that a
// muxer can hold and this application could not say — a second audio track, a
// language, a disposition, a fourcc, a font travelling beside a subtitle —
// followed from that one assumption, so what is here now is a vector of `Out`,
// each of which is a description (`ExportStream`) plus whatever apparatus its
// kind needs to get a frame into the file. `writeVideo` feeds every video
// stream mapped to the composite and `writeAudio` feeds every audio stream
// mapped to the mix, which is why the job above did not change at all.
#pragma once

#include "export_frame.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/eval.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <cstdio>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

class CopyStreams;

class Writer {
public:
    ~Writer();

    /// `copies` is the render's packet path — the streams fed from a demuxer
    /// rather than from the compositor. It is built *before* this is called
    /// because a copied stream is described to the muxer out of its input
    /// stream's own parameters, and there is nowhere else to get them from.
    /// Null is a render with no copied stream in it, which is nearly all of
    /// them.
    bool open(const ExportSettings& s, bool wantAudio, std::string* err,
              CopyStreams* copies = nullptr);

    /// Encode one composited canvas into every video stream mapped to the
    /// composite. `index` is the output frame number, which is the whole
    /// timestamp: a fixed frame rate is what makes the result a file every
    /// editor will accept.
    bool writeVideo(const Rgba& canvas, int64_t index, std::string* err);

    /// Take mixed interleaved float samples, for every audio stream mapped to
    /// the mix. They are buffered per stream and handed to each encoder in
    /// exactly the frame size it asked for, because AAC wants 1024 samples at a
    /// time and the video loop produces however many one frame covers — and
    /// because two encoders in one file rarely agree on that number.
    bool writeAudio(const float* interleaved, int frames, std::string* err);

    /// One packet of a copied stream, in that stream's *input* time base and
    /// already shifted so that the copy's zero is the file's. It goes through
    /// the same bitstream chain and the same muxer call an encoded packet does
    /// — which is the whole reason the packet path cost so little: `writePacket`
    /// was already codec-agnostic, and a copied stream differs from an encoded
    /// one by where its `srcTimeBase` came from.
    ///
    /// `desc` indexes the resolved stream list — `outputStreams()`'s answer —
    /// which is the same numbering `CopyStreams` was built against.
    bool writeCopiedPacket(size_t desc, AVPacket* pkt, std::string* err);

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

    /// What was written, on disk. A path with a frame-number pattern in it is
    /// a run of files rather than one, so it is measured as one — see the note
    /// in `finish()`.
    static int64_t sizeOnDisk(const std::string& path, int64_t startNumber);

    /// The rate the mixer should produce, which is the render's rather than any
    /// one encoder's: every audio stream resamples from it to whatever it can
    /// take, so two streams at different rates cost one mix and two resamplers.
    int audioSampleRate() const { return hasAudio() ? settings_.audioSampleRate : 0; }
    bool hasAudio() const;

    /// What went into the file, in the order the muxer numbered them — the
    /// resolved list, not the one that was asked for. A stream the build could
    /// not encode is not in it.
    const std::vector<ExportStream>& streams() const { return described_; }

private:
    /// Which output frames are made keyframes, whatever the GOP says.
    ///
    /// `-force_key_frames` is ffmpeg's, not any encoder's: what it does is set
    /// `pict_type = I` on the frame before it goes in, and every encoder that
    /// honours that then starts a GOP there. Both of ffmpeg's forms are here
    /// because they answer different questions — a list of times is "cut here,
    /// here and here", and `expr:` is a rule. **A keyframe where an edit cuts is
    /// what makes a file that can be cut again**, which is the whole reason the
    /// list form matters in this application.
    struct KeyFrames {
        bool on = false;
        std::vector<double> times;      ///< seconds into the output, sorted
        size_t next = 0;
        AVExpr* expr = nullptr;         ///< `expr:`, evaluated per frame

        // ffmpeg's own variables, kept across frames because the expression
        // people actually write — `gte(t,n_forced*2)` — is about the last one.
        double nForced = 0;
        double prevForcedN = -1;
        double prevForcedT = -1;

        bool parse(const std::string& text, std::string* err);
        bool wants(int64_t n, double t);
        ~KeyFrames();
    };

    /// One output stream: its description, the muxer's stream, and whatever a
    /// stream of its kind needs to be fed.
    struct Out {
        ExportStream desc;
        size_t descIndex = 0;           ///< where it sits in the resolved list
        AVStream* st = nullptr;
        AVCodecContext* enc = nullptr;

        /// Packets from a demuxer rather than from an encoder. `enc` is null
        /// for one of these and every loop that feeds encoders steps over it.
        bool copied = false;

        /// The time base the packets arrive in: an encoder's, or the input
        /// stream's for a copy. One field rather than two branches at the
        /// muxer, which is what let the packet path reuse `writePacket` whole.
        AVRational srcTimeBase{1, 1};

        // video
        AVFrame* vframe = nullptr;
        SwsContext* toEncoder = nullptr;
        KeyFrames keys;
        int frameFlags = 0;             ///< interlaced/field order, per frame

        /// The packet chain between this encoder and the muxer — `-bsf:v`.
        /// `av_bsf_list_finalize` folds a whole chain into one context, so what
        /// runs here is what a command line's comma-separated list runs.
        AVBSFContext* bsf = nullptr;
        AVPacket* bsfPkt = nullptr;

        // Two-pass. The handoff between the passes is a file on disk, always,
        // and which file is `-passlogfile` — which is ffmpeg's own option and
        // not the encoder's, so it never reaches av_opt_set.
        std::FILE* statsLog = nullptr;  ///< pass 1, when the encoder does not keep its own
        std::string statsIn;            ///< pass 2, read back and pointed at by the context
        bool statsWritten = false;
        bool ownStatsFile = false;      ///< the encoder has a `stats` option and was given one

        // audio: its own resampler and fifo, because the encoder it feeds has
        // its own sample format, rate and frame size and nothing says two
        // streams in one file agree about any of them.
        AVFrame* aframe = nullptr;
        AVFrame* aconv = nullptr;
        SwrContext* swr = nullptr;
        AVAudioFifo* fifo = nullptr;
        int frameSize = 1024;
        int64_t audioPts = 0;
    };

    void close();
    bool openVideoStream(Out& o, std::string* err);
    bool openAudioStream(Out& o, bool* skipped, std::string* err);
    bool openAttachment(Out& o, std::string* err);

    /// A stream that is the bytes that were already there: the muxer is told
    /// about the *input* stream's parameters, and no encoder is opened at all.
    bool openCopyStream(Out& o, CopyStreams& copies, std::string* err);

    /// Metadata, language, disposition and codec tag — everything the muxer is
    /// told about a stream that is not the bitstream itself.
    bool describeStream(Out& o, std::string* err);
    bool addChapters(std::string* err);

    /// `-bsf:v h264_mp4toannexb,dump_extra` — built, initialised, and the
    /// stream's own parameters taken from what comes out of the far end. A
    /// bitstream filter is allowed to change the extradata and the codec tag,
    /// so the muxer has to be told about the *filtered* stream and not the
    /// encoder's.
    bool openBitstreamFilters(Out& o, std::string* err);

    /// `-pass`/`-passlogfile`. Two options that are ffmpeg's rather than any
    /// encoder's, so they are taken out of the bag before it is applied.
    bool setUpPasses(Out& o, const AVCodec* codec, std::string* err);

    /// Hand one stream's encoder every whole frame its fifo can fill. At the
    /// end of the job `flushTail` takes the short one too.
    bool drainFifo(Out& o, bool flushTail, std::string* err);
    bool encode(Out& o, AVFrame* frame, std::string* err);

    /// One encoded packet through the stream's bitstream chain and into the
    /// muxer. `flush` sends the chain its end-of-stream and drains what falls
    /// out, which is how a filter that buffers gets to write its last packet.
    bool writePacket(Out& o, AVPacket* pkt, std::string* err);
    bool drainBsf(Out& o, std::string* err);

    ExportSettings settings_;
    AVFormatContext* oc_ = nullptr;
    AVPacket* pkt_ = nullptr;
    std::vector<std::unique_ptr<Out>> outs_;
    std::vector<ExportStream> described_;
    int64_t bytes_ = 0;
    bool headerWritten_ = false;
    bool finished_ = false;
};

} // namespace ffmpegbro
