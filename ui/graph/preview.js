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

import { derive, clipOf } from './derive.js';
import { specInputs } from '../inputs.js';
import { previewGraph } from './subgraph.js';
import * as play from './play.js';
import { deviceForRender } from '../hardware.js';

/// How much of the timeline a preview shows. Long enough to see motion, short
/// enough that a nine-node graph is populated in a few seconds — and also the
/// length of one piece of a playback, which is what lets the still already on a
/// card be the first piece rather than a render somebody has to wait through.
const SECONDS = 2;

/// How long the graph has to hold still before anything renders.
const QUIET_MS = 350;

let hooks = {};
let on = true;
let range = null;                 // { start, end }, snapshotted rather than live
let seq = 0;

/// **When to look at a node**, which is not one moment for the whole graph.
///
/// The previews are taken at a point somebody chose, and a two-second window
/// falls inside at most a couple of clips of a long edit. Everything cut from
/// the others is not in the graph at that instant at all — so those cards had
/// no picture, no failure and no wait, about filters that were working
/// perfectly. Three clips laid end to end left two thirds of the graph blank.
///
/// So a node the chosen point does not reach is looked at from inside its own
/// clip instead. **Two candidates and not one**, because which nodes the
/// derivation makes depends on where the window falls *within* the clip, not
/// merely on which clip it is in. `adelay` is what forced that: the silence it
/// prepends is the clip's offset from the start of the window, so a window
/// beginning exactly where the clip does has no offset to delay by and no
/// `adelay` node in it at all. The second candidate straddles the clip's first
/// moment, which is the only place that node exists — and the picture it gives
/// is the honest one, silence running into sound.
///
/// Nodes belonging to no clip — the canvas, the sinks, the mix — have no other
/// moment to be looked at, and `sync` says so on the card rather than leaving it
/// empty.
function windowsFor(anchor, spans) {
    const span = spans.get(clipOf(anchor));
    if (!span) return [];
    const a = span.start;
    const at = { from: a, to: Math.max(a + 0.1, Math.min(span.end, a + SECONDS)) };
    const b = Math.max(0, a - SECONDS / 2);
    return b < a ? [at, { from: b, to: Math.max(b + 0.1, a + SECONDS / 2) }] : [at];
}

/// Where each clip sits in the render, by the id its anchors are spelt with.
function clipSpans(spec) {
    const spans = new Map();
    for (const c of (spec && spec.clips) || []) {
        if (c.id === undefined || c.id === null) continue;
        spans.set(String(c.id), { start: Number(c.start) || 0,
                                  end: (Number(c.start) || 0) + (Number(c.length) || 0) });
    }
    return spans;
}

/// key → { sig, state, path, from, to, reason }. `state` is 'pending' | 'ready'
/// | 'failed' | 'absent', the last being a node that is in the graph on the
/// screen and in no window this can render — see `sync`. `from`/`to` are the
/// seconds this node in particular is looked at, which are not the same for
/// every node; see `windowsFor`.
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
        play.stop();
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
    // A playback is a walk forward from where the previews were taken. Moving
    // where they are taken from moves its beginning, so it starts again rather
    // than carrying on from a place that is no longer related to it.
    play.stop();
}

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

    // The spec is kept, not just derived from: a waveform has to be drawn at
    // the rate the render walks at, and the rate is the spec's.
    const spec = hooks.spec(range.start, range.end);
    const d = derive(spec, hooks.sources(), { overlay: hooks.overlay() });
    if (!d.ok) { queue.length = 0; return; }
    const spans = clipSpans(spec);

    // **A second derivation, per clip the preview point misses.**
    //
    // `derive()` keeps the clips that fall inside the window it is given, so
    // this one holds only what is on screen at the chosen instant — and the
    // view draws the graph over the *whole* range. Every node cut from a clip
    // outside the window was therefore missing from here entirely, its shot was
    // dropped as gone, and the card drew no picture box at all: not a failure,
    // not a wait, nothing to say why. Three clips end to end left two thirds of
    // the graph permanently blank.
    //
    // Deriving once over the whole range instead would fix that and cost far
    // too much: the trim would be the clip's whole span, so each input would
    // seek to the clip's beginning and decode forward to the window — an hour
    // of decoding for a preview an hour in, which is the exact trap
    // `ExportGraphInput::from` exists to avoid. So the window stays small and
    // there is one derivation per *distinct* window, built only when something
    // actually asks for one. A graph whose clips all overlap the chosen point
    // never builds a second, which is what it always did.
    const alts = new Map();
    const graphAt = (win) => {
        const k = `${win.from.toFixed(3)}-${win.to.toFixed(3)}`;
        if (!alts.has(k)) {
            const s = hooks.spec(win.from, win.to);
            const dd = derive(s, hooks.sources(), { overlay: hooks.overlay() });
            alts.set(k, dd.ok ? { graph: dd.graph, fps: s.fps } : null);
        }
        return alts.get(k);
    };

    const live = new Set();
    let fresh = false;
    const inputSig = JSON.stringify(specInputs());
    queue.length = 0;
    for (const { key, anchor, fit } of wanted) {
        let host = d.graph, fps = spec.fps;
        let win = { from: range.start, to: range.end };
        let node = host.node(key) || host.byAnchor(key);
        if (!node) {
            // Absent at the chosen instant. If it belongs to a clip, look at it
            // from that clip's own beginning instead.
            for (const alt of windowsFor(anchor || key, spans)) {
                const other = graphAt(alt);
                const found = other && (other.graph.node(key) || other.graph.byAnchor(key));
                if (!found) continue;
                node = found; host = other.graph; fps = other.fps; win = alt;
                break;
            }
            if (!node) {
                // Nowhere to look. A node can be in the graph on the screen —
                // which is derived over the whole range — and in no two seconds
                // of it: `amix` is there because three clips are mixed across
                // the render, and at any one instant fewer than two of them are
                // playing, so there is no mix to draw. Said on the card, because
                // the alternative is the blank that started all this.
                live.add(key);
                const before = shots.get(key);
                if (!before || before.state !== 'absent')
                    shots.set(key, { sig: `absent|${range.start}`, fit, state: 'absent',
                                     path: '', from: range.start, to: range.end,
                                     reason: 'not in the graph at the moment previewed',
                                     graph: null });
                continue;
            }
        }
        const g = previewGraph(host, node, { fit, fps });
        if (!g.ok) continue;
        live.add(key);

        // The signature is the render, spelled out. Two nodes that produce the
        // same picture from the same files share one, and a node whose
        // arguments were not touched keeps its picture through an edit that
        // rebuilt every node object in the graph.
        // The inputs are in it as well as the pads, because a pad says which
        // `-i` it reads and not how that `-i` is opened: forcing a demuxer or
        // setting a `-probesize` changes the picture without changing a
        // character of the graph.
        // The window is in the signature because it is part of the render: two
        // nodes with identical chains asked about different seconds are two
        // different pictures, and moving the preview point has to re-render
        // whatever it moved into or out of.
        const sig = `${g.filterGraph}|${JSON.stringify(g.filterInputs)}|${inputSig}` +
                    `|${win.from.toFixed(3)}-${win.to.toFixed(3)}`;
        const had = shots.get(key);
        if (had && had.sig === sig) {
            had.fit = fit;
            // Unchanged — but the queue was emptied above, and an entry still
            // waiting for its turn has to go back on it. Without this the first
            // preview to finish takes the rest of the queue down with it and
            // eight nodes stay blank forever.
            if (had.state === 'pending' && !(running && running.key === key)) queue.push(key);
            continue;
        }
        // Two nodes can be the same picture, and one pair always is: the pad the
        // muxer maps and the filter that produces it are one render described
        // twice. Rendering it twice would be the most conspicuous waste on the
        // screen, since those two cards sit side by side.
        const twin = ready(sig);
        if (twin) {
            shots.set(key, { sig, fit, state: 'ready', path: twin.path, from: win.from, to: win.to,
                             w: twin.w, h: twin.h, reason: '', graph: g });
            continue;
        }
        shots.set(key, { sig, fit, state: 'pending', path: '', from: win.from, to: win.to,
                         reason: '', graph: g });
        queue.push(key);
        fresh = true;
    }

    for (const key of Array.from(shots.keys())) if (!live.has(key)) shots.delete(key);
    // A node that is no longer in the graph cannot be playing. Nothing else
    // notices: the view holds its `<video>` by key and would go on showing the
    // last piece of a node that has been deleted.
    if (play.playingKey() && !live.has(play.playingKey())) play.stop();
    // Only something genuinely new restarts the wait. Otherwise each finished
    // preview would push the next one another quiet period into the future, and
    // a nine-node graph would fill in at one node every second for no reason.
    if (fresh) settleAt = Date.now() + QUIET_MS;
}

/// A picture already in hand for this exact render, whoever asked for it.
function ready(sig) {
    for (const shot of shots.values())
        if (shot.sig === sig && shot.state === 'ready' && shot.path) return shot;
    return null;
}

/// Called once a frame. Everything asynchronous about this is here.
export function tick() {
    if (running) {
        const p = bro.ffmpeg.render.poll();
        if (p.state === 'running') return;
        const was = running;
        running = null;
        if (was.seg) finishSegment(was, p);
        else finishShot(was, p);
        return;
    }

    if (!on) return;
    // The slot belongs to whatever else wants it. An export is the point of the
    // application and the A/B preview is a decision being taken; this is a
    // convenience and goes last.
    if (hooks.busy && hooks.busy()) return;
    if (bro.ffmpeg.render.poll().state === 'running') return;

    // A picture somebody is watching outranks a picture somebody might look at,
    // and it is the only work here with a deadline: fall behind and the playback
    // stalls, where a still that arrives a second late is a still that arrives.
    if (nextSegment()) return;
    if (!queue.length || Date.now() < settleAt) return;

    const key = queue.shift();
    const shot = shots.get(key);
    if (!shot || shot.state !== 'pending') return;
    const path = launch(shot.graph, shot.from, shot.to);
    if (path.error) {
        shot.state = 'failed';
        shot.reason = path.error;
        if (hooks.changed) hooks.changed();
        return;
    }
    running = { key, sig: shot.sig, path: path.path };
}

/// Start the next piece of a playback, if one is wanted. Returns whether the
/// slot was taken.
function nextSegment() {
    const key = play.playingKey();
    if (!key) return false;
    const seg = play.want();
    if (!seg) return false;
    const shot = shots.get(key);
    const g = graphFor(key, seg.from, seg.to, (shot && shot.fit) || 320);
    if (!g) { play.failed(seg, 'the graph no longer reaches this node'); return false; }
    const out = launch(g, seg.from, seg.to);
    if (out.error) { play.failed(seg, out.error); return false; }
    play.began(seg);
    running = { key, seg, path: out.path };
    return true;
}

/// The subgraph for one node over one window. Derived afresh rather than
/// re-timed, because a window is not a parameter of the graph: it is what the
/// `trim` on every clip is cut at and what each input seeks to, and the
/// derivation is the one place that knows how to work both out.
function graphFor(key, from, to, fit) {
    const spec = hooks.spec(from, to);
    const d = derive(spec, hooks.sources(), { overlay: hooks.overlay() });
    if (!d.ok) return null;
    const node = d.graph.node(key) || d.graph.byAnchor(key);
    if (!node) return null;
    const g = previewGraph(d.graph, node, { fit, fps: spec.fps });
    return g.ok ? g : null;
}

/// Hand a subgraph to the renderer. Returns `{ path }` or `{ error }`.
///
/// Fast and disposable, and deliberately not the settings being chosen on the
/// Encode stage — an x265 option on an x264 preview is an unknown key and an
/// unknown key is an error, which is right for a render and absurd for a
/// thumbnail.
function launch(g, from, to) {
    const spec = hooks.spec(from, to);
    spec.filterGraph = g.filterGraph;
    spec.filterInputs = g.filterInputs;
    // Re-derived, because the spec's was worked out from the *export's* graph
    // and the chains above are a subgraph of it. A preview of a node past an
    // `hwupload`, run without a device, refuses at the parse with libavfilter's
    // own wording and the card goes blank.
    spec.filterHwDevice = deviceForRender(g.filterGraph, spec.inputs);
    // The graph decides how big the picture is. Nothing out here could know:
    // half way down a graph the size is whatever libavfilter made it.
    spec.sizeFromGraph = true;
    spec.videoCodec = 'libx264';
    spec.crf = 30;
    spec.preset = 'ultrafast';
    spec.pixelFormat = 'yuv420p';
    spec.videoOptions = {};
    // And however many times the *export* is set to walk the range. A node
    // preview is a claim about what a filter does to a picture, and two passes
    // of it is the same picture rendered twice — nine cards paying twice over
    // for a bitrate decision none of them is about.
    spec.passes = [];
    // A picture preview is silent — nothing on that side of the graph has a
    // sound to carry, and an audio stream would be silence encoded nine times.
    // A waveform preview is not: the pad it draws is also the pad it plays, and
    // the whole point of pressing play on one is to hear it. Pinned to aac in
    // the temp mp4 rather than taken from the Encode stage for the same reason
    // the video codec is: a flac option on an aac preview is an unknown key,
    // and an unknown key is an error.
    spec.audio = !!g.audio;
    spec.audioCodec = 'aac';
    spec.audioBitrate = 128;
    spec.audioOptions = {};
    spec.faststart = false;
    spec.title = '';
    spec.path = bro.ffmpeg.tempPath(`node-${++seq}.mp4`);
    try {
        bro.ffmpeg.render.start(spec);
    } catch (e) {
        return { error: String(e.message || e) };
    }
    return { path: spec.path };
}

function finishShot(was, p) {
    const shot = shots.get(was.key);
    // Only if it is still the render that was asked for: a graph edit while
    // this was encoding has already replaced the entry, and writing an old
    // picture into a new one is the one way a preview can lie.
    if (shot && shot.sig === was.sig) {
        if (p.state === 'done') {
            shot.state = 'ready';
            shot.path = was.path;
            // How big the picture turned out. Asked of the file rather than of
            // the `<video>`, because the card has to be laid out at the right
            // height *before* the element is in the tree and has anything to
            // report — and this is the one moment the answer is both known and
            // cheap.
            try {
                const info = bro.ffmpeg.probe(was.path);
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
    if (hooks.changed) hooks.changed();
}

/// A piece of a playback landed. Deliberately does *not* redraw: a redraw
/// re-derives the graph, rebuilds nine cards and measures every one of them, and
/// during a playback that would happen every couple of seconds to change nothing
/// on screen. The frame loop picks the piece up.
function finishSegment(was, p) {
    if (!play.holds(was.seg)) return;
    if (p.state === 'done') play.finished(was.seg, was.path);
    else play.failed(was.seg, p.error || p.state);
}

// ── playing one node ──────────────────────────────────────────────────

/// Play `key` from where the previews are taken to the end of what would be
/// written. The still already on the card is handed over as the first piece
/// where it covers the same seconds, which it does unless the range has been set
/// to something other than the default — so pressing play normally starts on
/// that frame instead of after a render.
export function startPlay(key) {
    if (!on || !range || !key) return false;
    const shot = shots.get(key);
    // From where this node's own still was taken, not from where the previews
    // in general are: they are the same for most of the graph and are not for a
    // clip the preview point misses, and starting a playback somewhere its
    // first piece is guaranteed to be blank is the one place that would show.
    const from = shot && shot.from !== undefined ? shot.from : range.start;
    const to = shot && shot.to !== undefined ? shot.to : range.end;
    const until = hooks.until ? hooks.until() : to;
    const seed = shot && shot.state === 'ready' && shot.path
        ? { path: shot.path, seconds: to - from } : null;
    return play.start(key, from, Math.max(until, to), SECONDS, seed);
}

export function stopPlay() { play.stop(); }

export const playingKey = play.playingKey;
export const isPlaying = play.isPlaying;
export const playStats = play.stats;
export const currentPiece = play.current;
export const nextPiece = play.next;
export const reportPosition = play.report;
export const advancePlay = play.advance;

/// Whether anything is outstanding, for the status line — a graph that is
/// halfway through filling in should say so rather than looking half broken.
export function outstanding() {
    return queue.length + (running && !running.seg ? 1 : 0);
}
