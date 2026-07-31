[← Use cases](README.md)

# UC02 — Make it small enough to send

> **Who** somebody with a recording too big for the upload limit they have been given
> **Wants** the same video, under a size they were told, without thinking about codecs

**6 steps · 3 stages · 2 ffmpeg concepts · 0 hidden.**
Script: [`tests/usecases/uc02_small_enough_to_send.js`](../../tests/usecases/uc02_small_enough_to_send.js)

The most common thing anybody asks a video tool for after "trim it", and the one
this application is least shaped to answer — because the question is a **file
size** and every control here is a quality.

## The path

1. Drop the file.
2. Go to Encode.
3. Press the **Small file** starting point. *(The right press, right there —
   this is the presets earning their place.)*
4. Look for the size. There isn't one. *(needs: CRF, rate control)*
5. Go to Write, name the file.
6. Export and find out.

## What went wrong

**Nothing anywhere takes a size, and nothing predicts one.** The preset sets a
CRF; the quality readout says `34 · small file`; no arithmetic anybody can do in
their head turns that into megabytes.

*What will be written* does carry an estimate — but only for a bitrate-driven
render, or once a preview has been measured. Constant quality is the default and
is what every preset sets, so on the ordinary path the answer to the only
question being asked arrives with the file.

The nearest available control is Bitrate mode in kbps, which asks the person to
compute `size = bitrate × duration ÷ 8` and to remember the audio track.

## What would fix it

- **A size target is a rate-control mode.** `Rate` already offers Quality,
  Bitrate, Two-pass, Capped and Lossless — all of them answers to "how should
  the bits be spent". *Fit in ___ MB* is the sixth, and it is the one most
  people arrive holding. It resolves to a bitrate the application already knows
  how to set, because the timeline knows the duration and the stream list knows
  the audio track.
- **Two-pass is already here**, and it is exactly the machinery a size target
  wants — measure where the bits are needed, then spend a known budget. This is
  less new capability than a new way in to what is built.
- **An estimate for constant quality, marked as an estimate.** The preview
  measurement is honest and costs a render nobody asked for. A rough figure from
  the CRF, the size and the rate, labelled rough, beats silence — and silence is
  what the stage gives today.
