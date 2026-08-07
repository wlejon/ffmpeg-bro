[← The manual](README.md)

# The timeline

Video lanes under the ruler and one audio lane beneath them, the way an edit
suite stacks them:

- **V1, V2, …** filmstrips — each slot showing the frame that is on screen at
  that point, so it stays honest as you zoom in. There is always one empty lane
  above the highest one in use: dragging a clip into it is how you add a track.
  Beside each name is a padlock: the [sync lock](#the-sync-lock). A clip stored
  sideways gets upright, portrait slots: the strip is cut to the *displayed*
  aspect and the pictures are turned to match.
- **A1** the waveform — peak envelope over an RMS body, so you can see where
  the sound is before you hear it. **One waveform, not one per clip**: two
  clips that overlap in time are one sound at that moment, and A1 draws what
  the render will make of it. A **muted** clip is drawn on its own, dimmed, and
  is outside the sum — it is still there and simply not being heard.

  The lane is drawn in **decibels**, from -60 dBFS at the centre line to +6 at
  the top, with a dashed line across it where full scale is. The ceiling is
  *above* full scale because the envelope is a sum of everything playing at
  once and a sum can exceed it: two clips that each peak just under 0 dBFS make
  a mix that does not. Columns that go over are drawn in their own colour, so
  an over is something you see rather than something you infer.

- **When** — the spans that turn a filter on and off part way through the render,
  drawn where the shots they cover are. It is only there when there are any; see
  [the When lane](#the-when-lane).

Decoding the filmstrips and the waveform is not free, so ffmpeg-bro runs it off
the UI thread and the lanes fill in behind a window that never stops
responding.

**A file on this machine is read whole. A clip on a link is read for the span
you are looking at.** So a clip whose input is a URL is read a window at a
time, following what the timeline shows, and a window already read is not read
again. **A strip samples and an envelope integrates**, and the two lanes behave
differently because of it: the filmstrip covers whatever is on screen and
zooming out is not a bigger job, but the envelope has to decode every sample
between its ends, so it is read in a bounded window. Zoomed out past that
window the lane is honestly **blank** either side of it — a bucket nobody has
read is not a bucket that was quiet — and zoom out far enough and it stops
reading altogether and says **zoom in to read the sound**, rather than
spending several seconds on a waveform that would be a few pixels wide in the
middle of a long recording.

The envelope is also read from the cheapest source that carries the same
soundtrack: a local copy if one has been pulled, otherwise the site's
audio-only rendition, otherwise the clip itself. The middle two are a couple of
seconds away from the picture and no offset corrects it (see [Saving a stream to
this machine](sources.md#saving-a-stream-to-this-machine)), so the lane says which one it read. Pull the sound
and the lane gets exact and instant, which is the point of pulling it.

**Zoom** with the wheel, about the pointer — the version that lets you dive
into a moment instead of steering the window back after every notch.
`Shift`+wheel pans, the scrollbar under the tracks pans, and `Fit` goes back to
the whole timeline. Everything is drawn from the visible window rather than the
whole file, so at high zoom the strip is the individual frames around the
playhead and the waveform under it is the sound at that instant.

**Drop more files** to add them. One or two land after what is already there.
Three or more is a different act — that is a morning's recordings, not an edit —
so they go on tracks of their own, all starting together at zero, and the canvas
switches to a **grid**. Each gets its own filmstrip and waveform.

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
the *cut* rather than about the clip:

| | | |
|---|---|---|
| `Alt` + a clip's **end** | **ripple** | holds the content, moves everything after — the gap closes instead of being left as a hole |
| `Alt` + a **cut** between two butted clips | **roll** | holds the total, moves the boundary — the programme is the same length and the cut is somewhere else in it |
| `Alt` + a clip's **body** | **slip** | holds the window, moves the content inside it — the clip stays put and starts somewhere else in the file |

A cut is only where two clips are butted end to end and share an edge; a clip
with a gap after it has a loose end and no cut, and `Alt` on it ripples.

Slip drags the film under the window, so dragging **right shows earlier
footage** — the convention every editor uses. It stops at the ends of the
footage rather than shortening the clip. Roll stops when either side runs out
of frames, by doing less rather than by refusing.

Ripple moves everything later **on the same track**, unless that track is
[locked](#the-sync-lock) to others.

**Split** (`S`, or the button) cuts every selected clip the playhead is inside —
one keypress through a whole stack, or through exactly the one you picked. Both
halves point at the same file, and together they cover exactly what the one
clip covered. Trimming a half and deleting the other is how you take a piece
out of the middle.

**Select** by clicking a clip or its picture. `Ctrl`/`Shift`-click adds to the
selection, `Ctrl`+`A` takes everything, `Esc` narrows back to one. `Delete`
removes the lot. Drag the ruler or A1 to scrub.

## Speed

**Speed** on the properties panel is how fast a clip runs — `2` is twice as fast,
`0.5` is half. It is part of the *edit*, so it is what the render performs; the
speed selector and `J`/`K`/`L` beside the viewer are still how fast you are
*watching*, and they reach no file. The two multiply on screen, exactly as the
transport's volume and the clip's do.

**Changing it keeps the footage and changes the bar.** "Play this shot at 2×"
means the same seconds of the file in half as much of the programme — so the
clip's bar halves and its in and out points do not move. Slowing a clip down
therefore *grows* it, and it stops at the clip after it exactly as a trim does.
The bar carries a `2×` badge, because a shot at 2× looks exactly like half as
much of the same shot until it plays.

A clip's length is still how much of the programme it occupies; what it takes
out of its file is that times the speed, so trimming half a second off the tail
of a 2× clip gives back a second of footage, and a slip runs out of file when
twice the bar's length reaches the end.

**The pitch moves with the speed.** Speeding a clip up resamples its sound, so
it goes up in pitch like a tape run fast. That is deliberate rather than a
limitation: preserving the pitch means time-stretching, which the internal
compositor cannot do, so a render that did it one way while [the
graph](graph.md) said the other would be describing a render this application
does not perform. `atempo` is a filter you can place on the Graph stage
yourself if you want the pitch held.

**Reverse and freeze are refused, by name.** A negative speed is reverse
playback, which nothing here can express, and zero is a freeze frame, which is
a different feature. Both come back as a sentence rather than being quietly
clamped to something nobody asked for.

Two things a speed costs. A **copied** stream cannot be sped up at all — the
Write stage stops offering to follow a sped-up clip and says why; encode it
instead. And the viewer will not show a filter placed at a sped-up clip's
`after scale` point, which keeps its `fx` badge: see [Not yet](not-yet.md).

## A generator, laid out like a clip

**Generator** in the timeline bar lays out a test source: pick `testsrc`,
`color`, `smptebars`, `mandelbrot` — every picture-producing source this build
has — and what appears on a lane is a **clip**.

It has a track, a start, a length, in and out points, a rectangle on the
canvas, a selection ring, and a program-monitor picture of its own. Drag it,
trim it, `Alt`-drag it to ripple, roll the cut after it, slip inside it, split
it, stack it under a title, crop it, fade it with `Opacity` — all of that works
exactly as it does for a file. The bar is drawn in a colour of its own with the
command that makes it written along it, and it carries no filmstrip and nothing
on A1, because there is no source file to read a thumbnail or a sound from.

**How long one is is a decision, not a measurement.** Something like `color` is
infinite: it goes on producing frames for as long as something pulls them, so
unlike a file there is nothing to discover. One arrives five seconds long —
long enough to see and short enough to trim — and dragging its end *outward*
makes it longer, the same convention an [endless input](sources.md) follows.
The number is kept on the clip and travels with the document.

**Its arguments are one line, on the properties panel** — `size=1920x1080:rate=25`
— with the filter's own description under it. A new one takes the canvas's
size and rate where the filter has options to put them. An option the filter
does not have is refused and nothing changes; the full option table is on that
filter's card on the [Graph stage](graph.md).

**A sound source is not a clip.** `sine` and `anullsrc` are sources too, and
they are deliberately not in the list: a bar with no picture would have
nothing for the canvas and no length anything on screen states. One of those
is a node wired to the mix on the Graph stage instead.

Two things about a generator are genuinely not like a file. It is never the
**master clock**: with a file clip under the playhead the file drives the
transport even with the generator on the lane above it, and a timeline of
nothing but generators runs on the wall clock, the same way a gap between
clips does. And the picture on the monitor is the generator *running* rather
than the generator at the playhead's moment — right for a still pattern, and
for a moving one it is the pictures without the timecode. `O` shows [the
render itself](playback.md#the-output-instead-of-the-clips), which is that
moment exactly.

The [Graph stage](graph.md) draws the filter at the head of the clip's chain,
where an `-i` would be for a file. It is rebuilt on every timeline edit and
gone when you delete the bar. A generator you place on that stage by hand is a
different thing entirely — a node, with no lane and no bar — and the two do
not interfere.

## The When lane

A filter does not have to run for the whole render: `enable=` turns one on and
off part way through, written as an expression on the [Graph
stage](graph.md#when-it-is-on). What that stage cannot answer is the question
the spans are usually about — *does the blur cover the whole of this take, does
the logo come off before the cut* — because the take is here.

So every span that exists is drawn here, under the video tracks, as a region on
the timeline's own ruler:

| | |
|---|---|
| drag a region's end | move where it comes on, or goes off |
| drag its middle | move the whole span, keeping its length |
| press anywhere on the lane | the playhead goes there, as on any other lane |

Ends snap to the same things a clip snaps to — the start of the timeline, the
playhead, and the other clips' edges — because "cover exactly that shot" is
what the gesture is nearly always for.

**The lane is there because spans are.** An edit with none does not carry an
empty lane; a span made on the Graph stage is here when you come back; taking
the last one off takes the lane with it.

**One row per node, and each says which node it is.** A `hue` on one shot and a
`drawtext` over the whole canvas are two rows, each carrying the filter's name
and what it is on — `hue · V1 shot.mp4`, `drawtext · the whole canvas` — in a
colour of its own, so two spans that overlap in time stay two regions you can
each reach with the pointer. A node you delete takes its row with it.

It travels in the [document](document.md) with the rest of the graph, and a
span dragged here is one press of `Ctrl`+`Z` to undo.

Two kinds of span are not on it. A filter on a file the *graph* reads on its
own account — a watermark, a logo bug — is written in that file's own
timestamps with no clip cut from it, so it has a strip in the column instead,
where the ruler is that file's own. And `enable` on a filter that has no
timeline support is reported on the node rather than drawn as a region.

## The Cues lane

Cues this document holds — see [Cues of your own](subtitles.md#cues-of-your-own)
— drawn as regions on the timeline's own ruler, directly above the waveform, with
a strip under it for the words.

It is here rather than in a panel because **a subtitle's timing is judged by
listening to where the line is spoken**: a pair of number fields cannot answer
"does this come on when he starts talking", but a region against A1 can.

| | |
|---|---|
| drag a region's end | move where the cue comes on, or goes off |
| drag its middle | move the whole cue, keeping its length |
| press a region | select it — its words appear in the strip below |
| press the lane | the playhead goes there, as on any other lane |

Ends snap to the same things everything else on this timeline snaps to: the
start, the playhead, and every clip's edges. The strip carries four presses:

| | |
|---|---|
| **+ Cue** | a new cue at the playhead, running to the next cue or two seconds, whichever comes first |
| **Split** | cut this cue in two at the playhead |
| **Merge** | join it with the next one — the words become two lines, the span runs from this start to that end |
| **Delete** | take it out |

A split leaves the words with the first half and hands you an **empty** second
one — where in the sentence the cut goes is not something this can know.

**The lane is there because cues are** — the same rule the video tracks and the
When lane follow. A document with no cue track does not carry an empty one, and
the first one appears the moment `+ Subtitle` on the Write stage makes it or a
file's cues are taken into the document.

Each cue is drawn with **its own words inside it**, which is the opposite of
what the When lane does: a span's identity is its filter, one name belonging
to the whole row, and a cue's identity is what it says. The line is pinned to
the visible left edge, so a cue running off the window keeps its words
readable, cut with an ellipsis rather than spilling into the next one.

Everything here is one press of `Ctrl`+`Z`, and travels in the
[document](document.md). Typing is folded into one undo step the way a slider
drag is.

A cue that came out of a file and still carries ASS override codes says so in
the strip, next to the field you are about to type into, because retyping it
is when they go. See [Cues of your
own](subtitles.md#what-a-fork-costs-and-it-is-the-one-thing-here-that-can-lose-work).

## The Data lane

Numbers read out of a data track — see [Reading a data
track](sources.md#reading-a-data-track) — drawn against the timeline's own
ruler, directly above the waveform.

Beside the waveform is where it belongs: what a number off a camera is *for*
is telling you where in the shot something happened. A list of readings
answers "how fast was I going"; a line under the clips answers "which of these
shots is the one where the bike went over".

One row per picked series. Each row is drawn **per clip**, not per file: two
clips from one recording show two pieces of one line, in the order they were
cut into, following every trim, move and speed change without the track being
read again.

| | |
|---|---|
| the band | the reach of every sample under that pixel — its lowest and its highest |
| the line | their mean |
| a break in the line | no sample landed there |

The band and the line are the same claim A1 makes about sound, and for the same
reason: the mean alone hides every spike, which is the half of a telemetry trace
anybody is looking for, and the maximum alone says a camera was permanently at
its worst moment. A break is a break because a recording whose GPS dropped out
for a minute did not travel in a straight line through it.

Each row is on **its own vertical scale**, drawn between its own lowest and
highest sample, with those two numbers printed beside its name — putting two
different quantities on one axis would invent a correlation that is not in the
data.

**The lane is there because a series is picked**, the same rule the video
tracks, the When lane and the Cues lane follow. Nothing on it can be edited: a
reading is what a file says. Pressing it moves the playhead, as on every other
lane.

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
clips.

**A lock is visible before the drag, never discovered after it.** The padlock
shuts, the track's name goes to the accent colour, and the whole lane takes a
faint wash of it — so a locked group is two or three lanes plainly marked as one.
Hovering the padlock says what the press will do, including the case where a
track is the only locked one and so nothing else moves with it yet.

Locking a lane and then emptying it costs nothing: a lock lasts as long as its
lane is on the screen, and a lane that has gone takes its lock with it.

Only ripple is affected. Dragging a clip along its lane, trimming, rolling and
slipping all do exactly what they did.
