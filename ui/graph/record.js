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
//   - **A source filter is pulled in, an `-i` is refused.** `[0:v][1:v]overlay`
//     where `[1:v]` is a `testsrc` is fine — a filter with no inputs makes its
//     own frames — and so is `movie=card.png`, which is the same kind of node
//     and happens to read a file: libavfilter opens it itself and, in a graph
//     driven by pushing at a buffersrc and draining a buffersink, asks it for
//     one frame per output frame and no more. What is refused is an **input
//     node**, because its pad would be a buffersrc this recording pushes device
//     frames into and there is nothing pushing a file. See the top of
//     `capture_graph.h`, where the same distinction is stated from the other
//     end, and tests/capture_test.cpp, where both halves are measured.
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
//
// **A recording writes several files, so `pads` is a list.** One reading of the
// devices, one graph, and a muxer per file on the end of it — the cameras into
// one and a cropped copy into another is two `-map`s of two pads, which is what
// `-f tee` is not. Nothing about the walk changes: the ends are every sink any
// file names, and what each file gets back is the label of the pad it picked.
//
// **One label per sink and not per file**, because two files can name the same
// one — a master and a smaller copy of the same picture — and labelling a chain
// twice is "Label found twice", about a graph ffmpeg has already half parsed.
// Only file 0's ends get `vout`/`aout`; anything else keeps the name it has on
// the Graph stage, and a second file pointed at the derivation's own end (which
// has no name) gets one made from its position in the list.

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
/// `overlay` is the user's layer and `pads` is the files this recording writes,
/// as `{ v, a }` of overlay sink ids — a list of them, or one on its own for
/// the recording that writes one file. Both passed in for the reason `derive()`
/// takes its overlay that way: a pure function of its arguments is one a test
/// can hand literals to.
///
/// `files` comes back beside `video`/`audio`, which stay what they were: file
/// zero's two pads, because that is the answer every caller wanted before there
/// was more than one file and it is still the answer they want.
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

    const wanted = (Array.isArray(pads) ? pads : [pads || {}])
        .map((p) => ({ v: (p && p.v) || '', a: (p && p.a) || '' }));
    if (!wanted.length) wanted.push({ v: '', a: '' });
    const at = wanted.map((p) => ({ v: chosen(g, 'v', p.v), a: chosen(g, 'a', p.a) }));
    for (const f of at)
        for (const stream of ['v', 'a'])
            if (f[stream] === undefined)
                return { ok: false, reason: 'the output this recording writes is not on the ' +
                                            'Graph stage any more — pick another' };

    // Up from the sinks, so a `testsrc` two filters above an `overlay` comes
    // with it and an output nobody named here is never reached. **Every file's**
    // — a second file is a second thing to keep, and a branch that only it reads
    // is exactly as much a part of this recording as the first file's.
    const ends = [];
    for (const f of at)
        for (const sink of [f.v, f.a])
            if (sink && ends.indexOf(sink) < 0) ends.push(sink);
    const keep = ancestors(g, ends);

    // Nothing this recording opens reaches what it writes. Two ways to be in
    // that state and they want different sentences: with the derivation's own
    // ends it is a graph nobody finished wiring, and with an output of one's
    // own it is very likely the wrong output.
    if (!seedNodes.some((n) => keep.has(n.id))) {
        const named = wanted.some((p) => p.v || p.a);
        if (named)
            return { ok: false, reason: `${sinkName(ends[0])} is fed by something other ` +
                                        'than these devices, so a recording of them would ' +
                                        'write a file nothing they see reaches' };
        const outs = g.nodes.filter((n) => n.kind === 'sink' && n.name).length;
        return { ok: false, reason: 'the graph reads the devices but nothing arrives at video ' +
                                    'out or sound out' + (outs
                                        ? ' — this graph has outputs of its own, and a ' +
                                          'recording can write one of those instead'
                                        : '') };
    }

    // An `-i` that is not one of this recording's is a file, and a recording's
    // `-i` list is its devices. Named rather than summarised, because the fix
    // is about one node and nothing else says which.
    //
    // **The refusal is about the `-i` and not about the file**, which is the
    // correction this sentence has just been through. An input pad of a
    // capture's graph is a buffersrc the recording loop pushes device frames
    // into; a file has nothing pushing it, and pulling one is what a device
    // cannot be asked for. A `movie` node is not one of those pads at all — it
    // is a filter with no inputs, which libavfilter reads for itself, and in a
    // graph driven by push-and-drain it is pulled exactly once per output frame
    // by whatever it feeds. So the file *can* be in the graph; it is the `-i`
    // that cannot, and the way through is named here rather than left to be
    // discovered.
    for (const n of g.nodes) {
        if (!keep.has(n.id) || n.kind !== 'input') continue;
        if (numberOf(n) < 0)
            return { ok: false, reason: `the graph feeds ${n.title || n.path || 'an input'} ` +
                                        'into the recording as an -i, and a recording’s ' +
                                        'inputs are its devices — read it with a movie node ' +
                                        'instead, which the graph pulls in step with them' };
    }

    // **Only the problems this recording would hit.** A half-wired node on the
    // other side of the stage is an ordinary state of a graph somebody is in
    // the middle of building, and a Record button that went dead for it would
    // be reporting the render's business as the recording's. What is left is
    // exactly the set of nodes the walk above says will run.
    const wrong = (d.problems || []).filter((p) => p.id && keep.has(p.id));
    if (wrong.length) return { ok: false, reason: wrong[0].reason };

    const view = pruned(g, keep, numberOf);

    // **What each pad is going to be called.** One name per sink whatever the
    // number of files reading it, worked out before anything is written so that
    // the clearing below knows every name it has to make room for.
    const label = new Map();        // sink node id → the label its chain gets
    for (let i = 0; i < at.length; ++i)
        for (const stream of ['v', 'a']) {
            const sink = at[i][stream];
            if (!sink || label.has(sink.id)) continue;
            const imposed = stream === 'v' ? 'vout' : 'aout';
            const used = (name) => {
                for (const v of label.values()) if (v === name) return true;
                return false;
            };
            // File zero's ends are `vout` and `aout` because that is what
            // `resolvePads` maps with nothing said. Every other file names its
            // pad, and the name it names is the one on the Graph stage — so a
            // person reading the printed command sees the output they wired.
            let own = i === 0 ? imposed : (sink.name || `${imposed}${i}`);
            // A name two things want is one thing named wrong. Counted up
            // rather than refused: the collision is between what somebody wrote
            // on the Graph stage and what this file has to be called, and
            // neither of those is a mistake to report.
            for (let n = i; used(own); ++n) own = `${imposed}${n + 1}`;
            label.set(sink.id, own);
        }

    // Relabelled to the names the writer maps, cleared off everything else
    // first, for the reason `nameTheRendersPads` clears them: two chains ending
    // in `[vout]` is "Label found twice", about a graph ffmpeg has already half
    // parsed.
    const extra = [];
    const ours = new Set(label.values());
    for (const n of view.nodes) {
        if (ours.has(n.label)) n.label = null;
        if (n.outLabels) n.outLabels = n.outLabels.map((l) => (ours.has(l) ? null : l));
    }
    for (let i = 0; i < at.length; ++i)
        for (const stream of ['v', 'a']) {
            const sink = at[i][stream];
            if (!sink) continue;
            const name = label.get(sink.id);
            const e = view.inEdges(sink)[0];
            const src = e ? view.node(e.from) : null;
            // An end nothing is wired into writes nothing, and the file simply
            // has no stream of that kind. Dropped rather than refused: a
            // recording of a screen grab has no sound out wired and never had.
            if (!src) { at[i][stream] = null; continue; }
            const port = e.fromPort || 0;
            // A device wired straight to a sink is a stream with no filter on
            // it, and there is no chain for a label to go on the end of.
            // `null`/`anull` is the chain that says "this pad, unchanged" — the
            // same one a single-microphone preset used to write, and needed for
            // the same reason: with a graph in play every stream reaches a pad
            // or the engine refuses.
            if (src.kind === 'input') {
                const out = (src.outs || [])[port];
                // Once per sink, not once per file reading it: the chain is the
                // pad, and printing it twice is the same "Label found twice".
                if (extra.every((c) => c.indexOf(`[${name}]`) < 0))
                    extra.push(`[${src.index}:${(out && out.stream) || stream}]` +
                               `${stream === 'v' ? 'null' : 'anull'}[${name}]`);
            } else if (src.outs && src.outs.length > 1) {
                // A `split` writes two pads and one `label` would name neither
                // of them honestly, so a fork's names are per pad. See `padOf`.
                if (!src.outLabels) src.outLabels = [];
                src.outLabels[port] = name;
            } else src.label = name;
        }

    const files = at.map((f) => ({
        video: f.v ? label.get(f.v.id) : null,
        audio: f.a ? label.get(f.a.id) : null,
    }));
    // A file that maps neither a picture nor a sound is a file of nothing, and
    // for file zero that is the whole recording. Named by position, because
    // with several of them "the recording writes nothing" would not say which.
    for (let i = 0; i < files.length; ++i)
        if (!files[i].video && !files[i].audio)
            return { ok: false, reason: i === 0
                ? 'the graph reads the devices but nothing arrives at video out or sound out'
                : `file ${i + 1} of this recording maps nothing — the output it writes has ` +
                  'nothing wired into it' };

    const { chains } = print(view);
    return { ok: true, filterGraph: chains.concat(extra).join(';'),
             video: files[0].video, audio: files[0].audio, files, graph: view };
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
