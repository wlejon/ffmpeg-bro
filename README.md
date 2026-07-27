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
bro.ffmpeg.containers     // [{ ext: "mp4", label, videoCodec, audioCodec,
                          //    videoCodecs, audioCodecs }, ...]

// Every private option of one encoder, out of its AVClass. On demand: x265
// alone has enough of them that building all of these at startup would be
// work nobody asked for.
bro.ffmpeg.encoderOptions("libx265")
// → [{ name: "crf", help, type: "double", unit, min, max, default, hasRange,
//      values: [{ name, help, value }, ...] }, ...]

bro.ffmpeg.tempPath("candidate.mp4")   // somewhere to put a preview render

// Rendering the timeline. Runs on its own thread; poll it.
bro.ffmpeg.render.start({ path, width, height, fps, start, end,
                          videoCodec, audioCodec, audio, clips: [...],
                          pixelFormat, scaler, colorspace, colorRange,
                          faststart, title, sampleRate, channels,
                          // -key value pairs, applied with av_opt_set and
                          // AV_OPT_SEARCH_CHILDREN — the whole of ffmpeg's
                          // writing surface, not a subset with named fields.
                          videoOptions: { crf: 20, preset: "slow" },
                          audioOptions: { b: "192k" },
                          formatOptions: {} })
bro.ffmpeg.render.poll()    // → { state, progress, frames, totalFrames,
                            //     elapsed, fps, bytes, path, stage, error }
bro.ffmpeg.render.cancel()
```

`render.start` throws if a job is already running. It stops being one the
instant `poll()` reports a terminal state — the run slot is released before
the status is published, so chaining a second render off the first's `done` is
safe, which is what the preview does.

A clip in a render spec is a file, a slice of it, and a rectangle in the output
canvas — `{ path, start, length, inPoint, x, y, w, h, crop, opacity, volume,
muted, z }`. Rectangles rather than fit/zoom/pan modes on purpose: the layout
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

`I` (or the first card on the spine) is what is actually in the files: container,
duration, size, bitrate, and then every stream — codec, profile, dimensions, frame
rate, pixel format, colour tags, sample rate, channel layout. Straight out of
`probe()`, which runs in-process, so it is there the moment a file lands rather than
after a subprocess has been waited on.

Every file on the timeline, once each, with the number of clips cut from it. Two clips
from one file are one source, which is what ffmpeg would open.

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
rather than a copy of the edit as it was. Drag the background to pan, scroll to
zoom, `0` to fit, `Esc` back to the edit.

### Putting a filter in it

Every wire that can take one carries a `+`. Click it and pick a filter out of
**libavfilter's own list** — five hundred of them in this build, searchable by
name and by what libavfilter says each one does; there is no list of supported
filters written down anywhere in this application. The filter appears on the
wire, selected, with its whole option table beside it, read out of the filter's
own `AVClass` exactly as the encoder's advanced column is read out of an
encoder's.

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

Audio nodes have no picture, and show none rather than a black rectangle.

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
| Video | x264, x265, AV1 (SVT / libaom), VP9, ProRes, MJPEG, MPEG-4 — plus NVENC, AMF and QSV when the build has them |
| Audio | AAC, Opus, MP3, Vorbis, FLAC, PCM |
| Containers | MP4, Matroska, QuickTime, WebM |

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
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file>
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
file that comes out can be dropped straight back on the timeline.

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
- **Scrubbing a node preview.** Each one is a couple of seconds from wherever
  the playhead was, looping. There is no way to move within it except to move
  the playhead and press `At playhead`.
- **Filters with more than one input or output.** The palette offers what can
  be spliced onto a wire, which means one in and one out. `amix`, `split`,
  `blend` and everything else that needs a wire made by hand needs an editor
  that can make one — the model can express it (an edge names the input port it
  arrives at), and `split` additionally needs an edge to name the output it
  leaves by.
- **A project file.** What you insert and lock is remembered in
  `localStorage`, which is per machine rather than per edit. The graph
  overlay is the first thing that makes a document format worth having.
- **Two-pass encoding.** A bitrate target is one pass, so it is met on average
  and not intelligently. Real two-pass needs the stats file from pass one fed
  into pass two, which means a job that is two jobs, and the job state machine
  is built around one.
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
