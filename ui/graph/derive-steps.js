// Derived step builders, source/colour helpers, and overlay application for
// `ui/graph/derive.js`.

import { byKey } from './model.js';
import { padsOf } from './filters.js';

/// Numbers, short. ffmpeg's parser is happy with any of these, and a graph full
/// of `0.30000000000000004` is one nobody reads.
export function n(v, dp = 3) {
    const r = Number(Number(v).toFixed(dp));
    return Object.is(r, -0) ? '0' : String(r);
}

export const px = (v) => String(Math.round(v));

/// What a clip has taken off each edge, as fractions. A clip that has never
/// been cropped carries no crop at all, and three copies of that default were
/// three places for "no crop" to come to mean something slightly different.
export const cropOf = (clip) => clip.crop || { l: 0, t: 0, r: 0, b: 0 };

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
///
/// **`length` and `offset` are on the output's clock and `srcIn`/`srcOut` are on
/// the source's, and `speed` is the slope between them** — the same statement
/// `ui/project.js` makes about `length` and `sourceSpan`, in filter vocabulary.
/// A clip at 2× spends two seconds of its file per second of the render, so its
/// `trim` is twice as wide as its bar and the `setpts` below divides.
export function windowOf(clip, start, end) {
    const from = Math.max(clip.start, start);
    const to = Math.min(clip.start + clip.length, end);
    if (to - from <= 1e-6) return null;
    const speed = speedOf(clip);
    return {
        srcIn: clip.inPoint + (from - clip.start) * speed,
        srcOut: clip.inPoint + (to - clip.start) * speed,
        offset: from - start,
        length: to - from,
        speed,
    };
}

/// How fast a clip runs, off the spec.
///
/// `ui/project.js`'s `speedOf` asked of a spec's clip rather than of the model's,
/// so this stays a pure function of its argument — and so that a spec written by
/// hand in a test, which carries no `speed` at all, derives exactly as it always
/// did. **The rule is the model's and it is stated in one sentence in each place:**
/// anything that is not a positive number is 1, because zero would be a freeze and
/// negative would be reverse and neither is expressible here.
export const speedOf = (clip) => {
    const s = Number(clip && clip.speed);
    return Number.isFinite(s) && s > 0 ? s : 1;
};

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
export function sourceColor(src) {
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
export function videoSteps(clip, w, src, key, off, onDevice) {
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
        // is what reads it — and `moves` is the constant **at speed 1**, which is
        // why a sped-up clip's late filters are refused a view there rather than
        // shown on a clock a constant cannot express.
        //
        // **A clip's speed is the divisor on this node**, because this is the
        // node that maps the source's seconds onto the render's and a speed is
        // nothing but the slope of that map. `(PTS-STARTPTS)/speed` and not an
        // `fps` or a `setpts` of somebody's: the frames are not resampled, they
        // are re-stamped, and the canvas's own rate is what the render walks at
        // (see `base` below). The sound's half is two filters and says why.
        { filter: 'setpts', anchor: `${key}/setpts`, posNames: ['expr'],
          pos: [w.speed === 1
                    ? `PTS-STARTPTS+${n(w.offset + off, 6)}/TB`
                    : `(PTS-STARTPTS)/${n(w.speed, 6)}+${n(w.offset + off, 6)}/TB`],
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
export function audioSteps(clip, w, key, off, rate) {
    const steps = [
        { filter: 'atrim', anchor: `${key}/atrim`,
          params: { start: n(w.srcIn, 6), end: n(w.srcOut, 6) } },
    ];
    // **Speed resamples, and the pitch moves with it.** `asetrate` reinterprets
    // the samples as though they had been recorded at another rate — which is
    // exactly what the compositor asks libav's own `swr` for by multiplying the
    // input rate by the speed (`SourceAudio::open`, one home for the same rule at
    // the other end) — and `aresample` puts them back on the rate the file was
    // at, so nothing downstream has to know this happened.
    //
    // The pitch-preserving answer is `atempo`, which is WSOLA and is a
    // libavfilter filter: there is no graph inside `TimelineSource::mixInto`, so
    // taking it would mean the compositor resampling while this printed `atempo`
    // — a graph describing a render this application would not perform, which is
    // the one thing this file exists not to write. So it is a filter somebody
    // places, and `caveats` says so.
    //
    // Before the `asetpts`, so the offset below is on the output's clock and not
    // divided by the speed along with everything else; and after the `atrim`,
    // whose numbers are the source's own seconds.
    if (w.speed !== 1) {
        steps.push({ filter: 'asetrate', anchor: `${key}/asetrate`, posNames: ['sample_rate'],
                     pos: [px(rate * w.speed)] });
        steps.push({ filter: 'aresample', anchor: `${key}/aresample`,
                     posNames: ['sample_rate'], pos: [px(rate)] });
    }
    steps.push(
        // The sound's half of the clock, and it is in two filters where the
        // picture's is in one — see `moves` on the `setpts` above. This node
        // carries the range's origin; the `adelay` below carries where the clip
        // sits in it, because that part of the offset is silence rather than
        // arithmetic.
        { filter: 'asetpts', anchor: `${key}/asetpts`, posNames: ['expr'],
          pos: [off ? `PTS-STARTPTS+${n(off, 6)}/TB` : 'PTS-STARTPTS'],
          moves: off - w.srcIn });
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

export const clipKey = (clip, i) =>
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
export function inputInfo(spec, id) {
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
export function inputOnDevice(spec, index) {
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
export function clipHasSound(spec, clip) {
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

/// What rate this clip's soundtrack is at, or 0 for "the spec did not say".
///
/// Only a clip with a **speed** needs it — see `audioSteps`, where `asetrate` takes
/// a number and not an expression over the input's rate — and 0 is refused there
/// rather than defaulted, because `asetrate`'s own default is 44100 and a chain
/// that resampled a 48 kHz file through it would be a graph describing a render
/// this application would not perform. A hand-written spec carries no `inputInfo`
/// and no `speed`, so nothing in `tests/` reaches this.
export function clipSoundRate(spec, clip) {
    const list = Array.isArray(spec.inputInfo) ? spec.inputInfo : [];
    const info = list[clip.input];
    return Math.round(Number(info && info.sampleRate)) || 0;
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
export function clipHasPicture(spec, clip) {
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
export const generatorOf = (clip) =>
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
export function applyOverlay(g, points, ov, overrides) {
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
export function applyLocks(g, nodes, ov, overrides) {
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
export function applyStructure(g, ov, stranded) {
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
export function declarePads(g) {
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
export function outputColour(g, spec, colour) {
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
