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
- **A generator with a place on the timeline.** A `testsrc` or a `color` plays
  on the program monitor now — `O` shows
  [the output itself](playback.md#the-output-instead-of-the-clips), and a render
  rooted entirely in generators, with nothing on the timeline at all, plays there
  — so the *picture* is no longer the missing half. What is missing is the edit:
  a generator has no lane, no bar to drag, no in and out points, and the only
  thing that says how long one is is its own `d`. Every element the viewer places
  belongs to something laid out on the timeline — where the picture goes, how
  long it is there, which moment of it is on screen — and a `color` feeding an
  `overlay` has none of those. What would close it is a lane that holds a
  generator as though it were a clip, which is a decision about what an edit
  *contains* and not about playback.
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
- **A span dragged *on* the timeline.** The playhead is on the When strip and
  can place either end of a span — see [When it is on](graph.md#when-it-is-on)
  — so the two clocks are reconciled in both directions now. What is still not
  built is the other reading of it: a span drawn as a region on the timeline
  itself, where the shot it is meant to cover is. That is a lane, not a button,
  and it would have to hold spans belonging to several nodes at once and say
  which is which.
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
- **An editor for the cues themselves.** Everything here reads a subtitle file
  and writes one; nothing lets you type a line, retime one against the
  waveform, or split a cue at the playhead. The timeline has the lane that
  would make it possible — A1 is where you would judge a timing — and none of
  it is built. What a person with a file that is a second and a half out has
  here is `-itsoffset` on the input, which shifts the whole track and is the
  right tool for exactly that one problem and no other.
- **Picture subtitles, anywhere but carried.** `dvdsub` and
  `hdmv_pgs_subtitle` can be carried into a container that holds them and
  nothing else: they cannot become `subrip`, because that is optical character
  recognition, and they cannot be burned in, because libavfilter's subtitles
  filter is libass and libass reads characters. Drawing one *would* be
  expressible — the packets are pictures and `overlay` draws pictures — but
  nothing here reads an input for its subtitle pad, so there is no wire to draw.
  Both refusals name the reason rather than failing at the first cue.
- **What a cue says, anywhere on the Write stage.** Where the cues are is drawn
  now — see [A track beside the picture](subtitles.md#a-track-beside-the-picture) — and it
  is times and nothing else, because it is read off the packets. So a window
  can be placed against the cue it lands in without the line it is cutting into
  being readable, which is the half of the question a person actually has when
  they are deciding where a programme starts. The words are a decoder per
  track, kept alive while the panel is open, and for `dvdsub` they are a
  picture with no text in it at all — so it is a second query with a second
  cost rather than a column this one forgot to fill in.
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
- **Speed on a render.** `J`/`K`/`L` and the speed selector are transport
  controls, not part of the edit, so a clip exports at its own rate whatever
  the viewer was last playing at.
- **A ripple that crosses tracks.** Alt-dragging ripples the track it is on and
  no other, which is right for a title on V2 placed against a shot on V1 and
  wrong for a programme cut across a stack. Which tracks move together is a
  decision about locking them, and there is nothing here that says — so the
  safe half is built and the other half needs a control before it can mean
  anything.
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
