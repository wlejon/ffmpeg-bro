// The edit, written as the filtergraph that would produce it.
//
// ffmpeg-bro does not shell out. `ffmpeg_export.cpp` decodes each clip into an
// RGBA canvas, composites, swscales to the encoder's pixel format and encodes.
// So a command line offered to the user is two different kinds of statement and
// has to be drawn as two: the encoder options are *exact* — they are literally
// the keys handed to `av_opt_set` — and the composition is *equivalent*. This
// file is the equivalent half.
//
// It is now two steps rather than one, and they are worth separating because
// they change for different reasons. `graph/derive.js` turns the edit into
// nodes and wires; `graph/print.js` turns nodes and wires into the chains
// `-filter_complex` wants. Derivation changes when the application learns to
// express something new; printing changes when ffmpeg's syntax does, which is
// to say never. Between them sits a graph that can be shown, edited and — once
// the renderer can parse one — run, which is the whole point of having pulled
// them apart.
//
// This module stays because the shape it presents is the one every caller
// wants: one call, one answer, refusals included. `ui/command.js` does not know
// a graph exists.

import { derive, outputColor } from './graph/derive.js';
import { print } from './graph/print.js';

export { outputColor };

/// The files a graph's input pads read, in the shape `render.start` wants.
///
/// Taken from the input nodes rather than passed alongside them, so `[0:v]` in
/// a chain and input number zero are one fact rather than two that can
/// disagree. `from` is the seek — see `ExportGraphInput` — and it is here
/// rather than in the printed chains because a command line says it with `-ss`
/// and this application says it by handing the renderer a number.
///
/// One entry per *pad that is read*, not per node: an input node is a file and
/// a file has an output per stream, so `[0:v]` and `[0:a]` are two lines here
/// and one `-i`. A pad nothing in the graph reads is left out rather than
/// listed and ignored — the renderer opens a reader per entry, and a subgraph
/// cut down to one clip's picture must not be the reason its sound is decoded.
///
/// Exported because a preview of one node needs the same list for a subgraph.
export function inputsOf(graph) {
    const out = [];
    for (const n of graph.nodes) {
        if (n.kind !== 'input' || !n.path) continue;
        const outs = n.outs && n.outs.length ? n.outs : [{ stream: n.stream || 'v' }];
        const read = new Set(graph.outEdges(n).map((e) => e.fromPort || 0));
        outs.forEach((o, i) => {
            if (!read.has(i)) return;
            out.push({ label: `${n.index}:${o.stream}`, path: n.path,
                       stream: o.stream, from: n.from || 0 });
        });
    }
    return out;
}

/// `buildSpec()`'s output → the inputs and the graph that would render it.
///
/// Returns `{ ok: true, inputs, chains, video, audio, colour, caveats, graph }`
/// — `chains` being the filtergraph's semicolon-separated parts, unjoined, so
/// the caller can lay them out one per line or all on one. `video` and `audio`
/// are the pad names to map, and `graph` is what they were printed from. On
/// refusal: `{ ok: false, reason }`, and the caller must say so rather than
/// print a graph.
///
/// `sources` is optional and runs parallel to `spec.clips`: what
/// `bro.ffmpeg.probe()` said about each clip's video stream, which is where the
/// colour tags come from. Without it the graph is still correct in geometry and
/// timing but leaves the source matrices to swscale's guess, and `caveats` says
/// so — the difference is a visible colour cast, not rounding.
export function filtergraph(spec, sources, opts) {
    const d = derive(spec, sources, opts);
    if (!d.ok) return d;
    const { chains, inputs, video, audio } = print(d.graph);
    return { ok: true, inputs, chains, video, audio, colour: d.colour,
             caveats: d.caveats, graph: d.graph, overrides: d.overrides };
}

/// The same graph, in the two fields `bro.ffmpeg.render.start` wants to render
/// *through* libavfilter rather than through the internal compositor:
/// `{ ok: true, filterGraph, filterInputs }`.
///
/// Two differences from what `filtergraph()` returns, both of them because the
/// renderer is not a standalone ffmpeg. The graph stops in the compositing
/// space — see `derive`'s `forRender` — and the inputs are named rather than
/// numbered, because `[0:v]` and `-i` number zero are one fact on a command
/// line and two separate statements here. Taking both from the graph's own
/// input nodes is what keeps them from disagreeing.
export function renderGraph(spec, sources, opts) {
    const d = derive(spec, sources, Object.assign({}, opts, { forRender: true }));
    if (!d.ok) return d;
    const { chains } = print(d.graph);
    const filterInputs = inputsOf(d.graph);
    return { ok: true, filterGraph: chains.join(';'), filterInputs,
             caveats: d.caveats, graph: d.graph };
}
