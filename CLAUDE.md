# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and test

Requires a C++20 compiler (Visual Studio 2022 on Windows), vcpkg (`VCPKG_ROOT`
set, or pass the toolchain yourself), and a checkout of
[bro](https://github.com/wlejon/bro) beside this repo — or `-DBRO_DIR=<path>`,
**cloned `--recursive`**. There is no `vcpkg install` step: `vcpkg.json` is the
one home for what this build links, the toolchain installs it during the
configure, and `builtin-baseline` pins it to the same microsoft/vcpkg commit
bro's own manifest pins. bro's five ports are copied into it rather than
inherited, because vcpkg reads the top-level manifest only; the `!osx` entry
exists because `nvcodec` and `amf` do not build there. `x264`/`x265` are needed
for export, not for playback.

`CMakeLists.txt` turns bro's `BRO_WITH_SOUNDML` on before `add_subdirectory`,
which is what makes `bro.sense` a working namespace here rather than the
*unavailable* stub bro's default `app` profile installs. bro's `_bro_require`
chain pulls `BRO_WITH_LM` and `BRO_WITH_TENSOR` in behind it, so this is four
features and 684 more source files — and 27 s of build and 2.7 MB of binary,
because the linker takes what is referenced. The reasoning, the alternatives and
the measurements are in the block itself. **`-DBRO_WITH_SOUNDML=OFF` is a
`FATAL_ERROR`**: bro declares the flag with `option()`, so a command-line
setting beats the cache entry this file writes, and without the refusal that is
a silently different build. Two things about that namespace are
easy to get wrong and are written down here because nothing else states them:
**the real binding does not set `available`** — only the stub does, so the
feature test is `bro.sense.available !== false` and never `typeof
bro.sense.analyze`, which is a function on the stub too (it is a `Proxy` whose
every other property is a thrower). And `bro.sense` is **not installed in worker
realms**: bro's `worker.cpp` builds its context from an explicit list and
`installSenseBindings` is called only from `Engine::initAppRealm`, exactly as
`bro.ffmpeg` is only installed by `installHostBindings`.

The same block turns **four of bro's renderer features off** for the opposite
reason, and the asymmetry is the point. `BRO_WITH_3D`, `BRO_WITH_PHYSICS`,
`BRO_WITH_GAMEAI` and `BRO_WITH_FLORA` are on in the `app` profile because that
profile is a game runtime; the whole JS closure here names `bro.scene`,
`bro.physics`, `bro.mesh`, `bro.tile` and `bro.flora` zero times, so they were
471 of 1676 objects on every clean build and 6.7 MB of the shipped binary. Off,
that is 1205 objects and 24.9 MB. **These are cache entries and not a refusal**:
SOUNDML off is a build that lies about what it is, and 3D on is only a build
that is slower, so `-DBRO_WITH_3D=ON` deliberately still wins.

```
cmake -B build
cmake --build build --config Release
ctest --test-dir build -C Release

./build/Release/ffmpeg-bro [media-file]                  # the application
./build/Release/ffmpeg-bro-headless ui/ <script.js> [-- args]   # the same engine, scripted
```

One test, by ctest name (`decode`, `export`, `capabilities`, `inputs`,
`sequences`, `playback`, `capture`, `hardware`, `telemetry`, `marks`, `words`,
`proxy`, `ui-player`, `ui-sources`, `ui-hardware`, `ui-export`, `ui-sequence`,
`ui-report`, `ui-measure`, `ui-subtitles`, `ui-capture`, `ui-filtergraph`,
`ui-graph`, `ui-document`, `ui-output`, `ui-find`, `ui-load`, `supercut`):

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
both) — `av1.mp4` is the only picture here that is not H.264, and it is about
*which decoder a codec has* rather than about AV1: this build's default AV1
decoder is `libdav1d`, which is software and can be given no device, while the
native `av1` decoder exists only to be driven through one, so it is the only
fixture that can tell "the card cannot decode this" from "the decoder this build
reaches for cannot be given a card" (`hwDecoderFor`) — `marks.m4a` is the only
soundtrack here in which anything ever
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

Four layers:

- **`src/native/`** — C++ built as `ffmpeg-bro-core` (static), linked by every
  executable and by every test. `app_main.h` is the bring-up both windowed
  applications share; the two `*_main.cpp` beside it are a call each.
- **`ui/`** — the workbench, plain ES modules + DOM, run by bro's QuickJS
  engine. `ui/bro.json` is the window manifest.
- **`supercut/`** — the *second application*, its own window and its own
  executable, over the same core and the same **model** modules out of `ui/`.
  See "The second application" below.
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

**A gap here is fixed in bro, not routed around here**, and `change` is the
worked example. A text `<input>` fired none — `input` per keystroke, and `change`
only for a checkbox, a radio, a range and a colour — so *every* field on every
stage written the way HTML says to write one was dead in the window and alive
only in the suites, which dispatch the event by hand (`type()` in every
`tests/ui_*.js`). It surfaced as a Whisper model path typed in and a button
beside it answering `no model has been chosen`. The fix is bro's
`layout/value_change.h`: `change` reports a *departure from an edited field*, so
a field left alone, an edit typed and undone, and a value a script wrote all
report nothing. Two consequences to know here. The suites still cannot see any
of it — they synthesise events and never press a mouse, so **the real
interleaving is only testable in bro** (`tests/events/test_text_change.js`). And
`change` now arrives *during* the press on whatever was clicked next, which in a
browser loses that click when the handler redraws; bro puts the press back onto
the control standing where the pressed one stood, and only if the tag and the
words match. Do not lean on that: a field that can commit on `input` should,
which is what `ui/sources.js`'s model path does.

The second example is the same shape one layer down, and it is why the supercut
suite now presses a mouse. The Rhythm tab this application had before the Line
tab opened a cell editor — an `<input>` made
and focused inside the press handler that opens it; bro creates a control for
an input on the next layout pass, so `.focus()` on a fresh one moved
`activeElement` and drew a caret and every keystroke went nowhere — and every
check in `tests/supercut.js` passed, because a `keydown` dispatched on the node
never asks the engine who is focused. Fixed in bro's `handleProgrammaticFocus`
(the control is created on the spot). What the headless harness has for this
is bro's own `click(x, y)`, `textInput(text)`, `keyDown`/`keyUp` and
`mouseDown`/`mouseMove`/`mouseUp` globals, which go through the engine's hit
test and focus exactly as a hand does; anything that is a press-and-type should
be asserted through them at least once, beside the synthesised version.

## The model everything is arranged around

ffmpeg's model is inputs → streams → a filter graph → encoders → a muxer → an
output. This app presents exactly that as its navigation — `ui/shell.js` draws
the spine: **Capture → Sources → Compose → Graph → Encode → Write**.
Anything the app cannot yet express usually has an obvious home in that chain and
no home in an NLE's timeline-plus-export-dialog model; put new capability where
ffmpeg puts it.


Stage views hide each other with `display:none` and are **never unmounted** —
the viewer's `<video>` elements *are* the decoders — each one owns a
`VideoPipeline`, which demuxes and decodes on a thread of its own and hands
pictures back through a bounded queue. **Off-thread is not free-running**: the
worker decodes a few frames past the moment being shown and then parks, because
the producer at the other end of a live source reads "the screen has asked for a
picture" as "the screen has reached that moment" — that is bro's
`decodeCeiling_`, and without it the output preview stopped making pictures
altogether. Consequence that keeps
biting: anything in the frame loop that measures a panel must ignore a
measurement of zero, because most of the window is `display:none` at any moment.

**How many of those elements exist is `ui/residency.js`'s and nothing else's.**
The rule used to be one per clip, built when the clip arrived and never taken
back, which is right at a handful of clips and ruinous past a few dozen: opening
a 75-clip montage of 1080p60 segments cost 26 s of frozen window and 9.1 GB, and
the same open with the elements suppressed was 17 ms with every part of the apply
under 10 ms — so the elements were not *a* cost of opening a large document, they
were all of it. So a decoder is held by a clip **near the playhead**: memory is a
property of the window rather than of the project, the same statement
`ffmpeg_data.h` makes about a telemetry reading and its grid. Two halves of it
are load-bearing and are easy to undo by accident. The clips *under* the playhead
are attached synchronously and are never capped — `setPlayhead` reads
`clip.video.currentTime` on the line after it asks for them, and a composite of
twelve clips genuinely needs twelve decoders — so what is bounded is only the
look-ahead. And **analysis is not residency**: peaks and filmstrips belong to the
clip rather than to the element, so evicting a decoder leaves the timeline lanes
exactly as they were, and tying the two together would make scrolling re-decode
files.

`ui/analysis.js` states the same rule about *reading* a clip and is the second
place a cost was found to be a property of the window rather than of the
project. A file on this machine is read whole, once, exactly as it always was. A
clip whose input is a URL (`input.remote`, decided once in `ui/inputs.js` where
the scheme is already parsed) is read for the span the timeline is showing, and
`timeline.draw()` is what says which span that is. Four things about it are
load-bearing. **The two lanes are not one job**, and the measurements say why: a
strip *samples* and an envelope *integrates*, so twenty-four thumbnails cost 6.2 s
whether they are spread over five minutes of a six-hour VOD or over all of it,
while the envelope of that VOD is sixteen minutes of continuous decoding — the
picture therefore follows the view at any zoom and the sound is capped at a
window — and past four times that window it is not read at all, because two
minutes of envelope in a six-hour lane is six pixels of waveform and the lane
saying *why* it is empty is worth more. **A bucket nobody has read is not a
bucket that was quiet**, which is
what `peaks.have` is and why `columnsOf` answers `null` rather than zero for a
column outside it. **The envelope is read from the cheapest source carrying the
same soundtrack** — a local copy, then the audio-only rendition (1.9 s against
6.5 s for the same sixty seconds), then the clip — and two of those are the ones
that do not share the picture's zero, so `peaks.about` says which and the lane
prints it. And **the same window is never asked for twice** (`tried`): a short
answer that fails its own coverage test would otherwise be re-read on every
frame for ever.

The same document exposed a second cost that was never about the elements. A
measurement landing — a waveform or filmstrip off `ui/analysis.js`'s worker —
arrives on the model's change channel, and that channel's listener rebuilds the
Sources cards, the spine, the command bar, the export rows and every element's
source. Seventy-five clips answer with a hundred and fifty of those and they arrive
in one drain: at 22 clips it was a **single frame of 12.9 s** against a median frame
of 1 ms. Derived channels are excluded from the undo track and the unsaved marker
for the same reason — so the listener now returns early and marks the timeline
for one redraw on the next frame.

That last move is the general one and `needs()`/`drawPending()` in `ui/app.js`
is where it lives. Five redraws restate the *whole* edit — `refreshPlayback`
settles a filter chain per clip, the timeline draws a lane per clip, the spine
and the command bar each build a render spec out of all of them, and the graph
lays out a node per filter — so all five are priced in the size of the project
(0.6 s, 0.5 s, 0.8 s and 2.3 s at 75 clips). Opening a document ran them several
times over: the overlay a document brings says so on its own channel, the
document says so on the model's, restoring the session's selection says so
again, and `closeExport()` — which every walk away from the encode side goes
through — is *itself* a spine-and-command redraw, so walking to the Sources
stage drew both twice. So a change **marks** what is out of date and the frame
loop draws it, which took `doc.load()` on that montage from 8.0 s to 1.0 s and
the whole blocking open from 25.9 s to 3.6 s. Two things about it are easy to get
wrong. The frame loop draws **one** of the five per frame and rotates, starting
where the last pass stopped — straight priority order starves, because readings
landing off the analysis worker mark the timeline on every frame for as long as a
large document is being read, and a command bar that goes minutes without being
drawn is the one failure this application refuses to have. And the **Sources
stage is deliberately not among them**: it is the one whole-edit redraw that is
not priced in the project's size (7 ms at 75 inputs, because the list is one row
each and the detail column is the selected input only), so it is drawn directly
and a dropped file's card does not arrive a frame late.

**A seek is marked on the same list, and it is drawn first.** A hand dragging the
playhead hands over a position per pixel and `setPlayhead` opens, seeks and
settles every clip under it, so a scrub answered move by move did that work tens
of times between two drawn frames. So `scheduleSeek` marks and `drawPending`
performs the last one, before the five — a redraw of a position that is about to
change is a redraw thrown away. The end of the gesture is *performed* rather than
marked (`finalSeek`), because a stopped hand causes no further frames. The same
distinction runs through the model's change channel: `move` is a clip being
dragged and `moved` is one that has moved, so everything that is a pass over the
whole edit — the overlay's retain, the Write stage's copied rows, the Sources
cards, the unsaved marker — waits for the second, which always follows.

**Playback runs on the render rather than on the clips**, and that is the other
half of the same measurement. Compositing with an element per clip means crossing
from one decoder to the next at every cut, and a crossing is a file opened and
seeked on the drawing thread — on the same montage, 23 frames over 40 ms in
fifteen seconds against 10 for the render, and a median frame of 19 ms against
13. So `play()` asks `ui/output.js` for a render under the name `'play'` and
`advance()` moves the clock across the frame one appears. Four things about it
are load-bearing, and three were bugs first. The **press must return** — building
one opens every input it reads, 1.2 s on that edit — so the clips carry playback
until it exists rather than the button freezing. It is **kept for `KEEP_MS` after
playback stops**, because a paused element resumes where it stopped and its range
still covers that moment, which makes stop-and-go free; it costs ~1 GB, which is
why it is not kept for ever. **`isShowing()` is not `isOn()` and not `ready()`**:
a kept render exists and answers `at()` without anybody watching it, and letting
it answer put a still picture over the clips and dragged every scrub back to
wherever playback had stopped. A **stale** one is the same trap one layer down —
a graph cannot seek, so a moved playhead is a new source, and between the two the
element still holds the old range — which is what `current()` is for, and a stale
render is therefore neither **seen** (`reveal()`, the element being `z-index: 900`
over the clips) nor **heard** (`play()` and `chase()` start nothing that is not
`current()`); the clips carry both halves until the rebuild lands. "Engage at
`t`" for a render already held is `setOn`'s, and the question it asks is
`sittingAt()` rather than `want === t` — `want` is where the *range* begins and
the element has played on from there, so a resume where playback stopped is free
and a playhead that has moved is a rebuild, including one moved back to the
range's own start, which is the same src and still a new source (`restart`).
Answering nothing there was the click-during-playback bug: press → `pause()` →
seek → release → `play()`, and what came back was the render of the moment
playback had *stopped* at, over a playhead somebody had just moved. And
`holders` is a set because `O` and playback are two reasons for one mechanism:
pausing must not close a preview somebody opened, pressing `O` during playback
must not close it when playback ends, and turning it off *by hand* must turn it
off whoever else was holding it.

`tests/ui_load.js` is the suite for all of it, and it asserts the worst *frame*
rather than a total, because the same total spread over a hundred frames and
delivered in one are completely different to use.

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
counters are told what a document has already handed out.

`ui/softcues.js` is the *reader* of the output's soft subtitle rows (`copy:` and
`decode:`), drawing them over the program monitor
(`Cues`, `T`), and the one thing it must never grow is a **style**: a soft track
is styled by whatever player opens the file, so it draws `text`, says on the
canvas that this is what the cues say and not how they will look, and switches
off the way the thing it previews does. It computes no rectangle — the layer is a
child of `#stage`, which *is* the canvas, so `viewer.placement()` (a *clip's*
rectangle) is not asked and no second one exists to drift from it. The clocks are
not restated either: `cueWindow()` says where a file's cues land and the output's
zero is where the render range begins. `ui/graph/overlay.js`
has two reads for exactly this reason: `restore()` (localStorage, drops input
nodes because the inputs are not coming back) and `adopt()` (a document, keeps
them because they are).

### The corpus is a third seam, and it points the other way

`ui/library.js` is the corpus of transcripts — which recordings there are, what
was said in them and where — and it has **three views over it**: `ui/find.js`
(the panel over Compose), `supercut/results.js` (the second application's whole
left-hand side) and `tools/`. `supercut/line.js` is a fourth *reader* and
deliberately not a fourth view: it resolves a line through `searchWords` like
everything else and draws nothing, which is why a line and the Words tab can
never come to disagree about where a word was said. What *makes* a corpus — the
Twitch API, the pulling, the store's layout, and now a folder of footage already
on the disk — is **`corpus/`**, which is a module set rather
than a face: it is imported by `tools/supercut.js`'s batch verbs and by the
supercut window both, exactly as `ui/`'s model modules are imported by two
windows. `build/corpus/find.json` is still the manifest a view reads, and **an
absent file is still the ordinary case**: no corpus, no panel, and `/` does
nothing.

That directory used to be `tools/` outright, on the rule that nothing which
builds a corpus belongs in an application. What overturned it is that the
supercut application's job *starts* with getting a recording: a window that can
search six hours of somebody talking and cannot go and get the six hours is a
window that sends you to a command line to use it. Two properties keep the split
honest and both are easy to break. **Nothing in `corpus/` may touch the DOM at
import time or drive an application**, which is the same property that lets
`supercut/` share `ui/`'s model modules — `pullMedia` used to click `#ex-go` on
the Write stage, and that is precisely what made it unimportable. And **`assert`
is a headless-only global**, installed by `headless_bindings.cpp` and absent in a
window, so a refusal in `corpus/` throws an `Error` carrying the same sentence.
Anything moved in here next will hit that.

**A folder of footage is a channel whose listing is the folder** (`corpus/local.js`),
and that is the whole of what local files needed: everything downstream of a
transcript asks the corpus which recordings there are, what was said in them and
where, and not one part of it is about Twitch. What is about Twitch is the
listing and the pull, so those are the two steps this replaces — `adopt` is
synchronous and answers what it did, `tick` is idempotent, in `corpus/pull.js`'s
shape. Four things are load-bearing. **The file is not copied**: it is already on
the disk and it is tens of gigabytes, so the store holds a `state.json` and a
`words.srt` and `store.mediaOf` is the one home for "where is this recording's
picture" — a second answer would be a recording that transcribes and will not
play. **Ids are allocated and must be stable**, so the path is written into the
state file and a second adoption of the same folder finds its own work rather
than re-transcribing everything. **The probe is a thread**, because a press may
not open fifty files (`bro.ffmpeg.probes`, one at a time), so a file with no
length yet is one `isPulled` refuses and nothing offers to transcribe. And a file
with **no soundtrack is kept and flagged rather than refused** — b-roll plays and
adds and can never be searched, which is a fact about the file and is said on the
row. The prices, both named where they land: an adopted corpus describes *this*
machine's disk where a pulled one is portable, and a file that moves keeps its
words and loses its picture — the state a dropped broadcast is already in.

**A pull is a `bro.ffmpeg.fetch`, not a render.** The old one drove the Write
stage and so held the one job slot, which is why the command line pulls one
recording at a time; the queue takes several at once, cancels one at a time and
leaves the Render button alone. Measured against a real VOD: 60 s of 1080p60 in
2.7 s, 17 MB/s, with `position`/`span`/`progress` live on the output's clock, so
a progress bar needs no second request. `mediaDuration`'s comment says
libavformat reports zero for a Twitch playlist; the *probe* now answers 22 960 s
for a 2296-segment VOD, matching the manifest's own `#EXTINF` sum exactly — the
playlist sum is kept anyway, because it is arithmetic where a probe is a report
and because `segments` is a fact only the manifest holds.

**The speech model is looked for rather than computed, and the application
fetches it** (`corpus/words.js`, `corpus/model.js`). Where a checkpoint is was one
expression — a size directory under a standalone brosoundml beside the repo — and
every part of it was a guess: it named `0.6b-v3`, so another size was invisible;
it named the standalone clone, so bro's own submodule, which is what
`--recursive` produces, resolved to nothing; and being one path it could only be
wrong, never say where it had looked. Now three named places are searched for a
directory holding the *three files `loadModel` names*, `useSpeechModel` is the
way out (`useCorpus`'s shape, and the window remembers it, not `corpus/`), and
`speechRefusal` names every place. `startRead` refuses on the press rather than
letting the native loader refuse minutes later about the one path it was handed.
**And `corpus/model.js` goes and gets one**: `bro.ffmpeg.fetch` is the packet path
and refuses a spec it cannot perform, so a 2.5 GB safetensors is not its job —
what is needed is `fetch` with a `Range` header, measured here at 9.4 MB/s for a
32 MB range, appended to a `.part` and renamed when whole (`proxy_queue.h`'s
rule), resumed from what is on disk (`pull.js`'s). A chunk loop rather than one
request because the body is one `ArrayBuffer`. Nothing starts it but a press.

The split between `library.js` and its views is the load-bearing part and was
learned the expensive way: **everything that decides what the answer is lives in
the library or in `phrase.js` beneath it, and a view may decide only how to draw
it.** When one rule — that two hits under two seconds apart are one moment — lived
in `tools/corpus.js` alone, the panel reported fifteen of a phrase the command
line reported fourteen of, on the same corpus, with nothing anywhere saying which
was right.

Three more things are load-bearing. **The finder is not a stage of the
workbench**, and must not become one — the spine is ffmpeg's pipeline and its
whole value is that it stays exactly that, so the panel opens *over* Compose the
way the crop handles do; a tool built *around* finding is a second application
and not a seventh button. **The matching is `ui/phrase.js`'s and
`tools/transcript.js` imports it back**
(`/app/phrase.js`), which is the one place the dependency runs app→tool-ward
rather than the reverse: the panel says where the moments are and `tools/clips.js`
cuts them, so two copies of the search would be two chances for the list and the
files to describe different sets of moments with nothing saying so. And **the
words are not copied into the manifest** — the transcripts are already on disk in
a form the app reads, so the panel reads the `.srt` directly and there is no copy
to go stale. `monologues()` is in the same file and is named after its
measurement for `sound_marks.h`'s reason: it is a run of words with no gap wider
than *n*, and nothing in that decided anything was a monologue.

**Which recordings a search runs over is the library's too** (`choose`/`chosen`/
`searching`, and `searched()` beneath every search): a corpus is not one
question, and twenty broadcasts of one streamer are twenty afternoons. Three
parts of it are decisions. The confinement is asked of the *manifest* rather than
of the chosen ids, so an id from another channel or from a recording that has
gone narrows to nothing instead of leaking or throwing. There is deliberately no
way to express "search nothing" — a finder that could be put into that state and
would say so only by finding nothing is a finder people learn not to trust, which
is also why `supercut/results.js` refuses to untick the last box rather than
letting it bounce back on. And **re-reading the same channel keeps the choice
while moving to another drops it**: a transcription landing calls `reload()`, and
a search that quietly went back to everything on that frame would be the tool
changing the question under somebody.

**Auditioning is one `<video>` that every row shares**, which is `ui/residency.js`'s
rule arriving in a second place: two hundred results with a player each is two
hundred decoders on six-hour files. And an input added by the panel has no probe
on the frame it is added — a six-hour file is probed on a thread — so the add is
finished by `settleProbes()` on the frame loop rather than refused on the press,
which is the one thing `openSpec`'s refusal would get wrong here.

### The second application

`supercut/` is a second window from a second executable
(`src/native/supercut_main.cpp`, `supercut`), for one job: finding what somebody
said across hours of recordings and cutting it together. It exists
because that job is a loop between three things — find a moment, hear it, put it
in the row — and **none of the workbench's six stages is on that loop**. A
separate executable rather than a `--app` flag, because a mode of a larger tool
is still that tool: same title, same icon, same thing to explain.

**It shares every model module in `ui/` and not one line of its interface.**
`project.js` (clips and what a trim, a slip and a speed change mean), `inputs.js`,
`library.js`, `analysis.js`, `export/spec.js`, `output.js`, `document.js`,
`transport.js`, `dom.js`, `format.js` — imported by relative path out of
`supercut/`. That is possible at all because **no module in that closure touches
the DOM at import time** and `viewer.placement()` is a pure function of a clip
and a canvas size; keep both true. The payoff is not only that the two agree: a
`.fbro` written in one **opens in the other**, so the simple tool is where an
edit starts rather than a dead end.

Two things it adds, and both are its own rather than the model's:

**A mix is a packed sequence** — one lane, no gaps, no overlaps — and that is
`supercut/mix.js`'s only arithmetic. The consequence that bites: `ui/project.js`
stops every edit at the neighbour (`walls`), which is right on a timeline and in
a packed sequence would mean **no clip could ever be made longer**. `unwalled()`
moves the neighbours out of reach, runs the real primitive so its own limits
still bite (the head of the file, one frame, `SPEED_MIN`/`SPEED_MAX`), and packs
the result. Do not reimplement a trim here to avoid it.

**Residency is per *file*, not per clip**, which is `ui/residency.js`'s rule with
the opposite hard case. The workbench's is a montage — many clips of many files —
so it holds a decoder per clip near the playhead. This one's is forty clips of
four recordings, so an element per clip would open one six-hour file forty times.
`supercut/screen.js` keys its pool by path and a cut inside a recording is a
seek. Both rules say a decoder belongs to what is being *watched*; they differ on
what counts as the same thing. **The pool has to be able to hold the whole mix or
it holds none of it** — `room()` is the distinct files plus one, and the cap is a
gigabyte's worth rather than a number of clips: a fixed three evicted the file it
was about to need again on every crossing, and a fixed eight did the same once
every clip had a proxy of its own (80 ms of opening on a click that should be a
seek).

**A line is the other way to make a mix, and it is the shape deciding the
material rather than the reverse** (`supercut/line.js`, drawn by
`supercut/ruler.js`). The rest of that application assembles by finding — a
hit, a listen, a press — which is right until you can already hear the thing:
*what the hell are you doing, man* in this voice is seven searches, seven
presses and then a trim per piece to a length nobody hits by eye. So the
sentence is typed and the finding is done: a **line** is the text and under it
a packed sequence of words in *seconds* — each one a moment of the corpus, its
cut points inside that moment (`head`/`tail`, offsets from the take's own ends
so a nudge means the same thing on the next take), the rest after it, its pace
and its gain — all of which live **on the word object** rather than in a map
keyed by position, so a word moved keeps its choices. The line is edited as
text and `setText` is a **diff** (longest common subsequence over the words),
so retyping a sentence to change one word keeps six chosen takes. Punctuation
is pacing and comes off the word: a comma a short rest, a full stop a long one,
a line break the longest, each a multiple of the speaker's own gap
(`library.naturalGap`, the median silence between neighbouring words — and the
default when the transcript's words abut, because Parakeet's do and a median of
zero is words with no breath between them).

**Three stages, and the mix is the last** — the order was the whole point of
the rewrite, and it is asserted as an order in `tests/supercut.js`. *Write*:
every word resolves as it is completed and the word that just landed is heard,
because the natural confirmation that a word exists in this voice is to hear it
in this voice, and nothing is in the mix. *Hear and fix*: Enter says the line
back through the audition element, and a take cycled, a cut point dragged on
the panel's waveform, a pace, a gain is heard on the change. *Then the mix*:
`→ Mix` (`commit`) lays the line into the row, and only then — the cuts and the
proxies that make a clip cheap to scrub are seconds of work each, and the
version before this one, which mirrored a grid into the mix on every edit,
started twenty of them for twenty takes auditioned. Pressing it again
reconciles (`lay`): every clip is tagged with its word's id and the take it was
cut from (`clip.word`, `clip.laid`), so the same take is the same clip adjusted
in place and another take is another clip where it stood; between presses the
mix is not touched, so trims made on the cards survive. The line's clips are
one block of the row in line order, standing where the first of them stood, and
a clip added by hand keeps its place beside them. A word nothing says is a
`hole` of nominal length, so the line can still be read, and is named rather
than refusing the whole line.

**Speech is not on a grid, and the grid is a quantiser.** The first version
was a step sequencer — a tempo, cells, words on steps — which is the right model
for `no no no no` on the beat and was the only model, so a sentence was rounded
to eighths of a second and came out as a machine reading it. The substrate is
now time, and *on a beat* (`onBeat`) rounds every word and rest to a step:
within a quarter by a stretch (`STRETCH_NEAR_*`, the clip's speed set so its
own span fills the steps), past that by the cut. Off, nothing is rounded.

**Which take, and what clean means.** Takes are ranked by how near the span is
to the length the word is *typically* said in (the median over its takes), by
the quiet either side in the transcript (`before`/`after` on a hit,
`ui/phrase.js`), and when quantising by the fit to a whole number of steps. The
length weighs more than the quiet, and the reason is what a transcript's span
is: a word runs to the next token, so a word before a pause *is* the pause —
`the` before a breath was 4.8 s, read as quiet on both sides, and the cleanest
take of eighteen thousand. Such a span is cut at twice the typical length
(`LONG`) and the rest counted as the quiet after the word. Repeats walk the
takes. **Pace** is realised as the rate within a whole tone (`PITCH_NEAR`) and
as the rests beyond, so the voice stays the voice until the sound can be
stretched with its pitch kept, which is native work not yet done.

**A rest holds the shot** (`restHold`): it is the previous word's recording
carried on from where the word ended, muted — a clip the model already
expresses — so the speaker pauses on the screen; black (a `color` generator
clip, because the sequence is packed and there is nowhere for an absence to be)
is the other choice and the rest after a hole. The shape of a word's sound on
its block and in the panel is `supercut/waves.js`: `ui/loudness.js`'s reader one
size down, a span keyed by its own numbers off the same worker, one in flight,
because a word has no clip until the line is in the mix and `ui/analysis.js`
reads clips. **What can be typed is the library's** (`vocabulary`, `saidCount`,
`suggest`); the box's hints draw it and decide nothing. **A plan is an answer
about a corpus** and `plan()` re-resolves when the corpus under it moves
(`corpusKey`): a line restored before a channel was open once reported every
word missing for the rest of the session. And the line is a workspace
preference and **not in the document**: what a `.fbro` holds is the mix, which
is a mix like any other from the moment it exists.

**Where the beat is, is measured** — and it is the first reader
`bro.ffmpeg.marks` has ever had. A transcript's time is Parakeet's frame (0.08 s)
and is where the *token* was emitted; at 120 bpm a sixteenth is 125 ms, so
cutting on that number is nearly on the beat and sounds like a mistake. So each
take asks for the onsets in a short window around its word and **slips** to the
nearest transient. Four things. It is a **slip, not a trim** — the whole take
moves, end with start — so the line's timing is untouched whatever the answer
is and a read that never lands leaves the transcript's; and the answer is kept
**by take** (`path@at`), so the ruler, the audition and a clip already in the
mix read one number, and a take cycled back to is not read again. The window
**leads by 0.6 s** because the flux baseline is
an EMA starting at zero — the first half-second of anything analysed carries
marks that are not in it, and the lead puts that before the word rather than on
it. The offset is applied **relative**, so it composes with `cuts.js` repointing
the clip mid-flight. And **an onset is a transient and is not "the word"**:
what is claimed is that the piece moved to the transient nearest its word,
gated against speech presence (energy VAD) and weighted by PCEN spectral flux so
that vocal attacks are preferred over background noise or music transients.
Finding this needed a real fix one layer down — `SourceAudio::open` moved the clock
for an input's `-ss` and never seeked, so a windowed `marks` read analysed the
file from zero to `ss + t` and put every `at` on the wrong clock. Silent for as
long as nothing asked for a window; measured at 940 ms against 28 for the same
answer.

**Tracking higher energy speaking, yelling, and activated speaking** (`ui/phrase.js`,
`ui/library.js`, `supercut/results.js`). Beyond searching for specific words or
longest monologues, speech energy and delivery pace are tracked natively:
- **Speech activation & cadence**: `monologues()` computes words per second (`rate`)
  for every run. In `activated` mode, runs are ranked by cadence (with an optional
  `min pace` filter, e.g. 2.8 w/s), surfacing rapid-fire rants and breathless delivery.
- **Yelling & high vocal energy**: Combines lexical/prosodic markers (exclamations `!`,
  emphatic all-caps tokens) with acoustic measurement (`bro.media.peaks`) when media is
  available on disk. `energyScore = rate * (1 + 2 * exclamations/n + 1.2 * caps/n)`
  weighted by peak RMS loudness ($> 0.25$ RMS).
- **Exclamation search in Words**: Typing `!` in the Words search box matches all
  exclaimed words across transcripts, while appending `!` (e.g. `stop!`) searches
  specifically for yelled/exclaimed instances.

**The acoustic half is a second phase off a worker, and `searchTalking` no longer
has it.** A span of a six-hour recording is a decode, and two dozen of them is
1.28 s measured — which is what the press cost with them where they were first
written, on the thread drawing the window. `ui/loudness.js` reads them off
`ui/analyze-worker.js` (a second `Worker` over the one script, not a second
script; the block at its top says why it is not `ui/analysis.js`'s), one span in
flight so that abandoning a ranking costs one span rather than twenty-four. Two
things about the answer are load-bearing. **A measurement weights the words
rather than replacing them** — the pace and the exclamation marks are a real
signal and a list that reordered itself wholesale the moment a number arrived
would be moving under a hand for a reason nobody could see. And **`peakRms` has
three states**: `null` is a span nobody listened to, `0` is one that could not be
read, and a number is a measurement — a ranking that read the first as silence
would push every unheard stretch to the bottom and call that an answer, which is
also why `· loud` appears only on a stretch that was actually heard.

**A corpus search is a *reading*, because a corpus is a hundred hours**
(`beginSearch`/`stepSearch`/`cancelSearch`/`searchProgress` in `ui/library.js`,
drawn by `ui/find.js` and `supercut/results.js`). Every call above answers on the
line it is made, which is right for a script and is a frozen window here: on the
real corpus (11 recordings, 99.3 h, 787 k words) the *first* search of a session
was 11.1 s — the transcripts being read — and every keystroke after it 97 ms, and
the energy press added 1.28 s of decoding on top. So a view asks for a reading
and the frame loop steps it with an 8 ms budget: **median step 9 ms, p99 57 ms,
worst 103 ms**, with 19 steps of 1179 over one frame. Five things are
load-bearing. **The answer is the same answer** — `wordsIn` and `talkingIn` are
what both paths walk and the partial list is sorted by the rule the finished one
is sorted by, so a reading is the whole search made visible rather than a second
search that can disagree with the first. **The parse is stepped too, not just the
walk**: a step that finished the recording it started was still 1.6 s, so
`parseSrtFrom`/`growStream` read an `.srt` `CUES` at a time and a stream half
built is a correct stream of the words in it. **A step always does at least one
slice** whatever the budget says, because a search a busy machine can starve into
never finishing is worse than one that blocks. **A frame with nothing to look for
reads the corpus anyway** (`warmSome`), which is what keeps the calls that
*cannot* be readings — `supercut/line.js` resolving every word of a line on
the keystroke that changed it, and `commit()` needing the whole answer — off the
8.9 s: nothing about reading a transcript depends on the question, so the only
decision was which moment paid. And **an answer is remembered** (`answered`, and
`forget()` is the one place that drops it), because a score is a dozen searches
of one corpus asked again on every keystroke and eleven of them have the answer
they had on the frame before — 85 ms each becomes 0.

**A moment added to the mix is cut out of its recording** (`supercut/cuts.js`).
`+` puts the clip in the row on the frame it is pressed, against the recording,
and starts a `bro.ffmpeg.fetch` stream copy of the moment with `PAD` (10 s)
either side; when it lands the clip is repointed at the cut and the recording
leaves the input list. Four things about it. The in-point is snapped to a
**keyframe asked for before the copy** (`bro.ffmpeg.keyframes`, 60 ms over a
twenty-second window) rather than inferred from the result afterwards, because a
copy begins at or before what it was asked for and the offset is what the clip's
new in-point is measured against. The pad is what makes a cut *fixable* — a
transcript says where a word is, not where the sentence starts, so a piece taken
to the word cannot be widened and widening it is the first thing anybody wants.
Every failure leaves the clip on the recording, which works and is slow. And the
**measured win is bytes and portability, not speed**: thirteen moments of four
six-hour recordings go from 60 GB to 270 MB, but a 20 MB cut opens in ~110 ms and
seeks in ~55 ms against ~129 ms and ~59 ms for the 15 GB recording — nearly all
of it is `avformat_find_stream_info` and the decoder, neither of which cares how
long a file is. It also makes thirteen clips *thirteen* distinct inputs where
there were four, which is why `TimelineSource::openTheFirstOfEach` opens them at
once (1.4 s in a row, 0.2 s together).

**And the file a scrub is answered out of is a third file, because a cut is
not one** (`src/native/proxy_queue.h`, `bro.ffmpeg.proxy`, `PROXY_HEIGHT` in
`supercut/cuts.js`). `ElVideo::seekTo` calls `VideoPipeline::settleAt` —
deliberately, because the documented answer to "what is at t?" is read back on
the line after the assignment — so a hand dragging a trim edge pays a decode per
position, on the UI thread. Forty seeks over 25 s of 1080p60: **50 ms** with the
recording's two-second GOP, 46 ms at a GOP of four, 24 ms all-keyframe, 40 ms at
720p with the long GOP, **11 ms at 720p all-keyframe**. Two facts decide the
design: shortening a GOP buys nothing until it reaches *none* (the walk is ~0.45
ms a picture almost regardless of size), and the rest is per pixel. So a proxy is
all-keyframe at about the size it is looked at, `supercut/screen.js`'s `pathFor`
is the only reader, and a trim drag went 50 ms → 7 ms a position. Four things
about it. It is **not a render** and could not be: the export half's currency is
RGBA, so the same output through `render.start` is 29.7 s against 1.9 s for a
loop that scales planes to planes — and it holds no job slot, for the reason
`fetch_queue.h` gives. `gop_size = 1` is **refused by NVENC** ("Gop Length should
be greater than number of B frames + 1"), and the mark that replaces it makes a
non-IDR I frame — which is not flagged as a keyframe — unless the encoder's own
`forced-idr` is on too, so `tests/proxy_test.cpp` counts rather than trusts. Both
kinds of file are written `.part` and **renamed on Done**, and the terminal state
is published only after the muxer has closed, because a rename of a file libav
still holds fails silently on Windows. And a proxy is `ui/localcopy.js`'s rule
where the cut is the exception to it: nothing renders from one, none is in a
document, and deleting every one of them costs a slower drag until they are made
again.

One decision worth not undoing: **playback is the render preview and only that**
(`ui/output.js`). The workbench plays the clips and uses the render to smooth the
cuts; a supercut is nothing *but* cuts, so playing the clips would be almost
entirely seams. The cost is a visible wait while the render builds, which the bar
says out loud — a wait somebody can see beats a stutter they cannot fix. That
wait is ~200 ms on a thirteen-cut mix, and getting there needed the one-time
**781 ms of `bro.ffmpeg.hardware()`** — which `buildSpec()` reaches through
`deviceForRender` — moved off the press onto an early frame of the app's own
loop. Nothing about that answer depends on the edit; the only question was which
moment paid for it.

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

`ui/export/explain.js` draws a second distinction that is the same shape and is
just as easy to blur. This application explains itself in prose, and the Write
stage had reached eight paragraphs against twelve controls — the reasoning was
the page and the controls were what you hunted through it for, which is how
prose that good stops being read. So an **explanation** is folded behind an ⓘ,
off by default and remembered: it says how a thing works and is the same
sentence on every render (`why(key, …)`, and `explained(key, title)` for the
heading that carries the control). A **statement** is never folded: what *this*
row's numbers do, why a control is absent, what a setting has cost — those
change with the settings and are the answer to a question somebody is holding
right now, and they stay `ex-note`/`ex-copy-note`. Folding one would be an
application that knew something and did not say it. The line is drawn by hand,
note by note, because it is a judgement about each sentence and no class name
could make it. A stream row's detail is faceted for the related reason
(`facetsOf` in `ui/export/streams.js`): one fold that opened onto forty controls
is the thing the fold exists to prevent, moved a level down rather than avoided,
and a closed tab carries a count so it summarises rather than hides.

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
data, render, fetch, proxy, capture, capabilities, playback, sequences, expressions — each owning its calls, the
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
job for `ui/analyze-worker.js`. Nothing in the UI currently draws a reading —
the Data lane left with the ffmpeg-only pass — so `bro.ffmpeg.data` and
`tests/data_test.cpp` are the whole surface until one returns. A reading is
derived, so it would not be in the document, for the reason `peaks` is not.

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
A label claiming a
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

**brosoundml is required, and that replaced a branch nothing ever ran.**
`-DBRO_WITH_SOUNDML=OFF` was once a supported configuration — a conditional
link, an `#if` compiling `sound_marks.cpp` to a refusal, a runtime throw in the
binding, `bro.ffmpeg.marks.available()` answering false, and a second path in two
suites — and it was never configured, built or run. Now the configure refuses it
with a sentence, the link and the sources are unconditional, and there is no
`available()` on `bro.ffmpeg.marks` because its answer could not vary. What is
left is the distinction that was always the point: a *silent file* gives back an
empty list, and a file with no soundtrack at all is refused by name.

**Marks have exactly one reader and it is not a lane.** The Marks lane and the
`,`/`.` walk left with the ffmpeg-only pass and have not come back;
`supercut/line.js` is what arrived instead, and the shape of it is worth
noticing before adding a lane. It never shows a mark and never lets anybody pick
one — it asks for the onsets in a 0.8 s window around a word and moves the take
onto the nearest one, so the measurement is *used* rather than drawn, which is
the form that turned out to be worth having. It is also what found the windowing
bug in `SourceAudio::open` above: nothing had ever asked this surface for a
window before.

### The words, which are the other thing a soundtrack holds

`transcribe.h` is the second reader on this surface that is not a part of
ffmpeg's model, and it answers the question a waveform and a mark cannot: *what
was said*. Six hours of somebody talking is a recording nobody scrubs through.
`brosoundml::Whisper` reads it, `brolm::whisper::Tokenizer` builds the prompt and
decodes the ids, and both are linked into `ffmpeg-bro-core` — brolm's link line
is new and the block in `CMakeLists.txt` says why reimplementing a byte-level BPE
was not an option.

**A transcript is a search hint and never the cut**, and everything downstream
holds that line. The audio-only and video renditions of a Twitch VOD do not share
a zero (+0.80 s, +2.21 s, +2.57 s at three points of one recording — a *step*,
from an ad break discontinuous in one and not the other), so a transcript read
from the cheap audio-only copy is on that copy's seconds and a cut placed on a
word boundary would land on the wrong file's clock. A hit moves the playhead; a human agrees.

**Why this is native is NOT `sound_marks.h`'s reason, and the difference is the
important part.** That file is native because `bro.sense.analyze()` is
synchronous on the UI thread; `bro.stt.transcribe()` is already asynchronous, so
that argument does not transfer. What forced it: Whisper wants mono 16 kHz and
the conversion is `swr`'s, which bro must never learn about — so `SourceAudio` is
the only reader that can feed it; and brotensor's pool is a process-wide
singleton, so a transcription and a marks read take the *same* `analysisLock()`,
which is only possible with both on this side. That lock moved out of
`sound_marks.cpp`'s anonymous namespace into its header for exactly this.

**Three engine fixes are why this file does not window anything.** Each was a
place where routing around brosoundml would have worked and been wrong:
a decoder asked for timestamps could answer `<|notimestamps|>` and produce none
at all (`TranscribeOptions::no_timestamps_id` forbids it); a long-form run's
timestamps restart at `<|0.00|>` every window and nothing said where a window
began, so `[10.38]` was unplaceable in a six-hour recording
(`Transcription::windows` and `on_window`); and long-form took the whole input as
one `AudioBuffer` — 690 MB for six hours — so it could not do anything long
(`AudioReader`). What is left here is the reader over `SourceAudio` and the walk
from ids to segments. **When something is wrong one layer down, fix it there** —
the measured result of doing so was that this file got smaller.

**A poll of a running read answers with the words so far**, which is the one rule
this breaks that `marks.reads` and `data.reads` keep. The consequence is that a
terminal answer is *not* handed over exactly once — a finished read keeps
answering until `forget`, or a caller polling a growing transcript on the frame
loop would watch it vanish on the frame after it completed — so `forget` is
required rather than tidy. `read` is carried beside the segments because without
it nothing can tell "the last hour is silent" from "the last hour is unread".

The transcript reaches no UI at present — the Sources read rows and the Find
stage left with the ffmpeg-only pass — and the surface that remains is
`bro.ffmpeg.transcribe` and its native reader.

The weights are not shipped and an absent model is refused **by name**;
`brosoundml/scripts/download-whisper.sh --size large-v3` puts one on disk.
Measured on an RTX 4090: large-v3 at 4.0x realtime, so a six-hour VOD is about
ninety minutes and is searchable from the first window. The same model on the CPU
is days, and whisper-tiny — which transcribes clean speech correctly and stream
audio poorly — is 1.2x. **The default build has brotensor's CUDA backend off**
(`BRO_WITH_TENSOR_CUDA`), which is what makes that difference; the feature works
either way and is only worth using with a GPU.

**The nightly turns it on and CI does not**, and the split is deliberate. A
released binary that transcribes at days per recording ships a button nobody can
press, so `.github/workflows/nightly.yml` builds CUDA on Windows and Linux and
Metal on macOS — one download per platform, because brotensor falls back when
there is no device and the runner that smoke-tests it has none. CI stays CPU-only
because it is the fast signal on every push and 88 `.cu` files across four
architectures is not; brotensor's own CUDA compile is covered by bro's nightly,
so what this repository risks by not building it on every push is small. The
consequence to know: **a CUDA-only compile break shows up at night**, and it
holds the release the way a macOS break does.

### The native encode side

`export_timeline.h` defines the seam: a `FrameSource` answers "what does the
output look like at t?" `TimelineSource` is the track stack's answer,
`GraphSource` (`export_graph.h`) is libavfilter's, and `runExport` cannot tell
them apart. Beyond that: `export_writer` (encoders + muxer — and one writer is
one *muxer*, not one file: `segment`, `image2`, `hls`/`dash`, `tee` all write
runs), `export_copy` (stream copy), `export_subtitle`, `export_compositor`,
`export_source`, `export_frame` (RGBA is the currency of this half, plus the
shared libav helpers).

**A windowed copy seeks on the picture, and which stream that is was once decided
by the order of the stream rows.** Only video has sparse keyframes; every audio
packet is one, so `av_seek_frame` on a soundtrack lands anywhere and the video
packets after it start mid-GOP — Matroska then reports "File is broken, keyframes
not correctly marked", a non-monotonic dts, and the copy fails with nothing on
disk. `CopyStreams::build` took the tap holding the earliest in-point, ties to the
first listed, and `copyRowsOf` lists a file's streams in the container's order —
so a recording muxed soundtrack-first broke and one muxed picture-first worked,
on the same call with the same window.

**And a windowed copy begins where it was asked, which for years it did not.**
The window's *tail* was enforced and its head was not, so the copy's zero was
wherever the earliest packet of any stream happened to land — and that is a GOP
before the in-point, routinely, for two reasons that stack: the seek is
approximate (`keyframesOf` answers `how: "scan"` on a file with no index, and
`av_seek_frame` then comes back with whatever keyframe its binary search finds),
and a Matroska cluster hands over a second or two of soundtrack before the video
keyframe in it. Both were invisible, because a copy two seconds long at the front
plays perfectly. What noticed was `supercut/cuts.js`, which measures a clip's new
in-point against *the moment it asked for*: every cut came out two seconds early
and the word each one was cut around fell outside the clip. So `prime` now finds
the copy's own beginning — reading forward from wherever the seek landed, keeping
one GOP, discarding it at every later keyframe still at or before the in-point —
and `keepsEarly` is the one home for which streams may precede it: a **picture**
because the ones after it are predicted from it, a **cue** because it is still on
the screen, and nothing else. A sound packet from before the window was not asked
for. `seekTarget` was half of the same bug at a thirtieth of the size:
`keyframesOf` answers on the stream-origin-relative clock and the seek was built
without the origin put back, so a target 34 ms early landed a whole GOP early.

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

**A `fetch` is the packet path with that slot taken off it** (`fetch_queue.h`,
`bro.ffmpeg.fetch`): a stream copy into a local file, several at a time, each
cancelable, running while the application is used and while a render is running.
It is not in the slot because it is not a render — no compositor, no encoder, no
graph, no report channel — and putting one there would mean that saving a
six-hour recording locked out the Render button for forty minutes, which is
backwards: the download is what you start *so that* you can get on. It takes the
same `buildSpec()` object every other consumer takes and **refuses by name** a
spec it cannot perform, so a fetch can never quietly become a render. The pool
is small on purpose — every fetch is a download and they share one link — and
`soon` jumps the queue without preempting, because a half-written file is worse
than a wait.

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

**Pressing play must not stop the window, and both halves of that were bugs.**
The two opens above happen on bro's UI thread inside `<video>.src`, and a
preview's source is a *render*: what a file demuxer has lying on a disk, this has
to make. Measured on a thirteen-cut supercut of four six-hour recordings, the
press cost **one frame of 6.0 s**, and it was two separate things.

**A source that makes its packets needs a way to say "not yet".**
`MediaSource::readPacket` has only true and false, and false means the stream
ended — so `OutputSource` waited, and bro's `pumpStreamingAudio` waits inside it,
once a frame, from `pumpEvents`, on the UI thread: 4.0 s of the 6.0 filling the
audio ring for the first time. `MediaSource::packetReady()` is the answer, in
bro: a demuxer says true always and nothing about it changes, a tap-backed source
says whether a block is queued, and the pump comes back next frame. **The wake is
part of it and not a tidy-up** — the run produces only while it is being asked,
and the asking used to live in `readPacket` alone, so a `packetReady` that did
not wake the run would be the reason it stayed "not yet" for ever. Waiting never
made the block arrive sooner; it only decided who stood still.

**And whether a render has a soundtrack is a question about its inputs, not
about its clips.** `TimelineSource` opened a `SourceAudio` per clip in its
constructor, because `hasAudio()` is asked once before the first frame — thirteen
opens of fifteen-gigabyte files, 1.9 s. One clip of each distinct input answers
the same question; the rest open in `mixInto`, which is the run's own thread. The
picture already worked this way in `canvasAt` and the sound now matches it.
Together: 6.0 s → 1.5 s cold and ~0.5 s for a rebuild after an edit. The runs of
~210 ms frames that show up around this in a headless probe are
`VideoPipeline::flush`'s `kFrameWait`, which `engine.cpp` calls in
`DisplayMode::Headless` **only** — do not read them as window stutter.

## Conventions that are load-bearing

- **No instructional prose or explaining tooltips in the UI.** The UI itself must lead into what it does. Instructions (how to operate) are replaced by affordances (controls, cursors, handles, menus). Explanations (teaching concepts) leave the UI for the manual (`docs/manual/`). Statements (changing facts/counts/refusals) stay as 1-line structured data anchored to controls. Build-reported strings and shortcut-name titles (e.g. `title="Mute (M)"`) remain.
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
