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

`Save a local copy` appears beside those for an input that came off a page, and
it is worth pressing before anything else you plan to do more than once.
Everything downstream reads an input *repeatedly* — a scrub, a filmstrip, a
waveform, a transcription pass, a render — and for a URL every one of those is a
network read. Word searches in particular want the media on this machine:
finding a phrase means transcribing around it, and doing that over HLS is the
same segments fetched twice.

Nothing waits for the copy. A clip on a URL is [read for the span the timeline
is showing](timeline.md), so you can explore a six-hour recording while it is
still arriving — but the reads are seconds each and the waveform is bounded to a
window and taken from the audio-only rendition, which is a second or two from
the picture. The moment a copy is on this machine both lanes are read from it
instead: whole, exact and free.

What it does is a **stream copy**: the packets already on the CDN written into a
local container without being decoded, which is what
[Rewrap](rendering.md) does and is why it runs at whatever the network will give
rather than at whatever an encoder will. It runs **in the background** and
nothing here waits for it — the card grows a row per pull saying where each has
got to, with `Stop` beside it, and you carry on. A pull is not a render: it takes
no encoder, no compositor and none of the one job slot, so the Render button goes
on working the whole time.

### The soundtrack first, and then the picture

One recording resolves to several renditions and the press takes **two** of them,
one after the other: the audio-only stream, and then the picture. When the sound
lands the card says so, because that is the moment the work that needs only sound
can start — a transcription, a word search, finding where something happens —
while the picture is still arriving.

The reason they run one after the other is not the one the sizes suggest, and it
was measured on a six-hour VOD with each pulled alone:

| | rate | of the recording | size | to pull it all |
|---|---|---|---|---|
| `Audio Only` | 1.5 MB/s | 78× realtime | ~0.4 GB | ~4.6 min |
| `1080p60` | 69.6 MB/s | 95× realtime | ~15 GB | ~3.8 min |

The soundtrack is not the faster of the two per second of recording — it is very
slightly *slower*. It is latency-bound: forty times fewer bytes over the same
number of segments, so what it spends is round trips rather than bandwidth.
Queued together, the picture took the link and the soundtrack fell to a third of
its own rate. So what "sound first" buys is not a small file arriving before a
big one; it is a **searchable soundtrack on this machine in five minutes instead
of fourteen**.

The two are different transcodes of one stream and **do not share a zero** — the
ad-break discontinuities put them +0.80 s, +2.21 s and +2.57 s apart at three
points of one pair — so a time you find in the sound is where to *look* in the
picture and never where to cut it. The card says so once both are here.

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
which is the opposite of how a default usually gives way: it is the answer to
"put my downloads on the big disk", and saving the document somewhere else
afterwards must not silently move fourteen gigabytes of them. `Beside the
document` clears it and puts the first rule back. It is not in the `.fbro` file
— it names a disk on this machine, and a document opened on another would carry
a folder that is not there.

Each pull's row then names the file it is writing, so the folder above it and
the name beside it are the whole answer.

Two more things about the pull:

- **Data streams are left out.** Twitch's HLS carries a `timed_id3` track of its
  own segment metadata, Matroska will not hold a data stream and says so, and the
  track means nothing once the recording is off Twitch.
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
rows means libavformat fetches the segments the window covers and no others, and
the whole VOD against forty six-second hits out of five hours is the difference
between three quarters of an hour of bandwidth and 0.6% of it — and where another
container, a stream left out, or simply reading the invocation before it runs all
live.

Every row arrives closed there, and that is deliberate: opening a copied video
row draws its keyframe strip, and drawing that means reading the file to find out
where the keyframes are — over a network, on a container with no index, that is a
download. Open a row when you want the strip. See
[Rendering](rendering.md) for what the reading costs and what it says when it
stops early.

The input must be on the timeline for `Describe it…`, because the Write stage
describes the edit; the background pull needs none of that.

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

## Reading it

Under `What came back` there is a second section, and the difference between the
two is worth stating once because everything below depends on it.

**`What came back` is the probe.** It is what libavformat said the instant this
input was opened, under the options set above it: the container, and one line per
stream. It costs nothing and it is complete.

**`Reading it` is what this machine has been asked to work out**, beyond opening
the file. There are three of those — what a data track carries, where something
happens in the soundtrack, and what was said in it — and each is a press, because
each costs real time: thirty milliseconds for a telemetry track, about a minute
per hour of sound for the marks, ninety minutes for a six-hour transcript on a
fast GPU. Nothing here starts on its own.

Each is one row, and always the same four columns:

```
READING IT
  SOUND       A1   51 transients, 1 tonal run                       [Forget]
  WORDS       A1   large-v3 · nothing has read this for words yet   [Transcribe] [Model…]
  TELEMETRY   D2   HERO8 Black · 40 series · 708 packets            [Forget]
```

Which read, **which stream it read**, how it went, and the door. The second
column is not decoration. `Sound` and `Words` both read the soundtrack libav
picks as the best one — what `[0:a]` means on a command line — and a file with
three of them says `best of 3` until a read has run and reported which it
actually was. These controls used to be drawn under the *first* audio line, which
asserted by position an answer neither reader had given.

They were also drawn *inside* the stream list, which is what this section exists
to undo: a probe answer and a ninety-minute read are different kinds of thing,
and interleaving them put a full-width model-path field between `A0` and `V1` and
cut the readout looked at more than anything else on this stage in half.

Everything in this section is **derived**. None of it is in the document, on the
undo track or in the unsaved marker, for the reason a waveform is not: it comes
back from the file the same way twice, and storing an answer the next reopen may
contradict is how a document comes to disagree with the file it describes.

## Reading a data track

The first row is a **data** stream whose fourcc something here can parse.

`gpmd`, `tmcd`, `mebx` and `fdsc` all probe as `bin_data`, because there is no
decoder for any of them — a data stream is packets whose meaning belongs to
whatever they were written for, and the container's fourcc is the whole of what
identifies one. That is why the tag is printed on the stream line and nowhere
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

## Finding a word

The `Words` row, directly under `Sound`: **Transcribe**.

The two are beside each other because they answer the two halves of one question
— where something happened, and what was said — and somebody who has just read
one wants the other in the same place.

`Find sounds` says *where* something happened. This says *what was said*. Six
hours of somebody talking is a recording nobody is going to scrub through, and
neither a waveform nor a set of onsets can find the minute a name was mentioned.
This decodes the soundtrack and runs speech-to-text over it. What you then *do*
with the words is the [Find stage](find.md)'s, and `Search these words…` on this
row is the door — it walks there with the rule already wired to this recording,
and typing a phrase into it is the only thing left to do.

**The reading is here and the searching is there**, and the split is deliberate.
A transcript belongs to an *input* — it is a property of the file, it costs
minutes to hours, and nothing should spend that unasked — so the press that
starts one is on this stage and nowhere else. A rule on the Find stage only ever
*reads* what has been read, which is what keeps a keystroke in its phrase field
cheap enough to re-evaluate the whole graph on, and a finder wired to a recording
nobody has transcribed says which press is missing rather than making it.

There used to be a search box on this card, with the places a phrase was said
listed under it. It was the Find stage's question asked one file at a time, three
levels deep inside a probe readout, in a list that grew to a screenful — so it is
on that stage now, where the same search was already running.

**The words arrive while it is still reading.** This is the difference from every
other read on this stage. A transcript of a six-hour VOD is about ninety minutes
of work on a fast GPU, and one you could only search at the end would be one
nobody waits for — so it is searchable seconds after the press, over as much as
has been read so far, and the row says how far down the recording that is:

```
WORDS   A0   1:12:30 of 5:34:30 · 22% · 1,204 segments · 4.0× realtime · about 68 min left   [Stop]
```

That readout is not decoration. A rate is what tells a read that is working from
one that has silently stopped — 4.0× says a six-hour VOD is ninety minutes and
0.05× says it will not finish today — and neither is knowable from a percentage.
When it is done the row says `all of it` or `only the first 1:12:30 of 5:34:30`,
because "no results" over ten minutes of a six-hour recording and "no results"
over all six hours are completely different answers, and a count on its own
cannot tell you which one you are looking at.

**A hit is a place to look. It is never a cut.** Pressing one moves the playhead
to it; nothing is trimmed. That restraint is deliberate and it is about clocks: a
Twitch VOD's audio-only rendition and its 1080p rendition do not share a zero —
measured at +0.80 s, +2.21 s and +2.57 s at three points of one recording, and a
*step* rather than a drift, because an ad break is discontinuous in one and not
in the other. So a transcript read from the cheap audio-only copy is on that
copy's seconds, and a cut placed on a word boundary would land on the wrong
file's clock. The transcript takes you to the right minute; your eyes do the
rest.

Two more things worth knowing before the first press.

**The weights are not shipped, and their absence is said out loud.** A model is a
directory of files that is between 145 MB and 3 GB depending on the size, so
there is nothing to choose until you have downloaded one —
`scripts/download-whisper.sh --size large-v3` in brosoundml puts one on disk.
Until then the control names the file it could not find rather than quietly
doing nothing.

`Model…` picks the directory. The row **names** the one that is chosen, by the
directory's own name — `large-v3`, `whisper-tiny` — with the full path on the
tooltip, because which model will run is the difference between a transcript that
is right and 145 MB of guesses. It is a statement rather than a field on purpose:
the choice is remembered between runs and is the same for every input in the
list, since the weights are a property of this machine rather than of the edit,
and a per-input text box was the same value drawn once per card.

And `Transcribe` with nothing chosen **asks** rather than failing: it opens that
same picker, and starts once you have named a directory. It used to make a
failed read saying `no model has been chosen`, which was true, unhelpful, and a
dead end with an `Again` button on it.

**Size is a real choice and it is yours.** `tiny` is 145 MB and transcribes clean
speech correctly; on a stream with game audio under it, it will not. `large-v3`
is 3 GB and is the one to use if the transcript has to be right. Measured here on
an RTX 4090: large-v3 at 4x realtime, so a six-hour recording is about ninety
minutes. On a CPU the same model is days — this is a feature that wants a GPU,
and the build has to have been configured with one (`-DBRO_WITH_TENSOR_CUDA=ON`).

Like a set of marks, a transcript belongs to the **input** rather than to a clip,
so two clips cut from one recording share one, and a trim moves where the hits
land without the soundtrack being read again. It is not in the document, not
cached beside the app and not on the undo stack, for the reasons a set of marks
is not: it is derived from the file, and reading it again gives the same answer.

The soundtrack it reads is the one your local copy has, if there is one — which
is why **Save a local copy** offers the soundtrack on its own. The audio-only
rendition of a VOD is a fraction of the bytes and is all this needs.

### Pulling just the window

The payoff of the whole feature, and it is on the [Find stage](find.md) — because
what it acts on is a *selection*, and a stack of candidates is what a selection
is here.

A six-hour VOD is tens of gigabytes; the twenty seconds you actually want is a
few megabytes. The transcript found the moments, so `Pull N windows` on a stack
copies only those — `-ss` and `-t` on the input, so what comes down the link is
each window rather than the recording. They are stream copies, so they run in the
background, take none of the render slot, and jump ahead of any whole-recording
copy already queued: the windows are what you are waiting on, and the full copy
is the thing you started so that you could get on.

**The ten seconds either side are not slack.** They are the two clocks again: the
transcript was read from the soundtrack rendition and the picture rendition does
not share its zero, by up to 2.6 s on the recording that was measured. A window
that hugged the words would sometimes not contain them. The span pulled is the
candidate's own, pad and all, so the file matches the number the rule's card
shows — which is why the `Either side` field on a `Said` rule is the one place
that number is decided.

When they land, `Open N here` opens them as inputs of their own — new ones, not
the recording repointed, because each genuinely is a different file with its own
zero. They appear on **this** stage with cards like anything else, and `Use on
the timeline` puts one in the edit. One press more, and no second way in.

A recording already on this machine is offered no windows to pull. There is
nothing to fetch, and copying twenty seconds out of it to somewhere else is not
something anybody is waiting for.

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
