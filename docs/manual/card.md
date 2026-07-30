[← The manual](README.md)

# The card

There is no "use hardware acceleration" checkbox, and that is a finding rather
than an omission. **Decoding on a card and encoding on a card are two different
decisions with opposite answers on this machine**, so they are two controls in
the two places they belong: the device an input decodes on is on Sources, in
front of the `-i` beside `-probesize`, because a decoder belongs to an input;
the encoder a stream is written with is on Encode, because that is what a stream
is. One switch covering both would be wrong about half of what it did.

What the menus offer is what this machine turned out to have. `bro.ffmpeg
.hwaccels` lists what the *build* has — every type a vcpkg ffmpeg is compiled
with is in it on every machine, card or no card — so nothing is drawn from it.
`bro.ffmpeg.hardware()` creates a device of each type and reports whether that
worked, and the picker is cut down again by whether this build's decoder for
*this codec* has a configuration for that device. Two RTX 4090s still do not
give you a CUDA ProRes decoder.

That question is asked by *failing*, so it is asked with the report channel
muted. Every type the build carries and this machine has no card for answers
with an error — on a machine with NVIDIA cards, `AMFQueryVersion failed with
error 1` — and those are not things a render said: left in the channel they
open the report drawer red under a render that went perfectly, before anybody
has pressed anything. What the failure was is reported as the device's own
`error`, which is where somebody asking about a card is already looking.

**Unavailable refuses, and says why. It never falls back silently.** A type that
is compiled in and absent, a driver that will not answer, a codec the card
cannot decode: each stops the open with the reason named. That is this repo's
standing rule — a render must not succeed while ignoring what it was told —
and here it has a second edge, because on this hardware falling back to software
would make the render *faster*, and nobody would ever notice it happening.

## What it measured

`tests/hardware_test.cpp`, on this machine: **AMD Ryzen 9 7950X3D (16 cores, 32
threads) and two NVIDIA GeForce RTX 4090s**, driver 610.62, vcpkg ffmpeg with
`nvcodec` and `amf`. Four device types work here — `cuda`, `dxva2`, `d3d11va`,
`d3d12va` — and `amf` does not: AMF is compiled in and there is no AMD card.

One pass over a file, `nextRaw` a frame at a time, milliseconds per picture:

| | 640×360 | 1920×1080 | 3840×2160 |
|---|---|---|---|
| software, threaded across all cores | **0.05** | **0.35** | **1.70** |
| cuda, brought back to system memory | 0.29 | 1.21 | 4.51 |
| cuda, left on the card | 0.29 | 1.17 | 4.38 |

**Hardware decode is a loss here, by between two and six times, and the readback
everybody blames is not the reason.** Bringing a 4K frame down costs 3% of the
decode's wall clock; the decode itself is what is slow, because NVDEC is a
throughput engine being asked for one frame at a time while libavcodec has
thirty-two threads and frame-level parallelism. It is offered anyway — a laptop
with four cores and a QSV block has different numbers, and it is the only way to
feed a hardware filter graph without an upload — but the **Decode on** picker carries
the measurement, so it is said on the control somebody is about to use.

The encoder is the opposite answer. The same 1.6 s of output, rendered three
ways at the source's own size:

| | 640×360 | 1920×1080 | 3840×2160 |
|---|---|---|---|
| decode + composite + x264 `ultrafast`, all in system memory | **56 ms** | 453 ms | 1848 ms |
| decode on the card, filter on it, NVENC, never coming down | 96 ms | **205 ms** | **565 ms** |
| decode on the CPU, upload, NVENC | 85 ms | **190 ms** | 591 ms |

**Above SD the card is worth two to three times, and below it the card loses
outright** — 4K is 3.3× and 640×360 is 0.6×, because a small frame is all
fixed cost and a GPU round trip is mostly fixed cost. Note the third row: on this
machine the *best* arrangement at 1080p is a software decode uploaded straight
into NVENC, which is what falls out of hardware decode being the slower half.
And note that x264 is on `ultrafast` throughout — at `medium` the gap widens by
a great deal more than these numbers show.

## Choosing it for you, on a press

Two decisions in two places is right, and it is also two decisions in two places.
So the Encode stage carries **`Choose for me`**, which applies the arrangement the
tables above arrived at — *software decode, hardware encode, above SD* — to this
machine and this render, and then says what it did.

> H.264 (NVIDIA) on cuda, because 1080 lines is above SD and the card is worth two
> to three times there — measured, in docs/manual/card.md. Same codec as libx264,
> so what will play on the other end has not changed. landscape.mp4 is decoding on
> a device and goes back to the CPU: the decode is measured two to six times slower
> there, and the readback everybody blames is 3% of it.

**A press, and never automatic.** An application that quietly rewrote your encoder
when you opened a file would be the "use hardware acceleration" checkbox this one
exists without, one step worse: it would be making the choice *and* not saying so.
The sentence is not a nicety — choosing on somebody's behalf and then having to say
so is the entire cost of the feature, so it is on the button before the press as
well as on the stage after it.

**It asks the machine, never a list.** Which encoders run on a device here is
`bro.ffmpeg.hardware()`'s answer, cut down to the ones this build carries; nothing
in it names a device or an encoder. The only preference it expresses is *which* of
several to reach for, and even that is derived — the same codec as the one already
chosen, read off `codecName`, so a press changes where the encoding happens and not
what will play on the other end.

**And it says so when there is nothing to choose.** A machine with no working
device, or one whose devices report no encoder this build carries, gets the sentence
naming that rather than a button that appears to do nothing — the same rule the
**Decode on** picker follows when nothing here can decode the file.

Below SD it presses the other way, because that is what the second table says: a
device encoder at 360 lines is moved back to the CPU, naming both. The line is
drawn at **576** — the top of standard definition — and not at a measured number,
because the measurement has 640×360 at 0.6× and 1920×1080 at 2.2× and no number in
that gap is more honest than another.

## Never coming down

A render whose pictures are made on a card and encoded on the same card does not
touch system memory at any point. It is not a special path: `FrameSource` grew
two optional questions — which pool the pictures arrive in, and the picture
itself rather than a canvas — and a hardware encoder is *opened against that
pool*, so `avcodec_open2` builds its surfaces from the graph's own. Everything
else about the job is unchanged.

Which means the arrangement is reachable by wiring it. Put an `hwupload` on the
last wire before the output, choose `h264_nvenc`, and the render has nothing to
copy; the command bar prints `-filter_hw_device cuda` and the `hwupload` in the
graph, and a standalone ffmpeg given that command does the same thing. It is
all-or-nothing per file: a render that kept its pictures up and had one software
video stream in it is refused, naming the stream, rather than downloading behind
your back.

Two consequences worth knowing. A render on this path **ends when its graph
ends** — there is no black frame past the last picture, because black would have
to be made in system memory and uploaded once a frame, which is the cost the
path exists to avoid. And the **viewer cannot show a clip whose input keeps its
pictures on the card** in the way you might expect: playback downloads every
frame unconditionally, because bro's renderer takes three planes it can read and
there is no path in playback that could hand it a device handle.

## Filters on the card

`hwupload`, `hwdownload` and whatever `_cuda` / `_qsv` / `_vulkan` / `_d3d11`
filters this build has are ordinary nodes on the graph — the palette offers them
because it offers whatever libavfilter reports, and there is no list of hardware
filters written down anywhere. The device they get is `-filter_hw_device`, and
it is derived rather than asked for: an input that decodes on a device names one,
a filter that belongs to a device names one, and `hwupload` takes no argument
that could name a third.

**A picture on a card reaching a filter that reads pixels is libavfilter's least
readable failure** — four hundred pixel format names, twice, and nothing in it
saying the word hardware. The Graph stage names the node and says which way to
cross. And a clip whose input keeps its pictures up gets an `hwdownload` at the
head of its chain from the derivation, because that is exactly what the
compositor does with one, and the printed command and the render have to agree.

Worth knowing about builds: **a vcpkg ffmpeg with `nvcodec` gets NVDEC and NVENC
and not the `scale_cuda`/`overlay_cuda` family**, which needs the CUDA compiler
at configure time. So this build can decode on the card and encode on the card
with nothing at all to put between them — and a picture still never has to come
down, because `trim` and `setpts` are arithmetic on timestamps and pass any
format through.
