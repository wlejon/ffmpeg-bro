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
bro.ffmpeg.probe({ path, format, options, decoderOptions,
                   ss, t, to, itsoffset, streamLoop })
// `decoderOptions` is the second bag on an input and a different one:
// `-probesize` belongs to libavformat and `-skip_frame` to libavcodec, and
// ffmpeg writes both in front of the same `-i` because both are decisions
// taken while this input is being read. They reach every decoder opened for
// this input — the two export readers and both playback decoders — so
// `-skip_frame nokey` is the same decision on the timeline and in the file.
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
                          //    codecName: "h264",   // the codec, not the encoder
                          //    crf, preset, qp, tune,          // booleans
                          //    hardware, intraOnly, lossless, alwaysLossless,
                          //    crfMin, crfMax, crfDefault,
                          //    pixelFormats, presets, tunes, profiles,
                          //    containers }, ...]
bro.ffmpeg.audioEncoders  // [{ id: "aac", label, sampleRates, channelCounts,
                          //    lossless, containers }, ...]

// The third encoder list, and the first that is not a judgement about which
// entries are worth offering. The two above start from a candidate list
// because "the useful video encoders" is not a thing libavcodec can be asked;
// there are nine subtitle encoders and every one of them is a named
// interchange format, so this is the registry walk.
bro.ffmpeg.subtitleEncoders
// → [{ id: "mov_text", label, longName, textSub: true, containers }, ...]
// `textSub` is AV_CODEC_PROP_TEXT_SUB and it is the one fact that decides
// whether a conversion is possible at all: `subrip`, `ass` and `webvtt` are
// text, `dvdsub` and `hdmv_pgs_subtitle` are pictures of text, and turning one
// into the other is optical character recognition.

// Every muxer this build links — a hundred and eighty of them — by the name
// `-f` takes. `containers` was four of these written down in C++, and MPEG-TS,
// MXF, AVI, FLV, GIF, image2, WAV and ADTS were compiled in and unreachable
// because of it.
bro.ffmpeg.muxers
// → [{ name: "matroska", label, longName, ext: "mkv", extensions: ["mkv"],
//      mimeType, videoCodec, audioCodec,        // encoders to default to
//      defaultVideo, defaultAudio, defaultSubtitle,   // what the muxer asks for
//      noFile, globalHeader, noTimestamps, stills, device,
//      subtitleCodec, subtitleCodecs,
//      videoCodecs, audioCodecs, answersCodecs }, ...]
// **A muxer's declaration and a muxer's answer are different facts**, and mp4
// is where that costs: its `subtitle_codec` is AV_CODEC_ID_NONE in this build
// and yet `avformat_query_codec` says it holds `mov_text`. `defaultSubtitle`
// is the declaration; `subtitleCodec` is what a picker and the writer should
// act on — the declaration where there is one, and otherwise the first codec
// the muxer answers for, preferring text over pictures because mp4 also
// accepts `dvdsub` and that is first in libavcodec's order.

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
bro.ffmpeg.bsfOptions("h264_metadata")   // and the stage between the two
// → [{ name: "crf", help, type: "double", unit, min, max, default, hasRange,
//      values: [{ name, help, value }, ...] }, ...]

// The stage of the pipeline that is neither an encoder nor a muxer: bitstream
// filters work on packets that are already encoded, in between. `codecs` is
// each filter's own `codec_ids`, and **empty means any** — `setts` and `noise`
// declare no list at all, which is an answer and not an absence.
bro.ffmpeg.bitstreamFilters
// → [{ name: "h264_mp4toannexb", codecs: ["h264"] },
//     { name: "setts", codecs: [] }, ...]
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

// Where a copy can start. **A copied stream can only begin at a keyframe**,
// which is a fact about the input rather than about the render — so it is a
// query, asked before the render rather than explained after it. Read out of
// the demuxer's own index where there is one, which is instant and exact, and
// by reading the window where there is not.
bro.ffmpeg.keyframes(path | input, { stream, from, to, max })
// → { stream, how: "index" | "scan", complete, from, to, times: [0, 2, 4, …] }
// The times are seconds on the stream's own clock, counted from its first
// packet — which is the clock `ExportStream.copyFrom` is written against and
// the clock the seek is made on, so a number snapped to here is the number the
// render lands on. `complete` is false when the walk was cut short by `max` or
// by the scan not reaching `to`: a list of keyframes that quietly stops is a
// list somebody would snap to the wrong end of.

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
                          inputs: [{ path, format, options, decoderOptions,
                                     ss, t, to, itsoffset, streamLoop }],
                          // Which muxer, by name — `-f matroska`. Empty falls
                          // back to guessing from the extension. Named because
                          // that is what identifies one: nothing in
                          // libavformat is called "mkv", forty-seven muxers
                          // have no extension at all, and several share one.
                          //
                          // **`path` is not always a path.** It is whatever
                          // this muxer is named with: a file, a pattern with a
                          // frame number in it, a URL through any output
                          // protocol this build links, or — for `-f tee` — the
                          // destination list, `[f=matroska]a.mkv|[f=flv]rtmp://…`.
                          // `formatOptions` is split in two on the way in by
                          // asking the muxer which keys are its own; what it
                          // does not know is handed to `avio_open2`, which is
                          // where a protocol's options are taken. A key
                          // neither of them has is an error.
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
                          // None of these five is an encoder option, which is
                          // why each is a named field rather than a key in the
                          // bag above. `-force_key_frames` sets a frame's
                          // picture type before the encoder sees it; the field
                          // order has to reach the frames as well as the
                          // encoder; `-shortest` ends the loop the writer is
                          // being fed from.
                          forceKeyFrames: "1.5,4,8",     // or "expr:gte(t,n_forced*2)"
                          fieldOrder: "tt",              // "" | tt | bb
                          threads: 0, threadType: "",    // 0 is libavcodec's auto
                          shortest: false,
                          streams: [...], chapters: [...] })
bro.ffmpeg.render.poll()    // → { state, progress, frames, totalFrames, openEnded,
                            //     elapsed, fps, bytes, pieces, path, stage,
                            //     error, job, pass, passes, passLabel }
// `bytes` is on disk for a file and *sent* for a URL — a socket cannot be
// stat'd, and an mp4 that +faststart rewrote is not the write position either.
// `pieces` is how many files the muxer opened **beside** the one it was named
// with: 0 for an ordinary render, the segments of an `hls` or `segment` one,
// the chunks of a `dash` one, the numbered pictures of an `image2` one, the
// destinations of a `tee`. Counted as libavformat opens them, through
// `AVFormatContext::io_open`, so it needs to know nothing about how any muxer
// numbers its files — and a file opened twice is one file, so a playlist
// rewritten every segment is not counted forty times.
bro.ffmpeg.render.cancel()

// A render that is more than one render. Two things in ffmpeg need a second
// walk over the same frames, and both hand off through a file on disk:
// `vidstabdetect` writes a .trf that `vidstabtransform` reads, and `-pass 1`
// writes a statistics log that `-pass 2` spends the bitrate by. So a pass is
// the render with **overrides**, not a new kind of job — and an empty list is
// one pass that overrides nothing, which is every render written before there
// were passes.
bro.ffmpeg.render.start({ …,
  passes: [{ label: 'analysing',      // what the status says while it runs
             discard: true,           // `-f null -`: run it all, keep nothing
             videoCodec: 'wrapped_avframe',
             filterGraph, filterInputs,   // this pass's, if it differs
             path, format,
             videoOptions: { pass: '1' } },   // merged on top of the render's
           { label: 'the render itself', videoOptions: { pass: '2' } }] })

// **One job, two passes.** One claim on the run slot, one thread, one Stop,
// and one terminal status published after the *last* pass has closed its file.
// `progress` runs across the whole job because the person watching started one
// render; `frames`/`totalFrames` are the pass's, because that is what the
// encoder is doing. `pass` is 1 of 1 for an ordinary render, so nothing has to
// know passes exist.
//
// A pass that names its own encoder starts from an **empty** option bag: an
// option table belongs to an encoder, and x264's `preset` on `wrapped_avframe`
// is an unknown option, which is an error here rather than a shrug.

// Recording a device — the second kind of job in the same slot, polled through
// the same `render.poll()`. A separate pair of calls because what it is given
// is different (one device, no timeline) and because **stop is the normal end
// of a recording**, which is a different act from cancelling a render even
// though it is the same signal.
bro.ffmpeg.record.start({ source: { path: 'desktop', format: 'gdigrab',
                                    options: { framerate: 30 }, t: 0 },
                          // the output half is exactly a render's: path,
                          // format, videoCodec, audioCodec, crf, preset,
                          // videoOptions, streams, … Width, height and fps
                          // default to *the device's own* rather than to
                          // 1920×1080 at 30: a capture is not composited into
                          // a canvas, so a size of this application's choosing
                          // would be a scale nobody asked for.
                          path: 'out/take1.mkv', format: 'matroska' })
bro.ffmpeg.record.stop()

// `source.t` is `-t`: how long to record for, and **zero means until stopped**.
// With no `-t` the job reports `openEnded: true`, `totalFrames: 0` and
// `progress: 0` — zero meaning nobody knows, the same rule `probe()` follows
// for an input with no length. Anything drawing a progress bar has to read
// `openEnded`: a fraction of an unknown total is zero, and a bar sitting at
// zero for ten minutes says "stuck" rather than "recording".
//
// A recording that is stopped reports `done`, not `cancelled`. Nothing was
// abandoned — the length was the open question and stopping answered it — and
// the trailer goes down either way, so what is on disk opens.

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
  { kind: "video",                  // "video" | "audio" | "subtitle" | "attachment"
    source: "composite",            // where the content comes from: "composite"
                                    // (the canvas), "mix" (the whole
                                    // soundtrack), or "copy:0:1" — an input and
                                    // a stream in it, exactly what `-map 0:1`
                                    // names. The first two are *composed*, so
                                    // they are named rather than numbered: no
                                    // input index means "everything, stacked".
                                    //
                                    // A copied stream reaches no encoder at
                                    // all — its packets come out of a demuxer,
                                    // through this stream's bitstream chain,
                                    // into the muxer — so `codec`, `crf`,
                                    // `preset`, `pixelFormat` and the option
                                    // bag have nothing to configure and naming
                                    // one is an error rather than a shrug.
    copyFrom: 0, copyTo: 0,         // the span it takes, in the input's own
                                    // seconds; 0 is the end of it. **A copy
                                    // can only start at a keyframe**: the seek
                                    // is AVSEEK_FLAG_BACKWARD, so it lands at
                                    // or *before* `copyFrom` and never skips a
                                    // frame the copy wanted. What that costs is
                                    // the caller's to show — see
                                    // `bro.ffmpeg.keyframes`.
    codec: "libx265",               // empty asks the muxer for its default
    options: { crf: 22 },           // this stream's encoder options
    metadata: { title: "Programme" },
    language: "eng",                // ISO 639-2
    disposition: "+default+forced", // av_disposition_from_string, or "0"
    tag: "hvc1",                    // -tag:v, four characters
    // `-bsf:v h264_mp4toannexb,dump_extra=freq=k` — a chain, per stream, in
    // the order it runs. A list rather than the comma-separated string
    // because it *is* a list: the order is the whole of the meaning and each
    // entry has its own option table. A bare string is the same as `{ name }`.
    bsf: [{ name: "h264_metadata", options: { level: "5.1" } }, "dump_extra"],
    // each of these takes the render's when it is absent
    crf, bitrate, preset, pixelFormat, sampleRate, channels,
    forceKeyFrames, fieldOrder, threads, threadType },
  { kind: "audio", source: "mix", codec: "aac", language: "fra",
    disposition: "+comment" },
  // A subtitle stream, which is the one kind with **no composed source**: a
  // picture is made and a soundtrack is made, and there is no third thing here
  // that makes cues. So it always reads something that already exists, and
  // there are exactly two ways to read it — the same `-map` either way, and
  // the difference is `-c:s`:
  //
  //   copy:0:2     the packets that are already there, into the new container
  //                unchanged, which needs no decoder at all
  //   decode:1:0   decoded and written again in `codec`, or in whatever the
  //                container holds when `codec` is empty — an .srt becoming
  //                mov_text in an mp4, ass in a Matroska file, webvtt in a
  //                sidecar with nothing else in it
  //
  // `copyFrom`/`copyTo` mean here what they mean on a copy: the span read out
  // of the input, on the input's own clock, with `copyFrom` also being the
  // output's zero. Unlike a copied picture there are no keyframes to land on —
  // every cue stands on its own — so a subtitle window can begin anywhere.
  //
  // **Pictures of text are refused rather than converted.** `dvdsub` and
  // `hdmv_pgs_subtitle` carry bitmaps; the pairing is refused by name before
  // anything opens, because arriving as "Bitmap subtitle required" at the
  // first cue is true and unusable.
  { kind: "subtitle", source: "decode:1:0", codec: "mov_text", language: "eng",
    disposition: "+default" },
  { kind: "attachment", path: "…/font.ttf", mimeType: "font/ttf" },
]
chapters: [{ start: 0, end: 12.5, title: "Opening" }, ...]
```

A malformed entry is a `TypeError` naming it — `streams[2] is a 'data'` —
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

## Capture

`D` (or the first card on the spine) is where an input comes from when there is not
one yet: a screen, a camera, a microphone, recorded to a file.

It is **first on the spine and it is the one card that is not about the render**.
Every other stage is a question about the file coming out; this is the question
about the file going in. `ffmpeg -f gdigrab -i desktop out.mkv` is a whole pipeline
whose output is a file, and then you open that file — so the arrow from Capture to
Sources is real, just crossed at a different moment. `Add to the timeline` is that
arrow being followed.

**A device is an input.** `-f dshow` names a libavdevice demuxer, `-i video=…` names
what it can see, and everything else about it is that demuxer's own options — in the
same bag `-probesize` travels in, printed in front of the same `-i`. Nothing about a
device is a feature of this application, which is why the whole stage is three
questions:

- **Which device.** libavdevice's own list: on Windows `dshow`, `gdigrab`, `vfwcap`
  and `lavfi`. On another platform it is a different list and nothing here changes.
- **What it can see.** `avdevice_list_input_sources`, picked rather than typed —
  a DirectShow name is an exact string with punctuation in it and nobody types one
  correctly. A camera and a microphone chosen together are **one `-i`**
  (`video=Cam:audio=Mic`), because that is what dshow means by it: one demuxer, one
  file, two streams. A device with nothing to enumerate says so — gdigrab takes a
  rectangle rather than a name — rather than showing an empty list, which reads as a
  machine with no cameras in it.
- **What it is set to.** The demuxer's whole option table, in the column the
  encoder's and the muxer's options already use: `video_size`, `framerate`,
  `draw_mouse`, `offset_x`, `audio_buffer_size`, `rtbufsize`. An unknown key stops
  the open rather than being ignored.

**A live preview, before you commit to a recording.** The picture is an ordinary
`<video>` playing the device through the same backend, the same decoder and the same
renderer everything else in this application plays through. There is no preview-only
path, for the reason the node previews have none: a preview that agreed with the
recording most of the time would be worse than none, because it would be trusted.

**A region is dragged, not typed.** Drag a box on the picture and it becomes
`-offset_x`, `-offset_y` and `-video_size` — the demuxer's own options, in the
screen's own pixels, printed in the command a foot below. Which devices can be asked
for a region is a question about their option table rather than a list of names here:
a device takes a rectangle when it has all three of those options, which a screen
grabber does and a camera does not. The picture is fitted rather than stretched,
because a squashed picture would be a squashed rectangle.

**Recording says what it can say and no more.** Elapsed, frames written, bytes on
disk — and, out loud, that there is no percentage: a fraction needs a total and a
device has no end until you press stop. Give it a `-t` and it does have one, and then
the percentage means something. `Stop` is the *normal* end of a recording rather than
the exceptional one, so a stopped recording reports as **done**: nothing was
abandoned, the length was the open question and stopping answered it. The trailer
goes down either way, which matters more here than anywhere else — a render that lost
its index has lost a file that can be made again, and a recording that lost its index
has lost the only copy of something that happened once.

**One job at a time, and while recording that job is the recording.** There is one
render slot in this binary and a capture takes it: no export, no preview, no node
render while the light is on. That is a decision and not a limitation left in —
a recording is the only job here with a real-time deadline and it cannot be re-run,
so it gets the machine. Every other stage is refused with the reason while it runs.

## Sources

`I` (or the second card on the spine) is the **inputs** — the `-i`s. Not "the files on
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

Under them, **the decoders** — one column per codec this input turned out to
carry. `-skip_frame`, `-skip_loop_filter`, `-thread_type`, `-lowres`, and every
private option of whichever decoder libavcodec picks. **A decoder belongs to an
`-i`**, which is why they are here and not on the Encode stage: ffmpeg writes
`-skip_frame` in front of the same `-i` that `-probesize` goes in front of, and
for the same reason — both are decisions taken while this input is being read.
They are a separate bag from the demuxer's because they are a separate object
with a separate table, and they reach *both* the render and playback, so
`-skip_frame nokey` is the same decision on the timeline and in the file that
comes out. An unknown key is refused with the key named, as an unknown demuxer
option is — and refused **before the render starts**, because the compositor
deliberately draws an unopenable clip as the hole it is, which is right for a
file that has gone missing and wrong for a setting somebody typed.

Two clips from one file are one input, which is what ffmpeg would open. A second drop
of the same file reuses it — unless something has been set on it, in which case a
fresh one is made rather than silently inheriting somebody's decision.

An input with no clip cut from it is **not necessarily unused**. The Graph stage
can read one directly — that is what a watermark is — and such an input says
`read by the graph` on its card and cannot be removed while the node naming it
exists. Underneath the list, **Opened by the graph** accounts for the one way a
file can be opened without being an `-i`: a `movie` filter, which opens its file
inside libavfilter with none of this stage's options reaching it. It is listed
rather than left off, with the offer to make it an input instead.

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
| drag socket → socket | make a wire |
| drag a socket onto empty canvas | the palette, filtered to what can take that pad |
| click a wire | select it; `Delete` cuts it |
| `Add filter` | place one on the canvas with nothing wired to it |
| `Fit`, or `0` | frame the whole graph |
| the percentage | back to 1:1 |
| `Re-layout` | give every node back to the layout |
| `Delete` | remove a selected node of yours, or cut a selected wire |
| `Esc` | clear the selection, then leave the stage |

Nodes carry a socket for **every pad the filter has**, not one per wire that
arrived — which matters most at `overlay`, whose two inputs are the canvas and
the clip and are not interchangeable, and which is what makes an empty pad
something you can see and aim at rather than something invisible. An input pad
that has nothing on it is drawn hollow. **Where you put a node is remembered**, against the node rather
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
insert point. It is attached at the very end, after everything you did, which is
what makes wiring anything behind it unreachable rather than something to be
warned about.

### Wiring it yourself

Splicing is one in and one out, and most of libavfilter is not. `overlay` reads
two pads, `amix` reads as many as you say, `split` writes several, `concat` does
both — none of which can be dropped *onto* a wire, because there is nothing for
the second pad to read. So they are placed and then wired:

- **Drag from a socket to a socket.** Either end first; a wire from an input
  back to an output is the same connection. **An input pad holds one wire**, so
  dropping on an occupied pad replaces what was there — which is how a filter
  gets *between* two derived nodes in one gesture rather than a delete and two
  connects.
- **Let a wire go over empty canvas** and the palette opens on what can take
  that pad, out of libavfilter's own registry. What you pick lands where you
  let go and arrives already wired. `Add node` is the same palette with
  nothing in the air.
- **Click a wire to select it, `Delete` to cut it.** Cutting a wire the
  derivation made is *remembered*: the skeleton is rebuilt from the timeline on
  every edit and would put it straight back, so the absence has to be written
  down. `Give it back` in the column hands the pad to the derivation again.

A filter whose pad count is a number — `amix=inputs=3`, `concat=n=3:v=1:a=1`,
`xstack` — grows and loses sockets as you change it, because the count is an
ordinary option in the column beside the graph. **A wire whose pad stops
existing does not vanish.** It is kept, reported by name — *amix has 2 inputs,
so your wire at input 3 has nowhere to land* — and put back the moment the count
goes up again, because a mistyped number should not be lost work.

### A node that makes something out of nothing

Some filters read no pad at all. `color` is a rectangle, `testsrc` and
`smptebars` are test cards, `sine` is a tone, `anullsrc` is silence,
`mandelbrot` is what it says — and there are about thirty of them in this build.
They are **discovered, not listed**: a source here is simply a filter
libavfilter declares with no input pads, so a build that gains one gains it in
the palette without an edit.

`Add node` opens on them, and so does letting a wire go from an *input* pad —
which is the short way round, because what you get back is already wired to the
pad you were trying to fill.

A generator arrives carrying **the size and the frame rate the render is**, read
out of the filter's own option table. That is not decoration: a graph whose last
pad is a different size from the render is refused rather than quietly rescaled,
so filling it in at the moment of placing means the ordinary case simply agrees
and changing it afterwards is a decision you get told about.

**A generator has no length.** It goes on producing for as long as it is asked
to, so with clips on the timeline the render's range is what stops it, and with
nothing on the timeline its own `duration`/`d` is the only thing that can — the
same rule a still and a `-stream_loop -1` follow, and zero still means nobody
knows. Say nothing and the stage says so: *the range is empty — with nothing on
the timeline, a source's own duration (d) is the only thing that says how long a
render would be*.

**A render with nothing on the timeline is a real render.** `ffmpeg -f lavfi -i
testsrc -t 5 out.mp4` is a thing people do every day, and a `testsrc` wired to
`video out` writes a file here with no clip involved. With no clips there is no
derived black canvas either — a rectangle nothing is laid over would be a source
nothing reads the moment you wire your own to the sink — so `video out` is empty
until you fill it, and the stage says which pad it is waiting on.

### A file the graph reads

A watermark, a logo bug, a picture-in-picture insert and a sound bed are one
shape: a file the *graph* reads that nothing on the timeline is cut from.

ffmpeg writes that two ways — `-i logo.png` with `[1:v]overlay`, and
`movie=logo.png,overlay` — and **this application reaches for the first**. The
reason is that everything deciding *how a file is opened* belongs to the `-i`:
the forced demuxer, `-probesize`, `-loop`, `-ss`, `-t`, `-stream_loop`, and for
a URL the whole protocol option table. A `movie` node carries a filename and a
seek point, so making it the mechanism would mean rebuilding all of that inside
a filter argument, badly, beside an input model that already has it. It also
keeps the Sources stage honest: that stage claims to be every file this render
opens, and a `movie=` names one that never appears there and cannot be probed
with the options in force.

So the palette's Sources list **leads with the inputs you already have**.
Picking one places a node that is that input — a file, with a socket per stream
the probe found, numbered as the `-i` it will be. Everything about how it opens
stays on the Sources stage, and the card there says `read by the graph` and
refuses to be removed out from under the node naming it.

Placing a logo over the picture is then two nodes and two wires:

1. `Add node` → the logo file. It lands on the canvas.
2. Drag from the composite's output into empty canvas → pick `overlay`. It
   lands wired to overlay's first input, which is what it draws *onto*.
3. Drag the logo's picture socket onto overlay's second input.
4. Drag overlay's output onto `video out`.

`movie` and `amovie` are still there — they are ordinary filters with no inputs
and the palette offers every one of those — and if you use one, the file it
names is listed on the Sources stage under **Opened by the graph**, with what
that costs said plainly and an offer to make it an `-i` instead. Two things to
know if you do: nothing on the Sources stage reaches it, and a path with a drive
letter in it has to have its colon escaped (`C\:/logo.png`) because a colon
separates filter arguments.

### When it will not run

A graph you are half way through wiring is a graph that will not run, and that
is a normal state to be in — the moment between placing a node and connecting it
is exactly it. So the stage draws it and **says what is wrong on the node it is
about**: the card is outlined, the reason is on it, the column beside it says the
same thing with room, the bar along the bottom counts them, and the Graph card
on the spine reads `will not run` from whichever stage you are on.

What is refused, each naming the node:

| | |
|---|---|
| an input pad with nothing on it | `overlay has nothing wired to its input 2 of 2` |
| a pad read twice | `hflip's output is read by 2 filters — put a split in between` |
| an output nothing reads | `nothing reads split's output 2 of 2` |
| a picture wire in a sound pad | `a picture wire arrives at amix's input 2 of 2, which takes sound` |
| a loop | `these feed each other in a circle: hflip → vflip` |
| a filter this build does not have | `libavfilter in this build has no filter called "unsharpenator"` |
| nothing mapped | `nothing is wired to video out, so the render has no picture to write` |
| a wire on a pad that stopped existing | *see above* |

**A render is refused rather than approximated.** The command bar prints the
reason instead of a filtergraph, and the export goes through the internal
compositor *without your filters* and says so on the Encode stage — which is the
honest outcome, because the alternative is a file that succeeded and is not what
you asked for. Every one of these is a shape ffmpeg itself rejects; the whole
value of printing a command is that it can be taken elsewhere and run.

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

### When it is on

A filter does not have to run for the whole render. ffmpeg's timeline support is
one option — `enable`, an expression evaluated per frame — and the **When** strip
in the column beside the graph is where it is set: the render's range as a ruler,
the spans the expression describes drawn on it, and ends you drag. `Another span`
adds one; each span is `between`, `from` or `until`, with its moments in fields
beside it. The card carries the answer in one line.

**`enable` turns a filter on and off. It does not interpolate a value.** That is
a real limit and it is worth being plain about, because "keyframes" is the word
people reach for and this is not that: a blur that comes on at ten seconds comes
on at full strength. What ffmpeg *does* have for animating a value is expressions
in a filter's own options — `crop`'s `x` and `y`, `overlay`'s, `drawtext`'s, some
of them with an `eval` option choosing between once and per-frame — which are
evaluated every frame and genuinely do move. Those are reachable here as ordinary
option text and are not surfaced as anything better than that.

The strip is a **reading of the expression, not a copy of it**. It is parsed on
every draw and nothing is written until you drag or type, which is the same
arrangement the Quality slider and the advanced option editor have: one
mechanism, nothing to drift. The expression itself is in a field under the strip
and on the card, quoted — `enable='between(t,1,2)'` — because a filtergraph
separates filters with commas.

So an expression the strip cannot draw is **left exactly as you typed it**. It
can draw `between(t,a,b)`, `gt(t,a)`, `gte(t,a)`, `lt(t,b)` and `lte(t,b)` added
together, and that is all; `mod(t,4)`, anything written against `n` or `pos`,
arithmetic inside a span, or any of the rest of ffmpeg's expression evaluator
makes the strip stand down and say which part of it it gave up on. It does not
approximate and it does not rewrite.

**A filter with no timeline support is offered no control at all**, because
there is nothing for one to do: libavfilter checks the flag and refuses the
graph outright — *Timeline ('enable' option) not supported with filter 'scale'*
— rather than ignoring it. Which filters have it is read off the registry, so
there is no list here either. One set the other way, typed raw or moved onto a
filter that cannot take it, is reported against that node before the render
rather than after.

`t` is seconds into the render, measured from the start of the range — the same
clock the whole graph runs on, because every derived chain begins
`setpts=PTS-STARTPTS+offset/TB`. A filter spliced in *before* that, at a clip's
`after decode` point, sees the source file's own timestamps instead, and the
strip says so and rules itself in the source's seconds.

Playing the node (▶, above) is how you judge it: the readout over the picture
says `on` or `off` as the playhead crosses the boundary.

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
(`clip:7/after-scale`), never to a position, so they survive the rebuild. A node
you placed carries an id of its own, and a wire is written as the two pads it
joins — each named the same way, by anchor or by id — so hand-made structure
survives it too. They survive moving and trimming the clip; splitting a clip
copies the filters and the locks to both halves, because a cut should not change
how either half looks, and does *not* copy the wires, because an input pad holds
one wire and a copy of one would be a second producer arriving at a pad that
already has one. A clip trimmed out of the rendered range takes its nodes and
wires with it and brings them back; deleting the clip takes them for good.

They are remembered in `localStorage` between runs — there is no project file
yet, and this is now a good deal more than the first thing that makes one worth
having. A hand-wired graph is work in the way a slider position is not, and it
currently lives on one machine under one key for the whole application.

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

`Encode` and `Write` are two of the six stages on the spine — the row under
the title bar that *is* the pipeline: **Capture → Sources → Compose → Graph →
Encode → Write**. Each card says what its stage is currently set to, so the bar reads as
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
quality, a bitrate target, **two-pass**, a capped average for streaming
(`-maxrate` and `-bufsize`), and lossless. NVENC has no CRF, so its quality mode
is `-cq` with the bitrate target taken out of the way; x264's lossless is
`-crf 0`; VP9's is `-lossless 1`. That mapping lives in one function, so the
summary line, the preview and the export cannot describe three different
renders.

**Two-pass is a mode of that control and not a switch beside it**, because it is
the same decision — spend this many bits — taken twice. The range is rendered
once to measure where the bits are needed and once to spend them, and the
statistics go between the two through a file on disk, which is the only way
ffmpeg ever does it. It is one job here: one Stop, one progress bar, one file at
the end, with the bar saying which pass it is in — a render that is going to do
the whole thing again must not report 43% and leave the rest to be discovered.
A checkbox instead would have let you ask for two passes of *constant quality*,
which is two runs of an encoder that had nothing to learn from the first.

One thing about it cannot be promised, and is said where it is chosen: **whether
an encoder acts on `-pass` is the one capability libavcodec will not answer in
advance.** There is no flag for it and no option to ask about. So the control
does exactly what it says — it writes `-pass 1` and `-pass 2`, as the command
line does — and a render whose encoder kept its statistics somewhere else says
so in the report rather than pretending. x264 keeps its own log and is handed
the filename; everything else uses libavcodec's own statistics pair; which of
the two applies is asked of the encoder rather than looked up in a list here.

**Where the keyframes go** is a different question from how often, and the more
useful one. `-g` is the interval; `Force at` is the *places*:

| | |
|---|---|
| **Off** | whatever the GOP length produces |
| **Cut points** | one wherever the edit cuts — read from the timeline every time |
| **Times** | a list of seconds into the output |
| **Expression** | ffmpeg's own, evaluated per frame over `n`, `t`, `n_forced`… |

**A keyframe where an edit cuts is what makes a file that can be cut again.**
Every editor and every stream packager has to start a segment on one, so a cut
that falls in the middle of a GOP costs a re-encode of everything up to it.
Nothing is copied when you choose it: what is remembered is the *decision*, and
the list is re-read from the timeline whenever it is asked for — so moving a
clip moves the keyframe with it. A version that wrote the numbers down when the
button was pressed would go on naming moments nothing cuts at.

The times are seconds into the **output**, not into the timeline, which is what
ffmpeg means by them and what makes the printed command run somewhere else and
produce the same file.

Under Advanced, four more that are not encoder options and could not be reached
through the option column:

- **Frame timing** is *stated*, not chosen. This renderer walks the range
  forward at the output rate and stamps every frame with its number — both
  paths do — so `-fps_mode cfr` is a fact about it rather than a setting, and
  the command says so. A picker offering `vfr` or `passthrough` would be
  offering two things neither render path can produce.
- **Field order** — progressive, top field first, bottom field first. It is two
  statements that travel together: the encoder goes into field mode
  (`-flags +ildct+ilme`) *and* every frame is marked to match, because only the
  first writes a file that claims to be interlaced without being coded that way.
  What is composited here is progressive, so this is right for footage that was
  interlaced and has come through untouched, and a claim about the picture
  otherwise.
- **Threads** — `-threads` and `-thread_type`. Zero is all cores, which is what
  every render here has always done and remains the right default; this is for
  the render that has to leave a core alone.
- **Shortest** — end the file where the content ends rather than where the range
  does. Off by default: a range is a decision somebody made, and quietly writing
  less of it than was asked for is the wrong half of the trade.

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

### Where it goes

The other half of `Write` is the destination, and it stopped being a path.
There are four shapes and each says which it is:

| | |
|---|---|
| **one file** | what nearly every render is: opened now, closed when the render ends |
| **a set of files** | `image2`, `segment`, `hls`, `dash` — pictures, segments, chunks, and the playlist that names them |
| **a stream** | a URL through one of the thirty output protocols this build links |
| **several at once** | `-f tee`: one encode, several destinations |

**Which one it is, is asked rather than chosen.** There is no mode control here
and no list of segmenting muxers written down anywhere, because either would be
a second answer that could disagree with the first. `AVFMT_NOFILE` is
libavformat's own way of saying *I do not write the file you named me with* —
which is exactly what a segmenter, a playlist writer and `tee` all are — a frame
pattern in the name is what makes `image2` a run rather than one picture, and a
URL is a URL. The muxer picker's **Streaming** facet is the same query.

Each shape then gets what it needs and nothing else. A URL says which protocol
it names and **whether this build has it**, because a URL naming a protocol that
is absent fails at open with a message about a filename. Beside the muxer's
option column is the **protocol's own** — `srt` reports 38 here, `rtmp` about
twenty — and they travel in one bag, which is what libavformat does with
whatever a muxer does not recognise, exactly as the Sources stage does at the
reading end. A key neither of them has stops the render rather than being
ignored.

### Several destinations at once

`-f tee` is **one encode written to several places**. That is worth being exact
about, because "two outputs" can mean two different things and only one of them
is this: `tee` sends the *same packets* to several muxers, so a Matroska file
and an MPEG-TS stream carry the same bitstream in different wrappers, at the
cost of one encode. Two outputs at *different settings* is a different feature —
two encodes — and is not built.

The destinations are a list: a muxer, a target, and that destination's own
options. The `-f tee` argument is **built from the list rather than typed**,
and shown in full underneath it, because that argument is a small language with
two layers of escaping over it:

- `tee` separates destinations with `|` and reads each one's options out of
  `[ ]` on `=` and `:`, honouring a backslash — so a `|` or a `\` in a target,
  and a `:` or a `]` in an option value, have to be escaped. On Windows that
  means every backslash in a path is doubled, which looks wrong and is right.
- then the shell quotes the lot again, which is a second and completely
  separate layer, and is what the command bar's quotes are.

An argument assembled on your behalf is exactly the one that has to be visible,
which is why the list and the string are both on the screen.

**Recording and streaming the same capture** is this, and it is the case tee was
chosen for: one encode, one real-time deadline, a file kept and the same packets
sent somewhere else. The Capture stage takes a tee argument in its own path
field and says how many destinations it comes to; the editor for the argument is
on the Write stage, because a second copy of the escaping would be a second
answer to it.

### What comes back from each

Progress has to say something true for each shape, and they do not share a
sentence:

| | |
|---|---|
| **one file** | frames of a total, a percentage, a rate and an estimate |
| **a set of files** | all of that, and **how many files have arrived** — the only number that says a segmenter is segmenting |
| **a stream** | elapsed, frames, bytes **sent** and the bitrate they come to — no size, no percentage, no bar |

How many files is asked of libavformat rather than counted off the disk.
`AVFormatContext::io_open` is the callback every output goes through — the
primary file, each segment, each DASH chunk, each `tee` slave, each numbered
picture — and it is the seam ffmpeg's own CLI overrides, so the count, the names
and the sizes come for nothing and stay right whatever a muxer's numbering
scheme is. A file opened twice is one file, so an HLS playlist rewritten on
every segment is not counted forty times.

A stream has no size because there is nothing to stat, and the number reported
is what went through the socket. It is the same vocabulary a recording with no
`-t` uses — `openEnded`, and zero meaning nobody knows — rather than a second
convention.

**And "open the result" is a real question when the result is not one file.**
For `hls` and `dash` the answer is the playlist: it is the file that was named
and the only thing that says what order the pieces go in. For a numbered run it
is the first picture, because a run has no index and `out%04d.png` is not a name
anything can open. For a `tee` it is whichever destination is local. For a
stream there is **nothing** — what was sent has gone — so no button is offered,
because one that opened a socket would be worse than its absence.

**A destination can fail in ways a file cannot, and that is reported rather than
handled.** A port nothing is listening on is refused before the render starts,
naming the URL — *cannot reach 'tcp://…'* — rather than as the message about a
filename `avio_open` would have given. A connection that drops half way through
stops the render with the destination named and libav's own account of it
beside, in the report drawer, which is where a render says what it was told; a
disconnect is not a defect in this application and nothing here pretends
otherwise. What is deliberately *not* built is retrying: `-reconnect`,
`-rw_timeout` and the `fifo` muxer are what ffmpeg has for that and all three are
ordinary options in the columns beside the destination.

Two things about a destination are warned about rather than discovered:
`+faststart` on a stream, which rewrites the file after the trailer and cannot
be done to something that cannot be rewound — it fails at the end, after
everything has been sent — and a **keyframe interval longer than the segment
time**, which succeeds and quietly produces segments of the wrong length,
because a segment can only start on a keyframe.

### What is in the file

`Write` is the output's **stream list**: one row per stream the muxer will
number, in the order it will number them. A file is not a picture and a
soundtrack — it is a list of streams — and everything this application could
not say before followed from that list not existing.

A row reads as a statement rather than as a grid of labelled inputs:

> **A2** the mix, through `aac` — *fra · “Commentary” · forced · comment*

The usual two — the composite through one video encoder, the mix through one
audio encoder — arrive without anyone asking, because that is what nearly
every render is. `+ Video`, `+ Audio`, `+ Subtitle` and `+ Attachment` add one;
`×` takes one
away, including the last video stream, which is what a sound-only render is.
Everything a row does not say it takes from the Encode stage, so a second audio
track is one click and not twenty controls.

**The first word of the row is where its content comes from**, and there are
two answers. The composite and the mix are made — the edit, composited and
summed, through an encoder. A **copy** is not made at all: it is one input's
packets, going into the file exactly as they came out, which is `-map 0:1`
and `-c:v copy`. Picking one changes the rest of the sentence, because a
copied stream has no encoder to choose: the codec in the file is the codec that
was in the input, so it is stated rather than offered.

## Subtitles

There are three things people mean by subtitles, they are three different
mechanisms in ffmpeg, and each of them lives where its decision is taken. Doing
that badly is the ordinary way an application ends up with a "Subtitles" panel
that quietly does one of the three.

| | |
|---|---|
| **A track beside the picture** | a stream in the output, which a player can turn off — a row on the Write stage |
| **Burned into the image** | a `subtitles` filter on the Graph stage, like every other filter |
| **A file on its own** | a render whose only stream is subtitles: extracting one, and converting the format |

### A file of cues is an `-i`

Add an `.srt`, a `.vtt` or an `.ass` on the Sources stage and it is an input
like any other: the demuxer can be forced, `-ss` shifts every cue, the command
bar prints all of it in front of the same `-i`. What it is not is a clip —
there is no picture to lay out and no sound to mix — so nothing appears on the
timeline and the panel says so rather than offering `Use on the timeline`.

Which it is, is read off **what libavformat found in the file** rather than off
the extension: an input whose every stream is subtitles is a subtitle file.

A card that nothing is cut from stops calling itself unused the moment a stream
row is written from it or a `subtitles=` node reads it. Both are ways an input
is used without a clip existing, and "unused" beside a file the render is about
to open is the one thing the Sources stage cannot afford to get wrong.

### A track beside the picture

`+ Subtitle` on the Write stage adds a row that says which track it reads and
what it comes out as. **Carrying and converting are one control**, because they
are one decision with one question behind it:

| | |
|---|---|
| **carry** | `-c:s copy` — the packets that are already there, instant and lossless, and only possible where the output container holds the codec the input has |
| **convert** | `-c:s mov_text` — decoded and written again in whatever the container does hold |

A new row answers that question by asking `avformat_query_codec`, not by
preferring one: an `.ass` track going into Matroska is carried, and the same
track going into an mp4 is converted, because mp4 holds exactly one subtitle
codec and it is `mov_text`. The codec menu is the same query, so a row cannot
offer something the muxer will refuse at `write_header`.

Where `+ Subtitle` is not offered, the reason is written in its place — a
container that holds none, or no subtitle file open yet. A stage with no button
on it reads as an application that cannot write subtitles at all.

**Pictures of text cannot be converted.** `dvdsub` and `hdmv_pgs_subtitle`
carry bitmaps rather than characters, and turning one of those into `subrip`
is optical character recognition, which neither this nor ffmpeg does. Such a
track can be carried into a container that holds it, or burned into the
picture; asking for it as text is refused by name, before anything opens.
Which family a codec is in is libavcodec's own `AV_CODEC_PROP_TEXT_SUB`.

### Burning them in

`Burn it into the picture` on a subtitle input places a `subtitles` filter at
the point where the whole canvas is, and takes you to the Graph stage where the
node now is. **What it places is an ordinary node** — it is printed by the
command bar, it can be moved, configured and deleted, and nothing about the
render behaves differently because a button rather than the palette put it
there. A shortcut that produced something you could not then find would be
worse than no shortcut.

Burned-in subtitles *are* visible in this application, because a node preview
and the export preview are real renders. Playing the node is how you watch them
come and go.

One thing is escaped on your behalf and shown so that it is not a mystery: **a
filtergraph separates a filter's arguments with `:`**, so a Windows path with a
drive letter in it goes into `subtitles=` unusable and libavfilter complains
about an option named after half the path without ever mentioning the colon.
The path is written `subtitles=filename='D\:/media/cues.srt'`, quoted as well
because a filename may contain a comma and a comma ends the filter.

### Out on its own

A render whose only stream is a subtitle track has no canvas, no mix, no
encoder and no frame clock — the cues drive it. That is what extracting a
track is, and it is also what converting one is: `.srt` in, `.vtt` out, with
`-f webvtt` and a filename that ends in `.vtt`. The three formats everything
converts between — SubRip, WebVTT and ASS — are all muxers this build links,
and the picker shows them among the other hundred and eighty.

### What the viewer cannot do

**A soft subtitle track is invisible in the viewer, and always will be until
playback grows a path of its own.** bro's `<video>` decodes into an element and
there is no subtitle path anywhere in it — the same structural reason a filter
cannot be previewed there. The track is in the file and plays in any player;
what this application can show you is the render, not the timeline.

That is said on the Write stage, out loud, with the reason. Somebody who adds a
subtitle row, looks at the viewer, sees nothing and concludes the track was not
written is the failure this is against — and a fake overlay would be worse,
because it would then disagree with the render in every detail of position,
font and line breaking.

### A font travelling with the text

An ASS track names its fonts by name — `Style: Default,Arial,48,…` — and
carries none of them, so a player without that font substitutes one and every
line, break and position moves with it. Embedding the font is what `-attach`
is for, it is an **attachment stream** on the Write stage, and Matroska holds
them. An ASS row with no attachment beside it says so.

### Copying instead of encoding

Four things become possible and each of them is instant and lossless, because
nothing is decoded:

| | |
|---|---|
| **Rewrap** | the same packets in a different container |
| **Lossless cut** | a span of one input, byte for byte |
| **Replace the audio** | copy the picture, take the sound from the edit or from elsewhere |
| **Extract** | one stream on its own |

`Rewrap <file>` under the list is the short way to all four: it fills the list
with one copied row per stream of that input. **It is a shortcut and not a
mode** — what it leaves behind is ordinary rows with ordinary sources, so
everything it decided is on the screen and can be changed or undone a row at a
time. Nothing on this stage behaves differently afterwards.

**A copy can only start at a keyframe**, and that is the one cost worth knowing
about the whole packet path. Open a copied row and the keyframes are drawn on
the input's own clock with the in-point against them: click a mark to cut
there, or type a time and read what it costs —

> the nearest keyframe at or before 4.20 s is 4.00 s — a copy can only start on
> one, so 0.20 s more than you asked for will be at the front of the file

with `Snap` beside it. Where they are is asked of the demuxer's own index,
which is instant for mp4 and Matroska; a container without one is read, and
the panel says which of the two happened and whether the list was cut short.
Every packet of a sound stream stands on its own, so a copied soundtrack starts
exactly where it is asked to and says so instead of drawing a strip.

**A copy conflicts with the edit, and every conflict is named rather than
ignored.** This matters more here than anywhere else on the stage: a render
that quietly dropped what it could not apply would succeed, and what came out
would be the input again.

| | |
|---|---|
| more than one clip | *the timeline has 3 clips and the picture is copied — a copy is one input's packets, so nothing stacked, cut or laid beside it will be in the file* |
| a filter on the graph | *the filters on the Graph stage do not reach a copied stream — it is never decoded, so there is no picture for a filter to work on* |
| a crop, or an opacity | *the packets go into the file as they are* |
| an output of a different size | *the output is set to 1920×1080 and the copied picture is 640×360 — a copy is not resized* |
| a container that will not hold the codec | refused by `avformat_query_codec`, with both named |
| a codec chosen on a copied row | there is no encoder to configure, so it is refused rather than ignored |
| the same container it came from | *this is a rewrap into the container the file is already in* |

The command bar prints `-map 0:1` and `-c:v copy`, and puts `-ss` and `-to`
**in front of the `-i`**. That position is the whole difference between a
lossless cut and a slow one: before the `-i` it is an input seek and the
demuxer jumps to the keyframe, which is why a copy starts there; after it, the
same word is an output seek — the whole file read and the front discarded,
slower and beginning on a frame nothing can decode. The bar says so under the
command.

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
- **Bitstream filters** — the packet chain, in the order it runs.

**A bitstream filter is neither an encoder nor a muxer**, which is why it lives
here rather than on the Encode stage: it works on packets that have already been
encoded, in between the two, and nothing it does costs a re-encode.
`h264_mp4toannexb` rewrites NAL framing, `hevc_metadata` edits the VUI without
touching a pixel, `dump_extra` repeats the parameter sets so a stream can be
joined mid-flight, `setts` rewrites timestamps. None of them is reachable
through any option table, and before this there was no `av_bsf_*` anywhere in
this binary.

It is drawn as the ordered list it is — a row per filter, numbered, with the
arrows to move one — because the order is the whole of the meaning:
`h264_mp4toannexb,dump_extra` and the same two the other way round are different
files. What is offered is narrowed to the codec this stream is actually encoded
with, out of each filter's own declared list, so the menu cannot offer something
the render will then refuse; a filter that declares no list runs on anything and
is always there. Each carries its own option table, in the column the encoder's
and the muxer's already use.

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

### Measuring, and doing something about it

A whole family of libavfilter's filters answers a question rather than changing
a picture. **There is no list of them anywhere in this application**, because
what distinguishes one is not its name — it is that it emits frame metadata or
logs, and both are captured from every filter on the graph. Put any of the four
hundred and eighty-eight on and what it says arrives.

**Starting one is a filter on the graph, and stays that.** The Report drawer
offers `Crop`, `Black`, `Scenes`, `Freezes`, `Levels`, `Silence`, `Loudness` and
`Sound levels` — each a shortcut to a gesture the Graph stage's palette already
makes, which is why the node appears on the graph and in the command bar
afterwards. What the shortcut adds is knowing *where* it goes and which of its
options make it answer at all: `ebur128` says nothing whatever without
`metadata=1`, and its true peak needs `peak=true`, which is not a thing anybody
should find out by getting an empty report.

`Measure now` runs it. That is a real render — the graph, the range, the same
`buildSpec()` every other render here goes through — with the output thrown
away: `-f null -` through an encoder that encodes nothing. It costs the decode
and the filters and leaves no file, because rendering something nobody wanted in
order to find out what a filter thought of it is most of a reason not to bother.

**Reading it is a plot.** Click a series and it opens over the render's range:
axes, a hairline grid, up to six lines against each other, a crosshair that
reads every value under the pointer, and a click that takes the playhead to that
moment. Colours are taken in a fixed order and then *remembered*, so taking one
line off never repaints the rest. Series that do not share a scale are
normalised, and the axis says so — there is deliberately no second y-axis, since
the alignment of two scales is arbitrary and invents a correlation that is not
in the data.

**Acting on it is the point.** A measurement that can only be read is a number;
one that can be applied is a tool. Each is parsed, and then either offered or
*refused with a reason* — never quietly approximated:

| | |
|---|---|
| `cropdetect` | **the crop it found**, put on the graph straight after the filter that measured it, carrying the four numbers exactly as `cropdetect` printed them |
| `ebur128` | **`loudnorm`'s measured parameters** — integrated loudness, range, threshold and true peak, which is ffmpeg's own two-pass loudness normalisation and the only version of it that is not a guess |
| `blackdetect`, `silencedetect`, `freezedetect`, `scdet` | **cut points on the timeline**, one at each end of every span |

The line each number was read out of is on the card, for the reason the command
bar prints the invocation: a number handed over without its source has to be
taken on trust.

The refusals matter more than the offers. A `cropdetect` still finding letterbox
in the last third of what it saw is refused *naming both answers* — a crop from
a filter that had not settled is a shot with its edges taken off and it looks
exactly like a crop that worked. An `ebur128` that has not reached the end of
its input has no summary, because that is the only place it prints one, and
normalising to a number that is going to change is worse than not normalising.
A picture that reaches every edge of the frame is offered no crop and says why,
which is an answer rather than a missing button.

### What the settings cost, as a number

The A/B stage renders the same seconds twice, at the chosen settings and
losslessly. That is a *distorted* input and a *reference* sitting on disk with
nothing else to do — which is exactly what every objective quality metric is
defined on. So a third render compares them, and under the wipe is

> **measured** PSNR 43.62 dB · SSIM 0.9912 — *against the lossless half*

Which metrics are available is asked of libavfilter rather than written down:
`psnr` and `ssim` are in every build, `libvmaf` is a `--enable-` and this build
does not have it. The comparison is on the very files the wipe is showing, so it
cannot be describing a different render; the answers arrive through the same
channel `cropdetect` uses, as series, so the frame where the encode fell apart
is a place you can point at on a plot.

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
| `D` | the Capture stage — a device, watched and recorded |
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
./build/Release/ffmpeg-bro-capturetest out         # devices: an endless input, and recording one
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sources.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sequence.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_report.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_measure.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_subtitles.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_capture.js       # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js   # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js         # needs no media
```

`capturetest` and `ui_capture.js` have a problem the others do not: **CI has no
camera.** The vehicle is `lavfi` — libavfilter's *input device*, `-f lavfi -i
testsrc=size=320x240:rate=25` — which is a device in exactly the way gdigrab is
(registered by `avdevice_register_all()`, opened by a forced `-f`, reporting no
duration, never ending) and is openable on any machine. It is **not** the same
mechanism as a source filter inside a filtergraph, which is a thing the Graph stage
will grow: `testsrc` as a *filter* is a node with no input pad, and the lavfi
*device* wraps a whole graph up as a demuxer so libavformat can read it as an `-i`.
Two different places in the pipeline spelt almost identically.

The machine's real devices are asked about as well, and whatever the answer is it is
*asserted* rather than skipped: gdigrab is either in this build or it is not, and if
it is then opening it either produces frames or says why it did not. A test that
quietly passed because it found no camera would be worse than no test. On Windows
with a desktop session, gdigrab opens — including headless — so what runs here is the
real screen grabber.

`ui_player.js` drops real files on the real UI, plays them, scrubs, steps to the
last picture in the file, zooms the timeline, moves and deletes a clip, scales
and crops the picture, works the controls, and screenshots the viewer into
`out/`. Pass a second file to exercise the multi-clip transport. It also checks
the control strip's geometry — that every icon button drew its icon, that the
transport buttons are one width, that the transport is on the window's centre
line and the zoom controls on the timeline's left edge — because a mistyped
icon name or a stray width breaks none of the behaviour and all of the look.

`ui_subtitles.js` is the three things people mean by subtitles, each of which is
a different mechanism: the cue file arriving as an `-i` and being recognised
from what libavformat found in it, the stream row that carries or converts it,
the container narrowing the codec menu, the command bar printing the `-i`, the
`-map` and the `-c:s`, and the burn-in placed as an ordinary node with its path
escaped the way libavfilter needs it. It renders both and reads the results
back, because a subtitle track that is described correctly and not written is
the failure worth catching.

The fixture generator writes `cues.srt` and `cues.ass` beside the video, with
the cues placed so that a burn-in is **measurable**: a second of picture with
nothing over it, a second with a line over it, a second with nothing again. The
export suite renders the same seconds with the filter and without it and
compares them at both moments — 99 dB apart before the cue and 31 dB during it.
Either half alone proves nothing, because a filter that did nothing passes the
first and a filter that ruined every frame passes the second.

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
given `-probesize` out of the option column, given `-skip_frame` out of the
*decoder's* column beside it — a separate bag, because a decoder is a separate
object with a separate table — cut to a two-second window, used on
the timeline, and then found in the spec with the clip pointing at it by index —
and every one of those printed by the command bar **in front of** its `-i`,
because the same words after it are output options meaning something else. It
also adds a URL, to check that it survives as written rather than being resolved
against the document, that the protocol is named, and that its own option table
is offered.

`ui_capture.js` follows a device the length of the stage: chosen out of
libavdevice's list, its option set from its own table and printed in front of its
`-i`, `-t` printed in front of it too (after the `-i` it would limit the output
instead), a recording started with no end that says so and offers no percentage,
every other stage refused while it runs, and then stopped — which is `done` and not
`cancelled` — leaving a file that probes and lands on the timeline. Then the same
with a `-t`, which does have a percentage and ends by itself. It also lays a device
on the timeline and requires the refusal, drags a region on the live screen and
checks the numbers it becomes are in the screen's pixels rather than the panel's, and
asserts that leaving the stage gives the device back.

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

`ui_measure.js` is the half above that: a measurement started, run, read and
acted on. It clicks `Crop` and finds `cropdetect` on the graph and in the
command the bar prints; runs `Measure now` and finds the series on the render's
own clock; opens a plot and checks that taking a line off does not repaint the
one left; applies the crop and finds a `crop` node at the anchor the
measurement was taken at, carrying the characters `cropdetect` printed. Three
sections are written against **hand-made channel records**, the way
`ui_filtergraph.js` is written against hand-made specs — parsing what a filter
said is a pure function of what it said, so a `cropdetect` that has not settled,
an `ebur128` with no summary and a `blackdetect` that found two stretches can be
stated exactly rather than hoped for out of a fixture. The cut those spans
produce is then made on the real timeline through the real split. Last, the A/B
comparison is rendered and measured, and a better setting has to measure better
— the one check that says the number is about the encoder rather than about the
plumbing.

`ui_report.js` drives a render the renderer has something to complain about —
a graph running at half the output rate, with `cropdetect` measuring on the way
past — and follows what it said from `av_log` inside libav to a line on screen:
that the drain runs off the frame loop without anyone asking, that the warning
is visible and attributed, that the whole of libav's chatter is kept and merely
filtered, and that what the filter measured arrives as a named series sampled
in order rather than as more log lines.

`exporttest` also covers where a render *goes*, which stopped being one file: a
`segment` render writing four .ts files and an m3u8 that names them, every name
in the playlist checked against the disk and the playlist opened back as one
piece of media of the whole render's length rather than one segment's; the same
through `hls`, where the playlist is the thing you name and the segments are the
pieces; a `tee` whose two destinations receive the same forty packets, one of
which decodes to the render in the rectangle the clip was given; and a **real
network destination** — a UDP socket bound on the loopback in the test process
*before* the render starts, because writing to a port nobody is on succeeds
silently whatever is wrong underneath. What arrives starts with an MPEG-TS sync
byte, and the render reports what it sent rather than a size. `capturetest`
records through a tee, since a recording is a device into the same `Writer`.

`exporttest` also covers the four things on the encode side that are claims
about bytes: a real two-pass encode at a bitrate target, which has to write its
statistics where `-passlogfile` said, come out a different size from one pass
and land closer to the target; a bitstream filter, checked by finding a level in
the written SPS that the encoder did not put there; forced keyframes, read back
out of the file's own packet flags rather than taken from the encoder, with a
GOP longer than the render so that every keyframe past the first is one that was
asked for; and `-shortest` stopping where the content does. Each refusal is
checked too — a pass 2 with no statistics, a bitstream filter this build lacks,
an option it does not have, an expression that will not parse, a decoder option
no decoder takes.

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

And where the render goes: that the shape of a destination is *asked* — a URL
is a stream because of its scheme, `segment` is a set of files because it says
`AVFMT_NOFILE`, a frame pattern is a set because the numbering is in the name,
and `C:/` is a path and not a protocol — that a URL's own protocol options are
offered beside the muxer's and reach the same bag, the spec and the printed
command; that the `-f tee` argument is built with tee's escaping (a `|` in a
target, a `:` and a `]` in an option value) and then quoted for the shell, so
what is printed can be pasted and run; that picking `tee` makes the file already
named the first destination rather than throwing it away; that a two-destination
render writes both and reports two; and that the progress panel says something
different and true for each shape — the count of files for a set, "sent" and no
offer to open anything for a stream.

It also drives everything on the encode side that is not an encoder option: that
two-pass is a *mode* of the rate control and that choosing it makes the spec say
the range is walked twice with both passes naming one statistics file and the
command bar printing two invocations; that a forced keyframe at a cut point
**follows the clip when the clip moves**, which is the whole claim of deriving
it rather than copying it; that the field order prints as the two things it is;
that `-fps_mode` has no picker and is stated instead; and that a bitstream
filter chain is offered only for the codec the stream is encoded with, runs in
the order shown, carries libavcodec's own option table and prints as one
`-bsf:v` the way `av_bsf_list_parse_str` takes it.

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
- **Undo, on the graph.** Everything else in the application is a model edit;
  the graph overlay is not on that stack, so a wire cut by mistake is put back
  by wiring it again rather than by `Ctrl-Z`. `Give it back` covers the one case
  where "again" is ambiguous — a pad handed to the derivation.
- **A generated source in the viewer.** A `testsrc` or a `movie` renders and
  previews on its own card, and the *viewer* cannot show it for the same reason
  it cannot show a filter: playback is the engine decoding a file into a
  `<video>` and there is no filtergraph anywhere in that path. A render with
  nothing on the timeline is therefore something you watch on the Graph stage
  and on the Encode stage's preview, not on the program monitor.
- **A generator that follows the render.** A source is placed carrying the
  render's size and rate, and it does not chase them: change the output size
  afterwards and the graph is refused with both numbers rather than rescaled.
  Refusing is the right half of that; noticing before the render is not done.
- **A project file.** What you insert, lock, place and wire is remembered in
  `localStorage`, which is per machine rather than per edit. It was the first
  thing that made a document format worth having and is now most of the reason —
  and a node naming one of your inputs is deliberately *not* written there,
  because the inputs themselves do not survive a restart and their ids start
  again from one, so a restored reference would name whichever file happened to
  be third next time.
- **Animating a value.** `enable` turns a filter on and off for a span and that
  is the whole of what it does — there is no interpolation anywhere in ffmpeg's
  timeline support, so a value cannot be ramped by it. What ffmpeg has instead is
  **expressions in a filter's own options**, evaluated per frame: `crop`'s `x`
  and `y`, `overlay`'s, `scale`'s, `drawtext`'s, several of them with an `eval`
  option choosing between evaluating once and evaluating every frame. Those work
  here — an option is a string and the string goes through verbatim — but nothing
  surfaces them: no control writes one, no strip draws one, and the `eval` option
  is an entry in the table like any other. That is the shape of a real
  keyframe editor and it is not built.
- **A span you can see while you scrub.** The When strip is drawn against the
  render's range and is not the timeline: the playhead is not on it, and moving
  the playhead does not move anything on it. Judging where a span lands is done
  by playing the node, where the readout says `on` or `off`.
- **Two-pass filters.** The mechanism is there — a render is a list of passes,
  each the render with overrides, run in one job through one slot — and the two
  filters that need it are `vidstabdetect`/`vidstabtransform`, which this build
  of ffmpeg was not configured with. So nothing in the UI offers a two-pass
  filter render, because there is none here to offer and a control for a filter
  the build does not have is a control that fails at parse. `loudnorm`'s two
  passes *are* reachable, by a different route: `ebur128` measures and the
  Report drawer offers `loudnorm` told what it found, which is one render and a
  decision rather than two renders.
- **A measurement that follows the edit.** What a filter found is about the
  render it was measured during. Move a clip and the numbers stay, describing an
  edit that no longer exists — nothing marks them stale, and the only thing that
  says so is the timestamp on the render they came from.
- **Measuring part of a graph.** `Measure now` runs the whole graph over the
  whole range. Measuring one node's output means putting the filter at that
  node's point, which works, and there is no equivalent of the Graph stage's
  per-node preview for a *number*.
- **Reading a URL that is far away.** A URL is an ordinary input now — typed in
  on the Sources stage, opened through whichever of the thirty-six protocols it
  names, with that protocol's own options beside the demuxer's. What has not
  been looked at is what a *slow* one costs: `probe()` is synchronous on
  purpose, so a URL that takes four seconds to answer takes the UI with it, and
  nothing yet says "connecting" or offers to stop. A local file was never long
  enough for that to matter.
- **Reading a URL while it is slow, and writing to one while it fails.** A
  render goes to a URL now, with its protocol's own options beside the muxer's,
  and reports what it sent rather than a size. What is not built is either end
  of *going wrong*: `probe()` is synchronous, so a URL that takes four seconds
  to answer takes the UI with it and nothing says "connecting" or offers to
  stop; and a destination that drops mid-render arrives as a failed render with
  libav's own message in the report, with nothing that retries, reconnects or
  buffers. Both are what `-reconnect`, `-rw_timeout` and the `fifo` muxer exist
  for, and all three are reachable as ordinary options — none of them is
  surfaced as anything better than that.
- **Subtitles in the viewer.** A soft subtitle track is written correctly,
  plays in any player and is invisible here for the whole time you are working
  on it: bro's `<video>` decodes into an element and there is no subtitle path
  anywhere in that pipeline, which is the same structural reason a filter
  cannot be previewed. Burned-in subtitles *are* visible, because a node
  preview and the export preview are real renders. The Write stage says which
  of the two you are looking at rather than leaving the viewer to imply the
  track was not written.
- **An editor for the cues themselves.** Everything here reads a subtitle file
  and writes one; nothing lets you type a line, retime one against the
  waveform, or split a cue at the playhead. The timeline has the lane that
  would make it possible — A1 is where you would judge a timing — and none of
  it is built. What a person with a file that is a second and a half out has
  here is `-itsoffset` on the input, which shifts the whole track and is the
  right tool for exactly that one problem and no other.
- **Picture subtitles converted to text.** `dvdsub` and `hdmv_pgs_subtitle`
  can be carried into a container that holds them and burned into the picture;
  they cannot become `subrip`, because that is optical character recognition.
  The refusal names the reason rather than failing at the first cue.
- **A subtitle stream on the packet path's terms.** A copied subtitle track is
  the whole track: `copyFrom`/`copyTo` cut the *span* read out of it, which is
  what the renderer does, but nothing on the Write stage draws that against the
  cues the way the keyframe strip draws a copied picture. There is nothing to
  snap to, so a strip would be decoration; a list of where the cues are would
  not be, and it is not built.
- **Two outputs at different settings.** `-f tee` is one encode to several
  destinations, which is what the Write stage builds. The same render written
  *twice* — a 1080p master and a 720p proxy — is two encodes and is a different
  feature; the `passes` list already expresses it as two walks over the range in
  one job, and no control offers it.
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
- **Previewing the `lavfi` device.** Every other device plays in the Capture
  stage's picture through the ordinary `<video>` path. lavfi cannot, and the
  reason is about the seam rather than about the device: its packets are not
  bytes — the demuxer emits `wrapped_avframe`, a pointer to an already-decoded
  frame — and bro's `MediaPacket` is a byte buffer, because bro is
  codec-agnostic and knows nothing about libav's types. The pointer does not
  survive the crossing. It is detected by asking `probe()` what the codec is,
  said out loud, and it records normally.
- **A live device on the timeline.** A device never ends, so nothing can be cut
  from it: there is no length for a clip to have and no seeking back to a
  moment that has gone. Forcing `-f dshow` on the Sources stage describes one
  correctly and refuses to lay it out, and the Capture stage is where one is
  watched and recorded. Live *through* the edit — a camera composited with a
  title and streamed out — is a different thing again and needs the render loop
  to run on the wall clock.
- **Two devices at once.** A camera and a microphone are one `-i` when the same
  demuxer can open both, which on Windows dshow can. Two separate devices — a
  webcam and a USB interface — are two `-i`s, and a recording opens one.
- **A destination editor on the Capture stage.** Recording and streaming the
  same capture works — it is `-f tee` and the same `Writer` — but the argument
  is typed into the path field there rather than built from a list. The Write
  stage has the editor, and a second copy of the escaping would be a second
  answer to it.
- **Variable frame rate out.** `-fps_mode` has one honest value here and the
  command says it: `cfr`. Both render paths walk the range forward at the output
  rate and stamp each frame with its number — the compositor because it samples
  the edit at *t*, the graph because the writer numbers what leaves the sink —
  so a variable-rate output is not something either can express, and no control
  offers it. Making one possible means the `FrameSource` seam handing over a
  timestamp with each frame instead of being asked for an instant, which is a
  change to the one interface both paths are measured against.
- **Genuinely interlaced content.** The field-order control puts the encoder in
  field mode and marks the frames, which is the whole of what ffmpeg does — but
  what this application composites is a progressive RGBA canvas, so it is a true
  statement only for footage that was interlaced and came through at its own
  size. Anything scaled has had its fields woven together by the scaler first,
  and a 4:2:0 output subsamples chroma across both fields either way. There is
  no field-aware scaling path and no deinterlacer in playback; `yadif` on the
  graph is the answer to the other half of that.
- **A two-pass encoder that keeps its own statistics somewhere else.**
  `-passlogfile` reaches x264, which takes the filename as an option, and every
  encoder that uses libavcodec's own statistics pair. An encoder that does
  neither writes its log wherever it likes and pass 2 reads an empty one — the
  render says so, naming the encoder, because there is no capability to ask
  first.
- **Subtitle streams.** The Write stage's list can hold video, audio and
  attachments; a subtitle track is a kind it does not offer yet. The seam is
  there — a stream says what *kind* it is and where its content comes from —
  and what is missing is a source for one.
- **A copy that follows the timeline.** A copied stream is one input's packets
  over a span, set on its own row in the input's own seconds. The clip you
  trimmed on the timeline is not that span and nothing connects the two, so
  cutting losslessly means reading the in-point off the keyframe strip rather
  than off the edit. It is the obvious next thing and it is not built.
- **A copy of a stream that is not video or audio.** The stream list holds
  those two and attachments; a copied subtitle track is the same gap the
  encoded one is, one kind short.
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
