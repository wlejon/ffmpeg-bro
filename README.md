# ffmpeg-bro

A comprehensive, friendly UI on top of ffmpeg, built as a [bro](https://github.com/wlejon/bro) app.

ffmpeg is extraordinarily capable and extraordinarily hard to drive. This is a real
GUI over it: probe a file, see what is actually in it, preview it *without a proxy
transcode*, build an operation visually, watch progress, and get the exact command
line it ran.

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
- **libavformat / libavcodec / libavfilter / libswscale** — GPL, for decoding and
  encoding.

Linking ffmpeg is what makes this binary GPL, and it is why this is a separate
repository. libav* reaches bro only through `bro::video`'s codec-agnostic
`MediaSource` / `VideoDecoder` / `AudioDecoder` interfaces, registered as a
[media backend](../bro/src/video/media_backend.h). bro itself never links, ships,
or knows about ffmpeg.

The payoff is that **one download does everything**: no separate ffmpeg install,
no PATH hunting, no version skew, and decoding happens in-process so frames reach
the renderer without a subprocess or a pipe in the way.

## Building

```
git clone <this repo>
git clone https://github.com/wlejon/bro   # beside it, or pass -DBRO_DIR=<path>

vcpkg install ffmpeg[avcodec,avformat,avfilter,swscale,x264,x265,nvcodec]:x64-windows

cmake -B build
cmake --build build --config Release
./build/Release/ffmpeg-bro
```

`x264`/`x265`/`nvcodec` are **encoders**, needed for export. Decoding — and so
playback — works with the plain `ffmpeg` port, because H.264/HEVC/AV1 decoders
are native to libavcodec.

## How preview works

There is no proxy transcode, no intermediate file, and no second encode. libavcodec
decodes in-process, frames go to the renderer, and audio goes to bro's live PCM
ring. What you see is the decoder's output at full quality.
