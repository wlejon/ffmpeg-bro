[← The manual](README.md)

# The card

There is no single "use hardware acceleration" checkbox, because decoding on
a card and encoding on a card are two different decisions with, on typical
hardware, opposite answers. They are two controls in two places: the device
an input decodes on is on Sources, because a decoder belongs to an input; the
encoder a stream is written with is on Encode, because that is what a stream
is.

What the menus offer is only what *this machine* turns out to have — every
device type this build supports is probed by actually creating one, and the
picker only lists what worked. A codec can still be unsupported on a device
that otherwise works: two RTX 4090s do not give you a CUDA ProRes decoder if
the build's decoder for that codec has no configuration for that device.

**Unavailable refuses, and says why. It never falls back silently.** A device
type that is compiled in but absent, a driver that will not answer, a codec
the card cannot decode — each stops the open with the reason named, because
on capable hardware a silent fallback to software would make the render
*faster*, and you would never notice it happening.

## What it measured

The advice built into this application — the `Choose for me` button below,
and the guidance next to the Decode-on and encoder pickers — was tuned on one
machine: an AMD Ryzen 9 7950X3D with two NVIDIA RTX 4090s. Your hardware may
give different numbers, but the general pattern below holds across most
consumer GPUs and is why the advice defaults the way it does.

**Hardware decode is usually a loss, not a win.** On the measured machine it
was two to six times slower than software decode across all core counts, and
copying the frame back to system memory was not the reason — the decode
engine itself is a throughput accelerator being asked for one frame at a
time, while software decode is threaded across every core. Hardware decode is
still offered, because it is the only way to feed a hardware filter graph
without an upload step, and it may win on hardware with fewer CPU cores.

**Hardware encode is the opposite: usually a real win, above a certain
resolution.** On the measured machine, above standard definition the card
encoded two to three times faster than software; at 360p and below the card
lost outright, because a small frame is mostly fixed overhead and a GPU round
trip is mostly fixed cost too. The best arrangement at 1080p on that machine
was software decode feeding the encoder directly on the card, rather than
decoding on the card as well.

## Choosing it for you, on a press

The Encode stage carries **`Choose for me`**, which applies that arrangement
— software decode, hardware encode, above standard definition — to your
machine and your render, and says what it did and why:

> H.264 (NVIDIA) on cuda, because 1080 lines is above SD and the card is
> worth two to three times there. Same codec as libx264, so what will play on
> the other end has not changed. landscape.mp4 is decoding on a device and
> goes back to the CPU: the decode is measured slower there.

**A press, and never automatic.** Nothing here rewrites your encoder on its
own — the whole point of not having a single "hardware acceleration"
checkbox is that a choice like this should be visible, not quiet.

It asks the machine for what is actually available rather than assuming from
a name, and its one preference is to keep the same codec family already
chosen, so pressing it changes *where* encoding happens rather than what will
play on the other end. If nothing on your machine can do better, it says so
instead of doing nothing silently. The line between "above SD" and "at or
below SD" is drawn at 576 lines — the top of standard definition — since the
measured gap between what wins and loses is wide enough that no exact number
in between is more honest than another.

## A second card

Which device *index* to use (`-hwaccel_device`) is asked of the machine the
same way presence is: by trying to create device 0, then 1, and so on until
it fails. **Which one** on Sources is therefore a real picker built from what
this machine actually has, not a text box you have to guess a number into.

**An index this machine does not have is shown, not silently snapped to the
default.** A document written on a two-card machine and opened on a one-card
laptop keeps its `-hwaccel_device 1`, marked as not available here, and the
render is refused at open with libav's own reason — rather than quietly
running on a different card than the one the document names.

### What the second one is worth

Two cards of the same model are not guaranteed to perform identically — a
card on a narrower PCIe link measured a few percent slower on the same
render — so the picker is worth having even on a machine with two of the same
GPU.

**A second card is rarely worth a second render.** Running two renders at
once, one per card, was measured directly: at 1080p a second render on the
*same* card cost only a few percent more than one, because the encoder was
never the bottleneck — so a second card bought almost nothing. Only a genuinely
saturated encoder (4K, the slowest preset, decode on the card too) showed a
real win from a second card, and even there most of the benefit came from
running two jobs at once rather than from the second card specifically. The
A/B comparison's reference render deliberately does not use a card at all,
for the same reason: it exists to be compared against, not to be fast. See
[Not yet](not-yet.md) for more on running more than one render at a time.

## Never coming down

A render whose pictures are made on a card and encoded on the same card never
touches system memory. Put `hwupload` on the last wire before the output,
choose a hardware encoder such as `h264_nvenc`, and the render has nothing
left to copy — the command bar's `-filter_hw_device` and `hwupload` describe
exactly that, and a standalone `ffmpeg` given the same command does the same
thing. It is all-or-nothing per file: a render that would otherwise keep its
pictures up but still has one software video stream in it is refused, naming
the stream, rather than silently downloading behind your back.

Two consequences worth knowing. A render on this path **ends when its graph
ends** — there is no way to hold a black frame past the last picture without
an upload, so this path does not do it. And **the viewer cannot show a clip
whose input keeps its pictures on the card**: playback always downloads every
frame, so this path is for rendering, not for previewing.

## Filters on the card

`hwupload`, `hwdownload` and whatever `_cuda`/`_qsv`/`_vulkan`/`_d3d11`
filters this build has are ordinary nodes on the Graph stage's palette — it
offers whatever libavfilter reports, with no separate hardware-filter list.
The device such a filter runs on is derived automatically from whichever
input or filter already named one; `hwupload` itself takes no argument that
could name a device.

**A picture on a card reaching a filter that expects one in system memory
fails with libavfilter's own, fairly unreadable, pixel-format error.** The
Graph stage names the node and says which way to cross when this happens. A
clip whose input keeps its pictures on a device gets an `hwdownload` added to
the front of its chain automatically, to match what the compositor itself
does with such a clip.

Whether this build can filter *on* the card (`scale_cuda`, `overlay_cuda`,
and similar) depends on how it was built — decoding and encoding on the card
work without it, since `trim` and `setpts` are pure timestamp arithmetic and
pass any pixel format through untouched.
