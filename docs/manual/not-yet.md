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
- **A value animated against anything but the clock.** Expressions in a filter's
  own options are surfaced now — see [what a value does over
  time](graph.md#what-a-value-does-over-time): the value is drawn as a curve over
  the render, points can be placed and dragged, and what the editor writes it
  reads back. Two things about that are not what they could be, and both are the
  same missing number rather than a missing control.

  **`t` is the only variable this application can put a value to.** An expression
  of `in_w`, `main_h`, `text_w` or `overlay_h` parses perfectly well, goes to the
  render exactly as written and is refused a curve *by name*, because the picture
  size part way down a graph is what the chain above it makes and nothing here
  knows it without running the graph. The node previews do run it — that is what
  the ▶ on a card is — and joining those two up is what would close this: a size
  reported by a preview, handed to the evaluator as `in_w`, with the curve saying
  which run it was drawn from and going away again when the graph changes under
  it. `n` is refused for a sharper reason and would not be closed by that at all:
  it counts frames arriving at *that filter*, and there are deliberately two
  frame rates here — `projectFps()` and `outputFps()` — with a `setpts`, a clip's
  speed and any `fps` of yours in between, so a curve against a guessed rate
  would be right at zero and wrong everywhere else in the direction nobody
  notices.

  **And what a filter means by a variable cannot be asked.** libav publishes
  nothing: the names are `static const char *const var_names[]` in each filter's
  own C file, not in the AVOption table and not on the AVFilter, and
  `av_expr_count_vars` only says which of the names *you supplied* occur. Two
  consequences are lived with rather than solved. A `t` a filter does not have
  makes libavfilter refuse the whole graph, which is loud and is the right
  authority. And a filter that means something else by `t` — `drawbox` and
  `drawgrid` mean the box thickness, measured: `drawbox=x='t*10':t=3` draws an
  unmoving box at x=30 at every timestamp — gets no curve, found by the one thing
  that *is* askable, which is that its own option table has a string option
  called `t`. That rule holds for those two out of the thirty filters in this
  build carrying an option of that name, and it is a rule about a habit rather
  than a published fact.

  Two smaller things sit beside them. The points editor writes one shape and
  reads that shape back — `lerp`/`clip`, nested in `if(lt(t,…))` past two points
  — and **an expression of your own, or a hand-edited version of one of its own,
  comes back as "not points"**. That is the contract rather than a gap: a
  generator that could not re-read its output would be a one-way door. What is
  genuinely not here is any *shape* but a straight line between two moments;
  ffmpeg's evaluator has the arithmetic for an ease, and nothing writes one. And
  the curve is in the column beside the graph and on the card, and nowhere near
  the picture: there is no handle on the viewer to drag a crop window along, the
  way the When lane put a span on the timeline.
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
- **A live device on the timeline.** This entry used to name two things and was
  wrong about both. It said a device has no length for a clip to have, and it
  said that a camera composited with a title and streamed out "needs the render
  loop to run on the wall clock". Neither survived being measured.

  **The named case is built, and it is the Capture stage.** A device, a title
  over it in a `movie` node, an `overlay`, and a destination that is a URL: one
  recording, and every part of it was already here. A recording *is* the wall
  clock — one tick per output frame, every feed sampled at the tick — and a
  `Writer` is a muxer, so `udp://`, `rtmp://` and `srt://` reach one for the
  reason they do on the Write stage. `tests/capture_test.cpp` records exactly
  that against a UDP listener bound on the loopback in the same process and gets
  29140 bytes back, beginning with an MPEG-TS sync byte. Nothing had to be built;
  what was missing was anybody having tried it.

  **And the render loop is already on the wall clock wherever a device is in
  it**, which is the part that is worth knowing rather than the part that is
  missing: `av_read_frame` blocks until the device has a frame, so a render that
  reads one is paced by it and no clock is consulted. Measured with `-f lavfi -i
  testsrc=…,realtime`, which is a device that produces in real time: two seconds
  of a graph render take **2024 ms** against 65 ms off the same device without
  the `realtime`, and a device feeding a `filterInputs` pad is not refused for
  that reason. There is no loop to write.

  What is genuinely refused, at both ends, is a device as a **clip** — and the
  reason is the *seek*, not the length. `Stop at` gives a device a length, the
  same way it gives a `-loop 1` still one; that is why the refusal is now keyed
  on what the input **is** rather than on what it measures, which is a hole this
  entry's own wording hid. The compositor asks a source for the picture at
  `inPoint + (t − start) × speed`; a libavdevice demuxer has no `read_seek`, so
  the answer is `Invalid argument` and the moment asked for has either not
  happened or has gone. Measured before it was refused: two seconds of output off
  the real-time device cost 2038 ms untrimmed, **3040 ms trimmed one second in
  and 5061 ms trimmed three seconds in**, and the file was two seconds long every
  time — a trim on a device is a *wait* of exactly its own length, and nothing in
  the file says so.

  So what remains is one thing and it is not a mechanism: **a device inside the
  timeline compositor** — with a rectangle, in and out points, a track under
  another one and a transition into the next shot. Closing it does not want a
  clock. It wants an answer to what a trim, a scrub, a second render and an undo
  *mean* when the source cannot be asked twice: a `.fbro` is a description that
  can be rendered again, and a device clip renders different content every time
  it is run, which is the thing an edit is not. The honest route is the one the
  application already takes — record it, and then it is a file, and a file can be
  cut.
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
- **An `-i` beside a device on the same graph.** This entry used to say a *file*
  could not be there and that a title card over a screen grab was therefore
  inexpressible. That was wrong, and wrong by its own reasoning: it allowed a
  `color` or a `testsrc` "because a filter with no inputs makes its own frames
  and nothing has to pull one", and `movie` is a filter with no inputs. See [A
  file in the graph](capture.md#a-file-in-the-graph) — a `movie` node beside the
  device works, and is *pulled in step with it* rather than racing ahead, because
  a push-and-drain graph asks a source filter for one frame per output frame and
  no more.

  What is still refused is an **input node** — a real `-i` — in a capture's
  graph, at both ends of the seam: the walk that builds it refuses one by name,
  and `filterInputs`, which says which file feeds which `[n:v]`, is refused by the
  engine outright. The reason is the shape rather than the file: those pads are
  buffersrcs the recording loop pushes device frames into, nothing pushes a file,
  and pulling one backwards from a sink is what a *render* does and what a device
  cannot be asked for. The cost of that refusal is everything an `-i` carries and
  a `movie` does not — a forced demuxer, `-probesize`, `-ss`, `-t`, `-loop`,
  `-stream_loop`, a protocol's option table — so a file whose *opening* has to be
  described is still a file to render with rather than to record with. A graph
  whose filters want a graphics card is refused separately and for its own
  reason, because `-filter_hw_device` has nowhere to be said on this stage.
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
- **A data stream drawn over the picture, or cut on.** A `gpmd` telemetry track
  is read now and plotted beside the waveform — see [Reading a data
  track](sources.md#reading-a-data-track) and [the Data
  lane](timeline.md#the-data-lane) — which is one of the three things this entry
  used to name. The other two are not here, and neither is one line.

  **The parser is per format, and there is one.** The seam is the fourcc, as this
  entry always said it would be: a data stream whose fourcc is X is read by the
  parser registered for X, and `gpmd` is the row that is filled in. A real GoPro
  file carries `tmcd` and `fdsc` beside it and a phone writes `mebx`, and each of
  those is a different specification — so the button is offered against the one
  that can be read and not against the others, which is a refusal by name rather
  than a parser that guessed. Adding one is a native file and a row in a table
  and no change in `ui/` at all, because the list of fourccs is asked of the
  registry.

  **Drawn over the picture** is closer than it was and is still not free.
  Everything a burn-in needs exists — a render writes a subtitle file beside the
  output from cues the document holds, and `subtitles=` puts them on the frames —
  so "speed, bottom left, updated four times a second" is a *generator*: a cue
  every quarter-second with a formatted number in it. What is missing is the
  decision that generator has to embody, which is a format. A number needs a unit
  and a rounding and a place on the frame and a style, none of which is in the
  file, and every one of which is a control on a stage that does not exist yet.
  Doing it by writing cues into the Cues lane would work today and would be
  dishonest in one specific way: those cues are *content somebody typed* as far
  as the document is concerned, so they would be saved, undone and re-edited as
  if a person had written them, and re-reading the track would not update them.

  **Cut on** is a different piece of work and a bigger one. The lane can be
  looked at and cannot be acted on: there is no "put a cut wherever the
  accelerometer goes over 20", which is a threshold, a hysteresis, a minimum
  shot length and then an edit that makes clips. The Measure stage is where the
  shape of that already exists — a filter measures, a finding is a moment, and
  the Report drawer marks them — and joining the two would mean a reading being
  a *source of findings* rather than a line on a lane. That is the honest way in,
  and it is a stage's worth of design rather than a missing wire.

  Two smaller things sit beside them. A reading is **decimated to two thousand
  buckets** on the way in, which is what makes two hours of 200 Hz accelerometer
  the same size as twenty seconds of it — the numbers printed beside a row are
  exact, over every sample, but zooming the timeline past the decimation shows the
  decimated line rather than more of it. Closing that is a window on the call
  (`bro.ffmpeg.data.reads.start` already takes a bucket count) and a re-read per
  zoom, which is a decision about how often a file is opened rather than a
  mechanism. And **which series you picked is not saved**: a reading is derived
  and rightly out of the document, but the pick is an editorial choice and losing
  it on reopen is a press nobody should have to repeat — it wants a home in the
  workspace, keyed by something that survives an input being renumbered.
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
- **Two renders at once, one per card.** The second card is *chosen* now — see
  [A second card](card.md#a-second-card): this application asks libav how many
  devices of each type there are, `Which one` on Sources is a picker of them
  rather than a number to type, and a render points at either one through
  `-hwaccel_device` and `-filter_hw_device cuda:1`. Both are measured, and they
  are not the same card: on this machine card 1 is 4% behind card 0 on the same
  1080p render, because it is on a x4 PCIe link.

  What is not here is **two renders at the same time**, which is what this entry
  used to call the obvious thing to do with the second card. It named the case:
  render the A/B preview's reference on it while the candidate runs on the
  first. That case was wrong twice over and both halves were measured before
  anything was built.

  **The reference cannot use a card.** It is `libx264 -crf 0`, deliberately —
  the comparison is only worth looking at because the reference is what the
  compositor produced before any encoder saw it — so there is nothing in it for
  a GPU to do. Reference and a 1080p NVENC candidate: 1.09 s one after the
  other, 0.84 s at the same time, and **0.92 s with the candidate moved to the
  second card**, which is slower than leaving it on the first. The win is
  entirely the second *job*, and the second card is a 9% loss on top of it.

  **And the card is almost never the thing in the way.** Two ordinary 1080p
  renders — software decode, `hwupload`, NVENC, the arrangement `Choose for me`
  picks — are 1.58 s alone, 1.66 s for two on one card and 1.67 s for two across
  both, because the first card was never busy. Only a 4K `hevc_nvenc p7` render
  with its decode on the card too saturates one: 13.6 s alone, 17.2 s for two on
  one card, 13.7 s for two across both, against 27.1 s sequential. Even there
  most of the win is running two at all rather than the second card.

  So what stands between here and two renders is the slot, and the slot turns
  out to be holding more than a flag. Three things in `ffmpeg_job.h` — one
  status, one stop, one thread — would widen readily, and `render.poll()` and
  `render.cancel()` would grow an id with them. The other four would not.

  **The report cannot say which of two renders said something.** Every line
  libav emits arrives through one global `av_log` callback which is handed an
  `AVClass**` and nothing else; there is no job in it, so `LogRecord::job` and
  `MetaRecord::job` — what the Report drawer filters on and what every
  measurement on the Measure stage is read back by — can only ever mean "the
  render running now". A thread-local would cover most of it and not the part
  that matters: counted across the whole export suite, 866 of libx264's 867
  lines and every one of the filters' come from the job thread, but **all four
  of `fifo`'s recovery lines and all eight of `hls`'s do not**, because those
  components recover and write on threads of their own. Those four are exactly
  `WriteRecovery`, which is the count that says a render's file has a gap in it.
  Doing better means a registry of every libav context each job owns, matched
  against the pointer, and a filter's private children are not in it.

  **The slot is a priority ordering, not only an exclusion.** The node previews
  on the Graph stage yield to an export and to the A/B preview by reading
  `render.poll().state`, which is the whole of how "a preview is the least
  important render in the application" is implemented. With a second slot free
  there is nothing left to yield to.

  **It is what keeps a recording alone with its devices.** A DirectShow camera
  opens once; a recording closes every live session before opening its own, and
  the live session holds no slot precisely so that watching can happen while
  nothing is being written. Two slots make two recordings reaching one camera
  newly possible.

  **And a version is a pass because there is one slot.** Two output sizes are
  two encoders and therefore two walks, and `ExportPass` exists to make that one
  job with one Stop and one status rather than two.

  Which adds up to: the second slot is worth 1.30× on the one case anybody would
  use it for, and costs the report the ability to say which render said what. So
  the numbers are here instead of the feature.
