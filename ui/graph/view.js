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

import { el, span, put } from '../dom.js';
import { clock } from '../format.js';
import { buildSpec, previewSpec, specSources, range as exportRange } from '../export/spec.js';
import { parseEnable, isOnAt } from './enable.js';
import { derive } from './derive.js';
import { print } from './print.js';
import { layout, NODE_W } from './layout.js';
import * as canvas from './canvas.js';
import * as cards from './card.js';
import { padTakes, streamWord } from './model.js';
import { padsOf as filterPads } from './filters.js';
import { inputs as documentInputs, streamKinds } from '../inputs.js';
import * as overlay from './overlay.js';
import * as panel from './panel.js';
import * as preview from './preview.js';
import { measureGraph } from './subgraph.js';
import { fold, FOLD_OVER } from './fold.js';
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
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;

let refs = {};
/// What the application handed this stage. Held at module scope as well as
/// closed over by `initGraphView`, because a panel button pressed later needs
/// the same hooks a preview started at init does — and a second copy passed
/// down through `initPanel` would be two answers to "who owns the job slot".
let outer = {};
/// A measurement waiting for the one job slot — `{ cut, until }`. See
/// `runPending`.
let pending = null;
/// How long it waits. A node preview is a second at most and there are seldom
/// more than a couple left when somebody presses the button; past this the
/// honest thing is to say the slot is busy rather than to keep a promise
/// nothing is watching.
const WAIT_MS = 5000;
let zoom = 1;
let panX = 0;
let panY = 0;
let placed = null;      // the last layout(), for repainting on a pan
let lastGraph = null;   // ...and the graph it was of, for the keyboard
/// The cards this redraw built, by key — see the loop in `drawGraph` that fills
/// it. A list per key because several nodes can share an anchor. Rebuilt with
/// them, so it cannot outlive the elements it names.
const byKey = new Map();
const cardsFor = (key) => byKey.get(key) || [];
/// A redraw owed to something that was not an edit, drawn by `tickGraph`.
let wantDraw = false;
let shape = '';         // what the graph looked like, so a fit happens once per shape
let bounds = '';        // and how big it came out, so a card that grew is framed
let userMoved = false;  // ...unless you have panned or zoomed since
let canvasSize = '';
let lod = 'full';
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
// Dragging the scrub bar of the node that is playing. Held while the hand is
// down so that the frame loop leaves the marker alone — the bar follows the
// pointer, and the picture is asked to move on the way down and on release, not
// on every pixel: a seek re-points which piece is wanted, and re-pointing that
// sixty times a second is sixty renders begun and abandoned.
let scrubbing = null;
/// A wire being drawn, from the socket it was started at to the pointer.
let wiring = null;
/// The wire that is selected, by the pad it *arrives* at — `key#port`.
///
/// By its arriving end because that is the only end that identifies it: an input
/// pad holds exactly one wire, so "the wire at `composite/overlay:7` input 1" is
/// a name that survives a rebuild, and the wire object it currently refers to
/// does not survive anything.
let selectedWire = null;
/// Set on the mouse-up that ends a drag and cleared by the click that follows
/// it, because a drag on the background finishes with one and "clicked the
/// background" means "select nothing".
let swallowClick = false;

const view = () => ({ zoom, panX, panY });

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
    const cards = Array.from(refs.nodes.querySelectorAll('.gn'));
    
    if (!term) {
        for (const node of cards) node.classList.remove('gn-dimmed');
        return;
    }

    if (!placed || !lastGraph) return;

    let matchCount = 0;
    let lastMatch = null;

    for (const b of placed.nodes) {
        const k = panel.keyOf(b.node);
        if (!k) continue;
        const els = cardsFor(k);
        if (!els || !els.length) continue;
        
        const n = (lastGraph && lastGraph.node(b.node.id)) || b.node;
        if (!n) continue;

        let text = (n.name || '').toLowerCase() + ' ';
        text += (n.filter || '').toLowerCase() + ' ';
        if (n.clip && n.clip.name) text += n.clip.name.toLowerCase() + ' ';
        if (n.params) {
            for (const key in n.params) {
                text += String(n.params[key]).toLowerCase() + ' ';
            }
        }
        
        const matched = text.includes(term);
        for (const el of els) {
            el.classList.toggle('gn-dimmed', !matched);
            if (matched) {
                matchCount++;
                lastMatch = b;
            }
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
        busy: () => (hooks.busy ? hooks.busy() : false) || !!pending,
        // **A picture arriving is not an edit, so it marks rather than draws.**
        // The same rule `ui/app.js` states about a waveform landing, and for the
        // same reason: several can land while one redraw is owed, and a redraw is
        // priced in the size of the graph. `tickGraph` draws it, once, on the
        // next frame.
        changed: () => { wantDraw = true; },
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
                if (!targetNode.derived) {
                    overlay.removeInsert(targetNode.id);
                } else if (targetNode.anchor && overlay.isLocked(targetNode.anchor)) {
                    overlay.unlock(targetNode.anchor);
                }
                drawGraph();
            }
        });

        const key = panel.keyOf(targetNode);
        const isPinned = !!overlay.pinOf(key);
        items.push({
            label: isPinned ? 'Unanchor' : 'Anchor',
            action: () => {
                if (isPinned) {
                    overlay.setPin(key, null, null);
                } else {
                    overlay.setPin(key, Math.round(canvasX), Math.round(canvasY));
                }
                drawGraph();
            }
        });
    } else {
        items.push({
            label: 'Add node here',
            action: () => {
                panel.openPad({ at: { x: canvasX, y: canvasY } });
            }
        });
    }

    const menu = el('div', { cls: 'gr-ctx-menu' });
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    for (const item of items) {
        const row = el('div', { cls: 'gr-ctx-item', text: item.label, on: {
            click: (ev) => {
                ev.stopPropagation();
                dismissContextMenu();
                item.action();
            }
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
        const hit = canvas.wireAt(placed, e.clientX - rect.left, e.clientY - rect.top, view());
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
    if (detail() !== lod) drawGraph();
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
    const hit = canvas.socketAt(placed, e.clientX - rect.left, e.clientY - rect.top, view());
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
        selectedWire = `${into.key}#${into.port}`;
        return drawGraph();
    }
    const rect = refs.viewport.getBoundingClientRect();
    const hit = canvas.socketAt(placed, e.clientX - rect.left, e.clientY - rect.top, view());
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

// ── selection ──────────────────────────────────────────────────────────────

/// A wire, held by the pad it arrives at. See `selectedWire`.
function selectWire(w) {
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

function select(key, add) {
    if (!key) return clearSelection();
    if (!add) selection.clear();
    selection.add(key);
    primary = key;
    selectedWire = null;
    panel.selectNode(key, selection.size);
    markSelection();
    paint();
}

function clearSelection() {
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
    if (e.key === 'Escape' && (selection.size || selectedWire)) { clearSelection(); return true; }
    // A selected wire is what Delete is about, ahead of any node — you selected
    // it by clicking it, and the node selection was cleared when you did.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWire) {
        const at = selectedWire.split('#');
        // A derived wire is *cut*, not forgotten: the skeleton grows it back on
        // every rebuild, so the absence has to be written down. The two cases
        // are one call because from here they are one gesture.
        overlay.unwire(at[0], Number(at[1]) || 0);
        selectedWire = null;
        panel.selectWire(null);
        drawGraph();
        return true;
    }
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
    // The first problem about each node, by id rather than by key: two nodes can
    // share an anchor — several inserts at one point do — and the complaint
    // belongs to the one it is about.
    const trouble = new Map();
    for (const p of d.problems) if (p.id && !trouble.has(p.id)) trouble.set(p.id, p);

    // A clip's derived run as one card, folded by default per clip into one card
    // unless explicitly opened/expanded by the user. User nodes (derived: false) never fold.
    const folding = foldChoice === null ? true : foldChoice;
    lastFold = fold(d.graph, { open: openFolds, trouble, points: d.points,
                               enabled: folding });
    lastFold.folding = folding;
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
        place(node, box.x, box.y);
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
    // The points as well as the graph: an insert point somebody has open is
    // re-resolved against the derivation that has just run, rather than being
    // held from the one that declared it.
    panel.draw(d.graph, d.problems, d.points);
    markSelection();
    cards.restoreFocus(refs.nodes);
    syncPreviews();
    if (refs.search && refs.search.value) applySearch();
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
    const { w, h } = port();
    if (w <= 0 || h <= 0) return false;
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
    if (!scrubbing) {
        const span = Math.max(1e-6, st.until - st.from);
        paintScrub((st.at - st.from) / span, (st.ready - st.from) / span);
    }
}

/// Both marks on the scrub bar, as fractions of the range.
///
/// `ahead` is left as it was when it is not given, which is what a drag wants:
/// how far the pieces reach has not changed because a pointer moved.
function paintScrub(at, ahead) {
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
function dragScrub(e) {
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
    refreshInsertPoints();
    paint();
}

/// The `+` again, against the boxes as they now are.
///
/// It is a DOM element in the card container, so this is a small rebuild of just
/// those. Cheaper than it sounds: there are five. Two callers — the hovered wire
/// changing, and a node being let go of somewhere else, which moves the wire the
/// `+` was sitting on.
function refreshInsertPoints() {
    if (!refs.nodes || !placed) return;
    for (const b of Array.from(refs.nodes.querySelectorAll('.gp-plus')))
        refs.nodes.removeChild(b);
    if (!lastPoints) return;
    drawInsertPoints({ points: lastPoints },
                     new Map(placed.nodes.map((b) => [b.node.id, b])));
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
    canvas.paintWires(ctx, placed, view(), litWire(), hoveredWire(), chosenWire());
    if (wiring) paintWiring(ctx);
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

/// The wire in the air, from the socket it left to wherever the pointer is —
/// snapped to the socket it would land on, so the drop is confirmed before it
/// happens rather than discovered afterwards.
function paintWiring(ctx) {
    const rect = refs.viewport.getBoundingClientRect();
    const v = view();
    const from = { x: wiring.from.x * zoom + panX, y: wiring.from.y * zoom + panY };
    const to = wiring.over
        ? { x: wiring.over.at.x * zoom + panX, y: wiring.over.at.y * zoom + panY }
        : { x: wiring.x - rect.left, y: wiring.y - rect.top };
    canvas.paintPending(ctx, from, to, wiring.stream || 'v', !!wiring.over);
    void v;
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

function note(text) {
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
    const f = lastFold;
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
