[← Use cases](README.md)

# UC03 — Cut an excerpt out without re-encoding it

> **Who** somebody who wants a piece of a long recording at the quality it already has
> **Wants** the same bitstream, cut, in seconds rather than minutes

**7 steps · 2 stages · 4 ffmpeg concepts · 2 hidden.**
Script: [`tests/usecases/uc03_lossless_cut.js`](../../tests/usecases/uc03_lossless_cut.js)

A stream copy: the packets already in the file, moved into a new one, starting
at a keyframe. Instant, lossless, and the right answer to a very large share of
everything anybody asks a video tool for.

## The path

1. Drop the recording.
2. Ripple-trim the clip down to the excerpt.
3. Go to Write.
4. Scroll past the stream list to **Copy it instead**. *(needs: stream copy)*
5. Press **Cut &lt;file&gt;**. *(needs: stream copy, keyframes)*
6. Change the container to one that will hold the codecs. *(needs: muxer, codec)*
7. Name the file and Export.

## What the application gets right

Genuinely a lot. The copy rows are ordinary rows with ordinary `copy:` sources
written into the stream list, so everything the shortcut decided is visible,
editable and undoable the moment it has run. The cut **follows the clip on the
timeline**, so re-trimming moves it. `Cut` is offered only where the timeline
says something a whole-file `Rewrap` does not.

## What went wrong

**Nothing on the ordinary path says this exists.** [UC01](uc01-trim-and-post.md)
is the same person one decision earlier, doing the same job the slow lossy way,
and neither the timeline nor Encode nor the read-back mentions that a cut
without re-encoding is possible at all.

The control is the fourth thing down the last stage, below the stream list,
under a heading named after the mechanism. Somebody who does not know the phrase
"stream copy" has no reason to look at it. The section's heading carries no
handle of its own — the only thing on the stage that names the section is its ⓘ
button.

`Rewrap` and `Cut` sit side by side and the difference between them — one takes
the whole file, one takes the trim — is in a tooltip.

**The keyframe rule is stated after the choice.** A copy can only begin at a
keyframe, so a cut asked for at 2.00 s landed at a keyframe before it and the
file came out 6.12 s rather than 4.00 s. That is correct and unavoidable; it is
said in the opened row *after* pressing the button rather than beside it.

## What would fix it

- **Offer it where the trim happens.** The timeline knows the clip is trimmed
  and Sources knows the codecs; "this cut can be made losslessly" is answerable
  at the moment somebody drags the edge, which is when they still care.
- **Name it after the job.** *Cut without re-encoding* is what it does. *Copy it
  instead* is what it is.
- **Say where the cut will land before it is taken.** The keyframe list is
  already read for the opened row. The nearest keyframe is one number and it is
  the only surprise on this path.
- **Let the container follow.** A copy the current muxer will not hold is
  already warned about; picking the muxer that will is the obvious next act and
  is left to the person to work out.
