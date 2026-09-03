[← The manual](README.md)

# Finding the material

`/` opens the finder over the Compose stage. It searches the words of every
recording in a corpus and hands back moments you can play and put on the
timeline.

**There is a whole application built around this**, and it is usually the one to
reach for: [supercut](supercut.md) is a second window whose entire left-hand side
is this search, with a row of cards along the bottom instead of a timeline. Use
the panel when you want one found moment *inside* a larger edit; use that when
finding is the job. They are two views of one library, so they cannot disagree
about what was said or where.

**It is there only when a corpus is.** A corpus is a channel's broadcasts pulled
onto this machine and transcribed, and there are two ways to make one — the
Recordings tab of [the supercut application](supercut.md), or
[`tools/supercut.js`](../../tools/README.md) for a batch:

```
ffmpeg-bro-headless ui/ tools/supercut.js -- build turk
```

Neither is *this* application: the workbench searches a corpus and does not make
one. Without the manifest there is no panel and `/` does nothing, which is the
ordinary state here and not a fault.

## Why it is not on the spine

The spine is ffmpeg's pipeline — Capture → Sources → Compose → Graph → Encode →
Write — and its value is that it stays exactly that. Finding is not one of
ffmpeg's stages, so a seventh button would turn the spine from a picture of
ffmpeg into a picture of this application's menus. The finder opens over the
edit instead, the way the crop handles and the cue layer do, and the timeline it
feeds stays visible behind it.

## Words

Type a phrase. Every place it is said comes back in one list across every
recording, newest first.

**The match is over the letters, not over the words**, because an ASR does not
put the spaces where you would: across five hours it will write `you cross`,
`youcross` and `Ucross` for three utterances a person would call the same, and
comparing word by word finds only the first. Losing a hit is the failure that
matters here — a missed instance is invisible, because nothing in the result says
it should have been there.

- A match must begin where a word begins and end where a word ends, so
  `you cross` is not found inside `you crossing`. **inside longer words** turns
  that off, which is how `cross` also catches `crossed` and `crossing`.
- `you cross|ucross` is one search for either. Names are the sharp case: a
  regular called **ucross** is written `you cross` by the model every time,
  because that is what it sounds like, and no amount of fuzzy matching would
  have guessed it. Stating the variants is honest where guessing at them is not.

- Two hits less than two seconds apart are **one** moment. A phrase said three
  times for emphasis is one thing that happened, and listing it three times means
  cutting three clips out of the same breath.

**The list fills in while you type.** A thin bar under the note is on while the
search is still walking the corpus, and the note says which recording it has
reached and how many hits it has so far. On a hundred hours the whole walk is
about ten seconds the first time — the transcripts are being read — and a
fraction of a second after that. Results above the bar are real; results are only
ever missing from the *end* of the list, so a hit that is already showing is not
going to move. If a phrase seems to find nothing, check whether the bar is still
on before believing it.

This is the same search `tools/supercut.js` cuts clips with — one
implementation, so the list on the screen and the files on disk can never
describe different sets of moments. That is not a theoretical worry: when the
collapsing rule above lived only in the tool, the panel found fifteen of a phrase
the command line found fourteen of, on the same corpus, with nothing anywhere
saying which was right.

## Talking

The other question, and the one there is no phrase to ask. Six hours of somebody
talking has stretches in it worth cutting up, and you cannot search for them by
content because you do not know what is in them yet.

So a stretch is defined by its **gaps**: a run of words in which no two
neighbours are further apart than **pause under**, lasting at least the second
number. Nothing classifies anything — it is a measurement, and it is named after
the measurement. Whether a run is a story or a rant is for you to decide by
playing it, which is what the list is for.

Widening the pause welds separate thoughts into one run; narrowing it cuts a run
at every hesitation. The right value is a property of how somebody talks, which
is why it is a control and not a constant. Runs are listed longest first — with
nothing known about the content, size is the only ranking there is.

## Playing and adding

**▶** plays the moment in the panel's own player. There is one player and every
row shares it: a list of two hundred hits with a player each would be two hundred
decoders open on six-hour files, which is the cost
[residency](playback.md) exists to refuse.

**Add** puts the moment on the timeline, after everything already there — so a
list auditioned top to bottom becomes a mix in that order. A word is taken with
1.5 s either side, the same padding the command-line `clips` cuts with, because a
word with nothing before it arrives already half said. A stretch of talking is
taken as it is; its edges are silences by construction.

Adding several moments from one recording opens that recording **once**. The
file becomes an input like any other, and everything on the
[timeline](timeline.md) — ripple, slip, rate, split — then applies to what the
finder put there.

A recording whose media has been deleted to reclaim the disk still has its words,
so its hits still appear and count. **▶** and **Add** are refused on those rows
rather than the rows being left out, which would make the count disagree with the
list.
