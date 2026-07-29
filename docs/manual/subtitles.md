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
Which family a codec is in is libavcodec's own `AV_CODEC_PROP_TEXT_SUB`, and
`probe()` reports it per track as `textSub`.

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
cannot be burned in at all, and the button says so rather than failing at
parse: libavfilter's subtitles filter is libass, and libass reads characters.
Such a track can still be carried as a stream into a container that holds it.

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
