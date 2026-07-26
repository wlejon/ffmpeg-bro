# ffmpeg-bro

A comprehensive, friendly UI on top of ffmpeg, built on the [bro](https://github.com/wlejon/bro) engine.

ffmpeg is extraordinarily capable and extraordinarily hard to drive. This is a real
GUI over it: open a file, see what is actually in it, play it *at full quality with
no proxy transcode*, scrub it frame by frame, and — as the edit surface fills in —
cut it.

## Licensing

**This application is GPL-3.0-or-later** (see [LICENSE](LICENSE)).

That is deliberate, and it is why this lives in its own repository:

- **bro and its ecosystem are MIT.** ffmpeg never enters them. libav* is linked
  into *this* binary and reaches the engine only through bro's codec-agnostic
  media interfaces.
- **ffmpeg builds worth using are GPL.** x264, x265, and the rest of the good
  encoders are GPL, so a build that can actually do the work is GPL. Rather than
  restrict the app to an LGPL subset, this repo takes the license ffmpeg's best
  feature set requires and gives you everything.

So: bro stays MIT and ffmpeg-free, this app is GPL and uses all of ffmpeg.

## What this is, structurally

`ffmpeg-bro` is **its own executable**, not an app directory you hand to `bro.exe`.
It links two things:

- **bro's engine** (`bro_engine` and friends) — MIT static libraries, for the
  window, DOM, layout, renderer and JS runtime.
- **libavformat / libavcodec / libavfilter / libswscale / libswresample** — GPL,
  for demuxing, decoding and encoding.

libav* reaches bro only through `bro::video`'s codec-agnostic `MediaSource` /
`VideoDecoder` / `AudioDecoder` interfaces, registered as a
[media backend](../bro/src/video/media_backend.h) at priority 100 — above bro's
built-in WebM one. Every path that plays media picks it up without knowing it
exists, `<video src="anything.mkv">` included. bro itself never links, ships, or
knows about ffmpeg.

The payoff is that **one download does everything**: no separate ffmpeg install,
no PATH hunting, no version skew, and decoding happens in-process so frames reach
the renderer without a subprocess or a pipe in the way.

Two binaries are built:

| Binary | What |
|---|---|
| `ffmpeg-bro` | the windowed application |
| `ffmpeg-bro-headless` | the same engine and backend driven by a JS script — how the UI is tested, and a scripted media tool in its own right |

## Building

```
git clone <this repo>
git clone https://github.com/wlejon/bro   # beside it, or pass -DBRO_DIR=<path>

vcpkg install "ffmpeg[core,gpl,version3,avcodec,avdevice,avfilter,avformat,swresample,swscale,x264,x265,nvcodec,amf,dav1d,aom,vpx,opus,mp3lame,vorbis,theora,webp,openjpeg,zlib,bzip2,lzma,xml2,soxr,speex,snappy,ass,freetype,fontconfig,fribidi,drawtext,openssl,srt,iconv]:x64-windows"

cmake -B build
cmake --build build --config Release
./build/Release/ffmpeg-bro
```

`x264` / `x265` are **encoders**, needed for export. Decoding — and so playback —
works with the plain `ffmpeg` port too, because the H.264/HEVC/AV1 decoders are
native to libavcodec.

## How playback works

There is no proxy transcode, no intermediate file, and no second encode.
libavcodec decodes in-process with frame and slice threading across all cores,
frames go to the renderer, and audio streams into bro's live PCM ring half a
second ahead of the mixer. What you see is the decoder's output at full quality.

Non-4:2:0 sources (10-bit HDR, 4:2:2 broadcast, 4:4:4 ProRes, RGB screen
captures) are converted by swscale on the way through.

## `bro.ffmpeg`

The host bindings this binary adds to the JS environment:

```js
bro.ffmpeg.available      // true — it's linked, not looked up on PATH
bro.ffmpeg.linked         // true
bro.ffmpeg.version        // "libavformat 62.x.x, libavcodec 62.x.x"
bro.ffmpeg.configuration  // the build's ./configure line
bro.ffmpeg.hwaccels       // ["cuda", "d3d11va", "dxva2", "qsv", ...]
bro.ffmpeg.openOnStart    // media file named on the command line, or null

bro.ffmpeg.probe(path)    // in-process ffprobe: throws if the file can't be read
// → { path, format: {name, longName, duration, bitRate, size},
//     streams: [{index, kind, codec, codecLong, profile, bitRate, language,
//                title, default,
//                duration,
//                // video: width, height, displayWidth, displayHeight, fps,
//                //        pixFmt, sampleAspect, rotation
//                // audio: sampleRate, channels, channelLayout, sampleFmt
//               }, ...],
//     video, audio }          // shortcuts to the first of each
```

`displayWidth`/`displayHeight` account for the rotation in the container's
display matrix — a phone video is 1920×1080 on disk and 1080×1920 on screen, and
only that side-datum says so.

A stream's `duration` is its own, not the container's. They differ: a recording
routinely stops the audio a fraction of a second after the last picture, so a
clip whose length came from the container would run past the end of its video.
Matroska keeps only one duration for the whole file, and then that is what every
stream reports.

## The timeline

Video lanes under the ruler and one audio lane beneath them, the way an edit
suite stacks them:

- **V1, V2, …** filmstrips — each slot showing the frame that is on screen at
  that point, so it stays honest as you zoom in. There is always one empty lane
  above the highest one in use: dragging a clip into it is how you add a track,
  and the lanes share a fixed height between them so the waveform never gets
  pushed off the bottom.
- **A1** the waveform — peak envelope over an RMS body, so you can see where
  the sound is before you hear it.

Both come from `bro.media` (see bro's `docs/video-api.js`), which decodes the
whole file through the same backend registry `<video>` plays through. Both are
full-file decodes, so ffmpeg-bro runs them in a Worker and the lanes fill in
behind a UI that never stops responding.

**Zoom** with the wheel, about the pointer — the only version that lets you
dive into a moment instead of steering the window back after every notch.
`Shift`+wheel pans, the scrollbar under the tracks pans, and `Fit` goes back to
the whole timeline. Everything is drawn from the visible window rather than the
whole file, so at 200× the strip is the individual frames around the playhead
and the waveform under it is the sound at that instant.

**Drop more files** to add them. One or two land after what is already there.
Three or more is a different act — that is a morning's recordings, not an edit —
so they go on tracks of their own, all starting together at zero, and the canvas
switches to a **grid** (see below). Each gets its own filmstrip and waveform.

**Drag a clip** along its lane to move it — it snaps to the timeline start, the
playhead and the other clips' edges, and anything it lands on top of *on the
same track* slides out of the way, which is also how you reorder. Overlapping
across tracks is the point of having tracks, so nothing moves there. Drag it
into another lane to restack it.

**Drag a clip's end** to trim. In-point and start move together when you trim
the head, so the pictures under the part you kept do not slide sideways, and a
trim stops at its neighbours rather than growing over them. The two grips
appear on the selected clip.

**Split** (`S`, or the button) cuts every selected clip the playhead is inside —
one keypress through a whole stack, or through exactly the one you picked. Both
halves point at the same file, so a split costs nothing but a second `<video>`,
and together they cover exactly what the one clip covered. Trimming a half and
deleting the other is how you take a piece out of the middle.

**Select** by clicking a clip or its picture. `Ctrl`/`Shift`-click adds to the
selection, `Ctrl`+`A` takes everything, `Esc` narrows back to one. `Delete`
removes the lot. Drag the ruler or A1 to scrub.

## The picture

The viewer is an **output canvas**, not just a window onto the file: it has a
size of its own (`Match clip`, 1080p, vertical, 4K, or type one in), and each
clip is placed inside it. So a portrait phone capture and a 16:9 clip can share
a timeline with the black bars you would actually get.

Every clip the playhead is inside is on screen at once, bottom track first, so
V2 composites over V1. Per clip, from the **Properties** panel:

- **Track** — which lane, and so where in the stack.
- **Opacity** — what you see through it to the track below.
- **Audio** — the clip's own level and mute, multiplied by the transport's.
- **Fit / Fill / Stretch / 1:1** — how the picture meets the canvas.
- **Scale** — the slider, or the wheel over the picture.
- **Position** — drag the picture.
- **Crop** — four numbers, or press `C` for handles on the picture. Cropping
  trims edges where the picture already is; it does not re-fit what is left, so
  the frame stays put under the handle you are dragging.

With several clips selected the panel edits all of them. A property they
disagree on reads as blank or `mixed` rather than as one clip's value, so
tabbing past a field cannot silently apply it to the rest.

None of this costs anything per frame. The crop is a window around the clip's
`<video>`, opacity and stacking order are an `opacity` and a `z-index` on that
window, and the engine clips replaced content against an ancestor's overflow
like anything else — so a change is a handful of style writes and the decoded
frame still goes straight to the renderer.

### Grid

`Grid` (or `G`) sets every clip's placement aside and gives each an equal cell.
The shape is chosen so a cell has the canvas's own aspect rather than being
square — the clips came out of that canvas, so that is the shape that fills:
four clips go 2×2, a dozen go 4×3, and three go two-up with a gap rather than
into one row of slivers. Scale and position still work inside a cell, so one can
be pushed in on a detail while the others hold still.

Everything plays at once. The topmost clip's decoder is the master clock and the
rest are chased back into line whenever they drift more than about two frames —
correcting every frame would mean a seek per clip per frame, and left alone,
several decoders each free-running on their own audio clock come apart within a
minute. Four 1080p60 streams stay inside ~35 ms of each other; the ceiling is
decode throughput, not the transport.

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
| `Ctrl`+`A` | select every clip (`Esc` narrows back to one) |
| `Delete` | remove the selection |

## Testing

```
./build/Release/ffmpeg-bro-decodetest <file>          # backend: demux, decode, seek, audio
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]
```

`ui_player.js` drops real files on the real UI, plays them, scrubs, steps to the
last picture in the file, zooms the timeline, moves and deletes a clip, scales
and crops the picture, works the controls, and screenshots the viewer into
`out/`. Pass a second file to exercise the multi-clip transport. It also checks
the control strip's geometry — that every icon button drew its icon, that the
transport buttons are one width, that the transport is on the window's centre
line and the zoom controls on the timeline's left edge — because a mistyped
icon name or a stray width breaks none of the behaviour and all of the look.

## Not yet

Honest list of what does not work:

- **Audio-only files.** bro's `<video>` drives its clock from decoded pictures,
  so a file with no video track has nothing to advance. The UI says so rather
  than sitting at 0:00.
- **Export.** The encoders are linked and the UI has no surface for them yet.
- **Rendering the canvas.** Scale, position, crop, opacity, the track stack and
  the grid are all live on the viewer and describe what an export *would* do —
  but with no export, they only affect what you are looking at.
- **Ripple, roll and slip.** Trimming leaves a gap rather than closing it up,
  and there is no gesture that moves a cut without moving the pictures either
  side of it. Nothing here needs new machinery — a clip already knows its
  in-point separately from where it sits.
- **One waveform for the whole timeline.** A1 draws every clip, so clips that
  overlap in time draw over each other rather than mixing. With tracks stacked
  it is the top one you see.
- **Finding things by sound.** Reviewing wildlife footage, the birds are
  audible long before anything is visible; nothing yet marks where a call
  happens so you can jump between them. bro has the parts — `bro.sense` for
  onset and tonality, `bro.kws` for open-vocabulary spotting.
- **Hardware decode.** libavcodec's software decoders are threaded across all
  cores and cost no GPU→CPU readback, which is the right trade while the
  renderer still wants frames in system memory. `bro.ffmpeg.hwaccels` reports
  what the build could use; nothing selects one yet.
