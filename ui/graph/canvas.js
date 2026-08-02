// Everything on the Graph stage that is drawn rather than built.
//
// The cards are DOM because a node is a small panel and panels are what the DOM
// is for. These three are not: a dotted background, a few dozen bezier curves and
// a minimap are pixels, and doing them in elements would mean a thousand divs for
// the grid and re-implementing curve rasterisation for the wires.
//
// **All three are drawn in screen coordinates against an untransformed canvas**,
// while the cards live in a container with a `transform` on it. That asymmetry is
// deliberate and it is about sharpness: a curve stroked into a scaled canvas is a
// blurred curve, and the reason to zoom in on a graph is to read it. The cost is
// redrawing on every pan, which is a few dozen curves and one filled path.
//
// What each of them is for, since none of it was here and the stage was hard to
// use without all three:
//
// - **The grid** is the only thing that says the canvas is moving. Without it a
//   pan on an empty area looks like nothing happening, and there is no sense of
//   scale to tell 0.5× from 1×. Faded out when the dots get close enough together
//   to read as noise instead of as a grid.
// - **Wire emphasis.** Every wire being equally loud means a nine-node graph is a
//   thicket. The selected node's wires come forward and the rest go back, which is
//   what Nuke and Houdini do and is most of how a big graph stays readable.
// - **The minimap** is where you are. A graph wider than the viewport — which
//   this one is with two clips on the timeline — has no other answer than
//   panning around until you recognise something.

import { portY } from './layout.js';

/// The palette's --blue, --good and --accent. Canvas takes colours, not custom
/// properties, and a wire whose colour drifts from the node it leaves is worse
/// than one written down in two places. `s` is a wire of cues — an input's
/// subtitle pad on its way to an `overlay`, the one wire that is neither picture
/// nor sound — and it is the same orange the socket it leaves is drawn in.
const WIRE = { v: '#4a9eff', a: '#57c98a', s: '#ff8c42' };
const WIRE_DIM = { v: '#2c5f99', a: '#357a55', s: '#99551f' };

/// The Find stage's two, which are the other thing a wire can carry
/// (`ui/find/model.js`): a **recording** on its way into a finder, and a
/// **stack** of candidates on its way through the arrangement. Here rather than
/// there because a wire's colour and the curve it is stroked onto are one fact,
/// and a palette kept beside the caller is how the two come to disagree about
/// which end of a graph is which.
///
/// Violet for a recording, because the three above are taken and because violet
/// is what a *generator* is drawn in on the timeline — the same idea, a source
/// that is not yet a picture. Amber for a stack, clear of the accent, which
/// everywhere in this application means "selected".
export const FIND_WIRES = {
    wire: { input: '#b07cff', stack: '#ffcf5c' },
    dim:  { input: '#6a4a99', stack: '#997c37' },
};
const GRID = 'rgba(255, 255, 255, 0.17)';
const MINI_BG = 'rgba(0, 0, 0, 0.35)';
const MINI_EDGE = 'rgba(255, 255, 255, 0.18)';
const MINI_VIEW = '#ff8c42';

/// The graph grid, in graph pixels. 32 rather than 24 so that a card of the
/// default width is a whole number of cells across at 1×, which is what makes a
/// dragged node look placed rather than dropped.
const GRID_STEP = 32;

/// Where a wire is, in screen space. `view` is `{ zoom, panX, panY }`.
const sx = (x, view) => x * view.zoom + view.panX;
const sy = (y, view) => y * view.zoom + view.panY;

/// The control points a wire is drawn with. Horizontal, so a wire leaves a node
/// sideways and arrives sideways however far apart they are — which is what makes
/// a graph with one long edge in it still readable.
function curve(w, view) {
    const x1 = sx(w.x1, view), y1 = sy(w.y1, view);
    const x2 = sx(w.x2, view), y2 = sy(w.y2, view);
    const reach = Math.max(24, Math.abs(x2 - x1) * 0.45);
    return { x1, y1, x2, y2, c1: x1 + reach, c2: x2 - reach };
}

export function paintGrid(ctx, w, h, view) {
    const step = GRID_STEP * view.zoom;
    // Under about eight pixels the dots stop being a grid and start being a
    // texture, which is worse than nothing behind a graph you are trying to read.
    if (step < 8) return;
    ctx.fillStyle = GRID;
    const x0 = view.panX - Math.floor(view.panX / step) * step;
    const y0 = view.panY - Math.floor(view.panY / step) * step;
    const r = view.zoom > 1.2 ? 2 : 1;
    // A fill per dot rather than one accumulated path. About fifteen hundred of
    // them across a full window, which measures as nothing, and it is the version
    // whose output can be checked a pixel at a time — which mattered, because a
    // grid this quiet is invisible in a screenshot whether it is drawn or not.
    for (let y = y0; y < h; y += step)
        for (let x = x0; x < w; x += step) ctx.fillRect(x, y, r, r);
}

/// Whether any of a wire could land on a canvas this size.
///
/// **The one thing on this screen that has to be priced in what is being looked
/// at rather than in how big the edit is.** A montage of seventy clips derives
/// seven hundred wires and a window holds a couple of dozen of them; stroking the
/// rest is a bezier a piece for something off the edge of the canvas, on every
/// frame of every pan and every drag. The bound is the curve's own: the control
/// points are horizontal offsets from the ends, so the ends plus `reach` contain
/// it, and a margin covers the stroke's width.
///
/// The test is against the wire *as drawn*, which is why it is here and not in
/// `view.js` — screen space is what `curve` works in and the only place the pan
/// and the zoom have already been applied.
function onScreen(c, w, h) {
    const reach = Math.max(c.c1 - c.x1, c.x2 - c.c2, 0) + 8;
    return Math.min(c.x1, c.x2) - reach <= w && Math.max(c.x1, c.x2) + reach >= 0 &&
           Math.min(c.y1, c.y2) - 8 <= h && Math.max(c.y1, c.y2) + 8 >= 0;
}

/// `lit(wire)` says whether a wire belongs to what is selected. Everything else
/// is drawn first and dimmer, so the lit ones are on top rather than merely
/// brighter.
///
/// **Grouped rather than sorted, and one path per group.** This runs on every
/// frame of every pan and every drag, so what it does per wire is the whole cost:
/// a `sort` over seven hundred of them allocated a copy and called `lit` twice
/// per comparison — about fourteen thousand calls to answer a question with two
/// possible values — and setting `strokeStyle` and `lineWidth` per wire is a
/// canvas state change per wire for a colour there are six of. Splitting into
/// dim-then-lit is one pass, and a path per (group, stream) is one state change
/// per colour and one `stroke` for everything wearing it. Measured at 634 nodes
/// with all seven hundred wires in view: 2.74 ms a frame to 1.09.
///
/// The hovered and chosen wires are drawn on their own afterwards, because they
/// are one wire each and their whole point is to be on top.
export function paintWires(ctx, placed, view, lit, hovered, chosen, palette) {
    if (!placed) return;
    const WIRES = (palette && palette.wire) || WIRE;
    const DIMS = (palette && palette.dim) || WIRE_DIM;
    // What an unrecognised stream falls back to. The first entry of whichever
    // palette is in use rather than `WIRE.v`, which would draw a Find stage wire
    // in the filter graph's blue and say it carried a picture.
    const anyWire = WIRES[Object.keys(WIRES)[0]];
    const anyDim = DIMS[Object.keys(DIMS)[0]];
    const W = ctx.canvas ? ctx.canvas.width : 0;
    const H = ctx.canvas ? ctx.canvas.height : 0;
    // Keyed by group and stream, built as it goes: an edit with no sound in it
    // should not pay for the sound colours, and the six that exist are named by
    // the wires that turn up rather than by a list here.
    const groups = new Map();
    for (const w of placed.wires) {
        const c = curve(w, view);
        if (W > 0 && H > 0 && !onScreen(c, W, H)) continue;
        const on = lit(w);
        const key = `${on ? 1 : 0}:${w.stream}`;
        let g = groups.get(key);
        if (!g) {
            g = { on, stream: w.stream, curves: [] };
            groups.set(key, g);
        }
        g.curves.push(c);
    }
    // Dim first, so the lit ones are on top rather than merely brighter.
    const order = [...groups.values()].sort((a, b) => (a.on ? 1 : 0) - (b.on ? 1 : 0));
    for (const g of order) {
        ctx.lineWidth = Math.max(1, (g.on ? 2.2 : 1.4) * view.zoom);
        ctx.strokeStyle = g.on ? (WIRES[g.stream] || anyWire) : (DIMS[g.stream] || anyDim);
        ctx.beginPath();
        for (const c of g.curves) {
            ctx.moveTo(c.x1, c.y1);
            ctx.bezierCurveTo(c.c1, c.y1, c.c2, c.y2, c.x2, c.y2);
        }
        ctx.stroke();
    }
    for (const w of placed.wires) {
        if (w !== hovered && w !== chosen) continue;
        const c = curve(w, view);
        if (W > 0 && H > 0 && !onScreen(c, W, H)) continue;
        ctx.beginPath();
        ctx.moveTo(c.x1, c.y1);
        ctx.bezierCurveTo(c.c1, c.y1, c.c2, c.y2, c.x2, c.y2);

        // The wire under the pointer is the one a `+` is about to be offered on,
        // so it says which one that is before you click.
        if (hovered && hovered === w) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, 1 * view.zoom);
            ctx.stroke();
        }

        // A wire can be selected now, because a wire can be deleted now. Drawn
        // as the selection colour rather than as a brighter version of itself:
        // "this is what Delete is about" is a different statement from "this
        // belongs to the node you clicked", and the two are on screen together.
        if (chosen && chosen === w) {
            ctx.strokeStyle = '#ff8c42';
            ctx.lineWidth = Math.max(1.5, 3 * view.zoom);
            ctx.stroke();
        }
    }
}

/// Which wire is under a screen point, or null.
///
/// Sampled rather than solved: a cubic's distance to a point has a closed form
/// nobody should write twice, and sixteen points per wire over a few dozen wires
/// is a few hundred subtractions on a mouse move. The tolerance is in screen
/// pixels so that a wire is as easy to hit when zoomed out as in.
export function wireAt(placed, px, py, view, tol = 7) {
    if (!placed) return null;
    let best = null, bestD = tol * tol;
    for (const w of placed.wires) {
        const c = curve(w, view);
        // The seventeen samples are cheap and seven hundred wires of them on
        // every mouse move are not. A wire whose own box does not reach the
        // pointer cannot be the nearest one, and the box is four comparisons.
        const reach = Math.max(c.c1 - c.x1, c.x2 - c.c2, 0) + tol;
        if (px < Math.min(c.x1, c.x2) - reach || px > Math.max(c.x1, c.x2) + reach ||
            py < Math.min(c.y1, c.y2) - tol || py > Math.max(c.y1, c.y2) + tol) continue;
        for (let i = 0; i <= 16; i++) {
            const t = i / 16, u = 1 - t;
            const x = u * u * u * c.x1 + 3 * u * u * t * c.c1 + 3 * u * t * t * c.c2 + t * t * t * c.x2;
            const y = u * u * u * c.y1 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y2;
            const d = (x - px) * (x - px) + (y - py) * (y - py);
            if (d < bestD) { bestD = d; best = w; }
        }
    }
    return best;
}

/// The wire being dragged, from a socket to wherever the pointer is.
///
/// Drawn dashed and in the stream's own colour, because both halves of what it
/// is saying matter while it is in the air: that this is not yet a connection,
/// and that it is a picture or a sound — which is what decides whether the pad
/// it is heading for can take it.
export function paintPending(ctx, from, to, stream, valid, palette) {
    const WIRES = (palette && palette.wire) || WIRE;
    const colour = WIRES[stream] || WIRES[Object.keys(WIRES)[0]];
    ctx.save();
    ctx.setLineDash(valid ? [] : [5, 4]);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    const reach = Math.max(24, Math.abs(to.x - from.x) * 0.45);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(from.x + reach, from.y, to.x - reach, to.y, to.x, to.y);
    ctx.stroke();
    ctx.restore();
    // The end you are holding, so it reads as an end rather than as a wire that
    // trails off. Filled where it would connect and hollow where it would not.
    ctx.beginPath();
    ctx.arc(to.x, to.y, 4, 0, Math.PI * 2);
    if (valid) { ctx.fillStyle = colour; ctx.fill(); }
    else { ctx.strokeStyle = MINI_EDGE; ctx.lineWidth = 1.5; ctx.stroke(); }
}

// ── sockets ────────────────────────────────────────────────────────────────
//
// Where a socket is, and which one is under the pointer. Both answered from the
// layout rather than from the document, and that is not an implementation
// detail: the cards live in a container with a `transform` on it, so asking
// what element is under a point asks about a coordinate system nothing else
// here uses — and the socket elements are eight pixels wide, which at 0.6×
// zoom is a target nobody can hit. The layout knows where every pad is in graph
// coordinates and `portY` is the one formula that decides it, so the wire, the
// dot and the hit test are all the same arithmetic.

/// Where one pad sits, in graph coordinates. `dir` is `'in'` or `'out'`.
export function socketPoint(box, dir, port) {
    const ports = dir === 'in' ? box.inPorts : box.outPorts;
    return { x: dir === 'in' ? box.x : box.x + box.w,
             y: box.y + portY(box.h, port, ports) };
}

/// The pad under a screen point, or null. Generous on purpose — a socket is a
/// small dot and dropping a wire is a gesture, not a click on a button.
export function socketAt(placed, px, py, view, tol = 14) {
    if (!placed) return null;
    let best = null, bestD = tol * tol;
    for (const box of placed.nodes) {
        for (const dir of ['in', 'out']) {
            const ports = dir === 'in' ? box.inPorts : box.outPorts;
            for (let port = 0; port < ports; port++) {
                const p = socketPoint(box, dir, port);
                const dx = sx(p.x, view) - px, dy = sy(p.y, view) - py;
                const d = dx * dx + dy * dy;
                if (d >= bestD) continue;
                bestD = d;
                best = { box, node: box.node, dir, port, at: p };
            }
        }
    }
    return best;
}

// ── the minimap ────────────────────────────────────────────────────────────

/// The transform that fits the whole graph into the map, plus a margin so a node
/// on the edge is not drawn half off it.
function miniFit(placed, w, h) {
    const pad = 4;
    const gw = Math.max(1, placed.width), gh = Math.max(1, placed.height);
    const k = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh);
    return {
        k,
        ox: pad + (w - pad * 2 - gw * k) / 2 - placed.left * k,
        oy: pad + (h - pad * 2 - gh * k) / 2 - placed.top * k,
    };
}

export function paintMini(canvas, placed, view, port, palette) {
    const DIMS = (palette && palette.dim) || WIRE_DIM;
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = MINI_BG;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = MINI_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (!placed || !placed.nodes.length) return;

    const m = miniFit(placed, w, h);
    // Nodes only, no wires: at this size a wire is a smudge between two blocks
    // that are already touching, and the shape of the graph is what a minimap is
    // for. Every editor with one draws it this way.
    for (const b of placed.nodes) {
        ctx.fillStyle = DIMS[b.stream] || DIMS[Object.keys(DIMS)[0]];
        ctx.fillRect(b.x * m.k + m.ox, b.y * m.k + m.oy,
                     Math.max(2, b.w * m.k), Math.max(2, b.h * m.k));
    }

    // What is on screen, in graph coordinates, put through the same transform.
    const vx = (-view.panX) / view.zoom, vy = (-view.panY) / view.zoom;
    ctx.strokeStyle = MINI_VIEW;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(vx * m.k + m.ox) + 0.5, Math.round(vy * m.k + m.oy) + 0.5,
                   Math.max(3, (port.w / view.zoom) * m.k), Math.max(3, (port.h / view.zoom) * m.k));
}

/// A point on the minimap, as the pan that centres the view there. Returned
/// rather than applied so the caller keeps every write to the view in one place.
export function miniPan(canvas, placed, view, port, mx, my) {
    if (!placed) return null;
    const m = miniFit(placed, canvas.width, canvas.height);
    if (!(m.k > 0)) return null;
    const gx = (mx - m.ox) / m.k, gy = (my - m.oy) / m.k;
    return { panX: port.w / 2 - gx * view.zoom, panY: port.h / 2 - gy * view.zoom };
}
