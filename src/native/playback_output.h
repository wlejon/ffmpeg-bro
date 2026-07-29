// The render, on playback — `<video src="/@out/edit">` plays what the export
// would write, made while you watch it.
//
// `FrameSource` (export_timeline.h) answers "what does the output look like at
// t?", and until now the only thing that ever asked was a job with a writer on
// the end of it. This asks the same question for the screen. Nothing is
// encoded, nothing is written, and no job slot is held — a preview is not a
// render, it is the render's own source read by an element.
//
// **Why this exists at all.** The program monitor composites by placing one
// `<video>` per clip, which is free and exact for everything a clip does on its
// own — and cannot show the three things that are not about one clip: a
// generated source with no clip behind it (`testsrc` feeding an `overlay`), a
// filter over the whole canvas (a burn-in after the composite), and a filter
// that changes the size of a clip's picture, which the viewer refuses because it
// places a clip by the rectangle its *source* has. All three are questions about
// what the *output* is, and the only honest answer to those is the output.
//
// Four decisions, each of them about being the render rather than resembling it:
//
// **It is the render's own two sources.** `TimelineSource` where the edit has no
// filters of anybody's on it and `GraphSource` where it does — chosen by the
// same line `runExport` chooses by, which is whether the spec carries a
// `filterGraph`. There is no preview compositor and no third path that could
// come to disagree with the other two.
//
// **A view holds a spec, and a spec is what a render is started from.** The
// caller builds it with `buildSpec()` exactly as it builds the one it hands
// `render.start`, so a preview cannot describe a render the application would
// not perform. What it changes is the encode half, which is ignored here — there
// is no writer to be opened, so the codec, the container and the path go
// unread.
//
// **It plays forward from where its range begins, and the caller owns the
// seek.** `GraphSource` pulls: a filter graph produces the frames it produces,
// in order, and `t` is not used to find one — so there is no seeking inside a
// graph, only building one whose inputs begin where you want to start. The
// caller already knows how to do that (it is what a node preview does), so
// moving the playhead is a *redefinition*, and the token carries the range so
// that a new range is a new src and therefore a new source. `seekTo` is refused
// for the same reason `LiveSource` refuses it: forward is the only direction
// there is.
//
// **Sound is not part of it.** A preview is a picture of the render, and the
// sound you are listening to is the timeline's own — which is the same mix by a
// cheaper route, since a clip element plays at the clip's volume and the
// compositor sums exactly those. So `includeAudio` is turned off before the
// source is built, which is not a saving at the margin: `TimelineSource` opens
// an audio reader per clip in its constructor to answer `hasAudio()`, and a
// preview that asked would open every file on the timeline to hand the samples
// to nobody. What this does cost is that a filter on the *mix* is not heard,
// which the manual says.
#pragma once

#include "ffmpeg_export.h"

#include <memory>
#include <string>
#include <vector>

struct AVFrame;

namespace ffmpegbro {

class FrameSource;

/// A render, registered so that an element can be pointed at it.
///
/// The two halves of what `render.start` is given, and nothing else: a spec and
/// the clips it composites. Held by value for the reason `PlaybackView::input`
/// is — a view outlives nothing, and resolving anything by reference later would
/// make its meaning depend on the order two registries were written to.
struct OutputView {
    ExportSettings settings;
    std::vector<ExportClip> clips;
};

// ── The registry ───────────────────────────────────────────────────────────
//
// The input registry's shape (ffmpeg_input.h) and the view registry's
// (playback_filter.h), for the third time and for the same reason: `<video src>`
// is a string, so a render has to be part of what is being played rather than a
// parameter of playing it. Process-global and mutex-guarded because a Worker is
// another realm on another thread and reaches the same backend.

/// Register (or replace) a render under `id`. Returns the token to hand a
/// `<video>` as its src.
///
/// **The token carries the range**, not just the id: an element holds the source
/// it opened, so a redefinition under a token that did not change would leave
/// the picture playing the render as it used to be. Moving the playhead is a
/// change of range, which is therefore a change of src, which is a new source —
/// see the note at the top about who owns the seek.
std::string defineOutput(const std::string& id, const OutputView& v);

/// Forget one. Nothing already playing is disturbed — a source holds what it
/// resolved — and a token that no longer resolves opens as the literal string it
/// is, which fails the way a missing file does.
void forgetOutput(const std::string& id);

/// Token → view. False when `src` is not one of ours, which is the ordinary
/// case.
bool resolveOutput(const std::string& src, OutputView* out);

// ── What the render turns out to be ────────────────────────────────────────

/// The picture a view produces, for a caller that has to decide something before
/// it points an element at one.
struct OutputFacts {
    int width = 0;        ///< the canvas size — the graph's, where it says
    int height = 0;
    double fps = 0.0;
    double start = 0.0;   ///< where on the timeline the first frame sits
    double length = 0.0;  ///< seconds of it, 0 for a range with no end
    bool graph = false;   ///< libavfilter's answer rather than the compositor's
};

/// Build the source, say what it produces, and throw it away again.
///
/// **The expensive half of a view, done on purpose and only when asked.** A
/// graph that will not parse is the interesting case: it is a message worth
/// putting in front of somebody the moment they wire something impossible, and
/// an element pointed at a token that fails to open is a black rectangle and a
/// line in a log. `defineOutput` deliberately does *not* call this — a spec
/// changes on every drag and settling one opens every input the graph reads —
/// so the caller settles when it is about to show the picture and not before.
///
/// False with `*err` set for a graph libavfilter refuses, in its own words.
bool settleOutput(const OutputView& v, OutputFacts* facts, std::string* err);

// ── One render, read a frame at a time ─────────────────────────────────────

/// The render's `FrameSource`, driven forward at the output rate.
///
/// The other half of what `runExport`'s frame loop does, with the writer taken
/// off the end — and deliberately not shared with it: that loop also carries
/// passes, stream copies, named pads, `-shortest` and the hardware path, none of
/// which a picture on the screen has any use for. What *is* shared is the source
/// itself, which is the only part either of them could get wrong.
class OutputReader {
public:
    OutputReader();
    ~OutputReader();
    OutputReader(const OutputReader&) = delete;
    OutputReader& operator=(const OutputReader&) = delete;

    /// Build the source for this view. False with `*err` set for a graph that
    /// will not parse.
    bool open(const OutputView& v, std::string* err);

    const OutputFacts& facts() const { return facts_; }

    /// The next picture, as an RGBA frame **owned by the caller**, or null once
    /// the range has run out.
    ///
    /// A copy of the compositor's canvas rather than a reference into it: the
    /// source owns one buffer and overwrites it on the next call, and what this
    /// hands back travels through a packet queue that outlives the call. It is
    /// one frame in flight, not a queue of them — see `Wrapped` in
    /// ffmpeg_backend.cpp for who frees it.
    ///
    /// `*at` is seconds from the start of the range, which is the element's own
    /// clock; the timeline moment is `facts().start + *at`.
    AVFrame* next(double* at);

private:
    std::unique_ptr<FrameSource> source_;
    OutputFacts facts_;
    int64_t n_ = 0;        ///< the next frame's number in the range
    int64_t total_ = 0;    ///< how many there are, or 0 for "until it stops"
};

} // namespace ffmpegbro
