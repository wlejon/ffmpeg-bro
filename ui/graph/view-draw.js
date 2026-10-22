// Selection, graph derivation/layout/rendering (`drawGraph`), frame loop
// (`tickGraph`/`playFrame`), view fit/paint, and node measurement for
// `ui/graph/view.js`.

import { el, span, put } from '../dom.js';
import { clock } from '../format.js';
import { buildSpec, specSources, range as exportRange } from '../export/spec.js';
import { parseEnable, isOnAt } from './enable.js';
import { derive } from './derive.js';
import { print } from './print.js';
import { layout, NODE_W } from './layout.js';
import * as canvas from './canvas.js';
import * as cards from './card.js';
import * as overlay from './overlay.js';
import * as panel from './panel.js';
import * as preview from './preview.js';
import { measureGraph } from './subgraph.js';
import { fold } from './fold.js';
import { chaseWhen } from './when.js';
import { chaseCurves } from './curve.js';

/// **`Fit` never crosses the level-of-detail threshold**, and that is what stops
/// the one loop this design can have: the cards are measured at one detail, the
/// fit is computed from those measurements, and if the fit then changed the detail
/// the measurements would be of cards that are no longer on screen — and the
/// rebuild would produce a different fit, which could change the detail back.
///
/// Clamping the fit at the threshold removes the possibility rather than
/// detecting it, and it is also the better behaviour: a graph too big to frame
/// legibly should be navigated with the minimap, not framed illegibly. Only you
/// can go below it, with the wheel, where no fit is running to argue with.
const FIT_FLOOR = 0.6;

/// A measurement waiting for the one job slot — `{ cut, until }`. See
/// `runPending`.
let pending = null;
/// How long it waits. A node preview is a second at most and there are seldom
/// more than a couple left when somebody presses the button; past this the
/// honest thing is to say the slot is busy rather than to keep a promise
/// nothing is watching.
const WAIT_MS = 5000;

let placed = null;      // the last layout(), for repainting on a pan
let lastGraph = null;   // ...and the graph it was of, for the keyboard
/// The cards this redraw built, by key — see the loop in `drawGraph` that fills
/// it. A list per key because several nodes can share an anchor. Rebuilt with
/// them, so it cannot outlive the elements it names.
const byKey = new Map();
export const cardsFor = (key) => byKey.get(key) || [];
/// A redraw owed to something that was not an edit, drawn by `tickGraph`.
let wantDraw = false;
let shape = '';         // what the graph looked like, so a fit happens once per shape
let bounds = '';        // and how big it came out, so a card that grew is framed
let canvasSize = '';
let lod = 'full';
let lastPoints = null;

/// Keys, not nodes: a redraw remakes every node object. The first inserted is the
/// primary — what the panel is about — because that is the one you clicked.
const selection = new Set();
let primary = null;

/// The insert point under the pointer, by id — not the wire object it is on.
///
/// A redraw makes every wire object again, and a preview landing on any card
/// redraws: holding the object meant that the moment one did, the `+` you were
/// reaching for vanished and could not be brought back without moving to another
/// wire and back. An id is what survives a derivation; nothing else here does.
let hoverPoint = null;
/// The wire that is selected, by the pad it *arrives* at — `key#port`.
///
/// By its arriving end because that is the only end that identifies it: an input
/// pad holds exactly one wire, so "the wire at `composite/overlay:7` input 1" is
/// a name that survives a rebuild, and the wire object it currently refers to
/// does not survive anything.
let selectedWire = null;

let ctx = null;
export function bindViewDrawContext(c) { ctx = c; }
export function placedOf() { return placed; }
export function lodOf() { return lod; }
export function selectionOf() { return selection; }
export function selectedWireOf() { return selectedWire; }
export function setSelectedWire(v) { selectedWire = v; }
export function setWantDraw(v) { wantDraw = v; }
export function isPending() { return !!pending; }

// ── selection ──────────────────────────────────────────────────────────────

/// A wire, held by the pad it arrives at. See `selectedWire`.
export function selectWire(w) {
    const to = lastGraph && lastGraph.node(w.edge.to);
    selection.clear();
    primary = null;
    // The key and the pad, and deliberately not the node: the panel keeps this
    // across redraws, and every node object in it belongs to a graph that the
    // next derivation throws away. `wirePanel` re-resolves from the key, which
    // is what makes the wire survive the rebuild at all.
    panel.selectWire(to ? { key: panel.keyOf(to), port: w.edge.port || 0,
                            stream: w.stream } : null);
    selectedWire = to ? `${panel.keyOf(to)}#${w.edge.port || 0}` : null;
    markSelection();
    paint();
}

export function select(key, add) {
    if (!key) return clearSelection();
    if (!add) selection.clear();
    selection.add(key);
    primary = key;
    selectedWire = null;
    panel.selectNode(key, selection.size);
    markSelection();
    paint();
}

export function clearSelection() {
    selection.clear();
    primary = null;
    selectedWire = null;
    panel.selectNode(null, 0);
    markSelection();
    paint();
    if (window.getSelection) {
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
    }
}

/// Everything the rubber band touched.
export function pickInside(m) {
    if (!placed) return;
    const refs = ctx.refs();
    const { zoom, panX, panY } = ctx.view();
    const rect = refs.viewport.getBoundingClientRect();
    const x0 = Math.min(m.x0, m.x1) - rect.left, x1 = Math.max(m.x0, m.x1) - rect.left;
    const y0 = Math.min(m.y0, m.y1) - rect.top, y1 = Math.max(m.y0, m.y1) - rect.top;
    if (x1 - x0 < 4 && y1 - y0 < 4) return paint();
    if (!m.add) selection.clear();
    for (const b of placed.nodes) {
        const bx = b.x * zoom + panX, by = b.y * zoom + panY;
        if (bx + b.w * zoom < x0 || bx > x1 || by + b.h * zoom < y0 || by > y1) continue;
        const key = panel.keyOf(b.node);
        if (key) selection.add(key);
    }
    primary = selection.size ? Array.from(selection)[0] : null;
    panel.selectNode(primary, selection.size);
    markSelection();
    paint();
}

/// Which cards the selection is about. A class rather than a rebuild: the
/// selection changes on every click and the cards are expensive enough to measure
/// that making them again to draw a border would be visible.
export function markSelection() {
    const refs = ctx.refs();
    if (!refs.nodes) return;
    for (const node of refs.nodes.querySelectorAll('.gn')) {
        const key = node.getAttribute('data-key');
        node.classList.toggle('on', !!key && selection.has(key));
        node.classList.toggle('primary', !!key && key === primary);
    }
    const point = panel.selectedPoint();
    for (const b of refs.nodes.querySelectorAll('.gp-plus'))
        b.classList.toggle('on', !!point && b.getAttribute('data-point') === point);
}

// ── the draw ───────────────────────────────────────────────────────────────

const cardWidth = (key) => Math.max(120, Math.min(720, overlay.sizeOf(key) || NODE_W));

/// Rebuild from the edit. Refused while the stage is not on screen, because every
/// height it needs would measure zero and the layout would be a stack of nodes in
/// the top-left corner that nobody ever sees be wrong.
export function drawGraph() {
    const refs = ctx.refs();
    if (!refs.viewport) return;
    if (!refs.viewport.clientWidth) return;

    const d = derive(buildSpec(), specSources(), { overlay: overlay.current() });
    if (!d.ok) {
        placed = null;
        lastGraph = null;
        // With the cards, for the reason the index exists: it names elements, and
        // an element that has been taken out of the tree is not one to move.
        byKey.clear();
        put(refs.nodes, () => []);
        paint();
        note(d.reason ? `No graph: ${d.reason}.` : 'No graph.');
        status(null);
        panel.draw(null, [], []);
        return;
    }
    note('');
    lastGraph = d.graph;
    // Kept because the hover rebuild needs them, and re-deriving on a mouse move
    // to find out where five wires are would derive the whole graph sixty times a
    // second.
    lastPoints = d.points;
    lod = ctx.detail();

    // Build, then measure, then place. The transform is cleared for the
    // measurement so heights come back in graph coordinates whatever the zoom is —
    // a card read at 1.4× and then positioned at 1.4× would compound.
    const built = new Map();
    // Whoever caused this redraw, the field somebody is typing into survives
    // it. See cards.noteFocus: a preview arriving is a redraw too.
    cards.noteFocus(refs.nodes);
    refs.nodes.style.transform = 'none';
    refs.nodes.classList.toggle('lod-min', lod === 'min');
    // The first problem about each node, by id rather than by key: two nodes can
    // share an anchor — several inserts at one point do — and the complaint
    // belongs to the one it is about.
    const trouble = new Map();
    for (const p of d.problems) if (p.id && !trouble.has(p.id)) trouble.set(p.id, p);

    // A clip's derived run as one card, folded by default per clip into one card
    // unless explicitly opened/expanded by the user. User nodes (derived: false) never fold.
    const foldChoice = ctx.foldChoice();
    const folding = foldChoice === null ? true : foldChoice;
    const lastFold = fold(d.graph, { open: ctx.openFolds(), trouble, points: d.points,
                                     enabled: folding });
    lastFold.folding = folding;
    ctx.setLastFold(lastFold);
    const shown = lastFold.graph;

    put(refs.nodes, () => shown.nodes.map((n) => {
        const key = panel.keyOf(n);
        const node = cards.buildCard(n, { graph: shown, key, width: cardWidth(key), lod,
                                          problem: trouble.get(n.id),
                                          fold: lastFold.folds.get(n.id) });
        built.set(n.id, node);
        return node;
    }));

    const measured = new Map();
    for (const n of shown.nodes)
        measured.set(n.id, { w: cardWidth(panel.keyOf(n)),
                             h: built.get(n.id).getBoundingClientRect().height });

    placed = layout(shown, (n) => measured.get(n.id),
                    (n) => overlay.pinOf(panel.keyOf(n)));
    const boxes = new Map();
    byKey.clear();
    for (const box of placed.nodes) {
        const node = built.get(box.node.id);
        node.classList.add(`gn-${box.stream}`);
        if (box.pinned) node.classList.add('gn-pinned');
        ctx.place(node, box.x, box.y);
        cards.placeSockets(node, box.h);
        boxes.set(box.node.id, box);
        // The card for a key, kept from the build. A drag used to ask the
        // container for it with `querySelector` on every mouse move, which is a
        // walk of two thousand elements to find something this loop is holding.
        const key = panel.keyOf(box.node);
        if (key) {
            const at = byKey.get(key);
            if (at) at.push(node); else byKey.set(key, [node]);
        }
    }

    drawInsertPoints(d, boxes);
    if (refs.previews) refs.previews.classList.toggle('on', preview.isEnabled());

    // Frame it when the graph is a different graph, and also when it is the same
    // graph at a different size — a card is as tall as what is in it, and eight
    // pictures arriving one at a time grow the layout out from under a frame
    // computed before any of them existed. Not once you have panned or zoomed
    // yourself: at that point where you are looking is a decision, and nothing
    // here gets to overrule it.
    const nowShape = shapeOf(shown);
    const nowBounds = `${Math.round(placed.width)}x${Math.round(placed.height)}`;
    if (shape !== nowShape || (!ctx.userMoved() && bounds !== nowBounds)) {
        shape = nowShape;
        bounds = nowBounds;
        fit();
        // A fit can only ever move the zoom *up* across the detail threshold —
        // `FIT_FLOOR` is that threshold — so this is at most one more pass and
        // never a pair of them arguing. Without it a graph framed after being
        // zoomed out keeps the bodies it was built without.
        if (ctx.detail() !== lod) return drawGraph();
    }
    apply();
    status(print(d.graph), d);
    // The points as well as the graph: an insert point somebody has open is
    // re-resolved against the derivation that has just run, rather than being
    // held from the one that declared it.
    panel.draw(d.graph, d.problems, d.points);
    markSelection();
    cards.restoreFocus(refs.nodes);
    syncPreviews();
    if (refs.search && refs.search.value) ctx.applySearch();
}

/// The insert points, on the wire each one names.
///
/// Only the wire under the pointer, and the one whose point is open, get a `+`.
/// One on every wire all the time was five orange dots reading as part of the
/// graph — and n8n, which is where this gesture is from, shows it on hover for
/// exactly that reason.
function drawInsertPoints(d, boxes) {
    const refs = ctx.refs();
    for (const p of d.points) {
        // The pad as well as the node: a file's picture and its sound leave one
        // input node, and a point matched on the node alone would put the `+`
        // for "after decode" on whichever of the two wires came first.
        const wire = placed.wires.find(
            (w) => w.edge.from === p.at && (w.edge.fromPort || 0) === (p.atPort || 0));
        const from = boxes.get(p.at);
        if (!from) continue;
        if (panel.selectedPoint() !== p.id && hoverPoint !== p.id) continue;
        const x = wire ? (wire.x1 + wire.x2) / 2 : from.x + from.w + 20;
        const y = wire ? (wire.y1 + wire.y2) / 2 : from.y + from.h / 2;
        refs.nodes.append(insertButton(p, x - 9, y - 9));
    }
}

/// The `+` that sits on a wire. In the transformed container with the cards
/// rather than on the canvas with the wires, because it is a thing to be clicked
/// and the canvas is one element — hit-testing a bezier by hand to find out which
/// wire was meant is work with a DOM node's name on it.
function insertButton(point, x, y) {
    return el('button', {
        cls: 'gp-plus' + (panel.selectedPoint() === point.id ? ' on' : ''),
        'data-point': point.id,
        title: `Insert a filter ${point.title}`,
        text: '+',
        style: { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` },
        on: { mousedown: (e) => e.stopPropagation(),
              click: (e) => { e.stopPropagation(); panel.openPoint(point); markSelection(); } },
    });
}

/// What is worth a picture: every node, both sinks included — those two are the
/// render, and they are the first things anybody clicks. The sound side gets a
/// waveform rather than a frame, which `subgraph.js` decides and this does not
/// need to know: a preview is a file with a picture in it either way.
///
/// Asked for after the layout at the width each card actually is, so a card
/// dragged bigger gets a sharper render rather than a stretched one.
///
/// **And only for the cards on the screen.** A preview is an ffmpeg render — the
/// most expensive thing this stage can ask for — and asking for one per node made
/// the cost of arriving here a property of the size of the edit: seventy clips
/// derive 634 nodes, so the stage queued 634 renders, and each one that landed
/// redrew the whole graph. Measured, that was a *second* of redraw per picture
/// for as long as the queue lasted. A picture nobody can see answers no question,
/// and panning brings the rest in.
function syncPreviews() {
    if (preview.isEnabled())
        preview.sync(placed.nodes
            .filter(inView)
            .map((b) => ({ key: panel.keyOf(b.node),
                           // Which clip this node belongs to, for deciding *when*
                           // to look at it. A node's key is its anchor only when
                           // the derivation made it; one somebody inserted is
                           // held by id and carries the clip in its anchor
                           // instead, and both have to answer.
                           anchor: b.node.anchor || '',
                           fit: previewFit(cardWidth(panel.keyOf(b.node))) }))
            .filter((w) => w.key));
    cards.dropUnless((key) => !!preview.shotFor(key));
}

/// Whether a box is where somebody can see it, in graph coordinates.
///
/// The margin is a card and a half, so that a preview is already there when a
/// small pan brings the card in rather than arriving after it. Everything this
/// gates is priced per node — a render, a `<video>` — which is why the test is
/// against the *view* and not against the graph: the one number that does not
/// grow with the edit is how much of it fits on a screen.
function inView(b, margin = 260) {
    const { w, h } = ctx.port();
    if (w <= 0 || h <= 0) return false;
    const { zoom, panX, panY } = ctx.view();
    const x0 = -panX / zoom - margin, x1 = (w - panX) / zoom + margin;
    const y0 = -panY / zoom - margin, y1 = (h - panY) / zoom + margin;
    return b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= y0 && b.y <= y1;
}

/// The width a preview is rendered at, rounded so that nudging a card by three
/// pixels does not re-render it.
function previewFit(width) {
    return Math.max(128, Math.min(640, Math.round(width / 32) * 32));
}

function shapeOf(g) {
    // Wires by the *position* of the nodes they join, not by their ids: ids come
    // from a counter that never restarts, so two derivations of the same unchanged
    // edit produce the same graph with entirely different ids and an id-keyed
    // comparison says "different" every single time. Which it did, and the view
    // refit on every redraw.
    const at = new Map(g.nodes.map((n, i) => [n.id, i]));
    return g.nodes.map((n) => `${n.kind}:${n.filter}`).join(',') + '|' +
           g.edges.map((e) => `${at.get(e.from)}:${e.fromPort || 0}>${at.get(e.to)}:${e.port}`)
                  .join(',');
}

// ── the frame loop ─────────────────────────────────────────────────────────

export function tickGraph() {
    runPending();
    preview.tick();
    // Whatever asked for a redraw without being an edit — see the `changed` hook
    // `initPreview` is given. Before the rest of this, so a picture that has just
    // landed is on the card the clock below is about to be written into.
    if (wantDraw) { wantDraw = false; drawGraph(); }
    playFrame();
    // One style write per strip, for the reason `playFrame` writes the clock
    // readout in place: redrawing the properties column would rebuild every
    // control in it, sixty times a second, under whatever hand was on one.
    chaseWhen();
    // The same rule for the value curves, plus the one thing they need that a
    // When strip does not: a `<canvas>` measured while this stage is
    // `display:none` measures zero, so the curve is drawn when it first has a
    // width to be drawn at. See `chaseCurves`.
    chaseCurves();
}

/// Drive the node that is playing.
///
/// Polled rather than driven by events, for the reason the rest of this
/// application polls: what has to be noticed is a `<video>` arriving at the end of
/// its file, and an `ended` that this engine may or may not raise is a playback
/// that may or may not continue. `currentTime` against `duration` is two
/// properties that certainly exist.
///
/// No redraw happens here. A redraw re-derives the graph, rebuilds every card and
/// measures all of them, and doing that sixty times a second to move a clock would
/// make the stage unusable — so the readout is written into the element in place,
/// and the structure of a card only changes when playback starts or stops.
function playFrame() {
    const key = preview.playingKey();
    if (!key) return;
    const pair = cards.pairOf(key);
    const st = preview.playStats();
    if (!pair || !pair.b || !st) return;
    if (st.failed) { preview.stopPlay(); drawGraph(); note(`Playback stopped: ${st.failed}.`); return; }

    let front = pair.front === 'b' ? pair.b : pair.a;
    let back = pair.front === 'b' ? pair.a : pair.b;
    const piece = preview.currentPiece();

    // Put the piece that is due on screen. Where the other element is already
    // holding it — which is the point of there being two — this is a swap and not
    // a load.
    if (piece && piece.state === 'ready' && front.__path !== piece.path) {
        if (back.__path === piece.path) {
            pair.front = pair.front === 'b' ? 'a' : 'b';
            const t = front; front = back; back = t;
        } else {
            front.__path = piece.path;
            front.src = piece.path;
        }
        front.classList.remove('gn-off');
        back.classList.add('gn-off');
    }

    // And run it. Separate from putting it there because the first piece is
    // usually the still that was already on the card — nothing to load and nothing
    // to swap, but it is looping two seconds and a playback is not, so the one
    // thing it does need is to be told to stop doing that.
    if (piece && piece.state === 'ready' && pair.playing !== piece.path) {
        pair.playing = piece.path;
        front.loop = false;
        // From the top, which matters for exactly one piece: the first. It is the
        // still that was already on the card, and the still has been going round
        // for however long the stage has been open — adopting it where it happened
        // to be would start the playback part way through its own first two
        // seconds and then credit the whole of them to the rate.
        try { front.currentTime = 0; } catch (e) { /* it starts where it starts */ }
        try { front.play(); } catch (e) { /* it will play when it can */ }
    }

    // And get the one after it decoding while this one runs.
    const after = preview.nextPiece();
    if (after && after.state === 'ready' && back.__path !== after.path) {
        back.__path = after.path;
        back.loop = false;
        back.src = after.path;
    }

    // **A seek is applied here and nowhere else**, because the element is the
    // only thing that can be told where to be and this is the only thing holding
    // one. After the block above, so that a seek into a piece that has only just
    // arrived wins over the `currentTime = 0` that starting it writes; and only
    // once the front element actually holds that piece, since an element cannot
    // be told to be somewhere in a file it has not got.
    const into = preview.requestedPosition();
    if (into !== null && piece && piece.state === 'ready' && front.__path === piece.path) {
        try { front.currentTime = into; } catch (e) { /* it plays from where it is */ }
        try { front.play(); } catch (e) { /* it will play when it can */ }
        preview.positionGranted();
    }

    if (piece && front.__path === piece.path) {
        const at = Number(front.currentTime) || 0;
        const dur = Number(front.duration) || 0;
        preview.reportPosition(at);
        // A hair short of the end: the last frame's timestamp is one frame before
        // the duration, so waiting for equality waits forever.
        if (dur > 0 && at >= dur - 0.05 && preview.advancePlay() === 'ended') {
            preview.stopPlay();
            drawGraph();
            return;
        }
    }

    readout(st);
}

/// The clock and the rate, written straight into the strip over the picture.
function readout(st) {
    const refs = ctx.refs();
    const strip = refs.nodes && refs.nodes.querySelector('.gn-playbar .gn-clock');
    if (!strip) return;
    const slow = st.settled && st.rate < 0.95;
    // The rate is what is actually being sustained, waits included, because that
    // is the number somebody deciding whether a filter is affordable wants —
    // rather than the renderer's throughput with the stalls taken out, which would
    // say a graph was fast while you watched it not be. Withheld for the first
    // second and a half: there is nothing to average over yet, and the first piece
    // is a render nobody has waited for.
    strip.textContent = clock(st.at) + whenNow(strip, st) +
        (st.settled ? ` · ${st.rate.toFixed(2)}×` : '') +
        (st.waiting ? ' · rendering' : slow ? ' · slower than real time' : '');
    strip.className = 'gn-clock' + (slow || st.waiting ? ' gn-slow' : '');

    // The marker is left alone while a hand is on it: the bar follows the
    // pointer during a drag, and writing the picture's position into it would
    // pull it back to where the picture still is.
    if (!ctx.scrubbing()) {
        const span = Math.max(1e-6, st.until - st.from);
        paintScrub((st.at - st.from) / span, (st.ready - st.from) / span);
    }
}

/// Both marks on the scrub bar, as fractions of the range.
///
/// `ahead` is left as it was when it is not given, which is what a drag wants:
/// how far the pieces reach has not changed because a pointer moved.
export function paintScrub(at, ahead) {
    const refs = ctx.refs();
    const bar = refs.nodes && refs.nodes.querySelector('.gn-scrub');
    if (!bar) return;
    const head = bar.querySelector('.gn-scrub-head');
    const run = bar.querySelector('.gn-scrub-ahead');
    const pct = (f) => `${Math.max(0, Math.min(1, f)) * 100}%`;
    if (head) head.style.left = pct(at);
    if (run && ahead !== undefined) {
        run.style.left = pct(at);
        run.style.width = pct(Math.max(0, ahead - at));
    }
}

/// The bar under the pointer, while it is held. No seek: see `scrubbing`.
export function dragScrub(e) {
    const refs = ctx.refs();
    const scrubbing = ctx.scrubbing();
    const bar = refs.nodes && refs.nodes.querySelector('.gn-scrub');
    if (!bar || !scrubbing) return;
    scrubbing.at = cards.scrubFraction(bar, e.clientX);
    paintScrub(scrubbing.at);
}

/// Whether the filter being watched is on right now.
///
/// **The one thing a playback answers that a still cannot.** A time-varying
/// filter is judged by watching it come on, and a picture that changes with no
/// word for what changed leaves you counting seconds against a field in another
/// column. The clock is the render's own — `enable`'s `t` is measured from the
/// start of the range, and `st.at` is a timeline second — so the two are put on
/// the same footing here rather than anywhere the difference could be forgotten.
///
/// Read off the card's `data-enable` rather than out of a graph: this runs on
/// the frame loop, and re-deriving to answer it would derive sixty times a
/// second. Silent for a filter with no `enable` and for an expression the
/// parser will not read, because a readout that guessed at `mod(t,4)` would be
/// worse than one that said nothing.
function whenNow(strip, st) {
    let card = strip.parentNode;
    while (card && card.getAttribute && !card.getAttribute('data-key')) card = card.parentNode;
    const value = card && card.getAttribute ? card.getAttribute('data-enable') : '';
    if (!value) return '';
    const parsed = parseEnable(value);
    if (!parsed.ok || !parsed.spans.length) return '';
    return isOnAt(parsed.spans, st.at - exportRange().start) ? ' · on' : ' · off';
}

// ── view transform ─────────────────────────────────────────────────────────

/// Frame the whole graph and repaint. The two halves are separate because
/// `drawGraph()` fits before it has anything to apply to.
export function fitView() {
    ctx.setUserMoved(false);
    fit();
    // Framing a graph you had zoomed out of brings the detail back with it. Same
    // one-pass argument as in `drawGraph`.
    if (ctx.detail() !== lod) drawGraph();
    else apply();
}

/// Zoom and centre so the whole graph is on screen — never magnified past
/// life-size, because a four-node graph blown up to fill the window reads as an
/// error, and never shrunk past `FIT_FLOOR`, for the reason written there.
function fit() {
    const refs = ctx.refs();
    if (!placed || !refs.viewport) return;
    const { w, h } = ctx.port();
    if (!w || !h || !placed.width) return;
    const pad = 28;
    const want = Math.min((w - pad * 2) / placed.width,
                          (h - pad * 2) / Math.max(1, placed.height));
    const zoom = Math.max(FIT_FLOOR, Math.min(1, want));
    const panX = (w - placed.width * zoom) / 2 - placed.left * zoom;
    const panY = (h - placed.height * zoom) / 2 - placed.top * zoom;
    ctx.setView(zoom, panX, panY);
}

export function apply() {
    const refs = ctx.refs();
    if (!refs.nodes) return;
    const { zoom, panX, panY } = ctx.view();
    refs.nodes.style.transform =
        `translate(${Math.round(panX)}px, ${Math.round(panY)}px) scale(${zoom})`;
    if (refs.zoomLabel) refs.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    paint();
}

/// What the pointer is over, which decides which wire is lit and where the `+`
/// goes. Only acted on when it changes: this runs on every mouse move.
export function hover(e) {
    // This is on the document, so it runs while some other stage is up and the
    // viewport is `display:none` — where every coordinate is zero and every wire
    // would look like a hit.
    const refs = ctx.refs();
    if (!placed || !refs.viewport || !refs.viewport.clientWidth) return;
    const rect = refs.viewport.getBoundingClientRect();
    const was = hoverPoint;
    const wire = ctx.inNode(e.target)
        ? null
        : canvas.wireAt(placed, e.clientX - rect.left, e.clientY - rect.top, ctx.view());
    // A wire with no insert point on it is not a wire anything can be put on, so
    // hovering it offers nothing — which is itself the answer to "why is there no
    // + here", and better than a `+` that turns out to be unclickable.
    const point = wire && lastPoints
        ? lastPoints.find((p) => p.at === wire.edge.from &&
                                 (p.atPort || 0) === (wire.edge.fromPort || 0)) : null;
    hoverPoint = point ? point.id : null;
    if (was === hoverPoint) return;
    refreshInsertPoints();
    paint();
}

/// The `+` again, against the boxes as they now are.
///
/// It is a DOM element in the card container, so this is a small rebuild of just
/// those. Cheaper than it sounds: there are five. Two callers — the hovered wire
/// changing, and a node being let go of somewhere else, which moves the wire the
/// `+` was sitting on.
export function refreshInsertPoints() {
    const refs = ctx.refs();
    if (!refs.nodes || !placed) return;
    for (const b of Array.from(refs.nodes.querySelectorAll('.gp-plus')))
        refs.nodes.removeChild(b);
    if (!lastPoints) return;
    drawInsertPoints({ points: lastPoints },
                     new Map(placed.nodes.map((b) => [b.node.id, b])));
}

export function paint() {
    const refs = ctx.refs();
    const c = refs.canvas;
    if (!c || !refs.viewport) return;
    const { w, h } = ctx.port();
    if (w <= 0 || h <= 0) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const c2d = c.getContext('2d');
    c2d.clearRect(0, 0, w, h);
    const v = ctx.view();
    canvas.paintGrid(c2d, w, h, v);
    canvas.paintWires(c2d, placed, v, litWire(), hoveredWire(), chosenWire());
    if (ctx.wiring()) paintWiring(c2d);
    if (ctx.marquee()) paintMarquee(c2d);
    if (refs.mini) canvas.paintMini(refs.mini, placed, v, ctx.port());
}

/// The wire the hovered point sits on, resolved out of the current layout rather
/// than remembered — see `hoverPoint`.
function hoveredWire() {
    if (!hoverPoint || !placed || !lastPoints) return null;
    const point = lastPoints.find((p) => p.id === hoverPoint);
    if (!point) return null;
    return placed.wires.find((w) => w.edge.from === point.at &&
                                    (w.edge.fromPort || 0) === (point.atPort || 0)) || null;
}

/// A wire belongs to the selection when either end of it does. With nothing
/// selected they are all lit — a graph that dims itself until you click something
/// looks broken rather than focused.
///
/// The set is built once per paint and closed over, not looked up per wire: this
/// runs on every mouse move of a pan.
function litWire() {
    if (!selection.size || !placed) return () => true;
    const ids = new Set();
    for (const b of placed.nodes) {
        const key = panel.keyOf(b.node);
        if (key && selection.has(key)) ids.add(b.node.id);
    }
    return (w) => ids.has(w.edge.from) || ids.has(w.edge.to);
}

/// The wire in the air, from the socket it left to wherever the pointer is —
/// snapped to the socket it would land on, so the drop is confirmed before it
/// happens rather than discovered afterwards.
function paintWiring(c2d) {
    const refs = ctx.refs();
    const wiring = ctx.wiring();
    const { zoom, panX, panY } = ctx.view();
    const rect = refs.viewport.getBoundingClientRect();
    const from = { x: wiring.from.x * zoom + panX, y: wiring.from.y * zoom + panY };
    const to = wiring.over
        ? { x: wiring.over.at.x * zoom + panX, y: wiring.over.at.y * zoom + panY }
        : { x: wiring.x - rect.left, y: wiring.y - rect.top };
    canvas.paintPending(c2d, from, to, wiring.stream || 'v', !!wiring.over);
}

/// The selected wire, found again in the layout rather than remembered — see
/// `selectedWire`, and `hoverPoint` for the same argument at length.
function chosenWire() {
    if (!selectedWire || !placed || !lastGraph) return null;
    const at = selectedWire.split('#');
    const port = Number(at[1]) || 0;
    return placed.wires.find((w) => {
        const to = lastGraph.node(w.edge.to);
        return to && panel.keyOf(to) === at[0] && (w.edge.port || 0) === port;
    }) || null;
}

function paintMarquee(c2d) {
    const refs = ctx.refs();
    const marquee = ctx.marquee();
    const rect = refs.viewport.getBoundingClientRect();
    const x = Math.min(marquee.x0, marquee.x1) - rect.left;
    const y = Math.min(marquee.y0, marquee.y1) - rect.top;
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    c2d.fillStyle = 'rgba(74, 158, 255, 0.10)';
    c2d.fillRect(x, y, w, h);
    c2d.strokeStyle = '#4a9eff';
    c2d.lineWidth = 1;
    c2d.strokeRect(x + 0.5, y + 0.5, w, h);
}

/// The stage resizes when the window does, and the wires are drawn in screen
/// coordinates, so they have to be told. Called from the frame loop; a measurement
/// of zero means the stage is not up and is ignored rather than acted on.
export function chaseGraph() {
    const refs = ctx.refs();
    if (!refs.viewport) return;
    const { w, h } = ctx.port();
    if (w <= 0 || h <= 0) return;
    const key = `${w}x${h}`;
    if (key === canvasSize) return;
    canvasSize = key;
    if (!placed) drawGraph();
    else paint();
}

/// The graph this stage last drew. Exposed so that a test can name the node it
/// means the way the panel does — by picking it out of the graph on the screen
/// — rather than deriving a second one that might not be the same.
export function currentGraph() { return lastGraph; }

/// Start a measurement that stops at one node, and say what it is of.
///
/// Cut from `lastGraph` — the graph this stage last drew, which is the export's
/// own, derived from `buildSpec()`. Deriving a second one here to cut would be
/// a second graph that could differ from the one somebody is looking at, and
/// the whole claim being made is that the node on the screen is the node the
/// numbers are about.
///
/// **The note states how much was left out.** A measurement over part of a
/// graph is a claim about part of a graph; nothing else on the screen says
/// which part, and a report that looked exactly like a whole-graph one would be
/// the stale-measurement failure wearing a different hat.
///
/// Returns the reason it could not be started at all, or `''` — which includes
/// "waiting for the slot", since that is not a refusal.
export function measureTo(node) {
    if (!lastGraph || !node) { note('No graph to measure.'); return 'no graph'; }
    // **Found again by key, not used as handed over.** A node object does not
    // survive a rebuild and a rebuild is caused by almost anything — a node
    // preview landing, a timeline edit, a value typed — so a node held across
    // one belongs to a graph that is no longer on the screen. Cutting with it
    // would walk `producers()` on a graph that has never seen it, find none, and
    // refuse with "nothing feeds this node" about a node that plainly has
    // something feeding it.
    const key = panel.keyOf(node);
    const now = lastGraph.node(key) || lastGraph.byAnchor(key);
    if (!now) { note('That node is not in the graph any more.'); return 'no such node'; }
    const cut = measureGraph(lastGraph, now);
    if (!cut.ok) { note(`Nothing to measure: ${cut.reason}.`); return cut.reason; }
    pending = { cut, until: Date.now() + WAIT_MS };
    runPending();
    return '';
}

/// Start the waiting measurement if the one job slot has come free.
///
/// **It waits rather than failing, and it waits for a few seconds rather than
/// for ever.** This stage is the one place in the application where something
/// is nearly always rendering: the node previews fill in as the graph settles,
/// and a `Measure to here` pressed during that would otherwise come back with
/// "a job is already running" for a reason that has nothing to do with the
/// measurement and resolves itself in a moment. So it queues — and the previews
/// stop starting new work while it does, because a measurement is a question
/// somebody asked and a preview is one they might look at.
///
/// The bound is what stops it being a promise this cannot keep. Nothing outside
/// this stage ticks it, so a queue with no deadline would be a measurement that
/// fires when you come back to the Graph stage half an hour later, about an
/// edit that has since changed — which is exactly the stale measurement
/// `ui/measure.js` refuses to hand anybody.
function runPending() {
    if (!pending) return;
    const outer = ctx.outer();
    const { cut } = pending;
    // **Both halves of "busy", because they stop being true a frame apart.** The
    // host's slot is free the moment its render ends; the workspace still holds
    // its own job until the next poll tells it otherwise, and starting inside
    // that gap is refused by the workspace for a render that has already
    // finished. Asking one question with both answers in it is the only way the
    // wait ends where the wait was for.
    if (outer.slotBusy ? outer.slotBusy() : bro.ffmpeg.render.poll().state === 'running') {
        if (Date.now() < pending.until) return;
        pending = null;
        note('The render slot is still busy — try again in a moment.');
        return;
    }
    pending = null;
    const no = outer.measure ? outer.measure(cut) : 'nothing here runs a measurement';
    if (no) { note(`Not measuring: ${no}.`); return; }
    note(`Measuring ${cut.nodes} of ${cut.of} nodes, ` +
         `${cut.inputs} input${cut.inputs === 1 ? '' : 's'} — the report says what was found.`);
}

export function note(text) {
    const refs = ctx.refs();
    if (!refs.note) return;
    refs.note.textContent = text;
    refs.note.classList.toggle('hidden', !text);
}

/// What the fold did, as spans for the line above — and the button's own state,
/// set from here because the two say the same thing and a button that disagreed
/// with the sentence beside it would be worse than no button.
///
/// Empty when there is nothing to fold at all, which is a graph with no clips in
/// it: an offer to collapse nothing is a control that does nothing.
function foldStatus() {
    const refs = ctx.refs();
    const f = ctx.lastFold();
    if (refs.fold) {
        const useful = !!f && f.foldable > 0;
        refs.fold.classList.toggle('hidden', !useful);
        refs.fold.classList.toggle('on', !!f && f.folding);
        refs.fold.textContent = f && f.folding ? 'Expand' : 'Collapse';
    }
    if (!f || !f.foldable) return [];
    const held = f.held.length;
    const out = [];
    if (f.folds.size) {
        out.push(span(`${f.folds.size} clip${f.folds.size === 1 ? '' : 's'} collapsed`,
                      'gr-fold'));
        out.push(span('·', 'dim'));
    }
    // Named by the reason rather than counted, because the reason is the point:
    // a run stays open because it holds something the timeline cannot make
    // again, and that is exactly what somebody came to this stage to see.
    if (held) {
        const why = f.held[0].why;
        out.push(span(held === 1 ? `one left open — it holds ${why}`
                                 : `${held} left open — the first holds ${why}`, 'gr-mine'));
        out.push(span('·', 'dim'));
    }
    return out;
}

/// What is on screen, said in the same numbers the command bar uses.
function status(p, d) {
    const refs = ctx.refs();
    if (!refs.status) return;
    if (!p || !placed) return put(refs.status, () => []);
    // **From the derivation, not from what is drawn.** A folded card stands for
    // four filters and the render still runs all four, so counting the boxes on
    // the screen would make the one line on this stage that states the render
    // disagree with the command bar underneath it the moment anything folded.
    const nodes = d ? d.graph.nodes.filter((n) => n.kind === 'filter').length
                    : placed.nodes.filter((b) => b.node.kind === 'filter').length;
    const mine = d ? d.graph.nodes.filter((n) => !n.derived).length : 0;
    const locks = d ? d.graph.nodes.filter((n) => n.locked).length : 0;
    const pins = overlay.pinCount();
    const bad = d && d.problems ? d.problems.length : 0;
    put(refs.status, () => [
        span(`${p.inputs.length} input${p.inputs.length === 1 ? '' : 's'}`),
        span('·', 'dim'),
        span(`${nodes} filter${nodes === 1 ? '' : 's'}`),
        span('·', 'dim'),
        span(`${p.chains.length} chain${p.chains.length === 1 ? '' : 's'}`),
        span('·', 'dim'),
        // **What is not on the screen, whenever anything is not.** A fold is the
        // one thing this stage does that leaves part of the render undrawn, so
        // it is a statement and never silent: how many clips are one card, and
        // how many refused to be because there is work of yours inside them.
        ...foldStatus(),
        // A graph halfway through filling its pictures in should say so; half of
        // them blank and no explanation reads as broken.
        preview.isEnabled() && preview.outstanding()
            ? span(`${preview.outstanding()} rendering`, 'gr-mine') : null,
        preview.isEnabled() && preview.outstanding() ? span('·', 'dim') : null,
        // What is derived and what is not, counted separately, because that is the
        // difference the whole stage turns on: the first is rebuilt from the
        // timeline and the second survives it.
        mine || locks
            ? span(`${mine} of yours${locks ? `, ${locks} locked` : ''}`, 'gr-mine')
            : span('derived from the edit', 'dim'),
        pins ? span('·', 'dim') : null,
        pins ? span(`${pins} placed`, 'dim') : null,
        // A render with a filter of your own in it goes through libavfilter
        // instead of the internal compositor. Stated here because it is the one
        // thing on this screen that changes what the renderer does — and a graph
        // that will not run does not go there at all, which is the one thing on
        // this screen it is worse to find out afterwards.
        mine && !bad ? span('·', 'dim') : null,
        mine && !bad ? span('rendered through libavfilter', 'dim') : null,
        bad ? span('·', 'dim') : null,
        bad ? span(bad === 1 ? d.problems[0].reason
                             : `${bad} things stop this graph running — ${d.problems[0].reason}`,
                   'gr-bad') : null,
    ]);
}
