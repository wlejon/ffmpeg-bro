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
// The input is `buildSpec()`'s output and nothing else, which is the same
// object the renderer is driven from — so this cannot describe a render the
// application would not perform. When an edit cannot be expressed faithfully
// this returns a refusal rather than an approximation: a graph that is nearly
// right is worse than no graph, because the whole reason to show one is that it
// can be taken somewhere else and run.

import { makeGraph } from './model.js';

/// Numbers, short. ffmpeg's parser is happy with any of these, and a graph full
/// of `0.30000000000000004` is one nobody reads.
function n(v, dp = 3) {
    const r = Number(Number(v).toFixed(dp));
    return Object.is(r, -0) ? '0' : String(r);
}

const px = (v) => String(Math.round(v));

/// What a clip has taken off each edge, as fractions. A clip that has never
/// been cropped carries no crop at all, and three copies of that default were
/// three places for "no crop" to come to mean something slightly different.
const cropOf = (clip) => clip.crop || { l: 0, t: 0, r: 0, b: 0 };

/// The matrix, primaries, transfer and range the render will be converted to
/// and tagged with. This mirrors `ffmpeg_export.cpp`'s rule exactly, including
/// what "auto" means — the guess every player makes, by frame height — because
/// two implementations of that rule would be two answers to what colour the
/// picture is. Exported because the command's `-colorspace`/`-color_range`
/// arguments and the graph's final conversion are the same decision.
export function outputColor(spec) {
    const want = spec.colorspace || 'auto';
    const wide = want === 'bt2020';
    const hd = want === 'bt709' || (want === 'auto' ? Math.round(spec.height) >= 720 : false);
    const full = spec.colorRange === 'pc';
    // `matrix` names the stream tag and `sws` names the same matrix to the
    // scale filter, which has a vocabulary of its own: the tag for
    // non-constant-luminance BT.2020 is `bt2020nc`, and swscale calls it
    // `bt2020`. Writing one where the other belongs is accepted silently by
    // neither and quietly by one, depending on the version.
    const range = full ? 'pc' : 'tv';
    if (wide)
        return { matrix: 'bt2020nc', sws: 'bt2020', primaries: 'bt2020',
                 transfer: 'bt2020-10', range, full };
    return hd
        ? { matrix: 'bt709', sws: 'bt709', primaries: 'bt709',
            transfer: 'bt709', range, full }
        : { matrix: 'smpte170m', sws: 'smpte170m', primaries: 'smpte170m',
            transfer: 'smpte170m', range, full };
}

/// The part of a clip that lands inside the rendered range, in three clocks:
/// where it starts in the source, where it starts in the output, and how long
/// it runs. Returns null for a clip the range does not reach.
function windowOf(clip, start, end) {
    const from = Math.max(clip.start, start);
    const to = Math.min(clip.start + clip.length, end);
    if (to - from <= 1e-6) return null;
    return {
        srcIn: clip.inPoint + (from - clip.start),
        srcOut: clip.inPoint + (to - clip.start),
        offset: from - start,
        length: to - from,
    };
}

/// The matrix and range a source will be decoded through, in the scale
/// filter's vocabulary.
///
/// This is `swsSpaceFor()` in ffmpeg_export.cpp written again, which is a
/// duplication worth naming: the renderer reads the file's tag and falls back
/// to frame height, and if this fell back differently the command would
/// describe a colour the render does not have. `probe()` reports the tag
/// verbatim and leaves it empty when the file carries none, so the fallback has
/// to live at each point of use. **If that rule changes there, it changes
/// here.**
function sourceColor(src) {
    if (!src) return null;
    const BY_TAG = {
        bt709: 'bt709', bt470bg: 'bt601', smpte170m: 'smpte170m',
        smpte240m: 'smpte240m', fcc: 'fcc',
        'bt2020nc': 'bt2020', 'bt2020_ncl': 'bt2020',
        'bt2020c': 'bt2020', 'bt2020_cl': 'bt2020',
    };
    const matrix = BY_TAG[src.colorSpace] ||
                   (Number(src.height) >= 720 ? 'bt709' : 'bt601');
    // An untagged file is limited range, which is what the renderer assumes:
    // only an explicit JPEG/pc tag makes it full.
    return { matrix, range: src.colorRange === 'pc' ? 'full' : 'tv' };
}

/// The video run for one clip: cut it out of its source, move it to where it
/// belongs on the output clock, take the crop off, size it to its rectangle,
/// and make it as transparent as it is.
///
/// Crop is written as an expression over `iw`/`ih` rather than in pixels
/// because the crop is a fraction of the source and the source's size is not in
/// the spec — the renderer does not need it, since it crops the placed picture.
/// Letting ffmpeg do that arithmetic keeps the two definitions the same one.
function videoSteps(clip, w, src, key) {
    const c = cropOf(clip);
    const keepW = 1 - c.l - c.r;
    const keepH = 1 - c.t - c.b;

    const steps = [
        { filter: 'trim', anchor: `${key}/trim`,
          params: { start: n(w.srcIn, 6), end: n(w.srcOut, 6) } },
        { filter: 'setpts', anchor: `${key}/setpts`, posNames: ['expr'],
          pos: [`PTS-STARTPTS+${n(w.offset, 6)}/TB`] },
    ];
    if (keepW < 1 || keepH < 1)
        steps.push({ filter: 'crop', anchor: `${key}/crop`,
                     posNames: ['w', 'h', 'x', 'y'],
                     pos: [`iw*${n(keepW, 6)}`, `ih*${n(keepH, 6)}`,
                           `iw*${n(c.l, 6)}`, `ih*${n(c.t, 6)}`] });

    // Sized and then taken into RGBA, which is the space the compositor works
    // in.
    //
    // All three of matrix, source range and destination range, or none of
    // them. They are one statement — "this is limited-range BT.709 and I want
    // full-range RGB" — and swscale acts on the part it is given: naming the
    // range without the matrix converts accurately through the wrong
    // coefficients, and naming the matrix without `out_range=full` carries the
    // limited range through into RGB and washes the picture out. Measured over
    // one edit against the renderer: 39.1 dB with all three, 29.0 dB with the
    // matrix alone, 26.8 dB with none, 24.1 dB with the ranges alone.
    const from = sourceColor(src);
    const scale = { filter: 'scale', anchor: `${key}/scale`, posNames: ['w', 'h'],
                    pos: [px(clip.w * keepW), px(clip.h * keepH)], params: {} };
    if (from)
        Object.assign(scale.params, { in_color_matrix: from.matrix,
                                      in_range: from.range, out_range: 'full' });
    steps.push(scale);
    steps.push({ filter: 'format', anchor: `${key}/format`,
                 posNames: ['pix_fmts'], pos: ['rgba'] });
    if (clip.opacity < 1)
        steps.push({ filter: 'colorchannelmixer', anchor: `${key}/opacity`,
                     params: { aa: n(clip.opacity) } });
    return steps;
}

/// The audio run for one clip. `adelay` rather than `asetpts` for the offset:
/// it pads with silence, which is what a clip that starts late sounds like.
function audioSteps(clip, w, key) {
    const steps = [
        { filter: 'atrim', anchor: `${key}/atrim`,
          params: { start: n(w.srcIn, 6), end: n(w.srcOut, 6) } },
        { filter: 'asetpts', anchor: `${key}/asetpts`, posNames: ['expr'],
          pos: ['PTS-STARTPTS'] },
    ];
    if (clip.volume !== 1)
        steps.push({ filter: 'volume', anchor: `${key}/volume`,
                     posNames: ['volume'], pos: [n(clip.volume)] });
    if (w.offset > 0.0005)
        steps.push({ filter: 'adelay', anchor: `${key}/adelay`, posNames: ['delays'],
                     pos: [px(w.offset * 1000)], params: { all: '1' } });
    return steps;
}

// ── anchors ────────────────────────────────────────────────────────────────
//
// Every node the derivation makes is named for *what it is*, and the wires
// between them carry named points where something can be put. Both exist for
// the same reason: this whole graph is rebuilt whenever the timeline moves, so
// an id is only good for as long as one derivation lasts, and a position in an
// array means something different afterwards. A name outlives both.
//
// A clip's own id is what makes `clip:7/scale` stable, which is why `buildSpec`
// carries it. A spec written by hand without one falls back to its position,
// which is fine for a test and would not be fine for an edit.

const clipKey = (clip, i) =>
    `clip:${clip.id !== undefined && clip.id !== null ? clip.id : `#${i}`}`;

/// Which control on the properties panel a node's value came from — so that a
/// lock can be reported *there*, against the field it outranks, rather than
/// only on a stage the person editing may not be looking at.
///
/// Not every node has one: `trim`'s numbers come from the range and the clip's
/// position together, and there is no single box on screen holding them.
const CONTROL = {
    crop: 'crop', scale: 'size', opacity: 'opacity', volume: 'volume',
};

export function controlOf(anchor) {
    if (/^composite\/overlay:/.test(anchor || '')) return 'position';
    const m = /\/([a-z]+)$/.exec(anchor || '');
    return (m && CONTROL[m[1]]) || null;
}

/// Which clip a node belongs to, as a string — clip ids are numbers and anchors
/// are text, and comparing the two directly is a bug that only shows up once
/// there are ten clips and one of them is `clip:1` next to `clip:10`.
export function clipOf(anchor) {
    const m = /^clip:([^/]+)\//.exec(anchor || '') ||
              /^composite\/overlay:(.+)$/.exec(anchor || '');
    return m ? m[1] : null;
}

/// The user's layer, put back onto a skeleton that has never seen it.
///
/// Locks first, then insertions, because an insertion's position is described
/// relative to derived nodes and a lock does not move any of them.
///
/// An override is only reported when the lock actually disagrees with what the
/// derivation just produced. A lock that happens to say what the timeline says
/// is still a lock — it will keep saying it after the next drag — but it has
/// outranked nothing yet, and a panel that marked the control anyway would cry
/// wolf on every field anyone had ever touched.
function applyOverlay(g, points, ov, overrides) {
    if (!ov) return;

    for (const node of g.nodes) {
        const lock = node.anchor && ov.locks ? ov.locks[node.anchor] : null;
        if (!lock) continue;
        const keys = [];
        for (const k of Object.keys(lock.params || {}))
            if (String(node.params[k]) !== String(lock.params[k])) keys.push(k);
        // Joined on a character no argument can contain, and written as an
        // escape rather than as itself: a literal NUL in the source makes every
        // tool that reads this file treat it as a binary and refuse to search it.
        if (lock.pos && lock.pos.join('\u0000') !== node.pos.join('\u0000'))
            keys.push('arguments');
        Object.assign(node.params, lock.params);
        if (lock.pos) node.pos = lock.pos.slice();
        node.locked = true;
        overrides.push({ anchor: node.anchor, filter: node.filter,
                         clip: clipOf(node.anchor), control: controlOf(node.anchor), keys });
    }

    for (const rec of ov.inserts || []) {
        const point = points.find((p) => p.id === rec.anchor);
        // Not an error and not something to throw away: a clip trimmed out of
        // the render range takes its insert points with it, and the node comes
        // back when the clip does.
        if (!point) continue;
        const after = g.node(point.at);
        if (!after) continue;
        const node = g.insertAfter(after, {
            id: rec.id, anchor: rec.anchor, filter: rec.filter,
            pos: rec.pos, params: rec.params, derived: false,
        });
        // The label goes with the end of the chain, not with the node that used
        // to be there. Left behind it would be a name no chain produces, and
        // the pad the muxer maps would be invented instead of `vout`.
        if (after.label) { node.label = after.label; after.label = null; }
        // Two nodes at one point run in the order they were added, so the next
        // one goes after this one rather than in front of it.
        point.at = node.id;
    }
}

/// `buildSpec()`'s output → the graph that would render it.
///
/// Returns `{ ok: true, graph, colour, caveats, points, overrides }`, or
/// `{ ok: false, reason }` — and a caller given a refusal must say so rather
/// than print a graph. `points` are the named places on the wires where a
/// filter can go; `overrides` is every lock that disagreed with what was just
/// derived, which is what lets the field it outranked say so.
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
export function derive(spec, sources, opts = {}) {
    if (!spec || !Array.isArray(spec.clips)) return refuse('there is no edit to describe');

    const start = Number(spec.start) || 0;
    const end = Number(spec.end) || 0;
    const length = end - start;
    if (!(length > 0)) return refuse('the range is empty');

    const W = Math.round(spec.width);
    const H = Math.round(spec.height);
    const fps = Number(spec.fps) || 30;
    if (!(W > 0 && H > 0 && fps > 0)) return refuse('the output size or frame rate is not a number');

    // Paint order is the array's order, which the model keeps sorted
    // bottom-track-first — the same order the viewer stacks in and the renderer
    // takes as `z`. Sorting again here would be a second opinion about which
    // clip is in front.
    const kept = [];
    for (let ci = 0; ci < spec.clips.length; ci++) {
        const clip = spec.clips[ci];
        const w = windowOf(clip, start, end);
        if (!w) continue;                       // outside the range; not an error
        const c = cropOf(clip);
        if (c.l + c.r >= 1 || c.t + c.b >= 1)
            return refuse(`a clip is cropped away to nothing`);
        if (!(clip.w > 0 && clip.h > 0) ||
            ![clip.x, clip.y, clip.w, clip.h].every(Number.isFinite))
            return refuse('a clip has no rectangle to be drawn in');
        kept.push({ clip, w, i: kept.length, key: clipKey(clip, ci),
                    src: Array.isArray(sources) ? sources[ci] : null });
    }
    if (!kept.length) return refuse('nothing on the timeline falls inside the range');

    const g = makeGraph({ derived: true });

    // A black canvas of the output's own size and rate, which every clip is
    // laid over. It is also what governs the output's frame rate: overlay's
    // frame sync follows its first input, so the render walks forward at the
    // rate asked for rather than at whatever the topmost source happens to run
    // at — the same thing the renderer does by holding a fixed output clock.
    const base = g.run([], [{
        filter: 'color', anchor: 'base',
        params: { c: 'black', s: `${W}x${H}`, r: n(fps, 6), d: n(length, 6) },
    }], 'base');

    // The named places on the wires where something can be put. `at` is where
    // the *next* insertion goes, which starts as the point's own node and moves
    // along as nodes are spliced in.
    const points = [];
    const point = (id, after, stream, title) => {
        if (after) points.push({ id, after: after.id, at: after.id, stream, title });
    };

    // Nodes are pushed in the order their chains are printed in, and print.js
    // walks the array — so a clip's whole run goes down before the next clip's,
    // and the overlays after all of them.
    const heads = kept.map(({ clip, w, src, i, key }) => {
        const input = g.add({ kind: 'input', stream: 'v', index: i, path: clip.path,
                              anchor: `${key}/in:v`, from: w.srcIn });
        const tail = g.run(input, videoSteps(clip, w, src, key), `v${i}`);
        // Two points per clip, and they are two different pictures: before the
        // scale a filter sees the source at its own size, in its own pixel
        // format and colour; after it, the clip as it will be composited —
        // RGBA, at the size it occupies on the canvas. `hflip` does not care;
        // anything that works in pixels does.
        point(`${key}/after-decode`, input, 'v', 'after decode');
        point(`${key}/after-scale`, g.byAnchor(`${key}/format`), 'v', 'after scale');
        return tail;
    });

    // The last overlay carries the conversion out of the compositing space and
    // into the encoder's, which is the step that decides what colour the render
    // is. Left to swscale's default it is BT.601 whatever the tag says, and the
    // picture comes back green in the shadows.
    const colour = outputColor(spec);
    const toEncoder = [];
    if (!opts.forRender) {
        toEncoder.push({
            filter: 'scale', anchor: 'output/color',
            params: { in_range: 'full', out_color_matrix: colour.sws, out_range: colour.range },
        });
        if (spec.pixelFormat)
            toEncoder.push({ filter: 'format', anchor: 'output/format',
                             posNames: ['pix_fmts'], pos: [spec.pixelFormat] });
    }

    let over = base;
    let lastOverlay = null;
    kept.forEach(({ clip, key }, i) => {
        const c = cropOf(clip);
        const x = clip.x + clip.w * c.l;
        const y = clip.y + clip.h * c.t;
        const last = i === kept.length - 1;
        // `eof_action=pass` because a clip is shorter than the render: when it
        // ends the canvas has to carry on rather than the whole graph stopping,
        // which is the default and would truncate the output at the first clip
        // to run out.
        const steps = [{ filter: 'overlay', anchor: `composite/overlay:${key.slice(5)}`,
                         posNames: ['x', 'y'], pos: [px(x), px(y)],
                         params: { eof_action: 'pass' } }];
        if (last) steps.push(...toEncoder);
        over = g.run([over, heads[i]], steps, last ? 'vout' : `o${i}`);
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
    point('composite/after-overlay', lastOverlay, 'v', 'after compositing');
    g.connect(over, g.add({ kind: 'sink', stream: 'v', anchor: 'out:v' }), 0);

    if (spec.audio !== false) {
        const heard = kept.filter(({ clip }) => !clip.muted && clip.volume > 0);
        const tails = heard.map(({ clip, w, i, key }) => {
            const input = g.add({ kind: 'input', stream: 'a', index: i, path: clip.path,
                                  anchor: `${key}/in:a`, from: w.srcIn });
            const tail = g.run(input, audioSteps(clip, w, key), `a${i}`);
            point(`${key}/audio`, input, 'a', 'clip audio');
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
        point('audio/after-mix', out, 'a', 'after mixing');
        if (out) g.connect(out, g.add({ kind: 'sink', stream: 'a', anchor: 'out:a' }), 0);
    }

    // The user's layer goes on last, over a skeleton that is complete — so an
    // insert point is a wire that exists and a lock is a value that has already
    // been derived and can therefore be reported as outranked.
    const overrides = [];
    applyOverlay(g, points, opts.overlay, overrides);

    // What is known to differ about *this* render, rather than a fixed
    // disclaimer. A note that is always the same is one nobody reads, and the
    // two that matter are only sometimes true.
    const caveats = [];
    if (kept.some(({ src }) => !src))
        caveats.push('a source’s colour is not known here, so swscale guesses ' +
                     'the matrix the renderer reads from the file');
    if (kept.some(({ src }) => src && src.fps > 0 && Math.abs(src.fps - fps) > 0.01))
        caveats.push('the output rate differs from a source’s, and a fixed-rate ' +
                     'walk and a frame-sync do not choose the same frames');

    return { ok: true, graph: g, colour, caveats, points, overrides };
}

function refuse(reason) { return { ok: false, reason }; }
