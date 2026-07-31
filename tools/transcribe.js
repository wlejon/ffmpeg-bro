// Transcribe a media file to cues, through ffmpeg-bro and bro's ASR.
//
// Two halves that have to meet in the middle. libav decodes whatever the file
// is — an HLS URL, a 400 MB Matroska, a camera file — and Parakeet wants
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
// The output is an `.srt` beside the input, which is deliberate: this
// application already reads a subtitle file as an ordinary `-i`, already draws
// its cues over the program monitor, and already knows how to burn them in. A
// transcript that arrives as cues is a transcript every part of the app can
// already use, and nothing had to learn a new kind of thing.
//
// Usage:
//   ffmpeg-bro-headless ui/ tools/transcribe.js -- <media> [options]
//     --from <seconds>   start of the window to transcribe. Default 0.
//     --to <seconds>     end of it. Default: the end of the file.
//     --chunk <seconds>  how much to decode at once. Default 300.
//     --window <seconds> how much to feed the model at once. Default 30.
//     --overlap <secs>   context around each window. Default 1.5.
//     --out <path>       where the .srt goes. Default: <media>.srt
//     --device cpu|cuda  Default: whatever bro.stt picks — cuda when built.

import { loadSpeech, wordsOf, renderAudio } from './speech.js';

const argv = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = argv[0];
assert(media, 'usage: … tools/transcribe.js -- <media> [--from s] [--to s]');

function opt(name, fallback = '') {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const A = globalThis.__ffmpegBro;
const fs = require('fs');
const ROOT = fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/');

const from = Number(opt('from', '0')) || 0;
const toArg = Number(opt('to', '0')) || 0;
// **Chunked, because the model wants the clip in memory as floats.** 16 kHz
// mono float32 is 64 kB per second — five and a quarter hours is 1.2 GB in one
// allocation, before the model has touched it. Five minutes is 19 MB and is a
// unit a render can also be watched finishing.
const chunkSeconds = Number(opt('chunk', '300')) || 300;
// **The window the model listens to is not the window that gets decoded, and
// conflating them is the difference between half an hour and most of a day.**
// The encoder's self-attention is quadratic in the length of what it is handed,
// measured on a 4090 at about 2.3 ms per second²:
//
//      10 s →     543 ms      120 s →  30 064 ms
//      30 s →   2 472 ms      180 s →  73 681 ms
//      60 s →   9 113 ms
//
// which is 18.4× realtime at ten seconds and 2.4× at three minutes — so cost
// *per second of audio* is `2.3·n + 300/n` and grows with n past about 11 s.
// Handing it the 300-second render window would be the slowest thing this file
// could do. A render, meanwhile, has a fixed setup cost that wants the opposite:
// few, large. So the two are separate numbers, the decode stays at five minutes,
// and the model is fed short slices of the buffer already in memory.
//
// **Fifteen seconds, because it is also the most accurate**, which was the
// surprise. The same two minutes of VOD, by window length:
//
//      15 s → 11.3× realtime, 82 words       30 s → 7.1×, 73 words
//      20 s → 11.0× realtime, 78 words       45 s → 7.1×, 61 words
//
// A longer window does not merely cost more, it *finds less* — the 45-second run
// loses a fifth of the words, and the 30-second run drops a whole closing
// sentence the 15-second one hears. Parakeet is a TDT transducer trained on
// short segments, so there is no accuracy being traded away here for speed.
const windowSeconds = Number(opt('window', '15')) || 15;
// **Padding, so no word is cut in half by a boundary.** Each window is decoded
// with `overlap` seconds of its neighbours on both sides as pure context, and
// keeps only the words whose *start* lands in its own span — so a word straddling
// a boundary is whole in exactly one window and counted once. Without it, 318
// minutes at 30-second windows is 637 chances to lose the word being searched
// for, which for a montage built by searching is the failure that matters.
const overlapSeconds = Number(opt('overlap', '1.5')) || 1.5;
const device = opt('device', '');
const verbose = argv.indexOf('--verbose') >= 0;

function pump(ms) {
    const n = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < n; i++) { wallSleep(20); advanceTime(20); flush(); }
}
function until(what, p, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (p()) return true; pump(120); }
    throw new Error(`timed out waiting for ${what}`);
}

// ── the file ───────────────────────────────────────────────────────────────

const probe = bro.ffmpeg.probe(media);
assert(probe.audio, `${media} has no soundtrack to transcribe`);
const total = probe.format.duration;
const to = toArg > 0 ? Math.min(toArg, total) : total;
console.log(`${media}`);
console.log(`  ${(total / 60).toFixed(1)} min, transcribing ` +
            `${(from / 60).toFixed(1)}–${(to / 60).toFixed(1)} min`);

A.shell.goTo('sources');
pump(200);
const input = A.inputs.addInput({ path: media });
until('the file to open', () => !!input.probe || !!input.error, 120000);
assert(!input.error, `could not open it: ${input.error}`);
A.openInput(input);
pump(500);

// ── 16 kHz mono, which is what the model eats ──────────────────────────────
//
// The render, the wav reader and the word assembly all live in `speech.js`,
// because `montage.js` needs the same three and the last of them is subtle
// enough that two copies would drift.

// ── the model ──────────────────────────────────────────────────────────────

console.log('loading Parakeet…');
const t0 = Date.now();
const speech = loadSpeech(ROOT, { device });
const parakeet = speech.model;
console.log(`  ready in ${((Date.now() - t0) / 1000).toFixed(1)} s · ` +
            `${speech.sampleRate} Hz · ${speech.frameSeconds} s per frame`);

// ── window by window ───────────────────────────────────────────────────────

const cues = [];
const tmp = `${ROOT}/build/vod/.transcribe.wav`;
let audioSeconds = 0;
let spentDecoding = 0;
let spentListening = 0;

for (let start = from; start < to; start += chunkSeconds) {
    const end = Math.min(to, start + chunkSeconds);

    const tDecode = Date.now();
    const audio = renderAudio(A, { pump, until }, start, end, tmp);
    spentDecoding += Date.now() - tDecode;
    // Checked rather than trusted: the model refuses anything but 16 kHz and
    // says so, and the useful place to find out is here, naming what the render
    // actually produced.
    assert(audio.sampleRate === parakeet.sampleRate,
           `the render produced ${audio.sampleRate} Hz, and the model wants ` +
           `${parakeet.sampleRate} — the sample rate was clamped somewhere`);

    const tHear = Date.now();
    if (verbose)
        console.log(`    buffer ${audio.samples.length} samples = ` +
                    `${(audio.samples.length / audio.sampleRate).toFixed(1)} s ` +
                    `(asked for ${(end - start).toFixed(1)} s)`);
    // Window by window across the buffer that is already in memory. `subarray`
    // is a view, so the padding costs nothing but the model's own time on it.
    for (let winAt = start; winAt < end; winAt += windowSeconds) {
        const winTo = Math.min(end, winAt + windowSeconds);
        // Padded outwards, clamped to what was actually decoded.
        const readFrom = Math.max(start, winAt - overlapSeconds);
        const readTo = Math.min(end, winTo + overlapSeconds);
        const at = (t) => Math.round((t - start) * audio.sampleRate);
        const res = parakeet.transcribe({
            samples: audio.samples.subarray(at(readFrom), at(readTo)),
            sampleRate: audio.sampleRate,
        });
        if (verbose) {
            const kept = res.tokenFrames.length
                ? `${(readFrom + res.tokenFrames[0] * parakeet.frameSeconds).toFixed(1)}` +
                  `..${(readFrom + res.tokenFrames[res.tokenFrames.length - 1] * parakeet.frameSeconds).toFixed(1)}`
                : '—';
            console.log(`    win ${winAt.toFixed(0)}–${winTo.toFixed(0)} ` +
                        `read ${readFrom.toFixed(1)}–${readTo.toFixed(1)} ` +
                        `(${at(readTo) - at(readFrom)} samples) → ` +
                        `${res.tokenIds.length} tokens at ${kept}`);
        }

        // Words, with the boundaries the tokenizer itself draws. `wordsOf` is
        // shared with montage.js and says why it cannot be done per token.
        for (const w of wordsOf(speech, res, readFrom))
            if (w.from >= winAt && w.from < winTo) cues.push(w);
    }
    spentListening += Date.now() - tHear;
    audioSeconds += end - start;

    const done = end - from;
    const span = to - from;
    console.log(`  ${(100 * done / span).toFixed(0)}% · ` +
                `${(end / 60).toFixed(1)} min · ${cues.length} words · ` +
                `${(audioSeconds / ((spentDecoding + spentListening) / 1000)).toFixed(1)}× realtime`);
}

try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }

// ── out as cues ────────────────────────────────────────────────────────────

const stamp = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const sec = Math.floor(ms / 1000) % 60;
    const rem = ms % 1000;
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(sec)},${p(rem, 3)}`;
};

// **Absolute, because a relative path here does not mean what it looks like.**
// `require('fs')` resolves against the *app* directory (`ui/`), not the working
// directory the command was typed in — so `--out out/x.srt` writes to
// `ui/out/x.srt` and a bare `<media>.srt` default lands beside the manifest
// rather than beside the media. Resolving it here against the repo root is what
// makes the printed path and the written path the same file.
const rel = opt('out', `${media.replace(/\.[^./\\]+$/, '')}.srt`);
const out = /^([a-z]:[\\/]|[\\/])/i.test(rel) ? rel : `${ROOT}/${rel}`;
const srt = cues.map((c, i) =>
    `${i + 1}\n${stamp(c.from)} --> ${stamp(Math.max(c.to, c.from + 0.08))}\n${c.text}\n`)
    .join('\n');
fs.writeFileSync(out, srt, 'utf-8');

const wall = (spentDecoding + spentListening) / 1000;
console.log(`${cues.length} words in ${wall.toFixed(0)} s ` +
            `(${(audioSeconds / wall).toFixed(1)}× realtime — ` +
            `${(spentDecoding / 1000).toFixed(0)} s decoding, ` +
            `${(spentListening / 1000).toFixed(0)} s listening)`);
console.log(`  ${out}`);
console.log('done');
