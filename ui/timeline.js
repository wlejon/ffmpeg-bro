// The timeline: a ruler, a stack of video tracks and one audio track, over a
// window of time you can zoom into.
//
// Everything is drawn from the visible window rather than from the whole file,
// which is what makes zooming mean anything: at 1× the strip is a summary of
// the clip, at 200× it is the individual frames around the playhead, and the
// waveform under it is the sound at that moment rather than a smear of the
// whole take.
//
// The video lanes are built from the model rather than written in the markup,
// because how many there are is a property of the edit.
//
// A lane's head is where the track is named and so is where the one thing a
// track has of its own lives: the **sync lock**, which says whether an Alt-drag
// ripples this track alone or every track locked with it. The state is drawn
// three times over — the padlock is shut, the name goes to the accent colour and
// the whole lane carries a wash of it — because a ripple that moved clips on a
// lane nobody was looking at is the exact failure the lock exists to prevent,
// and a state you discover after the drag is no better than no control at all.
//
// **A third kind of lane: When.** Under the stack, one row per filter node whose
// `enable=` turns it on for part of the render — see `ui/graph/spans.js`, which is
// where the list comes from and where the write-back goes. It is here rather than
// only in the column beside the graph because a span is about a *shot*: "does the
// blur cover the whole of this take" is a question about two rectangles on one
// ruler, and the ruler is this one. Three rules it follows, each of them the same
// rule something else on this timeline follows:
//
//   - **It exists because spans do**, the way the video lanes exist because
//     `trackCount()` says so. An edit with no spans carries no When lane, and one
//     made on the Graph stage is here when you come back.
//   - **One row per node**, so two spans that overlap in time are two regions in
//     two rows and both stay reachable by the pointer. Each row says which node
//     it is, in words and in a colour of its own.
//   - **What a press means is decided in one place** — `spanGrabAt`, beside
//     `grabAt`, which is the same decision for the same reason and deliberately
//     not the same function: a clip and a span are not two readings of one press,
//     they are on different lanes.

import { project, projectFps, duration, moveClip, resolveOverlaps, changed, trackCount,
         select, trimClip, rippleTrim, rollCut, slipClip, rateStretch,
         isTrackLocked, setTrackLocked, ripplesWith, speedOf } from './project.js';
import { el } from './dom.js';
import { setIcon } from './icons.js';
import {
    bindTimelineDrawContext, mixColumns, whenLane, spanStackOf, syncSpanLane,
    drawVideoLane, drawAudioLane, drawSpanLane, drawRuler, drawScrollbar, watchView,
} from './timeline-draw.js';

export { mixColumns, whenLane };

let ruler, tracksEl, wave, laneAudio, playhead, scrollTrack, scrollThumb, zoomLabel, timelineEl;
let lanes = [];                 // [{ row, head, lock, lane, canvas }] bottom track first
let onSeek = () => {};
let playheadTime = () => 0;

// The visible window, in seconds.
const view = { start: 0, span: 10 };

// How close to a clip's edge a press has to be to mean "trim" rather than
// "move", in pixels. Six is about a fingernail and comfortably clear of the
// 2px selection border.
const TRIM_GRAB = 6;

// Pixels the video lanes share between them, gaps included, and the height
// below which they stop shrinking and the timeline grows instead.
const LANE_BUDGET = 110;
const LANE_FLOOR = 18;

bindTimelineDrawContext({
    view: () => view,
    total: () => total(),
    laneWidth: () => laneWidth(),
    timeToX: (t) => timeToX(t),
    xToTime: (x) => xToTime(x),
    ruler: () => ruler,
    tracksEl: () => tracksEl,
    wave: () => wave,
    playhead: () => playhead,
    scrollThumb: () => scrollThumb,
    zoomLabel: () => zoomLabel,
    onSeek: (t, p, r) => onSeek(t, p, r),
    playheadTime: () => playheadTime(),
    tracked: (el, d, m, u) => tracked(el, d, m, u),
    snapTime: (t, ex) => snapTime(t, ex),
    isDragging: () => !!dragging,
    markRebuilt: () => { rebuilt = true; },
});

/// A copy, not the live window: handing out the object itself means a caller
/// that holds on to it is silently watching it change rather than remembering
/// what it was.
export function getView() { return { start: view.start, span: view.span }; }

/// Everything the timeline can show: the clips, plus a second so an empty
/// project still has a ruler.
function total() { return Math.max(duration(), 1); }

/// Deepest useful zoom: a handful of frames across the lane. Past that the
/// filmstrip is one picture and the ruler is noise.
function minSpan() {
    const fps = projectFps();
    return Math.max(0.02, 4 / fps);
}

/// The width every time-to-pixel mapping is against.
///
/// Measured on the lane, never on the canvas inside it. A canvas that has not
/// been through layout yet reports its intrinsic 300×150 rather than nothing,
/// so a lane built this frame would scale the whole timeline to 300px and look
/// entirely plausible doing it. A div reports 0, which draws nothing and is
/// obvious.
function laneWidth() { return lanes.length ? (lanes[0].lane.clientWidth || 0) : 0; }

export function laneWidthPx() { return laneWidth(); }

export function timeToX(t) {
    const w = laneWidth();
    return w > 0 ? ((t - view.start) / view.span) * w : 0;
}

export function xToTime(x) {
    const w = laneWidth();
    return w > 0 ? view.start + (x / w) * view.span : 0;
}

function clampView() {
    view.span = Math.max(minSpan(), Math.min(total(), view.span));
    view.start = Math.max(0, Math.min(total() - view.span, view.start));
}

export function fitView() {
    view.span = total();
    view.start = 0;
    clampView();
    draw();
}

/// Put the window back where a document says it was left.
///
/// The pair `getView()` hands out, and it takes the pair rather than a zoom
/// factor for the reason `getView()` gives one: a factor is `total / span` and
/// the total is the edit's own length, so a document opened after a clip grew
/// would come back looking at somewhere it never was. Clamped like every other
/// move of the window, so a span wider than the edit is simply the whole edit —
/// which is what `fitView()` is, and is what a document with no window written
/// gets from the caller instead.
///
/// Refused for a span of zero rather than treated as "fit": a document that did
/// not say has to be answered by the caller, since only the caller knows whether
/// it is an Open (fit it) or something else.
export function setView(start, span) {
    const s = Number(span);
    if (!(s > 0)) return false;
    view.span = s;
    view.start = Math.max(0, Number(start) || 0);
    clampView();
    draw();
    return true;
}

/// Zoom keeping `anchor` seconds under the same pixel. Without the anchor,
/// zooming walks away from whatever you were looking at.
export function zoomBy(factor, anchor) {
    const w = laneWidth();
    if (w <= 0) return;
    if (anchor === undefined) anchor = view.start + view.span / 2;
    const f = (anchor - view.start) / view.span;
    view.span = Math.max(minSpan(), Math.min(total(), view.span * factor));
    view.start = anchor - f * view.span;
    clampView();
    draw();
}

export function panBy(seconds) {
    view.start += seconds;
    clampView();
    draw();
}

/// Bring `t` into view if it has run off the edge — during playback, so the
/// window follows the playhead instead of the playhead leaving.
export function revealTime(t) {
    if (view.span >= total()) return false;
    if (t >= view.start && t <= view.start + view.span * 0.92) return false;
    view.start = t - view.span * 0.25;
    clampView();
    return true;
}

// ── hit testing ────────────────────────────────────────────────────────────

function clipAtX(x, track) {
    const t = xToTime(x);
    for (const c of project.clips)
        if ((track === undefined || c.track === track) &&
            t >= c.start && t <= c.start + c.length) return c;
    return null;
}

/// The clip butted against this one's given end, or null.
///
/// **What makes a cut a cut.** Two clips laid end to end share an x, and the
/// boundary between them is one thing with two names — the left one's out-point
/// *is* the right one's in-point. Roll is the edit that moves both, so it needs
/// the other half, and "is there one" is also what tells a cut apart from the
/// loose end of a clip with nothing after it. A gap of any size is not a cut:
/// there are two boundaries there and moving them together would be moving a
/// clip, which is what dragging its body already does.
function buttedAt(clip, edge) {
    const at = edge === 'start' ? clip.start : clip.start + clip.length;
    for (const c of project.clips) {
        if (c === clip || c.track !== clip.track) continue;
        const other = edge === 'start' ? c.start + c.length : c.start;
        if (Math.abs(other - at) < 1e-6) return c;
    }
    return null;
}

/// What a press at (x, track) means: trimming one end of a clip, moving it, or
/// nothing. Edges win over the body so a clip narrower than two grab zones can
/// still be trimmed.
function grabAt(x, track) {
    // Edges first, and the nearest edge wins. Two clips butted together share
    // an x, so "the clip under the pointer" has no answer there — but "the
    // nearest end of any clip" always does, and on an exact tie the clip that
    // starts there wins, which is the one whose head you can see.
    let best = null, bestD = TRIM_GRAB + 1;
    for (const c of project.clips) {
        if (c.track !== track) continue;
        const l = timeToX(c.start), r = timeToX(c.start + c.length);
        const dl = Math.abs(x - l), dr = Math.abs(x - r);
        // The half-pixel is the tie-break: at a butt join the two edges are the
        // same x, and the head of the clip that starts there is the one you can
        // see the pictures of.
        if (dl <= TRIM_GRAB && dl - 0.5 < bestD) { bestD = dl - 0.5; best = { clip: c, what: 'start' }; }
        if (dr <= TRIM_GRAB && dr < bestD) { bestD = dr; best = { clip: c, what: 'end' }; }
    }
    if (best) return best;
    const clip = clipAtX(x, track);
    return clip ? { clip, what: 'move' } : null;
}

export function draw() {
    syncLanes();
    syncHeads();
    syncSpanLane();
    fitHeights();
    clampView();
    watchView();
    drawRuler();
    for (const l of lanes) drawVideoLane(l.track, l.canvas);
    drawAudioLane();
    drawSpanLane();
    drawScrollbar();

    // A lane created a moment ago has not been through layout yet, so the width
    // everything was just scaled to is whatever its canvas happened to report —
    // and a batch drop would paint its clips at a scale the ruler above them
    // disagrees with. One more pass, once the boxes are real.
    if (rebuilt) {
        rebuilt = false;
        requestAnimationFrame(draw);
    }
}

export function setPlayhead(t) {
    if (!playhead) return;
    const x = timeToX(t);
    const w = laneWidth();
    // Off-window, park it just outside rather than letting it sit on an edge
    // pretending to be at a time it is not.
    const visible = x >= -1 && x <= w + 1;
    playhead.style.display = visible ? 'block' : 'none';
    if (visible && lanes.length)
        playhead.style.left = (lanes[0].lane.offsetLeft + x).toFixed(1) + 'px';
}

// ── lanes ──────────────────────────────────────────────────────────────────

/// Build or drop video lanes so there is one per track in use plus a spare.
/// Top track first in the DOM, because that is the order they composite in and
/// an edit suite that showed them upside down would be lying about the stack.
let rebuilt = false;

function syncLanes() {
    const want = trackCount();
    if (lanes.length === want) return;
    rebuilt = true;

    for (const l of lanes) tracksEl.removeChild(l.row);
    lanes = [];
    for (let track = 0; track < want; track++) {
        const row = document.createElement('div');
        row.className = 'track-row';
        const lock = lockButton(track);
        const head = el('div', { cls: 'track-head' },
                        [el('span', { cls: 'track-name', text: `V${track + 1}` }), lock]);
        const lane = document.createElement('div');
        lane.className = 'track-lane';
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        // Prepend so V1 ends up at the bottom of the stack of rows.
        tracksEl.insertBefore(row, tracksEl.firstChild);
        const entry = { track, row, head, lock, lane, canvas };
        lanes.push(entry);
        wireVideoLane(entry);
    }
    // The playhead spans every lane, so it has to stay last in the box.
    tracksEl.appendChild(playhead);

    // The lanes divide a budget rather than each keeping a fixed height,
    // because otherwise the video tracks grow downward as they multiply and
    // push the waveform — the one lane that is always worth seeing — off the
    // bottom. Below the floor they stop shrinking and the timeline grows
    // instead, which is why its height is written here and not in the
    // stylesheet: eight lanes at ten pixels would be a decoration, not a track.
    const h = Math.max(LANE_FLOOR, Math.floor((LANE_BUDGET - (want - 1) * 4) / want));
    for (const l of lanes) {
        l.lane.style.height = h + 'px';
        l.row.style.height = h + 'px';
    }
    laneStack = want * h + (want - 1) * 4;
    // A short lane has no room for a pill with a name in it.
    for (const l of lanes) l.head.classList.toggle('tiny', h < 22);
}

/// Pixels the video lanes and their gaps come to. Held rather than recomputed,
/// because `syncLanes()` returns early when the track count has not changed and
/// the height still has to be written on every draw — the When lane comes and
/// goes on a channel of its own.
let laneStack = 0;

/// How tall the box of lanes is, and how tall the timeline is around it.
///
/// **Written on every draw and from four numbers now**, which is the change the
/// When lane forced and the Cues, Marks and Telemetry lanes confirmed: the video
/// lanes divide a budget when the track count moves, and the other four appear
/// and disappear on channels of their own, so no one of those events can be the
/// only place the total is stated. One function, called from `draw()`, and the
/// contributions are added.
///
/// The words strip is outside the box of lanes — it is a form and not a lane —
/// so it is a term on the timeline's own height rather than on `#tracks`'s.
function fitHeights() {
    const stack = laneStack + spanStackOf();
    tracksEl.style.height = stack + 'px';
    // Everything above and below the box of lanes: the zoom bar, the ruler, the
    // waveform, the scrollbar and the gaps.
    timelineEl.style.height =
        (30 + 18 + 6 + stack + 4 + 44 + 6 + 9 + 6) + 'px';
}

/// The sync lock on one track head: press it and this track ripples with every
/// other track that carries one.
///
/// **On the head, beside the name**, because that is where the track is named and
/// a lock is a fact about the track rather than about a clip or about a drag. The
/// alternatives were a modifier on top of `Alt` — which makes the rule invisible
/// until the moment it fires, and there is only one hand — and a dialog of
/// checkboxes, which is a second place the stack is described.
///
/// The button carries no state of its own: `syncHeads()` reads the model on every
/// draw. A control that remembered would be a second answer to whether a track is
/// locked, and it would be the one on screen while the other was the one a ripple
/// used — which is precisely the failure mode of a lock you cannot see.
function lockButton(track) {
    return el('button', {
        cls: 'track-lock',
        on: { click: (e) => {
            e.preventDefault();
            // Nothing to announce when nothing changed — `setTrackLocked` says
            // so — because an announcement is a step of undo and a document
            // marked unsaved.
            if (setTrackLocked(track, !isTrackLocked(track))) changed('lock');
        } },
    });
}

/// Put every track head's lock in step with the model.
///
/// Called from `draw()` rather than from the press, and that is the load-bearing
/// half: a lock arrives from four directions — the press, an undo, an opened
/// document and `retainTracks()` forgetting a lane that has gone — and only the
/// first of them goes through this file. Drawn from the model on every pass, all
/// four are the same thing.
///
/// The title is written per state rather than being one sentence about the
/// control, because what the press *does* differs: on a track locked with nothing
/// else there is no other track to move, and saying so is cheaper than letting
/// somebody discover it by rippling.
function syncHeads() {
    for (const l of lanes) {
        const on = isTrackLocked(l.track);
        const name = `V${l.track + 1}`;
        l.head.classList.toggle('locked', on);
        l.lock.classList.toggle('on', on);
        setIcon(l.lock, on ? 'lock' : 'unlock', 12);
        const others = on ? ripplesWith(l.track).filter((t) => t !== l.track) : [];
        l.lock.title = !on
            ? `${name} ripples on its own — lock it to ripple it with other locked tracks`
            : others.length
                ? `${name} ripples with ${others.map((t) => `V${t + 1}`).join(', ')}`
                : `${name} is locked, and is the only locked track — nothing else moves with it yet`;
    }
}

/// The DOM for one video track — the lane box and its canvas. Tests and the
/// app reach lanes through this rather than by id, because the ids would have
/// to be invented per track and would go stale as tracks come and go.
///
/// The same objection is what shapes the sync lock, which is the first per-track
/// setting there has been: it is kept in the model keyed by the track number,
/// pruned to the lanes `trackCount()` says exist, and read by the clips rather
/// than by the lanes — so there is no per-lane record here to go stale, and the
/// button on the head holds nothing. See the section in `ui/project.js`.
export function laneOf(track) {
    for (const l of lanes) if (l.track === track) return l;
    return null;
}

/// Which lane a page-space y is over, for dragging a clip between tracks.
function laneAtY(clientY) {
    for (const l of lanes) {
        const r = l.lane.getBoundingClientRect();
        if (clientY >= r.top - 3 && clientY <= r.bottom + 3) return l.track;
    }
    return null;
}

// ── input ──────────────────────────────────────────────────────────────────

// One helper for press-and-track: the pointer leaving the element mid-drag is
// normal, and losing the drag when it does is not.
//
// **There is one pair of document listeners for the whole timeline, not one
// pair per call**, and both halves of that matter.
//
// A pair per call accumulates. `wireVideoLane()` runs per lane on every
// `syncLanes()`, and `syncLanes()` drops and rebuilds every row the moment the
// track count changes — so dragging a clip into the spare top lane and back
// leaves ten dead handlers behind, firing on every pointer move for the rest of
// the session and each retaining a detached lane and the clip that was in it.
// That is the sort of thing that gets blamed on "it just gets slow".
//
// And the obvious fix — a disposer called when the row is removed — would take
// the drag with it, because *the drag is what removed the row*: crossing into
// the spare lane is exactly the gesture that changes the track count. So the
// listeners outlive every element, and which handler is live is a module fact
// rather than a per-closure one. Only one gesture can be in flight at a time,
// there being one pointer.
let dragging = null;
let documentWired = false;

/// Drag anywhere on this element to move the playhead.
///
/// **At module scope rather than inside `initTimeline`**, because it is wired to
/// three things that exist at three different moments: the ruler and A1 are in
/// the markup, and the Telemetry lane is built when a series is picked. A
/// closure created at init could only reach the first two.
function scrubOn(target) {
    tracked(target,
        (e) => { onSeek(xToTime(localX(e, target)), true); },
        (e) => { onSeek(xToTime(localX(e, target)), false); },
        () => onSeek(undefined, false, true));
}

function tracked(el, onDown, onMove, onUp) {
    if (!documentWired) {
        documentWired = true;
        document.addEventListener('mousemove', (e) => { if (dragging) dragging.move(e); });
        document.addEventListener('mouseup', (e) => {
            const d = dragging;
            if (!d) return;
            dragging = null;
            if (d.up) d.up(e);
        });
    }
    el.addEventListener('mousedown', (e) => {
        if (onDown(e) === false) return;
        dragging = { move: onMove, up: onUp };
        e.preventDefault();
    });
}

function localX(e, el) {
    const r = el.getBoundingClientRect();
    return e.clientX - r.left;
}

// Snap a dragged clip to the things an edit is usually trying to line up with:
// the start of the timeline, the playhead, and the other clips' edges.
function snapStart(clip, start, playheadT) {
    const tolerance = (view.span / Math.max(1, laneWidth())) * 7;   // 7 px
    const targets = [0, playheadT];
    for (const other of project.clips) {
        if (other === clip) continue;
        targets.push(other.start, other.start + other.length);
    }
    let best = start, bestD = tolerance;
    for (const t of targets) {
        for (const edge of [start, start + clip.length]) {
            const d = Math.abs(edge - t);
            if (d < bestD) { bestD = d; best = start + (t - edge); }
        }
    }
    return Math.max(0, best);
}

function snapTime(t, exclude) {
    const tolerance = (view.span / Math.max(1, laneWidth())) * 7;
    let best = t, bestD = tolerance;
    const targets = [0, playheadTime()];
    for (const other of project.clips) {
        if (other === exclude) continue;
        targets.push(other.start, other.start + other.length);
    }
    for (const c of targets) {
        const d = Math.abs(t - c);
        if (d < bestD) { bestD = d; best = c; }
    }
    return best;
}

/// A video lane: press to seek and select, drag to move or trim, drag upward
/// to change track.
function wireVideoLane(entry) {
    let drag = null;

    const liveLane = () => {
        const l = laneOf(entry.track);
        return l ? l.lane : entry.lane;
    };

    entry.lane.addEventListener('mousemove', (e) => {
        if (dragging) return;
        const x = localX(e, liveLane());
        const grab = grabAt(x, entry.track);
        // The same question the press asks, asked a moment earlier: the pointer
        // shows which of the four edits this press would be, including the one
        // Alt is currently inverting it to.
        entry.lane.style.cursor = grab ? cursorFor(editFor(grab.what, e.altKey)) : 'default';
    });

    tracked(entry.lane,
        (e) => {
            const x = localX(e, liveLane());
            const grab = grabAt(x, entry.track);
            // Pressing anywhere on a lane moves the playhead there — including
            // on a clip, so the picture and the panel are about the thing you
            // just grabbed. Moving the pointer then edits instead of scrubbing.
            onSeek(xToTime(x), true);
            if (grab) select(grab.clip, (e.ctrlKey || e.metaKey || e.shiftKey) ? 'add' : 'set');
            else if (!(e.ctrlKey || e.metaKey || e.shiftKey)) select(null);
            // **Alt turns each of the three targets into its cut-relative
            // edit**, which is the pairing that makes one modifier enough:
            // an end ripples, a shared cut rolls, a body slips. Alt rather than
            // ctrl/meta/shift because those three already mean "add to the
            // selection" on this very press.
            //
            // A cut and an end are genuinely different targets rather than the
            // same one read two ways — at a butt join the left clip's out-point
            // and the right clip's in-point are one boundary — so which of the
            // two is under the pointer is asked, not assumed.
            // The edit this press is, decided once. Read per move it would
            // change under a hand that let go of Alt half way through a drag,
            // which is a gesture turning into a different gesture while it is
            // being made.
            let edit = grab ? editFor(grab.what, e.altKey) : null;
            const other = grab && grab.what !== 'move' && edit === 'ripple'
                ? buttedAt(grab.clip, grab.what) : null;
            // A shared cut is a roll rather than a ripple: at a butt join the
            // left clip's out-point and the right clip's in-point are one
            // boundary, so which of the two is under the pointer is asked
            // rather than assumed.
            if (other) edit = 'roll';
            drag = grab ? {
                clip: grab.clip, what: grab.what, edit, other,
                grabTime: xToTime(x), origin: grab.clip.start,
                originIn: grab.clip.inPoint,
                originTrack: grab.clip.track, moved: false,
            } : null;
        },
        (e) => {
            const x = localX(e, liveLane());
            if (!drag) { onSeek(xToTime(x), false); return; }
            const t = xToTime(x);
            const delta = t - drag.grabTime;
            if (!drag.moved && Math.abs(delta) * (laneWidth() / view.span) < 3) return;
            drag.moved = true;
            if (drag.edit === 'slip') {
                // Measured from where the press was rather than accumulated per
                // move: `slipClip` clamps at the ends of the footage, so adding
                // each step would let a drag that ran past the end come back a
                // different distance from the one it went out.
                //
                // Negated because the gesture pushes the film under the window:
                // dragging right shows earlier footage. Not snapped — there is
                // nothing on the timeline to snap to, since nothing about the
                // arrangement moves.
                drag.clip.inPoint = drag.originIn;
                // Scaled by the speed, because `slipClip` takes a distance in the
                // *file's* seconds and `delta` is a distance the pointer moved
                // along the timeline. At 2× the film has to slide two seconds for
                // the picture under the pointer to follow it by one.
                slipClip(drag.clip, -delta * speedOf(drag.clip));
            } else if (drag.edit === 'roll') {
                const left = drag.what === 'start' ? drag.other : drag.clip;
                const right = drag.what === 'start' ? drag.clip : drag.other;
                rollCut(left, right, snapTime(t, drag.clip));
            } else if (drag.edit === 'ripple') {
                rippleTrim(drag.clip, drag.what, snapTime(t, drag.clip));
            } else if (drag.edit === 'rate') {
                rateStretch(drag.clip, drag.what, snapTime(t, drag.clip));
            } else if (drag.edit === 'move') {
                const track = laneAtY(e.clientY);
                moveClip(drag.clip, snapStart(drag.clip, drag.origin + delta, playheadTime()),
                         track === null ? drag.originTrack : track);
            } else {
                trimClip(drag.clip, drag.what, snapTime(t, drag.clip));
            }
            changed('move');
        },
        () => {
            if (drag && drag.moved) {
                // Only a plain move can leave two clips over each other. A
                // ripple keeps the order it started with, a roll moves one
                // boundary between two clips that were already butted, and a
                // slip moves nothing on the timeline at all — so resolving
                // overlaps after any of them would be re-laying-out an
                // arrangement nobody disturbed.
                if (drag.edit === 'move') resolveOverlaps(drag.clip);
                changed('moved');
            }
            // Always release, even after an edit: the press paused playback to
            // scrub, and only this puts it back.
            onSeek(undefined, false, true);
            drag = null;
        });
}

// ── which edit a drag is ───────────────────────────────────────────────────
//
// **Alt was the only way in, and one modifier is not an affordance.** Every one
// of these edits already existed and was reachable by holding Alt — a body
// slipped, an end rippled, a shared cut rolled — and none of them was on the
// screen, in the keyboard map, or discoverable by any means other than being
// told. A mode the bar shows is what makes them ordinary: the pointer says what
// it will do before it is pressed, and the four edits stop being folklore.
//
// **Alt stays an inversion rather than becoming a fifth mode.** Whatever the bar
// says, holding it gives the *other* reading of the same target. That keeps the
// gesture that existed before this working exactly as it did in Select, and it
// makes every mode escapable without going back to the bar — which matters most
// in the mode you did not mean to be in.
const MODES = {
    select: { move: 'move', edge: 'trim' },
    ripple: { move: 'move', edge: 'ripple' },
    slip: { move: 'slip', edge: 'trim' },
    rate: { move: 'move', edge: 'rate' },
};
// The other reading of each target. `rate` inverts to a plain trim because the
// question it answers — how long should this take — has exactly one opposite
// here, which is how much of it to keep.
const INVERSE = { move: 'slip', slip: 'move', trim: 'ripple', ripple: 'trim', rate: 'trim' };
let editMode = 'select';

/// Which edit a press on `what` is, in the mode the bar is showing.
export function editFor(what, alt) {
    const m = MODES[editMode] || MODES.select;
    const base = what === 'move' ? m.move : m.edge;
    return alt ? (INVERSE[base] || base) : base;
}

/// Which mode the timeline is in, and what the pointer means in it.
export function currentEditMode() { return editMode; }

/// Put the timeline into one of the four modes.
///
/// Nothing about the edit changes — this is a statement about what the *next*
/// press means — so it is not a document change, takes no undo step and marks
/// nothing unsaved.
export function setEditMode(mode) {
    if (!MODES[mode] || mode === editMode) return;
    editMode = mode;
    for (const b of document.querySelectorAll('[data-edit-mode]'))
        b.classList.toggle('on', b.dataset.editMode === editMode);
    // The lanes carry the cursor, and a mode changed from the keyboard has to
    // reach a pointer that is already sitting still over one.
    for (const lane of document.querySelectorAll('.track-lane')) lane.style.cursor = '';
}

/// The pointer's shape for an edit, which is the mode made visible before the
/// press rather than after it.
function cursorFor(edit) {
    if (edit === 'slip') return 'all-scroll';
    if (edit === 'rate') return 'col-resize';
    if (edit === 'ripple' || edit === 'roll' || edit === 'trim') return 'ew-resize';
    return 'grab';
}

export function initTimeline(refs) {
    ruler = refs.ruler;
    tracksEl = refs.tracks;
    wave = refs.wave;
    laneAudio = refs.laneAudio;
    playhead = refs.playhead;
    scrollTrack = refs.scrollTrack;
    scrollThumb = refs.scrollThumb;
    zoomLabel = refs.zoomLabel;
    timelineEl = refs.timeline;
    onSeek = refs.onSeek || onSeek;
    playheadTime = refs.playheadTime || playheadTime;

    syncLanes();
    // The heights `syncLanes()` used to write itself. Written here as well as from
    // `draw()` so that the box has a size before the first draw, which is what
    // `laneWidth()` measures against.
    fitHeights();

    scrubOn(ruler);
    scrubOn(laneAudio);

    // Wheel: zoom about the pointer, or pan with shift held. Zooming about the
    // pointer is the only version that lets you dive into a specific moment
    // instead of steering the window back after every notch.
    refs.timeline.addEventListener('wheel', (e) => {
        const x = lanes.length ? localX(e, lanes[0].canvas) : 0;
        if (e.shiftKey) panBy((e.deltaY > 0 ? 0.2 : -0.2) * view.span);
        else zoomBy(e.deltaY > 0 ? 1.25 : 1 / 1.25, xToTime(x));
        e.preventDefault();
    });

    // The scrollbar pans; clicking the track jumps there.
    tracked(scrollTrack,
        (e) => {
            const f = localX(e, scrollTrack) / Math.max(1, scrollTrack.clientWidth);
            view.start = f * total() - view.span / 2;
            draw();
        },
        (e) => {
            const f = localX(e, scrollTrack) / Math.max(1, scrollTrack.clientWidth);
            view.start = f * total() - view.span / 2;
            draw();
        });
}
