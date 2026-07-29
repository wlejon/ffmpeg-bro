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
- **What came back** — the container on one line, then **one line per stream**:
  `V0  h264  1920×1080 · 29.97 fps · yuv420p · bt709`. Everything else the probe
  reported — profile, language, pixel aspect, colour range, per-stream duration — is
  on that line's tooltip. Straight out of `probe()`, run **with the options in
  force**, so it is the answer to "what did the thing I just set do" rather than a
  description of the file as libavformat's defaults see it.

**And under the column, the act.** `Use on the timeline`, pinned, with the reason
beside it where it is dead — `A device has no end`, `One picture, no time at all`,
`Never ends — set Stop at`, `Nothing to play`, `Will not open`. Those five mirror
`openInput()` exactly, so the button is never alive and then refusing. `Re-probe` and
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

**A still is a decision about how long it is.** A single picture is no time at all —
libavformat says so, and bro's `<video>` agrees, because it drives its clock from
decoded pictures and one picture is nothing to advance through. So a still is opened
as `-loop 1` with a `-t`: the loop makes the input go on producing the same picture,
and the `-t` is the only thing that can say how long it lasts. Both are **Hold for**,
which is one field because they are one decision, and the command bar prints the pair
of them in front of the `-i`. Take the loop away and the input has no length; the
application says so — on the pinned bar, where the act it refuses is — rather than
putting a clip of nothing on the timeline.

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
