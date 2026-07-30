// Recording live inputs: the job whose end is somebody pressing stop.
//
// A device needs nothing new in `MediaInput` — it is `-f dshow` naming a
// libavdevice demuxer, `-i video=…` naming what it can see, and that demuxer's
// own options (`video_size`, `framerate`, `draw_mouse`, `rtbufsize`) in the
// same bag `-probesize` travels in. Chunk 4 predicted that and it held: the
// model work for capture is one line in `inputIsEndless`.
//
// **A recording reads a list of inputs, and the list is what makes it a
// session.** A screen grab and a camera composited into one file is two `-i`s,
// `[1:v]` scaled and overlaid on `[0:v]`, `[0:a]` and `[1:a]` mixed — which is
// the same graph a render would be given and the same `-map` vocabulary on the
// way out. Three things follow from there being several of them, and each is
// worked out below rather than here: one reader thread per device, two clocks,
// and sound that is stamped rather than sampled.
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
// **One reader thread per device, because `av_read_frame` blocks.** N devices
// cannot share a read loop: a camera that has gone quiet would starve the
// screen grab beside it for as long as it stayed quiet, and what a session
// records in that moment is exactly what somebody will want back. So each
// device is read and decoded on a thread of its own which does nothing but
// deposit frames, and the job thread runs the graph, the writer and the clock.
// Every device is still *opened* on the caller's thread, so "there is no camera
// called that" stays a refusal from the call that asked for the recording.
// A read that has genuinely hung delays its own join and nothing else; that was
// the single-device loop's limitation and it is now one per input.
//
// **Two clocks, and which one runs is the number of inputs.** With one input
// there is nothing to line up against, so its own media timestamps place the
// frames — a `-f lavfi` input that produces faster than real time records
// faster than real time, and a device that runs a little fast or slow still
// writes a file whose clock is the wall clock. With several, no input's clock
// can be the master without starving the others, so the session runs on the
// **wall clock**: one tick per output frame, and every video feed *sampled* at
// the tick from a latest-frame slot its reader keeps filled — the newest
// picture, or the previous one again where nothing arrived. Every feed
// therefore reaches the graph constant-rate and aligned, `overlay`'s framesync
// has nothing to wait for, and a stalled camera freezes its own picture and
// only its own. That is the single-device loop's "a stall holds the last
// picture" rule moved in front of the graph, which is where N inputs need it.
//
// **Sound is not sampled.** Dropping or repeating blocks of samples is
// audible in a way a repeated picture is not, and what live sound actually
// needs is drift compensation: two devices are two crystal oscillators and
// 48000 Hz on one of them is not 48000 Hz on the other. So sound is pushed as
// it arrives, stamped with its arrival on the session's wall clock, and
// `aresample=async` is inserted between each sound buffersrc and the graph —
// ffmpeg's own tool for exactly this — in the same place and by the same
// mechanism the export graph inserts `transpose` for rotation.
//
// **The session's zero is the first tick at which every video feed has offered
// a picture**, which is the generalisation of "the recording's zero is the
// first picture": with two devices it is the reason a session does not open
// with one of them black for as long as it took to wake up. A feed that is
// sound only does not gate it, and a feed that has produced nothing at all
// after a few seconds fails the job naming its device — a session waiting for
// ever on a camera that is not going to answer, with "recording" on the screen,
// is the failure worth refusing rather than the one worth being patient about.
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
// Three things about it are refusals rather than features. A capture's graph is
// fed by its devices and by nothing else, so `filterInputs` — which says which
// *file* feeds which pad — is refused: a device cannot be cut from, and a file
// beside one on the same graph is a later chunk's. A graph whose filters want a
// graphics card is refused by name, because `-filter_hw_device` has nowhere to
// be said on the Capture stage and failing inside a parse would be the least
// readable version of it. And **several inputs with no graph is refused**,
// because two pictures and no statement of how they combine is not a
// composition this or anything else could guess at — the graph is what says how
// they go together, which is also why every stream of every input has to reach
// it once there is more than one.
//
// **A recording writes as many files as it was given, all at once.** One
// session, one reading of the devices, one graph — and a `Writer` per file on
// the end of it, each mapping the pads it names and encoding them its own way.
// That is what a render cannot do the same way round: a render writes two sizes
// by walking its range twice (`ExportPass`), and a recording has no second walk
// because what it was reading has happened. It is also what `-f tee` is not —
// `tee` writes one encode to several places, and the cameras to one file with a
// cropped copy in another is two encodes of two different pictures.
//
// The devices, the graph and `-t` belong to the session; the muxer, the
// encoders and the stream list belong to each file. See `CaptureSettings::outputs`.
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
#include <vector>

namespace ffmpegbro {

/// What a recording is: the live inputs it reads, and the file they go into.
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

    /// Every device this session reads, in the order `[0:…]`, `[1:…]` … number
    /// them for the graph.
    ///
    /// **Empty is not "no inputs" — it is `{source}`**, which is the same rule
    /// `outputStreams()` follows for an empty stream list and
    /// `ExportSettings::inputs` follows for a spec whose clips carry paths: a
    /// caller that never heard of this field asks for exactly what it always
    /// asked for, and every existing test still means what it meant. Given a
    /// list, `source` is the first entry of it and nothing reads the field.
    ///
    /// **`-t` is still per input, and the shortest of them is the session's.**
    /// An input that has run out has nothing further to offer the graph, so
    /// going on would be recording whatever is left, held still, over the top
    /// of it.
    std::vector<MediaInput> sources;

    /// Where it goes and how it is encoded. `width`/`height` at zero take the
    /// device's own picture size, which is nearly always what is wanted: a
    /// capture is not composited and there is no canvas to fit it into.
    /// `fps` at zero takes the rate the device reports.
    ///
    /// **`filterGraph` and `streams` mean here exactly what they mean in a
    /// render**, which is why they are not fields of their own: the graph is fed
    /// by the devices rather than by files, and what comes out of its pads is
    /// mapped with `pad:<label>` the same way. `filterInputs` is the one field
    /// of this struct a recording refuses — see the note at the top.
    ExportSettings output;

    /// Every file this recording writes, in the order they were asked for.
    ///
    /// **Empty is not "no output" — it is `{output}`**, which is the rule
    /// `sources` follows one field up and for the same reason: a caller that
    /// never heard of this field asks for exactly what it always asked for.
    /// Given a list, `output` is the first entry of it and nothing reads the
    /// field.
    ///
    /// **They are written at once, not one after another.** That is the whole
    /// difference between this and `ExportPass`, which is how a *render* comes
    /// to write two sizes: a render can walk its range twice because the range
    /// is still there the second time, and a recording cannot, because what it
    /// was reading has happened. So a second file here is a second `Writer`
    /// open beside the first, fed from the same devices and the same graph on
    /// the same pass — and the cost of it is a second encode running against
    /// the same CPU as the capture, which is the trade the person asking for it
    /// is making.
    ///
    /// **What differs between them is what they map and how they encode it.**
    /// The devices are the session's, the graph is the session's, and `-t` is
    /// the session's — one reading of one moment. Each file names its own
    /// muxer, its own encoders and its own `streams`, and a stream fed from
    /// `pad:<label>` is how a file says which of the graph's ends it is of. A
    /// file that names no size takes the pad's, exactly as one file always has.
    ///
    /// Only `[0]`'s frame count is the recording's — `framesDone`, the `-t`
    /// percentage — because a counter that jumped between two files' clocks
    /// would be a counter about neither. What is summed is what was written:
    /// bytes and pieces are of the recording, not of any one file in it.
    std::vector<ExportSettings> outputs;

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
/// taken or an input cannot be opened.
///
/// **Every** device is opened *here*, on the caller's thread, and not on the
/// job thread or on the reader thread that goes on to read it: "there is no
/// camera called that" is the commonest failure and it should arrive as a
/// refusal from the call that asked for the recording, while the name that was
/// wrong is still on screen — not as a job that starts and fails a moment later
/// with the second of two devices to blame and nothing saying which.
///
/// `jobNumber` is which job this one is in the report channel — the same thing
/// `startExport` hands back, and for the same reason.
bool startCapture(const CaptureSettings& s, std::string* error,
                  uint64_t* jobNumber = nullptr);

/// Stop the recording. The normal end: the frame being written is finished,
/// the trailer goes down, and the status reports Done.
void stopCapture();

// ── Watching, rather than writing ──────────────────────────────────────────
//
// **The same machine with the writer taken off the end.** A live session opens
// the devices, reads them on a thread each, samples them at a tick and pushes
// them through a `CaptureGraph` — every line of that is what a recording does,
// and it is here rather than in a file of its own because it *is* that, and two
// answers to "how is a device read" would be two things that can disagree about
// which frame a stall holds.
//
// What it does instead of writing is **publish pads**, sound as well as
// pictures. Each device appears as
// `in0`, `in1`, … exactly as it arrived — with its sound as `in0:a`, which is
// ffmpeg's own way of naming that stream — and everything the graph produces
// appears under the label the graph gave it: `vout`, `aout`, or a name somebody
// wrote. A `<video src="/@live/<id>/vout">` therefore plays the composition and
// `/@live/<id>/aout` is what it sounds like, which is the one thing the Capture
// stage could never show: a card is one device, and what two of them make
// together only existed in the file afterwards.
//
// **Sound is published only while something is listening**, and that is the whole
// of monitoring being off by default: the level a meter draws is measured from
// every block whatever happens, and the block is referenced only when a pad has a
// listener on it. See `LivePadTap::putSound`.
//
// **It owns the devices, and that is the point rather than a detail.** A
// DirectShow camera can be opened once. Previews used to open one each, which
// worked because nothing else wanted them and stopped working the moment the
// composition wanted them too — so the session opens each device once and
// every picture on the stage is a pad of it. That is also what makes a
// preview of two cameras cost two opens rather than four.
//
// **A recording still opens its own.** It does not attach to a running session
// and the session is torn down before one starts, because "there is no camera
// called that" is a refusal that belongs to the call that asked for the
// recording — see `startCapture` above — and a recording that inherited a
// session would have nothing to refuse with. The cost is the moment between
// the two opens, which is the moment the preview goes dark anyway.
//
// **No job slot.** A session is not a job: it writes nothing, it has no
// progress, and the whole point is to be watching while deciding whether to
// record. `ffmpeg_job.h`'s slot stays for the things that produce a file.

/// What to watch: the devices, and the graph to run them through.
///
/// `filterGraph` means what it means everywhere else in this application, and
/// an empty one is the ordinary case — with no graph each device is published
/// as itself and there is no composition to show.
struct LiveSettings {
    std::vector<MediaInput> sources;
    std::string filterGraph;
    /// The tick the devices are sampled at, and the rate the pads produce.
    /// Zero is 30, which is the rate a recording settles on when nothing says.
    double fps = 0.0;
    int audioSampleRate = 48000;
    int audioChannels = 2;
    bool includeAudio = true;
    /// swscale's preference where a conversion is unavoidable. Same key as a
    /// render's, because it is the same question.
    std::string scaler;
};

/// One pad a session publishes.
///
/// **Pictures and sound, and each is played the same way.** A sound pad used to
/// publish a level and nothing else, because playing one is *monitoring* and
/// monitoring asks its own questions — whose speakers, and what happens when the
/// microphone can hear them. Both are answered now, and neither answer is in
/// this struct: the speakers are the system's own until somebody asks for
/// another, and feedback is stated rather than suppressed. What is here is the
/// consequence — a sound pad has a `src` like any other, and it carries frames
/// only while something is listening to it (`LivePadTap::listen`).
///
/// A device with no sound and no picture has no pad at all, which the card
/// already knows from its probe.
struct LivePad {
    std::string name;      ///< `in0`, `in0:a`, `vout`, `aout`, or the graph's own label
    bool device = false;   ///< an `in<N>`: one input, before the graph
    int width = 0;         ///< once the graph has settled; zero before that
    int height = 0;

    /// A pad carrying sound rather than pictures. It has two things instead of
    /// one: a level, asked for separately by `liveLevels` because asking clears
    /// it, and — for whoever monitors it — the blocks themselves.
    bool sound = false;
};

/// What one sound pad has been doing since this was last asked.
///
/// **Separate from `LivePad` because reading it clears it.** Listing the pads
/// is an idempotent question that whatever is looking for a pad by name asks
/// several times a frame; taking a level is a *consuming* read, and the two
/// folded together would mean the first look of each frame got the reading and
/// the rest got nothing.
struct LiveLevel {
    std::string name;
    /// False where no sound arrived in the window at all — which is not the
    /// same as silence, and is why it is said rather than answered with a zero.
    /// A device that has stopped delivering would otherwise read as one
    /// delivering quiet.
    bool heard = false;
    float peak = 0.0f;   ///< loudest sample since the last read, 0…1 and beyond
    float rms = 0.0f;    ///< and the RMS over the same stretch
};

/// Open a session and start reading. Zero with a reason when a device will not
/// open — which, exactly as for a recording, is answered on *this* thread while
/// the name that was wrong is still on screen.
uint64_t openLive(const LiveSettings& s, std::string* error);

/// What this session publishes. Empty for an id nothing is open under.
///
/// Asked rather than returned by `openLive` because the graph's pads have sizes
/// only once libavfilter has configured it, and it cannot configure until a
/// device has handed over a frame. The names are known immediately; the numbers
/// arrive a moment later.
std::vector<LivePad> livePads(uint64_t id);

/// What each sound pad has been doing since the last call, and **the call
/// clears it**. One reader, once a frame: a peak left standing would make a
/// moment of clipping look permanent, and two readers would halve each other's
/// windows and draw two meters that disagree.
///
/// Empty for a session with no sound in it, which is the ordinary case for a
/// screen grab and is the meter simply not being there.
std::vector<LiveLevel> liveLevels(uint64_t id);

/// Give the devices back. Idempotent, and the destructor of everything the
/// session holds; a session left open holds a camera.
void closeLive(uint64_t id);

/// Every session, for shutdown and for the moment before a recording starts.
void closeAllLive();

} // namespace ffmpegbro
