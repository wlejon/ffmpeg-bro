[← The manual](README.md)

# Capture

`D` (or the first card on the spine) is where an input comes from when there is not
one yet: a screen, a camera, a microphone — one of them or several at once,
composited and recorded to a file.

It is the one stage that is about the file going *in* rather than the file
coming out. `ffmpeg -f gdigrab -i desktop out.mkv` is a whole pipeline whose
output is a file, and then you open that file — so the arrow from Capture to
Sources is real, just crossed at a different moment. `Add to the timeline` is
that arrow being followed.

**A device is an input, and it is in the same list every file is in.**
Clicking a device in the left column **activates** it, which is what adds
the `-i`: it appears on the Sources stage with its demuxer and its option
bag, and in the Graph stage's source list beside every file, with a picture
socket, a sound socket, or both, according to what the probe found. The `×`
on a card **releases** it, out of the recording and out of the input list
together. No device activated is an ordinary state; so is one device
activated and never recorded.

What is *not* possible is laying a device on the timeline: a clip is an
in-point and a length, and a live input has neither. It is refused by name,
with what to do instead.

**Activating one does not stop the window.** Opening a device can take a
while and is not always predictable — a camera another program is holding,
or a capture card mid-reset, can hang. The open runs on a thread of its own,
and the card says **Opening · 1.2s of 10** while it does. The previews and
`Record` both wait for it and say so.

**`Stop waiting`** ends this application's waiting, not the device's open:
the driver is not interruptible, so the card settles at once and the open is
abandoned in the background rather than aborted. To ask again, use
`Re-probe` on [Sources](sources.md).

Enumerating what a device can see is asked once per device and again only on
`Rescan` — it is a slower call than everything else on this stage and there
is no reason to repeat it on every draw.

Three columns, in the order somebody works:

- **What to capture**, on the left. libavdevice's own list — on Windows
  `dshow`, `gdigrab`, `vfwcap` and `lavfi`; a different list on another
  platform — under the human name libav gives each one, with the `-f`
  spelling beneath it. Clicking one adds it. Underneath is **what that device
  can see**, picked rather than typed, because a DirectShow name is an exact
  string with punctuation in it. A camera and a microphone chosen together
  are **one `-i`** (`video=Cam:audio=Mic`). A device with nothing to
  enumerate — `gdigrab` takes a rectangle rather than a name — says so rather
  than showing an empty list.
- **The pictures and the act**, in the middle. A card per input with its live
  preview, its **Source** and **Stop after**, and its region where it has
  one; under them, what the graph makes of them, playing; under that, the
  graph as one line; and at the bottom, the **Record** button with the file
  it is about to write beside it — and, where it is dead, the reason.
- **What comes out**, on the right: where it is saved, the container, the two
  codecs, the quality, and how long it will be. Beneath that the focused
  device's **whole option table** — `video_size`, `framerate`, `draw_mouse`,
  `offset_x`, `audio_buffer_size`, `rtbufsize`. An unknown key stops the open
  rather than being ignored.

The two fields on a card are **Source** and **Stop after**, and
`ffmpeg -f gdigrab -i desktop …` is printed exactly, and copyably, in the
command bar along the bottom of the window. The one piece of ffmpeg
vocabulary left on a card is the `-i` **number** — a badge, `0`, `1` —
because the graph genuinely calls them that.

**Several devices are several `-i`s, and a card each.** Clicking a second
device appends another input; the cards sit across the stage in the order
that numbers them for the graph, so the first is badged `0` and reaches the
graph as `[0:v]`/`[0:a]`, the second `1`. Each card is a whole input — its
source, its window, its own option bag — and clicking one points the device
list and the option column at it. An option set on it anywhere reaches the
recording: a `-probesize` typed on the Sources stage reaches the recording
too, and the command bar prints it in front of that `-i`.

Changing a card's device is releasing one and activating another — two
clicks, because a device and its option bag go together, and carrying
`draw_mouse` over to a camera would be carrying a key that stops the open.

**Stop after** — `-t` — belongs to an **input** rather than to the
recording, which is why it is on a card and not in the output column;
**the shortest of them is when the session ends** — that is the *Length* the
output column states. An input that has run out has nothing further to offer
the graph.

**A live preview per card, before you commit to a recording.** Each picture
is an ordinary `<video>` through the same backend, decoder and renderer
everything else in this application plays through. There is no preview-only
path, for the same reason a node preview has none: a preview that agreed
with the recording most of the time would be worse than none.

**And below them, what the graph makes of them — playing.** That is the
same composition a recording runs, on the same text the Graph stage built,
so a picture-in-picture is something you look at rather than something you
judge by its numbers and discover in the take. It appears when the graph
produces a picture and is absent when it does not.

**One open per device.** A *session* opens each device exactly once and
publishes what it sees — each input as `in0`, `in1`, … its sound as `in0:a`,
and whatever the graph makes as `vout` and `aout`. Every picture on the
stage — and every meter, and anything you are listening to — is a pad of
that one session, so three pictures of two cameras costs two opens rather
than three.

**And what the sound is doing, which is the half of a composition that
cannot be seen.** Every input with sound gets a meter, named `in0:a` the way
ffmpeg names that stream, and so does the graph's mix if it has one. Whether
a level is right cannot be fixed afterwards, so it is the reading worth
having before you commit.

Three readings, because they are three questions. The **bar** is what it is
doing now, falling fast so a transient is readable rather than a flicker.
The **mark** is what it just did, falling slowly. The **number** is the
loudest it has been since you last cleared it, which is the one somebody
setting a gain wants. The **over** light latches when a channel has gone
past full scale; clicking it forgets every latch on the stage, because they
are the same question about one take.

**A bar per channel of the pad, not one for the pad.** A stereo microphone
with a dead side reads perfectly healthy as a single number, which is the
fault a meter is here to catch. The channels are named as libav names them —
`FL`, `FR`, `FC`, `LFE`. A device with one channel gets one bar and no name.

**It is a true peak**, oversampled four times so a signal that never crosses
full scale on a sample can still be read correctly between samples. The one
place it reads high on purpose is sound that starts *abruptly* — a
hard-gated take, or the first block of a session, is a step for the filter
to ring on and reads about a decibel over; that is ordinary and every meter
built this way does it.

It is drawn on the same scale as A1 — see [The timeline](timeline.md) —
from -60 dBFS to +6, with a line where full scale is, by the same meter the
[program monitor](playback.md#the-meter-beside-the-picture) draws beside the
picture.

**And you can hear it, which is a different thing from reading it.**
`Listen` beside a meter plays that pad through this machine's speakers. It
starts off, always, at whatever gain the last session left. One pad at a
time — pressing `Listen` on another pad moves it, because two together would
be a mix of a mix and neither meter beside them would be a reading of what
you were hearing. The meter itself runs whether or not anything is being
played.

**Whose speakers: this machine's, chosen nowhere.** There is no output
device control — bro's mixer plays to the system default.

**What happens when the microphone can hear them: you are told.** While a
monitor is on, the panel names every input being read for sound and says
plainly that nothing is being done about it — no ducking, no gating, no
muting the input while you listen. A camera on a desk with the monitor on
headphones is the ordinary case, and any of those three would silently ruin
it, so the risk is stated with the device named and the choice stays where
it belongs.

A recording still opens its own devices, with the session torn down first —
so "there is no camera called that" is a refusal that belongs to the
recording itself, not to a session it inherited. The cost is the moment
between the two opens, which is the moment the pictures go dark anyway.

**Every device this build can open plays here, `lavfi` included** — a
`-f lavfi -i testsrc` card shows its test pattern like any other device.

**The graph is built on the Graph stage, and with several inputs it is not
optional.** Cropping one monitor out of a wide screen grab is a `crop` node
between the device and video out, at one input as much as at several.
Several inputs *require* a graph — two pictures and nothing saying how they
combine is refused rather than guessed at — and once there is more than one
input, every stream of every input has to reach a pad, because a stream
going straight to the writer would be one device's picture silently becoming
the file. Both refusals name what is wrong and which pad it is about.

An activated device is a document input, so it is already in the Graph
stage's source list: place it there, wire it, and it can be checked against
libavfilter's own pad lists and previewed at any point.

**A recording writes the pads it names, and runs the part of the graph that
produces them.** Three consequences:

- A **source filter** comes with it and an **`-i`** does not. A `testsrc`
  overlaid on a camera is fine; a `movie` reading a file is fine too, see
  below. What is refused by name is an input node — there is nothing pushing
  a file into a recording's graph the way a device's frames are pushed.
- The **ends it did not name** cost nothing to ignore: one graph can feed a
  render and a recording without either being an error.
- The pads are **renumbered** in the order the cards are in, which is the
  order the engine opens the devices in — not the order nodes were placed on
  the Graph stage.

**Which pads?** By default video out and sound out, because that is where a
person wires something when the graph has only one end. But those two are
also where a *render* of the timeline ends, so wiring two cameras into video
out is a statement about what the timeline's picture is, not about what the
recording writes. So place an output of your own on the Graph stage, wire
the cameras to that, and pick it under **Picture from** on the Capture stage;
the picker appears only once the graph has an output of its own. Delete the
output and the recording drops back to video out — the panel says what it is
mapped as now.

## A file in the graph

A title card over a screen grab as it records, a logo bug on a camera, a
plate to key against: all of them are a **`movie` node** on the Graph
stage — libavfilter's own source filter, in the palette with `color` and
`testsrc`. Wire its output into an `overlay` beside `[0:v]` and record.

**It is pulled, in step with the device.** A recording's graph is pushed by
the device's decoded frames; a `movie` has no input pad of its own, so when
the drain pulls at a sink, `overlay`'s frame sync asks the `movie` for the
frame that pairs with the device's — once per output frame, never sooner,
which is why a file read this way does not run ahead of the camera.

What happens at the end of the file is libavfilter's own rule: a still
picture is one frame and then EOF, and `overlay`'s default
`eof_action=repeat` holds that frame for the rest of the recording, which is
what makes a title card a title card. `endall` ends the recording with the
file and `pass` lets the other input through unaltered — both are ordinary
options on the `overlay` node.

**A `movie` is not an `-i`, and the difference is what it cannot carry.** It
takes a filename and a seek point; a forced demuxer, `-probesize`, `-ss`,
`-t`, `-loop`, `-stream_loop`, and for a URL the whole protocol option table
all belong to an `-i` and are simply not there. The [Sources](sources.md)
stage accounts for the file anyway, under **Opened by the graph**, with an
`Add` beside it that opens the same file as a real input with all of that.

A colon separates a filter's arguments, so a Windows path inside a `movie`
has to be written `'D\:/shots/card.png'` — quoted, with the drive colon
escaped.

## Streaming it out

**Save to** takes a URL as readily as a path, because a recording is a
device into a muxer — so `rtmp://`, `srt://` and `udp://` reach one here for
the same reason they reach one on the [Write](output.md) stage. A
**Protocol** row appears under the field saying whether the scheme it names
is linked into this build.

**A camera composited with a title and streamed out is this stage.** The
camera is a card, the title is a [`movie` node](#a-file-in-the-graph) wired
into an `overlay`, and the destination is the URL. A recording already runs
on the wall clock, so there is nothing else to add. What is *not* here is a
device on the timeline as a clip, which is refused for its own reason: see
[Sources](sources.md).

A stream has no size and no percentage while it runs, and nothing to open
when it stops. The bar says what it can — elapsed, frames and bytes sent —
and `Add to timeline` is offered only for a destination that is a local
file.

## Recording and streaming at once

**Container** offers *several destinations (tee)* under the containers, and
picking it turns **Save to** into a list. A row is a muxer and somewhere to
go, so a take on disk and an RTMP push out of the building is two rows — one
reading of the devices, one encode, two wrappers.

The `-f tee` argument is **built rather than typed**, shown in full under the
list. These are the same rows the Write stage draws for the same reason,
since a recording is a device into a muxer and a render is a timeline into a
muxer.

`tee` is the only entry named directly in the picker; everything else on
this stage is asked of libav. Picking it with the take already named makes
that file the first destination; switching back leaves the single path where
it was. Afterwards the button names how many destinations there are, and
`Add to timeline` offers the first one that is a local path.

## More than one file out of one recording

**Also write** is a list under the recording's own settings, and each row is
another file this same reading of the devices produces: the cameras into
one, a cropped copy into the next. A row is somewhere to go, a container,
and which ends of the graph it takes — nothing else, because everything else
is the recording's.

This is the **third** answer to "two outputs", and only a recording has it:

| | |
|---|---|
| `-f tee`, above | one encode, several places — same packets, different wrappers |
| Also write, on the Write stage | several encodes of one edit, run one after another |
| Also write, here | several encodes of one *moment*, running at once |

A render writes a 1080p master and a 720p proxy by walking its range twice,
because the range is still there the second time. **A recording has no
second walk** — what it was reading has happened — so its several encodes
run beside each other on the end of one pass, which costs a second encode
running against the same CPU as the live capture.

**Which ends** is the whole of what makes a row a different file rather than
a copy. Left on the recording's own pad it is a second encode of the same
picture — a mezzanine beside a delivery copy, say — and pointed at an output
of your own it is a different picture entirely. The pickers are drawn on
every row for that reason, unlike the recording's own, which appears only
when the graph offers a choice.

**No size field**, which is the one thing a render's version row has and
this does not: on this stage a picture's size is its pad's, and another size
is a `scale` on the Graph stage with an output to point at.

Everything else is the recording's and deliberately not per file: the
devices, the graph, `-t`, the encoders, the quality and the rate.

Two files aimed at one path is refused before the press, and again by the
engine — one muxer per file, and two writing to one interleave into
something no player reads. The same check refuses a destination that would
overwrite a file already open elsewhere as one of this recording's own
inputs.

The command bar prints it as what it is — several outputs on one line, each
naming the pad it is of:

```
ffmpeg -f dshow -i video=Cam -filter_complex "[0:v]split[vout][x0];[x0]crop=…[left]" \
  -map [vout] -f matroska take1.mkv  -map [left] -f matroska take1-left.mkv
```

All of that is **one line** on the Capture stage — `Filters: none`, or
`2 inputs → [vout]`, or `will not run — …` — with the button that opens the
Graph stage on the end of it, and the chains that will run listed under it
when there are any. A graph that will not run says so in the words the Graph
stage uses against the node it is about, the `Record` button is dead until
it does, and the command bar prints no `-filter_complex` at all.

**A region is dragged, not typed, and it lives on the card whose picture it
is dragged on.** Drag a box on an input's picture and it becomes
`-offset_x`, `-offset_y` and `-video_size` — that input's own demuxer
options, in the screen's own pixels, printed in the command below and set in
the option table on the right like any other key. Which devices can be asked
for a region is a question about their option table: a device takes a
rectangle when it has all three of those options, which a screen grabber
does and a camera does not. The picture is fitted rather than stretched, and
the rectangle is **clamped to the screen**, since a rectangle running off the
edge is one libavdevice refuses at the open.

**Recording says what it can say and no more.** Elapsed, frames written,
bytes on disk — and, out loud, that it *runs until you stop it*: a
percentage needs a total and a device has no end until you press stop. Give
an input a **Stop after** and it does have one, and then the percentage
means something. `Stop` is the *normal* end of a recording rather than the
exceptional one, so a stopped recording reports as **done**: nothing was
abandoned, the length was the open question and stopping answered it.

**One job at a time, and while recording that job is the recording.** There
is one render slot in this binary and a capture takes it: no export, no
preview, no node render while the light is on. A recording is the only job
here with a real-time deadline and it cannot be re-run, so it gets the
machine. Every other stage is refused with the reason while it runs.
