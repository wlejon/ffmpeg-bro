[← The manual](README.md)

# Subtitles

There are three things people mean by subtitles, they are three different
mechanisms in ffmpeg, and each of them lives where its decision is taken. Doing
that badly is the ordinary way an application ends up with a "Subtitles" panel
that quietly does one of the three.

| | |
|---|---|
| **A track beside the picture** | a stream in the output, which a player can turn off — a row on the Write stage |
| **Burned into the image** | a `subtitles` filter on the Graph stage, like every other filter |
| **A file on its own** | a render whose only stream is subtitles: extracting one, and converting the format |

Any of the three can read a file you added — and the first can also read cues
this document *holds*, which is [Cues of your own](#cues-of-your-own).

The second of those is libass drawing characters, so it is for text tracks. A
track of *pictures* — `dvdsub`, `hdmv_pgs_subtitle` — is drawn the other way, by
wiring its own pad into an `overlay`: [Drawing them, when they are
pictures](#drawing-them-when-they-are-pictures).

## A file of cues is an `-i`

Add an `.srt`, a `.vtt` or an `.ass` on the Sources stage and it is an input
like any other: the demuxer can be forced, `-ss` shifts every cue, the command
bar prints all of it in front of the same `-i`. What it is not is a clip —
there is no picture to lay out and no sound to mix — so nothing appears on the
timeline and the panel says so rather than offering `Use on the timeline`.

Which it is, is read off **what libavformat found in the file** rather than off
the extension: an input whose every stream is subtitles is a subtitle file.

A card that nothing is cut from stops calling itself unused the moment a stream
row is written from it or a `subtitles=` node reads it. Both are ways an input
is used without a clip existing, and "unused" beside a file the render is about
to open is the one thing the Sources stage cannot afford to get wrong.

## A track beside the picture

`+ Subtitle` on the Write stage adds a row that says which track it reads and
what it comes out as. **Carrying and converting are one control**, because they
are one decision with one question behind it:

| | |
|---|---|
| **carry** | `-c:s copy` — the packets that are already there, instant and lossless, and only possible where the output container holds the codec the input has |
| **convert** | `-c:s mov_text` — decoded and written again in whatever the container does hold |

A new row answers that question by asking `avformat_query_codec`, not by
preferring one: an `.ass` track going into Matroska is carried, and the same
track going into an mp4 is converted, because mp4 holds exactly one subtitle
codec and it is `mov_text`. The codec menu is the same query, so a row cannot
offer something the muxer will refuse at `write_header`.

Where `+ Subtitle` is not offered, the reason is written in its place — a
container that holds none, or no subtitle file open yet. A stage with no button
on it reads as an application that cannot write subtitles at all.

**Pictures of text cannot be converted.** `dvdsub` and `hdmv_pgs_subtitle`
carry bitmaps rather than characters, and turning one of those into `subrip`
is optical character recognition, which neither this nor ffmpeg does. Such a
track can be carried into a container that holds it; asking for it as text is
refused by name, before anything opens, and so is asking for it burned in,
because libavfilter's subtitles filter is libass and libass reads characters.
What it *can* be is [drawn](#drawing-them-when-they-are-pictures), which is
neither of those two things and is a wire on the Graph stage. Which family a
codec is in is libavcodec's own `AV_CODEC_PROP_TEXT_SUB`, and `probe()` reports
it per track as `textSub`.

**The window is two numbers, and the two ways of reading cut differently out of
them.** `From` and `To` are seconds into the file, the same pair a copied
picture has — and where a picture has keyframes, a track of cues has the cues
themselves, drawn as a list under the fields with each one written as the span
it is on screen for. Dimmed is outside the window; the one the output's clock
starts on is picked out; clicking any of them opens the window there.

The two rules the list is drawn against are not the same rule:

| | |
|---|---|
| **convert** | a cue is kept by where it **begins**, so one that was on screen at the in-point but started before it is dropped. `From` is the output's zero, exactly |
| **carry** | packets, from a backward seek: the copy begins on the cue at or before `From` — still on screen at that moment or long finished — and **that cue's** stamp is the output's zero |

Which is the keyframe story in subtitle vocabulary, and it is why this used to
say a subtitle window can begin anywhere. It can, if the row converts. Set a
copied row's `From` to 4.5 s over cues at 1–2, 4–5.5 and 7–8 and the file that
comes out has two cues in it, the first at zero, because 4 s is where the
packets start; the same two numbers through a conversion write one cue and zero
the file half a second later. So the row says which of the two it is doing —

> the cue at 4.00 s is on screen there, so a copy asked for 4.50 s begins on it
> — and that cue, not 4.50 s, is where the output's clock starts

with `Snap to 4.00 s` beside it, or `Start at 4.00 s` on a conversion, where
the same press means "take that cue back in" rather than "say what will happen
anyway".

Where the cues are is read off the **packets** — `bro.ffmpeg.cueTimes`, which
never opens a decoder — so the list is drawn for a `dvdsub` track exactly as it
is for an `.srt`. When a picture of text is on screen is the one thing anybody
can say about one. Two things the list states rather than tidies away: an mp4
writes an empty sample between one cue and the next, so some entries in a
`mov_text` track are the gaps rather than the lines; and a track long enough to
be worth cutting has more cues than a panel can show, so sixteen are drawn —
the ones the window's two ends fall among — with the count saying how many
there are in total.

### What each cue says

Beside each of those times is the line itself, because the question a person
actually has at an in-point is not "is there a cue at 4.5 s" but "which line am
I cutting into the middle of". It is a **second query** —
`bro.ffmpeg.cueText` — and a second cost: the words are inside a cue's payload,
so reading them is a decoder per track. One is opened when the panel asks,
closed again before the answer comes back, and the answers are kept for as long
as the Write stage is up and dropped when you leave it. Nothing here holds a
subtitle decoder open, and probing a file does not open one at all.

A cue is written on its line as far as it fits, with the whole of it in the
tooltip; a two-line cue reads as two, because `\N` in an ASS line is a break the
author asked for. What comes back is the *words* and not the dialogue line they
arrive in: every text decoder in libavcodec hands over ASS, so the eight leading
fields come off and the override codes — `{\i1}`, `{\pos(120,400)}` — come out.
They are instructions to a renderer, and a column of them where the line should
be would be worse than a column of nothing.

**A `dvdsub` track has no words, and the panel says which codec that is.** A
bitmap cue is a picture of characters; there is nothing to read out of one, so
the reason stands where the words would have been and the times are still drawn
and still snap. That is `AV_CODEC_PROP_TEXT_SUB` again — the same property that
decides whether the track can be converted or burned in — asked before any
decoder is opened, so a picture track costs nothing to ask about.

## Cues of your own

A subtitle row's third answer is **edit** — the cues this document holds, rather
than a file's. `+ Subtitle` with no subtitle file open makes one straight away
and points the row at it; with one open, the menu has `type them here — a new
track of your own` at the bottom of the same list the carry and convert entries
are in, because "where do this row's cues come from" is one question.

They are typed and retimed on the [Cues lane](timeline.md#the-cues-lane), under
the waveform, which is where a subtitle's timing is judged — by listening to
where the line is spoken.

### Taking a file's cues, which is a fork

`Edit these cues`, in a subtitle row's fold, copies that track's cues into the
document. From that press onwards **the document is what renders and the file is
not read by this row**: the row is repointed in place, so there is never a state
where both copies reach the output without somebody having added a second row
for the second one. The fold says which file the cues came out of and that it
has stopped being read.

**The file itself is never written to.** Not on save, not on render, not ever.
An editor that rewrites its input is one that loses work, and here the inputs are
read and the document is the edit — which is also why the cues are undoable with
`Ctrl`+`Z` and travel inside a `.fbro`.

A track of **pictures** cannot be taken this way, and the press is replaced by
the reason: `dvdsub` and `hdmv_pgs_subtitle` are pictures of characters, and
reading the words out of one is optical character recognition. It is the same
refusal, off the same `AV_CODEC_PROP_TEXT_SUB`, that stops such a track being
converted or burned in — and such a track can still be
[drawn](#drawing-them-when-they-are-pictures).

### What a fork costs, and it is the one thing here that can lose work

Every text decoder in libavcodec hands over ASS, so a cue arrives as a dialogue
line with its layer, its style, its three margins and its override codes —
`{\i1}`, `{\pos(120,400)}` — inside it. All of that is kept, and a cue **nobody
retypes is written back exactly as it was**, under the file's own `[V4+ Styles]`.

Retyping a cue's words replaces that one text field, so:

| | |
|---|---|
| **kept** | its style, its layer, its margins, its effect — and every other cue's everything |
| **lost** | that cue's own override codes |

Which is said in the fold, with a count of how many cues still carry any, and
the count goes down as they do. Reassembling `{\k40}`-style codes around retyped
words would mean guessing which syllable each belongs to, and a karaoke line put
back together by guesswork is worse than one plainly reset.

There is no style editor here and there is not going to be one. A cue is text, a
start and an end; writing an override from a control would be a second opinion
about what it means, and libass already has the only one that matters.

### The render writes a file, and the printed command names it

**ffmpeg has no way to receive cues except as a file.** There is no `-cue`
option and no filter that makes text out of nothing — a subtitle stream in an
output comes from a subtitle stream in an input. So a render materialises the
track into a real subtitle file and passes it as an ordinary `-i`. That is not a
compromise, it is the only exact answer, and it is what keeps the command bar
honest: everything past the compositor is exact, and a command naming a file this
application actually wrote is exact. The bar says so in its notes, because the
`-i` looks like a file you added and is not.

It goes **beside the output**, named from the output's name and the track's id —
`programme.sub1.ass` — rather than into a temp directory, because somebody who
pastes the command a day later needs the file to be there. The id is what makes
the name stable, so rendering twice overwrites one file instead of leaving a
trail; a destination that is a URL or a `tee` list has nothing to sit beside, and
those go to the temp directory.

The times in it are already the **output's**, with anything outside the render
range dropped and a cue straddling the start clamped — which is why there is no
`-ss` in front of that `-i`. Two [versions](output.md) share the one file: a
version is another output at another size, and cues do not change with the size.

Which format is decided by what the track holds:

| | |
|---|---|
| **`.ass`** | a track forked from a file, because its cues are already ASS and nothing else can carry them back out |
| **`.srt`** | a track typed here, because it is words and times and nothing else, and a script header would be claiming a look nobody chose |

What the **stream in the output** comes out as is a different question with the
answer it always had — the muxer's, through `avformat_query_codec`, so `.ass`
into an mp4 is `mov_text` and into Matroska is `ass`.

`-itsoffset` is untouched by any of this and is still exactly the right tool for
a *file* that is uniformly out: it shifts a whole track on the input, which is
one number rather than a hundred edits.

## Burning them in

Two buttons, because there are two clocks a set of cues can be on and they are
not interchangeable.

`Burn it into the picture` on a subtitle input places a `subtitles` filter at
the point where the whole canvas is, and takes you to the Graph stage where the
node now is. That is the right point for cues written against the **finished
programme** — where 00:01:30 means a minute and a half into what will be
written.

**Burn in**, on a clip's properties panel, places the same filter on that
clip's own chain, above the `setpts` that turns the file's clock into the
edit's. That is the right point for a track that belongs to the *file*: the
subtitle stream inside a recording, or an `.srt` downloaded to go with it,
where 00:01:30 means a minute and a half into that shot however it was later
trimmed and dragged. It lists every subtitle track the clip's input carries and
every file of cues that is open, and it does not take you anywhere, because the
point of it is that the picture in front of you changes.

Which track is `si=`, and **`si=` counts subtitle streams rather than
streams** — the second subtitle track of a file whose streams run video, audio,
subtitle, subtitle is `si=1` and never `si=3`. It is written only where it is
not the default, so what the command bar prints for the ordinary case is what
you would have typed.

**What either button places is an ordinary node** — it is printed by the command
bar, it can be moved, configured and deleted on the Graph stage, and nothing
about the render behaves differently because a button rather than the palette
put it there. A shortcut that produced something you could not then find would
be worse than no shortcut.

Burned-in subtitles *are* visible in this application. On one clip they are in
the program monitor, because a clip's playback chain is a filtergraph and this
is a filter in it — see [A filter in the viewer](graph.md#a-filter-in-the-viewer). Over
the whole canvas they are in a node preview and in the export preview, which
are real renders; playing the node is how you watch them come and go.

A track that is **pictures of characters** — `dvdsub`, `hdmv_pgs_subtitle` —
cannot be burned in at all: libavfilter's subtitles filter is libass, and libass
reads characters. Where `Burn in` would be, such a track gets `Draw cues`
instead, which is the section below.

## Drawing them, when they are pictures

A bitmap cue cannot become text (that is optical character recognition, which
neither this nor ffmpeg does) and cannot go through libass. What it *can* be is
drawn, because the cues are pictures and `overlay` draws pictures.

**The thing to know first is that libavfilter has no subtitle input.** `overlay`
cannot consume a subtitle stream and `buffer` takes video frames; there is no
third source that takes cues. When `ffmpeg -filter_complex "[0:v][0:s]overlay"`
appears to burn a DVD's subtitles in, libavfilter is not what is doing it —
ffmpeg's *CLI* carries a mechanism called sub2video which decodes the cues
itself, paints each one's palettised bitmap into an RGBA frame the size of the
picture they were authored against, and feeds those frames to an ordinary
`buffer`. This application has the same mechanism, which is why the command it
prints for a drawn cue runs and draws the same thing.

So an input whose subtitle track is bitmaps grows a third socket on the Graph
stage — **cues**, in orange, beside its picture and its sound — and a wire from
it into an `overlay`'s second input is the whole of it. `Draw cues` on a clip's
properties panel is that in one press: it places the input as a node of the
graph, an `overlay` on the clip's own chain, and the wire between them. The three
are ordinary nodes, printed by the command bar and movable, configurable and
deletable on the Graph stage like anything else.

Three consequences worth knowing:

- **A cue is two frames, and the second one matters most.** One painted when the
  cue appears and one *cleared* when it expires. Nothing is sent for the gap in
  between, because `overlay` holds the last frame of its secondary input and
  reuses it — which is also why a graph never told the cue ended would go on
  drawing it for the rest of the render.
- **The canvas is the file's, not the render's.** A rect at (160, 270) means the
  lower third of the picture it was authored for; the size comes from the
  subtitle codec's own dimensions, or the largest video stream of the same input,
  or 720×576, which is ffmpeg's own rule. Using the output size instead would
  move every cue on any render at a different size.
- **The viewer cannot show it, and `O` can.** An `overlay` of two inputs is not
  one chain over one clip, which is all playback runs; the program monitor
  playing [the output itself](playback.md#the-output-instead-of-the-clips) is a real
  render and has them in it.

`Draw cues` opens the file a **second time** — one `-i` for the clip's picture
and one for its cues — because a graph's input node is an `-i` in this model and
the clip's own node carries pads only for what the derivation reads. It is what
the printed command says and it costs a demuxer, not a second decode of the
picture.

One thing this cannot be: a text track on that pad. It is refused when the input
is opened, naming the filter that does draw one. ffmpeg's own sub2video takes a
text track, warns once per cue and paints nothing, which is a render that
succeeds and has no subtitles in it.

One thing is escaped on your behalf and shown so that it is not a mystery: **a
filtergraph separates a filter's arguments with `:`**, so a Windows path with a
drive letter in it goes into `subtitles=` unusable and libavfilter complains
about an option named after half the path without ever mentioning the colon.
The path is written `subtitles=filename='D\:/media/cues.srt'`, quoted as well
because a filename may contain a comma and a comma ends the filter.

## Out on its own

A render whose only stream is a subtitle track has no canvas, no mix, no
encoder and no frame clock — the cues drive it. That is what extracting a
track is, and it is also what converting one is: `.srt` in, `.vtt` out, with
`-f webvtt` and a filename that ends in `.vtt`. The three formats everything
converts between — SubRip, WebVTT and ASS — are all muxers this build links,
and the picker shows them among the other hundred and eighty.

## What the viewer cannot do

**A soft subtitle track is invisible in the viewer, and always will be until
playback grows a path of its own.** bro's `<video>` decodes pictures and sound,
and a track a player can switch off is neither. The track is in the file and
plays in any player; what this application can show you is the render, not the
timeline.

That is said on the Write stage, out loud, with the reason. Somebody who adds a
subtitle row, looks at the viewer, sees nothing and concludes the track was not
written is the failure this is against — and a fake overlay would be worse,
because it would then disagree with the render in every detail of position,
font and line breaking. Those details belong to the *player*, which is the
whole point of writing the track soft.

What the viewer does show is a track **burned into a clip**, because that is a
`subtitles` filter on the clip's own chain and the program monitor runs a clip's
filters. It is on the same stage as the warning, one sentence along, and it is
deliberately not offered as a fix: burning cues into the picture and writing
them beside it are two different files, and the one you meant is not something
this can infer.

## A font travelling with the text

An ASS track names its fonts by name — `Style: Default,Arial,48,…` — and
carries none of them, so a player without that font substitutes one and every
line, break and position moves with it. Embedding the font is what `-attach`
is for, it is an **attachment stream** on the Write stage, and Matroska holds
them. An ASS row with no attachment beside it says so.
