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
//                // video: width, height, displayWidth, displayHeight, fps,
//                //        pixFmt, sampleAspect, rotation
//                // audio: sampleRate, channels, channelLayout, sampleFmt
//               }, ...],
//     video, audio }          // shortcuts to the first of each
```

`displayWidth`/`displayHeight` account for the rotation in the container's
display matrix — a phone video is 1920×1080 on disk and 1080×1920 on screen, and
only that side-datum says so.

## The timeline

Two lanes under the ruler, the way an edit suite stacks them:

- **V1** a filmstrip — frames grabbed across the file and drawn into the lane.
- **A1** the waveform — peak envelope over an RMS body, so you can see where
  the sound is before you hear it.

Both come from `bro.media` (see bro's `docs/video-api.js`), which decodes the
whole file through the same backend registry `<video>` plays through. Both are
full-file decodes, so ffmpeg-bro runs them in a Worker and the lanes fill in
behind a UI that never stops responding. Clicking or dragging either lane scrubs.

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

## Testing

```
./build/Release/ffmpeg-bro-decodetest <file>          # backend: demux, decode, seek, audio
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file>
```

`ui_player.js` drops a real file on the real UI, plays it, scrubs it, works the
controls and screenshots the viewer into `out/`.

## Not yet

Honest list of what does not work:

- **Audio-only files.** bro's `<video>` drives its clock from decoded pictures,
  so a file with no video track has nothing to advance. The UI says so rather
  than sitting at 0:00.
- **Export.** The encoders are linked and the UI has no surface for them yet.
- **Cutting.** The timeline shows the file — a V1 filmstrip and an A1 waveform,
  both scrubbable — but it is still a viewing surface: split/cut/select/delete
  are the next thing to land on it.
- **Hardware decode.** libavcodec's software decoders are threaded across all
  cores and cost no GPU→CPU readback, which is the right trade while the
  renderer still wants frames in system memory. `bro.ffmpeg.hwaccels` reports
  what the build could use; nothing selects one yet.
