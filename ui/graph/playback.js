// A clip's own filters, running in the program monitor.
//
// Everything else in this application already runs the filters somebody put on
// the graph — the render runs them, the export preview runs them, a node's card
// renders them. The viewer could not, and the reason was structural: playback
// is bro's `<video>` decoding a file and there was no filtergraph anywhere in
// that path. A clip with an `eq` on it played back as it was shot, wore an `fx`
// badge to say so, and only looked right once a render had run.
//
// `src/native/playback_filter.h` is the other half — a **view**, which is an
// input plus the chain each of its streams goes through, registered under an id
// and named by a token an element is pointed at. This file decides what to ask
// for. Four decisions, and each of them is about being *the same* as the render
// rather than about being close to it:
//
// **The chain is read off the derived graph, in the order the graph runs it.**
// Not assembled from the overlay's insert list, which is stored in the order
// things were added and says nothing about where in a clip's run they landed.
// A filter inserted before the derived `scale` and one inserted after it are
// two different pictures, and the only thing that knows which is which is the
// graph — so the walk goes down the clip's run from its input node and takes
// the nodes a person put there, in the order it meets them.
//
// **Only the user's nodes.** The derived run around them — `trim`, `setpts`,
// `crop`, `scale`, `colorchannelmixer` — is the timeline's own doing, and the
// viewer already performs every one of those: the crop window, the placement
// rectangle, the opacity style, the playhead. Running them again in the chain
// would be the picture laid out twice.
//
// **The clock changes where the render changes it.** `enable=` names a moment
// on the render — `between(t,5,10)` is five seconds into what will be written —
// and a clip half an hour into a recording plays back on the file's own
// timestamps. But the two places a filter can be put are on opposite sides of
// the node that reconciles those: the derivation's `setpts` sits between them,
// so in the *render* a filter inserted after the decode sees the file's clock
// and one inserted after the scale sees the edit's. Moving the whole chain onto
// the edit's clock would therefore be right for one insert point and wrong for
// the other. So the walk below keeps that `setpts`, written as the constant it
// comes to (`moves`, stated by `derive.js` on the node itself), and a view's
// `shift` is only how much of it to take back off at the end — the element's
// clock is the file's, whatever the filters in between did to it.
//
// **A clip's size is what its chain makes of it.** A `crop` or a `scale` put on
// a clip does not only change its pixels, it changes how big the picture *is* —
// and one number decides everything about where a picture goes:
// `viewer.placement()` fits it, `buildSpec` carries the rectangle that fitting
// produced, and the derivation's own `scale` sizes the clip into that rectangle.
// So `sizeFor` reports what the chain settled on and the layout asks it before
// it asks the probe. Reported rather than written onto the clip: `clip.width` is
// what the *file* holds, which is a different question and still has an answer.
//
// That is also what makes the picture on the screen and the picture in the
// render the same one. The viewer stretches the element into the rectangle; the
// render scales the chain's output into the same rectangle and lays it there.
// Neither of them knows a filter resized anything, and the rectangle is the
// shape the filter made — which is the whole of what applying a resize *in
// place* comes to.
//
// **A chain that cannot be shown honestly is not shown.** Two cases, and both
// keep the badge rather than drawing something nearly right:
//
//   - **a resize below the point where the clip is placed.** The derivation's
//     `scale` is where a clip stops being its own size and becomes a rectangle
//     on the canvas, and the render lays whatever comes out below that node over
//     the canvas *at its own size*, at the rectangle's top-left — so a `crop`
//     inserted after the scale is not a rectangle at all and there is nothing
//     for the viewer to place. Which side of the scale a filter is on is what
//     the walk below counts, because `views.define` reports one size for the
//     whole chain and cannot say where in it the size changed: a resize on the
//     way *in* with any filter of somebody's below the scale is refused as well,
//     since from one number there is no telling which of the two did it.
//   - **filters that are not one run.** A hand-wired fork, a node placed on the
//     canvas and wired into the middle of a clip, anything with two producers:
//     playback is one stream through one chain, and half of a graph shown as
//     though it were the whole of it is worse than the badge.

import { derive } from './derive.js';
import { filterArgs } from './print.js';
import { inputFor } from '../generator.js';

/// `spec()` — the whole timeline as a render spec, with `origin` set to where
/// the export range starts so the graph's clock is the render's; `sources()`
/// and `overlay()` are `derive`'s other two arguments. Hooks rather than
/// imports for the reason `preview.js` takes hooks: this is reached from the
/// viewer, and the spec is built out of the viewer.
let hooks = {};
export function initPlayback(h) { hooks = h || {}; }

/// clip id → `{ key, src, why }`. `key` is what was asked for last time, so a
/// change to anything else on the timeline costs one derivation and no opens.
const state = new Map();

/// The src this clip's `<video>` should be pointed at, or '' for its input's
/// own token. Read by the viewer when it builds an element and when this file
/// says something has moved.
export function srcFor(id) {
    const s = state.get(id);
    return (s && s.src) || '';
}

/// What was last asked for on this clip's behalf — `{ input, video, audio,
/// shift }` — or null for a clip playing its input plainly.
///
/// A read accessor and nothing else, and it exists because the two things that
/// have to agree with the render exactly are the chain's *order* and its clock,
/// and neither is visible in a picture: a viewer showing the right pixels a
/// minute late is indistinguishable from one showing them on time until
/// somebody seeks. `tests/ui_graph.js` reads it.
export function viewFor(id) {
    const s = state.get(id);
    return (s && s.ask) || null;
}

/// The size this clip's picture *is* — `{ w, h }`, what its chain produced — or
/// null for a clip whose element is playing its input plainly.
///
/// Read by `viewer.placement()` before it reads the probe, which is what puts a
/// resizing filter into the layout rather than into a badge; see the note at the
/// top of this file. Null rather than the source's size, so that the one place
/// with a default keeps it: a clip with no picture at all has neither.
export function sizeFor(id) {
    const s = state.get(id);
    return (s && s.size) || null;
}

/// Why this clip's filters are not on the screen, for a clip that has some and
/// is not showing them. Empty when there is nothing to say — which includes the
/// ordinary case of a clip with no filters at all.
export function whyFor(id) {
    const s = state.get(id);
    return (s && s.why) || '';
}

/// The graph the viewer is playing, or null.
///
/// Derived over the **whole timeline** rather than over the export range,
/// because a clip outside the range is still on the screen and its filters are
/// still its filters. What that costs is nothing: `derive` is a walk over a
/// handful of clips, and the trims it writes are never rendered from here.
function graphNow(spec) {
    if (!spec || !Array.isArray(spec.clips)) return null;
    const d = derive(spec, hooks.sources ? hooks.sources() : null,
                     { overlay: hooks.overlay ? hooks.overlay() : null });
    return d.ok && d.graph ? d.graph : null;
}

/// The node a clip's run starts at: the `-i` its pictures are decoded from, or —
/// for a generator clip — the filter that makes them.
///
/// Both, because a view is an *input plus chains* and a generator is an input:
/// `-f lavfi -i testsrc=size=…` is what `ui/generator.js` registered for the
/// element in the first place, so a `hue` put on a colour card is shown by
/// exactly the mechanism that shows a `hue` put on a shot. Without this arm the
/// walk found no head, the chain came back empty, and the clip wore the `fx`
/// badge for a filter there was nothing standing in the way of.
function headOf(g, id) {
    return g.nodes.find((n) => n.anchor === `clip:${id}/in` || n.anchor === `clip:${id}/gen`)
        || null;
}

/// What the derivation called a step: `clip:3/format` → `format`.
///
/// The anchor and not `controlOf`, which answers a different question — *which
/// box on the properties panel wrote this* — and has an entry only for the four
/// nodes a control owns. Asking it about `format` gets a null, and a walk that
/// took the null for "nothing to contribute" dropped every conversion below
/// while the comment said they were kept.
function stepOf(anchor) {
    const m = /\/([a-z]+)$/.exec(String(anchor || ''));
    return m ? m[1] : '';
}

/// Seconds, as a filter argument. Six places, which is a microsecond and two
/// orders of magnitude finer than a frame.
const secs = (x) => String(Number(Number(x).toFixed(6)));

/// What a *derived* node contributes to a playback chain, on one stream.
///
/// **Geometry and level are the viewer's; the clock and what the pixels mean
/// are the chain's.** The crop window, the placement rectangle and the opacity
/// style are things the program monitor already does, so `trim`, `crop`,
/// `scale`'s size and `colorchannelmixer` are dropped — kept, they would be the
/// picture laid out twice.
///
/// The conversions are not like that, and leaving them out is how a filter
/// comes to look different here from in the render: a `negate` spliced in after
/// the derivation's `format=rgba` inverts red, green and blue, and the same
/// filter handed the decoder's yuv420p inverts luma and chroma, which is a
/// different picture and not a rounding difference. So `format` and
/// `hwdownload` are kept verbatim, and `scale` is kept **at the picture's own
/// size** — `iw`/`ih`, with its colour arguments untouched, because the matrix
/// and range it converts through are the render's answer to a question playback
/// asks in exactly the same words.
///
/// The clock is kept for the reason at the top of this file, and kept *as a
/// filter* rather than as the view's `shift`, because where it happens is the
/// whole of what it means. What goes in is a constant and not the derivation's
/// own `PTS-STARTPTS+x/TB`: playback is sitting wherever the playhead is, so
/// there is no first frame for `STARTPTS` to be. The `adelay` on the sound is
/// the same number arriving as silence, and silence is exactly what the viewer
/// must not add — a clip that starts a minute in would take a minute to make a
/// sound — so it contributes its clock and nothing else.
function derivedStep(node, stream) {
    if (Number(node.moves))
        return `${stream === 'a' ? 'asetpts' : 'setpts'}=PTS+${secs(node.moves)}/TB`;
    const step = stepOf(node.anchor);
    if (step === 'format' || step === 'hwformat' || step === 'hwdownload')
        return filterArgs(node);
    if (step === 'scale')
        return filterArgs({ filter: 'scale', pos: ['iw', 'ih'], params: node.params || {} });
    return '';
}

/// One clip's user filters on one stream, as `-vf`/`-af` text.
///
/// Returns `{ ok: true, text, shift, late }` or `{ ok: false, reason }` —
/// `shift` being how far the text moves the clock, so the caller can say what to
/// take back off at the end, and `late` how many of the user's filters are below
/// the derivation's `scale`, which is the node that decides whether a resize is
/// a rectangle or a picture laid over one. Walking rather than filtering, because
/// both answers are about *order* and only the wires know it.
function chainOf(g, id, stream) {
    const key = `clip:${id}/`;
    const head = headOf(g, id);
    if (!head) return { ok: true, text: '', shift: 0, late: 0 };
    const port = (head.outs || []).findIndex((o) => o.stream === stream);
    if (port < 0) return { ok: true, text: '', shift: 0, late: 0 };  // not read for that

    const parts = [];
    let user = 0;
    let late = 0;
    let placed = false;
    let shift = 0;
    let edges = g.outEdges(head).filter((e) => (e.fromPort || 0) === port);
    for (;;) {
        // A pad read twice is a fork, and a fork is not a chain. Said before
        // anything is collected as well as after, because the split can be the
        // very first thing on the run.
        if (edges.length !== 1)
            return user
                ? { ok: false, reason: 'these filters fork, and playback runs one chain' }
                : { ok: true, text: '', shift: 0, late: 0 };
        const node = g.node(edges[0].to);
        if (!node) break;
        // Out of this clip: the compositor's `overlay`, the mix, or the sink.
        // The ordinary end of the walk.
        if (String(node.anchor || '').indexOf(key) !== 0) break;
        if (node.kind !== 'filter') break;
        if (g.inEdges(node).length !== 1)
            return { ok: false,
                     reason: 'these filters read more than one pad, and playback plays one clip' };
        if (node.derived) {
            const step = derivedStep(node, stream);
            if (step) parts.push(step);
            shift += Number(node.moves) || 0;
            // Everything from here down is running on a picture the size of the
            // rectangle this clip is drawn in, in the render — so a filter here
            // that resizes has resized the placed picture and not the clip.
            if (stepOf(node.anchor) === 'scale') placed = true;
        } else {
            parts.push(filterArgs(node));
            user++;
            if (placed) late++;
        }
        edges = g.outEdges(node);
    }
    // The conversions on their own are not worth a view: without a filter of
    // somebody's in the chain, what comes out is the picture the element was
    // already playing, decoded twice.
    return user ? { ok: true, text: parts.join(','), shift, late }
                : { ok: true, text: '', shift: 0, late: 0 };
}

/// What to ask for, for one clip — or what to say instead.
function askFor(g, spec, clip) {
    const v = chainOf(g, clip.id, 'v');
    const a = chainOf(g, clip.id, 'a');
    if (!v.ok) return { why: v.reason };
    if (!a.ok) return { why: a.reason };
    if (!v.text && !a.text) return {};             // nothing to run: the plain src

    const head = headOf(g, clip.id);
    // The `-i` the render would open, taken from the spec the graph was derived
    // from — so playback opens the file with the demuxer, the options and the
    // window the render opens it with, rather than with a path.
    //
    // A generator clip has no `-i` in the render at all: its picture is a filter
    // in the graph. What it has is the *other* spelling of the same picture — `-f
    // lavfi -i testsrc=…`, which is what its bar is already playing — so a view
    // over it is that input with the chain on top, and `inputFor()` is the one
    // place that shape is written.
    const input = clip.generator ? inputFor(clip.generator)
                : head && head.input >= 0 && spec.inputs ? spec.inputs[head.input]
                : null;
    if (!input) return { why: 'this clip has no input for playback to open' };

    // What the chain did to the clock, to be undone on the way out. The
    // picture's run and the sound's arrive at the same number by different
    // filters — one `setpts` against an `asetpts` and an `adelay` — so either
    // answers for both, to within the half-millisecond below which the
    // derivation writes no `adelay` at all.
    const shift = v.text ? v.shift : a.shift;
    // `late` is not in the key, and cannot be: it is read off the same walk that
    // produced the text, so a filter moved from one insert point to the other is
    // a different chain in the text before it is a different number here.
    return { input, video: v.text, audio: a.text, shift, late: v.late,
             key: JSON.stringify([input, v.text, a.text, shift]) };
}

/// Recompute every clip's view. Returns `{ moved, resized }`, two lists of ids
/// and two different things for the caller to do about them: `moved` is the
/// elements to re-point and seek back into position, `resized` the clips whose
/// picture is now a different size and whose layout — and therefore the graph
/// and the printed command, which are downstream of a rectangle — was stated
/// before this ran.
///
/// **The ids and not a flag**, because a view can change without its token
/// changing: dragging a clip along the timeline moves its `shift` and the src
/// stays `/@fx/clip-7`, and a source that resolved the old one holds it for as
/// long as it is open. The element has to be rebuilt for that, and only the
/// clips it is true of.
///
/// A clip that has just *stopped* being filtered is in `resized` too, even where
/// the chain it lost never changed the size: what the layout falls back to is the
/// probe's answer, and this file does not hold that to compare against. The cost
/// of being wrong that way is one redraw of two statements.
///
/// Cheap when nothing relevant moved: one derivation, and a settle only for a
/// clip whose input or chains actually changed — `defineSettled` in the native
/// half is where that rule is written down.
export function refresh() {
    const spec = hooks.spec ? hooks.spec() : null;
    const g = graphNow(spec);
    const live = new Set();
    const moved = [];
    const resized = [];

    for (const clip of (spec && spec.clips) || []) {
        if (clip.id === undefined || clip.id === null) continue;
        live.add(clip.id);
        const had = state.get(clip.id) || { key: '', src: '', why: '', size: null };
        // A graph that will not derive leaves everything exactly as it was: the
        // Graph stage is where a broken graph is explained, and pulling the
        // pictures off the screen while somebody is half way through wiring
        // something would be this file having an opinion about that.
        if (!g) continue;

        const ask = askFor(g, spec, clip);
        const key = ask.key || (ask.why ? `why:${ask.why}` : '');
        if (had.key === key) continue;

        let src = '';
        let size = null;
        let why = ask.why || '';
        if (ask.key) {
            try {
                const got = bro.ffmpeg.views.define(`clip-${clip.id}`, {
                    input: ask.input, video: ask.video, audio: ask.audio, shift: ask.shift,
                });
                const changedSize = ask.video && got.video &&
                    (got.width !== got.sourceWidth || got.height !== got.sourceHeight);
                if (changedSize && ask.late) {
                    // Refused, not drawn at the wrong size — see the note at the
                    // top. The token is dropped so nothing can be pointed at it
                    // by accident later.
                    bro.ffmpeg.views.forget(`clip-${clip.id}`);
                    why = `these filters make a ${got.width}×${got.height} picture out of a ` +
                          `${got.sourceWidth}×${got.sourceHeight} one below the point where ` +
                          'this clip is placed, and the render lays that over the canvas at ' +
                          'its own size rather than in a rectangle';
                } else {
                    src = got.src;
                    // What the clip's picture now *is*, for the layout to fit —
                    // whatever the chain settled on, which for the chains that
                    // change no size is the size the file already had.
                    if (got.video && got.width > 0)
                        size = { w: got.width, h: got.height };
                }
            } catch (e) {
                why = String((e && e.message) || e);
            }
        } else {
            forget(clip.id);
        }
        // Either the token changed, or it did not and the view behind it did.
        // Both mean this element is playing something that is no longer what
        // was asked for.
        if (src !== had.src || src) moved.push(clip.id);
        if ((size ? size.w : 0) !== (had.size ? had.size.w : 0) ||
            (size ? size.h : 0) !== (had.size ? had.size.h : 0))
            resized.push(clip.id);
        state.set(clip.id, { key, src, why, size, ask: ask.key ? ask : null });
    }

    // Clips that have gone. The token goes with them: a view holds an input
    // and an input holds a path, and a registry that only ever grew would keep
    // every file this session has opened named in it.
    for (const id of Array.from(state.keys()))
        if (!live.has(id)) { forget(id); state.delete(id); }
    return { moved, resized };
}

function forget(id) {
    try { bro.ffmpeg.views.forget(`clip-${id}`); } catch (e) { /* never defined */ }
}
