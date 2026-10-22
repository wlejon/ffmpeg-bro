// The edit → the graph that would produce it.
//
// This is the derivation: `buildSpec()`'s output, plus what `probe()` said
// about each source, becomes nodes and wires. It was `ui/filtergraph.js` in
// full until the graph became a thing the application holds, and the numbers
// behind every decision below were measured then — by rendering one edit both
// ways, through the compositor and through this graph on the ffmpeg CLI:
//
//     the obvious graph                                  24.1 dB
//     + the output colour handling                       26.8 dB
//     + the source matrices and ranges                   39.1 dB
//
// Two things came out of that, and neither was guessable.
//
// **Colour handling is most of the difference, and almost all of it is
// recoverable.** A graph that leaves the conversions to swscale's defaults gets
// BT.601 at both ends and a picture green in the shadows — the exact failure
// the renderer's own comment warns about. The output side is fully determined
// by the spec. The input side needs each file's tag, which is why
// `bro.ffmpeg.probe()` reports `colorSpace`/`colorRange` and why `sources` is a
// parameter here: without it the graph is still right in geometry and timing,
// but the colours visibly are not, and `caveats` says so rather than letting
// that pass as rounding.
//
// **A rate change is the one difference no option can close.** The renderer
// walks forward at a fixed output rate; overlay's frame sync picks by
// timestamp. Given a 30 fps source and a 25 fps render the two choose different
// source frames — a different way of compositing, not a different setting. That
// is a caveat too, raised only when the rates actually differ.
//
// Beyond those: the renderer crops after converting to RGBA, so a crop is a
// pointer offset with no chroma-alignment rounding, where `crop` in a graph
// cuts the decoded format. That is the sort of thing the remaining 39 dB is
// made of.
//
// **A clip has one of two things at the head of its run.** Usually an `-i`: a
// file, opened the way its input says, read for the streams this render wants.
// For a **generator clip** — a `testsrc` or a `color` laid out on the timeline,
// see ui/generator.js — it is the filter itself, which makes its pictures out of
// nothing and needs no file. Everything below that node is written by the same
// code for both, because it is the same edit: the same `trim`, the same clock,
// the same crop, the same `scale` into the same rectangle, the same `overlay`.
// A generator's node is *derived*, so it is rebuilt on every timeline edit and
// vanishes when the bar is deleted; a generator somebody placed by hand on the
// Graph stage is a user node and is untouched by any of this.
//
// **A clip's speed is the slope of one node.** The `setpts` that takes a clip off
// its file's clock and onto the render's is where a speed belongs, because a speed
// is nothing but the slope of that map: `(PTS-STARTPTS)/speed`. The sound cannot
// be done by re-stamping — samples are a count and not a timestamp — so it is
// `asetrate` and `aresample`, which is a **resample**: the pitch moves with the
// speed, in the printed graph and in the compositor both, and `atempo` is the
// pitch-preserving answer somebody can place. The two paths agreeing is the point;
// see `audioSteps`.
//
// The input is `buildSpec()`'s output and nothing else, which is the same
// object the renderer is driven from — so this cannot describe a render the
// application would not perform. When an edit cannot be expressed faithfully
// this returns a refusal rather than an approximation: a graph that is nearly
// right is worse than no graph, because the whole reason to show one is that it
// can be taken somewhere else and run.

import { makeGraph } from './model.js';
import { isSource } from './filters.js';
import { problems } from './check.js';
import { whyNotAClip } from '../generator.js';
import {
    n, px, cropOf, outputColor, windowOf, videoSteps, audioSteps,
    clipKey, COMPOSITE_POINT, MIX_POINT, inputInfo, inputOnDevice,
    clipHasSound, clipSoundRate, clipHasPicture, generatorOf,
    controlOf, clipOf, applyOverlay, applyLocks, applyStructure,
    declarePads, outputColour,
} from './derive-steps.js';

export { outputColor, COMPOSITE_POINT, MIX_POINT, controlOf, clipOf };

/// A named output's label goes on the node that produces it.
///
/// **The same mechanism the derivation's own sinks use, not a second one.**
/// `out:v` is mapped as `[vout]` because the last `overlay` *carries* that
/// label — a sink imposes nothing and reports what it finds, which is why with
/// one audible clip the muxer maps that clip's own `[a0]`. So a pad somebody
/// named is written onto whatever feeds it, and `moveLabelsToChainEnds` below
/// then keeps it at the end of whichever run that node turns out to end.
///
/// A node that already carries a label keeps it: that is a pad being read twice
/// — by the composite's sink and by an output — which `check.js` names, and
/// overwriting the name would print a graph that maps a pad no chain produces
/// on top of it.
function labelUserOutputs(g) {
    for (const n of g.nodes) {
        if (n.kind !== 'sink' || !n.name) continue;
        const e = g.inEdges(n)[0];
        const src = e ? g.node(e.from) : null;
        // An input node's pads are ffmpeg's — `[1:v]` is a demuxer's stream and
        // cannot be given a name of its own. `check.js` says so; there is
        // nothing to write here.
        if (!src || src.kind !== 'filter') continue;
        // A `split` writes two pads and one `label` would name neither of them
        // honestly, so a fork's names are per pad. See `padOf` in print.js.
        if (src.outs && src.outs.length > 1) {
            if (!src.outLabels) src.outLabels = [];
            const port = e.fromPort || 0;
            if (!src.outLabels[port]) src.outLabels[port] = n.name;
            continue;
        }
        if (src.label) continue;
        src.label = n.name;
    }
}

/// The two pads the renderer looks for by name, once there is more than one for
/// it to choose between.
///
/// **Native's rule, mirrored rather than guessed at.** With one picture pad in a
/// graph it is the composite whatever it is called — which is why a single
/// audible clip's soundtrack has always been mapped as that clip's own `[a0]`
/// and nothing minded. With several, the pad labelled `vout` is the composite
/// and the one labelled `aout` is the mix, and a graph that labels neither is
/// refused before the file is opened, listing the labels it does have.
///
/// So the moment somebody places an output of their own, the derivation's own
/// pad has to say which one it is — and it may by then be some way from where
/// the label started. A `split` between the composite and the sink is the
/// ordinary case: `moveLabelsToChainEnds` stops at the fork, because a single
/// label names neither of its pads, so `vout` is left mid-chain where nothing
/// prints it and the composite comes out as an invented name.
///
/// Run last, after every other label has settled, and it takes the name off
/// whatever was carrying it first: two chains ending in `[vout]` is "Label
/// found twice".
function nameTheRendersPads(g) {
    for (const stream of ['v', 'a']) {
        const named = g.nodes.some((n) => n.kind === 'sink' && n.name &&
                                          (n.stream || 'v') === stream);
        if (!named) continue;
        const sink = g.byAnchor(stream === 'a' ? 'out:a' : 'out:v');
        const e = sink ? g.inEdges(sink)[0] : null;
        const src = e ? g.node(e.from) : null;
        if (!src || src.kind !== 'filter') continue;
        const want = stream === 'a' ? 'aout' : 'vout';
        for (const n of g.nodes) {
            if (n.label === want) n.label = null;
            if (n.outLabels)
                n.outLabels = n.outLabels.map((l) => (l === want ? null : l));
        }
        if (src.outs && src.outs.length > 1) {
            if (!src.outLabels) src.outLabels = [];
            src.outLabels[e.fromPort || 0] = want;
        } else src.label = want;
    }
}

/// A derived chain label that a person has since used as an output name.
///
/// The derivation hands out `base`, `v0`, `o0`, `a0`, `vout` and `aout` before
/// it has ever seen the overlay, so an output called `v0` on a two-clip timeline
/// would be two chains ending in the same label — which ffmpeg refuses with
/// "Label found twice", about a graph it has already half parsed. The other way
/// of avoiding that is to narrow what a person may type by how many clips are on
/// the timeline, which is a rule nobody could hold. So the *derived* name moves
/// instead: nothing outside this graph refers to it, and everything that refers
/// to a person's name was written down by a person.
function avoidUserLabels(g) {
    const taken = new Set();
    for (const n of g.nodes) if (n.kind === 'sink' && n.name) taken.add(n.name);
    if (!taken.size) return;
    const used = new Set();
    for (const n of g.nodes) if (n.label) used.add(n.label);
    let next = 0;
    for (const n of g.nodes) {
        if (!n.label || !taken.has(n.label)) continue;
        let name;
        do { name = `g${next++}`; } while (taken.has(name) || used.has(name));
        used.add(name);
        n.label = name;
    }
}

/// A pad name belongs at the end of the run that produces it.
///
/// Only chain-final nodes carry a label — that is `print.js`'s rule — and the
/// derivation puts them exactly there. A wire drawn by hand can move the end of
/// a run: put a filter between the last `overlay` and the sink and `vout` is
/// suddenly on a node in the middle of a chain, where it is printed by nothing
/// and the pad the muxer maps is invented instead.
///
/// So the labels are walked forward afterwards, by the same rule the printer
/// reads them by. `applyOverlay` does this for an insertion at the moment it
/// makes one; this catches every other way a run can grow, and is a no-op for
/// the graph the derivation builds on its own.
function moveLabelsToChainEnds(g) {
    for (const node of g.nodes) {
        if (!node.label || node.kind !== 'filter') continue;
        let at = node;
        for (;;) {
            const cons = g.consumers(at);
            if (cons.length !== 1) break;
            const next = cons[0];
            if (next.kind !== 'filter' || g.producers(next).length !== 1) break;
            if (next.label) break;              // it already ends a chain of its own
            // A fork writes several pads and a single label names none of them
            // — its names are per pad (`outLabels`), so a label carried onto one
            // would be a name the printer has nowhere to put.
            if (next.outs && next.outs.length > 1) break;
            at = next;
        }
        if (at === node) continue;
        at.label = node.label;
        node.label = null;
    }
}

/// `buildSpec()`'s output → the graph that would render it.
///
/// Returns `{ ok: true, graph, colour, caveats, points, overrides, problems }`,
/// or `{ ok: false, reason }` — and a caller given a refusal must say so rather
/// than print a graph. `points` are the named places on the wires where a
/// filter can go; `overrides` is every lock that disagreed with what was just
/// derived, which is what lets the field it outranked say so; `problems` is
/// every reason this graph would not run, each naming the node it is about.
///
/// `opts.overlay` is the user's layer — `{ inserts, locks }` from
/// `graph/overlay.js`. Passed in rather than reached for, so this stays a pure
/// function of its arguments: the tests hand it literals and get the same
/// answer the application gets, which is the only reason they are worth
/// anything.
///
/// `sources` is optional and runs parallel to `spec.clips`: what
/// `bro.ffmpeg.probe()` said about each clip's video stream, which is where the
/// colour tags come from. Without it the graph is still correct in geometry and
/// timing but leaves the source matrices to swscale's guess, and `caveats` says
/// so — the difference is a visible colour cast, not rounding.
///
/// `opts.forRender` asks for the graph *this application* will run rather than
/// the one it prints. They differ by exactly one thing, and only because the
/// two have different things downstream of them: a standalone ffmpeg hands the
/// last pad straight to its encoder, so the conversion into the encoder's
/// colour has to be the last filter; here the last pad is handed to the writer,
/// which converts out of the compositing space itself, exactly as it does for a
/// render with no graph at all. Leaving the tail on for a render would convert
/// twice and come out slightly worse than either.
///
/// `opts.live` says the inputs are devices, and the one thing it changes is the
/// range: a recording has no end to walk to, so the empty-range refusal below is
/// not a refusal here, it is the ordinary case. Nothing else in a clip-less
/// derivation reads the length — the black canvas that would carry it as `d`
/// exists only where there is something to lay over it — so this is the whole of
/// the difference and not a mode. See `graph/record.js`, which is the only
/// caller and explains why a recording's graph is derived at all.
export function derive(spec, sources, opts = {}) {
    if (!spec || !Array.isArray(spec.clips)) return refuse('there is no edit to describe');

    const start = Number(spec.start) || 0;
    const end = Number(spec.end) || 0;
    const length = end - start;
    // **Where the zero of the graph's clock is**, which is not the same
    // question as where this render's window begins.
    //
    // Every chain in a derived graph starts `setpts=PTS-STARTPTS+offset/TB`, so
    // `t` inside the graph reads as time into the render — and a filter carrying
    // `enable='between(t,10,20)'` means those seconds of *the render*. A node
    // preview and the A/B comparison are renders of a two-second window out of
    // the middle of that range, and derived against their own start they would
    // put t=0 at the start of the window: the same filter would come on ten
    // seconds into every preview, wherever the preview was taken from. So the
    // window's position on the render's clock travels with the spec, and the
    // whole graph is shifted by it.
    //
    // Defaults to the window's own start, which is what an export has and what a
    // spec written by hand in a test has, and makes this a no-op for both.
    const origin = Number.isFinite(Number(spec.origin)) ? Number(spec.origin) : start;
    const off = start - origin;
    // With nothing on the timeline the range has nothing to measure itself
    // against, and the answer is the one chunks 5 and 6 already settled on for
    // a still and an endless input: `-t` is the only thing that can say how long
    // something with no length of its own is. Said here rather than left as
    // "the range is empty", because that is a true sentence that tells nobody
    // what to do about it.
    //
    // **Both of these questions are the canvas's**, which is why `opts.live`
    // excuses both and excuses nothing else. How long, how big and how fast are
    // the three arguments of the black rectangle every clip is laid over; a
    // recording has no canvas, because it has no clips and its picture is the
    // device's own. Refusing a recording for having no output size would be
    // demanding a scale nobody asked for, which is the same mistake
    // `CaptureSettings`' zeroed width and height exist to avoid.
    if (!opts.live) {
        if (!(length > 0))
            return refuse(spec.clips.length
                ? 'the range is empty'
                : 'the range is empty — with nothing on the timeline, a source’s own ' +
                  'duration (d) is the only thing that says how long a render would be');
        if (!(Math.round(spec.width) > 0 && Math.round(spec.height) > 0 &&
              (Number(spec.fps) || 30) > 0))
            return refuse('the output size or frame rate is not a number');
    }

    const W = Math.round(spec.width);
    const H = Math.round(spec.height);
    const fps = Number(spec.fps) || 30;

    // Paint order is the array's order, which the model keeps sorted
    // bottom-track-first — the same order the viewer stacks in and the renderer
    // takes as `z`. Sorting again here would be a second opinion about which
    // clip is in front.
    const kept = [];
    for (let ci = 0; ci < spec.clips.length; ci++) {
        const clip = spec.clips[ci];
        const w = windowOf(clip, start, end);
        if (!w) continue;                       // outside the range; not an error
        // A generator is a picture by construction — that is what makes it
        // something a clip can be cut from — and it is asked of the clip rather
        // than of `inputInfo`, which describes the `-i`s and knows nothing about
        // one.
        const gen = generatorOf(clip);
        if (gen) {
            const bad = whyNotAClip(gen);
            if (bad) return refuse(bad);
        }
        // A clip that puts nothing on the canvas is not asked for a rectangle.
        // It is still kept — it is in the mix — and it still gets an `-i`, so
        // the numbering the graph gives its pads counts it like any other.
        const picture = gen ? true : clipHasPicture(spec, clip);
        const c = cropOf(clip);
        if (picture) {
            if (c.l + c.r >= 1 || c.t + c.b >= 1)
                return refuse(`a clip is cropped away to nothing`);
            if (!(clip.w > 0 && clip.h > 0) ||
                ![clip.x, clip.y, clip.w, clip.h].every(Number.isFinite))
                return refuse('a clip has no rectangle to be drawn in');
        }
        kept.push({ clip, w, picture, gen, i: kept.length, key: clipKey(clip, ci),
                    src: Array.isArray(sources) ? sources[ci] : null });
    }
    // The clips that put something on the canvas, in paint order. Everything
    // about the picture is measured against this list and everything about the
    // sound against `kept`, because the two stop being the same list the moment
    // a clip has only one of them.
    const shown = kept.filter((k) => k.picture);
    // **A render with nothing on the timeline is a legitimate render.** `ffmpeg
    // -f lavfi -i testsrc -t 5 out.mp4` is a thing people do every day, and the
    // moment the graph can hold a node that produces something out of nothing
    // there is no reason this application cannot. So an empty range is only a
    // refusal while there is also nothing in the graph that can produce a
    // picture.
    //
    // **What counts is a node that produces**, not any node at all: an `hflip`
    // somebody has placed and not yet wired cannot be the whole of a render, and
    // a graph derived around it would report five separate problems where
    // "there is nothing to render" is the one true sentence. So it is an input
    // the graph reads, or a filter libavfilter says has no inputs — the same
    // question `isSource` answers for the palette.
    const placedNodes = (opts.overlay && opts.overlay.nodes) || [];
    const produces = placedNodes.some((rec) => rec.kind === 'input' || isSource(rec.filter));
    if (!kept.length && !produces)
        return refuse('nothing on the timeline falls inside the range');

    const g = makeGraph({ derived: true });

    // A black canvas of the output's own size and rate, which every clip is
    // laid over. It is also what governs the output's frame rate: overlay's
    // frame sync follows its first input, so the render walks forward at the
    // rate asked for rather than at whatever the topmost source happens to run
    // at — the same thing the renderer does by holding a fixed output clock.
    //
    // **This node is why `-fps_mode vfr` changes nothing about a derived graph,
    // and it is not a coincidence.** Under `vfr` the timestamps that reach the
    // file are the ones the graph put on the frames — and for a graph rooted in
    // this `color` those *are* the output rate, because everything below is
    // frame-synced to it. So the derivation goes on imposing the rate and says so
    // here; what `vfr` is for is a filter of somebody's that changes it below
    // this point (an `fps`, a `select`, a `framestep`), which is exactly the
    // chain a fixed-rate walk came out of fast or slow. One fact, two homes: this
    // and ExportSettings::fpsMode.
    //
    // **With nothing on the timeline there is no canvas either.** A black
    // rectangle nothing is laid over is not the picture of an empty edit, it is
    // a node in the way: the moment a `testsrc` was wired to the sink instead,
    // the canvas would be a source nothing read, which is a graph libavfilter
    // refuses. Left out, the sink is simply unwired, and "nothing is wired to
    // video out" is exactly the state a graph you have not finished is in.
    //
    // The canvas is what `overlay` frame-syncs against, so it carries the clock
    // offset too — `color` always starts at zero and a canvas left there while
    // every clip was shifted would composite the clips against the wrong frames
    // of it, which is a black picture rather than a subtle one.
    const base = shown.length ? g.run([], [
        { filter: 'color', anchor: 'base',
          params: { c: 'black', s: `${W}x${H}`, r: n(fps, 6), d: n(length, 6) } },
        ...(off ? [{ filter: 'setpts', anchor: 'base/setpts', posNames: ['expr'],
                     pos: [`PTS-STARTPTS+${n(off, 6)}/TB`] }] : []),
    ], 'base') : null;

    // The named places on the wires where something can be put. `at`/`atPort`
    // are where the *next* insertion goes, which starts as the point's own node
    // and the pad it leaves by, and moves along as nodes are spliced in.
    //
    // The pad is not optional now that one node produces two of them: a clip's
    // picture and its sound both leave its input node, and a point that named
    // only the node would put a `+` on whichever of the two wires happened to
    // be found first.
    const points = [];
    const point = (id, after, atPort, stream, title) => {
        if (after)
            points.push({ id, after: after.id, at: after.id, atPort, stream, title });
    };

    // One node per clip, because one file is one `-i`. Its outputs are the
    // streams this graph reads it for — the picture always, the sound below if
    // the clip is audible — and every wire leaving it says which. Two nodes
    // reading one path was the older shape, and it drew a file as two unrelated
    // things when the whole of `[0:v]` and `[0:a]` being one input is that they
    // are not: one demuxer, one seek, one row on the Sources stage.
    const inputs = new Map();

    // The `-i` numbers this graph hands out, in the order it reads them. A
    // counter rather than a position in `kept`, because a generator clip is not
    // an `-i`: numbered by position, a `testsrc` between two files would leave a
    // hole in the list and `[2:v]` would name the wrong file. The graph inputs
    // below carry on from the same counter for the same reason.
    let nextInput = 0;

    // Nodes are pushed in the order their chains are printed in, and print.js
    // walks the array — so a clip's whole run goes down before the next clip's,
    // and the overlays after all of them.
    kept.forEach((k) => {
        const { clip, w, src, i, key, gen } = k;
        // **What sits at the head of this clip's run**, which is the one thing a
        // generator changes: a filter that makes pictures out of nothing, where a
        // clip of a file has the `-i` its pictures are decoded from. Derived like
        // everything else here — it is rebuilt on every timeline edit, and a
        // generator somebody placed *by hand* on the Graph stage is a different
        // node with no lane and no bar, exactly as it was.
        if (gen) {
            const source = g.add({ filter: gen.filter, anchor: `${key}/gen`,
                                   pos: gen.pos || [], params: gen.params || {} });
            // The same run as a file clip's, written by the same function: cut it
            // out of the source (`trim` is what bounds an endless generator, and
            // is why the clip's own length is the only thing that says how long
            // one is), move it onto the render's clock, crop, size, opacity. No
            // source colour is passed, because there is no file to have been
            // tagged — swscale's own default is what `ffmpeg -f lavfi -i testsrc`
            // gets and therefore what this render and the printed command both
            // do.
            k.head = g.run({ node: source, out: 0 },
                           videoSteps(clip, w, null, key, off, false), `v${i}`);
            // The same two insert points, under the same names, so a `drawtext`
            // over a colour card is placed the way a `drawtext` over a shot is —
            // and so an overlay written down against `clip:7/after-scale` means
            // the same thing whichever kind of clip 7 turned out to be.
            point(`${key}/after-decode`, source, 0, 'v', 'after the generator');
            point(`${key}/after-scale`, g.byAnchor(`${key}/format`), 0, 'v', 'after scale');
            return;
        }
        // `index` is the `-i` number this graph gives the input and `input` is
        // which of the spec's inputs that is. Two numbers because they count
        // different things: a graph numbers the pads it reads, in the order it
        // reads them, and the document numbers every input it holds whether or
        // not anything on the timeline is cut from it.
        // Whether this clip's `-i` was told to keep its pictures on the card.
        // Read off the spec's input list, which is what the render is handed,
        // so the graph and the render cannot disagree about where the picture
        // starts out.
        const onDevice = inputOnDevice(spec, clip.input);
        // `from` is the earliest source time anything downstream asks for, which
        // is the renderer's seek (`ExportGraphInput::from`). Where those frames
        // *land* is not here: it is the `setpts` below, which is the node that
        // moves them, and it says so in `moves`.
        const input = g.add({ kind: 'input', index: nextInput++, path: clip.path,
                              input: clip.input === undefined ? -1 : clip.input,
                              anchor: `${key}/in`, from: w.srcIn,
                              onDevice, outs: [] });
        inputs.set(key, input);
        // **A pad is added when something reads it**, which is the rule the
        // sound side already followed and which the picture side could take for
        // granted while every clip had one. A clip of a file with no video in it
        // is read for its sound and nothing else, so its node's only socket is
        // the one the audio pass below adds — the card says what this render
        // does with the file, not what the file happens to contain.
        if (!k.picture) return;
        input.outs.push({ stream: 'v' });
        k.head = g.run({ node: input, out: 0 },
                       videoSteps(clip, w, src, key, off, onDevice), `v${i}`);
        // Two points per clip, and they are two different pictures: before the
        // scale a filter sees the source at its own size, in its own pixel
        // format and colour; after it, the clip as it will be composited —
        // RGBA, at the size it occupies on the canvas. `hflip` does not care;
        // anything that works in pixels does.
        point(`${key}/after-decode`, input, 0, 'v', 'after decode');
        point(`${key}/after-scale`, g.byAnchor(`${key}/format`), 0, 'v', 'after scale');
    });

    // The files the *graph* reads that no clip accounts for — a logo laid over
    // the picture, a second angle, a sound bed.
    //
    // **They are `-i`s, not `movie=` arguments, and that is the decision this
    // whole chunk turns on.** ffmpeg writes both: `-i logo.png` with
    // `[1:v]overlay`, and `movie=logo.png,overlay`. They are the same picture
    // and they are not the same thing to reason about, because everything that
    // decides *how a file is opened* belongs to the `-i` — the forced demuxer,
    // `-probesize`, `-loop`, `-ss`, `-t`, `-stream_loop`, and for a URL the
    // whole protocol option table. A `movie` node carries a filename and a
    // `seek_point` and nothing else, so making it the mechanism would mean
    // rebuilding all of that inside a filter argument, badly, beside an input
    // model that already has it.
    //
    // The other half of the argument is the Sources stage. It claims to be
    // every file this render opens; a `movie=` names a file that never appears
    // there, cannot be probed with the options in force, and cannot be reused by
    // a clip. Referencing an input means the row is already on that stage and
    // the answer to "what will be opened" stays one list.
    //
    // `movie` is still reachable — it is a filter with no inputs and the palette
    // offers every one of those — and `sources.js` reports whatever file such a
    // node names, so the stage keeps telling the truth. It is just not what this
    // application reaches for on your behalf.
    const graphInputs = [];
    for (const rec of placedNodes) {
        if (rec.kind !== 'input') continue;
        const info = inputInfo(spec, rec.input);
        // An input somebody removed. Kept in the overlay rather than dropped,
        // by the same rule an insert point out of range follows: put the input
        // back and the node comes back with it.
        if (!info) continue;
        const streams = info.streams && info.streams.length ? info.streams : ['v'];
        const node = g.add({
            id: rec.id, kind: 'input', derived: false,
            // Two numbers, counting different things, exactly as a clip's input
            // node carries: `index` is the `-i` this graph gives the pad and
            // `input` is which of the document's inputs that is.
            index: nextInput++,
            input: info.index, path: info.path, title: info.name,
            // The same question a clip's input node answers, asked of the same
            // list: a file the graph reads on its own account can decode on a
            // card too, and nothing downstream of it can know that from the
            // path.
            onDevice: inputOnDevice(spec, info.index),
            // Every stream the input turned out to have, because unlike a clip
            // there is nothing here to say which of them will be used — you
            // decide that by dragging a wire off one of the sockets. An `-i`
            // pad nothing references is ordinary ffmpeg, so an unread one is
            // not a complaint (see check.js).
            //
            // **Including its cues, where they are pictures of characters.**
            // `streamKinds` is where that is decided and why (`ui/inputs.js`):
            // a `dvdsub` track is drawn by painting the bitmaps it carries, so
            // it is a pad; a `.srt` is drawn by libass, so it is a `subtitles`
            // filter and not a pad at all.
            outs: streams.map((s) => ({ stream: s })),
        });
        streams.forEach((s, i) =>
            point(`${rec.id}/after-decode:${i}`, node, i, s,
                  s === 'a' ? 'input sound' : s === 's' ? 'cues, painted' : 'after decode'));
        graphInputs.push(node);
    }

    const colour = outputColor(spec);

    let over = base;
    let lastOverlay = null;
    shown.forEach(({ clip, key, head }, i) => {
        const c = cropOf(clip);
        const x = clip.x + clip.w * c.l;
        const y = clip.y + clip.h * c.t;
        const last = i === shown.length - 1;
        // `eof_action=pass` because a clip is shorter than the render: when it
        // ends the canvas has to carry on rather than the whole graph stopping,
        // which is the default and would truncate the output at the first clip
        // to run out.
        const steps = [{ filter: 'overlay', anchor: `composite/overlay:${key.slice(5)}`,
                         posNames: ['x', 'y'], pos: [px(x), px(y)],
                         params: { eof_action: 'pass' } }];
        over = g.run([over, head], steps, last ? 'vout' : `o${i}`);
        lastOverlay = g.byAnchor(`composite/overlay:${key.slice(5)}`);
    });
    // The composite, before it is converted into the encoder's colour.
    //
    // There is deliberately no point *after* that conversion. It is the one
    // chain that exists in the printed graph and not in the one this
    // application runs — the writer converts on that path — so a filter placed
    // there would sit in the encoder's colour in the command you copied and in
    // RGBA in the render you got. Two pictures from one insert point is worse
    // than one fewer insert point.
    point(COMPOSITE_POINT, lastOverlay, 0, 'v', 'after compositing');
    // The pad the muxer maps for the picture exists when there is a picture for
    // it to map — the same rule `out:a` follows below, arrived at from the other
    // end. A timeline of nothing but sound has no composite, and an unwired
    // video sink there would refuse every render of it with "nothing is wired to
    // video out": a true statement about the graph and a false one about the
    // edit.
    //
    // With *nothing* on the timeline the sink stays, because that is the
    // generator case — `ffmpeg -f lavfi -i testsrc -t 5` — where an unwired
    // video out is exactly what the `testsrc` you have just placed needs
    // somewhere to go. Same for a wire somebody has already drawn to it.
    const wantsPicture = over || !kept.length ||
        (opts.overlay && (opts.overlay.wires || []).some((w) => w.to === 'out:v'));
    if (wantsPicture) {
        const vsink = g.add({ kind: 'sink', stream: 'v', anchor: 'out:v' });
        if (over) g.connect(over, vsink, 0);
    }

    if (spec.audio !== false) {
        const heard = kept.filter(({ clip }) => !clip.muted && clip.volume > 0 &&
                                                clipHasSound(spec, clip));
        // **Refused rather than approximated**, before a node is made: a sped-up
        // clip's sound is `asetrate=<rate>*<speed>,aresample=<rate>` and
        // `asetrate` takes a number, so a spec that does not say what rate the
        // file is at cannot be printed honestly. `asetrate`'s own default is
        // 44100 and a 48 kHz file put through that comes out slightly slow and a
        // semitone flat, which is exactly the nearly-right graph this file exists
        // instead of.
        for (const k of heard) {
            if (k.w.speed === 1) continue;
            if (!clipSoundRate(spec, k.clip))
                return refuse(`a clip plays at ${n(k.w.speed)}× and nothing here says what ` +
                              'rate its sound is recorded at, so there is no rate to ' +
                              'resample it from');
        }
        const tails = heard.map(({ clip, w, i, key }) => {
            // The clip's own input node, given a second output. A pad is added
            // when something reads it rather than for every stream the file
            // happens to carry: a muted clip is not read for its sound, and a
            // socket wired to nothing would be a claim about the render that
            // the render does not make.
            const input = inputs.get(key);
            const out = input.outs.length;
            input.outs.push({ stream: 'a' });
            const tail = g.run({ node: input, out },
                               audioSteps(clip, w, key, off, clipSoundRate(spec, clip)),
                               `a${i}`);
            point(`${key}/audio`, input, out, 'a', 'clip audio');
            return tail;
        });
        let out = null;
        if (tails.length === 1) {
            out = tails[0];
        } else if (tails.length > 1) {
            // `normalize=0` because the renderer sums and clamps. amix's default
            // divides by the number of inputs, which would make every clip
            // quieter for the company of the others — a render that sounds
            // different from the edit it was made from.
            out = g.run(tails, [{ filter: 'amix', anchor: 'audio/mix',
                                  params: { inputs: String(tails.length), normalize: '0' } }],
                        'aout');
        }
        // With one audible clip there is no mixer, and this point sits on that
        // clip's own tail — which is the same wire the muxer maps and the right
        // place for something that applies to the whole soundtrack.
        point(MIX_POINT, out, 0, 'a', 'after mixing');
        // The pad the muxer maps exists when something maps it — either the
        // edit's own soundtrack, or a wire somebody drew to it.
        //
        // That second case is what a `sine` or an `anullsrc` needs and could
        // not have: with no audible clip there was no `out:a` in the graph at
        // all, so a sound generator had nowhere to send what it made. Making
        // the sink unconditional is the other obvious answer and the wrong one —
        // every render of a silent timeline would then carry an unwired audio
        // out and be refused for it.
        const wanted = out || (opts.overlay && (opts.overlay.wires || [])
            .some((w) => w.to === 'out:a'));
        if (wanted) {
            const sink = g.add({ kind: 'sink', stream: 'a', anchor: 'out:a' });
            if (out) g.connect(out, sink, 0);
        }
    }

    // The user's layer goes on last, over a skeleton that is complete — so an
    // insert point is a wire that exists and a lock is a value that has already
    // been derived and can therefore be reported as outranked.
    const overrides = [];
    applyOverlay(g, points, opts.overlay, overrides);
    const stranded = [];
    applyStructure(g, opts.overlay, stranded);
    // The names a person gave first, because the derivation's own are the ones
    // that can move — then the outputs take theirs, on whatever ended up
    // feeding them.
    avoidUserLabels(g);
    labelUserOutputs(g);
    // **The conversion into the encoder's colour goes on last, in front of the
    // sink, after everything a person did.**
    //
    // It used to ride on the back of the last derived `overlay`, which was
    // right while the only thing that could be added to a graph was a filter
    // spliced onto a wire — there was no wire after it, deliberately, so
    // nothing could get between the conversion and the encoder.
    //
    // A hand-made wire can. And the moment it can, those two nodes become the
    // one place on the screen it must not be joined to: they exist in the graph
    // this application *prints* and not in the one it *runs*, so a wire ending
    // on `output/color` is a wire that is there in the command you copied and
    // absent from the render you got. Attaching them here — after the user's
    // structure, to whatever ends up feeding the sink — makes that unreachable
    // rather than something to be checked for, and keeps the two forms of the
    // graph differing by exactly the one chain they are supposed to.
    if (!opts.forRender) {
        applyLocks(g, outputColour(g, spec, colour), opts.overlay, overrides);
        declarePads(g);
    }
    moveLabelsToChainEnds(g);
    nameTheRendersPads(g);

    // What is known to differ about *this* render, rather than a fixed
    // disclaimer. A note that is always the same is one nobody reads, and the
    // two that matter are only sometimes true.
    // A generator is in neither: there is no file for a tag to have been read
    // off, and no source rate for a fixed-rate walk to disagree with — the
    // pictures are made by libavfilter inside this very graph, at whatever rate
    // its arguments asked for. Saying "a source's colour is not known here" about
    // one would be a caveat that is true of every render containing a `color` and
    // means nothing about any of them.
    const caveats = [];
    if (kept.some(({ src, gen }) => !src && !gen))
        caveats.push('a source’s colour is not known here, so swscale guesses ' +
                     'the matrix the renderer reads from the file');
    // **A speed is a source arriving at another rate**, which is why the rate
    // caveat divides by it rather than having one of its own: a 25 fps file at 2×
    // delivers twelve and a half pictures per second of render, and the
    // disagreement that follows is exactly the one this sentence already names.
    // Measured in tests/export_test.cpp over one fixture at 2×: the compositor
    // takes source frame 2m for output frame m, `overlay`'s frame-sync takes 2m-1
    // — one frame, never more, 27 dB against the compositor and 50 dB against the
    // frame either side of it. Raised only where the numbers actually differ, like
    // everything else in this list, so a clip at 1× on a matching rate says
    // nothing.
    if (kept.some(({ src, w }) => src && src.fps > 0 &&
                                  Math.abs(src.fps / w.speed - fps) > 0.01))
        caveats.push('the output rate differs from the rate a source’s pictures ' +
                     'arrive at, and a fixed-rate walk and a frame-sync do not ' +
                     'choose the same frames');

    // What is wrong with the graph, as opposed to what could not be derived.
    //
    // The two are deliberately different answers. A refusal means there is no
    // graph to look at; this means there is one, it is on the screen, and it
    // will not run — a node with an empty input, a pad read twice, a wire into
    // the wrong kind of pad. Reported rather than refused because the state is
    // reachable and normal: the moment between placing a node and wiring it up
    // is a graph with a problem in it, and a stage that blanked itself for that
    // would be unusable. What must not happen is a render going ahead as though
    // the problem were not there, which is `filtergraph.js`'s job.
    return { ok: true, graph: g, colour, caveats, points, overrides,
             problems: problems(g, stranded) };
}

function refuse(reason) { return { ok: false, reason }; }
