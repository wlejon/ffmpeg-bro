// A filter, on playback — what makes the viewer show the picture the render
// will make rather than the one the file happens to hold.
//
// Everything else in this application already runs the filters somebody put on
// the graph: the export runs them, the export preview runs them, and a node's
// own card on the Graph stage renders them. The *viewer* could not, and the
// reason was structural rather than an omission — playback is bro's `<video>`
// decoding a file, and there is no filtergraph anywhere in that path. So a clip
// with an `eq` on it played back exactly as it was shot and only looked right
// once the render had run.
//
// This is the filtergraph put into that path, and the shape of it is decided by
// where it had to go. bro's `<video>` takes a **string**, the media backend is
// registered generically, and a `MediaSource` hands over **packets** — so a
// filter cannot be a parameter of playing something. It has to be part of what
// is being played. Hence a *view*: an input, plus the chain each of its streams
// goes through, registered under an id and named by a token the element is
// pointed at. It is the same trick, and the same registry shape, as
// `defineInput` one file over — for the same reason, written out there.
//
// **The frames leave as `wrapped_avframe`.** A filtered stream has nothing to
// compress and inventing an encode to undo would be absurd; this backend
// already carries decoded frames through the packet path for `-f lavfi` inputs
// and for live capture pads, and the pairing that makes it safe
// (`TrackPrivate::wrapped`, `Wrapped` in ffmpeg_backend.cpp) is the same one.
// A filtered stream is therefore one more producer of frames-as-packets and not
// a new mechanism.
//
// Three decisions worth knowing before changing anything here.
//
// **The filters see the render's clock, not the file's.** `enable=` names a
// moment on the timeline — `between(t,5,10)` is five seconds into the *edit* —
// and a clip half an hour into a recording would otherwise switch its filter on
// half an hour late. So `PlaybackView::shift` moves each frame onto the output
// clock on the way in and takes it back off on the way out. It is a number and
// not two `setpts` filters because the chain that runs has to be the chain that
// was asked for: a chain with something of ours spliced into it is a chain whose
// libavfilter error messages name filters nobody wrote.
//
// **Rotation moves into the graph**, because that is where the render puts it.
// A display matrix is metadata, and `GraphSource` inserts `transpose` between
// the reader and the graph so the filters work on the picture the right way up.
// Playback normally leaves rotation to bro — `TrackInfo::rotationDegrees` — and
// a filtered track cannot: `crop=iw/2` means one thing on a portrait picture and
// another on the landscape frames the decoder produces. So the turn is prepended
// to the chain here and the track reports no rotation of its own.
//
// **A view is settled before anything is pointed at it.** `settleView` opens the
// input, builds the graph and reports what it turned out to produce — because
// the answer decides what the caller does, and a `<video>` that fails to open is
// a black rectangle with the reason in a log nobody reads. A chain that will not
// parse is a refusal with libavfilter's own words in it, and a chain that
// changes the size of the picture is one the viewer says it cannot show rather
// than showing at the wrong size: the program monitor places a clip by the
// rectangle its *source* has, and a filter that resizes the picture would be
// drawn into a rectangle the render never puts it in.
#pragma once

#include "ffmpeg_input.h"

#include <string>

struct AVChannelLayout;
struct AVFilterContext;
struct AVFilterGraph;
struct AVFormatContext;
struct AVFrame;
struct AVPacket;
struct AVCodecContext;

namespace ffmpegbro {

/// An input, and what its streams go through on the way to the screen.
///
/// Deliberately *not* a field on `MediaInput`: an input is an `-i`, a filter is
/// not, and a view over an input is a third thing that names one. Two views of
/// one input — the same footage with and without a `hue` on it — are two
/// registrations and one demuxer's worth of options, which is exactly what
/// keeping them apart buys.
struct PlaybackView {
    /// What is opened, with everything an `-i` carries. Held by value rather
    /// than as an input id because a view outlives nothing and resolving twice
    /// would make a view's meaning depend on the order two registries were
    /// written to.
    MediaInput input;

    /// The chain the picture goes through, in `-vf` syntax: `eq=contrast=1.4`,
    /// `hue=s=0,unsharp`. Empty leaves the stream alone, and a stream left
    /// alone is not decoded — its packets reach the element exactly as they do
    /// without a view at all, which is what keeps a sound-only filter from
    /// costing a video decode.
    std::string video;

    /// The same for the sound, in `-af` syntax.
    std::string audio;

    /// Seconds to add to a frame's clock before the filters see it, and to take
    /// off again afterwards. Where a clip sits on the timeline minus where it
    /// is cut from — see the note at the top about `enable=`. Zero is the file's
    /// own clock, which is right for anything with no time in it.
    double shift = 0.0;
};

// ── The registry ───────────────────────────────────────────────────────────
//
// Exactly the shape of the input registry in ffmpeg_input.h, and process-global
// and mutex-guarded for the same reason: a Worker is another realm on another
// thread and reaches the same backend.

/// Register (or replace) a view under `id`. Returns the token to hand a
/// `<video>` as its src.
std::string defineView(const std::string& id, const PlaybackView& v);

/// Forget one. Nothing already playing is disturbed — a source holds what it
/// resolved — and a token that no longer resolves opens as the literal string
/// it is, which fails the way a missing file does.
void forgetView(const std::string& id);

/// Token → view. False when `src` is not one of ours, which is the ordinary
/// case.
bool resolveView(const std::string& src, PlaybackView* out);

/// The token for an id, without registering anything. One place that knows the
/// shape of the string.
std::string viewToken(const std::string& id);

// ── What a view turns out to be ────────────────────────────────────────────

/// What came out of the graph once it was built, for a caller that has to
/// decide something before it points an element at the view.
struct ViewFacts {
    bool video = false;      ///< the input has a picture stream and it filtered
    int width = 0;           ///< the size the *chain* produces, not the file's
    int height = 0;
    int sourceWidth = 0;     ///< what went in, the right way up
    int sourceHeight = 0;
    bool audio = false;
    int sampleRate = 0;
    int channels = 0;
};

/// Open the input, build the chains, and say what they produce.
///
/// The expensive half of a view, done once and on purpose: it opens the file
/// and decodes a frame per filtered stream, because the formats a graph
/// negotiates are not knowable from the container — a decoder does not always
/// know its own pixel format until it has decoded something, and no part of
/// libavfilter will say what a chain produces until it has been configured with
/// real formats at the top.
///
/// False with `*err` set for a chain that will not parse, a chain that ends
/// somewhere the screen cannot read (a picture still on a card), or an input
/// that will not open. The message is meant to be shown, so it is libav's own
/// sentence — "Option not found" — and the line naming the filter and the
/// option is in the report beside every other libav message.
bool settleView(const PlaybackView& v, ViewFacts* facts, std::string* err);

/// Settle a view and register it under `id`, in one call — and **settle it only
/// when the answer could have changed**.
///
/// What a chain produces is decided by the input and by the chains. `shift` is
/// a clock, and moving a filter's idea of what time it is cannot change the
/// size of the picture coming out of it — a `crop` whose `enable=` is off still
/// negotiated the cropped size when the graph was configured. So a view
/// re-registered under the same id with the same input and the same chains
/// keeps the facts it already had and opens nothing.
///
/// That is not an optimisation for its own sake: a clip dragged along the
/// timeline changes its `shift` on every mouse move, and settling opens the
/// file and decodes a frame. The rule is stated here, once, rather than left
/// for each caller to guess at.
///
/// `*token` is the src to hand a `<video>`. False with `*err` set leaves the id
/// registered as whatever it was.
bool defineSettled(const std::string& id, const PlaybackView& v, ViewFacts* facts,
                   std::string* token, std::string* err);

// ── One stream, decoded and filtered ───────────────────────────────────────

/// A decoder and a linear filter chain, driven a packet at a time.
///
/// Linear because that is what a stream is: one input pad at the top, one
/// output pad at the bottom, and `avfilter_graph_parse_ptr` is the entry point
/// libavfilter provides for exactly that shape. The render's `parseFilterGraph`
/// is the other one — several inputs, several outputs, and a device to hand to
/// the filters that need one — and neither is a special case of the other.
/// **There is no hardware path here.** `-filter_hw_device` has nowhere to be
/// said on a `<video>` src, so a chain that wants a device is refused in
/// libavfilter's own words rather than half-supported.
///
/// The graph is built from the *first decoded frame* and rebuilt after a seek.
/// Rebuilt rather than flushed because libavfilter has no flush: a filter with
/// state — `tblend`, `deshake`, anything with a `setpts` in it — carries the
/// moment before the seek across it otherwise, which shows up as one wrong
/// frame at every scrub and is precisely the sort of thing nobody would think
/// to look for.
class StreamFilter {
public:
    StreamFilter();
    ~StreamFilter();
    StreamFilter(const StreamFilter&) = delete;
    StreamFilter& operator=(const StreamFilter&) = delete;

    /// Open the decoder for `streamIndex` of `fmt` and remember what to build.
    /// Nothing is parsed yet — see the note above about the first frame.
    ///
    /// `rotation` is the display matrix in degrees; it becomes `transpose`
    /// filters in front of the chain and is the caller's cue to report none.
    /// `shift` is seconds added to the stream's own timestamps before the
    /// filters see them and taken off again after — the caller composes it out
    /// of where the clip sits on the timeline and where the input's zero is,
    /// because both of those are the caller's arithmetic and neither is this
    /// class's business. See `PlaybackView::shift`.
    bool open(AVFormatContext* fmt, int streamIndex, const MediaInput& in,
              const std::string& chain, int rotation, double shift, std::string* err);

    /// Which stream of the container this filters. `settleFilter` needs it to
    /// know which packets are for it.
    int index() const { return index_; }

    /// Has the graph been built? False until a frame has been decoded, which is
    /// why `settle` exists.
    bool ready() const { return graph_ != nullptr; }

    /// Feed one packet of this stream, or null for end of stream. Frames come
    /// out of `take` afterwards; a packet can produce none, one or several.
    bool push(const AVPacket* pkt, std::string* err);

    /// The next filtered frame, or null. The caller owns what it gets and frees
    /// it — for the playback path that is the `Wrapped` payload's deleter.
    AVFrame* take();

    /// Throw away the decoder's and the graph's state. Called after a seek; the
    /// graph is rebuilt from the first frame that arrives afterwards.
    void reset();

    // What the graph settled on. Meaningless until `ready()`.
    int width() const { return width_; }
    int height() const { return height_; }
    int format() const { return format_; }
    int sampleRate() const { return sampleRate_; }
    int channels() const;
    const AVChannelLayout* layout() const { return layout_; }
    bool audio() const { return audio_; }

    /// The size that went into the chain, the right way up — what the file
    /// would have shown with no view on it. Kept so a caller can ask whether the
    /// chain changed the shape of the picture without opening the file twice.
    int sourceWidth() const { return srcW_; }
    int sourceHeight() const { return srcH_; }

private:
    bool build(const AVFrame* first, std::string* err);
    /// Everything the decoder is holding, into the graph. Separate from `push`
    /// because `avcodec_send_packet` answers EAGAIN when the decoder is full,
    /// and the packet that got that answer has to be offered again afterwards —
    /// dropped instead, it is a picture missing from the middle of a chain.
    bool drain(std::string* err);

    AVCodecContext* dec_ = nullptr;
    AVFilterGraph* graph_ = nullptr;
    AVFilterContext* src_ = nullptr;
    AVFilterContext* sink_ = nullptr;
    AVFrame* frame_ = nullptr;   ///< what the decoder fills
    /// The layout the sink settled on, owned here because a caller describing
    /// the track needs it after this class has stopped being on the stack.
    AVChannelLayout* layout_ = nullptr;

    std::string chain_;
    int rotation_ = 0;
    double shift_ = 0.0;
    bool audio_ = false;
    int index_ = -1;
    /// The stream's time base, which is the clock the graph is fed on, and the
    /// sink's, which is the clock frames come back on. Not always the same one:
    /// a chain with an `fps` in it renumbers.
    int tbNum_ = 0, tbDen_ = 1;
    int outNum_ = 0, outDen_ = 1;
    int frNum_ = 0, frDen_ = 1;
    int width_ = 0, height_ = 0, format_ = -1;
    int srcW_ = 0, srcH_ = 0;
    int sampleRate_ = 0;
};

/// Read packets until `f` has built its graph. The one place that knows how a
/// filter is got going, because two callers need it and doing it twice is how
/// they come to disagree about what an unfilterable stream is.
///
/// False with `*err` set when the stream ends without producing a frame, which
/// for a picture stream means a file with no picture in it.
bool settleFilter(AVFormatContext* fmt, StreamFilter& f, std::string* err);

} // namespace ffmpegbro
