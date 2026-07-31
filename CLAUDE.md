# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and test

Requires Visual Studio 2022, vcpkg (`VCPKG_ROOT` set, or pass the toolchain
yourself), and a checkout of [bro](https://github.com/wlejon/bro) beside this
repo — or `-DBRO_DIR=<path>`, **cloned `--recursive`**. The vcpkg `ffmpeg[...]`
feature list is in README.md; `x264`/`x265` are needed for export, not for
playback.

`CMakeLists.txt` turns bro's `BRO_WITH_SOUNDML` on before `add_subdirectory`,
which is what makes `bro.sense` a working namespace here rather than the
*unavailable* stub bro's default `app` profile installs. bro's `_bro_require`
chain pulls `BRO_WITH_LM` and `BRO_WITH_TENSOR` in behind it, so this is four
features and 684 more source files — and 27 s of build and 2.7 MB of binary,
because the linker takes what is referenced. The reasoning, the alternatives and
the measurements are in the block itself. Two things about that namespace are
easy to get wrong and are written down here because nothing else states them:
**the real binding does not set `available`** — only the stub does, so the
feature test is `bro.sense.available !== false` and never `typeof
bro.sense.analyze`, which is a function on the stub too (it is a `Proxy` whose
every other property is a thrower). And `bro.sense` is **not installed in worker
realms**: bro's `worker.cpp` builds its context from an explicit list and
`installSenseBindings` is called only from `Engine::initAppRealm`, exactly as
`bro.ffmpeg` is only installed by `installHostBindings`.

```
cmake -B build
cmake --build build --config Release
ctest --test-dir build -C Release

./build/Release/ffmpeg-bro [media-file]                  # the application
./build/Release/ffmpeg-bro-headless ui/ <script.js> [-- args]   # the same engine, scripted
```

One test, by ctest name (`decode`, `export`, `capabilities`, `inputs`,
`sequences`, `capture`, `hardware`, `telemetry`, `marks`, `ui-player`,
`ui-sources`, `ui-hardware`, `ui-export`, `ui-sequence`, `ui-report`,
`ui-measure`, `ui-subtitles`, `ui-capture`, `ui-filtergraph`, `ui-graph`,
`ui-document`, `ui-output`, `ui-telemetry`, `ui-marks`):

```
ctest --test-dir build -C Release -R ui-graph --output-on-failure
```

Or standalone, **from the repo root** — the headless binary writes screenshots
and renders relative to the working directory, which is why CMakeLists sets
`WORKING_DIRECTORY` to the source dir for most tests:

```
./build/Release/ffmpeg-bro-exporttest <file> [<file2>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file> [<video-only>] [<sound-only>]
```

The manual's [Testing](docs/manual/testing.md) part lists every
standalone invocation and what each suite is about.

Test media is **generated, never checked in**: `tests/make_fixture.cpp` writes
`build/fixtures/` as a CTest `FIXTURES_SETUP`, so `-R` on any suite pulls the
generator in automatically. Each fixture exists for one fact that cannot be
faked with content — `silent.mp4` has *no audio stream* (not a quiet one),
`sound.m4a` has *no video stream*, `rotated.mp4` carries a display matrix,
`telemetry.mp4` carries a `gpmd` data track — a stream identified by its fourcc
alone, since every data stream probes as `bin_data`, and carrying **real GPMF**
now that there is a parser, because `SCAL` is a divisor and a value reported
without it is off by orders of magnitude while still looking plausible
(`tests/gpmf_write.h` builds the payload for the fixture and for the parser test
both) — `marks.m4a` is the only soundtrack here in which anything ever
*happens* (transients at 1, 3 and 5 s, a 1000 Hz tone from 6.0 to 7.5, over a bed
of **stationary** noise, because a bed that swells is a bed with spectral flux in
it and the first version of it manufactured eight onsets in the first second of
"silence") — and `picture-cues.mkv`
carries a `dvdsub` track, whose cues are *pictures* of characters and are the
only thing here that reaches the refusals a bitmap subtitle earns.
Every suite also runs against any real file, and skips the sections whose
fixture is absent rather than failing; keep that property when adding tests.

## What this is

A GUI over ffmpeg built on the bro engine. libav* is **linked into this binary**
and registered as a bro media backend, so `<video src="anything.mkv">` decodes
the real stream in-process — no subprocess, no pipe, no proxy transcode. That is
the reason for the repo split: bro stays MIT and ffmpeg-free, libav reaches it
only through `bro::video`'s codec-agnostic interfaces, and linking ffmpeg is what
makes *this* binary GPL-3.0-or-later.

Three layers:

- **`src/native/`** — C++ built as `ffmpeg-bro-core` (static), linked by both
  executables and by every test.
- **`ui/`** — the application, plain ES modules + DOM, run by bro's QuickJS
  engine. `ui/bro.json` is the window manifest.
- **`docs/`** — `manual/`, one file per stage plus the document, the keyboard,
  the testing guide and an honest "Not yet" ([the
  index](docs/manual/README.md) lists them), and api.md (the `bro.ffmpeg` host
  surface). README stays short; the depth lives here.

The UI is **not a browser**. The DOM is bro's subset, and the gaps matter, so
check what the engine actually implements before reaching for a web API — and
check it against *this* bro rather than against this file, because the subset
grows. `Document.dispatchEvent` was the standing example of a gap here until
bro grew it; the tests that dispatch key events on `<body>` and let them bubble
are written that way for that reason and are simply no longer forced to be.
`bro.media` is installed in worker realms, which is what `ui/analyze-worker.js`
uses for full-file peak and filmstrip decodes off the UI thread.

## The model everything is arranged around

ffmpeg's model is inputs → streams → a filter graph → encoders → a muxer → an
output. This app presents exactly that as its navigation — `ui/shell.js` draws
the spine: **Capture → Sources → Compose → Graph → Encode → Write**. Anything the
app cannot yet express usually has an obvious home in that chain and no home in
an NLE's timeline-plus-export-dialog model; put new capability where ffmpeg puts
it.

Stage views hide each other with `display:none` and are **never unmounted** —
the viewer's `<video>` elements *are* the decoders. Consequence that keeps
biting: anything in the frame loop that measures a panel must ignore a
measurement of zero, because most of the window is `display:none` at any moment.

### The document is the other seam

`ui/document.js` `snapshot()` produces one plain JS object describing the whole
*edit* — inputs, clips, canvas, graph overlay, output settings — and `open()`
puts one back. A `.fbro` file is that object stringified; an undo stack is a
list of them. Write the file format first and you get a serialiser, which can
only ever do one of those.

`ui/history.js` is the second consumer: a step of undo is a snapshot minus its
`output` key, held as JSON text so that comparing two states is `===` and
parsing one out is inherently a fresh object. `open()` **reconciles** rather than
rebuilds for its sake — an input described exactly as it already is costs
nothing, and a clip of one keeps its `<video>`.

**Ids are part of it, and that is the load-bearing part.** A clip's id, an
input's id and a cue track's id are names other files write down —
`clip:7/after-scale` is a graph anchor, `in3` is a source node, `cues:3` is a
subtitle row on the Write stage — so an open that renumbered would silently
re-point a filter at a different shot or a row at somebody else's dialogue.
`useClipId`/`useInputId`/`useCueId` are how the three counters are told what a
document has already handed out.

`ui/cues.js` is the third thing in the document that is *content* rather than a
description of a file, beside the clips and the graph: cues you typed, on the
timeline's own clock, with a lane (`ui/timeline.js`) to retime them against A1.
Two decisions in it are not negotiable. **The source file is never written to** —
taking a file's cues in is a fork, the row is repointed in place so both copies
can never render, and the input is read exactly as it always was. And **a render
materialises the track into a real subtitle file beside the output and reads it
back as an ordinary `-i`**, because ffmpeg has no way to receive cues except as a
file; `attachCueFiles` in `ui/export/spec.js` names it (turning `cues:3` into
`decode:4:0`, which is why nothing downstream learned the third form exists) and
`ui/export.js` writes it at the one moment a render starts. `cueTextOf` answers
with `raw` and `header` beside `text` for exactly one reason — a fork through the
words alone would silently flatten somebody's styled subtitles, which is the one
failure on this path that loses work. `ui/graph/overlay.js`
has two reads for exactly this reason: `restore()` (localStorage, drops input
nodes because the inputs are not coming back) and `adopt()` (a document, keeps
them because they are).

### The spec is the seam

`ui/export/spec.js` `buildSpec()` produces one plain JS object describing the
whole render. Three things consume it and must not disagree:

1. `bro.ffmpeg.render.start(spec)` → `src/native/ffmpeg_bindings.cpp` reads it
   into `ExportSettings` (`ffmpeg_export.h`) and renders.
2. `ui/graph/derive.js` turns the *same object* into the node graph, so the
   graph cannot describe a render the app would not perform.
3. `ui/command.js` prints the ffmpeg invocation from it.

Placement rectangles come from `ui/viewer.js` `placement()` in canvas pixels —
the renderer never learns about fit/zoom/pan/grid. One layout implementation,
and export follows the screen for free.

`ui/command.js` draws two kinds of statement differently on purpose: everything
past the compositor is **exact** (those keys are literally what `av_opt_set(...,
AV_OPT_SEARCH_CHILDREN)` is called with), the composition is **equivalent**
(the renderer composites RGBA rather than building a graph). Do not blur them.

### The graph

- `ui/graph/model.js` — the graph the app *holds*. One node kind, because ffmpeg
  has one: crop/opacity/stacking are `crop`/`colorchannelmixer`/`overlay`, not
  special cases. Only the ends differ (`input` = an `-i` with an output per
  stream read — `v`, `a`, and `s` for a **bitmap** subtitle track, whose cues are
  painted into pictures; `sink` = a pad the muxer maps, optionally named).
  Derived nodes are rebuilt on every timeline edit; user nodes never are — that
  is what `anchor`, `locked` and `derived` are for.
- `ui/graph/derive.js` — edit → nodes and wires. Refuses rather than
  approximates: a nearly-right graph is worse than none.
- `ui/graph/print.js` — nodes and wires → `-filter_complex` chains.
- `ui/filtergraph.js` — the one-call facade over both; `command.js` does not know
  a graph exists.
- `ui/graph/expr.js` + `ui/graph/curve.js` — the other half of that pair, for the
  other thing ffmpeg has: an option written as an **expression**, re-read per
  frame. The evaluation is libav's own (`bro.ffmpeg.expr.evaluate` →
  `av_expr_parse`/`av_expr_eval`, `src/native/bindings_expr.cpp`) and must stay
  so — a second evaluator would draw a curve the render does not perform.
  Three facts have one home each and all three are unaskable in libav, which is
  why they are written down with their provenance: `KNOWN_NAMES` (which variables
  exist at all, incomplete by construction), `VALUED` (which of them this
  application can put a number to — `t`, and the comment says why not `n`), and
  `tIsTime` (which filters mean the timestamp by `t`, decided by the one askable
  signal there is). `evalMode` is what the `eval` option is genuinely a signal
  for, which is *re-reading*, not *being an expression*.
- `ui/graph/enable.js` + `ui/graph/when.js` — `enable=` as a set of spans and as
  the text it is, plus which *clock* a node's `t` is on (`clockOf`) and the map
  between that clock and the timeline's, read in both directions (`onClock`,
  `onTimeline`). A span is clamped and drawn against a **window** with a start,
  not a bare length, because a filter above the derivation's `setpts` is written
  in the source file's own seconds. `ui/graph/spans.js` is the third reader: every
  span in the edit on the timeline's clock, which is what the timeline's When lane
  draws and writes back through.

### The JS surface

`bro.ffmpeg` is `bindings_*.cpp`, one file per part of ffmpeg's model — probe,
data, render, capture, capabilities, playback, sequences, expressions — each owning its calls, the
helpers that build its answers, and the paragraph saying why the calls are
shaped that way; `bindings_install.h` lists them and `ffmpeg_bindings.cpp` is
the assembly. Two are shared and neither may be duplicated: `bindings_value.h`
(reading one property off a plain object — deliberately *not* qjsbind's
`get_prop_*`, for the two reasons its header names) and `bindings_spec.h` (the
render spec, read once for the render, the recording and the preview).

Registration is qjsbind through `Table` (`bindings_table.h`), which is a name for
`qjsbind::Namespace` — the parent parameter this surface needs, being two levels
down, is qjsbind's own now. A call taking a name or an id is a typed lambda; a
call reading a whole spec keeps QuickJS's own signature, because there is nothing
for `Convert<T>` to do with a render spec. qjsbind gives every registration its
own callable, owned by the function object, so a helper may register a family of
calls from one lambda expression (`optionTable`) — it used to key that storage on
the closure's type, which made both of those silently call whichever was
registered last.

### The stream nothing decodes

`ffmpeg_data.h` is the seam for the one kind of stream libavcodec cannot touch:
**a data stream whose fourcc is X is parsed by the parser registered for X.**
`gpmd`, `tmcd`, `mebx` and `fdsc` all probe as `bin_data`, so the container's tag
is the whole identity of one — which is why it is the only thing a copy must
preserve (`export_writer.cpp`) and why it is what a parser dispatches on. One row
is filled in, `data_gpmf.h`; the seam does not name GoPro and the parser does.

Three things about it are load-bearing. **libav has nothing to ask here and that
is not a breach of the "ask libav" convention** — libavformat carries the track,
reports the tag and hands over the packets, and there is no option table to
enumerate; only the byte layout inside a packet is knowledge this repository
owns, and it is written down where it was verified. **The payload is untrusted
input and the parser is written that way**: every length, repeat count and
nesting depth comes from the file, so nothing declared is believed, the depth,
item count and value count are capped, and the walk is proved to make progress so
a zero-length item cannot loop it — `tests/data_test.cpp` truncates a real payload
at every boundary, scribbles an oversized length into every header, nests one two
hundred deep and puts a megabyte of noise through it, and what is required is a
*refusal*, not a parse. And **nothing lists the sample keys**: a numeric item that
is not one of GPMF's structural keys is data whatever it is called, and the file
supplies the name (`STNM`) and the units (`SIUN`/`UNIT`). `SCAL` is the divisor
and it applies to **integer** items only — a float is already in its units, which
is what stops a HERO8's 64.57 °C being reported as 0.155 °C.

A whole track is read once, on a thread (`async_open.h`, shared with
`probe_async.h` so that "handed over exactly once, reaped by whoever notices" has
one implementation), and **bucketed on the way in** — min, max and mean over a
fixed grid, so a reading's size is a property of the grid and not of the file.
`bro.ffmpeg` is not installed in worker realms, so this is a thread rather than a
job for `ui/analyze-worker.js`. `ui/telemetry.js` is the model on the other side
and `ui/timeline.js`'s Data lane draws it, per clip, through `sourceTime` — the
same map `columnsOf` uses for a waveform, which is what makes a series follow a
trim without being re-read. A reading is derived, so it is not in the document,
for the reason `peaks` is not.

### The sensors that are not libav's

`sound_marks.h` is the one call on this surface that is not a part of ffmpeg's
model: libav decodes an input's soundtrack to mono 16 kHz through `SourceAudio`
and **bro's** acoustic sensor bus reads it — `brosoundml::SensorHub`, the same
class and the same configuration `bro.sense.analyze()` runs, linked into
`ffmpeg-bro-core`. Five things about it are load-bearing.

**A mark is named after the measurement, never after what made it.** An `onset`
is a spectral-flux transient, a `tonal` run is sustained autocorrelation
periodicity with a real frequency in hertz, and a `sound` run is an energy gate
against a measured noise floor — bro calls that flag `voice` and this
deliberately does not, because nothing in a gate decided anything about a voice.
The words have one home (`MARK_WORDS` in `ui/marks.js`) and `tests/ui_marks.js`
asserts none of them names a *source* of sound. A label claiming a
classification the DSP never made is the one failure that would make the whole
feature a lie.

**The DSP is native because `bro.sense.analyze()` is synchronous on the UI
thread** at ~58× realtime — 5.4 s of frozen window for a five-minute clip, ~31 s
for half an hour, for exactly the long recordings this is for — and wants the
whole clip as one `Float32Array` (~230 MB/hour). Chunking it is **not** the fix:
each call builds a private `SensorHub`, so a boundary resets the flux EMA and the
VAD floor and manufactures an onset there. `bro.sense` is not installed in worker
realms either, so this is a thread and not a job for `ui/analyze-worker.js`.

**The prime-then-hop framing loop is a second home for a fact bro owns** — bro's
`js_analyze` is the other — and the two must agree on `sample_rate`, `win_length`
and `hop_length`. The comment on the loop says so by name; `tests/marks_test.cpp`
asserts the three numbers so a change to bro's recipe fails loudly instead of
moving every mark quietly.

**Only one analysis runs at a time, process-wide, and that is brotensor's rule.**
The mel front-end reaches `matmul`, and brotensor's CPU pool is a singleton whose
`run()` "assumes it is not re-entered from a second concurrent application
thread". So `readSoundMarks` takes a lock and re-arms the deadline once it has
it, because a read that queued behind another must not be failed for somebody
else's file.

**`-DBRO_WITH_SOUNDML=OFF` is a refusal that names itself**, not an empty result:
the link and the `#if` are conditional, the call throws with the flag and the fix
in it, and `bro.ffmpeg.marks.available()` is what stops the UI offering a control
that would fail. An empty list is what a *silent file* gives back.

Marks are derived, so they are not in the document, not in `ui/.storage.json` and
not on the undo track — `peaks`'s rule. They reach the timeline per clip through
`timelineTime` (`ui/project.js`), the same map the waveform and the Data lane
use, which is what makes them follow a trim. `ui/marks.js` is the model,
`ui/timeline.js`'s Marks lane draws them, and `,`/`.` walk them.

### The native encode side

`export_timeline.h` defines the seam: a `FrameSource` answers "what does the
output look like at t?" `TimelineSource` is the track stack's answer,
`GraphSource` (`export_graph.h`) is libavfilter's, and `runExport` cannot tell
them apart. Beyond that: `export_writer` (encoders + muxer — and one writer is
one *muxer*, not one file: `segment`, `image2`, `hls`/`dash`, `tee` all write
runs), `export_copy` (stream copy), `export_subtitle`, `export_compositor`,
`export_source`, `export_frame` (RGBA is the currency of this half, plus the
shared libav helpers).

**libavfilter has no subtitle input**, so `[0:s]` reaching an `overlay` is not a
libavfilter link: it is ffmpeg's own sub2video, and `export_sub2video.h` is that
mechanism here — a bitmap track decoded and painted into frames a `buffer` source
takes, one when a cue appears and a **cleared one when it expires**. Do not go
looking for a subtitle pad in libavfilter; there is not one. A text track on such
a pad is refused by name, because drawing characters is libass's job (the
`subtitles` filter). `ui/command.js` prints the pad and says in the notes that
this one wire is the CLI's mechanism rather than a link libavfilter makes — which
is the exact/equivalent distinction, so do not blur it. `ffmpeg_job.h` owns the single job slot shared by renders
and recordings, and documents the ordering rules around terminal status.

`ExportPass` is *one run over the frames, as a set of overrides on the render*,
and it now carries both reasons a render is several: a two-pass encode (two
walks, one output) and a **version** (another output at another size —
`ui/export/versions.js`). Two sizes cannot come out of one encoder, which is
precisely what separates a version from `-f tee`. A pass at its own size brings
its own `clips`, because a rectangle is in output pixels; `ui/export/spec.js`
builds each version by recursing through `buildSpec()`, so a version is what
this application *would* render at that size rather than the master scaled.

A **live session** (`LiveSettings` in `ffmpeg_capture.h`) is the same device
reading with the writer taken off the end: it publishes pads into a `LiveTap`
(`live_tap.h`) and `<video src="/@live/<id>/<pad>">` plays one. It holds no job
slot — the point of one is to be running while nothing is — and a recording
closes every session before opening its own devices. Frames reach the element
as `wrapped_avframe` through the `Wrapped` payload in `ffmpeg_backend.cpp`,
which is the same mechanism that makes a `-f lavfi` input playable. A **sound**
pad holds two things, and they answer different questions: a level, which
`live.levels()` reads and clears (so there is exactly one caller) and which is
measured whether or not anybody is listening; and — only while something *is* —
the blocks themselves, in a bounded queue per listener, because two readers
popping one queue would each play half the sound. Registering that listener is
what monitoring *is*: `ui/capture.js` creates one element for the pad somebody
pressed `Listen` on and destroys it again, so there is nothing to mute. The level
is measured by the *pad* (`sound_meter.h`, per channel, 4× oversampled true peak),
which is what stops the two things publishing into a tap from measuring
differently; the scale every meter is drawn on is `ui/levels.js` and the drawn
meter itself is `ui/meter.js`.

An **output preview** (`playback_output.h`, `ui/output.js`) is the third use of
the same idea and the second of the same registry trick: the render with the
*writer* taken off the end, registered under a token so `<video src="/@out/…">`
can play it. `runExport`'s choice of `FrameSource` is made again there and
nowhere else, so the picture on the program monitor is the render rather than a
resemblance of one — which is what puts a generator with no clip, and a filter
over the whole canvas, on the screen at all. Four consequences worth knowing
before touching it: a graph *pulls*, so there is no seeking inside one and the
range is part of the token (a moved playhead is a new source); `settle` is
separate from `define` because a spec changes on every drag and building one
opens every input — and it answers with no rate and no channel count, because
sound is the half that would open every file on the timeline to be told a number
nobody has asked for; it **carries the render's own soundtrack**, on which the
sound is authoritative and a late composite is dropped, so the transport parks
the clips rather than playing them (a clip playing under the preview is that clip
heard twice, once as itself and once through the mix); and bro opens a media
element's source *twice* — once for the pipeline, once for the audio ring it
keeps ahead of the mixer — so a run is shared by token and published into the
same `LiveTap` monitoring reads, or the same edit would be rendered twice and the
two raced for one set of decoders. Because it publishes into a tap, its mix is
*metered* by the same mechanism a microphone is, which is what `output.levels(id)`
reads and what puts a meter of the output's own channels beside the viewer
(`ui/monitor.js`); with the preview off there is no render and no tap, and the
strip says so by reading bro's master bus instead. `playback_filter.h` is the same registry one
turn earlier — one input with one chain — and the two prefixes (`/@fx/`, `/@out/`)
are deliberately distinct.

## Conventions that are load-bearing

- **Ask libav; never hardcode a list.** Muxers, demuxers, encoders, protocols,
  devices, filters and their option tables are enumerated (`ffmpeg_capabilities.cpp`,
  surfaced as `bro.ffmpeg.*` — see docs/api.md). "The four containers we support"
  is how MPEG-TS, MXF, AVI, FLV, GIF and image2 were compiled in and unreachable.
- **An unknown option is an error, not a shrug** — at both ends. A demuxer option
  nothing consumed throws with the key named; an encoder option the codec does
  not have fails the render rather than being silently dropped.
- **One home per fact.** Rotation (`rotationOf`) and the colour-matrix fallback
  (`swsSpaceFor`) live in `export_frame.h`; `ui/graph/derive.js` states the same
  rule in filter vocabulary. If one changes, the other must. Same for
  `projectFps()` (timeline rate) vs `outputFps()` (encoder rate) — genuinely two
  questions, deliberately not merged. Sound is metered in exactly one place at
  each level: `sound_meter.h` is *how loud is this block* (per channel, true peak,
  4× oversampled — called by `LivePadTap::heard` and by nothing else, so a capture
  pad and the output preview's mix cannot come to be measured differently),
  `ui/levels.js` is the dB scale, and `ui/meter.js` is the drawn meter. A second
  meter that put the clipping line a decibel elsewhere would make comparing two
  stages a quiet lie.
- **Persistence is a version-tolerant read.** Two homes, two meanings: the
  *workspace* is `localStorage` (`ui/.storage.json`, gitignored) holding export
  settings and the graph overlay, and a *document* is `ui/document.js` holding
  the whole edit as one file. What is in either was written by an earlier
  version of this code and cannot be trusted — every reader sanitises, and
  `store.adopt()` is deliberately the one sanitiser both paths go through.
- **Comments say *why*, at the top of the file.** Every source file opens with a
  block explaining what it is and which decision it embodies, and exported
  functions carry `///` doc comments including the alternatives rejected and the
  numbers measured. Match that density; it is the repository's main documentation.
- **Docs move with the code.** A change to behaviour updates the part of
  `docs/manual/` that describes it (and docs/api.md for the `bro.ffmpeg`
  surface) in the same commit.
- Commit subjects are a sentence in the present tense stating the new behaviour
  — "A recording reads several live inputs at once", not "add multi-input capture".
