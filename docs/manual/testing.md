[← The manual](README.md)

# Testing

```
cmake --build build --config Release && ctest --test-dir build -C Release
```

`ctest` generates its own media — two files with known content, a moving bar over a
gradient and a tone at a known level, differing in size, aspect, frame rate and length,
and a third with **no audio stream in it at all**, which is not the same file as one
whose soundtrack is quiet and is the only thing that separates "the mix" from "a mix
nothing feeds" — and runs every suite against them. Four more are each about a stream
the rest take for granted: one with **no video stream in it at all**, the mirror of
the silent one and the only thing separating the composite from a composite nothing
feeds; one whose pictures carry a **display matrix**, which is the only thing
separating a clip laid out upright from one laid out on its side; one with a
**`gpmd` data track**, which is a stream that is neither picture, sound nor cues,
is identified by its fourcc alone, and carries **real GPMF** — a payload whose
`SCAL` divisors are the difference between 9.81 m/s² and 981; and one with a **`dvdsub` track**, whose cues are
*pictures* of characters and therefore cannot be converted, burned in or read for what
they say. None can be faked with content: a picture that
happens to be black is not an absent one, a picture that happens to be tall is not a
rotated one, a track full of bytes is not a track something can still find by
name or read, and a text track with an odd payload is still a text track. Nothing is checked in and nothing depends on what a file you happened to have
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
./build/Release/ffmpeg-bro-playbacktest <file>      # the preview's cadence: which call makes a picture, and for which moment
./build/Release/ffmpeg-bro-capturetest out [<fixture-dir>]  # devices: an endless input, recording one, a session of several, a file laid over one
./build/Release/ffmpeg-bro-hwtest <file>           # the GPU: what is here, is it the same picture, what does each path cost
./build/Release/ffmpeg-bro-datatest <telemetry.mp4> [<real-gopro.MP4>]  # a data track: which parser, what GPMF says, and a payload it may not trust
./build/Release/ffmpeg-bro-markstest <marks.m4a> [<silent.mp4>] [<sound.m4a>]  # a soundtrack: is a transient found, is it at the right second, is the tone the frequency it was written at
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
./build/Release/ffmpeg-bro-headless ui/ tests/ui_load.js -- <file>
./build/Release/ffmpeg-bro-headless ui/ tests/ui_capture.js       # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_filtergraph.js   # needs no media
./build/Release/ffmpeg-bro-headless ui/ tests/ui_graph.js [-- <file>]  # media only for the last four sections
```

`hwtest` has the same problem one further on: **CI has no graphics card**, and
unlike a camera there is no `lavfi` to stand in for one. So it splits what the
other suites do not. The assertions run everywhere and are about the *shape* of
the answer — enumeration answers something, a type reported present can be
created and is shared rather than remade, a type reported absent refuses with a
sentence, a codec the device cannot decode is refused before a packet is read —
and every one of them is reachable on a machine with nothing. **How many devices
of a type there are is checked the same way**: the indices the enumeration
reported can all be opened, the first one past the end refuses, and they start at
0 and are contiguous. One card satisfies that as well as two do, and a machine
with none skips it — asserting *two* would be asserting something about the
hardware, which is the line this whole suite is drawn along. The numbers are
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

Its last section needs **no fixture at all**, which is the whole point of it: a
[generator laid out on the timeline](timeline.md#a-generator-laid-out-like-a-clip)
is a clip whose pictures libavfilter makes, so it is dragged, trimmed and played
with nothing on disk involved. Four things there are checked because they are the
four places a generator is not a file — the list of them is libavfilter's registry
and not a table here, its length is a decision that a trim *raises*, it takes no
`-i` number, and it is never the master clock. What it derives to is in
`ui_graph.js`, what a document does with it in `ui_document.js`, and the render it
produces in `ui_export.js`.

Its second-to-last section needs **no network**, which is the same trick the
other way round: reading a clip for the span on screen rather than whole is
decided by one flag on the input (`remote`, `ui/inputs.js`), so the section sets
it by hand on a ten-second fixture and everything downstream of it — the settle,
the grid, the strips, the honest blank where nothing has been read — is the code
a Twitch VOD goes through, against a file whose content a test can check. The
assertion the whole design is for is the one that pumps a second and a half of a
timeline that is holding still and requires that **nothing was read**.

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

One of `cues.srt`'s three cues is **marked up** (`<i>third cue</i>`), which is
there for the decoded half: a cue does not arrive as its words but as an ASS
dialogue line, so a reader that printed the `{\i1}` override codes instead of
the line passes against the two plain cues and fails only against that one.

`picture-cues.mkv` is the fixture for the other family — a `dvdsub` track beside
a picture, written by the generator with libavcodec's own dvdsub encoder. It is
the only fixture that reaches the three refusals a bitmap track earns (it cannot
become text, cannot be burned in, and has no words to read) and the only one a
drawn bitmap cue can be rendered from, because a text track with an odd payload
is still a text track. Its cues are at the same three moments the sidecars use,
each an opaque box in the lower third: what a check can ask about a picture of
text is that pixels changed where the box is and did not change where it is not.

The drawn half is measured **three** times rather than twice, and the third is the
one nothing else would catch: two renders of the same seconds, one with the
input's cues pad wired into an `overlay` and one without, compared before the cue
(99 dB), during it (14 dB) and *after it expires* (99 dB again). A sub2video that
paints each cue and never sends the cleared frame that ends one passes the first
two and leaves the subtitle on screen for the rest of the render.

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

The **cues** section of it is the same identity argument applied to the one part
of a document that is content rather than a description of a file. Two tracks are
made rather than one, so that "the ids come back" is a fact and not a coincidence
about the number 1; a cue is given a dialogue line with `{\i1}` and a non-default
style in it, so that what is asserted after the round trip is the *styling* and
not only the words; a track made after the open has to take an id the document
did not use, which is the check a fresh counter would fail; and the reader is
handed a hand-edited `subtitles` list — an id that is a word, a start that is a
letter, a negative end, a null and a string among the cues — because a document
is a text file people open.

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

`data_test.cpp` is a data track read, and it is the one suite here whose bulk is
about **input nobody wrote in good faith**. Every length, repeat count and
nesting depth in a GPMF payload comes from the file, so a malformed or hostile
`.mp4` is the case the parser is designed for and not an edge of it — a parser
that segfaulted on a bad file would be a worse outcome than a camera's telemetry
never being plotted, which was the alternative to writing this.

So a good payload is put through it damaged in five ways, and what is required of
each is not that it parses but that it **refuses and returns**: truncated at
every four-byte boundary in it (493 cases — a camera that lost power mid-write
leaves exactly this); every one of its 25 item headers given an oversized length
in turn, the declared struct size and the declared repeat count scribbled
*separately* because a check on their product that trusted either one would pass
one and fail the other; the largest length a header can express (16.7 MB) put in
front of a two-kilobyte buffer; a nesting bomb two hundred levels deep, which has
to stop at the parser's own depth cap rather than at the C stack's; four
kilobytes of zeros, which is every item nested, empty and named with NULs and is
the shape that loops a walk advancing by the payload rather than by the header; a
megabyte of pseudo-random bytes in two hundred packets; and every byte of the
first kilobyte flipped three ways, 3072 cases, of which 2980 still parse into
something and 92 are refused. After each one, whatever survived is checked for
internal consistency — an item whose value count disagreed with its own sample
and component counts would be a caller indexing off the end of it.

The rest of it is the format, each rule with a value that says the rule was
followed: a broadcast `SCAL` over three components (an axis that is exactly 9.81
was divided and one that is 981 was not), a per-component `SCAL` with five
different divisors in it (an altitude of 123.456 m proves the *third* was used
and not the first), a float under a divisor that must come back undivided, a
`SCAL` whose count fits nothing and must therefore be applied to nothing, an item
of repeat zero that must advance the cursor rather than loop it, and a `?`
complex item that must be stepped over by its declared length rather than read.

The **second argument is a real camera file** and there is deliberately no
fixture for it: a fixture is written by this repository and therefore cannot
prove that a real HERO8 payload parses. Given one, the suite prints every series
it found with its sample count, rate, units and range, and asserts the two things
about a real recording that are checkable without knowing where the camera was —
an accelerometer that reaches a number an accelerometer has rather than one in
the hundreds of thousands, and a latitude that is on the Earth rather than in the
hundreds of millions. Without one it says so and skips, so the suite runs on a
machine with no GoPro in the drawer. `-DGOPRO_FILE=<path>` at configure time is
how a machine that has one points `ctest` at it.

A file that carries a data track nothing here parses is **skipped and not
failed**, and that distinction was found by running this over seventy-one real
files rather than reasoned about: an older GoPro, or a newer one with telemetry
switched off, writes a `tmcd` and no `gpmd`, and "this file has no track a parser
answers for" is a true thing about the file rather than a fault. The skip names
the tags that got no parser, so the seam is as visible there as it is with a
`gpmd` present. Of those seventy-one files, twenty-one carry real GPMF and **all
twenty-one parse with no packet refused** — 40 series each, and the largest (a
4 GB recording, 1058 payloads) read in 45 ms.

## Finding things by sound

`markstest` is the native measurement suite.

The measurement is almost entirely **a number of seconds**, because that is what
the feature is: a mark is a place, and a detector that finds a transient a second
late is worse than useless. `marks.m4a` is the only fixture here in which
anything ever *happens* — three broadband transients at 1, 3 and 5 seconds, a
1000 Hz tone from 6.0 to 7.5, and two seconds of quiet after it — and each of
those parts is there for one assertion. The clicks are two seconds apart, which
is forty times the detector's own refractory period, so a mark near one is
unambiguously about that one. The tolerance is 120 ms and it is arithmetic
rather than tuning: a 25 ms analysis window, a mark stamped at its start so it
lands early rather than late, and an AAC transform of 1024 samples on top. The
tone's frequency is the one *physical* measurement in the whole feature — a
detector that reports a run and gets the pitch wrong is the failure that still
looks plausible — and the two seconds of bed after it are what separates a
detector from one that marks everything.

The bed being **stationary** noise rather than a quiet tone is not a detail. The
first version of the fixture used a 137 Hz tone amplitude-modulated at 3.1 Hz,
and PCEN — which divides each mel channel by its own smoothed energy — turned
that swell into real spectral flux: eight onsets came out of the first second of
"silence", and the refractory period of the last of them swallowed the genuine
transient at 1.0 s. The suite passed, on a spurious mark. Anything added to that
file has to be stationary or has to be one of the things being detected.

Two onsets in the first quarter-second survive even with a stationary bed, and
they are asserted rather than suppressed: the flux baseline is an EMA starting
at zero, so the earliest frames clear the bar trivially. What is required is that
they are *distinguishable* — flux 0.055 and 0.077 against 3.4–3.5 for a real
transient — because filtering them out here would make this and
`bro.sense.analyze()` disagree about the same file.

Both halves of this suite used to carry a second path, for a build configured
`-DBRO_WITH_SOUNDML=OFF`, and both are gone: that configuration is refused at
configure time now, so there is one behaviour to assert. It was worth removing
for a reason worth remembering — the branch was never once configured, built or
run, only checked by compiling two files with the macro forced off, so the suite
that asserted it was asserting a claim nothing had ever exercised.


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

A third is there because it broke in *use*: the picture has to go on being made.
It plays for four seconds and watches the element's own clock, and what it
asserts is only that the moment never stands still — no rate, because a machine
that renders at a tenth of the speed should pass. `playbacktest` is the same
failure taken one layer down and made deterministic: `OutputReader` driven by
hand, with the screen readings a real element would have produced, asserting
which calls make a picture and which moment each is for. The two are worth having
separately — the invariant is a property of the reader and can be pinned exactly
there, but nothing at that layer can see the deadlock between three threads that
made it matter.

The three sections in the middle are the three things one element per clip
structurally cannot show, driven one at a time: a filter over the whole canvas, a
filter that resizes a clip's picture below the point where the clip is placed —
asserted from *both* ends, the viewer refusing it by name and the render showing
it without complaint — and a
`testsrc` with nothing on the timeline at all, which is a picture where the
viewer has no element to put one in.

The **level strip** beside the viewer is asserted for the one thing a strip of bars
cannot say about itself, which is *which* of two things it is reading — see
[The meter beside the picture](playback.md#the-meter-beside-the-picture). With the
preview off it has to say `monitor`, because bro's mixer is what is summing the clips
and nothing else has a mix to measure; with it on, `output`, and the loudest-so-far
number has to come off the floor, which is the assertion that a reading is arriving
rather than that the bars exist. Then the channel count: two bars for a stereo output
and **one** for an output written in mono, which is the half of the old Not-yet entry
that said the meter was per clip rather than per output channel. That the peak is a
*true* peak is asserted on the Capture stage instead, where the signal can be written
down as an expression.

`ui_load.js` is the suite for a large edit, and everything in it is a claim
nothing else can make: **an edit of many clips holds few decoders**, every clip
under the playhead has one whatever that costs, the lanes survive a decoder being
let go, a measurement landing is not an edit, playback runs on the render, and a
gesture on the Graph stage costs what the gesture changed. It is built from one
file cut many times, because residency is about how many decoders are open and a
decoder per clip is a decoder per clip whether or not two of them read the same
path.

Its timing assertions are all **ratios or worst frames, never totals**. The same
total spread over a hundred frames and delivered in one are the same number and
completely different to use, so what is asserted is the worst single frame; and
"this is not quadratic" has no honest form other than asking the same question of
two sizes and comparing, so the graph's derivation is timed at the full edit and
at a fifth of it and checked against how much bigger the graph actually got. That
one fails at about 20× on the array-walking model and passes at about 5× on the
indexed one, which is a threshold that cannot be met by a fast machine or missed
by a slow one.

The last section is the fold — a clip's derived run drawn as one card, see [When
there is too much of it to read](graph.md#when-there-is-too-much-of-it-to-read).
Three of its four checks are about the fold not being a hiding place rather than
about it being fast: a filter you inserted is on the screen as itself, a
*derived* node you locked holds its whole run open, and the stage's own line says
how many clips were collapsed and why any were not. The fourth is that walking to
the stage returns without laying the graph out, because a press that does not
return until the work is done is a press that looks like it failed.

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
is offered — and then that **adding it returned at once**, that the card says
`Connecting` with a `Stop`, and that pressing Stop settles the input as `stopped`.

**Nothing in either suite reaches a network, and neither needs one.** The address
is `192.0.2.1`, which RFC 5737 reserves for documentation and which is therefore
never assigned to anything, so what is asserted is what this code does while an
open is going nowhere. `input_test.cpp` does the same at the native level against
a closed port on the loopback address — which on this platform is a genuinely
blocking open, since libav sits in the poll until the protocol's own
`open_timeout` — and checks the two halves that matter: a one-second deadline
ends the open in about a second rather than when libav gives up, and a stop
against a *sixty*-second deadline lands in a tenth of one, which is only possible
if the press actually reached the interrupt callback. A machine with no route at
all answers immediately, and the UI half then says so and skips the part that
needs something to stop, the way every suite here skips what its fixture cannot
provide. What is not tested is a URL that *works*: that needs a server, and a
test that needs a server does not belong here.

**The device half of the same path needs no hardware either**, because `lavfi` is
a device in this build and exists on every machine. `input_test.cpp` probes one
through `startProbe` and asserts two things about it: that the answer comes back
like any other input's, and that it reports `stoppable: false` — a stop would not
reach a libavdevice open, which is measured rather than assumed. It then puts a
watch that has already given up — once because its deadline is past, once because
somebody pressed Stop — through the same device's open and requires the probe to
*fail* both times, because `avformat_find_stream_info` answers success when the
callback cuts it short and a successful probe of a half-analysed file is worse
than the hang the deadline is there to end.

**Already past, rather than expiring part-way through, and that is the whole of
what is deterministic here.** The deadline is armed and then slept out before the
probe begins. Arming one for a microsecond and probing at once — which is what
this used to do — failed five runs in six, not because a device goes unpolled
(counted, `find_stream_info` polls the callback twice on every run of this
source) but because `av_gettime_relative()` is the system tick and steps in
0.5–1.5 ms on this platform, which is longer than the whole open: a deadline read
back inside the tick it was armed in has genuinely not passed, and the probe
genuinely succeeds. So the suite asserts the rule that exists — `openInput` asks
the watch as well as libav's return code — and not a claim about when a clock
ticks. The stop half of the pair carries no clock at all and is the same rule
proved twice. `ui_capture.js` asserts the route from the other side: activating a
device returns at once, the input is `opening` the instant the click does, no
preview session is opened over the top of it and Record is held while it is
outstanding. What no suite here can exercise is a device that genuinely hangs —
that wants a camera another program is holding, which is a machine and not a
fixture.

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

**A file beside the device** is checked in both suites and in three parts, because
the claim has three halves and only the third is hard to believe. `capture_test.cpp`
records `testsrc` with `movie=still.png` overlaid and reads the strip the card covers:
it is not the device's picture (so the file is in the frame and not merely in the
graph), and frame 45 reads the same as frame 5 (so a still is *held*, by `overlay`'s
own `eof_action=repeat` rather than by a rule this application wrote). Then the same
with `landscape.mp4`, whose bar sweeps across it over ten seconds: frame 0 and frame
45 must **differ**, because a file raced to its end would be its last frame repeated
and both would read alike. That is the assertion that says the file is pulled one
frame per output frame. `ui_capture.js` does the same from the stage a person uses —
a `movie` node placed, wired into an `overlay` beside `[0:v]`, `recordGraph`
accepting it, one `-i` in the command bar because a `movie` is not one, and a real
recording that comes out at the device's own size. Its file is the one the suite
recorded a section earlier, so that half still needs no fixture.

**A device with a title on it, streamed out** is the whole of what [Not
yet](not-yet.md) used to call inexpressible, checked in one recording.
`capture_test.cpp` binds a **UDP listener on the loopback in its own process**
first — writing to a port nobody is on succeeds silently, whatever is wrong with
the plumbing, so a check without one proves nothing — then records `testsrc` with
`movie=still.png` overlaid to `udp://127.0.0.1:45233` as MPEG-TS, and requires
that the job is Done, that it reports what it sent, and that the listener received
it beginning with a `0x47` sync byte. Nothing reaches a network. `ui_capture.js`
does the stage half: a URL in **Save to** draws the `udp · linked in` row, the
command bar prints the URL where a filename goes, and nothing about it is refused.

**A device is not a clip, and `Stop at` does not change that**, which is asserted
at both ends because the refusal used to be keyed on the wrong question.
`ui_capture.js` lays a `lavfi` device on the timeline and requires the refusal,
then sets `-to 3`, requires that the input now *has* a length of 3 — the same rule
a `-loop 1` follows — and requires the refusal again. `export_test.cpp` asks
`startExport` for the same clip and requires a failure naming the device and
saying what a trim on one would cost, with and without a `-t`; and then renders
the same device through `filterInputs` and requires that one to **succeed**,
because a pad is pulled forward and never asked for an instant. The numbers behind
those two — 3040 ms for two seconds trimmed one second in against 2038 ms
untrimmed, and 2024 ms for a graph render paced by the device — are in `deviceClip`
in `src/native/ffmpeg_export.h`.

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

Two claims about what *kind* of reading it is are checked the same way. Two
expressions twelve decibels apart is **a bar per channel** reading its own number,
which a mono summary of the two could not produce — and the two are named `FL` and
`FR` out of libav's own layout. Then a **true** peak: 12 kHz at 48 kHz with a
quarter-cycle offset puts every sample on ±sin 45°, so the loudest *sample* is 3 dB
below the loudest *point*, and the meter reads `-0.1` where a sample-peak meter would
read `-3.1`. The latch is cleared first, because a signal that starts abruptly is a
step and an oversampling filter rings on a step — what is being measured is the steady
state after it. Every sine source here carries `arealtime` for a related reason: a
`lavfi` device left to generate as fast as it can overflows the reader's sound queue,
whose oldest blocks are then dropped, and a meter handed a signal with cuts in it reads
the cuts.

**Monitoring is asserted at bro's mixer and not at the element.** An element with a
src on it says nothing about whether anything is audible, so `Listen` is checked by
reading the master bus — `new AudioContext().getBusPeakL(0)`, bro's own metering of
what the speakers are being handed — silent before the press, audible after it, and
silent again once the button is off and the half-second ring has drained. What that
proves is the part that could have been faked: the pad really is carrying blocks and
they really are reaching the mixer. The rest is asserted where it is decided —
monitoring off to begin with, the element removed rather than muted (because the
element *is* the listening), the feedback sentence naming the input it is warning
about, and the whole thing stopping with the session when the stage is left.

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

`ui_graph.js` needs one only for its last four sections, and watches the graph
from inside rather than
through the string it prints: the model, the printer's chain rule on shapes the
derivation does not produce, and the whole of what makes an edited graph
survive a rebuilt one. A filter lands on the wire it names and takes the pad
name with it; two at one point run in order; a lock outranks the timeline and
reports which control it took; a lock that happens to agree has outranked
nothing; a split copies both halves' filters and a delete takes them away; and
the run graph differs from the printed one by exactly one chain with the
inserted filter in both.

It also holds the checks on **a value written as an expression**, which need no
media because an expression is a string: the four states libav's evaluator puts
one in, the round-trip through the points printer and parser at two, three and
four points, the refusals for an expression it did not write and for a nest whose
halves do not join up, and the sampled values themselves — which are the one
claim that could not be checked by reading the code, since they come out of
`av_expr_eval` rather than out of anything here. The last of it wants a file,
because the printed chain has to be read off a real node.

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

**The When lane** is the last of it, and it is on the *Compose* stage rather than
the Graph one — the timeline lives in `#st-compose`, so behind a `display:none`
every rectangle on it is zero and a press computed from one would land nowhere.
What is asserted after each real drag is the **stored expression**, because the
claim is that the lane is a reading of it and writes through the same two
functions the strip does: an end moves and the other end does not, a body move
keeps the length, a press that dragged nothing writes nothing, and `Ctrl`+`Z` puts
a drag back. Then the two halves of the entry it closes — a second node with
spans is a second row, both cover the same second without either becoming
unreachable, a drag on one row edits that node and no other, and deleting a node
takes its row away. The lane's *existence* is checked in both directions (no
spans, no lane; the last span off, no lane), and a span dragged there is read back
out of the workspace and out of a document, which are the overlay's two reads.

One section is about the **other clock** and is the reason a span is clamped
against a window with a start rather than a bare length: on a clip cut from two
seconds in and laid down at one, a filter above the derivation's `setpts` written
`between(t,3,3.5)` has to be drawn at the edit's second 2 and a region dropped at
the edit's second 4 has to be written back as the file's second 5. Both directions,
because that is what makes the two clocks one map rather than two.

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
produce is then made on the real timeline through the real split. `Re-measure
when stale` is checked in both directions, and the interesting half is the things
that must *not* happen: the toggle is off to begin with and is written under a key
of its own with nothing of the encode side's blob beside it; a re-measure asked
for while something else holds the one job slot is refused and then does **not**
fire when the slot comes free; a second attempt for the same edit is refused and a
frame loop left running for a second and a half starts nothing. What it moves to
make the finding stale is a clip's *level* — the one thing in a render's subject
that `cropdetect` cannot see, since moving the clip would take it out of the range
and cropping it would change the answer rather than the question. Last, the A/B
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

And **`-fps_mode vfr`**, which is about timestamps rather than about bytes and is
checked by reading them out of the container. The graph is deliberately *unevenly*
spaced — a 50 fps source with `select` keeping two frames in every four, so the
gaps are one fiftieth then three — because anything constant would pass under
either mode and prove nothing: what is asserted is that the first gap is a
fiftieth and the second is three of them, which no frame number can express, and
that the same graph under `cfr` comes back on an even grid. The container's own
time base has to be fine enough to hold those, which is the second half of the
same check. The soundtrack is compared against the *other* walk rather than
against a number, because the paced walk covers up to each frame's own moment and
owes whatever the last frame lasts — so the two must come out the same length,
and it must reach past the last picture to the end of the range. All three
refusals are checked by their sentences: a composited render, a render mapping a
graph pad, and a mode this renderer does not perform (`passthrough`), which is
refused by name rather than mapped onto one it does.

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

**Keep trying if it drops** is asserted without streaming anywhere, which is most
of what there is to say about it: that a local file gets no `fifo` however the
setting is left and a URL does; that the printed command names `fifo` with the
real muxer as `-fifo_format`'s argument and the wait in the microseconds libav
reads a bare duration as; that the wrapped muxer's own options come out as one
`-format_opts` bag and **never as flags**, because ffmpeg applies output options
to the muxer it was named with and `-flvflags` on a fifo is an exit; that a tee
is refused with a warning naming the per-destination form that does work; and
that a stored workspace with `queueSize: "90"` and `waitSeconds: null` comes back
as a number and as the sentinel, since zero is a real answer there and `Number()`
turns absence into it. Then the one half that can be *rendered* without a
network: a fifo around a local file, whose output has to come back the same codec,
the same size and the same length as the render that was not wrapped — which is
worth a file because the wrapping changes which muxer answers every question
about the container, and `fifo` answers `AVERROR_PATCHWELCOME` to every
`query_codec`, has no default codecs and no fourcc tables. What is *not* tested
is a destination that actually drops and comes back: that needs a server to take
away.

That section puts the **whole stored blob** back when it is done rather than the
fields it named. `ui/.storage.json` is one workspace shared by every suite and
every run, and changing the container rewrites the stream rows' codecs on the way
past — which is remembered. Left behind, it broke an assertion four thousand
lines earlier on the *next* run of this suite, and then a subtitle row in
`ui_subtitles.js`, which had never heard of any of it. Restoring the bytes is the
only repair that covers what a setting quietly changed on its way past; restoring
the *fields* is what did not.

It also drives everything on the encode side that is not an encoder option: that
two-pass is a *mode* of the rate control and that choosing it makes the spec say
the range is walked twice with both passes naming one statistics file and the
command bar printing two invocations; that a forced keyframe at a cut point
**follows the clip when the clip moves**, which is the whole claim of deriving
it rather than copying it; that the field order prints as the two things it is;
that `-fps_mode` is a choice of two whose variable half is **present and refused,
with its reason**, while the render composites — and becomes available, reaches
the spec and prints without an `-r` the moment there is a filter on the graph; and
that a bitstream filter chain is offered only for the codec the stream is encoded
with, runs in the order shown, carries libavcodec's own option table and prints as
one `-bsf:v` the way `av_bsf_list_parse_str` takes it.
