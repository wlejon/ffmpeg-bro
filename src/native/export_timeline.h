// The edit, as something that answers "what does the output look like at t?"
//
// This is the seam between *what to render* and *how to write it*. The job
// above it owns a clock and a writer and knows nothing about clips; this owns
// clips and knows nothing about encoders. What passes between them, per output
// frame, is the canvas and a block of the mix — and, for a render whose graph
// produces more than one thing, whatever *named pads* the stream list asked
// for besides.
//
// **That seam is where a node graph attaches**, and now does: `FrameSource`
// below is what the job asks written down, `TimelineSource` is the track
// stack's answer, and `GraphSource` in export_graph.h is libavfilter's. The job
// asks nothing else of either, which is why adding the second one left
// `runExport` a walk over frames with one line changed.
//
// **Two of the three questions are about an instant and one is not.** "What does
// the output look like at t" is the whole of a fixed-rate render and the only
// thing a track stack can answer, because it composites the edit wherever it is
// asked to. A filter graph is the other way round: its frames arrive when the
// graph is ready and carry timestamps of their own, and a walk that asks it for
// an instant is imposing a grid on times that already existed. So `FrameSource`
// grew a *paced* pull beside the instant one — `pacedClock` and `nextFrame`
// below — which answers "no" by default and is what `-fps_mode vfr` is made of.
//
// Sources are opened lazily, on the frame a clip first appears. A two-hour
// timeline of a hundred clips would otherwise open a hundred files, and their
// decoders, before writing a frame.
#pragma once

#include "ffmpeg_export.h"

extern "C" {
// For `AVRational` alone, which `pacedClock()` below answers with. A clock is a
// pair of integers and libavutil already has the name for one; two ints here
// would be a second spelling of `AVRational` for the writer to convert back.
#include <libavutil/rational.h>
}

#include <memory>
#include <string>
#include <vector>

struct AVBufferRef;
struct AVFrame;

namespace ffmpegbro {

struct Rgba;
class ClipSources;

/// What the job asks, and nothing else. Whatever answers it can be rendered.
///
/// Deliberately narrow: every widening of this is a thing the job has to know
/// about the edit, and the job's whole claim is that it knows nothing about
/// the edit. Three of the questions are the whole of the ordinary render — is
/// there sound, what does the canvas look like at `t`, what does it sound like
/// between here and the next frame — and everything below them is optional,
/// answers "no" by default, and exists because one kind of source can say
/// something the track stack cannot.
class FrameSource {
public:
    virtual ~FrameSource() = default;

    /// Whether this render has sound. Asked before the first frame because it
    /// decides whether the file gets an audio track at all, which has to be
    /// settled before the header goes down.
    virtual bool hasAudio() const = 0;

    /// The output frame at `t` seconds on the timeline. Owned by the source
    /// and valid until the next call.
    virtual const Rgba& canvasAt(double t) = 0;

    /// Add `frames` samples covering [from, from + frames/rate) into `dst`,
    /// which the caller has zeroed.
    virtual void mixInto(float* dst, double from, int frames, int rate, int channels) = 0;

    /// Is there anything left to render at `t`, or is the rest of the range
    /// going to come out empty?
    ///
    /// Only asked when `-shortest` is on, and only *after* `canvasAt(t)` — the
    /// graph does not find out that its last input has ended until it has tried
    /// to pull a frame, so a question asked before would always be one frame
    /// behind and would write the black frame it was meant to prevent. The
    /// default is "there is always more", which is the honest answer for
    /// anything that has not been taught to say otherwise.
    virtual bool exhausted(double t) const { return false; }

    // ── the other things a render produces ─────────────────────────────────
    //
    // A filter graph can end in more than one pad, and each of them is a
    // picture or a sound in its own right: a 6400-wide screen grab split by
    // `crop` into two halves is two streams of the output file and neither of
    // them is the canvas. `ExportStream::source` names one as `pad:<label>`,
    // and these two are how the job asks for it.
    //
    // Optional, and false/null by default, because the track stack has no such
    // thing — a timeline produces one canvas and one mix, and a render that
    // asked it for a pad is a spec the job refuses long before a frame is
    // written. Nothing that predates this changes shape.

    /// This tick's picture for a named output pad, converted to RGBA.
    ///
    /// **Only meaningful straight after `canvasAt(t)` for the same `t`**: one
    /// tick advances every pad together, because they come out of one graph
    /// and pulling them at different moments would put a stream's frames out
    /// of step with the canvas they were made beside. Black once that pad's
    /// branch has ended, which is the convention `canvasAt` already follows;
    /// null for a label that names no pad, which is a caller's mistake and is
    /// refused before the render starts.
    virtual const Rgba* padAt(const std::string& label) { return nullptr; }

    /// The same as `mixInto`, for a named output pad rather than for the mix.
    /// False when there is no such pad, so a caller can tell "no sound here"
    /// from "no such thing".
    virtual bool padMixInto(const std::string& label, float* dst, double from, int frames,
                            int rate, int channels) {
        return false;
    }

    // ── the picture that never came down ───────────────────────────────────
    //
    // Two calls, and they are the whole of what "encoding straight from the
    // GPU" needs from this seam. A source that decodes on a device, filters on
    // it and hands the last pad to a hardware encoder has a picture that is
    // never pixels anybody can touch — so `canvasAt`, whose answer is an RGBA
    // buffer in system memory, is the wrong question to ask it. Asking anyway
    // is what every render did before this and is what the readback *is*.
    //
    // Deliberately optional rather than a second interface. The default answers
    // are "no frames context" and "nothing", which is the truth for the track
    // stack and for every graph that ends in software, so nothing that predates
    // this changes shape and the job keeps one loop.

    /// The pool the pictures leaving this source belong to, or null when they
    /// are ordinary memory. Asked once, before the writer opens, because an
    /// encoder that is going to take frames from a pool has to be opened
    /// against that pool — `avcodec_open2` builds its surfaces from it.
    virtual AVBufferRef* hwFrames() const { return nullptr; }

    /// The output frame at `t`, exactly as it left the source: on the device
    /// when that is where it was made. Null once there are no more, which on
    /// this path ends the render — there is no black frame to write, because
    /// black would have to be uploaded and the point of the path is that
    /// nothing is.
    ///
    /// Only called when `hwFrames()` said yes *and* the writer agreed to take
    /// them; `canvasAt` remains the question for every other render.
    virtual const AVFrame* nativeAt(double t) { return nullptr; }

    // ── the source that keeps its own time ─────────────────────────────────
    //
    // `canvasAt(double t)` asks for an instant, and that is the right question
    // for two of the three things that ask it: `playback_output.h` wants a
    // picture at the playhead to hand a `<video>`, and `ffmpeg_capture.h`'s
    // recording walk is the wall clock, which is constant by definition. The
    // job's own walk is the third, and it is the only one for which "at t" is a
    // *decision* rather than the question — it steps t forward at the output
    // rate and stamps each frame with its number, which is what makes a file
    // constant frame rate and is `-fps_mode cfr`.
    //
    // **Frames leaving a libavfilter sink carry timestamps of their own**, and
    // throwing them away is what made `cfr` the only honest value here. A graph
    // holding an `fps`, a `select`, a `framestep` or a
    // `minterpolate` produces frames at moments that are not the output grid,
    // and re-numbering them slows the picture down or speeds it up by exactly
    // the ratio of the two rates. So the four calls below are the paced pull:
    // *the source says when its next frame is, instead of being asked for an
    // instant.*
    //
    // Optional, and answering "no" by default, exactly as `exhausted`,
    // `nativeAt` and `padAt` do — and for the same reason. `TimelineSource`
    // composites the edit at whatever instant it is handed: it can answer for
    // *any* t, so there is no set of times of its own for it to pass through,
    // and a multi-clip composite has no answer to "whose timestamps?" that is
    // not invented. A compositor-driven render therefore stays `cfr` and a
    // spec asking otherwise is refused by name in `startExport`, rather than
    // being quietly given the grid it asked to be let off.
    //
    // The picture is read *after* `nextFrame` and by the two `…Now` calls, not
    // by `canvasAt`/`nativeAt`: those advance the source, which on this walk has
    // already happened. `padAt` needs no twin — it never advanced anything.

    /// The clock this source's own frame times are on, or `{0, 1}` for a source
    /// that has none.
    ///
    /// `{0, 1}` — the default — is the whole of "no": the job checks it before
    /// the first frame and walks the range at the output rate instead. It is
    /// asked once, before the writer opens, because a stream that will carry the
    /// source's own timestamps has to have its *encoder* opened on this clock:
    /// stamped into a `1/fps` time base every frame would quantise straight back
    /// onto the grid and the file would be constant-rate while claiming not to
    /// be.
    virtual AVRational pacedClock() const { return AVRational{0, 1}; }

    /// Advance to the next frame this source makes, and say when it is.
    ///
    /// False once there are no more, which ends the walk. `*pts` is on
    /// `pacedClock()` and is the source's own — unshifted, so the job is the one
    /// place that decides where the output's zero is.
    virtual bool nextFrame(int64_t* pts) { return false; }

    /// The picture the last `nextFrame` handed over, as RGBA. Null when there is
    /// none, which the job treats as the end of the walk rather than as black:
    /// on this path a frame exists because the source said so.
    virtual const Rgba* canvasNow() { return nullptr; }

    /// The same picture exactly as it left the source — on the device when that
    /// is where it was made. The paced twin of `nativeAt`, for the render whose
    /// pictures never come down.
    virtual const AVFrame* nativeNow() { return nullptr; }
};

class TimelineSource : public FrameSource {
public:
    /// `clips` need not be sorted; they are put into paint order here, which is
    /// bottom track first — the same order the viewer stacks them and for the
    /// same reason.
    TimelineSource(const ExportSettings& s, std::vector<ExportClip> clips);
    ~TimelineSource() override;

    /// Opening the audio readers is a header read per clip, which is cheap
    /// enough to do eagerly and the only way to answer honestly.
    bool hasAudio() const override { return anyAudio_; }

    const Rgba& canvasAt(double t) override;

    /// Every clip under the playhead contributes at its own level: summed, not
    /// picked between.
    void mixInto(float* dst, double from, int frames, int rate, int channels) override;

    /// Nothing covers `t` and nothing begins after it — the stack has run out.
    /// A gap in the middle of a timeline is not the end of it, which is why
    /// this asks about every clip rather than about the one under the playhead.
    bool exhausted(double t) const override;

private:
    /// Open the one clip of each distinct input that settles `hasAudio()`, all
    /// of them at once. See the definition for why that is worth a thread pool
    /// and why the rest of the clips are not opened here at all.
    void openTheFirstOfEach(const ExportSettings& s,
                            const std::vector<class ClipSources*>& firsts,
                            const std::vector<MediaInput>& theirInputs);

    ExportSettings settings_;
    std::vector<std::unique_ptr<ClipSources>> clips_;
    std::unique_ptr<class Compositor> comp_;
    bool anyAudio_ = false;
};

} // namespace ffmpegbro
