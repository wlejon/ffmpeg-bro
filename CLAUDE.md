# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GPL video editor/player built as its own executable on top of the MIT [bro](https://github.com/wlejon/bro)
engine, with libav* linked in directly. Two halves:

- **`src/native/`** — C++ that implements bro's codec-agnostic `bro::video` interfaces on
  top of libavformat/libavcodec and registers them as a media backend, plus the `bro.ffmpeg`
  JS bindings.
- **`ui/`** — the whole application, written as plain ES modules running in bro's QuickJS +
  DOM environment. No Node, no npm, no bundler, no package.json: `ui/index.html` loads
  `ui/*.js` directly.

Read `README.md` first — it documents the user-facing behaviour (timeline, viewer, keyboard)
in detail and lists what does not work yet.

## Building and running

Requires a sibling `bro` checkout (or `-DBRO_DIR=<path>`) and vcpkg's GPL ffmpeg port; see
README.md for the exact `vcpkg install` line. Configured here with Visual Studio 2022,
multi-config, so `--config` matters.

```bash
cmake -B build
cmake --build build --config Release
./build/Release/ffmpeg-bro [media-file]
```

`bro` is added via `add_subdirectory`, so a change under `../bro` rebuilds through this
project's build. `BRO_BUILD_EXECUTABLES` stays off — no second `bro.exe` is produced.

Targets: `ffmpeg-bro` (windowed), `ffmpeg-bro-headless` (scripted) and
`ffmpeg-bro-core` (the shared static lib the two are built on), plus one executable per
native suite — `ffmpeg-bro-decodetest`, `ffmpeg-bro-exporttest`, `ffmpeg-bro-captest`,
`ffmpeg-bro-inputtest`, `ffmpeg-bro-seqtest`, `ffmpeg-bro-capturetest`,
`ffmpeg-bro-hwtest`, `ffmpeg-bro-perftest` — and `ffmpeg-bro-mkfixture`, which `ctest`
runs first to make the media everything else is measured against.

## Tests

```bash
# everything, with generated fixture media: the only command you need
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` writes the fixture media into `build/fixtures/` (a CTest `FIXTURES_SETUP` test, so
it is made once and only when something will use it) and runs every suite against it —
two mp4s with sound, **a third with no audio stream in it at all**, plus a folder of
stills for the sequence work: a padded run, an unpadded run
whose numbers cross from one digit to two, and a file beside them that is part of
neither. The silent one is not the same file as one whose soundtrack is quiet — it is
the only thing that separates "the mix" from "a mix nothing feeds", and every screen in
this application used to claim a soundtrack for it. The third of those is the case that decides whether the sequence scan is any
good, and it is written by the same `Writer` through the `image2` muxer, which makes the
fixtures the check that the picture side of that works at all. They are generated rather than checked in, and generated with **known content** —
a moving bar over a gradient, a 440/660 Hz tone at -6 dBFS, two different sizes, aspects,
rates and lengths. What that buys is in tests/make_fixture.cpp: a source whose audio track
is digitally silent turns the export test's mixer check into a failure that reads as a
broken mixer, and a source that is mostly black makes a picture check pass for the wrong
reason. The generator writes through the renderer's own `Writer`, which is why it is
eighty lines.

**Wiring `ctest` up found two crashes on its first run**, both of which predated it and
both of which were invisible because every suite used to be run through a shell pipe —
which reports the exit status of the pipe, not of the program, so a process that printed
all its passes and then died on the way out looked green. Both are fixed; what they were
is worth keeping, because each is a mistake that is easy to make again:

- **Buffers handed to libav* need slack past the end.** Both libswscale and libswresample
  work a SIMD block at a time, so the last store of a row — or of a run of samples — goes
  past what was asked for. A `std::vector` sized to exactly `width*height`, or to exactly
  the sample count, is therefore too small however carefully the count was worked out.
  `Rgba::kSwsSlack` and `ffmpeg_backend.cpp`'s `kSwsSlack` are the padding
  `av_image_alloc` and `av_samples_alloc` would have added. A 640-wide fixture is a whole
  number of blocks and never showed it; the 360-wide one corrupted the heap on the first
  frame it converted — far enough from the write that it read as a bug in the audio seek
  that happened next. **Where three planes are packed into one allocation, each of them
  needs the slack**, not just the last: one plane's spill lands in the next.
- **The engine destroyed its audio engine before its document.** `~ElVideo` calls
  `closeStreamingAudio()`, whose first act is `audioEngine_->closeStream(id)` through a
  non-owning pointer, so every document that had ever played sound corrupted the heap on
  the way out. Fixed in bro's `Engine::~Engine` (`document_.reset()` now precedes
  `audioEngine_.reset()`), which is why this repo needs a bro at least that new. A silent
  file never showed it: with no audio track there is no stream to close.

The technique that found both, after bisection stalled, is worth repeating: a standalone
CMake project that compiles `src/native/export_*.cpp` directly against ffmpeg with a
twenty-line stub for `util/log.h`, so a render can be run in two seconds without the
engine. **Note that AddressSanitizer hid it** — MSVC's ASan replaces the allocator, so the
overflow stopped being fatal and was never reported, since the store came from an
uninstrumented DLL. The plain Release build of the same sources crashed on demand.

Do not "fix" a crash like these by making a test tolerate a bad exit code.

Tests print unbuffered (`setvbuf(stdout, nullptr, _IONBF, 0)`). Through a pipe stdout is
fully buffered, so a process that dies mid-run discards every line it printed and the
failure reads as "nothing ran" — which is precisely the information needed to find it.

Each suite also runs standalone against any real file, which is how to check behaviour
against footage the fixtures do not resemble:

```bash
# native: demux, decode, reorder, seek, audio, backend precedence
./build/Release/ffmpeg-bro-decodetest <file> [more files...]

# native: an -i — a forced demuxer, an option bag whose unknown keys are
# errors, a window that moves the input's own clock, and the token playback
# opens a registered input by
./build/Release/ffmpeg-bro-inputtest <file>

# native: inputs whose content is assembled — the sequence scan and what it
# refuses to guess, a still that has no length until somebody gives it one,
# -stream_loop, the concat demuxer, and a render that writes a run of files
./build/Release/ffmpeg-bro-seqtest <fixture-directory>

# native: render a timeline and open the result — geometry, opacity, audio
# mixing, cancellation, capability reporting, whether options reach the
# encoder, and what a multi-stream file came out as. Writes into out/.
# It opens results with libavformat directly as well as through probeMedia(),
# because a disposition beyond "default", a fourcc and an attachment's mimetype
# are not things playback asks about — which is why this target alone among the
# test binaries takes ${FFMPEG_INCLUDE_DIRS}.
./build/Release/ffmpeg-bro-exporttest <file> [<second-file>]

# native: what this build can write, read, reach and capture — the muxer,
# demuxer, protocol, device and decoder registries, their option tables, and
# a render into a muxer named rather than guessed from the filename
./build/Release/ffmpeg-bro-captest <file>

# native: where the time in a seek goes (demux vs decode vs YUV->RGB)
./build/Release/ffmpeg-bro-perftest <file>

# the whole UI, driven like a person — writes screenshots to out/
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]

# the encode side end to end: the spine's stages, controls -> ffmpeg options,
# the advanced option editor, the command bar, both halves of the A/B preview,
# the stream list and the copy decision on it, and loading the result back.
# Its last seven hundred lines are the Graph stage *as it reaches a render* —
# a filter changing the picture that comes out, a card's value outranking the
# edit, a node previewed and played — which is why they are here and not in
# ui_graph.js, which needs no media and is about the model.
# The second file has **no audio stream in it**, which is what separates the
# mix from a mix nothing feeds; the last section is skipped without one.
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file> [<video-only file>]

# the Sources stage as the input editor: an input added by typing a path with
# nothing on the timeline, a demuxer forced, an option set, a window cut, and
# every one of those printed in front of its own -i
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sources.js -- <file>

# the same subject from the drop inwards: twelve files becoming one -i, a
# still that plays because it is held and is refused when it is not, a
# sequence played, and the Write stage naming the files it will produce.
# Takes the fixture *directory*, because what it is about is a folder.
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sequence.js -- <fixture-directory>

# the equivalent filtergraph, against specs written out by hand. Needs no
# media: buildSpec()'s output is a plain object and the module is pure.
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js

# the graph underneath it: the model, the printer's chain rule on graphs the
# derivation does not produce, every refusal, pad counts, locks, insertion,
# removal, hand-made wires surviving a rebuild, the round trip — and, given a
# file, the wiring gesture driven on the real stage with real MouseEvents
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js [-- <file>]

# filters whose output is information: a measurement started, run, plotted and
# applied — and refused where it could not be trusted. Plus the A/B comparison
# measured with psnr/ssim rather than judged by eye.
./build/Release/ffmpeg-bro-headless ui/ tests/ui_measure.js -- <file>

# the render's back-channel, from av_log inside libav to a line on screen:
# the drain off the frame loop, a warning that is visible and attributed, and
# a measuring filter's values as a named series over time
./build/Release/ffmpeg-bro-headless ui/ tests/ui_report.js -- <file>

# the three things people mean by subtitles, each a different mechanism: a
# track beside the picture (a stream row, carried or converted), burned into
# the picture (a `subtitles` node on the graph, path escaped), and out on its
# own (a render whose only stream is cues). Renders both and reads them back,
# because a track described correctly and not written is the failure. Takes the
# fixture *directory* — it wants `cues.srt` and `cues.ass` beside the video.
./build/Release/ffmpeg-bro-headless ui/ tests/ui_subtitles.js -- <fixture-directory>

# native: a device as an endless input, and recording one — bounded, stopped,
# with sound. Needs no media: it records from `lavfi`.
./build/Release/ffmpeg-bro-capturetest out

# the Capture stage: choosing a device, its options in front of its -i, a
# recording with no percentage, and a region dragged on the live screen
./build/Release/ffmpeg-bro-headless ui/ tests/ui_capture.js

# native: the GPU. Which device types work on *this* machine, whether a
# hardware decode is the same picture as a software one, a refusal where a
# device or a codec is missing, and — printed, never asserted on — what each
# path costs. Passes on a machine with no card at all.
./build/Release/ffmpeg-bro-hwtest <file>

# the two places a person decides about a card: the device an input decodes on
# (Sources, in front of the -i) and the encoder a stream is written with
# (Encode), plus the sentence saying which of the two is measured slower here
./build/Release/ffmpeg-bro-headless ui/ tests/ui_hardware.js -- <file>
```

**`hwtest` is mostly a measurement and that changes how it is written.** CI has
no graphics card and, unlike a camera, there is no `lavfi` to stand in for one —
so the suite splits. Assertions are about the *shape* of the answer and run
everywhere: enumeration answers something, a type reported present can be created
and is shared rather than remade, a type reported absent refuses with a sentence,
a codec the device cannot decode is refused before a packet is read. **Numbers are
printed and never asserted on**, because a threshold on them would be a statement
about the machine and not about the code; where they belong is README, beside the
name of the hardware they came from. Do not turn one into a check.

The one equivalence check needs its threshold explained rather than tuned. **A
hardware decoder is not bit-exact with a software one and is not required to be**
— NVDEC and the CPU implement the same standard and differ in rounding and
deblocking arithmetic, all within what H.264 permits — so the floor is PSNR and
it is 40 dB. Two conformant decoders of one bitstream score in the forties here;
every mistake reachable in this code (a frame out of step, a plane swapped, a
download that lost the colour tags) scores under twenty. The gap is where the
threshold lives, and lowering it to make something pass would be removing the
only thing the check does.

**What the measurement said, because it is not what the folklore says.** On this
machine — Ryzen 9 7950X3D, two RTX 4090s — hardware *decode* is two to six times
slower than libavcodec threaded across thirty-two cores, and the readback
everybody blames is 3–4% of it: NVDEC is a throughput engine being asked for one
frame at a time. Hardware *encode* is two to three times faster above SD and
slower below it. So the win is entirely the encoder, the two are separate
decisions in the UI, and every comment in this repo that used to say "the
readback is the cost" now says what was measured. README has the tables.

**Testing capture is awkward and must not be fudged.** CI has no camera, so both
suites drive `lavfi` — libavfilter's *input device* (`-f lavfi -i testsrc=…`), which
is a device in every respect that matters (registered by `avdevice_register_all()`,
forced with `-f`, no duration, never ends) and opens anywhere. **It is not the same
mechanism as a source filter on the graph**, which the Graph stage also has: `testsrc` as a
*filter* is a node with no input pad inside a filtergraph, and the lavfi *device*
wraps a whole graph up as a demuxer so libavformat can read it as an `-i`. They are
spelt almost identically and they are two different places in the pipeline; say so
wherever a reader will hit it.

The machine's real devices are asked about too, and **whatever the answer is, it is
asserted**: gdigrab is either in this build or it is not, and if it is then opening
it either produces frames or says why it did not. There is no branch that asserts
nothing — a test that quietly passed for want of a camera would be worse than no
test. On Windows with a desktop session gdigrab opens even under the headless
binary, so what runs is the real screen grabber, region drag included.

Two things lavfi will not do that a real device does. It produces frames as fast as
it can rather than in real time — there is no `-re` here — so a "five second"
recording is over in a fraction of one, and a UI test that wants to look at a
*running* recording has to ask for enough seconds that there is still one to look at.
And it cannot be previewed, for the `wrapped_avframe` reason above.

`tests/ui_player.js` is the main regression suite: it drops files on the real UI, plays,
scrubs, steps, zooms, moves/trims/splits clips, crops, drops a batch as a grid, and asserts
on the DOM and on control-strip geometry. To run one section, comment the rest out — the
script is straight-line, top to bottom, and later sections depend on earlier state (the
batch section deliberately clears the timeline, so it is last).

Test scripts use bro's headless globals (`dropFiles`, `wallSleep`, `advanceTime`, `flush`,
`screenshot`, `assert`, `scriptArgs`) — documented in `../bro/docs/headless.md`. Video runs
on the **real** clock: `advanceTime()` moves bro's virtual time and the decoder ignores it,
so every wait must be `wallSleep()` + `flush()` (that is what `pump()` in the test does).

Six traps when writing headless tests here:

- **`document.dispatchEvent` does not exist.** bro gives `Document` `addEventListener` but
  not `dispatchEvent`, so the node `app.js` binds its keyboard to cannot be aimed at
  directly. Dispatch on `document.body` with `bubbles: true` instead — bubbling itself is
  correct all the way up through body to document to window, and that is the route a real
  key press takes. `ui_player.js`'s `key()` helper is the one place that does it.
- **Never trigger a native file dialog.** `showSaveFileDialog` / `showOpenFileDialog` block
  the JS thread until dismissed, and headless is not a safe harbour — there is no window to
  dismiss them at. `ui_export.js` types into `#st-write [data-f="path"]` rather than
  pressing "Choose…". (Nothing built at runtime carries an id — see `ui/dom.js` — so the
  path field is reached by its stage and its `data-f` name, not by one.)
- **Paths handed to `<video src>` must be absolute.** `bro.ffmpeg.probe()` resolves relative
  to the process cwd but `<video src>` resolves relative to the *document* (`ui/`), so a
  relative path silently probes fine and plays black. Use `bro.appDir + '/../out/x.mp4'`.
- **A click is three events, and the middle two matter.** `new MouseEvent(...)`
  works here and carries `clientX`/`clientY`/`button`, so a drag can be driven
  properly — mousedown on the element, mousemove and mouseup on `document.body`,
  which bubbles to `document` where the graph listens. But the Graph stage
  *swallows* the click that ends a drag (a rubber band finishes with one, and
  letting it through would clear the selection the band had just made), and
  that flag is only reset by the next press. So a synthesised bare `click` after
  any drag is discarded: dispatch mousedown and mouseup first. `ui_graph.js`'s
  `click()` helper is the one place that does it.
- **`ui/.storage.json` carries state between runs.** It is this engine's `localStorage`,
  it is not in git, and `ui_export.js` renders — which calls `remember()`. So a run that
  leaves the export settings somewhere odd hands them to the *next* run, and a suite that
  passes on a clean checkout can fail on the second run for a reason nothing in the diff
  explains. One botched run left `videoCodec: mpeg2video` behind, which has no CRF, so the
  quality slider was not drawn and an assertion four hundred lines earlier failed.
  `rm ui/.storage.json` before believing a failure, and leave the settings as you found
  them at the end of a section.
- **A comma inside an attribute selector starts a second selector.** A demuxer's
  name is `mov,mp4,m4a,3gp,3g2,mj2`, and `querySelector('[data-demuxer="mov,mp4,…"]')`
  does not find the button carrying it. `ui_sources.js` walks `querySelectorAll` and
  compares `getAttribute` instead, which is what anything keyed by an ffmpeg name has
  to do.


One trap on the native side is worth the same billing. **A network destination is tested
against a real listener, in this process**: a UDP socket bound on the loopback with
`avio_open2(..., AVIO_FLAG_READ)` *before* the render starts, drained on a thread with the
protocol's own `timeout` option so the read gives up rather than outliving the job. That is
not ceremony — writing to a port nobody is on **succeeds silently**, so a test that only
checked the render's exit status would pass with the protocol plumbing entirely broken.
`tests/export_test.cpp` requires what arrives to start with an MPEG-TS sync byte.

The app exposes `globalThis.__ffmpegBro` (model, transport, and the operations) and
`__ffmpegBroReady` purely so tests drive it through a stable surface instead of DOM ids
that only exist while one clip is selected. Keep that in mind when renaming anything there.

`tests/ui_measure.js` is the family above: a measurement started, run, read and acted
on. Three of its sections are written against **hand-made channel records**, the way
`ui_filtergraph.js` is written against hand-made specs — parsing what a filter said is
a pure function of what it said, so a `cropdetect` that has not settled and a
`blackdetect` that found two stretches can be *stated* rather than hoped for out of a
fixture. The cut those spans produce is then made on the real timeline through the real
split. Two traps it hit and that the next suite will hit too: **the overlay lives in
`localStorage` and survives between headless runs**, so a suite asserting on what is in
the graph has to `overlay.clear()` first; and **`project.width/height` is what a clip is
placed in while `settings.width/height` only rescales the result**, so making
`cropdetect` find letterbox means squaring the *project* canvas.

`tests/perf_ui.js` times seeks through the whole application — the same seeks
`perf_test.cpp` measures inside the decoder, but arriving through a clip's `<video>` with
the frame loop, viewer and timeline still running. It asks `__ffmpegBro.video()` for the
element rather than an id, because the viewer creates a `<video>` per clip and there has
been no one player element for some time.

## Architecture

### Native side

The encode half is **one file per stage of the render**, because each changes for a
different reason and the three things README's "Not yet" list wants next each need one of
them to change alone:

| File | What |
|---|---|
| `ffmpeg_input.h` | **what an `-i` is**, the one function that opens one, `-stream_loop`, where a duration comes from, and the registry playback resolves a token through |
| `ffmpeg_sequence.*` | **files that are one input** — the sequence scan and its refusals, the concat list, the frame-name pattern, and whether this build has glob |
| `ffmpeg_export.h` | the description a render is given, and the four calls that run one |
| `ffmpeg_export.cpp` | the job: one thread, **N passes**, the status the UI polls |
| `ffmpeg_job.*` | **the one slot both kinds of job run in**, and the three rules that go with it |
| `ffmpeg_capture.*` | recording a device: the job whose end is somebody pressing stop |
| `export_timeline.*` | **what the output looks like at t** — the `FrameSource` seam, and the track stack's answer to it |
| `export_graph.*` | libavfilter's answer to the same two questions |
| `export_copy.*` | **the packet path** — streams that are not made at all, and where a copy can start |
| `export_source.*` | one clip's pictures, one clip's sound |
| `export_compositor.*` | placing a picture in the canvas: crop, scale, alpha |
| `export_writer.*` | encoders and the muxer they feed — **N streams, not one video and one audio**, plus the three stages that are neither: forced keyframes, two-pass, and the packet chain. Also **every destination the muxer opens**: one writer is one muxer, which is not the same thing as one file |
| `export_subtitle.*` | **cues, decoded and written again** — the one stream kind with no composed source |
| `export_frame.*` | an RGBA picture, and the small libav helpers |
| `ffmpeg_capabilities.*` | what this build can write, read, reach, capture and put a picture through, asked of libav* |
| `ffmpeg_report.*` | **what a render said** — libav's log, and the values filters attach to frames |
| `ffmpeg_hardware.*` | **what this machine has**, as against what this build has — devices created rather than listed, shared once made, and which decoders, encoders and filters each one carries |

**`export_timeline.h` is the seam a node graph attaches at**, and does. `runExport` asks a
`FrameSource` two questions per output frame — the canvas at `t`, and the samples between
`t` and the next frame — and asks nothing else, so a second implementation cost the job one
line. `TimelineSource` is the track stack; `GraphSource` parses a `-filter_complex` and runs
it. **Which one runs is `ExportSettings::filterGraph` being empty or not**, and the two are
measured against each other in `tests/export_test.cpp` — the same edit rendered both ways,
compared as PSNR, 43 dB and holding. **The assertion is that number**, `worst > 43.0`,
against a measurement of 43.6 that repeats to the decimal; it read 34 for a while, which is
nine decibels of slack nobody could account for and enough room for a real regression to sit
green in. Do not let that check be loosened: the whole value of a second path is that it is
the same render.

Six things about the graph path are load-bearing:

- **The graph ends in the compositing space, not the encoder's.** What leaves the last pad
  is a picture; converting it into the encoder's format and colour is the writer's job on
  both paths. The command bar prints that tail because a standalone ffmpeg has no writer,
  which is why `derive()` takes `forRender` and why `renderGraph()` and `filtergraph()`
  differ by exactly one chain.
- **Sources are fed as decoded**, through `SourceVideo::nextRaw`/`SourceAudio::nextRaw`, so
  the graph does its own cropping, scaling and colour conversion. A reader is walked that
  way or through `rgbaAt`/`mixInto`, never both: they share a decoder and a position.
- **Rotation is inserted as `transpose` filters** between the buffersrc and the graph,
  where ffmpeg's own autorotate puts it, because a display matrix is metadata and a filter
  graph works on pictures.
- **Each input seeks to its own window** — `ExportGraphInput::from`, which the derivation
  fills in from the same number the `trim` in the graph is cut at. A plain
  `-filter_complex` without `-ss` decodes every input from the start of its file and lets
  `trim` throw the rest away, which is right and takes an hour for a clip an hour in.
  The seek is **safe by construction rather than by care**: `SourceVideo::seekTo` is
  `AVSEEK_FLAG_BACKWARD`, so it lands at or *before* what it is given and can never skip a
  frame the graph still wants; too small only costs decoding and too large is not
  reachable. `tests/export_test.cpp` renders the same graph with and without it and
  requires the frames to be identical, not merely close — 99 dB being the test's own
  answer for a squared error of zero, and `>= 99.0` therefore meaning bit for bit.
- **`ExportSettings::sizeFromGraph` lets the graph say how big the picture is.** Off — the
  export — a last pad that is a different size from the render is an error, because the
  writer was opened for one size and saying so plainly beats a scaler quietly resizing
  every frame. On, the sink is asked and the writer is opened for the answer. That is what
  previewing a node in the middle of a graph needs, since nothing outside libavfilter
  knows how big the picture is half way through. **The sixteen-pixel floor it puts under
  the sink's answer is the one case where the canvas is legitimately bigger than the
  frame**, and `GraphSource::canvasAt`'s RGBA fast path — a row-by-row memcpy sized from
  the canvas — read past the end of the frame because of it. The size is part of the test
  now, not an assumption behind it: a frame that is not exactly the canvas goes through
  the scaler, which is where a resize belonged anyway. Reachable in two clicks, from a
  node preview of anything tiny.
- **The parse is `avfilter_graph_segment_*`, not `avfilter_graph_parse2`.** They do the
  same thing; the difference is that the segment API stops between creating the filters
  and initialising them, and that gap is the only moment `-filter_hw_device` can be
  handed over. `hwupload` refuses to initialise without a device and takes no argument
  that could name one, so a device assigned after `parse2` has already come too late —
  "A hardware device reference is required to upload frames to", from inside a parse,
  with nothing saying which filter meant it. This is `graph_parse()` in ffmpeg's own
  `ffmpeg_filter.c` written out; with no device named it is three lines doing what one
  did, which is why there is no fast path here to disagree with.

**The picture that never comes down.** `FrameSource` has two more questions on it now,
both optional and both defaulting to "no": `hwFrames()` — which device pool the pictures
arrive in — and `nativeAt(t)` — the picture itself rather than a canvas. That is the whole
of what encoding straight from the GPU needed from this seam, because a hardware encoder is
*opened against a pool*: `Writer::open` takes the frames context, `avcodec_open2` builds
its surfaces from it, and `writeVideoFrame` hands the graph's own frame to
`avcodec_send_frame` with nothing written on it but the timestamp, the forced keyframe and
the field order. Four things follow and each has a reason:

- **All the composite-fed video streams or none.** A file with one hardware video stream
  and one software one needs the picture in both places at once, which is a download per
  frame on behalf of a render that asked for the opposite. `Writer::open` refuses it and
  names the odd stream.
- **A native render ends when its graph ends.** There is no black frame past the last
  picture, because black would have to be made in system memory and uploaded once a frame.
  `-shortest` is not consulted on this path; it is implied.
- **`rgbaAt` means pixels and downloads whatever it is handed**, whatever the input asked
  for. The two questions have different callers — the compositor asks `rgbaAt`, a graph
  asks `nextRaw` — and an input configured for the graph would otherwise render every clip
  on the timeline as a hole.
- **Rotation on a device needs `transpose_<device>`.** `transpose` reads pixels and a
  `cuda` frame has none, so a feed that is on a device gets the hardware member of the
  family and a build without one refuses with a sentence rather than at graph config.

**A file is a list of streams.** `ExportSettings::streams` is a
`std::vector<ExportStream>` and the writer holds a `std::vector<Out>`;
`outputStreams(settings, wantAudio)` in `export_writer.cpp` resolves every
default in one place, so nothing downstream has to know whether the caller gave
a list. Four things about it are load-bearing:

- **An empty list is not "no streams" — it is the usual two.** `outputStreams()`
  synthesises one video stream from the composite and one audio stream from the
  mix out of the named fields, which is byte for byte the file this renderer
  wrote before the list existed. That is what keeps `make_fixture.cpp`, the node
  previews and every test that predates it untouched, and it is the sentinel the
  UI's `previewSpec()` uses to say "a render about the picture".
- **`ExportStream::source` is `-map` written down.** "composite" and "mix" are
  *composed* sources rather than input streams, which is why they are named and
  not numbered — no input index means "everything, stacked". `copy:0:1` is the
  third answer and it is an input and a stream in it: the writer branches on the
  prefix in `Writer::open` rather than growing a second list beside this one.
  See the packet path below.
- **The list order is the muxer's numbering.** Streams are created in list
  order and there is no second sorting pass anywhere, which is what makes
  `-metadata:s:a:1` mean the stream the UI drew second.
- **A tag is a container's vocabulary, not a codec's.** `hvc1` set in an mp4 and
  then written to Matroska stops the muxer at `avformat_write_header` with
  "Invalid data found when processing input" and no mention of the tag.
  `ui/export/warnings.js` says so before the render; `codecTags()` is what it
  asks.

**A stream that fails to open still has to give back what it opened**, and that
is why `Out` has a destructor rather than a step in `close()`. `close()` walks
`outs_`, and a stream is only put in that list once every part of opening it has
succeeded — so the refusals that happen *after* `avcodec_open2`, which is a
bitstream chain that will not build and a fourcc that is not four characters,
dropped an open encoder, its scaler, its frames and on the hardware path a
reference pinning a device's whole surface pool. Thirty-two goes at the same
refused render grew the process by 88 MB; with the destructor it is under two.
The general shape is worth keeping: **a resource is owned by the object that
holds it, not by the sweep that runs when things went well**, and a half-built
object is exactly the case a sweep does not see.

**And a render that fails says why.** Six paths in the writer returned false
without writing `*err` — three of them `avcodec_parameters_from_context` on
ordinary open paths — and an empty reason is worse than a wrong one: `runPass`
publishes the empty string, `reportNote(AV_LOG_ERROR, "render", "")` commits
nothing because the channel drops empty text, and what arrives is a Failed
render with a blank message and an empty report drawer. `tests/export_test.cpp`'s
`render()` helper now holds the whole suite to it, silently, since every render
in that file goes through it.

**The packet path is a stream that is never made.** `export_copy.*` is the whole
of it: a `CopyStreams` opens one demuxer per input — however many streams are
taken from it, because that is what `-i` means — and pumps packets into the
writer, which puts them through the same bitstream chain and the same
`av_interleaved_write_frame` an encoder's packets go through. It cost the writer
one branch and one field (`Out::srcTimeBase`, an encoder's time base or an input
stream's), because `writePacket`/`drainBsf` were already packet-level and
codec-agnostic. Six things here are load-bearing:

- **There are two loops in `runPass` and only one of them is about frames.** A
  copy is not fed per output frame, so `copies.pumpTo(t)` runs *beside* the frame
  loop, catching up to the frame just written: `av_interleaved_write_frame`
  queues a stream that runs ahead of its neighbours, so writing a whole copied
  track first would hold an hour of packets in memory. `composesAnything()`
  decides whether there is a frame loop at all — a render whose every stream is
  copied never builds a `FrameSource` and never opens a decoder, and its progress
  comes from the copy's own clock with `framesTotal` at zero.
- **Two clocks had to be told apart, and both cost an afternoon.** A packet's dts
  begins a *reorder delay before* the container's `start_time` — 80 ms, two
  frames, in every mp4 this application writes — so measuring a copy the way
  every other reader here measures an input put the first keyframe at −0.08 s,
  outside a window starting at zero, and offered the file's *second* keyframe as
  the first place a cut could start. `streamOrigin()` counts from the stream's own
  first packet instead (index entry zero, or `start_time`). Worse, and separately:
  **mp4's seek takes a presentation timestamp while its index holds decode ones.**
  `mov_read_seek` subtracts the edit-list offset itself before searching, so an
  index timestamp handed to it verbatim searched two frames early, found no
  keyframe, walked *backwards to the start of the file*, and returned success — a
  cut two seconds in silently copied the whole thing. `inputSeekTarget()` is the
  moment as the timeline means it and `streamZero()` is the moment as the index
  reports it; they are different functions on purpose. The first of the two now
  lives in `ffmpeg_input.h`, beside `inputEpoch`, because it is arithmetic on an
  input's clock and three things ask for it.
- **A third reader was on neither clock, and nothing failed.** `export_subtitle.cpp`
  compared a cue's raw container timestamp against a window written on the
  input's clock, while seeking in the input's terms — so the seek and the
  comparison had zeros that differed by exactly `-ss`, and a subtitle input
  trimmed three seconds in wrote every cue three seconds late while dropping
  none of the ones that were no longer in the input. **The lesson is that the
  function telling the two clocks apart already existed and was simply not
  called**: anything that reads packets or cues out of an `-i` is on the
  input's clock, and `inputEpoch` is the one place that says where its zero
  is. It costs nothing when there is no window, which is why every test in the
  suite passed for the whole of the subtitle work. `cueEpoch()` is `SourceVideo`'s and
  `SourceAudio`'s epoch and **not** `streamZero`, deliberately: cues go into
  the same output the composite and the mix go into, so they are placed on the
  clock those are placed on, and `streamOrigin`'s reorder-delay correction is
  for a clock `sub.pts` is not on. Measured, the two agree on every subtitle
  track this suite can produce — an .srt reports no container start at all, and
  mov_text and Matroska both put their stream's origin at zero — so what
  separates them is a container that genuinely starts late.
- **A copy can only start at a keyframe, and the seek is backward.** So it lands
  at or *before* the in-point and can never skip a frame the copy wanted — safe by
  construction, exactly as `ExportGraphInput::from` is. What that costs is the
  caller's to show, which is what `keyframesOf()` and `bro.ffmpeg.keyframes` exist
  for.
- **The first packet decides the file's zero, one zero per input.** Two streams
  copied out of one file keep the offset they had, which is the whole of A/V sync;
  a zero taken per stream would move a soundtrack by however far the picture's
  first keyframe was from it.
- **A packet may be for more than one output stream.** `-map 0:1 -map 0:1` is
  a legal thing to ask for and two rows differing only in their disposition is
  the reason somebody would, so `Reader::pendingTaps` is a list. It was one
  pointer, filled by a search that did not stop, which silently gave every
  packet to one of the two and left the other stream in the file empty — a
  valid file, missing a track. The muxer takes the reference it is handed, so
  every tap past the first gets `av_packet_ref`'d one of its own; one tap pays
  nothing for the general case. Note the windows are per tap all the way down:
  a packet past the end of the first row's span can still be inside the
  second's.
- **A copied audio stream is not the mix**, and the two one-line exceptions that
  say so are not the same kind of claim. `outputStreams()` drops audio streams on
  a silent timeline and must not drop a copied one: that one is **correctness**,
  and without it "replace the audio" and "extract the soundtrack" write a file
  with no streams in it. `Writer::hasAudio()` reporting only mix-fed streams is a
  **performance** guard — mutation-tested, so state it as one: `writeAudio` skips
  a copied stream itself, so counting one costs a decode of every clip's sound on
  behalf of a stream that will never ask for a sample, and changes nothing that
  is written. Both are worth keeping; only the first is worth a test.
- **A codec named on a copied stream is an error.** There is no encoder, so it
  would be a setting that silently did nothing — the failure every option bag in
  this repo is written against. Likewise `avformat_query_codec` returning a
  definite no stops the render with the muxer and the codec both named;
  `AVERROR_PATCHWELCOME` is carried through as the shrug it is.

Two refusals deliberately *do not* live here. A copy conflicting with the edit —
two clips, a filter on the graph, a crop, an output of a different size — is the
UI's, in `ui/export/warnings.js`, because the standing rule is that a refusal
arrives where the decision is made and not at render time.

**`AVCodecTag` is opaque and its tables cannot be walked.** `av_codec_get_tag2`
asks "what tag for this codec here" and `av_codec_get_id` asks "what codec for
this tag here", and there is no third call. So `codecTags()` is the one
capability in this repo that cannot be purely enumerated: the muxer's default
comes from `av_codec_get_tag2`, and the alternates are *candidates* put back
through `av_codec_get_id` against that muxer's own tables before being offered.
Nothing false can reach a caller — `hvc1` appears for HEVC in mp4 and mov and is
absent from Matroska without any of that being written down — but a fourcc
nobody thought to list is a fourcc the menu will not have. `streamDispositions()`
has no such problem: a disposition is a single bit and `av_disposition_to_string`
names it, so asking for every bit in turn *is* the whole vocabulary.

**`ffmpeg_report.*` is the render's back-channel, and what `ui/measure.js` stands on.**
`ExportStatus` answers "how far along"; this answers "what happened". Two
bounded rings behind one mutex, drained through `render.poll(cursor)`:

- **The log.** `av_log_set_callback` — installed once at startup, never
  removed. There is exactly **one** callback in the process and it does both
  jobs, printing through bro's logger and recording here, because two callbacks
  is one callback, whichever was installed last (this replaced the backend's).
  Two thresholds, deliberately different: `av_log_set_level` governs what is
  *printed* (warnings and up, so a windowed build's log stays readable) and the
  ring keeps everything down to `AV_LOG_INFO`, because the detail nobody wants
  while things work is the detail wanted afterwards. **A custom callback is
  handed every level libav emits regardless of `av_log_get_level()`** — the
  check lives in the *default* callback you just replaced — so a trace-level
  filter will drown you unless you test the level before formatting anything.
  Attribution is the `AVClass` on the `ptr` argument (`item_name` gives
  `libx264`, `Parsed_cropdetect_0`, `mp4`); a warning nobody can attribute is
  worth much less than one that names the encoder. **libav writes some lines in
  pieces** — `av_log_format_line2` sets `print_prefix` on the way out to say the
  line ended — so the channel joins on the newline rather than committing a
  record per call.
- **Frame metadata.** Harvested in `GraphSource::pull`, the one place both
  sinks are read from, so *adding a measuring filter to a graph is all anybody
  has to do*. Key verbatim (`lavfi.cropdetect.w`), value, and the frame's own
  timestamp from the sink's time base. Costs one null check per frame when the
  graph is not measuring.

Four properties are load-bearing:

- **Every record carries the render it was said during**, 0 for none.
  `job::claim()` is what numbers it — before the thread exists, which is why
  `startExport` and `startCapture` can hand the number straight back out and why
  `render.start`/`record.start` return a number rather than `true`. The `job::Held`
  guard in the job body is declared *first* so it runs *last*, after the writer's
  teardown — what libav says while a muxer closes a file belongs to the render that
  opened it. Any path that claims and then leaves without starting a thread has to
  use `Held` too; see the note under the job slot.
- **The drain is a cursor, not a flush.** Records are numbered and never
  renumbered, so two consumers cannot take each other's messages and a dropped
  poll loses nothing. It is also why **a render's last words are readable after
  the job is gone**: the rings belong to the process, and draining does not
  touch the job at all — nothing races the teardown.
- **Both rings are bounded and report what they dropped** (512 messages, 8192
  samples). They are sized for the gap between two polls, not for a whole
  series — keeping the series is the consumer's job, and a native buffer big
  enough for an hour of `ebur128` is a leak with a justification attached.
- **The renderer is a speaker too.** `reportNote(level, source, text)` puts the
  render's own words in the same channel at the same levels — the graph running
  at a different rate, a trailer that would not go down after a Stop, the file
  that was written. `poll()` without an argument builds no arrays, so the three
  callers that only want a progress bar pay nothing.

### Inputs

**An input is an `-i`, and one function opens one.** `openInput()` in
`ffmpeg_input.cpp` is the only `avformat_open_input` call left with an argument list
of its own: everything else — the two readers, the playback backend, `probe()` — goes
through it. That is what makes a forced demuxer, an option bag and a window facts
about *an input* rather than four separate features:

- **An option nothing consumed is an error naming the key.** `avformat_open_input`
  hands back the `AVDictionary` entries the demuxer, the protocol and libavformat's
  generic table all declined, which is the one place in libav where "was that option
  used?" has an answer. It is asked, and the open is refused. A demuxer name this
  build does not have is refused too, rather than falling back to probing.
- **`-ss`, `-t` and `-itsoffset` are arithmetic on a reader's clock**, not options —
  libav has no idea about any of them. `inputEpoch()` and `inputLimit()` are that
  arithmetic, in one place, and both readers and the playback source use them: the
  input's zero moves to `ss`, which is precisely what makes an input seek a different
  thing from a clip's in-point. `probe()` reports the window too, so the duration a
  clip's length comes from is the input's and not the file's.
- **`ExportSettings::inputs` is the list and `ExportClip::input` is an index into
  it**, with `resolveInput()` the one place that turns either an index or a bare path
  into a `MediaInput`. A spec whose clips carry paths and no list renders exactly as
  it always did — the fixture generator, the node previews and every hand-written
  spec in `tests/` still do. Same shape as `outputStreams()`, for the same reason.

**An input whose content is assembled needed almost nothing added to the model,
and that is the finding worth keeping.** `-framerate`, `-start_number`,
`-pattern_type` and `-loop` are options of the `image2` demuxer; `safe` and
`auto_convert` are `concat`'s. They reach libavformat through the option bag
above, unchanged from what a command line writes, so an image sequence is not a
feature of this application — it is a demuxer with options, and the Sources
stage edits it as one. Four things *were* missing:

- **`MediaInput::streamLoop` is the one field libavformat has never heard of.**
  `-stream_loop` is implemented in ffmpeg's own CLI by seeking the input back to
  the start when it ends and shifting every timestamp forward by one pass, and
  `InputLoop` is this binary's single copy of that arithmetic. Three things read
  packets — `SourceVideo`, `SourceAudio` and the playback `FFmpegSource` — and
  each holds one, because a soundtrack shifted by a different amount from the
  picture it belongs to is the failure. A pass is as long as the container says
  or as long as the furthest packet seen, so it works on formats that report no
  duration; a seek is mapped into the pass it lands in (`InputLoop::seekTo`)
  rather than the demuxer being asked for a moment it has no idea about.
- **`inputDuration()` is the one place a length is decided**, and it says
  "nobody knows" out loud. An ordinary input is as long as it measured, cut down
  by the window. A *finite* `-stream_loop` is that over again a known number of
  times, which is measurable and is measured. `-loop 1` and `-stream_loop -1`
  never end — libavformat reports one pass, and for a still one frame — so `-t`
  is the whole of their length and **zero when there is no `-t`**. `probeMedia`
  and `FFmpegSource::open` both ask it, because a clip's length comes from it and
  a UI that disagreed with the renderer about it would lay out a clip the render
  will not produce. **Do not replace that zero with a default here**: a chosen
  duration belongs where somebody chose it, which is `-t` on the input.
- **`scanForSequences()` is the guess, and it is mostly refusals.** The number is
  the *last* run of digits in the name; a run of one file is a still; zero
  padding is meaningful and unpadded numbering is not (so `plate1`…`plate12` is
  one `%d` and `007` beside `0007` is two runs); a gap is reported and never
  closed, because image2 stops at the first missing number; folders are read one
  level deep and never crossed. The image extensions are libavformat's own — the
  `image2` muxer's `extensions` string plus every `*_pipe` demuxer's name with
  the suffix off, which is where `webp` and `psd` come from.
- **The concat demuxer reports no duration until something has read to the end.**
  It opens the first file at header time and discovers the rest as it reaches
  them, so a joined input laid out as no clip at all. `writeConcatList()`
  therefore writes a `duration` line per entry, out of numbers the caller got by
  probing each file. Found by measuring, not by reading.

**`globPatternsSupported()` is the only capability in this repo that can be
neither enumerated nor asked directly.** `pattern_type=glob` is in the demuxer's
option table on every build because the table is unconditional; whether it
*works* is `HAVE_GLOB` at compile time and surfaces as `ENOSYS` from
`read_header` and nowhere else. So it is asked by trying, once, on a filename no
filesystem can hold — and behind `LogQuiet`, which is a thread-local mute on the
report channel added for exactly this: a question the application put to itself
is not something a render said.

**`hwDevices()` is the second question of that shape and is muted the same way.**
It finds out what this machine has by creating a device of every type the build
carries and seeing which fail, and every failure is an `AV_LOG_ERROR` from code
that has no idea it is being interrogated — on a machine with NVIDIA cards, `amf`
answers `AMFQueryVersion failed with error 1`. Left in the channel, a render that
went perfectly opens its report drawer red over something said before anybody
pressed anything. Nothing is lost: the reason is `HwDevice::error`, reported by
`bro.ffmpeg.hardware()`, which is where somebody asking about a card is looking.
`LogQuiet` mutes the console as well as the channel, which is right for both of
these and would be wrong for anything a render said.

**How an input's options reach playback, and why it is a token.** bro's `<video>`
takes a src *string* and the media backend is registered generically, so there is
nowhere to pass an options object: the string has to name the input. `defineInput()`
registers one and hands back `/@input/<id>`; the backend's `open` resolves it and
opens the real URL with the real options. Three things that buys, and the third is
the one that decided it:

- two inputs on one file with two different option bags are two different srcs;
- `bro.media`'s filmstrip and waveform go through the same registry one level down,
  so a strip is of the file *as the input opens it* — the registry is process-global
  and mutex-guarded because that decode runs in a Worker, on another thread;
- **a URL could not be a `<video src>` at all.** `Element::resolveUrl` treats a src
  as absolute only if it starts with `/`, `\` or `x:`, so `https://example.com/a.mp4`
  is resolved against the document and becomes a path under `ui/`. The leading slash
  in the token is not decoration — it is why this works without touching bro.

### Recording, and the shape a job with no end has

**A device needed nothing new in `MediaInput`.** It is `-f dshow` naming a
libavdevice demuxer, `-i video=…` naming what it can see, and that demuxer's own
options in the bag `-probesize` already travels in. The whole model change is one
line in `inputIsEndless`: a device never ends, so `-t` is the only thing that can say
how long it is, and with no `-t` the answer is zero — *nobody knows*, which is the
same rule `inputDuration` already applied to `-loop 1`.

**The job machine is where a device is genuinely a new shape.** `runExport` walks
forward from `start` to `end` at a fixed rate asking a `FrameSource` what the output
looks like at `t`, and every part of that is wrong for a device: it cannot be asked
what it looks like at `t` (there is no seeking a camera), it has no `end`, and the
clock is the device's rather than the render's. So recording is a **second job**, not
a flag on the first, and what the two share is what does not care — `Writer`, and the
one slot.

Five decisions here, and they were written expecting streaming *out* to be the second
job of this shape with the ends swapped. It turned out not to be one: a stream is an
ordinary export whose destination is a URL, so it goes through `runExport` and the
protocol does the rest. What it did reuse is the progress vocabulary — bytes sent and
a bitrate rather than a percentage — which `ui/export/progress.js` reaches by treating
a `stream` destination as open-ended in JS, since the native job has an end and knows
it. The five stand as the rules any job with no end gets wrong the same way:

- **The slot lives in `ffmpeg_job.h`, owned by neither job.** It carries the three
  rules that both of them get wrong in the same way if left to remember: the slot is
  freed *before* the terminal status is published, a terminal state is published once
  at the bottom after the file is closed, and `job::Held` frees the slot however the
  job leaves. `startExport`/`exportStatus`/`cancelExport`/`waitForExport` are now
  forwarders. **`Slot`'s destructor joins**, because a function-local static holding a
  joinable `std::thread` calls `std::terminate` at exit — which reads as "the last
  thing it printed crashed" and is nothing of the kind.
  **`claim()` takes two things and `Held` gives back two**: the slot, and a number in
  the report channel that every `av_log` line said from here on is stamped with. Any
  path that claims and then leaves without starting a thread has to use `Held` rather
  than calling `release()` on its own — `startCapture`'s device-open failure was doing
  the latter, so the channel's job number stayed set for the rest of the process and
  every line said afterwards by anything at all was attributed to a recording that
  never happened. Nothing fails and nothing is slow; every surface reading the report
  is quietly wrong, which is the only kind of bug a report channel can have.
- **Stop is the *normal* end of a recording**, so a stopped recording reports `Done`.
  A render is `Cancelled` because something was abandoned; a recording's length was
  the open question and stopping answered it. Reporting `Cancelled` would make every
  successful recording look like a mistake and make the one case worth
  distinguishing — a recording that *failed* — indistinguishable from the ordinary
  one. A streamed output will want the same reading.
- **Progress is elapsed and size, and there is no percentage.** `framesTotal` stays
  0 and `ExportStatus::openEnded` says so, which `render.poll()` reports. Zero
  meaning "nobody knows" is deliberately the same convention `inputDuration` uses, so
  there is one rule in this binary rather than two. Given a `-t` there *is* a total
  and then the fraction means something — which is why the UI reads `openEnded`
  rather than assuming.
- **A cancelled render's trailer discipline matters more here, not less.** A render
  that lost its index has lost a file that can be made again; a recording that lost
  its index has lost the only copy of something that happened once. `Writer::finish()`
  runs every step whatever failed before it, and it is called on every path.
- **One slot means no preview and no export while recording, and that is right.**
  Not a limitation left in: a capture is the only job in this application with a
  real-time deadline and it cannot be re-run, so it gets the machine. An encode
  competing for the same cores is how a capture comes to drop frames. The UI refuses
  the other stages with the reason rather than offering a door that will not open.

The read loop itself is worth two notes. Frames are **placed** rather than counted —
the device's own timestamp becomes an output frame index — so the file is constant
frame rate whatever the device did, and a stall **holds the last picture** rather
than leaving a gap, because a jump in the muxer's timestamps reads as a corrupt file
in several players. And **the recording's zero is the first picture**: sound that
arrived before it is dropped to the sample, because letting it in would put the whole
soundtrack ahead of the picture by however long the camera took to wake up.

One limitation to know before extending this: `job::stopping()` is only checked
between `av_read_frame` calls, so a device that has stalled is not stopped until its
next frame arrives. At 10–30 fps that is under a tenth of a second. A device that has
been unplugged is a different matter and is what `rw_timeout` is for.

**A render is a list of passes, and an empty list is one pass that overrides
nothing.** `ExportPass` is the render with overrides — a graph and its inputs, an
option bag merged on top, an encoder, a destination, or `discard` for `-f null -`
— and `runExport` loops over them, `runPass` being the old body. Four things:

- **A pass is not a job.** One claim on `ffmpeg_job.h`'s slot, one thread, one
  Stop, and one terminal status published after the *last* pass closed its file.
  Giving the second pass its own claim would open a window between them where
  `render.start` would be accepted — exactly the race the export preview's
  chaining already lives in.
- **`ExportStatus::pass`/`passCount`/`passLabel`** are how the status stays
  honest about being two things to the machine and one thing to a person.
  `progress` runs across the whole job; `framesDone`/`framesTotal` are the
  pass's, because that is what the encoder is doing and a count that restarted
  half way would be the confusing one.
- **A pass that names its own encoder starts from an empty option bag.** An
  option table belongs to an encoder, and carrying x264's `preset` onto
  `wrapped_avframe` is an unknown option — an error here, and rightly. A pass
  that keeps the encoder is *adding* to what it was set to, which is what
  `-pass 1` means.
- **The handoff between passes is a file on disk, always.** `vidstabdetect`
  writes a `.trf` that `vidstabtransform` reads; `-pass 1` writes a statistics
  log that `-pass 2` reads. Nothing crosses between passes in memory, which is
  why the mechanism is this small. **The encoder two-pass built on it is
  `passes: [{label:"pass 1", videoOptions:{pass:"1", passlogfile:X}, discard:true},
  {label:"pass 2", videoOptions:{pass:"2", passlogfile:X}}]`, and it needed nothing
  new here** — `ui/export/spec.js`'s `passesFor()` writes exactly that, and
  `export_writer.cpp` takes the two keys out of the bag. `tests/export_test.cpp`
  proves the shape both ways: with the graph, by having pass one write an
  intermediate file and pass two read it (vidstab itself is a `--enable-` this build
  lacks), and with the encoder, by requiring a real two-pass ABR render to hit its
  bitrate target more closely than one pass at the same target.

**A destination is not always one file, and `export_writer.cpp` is where that is
known.** One `Writer` is one *muxer*; it was the same thing as one file until four muxers
said otherwise — `segment` and `image2` write a numbered run, `hls` and `dash` write a run
and a playlist naming it, `tee` writes the same packets to several places at once. Five
things about how that is handled are load-bearing:

- **What a render wrote is asked of libavformat, through `AVFormatContext::io_open`.**
  That callback is what *every* output goes through: the primary file, each segment, each
  DASH chunk, each `tee` slave, each numbered picture. It is the seam ffmpeg's own CLI
  overrides (`oc->opaque` carries the object; libavformat never touches that field), so
  hooking the `io_open`/`io_close2` pair gives the names, the count and the sizes without
  a second implementation of anybody's numbering scheme. It also survives a muxer changing
  how it numbers things, which `sizeOnDisk`'s pattern walk — still there as the fallback —
  would not. **A file opened twice is one file**: `hls` rewrites its playlist every segment
  and would otherwise be counted forty times.
- **`ExportStatus::piecesWritten` counts what was opened *beside* `path`.** Zero for an
  ordinary render, so nothing has to know segmenters exist; the segments, the chunks, the
  pictures, the tee destinations otherwise. And `bytesWritten` is **on disk for a file and
  sent for a URL** — the io_close hook stats a local path after the close (which is the
  only correct answer for an mp4 that `+faststart` rewrote) and takes `avio_tell` for
  anything else.
  **A working name a muxer renames onto the destination is not a piece**, and one muxer
  makes that a real case: hlsenc writes its playlist through `out/hls.m3u8.tmp` and
  renames it, so the one URL the exclusion is *for* reaches `io_open` spelt differently
  and was counted as an extra segment. `Writer::resolveRenames()` folds it back in
  `finish()`, after every close and therefore after every rename, by asking the
  filesystem rather than knowing which muxers use which suffix: a local piece that is
  gone, where `path` is there and nothing in the list claims to have written it, is the
  pair of facts a rename leaves behind, and a segment, a chunk, a picture and a tee
  slave are all still on disk. Exactly one missing, or none — several missing is
  `hls_flags delete_segments` doing what it was asked, and guessing would be worse than
  leaving the count one high. `Writer::pieces()` is how a caller answers "which files",
  which is the only way to check a count without re-deriving somebody's numbering.
- **`formatOptions` is one bag and two objects, split in `open()`.** At the reading end
  libavformat hands a demuxer's leftovers down to AVIO, and the Sources stage says so.
  Writing cannot work that way because the order is reversed — `avio_open2` runs *before*
  `avformat_write_header`, and an `AVFMT_NOFILE` muxer opens its files later still, from
  inside libavformat. So the split is made once, by asking the format context which keys
  it has (`av_opt_find` with `AV_OPT_SEARCH_CHILDREN` reaches the generic table and the
  muxer's private one); what it does not know is stashed and merged into every
  `avio_open2`. **An unknown key is still an error**, in three places: unconsumed by the
  muxer, unconsumed by the protocol (carried out of the callback, which cannot refuse, to
  `open()` which can), and — for a muxer that opens nothing at all, which is what `-f null
  -` is — reaching nothing.
- **`io_open` gives the caller back only what the protocol did not take.** That is what
  the callback is defined to do, and `tee` is the one that notices: its slave options go
  through here on the way to a muxer, and a protocol option still in the bag afterwards is
  reported by the slave as an unknown muxer option.
- **Encoders take `AV_CODEC_FLAG_GLOBAL_HEADER` for `AVFMT_NOFILE` muxers as well as
  `AVFMT_GLOBALHEADER` ones.** A muxer that does not write the file it was named with —
  `tee`, `segment`, `hls`, `dash`, `rtp` — cannot answer for the format that eventually
  receives the packets. The safe answer is to have the extradata: a muxer that wants the
  parameter sets in-band gets them from its own automatic bitstream filter, and one that
  wants them up front has nowhere else to look. **This is not a table** — the flag is the
  question — and it was found the hard way: matroska behind a `tee` fails at
  `write_header` with `Invalid data found when processing input` and no mention of
  extradata anywhere in it.

**What subtitles inherited from this, and it was nearly everything.** Nothing here
narrowed the stream list: `ExportStream::kind` is a string and `source` is where the
content comes from, so `"subtitle"` slotted in beside `"video"`, `"audio"` and
`"attachment"` with a fourth `openXStream()` and no change to the shape. Three things
carried straight over — a copied stream already reached the muxer without an encoder,
which is what extracting or rewrapping a subtitle track is; `piecesWritten` and the
`io_open` hook already accounted for a muxer that writes a sidecar (`-f webvtt` beside
an `hls` render is exactly that shape); and `kindOf()` on the Write stage already said
when the destination is a set, which is the case where a subtitle track becomes a
separate playlist rather than a stream in the file. What had to be added was a source
that decodes: `decode:<input>:<stream>` beside `copy:`, and with it the one subtitle
decoder and the one subtitle encoder this binary opens. See **Subtitles are the fourth
stream kind** below for what that cost.

**`tee` is the muxer, not two `Writer`s, and the reason is what `tee` means.** Chunk 12
sketched two writers fed from one `FrameSource` and the seams do allow it — but `tee` is
*one encode to several places*, and two writers are two encoders on the same frames:
twice the CPU, and two files that are supposed to be the same bitstream in different
wrappers are two different bitstreams. The muxer does what the name means. The seam is
still there for the day something wants two genuinely *different* encodes, which is a
different feature (the `passes` list already expresses it sequentially) and is not built.

`registerFfmpegBackend()` must run **before** the `Engine` is constructed (see `main.cpp`
and `headless_main.cpp`), so the first `<video>` in the first document already finds it. It
registers a `bro::video::MediaBackend` at **priority 100**, above bro's built-in WebM
backend, which is why `<video src="anything.mkv">` just works and why every container goes
through one set of seek/timestamp/reordering semantics.

`ffmpeg_bindings.cpp` installs `bro.ffmpeg` (`probe`, `version`, `hwaccels`,
`openOnStart`, `encoders`, `muxers`, `demuxers`, `decoders`, `protocols`, `devices`,
`filters`, `bitstreamFilters`, the seven `*Options(name)` lookups, `deviceSources`,
`keyframes`, `inputs.*`, `render.*`,
…) via `EngineConfig::installHostBindings`, so it exists in every realm including
workers. `probe()` is synchronous on purpose, and takes an input rather than only a
path — probing wrong is the reason demuxer options exist, so a Sources stage showing
what libavformat's defaults made of a file while the render opened it with `-f` and a
`-probesize` would be describing a different file. `inputs.define/forget/token` is the
playback registry; the ids are the UI's and the tokens are opaque strings to it.

**The rule for what is built at startup and what is asked for on demand is the size of
the answer, and the option tables are always the expensive part.** The registries —
182 muxers, 364 demuxers, 532 decoders, 488 filters, 50 bitstream filters — are names,
long names, extensions and flags, and are built once per process (function-local statics
in `ffmpeg_capabilities.cpp`) and converted per realm. Every option table is a function:
`encoderOptions`, `muxerOptions`, `demuxerOptions`, `decoderOptions`, `protocolOptions`,
`filterOptions`, `bsfOptions`. Building all of them at startup was most of a second before the window
opened when it was only the filters.

**`optionsOf()`'s `require` flag has to be zero for a bitstream filter.** Every other
walk narrows by direction — `AV_OPT_FLAG_ENCODING_PARAM` for an encoder,
`FILTERING_PARAM` for a filter — because without it the table offers options the object
does not take. A bsf's options carry none of those bits at all, so asking for one
returns an empty table and the chain editor looks like it has nothing to configure.

**Four things about the non-encoder capabilities are load-bearing:**

- **A muxer is identified by its name, never by an extension.** `-f matroska` is what
  ffmpeg is told; nothing in libavformat is called "mkv", 47 muxers have no extension at
  all and several share one. So `ExportSettings::format` carries the name and
  `Writer::open` passes it to `avformat_alloc_output_context2`; the extension is a
  consequence (`MuxerOption::ext`, the first of `extensions`) and is what a file gets
  called. **A spec with `path: "x.mkv"` and `format: "mp4"` writes an mp4**, exactly as
  `ffmpeg -f mp4 out.mkv` does — which caught `tests/ui_export.js` out, and is why
  `buildSpec()` sends `format` and `withExtension()` is called whenever the muxer changes.
- **`avformat_query_codec` has three answers, not two.** Yes and no come from a muxer's
  `query_codec` function or its codec tag table; a muxer with neither returns
  `AVERROR_PATCHWELCOME` for everything except the codecs it names as defaults, and that
  means *not taught to answer*. Over the four containers the old table held it never came
  up; over 182 it does — mpegts is one — and reading the shrug as "no" makes the app
  insist MPEG-TS will not hold H.264. `MuxerOption::answersCodecs` carries the
  distinction, the codec lists are *everything offered* when it is false, and the UI says
  "does not say". Do not collapse this back to a boolean.
- **Two muxers can share a name.** "matroska" is both the Matroska muxer and the Matroska
  Audio one, and `-f matroska` reaches the first because that is what `av_guess_format`
  returns — so the second is not a duplicate row, it is a row that cannot be chosen.
  `availableMuxers()` drops it.
- **`avdevice_register_all()` must run before anything enumerates.** libavdevice registers
  gdigrab and dshow *as* formats, so without it they are absent from `av_muxer_iterate`,
  from `av_demuxer_iterate` and from `av_find_input_format` — not merely unlisted but
  unopenable. `registerFfmpegBackend()` calls `registerDevices()`, and every enumeration
  in `ffmpeg_capabilities.cpp` calls it again through a `std::once_flag`.

The encoder menu is a named list *plus every muxer's own default encoder*, which is what
makes gif, image2, mpegts and the raw writers pick-able at all. That second half is asked
of libavformat, so it grows with the build.

**`image2` is the one muxer whose extension names a codec rather than a container.**
`.png` is PNG data and `.bmp` is BMP data through the same muxer, which is the opposite
of how every other extension in libavformat works — so `guessEncoder()` wraps
`av_guess_codec`, the call ffmpeg's own CLI uses, and `ui/export/form.js`'s
`followExtension()` applies it *only* for image2. Without it every picture render
inherits image2's declared default of mjpeg whatever the file is called. Do not
generalise it to other muxers: elsewhere the extension is the container and the encoder
is a decision of its own.

`avformat_query_codec` for *attachments* does not exist and there is no flag for it
either — ffmpeg's own CLI adds the stream and lets the muxer complain — so
`ui/export/warnings.js` names Matroska and WebM. It is the second place in this repo
where a capability genuinely cannot be asked for (the first is `codecTags`' candidate
fourccs, since `AVCodecTag` is opaque). Both say so where they do it.

`ffmpeg_export.cpp` is the encode half: decode each clip → composite into an RGBA canvas →
swscale to the encoder's pixel format → encode → mux. It owns its own readers rather than
going through `bro::video` — export walks strictly forward at a fixed output frame rate,
which is a different access pattern from playback, and it needs the audio of every clip at
once to mix. Notable:

- **One job at a time**, on a `std::thread`, with a mutex-guarded `ExportStatus`. The UI
  polls (`render.poll()`) from its rAF loop; nothing calls back into JS, because QuickJS is
  single-threaded and a callback would have to be marshalled anyway.
- **Sources are converted to RGBA before being cropped**, so a crop is a pointer offset with
  no chroma-alignment rounding. The conversion is cached against the decoded frame, so a
  30 fps render off a 60 fps source converts each picture once.
- **Encoder capabilities are queried, never assumed** — `avcodec_get_supported_config` for
  pixel/sample formats and sample rates, `av_opt_find(..., AV_OPT_SEARCH_FAKE_OBJ)` to ask
  whether an encoder takes `crf`/`preset` before there is a context to ask about, and
  `av_opt_next` over an encoder's `AVClass` to enumerate its whole option table (which is
  what `encoderOptions()` returns and what the workspace's advanced column is drawn from).
  Walking an `AVClass` with no instance of it works by passing `&cls` to `av_opt_next`.
- **Settings past the codec are `ExportOption` key/values**, applied with
  `av_opt_set(ctx, k, v, AV_OPT_SEARCH_CHILDREN)` — the same path the ffmpeg CLI uses for
  its `-key value` arguments, reaching both generic `AVCodecContext` options and private
  ones. The UI's friendly controls *produce* those pairs, so a slider and the raw editor
  are one mechanism and cannot drift. Applied last, after the named convenience fields, so
  an explicit option wins. **An unknown key is an error, not a shrug** — a render that
  succeeds while ignoring what it was told is the worst of the three outcomes.
- **A cancelled render still writes its trailer.** An MP4 with no index opens nowhere.
  Two things this needs, and both of them were wrong for a while, in a way that only
  showed up as an intermittently unopenable file after a Stop:
  - **A terminal state is published once, at the bottom, after the writer has closed the
    file.** A cancelled render already carries its state when it leaves the frame loop, so
    the `setStatus` that marks the *stage* "finishing" must not run for it: saying
    "stopped" while the trailer has yet to go down is a window as long as finishing takes
    — for an mp4 with `+faststart`, a whole second pass over the file — and the obvious
    act on seeing "stopped" is to open what was made.
  - **`Writer::finish()` runs every step and writes the trailer whatever failed before
    it.** Returning at the first failure was the obvious shape and the wrong one: a render
    stopped after a second has an audio FIFO holding less than one encoder frame, draining
    it can fail, and the file was then closed with no moov — losing everything rendered to
    save the last few milliseconds of sound. Whichever step failed is still reported.
- **The run slot is freed *before* the terminal status is published.** Anything polling
  acts the instant it sees `done`, and the obvious next act is another render — which is
  what the preview does, chaining a lossless reference into the candidate. Cleared
  afterwards, there is a short and perfectly reachable window where the status says
  finished and the next `startExport` is refused as "already running".
- **Output size is stat'd from the file, not taken from `avio_tell`.** `+faststart`
  rewrites an mp4 after the trailer goes down; the write position left behind reported
  three kilobytes for a file of three quarters of a megabyte.
- **A `yuvj*` pixel format is the statement that the picture is full range**, so the
  writer does not also say limited range alongside one. mjpeg is the encoder that
  refuses the contradiction, and it refuses it as `EINVAL` from `avcodec_open2` —
  which arrives as "cannot open the mjpeg encoder: Invalid argument" with no mention
  of colour. Reachable in two clicks, because picking image2 lands on mjpeg.
  **`outputColor()` in `ui/graph/derive.js` carries the same term**, or the command
  bar prints `-color_range tv` and `out_range=tv` for a render that tags and converts
  to JPEG range — copy that command and you get a different picture. Only an explicit
  choice reaches it: left on auto the writer takes `pickPixelFormat`, which prefers
  `yuv420p` wherever the encoder has it, and mjpeg does.
- **Output size is measured over the run of files, not stat'd from the path.** A
  render into `out%04d.png` writes many files and there is no file called that;
  `Writer::sizeOnDisk` walks the names from the muxer's own `start_number` — asked
  of `oc_->priv_data` before `close()`, because only image2 knows what it was told —
  and stops at the first one that is not there.
- **The convenience rate fields stand down when the option bag names a rate control**,
  and this is *not* the same thing as the bag being applied last. `crf` is a private
  option and `b` is a generic one, so they do not overwrite each other: the writer set
  `crf` from `ExportStream::crf`, the bag then set `b`, and x264 picked CRF — so every
  render the UI made at a bitrate target came out byte for byte identical to the
  constant-quality one, silently, with the command bar printing `-b:v 200k` throughout.
  `bagSetsBitrate`/`bagSetsQuality` are the guard, and `tests/export_test.cpp` requires
  a bag bitrate to produce a different file from the crf. **Anything else added here
  that writes to `priv_data` has the same hazard**: applied-last only wins where the two
  writes land on the same option.
- **Profile ids are numbered per codec.** Do not resolve `codec->profiles` against the
  generic `profile` option's constants: VP9's profile 2 and HEVC's Main 10 are both 2, and
  that "translation" confidently offered `main10` as a VP9 profile. Profiles come from the
  encoder's own private enum, or from x264/x265's documented vocabularies, or not at all.

**Subtitles are the fourth stream kind, and the only one with no composed source.**
`ExportStream::kind` gained `"subtitle"` and `ExportStream::source` gained one form —
`decode:<input>:<stream>`, beside `copy:<input>:<stream>`. That pair is exactly the
distinction ffmpeg's command line draws between `-c:s copy` and `-c:s mov_text`: the
`-map` is the same either way and what differs is whether anything is decoded. There is
no third form and there must not be, because a picture is *made* here (the canvas) and a
soundtrack is *made* here (the mix) and there is nothing in this binary that makes cues.

Six things about `export_subtitle.*` are load-bearing:

- **A cue is not a frame**, so `SubtitleStreams::pumpTo` is driven beside the frame loop
  exactly as `CopyStreams::pumpTo` is — up to the time of the frame just written, which
  keeps the muxer's interleaving sane. A render whose only stream is subtitles has no
  frame loop at all and is driven by the cues, which is what "extract them" and "convert
  the format" both are. **And it is driven in *output* seconds**, so `Tap::at` is where
  a cue lands in the file and not where it sat in the input — the two differ by the
  input's window and by `copyFrom`, and a tap reporting the wrong one either stops
  pumping early or never stops.
- **A cue is placed on the input's clock, which is `cueEpoch`.** See the note on
  telling two clocks apart under the packet path: a cue arrives with the container's
  raw timestamp on it and the window it is judged against is the input's, so the
  epoch has to come off before anything is compared or written. Every seek, every
  window and every timestamp in this file is on that one clock now.
- **The loop that drives a render with nothing composed in it keeps its own clock.** It
  used to advance half a second past wherever the copy had reached, which works while
  packets are dense and hangs the moment they are not: a subtitle track writes its first
  cue at output zero and then has nothing until four seconds, so the position stayed at
  zero, the window stayed at half a second, and it asked the same question forever. This
  is a hazard for anything sparse, not only for subtitles.
- **The decoder's `subtitle_header` becomes the encoder's.** An ASS file's styles — the
  fonts, the colours, the margins, the resolution every position is measured against —
  live in the header and not in the cues, so an `ass`→`ass` pass that opened a fresh
  encoder keeps every line of dialogue and silently loses how all of it looks.
- **Timing is the packet's, not the subtitle's.** `avcodec_encode_subtitle` refuses a
  non-zero `start_display_time` outright and every text encoder ignores `pts`; the moment
  a line appears is `pkt->pts` and how long it stays is `pkt->duration`. So a cue leaves
  `SubtitleStreams` as two millisecond stamps and the stream's `srcTimeBase` is `1/1000`,
  which puts it through the rescale `writePacket` already does.
- **Text and pictures are not interchangeable**, and the pairing is refused *by name*
  before anything opens rather than arriving as "Bitmap subtitle required" at the first
  cue. Which family a codec is in is libavcodec's `AV_CODEC_PROP_TEXT_SUB`, reported
  through `CodecOption::textSub`.
- **A muxer's declaration and a muxer's answer are different facts.** mp4's
  `subtitle_codec` is `AV_CODEC_ID_NONE` in this build while `avformat_query_codec` says
  it holds `mov_text` — so `defaultSubtitleEncoder()` uses the declaration where there is
  one and asks the registry where there is not, preferring a text encoder because mp4
  also accepts `dvdsub` and that is first in libavcodec's order. Both the writer and
  `MuxerOption::subtitleCodec` go through that one function, so the picker and the render
  cannot disagree.

Burning subtitles in needed **no native work at all**: `subtitles=` is an ordinary
libavfilter filter, this build has libass (verified — `subtitles`, `ass`, `drawtext` are
all in `availableFilters()`), and `GraphSource` parses whatever it is given. The UI side
is `ui/export/subtitles.js`, which owns `filterPath()` — the escaping — because a
filtergraph separates a filter's arguments with `:` and a Windows drive letter therefore
makes `subtitles=` unusable with an error message that names half a path and never
mentions the colon. One function, called at the moment a node is *made* — the Sources
panel's `As a filter` line and the burn-in shortcut — so that what is stored on the node
is one string escaped once, which the graph, the render and the command bar then all
read verbatim.

**Four things reach the output that are not options of an encoder or of a muxer**, and
each one needed a named field rather than a key in a bag. They are worth knowing as a
group, because the group is what the option bags cannot express and the next thing that
looks like an option may well belong here:

- **`-pass` and `-passlogfile` are ffmpeg's own**, taken *out* of the video option bag
  by `takeOption()` before it is applied, exactly as the ffmpeg CLI treats them as its
  own rather than the encoder's. They travel in the bag because that is where a command
  line puts them; handing either to `av_opt_set` would be an unknown option, and an
  unknown option is an error here.
  **Which mechanism carries the statistics is asked of the encoder, never listed:**
  `hasOption(codec, "stats")` is true for x264, which keeps its own log and is handed
  the filename; everything else uses libavcodec's generic pair, `stats_out` appended
  per packet and `stats_in` pointed at a `std::string` owned by the `Out` (and detached
  before `avcodec_free_context`, so nothing has to know whether libavcodec would have
  freed it). Two traps: **a pass 2 whose log is missing must be refused on *both*
  branches** — x264 left to find out for itself fails at `avcodec_open2` with "Generic
  error in an external library" and no mention of a statistics file — and **an encoder
  that fills neither `stats_out` nor a `stats` option cannot be detected in advance**,
  so a pass 1 that wrote nothing warns naming the encoder. That is the third place in
  this repo where a capability genuinely cannot be queried.
- **`-force_key_frames` sets `pict_type = I` on the frame** before it goes in, which is
  the whole of what ffmpeg does with it. Both forms are parsed with libavutil's own
  tools — `av_parse_time` in duration mode, `av_expr_parse` over ffmpeg's own variable
  names — so an expression copied out of the documentation means here what it means
  there. **The times are seconds into the output, not into the timeline**; whoever knows
  there was a range subtracts its start, and `ui/export/options.js` is the only thing
  that does. `source` and `chapters` are refused with a sentence, because this render
  composites and has no input packets to take keyframes from.
- **A field order is two statements that travel together**: `enc->field_order` plus
  `+ildct+ilme`, *and* `AV_FRAME_FLAG_INTERLACED`/`TOP_FIELD_FIRST` on every frame
  (`Out::frameFlags`, applied in `writeVideo`). Setting only the first writes a file
  that claims to be interlaced and is not.
- **`-shortest` is `FrameSource::exhausted(t)`, asked *after* `canvasAt`.**
  `GraphSource` does not know its last input has ended until a pull has come back
  empty, so the frame that discovered it is the black one this exists to stop being
  written — a question asked before the canvas would always be one frame behind.

**Bitstream filters are a chain per stream, built with `av_bsf_list_*`**, so what runs
is what a comma-separated `-bsf:v` runs and `av_bsf_list_finalize` hands back one context
whether there is one filter or five. Two things about it are load-bearing:

- **The muxer is told about the far end of the chain, not the encoder.**
  `avcodec_parameters_copy(st->codecpar, bsf->par_out)` and `st->time_base =
  bsf->time_base_out`, because `h264_mp4toannexb` rewrites the extradata out of all
  recognition and `hevc_metadata` can change the profile. A header written from the
  encoder's parameters describes something that is not in the file.
- **The chain gets its end-of-stream when the encoder drains.** `AVERROR_EOF` from
  `avcodec_receive_packet` sends a null packet into the bsf and drains what falls out;
  without it a filter that buffers loses its last packet.

**Decoder options live on `MediaInput`, because a decoder belongs to an `-i`.** One
`openDecoder()` in `ffmpeg_input.cpp` is the only place a decoder is opened in this
binary — both export readers and both playback decoders — so `-skip_frame nokey` is the
same decision on the timeline and in the file. Applied through an `AVDictionary` rather
than `av_opt_set` for the reason the demuxer's are: a dictionary is the one call that
reports back what nothing understood. `TrackPrivate` carries the whole `MediaInput`
because a playback decoder is built from a `TrackInfo` long after the source has left
the stack. **And they are checked in `runPass` before a frame is written**
(`checkDecoderOptions`), because the compositor deliberately renders an unopenable clip
as the hole it is — right for a file that has gone missing, wrong for a setting somebody
typed, and the two cannot be told apart down where the clip is opened.

**`encoderOptions()` returns the encoder's own table *and* libavcodec's generic one**, as
`muxerOptions`, `demuxerOptions` and `decoderOptions` always did. It did not, and was
short by ninety options — `flags` (where `+ildct`, `+ilme` and `+cgop` live), `g`, `bf`,
`maxrate`, `bufsize`, `threads`, `thread_type`, `field_order`. Note the knock-on: `hasOpt`
in `ui/export/capabilities.js` now sees `maxrate` on every encoder, so the "capped
average" rate mode is offered wherever it works rather than only where an encoder has a
private `rc`.

**Licensing is a structural constraint, not a footnote.** libav* may only reach bro through
`bro::video`'s codec-agnostic interfaces. Never add an ffmpeg dependency to anything under
`../bro` — bro stays MIT and ffmpeg-free; this binary is the GPL one.

### UI side

`ui/inputs.js` and `ui/project.js` are the model: the `-i`s, and what is on the
timeline. **A clip references an input rather than carrying a path** — what is opened,
with which demuxer, with which options and over which window is the input's business,
and two clips cut from one file are two clips of one `-i`. Six rules there are
load-bearing:

- **The index in `inputs` is the `-i` number.** `buildSpec()` sends the whole list and
  a `clip.input` index into it, the graph's input nodes carry the same index, and
  `graph/print.js` returns `inputRefs` so the command bar can put `-f`, the demuxer's
  options, `-ss`, `-to` and `-itsoffset` **in front of** the right `-i`. Nothing may
  reorder the list under a spec built from it. All of them are sent, including the
  unused ones: dropping those would renumber the rest.
- **An input with no clip is an ordinary state.** Nothing garbage-collects the list
  against the timeline, and `Use on the timeline` is an action rather than a
  consequence. Removing one is refused while a clip is cut from it, because a clip
  with no input has nothing to decode.
- **A clip's `src` is the input's token, not its path**, and `applyInput()` puts the
  input's answer back into the clips when it is reopened — including the length, since
  `-ss 30` on a ten-second input leaves nothing to lay out. `app.js` rebuilds the
  `<video>` rather than re-pointing it: the element *is* the decoder, and it is
  holding the file as it was opened before.
- **`ui/sequence.js` turns a drop into inputs, and `kindOf()` is derived, never
  stored.** A sequence is a path with `%04d` in it, a still is an image file that is
  not one, a concat input is `-f concat` — all three are consequences of the path,
  the demuxer and the option bag, so a `kind` field would be a second place for the
  same fact to live. `openables()` is the one route a drop takes; `typedSpec()` is the
  same rules for a path typed in or named on the command line, so `open()`,
  `openBatch()` and the Sources stage's Add cannot come to three different answers
  about what a `.png` is. **The batch-becomes-a-grid count is taken after the
  grouping**, or a folder of three hundred frames would be three hundred tracks.
- **Two numbers in `ui/sequence.js` are decisions and are written into the input's own
  option bag.** A sequence's `-framerate` (25) and a still's `-loop 1 -t 5`. They live
  there rather than anywhere private so the command bar prints them and the Sources
  stage edits them — which is the whole answer to "where does a still's duration come
  from": from where somebody chose it. `app.js` refuses to lay out an input whose
  length is zero and says which of the two reasons it is, because a clip of nothing is
  worse than a sentence.
- **`graph/model.js`'s `add()` copies only the fields it knows.** That is the right
  rule — a stray field on a spec must not quietly become part of the model — and it is
  why an input node's index arrived as -1 and the command printed no `-f` at all until
  `input` was added to the list. Anything new on a node has to be added there too.

`ui/project.js` is the single source of truth for the edit: clips, selection, the
output canvas, the layout mode. Everything else reads it and nothing else.

**No markup in strings.** Structure that repeats lives in a `<template>` in `index.html`
and is cloned; everything else is built with the helpers in `ui/dom.js` (`el`, `div`,
`span`, `put`, `select`, `segmented`, `fromTemplate`, `row`, `head`). Two reasons beyond
taste: a value interpolated into a template literal has to be escaped by hand and only
ever is until someone forgets, and markup rebuilt as a string throws away its elements, so every
listener has to be found and re-attached in a second pass — a pass that is free to drift
out of step with the first. Controls here carry their own listeners, made in the same call
that makes the control, so a control that moves between panels takes its behaviour with it.

**Five bugs this app found in bro, each of which cost an afternoon. Four are fixed
upstream** — bro `87d60e5` and htmlayout `2f881f7` for the first three, and the shutdown
order in `Engine::~Engine` for the fourth — so this app needs a bro at least that new.
The fifth is worked around here. What the fixes were, and what the code here still does
about them:

- **`getElementById` went stale on a redraw.** The index kept one element per id and erased
  by the id *string*, so removing an element unregistered whatever element currently
  answered to it; a redraw that built its replacement before clearing what it replaced
  registered the new element and then had that registration thrown away. Elements were in
  the tree, `querySelector` by class found them, and `getElementById` denied them; after a
  second redraw it handed back the previous element, detached and wired to nothing. The
  index is now a cache that only answers with an element still carrying the id and still in
  the document, and asks the tree when it cannot. **Two habits here outlived the bug and are
  worth keeping**: `put(node, () => [...])` takes a builder rather than a list, so the old
  content is cleared before the new is built — which is the order that makes sense whether
  or not the engine minds — and dynamic elements are marked with classes (`.pv-ref`) or
  `data-f` attributes rather than ids, which is what lets several of them exist at once
  without inventing unique names. Tests select the same way:
  `document.querySelector('#st-write [data-f="path"]')`.
- **A `<span>` that is a flex item wrapped its own contents.** The seam between two inline
  boxes — the space in `<span>AAA</span><span> BBB</span>` — was counted by neither of them
  when their widths were summed, so the item's max-content width came out one space too
  narrow and the second box fell to a second line. It looked like a flex item not laying its
  inline children out. Fixed in htmlayout's intrinsic sizing; the workarounds it prompted
  (making a row's children direct children of the flex row) are harmless and can stay.
- **Nothing could measure itself in the turn it was created in.** Layout ran on the frame
  loop, so `getBoundingClientRect` answered about the DOM as it was before the last edit.
  Geometry reads now flush pending layout the way CSSOM requires, so measuring an element
  built a line ago is correct. The build/measure split that this forced — the range strip's
  `drawStrip` (build once) and `paintStrip` (measure and paint) — is still the right shape
  for a different reason: the strip repaints when the *stage* resizes, which is not when it
  was built. Anything that genuinely needs a frame to have happened (a rendered video's
  first picture, a screenshot) still has to wait for one.
- **The engine outlived its own audio engine by one member.** `~Engine` reset
  `audioEngine_` before `document_`, and `~ElVideo` calls `closeStream` on it through a
  non-owning pointer, so any document that had played sound corrupted the heap at exit —
  which surfaced as this app's headless binary dying after every check had passed. The
  general shape is worth remembering: **a shutdown that frees a service before the objects
  that call into it fails silently and blames whatever ran last.**
- **`replaceChildren()` destroys the subtree it removes instead of detaching it.** Every
  descendant is dead afterwards: appending one back into the document silently does
  nothing — no error, no exception, `childNodes.length` stays zero — and it is not
  specific to any element type, a plain `<span>` behaves the same way. Found because the
  Graph stage keeps one `<video>` per node across rebuilds, so that a preview arriving for
  one card does not restart the other eight; seven of nine came back blank with every line
  of the code that built them looking correct. **`put()` in `ui/dom.js` now clears with
  `removeChild` in a loop**, which is what the DOM says happens and leaves the elements
  alive. Not fixed upstream yet. The shape to remember: an API that destroys where the
  standard detaches turns *holding a reference* — an ordinary thing to do — into a silent
  no-op somewhere else entirely.

- `capture.js` — the Capture stage: a device, what it can see, and the recording
  it becomes. **A device is an input and this is deliberately not the Sources
  stage**, and the reason is not layout: an input on that stage is something the
  render about to happen will *read*, and a device cannot be — it never ends, so
  nothing can be cut from it. What you do with a device is not configure it and
  move on, it is watch it and then press record, which is a moment rather than a
  setting. It is **first on the spine** because it is the one card that is not a
  question about the file coming out: it is where an input comes from when there
  is not one yet, and the arrow into Sources is real (what a recording writes is
  opened as an input) just crossed at a different time.

  Four things here are load-bearing:

  - **A device's settings are its demuxer's options**, through the same
    `ui/opttable.js` column the encoder's, the muxer's and the file demuxer's use.
    There is no list of device settings written down and there could not be: this
    build has five devices and another platform's has different ones.
  - **The preview is an ordinary `<video>`** playing the device through
    `inputs.define()`, so it is the same backend and the same decoder a clip
    plays through. There is no preview-only path, for the reason the node
    previews have none. The **one** device that cannot be shown is `lavfi`, and
    the reason is about the seam rather than the device: lavfi's packets are not
    bytes — `wrapped_avframe` is a pointer to a decoded AVFrame — and bro's
    `MediaPacket` is a byte buffer because bro is codec-agnostic. The pointer
    does not survive the crossing and the decoder answers EPERM. Detected by
    asking `probe()` for the codec, never by name.
  - **Whether a device takes a region is asked of its option table** — `offset_x`,
    `offset_y` and `video_size` together — not decided by name, so another
    platform's screen grabber answers the same way with nothing edited here. The
    region is *dragged on the live picture*, which is the only way it could be
    picked in this engine and turns out to be the right way anyway. That is why
    `fitPreview()` places the picture at its own aspect rather than stretching it:
    a squashed picture is a squashed rectangle.
  - **The device goes to the recording, not to the preview.** `stopPreview()` runs
    before `record.start` and the preview comes back afterwards, because a
    DirectShow device is exclusive and the second open fails — which would read as
    every recording being broken. Leaving the stage releases it too.

  The one thing on this stage that is *not* asked of libav is the starting point
  for a device that will not list its sources (`desktop` for gdigrab). There is no
  call that returns it — it is in ffmpeg's man page and nowhere in the library —
  so it is a placeholder and one button, never a restriction, and it is labelled
  as a hint where it is offered.
- `shell.js` — the pipeline, as the thing you navigate. Six stages — Capture,
  Sources, Compose, Graph, Encode, Write — and the spine is both the diagram and the
  navigation:
  each card states what its stage is set to, so the bar reads as one statement of
  the whole render and clicking the part that is wrong is how you go and change it.
  **This replaced the Edit/Output tabs**, which were a modal in disguise. The reason
  is structural: ffmpeg's model is inputs → streams → a filter graph → encoders → a
  muxer, and an NLE's is a lossy projection of it — which is exactly why every item
  on README's "Not yet" list (stream copy, `-map`, two-pass, filters, hardware paths)
  had nowhere to live.
- `command.js` — the invocation, under every stage, live. Not a summary line: this
  application's argument is that ffmpeg should stop being a thing you guess at, and
  that argument is made by never hiding what is about to run. Drawn as two kinds of
  statement because it is two — the options are exact (those keys go to `av_opt_set`),
  the filtergraph is equivalent. **The second claim is conditional and must stay that
  way**: with a filter of the user's on the graph the render goes through libavfilter
  and those chains are what it parses, so calling them a translation would be
  underselling them by exactly the amount that matters. On the Capture stage it
  prints the *capture* instead — a device into a file is its own pipeline, and
  printing the timeline's render under it would be describing a command nobody is
  about to run — and all of that one is exact, because a capture composites nothing
  and so has no filtergraph to be a translation of. **Three things reach the
  encoder that are not in
  `videoOptions()`**, so a command built from the bag alone is quietly incomplete: the
  colour tags and the conversion into them, the keyframe interval (two seconds here,
  250 frames in x264), and the scaler, which is a flag rather than an option. There are
  more of them now and they are all named fields on the spec —
  `-force_key_frames`, `-flags +ildct+ilme` with `-field_order`, `-threads`,
  `-thread_type`, `-fps_mode cfr`, `-shortest`, `-bsf:v` and the decoder options in
  front of the right `-i`.
  **A two-pass render is two invocations and the bar prints two.** ffmpeg has no way to
  say it in one, and the halves genuinely differ — the first writes statistics through
  `-f null -` and keeps no file — so folding them into one line would print a command
  that produces a different result. `parts()` therefore returns `tails` (one output tail
  per pass) with `out` being the last of them, which is what every existing caller
  wanted; `commandText()` joins them with newlines so a paste into a shell runs both.
  **It is written from `spec.streams` and not from the settings the list was built
  out of**, because the spec is what `render.start` is handed: a `-map` per stream,
  `-c:a:1`, `-metadata:s:`, `-disposition:`, `-tag:` and `-attach`, with the index
  appearing only when there is more than one of that kind (`sel()`/`keyFor()`) —
  `-c:v` is what everybody reads, and `-metadata:s:a language=fra` with two audio
  streams claims both of them. **Chapters are the one thing on the Write stage an
  ffmpeg command line cannot say at all**: ffmpeg reads them from an input rather
  than from an option, so the note says so rather than dropping them silently.
- `report.js` — **what the render said**, under every stage beside the command bar and
  for the same reason: one states what is about to run, the other what came back.
  Two kinds of thing drawn as two, because they are not the same kind of fact —
  levelled, attributed messages are a list, and a filter's measurements are a line.
  Five decisions to keep:
  - **The series model is the thing later work stands on.** A series is
    `{ key, stream, numeric, points: [{ t, v, raw, job }], min, max, count }`, keyed by
    libavfilter's own metadata name *verbatim*. That name already says both which
    filter and which quantity, and normalising it would mean a table of filters this
    application refuses to have. Chunk 10 grows plots and actions on `seriesList()` /
    `seriesFor(key)`; do not reshape them without a reason.
  - **Drained from the frame loop, always** — not from `exporter.tick()`. A render
    started on the Write stage keeps going while you walk back to the edit, and
    `probe()` and playback log from wherever you are, so a channel that listened only
    while one panel was up would have holes exactly where somebody went to look.
    `poll(cursor)` is one lock and two usually-empty arrays; `draw()` only runs when
    something arrived.
  - **Quiet by default, loud when it matters.** The filter is warnings-and-above, so
    a good render shows an empty list; `Everything` still has all of it, because the
    render where the info line is the answer is the one you go looking for it on.
    The bar colours itself, and `export/progress.js` states the count under a finished
    render's bar — a green bar over a file that is not what was asked for is the
    failure the channel exists against.
  - **Nothing is cleared when a render ends.** `Clear` is a button because throwing
    away what you were about to read is a decision, not a side effect. Sparklines are
    built-then-measured-then-painted (the range strip's split) and repainted only when
    the measured width changes, since eight canvases at 60 Hz is a frame loop nobody
    can explain.
  - **The sparkline is the index; the plot is what one opens into.** Picking a series
    (a row click, or `plotSeries(key)`) puts it on a `plot.js` canvas over the render's
    range. Colours are handed out in the palette's fixed order and then *remembered*
    in a `Map`, never recomputed from the picked list — recomputed, unpicking the blue
    line makes the orange one blue, which takes away what a reader has just learnt.
- `plot.js` — a series drawn as the line it is: canvas, by hand, the way `timeline.js`
  and `graph/canvas.js` draw, because this is QuickJS with no npm and there is no
  chart library. Four rules, none of them taste:
  - **One axis, never two.** Two y-scales invent a correlation that is not in the
    data, since their alignment is arbitrary and unseeable. Series that cannot share
    a scale are normalised to their own 0–100% and the axis *says so*, with the real
    numbers in the readout under the pointer. A series that never moved is not a
    reason to normalise — it is a flat rule wherever it is put, and put at its own
    value it says something true.
  - **`SERIES_COLORS` is validated as a sequence**, against `#101216`: inside the
    dark lightness band, over the chroma floor, ≥ 3:1 on the surface, worst adjacent
    pair ΔE 8.4 under protanopia. **The order is the safety mechanism** — re-ordering
    it means re-running that check — which is why `nextColor()` takes the next free
    slot in order rather than hashing the key.
  - **Marks are the only loud thing**: hairline grid one step off the surface and
    *solid* (a dashed gridline reads as a threshold), 2px lines with round joins, an
    8px end marker carrying a 2px ring in the surface colour so it survives a
    crossing. Six lines is the cap; a seventh hue is either a repeat or one nobody
    validated, and it is refused in words.
  - **Interaction is not optional.** A crosshair reads every series under the
    pointer, and a click seeks the playhead there — a measurement is about a moment,
    and the moment is on the timeline.
- `measure.js` — **the verb.** Filters whose output is information, and what can be
  done with each. Two halves and they are not alike:
  - **The reading half is generic and must stay so.** There is no list of measuring
    filters: what distinguishes one is that it emits frame metadata or logs, and the
    channel captures both from all four hundred and eighty-eight. `OFFERS` is a list
    of *suggestions* — filtered against `bro.ffmpeg.filters`, placed at
    `composite/after-overlay` or `audio/after-mix`, carrying the options that make
    each answer at all (`ebur128` says nothing without `metadata=1`, and its true
    peak needs `peak=true`) — and the palette is still the whole registry.
  - **The verb half is written down, and has to be.** Nothing generic knows that
    `lavfi.cropdetect.w` is a width in pixels or that ebur128's summary is the four
    numbers `loudnorm` calls `measured_*`. Each follows **parse → refuse-or-offer →
    apply**, `enable.js`'s shape: parsing reads and never writes, a refusal is a
    sentence naming what was found rather than a button, and applying is *visible* —
    a `crop` node at the anchor the measurement was taken at, `loudnorm` on the
    sound, cuts on the timeline. The raw line every number came from travels with
    the finding and is shown.
  - **Anchors, not points in space.** `anchorFor(filter)` puts what is applied at the
    same insert point as what measured it: a `cropdetect` at a clip's `after-decode`
    measured the source at its own size, and a crop from it belongs there and nowhere
    else. Applying it after compositing would be four numbers about one picture
    applied to a different one.
  - **Parsing is safe because it is a reading.** Log-only measurements
    (`blackdetect`'s spans, `cropdetect`'s printed rectangle, `ebur128`'s summary) are
    parsed here, in JS, over records the channel already holds, keyed by the
    `AVClass` name libav puts on them (`Parsed_ebur128_0`). Nothing is applied because
    something parsed; what parsing produces is an offer a person accepts.
- `export/quality.js` — **what the settings cost, as a number.** The A/B stage already
  renders the same seconds twice, at the settings and losslessly, which is a distorted
  input and a reference on disk. A third render through the same slot chains after the
  candidate and compares them with `psnr`, `ssim` and `libvmaf` where the build has
  one — asked of libavfilter, never tabled. It writes nothing (`-f null -`,
  `wrapped_avframe`), it leaves the pixel formats to libavfilter's own negotiation
  (`psnr` declares one format list across both inputs, so doing it by hand would be a
  second opinion and a wrong one the first time somebody renders 10-bit), and the
  answers come back through the report as ordinary series — so the number under the
  wipe and the per-frame line in the drawer are one measurement. It must not redraw
  the preview while it runs: the two `<video>` elements *are* the decoders, and
  rebuilding the stage would stop the playback it is measuring. `drawPreviewStats()`
  exists for exactly that.

  **Reading the answer is three separate decisions and all three were wrong**, in a
  way that put a PSNR number on screen under settings that did not produce it — and
  which surfaced only as `ui_measure.js` failing three or four runs in eight:
  - **The channel is drained before it is read.** The result is asked for in the very
    frame the render that measured it publishes `done`, and the frame loop drains the
    report *after* it polls the export — so the reading saw whatever had arrived by
    the previous frame. A comparison that began and ended between two frames had said
    nothing yet and the wipe reported no measurement at all; a half-drained one handed
    over one arbitrary frame's value. `report.drain()` is on the surface for this and
    keeps asking until the channel is empty, because one poll is capped at 500 records.
  - **`render.start` hands back the number of the render it started.** `poll()`'s `job`
    is the render running *now* and is zero from the instant one ends, which is exactly
    the frame a caller comes to read what it said, so there was nowhere to learn which
    render a series' points belonged to. `job::claim()` already numbered the job before
    the thread existed; it returns that number now and `startExport`/`startCapture`
    pass it out. A series accumulates across every render that ever measured its key
    and each *point* carries its own job, so the filtering is on the points.
  - **A metric's frame metadata is that frame's value, not a running total.** `psnr`
    and `ssim` hang a number on every frame they pass and print the summary at end of
    input; an intra frame at the top of a GOP scores several dB above what follows it,
    so "the last point" has a five or six dB spread on a two-second preview. The points
    are combined here the way each filter combines them — PSNR over the errors, because
    decibels are logarithms and the mean of them is not the PSNR of the mean error;
    SSIM and VMAF over the scores.
- `sources.js` — the Sources stage, which is the **input editor**: three columns for
  the list, what this input is set to and what came back, and the demuxer's option
  table beside it. It was a read-only list derived from the timeline, which is an
  NLE's idea of a source and the wrong end of ffmpeg. **It is not driven by the
  selection and it is not derived from the timeline** — the two things it exists to
  make legible are that an input can be configured (and re-probed, so the stream list
  under the options is the answer to what they did) and that an input seek is not a
  clip's in-point.
  It also holds the three inputs whose content is assembled, in rows of their own
  under the demuxer: a sequence's `-framerate`, `-start_number` and `-pattern_type`,
  a still's hold, and what a concat list is made of. Everything they write goes into
  the same option bag `-probesize` goes into — they are `image2`'s and `concat`'s
  own options — so the rows exist for what they *mean* rather than for what they
  are. A sequence's frame rate drawn as row 34 of an option table says the opposite
  of what it is, which is a decision nothing on disk can make for you.

  **The decoders get a column too, one per codec the probe found**, under the
  demuxer's and the protocol's. They are here because a decoder belongs to an `-i` —
  ffmpeg writes `-skip_frame` in front of the same `-i` `-probesize` goes in front of
  — and in a *separate bag* (`input.decoderOptions`), because a decoder is a separate
  object with a separate table. The one trap: the column's `onChange` has to go
  through `reprobe()` even though the probe will say the same thing, because
  `reopen()` is also what re-registers the input for playback, and the token is the
  only route an option has into the `<video>` elements the viewer is already holding.

  **The stage's claim is that it is every file this render opens**, and two things
  the graph can now do would quietly break it. An input the *graph* reads has no
  clip cut from it, so it says `read by the graph` rather than `unused`, is not
  counted as unused on the spine, and cannot be removed while a node names it.
  And a `movie` filter opens its file inside libavfilter with none of this
  stage's options reaching it, so what one names is listed under *Opened by the
  graph* — separately, because it is a different kind of thing — with the offer
  to make it an `-i`. Neither is a special case bolted on: both are the
  consequence of the decision in `graph/derive.js` about what a graph source is.

  **And where an input's pictures are decoded**, which is `-hwaccel`,
  `-hwaccel_device` and `-hwaccel_output_format` in three rows. Here for the reason
  the decoder column is here, and beside a sentence saying that this is measured
  *slower* than the CPU — see `hardware.js`.
- `hardware.js` — **what this machine has, and an honest account of when it helps.**
  Two things live here and the second is the unusual one.

  The first is discovery. `bro.ffmpeg.hwaccels` is a fact about the *build* — every
  device type a vcpkg ffmpeg is compiled with is in it on a machine with no card at
  all — so nothing on the screen is drawn from it. `bro.ffmpeg.hardware()` creates a
  device of each type and reports what happened, and every menu, every badge and
  every filter-family question comes from that. There is no list of hardware
  filters, encoders or decoders written down anywhere: each device reports its own,
  built by walking libavcodec's `avcodec_get_hw_config` and libavfilter's registry.
  **The "Fast (GPU)" preset asks it too**, through `firstOnACard()` in
  `export/presets.js`. Filtered against `bro.ffmpeg.encoders` instead, it was offered
  on every machine — a vcpkg ffmpeg carries every NVENC, AMF and QSV encoder whether
  or not there is a card — badged by nothing, warned about by nothing, and failing at
  `avcodec_open2` with the render already started. The candidate list stays, because
  it is the order of preference and not a list of what is supported.

  The second is `decodeCost` and `encodeCost`, which are two sentences and are the
  reason this file has an opinion. **A control labelled "hardware acceleration"
  would be wrong about half of what it does**: measured (README has the numbers),
  decoding on the card here is two to six times *slower* than libavcodec threaded
  across thirty-two cores, and encoding on it is two to three times faster above SD.
  So they are two decisions in the two places they belong — the device is on
  Sources in front of the `-i`, the encoder is on Encode — and the one that is
  usually a mistake carries its sentence to wherever it is drawn.

  `deviceForRender()` is the third thing and it is a derivation, not a control.
  `-filter_hw_device` has to be *something*, `hwupload` takes no argument that could
  name it, and there are exactly two things in a render that name a device: an input
  that decodes on one, and a filter that belongs to one. A separate control would be
  a second place that has to be set to agree.
- `opttable.js` — **one AVOption table, edited into one bag**, and the third instance
  of the pattern is what made it a component. libavutil describes an encoder, a muxer,
  a demuxer, a decoder, a protocol and a filter with the same structure, so the
  encoder's advanced column, the muxer's on Write and the demuxer's on Sources are the
  same rows over the same kind of data; `export/form.js` was migrated onto it rather
  than left as a fourth copy. Three copies would be three sets of decisions about which
  control a type gets, arrived at from one table by different routes, and they would
  drift in the direction of whichever one somebody last had a reason to touch. The
  search term lives in the component, keyed by the column's `data-f` name, because it
  is about the *list* and has to survive the column being rebuilt.
- `transport.js` — the playhead, and what has to be true of every decoder while it moves.
  **The one part of the application that is not an edit**: play, pause, step, shuttle and
  loop are how you look at the timeline, not what it says, which is why a render exports a
  clip at its own rate whatever the viewer was last playing at. Owns the master-clock
  choice, the drift tolerance and `adoptDecoderTime()` — see the invariants below.
- `app.js` — orchestration: the control strip, keyboard, drag/drop, the frame loop, the
  inspector. The frame loop's whole dealing with the transport is `tick(dt)`.
- `viewer.js` — the program monitor. Each clip is a `<video>` inside a crop window (a div
  with `overflow:hidden`). Fit/zoom/pan/crop/opacity/stacking are **style writes on those
  two elements** — nothing costs anything per frame, and decoded frames still go straight
  to the renderer. Keep it that way: no canvas readback, no per-frame compositing. The
  one thing it cannot show is a filter — there is no filter path in playback at all — so
  a clip carrying one is badged `fx`. An unmarked picture would read as the filter not
  working, which is the failure mode; the badge is the honest answer until playback
  grows a path of its own.
- `timeline.js` — ruler, dynamic V-lanes, one A1 waveform lane. Everything is drawn from
  the *visible window*, not the whole file, which is what makes zoom meaningful.
  **A drag can rebuild the lanes underneath itself**, and that is not an edge case: the
  spare top lane is what a clip is dragged into to restack it, and crossing into it is
  what changes the track count and drops and rebuilds every row. Two things follow.
  `tracked()` keeps **one** pair of `document` listeners for the whole timeline with the
  live gesture in a module variable — a pair per call accumulated a set per rebuild,
  firing dead handlers on every pointer move for the rest of the session, and the obvious
  disposer-per-row fix would have ended the drag that removed the row. And the drag
  measures `laneOf(entry.track)` on every event rather than the element it began on: a
  detached element reports `left: 0`, so the clip jumped sideways by the track-head
  gutter the instant it crossed and snapped to the wrong neighbours thereafter.
- `analysis.js` + `analyze-worker.js` — filmstrip and waveform via `bro.media` (see
  `../bro/docs/video-api.js`). Both are full-file decodes, so they run in one worker with
  one queue and the lanes fill in behind a responsive UI.
- `inspector.js` — the properties panel and the chips in the title bar. Owns `subjects()`
  and `common()`: what an edit applies to, and what a field shows when the selection
  disagrees. It edits the model and calls back for everything else, so it never has to
  know about the viewer, the timeline or the transport. It asks one more thing of the
  application now — `hooks.outranked()` — because a control whose job has been taken
  over by a locked node has to say so *where somebody is about to drag it*, not only on
  a stage they may not have open. Marked rather than disabled: the value still goes into
  the model and the viewer still follows it, so a control you could not touch would be a
  lie in the other direction.
- `export.js` + `export/` — the Output workspace. `export.js` is the wiring; the parts are
  `state` (settings, the render slot, and the four readers — `activeVideoCodec()`,
  `activeAudioCodec()`, `outputFps()`, `outputExt()` — that say what the settings *come
  to*, because a fallback chain written out at each point of use is a fallback chain that
  can disagree with itself), `capabilities` (what libavcodec and libavformat say this
  build can do — `muxers()`, `muxerInfo()`, `extOf()`, `formatOptionsOf()`),
  `options` (settings → `-key value`), `spec` (the model → what the renderer
  wants), `streams` (what the file is made of), `destination` (where it goes),
  `presets`, `warnings`, `store`, `form`, `preview`, `strip`, `progress` — and
  `controls`, which is the smallest of them and the reason `form.js` is readable: a
  labelled row, a number field with its unit, a cluster of buttons. It holds nothing
  and decides nothing; `row` and `head` moved out of it into `ui/dom.js` when the
  Sources stage wanted the same rows, which is the rule for anything here that a
  second stage comes to want.
  `buildSpec()` turns the model into what `bro.ffmpeg.render.start` wants. **Two stages,
  not a modal**: what the picture is put through (Encode) and where it goes (Write) are
  different decisions taken at different moments, so `#st-encode` and `#st-write` are
  siblings of `#st-compose` under `#stages`. All six stages hide each other rather than
  unmounting — the viewer's `<video>` elements *are* the decoders, and tearing them down to
  look at an export would mean rebuilding and re-seeking every one on the way back.
  Consequences: anything in the frame loop that measures a panel has to ignore a
  measurement of zero (most of the window is `display:none` at any moment), and
  `shell.goTo` is the only thing that switches — `export.js` offers `prepare()` and
  `canLeave()` and has no opinion about what is on screen.

  **A zero here means "never laid out", not "hidden", and that is worth knowing
  before writing a guard against one.** Measured: a `display:none` element that has
  been through layout once keeps its box — `#viewer` is 1630 px wide from the
  Sources stage, because `#st-compose` is the stage the application opens on — and
  an element in a stage that has *never* been shown reports 0×0. So the reachable
  case is the first visit to a panel, and it is reachable: going straight to Write
  without ever having been on Encode drew the range strip against nothing, which
  is what `paintStrip()` now waits out and `refitStrip()` asks again for. A guard
  on `viewer.layout()` or on the A/B stage's fit would be guarding a state neither
  can be in, and there is no point writing one.

  **`prepare()` runs for both
  Encode and Write, so the half of it that reads the edit is gated on arriving from
  outside** (`arrive()`): stepping between the two stages is one visit, and re-running
  it moved the preview's sample point back to the playhead on the way back from setting
  a filename.

  **Two-pass is a fourth mode of `rateModes()`, not a checkbox beside it**, because it
  is the same decision — spend this many bits — taken twice; a switch would let somebody
  ask for two passes of *constant quality*, which is two runs of an encoder that had
  nothing to learn from the first. `passesFor()` in `spec.js` is the one place a render
  becomes two, for the reason the filter graph is attached there: there are three
  renders on this stage and a reference or a candidate that quietly ran one pass would
  be comparing against a different encode. It bows out when `over.videoOptions` is given
  — the lossless reference names its own bag and has no bitrate for a second pass to
  spend.

  **`export/destination.js` is where the render goes, and the shape is *asked*.** Four
  of them — one file, a set of files, a stream, several at once — and `kindOf()` decides
  by asking, in this order: the muxer is `tee`; the path has a scheme in the output
  protocol list; the path has a frame pattern or the muxer says `AVFMT_NOFILE`; otherwise
  a file. **No mode control and no list of segmenting muxers**, because either would be a
  second answer that could disagree with the first — `AVFMT_NOFILE` is libavformat's own
  way of saying *I do not write the file you named me with*, which is exactly what a
  segmenter, a playlist writer and `tee` all are, and it is the same query the muxer
  picker's "Streaming" facet already runs. The one *name* in the file is `tee`, and it is
  a name rather than a capability: `-f tee` is the mechanism, there is one such muxer, and
  a question to discover it could only ever answer with its name.

  Four things here are load-bearing:

  - **`outputTarget()` is the one place that says what `spec.path` is.** For a tee it is
    the built argument and not a path at all, and there are four callers — the spec, the
    command bar, the warnings, the progress panel. A fifth answer assembled by hand
    somewhere would be a render going somewhere the screen does not say.
  - **The `-f tee` argument is built, never typed, and shown in full.** Two layers of
    escaping sit over it: `tee` splits destinations on `|` with `av_get_token` (so `|` and
    `\` are escaped) and reads each one's options out of `[ ]` on `=` and `:` (so `:` and
    `]` are escaped in values), and then the command bar quotes the lot for the shell.
    On Windows that doubles every backslash in a path, which looks wrong and is right.
    An argument assembled on somebody's behalf is exactly the one that has to be visible.
  - **What a scheme is, is `format.js`'s `urlScheme()` and there is one of it.** There
    were two, and only one carried the guard that a Windows drive letter is a colon in
    a path and not a scheme — so `C://media/x.mp4` was an ordinary path to this stage
    and protocol `c` to the Sources stage, which drew "not in this build" against it.
    The **policy** stays at each call site because it is one, and both of them answer
    `''` for `file:`: that is what `isLocalPath` in `export_writer.cpp` says, and it is
    the function deciding whether the render stats a file or reports what it sent, so
    a screen disagreeing with it says there is nothing to open about a file on the
    disk. `openable()` hands back the path behind such a URL, stripping the five
    characters `localPathOf` strips.
  - **`[` and `]` in a tee destination cannot be escaped, and are not.**
    `tee_write_header` splits the list with `av_get_token` — which removes a backslash
    and keeps what follows — and only then tests whether the first character of the
    slave is a `[`. So `\[` arrives as `[` and is read as the option bracket exactly
    as an unescaped one would be. A destination whose path begins with `[` is
    unreachable through `tee`; an escape there would be a guard that does nothing.
  - **`openable()` answers "open the result" per shape**, because a set of files is not
    "done, here is your file": the playlist for `hls`/`dash` (it is what was named and the
    only thing that says the order), the first picture of a numbered run (a run has no
    index and `out%04d.png` is not a name anything can open), whichever `tee` destination
    is local, and **nothing** for a stream — so no button is drawn, since one that opened a
    socket would be worse than its absence.
  - **`destinations` is in `store.js`'s `REMEMBERED` list, beside `container`.** A
    remembered `tee` with a forgotten destination list is a workspace that opens saying it
    will write to several places and naming none. (Worth knowing while testing: the whole
    settings block is persisted in `localStorage`, so a headless run that dies half way
    through a section leaves its container and option bag behind for the next one. The
    destination section of `ui_export.js` sets its own starting point for that reason.)

  Progress says something different and true for each: frames and an estimate for a
  bounded file, `pieces` — the count of files arriving — for a set, bytes *sent* and a
  bitrate for a stream, with no bar at all when the job is `openEnded`. That is the
  recording's vocabulary reused rather than a second convention.

  **`forceKeyFrames()` in `options.js` derives, it never copies.** `settings.keyframeMode`
  is what is stored; `cuts` re-reads `project.clips` on every call, so a keyframe follows
  the clip that moves. Written against the *window* being rendered rather than the range,
  because ffmpeg's times are seconds into the output and a preview of the middle of the
  range is a different output. A version that wrote the numbers into a field when the
  button was pressed would go on naming moments nothing cuts at, which is the failure
  this shape exists to avoid.

  **`-fps_mode` is printed and not offered.** Both render paths walk the range forward at
  the output rate and stamp each frame with its index — `TimelineSource` because it
  samples the edit at *t*, `GraphSource` because the writer numbers what leaves the sink
  — so `cfr` is a fact about this renderer, and a picker offering `vfr` would be offering
  something neither path can produce. Making one possible is a change to the
  `FrameSource` seam (a timestamp handed over with each frame rather than an instant
  asked for), which is the one interface the 43 dB check is measured across.

  Four regions: the settings form (drawn from the selected encoder's reported capabilities,
  so it changes shape per codec), the A/B stage, the advanced option column, and the range
  strip across the bottom. The preview renders the same seconds twice — once at the chosen
  settings, once losslessly — and wipes between them; the reference is keyed by
  `referenceKey()` on everything that changes the *picture*, so changing the quality
  re-renders only the candidate. Both videos are placed in pixels against the stage, never
  sized to their own boxes: the clipped one's parent is the wipe window, and fitting to it
  would compare a picture against a squashed copy of itself. Because they are placed in
  pixels they do not follow a stage that resizes, which it now does — `chasePreview()`
  refits when the measured stage changes. **And the stage is rebuilt only when what it
  is showing changes**, keyed on the two paths, the mode and whether there is anything
  to show: those two `<video>` elements are the decoders, `put()` throws them away, and
  `prepare()` draws everything for Encode *and* for Write — so without it, walking over
  to set a filename and back restarted both files from frame 0. Same rule
  `drawPreviewStats()` follows on the measurement path. A busy stage is a progress bar
  with a percentage on it and is redrawn every frame, which is what a null key says.
  **The muxer picker lives in `form.js`'s `outputRows()`, drawn into `#ex-dest` on the
  Write stage**, with the muxer's own option table in `#ex-format-opts` beside it — the
  same relationship the encoder's advanced column has to the settings form, and the same
  rows (`bagRows`/`optionRow` take the bag now, so the encoder's `extraVideo`, the audio
  encoder's `extraAudio` and the muxer's `extraFormat` are one mechanism —
  `extraAudio` was declared, persisted and read on every render by `audioOptions()` with
  nothing anywhere writing to it, which made the audio encoder the one bag in this
  application with no column). It is the filter palette's shape rather than
  a `<select>`, because 182 entries is the palette's problem one stage later: a statement
  of what is chosen, a search over name, long name and extension, and facets that are
  each a query (`fits` is `avformat_query_codec`, `stills`/`noFile`/`device` are flags).
  Two rules there are not decoration — **a search ignores the facet**, because a facet is
  a way of not having to name what you want and narrowing a named answer hides it; and
  under `Fits` **the muxers that answered come before the ones that never did**, or the
  list opens on `avm2` and `crc`. Picking one clears `settings.extraFormat`, since an
  option is the previous muxer's and an unknown key is an error.

- `export/streams.js` — **the Write stage is the output's stream list**, one row per
  stream the muxer will number, in that order. `#ex-streams` is the middle column of
  `#st-write`, between the destination and the verdict. This is the surface stream
  copy (12) attached to and destinations (13) and subtitle tracks (14) will, so its
  shape matters more than its polish. Six things here are decisions rather than
  layout:

  - **The first control on a row is where its content comes from**, and it changes
    what the rest of the row can be: made (the composite, the mix, through an
    encoder) or copied (`copy:0:1`, no encoder at all). A copied row states its
    codec instead of offering one — there is nothing to choose, and a disabled menu
    would say a choice was being withheld. `setSource()` is the one place that
    moves a row between the two, and it drops what does not apply on the way: the
    encoder going in, the span coming out.
  - **A row is a sentence, not a grid of labelled inputs** — "A2 · the mix, through
    aac · fra · “Commentary” · forced" — because what a person checks on this stage
    is whether that sentence is the one they meant. What a stream *has* is behind a
    ▸, for the same reason the encoder's eighty options are a column. A row you add
    opens on its detail, since adding a stream and saying what it is are one gesture
    with a pause in it.
  - **An attachment is a row and a chapter is not.** An attachment *is* a stream: an
    index, `-attach`, extradata written at header time. A chapter has no index,
    nothing maps to it and no player shows it in a track menu — it is a table beside
    the streams, so it is drawn beside them, and `ExportSettings` holds it the same
    way. Drawn among the streams it would invite "what is chapter 2's language",
    which has no answer.
  - **`settings.audio` and the audio rows are one fact** — the *mix-fed* ones. The
    Encode stage's Include switch goes through `setAudioIncluded()`, which empties or
    refills them. Two switches for one decision is how a render comes out silent
    while a track list insists it should not have. A **copied** audio row is outside
    it in both directions: the switch is about the thing the encoder is fed, and a
    stream whose packets come out of a demuxer is not made of it.
  - **A mix nothing feeds is not a stream in the file**, and that is a third fact
    beside those two. Native decides it by opening — `wantAudio` in
    `export_timeline.cpp` is set only where a clip's `SourceAudio::open` succeeded,
    and `outputStreams()` then drops every non-copied audio stream — so a
    video-only timeline has always written a file with no soundtrack. This side had
    no equivalent term: a row tested `settings.audio` and `derive()` tested
    `muted`/`volume`, and `volume` is 1 and `muted` is false whatever a probe found.
    So the stage drew "A1 · the mix, through aac" for a stream that was always going
    to be dropped and the command bar printed `[0:a]atrim…`, `-map [a0]` and
    `-c:a aac` against an `-i` with no audio in it — which real ffmpeg refuses with
    *Stream specifier ':a' matches no streams*. `hasAudibleSound()` here is the
    term, over `streamKinds()`, counting an overlay wire into `audio out` as well
    since a `sine` there is a soundtrack with no clip near it; `derive()` asks the
    same question of `spec.inputInfo` so that it stays a pure function of its
    argument, and **a spec that does not carry that field answers yes**, which is
    what every hand-written spec in `tests/` has always meant. The row stays on the
    stage and says it will not be written, because adding a file with sound will use
    it.
  - **Nothing is tabled.** The dispositions are `bro.ffmpeg.dispositions` (every bit,
    through `av_disposition_to_string`), the fourccs are
    `bro.ffmpeg.codecTags(container, codec)` — a muxer's *name*, since a fourcc is a
    container's vocabulary and nothing in libavformat is identified by an extension —
    and the codecs are the encoder lists. A row cannot offer what the render
    would then refuse.
  - **The bitstream filter chain is an ordered list and is drawn as one** — a
    numbered row per filter with the arrows to move it — because the order is the
    whole of the meaning: `h264_mp4toannexb,dump_extra` and the same two the other
    way round are different files. It is here and not on the Encode stage because a
    bsf is neither an encoder nor a muxer; it is per stream because `-bsf:v` and
    `-bsf:a` are different chains on different packets. What is offered is narrowed
    by `bsfsFor()` against each filter's own `codecs`, which is why
    `bro.ffmpeg.encoders` reports `codecName`: `libx264` writes `h264` and nothing
    else in the app could have said so. **An empty `codecs` is "any"**, not "none".
  - **`hooks.changed` rebuilds the rows; `hooks.restated` only re-says what will be
    written.** A language or a disposition changes what is *in* the file and not what
    the picture looks like, so it must not throw away a candidate render that cost
    ten seconds. Which is also why the detail's fields commit on `change` and rewrite
    the row's tail in place rather than redrawing the list under the caret — the same
    build/measure split the range strip and the graph cards use.
    **The path field on the same stage is the same distinction**, and was on the wrong
    side of it: every destination commit ran `invalidateCandidate()`, so typing a
    filename discarded a candidate render and the PSNR numbers under the wipe — which
    is exactly what somebody walks over to the Write stage to do, usually straight
    after looking at the comparison. `referenceKey()` already leaves the path out. The
    one exception is `image2`, where the extension names a *codec* rather than a
    container, so `followExtension()` really can change the encoder; asking whether it
    did is the whole test, since nothing else in that handler can.

- `export/copy.js` — **the decision to copy a stream rather than encode it**, and
  where a copy can start. `parseCopy`/`copySource` are the one place that reads and
  writes `copy:<input>:<stream>`; `keyframesFor()` caches `bro.ffmpeg.keyframes`
  against the input's *opening key* and the stream, so a re-probe with a different
  demuxer answers again and a redraw does not. Three things about the surface:

  - **The keyframes are drawn as the places they are.** `.ex-kf-strip` is the input's
    own clock with a mark per keyframe and a line for the in-point; the gap between
    them is exactly what the cut costs, and `inPointNote()` says it in words because
    a strip answers "where" and only a sentence answers "and what does that mean".
    Marks are DOM buttons rather than something drawn into a canvas, for the reason
    the Graph stage's `+` is: hit-testing them by hand is work with a DOM node's
    name on it.
  - **The refusals live in `export/warnings.js`, not in the renderer.** A copy
    contradicts the edit — a second clip, a filter on the graph, a crop, an output
    of a different size — and every one of those is a setting somebody made that
    will not be in the file. Said here because a render that dropped them would
    *succeed* and hand back the input again, which is the worst outcome this stage
    has. It also means `wantsVideo`/`wantsAudio` in that file count only the streams
    an encoder is opened for: a container holding no encoder this build has is no
    obstacle to a copy, and reading the encoder list at it would refuse the render
    that works.
  - **`Rewrap <file>` is a shortcut and not a mode.** It writes ordinary rows with
    ordinary `copy:` sources into `settings.streams` and nothing on the stage
    behaves differently afterwards — the same rule the Report drawer's measurement
    shortcuts follow, where what you get is an ordinary node on the graph. It
    deliberately leaves the container alone: which muxer to write is the whole of
    the remaining decision and it is taken on its own control a foot away.
    **It carries the cues too**, as `copy:` like everything else it writes — it
    used to take the video and the audio and silently leave the subtitle track
    behind, which is a shortcut that *succeeds* while handing back a file that is
    not the one it was asked for. `copy:` and not the `decode:` a fresh subtitle
    row would default to, because a rewrap is not changing the container and the
    honest first answer is the packets that are already there; a container that
    will not hold them is refused by name with the row still on the screen to be
    flipped to `convert`.

  `ui/command.js` grew an input *plan* for this. A `-map` counts input files on the
  command line and the graph's `[0:v]` counts the same list, so a copied input has to
  be printed as one of those `-i`s and know its own printed index — graph inputs
  first, copied ones appended, a file both read once. `-ss`/`-to` for a copy go in
  front of the `-i` and are added to the input's own, because **an input seek is not
  an output seek**: before the `-i` the demuxer jumps to the keyframe, which is why a
  copy starts there; after it, the whole file is read and the front discarded. And
  `graphUsed` decides whether a `-filter_complex` is printed at all — a rewrap maps
  input pads and nothing else, so printing a composition nothing reads would describe
  work the render is not doing.

  **`previewSpec()` in `export/spec.js` is how a preview avoids inheriting an
  eight-stream output.** The A/B comparison and every node preview exist to show what
  something does to one *picture*; a second language track proves nothing about a
  wipe, a chapter table measured against the whole timeline means nothing inside
  three seconds of it, and an audio-only stream list would leave the comparison with
  no picture at all. So they call `previewSpec()`, which is `buildSpec()` with
  `streams: []` and `chapters: []` — the renderer's own sentinel for one video stream
  and one audio stream. One place decides it, for the reason `buildSpec()` is one
  place: there are four callers and a preview rendered from a different description
  is a preview of something else.
- `export/subtitles.js` — **where a subtitle track comes from, and what it can be
  written as.** The counterpart of `copy.js` one stream kind over, and it is a
  separate file because the decisions are different ones: there is no composed
  subtitle source, so a row is always reading something that exists and the only
  question is whether the container holds the codec that is already there.
  `defaultSubtitleSource()` answers exactly that with `avformat_query_codec` — an
  `.ass` into Matroska is carried, the same track into an mp4 is converted — because
  defaulting to either one unconditionally means half the rows arrive wrong, and the
  wrong-but-still-renders half (a needless re-encode) is the half nobody notices.

  Four things here are load-bearing:

  - **`filterPath()` is the escaping, and it is called where a node is made rather
    than where one is printed.** A filtergraph separates a filter's arguments with `:`
    and its filters with `,`, so `C:/media/cues.srt` reaches libavfilter as a filter
    option called `C` and the complaint names half a path without ever mentioning the
    drive letter. `ui/sources.js` is its only importer — the `As a filter` line and
    `burnIn()` — and what goes onto the node is the escaped string, so the graph, the
    render and `ui/command.js` all read one value that was escaped once. A second call
    in the printer would be a second escaping, which is how a printed command comes to
    differ from the render it describes. The same rule the Sources stage already
    recorded for `movie=`.
  - **Burning in is a filter and stays one.** `burnIn()` in `sources.js` calls
    `overlay.insert('composite/after-overlay', 'subtitles', …)` and goes to the Graph
    stage — an ordinary node, printed by the command bar, movable and deletable. The
    rule `measure.js`'s offers follow: a shortcut that produced something you
    could not then find is worse than no shortcut.
  - **Which files are subtitles is asked of the *probe*, not of the name.**
    `inputs.js`'s `kindOf()` is the answer: an input whose every stream is subtitles
    is a subtitle file whatever it happens to be called. There was a second answer
    here — an `isSubtitlePath()` over the extensions of every muxer that declares a
    subtitle codec and neither a video nor an audio one, which correctly left out mp4
    and Matroska because dropping one of those is dropping a video — and nothing ever
    called it. It is gone; the note stays, because the list it built is the right
    answer for the one case there is no file to ask, and somebody will want it again.
  - **The viewer cannot show a soft track and `warnings.js` says so.** There is no
    subtitle path in playback — the same structural reason there is no filter path —
    so the honest move is the sentence, not an overlay that would then disagree with
    the render in every detail of position, font and line breaking. The `fx` badge is
    the same pattern one stage over.
- `graph/` + `filtergraph.js` — `buildSpec()`'s output written as the
  `-filter_complex` that would produce it, for showing (and copying) what the
  render amounts to in ffmpeg's own terms. The app composites internally rather
  than shelling out, so this is a *translation*, and how good a one was settled
  by measuring: render the same edit both ways and compare. Naming every colour
  conversion is worth 24.1 dB → 39.1 dB, which is why `probe()` reports each
  source's colour tags and why they are threaded in. A rate change is the one
  difference no option closes — a fixed-rate walk and a frame-sync pick
  different frames — so it is reported as a caveat instead. **An edit it
  cannot express faithfully returns a refusal, not an approximation**: the
  whole value of printing a command is that it can be taken elsewhere and run.

  It is a graph before it is a string, in three parts that change for different
  reasons. `graph/model.js` is nodes and wires — **one node kind, because
  ffmpeg has one**: a `scale` node *is* a filter named `scale`, and the app's
  crop, opacity and stacking are `crop`, `colorchannelmixer` and `overlay`
  rather than special cases of anything. The two ends are the exceptions, and
  an `input` node is no longer only the derivation's: a file the graph reads on
  its own account is one too, carrying `input` (which of the document's `-i`s)
  and `derived: false`. `graph/derive.js` builds the skeleton
  from the edit and owns every refusal and caveat; `graph/print.js` turns nodes
  into chains; `graph/check.js` says what is wrong with a finished one.
  `filtergraph.js` is the composition, with the shape callers want, so
  `command.js` does not know a graph exists.

  **`spec.origin` is where the zero of the graph's clock is, and it is not
  `spec.start`.** Every derived chain begins `setpts=PTS-STARTPTS+offset/TB`, so
  `t` inside the graph reads as time into the render — which is the clock a
  filter's `enable=` names. A node preview, a piece of a node playback and the
  A/B comparison are each a render of a two-second window out of the middle of
  the range, and derived against their own start they put t=0 at the start of
  the window: a filter told to come on ten seconds in came on ten seconds into
  every one of them. So `buildSpec()` carries `origin` (the range's start) beside
  `start` (this window's), and `derive()` shifts the whole graph by the
  difference — the canvas too, because `overlay` frame-syncs against it and a
  canvas left at zero while every clip moved composites against the wrong frames
  of it. Audio takes the shift on its `asetpts` and **not** on its `adelay`:
  `adelay` prepends real silence, so a window five minutes in would arrive with
  five minutes of it. `origin` defaults to `start`, which makes an export — and
  every spec written by hand in a test — unchanged.

  **Printing and refusing are separate, and that is not tidiness.** `print()`
  prints whatever it is given, because half of what asks it is a *pruned* view
  where outputs deliberately go nowhere — that is what cutting a graph off at
  one node means, and a printer that refused would refuse every node preview.
  `problems(g)` is asked only of a whole graph, by `derive()`, which returns
  them alongside the graph rather than instead of it: the state is reachable and
  normal — the moment between placing a node and wiring it is a graph with a
  problem in it — so the stage draws it and marks the node. What must not
  happen is a render going ahead as though the problem were not there, and that
  is `filtergraph.js`'s job: both `filtergraph()` and `renderGraph()` refuse
  over any problem, naming the first, because both of them produce something
  that will be *run*.

  **Which of the renderer's two paths a render takes is decided in one place**:
  `buildSpec()` attaches `filterGraph`/`filterInputs` when — and only when — the
  overlay has something in it. There it rather than at each `render.start`,
  because there are three of those (the export and both halves of the A/B
  preview) and a reference rendered without the filters would be comparing the
  picture against a different picture. If the derivation refuses while the
  overlay is non-empty the render still happens, through the compositor,
  without the filters — so `export/warnings.js` says so.

  It exports the graph twice, because there are two consumers and they want
  different tails. `filtergraph()` is the one to *print*: it ends with the
  conversion into the encoder's colour, because a standalone ffmpeg hands the
  last pad to its encoder. `renderGraph()` is the one to *run* — the same
  chains, stopping in the compositing space, plus the `filterInputs` list that
  says which file feeds `[0:v]` — because on that path the writer converts, and
  doing it in both places does it twice. They differ by exactly one chain, and
  `tests/ui_filtergraph.js` asserts that. `filterInputs` is **one entry per pad
  that is read**, not per node and not per stream the file happens to carry:
  a subgraph cut down to one clip's picture must not be the reason its sound is
  decoded, and a muted clip is not read for sound at all.

  **The conversion into the encoder's colour is attached last, in front of the
  video sink**, by `outputColour()` — after the locks, the insertions and every
  wire a person made. It used to ride on the back of the last derived `overlay`,
  which was right while the only thing that could be added to a graph was a
  filter spliced onto a wire: there was no wire after it, deliberately, so
  nothing could get between the conversion and the encoder. A hand-made wire
  can, and the moment it can those two nodes become the one place on the screen
  that must not be joined to — they exist in the graph this application *prints*
  and not in the one it *runs*, so a wire ending on `output/color` would be in
  the command you copied and absent from the render you got. Attaching them at
  the end makes that unreachable rather than something to check for, and the two
  forms still differ by exactly one chain. `applyLocks()` is called a second
  time for those nodes, or they would be the only two on the screen that could
  not be edited.

  Four things about the model are load-bearing rather than incidental.
  **Arguments are positional-then-named because ffmpeg's are** — `crop`'s four
  numbers are the first entries of the same option table the named ones come
  from, and normalising them would print something other than what was written.
  **Only chain-final nodes carry a label**, because print's rule is that a run
  continues while the wire is private (one producer, one consumer, both
  filters) and a private pad has no name to carry. A hand-made wire can move
  the end of a run — put a filter between the last `overlay` and the sink and
  `vout` is suddenly in the middle of a chain, printed by nothing — so
  `moveLabelsToChainEnds()` walks them forward afterwards by that same rule; it
  is a no-op for a graph the derivation built on its own. **A node has the pads
  its filter has, not the pads its wires gave it** — `node.ins`, filled in by
  `declarePads()` from `padsOf()`, and `g.inPorts()` — because an unwired pad is
  the thing you are looking for while wiring and a count of wires cannot see
  one. And **a node may have more than one output, and an edge
  says which it leaves by** — `node.outs` and `edge.fromPort`. An **input node
  is a file, not a stream**: `[0:v]` and `[0:a]` are two pads of one `-i`, one
  demuxer and one seek, and drawing them as two nodes reading the same path
  said they had nothing to do with each other. The chain rule did not change
  when the port arrived; `padOf` takes it, `connect` records it, and
  `insertAfter`/`remove` move and heal only the wires on the pad in question —
  a filter dropped on a clip's picture that took its sound with it would put an
  `hflip` in front of `atrim`. `g.wire()` is the one a *gesture* goes through
  and `connect` is the one the derivation builds with: an input pad holds
  exactly one wire, so wiring replaces (`disconnectAt` first) where building
  appends, and that is what makes putting a filter between two derived nodes one
  gesture rather than a delete and two connects. **`streamsOf(g)` lives here rather
  than in `layout.js`**, because which stream a node is on is a fact about the
  graph and not about where it is drawn, and there are three callers — the
  layout colours a wire with it, the card colours its dot, and `subgraph.js`
  uses it to decide whether a preview is a picture or a waveform. `keyOf(node)`
  is also here now — anchor for a derived node, id for a user one — because a
  hand-made wire's two ends are written as exactly that and the overlay cannot
  import a panel; `panel.js` re-exports it, since half the application asks the
  panel.

- `graph/filters.js` — libavfilter's own answers, cached: the registry, one
  filter's option table, and **`padsOf(filter, params, pos)`, which is the one
  question libavfilter will not simply answer.** A dynamic filter's pad count is
  a function of an option value and nothing in the metadata says which option —
  each of them works it out in its own `init`, from a field it named itself, and
  ffmpeg's CLI does not know either. So the option is *found*: among the four
  names ffmpeg has ever used for a pad count (`inputs`, `nb_inputs`, `n`,
  `outputs`), at most one is in a given filter's table, and its default is in
  that table too. Three things there were wrong first and are worth not
  repeating:

  - **The dynamic flag is not the count.** `scale` carries
    `AVFILTER_FLAG_DYNAMIC_INPUTS` — it grows a pad for `scale2ref` — while
    declaring one `v` input and having nothing that counts anything. The
    declared pads win unless a counting option is actually found.
  - **The positional fallback needs the option to be the table's first entry.**
    `amix=3` is `amix=inputs=3` only because `inputs` is amix's first option.
    Reading `pos[0]` as a count without checking turned `scale=1920:1080` into a
    node with sixty-four sockets on every graph the application drew.
  - **`concat` is written out**, because its count multiplies: `n=3:v=1:a=1` is
    six pads in and two out, grouped per segment, and no rule about a single
    number expresses that.

- `graph/check.js` — **what is wrong with a finished graph, in sentences that
  name the node.** An empty input pad, two wires on one pad, a pad read twice
  (ffmpeg's own message for which is "Label found twice", about its parser), a
  pad nothing reads, a picture wire in a sound pad, a cycle, a filter this build
  does not have, and a wire the overlay could not put back. Every one of them is
  a shape ffmpeg itself rejects — that is the entry requirement, because the
  whole value of printing a command is that it runs. Cycles get a proper
  depth-first colouring rather than the bounded relaxations `depths()` and
  `streamsOf()` use: those survive a loop by giving up, which draws something
  and never says what, and a cycle has to be *named* because every other
  complaint about it is a consequence.

  **And where the picture is.** A `cuda` frame arriving at `scale` produces four
  hundred pixel format names, twice, with nothing in it saying the word
  hardware — the single least readable failure in this application, and one
  sentence to explain. So `memoryProblems()` carries one fact through the graph
  (is the picture up or down) and names the first node where the two disagree.
  **That fact is `whereIs(g, node)` and it is exported**, because three places ask
  it of three different questions and only the questions differ: whether every
  node's expectation holds (here), whether one pad's picture is on a card so a
  preview's tail needs an `hwdownload` (`graph/subgraph.js`), and whether the
  picture the *encoder* is handed ends up on one (`export/warnings.js`). The last
  of those used to answer by looking for `hwupload` in the last chain of the
  printed graph, which is neither the same question nor even the same chain —
  `print()` walks the node array in order and `derive()` builds the audio runs
  after the video sink, so the last chain of any render with sound in it is an
  `atrim` and the answer was unconditionally no.
  Four things about the walk were learnt the hard way:

  - **Resolve by asking upstream, not by walking `g.nodes` in order.** A node's
    producers are earlier in the array for a graph the derivation built and are
    *not* for one somebody edited, because `insertAfter` appends. Reading in
    order made every node after an insertion answer "system memory" because
    what fed it had not been reached — a wrong answer that looks exactly like a
    right one.
  - **Every input pad, not the first.** `overlay`'s canvas comes from a `color`
    source and its clip comes from a chain that may have put itself on a card.
    Reading only the first said nothing about the graph the check exists for.
  - **Sound is never on a card.** An input that decodes its pictures on one
    still decodes its soundtrack with libavcodec, and leaving that out reported
    the `atrim` hanging off the same `-i` as a filter that could not read what
    reached it.
  - **An input can already be up, and the fact rides on the node.**
    `-hwaccel_output_format` is what decides it, `derive.js`'s `inputOnDevice()`
    is the one place that reads it, and it is written onto the input node as
    `onDevice` — so a graph answers out of itself rather than out of the
    document's live input list, which is what `derive()` being a pure function of
    its arguments means. Two copies of that question is what there was: one term
    short here (`hwaccelOutputFormat` alone rather than `hwaccel &&
    hwaccelOutputFormat`) and read off module state, and `subgraph.js` had no
    term for it at all — so previewing the card of a clip opened with `-hwaccel
    cuda -hwaccel_output_format cuda` skipped the `hwdownload` and failed with
    exactly the message this check exists to explain.

  It is deliberately conservative: only a filter that *belongs to a device*, or
  one known to pass anything through (`trim`, `setpts`, `fps`…), is judged at
  all. A false accusation about a graph that runs is worse than a missing note
  about one that does not.

- `graph/overlay.js` — the part of the graph a person made, held apart from the
  part that is derived, because **the skeleton is thrown away and rebuilt on
  every timeline edit**. Five pieces of data: `inserts` (ordered, each pinned to
  a named point), `locks` (params keyed by a node's anchor), and — since the
  graph stopped being a chain of splices — `nodes`, `wires` and `cuts`.
  `derive(spec, sources, { overlay })` puts them back in that order, because
  each step is described in terms of what the ones before it produced, and
  reports every lock that *disagreed* with what it just derived as an
  `override`, which is what lets the outranked control say so.

  **Structure needs a vocabulary that survives the rebuild, and there is exactly
  one**: a key. A free node carries an id from the same counter the inserts use;
  a wire is `{ from, fromPort, to, port }` where both ends are keys; a cut is
  `key#port`. Nothing refers to a node object or to a position in an array.

  Three things about that shape, each with a reason:

  - **A cut is a thing, not the absence of one.** The skeleton grows every
    derived wire back on every rebuild, so "there is no wire here" cannot be
    said by leaving something out. It is what lets you be half way through
    wiring something in between.
  - **Pads are worked out between the locks and the wires.** A lock can change
    how many pads a node has — `amix`'s count is an option like any other — so
    `declarePads()` runs after the locks, and a wire is checked against pads
    that exist by then.
  - **A wire whose pad stopped existing is kept and reported, not dropped.**
    Same rule as an anchor whose point is out of range, same reason: putting the
    count back has to bring the wire back, or a mistyped number is lost work.

  Five older rules are load-bearing and each has a failure behind it:

  - **Anchors, not positions.** A derived node is named for what it is
    (`clip:7/scale`, `composite/overlay:7`); an insert point is a named place
    on a wire (`clip:7/after-scale`). Ids come from a counter that never
    restarts, so they identify nothing across two derivations. `buildSpec()`
    carries `clip.id` for exactly this.
  - **There is no insert point after the output colour conversion, and no
    socket behind it either.** That chain is in the printed graph and not in
    the one this binary runs, so a filter there would be in the encoder's
    colour in the command and in RGBA in the render. One point, two pictures.
    It is now structural rather than a rule to remember: the conversion is
    attached after the overlay is applied, so there is nothing there to wire to.
  - **An insertion moves the label.** Only chain-final nodes carry one, so a
    node spliced onto the end of a run takes `v0`/`vout` with it — left behind
    it names a pad no chain produces.
  - **An anchor whose point is not in this graph is kept, not dropped.** A clip
    trimmed out of the range takes its points with it and brings them back.
    `retain()` is the only thing that deletes, and it is driven by which clips
    are open.
  - **A lock that agrees has overridden nothing.** It is still a lock; it just
    has nothing to report yet, and marking the control anyway would badge every
    field anyone had ever touched.
  - **A node that goes takes everything keyed by its id with it**, through one
    `forget()`: the insert points that hung off its own pads, the card's width
    and where it was dropped. Three places lose a node — `removeInsert`,
    `retain` dropping a source whose input has been taken off the Sources stage,
    and `restore` dropping an input node it will not put back — and each of them
    used to remember a different subset of that. It is not merely a blob that
    grows: `pins` and `sizes` are keyed by the id, the counter starts at one on
    every run, and the ids dropped on read were not counted into it, so the next
    filter spliced in arrived at a width and a position nobody gave it. A `u<n>`
    key naming no record is dropped on read for the same reason — nothing else
    in that file is shaped like one, every anchor carrying a `/` or a `:`.

  A split copies a clip's inserts and locks to both halves (`cloneClip`, called
  from `splitAtPlayhead`) — a cut should not change how either half looks — and
  copies neither pins nor **wires**. Not wires for a stronger reason than the
  pins: an input pad holds one wire, so a copy of one would be a second producer
  arriving at a pad that already has one, which is not a graph.

  Persisted in `localStorage` under `ffmpeg-bro.graph`. **The shape grew rather
  than changing**, which is what lets a blob written before any of this load as
  exactly what it was — three keys it has never heard of come back empty — and
  is worth the restraint it cost, because the alternative was a migration for
  work somebody had done and could not get back. There is still **no project
  file**, and this was already the first thing that made one worth having; a
  hand-wired graph is work in the way a slider position is not, and the next
  agent to want one should say so rather than keep adding to a localStorage key.
  **A node naming one of the document's inputs is the one thing not persisted**,
  and that is not an omission to be fixed by writing it out: the inputs
  themselves do not survive a restart and `inputs.js` hands ids out from one
  again on every run, so a restored `in3` would name whichever file happened to
  be third next time — a graph that quietly reads a different file, which is
  worse than losing the node. That is the second reason a project file is owed.

- **Sources in the graph — the `movie` decision, and it is the load-bearing one
  in this area.** A file the graph reads that no clip is cut from is what a
  watermark, a logo bug and an insert are made of. ffmpeg writes it both ways —
  `-i logo.png` with `[1:v]overlay`, and `movie=logo.png,overlay` — and this
  application makes it an **input reference**: `overlay.addSource(inputId)`
  records `{ id, kind: 'input', input }`, and `derive()` turns it into an
  `input` node with the next `-i` index after the clips', a pad per stream the
  probe found, and `node.input` naming which of the document's inputs it is.
  Two arguments, and the second is the one that generalises:

  - Everything that decides *how a file opens* belongs to the `-i` — the forced
    demuxer, `-probesize`, `-loop`, `-ss`, `-t`, `-stream_loop`, and for a URL
    the whole protocol option table. A `movie` node carries a filename and a
    seek point, so making it the mechanism means rebuilding all of that inside a
    filter argument, badly, beside an input model that already has it.
  - The Sources stage claims to be **every file this render opens**. A `movie=`
    names one that never appears there. So `sources.js` reports what a `movie`
    node names under *Opened by the graph*, says what it costs, and offers to
    make it an `-i`; and an input the graph reads says `read by the graph` on
    its card, is not counted as unused on the spine, and cannot be removed while
    a node names it.

  `movie` remains reachable — it is an ordinary filter with no inputs and the
  palette offers every one of those. Two things about it needed writing down:
  its pads come from the `streams` option, which is a *string* in ffmpeg's
  stream-specifier grammar and not a count, so `padCount`'s general rule left it
  with no output pads at all and it is written out in `filters.js` beside
  `concat`; and a Windows path inside a filter argument needs its colon escaped
  (`C\:/logo.png`), which the panel says where somebody is about to type one.

  How the id reaches the derivation is `spec.inputInfo`, index-aligned with
  `spec.inputs` and carrying `{ id, name, path, streams }`. An **id and not an
  index**, because the index is the `-i` number and shifts when anything above it
  is removed — the same reason a derived node is held by its anchor. The renderer
  ignores the field exactly as it ignores `clip.id`.

- **A source is a filter with no inputs, and libavfilter says which.**
  `filters.js`'s `isSource()` reads it off the registry entry (`!inputs &&
  !dynamicInputs`) rather than through `padsOf`, because it is asked of every
  filter in the build at once and `padsOf` builds an option table for each
  dynamic one. `amix` and `hstack` declare no inputs and are *not* sources —
  they grow as many as they are told. There is no list of generators anywhere.

  Three consequences worth keeping:

  - **A placed generator carries the render's `size` and `rate`**, looked up in
    the filter's own option table (`size`, `rate`, `sample_rate`) and written by
    `panel.js`'s `sourceDefaults` from `hooks.canvas()`. A graph whose last pad
    is a different size from the render is refused rather than rescaled — that
    rule stays — so agreeing at the moment of placing is what makes the ordinary
    case work without `sizeFromGraph`, which remains what the node previews use
    and only they. For an export the size is a decision somebody made.
  - **A generator has no length**, and the convention `inputDuration` and a
    recording already share is followed rather than a third one invented: `-t` is
    the only thing that can
    answer and zero means nobody knows. `export/spec.js`'s `graphLength()` is a
    generator's own `duration`/`d` or a referenced input's length, and `range()`
    falls back to it when the timeline has no duration. Nothing saying anything
    is a refusal that names `d`.
  - **With no clips there is no derived canvas.** `derive()` builds the black
    `color` base only when something is laid over it: left in, the moment a
    `testsrc` is wired to the sink instead, the canvas is a source nothing reads
    — a graph libavfilter refuses. The video sink is simply unwired, which is
    the honest state. The audio sink likewise exists when something maps it,
    either an audible clip or an overlay wire to `out:a`, because an
    unconditional one would refuse every silent render.

  `derive()` only tolerates an empty timeline when the overlay holds a node that
  *produces* — an input reference or an `isSource` filter. An unwired `hflip` on
  its own is still "nothing on the timeline falls inside the range", because
  deriving a graph around it would report five problems where one sentence is
  true. And `check.js` treats an **input's pads as ffmpeg's, not a filter's**:
  `[1:a]` that nothing references is ordinary, so only an input nothing reads at
  all is worth a word.
- `graph/view.js` + `graph/card.js` + `graph/canvas.js` + `graph/layout.js` — the Graph
  stage. Nothing here builds a graph; it asks `derive()` for one on every change and
  draws the answer, so a redraw throws away every node object and **nothing may be
  remembered by reference** — the selection is held by `panel.keyOf()`, which is the
  anchor for a derived node and the id for a user one, and the hovered insert point is
  held by *its* id for the same reason (holding the wire object meant a preview landing
  on any card made the `+` you were reaching for vanish irrecoverably).

  **A node editor is a solved interface and this one now does what the solved one
  does.** Blender, Nuke, Houdini, TouchDesigner, Unreal, n8n and React Flow agree on
  the same handful of things and the version invented here was missing most of them.
  What was adopted, and the reason each is not decoration:

  | | |
  |---|---|
  | sockets, one per port, typed by colour | wires arrived at a bare edge, so `overlay`'s two inputs — the canvas and the clip, not interchangeable — were one point |
  | a header that is also the handle | dragging anywhere would mean a field could not be dragged through |
  | fields on the card | reading a value and changing it were two places |
  | drag to place, `Re-layout` to give it back | positions were computed and could not be argued with |
  | a dotted grid | nothing said the canvas was moving |
  | a minimap | a nine-node graph runs off the screen |
  | zoom readout, `−` `+` `Fit` | `Fit` was the only control |
  | level of detail | nine cards of 10px argument text at 0.4× is nine smudges |
  | the selection's wires lit, the rest dimmed | every wire was equally loud |
  | `+` on the wire under the pointer | five of them, always, read as part of the graph |
  | left-drag marquee, middle-drag pan | selecting eight nodes was eight clicks |
  | drag socket → socket to wire | there was no way to make a connection at all, which confined the whole stage to filters that can be spliced |
  | let go over nothing for a palette | placing a node and wiring it are one gesture with a pause in it, exactly as inserting one on a wire already is |
  | a wire is selectable and `Delete` cuts it | the other half of being able to make one |

  Six things about how it is built are load-bearing:

  - **`portY()` is exported from `layout.js` and used by both the wire and the socket
    it lands on — at both ends.** A dot anywhere else says this wire goes to that port
    when it does not, which a source card cannot afford either: its picture and its
    sound leave the same edge, coloured by the pad rather than by the card, and two
    dots at one point would say the two wires were interchangeable.
    The same line found a bug that had been there since the layout was written:
    `g.producers(b)` was being handed a *box*, which has no `id`, so the model matched
    nothing, the port count came back zero and every arrival was clamped to the middle
    — the comment above it had been claiming the opposite the whole time.
  - **`Fit` never crosses the level-of-detail threshold** (`FIT_FLOOR` *is* the
    threshold). That removes the only loop this design can have — cards measured at one
    detail, framed at a zoom that implies the other, rebuilt, framed differently — by
    making it unreachable rather than by detecting it. Going below is a thing only the
    wheel can do, where no fit is running to argue with.
  - **Editing on a card commits on `change`, never on `input`, and the field being
    used survives a redraw — where it is *and what is half-typed into it*.** An edit
    locks the node, a lock redraws the graph, and a redraw throws away every card: on
    `input` the field vanishes between keystrokes, and without the restore a
    `<select>` loses focus mid-gesture. The half that bites is the value, and it took
    a flaky test to find: an edit is not the only thing that redraws this stage — a
    node preview arriving a second later rebuilds every card too, and it rebuilds
    them *from the model*, so what had been typed and not yet committed was silently
    eaten. `cards.noteFocus()` reads the ambient focus and its value off the document
    before the rebuild, because the document is the only thing that knows them; it
    stands down when an edit has already recorded an intent, since putting the old
    text back over the value that edit just committed would be undoing it. Controls
    also stop `mousedown` propagating, or using one drags the node it is on.
  - **A pin is visual.** `layout()` puts a pinned node where it was dropped and changes
    nothing else — the flow does not part to make room. That is what Nuke does; a layout
    that reflowed around pins would mean dragging one node rearranged the eight you were
    happy with. Pins live in `overlay` next to the card sizes, keyed by anchor so they
    survive the rebuild, and **outside `isEmpty()`**: where a card sits must never
    change which of the renderer's two paths runs. A split copies a clip's filters and
    *not* its pins, because two cards cannot be in one place.
  - **A socket is hit-tested from the layout, never from the document.**
    `canvas.socketAt()` walks `placed.nodes` and computes each pad's position
    with the same `portY()` the wire and the dot use. Asking what element is
    under a point would ask about a container with a `transform` on it, and the
    socket elements are eight pixels wide — four at 0.6× zoom, which is a target
    nobody can hit. It also makes the gesture testable without
    `elementFromPoint`, which is how `tests/ui_graph.js` drives it.
  - **A drag's origin and the pointer's position are two fields.** They were one
    in the first version of `startWire`, so the first mouse move overwrote where
    the drag began, every completed drag measured as zero pixels long, and
    letting go over empty canvas did nothing at all — which reads as a press
    that did nothing, because a zero-length drag is exactly that. The general
    shape: a field that means "where this started" cannot be the same field as
    "where this is".

  `layout.js` stays pure geometry — a graph, a `sizeOf()` and a `pinOf()` in, positions
  out — so the view can build its cards, measure them and only then place them, which
  is the build/measure split the range strip already uses: a node is as tall as the
  arguments its filter was given and as tall as the picture in it. Columns are
  longest-path depth; within a column a node wants the average row of what feeds it,
  which keeps a clip's whole chain on one line. `canvas.js` draws the grid, the wires
  and the minimap in screen coordinates against an untransformed canvas, while the
  cards live in a container with a `transform`: a curve stroked into a scaled canvas is
  a blurred curve and the reason to zoom in on a graph is to read it. The `+` is a DOM
  element in the transformed container rather than something drawn into the canvas,
  because hit-testing a bezier by hand to find out which wire was meant is work with a
  DOM node's name on it.

  **Two subset traps found here, both worth knowing before styling anything.** The base
  `button` rule is a 26px single-line control, so a button holding two lines needs
  `height: auto` and a round one needs `min-width: 0` — the filter palette was
  unreadable for want of the first and every `+` was an oval for want of the second.
  And this engine does not blockify an absolutely positioned inline element: a `<span>`
  socket with a width and a height came out one pixel square until it said
  `display: block`.
- `graph/subgraph.js` + `graph/preview.js` — **what each node actually produces**, drawn
  in the card. A node states what a filter is configured with, which is not the same as
  knowing what comes out of it: `crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25` is a claim about a
  picture. `subgraph.js` keeps a node's ancestors and nothing else, ends the graph there
  with a `scale` that fits it into the card, and hands back a `-filter_complex`;
  `preview.js` renders it through the same `GraphSource` the export uses and plays the
  result in the card. **There is no preview-only path** — a preview that agreed with the
  render most of the time would be worse than none, because it would be trusted.

  Four rules, not tuning knobs: one render at a time and always behind the export (the
  host has a single slot); only ancestors and only seconds, with each input seeking to its
  window; keyed by the subgraph *text*, so a rebuild that regenerated every node object
  changes nothing and an edit that does not reach a node leaves its picture alone; and
  nothing starts until the graph has held still, or dragging a slider would render every
  value it passed through. The range is snapshotted when the stage opens rather than
  following the playhead, because a playhead move would otherwise invalidate every node.
  **A sink shows the pad it maps** — `video out` and `audio out` are the two nodes on the
  screen that mean *the render*, and they are the first things anybody clicks; the picture
  is the producer's, so `sync()` hands it that one rather than rendering it twice.

  **A sound pad gets a waveform, and libavfilter draws it.** `volume=0.6` is a claim about
  a sound in exactly the way a crop is a claim about a picture, so the tail of an audio
  preview is `asplit` into two pads: one goes to `showwaves`, which turns those very
  samples into a picture, and one is the sound itself. What comes out is an ordinary video
  with an ordinary soundtrack, which is what lets a card play it through the same
  `<video>`, the same two-element swap and the same play button every other node uses —
  unmuted only while it is being played, because nine cards looping their two seconds at
  once is a room nobody can think in. Three decisions there were made by what the
  alternatives cost:
  - **Not `showwavespic`.** It draws the whole window as one still, which is the nicer
    picture, but it emits that frame only at end of input — so a looping card would show a
    waveform for one frame and black for the rest.
  - **Not our own canvas from `bro.media.peaks()`.** That decodes the render again to draw
    a second version of what is already in it, and bro's `<video>` refuses a file with no
    picture in it (`VideoPipeline::adoptSource` returns false without a video decoder), so
    a sound-only render could not be played at all.
  - **`showwaves` emits one blank frame before any waveform**, and that is exactly the
    frame a paused or looping element sits on, so every waveform on the screen was a black
    rectangle. `trim=start_frame=1,setpts,tpad=stop=-1:stop_mode=clone` drops it and holds
    the last frame instead of leaving the render one short at the other end. Cloning rather
    than counting: the render stops pulling when it has enough.
- `graph/play.js` — a node **played** rather than looked at, which is a different question:
  a still answers "is the crop right" and only a run of seconds answers "does this hold up".
  The range is cut into pieces, each is rendered in front of the picture, and each plays at
  its own rate. **The renderer is the bottleneck and the readout says so** — every second
  on this stage is a real render through libavfilter, so an expensive graph cannot be
  played at speed, and the two alternatives are both worse: dropping frames would make a
  slow filter look fast, and rendering something cheaper would show a picture the render
  will not produce. When the renderer keeps up it is real time; when it does not the
  picture waits and the card reports the rate actually being sustained, waits included.
  That number is a fact about your filter.

  `play.js` renders nothing — it is the bookkeeping, and `preview.js`, which owns the one
  slot, asks it what to do first. Splitting it that way is what keeps the slot in one
  place. One node plays at a time for the same reason: nine at once is not nine ninths of
  the speed, it is one playing and eight stuttering. Three things in `view.js` go with it —
  **two `<video>` elements** for the playing node, since `src = next` is a reload and a
  blink every couple of seconds is what you would end up watching instead of the filter;
  the frame loop **polls `currentTime` against `duration`** rather than listening for
  `ended`, which this engine may not raise; and it **never redraws** — a redraw re-derives
  the graph and re-measures every card, so the clock is written into the element in place
  and only starting and stopping change the card's structure. The still already on a card
  is handed over as the first piece, so pressing play starts on that frame.
- `graph/enable.js` + `graph/when.js` — **a filter that is on for part of the render.**
  `enable=` is libavfilter's timeline support and the nearest thing ffmpeg has to a
  keyframe; `enable.js` is the pure half (parse, print, `isOnAt`, `supportsTimeline`)
  and `when.js` is the strip in the panel and the one line on the card.

  **The control writes an `enable` expression and nothing else**, which is this
  codebase's one answer to "a friendly control and the raw text must not drift" —
  the same shape as the Quality slider and the advanced editor both producing
  `{crf: 20}`. The strip is a *reading*: it parses the stored value on every draw
  and writes only on a drag or a keystroke, so there is no second state. Four
  things follow and each is load-bearing:

  - **An expression it cannot draw is refused, not rewritten.** It reads
    `between(t,a,b)`, `gt`, `gte`, `lt`, `lte`, joined by `+`, with plain numbers
    and the variable `t`. Anything else — `mod(t,4)`, `n`, `pos`, arithmetic
    inside a term — comes back `{ ok: false, reason }`, the strip stands down and
    says which part it gave up on, and the text is untouched. `gte` prints as
    `gte` and not as `gt` for the same reason: printing one as the other is a
    rewrite of somebody's expression.
  - **The quotes are part of the stored value.** `print.js` writes an argument
    verbatim, deliberately, and a filtergraph separates filters with commas — so
    `enable=between(t,1,2)` is three filters and a syntax error. What is stored is
    `'between(t,1,2)'`, and `parseEnable` accepts it with or without so that a
    value typed by hand still draws.
  - **A filter with no `AVFILTER_FLAG_SUPPORT_TIMELINE` is offered no control.**
    libavfilter's `set_enable_expr` checks the flag and returns
    AVERROR_PATCHWELCOME, so the graph never builds — it is refused, not ignored,
    which `tests/export_test.cpp` asserts because the whole UI rule rests on
    which of the two it is. `f.timeline` on the registry entry is the answer;
    `check.js` reports one arriving the other way, against the node.
  - **The ruler is worked out from the graph, not assumed.** `clockOf()` walks
    ancestors: past a `setpts`/`asetpts`, `t` is time into the render; a node
    spliced in before one — at a clip's `after decode` point — is on the source
    file's own clock, and the window is read off the `trim` below it.

  Playing a node is where it is judged, so `view.js`'s readout appends `on`/`off`
  from `data-enable` on the card — read off the element rather than re-derived,
  because that runs on the frame loop.
- `graph/panel.js` — the column beside the graph, in four modes over one panel:
  what the selected node is set to, what can go on the wire whose `+` was
  clicked, what can go on the end of a wire you let go over nothing, and what a
  selected *wire* is. One panel for all of it, because each of them is half of
  one gesture with a pause in it — the thing you just made must not be somewhere
  other than where you were looking. Now that values are also edited on the
  cards, the division is that a card shows what is *set* and the column shows
  everything the filter *has* — thirty options for `scale` is a column, not a
  card — plus the node's pads and any reason it will not run.

  **Two palettes, and the difference between them is the difference between the
  two gestures.** `spliceable()` offers one input and one output of the wire's
  stream, which is what splicing *means* rather than a simplification of ffmpeg.
  `canTake()` offers anything with a pad of the right stream on the opposite
  side, which is where `overlay`, `amix`, `concat`, `xfade` and `split` arrive —
  they are placed and wired rather than spliced, because there is no wire a
  two-input filter could be dropped onto. Both are filtered from libavfilter's
  own registry through `padsOf`, so neither is a list of what is supported.

  **`canTake`'s palette leads with sources**, but only where one can attach:
  `wantsSource()` is "no wire in the air, or a wire that came off an *input*
  pad", because a source has no input for a wire off an output pad to land on.
  The document's own inputs come first — that is the `movie` decision made
  visible — and libavfilter's generators after them. Dragging backwards out of
  an empty input and picking a file is what makes a watermark short: what you
  get back is already wired to the pad you were trying to fill.

  A wire's panel says which pads it joins and whether it is yours or the
  derivation's, because that is what `Delete` means: forgetting a wire of your
  own, or *recording the absence* of a derived one.

  Positional arguments are edited in place and labelled from the node's
  `posNames`, which the derivation records because ffmpeg's option tables carry
  aliases as separate entries and the n-th option is not the n-th positional
  argument.

  **Everything the panel keeps between draws is held by name**, because this
  column is rebuilt whole on every derivation and a derivation is not only
  something you asked for — a node preview finishing rebuilds the stage too. So
  a node is a key, a wire is a key and a pad number, and **an insert point is an
  id that is re-resolved against the derivation that has just run**: it is the
  one kind of selection that can stop existing while it is open, and held as an
  object the palette went on offering filters for a wire that was not there,
  recording inserts against an anchor `applyOverlay` then skipped without a
  word. It says the wire has gone instead. The field being typed into is kept
  the same way — `card.js`'s `noteFocus`/`restoreFocus` one column over, keyed
  on whichever `data-*` attribute the control was built with, standing down when
  an edit has already recorded an intent. Values commit on `change`, so what is
  half typed is not in the model and a rebuild from the model eats it.

  Cards are absolutely positioned divs over a `<canvas>` that draws only the
  wires — the pairing `timeline.js` already uses. Drawing the nodes into the
  canvas too would mean re-implementing text wrapping to save nothing. **Pan and
  zoom are a `transform` on the card container, and the wires are drawn in
  screen coordinates against an untransformed canvas**: a curve stroked into a
  scaled canvas is a blurred curve, and the reason to zoom in on a graph is to
  read it. Two consequences worth keeping in mind — the card's width is written
  before it is measured (left to itself it is shrink-to-fit inside a container
  that is deliberately zero wide, so every height would be of a different card),
  and the container's transform is cleared for the measurement so heights come
  back in graph coordinates whatever the zoom is.
- `format.js`, `icons.js` — timecode/byte formatting, and SVG icons painted from
  `data-icon` attributes. `icons.js` is the one place that still writes markup as a
  string: the icons are `<svg>` path data, closer to an asset than to a UI, and
  createElementNS would make a table of paths unreadable to save nothing.

### Invariants worth knowing before changing playback

- **A clip's length comes from its video stream's own duration**, never the container's.
  They differ routinely (audio outlives the last picture) and using the container's leaves
  the playhead running past the end of the video.
- **The topmost clip under the playhead is the master clock** while playing. Other active
  clips are *chased* — corrected only when they drift past `DRIFT_LIMIT`, which is 0.12 s,
  three frames at 25 fps and rather more at 60 — because correcting every frame means a
  seek per clip per frame, and free-running decoders come apart within a minute.
- **`setPlayhead(t, seek = true)`** exists because writing `currentTime` back while the
  decoder drives the clock fights it, so *playback* is the caller that passes `false`.
  The default is the seek, which is what every other caller wants and what makes a
  plain `setPlayhead(t)` move the picture; reading it the other way round gets you a
  `currentTime` write on every active clip from a call you believed was inert. A clip
  that has just come into view is seeked whatever the caller said, because its decoder
  is parked wherever it was left. When paused, `adoptDecoderTime()` reports where the
  picture actually is, not where the seek asked for.
- **Frame stepping uses `video.stepFrame()`**, not `currentTime += 1/fps`: fps is an average
  and the seconds round-trip misses frame boundaries, so a back-step lands where it started.
- **Two clips must never overlap on one track** (no answer to "which is on screen").
  `resolveOverlaps()` pushes neighbours aside; trims stop at neighbours. Overlap *across*
  tracks is the point of having tracks — leave it alone.
- **Audio multiplies**: the clip's own `volume`/`muted` (part of the edit) times the
  transport's (how loud you are listening).
- **Multi-select edits must not leak values.** `common()` returns `undefined` when the
  selection disagrees, and fields render blank/`mixed` rather than one clip's value.
- **The renderer must never learn about layout.** `buildSpec()` sends rectangles in canvas
  pixels straight from `viewer.placement(clip, project.width, project.height)`; fit, zoom,
  pan and grid are resolved in one place. Anything that changes how a clip is placed on
  screen has to change `viewer.placement()`, and then the export follows for free. Paint
  order is the `project.clips` array order (already sorted bottom-track-first) as `z`.
- **App preferences go in `localStorage`, not `bro.settings`.** bro's settings are a closed
  schema of engine keys; an unknown key is warned about and dropped.
- **The timeline's rate and the output's are two questions, one home each.**
  `projectFps()` in `ui/project.js` is what the ruler steps by, what a timecode counts
  frames in and what the spine's Compose card states; `outputFps()` in
  `ui/export/state.js` is what the encoder is asked for. A 60 fps render off a 25 fps
  timeline is an ordinary thing to want, so they are not merged — but the *fallback*
  behind them was written out at eight points of use in two different answers, 25 at
  one end and 30 at the other. Nothing was ever visibly wrong (`project` is seeded at
  25 and `makeClip` falls back to 25, so `project.fps` is never zero and the `|| 30`
  arms were unreachable); one home is what keeps a probe reporting no rate from making
  one moment read as two timecodes. The `|| 30` in `derive()` and in the command bar's
  `-g` are a different question again — they are defaults for a *spec* with no rate in
  it, which is a hand-written one.
- **`buildSpec()` is memoised for exactly one answer, and no longer.** `warnings()` and
  `command.parts()` each open with `freshSpec()` and everything inside them reads
  `currentSpec()`; between them they used to derive the same edit five times per
  redraw of a panel that redraws on every keystroke (measured: `warnings()` 1.46 ms →
  0.44 ms, a redraw pass 2.40 ms → 1.43 ms). The memo cannot outlive a synchronous
  call, which is what makes it safe: invalidating from listeners would have to name
  every place a setting is written, and a spec quietly one edit behind is worse than a
  slow one. `currentGraph()` hands back the derivation that spec was built with, so
  the hardware warning and the "without your filters" refusal share one `renderGraph()`.

## Style

Comments here explain *why*, in prose, at the top of a file or above a non-obvious decision
— often several sentences about the failure mode being avoided. Commit messages follow the
same voice (declarative, about the behaviour: "Seek targets round down, not to nearest").
Match that rather than adding `// increment i` noise.
