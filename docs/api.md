# The `bro.ffmpeg` API

The host bindings this binary adds to the JS environment — the surface that
`ffmpeg-bro-headless` scripts, the test suites and the UI itself all drive.
Everything here is asked of libav* rather than written down, so it grows with
the build. For what the *application* does with it, see [the manual](manual.md).

```js
bro.ffmpeg.available      // true — it's linked, not looked up on PATH
bro.ffmpeg.linked         // true
bro.ffmpeg.version        // "libavformat 62.x.x, libavcodec 62.x.x"
bro.ffmpeg.configuration  // the build's ./configure line
bro.ffmpeg.hwaccels       // ["cuda", "d3d11va", "dxva2", "qsv", ...]
bro.ffmpeg.openOnStart    // media file named on the command line, or null

// What this *machine* has, as against what this build has. `hwaccels` above is
// `av_hwdevice_iterate_types` — a fact about the build, and every type in a
// vcpkg ffmpeg is in it whether or not there is a card. This creates a device
// of each and reports whether that worked, which is the only way to find out.
// A call rather than a property, because creating one of every type is the
// better part of a second; cached after the first ask.
bro.ffmpeg.hardware()
// → [{ name: "cuda", present: true, pixelFormat: "cuda",
//      decoders: ["h264", "hevc", "av1", ...],   // asked of avcodec_get_hw_config
//      encoders: ["h264_nvenc", "hevc_nvenc", "av1_nvenc"],
//      filters:  ["hwupload_cuda", "hwupload", "hwdownload"] },
//     { name: "amf", present: false, error: "Unknown error occurred" }, ...]

// An input is an `-i`: a path or a URL, a demuxer, that demuxer's options and
// the part of the file you want. Everything here appears *before* the `-i` on
// a command line, which is not trivia about argument order — these are the
// decisions taken while the file is being opened, and none of them can be
// taken afterwards.
bro.ffmpeg.probe(path)               // in-process ffprobe: throws if it can't be read
bro.ffmpeg.probe(path, { format, options })
bro.ffmpeg.probe({ path, format, options, decoderOptions,
                   hwaccel, hwaccelDevice, hwaccelOutputFormat,
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

// Every filter libavfilter was built with — four hundred and eighty-eight of
// them — which is what the Graph stage's palette is and why there is no list of
// supported filters written down anywhere. `inputs`/`outputs` are the declared
// pad *types* (`"V"`, `"A"`, `"VV"`, `""`), so a filter with no inputs is a
// source and libavfilter is what says which. `dynamic*` means the count comes
// from an option — see `padsOf()` in ui/graph/filters.js, which is the one
// question libavfilter will not simply answer. `timeline` is
// AVFILTER_FLAG_SUPPORT_TIMELINE, and it decides whether an `enable=` control
// is offered at all: a filter without it *refuses* the expression rather than
// ignoring it.
bro.ffmpeg.filters
// → [{ name: "cropdetect", description, inputs: "V", outputs: "V",
//      dynamicInputs: false, dynamicOutputs: false, timeline: false }, ...]

// Option tables, one at a time. Same walk, six more kinds of thing: there are
// a hundred and eighty muxers and three hundred and fifty demuxers, and their
// option tables are the expensive part of describing any of them — which is why
// each is a function and only the registries above are built at startup.
bro.ffmpeg.encoderOptions("libx265")
bro.ffmpeg.muxerOptions("mp4")        // movflags, and libavformat's generic ones
bro.ffmpeg.demuxerOptions("mp4")      // and -fflags, for the other end
bro.ffmpeg.decoderOptions("h264")     // -skip_frame, -skip_loop_filter, -thread_type
bro.ffmpeg.protocolOptions("srt")     // what a destination is configured with
bro.ffmpeg.filterOptions("scale")     // what a node on the Graph stage is set to
bro.ffmpeg.bsfOptions("h264_metadata")   // and the stage between the two
// → [{ name: "crf", help, type: "double", unit, min, max, default, hasRange,
//      values: [{ name, help, value }, ...] }, ...]
// One walk, one shape, seven callers — which is what lets `ui/opttable.js` be a
// single component and not one editor per kind of thing.

// The stage of the pipeline that is neither an encoder nor a muxer: bitstream
// filters work on packets that are already encoded, in between. `codecs` is
// each filter's own `codec_ids`, and **empty means any** — `setts` and `noise`
// declare no list at all, which is an answer and not an absence.
bro.ffmpeg.bitstreamFilters
// → [{ name: "h264_mp4toannexb", codecs: ["h264"] },
//     { name: "setts", codecs: [] }, ...]

// Every disposition bit a stream can carry, named the way `-disposition:s:0`
// names them. Unlike the fourccs below this one *can* be enumerated exactly:
// a disposition is a single bit and `av_disposition_to_string` names it, so
// asking for every bit in turn is the whole vocabulary.
bro.ffmpeg.dispositions
// → ["default", "dub", "original", "comment", "lyrics", "karaoke", "forced", ...]

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
                                     hwaccel, hwaccelDevice,
                                     hwaccelOutputFormat,
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
// rewritten every segment is not counted forty times. Nor is a *working name*
// the muxer renames onto the destination: hlsenc writes its playlist through
// `out/hls.m3u8.tmp`, so the one file that is not a piece arrives spelt
// differently. That is resolved by asking the filesystem which of the names
// still exists once everything is closed, rather than by knowing about
// suffixes — the ordinary pieces are all still on disk and the working name is
// not.
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

**It returns the number of the render it started**, and `record.start` returns
the number of the recording. That is the only moment the number is unambiguous:
`poll()`'s `job` is the render running *now*, so it is zero from the instant one
ends — which is exactly the frame a caller comes to read what its render said.
Every record in the channel below carries the render it was said during, and
this is where the other half of that pairing comes from.

A clip in a render spec is an input, a slice of it, and a rectangle in the output
canvas — `{ input, start, length, inPoint, x, y, w, h, crop, opacity, volume,
muted, z }`. `input` indexes `inputs`; a clip carrying a `path` and no index is
that path opened plainly, which is what every spec written before inputs existed
means and still does. Rectangles rather than fit/zoom/pan modes on purpose: the layout
is worked out once, in `ui/viewer.js`, and both the screen and the encoder are
driven from the same answer.

A clip of a file with no video stream in it sends a rectangle of no size, which
is what the compositor reads as "this one is in the mix and nowhere else". It is
the same statement `viewer.placement()` makes on screen, which is why there is no
separate field for it.

`displayWidth`/`displayHeight` account for the rotation in the container's
display matrix — a phone video is 1920×1080 on disk and 1080×1920 on screen, and
only that side-datum says so. `rotation` is the angle itself, in degrees
clockwise, and it is always 0, 90, 180 or 270: anything else is reported as no
rotation, because no path in this binary can apply one and a number nothing
honours is worse than none. `<video>` reports the same pair as
`videoWidth`/`videoHeight` and the angle as `videoRotation`, read-only.

A stream's `duration` is its own, not the container's. They differ: a recording
routinely stops the audio a fraction of a second after the last picture, so a
clip whose length came from the container would run past the end of its video.
Matroska keeps only one duration for the whole file, and then that is what every
stream reports.

