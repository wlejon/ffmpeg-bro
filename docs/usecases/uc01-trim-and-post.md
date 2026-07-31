[← Use cases](README.md)

# UC01 — Trim the dead air off a recording and post it

> **Who** somebody who screen-recorded a demo and spent the first seconds getting settled
> **Wants** the same recording with the front taken off, as a file they can upload

**5 steps · 2 stages · 0 ffmpeg concepts · 0 hidden.**
Script: [`tests/usecases/uc01_trim_and_post.js`](../../tests/usecases/uc01_trim_and_post.js)

The most common video job there is, and the one to measure everything else
against: nothing composited, nothing filtered, no setting chosen.

## The path

1. Drop the recording on the window — it becomes a clip.
2. Drag the clip's left edge past the dead air.
3. Go to Write. *(The next stage along the spine is Encode, which is a question
   about the picture nobody asked.)*
4. Type where it goes.
5. Export.

Cheapest journey in the set, and the application deserves the credit: a file, a
drag, a name, a button, and no ffmpeg vocabulary at all.

## What went wrong

**The exported file is the full original length with black on the front.**
Trimming a clip's head moves `clip.start` forward and leaves a gap at zero. The
render range is still the whole timeline, so the gap is rendered. Verified: a
10.00 s source trimmed by 0.40 s exports 10.00 s.

Nothing between the drag and the button says so. The program monitor is parked
at the playhead, the range strip shows the whole timeline because that is what
the range is, and *What will be written* states `00:00:10 · 250 frames` and
presents it as correct — it is describing the render faithfully, and the render
is not what was asked for.

`rippleTrim` — Alt-drag — does what was meant: it trims and closes the gap, so
the clip starts at zero and the timeline is 9.60 s. Two drags on one edge doing
different things, with nothing on the timeline saying which one just happened.

Two more, both real and both about the same moment:

- **The whole file was re-encoded** to take 0.4 s off the front. The same cut at
  a keyframe would have been instant and lossless — [UC03](uc03-lossless-cut.md)
  — and nothing on this path mentions that it is possible.
- **No size was offered**, before or after. See [UC02](uc02-small-enough-to-send.md).

## What would fix it

- **Make the render range follow the content by default.** A range beginning
  where the first clip begins is right for every edit anybody has made; starting
  at zero regardless is a deliberate hold, and holds are what a control is for.
- Failing that, **say it in the read-back**. *What will be written* is the last
  thing under the pointer and already knows the range and the clips. "starts
  with 0.4 s of black" is one line, and it turns a wrong file into a decision.
- **Name the two drags.** A trim that leaves a gap and a trim that closes one
  are different edits. The timeline draws the gap and never says it will be
  rendered.
