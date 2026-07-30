[← The manual](README.md)

# Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own media — two files with known content, a moving bar over a
gradient and a tone at a known level, differing in size, aspect, frame rate and length,
and a third with **no audio stream in it at all**, which is not the same file as one
whose soundtrack is quiet and is the only thing that separates "the mix" from "a mix
nothing feeds" — and runs every suite against them. Three more are each about a stream
the rest take for granted: one with **no video stream in it at all**, the mirror of
the silent one and the only thing separating the composite from a composite nothing
feeds; one whose pictures carry a **display matrix**, which is the only thing
separating a clip laid out upright from one laid out on its side; and one with a
**`gpmd` data track**, which is a stream that is neither picture, sound nor cues and
is identified by its fourcc alone. None can be faked with content: a picture that
happens to be black is not an absent one, a picture that happens to be tall is not a
rotated one, and a track full of bytes is not a track something can still find by
name. Nothing is checked in and nothing depends on what a file you happened to have
lying around contains.

A UI suite is given one more thing before it starts: **no leftovers**. `localStorage`
is written beside the application, so `ui/.storage.json` outlives the run that wrote
it — which is what makes remembered settings work and what makes a suite unrepeatable,
since every reader in `ui/` is written to sanitise a blob left by an older version of
this code and a suite that finds one is not testing the input it states. `ctest`
removes the file first, as a fixture of the same kind as the media. Running a suite by
hand does not, so delete it yourself if a result surprises you — a failure caused this
way names whatever the leftover state confused, not the file that confused it.

Each suite also runs standalone against any real file, which is how to check behaviour
against footage the fixtures do not resemble:

```
./build/Release/ffmpeg-bro-decodetest <file> [--rotated <file>] [--sound-only <file>]
./build/Release/ffmpeg-bro-exporttest <file> [<file2>] # renderer: geometry, opacity, mix, cancel
./build/Release/ffmpeg-bro-captest <file>            # muxers, demuxers, protocols, devices, decoders
./build/Release/ffmpeg-bro-inputtest <file> [<rotated>] [<cues>]  # an -i: forced demuxer, options, window, token, filters
./build/Release/ffmpeg-bro-seqtest <fixture-dir>    # sequences, stills, -stream_loop, concat, image output
./build/Release/ffmpeg-bro-capturetest out         # devices: an endless input, recording one, and a session of several
./build/Release/ffmpeg-bro-hwtest <file>           # the GPU: what is here, is it the same picture, what does each path cost
./build/Release/ffmpeg-bro-headless ui/ tests/ui_player.js -- <file> [<file2>] [<rotated>] [<sound-only>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sources.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_hardware.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_sequence.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_export.js -- <file> [<video-only>] [<sound-only>] [<with-data-stream>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_report.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_measure.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_subtitles.js -- <fixture-dir>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_document.js -- <file> [<file2>]
./build/Release/ffmpeg-bro-headless ui/ tests/ui_output.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_capture.js       # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js   # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js [-- <file>]  # media only for the last two sections
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

**Several files out of one recording** is asserted by reading them back, because a
size check alone passes for a second copy of the master and the whole claim is that
it is not one. `capturetest` records one graph — `split`, one branch cropped — into
two files and checks that the second is 160×120 where the first is 320×240 *and* that
their mean colours differ, which a `tee` of the same encode could not do; then it
records a proxy beside a master with no graph at all, where the two means agree and
only the size differs, which is the other reason for a second file. `ui_capture.js`
does the same through the stage: a `split` and a `crop` wired on the Graph stage, an
Also-write row pointed at the output of its own, the command bar asserted to map both
pads on one line, the clash of two files at one path caught before the press, and
then the recording run — the second file half the width of the first, off the disk.

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

Both burn-in points are driven: the one over the whole canvas from the Sources
stage, and the one on a clip from its properties panel — where what is checked
is the anchor (above the `setpts`, which is the clock the cues are on), the
`si=` that is *not* written because the track is the first of its kind despite
being stream 2, and the clip's element ending up pointed at a `/@fx/` view whose
chain starts with the filter. The stream that proves `si=` counts subtitle
streams rather than streams is written out in the test as a shape rather than
made as a file, because two subtitle tracks in one container is not a fact any
fixture here exists for; the end-to-end half runs against the mp4 the same test
rendered a page earlier.

The window is driven twice over the same two numbers, once with the row
carrying and once with it converting, because the two keep different cues: at
an in-point of 4.5 s a conversion keeps one of the fixture's three and zeroes
the output at 4.5, and a copy keeps two and zeroes it at 4. Both claims are
made against a rendered file in the export suite as well as against the panel
here, since which cues survive a window is exactly the sort of thing a UI can
be confidently wrong about on its own.

The fixture generator writes `cues.srt` and `cues.ass` beside the video, with
the cues placed so that a burn-in is **measurable**: a second of picture with
nothing over it, a second with a line over it, a second with nothing again. The
export suite renders the same seconds with the filter and without it and
compares them at both moments — 99 dB apart before the cue and 31 dB during it.
Either half alone proves nothing, because a filter that did nothing passes the
first and a filter that ruined every frame passes the second.

`ui_document.js` is the whole edit through a file and back — see
[The document](document.md). The shape is a round trip, and the step that makes
it mean anything is the one in the middle: after saving, the suite starts a new
document, opens a *different* file, and only then reads the saved one back. Skip
that and every assertion below passes for free, because the model was never
actually cleared.

What it checks is mostly **identity**, which is why it takes two videos rather
than one. A filter is inserted against `clip:<id>/after-scale` and a source node
is placed naming the second input's id; after the round trip both have to point
at the same shot and the same file, and one file cannot tell a renumbering from a
correct answer. It also asserts the two negatives that the design turns on — that
a clip in the file carries no probe and no name, because both are its input's
answer, and that a snapshot does not change when the model does, because an undo
stack is a list of them and one that shared its objects would be N copies of the
present. The failure cases are driven too: a document whose input path has been
edited to something that is not there opens *short*, with the input carrying
libav's message and the clips of it named as left out, and a file that is not
JSON at all is refused by name rather than by a stack trace.

The undo half of the same suite drives the three rules that decide what a step
is, in the change channel's own vocabulary rather than through a synthesised
drag: twenty `move` events and one `moved` are one step, three `edit`s inside
half a second are one and three either side of the gap are two, and a change that
changed nothing is none. The assertion worth naming is the cheap-looking one —
that a clip is still being decoded by the same element after an undo — because
that is the whole reason `open()` reconciles instead of rebuilding, and nothing
else in the suite would notice if it stopped.

Then **the other track**, which is the boundary asserted from both sides: a press
on a stage about the timeline leaves the form alone, and a press on the encode
side is about the form and adds no step to the edit's stack at all. It is driven
through the *Start from* row, because a preset is the press this exists for — the
test walks the row until one of them actually changes what will be written, since
which preset differs from the default depends on what this build can encode. What
comes back has to be the codec, the rate control and the quality it was, and the
control in front of you has to be showing it: the form draws from `settings`, so
an undo changes the model behind its back and a redraw that stopped happening
would leave the preset's value on screen under the old settings. Arriving on the
encode side is asserted *not* to be a step.

`ui_output.js` is the render on the program monitor instead of the clips — see
[The output, instead of the clips](playback.md#the-output-instead-of-the-clips).
**Nothing in it compares pixels**, and that is deliberate rather than a gap: a
screenshot is for the record and the picture on the screen is the host's. What is
checkable is every claim the mode makes about itself, and each of those is a
thing that could silently stop being true — that the preview is the render's own
source and says which of the two renderers it is, that a moved playhead is a new
source rather than a seek, that the clips underneath are parked and not playing,
and that a graph libavfilter refuses arrives as libavfilter's own sentence on the
stage rather than as black.

Two of the checks are there because the behaviour broke in review rather than
because it looked interesting: an edit made *while* the preview is playing has to
go on playing — a re-point hands the element a new src, and a new src is a paused
element at zero — and a preview whose range ends before the timeline does has to
stop there rather than hand over to the clip after it.

The three sections in the middle are the three things one element per clip
structurally cannot show, driven one at a time: a filter over the whole canvas, a
filter that resizes a clip's picture below the point where the clip is placed —
asserted from *both* ends, the viewer refusing it by name and the render showing
it without complaint — and a
`testsrc` with nothing on the timeline at all, which is a picture where the
viewer has no element to put one in.

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

The last third of it is the other token: **an input with filters on it**, which
is what a `<video>` on the timeline plays when the clip carries any. Asserted by
decoding the frames back through bro's own registry rather than by reading a
size, because a chain that quietly did nothing would report the same width as
one that worked. `negate` is the filter, because its effect can be *predicted* —
the picture that comes out has to be 255 minus the one that went in, which a
chain that ran nothing cannot land on by accident — and then the same filter
carrying `enable='gt(t,10)'` twice with nothing changed but the view's `shift`,
which is the only way to see from outside that a filter is on the render's clock
and not the file's: at zero the first frame is before the span and comes back
untouched, and moved twenty seconds along it comes back inverted. Three things
are asserted about that one, because a clock has three ways to be wrong — the
frame is inverted, it comes back stamped at *its own* second rather than the
render's, and the same filter written in front of the `setpts` instead of behind
it is untouched again, which is where the render puts a filter inserted after
the decode.

Then a **`subtitles` burn-in**, which is the only filter here whose whole job is
to be different at different moments: the same view is decoded inside a cue and
between two, and it has to differ from the file at the first and equal it
exactly at the second. Either check alone passes for a bug — one that never drew
passes the second, one hard-wired to draw always fails it, and one whose clock is
out by seconds fails both. The path is escaped by hand in C++ rather than by
calling the UI's `filterPath`, so that the escaping is *stated* in both
languages rather than agreed with itself.

Then a `crop` for the sizes, a seek for the graph being rebuilt across one,
`volume=0` for the sound half with the *picture* checked to be untouched and
undecoded beside it, a filter option nothing has for the refusal, and a clip shot
sideways for the turn: the chain sees the picture the right way up and the track
then asks for no turn of its own, both halves asserted because either alone
passes for a bug.

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

**Several destinations** is driven through the picker and the rows and asserted off
the disk. `tee` has to be *in* the container list — it would be filtered out, being a
muxer that does not write the file it is named with — and picking it has to turn the
take already named into destination one rather than throwing the name away. The list
is then emptied through Remove, which is the one state that has nowhere to go and
must reach the button rather than the open; refilled through **+ Destination** and the
two fields; and the argument the muxer is opened with is compared against
`escapeTarget` on both paths, because it is the render side's own function on the same
kind of argument. Then a real recording, and both files are probed: **the same width
in each**, which is what makes it one encode rather than two. Switching the container
back has to leave the single path where it was.

The **meters** are checked against arithmetic rather than against a file. `aevalsrc`
puts the amplitude in the expression, so a sine at 0.5 must read exactly `-6.0` dBFS
on the number, put its bar at the RMS — which for a sine is peak over root two — and
its mark 3 dB above that; halving it must read `-12.0`, because a halving is 6.02 dB
wherever on the scale it lands. The bar is sampled at its *ceiling* over a moment
rather than once, since it falls between blocks of sound on purpose and one sample of
a falling bar has a tick count in it — and it is bounded tightly above and loosely
below, which is the shape of that claim: a falling bar can never be higher than the
level it was last driven to, so anything over is a real disagreement, while under it
can only mean the sample landed on a tick that had not heard anything yet. Then 1.5,
which is a source past full scale:
the light latches, the bar changes colour, the number goes above zero rather than
pinning to it, one click forgets both latches, and both fill again from what is
actually arriving.

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

`ui_graph.js` needs one only for its last two sections, and watches the graph
from inside rather than
through the string it prints: the model, the printer's chain rule on shapes the
derivation does not produce, and the whole of what makes an edited graph
survive a rebuilt one. A filter lands on the wire it names and takes the pad
name with it; two at one point run in order; a lock outranks the timeline and
reports which control it took; a lock that happens to agree has outranked
nothing; a split copies both halves' filters and a delete takes them away; and
the run graph differs from the printed one by exactly one chain with the
inserted filter in both.

Given a file it goes on to the wiring gesture on the real stage, and then to
**a filter in the viewer**: inserting one points the clip's element at a
filtered view of its input and takes the `fx` badge off, the element decodes at
the size the chain produces, taking the filters off puts it back on the input,
a filter that resizes the picture on the way in is laid out in the shape it made
— on the screen and in the printed invocation, which is the same rectangle
arriving twice — and the two cases that keep the badge, a resize below the point
where the clip is placed and a chain libavfilter will not parse, do so with a
sentence on the picture saying which. Every one of them goes through `overlay.insert`, which is
what the palette calls, so the src moves because the application reacted and not
because the test asked it to.

**Scrubbing a node** is driven through the bar rather than through `seekPlay`,
because the arithmetic that turns a pointer into a fraction of the range belongs
to the bar and calling past it would not have exercised it. A press half way
along has to put the picture half way along and draw the marker there; the rate
has to be measured from the seek rather than crediting the jump as playback; and
a press back at the start has to land on a piece that is already in hand, which
is asserted as `waiting` being false — "instant" means no render outstanding, and
that is the whole reason a playback keeps its pieces.

`ui_measure.js` is the half above that: a measurement started, run, read and
acted on. It clicks `Crop` and finds `cropdetect` on the graph and in the
command the bar prints; runs `Measure now` and finds the series on the render's
own clock; opens a plot and checks that taking a line off does not repaint the
one left; applies the crop and finds a `crop` node at the anchor the
measurement was taken at, carrying the characters `cropdetect` printed. Then it
puts the same filter at one clip's decode point instead and measures *to* that
node: the cut is two nodes of fourteen and one input pad, nothing after it is in
the printed graph, no `scale` is on the end — and the number that comes back is
the source's own width rather than the square composite's, which is the whole
claim being made about where a measurement is taken. A sound pad is cut at the
same way and renders to the end; and a press while the whole-graph measurement
still holds the one slot queues instead of failing, and starts when it comes
free. Three sections are written against **hand-made channel records**, the way
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
