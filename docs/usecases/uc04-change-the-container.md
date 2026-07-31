[← Use cases](README.md)

# UC04 — Change the container without touching the video

> **Who** somebody whose player will not open the file they have
> **Wants** the same video in a different wrapper, quickly and with nothing lost

**5 steps · 2 stages · 2 ffmpeg concepts · 2 hidden.**
Script: [`tests/usecases/uc04_change_the_container.js`](../../tests/usecases/uc04_change_the_container.js)

Nothing about the video needs to change. The same streams go into a different
wrapper, in about a second, losing nothing.

## The path

1. Drop the file.
2. Go to Write. *(The four stages in between are all about changing the video,
   which is the one thing this job must not do.)*
3. Press **Rewrap &lt;file&gt;**. *(needs: stream copy)*
4. Notice the container did not change, and go and change it. *(needs: muxer)*
5. Name the file and Export.

## What the application gets right

Searching `mkv` finds Matroska, even though nothing in libavformat is called
mkv — the picker searches each muxer's name, its long name and its extension
list, and it deliberately ignores whichever facet you are standing in, so naming
what you want beats the filter. That is the picker being better than
libavformat, and it is the reason this journey is five steps and not eight.

## What went wrong

**The button named after the job does half of it.** `Rewrap` makes every stream
a copy and deliberately leaves the container alone — the reasoning being that
which muxer to write is "the whole of the remaining decision", taken on its own
control a foot away. That is defensible and it means the person who presses the
one control named after their intention gets a render that produces a file
identical to the input.

It succeeds. Nothing says that nothing happened.

The two halves are in different places (the stream column and the destination
band), in an order that is never stated, and neither refers to the other.

## What would fix it

- **One control for one intention.** *Put this in a different container* is a
  single thing to want. It is `Rewrap` plus a muxer choice, and the muxer choice
  is the only part the person has an opinion about — so the gesture should be
  picking the container, with the copy following, rather than the reverse.
- **Refuse the null render, or say it.** A render whose output is byte-identical
  to its input is worth a sentence in *What will be written*, which is exactly
  the sort of thing that column exists to say.
- Keep the picker exactly as it is.
