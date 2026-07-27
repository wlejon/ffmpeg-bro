// An input is an `-i`, not a file on a timeline.
//
// Every `avformat_open_input` in this binary used to be handed `nullptr,
// nullptr` for the format and the options, which meant three things this
// application could not say. No demuxer could be forced, so a file that probes
// wrong probed wrong for good. Nothing could set `-probesize` or
// `-analyzeduration`, which is the first thing anybody reaches for when it
// does. And an input could only ever be a path that arrived on a drop — a URL
// was unreachable although this build links openssl and srt and reports
// thirty-six input protocols.
//
// So an input is a thing now, and this is what one is: what is opened, how it
// is opened, and which part of it is used. It is deliberately *not* a clip —
// several inputs may exist with nothing on the timeline using them, and an
// input seek is not a clip in-point.
//
// **Two consumers, one struct.** The renderer is given the whole list in its
// spec and resolves each clip's index against it. Playback cannot be: bro's
// `<video>` takes a src string and the media backend is registered generically,
// so an input reaches it through the registry at the bottom of this file — the
// element is handed a token naming the input, and the backend swaps the token
// for the real URL and its options on the way into libavformat. See CLAUDE.md
// for why that is a token rather than the path itself.
#pragma once

#include <string>
#include <vector>

struct AVFormatContext;
struct AVPacket;

namespace ffmpegbro {

/// One `-key value` pair, exactly as the ffmpeg command line would take it.
///
/// One struct for every bag of ffmpeg arguments in this binary: the demuxer's
/// here, the encoder's and the muxer's through the `ExportOption` alias in
/// ffmpeg_export.h. They are applied the same way — `av_opt_set` /
/// `AVDictionary` — and an unknown key is an error in all of them.
struct KeyValue {
    std::string key;
    std::string value;
};

/// One `-i`.
///
/// Everything here appears *before* the `-i` on a command line, which is not a
/// piece of trivia about argument order: these are the decisions taken while
/// the file is being opened, and none of them can be taken afterwards.
struct MediaInput {
    /// The path or URL `-i` is given. A local file, or anything a protocol in
    /// `bro.ffmpeg.protocols.input` can reach — `https://`, `srt://`, `udp://`.
    std::string path;

    /// The demuxer, forced: `-f mov` before `-i`. Empty lets libavformat probe,
    /// which is right nearly always and wrong in exactly the cases this field
    /// exists for — a raw stream with no header to probe, a container whose
    /// first bytes lie, a device.
    std::string format;

    /// Demuxer and protocol options. `-probesize`, `-analyzeduration`,
    /// `-fflags`, and every private option of the demuxer and of the protocol
    /// the URL names, since libavformat passes what it does not recognise down
    /// to the AVIO layer.
    ///
    /// **An unknown key is an error, not a shrug.** `avformat_open_input`
    /// hands back the entries nothing consumed, and this is the one place in
    /// libav where "was that option used?" has a real answer — so it is asked.
    std::vector<KeyValue> options;

    /// `-ss` before `-i`: where this input starts. The input's clock is
    /// rewritten so that this instant is its zero, which is what makes it a
    /// different thing from a clip's in-point — trimming a clip picks a moment
    /// out of an input, and this decides what the input *is*.
    double ss = 0.0;

    /// `-t`: how much of the input is used, from `ss`. Zero is all of it.
    /// `-to` is the same decision stated as an end time; the UI converts.
    double duration = 0.0;

    /// `-itsoffset`: shift this input's timestamps. Positive delays it — the
    /// picture arrives later — which is how a camera and a separately recorded
    /// soundtrack are lined up.
    double itsoffset = 0.0;

    /// `-stream_loop`: how many *more* times to read this input after the
    /// first. 0 is once through, -1 is forever.
    ///
    /// This is the one thing in this struct libavformat has never heard of.
    /// `-framerate`, `-start_number`, `-pattern_type` and `-loop` — everything
    /// that makes a numbered run of files or a single still into an input —
    /// are options of the `image2` demuxer and travel in the bag above, which
    /// is why an image sequence needed nothing added here. Looping a *stream*
    /// is not: ffmpeg's own CLI implements it by seeking the input back to the
    /// start when it ends and shifting every timestamp forward by one pass,
    /// and `InputLoop` below is this binary's one copy of that arithmetic.
    int streamLoop = 0;

    bool operator==(const MediaInput& o) const {
        return path == o.path && format == o.format && ss == o.ss &&
               duration == o.duration && itsoffset == o.itsoffset &&
               streamLoop == o.streamLoop && sameOptions(o);
    }

private:
    bool sameOptions(const MediaInput& o) const {
        if (options.size() != o.options.size()) return false;
        for (size_t i = 0; i < options.size(); ++i)
            if (options[i].key != o.options[i].key ||
                options[i].value != o.options[i].value) return false;
        return true;
    }
};

/// Open one input, the way its `-f` and its option bag say to.
///
/// Everything that opens a demuxer in this binary goes through here, so there
/// is one place where a forced format is looked up, one place where the option
/// bag becomes an `AVDictionary`, and one place where an option nothing
/// consumed becomes a refusal naming the key. `avformat_find_stream_info` is
/// run too, because every caller then does it and a probe that has not run it
/// answers about a container rather than about a file.
///
/// On failure `*err` says what and `*out` is left null.
bool openInput(AVFormatContext** out, const MediaInput& in, std::string* err);

/// The window `openInput` did not apply: the reader's own clock, in seconds.
///
/// `ss` and `itsoffset` are not demuxer options — libav has no idea about
/// either — so they are arithmetic on whatever reads the file. This is the one
/// implementation of that arithmetic: the offset to subtract from a container
/// timestamp so that the input's zero is where the input says it is.
double inputEpoch(const MediaInput& in, double containerStart);

/// Where this input ends on its own clock, or 0 for "at the end of the file".
double inputLimit(const MediaInput& in);

/// True when this input goes on producing frames for as long as it is asked to.
///
/// `-loop 1` on an image and `-stream_loop -1` on anything make an input with
/// no length of its own: libavformat reports one pass — for a still, one frame
/// — and everything above the model believes it, because everything above the
/// model was written when a duration was a fact discovered by probing.
///
/// It is not a fact here. **`-t` is the only thing that can say how long such
/// an input is, and it is a decision rather than a measurement**, which is
/// exactly why it lives on the input beside the options that made it endless
/// and is not invented somewhere further up to make a timeline comfortable.
/// `probeMedia` and the playback source both ask this before believing a
/// container's duration; see `inputDuration`.
bool inputIsEndless(const MediaInput& in);

/// How long this input is, given what the container said its own length was.
///
/// One rule in one place, because a clip's length comes from it and the
/// timeline, the renderer and playback each ask separately. Three cases:
///
///   - an ordinary input is as long as it measured, cut down by the window;
///   - a finite `-stream_loop` is that length over again a known number of
///     times, which is measurable and is measured;
///   - an input that never ends — `-loop 1`, `-stream_loop -1` — has `-t` as
///     the whole of its length, and **zero when there is no `-t`**. Zero means
///     nobody knows, which is the honest answer and not a number to paper over.
double inputDuration(const MediaInput& in, double containerDuration);

/// `-stream_loop`, folded into the packet read.
///
/// Three things in this binary read packets — the two export readers and the
/// playback source — and looping is arithmetic on timestamps rather than a
/// demuxer feature, so without a shared implementation each would get it
/// slightly differently and a soundtrack would end up shifted by a different
/// amount from the picture it belongs to.
///
/// A pass is as long as the container says, or as long as the furthest packet
/// seen if it will not say — which is what makes this work on the formats that
/// report no duration at all.
class InputLoop {
public:
    /// What the input asked for, and how long one pass is. Safe to call with
    /// `streamLoop == 0`, where every call below is `av_read_frame` verbatim.
    void configure(AVFormatContext* fmt, const MediaInput& in);

    bool looping() const { return passes_ != 1; }

    /// `av_read_frame`, plus the seek back and the timestamp shift when a pass
    /// ends and another is owed. Returns libav's own code, so `AVERROR_EOF`
    /// still means the input has genuinely ended.
    int read(AVFormatContext* fmt, AVPacket* pkt);

    /// Where a seek to `seconds` on the input's continuous clock actually
    /// lands: which pass it is in, and the moment within that pass. Call before
    /// seeking and seek to `*within` instead.
    void seekTo(double seconds, double* within);

private:
    int64_t passes_ = 1;      ///< total passes; 0 is forever
    int64_t done_ = 0;        ///< passes finished
    int64_t shift_ = 0;       ///< AV_TIME_BASE units added to every timestamp
    int64_t passLen_ = 0;     ///< AV_TIME_BASE units, 0 until something is known
    int64_t furthest_ = 0;    ///< the end of the furthest packet seen, same units
};

// ── The playback registry ──────────────────────────────────────────────────
//
// `<video src>` is a string and the media backend is registered generically,
// so the only way an input's options can reach playback is for the string to
// name the input. `defineInput` returns the token to hand the element;
// `resolveToken` is what the backend calls on the way in.
//
// Process-global and mutex-guarded, because a Worker is another realm on
// another thread and `bro.media`'s filmstrip decode runs there against the
// same inputs.

/// Register (or replace) an input under `id`. Returns the token to use as a
/// `<video>` src, a `bro.media` path, or anywhere else bro takes a media path.
std::string defineInput(const std::string& id, const MediaInput& in);

/// Forget one. Nothing already open is disturbed; a token that no longer
/// resolves opens as the literal string it is, which fails the way a missing
/// file does.
void forgetInput(const std::string& id);

/// Token → input. False when `src` is not one of ours, which is the ordinary
/// case: a plain path stays a plain path.
bool resolveToken(const std::string& src, MediaInput* out);

/// The token for an id, without registering anything. One place that knows the
/// shape of the string.
std::string inputToken(const std::string& id);

} // namespace ffmpegbro
