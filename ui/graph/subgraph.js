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
// **The other reason to cut a graph off somewhere is to measure it there.**
// `Measure now` renders the whole thing: every clip decoded, every filter run,
// the composite built and the mix mixed, so that a `cropdetect` on one clip's
// decoded picture can say four numbers. Cutting at that node instead runs the
// filters it depends on and no others, and opens the files that feed it and no
// others — the same saving as a preview, for the same reason, and it is what
// makes measuring one point of a long edit cost what that point costs. What
// comes off the end differs, and `measureGraph` says why.
//
// **A sound pad gets a waveform, and it is drawn by libavfilter.** The same
// argument applies to `volume=0.6` as to a crop — it is a claim about a sound,
// and a card that only restated the argument would be the thing worth
// checking, unchecked. So the tail of an audio preview is `asplit` into two
// pads: one goes to `showwaves`, which turns those very samples into a picture,
// and one is the sound itself. The render that comes out is an ordinary video
// with an ordinary soundtrack, which is what lets a card play it through the
// same `<video>` and the same two-element swap every other node uses.
//
// Two things about that were decided by what the alternatives cost:
//
// - **Not `showwavespic`.** It draws the whole window as one still — which is
//   what the timeline's A1 lane looks like and is the nicer picture — but it
//   emits that frame only at end of input, so a card would show a waveform for
//   one frame and black for the rest of the loop. `showwaves` draws as it goes.
// - **Not our own canvas from `bro.media.peaks()`.** It would mean decoding the
//   render again to draw a second version of what is in it, and — because
//   bro's `<video>` refuses a file with no picture in it — a sound-only render
//   could not be played at all. One render, one file, seen and heard.

import { print } from './print.js';
import { streamsOf } from './model.js';
import { isSource } from './filters.js';
import { whereIs } from './check.js';
import { inputsOf } from '../filtergraph.js';

/// `--good`, as libavfilter spells a colour. The waveform is the same green the
/// timeline draws its audio lane in, because it is the same thing.
const WAVE = '0x7ed6a0';

/// How tall a waveform is next to how wide, and the aspect the card reserves
/// for one before the render lands. Shorter than a picture on purpose: a
/// waveform is read across, and 16:9 of mostly empty green is a card twice as
/// tall as it needs to be.
export const WAVE_ASPECT = 0.375;

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

/// The graph cut off at `node`, before anything is put on the end of it.
///
/// Returns `{ ok: true, view, chains, head, inputs, node, stream }` or
/// `{ ok: false, reason }` — `head` being the pad the chosen node leaves by and
/// `stream` which kind it is. Everything both callers below disagree about is
/// what they hang on `head`, so the cutting is here once: a preview scales the
/// pad into a card, a measurement takes it at its own size, and neither is
/// allowed a second opinion about which nodes the chosen one depends on.
function cutTo(g, node) {
    if (!node) return { ok: false, reason: 'no node' };
    // An input node is a file, not a stream, so which of its pads is being
    // asked about is a question that has to be answered rather than read off
    // the node: an input card shows the picture the file carries.
    // A file's **cues** are a picture too, once painted — so an input whose only
    // drawable pad is a bitmap subtitle track previews that pad rather than
    // refusing. Second, so a DVD rip's card still shows the film and not the
    // subtitles over nothing.
    const videoPort = node.kind === 'input'
        ? (() => {
              const outs = node.outs || [];
              const v = outs.findIndex((o) => o.stream === 'v');
              return v >= 0 ? v : outs.findIndex((o) => o.stream === 's');
          })()
        : -1;
    if (node.kind === 'input' && videoPort < 0)
        return { ok: false, reason: 'this input is not read for a picture' };
    // A sink is not a picture of its own — it is the pad the muxer maps, and
    // what it shows is whatever its producer hands it. Following the wire is
    // worth doing rather than refusing, because the sink at each end is the one
    // node on that side of the screen that means *the render*, and it is the
    // first thing anybody clicks.
    if (node.kind === 'sink') {
        const from = g.producers(node)[0];
        return from ? cutTo(g, from) : { ok: false, reason: 'nothing is mapped here' };
    }

    const keep = ancestors(g, node);
    const view = pruned(g, keep);
    // Something has to be producing frames at the top of it — a file, or a
    // filter that makes pictures out of nothing. The second is asked of
    // libavfilter rather than named, so a `testsrc` or a `mandelbrot` previews
    // for the same reason the derived black canvas does.
    if (!view.nodes.some((n) => n.kind === 'input' ||
                                (n.kind === 'filter' && isSource(n.filter))))
        return { ok: false, reason: 'nothing feeds this node' };

    // An input node is not a filter and cannot be a chain on its own, so
    // cutting at one is cutting at the stream itself: the tail chain reads
    // `[0:v]` directly and there is no body.
    const chains = node.kind === 'input' ? [] : print(view).chains;
    const head = node.kind === 'input'
        ? `${node.index}:${node.outs[videoPort].stream}`
        : padAtEndOf(chains, node);

    // The pads this subgraph reads, which for an input node cut on its own is
    // the one the chain above names — the file's sound is not decoded to draw a
    // still of its picture.
    const inputs = node.kind === 'input'
        ? [{ label: head, path: node.path, stream: node.outs[videoPort].stream,
             input: node.input === undefined ? -1 : node.input,
             from: node.from || 0 }]
        : inputsOf(view);

    // `node` travels back because a sink was followed to its producer above and
    // both callers ask a question *about the node they ended at*, not about the
    // one they named.
    return { ok: true, view, chains, head, inputs, node,
             stream: node.kind === 'input' ? 'v' : streamsOf(g).of(node) };
}

/// A graph that ends at `node`, ready to hand to `bro.ffmpeg.render.start`.
///
/// Returns `{ ok: true, filterGraph, filterInputs, pad, audio }` or
/// `{ ok: false, reason }`. `opts.fit` is the longest side the picture is
/// scaled into; `opts.fps` is the rate the render will walk at, which a
/// waveform has to be drawn at or the file plays fast.
///
/// `audio` says the render carries a soundtrack as well as a picture — which is
/// what a card needs to know to unmute it, and the only difference between the
/// two kinds of preview once the file exists.
///
/// The node's own label is dropped and replaced with one this owns, because
/// the pad a preview maps has to be named whatever happens to be at the end —
/// which for a node in the middle of a chain is nothing, and `print()` would
/// invent a name that nothing else here would know.
export function previewGraph(g, node, opts = {}) {
    const cut = cutTo(g, node);
    if (!cut.ok) return cut;
    const { chains, head, inputs } = cut;
    const fit = Math.max(64, Math.round(opts.fit || 320));

    if (cut.stream === 'a') {
        chains.push(...waveTail(head, fit, opts.fps));
        return { ok: true, filterGraph: chains.join(';'), filterInputs: inputs,
                 pad: '[pv]', audio: true };
    }

    // **A card is a picture on the screen, so it comes off the card first.**
    // The tail below is `scale`, which reads pixels, and a preview cut off
    // after an `hwupload` would be handing it a device handle — libavfilter's
    // refusal for which is four hundred format names and no filter. Nothing is
    // lost by downloading: the preview is drawn in a `<video>` at three hundred
    // pixels wide and was never going to stay on the card.
    //
    // **Asked of `check.js`, which is where that fact lives.** This used to be
    // a walk of its own, and it was one term short: it knew about `hwupload`,
    // `hwdownload` and a filter belonging to a device, and nothing about an
    // *input* that decodes on one — so previewing the card of a clip opened
    // with `-hwaccel cuda -hwaccel_output_format cuda` skipped the download and
    // failed with exactly the message the Graph stage exists to explain. The
    // three callers ask three different questions and share this one answer.
    const up = whereIs(cut.view, cut.node) === 'device';
    if (up) chains.push(`[${head}]hwdownload,format=nv12[hwdl]`);
    const shown = up ? 'hwdl' : head;

    // `trunc(iw/2)*2` keeps the width even and `h=-2` keeps the height even
    // and the aspect right, which between them are what stop an odd size
    // reaching an encoder that has no half pixels.
    chains.push(`[${shown}]scale=w='min(${fit}\\,trunc(iw/2)*2)':h=-2[pv]`);
    return { ok: true, filterGraph: chains.join(';'), filterInputs: inputs,
             pad: '[pv]', audio: false };
}

/// The same graph, cut off at `node`, for a render whose output is a *number*.
///
/// Returns `{ ok: true, filterGraph, filterInputs, pad, audio, nodes, inputs,
/// of }` or `{ ok: false, reason }`, where `nodes`/`inputs` are how much of the
/// graph is left and `of` how much there was — the two numbers a note has to
/// state, because a measurement over part of a graph is a claim about part of a
/// graph and nothing else on the screen says which part.
///
/// **Three differences from a preview, and every one of them is the same
/// reason: a number is not a picture.**
///
/// - **No `scale` on the end.** A preview is fitted into a card and a card is
///   three hundred pixels wide; `cropdetect` on that answers in the card's
///   pixels, which is four plausible numbers about a picture nobody is
///   rendering. So the pad is taken at whatever size libavfilter made it, which
///   is what `sizeFromGraph` is for.
/// - **No waveform.** `showwaves` exists so a sound can be *looked* at. A
///   measurement of a sound is read off `ebur128` or `astats`, both of which
///   have already said everything they have to say by the time a picture would
///   be drawn, and drawing one would be a video encode per measurement for
///   nobody.
/// - **No `hwdownload`.** A preview adds one because it is about to scale, and
///   scaling wants pixels. A measurement adds nothing to the graph, so what
///   happens at a pad on a device here is exactly what happens at that pad in
///   the render — which is the property that makes the answer worth having.
///
/// The tail is `null`/`anull` and it is there to give the pad a **name**: a pad
/// the muxer maps has to have one, and a node in the middle of a chain has
/// none. Nothing else was cheap enough to be certain about — `null` is
/// libavfilter's own way of writing "the same frames, called something else".
export function measureGraph(g, node) {
    const cut = cutTo(g, node);
    if (!cut.ok) return cut;
    const audio = cut.stream === 'a';
    const chains = cut.chains.slice();
    chains.push(`[${cut.head}]${audio ? 'anull[ma]' : 'null[mv]'}`);
    // **A render has a picture in it**, and the renderer says so: a graph whose
    // only output is a sound pad is refused with "the filter graph has no
    // picture coming out of it". Which is the right rule for the thing it was
    // written about — an output file — and leaves a cut at `ebur128` on the mix
    // with nowhere to go, since loudness is exactly the measurement somebody
    // wants at a sound pad.
    //
    // So the picture is supplied, and it is deliberately the *smallest thing
    // that is not the sound*: four black pixels once a second, which the null
    // encoder discards. Not `showwaves`, which is what a preview draws — that
    // is a video encode of a picture nobody is looking at, for every
    // measurement. Nothing is added to the path being measured: the pad reaches
    // the writer through `anull` and one filter, exactly as it does in the
    // render, which is the property the number is worth having for.
    if (audio) chains.push('color=c=black:s=2x2:rate=1[mv]');
    return { ok: true, filterGraph: chains.join(';'), filterInputs: cut.inputs,
             pad: audio ? '[ma]' : '[mv]', audio,
             nodes: cut.view.nodes.length, inputs: cut.inputs.length,
             of: g.nodes.length };
}

/// The two chains that turn a sound pad into something a card can show and
/// play: split it, draw one half, keep the other.
///
/// **`rate` has to be the render's own frame rate.** The writer stamps whatever
/// arrives at the output rate, so a waveform drawn at 25 fps inside a 30 fps
/// render is a picture that runs slow against its own sound — which reads as
/// the filter being wrong rather than as the preview being wrong.
///
/// **`showwaves` emits one blank frame before it emits any waveform**, and the
/// three filters after it are there for that and nothing else. It is one frame
/// out of fifty and it is the *first*, which is precisely the one a card shows:
/// a preview element that is paused, or looping, sits on frame zero, so every
/// waveform on the screen was a black rectangle. `trim=start_frame=1` drops it,
/// `setpts` puts what is left back at zero, and `tpad` clones the last frame
/// for as long as anything asks — because dropping a frame from the front
/// leaves the render one short at the back, where it would come out as a black
/// flash at the end of the loop instead of at the start. Cloning rather than
/// counting: the render stops pulling when it has enough, so there is no
/// arithmetic to get wrong and a sound that ends before the range does freezes
/// on its own last picture rather than going dark.
///
/// Sizes are even because yuv420p has no half pixels, and `sizeFromGraph` means
/// this is the size the writer is opened for: an odd one is an encoder that
/// refuses, not a picture that is a pixel off.
function waveTail(head, fit, fps) {
    const w = Math.max(64, fit - (fit & 1));
    const h = Math.max(48, 2 * Math.round((fit * WAVE_ASPECT) / 2));
    const rate = Number(fps) > 0 ? Number(fps) : 30;
    return [
        `[${head}]asplit=2[pa][pw]`,
        `[pw]showwaves=s=${w}x${h}:mode=cline:rate=${rate}:` +
        `colors=${WAVE}:draw=full:scale=lin,` +
        `trim=start_frame=1,setpts=PTS-STARTPTS,tpad=stop=-1:stop_mode=clone[pv]`,
    ];
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
