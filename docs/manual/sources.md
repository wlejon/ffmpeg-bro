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
