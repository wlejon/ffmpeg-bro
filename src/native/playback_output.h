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
// that resizes a clip's picture *below the point where the clip is placed*,
// which the render lays over the canvas at its own size rather than in a
// rectangle — so the viewer, which has only rectangles, refuses it. All three
// are questions about what the *output* is, and the only honest answer to those
// is the output.
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
// **Sound is part of it, and the sound is authoritative.** A preview used to be
// a picture and nothing else, on the argument that the clips underneath were the
// same mix by a cheaper route — true for everything except the thing a preview
// exists for, which is a filter on the *whole programme*: an `-af` chain, a
// `loudnorm`, an `amix` of a generator, none of which any clip element can play.
// So the render's `mixInto` is published here beside its canvas and the element
// plays both.
//
// What that needed was an answer to "what happens when the picture cannot keep
// up and the sound can", and the answer is that **the sound wins**. A soundtrack
// stretched to match a slow render is not the render's soundtrack — it is a
// slower piece of music, and every judgement somebody makes listening to it is
// about the wrong thing. Pictures, by contrast, are droppable: one is what the
// output looks like at an instant, and the instant nearest to now is a true
// answer even when the ones in between were never made. So:
//
//   - the mix is produced for **every** frame of the range, in order, because a
//     gap in sound is audible in a way a missing picture is not;
//   - the *composite* is skipped for a frame the render has arrived at late,
//     which is what makes the sound keep up rather than merely claiming to —
//     the picture is where nearly all of the cost is;
//   - a **graph cannot be skipped**, because libavfilter holds every frame it
//     has pushed at a sink until somebody takes it, so a pull skipped is memory
//     grown rather than work saved. A graph preview too slow for real time
//     therefore gaps its sound, and that is the shape of a pull rather than a
//     decision made here.
//
// **A preview is therefore one render read by two elements, and the render runs
// behind a tap.** That is not a flourish: bro opens a media element's source
// twice — once for the pipeline and once for the audio ring it keeps ahead of
// the mixer — so a source that built a render per open would build two renders
// of the same edit and race them for the same decoders. So a *run* is shared by
// token, publishes into the `LiveTap` (live_tap.h) a live capture session
// publishes into, and both opens read pads of it. Picture: newest wins, which is
// how a picture is dropped. Sound: a bounded queue per listener, which is how a
// block never is.
//
// **The run produces nothing while nobody is asking.** A reader wakes it and the
// demand expires; a preview left paused on screen — which is most of the time a
// preview is on screen — costs what it always cost, nothing. While there *is* a
// listener the queue's room is the pacing (a monitor drains at real time, so the
// render runs at real time and no clock is consulted); with no sound in the
// render there is no such regulator, and the run paces itself at the output rate.
//
// **The clock is the sound's, which is real time.** Pictures are stamped with the
// moment they were published rather than with where they sit in the range, for
// the reason `LiveSource` stamps them that way: an element told a picture is from
// a moment already past will pump for more, and a render slower than real time
// would be asked for frames faster than it can make them for as long as it ran.
// The two numbers are the same whenever the render is keeping up, which is the
// case this is tuned for; when it is not, the picture is older than the playhead
// says and the sound is right, which is this file's whole trade written into one
// timestamp.
//
// **`-fps_mode` is one of the encode-half settings this ignores, and it has to
// be.** A render with `vfr` on it keeps the graph's own frame times *in the
// file*; here there is no file, and what an element is fed is a picture at an
// instant on the sound's clock — see the paragraph above. So this walks the range
// at the output rate whatever the setting says, asking `canvasAt(t)` rather than
// `FrameSource`'s paced pull, and the frame timing of the output is not something
// a monitor could show in the first place. Nothing is being quietly dropped: the
// pictures are the render's pictures either way, and only their stamps differ.
#pragma once

#include "ffmpeg_export.h"
#include "sound_meter.h"

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct AVFrame;

namespace ffmpegbro {

class FrameSource;
class LiveTap;

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
    /// The soundtrack this render would have, which is the shape the preview's
    /// audio track is described from. Zero on both when it has none — and that is
    /// what a reader asks rather than `hasAudio()`, because a track has to be
    /// described before a sample of it has been made.
    int audioRate = 0;
    int audioChannels = 0;
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
///
/// **Settled without its sound**, which is the one thing this does not answer.
/// Building the audio half opens a reader per clip — `TimelineSource`'s
/// constructor does it to be able to answer `hasAudio()` at all — and settling
/// happens on every graph edit, so it would be every file on the timeline opened
/// to be told a number nobody has asked for. What comes back therefore has
/// `audioRate` at zero whatever the render's sound would be; the run below is
/// where that question is asked, once, by something that is about to play it.
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
    ///
    /// `wantSound` decides whether the render is built with its soundtrack, and
    /// it is a parameter rather than always-on because the audio half costs a
    /// reader per clip — see `settleOutput`, which is the caller that passes
    /// false.
    bool open(const OutputView& v, bool wantSound, std::string* err);

    const OutputFacts& facts() const { return facts_; }

    /// One tick of the render: a picture, a block of sound, or both.
    ///
    /// Everything here is **owned by the caller**. The canvas is copied rather
    /// than referenced because the compositor paints the next frame into the same
    /// buffer, and the samples are copied because there is no buffer to reference
    /// — `mixInto` adds into one this provides. See `Wrapped` in
    /// ffmpeg_backend.cpp for who frees them afterwards.
    struct Tick {
        AVFrame* picture = nullptr;  ///< RGBA; null when skipped or past the end
        AVFrame* sound = nullptr;    ///< packed float; null for a silent render
        double at = 0.0;             ///< seconds from the start of the range
        bool done = false;           ///< the range has run out; nothing follows
    };

    /// Render the next tick. `wantPicture` false composites nothing and still
    /// produces the sound, which is how a late render catches up — and it is
    /// honoured only for the compositor: see the note at the top about a graph
    /// having nothing that can be skipped.
    Tick next(bool wantPicture);

private:
    std::unique_ptr<FrameSource> source_;
    OutputFacts facts_;
    int64_t n_ = 0;              ///< the next frame's number in the range
    int64_t total_ = 0;          ///< how many there are, or 0 for "until it stops"
    int64_t samplesDone_ = 0;    ///< of the mix, counted from the start of the range
    std::vector<float> mix_;     ///< one tick's worth, reused
};

// ── One render, shared by everything playing it ────────────────────────────

/// A render running behind a tap: the reader above, driven on a thread of its
/// own, publishing `vout` and — when the render has sound — `aout`.
///
/// **Shared by token**, because bro opens one media element's source twice and
/// two renders of one edit would be two sets of decoders on the same files. Held
/// by `shared_ptr` from every reader, so the last one to let go stops the render;
/// nothing else does, and `forgetOutput` deliberately does not — a token that no
/// longer resolves is about what the *next* element would open.
class OutputRun {
public:
    ~OutputRun();
    OutputRun(const OutputRun&) = delete;
    OutputRun& operator=(const OutputRun&) = delete;

    const OutputFacts& facts() const { return facts_; }
    const std::shared_ptr<LiveTap>& tap() const { return tap_; }

    /// Somebody is waiting for something. The run produces while it is being
    /// asked and idles a quarter of a second after the asking stops, which is
    /// what makes a paused preview free — see the note at the top.
    void wake();

private:
    friend std::shared_ptr<OutputRun> attachOutput(const std::string& src,
                                                   std::string* err);
    OutputRun() = default;
    void loop();

    OutputFacts facts_;
    std::shared_ptr<LiveTap> tap_;
    std::unique_ptr<OutputReader> reader_;
    std::thread thread_;
    std::mutex m_;
    std::condition_variable cv_;
    bool quit_ = false;
    /// When the demand runs out, on the steady clock in milliseconds.
    int64_t until_ = 0;
};

/// The run behind this src, joining one that is already going or starting it.
///
/// Null with `*err` set when the token names no view or the graph will not parse
/// — the same two refusals `OutputReader::open` has, answered here because this
/// is where a source is built.
std::shared_ptr<OutputRun> attachOutput(const std::string& src, std::string* err);

// ── What the render's soundtrack is doing ──────────────────────────────────

/// How loud the render being previewed is, right now.
///
/// **The point of this call is that it is the render's own answer.** A meter beside
/// the viewer could be got at three ways and two of them are wrong: summing the
/// clips' analysed peaks is a waveform with a meter's name on it, and reading bro's
/// master bus gives the *machine's* stereo mix through whatever the monitoring
/// volume is set to. The run above already makes the mix `-af`, `loudnorm` and
/// `amix` produce, at the channel count the encoder will be opened with, and it
/// already publishes it into a `LiveTap`; so it measures it on the way past and
/// this reads the reading. Nothing extra is decoded, and a preview nobody is
/// playing costs what it always cost.
struct OutputLevels {
    /// Is there a render behind this id at all? False is the ordinary answer while
    /// the preview is off, and is not the same as a silent one.
    bool running = false;
    /// Has any sound been through since the last call? False for a render with no
    /// soundtrack *and* for one whose thread is between blocks — told apart by
    /// `rate`, which is zero only for the first.
    bool heard = false;
    int rate = 0;         ///< the mix's sample rate, or 0 for a silent render
    std::vector<ChannelLevel> channels;
};

/// Read it, **and reading clears it** — the rule every level in this binary
/// follows, so there is exactly one caller and it is the meter. Empty for an id
/// nothing is registered under, which is what the UI sees the moment the preview
/// is turned off.
OutputLevels outputLevels(const std::string& id);

} // namespace ffmpegbro
