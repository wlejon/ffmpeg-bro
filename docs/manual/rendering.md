[← The manual](README.md)

# Rendering

The rest of the Write stage: copying packets instead of encoding, the printed
command, what the render reported, measuring a render, and previewing what
your settings cost before you spend the time on the real thing.

## Copying instead of encoding

Five things become possible and each is instant and lossless, because nothing
is decoded:

| | |
|---|---|
| **Rewrap** | the same packets in a different container |
| **Lossless cut** | a span of one input, byte for byte |
| **Replace the audio** | copy the picture, take the sound from the edit or from elsewhere |
| **Extract** | one stream on its own |
| **Carry a data track** | telemetry, timecode, timed metadata — the one kind that can *only* be copied |

`Rewrap <file>` under the stream list fills it with one copied row per stream
of that input. `Cut <file>` beside it does the same with the edit's own span
on every row, and appears wherever the timeline has something a whole-file
rewrap does not. Both are shortcuts, not modes: what they leave behind is
ordinary rows with ordinary sources, editable or removable a row at a time.
The container itself is chosen separately; a subtitle track the new container
will not hold is refused by name, with the row still there to switch it from
carrying to converting.

**A copy can only start at a keyframe.** Open a copied row and its keyframes
are drawn on the input's own clock with the in-point marked against them —
click a mark to cut there, type a time and see what it costs:

> the nearest keyframe at or before 4.20 s is 4.00 s — a copy can only start
> on one, so 0.20 s more than you asked for will be at the front of the file

`Snap` sits beside it. **`Follow the clip`** takes the span you trimmed on the
timeline directly. With several clips of one input, it asks which, since a
copy is one continuous run of packets. It refuses a clip with
[speed](timeline.md#speed) on it — a copy plays at the file's own rate no
matter what the composited picture is doing, so the stream would drift
against the picture it accompanies. Encode that stream instead.

**A following row keeps following.** Trim, move or ripple the clip afterward
and the row's `From`/`To` move with it; `Stop following` breaks the link
without changing the numbers. Delete the clip and the link breaks and says
so, rather than quietly pointing at a shot that is gone.

Reading a copied row's keyframes costs a read of the file (or, for a URL
input, a download) the first time the row is opened, and it stops after half
a second — for a long stream this may only cover the first minute or so, and
the panel says how far it got:

> 7 keyframes, from the packets, read — and the reading stopped at 13.97 s, so
> there are more further in

An in-point past that point is answered *not known* rather than guessed.

**A data stream is a row like any other** — an action camera's telemetry, a
timecode track, timed metadata. `+ Data` appears when an open input has one.
Nothing here reads or interprets the samples; the row has no encoder menu, no
bitstream chain and no keyframe strip, only a span. It is named by its
**fourcc** rather than its codec, since `gpmd`, `tmcd` and `mebx` all decode
to nothing and would otherwise look identical. Whether the output container
can hold a data track at all depends on the muxer — mp4, mov and MPEG-TS
carry one, Matroska refuses one and the render says so naming the row. See
[Reading a data track](sources.md#reading-a-data-track) for reading one back.

**A copy conflicts with the edit, and every conflict is named rather than
ignored:**

| | |
|---|---|
| more than one clip | a copy is one input's packets, so nothing stacked, cut or laid beside it will be in the file |
| a filter on the graph | never decoded, so there is no picture for a filter to work on |
| a crop, or an opacity | the packets go into the file as they are |
| an output of a different size | a copy is not resized |
| a container that will not hold the codec | refused, with both named |
| a codec chosen on a copied row | there is no encoder to configure |
| the same container it came from | treated as a rewrap into the container the file is already in |

Open a row and it says what the stream carries:

- **Language** — ISO 639-2.
- **Name** — what a track menu shows.
- **Flags** — a toggle per disposition (`default`, `forced`, `comment`,
  `hearing_impaired`, and the rest libavformat has). Several at once, because
  a track can be forced *and* a commentary.
- **Tag** — the fourcc, offered from the vocabulary the chosen muxer actually
  takes. `hvc1` and `hev1` are the same HEVC bitstream and only the first
  plays on Apple hardware. An unrecognised tag is flagged here rather than
  failing later with an opaque muxer error.
- **Metadata** — anything else, as key and value.
- **Bitstream filters** — the packet chain, in the order it runs. This works
  on already-encoded packets between decode and mux, so nothing it does costs
  a re-encode: `h264_mp4toannexb` rewrites NAL framing, `hevc_metadata` edits
  the VUI, `dump_extra` repeats parameter sets so a stream can be joined
  mid-flight, `setts` rewrites timestamps. Order matters — it is drawn as a
  numbered, reorderable list, and the menu is narrowed to filters that apply
  to this stream's codec.

**An attachment is a row and a chapter is not.** An attachment is a real
stream with its own index — a font beside a subtitle, a cover image. A
chapter has no index and no player shows it in a track menu, so it is drawn
as a table beside the stream rows rather than as one of them.

The A/B preview and every node preview on the Graph stage always use one
video stream and one audio stream, regardless of what the stream list has —
they exist to show what something does to a picture, not to prove out extra
tracks.

## The command

Under every stage, live, is the invocation about to run. Open it and it lays
the filter graph out a chain per line; `Copy` puts the whole thing on the
clipboard, so a render built here can be taken to a server and run.

It is drawn as **two kinds of statement, because they are not equally true**:

- **Exact** — everything but the filter graph. Those keys are literally what
  the render is configured with, the same way the `ffmpeg` command line's own
  arguments are applied. Not a description of the render; the render.
- **Equivalent** — the composition. With nothing of your own on the graph,
  this application composites internally rather than running a filter graph,
  so the graph shown is a translation, and it is dimmed to say so.

Put a filter of your own on the graph and the second line changes to
**Run, not translated**, because the render genuinely goes through
libavfilter at that point and those are the chains it parses.

An edit the graph cannot express faithfully produces **no graph and a
reason**, rather than an approximation — a command that is nearly right is
worse than none, because the only reason to print one is that it can be run.
When it applies, the notes under the command also say when a rate mismatch
between a source and the render means a composited frame is not exactly the
one `overlay`'s own frame sync would have picked, and when cues are being
drawn into frames by ffmpeg's own `sub2video` mechanism rather than a
filtergraph link — both cases where "equivalent" is doing real work.

One thing genuinely cannot be said as an argument: chapters. ffmpeg reads
chapters from an input rather than an option, so the command notes that they
are not expressible on the line even though the render writes them.

## What the render said

Under the command bar, and under every stage, is its counterpart: what came
back. Collapsed it is one line — *"The last render: 1 warning · 9 series ·
207 samples"* — and `R` opens it from anywhere; `R` again shuts it, and open
it is exactly as tall as what it has to say.

Two kinds of thing appear here, because they are not the same kind of fact:

- **Messages**, levelled and attributed — an encoder announcing the profile
  it settled on, a muxer refusing a tag, each with its source. Filtered to
  warnings and errors by default; `Everything` shows the rest.
- **Measured**, which is what a filter found. `cropdetect`, `blackdetect`,
  `silencedetect`, `ebur128`, `signalstats`, `astats`, `psnr`, `ssim` and the
  rest of that family answer a question rather than paint a picture, and what
  they find arrives here as a named series sampled at the frames it came off,
  drawn as a line, while the render runs.

Nothing is cleared when a render ends — the messages matter most once it is
over. `Clear` is a deliberate button rather than something that happens on
its own.

## Measuring, and doing something about it

Any filter that answers a question rather than changing a picture reports
here — there is no fixed list, since what qualifies is simply that it emits
metadata or logs.

**Starting one is placing a filter on the graph**, and stays that way. The
Report drawer offers shortcuts — `Crop`, `Black`, `Scenes`, `Freezes`,
`Levels`, `Silence`, `Loudness`, `Sound levels` — each the same gesture the
Graph stage's palette offers, so the node it adds shows up on the graph and
in the command bar too. The shortcut also sets the options that make a filter
answer at all — `ebur128` says nothing without `metadata=1`, for instance.

`Measure now` runs the graph and range for real, with the output thrown away
(`-f null -`) — it costs the decode and the filters and leaves no file.
`Measure to here`, on a node's own panel, runs only the part of the graph
that node depends on, which is faster when you only need one answer partway
through a large graph; the note under it says how much of the graph was
built. Measurements taken this way carry no scaling and no card-sized
waveform substitute — a `cropdetect` or `ebur128` result is read from the
pad's own resolution, not a preview thumbnail's.

**Reading a series is a plot.** Click one to open it against the render's
range: axes, a hairline grid, up to six lines at once, a crosshair reading
every value under the pointer, and a click that moves the playhead there.
Colours stick to a series once you pick it. Series that don't share a scale
are normalised and the axis says so.

**Acting on a finding is the point**, where the filter supports it. Each is
either offered a next step or refused with a reason — never silently
approximated:

| | |
|---|---|
| `cropdetect` | the crop it found, added to the graph right after the filter that measured it |
| `ebur128` | `loudnorm`'s measured parameters — integrated loudness, range, threshold, true peak |
| `blackdetect`, `silencedetect`, `freezedetect`, `scdet` | cut points on the timeline, one at each end of every span |

The refusals matter as much as the offers: a `cropdetect` still finding
letterbox near the end of what it saw is refused, naming both readings,
because a crop taken before the filter settled would cut real picture off. An
`ebur128` that hasn't reached the end of its input has no summary at all. A
picture that already reaches every edge is offered no crop, and says why.

**A finding goes stale when the edit moves under it.** Move a clip, wire a
filter, change the canvas or the range, and the offer to act on an old
finding is withdrawn — the bar says `measured before the last edit` — while
the raw reading stays visible, since it is still true of the render it came
from. `Measure now` is one press away. A window that moved (the A/B
comparison or a node preview measuring two seconds out of the middle) is told
apart from an edit that moved, and reported differently: it says it is about
*part of* the render rather than implying something changed.

`Re-measure when stale` does this automatically once the edit holds still,
and is off by default — whether a render is cheap enough to spend unasked is
a decision about your own machine. It never takes the render slot from
anything else (a render in progress simply causes a skipped attempt, noted in
the drawer), it never queues behind one, and it fires once per edit rather
than looping.

## What the settings cost, as a number

The A/B stage renders the same seconds twice — at the chosen settings, and
losslessly — then compares them:

> **measured** PSNR 43.62 dB · SSIM 0.9912 — *against the lossless half*

Which metrics are available depends on the build: `psnr` and `ssim` are in
every build, `libvmaf` only where the build was compiled with it. The number
under the wipe is the whole comparison combined across every frame, not a
single frame's score — a frame at the top of a GOP typically scores several
decibels above what follows it, so a per-frame number would flatter the
setting.

## Preview

`Render preview` encodes a few seconds — 1 to 10, from wherever you were
looking, at the exact settings you've chosen — and the same frames
losslessly, then lays one over the other with a wipe you can drag. The
lossless half is what the compositor produced before any encoder touched it,
so the difference on screen is exactly what the settings cost.

Underneath: what those seconds weighed, the bitrate they came to, and the
size the whole render extrapolates to (the number the summary elsewhere on
the stage then quotes). Also how fast it encoded, and so how long the full
render will take.

It plays, and the two halves run together to the frame — banding and motion
artifacts don't show on a still. `Space` starts and stops it, the arrow keys
step a frame at a time, and the scrub bar under the picture seeks both sides
to exactly the same frame. The timecode shown is the **timeline's**, with a
marker on the range strip below, so you can go back and find the same moment
on the edit.

Changing the quality re-renders only the candidate; the reference does not
move, since it is of the same source frames either way. Changing the size or
the edit invalidates both. Both files are temporary and are overwritten on
each render — the lossless one is large, on the order of 15 MB per second at
720p.

**Range** is the strip across the bottom: the whole edit with one bar per
track, the part being previewed picked out. Drag its ends to preview a
different part of the timeline, or drag the lane beneath to move the sampled
window without changing its length.

**Sound** is mixed the way the real render mixes it — every clip under the
playhead contributes, at its own level and mute.

**Colour** is converted rather than reinterpreted: sources are decoded
through their own matrix (BT.709, BT.601, BT.2020, or what the frame size
implies if the file says nothing), and the output is tagged to match what was
actually written.

The render runs on its own thread — the window keeps working, the progress
bar shows a frame count, an encode rate and an estimate, and `Stop` stops it
cleanly (a stopped render still closes its file properly, so the part that
rendered stays playable). When it finishes, one button puts the result back
on the timeline.

Rotation is applied here: a phone clip shot upright is written upright, from
the file's own display matrix.
