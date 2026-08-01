[← The manual](README.md)

# How playback works

There is no proxy transcode, no intermediate file, and no second encode.
libavcodec decodes in-process with frame and slice threading across all cores,
frames go to the renderer, and audio streams into bro's live PCM ring half a
second ahead of the mixer. What you see is the decoder's output at full quality.

Non-4:2:0 sources (10-bit HDR, 4:2:2 broadcast, 4:4:4 ProRes, RGB screen
captures) are converted by swscale on the way through.

**A clip recorded sideways plays the right way up.** Phones do not turn the
pixels; they record landscape frames and write the correction into the container
as a display matrix. That matrix reaches the player — the decoded frames stay the
size they were coded at and the *shown* size is the swapped pair, which is what a
clip is laid out against, so a 1920×1080 file tagged for a quarter turn is a
1080×1920 clip on a 1080×1920 canvas. The turning is a transform on the quad the
frame is drawn as rather than a pass over the pixels, so it costs nothing per
frame. Anything that is not a quarter turn is read as no rotation at all: a size
can be swapped or not, and a picture drawn at an angle inside a box laid out for
a rectangle is worse than the picture as it was stored.

**A generator clip is played, and never asked to seek.** Its element is an
ordinary `<video>` pointed at the `-f lavfi -i testsrc=…` registered for it — the
same backend, the same decoder, the same renderer, the crossing that already makes
a lavfi device play in its card on the [Capture stage](capture.md). What it cannot
do is go to a moment: libavfilter's sources produce forward and the `lavfi` demuxer
has no seek, so the picture is the generator *running* rather than the generator at
the playhead. For a `color` or a `smptebars` those are the same picture; for a
moving pattern it is the right pictures without the timecode. It is also never the
master clock for that reason — with a file clip under the playhead the file drives
the transport whichever is on top, and a timeline of nothing but generators runs on
the wall clock the way a gap does. `O` below shows the moment exactly.

**Only the clips near the playhead are open.** A clip's `<video>` element *is* a
decoder — a demuxer, a codec context, an audio ring — and holding one for every
clip in the edit is what made a 75-clip montage take 26 seconds to open and 9.1
GB to hold. So an element is built as the playhead approaches and taken down once
it is well past: a few seconds either side are open, everything under the
playhead is open whatever that costs, and the rest of the edit is model and
nothing more. You are meant not to notice, and the two things that would make you
notice are exactly the two the window is shaped around — a clip is opened *before*
the playhead reaches it, so a cut does not stutter, and it is not closed until it
is three times further away than the distance at which it was opened, so
scrubbing back and forth across a cut does not tear the same decoder down twice a
second.

What does **not** go with the decoder is what the timeline draws. A clip's
waveform and filmstrip are read once, when it joins the edit, and they belong to
the clip — so a lane stays drawn for a clip whose decoder has been closed, and
scrolling the timeline never re-reads a file. On a large document they fill in
over the following seconds while everything else works normally, and the
readout beside the clip count says how many are still being read.

**Pressing play watches the render.** The picture on the monitor is normally one
`<video>` per clip laid out inside the output canvas, which is exact and free —
but playing an edit that way means crossing from one decoder to the next at every
cut, and each crossing is a file being opened and seeked on the thread that
draws. On a montage of 1.6 s clips that is about one visible hitch a second. So
playback asks for the *render* instead: one source for the whole edit, with the
cuts done by the compositor, where there is nothing to cross. Measured on a
75-clip montage, the same fifteen seconds went from 23 stuttering frames to 8,
and the median frame from 19 ms to 13.

Three things follow, and you are meant to notice only the last.

Building a render opens every input it reads — over a second on an edit that
size — so the button answers immediately and the clips carry playback until the
render exists, which is generally before you have looked away from the mouse.

It is kept for twenty seconds after you stop, so stopping to look at something
and starting again is instant. It costs about a gigabyte on a large edit, which
is why it is not kept for ever. **Scrubbing does not rebuild it**: a filter graph
cannot seek — moving the playhead means building a source that begins there — so
while it is merely being kept, the clips answer the scrub and the render is left
alone. That is why dragging the playhead is as quick as it ever was, and why
playing from a new position takes a moment to start.

And what you see while it plays is the *render*, which for most edits is the same
picture the clips make. Where it differs it differs because the clips cannot show
that thing at all — a generated source, a filter over the whole canvas — so the
difference is always in the direction of the truth. None of this touches the `O`
button below: playback borrows the same machinery, it does not turn the mode on.

## The output, instead of the clips

`O`, or **Output** on the timeline bar, puts the *render* on the program monitor
instead of the clips. Nothing is encoded and no file is written: what plays is
the render's own frame source — `TimelineSource` where the edit has no filters of
anybody's on it and libavfilter's `GraphSource` where it does — with the writer
taken off the end. It is the same choice `runExport` makes and the same spec
`Render` is given, so a preview cannot show a render this application would not
perform.

**It exists for the three things one element per clip cannot show**, all of them
things that are not about one clip:

- a **generated source placed on the graph** — a `testsrc`, a `color`, a `movie`
  wired up on the [Graph stage](graph.md) — which is a node with no clip, so there
  is no element on the monitor it could be. A render rooted entirely in generators,
  with nothing on the timeline at all, plays here. A generator [laid out on the
  timeline](timeline.md#a-generator-laid-out-like-a-clip) is the other case and
  needs none of this: it is a clip, so it has an element of its own, playing its
  own `-f lavfi -i` through the same backend every other clip goes through.
- a **filter over the whole canvas**: a burn-in after the composite has no single
  picture to run on, because the composite is one element laid over another.
- a **filter that resizes a clip's picture below the point where the clip is
  placed**, which the render lays over the canvas at its own size rather than in
  a rectangle — so the viewer, which has only rectangles, refuses it: see
  [A filter in the viewer](graph.md#a-filter-in-the-viewer). A resize on the way
  *in* is a rectangle, and the monitor shows that one. Placing is what the render
  does, so the render has no such problem with either.

**It is the clock while it is on**, because it is the picture on the screen —
which is the rule the transport has always followed about the topmost clip. The
playhead moves at whatever rate the frames can be made at rather than on the
wall: a timecode running at real time past a picture arriving at half of it would
describe something nobody is looking at. It also **stops where its own range
stops**, which is not always the end of the timeline — a render of seconds 10 to
20 runs out at 20 with half the edit still to come, and handing over to the clip
after it would be handing over to something that is not on the screen.

**Moving the playhead builds a new one.** A filter graph pulls — it produces the
frames it produces, in order — so there is no seeking inside one, only building
one whose inputs begin where you want to start. Every position of the playhead is
therefore its own render, which is also why nothing rebuilds under a moving hand:
like a node preview, it waits for the edit to hold still before opening the files
again.

**It has the render's own soundtrack.** What a preview is for is a statement
about the whole programme — an `-af` chain, a `loudnorm`, an `amix` against a
generator — and none of those is anything a clip element can play, so the preview
carries the mix as well as the picture. The clips underneath stay parked: one of
them playing under it would be that clip heard twice, once as itself and once
through the mix.

**When it cannot keep up, the sound wins.** A soundtrack stretched to match a
slow render is a slower piece of music, and anything you decide while listening
to it is a decision about the wrong thing. So the mix is made for every frame of
the range, in order, and the *picture* is what gets dropped — the instant nearest
to now is a true answer even when the ones in between were never made. A graph is
the exception and can drop nothing: libavfilter holds every frame it has pushed at
a sink until somebody takes it, so a pull skipped is memory grown rather than work
saved, and a `filter_complex` slower than real time gaps its sound instead.

**What it never does is stop.** A picture is made only where there is a new
moment to make one for, and the moment is where the element says its screen is —
so the picture and the screen depend on each other, and anything that interrupts
the pair leaves both waiting. That failure is silent: the sound plays on, the
playhead goes on moving, and the picture simply never changes again. Two things
in the render hold it open and neither is a rate, so both hold on any machine:
the picture is never withheld because the *sound* has not reached that moment
yet — a render that cannot make its own frame rate lives permanently in that
state — and it is never withheld because the run is waiting for room to put its
next block of sound, since the thread that makes that room is the one waiting for
the picture.

A graph libavfilter will not have says so on the stage, in libavfilter's own
words, rather than showing black.

## The cues, over whichever picture it is

`T`, or **Cues** on the same bar, draws the output's [soft subtitle
tracks](subtitles.md#a-soft-track-on-the-monitor-as-the-cues-it-is) over the
picture. It is a separate switch from `O` and not a part of it, because the two
answer different questions: `O` is *which picture* is on the monitor, and this is
whether the stream written beside that picture is drawn over it. A soft track is
a fact about the finished file whether you are watching the clips or the render,
so it is over both.

What it draws is the cue text, unstyled, with a line saying so while it is on —
because a soft track is styled by whatever player opens the file, and this
application cannot know which. And it turns off, which is the point rather than a
convenience: a soft track is exactly the thing a player can switch off, so an
overlay that switches off is a faithful preview of one.

## The meter beside the picture

A1 on the timeline is drawn in decibels with a line where clipping is, so an over
can be *found* — but it is the analysis's buckets, per clip, measured before
anything was played. The strip down the right of the viewer answers the other
question: **how loud is what is leaving now.** It is drawn on the same scale A1 is,
so a reading there and a mark there are comparable.

What it is reading depends on what is making the sound, and the strip says which:

**`output`, while the preview is on.** The render publishes its mix for the element
to play, and it is measured on the way past — so what the bars show is:

- **one bar per channel of the output**, at the channel count the encoder would be
  opened with, named as libav names them (`FL`, `FC`, `LFE`…). An output written in
  mono is one bar; a 5.1 output is six. Nothing here assumes two.
- a **true peak**, oversampled four times, which is the loudest point on the
  *signal* and not merely the loudest sample. A waveform whose every sample is
  inside full scale can pass through +1.5 dBFS between two of them, and that is
  what clips a converter and what makes a limiter set by a sample-peak meter
  distort anyway. Four times is what ITU-R BS.1770 specifies; the filter's
  overshoot on a steady tone measures under 0.001 dB, and a 4× grid cannot see
  more than 0.3 dB under the top of a 16 kHz sine, which is arithmetic rather than
  a fault.
- **every block**, because reading the level clears it — so a transient between two
  frames of the UI is caught rather than missed.

**`monitor`, while it is off.** There is no render then: bro's mixer is summing the
clips' elements, so the strip reads bro's own metering of its master mix bus. It is
a weaker reading and is labelled as one — **sample peak**, sampled once a frame
rather than accumulated, and **two channels** because that is the device's mix and
not the output's. The monitoring volume is divided back out of it, so turning the
speakers down does not hide an over; a clip's own level stays in, because that is
part of the edit. Press `O` for the reading to trust.

The number beside each bar is the loudest that channel has been since the latches
were cleared, and the `over` light latches when it has passed full scale. Click
either to forget both — one accident should not leave a light on for the rest of
the session. It is the same meter the [Capture](capture.md) stage draws below its
pictures, on the same scale, for the same reason.

**A file with no picture in it is an ordinary clip.** Drop an `.mp3`, a `.wav` or
an `.m4a` on the timeline and it lays out with the length of its audio track,
plays, moves the playhead and goes into the mix. What it does not do is take up
room on the canvas: it has no rectangle, no cell in a grid, no filmstrip and no
`[0:v]` pad in the graph, and a render of a timeline with nothing but sound on it
writes a file with a soundtrack and no video stream. The one thing it will not
do is step: `[` and `]` move by decoded pictures, and a soundtrack has none, so
stepping through a timeline of sound moves clip to clip. The master clock stays
with the topmost clip that *has* a picture wherever there is one — a music bed
laid over the footage must not take the clock away from the thing being watched.
