// The graph, on screen — and the conventions a node editor is expected to have.
//
// The skeleton is derived: nothing here builds a graph, it asks `derive()` for one
// on every change and draws the answer. What a person does goes into `overlay.js`
// and is put back by the derivation, so the picture is always of the edit as it is
// now rather than as it was when a node was made. Two consequences carry through
// everything below — a redraw throws away every node object (so nothing may be
// remembered by reference, see `panel.keyOf`) and a filter you insert survives
// moving, trimming and splitting the clip it is pinned to.
//
// **What this stage does, it does the way every other node editor does it.** That
// is not deference for its own sake: a node graph is a solved interface and the
// version of it we had invented was missing the parts that make one usable. So:
//
// - **Cards are DOM over a canvas that draws the wires.** The pairing
//   `ui/timeline.js` already uses. Drawing the nodes into the canvas too would
//   mean every string on this screen was `fillText` — unselectable, unstyleable,
//   and re-implementing text wrapping to lay out an option value.
// - **Pan and zoom are a `transform` on the card container; the wires, the grid
//   and the marquee are drawn in screen coordinates against an untransformed
//   canvas.** A curve stroked into a scaled canvas is a blurred curve and the
//   reason to zoom in on a graph is to read it.
// - **Nodes can be dragged, and where you put one is remembered** — against its
//   anchor, in `overlay`, so it survives the skeleton being rebuilt. `Re-layout`
//   hands the graph back. Refusing to let a node be moved, which is what this
//   stage did, is the first thing anybody tries.
// - **Level of detail.** Below `LOD_ZOOM` the bodies are not built. The loop this
//   could cause — smaller cards, a different fit, a different zoom, a different
//   level of detail — is closed by `fit()` never going below `FIT_FLOOR`, which is
//   also the right behaviour: a graph too big to frame legibly should be navigated
//   with the minimap rather than framed illegibly.
// - **Heights are measured, not guessed.** A node is as tall as the arguments its
//   filter was given. `layout()` is asked for positions only once every card has
//   been built and read, with the container's transform cleared so the numbers come
//   back in graph coordinates and not in whatever the zoom happens to be. And
//   because this stage is `display:none` most of the time, a measurement of zero
//   means "not on screen" rather than "empty" — the redraw is refused rather than
//   believed.

import { el, div, span, put } from '../dom.js';
import { clock } from '../format.js';
import { buildSpec, previewSpec, specSources, range as exportRange } from '../export/spec.js';
import { derive } from './derive.js';
import { print } from './print.js';
import { layout, NODE_W } from './layout.js';
import * as canvas from './canvas.js';
import * as cards from './card.js';
import * as overlay from './overlay.js';
import * as panel from './panel.js';
import * as preview from './preview.js';

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
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;

let refs = {};
let zoom = 1;
let panX = 0;
let panY = 0;
let placed = null;      // the last layout(), for repainting on a pan
let lastGraph = null;   // ...and the graph it was of, for the keyboard
let shape = '';         // what the graph looked like, so a fit happens once per shape
let bounds = '';        // and how big it came out, so a card that grew is framed
let userMoved = false;  // ...unless you have panned or zoomed since
let canvasSize = '';
let lod = 'full';

/// Keys, not nodes: a redraw remakes every node object. The first inserted is the
/// primary — what the panel is about — because that is the one you clicked.
let selection = new Set();
let primary = null;

/// The insert point under the pointer, by id — not the wire object it is on.
///
/// A redraw makes every wire object again, and a preview landing on any card
/// redraws: holding the object meant that the moment one did, the `+` you were
/// reaching for vanished and could not be brought back without moving to another
/// wire and back. An id is what survives a derivation; nothing else here does.
let hoverPoint = null;
let dragging = null;    // panning
let moving = null;      // dragging nodes
let resizing = null;    // dragging a card's corner
let marquee = null;     // rubber band
/// Set on the mouse-up that ends a drag and cleared by the click that follows
/// it, because a drag on the background finishes with one and "clicked the
/// background" means "select nothing".
let swallowClick = false;

const view = () => ({ zoom, panX, panY });

/// Walked by hand rather than with `closest()`: this engine's DOM is a subset, and
/// a selector match that silently answered nothing would make the whole background
/// draggable including the cards on it.
function inNode(node) {
    for (let p = node; p && p !== refs.viewport; p = p.parentNode)
        if (p.classList && p.classList.contains('gn')) return true;
    return false;
}

function port() {
    return { w: refs.viewport ? refs.viewport.clientWidth : 0,
             h: refs.viewport ? refs.viewport.clientHeight : 0 };
}

export function initGraphView(r, hooks = {}) {
    refs = r;

    preview.initPreview({
        // The preview graph is derived over its own short range, so it asks for a
        // spec of that range rather than reusing the one on screen: two seconds of
        // a ten-minute edit is two seconds of decoding, and the `trim` in the
        // graph is what makes it so.
        spec: (start, end) => previewSpec({ start, end }),
        sources: specSources,
        overlay: overlay.current,
        // How far a playback runs: to the end of what would be written, not to
        // the end of the timeline. A node is being watched to decide something
        // about the render, and the render stops where the range does.
        until: () => exportRange().end,
        // An export and the A/B comparison are both more important than this.
        busy: () => (hooks.busy ? hooks.busy() : false),
        changed: () => drawGraph(),
    });

    cards.initCards({
        keyOf: panel.keyOf,
        onSelect: (key, add) => select(key, add),
        onDragStart: (key, e) => startMove(key, e),
        onResizeStart: (key, width, e) => { resizing = { key, from: width, x: e.clientX, at: width }; },
        onChanged: () => { drawGraph(); if (hooks.changed) hooks.changed(); },
        onPlayed: (started) => {
            drawGraph();
            if (!started) note('There is nothing after this point to play.');
        },
    });

    panel.initPanel({ panel: refs.panel }, {
        // An edit to the overlay changes the graph, the command, the spine and the
        // properties panel's idea of which of its controls have been outranked.
        // The stage does not know about any of those, so it says what happened and
        // lets the application put them back in step.
        changed: () => { drawGraph(); if (hooks.changed) hooks.changed(); },
    });

    bindViewport();
    bindBar(hooks);
}

// ── pointer ────────────────────────────────────────────────────────────────

function bindViewport() {
    // **Left-drag on the background selects; middle-drag pans.** Nuke, Houdini
    // and Blender all work this way and it is the pair that leaves both gestures
    // reachable: with left-drag panning there is nowhere to put a rubber band,
    // and a node editor without one means selecting eight nodes is eight clicks.
    // Middle-drag pans from anywhere, cards included, which is the only way out
    // of a corner filled with them.
    refs.viewport.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
            dragging = { x: e.clientX, y: e.clientY, panX, panY, moved: false };
            e.preventDefault();
        } else if (e.button === 0 && !inNode(e.target)) {
            marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
                        add: e.ctrlKey || e.shiftKey };
            e.preventDefault();
        }
    });

    // A click on the background with nothing dragged is "select nothing" — the
    // panel is about a node and there has to be a way to be about none. A drag
    // that happened to end there is not: `pickInside` has already decided what
    // the selection is.
    refs.viewport.addEventListener('click', (e) => {
        if (inNode(e.target) || e.target === refs.mini || swallowClick) return;
        clearSelection();
    });

    document.addEventListener('mousemove', (e) => {
        if (resizing) return dragResize(e);
        if (moving) return dragMove(e);
        if (marquee) {
            marquee.x1 = e.clientX;
            marquee.y1 = e.clientY;
            return paint();
        }
        if (dragging) {
            panX = dragging.panX + (e.clientX - dragging.x);
            panY = dragging.panY + (e.clientY - dragging.y);
            if (Math.abs(e.clientX - dragging.x) + Math.abs(e.clientY - dragging.y) > 3) {
                dragging.moved = true;
                userMoved = true;
            }
            return apply();
        }
        hover(e);
    });

    document.addEventListener('mouseup', () => {
        if (dragging) { swallowClick = dragging.moved; dragging = null; }
        if (marquee) {
            const m = marquee;
            marquee = null;
            // A rubber band ends with a click on the background. Letting that
            // click through would clear the selection the band had just made.
            swallowClick = Math.abs(m.x1 - m.x0) + Math.abs(m.y1 - m.y0) > 4;
            pickInside(m);
            return;
        }
        if (moving) return endMove();
        if (!resizing) return;
        const done = resizing;
        resizing = null;
        // Committed once. Everything downstream of a size — the layout, the wires,
        // and the preview that has to be re-rendered to be sharp at it — happens
        // here rather than on every pixel of the drag.
        overlay.setSize(done.key, done.at);
        drawGraph();
    });

    // Zoom about the pointer, so the thing being looked at stays under it.
    // Zooming about the corner means chasing the graph across the screen with the
    // scroll wheel, which is how every node editor that gets this wrong feels.
    refs.viewport.addEventListener('wheel', (e) => {
        const rect = refs.viewport.getBoundingClientRect();
        zoomAbout(e.clientX - rect.left, e.clientY - rect.top,
                  zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
        e.preventDefault();
    });

    if (refs.mini) {
        const jump = (e) => {
            const rect = refs.mini.getBoundingClientRect();
            const to = canvas.miniPan(refs.mini, placed, view(), port(),
                                      e.clientX - rect.left, e.clientY - rect.top);
            if (!to) return;
            panX = to.panX;
            panY = to.panY;
            userMoved = true;
            apply();
        };
        refs.mini.addEventListener('mousedown', (e) => { e.stopPropagation(); jump(e); });
        refs.mini.addEventListener('mousemove', (e) => { if (e.buttons & 1) jump(e); });
    }
}

function bindBar(hooks) {
    if (refs.previews)
        refs.previews.addEventListener('click', () => {
            preview.setEnabled(!preview.isEnabled());
            drawGraph();
        });
    if (refs.atPlayhead)
        refs.atPlayhead.addEventListener('click', () => {
            if (hooks.playhead)
                preview.setRange(hooks.playhead(), hooks.playhead() + preview.previewSeconds);
            drawGraph();
        });
    if (refs.fit) refs.fit.addEventListener('click', fitView);
    if (refs.zoomIn) refs.zoomIn.addEventListener('click', () => step(1.25));
    if (refs.zoomOut) refs.zoomOut.addEventListener('click', () => step(1 / 1.25));
    // Clicking the readout is 1:1, which is what the number is claiming to be a
    // deviation from.
    if (refs.zoomLabel) refs.zoomLabel.addEventListener('click', () => step(1 / zoom));
    if (refs.relayout)
        refs.relayout.addEventListener('click', () => {
            overlay.unpinAll();
            userMoved = false;
            drawGraph();
        });
}

function step(by) {
    const p = port();
    zoomAbout(p.w / 2, p.h / 2, zoom * by);
}

/// Every write to the zoom goes through here, so that the pan correction which
/// keeps a point under the pointer, and the rebuild a change of detail needs, both
/// happen once and in one place.
function zoomAbout(mx, my, next) {
    const to = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    if (Math.abs(to - zoom) < 1e-4) return;
    panX = mx - ((mx - panX) * to) / zoom;
    panY = my - ((my - panY) * to) / zoom;
    zoom = to;
    userMoved = true;
    if (detail() !== lod) drawGraph();
    else apply();
}

const detail = () => (zoom < cards.LOD_ZOOM ? 'min' : 'full');

// ── moving nodes ───────────────────────────────────────────────────────────

/// Dragging a header moves that node — and every other selected node with it,
/// which is what a multiple selection is for.
function startMove(key, e) {
    if (!key || !placed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selection.has(key)) select(key, false);
    const from = new Map();
    for (const box of placed.nodes) {
        const k = panel.keyOf(box.node);
        if (k && selection.has(k)) from.set(k, { x: box.x, y: box.y });
    }
    moving = { x: e.clientX, y: e.clientY, from, at: new Map(), moved: false };
}

/// Written straight to the elements, in graph coordinates — the container is
/// scaled, so a hundred pixels of mouse at 0.5× is two hundred pixels of card.
/// The wires follow because `placed` is updated with them; nothing is re-derived
/// and nothing is re-measured until the drag ends.
function dragMove(e) {
    const dx = (e.clientX - moving.x) / Math.max(0.1, zoom);
    const dy = (e.clientY - moving.y) / Math.max(0.1, zoom);
    if (Math.abs(dx) + Math.abs(dy) > 2) moving.moved = true;
    for (const [key, from] of moving.from) {
        const at = { x: Math.round(from.x + dx), y: Math.round(from.y + dy) };
        moving.at.set(key, at);
        const node = refs.nodes.querySelector(`[data-key="${key}"]`);
        if (node) { node.style.left = `${at.x}px`; node.style.top = `${at.y}px`; }
        for (const box of placed.nodes) {
            if (panel.keyOf(box.node) !== key) continue;
            box.x = at.x;
            box.y = at.y;
        }
    }
    reflowWires();
    paint();
}

/// The wire endpoints again, from boxes that have moved. The same arithmetic
/// `layout()` does, and the reason it is repeated rather than shared is that this
/// runs on a mouse move and `layout()` needs measured heights it cannot have
/// mid-drag.
function reflowWires() {
    const at = new Map(placed.nodes.map((b) => [b.node.id, b]));
    for (const w of placed.wires) {
        const a = at.get(w.edge.from), b = at.get(w.edge.to);
        if (!a || !b) continue;
        w.x1 = a.x + a.w;
        w.y1 = a.y + w.oy1;
        w.x2 = b.x;
        w.y2 = b.y + w.oy2;
    }
}

function endMove() {
    const done = moving;
    moving = null;
    if (!done.moved) return;
    for (const [key, at] of done.at) overlay.setPin(key, at.x, at.y);
    drawGraph();
}

// ── selection ──────────────────────────────────────────────────────────────

function select(key, add) {
    if (!key) return clearSelection();
    if (!add) selection.clear();
    selection.add(key);
    primary = key;
    panel.selectNode(key, selection.size);
    markSelection();
    paint();
}

function clearSelection() {
    selection.clear();
    primary = null;
    panel.selectNode(null, 0);
    markSelection();
    paint();
}

/// Everything the rubber band touched.
function pickInside(m) {
    if (!placed) return;
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
function markSelection() {
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

/// What was last laid out, for tests: where the cards ended up and where the
/// wires run, in graph coordinates, plus the view transform needed to turn either
/// into a screen position. Exposed because the alternative is a test that
/// hard-codes pixel positions of a layout it does not compute, and hovering a
/// wire is a gesture that has to be checkable.
export function graphPlacement() {
    return placed ? { nodes: placed.nodes, wires: placed.wires, zoom, panX, panY } : null;
}

/// The keys this stage wants while it is up. Returns whether it took one, so
/// `app.js` can fall through to leaving the stage when it did not.
export function graphKey(e) {
    if (e.key === '0') { fitView(); return true; }
    if (e.key === 'Escape' && selection.size) { clearSelection(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size && lastGraph) {
        let any = false;
        for (const key of Array.from(selection)) {
            const node = lastGraph.node(key) || lastGraph.byAnchor(key);
            // Only what a person put there. A derived node is the edit, and the
            // way to be rid of one is to change the edit.
            if (node && !node.derived) any = overlay.removeInsert(node.id) || any;
        }
        if (any) { clearSelection(); drawGraph(); }
        return any;
    }
    return false;
}

// ── what the graph comes to ────────────────────────────────────────────────

/// For the spine's card and anything else that wants the shape without the
/// picture. Cheap: `derive()` is a pure walk over a handful of clips, which is
/// also what the command bar does twice a draw.
export function graphSummary() {
    const d = derive(buildSpec(), specSources(), { overlay: overlay.current() });
    if (!d.ok) return { ok: false, reason: d.reason };
    const p = print(d.graph);
    return {
        ok: true,
        nodes: d.graph.nodes.filter((n) => n.kind === 'filter').length,
        chains: p.chains.length,
        inputs: p.inputs.length,
        caveats: d.caveats.length,
        mine: d.graph.nodes.filter((n) => !n.derived).length,
        locks: d.graph.nodes.filter((n) => n.locked).length,
        overrides: d.overrides,
    };
}

/// Which controls elsewhere in the application are outranked by a lock, by clip
/// id. The properties panel asks, because a field that has quietly stopped
/// applying has to say so where it is, not only on a stage nobody may be looking
/// at.
export function outrankedControls() {
    const d = derive(buildSpec(), specSources(), { overlay: overlay.current() });
    const by = {};
    if (!d.ok) return by;
    for (const o of d.overrides) {
        if (!o.clip || !o.control || !o.keys.length) continue;
        const list = by[o.clip] || (by[o.clip] = []);
        if (list.indexOf(o.control) < 0) list.push(o.control);
    }
    return by;
}

// ── the draw ───────────────────────────────────────────────────────────────

const cardWidth = (key) => Math.max(120, Math.min(720, overlay.sizeOf(key) || NODE_W));

/// Rebuild from the edit. Refused while the stage is not on screen, because every
/// height it needs would measure zero and the layout would be a stack of nodes in
/// the top-left corner that nobody ever sees be wrong.
export function drawGraph() {
    if (!refs.viewport) return;
    if (!refs.viewport.clientWidth) return;

    const d = derive(buildSpec(), specSources(), { overlay: overlay.current() });
    if (!d.ok) {
        placed = null;
        lastGraph = null;
        put(refs.nodes, () => []);
        paint();
        note(d.reason ? `No graph: ${d.reason}.` : 'No graph.');
        status(null);
        panel.draw(null);
        return;
    }
    note('');
    lastGraph = d.graph;
    // Kept because the hover rebuild needs them, and re-deriving on a mouse move
    // to find out where five wires are would derive the whole graph sixty times a
    // second.
    lastPoints = d.points;
    lod = detail();

    // Build, then measure, then place. The transform is cleared for the
    // measurement so heights come back in graph coordinates whatever the zoom is —
    // a card read at 1.4× and then positioned at 1.4× would compound.
    const built = new Map();
    // Whoever caused this redraw, the field somebody is typing into survives
    // it. See cards.noteFocus: a preview arriving is a redraw too.
    cards.noteFocus(refs.nodes);
    refs.nodes.style.transform = 'none';
    refs.nodes.classList.toggle('lod-min', lod === 'min');
    put(refs.nodes, () => d.graph.nodes.map((n) => {
        const key = panel.keyOf(n);
        const node = cards.buildCard(n, { graph: d.graph, key, width: cardWidth(key), lod });
        built.set(n.id, node);
        return node;
    }));

    const measured = new Map();
    for (const n of d.graph.nodes)
        measured.set(n.id, { w: cardWidth(panel.keyOf(n)),
                             h: built.get(n.id).getBoundingClientRect().height });

    placed = layout(d.graph, (n) => measured.get(n.id),
                    (n) => overlay.pinOf(panel.keyOf(n)));
    const boxes = new Map();
    for (const box of placed.nodes) {
        const node = built.get(box.node.id);
        node.classList.add(`gn-${box.stream}`);
        if (box.pinned) node.classList.add('gn-pinned');
        node.style.left = `${box.x}px`;
        node.style.top = `${box.y}px`;
        cards.placeSockets(node, box.h);
        boxes.set(box.node.id, box);
    }

    drawInsertPoints(d, boxes);
    if (refs.previews) refs.previews.classList.toggle('on', preview.isEnabled());

    // Frame it when the graph is a different graph, and also when it is the same
    // graph at a different size — a card is as tall as what is in it, and eight
    // pictures arriving one at a time grow the layout out from under a frame
    // computed before any of them existed. Not once you have panned or zoomed
    // yourself: at that point where you are looking is a decision, and nothing
    // here gets to overrule it.
    const nowShape = shapeOf(d.graph);
    const nowBounds = `${Math.round(placed.width)}x${Math.round(placed.height)}`;
    if (shape !== nowShape || (!userMoved && bounds !== nowBounds)) {
        shape = nowShape;
        bounds = nowBounds;
        fit();
        // A fit can only ever move the zoom *up* across the detail threshold —
        // `FIT_FLOOR` is that threshold — so this is at most one more pass and
        // never a pair of them arguing. Without it a graph framed after being
        // zoomed out keeps the bodies it was built without.
        if (detail() !== lod) return drawGraph();
    }
    apply();
    status(print(d.graph), d);
    panel.draw(d.graph);
    markSelection();
    cards.restoreFocus(refs.nodes);
    syncPreviews();
}

/// The insert points, on the wire each one names.
///
/// Only the wire under the pointer, and the one whose point is open, get a `+`.
/// One on every wire all the time was five orange dots reading as part of the
/// graph — and n8n, which is where this gesture is from, shows it on hover for
/// exactly that reason.
function drawInsertPoints(d, boxes) {
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
function syncPreviews() {
    if (preview.isEnabled())
        preview.sync(placed.nodes
            .map((b) => ({ key: panel.keyOf(b.node),
                           fit: previewFit(cardWidth(panel.keyOf(b.node))) }))
            .filter((w) => w.key));
    cards.dropUnless((key) => !!preview.shotFor(key));
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
    preview.tick();
    playFrame();
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
    const strip = refs.nodes && refs.nodes.querySelector('.gn-playbar .gn-clock');
    if (!strip) return;
    const slow = st.settled && st.rate < 0.95;
    // The rate is what is actually being sustained, waits included, because that
    // is the number somebody deciding whether a filter is affordable wants —
    // rather than the renderer's throughput with the stalls taken out, which would
    // say a graph was fast while you watched it not be. Withheld for the first
    // second and a half: there is nothing to average over yet, and the first piece
    // is a render nobody has waited for.
    strip.textContent = clock(st.at) +
        (st.settled ? ` · ${st.rate.toFixed(2)}×` : '') +
        (st.waiting ? ' · rendering' : slow ? ' · slower than real time' : '');
    strip.className = 'gn-clock' + (slow || st.waiting ? ' gn-slow' : '');
}

// ── view transform ─────────────────────────────────────────────────────────

/// Frame the whole graph and repaint. The two halves are separate because
/// `drawGraph()` fits before it has anything to apply to.
export function fitView() {
    userMoved = false;
    fit();
    // Framing a graph you had zoomed out of brings the detail back with it. Same
    // one-pass argument as in `drawGraph`.
    if (detail() !== lod) drawGraph();
    else apply();
}

/// Zoom and centre so the whole graph is on screen — never magnified past
/// life-size, because a four-node graph blown up to fill the window reads as an
/// error, and never shrunk past `FIT_FLOOR`, for the reason written there.
function fit() {
    if (!placed || !refs.viewport) return;
    const { w, h } = port();
    if (!w || !h || !placed.width) return;
    const pad = 28;
    const want = Math.min((w - pad * 2) / placed.width,
                          (h - pad * 2) / Math.max(1, placed.height));
    zoom = Math.max(FIT_FLOOR, Math.min(1, want));
    panX = (w - placed.width * zoom) / 2 - placed.left * zoom;
    panY = (h - placed.height * zoom) / 2 - placed.top * zoom;
}

function apply() {
    if (!refs.nodes) return;
    refs.nodes.style.transform =
        `translate(${Math.round(panX)}px, ${Math.round(panY)}px) scale(${zoom})`;
    if (refs.zoomLabel) refs.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    paint();
}

/// What the pointer is over, which decides which wire is lit and where the `+`
/// goes. Only acted on when it changes: this runs on every mouse move.
function hover(e) {
    // This is on the document, so it runs while some other stage is up and the
    // viewport is `display:none` — where every coordinate is zero and every wire
    // would look like a hit.
    if (!placed || !refs.viewport || !refs.viewport.clientWidth) return;
    const rect = refs.viewport.getBoundingClientRect();
    const was = hoverPoint;
    const wire = inNode(e.target)
        ? null
        : canvas.wireAt(placed, e.clientX - rect.left, e.clientY - rect.top, view());
    // A wire with no insert point on it is not a wire anything can be put on, so
    // hovering it offers nothing — which is itself the answer to "why is there no
    // + here", and better than a `+` that turns out to be unclickable.
    const point = wire && lastPoints
        ? lastPoints.find((p) => p.at === wire.edge.from &&
                                 (p.atPort || 0) === (wire.edge.fromPort || 0)) : null;
    hoverPoint = point ? point.id : null;
    if (was === hoverPoint) return;
    // The `+` is a DOM element in the card container, so a change of hovered wire
    // is a small rebuild of just those. Cheaper than it sounds: there are five.
    for (const b of Array.from(refs.nodes.querySelectorAll('.gp-plus')))
        refs.nodes.removeChild(b);
    if (lastPoints) {
        drawInsertPoints({ points: lastPoints },
                         new Map(placed.nodes.map((b) => [b.node.id, b])));
    }
    paint();
}

let lastPoints = null;

function paint() {
    const c = refs.canvas;
    if (!c || !refs.viewport) return;
    const { w, h } = port();
    if (w <= 0 || h <= 0) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    canvas.paintGrid(ctx, w, h, view());
    canvas.paintWires(ctx, placed, view(), litWire(), hoveredWire());
    if (marquee) paintMarquee(ctx);
    if (refs.mini) canvas.paintMini(refs.mini, placed, view(), port());
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

function paintMarquee(ctx) {
    const rect = refs.viewport.getBoundingClientRect();
    const x = Math.min(marquee.x0, marquee.x1) - rect.left;
    const y = Math.min(marquee.y0, marquee.y1) - rect.top;
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = 'rgba(74, 158, 255, 0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
}

/// The stage resizes when the window does, and the wires are drawn in screen
/// coordinates, so they have to be told. Called from the frame loop; a measurement
/// of zero means the stage is not up and is ignored rather than acted on.
export function chaseGraph() {
    if (!refs.viewport) return;
    const { w, h } = port();
    if (w <= 0 || h <= 0) return;
    const key = `${w}x${h}`;
    if (key === canvasSize) return;
    canvasSize = key;
    if (!placed) drawGraph();
    else paint();
}

function note(text) {
    if (!refs.note) return;
    refs.note.textContent = text;
    refs.note.classList.toggle('hidden', !text);
}

/// What is on screen, said in the same numbers the command bar uses.
function status(p, d) {
    if (!refs.status) return;
    if (!p || !placed) return put(refs.status, () => []);
    const nodes = placed.nodes.filter((b) => b.node.kind === 'filter').length;
    const mine = d ? d.graph.nodes.filter((n) => !n.derived).length : 0;
    const locks = d ? d.graph.nodes.filter((n) => n.locked).length : 0;
    const pins = overlay.pinCount();
    put(refs.status, () => [
        span(`${p.inputs.length} input${p.inputs.length === 1 ? '' : 's'}`),
        span('·', 'dim'),
        span(`${nodes} filter${nodes === 1 ? '' : 's'}`),
        span('·', 'dim'),
        span(`${p.chains.length} chain${p.chains.length === 1 ? '' : 's'}`),
        span('·', 'dim'),
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
        // thing on this screen that changes what the renderer does.
        mine ? span('·', 'dim') : null,
        mine ? span('rendered through libavfilter', 'dim') : null,
    ]);
}
