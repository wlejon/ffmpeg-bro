[← The manual](README.md)

# The timeline

Video lanes under the ruler and one audio lane beneath them, the way an edit
suite stacks them:

- **V1, V2, …** filmstrips — each slot showing the frame that is on screen at
  that point, so it stays honest as you zoom in. There is always one empty lane
  above the highest one in use: dragging a clip into it is how you add a track,
  and the lanes share a fixed height between them so the waveform never gets
  pushed off the bottom. A clip stored sideways gets upright, portrait slots:
  the strip is cut to the *displayed* aspect and the pictures are turned to
  match, which is the one place anything here rotates pixels rather than the
  thing they are drawn on — a strip is a finished image with nothing left
  downstream to turn it.
- **A1** the waveform — peak envelope over an RMS body, so you can see where
  the sound is before you hear it. **One waveform, not one per clip**: two
  clips that overlap in time are one sound at that moment, and A1 draws what
  the render will make of it rather than whichever of them was painted last.
  The two halves are summed the way a mix is summed and not the same way as
  each other — the envelope *adds*, because two sounds at once reach the sum of
  their peaks and that is what clipping is, while the body is a
  root-sum-of-squares, because power adds and amplitude does not: two
  uncorrelated sounds at -6 dB make one at -3 rather than one at 0. A **muted**
  clip is drawn on its own, dimmed, and is outside the sum — it is still there
  and simply not being heard, so hiding it would make it hard to find again and
  folding it in would draw sound the render will not write.

  The lane is drawn in **decibels**, from -60 dBFS at the centre line to +6 at
  the top, with a dashed line across it where full scale is. Amplitude is the
  wrong scale to judge sound by eye — a linear lane spends half its height on
  the top 6 dB and crushes a quiet dialogue line into the last few pixels,
  where the decisions are; on this one a halving is the same distance wherever
  it happens. The ceiling is *above* full scale because the envelope is a sum
  and a sum can exceed it: two clips that each peak just under 0 dBFS make a
  mix that does not, and a lane that stopped at 1.0 drew that as exactly full
  height and looked fine. Columns that go over are drawn in their own colour,
  so an over is something you see rather than something you infer from a shape
  that has run out of room.

Both come from `bro.media` (see bro's `docs/video-api.js`), which decodes the
whole file through the same backend registry `<video>` plays through. Both are
full-file decodes, so ffmpeg-bro runs them in a Worker and the lanes fill in
behind a UI that never stops responding.

**Zoom** with the wheel, about the pointer — the only version that lets you
dive into a moment instead of steering the window back after every notch.
`Shift`+wheel pans, the scrollbar under the tracks pans, and `Fit` goes back to
the whole timeline. Everything is drawn from the visible window rather than the
whole file, so at 200× the strip is the individual frames around the playhead
and the waveform under it is the sound at that instant.

**Drop more files** to add them. One or two land after what is already there.
Three or more is a different act — that is a morning's recordings, not an edit —
so they go on tracks of their own, all starting together at zero, and the canvas
switches to a **grid** (see below). Each gets its own filmstrip and waveform.

**Drag a clip** along its lane to move it — it snaps to the timeline start, the
playhead and the other clips' edges, and anything it lands on top of *on the
same track* slides out of the way, which is also how you reorder. Overlapping
across tracks is the point of having tracks, so nothing moves there. Drag it
into another lane to restack it.

**Drag a clip's end** to trim. In-point and start move together when you trim
the head, so the pictures under the part you kept do not slide sideways, and a
trim stops at its neighbours rather than growing over them. The two grips
appear on the selected clip.

**Hold `Alt`** and each of those three targets becomes the edit that is about
the *cut* rather than about the clip. One modifier is enough because the target
already says which of the three you mean, and they hold three different things
constant:

| | | |
|---|---|---|
| `Alt` + a clip's **end** | **ripple** | holds the content, moves everything after — the gap closes instead of being left as a hole |
| `Alt` + a **cut** between two butted clips | **roll** | holds the total, moves the boundary — the programme is the same length and the cut is somewhere else in it |
| `Alt` + a clip's **body** | **slip** | holds the window, moves the content inside it — the clip stays put and starts somewhere else in the file |

**A cut is a different target from an end**, which is what makes that table
unambiguous rather than clever: two clips laid end to end share an x, and the
left one's out-point *is* the right one's in-point, so there is one boundary
there with two names. A clip with a gap after it has a loose end and no cut, and
`Alt` on it ripples.

Slip drags the film under the window, so dragging **right shows earlier
footage** — the convention every editor uses, and worth stating because both
readings are defensible. It stops at the ends of the footage rather than
shortening the clip, since a slip that got shorter would be a trim wearing the
wrong name. Roll stops when either side runs out of frames, by doing less rather
than by refusing: a drag that stops moving says where the wall is more clearly
than a drag that does nothing.

Ripple moves everything later **on the same track**. Not every track: a title on
V2 is placed against the shot under it, and rippling one track beneath another
would silently move it off.

**Split** (`S`, or the button) cuts every selected clip the playhead is inside —
one keypress through a whole stack, or through exactly the one you picked. Both
halves point at the same file, so a split costs nothing but a second `<video>`,
and together they cover exactly what the one clip covered. Trimming a half and
deleting the other is how you take a piece out of the middle.

**Select** by clicking a clip or its picture. `Ctrl`/`Shift`-click adds to the
selection, `Ctrl`+`A` takes everything, `Esc` narrows back to one. `Delete`
removes the lot. Drag the ruler or A1 to scrub.
