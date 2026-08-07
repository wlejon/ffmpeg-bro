[← The manual](README.md)

# Sources

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
  `srt`, `rtmp`, `udp`, `tcp` and others. A URL gets an **Over** row naming its
  protocol and saying whether it is one of them, because a URL naming a protocol
  that is absent otherwise fails at open with a message about a filename.
- **Connecting**, only while a URL is being opened, with the seconds against the
  deadline and a **Stop** — or **Opening** with a **Stop waiting**, when what is
  being opened is a device. See [While it is
  connecting](#while-it-is-connecting) below.
- **Read as** — the demuxer. What it probed as, `Change…` for a search over every
  demuxer this build has, and `Auto` to hand the choice back to libavformat.
- **Window** — **Start at**, **Stop at**, **Delay by**, **Repeat**. **An input seek
  is not a clip's in-point**: `-ss` moves the input's zero, so the input becomes
  shorter and a clip is cut from what is left. Trimming a clip picks a moment out of
  an input; Start at decides what the input is. Delay by (`-itsoffset`) shifts every
  timestamp, which is how a camera and a separately recorded soundtrack are lined
  up. Repeat (`-stream_loop`) says how many more times to read the input; `-1` is
  forever, which has no length at all, so a looping input is as long as Stop at says
  and no longer.
- **Stream**, only for an input that came from a *page* rather than from a path.
  Pasting a stream page's URL into **From** turns the page into the HLS renditions
  behind it — nothing is downloaded until something asks for a range of it. All of
  them are kept, not just the best: one recording is two different jobs, the picture
  at full resolution for the cut and `Audio Only` at a fraction of the bytes for
  finding sound marks, and picking one is an ordinary change of `-i`. What does
  **not** carry between two of them is *times* — a VOD's renditions do not resolve
  ad breaks identically and drift apart by seconds — so a cut made against one is a
  search hint against another and the row says so.
- **What came back** — the container on one line, then **one line per stream**:
  `V0  h264  1920×1080 · 29.97 fps · yuv420p · bt709`. Everything else the probe
  reported — profile, language, pixel aspect, colour range, per-stream duration — is
  on that line's tooltip. This is the answer to "what did the thing I just set do"
  rather than a description of the file as libavformat's defaults see it: it is
  probed again with the options above in force every time one changes.

**And under the column, the act.** `Use on the timeline`, pinned, with the reason
beside it where it is dead — `A device cannot be cut`, `One picture, no time at all`,
`Never ends — set Stop at`, `No length to cut`, `Nothing to play`, `Will not open`,
`Still connecting`, `Still opening`.

## Saving a stream to this machine

`Save a local copy` appears beside those for an input that came off a page, and
it is worth pressing before anything else you plan to do more than once.
Everything downstream reads an input *repeatedly* — a scrub, a filmstrip, a
waveform, a render — and for a URL every one of those is a
network read.

Nothing waits for the copy. A clip on a URL is [read for the span the timeline
is showing](timeline.md), so you can explore a six-hour recording while it is
still arriving — the waveform is bounded to a window and taken from the
audio-only rendition, which is a second or two from the picture, until the copy
lands. The moment a copy is on this machine both lanes are read from it instead:
whole, exact and free.

What it does is a **stream copy**: the packets already on the CDN written into a
local container without being decoded, which is what [Rewrap](rendering.md)
does. It runs **in the background** — the card grows a row per pull saying where
each has got to, with `Stop` beside it, and you carry on. A pull is not a
render: it takes no encoder, no compositor and none of the one job slot, so the
Render button goes on working the whole time.

### The soundtrack first, and then the picture

The press pulls **two** streams, one after the other: the audio-only stream,
and then the picture. When the sound lands the card says so, because that is
the moment work that needs only sound can start — finding where
something happens — while the picture is still arriving.

The two are different transcodes of one stream and **do not share a zero** — a
Twitch VOD's ad-break discontinuities put them up to a few seconds apart — so a
time you find in the sound is where to *look* in the picture and never where to
cut it. The card says so once both are here.

### Where it goes

The card says, on a `Folder` row, before anything has been pulled. There are
three answers and it names which one is speaking:

- a folder you chose with `Choose…`, which then takes every copy — a five-hour
  stream is tens of gigabytes, so this is usually a question about which disk;
- otherwise **beside the document**, which is where an edit's media belongs;
- and with no document saved, the directory the application was started in. That
  is a real place and a useless one to be told about, so the row says so and the
  press to end the question is right there.

A chosen folder is remembered between runs and **wins over the document's**,
which is the answer to "put my downloads on the big disk": saving the document
somewhere else afterwards must not silently move fourteen gigabytes of them.
`Beside the document` clears it and puts the first rule back. It is not saved in
the `.fbro` file — it names a disk on this machine, and a document opened on
another would carry a folder that is not there.

Each pull's row names the file it is writing, so the folder above it and the
name beside it are the whole answer.

Two more things about the pull:

- **Data streams are left out.** A stream's own segment-metadata track means
  nothing once the recording is off the site it came from, and some containers
  will not hold a data stream at all.
- **Stopping leaves what was written.** A cancelled pull still closes its
  container, because the point of stopping a six-hour download after ten minutes
  is to have the ten minutes.

Once a copy is here the card offers **`Use the local copy`**, which points the
input at the file. The clips cut from it keep their times, and that is correct
here where it is not correct between renditions: this is a copy of these packets
and not another transcode of the same stream.

### Or take the decisions yourself

`Describe it…` sets the same copy up on the [Write stage](rendering.md) and
starts nothing. That is where a **section** is taken — `-ss`/`-to` on the copy
rows means libavformat fetches the segments the window covers and no others —
and where another container, a stream left out, or simply reading the
invocation before it runs all live.

A row opened there for a copied video draws its keyframe strip only once you
open it, because drawing that means reading the file to find out where the
keyframes are — over a network, on a container with no index, that is a
download. Open a row when you want the strip. See
[Rendering](rendering.md) for what the reading costs and what it says when it
stops early.

The input must be on the timeline for `Describe it…`, because the Write stage
describes the edit; the background pull needs none of that.

`Re-probe` and `Remove` sit at the other end of the same bar; `Remove` says who
is holding the input instead of going dead silently.

**The options.** The demuxer's own table, out of its `AVClass` and libavformat's
generic one — and the protocol's beside it when the path is a URL, since libavformat
passes what the demuxer does not recognise down to the AVIO layer and they travel in
one bag. An unknown key stops the open and names itself.

Under them, **the decoders** — one column per codec this input turned out to
carry, with every private option of whichever decoder libavcodec picks. **A
decoder belongs to an `-i`**, which is why they are here and not on the Encode
stage: ffmpeg writes `-skip_frame` in front of the same `-i` that `-probesize`
goes in front of, and both reach *both* the render and playback. An unknown key
is refused with the key named, as an unknown demuxer option is — and refused
before the render starts.

**Decode on**, under **Decoding**, is a picker of the cards this machine has
rather than a number to type — `-hwaccel`. An index a document brought from a
machine with more cards stays selected and is marked as not on this machine,
rather than being snapped to the default: the render is refused at the open
either way, and a render quietly pointed at a different card from the one the
file names is the worse of the two. Every application with a "hardware
acceleration" switch reads as offering an optimisation; on this machine,
decoding on the card measures several times *slower* than the CPU threaded
across every core. The device is still offered, because another machine's
numbers may differ and it is the only way to feed a hardware filter graph
without an upload.

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

## Reading it

Under `What came back` there is a second section, and the difference between the
two is worth stating once.

**`What came back` is the probe.** It is what libavformat said the instant this
input was opened, under the options set above it: the container, and one line per
stream. It costs nothing and it is complete.

**`Reading it` is what this machine has been asked to work out**, beyond opening
the file. There are two of those — what a data track carries, and where something
happens in the soundtrack — and each is a press, because
each costs real time: about thirty milliseconds for a telemetry track, about a
minute per hour of sound for the marks. Nothing here starts on its own.

Each is one row, and always the same four columns:

```
READING IT
  SOUND       A1   51 transients, 1 tonal run                       [Forget]
  TELEMETRY   D2   HERO8 Black · 40 series · 708 packets             [Forget]
```

Which read, **which stream it read**, how it went, and the door. `Sound` reads
the soundtrack libav picks as the best one, and a file with more
than one soundtrack says `best of N` until a read has run and reported which it
actually was.

Everything in this section is **derived**. None of it is in the document, on the
undo track or in the unsaved marker: it comes back from the file the same way
twice, and storing an answer the next reopen may contradict is how a document
comes to disagree with the file it describes.

## Reading a data track

The first row is a **data** stream whose fourcc something here can parse.

A data stream is packets whose meaning belongs to whatever they were written for,
and the container's fourcc is the whole of what identifies one — `gpmd`, `tmcd`,
`mebx` and `fdsc` all probe as `bin_data`. A real camera file can carry three data
tracks and only some get a button: a parser has to exist for that specific fourcc,
and one that guessed would produce numbers nobody could check. Today's build reads
GoPro's `gpmd`.

**Read it** walks the whole track and says what it found:

```
HERO8 Black · 40 series · 708 packets
```

then a chip per series. A chip is the quantity's fourcc, the name the *file* gave
it, and the reach of every sample in it:

```
ACCL/0 Accelerometer   -15.22..-3.85 m/s²      GPS5/0 GPS (Lat., Long., …)   45.66..47.46 deg
```

Press one and it goes on [the Data lane](timeline.md#the-data-lane); press it
again and it comes off. Six at once, because that is how many colours the
palette runs to.

Nothing in this application knows what a `GPS5` is: the names, the units and the
divisors all come out of the payload, so a camera firmware that starts writing
something nobody has seen plots it with no change here.

**It is a press rather than something that happens.** A probe is what makes an
input usable at all; this is a walk over a whole track that most edits have no
use for. It runs on a thread of its own, so nothing here stops while it runs.

A track that would not parse all the way through is drawn with what survived and
**says so**, counting the packets and naming the first thing it found: an empty
plot cannot be told from a file with nothing in it, and a camera that lost power
mid-write leaves good samples in front of the damage.

A series whose divisor could not be applied is marked `raw`. That is worth a
word, because it is the one number on this stage that may not mean what it looks
like: a GPS latitude without its divisor is 474305352, which is a number, and
47.4305352, which is a place.

**A reading is not in the document**: it is derived from a file, and storing an
answer the next reopen may contradict is how a document comes to disagree with
the file it describes. Which series you picked is not saved either — see [Not
yet](not-yet.md).

## Finding things by sound

The `Sound` row: **Find sounds**.

Reviewing wildlife footage, the birds are audible long before anything is
visible. A waveform is no help — at a lane's zoom a call and the wind under it
are the same two pixels — so this decodes the whole soundtrack and marks the
moments something happened in it. Press `,` and `.` to jump between them.

It finds three things, and **each is named after what was measured, never after
what made it**:

| Kind | What it is |
|---|---|
| `onset` | a sharp change in the spectrum — something happened here |
| `tonal` | a run of steady pitch, with the frequency it was measured at |
| `sound` | a run louder than the noise floor around it |

That table is the whole of the honesty of this feature. An `onset` is spectral
flux crossing a threshold: it does not know whether it was a wingbeat, a car
door or a footstep. A `tonal` run is sustained autocorrelation periodicity, and
its frequency in hertz is a real measurement — but a whistle, a hum, an engine
and a blackbird all read as one. A `sound` run is an energy gate against a noise
floor the detector measured for itself; it is *not* speech detection. **Nothing
here classifies anything.** A mark says *when*, and it never says *what*.

The detection is pure CPU arithmetic — no model, no weights, nothing downloaded,
and the same answer on every machine. **It is a press rather than something that
happens**, for the reason reading a data track is: it walks the whole
soundtrack, about a minute of work per hour of sound, on a thread of its own, so
nothing here stops while it does.

Under the summary sit three chips, one per kind, with how many of each was kept.
Press one to take that kind off [the Marks lane](timeline.md#the-marks-lane) and
out of the `,`/`.` walk.

A run shorter than a tenth of a second is not kept: a run of one frame is a
flicker rather than a place, and a lane of them is a smear nothing can be jumped
between. The summary counts every run the sensors found, so the number above the
chips and the number on them can differ.

Two things are worth knowing before you trust a mark:

- **The first half-second of any file usually carries a mark or two that are not
  really in it.** The onset detector compares each frame against a slowly-built
  average of the recent past, and at the start of a file there is no past, so
  the earliest frames clear the bar trivially. They are weak, and the ones that
  matter are not.
- **A mark is stamped at the start of the window the sensor fired on**, so a
  jump lands slightly early. That is on purpose: landing early plays the whole
  of what was detected, and landing late clips its front, which is the part an
  onset is about.

**Marks are not in the document**: they are derived from a file and would be
recomputed identically, so storing them is how a document comes to disagree
with the file it describes. They are not on the undo stack either — undo
answers "does this change the clips", and a detected onset does not.

The control is drawn under a soundtrack and nowhere else — a file with no audio
stream is offered nothing, rather than a button that fails at the press.


## While it is connecting

A file on disk answers in about a millisecond. A URL answers when the far end
feels like it, and until it does the open is on **a thread of its own** rather
than blocking the window — the card says what is happening while it waits:

- **Connecting · 3.4s of 10** — how long it has been waiting, and against what.
- **Stop** — abandon the open now. This is a real stop: it aborts the connect,
  the TLS handshake or the read inside a tenth of a second, and the card then
  says `stopped`, which is a different word from a failure because a press is
  not a fault.
- **The deadline** ends it by itself after ten seconds if nothing answers. There
  is no way to ask for no deadline, deliberately.

**A path is not routed through any of this.** The overwhelmingly common input is
a file that probes in under a millisecond, so only a URL or a device goes
through the thread and the deadline.

**A device goes the same way, and the row says a different thing.** Opening a
device is not this application's to make fast either, so it is also started on
a thread, and the card says **Opening · 1.2s of 10** rather than *Connecting*,
because it is waiting on a driver and not on a host. **What differs is the
Stop, and the button says so: `Stop waiting`.** A device's own driver never
consults the same interrupt mechanism a URL's open does, so a press ends this
application's *waiting* rather than the open itself — the input settles at
once, saying so, and the thread is abandoned and reaped whenever the device
finally answers. `Re-probe` is how to ask again.

**What a device cannot be is a clip, and the reason is the seek rather than the
length.** `Use on the timeline` is dead for one and stays dead when you give it
a **Stop at**, because a device has no way to seek: every scrub comes back an
error, and the compositor asks a source for the picture at a *moment*, which
for a live input is either one that has not happened or one that has gone.

Where a device is watched, composed and written is [Capture](capture.md), and it
goes the whole way there: several devices on one graph, a file over them, and a
destination that is a URL. This stage is where the same `-i` is described.

## An input that is not one file

Three of ffmpeg's inputs are not a file, and each is *assembled* rather than opened.
Every one of them is set with ordinary demuxer options — `-framerate`,
`-start_number`, `-pattern_type` and `-loop` belong to `image2`, `safe` belongs to
`concat` — so they travel in the same bag `-probesize` does and are printed in front
of the same `-i`.

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

**A sequence takes a soundtrack from the ordinary place**, which is another clip. A run
of frames is a clip with pictures and no sound; a file with sound and no video is a clip
with sound and no pictures; lay the second under the first and the render is the two of
them, because that is what a track stack is for.

**Named by** is `-pattern_type`, and the `pattern` half — matching by a shell glob
instead of a number in the name — is offered only where the build has it: globbing
is a compile-time feature of libavformat, so the control is shown disabled with the
reason rather than failing at open.

**A still is a decision about how long it is.** A single picture is no time at all: a
picture is a picture, and any number of seconds you can see it for is something
somebody chose. So a still is opened as `-loop 1` with a `-t`: the loop makes the input
go on producing the same picture and the `-t` is the only thing that can say how long
it lasts. Both are **Hold for**, which is one field because they are one decision. Take
the loop away and the application says so — on the pinned bar, where the act it refuses
is — rather than putting a clip of nothing on the timeline.

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
