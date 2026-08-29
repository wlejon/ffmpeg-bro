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
//   - **The in-point decides the file's zero, and the first packet only moves
//     it earlier** — one zero per input rather than one per stream. Two streams
//     copied out of one file keep the offset between them that they had, which
//     is the whole of A/V sync; a zero taken per stream would silently move a
//     soundtrack by however far the video's first keyframe was from the audio's
//     first packet. The packet has to be able to move it because the seek lands
//     at or before what was asked for; it must not move it *later*, which is
//     what taking it alone did to a subtitle track whose first packet is its
//     first cue a minute in.
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

#include <deque>
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

/// Where one stream's own packet clock starts, in seconds.
///
/// **A packet clock is not a frame clock, and this is where that bites.** The
/// rest of this renderer measures an input from the container's `start_time`,
/// which is where the first *picture is presented*. A packet carries a decode
/// timestamp, and for anything with B-frames in it the first one is the reorder
/// delay *earlier* — two frames, 80 ms at 25 fps, in every mp4 this application
/// writes. Measured the container's way, the first keyframe of the fixture came
/// out at −0.08 s, fell outside a window starting at zero, and the second
/// keyframe of the file was offered as the first place a cut could start.
///
/// So a copy counts from the stream's own first packet — which is the demuxer's
/// index entry zero where there is an index, and `start_time` where there is
/// not. `st->start_time` alone is not enough: an mp4's edit list puts it at
/// zero while the packets still begin at −0.08, which is the whole of the bug
/// above. The result is that a copy's clock and the file it writes agree — a
/// cut at 2 s starts 2 s in and the output starts at zero — and that the
/// keyframes a UI snaps to are the numbers the render seeks to.
///
/// **Exported for the one caller outside the packet path**, which is
/// `cueTextOf` (export_subtitle.h): the words of a cue are drawn against the
/// list `cueTimesOf` produced, so the two have to be on one clock or a panel
/// joining them by time joins nothing. `cueEpoch` — the clock a *render* places
/// cues on — is the other question and is documented where it lives.
double streamZero(AVStream* st, const MediaInput& in);

/// Where a copy can start: one stream's keyframes, on the input's own clock.
///
/// A fact about the input and not about the render, which is why it is a query
/// and not something the job hands back. It is asked of the demuxer's index
/// where there is one — instant, and exact — and by reading packets where there
/// is not, which costs the window and says so. `complete` is false when the
/// answer was cut short by `max`, by `budgetMs` or by the scan not reaching
/// `to`, because a list of keyframes that quietly stops is a list somebody
/// would snap to the wrong end of.
///
/// **`budgetMs` is the only bound that is about the caller rather than about
/// the file, and it exists because `max` turned out not to bound anything a
/// person can feel.** A scan is a read, and a read of a *remote* input is a
/// download: a six-hour Twitch VOD asked for its default 4000 keyframes is two
/// and a quarter hours of H.264 fetched over HTTPS, which measured **158
/// seconds** with the window frozen for every one of them — this call is
/// synchronous and the Write stage makes it while drawing. Bounding the count
/// harder would not have helped, since what is unbounded is the seconds each
/// entry costs and that is a property of the connection. So the walk carries a
/// deadline, stops on it, and says the list was cut short in the one field that
/// already meant exactly that. Zero or less is no deadline, which is what the
/// native callers and the tests pass; the JS binding defaults it, because
/// everything reaching this from JS is on the drawing thread.
struct KeyframeList {
    int stream = -1;
    std::string how;            ///< "index" or "scan"
    bool complete = false;
    double from = 0.0, to = 0.0;
    std::vector<double> times;  ///< seconds on the input's clock, ascending
};

bool keyframesOf(const MediaInput& in, int stream, double from, double to, int max,
                 int budgetMs, KeyframeList* out, std::string* err);

/// Where a subtitle track's cues are, on the input's own clock.
///
/// The packet path's answer to `keyframesOf` above, and the same kind of fact:
/// something about the *input* that a decision on the Write stage has to be
/// taken against, read without opening anything that decodes. **A subtitle
/// packet is a cue** — one moment with a payload on it, timed by the demuxer —
/// so when the words are on screen is knowable without knowing what they are.
///
/// Not decoded, and that is the point rather than an economy. A `dvdsub` track
/// cannot become text and cannot be burned in; *when* it is on screen is the
/// one thing anybody can say about it, and an answer that needed a decoder
/// would have nothing to say about half the subtitle tracks there are.
///
/// `from` and `to` bound what is **listed**, and not what a copy would take.
/// A copy seeks backward and then carries the cue that was on screen when it
/// was asked to start — so a caller asking what a window costs asks for the
/// whole track and compares, and a window here that meant the copy's would hide
/// the one cue the comparison is about.
///
/// There is no index shortcut, unlike the keyframes: an index answers "which
/// packets are keyframes" and every subtitle packet is one, so what is wanted
/// here is the packets themselves. That costs a read of the file up to `to` —
/// every other stream discarded in the demuxer, so a 1080p sibling costs only
/// its bytes — which is why `from`/`to` are worth passing and why `complete`
/// exists.
///
/// `Cue::end` is `start` plus the packet's duration and **equals `start` where
/// the container did not record one**. An `.srt`, Matroska and `mov_text` all
/// carry it; a format that puts the end inside the payload — a `dvdsub`
/// bitmap's stop-display command — does not. Equal ends mean "the packets do
/// not say", which is a different answer from "no time at all".
///
/// `Cue::bytes` is the payload's size, and it is carried for one case: mp4's
/// `mov_text` writes a sample *between* the cues as well as on them — an empty
/// one, two bytes of zero length — so an mp4's subtitle track has packets where
/// nothing is on screen and a count of packets is not a count of lines.
///
/// The epoch is `streamZero`'s, which is the one a *copy* is measured against,
/// because this is the packet path. `cueEpoch` in export_subtitle.cpp is the
/// conversion's, and the two differ only where a container genuinely starts
/// late (mpegts); its doc comment is where that difference is written down.
struct Cue {
    double start = 0.0;
    double end = 0.0;   ///< == start when the packets do not time the end
    int bytes = 0;
};

struct CueTimes {
    int stream = -1;
    bool complete = false;
    double from = 0.0, to = 0.0;
    std::vector<Cue> cues;  ///< seconds on the input's clock, in the order read
};

/// `budgetMs` bounds the read in wall time exactly as `keyframesOf`'s does, and
/// for the same reason: there is no index shortcut here at all, so *every* call
/// is the scan, and a subtitle track inside a remote container costs the whole
/// container's bytes to walk. Zero or less is no deadline.
bool cueTimesOf(const MediaInput& in, int stream, double from, double to, int max,
                int budgetMs, CueTimes* out, std::string* err);

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

        /// Every live tap this packet belongs to, which is usually one and is
        /// not always. `-map 0:1 -map 0:1` is a legal thing to ask for — two
        /// rows out of one input stream differing only in their disposition —
        /// and a single pointer here silently gave every packet to one of them
        /// and left the other stream in the file empty.
        std::vector<Tap*> pendingTaps;
        bool eof = false;
        bool haveEpoch = false;
        int64_t epochUs = 0;        ///< the input's zero, container clock

        /// Is any tap of this reader a *window* rather than the whole input?
        ///
        /// It decides two things together, and they are two halves of one rule:
        /// which streams may pull the zero back before the moment asked for
        /// (video only) and whose packets before it are dropped (everything
        /// else). A whole-file copy sets neither and keeps every packet there
        /// is. Settled in `prime`, where the reasoning is.
        bool trimsHead = false;

        /// Packets read while settling the epoch, waiting to be handed out.
        ///
        /// The epoch cannot be chosen from the first packet alone (see `prime`),
        /// so the ones read to find it have to be kept rather than dropped —
        /// they are the beginning of the copy.
        std::deque<AVPacket*> primed;

        std::vector<Tap> taps;
        ~Reader();
    };

    /// Settle `r.epochUs` before a single packet is written. Reads ahead.
    void prime(Reader& r);

    /// The next packet off this reader, from `primed` first. False at the end.
    bool readOne(Reader& r, AVPacket* into);

    /// Leave `r.pending` holding the next packet that belongs to a live tap.
    void fill(Reader& r);
    double outSecondsOf(const Reader& r, const AVPacket* pkt) const;

    std::vector<std::unique_ptr<Reader>> readers_;
    size_t count_ = 0;
    double position_ = 0.0;
    double span_ = 0.0;
    int64_t packets_ = 0;
};

} // namespace ffmpegbro
