[← The manual](README.md)

# How playback works

There is no proxy transcode, no intermediate file, and no second encode. What
you see is the decoder's output at full quality, including 10-bit HDR, 4:2:2
broadcast, 4:4:4 ProRes and RGB screen captures.

**A clip recorded sideways plays the right way up.** A phone writes the
correction into the file rather than turning the pixels, and this reads it: a
1920×1080 file tagged for a quarter turn plays and exports as a 1080×1920 clip.
Anything that is not a quarter turn is treated as no rotation at all.

**A generator clip** — `color`, `testsrc`, `smptebars` and the like, placed on
the timeline like any other clip — **plays, but cannot be scrubbed to an exact
moment.** For a still pattern that makes no difference; for a moving one,
stepping or scrubbing shows the generator running rather than the generator at
the position the playhead reads. A generator is also never the master clock:
with a file clip under the playhead that clip drives the transport, and a
stretch of timeline with only generators on it runs on the wall clock the way a
gap does. `O`, described below, shows the exact moment instead.

**Large projects open fast, and memory stays bounded.** Only the clips near the
playhead are fully loaded; the rest of the timeline is just as editable, but a
clip's picture may take a moment to reappear the first time you jump straight to
it from far away. A clip's waveform and filmstrip, once read, stay drawn even
after this happens — scrolling the timeline never re-reads a file. On a large
document they fill in over the following seconds while everything else works
normally, and a readout beside the clip count says how many are still being
read.

**The same readout says when a redraw is going to take a moment.** A large edit
occasionally needs a moment to catch up after a change — relaying out the graph,
restating a render — and the window keeps taking input while it does; a short
status message appears beside the clip count only when that is actually
happening, so on an ordinary project you will not see it at all.

**Playing across a cut is smooth.** Rather than switching between one clip's
decoder and the next at every cut, playback renders the edit the same way an
export would. Building that takes a moment, so the clips carry playback until it
is ready — normally well before you have looked away from the mouse — and it is
kept for a short while after you stop, so pausing and resuming is instant.
Dragging the playhead is unaffected and stays just as quick; starting playback
from a new position takes a brief moment to begin. What you see during playback
can differ from what the clips alone would show only where the clips genuinely
cannot show something — a generated source, a filter over the whole canvas —
and in that case the difference is always toward what will actually render.
This is the same machinery `O` uses below, not a mode of its own.

## The output, instead of the clips

`O`, or **Output** on the timeline bar, puts the actual render on the program
monitor instead of the clips. Nothing is encoded and no file is written — what
you see is what a render of the current edit would actually produce.

**It exists for three things one clip's own picture cannot show:**

- a **generated source placed on the graph** — a `testsrc`, a `color`, a
  `movie` wired up on the [Graph stage](graph.md) — which has no clip and so no
  element of its own on the monitor. A generator [laid out on the
  timeline](timeline.md#a-generator-laid-out-like-a-clip) is different: it has a
  clip and plays normally without `O`.
- a **filter over the whole canvas**, such as a burn-in applied after
  compositing.
- a **filter that resizes a clip's picture below the point where the clip is
  placed** — the viewer refuses to guess at that layout and badges the clip
  `fx` instead; see [A filter in the viewer](graph.md#a-filter-in-the-viewer).

**It is the playback clock while it is on**, and it stops at the end of its own
render range even when the timeline continues past that point.

**Moving the playhead rebuilds it.** There is no seeking inside a render — only
building a new one starting from where you want to be — so scrubbing while `O`
is on takes a moment to catch up rather than being instant.

**It carries the render's own soundtrack.** An `-af` chain, a `loudnorm`, an
`amix` against a generator — none of that is anything a clip's own element can
play, so the preview plays the finished mix and the clips underneath stay
muted, to avoid hearing the same audio twice.

**When it cannot keep up, the sound stays correct and frames are dropped.**
Picture frames are made in real time where possible; when they cannot keep up,
frames are skipped rather than letting the sound run slow. The exception is a
render built from a filter graph on the Graph stage, which cannot drop frames
this way — if it falls behind, its sound falls behind with it instead.

A graph that libavfilter refuses to build says so on the stage, in libavfilter's
own words, rather than showing black.

## The cues, over whichever picture it is

`T`, or **Cues** on the same bar, draws the output's [soft subtitle
tracks](subtitles.md#a-soft-track-on-the-monitor-as-the-cues-it-is) over
whichever picture is showing, clips or the render alike. It draws the cue text
only, unstyled, and says so on screen — a soft track is styled by whatever
player eventually opens the file, and this application does not guess at that.
It turns off, which is the point: a soft track is exactly the kind of thing a
player can switch off, so an overlay that switches off is a faithful preview of
one.

## The meter beside the picture

A1 on the timeline shows level in decibels with a line where clipping is, but
it is measured ahead of time, per clip. The strip down the right of the viewer
answers a different question: **how loud is what is leaving right now.** It is
drawn on the same scale A1 is, so a reading there and a mark there are
comparable.

What it is reading depends on what is making the sound, and the strip says
which:

**`output`, while the preview (`O`) is on.** The strip shows the render's own
mix as it is made:

- **one bar per channel of the output**, at the channel count the encoder would
  use — a mono output is one bar, a 5.1 output is six.
- a **true peak**, not merely the loudest sample: a signal can pass briefly
  above full scale between two samples, which is what actually clips a
  converter or a limiter set from a weaker meter.
- **every block measured**, so a transient between two frames of the UI is
  still caught.

**`monitor`, while `O` is off.** There is no render then, so the strip reads
the level of whatever is currently playing through the mixer instead — a
weaker reading, labelled as one: **sample peak** rather than true peak, and
**two channels** because that is the device's own mix rather than the output's.
Turning your speakers down does not hide an over; a clip's own level in the
edit still counts. Press `O` for the reading to trust before a render.

The number beside each bar is the loudest that channel has been since it was
last cleared, and the `over` light latches once a signal has passed full scale.
Click either to clear both. It is the same meter the [Capture](capture.md)
stage draws below its pictures, on the same scale, for the same reason.

**A file with no picture in it is an ordinary clip. Drop an `.mp3`, a `.wav`
or an `.m4a` on the timeline and it lays out with the length of its audio
track, plays, moves the playhead and goes into the mix. It takes up no room on
the canvas, and a render of a timeline with nothing but sound on it writes a
file with a soundtrack and no video stream. Frame stepping (with `←` and `→`)
steps by decoded picture, so a stretch of timeline with only sound on it steps
clip to clip rather than frame to frame (`[` and `]` step one stage back / forward
along the pipeline). The master clock stays with the topmost clip that
*has* a picture, wherever one is present — a music bed under the footage never
takes the clock away from what is being watched.
