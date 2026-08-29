[← The manual](../docs/manual/README.md)

# tools/

Scripted jobs, run through `ffmpeg-bro-headless` against the same `ui/` the
application is. Each drives the app through its own surface (`__ffmpegBro`), so
every render one of these performs is a render a person could have performed by
hand on the Write stage.

**These are not part of the application and deliberately not in `ui/`.**
Resolving a Twitch page is one HTTP request that happens *before* ffmpeg's model
starts, so the ffmpeg-only pass took it out of the app (commit `3d09af1`) and it
lives here, beside the only things that ever wanted it.

| | |
|---|---|
| [`supercut.js`](supercut.js) | every time somebody said a thing, found and cut |
| [`pull_vod.js`](pull_vod.js) | one VOD, or one window of one, as a stream copy |
| [`transcribe.js`](transcribe.js) | one file's words, with times, as cues |
| [`montage.js`](montage.js) | a rhythmic montage of a phrase, on a beat grid |
| `vod.js` `corpus.js` `clips.js` `flipbook.js` `speech.js` `transcript.js` `drive.js` | the parts they share |

## supercut.js

```
ffmpeg-bro-headless ui/ tools/supercut.js -- list turk --last 5
ffmpeg-bro-headless ui/ tools/supercut.js -- pull turk --last 4 --skip 1
ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe turk
ffmpeg-bro-headless ui/ tools/supercut.js -- phrases turk --n 3
ffmpeg-bro-headless ui/ tools/supercut.js -- search turk "you cross"
ffmpeg-bro-headless ui/ tools/supercut.js -- clips turk "you cross" --pad 2
ffmpeg-bro-headless ui/ tools/supercut.js -- flipbook turk "you cross" --hold 6
```

Eight verbs, none of which redoes what a previous run finished. They are
separate because their costs are: `pull` is the network, `transcribe` is the
GPU, and `search`, `phrases` and `clips` are cheap and are the ones you actually
iterate on. Welding them together would mean re-pulling seventeen gigabytes to
try a different phrase.

```
build/corpus/<login>/channel.json          what the channel has, newest first
build/corpus/<login>/<id>/media.mkv        the recording, picture and sound
build/corpus/<login>/<id>/words.srt        one cue per word
build/corpus/<login>/<id>/state.json       what has been done to it
build/corpus/<login>/clips/<phrase>/       a clip per hit, cached
```

Once a channel is built, every later question is answered off disk. Nothing
after `transcribe` touches the network, and `clips` re-run on a search you have
already cut writes nothing — a clip is named `<vodId>-<seconds>.mp4`, which is
exactly what identifies the moment, so two searches landing on one moment share
the file and a wider `--pad` is a new file rather than a silent overwrite.

### Picking the phrase

`phrases <channel> --n 3` ranks what is actually said, which is the half of a
supercut that is hard. You cannot search for a catchphrase you have not noticed,
and the phrase you remember is often not the phrase the ASR wrote — so two hits
for a half-remembered one is ambiguous between "rarely said" and "spelt some
other way in here". Ranking answers both.

Names are the sharp case. A regular called **ucross** is written `you cross` by
the model, every time, because that is what it sounds like — so the search that
finds him is `"you cross|ucross"`, and no amount of fuzzy matching would have
guessed it. That is what the `|` alternates are for.

### Three things that change what you do

**Transcribing needs the CUDA build.** `build/` is configured
`BRO_WITH_TENSOR_CUDA=OFF` and Parakeet runs on the CPU there, which for a
six-hour broadcast is not a wait anybody sits through. `build-cuda/` has it on
and logs `[stt] Parakeet loaded on CUDA` when it has worked:

```
build-cuda/Release/ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe turk
```

Measured: **10.5× realtime** on a 4090, so an hour of broadcast is about six
minutes. Everything else — pulling, searching, the flipbook — is happy on either
build.

**Pull today's broadcast last.** A recording Twitch is still finalising reads at
about **1.2 MB/s**; a settled one reads at **14–40 MB/s** through the identical
code, on the same CDN host, while raw parallel fetches of the slow one's own
segments run at 41 MB/s. It is not the network and it is not the reader. `--skip
1` leaves the newest out, which is how the other four get done in the time that
one would have spent on its own.

**A pull in flight has a valid part-file on disk**, so "the file is there" is
not "the recording is here". `transcribe` asks the state written after the pull
reported done, which is what lets a pull and a transcribe run at the same time —
one process on the network, one on the GPU. `status` says `partial` for the one
being written.

### Why the whole recording is pulled, and not just the sound

A transcript reads the soundtrack and nothing else, and Twitch's audio-only
rendition is thirty times smaller — 0.6 GB against 17.4 GB for six hours. An
earlier version of this pulled that, and it cost far more than it saved.

**Two renditions of one Twitch VOD do not share a zero.** They are separate
transcodes. Measured over sixteen consecutive words the audio-only copy ran
0.80 s ahead of the 1080p60 one, while both reported the same duration to the
millisecond and neither carried a start time — and at three points of the same
pair the offset was +0.80 s, +2.21 s and +2.57 s. Growing, but not steadily:
that is a *step*, where an ad break was resolved differently in the two, and no
offset and no slope corrects it.

So a transcript from the cheap copy could not be used to cut the expensive one.
Every cut had to re-transcribe ten seconds of the picture rendition to find the
phrase again on *its* clock — a fetch, a decode and a model pass per hit, to
recover a fact the transcript already knew. Pulling the picture makes the words
and the frames the same file's seconds, and the whole alignment step deletes.

### Searching

A phrase is matched over the words flattened into one stream of letters, because
**an ASR does not put the spaces where you would**: across six hours it will
write `you cross`, `youcross` and `you crossed` for three utterances a person
would call the same, and comparing word-by-word finds only the first. Losing
hits is the failure that matters here, because a missed instance is invisible.

- A match must begin where a word begins and end where a word ends, or
  `you cross` finds itself inside `you crossing`. `--loose` turns that off.
- `"you cross|ya cross"` is one search for either. Stating the variants is
  honest where a fuzzy matcher guessing at them would not be.
- `--spacing S` collapses hits closer together than S seconds (default 2): a
  phrase said three times for emphasis is one moment.

Every hit prints a `twitch.tv/videos/…?t=1h23m45s` link. A supercut assembled
from times nobody checked is one nobody can defend.

### The flipbook

One video frame per instance, played back to back — at 30 fps, forty instances
is one and a third seconds. `--hold N` holds each for N frames instead, which is
the difference between a strobe and something you can watch.

Each instance is rendered out as a PNG and the flipbook is an image sequence:
one `-i`, no decoders, where forty one-frame clips would be forty decoders open
on six-hour files. **The stills are kept** beside the video — they are the
evidence for every frame in it, and opening one is how you find out whether a
hit was really the phrase.

The frame is taken `--into` seconds after the word starts (default 0.10), not at
the attack: a frame at the exact start catches a mouth still opening.
