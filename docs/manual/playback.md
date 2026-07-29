[← The manual](README.md)

# How playback works

There is no proxy transcode, no intermediate file, and no second encode.
libavcodec decodes in-process with frame and slice threading across all cores,
frames go to the renderer, and audio streams into bro's live PCM ring half a
second ahead of the mixer. What you see is the decoder's output at full quality.

Non-4:2:0 sources (10-bit HDR, 4:2:2 broadcast, 4:4:4 ProRes, RGB screen
captures) are converted by swscale on the way through.

**A clip recorded sideways plays the right way up.** Phones do not turn the
pixels; they record landscape frames and write the correction into the container
as a display matrix. That matrix reaches the player — the decoded frames stay the
size they were coded at and the *shown* size is the swapped pair, which is what a
clip is laid out against, so a 1920×1080 file tagged for a quarter turn is a
1080×1920 clip on a 1080×1920 canvas. The turning is a transform on the quad the
frame is drawn as rather than a pass over the pixels, so it costs nothing per
frame. Anything that is not a quarter turn is read as no rotation at all: a size
can be swapped or not, and a picture drawn at an angle inside a box laid out for
a rectangle is worse than the picture as it was stored.

**A file with no picture in it is an ordinary clip.** Drop an `.mp3`, a `.wav` or
an `.m4a` on the timeline and it lays out with the length of its audio track,
plays, moves the playhead and goes into the mix. What it does not do is take up
room on the canvas: it has no rectangle, no cell in a grid, no filmstrip and no
`[0:v]` pad in the graph, and a render of a timeline with nothing but sound on it
writes a file with a soundtrack and no video stream. The one thing it will not
do is step: `[` and `]` move by decoded pictures, and a soundtrack has none, so
stepping through a timeline of sound moves clip to clip. The master clock stays
with the topmost clip that *has* a picture wherever there is one — a music bed
laid over the footage must not take the clock away from the thing being watched.
