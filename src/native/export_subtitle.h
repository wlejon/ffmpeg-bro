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
// So this is where a subtitle decoder lives, and there are two things in this
// file that open one. The first is the render's own decode-and-encode path,
// described below. The second is `cueTextOf` at the bottom — what a cue *says*,
// for the Write stage's cue list — which is the same decoder opened for a
// question rather than for an output, and closed again before it answers.
//
// The render half, and `ExportStream::source` names it:
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

// ── What a cue says ────────────────────────────────────────────────────────
//
// `cueTimesOf` (export_copy.h) answers *when* the cues of a track are, off the
// packets, without opening anything that decodes — which is why it answers for
// a `dvdsub` track as readily as for an `.srt`. This is the other half of the
// question and it is a different query with a different cost, deliberately, and
// not a column the first one forgot to fill in:
//
//   - **It costs a decoder per track.** A cue's words are inside its payload
//     and only libavcodec can get them out, so this opens one, walks the
//     window, and **closes it before it returns**. Nothing in this binary holds
//     a subtitle decoder open: a probe must not pay for one (every input is
//     probed, most of them have no subtitle track and none of the callers of
//     `probe()` want words), and holding one for the life of the process would
//     keep a demuxer and a decoder alive for a panel nobody is looking at. The
//     UI's side of the same decision is that it caches the answer while the
//     Write stage is up and drops it on the way out — see `cueTextFor` in
//     ui/export/subtitles.js.
//   - **For a bitmap codec there is nothing to read, and that is the answer.**
//     `dvdsub` and `hdmv_pgs_subtitle` carry pictures of characters, so the
//     honest answer is not an empty list of words but "this track has none,
//     because it is `dvdsub`" — which is what `CueText::text` and
//     `CueText::codec` are for. No decoder is opened in that case at all: the
//     question is settled by `AV_CODEC_PROP_TEXT_SUB` before anything is read,
//     which is the same property that decides whether such a track can be
//     converted or burned in.
//   - **It answers twice about the same cue, and the second answer is the one
//     that can be given back.** `CueLine::text` is what a person reads and it
//     is lossy by design — the eight leading fields and every `{\i1}` are gone,
//     because a column of override codes is worse than a column of nothing.
//     `CueLine::raw` is the dialogue line exactly as the decoder handed it over
//     and `CueText::header` is that decoder's `subtitle_header`, and between
//     them they are everything an `.ass` file needs to be written again: the
//     styles, the resolution the positions are against, and per cue its layer,
//     its style, its margins and its overrides.
//
//     That pair exists because of what `ui/cues.js` does with the answer.
//     Taking a file's cues into the document to edit them is a **fork**, and a
//     fork through `text` alone would silently flatten somebody's styled
//     subtitles the moment they retimed one line — losing work, quietly, which
//     is the one failure this whole path is arranged against. With `raw` a cue
//     nobody retyped is written back byte for byte, and a cue somebody did
//     retype loses its own overrides and keeps its style, which the UI says out
//     loud per cue. The alternative — a second reader that kept the payload —
//     would be two decoders and two answers about one track.
//
// **The clock is the packets', which is `cueTimesOf`'s.** These are the same
// cues that list describes, and the panel draws one against the other, so a
// second epoch here would be a panel that lines nothing up. `streamZero` is
// therefore the epoch and `cueEpoch` — the clock a *render* places cues on — is
// deliberately not, for the reason its own doc comment gives.

/// One cue's words, and the line they came out of.
struct CueLine {
    double start = 0.0;
    double end = 0.0;      ///< == start where nothing timed the end
    std::string text;      ///< the words, with ASS override codes taken out
    /// The dialogue line verbatim — `ReadOrder,Layer,Style,…,Effect,Text` —
    /// or empty for a decoder that handed over a plain-text rect instead.
    ///
    /// **The first ASS rect's, and only the first.** No text decoder in this
    /// build produces two of them for one cue; joining two dialogue lines would
    /// have to invent a line neither of them is, since a `,` inside one is a
    /// field separator. A second rect's *words* are still in `text`, which is
    /// what the panel draws, so nothing is hidden — what cannot be written back
    /// exactly is a shape nothing here produces.
    std::string raw;
};

/// What a subtitle track says over the window asked for — or why it says
/// nothing.
///
/// `complete` is false when the walk was cut short by `max`, for the reason
/// `KeyframeList::complete` exists: a list that quietly stops is one somebody
/// reads the end of as the end of the track.
struct CueText {
    int stream = -1;
    std::string codec;      ///< libavcodec's own name for what the track turned out to be
    bool text = false;      ///< `AV_CODEC_PROP_TEXT_SUB`: is there anything to read at all
    bool complete = false;
    double from = 0.0, to = 0.0;
    /// The decoder's `subtitle_header`, which is an ASS script's `[Script
    /// Info]`, `[V4+ Styles]` and the `[Events]` `Format:` line — everything a
    /// cue's fields are written *against*. Empty for a bitmap track, which
    /// opens no decoder, and for one whose decoder declares none.
    ///
    /// This is the same buffer `Writer::openSubtitleStream` memcpys into the
    /// encoder, and for the same reason: an ASS file's look lives in the header
    /// and not in the cues, so an `ass`→`ass` pass that dropped it would keep
    /// every line of dialogue and silently throw away how it appears. One home
    /// for that fact; if the copy there changes, this has to.
    std::string header;
    std::vector<CueLine> cues;
};

/// The cues of one subtitle stream, decoded, over `[from, to]` seconds of the
/// input's own clock. `stream < 0` takes the best subtitle stream there is;
/// `max <= 0` is 500 cues, which is already more than any panel draws and is a
/// tenth of what the packet walk allows itself, because this one decodes.
///
/// False with `*err` set only for a stream that is not there or is not
/// subtitles. A track with no words in it is a true answer, not a failure.
bool cueTextOf(const MediaInput& in, int stream, double from, double to, int max,
               CueText* out, std::string* err);

/// The words out of one ASS dialogue line, which is what every text subtitle
/// decoder in libavcodec produces.
///
/// **A rect's `ass` field is a line of dialogue, not a line of text**: eight or
/// nine comma-separated fields and then the words, which may themselves contain
/// commas — so the split is by counting fields from the front and never by
/// taking the last one. Two shapes exist and both are handled: the modern
/// `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text` that every
/// decoder in this build emits, and the older `Dialogue: Layer,Start,End,…`
/// with the event's own prefix, which is what a file's `[Events]` section holds
/// and what an older libavcodec handed over.
///
/// Then the **override codes come out**: `{\i1}`, `{\pos(120,400)}`, `{\fad…}`
/// are instructions to the renderer and printing them in a column whose whole
/// purpose is the words would be worse than printing nothing. `\N` and `\n`
/// become newlines and `\h` a space, which is what they are. An unterminated
/// `{` takes the rest of the line with it, because that is what libass does
/// with one and this column is meant to say what would be drawn.
std::string assDialogueText(const std::string& line);

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
