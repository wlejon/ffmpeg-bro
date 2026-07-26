# ffmpeg-bro

A comprehensive, friendly UI on top of ffmpeg, built as a [bro](https://github.com/wlejon/bro) app.

ffmpeg is extraordinarily capable and extraordinarily hard to drive. This is a real
GUI over it: probe a file, see what is actually in it, preview it *without a proxy
transcode*, build an operation visually, watch progress, and get the exact command
line it ran.

## Licensing

**This application is GPL-3.0-or-later** (see [LICENSE](LICENSE)).

That is deliberate, and it is why this lives in its own repository:

- **bro and its ecosystem are MIT.** ffmpeg never enters them. This app links
  nothing into bro; it drives the `ffmpeg` and `ffprobe` *executables* over pipes.
- **ffmpeg builds worth using are GPL.** x264, x265, and the rest of the good
  encoders are GPL, so a build that can actually do the work is GPL. Rather than
  restrict the app to an LGPL subset, this repo takes the license ffmpeg's best
  feature set requires and gives you everything.

So: bro stays MIT and ffmpeg-free, this app is GPL and uses all of ffmpeg.

## Setup

Two things, in this order.

1. **bro** — build it (see the bro repo's `BUILDING.md`), or use a release binary.
2. **ffmpeg** — any recent full build with `ffmpeg` and `ffprobe`. Either:
   - put them on `PATH` (`winget install Gyan.FFmpeg`, `brew install ffmpeg`,
     `apt install ffmpeg`), or
   - drop the executables in `bin/` next to this README.

   The app finds them either way, and tells you what it found.

Then run it:

```
bro /path/to/ffmpeg-bro
```

## Requirements

- bro (any profile; the `app` default is plenty). Hardware-accelerated encode and
  the ML features come from ffmpeg and from bro's optional AI tower respectively —
  neither is needed to play or convert.
- ffmpeg 6.0 or newer. 8.x is what this is developed against.

## How preview works

There is no proxy transcode and no intermediate file. ffmpeg decodes to raw RGBA
straight down a pipe (`-f rawvideo -pix_fmt rgba pipe:1`), the app uploads those
frames to a texture, and a second ffmpeg feeds raw float PCM into bro's live audio
stream. What you see is what ffmpeg decoded, at full quality, with no second
encode anywhere in the path.
