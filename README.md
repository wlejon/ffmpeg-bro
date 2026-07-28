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
git clone https://github.com/wlejon/bro

vcpkg install "ffmpeg[core,gpl,version3,avcodec,avdevice,avfilter,avformat,swresample,swscale,x264,x265,nvcodec,amf,dav1d,aom,vpx,opus,mp3lame,vorbis,theora,webp,openjpeg,zlib,bzip2,lzma,xml2,soxr,speex,snappy,ass,freetype,fontconfig,fribidi,drawtext,openssl,srt,iconv]:x64-windows"

cmake -B build
cmake --build build --config Release
./build/Release/ffmpeg-bro [media-file]
```

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
| `E` | the Encode stage (`Esc` goes back to the edit) |
| `D` | the Capture stage — a device, watched and recorded |
| `I` | the Sources stage — what is actually in the files |
| `R` | what the render said — messages and what filters measured |
| `N` | the Graph stage — the edit as a filtergraph (`0` fits it) |
| `[` `]` | one step back / forward along the pipeline |
| `Ctrl`+`A` | select every clip (`Esc` narrows back to one) |
| `Delete` | remove the selection |

## Documentation

- **[The manual](docs/manual.md)** — every stage in detail: playback, capture,
  inputs, the timeline, the graph, exporting, subtitles, measurement, and an
  honest list of what does not work yet.
- **[The `bro.ffmpeg` API](docs/api.md)** — the JS surface that headless scripts
  and the test suites drive.

## Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own fixture media with known content and runs every suite —
native and UI — against it. Each suite also runs standalone against any real
file; the manual's [Testing](docs/manual.md#testing) section has the full list.

## Known limitations

The short version — the manual's [Not yet](docs/manual.md#not-yet) section is the
honest, complete list:

- No undo, anywhere.
- Playback cannot show filters, soft subtitles or generated sources — those appear
  in node previews and the export preview, which are real renders; affected clips
  are badged `fx` rather than left looking broken.
- A phone clip plays, lays out and exports the right way up, but the timeline's
  filmstrip still shows its frames on their side.
- No project file — graph work persists per machine in local storage, not per
  edit.

## License

**GPL-3.0-or-later** — see [LICENSE](LICENSE). ffmpeg's best encoders (x264,
x265, …) are GPL, so a build that can actually do the work is GPL; rather than
restrict itself to an LGPL subset, this application takes the license that
ffmpeg's full feature set requires. The underlying bro engine is MIT and contains
no ffmpeg: libav* is linked into this binary alone and reaches the engine only
through bro's codec-agnostic media interfaces.
