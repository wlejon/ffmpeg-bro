# The manual

Everything the application does, stage by stage, in detail — the behaviour half
of the documentation, kept whole because the details are load-bearing. The
README is the short version; this is all of it. The JS surface that scripts and
tests drive is documented separately in [api.md](api.md).

## How playback works

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

## Capture

`D` (or the first card on the spine) is where an input comes from when there is not
one yet: a screen, a camera, a microphone — one of them or several at once,
composited and recorded to a file.

It is **first on the spine and it is the one card that is not about the render**.
Every other stage is a question about the file coming out; this is the question
about the file going in. `ffmpeg -f gdigrab -i desktop out.mkv` is a whole pipeline
whose output is a file, and then you open that file — so the arrow from Capture to
Sources is real, just crossed at a different moment. `Add to the timeline` is that
arrow being followed.

**A device is an input, and it is in the same list every file is in.** `-f dshow`
names a libavdevice demuxer, `-i video=…` names what it can see, and everything else
about it is that demuxer's own options — in the same bag `-probesize` travels in,
printed in front of the same `-i`. Nothing about a device is a feature of this
application.

**Clicking a device activates it**, and activating is what adds the `-i`. This stage
used to keep a private list of devices, which meant a device it could record existed
nowhere else: not on Sources, not in the graph's source list, not in a spec. It now
adds an ordinary input, so the moment you activate a camera it appears on the Sources
stage with its demuxer and its option bag, and in the Graph stage's source list beside
every file — with a picture socket, a sound socket, or both, according to what
`probe()` found. The `×` on a card **releases** it, out of the recording and out of
the input list together. No devices activated is an ordinary state; so is one device
activated and never recorded.

What is *not* possible is laying a device on the timeline, and that is not a gap: a
clip is an in-point and a length, and a live input has neither. It is refused by name,
with what to do instead.

Three columns, in the order somebody works:

- **What to capture**, on the left. libavdevice's own list — on Windows `dshow`,
  `gdigrab`, `vfwcap` and `lavfi`; on another platform a different list, with nothing
  here changed — under the human name libav gives each one, with the `-f` spelling
  beneath it. Clicking one adds it. Underneath is **what that device can see**:
  `avdevice_list_input_sources`, picked rather than typed, because a DirectShow name
  is an exact string with punctuation in it and nobody types one correctly. A camera
  and a microphone chosen together are **one `-i`** (`video=Cam:audio=Mic`), because
  that is what dshow means by it: one demuxer, one file, two streams. A device with
  nothing to enumerate says so — gdigrab takes a rectangle rather than a name — rather
  than showing an empty list, which reads as a machine with no cameras in it.
- **The pictures and the act**, in the middle. A card per input with its live preview,
  its **Source** and **Stop after**, and its region where it has one; under them, what
  the graph makes of them; under that, the graph as one line; and at the bottom, the
  **Record** button with the file it is about to write beside it and — where it is dead
  — the reason it is dead.
- **What comes out**, on the right: where it is saved, the container, the two codecs,
  the quality, and how long it will be. Beneath that the focused device's **whole
  option table**, in the column the encoder's and the muxer's options already use:
  `video_size`, `framerate`, `draw_mouse`, `offset_x`, `audio_buffer_size`,
  `rtbufsize`. An unknown key stops the open rather than being ignored.

**The stage states; this manual explains.** It did not always. Every panel used to
carry the paragraph that justified it — why a device is an input, why the graph is
edited elsewhere, what a region is in ffmpeg's vocabulary, why there is no percentage
— and all of it was true and the screen was unusable: the Record button sat in the
middle of nine paragraphs at the weight of an ordinary control, and where the file
was going had been pushed off the bottom of the same column. What is on screen now is
a label, a value and a door to whatever would change it, with the sentence that was
load-bearing attached as a tooltip to the control it is about. The vocabulary went
the same way: the two fields on a card were *labelled* `-i` and `-t`, which is a
control only somebody who did not need it could read. They are **Source** and **Stop
after**, and `ffmpeg -f gdigrab -i desktop …` is printed exactly, and copyably, in the
command bar along the bottom of the window. The one piece of ffmpeg left on a card is
the `-i` **number** — a badge, `0`, `1` — because the graph genuinely calls them that.

**Several devices are several `-i`s, and a card each.** Clicking a second device
appends another input; the cards sit across the stage in the order that numbers them
for the graph, so the first is badged `0` and reaches the graph as `[0:v]`/`[0:a]`, the
second `1` and `[1:…]`. Each card is a whole input — its source, its window, its own
option bag — and clicking one is what points the device list and the option column at
it, which both of them say. Because
a card is a document input, an option set on it anywhere is set on it everywhere: a
`-probesize` typed on the Sources stage reaches the recording, and the command bar
prints it in front of that `-i`.

Changing a card's device is releasing one and activating another, which is two clicks
and is the honest spelling: a device and its option bag go together, and carrying
`draw_mouse` over to a camera would be carrying a key that stops the open.

**Stop after** — `-t` — belongs to an **input** rather than to the recording, exactly
as it does on a command line, which is why it is on a card and not in the output
column; **the shortest of them is when the session ends**, and that is the *Length* the
output column states. An input that has run out has nothing further to offer the graph,
so going on would be recording the others over a picture held still.

**A live preview per card, before you commit to a recording.** Each picture is an
ordinary `<video>` through the same backend, the same decoder and the same renderer
everything else in this application plays through. There is no preview-only path, for
the reason the node previews have none: a preview that agreed with the recording most
of the time would be worse than none, because it would be trusted.

**And below them, what the graph makes of them — playing.** That is the same
`CaptureGraph` a recording runs, on the same text the Graph stage built, so a
picture-in-picture is something you look at rather than something you judge by its
numbers and then discover in the take. It appears when the graph produces a picture
and is absent when it does not; there is nothing to turn on.

Behind all of it is **one open per device**. A card used to play the device itself,
which opened it a second time — fine while the cards were the only things watching,
and an error the moment the composition wanted the same cameras, because a DirectShow
device can be opened once. So a *session* opens each device exactly once and publishes
what it sees: each input as `in0`, `in1`, … and whatever the graph makes as `vout`.
Every picture on the stage is a pad of that one session, and three pictures of two
cameras costs two opens.

A recording still opens its own devices, and the session is torn down first. That is
deliberate rather than a limitation: "there is no camera called that" is a refusal
that belongs to the call that asked for the recording, and a recording that inherited
a running session would have nothing to refuse with. The cost is the moment between
the two opens, which is the moment the pictures go dark anyway.

**Every device this build can open plays here, `lavfi` included.** It did not always:
lavfi is a whole filtergraph wrapped up as a demuxer, and what it hands over is
`wrapped_avframe` — a pointer to an already-decoded frame rather than a packet of
bytes. bro's `MediaPacket` carries bytes, quite rightly, because bro is
codec-agnostic and knows nothing about libav's types; so the pointer was copied as
eight meaningless bytes, the frame behind it was freed on the way past, and the
decoder at the far end refused it. The fix was the crossing rather than a special
case in the UI: such a frame now travels as itself, owned by the packet, and only
the decoder this backend built for that track ever looks inside. Everything else
about the seam is unchanged, and a `-f lavfi -i testsrc` card now shows its test
pattern like any other device.

**The graph is built on the Graph stage, and with several inputs it is not
optional.** A recording has been able to run a filter graph for as long as the engine
has had one, at one input as much as at several: cropping one monitor out of a wide
screen grab is a `crop` node between the device and video out. Several inputs
*require* one — two pictures and nothing saying how they combine is refused rather
than guessed at, and once there is more than one input **every** stream of every
input has to reach a pad, because a stream going straight to the writer would be one
device's picture silently becoming the file. Both refusals name what is wrong and
which pad it is about.

There used to be a textarea here and three buttons that wrote a chain into it. Both
are gone, and what replaced them is not a smaller version of the same thing: an
activated device is a document input, so it is already in the Graph stage's source
list, and placing it there gives a node that can be wired, checked against
libavfilter's own pad lists and previewed at any point. Keeping the field as well
would have meant two descriptions of one recording and no rule about which wins.

**A recording writes the pads it names, and runs the part of the graph that produces
them.** That is ffmpeg's own rule — an invocation maps some labels and libavfilter
runs whatever those labels need — so the walk starts at the sinks the recording writes
and goes *up*. Not a graph of its own, since there is one document and one editor for
it; not the whole graph either, since most of what is on that stage is usually about
the timeline. Three consequences:

- A **generator** comes with it and a **file** does not. A `testsrc` overlaid on a
  camera is fine — a filter with no inputs makes its own frames, and nothing has to
  pull one. A file is refused by name, because a recording's graph is *pushed*: a
  device frame goes in and whatever falls out of the sinks is what there is, and
  there is nobody to ask a file for its next frame.
- The **ends it did not name** cost nothing to ignore. Walking upwards cannot reach a
  sink, so a branch leaving by some other output is simply not in the recording —
  which is why the walk runs this way round. One graph feeds a render and a recording
  without either being an error.
- The pads are **renumbered**. The graph numbers `-i`s in the order nodes were
  placed; a recording numbers them in the order its cards are in, because that order
  is the one the engine opens the devices in.

**Which pads?** By default video out and sound out, because that is where a person
wires something when the graph has only one end. But those two are also where a
*render* of the timeline ends, and one pad cannot be both the timeline's composite and
the cameras' — wiring two cameras into video out is not a statement about recordings,
it is a statement about what this graph's picture is, and the composite is then
feeding nothing. So place an output of your own on the Graph stage, wire the cameras
to that, and pick it under **Picture from** on the Capture stage. The picker appears
only once the graph has an output of its own; until then there is nothing to choose
and a control with one option is a statement dressed as a question.

That choice is a `-map` and nothing more. The composition is still described once, on
the Graph stage, and the pad is remembered by identity rather than by name, so
renaming an output moves the recording with it. Whatever it is called there, the chain
comes out ending in `[vout]`: a recording is its own invocation with its own muxer,
and that is the label the writer maps. Delete the output and the recording drops back
to video out — the panel says what it is mapped as now, which is the whole of what
changed.

All of that is **one line** on the Capture stage — `Filters: none`, or `2 inputs →
[vout]`, or `will not run — …` — with the button that opens the Graph stage on the end
of it, and the chains that will run listed under it when there are any. It is the same
text the command bar prints from the same call. A graph that will not run says so in
the words the Graph stage uses against the node it is about, the Record button is dead
until it does and says so beside itself, and the command bar prints no
`-filter_complex` at all, because a line that cannot be run is not one to offer for
copying. The line is short because the ordinary answer is "none" and a permanent
four-line explanation of the case where there is nothing to explain is what the
commonest screen on this stage used to be.

**A region is dragged, not typed, and it lives on the card whose picture it is dragged
on.** Drag a box on an input's picture and it becomes `-offset_x`, `-offset_y` and
`-video_size` — that input's own demuxer options, in the screen's own pixels, printed
in the command a foot below and set in the option table on the right like any other
key. It belongs to an input the way its source does, which is why it is not a section
in another column describing a rectangle you cannot see from there — with two screen
grabbers activated, that section was about whichever card happened to be focused.
Which devices can be asked for a region is a question about their option table rather
than a list of names here:
a device takes a rectangle when it has all three of those options, which a screen
grabber does and a camera does not. The picture is fitted rather than stretched,
because a squashed picture would be a squashed rectangle — and the rectangle is
**clamped to the screen**, because a card is only as wide as the room the other cards
left it, one pixel of a wide desktop shown small is thirty of screen, and a rectangle
running off the edge is one libavdevice refuses at the open.

**Recording says what it can say and no more.** Elapsed, frames written, bytes on
disk — and, out loud, that it *runs until you stop it*: a percentage needs a total and
a device has no end until you press stop. Give an input a **Stop after** and it does
have one, and then the percentage means something. `Stop` is the *normal* end of a recording rather than
the exceptional one, so a stopped recording reports as **done**: nothing was
abandoned, the length was the open question and stopping answered it. The trailer
goes down either way, which matters more here than anywhere else — a render that lost
its index has lost a file that can be made again, and a recording that lost its index
has lost the only copy of something that happened once.

**One job at a time, and while recording that job is the recording.** There is one
render slot in this binary and a capture takes it: no export, no preview, no node
render while the light is on. That is a decision and not a limitation left in —
a recording is the only job here with a real-time deadline and it cannot be re-run,
so it gets the machine. Every other stage is refused with the reason while it runs.

## Sources

`I` (or the second card on the spine) is the **inputs** — the `-i`s. Not "the files on
the timeline": an input is a thing in its own right, it carries a demuxer and that
demuxer's options and a window, it can be a URL, and it exists whether or not
anything is cut from it. Adding one and using one are two acts, and `Use on the
timeline` is how the second happens.

Three columns, in the order the questions come.

**The list.** Every input, numbered the way `-i` numbers them, each saying where it
comes from, what has been set on it in ffmpeg's own words (`-f matroska -probesize
5000000 -ss 12`) and what is being done with it — `unused`, `2 clips`, `recording`,
`in the graph`, `written`. **Unused is a normal state and says so** rather than being
hidden or collected: opening a file to see what is in it is a thing people do.

**The input.** What it is:

- **From.** A path, or anything a protocol this build links can reach — `https`,
  `srt`, `rtmp`, `udp`, `tcp`, thirty-six of them. A URL gets an **Over** row naming
  its protocol and saying whether it is one of them, because a URL naming a protocol
  that is absent otherwise fails at open with a message about a filename.
- **Read as** — the demuxer. What it probed as, `Change…` for a search over all three
  hundred and fifty, and `Auto` to hand the choice back to libavformat. Searched
  rather than listed for the reason the muxer picker and the filter palette are:
  there is no list of the good ones anywhere.
- **Window** — **Start at**, **Stop at**, **Delay by**, **Repeat**. **An input seek
  is not a clip's in-point**, and this is where the difference is legible: `-ss`
  moves the input's zero, so the input becomes shorter and a clip is cut from what is
  left. Trimming a clip picks a moment out of an input; Start at decides what the
  input is. Delay by (`-itsoffset`) shifts every timestamp, which is how a camera and
  a separately recorded soundtrack are lined up. Repeat (`-stream_loop`) is the other
  half of the same question — how much of this input there is — and `-1` is forever,
  which has no length at all, so a looping input is as long as Stop at says and no
  longer.
- **What came back** — the container on one line, then **one line per stream**:
  `V0  h264  1920×1080 · 29.97 fps · yuv420p · bt709`. Everything else the probe
  reported — profile, language, pixel aspect, colour range, per-stream duration — is
  on that line's tooltip. Straight out of `probe()`, run **with the options in
  force**, so it is the answer to "what did the thing I just set do" rather than a
  description of the file as libavformat's defaults see it.

**And under the column, the act.** `Use on the timeline`, pinned, with the reason
beside it where it is dead — `A device has no end`, `One picture, no time at all`,
`Never ends — set Stop at`, `Nothing to play`, `Will not open`. Those five mirror
`openInput()` exactly, so the button is never alive and then refusing. `Re-probe` and
`Remove` sit at the other end of the same bar; `Remove` says who is holding the input
instead of going dead silently.

**The stage states; this manual explains.** It did not always. `-ss`, `-to`,
`-itsoffset`, `-stream_loop`, `-hwaccel`, `-framerate` and `-start_number` were the
*labels* of the fields, each with the paragraph that justified it underneath — three
hundred words with the controls scattered through them, `Use on the timeline` at the
weight of an ordinary button somewhere in the middle, and the file's own streams (six
rows each, forty rows on a camera file) below all of it. What is on screen now is a
label, a value and a door; the sentence that was load-bearing is the tooltip of the
control it is about, and the ffmpeg spelling with it. The exact line is a foot below
in the command bar, which is the honest place for it. What stayed in ffmpeg's own
words is the `-i` **number** on a list card, because the graph genuinely calls an
input `[1:v]`, and the one-line summary under it, because "what is set on this input"
is precisely a list of flags.

**The options.** The demuxer's own table, out of its `AVClass` and libavformat's
generic one, in the column the encoder's advanced options and the muxer's already use
— and the protocol's beside it when the path is a URL, since libavformat passes what
the demuxer does not recognise down to the AVIO layer and they travel in one bag.
An unknown key stops the open and names itself.

Under them, **the decoders** — one column per codec this input turned out to
carry. `-skip_frame`, `-skip_loop_filter`, `-thread_type`, `-lowres`, and every
private option of whichever decoder libavcodec picks. **A decoder belongs to an
`-i`**, which is why they are here and not on the Encode stage: ffmpeg writes
`-skip_frame` in front of the same `-i` that `-probesize` goes in front of, and
for the same reason — both are decisions taken while this input is being read.
They are a separate bag from the demuxer's because they are a separate object
with a separate table, and they reach *both* the render and playback, so
`-skip_frame nokey` is the same decision on the timeline and in the file that
comes out. An unknown key is refused with the key named, as an unknown demuxer
option is — and refused **before the render starts**, because the compositor
deliberately draws an unopenable clip as the hole it is, which is right for a
file that has gone missing and wrong for a setting somebody typed.

Two clips from one file are one input, which is what ffmpeg would open. A second drop
of the same file reuses it — unless something has been set on it, in which case a
fresh one is made rather than silently inheriting somebody's decision.

An input with no clip cut from it is **not necessarily unused**. The Graph stage
can read one directly — that is what a watermark is — and such an input says
`read by the graph` on its card and cannot be removed while the node naming it
exists. Underneath the list, **Opened by the graph** accounts for the one way a
file can be opened without being an `-i`: a `movie` filter, which opens its file
inside libavfilter with none of this stage's options reaching it. It is listed
rather than left off, with the offer to make it an input instead.

### An input that is not one file

Three of ffmpeg's inputs are not a file, and each is *assembled* rather than opened.
Every one of them is set with ordinary demuxer options — `-framerate`,
`-start_number`, `-pattern_type` and `-loop` belong to `image2`, `safe` belongs to
`concat` — so they travel in the same bag `-probesize` does and are printed in front
of the same `-i`. They get rows of their own for what they *mean*, not for what they
are.

**An image sequence.** Drop a folder of numbered frames, or the frames themselves, and
they arrive as one input rather than three hundred. Working out which files belong
together is the part that has to be right, so the grouping is a set of refusals:

| | |
|---|---|
| the number is the **last** run of digits | `shot2_0007.png` is frame 7 of `shot2_`, not frame 2 of `shot` |
| a run of one file is not a sequence | it is a still, which is a different input with a different question on it |
| zero padding is meaningful, unpadded numbering is not | `007` and `0007` are two runs; `plate1`…`plate12` is one, written `%d` |
| a gap is reported, never closed | `image2` stops at the first missing number, so a run of 300 with 12 absent is not 300 frames |
| folders are read one level deep and never crossed | two levels of folder is a project layout, not a sequence |
| only image extensions take part | and they are libavformat's own, not a list written down here |

So a logo sitting beside three hundred frames stays a file of its own, and a folder
holding two sequences is two inputs.

**A sequence has no frame rate.** Twelve pictures are twelve pictures; nothing on disk
says how long each is on screen. **Rate** (`-framerate`) is what decides, it is an
*input option*, and the same files are one second or two depending only on it. **First
number** (`-start_number`) is set out loud too, because `image2` looks for the first
five numbers from zero and then gives up — a run beginning at 1000 is unopenable
without it, and one beginning at 1 opens only by accident.

**Named by** is `-pattern_type`, and the `pattern` half is offered where the build has
it. This one does not: globbing is a compile-time feature of libavformat, reported as
"Function not implemented" from `read_header` and from nowhere else, so it is asked by
trying and the control is shown disabled with the reason rather than failing at open.

**A still is a decision about how long it is.** A single picture is no time at all —
libavformat says so, and bro's `<video>` agrees, because it drives its clock from
decoded pictures and one picture is nothing to advance through. So a still is opened
as `-loop 1` with a `-t`: the loop makes the input go on producing the same picture,
and the `-t` is the only thing that can say how long it lasts. Both are **Hold for**,
which is one field because they are one decision, and the command bar prints the pair
of them in front of the `-i`. Take the loop away and the input has no length; the
application says so — on the pinned bar, where the act it refuses is — rather than
putting a clip of nothing on the timeline.

**Several files as one input.** `Join…` writes a list file and adds it as
`-f concat -safe 0`. **Three things here are called concat and they are not each
other**, so the panel is headed `Read end to end` and its tooltip says which this is
before it offers to do it:

| | |
|---|---|
| the concat **demuxer** | reads the listed files one after another *before* anything is decoded — they have to be encoded compatibly |
| the concat **filter** | joins decoded streams inside the graph, and does not care what they were |
| two clips **end to end** on the timeline | is neither: that is an edit, and it renders through the compositor |

Each entry in the list carries its own duration. Without them the demuxer opens the
first file at header time, discovers the rest as it reaches them, and reports no
length at all — so the joined input would lay out as no clip.

## The timeline

Video lanes under the ruler and one audio lane beneath them, the way an edit
suite stacks them:

- **V1, V2, …** filmstrips — each slot showing the frame that is on screen at
  that point, so it stays honest as you zoom in. There is always one empty lane
  above the highest one in use: dragging a clip into it is how you add a track,
  and the lanes share a fixed height between them so the waveform never gets
  pushed off the bottom.
- **A1** the waveform — peak envelope over an RMS body, so you can see where
  the sound is before you hear it.

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

**Split** (`S`, or the button) cuts every selected clip the playhead is inside —
one keypress through a whole stack, or through exactly the one you picked. Both
halves point at the same file, so a split costs nothing but a second `<video>`,
and together they cover exactly what the one clip covered. Trimming a half and
deleting the other is how you take a piece out of the middle.

**Select** by clicking a clip or its picture. `Ctrl`/`Shift`-click adds to the
selection, `Ctrl`+`A` takes everything, `Esc` narrows back to one. `Delete`
removes the lot. Drag the ruler or A1 to scrub.

## The picture

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

None of this costs anything per frame. The crop is a window around the clip's
`<video>`, opacity and stacking order are an `opacity` and a `z-index` on that
window, and the engine clips replaced content against an ancestor's overflow
like anything else — so a change is a handful of style writes and the decoded
frame still goes straight to the renderer.

### Grid

`Grid` (or `G`) sets every clip's placement aside and gives each an equal cell.
The shape is chosen so a cell has the canvas's own aspect rather than being
square — the clips came out of that canvas, so that is the shape that fills:
four clips go 2×2, a dozen go 4×3, and three go two-up with a gap rather than
into one row of slivers. Scale and position still work inside a cell, so one can
be pushed in on a detail while the others hold still.

Everything plays at once. The topmost clip's decoder is the master clock and the
rest are chased back into line whenever they drift more than about two frames —
correcting every frame would mean a seek per clip per frame, and left alone,
several decoders each free-running on their own audio clock come apart within a
minute. Four 1080p60 streams stay inside ~35 ms of each other; the ceiling is
decode throughput, not the transport.

## The graph

`N` opens the Graph stage, which is the edit drawn as the filtergraph that
performs it. Every trim, every scale, every overlay, named the way ffmpeg names
them, wired the way ffmpeg wires them — and the same chains the command bar
prints along the bottom, laid out so they can be read.

It is **derived from the timeline and rebuilt whenever the timeline moves**.
Nothing on this screen invents a graph; it asks for one on every change and
draws the answer, which is what makes it a picture of the edit as it is now
rather than a copy of the edit as it was.

### Getting around it

It works the way a node editor works. Nothing here is invented — Blender, Nuke,
Houdini, Unreal and n8n all agree on this much, and knowing one of them should
be enough to use this.

| | |
|---|---|
| drag the background | select what the band covers |
| middle-drag | pan, from anywhere including over a node |
| wheel | zoom about the pointer |
| drag a node's title bar | place it — and everything else selected with it |
| click a value on a card | change it |
| hover a wire | its `+` |
| drag socket → socket | make a wire |
| drag a socket onto empty canvas | the palette, filtered to what can take that pad |
| click a wire | select it; `Delete` cuts it |
| `Add filter` | place one on the canvas with nothing wired to it |
| `Fit`, or `0` | frame the whole graph |
| the percentage | back to 1:1 |
| `Re-layout` | give every node back to the layout |
| `Delete` | remove a selected node of yours, or cut a selected wire |
| `Esc` | clear the selection, then leave the stage |

Nodes carry a socket for **every pad the filter has**, not one per wire that
arrived — which matters most at `overlay`, whose two inputs are the canvas and
the clip and are not interchangeable, and which is what makes an empty pad
something you can see and aim at rather than something invisible. An input pad
that has nothing on it is drawn hollow. **Where you put a node is remembered**, against the node rather
than against a position, so it survives the graph being rebuilt by the next
timeline edit; a placed node does not move for anything except you and
`Re-layout`. Zoomed out far enough that the values stop being readable the cards
become their names and their pictures, and the minimap in the corner is where
you are.

### Putting a filter in it

Hover a wire that can take one and it offers a `+`. Click it and pick a filter out of
**libavfilter's own list** — five hundred of them in this build, searchable by
name and by what libavfilter says each one does; there is no list of supported
filters written down anywhere in this application. The filter appears on the
wire, selected, with its whole option table beside it, read out of the filter's
own `AVClass` exactly as the encoder's advanced column is read out of an
encoder's.

What is *set* is on the card and can be typed there; what the filter *has* is in
the column, because `scale` has thirty options and a card with thirty rows is not
a card. Typing on either locks the node — see below.

There are five places a filter can go, and they are five different pictures:

| Point | What is on the wire there |
|---|---|
| after decode | the source at its own size, format and colour |
| after scale | the clip as it will be composited — RGBA, at the size it occupies |
| after compositing | the whole canvas, before the encoder's colour |
| clip audio | one clip's sound, before it is trimmed and placed |
| after mixing | the whole soundtrack |

Two filters at one point run in the order you added them.

There is deliberately **no point after the output colour conversion**. That
conversion is the one chain that exists in the printed command and not in the
graph this binary runs — the writer does it here — so a filter placed there
would sit in the encoder's colour in the command you copied and in RGBA in the
render you got. One insert point producing two pictures is worse than one fewer
insert point. It is attached at the very end, after everything you did, which is
what makes wiring anything behind it unreachable rather than something to be
warned about.

### Wiring it yourself

Splicing is one in and one out, and most of libavfilter is not. `overlay` reads
two pads, `amix` reads as many as you say, `split` writes several, `concat` does
both — none of which can be dropped *onto* a wire, because there is nothing for
the second pad to read. So they are placed and then wired:

- **Drag from a socket to a socket.** Either end first; a wire from an input
  back to an output is the same connection. **An input pad holds one wire**, so
  dropping on an occupied pad replaces what was there — which is how a filter
  gets *between* two derived nodes in one gesture rather than a delete and two
  connects.
- **Let a wire go over empty canvas** and the palette opens on what can take
  that pad, out of libavfilter's own registry. What you pick lands where you
  let go and arrives already wired. `Add node` is the same palette with
  nothing in the air.
- **Click a wire to select it, `Delete` to cut it.** Cutting a wire the
  derivation made is *remembered*: the skeleton is rebuilt from the timeline on
  every edit and would put it straight back, so the absence has to be written
  down. `Give it back` in the column hands the pad to the derivation again.

A filter whose pad count is a number — `amix=inputs=3`, `concat=n=3:v=1:a=1`,
`xstack` — grows and loses sockets as you change it, because the count is an
ordinary option in the column beside the graph. **A wire whose pad stops
existing does not vanish.** It is kept, reported by name — *amix has 2 inputs,
so your wire at input 3 has nowhere to land* — and put back the moment the count
goes up again, because a mistyped number should not be lost work.

### A node that makes something out of nothing

Some filters read no pad at all. `color` is a rectangle, `testsrc` and
`smptebars` are test cards, `sine` is a tone, `anullsrc` is silence,
`mandelbrot` is what it says — and there are about thirty of them in this build.
They are **discovered, not listed**: a source here is simply a filter
libavfilter declares with no input pads, so a build that gains one gains it in
the palette without an edit.

`Add node` opens on them, and so does letting a wire go from an *input* pad —
which is the short way round, because what you get back is already wired to the
pad you were trying to fill.

A generator arrives carrying **the size and the frame rate the render is**, read
out of the filter's own option table. That is not decoration: a graph whose last
pad is a different size from the render is refused rather than quietly rescaled,
so filling it in at the moment of placing means the ordinary case simply agrees
and changing it afterwards is a decision you get told about.

**A generator has no length.** It goes on producing for as long as it is asked
to, so with clips on the timeline the render's range is what stops it, and with
nothing on the timeline its own `duration`/`d` is the only thing that can — the
same rule a still and a `-stream_loop -1` follow, and zero still means nobody
knows. Say nothing and the stage says so: *the range is empty — with nothing on
the timeline, a source's own duration (d) is the only thing that says how long a
render would be*.

**A render with nothing on the timeline is a real render.** `ffmpeg -f lavfi -i
testsrc -t 5 out.mp4` is a thing people do every day, and a `testsrc` wired to
`video out` writes a file here with no clip involved. With no clips there is no
derived black canvas either — a rectangle nothing is laid over would be a source
nothing reads the moment you wire your own to the sink — so `video out` is empty
until you fill it, and the stage says which pad it is waiting on.

### A file the graph reads

A watermark, a logo bug, a picture-in-picture insert and a sound bed are one
shape: a file the *graph* reads that nothing on the timeline is cut from.

ffmpeg writes that two ways — `-i logo.png` with `[1:v]overlay`, and
`movie=logo.png,overlay` — and **this application reaches for the first**. The
reason is that everything deciding *how a file is opened* belongs to the `-i`:
the forced demuxer, `-probesize`, `-loop`, `-ss`, `-t`, `-stream_loop`, and for
a URL the whole protocol option table. A `movie` node carries a filename and a
seek point, so making it the mechanism would mean rebuilding all of that inside
a filter argument, badly, beside an input model that already has it. It also
keeps the Sources stage honest: that stage claims to be every file this render
opens, and a `movie=` names one that never appears there and cannot be probed
with the options in force.

So the palette's Sources list **leads with the inputs you already have**.
Picking one places a node that is that input — a file, with a socket per stream
the probe found, numbered as the `-i` it will be. Everything about how it opens
stays on the Sources stage, and the card there says `read by the graph` and
refuses to be removed out from under the node naming it.

Placing a logo over the picture is then two nodes and two wires:

1. `Add node` → the logo file. It lands on the canvas.
2. Drag from the composite's output into empty canvas → pick `overlay`. It
   lands wired to overlay's first input, which is what it draws *onto*.
3. Drag the logo's picture socket onto overlay's second input.
4. Drag overlay's output onto `video out`.

`movie` and `amovie` are still there — they are ordinary filters with no inputs
and the palette offers every one of those — and if you use one, the file it
names is listed on the Sources stage under **Opened by the graph**, with what
that costs said plainly and an offer to make it an `-i` instead. Two things to
know if you do: nothing on the Sources stage reaches it, and a path with a drive
letter in it has to have its colon escaped (`C\:/logo.png`) because a colon
separates filter arguments.

### An end of your own

`video out` and `sound out` are the derivation's two ends, and a render maps them
because they are the render's picture and its soundtrack. A graph can have more ends
than that. **Drag forwards out of an output pad** and the palette leads with *an
output* — the forward analogue of dragging backwards for a file or a generator, and
the one answer to "where does this go" that is not another filter. It lands wired and
already named, and the name is editable the moment it arrives, because the panel is
showing the node you just made. `out2`, `out3` — not `out1`, because `vout` and `aout`
are the derivation's own names for the composite and the mix, so the first one anybody
adds is the second thing this render writes.

The name is the whole of it: it becomes the pad label the chain feeding it is printed
with.

What that buys is that something can ask for the pad by name. A stream on the Write
stage is fed from `pad:<label>`, so a second video stream at a different crop is an
`overlay` branch ending in an output of its own and a row that names it — and a
recording writes one, which is above under [Capture](#capture). Rename it and
everything reading it moves with it; the identity is the node, and the name is what
ffmpeg reads.

It is a pad label, so the rules are ffmpeg's and each is refused on the node: letters,
digits and underscores only, because a filtergraph reads anything else as the end of
the name; not `vout` or `aout`, which would leave nothing to say which pad the
render's own picture comes out of; not the same name twice, which ffmpeg rejects as
*Label found twice*; and not fed straight from an `-i`, because `[1:v]` is a demuxer's
stream with no chain to put a label on the end of — one `null` in between is enough.

**Video out may then be left empty.** Once an output of that kind is fed, a graph
whose whole picture leaves by name is a legitimate graph and the stage stops asking
for the composite's pad. The stream list on the Write stage is where it is decided
what actually gets written.

### When it will not run

A graph you are half way through wiring is a graph that will not run, and that
is a normal state to be in — the moment between placing a node and connecting it
is exactly it. So the stage draws it and **says what is wrong on the node it is
about**: the card is outlined, the reason is on it, the column beside it says the
same thing with room, the bar along the bottom counts them, and the Graph card
on the spine reads `will not run` from whichever stage you are on.

What is refused, each naming the node:

| | |
|---|---|
| an input pad with nothing on it | `overlay has nothing wired to its input 2 of 2` |
| a pad read twice | `hflip's output is read by 2 filters — put a split in between` |
| an output nothing reads | `nothing reads split's output 2 of 2` |
| a picture wire in a sound pad | `a picture wire arrives at amix's input 2 of 2, which takes sound` |
| a loop | `these feed each other in a circle: hflip → vflip` |
| a filter this build does not have | `libavfilter in this build has no filter called "unsharpenator"` |
| nothing mapped | `nothing is wired to video out, so the render has no picture to write` |
| a wire on a pad that stopped existing | *see above* |

**A render is refused rather than approximated.** The command bar prints the
reason instead of a filtergraph, and the export goes through the internal
compositor *without your filters* and says so on the Encode stage — which is the
honest outcome, because the alternative is a file that succeeded and is not what
you asked for. Every one of these is a shape ffmpeg itself rejects; the whole
value of printing a command is that it can be taken elsewhere and run.

### Seeing what each node produces

A node card says what a filter is *set to*. What it does not say is what comes out
of it, which is the thing you actually want — `crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25`
is a claim about a picture, and a claim about a picture is either right or it is a
bug you find at the end of a render.

So every node on the picture side plays its own output, looping. **Drag the corner
of a card** to make it as big as helps, and the media fills it — and re-renders at
the new size, so a bigger card is a sharper picture rather than a stretched one.
The size is remembered per node.

These are real renders, not simulations: the graph is cut off at the chosen node,
ended with a scale that fits the card, and run through the same libavfilter path
an export takes. What a card shows is what that pad hands its consumer. The rules
that make it affordable are worth knowing, because they are what you will notice:

- **One at a time, and always behind an export.** There is one render slot. A node
  preview is the least important thing in the application and waits for everything
  else, so a nine-node graph fills in over a second or two rather than at once.
- **Nothing renders until the graph holds still.** Dragging a value walks through
  fifty of them; only the one you stop on is rendered.
- **Only what the node depends on.** Previewing the first filter of a two-clip edit
  opens one file, not two — and each input seeks to its own window, so a node on a
  clip forty minutes in costs the same as one at the top.
- **Taken from where the playhead was** when you opened the stage, not followed
  live. `At playhead` re-takes it; `Previews` turns the whole thing off.

`video out` gets one too — it is the pad the muxer maps, which makes it the one node
on the screen that means *the render*. Audio nodes have no picture, and show none
rather than a black rectangle.

### Playing a node

A couple of seconds on a loop answers "is the crop right". It does not answer "does
this hold up over a shot", which is usually what a filter is being judged on. **The
▶ in the corner of a picture** plays that node forward, from where the previews were
taken to the end of what would be written.

Every second of it is a real render, which is the whole point and also the
constraint: an expensive graph cannot be played at speed. So the range is rendered
in pieces, ahead of the picture, and each piece plays at its own rate. When the
renderer keeps up, that is real time. When it does not, the picture waits for the
next piece and the readout says what rate is actually being sustained — `0.42×`,
waits included. That number is a fact about your filter, and it is the reason
nothing here quietly drops frames instead: a smooth picture that had skipped nine
frames in ten would make a slow filter look fast.

Pressing play starts on the frame already in the card, because the still is the
first piece. One node plays at a time — there is one render slot, and two would not
be two playbacks so much as two stutters.

### When it is on

A filter does not have to run for the whole render. ffmpeg's timeline support is
one option — `enable`, an expression evaluated per frame — and the **When** strip
in the column beside the graph is where it is set: the render's range as a ruler,
the spans the expression describes drawn on it, and ends you drag. `Another span`
adds one; each span is `between`, `from` or `until`, with its moments in fields
beside it. The card carries the answer in one line.

**`enable` turns a filter on and off. It does not interpolate a value.** That is
a real limit and it is worth being plain about, because "keyframes" is the word
people reach for and this is not that: a blur that comes on at ten seconds comes
on at full strength. What ffmpeg *does* have for animating a value is expressions
in a filter's own options — `crop`'s `x` and `y`, `overlay`'s, `drawtext`'s, some
of them with an `eval` option choosing between once and per-frame — which are
evaluated every frame and genuinely do move. Those are reachable here as ordinary
option text and are not surfaced as anything better than that.

The strip is a **reading of the expression, not a copy of it**. It is parsed on
every draw and nothing is written until you drag or type, which is the same
arrangement the Quality slider and the advanced option editor have: one
mechanism, nothing to drift. The expression itself is in a field under the strip
and on the card, quoted — `enable='between(t,1,2)'` — because a filtergraph
separates filters with commas.

So an expression the strip cannot draw is **left exactly as you typed it**. It
can draw `between(t,a,b)`, `gt(t,a)`, `gte(t,a)`, `lt(t,b)` and `lte(t,b)` added
together, and that is all; `mod(t,4)`, anything written against `n` or `pos`,
arithmetic inside a span, or any of the rest of ffmpeg's expression evaluator
makes the strip stand down and say which part of it it gave up on. It does not
approximate and it does not rewrite.

**A filter with no timeline support is offered no control at all**, because
there is nothing for one to do: libavfilter checks the flag and refuses the
graph outright — *Timeline ('enable' option) not supported with filter 'scale'*
— rather than ignoring it. Which filters have it is read off the registry, so
there is no list here either. One set the other way, typed raw or moved onto a
filter that cannot take it, is reported against that node before the render
rather than after.

`t` is seconds into the render, measured from the start of the range — the same
clock the whole graph runs on, because every derived chain begins
`setpts=PTS-STARTPTS+offset/TB`. A filter spliced in *before* that, at a clip's
`after decode` point, sees the source file's own timestamps instead, and the
strip says so and rules itself in the source's seconds.

Playing the node (▶, above) is how you judge it: the readout over the picture
says `on` or `off` as the playhead crosses the boundary.

### Locks

Every value on a derived node can be typed into, and **typing into one locks
that node**. The skeleton around it still regenerates: move the clip, trim it,
crop it, and everything except the thing you set follows. A value you typed
that the next drag silently reverted is worse than the edit not applying,
because at least the second one is visible.

So every place that could disagree says which one won. The node is badged, the
Graph card on the spine counts the locks, the panel beside the graph says what
the lock outranks, and **the control it took over is marked in the properties
panel** — faded, with a dot, and a tooltip naming the node to unlock. `Unlock`
hands it back to the derivation.

A filter you insert and a value you lock are pinned to a **named point**
(`clip:7/after-scale`), never to a position, so they survive the rebuild. A node
you placed carries an id of its own, and a wire is written as the two pads it
joins — each named the same way, by anchor or by id — so hand-made structure
survives it too. They survive moving and trimming the clip; splitting a clip
copies the filters and the locks to both halves, because a cut should not change
how either half looks, and does *not* copy the wires, because an input pad holds
one wire and a copy of one would be a second producer arriving at a pad that
already has one. A clip trimmed out of the rendered range takes its nodes and
wires with it and brings them back; deleting the clip takes them for good.

They are remembered in `localStorage` between runs — there is no project file
yet, and this is now a good deal more than the first thing that makes one worth
having. A hand-wired graph is work in the way a slider position is not, and it
currently lives on one machine under one key for the whole application.

### What changes when there is one

A render with a filter of your own in it goes through **libavfilter** instead of
the internal compositor, and nothing has to be switched on for that: the spec
the application builds carries the graph, and `ffmpeg_export.cpp` picks its
`FrameSource` on whether that field is empty. The two paths are measured against
each other on every `ctest` run — the same edit rendered both ways, compared as
PSNR, 43 dB and holding — so this is a choice about what is *expressible*, not
about which is better.

Two consequences worth knowing. The command bar stops calling its filtergraph a
translation, because on this path it is not one: those are the chains
libavfilter parses, all but the last. And **the viewer cannot show you a
filter** — playback is the engine decoding the file straight into a `<video>`,
with no filter path anywhere in it. Clips carrying filters are marked `fx` in
the picture rather than left looking as though the filter did nothing; the
export preview is where you see what it does.

## Output

`Encode` and `Write` are two of the six stages on the spine — the row under
the title bar that *is* the pipeline: **Capture → Sources → Compose → Graph →
Encode → Write**. Each card says what its stage is currently set to, so the bar reads as
one statement of the whole render, and clicking the part that is wrong is how
you go and change it. `E` goes to Encode, `[` and `]` step along the chain,
`Esc` comes back to the edit.

Choosing an encoder setting means looking at what it does to the picture, and
the comparison that shows you is the whole point of the Encode stage, so it
gets the middle of the window: settings down the left, every option the encoder
has down the right when you want them, the range across the bottom. Where the
file goes is the *next* stage, because it is a different decision taken at a
different moment — you settle what the picture is by looking at it, and then
you say where to put it.

Everything the viewer is showing is what gets written: the track stack
composited bottom-up, each clip in the rectangle its fit, scale, position and
crop put it in, at its opacity, and the grid if the grid is on. The placement
rectangles the renderer works from are the ones `ui/viewer.js` computes, so
there is no second layout implementation to drift away from what you were just
looking at.

The encoders are the reason this repo is GPL, and they are all here:

| | |
|---|---|
| Video | x264, x265, AV1 (SVT / libaom), VP9, ProRes, MJPEG, MPEG-4 — plus NVENC, AMF and QSV when the build has them, and every muxer's own default encoder |
| Audio | AAC, Opus, MP3, Vorbis, FLAC, PCM |
| Containers | **every muxer this build links** — 182 of them |

The menu is built by asking libavcodec what this binary actually has rather
than from a list, so it cannot offer an encoder that then fails at the last
step. The same goes for what each encoder can do: its pixel formats, presets,
tunes, profiles and the range of its quality scale are read out of libavcodec's
own option tables, so the controls change with the encoder — x264 gets a CRF
slider from 0 to 51 and ten presets, VP9's goes to 63, ProRes gets its six
profiles and no quality slider at all, and NVENC gets `p1`–`p7`. Which
containers will hold a codec comes from `avformat_query_codec` rather than from
a table, so picking WebM narrows the codec list to the two that are legal in it.

**Start from** is the top row: six named starting points — web, small, HEVC,
ProRes master, GPU, lossless — each filtered against what this build has, and
the GPU one against what this *machine* has, so it is absent on a machine with
no card in it. Those are two different questions and the second one is the one
that matters here: a vcpkg ffmpeg carries every NVENC, AMF and QSV encoder
whether or not there is anything to run them on. Most renders are one of
these, and the twenty controls below are for the render that is not.

**Rate control** is offered as the modes the encoder actually has: constant
quality, a bitrate target, **two-pass**, a capped average for streaming
(`-maxrate` and `-bufsize`), and lossless. NVENC has no CRF, so its quality mode
is `-cq` with the bitrate target taken out of the way; x264's lossless is
`-crf 0`; VP9's is `-lossless 1`. That mapping lives in one function, so the
summary line, the preview and the export cannot describe three different
renders.

**Two-pass is a mode of that control and not a switch beside it**, because it is
the same decision — spend this many bits — taken twice. The range is rendered
once to measure where the bits are needed and once to spend them, and the
statistics go between the two through a file on disk, which is the only way
ffmpeg ever does it. It is one job here: one Stop, one progress bar, one file at
the end, with the bar saying which pass it is in — a render that is going to do
the whole thing again must not report 43% and leave the rest to be discovered.
A checkbox instead would have let you ask for two passes of *constant quality*,
which is two runs of an encoder that had nothing to learn from the first.

One thing about it cannot be promised, and is said where it is chosen: **whether
an encoder acts on `-pass` is the one capability libavcodec will not answer in
advance.** There is no flag for it and no option to ask about. So the control
does exactly what it says — it writes `-pass 1` and `-pass 2`, as the command
line does — and a render whose encoder kept its statistics somewhere else says
so in the report rather than pretending. x264 keeps its own log and is handed
the filename; everything else uses libavcodec's own statistics pair; which of
the two applies is asked of the encoder rather than looked up in a list here.

**Where the keyframes go** is a different question from how often, and the more
useful one. `-g` is the interval; `Force at` is the *places*:

| | |
|---|---|
| **Off** | whatever the GOP length produces |
| **Cut points** | one wherever the edit cuts — read from the timeline every time |
| **Times** | a list of seconds into the output |
| **Expression** | ffmpeg's own, evaluated per frame over `n`, `t`, `n_forced`… |

**A keyframe where an edit cuts is what makes a file that can be cut again.**
Every editor and every stream packager has to start a segment on one, so a cut
that falls in the middle of a GOP costs a re-encode of everything up to it.
Nothing is copied when you choose it: what is remembered is the *decision*, and
the list is re-read from the timeline whenever it is asked for — so moving a
clip moves the keyframe with it. A version that wrote the numbers down when the
button was pressed would go on naming moments nothing cuts at.

The times are seconds into the **output**, not into the timeline, which is what
ffmpeg means by them and what makes the printed command run somewhere else and
produce the same file.

Under Advanced, four more that are not encoder options and could not be reached
through the option column:

- **Frame timing** is *stated*, not chosen. This renderer walks the range
  forward at the output rate and stamps every frame with its number — both
  paths do — so `-fps_mode cfr` is a fact about it rather than a setting, and
  the command says so. A picker offering `vfr` or `passthrough` would be
  offering two things neither render path can produce.
- **Field order** — progressive, top field first, bottom field first. It is two
  statements that travel together: the encoder goes into field mode
  (`-flags +ildct+ilme`) *and* every frame is marked to match, because only the
  first writes a file that claims to be interlaced without being coded that way.
  What is composited here is progressive, so this is right for footage that was
  interlaced and has come through untouched, and a claim about the picture
  otherwise.
- **Threads** — `-threads` and `-thread_type`. Zero is all cores, which is what
  every render here has always done and remains the right default; this is for
  the render that has to leave a core alone.
- **Shortest** — end the file where the content ends rather than where the range
  does. Off by default: a range is a decision somebody made, and quietly writing
  less of it than was asked for is the wrong half of the trade.

**Every option the encoder has** is available under Advanced — both encoders,
the picture's and the sound's, in a column each with a search of its own. The
list is `av_opt_next` over the encoder's `AVClass` — name, type, range, default,
help text and named values, straight out of libavcodec — with a search box over
it. x264 reports 48 options here, x265 many more, `aac` 82. Nothing about them
is written down in this repo, so an ffmpeg upgrade that adds an option adds it
to the app.

This works because there is no private path from the controls to the encoder:
a Quality slider produces `{crf: 20}`, the raw editor produces `{crf: 20}`, and
both are applied with `av_opt_set(ctx, key, value, AV_OPT_SEARCH_CHILDREN)` —
exactly how the `ffmpeg` command line applies its own arguments. Anything
documented for `ffmpeg -c:v libx265 -x265-params …` works here unchanged. The
summary at the bottom shows the result as a command line, because that is the
shortest complete statement of what is about to happen. An option the encoder
does not have is an error, not a shrug: a render that succeeds while silently
ignoring half of what it was told is the worst of the three outcomes.

### Which container

The format control was four entries — MP4, Matroska, QuickTime, WebM — written
down in C++ beside a codec list that was genuinely asked of libavcodec. MPEG-TS,
MXF, AVI, FLV, GIF, image2, WAV, ADTS and a hundred and seventy others were
compiled into this binary and unreachable because of that one line. They are all
here now, and the picker is the shape the filter palette already uses, because
it is the same problem one stage later: **there is no list of the good ones
anywhere.**

A muxer is chosen **by name**, which is what `-f matroska` means and the only
thing that identifies one: nothing in libavformat is called "mkv", forty-seven
muxers have no extension at all, and several share one. The extension is a
consequence — what the file gets called — and it follows the choice.

What you can group a hundred and eighty by, all of it asked rather than decided:

| | |
|---|---|
| **Fits** | `avformat_query_codec` says it will hold the codecs this render is set to |
| **Files** | it has an extension and writes a file it opens itself |
| **Pictures** | an intra-only video codec and no audio codec at all — image2, gif, the single-frame writers |
| **Streaming** | `AVFMT_NOFILE`: it writes through a protocol rather than to a file |
| **Devices** | libavdevice's own, which only exist once `avdevice_register_all()` has run |

and a search over the name, libavformat's own description and the extensions —
so "mkv" finds Matroska even though nothing is called that.

**`avformat_query_codec` has three answers and only two of them are yes and
no.** A muxer with neither a `query_codec` function nor a codec tag table
returns `AVERROR_PATCHWELCOME`, which means *not taught to answer*. Over four
well-known containers that never came up; over a hundred and eighty it does —
MPEG-TS is one, and reading its shrug as a refusal is how a picker comes to
insist that MPEG-TS will not hold H.264. So it is carried through as itself:
nothing is filtered where it applies, the codec in hand is left alone, and the
row says *does not say*. A muxer that genuinely answers no still narrows the
codec lists, and the codecs it refuses are shown marked rather than hidden —
hiding them hides the reason the one you wanted is missing.

Beside the picker, **every option the muxer has**, in a column, exactly as the
encoder's are: `movflags`, `hls_time`, `mpegts_service_id`, plus libavformat's
generic ones, walked out of the muxer's own `AVClass`. They reach it through
the same `av_opt_set`-with-children route ffmpeg's own arguments take, and an
unknown key stops the render rather than being ignored. Changing the muxer
empties the bag, because `movflags` in Matroska is an error and not a carried
preference.

### Writing pictures

`image2` is the one muxer whose output is not a file but a *set* of them, and the only
thing that says which is which is the filename: `out%04d.png` is a run of pictures and
`out.png` is one picture written over itself on every frame. So picking image2 puts a
frame number in the name, and **Numbering** says which of the two you meant —
`A file per frame`, or `One picture`, which is `-update 1` and is not optional for a
single file.

Under it, **the names that will actually be on disk**. Not the pattern: `%04d` is
exactly the kind of thing somebody gets wrong once and then never trusts again, so the
panel shows the first few and the last, from `av_get_frame_filename2` — the same
function the muxer calls. `-start_number` is beside them, since a run does not have to
begin at one.

One PNG of the frame at the playhead is the degenerate case and is the fastest way to
get a still out of an edit: `One picture`, and a range of one frame.

**Here alone, the extension chooses the encoder.** `.png` is PNG data and `.bmp` is BMP
data through the same muxer, so image2's extension names a *codec* rather than a
container — the opposite of how every other extension in libavformat works. The
encoder follows the filename through `av_guess_codec`, which is what `ffmpeg` itself
does; without it every picture render lands on mjpeg, which is what image2 declares as
its default whatever the file is called.

### Where it goes

The other half of `Write` is the destination, and it stopped being a path.
There are four shapes and each says which it is:

| | |
|---|---|
| **one file** | what nearly every render is: opened now, closed when the render ends |
| **a set of files** | `image2`, `segment`, `hls`, `dash` — pictures, segments, chunks, and the playlist that names them |
| **a stream** | a URL through one of the thirty output protocols this build links |
| **several at once** | `-f tee`: one encode, several destinations |

**Which one it is, is asked rather than chosen.** There is no mode control here
and no list of segmenting muxers written down anywhere, because either would be
a second answer that could disagree with the first. `AVFMT_NOFILE` is
libavformat's own way of saying *I do not write the file you named me with* —
which is exactly what a segmenter, a playlist writer and `tee` all are — a frame
pattern in the name is what makes `image2` a run rather than one picture, and a
URL is a URL — except `file:`, which is the long way of writing a path and is
read as one, because that is what the renderer does with it. The muxer picker's
**Streaming** facet is the same query.

Each shape then gets what it needs and nothing else. A URL says which protocol
it names and **whether this build has it**, because a URL naming a protocol that
is absent fails at open with a message about a filename. Beside the muxer's
option column is the **protocol's own** — `srt` reports 38 here, `rtmp` about
twenty — and they travel in one bag, which is what libavformat does with
whatever a muxer does not recognise, exactly as the Sources stage does at the
reading end. A key neither of them has stops the render rather than being
ignored.

### Several destinations at once

`-f tee` is **one encode written to several places**. That is worth being exact
about, because "two outputs" can mean two different things and only one of them
is this: `tee` sends the *same packets* to several muxers, so a Matroska file
and an MPEG-TS stream carry the same bitstream in different wrappers, at the
cost of one encode. Two outputs at *different settings* is a different feature —
two encodes — and is not built.

The destinations are a list: a muxer, a target, and that destination's own
options. The `-f tee` argument is **built from the list rather than typed**,
and shown in full underneath it, because that argument is a small language with
two layers of escaping over it:

- `tee` separates destinations with `|` and reads each one's options out of
  `[ ]` on `=` and `:`, honouring a backslash — so a `|` or a `\` in a target,
  and a `:` or a `]` in an option value, have to be escaped. On Windows that
  means every backslash in a path is doubled, which looks wrong and is right.
- then the shell quotes the lot again, which is a second and completely
  separate layer, and is what the command bar's quotes are.

An argument assembled on your behalf is exactly the one that has to be visible,
which is why the list and the string are both on the screen.

**Recording and streaming the same capture** is this, and it is the case tee was
chosen for: one encode, one real-time deadline, a file kept and the same packets
sent somewhere else. The Capture stage takes a tee argument in its own path
field and says how many destinations it comes to; the editor for the argument is
on the Write stage, because a second copy of the escaping would be a second
answer to it.

### What comes back from each

Progress has to say something true for each shape, and they do not share a
sentence:

| | |
|---|---|
| **one file** | frames of a total, a percentage, a rate and an estimate |
| **a set of files** | all of that, and **how many files have arrived** — the only number that says a segmenter is segmenting |
| **a stream** | elapsed, frames, bytes **sent** and the bitrate they come to — no size, no percentage, no bar |

How many files is asked of libavformat rather than counted off the disk.
`AVFormatContext::io_open` is the callback every output goes through — the
primary file, each segment, each DASH chunk, each `tee` slave, each numbered
picture — and it is the seam ffmpeg's own CLI overrides, so the count, the names
and the sizes come for nothing and stay right whatever a muxer's numbering
scheme is. A file opened twice is one file, so an HLS playlist rewritten on
every segment is not counted forty times.

A stream has no size because there is nothing to stat, and the number reported
is what went through the socket. It is the same vocabulary a recording with no
`-t` uses — `openEnded`, and zero meaning nobody knows — rather than a second
convention.

**And "open the result" is a real question when the result is not one file.**
For `hls` and `dash` the answer is the playlist: it is the file that was named
and the only thing that says what order the pieces go in. For a numbered run it
is the first picture, because a run has no index and `out%04d.png` is not a name
anything can open. For a `tee` it is whichever destination is local. For a
stream there is **nothing** — what was sent has gone — so no button is offered,
because one that opened a socket would be worse than its absence.

**A destination can fail in ways a file cannot, and that is reported rather than
handled.** A port nothing is listening on is refused before the render starts,
naming the URL — *cannot reach 'tcp://…'* — rather than as the message about a
filename `avio_open` would have given. A connection that drops half way through
stops the render with the destination named and libav's own account of it
beside, in the report drawer, which is where a render says what it was told; a
disconnect is not a defect in this application and nothing here pretends
otherwise. What is deliberately *not* built is retrying: `-reconnect`,
`-rw_timeout` and the `fifo` muxer are what ffmpeg has for that and all three are
ordinary options in the columns beside the destination.

Two things about a destination are warned about rather than discovered:
`+faststart` on a stream, which rewrites the file after the trailer and cannot
be done to something that cannot be rewound — it fails at the end, after
everything has been sent — and a **keyframe interval longer than the segment
time**, which succeeds and quietly produces segments of the wrong length,
because a segment can only start on a keyframe.

### What is in the file

`Write` is the output's **stream list**: one row per stream the muxer will
number, in the order it will number them. A file is not a picture and a
soundtrack — it is a list of streams — and everything this application could
not say before followed from that list not existing.

A row reads as a statement rather than as a grid of labelled inputs:

> **A2** the mix, through `aac` — *fra · “Commentary” · forced · comment*

The usual two — the composite through one video encoder, the mix through one
audio encoder — arrive without anyone asking, because that is what nearly
every render is. `+ Video`, `+ Audio`, `+ Subtitle` and `+ Attachment` add one;
`×` takes one
away, including the last video stream, which is what a sound-only render is.
Everything a row does not say it takes from the Encode stage, so a second audio
track is one click and not twenty controls.

**A stream nothing feeds is not written, and the row says so.** Drop a file with
no audio track on the timeline and the mix has nothing to be made of — the
render leaves the stream out, which is right, and the row that would have
claimed it says it will not be written rather than describing a track that will
not be there. It stays on the stage, because adding a file with sound will use
it. The command bar prints `-an`, which is how ffmpeg spells the same thing.

**The first word of the row is where its content comes from**, and there are
two answers. The composite and the mix are made — the edit, composited and
summed, through an encoder. A **copy** is not made at all: it is one input's
packets, going into the file exactly as they came out, which is `-map 0:1`
and `-c:v copy`. Picking one changes the rest of the sentence, because a
copied stream has no encoder to choose: the codec in the file is the codec that
was in the input, so it is stated rather than offered.

## Subtitles

There are three things people mean by subtitles, they are three different
mechanisms in ffmpeg, and each of them lives where its decision is taken. Doing
that badly is the ordinary way an application ends up with a "Subtitles" panel
that quietly does one of the three.

| | |
|---|---|
| **A track beside the picture** | a stream in the output, which a player can turn off — a row on the Write stage |
| **Burned into the image** | a `subtitles` filter on the Graph stage, like every other filter |
| **A file on its own** | a render whose only stream is subtitles: extracting one, and converting the format |

### A file of cues is an `-i`

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

### A track beside the picture

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
track can be carried into a container that holds it, or burned into the
picture; asking for it as text is refused by name, before anything opens.
Which family a codec is in is libavcodec's own `AV_CODEC_PROP_TEXT_SUB`.

### Burning them in

`Burn it into the picture` on a subtitle input places a `subtitles` filter at
the point where the whole canvas is, and takes you to the Graph stage where the
node now is. **What it places is an ordinary node** — it is printed by the
command bar, it can be moved, configured and deleted, and nothing about the
render behaves differently because a button rather than the palette put it
there. A shortcut that produced something you could not then find would be
worse than no shortcut.

Burned-in subtitles *are* visible in this application, because a node preview
and the export preview are real renders. Playing the node is how you watch them
come and go.

One thing is escaped on your behalf and shown so that it is not a mystery: **a
filtergraph separates a filter's arguments with `:`**, so a Windows path with a
drive letter in it goes into `subtitles=` unusable and libavfilter complains
about an option named after half the path without ever mentioning the colon.
The path is written `subtitles=filename='D\:/media/cues.srt'`, quoted as well
because a filename may contain a comma and a comma ends the filter.

### Out on its own

A render whose only stream is a subtitle track has no canvas, no mix, no
encoder and no frame clock — the cues drive it. That is what extracting a
track is, and it is also what converting one is: `.srt` in, `.vtt` out, with
`-f webvtt` and a filename that ends in `.vtt`. The three formats everything
converts between — SubRip, WebVTT and ASS — are all muxers this build links,
and the picker shows them among the other hundred and eighty.

### What the viewer cannot do

**A soft subtitle track is invisible in the viewer, and always will be until
playback grows a path of its own.** bro's `<video>` decodes into an element and
there is no subtitle path anywhere in it — the same structural reason a filter
cannot be previewed there. The track is in the file and plays in any player;
what this application can show you is the render, not the timeline.

That is said on the Write stage, out loud, with the reason. Somebody who adds a
subtitle row, looks at the viewer, sees nothing and concludes the track was not
written is the failure this is against — and a fake overlay would be worse,
because it would then disagree with the render in every detail of position,
font and line breaking.

### A font travelling with the text

An ASS track names its fonts by name — `Style: Default,Arial,48,…` — and
carries none of them, so a player without that font substitutes one and every
line, break and position moves with it. Embedding the font is what `-attach`
is for, it is an **attachment stream** on the Write stage, and Matroska holds
them. An ASS row with no attachment beside it says so.

### Copying instead of encoding

Four things become possible and each of them is instant and lossless, because
nothing is decoded:

| | |
|---|---|
| **Rewrap** | the same packets in a different container |
| **Lossless cut** | a span of one input, byte for byte |
| **Replace the audio** | copy the picture, take the sound from the edit or from elsewhere |
| **Extract** | one stream on its own |

`Rewrap <file>` under the list is the short way to all four: it fills the list
with one copied row per stream of that input — picture, sound and cues alike.
**It is a shortcut and not a mode** — what it leaves behind is ordinary rows
with ordinary sources, so everything it decided is on the screen and can be
changed or undone a row at a time. Nothing on this stage behaves differently
afterwards. It leaves the container alone, which is the whole of the remaining
decision and is taken on its own control a foot away; a subtitle track the new
container will not hold is refused by name, with the row still there to be
switched from carrying it to converting it.

**A copy can only start at a keyframe**, and that is the one cost worth knowing
about the whole packet path. Open a copied row and the keyframes are drawn on
the input's own clock with the in-point against them: click a mark to cut
there, or type a time and read what it costs —

> the nearest keyframe at or before 4.20 s is 4.00 s — a copy can only start on
> one, so 0.20 s more than you asked for will be at the front of the file

with `Snap` beside it. Where they are is asked of the demuxer's own index,
which is instant for mp4 and Matroska; a container without one is read, and
the panel says which of the two happened and whether the list was cut short.
Every packet of a sound stream stands on its own, so a copied soundtrack starts
exactly where it is asked to and says so instead of drawing a strip.

**A copy conflicts with the edit, and every conflict is named rather than
ignored.** This matters more here than anywhere else on the stage: a render
that quietly dropped what it could not apply would succeed, and what came out
would be the input again.

| | |
|---|---|
| more than one clip | *the timeline has 3 clips and the picture is copied — a copy is one input's packets, so nothing stacked, cut or laid beside it will be in the file* |
| a filter on the graph | *the filters on the Graph stage do not reach a copied stream — it is never decoded, so there is no picture for a filter to work on* |
| a crop, or an opacity | *the packets go into the file as they are* |
| an output of a different size | *the output is set to 1920×1080 and the copied picture is 640×360 — a copy is not resized* |
| a container that will not hold the codec | refused by `avformat_query_codec`, with both named |
| a codec chosen on a copied row | there is no encoder to configure, so it is refused rather than ignored |
| the same container it came from | *this is a rewrap into the container the file is already in* |

The command bar prints `-map 0:1` and `-c:v copy`, and puts `-ss` and `-to`
**in front of the `-i`**. That position is the whole difference between a
lossless cut and a slow one: before the `-i` it is an input seek and the
demuxer jumps to the keyframe, which is why a copy starts there; after it, the
same word is an output seek — the whole file read and the front discarded,
slower and beginning on a frame nothing can decode. The bar says so under the
command.

Open a row and it says what the stream carries:

- **Language** — ISO 639-2, the one metadata key every player reads.
- **Name** — what a track menu shows.
- **Flags** — a toggle per disposition, and the list is libavformat's own:
  `default`, `forced`, `comment`, `hearing_impaired` and the rest, walked out
  of `av_disposition_to_string`. Several at once, because a track can be forced
  *and* a commentary.
- **Tag** — the fourcc, offered as the vocabulary the chosen muxer actually
  takes. `hvc1` and `hev1` are the same HEVC bitstream and only the first plays
  on Apple hardware, which is a decision worth being able to take and not a
  string anybody types from memory. A tag the container has never heard of is
  called out here rather than at `write_header`, where it arrives as "Invalid
  data found when processing input" with no mention of the tag.
- **Metadata** — anything else, as key and value.
- **Bitstream filters** — the packet chain, in the order it runs.

**A bitstream filter is neither an encoder nor a muxer**, which is why it lives
here rather than on the Encode stage: it works on packets that have already been
encoded, in between the two, and nothing it does costs a re-encode.
`h264_mp4toannexb` rewrites NAL framing, `hevc_metadata` edits the VUI without
touching a pixel, `dump_extra` repeats the parameter sets so a stream can be
joined mid-flight, `setts` rewrites timestamps. None of them is reachable
through any option table, and before this there was no `av_bsf_*` anywhere in
this binary.

It is drawn as the ordered list it is — a row per filter, numbered, with the
arrows to move one — because the order is the whole of the meaning:
`h264_mp4toannexb,dump_extra` and the same two the other way round are different
files. What is offered is narrowed to the codec this stream is actually encoded
with, out of each filter's own declared list, so the menu cannot offer something
the render will then refuse; a filter that declares no list runs on anything and
is always there. Each carries its own option table, in the column the encoder's
and the muxer's already use.

**An attachment is a row and a chapter is not**, and that is the shape of the
things rather than a layout choice. An attachment *is* a stream: it has an
index, it is what `-attach` produces, and the muxer writes it out of the stream
at header time — a font travelling beside a subtitle, a cover image. A chapter
has no index, nothing is mapped to it and no player shows it in a track menu;
it is a table beside the streams, so it is drawn beside them.

The preview is not part of this. Both halves of the A/B comparison, and every
node preview on the Graph stage, ask for the renderer's own default of one
video stream and one audio stream: they exist to show what something does to a
*picture*, and a second language track proves nothing about a wipe.

### The command

Under every stage, live, is the invocation. Not a summary line at the bottom of
one screen — the whole argument of this application is that ffmpeg should stop
being a thing you guess at, and that argument is made by never hiding what is
about to run. Open it and it lays the filtergraph out a chain per line; `Copy`
puts the whole thing on the clipboard, so a render built here can be taken to a
server and run.

It is **two kinds of statement and it is drawn as two**, because they are not
equally true:

- **Exact** — everything but the filtergraph. Those keys are literally what
  `av_opt_set` is called with, which is the same path the `ffmpeg` command line
  uses for its own arguments. Not a description of the render; the render.
- **Equivalent** — the composition. With nothing of your own on the graph this
  binary composites internally rather than building a filter graph, so the
  graph shown is a translation, and it is dimmed to say so.

Put a filter on the graph and the second line changes, because the claim
changes: the render goes through libavfilter and those are the chains it
parses. All but the last, which converts into the encoder's colour and is the
writer's job here.

Everything the stream list produces is printed: a `-map` per stream,
`-c:a:1`, `-metadata:s:a:1 language=fra`, `-disposition:a:1 +forced+comment`,
`-tag:v hvc1`, `-attach`. The index appears only when it has to — `-c:v` for
the file that is a picture and a soundtrack, `-c:a:0` and `-c:a:1` once there
are two, because unqualified the second would claim both. One thing on this
stage genuinely cannot be said as an argument: ffmpeg reads **chapters** from
an input rather than from an option, so a command that wrote them would need an
FFMETADATA file and a second `-i`. That is said out loud under the command
instead of being quietly dropped.

How good a translation was measured rather than asserted: render the same edit
both ways and compare. Naming every colour conversion is the difference between
24.1 dB and 39.1 dB — a visible cast, not rounding — which is why `probe()`
reports each source's colour tags and why they are threaded into the graph. One
difference cannot be closed at all: the renderer walks forward at a fixed output
rate and `overlay`'s frame sync picks by timestamp, so a 30 fps source in a
25 fps render gives the two different frames to composite. That is said out
loud, under the command, when it applies.

An edit the graph cannot express faithfully produces **no graph and a reason**
rather than an approximation. A command that is nearly right is worse than no
command, because the only reason to print one is that it can be run.

### What the render said

Under the command bar, and under every stage with it, is its counterpart: one
says what is about to run and the other says what came back. Collapsed it is a
line — *"The last render: 1 warning · 9 series · 207 samples"* — and `R` opens
it from anywhere.

Because until it existed, a render could tell you four things: how far along it
was, how fast, how big, and — only if it failed outright — one sentence. libav
had plenty more to say. An encoder that clamped a bitrate, a muxer that refused
a fourcc, a filter unhappy with its arguments: all of it went to a console
nobody sees, and a render that came out wrong left nothing to look at.

Two kinds of thing, because they are not the same kind of fact:

- **Messages**, levelled and attributed. `libx264` announcing the profile it
  settled on is a different statement from `mp4` refusing a tag, and the source
  is a column rather than a prefix so you can see at a glance which part of the
  pipeline is talking. Filtered to warnings and errors by default: a render
  that went fine says so in one line and takes up one line. `Everything` is the
  whole of what libav said, kept rather than discarded, for the render where
  the info line turns out to be the answer.
- **Measured**, which is what a filter found. `cropdetect`, `blackdetect`,
  `silencedetect`, `ebur128`, `signalstats`, `astats`, `psnr`, `ssim` and the
  rest of that family produce information rather than pictures, and libavfilter
  hands it over by hanging it on the frames. So a value is not a log line, it
  is a *series*: a named quantity sampled at the timestamps of the frames it
  came off, drawn as the line it is. Put one of those filters on the graph and
  what it measures appears here, frame by frame, while the render runs.

Nothing is cleared when a render ends. The messages matter most once it is
over, which is why they outlive the job — and why the Write stage's progress
panel, under a green bar, says how many warnings there were and takes you
straight to them. A file that is not what was asked for, reported as a success,
is the failure this whole channel is against.

### Measuring, and doing something about it

A whole family of libavfilter's filters answers a question rather than changing
a picture. **There is no list of them anywhere in this application**, because
what distinguishes one is not its name — it is that it emits frame metadata or
logs, and both are captured from every filter on the graph. Put any of the four
hundred and eighty-eight on and what it says arrives.

**Starting one is a filter on the graph, and stays that.** The Report drawer
offers `Crop`, `Black`, `Scenes`, `Freezes`, `Levels`, `Silence`, `Loudness` and
`Sound levels` — each a shortcut to a gesture the Graph stage's palette already
makes, which is why the node appears on the graph and in the command bar
afterwards. What the shortcut adds is knowing *where* it goes and which of its
options make it answer at all: `ebur128` says nothing whatever without
`metadata=1`, and its true peak needs `peak=true`, which is not a thing anybody
should find out by getting an empty report.

`Measure now` runs it. That is a real render — the graph, the range, the same
`buildSpec()` every other render here goes through — with the output thrown
away: `-f null -` through an encoder that encodes nothing. It costs the decode
and the filters and leaves no file, because rendering something nobody wanted in
order to find out what a filter thought of it is most of a reason not to bother.

**Reading it is a plot.** Click a series and it opens over the render's range:
axes, a hairline grid, up to six lines against each other, a crosshair that
reads every value under the pointer, and a click that takes the playhead to that
moment. Colours are taken in a fixed order and then *remembered*, so taking one
line off never repaints the rest. Series that do not share a scale are
normalised, and the axis says so — there is deliberately no second y-axis, since
the alignment of two scales is arbitrary and invents a correlation that is not
in the data.

**Acting on it is the point.** A measurement that can only be read is a number;
one that can be applied is a tool. Each is parsed, and then either offered or
*refused with a reason* — never quietly approximated:

| | |
|---|---|
| `cropdetect` | **the crop it found**, put on the graph straight after the filter that measured it, carrying the four numbers exactly as `cropdetect` printed them |
| `ebur128` | **`loudnorm`'s measured parameters** — integrated loudness, range, threshold and true peak, which is ffmpeg's own two-pass loudness normalisation and the only version of it that is not a guess |
| `blackdetect`, `silencedetect`, `freezedetect`, `scdet` | **cut points on the timeline**, one at each end of every span |

The line each number was read out of is on the card, for the reason the command
bar prints the invocation: a number handed over without its source has to be
taken on trust.

The refusals matter more than the offers. A `cropdetect` still finding letterbox
in the last third of what it saw is refused *naming both answers* — a crop from
a filter that had not settled is a shot with its edges taken off and it looks
exactly like a crop that worked. An `ebur128` that has not reached the end of
its input has no summary, because that is the only place it prints one, and
normalising to a number that is going to change is worse than not normalising.
A picture that reaches every edge of the frame is offered no crop and says why,
which is an answer rather than a missing button.

### What the settings cost, as a number

The A/B stage renders the same seconds twice, at the chosen settings and
losslessly. That is a *distorted* input and a *reference* sitting on disk with
nothing else to do — which is exactly what every objective quality metric is
defined on. So a third render compares them, and under the wipe is

> **measured** PSNR 43.62 dB · SSIM 0.9912 — *against the lossless half*

Which metrics are available is asked of libavfilter rather than written down:
`psnr` and `ssim` are in every build, `libvmaf` is a `--enable-` and this build
does not have it. The comparison is on the very files the wipe is showing, so it
cannot be describing a different render; the answers arrive through the same
channel `cropdetect` uses, as series, so the frame where the encode fell apart
is a place you can point at on a plot.

**The number is the whole comparison and not a frame of it.** `psnr` and `ssim`
hang a value on every frame they pass rather than a running total — a frame at
the top of a GOP scores several decibels above what follows it — so the figure
under the wipe is every frame combined, the way each filter combines them at end
of input: PSNR over the errors, because a decibel is the logarithm of one and
averaging decibels lets a handful of easy frames drown out the frames somebody
choosing a setting is actually looking at.

### Preview

The hard part of encoding is not finding the settings, it is knowing what they
cost. `Render preview` encodes a few seconds — 1 to 10, from wherever you were
looking — at the exact settings, *and* the same frames losslessly, and lays one
over the other with a wipe you can drag. The lossless one is what the
compositor produced before any encoder saw it, so the difference on screen is
what the settings cost and nothing else.

Underneath it: what those seconds weighed, the bitrate they came to, and the
size the whole render extrapolates to — which is the number the summary then
quotes, because a measurement beats an estimate. Also how fast it encoded, and
therefore how long the whole thing will take.

It plays, and the two halves run together to the frame — banding crawls and
grass smears, and neither shows on a still. `Space` starts and stops it, the
arrows step a frame at a time, and the scrub bar under the picture goes
anywhere in it; both sides are seeked to exactly the same frame, because a wipe
between two moments a fraction of a second apart shows the movement between
them rather than what the encoder did. The timecode is the **timeline's**, not
the little preview file's, and a marker runs along the range strip below — so
the frame you are looking at is one you can go back and find on the edit.

Changing the quality re-renders only the candidate; the reference is of the
same frames and does not move. Changing the size or the edit invalidates both.
Both files go to a temp directory and are overwritten each time — the lossless
one is large, on the order of 15 MB per second at 720p.

**Range** is the strip across the bottom: the whole edit with a ruler over it
and one bar per track, the part being written picked out. Drag its ends to
write part of the timeline, and drag the lane beneath to move where the preview
samples from.

**Sound** is mixed, not picked from: every clip under the playhead contributes,
at its own level and mute, summed and clamped. A clip's in-point is honoured to
the sample — a seek lands on a packet boundary at or before the target, and
what is between the two is dropped rather than played.

**Colour** is converted rather than reinterpreted. Sources are decoded through
their own matrix (BT.709, BT.601, BT.2020 — whatever the file says, or what its
size implies when it says nothing), and the output is tagged to match what was
actually written, so the result does not come back a little green.

The render runs on its own thread: the UI keeps drawing, the progress bar has a
frame count, an encode rate and an estimate, and `Stop` stops it. A stopped
render still closes its file properly — a half-written MP4 with no index plays
nowhere, so the part that was rendered is left playable. When it finishes, one
button puts the result back on the timeline, which is the fastest way to see
what you just made.

Rotation is applied here: a phone clip that was shot upright is written
upright, from the container's display matrix.

## The card

There is no "use hardware acceleration" checkbox, and that is a finding rather
than an omission. **Decoding on a card and encoding on a card are two different
decisions with opposite answers on this machine**, so they are two controls in
the two places they belong: the device an input decodes on is on Sources, in
front of the `-i` beside `-probesize`, because a decoder belongs to an input;
the encoder a stream is written with is on Encode, because that is what a stream
is. One switch covering both would be wrong about half of what it did.

What the menus offer is what this machine turned out to have. `bro.ffmpeg
.hwaccels` lists what the *build* has — every type a vcpkg ffmpeg is compiled
with is in it on every machine, card or no card — so nothing is drawn from it.
`bro.ffmpeg.hardware()` creates a device of each type and reports whether that
worked, and the picker is cut down again by whether this build's decoder for
*this codec* has a configuration for that device. Two RTX 4090s still do not
give you a CUDA ProRes decoder.

That question is asked by *failing*, so it is asked with the report channel
muted. Every type the build carries and this machine has no card for answers
with an error — on a machine with NVIDIA cards, `AMFQueryVersion failed with
error 1` — and those are not things a render said: left in the channel they
open the report drawer red under a render that went perfectly, before anybody
has pressed anything. What the failure was is reported as the device's own
`error`, which is where somebody asking about a card is already looking.

**Unavailable refuses, and says why. It never falls back silently.** A type that
is compiled in and absent, a driver that will not answer, a codec the card
cannot decode: each stops the open with the reason named. That is this repo's
standing rule — a render must not succeed while ignoring what it was told —
and here it has a second edge, because on this hardware falling back to software
would make the render *faster*, and nobody would ever notice it happening.

### What it measured

`tests/hardware_test.cpp`, on this machine: **AMD Ryzen 9 7950X3D (16 cores, 32
threads) and two NVIDIA GeForce RTX 4090s**, driver 610.62, vcpkg ffmpeg with
`nvcodec` and `amf`. Four device types work here — `cuda`, `dxva2`, `d3d11va`,
`d3d12va` — and `amf` does not: AMF is compiled in and there is no AMD card.

One pass over a file, `nextRaw` a frame at a time, milliseconds per picture:

| | 640×360 | 1920×1080 | 3840×2160 |
|---|---|---|---|
| software, threaded across all cores | **0.05** | **0.35** | **1.70** |
| cuda, brought back to system memory | 0.29 | 1.21 | 4.51 |
| cuda, left on the card | 0.29 | 1.17 | 4.38 |

**Hardware decode is a loss here, by between two and six times, and the readback
everybody blames is not the reason.** Bringing a 4K frame down costs 3% of the
decode's wall clock; the decode itself is what is slow, because NVDEC is a
throughput engine being asked for one frame at a time while libavcodec has
thirty-two threads and frame-level parallelism. It is offered anyway — a laptop
with four cores and a QSV block has different numbers, and it is the only way to
feed a hardware filter graph without an upload — but the **Decode on** picker carries
the measurement, so it is said on the control somebody is about to use.

The encoder is the opposite answer. The same 1.6 s of output, rendered three
ways at the source's own size:

| | 640×360 | 1920×1080 | 3840×2160 |
|---|---|---|---|
| decode + composite + x264 `ultrafast`, all in system memory | **56 ms** | 453 ms | 1848 ms |
| decode on the card, filter on it, NVENC, never coming down | 96 ms | **205 ms** | **565 ms** |
| decode on the CPU, upload, NVENC | 85 ms | **190 ms** | 591 ms |

**Above SD the card is worth two to three times, and below it the card loses
outright** — 4K is 3.3× and 640×360 is 0.6×, because a small frame is all
fixed cost and a GPU round trip is mostly fixed cost. Note the third row: on this
machine the *best* arrangement at 1080p is a software decode uploaded straight
into NVENC, which is what falls out of hardware decode being the slower half.
And note that x264 is on `ultrafast` throughout — at `medium` the gap widens by
a great deal more than these numbers show.

### Never coming down

A render whose pictures are made on a card and encoded on the same card does not
touch system memory at any point. It is not a special path: `FrameSource` grew
two optional questions — which pool the pictures arrive in, and the picture
itself rather than a canvas — and a hardware encoder is *opened against that
pool*, so `avcodec_open2` builds its surfaces from the graph's own. Everything
else about the job is unchanged.

Which means the arrangement is reachable by wiring it. Put an `hwupload` on the
last wire before the output, choose `h264_nvenc`, and the render has nothing to
copy; the command bar prints `-filter_hw_device cuda` and the `hwupload` in the
graph, and a standalone ffmpeg given that command does the same thing. It is
all-or-nothing per file: a render that kept its pictures up and had one software
video stream in it is refused, naming the stream, rather than downloading behind
your back.

Two consequences worth knowing. A render on this path **ends when its graph
ends** — there is no black frame past the last picture, because black would have
to be made in system memory and uploaded once a frame, which is the cost the
path exists to avoid. And the **viewer cannot show a clip whose input keeps its
pictures on the card** in the way you might expect: playback downloads every
frame unconditionally, because bro's renderer takes three planes it can read and
there is no path in playback that could hand it a device handle.

### Filters on the card

`hwupload`, `hwdownload` and whatever `_cuda` / `_qsv` / `_vulkan` / `_d3d11`
filters this build has are ordinary nodes on the graph — the palette offers them
because it offers whatever libavfilter reports, and there is no list of hardware
filters written down anywhere. The device they get is `-filter_hw_device`, and
it is derived rather than asked for: an input that decodes on a device names one,
a filter that belongs to a device names one, and `hwupload` takes no argument
that could name a third.

**A picture on a card reaching a filter that reads pixels is libavfilter's least
readable failure** — four hundred pixel format names, twice, and nothing in it
saying the word hardware. The Graph stage names the node and says which way to
cross. And a clip whose input keeps its pictures up gets an `hwdownload` at the
head of its chain from the derivation, because that is exactly what the
compositor does with one, and the printed command and the render have to agree.

Worth knowing about builds: **a vcpkg ffmpeg with `nvcodec` gets NVDEC and NVENC
and not the `scale_cuda`/`overlay_cuda` family**, which needs the CUDA compiler
at configure time. So this build can decode on the card and encode on the card
with nothing at all to put between them — and a picture still never has to come
down, because `trim` and `setpts` are arithmetic on timestamps and pass any
format through.

## Keyboard

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` `→` | step one frame (hold `Shift` for one second) |
| `J` `L` | shuttle down / up through the speed list |
| `K` | pause |
| `Home` `End` | go to start / end |
| `M` | mute |
| `F` | fullscreen (`Esc` leaves) |
| `+` `-` `0` | zoom the timeline in / out / to fit |
| `C` | crop handles on the picture (`Esc` leaves) |
| `S` | split the selection at the playhead |
| `G` | grid / stacked layout |
| `E` | the Encode stage (`Esc` goes back to the edit) |
| `D` | the Capture stage — a device, watched and recorded |
| `I` | the Sources stage — what is actually in the files |
| `R` | what the render said — messages and what filters measured |
| `N` | the Graph stage — the edit as a filtergraph (`0` fits it) |
| `[` `]` | one step back / forward along the pipeline |
| `Space` `←` `→` | on the Encode stage: play / pause and step the comparison |
| `Ctrl`+`A` | select every clip (`Esc` narrows back to one) |
| `Delete` | remove the selection |

## Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own media — two files with known content, a moving bar over a
gradient and a tone at a known level, differing in size, aspect, frame rate and length,
and a third with **no audio stream in it at all**, which is not the same file as one
whose soundtrack is quiet and is the only thing that separates "the mix" from "a mix
nothing feeds" — and runs every suite against them. Two more are each about a stream
the rest take for granted: one with **no video stream in it at all**, the mirror of
the silent one and the only thing separating the composite from a composite nothing
feeds, and one whose pictures carry a **display matrix**, which is the only thing
separating a clip laid out upright from one laid out on its side. Neither can be
faked with content: a picture that happens to be black is not an absent one and a
picture that happens to be tall is not a rotated one. Nothing is checked in and
nothing depends on what a file you happened to have lying around contains.

Each suite also runs standalone against any real file, which is how to check behaviour
against footage the fixtures do not resemble:

```
./build/Release/ffmpeg-bro-decodetest <file> [--rotated <file>] [--sound-only <file>]
./build/Release/ffmpeg-bro-exporttest <file> [<file2>] # renderer: geometry, opacity, mix, cancel
./build/Release/ffmpeg-bro-captest <file>            # muxers, demuxers, protocols, devices, decoders
./build/Release/ffmpeg-bro-inputtest <file>          # an -i: forced demuxer, options, window, token
./build/Release/ffmpeg-bro-seqtest <fixture-dir>    # sequences, stills, -stream_loop, concat, image output
./build/Release/ffmpeg-bro-capturetest out         # devices: an endless input, recording one, and a session of several
./build/Release/ffmpeg-bro-hwtest <file>           # the GPU: what is here, is it the same picture, what does each path cost
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>] [<rotated>] [<sound-only>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sources.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_hardware.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sequence.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file> [<video-only>] [<sound-only>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_report.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_measure.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_subtitles.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_capture.js       # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js   # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js         # needs no media
```

`hwtest` has the same problem one further on: **CI has no graphics card**, and
unlike a camera there is no `lavfi` to stand in for one. So it splits what the
other suites do not. The assertions run everywhere and are about the *shape* of
the answer — enumeration answers something, a type reported present can be
created and is shared rather than remade, a type reported absent refuses with a
sentence, a codec the device cannot decode is refused before a packet is read —
and every one of them is reachable on a machine with nothing. The numbers are
*printed and never asserted on*, because a threshold on them would be a
statement about the machine rather than about the code; where they belong is
this README, beside the name of the hardware they came from.

The one equivalence check is worth its own note. **A hardware decoder is not
bit-exact with a software one and is not required to be** — NVDEC and the CPU
implement the same standard and differ in rounding and in deblocking arithmetic,
all of it within what H.264 permits — so what is asserted is a PSNR floor of 40
dB. Two conformant decoders of one bitstream land in the forties; every mistake
that could be made here (a frame out of step, a plane swapped, a download that
lost the colour tags) lands under twenty. There is a great deal of room between
those and the threshold sits in it.

`capturetest` and `ui_capture.js` have a problem the others do not: **CI has no
camera.** The vehicle is `lavfi` — libavfilter's *input device*, `-f lavfi -i
testsrc=size=320x240:rate=25` — which is a device in exactly the way gdigrab is
(registered by `avdevice_register_all()`, opened by a forced `-f`, reporting no
duration, never ending) and is openable on any machine. It is **not** the same
mechanism as a source filter inside a filtergraph, which the Graph stage also has:
`testsrc` as a *filter* is a node with no input pad, and the lavfi
*device* wraps a whole graph up as a demuxer so libavformat can read it as an `-i`.
Two different places in the pipeline spelt almost identically.

Being the vehicle makes it worth one assertion of its own: the card's `<video>` is
required to reach a picture **1280 wide**, which is a claim about the crossing rather
than about the UI. lavfi's packets are still `wrapped_avframe` — the probe is asserted
to say so — so what changed is that such a frame now survives the trip into the
engine, and a preview that came back empty would fail here rather than be worked
around with a refusal on the card.

The machine's real devices are asked about as well, and whatever the answer is it is
*asserted* rather than skipped: gdigrab is either in this build or it is not, and if
it is then opening it either produces frames or says why it did not. A test that
quietly passed because it found no camera would be worse than no test. On Windows
with a desktop session, gdigrab opens — including headless — so what runs here is the
real screen grabber.

A **session** — several devices at once — needs one thing more from the vehicle:
a lavfi input produces as fast as it can be read, and two of them free-running
would exercise none of what several inputs are about. So the session sections
pace each one with the `realtime`/`arealtime` filter, which is what makes the
wall clock the thing under test rather than a formality, and they skip by name
where a build has not got it. What they assert is what several inputs added:
that two pictures composited by the graph both reach the file, that two sounds
mixed by it do, that a session of picture and sound together lines up, and that
the refusals fire — several inputs with no graph, and a device that produces
nothing failing the job naming itself rather than waiting for ever.

`ui_player.js` drops real files on the real UI, plays them, scrubs, steps to the
last picture in the file, zooms the timeline, moves and deletes a clip, scales
and crops the picture, works the controls, and screenshots the viewer into
`out/`. Pass a second file to exercise the multi-clip transport. It also checks
the control strip's geometry — that every icon button drew its icon, that the
transport buttons are one width, that the transport is on the window's centre
line and the zoom controls on the timeline's left edge — because a mistyped
icon name or a stray width breaks none of the behaviour and all of the look.

`ui_subtitles.js` is the three things people mean by subtitles, each of which is
a different mechanism: the cue file arriving as an `-i` and being recognised
from what libavformat found in it, the stream row that carries or converts it,
the container narrowing the codec menu, the command bar printing the `-i`, the
`-map` and the `-c:s`, and the burn-in placed as an ordinary node with its path
escaped the way libavfilter needs it. It renders both and reads the results
back, because a subtitle track that is described correctly and not written is
the failure worth catching.

The fixture generator writes `cues.srt` and `cues.ass` beside the video, with
the cues placed so that a burn-in is **measurable**: a second of picture with
nothing over it, a second with a line over it, a second with nothing again. The
export suite renders the same seconds with the filter and without it and
compares them at both moments — 99 dB apart before the cue and 31 dB during it.
Either half alone proves nothing, because a filter that did nothing passes the
first and a filter that ruined every frame passes the second.

`captest` is what this build can write, read, reach and capture, and it prints
as much as it asserts: how many muxers, which of them write pictures, which
protocols are in and out, what capture devices the machine has. The numbers
are printed rather than demanded, because how many muxers a build has depends
on how it was configured; what is asserted is the *shape* — that a muxer's
extensions are split rather than handed over as one string, that the name a
picker puts in `-f` is the name libavformat answers to, that an option table is
the muxer's own and not the last one asked for — and then it renders into
Matroska and MPEG-TS by name and opens what came out, because a picker over a
hundred and eighty is only worth having if what it offers can be written.

`inputtest` is what an `-i` is: a demuxer forced and a name this build does not
have refused, an option reaching the demuxer and an unknown one stopping the open
with the key named, `-ss` and `-t` moving the input's own clock — checked in
pixels, by asking a seeked reader for its zero and an unseeked one for the same
moment — and the token bro's media backend opens a registered input by.

`seqtest` is the inputs whose content is assembled, and most of what it asserts
is what the grouping *refuses*: a lone numbered file is a still, a folder of two
runs and a stray picture is two sequences, and an unpadded run crossing from one
digit to two is one input rather than two. Then that a sequence's length is its
`-framerate` and nothing else, that a still probes as no time at all and is as
long as its `-t` and no longer, that `-stream_loop 1` is twice through and then
the end, that a concat list with no durations in it reports none — and the round
trip, since what the writer means by a sequence and what the reader means by one
have to be the same thing or every half of this works alone and none of it works
together.

`ui_sequence.js` is the same subject from the drop inwards: twelve files becoming
one `-i` with its options printed in front of it, a still that plays because it
is held and is refused when it is not, a sequence played through the same
`<video>` everything else uses, and the Write stage listing the filenames a run
will be written as before anything is rendered.

`ui_sources.js` follows one input the length of the stage: typed in as a path
with no clip near it, forced to a demuxer picked out of libavformat's own list,
given `-probesize` out of the option column, given `-skip_frame` out of the
*decoder's* column beside it — a separate bag, because a decoder is a separate
object with a separate table — cut to a two-second window, used on
the timeline, and then found in the spec with the clip pointing at it by index —
and every one of those printed by the command bar **in front of** its `-i`,
because the same words after it are output options meaning something else. It
also adds a URL, to check that it survives as written rather than being resolved
against the document, that the protocol is named, and that its own option table
is offered.

`ui_capture.js` follows a device the length of the stage: chosen out of
libavdevice's list, its option set from its own table and printed in front of its
`-i`, `-t` printed in front of it too (after the `-i` it would limit the output
instead), a recording started with no end that says so and offers no percentage,
every other stage refused while it runs, and then stopped — which is `done` and not
`cancelled` — leaving a file that probes and lands on the timeline. Then the same
with a `-t`, which does have a percentage and ends by itself. It also lays a device
on the timeline and requires the refusal, drags a region on the live screen and
checks the numbers it becomes are in the screen's pixels rather than the card's — and
that a drag off the edge is clamped, because an unclamped rectangle is one
libavdevice refuses at the open — and asserts that leaving the stage gives the device
back.

The session half adds a second input and follows what changes: the card and the
column that say which input they are about, the refusal at two inputs with no graph
asserted **twice** — once as the disabled button and once from `record.start`, so
that a button which stopped asking would still be caught — and then the graph, built
the way a person builds one: two `addSource` calls naming the devices' input ids, an
`hstack` placed, three wires. Nothing in that sequence knows what a recording is,
which is the point of it. What is asserted off the other end is the chain
(`[0:v][1:v]hstack=inputs=2[vout]`), the pad it is mapped by, two `-f`/`-i` pairs and
one exact `-filter_complex` in the command bar, and then a real recording of two
paced lavfi devices whose file comes back **640 wide from two 320-wide pictures**.
That last number is the assertion worth having: nothing but the graph could have
produced it, so a session that quietly recorded one device would fail rather than
pass with a plausible file.

The **composition preview** is asserted the same way and before any file exists: the
picture below the cards has to be exactly twice the width of the picture on one of
them. Measured against the card rather than written down, because the two are made of
the same devices and a constant would only say whether somebody had edited the test.
The session behind it is asked directly too — three pads over two `-i`s, two of them
devices — which is the assertion that one open per device is what is actually
happening rather than what is intended.

Then the states either side of a graph that works. Widening the `hstack` to three
inputs leaves a pad nothing arrives at, and that is a *refusal* — the button goes
dead, the stage names the empty pad in the Graph stage's own words, and the command
bar prints no `-filter_complex` at all rather than a line that cannot be run.
Releasing an input takes the node reading it with it, which leaves the same refusal
from the other direction. Clearing the graph is the third state and the commonest:
`recordGraph` answers null, which is not a broken graph, and one device is written as
it comes.

Which pad the recording writes is followed through the whole gesture. With no output
of its own the graph offers no choice and there is **no picker** at all; placing one
and moving the `hstack` onto it puts a two-option picker on the stage, and until it is
picked the recording still writes the now-unfed video out and says so — the refusal
naming the choice rather than quietly following the wire. Picked, the same chain runs
and comes out ending in `[vout]` with the name it has on the stage appearing **nowhere**
in what runs, which is the relabelling asserted rather than assumed. Deleting the
output from the Graph stage drops the recording back to video out and takes the picker
with it, because nothing on that stage knows a recording was pointed at it.

`ui_filtergraph.js` needs no media at all: `buildSpec()`'s output is a plain object and
the translation into a filter graph is a pure function of it, so the graph is checked
against specs written out by hand — including the edits it must refuse rather than
approximate.

`ui_graph.js` needs none either, and watches the graph from inside rather than
through the string it prints: the model, the printer's chain rule on shapes the
derivation does not produce, and the whole of what makes an edited graph
survive a rebuilt one. A filter lands on the wire it names and takes the pad
name with it; two at one point run in order; a lock outranks the timeline and
reports which control it took; a lock that happens to agree has outranked
nothing; a split copies both halves' filters and a delete takes them away; and
the run graph differs from the printed one by exactly one chain with the
inserted filter in both.

`ui_measure.js` is the half above that: a measurement started, run, read and
acted on. It clicks `Crop` and finds `cropdetect` on the graph and in the
command the bar prints; runs `Measure now` and finds the series on the render's
own clock; opens a plot and checks that taking a line off does not repaint the
one left; applies the crop and finds a `crop` node at the anchor the
measurement was taken at, carrying the characters `cropdetect` printed. Three
sections are written against **hand-made channel records**, the way
`ui_filtergraph.js` is written against hand-made specs — parsing what a filter
said is a pure function of what it said, so a `cropdetect` that has not settled,
an `ebur128` with no summary and a `blackdetect` that found two stretches can be
stated exactly rather than hoped for out of a fixture. The cut those spans
produce is then made on the real timeline through the real split. Last, the A/B
comparison is rendered and measured, and a better setting has to measure better
— the one check that says the number is about the encoder rather than about the
plumbing, and beside it that the score was combined from more than one frame,
which is what says the channel had actually been drained when it was read.

`ui_report.js` drives a render the renderer has something to complain about —
a graph running at half the output rate, with `cropdetect` measuring on the way
past — and follows what it said from `av_log` inside libav to a line on screen:
that the drain runs off the frame loop without anyone asking, that the warning
is visible and attributed, that the whole of libav's chatter is kept and merely
filtered, and that what the filter measured arrives as a named series sampled
in order rather than as more log lines.

`exporttest` also covers where a render *goes*, which stopped being one file: a
`segment` render writing four .ts files and an m3u8 that names them, every name
in the playlist checked against the disk and the playlist opened back as one
piece of media of the whole render's length rather than one segment's; the same
through `hls`, where the playlist is the thing you name and the segments are the
pieces; a `tee` whose two destinations receive the same forty packets, one of
which decodes to the render in the rectangle the clip was given; and a **real
network destination** — a UDP socket bound on the loopback in the test process
*before* the render starts, because writing to a port nobody is on succeeds
silently whatever is wrong underneath. What arrives starts with an MPEG-TS sync
byte, and the render reports what it sent rather than a size. `capturetest`
records through a tee, since a recording is a device into the same `Writer`.

`exporttest` also covers the four things on the encode side that are claims
about bytes: a real two-pass encode at a bitrate target, which has to write its
statistics where `-passlogfile` said, come out a different size from one pass
and land closer to the target; a bitstream filter, checked by finding a level in
the written SPS that the encoder did not put there; forced keyframes, read back
out of the file's own packet flags rather than taken from the encoder, with a
GOP longer than the render so that every keyframe past the first is one that was
asked for; and `-shortest` stopping where the content does. Each refusal is
checked too — a pass 2 with no statistics, a bitstream filter this build lacks,
an option it does not have, an expression that will not parse, a decoder option
no decoder takes.

`exporttest` renders a timeline and then opens what it wrote, which is the only
way to check the things nobody can see until the render is over: that a clip
lands in the rectangle it was given and the rest of the canvas stays black,
that opacity is a blend and not a switch (half of a picture over black is half
as bright, whatever the picture is), that overlapping clips are summed rather
than picked between, and that stopping half way still leaves a playable file.
`ui_export.js` drives the Output workspace and checks the join above it — that the spec
it builds is the edit that is on screen, that every control turns into the
ffmpeg option it claims to be (and that a raw option beats the control setting
the same key), that the advanced editor's list is libavcodec's, that both
halves of the A/B preview render and land on identical pixels, and that the
file that comes out can be dropped straight back on the timeline. It also
drives the Write stage's stream list: a second audio track added, given a
language, a name and two flags at once, and then rendered and opened to find
both tracks in it — and every one of those printed by the command bar, because
anything reaching the muxer the bar does not print is a bug. And the muxer
picker: that the default group is only muxers `avformat_query_codec` said yes
to, that searching reaches the other hundred and forty by name, by libavformat's
description and by extension, that picking MPEG-TS sets `-f mpegts` rather than
a filename somebody hopes will be guessed, that a muxer which never answered
does not have the codec taken off it, and that the muxer's own options reach
the spec, the command and a file that opens as an MPEG-TS.

And where the render goes: that the shape of a destination is *asked* — a URL
is a stream because of its scheme, `segment` is a set of files because it says
`AVFMT_NOFILE`, a frame pattern is a set because the numbering is in the name,
and `C:/` is a path and not a protocol — that a URL's own protocol options are
offered beside the muxer's and reach the same bag, the spec and the printed
command; that the `-f tee` argument is built with tee's escaping (a `|` in a
target, a `:` and a `]` in an option value) and then quoted for the shell, so
what is printed can be pasted and run; that picking `tee` makes the file already
named the first destination rather than throwing it away; that a two-destination
render writes both and reports two; and that the progress panel says something
different and true for each shape — the count of files for a set, "sent" and no
offer to open anything for a stream.

It also drives everything on the encode side that is not an encoder option: that
two-pass is a *mode* of the rate control and that choosing it makes the spec say
the range is walked twice with both passes naming one statistics file and the
command bar printing two invocations; that a forced keyframe at a cut point
**follows the clip when the clip moves**, which is the whole claim of deriving
it rather than copying it; that the field order prints as the two things it is;
that `-fps_mode` has no picker and is stated instead; and that a bitstream
filter chain is offered only for the codec the stream is encoded with, runs in
the order shown, carries libavcodec's own option table and prints as one
`-bsf:v` the way `av_bsf_list_parse_str` takes it.

## Not yet

Honest list of what does not work:

- **Rotation in the filmstrip.** A clip stored sideways now plays, lays out and
  exports the right way up. The timeline's *thumbnails* are the one place the
  display matrix does not reach: `bro.media.thumbnails` decodes with a reader of
  its own and hands back pictures at the coded size, so a phone clip shot upright
  has a strip of landscape frames lying on their side underneath a portrait
  picture. It is wrong for exactly the reason laying the clip out at the coded
  size was wrong, and the fix belongs in bro's media analysis, which is handed
  the rotation and does not apply it.
- **Filters on playback.** A filter you put on the graph runs when you render,
  in the export preview, and in the node's own preview on the Graph stage. The
  *viewer* cannot show it: playback is the engine decoding into a `<video>` and
  there is no filter anywhere in that path. Filtered clips are marked `fx` rather
  than left looking broken.
- **Scrubbing a node.** ▶ plays one forward from where the previews were taken,
  and that is the only way to move through it: there is no scrub bar, no way
  back, and nothing to jump with. Somewhere else to start from means moving the
  playhead and pressing `At playhead`.
- **Undo, anywhere.** There is no undo stack in this application and no `Ctrl-Z`
  handler — not on the timeline, not on the settings, and not on the graph. Every
  edit is applied to the model and the model is what is drawn, so putting a cut
  wire back means wiring it again and putting a split back means deleting one
  half and trimming the other. The graph is where the absence is felt most,
  because a wire is work in the way a slider position is not, which is the same
  argument the project file below is made on. `Give it back` covers the one case
  where "again" is ambiguous — a pad handed to the derivation.
- **A generated source in the viewer.** A `testsrc` or a `movie` renders and
  previews on its own card, and the *viewer* cannot show it for the same reason
  it cannot show a filter: playback on the timeline is the engine decoding a
  file into a `<video>`, and the filtergraph is not in that path. A render with
  nothing on the timeline is therefore something you watch on the Graph stage
  and on the Encode stage's preview, not on the program monitor. The Capture
  stage's composition is the shape of the answer — a filtergraph's output
  playing in an ordinary `<video>` — and what it does not have is the other
  half: a session is pushed by devices on the wall clock, and a timeline is
  pulled by a playhead that can be dragged.
- **A generator that follows the render.** A source is placed carrying the
  render's size and rate, and it does not chase them: change the output size
  afterwards and the graph is refused with both numbers rather than rescaled.
  Refusing is the right half of that; noticing before the render is not done.
- **A project file.** What you insert, lock, place and wire is remembered in
  `localStorage`, which is per machine rather than per edit. It was the first
  thing that made a document format worth having and is now most of the reason —
  and a node naming one of your inputs is deliberately *not* written there,
  because the inputs themselves do not survive a restart and their ids start
  again from one, so a restored reference would name whichever file happened to
  be third next time.
- **Animating a value.** `enable` turns a filter on and off for a span and that
  is the whole of what it does — there is no interpolation anywhere in ffmpeg's
  timeline support, so a value cannot be ramped by it. What ffmpeg has instead is
  **expressions in a filter's own options**, evaluated per frame: `crop`'s `x`
  and `y`, `overlay`'s, `scale`'s, `drawtext`'s, several of them with an `eval`
  option choosing between evaluating once and evaluating every frame. Those work
  here — an option is a string and the string goes through verbatim — but nothing
  surfaces them: no control writes one, no strip draws one, and the `eval` option
  is an entry in the table like any other. That is the shape of a real
  keyframe editor and it is not built.
- **A span you can see while you scrub.** The When strip is drawn against the
  render's range and is not the timeline: the playhead is not on it, and moving
  the playhead does not move anything on it. Judging where a span lands is done
  by playing the node, where the readout says `on` or `off`.
- **Two-pass filters.** The mechanism is there — a render is a list of passes,
  each the render with overrides, run in one job through one slot — and the two
  filters that need it are `vidstabdetect`/`vidstabtransform`, which this build
  of ffmpeg was not configured with. So nothing in the UI offers a two-pass
  filter render, because there is none here to offer and a control for a filter
  the build does not have is a control that fails at parse. `loudnorm`'s two
  passes *are* reachable, by a different route: `ebur128` measures and the
  Report drawer offers `loudnorm` told what it found, which is one render and a
  decision rather than two renders.
- **A measurement that follows the edit.** What a filter found is about the
  render it was measured during. Move a clip and the numbers stay, describing an
  edit that no longer exists — nothing marks them stale, and the only thing that
  says so is the timestamp on the render they came from.
- **Measuring part of a graph.** `Measure now` runs the whole graph over the
  whole range. Measuring one node's output means putting the filter at that
  node's point, which works, and there is no equivalent of the Graph stage's
  per-node preview for a *number*.
- **Reading a URL while it is slow, and writing to one while it fails.** A
  render goes to a URL now, with its protocol's own options beside the muxer's,
  and reports what it sent rather than a size. What is not built is either end
  of *going wrong*: `probe()` is synchronous, so a URL that takes four seconds
  to answer takes the UI with it and nothing says "connecting" or offers to
  stop; and a destination that drops mid-render arrives as a failed render with
  libav's own message in the report, with nothing that retries, reconnects or
  buffers. Both are what `-reconnect`, `-rw_timeout` and the `fifo` muxer exist
  for, and all three are reachable as ordinary options — none of them is
  surfaced as anything better than that.
- **Subtitles in the viewer.** A soft subtitle track is written correctly,
  plays in any player and is invisible here for the whole time you are working
  on it: bro's `<video>` decodes into an element and there is no subtitle path
  anywhere in that pipeline, which is the same structural reason a filter
  cannot be previewed. Burned-in subtitles *are* visible, because a node
  preview and the export preview are real renders. The Write stage says which
  of the two you are looking at rather than leaving the viewer to imply the
  track was not written.
- **An editor for the cues themselves.** Everything here reads a subtitle file
  and writes one; nothing lets you type a line, retime one against the
  waveform, or split a cue at the playhead. The timeline has the lane that
  would make it possible — A1 is where you would judge a timing — and none of
  it is built. What a person with a file that is a second and a half out has
  here is `-itsoffset` on the input, which shifts the whole track and is the
  right tool for exactly that one problem and no other.
- **Picture subtitles converted to text.** `dvdsub` and `hdmv_pgs_subtitle`
  can be carried into a container that holds them and burned into the picture;
  they cannot become `subrip`, because that is optical character recognition.
  The refusal names the reason rather than failing at the first cue.
- **A subtitle stream on the packet path's terms.** A copied subtitle track is
  the whole track: `copyFrom`/`copyTo` cut the *span* read out of it, which is
  what the renderer does, but nothing on the Write stage draws that against the
  cues the way the keyframe strip draws a copied picture. There is nothing to
  snap to, so a strip would be decoration; a list of where the cues are would
  not be, and it is not built.
- **Two outputs at different settings.** `-f tee` is one encode to several
  destinations, which is what the Write stage builds. The same render written
  *twice* — a 1080p master and a 720p proxy — is two encodes and is a different
  feature; the `passes` list already expresses it as two walks over the range in
  one job, and no control offers it.
- **A still in the viewer without `-loop 1`.** One picture is one picture: bro's
  `<video>` drives its clock from decoded pictures, so a file with exactly one
  has nothing to advance through, and the element shows the frame and reports
  itself ended. Held with `-loop 1` and a `-t` it plays like anything else, which
  is why that is what a dropped picture becomes — but an input somebody has taken
  the loop off is refused with a sentence rather than laid out as a clip of
  nothing. The same is true of `-stream_loop -1`.
- **`pattern_type=glob` on this build.** Globbing is compiled into libavformat or
  it is not, and this build's is not. The control says so instead of offering a
  pattern type that fails at open.
- **A sound sequence.** An image sequence is pictures. Giving a run of frames a
  separate soundtrack means two inputs and a `-map` per stream, which the Write
  stage can say and nothing yet joins up.
- **A live device on the timeline.** A device never ends, so nothing can be cut
  from it: there is no length for a clip to have and no seeking back to a
  moment that has gone. Forcing `-f dshow` on the Sources stage describes one
  correctly and refuses to lay it out, and the Capture stage is where one is
  watched and recorded. Live *through* the edit — a camera composited with a
  title and streamed out — is a different thing again and needs the render loop
  to run on the wall clock.
- **Hearing a recording before you commit to it.** The composition is shown; the
  mix is not. The graph's sound pads are drained like every other, but nothing
  is played from them, because that is *monitoring* and monitoring asks
  questions a preview does not — whose speakers, and what happens when the
  microphone can hear them. The levels a session is running at are therefore
  not visible either, which is the part worth having first.
- **More than one file out of one recording.** A recording writes one muxer, so it
  maps one picture and one sound. The graph can end in half a dozen pads and the
  Write stage can feed a stream from each of them, but that is a render's stream
  list and a recording has none — recording the cameras to one file while a
  cropped copy goes to another means running the session twice. `-f tee` in the
  destination field is the near answer and it writes the *same* encode to both.
- **A file beside a device on the same graph.** A capture's graph is fed by its
  devices and by nothing else, at both ends of the seam: the walk that builds it
  refuses a file input by name, and `filterInputs` — which says which *file*
  feeds which pad — is refused by the engine outright. Overlaying a title card on
  a screen grab as it records is therefore not something this can express, though
  a `color` or a `testsrc` beside the device is, because a filter with no inputs
  makes its own frames and nothing has to pull one. A graph whose filters want a
  graphics card is refused the same way, because `-filter_hw_device` has nowhere
  to be said on this stage.
- **A destination editor on the Capture stage.** Recording and streaming the
  same capture works — it is `-f tee` and the same `Writer` — but the argument
  is typed into the path field there rather than built from a list. The Write
  stage has the editor, and a second copy of the escaping would be a second
  answer to it.
- **Variable frame rate out.** `-fps_mode` has one honest value here and the
  command says it: `cfr`. Both render paths walk the range forward at the output
  rate and stamp each frame with its number — the compositor because it samples
  the edit at *t*, the graph because the writer numbers what leaves the sink —
  so a variable-rate output is not something either can express, and no control
  offers it. Making one possible means the `FrameSource` seam handing over a
  timestamp with each frame instead of being asked for an instant, which is a
  change to the one interface both paths are measured against.
- **Genuinely interlaced content.** The field-order control puts the encoder in
  field mode and marks the frames, which is the whole of what ffmpeg does — but
  what this application composites is a progressive RGBA canvas, so it is a true
  statement only for footage that was interlaced and came through at its own
  size. Anything scaled has had its fields woven together by the scaler first,
  and a 4:2:0 output subsamples chroma across both fields either way. There is
  no field-aware scaling path and no deinterlacer in playback; `yadif` on the
  graph is the answer to the other half of that.
- **A two-pass encoder that keeps its own statistics somewhere else.**
  `-passlogfile` reaches x264, which takes the filename as an option, and every
  encoder that uses libavcodec's own statistics pair. An encoder that does
  neither writes its log wherever it likes and pass 2 reads an empty one — the
  render says so, naming the encoder, because there is no capability to ask
  first.
- **A copy that follows the timeline.** A copied stream is one input's packets
  over a span, set on its own row in the input's own seconds. The clip you
  trimmed on the timeline is not that span and nothing connects the two, so
  cutting losslessly means reading the in-point off the keyframe strip rather
  than off the edit. It is the obvious next thing and it is not built.
- **A copy of a stream that is neither picture, sound nor cues.** Video, audio
  and subtitle streams are all copyable and attachments are their own kind of
  row. What has no home is a `data` stream — timed metadata, a GoPro's telemetry
  track, a camera's timecode — which `-map` carries and `-c copy` writes and
  which nothing here will offer, because the probe does not report the kind and
  the stream list has no row that could say what it is.
- **Hardware filters that this build does not have.** `hwupload`, `hwdownload`
  and `hwupload_cuda` are here; `scale_cuda`, `overlay_cuda`, `scale_qsv` and
  the rest of the device families are not, because a vcpkg ffmpeg with
  `nvcodec` is built without the CUDA compiler. Nothing in this application
  knows that — the palette offers whatever libavfilter reports — so a build
  that has them gets them with no edit here. What it costs today is that a
  render on the card cannot resize or composite on the card, only pass frames
  through.
- **Hardware anywhere in playback.** A clip whose input decodes on a device
  still has every frame brought down for the viewer, because bro's renderer
  takes planes it can read. That is the right trade — the readback is 3% and
  the decode is the slow half — but it does mean `-hwaccel` on the timeline is
  a setting that only costs.
- **A hardware decode chosen for you.** Nothing looks at the file, the machine
  and the render and picks. It could: the measurement is in this README and the
  shape of the answer is clear (software decode, hardware encode, above SD).
  Doing it would mean choosing on somebody's behalf and then having to say so,
  which is a design problem and not a plumbing one.
- **Speed on a render.** `J`/`K`/`L` and the speed selector are transport
  controls, not part of the edit, so a clip exports at its own rate whatever
  the viewer was last playing at.
- **Ripple, roll and slip.** Trimming leaves a gap rather than closing it up,
  and there is no gesture that moves a cut without moving the pictures either
  side of it. Nothing here needs new machinery — a clip already knows its
  in-point separately from where it sits.
- **One waveform for the whole timeline.** A1 draws every clip, so clips that
  overlap in time draw over each other rather than mixing. With tracks stacked
  it is the top one you see.
- **Finding things by sound.** Reviewing wildlife footage, the birds are
  audible long before anything is visible; nothing yet marks where a call
  happens so you can jump between them. bro has the parts — `bro.sense` for
  onset and tonality, `bro.kws` for open-vocabulary spotting.
- **A second GPU used for anything.** `-hwaccel_device` and
  `-filter_hw_device cuda:1` reach one by index, and this machine has two — but
  nothing splits a render across them, and the obvious thing to do with the
  second card (render the A/B preview's reference on it while the candidate
  runs on the first) needs the one-job-at-a-time slot to become two.
