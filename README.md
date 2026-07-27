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

// An input is an `-i`: a path or a URL, a demuxer, that demuxer's options and
// the part of the file you want. Everything here appears *before* the `-i` on
// a command line, which is not trivia about argument order — these are the
// decisions taken while the file is being opened, and none of them can be
// taken afterwards.
bro.ffmpeg.probe(path)               // in-process ffprobe: throws if it can't be read
bro.ffmpeg.probe(path, { format, options })
bro.ffmpeg.probe({ path, format, options, ss, t, to, itsoffset, streamLoop })
// `format` forces the demuxer (`-f`), `options` are its own and the
// protocol's (`probesize`, `analyzeduration`, `fflags`, `rw_timeout`…), and
// **an unknown key throws** rather than being ignored — libavformat hands back
// what nothing consumed, which is the one place it will say whether an option
// was used. The window is reported as the window: probing with `ss: 1, to: 3`
// gives a two-second file, because that is what the input is.
//
// `streamLoop` is `-stream_loop`: how many *more* times to read the input
// after the first, -1 for forever. It is the one field here libavformat has
// never heard of — everything an image sequence or a still needs
// (`framerate`, `start_number`, `pattern_type`, `loop`) is an option of the
// `image2` demuxer and goes in `options`, unchanged from what a command line
// would say.
//
// **A duration is reported and never invented.** A finite `-stream_loop` is
// the file over again a known number of times, so it is measured. `-loop 1`
// and `-stream_loop -1` never end: libavformat reports one pass — for a still,
// one frame — so `-t` is the whole of how long they are, and with no `-t` the
// duration comes back **zero**, meaning nobody knows.
// → { path, format: {name, longName, duration, bitRate, size},
//     streams: [{index, kind, codec, codecLong, profile, bitRate, language,
//                title, default,
//                duration,
//                // video: width, height, displayWidth, displayHeight, fps,
//                //        pixFmt, sampleAspect, rotation,
//                //        colorSpace, colorRange, colorPrimaries, colorTransfer
//                //        — verbatim, and empty when the file says nothing.
//                //        "Untagged" and "BT.601" are different facts; only
//                //        the point of use is entitled to turn one into the
//                //        other, and it does it by frame height.
//                // audio: sampleRate, channels, channelLayout, sampleFmt
//               }, ...],
//     video, audio }          // shortcuts to the first of each
```

```js
// What this build can write — asked of libavcodec, not hardcoded.
bro.ffmpeg.encoders       // [{ id: "libx264", label, longName,
                          //    crf, preset, qp, tune,          // booleans
                          //    hardware, intraOnly, lossless, alwaysLossless,
                          //    crfMin, crfMax, crfDefault,
                          //    pixelFormats, presets, tunes, profiles,
                          //    containers }, ...]
bro.ffmpeg.audioEncoders  // [{ id: "aac", label, sampleRates, channelCounts,
                          //    lossless, containers }, ...]

// Every muxer this build links — a hundred and eighty of them — by the name
// `-f` takes. `containers` was four of these written down in C++, and MPEG-TS,
// MXF, AVI, FLV, GIF, image2, WAV and ADTS were compiled in and unreachable
// because of it.
bro.ffmpeg.muxers
// → [{ name: "matroska", label, longName, ext: "mkv", extensions: ["mkv"],
//      mimeType, videoCodec, audioCodec,        // encoders to default to
//      defaultVideo, defaultAudio, defaultSubtitle,   // what the muxer asks for
//      noFile, globalHeader, noTimestamps, stills, device,
//      videoCodecs, audioCodecs, answersCodecs }, ...]

bro.ffmpeg.demuxers       // [{ name, longName, extensions, mimeType,
                          //    noFile, device }, ...]
bro.ffmpeg.decoders       // [{ name, longName, type, hardware, experimental }, ...]
bro.ffmpeg.protocols      // { input: ["file","https","srt",...], output: [...] }
bro.ffmpeg.devices        // [{ name: "gdigrab", longName, kind: "video",
                          //    direction: "input" }, ...]

// Option tables, one at a time. Same walk, four more kinds of thing: there are
// a hundred and eighty muxers and three hundred and fifty demuxers, and their
// option tables are the expensive part of describing any of them.
bro.ffmpeg.encoderOptions("libx265")
bro.ffmpeg.muxerOptions("mp4")        // movflags, and libavformat's generic ones
bro.ffmpeg.demuxerOptions("mp4")      // and -fflags, for the other end
bro.ffmpeg.decoderOptions("h264")     // -skip_frame, -skip_loop_filter, -thread_type
bro.ffmpeg.protocolOptions("srt")     // what a destination is configured with
// → [{ name: "crf", help, type: "double", unit, min, max, default, hasRange,
//      values: [{ name, help, value }, ...] }, ...]

// What one capture device can see right now. A function and not a list,
// because it is the one query here that talks to hardware — enumerating
// DirectShow asks every camera driver on the machine.
bro.ffmpeg.deviceSources("dshow")
// → { ok, error, sources: [{ name, description, mediaTypes }, ...] }
// `mediaTypes` is load-bearing: dshow returns the cameras and the sound cards
// in one list, and without it a capture UI has to guess which is which.
// A device with nothing to enumerate — gdigrab takes a rectangle, not a name —
// answers `ok: false` with a reason, because an empty list reads as a machine
// with no cameras in it.

// The fourccs a muxer will take for a codec — `-tag:v`. First is what it
// writes by itself. `hvc1` and `hev1` are the same HEVC bitstream and only
// the first plays on Apple hardware, so this is a decision somebody has to
// be able to take, and nobody types a fourcc they have not seen.
bro.ffmpeg.codecTags("mp4", "libx265")   // → ["hev1", "hvc1"]

// The encoder libavformat itself would reach for, given a muxer and a
// filename — `av_guess_codec`, which is what the `ffmpeg` CLI uses. It matters
// for one muxer: **`image2`'s extension names a codec, not a container**, so
// `.png` is PNG data and `.bmp` is BMP data through the same muxer, and
// leaving the encoder on image2's declared default lands every picture render
// on mjpeg whatever the file is called.
bro.ffmpeg.guessCodec("image2", "out%04d.png")   // → "png"

// Files that are one input. A drop of three hundred numbered PNGs is one `-i`,
// and working that out is the most-used path into image sequences.
bro.ffmpeg.sequences([path, folder, ...])
// → { sequences: [{ dir, pattern: "…/shot_%04d.png", prefix, suffix, first,
//                   digits, start, end, count, missing }],
//     singles: [path, ...] }
// The rules are refusals rather than cleverness: the number is the *last* run
// of digits in the name, a run of one file is a still, zero padding is
// meaningful and unpadded numbering is not (`plate1`…`plate12` is one `%d`), a
// gap is reported and never closed, folders are read one level deep and never
// crossed, and only files with an image extension take part. **The frame rate
// is deliberately absent**: three hundred pictures are three hundred pictures
// and nothing on disk says how long each is on screen, so `-framerate` is a
// decision and inventing one here would be making it quietly.

bro.ffmpeg.imageExtensions   // libavformat's own: the image2 muxer's list plus
                             // every `*_pipe` demuxer's name
bro.ffmpeg.globPatterns      // whether this build's image2 can do
                             // pattern_type=glob. The one capability here that
                             // cannot be enumerated — it is HAVE_GLOB at
                             // compile time, reported as ENOSYS from
                             // read_header and nowhere else — so it is asked
                             // once, by trying.

bro.ffmpeg.hasFramePattern("out%04d.png")        // → true
bro.ffmpeg.frameNames("out%04d.png", 1, 3)       // → the names image2 will write
// `av_get_frame_filename2`, the same function the muxer calls, so this is the
// answer rather than a second implementation of `%04d`.

bro.ffmpeg.concatList(listPath, [{ path, duration }, ...])   // → listPath
// An `ffconcat version 1.0` list for the concat *demuxer*. Each duration is
// written because without one the demuxer reports no length at all until
// something has read to the end of the last file.

// The inputs playback knows about. `<video src>` is only a string and the
// media backend is registered generically, so the string names the input and
// the backend swaps it for the URL and its options on the way into
// libavformat. That is also what lets a URL be a src at all: bro resolves
// anything not starting with `/` or `x:` against the document, so
// `https://…` would otherwise become a path under `ui/`.
bro.ffmpeg.inputs.define("in3", { path, format, options, ss, to, itsoffset })
// → "/@input/in3", to use as a <video src> or a bro.media path
bro.ffmpeg.inputs.forget("in3")
bro.ffmpeg.inputs.token("in3")

bro.ffmpeg.tempPath("candidate.mp4")   // somewhere to put a preview render

// Rendering the timeline. Runs on its own thread; poll it.
bro.ffmpeg.render.start({ path,
                          // The `-i`s, in the order they are numbered. A clip
                          // and a filter-graph input pad each name one by
                          // index; the demuxer, its options and the window
                          // are the input's, and a path cannot carry them.
                          inputs: [{ path, format, options,
                                     ss, t, to, itsoffset, streamLoop }],
                          // Which muxer, by name — `-f matroska`. Empty falls
                          // back to guessing from the extension. Named because
                          // that is what identifies one: nothing in
                          // libavformat is called "mkv", forty-seven muxers
                          // have no extension at all, and several share one.
                          format: "matroska",
                          width, height, fps, start, end,
                          videoCodec, audioCodec, audio, clips: [...],
                          pixelFormat, scaler, colorspace, colorRange,
                          faststart, title, sampleRate, channels,
                          // -key value pairs, applied with av_opt_set and
                          // AV_OPT_SEARCH_CHILDREN — the whole of ffmpeg's
                          // writing surface, not a subset with named fields.
                          videoOptions: { crf: 20, preset: "slow" },
                          audioOptions: { b: "192k" },
                          formatOptions: {},
                          metadata: { comment: "…" },   // the container's own
                          streams: [...], chapters: [...] })
bro.ffmpeg.render.poll()    // → { state, progress, frames, totalFrames,
                            //     elapsed, fps, bytes, path, stage, error, job }
bro.ffmpeg.render.cancel()

// What the render *said*. Given a cursor, poll also drains libav's log and
// every value a filter measured, and hands back the cursor to carry forward.
// Ask for nothing and you pay for nothing: a caller that only wants a
// progress bar gets the fields above and no arrays.
bro.ffmpeg.render.poll({ log: 0, meta: 0, max: 500 })
// → { …, log:  [{ seq, job, at, level, severity, source, text }],
//        meta: [{ seq, job, at, stream, key, value }],
//        cursor: { log, meta, logDropped, metaDropped } }
```

`job` numbers renders, and every record says which one it was said during —
0 for the ones said while nothing was rendering, which is where a failed
`probe()` and a decoder complaining during playback land. The capture is
installed at startup and never removed: a muxer finishing a file *after* the
job has published its terminal status is exactly the sort of thing worth
reading, and it happens in the window an uninstall would have to race. Reading
after the render is over is an ordinary read, because the rings belong to the
process rather than to the job.

`level` is libav's own — `error`, `warning`, `info` — and `source` is the
`AVClass` behind the message: `libx264`, `Parsed_cropdetect_0`, `mp4`. The
console keeps warnings and up so a log stays readable; the channel keeps
everything down to info, because the detail nobody wants while things are
working is the detail wanted afterwards.

`meta` is **frame metadata**, which is how a whole family of filters answers a
question: `cropdetect`, `blackdetect`, `silencedetect`, `ebur128`,
`signalstats`, `astats`, `psnr`, `ssim`, `libvmaf`, `freezedetect`, `scdet`.
The key is libavfilter's own, verbatim, and `at` is the timestamp of the frame
it came off — so a series is a named quantity sampled over the render rather
than more log lines.

Both are bounded rings that say how much they dropped, because a long render
with a measuring filter on it emits several values a frame. They are sized for
the gap between two polls, not for the whole series: keeping the series is the
consumer's job.

**`streams` is what the file is made of**, one entry per stream the muxer will
number, in that order. Leaving it out is not "no streams" — it means the file
this renderer has always written, one video stream fed from the composite and
one audio stream fed from the mix, synthesised out of the named fields above.
Given, it is authoritative:

```js
streams: [
  { kind: "video",                  // "video" | "audio" | "attachment"
    source: "composite",            // where the content comes from: "composite"
                                    // (the canvas) or "mix" (the whole
                                    // soundtrack). Composed, so named rather
                                    // than numbered — no input index means
                                    // "everything, stacked".
    codec: "libx265",               // empty asks the muxer for its default
    options: { crf: 22 },           // this stream's encoder options
    metadata: { title: "Programme" },
    language: "eng",                // ISO 639-2
    disposition: "+default+forced", // av_disposition_from_string, or "0"
    tag: "hvc1",                    // -tag:v, four characters
    // each of these takes the render's when it is absent
    crf, bitrate, preset, pixelFormat, sampleRate, channels },
  { kind: "audio", source: "mix", codec: "aac", language: "fra",
    disposition: "+comment" },
  { kind: "attachment", path: "…/font.ttf", mimeType: "font/ttf" },
]
chapters: [{ start: 0, end: 12.5, title: "Opening" }, ...]
```

A malformed entry is a `TypeError` naming it — `streams[2] is a 'subtitle'` —
never a stream quietly missing from the file. An unknown disposition, a fourcc
that is not four characters and an attachment that is not there all stop the
render rather than being dropped: the whole value of writing down what is in
the output is that the output is what was written down.

An attachment is a stream because that is what `-attach` produces — it has an
index and the muxer writes it out of the stream's extradata at header time.
A chapter is not: it is a table beside the streams with no index and nothing
mapped to it, so it travels in `chapters`.

`render.start` throws if a job is already running. It stops being one the
instant `poll()` reports a terminal state — the run slot is released before
the status is published, so chaining a second render off the first's `done` is
safe, which is what the preview does.

A clip in a render spec is an input, a slice of it, and a rectangle in the output
canvas — `{ input, start, length, inPoint, x, y, w, h, crop, opacity, volume,
muted, z }`. `input` indexes `inputs`; a clip carrying a `path` and no index is
that path opened plainly, which is what every spec written before inputs existed
means and still does. Rectangles rather than fit/zoom/pan modes on purpose: the layout
is worked out once, in `ui/viewer.js`, and both the screen and the encoder are
driven from the same answer.

`displayWidth`/`displayHeight` account for the rotation in the container's
display matrix — a phone video is 1920×1080 on disk and 1080×1920 on screen, and
only that side-datum says so.

A stream's `duration` is its own, not the container's. They differ: a recording
routinely stops the audio a fraction of a second after the last picture, so a
clip whose length came from the container would run past the end of its video.
Matroska keeps only one duration for the whole file, and then that is what every
stream reports.

## Sources

`I` (or the first card on the spine) is the **inputs** — the `-i`s. Not "the files on
the timeline": an input is a thing in its own right, it carries a demuxer and that
demuxer's options and a window, it can be a URL, and it exists whether or not
anything is cut from it. Adding one and using one are two acts, and `Use on the
timeline` is how the second happens.

Three columns, in the order the questions come.

**The list.** Every input, numbered the way `-i` numbers them, each saying where it
comes from, what has been set on it in ffmpeg's own words (`-f matroska -probesize
5000000 -ss 12`) and whether anything is cut from it. **Unused is a normal state and
says so** rather than being hidden or collected — opening a file to see what is in it
is a thing people do.

**The input.** What it is:

- **Path or URL.** Anything a protocol this build links can reach — `https`, `srt`,
  `rtmp`, `udp`, `tcp`, thirty-six of them — and the panel says which protocol a URL
  names and whether it is one of them, because a URL naming a protocol that is absent
  otherwise fails at open with a message about a filename.
- **Demuxer.** What it probed as, and a search over all three hundred and fifty to
  force another. Searched rather than listed for the reason the muxer picker and the
  filter palette are: there is no list of the good ones anywhere. `Probe it` hands the
  choice back to libavformat.
- **Window** — `-ss`, `-to`, `-itsoffset`, `-stream_loop`, named as ffmpeg names them
  because that is
  what they are and the command bar prints them a foot below. **An input seek is not a
  clip's in-point**, and this is where the difference is legible: `-ss` moves the
  input's zero, so the input becomes shorter and a clip is cut from what is left.
  Trimming a clip picks a moment out of an input; `-ss` decides what the input is.
  `-itsoffset` delays it, which is how a camera and a separately recorded soundtrack
  are lined up. `-stream_loop` is the other half of the same question — how much of
  this input there is — and `-1` is forever, which has no length at all.
- **What came back** — container, duration, size, bitrate, and then every stream:
  codec, profile, dimensions, frame rate, pixel format, colour tags, sample rate,
  channel layout. Straight out of `probe()`, run **with the options in force**, so it
  is the answer to "what did the thing I just set do" rather than a description of the
  file as libavformat's defaults see it.

**The options.** The demuxer's own table, out of its `AVClass` and libavformat's
generic one, in the column the encoder's advanced options and the muxer's already use
— and the protocol's beside it when the path is a URL, since libavformat passes what
the demuxer does not recognise down to the AVIO layer and they travel in one bag.
An unknown key stops the open and names itself.

Two clips from one file are one input, which is what ffmpeg would open. A second drop
of the same file reuses it — unless something has been set on it, in which case a
fresh one is made rather than silently inheriting somebody's decision.

### An input that is not one file

Three of ffmpeg's inputs are not a file, and each is *assembled* rather than opened.
Every one of them is set with ordinary demuxer options — `-framerate`,
`-start_number`, `-pattern_type` and `-loop` belong to `image2`, `safe` belongs to
`concat` — so they travel in the same bag `-probesize` does and are printed in front
of the same `-i`. They get rows of their own for what they *mean*, not for what they
are.

**An image sequence.** Drop a folder of numbered frames, or the frames themselves, and
they arrive as one input rather than three hundred. Working out which files belong
together is the part that has to be right, so the grouping is a set of refusals:

| | |
|---|---|
| the number is the **last** run of digits | `shot2_0007.png` is frame 7 of `shot2_`, not frame 2 of `shot` |
| a run of one file is not a sequence | it is a still, which is a different input with a different question on it |
| zero padding is meaningful, unpadded numbering is not | `007` and `0007` are two runs; `plate1`…`plate12` is one, written `%d` |
| a gap is reported, never closed | `image2` stops at the first missing number, so a run of 300 with 12 absent is not 300 frames |
| folders are read one level deep and never crossed | two levels of folder is a project layout, not a sequence |
| only image extensions take part | and they are libavformat's own, not a list written down here |

So a logo sitting beside three hundred frames stays a file of its own, and a folder
holding two sequences is two inputs.

**A sequence has no frame rate.** Twelve pictures are twelve pictures; nothing on disk
says how long each is on screen. `-framerate` is what decides, it is an *input option*,
and the same files are one second or two depending only on it. `-start_number` is set
out loud too, because `image2` looks for the first five numbers from zero and then
gives up — a run beginning at 1000 is unopenable without it, and one beginning at 1
opens only by accident.

`-pattern_type glob` is offered where the build has it. This one does not: globbing is
a compile-time feature of libavformat, reported as "Function not implemented" from
`read_header` and from nowhere else, so it is asked by trying and the control says so
rather than failing at open.

**A still is a decision about how long it is.** A single picture is no time at all —
libavformat says so, and bro's `<video>` agrees, because it drives its clock from
decoded pictures and one picture is nothing to advance through. So a still is opened
as `-loop 1` with a `-t`: the loop makes the input go on producing the same picture,
and the `-t` is the only thing that can say how long it lasts. Five seconds to begin
with, on the input, in ffmpeg's own words, where the command bar prints it and the
Sources stage changes it. Take the loop away and the input has no length; the
application says so and will not lay it out, rather than putting a clip of nothing on
the timeline.

**Several files as one input.** `Join…` writes a list file and adds it as
`-f concat -safe 0`. **Three things here are called concat and they are not each
other**, so the panel says which this is before it offers to do it:

| | |
|---|---|
| the concat **demuxer** | reads the listed files one after another *before* anything is decoded — they have to be encoded compatibly |
| the concat **filter** | joins decoded streams inside the graph, and does not care what they were |
| two clips **end to end** on the timeline | is neither: that is an edit, and it renders through the compositor |

Each entry in the list carries its own duration. Without them the demuxer opens the
first file at header time, discovers the rest as it reaches them, and reports no
length at all — so the joined input would lay out as no clip.

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

## The graph

`N` opens the Graph stage, which is the edit drawn as the filtergraph that
performs it. Every trim, every scale, every overlay, named the way ffmpeg names
them, wired the way ffmpeg wires them — and the same chains the command bar
prints along the bottom, laid out so they can be read.

It is **derived from the timeline and rebuilt whenever the timeline moves**.
Nothing on this screen invents a graph; it asks for one on every change and
draws the answer, which is what makes it a picture of the edit as it is now
rather than a copy of the edit as it was.

### Getting around it

It works the way a node editor works. Nothing here is invented — Blender, Nuke,
Houdini, Unreal and n8n all agree on this much, and knowing one of them should
be enough to use this.

| | |
|---|---|
| drag the background | select what the band covers |
| middle-drag | pan, from anywhere including over a node |
| wheel | zoom about the pointer |
| drag a node's title bar | place it — and everything else selected with it |
| click a value on a card | change it |
| hover a wire | its `+` |
| `Fit`, or `0` | frame the whole graph |
| the percentage | back to 1:1 |
| `Re-layout` | give every node back to the layout |
| `Esc` | clear the selection, then leave the stage |

Nodes carry a socket for every port, and wires land on them — which matters most
at `overlay`, whose two inputs are the canvas and the clip and are not
interchangeable. **Where you put a node is remembered**, against the node rather
than against a position, so it survives the graph being rebuilt by the next
timeline edit; a placed node does not move for anything except you and
`Re-layout`. Zoomed out far enough that the values stop being readable the cards
become their names and their pictures, and the minimap in the corner is where
you are.

### Putting a filter in it

Hover a wire that can take one and it offers a `+`. Click it and pick a filter out of
**libavfilter's own list** — five hundred of them in this build, searchable by
name and by what libavfilter says each one does; there is no list of supported
filters written down anywhere in this application. The filter appears on the
wire, selected, with its whole option table beside it, read out of the filter's
own `AVClass` exactly as the encoder's advanced column is read out of an
encoder's.

What is *set* is on the card and can be typed there; what the filter *has* is in
the column, because `scale` has thirty options and a card with thirty rows is not
a card. Typing on either locks the node — see below.

There are five places a filter can go, and they are five different pictures:

| Point | What is on the wire there |
|---|---|
| after decode | the source at its own size, format and colour |
| after scale | the clip as it will be composited — RGBA, at the size it occupies |
| after compositing | the whole canvas, before the encoder's colour |
| clip audio | one clip's sound, before it is trimmed and placed |
| after mixing | the whole soundtrack |

Two filters at one point run in the order you added them.

There is deliberately **no point after the output colour conversion**. That
conversion is the one chain that exists in the printed command and not in the
graph this binary runs — the writer does it here — so a filter placed there
would sit in the encoder's colour in the command you copied and in RGBA in the
render you got. One insert point producing two pictures is worse than one fewer
insert point.

### Seeing what each node produces

A node card says what a filter is *set to*. What it does not say is what comes out
of it, which is the thing you actually want — `crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25`
is a claim about a picture, and a claim about a picture is either right or it is a
bug you find at the end of a render.

So every node on the picture side plays its own output, looping. **Drag the corner
of a card** to make it as big as helps, and the media fills it — and re-renders at
the new size, so a bigger card is a sharper picture rather than a stretched one.
The size is remembered per node.

These are real renders, not simulations: the graph is cut off at the chosen node,
ended with a scale that fits the card, and run through the same libavfilter path
an export takes. What a card shows is what that pad hands its consumer. The rules
that make it affordable are worth knowing, because they are what you will notice:

- **One at a time, and always behind an export.** There is one render slot. A node
  preview is the least important thing in the application and waits for everything
  else, so a nine-node graph fills in over a second or two rather than at once.
- **Nothing renders until the graph holds still.** Dragging a value walks through
  fifty of them; only the one you stop on is rendered.
- **Only what the node depends on.** Previewing the first filter of a two-clip edit
  opens one file, not two — and each input seeks to its own window, so a node on a
  clip forty minutes in costs the same as one at the top.
- **Taken from where the playhead was** when you opened the stage, not followed
  live. `At playhead` re-takes it; `Previews` turns the whole thing off.

`video out` gets one too — it is the pad the muxer maps, which makes it the one node
on the screen that means *the render*. Audio nodes have no picture, and show none
rather than a black rectangle.

### Playing a node

A couple of seconds on a loop answers "is the crop right". It does not answer "does
this hold up over a shot", which is usually what a filter is being judged on. **The
▶ in the corner of a picture** plays that node forward, from where the previews were
taken to the end of what would be written.

Every second of it is a real render, which is the whole point and also the
constraint: an expensive graph cannot be played at speed. So the range is rendered
in pieces, ahead of the picture, and each piece plays at its own rate. When the
renderer keeps up, that is real time. When it does not, the picture waits for the
next piece and the readout says what rate is actually being sustained — `0.42×`,
waits included. That number is a fact about your filter, and it is the reason
nothing here quietly drops frames instead: a smooth picture that had skipped nine
frames in ten would make a slow filter look fast.

Pressing play starts on the frame already in the card, because the still is the
first piece. One node plays at a time — there is one render slot, and two would not
be two playbacks so much as two stutters.

### Locks

Every value on a derived node can be typed into, and **typing into one locks
that node**. The skeleton around it still regenerates: move the clip, trim it,
crop it, and everything except the thing you set follows. A value you typed
that the next drag silently reverted is worse than the edit not applying,
because at least the second one is visible.

So every place that could disagree says which one won. The node is badged, the
Graph card on the spine counts the locks, the panel beside the graph says what
the lock outranks, and **the control it took over is marked in the properties
panel** — faded, with a dot, and a tooltip naming the node to unlock. `Unlock`
hands it back to the derivation.

A filter you insert and a value you lock are pinned to a **named point**
(`clip:7/after-scale`), never to a position, so they survive the rebuild. They
survive moving and trimming the clip; splitting a clip copies them to both
halves, because a cut should not change how either half looks; deleting a clip
takes them with it. They are remembered in `localStorage` between runs — there
is no project file yet, and this is the first thing that makes one worth having.

### What changes when there is one

A render with a filter of your own in it goes through **libavfilter** instead of
the internal compositor, and nothing has to be switched on for that: the spec
the application builds carries the graph, and `ffmpeg_export.cpp` picks its
`FrameSource` on whether that field is empty. The two paths are measured against
each other on every `ctest` run — the same edit rendered both ways, compared as
PSNR, 43 dB and holding — so this is a choice about what is *expressible*, not
about which is better.

Two consequences worth knowing. The command bar stops calling its filtergraph a
translation, because on this path it is not one: those are the chains
libavfilter parses, all but the last. And **the viewer cannot show you a
filter** — playback is the engine decoding the file straight into a `<video>`,
with no filter path anywhere in it. Clips carrying filters are marked `fx` in
the picture rather than left looking as though the filter did nothing; the
export preview is where you see what it does.

## Output

`Encode` and `Write` are two of the five stages on the spine — the row under
the title bar that *is* the pipeline: **Sources → Compose → Graph → Encode →
Write**. Each card says what its stage is currently set to, so the bar reads as
one statement of the whole render, and clicking the part that is wrong is how
you go and change it. `E` goes to Encode, `[` and `]` step along the chain,
`Esc` comes back to the edit.

Choosing an encoder setting means looking at what it does to the picture, and
the comparison that shows you is the whole point of the Encode stage, so it
gets the middle of the window: settings down the left, every option the encoder
has down the right when you want them, the range across the bottom. Where the
file goes is the *next* stage, because it is a different decision taken at a
different moment — you settle what the picture is by looking at it, and then
you say where to put it.

Everything the viewer is showing is what gets written: the track stack
composited bottom-up, each clip in the rectangle its fit, scale, position and
crop put it in, at its opacity, and the grid if the grid is on. The placement
rectangles the renderer works from are the ones `ui/viewer.js` computes, so
there is no second layout implementation to drift away from what you were just
looking at.

The encoders are the reason this repo is GPL, and they are all here:

| | |
|---|---|
| Video | x264, x265, AV1 (SVT / libaom), VP9, ProRes, MJPEG, MPEG-4 — plus NVENC, AMF and QSV when the build has them, and every muxer's own default encoder |
| Audio | AAC, Opus, MP3, Vorbis, FLAC, PCM |
| Containers | **every muxer this build links** — 182 of them |

The menu is built by asking libavcodec what this binary actually has rather
than from a list, so it cannot offer an encoder that then fails at the last
step. The same goes for what each encoder can do: its pixel formats, presets,
tunes, profiles and the range of its quality scale are read out of libavcodec's
own option tables, so the controls change with the encoder — x264 gets a CRF
slider from 0 to 51 and ten presets, VP9's goes to 63, ProRes gets its six
profiles and no quality slider at all, and NVENC gets `p1`–`p7`. Which
containers will hold a codec comes from `avformat_query_codec` rather than from
a table, so picking WebM narrows the codec list to the two that are legal in it.

**Start from** is the top row: six named starting points — web, small, HEVC,
ProRes master, GPU, lossless — each filtered against what this build has, so
the NVIDIA one is absent on a machine without one. Most renders are one of
these, and the twenty controls below are for the render that is not.

**Rate control** is offered as the modes the encoder actually has: constant
quality, a bitrate target, a capped average for streaming (`-maxrate` and
`-bufsize`), and lossless. NVENC has no CRF, so its quality mode is `-cq` with
the bitrate target taken out of the way; x264's lossless is `-crf 0`; VP9's is
`-lossless 1`. That mapping lives in one function, so the summary line, the
preview and the export cannot describe three different renders.

**Every option the encoder has** is available under Advanced. The list is
`av_opt_next` over the encoder's `AVClass` — name, type, range, default, help
text and named values, straight out of libavcodec — with a search box over it.
x264 reports 48 options here, x265 many more. Nothing about them is written
down in this repo, so an ffmpeg upgrade that adds an option adds it to the app.

This works because there is no private path from the controls to the encoder:
a Quality slider produces `{crf: 20}`, the raw editor produces `{crf: 20}`, and
both are applied with `av_opt_set(ctx, key, value, AV_OPT_SEARCH_CHILDREN)` —
exactly how the `ffmpeg` command line applies its own arguments. Anything
documented for `ffmpeg -c:v libx265 -x265-params …` works here unchanged. The
summary at the bottom shows the result as a command line, because that is the
shortest complete statement of what is about to happen. An option the encoder
does not have is an error, not a shrug: a render that succeeds while silently
ignoring half of what it was told is the worst of the three outcomes.

### Which container

The format control was four entries — MP4, Matroska, QuickTime, WebM — written
down in C++ beside a codec list that was genuinely asked of libavcodec. MPEG-TS,
MXF, AVI, FLV, GIF, image2, WAV, ADTS and a hundred and seventy others were
compiled into this binary and unreachable because of that one line. They are all
here now, and the picker is the shape the filter palette already uses, because
it is the same problem one stage later: **there is no list of the good ones
anywhere.**

A muxer is chosen **by name**, which is what `-f matroska` means and the only
thing that identifies one: nothing in libavformat is called "mkv", forty-seven
muxers have no extension at all, and several share one. The extension is a
consequence — what the file gets called — and it follows the choice.

What you can group a hundred and eighty by, all of it asked rather than decided:

| | |
|---|---|
| **Fits** | `avformat_query_codec` says it will hold the codecs this render is set to |
| **Files** | it has an extension and writes a file it opens itself |
| **Pictures** | an intra-only video codec and no audio codec at all — image2, gif, the single-frame writers |
| **Streaming** | `AVFMT_NOFILE`: it writes through a protocol rather than to a file |
| **Devices** | libavdevice's own, which only exist once `avdevice_register_all()` has run |

and a search over the name, libavformat's own description and the extensions —
so "mkv" finds Matroska even though nothing is called that.

**`avformat_query_codec` has three answers and only two of them are yes and
no.** A muxer with neither a `query_codec` function nor a codec tag table
returns `AVERROR_PATCHWELCOME`, which means *not taught to answer*. Over four
well-known containers that never came up; over a hundred and eighty it does —
MPEG-TS is one, and reading its shrug as a refusal is how a picker comes to
insist that MPEG-TS will not hold H.264. So it is carried through as itself:
nothing is filtered where it applies, the codec in hand is left alone, and the
row says *does not say*. A muxer that genuinely answers no still narrows the
codec lists, and the codecs it refuses are shown marked rather than hidden —
hiding them hides the reason the one you wanted is missing.

Beside the picker, **every option the muxer has**, in a column, exactly as the
encoder's are: `movflags`, `hls_time`, `mpegts_service_id`, plus libavformat's
generic ones, walked out of the muxer's own `AVClass`. They reach it through
the same `av_opt_set`-with-children route ffmpeg's own arguments take, and an
unknown key stops the render rather than being ignored. Changing the muxer
empties the bag, because `movflags` in Matroska is an error and not a carried
preference.

### Writing pictures

`image2` is the one muxer whose output is not a file but a *set* of them, and the only
thing that says which is which is the filename: `out%04d.png` is a run of pictures and
`out.png` is one picture written over itself on every frame. So picking image2 puts a
frame number in the name, and **Numbering** says which of the two you meant —
`A file per frame`, or `One picture`, which is `-update 1` and is not optional for a
single file.

Under it, **the names that will actually be on disk**. Not the pattern: `%04d` is
exactly the kind of thing somebody gets wrong once and then never trusts again, so the
panel shows the first few and the last, from `av_get_frame_filename2` — the same
function the muxer calls. `-start_number` is beside them, since a run does not have to
begin at one.

One PNG of the frame at the playhead is the degenerate case and is the fastest way to
get a still out of an edit: `One picture`, and a range of one frame.

**Here alone, the extension chooses the encoder.** `.png` is PNG data and `.bmp` is BMP
data through the same muxer, so image2's extension names a *codec* rather than a
container — the opposite of how every other extension in libavformat works. The
encoder follows the filename through `av_guess_codec`, which is what `ffmpeg` itself
does; without it every picture render lands on mjpeg, which is what image2 declares as
its default whatever the file is called.

### What is in the file

`Write` is the output's **stream list**: one row per stream the muxer will
number, in the order it will number them. A file is not a picture and a
soundtrack — it is a list of streams — and everything this application could
not say before followed from that list not existing.

A row reads as a statement rather than as a grid of labelled inputs:

> **A2** the mix, through `aac` — *fra · “Commentary” · forced · comment*

The usual two — the composite through one video encoder, the mix through one
audio encoder — arrive without anyone asking, because that is what nearly
every render is. `+ Video`, `+ Audio` and `+ Attachment` add one; `×` takes one
away, including the last video stream, which is what a sound-only render is.
Everything a row does not say it takes from the Encode stage, so a second audio
track is one click and not twenty controls.

Open a row and it says what the stream carries:

- **Language** — ISO 639-2, the one metadata key every player reads.
- **Name** — what a track menu shows.
- **Flags** — a toggle per disposition, and the list is libavformat's own:
  `default`, `forced`, `comment`, `hearing_impaired` and the rest, walked out
  of `av_disposition_to_string`. Several at once, because a track can be forced
  *and* a commentary.
- **Tag** — the fourcc, offered as the vocabulary the chosen muxer actually
  takes. `hvc1` and `hev1` are the same HEVC bitstream and only the first plays
  on Apple hardware, which is a decision worth being able to take and not a
  string anybody types from memory. A tag the container has never heard of is
  called out here rather than at `write_header`, where it arrives as "Invalid
  data found when processing input" with no mention of the tag.
- **Metadata** — anything else, as key and value.

**An attachment is a row and a chapter is not**, and that is the shape of the
things rather than a layout choice. An attachment *is* a stream: it has an
index, it is what `-attach` produces, and the muxer writes it out of the stream
at header time — a font travelling beside a subtitle, a cover image. A chapter
has no index, nothing is mapped to it and no player shows it in a track menu;
it is a table beside the streams, so it is drawn beside them.

The preview is not part of this. Both halves of the A/B comparison, and every
node preview on the Graph stage, ask for the renderer's own default of one
video stream and one audio stream: they exist to show what something does to a
*picture*, and a second language track proves nothing about a wipe.

### The command

Under every stage, live, is the invocation. Not a summary line at the bottom of
one screen — the whole argument of this application is that ffmpeg should stop
being a thing you guess at, and that argument is made by never hiding what is
about to run. Open it and it lays the filtergraph out a chain per line; `Copy`
puts the whole thing on the clipboard, so a render built here can be taken to a
server and run.

It is **two kinds of statement and it is drawn as two**, because they are not
equally true:

- **Exact** — everything but the filtergraph. Those keys are literally what
  `av_opt_set` is called with, which is the same path the `ffmpeg` command line
  uses for its own arguments. Not a description of the render; the render.
- **Equivalent** — the composition. With nothing of your own on the graph this
  binary composites internally rather than building a filter graph, so the
  graph shown is a translation, and it is dimmed to say so.

Put a filter on the graph and the second line changes, because the claim
changes: the render goes through libavfilter and those are the chains it
parses. All but the last, which converts into the encoder's colour and is the
writer's job here.

Everything the stream list produces is printed: a `-map` per stream,
`-c:a:1`, `-metadata:s:a:1 language=fra`, `-disposition:a:1 +forced+comment`,
`-tag:v hvc1`, `-attach`. The index appears only when it has to — `-c:v` for
the file that is a picture and a soundtrack, `-c:a:0` and `-c:a:1` once there
are two, because unqualified the second would claim both. One thing on this
stage genuinely cannot be said as an argument: ffmpeg reads **chapters** from
an input rather than from an option, so a command that wrote them would need an
FFMETADATA file and a second `-i`. That is said out loud under the command
instead of being quietly dropped.

How good a translation was measured rather than asserted: render the same edit
both ways and compare. Naming every colour conversion is the difference between
24.1 dB and 39.1 dB — a visible cast, not rounding — which is why `probe()`
reports each source's colour tags and why they are threaded into the graph. One
difference cannot be closed at all: the renderer walks forward at a fixed output
rate and `overlay`'s frame sync picks by timestamp, so a 30 fps source in a
25 fps render gives the two different frames to composite. That is said out
loud, under the command, when it applies.

An edit the graph cannot express faithfully produces **no graph and a reason**
rather than an approximation. A command that is nearly right is worse than no
command, because the only reason to print one is that it can be run.

### What the render said

Under the command bar, and under every stage with it, is its counterpart: one
says what is about to run and the other says what came back. Collapsed it is a
line — *"The last render: 1 warning · 9 series · 207 samples"* — and `R` opens
it from anywhere.

Because until it existed, a render could tell you four things: how far along it
was, how fast, how big, and — only if it failed outright — one sentence. libav
had plenty more to say. An encoder that clamped a bitrate, a muxer that refused
a fourcc, a filter unhappy with its arguments: all of it went to a console
nobody sees, and a render that came out wrong left nothing to look at.

Two kinds of thing, because they are not the same kind of fact:

- **Messages**, levelled and attributed. `libx264` announcing the profile it
  settled on is a different statement from `mp4` refusing a tag, and the source
  is a column rather than a prefix so you can see at a glance which part of the
  pipeline is talking. Filtered to warnings and errors by default: a render
  that went fine says so in one line and takes up one line. `Everything` is the
  whole of what libav said, kept rather than discarded, for the render where
  the info line turns out to be the answer.
- **Measured**, which is what a filter found. `cropdetect`, `blackdetect`,
  `silencedetect`, `ebur128`, `signalstats`, `astats`, `psnr`, `ssim` and the
  rest of that family produce information rather than pictures, and libavfilter
  hands it over by hanging it on the frames. So a value is not a log line, it
  is a *series*: a named quantity sampled at the timestamps of the frames it
  came off, drawn as the line it is. Put one of those filters on the graph and
  what it measures appears here, frame by frame, while the render runs.

Nothing is cleared when a render ends. The messages matter most once it is
over, which is why they outlive the job — and why the Write stage's progress
panel, under a green bar, says how many warnings there were and takes you
straight to them. A file that is not what was asked for, reported as a success,
is the failure this whole channel is against.

### Preview

The hard part of encoding is not finding the settings, it is knowing what they
cost. `Render preview` encodes a few seconds — 1 to 10, from wherever you were
looking — at the exact settings, *and* the same frames losslessly, and lays one
over the other with a wipe you can drag. The lossless one is what the
compositor produced before any encoder saw it, so the difference on screen is
what the settings cost and nothing else.

Underneath it: what those seconds weighed, the bitrate they came to, and the
size the whole render extrapolates to — which is the number the summary then
quotes, because a measurement beats an estimate. Also how fast it encoded, and
therefore how long the whole thing will take.

It plays, and the two halves run together to the frame — banding crawls and
grass smears, and neither shows on a still. `Space` starts and stops it, the
arrows step a frame at a time, and the scrub bar under the picture goes
anywhere in it; both sides are seeked to exactly the same frame, because a wipe
between two moments a fraction of a second apart shows the movement between
them rather than what the encoder did. The timecode is the **timeline's**, not
the little preview file's, and a marker runs along the range strip below — so
the frame you are looking at is one you can go back and find on the edit.

Changing the quality re-renders only the candidate; the reference is of the
same frames and does not move. Changing the size or the edit invalidates both.
Both files go to a temp directory and are overwritten each time — the lossless
one is large, on the order of 15 MB per second at 720p.

**Range** is the strip across the bottom: the whole edit with a ruler over it
and one bar per track, the part being written picked out. Drag its ends to
write part of the timeline, and drag the lane beneath to move where the preview
samples from.

**Sound** is mixed, not picked from: every clip under the playhead contributes,
at its own level and mute, summed and clamped. A clip's in-point is honoured to
the sample — a seek lands on a packet boundary at or before the target, and
what is between the two is dropped rather than played.

**Colour** is converted rather than reinterpreted. Sources are decoded through
their own matrix (BT.709, BT.601, BT.2020 — whatever the file says, or what its
size implies when it says nothing), and the output is tagged to match what was
actually written, so the result does not come back a little green.

The render runs on its own thread: the UI keeps drawing, the progress bar has a
frame count, an encode rate and an estimate, and `Stop` stops it. A stopped
render still closes its file properly — a half-written MP4 with no index plays
nowhere, so the part that was rendered is left playable. When it finishes, one
button puts the result back on the timeline, which is the fastest way to see
what you just made.

Rotation is applied here: a phone clip that was shot upright is written
upright, from the container's display matrix.

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
| `I` | the Sources stage — what is actually in the files |
| `R` | what the render said — messages and what filters measured |
| `N` | the Graph stage — the edit as a filtergraph (`0` fits it) |
| `[` `]` | one step back / forward along the pipeline |
| `Space` `←` `→` | on the Encode stage: play / pause and step the comparison |
| `Ctrl`+`A` | select every clip (`Esc` narrows back to one) |
| `Delete` | remove the selection |

## Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own media — two files with known content, a moving bar over a
gradient and a tone at a known level, differing in size, aspect, frame rate and length —
and runs every suite against them. Nothing is checked in and nothing depends on what a
file you happened to have lying around contains.

Each suite also runs standalone against any real file, which is how to check behaviour
against footage the fixtures do not resemble:

```
./build/Release/ffmpeg-bro-decodetest <file>          # backend: demux, decode, seek, audio
./build/Release/ffmpeg-bro-exporttest <file> [<file2>] # renderer: geometry, opacity, mix, cancel
./build/Release/ffmpeg-bro-captest <file>            # muxers, demuxers, protocols, devices, decoders
./build/Release/ffmpeg-bro-inputtest <file>          # an -i: forced demuxer, options, window, token
./build/Release/ffmpeg-bro-seqtest <fixture-dir>    # sequences, stills, -stream_loop, concat, image output
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sources.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sequence.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_report.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js   # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js         # needs no media
```

`ui_player.js` drops real files on the real UI, plays them, scrubs, steps to the
last picture in the file, zooms the timeline, moves and deletes a clip, scales
and crops the picture, works the controls, and screenshots the viewer into
`out/`. Pass a second file to exercise the multi-clip transport. It also checks
the control strip's geometry — that every icon button drew its icon, that the
transport buttons are one width, that the transport is on the window's centre
line and the zoom controls on the timeline's left edge — because a mistyped
icon name or a stray width breaks none of the behaviour and all of the look.

`captest` is what this build can write, read, reach and capture, and it prints
as much as it asserts: how many muxers, which of them write pictures, which
protocols are in and out, what capture devices the machine has. The numbers
are printed rather than demanded, because how many muxers a build has depends
on how it was configured; what is asserted is the *shape* — that a muxer's
extensions are split rather than handed over as one string, that the name a
picker puts in `-f` is the name libavformat answers to, that an option table is
the muxer's own and not the last one asked for — and then it renders into
Matroska and MPEG-TS by name and opens what came out, because a picker over a
hundred and eighty is only worth having if what it offers can be written.

`inputtest` is what an `-i` is: a demuxer forced and a name this build does not
have refused, an option reaching the demuxer and an unknown one stopping the open
with the key named, `-ss` and `-t` moving the input's own clock — checked in
pixels, by asking a seeked reader for its zero and an unseeked one for the same
moment — and the token bro's media backend opens a registered input by.

`seqtest` is the inputs whose content is assembled, and most of what it asserts
is what the grouping *refuses*: a lone numbered file is a still, a folder of two
runs and a stray picture is two sequences, and an unpadded run crossing from one
digit to two is one input rather than two. Then that a sequence's length is its
`-framerate` and nothing else, that a still probes as no time at all and is as
long as its `-t` and no longer, that `-stream_loop 1` is twice through and then
the end, that a concat list with no durations in it reports none — and the round
trip, since what the writer means by a sequence and what the reader means by one
have to be the same thing or every half of this works alone and none of it works
together.

`ui_sequence.js` is the same subject from the drop inwards: twelve files becoming
one `-i` with its options printed in front of it, a still that plays because it
is held and is refused when it is not, a sequence played through the same
`<video>` everything else uses, and the Write stage listing the filenames a run
will be written as before anything is rendered.

`ui_sources.js` follows one input the length of the stage: typed in as a path
with no clip near it, forced to a demuxer picked out of libavformat's own list,
given `-probesize` out of the option column, cut to a two-second window, used on
the timeline, and then found in the spec with the clip pointing at it by index —
and every one of those printed by the command bar **in front of** its `-i`,
because the same words after it are output options meaning something else. It
also adds a URL, to check that it survives as written rather than being resolved
against the document, that the protocol is named, and that its own option table
is offered.

`ui_filtergraph.js` needs no media at all: `buildSpec()`'s output is a plain object and
the translation into a filter graph is a pure function of it, so the graph is checked
against specs written out by hand — including the edits it must refuse rather than
approximate.

`ui_graph.js` needs none either, and watches the graph from inside rather than
through the string it prints: the model, the printer's chain rule on shapes the
derivation does not produce, and the whole of what makes an edited graph
survive a rebuilt one. A filter lands on the wire it names and takes the pad
name with it; two at one point run in order; a lock outranks the timeline and
reports which control it took; a lock that happens to agree has outranked
nothing; a split copies both halves' filters and a delete takes them away; and
the run graph differs from the printed one by exactly one chain with the
inserted filter in both.

`ui_report.js` drives a render the renderer has something to complain about —
a graph running at half the output rate, with `cropdetect` measuring on the way
past — and follows what it said from `av_log` inside libav to a line on screen:
that the drain runs off the frame loop without anyone asking, that the warning
is visible and attributed, that the whole of libav's chatter is kept and merely
filtered, and that what the filter measured arrives as a named series sampled
in order rather than as more log lines.

`exporttest` renders a timeline and then opens what it wrote, which is the only
way to check the things nobody can see until the render is over: that a clip
lands in the rectangle it was given and the rest of the canvas stays black,
that opacity is a blend and not a switch (half of a picture over black is half
as bright, whatever the picture is), that overlapping clips are summed rather
than picked between, and that stopping half way still leaves a playable file.
`ui_export.js` drives the Output workspace and checks the join above it — that the spec
it builds is the edit that is on screen, that every control turns into the
ffmpeg option it claims to be (and that a raw option beats the control setting
the same key), that the advanced editor's list is libavcodec's, that both
halves of the A/B preview render and land on identical pixels, and that the
file that comes out can be dropped straight back on the timeline. It also
drives the Write stage's stream list: a second audio track added, given a
language, a name and two flags at once, and then rendered and opened to find
both tracks in it — and every one of those printed by the command bar, because
anything reaching the muxer the bar does not print is a bug. And the muxer
picker: that the default group is only muxers `avformat_query_codec` said yes
to, that searching reaches the other hundred and forty by name, by libavformat's
description and by extension, that picking MPEG-TS sets `-f mpegts` rather than
a filename somebody hopes will be guessed, that a muxer which never answered
does not have the codec taken off it, and that the muxer's own options reach
the spec, the command and a file that opens as an MPEG-TS.

## Not yet

Honest list of what does not work:

- **Audio-only files.** bro's `<video>` drives its clock from decoded pictures,
  so a file with no video track has nothing to advance. The UI says so rather
  than sitting at 0:00.
- **Rotation on playback.** Export reads the container's display matrix and
  writes the picture upright. `<video>` does not: bro's decode path carries no
  rotation, so a phone clip shot upright plays on its side and exports
  correctly. The export is the one that is right, which is the wrong way round.
- **Filters on playback.** A filter you put on the graph runs when you render,
  in the export preview, and in the node's own preview on the Graph stage. The
  *viewer* cannot show it: playback is the engine decoding into a `<video>` and
  there is no filter anywhere in that path. Filtered clips are marked `fx` rather
  than left looking broken.
- **Scrubbing a node.** ▶ plays one forward from where the previews were taken,
  and that is the only way to move through it: there is no scrub bar, no way
  back, and nothing to jump with. Somewhere else to start from means moving the
  playhead and pressing `At playhead`.
- **Filters with more than one input or output.** The palette offers what can
  be spliced onto a wire, which means one in and one out. `amix`, `split`,
  `blend` and everything else that needs a wire made by hand needs an editor
  that can make one — the model can express it (an edge names the input port it
  arrives at), and `split` additionally needs an edge to name the output it
  leaves by.
- **A project file.** What you insert and lock is remembered in
  `localStorage`, which is per machine rather than per edit. The graph
  overlay is the first thing that makes a document format worth having.
- **Acting on what was measured.** A filter's numbers arrive as a series and
  are drawn as one, which is where it stops: `cropdetect` can tell you the
  black bars are 240 rows deep and nothing offers to crop them, `ebur128` can
  tell you the loudness and nothing offers to normalise it. The channel and
  the data model are there; what is missing is the verb.
- **Reading a URL that is far away.** A URL is an ordinary input now — typed in
  on the Sources stage, opened through whichever of the thirty-six protocols it
  names, with that protocol's own options beside the demuxer's. What has not
  been looked at is what a *slow* one costs: `probe()` is synchronous on
  purpose, so a URL that takes four seconds to answer takes the UI with it, and
  nothing yet says "connecting" or offers to stop. A local file was never long
  enough for that to matter.
- **Writing to one.** `AVFMT_NOFILE` muxers are in the picker and thirty output
  protocols are reported, but a render still writes to a path. Pointing one at
  a socket is chunk 13's.
- **A still in the viewer without `-loop 1`.** One picture is one picture: bro's
  `<video>` drives its clock from decoded pictures, so a file with exactly one
  has nothing to advance through, and the element shows the frame and reports
  itself ended. Held with `-loop 1` and a `-t` it plays like anything else, which
  is why that is what a dropped picture becomes — but an input somebody has taken
  the loop off is refused with a sentence rather than laid out as a clip of
  nothing. The same is true of `-stream_loop -1`.
- **`pattern_type=glob` on this build.** Globbing is compiled into libavformat or
  it is not, and this build's is not. The control says so instead of offering a
  pattern type that fails at open.
- **A sound sequence.** An image sequence is pictures. Giving a run of frames a
  separate soundtrack means two inputs and a `-map` per stream, which the Write
  stage can say and nothing yet joins up.
- **Capturing.** `gdigrab`, `dshow`, `vfwcap` and `lavfi` are registered and
  listed, and `bro.ffmpeg.deviceSources()` will say what each can see. A device
  is an input with its name forced as the demuxer and its settings as the
  option bag, so the model is now the right shape for one — but nothing opens
  one, and a live input is not a file with a duration, which is what everything
  above the model still assumes.
- **Decoder options.** `-skip_frame`, `-skip_loop_filter`, `-thread_type` and
  every private option of every decoder are reported by
  `bro.ffmpeg.decoderOptions()`. Nothing sets one: playback and the render both
  open their decoders with defaults.
- **Two-pass encoding.** A bitrate target is one pass, so it is met on average
  and not intelligently. Real two-pass needs the stats file from pass one fed
  into pass two, which means a job that is two jobs, and the job state machine
  is built around one.
- **Subtitle streams.** The Write stage's list can hold video, audio and
  attachments; a subtitle track is a kind it does not offer yet. The seam is
  there — a stream says what *kind* it is and where its content comes from —
  and what is missing is a source for one.
- **Every stream of the list from the same place.** A video row is fed from
  the composite and an audio row from the mix, which is why the source is
  stated rather than chosen. Mapping a particular input stream through — the
  thing `-map 0:a:2` says — is the packet path's, below.
- **Stream copy.** Every render decodes and re-encodes, even where the output
  settings match the input exactly and the packets could have been remuxed
  untouched — which would be both instant and lossless.
- **Encoding straight from the GPU.** NVENC, AMF and QSV are offered with their
  own presets, tunes, profiles and rate-control modes, but frames still go
  down to system memory as RGBA and back up again. A hardware decode feeding a
  hardware encode would never leave the card.
- **Speed on a render.** `J`/`K`/`L` and the speed selector are transport
  controls, not part of the edit, so a clip exports at its own rate whatever
  the viewer was last playing at.
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
