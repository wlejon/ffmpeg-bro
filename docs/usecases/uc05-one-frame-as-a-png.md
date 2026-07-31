[← Use cases](README.md)

# UC05 — Get one frame out as a PNG

> **Who** somebody who needs a thumbnail, a still for a slide, or a bug report
> **Wants** the picture at one moment, as an image file

**8 steps · 2 stages · 3 ffmpeg concepts · 3 hidden.**
Script: [`tests/usecases/uc05_one_frame_as_a_png.js`](../../tests/usecases/uc05_one_frame_as_a_png.js)

One of the most-wanted things anybody does with a video, and by a distance the
hardest journey in this set.

## The path

1. Drop the file.
2. Move the playhead to the frame.
3. Look for "save this frame" on the monitor, the clip, the transport and the
   keyboard map. **There is none** — verified, not assumed.
4. Work out that a still is written by a *container*, open the muxer picker,
   search `png`, choose **image2**. *(needs: muxer, image sequences)*
5. Name the file, and take back out the frame-number pattern that choosing
   image2 just wrote into it.
6. Find **Numbering** and choose **One picture**. *(needs: image sequences)*
7. Shorten the render range to a single frame.
8. Export.

## What the application gets right

Searching `png` finds `image2`, because the search reads each muxer's extension
list. Every one of the three ffmpeg facts is explained properly where it
appears, and `Numbering` exists at all — most tools would have shipped
`out%04d.png` and let people discover it.

## What went wrong

**There is no control for the thing being asked for.** Eight steps and three
ffmpeg concepts for "save this picture". Every step is correct; none of them is
the job. The playhead is already on the frame, and the renderer already has a
one-frame path — `runExport` over a range of one — so what is missing is a
press, not capability.

**Choosing image2 rewrites the filename** to a numbering pattern. That is what
image2 means and it is right, and it is not what somebody who asked for one
thumbnail expected to see happen to a field they had typed in.

**The step that is easy to miss is silently wrong to skip.** `One picture` is
`-update 1`, and nothing connects it to the render range. Leave the range alone
and the render walks the whole clip writing every frame into the same file. It
succeeds. It takes as long as a full encode. What is left on disk is the *last*
frame, not the one that was under the playhead.

## What would fix it

- **A frame grab is a press, not a pipeline.** The playhead is on the frame; the
  renderer can already write one. `Save this frame` under the monitor, writing a
  PNG beside the project, covers the entire use case and needs nothing new
  underneath it.
- If it must stay in the render pipeline, **make `One picture` set the range.**
  The two are one intention and the second is invisible; a still that quietly
  costs a full encode and yields the wrong frame is the worst failure on this
  path.
- **Do not rewrite a filename somebody typed.** Offer the pattern; do not apply
  it.
