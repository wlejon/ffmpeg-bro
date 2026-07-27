// A stream that is not encoded: the packets that were already there.
//
// Everything else in this renderer decodes, composites and encodes. A copied
// stream does none of it — the bytes in the input are the bytes in the output,
// and what happens in between is a demuxer, a timestamp rescale, optionally a
// bitstream filter, and a muxer. That is what makes a rewrap instant, a cut
// lossless, and replacing a soundtrack cost nothing to the picture.
//
// **The seam it attaches at is `ExportStream::source`.** `composite` and `mix`
// are composed sources with no input index, because they are everything stacked;
// `copy:0:1` is `-map 0:1`, one input and one stream in it. The writer branches
// on the prefix and the job asks this to keep the packets flowing.
//
// Four things about the packet path are load-bearing:
//
//   - **A copy can only start at a keyframe.** `seekTo` is
//     `AVSEEK_FLAG_BACKWARD`, so the copy begins at or *before* what it was
//     asked for and never skips a frame. What that costs is the difference
//     between the in-point asked for and the keyframe found, and it must be
//     visible rather than discovered afterwards — which is what `keyframesOf`
//     below exists for. This is exactly ffmpeg's own **input** seek
//     (`-ss` before `-i`), and the distinction matters: an *output* seek
//     (`-ss` after the `-i`) with `-c copy` reads the file from the beginning
//     and then drops packets, which is slower and starts the file on a frame
//     nothing can decode.
//   - **The first packet decides the file's zero**, and it is one zero per
//     input rather than one per stream. Two streams copied out of one file keep
//     the offset between them that they had, which is the whole of A/V sync; a
//     zero taken per stream would silently move a soundtrack by however far the
//     video's first keyframe was from the audio's first packet.
//   - **Timestamps are rescaled and never invented.** A packet arrives in its
//     input stream's time base and leaves in the output stream's, which is what
//     `Writer::writePacket` already did for an encoder's packets — a copied
//     stream sets `srcTimeBase` from its input instead of from an encoder and
//     goes through the same call.
//   - **A copied stream cannot be filtered, scaled, cropped or mixed.** There is
//     no picture to work on; there are packets. Every refusal that follows from
//     that belongs where the decision is taken — on the Write stage — and the
//     ones here are the ones only libav can answer: a stream that is not there,
//     a kind that disagrees, a codec the muxer will not hold.
#pragma once

#include "ffmpeg_export.h"
#include "ffmpeg_input.h"

extern "C" {
#include <libavformat/avformat.h>
}

#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

class Writer;

/// Is this stream fed from a demuxer rather than from the compositor?
inline bool isCopySource(const std::string& source) {
    return source.rfind("copy:", 0) == 0;
}

/// `copy:0:1` → input 0, stream 1. False when the text is not that shape, which
/// is a caller's mistake and is reported as one rather than guessed at.
bool parseCopySource(const std::string& source, int* input, int* stream);

/// Where a copy can start: one stream's keyframes, on the input's own clock.
///
/// A fact about the input and not about the render, which is why it is a query
/// and not something the job hands back. It is asked of the demuxer's index
/// where there is one — instant, and exact — and by reading packets where there
/// is not, which costs the window and says so. `complete` is false when the
/// answer was cut short by `max` or by the scan not reaching `to`, because a
/// list of keyframes that quietly stops is a list somebody would snap to the
/// wrong end of.
struct KeyframeList {
    int stream = -1;
    std::string how;            ///< "index" or "scan"
    bool complete = false;
    double from = 0.0, to = 0.0;
    std::vector<double> times;  ///< seconds on the input's clock, ascending
};

bool keyframesOf(const MediaInput& in, int stream, double from, double to, int max,
                 KeyframeList* out, std::string* err);

/// Every copied stream of one render, and the demuxers they read.
///
/// One reader per input, however many streams are taken from it: that is what
/// `-i` means, and it is what makes the zero above one zero. Built before the
/// writer is opened, because the writer describes a copied stream to the muxer
/// out of the input stream's own parameters and there is nowhere else to get
/// them from.
class CopyStreams {
public:
    ~CopyStreams();

    /// `streams` is the resolved list — `outputStreams()`'s answer — so that an
    /// index here means the same stream it means in the writer.
    bool build(const ExportSettings& s, const std::vector<ExportStream>& streams,
               std::string* err);

    bool empty() const { return count_ == 0; }

    /// The input stream feeding output stream `desc`, or null. The writer's
    /// copy of `avcodec_parameters_copy` reads this.
    const AVStream* streamFor(size_t desc) const;

    /// Write every packet whose place in the output is before `until` seconds.
    /// `until <= 0` means all of them, which is what the end of a render asks
    /// for once the frame loop has stopped.
    bool pumpTo(double until, Writer& w, std::string* err);

    /// Nothing left to copy: every tap has reached its end or its input has.
    bool done() const;

    double position() const { return position_; }

    /// How long the copy is, in output seconds, or 0 when nobody knows — the
    /// same rule an endless input follows.
    double span() const { return span_; }

    int64_t packets() const { return packets_; }

    /// Where the copy actually began, on the input's clock: the keyframe the
    /// seek landed on, which is at or before the in-point that was asked for.
    /// Meaningful only once something has been read.
    double startedAt() const { return startedAt_; }

private:
    struct Tap {
        size_t desc = 0;        ///< index into the resolved stream list
        int stream = -1;        ///< the stream in the input
        double from = 0.0;
        double to = 0.0;        ///< 0 is the end of the input
        double zero = 0.0;      ///< where this stream's own packet clock starts
        bool finished = false;
    };

    struct Reader {
        MediaInput in;
        AVFormatContext* fmt = nullptr;
        AVPacket* pending = nullptr;
        bool havePending = false;
        const Tap* pendingTap = nullptr;
        bool eof = false;
        bool haveEpoch = false;
        int64_t epochUs = 0;        ///< the first packet's dts, container clock
        std::vector<Tap> taps;
        ~Reader();
    };

    /// Leave `r.pending` holding the next packet that belongs to a live tap.
    void fill(Reader& r);
    double outSecondsOf(const Reader& r, const AVPacket* pkt) const;

    std::vector<std::unique_ptr<Reader>> readers_;
    size_t count_ = 0;
    double position_ = 0.0;
    double span_ = 0.0;
    double startedAt_ = 0.0;
    bool started_ = false;
    int64_t packets_ = 0;
};

} // namespace ffmpegbro
