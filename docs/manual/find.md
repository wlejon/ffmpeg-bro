# Find

Between having a file and having an edit there is a question neither stage
answers: **what is in this recording, and which of it do I want?** For a
half-hour clip you answer it by watching. For a six-hour stream you do not
answer it at all — nobody scrubs six hours — and that is the gap this stage
fills.

The Find stage is a canvas of **rules**. You wire a recording into a rule, the
rule finds every place something happened, and what comes out is a **stack**: an
ordered list of spans of that recording, each carrying the reason it is there.
Stacks go into other rules — shaped, filtered, reordered, woven together — and
the end of a chain is a stack you send to the timeline in one press.

It sits after Sources and before Compose:

```
Capture → Sources → Find → Compose → Graph → Encode → Write
```

## Why it is a second graph and not the Graph stage

The Graph stage holds ffmpeg's filter graph, and every node in it prints into a
render. A rule that says *every time he said "insane"* has no printout at all —
its value is a list of clips, not a stream of frames — so this is a separate
canvas with the same idiom: cards, sockets, wires, drag to connect, a panel for
the selected node. What differs is what a wire carries:

| Wire | Carries |
|---|---|
| violet | a **recording** — an input, on its way into a finder |
| amber | a **stack** — an ordered list of candidates |

A wire that would join the wrong two is refused when you drop it.

## A candidate is not a cut

Everything on a stack is a **candidate**: a span of a recording, with the reason
it is there. It is deliberately not a clip until you say so.

A transcript is read from whichever soundtrack was cheapest — for a linked
recording that is usually the audio-only rendition — and the picture rendition
does not share its zero: the two can drift apart by a few seconds, in a step
rather than a smooth drift, wherever the source has a discontinuity such as an
ad break. A span cut exactly to the word boundary would sometimes not contain
the word.

So a candidate off a word search carries **ten seconds either side** by
default. You can lower it; the rule says what that costs when you do. What
lands on the timeline contains the moment rather than cutting at it, and the
trim is yours.

## The rules

### From

**Recording** — an input, chosen from what is open on
[Sources](sources.md). Every chain starts with one.

### Find

These are the only two rules that read a soundtrack, and **neither of them ever
starts a read**. Transcribing and listening for sounds are both asked for on
Sources, deliberately, because nothing should spend that time without being
asked. A finder over a recording nobody has listened to answers with an empty
stack and says which press is missing.

**Said** — every place a phrase was said, out of the transcript. This is the
whole of the word search: `Search these words…` on the Sources `Words` row
walks here with a `Recording`, a `Said` and a `Stack` already placed and wired
to that recording, so the phrase is the only thing left to type.

- *Words* — what to look for. Case and punctuation are ignored; spaces are not,
  so a phrase search works.
- *Either side* — the pad, ten seconds by default. See above.
- *Whole words only* — off by default. `insane` finding `insanely` is usually
  right and sometimes exactly wrong, and only you know which.

The rule says how much of the recording has been read, always. A search that
found nothing over the first ten minutes of six hours and a search that found
nothing over all of it are completely different answers.

**Sound** — every run the acoustic sensors marked, out of a
[Find sounds](sources.md#finding-things-by-sound) pass.

- *Kind* — `sound`, `tonal` or `onset`. The three are named after what was
  **measured** and never after what made it: `sound` is a run above the measured
  noise floor, `tonal` is sustained periodicity with a real frequency in hertz,
  `onset` is a spectral-flux transient. Nothing here decided anything was a
  voice, a bird or a word.
- *At least* / *At most* — in seconds. Not offered on `onset`, which has no
  length.
- *Around* — a frequency, on a tonal run only, matched within a tenth.

A transient has no length, so a stack of onsets is a stack of *moments*. Put a
**Pad** after it to turn them into clips.

### Shape

**Pad** — widen everything by so much before and after, clamped to the
recording.

**Merge** — fold candidates that touch into one, within a tolerance. A word
said three times in one breath, padded ten seconds each, is three overlapping
spans of one moment — cut, that is the same clip three times. The survivor says
how many went into it.

**Length** — drop what is too short or too long.

**Order** — `found` (the order the recording said them, and the only one that is
not a rearrangement), `longest`, `shortest`, `scattered`. A shuffle is
**seeded**: the same document opens as the same montage, and pressing the die is
what changes it.

**Some of** — a run of the stack, counted in items. This is what lets a rule
apply to part of a stack: *the monologues go in the second half* is **Some of**
feeding **Every**.

### Arrange

**Mix** — take so many of the first, then so many of the second, over and over.
*For every one use of this word, three of that* is `1 : 3`.

**Every** — put one of the second after every *n*th of the first.

The two are not the same operation. **Mix** weaves two streams symmetrically.
**Every** treats the first as a *spine* and places the second into it, so
running out of what is being placed leaves the rest of the spine continuous.

Both run until **both** sides are empty, so the tail of the longer is never
silently dropped once the shorter side runs out — the card says how many
rounds the ratio actually held for.

### Keep

**Stack** — the end of a chain. Give it a name, see what is in it, and send it.

## Sending a stack

One press. The clips land **end to end on one track**, in the stack's order,
after whatever is already there — appended rather than replacing, so sending a
second stack is how a montage is built out of several rules.

Each clip is named with the reason it is here — `1:04:12 "oh yeah that's the"` —
rather than with the file it came from.

A candidate whose recording has been removed since the rule ran is counted and
said out loud rather than dropped in silence.

Each candidate in the panel's preview list carries its own timestamp as a press:
it moves the playhead to that moment through whichever clip covers it, and
nothing is cut. A recording with nothing of it on the timeline yet says so rather
than laying five hours of stream down as a side effect of a click.

### Pulling the windows

For a stack whose recording is a **link**, a second press: `Pull N windows`.

This is what the word search is *for*. A six-hour VOD is tens of gigabytes and
the twenty seconds each candidate covers is a few megabytes, so this copies only
those spans — stream copies, so they run in the background, take none of the
one render slot, and jump ahead of any whole-recording copy already queued.

The span pulled is **the candidate's own**, pad and all — the `Either side`
field on the `Said` rule is where that number is decided, and it is not
re-padded here.

At most 24 at a time, and it says so. Press again for the next batch — a window
already pulled costs nothing to ask for twice.

When they land, `Open N here` opens them as inputs of their own on
[Sources](sources.md) — new ones, not the recording repointed, because each is a
different file with its own zero. `Use on the timeline` is still the press that
puts one in the edit.

A recording already on this machine is offered no windows to pull. There is
nothing to fetch.

## What is saved and what is not

**The rules are in the document.** They are authored work — *every time he said
this, and one long run of talking for every three of them* is an editorial
decision — so they are in a `.fbro`, on the undo track, and in the unsaved
marker.

**What they found is not.** A stack comes back from the rules the way a waveform
comes back from a file. Neither are transcripts, marks or waveforms in any
document, workspace or undo step, for the same reason.

A rule pointing at an input that has been removed on Sources keeps its settings
and its wires and simply has no recording; it is not deleted. A phrase you typed
and wired into five other nodes is work, and losing it because a file was closed
on another stage would be the wrong trade.

## On the canvas

| | |
|---|---|
| Drag a card's header | move it; it stays where you put it |
| Drag a socket | draw a wire, from either end |
| Drag out of a filled input | pick that wire up rather than making a second |
| Click a wire | cut it |
| Drag the background | pan |
| Wheel | zoom about the pointer |
| `A` | open the Add menu |
| **Add rule** | place one, then wire it |
| **Re-layout** | give every card back to the automatic layout |

A socket takes one wire. Dropping a second on it replaces the first, because
every rule reads exactly one list per socket.

## Not yet

- **Nothing sees the picture.** Every rule here reads a soundtrack. Finding
  where something *appeared* is not here.
- **A stack goes to one track.** Sending two stacks to two tracks to be
  composited is two presses and a drag, not a wire.
- **No rule reads the timeline.** Rules find material in recordings; they cannot
  yet be about what is already cut.
