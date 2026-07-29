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
// **A recording writes the pads it names, and runs the part of the graph that
// produces them.** That is the whole rule, and it is ffmpeg's: an invocation
// maps some labels and libavfilter runs whatever those labels need. So the walk
// starts at the sinks the recording writes and goes *up*, and everything it
// does not reach is somebody else's render. Not a graph of its own, because
// there is only one document and only one editor for it; not the whole graph
// either, because most of what is on that stage is about the timeline and a
// camera has nothing to do with it.
//
// **Which sinks?** By default the derivation's own two — video out and sound
// out — because that is where a person wires something when the graph has only
// one end. But those two are also where a *render* ends, and one pad cannot be
// both the timeline's composite and the cameras', so a recording may instead
// name an output somebody placed. `pads` is how it says which, and the rest of
// this file does not care: a sink is a sink and the walk is the same.
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
//   - **The unchosen ends are not walked into at all.** Walking up cannot reach
//     a sink, so an output this recording did not name costs nothing to ignore
//     and a graph that feeds both a render and a recording is an ordinary graph
//     rather than an error. That is the whole reason the walk runs this way
//     round rather than down from the devices.
//   - **The pads are renumbered.** The derivation numbers `-i`s in the order
//     the nodes were placed; a recording numbers them in the order its cards
//     are in, because that order is `CaptureSettings::sources` and the two have
//     to agree. Renumbering here rather than reordering the cards keeps the
//     numbering where `print.js` already says it lives — on the input node.
//
// **`vout` and `aout` are imposed, and that is the one thing here that is not
// derived.** `resolvePads` maps those two labels and the engine has said so
// since before there was a graph stage; a recording is its own invocation with
// its own muxer, so whatever the graph called the pad — `out2`, or nothing at
// all — the node feeding it is relabelled on the way out. `subgraph.js` does
// exactly this for a preview and for the same reason: the pad a caller has to
// map cannot be whatever happened to be at the end.

import { derive } from './derive.js';
import { print } from './print.js';
import { specInputs, specInputInfo, byId, indexOf } from '../inputs.js';

/// Which placed nodes read one of these inputs, by document input id.
function seedRecords(overlay, ids) {
    return ((overlay && overlay.nodes) || [])
        .filter((rec) => rec.kind === 'input' && ids.indexOf(rec.input) >= 0);
}

/// Everything `from` depends on, following producers.
function ancestors(g, from) {
    const seen = new Set(from.map((n) => n.id));
    const queue = from.slice();
    while (queue.length) {
        for (const next of g.producers(queue.shift()))
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
    const nodes = g.nodes.filter((n) => keep.has(n.id)).map((n) => {
        const copy = Object.assign({}, n, n.kind === 'input' ? { index: numberOf(n) } : null);
        // Shallow-copied above, and this one is written to below. Left shared,
        // relabelling a fork's pad would reach back into the derivation the
        // caller still holds.
        if (copy.outLabels) copy.outLabels = copy.outLabels.slice();
        return copy;
    });
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

/// What a sink is called on the screen, for a sentence about it.
function sinkName(n) {
    if (!n) return 'an output';
    if (n.name) return `[${n.name}]`;
    return (n.stream || 'v') === 'a' ? 'sound out' : 'video out';
}

/// The sink this recording writes for `stream`, or null when it writes none.
///
/// `pick` is an overlay node id, or empty for the derivation's own end. Looked
/// up by id rather than by name so that renaming an output on the Graph stage
/// moves the recording with it — the name is what ffmpeg reads, the id is what
/// this application means. `undefined` back means the pick names nothing that
/// could be written: an output that has been deleted, or one whose first wire
/// has since made it the other kind of stream.
function chosen(g, stream, pick) {
    if (pick) {
        const n = g.node(pick);
        if (!n || n.kind !== 'sink') return undefined;
        return !n.stream || n.stream === stream ? n : undefined;
    }
    return g.byAnchor(stream === 'a' ? 'out:a' : 'out:v') || null;
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
/// null where the recording writes nothing of that kind.
///
/// `ids` is the recording's inputs in `-i` order, which is `capture.inputs`.
/// `overlay` is the user's layer and `pads` is `{ v, a }` of overlay sink ids,
/// both passed in for the reason `derive()` takes its overlay that way: a pure
/// function of its arguments is one a test can hand literals to.
export function recordGraph(ids, overlay, pads) {
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

    const picked = { v: (pads && pads.v) || '', a: (pads && pads.a) || '' };
    const at = { v: chosen(g, 'v', picked.v), a: chosen(g, 'a', picked.a) };
    for (const stream of ['v', 'a'])
        if (at[stream] === undefined)
            return { ok: false, reason: 'the output this recording writes is not on the ' +
                                        'Graph stage any more — pick another' };

    // Up from the sinks, so a `testsrc` two filters above an `overlay` comes
    // with it and an output nobody named here is never reached.
    const ends = [at.v, at.a].filter(Boolean);
    const keep = ancestors(g, ends);

    // Nothing this recording opens reaches what it writes. Two ways to be in
    // that state and they want different sentences: with the derivation's own
    // ends it is a graph nobody finished wiring, and with an output of one's
    // own it is very likely the wrong output.
    if (!seedNodes.some((n) => keep.has(n.id))) {
        const named = picked.v || picked.a;
        if (named)
            return { ok: false, reason: `${sinkName(at.v || at.a)} is fed by something other ` +
                                        'than these devices, so a recording of them would ' +
                                        'write a file nothing they see reaches' };
        const outs = g.nodes.filter((n) => n.kind === 'sink' && n.name).length;
        return { ok: false, reason: 'the graph reads the devices but nothing arrives at video ' +
                                    'out or sound out' + (outs
                                        ? ' — this graph has outputs of its own, and a ' +
                                          'recording can write one of those instead'
                                        : '') };
    }

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
    // knows. Cleared off everything else first, for the reason
    // `nameTheRendersPads` clears them: two chains ending in `[vout]` is "Label
    // found twice", about a graph ffmpeg has already half parsed.
    const extra = [];
    for (const stream of ['v', 'a']) {
        const sink = at[stream];
        const label = stream === 'v' ? 'vout' : 'aout';
        for (const n of view.nodes) {
            if (n.label === label) n.label = null;
            if (n.outLabels) n.outLabels = n.outLabels.map((l) => (l === label ? null : l));
        }
        if (!sink) continue;
        const e = view.inEdges(sink)[0];
        const src = e ? view.node(e.from) : null;
        if (!src) { at[stream] = null; continue; }
        const port = e.fromPort || 0;
        // A device wired straight to a sink is a stream with no filter on it,
        // and there is no chain for a label to go on the end of. `null`/`anull`
        // is the chain that says "this pad, unchanged" — the same one a
        // single-microphone preset used to write, and needed for the same
        // reason: with a graph in play every stream reaches a pad or the engine
        // refuses.
        if (src.kind === 'input') {
            const out = (src.outs || [])[port];
            extra.push(`[${src.index}:${(out && out.stream) || stream}]` +
                       `${stream === 'v' ? 'null' : 'anull'}[${label}]`);
        } else if (src.outs && src.outs.length > 1) {
            // A `split` writes two pads and one `label` would name neither of
            // them honestly, so a fork's names are per pad. See `padOf`.
            if (!src.outLabels) src.outLabels = [];
            src.outLabels[port] = label;
        } else src.label = label;
    }

    if (!at.v && !at.a)
        return { ok: false, reason: 'the graph reads the devices but nothing arrives at ' +
                                    'video out or sound out' };

    const { chains } = print(view);
    return { ok: true, filterGraph: chains.concat(extra).join(';'),
             video: at.v ? 'vout' : null, audio: at.a ? 'aout' : null, graph: view };
}

/// The ends this recording could write, for the picker on the Capture stage.
///
/// `{ v: [{ id, label }], a: [...] }`, the derivation's own end first with an
/// empty id. Answered here rather than read off the overlay by the caller
/// because "which sinks could this recording write" is the same question
/// `chosen()` asks, and two answers to it would be two things that can
/// disagree.
///
/// An output nobody has wired yet is in neither list. Its stream is what the
/// first wire brought and it has had none, so there is no honest side of the
/// picker to put it on — and a recording of it would refuse anyway, for having
/// nothing wired in.
export function recordPads(overlay) {
    const out = { v: [{ id: '', label: 'video out' }], a: [{ id: '', label: 'sound out' }] };
    for (const n of ((overlay && overlay.nodes) || [])) {
        if (n.kind !== 'sink' || !n.name || (n.stream !== 'v' && n.stream !== 'a')) continue;
        out[n.stream].push({ id: n.id, label: `[${n.name}]` });
    }
    return out;
}
