// The edit, as something that answers "what does the output look like at t?"
//
// This is the seam between *what to render* and *how to write it*. The job
// above it owns a clock and a writer and knows nothing about clips; this owns
// clips and knows nothing about encoders. Between them passes one canvas and
// one block of samples per output frame.
//
// **That seam is where a node graph attaches**, and now does: `FrameSource`
// below is the two questions written down, `TimelineSource` is the track
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

namespace ffmpegbro {

struct Rgba;
class ClipSources;

/// The two questions, and nothing else. Whatever answers them can be rendered.
///
/// Deliberately narrow: every widening of this is a thing the job has to know
/// about the edit, and the job's whole claim is that it knows nothing about
/// the edit.
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
