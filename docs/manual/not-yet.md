[← The manual](README.md)

# Not yet

Honest list of what does not work:

- **A filter that resizes the picture, on playback.** Most of them play now —
  see [A filter in the viewer](graph.md#a-filter-in-the-viewer) — and the exception is
  the one where the viewer's own layout and the render's disagree: this
  application places a clip by the rectangle its *source* has, and libavfilter
  hands back whatever size the chain made. Showing that stretched into the
  rectangle would be a picture the render never produces, so the clip keeps its
  `fx` badge and the badge says both sizes. Fixing it properly means the
  placement rectangle coming from the chain's output rather than from the
  probe — one number, in one place, and a change to what a clip's size *is*.
- **Scrubbing a node.** ▶ plays one forward from where the previews were taken,
  and that is the only way to move through it: there is no scrub bar, no way
  back, and nothing to jump with. Somewhere else to start from means moving the
  playhead and pressing `At playhead`.
- **Undo on the Encode and Write stages.** `Ctrl-Z` covers the edit — the
  clips, the inputs, the canvas and the graph — and stops at the form; see
  [Undo](document.md#undo) for why, which is that a control you just changed is
  in front of you with its old value one keystroke away, and that a `Ctrl-Z`
  pressed on the timeline which silently reverted a codec three stages away
  would be worse than none. Whether that is the right line is a real question
  and it has not been tested on anybody. What would have to come first is a
  single "the settings changed" channel: the encode side has three change hooks
  meaning three different things, and none of them is that.
- **A generated source in the viewer.** A `testsrc` or a `movie` renders and
  previews on its own card, and the *viewer* cannot show it — no longer because
  there is no filtergraph in the playback path (there is one now, per clip), but
  because a generator is a node with **no clip**. Every element on the program
  monitor belongs to something laid out on the timeline: it is where the picture
  goes, how long it is there and which moment of it is on screen. A `color`
  feeding an `overlay` has none of those, and a render with nothing on the
  timeline at all is therefore something you watch on the Graph stage and on the
  Encode stage's preview. What would close it is a lane that holds a generator
  as though it were a clip — a length and a position for something that has
  neither of its own — which is a decision about the *edit* and not about
  playback.
- **A generator that follows the render on its own.** A source now says when
  its numbers and the render's have drifted apart, and `Match the render` brings
  it up to date in one press — but nothing does it unasked, because a `color`
  feeding an `overlay` as a badge is *meant* to be its own size and there is no
  way to tell those apart from the node alone. Deciding it would mean tracing
  what each generator reaches and what resizes it on the way, which is a real
  piece of work and not a missing line.
- **A document that remembers where you were in it.** The edit is a file now —
  see [The document](document.md) — and what a document holds is the *edit*: the
  inputs, the clips, the canvas, the graph and the output settings, with the ids
  that the graph's anchors and source nodes are written against. What it does not
  hold is the session around it: which clip was selected, where the playhead was
  standing, which stage you were on, how far the timeline was zoomed. Those are
  the running application rather than the edit, and adding them would mean
  deciding whether opening somebody else's document should move *your* playhead —
  which is a question about what a document is for, not a missing field.
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
- **A measurement that re-runs itself.** A finding that has stopped describing
  the edit now says so and stops being offered, but nothing measures again on
  its own — `Measure now` is a press. Doing it automatically would mean deciding
  when a render is cheap enough to spend without being asked, which is a
  question about somebody's machine and not about this code.
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
- **A programme-wide burn-in in the viewer.** The other of the two burn-in
  points, over the whole canvas, is not shown: the viewer composites by placing
  one element per clip, so there is no single picture for a filter after the
  composite to run on. That is the same absence as a generated source in the
  viewer, above, and the same thing would close both — an export preview that
  runs while you edit rather than when you ask for one.
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
- **Hearing a recording before you commit to it.** The levels are now shown —
  see [Capture](capture.md) — and hearing it is still not. Nothing on this stage
  makes a sound, because that is *monitoring* and monitoring asks questions a
  meter does not: whose speakers, and what happens when the microphone can hear
  them. A sound pad publishes a level and no frames, so playing one would mean
  the tap carrying audio as well, an output device chosen somewhere, and an
  answer to feedback — three decisions, none of which the meter needed.
- **A file beside a device on the same graph.** A capture's graph is fed by its
  devices and by nothing else, at both ends of the seam: the walk that builds it
  refuses a file input by name, and `filterInputs` — which says which *file*
  feeds which pad — is refused by the engine outright. Overlaying a title card on
  a screen grab as it records is therefore not something this can express, though
  a `color` or a `testsrc` beside the device is, because a filter with no inputs
  makes its own frames and nothing has to pull one. A graph whose filters want a
  graphics card is refused the same way, because `-filter_hw_device` has nowhere
  to be said on this stage.
- **A destination editor on the Capture stage.** Recording and streaming the
  same capture works — it is `-f tee` and the same `Writer` — but the argument
  is typed into the path field there rather than built from a list. The Write
  stage has the editor, and a second copy of the escaping would be a second
  answer to it. **Also write** is a list on that stage and is not this: it is
  several encodes running at once, one muxer each, and every row of it has a
  path field of its own that a tee argument can be typed into.
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
- **A copy that keeps following the timeline.** `Follow the clip` and `Cut
  <file>` take the span off the edit — see [Copying instead of
  encoding](rendering.md#copying-instead-of-encoding) — and what they leave behind is two
  ordinary numbers. Trim the clip afterwards and the row does not move: a
  binding would be a second source of truth for `copyFrom` and a hidden mode to
  be in or out of, so the connection is a press rather than a link. Whether
  that is the wrong trade is a real question and it has not been tested on
  anybody yet.
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
- **A hardware decode chosen for you.** Nothing looks at the file, the machine
  and the render and picks. It could: the measurement is in this README and the
  shape of the answer is clear (software decode, hardware encode, above SD).
  Doing it would mean choosing on somebody's behalf and then having to say so,
  which is a design problem and not a plumbing one.
- **Speed on a render.** `J`/`K`/`L` and the speed selector are transport
  controls, not part of the edit, so a clip exports at its own rate whatever
  the viewer was last playing at.
- **A ripple that crosses tracks.** Alt-dragging ripples the track it is on and
  no other, which is right for a title on V2 placed against a shot on V1 and
  wrong for a programme cut across a stack. Which tracks move together is a
  decision about locking them, and there is nothing here that says — so the
  safe half is built and the other half needs a control before it can mean
  anything.
- **A meter, as opposed to a waveform.** A1 is drawn in dB with a line where
  clipping is, so an over can be *found* on the timeline — but it is the
  analysis's peaks, which is a bucket's worth of samples at a time and not a
  true-peak reading, and it is per clip rather than per output channel. What is
  not here is a level meter beside the viewer showing what is leaving *now*,
  which is the same missing piece as monitoring a capture below and would be
  the same mechanism.
- **Finding things by sound.** Reviewing wildlife footage, the birds are
  audible long before anything is visible; nothing yet marks where a call
  happens so you can jump between them. bro has the parts — `bro.sense` for
  onset and tonality, `bro.kws` for open-vocabulary spotting.
- **A second GPU used for anything.** `-hwaccel_device` and
  `-filter_hw_device cuda:1` reach one by index, and this machine has two — but
  nothing splits a render across them, and the obvious thing to do with the
  second card (render the A/B preview's reference on it while the candidate
  runs on the first) needs the one-job-at-a-time slot to become two.
