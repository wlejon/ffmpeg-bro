[← The manual](README.md)

# The timeline

Video lanes under the ruler and one audio lane beneath them, the way an edit
suite stacks them:

- **V1, V2, …** filmstrips — each slot showing the frame that is on screen at
  that point, so it stays honest as you zoom in. There is always one empty lane
  above the highest one in use: dragging a clip into it is how you add a track,
  and the lanes share a fixed height between them so the waveform never gets
  pushed off the bottom. Beside each name is a padlock: the [sync
  lock](#the-sync-lock). A clip stored sideways gets upright, portrait slots:
  the strip is cut to the *displayed* aspect and the pictures are turned to
  match, which is the one place anything here rotates pixels rather than the
  thing they are drawn on — a strip is a finished image with nothing left
  downstream to turn it.
- **A1** the waveform — peak envelope over an RMS body, so you can see where
  the sound is before you hear it. **One waveform, not one per clip**: two
  clips that overlap in time are one sound at that moment, and A1 draws what
  the render will make of it rather than whichever of them was painted last.
  The two halves are summed the way a mix is summed and not the same way as
  each other — the envelope *adds*, because two sounds at once reach the sum of
  their peaks and that is what clipping is, while the body is a
  root-sum-of-squares, because power adds and amplitude does not: two
  uncorrelated sounds at -6 dB make one at -3 rather than one at 0. A **muted**
  clip is drawn on its own, dimmed, and is outside the sum — it is still there
  and simply not being heard, so hiding it would make it hard to find again and
  folding it in would draw sound the render will not write.

  The lane is drawn in **decibels**, from -60 dBFS at the centre line to +6 at
  the top, with a dashed line across it where full scale is. Amplitude is the
  wrong scale to judge sound by eye — a linear lane spends half its height on
  the top 6 dB and crushes a quiet dialogue line into the last few pixels,
  where the decisions are; on this one a halving is the same distance wherever
  it happens. The ceiling is *above* full scale because the envelope is a sum
  and a sum can exceed it: two clips that each peak just under 0 dBFS make a
  mix that does not, and a lane that stopped at 1.0 drew that as exactly full
  height and looked fine. Columns that go over are drawn in their own colour,
  so an over is something you see rather than something you infer from a shape
  that has run out of room.

- **When** — the spans that turn a filter on and off part way through the render,
  drawn where the shots they cover are. It is only there when there are any; see
  [the When lane](#the-when-lane).

The filmstrips and the waveform come from `bro.media` (see bro's
`docs/video-api.js`), which decodes the whole file through the same backend
registry `<video>` plays through. Both are full-file decodes, so ffmpeg-bro runs
them in a Worker and the lanes fill in behind a UI that never stops responding.

**Zoom** with the wheel, about the pointer — the only version that lets you
dive into a moment instead of steering the window back after every notch.
`Shift`+wheel pans, the scrollbar under the tracks pans, and `Fit` goes back to
the whole timeline. Everything is drawn from the visible window rather than the
whole file, so at 200× the strip is the individual frames around the playhead
and the waveform under it is the sound at that instant.

**Drop more files** to add them. One or two land after what is already there.
Three or more is a different act — that is a morning's recordings, not an edit —
so they go on tracks of their own, all starting together at zero, and the canvas
switches to a **grid** (see below). Each gets its own filmstrip and waveform.

**Drag a clip** along its lane to move it — it snaps to the timeline start, the
playhead and the other clips' edges, and anything it lands on top of *on the
same track* slides out of the way, which is also how you reorder. Overlapping
across tracks is the point of having tracks, so nothing moves there. Drag it
into another lane to restack it.

**Drag a clip's end** to trim. In-point and start move together when you trim
the head, so the pictures under the part you kept do not slide sideways, and a
trim stops at its neighbours rather than growing over them. The two grips
appear on the selected clip.

**Hold `Alt`** and each of those three targets becomes the edit that is about
the *cut* rather than about the clip. One modifier is enough because the target
already says which of the three you mean, and they hold three different things
constant:

| | | |
|---|---|---|
| `Alt` + a clip's **end** | **ripple** | holds the content, moves everything after — the gap closes instead of being left as a hole |
| `Alt` + a **cut** between two butted clips | **roll** | holds the total, moves the boundary — the programme is the same length and the cut is somewhere else in it |
| `Alt` + a clip's **body** | **slip** | holds the window, moves the content inside it — the clip stays put and starts somewhere else in the file |

**A cut is a different target from an end**, which is what makes that table
unambiguous rather than clever: two clips laid end to end share an x, and the
left one's out-point *is* the right one's in-point, so there is one boundary
there with two names. A clip with a gap after it has a loose end and no cut, and
`Alt` on it ripples.

Slip drags the film under the window, so dragging **right shows earlier
footage** — the convention every editor uses, and worth stating because both
readings are defensible. It stops at the ends of the footage rather than
shortening the clip, since a slip that got shorter would be a trim wearing the
wrong name. Roll stops when either side runs out of frames, by doing less rather
than by refusing: a drag that stops moving says where the wall is more clearly
than a drag that does nothing.

Ripple moves everything later **on the same track**, unless that track is
[locked](#the-sync-lock) to others.

**Split** (`S`, or the button) cuts every selected clip the playhead is inside —
one keypress through a whole stack, or through exactly the one you picked. Both
halves point at the same file, so a split costs nothing but a second `<video>`,
and together they cover exactly what the one clip covered. Trimming a half and
deleting the other is how you take a piece out of the middle.

**Select** by clicking a clip or its picture. `Ctrl`/`Shift`-click adds to the
selection, `Ctrl`+`A` takes everything, `Esc` narrows back to one. `Delete`
removes the lot. Drag the ruler or A1 to scrub.

## A generator, laid out like a clip

`ffmpeg -f lavfi -i testsrc` is one of the first commands anybody runs. **Generator**
in the timeline bar lays one out here: pick `testsrc`, `color`, `smptebars`,
`mandelbrot` — every filter libavfilter declares with no input pads and a picture
on its output — and what appears on a lane is a **clip**.

That is the whole design and not a turn of phrase. It has a track, a start, a
length, in and out points, a rectangle on the canvas, a selection ring, and a
`<video>` of its own showing the real thing on the program monitor. Drag it, trim
it, `Alt`-drag it to ripple, roll the cut after it, slip inside it, split it,
stack it under a title, crop it, fade it with `Opacity` — none of that is a second
implementation of anything. The bar is drawn in a colour of its own with the
command that makes it written along it, and it carries no filmstrip and nothing on
A1, because there are no thumbnails to grab from a source that cannot be seeked
and no sound in it to draw.

**How long one is is a decision, not a measurement.** A `color` is infinite:
libavfilter goes on producing frames for as long as something pulls them, so unlike
a file there is nothing to discover. One arrives five seconds long — long enough to
see and short enough to trim, and no dialog, because a question with no information
in it is worse than a default. Drag its end *outward* and it gets longer: asking a
`testsrc` for another ten seconds is a request it answers. That is the same
convention this application already follows for [an endless
input](sources.md) — `-t` is the only thing that can say — with the number kept on
the clip, so it travels in the [document](document.md) and comes back with the
edit.

**Its arguments are one line, on the properties panel.** `size=1920x1080:rate=25`,
exactly what you would have typed after `-f lavfi -i`, with the filter's own
description under it. A new one takes the canvas's size and rate where the filter
has options to put them, so a test pattern dropped on a 1080p edit is 1080p rather
than libavfilter's 320×240 default. An option the filter does not have is refused
in libavfilter's own words and nothing changes; the full option table, drawn per
option, is on that filter's card on the [Graph stage](graph.md).

**A sound source is not a clip.** `sine` and `anullsrc` are sources too, and they
are deliberately not in the list: a bar with no picture would have nothing for the
canvas and no length anything on screen states. One of those is a node wired to the
mix on the Graph stage, where it has a pad to be wired to.

Two things about a generator are genuinely not like a file, and both come from the
same fact — libavfilter's sources produce forward and the `lavfi` demuxer cannot
seek. It is never the **master clock**: with a file clip under the playhead the
file drives the transport even with the generator on the lane above it, and a
timeline of nothing but generators runs on the wall clock, the same way a gap
between clips does. And the picture on the monitor is the generator *running*
rather than the generator at the playhead's moment — right for a `color` or a
`smptebars`, and for a moving pattern it is the pictures without the timecode. `O`
shows [the render itself](playback.md#the-output-instead-of-the-clips), which is
that moment exactly.

The [Graph stage](graph.md) draws the filter at the head of the clip's chain,
where an `-i` would be for a file. It is a **derived** node: rebuilt on every
timeline edit and gone when you delete the bar. A generator you place on that stage
by hand is the other thing entirely — a node, with no lane and no bar — and the two
do not interfere.

## The When lane

A filter does not have to run for the whole render: `enable=` turns one on and off
part way through, and the [Graph stage](graph.md#when-it-is-on) is where an
expression is written. What that stage cannot answer is the question the spans are
usually about — *does the blur cover the whole of this take, does the logo come off
before the cut* — because the take is here.

So every span that exists is drawn here, under the video tracks, as a region on
the timeline's own ruler:

| | |
|---|---|
| drag a region's end | move where it comes on, or goes off |
| drag its middle | move the whole span, keeping its length |
| press anywhere on the lane | the playhead goes there, as on any other lane |

Ends snap to the same things a clip snaps to — the start of the timeline, the
playhead, and the other clips' edges — because "cover exactly that shot" is what
the gesture is nearly always for. A whole-span drag snaps by whichever of its two
edges lands on something.

**The lane is there because spans are.** An edit with none does not carry an empty
lane; a span made on the Graph stage is here when you come back; taking the last
one off takes the lane with it. That is the same rule the video lanes follow —
how many there are is a property of the edit and not of the window.

**One row per node, and each says which node it is.** A `hue` on one shot and a
`drawtext` over the whole canvas are two rows, each carrying the filter's name and
what it is on — `hue · V1 shot.mp4`, `drawtext · the whole canvas` — in a colour of
its own. The name is drawn at the left of its row and the regions are translucent
over it, so it is readable at any zoom rather than only where a region is wide
enough to hold it.

Rows rather than one shared strip, and that is the load-bearing part: two spans
from different nodes that overlap in time would otherwise be drawn over each other
and the one underneath would be unreachable by the pointer, which is the whole
gesture. The rows are ordered by the clip each node is about, so a drag — which
moves a span and never a clip — can never reorder them underneath your hand. A
node you delete takes its row with it.

**It is the same edit as the strip in the column**, through the same two functions,
so a span dragged here and a span dragged there cannot come to mean different
things, and either is one press of `Ctrl`+`Z`. It travels in the
[document](document.md) with the rest of the graph.

Two kinds of span are deliberately not on it, and each because there is nothing
true to draw. A filter on a file the *graph* reads on its own account — a
watermark, a logo bug — is written in that file's own timestamps and no clip is cut
from it, so no second of the edit corresponds to its `t=5`; it has a strip in the
column, where the ruler is that file's. And `enable` on a filter libavfilter says
has no timeline support is a graph that will not build, reported on the node rather
than drawn as a region you could drag.

## The sync lock

The padlock beside a track's name says whether that track ripples on its own or
along with the rest of the stack. **Off by default, on every track.**

- **Unlocked** — an `Alt`-drag ripples that track and no other. That is right for
  a title on V2 placed against the shot under it: rippling one track beneath
  another would silently move the title off the shot it was cut to.
- **Locked** — an `Alt`-drag on it moves everything later on *every* locked
  track, by the same amount. That is right when the tracks are one programme: a
  cut across a stack, where the sound bed and the overlay are meant to travel
  with the picture.

Which of the two a given pair of tracks is, only you know, so it is a control
rather than a rule — and the safe answer is the default. A lock is **part of the
edit**: it is saved in the [document](document.md), and locking a track is one
press of `Ctrl`+`Z` to undo, because it changes what the next drag does to the
clips. It is not part of where you happen to be standing, which is the half of a
document that an undo deliberately never touches.

**A lock is visible before the drag, never discovered after it.** The padlock
shuts, the track's name goes to the accent colour, and the whole lane takes a
faint wash of it — so a locked group is two or three lanes plainly marked as one,
and a ripple can never quietly move clips on a lane you were not looking at.
Hovering the padlock says what the press will do, including the case where a track
is the only locked one and so nothing else moves with it yet.

Locking a lane and then emptying it costs nothing: a lock lasts as long as its
lane is on the screen, and a lane that has gone takes its lock with it. There is
no list of tracks anywhere — how many lanes there are is still worked out from the
clips that exist — so a lock left over from a deleted clip can neither put a lane
on the screen nor move a clip that is not on one.

Only ripple is affected. Dragging a clip along its lane, trimming, rolling and
slipping all do exactly what they did: the lock is about the one edit whose whole
point is that it moves things you are not touching.
