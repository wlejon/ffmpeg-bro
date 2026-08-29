// The mix: one row of cards, in the order they play.
//
// ── Why this is not a timeline ────────────────────────────────────────────
//
// The workbench has a real one — tracks, a ruler, gaps, clips placed against
// each other in time — because compositing needs all of that. A supercut needs
// none of it. It is a **sequence**: one lane, no gaps, no overlaps, and the only
// thing that varies is what is in each piece and how long it is. So the cards
// are butted, a card's width *is* its length, and its left edge is its moment —
// which makes the strip its own ruler and means the playhead needs no second
// measurement to agree with it.
//
// One consequence is worth stating because it is the whole reason this file has
// arithmetic of its own: **in a packed sequence a clip's neighbour is always
// touching it**, and `ui/project.js`'s edits stop at a neighbour (`walls`). That
// is right on a timeline, where growing into the clip after you would put two
// pictures on one moment with nothing to say which is on top. Here it would mean
// no clip could ever be made longer. So `unwalled()` moves the neighbours out of
// reach, runs the real edit, and packs the result back up — the primitive keeps
// its own limits (the head of the file, one frame, the speed range) and the only
// rule this file adds is that the mix has no holes in it.
//
// ── Four gestures, four grab points, no modes ─────────────────────────────
//
// The workbench puts ripple, slip and rate behind a mode picker and Alt, which
// is right when the timeline has to serve every kind of edit. Here there are
// four things you can do to a piece and they each get somewhere to grab:
//
//   - the **grip** along the top — drag sideways to reorder
//   - either **edge** — drag to trim, and everything after closes up
//   - the **picture** — drag to slip: the card stays, the footage moves inside it
//   - the **rate badge** — drag to change speed, and the card grows or shrinks
//
// Nothing is modal, so nothing has to be remembered and nothing can be left
// switched on. A click on the picture that did not move is a click, and it puts
// the playhead there.

import {
    project, addClip, sortClips, removeClip, select, isSelected,
    trimClip, slipClip, setSpeed, speedOf, sourceSpan, duration, changed,
} from '../ui/project.js';
import { analyzeClip, frameAt, showing } from '../ui/analysis.js';
import { el, div, put } from '../ui/dom.js';
import { clock } from '../ui/format.js';

/// Far enough that no edit can reach a neighbour. Seconds — a clip cannot be
/// grown past its own file and no file is eleven days long.
const WAY = 1e6;

/// How far the pointer travels for one doubling of speed, in pixels. Slow enough
/// that 1.05× is reachable, fast enough that 4× is not a journey.
const RATE_PX = 170;

/// A press that moves less than this is a click, not a drag.
const SLOP = 3;

let nodes = null;
let hooks = {};
let pxPerSec = 120;
let drag = null;
/// Card elements by clip id, so a drag can move one without rebuilding the row
/// underneath the pointer — which would destroy the element the gesture is on.
const cards = new Map();

export function initMix(refs, h) {
    nodes = refs;
    hooks = h || {};
    nodes.zoom.addEventListener('input', () => {
        pxPerSec = Number(nodes.zoom.value) || 120;
        draw();
    });
    nodes.fit.addEventListener('click', () => { fit(); draw(); });
    nodes.clear.addEventListener('click', () => {
        for (const c of project.clips.slice()) removeClip(c);
        reflow();
        edited();
    });
    // The strip's own background is the rest of the ruler: clicking past the end
    // of the mix parks the playhead at the end rather than doing nothing.
    nodes.strip.addEventListener('mousedown', (e) => {
        if (e.target !== nodes.strip && e.target !== nodes.cards) return;
        hooks.seek(timeAt(e));
    });
    // On the document, not on the card: a hand dragging an edge leaves the card
    // within a few pixels and the gesture must not end when it does. The same
    // rule `ui/timeline.js` and `ui/graph/view.js` follow, and it is also what
    // lets a suite drive a drag by dispatching on `<body>`.
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ── the sequence ───────────────────────────────────────────────────────────

/// The clips in play order. The mix is one lane, so this is the whole model of
/// where anything is.
export function sequence() {
    return project.clips.filter((c) => c.track === 0)
                        .sort((a, b) => a.start - b.start);
}

/// Pack every clip end to end, in the order they are already in.
///
/// The one rule this file adds to the model, applied after every edit: a mix has
/// no holes and no overlaps, so a piece made shorter pulls the rest back and a
/// piece made longer pushes them along. That is "ripple" for a sequence, and it
/// is not a mode here because there is nothing else it could be.
export function reflow() {
    let at = 0;
    for (const c of sequence()) { c.start = at; at += c.length; }
    sortClips();
}

/// Run an edit with the neighbours out of reach, then pack the result.
///
/// See the header: the model's edits stop at a neighbour, and in a packed
/// sequence there is always one touching. Moving the clip a long way right and
/// everything after it twice as far leaves both walls unreachable while keeping
/// the order, so the primitive's *own* limits — the head of the file, the last
/// frame, one frame of length, the speed range — are the only ones that bite.
function unwalled(clip, edit) {
    const order = sequence();
    const i = order.indexOf(clip);
    if (i < 0) return;
    for (let k = 0; k < order.length; k++) {
        if (k === i) order[k].start += WAY;
        else if (k > i) order[k].start += 2 * WAY;
    }
    edit();
    reflow();
}

/// Put a found moment at the end of the mix.
///
/// Appending is the whole behaviour, because a list auditioned top to bottom is
/// a mix assembled in that order — and reordering is a drag away once it is
/// there.
export function append(clip, spec) {
    clip.track = 0;
    clip.inPoint = Math.max(0, spec.from || 0);
    clip.length = Math.max(1 / Math.max(1, clip.fps),
                           Math.min(spec.to - spec.from, clip.media - clip.inPoint));
    clip.start = duration();
    addClip(clip);
    reflow();
    analyzeClip(clip);
    select(clip, 'auto');
    return clip;
}

function edited() {
    changed('edit');
    if (hooks.edited) hooks.edited();
    draw();
}

// ── geometry ───────────────────────────────────────────────────────────────

/// Where the cards begin inside the strip, in pixels. The strip's own padding,
/// asked of the element rather than written down twice.
function pad() {
    return nodes.cards.offsetLeft;
}

export function xOf(t) { return pad() + t * pxPerSec; }

/// The moment under a pointer event, clamped to the mix.
export function timeAt(e) {
    const box = nodes.strip.getBoundingClientRect();
    const x = e.clientX - box.left + nodes.strip.scrollLeft - pad();
    return Math.max(0, Math.min(x / pxPerSec, duration()));
}

/// A zoom at which the whole mix is on the screen.
export function fit() {
    const total = duration();
    const room = nodes.strip.clientWidth - pad() * 2;
    if (!(total > 0) || !(room > 0)) return;
    pxPerSec = Math.max(10, Math.min(600, room / total));
    nodes.zoom.value = String(Math.round(pxPerSec));
}

export function zoom() { return pxPerSec; }

// ── gestures ───────────────────────────────────────────────────────────────

function onDown(e, clip, kind, edge) {
    e.preventDefault();
    e.stopPropagation();
    select(clip, 'pick');
    drag = {
        clip, kind, edge,
        x0: e.clientX,
        moved: false,
        // What the clip was before the gesture. Every move re-applies the edit
        // from *here* rather than accumulating, so a drag out and back leaves
        // the clip exactly as it was — an accumulating one drifts, because every
        // step is separately clamped.
        was: { inPoint: clip.inPoint, length: clip.length, speed: clip.speed },
        index: sequence().indexOf(clip),
    };
    // **Not a redraw.** Rebuilding the row on the press would destroy the very
    // element the gesture is on — the drag survives it, because the moves are
    // listened for on the document and the clip is held rather than the node,
    // but the press would be paying for a whole row to show one border.
    for (const [id, node] of cards)
        node.classList.toggle('sel', id === clip.id);
    const card = cards.get(clip.id);
    if (card && kind === 'reorder') card.classList.add('dragging');
}

function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < SLOP) return;
    drag.moved = true;
    const clip = drag.clip;
    const dt = dx / pxPerSec;

    // Back to where the gesture started, so this move is the whole edit.
    clip.inPoint = drag.was.inPoint;
    clip.length = drag.was.length;
    clip.speed = drag.was.speed;

    if (drag.kind === 'trim') {
        const edge = drag.edge;
        unwalled(clip, () => trimClip(
            clip, edge,
            edge === 'start' ? clip.start + dt : clip.start + drag.was.length + dt));
    } else if (drag.kind === 'slip') {
        // **Dragging right shows earlier footage** — the film moves under the
        // window rather than the window over the film, which is the sign every
        // editor uses. Scaled by the speed because the pointer distance is on
        // the timeline and the in-point is in the file's own seconds.
        slipClip(clip, -dt * speedOf(clip));
    } else if (drag.kind === 'rate') {
        // Geometric, so that the same drag either way is the same musical
        // interval: 170 px is twice as fast one way and half as fast the other.
        unwalled(clip, () => setSpeed(clip, drag.was.speed * Math.pow(2, dx / RATE_PX)));
    } else if (drag.kind === 'reorder') {
        reorderTo(clip, indexAt(e));
    }
    // Sizes only: rebuilding the row would destroy the element under the hand.
    resize();
    if (hooks.moved) hooks.moved();
}

function onUp() {
    if (!drag) return;
    const was = drag;
    drag = null;
    const card = cards.get(was.clip.id);
    if (card) card.classList.remove('dragging');
    if (!was.moved) {
        // A press that never moved is a click, and on the picture it means
        // "show me this moment" — the one thing a card is for that is not an
        // edit.
        if (was.kind === 'slip') hooks.seek(was.clickTime);
        draw();
        return;
    }
    edited();
}

/// Which slot the pointer is over, for a reorder.
///
/// Measured against the *midpoints* of the cards as they stand, which is what
/// makes a card swap places when its leading edge passes the middle of its
/// neighbour rather than when it fully clears it.
function indexAt(e) {
    const t = timeAt(e);
    const order = sequence();
    let at = 0;
    for (let i = 0; i < order.length; i++) {
        const mid = at + order[i].length / 2;
        if (t < mid) return i;
        at += order[i].length;
    }
    return order.length;
}

function reorderTo(clip, index) {
    const order = sequence();
    const from = order.indexOf(clip);
    const to = Math.max(0, Math.min(index, order.length - 1));
    if (from < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, clip);
    let at = 0;
    for (const c of order) { c.start = at; at += c.length; }
    sortClips();
}

/// Remove a piece and close the gap.
export function drop(clip) {
    removeClip(clip);
    reflow();
    edited();
}

// ── drawing ────────────────────────────────────────────────────────────────

/// Widths and readouts only, for a hand that is still moving.
///
/// **A card is repainted only when its width changed**, which under a drag is
/// one of them. The cards are butted and laid out by the flex row, so a trim
/// moves every card after it without any of them being redrawn — and painting a
/// canvas is a `drawImage` per thumbnail, which forty times a frame is the cost
/// this function exists to avoid.
function resize() {
    for (const c of sequence()) {
        const card = cards.get(c.id);
        if (!card) continue;
        const w = Math.max(1, c.length * pxPerSec);
        card.style.width = `${w}px`;
        card.classList.toggle('narrow', w < 92);
        const rate = card.querySelector('.rate');
        if (rate) {
            const s = speedOf(c);
            rate.textContent = `${s.toFixed(2)}×`;
            rate.classList.toggle('off', Math.abs(s - 1) > 1e-3);
        }
        const len = card.querySelector('.len');
        if (len) len.textContent = `${c.length.toFixed(2)}s`;
        const canvas = card.querySelector('canvas');
        // The in-point moves under a slip without the width changing, so the
        // painted span is what is compared rather than the width alone.
        const key = `${Math.round(w)}:${c.inPoint.toFixed(3)}:${c.speed}`;
        if (canvas && canvas.dataset.key !== key) {
            canvas.dataset.key = key;
            paint(c, canvas);
        }
    }
    if (hooks.resized) hooks.resized();
}

/// The whole row. Cheap — a card is six elements — and never called under a
/// moving hand.
export function draw() {
    if (!nodes) return;
    const order = sequence();
    cards.clear();
    put(nodes.cards, () => order.map((c) => cardFor(c)));
    resize();
    drawNote();
}

function cardFor(clip) {
    const canvas = el('canvas', { title: 'Slip' });
    canvas.addEventListener('mousedown', (e) => {
        onDown(e, clip, 'slip');
        // Remembered on the way down: if the press turns out to be a click, this
        // is where it was, and by then the pointer may have moved a pixel.
        if (drag) drag.clickTime = timeAt(e);
    });

    const card = div('card' + (isSelected(clip) ? ' sel' : ''), [
        el('div', { cls: 'grip', title: 'Reorder',
                    on: { mousedown: (e) => onDown(e, clip, 'reorder') } }),
        el('div', { cls: 'edge l', title: 'Trim',
                    on: { mousedown: (e) => onDown(e, clip, 'trim', 'start') } }),
        canvas,
        el('div', { cls: 'edge r', title: 'Trim',
                    on: { mousedown: (e) => onDown(e, clip, 'trim', 'end') } }),
        div('foot', [
            // Where in the recording this is, which is `inPoint` and not the
            // moment the finder matched: a slip and a trim both move it, and a
            // card showing where the *search* landed would go on saying so
            // after the footage under it had been moved somewhere else.
            el('span', { cls: 'when mono', text: clock(clip.inPoint) }),
            el('span', { cls: 'len mono', text: `${clip.length.toFixed(2)}s` }),
            el('span', { cls: 'spacer' }),
            el('button', { cls: 'rate', title: 'Speed',
                           on: { mousedown: (e) => onDown(e, clip, 'rate') } }),
            el('button', { cls: 'kill tiny', text: '✕', title: 'Remove',
                           on: { click: () => drop(clip) } }),
        ]),
    ]);
    cards.set(clip.id, card);
    return card;
}

/// What a piece looks and sounds like, in its own card.
///
/// The projection is the card's, not the timeline's: a card covers exactly one
/// clip's source span, so x maps to `inPoint + (x/w) * span` with no zoom, no
/// scroll and no clip boundaries in it. That is why the mapping is written here
/// rather than borrowed from `ui/timeline.js`, which answers a different
/// question (where is this clip in a view of the whole edit) with the same data.
function paint(clip, canvas) {
    if (!canvas) return;
    const w = Math.max(1, Math.round(clip.length * pxPerSec));
    const h = canvas.clientHeight || 90;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const span = sourceSpan(clip);
    const at = (x) => clip.inPoint + (x / w) * span;
    // Tell the reader what is on screen, so a clip on a link is read for the
    // span this card is showing rather than for all six hours of the file.
    showing(clip, clip.inPoint, clip.inPoint + span, w);

    // The picture, as a strip of frames at the card's own height. One thumbnail
    // per its own aspect, laid out from the card's left edge — the same shape
    // `ui/timeline.js` reads, since it is the same sheet the worker wrote.
    if (clip.film && clip.film.strips.length) {
        const { width: tw, height: th } = clip.film;
        const slot = Math.max(8, h * (tw / Math.max(1, th)));
        for (let x = 0; x < w; x += slot) {
            const f = frameAt(clip.film, at(x + slot / 2));
            if (!f) continue;
            const dw = Math.min(slot, w - x);
            try {
                ctx.drawImage(f.bitmap, f.i * tw, 0, Math.max(1, tw * (dw / slot)), th,
                              x, 0, dw, h);
            } catch (e) { /* a strip being replaced under us */ }
        }
    } else {
        ctx.fillStyle = '#2a2f38';
        ctx.fillRect(0, 0, w, h);
    }

    // The sound, over it. Not a mix and not a scale — one clip's own envelope,
    // which is the only thing a card can be asked about.
    const p = clip.peaks;
    if (p && p.buckets && p.duration) {
        ctx.fillStyle = 'rgba(74,158,255,.55)';
        const mid = h - 1;
        for (let x = 0; x < w; x++) {
            const b = Math.floor((at(x) / p.duration) * p.buckets);
            if (b < 0 || b >= p.buckets) continue;
            // **A bucket nobody has read is not a bucket that was quiet** — the
            // rule `ui/analysis.js` states — so an unread column is left blank
            // rather than drawn flat.
            if (p.have && !p.have[b]) continue;
            const a = Math.min(1, p.rms[b] * 3) * (h * 0.42);
            ctx.fillRect(x, mid - a, 1, a);
        }
    }
}

/// Redraw the card art without rebuilding the row — what a reading landing off
/// the analysis worker asks for.
export function repaint() {
    for (const c of sequence()) {
        const card = cards.get(c.id);
        if (!card) continue;
        const canvas = card.querySelector('canvas');
        if (!canvas) continue;
        // The span has not changed — the *reading of it* has — so `resize`'s
        // key would say there was nothing to do. Cleared rather than compared.
        delete canvas.dataset.key;
        paint(c, canvas);
    }
}

function drawNote() {
    if (!nodes.note) return;
    const n = sequence().length;
    const total = duration();
    nodes.note.textContent = n
        ? `${n} ${n === 1 ? 'clip' : 'clips'} · ${total.toFixed(2)}s`
        : '';
}

/// Where the playhead line goes, in strip pixels. Called every frame by the app,
/// which owns the clock.
export function placePlayhead(t) {
    if (!nodes || !nodes.playhead) return;
    nodes.playhead.style.left = `${xOf(t)}px`;
    nodes.playhead.hidden = !project.clips.length;
}

/// Bring the playhead into view, for a mix wider than the strip.
export function follow(t) {
    if (!nodes) return;
    const x = xOf(t);
    const view = nodes.strip.scrollLeft;
    const room = nodes.strip.clientWidth;
    if (x < view + 40) nodes.strip.scrollLeft = Math.max(0, x - 40);
    else if (x > view + room - 40) nodes.strip.scrollLeft = x - room + 40;
}
