# ffmpeg-bro

[![CI](https://github.com/wlejon/ffmpeg-bro/actions/workflows/ci.yml/badge.svg)](https://github.com/wlejon/ffmpeg-bro/actions/workflows/ci.yml)
[![CodeQL](https://github.com/wlejon/ffmpeg-bro/actions/workflows/codeql.yml/badge.svg)](https://github.com/wlejon/ffmpeg-bro/actions/workflows/codeql.yml)
[![Nightly](https://github.com/wlejon/ffmpeg-bro/actions/workflows/nightly.yml/badge.svg)](https://github.com/wlejon/ffmpeg-bro/actions/workflows/nightly.yml)
[![Download nightly](https://img.shields.io/github/v/release/wlejon/ffmpeg-bro?label=download%20nightly)](https://github.com/wlejon/ffmpeg-bro/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A friendly GUI for ffmpeg, built on the [bro](https://github.com/wlejon/bro) engine.

ffmpeg is extraordinarily capable and extraordinarily hard to drive. This is a real
GUI over it: open a file, see what is actually in it, play it at full quality
through the real decoder, cut it on a timeline, filter it through a node graph,
and export it.

Pre-alpha, and the nightly is the release channel. The nightly builds Windows,
Linux and macOS; Windows is the one it is used on daily, so treat the badge as
what the other two are backed by.

## What it does

- **Full-quality playback.** libavcodec decodes in-process, threaded across all
  cores: no proxy transcode, no intermediate files, no subprocess. What you see is
  the decoder's output.
- **Everything ffmpeg reads and writes, in one download.** 350+ demuxers, 180+
  muxers, 500+ filters and every protocol this build links, enumerated from the
  libraries rather than written down, so nothing is artificially off the menu.
- **A real timeline.** Filmstrips and a waveform, multiple video tracks, trim,
  split, snap, drag to restack, and a grid layout that turns a morning's
  recordings into a synchronized wall of clips.
- **The edit as a node graph.** The Graph stage draws your edit as the filtergraph
  that performs it. Add any libavfilter filter, wire pads yourself, and preview
  what each node actually produces, rendered through the same engine as the
  export, never a simulation.
- **One render, several streams.** Name output pads on the graph and map streams
  to them: a two-monitor screen grab cropped into two streams of one file.
- **Honest exports.** Per-stream everything: stream copy without re-encoding (with
  the keyframe costs shown, not hidden), subtitles carried, converted, burned in or
  extracted, two-pass encoding, attachments, chapters, dispositions, fourccs.
- **The output, while you edit.** `O` puts the render itself on the program
  monitor instead of the clips: the same frame source the export walks, made as
  you watch it, so a burn-in over the whole canvas or a generator with no clip
  behind it is on the screen rather than something you take on trust.
- **The command bar.** The real ffmpeg invocation for what you built, under every
  stage, ready to copy into a shell.
- **Capture.** Screen, camera, microphone, previewed live, a region dragged
  directly on the picture, recorded through the same encoders as everything else.
- **Measurement.** `cropdetect`, `blackdetect`, `ebur128`, PSNR/SSIM/VMAF and
  friends, plotted over the render, with one-click actions on what they found,
  plus an A/B preview that puts a number on what your settings cost.
- **What was said, found.** Given a corpus of transcribed recordings, `/` searches
  every word of it from inside the timeline and moves the playhead to a hit. The
  [supercut application](#the-supercut-application) below is a whole window for
  that job.
- **Anywhere ffmpeg can write.** A file, a numbered image run, HLS/DASH, a URL
  (`rtmp://`, `srt://`, …), or several destinations at once through `tee`.
- **An honest account of hardware.** What your GPU actually speeds up (usually
  encoding) and what it does not (usually decoding), measured on your machine
  rather than assumed.

## Installing

Grab the [latest nightly](https://github.com/wlejon/ffmpeg-bro/releases/latest)
for your platform and unzip it. Everything is in the download: ffmpeg is linked
into the binary, so there is nothing else to install and nothing on your `PATH`
to conflict with. The Windows binaries are code-signed; the Linux and macOS ones
are not, so macOS will need `xattr -dr com.apple.quarantine` on the folder.

There is one download per platform and it runs with or without a graphics card.
The nightly compiles brotensor's GPU backend in, CUDA on Windows and Linux and
Metal on macOS, which is what makes supercut's transcription quick: about 81x
realtime on an RTX 4090, so a six-hour recording is roughly five minutes. On a
CPU it is much slower, which is what a card is for here. The speech model weights
are not in the zip: with none on this machine supercut offers no **Transcribe**,
and **Get model** beside the channel box fetches them, 2.5 GB, resumable and
stoppable, into a `models/parakeet` folder beside the binaries. **Model…** points
at a checkpoint you already have instead. Those, plus
`brosoundml/weights/parakeet` in a brosoundml checkout or in bro's own, are the
three places looked in.

## Building

Requires a C++20 compiler (Visual Studio 2022 on Windows), [CMake
3.21+](https://cmake.org), [vcpkg](https://vcpkg.io), and a checkout of
[bro](https://github.com/wlejon/bro) beside this one (or `-DBRO_DIR=<path>`).

`cmake -B build` finds vcpkg through **`VCPKG_ROOT`**; set it, or pass
`-DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake` yourself.
With neither, the configure stops and says so.

```
git clone https://github.com/wlejon/ffmpeg-bro
git clone --recursive https://github.com/wlejon/bro

cd ffmpeg-bro
cmake -B build
cmake --build build --config Release
./build/Release/ffmpeg-bro [media-file]
```

There is no `vcpkg install` step: [`vcpkg.json`](vcpkg.json) is the list of what
this build links, and the toolchain installs it into `build/vcpkg_installed`
during the configure. That list is pinned by `builtin-baseline` to the same
microsoft/vcpkg commit bro pins, so your build and CI's link the same libraries
at the same versions. The first configure builds ffmpeg and its dependencies
from source and takes a while; every one after it is cached.

`--recursive` matters: this build turns bro's `BRO_WITH_SOUNDML` on, which
reaches brotensor, brolm and brosoundml in bro's tree. They are MIT like bro,
nothing is downloaded at configure or build time, and they add no vcpkg port.
What they buy is the two things this application reads out of a soundtrack that
libav cannot: the words that were said in it, which is the corpus everything in
supercut is built on, and the transients a beat-cut snaps to. bro's own preflight
only checks three of its submodules, so an unrecursed clone fails by naming a
missing `CMakeLists.txt` rather than a missing submodule.

There is no way out of them: `-DBRO_WITH_SOUNDML=OFF` stops the configure with a
sentence saying so. Reading a soundtrack is an ordinary part of this application
rather than an extra, and a build without it would be one whose difference from
every other build shows up nowhere until somebody presses something. Fix the
clone rather than the flag.

Three binaries are built: `ffmpeg-bro` (the application), `supercut` (a second,
single-purpose application over the same engine, see below) and
`ffmpeg-bro-headless` (the same engine driven by a JS script: how the UI is
tested, and a scriptable media tool in its own right).

## The supercut application

```
./build/Release/supercut
```

One window for one job: search hours of transcribed recordings for a word or for
a stretch of talking, hear what comes back, and cut it together. No stages, no
node graph, no encode form: a list down the left, the picture on the right, and
a row of cards along the bottom with four places to grab each (reorder, trim,
slip, speed).

**It goes and gets its own material.** Type a broadcaster's login and it lists
their past broadcasts and fetches the ones you pick, resuming an interrupted one
where it stopped; or point it at a folder of footage already on this disk and
that folder becomes a channel, with nothing copied. Either way **Transcribe**
then reads every word of a recording with times, on the GPU, at about 81x
realtime: six hours is about five minutes, and the words are searchable as they
arrive rather than at the end.

**A moment you add is cut out of its recording**, as a stream copy with ten
seconds either side, so the mix ends up being its own footage: thirteen moments
of four six-hour recordings are 270 MB rather than sixty gigabytes, and the
recordings can go back on the shelf. Downloads, transcriptions and cuts all run
beside the editing, several at a time, and the count in the top bar is what is
running.

**The Line tab is the other way to build one.** Type the sentence, and it finds
each word in this voice as you type it, gives it its cleanest take, and says the
line back; tune it by ear — another take, a cut point, a pace, a rest — and
then put it in the mix, where the cuts land on the measured attack of each word
rather than near it.

It shares this application's clips, edits, render and **document**, so a `.fbro`
written in one opens in the other, and none of its interface. Nothing in it needs
a terminal: the model, the recordings, the transcripts, the search, the cuts and
the file it writes are all presses, and the corpus lives in `build/corpus/`
beside the application wherever you start it from. The same corpus can be built
and searched from the command line with [`tools/supercut.js`](tools/README.md),
which is what a folder of five hundred clips wants. [The manual
part](docs/manual/supercut.md) is the detail.

## Keyboard

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` `→` | step one frame (hold `Shift` for one second) |
| `J` `L` | shuttle down / up through the speed list |
| `K` | pause |
| `Home` `End` | go to start / end |
| `M` | mute |
| `F` | fullscreen (`Esc` leaves) |
| `+` `-` `0` | zoom the timeline in / out / to fit |
| `C` | crop handles on the picture (`Esc` leaves) |
| `S` | split the selection at the playhead |
| `G` | grid / stacked layout |
| `O` | the output on the monitor instead of the clips |
| `/` | find a word, or a stretch of talking, in a corpus |
| `E` | the Encode stage (`Esc` goes back to the edit) |
| `D` | the Capture stage: a device, watched and recorded |
| `I` | the Sources stage: what is actually in the files |
| `R` | what the render said, messages and what filters measured |
| `N` | the Graph stage, the edit as a filtergraph (`0` fits it) |
| `[` `]` | one step back / forward along the pipeline |
| `Ctrl`+`A` | select every clip (`Esc` narrows back to one) |
| `Delete` | remove the selection |
| `Ctrl`+`S` `Ctrl`+`O` `Ctrl`+`N` | save, open and start a document |
| `Ctrl`+`Z` | undo (`Ctrl`+`Shift`+`Z` redoes) |

## Documentation

- **[The manual](docs/manual/README.md)**, one part per stage, in detail:
  playback, capture, inputs, the timeline, the graph, exporting, subtitles,
  measurement, [the document](docs/manual/document.md) an edit is saved as,
  and an honest list of what does not work yet.
- **[The supercut application](docs/manual/supercut.md)**, the second window:
  what it is for, the four gestures, and what it shares with this one.
- **[The `bro.ffmpeg` API](docs/api.md)**, the JS surface that headless scripts
  and the test suites drive.

## Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own fixture media with known content and runs every suite,
native and UI, against it. Each suite also runs standalone against any real
file; the manual's [Testing](docs/manual/testing.md) part has the full list.

## Known limitations

The short version. The manual's [Not yet](docs/manual/not-yet.md) part is the
honest, complete list:

- With the clips on the monitor, playback shows a clip's own filters and not a
  filter over the whole picture, a soft subtitle track or a generated source with
  no clip behind it; a clip whose filters cannot be shown honestly (one that
  resizes the picture, one that forks) is badged `fx` rather than left looking
  broken. `O` puts the render itself there instead, which has none of those
  exceptions and carries its own sound, but takes a moment to build and rebuilds
  whenever the playhead moves.
- A phone clip plays, lays out and exports the right way up, but the timeline's
  filmstrip still shows its frames on their side.
- A document saves the edit and where you left off in it (selection, playhead,
  zoom, stage), not what has been analysed or what a render last said.
- Undo is split into two separate histories: the edit, and the Encode/Write
  settings. `Ctrl`+`Z` on one never reaches the other.

## License

**GPL-3.0-or-later**, see [LICENSE](LICENSE). ffmpeg's best encoders (x264,
x265, …) are GPL, so a build that can actually do the work is GPL; rather than
restrict itself to an LGPL subset, this application takes the license that
ffmpeg's full feature set requires. The underlying bro engine is MIT and contains
no ffmpeg: libav* is linked into this binary alone and reaches the engine only
through bro's codec-agnostic media interfaces. So are the three libraries the
acoustic and speech readers bring in: brotensor, brolm and brosoundml are MIT,
ship no model weights, and change nothing here. Linking libav* is still the whole
of why this binary is GPL.
