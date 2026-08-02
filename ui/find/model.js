// The find graph: the rules that turn recordings into stacks of clips.
//
// **Why this is not `ui/graph/model.js`.** That graph's values are *pads* —
// streams of frames — and every node in it prints into a `-filter_complex`;
// `ui/graph/derive.js` refuses rather than approximates precisely so that the
// graph can never describe a render this application would not perform. A node
// that says "every time he said 'insane'" has no printout at all. Putting it in
// there would mean the filter graph could no longer be printed, which is the one
// property it has. So this is a second graph, sharing the *idiom* — nodes,
// sockets, wires, cards, and `ui/graph/layout.js`'s geometry, which is imported
// rather than copied — and sharing none of the semantics.
//
// What travels on a wire here is a **stack** (`ui/find/stack.js`), and what a
// node does to one is in `ui/find/nodes.js`. This file is the structure: what
// nodes there are, what is wired to what, and the walk that turns that into
// values.
//
// **This graph is in the document and the transcript is not**, which is the
// distinction that decides where everything on this stage lives. A transcript, a
// set of marks and a waveform are *derived* — read from a file, the same answer
// every time, so `ui/document.js` does not carry them and `ui/history.js` never
// sees them. A rule is **authored**: "for every one of these, three of those" is
// somebody's editorial decision and is exactly the kind of work a `.fbro` exists
// to keep. So the graph is in the snapshot, it is on the undo track, and the
// stacks it computes are not — they are recomputed, because they are derived
// from the graph the way a waveform is derived from a file.
//
// **Evaluation is a whole-graph walk and it is not incremental.** A stack is a
// list of a few hundred small objects and every operation on one is a `map` or a
// `filter`; the expensive half — reading the soundtrack — happened long before
// any of this and is only *looked up* here. Measured on a six-hour transcript of
// 6,800 segments with eleven nodes on the canvas, a full evaluation is under two
// milliseconds, so the cache below exists to keep it off the frame loop rather
// than because a second pass would hurt. Incremental evaluation would be a
// dependency graph maintained beside a dependency graph.

import { layout as placeNodes } from '../graph/layout.js';
import * as N from './nodes.js';

/// Ids are unique across every find graph in the process, for
/// `ui/graph/model.js`'s reason: two exist at once the moment one is compared
/// against another, and ids that collide turn "is this the same node" into a
/// question with two answers.
let seq = 0;

/// Told what a document has already handed out, so an open does not renumber
/// nodes a saved layout points at. `useClipId`'s rule, and the same failure it
/// prevents: a pinned position keyed by node id would land on somebody else's
/// node.
export function useNodeId(id) {
    const n = /^f(\d+)$/.exec(String(id || ''));
    if (n) seq = Math.max(seq, Number(n[1]));
}

export function makeFindGraph() {
    const nodes = [];
    const edges = [];
    const listeners = [];
    const g = { nodes, edges };

    /// Bumped on every structural change and every parameter write. The view
    /// evaluates when this moves rather than on a timer, and `ui/history.js`
    /// compares snapshots rather than this — it is a cache key, not a version.
    g.rev = 0;

    const idOf = (n) => (typeof n === 'string' ? n : n && n.id);

    g.node = (n) => {
        const id = idOf(n);
        return nodes.find((x) => x.id === id) || null;
    };

    /// Add a node of `kind`, with the kind's own defaults filled in.
    ///
    /// The defaults come from `nodes.js` rather than from the caller so that a
    /// node placed from the menu, a node restored from a document and a node
    /// made by a test are the same object — a `params` key missing on one of
    /// the three is how a field comes to read `undefined` on a card.
    g.add = (kind, spec = {}) => {
        const k = N.KINDS[kind];
        if (!k) return null;
        const node = {
            id: spec.id || `f${++seq}`,
            kind,
            params: Object.assign({}, k.params, spec.params),
            // Where a person dragged it, or null for wherever the layout puts
            // it. `ui/graph/layout.js`'s `pinOf` contract: a pin overrides the
            // flow and changes nothing else.
            pin: spec.pin ? { x: spec.pin.x, y: spec.pin.y } : null,
        };
        nodes.push(node);
        g.rev++;
        g.changed('add');
        return node;
    };

    g.inEdges = (n) => { const id = idOf(n); return edges.filter((e) => e.to === id); };
    g.outEdges = (n) => { const id = idOf(n); return edges.filter((e) => e.from === id); };
    g.producers = (n) => g.inEdges(n).map((e) => g.node(e.from)).filter(Boolean);
    g.consumers = (n) => g.outEdges(n).map((e) => g.node(e.to)).filter(Boolean);

    g.inPorts = (n) => N.portKinds(g.node(n) || n, 'in').length;
    g.outPorts = (n) => N.portKinds(g.node(n) || n, 'out').length;

    /// Wire one output to one input, or refuse.
    ///
    /// **Refused rather than coerced**, `derive.js`'s rule one stage over: a
    /// recording dropped on a `Merge` is a mistake, and a wire that silently
    /// became something else would produce an empty stack somewhere downstream
    /// with nothing on the screen saying why. The refusal has a reason and the
    /// caller flashes it.
    ///
    /// One wire per input socket, because every operation here reads exactly
    /// one list per pad; a second wire to the same pad replaces the first,
    /// which is what dropping one on an occupied socket means everywhere.
    g.connect = (from, to, port = 0, fromPort = 0) => {
        const a = g.node(from), b = g.node(to);
        if (!a || !b) return 'there is no such node';
        if (a === b) return 'a node cannot feed itself';
        const out = N.portKinds(a, 'out')[fromPort];
        const inn = N.portKinds(b, 'in')[port];
        if (!out || !inn) return 'there is no such socket';
        if (!N.accepts(out, inn))
            return out === N.INPUT
                ? 'that is a recording — it goes into a Said or a Sound'
                : 'that is a stack — it does not go into a recording socket';
        if (reaches(b, a)) return 'that would make a loop';
        g.disconnectAt(b, port);
        edges.push({ from: a.id, to: b.id, port, fromPort });
        g.rev++;
        g.changed('connect');
        return '';
    };

    /// Would following the wires out of `from` ever arrive at `to`? What stops a
    /// cycle being made rather than being survived — the evaluator guards
    /// against one too, because a document written by an older version of this
    /// code cannot be trusted, but a cycle you cannot draw is one nobody has to
    /// be told about.
    function reaches(from, to) {
        const seen = new Set();
        const walk = (n) => {
            if (!n || seen.has(n.id)) return false;
            if (n === to) return true;
            seen.add(n.id);
            return g.consumers(n).some(walk);
        };
        return walk(from);
    }

    g.disconnectAt = (to, port = 0) => {
        const id = idOf(to);
        for (let i = edges.length - 1; i >= 0; i--)
            if (edges[i].to === id && edges[i].port === port) edges.splice(i, 1);
        g.rev++;
    };

    g.removeEdge = (e) => {
        const i = edges.indexOf(e);
        if (i < 0) return;
        edges.splice(i, 1);
        g.rev++;
        g.changed('disconnect');
    };

    g.remove = (n) => {
        const node = g.node(n);
        if (!node) return;
        for (let i = edges.length - 1; i >= 0; i--)
            if (edges[i].from === node.id || edges[i].to === node.id) edges.splice(i, 1);
        nodes.splice(nodes.indexOf(node), 1);
        g.rev++;
        g.changed('remove');
    };

    g.setParam = (n, key, value) => {
        const node = g.node(n);
        if (!node) return;
        if (node.params[key] === value) return;
        node.params[key] = value;
        g.rev++;
        g.changed('params');
    };

    g.pin = (n, at) => {
        const node = g.node(n);
        if (!node) return;
        node.pin = at ? { x: at.x, y: at.y } : null;
        g.rev++;
        g.changed('pin');
    };

    g.onChange = (fn) => { listeners.push(fn); };
    g.changed = (what) => { for (const fn of listeners.slice()) fn(what, g); };

    /// The whole graph as plain data. `ui/document.js` writes this and
    /// `restore` reads it; the shape is deliberately the node's own so that a
    /// document is readable and a hand-written one is possible.
    g.toJSON = () => ({
        nodes: nodes.map((n) => ({
            id: n.id, kind: n.kind,
            params: Object.assign({}, n.params),
            pin: n.pin ? { x: n.pin.x, y: n.pin.y } : null,
        })),
        edges: edges.map((e) => ({ from: e.from, to: e.to,
                                   port: e.port, fromPort: e.fromPort })),
    });

    return g;
}

/// A graph out of what a document or `localStorage` held.
///
/// **Version-tolerant, which is this repository's rule for every read of
/// persisted state and not a nicety here.** What is in a `.fbro` was written by
/// an earlier version of this code: a kind that no longer exists, a param that
/// has been renamed, an edge naming a node that was dropped. Each of those is
/// skipped rather than thrown on, because the alternative is a document that
/// will not open at all over one stale node.
export function restoreFindGraph(json) {
    const g = makeFindGraph();
    if (!json || typeof json !== 'object') return g;
    const made = new Map();
    for (const raw of Array.isArray(json.nodes) ? json.nodes : []) {
        if (!raw || !N.KINDS[raw.kind]) continue;
        useNodeId(raw.id);
        // Only the params this version of the kind declares. A stale key would
        // otherwise ride along invisibly and be written back out on the next
        // save, which is how a document accumulates fields nothing reads.
        const params = {};
        const known = N.KINDS[raw.kind].params;
        for (const key of Object.keys(known))
            if (raw.params && raw.params[key] !== undefined) params[key] = raw.params[key];
        const pin = raw.pin && Number.isFinite(raw.pin.x) && Number.isFinite(raw.pin.y)
            ? { x: raw.pin.x, y: raw.pin.y } : null;
        const node = g.add(raw.kind, { id: String(raw.id || ''), params, pin });
        if (node) made.set(node.id, node);
    }
    for (const raw of Array.isArray(json.edges) ? json.edges : []) {
        if (!raw) continue;
        const a = made.get(String(raw.from)), b = made.get(String(raw.to));
        if (!a || !b) continue;
        g.connect(a, b, raw.port | 0, raw.fromPort | 0);
    }
    g.rev = 0;
    return g;
}

// ── running it ────────────────────────────────────────────────────────────

/// Evaluate every node, in an order that has each one's producers done first.
///
/// Returns `{ values, notes, order }` — `values` by node id (an input for a
/// `source`, a list of candidates for everything else), `notes` the sentence
/// each node's kind wants to say about what just happened, and `order` the walk
/// that was taken, which the tests assert against.
///
/// `ctx` is how this reaches the world, and it is a parameter rather than a set
/// of imports for one reason: it is the whole of what makes a graph's result
/// depend on something outside it, so a test hands over four functions and
/// evaluates a graph against a transcript that was never read from a file.
///
/// **A cycle answers empty rather than hanging.** `connect` refuses to make one,
/// so the only way to get here with one is a document written by another version
/// of this code — and a `.fbro` that locks the application up is a worse failure
/// than one node that says it is in a loop.
export function evaluate(g, ctx) {
    const values = new Map();
    const notes = new Map();
    const order = [];
    const state = new Map();      // node id → 'running' | 'done'

    const run = (node) => {
        if (!node) return null;
        const was = state.get(node.id);
        if (was === 'done') return values.get(node.id);
        if (was === 'running') {
            notes.set(node.id, 'this is in a loop');
            return emptyFor(node);
        }
        state.set(node.id, 'running');

        const kind = N.kindOf(node);
        const ins = [];
        if (kind) {
            for (let port = 0; port < kind.ins.length; port++) {
                const edge = g.inEdges(node).find((e) => e.port === port);
                // **An unwired socket is `null`, not an empty list**, and that
                // is the same distinction `coverageOf` and `marksOf` make one
                // file over: nothing is connected here and a stack arrived with
                // nothing in it are different states, and only the first is a
                // wire somebody has not drawn. A `Mix` that could not tell them
                // apart said "wire two stacks in" over two wires that were
                // plainly there. Every `run` below reads `ins[n] || []`, so this
                // costs the arithmetic nothing and buys the notes the truth.
                ins.push(edge ? run(g.node(edge.from)) : null);
            }
        }

        let value = emptyFor(node);
        if (kind) {
            try {
                value = kind.run(node, ins, ctx);
            } catch (e) {
                // A rule that throws is a bug, and the node says so rather than
                // taking the stage down with it: a graph is eleven nodes and ten
                // of them were fine.
                notes.set(node.id, String((e && e.message) || e));
                value = emptyFor(node);
            }
        }
        values.set(node.id, value);
        if (!notes.has(node.id) && kind && kind.note)
            notes.set(node.id, kind.note(node, value, ctx, ins) || '');
        state.set(node.id, 'done');
        order.push(node.id);
        return value;
    };

    for (const n of g.nodes) run(n);
    return { values, notes, order };
}

/// What a node answers with when it could not run: an empty list for a stack,
/// null for a recording. One function, because "nothing" having two shapes is
/// exactly the kind of thing that comes out as `[].id` somewhere downstream.
///
/// This is a node's *output* and is deliberately not what an unwired input is —
/// see the walk above. A rule that produced nothing produced an empty stack; a
/// socket with no wire on it produced no answer at all.
function emptyFor(node) {
    const k = N.kindOf(node);
    if (!k || !k.outs.length) return [];
    return k.outs[0] === N.INPUT ? null : [];
}

/// Every `stack` node, with what it holds. What the stage's list draws and what
/// the spine counts — the sinks are the graph's answer, exactly as the muxer's
/// mapped pads are the filter graph's.
export function stacksOf(g, result) {
    return g.nodes
        .filter((n) => n.kind === 'stack')
        .map((n) => ({
            node: n,
            name: String(n.params.name || '').trim() || 'unnamed',
            list: result.values.get(n.id) || [],
        }));
}

// ── where they go on the canvas ───────────────────────────────────────────

/// The layout, which is `ui/graph/layout.js`'s — the same columns-are-depth,
/// rows-are-a-chain arithmetic, imported rather than reimplemented. What it
/// needs that this graph has to supply is which *kind of value* a node puts out,
/// because that is what the wires are coloured by; the filter graph answers `v`,
/// `a` or `s` there and this one answers `input` or `stack`.
export function layoutFind(g, sizeOf) {
    return placeNodes(g, sizeOf, (n) => n.pin, {
        of: (n) => (N.portKinds(n, 'out')[0] === N.INPUT ? N.INPUT : N.STACK),
    });
}
