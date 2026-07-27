// The graph, on screen.
//
// The spine made the *stages* visible; this makes the graph itself visible. It
// is derived from the edit and read-only for now, which is not a placeholder:
// seeing what the timeline amounts to — every trim, every scale, every overlay,
// named the way ffmpeg names them — is most of what this stage is for, and it
// is the picture the command bar has only ever been able to state as one long
// line.
//
// Absolutely positioned divs over a `<canvas>` that draws the wires, which is
// the pairing `ui/timeline.js` already uses. The alternative is drawing nodes
// into the canvas too, and then every string on this screen would be
// `fillText` — unselectable, unstyleable, and re-implementing text layout to
// wrap an option value. A node is a small panel; panels are what the DOM is
// for. The canvas draws the one thing the DOM is bad at, which is a curve.
//
// Pan and zoom are a `transform` on the node container, and the wires are drawn
// in screen coordinates rather than being scaled with it: a curve stroked into
// a scaled canvas is a blurred curve, and the whole reason to zoom in on a
// graph is to read it. The cost is redrawing the wires on every pan, which is
// a few dozen beziers.
//
// **Heights are measured, not guessed.** A node is as tall as the arguments its
// filter was given, and `layout()` is asked for positions only once every card
// has been built and read. The measurement happens with the container's
// transform cleared, so what comes back is in graph coordinates and not in
// whatever the zoom happens to be. And because this stage is `display:none`
// most of the time, a measurement of zero means "not on screen" rather than
// "empty" — the redraw is refused rather than believed.

import { el, div, span, put } from '../dom.js';
import { basename } from '../format.js';
import { buildSpec, specSources } from '../export/spec.js';
import { derive } from './derive.js';
import { print } from './print.js';
import { layout, NODE_W } from './layout.js';

// The palette's --blue and --good. Canvas takes colours, not custom
// properties, and a wire whose colour drifts from the node it leaves is worse
// than one that is written down in two places.
const WIRE = { v: '#4a9eff', a: '#57c98a' };
const WIRE_DIM = { v: '#2c5f99', a: '#357a55' };

let refs = {};
let zoom = 1;
let panX = 0;
let panY = 0;
let placed = null;      // the last layout(), for repainting wires on a pan
let shape = '';         // what the graph looked like, so a fit happens once per shape
let canvasSize = '';

/// Walked by hand rather than with `closest()`: this engine's DOM is a subset,
/// and a selector match that silently answers nothing would make the whole
/// background draggable including the cards on it.
function inNode(node) {
    for (let p = node; p && p !== refs.viewport; p = p.parentNode)
        if (p.classList && p.classList.contains('gn')) return true;
    return false;
}

export function initGraphView(r) {
    refs = r;

    // Dragging the background pans. On a node it does nothing yet, which is
    // the honest read-only behaviour: a node that moves under the mouse but
    // does not stay moved is worse than one that does not move.
    let dragging = null;
    refs.viewport.addEventListener('mousedown', (e) => {
        if (inNode(e.target)) return;
        dragging = { x: e.clientX, y: e.clientY, panX, panY };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panX = dragging.panX + (e.clientX - dragging.x);
        panY = dragging.panY + (e.clientY - dragging.y);
        apply();
    });
    document.addEventListener('mouseup', () => { dragging = null; });

    // Zoom about the pointer, so the thing being looked at stays under it.
    // Zooming about the corner means chasing the graph across the screen with
    // the scroll wheel, which is how every node editor that gets this wrong
    // feels.
    refs.viewport.addEventListener('wheel', (e) => {
        const rect = refs.viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const next = Math.max(0.3, Math.min(2.5, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        if (next === zoom) return;
        panX = mx - ((mx - panX) * next) / zoom;
        panY = my - ((my - panY) * next) / zoom;
        zoom = next;
        apply();
        e.preventDefault();
    });

    if (refs.fit) refs.fit.addEventListener('click', fitView);
}

/// What the graph comes to, for the spine's card and for anything else that
/// wants the shape without the picture. Cheap: `derive()` is a pure walk over
/// a handful of clips, which is also what the command bar does twice a draw.
export function graphSummary() {
    const d = derive(buildSpec(), specSources());
    if (!d.ok) return { ok: false, reason: d.reason };
    const p = print(d.graph);
    return {
        ok: true,
        nodes: d.graph.nodes.filter((n) => n.kind === 'filter').length,
        chains: p.chains.length,
        inputs: p.inputs.length,
        caveats: d.caveats.length,
    };
}

/// One node as a card. Everything the node carries is on it — a graph screen
/// that hides an argument behind a click is a diagram, not the thing itself.
///
/// Which stream it is on is not settled here: that is `layout()`'s answer,
/// carried forward from the input nodes, and it arrives after the card has been
/// built and measured.
///
/// The width is written here rather than after the layout, because the height
/// this card is about to be measured for is a consequence of it: left to size
/// itself the card is shrink-to-fit inside a container that is deliberately
/// zero wide, and every measurement would be of a different card from the one
/// that ends up on screen.
function card(n, g) {
    const cls = ['gn', `gn-${n.kind}`];
    if (n.locked) cls.push('gn-locked');
    if (!n.derived) cls.push('gn-user');

    const args = [];
    for (const v of n.pos) args.push(div('gn-arg', span(String(v), 'gn-v')));
    for (const k of Object.keys(n.params))
        args.push(div('gn-arg', [span(k, 'gn-k'), span(String(n.params[k]), 'gn-v')]));

    const name = n.kind === 'input' ? basename(n.path)
               : n.kind === 'sink' ? (n.stream === 'a' ? 'audio out' : 'video out')
               : n.filter;
    // The pad, because it is what the chain in the command bar says and this
    // screen is worth nothing if the two cannot be read against each other.
    // A sink does not have a pad of its own — it reports the one it maps, the
    // same answer `print()` gives `-map`.
    const mapped = n.kind === 'sink' && g.producers(n)[0];
    const pad = n.kind === 'input' ? `[${n.index}:${n.stream}]`
              : mapped && mapped.label ? `[${mapped.label}]`
              : n.label ? `[${n.label}]` : '';

    return el('div', {
        cls: cls.join(' '),
        'data-node': n.id,
        'data-filter': n.filter || n.kind,
        title: n.path || undefined,
        style: { width: `${NODE_W}px` },
    }, [
        div('gn-head', [span(name, 'gn-name'), pad && span(pad, 'gn-pad mono')]),
        args.length ? div('gn-args mono', args) : null,
    ]);
}

/// Rebuild from the edit. Refused while the stage is not on screen, because
/// every height it needs would measure zero and the layout would be a stack of
/// nodes at the top-left corner that nobody ever sees be wrong.
export function drawGraph() {
    if (!refs.viewport) return;
    const width = refs.viewport.clientWidth;
    if (!width) return;

    const d = derive(buildSpec(), specSources());
    if (!d.ok) {
        placed = null;
        put(refs.nodes, () => []);
        paint();
        note(d.reason ? `No graph: ${d.reason}.` : 'No graph.');
        status(null);
        return;
    }
    note('');

    // Build, then measure, then place. The transform is cleared for the
    // measurement so heights come back in graph coordinates whatever the zoom
    // is — a card read at 1.4× and then positioned at 1.4× would compound.
    const cards = new Map();
    refs.nodes.style.transform = 'none';
    put(refs.nodes, () => d.graph.nodes.map((n) => {
        const node = card(n, d.graph);
        cards.set(n.id, node);
        return node;
    }));

    const measured = new Map();
    for (const n of d.graph.nodes)
        measured.set(n.id, cards.get(n.id).getBoundingClientRect().height);

    placed = layout(d.graph, (n) => measured.get(n.id));
    for (const box of placed.nodes) {
        const node = cards.get(box.node.id);
        node.classList.add(`gn-${box.stream}`);
        node.style.left = `${box.x}px`;
        node.style.top = `${box.y}px`;
    }

    if (shape !== shapeOf(d.graph)) { shape = shapeOf(d.graph); fit(); }
    apply();
    status(print(d.graph));
}

/// What makes one graph a different *picture* from another: how many nodes,
/// what they are and how they are wired. Not their arguments — turning the
/// quality up should not throw away where you had panned to.
function shapeOf(g) {
    return g.nodes.map((n) => `${n.kind}:${n.filter}`).join(',') + '|' +
           g.edges.map((e) => `${e.from}>${e.to}:${e.port}`).join(',');
}

/// Frame the whole graph and repaint. The two halves are separate because
/// `drawGraph()` fits before it has anything to apply to.
export function fitView() { fit(); apply(); }

/// Zoom and centre so the whole graph is on screen, never magnified past
/// life-size — a four-node graph blown up to fill the window reads as an error.
function fit() {
    if (!placed || !refs.viewport) return;
    const w = refs.viewport.clientWidth, h = refs.viewport.clientHeight;
    if (!w || !h || !placed.width) return;
    const pad = 24;
    zoom = Math.max(0.3, Math.min(1, Math.min((w - pad * 2) / placed.width,
                                              (h - pad * 2) / Math.max(1, placed.height))));
    panX = (w - placed.width * zoom) / 2;
    panY = (h - placed.height * zoom) / 2;
}

function apply() {
    if (!refs.nodes) return;
    refs.nodes.style.transform = `translate(${Math.round(panX)}px, ${Math.round(panY)}px) scale(${zoom})`;
    paint();
}

/// The wires, in screen coordinates. Horizontal control points, so a wire
/// leaves a node sideways and arrives sideways however far apart they are —
/// which is what makes a graph with a long edge in it still readable.
function paint() {
    const canvas = refs.canvas;
    if (!canvas) return;
    const w = refs.viewport.clientWidth | 0;
    const h = refs.viewport.clientHeight | 0;
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!placed) return;

    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    for (const wire of placed.wires) {
        const x1 = wire.x1 * zoom + panX, y1 = wire.y1 * zoom + panY;
        const x2 = wire.x2 * zoom + panX, y2 = wire.y2 * zoom + panY;
        const reach = Math.max(24, Math.abs(x2 - x1) * 0.45);
        ctx.strokeStyle = WIRE[wire.stream] || WIRE.v;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1 + reach, y1, x2 - reach, y2, x2, y2);
        ctx.stroke();

        // A dot where it arrives, because a node with two inputs has to show
        // which wire went into which port.
        ctx.fillStyle = WIRE_DIM[wire.stream] || WIRE_DIM.v;
        ctx.beginPath();
        ctx.arc(x2, y2, Math.max(1.5, 2.5 * zoom), 0, Math.PI * 2);
        ctx.fill();
    }
}

/// The stage resizes when the window does, and the wires are drawn in screen
/// coordinates, so they have to be told. Called from the frame loop; a
/// measurement of zero means the stage is not up and is ignored rather than
/// acted on.
export function chaseGraph() {
    if (!refs.viewport) return;
    const w = refs.viewport.clientWidth | 0, h = refs.viewport.clientHeight | 0;
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
function status(p) {
    if (!refs.status) return;
    if (!p || !placed) return put(refs.status, () => []);
    const nodes = placed.nodes.filter((b) => b.node.kind === 'filter').length;
    put(refs.status, () => [
        span(`${p.inputs.length} input${p.inputs.length === 1 ? '' : 's'}`),
        span('·', 'dim'),
        span(`${nodes} filter${nodes === 1 ? '' : 's'}`),
        span('·', 'dim'),
        span(`${p.chains.length} chain${p.chains.length === 1 ? '' : 's'}`),
        span('·', 'dim'),
        // Said out loud rather than left to be discovered: this is what the
        // edit comes to, not a place the edit is made.
        span('derived from the edit', 'dim'),
    ]);
}
