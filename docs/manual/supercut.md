[← The manual](README.md)

# The supercut application

A second application, in a second window, from a second executable:

```
./build/Release/supercut [document.fbro]
```

It does one job — find what somebody said across hours of recordings and cut it
together — and it is separate from `ffmpeg-bro` because that job is a loop
between three things (find a moment, hear it, put it in the row) and none of the
workbench's six stages is on that loop.

**Start it however you like** — a double-click is fine, and where you were
standing when you did makes no difference. The corpus it reads and writes is
`build/corpus/` beside the application itself, not beside the shell. With none
there yet, either type a channel's name into the Recordings tab and it will go
and get one, or point it at a folder of footage you already have; you can also
open recordings by hand and cut them.

Nothing in this window needs a terminal: getting the speech model, getting a
recording, reading its words, finding a moment, cutting it and writing the file
out are all presses. [`tools/supercut.js`](../../tools/README.md) does the same
work in batches for anybody who prefers one.

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

**Left — the finder**, and four tabs because there are four questions:

- **Recordings** — what a channel has: each broadcast with its date, its length,
  and whether it is here yet. This is what the window opens on, so there is
  something there before anybody types. It is also where you point it at a
  folder of footage you already have.
- **Words** — every place a phrase was said.
- **Talking** — the stretches where somebody talked without stopping.
- **Line** — a sentence, typed; it finds every word of it in this voice, and
  you hear it and tune it before it goes in the mix.

Words and Talking are the same questions the workbench's panel asks, with the
same answers, because [the search is one implementation](find.md). All four list
the same way: `▶` plays it — and becomes `■`, which stops it, as does `Space` — and
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

**With no speech model there is no Transcribe.** Reading words needs a Parakeet
checkpoint on this machine, and three places are looked in for one: a
`models/parakeet` folder beside the application, and `brosoundml/weights/parakeet`
in a brosoundml checkout or in bro's own. With none of them holding one, no row
offers to be read and the line at the top says `no speech model` — a button that
could only fail is worse than no button.

Two presses stand beside the channel box while that is true, because there are
two answers. **Get model** fetches the weights, 2.5 GB, into the first of those
places: it runs beside everything else, says where it has got to on the same line
and in the running list, and **Stop** leaves what it has so the next press
carries on from there rather than starting again. It is the only download this
application ever starts that nobody pointed at, so it happens on that press and
on nothing else. **Model…** is the other answer: point at a checkpoint you
already have, anywhere on this disk, and it is remembered. Nothing is copied.

When the last file lands, every row grows its **Transcribe** on that frame.
`brosoundml/scripts/download-parakeet.sh` writes the same checkpoint from a
shell, for a machine where that is easier.

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

### Footage you already have

Beside the channel box are **Folder…** and **Files…**. A folder becomes a
channel of its own, named after the folder — point it at `D:/footage/interviews`
and you get a channel called `interviews` holding every video directly inside it.
**Files…** takes files you pick one by one, into a channel called `local`.

**Nothing is copied.** The files stay exactly where they are; what goes into
`build/corpus/` is a small record per file and, once you transcribe one, its
words. Two things follow. Moving or deleting a file later leaves its row and its
words and takes away its picture, which is the same state a broadcast Twitch has
dropped ends up in. And a corpus of your own footage describes *this* machine's
disk — a pulled channel can be carried to another machine and one of these
cannot.

Each row then reads the same way a broadcast's does, minus the **Get** — the
recording is already here — and with three conditions a download cannot be in:

| The row says | What it means |
|---|---|
| `measuring` | it is being opened to find out how long it is; a moment |
| `no soundtrack` | it plays and it adds, and no search will ever find it |
| `would not open`, `not where it was` | say which; **Re-scan** is what mends both |

**Transcribe** appears once a file has been measured, and from there it is a
recording like any other: the words are searchable, `+` cuts a moment out of it,
and the Line tab can say things out of it.

**Press the same button again to look at the folder again.** Where a broadcaster
gets **Look up**, a folder gets **Re-scan**: it takes in whatever has appeared
since and leaves everything already transcribed alone. Nothing is ever removed by
a re-scan.

For a folder of five hundred clips, `adopt` on the command line below does the
same thing without a window to watch it in.

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
absent while all of it is. Playback carries the strip along on its own. While
your hand is on a card the strip holds still — a trim changes how long the mix
is on every move, and the bar and the window settle when you let go rather than
sliding about under the edit.

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

One consequence you can see: **trimming the head does not move the card**, it
moves everything inside and after it. The left edge stays where it was and the
footage slides back to meet it. The playhead slides with it, so it goes on
standing on the sound it was standing on — and if you trim past it, it ends up
on the clip's new first frame.

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

## Finding talking, yelling, and activated speaking

The **Talking** tab finds unbroken stretches of speech: a stretch is however
long somebody went with every **pause under** the number of seconds set (two to
begin with), and only stretches of **at least** the other number are listed.
Changing either number searches again.

The mode selector offers three distinct ways to audition and rank speech:

| Mode | What it finds and ranks |
|---|---|
| **Longest stretches** | Longest unbroken monologues first |
| **Activated / fast pace** | Fast delivery and high cadence, ranked by words per second; a third number, **faster than**, sets the floor |
| **Yelling / high energy** | Shouted outbursts, high vocal intensity, and exclamations (ranked first by delivery, then re-ranked by what the sound actually measures) |

Each row displays the duration, word count, speaking cadence (`words/s`), and badges
for fast delivery (`fast`), exclamation count (`!`), and acoustic loudness (`loud`).

**Yelling answers twice.** The list arrives on what the words say — pace,
exclamation marks, words written in capitals — and then the top two dozen
stretches are *listened to* and the order settles, which is when `loud` appears
on the ones that earn it. The bar under the note says which half is happening:
`searching · 3 of 11 recordings`, then `listening · 7 of 24 stretches`. Nothing
below the top two dozen is listened to, so the absence of `loud` further down the
list means nobody measured it rather than that it was quiet.

**Every search fills in rather than blocking.** On a hundred-hour corpus the
first search of a session is about ten seconds of reading the transcripts and the
window stays usable throughout; searches after it are a fraction of a second. The
list is complete when the bar goes away.

In the **Words** tab:
- Searching for `!` matches every exclamation or shouted word in the corpus.
- Appending an exclamation point to a word (e.g. `stop!`) searches specifically for
  the yelled/exclaimed take of that word.

## The line

The **Line** tab is for the mix you can already hear: you know what it should
say, and what you need is for somebody to go and find every word of it in this
voice and put them in a row. It goes in three steps, and the mix is the last of
them: write the line and hear it, fix it by ear, then put it in the mix.

**Type.** The box at the top takes a whole sentence. Every word is found as you
finish typing it and played to you as it lands, so a word this streamer never
said is one you hear is missing before you have finished the sentence. Nothing
goes in the mix. Under the box the line is drawn on a ruler of seconds: each
word a block as wide as it is long, with the shape of its own sound on it, and
the space after it its rest. A comma is a short rest and a full stop a long one,
so `what the hell, are you doing.` breathes where the text does. `"you cross"`
in quotes is one word with a space in it, `what|wot` is either spelling, and a
new line is the longest rest. While you type, the words the corpus has that
begin with what you have typed appear under the box, each with how often it is
said: `↓` `↑` pick one and `Tab` or Enter takes it.

**Enter says the line** — the whole sentence back, out of the recordings,
lighting each word as it goes. **Say** and `Space` do the same, and **loop**
plays it round. It is the clips one after another rather than the render, so
there is a seam at every word, which is also what the words sound like.

**Each word is given its cleanest take**: the one nearest the length the word is
usually said in, with the most quiet either side of it. A word said three
thousand times has three thousand takes, ranked that way, and a word said twice
on one line takes two of them. **Pace** says the line faster or slower: within
a whole tone it is the words that are sped up, which you hear, and past that it
is the rests that close up, so the voice stays the voice.

**Fix it by ear.** Pressing a word plays it and selects it, and the panel under
the ruler is about it: what it says, which take of how many, how long, and its
own sound with the recording either side of it, the cut bright in the middle.

| Do | Gets |
|---|---|
| press a word | plays it; the panel is about it |
| `[` `]` — or a numbered take in the panel | the next take, played as it lands |
| drag either edge of the sound in the panel | moves that cut point; drag the middle to slide both |
| `,` `.` | the word five milliseconds earlier or later; twenty-five with `Shift` |
| drag a word's **right edge** on the ruler | where the word ends |
| drag the **space after** a word | how long its rest is |
| drag a word by its **top edge** | moves it along the line; the box follows |
| **gain** | how loud, for the one word |
| `⟳ loop` | the word over and over, for dialling in a cut |
| `↺` | the word as it was found |
| double-click a word, or **Enter** | changes what it says |
| **Delete** | takes the word off |

Drag across several words — or `Shift`-press the far end — and they are a
**section**: `Space` says only that, the pace and the gain apply to it, **match
levels** brings its words to one loudness, and **other takes** gives every word
in it its next take.

A word nothing in the corpus says shows `×0` under the box before you finish
it, and stays on the line if you let it — drawn as a hole, so the line can be
read with it in, and its panel offers the nearest words the corpus does have,
each a press away from taking its place.

**On a beat** is for `no no no no` on the beat rather than for a sentence, and
it is a switch: ticked, every word and every rest is rounded to a step and the
rows of the ruler become bars with the beats drawn on them; unticked, nothing
is. Set the **tempo** — type it, or press **Tap** in time — and the grid: how
many steps a beat and how many beats a bar. At 120 with four steps a beat, a
step is an eighth of a second, and the line under the controls says so. A word
fills its steps by being stretched when the stretch is within a quarter, and
by being cut to them when it is not.

**Where a word starts is measured, not guessed.** A transcript knows roughly
where a word is — near enough to find it, not near enough to cut on — so every
take is moved onto the transient nearest its word, quietly in the background,
and the line says `finding the beat in 6` while it is going on. The ruler, the
audition and the mix all hear the same cut.

**→ Mix** puts the line in the mix — `Ctrl+Enter` does the same — and that is
the first moment anything is: every word a clip, and every rest the same
recording carried on from where the word ended, muted, so the speaker pauses
on the screen. Untick **hold** for black instead. The mix does not follow the
line after that: change a take or a rest and press → Mix again, and the clip
that changed is the one that changes, in place, with the rest of the row
closing up; a clip you added from the Words tab keeps its place beside the
line's block. From there it is a mix like any other — trim a picture, reorder,
render — and the line stays on its tab to be said again.

The line is remembered between sessions but it is **not in the document** —
what a `.fbro` holds is the mix. **Clear** on the tab empties the line and
takes its clips out of the mix; **Clear** on the mix empties the mix and leaves
the line.

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
| `←` `→` | one frame; with `Shift`, one second — on the Line tab, the previous / next word, and with `Shift` a section |
| `+` `-` | zoom the mix in, out |
| `0` | fit the whole mix on the screen |
| `M` | mute |
| `Delete` | remove the selected clip and close the gap — on the Line tab, the selected word or section |
| `/` | jump to the search box |
| `Esc` | close the list of what is running |
| `Ctrl+S` `Ctrl+O` `Ctrl+R` | save, open, render |

On the Line tab, with nothing being typed into:

| | |
|---|---|
| `Space` | say the line, or the section / stop |
| `L` | loop it |
| `[` `]` | previous / next take of the selected word |
| `,` `.` | the selected word 5 ms earlier / later; 25 ms with `Shift` |
| `Enter` | back to the box; `Ctrl+Enter` puts the line in the mix |
| `Esc` | nothing selected |

## Getting a corpus in a batch

The Recordings tab above is the way in when you want *this* broadcast now. For
five of them overnight there is [`tools/supercut.js`](../../tools/README.md),
which reads and writes the same store:

```
ffmpeg-bro-headless ui/ tools/supercut.js -- pull turk --last 5
ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe turk --last 5
```

`adopt` is the folder half of the same thing, and the verb to reach for when the
folder is large:

```
ffmpeg-bro-headless ui/ tools/supercut.js -- adopt D:/footage/interviews
ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe interviews
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
