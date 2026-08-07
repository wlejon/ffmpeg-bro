[← The manual](README.md)

# Not yet

Honest list of what does not work, how you would notice, and what to do
about it instead.

- **A resize placed below where a clip sits in its chain.** A filter that
  resizes the picture on its way *in* is shown correctly on the clips view and
  in the render alike. A filter *after* a `scale` further down the chain is
  not: the clips view has one layout rule and cannot place a rectangle that
  came out at a different size, so the clip is badged `fx` instead of shown
  wrong. Press `O` to see [the render
  itself](playback.md#the-output-instead-of-the-clips), which always shows it
  correctly.
- **A generator scrubbed to a moment.** A `testsrc`, `mandelbrot` or similar
  behaves like a clip on the timeline — see [a generator, laid out like a
  clip](timeline.md#a-generator-laid-out-like-a-clip) — but its `<video>`
  cannot be seeked: ffmpeg's generator sources only run forward. For a still
  pattern (`color`, `smptebars`) that makes no difference; for a `testsrc`'s
  counter or a `mandelbrot`'s zoom, scrubbing shows the generator running
  rather than the frame at the playhead, and frame-stepping across a stretch
  of nothing but generators moves clip to clip instead of frame to frame.
  Press `O` to see the moment exactly.
- **A generator that resizes itself to follow the render.** `Match the
  render` updates a generator's size to the render's in one press, but nothing
  does this automatically — a `color` used as an overlay badge is often
  *meant* to be its own fixed size, and there is no way to tell the two cases
  apart from the node alone.
- **A value animated against anything but the clock.** A filter option
  written as an expression can be drawn as a curve and edited by dragging
  points — see [what a value does over
  time](graph.md#what-a-value-does-over-time) — but only for `t`. Any other
  variable a filter's expression can use (`in_w`, `n`, `overlay_h`, …) is
  refused a curve by name: this application has no way to know what a filter
  further down the chain will make of the picture, so it cannot say what those
  variables will be. There is also no way to draw anything but a straight line
  between two points — no eased curve — and no handle on the viewer itself to
  drag, only the column beside the graph and the card.
- **Two-pass filters.** `vidstabdetect`/`vidstabtransform` need one, and this
  build's ffmpeg was not compiled with them, so nothing offers a two-pass
  filter render. `loudnorm`'s two passes are reachable a different way: run
  `ebur128` as a measurement and the Report drawer offers `loudnorm` with what
  it found, which is one render rather than two.
- **A measurement that re-runs itself with no cost model.** `Re-measure when
  stale` (off by default) re-runs a measurement automatically once you stop
  editing — see [measuring, and doing something about
  it](rendering.md#measuring-and-doing-something-about-it). What it cannot do
  is decide *for* you whether that is cheap: it has no sense of whether a
  given graph is a quick `cropdetect` or a slow `libvmaf`, so turning it on
  re-runs everything, not just what's cheap.
- **Reading a URL that keeps dropping, and a device that hangs on open.**
  Both ends of a flaky connection are handled for the *writing* side —
  `Keep trying` reconnects a broken output and counts the gaps, see [when the
  destination goes away](output.md#when-the-destination-goes-away) — and
  reading a URL has a Stop and a deadline while it connects, see [while it is
  connecting](sources.md#while-it-is-connecting). Three things around that are
  not yet as good:

  - Reading has no equivalent of `Keep trying`: if a URL input drops
    mid-render there is no one-press "reconnect and carry on" — only the raw
    `-reconnect*` protocol options on the input, which you can set yourself.
  - `Stop waiting` on a device that is slow to open (a camera, a capture card)
    stops this application from waiting; it does not reach into the driver
    and cancel the open. The device may still take its own time to answer in
    the background, and the input settles once it does.
  - Opening a live session or starting a recording opens each device on the
    same thread that draws the window. In practice this is quick, because it
    only happens right after a successful probe — but a camera that answers a
    probe and then stops responding can still freeze the window briefly.
- **A bitmap subtitle drawn as the picture it is, over the monitor.** `Cues`
  (`T`) draws a soft track's *text* over the picture — see [a soft track on
  the monitor](subtitles.md#a-soft-track-on-the-monitor-as-the-cues-it-is) —
  but `dvdsub` and `hdmv_pgs_subtitle` cues are pictures of characters, not
  text, so there is nothing to draw there: the overlay shows a line saying a
  picture cue is present instead. The render itself already puts these tracks
  on screen correctly — see [drawing them, when they are
  pictures](subtitles.md#drawing-them-when-they-are-pictures) — this gap is
  only in the live monitor overlay.
- **Any styling of a soft track at all, and that is permanent.** The monitor
  overlay draws a soft track's words and nothing else — no font, size,
  position or outline — because that belongs to whatever player eventually
  opens the file, and this application has no way to guess which one that
  will be. If you need a guaranteed appearance, burn the track in instead;
  see [burning them in](subtitles.md#burning-them-in).
- **A graph preview that drops sound instead of picture when it falls
  behind.** With `O` on, [the output](playback.md#the-output-instead-of-the-clips)
  keeps its sound real-time by dropping picture when the render can't keep up.
  A `filter_complex` graph preview cannot do the same trick — libavfilter
  holds every frame until something takes it — so a graph slower than real
  time gaps its *sound* instead. There is no workaround beyond a lighter
  graph.
- **Cues seen positioned on the picture, and cues that keep their styling
  through a retype.** Typing, retiming and splitting a cue works against the
  waveform and ruler — see [cues of your own](subtitles.md#cues-of-your-own)
  — but two things about that fall short:

  - The words are never shown over the shot while you write them, only on the
    lane and the strip. To see them positioned, burn a render's worth of them
    in with `subtitles=`.
  - Retyping a cue's text replaces the *whole* text field, including any
    override codes it carried (`{\i1}`, karaoke timing, and so on) — a cue
    forked from a subtitle file keeps its styling only until you edit its
    words. The loss is shown per cue and counted on the Write stage rather
    than discovered later. There is no style editor to write new codes by
    hand.

  Nothing here ever writes back to the file a track came from — a fork always
  stays a fork. And `-itsoffset` on the input is still the right tool for a
  track that is uniformly out of sync: one number shifts the whole thing,
  which many small cue edits is a poor substitute for.
- **Picture subtitles as text, or through libass.** `dvdsub` and
  `hdmv_pgs_subtitle` cannot become `subrip` (that is optical character
  recognition) and cannot be burned in with `subtitles=` (that filter reads
  characters, and these tracks have none). Both are refused by name. What
  *is* offered is drawing the pictures directly — see [drawing them, when
  they are pictures](subtitles.md#drawing-them-when-they-are-pictures). Two
  things about that path are worth knowing: the clips view cannot show it
  (press `O` to see the render), and the size the cues are painted at is
  whatever the file itself declares, with no control to override it.
- **`pattern_type=glob` on this build.** Globbing an image sequence by shell
  pattern is a compile-time feature of libavformat, and this build does not
  have it. The control says so and stays disabled rather than offering
  something that would fail at open.
- **A live device on the timeline, as a clip.** Recording a device — several
  devices on one graph, a title over them, streamed or written to a file — is
  the [Capture](capture.md) stage, and that already covers it. What a device
  still cannot be is a clip on the ordinary timeline, and the reason is the
  seek rather than the length: a moved playhead asks a source for the picture
  at a specific moment, and a live device has no way to answer that for a
  moment that has already gone or hasn't happened yet. The honest workaround
  is the one this application already pushes you toward: record it, and then
  it is a file, and a file can be cut.
- **Monitoring a session on a second audio interface, or a mix of everything
  at chosen levels.** `Listen` (see [Capture](capture.md)) plays out of this
  machine's default output; there is no picker for a different interface yet.
  And what can be monitored is one pad at a time — a device's own sound, or an
  end of the graph — not several sources mixed together at levels you choose.
- **A real file input beside a device on the same capture graph.** A file
  *can* sit beside a device already — a `movie` node over a camera works, and
  is pulled in step with it rather than racing ahead, see [a file in the
  graph](capture.md#a-file-in-the-graph). What is still refused is a proper
  input node (`-i`) in a capture graph: a `movie` node has none of an `-i`'s
  own options (`-probesize`, `-ss`, `-t`, `-loop`, protocol options), because
  nothing pushes frames into a capture's device pads except the recording
  loop itself.
- **A variable frame rate out of the ordinary timeline compositor.** A
  `filter_complex` graph's own frame times can already reach the output file
  — see [frame timing](output.md#frame-timing) — but the timeline's track
  stack cannot: it composites the edit at whatever instant it's asked for,
  with no set of times of its own, so there's no single answer to whose clock
  a variable-rate output frame would be on when several clips at different
  rates are stacked. A render whose streams read named graph pads is refused
  `vfr` for the same reason at a smaller scale — write each pad as its own
  render instead. `passthrough` mode is not offered at all.
- **Genuinely interlaced content.** The field-order control puts the encoder
  in field mode, which is the whole of what this application does for
  interlacing — the canvas itself is composited as progressive RGBA, so
  anything scaled has already had its fields woven together, and a 4:2:0
  output subsamples chroma across both fields regardless. There is no
  field-aware scaling and no deinterlacer in playback; `yadif` on the Graph
  stage is the tool for footage that needs one before it is composited.
- **A two-pass encoder that keeps its statistics somewhere other than a
  plain log file.** `-passlogfile` works for x264, x265 and anything else
  using libavcodec's own statistics pair. An encoder that keeps its stats
  another way writes them wherever it likes, pass 2 reads nothing useful, and
  the render says so by naming the encoder — there's no way to ask a codec in
  advance whether it supports this.
- **A data stream drawn over the picture, or cut on.** Reading a telemetry
  track and plotting it beside the waveform works now — see [reading a data
  track](sources.md#reading-a-data-track) and [the Data
  lane](timeline.md#the-data-lane) — for GoPro's `gpmd` specifically. Other
  fourccs (`tmcd`, `fdsc`, a phone's `mebx`) are each a different format and
  are refused by name rather than guessed at; adding one is possible but
  hasn't been done. Two things the Data lane cannot yet do:

  - **Burn a live reading onto the picture** — "speed, bottom left, updated
    four times a second" — as anything other than typed cues, which would be
    dishonest: cues you type are saved and re-edited as your own words, and
    would not update if the track were re-read.
  - **Cut on a reading** — "put a cut wherever the accelerometer crosses 20"
    — there is no threshold, hysteresis or minimum-shot-length control for a
    data track the way there is for the Measure stage's findings.

  Two smaller gaps: a reading is decimated to two thousand buckets on the way
  in, so zooming the timeline in past that shows the same decimated line
  rather than finer detail (the numbers printed beside a row are still exact,
  over every sample). And which series you picked to plot is not saved
  between sessions — reopening the document loses the pick.
- **Hardware filters this build does not have.** `hwupload`, `hwdownload` and
  `hwupload_cuda` are present; `scale_cuda`, `overlay_cuda`, `scale_qsv` and
  the rest of a device family are not, because this build's ffmpeg was
  compiled without the CUDA compiler. The palette simply offers whatever
  libavfilter reports, so a build that has them shows them with no change
  here — what today's build costs you is that a render on the card can pass
  frames through but not resize or composite them there.
- **Hardware decode anywhere in playback.** A clip whose input decodes on a
  device still has every frame brought back to system memory for the viewer,
  because the renderer only reads system-memory frames. That is the right
  trade for playback, but it does mean `-hwaccel` on the timeline only costs
  you something — see [the card](card.md) for when hardware decode is
  actually worth it.
- **A hardware recommendation measured on your own machine.** `Choose for
  me` (see [choosing it for you, on a
  press](card.md#choosing-it-for-you-on-a-press)) applies an arrangement
  tuned on one specific machine. It asks your machine what devices and
  encoders it has, but not how fast any of them actually are for you — there
  is no built-in benchmark to run and keep an answer for. A machine
  meaningfully different from the one this was tuned on (few cores, an
  integrated GPU) may get worse advice than it should.
- **Speed that keeps the pitch, and speed under a filter of yours.** A clip's
  speed control (see [speed](timeline.md#speed)) has three rough edges.
  Pitch moves with speed, because speed is done by resampling rather than by
  a time-stretcher — put `atempo` on the Graph stage if you need the pitch
  held. The clips view keeps the `fx` badge for a filter placed below a
  sped-up clip's `scale`, for the same reason the resize entry above does —
  press `O` to see it correctly. And at a speed change, the timeline
  compositor and a `filter_complex` graph can occasionally choose a different
  source frame by one frame's difference — a rounding disagreement between
  the two render paths, rare and small.
- **A meter of the timeline's own mix during ordinary playback.** With `O`
  on, [the meter](playback.md#the-meter-beside-the-picture) reads the
  render's real output. With `O` off, it reads a weaker signal — this
  machine's whole audio mix, sample peak rather than true peak, two channels
  regardless of the output's own count — labelled `monitor` so it isn't
  mistaken for the real thing. Press `O` before trusting a level.
- **Finding things by sound, by *what* the sound was.** Finding *where*
  something happens already works — see [finding things by
  sound](sources.md#finding-things-by-sound) — but it never says *what* made
  the sound, and it never will from these sensors: an `onset` is the same
  event for a wingbeat, a car door or a footstep, and a `tonal` run is the
  same event for a blackbird and a fridge. What the marks carry — the flux of
  a transient, the frequency of a tonal run — isn't exposed as a filter, so
  there's no way yet to ask for "only transients stronger than this" or "only
  runs between 2 and 6 kHz" to cut a dawn chorus's three hundred marks down
  to the twenty worth hearing.

  **Searching for a spoken word is a licensing problem, not a missing
  feature.** The engine underneath this application has an open-vocabulary
  keyword spotter that would do exactly this — type a word, get every moment
  someone said it. The checkpoint it needs was trained partly on data
  distributed for academic, non-commercial use only, and this application is
  distributed under the GPL. Shipping a control wired to weights that cannot
  be shipped commercially isn't a smaller version of the problem, it's a
  different one, so the feature stays off. [Transcribing and searching
  words](sources.md#finding-a-word) on the Sources and Find stages is the
  alternative today, and it has no such restriction.
- **Two renders running at once.** This application runs one render at a
  time. Downloads and live monitoring are not affected — a background fetch
  (see [saving a stream to this
  machine](sources.md#saving-a-stream-to-this-machine)) and a Capture session
  both run alongside a render already, because neither takes the render's job
  slot. A second render is a bigger change than it sounds: the report
  currently can't say which of two simultaneous renders produced which log
  line, the priority ordering that lets a node preview step aside for a real
  render assumes there is only one to step aside for, and a recording
  currently gets a device to itself by construction. None of that is
  impossible, but [a second card](card.md#a-second-card) is rarely the actual
  bottleneck — the encoder usually isn't the limit at ordinary sizes — so it
  hasn't been worth the rework yet.
