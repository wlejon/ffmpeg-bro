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

There is no ctest wiring and no test fixture media in the repo — every test takes a real
media file as an argument.

```bash
# native: demux, decode, reorder, seek, audio, backend precedence
./build/Release/ffmpeg-bro-decodetest <file> [more files...]

# native: where the time in a seek goes (demux vs decode vs YUV->RGB)
./build/Release/ffmpeg-bro-perftest <file>

# the whole UI, driven like a person — writes screenshots to out/
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]
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

The app exposes `globalThis.__ffmpegBro` (model, transport, and the operations) and
`__ffmpegBroReady` purely so tests drive it through a stable surface instead of DOM ids
that only exist while one clip is selected. Keep that in mind when renaming anything there.

Note: `tests/perf_ui.js` is stale — it reaches for `document.getElementById('player')`,
which no longer exists now that the viewer creates a `<video>` per clip.

## Architecture

### Native side

`registerFfmpegBackend()` must run **before** the `Engine` is constructed (see `main.cpp`
and `headless_main.cpp`), so the first `<video>` in the first document already finds it. It
registers a `bro::video::MediaBackend` at **priority 100**, above bro's built-in WebM
backend, which is why `<video src="anything.mkv">` just works and why every container goes
through one set of seek/timestamp/reordering semantics.

`ffmpeg_bindings.cpp` installs `bro.ffmpeg` (`probe`, `version`, `hwaccels`,
`openOnStart`, …) via `EngineConfig::installHostBindings`, so it exists in every realm
including workers. `probe()` is synchronous on purpose.

**Licensing is a structural constraint, not a footnote.** libav* may only reach bro through
`bro::video`'s codec-agnostic interfaces. Never add an ffmpeg dependency to anything under
`../bro` — bro stays MIT and ffmpeg-free; this binary is the GPL one.

### UI side

`ui/project.js` is the single source of truth: clips, selection, the output canvas, the
layout mode. Everything else reads it and nothing else.

- `app.js` — orchestration: transport, keyboard, drag/drop, the frame loop, the inspector.
- `viewer.js` — the program monitor. Each clip is a `<video>` inside a crop window (a div
  with `overflow:hidden`). Fit/zoom/pan/crop/opacity/stacking are **style writes on those
  two elements** — nothing costs anything per frame, and decoded frames still go straight
  to the renderer. Keep it that way: no canvas readback, no per-frame compositing.
- `timeline.js` — ruler, dynamic V-lanes, one A1 waveform lane. Everything is drawn from
  the *visible window*, not the whole file, which is what makes zoom meaningful.
- `analysis.js` + `analyze-worker.js` — filmstrip and waveform via `bro.media` (see
  `../bro/docs/video-api.js`). Both are full-file decodes, so they run in one worker with
  one queue and the lanes fill in behind a responsive UI.
- `format.js`, `icons.js` — timecode/byte formatting, and SVG icons painted from
  `data-icon` attributes.

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

## Style

Comments here explain *why*, in prose, at the top of a file or above a non-obvious decision
— often several sentences about the failure mode being avoided. Commit messages follow the
same voice (declarative, about the behaviour: "Seek targets round down, not to nearest").
Match that rather than adding `// increment i` noise.
