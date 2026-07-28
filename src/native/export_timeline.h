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
// Sources are opened lazily, on the frame a clip first appears. A two-hour
// timeline of a hundred clips would otherwise open a hundred files, and their
// decoders, before writing a frame.
#pragma once

#include "ffmpeg_export.h"

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
    ExportSettings settings_;
    std::vector<std::unique_ptr<ClipSources>> clips_;
    std::unique_ptr<class Compositor> comp_;
    bool anyAudio_ = false;
};

} // namespace ffmpegbro
