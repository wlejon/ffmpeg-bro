// Getting the speech model itself — the one thing a corpus needs that is not a
// recording, and the last step this application sent people to a shell for.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// `corpus/words.js` searches three places for a Parakeet checkpoint and refuses
// by name when there is none, and until this file the whole of the answer was
// the sentence it ends on: *run brosoundml's scripts/download-parakeet.sh*. That
// is a fine answer in a checkout and no answer at all in a downloaded nightly,
// which ships no brosoundml, no scripts directory and no bash — so the one
// button in that build somebody actually wants to press was gated behind a file
// they did not have. `supercut/acquire.js` already goes and gets the recordings;
// a window that fetches six hours of somebody talking and cannot fetch the 2.5 GB
// that make it searchable is drawing a line in a strange place.
//
// ── Why it is JS and not a native downloader ───────────────────────────────
//
// `bro.ffmpeg.fetch` is the packet path (`fetch_queue.h`) and refuses by name a
// spec it cannot perform: a safetensors blob is not a media stream and there is
// no demuxer for it, so putting this there would mean teaching that surface a
// second job that has nothing to do with ffmpeg's model. What is actually needed
// is an HTTP GET with a `Range` header, which bro already has: measured through
// this engine, a 32 MB range of the real checkpoint comes back in 3.6 s at
// 9.4 MB/s, `Range` is honoured (206, with `content-range` carrying the total),
// and `fs.appendFileSync` takes a `Uint8Array` and appends the bytes. So the
// whole mechanism is a loop over ranges, and the reason it is a *loop* rather
// than one request is memory: the body arrives as one ArrayBuffer, and the
// checkpoint is 2.5 GB.
//
// ── Three rules, all of them somebody else's ───────────────────────────────
//
// **Written `.part` and renamed when whole**, which is `proxy_queue.h`'s rule
// and `corpus/pull.js`'s: a file under its real name is a file the search will
// find, and half a checkpoint under its real name is a model that loads and
// throws somewhere inside brosoundml. The rename is the moment it exists.
//
// **Resumed from what is on disk**, `pull.js` again, for the same reason: this
// is minutes of somebody's connection and a window that was closed must not
// start again from zero. The guard against resuming onto the wrong bytes is the
// total the server reports — a `.part` longer than the file it claims to be part
// of is thrown away rather than finished.
//
// **Nothing here decides to download anything.** It runs on a press, it can be
// stopped, and it never starts itself: the weights are 2.5 GB of somebody's
// bandwidth and a checkpoint nobody asked for is the download this application
// would be remembered for.
//
// The files, the repository and the layout are NVIDIA's and Hugging Face's, and
// they are the ones `brosoundml/scripts/download-parakeet.sh` fetches — that
// script is the other home for this list and the two must agree. It is the model
// `spoken_words.cpp` loads and the model every `words.srt` in a store was
// written by; a checkpoint of some other model would transcribe fine and put
// every word on a different clock from the corpus it was extending.

import { exists, sizeOf, mkdirp, rename, unlink } from './files.js';
import { modelHome, isCheckpoint, checkpointIn, forgetSpeechModel } from './words.js';

/// The default variant, and the only one this knows the shape of. `--size` on
/// brosoundml's script is the same string, and the directory it lands in is
/// named after it for the reason `checkpointIn` looks one level down: a second
/// checkpoint beside it is a second directory rather than an overwrite.
export const SIZE = '0.6b-v3';

/// Where the bytes come from. `resolve/main` is the raw-file endpoint, which is
/// what the script uses and what redirects to the CDN that serves ranges.
const REPO = (size) => `https://huggingface.co/nvidia/parakeet-tdt-${size}`;
const URL_FOR = (size, file) => `${REPO(size)}/resolve/main/${file}`;

/// What a checkpoint is made of. The three that are required are the three
/// `loadModel` names in `spoken_words.cpp`; the rest are what the model card
/// ships beside them and what the script fetches with a 404 allowed, because
/// not every checkpoint has every one.
const FILES = [
    { name: 'config.json', need: true },
    { name: 'tokenizer.json', need: true },
    { name: 'tokenizer_config.json', need: false },
    { name: 'special_tokens_map.json', need: false },
    { name: 'preprocessor_config.json', need: false },
    { name: 'generation_config.json', need: false },
    // Last, because it is 2.5 GB and everything above it is under 4 MB: a run
    // that is interrupted early leaves the small files done and the big one
    // resumable, rather than the other way round.
    { name: 'model.safetensors', need: true },
];

/// How much is asked for at a time.
///
/// Measured on this connection: 32 MB in 3.6 s, so a progress bar moves about
/// once every four seconds and a press of **Stop** is felt within one range.
/// Larger buys nothing — the rate is the connection's — and costs memory, since
/// a range is one `ArrayBuffer` before it is one append.
const CHUNK = 32 * 1024 * 1024;

/// Where a checkpoint of this size would go: the first place `words.js` looks.
export const modelDir = (size = SIZE) => `${modelHome()}/${size}`;

/// Is it already here? What the press asks before offering itself.
export const modelHere = (size = SIZE) => isCheckpoint(modelDir(size));

// ── one download ───────────────────────────────────────────────────────────

/// Start fetching a checkpoint. Synchronous; answers a job to poll.
///
/// `{ size, dir, state, file, done, bytes, total, progress, error }` where
/// `state` is one of:
///
///   `fetching`  running; `file` is what is being read and `progress` is of it
///   `done`      every required file is on disk under its real name
///   `failed`    `error` says which file and why; what landed is left in place
///   `skipped`   there is already a checkpoint there and `opts.again` was unset
///   `stopped`   somebody pressed stop; the `.part` is kept for the next press
///
/// **The press comes straight back**, which is this window's rule everywhere
/// (`ui/output.js`'s `play()`, `cuts.js`'s `+`, `acquire.js`'s `get`): the first
/// request is a round trip and the loop below runs off it, so nothing here waits
/// for the network. A caller polls; a command line pumps.
export function startModel(opts = {}) {
    const size = String(opts.size || SIZE);
    // `opts.dir` is the script's `--out-dir` and exists for the same reason: a
    // checkpoint on another disk, and a suite that must not write 2.5 GB into
    // the place the application reads from.
    const dir = opts.dir ? String(opts.dir).replace(/\\/g, '/').replace(/\/+$/, '')
                         : modelDir(size);
    const job = { size, dir, state: 'fetching', file: '', done: 0,
                  bytes: 0, total: 0, progress: 0, began: Date.now(),
                  error: '', stopping: false };

    // **Asked the way the search asks it**, one level down included: a `dir`
    // that is a `weights/parakeet` rather than a size directory holds a
    // checkpoint as far as everything else in this repository is concerned, and
    // a fetch that did not think so would download 2.5 GB alongside one that is
    // already there.
    if (checkpointIn(dir) && !opts.again) {
        job.state = 'skipped';
        return job;
    }

    mkdirp(dir);
    run(job).catch((e) => {
        // Only a failure the loop did not already describe: it sets `error` on
        // the file it was reading, which is the more useful sentence.
        if (job.state === 'fetching') {
            job.state = 'failed';
            job.error = String((e && e.message) || e);
        }
    });
    return job;
}

/// Where it has got to. Idempotent, and the one call a frame loop makes.
///
/// There is nothing to do here — the loop writes the job as it goes — and that
/// is deliberate rather than lazy: everything this could finish on the frame it
/// lands is a file operation, and a file operation on the UI thread is what the
/// rest of this directory arranges to avoid. What it does do is drop
/// `words.js`'s cached answer once, so that the frame after the last file lands
/// is the frame `Transcribe` appears on.
export function pollModel(job) {
    if (job && job.state === 'done' && !job.announced) {
        job.announced = true;
        forgetSpeechModel();
    }
    return job;
}

/// Stop it. The `.part` stays where it is and the next press carries on from it.
export function stopModel(job) {
    if (!job || job.state !== 'fetching') return job;
    job.stopping = true;
    return job;
}

/// Is there still something to wait for?
export const fetching = (job) => !!job && job.state === 'fetching';

/// A line about where it has got to. One statement, drawn on a control and
/// printed by a command line both.
export function modelNote(job) {
    if (!job) return '';
    if (job.state === 'skipped') return 'the model is already here';
    if (job.state === 'failed') return job.error;
    if (job.state === 'stopped') return `stopped · ${gbOf(job.bytes)} of ${job.file}`;
    if (job.state === 'done') return 'the model is here';
    const pct = Math.round((job.progress || 0) * 100);
    return job.total > 1e6
        ? `${job.file} · ${pct}% of ${gbOf(job.total)}`
        : `${job.file}`;
}

const gbOf = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB`
                             : `${Math.max(1, Math.round(n / 1e6))} MB`);

// ── the loop ───────────────────────────────────────────────────────────────

/// Every file, in order, each in ranges. Async, and the only thing in this file
/// that is.
async function run(job) {
    for (const f of FILES) {
        if (job.stopping) { job.state = 'stopped'; return; }
        const dest = `${job.dir}/${f.name}`;
        // Already whole from an earlier run. Nothing is re-fetched: a resumed
        // download of a checkpoint is mostly this branch.
        if (exists(dest) && sizeOf(dest) > 0) { job.done++; continue; }

        job.file = f.name;
        job.bytes = 0;
        job.total = 0;
        job.progress = 0;
        const why = await fetchWhole(job, URL_FOR(job.size, f.name), dest, f.need);
        if (job.state === 'stopped') return;
        if (why) {
            // An optional file that is not in this checkpoint is not a failure:
            // the script allows a 404 on the same six names for the same reason.
            if (!f.need) { job.done++; continue; }
            job.state = 'failed';
            job.error = `${f.name}: ${why}`;
            return;
        }
        job.done++;
    }
    // What was asked for is not what makes it a model: the three files the
    // native loader names are, and it is the same test the search makes.
    job.state = isCheckpoint(job.dir) ? 'done' : 'failed';
    if (job.state === 'failed')
        job.error = `${job.dir} is still not a checkpoint after fetching it`;
}

/// One file, in ranges, into `<dest>.part`, renamed when it is whole.
///
/// Answers '' or a sentence. Never throws for an ordinary network answer, since
/// a refusal about one optional file is a `continue` above.
async function fetchWhole(job, url, dest, need) {
    const part = `${dest}.part`;
    let have = exists(part) ? sizeOf(part) : 0;
    // Before the first range comes back, so a resumed file reports the bytes it
    // already has rather than 0% for the four seconds the first one takes.
    job.bytes = have;

    for (;;) {
        if (job.stopping) { job.state = 'stopped'; return ''; }
        let res = null;
        try {
            res = await fetch(url, { headers: { Range: `bytes=${have}-${have + CHUNK - 1}` } });
        } catch (e) {
            return String((e && e.message) || e);
        }
        // 416 is "you asked past the end", which is what a `.part` that is
        // already the whole file answers. Anything else outside 200/206 is a
        // real answer about the file — a 404 on an optional one lands here.
        if (res.status === 416) break;
        if (res.status !== 200 && res.status !== 206) {
            if (!need && res.status === 404) return `HTTP ${res.status}`;
            return `HTTP ${res.status}`;
        }

        // The total comes off `content-range` (`bytes from-to/total`), which is
        // the only place the server states the *file's* length rather than the
        // range's. A 200 means ranges were ignored and this is the whole file.
        const range = headerOf(res, 'content-range');
        const total = range ? Number(String(range).split('/')[1]) : 0;
        if (total > 0) job.total = total;
        if (res.status === 200) { have = 0; try { unlink(part); } catch (e) { /* fresh */ } }

        let bytes = null;
        try { bytes = new Uint8Array(await res.arrayBuffer()); }
        catch (e) { return String((e && e.message) || e); }
        if (!bytes.length) break;

        // **A `.part` longer than the file cannot be finished into it.** The one
        // way to get here is a leftover from a different revision of the same
        // name; throwing it away costs the download again and keeps a corrupt
        // checkpoint off the disk.
        if (job.total && have + bytes.length > job.total) {
            try { unlink(part); } catch (e) { /* nothing there */ }
            return 'what was already here does not belong to this file';
        }

        const fs = require('fs');
        try { fs.appendFileSync(part, bytes); }
        catch (e) { return String((e && e.message) || e); }
        have += bytes.length;
        job.bytes = have;
        job.progress = job.total > 0 ? have / job.total : 0;

        // **A short range is not the end of the file** unless the file's own
        // length says so: a CDN may hand back less than was asked for, and a
        // loop that took that for the end would rename a truncated checkpoint
        // into place. The length is what decides, and only where the server did
        // not state one is a short answer read as the end.
        if (job.total) { if (have >= job.total) break; }
        else if (bytes.length < CHUNK) break;
    }

    if (job.total && have !== job.total)
        return `got ${have} bytes of ${job.total}`;
    if (!rename(part, dest)) return 'could not put it under its own name';
    return '';
}

/// One header, whatever shape the response's headers are.
///
/// Guarded because this is the one place a `Response` is asked for something
/// other than its body: a build whose headers are a plain object rather than a
/// `Headers` would otherwise throw here, and the answer is only used to draw a
/// percentage.
function headerOf(res, name) {
    try {
        if (res.headers && typeof res.headers.get === 'function')
            return res.headers.get(name);
        return (res.headers || {})[name] || '';
    } catch (e) { return ''; }
}
