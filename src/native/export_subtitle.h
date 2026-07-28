// A subtitle stream that is decoded and written again, rather than copied.
//
// **Where the gap was.** This binary has never opened a subtitle decoder. The
// packet path could already carry an existing subtitle track through to the
// muxer — that is `copy:0:2`, and it needs no decoder at all — and burning one
// into the picture is `subtitles=` on the graph, which is libavfilter's job and
// not this file's. What was missing is the third thing: a subtitle stream whose
// *content* comes from somewhere and has to be written in a codec the output
// container will hold. An `.srt` beside a video goes into an mp4 as `mov_text`
// and into Matroska as `ass`; neither is the bytes that were already there.
//
// So this is the decode-and-encode half, and `ExportStream::source` names it:
// `decode:0:2` is input 0's stream 2, read, decoded and handed to this stream's
// own encoder. It is the same `-map 0:2` a copy names — what differs is
// `-c:s`, and that is exactly the difference ffmpeg's own command line draws
// between `-c:s copy` and `-c:s mov_text`.
//
// Four things here are load-bearing:
//
//   - **A cue is not a frame.** There is no output frame rate to walk and no
//     canvas to fill: a subtitle is a sparse list of moments with text on them,
//     arriving on the input's own clock. So this is pumped *beside* the frame
//     loop exactly as `CopyStreams` is, up to the time of the frame just
//     written, which keeps the muxer's interleaving sane without a second
//     sorting stage — and a render whose only stream is a subtitle track has no
//     frame loop at all and is driven by the cues.
//
//   - **Text and pictures are not interchangeable.** `subrip`, `ass`, `webvtt`
//     and `mov_text` carry text; `dvdsub` and `hdmv_pgs_subtitle` carry
//     pictures of text. Turning the second into the first is optical character
//     recognition, which neither this nor ffmpeg does, so the pairing is
//     refused *by name* before anything opens rather than arriving as an
//     encoder failure. libavcodec answers which is which
//     (`AV_CODEC_PROP_TEXT_SUB`); there is no list here.
//
//   - **The decoder's `subtitle_header` is the encoder's.** An ASS file's
//     styles — fonts, colours, margins, the resolution the positions are
//     against — live in the header and not in the cues, so an `ass`→`ass`
//     pass that opened a fresh encoder would keep every line of dialogue and
//     silently throw away how it looks. ffmpeg copies it across for the same
//     reason; so does `Writer::openSubtitleStream`, which is where the encoder
//     lives.
//
//   - **Timestamps are milliseconds and the writer is told so.** An AVSubtitle
//     carries `pts` in `AV_TIME_BASE_Q` and its display times in milliseconds
//     relative to it, and `avcodec_encode_subtitle` refuses a non-zero
//     `start_display_time` outright — the timing goes on the *packet*. So a
//     cue leaves here as two millisecond stamps, the writer stamps the packet
//     with them, and the stream's `srcTimeBase` is `1/1000`: the same rescale
//     an encoder's packets already go through.
#pragma once

#include "ffmpeg_export.h"
#include "ffmpeg_input.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

class Writer;

/// Is this stream decoded out of an input rather than composed or copied?
inline bool isDecodeSource(const std::string& source) {
    return source.rfind("decode:", 0) == 0;
}

/// `decode:0:2` → input 0, stream 2. False when the text is not that shape.
bool parseDecodeSource(const std::string& source, int* input, int* stream);

/// Every decoded subtitle stream of one render, and the demuxers they read.
///
/// One reader per (input, stream) rather than one per input, which is where
/// this differs from `CopyStreams` and why: a subtitle stream is read at its
/// own pace and seeked to its own window, and two subtitle tracks out of one
/// file are two independent walks with nothing between them to keep in sync.
/// There is no A/V relationship to preserve, so there is no reason to pay for
/// one.
class SubtitleStreams {
public:
    ~SubtitleStreams();

    /// `streams` is the resolved list — `outputStreams()`'s answer — so an
    /// index here means the same stream it means in the writer.
    bool build(const ExportSettings& s, const std::vector<ExportStream>& streams,
               std::string* err);

    bool empty() const { return taps_.empty(); }

    /// The decoder feeding output stream `desc`, or null. The writer opens its
    /// encoder against this — for the ASS header, and for the frame size a
    /// `mov_text` box is positioned in.
    const AVCodecContext* decoderFor(size_t desc) const;

    /// Every cue whose place in the output is before `until` seconds, decoded,
    /// re-encoded and written. `until <= 0` means all of them.
    bool pumpTo(double until, Writer& w, std::string* err);

    /// Nothing left: every tap has reached the end of its window or its input.
    bool done() const;

    double position() const { return position_; }

    /// How long the subtitles are, in output seconds, or 0 when nobody knows.
    double span() const { return span_; }

    int64_t cues() const { return cues_; }

private:
    struct Tap {
        size_t desc = 0;
        MediaInput in;
        AVFormatContext* fmt = nullptr;
        AVCodecContext* dec = nullptr;
        AVPacket* pkt = nullptr;
        int stream = -1;

        /// The window of the input this stream takes, on the input's clock —
        /// `copyFrom`/`copyTo`, which mean here what they mean on a copy.
        /// `from` is also the output's zero: a subtitle file whose times are
        /// against the whole programme, taken from ten seconds in, has to come
        /// out ten seconds earlier than it went in or it describes a different
        /// shot.
        double from = 0.0;
        double to = 0.0;

        /// What to subtract from a cue's container timestamp to put it on the
        /// input's clock — the clock `from` and `to` are written against, and
        /// the one the seek is made on. See `cueEpoch`.
        double zero = 0.0;

        double at = 0.0;            ///< where this tap has read to, in output seconds
        bool finished = false;
        ~Tap();
    };

    /// One packet's worth of cues out of one tap, written. Returns false only
    /// on a real failure — running out of input is an ordinary end.
    bool pumpTap(Tap& t, double until, Writer& w, std::string* err);

    std::vector<std::unique_ptr<Tap>> taps_;
    double position_ = 0.0;
    double span_ = 0.0;
    int64_t cues_ = 0;
};

} // namespace ffmpegbro
