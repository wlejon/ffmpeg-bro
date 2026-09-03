// How loud a span of a recording actually is, read off a worker.
//
// This is the acoustic half of the energy search: `monologues` in `ui/phrase.js`
// can say how fast somebody was talking and how often they wrote `!`, and it
// cannot say whether any sound was made. The words are a transcript's opinion of
// the delivery; this is a measurement of it.
//
// **Why a worker.** A span of a six-hour recording is a decode — the same
// argument the block at the top of `ui/analyze-worker.js` makes about a
// waveform — and a ranking asks for two dozen of them. Done where it was first
// written, on the thread drawing the window, that was several seconds of frozen
// application per press with nothing on the screen saying why: the whole reason
// this module exists. Now the list arrives on what the words alone say and the
// sound is folded in behind it, a span at a time, with a count of what is left.
//
// **Why this is not `ui/analysis.js`.** That file reads a *clip* so a timeline
// lane can be drawn, and every entry in it is keyed by a clip id and by the
// window the timeline is showing. What is asked for here is a span of a file no
// clip exists for — a stretch of talking in a recording that may never reach the
// mix — so the two would share a map with nothing in common but the call at the
// bottom, and that call is `bro.media.peaks`, which is already one home. They do
// share the worker *script*, which is the part that would otherwise be copied.
//
// **One span in flight at a time.** The worker is one thread, so a queue of
// twenty-four posted at once buys no parallelism and costs the only thing that
// matters here — the ability to stop. A phrase typed, a mode changed or a panel
// closed abandons a ranking mid-read, and what that has to cancel is a queue of
// one.

/// Where the worker script is, relative to the running application's directory.
/// The second application lives one directory along and passes its own path, for
/// `ui/analysis.js`'s reason: one worker script, not two that can come to
/// disagree about what a reading means.
let workerPath = 'analyze-worker.js';
let worker = null;

/// Must be called before the first read, which is what building the worker
/// lazily is for. Answers false if it is already too late to matter.
export function useWorker(path) {
    if (worker) return false;
    workerPath = path || 'analyze-worker.js';
    return true;
}

/// Is there a worker to read with at all?
///
/// **A run without one is not an error and must not be a stall**: the energy
/// ranking still has the words, and the caller says so rather than reading two
/// dozen spans on the thread it is drawing from. See `stepSearch` in
/// `ui/library.js`, which is the only caller.
export function available() {
    return typeof Worker === 'function';
}

let nextId = 1;
const open = new Map();   // reading id → reading

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerPath);
    worker.onmessage = (e) => receive(e.data || {});
    return worker;
}

/// Begin reading the loudness of these spans, as `[{ path, from, to }]`.
///
/// Answers a reading whose `rms` fills in as the spans land: `rms[i]` is the
/// loudest bucket of span `i`, or `null` for one that has not been read and
/// `0` for one that could not be. Those are three different facts and a caller
/// ranking on them has to be able to tell them apart — an unreadable file is not
/// a silent one.
export function begin(spans) {
    const list = (spans || []).filter((s) => s && s.path);
    const reading = {
        id: nextId++,
        spans: list,
        rms: list.map(() => null),
        read: 0,
        total: list.length,
        done: !list.length,
        landed: false,
        sent: 0,
    };
    if (!list.length || !available()) {
        reading.done = true;
        return reading;
    }
    open.set(reading.id, reading);
    post(reading);
    return reading;
}

/// Hand the worker the next span. One at a time — see the block above.
function post(reading) {
    if (reading.sent >= reading.spans.length) return;
    const i = reading.sent++;
    const s = reading.spans[i];
    ensureWorker().postMessage({
        clip: reading.id, token: i, half: 'sound',
        path: s.path, from: s.from || 0, to: s.to || 0,
        // Enough buckets to catch a shout inside a stretch and few enough that
        // the answer is a number rather than a waveform: what is wanted is the
        // loudest moment in the span, not its shape.
        n: 32,
    });
}

function receive(msg) {
    const reading = open.get(msg.clip);
    if (!reading) return;                      // cancelled while it was reading
    const i = msg.token;
    if (typeof i !== 'number' || i < 0 || i >= reading.rms.length) return;
    let loudest = 0;
    const p = msg.peaks;
    if (p && p.rms && p.rms.length) {
        for (let k = 0; k < p.rms.length; k++)
            if (p.rms[k] > loudest) loudest = p.rms[k];
    }
    reading.rms[i] = loudest;
    reading.read++;
    reading.landed = true;
    if (reading.read >= reading.total) {
        reading.done = true;
        open.delete(reading.id);
        return;
    }
    post(reading);
}

/// Has anything landed since the last time this was asked?
///
/// Cleared by the asking, so a frame loop can use it to decide whether to redraw
/// — which is the whole of what a caller does with it.
export function poll(reading) {
    if (!reading || !reading.landed) return false;
    reading.landed = false;
    return true;
}

/// Abandon a reading. The span already with the worker is still decoded — there
/// is no way to reach into it — but its answer is dropped and no further span is
/// posted, which is the difference between a cancelled ranking costing one span
/// and costing twenty-four.
export function cancel(reading) {
    if (!reading) return;
    open.delete(reading.id);
    reading.done = true;
}
