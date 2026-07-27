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

/// Fixed, so a column's x is arithmetic rather than a measurement, and so that
/// two nodes at the same depth line up whatever is written inside them.
export const NODE_W = 156;
const COL_GAP = 54;
const ROW_GAP = 16;

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

/// Which stream each node is on, carried forward from the input nodes. Only
/// the two ends of the graph say so themselves; everything between is whatever
/// reached it. The generated canvas (`color`) has no producer and no input, so
/// it falls back to video — which is what it is.
function streams(g) {
    const s = new Map();
    const queue = [];
    for (const n of g.nodes)
        if (n.kind === 'input' && n.stream) { s.set(n.id, n.stream); queue.push(n); }
    while (queue.length) {
        const n = queue.shift();
        for (const c of g.consumers(n)) {
            if (s.has(c.id)) continue;
            s.set(c.id, s.get(n.id));
            queue.push(c);
        }
    }
    return (n) => s.get(n.id) || n.stream || 'v';
}

/// `heightOf(node)` is asked once per node and must answer in pixels.
///
/// Returns `{ nodes, wires, width, height }` — `nodes` carrying the node and
/// its box, `wires` the endpoints of every edge already resolved to the port it
/// arrives at, so the caller draws curves and does no arithmetic.
export function layout(g, heightOf) {
    const depth = depths(g);
    const streamOf = streams(g);

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
    // — which is what keeps the chains from overlapping each other.
    const heights = new Map();
    const rowHeight = [];
    for (const n of g.nodes) {
        const h = Math.max(24, heightOf(n) || 0);
        heights.set(n.id, h);
        const r = row.get(n.id);
        rowHeight[r] = Math.max(rowHeight[r] || 0, h);
    }
    const rowTop = [];
    let y = 0;
    for (let r = 0; r < rowHeight.length; r++) {
        rowTop[r] = y;
        y += (rowHeight[r] || 0) + ROW_GAP;
    }

    const boxes = new Map();
    const nodes = g.nodes.map((n) => {
        const box = {
            node: n,
            col: depth.get(n.id),
            row: row.get(n.id),
            stream: streamOf(n),
            x: depth.get(n.id) * (NODE_W + COL_GAP),
            y: rowTop[row.get(n.id)],
            w: NODE_W,
            h: heights.get(n.id),
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
        const ports = g.producers(b).length || 1;
        wires.push({
            edge: e,
            stream: a.stream,
            x1: a.x + a.w, y1: a.y + a.h / 2,
            x2: b.x, y2: b.y + (b.h * (e.port + 1)) / (ports + 1),
        });
    }

    return {
        nodes, wires,
        width: cols.length ? (cols.length - 1) * (NODE_W + COL_GAP) + NODE_W : 0,
        height: Math.max(0, y - ROW_GAP),
    };
}
