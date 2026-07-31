# ffmpeg-bro

A friendly GUI for ffmpeg, built on the [bro](https://github.com/wlejon/bro) engine.

ffmpeg is extraordinarily capable and extraordinarily hard to drive. This is a real
GUI over it: open a file, see what is actually in it, play it at full quality with 
cut it on a timeline, filter it through a node graph, and export it.

## What it does

- **Full-quality playback.** libavcodec decodes in-process, threaded across all
  cores — no proxy transcode, no intermediate files, no subprocess. What you see is
  the decoder's output.
- **Everything ffmpeg reads and writes, in one download.** 350+ demuxers, 180+
  muxers, 500+ filters and every protocol this build links — enumerated from the
  libraries, not written down, so nothing is artificially off the menu.
- **A real timeline.** Filmstrips and a waveform, multiple video tracks, trim,
  split, snap, drag to restack — and a grid layout that turns a morning's
  recordings into a synchronized wall of clips.
- **The edit as a node graph.** The Graph stage draws your edit as the filtergraph
  that performs it. Add any libavfilter filter, wire pads yourself, and preview
  what each node actually produces — rendered through the same engine as the
  export, never a simulation.
- **One render, several streams.** Name output pads on the graph and map streams
  to them — a two-monitor screen grab cropped into two streams of one file.
- **Honest exports.** Per-stream everything: stream copy without re-encoding (with
  the keyframe costs shown, not hidden), subtitles carried, converted, burned in or
  extracted, two-pass encoding, attachments, chapters, dispositions, fourccs.
- **The output, while you edit.** `O` puts the render itself on the program
  monitor instead of the clips — the same frame source the export walks, made as
  you watch it, so a burn-in over the whole canvas or a generator with no clip
  behind it is on the screen rather than something you take on trust.
- **The command bar.** The real ffmpeg invocation for what you built, under every
  stage, ready to copy into a shell.
- **Capture.** Screen, camera, microphone — previewed live, a region dragged
  directly on the picture, recorded through the same encoders as everything else.
- **Measurement.** `cropdetect`, `blackdetect`, `ebur128`, PSNR/SSIM/VMAF and
  friends, plotted over the render, with one-click actions on what they found —
  and an A/B preview that puts a number on what your settings cost.
- **Anywhere ffmpeg can write.** A file, a numbered image run, HLS/DASH, a URL
  (`rtmp://`, `srt://`, …), or several destinations at once through `tee`.
- **An honest account of hardware.** What your GPU actually speeds up (usually
  encoding) and what it does not (usually decoding) — measured on your machine,
  not assumed.

## Building

Requires Visual Studio 2022, [vcpkg](https://vcpkg.io), and a checkout of
[bro](https://github.com/wlejon/bro) beside this one (or `-DBRO_DIR=<path>`).

```
git clone <this repo>
git clone --recursive https://github.com/wlejon/bro

vcpkg install "ffmpeg[core,gpl,version3,avcodec,avdevice,avfilter,avformat,swresample,swscale,x264,x265,nvcodec,amf,dav1d,aom,vpx,opus,mp3lame,vorbis,theora,webp,openjpeg,zlib,bzip2,lzma,xml2,soxr,speex,snappy,ass,freetype,fontconfig,fribidi,drawtext,openssl,srt,iconv]:x64-windows"

cmake -B build
cmake --build build --config Release
./build/Release/ffmpeg-bro [media-file]
```

`--recursive` matters: this build turns bro's `BRO_WITH_SOUNDML` on, which
reaches brotensor, brolm and brosoundml in bro's tree. They are MIT like bro,
nothing is downloaded at configure or build time, and they add no vcpkg port —
they cost 27 s of build and 2.7 MB of binary here, because the linker takes what
is referenced and nothing here calls a language model. What they buy is a
working `bro.sense` — the acoustic sensors, which nothing in the UI reads yet.
bro's own preflight only checks three of its
submodules, so an unrecursed clone fails by naming a missing `CMakeLists.txt`
rather than a missing submodule; `-DBRO_WITH_SOUNDML=OFF` is the way out if you
would rather not have them.

`x264`/`x265` are encoders, needed for export; playback works with the plain
`ffmpeg` port too. Two binaries are built: `ffmpeg-bro` (the application) and
`ffmpeg-bro-headless` (the same engine driven by a JS script — how the UI is
tested, and a scriptable media tool in its own right).

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
| `E` | the Encode stage (`Esc` goes back to the edit) |
| `D` | the Capture stage — a device, watched and recorded |
| `I` | the Sources stage — what is actually in the files |
| `R` | what the render said — messages and what filters measured |
| `N` | the Graph stage — the edit as a filtergraph (`0` fits it) |
| `[` `]` | one step back / forward along the pipeline |
| `Ctrl`+`A` | select every clip (`Esc` narrows back to one) |
| `Delete` | remove the selection |
| `Ctrl`+`S` `Ctrl`+`O` `Ctrl`+`N` | save, open and start a document |
| `Ctrl`+`Z` | undo (`Ctrl`+`Shift`+`Z` redoes) |

## Documentation

- **[The manual](docs/manual/README.md)** — one part per stage, in detail:
  playback, capture, inputs, the timeline, the graph, exporting, subtitles,
  measurement, [the document](docs/manual/document.md) an edit is saved as,
  and an honest list of what does not work yet.
- **[The `bro.ffmpeg` API](docs/api.md)** — the JS surface that headless scripts
  and the test suites drive.

## Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own fixture media with known content and runs every suite —
native and UI — against it. Each suite also runs standalone against any real
file; the manual's [Testing](docs/manual/testing.md) part has the full list.

## Known limitations

The short version — the manual's [Not yet](docs/manual/not-yet.md) part is the
honest, complete list:

- With the clips on the monitor, playback shows a clip's own filters and not a
  filter over the whole picture, a soft subtitle track or a generated source with
  no clip behind it; a clip whose filters cannot be shown honestly (one that
  resizes the picture, one that forks) is badged `fx` rather than left looking
  broken. `O` puts the render itself there instead, which has none of those
  exceptions and costs a render — and has no sound.
- A phone clip plays, lays out and exports the right way up, but the timeline's
  filmstrip still shows its frames on their side.
- A document holds the edit and not the session: which clip was selected, where
  the playhead was and how far the timeline was zoomed are not written.
- Undo covers the edit and stops at the Encode and Write stages, which are a
  form.

## License

**GPL-3.0-or-later** — see [LICENSE](LICENSE). ffmpeg's best encoders (x264,
x265, …) are GPL, so a build that can actually do the work is GPL; rather than
restrict itself to an LGPL subset, this application takes the license that
ffmpeg's full feature set requires. The underlying bro engine is MIT and contains
no ffmpeg: libav* is linked into this binary alone and reaches the engine only
through bro's codec-agnostic media interfaces. So are the three libraries the
acoustic sensors bring in — brotensor, brolm and brosoundml are MIT, ship no
model weights, and change nothing here: linking libav* is still the whole of why
this binary is GPL.
