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
// **The filters see the render's clock.** `enable=` names a moment on the
// render — `between(t,5,10)` is five seconds into what will be written — and a
// clip half an hour into a recording plays back on the file's own timestamps.
// So a view carries the difference, which is where the clip's frames land minus
// where they are read from, and the graph states both on its input node. It is
// the same mapping `when.js`'s `playheadOn` does for the strip, which is why
// the mark on the strip and the picture on the screen agree.
//
// **A chain that cannot be shown honestly is not shown.** Two cases, and both
// keep the badge rather than drawing something nearly right:
//
//   - **a filter that changes the size of the picture.** The viewer places a
//     clip by the rectangle its *source* has and the render overlays whatever
//     the chain produced at the same top-left, so a `crop` on the end of a run
//     would be drawn stretched back into a rectangle the render never puts it
//     in. `views.define` reports both sizes and this refuses when they differ.
//   - **filters that are not one run.** A hand-wired fork, a node placed on the
//     canvas and wired into the middle of a clip, anything with two producers:
//     playback is one stream through one chain, and half of a graph shown as
//     though it were the whole of it is worse than the badge.

import { derive, controlOf } from './derive.js';
import { filterArgs } from './print.js';

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

/// The input node a clip's run starts at.
function headOf(g, id) {
    return g.nodes.find((n) => n.kind === 'input' && n.anchor === `clip:${id}/in`) || null;
}

/// What a *derived* node contributes to a playback chain.
///
/// **Geometry, timing and level are the viewer's; what the pixels mean is the
/// chain's.** The crop window, the placement rectangle, the opacity style and
/// the playhead are all things the program monitor already does, so `trim`,
/// `setpts`, `crop`, `scale`'s size and `colorchannelmixer` are dropped — kept,
/// they would be the picture laid out twice.
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
function derivedStep(node) {
    const control = controlOf(node.anchor);
    if (control === 'format' || control === 'hwformat' || control === 'hwdownload')
        return filterArgs(node);
    if (control === 'scale')
        return filterArgs({ filter: 'scale', pos: ['iw', 'ih'], params: node.params || {} });
    return '';
}

/// One clip's user filters on one stream, as `-vf`/`-af` text.
///
/// Returns `{ ok: true, text }` or `{ ok: false, reason }`. Walking rather than
/// filtering, because the answer is an *order* and only the wires know it.
function chainOf(g, id, stream) {
    const key = `clip:${id}/`;
    const head = headOf(g, id);
    if (!head) return { ok: true, text: '' };
    const port = (head.outs || []).findIndex((o) => o.stream === stream);
    if (port < 0) return { ok: true, text: '' };   // this clip is not read for that

    const parts = [];
    let user = 0;
    let edges = g.outEdges(head).filter((e) => (e.fromPort || 0) === port);
    for (;;) {
        // A pad read twice is a fork, and a fork is not a chain. Said before
        // anything is collected as well as after, because the split can be the
        // very first thing on the run.
        if (edges.length !== 1)
            return user
                ? { ok: false, reason: 'these filters fork, and playback runs one chain' }
                : { ok: true, text: '' };
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
            const step = derivedStep(node);
            if (step) parts.push(step);
        } else {
            parts.push(filterArgs(node));
            user++;
        }
        edges = g.outEdges(node);
    }
    // The conversions on their own are not worth a view: without a filter of
    // somebody's in the chain, what comes out is the picture the element was
    // already playing, decoded twice.
    return { ok: true, text: user ? parts.join(',') : '' };
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
    const input = head && head.input >= 0 && spec.inputs ? spec.inputs[head.input] : null;
    if (!input) return { why: 'this clip has no input for playback to open' };

    // Where its frames land, less where they are read from. See the note at the
    // top: this is the whole of what puts `enable=` on the render's clock.
    const shift = (Number(head.at) || 0) - (Number(head.from) || 0);
    return { input, video: v.text, audio: a.text, shift,
             key: JSON.stringify([input, v.text, a.text, shift]) };
}

/// Recompute every clip's view. Returns the ids whose view changed, which is
/// the caller's cue to re-point those elements and seek them back into position.
///
/// **The ids and not a flag**, because a view can change without its token
/// changing: dragging a clip along the timeline moves its `shift` and the src
/// stays `/@fx/clip-7`, and a source that resolved the old one holds it for as
/// long as it is open. The element has to be rebuilt for that, and only the
/// clips it is true of.
///
/// Cheap when nothing relevant moved: one derivation, and a settle only for a
/// clip whose input or chains actually changed — `defineSettled` in the native
/// half is where that rule is written down.
export function refresh() {
    const spec = hooks.spec ? hooks.spec() : null;
    const g = graphNow(spec);
    const live = new Set();
    const moved = [];

    for (const clip of (spec && spec.clips) || []) {
        if (clip.id === undefined || clip.id === null) continue;
        live.add(clip.id);
        const had = state.get(clip.id) || { key: '', src: '', why: '' };
        // A graph that will not derive leaves everything exactly as it was: the
        // Graph stage is where a broken graph is explained, and pulling the
        // pictures off the screen while somebody is half way through wiring
        // something would be this file having an opinion about that.
        if (!g) continue;

        const ask = askFor(g, spec, clip);
        const key = ask.key || (ask.why ? `why:${ask.why}` : '');
        if (had.key === key) continue;

        let src = '';
        let why = ask.why || '';
        if (ask.key) {
            try {
                const got = bro.ffmpeg.views.define(`clip-${clip.id}`, {
                    input: ask.input, video: ask.video, audio: ask.audio, shift: ask.shift,
                });
                if (ask.video && got.video &&
                    (got.width !== got.sourceWidth || got.height !== got.sourceHeight)) {
                    // Refused, not drawn at the wrong size — see the note at the
                    // top. The token is dropped so nothing can be pointed at it
                    // by accident later.
                    bro.ffmpeg.views.forget(`clip-${clip.id}`);
                    why = `these filters make a ${got.width}×${got.height} picture out of a ` +
                          `${got.sourceWidth}×${got.sourceHeight} one, and the viewer places ` +
                          'this clip at the size its source is';
                } else {
                    src = got.src;
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
        state.set(clip.id, { key, src, why });
    }

    // Clips that have gone. The token goes with them: a view holds an input
    // and an input holds a path, and a registry that only ever grew would keep
    // every file this session has opened named in it.
    for (const id of Array.from(state.keys()))
        if (!live.has(id)) { forget(id); state.delete(id); }
    return moved;
}

function forget(id) {
    try { bro.ffmpeg.views.forget(`clip-${id}`); } catch (e) { /* never defined */ }
}
