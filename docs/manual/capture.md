[← The manual](README.md)

# Capture

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
what it sees: each input as `in0`, `in1`, … its sound as `in0:a`, and whatever the graph
makes as `vout` and `aout`. Every picture on the stage — and every meter, and anything
you are listening to — is a pad of that one session, and three pictures of two cameras
costs two opens.

**And what the sound is doing, which is the half of a composition that cannot be
seen.** Every input with sound gets a meter, named `in0:a` the way ffmpeg names that
stream, and so does the graph's mix if it has one. Whether a level is right is the one
thing about a take that cannot be fixed afterwards — a badly framed picture is still a
picture; sound recorded ten decibels into the limiter is gone — so it is the reading
worth having before you commit, and until now the sound of a session was drained and
dropped, which left a capture with a microphone in it saying nothing at all about the
microphone.

Three readings, because they are three questions. The **bar** is what it is doing now,
falling about 20 dB a second so a transient is readable rather than a flicker. The
**mark** is what it just did, falling five times slower. The **number** is the loudest
it has been since you last cleared it, which is the one somebody setting a gain wants
and the only one of the three that is a measurement rather than a drawing. The **over**
light latches when a pad has gone past full scale; clicking it forgets both latches at
once, because they are the same question at two resolutions.

It is drawn on the same scale as A1 — see [The timeline](timeline.md)
— from -60 dBFS to +6, with a line where full scale is. Somebody looking at one and
then the other is comparing them, and two scales disagreeing by a decibel would make
that comparison a quiet lie.

**And you can hear it, which is a different thing from reading it.** `Listen` beside a
meter plays that pad through this machine's speakers. It starts off, always: sound that
begins by itself is sound nobody asked for, at whatever gain the last session left. One
pad at a time, because `in0:a` under `aout` is the microphone twice and neither meter
beside them would be a reading of what you were hearing — pressing `Listen` on another
pad moves it. The meter itself runs whether or not anything is being played, which is
what makes it the thing you glance at.

**Whose speakers: this machine's, chosen nowhere.** There is no output device control,
because bro's mixer plays to the system default and picking another interface is a
decision nobody has asked to make yet. The day somebody does, it is a control here and
nothing else changes.

**What happens when the microphone can hear them: you are told.** While a monitor is
on, the panel names every input being read for sound and says plainly that nothing is
being done about it — no ducking, no gating, no muting the input while you listen.
Doing any of those would be this application deciding that two devices are in the same
room, which it cannot know: a camera on a desk with the monitor on headphones is the
ordinary case and all three would silently ruin it. So the risk is stated, with the
device named, and the choice stays where it belongs.

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

## Recording and streaming at once

**Container** offers *several destinations (tee)* under the containers, and picking it
turns **Save to** into a list. A row is a muxer and somewhere to go, so a take on disk
and an RTMP push out of the building is two rows — one reading of the devices, one
encode, two wrappers.

The `-f tee` argument is **built rather than typed**, which is the whole reason the list
is here. That argument is a small language inside a filename: destinations separated by
`|`, each optionally preceded by `[key=value:key=value]`, and libavformat unescapes it
before it looks at it — so a `|` or a `\` in a path has to be escaped, a `:` or a `]`
inside a bracket does too, and then the shell quotes the lot again. Hand-writing one
correctly is a party trick. It is shown as well as built, in full, under the list.

These are **the same rows the Write stage draws**, out of the same file, because they
are the same question: a recording is a device into a muxer, and a render is a timeline
into a muxer. One editor, so there is one answer to how a `|` is escaped.

`tee` is in the picker by name and is the only entry that is. Everything else on this
stage is asked of libav, and the filter is "writes the file it is named with, and has
an extension" — which is what a recording is and which `tee` is not: it opens the
muxers in its argument instead. So it would have been filtered out, and it is exactly
the mechanism for the thing people arrive at this stage wanting.

Picking it with the take already named makes that file the first destination. Switching
back leaves the single path where it was — changing your mind about how many files
there are should not lose the name of the one.

Afterwards there is one thing to point at rather than a filename: the button names how
many destinations there are, and *Add to timeline* offers the first one that is a local
path, because the others are the same bitstream and a URL has gone.

## More than one file out of one recording

**Also write** is a list under the recording's own settings, and each row is another
file this same reading of the devices produces: the cameras into one, a cropped copy
into the next. A row is somewhere to go, a container, and which ends of the graph it
takes — nothing else, because everything else is the recording's.

This is the **third** answer to "two outputs" and only a recording has it. The Write
stage has the other two and they are worth telling apart:

| | |
|---|---|
| `-f tee`, above | one encode, several places — same packets, different wrappers |
| Also write, on the Write stage | several encodes of one edit, run one after another |
| Also write, here | several encodes of one *moment*, running at once |

The middle one is why this exists. A render writes a 1080p master and a 720p proxy by
walking its range twice, because the range is still there the second time. **A
recording has no second walk** — what it was reading has happened — so its several
encodes are several muxers open beside each other on the end of one pass. The cost is
what it is: two encodes running against the same CPU as a live capture, which is the
one job in this application with a real-time deadline.

**Which ends** is the whole of what makes a row a different file rather than a copy.
Left on the recording's own pad it is a second encode of the same picture, which is a
real thing to want — the same take in a smaller container, or a mezzanine beside a
delivery — and pointed at an output of your own it is a different picture entirely.
The pickers are drawn on every row for that reason, unlike the recording's own, which
appear only when the graph offers a choice.

**No size field**, which is the one thing a render's version row has and this does not.
On this stage a picture's size is its pad's, and another size is a `scale` on the Graph
stage with an output to point at — that is where a composition is described, and a
second place to describe one is a second thing to keep in step. (`record.start` does
take `width`/`height` per file, for a caller with no graph at all; see
[api.md](../api.md).)

Everything else is the recording's and deliberately not per file: the devices, the
graph, `-t`, the encoders and the quality. So is the **rate** — placing a frame is
turning the moment it arrived into an output frame number, and two files answering that
differently would be two files disagreeing about when the recording started.

Two files aimed at one path is refused before the press, and again by the engine: one
muxer per file, and two writing to one interleave into something no player reads.

The command bar prints it as what it is — several outputs on one line, each naming the
pad it is of:

```
ffmpeg -f dshow -i video=Cam -filter_complex "[0:v]split[vout][x0];[x0]crop=…[left]" \
  -map [vout] -f matroska take1.mkv  -map [left] -f matroska take1-left.mkv
```

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
