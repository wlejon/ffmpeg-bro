[← The manual](README.md)

# Output

`Encode` and `Write` are two of the six stages on the spine — the row under
the title bar that *is* the pipeline: **Capture → Sources → Compose →
Graph → Encode → Write**. Each card says what its stage is currently set to,
so the bar reads as one statement of the whole render, and clicking the part
that is wrong is how you go and change it. `E` goes to Encode, `[` and `]`
step along the chain, `Esc` comes back to the edit.

Encode is where you choose what the picture looks like — settings down the
left, every option the encoder has down the right when you want them, an A/B
comparison across the bottom (see [Rendering](rendering.md)). Write is where
you say where the file goes.

Everything the viewer is showing is what gets written: the track stack
composited bottom-up, each clip in the rectangle its fit, scale, position and
crop put it in, at its opacity, and the grid if the grid is on.

The encoders are the reason this repo is GPL, and they are all here:

| | |
|---|---|
| Video | x264, x265, AV1 (SVT / libaom), VP9, ProRes, MJPEG, MPEG-4 — plus NVENC, AMF and QSV when the build has them, and every muxer's own default encoder |
| Audio | AAC, Opus, MP3, Vorbis, FLAC, PCM |
| Containers | every muxer this build links |

The menu is built from what this binary actually has, not a fixed list, so it
cannot offer an encoder or container that then fails. The controls change with
the encoder — x264 gets a CRF slider from 0 to 51 and ten presets, VP9's goes
to 63, ProRes gets its six profiles and no quality slider, NVENC gets
`p1`–`p7`. Picking a container narrows the codec list to what it can legally
hold.

**Start from** is the top row: six named starting points — web, small, HEVC,
ProRes master, GPU, lossless — each filtered against what this build has, and
the GPU one against what this machine has, so it is absent on a machine with
no card in it. Most renders are one of these; the controls below are for the
render that is not.

**Rate control** offers the modes the encoder actually has: constant quality,
a bitrate target, two-pass, a capped average for streaming, and lossless.
NVENC has no CRF, so its quality mode is `-cq`; x264's lossless is `-crf 0`;
VP9's is `-lossless 1`.

**Two-pass** is a mode of that control, not a separate switch, because it is
one decision — spend this many bits — taken twice: the range is rendered once
to measure where the bits are needed and once to spend them. It is one job on
screen: one Stop, one progress bar that says which pass it is in, one file at
the end. **Whether an encoder honours `-pass` at all cannot be promised in
advance** — there is no way to ask libavcodec — so a render whose encoder kept
its statistics somewhere else says so in the report rather than pretending.

**Where the keyframes go** is a different question from how often. `-g` is
the interval; `Force at` is the places:

| | |
|---|---|
| **Off** | whatever the GOP length produces |
| **Cut points** | one wherever the edit cuts — re-read from the timeline every time |
| **Times** | a list of seconds into the output |
| **Expression** | ffmpeg's own, evaluated per frame over `n`, `t`, `n_forced`… |

**Cut points** is what makes a file that can be cut again without a re-encode
up to the first following keyframe: moving a clip moves the keyframe with it,
because the list is re-read rather than written down once. The times under
**Times** are seconds into the **output**, not into the timeline.

Under Advanced, four more that are not encoder options:

- **Frame timing** — `-fps_mode`, constant or variable. [Its own
  section](#frame-timing) below.
- **Field order** — progressive, top field first, bottom field first. Choosing
  one puts the encoder into field mode and marks every frame to match. What is
  composited here is progressive, so leave this alone unless the footage was
  shot interlaced and has come through untouched.
- **Threads** — `-threads` and `-thread_type`. Zero is all cores and is the
  right default; set this only when the render has to leave a core alone.
- **Shortest** — end the file where the content ends rather than where the
  range does. Off by default, so a render never quietly writes less than the
  range asked for.

**Every option the encoder has** is available under Advanced, video and audio
each in a column with its own search — name, type, range, default, help text
and named values, read straight out of the encoder. Anything documented for
`ffmpeg -c:v libx265 -x265-params …` works here unchanged, because the
controls apply options through the same call the `ffmpeg` command line uses.
An option the encoder does not have is a render-time error, not a silently
dropped setting.

## Frame timing

`-fps_mode`, and it is a choice of two.

**Constant** walks the range forward at the output rate and stamps every
frame with its number. It is what makes a file every editor accepts, printed
with the `-r` that says what rate it is constant at.

**Variable** keeps the frame times the filter graph produced instead of
renumbering them — the difference between a chain holding an `fps`, `select`,
`framestep` or `minterpolate` coming out at the rate it made versus sped up or
slowed down by the ratio of the two rates. A picture whose timestamp does not
advance is dropped, and the report says how many were. The progress bar
counts against time rather than frames in this mode, because how many frames
the graph will make is not known until it has made them.

It is offered **only where there is a filter graph** — the button is present
elsewhere, refused, and says why. A stack of clips composited without a graph
has no frame times of its own to keep; put a rate change on the Graph stage
and there is an answer. A recording refuses it too, for the plainest version
of the reason: a device's clock is the wall clock.

A graph *derived* from the timeline is always constant, whichever mode is
chosen — the derivation is frame-synced to the render's own rate throughout.
Variable is for a filter of your own placed below that point.

## Which container

The picker covers every muxer this build links, in the same searchable shape
the filter palette uses — there is no curated "supported containers" list.

A muxer is chosen **by name** (`-f matroska`), which is the only thing that
identifies one — several share an extension and many have none at all. The
extension is a consequence, not the choice.

You can filter the list by:

| | |
|---|---|
| **Fits** | will hold the codecs this render is currently set to |
| **Files** | has an extension and writes a file it opens itself |
| **Pictures** | an intra-only video codec and no audio — image2, gif, the single-frame writers |
| **Streaming** | writes through a protocol rather than to a file |
| **Devices** | libavdevice's own |

and a text search over the name, description and extensions — "mkv" finds
Matroska even though nothing is called that.

**Some muxers cannot say whether they hold a given codec.** MPEG-TS is one.
Where that happens the codec is left unfiltered rather than hidden, and the
row is marked *does not say* instead of being treated as a refusal. A muxer
that genuinely refuses a codec still narrows the list, and the codecs it
refuses are shown marked rather than removed, so you can see why the one you
wanted is missing.

Beside the picker, every option the muxer has — `movflags`, `hls_time`,
`mpegts_service_id`, and libavformat's generic ones — in a searchable column
exactly like the encoder's. Changing the muxer empties the option bag, because
an option that belonged to the old one is usually an error on the new one.

### Streaming & Recovery

When streaming to a remote endpoint (RTMP, UDP, SRT), network interruptions can cause libavformat to abort the render. Enabling **Keep trying** wraps the output format in ffmpeg's `fifo` pseudo-muxer (`-f fifo -fifo_format <muxer>`), queueing packets in memory and attempting reconnects automatically. When sending to multiple destinations, configure fifo per-destination so a drop on one endpoint does not halt the others.

## Writing pictures

`image2` writes a *set* of files rather than one, and the filename says which:
`out%04d.png` is a run of pictures, `out.png` is one picture overwritten every
frame. Picking image2 puts a frame number in the name, and **Numbering** says
which you meant — `A file per frame`, or `One picture` (`-update 1`).

Under it, the names that will actually land on disk — the first few and the
last — because a `%04d` pattern is easy to get wrong once and then not trust.
`-start_number` sits beside them, since a run does not have to begin at one.

One PNG of the frame at the playhead is the fastest way to get a still out of
an edit: `One picture`, and a range of one frame.

**Here alone, the extension chooses the encoder.** `.png` is PNG data and
`.bmp` is BMP data through the same muxer — image2's extension names a codec
rather than a container. Left unnamed, image2 defaults to MJPEG whatever the
file is called, so the extension is what decides.

## The shape of the stage

`Write` reads as three zones, top to bottom then left to right: **where it
goes**, a band across the top; **what is in it**, the stream list under the
band; **what will come out, and go**, the rail down the right with `Export`
directly under the read-back.

## Where it goes

The band's left cell is the destination: the path, above everything else,
read all the way to the end rather than elided — `Choose…` and the filename
the render will actually write sit under it, along with what happens to
*this* destination if it drops and whether there's another version. The right
cell holds the muxer and, on the same line, which of four shapes the
destination is:

| | |
|---|---|
| **one file** | what nearly every render is: opened now, closed when the render ends |
| **a set of files** | `image2`, `segment`, `hls`, `dash` — pictures, segments, chunks, and the playlist that names them |
| **a stream** | a URL through one of the output protocols this build links |
| **several at once** | `-f tee`: one encode, several destinations |

Which shape it is is asked of the muxer rather than chosen from a mode
control, so there is no second answer that could disagree with the first.

Each shape gets what it needs. A URL says which protocol it names and whether
this build has it — a URL naming an absent protocol fails at open with a
message about the filename otherwise. Beside the muxer's option column is the
protocol's own (`srt` reports around 38 options, `rtmp` about twenty), and
they travel together the way the Sources stage handles the reading end. A key
neither recognises stops the render rather than being ignored.

## When the destination goes away

A file on this machine does not stop existing mid-render. A URL can: a socket
closes, a stream key is rejected, a network drops. Without anything set, that
is a **failed render** — libav's own message in the report, whatever had
already been sent closed properly, and nothing to do but start again.

`If it drops · Keep trying` is the other answer, offered only when the
destination is a URL. It wraps the muxer in ffmpeg's `fifo` pseudo-muxer — a
queue, a background thread, and a reconnect loop — with four dials read from
that muxer, so a blank field means its own default:

- **Queue** — how many packets may be waiting.
- **Wait** — how long between attempts, in seconds.
- **Give up after** — a number of attempts. Blank never gives up.
- **When it fills** — *Drop* (the render keeps its pace and the oldest
  packets go) or *Drop, resume on a keyframe* (the same, and nothing is sent
  after a drop until there is a picture the far end can start from).

fifo's third mode — block until the queue drains — is not offered: it can
leave a render to a destination that never comes up retrying forever past a
Stop press. Blocking is the right behaviour only for a destination that is
merely slow, and stays reachable through a hand-written option spec if you
need it.

**A render that reconnected is not one that never dropped, and the report
says so** — the file has a gap exactly as long as the destination was gone,
and the reconnection count is in the note beside the written-file summary.
**A destination that cannot be reached at all is not a refusal here**: the
render starts, queues on its own thread, and reports at the end that it never
connected — which is the point, since a URL that isn't there *yet* is
precisely what this is for. An option nothing recognised is likewise reported
at the end rather than before the first frame.

The command bar prints `-f fifo`, with the real muxer as `-fifo_format`'s
argument and its own options in `-format_opts` rather than as flags — a
`-movflags` handed to `fifo` itself is an error.

**It does not apply to `tee`**: one fifo in front of several destinations
would be one queue and one recovery for all of them, so a single flaky
endpoint would take every other destination down with it. For a tee
destination, wrap that one row by hand — set its `-f` to `fifo` and give it
`fifo_format=<muxer>` in its own options, the way ffmpeg's own documentation
shows. A version with its own URL destination gets its own wrapping the same
way; one that writes to a file gets none.

The reading end has its own reconnect options (`-reconnect`,
`-reconnect_streamed`, `-reconnect_delay_max`) in the protocol column on the
Sources stage — ordinary options, not tied to anything here.

## Several destinations at once

`-f tee` is **one encode written to several places**: the same packets reach
several muxers, so a Matroska file and an MPEG-TS stream carry the same
bitstream in different wrappers, at the cost of one encode. Two outputs at
*different* settings is a different feature — two encodes — covered in [The
same edit, written twice](#the-same-edit-written-twice).

The destinations are a list — a muxer, a target, and that destination's own
options — and the `-f tee` argument is built from the list and shown in full
underneath it, because that argument has two layers of escaping over it (tee's
own, then the shell's) and is exactly the kind of thing that should stay
visible rather than be typed by hand.

**Recording and streaming the same capture** is the case tee was built for:
one encode, one file kept, the same packets sent somewhere else at the same
time. The Capture stage takes a tee argument in its own path field; the
editor for that argument lives on the Write stage.

## The same edit, written twice

**Also write** is the other answer to "two outputs" — a 1080p master and a
720p proxy, out of one job. It cannot be a `tee`, because an encoder has one
frame size: two sizes need two encodes.

| | |
|---|---|
| `-f tee` | one encode, several places — same packets, different wrappers |
| Also write | several encodes, one edit — different sizes, different files |

A recording has a third answer of its own; see [More than one file out of one
recording](capture.md#more-than-one-file-out-of-one-recording).

**A version is a size and somewhere to put it, and nothing else.** The muxer,
codec, rate control, stream list and range are all the render's own — a
version is the same render, smaller. CRF is a quality target rather than a
bitrate, so the smaller version comes out smaller without being told to.
Beside the size you can set a different muxer for a version; left blank it is
read off the extension. Give one side of the size and the other follows the
render's aspect.

**It runs as one job.** Two versions, or a version alongside a two-pass
encode, are one Stop button and one row of progress, with the status naming
which output and which pass it is on. A version carries its own composited
stack at its own scale — a clip filling a 1920-wide canvas is not simply
cropped or stretched onto a 1280-wide one — so it renders as this application
would render that size, not the master scaled afterward. The command bar
prints a whole invocation per version, each with its own filter chain scaled
to its own size.

Two versions aimed at the same path is on the warnings list rather than
refused outright: the render succeeds and one of the two files you paid for
is gone. A version with no size and no muxer of its own is flagged too, since
it is just a second, identical encode.

## What comes back from each

Progress says something different depending on the shape:

| | |
|---|---|
| **one file** | frames of a total, a percentage, a rate and an estimate |
| **a set of files** | all of that, plus how many files have arrived |
| **a stream** | elapsed time, frames, bytes sent and the bitrate — no size, no percentage, no bar |

**`Stop` lives on the progress panel** — that is the one place it can be
pressed while a render is running.

**"Open the result" is not always one file.** For `hls`/`dash` it opens the
playlist. For a numbered picture run it opens the first picture. For a `tee`
it opens whichever destination is local. For a stream there is nothing to
open — what was sent has gone — so no button is offered.

**A destination can fail in ways a file cannot.** A port nothing is listening
on is refused before the render starts, naming the URL. A connection that
drops mid-render stops the render with the destination named and libav's own
account of it in the report drawer. Retrying is deliberately not built in
here beyond `Keep trying` above — `-reconnect`, `-rw_timeout` and the `fifo`
muxer are ordinary options in the columns beside the destination.

Two things are warned about rather than silently allowed to happen:
`+faststart` on a stream destination, which rewrites the file after the
trailer and cannot be done to something that cannot be rewound — it fails at
the very end, after everything has been sent — and a **keyframe interval
longer than the segment time**, which succeeds but quietly produces segments
of the wrong length, since a segment can only start on a keyframe.

## What is in the file

`Write` is the output's **stream list**: one row per stream the muxer will
number, in the order it numbers them. A row reads as a statement rather than
a grid of fields:

> **A2** the mix, through `aac` — *fra · "Commentary" · forced · comment*

The usual two — the composite through a video encoder, the mix through an
audio encoder — arrive without asking. `+ Video`, `+ Audio`, `+ Subtitle` and
`+ Attachment` add a row; `×` removes one, including the last video stream,
which is what makes a sound-only render.

**A stream nothing feeds is not written, and the row says so.** Drop a file
with no audio track on the timeline and the mix has nothing to be made of —
the row stays on the stage, saying it will not be written, rather than
describing a track that will not exist. Adding a file with sound puts it back
to work.

**The first word of a row is where its content comes from.** The composite
and the mix are *made* — the edit, composited or summed, through an encoder.
A **copy** is not made at all: one input's packets, unchanged, which is
`-map` and `-c copy`. A copied stream has no encoder to choose, since the
codec in the file is whatever the input already had.

A copy conflicts with parts of the edit, and every conflict is named rather
than silently dropped:

| | |
|---|---|
| more than one clip | a copy is one input's packets, so nothing stacked, cut or laid beside it reaches the file |
| a filter on the graph | a copied stream is never decoded, so there is no picture for a filter to act on |
| a crop, or an opacity | the packets go into the file as they are |
| an output of a different size | a copy is not resized |
| a container that will not hold the codec | refused, with both named |
| a codec chosen on a copied row | there is no encoder to configure |

### Opening one

`▸` opens a row, and what opens is one part of the stream at a time, as tabs:

| | |
|---|---|
| **Span** / **Cues** | what part of the source this takes, and where a copy is allowed to begin |
| **Naming** | the language, the name a track menu shows, and the fourcc the muxer writes |
| **Flags** | the dispositions, as `+forced+comment` |
| **Metadata** | `-metadata:s:` on this stream |
| **Packets** | the bitstream-filter chain |

A row only gets the tabs it can have — a composed stream has no span because
it takes the whole render range, an attachment has none of them because it is
one field to set. **A closed tab says how much is on it** — `Flags · 2`,
`Packets · 1` — so what is set on a stream is legible without opening
anything. Chapters and file metadata, above the stream list, follow the same
rule: each is a line carrying its count until there is something in it, and a
list with anything in it is always open.

### Statements and Warnings

Every statement or warning on this stage is shown directly on screen, anchored to the control or stream it describes — what a setting costs, why a control is missing, or why a stream will not be written.

### What will be written

The right-hand rail is the read-back: size, rate, length, frame count, then
the stream list again as plain statements, no controls. `Export` sits
directly under it, full width, with `Back` below that.
