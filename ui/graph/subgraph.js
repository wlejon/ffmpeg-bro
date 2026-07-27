// The graph, cut off at one node.
//
// A node on this screen states what it does. What it does not state is what
// comes out of it, and that is the thing you actually want to see — a `crop`
// with four expressions in it is a claim about a picture, and the claim is
// either right or it is a bug you find at the end of a render.
//
// So: take the derived graph, throw away everything the chosen node does not
// depend on, and end it there. What that produces is a `-filter_complex` like
// any other, which means the renderer already knows how to run it — the same
// `GraphSource` the real export goes through, fed by the same readers. **A
// preview is not a second implementation of anything.** If the node's output
// looks wrong here, it is wrong in the render.
//
// Two things make it cheap enough to do per node:
//
// - **Only the ancestors are kept.** A ten-node graph previewed at its first
//   `trim` opens one file and runs one filter, not ten.
// - **The render is bounded and scaled down.** A couple of seconds, and a
//   `scale` on the end that fits the picture into the card it will be drawn
//   in. The scale is part of the graph rather than a setting because nothing
//   outside libavfilter knows how big the picture is half way through — which
//   is also why the render is told to take its size from the graph
//   (`sizeFromGraph`) instead of being given one.
//
// The audio nodes get no picture. A waveform of a pad is a real thing to want
// and it is not a smaller version of this: it needs the samples, not a file to
// play, and `analysis.js` already knows how to draw one.

import { print } from './print.js';
import { inputsOf } from '../filtergraph.js';

/// Everything `node` depends on, `node` included.
function ancestors(g, node) {
    const keep = new Set([node.id]);
    const queue = [node];
    while (queue.length) {
        const n = queue.shift();
        for (const p of g.producers(n))
            if (!keep.has(p.id)) { keep.add(p.id); queue.push(p); }
    }
    return keep;
}

/// A view of `g` holding only `keep`. Not a copy: `print()` and `inputsOf()`
/// ask a graph four questions and all four can be answered by filtering, so
/// rebuilding the nodes would be work whose only product is a second set of
/// objects to keep in step.
function pruned(g, keep) {
    const nodes = g.nodes.filter((n) => keep.has(n.id));
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

/// A graph that ends at `node`, ready to hand to `bro.ffmpeg.render.start`.
///
/// Returns `{ ok: true, filterGraph, filterInputs, from, length }` or
/// `{ ok: false, reason }`. `fit` is the longest side the picture is scaled
/// into; `seconds` is how much of it to render.
///
/// The node's own label is dropped and replaced with one this owns, because
/// the pad a preview maps has to be named whatever happens to be at the end —
/// which for a node in the middle of a chain is nothing, and `print()` would
/// invent a name that nothing else here would know.
export function previewGraph(g, node, opts = {}) {
    if (!node) return { ok: false, reason: 'no node' };
    if (node.stream === 'a') return { ok: false, reason: 'a waveform is not a small picture' };
    // An input node is a file, not a stream, so which of its pads is being
    // asked about is a question that has to be answered rather than read off
    // the node: a preview is a picture, and a picture comes from its video pad.
    const videoPort = node.kind === 'input'
        ? (node.outs || []).findIndex((o) => o.stream === 'v') : -1;
    if (node.kind === 'input' && videoPort < 0)
        return { ok: false, reason: 'this input is not read for a picture' };
    // A sink is not a picture of its own — it is the pad the muxer maps, and
    // what it shows is whatever its producer hands it. Following the wire is
    // worth doing rather than refusing, because the sink at the end of the
    // picture side is the one node on this screen that means *the render*, and
    // it is the first thing anybody clicks.
    if (node.kind === 'sink') {
        const from = g.producers(node)[0];
        return from ? previewGraph(g, from, opts)
                    : { ok: false, reason: 'nothing is mapped here' };
    }

    const keep = ancestors(g, node);
    const view = pruned(g, keep);
    if (!view.nodes.some((n) => n.kind === 'input') &&
        !view.nodes.some((n) => n.filter === 'color'))
        return { ok: false, reason: 'nothing feeds this node' };

    // An input node is not a filter and cannot be a chain on its own, so
    // previewing one is previewing the stream itself: the tail chain reads
    // `[0:v]` directly and there is no body.
    //
    // `trunc(iw/2)*2` keeps the width even and `h=-2` keeps the height even
    // and the aspect right, which between them are what stop an odd size
    // reaching an encoder that has no half pixels.
    const fit = Math.max(64, Math.round(opts.fit || 320));
    const chains = node.kind === 'input' ? [] : print(view).chains;
    const head = node.kind === 'input'
        ? `${node.index}:${node.outs[videoPort].stream}`
        : padAtEndOf(chains, node);
    chains.push(`[${head}]scale=w='min(${fit}\\,trunc(iw/2)*2)':h=-2[pv]`);

    // The pads this subgraph reads, which for an input node previewed on its
    // own is the one the chain above names — the file's sound is not decoded to
    // draw a still of its picture.
    const inputs = node.kind === 'input'
        ? [{ label: head, path: node.path, stream: node.outs[videoPort].stream,
             from: node.from || 0 }]
        : inputsOf(view);
    return { ok: true, filterGraph: chains.join(';'), filterInputs: inputs, pad: '[pv]' };
}

/// What the node at the end of the last chain is called.
///
/// `print()` uses a node's own label where it has one and invents `x0`, `x1`…
/// where it does not — and pruning a run in half routinely leaves the new last
/// node unlabelled, because only chain-final nodes in the *whole* graph carry a
/// name. Reading it back off the chain is the only way to know which happened
/// without writing the rule down a second time.
function padAtEndOf(chains, node) {
    const last = chains[chains.length - 1] || '';
    const m = /\[([^\]]+)\]$/.exec(last);
    return m ? m[1] : node.label || 'x0';
}
