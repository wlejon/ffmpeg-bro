[← The manual](README.md)

# Not yet

Honest list of what does not work:

- **A resize *below* the point where a clip is placed, on the cheap path.** A
  filter that resizes the picture on the way in is laid out at the size it made
  it now, on the program monitor and in the render both — a clip's size is what
  its chain makes of it, and there is one layout. A filter under the derivation's
  `scale` is the other thing: the render lays what comes out of it over the
  canvas *at its own size*, at the rectangle's top-left, and that is not a
  rectangle the viewer has any way to place. `O` plays
  [the output itself](playback.md#the-output-instead-of-the-clips) and shows it;
  the clips on the monitor keep the `fx` badge. Closing it would mean an element
  whose box is the chain's pixels scaled by the canvas, anchored rather than
  fitted and not clipped by the crop window — which is a second layout rule for
  one case, and a nearly-right picture is what the badge exists instead of. The
  same badge covers one chain it need not: a resize on the way in *and* a filter
  of yours below the `scale`, where one reported size cannot say which of the two
  did it.
- **A generator scrubbed to a moment.** A `testsrc` is a clip now — see [a
  generator, laid out like a clip](timeline.md#a-generator-laid-out-like-a-clip) —
  with a lane, a bar, in and out points, a rectangle and a `<video>` of its own
  playing its `-f lavfi -i` through the same backend every other clip uses. What
  that element cannot do is go to a moment: libavfilter's sources produce forward
  and the `lavfi` demuxer has no `read_seek`, so the picture on the monitor is the
  generator *running* rather than the generator at the playhead. For a `color`,
  `smptebars` or any other still pattern those are the same picture; for a
  `testsrc`'s counter or a `mandelbrot`'s zoom they are the right pictures at the
  wrong moment. For the same reason a generator clip is never the transport's
  master clock, and a timeline of nothing but generators runs on the wall clock the
  way a gap between clips does — so frame stepping inside one steps clip to clip.
  `O` plays [the output itself](playback.md#the-output-instead-of-the-clips) and is
  that moment exactly. Closing it means the element being a *view* whose chain
  carries a `trim` at the playhead and is rebuilt on every scrub — a reopen per
  gesture, which is what `views.define` already costs once per edit — or a seekable
  source in front of libavfilter's, which libavfilter does not have.
- **A generator that follows the render on its own.** A source now says when
  its numbers and the render's have drifted apart, and `Match the render` brings
  it up to date in one press — but nothing does it unasked, because a `color`
  feeding an `overlay` as a badge is *meant* to be its own size and there is no
  way to tell those apart from the node alone. Deciding it would mean tracing
  what each generator reaches and what resizes it on the way, which is a real
  piece of work and not a missing line.
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
- **Two-pass filters.** The mechanism is there — a render is a list of passes,
  each the render with overrides, run in one job through one slot — and the two
  filters that need it are `vidstabdetect`/`vidstabtransform`, which this build
  of ffmpeg was not configured with. So nothing in the UI offers a two-pass
  filter render, because there is none here to offer and a control for a filter
  the build does not have is a control that fails at parse. `loudnorm`'s two
  passes *are* reachable, by a different route: `ebur128` measures and the
  Report drawer offers `loudnorm` told what it found, which is one render and a
  decision rather than two renders.
- **A measurement that re-runs itself without being asked at all.**
  `Re-measure when stale` closes most of this — see [Measuring, and doing
  something about it](rendering.md#measuring-and-doing-something-about-it) — and
  what closed it was the toggle rather than the mechanism: whether a render is
  cheap enough to spend unasked is a question about somebody's machine, so it is
  asked once and then answered forever. What is still not here is anything that
  could answer it *for* them. Nothing measures how long the last measurement took,
  nothing knows whether this graph is a `cropdetect` over 640×360 or `libvmaf` over
  4K, and so nothing could decide to re-measure the cheap one and leave the
  expensive one alone. That is a cost model of a render, which the A/B stage's
  numbers are the beginning of and no part of this reads.
- **Reading a URL that keeps failing, and opening a device that hangs.** Both
  ends of *going wrong* on a network are built now. Reading: a URL is opened on a
  thread of its own with a deadline and a Stop that reaches libav's own interrupt
  callback — see [While it is connecting](sources.md#while-it-is-connecting).
  Writing: `Keep trying` wraps the muxer in ffmpeg's `fifo`, and a render that
  reconnected says so and counts the times — see [When the destination goes
  away](output.md#when-the-destination-goes-away). Three things around them are
  not.

  **Nothing turns the *reading* end's reconnection into a decision.**
  `-reconnect`, `-reconnect_streamed`, `-reconnect_at_eof` and
  `-reconnect_delay_max` are `http` protocol options and appear in the protocol
  column like any other, which is where they can be set — but "keep reading if
  the source drops" is the same shape of question the writing end now answers
  with one control, and it has no control of its own. It is a smaller piece of
  work than the writing end was, because there is no muxer to wrap: it is four
  keys in a bag the Sources stage already edits. What it needs is the same
  honesty about *counting* — an input that reconnected mid-render has a gap in
  it too, and `http` says so in the log the same way `fifo` does.

  **A recovery is counted out of what the muxer says**, because `fifo` keeps no
  counter and publishes nothing: the three strings matched are
  libavformat/fifo.c's own. A libav that reworded them would make the count read
  zero, which is the safe direction and is stated where it is done — but it is
  still a string match, and the alternative is a patch to libavformat.

  **A device's *probe* goes through the same mechanism now** — see [While it is
  connecting](sources.md#while-it-is-connecting) — and finding that out taught
  something the URL case did not have to face: the interrupt callback does not
  reach a device open at all. A libavdevice demuxer carries `AVFMT_NOFILE`, so
  `avformat_open_input` opens no AVIO layer and goes into the demuxer's own
  `read_header`, which is COM and a driver. Counted with a callback of its own,
  a 400 ms `dshow` open polls it **zero times** and an already-aborting one does
  not shorten it. So the thread is the whole mechanism there, the deadline
  covers only the `avformat_find_stream_info` that follows — 57% of a `dshow`
  open, 99.9% of a `gdigrab` one — and the button reads `Stop waiting` because
  that is all it does.

  **What is still opened on the UI thread is the live session and the
  recording**, which are not probes and cannot be routed through one: a probe
  answers with a `ProbeResult` and hands its file back, and both of these keep
  the devices. On the Capture stage a session is opened whenever the cards or
  the graph change, which is one `avformat_open_input` per device on the thread
  that draws — 400 ms for a `dshow` device with nothing wrong. It is bounded in
  practice, because a session only opens devices whose probe has just come back,
  which is the strongest evidence available that the open is quick; it is not
  bounded in principle, and a camera that answers a probe and then goes away is
  the case that would still freeze. `startCapture` opens on the caller's thread
  **deliberately** — "there is no camera called that" is a refusal that belongs
  to the call that asked for the recording, with the name that was wrong still
  on screen — so making that one asynchronous is a decision about where a
  refusal arrives and not only a thread.
- **A soft subtitle track in the viewer.** Cues burned into a clip are on the
  screen now — see [Burning them in](subtitles.md#burning-them-in) — and a track written
  *beside* the picture still is not: bro's `<video>` decodes pictures and
  sound, and a stream a player can switch off is neither. Faking one with the
  same filter would be the wrong answer rather than a partial one, because the
  two are different statements about the finished file and the whole value of
  the burn-in control is that it says which you meant. What is left is either
  a subtitle path through bro's renderer, or an overlay drawn by this
  application over the program monitor — and the second has the harder half of
  the problem in it, which is that a soft track is styled by the *player*.
- **A graph preview that keeps its sound when it cannot keep up.** The program
  monitor carries the render's soundtrack now — see
  [the output instead of the clips](playback.md#the-output-instead-of-the-clips)
  — and the trade that made it possible is that a late *picture* is dropped so
  the sound stays real time. The compositor can be skipped that way. A graph
  cannot: libavfilter holds every frame it has pushed at a sink until somebody
  takes it, so a pull skipped is memory grown rather than work saved, and a
  `filter_complex` slower than real time therefore gaps its sound rather than
  dropping its picture. Closing it means the sound leaving by a route the graph
  does not pace — a second walk over the range, or a buffer measured in seconds
  instead of frames — and both of those are a second answer to how far ahead a
  preview is allowed to be.
- **Cues seen where they will be, and cues that keep their styling through a
  retype.** A line can be typed, retimed against the waveform and split at the
  playhead now — see [Cues of your own](subtitles.md#cues-of-your-own) and
  [the Cues lane](timeline.md#the-cues-lane) — and two things about that are not
  what they could be.

  The first is that **the words are never on the picture.** The lane says when a
  cue is and the strip says what it says, and the viewer shows neither, for the
  reason the soft-track entry above gives: bro's `<video>` decodes pictures and
  sound. So writing a subtitle here is writing it against a waveform and a ruler,
  and the only way to see it over the shot is to burn a render's worth of it in
  with `subtitles=`. Closing it is the same piece of work as that entry — an
  overlay drawn by this application over the program monitor — with the same hard
  half in it, which is that a soft track is styled by the *player*.

  The second is that **retyping a cue drops that cue's override codes.** A track
  forked from a file keeps everything — its script header, and each cue's layer,
  style, margins and `{\i1}` — and a cue nobody retypes is written back byte for
  byte. The moment its words are replaced, the whole text field is replaced with
  them. Keeping the codes would mean deciding which `{\k40}` a retyped syllable
  belongs to, which is a guess, and the loss is stated per cue on the strip and
  counted on the Write stage rather than discovered afterwards. What is genuinely
  not here is any way to *write* one: there is no style editor, deliberately —
  writing an override from a control would be a second opinion about what it
  means and libass has the only one that matters.

  Two things it is worth saying are *not* missing. Nothing writes back to the
  file a track came out of, ever, which is a decision and not a gap. And
  `-itsoffset` on the input is still exactly the right tool for a track that is
  uniformly out: it shifts the whole thing with one number, which a hundred cue
  edits is a poor substitute for.
- **Picture subtitles as text, or through libass.** `dvdsub` and
  `hdmv_pgs_subtitle` can be carried into a container that holds them, and they
  can now be **drawn** — see [Drawing them, when they are
  pictures](subtitles.md#drawing-them-when-they-are-pictures), which is an input's own
  cues pad wired into an `overlay`. The two things they cannot be are the two
  they never could: `subrip`, because that is optical character recognition, and
  burned in with `subtitles=`, because that filter is libass and libass reads
  characters. Both refusals name the reason rather than failing at the first
  cue, and drawing is offered in place of the second. `Edit these cues` is
  refused for the first reason again — there is nothing in a picture of
  characters to type into — and it is the same `AV_CODEC_PROP_TEXT_SUB` behind
  all three.

  Three things about the drawn path are not what they could be. It opens the
  file a **second time** — one `-i` for the clip's picture and one for its cues —
  because the clip's own input node carries pads only for what the derivation
  reads, and teaching it to grow one on demand would mean an overlay's wires
  naming a port whose index moves when the clip is muted. The **viewer cannot
  show it**, because an overlay of two inputs is not one chain over one clip; `O`
  plays the render and has them in it. And `-canvas_size` is not surfaced: the
  size the cues are painted at is the one the file says, which is ffmpeg's own
  rule and is right until somebody has a file whose subtitle dimensions are
  wrong.
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
- **A live device on the timeline.** A device never ends, so nothing can be cut
  from it: there is no length for a clip to have and no seeking back to a
  moment that has gone. Forcing `-f dshow` on the Sources stage describes one
  correctly and refuses to lay it out, and the Capture stage is where one is
  watched and recorded. Live *through* the edit — a camera composited with a
  title and streamed out — is a different thing again and needs the render loop
  to run on the wall clock.
- **A monitor on a second interface, and a monitor of a mix that is not a pad.**
  Hearing a session is built — `Listen` beside a meter, see
  [Capture](capture.md) — and it plays out of bro's mixer, which is this
  machine's default output. Choosing *another* interface is not here: the
  decision was to name no device rather than to offer a list nobody has asked to
  pick from yet, and the day somebody wants a separate headphone bus it is a
  control on that stage and a bus in bro. The other half is that what can be
  monitored is a *pad* — a device's own sound, or an end of the graph — so
  "everything at once, at levels of my choosing" is a monitor mix, which is a
  little mixing desk and not a missing wire.
- **A file beside a device on the same graph.** A capture's graph is fed by its
  devices and by nothing else, at both ends of the seam: the walk that builds it
  refuses a file input by name, and `filterInputs` — which says which *file*
  feeds which pad — is refused by the engine outright. Overlaying a title card on
  a screen grab as it records is therefore not something this can express, though
  a `color` or a `testsrc` beside the device is, because a filter with no inputs
  makes its own frames and nothing has to pull one. A graph whose filters want a
  graphics card is refused the same way, because `-filter_hw_device` has nowhere
  to be said on this stage.
- **A variable frame rate out of the *compositor*.** A graph's own frame times
  reach the file now — see [Frame timing](output.md#frame-timing) — because frames
  leaving a libavfilter sink carry timestamps and the writer keeps them instead of
  numbering them. The track stack cannot join in, and the reason is not a missing
  line: `canvasAt(t)` composites the edit at whatever instant it is handed, so
  there is no set of times belonging to it, and a stack of clips at three
  different rates has no answer to *whose* timestamps that is not invented. So the
  control is present and refused with that sentence rather than absent, and a spec
  asking for it is refused before a file is opened. What would close it is a
  decision about which clip's clock an output frame is on — which is a real piece
  of design and not an interface change; the seam grew the paced pull it needed
  (`FrameSource::pacedClock`/`nextFrame`, answering "no" by default) and the
  compositor is the source that honestly answers no.

  Two smaller things sit inside the half that does work. A render whose video
  streams read named **pads** is refused `vfr` as well, because each pad leaves
  the graph at its own moments and one walk over the frames has one timestamp to
  hand over — writing them as renders of their own is the workaround and giving
  each stream its own clock is the fix. And `passthrough` is not offered at all:
  it differs from `vfr` only in handing libavcodec a timestamp that does not
  advance, which is a render that fails at a frame rather than a mode, so what
  this does with a repeated timestamp is drop the picture and say how many.
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
- **Anything a data stream carries, read.** A `gpmd` telemetry track is now
  carried through — see [Copying instead of
  encoding](rendering.md#copying-instead-of-encoding) — and carrying is the whole of it.
  Nothing parses one, so a GoPro's speed and GPS cannot be plotted beside the
  waveform, drawn over the picture or used to cut on. That is a parser per
  format rather than a gap in the render path, and the fourcc the row is named
  by is exactly what such a parser would dispatch on.
- **Hardware filters that this build does not have.** `hwupload`, `hwdownload`
  and `hwupload_cuda` are here; `scale_cuda`, `overlay_cuda`, `scale_qsv` and
  the rest of the device families are not, because a vcpkg ffmpeg with
  `nvcodec` is built without the CUDA compiler. Nothing in this application
  knows that — the palette offers whatever libavfilter reports — so a build
  that has them gets them with no edit here. What it costs today is that a
  render on the card cannot resize or composite on the card, only pass frames
  through.
- **Hardware anywhere in playback.** A clip whose input decodes on a device
  still has every frame brought down for the viewer, because bro's renderer
  takes planes it can read. That is the right trade — the readback is 3% and
  the decode is the slow half — but it does mean `-hwaccel` on the timeline is
  a setting that only costs.
- **A rule measured on the machine it is applied to.** `Choose for me` on the
  Encode stage picks — see [Choosing it for you, on a
  press](card.md#choosing-it-for-you-on-a-press) — and what it asks this machine is
  what it *has*: which device types answer, and which encoders they report that
  this build also carries. What it cannot ask is what any of that is *worth here*.
  The arrangement it applies — software decode, hardware encode, above SD — and the
  576-line threshold both come from one machine's numbers, a 16-core Ryzen with two
  RTX 4090s; a laptop with four cores and a QSV block would very likely measure a
  hardware decode as a *win*, and nothing in this application would notice. Closing
  it means running `tests/hardware_test.cpp`'s pass from inside the application, at
  these sizes, on the machine in front of you and keeping the answer — which is a
  benchmark somebody has to be asked to wait for, and then a second decision about
  when it is stale.
- **Speed that keeps the pitch, and speed under a filter of yours.** A clip has a
  speed now and the render performs it — see [Speed](timeline.md#speed) — and
  three things about it are not what they could be. **The pitch moves**, because
  speed here is a resample (`asetrate`, `aresample`) and preserving it would mean
  `atempo`, which is a libavfilter filter: `TimelineSource::mixInto` has no graph
  to put one in, so taking it would mean the internal compositor and the printed
  chain describing two different renders. What closes it is a WSOLA
  time-stretcher on the compositor path, which is a second home for something
  libavfilter already has — so the answer offered instead is the real one:
  `atempo` on the Graph stage. **The viewer will not show a filter placed below a
  sped-up clip's `scale`**, and keeps the `fx` badge: playback puts the render's
  clock back with a constant, and a speed makes that map a scale, which a
  constant cannot undo — a filter carrying `enable=` there would come on at the
  wrong moment on screen and the right one in the file. A filter *above* the
  clock is unaffected, because its `t` is the source's own timestamps either way.
  And the two render paths **choose one source frame differently** at a speed: the
  divided `setpts` puts the clip's frames on half the canvas's frame interval and
  `overlay`'s frame-sync rounds, so where the compositor takes source frame 2m the
  graph can take 2m−1. That is the disagreement the Graph stage already raises a
  caveat for when a source's rate differs from the output's — measured at one
  frame and never more (tests/export_test.cpp) — and closing it means an `fps`
  filter in the derived chain, which is a different render rather than a
  rounding fix.
- **A meter of the timeline's own mix, during ordinary playback.** There is a
  meter beside the viewer now — see
  [The meter beside the picture](playback.md#the-meter-beside-the-picture) — and
  with `O` on it is everything the entry this replaces asked for: the render's own
  mix, one bar per channel of the *output* at the count the encoder would be
  opened with, a **true** peak 4× oversampled rather than a bucket's loudest
  sample, measured off every block rather than sampled. The same meter draws the
  Capture stage's pads, on the same scale A1 is drawn on.

  With `O` **off** it is reading something weaker, and says so on the strip: bro's
  own metering of its master mix bus, which is a **sample** peak sampled once a
  frame, and **two** channels because that is the device's mix rather than the
  output's. That is where the remaining gap is, and it is not a missing line here.
  During ordinary playback the compositor is not running — the clips' `<video>`
  elements are, and bro's mixer is summing them — so there is no `mixInto` to
  measure and no tap to read one from. bro has no per-element meter either: the
  element's JS surface carries no level, `ElVideo` keeps its playback id private,
  and every element lands on bus 0, so `Bus::peakL/rmsL` on the master is the only
  place the question has an answer at all. Closing it means metering a playback
  instance in bro, or routing each element to a bus of its own so that the
  existing `getBusPeak*` could be asked per clip and summed — and then deciding
  what "the output's channels" means when the thing making the sound is a stereo
  device mix. Faking it from here — summing the clips' analysed peaks and drawing
  that — would be the waveform wearing a meter's name, which is exactly what the
  old entry was complaining about.
- **Finding things by sound.** Reviewing wildlife footage, the birds are
  audible long before anything is visible; nothing yet marks where a call
  happens so you can jump between them. bro has the parts — `bro.sense` for
  onset and tonality, `bro.kws` for open-vocabulary spotting.
- **A second GPU used for anything.** `-hwaccel_device` and
  `-filter_hw_device cuda:1` reach one by index, and this machine has two — but
  nothing splits a render across them, and the obvious thing to do with the
  second card (render the A/B preview's reference on it while the candidate
  runs on the first) needs the one-job-at-a-time slot to become two.
