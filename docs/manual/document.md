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

The name is in the top bar, with a dot beside it while there is something
unsaved. A document named on the command line opens as one:
`ffmpeg-bro my-edit.fbro`.

## What is in it

A `.fbro` file is indented JSON, on purpose: it describes an edit, it belongs in
a repository beside the footage, and a diff of one should be readable. It has
five parts.

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
- **`canvas`** — the output size, the timeline's rate, and stacked or grid.
- **`graph`** — everything you inserted, locked, placed and wired on the
  [Graph](graph.md) stage.
- **`output`** — what [Encode and Write](output.md) are set to, plus the three
  things that only mean something inside one edit: the chapters, the render
  range, and the output path.

That last split is the same rule the workspace is built on, read the other way
round. The application already remembered your encoder, your container and your
house rules about proxies in `localStorage`, because the second render is nearly
always the first one again — but it deliberately did *not* remember a chapter
called "Opening, 0 to 12.5 s", because carrying that into the next edit would put
a mark somewhere it means nothing. Inside the document that timeline is in, it is
exactly right.

It is also what `Ctrl`+`N` keeps and drops. A new document empties the timeline,
the inputs and the graph, and clears exactly those three — the chapters, the
range and the output path — because each names something about an edit that has
just gone. Your encoder, container, quality and render size stay, because those
are habits and the next render is nearly always the last one again.

## Ids, and why they are written down

The interesting part of a document is not the geometry. It is that a clip and an
input each keep **the same id** they had.

Both are names that something else writes down. A filter you inserted on the
Graph stage is pinned to `clip:7/after-scale`, and a source node reading a
watermark names `in3`. Renumber on open and every insert quietly moves to a
different shot and every source node quietly reads a different file — which is
worse than losing them, because nothing on screen would say so.

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

## What it is not

It is not a container for media. Nothing is copied, embedded or cached; a
document is a description of a render, and every frame it refers to lives where
it always did.

It is also not a save of the *session*. Which clip you had selected, where the
playhead was standing, what the analysis worker had got round to and which stage
you were on are all the running application rather than the edit, and none of
them is written.

And there is still **no undo** — see [Not yet](not-yet.md). The object this is
built on is what makes one straightforward, because a stack of undo states is a
list of exactly what gets written to a file here, but the stack is not built.
