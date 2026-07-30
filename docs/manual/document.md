[← The manual](README.md)

# The document

The one part of this manual that is not about a stage. A document is the whole
chain at once — every `-i`, every clip, the canvas, the graph you wired and what
the Encode and Write stages are set to — held as one object, written to one
file, and opened again.

| | |
|---|---|
| `Ctrl`+`S` | save (`Ctrl`+`Shift`+`S` to save somewhere else) |
| `Ctrl`+`O` | open one |
| `Ctrl`+`N` | start again |
| `Ctrl`+`Z` | undo (`Ctrl`+`Shift`+`Z` or `Ctrl`+`Y` to redo) |

The name is in the top bar, with a dot beside it while there is something
unsaved. A document named on the command line opens as one:
`ffmpeg-bro my-edit.fbro`.

## What is in it

A `.fbro` file is indented JSON, on purpose: it describes an edit, it belongs in
a repository beside the footage, and a diff of one should be readable. It has
seven parts.

- **`inputs`** — one entry per `-i`, **in order**, because the order is the `-i`
  number that a filtergraph's `[0:v]` counts in. Each is written as *what opens
  it* rather than as a file: the path, the forced demuxer, the demuxer's option
  bag, the decoder's, the hardware decode, `-ss`, `-to`, `-itsoffset` and
  `-stream_loop`. Opening a document is a reopen, so what has to be stored is
  what the [Sources](sources.md) stage reopens from.
- **`clips`** — where each one sits, which input it is cut from, its in-point,
  its length, its geometry, its level. Nothing derived: a clip's name, size,
  rate, duration and probe are all its input's answer, so storing them would be
  storing an answer the next reopen may contradict.

  **A clip says what it is cut from, and there are two answers.** Usually an
  input's id. For a [generator clip](timeline.md#a-generator-laid-out-like-a-clip)
  it is `"generator": { "filter": "testsrc", "params": { "size": "1920x1080" } }` —
  the filter and its arguments, because there is no file for an input to describe.
  One of the two, never both. A generator carries one number a clip of a file does
  not, its `media`, and that is the rule above stated exactly rather than an
  exception to it: how much of a `color` there is cannot be re-measured on the next
  open, because libavfilter would produce for ever. It is a decision the edit is
  holding, so the edit holds it. A generator this build has no filter for is
  skipped on the way in with libavfilter's own sentence, the same way a clip of a
  file that has moved is.
- **`canvas`** — the output size, the timeline's rate, and stacked or grid.
- **`tracks`** — the settings of a track, for the tracks any have been set on:
  today the [sync lock](timeline.md#the-sync-lock), which says whether an
  `Alt`-drag ripples that track alone or every locked track together. Written as a
  bag keyed by the track number — `"tracks": { "1": { "locked": true } }` — and
  **not** as a list of tracks, because how many lanes there are is worked out from
  the clips and a list would be a second answer to that. A document with no
  `tracks` at all, one written before there were locks, opens as a timeline that
  ripples one track at a time, which is what it describes.
- **`graph`** — everything you inserted, locked, placed and wired on the
  [Graph](graph.md) stage.
- **`output`** — what [Encode and Write](output.md) are set to, plus the three
  things that only mean something inside one edit: the chapters, the render
  range, and the output path.
- **`session`** — where you were in it: the selected clip, the playhead, the
  stage, and the timeline's window. The one part that is not the edit.

The `output` split is the same rule the workspace is built on, read the other way
round. The application already remembered your encoder, your container and your
house rules about proxies in `localStorage`, because the second render is nearly
always the first one again — but it deliberately did *not* remember a chapter
called "Opening, 0 to 12.5 s", because carrying that into the next edit would put
a mark somewhere it means nothing. Inside the document that timeline is in, it is
exactly right.

## Where you were in it

Open a document and it comes back where it was left: the clip that was selected
is selected, the playhead is where it was standing, the timeline is at the zoom
it was at, and you are on the stage the last save was made from.

**Including somebody else's document.** That was the question that kept the
session out for a while — whether opening a file you were handed should move
*your* playhead — and the answer is yes, because a `.fbro` is a handoff of work
in progress rather than an archive of a finished one. Handing over the
arrangement while throwing away where the work had got to is handing over half of
it. There is no "only my own documents" case, because that would mean identity on
the file, and nothing in a document is about who wrote it.

Two things it deliberately is not.

It is **not an undoable act**. `Ctrl`+`Z` is the edit and nothing else — the
session is taken out of a history state at the one place that decides what a step
is — so scrubbing does not fill the stack, and a press never answers by moving
the playhead or switching stages.

It **does not mark the document unsaved**. The dot beside the name is about work
you could lose; a dot that appeared because you clicked a clip would be a dot
that means nothing. So the session written is the session as of the last save,
and moving the playhead afterwards costs nothing and says nothing.

A document that carries no session at all — one written before there was one, one
hand-edited, one that names a clip that is no longer in it — opens at the top of
the timeline, fitted, with nothing selected. A named clip that has gone comes back
as *nothing selected* rather than as whichever clip now happens to have that
number; a clip id is a name the graph's anchors are written against, and picking
the wrong shot looks exactly like having picked it.

## What `Ctrl`+`N` keeps

It is the same split `output` is built on. A new document empties the timeline,
the inputs and the graph, and clears exactly those three — the chapters, the
range and the output path — because each names something about an edit that has
just gone. Your encoder, container, quality and render size stay, because those
are habits and the next render is nearly always the last one again.

## Ids, and why they are written down

The interesting part of a document is not the geometry. It is that a clip and an
input each keep **the same id** they had.

Both are names that something else writes down. A filter you inserted on the
Graph stage is pinned to `clip:7/after-scale`, a source node reading a watermark
names `in3`, a copied stream that [follows a
clip](rendering.md#copying-instead-of-encoding) names the clip it follows, and the
session above names the clip that was selected. Renumber on open and every insert
quietly moves to a different shot, every source node quietly reads a different
file, and a lossless cut quietly follows something else — which is worse than
losing them, because nothing on screen would say so.

This is what closes a hole the graph has had since it grew source nodes. A graph
restored from `localStorage` refuses to bring back a node naming an input, and
the refusal is correct: the inputs themselves did not survive a restart, and
their ids started again from one, so a restored `in3` would name whichever file
happened to be third that run. A document restores the inputs *and* their ids
first, so `in3` means the file it meant when it was written — same data, and the
only difference is whether the thing it refers to came back with it.

## When a file has moved

A document names files it does not contain. If one is not there when the
document is opened, the input comes back carrying libav's own message — exactly
as a [Sources](sources.md) row shows a broken input today — and the clips cut
from it are **not laid out**. What was left out is said on the way in.

Nothing is lost: the file on disk still describes them. Fix the path and open it
again. Laying such a clip out anyway would mean a rectangle of an unknown size
over an unknown length, which is a picture of an edit rather than the edit.

## Undo

Undo is the same object put to a second use. A step of history is a snapshot,
and going back one is opening it — so there is no separate model of "what
changed", no list of inverse operations, and nothing that can describe a state
the application could not be in.

Three rules decide what a step is.

**A gesture is one step, not a hundred.** A clip dragged along the timeline
reports every mouse position and one *moved* at the end; the positions are
ignored and the end is the step, and what it goes back to is where the drag
started. A slider has no such pair — the properties panel reports every pixel —
so changes of the same kind arriving within half a second of each other fold
into the step the run began with. Without that rule, one drag of a crop handle is
forty presses of `Ctrl`+`Z`.

**A change that changed nothing is not a step.** States are compared, so a
redraw, a tidy-up or an edit that came back to where it started never becomes a
step that appears to do nothing when it is undone.

**`Ctrl`+`Z` only ever changes what is in front of you.** There are two histories
and the stage you are standing on decides which one a press is answered by: the
edit — the clips, the inputs, the canvas, the graph — on the stages about the
timeline, and the Encode and Write stages' settings on those two. A press on the
timeline that silently reverted a codec three stages away would be worse than no
undo at all, and so would one on the Write stage that quietly moved a clip.
Neither stack can surprise you with the other's work, and the button says which
one it is about: on the Write stage with nothing to go back to it reads *nothing
to undo on this stage*.

The form was outside history for a while on the argument that the control you just
changed is in front of you with its old value one keystroke away. That is true of
one control and false of the press that changes twenty: *Start from* rewrites the
codec, the rate control, the quality, the preset and the pixel format at once, and
the raw option editor and the stream list both rewrite whole bags. "What was it
before I pressed that" has no other answer.

Arriving on the encode side is not a step. Walking over there fills in a path, a
size and the codecs from the timeline — and on a first run a whole preset — which
is the stage arriving rather than a decision anybody took, so it becomes the
baseline. An undo offering to go back to *no filename* would be offering to undo
having walked there.

Two things it deliberately does not disturb. Opening a document starts the
history again, because undoing across an Open would land in the middle of
somebody else's edit. And an undo leaves the playhead, the selection, the stage
and the timeline's zoom exactly where they are — putting a crop back while you are
looking at a shot two minutes in should leave you looking at that shot. Those
four *are* in the document, and they are taken out of a history state at the one
place that decides what a step is: a stack that recorded them would fill up with
states that differ in nothing anybody did, and comparing two of them would stop
meaning "the edit differs".

A **sync lock** is the same question answered the other way, and the pair is worth
reading together. It is in the document and it stays in a history state, so
locking a track is one step of undo — because the test is not whether somebody
chose it but whether it changes the clips, and a lock decides what the next
`Alt`-drag does to everything after the cut. Where you are standing is not an edit;
what a drag will do is.

Applying a state **reconciles** rather than rebuilds: an input the state
describes exactly as it already is costs nothing, and a clip of one keeps the
`<video>` it already has. That is not a refinement, it is what makes undo usable
— tearing down every decoder to put a crop back would take a second and blank
the picture.

The settings track goes back through `store.adopt`, which is the same reader a
document and the workspace both go through — so a state put back is sanitised
exactly as one read off the disk is, and there is one answer to what a stored
container means. Both tracks are the same stack with the same three rules; they
differ in what a state *is* and in what putting one back means, and in nothing
else, because two copies of the coalescing rule would be two answers to what one
gesture is.

## What it is not

It is not a container for media. Nothing is copied, embedded or cached; a
document is a description of a render, and every frame it refers to lives where
it always did.

It is not a snapshot of the running application. It holds where you were in the
edit — [above](#where-you-were-in-it) — and that is four numbers and a name.
What the analysis worker had got round to, which waveforms and filmstrips had
arrived, what a render last said and what a preview was holding are all the
process rather than the work, and none of them is written.

And it is not a version history. Undo is a stack held while the application is
running; closing it and opening the file again is the file, not the last hundred
things you did to it.
