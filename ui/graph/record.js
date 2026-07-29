// The recording, as the graph would run it.
//
// A recording used to carry its own `-filter_complex` in a textarea on the
// Capture stage, with three buttons that wrote one out of string concatenation.
// That was the right thing while a device was a private object this application
// had no other name for. It is not now: a device is a document input, so it is
// already a node the Graph stage can place, wire and preview — and a second
// place to describe a composition is a second thing to keep in step with what
// the engine will do.
//
// **A recording's graph is the part of the document's graph its devices feed.**
// Not a graph of its own, because there is only one document and only one
// editor for it; not the whole graph either, because most of what is on that
// stage is about the timeline and a camera has nothing to do with it. So:
// start at the input nodes that are this recording's `-i`s, take everything
// downstream of them, take whatever else feeds those nodes, and that is the
// recording. Everything the walk does not reach is somebody else's render.
//
// Three consequences worth stating, because each replaces a rule that used to
// be written down twice:
//
//   - **A generator is pulled in, a file is refused.** `[0:v][1:v]overlay`
//     where `[1:v]` is a `testsrc` is fine — a filter with no inputs makes its
//     own frames and `CaptureGraph` never has to pull one. A file is a refusal
//     naming the file, because the push shape has nobody to ask for its next
//     frame: see the top of `capture_graph.h`, where the same fact is stated
//     from the other end.
//   - **A named output is not the recording's.** `out2` is a pad a stream on
//     the Write stage asks for by name, and a recording writes its own file
//     with its own muxer. Those sinks are dropped from the walk rather than
//     refused, so a graph that feeds both a render and a recording is an
//     ordinary graph rather than an error.
//   - **The pads are renumbered.** The derivation numbers `-i`s in the order
//     the nodes were placed; a recording numbers them in the order its cards
//     are in, because that order is `CaptureSettings::sources` and the two have
//     to agree. Renumbering here rather than reordering the cards keeps the
//     numbering where `print.js` already says it lives — on the input node.
//
// **`vout` and `aout` are imposed, and that is the one thing here that is not
// derived.** `resolvePads` maps those two labels and the engine has said so
// since before there was a graph stage; a derived recording has no composite to
// have named them, so the node feeding each sink is relabelled on the way out.
// `subgraph.js` does exactly this for a preview and for the same reason — the
// pad a caller has to map cannot be whatever happened to be at the end.

import { derive } from './derive.js';
import { print } from './print.js';
import { specInputs, specInputInfo, byId, indexOf } from '../inputs.js';

/// Which placed nodes read one of these inputs, by document input id.
function seedRecords(overlay, ids) {
    return ((overlay && overlay.nodes) || [])
        .filter((rec) => rec.kind === 'input' && ids.indexOf(rec.input) >= 0);
}

/// Everything reachable from `from`, following `step` — consumers for the walk
/// down, producers for the walk back up.
function closure(g, from, step) {
    const seen = new Set(from.map((n) => n.id));
    const queue = from.slice();
    while (queue.length) {
        for (const next of step(queue.shift()))
            if (next && !seen.has(next.id)) { seen.add(next.id); queue.push(next); }
    }
    return seen;
}

/// A view of `g` holding only `keep`, with the input nodes renumbered.
///
/// The same filtering trick `subgraph.js` uses — `print()` asks a graph four
/// questions and all four can be answered by filtering the node and edge lists
/// rather than rebuilding them. The one difference is that the nodes here *are*
/// copied: an input's `index` changes and a chain-final node is relabelled, and
/// the graph both came out of is the one on the screen.
function pruned(g, keep, numberOf) {
    const nodes = g.nodes.filter((n) => keep.has(n.id)).map((n) =>
        Object.assign({}, n, n.kind === 'input' ? { index: numberOf(n) } : null));
    const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    const view = { nodes, edges };
    const idOf = (n) => (typeof n === 'string' ? n : n && n.id);
    view.node = (n) => nodes.find((x) => x.id === idOf(n)) || null;
    view.byAnchor = (a) => (a ? nodes.find((x) => x.anchor === a) || null : null);
    view.inEdges = (n) => {
        const id = idOf(n);
        return edges.filter((e) => e.to === id).sort((a, b) => a.port - b.port);
    };
    view.outEdges = (n) => edges.filter((e) => e.from === idOf(n));
    view.producers = (n) => view.inEdges(n).map((e) => view.node(e.from)).filter(Boolean);
    view.consumers = (n) => view.outEdges(n).map((e) => view.node(e.to)).filter(Boolean);
    return view;
}

/// The node the muxer would take this stream from, and the sink that says so.
function feeding(view, stream) {
    for (const n of view.nodes) {
        if (n.kind !== 'sink' || n.name || n.stream !== stream) continue;
        const e = view.inEdges(n)[0];
        if (e) return { node: view.node(e.from), port: e.fromPort || 0 };
    }
    return null;
}

/// The `-filter_complex` a recording of `ids` would run, or null when the graph
/// says nothing about it.
///
/// Three answers rather than two, and the third is the common one. `null` means
/// no placed node reads any of these devices — the recording is whatever it was
/// before there was a graph stage, which for one device is the device written
/// straight through. `{ ok: false, reason }` means the graph *is* about this
/// recording and will not run; the Record button says so rather than starting a
/// job that fails a moment later. `{ ok: true, filterGraph, video, audio }` is a
/// graph, with `video`/`audio` naming the pads to map — `[vout]`, `[aout]`, or
/// null where nothing arrives there.
///
/// `ids` is the recording's inputs in `-i` order, which is `capture.inputs`.
/// `overlay` is the user's layer, passed in for the reason `derive()` takes it
/// that way: a pure function of its arguments is one a test can hand literals to.
export function recordGraph(ids, overlay) {
    const seeds = seedRecords(overlay, ids || []);
    if (!seeds.length) return null;

    // **An input node says which of the document's inputs it is by *index*, not
    // by id** — see `inputInfo` in derive.js, where the two are told apart. So
    // the recording's `-i` order, which is a list of ids, is turned into the
    // list of indices the nodes will be carrying, once, here. The position in
    // this array is the number the pad gets: `mine[2]` is `[2:v]`.
    const mine = (ids || []).map((id) => indexOf(byId(id)));
    const numberOf = (n) => mine.indexOf(n.input === undefined ? -1 : n.input);

    const d = derive({
        clips: [],
        inputs: specInputs(),
        inputInfo: specInputInfo(),
    }, null, { overlay, live: true, forRender: true });
    if (!d.ok) return { ok: false, reason: d.reason };

    const g = d.graph;
    const seedNodes = seeds.map((rec) => g.node(rec.id)).filter(Boolean);
    if (!seedNodes.length) return null;

    // Down from the devices, then back up from everything that reached, so a
    // `testsrc` two filters above an `overlay` comes with it. A named output is
    // not walked into at all: it belongs to a stream on the Write stage, and
    // following it would drag that whole branch into the recording.
    const isOurs = (n) => !(n.kind === 'sink' && n.name);
    const down = closure(g, seedNodes, (n) => g.consumers(n).filter(isOurs));
    const reached = g.nodes.filter((n) => down.has(n.id));
    const keep = closure(g, reached, (n) => g.producers(n));

    // An `-i` that is not one of this recording's is a file, and a file cannot
    // be pushed. Named rather than summarised, because the fix is to take that
    // node out of the branch the camera is in and nothing else says which one.
    for (const n of g.nodes) {
        if (!keep.has(n.id) || n.kind !== 'input') continue;
        if (numberOf(n) < 0)
            return { ok: false, reason: `the graph feeds ${n.title || n.path || 'an input'} ` +
                                        'into the recording, and a recording reads live ' +
                                        'inputs only — a file has nobody to push it' };
    }

    // **Only the problems this recording would hit.** A half-wired node on the
    // other side of the stage is an ordinary state of a graph somebody is in
    // the middle of building, and a Record button that went dead for it would
    // be reporting the render's business as the recording's. What is left is
    // exactly the set of nodes the walk above says will run.
    const wrong = (d.problems || []).filter((p) => p.id && keep.has(p.id));
    if (wrong.length) return { ok: false, reason: wrong[0].reason };

    const view = pruned(g, keep, numberOf);

    // The two pads the writer maps, relabelled to the names `resolvePads`
    // knows. Done before printing, because `print()` reads a node's label to
    // decide what its chain ends with — and after pruning, because the node
    // that ends a run in the recording is not always the one that ends it in
    // the whole graph.
    const at = { v: feeding(view, 'v'), a: feeding(view, 'a') };
    if (!at.v && !at.a)
        return { ok: false, reason: 'the graph reads the devices but nothing arrives at ' +
                                    'video out or sound out' };

    // A device wired straight to a sink is a stream with no filter on it, and
    // there is no chain for a label to go on the end of. `null`/`anull` is the
    // chain that says "this pad, unchanged" — the same one a single-microphone
    // preset used to write, and needed for the same reason: with a graph in
    // play every stream reaches a pad or the engine refuses.
    const extra = [];
    for (const stream of ['v', 'a']) {
        const to = at[stream];
        if (!to || !to.node) continue;
        const label = stream === 'v' ? 'vout' : 'aout';
        if (to.node.kind === 'input') {
            const out = (to.node.outs || [])[to.port];
            extra.push(`[${to.node.index}:${(out && out.stream) || stream}]` +
                       `${stream === 'v' ? 'null' : 'anull'}[${label}]`);
        } else {
            to.node.label = label;
        }
    }

    const { chains } = print(view);
    return { ok: true, filterGraph: chains.concat(extra).join(';'),
             video: at.v ? 'vout' : null, audio: at.a ? 'aout' : null, graph: view };
}
