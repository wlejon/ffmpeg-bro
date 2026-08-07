[← The manual](README.md)

# Subtitles

There are three things people mean by subtitles, and they are three different
mechanisms:

| | |
|---|---|
| **A track beside the picture** | a stream in the output, which a player can turn off — a row on the Write stage |
| **Burned into the image** | a `subtitles` filter on the Graph stage, like every other filter |
| **A file on its own** | a render whose only stream is subtitles: extracting one, or converting the format |

Any of the three can read a file you added — and the first can also read cues
this document *holds*, which is [Cues of your own](#cues-of-your-own). The
first is also on the monitor, as the cues it is and not as a look nobody can
promise: [A soft track on the monitor](#a-soft-track-on-the-monitor-as-the-cues-it-is).

The second is libass drawing characters, so it is for text tracks. A track of
*pictures* — `dvdsub`, `hdmv_pgs_subtitle` — is drawn the other way, by wiring
its own pad into an `overlay`: [Drawing them, when they are
pictures](#drawing-them-when-they-are-pictures).

## A file of cues is an `-i`

Add an `.srt`, a `.vtt` or an `.ass` on the Sources stage and it is an input
like any other: the demuxer can be forced, `-ss` shifts every cue, the
command bar prints all of it in front of the same `-i`. What it is not is a
clip — there is no picture to lay out and no sound to mix — so nothing
appears on the timeline and the panel says so rather than offering `Use on
the timeline`.

Which it is, is read off **what libavformat found in the file** rather than
off the extension: an input whose every stream is subtitles is a subtitle
file.

A card that nothing is cut from stops calling itself unused the moment a
stream row is written from it or a `subtitles=` node reads it.

## A track beside the picture

`+ Subtitle` on the Write stage adds a row that says which track it reads and
what it comes out as. **Carrying and converting are one control**, because
they are one decision:

| | |
|---|---|
| **carry** | `-c:s copy` — the packets that are already there, instant and lossless, and only possible where the output container holds the codec the input has |
| **convert** | `-c:s mov_text` — decoded and written again in whatever the container does hold |

A new row answers that question by asking the muxer, not by preferring one:
an `.ass` track going into Matroska is carried, and the same track going into
an mp4 is converted, because mp4 holds exactly one subtitle codec and it is
`mov_text`. The codec menu is the same query, so a row cannot offer something
the muxer will refuse.

Where `+ Subtitle` is not offered, the reason is written in its place — a
container that holds none, or no subtitle file open yet.

**Pictures of text cannot be converted.** `dvdsub` and `hdmv_pgs_subtitle`
carry bitmaps rather than characters, and turning one into `subrip` is
optical character recognition, which neither this nor ffmpeg does. Such a
track can be carried into a container that holds it; asking for it as text is
refused by name, and so is asking for it burned in, because libass reads
characters. What it *can* be is [drawn](#drawing-them-when-they-are-pictures).

**The window is two numbers, and the two ways of reading cut differently out
of them.** `From` and `To` are seconds into the file. A track of cues shows
them drawn as a list under the fields, each written as the span it is on
screen for — dimmed outside the window, the one the output's clock starts on
picked out, clicking any of them opens the window there.

The two rules the list is drawn against are not the same rule:

| | |
|---|---|
| **convert** | a cue is kept by where it **begins**, so one that was on screen at the in-point but started before it is dropped. `From` is the output's zero, exactly |
| **carry** | packets, from a backward seek: the copy begins on the cue at or before `From` — still on screen at that moment or long finished — and **that cue's** stamp is the output's zero |

So the row says which of the two it is doing —

> the cue at 4.00 s is on screen there, so a copy asked for 4.50 s begins on it
> — and that cue, not 4.50 s, is where the output's clock starts

with `Snap to 4.00 s` beside it, or `Start at 4.00 s` on a conversion.

Two things the list states rather than tidies away: an mp4 writes an empty
sample between one cue and the next, so some entries in a `mov_text` track
are the gaps rather than the lines; and a track long enough to be worth
cutting has more cues than a panel can show, so sixteen are drawn — the ones
the window's two ends fall among — with the count saying how many there are
in total.

### What each cue says

Beside each of those times is the line itself, because the question at an
in-point is not "is there a cue at 4.5 s" but "which line am I cutting into
the middle of". Reading the words costs a decoder per track: one is opened
when the panel asks, closed again before the answer comes back, and the
answers are kept for as long as the Write stage is up.

A cue is written on its line as far as it fits, with the whole of it in the
tooltip; a two-line cue reads as two, because a line break in the file is a
break the author asked for. What comes back is the *words* and not the
dialogue line they arrive in — the override codes an ASS line carries
(`{\i1}`, `{\pos(120,400)}`) are instructions to a renderer, and a column of
them where the line should be would be worse than a column of nothing.

**A `dvdsub` track has no words, and the panel says which codec that is.** A
bitmap cue is a picture of characters; there is nothing to read out of one,
so the reason stands where the words would have been and the times are still
drawn and still snap.

## Cues of your own

A subtitle row's third answer is **edit** — the cues this document holds,
rather than a file's. `+ Subtitle` with no subtitle file open makes one
straight away and points the row at it; with one open, the menu has `type
them here — a new track of your own` at the bottom of the same list the
carry and convert entries are in.

They are typed and retimed on the [Cues lane](timeline.md#the-cues-lane),
under the waveform, which is where a subtitle's timing is judged — by
listening to where the line is spoken.

### Taking a file's cues, which is a fork

`Edit these cues`, on a subtitle row's **Cues** tab, copies that track's cues
into the document. From that press onwards **the document is what renders
and the file is not read by this row**: the row is repointed in place, so
there is never a state where both copies reach the output without somebody
having added a second row for the second one. The tab says which file the
cues came out of and that it has stopped being read.

**The file itself is never written to.** Not on save, not on render, not
ever. The cues are undoable with `Ctrl`+`Z` and travel inside a `.fbro`.

A track of **pictures** cannot be taken this way, and the press is replaced
by the reason: `dvdsub` and `hdmv_pgs_subtitle` are pictures of characters,
and reading the words out of one is optical character recognition. Such a
track can still be [drawn](#drawing-them-when-they-are-pictures).

### What a fork costs, and it is the one thing here that can lose work

A forked cue arrives carrying its style, layer, margins and override codes —
`{\i1}`, `{\pos(120,400)}` — inside its text, and a cue **nobody retypes is
written back exactly as it was**.

Retyping a cue's words replaces that one text field, so:

| | |
|---|---|
| **kept** | its style, its layer, its margins, its effect — and every other cue's everything |
| **lost** | that cue's own override codes |

This is said on the row's Cues tab, with a count of how many still carry any,
and the count goes down as they do. There is no style editor here and there
is not going to be one: a cue is text, a start and an end.

### The render writes a file, and the printed command names it

**ffmpeg has no way to receive cues except as a file.** There is no `-cue`
option and no filter that makes text out of nothing, so a render materialises
the track into a real subtitle file and passes it as an ordinary `-i`. The
command bar's notes say so, because the `-i` looks like a file you added and
is not.

It is written **beside the output**, named from the output's name and the
track's id — `programme.sub1.ass` — so rendering twice overwrites one file
instead of leaving a trail. A destination that is a URL or a `tee` list goes
to the temp directory instead.

The times in it are already the **output's**, with anything outside the
render range dropped and a cue straddling the start clamped — which is why
there is no `-ss` in front of that `-i`. Two [versions](output.md) of a
render share the one file, since cues do not change with the size.

Which format is decided by what the track holds:

| | |
|---|---|
| **`.ass`** | a track forked from a file, because its cues are already ASS |
| **`.srt`** | a track typed here, because it is words and times and nothing else |

What the **stream in the output** comes out as is a different question with
its own answer — the muxer's: `.ass` into an mp4 is `mov_text` and into
Matroska is `ass`.

`-itsoffset` is untouched by any of this and is still the right tool for a
*file* that is uniformly out — it shifts a whole track on the input.

## Burning them in

Two buttons, because there are two clocks a set of cues can be on and they
are not interchangeable.

`Burn it into the picture` on a subtitle input places a `subtitles` filter at
the point where the whole canvas is, and takes you to the Graph stage where
the node now is. That is the right point for cues written against the
**finished programme** — where 00:01:30 means a minute and a half into what
will be written.

**Burn in**, on a clip's properties panel, places the same filter early in
that clip's own chain, on the file's own clock rather than the edit's. That
is the right point for a track that belongs to the *file*: the subtitle
stream inside a recording, or an `.srt` downloaded to go with it, where
00:01:30 means a minute and a half into that shot however it was later
trimmed and dragged. It lists every subtitle track the clip's input carries
and every file of cues that is open, and it does not take you anywhere,
because the point of it is that the picture in front of you changes.

**What either button places is an ordinary node** — it can be moved,
configured and deleted on the Graph stage like any other, and it is printed
by the command bar.

Burned-in subtitles *are* visible in this application. On one clip they are
in the program monitor, because a clip's playback chain is a filtergraph and
this is a filter in it — see [A filter in the viewer](graph.md#a-filter-in-the-viewer).
Over the whole canvas they are in a node preview and in the export preview,
which are real renders; playing the node is how you watch them come and go.

A track that is **pictures of characters** — `dvdsub`, `hdmv_pgs_subtitle` —
cannot be burned in at all: libass reads characters. Where `Burn in` would
be, such a track gets `Draw cues` instead, which is the section below.

## Drawing them, when they are pictures

A bitmap cue cannot become text — that is optical character recognition,
which neither this nor ffmpeg does — and cannot go through libass. What it
*can* be is drawn, because the cues are pictures and `overlay` draws
pictures.

So an input whose subtitle track is bitmaps grows a third socket on the Graph
stage — **cues**, in orange, beside its picture and its sound — and a wire
from it into an `overlay`'s second input is the whole of it. `Draw cues` on a
clip's properties panel is that in one press: it places the input as a node
of the graph, an `overlay` on the clip's own chain, and the wire between
them. The three are ordinary nodes, movable, configurable and deletable on
the Graph stage like anything else.

Three consequences worth knowing:

- **A cue appears and disappears at its own times**, exactly as a text track
  would, with nothing drawn in the gap between two cues.
- **The canvas is the file's, not the render's.** A rect at (160, 270) means
  the lower third of the picture it was authored for; the size comes from the
  subtitle codec's own dimensions, or the largest video stream of the same
  input, or 720×576. Using the output size instead would move every cue on
  any render at a different size.
- **The viewer cannot show it, and `O` can.** An `overlay` of two inputs is
  not one chain over one clip, which is all playback runs. The program
  monitor playing [the output itself](playback.md#the-output-instead-of-the-clips)
  is a real render and has them in it.

`Draw cues` opens the file a **second time** — one `-i` for the clip's
picture and one for its cues — which the printed command shows and which
costs a demuxer, not a second decode of the picture.

One thing this cannot be: a text track on that pad. It is refused when the
input is opened, naming the filter that does draw one — ffmpeg's own
mechanism for a text track warns once per cue and paints nothing, which is a
render that succeeds and has no subtitles in it.

One thing is escaped on your behalf and shown so that it is not a mystery: **a
filtergraph separates a filter's arguments with `:`**, so a Windows path with
a drive letter in it goes into `subtitles=` unusable unless escaped. The path
is written `subtitles=filename='D\:/media/cues.srt'`, quoted as well because a
filename may contain a comma.

## Out on its own

A render whose only stream is a subtitle track has no canvas, no mix, no
encoder and no frame clock — the cues drive it. That is what extracting a
track is, and it is also what converting one is: `.srt` in, `.vtt` out, with
`-f webvtt` and a filename that ends in `.vtt`. SubRip, WebVTT and ASS are
all muxers this build links, and the picker shows them among the others.

## A soft track on the monitor, as the cues it is

**`Cues` on the program monitor (`T`) draws the output's soft subtitle tracks
over the picture — the words, plainly, and never an imitation of how they
will look.** It is not a decode path and not the burn-in filter: it is this
application reading the cues it is about to write and putting them on the
screen at the moment they are on screen.

**What it claims is exactly the cues, and the interface says so while it is
on.** A soft track is styled by whatever player opens the file — the font,
the size, the position, the outline and the margin are that player's, and
this application cannot know which player. So it shows unstyled text at the
bottom of the canvas, with a line above it saying that this is what the cues
*say* and not how they will *look*.

**It turns off, and that is the feature rather than a convenience.** A soft
track is precisely the thing a player can switch off, so an overlay that
switches off is a faithful preview of one.

**All three ways a row reads its cues are drawn.** A row reads the document's
own track, carries a file's packets, or converts them. The first is already
in timeline seconds; the other two are mapped the same way [A track beside
the picture](#a-track-beside-the-picture) states it — a conversion's zero is
the in-point exactly, a copy's is the stamp of the cue it begins on. Cues
outside the render's range are not drawn, for the same reason they are not
written.

**A cue that is a picture gets a line saying so, not a picture.** `dvdsub`
and `hdmv_pgs_subtitle` carry bitmaps of characters; there is nothing in one
to draw as text, though the overlay still says when one is on screen. Drawing
the actual rects is in [Not yet](not-yet.md).

**The other thing the viewer shows is a track burned into a clip**, and it is
a different statement about the finished file. That is a `subtitles` filter
on the clip's own chain, so the program monitor shows exactly what will be in
the picture — position, font and line breaking included. Neither is offered
as a fix for the other: burning cues into the picture and writing them
beside it are two different files, and the one you meant is not something
this can infer.

## A font travelling with the text

An ASS track names its fonts by name — `Style: Default,Arial,48,…` — and
carries none of them, so a player without that font substitutes one and every
line, break and position moves with it. Embedding the font is what `-attach`
is for, as an **attachment stream** on the Write stage; Matroska holds them.
An ASS row with no attachment beside it says so.
