# The `bro.ffmpeg` API

The host bindings this binary adds to the JS environment — the surface that
`ffmpeg-bro-headless` scripts, the test suites and the UI itself all drive.
Everything here is asked of libav* rather than written down, so it grows with
the build. For what the *application* does with it, see
[the manual](manual/README.md).

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
//     streams: [{index, kind, codec, codecLong, tag, profile, bitRate, language,
//                title, default,
//                duration,
//                // `tag` is the container's own fourcc — "avc1", "hvc1",
//                // "gpmd" — and is empty where the container tags nothing,
//                // which Matroska does not. For a `data` stream it is the
//                // whole identity of the track: telemetry, timecode and timed
//                // metadata all decode to nothing and all report `bin_data`,
//                // so the codec name cannot tell one from another.
//                // video: width, height, displayWidth, displayHeight, fps,
//                //        pixFmt, sampleAspect, rotation,
//                //        colorSpace, colorRange, colorPrimaries, colorTransfer
//                //        — verbatim, and empty when the file says nothing.
//                //        "Untagged" and "BT.601" are different facts; only
//                //        the point of use is entitled to turn one into the
//                //        other, and it does it by frame height.
//                // audio: sampleRate, channels, channelLayout, sampleFmt
//                // subtitle: textSub — characters rather than pictures of
//                //        them (AV_CODEC_PROP_TEXT_SUB). It decides four
//                //        different things: writing the track out as `subrip`
//                //        (optical character recognition, which nothing here
//                //        does); *burning it into the picture*, because
//                //        libavfilter's `subtitles` filter is libass and
//                //        refuses a bitmap track by name; whether `cueText`
//                //        has anything to read; and — the other way round —
//                //        whether the input grows a **cues pad** a graph can
//                //        draw from, which only a bitmap track has.
//               }, ...],
//     video, audio }          // shortcuts to the first of each

// The same probe, on a thread of its own, for the case where the wait is not
// measured in microseconds: **a URL**. `probe()` above is synchronous because a
// container on disk answers in about a millisecond and every caller wants the
// answer before it can lay anything out; a network open can wait for as long as
// the far end likes, and on this architecture that would be the whole window —
// the UI's stage views are never unmounted and the viewer's `<video>` elements
// are the decoders, so a blocked frame loop is a frozen application.
//
// The result is built by the same function `probe()` returns, so a path and a
// URL cannot come back described differently. Which of the two calls to use is
// decided by parsing the string for a scheme, which opens nothing and therefore
// cannot itself block.
bro.ffmpeg.probes.start(path | input, { timeout })   // → id, at once
// `timeout` is in seconds and defaults to 10. It is **not** an option and never
// reaches libav: it is a deadline on the `AVIOInterruptCB` the open is given,
// which is the only mechanism that covers every protocol and the whole open.
// Asked of libav rather than assumed: in this build `tcp`, `udp`, `udplite`,
// `rtp`, `ftp` and the six `rtmp` protocols carry a `timeout`, `srt` carries
// `connect_timeout`, and **`http`, `https` and `tls` carry none at all** — they
// hand their dictionary down to a `tcp` URLContext. `rw_timeout` is on the
// URLContext class rather than on any protocol, appears in no `protocolOptions`
// table, and covers transfers after a connect rather than the connect itself.
// So a timeout written as an option would be absent for the protocol a URL
// here overwhelmingly names, and would still not cover
// `avformat_find_stream_info`.
bro.ffmpeg.probes.poll(id)
// → { state: "opening" | "done" | "failed" | "stopped", opening,
//     elapsed, timeout,      // seconds, so "3.4s of 10" needs no second clock
//     error,                 // "" until it has one; "no answer in time" for a
//                            // deadline, "stopped" for a cancel — both of which
//                            // libav reports as "Immediate exit requested"
//     result }               // exactly what `probe()` returns, or null
// → null once a terminal state has been read: **a terminal answer is handed
//   over once** and the entry forgotten with it, so nothing accumulates behind
//   a caller that walked away.
bro.ffmpeg.probes.cancel(id)   // abort the open; the poll after it says "stopped"
bro.ffmpeg.probes.forget(id)   // abort it and throw the answer away
// `cancel` is a real stop rather than a hidden spinner: it sets the interrupt
// callback libav is polling — roughly every 100ms while it is inside a connect,
// a handshake or a read — and the operation is abandoned. The one thing it
// cannot cut short is `getaddrinfo`, which has no callback in it; that is why
// the open is on a thread as well as behind a deadline.
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

// When a subtitle track's cues are on screen. The same shape of query as the
// keyframes and for the same reason: a window is typed into two fields on the
// Write stage, and what it does to the cues is a fact about the input which
// nothing should have to render to discover.
bro.ffmpeg.cueTimes(path | input, { stream, from, to, max })
// → { stream, complete, from, to,
//     cues: [{ start: 1, end: 2, bytes: 9 }, …] }
// **Times, not text.** This reads packets and never opens a decoder, so it
// answers for a `dvdsub` track exactly as it answers for an `.srt` — and when
// a picture of text is on screen is the only thing anybody can say about one.
// `end` equals `start` where the container did not record a duration, which
// means "the packets do not say" and not "no time at all". `bytes` is the
// payload's size, and it is there because mp4's `mov_text` writes an empty
// sample *between* the cues as well as on them: a count of packets is not a
// count of lines.
//
// `from`/`to` bound what is **listed** and not what a copy would take — a copy
// seeks backward and carries the cue that was on screen when it was asked to
// start, so a caller working that out asks for the whole track and compares.
// There is no index shortcut: an index answers which packets are keyframes and
// every subtitle packet is one, so this reads the file up to `to` with every
// other stream discarded in the demuxer.

// And what those cues *say*. The other half of the question above, and a call
// of its own because it is a second cost rather than two more fields: this
// opens a **decoder per track**, which is the only way words come out of a
// payload, and closes it again before it answers. Nothing in this binary holds
// a subtitle decoder open; `probe()` deliberately does not ask.
bro.ffmpeg.cueText(path | input, { stream, from, to, max })
// → { stream, codec: "subrip", textSub: true, complete, from, to,
//     header: "[Script Info]\n…\n[Events]\nFormat: Layer, Start, …\n",
//     cues: [{ start: 1, end: 2, text: "first cue",
//              raw: "0,0,Default,,0,0,0,,first cue" }, …] }
// **A bitmap track answers `textSub: false` and its codec's name, not an empty
// list.** `dvdsub` and `hdmv_pgs_subtitle` carry pictures of characters, so
// there is nothing in them to read — which is a different answer from "this
// track has no cues" and reaches a panel as one, because an absence with a
// reason beats a blank column. No decoder is opened for such a track at all:
// libavcodec's `AV_CODEC_PROP_TEXT_SUB` settles it first, which is the same
// property `probe()` reports per stream as `textSub` and the same one that
// decides whether a track can be converted or burned in.
//
// The words are the words: every text decoder in libavcodec hands over an
// **ASS dialogue line**, so the eight leading fields come off, `{\i1}` and its
// family come out, and `\N` becomes a newline. A cue whose words come out
// empty is not listed — mp4 writes a sample between its cues and a list of
// blanks is what this call exists instead of; `cueTimes` is where those
// packets are visible and it says so.
//
// The clock is the packets', which is `cueTimes`'s: these are the same cues
// that list describes and a panel draws one against the other, so a second
// epoch here would line nothing up. `max` defaults to 500 rather than 4000,
// because this one decodes.
//
// **`raw` and `header` are the same answer given back rather than read.** A
// column has room for the words and nothing else, but taking a track into the
// document to edit it means being able to write it out again — and `text`
// alone would flatten somebody's styling the moment they retimed one line. So
// `raw` is the dialogue line exactly as the decoder handed it over
// (`ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`, empty for
// a plain-text rect and for the second rect of a cue that has two), and
// `header` is the decoder's `subtitle_header` — the styles, the resolution the
// positions are against and the `Format:` line the fields are ordered by, which
// is the same buffer an `ass`→`ass` render copies into its encoder. Both are
// always on the answer: the cost of this call is the decoder and the walk, and
// the strings are in hand by the time either question is asked.

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

// The same registry one turn further on: an input **with filters on it**, which
// is how a filtergraph reaches playback at all. `<video src="/@fx/clip-7">`
// opens the input, decodes it, runs the chain and hands the frames to the
// element — which is the same crossing a `-f lavfi` input and a live capture pad
// already make, so there is no new mechanism in it.
bro.ffmpeg.views.define("clip-7", {
    input: { path, format, options, ss, t, ... },   // exactly an inputs.define()
    video: "eq=contrast=1.4,hue=s=0",   // `-vf` syntax. Empty leaves the stream
    audio: "volume=0.5",                // alone — and *undecoded*, so a filter
                                        // on the sound costs no video decode.
    shift: 12.5,   // seconds the chains move the clock forward, taken back off
                   // at the end so what reaches the element is on the stream's
                   // clock again. This does not cause the move — a `setpts` in
                   // `video` (an `asetpts` in `audio`) does, and this says how
                   // much of it to undo, because libavfilter will not say.
                   // Zero for a chain that leaves timestamps alone.
})
// → { src: "/@fx/clip-7",
//     video, width, height,        // what the chain produces
//     sourceWidth, sourceHeight,   // what went into it, the right way up
//     audio, sampleRate, channels }
//
// **It settles rather than merely remembering.** The input is opened and a frame
// decoded per filtered stream, because nothing outside libavfilter will say what
// a chain produces until the graph has been configured with real formats at the
// top — and because the answer is what a caller decides on: a chain that will
// not parse **throws**, with libav's own sentence, which is a message worth
// having the moment a filter argument is typed rather than at the end of a
// render. Re-registering the same id with the same input and the same chains
// opens nothing: `shift` is arithmetic on the way out and cannot change what a
// chain produces. A *changed* chain does settle again, including one that
// changed only in the constant inside its `setpts`, so a caller that moves
// clips is the one that decides when to ask — this one asks when the mouse
// comes up rather than under the cursor.
//
// Rotation goes *into* the chain — a display matrix is metadata and `crop=iw/2`
// means one thing on a portrait picture and another on the landscape frames the
// decoder produces — so `sourceWidth`/`sourceHeight` are the shown size and the
// track the element gets reports no rotation of its own.
bro.ffmpeg.views.forget("clip-7")

// The same registry once more, one whole render further on: **the output**, as
// something a `<video>` can play. `<video src="/@out/edit/0-8000">` plays what
// `render.start` would write — the render's own frame source, made frame by
// frame as the element asks for it, with no encoder, no file and no job slot.
// Which of the two renderers it is comes from the spec exactly as it does for a
// render: a `filterGraph` means libavfilter, and its absence means the internal
// compositor.
bro.ffmpeg.output.define("edit", spec)    // spec: exactly a render.start() one
// → "/@out/edit/0-8000", to use as a <video src>
//
// **The token carries the range**, because an element holds the source it
// opened: a redefinition under an unchanged token would leave the picture
// playing the render as it used to be. That is also the whole of the seek — a
// filter graph pulls, so there is no seeking inside one, only building one whose
// inputs begin where you want to start. Moving the playhead is a redefinition.
//
// The encode half of the spec goes unread: there is no writer, so the codec, the
// container, the passes and the path mean nothing here.
//
// **It carries the render's sound as well as its picture**, as two tracks of one
// source, which is what makes an `-af` chain on the whole programme audible —
// nothing else in this application can play one, because there is no clip whose
// element it belongs to. Two things follow from that and both are visible from
// here. The render behind a token is **shared**: bro opens a media element's
// source twice, once for the pipeline and once for the audio ring, and a render
// per open would be two renders of one edit racing for the same files — so
// several elements on one token play one render, and a `define` is what ends it
// (a redefinition is a new render, even under a token that spells the same).
// And the **sound is the authoritative half**: a preview is made at whatever rate
// it can be made at, so pictures are dropped to keep the sound at real time
// rather than the sound being stretched to keep every picture. See
// `src/native/playback_output.h`.

bro.ffmpeg.output.settle(spec)
// → { width, height, fps, start, length, graph }
//
// Build the source, say what it produces, and throw it away — so that a graph
// libavfilter refuses is a sentence the moment somebody wires it rather than a
// black rectangle and a line in a log. It **throws** with libav's own words.
// Settled *without* its sound, which is why nothing here says whether the render
// has any: building the audio half opens a reader per clip, and settling happens
// on every graph edit. Whether there is a soundtrack is answered once, by the
// element that is about to play it.
// Deliberately *not* what `define` does, which is the opposite split from
// `views.define`: an output view is a whole render, and the caller redefines one
// every time the playhead moves, so building is asked for separately and only
// when the graph itself has changed.
bro.ffmpeg.output.levels("edit")
// → { running: true, heard: true, rate: 48000,
//     channels: [{ name: 'FL', truePeak: 0.71, peak: 0.70, rms: 0.28 },
//                { name: 'FR', truePeak: 0.69, peak: 0.69, rms: 0.27 }] }
//
// How loud the render being previewed is *right now*, per channel of the output,
// in exactly the shape `live.levels` hands back — one meter draws both, so one
// shape. **The call clears it**, so there is one caller, once a frame.
//
// The point of it being the render's own answer: the mix is made at the channel
// count the encoder would be opened with, and an `-af` chain, a `loudnorm` or an
// `amix` is in it. Summing the clips' analysed peaks instead would be a waveform
// with a meter's name on it, and reading bro's master bus gives the *machine's*
// stereo mix through whatever the monitoring volume is set to.
//
// Three states, not two. `running: false` is "nothing is registered under that
// id", which is the ordinary answer while the preview is off. `running` with
// `rate: 0` is a render with no soundtrack at all. `heard: false` with a rate is
// a render whose thread is between blocks.
bro.ffmpeg.output.forget("edit")

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
                          // **libavfilter instead of the compositor**, when
                          // there is a graph: `filterGraph` is the
                          // `-filter_complex` text and `filterInputs` says what
                          // feeds each pad it reads. One entry per *pad*, so
                          // `[0:v]` and `[0:a]` are two entries and one `-i`.
                          //
                          // `stream` is `v`, `a` or **`s`**, and the third is
                          // the one worth knowing about: libavfilter has no
                          // subtitle input, so `[0:s]` is a *picture* pad whose
                          // frames this renderer paints out of a bitmap
                          // subtitle track — ffmpeg's own sub2video, one frame
                          // when a cue appears and a cleared one when it
                          // expires. A **text** track there is refused by name,
                          // because drawing characters is libass's job and that
                          // is the `subtitles` filter. Anything else is an error
                          // naming the letter. `from` is the earliest source
                          // time anything downstream asks for, which is where
                          // the reader seeks to.
                          filterGraph: '[0:v][0:s]overlay[vout]',
                          filterInputs: [{ label: '0:v', input: 0, stream: 'v' },
                                         { label: '0:s', input: 0, stream: 's',
                                           from: 0 }],
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
                          // `-fps_mode:v`, and it decides which of two walks the
                          // render is rather than setting anything on an encoder.
                          fpsMode: "cfr",                // "" | cfr | vfr
                          streams: [...], chapters: [...] })
// `fpsMode` is `cfr` — the range walked at `fps`, each frame stamped with its
// number — or `vfr`, where the frames leave the **filter graph** carrying the
// timestamps libavfilter gave them and those reach the file, on the graph's own
// time base. A frame whose timestamp does not advance is dropped, which is what
// ffmpeg's `vfr` means; `passthrough`, `drop` and `auto` are not offered, because
// the first differs from `vfr` only in handing libavcodec a timestamp that does
// not move (an encode that fails rather than a mode), the second is `cfr` by
// another route, and the third is a choice the muxer makes for a CLI that is not
// here. `vfr` is **refused, by name and before a file is opened**, for a render
// with no `filterGraph`, for one whose every stream is copied, and for one whose
// video streams read `pad:` labels: the compositor answers for whatever instant
// it is asked about and so has no frame times of its own, and each pad of a graph
// produces at its own moments while one walk has one timestamp to hand over. A
// recording refuses anything but `cfr` for the same kind of reason — its clock is
// the wall clock.
bro.ffmpeg.render.poll()    // → { state, progress, frames, totalFrames, openEnded,
                            //     packets, elapsed, fps, bytes, pieces, path,
                            //     stage, error, job, pass, passes, passLabel }
// `packets` says what `frames` is counting: packets of a copy rather than output
// frames. It used to be inferable from `totalFrames == 0` and is not any more —
// an `fpsMode: "vfr"` render counts frames and cannot say how many there will be
// either, so the two zeroes mean different things and a readout that guessed
// would report a render encoding pictures as a rewrap.
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

// The other reason a render is several: **another output, at another size**.
// A 1080p master and a 720p proxy are two encodes — an encoder has one frame
// size, so they cannot come out of one, which is what separates this from
// `-f tee`. `width`/`height` are zero for "the render's", and the rectangles
// have to travel with them: a clip is `w: 1920` on a 1920-wide canvas and would
// be *cropped* onto a 1280-wide one rather than fitted, so a pass at its own
// size brings its own `clips` at that scale. An empty `clips` is the render's.
bro.ffmpeg.render.start({ …, width: 1920, height: 1080, clips: […],
  passes: [{ label: 'the master' },                     // overrides nothing
            { label: '1280×720', path: 'proxy.mp4', format: 'mp4',
              width: 1280, height: 720,
              clips: […],                    // the same stack, half the size
              filterGraph, filterInputs }] })  // scaling to 1280×720, not 1920

// **One job, two passes.** One claim on the run slot, one thread, one Stop,
// and one terminal status published after the *last* pass has closed its file.
// `progress` runs across the whole job because the person watching started one
// render; `frames`/`totalFrames` are the pass's, because that is what the
// encoder is doing. `pass` is 1 of 1 for an ordinary render, so nothing has to
// know passes exist.
//
// **`totalFrames` is 0 for an `fpsMode: "vfr"` render**, on the same rule a
// recording with no `-t` follows: how many frames the graph will make between
// here and the end of the range is not something anybody knows until it has made
// them, and zero is the honest answer rather than a number to be papered over.
// `progress` is still right, because it is computed against the range's *length*
// — which both walks know — and not against a frame count one of them would have
// to invent.
//
// A pass that names its own encoder starts from an **empty** option bag: an
// option table belongs to an encoder, and x264's `preset` on `wrapped_avframe`
// is an unknown option, which is an error here rather than a shrug.

// Recording live inputs — the second kind of job in the same slot, polled
// through the same `render.poll()`. A separate pair of calls because what it is
// given is different (devices, no timeline) and because **stop is the normal end
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

// **A recording reads a list of devices, and `source` is the one-device
// spelling of it.** `sources` numbers them for the graph — the first is
// `[0:v]`/`[0:a]`, the second `[1:…]` — and an absent list means `{source}`, so
// a caller that has never heard of the field asks for what it always asked for.
// Given a list, `source` is ignored. A screen grab with a camera in the corner:
bro.ffmpeg.record.start({ sources: [{ path: 'desktop', format: 'gdigrab' },
                                    { path: 'video=Elgato Facecam', format: 'dshow' }],
                          filterGraph: '[1:v]scale=480:-2[pip];' +
                                       '[0:v][pip]overlay=W-w-32:H-h-32[vout]',
                          path: 'out/take1.mkv', format: 'matroska' })

// Three things are refused rather than guessed at, all of them before the job
// starts and with the reason named:
//
//   - **several inputs and no `filterGraph`** — two pictures and nothing saying
//     how they combine, where picking one would be a recording that succeeded
//     while ignoring a device it was told to read;
//   - **a stream no pad reads, once there is more than one input** — the bypass
//     that sends an unfiltered stream straight to the writer has no answer to
//     which device's picture the file would be of, so it is named by pad
//     (`[1:a] is not read by the graph…`) rather than silently dropped;
//   - **`filterInputs`** at all — that field says which *file* feeds which pad,
//     and a capture's graph is fed by its devices.
//
// Every device is opened by this call, on the calling thread, so "there is no
// camera called that" is a throw from `record.start` with the device that
// failed named in it — not a job that starts and fails a moment later with the
// second of two devices to blame and nothing saying which.
//
// One input keeps its own media timestamps, so a `-f lavfi` source still
// records faster than real time. Several run on the wall clock: a tick per
// output frame, each video feed sampled at the tick and the previous picture
// pushed again where nothing new arrived. Sound is not sampled — it is pushed
// as it arrives through `aresample=async`, because two devices are two crystal
// oscillators and a repeated block of samples is audible where a repeated
// picture is not. See ffmpeg_capture.h for why each of those is what it is.

// **`also` is the other files this one recording writes, all at once.** Each
// entry is a whole output spec — the same shape the recording's own output is,
// read by the same reader — so it names its muxer, its encoders, its options
// and its `streams`. A stream fed from `pad:<label>` is `-map [label]`: that is
// how a second file says which of the graph's ends it is of.
bro.ffmpeg.record.start({ sources: [{ path: 'video=Cam A', format: 'dshow' },
                                    { path: 'video=Cam B', format: 'dshow' }],
                          filterGraph: '[0:v][1:v]hstack[vout];' +
                                       '[vout]split[x][y];[y]crop=iw/2:ih:0:0[left]',
                          path: 'out/both.mkv', format: 'matroska',
                          also: [{ path: 'out/left.mkv', format: 'matroska',
                                   streams: [{ kind: 'video', source: 'pad:left' }] }] })

// This is what `-f tee` is *not*: tee writes one encode to several places, and
// two files off two pads are two encodes of two different pictures. It is also
// what a render's `passes` cannot be here — a render writes two sizes by
// walking its range twice, and a recording has no second walk, so its files are
// several muxers open beside each other on the end of one pass.
//
// Session-wide and not per file: the devices, the graph, `-t`, the sample rate
// and the channel count, and the **rate** — placing a frame is turning the
// moment it arrived into an output frame number, and two files answering that
// differently would disagree about when the recording started. `fps` on an
// `also` entry is not read. Per file: `path`, `format`, the encoders and their
// options, `streams`, and `width`/`height` — a file that names a size keeps it
// (the writer's scaler takes the difference), and one that names none takes the
// pad's. An absent `also` is the recording that writes one file, which is every
// caller that has never heard of the field.
//
// Refused, with the path named: **two files aimed at one path**. One muxer per
// file, and two writing to one interleave into something no player reads.
//
// `piecesWritten` still means what it means for a render — what a muxer opened
// *beyond* the file it was named with, the segments of a `segment` run, the
// slaves of a `tee` — so two files asked for by name report zero. `bytes` is
// the sum of all of them; `framesDone` is the first file's, because a counter
// that jumped between two files' clocks would be about neither.

// `source.t` is `-t`: how long to record for, and **zero means until stopped**.
// It stays per input with a `sources` list, and **the shortest of them is the
// session's** — an input that has run out has nothing further to offer the
// graph, so going on would be recording the others over a picture held still.
// With no `-t` the job reports `openEnded: true`, `totalFrames: 0` and
// `progress: 0` — zero meaning nobody knows, the same rule `probe()` follows
// for an input with no length. Anything drawing a progress bar has to read
// `openEnded`: a fraction of an unknown total is zero, and a bar sitting at
// zero for ten minutes says "stuck" rather than "recording".
//
// A recording that is stopped reports `done`, not `cancelled`. Nothing was
// abandoned — the length was the open question and stopping answered it — and
// the trailer goes down either way, so what is on disk opens.

// ── Watching, without writing ──────────────────────────────────────────────
//
// A **session** reads the same devices through the same `CaptureGraph` and
// writes nothing. It is not under `record` and not under `render`: it produces
// no file, holds no job slot, and shares no status with either — the whole
// point of one is to be running while nothing else is.
bro.ffmpeg.live.open({ sources: [{ path: 'desktop', format: 'gdigrab' },
                                 { path: 'video=Elgato Facecam', format: 'dshow' }],
                       filterGraph: '[1:v]scale=480:-2[pip];' +
                                    '[0:v][pip]overlay=W-w-32:H-h-32[vout]',
                       fps: 30 })
// → 7, the session's id. Throws with the device named when one will not open,
//   on this thread, for the reason `record.start` does.

bro.ffmpeg.live.pads(7)
// → [{ name: 'in0',   device: true,  sound: false, width: 2560, height: 1440,
//      src: '/@live/7/in0' },
//    { name: 'in1',   device: true,  sound: false, width: 1920, height: 1080,
//      src: '/@live/7/in1' },
//    { name: 'in1:a', device: true,  sound: true,  src: '/@live/7/in1:a' },
//    { name: 'vout',  device: false, sound: false, width: 2560, height: 1440,
//      src: '/@live/7/vout' },
//    { name: 'aout',  device: false, sound: true,  src: '/@live/7/aout' }]

bro.ffmpeg.live.levels(7)
// → [{ name: 'in1:a', heard: true,
//      channels: [{ name: 'FL', truePeak: 0.53, peak: 0.51, rms: 0.19 },
//                 { name: 'FR', truePeak: 0.12, peak: 0.12, rms: 0.04 }] },
//    { name: 'aout',  heard: true,
//      channels: [{ name: 'FL', truePeak: 0.63, peak: 0.63, rms: 0.24 }, …] }]

bro.ffmpeg.live.close(7)     // and `live.close()` with no id closes every one

// **`src` is what a `<video>` takes**, and playing one is the whole API: the
// engine's media backend resolves `/@live/<id>/<pad>` to a reader of that pad,
// so a live composition is an element like any other and there is no second
// path for pixels to arrive by. It is made here rather than spelled out by the
// caller, because the token's shape is this binary's.
//
// One pad per input that has a picture — `in<N>`, the device exactly as it
// arrived, numbered as the graph numbers it — plus one per pad the graph
// produces, under the graph's own name, with the composite called `vout`.
//
// **A sound pad has a `src` as well as a level, and pointing an element at it
// is a decision.** One per input that has sound, named `in<N>:a` the way ffmpeg
// names that stream, plus one per sound pad the graph produces, with the mix
// called `aout`. Playing one is *monitoring*: the session queues that pad's
// blocks only while something is listening, so the element is the switch —
// there is nothing to turn on and nothing to turn off, and an element that is
// muted rather than removed is still a queue being filled. It plays out of
// bro's mixer, which is the system's own output; nothing here chooses a device,
// and nothing ducks, gates or mutes an input while a monitor is on, because
// whether a microphone can hear those speakers is a fact about the room.
//
// The level is there whether or not anybody is listening — measuring a block
// costs nothing and is what a meter is for — which is why these are two
// separate answers about one pad rather than one.
//
// `levels` is where the numbers are, and **the call clears them**: each reading
// covers the stretch since the last call, scaled so that full scale is 1.0. So
// there is exactly one caller, once a frame. Two would halve each other's
// windows and draw two meters that disagree, and a peak left standing would make
// a moment of clipping look permanent. `heard: false` means nothing arrived in
// that window at all, which is a device that has stopped rather than one
// delivering silence — said, because a zero cannot tell them apart.
//
// **One reading per channel, named as libav names them.** A mono summary of a
// stereo pair with a dead side is a perfectly healthy-looking number, which is
// the fault a meter is there to catch that nothing else is; the names come from
// `av_channel_name` on the frame's own layout, and are `1`, `2`, … for a device
// that never said what its channels mean.
//
// **`truePeak` is 4× oversampled and `peak` is the loudest sample**, and the
// distance between them is a reading of its own — a mix with a decibel of
// inter-sample peak in it has been through something that squared its waveform
// off. A meter should draw `truePeak`, which is the one that says whether an
// encoder or a converter will clip; both are here so that whichever is drawn can
// be labelled honestly. Sound that starts abruptly reads about a decibel over on
// `truePeak`, because a step is not a band-limited signal and every oversampling
// meter rings on one.
//
// A peak above 1.0 is not an error and not clamped: a mix is a sum, sums exceed
// full scale, and that is the reading a meter exists for.
//
// `pads` is asked rather than returned by `open` because a pad's size is not
// known until libavfilter has configured the graph, and it cannot configure
// until a device has handed over a frame. The device pads exist the instant
// `open` returns; the graph's appear a moment later.
//
// **A recording opens its own devices**, so `record.start` closes every session
// first. A DirectShow camera held by something watching is not a slow
// recording, it is one that fails at the open.

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
  { kind: "video",                  // "video" | "audio" | "subtitle" | "data"
                                    //   | "attachment"
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
  // `copyFrom`/`copyTo` are the span read out of the input, on the input's own
  // clock — and **the two ways of reading cut differently out of the same two
  // numbers**, which is the one thing about them worth knowing. A `decode:`
  // row keeps a cue by where it *begins*, so a cue that was on screen at
  // `copyFrom` but started before it is dropped, and `copyFrom` is the output's
  // zero exactly. A `copy:` row is packets from a backward seek: it begins on
  // the cue at or before `copyFrom` — still on screen at that moment or long
  // finished — and *that cue's* stamp is the output's zero. Which is the
  // keyframe story in subtitle vocabulary. `bro.ffmpeg.cueTimes` is what a
  // caller draws either against, and `bro.ffmpeg.cueText` is what puts the line
  // it is cutting into beside the number.
  //
  // **Pictures of text are refused rather than converted.** `dvdsub` and
  // `hdmv_pgs_subtitle` carry bitmaps; the pairing is refused by name before
  // anything opens, because arriving as "Bitmap subtitle required" at the
  // first cue is true and unusable.
  { kind: "subtitle", source: "decode:1:0", codec: "mov_text", language: "eng",
    disposition: "+default" },
  // A data stream — timed metadata, a camera's timecode, an action camera's
  // telemetry. **The one kind that can only ever be copied**, and unlike the
  // subtitle rule above that is not a gap: nothing here composes one and there
  // is no `decode:` half, because there is nothing to decode it into. What the
  // packets mean belongs to whatever reads them, which is exactly why carrying
  // them through is worth doing and interpreting them is not.
  //
  // `codec`, the option bag and the bitstream chain have nothing to configure,
  // for the reason they have nothing to configure on any copy. `copyFrom`/
  // `copyTo` mean what they mean elsewhere, and — as with cues — there are no
  // keyframes to land on, because every sample stands on its own.
  //
  // Its fourcc travels with it, taken from the input rather than looked up: a
  // muxer's tag tables are video, audio and subtitle, so there is nothing to
  // validate `gpmd` against and dropping it would write a track of the right
  // length at the right times that nothing can identify. **Whether the output
  // container holds one at all is the muxer's own answer**, arriving from
  // `avformat_write_header` — mp4, mov and MPEG-TS carry a data track and
  // Matroska refuses one.
  { kind: "data", source: "copy:0:3" },
  { kind: "attachment", path: "…/font.ttf", mimeType: "font/ttf" },
]
chapters: [{ start: 0, end: 12.5, title: "Opening" }, ...]
```

A malformed entry is a `TypeError` naming it — `streams[2] is a 'chapter'` —
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
canvas — `{ input, start, length, speed, inPoint, x, y, w, h, crop, opacity,
volume, muted, z }`. `input` indexes `inputs`; a clip carrying a `path` and no
index is that path opened plainly, which is what every spec written before inputs
existed means and still does. Rectangles rather than fit/zoom/pan modes on purpose:
the layout is worked out once, in `ui/viewer.js`, and both the screen and the
encoder are driven from the same answer.

**`length` is on the timeline and `speed` is the slope**, so the seconds of the
source a clip covers are `length * speed` and the source time for an output time
is `inPoint + (t - start) * speed`. `speed` defaults to 1 and anything not
positive reads as 1 — zero would be a freeze frame and negative would be reverse,
and neither is expressible on a path whose readers walk forward. The **sound is
resampled**, not time-stretched: the input rate handed to `swr` is the file's
multiplied by the speed, which is `asetrate=<rate>*<speed>,aresample=<rate>` in a
filtergraph, so the pitch moves with the speed and the two render paths describe
one render.

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

