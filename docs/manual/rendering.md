[← The manual](README.md)

# Rendering

The rest of the Write stage, and everything with an opinion about a render
before or after it happens: the packet path, the command the settings amount
to, what came back from the last one, what a measurement of it says, and what
the whole thing costs.

## Copying instead of encoding

Five things become possible and each of them is instant and lossless, because
nothing is decoded:

| | |
|---|---|
| **Rewrap** | the same packets in a different container |
| **Lossless cut** | a span of one input, byte for byte |
| **Replace the audio** | copy the picture, take the sound from the edit or from elsewhere |
| **Extract** | one stream on its own |
| **Carry a data track** | telemetry, timecode, timed metadata — the one kind that can *only* be copied |

`Rewrap <file>` under the list is the short way to all five: it fills the list
with one copied row per stream of that input — picture, sound, cues and data
alike. `Cut <file>` beside it is the same thing with the **edit's own span** on
every row, and appears where the timeline says something a whole-file rewrap
does not: a clip nobody has trimmed describes the same file, so a second button
for it would be two names for one operation.
**It is a shortcut and not a mode** — what it leaves behind is ordinary rows
with ordinary sources, and the link `Cut` puts on each of them is as ordinary and
as visible as the source is, so everything it decided is on the screen and can be
changed or undone a row at a time. Nothing on this stage behaves differently
afterwards. It leaves the container alone, which is the whole of the remaining
decision and is taken on its own control a foot away; a subtitle track the new
container will not hold is refused by name, with the row still there to be
switched from carrying it to converting it.

**Where a copy begins is where it was asked to begin, and the packet it finds
only ever moves that earlier.** The seek lands at or before the in-point, so a
keyframe found at 4.00 s for a cut asked at 4.20 s is what the file starts on —
that has to be, or the output would start at −0.20 s. What it must not do is
move the zero *later*, which is what taking the first packet alone did to a
carried subtitle track: a stream's start is its index's or its `start_time`'s,
and a track of cues has neither, so its first packet is its first line — a
minute in, if that is where somebody speaks. An untrimmed copy of that track
came out a minute early against a picture that was encoded rather than copied,
and so had no say in the input's zero. Which is the most ordinary render there
is: keep the video, keep the subtitles.

**A copy can only start at a keyframe**, and that is the one cost worth knowing
about the whole packet path. Open a copied row and the keyframes are drawn on
the input's own clock with the in-point against them: click a mark to cut
there, or type a time and read what it costs —

> the nearest keyframe at or before 4.20 s is 4.00 s — a copy can only start on
> one, so 0.20 s more than you asked for will be at the front of the file

with `Snap` beside it. **`Follow the clip`** is beside those: the span you
trimmed on the timeline, taken across as the two numbers it already is. A
clip's in-point and a copy's `From` are the same moment on the same clock —
`-ss` before an `-i` decides where the input's zero is and a clip is cut out of
what is left — so nothing is converted and nothing is approximated. With several
clips of one input it asks which, since a copy is one continuous run of packets
and two clips are exactly the case where it is not. It refuses a clip with a
[speed](timeline.md#speed) on it, and says so: a copy hands over the packets as
they were read, so a copied stream plays at the file's own rate whatever the
composited picture is doing — the span would be right and the stream would drift
against the picture it was chosen to accompany. Encode that one instead.

**And it keeps following.** Trim, move or ripple that clip afterwards and the row
moves with it. The row says which clip it is following and offers to `Stop
following`, which leaves the two numbers exactly where they are — breaking the
link is not undoing the trim. `Cut <file>` binds every row it writes to the clip
it took the span from, so a lossless cut goes on being the cut you made rather
than a photograph of one.

That is a link and not a hidden mode, and the difference is the whole design. What
a following row keeps is `From` and `To` — the same two fields you can type in, so
the printed command, the warnings and the render cannot tell a followed row from a
typed one and there is no second place the span lives. Delete the clip and the
link **breaks and says so**, with the numbers left where they were, because a row
quietly pointing at a shot that is gone is the invisible mode worth being afraid
of. The link travels in the [document](document.md), by clip id, which is the same
name the graph's anchors are written against; it is deliberately *not* carried into
the next edit through the workspace, where clip 7 is a different shot.

Where the keyframes are is asked of the demuxer's own index,
which is instant for mp4 and Matroska; a container without one is read, and
the panel says which of the two happened and whether the list was cut short.
Every packet of a sound stream stands on its own, so a copied soundtrack starts
exactly where it is asked to and says so instead of drawing a strip.

**A data stream is a row like any other, and it is the one kind that has no
other way to be.** `+ Data` appears when one of the open inputs has such a
stream — an action camera's telemetry, a camera's timecode, timed metadata that
`-map` carries and `-c copy` writes. Nothing here makes one, converts one or
reads one: what the samples mean belongs to whatever the track was written for,
which is exactly why carrying them through untouched is worth doing and
interpreting them is not. So the row has no encoder menu, no bitstream chain
and no keyframe strip — every sample stands on its own — and the only decision
on it is the span.

What it is named by is the **fourcc**, not the codec. `gpmd`, `tmcd` and `mebx`
all decode to nothing and all probe as `bin_data`, so the codec name cannot
tell one from another and a file with two of them would offer the same entry
twice; the Sources stage puts the tag on the line for the same reason — and the
tag is now also what decides whether such a track can be *read*, which is a
different question from whether it can be carried. See [Reading a data
track](sources.md#reading-a-data-track). The tag
travels into the output with the packets, taken from the input rather than
looked up — a muxer's tag tables are picture, sound and cues, so there is
nothing to check `gpmd` against, and a copy that dropped it would write a track
of the right length at the right times that nothing can identify. Whether the
output container holds a data track at all is the muxer's own answer and
arrives from `avformat_write_header`: mp4, mov and MPEG-TS carry one, Matroska
refuses one and the render says so naming the row.

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

## The command

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

## What the render said

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

## Measuring, and doing something about it

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

**`Measure to here` runs part of it.** A measurement at one point of a graph
does not need the rest: a `cropdetect` on one clip's decoded picture needs that
clip's file and the filters between the two, and everything else — the other
clips, the filters after it, the composite it is laid into, the mix beside it —
is decoded, run and thrown away so that four numbers can be printed. So a node's
panel offers to stop the render there. Only what the node depends on is built,
only the files that feed it are opened, and the note says how much of the graph
that was: `Measuring 2 of 14 nodes, 1 input`.

It is the pair of the ▶ on the card. A preview answers *what comes out of here*
with a picture; this answers it with a number, and both are cut from the same
model by the same printer — so a node's number is as much "what the render would
do" as its picture is. Two differences, and both are the same reason:

- **No scaling.** A preview ends in a `scale` because a card is three hundred
  pixels wide. A measurement must not: `cropdetect` on a scaled picture answers
  in the card's pixels, which is four plausible numbers about a picture nobody
  is rendering. The pad is taken at whatever size libavfilter made it.
- **No waveform.** A sound pad previewed is drawn by `showwaves`, because a
  sound has to be *looked* at to be judged. A sound pad measured is read off
  `ebur128` or `astats`, which have said everything they have to say without a
  picture — so the render carries four black pixels once a second, which is the
  smallest thing that satisfies the renderer's rule that a render has a picture
  in it.

The button is on every node, not only on the ones that measure, because
**nothing here knows which filters measure and nothing here should**: what makes
a filter a measurement is that it emits metadata or logs, which is true of any
of them. What is being chosen is where the render stops. Whatever measured
among the ancestors reports; the Report drawer reads it exactly as it reads a
whole-graph one. And because this is the one stage where something is nearly
always rendering — the node previews fill in as the graph settles — a press
while the slot is held **queues** rather than failing, and the previews stand
aside until it has had its turn.

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

**And a finding is refused once it stops describing what is on screen.** A
measurement is about the render it was taken during: move a clip, wire a filter,
change the canvas, and four plausible numbers go on sitting there about a
picture nobody is looking at any more, which is the same failure as a
`cropdetect` that had not settled and is harder to notice. So each render
records what it was *of* — the inputs, the clips, the printed filter chain, the
canvas and the range — and the drawer compares. When they differ the bar says
`measured before the last edit`, the offer is withdrawn, and the sentence takes
its place; the raw line it was read out of stays, because it is still true about
the render it came from. `Measure now` is one press away.

What counts as a difference is **derived from the spec rather than listed**. A
hand-written list of fields would have to be extended by whoever adds the next
kind of edit and the failure of forgetting is silent — a finding that goes on
looking current. What is deliberately outside it is the *output*: the container,
the codecs, the bitrate and the file's name change how a result is written and
not what the filters were shown, so typing a title does not invalidate an hour's
loudness measurement. Applying a `cropdetect` result marks its own measurement
stale, which is not a quirk: the graph now has a `crop` in it and the bars it
found are no longer there to find.

A window that moved is told apart from an edit that moved, and said differently.
The A/B comparison and the node previews render two seconds out of the middle of
the range, which is what they are for — so their findings are reported as being
about *part of it*, naming both spans, rather than as somebody having changed
something.

**`Re-measure when stale` does it for you, and it is off.** With it on, a finding
that has stopped describing the edit measures itself again once the edit holds
still, and the offer comes back without a press. It is a toggle rather than the
behaviour because whether a render is cheap enough to spend without being asked is
a question about *your* machine — a 4K graph re-run every time a clip is nudged is
not a decision to take on somebody's behalf — and once you have answered it, it is
answered. It is remembered under its own key rather than with the encoder
settings: it names no muxer and no encoder, it belongs to the drawer rather than to
the Encode stage, and everything in that other blob is in that stage's undo stack,
where a `Ctrl`+`Z` that quietly turned re-measuring on would be the surprise the
two stacks exist to prevent.

Four things it will not do, which are most of what makes it safe to leave on:

- **It never takes the one job slot.** A render, either half of the A/B
  comparison, a node preview and a recording all hold it, and a re-measure that
  finds it held is *dropped* — the drawer says `did not re-measure:` and why.
- **It never queues.** Waiting for a render to finish would mean firing when the
  reason had gone: the edit may have moved again since. The next attempt needs a
  fresh reason.
- **It cannot loop.** One attempt per edit, and the edit is identified by the same
  record the staleness comparison is made against — so a re-measure whose own
  findings somehow came back stale is not tried again.
- **It never fires mid-gesture.** The edit reports every mouse position of a drag,
  so it waits for the edit to hold still first, the same way the program monitor's
  preview does.

## What the settings cost, as a number

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

## Preview

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
