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
  `srt`, `rtmp`, `udp`, `tcp`, thirty-six of them. A URL gets an **Over** row naming
  its protocol and saying whether it is one of them, because a URL naming a protocol
  that is absent otherwise fails at open with a message about a filename.
- **Connecting**, only while a URL is being opened, with the seconds against the
  deadline and a **Stop** — or **Opening** with a **Stop waiting**, when what is
  being opened is a device. See [While it is
  connecting](#while-it-is-connecting) below.
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
- **Stream**, only for an input that came from a *page* rather than from a path.
  Pasting `https://www.twitch.tv/videos/…` into **From** turns the page into the
  HLS renditions behind it — nothing is downloaded, and a five-hour VOD costs one
  HTTP request until something asks for a range of it. All of them are kept, not
  just the best: one recording is two different jobs, the picture at 1080p60 for
  the cut and `Audio Only` at a fraction of the bytes for a transcription pass,
  and picking one is an ordinary change of `-i`. What does **not** carry between
  two of them is *times* — a Twitch VOD's renditions do not resolve the ad breaks
  identically and drift apart by seconds — so a cut made against one is a search
  hint against another and the row says so.
- **What came back** — the container on one line, then **one line per stream**:
  `V0  h264  1920×1080 · 29.97 fps · yuv420p · bt709`. Everything else the probe
  reported — profile, language, pixel aspect, colour range, per-stream duration — is
  on that line's tooltip. Straight out of `probe()`, run **with the options in
  force**, so it is the answer to "what did the thing I just set do" rather than a
  description of the file as libavformat's defaults see it.

**And under the column, the act.** `Use on the timeline`, pinned, with the reason
beside it where it is dead — `A device cannot be cut`, `One picture, no time at all`,
`Never ends — set Stop at`, `No length to cut`, `Nothing to play`, `Will not open`,
`Still connecting`, `Still opening`.

## Saving a stream to this machine

`Save a local copy…` appears beside those for an input that came off a page, and
it is worth pressing before anything else you plan to do more than once.
Everything downstream reads an input *repeatedly* — a scrub, a filmstrip, a
waveform, a transcription pass, a render — and for a URL every one of those is a
network read of the whole recording. Word searches in particular want the media
on this machine: finding a phrase means transcribing around it, and doing that
over HLS is the same segments fetched twice.

What it does is a **stream copy**: the packets already on the CDN written into a
local container without being decoded, which is what
[Rewrap](rendering.md) does and is why it runs at whatever the network will give
rather than at whatever an encoder will. So the press does not start anything —
it sets the [Write stage](rendering.md) up and takes you there, with the stream
list written, Matroska chosen, a filename filled in beside your document, and the
command bar printing exactly what will happen. Read it and press Render.

Two things about what it sets up:

- **The range is yours to set, and it is the whole difference.** HLS is
  segmented, and `-ss`/`-to` on the copy rows means libavformat fetches the
  segments the window covers and no others. The whole VOD is three quarters of an
  hour of bandwidth; forty six-second hits out of five hours is 0.6% of it.
- **Data streams are left out.** Twitch's HLS carries a `timed_id3` track of its
  own segment metadata, Matroska will not hold a data stream and says so, and the
  track means nothing once the recording is off Twitch. The press says how many
  it dropped rather than the list quietly being shorter than the file.
- **Every row arrives closed, and the press reads nothing.** Opening a copied
  video row draws its keyframe strip, and drawing that means reading the file to
  find out where the keyframes are — over a network, on a container with no
  index, that is a download. `Rewrap` opens the first row because you pressed it
  on the stage you were already looking at; this press was made somewhere else,
  about a file, and lands you on a list you can read without having paid for it.
  Open a row when you want the strip. See
  [Rendering](rendering.md) for what the reading costs and what it says when it
  stops early.

Once it is set up the card offers **`Use the local copy`**, which points the
input at the file. The clips cut from it keep their times, and that is correct
here where it is not correct between renditions: this is a copy of these packets
and not another transcode of the same stream.

The input must be on the timeline first — a render is of the edit, and this one
refuses rather than appending five hours to a montage you were in the middle of.
The same job is available without the window at all: `tools/pull_vod.js` is this
press written as a script, and takes `--quality`, `--from` and `--to`.
Those mirror `openInput()` exactly, so the button is never alive and then refusing.
`Re-probe` and
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

**Which one**, under **Decode on**, is a picker of the cards this machine has
rather than a number to type. It was a text box until libav could be asked how
many there are — see [A second card](card.md#a-second-card) — because
`-hwaccel_device 1` has always been settable and nothing here could say whether
the 1 addressed anything. An index a document brought from a machine with more
cards stays selected and is marked as not on this machine, rather than being
snapped to the default: the render is refused at the open either way, and a
render quietly pointed at a different card from the one the file names is the
worse of the two.

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

## Reading a data track

A file's streams are listed as one line each, and one kind of line has a control
under it: a **data** stream whose fourcc something here can parse.

`gpmd`, `tmcd`, `mebx` and `fdsc` all probe as `bin_data`, because there is no
decoder for any of them — a data stream is packets whose meaning belongs to
whatever they were written for, and the container's fourcc is the whole of what
identifies one. That is why the tag is printed on the line here and nowhere
else, and it is also the thing a parser dispatches on: **a data stream whose
fourcc is X is read by the parser registered for X**. One is registered today,
for GoPro's `gpmd`. A real camera file carries three data tracks and two of them
get no button rather than a button that fails at the press, because `tmcd` and
`fdsc` are different formats with different specifications and a parser that
guessed at one would produce numbers nobody could check.

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

Nothing in this application knows what a `GPS5` is. The names, the units and the
divisors all come out of the payload — the parser writes down GPMF's type
alphabet and its structural vocabulary and no list of quantities at all, so a
camera firmware that starts writing something nobody has seen plots it with no
change here.

**It is a press rather than something that happens.** A probe is what makes an
input usable at all; this is a walk over a whole track that most edits have no
use for. It costs 32 ms for the 4.5 MB telemetry track of a four-gigabyte camera
file, and it happens on a thread of its own, so nothing here stops while it runs
— the same mechanism a URL's open goes through, and for the same reason.

A track that would not parse all the way through is drawn with what survived and
**says so**, counting the packets and naming the first thing it found: an empty
plot cannot be told from a file with nothing in it, and a camera that lost power
mid-write leaves good samples in front of the damage.

A series whose divisor could not be applied is marked `raw`. That is worth a
word, because it is the one number on this stage that may not mean what it looks
like: a GPS latitude without its divisor is 474305352, which is a number, and
47.4305352, which is a place.

**A reading is not in the document**, for the reason a waveform is not: it is
derived from a file, and storing an answer the next reopen may contradict is how
a document comes to disagree with the file it describes. Which series you picked
is not saved either — see [Not yet](not-yet.md).

## Finding things by sound

An **audio** stream gets a control of its own: **Find sounds**.

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

That table is the whole of the honesty of this feature and it is worth being
plain about. An `onset` is spectral flux crossing a threshold: it does not know
whether it was a wingbeat, a car door or a footstep. A `tonal` run is sustained
autocorrelation periodicity, and its frequency in hertz is a real measurement —
but a whistle, a hum, an engine and a blackbird all read as one. A `sound` run is
an energy gate against a noise floor the detector measured for itself; it is
*not* speech detection, and it is deliberately not called "voice" even though the
sensor underneath uses that word. **Nothing here classifies anything.** A mark
says *when*, and it never says *what*.

The detection is [bro](https://github.com/wlejon/bro)'s own acoustic sensor bus —
a PCEN mel front-end at 16 kHz with a 25 ms window, driving spectral flux,
autocorrelation and an energy VAD, one reading per 10 ms. It is pure CPU
arithmetic: no model, no weights, nothing downloaded, and the same answer on
every machine.

**It is a press rather than something that happens**, for the reason reading a
data track is: it walks the whole soundtrack, which is about a minute of work per
hour of sound. It runs on a thread of its own, so nothing here stops while it
does — which is the whole reason this is done in the binary rather than through
`bro.sense.analyze()` from the interface, where a five-minute clip would freeze
the window for five seconds and half an hour for thirty-one.

Under the summary sit three chips, one per kind, with how many of each was kept.
Press one to take that kind off [the Marks lane](timeline.md#the-marks-lane) and
out of the `,`/`.` walk.

A run shorter than a tenth of a second is not kept: a run of one 10 ms frame is a
flicker rather than a place, and a lane of them is a smear nothing can be jumped
between. The summary counts every run the sensors found, so the number above the
chips and the number on them differ, and they differ for a reason you can see.

Two things are worth knowing before you trust a mark:

- **The first half-second of any file usually carries a mark or two that are not
  really in it.** The onset detector compares each frame against a slowly-built
  average of the recent past, and at the start of a file there is no past — so
  the earliest frames clear the bar trivially. They are left in rather than
  hidden, because suppressing them here would make this and `bro.sense.analyze()`
  disagree about the same file. They are weak, and the ones that matter are not.
- **A mark is stamped at the start of the 25 ms window the sensor fired on**, so
  a jump lands up to 25 ms *early*. That is on purpose: landing early plays the
  whole of what was detected, and landing late clips its front, which is the part
  an onset is about.

**Marks are not in the document**, for the reason a waveform and a telemetry
reading are not: they are derived from a file, they would be recomputed
identically, and storing an answer the next reopen may contradict is how a
document comes to disagree with the file it describes. They are not on the undo
stack either — undo answers "does this change the clips", and a detected onset
does not.

The control is drawn under a soundtrack and nowhere else — a file with no audio
stream is offered nothing, rather than a button that fails at the press. There is
no build of this application without the sensors in it: `-DBRO_WITH_SOUNDML=OFF`
stops the configure and says so.

## While it is connecting

A file on disk answers in about a millisecond. A URL answers when the far end
feels like it, and until it does the open is sitting inside libavformat with a
socket in its hand. **That wait used to be this application's wait**: `probe()`
is synchronous, and this program's UI thread is the whole program — stage views
hide each other rather than being unmounted and the viewer's `<video>` elements
*are* the decoders, so a four-second open was a four-second frozen window with
no cursor, no timeline and nothing to press.

A URL is now opened **on a thread of its own**, and the card says what is
happening while it is:

- **Connecting · 3.4s of 10** — how long it has been waiting, and against what.
  The seconds are counted where the deadline is measured, so the readout cannot
  drift from the thing that will act on it.
- **Stop** — abandon the open now. This is a real stop and not a hidden spinner:
  it sets libav's `AVIOInterruptCB`, which is the only thing in libav that can
  abort an operation already in progress, and the connect, the TLS handshake or
  the read is given up inside a tenth of a second. The card then says `stopped`,
  which is a different word from a failure because a press is not a fault.
- **The deadline** ends it by itself after ten seconds if nothing answers. There
  is no way to ask for no deadline, deliberately — an open with no timeout is
  exactly the hang this is about.

Both of those are one mechanism, which is why they behave the same. A protocol's
own timeout option is *not* that mechanism, and asking libav why is instructive:
`tcp`, `udp`, `rtp`, `ftp` and the `rtmp` family carry a `timeout`, `srt` carries
`connect_timeout`, and **`http`, `https` and `tls` carry none at all** — they
open a `tcp` URLContext underneath and pass their dictionary down to it.
`rw_timeout` lives on the URLContext class rather than on any protocol, so it is
in none of the tables this stage shows, and it covers transfers *after* a connect
rather than the connect. A deadline written as an option would therefore be
missing for the protocol a URL here overwhelmingly names, and would still not
cover `avformat_find_stream_info` — which is the half of an open that reads from
the network for as long as it likes. Those options are all still reachable in the
protocol's own column, and setting one is an ordinary thing to do; they are just
not what makes this stage responsive.

**What neither the deadline nor Stop can cut short is name resolution.**
`getaddrinfo` is a blocking call in the C library with no callback in it, so a
host whose DNS is slow holds the *probe thread* until the resolver gives up.
That is the second reason there is a thread and not only a deadline: the window
keeps running either way.

**A path is not routed through any of this**, and that is the point. The
overwhelmingly common input is a file that probes in under a millisecond, and
sending it round a thread and a poll would cost every user a round trip to fix a
case few hit. What decides is a parse of the string for a scheme — it opens
nothing and asks libav nothing, so the decision cannot itself be the thing that
blocks. A `file:` URL counts as a path, because that is the long way of writing
one.

**A device goes the same way, and the row says a different thing.** `-f dshow -i
video=…` is an `-i` whose open is not this application's to make fast either —
opening a working audio device measures 920 ms here, and a camera another
program holds or a capture card mid-reset does not measure at all — so it is
started on a thread by the same call, and the card says **Opening · 1.2s of 10**
rather than *Connecting*, because it is waiting on a driver and not on a host.
What decides is the `-f` looked up in libavdevice's own registry, which is a
lookup in a list already in memory.

**What differs is the Stop, and the button says so: `Stop waiting`.** libav's
interrupt callback aborts a URL's open wherever it has got to; a libavdevice
demuxer never consults it, because it is inside COM and a driver rather than
inside libavformat's AVIO layer. Measured with a callback that counts its own
calls: **zero polls across a 400 ms `dshow` open**, and an already-aborting one
does not shorten it by a millisecond. So a press ends this application's waiting
— the input settles at once, saying so — and the thread is abandoned and reaped
whenever the device finally answers. `Re-probe` is how to ask again. The
deadline and Stop *do* reach the stream analysis that follows the open, which is
92 ms of a 92 ms `gdigrab desktop` open and 520 ms of a 920 ms `dshow` one, so
they are worth having and are not the whole story. There is no timeout to set
instead: no device demuxer in this build has one.

**What a device cannot be is a clip, and the reason is the seek rather than the
length.** `Use on the timeline` is dead for one and stays dead when you give it a
**Stop at**, which is worth saying because everywhere else here `-t` is exactly
what gives an endless input a length — a `-loop 1` still, a `-stream_loop -1`. A
device has the other half missing: a libavdevice demuxer has no `read_seek`, so
every scrub comes back `Invalid argument`, and the compositor asks a source for
the picture at a *moment* — which for a live input is either one that has not
happened or one that has gone. Measured on the renderer before it was refused: two
seconds of output off a device paced to real time cost 2038 ms untrimmed, **3040
ms trimmed one second in and 5061 ms trimmed three seconds in**, and the file was
two seconds long every time. A trim on a device is a wait of its own length with
nothing written during it. Pacing was never the problem — `av_read_frame` blocks,
so a walk over a device is already on the wall clock.

Where a device is watched, composed and written is [Capture](capture.md), and it
goes the whole way there: several devices on one graph, a file over them in a
`movie` node, and a destination that is a URL. This stage is where the same `-i`
is described.

## An input that is not one file

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

**A sequence takes a soundtrack from the ordinary place**, which is another clip. A run
of frames is a clip with pictures and no sound; a file with sound and no video is a clip
with sound and no pictures; lay the second under the first and the render is the two of
them, because that is what a track stack is for. There is nothing here about sequences:
the composite is made of whichever clips have pictures and the mix of whichever have
sound, neither knows what the other is, and a run of numbered frames is only a clip that
answers one of those two questions. It is worth saying out loud because a sequence feels
like the kind of input that would need an arrangement of its own, and it does not.

**Named by** is `-pattern_type`, and the `pattern` half is offered where the build has
it. This one does not: globbing is a compile-time feature of libavformat, reported as
"Function not implemented" from `read_header` and from nowhere else, so it is asked by
trying and the control is shown disabled with the reason rather than failing at open.

**A still is a decision about how long it is.** A single picture is no time at all: a
picture is a picture, and any number of seconds you can see it for is something
somebody chose. So a still is opened as `-loop 1` with a `-t`: the loop makes the input
go on producing the same picture, and the `-t` is the only thing that can say how long
it lasts. Both are **Hold for**, which is one field because they are one decision, and
the command bar prints the pair of them in front of the `-i`. Take the loop away and
the application says so — on the pinned bar, where the act it refuses is — rather than
putting a clip of nothing on the timeline.

That refusal is keyed on **what the input is**, not on the length it measures, and the
difference is not academic: it is the same correction the device refusal went through,
and it was hiding the same kind of hole. Only a picture opened *bare* measures zero,
through `png_pipe`; `image2` — the demuxer this application forces for a still —
measures one frame at the declared rate. That is 0.04 s at 25 fps, and a full second at
`-framerate 1`. A length test therefore let a de-looped still straight through and laid
it out as a clip forty milliseconds long, which is exactly the clip of nothing it was
written to prevent.

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
