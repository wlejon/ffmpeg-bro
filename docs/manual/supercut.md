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

**Run it from the repository root**, because the corpus it reads and writes is
under `build/corpus/`, a path relative to the working directory. With no corpus
there yet, type a channel's name into the Recordings tab and it will go and get
one; you can also open recordings by hand and cut them.

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

- **Recordings** — what a channel has: each broadcast with its date, its length,
  and whether it is here yet. This is what the window opens on, so there is
  something there before anybody types.
- **Words** — every place a phrase was said.
- **Talking** — the stretches where somebody talked without stopping.

The last two are the same questions the workbench's panel asks, with the same
answers, because [the search is one implementation](find.md). All three list the
same way: `▶` plays it — and becomes `■`, which stops it, as does `Space` — and
`+` puts it at the end of the mix. A moment stops on its own at the end of
itself; a whole recording is six hours and does not. Adding a whole
recording adds the whole of it — six hours if that is what it is — because
trimming it down is one gesture away and taking the first minute instead would
be deciding something nobody asked for.

### What is running

Four kinds of work run in the background here — a recording being copied off
Twitch, a transcription, the cut a `+` starts, and the small file a card is
scrubbed with — and each of them used to be visible only in its own corner. The
count in the top bar is all of them: **`3 running`** appears there whenever
something is, and opening it lists every job with what it is, how far it has got,
and a **Stop** where stopping is a thing that can be done.

Nothing is running is not a state it says out loud — the button is simply not
there. `Esc` closes the list.

**A job of a channel you have moved away from is still in the list**, with the
channel's name in front of it. Downloads and transcriptions go on running when
you look up another channel — that is the point of starting them — and a list
that showed only the channel on screen would leave you watching nothing happen
with no way to see what was holding things up.

**Downloads and cuts do not wait for each other.** Two of each run at once: the
downloads are limited because they share one connection, and a cut reads a file
already on this disk, so it is not queued behind one. Two long downloads and
thirty cuts is thirty cuts that start immediately.

Two jobs have no Stop, and it is the same reason both times: a download in its
last minute is putting two halves back into one file, and stopping there leaves
neither; a scrubbing copy asked for by a clip in the mix would only start again
on the next frame. Take the clip out and that one goes with it.

### Getting the recordings

Type a channel's login into the box on the Recordings tab and press **Look up**.
It asks Twitch for the twenty newest past broadcasts and lists them beside the
ones already here. Nothing is downloaded by looking.

Each row then carries the one thing left to do to it:

| The row says | The button |
|---|---|
| a date, a title, a length | **Get** — copy the recording onto this machine |
| a percentage, and how many gigabytes | **Stop** |
| the size on disk | **Transcribe** — read every word of it |
| `queued` | **Stop** |
| a percentage, the words so far, and `81×` | **Stop** |
| the word count | `▶` and `+`, which is where the editing starts |

**A press comes straight back.** Getting a recording begins with a round trip to
Twitch and the row says so while that happens; the copy itself runs beside
everything else, several at a time, and you can search, audition and edit while
they do.

**Transcriptions go one at a time** and the rest say `queued` — the model runs on
one device and starting ten would only be ten rows claiming to be reading. The
two numbers on a running one answer different questions: the percentage is how
far down the recording it has got, and the multiplier is how fast. Six hours at
81× is about five minutes, which is what tells you whether to wait.

**When one finishes it is searchable immediately.** The Words and Talking tabs
pick up the new transcript with nothing to press and nothing to restart.

**The tick at the left of a row says whether searches run over it.** They all
start ticked, because they are all being searched. Untick the ones you do not
mean and the Words and Talking tabs answer about the rest only — the line at the
top says `3 of 20 recordings` while they do, and **All** beside the channel box
puts them back. Twenty broadcasts are twenty different afternoons, and a phrase
found four hundred times across the lot is a list nobody can read.

Three things about it. Only a recording that has been transcribed has a tick;
there is nothing to search in one that has not. The last ticked box will not come
off — there is no way to ask for nothing. And the choice is dropped when you move
to another channel, but not when a transcription lands.

**A download that was interrupted carries on where it stopped.** Close the
window, press **Stop**, lose the machine — press **Get** again and it picks up
from the last whole second it had, rather than starting a thirty-gigabyte
recording over. It takes a few seconds to work out where that is (six on a
twenty-gigabyte part, because a half-written file does not record its own
length), then fetches only the rest and puts the two together. The row says
`joining` while it does, which is a minute of local disk at the end and cannot
be stopped — stopping there would leave two halves and no recording. The result
is the same file to within a frame: measured 120.054 s against the 120 asked
for.

Two things follow from that. **Interrupting a resume costs only the resume** —
what was underneath it is never at risk, though a second interruption does drop
what the second attempt had fetched. And **do not run the batch command below
against a channel this window is downloading**: a recording being written is
refused rather than resumed, which is what stops two copies of one broadcast
being poured into one file, but the two faces cannot coordinate beyond that.

Where the files go and what a stopped job leaves behind is the same as the
command line's, below — this is the same store.

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
document finds them already there. A file that turns out not to be the moment its
name claims — one left by an older version that cut two seconds wide — is made
again, once, the first time it is used. **The cuts are inside the document and the
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

**The bar under the strip is where you are in the mix.** Zoomed in, most of the
row is off the screen; drag the bar to get to the rest of it, or press the track
to go straight there. It shows how much of the mix is on the strip, so it is
absent while all of it is. Playback carries the strip along on its own.

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

**The playhead is a magnet while you trim.** Park it on the word you want the
piece to start or stop at — clicking the row puts it there, and `←` `→` walk it
a frame at a time — then drag the edge to it and the last few pixels are taken
for you. The line brightens and thickens as it takes the edge, so you can see it
happen. Nothing else on the strip snaps: in a packed mix every neighbour is
already touching, so the playhead is the only thing there is to land on.

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
| `Space` | play / stop — or stop what a row is playing, if a row is playing |
| `Home` `End` | start, end |
| `←` `→` | one frame; with `Shift`, one second |
| `+` `-` | zoom the mix in, out |
| `0` | fit the whole mix on the screen |
| `M` | mute |
| `Delete` | remove the selected clip and close the gap |
| `/` | jump to the search box |
| `Esc` | close the list of what is running |
| `Ctrl+S` `Ctrl+O` `Ctrl+R` | save, open, render |

## Getting a corpus in a batch

The Recordings tab above is the way in when you want *this* broadcast now. For
five of them overnight there is [`tools/supercut.js`](../../tools/README.md),
which reads and writes the same store:

```
ffmpeg-bro-headless ui/ tools/supercut.js -- pull turk --last 5
ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe turk --last 5
```

The command line is the one with the knobs on it — how many, how many to skip,
which device, and redoing a step the store has already finished — and it can be
left running with no window open. The tab has none of those and one channel at a
time.

Either way, `transcribe` writes the manifest both applications read when it
finishes, so there is nothing to remember after it. `index turk` writes the same
file on its own, which is what a store built by an older version of these tools
needs once.

**Do not pull the same recording from both at once.** A copy in flight is not
finished, and neither side counts it as here — so the window will still offer
`Get` on a recording a batch is already fetching, and the two would write over
each other. Transcribing is safe either way: a recording that is not completely
pulled is refused by name.
