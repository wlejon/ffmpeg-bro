[← The manual](../manual/README.md)

# Use cases

Twelve people with twelve ordinary jobs, each one driven end to end by a script
that records what it cost. Not "does the application work" — the suites in
`tests/` already ask that and the answer is yes — but **could somebody have got
there, and what did they have to know first.**

Every one of these runs. Every one asserts the file that came out. The costs
below are measured by the scripts rather than argued for here, so this page
cannot drift away from the application.

```
ctest --test-dir build -C Release -R usecases        # all twelve, then the tally
ctest --test-dir build -C Release -R uc03            # one of them
```

## Who this application is for

The honest answer, and it is the thing the numbers are for.

The navigation is **ffmpeg's architecture**: inputs → streams → a filter graph →
encoders → a muxer → an output, drawn as `Capture → Sources → Compose → Graph →
Encode → Write`. That is a real and defensible choice — it is why this app can
express stream copy, per-stream mapping, two-pass, bitstream filters and 182
containers when an NLE-shaped one cannot — and it is stated as a principle in
CLAUDE.md: *put new capability where ffmpeg puts it.*

The cost of that choice is measurable, and here it is:

| | |
|---|---|
| Average job | **5.8 steps, 2.2 stages, 1.8 ffmpeg concepts, 0.9 hidden controls** |
| Jobs needing no ffmpeg vocabulary at all | **3 of 12** — trim, join, overlay |
| Most-required concept | **what a muxer is** — 6 of 12 jobs |

So: this is an application for **somebody who already knows ffmpeg's model** and
wants to see what they are doing. For that person it is very good, and several
of the journeys below say so out loud — the muxer picker searching extensions,
the container query narrowing the codec list, versions built by recursing
through the same `buildSpec()`, the three meanings of "subtitle" kept genuinely
apart.

For anybody else, the three jobs that need no ffmpeg vocabulary are the three
the timeline already covers, and every other job requires learning a piece of
ffmpeg before the control in front of you means anything.

**That is not fixed by explaining more.** The Write stage once carried eight
paragraphs against twelve controls and the fix applied to it was to fold them
behind ⓘ, which changed how much text was on screen and changed nothing about
what the person had to know. A concept that must be understood to proceed is a
concept whether it is explained on the page, behind a disclosure, or in the
manual. The work list below is about **removing the requirement**, not about
wording it better.

## What each job costs

| | job | steps | stages | ffmpeg | hidden |
|---|---|---|---|---|---|
| [UC01](uc01-trim-and-post.md) | Trim the dead air off a recording and post it | 5 | 2 | 0 | 0 |
| [UC02](uc02-small-enough-to-send.md) | Make it small enough to send | 6 | 3 | 2 | 0 |
| [UC03](uc03-lossless-cut.md) | Cut an excerpt out without re-encoding it | 7 | 2 | 4 | 2 |
| [UC04](uc04-change-the-container.md) | Change the container without touching the video | 5 | 2 | 2 | 2 |
| [UC05](uc05-one-frame-as-a-png.md) | Get one frame out as a PNG | 8 | 2 | 3 | 3 |
| [UC06](uc06-just-the-audio.md) | Get just the audio out, as an mp3 | 5 | 2 | 2 | 1 |
| [UC07](uc07-join-clips.md) | Join several clips end to end | 4 | 2 | 0 | 0 |
| [UC08](uc08-burn-in-subtitles.md) | Burn subtitles into the picture | 7 | 4 | 1 | 1 |
| [UC09](uc09-master-and-proxy.md) | A master and a small proxy out of one edit | 5 | 2 | 1 | 1 |
| [UC10](uc10-record-the-screen.md) | Record the screen to a file | 7 | 2 | 3 | 0 |
| [UC11](uc11-record-and-stream.md) | Record and stream at the same time | 5 | 1 | 3 | 1 |
| [UC12](uc12-logo-in-the-corner.md) | Put a logo in the corner | 5 | 2 | 0 | 0 |

## The three that are wrong rather than merely expensive

Most of what follows is a cost. Three findings are defects — the application
does something other than what the person asked, and says nothing.

**A trimmed clip exports with black on the front.** [UC01](uc01-trim-and-post.md).
Trimming a clip's head moves its start forward and leaves a gap at zero; the
render range is still the whole timeline, so the gap is rendered. The most
common video job there is produces a file that is the wrong length and begins
with black, and nothing between the drag and the button says so — not the
monitor, not the range strip, and not *What will be written*, which states the
length and presents it as correct. `rippleTrim` (Alt-drag) is the gesture that
does what was meant. Nothing says which drag you just performed.

**Dropping a subtitle file on the window does nothing at all.**
[UC08](uc08-burn-in-subtitles.md). No input, no clip, no refusal, no message.
The file is perfectly readable — added through the Sources path field it probes
and is recognised as subtitles from what libavformat found in it rather than
from its name. The first gesture anybody tries fails silently, which is the one
way a UI must never fail.

**Dropping several clips stacks them instead of joining them.**
[UC07](uc07-join-clips.md). Three files that are obviously one sequence land on
three tracks at time zero, all playing at once. The monitor shows the top of the
stack, so it looks exactly like one clip.

## The work list

Every shortfall the twelve journeys recorded, grouped by what would fix it.
These are ordered by how many journeys each would help.

### 1. There is no second answer to "where does the file go"

[UC10](uc10-record-the-screen.md), [UC11](uc11-record-and-stream.md). Capture
has **Save to** and **Container**; Write has **Write to** and **Format**. Same
questions, different names, different stages, nothing carried between them —
plus Capture's own video codec, audio codec, quality and *Also write*. The one
thing the two stages do share is the tee destination editor, which is the proof
that they are one question.

The spine reads `Capture → Sources → Compose → Graph → Encode → Write` with
arrows, and a recording takes none of those arrows: it is written by Capture and
then re-opened at Sources. Two of the six cards are a different pipeline drawn
as part of this one.

### 2. The app cannot answer the question people actually ask

[UC02](uc02-small-enough-to-send.md). The question is a **size**. Every control
is a quality. There is no field anywhere that takes megabytes, and no estimate
before the render for a constant-quality encode — which is the default and what
every preset sets. The nearest thing is Bitrate mode in kbps, leaving the person
to compute `size = bitrate × duration ÷ 8` and account for the audio track.
ffmpeg cannot answer this either; the difference is that a tool with a timeline
knows the duration and could.

### 3. The right answer is filed under its mechanism

[UC03](uc03-lossless-cut.md), [UC04](uc04-change-the-container.md),
[UC05](uc05-one-frame-as-a-png.md), [UC06](uc06-just-the-audio.md),
[UC09](uc09-master-and-proxy.md). Every one of these jobs has a correct, fast,
well-built answer in the application, named after the ffmpeg mechanism that
implements it and placed where that mechanism lives:

| the job | where the answer is | what it is called |
|---|---|---|
| cut without re-encoding | Write, below the stream list | *Copy it instead* |
| change the container | Write, two unrelated controls | *Rewrap* then *Change* |
| save one frame | Write, the muxer picker | *image2* + *Numbering* + a one-frame range |
| export the audio | Write, delete a row + pick a muxer | — |
| master and proxy | Write, a `· 0` fold | *Also write* |

UC03 is the sharpest: a stream copy is the right answer to a large share of
everything anybody asks a video tool for, it is instant and lossless, and
nothing on the ordinary path ([UC01](uc01-trim-and-post.md)) mentions that it
exists.

### 4. One intention, several unlinked controls

[UC04](uc04-change-the-container.md), [UC06](uc06-just-the-audio.md),
[UC05](uc05-one-frame-as-a-png.md). "Put this in an mp4" is two presses in two
places in an unstated order, and doing only the first succeeds while producing a
file identical to the input. "One picture" does not shorten the range, so
leaving the range alone writes every frame into the same file — successfully, at
the cost of a full encode, leaving the last frame rather than the one you were
looking at.

### 5. Two stages do the same job and nothing says which

[UC12](uc12-logo-in-the-corner.md). A logo can go on Compose (a clip on a track
above, placed by the viewer's own rectangle) or on Graph (an `overlay` node).
Both are correct and they are different renders. The spine puts them side by
side with an arrow, which reads as *and then* rather than *or*.

## What the journeys measure, and what they cannot

Each step records the stage it happened on, any **ffmpeg concept** it cannot be
taken without, and whether the control had to be **uncovered** first — a fold
opened, a picker searched. The concept vocabulary is fixed (`CONCEPTS` in
[tests/usecases/journey.js](../../tests/usecases/journey.js)) so that the tally
across journeys adds up; a concept is on the list when the control cannot be
used correctly without it, not when the application merely says the word.

Two limits, stated because the numbers are otherwise easy to over-read:

- **The step list is the path somebody who already knows the application
  takes.** It is the floor, not the ceiling. Nothing here measures whether the
  path would have been *found*, and the real cost is worse than the recorded one
  everywhere.
- **A gesture that cannot be synthesised is driven through the model**, with a
  note where that happens. A drag on a clip edge is one intention and is
  recorded as one step whether it went through the mouse or through
  `trimClip`.

Each journey ends in `got()` — an assertion on the file that came out, which
fails the build — and any number of `shortfall()`s, which are recorded and
printed and deliberately do not. That split is what lets this suite exist: a
record that failed the build every time it found a design problem would be
deleted in a week, and one that passed while the person got the wrong file would
be worth nothing.
