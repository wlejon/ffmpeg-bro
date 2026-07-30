// Every `enable` span in the edit, placed where the shot it covers is.
//
// The When strip in the column beside the graph answers "does this span cover
// the *render*". It cannot answer the question people actually ask, which is
// "does this blur cover the *shot*", because the shot is on the timeline and the
// strip is three stages away from it. This file is the other reading of the same
// data: the spans, on the timeline's clock, so a lane can draw them where the
// clips they are about already are.
//
// **It is a list and a write-back, and nothing else.** What a span *is*, what it
// means, how one is printed into an `enable=` expression and where an end lands
// when it is dragged all stay in `enable.js`; which clock a node's `t` is on and
// how the two clocks map onto each other stay in `when.js`. This file asks those
// questions of the graph and hands the answers to `ui/timeline.js`, which draws
// them. A lane that composed an expression would be a second `printEnable`, and
// the failure that follows is one screen writing `between(t,1,2)` where the other
// writes `between(t,1.00,2.00)` — the same span, a different lock, and no way to
// tell which of them the render used.
//
// **One row per node, because a lane that cannot say whose span a region is is a
// decoration.** A `hue` on one shot and a `drawtext` on another are two spans in
// one lane, and rows are what makes them two statements rather than one shape.
// The alternative — every span on one row, told apart by colour — was rejected
// twice over: two spans from different nodes that overlap in time would draw over
// each other, and the one underneath would be unreachable by the pointer, which
// is the whole gesture this lane exists for.
//
// **The rows are ordered by the clip they are about**, not by where the spans
// are. A drag on this lane moves a span and never a clip, so the row a hand is
// on cannot reorder underneath it — which is what ordering by the span's own
// start would do the moment one span was dragged past another node's.
//
// **A span with nowhere true to go is left out.** A filter on a file the *graph*
// reads on its own account — a watermark, a logo bug — is on that file's own
// timestamps, and no clip is cut from it: there is no second of the edit its
// `t=5` corresponds to. `onTimeline` says so by answering `null`, and this leaves
// the row out rather than parking it at the start of the timeline, which is the
// same refusal the strip's own playhead mark already makes. Those are set in the
// column, where the ruler is the file's.
//
// **`enable` on a filter libavfilter says has no timeline support is not drawn
// here either.** It is a graph that will not build — `check.js` reports it
// against the node — and a draggable region would be a control for a render that
// is going to be refused.
//
// **The graph is derived, and the answer is memoised on the three channels that
// can change it.** A lane is redrawn on every zoom notch and every pan, and a
// derivation is a walk over every clip plus a pad lookup per node; the Graph
// stage, the spine and the command bar each open one per edit already. So the
// list is built once per change to the clips, to the overlay, or to the settings
// — which between them are everything the answer depends on — and read from a
// memo the rest of the time. Subscribed here rather than told by `ui/app.js`,
// because a fourth caller that forgot to tell it is a lane that is quietly one
// edit out of date.

import { project, onChange as onModelChange } from '../project.js';
import { onSettingsChange } from '../export/state.js';
import { buildSpec, specSources } from '../export/spec.js';
import { derive, clipOf, COMPOSITE_POINT, MIX_POINT } from './derive.js';
import * as overlay from './overlay.js';
import { keyOf } from './model.js';
import { parseEnable, printEnable, drawnSpan, supportsTimeline,
         moveEdge, shiftSpan } from './enable.js';
import { clockOf, onClock, onTimeline } from './when.js';

/// The last answer, or null for "ask again". Invalidated rather than compared:
/// what would have to be compared is the whole edit, which is the thing being
/// derived from in the first place.
let memo = null;

const forget = () => { memo = null; };
onModelChange(forget);
overlay.onChange(forget);
onSettingsChange(forget);

/// Every span in the edit, one entry per node that has any.
///
/// `[{ key, node, clk, filter, where, at, spans, drawn }]`, ordered by the clip
/// each node is about and then by key:
///
///   - `key` — what names the node across a derivation (`keyOf`), so a caller can
///     tell two rows apart between rebuilds.
///   - `node` — the node object out of *this* derivation. Held for the write-back
///     and for nothing else: `overlay.edit` reads three fields off it, and a
///     record assembled here instead would be a fourth place that knows how a
///     lock is keyed.
///   - `clk` — the clock its `enable` is written in, from `clockOf`.
///   - `filter`, `where` — what to call it: the filter's name, and one phrase
///     saying what it is on (`V1 shot.mp4`, `the whole canvas`).
///   - `spans` — the parsed spans, in the node's own seconds.
///   - `drawn` — the same spans in **timeline** seconds, which is what a lane
///     needs: `[{ i, a, b, from, to }]`, where `from`/`to` say which ends exist
///     and are therefore draggable. `gt(t,4)` has no far edge, and a grip on the
///     end of the window would say it had one.
///
/// Rows whose clock has no place on the timeline are not in the list at all; see
/// the header.
export function spanRows() {
    if (memo) return memo;
    const d = derive(buildSpec(), specSources(), { overlay: overlay.current() });
    const rows = [];
    if (d.ok && d.graph) {
        for (const node of d.graph.nodes) {
            if (node.kind !== 'filter') continue;
            const value = node.params.enable === undefined ? '' : String(node.params.enable);
            if (!value || !supportsTimeline(node.filter)) continue;
            const parsed = parseEnable(value);
            if (!parsed.ok || !parsed.spans.length) continue;
            const clk = clockOf(d.graph, node);
            const drawn = placeSpans(clk, parsed.spans);
            if (!drawn) continue;
            const subject = subjectOf(node);
            rows.push({ key: keyOf(node) || node.id, node, clk,
                        filter: node.filter, where: subject.text, at: subject.at,
                        spans: parsed.spans, drawn });
        }
    }
    rows.sort((a, b) => (a.at - b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    memo = rows;
    return rows;
}

/// The same placement for a set of spans held mid-drag — the lane draws from the
/// working copy and commits on release, so it needs this without a row.
///
/// `null` when the clock has no place on the timeline, which is what keeps that
/// judgement in one function rather than in the loop above and again in the lane.
export function placeSpans(clk, spans) {
    const out = [];
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        // Through `drawnSpan`, which is the one home for where a span lands on a
        // ruler — including what an open end means, which is a drawing decision
        // and not a claim about the render.
        const d = drawnSpan(s, clk);
        const a = onTimeline(clk, d.a);
        const b = onTimeline(clk, d.b);
        if (a === null || b === null) return null;
        out.push({ i, a: Math.min(a, b), b: Math.max(a, b),
                   from: s.from !== null, to: s.to !== null });
    }
    return out;
}

/// What a node is *about*, for the lane's label and for the row order.
///
/// Read off the anchor, which is the only thing that survives a derivation and is
/// also the only thing that says where a filter was put: `clip:7/after-decode` is
/// on clip 7 whether that clip is first or last in the list. `at` is where its
/// subject begins on the timeline, and it is `Infinity` for the nodes that are
/// about the whole render rather than one shot — so the canvas and the soundtrack
/// sort below the clips, in the order the stage's own insert-point list already
/// reads.
function subjectOf(node) {
    const anchor = node.anchor || '';
    const id = clipOf(anchor);
    if (id !== null) {
        for (const c of project.clips)
            if (String(c.id) === String(id))
                return { at: c.start, text: `V${c.track + 1} ${c.name}` };
        // An anchor naming a clip that is not on the timeline. Reachable only
        // between an edit and a redraw, and named rather than blanked.
        return { at: Infinity, text: `clip ${id}` };
    }
    if (anchor === COMPOSITE_POINT || anchor.indexOf('composite/') === 0)
        return { at: Infinity, text: 'the whole canvas' };
    if (anchor === MIX_POINT || anchor.indexOf('audio/') === 0)
        return { at: Infinity, text: 'the soundtrack' };
    if (anchor.indexOf('output/') === 0)
        return { at: Infinity, text: 'the output colour' };
    return { at: Infinity, text: 'in the graph' };
}

// ── what a drag on the lane comes to ───────────────────────────────────────
//
// Three calls, and every one of them is a thin wrapper on `enable.js`. That is
// deliberate: the lane and the strip must not be able to disagree about where an
// edge lands, and the way to make that impossible is for neither of them to know.

/// One end of one span, dragged to a timeline second.
///
/// The moment is mapped onto the node's clock first — `onClock`, the same map the
/// strip's mark is drawn by — and then clamped by `moveEdge`, which is what keeps
/// a `between` from being dragged through itself.
export function editEdge(row, spans, i, which, t) {
    const at = onClock(row.clk, t);
    if (at === null) return spans;
    return moveEdge(spans, i, which, at, row.clk);
}

/// A whole span, moved by a distance.
///
/// **The distance is not mapped, and that is a fact about the map rather than a
/// shortcut**: both clocks run at one second per second, so a span dragged two
/// seconds along the timeline is two seconds later in its own expression. Only
/// the origins differ. `held` is the span as it was when the press began, for the
/// reason `shiftSpan` gives.
export function editBody(row, spans, i, held, by) {
    return shiftSpan(spans, i, held, by, row.clk);
}

/// Write it back, through the one call the When strip's own commit goes through.
///
/// So a span dragged on the timeline and a span dragged in the column are the
/// same edit: on a node of yours it changes that node's `enable`, on a derived one
/// it records a lock against its anchor, and an empty list takes the option off —
/// a filter with no `enable` is a filter that is always on. It announces itself on
/// the overlay's change channel, which is what makes it one step of undo, one
/// touch of the unsaved marker and one redraw of everything downstream.
export function commitSpans(row, spans) {
    return overlay.edit(row.node, { params: { enable: printEnable(spans) } });
}
