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

Targets: `ffmpeg-bro` (windowed), `ffmpeg-bro-headless` (scripted), `ffmpeg-bro-core`
(the shared static lib), `ffmpeg-bro-decodetest`, `ffmpeg-bro-perftest`.

## Tests

```bash
# everything, with generated fixture media: the only command you need
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` writes two fixture files into `build/fixtures/` (a CTest `FIXTURES_SETUP` test, so
they are made once and only when something will use them) and runs every suite against
them. They are generated rather than checked in, and generated with **known content** —
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

# native: render a timeline and open the result — geometry, opacity, audio
# mixing, cancellation, capability reporting, whether options reach the
# encoder, and what a multi-stream file came out as. Writes into out/.
# It opens results with libavformat directly as well as through probeMedia(),
# because a disposition beyond "default", a fourcc and an attachment's mimetype
# are not things playback asks about — which is why this target alone among the
# test binaries takes ${FFMPEG_INCLUDE_DIRS}.
./build/Release/ffmpeg-bro-exporttest <file> [<second-file>]

# native: where the time in a seek goes (demux vs decode vs YUV->RGB)
./build/Release/ffmpeg-bro-perftest <file>

# the whole UI, driven like a person — writes screenshots to out/
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]

# the encode side end to end: the spine's stages, controls -> ffmpeg options,
# the advanced option editor, the command bar, both halves of the A/B preview,
# and loading the result back
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file>

# the equivalent filtergraph, against specs written out by hand. Needs no
# media: buildSpec()'s output is a plain object and the module is pure.
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js

# the graph underneath it: the model, the printer's chain rule on graphs the
# derivation does not produce, locks, insertion, removal, the round trip
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js
```

`tests/ui_player.js` is the main regression suite: it drops files on the real UI, plays,
scrubs, steps, zooms, moves/trims/splits clips, crops, drops a batch as a grid, and asserts
on the DOM and on control-strip geometry. To run one section, comment the rest out — the
script is straight-line, top to bottom, and later sections depend on earlier state (the
batch section deliberately clears the timeline, so it is last).

Test scripts use bro's headless globals (`dropFiles`, `wallSleep`, `advanceTime`, `flush`,
`screenshot`, `assert`, `scriptArgs`) — documented in `../bro/docs/headless.md`. Video runs
on the **real** clock: `advanceTime()` moves bro's virtual time and the decoder ignores it,
so every wait must be `wallSleep()` + `flush()` (that is what `pump()` in the test does).

Three traps when writing headless tests here:

- **`document.dispatchEvent` does not exist.** bro gives `Document` `addEventListener` but
  not `dispatchEvent`, so the node `app.js` binds its keyboard to cannot be aimed at
  directly. Dispatch on `document.body` with `bubbles: true` instead — bubbling itself is
  correct all the way up through body to document to window, and that is the route a real
  key press takes. `ui_player.js`'s `key()` helper is the one place that does it.
- **Never trigger a native file dialog.** `showSaveFileDialog` / `showOpenFileDialog` block
  the JS thread until dismissed, and headless is not a safe harbour — there is no window to
  dismiss them at. `ui_export.js` types into `#ex-path` rather than pressing "Choose…".
- **Paths handed to `<video src>` must be absolute.** `bro.ffmpeg.probe()` resolves relative
  to the process cwd but `<video src>` resolves relative to the *document* (`ui/`), so a
  relative path silently probes fine and plays black. Use `bro.appDir + '/../out/x.mp4'`.

The app exposes `globalThis.__ffmpegBro` (model, transport, and the operations) and
`__ffmpegBroReady` purely so tests drive it through a stable surface instead of DOM ids
that only exist while one clip is selected. Keep that in mind when renaming anything there.

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
| `ffmpeg_export.h` | the description a render is given, and the four calls that run one |
| `ffmpeg_export.cpp` | the job: one slot, one thread, the status the UI polls |
| `export_timeline.*` | **what the output looks like at t** — the `FrameSource` seam, and the track stack's answer to it |
| `export_graph.*` | libavfilter's answer to the same two questions |
| `export_source.*` | one clip's pictures, one clip's sound |
| `export_compositor.*` | placing a picture in the canvas: crop, scale, alpha |
| `export_writer.*` | encoders and the muxer they feed — **N streams, not one video and one audio** |
| `export_frame.*` | an RGBA picture, and the small libav helpers |
| `ffmpeg_capabilities.*` | what this build can write and what it can put a picture through, asked of libav* |

**`export_timeline.h` is the seam a node graph attaches at**, and does. `runExport` asks a
`FrameSource` two questions per output frame — the canvas at `t`, and the samples between
`t` and the next frame — and asks nothing else, so a second implementation cost the job one
line. `TimelineSource` is the track stack; `GraphSource` parses a `-filter_complex` and runs
it. **Which one runs is `ExportSettings::filterGraph` being empty or not**, and the two are
measured against each other in `tests/export_test.cpp` — the same edit rendered both ways,
compared as PSNR, 43 dB and holding. Do not let that check be loosened: the whole value of
a second path is that it is the same render.

Four things about the graph path are load-bearing:

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
  requires the frames to be identical (99 dB), not merely close.
- **`ExportSettings::sizeFromGraph` lets the graph say how big the picture is.** Off — the
  export — a last pad that is a different size from the render is an error, because the
  writer was opened for one size and saying so plainly beats a scaler quietly resizing
  every frame. On, the sink is asked and the writer is opened for the answer. That is what
  previewing a node in the middle of a graph needs, since nothing outside libavfilter
  knows how big the picture is half way through.

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
  not numbered — no input index means "everything, stacked". The vocabulary has
  room in it for `copy:0:1`, which is where chunk 12's packet path attaches: the
  writer branches on the prefix rather than growing a second list beside this
  one. `openVideoStream`/`openAudioStream` already refuse anything else *with
  that sentence in the error*, so the branch has a named place to go.
- **The list order is the muxer's numbering.** Streams are created in list
  order and there is no second sorting pass anywhere, which is what makes
  `-metadata:s:a:1` mean the stream the UI drew second.
- **A tag is a container's vocabulary, not a codec's.** `hvc1` set in an mp4 and
  then written to Matroska stops the muxer at `avformat_write_header` with
  "Invalid data found when processing input" and no mention of the tag.
  `ui/export/warnings.js` says so before the render; `codecTags()` is what it
  asks.

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

`registerFfmpegBackend()` must run **before** the `Engine` is constructed (see `main.cpp`
and `headless_main.cpp`), so the first `<video>` in the first document already finds it. It
registers a `bro::video::MediaBackend` at **priority 100**, above bro's built-in WebM
backend, which is why `<video src="anything.mkv">` just works and why every container goes
through one set of seek/timestamp/reordering semantics.

`ffmpeg_bindings.cpp` installs `bro.ffmpeg` (`probe`, `version`, `hwaccels`,
`openOnStart`, `encoders`, `containers`, `filters`, `filterOptions`, `render.*`, …) via
`EngineConfig::installHostBindings`, so it exists in every realm including workers.
`probe()` is synchronous on purpose. `filters` is a list of names and pad shapes built at
startup because it is small; `filterOptions(name)` is asked one filter at a time because
there are five hundred of them and building every option table would be most of a second
before the window opened.

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
- **Profile ids are numbered per codec.** Do not resolve `codec->profiles` against the
  generic `profile` option's constants: VP9's profile 2 and HEVC's Main 10 are both 2, and
  that "translation" confidently offered `main10` as a VP9 profile. Profiles come from the
  encoder's own private enum, or from x264/x265's documented vocabularies, or not at all.

**Licensing is a structural constraint, not a footnote.** libav* may only reach bro through
`bro::video`'s codec-agnostic interfaces. Never add an ffmpeg dependency to anything under
`../bro` — bro stays MIT and ffmpeg-free; this binary is the GPL one.

### UI side

`ui/project.js` is the single source of truth: clips, selection, the output canvas, the
layout mode. Everything else reads it and nothing else.

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

- `shell.js` — the pipeline, as the thing you navigate. Five stages — Sources,
  Compose, Graph, Encode, Write — and the spine is both the diagram and the navigation:
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
  underselling them by exactly the amount that matters. **Three things reach the
  encoder that are not in
  `videoOptions()`**, so a command built from the bag alone is quietly incomplete: the
  colour tags and the conversion into them, the keyframe interval (two seconds here,
  250 frames in x264), and the scaler, which is a flag rather than an option.
  **It is written from `spec.streams` and not from the settings the list was built
  out of**, because the spec is what `render.start` is handed: a `-map` per stream,
  `-c:a:1`, `-metadata:s:`, `-disposition:`, `-tag:` and `-attach`, with the index
  appearing only when there is more than one of that kind (`sel()`/`keyFor()`) —
  `-c:v` is what everybody reads, and `-metadata:s:a language=fra` with two audio
  streams claims both of them. **Chapters are the one thing on the Write stage an
  ffmpeg command line cannot say at all**: ffmpeg reads them from an input rather
  than from an option, so the note says so rather than dropping them silently.
- `sources.js` — the Sources stage: every file on the timeline, once each, read out of
  `probe()`. Distinct by path, so two clips cut from one file are one source — which is
  what ffmpeg would open. **It is not driven by the selection**, which is why it is not
  in `inspector.js` any more: a panel hanging off the primary selection can only ever
  describe one file, and the stage's own card in the spine counts them all.
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
  `state` (settings, the render slot, and the three readers — `activeVideoCodec()`,
  `activeAudioCodec()`, `outputFps()` — that say what the settings *come to*, because
  a fallback chain written out at each point of use is a fallback chain that can
  disagree with itself), `capabilities` (what libavcodec says this build can do),
  `options` (settings → `-key value`), `spec` (the model → what the renderer
  wants), `streams` (what the file is made of), `presets`, `warnings`, `store`,
  `form`, `preview`, `strip`, `progress`.
  `buildSpec()` turns the model into what `bro.ffmpeg.render.start` wants. **Two stages,
  not a modal**: what the picture is put through (Encode) and where it goes (Write) are
  different decisions taken at different moments, so `#st-encode` and `#st-write` are
  siblings of `#st-compose` under `#stages`. The four hide each other rather than
  unmounting — the viewer's `<video>` elements *are* the decoders, and tearing them down to
  look at an export would mean rebuilding and re-seeking every one on the way back.
  Consequences: anything in the frame loop that measures a panel has to ignore a
  measurement of zero (most of the window is `display:none` at any moment), and
  `shell.goTo` is the only thing that switches — `export.js` offers `prepare()` and
  `canLeave()` and has no opinion about what is on screen. **`prepare()` runs for both
  Encode and Write, so the half of it that reads the edit is gated on arriving from
  outside** (`arrive()`): stepping between the two stages is one visit, and re-running
  it moved the preview's sample point back to the playhead on the way back from setting
  a filename.

  Four regions: the settings form (drawn from the selected encoder's reported capabilities,
  so it changes shape per codec), the A/B stage, the advanced option column, and the range
  strip across the bottom. The preview renders the same seconds twice — once at the chosen
  settings, once losslessly — and wipes between them; the reference is keyed by
  `referenceKey()` on everything that changes the *picture*, so changing the quality
  re-renders only the candidate. Both videos are placed in pixels against the stage, never
  sized to their own boxes: the clipped one's parent is the wipe window, and fitting to it
  would compare a picture against a squashed copy of itself. Because they are placed in
  pixels they do not follow a stage that resizes, which it now does — `chasePreview()`
  refits when the measured stage changes.
- `export/streams.js` — **the Write stage is the output's stream list**, one row per
  stream the muxer will number, in that order. `#ex-streams` is the middle column of
  `#st-write`, between the destination and the verdict. This is the surface stream
  copy (12), destinations (13) and subtitle tracks (14) attach to, so its shape
  matters more than its polish. Five things here are decisions rather than layout:

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
  - **`settings.audio` and the audio rows are one fact.** The Encode stage's Include
    switch goes through `setAudioIncluded()`, which empties or refills the rows. Two
    switches for one decision is how a render comes out silent while a track list
    insists it should not have.
  - **Nothing is tabled.** The dispositions are `bro.ffmpeg.dispositions` (every bit,
    through `av_disposition_to_string`), the fourccs are `bro.ffmpeg.codecTags(ext,
    codec)`, the codecs are the encoder lists. A row cannot offer what the render
    would then refuse.
  - **`hooks.changed` rebuilds the rows; `hooks.restated` only re-says what will be
    written.** A language or a disposition changes what is *in* the file and not what
    the picture looks like, so it must not throw away a candidate render that cost
    ten seconds. Which is also why the detail's fields commit on `change` and rewrite
    the row's tail in place rather than redrawing the list under the caret — the same
    build/measure split the range strip and the graph cards use.

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
  rather than special cases of anything. `graph/derive.js` builds the skeleton
  from the edit and owns every refusal and caveat; `graph/print.js` turns nodes
  into chains. `filtergraph.js` is the two composed, with the shape callers
  want, so `command.js` does not know a graph exists.

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

  Three things about the model are load-bearing rather than incidental.
  **Arguments are positional-then-named because ffmpeg's are** — `crop`'s four
  numbers are the first entries of the same option table the named ones come
  from, and normalising them would print something other than what was written.
  **Only chain-final nodes carry a label**, because print's rule is that a run
  continues while the wire is private (one producer, one consumer, both
  filters) and a private pad has no name to carry; that rule is what puts the
  output colour conversion on the back of the last `overlay` instead of in a
  chain of its own. And **a node may have more than one output, and an edge
  says which it leaves by** — `node.outs` and `edge.fromPort`. An **input node
  is a file, not a stream**: `[0:v]` and `[0:a]` are two pads of one `-i`, one
  demuxer and one seek, and drawing them as two nodes reading the same path
  said they had nothing to do with each other. The chain rule did not change
  when the port arrived; `padOf` takes it, `connect` records it, and
  `insertAfter`/`remove` move and heal only the wires on the pad in question —
  a filter dropped on a clip's picture that took its sound with it would put an
  `hflip` in front of `atrim`. `split` and `asplit` are what the model can now
  say and the derivation does not yet write. **`streamsOf(g)` lives here rather
  than in `layout.js`**, because which stream a node is on is a fact about the
  graph and not about where it is drawn, and there are three callers — the
  layout colours a wire with it, the card colours its dot, and `subgraph.js`
  uses it to decide whether a preview is a picture or a waveform.

- `graph/overlay.js` — the part of the graph a person made, held apart from the
  part that is derived, because **the skeleton is thrown away and rebuilt on
  every timeline edit**. Two pieces of data: `inserts` (ordered, each pinned to
  a named point) and `locks` (params keyed by a node's anchor).
  `derive(spec, sources, { overlay })` puts them back — locks first, then
  insertions — and reports every lock that *disagreed* with what it just
  derived as an `override`, which is what lets the outranked control say so.
  Five rules here are load-bearing and each has a failure behind it:

  - **Anchors, not positions.** A derived node is named for what it is
    (`clip:7/scale`, `composite/overlay:7`); an insert point is a named place
    on a wire (`clip:7/after-scale`). Ids come from a counter that never
    restarts, so they identify nothing across two derivations. `buildSpec()`
    carries `clip.id` for exactly this.
  - **There is no insert point after the output colour conversion.** That chain
    is in the printed graph and not in the one this binary runs, so a filter
    there would be in the encoder's colour in the command and in RGBA in the
    render. One point, two pictures.
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

  A split copies a clip's entries to both halves (`cloneClip`, called from
  `splitAtPlayhead`) — a cut should not change how either half looks. Persisted
  in `localStorage` under `ffmpeg-bro.graph`; there is still **no project
  file**, and this is the first thing that makes one worth having.
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

  Four things about how it is built are load-bearing:

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
  - **Editing on a card commits on `change`, never on `input`, and restores focus
    afterwards.** An edit locks the node, a lock redraws the graph, and a redraw throws
    away every card: on `input` the field vanishes between keystrokes, and without the
    restore a `<select>` loses focus mid-gesture. Controls also stop `mousedown`
    propagating, or using one drags the node it is on.
  - **A pin is visual.** `layout()` puts a pinned node where it was dropped and changes
    nothing else — the flow does not part to make room. That is what Nuke does; a layout
    that reflowed around pins would mean dragging one node rearranged the eight you were
    happy with. Pins live in `overlay` next to the card sizes, keyed by anchor so they
    survive the rebuild, and **outside `isEmpty()`**: where a card sits must never
    change which of the renderer's two paths runs. A split copies a clip's filters and
    *not* its pins, because two cards cannot be in one place.

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
- `graph/panel.js` + `graph/filters.js` — the column beside the graph: what the
  selected node is set to, or what can go on the wire whose `+` was clicked. One
  panel for both, because inserting a filter and configuring it are one gesture
  with a pause in it. Now that values are also edited on the cards, the division
  is that a card shows what is *set* and the column shows everything the filter
  *has* — thirty options for `scale` is a column, not a card. The filter list and
  every option table come from `bro.ffmpeg.filters` and
  `bro.ffmpeg.filterOptions(name)` — libavfilter's own, cached in `filters.js`
  because there are two callers now and two caches would be two answers to what a
  filter takes — so there is no list of supported filters written down anywhere. The palette
  offers what can be *spliced*: one input and one output of the wire's stream,
  which is what splicing means rather than a simplification of ffmpeg.
  Positional arguments are edited in place and labelled from the node's
  `posNames`, which the derivation records because ffmpeg's option tables carry
  aliases as separate entries and the n-th option is not the n-th positional
  argument.

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
  clips are *chased* — corrected only when they drift past `DRIFT_LIMIT` (~2 frames) —
  because correcting every frame means a seek per clip per frame, and free-running decoders
  come apart within a minute.
- **`setPlayhead(t, seek=false)`** exists because writing `currentTime` back while the
  decoder drives the clock fights it. When paused, `adoptDecoderTime()` reports where the
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

## Style

Comments here explain *why*, in prose, at the top of a file or above a non-obvious decision
— often several sentences about the failure mode being avoided. Commit messages follow the
same voice (declarative, about the behaviour: "Seek targets round down, not to nearest").
Match that rather than adding `// increment i` noise.
