// The Find stage on the screen.
//
// A canvas of rule cards, wires between them, and a panel for the one that is
// selected — `ui/graph/view.js`'s idiom, deliberately, because somebody who has
// used the Graph stage has already learnt this one. What it is *not* is that
// file: this graph's wires carry recordings and stacks rather than pads (see
// `ui/find/model.js` for why the two must stay apart), so what a card says, what
// a socket refuses and what the panel edits are all this stage's own.
//
// The geometry and the wire painting are **imported**, not reimplemented:
// `ui/graph/layout.js` places the nodes and `ui/graph/canvas.js` strokes the
// curves, both taught the one thing they did not know — that a wire can carry
// something other than a picture or a sound — as a parameter. Two node editors
// with two bezier implementations would drift in a week, and the drift would be
// invisible until somebody noticed the two stages did not look alike.
//
// **The cards are DOM and the wires are canvas**, for `ui/graph/canvas.js`'s
// stated reason: a card is a small panel and a panel is what the DOM is for,
// while a few dozen beziers in elements would mean re-implementing curve
// rasterisation. The cards live in a container with a `transform` and the canvas
// is untransformed and drawn in screen coordinates, which is what keeps a
// zoomed-in wire sharp.
//
// **Nothing here reads a soundtrack.** Every number on this screen comes from
// `find.js` `result()`, which is a walk over lists that were read on Sources
// long before. That is what makes a keystroke in the phrase field cheap enough
// to re-evaluate on.

import { el, div, span, put } from '../dom.js';
import * as canvas from '../graph/canvas.js';
import { FIND_WIRES } from '../graph/canvas.js';
import { NODE_W } from '../graph/layout.js';
import * as find from '../find.js';
// The one home of what a mark measured. Read rather than restated, because
// `tests/ui_marks.js` asserts that none of these sentences names a *source* of
// sound and a second copy is the one that guard cannot see.
import { MARK_WORDS } from '../marks.js';
import * as N from './nodes.js';
import * as S from './stack.js';
import { layoutFind } from './model.js';

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.2;

let refs = {};
let hooks = {};

let zoom = 1;
let panX = 60;
let panY = 40;
let placed = null;      // the last layout(), for repainting on a pan
let framed = false;     // has the canvas been fitted to this graph yet

let chosen = null;      // the selected node
let moving = null;      // dragging a card
let panning = null;
let wiring = null;      // a wire in the air
let hovered = null;     // the socket under the pointer while wiring
let swallowClick = false;

/// The card elements by node id, so a drag moves one instead of rebuilding all.
const cards = new Map();

const view = () => ({ zoom, panX, panY });
const graph = () => find.findGraph();

const port = () => ({
    w: refs.viewport ? refs.viewport.clientWidth : 0,
    h: refs.viewport ? refs.viewport.clientHeight : 0,
});

export function initFindView(r, h = {}) {
    refs = r;
    hooks = h;
    bindViewport();
    bindBar();
}

// ── drawing ───────────────────────────────────────────────────────────────

/// Rebuild the whole stage. Cheap in the way this application means it: the
/// cards are one element each over a graph of a dozen nodes, and the evaluation
/// behind them is memoised in `find.js`.
///
/// **Measured before it is placed**, `ui/graph/layout.js`'s build/measure split:
/// a card's height depends on how many fields its kind declares and there is no
/// honest way to guess it, so the cards go into the DOM, are measured, and only
/// then does the layout run.
export function drawFind() {
    if (!refs.viewport) return;
    const g = graph();
    const res = find.result();

    // Gone nodes take their cards with them. Done before the build so a card
    // whose node was deleted cannot be measured into the layout.
    for (const [id, card] of [...cards]) {
        if (g.nodes.some((n) => n.id === id)) continue;
        if (card.parentNode) card.parentNode.removeChild(card);
        cards.delete(id);
    }
    if (chosen && !g.node(chosen)) chosen = null;

    for (const node of g.nodes) {
        const card = buildCard(node, res);
        const had = cards.get(node.id);
        if (had && had.parentNode) refs.nodes.replaceChild(card, had);
        else refs.nodes.appendChild(card);
        cards.set(node.id, card);
    }

    placed = layoutFind(g, (n) => {
        const card = cards.get(n.id);
        return { w: (card && card.offsetWidth) || NODE_W,
                 h: (card && card.offsetHeight) || 48 };
    });

    for (const box of placed.nodes) place(cards.get(box.node.id), box.x, box.y);

    if (!framed && placed.nodes.length) { framed = true; fitView(); }
    apply();
    drawPanel(res);
    drawStatus(res);
}

/// The canvas is only ever the size of what is looking at it, and the transform
/// is the only thing that moves. `ui/graph/view.js` `apply()`.
function apply() {
    if (!refs.nodes) return;
    refs.nodes.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    paint();
    if (refs.zoomLabel) refs.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function place(card, x, y) {
    if (!card) return;
    // A transform rather than left/top, for the reason ui/style.css states at
    // `.gn`: an offset is a layout property and moving one card by it lays the
    // whole container out again.
    card.style.transform = `translate(${x}px, ${y}px)`;
}

function paint() {
    const c = refs.wires;
    if (!c) return;
    const p = port();
    if (c.width !== p.w || c.height !== p.h) { c.width = p.w; c.height = p.h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    canvas.paintGrid(ctx, c.width, c.height, view());
    // A wire is lit when it touches what is selected — `ui/graph/canvas.js`'s
    // rule and most of how a graph with a dozen chains in it stays readable.
    const lit = (w) => !!chosen && (w.edge.from === chosen.id || w.edge.to === chosen.id);
    canvas.paintWires(ctx, placed, view(), lit, null, null, FIND_WIRES);
    if (wiring) {
        const to = hovered ? screenOf(hovered.at) : wiring.to;
        canvas.paintPending(ctx, screenOf(wiring.at), to, wiring.kind,
                            !!hovered && wiring.ok, FIND_WIRES);
    }
    if (refs.mini) canvas.paintMini(refs.mini, placed, view(), p, FIND_WIRES);
}

const screenOf = (pt) => ({ x: pt.x * zoom + panX, y: pt.y * zoom + panY });

// ── a card ────────────────────────────────────────────────────────────────

/// One node, as the panel it is.
///
/// Three lines and no more: what kind of rule this is, what it is set to, and
/// what came out of it. The settings themselves are in the side panel rather
/// than on the card, which is `ui/graph/view.js`'s split and is what keeps a
/// canvas of ten rules readable — a card carrying six fields is a card you have
/// to zoom in to skim.
///
/// **The count is on the card and that is the point of the stage.** Every node
/// says how many candidates left it, so a chain of five reads as five numbers
/// going down — 412 hits, 180 after the length filter, 60 after the mix — and
/// where a rule threw away everything is visible without opening anything.
function buildCard(node, res) {
    const kind = N.kindOf(node);
    const value = res.values.get(node.id);
    const note = res.notes.get(node.id) || '';
    const ctx = find.context();
    const isStack = kind && kind.outs[0] !== N.INPUT;

    const card = el('div', {
        cls: 'fn' + (chosen && chosen.id === node.id ? ' on' : '') +
             (node.kind === 'source' ? ' fn-source' : '') +
             (node.kind === 'stack' ? ' fn-sink' : ''),
        'data-node': node.id,
    });

    const head = div('fn-head', [
        span(kind ? kind.title : node.kind, 'fn-kind'),
        // How many came out. A recording answers with a name rather than a
        // count, because "1" is not a fact anybody wants about a file.
        span(node.kind === 'source' ? '' :
             `${(value && value.length) || 0}`, 'fn-count'),
    ]);
    card.appendChild(head);

    const label = kind && kind.label ? kind.label(node, ctx) : '';
    if (label) card.appendChild(div('fn-label', label));
    if (note) card.appendChild(div('fn-note', note));
    // How much material, on anything that carries a stack — for
    // `ui/find/stack.js` `summaryOf`'s reason: forty candidates is four minutes
    // at six seconds each and forty minutes at sixty, and those are different
    // things to be about to put on a timeline.
    if (isStack && value && value.length)
        card.appendChild(div('fn-total dim', S.showTime(S.totalOf(value))));

    for (const [dir, kinds] of [['in', N.portKinds(node, 'in')],
                                ['out', N.portKinds(node, 'out')]])
        kinds.forEach((k, i) => card.appendChild(socketEl(node, dir, i, k, kinds.length)));

    head.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        pick(node);
        startMove(node, e);
        e.preventDefault();
    });
    card.addEventListener('mousedown', (e) => { if (e.button === 0) pick(node); });
    return card;
}

/// A socket. Drawn in the DOM so it can be grabbed and so it shows what it
/// takes; **hit-tested off the layout** while a wire is in the air, which is
/// `ui/graph/canvas.js`'s stated rule — the cards are inside a transform, and an
/// eight-pixel target at 0.6x zoom is one nobody can hit.
function socketEl(node, dir, index, kindName, count) {
    const s = el('div', {
        cls: `fn-sock fn-sock-${dir} fn-sock-${kindName}`,
        title: kindName === N.INPUT ? 'a recording' : 'a stack of clips',
    });
    // The same formula the wire lands by — `portY`, one home, so a dot drawn
    // anywhere else would make the picture say this wire goes to that port when
    // it does not. The height is not known until the card is measured, so this
    // is a percentage of it rather than a pixel offset.
    s.style.top = `${((index + 1) / (count + 1)) * 100}%`;
    s.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        startWire(node, dir, index, kindName, e);
    });
    return s;
}

// ── the panel ─────────────────────────────────────────────────────────────

/// What the selected rule is set to. One column, because setting a rule and
/// reading what it found are one gesture with a pause in it.
function drawPanel(res) {
    if (!refs.panel) return;
    put(refs.panel, () => {
        if (!chosen) return [div('dim', 'Pick a rule, or add one.')];
        const kind = N.kindOf(chosen);
        if (!kind) return [div('dim', 'an unknown rule')];
        const out = [div('fn-panel-head', kind.title)];
        for (const f of kind.fields || []) {
            // A field that only applies to one setting of another — the pitch
            // on a tonal run, the seed on a shuffle — is absent rather than
            // greyed. `ui/export/explain.js`'s line: a control that cannot do
            // anything is one more thing to read past.
            if (f.only && !holds(chosen, f.only)) continue;
            if (f.notFor && holds(chosen, f.notFor)) continue;
            out.push(fieldRow(chosen, f));
        }
        const value = res.values.get(chosen.id);
        const note = res.notes.get(chosen.id);
        if (note) out.push(div('ex-note', note));
        if (chosen.kind === 'stack') out.push(...sinkRows(chosen, value));
        else if (Array.isArray(value)) out.push(...previewRows(value));
        out.push(div('fn-panel-foot', [
            el('button', {
                cls: 'btn tiny', text: 'Remove',
                on: { click: () => { graph().remove(chosen); chosen = null; drawFind(); } },
            }),
        ]));
        return out;
    });
}

/// Is `state` what this node is currently set to?
///
/// A field can be present only in one state (`only`) or absent in one
/// (`notFor`), and both are the same question asked of the node's settings. The
/// two are needed rather than one: a pitch means something only on a tonal run,
/// and a length bound means something on everything *except* a transient — which
/// has no length, so a bound on one passes nothing rather than everything.
function holds(node, state) {
    return Object.values(node.params).some((v) => v === state);
}

function fieldRow(node, f) {
    const g = graph();
    const value = node.params[f.key];
    let control;
    if (f.kind === 'input') {
        control = el('select', {
            on: { change: (e) => { g.setParam(node, f.key, e.target.value); drawFind(); } },
        }, [el('option', { value: '', text: '— nothing —' })].concat(
            find.pickableInputs().map((i) => el('option', {
                value: i.id, text: i.name, selected: i.id === value || undefined }))));
    } else if (f.kind === 'mark') {
        // The words are `ui/marks.js` `MARK_WORDS`, on the tooltip and not
        // rewritten: that object is the one home of what a mark measured, and
        // `tests/ui_marks.js` refuses a copy of it that names a *source* of
        // sound. A copy here is the one the guard cannot see.
        control = el('select', {
            on: { change: (e) => { g.setParam(node, f.key, e.target.value); drawFind(); } },
        }, Object.keys(MARK_WORDS).map((k) => el('option', {
            value: k, text: k, title: MARK_WORDS[k],
            selected: k === value || undefined })));
    } else if (f.kind === 'order') {
        control = el('select', {
            on: { change: (e) => { g.setParam(node, f.key, e.target.value); drawFind(); } },
        }, S.ORDERS.map((k) => el('option', {
            value: k, text: k, selected: k === value || undefined })));
    } else if (f.kind === 'flag') {
        control = el('input', {
            type: 'checkbox', checked: !!value || undefined,
            on: { change: (e) => { g.setParam(node, f.key, !!e.target.checked); drawFind(); } },
        });
    } else if (f.kind === 'seed') {
        control = el('button', {
            cls: 'btn tiny', text: `shuffle (${value})`,
            title: 'A different order. Seeded rather than random, so the same ' +
                   'document opens as the same montage.',
            on: { click: () => { g.setParam(node, f.key, String((Number(value) || 1) + 1));
                                 drawFind(); } },
        });
    } else {
        control = el('input', {
            cls: 'wide', type: 'text', value: value === undefined ? '' : String(value),
            placeholder: f.placeholder || '',
            // **`input` and not `change`**, and CLAUDE.md says why at length: a
            // field that can commit on `input` should, because `change` arrives
            // during the press on whatever was clicked next. Every rule here is
            // cheap to re-run, so a keystroke re-evaluates and the counts on the
            // cards move as the phrase is typed — which is the whole feel of the
            // stage.
            on: { input: (e) => { g.setParam(node, f.key, e.target.value); drawFind(); } },
        });
    }
    return div('fn-field', [span(f.label, 'fn-field-name'), control,
                            f.unit ? span(f.unit, 'dim') : null].filter(Boolean));
}

/// What a stack node offers: the press that makes it an edit.
function sinkRows(node, list) {
    const rows = [];
    const n = (list && list.length) || 0;
    rows.push(div('ex-note', n
        ? `${S.summaryOf(list)} — sent end to end onto one track, in this order.`
        : 'Nothing in this stack yet.'));
    rows.push(div('fn-panel-foot', [
        el('button', {
            cls: 'btn tiny primary', text: `Send ${n} to the timeline`,
            disabled: n ? undefined : true,
            title: 'Put these on the timeline, end to end, after whatever is ' +
                   'already on the track.\nA candidate off a word search carries ' +
                   'ten seconds either side — the two renditions of a stream do ' +
                   'not share a zero — so what lands contains the moment rather ' +
                   'than cutting at it. The trim is yours.',
            on: { click: () => {
                const out = find.sendToTimeline(list);
                if (hooks.flash)
                    hooks.flash(out.skipped
                        ? `${out.made} on the timeline · ${out.skipped} skipped — their recording is gone`
                        : `${out.made} on the timeline`);
                if (hooks.wentToTimeline) hooks.wentToTimeline();
            } },
        }),
    ]));
    return rows;
}

/// The first few candidates, so a rule can be judged without leaving the stage.
///
/// **Capped, and it says so when it caps.** Twelve hundred rows would be twelve
/// hundred elements rebuilt on every keystroke, and the honest thing is a bound
/// that is stated rather than a list that quietly stops — `ui/sources.js` draws
/// its hits the same way and for the same reason.
const SHOWN = 8;

function previewRows(list) {
    if (!list.length) return [];
    const rows = [div('fn-panel-head', 'What it found')];
    for (const c of list.slice(0, SHOWN))
        rows.push(div('fn-cand', [
            span(S.showAt(c.at), 'mono'),
            span(S.showTime(S.lengthOf(c)), 'dim'),
            span(c.detail || c.rule, 'fn-cand-why'),
        ]));
    if (list.length > SHOWN)
        rows.push(div('dim', `…and ${list.length - SHOWN} more`));
    return rows;
}

function drawStatus(res) {
    if (!refs.status) return;
    const g = graph();
    const stacks = find.stacks();
    if (!g.nodes.length) {
        refs.status.textContent =
            'Nothing yet. Add a Recording, then a Said or a Sound, then a Stack.';
        return;
    }
    const loops = [...res.notes.values()].filter((n) => n === 'this is in a loop').length;
    refs.status.textContent =
        `${g.nodes.length} rules · ${stacks.length} stack${stacks.length === 1 ? '' : 's'}` +
        (loops ? ` · ${loops} in a loop` : '');
}

// ── pointer ───────────────────────────────────────────────────────────────

function inCard(target) {
    for (let n = target; n && n !== refs.viewport; n = n.parentNode)
        if (n.classList && n.classList.contains('fn')) return true;
    return false;
}

function bindViewport() {
    // Middle-drag pans from anywhere, left-drag on the background pans too.
    // **Not `ui/graph/view.js`'s rubber band**, and the difference is what the
    // two stages are: that one has six hundred derived nodes and selecting
    // eight of them is a real gesture, where this canvas is a dozen rules
    // somebody placed by hand and a marquee would be a mechanism with nothing
    // to select. Left-drag panning is what is left, and it is the more
    // discoverable of the two.
    refs.viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        if (e.button === 0 && inCard(e.target)) return;
        panning = { x: e.clientX, y: e.clientY, panX, panY, moved: false };
        e.preventDefault();
    });

    refs.viewport.addEventListener('click', (e) => {
        if (inCard(e.target) || swallowClick) { swallowClick = false; return; }
        // A click on a wire takes it out. A wire has no settings, so selecting
        // one would be a state with nothing in it; cutting is the only thing
        // anybody wants from a wire on this canvas.
        const rect = refs.viewport.getBoundingClientRect();
        const hit = canvas.wireAt(placed, e.clientX - rect.left, e.clientY - rect.top, view());
        if (hit) { graph().removeEdge(hit.edge); return drawFind(); }
        pick(null);
    });

    document.addEventListener('mousemove', (e) => {
        if (wiring) return dragWire(e);
        if (moving) return dragMove(e);
        if (!panning) return;
        panX = panning.panX + (e.clientX - panning.x);
        panY = panning.panY + (e.clientY - panning.y);
        if (Math.abs(e.clientX - panning.x) + Math.abs(e.clientY - panning.y) > 3)
            panning.moved = true;
        apply();
    });

    document.addEventListener('mouseup', (e) => {
        if (wiring) return endWire(e);
        if (moving) return endMove();
        if (panning) { swallowClick = panning.moved; panning = null; }
    });

    // Zoom about the pointer, so the thing being looked at stays under it.
    refs.viewport.addEventListener('wheel', (e) => {
        const rect = refs.viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX,
            zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const gx = (mx - panX) / zoom, gy = (my - panY) / zoom;
        zoom = next;
        panX = mx - gx * zoom;
        panY = my - gy * zoom;
        apply();
        e.preventDefault();
    });
}

function pick(node) {
    if (chosen === node) return;
    chosen = node;
    drawFind();
}

// ── moving a card ─────────────────────────────────────────────────────────

function startMove(node, e) {
    const box = placed && placed.nodes.find((b) => b.node.id === node.id);
    if (!box) return;
    moving = { node, x: e.clientX, y: e.clientY, x0: box.x, y0: box.y, moved: false };
}

function dragMove(e) {
    const dx = (e.clientX - moving.x) / zoom;
    const dy = (e.clientY - moving.y) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 2) moving.moved = true;
    const x = moving.x0 + dx, y = moving.y0 + dy;
    place(cards.get(moving.node.id), x, y);
    const box = placed && placed.nodes.find((b) => b.node.id === moving.node.id);
    if (box) {
        box.x = x;
        box.y = y;
        // The wires that touch this card follow it *during* the drag, off the
        // offsets the layout kept for exactly this. Re-deriving would mean
        // laying the whole graph out on every mouse move.
        for (const w of placed.wires) {
            if (w.edge.from === moving.node.id) { w.x1 = x + box.w; w.y1 = y + w.oy1; }
            if (w.edge.to === moving.node.id) { w.x2 = x; w.y2 = y + w.oy2; }
        }
    }
    paint();
}

function endMove() {
    const m = moving;
    moving = null;
    if (!m || !m.moved) return;
    const box = placed && placed.nodes.find((b) => b.node.id === m.node.id);
    if (box) graph().pin(m.node, { x: box.x, y: box.y });
    swallowClick = true;
}

// ── wiring ────────────────────────────────────────────────────────────────

/// A wire starts at a socket and is carried to another.
///
/// Started from either end, because both are real gestures: dragging out of an
/// output looking for somewhere to put it, and dragging out of an empty input
/// looking for something to fill it. What is carried is the *kind* either way,
/// which is what decides whether the far end can take it.
function startWire(node, dir, index, kindName, e) {
    const box = placed && placed.nodes.find((b) => b.node.id === node.id);
    if (!box) return;
    // Dragging out of a filled input picks the existing wire up rather than
    // making a second one — a socket takes one, so the alternative is a gesture
    // that silently replaces something.
    if (dir === 'in') {
        const had = graph().inEdges(node).find((x) => x.port === index);
        if (had) graph().removeEdge(had);
    }
    wiring = {
        node, dir, index, kind: kindName, ok: false,
        at: canvas.socketPoint(box, dir, index),
        to: { x: e.clientX, y: e.clientY },
    };
    dragWire(e);
}

function dragWire(e) {
    const rect = refs.viewport.getBoundingClientRect();
    wiring.to = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const hit = canvas.socketAt(placed, wiring.to.x, wiring.to.y, view());
    // A wire may only land on the opposite kind of socket, and only on one that
    // takes what it carries. Both are tested here so the dot under the pointer
    // is filled exactly when letting go would connect.
    hovered = null;
    if (hit && hit.dir !== wiring.dir && hit.node !== wiring.node) {
        const other = N.portKinds(hit.node, hit.dir)[hit.port];
        wiring.ok = N.accepts(wiring.dir === 'out' ? wiring.kind : other,
                              wiring.dir === 'out' ? other : wiring.kind);
        hovered = hit;
    }
    paint();
}

function endWire(e) {
    const w = wiring;
    const hit = hovered;
    wiring = null;
    hovered = null;
    if (!w || !hit) return drawFind();
    const g = graph();
    const why = w.dir === 'out'
        ? g.connect(w.node, hit.node, hit.port, w.index)
        : g.connect(hit.node, w.node, w.index, hit.port);
    if (why && hooks.flash) hooks.flash(why);
    drawFind();
}

// ── the bar ───────────────────────────────────────────────────────────────

function bindBar() {
    if (refs.add) refs.add.addEventListener('click', () => openAddMenu());
    if (refs.fit) refs.fit.addEventListener('click', () => { fitView(); apply(); });
    if (refs.zoomIn) refs.zoomIn.addEventListener('click', () => stepZoom(1.25));
    if (refs.zoomOut) refs.zoomOut.addEventListener('click', () => stepZoom(1 / 1.25));
    if (refs.relayout) refs.relayout.addEventListener('click', () => {
        for (const n of graph().nodes) graph().pin(n, null);
        framed = false;
        drawFind();
    });
}

function stepZoom(by) {
    const p = port();
    const mx = p.w / 2, my = p.h / 2;
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * by));
    const gx = (mx - panX) / zoom, gy = (my - panY) / zoom;
    zoom = next;
    panX = mx - gx * zoom;
    panY = my - gy * zoom;
    apply();
}

/// Fit the whole graph, up to 1:1. Zooming *in* to fill the window with three
/// cards is not a fit anybody wants — `ui/graph/view.js` has the same floor.
function fitView() {
    if (!placed || !placed.nodes.length) return;
    const p = port();
    if (!p.w || !p.h) return;
    const k = Math.min(1, Math.min((p.w - 40) / Math.max(1, placed.width),
                                   (p.h - 40) / Math.max(1, placed.height)));
    zoom = Math.max(ZOOM_MIN, k);
    panX = (p.w - placed.width * zoom) / 2 - placed.left * zoom;
    panY = (p.h - placed.height * zoom) / 2 - placed.top * zoom;
}

/// The menu of what can be placed, grouped by what it is for.
///
/// **Placed and then wired, rather than inserted onto a wire.** `Mix` and
/// `Every` take two stacks and there is no single wire either of them could be
/// spliced onto, which is `ui/graph/view.js`'s stated reason for having an `Add
/// node` at all — and here it is true of the two nodes the stage exists for.
function openAddMenu() {
    if (!refs.menu) return;
    const open = refs.menu.classList.contains('on');
    refs.menu.classList.toggle('on', !open);
    if (open) return;
    put(refs.menu, () => {
        const out = [];
        let group = '';
        for (const kind of N.KIND_ORDER) {
            if (N.GROUPS[kind] !== group) {
                group = N.GROUPS[kind];
                out.push(div('fn-menu-group', group));
            }
            out.push(el('button', {
                cls: 'fn-menu-item', text: N.KINDS[kind].title,
                on: { click: () => {
                    const node = graph().add(kind);
                    refs.menu.classList.remove('on');
                    chosen = node;
                    drawFind();
                } },
            }));
        }
        return out;
    });
}

/// Arriving on the stage. The layout measures elements, and every height it
/// needs reads zero while the stage is `display:none` — CLAUDE.md's standing
/// consequence of stage views never being unmounted — so the fit is deferred to
/// the first draw that happens with the stage up.
export function arriveFind() {
    framed = false;
    drawFind();
}
