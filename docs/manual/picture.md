[← The manual](README.md)

# The picture

The viewer is an **output canvas**, not just a window onto the file: it has a
size of its own (`Match clip`, 1080p, vertical, 4K, or type one in), and each
clip is placed inside it. So a portrait phone capture and a 16:9 clip can share
a timeline with the black bars you would actually get.

Every clip the playhead is inside is on screen at once, bottom track first, so
V2 composites over V1. Per clip, from the **Properties** panel:

- **Track** — which lane, and so where in the stack.
- **Opacity** — what you see through it to the track below.
- **Audio** — the clip's own level and mute, multiplied by the transport's.
- **Fit / Fill / Stretch / 1:1** — how the picture meets the canvas.
- **Scale** — the slider, or the wheel over the picture.
- **Position** — drag the picture.
- **Crop** — four numbers, or press `C` for handles on the picture. Cropping
  trims edges where the picture already is; it does not re-fit what is left, so
  the frame stays put under the handle you are dragging.

With several clips selected the panel edits all of them. A property they
disagree on reads as blank or `mixed` rather than as one clip's value, so
tabbing past a field cannot silently apply it to the rest.

## Grid

`Grid` (or `G`) sets every clip's placement aside and gives each an equal cell.
The shape is chosen so a cell has the canvas's own aspect rather than being
square: four clips go 2×2, a dozen go 4×3, and three go two-up with a gap rather
than into one row of slivers. Scale and position still work inside a cell, so
one can be pushed in on a detail while the others hold still.

Everything plays at once and stays in sync automatically. On heavy footage —
several 1080p60 streams at once — a slight drift can appear briefly and is
corrected within a couple of frames; it is not something you need to manage.
