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

### `+` cuts the moment out

Pressing `+` puts the clip in the row **on the frame you press it**, and starts
a stream copy of that moment — the words, with **ten seconds either side** — out
of the recording into a file of its own. A thin line along the bottom of the card
says how far that has got; on a local recording it is gone before you look at it
(70 ms for a 25-second cut of a six-hour file). You can play, drag and trim the
card the whole time it is happening.

**Ten seconds either side is what makes the cut fixable.** A transcript says
roughly where a word is, not where the sentence starts, so a piece taken to the
word cannot be widened — and widening it is the first thing you want. The handles
are what trim and slip have to work with.

Walking a list pressing `+` on one row after another is what this is for and what
it is built around: each press is its own copy, they run several at a time beside
everything else, and none of them blocks the next.

What you get for it is a mix that is its own footage. Thirteen moments taken out
of four six-hour recordings read **270 MB** instead of sixty gigabytes, and the
recordings are not needed again — you can put the drive away.

### And then it gets a file you can drag over

A cut is small but it is the same *kind* of file as the recording, and that is
what decides how a scrub feels: dragging a trim edge asks for a different frame
every few pixels, and each one costs a decode from the last keyframe. On the
footage this is for that was 50 ms a frame, which is a picture that arrives after
your hand has stopped.

So a second file is made behind each cut: the same piece, 720p, with **every
frame a keyframe**. Nothing is rendered from it and nothing else changes — it is
only what the picture on the right is read out of while you work. Dragging an
edge went from 50 ms a position to **7 ms**, which is a picture that keeps up.

The bar on the card covers both stages, and the row above says `preparing N`
while anything is still being made. It takes about **three seconds per cut**,
one at a time, and the clip is fully usable throughout — at the old speed until
its file lands, then at the new one.

A recording you have *not* cut down — anything over five minutes — does not get
one, because making it would take longer than the scrubbing it would speed up.
Those still work; they are just as slow as they were.

Both kinds of file are written under `build/cuts/`, named after what they were
made from, so adding the same moment twice writes one file and reopening a
document finds them already there. **The cuts are inside the document and the
scrub files are not** — a `.fbro` names its cuts, so deleting `build/cuts/`
breaks the documents that point at it. Deleting only the `-p720.mkv` files costs
nothing: they are made again next time, and everything works meanwhile at the
speed it worked at before there were any.

If a cut cannot be made — the recording will not answer, the copy fails — the
card turns amber and the clip stays a clip of the recording, which works and is
slower. Nothing is lost either way.

**Right — the picture**, and it is one of three things at a time. The bar under
it says which:

- *auditioning* — a result from the list, with its own sound
- *the clip under the playhead* — silent, because there is nothing to hear in a
  still. This is what you are looking at while you edit
- *the render* — while the mix plays

That last one is the whole of playback here. The workbench plays the clips and
uses the render only to smooth over the cuts; this plays **only** the render,
because a supercut is nothing but cuts — fourteen fragments of a second each is
the ordinary case — and playing the clips would be almost entirely seams.

The cost is a pause when you press play, while the render opens the files it
reads — about a fifth of a second on a mix of a dozen cuts. **Pressing play
again without having changed anything does not pay it** — the render is kept for
half a minute after you stop, so stopping to look at something and going on is
free. Changing the edit or moving the playhead is what makes a new one.

**Along the bottom — the mix.** One row of cards in the order they play. A card's
width is its length and its left edge is its moment, so the row is its own
ruler: click anywhere on it to put the playhead there. Each card carries a strip
of pictures over the shape of its sound, which is what you aim a trim with — the
pictures say where you are and the waveform says where the words are.

**Drag the divider above it** to give the mix more or less of the window; where
you leave it is remembered. It starts at about a third, because editing is the
job here and the picture is what you check it against.

**Zoom with the wheel** over the strip, which zooms about the pointer rather
than about the start, so the piece under the cursor stays under it. `+` and `-`
do the same about the playhead, and `0` — or **Fit** — puts the whole mix on the
screen. Two pixels a second up to twelve hundred: the whole of a long supercut,
or a single frame wide enough to aim at.

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
| `+` `-` | zoom the mix in, out |
| `0` | fit the whole mix on the screen |
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
