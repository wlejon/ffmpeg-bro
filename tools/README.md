[← The manual](../docs/manual/README.md)

# tools/

Scripted jobs, run through `ffmpeg-bro-headless` against the same `ui/` the
application is. Most drive the app through its own surface (`__ffmpegBro`), so
every render one of those performs is a render a person could have performed by
hand on the Write stage.

**These are the batch verbs, and the mechanics under them are
[`corpus/`](../corpus/).** Resolving a Twitch page is one HTTP request that
happens *before* ffmpeg's model starts, so the ffmpeg-only pass took it out of
the workbench (commit `3d09af1`) and it has not gone back. But the supercut
application's job *starts* with getting a recording, so page resolution, the
store's layout and the pull itself are now a module set with no interface in
them, imported by this directory and by that window both. What forced the split
was one concrete thing: `pullMedia` used to drive the workbench's Write stage,
so a window without one could not pull a recording at all. Transcribing followed
for the same reason and is `corpus/words.js` now — a window that can search six
hours of somebody talking has to be able to make the transcript it searches.

| | |
|---|---|
| [`supercut.js`](supercut.js) | every time somebody said a thing, found and cut |
| [`pull_vod.js`](pull_vod.js) | one VOD, or one window of one, as a stream copy |
| [`transcribe.js`](transcribe.js) | one file's words, with times, as cues |
| [`montage.js`](montage.js) | a rhythmic montage of a phrase, on a beat grid |
| `corpus.js` `clips.js` `flipbook.js` `weave.js` `speech.js` `transcript.js` `drive.js` | the parts they share |
| [`../corpus/`](../corpus/) `vod.js` `store.js` `pull.js` `srt.js` `words.js` `model.js` `index.js` `files.js` | the parts they share with the supercut application |

## supercut.js

```
ffmpeg-bro-headless ui/ tools/supercut.js -- model
ffmpeg-bro-headless ui/ tools/supercut.js -- adopt D:/footage/interviews
ffmpeg-bro-headless ui/ tools/supercut.js -- list turk --last 5
ffmpeg-bro-headless ui/ tools/supercut.js -- pull turk --last 4 --skip 1
ffmpeg-bro-headless ui/ tools/supercut.js -- transcribe turk
ffmpeg-bro-headless ui/ tools/supercut.js -- phrases turk --n 3
ffmpeg-bro-headless ui/ tools/supercut.js -- search turk "you cross"
ffmpeg-bro-headless ui/ tools/supercut.js -- clips turk "you cross" --pad 2
ffmpeg-bro-headless ui/ tools/supercut.js -- flipbook turk "you cross" --hold 6
ffmpeg-bro-headless ui/ tools/supercut.js -- weave turk "you cross"
ffmpeg-bro-headless ui/ tools/supercut.js -- index turk
```

Thirteen verbs, none of which redoes what a previous run finished. They are
separate because their costs are: `model` is 2.5 GB once, `pull` is the network,
`transcribe` is the GPU, and `search`, `phrases` and `clips` are cheap and are
the ones you actually iterate on. Welding them together would mean re-pulling
seventeen gigabytes to try a different phrase.

`adopt` is `pull` for footage that is already on this disk: a folder becomes a
channel named after itself, and **the files are not copied** — the store keeps a
record and the transcript, and the recordings stay where they are. Everything
after it is the same, `transcribe` included.

`transcribe` needs a Parakeet checkpoint and prints the one it is reading with.
Three places are looked in: a `models/parakeet` folder beside the application,
and `brosoundml/weights/parakeet` in a brosoundml checkout or in bro's own. With
none of them holding one the verb refuses on the command that started it, naming
every place it looked; `--model DIR` is the way to a checkpoint somewhere else.

`model` is the verb that goes and gets one, into the first of those places:
2.5 GB from Hugging Face, in ranges, written `.part` and renamed when whole, so
an interrupted run carries on where it stopped rather than starting again.
`--out DIR` puts it somewhere else and `--again` re-fetches one that is already
there. It is separate from `transcribe` for the reason every verb here is
separate from every other: a mistyped channel name should not start a
multi-gigabyte download.

```
build/corpus/<login>/channel.json          what the channel has, newest first
build/corpus/<login>/<id>/media.mkv        the recording, picture and sound
                                           — absent for an adopted folder, whose
                                             files stay where they already were
build/corpus/<login>/<id>/words.srt        one cue per word
build/corpus/<login>/<id>/state.json       what has been done to it
build/corpus/<login>/clips/<phrase>/       a clip per hit, cached
build/corpus/<login>/find.json            what the app's Find panel reads
build/corpus/find.json                    which channels have been indexed
```

Once a channel is built, every later question is answered off disk. Nothing
after `transcribe` touches the network, and `clips` re-run on a search you have
already cut writes nothing — a clip is named `<vodId>-<seconds>.mp4`, which is
exactly what identifies the moment, so two searches landing on one moment share
the file and a wider `--pad` is a new file rather than a silent overwrite.

### The two applications that read it

`transcribe` writes the manifest when it finishes and `index <channel>` writes it
on its own, and **two** things read it. The
[supercut application](../docs/manual/supercut.md) —
`./build/Release/supercut`, its own window over the same engine — is
where this store is meant to be used: a search down the left, the mix along the
bottom, four gestures on a card and a button that writes the file. And the
[Find panel](../docs/manual/find.md) in `ffmpeg-bro` itself, on `/` over the
Compose stage, for a moment wanted inside a larger edit.

Either way it is the part a terminal cannot do: hearing a hit before committing
to it.

**A file is the whole of the seam for the words.** The manifest is a list of
recordings with absolute paths to their words and their media; `ui/` never
imports anything from here, and this never learns anything about the timeline.
What they share is the matching itself, which lives in `ui/phrase.js` and is
imported back into `transcript.js`, and the corpus reading around it, which is
`ui/library.js` — three views of one library. Two copies of a search are two
chances for the list on the screen and the clips on disk to describe different
sets of moments, and that is not a theoretical worry: when one rule about what
counts as an instance lived only here, the panel found fifteen of a phrase this
found fourteen of.

What is *not* a file seam is making the corpus in the first place, and that is
what [`corpus/`](../corpus/) is: shared modules rather than a shared file,
because "pull this recording" is a verb both faces perform rather than an answer
one of them writes down. Nothing in it touches the DOM at import time and
nothing in it drives an application — the same property that lets `supercut/`
import `ui/project.js`.

The words are not copied into the manifest. The transcripts are a megabyte each
and already in a form the applications read, so they read the `.srt` directly; a
copy would go stale the first time a recording was transcribed again.

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

Measured: **11.3× realtime** on a 4090, so an hour of broadcast is about five
minutes. Everything else — pulling, searching, the flipbook — is happy on either
build. The read runs on a thread and the words arrive while it is running, so the
percentage a run prints is how far down the recording it has got rather than how
many chunks it has been through.

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

**A flipbook has no sound**, and cannot: a frame is a frame. If what you wanted
was to *hear* every instance, that is the weave.

### The weave

The phrase said **once**, with every fragment of it taken from a different
instance — picture and sound. Where the flipbook answers "how many times", this
answers "how many ways", and it is the one that keeps the audio.

Instance *i* of *N* contributes exactly the *i*-th *N*-th **of its own
utterance**: the first take gives its first fourteenth, the second take its
second fourteenth, and so on. The takes are cut at the same point *through the
word* rather than at the same number of milliseconds in, which is what leaves
the result still sounding like somebody saying the word instead of fourteen
unrelated syllables in a row.

**The split is by fraction because the takes are different lengths.** Measured
across these recordings the same word runs 0.48 s in one instance and over a
second in another; a fixed 57 ms cut lands mid-vowel in the short one and barely
past the consonant in the long one, while a fraction lands in the same place in
both.

Nothing is time-stretched, so the finished word is exactly the **mean** of the
utterances it came from — a number that falls out of the material rather than
one to choose, which is why there is no `--length`. Fourteen instances of
"ucross" gave 1.00 s, with fragments from 34 ms to about 110 ms.

`--rounds R` walks the instances R times instead of once, so the cut is R times
faster and the word stays the same length. Watch the *shortest fragment* the run
reports rather than the average: it is the number that decides between something
watchable and a strobe, and at one video frame it is neither seen nor heard.

The edit is saved beside the video as a `.fbro`. A weave is a judgement call — a
fragment landing on a cough is obvious once you hear it and invisible before —
so what you get is an edit to open and nudge, not only a file to watch.
