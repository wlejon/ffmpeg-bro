[← The manual](README.md)

# The supercut application

A second application, in a second window, from a second executable:

```
./build/Release/ffmpeg-bro-supercut [document.fbro]
```

It does one job — find what somebody said across hours of recordings and cut it
together — and it is separate from `ffmpeg-bro` because that job is a loop
between three things (find a moment, hear it, put it in the row) and none of the
workbench's six stages is on that loop.

**Run it from the repository root**, because the corpus it reads is
`build/corpus/find.json`, a path relative to the working directory. Without that
file the finder says so and the rest of the application still works — you can
open recordings by hand and cut them.

## What is shared with ffmpeg-bro, and what is not

Everything under the interface: the clips and what a trim, a slip and a speed
change mean; the inputs; the corpus and the search; the filmstrips and
waveforms; the render; and **the document**. A `.fbro` written here opens in
`ffmpeg-bro` and vice versa — it is the same file by the same serialiser. This
is where an edit starts, not a dead end you have to redo the moment it needs a
filter on it.

Nothing of the interface is shared. There are no stages, no node graph, no
encode form and no modes.

**Opening a workbench document flattens it.** This application has one lane; a
document with clips on higher tracks brings them all down into the row, in the
order they started, and says how many it moved. The clips are all still there —
but a stack is not a sequence, and saving afterwards saves the flattened one.

## The window

**Left — the finder**, and three tabs because there are three questions:

- **Recordings** — what is in the corpus at all: each broadcast with its date,
  its length and how many words are in it. This is what the window opens on, so
  there is something there before anybody types.
- **Words** — every place a phrase was said.
- **Talking** — the stretches where somebody talked without stopping.

The last two are the same questions the workbench's panel asks, with the same
answers, because [the search is one implementation](find.md). All three list the
same way: `▶` plays it, `+` puts it at the end of the mix. Adding a whole
recording adds the whole of it — six hours if that is what it is — because
trimming it down is one gesture away and taking the first minute instead would
be deciding something nobody asked for.

**Right — the picture**, and it is one of three things at a time. The bar under
it says which:

- *auditioning* — a result from the list, with its own sound
- *the clip under the playhead* — silent, because there is nothing to hear in a
  still. This is what you are looking at while you edit
- *the render* — while the mix plays

That last one is the whole of playback here. The workbench plays the clips and
uses the render only to smooth over the cuts; this plays **only** the render,
because a supercut is nothing but cuts — fourteen fragments of a second each is
the ordinary case — and playing the clips would be almost entirely seams. The
cost is a wait when you press play while the render is built, and the bar says
so while it happens.

**Along the bottom — the mix.** One row of cards in the order they play. A card's
width is its length and its left edge is its moment, so the row is its own
ruler: click anywhere on it to put the playhead there.

## The four gestures

Each is a different grab point on the card. Nothing is modal, so there is
nothing to switch on and nothing to leave switched on.

| Grab | Does |
|---|---|
| the **grip** along the top | drag sideways to **reorder** |
| either **edge** | **trim**, and everything after closes up |
| the **picture** | **slip** — the card stays put and the footage moves inside it |
| the **rate badge** | **speed** — the same footage, in more or less time |

**Trimming always ripples**, because the mix has no holes in it: shorten a piece
and the rest pulls back, lengthen it and the rest moves along. On the workbench
that is a second gesture behind a mode, and rightly so — there a clip may be
placed against a soundtrack and closing the gap would move it off. Here there is
one lane and nothing to place anything against.

**Slip is the one for a cut that landed wrong.** A word taken with a second and
a half either side sometimes has the wrong second and a half; dragging the
picture inside the card moves the footage without moving the card, so the piece
keeps its length and its place in the row and starts somewhere else. Dragging
right shows *earlier* footage — you are pushing the film under the window rather
than moving the window over the film, which is the convention every editor uses.

**Speed holds the footage and changes the length.** That is what separates it
from a trim: a trim throws frames away, a rate change fits the same frames into
a different amount of time. The badge shows what it is and turns orange when it
is not 1.00×.

Anything a gesture cannot do, it stops short of doing rather than refusing: an
edge that will not go further has run out of footage, and a speed that will not
go further has hit the range the model holds (0.05× to 20×).

## Writing the file

One button. H.264 and AAC into an mp4, at the canvas's own size and rate — the
canvas being the first recording you put in the mix. There is no codec menu
because a tool for cutting speech together does not need one; when a render
needs more than that, save the document and open it in
[ffmpeg-bro](output.md), where all of it is.

The render is the same one the workbench performs, from the same spec.

## Keys

| | |
|---|---|
| `Space` | play / stop |
| `Home` `End` | start, end |
| `←` `→` | one frame; with `Shift`, one second |
| `M` | mute |
| `Delete` | remove the selected clip and close the gap |
| `/` | jump to the search box |
| `Ctrl+S` `Ctrl+O` `Ctrl+R` | save, open, render |

## Getting a corpus

The recordings and their transcripts are [`tools/supercut.js`](../../tools/README.md)'s,
which is deliberately not part of either application:

```
ffmpeg-bro-headless ui/ tools/supercut.js -- pull turk
ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe turk
ffmpeg-bro-headless ui/ tools/supercut.js -- index turk
```

`index` is the one that writes the manifest both applications read. **Re-run it
after transcribing anything new**, or the finder reads a stale list.
