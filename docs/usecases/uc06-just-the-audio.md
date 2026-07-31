[← Use cases](README.md)

# UC06 — Get just the audio out, as an mp3

> **Who** somebody making a podcast episode out of a recorded call
> **Wants** the soundtrack on its own, in a format anything will play

**5 steps · 2 stages · 2 ffmpeg concepts · 1 hidden.**
Script: [`tests/usecases/uc06_just_the_audio.js`](../../tests/usecases/uc06_just_the_audio.js)

## The path

1. Drop the recording.
2. Go to Write.
3. Take the video row out of the file with `×`. *(needs: the stream list)*
4. Open the picker, search `mp3`, choose the mp3 muxer. *(needs: muxer)*
5. Name the file and Export.

## What the application gets right

**The model is the right one.** A file is a list of streams, so "no video" is
removing a row rather than a checkbox called *audio only* — which means the same
gesture gives you two audio tracks, or a video with no sound, or a copy of one
stream and an encode of another, with nothing special-cased.

**Choosing the mp3 muxer narrowed the audio codec to what mp3 holds**, so the
codec followed the container without a second decision. That is
`avformat_query_codec` earning its keep, and it is why this is five steps rather
than seven.

## What went wrong

**You have to know a file is a list of streams before any of it means
anything.** The row reads `V1 the composite through libx264` — a description of
what will happen, not obviously a thing you can delete — and the `×` beside it
looks like it closes something.

**The job is one intention and every partial version of it succeeds.** The
container is on Write, the audio codec is on Encode. Do only one and you get an
`.mp3` containing AAC, or an MP4 containing mp3. Both render, both are wrong,
neither says anything.

## What would fix it

- **Offer the whole job once.** *Export the audio only* is a recognisable thing
  to want, and it is the stream-list edit plus a container plus a codec — all of
  which the application can already choose correctly on its own.
- Keep the stream list exactly as it is underneath. The point is not to replace
  the model with a mode; it is that the model should not be the only way in.
- **Make the row look editable.** Everything else on the stage that can be
  removed says so; this one is the most important row on the page.
