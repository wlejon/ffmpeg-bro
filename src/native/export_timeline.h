// The edit, as something that answers "what does the output look like at t?"
//
// This is the seam between *what to render* and *how to write it*. The job
// above it owns a clock and a writer and knows nothing about clips; this owns
// clips and knows nothing about encoders. Between them passes one canvas and
// one block of samples per output frame.
//
// **That seam is where a node graph attaches.** A graph is a different answer
// to the same two questions — the canvas at t, and the samples between t and
// the next frame — with the inputs named explicitly and the compositing
// described rather than implied by a track stack. When it arrives it becomes a
// second implementation of this, and `runExport` does not change: it already
// asks these two questions and nothing else.
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

class TimelineSource {
public:
    /// `clips` need not be sorted; they are put into paint order here, which is
    /// bottom track first — the same order the viewer stacks them and for the
    /// same reason.
    TimelineSource(const ExportSettings& s, std::vector<ExportClip> clips);
    ~TimelineSource();

    /// Whether any clip has sound this render will use. Asked before the first
    /// frame because it decides whether the file gets an audio track at all,
    /// which has to be settled before the header goes down. Opening the audio
    /// readers is a header read per clip, which is cheap enough to do eagerly
    /// and the only way to answer honestly.
    bool hasAudio() const { return anyAudio_; }

    /// The composited output frame at `t` seconds on the timeline. Owned here
    /// and valid until the next call.
    const Rgba& canvasAt(double t);

    /// Add `frames` samples covering [from, from + frames/rate) into `dst`,
    /// which the caller has zeroed. Every clip under the playhead contributes
    /// at its own level: summed, not picked between.
    void mixInto(float* dst, double from, int frames, int rate, int channels);

private:
    ExportSettings settings_;
    std::vector<std::unique_ptr<ClipSources>> clips_;
    std::unique_ptr<class Compositor> comp_;
    bool anyAudio_ = false;
};

} // namespace ffmpegbro
