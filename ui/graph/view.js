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

import { el } from '../dom.js';
import { buildSpec, previewSpec, specSources, range as exportRange } from '../export/spec.js';
import { derive } from './derive.js';
import { print } from './print.js';
import * as canvas from './canvas.js';
import * as cards from './card.js';
import { padTakes, streamWord } from './model.js';
import { padsOf as filterPads } from './filters.js';
import { inputs as documentInputs, streamKinds } from '../inputs.js';
import * as overlay from './overlay.js';
import * as panel from './panel.js';
import * as preview from './preview.js';
import {
    bindViewDrawContext, placedOf, lodOf, selectionOf, selectedWireOf, cardsFor,
    setSelectedWire, setWantDraw, isPending,
    selectWire, select, clearSelection, pickInside,
    drawGraph, tickGraph, paintScrub, dragScrub,
    fitView, apply, hover, refreshInsertPoints, paint,
    chaseGraph, currentGraph, measureTo, note,
} from './view-draw.js';

export {
    drawGraph, tickGraph, fitView, chaseGraph, currentGraph, measureTo,
};

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;

let refs = {};
/// What the application handed this stage. Held at module scope as well as
/// closed over by `initGraphView`, because a panel button pressed later needs
/// the same hooks a preview started at init does — and a second copy passed
/// down through `initPanel` would be two answers to "who owns the job slot".
let outer = {};
let zoom = 1;
let panX = 0;
let panY = 0;
let userMoved = false;  // ...unless you have panned or zoomed since
/// Which clips are drawn as one card, and which of those you have opened.
///
/// `foldChoice` is null until somebody presses the button, and after that it is
/// the answer — the same rule `userMoved` states about the framing, and for the
/// same reason: a stage that undid your press the next time the graph grew would
/// be a stage arguing with you. `openFolds` holds the ones opened individually;
/// it is cleared when the whole thing is folded again, because "collapse" that
/// left three clips open would not be one.
///
/// Session state and deliberately not in the overlay: which folds you have open
/// is where you are *looking*, like the pan and the zoom, and neither the
/// document nor the workspace has any business remembering it. `lastFold` is the
/// answer the last draw came to, which is what the toolbar reads.
let foldChoice = null;
const openFolds = new Set();
let lastFold = null;

let dragging = null;    // panning
let moving = null;      // dragging nodes
let resizing = null;    // dragging a card's corner
let marquee = null;     // rubber band
// Dragging the scrub bar of the node that is playing. Held while the hand is
// down so that the frame loop leaves the marker alone — the bar follows the
// pointer, and the picture is asked to move on the way down and on release, not
// on every pixel: a seek re-points which piece is wanted, and re-pointing that
// sixty times a second is sixty renders begun and abandoned.
let scrubbing = null;
/// A wire being drawn, from the socket it was started at to the pointer.
let wiring = null;
/// Set on the mouse-up that ends a drag and cleared by the click that follows
/// it, because a drag on the background finishes with one and "clicked the
/// background" means "select nothing".
let swallowClick = false;

const view = () => ({ zoom, panX, panY });

bindViewDrawContext({
    refs: () => refs, outer: () => outer, view,
    setView: (z, px, py) => { zoom = z; panX = px; panY = py; },
    port: () => port(), detail: () => detail(), inNode: (n) => inNode(n),
    place: (el, x, y) => place(el, x, y), applySearch: () => applySearch(),
    userMoved: () => userMoved, setUserMoved: (v) => { userMoved = v; },
    foldChoice: () => foldChoice, openFolds: () => openFolds,
    lastFold: () => lastFold, setLastFold: (v) => { lastFold = v; },
    scrubbing: () => scrubbing, wiring: () => wiring, marquee: () => marquee,
});

/// Walked by hand rather than with `closest()`: this engine's DOM is a subset, and
/// a selector match that silently answered nothing would make the whole background
/// draggable including the cards on it.
function inNode(node) {
    if (!node) return false;
    if (refs.nodes && refs.nodes.contains(node) && node !== refs.nodes) return true;
    for (let p = node; p && p !== refs.viewport; p = p.parentNode || p.parentElement) {
        if (p.classList && typeof p.classList.contains === 'function' && p.classList.contains('gn')) return true;
        if (p.getAttribute && (p.getAttribute('data-node') || p.getAttribute('data-key'))) return true;
    }
    return false;
}

function port() {
    return { w: refs.viewport ? refs.viewport.clientWidth : 0,
             h: refs.viewport ? refs.viewport.clientHeight : 0 };
}

function applySearch() {
    if (!refs.search || !refs.nodes) return;
    const term = refs.search.value.toLowerCase().trim();
    const cardEls = Array.from(refs.nodes.querySelectorAll('.gn'));
    if (!term) {
        for (const node of cardEls) node.classList.remove('gn-dimmed');
        return;
    }
    const placed = placedOf(), lastGraph = currentGraph();
    if (!placed || !lastGraph) return;

    let matchCount = 0, lastMatch = null;
    for (const b of placed.nodes) {
        const k = panel.keyOf(b.node);
        if (!k) continue;
        const els = cardsFor(k);
        if (!els || !els.length) continue;
        const n = (lastGraph && lastGraph.node(b.node.id)) || b.node;
        if (!n) continue;
        let text = (n.name || '').toLowerCase() + ' ' + (n.filter || '').toLowerCase() + ' ';
        if (n.clip && n.clip.name) text += n.clip.name.toLowerCase() + ' ';
        if (n.params) for (const key in n.params) text += String(n.params[key]).toLowerCase() + ' ';
        const matched = text.includes(term);
        for (const el of els) {
            el.classList.toggle('gn-dimmed', !matched);
            if (matched) { matchCount++; lastMatch = b; }
        }
    }
    if (matchCount === 1 && lastMatch) {
        const p = port();
        panX = p.w / 2 - (lastMatch.x + lastMatch.w / 2) * zoom;
        panY = p.h / 2 - (lastMatch.y + lastMatch.h / 2) * zoom;
        userMoved = true;
        apply();
    }
}

export function initGraphView(r, hooks = {}) {
    refs = r;
    outer = hooks;

    refs.search = r.search || document.getElementById('gr-search');
    if (refs.search) {
        refs.search.addEventListener('input', applySearch);
        refs.search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                refs.search.value = '';
                refs.search.blur();
                applySearch();
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key.toLowerCase() === 'f' && refs.viewport && refs.viewport.offsetWidth > 0) {
            if (refs.search) {
                refs.search.focus();
                e.preventDefault();
            }
        }
    });

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
        // An export and the A/B comparison are both more important than this,
        // and so is a measurement waiting for the slot — a preview started
        // ahead of one would be the queue never emptying.
        busy: () => (hooks.busy ? hooks.busy() : false) || isPending(),
        // **A picture arriving is not an edit, so it marks rather than draws.**
        // The same rule `ui/app.js` states about a waveform landing, and for the
        // same reason: several can land while one redraw is owed, and a redraw is
        // priced in the size of the graph. `tickGraph` draws it, once, on the
        // next frame.
        changed: () => { setWantDraw(true); },
    });

    cards.initCards({
        keyOf: panel.keyOf,
        onSelect: (key, add) => select(key, add),
        onDragStart: (key, e) => startMove(key, e),
        // One clip's run put back. Not a change to the graph and not an edit —
        // the derivation is the same either way — so it redraws and nothing
        // else hears about it.
        onOpenFold: (key) => { openFolds.add(key); foldChoice = true; drawGraph(); },
        onWireStart: (key, dir, port, stream, e) => startWire(key, dir, port, stream, e),
        onResizeStart: (key, width, e) => {
            resizing = { key, from: width, x: e.clientX, at: width };
            document.body.style.cursor = 'nwse-resize';
        },
        // Pressing on the bar moves the picture at once — a click is a jump —
        // and holding follows the pointer without moving it again until release.
        onScrubStart: (key, f) => {
            scrubbing = { key, at: f };
            preview.seekPlay(f);
            paintScrub(f);
        },
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
        // A filter picked out of the palette while a wire was in the air lands
        // where the wire was let go, and is joined to the pad it came from. The
        // panel knows which filter; only this knows where the pointer was.
        placed: (rec, pad) => placeFromPalette(rec, pad),
        // What the render is, for a source that is about to be placed. A
        // `testsrc` is 320x240 until it is told otherwise, and a graph whose
        // last pad is a different size from the render is refused — so the
        // answer the render already has is written in at the moment of placing
        // rather than left to be discovered at the end of one.
        canvas: () => {
            const s = buildSpec();
            return { width: s.width, height: s.height, fps: s.fps,
                     sampleRate: s.sampleRate };
        },
        measureTo: (node) => measureTo(node),
    });

    bindViewport();
    bindBar(hooks);
}

// ── pointer ────────────────────────────────────────────────────────────────

let activeContextMenu = null;

function dismissContextMenu() {
    if (activeContextMenu && activeContextMenu.parentNode) {
        activeContextMenu.parentNode.removeChild(activeContextMenu);
    }
    activeContextMenu = null;
}

function showContextMenu(e) {
    dismissContextMenu();
    const rect = refs.viewport.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left - panX) / zoom;
    const canvasY = (e.clientY - rect.top - panY) / zoom;
    const lastGraph = currentGraph();

    let targetNode = null;
    let p = e.target;
    while (p && p !== refs.viewport) {
        if (p.getAttribute && (p.getAttribute('data-key') || p.getAttribute('data-node'))) {
            const key = p.getAttribute('data-key') || p.getAttribute('data-node');
            targetNode = lastGraph ? (lastGraph.node(key) || lastGraph.byAnchor(key)) : null;
            if (targetNode) break;
        }
        p = p.parentNode || p.parentElement;
    }

    const items = [];
    if (targetNode) {
        const isDisabled = targetNode.params && String(targetNode.params.enable) === '0';
        items.push({
            label: isDisabled ? 'Enable' : 'Disable',
            action: () => {
                overlay.edit(targetNode, { params: { enable: isDisabled ? '' : '0' } });
                drawGraph();
            }
        });
        items.push({
            label: 'Delete',
            action: () => {
                if (!targetNode.derived) overlay.removeInsert(targetNode.id);
                else if (targetNode.anchor && overlay.isLocked(targetNode.anchor)) overlay.unlock(targetNode.anchor);
                drawGraph();
            }
        });
        const key = panel.keyOf(targetNode);
        const isPinned = !!overlay.pinOf(key);
        items.push({
            label: isPinned ? 'Unanchor' : 'Anchor',
            action: () => {
                if (isPinned) overlay.setPin(key, null, null);
                else overlay.setPin(key, Math.round(canvasX), Math.round(canvasY));
                drawGraph();
            }
        });
    } else {
        items.push({
            label: 'Add node here',
            action: () => { panel.openPad({ at: { x: canvasX, y: canvasY } }); }
        });
    }

    const menu = el('div', { cls: 'gr-ctx-menu' });
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    for (const item of items) {
        const row = el('div', { cls: 'gr-ctx-item', text: item.label, on: {
            click: (ev) => { ev.stopPropagation(); dismissContextMenu(); item.action(); }
        } });
        menu.appendChild(row);
    }
    document.body.appendChild(menu);
    activeContextMenu = menu;

    const onOutside = (ev) => {
        if (menu.contains(ev.target)) return;
        dismissContextMenu();
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onEsc, true);
    };
    const onEsc = (ev) => {
        if (ev.key === 'Escape') {
            dismissContextMenu();
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onEsc, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onEsc, true);
    }, 0);
}

function bindViewport() {
    refs.viewport.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e);
    });

    refs.viewport.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
            dragging = { x: e.clientX, y: e.clientY, panX, panY, moved: false };
            document.body.style.cursor = 'grabbing';
            e.preventDefault();
        } else if (e.button === 0 && !inNode(e.target)) {
            marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
                        add: e.ctrlKey || e.shiftKey };
            document.body.style.cursor = 'crosshair';
            e.preventDefault();
        }
    });

    refs.viewport.addEventListener('click', (e) => {
        if (document.activeElement && document.activeElement.blur && document.activeElement !== refs.viewport) {
            document.activeElement.blur();
        }
        if (inNode(e.target) || e.target === refs.mini || swallowClick) return;
        const rect = refs.viewport.getBoundingClientRect();
        const hit = canvas.wireAt(placedOf(), e.clientX - rect.left, e.clientY - rect.top, view());
        if (hit) return selectWire(hit);
        clearSelection();
    });

    document.addEventListener('mousemove', (e) => {
        if (wiring) return dragWire(e);
        if (scrubbing) return dragScrub(e);
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

    document.addEventListener('mouseup', (e) => {
        document.body.style.cursor = '';
        if (wiring) return endWire(e);
        if (scrubbing) {
            const at = scrubbing.at;
            scrubbing = null;
            preview.seekPlay(at);
            return;
        }
        if (dragging) { swallowClick = dragging.moved; dragging = null; }
        if (marquee) {
            const m = marquee;
            marquee = null;
            swallowClick = Math.abs(m.x1 - m.x0) + Math.abs(m.y1 - m.y0) > 4;
            pickInside(m);
            return;
        }
        if (moving) return endMove();
        if (!resizing) return;
        const done = resizing;
        resizing = null;
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
            const to = canvas.miniPan(refs.mini, placedOf(), view(), port(),
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
    // A filter with nowhere to be spliced. Dropped in the middle of what is on
    // screen rather than at the origin — a node that appears somewhere you are
    // not looking reads as nothing having happened — and pinned, because it was
    // put there and the layout has no opinion about a node nothing is wired to.
    if (refs.add)
        refs.add.addEventListener('click', () => {
            const p = port();
            panel.openPad({ at: { x: (p.w / 2 - panX) / zoom, y: (p.h / 2 - panY) / zoom } });
        });
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
    // Folding is a decision once you have made it, the way the framing is: until
    // then the stage decides by how much there is to draw, and afterwards it does
    // what you said. Opening every fold by hand and then adding a clip must not
    // fold them all again.
    if (refs.fold)
        refs.fold.addEventListener('click', () => {
            foldChoice = !foldingNow();
            if (foldChoice) openFolds.clear();
            drawGraph();
        });
}

export function setFold(choice) {
    foldChoice = choice;
    if (choice) openFolds.clear();
    drawGraph();
}

/// Whether the graph is folded as things stand — your press if you have made
/// one, and otherwise whether there is more here than anybody could read.
function foldingNow() {
    if (foldChoice !== null) return foldChoice;
    return !!lastFold && lastFold.folding;
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
    if (detail() !== lodOf()) drawGraph();
    else apply();
}

const detail = () => (zoom < cards.LOD_ZOOM ? 'min' : 'full');

// ── moving nodes ───────────────────────────────────────────────────────────

/// Dragging a header moves that node — and every other selected node with it,
/// which is what a multiple selection is for.
///
/// **Everything the drag will touch is gathered here, once.** A mouse move used
/// to find its card with `querySelector` over the whole container, scan every box
/// for the one with that key, and rebuild a map of every node to reflow every
/// wire — three passes over the whole graph per selected node per pixel. At 634
/// nodes that is most of a frame before anything is drawn. What a drag actually
/// changes is known the moment it starts: these boxes, their elements, and the
/// wires with an end on one of them.
function startMove(key, e) {
    const placed = placedOf();
    const selection = selectionOf();
    if (!key || !placed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.style.cursor = 'grabbing';
    if (!e.shiftKey && !e.ctrlKey) {
        if (selection.size > 1 || !selection.has(key)) select(key, false);
    } else {
        if (!selection.has(key)) select(key, true);
    }
    const parts = [];
    const ids = new Set();
    // **Cards and boxes are paired by their order, because a key can name more
    // than one of each.** Several inserts at one anchor share a key, and `byKey`
    // is filled by walking `placed.nodes` — this walk — so the n-th card of a key
    // is the n-th box of it. Taking the first card for every box would drag one
    // element to the last box's position and leave the others where they were.
    const nth = new Map();
    for (const box of placed.nodes) {
        const k = panel.keyOf(box.node);
        if (!k || !selection.has(k)) continue;
        const i = nth.get(k) || 0;
        nth.set(k, i + 1);
        parts.push({ key: k, el: cardsFor(k)[i] || null, box, x: box.x, y: box.y });
        ids.add(box.node.id);
    }
    const wires = placed.wires.filter((w) => ids.has(w.edge.from) || ids.has(w.edge.to));
    moving = { x: e.clientX, y: e.clientY, parts, wires, at: new Map(), moved: false };
}

/// Written straight to the elements, in graph coordinates — the container is
/// scaled, so a hundred pixels of mouse at 0.5× is two hundred pixels of card.
/// The wires follow because `placed` is updated with them; nothing is re-derived
/// and nothing is re-measured until the drag ends.
///
/// **A card is moved by its transform and never by `left`/`top`.** They put the
/// card in the same place and cost differently by an order of magnitude:
/// measured at 634 cards, writing `left`/`top` on *one* of them and then reading
/// any geometry costs 10.4 ms, because an offset is a layout property and
/// htmlayout answers by laying the whole container out again. The same move as a
/// transform is 0.8 ms — it cannot affect anything else on the screen, so nothing
/// else is asked. That is the whole difference between a drag at 58 fps and a
/// drag that keeps up with the mouse, and it is why `place()` writes the same
/// property: a drag is then a re-write of what is already there rather than a
/// second way of saying where a card is.
function dragMove(e) {
    const dx = (e.clientX - moving.x) / Math.max(0.1, zoom);
    const dy = (e.clientY - moving.y) / Math.max(0.1, zoom);
    if (Math.abs(dx) + Math.abs(dy) > 2) moving.moved = true;
    for (const p of moving.parts) {
        const x = Math.round(p.x + dx), y = Math.round(p.y + dy);
        moving.at.set(p.key, { x, y });
        p.box.x = x;
        p.box.y = y;
        if (p.el) place(p.el, x, y);
    }
    reflowWires(moving.wires);
    paint();
}

/// Where a card sits, as the one property that says so.
///
/// See `dragMove` for why this is a transform. `.gn` pins `left`/`top` at zero in
/// the stylesheet so that the translate is the whole of the answer and the two
/// cannot drift.
function place(el, x, y) {
    el.style.transform = `translate(${x}px, ${y}px)`;
}

/// The wire endpoints again, from boxes that have moved. The same arithmetic
/// `layout()` does, and the reason it is repeated rather than shared is that this
/// runs on a mouse move and `layout()` needs measured heights it cannot have
/// mid-drag.
///
/// `only` is the wires with an end on something that moved — everything else has
/// the endpoints it had. Given none, all of them are done, which is what a
/// wholesale change wants.
function reflowWires(only) {
    const placed = placedOf();
    const list = only || placed.wires;
    if (!list.length) return;
    const at = new Map(placed.nodes.map((b) => [b.node.id, b]));
    for (const w of list) {
        const a = at.get(w.edge.from), b = at.get(w.edge.to);
        if (!a || !b) continue;
        w.x1 = a.x + a.w;
        w.y1 = a.y + w.oy1;
        w.x2 = b.x;
        w.y2 = b.y + w.oy2;
    }
}

/// **A node let go of is a pin written down, and nothing else.** This used to end
/// with `drawGraph()`, which re-derived the model, threw away all 634 cards and
/// built them again, re-measured every one of them, laid the graph out and
/// reprinted the whole `-filter_complex` — 1875 ms, measured, at the end of every
/// drag. None of it can say anything new: a pin is overlay data, the derivation
/// cannot see it, and the layout it would produce is the one already on the
/// screen because the drag put it there. So the pin is recorded, the extent is
/// widened to take in wherever the card went, and the `+` on the wire under the
/// pointer is re-placed against the boxes as they now are.
function endMove() {
    const done = moving;
    moving = null;
    if (!done.moved) return;
    for (const [key, at] of done.at) overlay.setPin(key, at.x, at.y);
    growExtent(done.parts.map((p) => p.box));
    refreshInsertPoints();
    paint();
}

/// The drawn extent, widened by boxes that have moved.
///
/// `layout()` computes this from the columns and then takes in every pinned card,
/// because a card dragged out past the last column is still part of the picture
/// and a `Fit` that framed the columns would leave it off screen. The columns are
/// not re-derived here, so this only ever grows — the next derivation is what
/// tightens it again.
function growExtent(boxes) {
    const placed = placedOf();
    if (!placed) return;
    let { left, top } = placed;
    let right = placed.left + placed.width, bottom = placed.top + placed.height;
    for (const b of boxes) {
        left = Math.min(left, b.x);
        top = Math.min(top, b.y);
        right = Math.max(right, b.x + b.w);
        bottom = Math.max(bottom, b.y + b.h);
    }
    placed.left = left;
    placed.top = top;
    placed.width = right - left;
    placed.height = bottom - top;
}

// ── wiring by hand ─────────────────────────────────────────────────────────
//
// **Drag from a socket to a socket.** That is the gesture every node editor
// has, and until now this one had no way to make a connection at all — which is
// what confined the whole stage to filters that can be *spliced*, one in and one
// out. Everything with two inputs, everything with two outputs, and every filter
// whose pad count is a number you type was unreachable for want of this.
//
// Three rules, and each of them is what one of those editors does:
//
// - **Either end first.** Dragging from an input back to an output is the same
//   connection as the other way round, and insisting on a direction means half
//   the gestures people make silently do nothing.
// - **An input pad holds one wire.** Dropping on an occupied pad replaces what
//   was there, derived or not — which is how a filter gets *between* two derived
//   nodes without anybody deleting a wire first.
// - **Let go over nothing and you get the palette**, filtered to what can take
//   the pad you came from. Placing a node and wiring it are one gesture with a
//   pause in it, exactly as inserting a filter on a wire already is.

function startWire(key, dir, port, stream, e) {
    const placed = placedOf();
    if (!key || !placed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.style.cursor = 'crosshair';
    const box = placed.nodes.find((b) => panel.keyOf(b.node) === key);
    if (!box) return;
    wiring = { key, dir, port, stream, box,
               from: canvas.socketPoint(box, dir, port),
               ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, over: null };
    paint();
}

function canConnect(fromDir, fromStream, toDir, toStream) {
    const carried = fromDir === 'out' ? fromStream : toStream;
    const wanted = fromDir === 'in' ? fromStream : toStream;
    if (!carried || !wanted) return true;
    return padTakes(carried, wanted);
}

function dragWire(e) {
    wiring.x = e.clientX;
    wiring.y = e.clientY;
    const rect = refs.viewport.getBoundingClientRect();
    const hit = canvas.socketAt(placedOf(), e.clientX - rect.left, e.clientY - rect.top, view());
    const valid = hit && hit.dir !== wiring.dir && panel.keyOf(hit.node) !== wiring.key &&
                  canConnect(wiring.dir, wiring.stream, hit.dir, hit.stream);
    wiring.over = valid ? hit : null;
    paint();
}

function endWire(e) {
    document.body.style.cursor = '';
    const w = wiring;
    wiring = null;
    // A press and release on one socket is a click, not a drag. Nothing is a
    // sensible answer to it: a wire from a pad to itself is not a thing, and
    // opening the palette every time somebody prodded a dot would be worse.
    const moved = Math.abs(e.clientX - w.ox) + Math.abs(e.clientY - w.oy) > 2 || !!w.over;
    swallowClick = true;
    if (w.over) {
        const other = panel.keyOf(w.over.node);
        const out = w.dir === 'out' ? { key: w.key, port: w.port }
                                    : { key: other, port: w.over.port };
        const into = w.dir === 'in' ? { key: w.key, port: w.port }
                                    : { key: other, port: w.over.port };
        // What this wire carries, read off the *producing* end — the only end
        // that knows. A named output has no kind until something is wired into
        // it, and its own socket reports nothing until then, so taking the
        // stream from the pad the drag started at would leave an output dragged
        // *into* from its own socket permanently kindless.
        const stream = w.dir === 'out' ? (w.stream || w.over.stream)
                                       : (w.over.stream || w.stream);
        overlay.wire(out.key, out.port, into.key, into.port, stream);
        setSelectedWire(`${into.key}#${into.port}`);
        return drawGraph();
    }
    const rect = refs.viewport.getBoundingClientRect();
    const hit = canvas.socketAt(placedOf(), e.clientX - rect.left, e.clientY - rect.top, view());
    if (hit && hit.dir !== w.dir && panel.keyOf(hit.node) !== w.key) {
        if (!canConnect(w.dir, w.stream, hit.dir, hit.stream)) {
            const carried = w.dir === 'out' ? w.stream : hit.stream;
            const wanted = w.dir === 'in' ? w.stream : hit.stream;
            if (outer.flash)
                outer.flash(`Cannot connect ${streamWord(carried)} to a ${streamWord(wanted)} socket`);
            return paint();
        }
    }
    if (!moved || !refs.viewport) return paint();
    const at = { x: (e.clientX - rect.left - panX) / zoom, y: (e.clientY - rect.top - panY) / zoom };
    // Dropped on nothing: what can go here? The palette is filtered to filters
    // with a pad of the right stream on the opposite side, which is the same
    // honesty the insert palette has — it offers what can actually be attached
    // rather than everything and a failure afterwards.
    panel.openPad({ key: w.key, dir: w.dir, port: w.port, stream: w.stream, at });
    paint();
}

/// A filter chosen out of the palette while a wire was in the air.
///
/// It lands where the wire was let go — pinned, because you chose the place —
/// and is joined to the pad the drag came from by the first pad of its own that
/// can take it. Which pad that is comes from libavfilter: `overlay` fed from a
/// picture takes it on input 1, and guessing at the second would put the clip
/// underneath the canvas.
function placeFromPalette(rec, pad) {
    if (!rec || !pad) return;
    overlay.setPin(rec.id, Math.round(pad.at.x), Math.round(pad.at.y));
    // Placed from the bar rather than from a wire: there is nothing to join it
    // to, and inventing a connection for it would be inventing which of
    // `overlay`'s two inputs somebody meant.
    if (!pad.key) { select(rec.id, false); return drawGraph(); }
    // An input the graph reads is a file, not a filter: its pads are the streams
    // the probe found, and which of them a wire leaves by is the whole reason a
    // logo's picture does not arrive on a pad expecting sound.
    // An output of your own is one input pad and nothing else, and the pad takes
    // whatever the wire that made it brings — which is also how it learns
    // whether it is a picture or a sound.
    const pads = rec.kind === 'input'
        ? { ins: [], outs: streamKinds(documentInputs.find((i) => i.id === rec.input)) }
        : rec.kind === 'sink'
            ? { ins: [pad.stream || 'v'], outs: [] }
            : filterPads(rec.filter, rec.params, rec.pos);
    const want = pad.dir === 'out' ? (pads && pads.ins) : (pads && pads.outs);
    let port = 0;
    if (want && want.length) {
        const match = want.indexOf(pad.stream || 'v');
        port = match >= 0 ? match : 0;
    }
    if (pad.dir === 'out') overlay.wire(pad.key, pad.port, rec.id, port, pad.stream);
    else overlay.wire(rec.id, port, pad.key, pad.port, pad.stream);
    select(rec.id, false);
    drawGraph();
}

/// What was last laid out, for tests: where the cards ended up and where the
/// wires run, in graph coordinates, plus the view transform needed to turn either
/// into a screen position. Exposed because the alternative is a test that
/// hard-codes pixel positions of a layout it does not compute, and hovering a
/// wire is a gesture that has to be checkable.
export function graphPlacement() {
    const placed = placedOf();
    if (!placed) return null;
    return { nodes: placed.nodes, wires: placed.wires, zoom, panX, panY };
}

/// The keys this stage wants while it is up. Returns whether it took one, so
/// `app.js` can fall through to leaving the stage when it did not.
export function graphKey(e) {
    const selection = selectionOf();
    const selectedWire = selectedWireOf();
    if (e.key === '0') { fitView(); return true; }
    if (e.key === 'Escape' && (selection.size || selectedWire)) { clearSelection(); return true; }
    // A selected wire is what Delete is about, ahead of any node — you selected
    // it by clicking it, and the node selection was cleared when you did.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWire) {
        const at = selectedWire.split('#');
        // A derived wire is *cut*, not forgotten: the skeleton grows it back on
        // every rebuild, so the absence has to be written down. The two cases
        // are one call because from here they are one gesture.
        overlay.unwire(at[0], Number(at[1]) || 0);
        setSelectedWire(null);
        panel.selectWire(null);
        drawGraph();
        return true;
    }
    const lastGraph = currentGraph();
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
        problems: d.problems,
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
