// Where the nodes go.
//
// Pure geometry: a graph and a way to ask how tall a node is, in, positions
// out. Nothing here touches the DOM, which is what lets the view build its
// cards first, measure them, and then place them — the same build/measure split
// the range strip uses, and for the same reason. A node's height depends on how
// many arguments its filter was given and there is no honest way to guess it.
//
// **Columns are depth, rows are what keeps a chain on one line.** A node's
// column is the longest path to it from a source, so everything that must
// happen before it is to its left and the picture reads the way the data flows.
// Within a column, a node wants to sit at the average row of what feeds it —
// which is what makes a clip's whole chain a horizontal line, and makes two
// clips two lines rather than a lattice. Collisions push down, so the wanting
// is a preference and the result is still a grid.
//
// That is a barycentre pass, one sweep, left to right. Layered graph drawing
// has much better than this in it, and none of it is worth having here: the
// graphs this stage draws are derived from a timeline, so they are wide and
// shallow and almost planar already. A second sweep changed nothing on every
// edit tried.

import { streamsOf } from './model.js';

/// What a card is when nothing has resized it. A column is as wide as its
/// widest card rather than this, so that dragging one node bigger moves the
/// rest of the graph out of its way instead of drawing over it.
export const NODE_W = 176;
const COL_GAP = 62;
const ROW_GAP = 20;

/// Where a port sits down a node's edge, as a fraction of its height.
///
/// Exported and used by both the wire and the socket that the wire arrives at,
/// because a dot drawn anywhere other than where the curve lands is worse than no
/// dot at all: it makes the picture say that this wire goes to that port when it
/// does not. One formula, two callers, no possibility of drift.
export function portY(h, port, ports) {
    return (h * (port + 1)) / (Math.max(1, ports) + 1);
}

/// The longest path to each node from a source. Longest rather than shortest:
/// a node must be drawn to the right of *everything* it waits for, and the
/// shortest path would put `overlay` beside the clip it is compositing.
///
/// Relaxed to a fixed point rather than sorted topologically, because the pass
/// is over a few dozen nodes and a cycle in a hand-built graph should come out
/// as a strange picture rather than as a hang.
function depths(g) {
    const d = new Map();
    for (const n of g.nodes) d.set(n.id, 0);
    for (let pass = 0; pass <= g.nodes.length; pass++) {
        let moved = false;
        for (const n of g.nodes) {
            const ps = g.producers(n);
            if (!ps.length) continue;
            let want = 0;
            for (const p of ps) want = Math.max(want, d.get(p.id) + 1);
            if (want > d.get(n.id)) { d.set(n.id, want); moved = true; }
        }
        if (!moved) break;
    }
    return d;
}

/// `sizeOf(node)` is asked once per node and must answer `{ w, h }` in pixels.
///
/// Both, rather than a height and a constant width, because a card can be
/// dragged wider to see the picture in it — and a wider card is a wider column,
/// or the next column is drawn on top of it.
///
/// `pinOf(node)` may answer `{ x, y }` for a node that was dragged somewhere. A
/// pin **overrides where the layout put it and changes nothing else**: the flow
/// does not part to make room, and the nodes you did not touch do not move. That
/// is what Nuke and Houdini do, and the alternative — a layout that reflowed
/// around every pin — would mean dragging one node rearranged the eight you were
/// happy with, which is the opposite of what dragging it was for.
///
/// Returns `{ nodes, wires, width, height }` — `nodes` carrying the node and
/// its box, `wires` the endpoints of every edge already resolved to the port it
/// arrives at, so the caller draws curves and does no arithmetic.
export function layout(g, sizeOf, pinOf) {
    const depth = depths(g);
    const streamOf = streamsOf(g);

    // Column membership, in the order the nodes were made — which for a
    // derived graph is the order its chains print in, and so the order a
    // person reading the command bar met them.
    const cols = [];
    for (const n of g.nodes) {
        const c = depth.get(n.id);
        (cols[c] || (cols[c] = [])).push(n);
    }

    const row = new Map();
    for (let c = 0; c < cols.length; c++) {
        const want = (cols[c] || []).map((n, i) => {
            const ps = g.producers(n).filter((p) => row.has(p.id));
            let bary = i;
            if (ps.length) {
                bary = 0;
                for (const p of ps) bary += row.get(p.id);
                bary /= ps.length;
            }
            return { node: n, bary, order: i };
        });
        want.sort((a, b) => a.bary - b.bary || a.order - b.order);
        let next = 0;
        for (const w of want) {
            const r = Math.max(next, Math.round(w.bary));
            row.set(w.node.id, r);
            next = r + 1;
        }
    }

    // Row tops, from the tallest node in each row. A row is a horizontal band
    // across every column, so a tall node anywhere in it pushes the whole band
    // — which is what keeps the chains from overlapping each other. Columns are
    // the same idea sideways, and for the same reason.
    const sizes = new Map();
    const rowHeight = [];
    const colWidth = [];
    for (const n of g.nodes) {
        const s = sizeOf(n) || {};
        const box = { w: Math.max(48, s.w || NODE_W), h: Math.max(24, s.h || 0) };
        sizes.set(n.id, box);
        const r = row.get(n.id);
        rowHeight[r] = Math.max(rowHeight[r] || 0, box.h);
        const c = depth.get(n.id);
        colWidth[c] = Math.max(colWidth[c] || 0, box.w);
    }
    const rowTop = [];
    let y = 0;
    for (let r = 0; r < rowHeight.length; r++) {
        rowTop[r] = y;
        y += (rowHeight[r] || 0) + ROW_GAP;
    }
    const colLeft = [];
    let x = 0;
    for (let c = 0; c < cols.length; c++) {
        colLeft[c] = x;
        x += (colWidth[c] || NODE_W) + COL_GAP;
    }

    const boxes = new Map();
    const nodes = g.nodes.map((n) => {
        const pin = pinOf ? pinOf(n) : null;
        const box = {
            node: n,
            col: depth.get(n.id),
            row: row.get(n.id),
            stream: streamOf.of(n),
            pinned: !!pin,
            x: pin ? pin.x : colLeft[depth.get(n.id)],
            y: pin ? pin.y : rowTop[row.get(n.id)],
            w: sizes.get(n.id).w,
            h: sizes.get(n.id).h,
        };
        boxes.set(n.id, box);
        return box;
    });

    // An edge arrives at the port it was wired to, spaced down the node's left
    // edge. overlay's two inputs are not interchangeable and a picture that
    // draws them into the same point says they are.
    const wires = [];
    for (const e of g.edges) {
        const a = boxes.get(e.from), b = boxes.get(e.to);
        if (!a || !b) continue;
        // `oy1`/`oy2` are the endpoints as offsets *into* their nodes, kept because
        // dragging a card has to move its wires without re-deriving anything: the
        // view moves the boxes and adds these back. Recovering them by subtracting
        // afterwards does not work — by then the box has moved.
        // `b.node`, not `b`. Asking the graph about a *box* answers nothing — the
        // model looks for an `id` and a box has none — so the port count came back
        // zero, every arrival was clamped to one port, and `overlay`'s two inputs
        // landed on top of each other. Which is the exact thing the comment above
        // says this code exists to prevent: it had been saying so and not doing it
        // since the day it was written.
        //
        // The same spacing on the way out, because a node can have more than
        // one: a file's picture and its sound leave one card and two wires
        // drawn from one point would say they were the same stream.
        const oy1 = portY(a.h, e.fromPort || 0, g.outPorts(a.node));
        const oy2 = portY(b.h, e.port, g.producers(b.node).length);
        wires.push({
            edge: e,
            stream: streamOf.ofEdge(e),
            oy1, oy2,
            x1: a.x + a.w, y1: a.y + oy1,
            x2: b.x, y2: b.y + oy2,
        });
    }

    // The extent of what was drawn, pins included: a card dragged out past the
    // last column is still part of the picture, and a `Fit` that framed the
    // columns and left it off screen would be framing something else.
    let right = Math.max(0, x - COL_GAP);
    let bottom = Math.max(0, y - ROW_GAP);
    let left = 0, top = 0;
    for (const b of nodes) {
        if (!b.pinned) continue;
        left = Math.min(left, b.x);
        top = Math.min(top, b.y);
        right = Math.max(right, b.x + b.w);
        bottom = Math.max(bottom, b.y + b.h);
    }

    return {
        nodes, wires,
        // Where the drawing starts, which is 0,0 until something is dragged left
        // of the first column. The view offsets by it rather than letting a
        // negative coordinate fall off the edge of the viewport.
        left, top,
        width: right - left,
        height: bottom - top,
    };
}
