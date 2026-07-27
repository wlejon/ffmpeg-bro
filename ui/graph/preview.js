// What each node actually produces, rendered.
//
// A node card states what a filter is configured with. That is not the same as
// knowing what comes out of it — `crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25` is a claim
// about a picture, and the only way to check a claim about a picture is to look
// at one. So each node gets a short clip of its own output, rendered through
// `graph/subgraph.js` by the same `GraphSource` the export uses, and played in
// the card.
//
// **Rendered, not simulated.** There is no second compositor here and no
// preview-only path: what a card shows is what that pad hands its consumer. A
// preview that agreed with the render only most of the time would be worse than
// none, because it would be trusted.
//
// Four things make it affordable, and each of them is a rule rather than a
// tuning knob:
//
// - **One at a time, behind the export.** The host has a single render slot and
//   `render.start` refuses while it is held, so this queues, and it never takes
//   the slot while an export or an A/B preview wants it. A preview is the least
//   important render in the application.
// - **Only ancestors, only seconds.** The subgraph opens the files the node
//   depends on and no others, over a couple of seconds around the playhead, and
//   each input *seeks* to its window rather than decoding from the start of its
//   file — which is what makes a node on a clip forty minutes in cost the same
//   as one at the top.
// - **Keyed by what it is, not by when it was made.** The cache key is the
//   subgraph text itself, so nudging a value that does not reach a node leaves
//   that node's picture alone, and the derivation regenerating every node
//   object on every timeline edit costs nothing.
// - **Quiet before it starts.** Dragging a slider walks through fifty values;
//   rendering all fifty would make the application unusable to save the last
//   one. Nothing starts until the graph has held still.
//
// The files go where the A/B preview's do, through `bro.ffmpeg.tempPath`, under
// names that never repeat. Overwriting one is not an option: a `<video>` still
// holding the previous render has the file open, and on Windows that is a
// failed render rather than a replaced file.

import { derive } from './derive.js';
import { previewGraph } from './subgraph.js';

/// How much of the timeline a preview shows. Long enough to see motion, short
/// enough that a nine-node graph is populated in a few seconds.
const SECONDS = 2;

/// How long the graph has to hold still before anything renders.
const QUIET_MS = 350;

let hooks = {};
let on = true;
let range = null;                 // { start, end }, snapshotted rather than live
let seq = 0;

/// key → { sig, state, path, reason }. `state` is 'pending' | 'ready' | 'failed'.
const shots = new Map();

const queue = [];
let running = null;               // { key, sig, path }
let settleAt = 0;

export function initPreview(h) { hooks = h || {}; }

export function isEnabled() { return on; }

export function setEnabled(value) {
    on = !!value;
    if (!on) {
        queue.length = 0;
        // A render in flight is left to finish rather than cancelled: it holds
        // the slot either way, and cancelling it would only mean the next
        // export waits for the same work to unwind.
        shots.clear();
    }
    if (hooks.changed) hooks.changed();
}

/// Where in the timeline the previews are taken from. Snapshotted when the
/// stage is opened rather than followed live, because every playhead move would
/// otherwise invalidate every node and re-render the whole graph — for a
/// picture nobody asked to change.
export function setRange(start, end) {
    const a = Math.max(0, Number(start) || 0);
    const b = Math.max(a + 0.1, Number(end) || a + SECONDS);
    if (range && Math.abs(range.start - a) < 1e-6 && Math.abs(range.end - b) < 1e-6) return;
    range = { start: a, end: b };
    shots.clear();
    queue.length = 0;
}

export function rangeStart() { return range ? range.start : 0; }

export const previewSeconds = SECONDS;

export function shotFor(key) { return shots.get(key) || null; }

/// Bring the set of previews into line with the nodes on screen.
///
/// Called after every redraw with the nodes worth a picture and how wide each
/// card is. Everything is decided here — what is stale, what is new, what is
/// gone — because doing it per node as the cards are built would derive the
/// preview graph once per node.
export function sync(wanted) {
    if (!on || !range || !hooks.spec) { queue.length = 0; return; }
    if (!wanted.length) { queue.length = 0; return; }

    const d = derive(hooks.spec(range.start, range.end), hooks.sources(),
                     { overlay: hooks.overlay() });
    if (!d.ok) { queue.length = 0; return; }

    const live = new Set();
    let fresh = false;
    queue.length = 0;
    for (const { key, fit } of wanted) {
        const node = d.graph.node(key) || d.graph.byAnchor(key);
        if (!node) continue;
        const g = previewGraph(d.graph, node, { fit });
        if (!g.ok) continue;
        live.add(key);

        // The signature is the render, spelled out. Two nodes that produce the
        // same picture from the same files share one, and a node whose
        // arguments were not touched keeps its picture through an edit that
        // rebuilt every node object in the graph.
        const sig = `${g.filterGraph}|${JSON.stringify(g.filterInputs)}`;
        const had = shots.get(key);
        if (had && had.sig === sig) {
            // Unchanged — but the queue was emptied above, and an entry still
            // waiting for its turn has to go back on it. Without this the first
            // preview to finish takes the rest of the queue down with it and
            // eight nodes stay blank forever.
            if (had.state === 'pending' && !(running && running.key === key)) queue.push(key);
            continue;
        }
        shots.set(key, { sig, state: 'pending', path: '', reason: '', graph: g });
        queue.push(key);
        fresh = true;
    }

    for (const key of Array.from(shots.keys())) if (!live.has(key)) shots.delete(key);
    // Only something genuinely new restarts the wait. Otherwise each finished
    // preview would push the next one another quiet period into the future, and
    // a nine-node graph would fill in at one node every second for no reason.
    if (fresh) settleAt = Date.now() + QUIET_MS;
}

/// Called once a frame. Everything asynchronous about this is here.
export function tick() {
    if (running) {
        const p = bro.ffmpeg.render.poll();
        if (p.state === 'running') return;
        const shot = shots.get(running.key);
        // Only if it is still the render that was asked for: a graph edit while
        // this was encoding has already replaced the entry, and writing an old
        // picture into a new one is the one way a preview can lie.
        if (shot && shot.sig === running.sig) {
            if (p.state === 'done') {
                shot.state = 'ready';
                shot.path = running.path;
                // How big the picture turned out. Asked of the file rather than
                // of the `<video>`, because the card has to be laid out at the
                // right height *before* the element is in the tree and has
                // anything to report — and this is the one moment the answer is
                // both known and cheap.
                try {
                    const info = bro.ffmpeg.probe(running.path);
                    shot.w = (info.video && info.video.width) || 0;
                    shot.h = (info.video && info.video.height) || 0;
                } catch (e) {
                    shot.state = 'failed';
                    shot.reason = 'nothing came out of it';
                }
            } else {
                shot.state = 'failed';
                shot.reason = p.error || p.state;
            }
        }
        running = null;
        if (hooks.changed) hooks.changed();
        return;
    }

    if (!on || !queue.length || Date.now() < settleAt) return;
    // The slot belongs to whatever else wants it. An export is the point of the
    // application and the A/B preview is a decision being taken; this is a
    // convenience and goes last.
    if (hooks.busy && hooks.busy()) return;
    if (bro.ffmpeg.render.poll().state === 'running') return;

    const key = queue.shift();
    const shot = shots.get(key);
    if (!shot || shot.state !== 'pending') return;

    const spec = hooks.spec(range.start, range.end);
    spec.filterGraph = shot.graph.filterGraph;
    spec.filterInputs = shot.graph.filterInputs;
    // The graph decides how big the picture is. Nothing out here could know:
    // half way down a graph the size is whatever libavfilter made it.
    spec.sizeFromGraph = true;
    // Fast and disposable, and deliberately not the settings being chosen on
    // the Encode stage — an x265 option on an x264 preview is an unknown key
    // and an unknown key is an error, which is right for a render and absurd
    // for a thumbnail.
    spec.videoCodec = 'libx264';
    spec.crf = 30;
    spec.preset = 'ultrafast';
    spec.pixelFormat = 'yuv420p';
    spec.videoOptions = {};
    spec.audio = false;
    spec.faststart = false;
    spec.title = '';
    spec.path = bro.ffmpeg.tempPath(`node-${++seq}.mp4`);

    try {
        bro.ffmpeg.render.start(spec);
    } catch (e) {
        shot.state = 'failed';
        shot.reason = String(e.message || e);
        if (hooks.changed) hooks.changed();
        return;
    }
    running = { key, sig: shot.sig, path: spec.path };
}

/// Whether anything is outstanding, for the status line — a graph that is
/// halfway through filling in should say so rather than looking half broken.
export function outstanding() { return queue.length + (running ? 1 : 0); }
