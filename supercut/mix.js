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
//
// ── The strip is a window onto the mix, and it owns it ────────────────────
//
// A mix trimmed to the frame is metres wide — at 600 px/s a two-minute supercut
// is seventy thousand pixels — so most of it is off the screen most of the time
// and the position of the window is a thing this file has to hold. It is held
// here, in **seconds**, and not on the element as a scroll offset. Two reasons,
// and the second would still stand if the first went away:
//
//   - This engine has no horizontal scrolling. `Element.scrollLeft` is a getter
//     fixed at zero and a setter that does nothing (bro's `element_bindings.cpp`
//     says so by name, and `layout_node_adapter.h` returns 0 for the layout's
//     own read), so `overflow-x: auto` clips and nothing more. Every
//     `strip.scrollLeft = ...` this file used to write did nothing and every one
//     it read was a zero — which is why the mix could be zoomed and never
//     scrolled, and why zooming about the pointer held nothing still.
//   - Where the window is, is a fact about the *view of the edit* rather than
//     about a box of pixels. It is in seconds, `showing()` is told a span in
//     seconds, and the playhead is placed out of it. `ui/timeline.js` next door
//     owns its `view` for exactly that reason and draws its own bar under it;
//     this is the same decision, one lane wide.
//
// So `left` is the moment at the strip's left edge, `setLeft` is the only writer
// of it, and the row is put where that says by a negative margin — which leaves
// the cards in normal flow with their flex widths intact, and `#strip` clips both
// axes, so what is outside the window is off the screen.

import {
    project, addClip, sortClips, removeClip, select, isSelected,
    trimClip, slipClip, setSpeed, speedOf, sourceSpan, duration, changed,
} from '../ui/project.js';
import { analyzeClip, frameAt, showing } from '../ui/analysis.js';
import { transport } from '../ui/transport.js';
import { el, div, put } from '../ui/dom.js';
import { clock } from '../ui/format.js';
import * as cuts from './cuts.js';

/// Far enough that no edit can reach a neighbour. Seconds — a clip cannot be
/// grown past its own file and no file is eleven days long.
const WAY = 1e6;

/// How far the pointer travels for one doubling of speed, in pixels. Slow enough
/// that 1.05× is reachable, fast enough that 4× is not a journey.
const RATE_PX = 170;

/// A press that moves less than this is a click, not a drag.
const SLOP = 3;

/// How near the playhead a trim has to come to be taken by it, in pixels.
///
/// **On the screen rather than in seconds**, so the magnet is the same size of
/// gesture at every zoom — which is the whole reason to have one. At 600 px/s a
/// frame is ten pixels and the thing being aimed at is a line two wide.
const MAGNET_PX = 9;

let nodes = null;
let hooks = {};
let pxPerSec = 120;
let drag = null;
/// A press on the scroll bar: where the hand went down and where the view was.
let bar = null;
/// The moment at the strip's left edge, in seconds — see the header. Written by
/// `setLeft` and by nothing else.
let left = 0;
/// Card elements by clip id, so a drag can move one without rebuilding the row
/// underneath the pointer — which would destroy the element the gesture is on.
const cards = new Map();

export function initMix(refs, h) {
    nodes = refs;
    hooks = h || {};
    nodes.zoom.addEventListener('input', () => {
        setZoom(Number(nodes.zoom.value) || 120);
        draw();
    });
    nodes.fit.addEventListener('click', () => { fit(); draw(); });
    // **The wheel zooms, and it zooms about the pointer.** Trimming to a frame
    // means about a hundred pixels a second on the strip and the whole mix is
    // then metres wide, so getting close to a cut has to be one gesture rather
    // than a zoom and then a pan. Holding the moment under the pointer still is
    // what makes it one: you point at the edge you care about and turn. The bar
    // below is for the other journey — somewhere else entirely, at this zoom.
    nodes.strip.addEventListener('wheel', (e) => {
        const box = nodes.strip.getBoundingClientRect();
        const held = timeAt(e);
        const off = e.clientX - box.left;
        setZoom(pxPerSec * (e.deltaY < 0 ? 1.25 : 1 / 1.25));
        // The moment that was under the pointer, put back under the pointer.
        setLeft(held - off / pxPerSec);
        draw();
        e.preventDefault();
    });
    // The bar under the strip pans it. A press on the thumb takes it with the
    // hand; a press on the track puts the window where it was pressed and then
    // takes it with the hand too, so overshooting the jump is a correction
    // rather than a second press.
    if (nodes.scroll) nodes.scroll.addEventListener('mousedown', (e) => {
        const track = nodes.scroll.getBoundingClientRect();
        const thumb = nodes.thumb.getBoundingClientRect();
        if (e.clientX < thumb.left || e.clientX > thumb.right)
            setLeft(((e.clientX - track.left) / Math.max(1, track.width)) * duration()
                    - viewSpan() / 2);
        bar = { grab: e.clientX, was: left };
        e.preventDefault();
    });
    nodes.clear.addEventListener('click', () => {
        for (const c of project.clips.slice()) { cuts.forget(c.id); removeClip(c); }
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
///
/// **The edit is handed how far the clip was moved**, because a trim is given a
/// moment and that moment is on the timeline the hand is pointing at rather than
/// on the one the clip is briefly standing in. Handed over rather than read off
/// `clip.start` inside the closure, which is the same number arrived at by
/// knowing what this function did to it.
function unwalled(clip, edit) {
    const order = sequence();
    const i = order.indexOf(clip);
    if (i < 0) return;
    for (let k = 0; k < order.length; k++) {
        if (k === i) order[k].start += WAY;
        else if (k > i) order[k].start += 2 * WAY;
    }
    edit(WAY);
    reflow();
}

/// The moment a trim asked for, or the playhead when it came near enough.
///
/// **Only the two trim edges ask.** A slip moves footage inside a card whose
/// length is not changing and a speed drag is not a position at all, so a magnet
/// on either would be the mix quietly altering something the hand was not on.
/// Nothing snaps to a neighbour either, because in a packed sequence every
/// neighbour is already touching and there is nothing to close up to.
///
/// What is snapped is where the *hand* is, which for the end edge is also where
/// the card's edge is and for the start edge is where the cut lands — the head
/// closes up behind a trim, so the left edge of a card never moves and the
/// pointer is the only thing on the screen that does.
function magnetTo(t) {
    return Math.abs(xOf(t) - xOf(transport.t)) <= MAGNET_PX ? transport.t : t;
}

/// Put a found moment at the end of the mix.
///
/// Appending is the whole behaviour, because a list auditioned top to bottom is
/// a mix assembled in that order — and reordering is a drag away once it is
/// there.
export function append(clip, spec) {
    clip.track = 0;
    clip.inPoint = Math.max(0, spec.from || 0);
    const rest = clip.media - clip.inPoint;
    // **No end named is the whole of what is left**, which is a file opened
    // rather than a moment found — `doOpen` in app.js passes a bare path with no
    // span. Read as a span it is a span of nothing, and what went into the mix
    // was a single frame of the file somebody had just opened.
    const span = (spec.to || 0) > (spec.from || 0) ? spec.to - spec.from : rest;
    clip.length = Math.max(1 / Math.max(1, clip.fps), Math.min(span, rest));
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

/// Where a moment is on the strip, in pixels from the strip's left edge.
///
/// **The strip has no horizontal padding**, which is what makes this two terms
/// rather than three: x zero is the moment `left`, so a card's left edge is its
/// moment and the playhead needs no second measurement to agree with it. A pad
/// would be dead space the scroll arithmetic had to carry at every zoom.
export function xOf(t) { return (t - left) * pxPerSec; }

/// The moment under a pointer event, clamped to the mix.
export function timeAt(e) {
    const box = nodes.strip.getBoundingClientRect();
    return Math.max(0, Math.min(left + (e.clientX - box.left) / pxPerSec, duration()));
}

/// How much of the mix is on the strip, in seconds.
export function viewSpan() {
    return nodes.strip.clientWidth / pxPerSec;
}

/// The furthest the window can go: the end of the mix at the strip's right edge,
/// or nowhere at all when the whole thing fits.
function maxLeft() {
    return Math.max(0, duration() - viewSpan());
}

/// Move the window, and put the row and the bar where the number says.
///
/// **The one writer of `left`**, so the offset the cards are drawn at and the
/// offset `xOf` measures from cannot come apart — which is exactly what a second
/// place setting a margin beside it would be.
export function setLeft(v) {
    if (!nodes) return;
    left = Math.max(0, Math.min(Number(v) || 0, maxLeft()));
    nodes.cards.style.marginLeft = `${(-left * pxPerSec).toFixed(2)}px`;
    drawScroll();
}

/// Where the window is, in seconds. For the suites and for `follow`.
export function view() { return { left, span: viewSpan() }; }

/// The range the strip can be scaled over, in pixels per second.
///
/// The top end is what "fine tune an edge" needs: at 1200 px/s a pixel is 0.8 ms
/// and a frame of 60 fps footage is twenty pixels wide, so a trim is a gesture
/// rather than an aim. The bottom is a six-hour recording dropped in whole,
/// which at 2 px/s is a card forty-eight thousand pixels wide and still
/// scrollable.
const ZOOM_MIN = 2;
const ZOOM_MAX = 1200;

/// The one place the scale is written, so the slider, the wheel and Fit cannot
/// come to disagree about the range or about what the readout says.
function setZoom(v) {
    pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
    if (nodes.zoom) nodes.zoom.value = String(Math.round(pxPerSec));
    // The row's offset is in pixels and the window's position is in seconds, so
    // a change of scale moves one and not the other until it is re-applied —
    // and the range the window may sit in has changed with it.
    setLeft(left);
    return pxPerSec;
}

/// A zoom at which the whole mix is on the screen.
export function fit() {
    const total = duration();
    const room = nodes.strip.clientWidth;
    if (!(total > 0) || !(room > 0)) return;
    setZoom(room / total);
    setLeft(0);
}

/// Closer in, or further out, about the playhead — what `+` and `-` do.
export function nudgeZoom(dir, t) {
    const room = nodes.strip.clientWidth;
    const off = xOf(t);
    setZoom(pxPerSec * (dir > 0 ? 1.4 : 1 / 1.4));
    // Keep the playhead where it was on the screen, unless it was off it, in
    // which case put it in the middle — zooming towards something you cannot
    // see is how a strip ends up scrolled to nowhere.
    const keep = off > 0 && off < room ? off : room / 2;
    setLeft(t - keep / pxPerSec);
    draw();
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
    if (bar) {
        // A hand on the bar moves the window in proportion to the whole mix,
        // which is what makes the thumb stay under it.
        const track = nodes.scroll.getBoundingClientRect();
        setLeft(bar.was + ((e.clientX - bar.grab) / Math.max(1, track.width)) * duration());
        return;
    }
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
        // On the timeline the hand is pointing at, before `unwalled` moves the
        // clip off it — which is the frame the playhead is in, and therefore the
        // only one the magnet can be asked in.
        const from = edge === 'start' ? clip.start : clip.start + drag.was.length;
        const want = magnetTo(from + dt);
        snapped(want !== from + dt);
        unwalled(clip, (by) => trimClip(clip, edge, want + by));
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
    if (bar) { bar = null; return; }
    if (!drag) return;
    const was = drag;
    drag = null;
    snapped(false);
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
    // **Before the clip goes**, because a cut still being copied has a fetch to
    // stop: a card removed while its copy ran would go on writing a file nothing
    // was ever going to point at.
    cuts.forget(clip.id);
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
    // The mix got longer or shorter under the hand, which is what the thumb is a
    // measurement of — and a trim past the right-hand edge can leave the window
    // beyond the end of what is left, so the clamp is re-applied here too.
    setLeft(left);
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

    // The copy this clip is waiting for, when there is one — see `cuts.js`. A
    // bar rather than a word, because what it is saying is *how far*, and it is
    // inside the card because the thing being waited for is this clip and not
    // the mix.
    const bar = div('cutbar', [div('fill')]);

    const card = div('card' + (isSelected(clip) ? ' sel' : ''), [
        el('div', { cls: 'grip', title: 'Reorder',
                    on: { mousedown: (e) => onDown(e, clip, 'reorder') } }),
        el('div', { cls: 'edge l', title: 'Trim',
                    on: { mousedown: (e) => onDown(e, clip, 'trim', 'start') } }),
        canvas,
        bar,
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
    markCut(clip, card);
    return card;
}

/// Say on one card what its cut is doing.
///
/// Written onto the element that is already there rather than through a rebuild,
/// which is the whole reason this is separate from `draw()`: a copy advances on
/// every frame and the row must not be destroyed under a hand that is dragging
/// part of it.
function markCut(clip, card) {
    if (!card) return;
    const state = cuts.stateOf(clip.id);
    const busy = state === 'cutting' || state === 'copied' || state === 'opening' ||
                 state === 'proxying';
    card.classList.toggle('cutting', busy);
    card.classList.toggle('cutbad', state === 'failed');
    const fill = card.querySelector('.cutbar .fill');
    if (fill) {
        // An opening probe has no progress of its own and is the short half of
        // the wait, so it reads as a full bar rather than as a stalled one.
        const at = (state === 'opening' || state === 'copied')
            ? 1 : cuts.progressOf(clip.id);
        fill.style.width = `${Math.round(Math.max(0, Math.min(1, at)) * 100)}%`;
    }
    const err = cuts.errorOf(clip.id);
    if (err) card.title = err;
    else if (card.title) card.removeAttribute('title');
}

/// The same, for every card there is. From the frame loop while anything is
/// being cut; costs nothing on the frames when nothing is.
export function markCuts() {
    for (const clip of sequence()) markCut(clip, cards.get(clip.id));
    drawNote();
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

    // **The picture gets a band and the sound gets the rest**, rather than the
    // sound being drawn faintly over the bottom of the picture. This is a tool
    // for cutting *speech*: what you trim against is where the words start and
    // stop, and that is a thing you read off an envelope. The picture is here to
    // say which moment this is, which one frame does as well as ten — so it is
    // capped, and every pixel the card grows goes to the waveform.
    const film = clip.width ? Math.min(88, Math.round(h * 0.4)) : 0;
    const wave = h - film;

    if (film) {
        if (clip.film && clip.film.strips.length) {
            // One thumbnail per its own aspect, laid out from the card's left
            // edge — the same sheet `ui/timeline.js` reads, since it is the one
            // the worker wrote.
            const { width: tw, height: th } = clip.film;
            const slot = Math.max(8, film * (tw / Math.max(1, th)));
            for (let x = 0; x < w; x += slot) {
                const f = frameAt(clip.film, at(x + slot / 2));
                if (!f) continue;
                const dw = Math.min(slot, w - x);
                try {
                    ctx.drawImage(f.bitmap, f.i * tw, 0, Math.max(1, tw * (dw / slot)), th,
                                  x, 0, dw, film);
                } catch (e) { /* a strip being replaced under us */ }
            }
        } else {
            ctx.fillStyle = '#2a2f38';
            ctx.fillRect(0, 0, w, film);
        }
    }

    // The sound: one clip's own envelope, on its own ground. Not a mix and not a
    // scale — those are questions about a whole edit and this is a card.
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, film, w, wave);
    const mid = film + wave / 2;
    ctx.fillStyle = '#242a33';
    ctx.fillRect(0, Math.round(mid), w, 1);

    const p = clip.peaks;
    if (p && p.buckets && p.duration) {
        const half = wave / 2 - 1;
        for (let x = 0; x < w; x++) {
            const b = Math.floor((at(x) / p.duration) * p.buckets);
            if (b < 0 || b >= p.buckets) continue;
            // **A bucket nobody has read is not a bucket that was quiet** — the
            // rule `ui/analysis.js` states — so an unread column is left blank
            // rather than drawn flat, which would claim the recording went
            // silent where in fact nothing has looked.
            if (p.have && !p.have[b]) continue;
            // The envelope behind, the rms in front: the outline is what the
            // waveform *is*, and the body is where the energy actually is, which
            // is what tells a word from a click at the same peak.
            const lo = Math.max(-1, p.min[b]) * half;
            const hi = Math.min(1, p.max[b]) * half;
            ctx.fillStyle = 'rgba(74,158,255,.40)';
            ctx.fillRect(x, mid + lo, 1, Math.max(1, hi - lo));
            const r = Math.min(1, p.rms[b]) * half;
            ctx.fillStyle = 'rgba(120,190,255,.85)';
            ctx.fillRect(x, mid - r, 1, Math.max(1, r * 2));
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
    // What is still being made is said here as well as on the cards, because
    // somebody who has just pressed `+` twelve times is looking at the row
    // rather than at any one card in it. "Preparing" and not "cutting": there
    // are two stages behind it now — the copy out of the recording and the proxy
    // that makes the piece scrubbable — and a clip is usable through both.
    const busy = cuts.pending();
    nodes.note.textContent = n
        ? `${n} ${n === 1 ? 'clip' : 'clips'} · ${total.toFixed(2)}s` +
          (busy ? ` · preparing ${busy}` : '')
        : '';
}

/// Where the playhead line goes, in strip pixels. Called every frame by the app,
/// which owns the clock.
export function placePlayhead(t) {
    if (!nodes || !nodes.playhead) return;
    nodes.playhead.style.left = `${xOf(t).toFixed(1)}px`;
    nodes.playhead.hidden = !project.clips.length;
}

/// Say on the playhead that it has taken the edge being dragged.
///
/// **The signal is on the thing doing the taking**, not on the card and not in a
/// word anywhere: a magnet that fires invisibly is an edit somebody did not ask
/// for, and one that announces itself in prose is a sentence to read in the
/// middle of a gesture. The line thickens and brightens; nothing else moves.
function snapped(on) {
    if (nodes && nodes.playhead) nodes.playhead.classList.toggle('magnet', !!on);
}

/// How much of the mix is on the strip, and where — drawn as the one control
/// that can move the window a long way in one gesture.
///
/// **Hidden rather than removed** when the whole mix fits: `display: none` would
/// give the strip nine more pixels of height, and the cards are as tall as the
/// strip, so every canvas in the row would be repainted at a new height each time
/// a clip was added or trimmed past the edge of the window.
function drawScroll() {
    if (!nodes.thumb) return;
    const total = duration();
    const f = total > 0 ? Math.min(1, viewSpan() / total) : 1;
    nodes.thumb.style.width = `${(f * 100).toFixed(3)}%`;
    nodes.thumb.style.left = `${total > 0 ? ((left / total) * 100).toFixed(3) : '0'}%`;
    nodes.scroll.style.visibility = f >= 0.999 ? 'hidden' : 'visible';
}

/// Bring the playhead into view, for a mix wider than the strip.
export function follow(t) {
    if (!nodes) return;
    const edge = Math.min(40, nodes.strip.clientWidth / 4) / pxPerSec;
    if (t < left + edge) setLeft(t - edge);
    else if (t > left + viewSpan() - edge) setLeft(t - viewSpan() + edge);
}
