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
// The input is `buildSpec()`'s output and nothing else, which is the same
// object the renderer is driven from — so this cannot describe a render the
// application would not perform. When an edit cannot be expressed faithfully
// this returns a refusal rather than an approximation: a graph that is nearly
// right is worse than no graph, because the whole reason to show one is that it
// can be taken somewhere else and run.

import { makeGraph, byKey } from './model.js';
import { padsOf, isSource } from './filters.js';
import { problems } from './check.js';
import { whyNotAClip } from '../generator.js';

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
    // **A `yuvj*` pixel format *is* the statement that the picture is full
    // range** — that is the whole of what the J means — so the writer derives
    // the range from it and not only from the control (`impliedFull` in
    // `export_writer.cpp`, where a limited-range tag alongside one is what
    // mjpeg refuses at `avcodec_open2`). Without the same term here the command
    // printed `-color_range tv` and `out_range=tv` for a render that tags and
    // converts to JPEG range: copy it and you get a different picture, which is
    // the one thing this bar must never do.
    //
    // Only an explicit choice reaches it. Left on auto the writer takes
    // `pickPixelFormat`, which prefers `yuv420p` wherever the encoder has it —
    // and mjpeg does, so even picking image2 lands on the limited-range form
    // unless somebody says otherwise.
    const impliedFull = /^yuvj/.test(String(spec.pixelFormat || ''));
    const full = impliedFull || spec.colorRange === 'pc';
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
///
/// `off` is where this render's window sits on the render's own clock — see
/// `origin` in `derive()`. It is zero for an export and for anything else that
/// renders the whole range, and non-zero for the short windows the preview and
/// the A/B comparison render, which have to carry the same clock or a filter
/// whose `enable=` names a moment would come on at a different one.
function videoSteps(clip, w, src, key, off, onDevice) {
    const c = cropOf(clip);
    const keepW = 1 - c.l - c.r;
    const keepH = 1 - c.t - c.b;

    const steps = [];
    // An input told to keep its pictures on the card starts with them coming
    // back off it, because the next four filters read pixels: `crop` is
    // arithmetic on plane pointers, `scale` is swscale, `format` is a
    // conversion. **This is the same thing the compositor does** — `rgbaAt`
    // downloads whatever it is handed — so the printed command and the render
    // agree, which is the whole claim the two paths are measured against.
    //
    // Written here rather than left for the person to insert, because it is not
    // a choice: a graph without it does not run, and libavfilter's message for
    // it is four hundred pixel format names and no filter. Where somebody wants
    // the picture to stay up, they put `hwupload` back on the wire — which is a
    // thing they did on purpose and can see.
    if (onDevice) {
        steps.push({ filter: 'hwdownload', anchor: `${key}/hwdownload` });
        steps.push({ filter: 'format', anchor: `${key}/hwformat`,
                     posNames: ['pix_fmts'], pos: ['nv12'] });
    }
    steps.push(
        { filter: 'trim', anchor: `${key}/trim`,
          params: { start: n(w.srcIn, 6), end: n(w.srcOut, 6) } },
        // **This is where a clip stops being on the file's clock and starts
        // being on the render's**, which is why `moves` is stated here and
        // nowhere else. Everything above this node sees the timestamps the file
        // has and everything below sees the moment the edit puts them at, and
        // the two insert points a person can reach are one on each side of it.
        //
        // `moves` is what the expression comes to rather than a term in it:
        // `STARTPTS` is the first frame the render reads, which is `srcIn`,
        // because the `trim` above has already thrown away everything earlier.
        // A render always starts at that frame and can write the map relative
        // to it; the viewer can be sitting anywhere in the file, so the same map
        // has to be written as the constant it amounts to. `ui/graph/playback.js`
        // is what reads it.
        { filter: 'setpts', anchor: `${key}/setpts`, posNames: ['expr'],
          pos: [`PTS-STARTPTS+${n(w.offset + off, 6)}/TB`],
          moves: w.offset + off - w.srcIn });
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
///
/// `off` — where this window sits on the render's clock — goes on the
/// `asetpts` and not on the `adelay`, and the difference is not cosmetic.
/// `adelay` prepends real silence; carrying a window five minutes into a render
/// there would prepend five minutes of it. `asetpts` moves the timestamps and
/// adds no samples, which is exactly what a clock offset is.
function audioSteps(clip, w, key, off) {
    const steps = [
        { filter: 'atrim', anchor: `${key}/atrim`,
          params: { start: n(w.srcIn, 6), end: n(w.srcOut, 6) } },
        // The sound's half of the clock, and it is in two filters where the
        // picture's is in one — see `moves` on the `setpts` above. This node
        // carries the range's origin; the `adelay` below carries where the clip
        // sits in it, because that part of the offset is silence rather than
        // arithmetic.
        { filter: 'asetpts', anchor: `${key}/asetpts`, posNames: ['expr'],
          pos: [off ? `PTS-STARTPTS+${n(off, 6)}/TB` : 'PTS-STARTPTS'],
          moves: off - w.srcIn },
    ];
    if (clip.volume !== 1)
        steps.push({ filter: 'volume', anchor: `${key}/volume`,
                     posNames: ['volume'], pos: [n(clip.volume)] });
    if (w.offset > 0.0005)
        steps.push({ filter: 'adelay', anchor: `${key}/adelay`, posNames: ['delays'],
                     pos: [px(w.offset * 1000)], params: { all: '1' },
                     moves: w.offset });
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

/// The two insert points that are not about one clip: the whole canvas, and the
/// whole soundtrack.
///
/// Named here because this is where they are declared, and exported because two
/// other files place nodes at them — `ui/measure.js`, which puts a measuring
/// filter where the thing being measured is, and `ui/sources.js`, whose
/// `Burn it into the picture` puts a `subtitles` filter over the composite.
/// **An insert whose anchor no derivation declares is dropped without a word**
/// (see `applyOverlay`), which is right for a clip that has been trimmed out of
/// the range and is silent ruin for a name that has been mistyped: the button
/// does nothing, the node never appears, and there is nothing on the screen to
/// say so. A constant is what makes that unreachable rather than something to
/// remember.
export const COMPOSITE_POINT = 'composite/after-overlay';
export const MIX_POINT = 'audio/after-mix';

/// One of the document's inputs, by the id the overlay wrote down.
///
/// `spec.inputInfo` runs parallel to `spec.inputs` and carries what the graph
/// needs and the renderer does not: which input this is (an id survives a list
/// being reordered where an index does not), what it turned out to contain, and
/// what to call it. The renderer ignores it exactly as it ignores `clip.id`,
/// and for the same reason — it is a fact about the document rather than about
/// the render.
function inputInfo(spec, id) {
    const list = Array.isArray(spec.inputInfo) ? spec.inputInfo : [];
    for (let i = 0; i < list.length; i++)
        if (list[i] && list[i].id === id) return Object.assign({ index: i }, list[i]);
    return null;
}

/// Was this `-i` told to keep its pictures on the card?
///
/// **One place, because the answer is written onto every input node and read
/// back by `check.js`.** It used to be asked twice with two different terms —
/// here as `hwaccel && hwaccelOutputFormat`, and in `check.js` as
/// `hwaccelOutputFormat` alone, off the *live* `inputs` list rather than off
/// the spec. Both parts of that were wrong to have: the derivation is a pure
/// function of its arguments, and a second reading of one fact is a
/// disagreement waiting for the first input that carries an output format with
/// no `-hwaccel` in front of it.
///
/// `-hwaccel_output_format` is meaningless without `-hwaccel`: it names the
/// format the *device's* frames come back as, and there is no device without
/// the first word. So both are required, which is what `sources.js` already
/// enforces at the control (picking a device clears the format) and what
/// `command.js` prints.
function inputOnDevice(spec, index) {
    const from = (spec.inputs || [])[index];
    return !!(from && from.hwaccel && from.hwaccelOutputFormat);
}

/// Does this clip's `-i` have a soundtrack for the mix to read at all?
///
/// **A muted clip and a clip of a file with no audio stream are two different
/// facts**, and only the first was ever asked about. `volume` defaults to 1 and
/// `muted` to false whatever the file turns out to contain, so a video-only
/// input produced an `[0:a]atrim…[a0]` chain reading a pad that does not exist
/// — a graph real ffmpeg refuses with "Stream specifier ':a' matches no
/// streams", printed under every stage as the command about to be run.
///
/// Asked of `spec.inputInfo`, which runs parallel to `spec.inputs` and carries
/// what the probe found, so this stays a pure function of the spec. **A spec
/// that does not carry it answers yes**, which is what this always assumed and
/// is what keeps every hand-written spec in `tests/` deriving exactly as it did.
function clipHasSound(spec, clip) {
    // A generator has no `-i` for the mix to read, so there is no pad and the
    // question is not "was it muted". Said before the list is consulted because
    // `clip.input` is -1 for one and `list[-1]` is undefined, which the rule
    // below reads as *yes* — an `[-1:a]atrim…` chain reading a stream that does
    // not exist. Sound sources are not clips (see ui/generator.js): one is wired
    // to the mix on the Graph stage, where it has a pad to be wired to.
    if (clip.generator) return false;
    const list = Array.isArray(spec.inputInfo) ? spec.inputInfo : [];
    const info = list[clip.input];
    if (!info || !Array.isArray(info.streams)) return true;
    return info.streams.indexOf('a') >= 0;
}

/// And does it have a picture?
///
/// The mirror of the question above, asked of the same list for the same
/// reason. A clip of a file with sound and no video is an ordinary clip — it
/// contributes to the mix and to nothing else — so it gets no `[0:v]` pad, no
/// `trim`/`scale` run and no `overlay` onto the canvas. Without the term it got
/// all three: `viewer.placement()` hands back no rectangle for one, and the
/// derivation refused the whole edit with "a clip has no rectangle to be drawn
/// in" — a true sentence about a graph that should not have been trying to draw
/// it.
///
/// **A spec that does not carry `inputInfo` answers yes**, which is what every
/// hand-written spec in `tests/` has always meant.
function clipHasPicture(spec, clip) {
    const list = Array.isArray(spec.inputInfo) ? spec.inputInfo : [];
    const info = list[clip.input];
    if (!info || !Array.isArray(info.streams)) return true;
    return info.streams.indexOf('v') >= 0;
}

/// The generator a clip is of, or null for a clip of a file.
///
/// **A clip has one source or the other**, and which it is decides only what sits
/// at the head of its run: a filter that makes pictures out of nothing, or an
/// `-i` its pictures are decoded from. Everything below that node — the trim, the
/// clock, the crop, the scale, the opacity and the overlay — is written by the
/// same code for both, because it is the same edit.
const generatorOf = (clip) =>
    (clip && clip.generator && clip.generator.filter) ? clip.generator : null;

// `whyNotAClip` is imported rather than written again: **refused rather than
// approximated** is this file's rule, and the case it protects against is a
// filter with an input pad at the head of a clip's run — a graph with an empty
// socket in it, which libavfilter refuses after this application has drawn it
// with a message about a pad rather than about the thing somebody did. The door a
// person comes through asks the same question before there is a clip; this asks
// it of the *spec*, which is where a hand-written one in a test arrives.

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
    applyLocks(g, g.nodes, ov, overrides);

    for (const rec of ov.inserts || []) {
        const point = points.find((p) => p.id === rec.anchor);
        // Not an error and not something to throw away: a clip trimmed out of
        // the render range takes its insert points with it, and the node comes
        // back when the clip does.
        //
        // **And, unlike a stranded wire, not reported either** — which is the
        // one place in this file that departs from "keep what you could not
        // place and say so", so it is worth being explicit about why. A wire
        // whose pad stopped existing leaves an *input pad empty*: the graph on
        // screen is one libavfilter refuses, the person has to put the count
        // back by hand, and rendering it as though the connection had never
        // been made would be a different render. An insert whose anchor is out
        // of range adds no node at all — there is nothing wrong with the graph
        // that is drawn, nothing to act on, and the state comes back on its own
        // the moment the range or the timeline includes that clip again.
        // Reported, it would fire on every drag of the range handles.
        if (!point) continue;
        const after = g.node(point.at);
        if (!after) continue;
        const node = g.insertAfter(after, {
            id: rec.id, anchor: rec.anchor, filter: rec.filter,
            pos: rec.pos, params: rec.params, derived: false,
        }, point.atPort || 0);
        // The label goes with the end of the chain, not with the node that used
        // to be there. Left behind it would be a name no chain produces, and
        // the pad the muxer maps would be invented instead of `vout`.
        if (after.label) { node.label = after.label; after.label = null; }
        // Two nodes at one point run in the order they were added, so the next
        // one goes after this one rather than in front of it — and the spliced
        // node is a filter, so what leaves it leaves by its only pad.
        point.at = node.id;
        point.atPort = 0;
    }
}

/// The locks over a given set of nodes.
///
/// Taken as a list rather than reaching for `g.nodes` because it is run twice:
/// the skeleton is locked before anything is spliced into it, and the output
/// colour conversion is not part of the skeleton — it is attached at the very
/// end, after the user's own structure, for reasons written where it happens.
/// A node that arrives after the pass has run would otherwise be the one node
/// on the screen that cannot be edited.
function applyLocks(g, nodes, ov, overrides) {
    if (!ov || !ov.locks) return;
    for (const node of nodes) {
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
}

/// The part of the overlay that is *structure*: nodes on no wire, wires nobody
/// derived, and derived wires somebody took off.
///
/// Applied after the locks and the insertions and in that order, because each
/// step is described in terms of what the ones before it produced. A lock can
/// change how many pads a node has — `amix`'s count is an option like any other
/// — so the pads are worked out between the two, and a wire can only be checked
/// against pads that exist by then.
///
/// **An endpoint naming something this graph does not contain is kept, not
/// dropped.** That is the same rule an insert point already follows and it is
/// the same situation: a clip trimmed out of the render range takes its nodes
/// and its wires with it, and both come back when the clip does. Nothing here
/// writes to the overlay.
function applyStructure(g, ov, stranded) {
    ov = ov || {};

    for (const rec of ov.nodes || []) {
        // An input the graph reads is built up in `derive` itself, where the
        // spec's input list and the `-i` numbering are: it is a *file*, not a
        // filter, and a filter is all this loop knows how to make.
        if (rec.kind === 'input') continue;
        // A named output, which is a sink of a person's own — one input pad,
        // no outputs, and a name the chain feeding it will be printed with.
        // Its pad is declared here rather than by `declarePads` below, which
        // asks libavfilter and has nothing to ask about a sink; the stream on
        // it is what the first wire brought, and an output nobody has wired
        // yet declares a pad that takes either, because it has not been told.
        if (rec.kind === 'sink') {
            g.add({ id: rec.id, kind: 'sink', name: rec.name || '',
                    stream: rec.stream || '', derived: false,
                    ins: [{ stream: rec.stream || '' }] });
            continue;
        }
        g.add({ id: rec.id, filter: rec.filter, pos: rec.pos, params: rec.params,
                derived: false });
    }

    // Every graph gets its pads worked out, overlay or no overlay: what a node
    // reads is a fact about the filter, and the checker asks it of the skeleton
    // exactly as it asks it of a node somebody placed.
    declarePads(g);

    for (const c of ov.cuts || []) {
        const at = String(c).split('#');
        const node = byKey(g, at[0]);
        if (node) g.disconnectAt(node, Number(at[1]) || 0);
    }

    for (const w of ov.wires || []) {
        const from = byKey(g, w.from), to = byKey(g, w.to);
        if (!from || !to) continue;
        // A pad the node no longer has, because the option that decides its
        // count was changed under the wire. **Not silently dropped**: the wire
        // stays in the overlay, so putting the count back brings it back, and it
        // is reported by name so that the graph is refused rather than rendered
        // as though the connection had never been made.
        if ((w.fromPort || 0) >= g.outPorts(from) || (w.port || 0) >= g.inPorts(to)) {
            stranded.push({ node: to, from, port: w.port || 0, fromPort: w.fromPort || 0 });
            continue;
        }
        g.disconnectAt(to, w.port || 0);
        g.connect(from, to, w.port || 0, w.fromPort || 0);
    }
}

/// What each filter node reads and writes, asked of libavfilter.
///
/// Every node gets it, derived and user alike, because the questions it answers
/// are asked of every node: how many sockets a card draws, where a wire may
/// land, and whether an input pad is empty. Counting the wires instead — which
/// is what everything here did while the derivation was the only thing making
/// graphs — cannot answer the last one at all, since a pad with no wire on it is
/// invisible to a count of wires.
///
/// A filter this build does not have gets nothing, and `check.js` says so. There
/// is no shape to invent for a name libavfilter will refuse.
function declarePads(g) {
    for (const n of g.nodes) {
        if (n.kind !== 'filter') continue;
        const pads = padsOf(n.filter, n.params, n.pos);
        if (!pads) continue;
        n.ins = pads.ins.map((s) => ({ stream: s }));
        n.outs = pads.outs.map((s) => ({ stream: s }));
    }
}

/// The conversion out of the compositing space and into the encoder's, spliced
/// in front of the video sink.
///
/// This is the step that decides what colour the render is: left to swscale's
/// default it is BT.601 whatever the tag says, and the picture comes back green
/// in the shadows. It is only in the *printed* graph, because on this
/// application's own path the writer does it — see `forRender` — which is why
/// it is attached here rather than built into the skeleton, and why there is no
/// insert point and no socket anywhere behind it.
///
/// Returns the nodes it made, so the caller can offer them to the locks: a node
/// that arrives after the lock pass has run would be the one node on the screen
/// that cannot be edited.
function outputColour(g, spec, colour) {
    const sink = g.byAnchor('out:v');
    const e = sink ? g.inEdges(sink)[0] : null;
    // Nothing is mapped — a wire somebody cut. The checker says so; putting a
    // colour conversion on the end of nothing would not.
    if (!e) return [];
    const src = g.node(e.from);
    if (!src) return [];

    const steps = [{
        filter: 'scale', anchor: 'output/color',
        params: { in_range: 'full', out_color_matrix: colour.sws, out_range: colour.range },
    }];
    if (spec.pixelFormat)
        steps.push({ filter: 'format', anchor: 'output/format',
                     posNames: ['pix_fmts'], pos: [spec.pixelFormat] });

    const before = g.nodes.length;
    const tail = g.run({ node: src, out: e.fromPort || 0 }, steps);
    g.disconnectAt(sink, 0);
    g.connect(tail, sink, 0);
    return g.nodes.slice(before);
}

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
            outs: streams.map((s) => ({ stream: s })),
        });
        streams.forEach((s, i) =>
            point(`${rec.id}/after-decode:${i}`, node, i, s,
                  s === 'a' ? 'input sound' : 'after decode'));
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
        const tails = heard.map(({ clip, w, i, key }) => {
            // The clip's own input node, given a second output. A pad is added
            // when something reads it rather than for every stream the file
            // happens to carry: a muted clip is not read for its sound, and a
            // socket wired to nothing would be a claim about the render that
            // the render does not make.
            const input = inputs.get(key);
            const out = input.outs.length;
            input.outs.push({ stream: 'a' });
            const tail = g.run({ node: input, out }, audioSteps(clip, w, key, off), `a${i}`);
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
    if (kept.some(({ src }) => src && src.fps > 0 && Math.abs(src.fps - fps) > 0.01))
        caveats.push('the output rate differs from a source’s, and a fixed-rate ' +
                     'walk and a frame-sync do not choose the same frames');

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
