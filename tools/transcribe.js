// Transcribe one media file to cues, through ffmpeg-bro and bro's ASR.
//
// Two halves that have to meet in the middle. libav decodes whatever the file
// is — an HLS URL, a 17 GB Matroska, a camera file — and Parakeet wants
// **16 kHz mono float samples**, so the first half is an ordinary render with
// the encoder set to `pcm_s16le` at 16 kHz and one channel, which is a thing
// this application already knows how to do and does not need a private path for.
//
// **Parakeet rather than Whisper**, for three reasons that all matter here:
// it is unconditional (no prompt to build), it makes one pass over the whole
// clip instead of Whisper's 30-second windows with their seek-by-last-timestamp
// long-form dance, and it reports `tokenFrames` — the encoder frame each token
// came from — so a word has a *time* without any of the alignment guesswork
// timestamps-in-the-token-stream needs. `frameSeconds` is 0.08, so the timing is
// good to 80 ms, which is far finer than any cut anybody makes by hand.
//
// The output is an `.srt`, which is deliberate: this application already reads a
// subtitle file as an ordinary `-i`, already draws its cues over the program
// monitor, and already knows how to burn them in. A transcript that arrives as
// cues is a transcript every part of the app can already use, and nothing had to
// learn a new kind of thing.
//
// **This is the one-file tool.** `supercut.js` is the one that does a whole
// channel and keeps a store; the decode-then-listen loop itself belongs to
// neither and lives in `speech.js`, where the window lengths are written down
// beside the measurements that chose them.
//
// Usage:
//   ffmpeg-bro-headless ui/ tools/transcribe.js -- <media> [options]
//     --from <seconds>   start of the window to transcribe. Default 0.
//     --to <seconds>     end of it. Default: the end of the file.
//     --chunk <seconds>  how much to decode at once. Default 300.
//     --window <seconds> how much to feed the model at once. Default 15.
//     --overlap <secs>   context around each window. Default 1.5.
//     --out <path>       where the .srt goes. Default: <media>.srt
//     --device cpu|cuda  Default: whatever bro.stt picks — cuda when built.

import { loadSpeech, transcribeSpan } from './speech.js';
import { writeSrt } from './transcript.js';
import { ROOT, abs, positionals, opt, num, driver, span, clock, unlink }
    from './drive.js';

const A = globalThis.__ffmpegBro;
const media = positionals()[0];
assert(media, 'usage: … tools/transcribe.js -- <media> [--from s] [--to s]');

const probe = bro.ffmpeg.probe(abs(media));
assert(probe.audio, `${media} has no soundtrack to transcribe`);
const total = probe.format.duration;
const from = num('from', 0);
const toArg = num('to', 0);
const to = toArg > 0 ? Math.min(toArg, total) : total;
console.log(`${abs(media)}`);
console.log(`  ${span(total)} · transcribing ${clock(from)}–${clock(to)}`);

A.shell.goTo('sources');
driver.pump(200);
const input = A.inputs.addInput({ path: abs(media) });
driver.until('the file to open', () => !!input.probe || !!input.error, 120000);
assert(!input.error, `could not open it: ${input.error}`);
const clip = A.openInput(input);
assert(clip, 'it would not lay out as a clip');
driver.pump(500);

console.log('loading Parakeet…');
const t0 = Date.now();
const device = opt('device', '');
const speech = loadSpeech(ROOT, device ? { device } : {});
console.log(`  ready in ${((Date.now() - t0) / 1000).toFixed(1)} s · ` +
            `${speech.sampleRate} Hz · ${speech.frameSeconds} s per frame`);

const scratch = `${ROOT}/build/.transcribe.wav`;
const res = transcribeSpan(A, driver, speech, {
    from, to, wav: scratch,
    chunkSeconds: num('chunk', 0) || undefined,
    windowSeconds: num('window', 0) || undefined,
    overlapSeconds: num('overlap', undefined),
    onChunk: (c) => {
        const pct = 100 * (c.at - from) / Math.max(0.001, to - from);
        console.log(`  ${pct.toFixed(0)}% · ${clock(c.at)} · ${c.words} words · ` +
                    `${c.realtime.toFixed(1)}× realtime · ` +
                    `${span((to - c.at) / Math.max(0.01, c.realtime))} left`);
    },
});
unlink(scratch);

// **Absolute, because a relative path here does not mean what it looks like.**
// `require('fs')` resolves against the *app* directory (`ui/`), not the working
// directory the command was typed in — so `--out out/x.srt` writes to
// `ui/out/x.srt`. `abs()` against the repo root is what makes the printed path
// and the written path the same file.
const out = abs(opt('out', `${media.replace(/\.[^./\\]+$/, '')}.srt`));
writeSrt(out, res.words);

console.log(`${res.words.length} words in ${span(res.secondsDecoding + res.secondsListening)} ` +
            `(${res.realtime.toFixed(1)}× realtime — ` +
            `${res.secondsDecoding.toFixed(0)} s decoding, ` +
            `${res.secondsListening.toFixed(0)} s listening)`);
console.log(`  ${out}`);
console.log('done');
