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

- a **generated source** — a `testsrc`, a `color`, a `movie` — which is a node
  with no clip, so there is no element on the monitor it could be. A render
  rooted entirely in generators, with nothing on the timeline at all, plays here.
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

A graph libavfilter will not have says so on the stage, in libavfilter's own
words, rather than showing black.

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
