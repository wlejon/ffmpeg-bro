[← The manual](README.md)

# Output

`Encode` and `Write` are two of the six stages on the spine — the row under
the title bar that *is* the pipeline: **Capture → Sources → Compose → Graph →
Encode → Write**. Each card says what its stage is currently set to, so the bar reads as
one statement of the whole render, and clicking the part that is wrong is how
you go and change it. `E` goes to Encode, `[` and `]` step along the chain,
`Esc` comes back to the edit.

Choosing an encoder setting means looking at what it does to the picture, and
the comparison that shows you is the whole point of the Encode stage, so it
gets the middle of the window: settings down the left, every option the encoder
has down the right when you want them, the range across the bottom. Where the
file goes is the *next* stage, because it is a different decision taken at a
different moment — you settle what the picture is by looking at it, and then
you say where to put it.

Everything the viewer is showing is what gets written: the track stack
composited bottom-up, each clip in the rectangle its fit, scale, position and
crop put it in, at its opacity, and the grid if the grid is on. The placement
rectangles the renderer works from are the ones `ui/viewer.js` computes, so
there is no second layout implementation to drift away from what you were just
looking at.

The encoders are the reason this repo is GPL, and they are all here:

| | |
|---|---|
| Video | x264, x265, AV1 (SVT / libaom), VP9, ProRes, MJPEG, MPEG-4 — plus NVENC, AMF and QSV when the build has them, and every muxer's own default encoder |
| Audio | AAC, Opus, MP3, Vorbis, FLAC, PCM |
| Containers | **every muxer this build links** — 182 of them |

The menu is built by asking libavcodec what this binary actually has rather
than from a list, so it cannot offer an encoder that then fails at the last
step. The same goes for what each encoder can do: its pixel formats, presets,
tunes, profiles and the range of its quality scale are read out of libavcodec's
own option tables, so the controls change with the encoder — x264 gets a CRF
slider from 0 to 51 and ten presets, VP9's goes to 63, ProRes gets its six
profiles and no quality slider at all, and NVENC gets `p1`–`p7`. Which
containers will hold a codec comes from `avformat_query_codec` rather than from
a table, so picking WebM narrows the codec list to the two that are legal in it.

**Start from** is the top row: six named starting points — web, small, HEVC,
ProRes master, GPU, lossless — each filtered against what this build has, and
the GPU one against what this *machine* has, so it is absent on a machine with
no card in it. Those are two different questions and the second one is the one
that matters here: a vcpkg ffmpeg carries every NVENC, AMF and QSV encoder
whether or not there is anything to run them on. Most renders are one of
these, and the twenty controls below are for the render that is not.

**Rate control** is offered as the modes the encoder actually has: constant
quality, a bitrate target, **two-pass**, a capped average for streaming
(`-maxrate` and `-bufsize`), and lossless. NVENC has no CRF, so its quality mode
is `-cq` with the bitrate target taken out of the way; x264's lossless is
`-crf 0`; VP9's is `-lossless 1`. That mapping lives in one function, so the
summary line, the preview and the export cannot describe three different
renders.

**Two-pass is a mode of that control and not a switch beside it**, because it is
the same decision — spend this many bits — taken twice. The range is rendered
once to measure where the bits are needed and once to spend them, and the
statistics go between the two through a file on disk, which is the only way
ffmpeg ever does it. It is one job here: one Stop, one progress bar, one file at
the end, with the bar saying which pass it is in — a render that is going to do
the whole thing again must not report 43% and leave the rest to be discovered.
A checkbox instead would have let you ask for two passes of *constant quality*,
which is two runs of an encoder that had nothing to learn from the first.

A pass's options reach the encoder through the **stream list**, which is worth
saying because for a while they did not. What a pass overrides is merged onto
the render it belongs to, and the writer reads the render's own option bag only
for the two streams it synthesises when nobody supplied a list — and every
render this application builds supplies one. So `-pass 1` was being dropped on
the way, silently, in the one place this codebase's rule is that an unknown
option is an error rather than a shrug: two-pass renders finished, wrote a valid
file and reported success, having spent the bitrate the way a single pass does.
The options now go onto the streams as well, which is where an option actually
reaches libavcodec, and the test for it breaks the render on purpose — a key
x264 does not have, put on a pass — because a test that only checks the spec is
a test that passed throughout.

One thing about it cannot be promised, and is said where it is chosen: **whether
an encoder acts on `-pass` is the one capability libavcodec will not answer in
advance.** There is no flag for it and no option to ask about. So the control
does exactly what it says — it writes `-pass 1` and `-pass 2`, as the command
line does — and a render whose encoder kept its statistics somewhere else says
so in the report rather than pretending. x264 keeps its own log and is handed
the filename; everything else uses libavcodec's own statistics pair; which of
the two applies is asked of the encoder rather than looked up in a list here.

**Where the keyframes go** is a different question from how often, and the more
useful one. `-g` is the interval; `Force at` is the *places*:

| | |
|---|---|
| **Off** | whatever the GOP length produces |
| **Cut points** | one wherever the edit cuts — read from the timeline every time |
| **Times** | a list of seconds into the output |
| **Expression** | ffmpeg's own, evaluated per frame over `n`, `t`, `n_forced`… |

**A keyframe where an edit cuts is what makes a file that can be cut again.**
Every editor and every stream packager has to start a segment on one, so a cut
that falls in the middle of a GOP costs a re-encode of everything up to it.
Nothing is copied when you choose it: what is remembered is the *decision*, and
the list is re-read from the timeline whenever it is asked for — so moving a
clip moves the keyframe with it. A version that wrote the numbers down when the
button was pressed would go on naming moments nothing cuts at.

The times are seconds into the **output**, not into the timeline, which is what
ffmpeg means by them and what makes the printed command run somewhere else and
produce the same file.

Under Advanced, four more that are not encoder options and could not be reached
through the option column:

- **Frame timing** is *stated*, not chosen. This renderer walks the range
  forward at the output rate and stamps every frame with its number — both
  paths do — so `-fps_mode cfr` is a fact about it rather than a setting, and
  the command says so. A picker offering `vfr` or `passthrough` would be
  offering two things neither render path can produce.
- **Field order** — progressive, top field first, bottom field first. It is two
  statements that travel together: the encoder goes into field mode
  (`-flags +ildct+ilme`) *and* every frame is marked to match, because only the
  first writes a file that claims to be interlaced without being coded that way.
  What is composited here is progressive, so this is right for footage that was
  interlaced and has come through untouched, and a claim about the picture
  otherwise.
- **Threads** — `-threads` and `-thread_type`. Zero is all cores, which is what
  every render here has always done and remains the right default; this is for
  the render that has to leave a core alone.
- **Shortest** — end the file where the content ends rather than where the range
  does. Off by default: a range is a decision somebody made, and quietly writing
  less of it than was asked for is the wrong half of the trade.

**Every option the encoder has** is available under Advanced — both encoders,
the picture's and the sound's, in a column each with a search of its own. The
list is `av_opt_next` over the encoder's `AVClass` — name, type, range, default,
help text and named values, straight out of libavcodec — with a search box over
it. x264 reports 48 options here, x265 many more, `aac` 82. Nothing about them
is written down in this repo, so an ffmpeg upgrade that adds an option adds it
to the app.

This works because there is no private path from the controls to the encoder:
a Quality slider produces `{crf: 20}`, the raw editor produces `{crf: 20}`, and
both are applied with `av_opt_set(ctx, key, value, AV_OPT_SEARCH_CHILDREN)` —
exactly how the `ffmpeg` command line applies its own arguments. Anything
documented for `ffmpeg -c:v libx265 -x265-params …` works here unchanged. The
summary at the bottom shows the result as a command line, because that is the
shortest complete statement of what is about to happen. An option the encoder
does not have is an error, not a shrug: a render that succeeds while silently
ignoring half of what it was told is the worst of the three outcomes.

## Which container

The format control was four entries — MP4, Matroska, QuickTime, WebM — written
down in C++ beside a codec list that was genuinely asked of libavcodec. MPEG-TS,
MXF, AVI, FLV, GIF, image2, WAV, ADTS and a hundred and seventy others were
compiled into this binary and unreachable because of that one line. They are all
here now, and the picker is the shape the filter palette already uses, because
it is the same problem one stage later: **there is no list of the good ones
anywhere.**

A muxer is chosen **by name**, which is what `-f matroska` means and the only
thing that identifies one: nothing in libavformat is called "mkv", forty-seven
muxers have no extension at all, and several share one. The extension is a
consequence — what the file gets called — and it follows the choice.

What you can group a hundred and eighty by, all of it asked rather than decided:

| | |
|---|---|
| **Fits** | `avformat_query_codec` says it will hold the codecs this render is set to |
| **Files** | it has an extension and writes a file it opens itself |
| **Pictures** | an intra-only video codec and no audio codec at all — image2, gif, the single-frame writers |
| **Streaming** | `AVFMT_NOFILE`: it writes through a protocol rather than to a file |
| **Devices** | libavdevice's own, which only exist once `avdevice_register_all()` has run |

and a search over the name, libavformat's own description and the extensions —
so "mkv" finds Matroska even though nothing is called that.

**`avformat_query_codec` has three answers and only two of them are yes and
no.** A muxer with neither a `query_codec` function nor a codec tag table
returns `AVERROR_PATCHWELCOME`, which means *not taught to answer*. Over four
well-known containers that never came up; over a hundred and eighty it does —
MPEG-TS is one, and reading its shrug as a refusal is how a picker comes to
insist that MPEG-TS will not hold H.264. So it is carried through as itself:
nothing is filtered where it applies, the codec in hand is left alone, and the
row says *does not say*. A muxer that genuinely answers no still narrows the
codec lists, and the codecs it refuses are shown marked rather than hidden —
hiding them hides the reason the one you wanted is missing.

Beside the picker, **every option the muxer has**, in a column, exactly as the
encoder's are: `movflags`, `hls_time`, `mpegts_service_id`, plus libavformat's
generic ones, walked out of the muxer's own `AVClass`. They reach it through
the same `av_opt_set`-with-children route ffmpeg's own arguments take, and an
unknown key stops the render rather than being ignored. Changing the muxer
empties the bag, because `movflags` in Matroska is an error and not a carried
preference.

## Writing pictures

`image2` is the one muxer whose output is not a file but a *set* of them, and the only
thing that says which is which is the filename: `out%04d.png` is a run of pictures and
`out.png` is one picture written over itself on every frame. So picking image2 puts a
frame number in the name, and **Numbering** says which of the two you meant —
`A file per frame`, or `One picture`, which is `-update 1` and is not optional for a
single file.

Under it, **the names that will actually be on disk**. Not the pattern: `%04d` is
exactly the kind of thing somebody gets wrong once and then never trusts again, so the
panel shows the first few and the last, from `av_get_frame_filename2` — the same
function the muxer calls. `-start_number` is beside them, since a run does not have to
begin at one.

One PNG of the frame at the playhead is the degenerate case and is the fastest way to
get a still out of an edit: `One picture`, and a range of one frame.

**Here alone, the extension chooses the encoder.** `.png` is PNG data and `.bmp` is BMP
data through the same muxer, so image2's extension names a *codec* rather than a
container — the opposite of how every other extension in libavformat works. The
encoder follows the filename through `av_guess_codec`, which is what `ffmpeg` itself
does; without it every picture render lands on mjpeg, which is what image2 declares as
its default whatever the file is called.

## Where it goes

The other half of `Write` is the destination, and it stopped being a path.
There are four shapes and each says which it is:

| | |
|---|---|
| **one file** | what nearly every render is: opened now, closed when the render ends |
| **a set of files** | `image2`, `segment`, `hls`, `dash` — pictures, segments, chunks, and the playlist that names them |
| **a stream** | a URL through one of the thirty output protocols this build links |
| **several at once** | `-f tee`: one encode, several destinations |

**Which one it is, is asked rather than chosen.** There is no mode control here
and no list of segmenting muxers written down anywhere, because either would be
a second answer that could disagree with the first. `AVFMT_NOFILE` is
libavformat's own way of saying *I do not write the file you named me with* —
which is exactly what a segmenter, a playlist writer and `tee` all are — a frame
pattern in the name is what makes `image2` a run rather than one picture, and a
URL is a URL — except `file:`, which is the long way of writing a path and is
read as one, because that is what the renderer does with it. The muxer picker's
**Streaming** facet is the same query.

Each shape then gets what it needs and nothing else. A URL says which protocol
it names and **whether this build has it**, because a URL naming a protocol that
is absent fails at open with a message about a filename. Beside the muxer's
option column is the **protocol's own** — `srt` reports 38 here, `rtmp` about
twenty — and they travel in one bag, which is what libavformat does with
whatever a muxer does not recognise, exactly as the Sources stage does at the
reading end. A key neither of them has stops the render rather than being
ignored.

## Several destinations at once

`-f tee` is **one encode written to several places**. That is worth being exact
about, because "two outputs" can mean two different things and only one of them
is this: `tee` sends the *same packets* to several muxers, so a Matroska file
and an MPEG-TS stream carry the same bitstream in different wrappers, at the
cost of one encode. Two outputs at *different settings* is a different feature —
two encodes — and it is the next section.

The destinations are a list: a muxer, a target, and that destination's own
options. The `-f tee` argument is **built from the list rather than typed**,
and shown in full underneath it, because that argument is a small language with
two layers of escaping over it:

- `tee` separates destinations with `|` and reads each one's options out of
  `[ ]` on `=` and `:`, honouring a backslash — so a `|` or a `\` in a target,
  and a `:` or a `]` in an option value, have to be escaped. On Windows that
  means every backslash in a path is doubled, which looks wrong and is right.
- then the shell quotes the lot again, which is a second and completely
  separate layer, and is what the command bar's quotes are.

An argument assembled on your behalf is exactly the one that has to be visible,
which is why the list and the string are both on the screen.

**Recording and streaming the same capture** is this, and it is the case tee was
chosen for: one encode, one real-time deadline, a file kept and the same packets
sent somewhere else. The Capture stage takes a tee argument in its own path
field and says how many destinations it comes to; the editor for the argument is
on the Write stage, because a second copy of the escaping would be a second
answer to it.

## The same edit, written twice

**Also write** is the other answer to "two outputs", and the one people arrive at
the tee rows looking for: a 1080p master and a 720p proxy, out of one job. It
cannot be a tee, and the reason is not a limitation of this application —
**an encoder has one frame size**, so two sizes cannot come out of one encoder,
and `tee` is one encoder by definition. What it costs is what it is: two encodes,
twice the CPU, two genuinely different bitstreams.

| | |
|---|---|
| `-f tee` | one encode, several places — same packets, different wrappers |
| Also write | several encodes, one edit — different sizes, different files |

A recording has a third answer, because it cannot run anything twice: see
[More than one file out of one recording](capture.md#more-than-one-file-out-of-one-recording).

**A version is a size and somewhere to put it, and nothing else.** Not a second
Write stage: the muxer, the codec, the rate control, the stream list and the
range are the render's, because what makes a proxy a proxy is that it is *the
same render, smaller*. CRF is a quality target rather than a bitrate, so the
smaller one comes out smaller without being told to. The one thing offered
beside the size is the muxer, because a proxy in another container is a real
thing to want — and left blank it is read off the extension, which is the same
question libavformat asks of a filename.

Give one side of the size and the other follows the render's aspect: a proxy is
"720 high" far more often than it is "1280 by 720".

**It is passes, not jobs.** `ExportPass` already means "one run over the frames,
as a set of overrides", which is exactly what a second output is — so two
versions are one thing to the person who asked for them: one Stop button, one
row of progress, one answer at the end. The status names which output it is on
as well as which pass, because "43%" of the first of three files is a lie by
omission. Two versions *and* a two-pass encode is four walks, each output
measured and then spent, each with a statistics log of its own — a bitrate map
measured on 1080p pictures is not a smaller version of the 720p decision.

**The rectangles travel with the size.** A clip filling a 1920-wide canvas is
1920 wide, and composited unchanged onto a 1280-wide one it would be cropped
rather than fitted. So a version carries its own stack at its own scale, built
by the same `buildSpec()` that builds the render — a version is *what this
application would render if you had asked for that size*, by construction, and
not the master scaled afterwards. That is also why it is one resample rather
than two: each picture goes from its source straight to the size it is shown at.

The command bar prints a whole invocation per version, each with its own
`-filter_complex` scaling to its own size and its own filename, because that is
what runs. The Graph stage draws the render's own graph; a version's differs
only in what its `scale` filters scale to.

Two versions aimed at one path is on the warnings list rather than refused: it
succeeds, and one of the two files it paid for is gone. So is a version with no
size and no muxer of its own, which is a second encode of an identical file.

## What comes back from each

Progress has to say something true for each shape, and they do not share a
sentence:

| | |
|---|---|
| **one file** | frames of a total, a percentage, a rate and an estimate |
| **a set of files** | all of that, and **how many files have arrived** — the only number that says a segmenter is segmenting |
| **a stream** | elapsed, frames, bytes **sent** and the bitrate they come to — no size, no percentage, no bar |

How many files is asked of libavformat rather than counted off the disk.
`AVFormatContext::io_open` is the callback every output goes through — the
primary file, each segment, each DASH chunk, each `tee` slave, each numbered
picture — and it is the seam ffmpeg's own CLI overrides, so the count, the names
and the sizes come for nothing and stay right whatever a muxer's numbering
scheme is. A file opened twice is one file, so an HLS playlist rewritten on
every segment is not counted forty times.

A stream has no size because there is nothing to stat, and the number reported
is what went through the socket. It is the same vocabulary a recording with no
`-t` uses — `openEnded`, and zero meaning nobody knows — rather than a second
convention.

**And "open the result" is a real question when the result is not one file.**
For `hls` and `dash` the answer is the playlist: it is the file that was named
and the only thing that says what order the pieces go in. For a numbered run it
is the first picture, because a run has no index and `out%04d.png` is not a name
anything can open. For a `tee` it is whichever destination is local. For a
stream there is **nothing** — what was sent has gone — so no button is offered,
because one that opened a socket would be worse than its absence.

**A destination can fail in ways a file cannot, and that is reported rather than
handled.** A port nothing is listening on is refused before the render starts,
naming the URL — *cannot reach 'tcp://…'* — rather than as the message about a
filename `avio_open` would have given. A connection that drops half way through
stops the render with the destination named and libav's own account of it
beside, in the report drawer, which is where a render says what it was told; a
disconnect is not a defect in this application and nothing here pretends
otherwise. What is deliberately *not* built is retrying: `-reconnect`,
`-rw_timeout` and the `fifo` muxer are what ffmpeg has for that and all three are
ordinary options in the columns beside the destination.

Two things about a destination are warned about rather than discovered:
`+faststart` on a stream, which rewrites the file after the trailer and cannot
be done to something that cannot be rewound — it fails at the end, after
everything has been sent — and a **keyframe interval longer than the segment
time**, which succeeds and quietly produces segments of the wrong length,
because a segment can only start on a keyframe.

## What is in the file

`Write` is the output's **stream list**: one row per stream the muxer will
number, in the order it will number them. A file is not a picture and a
soundtrack — it is a list of streams — and everything this application could
not say before followed from that list not existing.

A row reads as a statement rather than as a grid of labelled inputs:

> **A2** the mix, through `aac` — *fra · “Commentary” · forced · comment*

The usual two — the composite through one video encoder, the mix through one
audio encoder — arrive without anyone asking, because that is what nearly
every render is. `+ Video`, `+ Audio`, `+ Subtitle` and `+ Attachment` add one;
`×` takes one
away, including the last video stream, which is what a sound-only render is.
Everything a row does not say it takes from the Encode stage, so a second audio
track is one click and not twenty controls.

**A stream nothing feeds is not written, and the row says so.** Drop a file with
no audio track on the timeline and the mix has nothing to be made of — the
render leaves the stream out, which is right, and the row that would have
claimed it says it will not be written rather than describing a track that will
not be there. It stays on the stage, because adding a file with sound will use
it. The command bar prints `-an`, which is how ffmpeg spells the same thing.

**The first word of the row is where its content comes from**, and there are
two answers. The composite and the mix are made — the edit, composited and
summed, through an encoder. A **copy** is not made at all: it is one input's
packets, going into the file exactly as they came out, which is `-map 0:1`
and `-c:v copy`. Picking one changes the rest of the sentence, because a
copied stream has no encoder to choose: the codec in the file is the codec that
was in the input, so it is stated rather than offered.
