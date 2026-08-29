// Transcribe one media file to cues — the one-file tool.
//
// libav decodes whatever the file is — an HLS URL, a 17 GB Matroska, a camera
// file — and Parakeet reads the mono 16 kHz that comes out. Both halves are
// `bro.ffmpeg.words` now: the resample is `SourceAudio`'s and the windowing is
// `src/native/spoken_words.h`'s, on a thread, so this file is a command line, a
// progress line and an `.srt` writer and nothing else.
//
// **It used to render a wav.** The old path drove the Write stage to encode
// five-minute chunks of `pcm_s16le` at 16 kHz, read each back with a hand-written
// RIFF parser and handed the floats to a synchronous `bro.stt` call — which is
// where the three window lengths lived, and where a second copy of them could
// drift from the corpus's. There is one home for that recipe now and it is not
// in JS, which is why `--chunk`, `--window` and `--overlap` are gone: they were
// parameters on a loop this file no longer performs, and the numbers they
// defaulted to are asserted by `tests/words_test.cpp`.
//
// **Parakeet rather than Whisper**, for the reason `spoken_words.h` gives at
// length: it reports the encoder frame each token came from, so a word has a
// *time* — good to 80 ms — where Whisper times a phrase of several seconds.
// Everything this repository does with a transcript is built on the word.
//
// The output is an `.srt`, which is deliberate: this application already reads a
// subtitle file as an ordinary `-i`, already draws its cues over the program
// monitor, and already knows how to burn them in. A transcript that arrives as
// cues is a transcript every part of the app can already use, and nothing had to
// learn a new kind of thing.
//
// **This is the one-file tool.** `supercut.js` is the one that does a whole
// channel and keeps a store; the step it runs per recording is
// `corpus/words.js`, which this and it both drive — the difference being only
// that one writes into the store and this writes beside the file.
//
// Usage:
//   ffmpeg-bro-headless ui/ tools/transcribe.js -- <media> [options]
//     --out <path>       where the .srt goes. Default: <media>.srt
//     --model <dir>      the Parakeet checkpoint. Default: beside the repo.
//     --device cpu|cuda  Default: whatever the build picks — cuda when built.

import { startRead, pollRead, reading, SPEECH_MODEL } from '../corpus/words.js';
import { writeSrt } from '../corpus/srt.js';
import { abs, positionals, opt, driver, span, clock } from './drive.js';

const media = positionals()[0];
assert(media, 'usage: … tools/transcribe.js -- <media> [--out x.srt]');

// Probed here rather than left to the reader, for two reasons that are both
// about the first frame: "no soundtrack" is worth saying before a model is
// loaded onto a card, and the length is what the percentage is a percentage of.
const probe = bro.ffmpeg.probe(abs(media));
assert(probe.audio, `${media} has no soundtrack to transcribe`);
const total = probe.format.duration;
console.log(`${abs(media)}`);
console.log(`  ${span(total)} · ${SPEECH_MODEL}`);

const device = opt('device', '');
const job = startRead(abs(media), {
    duration: total,
    model: opt('model', '') || undefined,
    device: device || undefined,
});
assert(job.state !== 'failed', `could not start reading it: ${job.error}`);

// Once a second, because the read runs at about 11× realtime on a 4090 and a
// six-hour file is half an hour of it. `read` is how far down the file the
// reader has got — the one number that makes a partial answer honest.
// Started at now, not at zero: the first poll lands before the reader has opened
// the file, and "0% · 0 words · 0.0× realtime · 40.7 min left" about a
// twenty-four-second clip is a line that is wrong about everything it says.
let said = Date.now();
driver.until('the words', () => {
    pollRead(job);
    const now = Date.now();
    if (reading(job) && job.read > 0 && now - said > 5000) {
        said = now;
        const pct = 100 * job.read / Math.max(0.001, job.duration);
        const left = (job.duration - job.read) / Math.max(0.01, job.realtime);
        console.log(`  ${pct.toFixed(0)}% · ${clock(job.read)} · ${job.words} words · ` +
                    `${job.realtime.toFixed(1)}× realtime · ${span(left)} left`);
    }
    return !reading(job);
}, 13 * 60 * 60 * 1000);

assert(job.state !== 'failed', `reading it failed: ${job.error}`);
if (job.state === 'stopped')
    console.log(`  stopped after ${clock(job.read)} — writing what was read`);

// **Absolute, because a relative path here does not mean what it looks like.**
// `require('fs')` resolves against the *app* directory (`ui/`), not the working
// directory the command was typed in — so `--out out/x.srt` writes to
// `ui/out/x.srt`. `abs()` against the repo root is what makes the printed path
// and the written path the same file.
//
// **Written even when the read was stopped, which the corpus does not do.** The
// store's rule is that a transcript is finished or absent, because a search over
// half of one answers "he never said that" about the rest and nothing in the
// file says so. Nothing searches *this* file but the person who asked for it,
// standing at the terminal that just printed how far it got — so here the words
// that were read are worth having, and the sentence above is what says they are
// not all of them.
const out = abs(opt('out', `${media.replace(/\.[^./\\]+$/, '')}.srt`));
writeSrt(out, job.result);

console.log(`${job.result.length} words in ${span(job.elapsed)} ` +
            `(${job.realtime.toFixed(1)}× realtime)` +
            (job.truncated ? ` — capped; ${job.total} were heard` : ''));
console.log(`  ${out}`);
console.log('done');
