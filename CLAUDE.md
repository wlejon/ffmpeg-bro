# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and test

Requires Visual Studio 2022, vcpkg (`VCPKG_ROOT` set, or pass the toolchain
yourself), and a checkout of [bro](https://github.com/wlejon/bro) beside this
repo — or `-DBRO_DIR=<path>`. The vcpkg `ffmpeg[...]` feature list is in
README.md; `x264`/`x265` are needed for export, not for playback.

```
cmake -B build
cmake --build build --config Release
ctest --test-dir build -C Release

./build/Release/ffmpeg-bro [media-file]                  # the application
./build/Release/ffmpeg-bro-headless ui/ <script.js> [-- args]   # the same engine, scripted
```

One test, by ctest name (`decode`, `export`, `capabilities`, `inputs`,
`sequences`, `capture`, `hardware`, `ui-player`, `ui-sources`, `ui-hardware`,
`ui-export`, `ui-sequence`, `ui-report`, `ui-measure`, `ui-subtitles`,
`ui-capture`, `ui-filtergraph`, `ui-graph`, `ui-document`, `ui-output`):

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
alone, since every data stream probes as `bin_data`.
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

**Ids are part of it, and that is the load-bearing part.** A clip's id and an
input's id are names other files write down — `clip:7/after-scale` is a graph
anchor, `in3` is a source node — so an open that renumbered would silently
re-point a filter at a different shot. `useClipId`/`useInputId` are how the two
counters are told what a document has already handed out. `ui/graph/overlay.js`
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
  stream read, `sink` = a pad the muxer maps, optionally named). Derived nodes
  are rebuilt on every timeline edit; user nodes never are — that is what
  `anchor`, `locked` and `derived` are for.
- `ui/graph/derive.js` — edit → nodes and wires. Refuses rather than
  approximates: a nearly-right graph is worse than none.
- `ui/graph/print.js` — nodes and wires → `-filter_complex` chains.
- `ui/filtergraph.js` — the one-call facade over both; `command.js` does not know
  a graph exists.

### The native encode side

`export_timeline.h` defines the seam: a `FrameSource` answers "what does the
output look like at t?" `TimelineSource` is the track stack's answer,
`GraphSource` (`export_graph.h`) is libavfilter's, and `runExport` cannot tell
them apart. Beyond that: `export_writer` (encoders + muxer — and one writer is
one *muxer*, not one file: `segment`, `image2`, `hls`/`dash`, `tee` all write
runs), `export_copy` (stream copy), `export_subtitle`, `export_compositor`,
`export_source`, `export_frame` (RGBA is the currency of this half, plus the
shared libav helpers). `ffmpeg_job.h` owns the single job slot shared by renders
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
pad holds a level instead of a frame — `live.levels()` reads and clears it, so
there is exactly one caller — because a meter needs no answer to the questions
monitoring asks. The scale both it and A1 are drawn on is `ui/levels.js`.

An **output preview** (`playback_output.h`, `ui/output.js`) is the third use of
the same idea and the second of the same registry trick: the render with the
*writer* taken off the end, registered under a token so `<video src="/@out/…">`
can play it. `runExport`'s choice of `FrameSource` is made again there and
nowhere else, so the picture on the program monitor is the render rather than a
resemblance of one — which is what puts a generator with no clip, and a filter
over the whole canvas, on the screen at all. Three consequences worth knowing
before touching it: a graph *pulls*, so there is no seeking inside one and the
range is part of the token (a moved playhead is a new source); `settle` is
separate from `define` because a spec changes on every drag and building one
opens every input; and it carries no sound, so the transport pauses the clips and
takes its clock from the preview. `playback_filter.h` is the same registry one
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
  questions, deliberately not merged.
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
