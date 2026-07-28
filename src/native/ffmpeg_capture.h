// Recording a device: the job whose end is somebody pressing stop.
//
// A device needs nothing new in `MediaInput` — it is `-f dshow` naming a
// libavdevice demuxer, `-i video=…` naming what it can see, and that demuxer's
// own options (`video_size`, `framerate`, `draw_mouse`, `rtbufsize`) in the
// same bag `-probesize` travels in. Chunk 4 predicted that and it held: the
// model work for capture is one line in `inputIsEndless`.
//
// **The job machine is where a device is genuinely a new shape.** `runExport`
// walks forward from `start` to `end` at a fixed rate, asking a `FrameSource`
// what the output looks like at each instant. Every part of that sentence is
// wrong for a device:
//
//   - it cannot be asked what it looks like at `t`, only what it looks like
//     *now* — there is no seeking a camera;
//   - it has no `end`, so there is no total, no percentage and no estimate;
//   - the clock is the device's rather than the render's: a capture that
//     rendered faster than real time would be inventing frames and one that
//     rendered slower would be dropping them.
//
// So this is a second job rather than a flag on the first, and what the two
// share is the parts that do not care: `Writer` (the encoders, the muxer, the
// trailer, the stream list), the one slot in ffmpeg_job.h, and — since the
// device grew a filter graph — the filtergraph parse and the `pad:<label>`
// vocabulary. Sharing the slot is a decision and not an accident — see below.
//
// **A recording can run a filter graph, and it is pushed rather than pulled.**
// `ExportSettings::filterGraph` means the same thing here as it does in a
// render: `[0:v]crop=…[vout]` records one monitor out of a wide screen grab, and
// several output pads become several streams of one file exactly as they do for
// an export. What differs is the direction. `GraphSource` walks a bounded range
// asking the graph what the output looks like at an instant and drives its
// inputs backwards from a sink until they answer; `CaptureGraph`
// (capture_graph.h) is handed a decoded frame with the device's own timestamp on
// it and empties every sink of whatever fell out. So placement — a timestamp
// becoming an output frame number, a stall holding the last picture, `-t`
// running out — happens *after* the graph rather than before it, per output pad,
// which is what makes a rate-changing filter (`fps=10`) an ordinary filter here.
//
// Two things about it are refusals rather than features. A capture's graph is
// fed by the device and by nothing else, so `filterInputs` — which says which
// *file* feeds which pad — is refused: a device cannot be cut from, and a file
// beside it on one graph is a later chunk's. And a graph whose filters want a
// graphics card is refused by name, because `-filter_hw_device` has nowhere to
// be said on the Capture stage and failing inside a parse would be the least
// readable version of it.
//
// **Stop is the normal end of a recording, not the exceptional one.** Every
// rule about a cancelled render still writing its trailer matters more here,
// not less: a render that loses its index has lost a file you can make again,
// and a recording that loses its index has lost the only copy of something
// that happened once. So a recording that is stopped reports **Done**, not
// Cancelled — nothing was lost and nothing was abandoned; the length was the
// question and pressing stop is the answer to it. `Failed` still means failed.
//
// **Progress is elapsed and size, and there is no percentage.** A fraction
// needs a total, a recording has none until it is over, and a bar creeping
// towards an end nobody chose is a lie drawn sixty times a second.
// `ExportStatus::openEnded` says so, `framesTotal` stays 0 — which is the same
// rule `inputDuration` already follows, where zero means nobody knows — and
// the UI draws a counter instead of a bar. Give the input a `-t` and the
// recording *does* have an end, and then both fields say so.
//
// **One slot means no preview and no export while recording, and that is
// right.** The alternative is a second slot, and a second slot is a second
// answer to "is something running?" — but more than that, an encode running
// against the same CPU as a live capture is how a capture comes to drop
// frames. A recording is the one job in this application with a real-time
// deadline: it cannot be re-run, so it gets the machine. The UI says so where
// the doors are, rather than offering one that will not open.
//
// **Chunk 13 wants all of this.** Streaming *out* — `-f hls`, `-f tee`, an
// `srt://` destination — is the same open-ended shape with the ends swapped: a
// bounded input and an output that runs until stopped. What to reuse is the
// slot, `openEnded`, the terminal-state-is-Done-on-stop rule, and the fact
// that `Writer` already copes with being closed at an arbitrary moment.
#pragma once

#include "ffmpeg_export.h"
#include "ffmpeg_input.h"

#include <string>

namespace ffmpegbro {

/// What a recording is: one device, and the file it goes into.
///
/// Two structs rather than fields bolted onto `ExportSettings`, because they
/// answer different questions and only one of them is new. The output half is
/// exactly what an export is given — the same encoders, the same muxer, the
/// same option bags, the same stream list — so a recording and a render write
/// files the same way and there is no second set of encode settings to drift.
struct CaptureSettings {
    /// The device, as an `-i`. `format` is the libavdevice demuxer's name
    /// (`dshow`, `gdigrab`, `lavfi`) and `path` is what goes after the `-i`
    /// (`video=Elgato Virtual Camera`, `desktop`, `testsrc=size=320x240`).
    ///
    /// **`duration` is how long to record for, and zero means until stopped.**
    /// It is `-t` on the input, which is exactly what it is on a command line
    /// — `ffmpeg -f gdigrab -t 10 -i desktop out.mp4` — rather than a field of
    /// this application's own, so the command bar prints it in front of the
    /// `-i` with everything else.
    MediaInput source;

    /// Where it goes and how it is encoded. `width`/`height` at zero take the
    /// device's own picture size, which is nearly always what is wanted: a
    /// capture is not composited and there is no canvas to fit it into.
    /// `fps` at zero takes the rate the device reports.
    ///
    /// **`filterGraph` and `streams` mean here exactly what they mean in a
    /// render**, which is why they are not fields of their own: the graph is fed
    /// by the device rather than by files, and what comes out of its pads is
    /// mapped with `pad:<label>` the same way. `filterInputs` is the one field
    /// of this struct a recording refuses — see the note at the top.
    ExportSettings output;

    /// Zero rather than `ExportSettings`' 1920×1080 at 30, because for a
    /// recording those are not sensible defaults — they are a scale and a rate
    /// change applied to a camera nobody asked to resample. A capture that says
    /// nothing about its size gets the device's.
    CaptureSettings() {
        output.width = 0;
        output.height = 0;
        output.fps = 0.0;
    }
};

/// Start recording on the job thread. False — with a reason — when the slot is
/// taken or the device cannot be opened.
///
/// The device is opened *here*, on the caller's thread, and not on the job
/// thread: "there is no camera called that" is the commonest failure and it
/// should arrive as a refusal from the call that asked for the recording,
/// while the name that was wrong is still on screen — not as a job that starts
/// and fails a moment later.
///
/// `jobNumber` is which job this one is in the report channel — the same thing
/// `startExport` hands back, and for the same reason.
bool startCapture(const CaptureSettings& s, std::string* error,
                  uint64_t* jobNumber = nullptr);

/// Stop the recording. The normal end: the frame being written is finished,
/// the trailer goes down, and the status reports Done.
void stopCapture();

} // namespace ffmpegbro
