// The shape of a word's sound, read off a worker, for the ruler to draw.
//
// A block on the line is a word and what a person wants to see on it is where
// the sound is: whether the attack is inside the cut, whether the tail runs on
// into the next syllable. That is an envelope of a span a fraction of a second
// long, out of a recording that may be six hours — and it is asked for once per
// word on the line and once more per take auditioned.
//
// **Why this is not `ui/analysis.js`.** That file reads a *clip* — its map is
// keyed by clip id, the read is of the whole file for a local one, and the
// answer is scattered into a grid the size of the file. A word on the line has
// no clip until the line is put in the mix, and reading six hours of envelope
// to draw three hundred milliseconds of it is the cost `ui/loudness.js` refuses
// for the same reason. So this is `loudness.js`'s shape one size down: a span
// keyed by its own numbers, one in flight, the answer kept for as long as the
// line is likely to ask again.
//
// **Why it is not `ui/loudness.js`.** That module answers one number per span
// — the loudest bucket, for a ranking — and this answers a picture. They share
// the worker script and the call under it, which is the part that must not be
// copied.

/// Where the worker script is, relative to the running application. The second
/// application passes `../ui/analyze-worker.js`, as it does for the other two.
let workerPath = 'analyze-worker.js';
let worker = null;

export function useWorker(path) {
    if (worker) return false;
    workerPath = path || 'analyze-worker.js';
    return true;
}

export function available() { return typeof Worker === 'function'; }

/// How many answers are kept. A line is a few dozen words and a take strip a
/// couple of dozen more; past this the oldest goes, and is simply read again.
const KEPT = 400;

/// Answers by key, in insertion order so the oldest is first to go.
const have = new Map();
/// Keys asked for and not yet answered, in the order they were asked.
const queue = [];
let inFlight = null;
let landed = false;
let nextToken = 1;

function keyOf(path, from, to, n) {
    return `${path}|${from.toFixed(3)}|${to.toFixed(3)}|${n}`;
}

/// The envelope of `path` from `from` to `to`, in `n` buckets, or null while
/// it is being read. Asking is what starts the read; asking again is free.
///
/// The answer is `{ min, max, rms }`, three arrays of `n`, or `{ error }` for
/// a span that could not be read — kept as well, so a file that will not open
/// is not asked to open on every frame.
export function wave(path, from, to, n = 64) {
    if (!path || !(to > from)) return null;
    const key = keyOf(path, from, to, n);
    const got = have.get(key);
    if (got) return got;
    if (!available()) return null;
    if ((inFlight && inFlight.key === key) || queue.some((q) => q.key === key)) return null;
    queue.push({ key, path, from, to, n });
    post();
    return null;
}

/// Has an answer landed since this was last asked? Cleared by the asking, so
/// the frame loop can repaint on the frames something arrived and no other.
export function poll() {
    const was = landed;
    landed = false;
    return was;
}

/// How many spans are still to be read, for a line that says so.
export function pending() { return queue.length + (inFlight ? 1 : 0); }

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerPath);
    worker.onmessage = (e) => receive(e.data || {});
    return worker;
}

function post() {
    if (inFlight || !queue.length) return;
    inFlight = queue.shift();
    inFlight.token = nextToken++;
    ensureWorker().postMessage({
        clip: 'wave', token: inFlight.token, half: 'sound',
        path: inFlight.path, from: inFlight.from, to: inFlight.to, n: inFlight.n,
    });
}

function receive(msg) {
    if (!inFlight || msg.clip !== 'wave' || msg.token !== inFlight.token) return;
    const job = inFlight;
    inFlight = null;
    let answer;
    const p = msg.peaks;
    if (msg.error || !p || !p.min) answer = { error: msg.error || 'no sound' };
    else answer = { min: p.min, max: p.max, rms: p.rms };
    if (have.size >= KEPT) have.delete(have.keys().next().value);
    have.set(job.key, answer);
    landed = true;
    post();
}

/// Drop every answer and every waiting read. For a corpus that has moved.
export function forget() {
    have.clear();
    queue.length = 0;
}
