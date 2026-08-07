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
         isSelected, select, trimClip, rippleTrim, rollCut, slipClip,
         hasPicture, isGenerator, isTrackLocked, setTrackLocked,
         ripplesWith, sourceTime, speedOf } from './project.js';
import { frameAt, soundNote, showing } from './analysis.js';
import { rulerLabel, clock } from './format.js';
import { dbHeight, ZERO_DBFS } from './levels.js';
import { el, put } from './dom.js';
import { setIcon } from './icons.js';
import { spanRows, placeSpans, editEdge, editBody, commitSpans } from './graph/spans.js';
import { cueTracks, addCue, removeCue, splitCue, mergeCue, setCueText, setCueTime,
         hasOverrides, cuesChanged } from './cues.js';

let ruler, tracksEl, wave, laneAudio, playhead, scrollTrack, scrollThumb, zoomLabel, timelineEl;
let cueBar, cueBarRow;
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

// The When lane: how tall one row wants to be, how much the rows share, and the
// height below which they stop shrinking. A row is a region and a name, so the
// ideal is one line of the 10px face with room around it; the budget is a little
// over four of those, because past that the lane starts competing with the
// filmstrips for a window that has a viewer in it. Below the floor a row is a
// coloured bar with no room for its name, which is still worth having — it says
// where and it says how many — so the lane grows rather than hiding rows.
const SPAN_ROW = 14;
const SPAN_BUDGET = 62;
const SPAN_FLOOR = 8;

// The Cues lane, on the same trade as the When lane and with bigger numbers,
// because a region here has to be *read*: a span is a coloured bar with a name
// beside it and a cue is the line itself, so the ideal row is one line of the
// 10px face with room around it and the floor is where the words stop fitting.
// Below `CUE_FLOOR` a row is still worth having — it says when the cues are and
// it is still draggable — so the lane grows rather than hiding rows.
const CUE_ROW = 18;
const CUE_BUDGET = 56;
const CUE_FLOOR = 10;

// The shortest a cue can be dragged to. Below about a twentieth of a second no
// player draws anything a person can read, so an end pulled through its own
// start would come to a cue that is in the file, is in the way, and is invisible
// — which is indistinguishable from one that failed to be deleted.
const CUE_MIN = 0.05;

// How long a cue made at the playhead is, when there is nothing after it to stop
// against. Two seconds is the length of an ordinary line of dialogue; a cue made
// against a neighbour takes the room there is instead, because the gesture people
// use to write a whole track is press-press-press down the timeline.
const CUE_SECONDS = 2;

// The colours a row is told apart by. Six, because the label is what actually
// names a node and this is what makes two rows readable as two at a glance; a
// palette long enough to be unique per node would be a set of colours nobody
// could tell apart anyway. Chosen clear of the three colours a *clip* is drawn in
// — blue for a filmstrip, green for sound, violet for a generator — and clear of
// the accent, which everywhere on this timeline means "selected".
//
// Each is a pair: the line, and the wash under it. The wash is transparent
// because the row's name is drawn *under* the regions, so that a span sitting
// over the name does not take the name away.
const SPAN_TINTS = [
    ['#7cc4ff', 'rgba(124, 196, 255, 0.22)'],
    ['#ffcf5c', 'rgba(255, 207, 92, 0.20)'],
    ['#6fdcb0', 'rgba(111, 220, 176, 0.20)'],
    ['#ff8fa3', 'rgba(255, 143, 163, 0.20)'],
    ['#c98bff', 'rgba(201, 139, 255, 0.22)'],
    ['#a8d95c', 'rgba(168, 217, 92, 0.20)'],
];

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

/// What a press at (x, y) on the When lane means: one end of a span, the whole of
/// one, or nothing.
///
/// **Beside `grabAt` and not inside it.** The two answer the same question and
/// they are deliberately two functions, because a press is on one lane or the
/// other and there is nothing to disambiguate: a clip and a span are never under
/// the same pixel. Folding them together would mean a single function taking a
/// track number *or* a row number and deciding which it had been given, which is
/// the shape that eventually mistakes one for the other. What is shared is the
/// rule — edges first, nearest edge wins, the body only if no edge was near — and
/// `TRIM_GRAB` is shared with it, so a grab zone is the same size wherever you
/// reach for one.
///
/// An end that does not exist is not offered: `gt(t,4)` has no far edge and a grip
/// on the end of the row would say it had one. That is the same restraint the
/// strip's own handles follow, and it comes from the model — `drawn[].to` — rather
/// than from anything measured here.
function spanGrabAt(x, y) {
    if (!spanRowH) return null;
    const row = spanList[Math.floor(y / spanRowH)];
    if (!row) return null;
    let best = null, bestD = TRIM_GRAB + 1;
    for (const d of row.drawn) {
        const l = timeToX(d.a), r = timeToX(d.b);
        const dl = Math.abs(x - l), dr = Math.abs(x - r);
        // The half-pixel tie-break `grabAt` uses, for the same reason: two spans
        // butted together share an x, so "the span under the pointer" has no
        // answer there and "the nearest end of any of them" always does. On an
        // exact tie the one that *starts* there wins, which is the one whose left
        // edge is drawn on top.
        if (d.from && dl <= TRIM_GRAB && dl - 0.5 < bestD)
            { bestD = dl - 0.5; best = { row, at: d.i, what: 'from' }; }
        if (d.to && dr <= TRIM_GRAB && dr < bestD)
            { bestD = dr; best = { row, at: d.i, what: 'to' }; }
    }
    if (best) return best;
    for (const d of row.drawn)
        if (x >= timeToX(d.a) && x <= timeToX(d.b))
            return { row, at: d.i, what: 'move' };
    return null;
}

// ── drawing ────────────────────────────────────────────────────────────────

// Size a canvas to its box and hand back a cleared context.
function laneContext(canvas) {
    // The box, not the canvas — see laneWidth().
    const box = canvas.parentNode;
    const w = (box ? box.clientWidth : 0) | 0;
    const h = (box ? box.clientHeight : 0) | 0;
    if (w <= 0 || h <= 0) return null;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

function drawVideoLane(track, canvas) {
    const c = laneContext(canvas);
    if (!c) return;
    const { ctx, w, h } = c;

    // A locked track, across the whole lane and under everything. The wash is
    // faint on purpose — it is a standing fact about the track, not a reading —
    // but it is on the lane rather than only on the head because the lane is
    // what somebody watching a drag is looking at, and two washed lanes are two
    // lanes that will move together.
    if (isTrackLocked(track)) {
        ctx.fillStyle = 'rgba(255, 140, 66, 0.07)';
        ctx.fillRect(0, 0, w, h);
    }

    for (const clip of project.clips) {
        if (clip.track !== track) continue;
        const x0 = timeToX(clip.start);
        const x1 = timeToX(clip.start + clip.length);
        const l = Math.max(0, x0), r = Math.min(w, x1);
        if (r <= l) continue;
        const selected = isSelected(clip);
        // A clip with no picture in it is drawn in the waveform lane's colours
        // and says what it is. Left in the video lane's blue with an empty
        // filmstrip it reads as a clip whose thumbnails have not arrived — a
        // state that resolves itself a second later, and this one never will.
        // It stays on its lane rather than being hidden, because the lane is
        // the track it is on and where it sits in the stack is an edit.
        const sound = !hasPicture(clip);
        // A generator is a picture and no file, so it gets a colour of its own
        // rather than the blue a filmstrip is drawn on. It never has one: a strip
        // is grabbed by seeking and a `-f lavfi` source cannot seek (see
        // `analysis.js`), so left in the video lane's blue it would read as a clip
        // whose thumbnails are still coming — the same misreading the sound-only
        // colour exists to prevent, and this one would never resolve either. The
        // bar carries the command that makes it instead, which is what its `name`
        // is.
        const gen = isGenerator(clip);

        ctx.fillStyle = sound ? (selected ? '#24422f' : '#1d3227')
                    : gen ? (selected ? '#43335e' : '#352b4a')
                          : (selected ? '#2a4666' : '#223449');
        ctx.fillRect(l, 0, r - l, h);

        if (sound && r - l > 60 && h > 14) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#8a92a0';
            ctx.fillText('sound only', l + 6, h / 2 + 3);
        }

        if (clip.film && clip.film.strips.length) {
            const { width: tw, height: th } = clip.film;
            // One thumbnail per its own natural width, laid out from the
            // clip's left edge so the pictures hold still while you pan, and
            // each showing the frame that is actually on screen there.
            const slot = Math.max(8, h * (tw / th));
            const first = Math.floor((l - x0) / slot);
            for (let k = first; ; k++) {
                const sx = x0 + k * slot;
                if (sx >= r) break;
                const dl = Math.max(sx, l), dr = Math.min(sx + slot, r);
                if (dr <= dl) continue;
                // Through `sourceTime`, which carries the clip's speed: the
                // filmstrip's times are the file's and a sped-up clip walks
                // through them faster, so a lane that subtracted a start would
                // show the same shot stretched across the bar.
                //
                // `frameAt` rather than an index, because a clip read over a
                // link holds several strips of several spans and the finest one
                // covering this moment is the one to draw — and where none has
                // been read yet the slot is left empty rather than filled with
                // the nearest picture that was, which would be a frame of
                // somewhere else presented as a frame of here.
                const f = frameAt(clip.film, sourceTime(clip, xToTime(sx)));
                if (!f) continue;
                // Partial slots at either edge crop the source rather than
                // squeezing a whole thumbnail into fewer pixels.
                const u0 = (dl - sx) / slot, u1 = (dr - sx) / slot;
                ctx.drawImage(f.bitmap,
                              f.i * tw + u0 * tw, 0, Math.max(1, (u1 - u0) * tw), th,
                              dl, 0, dr - dl, h);
            }
        }

        // A clip that is not fully opaque says so, since on a lower track that
        // is the difference between "hidden" and "gone". A clip that is not at
        // its own speed says so for the stronger version of the same reason:
        // nothing else on the bar can tell you, because a shot at 2× looks
        // exactly like half as much of the same shot until it plays.
        const speed = speedOf(clip);
        const marks = [
            clip.xform.opacity < 0.999 ? { text: Math.round(clip.xform.opacity * 100) + '%',
                                           colour: '#ffb37a' } : null,
            Math.abs(speed - 1) > 1e-6 ? { text: `${+speed.toFixed(3)}×`,
                                           colour: '#7ad4ff' } : null,
        ].filter(Boolean);
        if (marks.length) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(l, 0, r - l, 13);
            ctx.font = '10px Consolas, monospace';
            let at = l + 5;
            for (const m of marks) {
                ctx.fillStyle = m.colour;
                ctx.fillText(m.text, at, 10);
                at += ctx.measureText(m.text).width + 6;
            }
        }

        ctx.strokeStyle = selected ? '#ff8c42'
                        : sound ? '#35604a' : gen ? '#5c4a80' : '#3d6183';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(l + 0.5, 0.5, Math.max(1, r - l - 1), h - 1);

        // Trim grips, on the selection only — four bright bars on every clip
        // would read as clutter, and you can only trim what you have picked.
        if (selected && r - l > 14) {
            ctx.fillStyle = '#ff8c42';
            if (x0 >= 0) ctx.fillRect(l, h * 0.25, 3, h * 0.5);
            if (x1 <= w) ctx.fillRect(r - 3, h * 0.25, 3, h * 0.5);
        }

        // The name, pinned to the visible left edge so it survives scrolling
        // half the clip off screen.
        if (r - l > 46) {
            ctx.font = '10px Consolas, monospace';
            const text = clip.name;
            const tx = l + 5;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(l + 1, h - 15, Math.min(r - l - 2, ctx.measureText(text).width + 8), 14);
            ctx.fillStyle = '#dbe6f2';
            ctx.fillText(text, tx, h - 4);
        }
    }
}

/// Which columns of the lane a clip covers, and what its sound does there.
///
/// One helper because three passes ask the same two questions, and a second
/// copy of the bucket arithmetic would be a second answer to which sample of
/// the file is under a pixel.
///
/// `at(x)` is the whole reading of one column — the loudest rms and the widest
/// envelope of every bucket under it — and it is **null where nothing has been
/// read**. A clip on a link is read a window at a time (`ui/analysis.js`), so
/// most of a long one is not silence but ground nobody has covered yet, and a
/// lane that drew those columns as a flat line would be claiming the recording
/// went quiet there.
function columnsOf(clip, w) {
    const p = clip.peaks;
    const l = Math.max(0, Math.floor(timeToX(clip.start)));
    const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
    if (r <= l || !p || !p.buckets || !p.duration) return null;
    const n = p.buckets;
    const bucketAt = (x) => {
        // The same map the filmstrip reads, and for the same reason: the buckets
        // are the file's seconds and the clip's speed is the slope between them
        // and the lane.
        const t = sourceTime(clip, xToTime(x));
        const b = Math.floor((t / p.duration) * n);
        return b < 0 ? 0 : b >= n ? n - 1 : b;
    };
    const at = (x) => {
        const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
        let rms = 0, min = 0, max = 0, any = false;
        for (let b = b0; b < b1 && b < n; b++) {
            // A whole-file read has no `have` and every bucket in it was read,
            // which is the shape this has always been handed and the one a test
            // builds by hand.
            if (p.have && !p.have[b]) continue;
            any = true;
            if (p.rms[b] > rms) rms = p.rms[b];
            if (p.min[b] < min) min = p.min[b];
            if (p.max[b] > max) max = p.max[b];
        }
        return any ? { rms, min, max } : null;
    };
    return { l, r, at };
}

/// The mix, one column of the lane at a time.
///
/// Separated from the drawing because it is the *claim*: two clips that overlap
/// in time are one sound at that moment, and what a reader is judging off A1 is
/// what the render will make of it. A canvas can be checked by eye and not by a
/// test; this can be checked by both.
///
/// `rms` is already rooted, `lo`/`hi` are the summed envelope, and `quiet` is
/// what is deliberately outside the sum — see `drawAudioLane` for why each is
/// combined the way it is.
///
/// `clipped` marks the columns where the envelope has gone past full scale.
/// It is derived from `lo`/`hi` and could be recomputed by the caller; it is
/// returned because it is the answer somebody is looking at A1 *for*, and a
/// number a test can count is worth more than a colour it cannot.
export function mixColumns(w) {
    const power = new Float32Array(w);      // sum of (rms*gain)^2 while accumulating
    const lo = new Float32Array(w), hi = new Float32Array(w);
    const quiet = [];
    let mixed = false;

    for (const clip of project.clips) {
        const col = columnsOf(clip, w);
        if (!col) continue;
        if (clip.muted || clip.volume < 0.02) { quiet.push(col); continue; }
        const g = clip.volume;
        const { l, r, at } = col;
        for (let x = l; x < r; x++) {
            const s = at(x);
            if (!s) continue;
            mixed = true;
            power[x] += (s.rms * g) * (s.rms * g);
            lo[x] += s.min * g;
            hi[x] += s.max * g;
        }
    }
    const clipped = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
        power[x] = Math.sqrt(power[x]);
        // Either half on its own: a mix can go past full scale downwards
        // without ever doing it upwards, and an encoder clips both.
        if (hi[x] > 1 || lo[x] < -1) clipped[x] = 1;
    }
    return { rms: power, lo, hi, quiet, mixed, clipped };
}

/// A1: where the clips are, and **one waveform for the whole timeline**.
///
/// **It draws the mix, not the clips one after another.** Every clip used to be
/// painted in turn, so two that overlapped in time drew over each other and
/// what you saw was whichever happened to be last in the list — which is not
/// what the render makes of that moment, and that moment is exactly what
/// somebody is looking at A1 to judge. The renderer sums the clips; so does
/// this.
///
/// Summed the way a mix is summed, and the two halves are not the same sum:
///
///   - **The envelope adds.** Two sounds at once reach the sum of their peaks
///     when they peak together, and that is what clipping is — so the outline
///     is the honest bound of what the mix can hit.
///   - **The body is a root-sum-of-squares.** Adding RMS would draw a mix half
///     as loud again as it is: power adds, amplitude does not, and two
///     uncorrelated sounds at -6 dB make one at -3 rather than one at 0. That
///     is an estimate — perfectly correlated material really does add — and it
///     is the estimate every meter makes.
///
/// **Drawn in dB, with a line where clipping is** — see `dbHeight`. The sum is
/// the reason the line is worth drawing: two clips that each peak just under
/// full scale make a mix that does not, and until the lane had a scale that
/// went above 1.0 that mix was drawn as exactly full height and looked fine.
///
/// **A muted clip is drawn on its own, dimmed, and is not in the sum.** It is
/// still there and simply not being heard, so hiding it would make it hard to
/// find again; folding it in would draw sound the render will not write. Which
/// of the two a shape is is said by its colour.
function drawAudioLane() {
    const c = laneContext(wave);
    if (!c) return;
    const { ctx, w, h } = c;
    const mid = h / 2;

    // Where the clips are, first, so the mix is drawn over their boxes rather
    // than under the next one's.
    for (const clip of project.clips) {
        // **A generator is not on this lane at all.** It has no sound to be part
        // of the mix — the derivation gives it no `atrim` and the render maps
        // nothing from it — so a box here would be a claim that something is
        // waiting to be read, and nothing is. Same argument as the video lane's
        // colour, the other way round.
        if (isGenerator(clip)) continue;
        const l = Math.max(0, Math.floor(timeToX(clip.start)));
        const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
        if (r <= l) continue;
        const p = clip.peaks;
        ctx.fillStyle = p ? (isSelected(clip) ? '#24422f' : '#1d3227') : '#20242c';
        ctx.fillRect(l, 0, r - l, h);
        // What this lane is showing and what it is not — `analysis.soundNote`
        // says both, because "reading…", "no audio track" and "read from the
        // audio-only rendition, which is a second or two from the picture" are
        // one question asked of one clip. Drawn under the shape rather than
        // only where there is no shape: the last of the three is a caveat
        // about a waveform that is right there.
        const note = soundNote(clip);
        if (note && r - l > 60) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#8a92a0';
            ctx.fillText(note, l + 6, p ? h - 4 : mid + 3);
        }
    }

    const { rms, lo, hi, quiet, mixed, clipped } = mixColumns(w);

    if (mixed) {
        // The RMS body first, then the peak envelope over it: the body is what
        // the sound feels like, the envelope is what it actually reaches.
        ctx.fillStyle = 'rgba(126, 214, 160, 0.35)';
        for (let x = 0; x < w; x++) {
            const y = dbHeight(rms[x]) * mid;
            if (!y) continue;
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        for (let x = 0; x < w; x++) {
            const top = mid - dbHeight(hi[x]) * mid;
            const bot = mid + dbHeight(lo[x]) * mid;
            if (bot - top < 0.5) continue;
            // A column that has gone over is drawn in its own colour rather
            // than left to be inferred from where it ended up: the line says
            // where full scale is, and this says which columns crossed it.
            ctx.fillStyle = clipped[x] ? 'rgba(255, 122, 92, 0.95)'
                                       : 'rgba(126, 214, 160, 0.9)';
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
    }

    // What is not in it, in its own colour and one clip at a time — there is no
    // mix for it to be part of, so there is nothing to sum.
    for (const col of quiet) {
        const { l, r, at } = col;
        ctx.fillStyle = 'rgba(126, 214, 160, 0.12)';
        for (let x = l; x < r; x++) {
            const s = at(x);
            if (!s) continue;
            const y = dbHeight(s.rms) * mid;
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        ctx.fillStyle = 'rgba(126, 214, 160, 0.3)';
        for (let x = l; x < r; x++) {
            const s = at(x);
            if (!s) continue;
            const top = mid - dbHeight(s.max) * mid;
            const bot = mid + dbHeight(s.min) * mid;
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
    }

    // Full scale, across the whole lane and over everything drawn so far. It
    // is the one number on this lane that does not depend on the edit, which
    // is what makes the shape either side of it mean anything — dashed and
    // dim, because it is a reference and not a reading.
    if (h > 18) {
        const y = ZERO_DBFS * mid;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255, 140, 66, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid - y + 0.5); ctx.lineTo(w, mid - y + 0.5);
        ctx.moveTo(0, mid + y - 0.5); ctx.lineTo(w, mid + y - 0.5);
        ctx.stroke();
        ctx.restore();
        ctx.font = '9px Consolas, monospace';
        ctx.fillStyle = 'rgba(255, 140, 66, 0.65)';
        ctx.fillText('0 dB', 3, mid - y - 2);
    }

    // The outlines last, so a clip's extent stays readable over the waveform
    // rather than being buried under the next clip's body.
    for (const clip of project.clips) {
        const l = Math.max(0, Math.floor(timeToX(clip.start)));
        const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
        if (r <= l || !clip.peaks) continue;
        const selected = isSelected(clip);
        ctx.strokeStyle = selected ? '#ff8c42' : '#35604a';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(l + 0.5, 0.5, Math.max(1, r - l - 1), h - 1);
    }
}

// ── the When lane ──────────────────────────────────────────────────────────
//
// One row per filter node whose `enable=` turns it on for part of the render, and
// the spans of that node drawn as regions on the timeline's own ruler. The list —
// what the spans are, which clock each is written in, and where that puts them in
// timeline seconds — is `ui/graph/spans.js`; nothing below works any of it out.

/// The lane's own DOM, or null when the edit has no spans in it.
let spanRow = null;
/// The rows as of the last `syncSpanLane()`. Held so that the draw, the hit test
/// and a drag in flight are all about the same list: re-asking per event would
/// mean a derivation per mouse move, and re-asking between the press and the
/// release would mean the row under the hand could be a different row by the time
/// it was let go of.
let spanList = [];
/// How far apart the rows are, **measured rather than chosen**: every box in this
/// application is `border-box`, so a lane styled 42px tall has 40px of canvas in
/// it, and rows laid out at the height they were asked for would run past the
/// bottom and leave the last one clipped. So `syncSpanLane()` decides what the
/// lane's *height* is and the draw divides what it actually got — which is also
/// what the hit test has to use, or a press would find a different row from the
/// one it was aimed at.
let spanRowH = 0;
/// Pixels the lane and the gap above it come to, for `fitHeights()`.
let spanStack = 0;

/// Which of the six colours each row is drawn in, in row order.
///
/// **Hashed from the key rather than taken from the row's position**, so a node
/// keeps its colour when another one appears above it — a lane that recoloured
/// itself every time a span was added somewhere else would make the colour worth
/// nothing, and the whole job of the colour is to be the thing you recognise a row
/// by between glances.
///
/// Adjacent rows that come out the same are nudged apart, which is why this is one
/// pass over the list rather than a function of one key: two touching rows in one
/// colour is the case the eye reads as a single row, and nudging the second one
/// can only be decided against what the first one *ended up* as.
function tintsFor(rows) {
    const out = [];
    for (let r = 0; r < rows.length; r++) {
        const key = String(rows[r].key || '');
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
        let i = h % SPAN_TINTS.length;
        if (r && i === out[r - 1]) i = (i + 1) % SPAN_TINTS.length;
        out.push(i);
    }
    return out;
}

/// Build or drop the lane so that it is there exactly when there are spans.
///
/// **`trackCount()`'s idiom**: the timeline shows lanes for what the edit has, so
/// an edit with nothing on this lane does not carry an empty one, and a span made
/// three stages away on the Graph stage puts the lane here without anybody
/// switching it on. It is a row inside `#tracks` rather than a sibling of the
/// audio row, which is what puts the playhead through it — `#playhead` spans that
/// box — and the playhead is half of what makes a region on this lane answer
/// anything.
function syncSpanLane() {
    spanList = spanRows();
    const want = spanList.length;
    if (!want) {
        if (spanRow) { tracksEl.removeChild(spanRow.row); spanRow = null; }
        spanRowH = 0;
        spanStack = 0;
        return;
    }
    if (!spanRow) {
        const row = el('div', { cls: 'track-row when-row' });
        const head = el('div', { cls: 'track-head',
            title: 'Filters that are on for part of the render — one row per node, ' +
                   'each drawn where the shot it covers is. Drag an end to move it, ' +
                   'the middle to move the whole span.' },
            [el('span', { cls: 'track-name', text: 'When' })]);
        const lane = el('div', { cls: 'track-lane', id: 'lane-when' });
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        // After every video lane — `syncLanes()` inserts those at the front — and
        // before the playhead, which has to stay last in the box.
        tracksEl.appendChild(row);
        tracksEl.appendChild(playhead);
        spanRow = { row, head, lane, canvas };
        wireSpanLane(spanRow);
        rebuilt = true;
    }
    // A row wants `SPAN_ROW`; the rows share `SPAN_BUDGET` between them and stop
    // shrinking at `SPAN_FLOOR`, at which point the lane grows instead — the same
    // trade `syncLanes()` makes, and for the same reason: a row too short to be a
    // region is not worth the pixels it saves.
    const pitch = Math.max(SPAN_FLOOR, Math.min(SPAN_ROW, Math.floor(SPAN_BUDGET / want)));
    // Two for the lane's own border, so that what is left inside it — which is
    // what the canvas measures and what `spanRowH` is divided out of — is exactly
    // the rows.
    const h = want * pitch + 2;
    spanRow.lane.style.height = h + 'px';
    spanRow.row.style.height = h + 'px';
    spanRow.head.classList.toggle('tiny', pitch < 22);
    // The 4px is the gap `.track-row + .track-row` puts above it.
    spanStack = 4 + h;
}

/// The rows, and the spans on them.
///
/// **The name is drawn first and the regions over it**, in a wash rather than a
/// solid, so that a span sitting on top of the name does not take the name away.
/// That is what makes the row readable at any zoom and any pan: the alternative
/// was a label inside each region, which vanishes the moment a span is narrower
/// than its filter's name — and a region nobody can attribute is exactly what this
/// lane exists not to be.
function drawSpanLane(over) {
    if (!spanRow) return;
    const c = laneContext(spanRow.canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    // The pitch the hit test will use, taken from the height the lane actually
    // got. See `spanRowH`.
    const rh = spanRowH = h / Math.max(1, spanList.length);
    const tints = tintsFor(spanList);

    spanList.forEach((row, i) => {
        const top = i * rh;
        const [line, wash] = SPAN_TINTS[tints[i]];

        // Every other row banded, so a stack of them reads as rows rather than as
        // one lane with shapes at different heights.
        if (i % 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            ctx.fillRect(0, top, w, rh);
        }

        if (rh >= 11) {
            ctx.font = '10px Consolas, monospace';
            const base = top + rh - 3;
            ctx.fillStyle = line;
            ctx.fillText(row.filter, 4, base);
            ctx.fillStyle = '#7c838f';
            ctx.fillText(` · ${row.where}`, 4 + ctx.measureText(row.filter).width, base);
        }

        // The working copy while a drag is in flight, so the regions follow the
        // hand without a write — a write locks the node and redraws the stage,
        // which at sixty frames a second would rebuild the lane out from under it.
        // By key rather than by object, because a redraw can arrive in the
        // middle of a gesture — pressing the lane moves the playhead, which can
        // change the selection, which redraws the timeline — and the list it
        // rebuilds is a fresh set of row objects describing the same nodes.
        const drawn = (over && over.key === row.key && over.drawn) || row.drawn;
        for (const d of drawn) {
            const x0 = timeToX(d.a), x1 = timeToX(d.b);
            const l = Math.max(0, x0), r = Math.min(w, x1);
            if (r <= l) continue;
            ctx.fillStyle = wash;
            ctx.fillRect(l, top + 1, r - l, rh - 2);
            ctx.strokeStyle = line;
            ctx.lineWidth = 1;
            ctx.strokeRect(l + 0.5, top + 1.5, Math.max(1, r - l - 1), rh - 3);
            // The ends you can hold, and only the ends that exist. Drawn where
            // the edge is actually on screen, so a span running off the window
            // does not grow a grip at the edge of it.
            ctx.fillStyle = line;
            if (d.from && x0 >= 0) ctx.fillRect(l, top + 1, 2, rh - 2);
            if (d.to && x1 <= w) ctx.fillRect(r - 2, top + 1, 2, rh - 2);
        }
    });
}

// ── the Cues lane ──────────────────────────────────────────────────────────
//
// One row per track of cues the document holds (`ui/cues.js`), each cue drawn as
// a region with its own words in it. This is where the entry in "Not yet" said an
// editor would have to be — *the timeline has the lane that would make it
// possible, A1 is where you would judge a timing* — and that is the whole
// argument for it being here rather than in a panel: a subtitle's timing is
// judged by listening to where the line is spoken, so the cue has to be drawn
// against the waveform and not beside a list of numbers.
//
// **The words are inside the region, which is the opposite of what the When lane
// does**, and the two are right for different reasons. A span's identity is its
// filter, which is one short name that belongs to the whole row — so it is drawn
// once, under the regions, and stays readable when a span is four pixels wide. A
// cue's identity *is* its words: a row of unlabelled boxes would say when
// somebody speaks and never what they say, which is exactly the half this lane
// exists to add. So the text is in the region, pinned to the visible left edge
// the way a clip's name is, and suppressed when there is no room rather than
// spilling into the next cue.
//
// **A drag is committed on release and never on a move**, the same rule and the
// same reason as the When lane: a write announces an edit, which redraws this
// lane out from under the hand holding it and leaves sixty steps of history
// behind one gesture.

/// The lane's own DOM, or null when the document holds no cues.
let cueRow = null;
/// The tracks as of the last `syncCueLane()` — held for the reason `spanList` is:
/// the draw, the hit test and a drag in flight all have to be about one list.
let cueList = [];
/// Measured rather than chosen, exactly as `spanRowH` is and for the same
/// `border-box` reason.
let cueRowH = 0;
/// Pixels the lane and the gap above it come to, for `fitHeights()`.
let cueStack = 0;
/// Pixels the strip under the waveform comes to, likewise.
let cueBarStack = 0;

/// Which cue the words strip is about: `{ track, cue }`, or null.
///
/// Held as the two objects rather than as ids, because everything that could
/// invalidate it happens on this side — a delete, a merge, a document opening —
/// and `cueSelectionStillThere()` checks it against the model on every draw. An
/// id pair would be the same check written out longer.
let cueSel = null;

/// Which cue is being edited, for the properties panel and for tests. Null when
/// nothing is selected.
export const selectedCue = () => (cueSel ? cueSel.cue : null);
export const selectedCueTrack = () => (cueSel ? cueSel.track : null);

/// Select one, or nothing. Exported because the Write stage's `Edit these cues`
/// arrives here with a track and no idea which cue somebody wants — and because a
/// test that had to synthesise a press to reach a selection would be testing the
/// press.
export function selectCue(track, cue) {
    cueSel = track && cue ? { track, cue } : null;
}

function cueSelectionStillThere() {
    if (!cueSel) return;
    if (cueTracks.indexOf(cueSel.track) < 0 || cueSel.track.cues.indexOf(cueSel.cue) < 0)
        cueSel = null;
}

/// Build or drop the lane so that it is there exactly when there are cues.
///
/// `trackCount()`'s idiom again, and inside `#tracks` for the same reason the When
/// lane is: `#playhead` spans that box, and half of what makes a region here
/// answer anything is being able to see where the playhead cuts it.
///
/// **Kept last among the rows**, so the cues sit directly above the waveform. The
/// When lane appends itself on creation, so a lane made before it would end up
/// above it; one line moves this back rather than making either of them know
/// about the other.
function syncCueLane() {
    cueList = cueTracks.slice();
    cueSelectionStillThere();
    const want = cueList.length;
    if (!want) {
        if (cueRow) { tracksEl.removeChild(cueRow.row); cueRow = null; }
        cueRowH = 0;
        cueStack = 0;
        return;
    }
    if (!cueRow) {
        const row = el('div', { cls: 'track-row cue-lane-row' });
        const head = el('div', { cls: 'track-head',
            title: 'Cues this document holds. Drag an end to retime one, the middle to ' +
                   'move it; the words are typed in the strip under the waveform.' },
            [el('span', { cls: 'track-name', text: 'Cues' })]);
        const lane = el('div', { cls: 'track-lane', id: 'lane-cues' });
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        tracksEl.appendChild(row);
        cueRow = { row, head, lane, canvas };
        wireCueLane(cueRow);
        rebuilt = true;
    }
    // Last among the rows and then the playhead, which has to stay last in the
    // box. Done on every sync rather than only on creation, because the When lane
    // appears and disappears on a channel of its own.
    if (cueRow.row.nextSibling !== playhead) {
        tracksEl.appendChild(cueRow.row);
        tracksEl.appendChild(playhead);
    }
    const pitch = Math.max(CUE_FLOOR, Math.min(CUE_ROW, Math.floor(CUE_BUDGET / want)));
    const h = want * pitch + 2;
    cueRow.lane.style.height = h + 'px';
    cueRow.row.style.height = h + 'px';
    cueRow.head.classList.toggle('tiny', pitch < 22);
    cueStack = 4 + h;
}

/// The rows, and the cues on them.
///
/// `over` is the cue held mid-drag with the span it is being dragged to, so the
/// region follows the hand without a write — matched by object rather than by
/// key, because unlike a derived graph node a cue *is* the model and survives a
/// redraw.
function drawCueLane(over) {
    if (!cueRow) return;
    const c = laneContext(cueRow.canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const rh = cueRowH = h / Math.max(1, cueList.length);
    ctx.font = '10px Consolas, monospace';

    cueList.forEach((track, i) => {
        const top = i * rh;
        if (i % 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            ctx.fillRect(0, top, w, rh);
        }
        for (const cue of track.cues) {
            const held = over && over.cue === cue;
            const a = held ? over.a : cue.start;
            const b = held ? over.b : cue.end;
            const x0 = timeToX(a), x1 = timeToX(b);
            const l = Math.max(0, x0), r = Math.min(w, x1);
            if (r <= l) continue;
            const on = cueSel && cueSel.cue === cue;
            ctx.fillStyle = on ? 'rgba(124, 196, 255, 0.30)' : 'rgba(124, 196, 255, 0.16)';
            ctx.fillRect(l, top + 1, r - l, rh - 2);
            // `#ff8c42` written out rather than `var(--accent)`: a canvas takes a
            // colour string and does not resolve a custom property, so the
            // variable would arrive as an invalid value and leave the stroke
            // whatever it was last set to. The same literal every other selected
            // thing on this timeline is drawn in.
            ctx.strokeStyle = on ? '#ff8c42' : '#7cc4ff';
            ctx.lineWidth = 1;
            ctx.strokeRect(l + 0.5, top + 1.5, Math.max(1, r - l - 1), rh - 3);
            // Both ends exist on a cue — unlike a span, which can be open at one
            // end — so both grips are always drawn, where they are on screen.
            ctx.fillStyle = on ? '#ffffff' : '#7cc4ff';
            if (x0 >= 0) ctx.fillRect(l, top + 1, 2, rh - 2);
            if (x1 <= w) ctx.fillRect(r - 2, top + 1, 2, rh - 2);
            // The words, pinned to the *visible* left edge so a cue running off
            // the window keeps its line readable — the same trick a clip's name
            // uses. Cut to the region rather than clipped, because a canvas clip
            // for one string is more machinery than measuring it.
            if (rh >= 11 && r - l > 24) {
                ctx.fillStyle = on ? '#e8ecf2' : '#b9c1cc';
                ctx.fillText(fitText(ctx, oneLine(cue.text), r - l - 8), l + 4, top + rh - 4);
            }
        }
    });
}

/// A cue's words on one line. A `\N` in an ASS cue is a break the *author* asked
/// for, so it becomes a middle dot rather than disappearing — "he said / and then
/// he said" reads as two lines and "he saidand then he said" reads as a typo. The
/// same rule the Write stage's cue list follows.
function oneLine(text) {
    return String(text || '').replace(/\s*\n\s*/g, ' · ').trim();
}

/// As much of a string as fits in `px`, with an ellipsis where it was cut.
///
/// Measured rather than counted, because the face is proportional at the edges
/// even at 10px and a character count would cut a wide line short and let a
/// narrow one overflow. Binary search rather than a walk: a cue is a sentence and
/// this runs once per cue per frame.
function fitText(ctx, text, px) {
    if (px <= 0) return '';
    if (ctx.measureText(text).width <= px) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${text.slice(0, mid)}…`).width <= px) lo = mid;
        else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

/// What a press on the Cues lane has hold of: an end, a body, or nothing.
///
/// Written out rather than shared with `spanGrabAt` for the reason that one is
/// written out rather than shared with `grabAt`: the shapes are the same and the
/// *rules* are not — a span can be open at one end and a cue never is, and a cue
/// carries no row index into a parallel list of drawn positions because it is the
/// model. Merging them would mean a hit test with a mode.
function cueGrabAt(x, y) {
    if (!cueRowH) return null;
    const track = cueList[Math.floor(y / cueRowH)];
    if (!track) return null;
    let best = null, bestD = TRIM_GRAB + 1;
    for (const cue of track.cues) {
        const l = timeToX(cue.start), r = timeToX(cue.end);
        const dl = Math.abs(x - l), dr = Math.abs(x - r);
        // The same half-pixel tie-break the clip and span hit tests use: two cues
        // butted together share an edge, and without it the press always finds
        // the second one's start.
        if (dl <= TRIM_GRAB && dl - 0.5 < bestD) { bestD = dl - 0.5; best = { track, cue, what: 'start' }; }
        if (dr <= TRIM_GRAB && dr < bestD) { bestD = dr; best = { track, cue, what: 'end' }; }
    }
    if (best) return best;
    for (const cue of track.cues)
        if (x >= timeToX(cue.start) && x <= timeToX(cue.end)) return { track, cue, what: 'move' };
    return { track, cue: null, what: '' };
}

/// Press to seek and to select, drag an end to retime, drag the middle to move.
///
/// **Snapped through the same two functions the rest of the timeline is** —
/// `snapTime` for an edge and `snapShift` for a body — so a cue's end lands on a
/// cut, on the playhead or on zero exactly where a clip's would. That is most of
/// what makes this lane worth having over a pair of number fields: the moment a
/// line is spoken is a moment on the waveform, and the playhead is how you say
/// where it is.
function wireCueLane(entry) {
    let drag = null;

    tracked(entry.lane,
        (e) => {
            const box = entry.lane.getBoundingClientRect();
            const x = e.clientX - box.left;
            const grab = cueGrabAt(x, e.clientY - box.top);
            onSeek(xToTime(x), true);
            // Selecting on the press rather than on the release, so that the
            // words strip is already about this cue while it is being dragged —
            // which is the state somebody retiming a line against the waveform is
            // in for the whole gesture.
            if (grab) { selectCue(grab.track, grab.cue); drawCueBar(); }
            drag = grab && grab.cue
                ? { track: grab.track, cue: grab.cue, what: grab.what,
                    a: grab.cue.start, b: grab.cue.end,
                    grabTime: xToTime(x), moved: false }
                : null;
        },
        (e) => {
            const x = e.clientX - entry.lane.getBoundingClientRect().left;
            if (!drag) { onSeek(xToTime(x), false); return; }
            const t = xToTime(x);
            const by = t - drag.grabTime;
            if (!drag.moved && Math.abs(by) * (laneWidth() / view.span) < 3) return;
            drag.moved = true;
            if (drag.what === 'move') {
                const d = snapShift(drag.cue.start, drag.cue.end, by);
                const at = Math.max(0, drag.a + d);
                drag.to = { a: at, b: at + (drag.b - drag.a) };
            } else if (drag.what === 'start') {
                drag.to = { a: Math.max(0, Math.min(snapTime(t, null), drag.b - CUE_MIN)),
                            b: drag.b };
            } else {
                drag.to = { a: drag.a,
                            b: Math.max(drag.a + CUE_MIN, snapTime(t, null)) };
            }
            drawCueLane({ cue: drag.cue, a: drag.to.a, b: drag.to.b });
        },
        () => {
            if (drag && drag.moved && drag.to) {
                setCueTime(drag.track, drag.cue, drag.to.a, drag.to.b);
                cuesChanged('cue-time');
            }
            onSeek(undefined, false, true);
            drag = null;
        });
}

// ── the words, which a canvas cannot hold ──────────────────────────────────
//
// A strip under the waveform: the selected cue's span, a field for its line, and
// the four presses the "Not yet" entry named — make one, split one at the
// playhead, merge two, delete one.
//
// **The field writes on every keystroke and announces on `change`.** That is the
// same rule as a drag committing on release, arrived at from the other side: the
// model has to be current so the lane draws what is being typed, and an announce
// per character would be a step of undo per character and a redraw of five stages.
// `change` fires on blur and on Enter, which is where a sentence ends.

/// What the strip is currently about, so that a redraw for the *same* cue leaves
/// the field alone.
///
/// **This is the one control on the timeline with a caret in it**, and `draw()`
/// runs on every model change — including the one the field itself makes. Rebuilt
/// unconditionally, a keystroke would replace the input under the hand and the
/// caret would jump to the end of the line on every character. So a repeat is the
/// time label and the styled marker rewritten in place, which are the only two
/// things that can change without the *subject* changing.
let cueBarFor = null;

/// The strip, redrawn.
function drawCueBar() {
    if (!cueBarRow) return;
    cueBarRow.classList.toggle('hidden', !cueList.length);
    if (!cueList.length) { cueBarFor = null; return put(cueBar, () => []); }
    const track = (cueSel && cueSel.track) || cueList[0];
    const cue = cueSel && cueSel.cue;

    if (cueBarFor && cueBarFor.track === track && cueBarFor.cue === cue &&
        cueBarFor.rows === cueList.length) {
        if (cue && cueBarFor.when)
            cueBarFor.when.textContent = `${cue.start.toFixed(2)} → ${cue.end.toFixed(2)}`;
        return;
    }
    cueBarFor = { track, cue, rows: cueList.length, when: null };

    // **The playhead is read inside the press and never captured here.** The
    // strip is rebuilt when its subject changes and not when the playhead moves,
    // so a moment taken at build time is the moment the cue was *selected* — and
    // `Split` would then cut where you pressed rather than where the playhead has
    // since been dragged to, which looks like a control that does not work.
    //
    // **The button's own name is the change's kind**, which is what keeps a split
    // and the cue added after it two steps of undo: `ui/history.js` folds a run of
    // one kind, and these four are four different things somebody did. All that
    // is left folding is two presses of the same button inside half a second.
    const press = (text, title, f, name) => el('button', {
        cls: 'tiny', text, title, 'data-f': name,
        on: { click: () => { f(playheadTime()); cuesChanged(name); draw(); } },
    });

    put(cueBar, () => {
        const bits = [];
        if (cueList.length > 1)
            bits.push(el('span', { cls: 'cue-at', text: track.name }));
        bits.push(press('+ Cue', 'A new cue at the playhead, running to the next cue or ' +
                                 'two seconds, whichever comes first', (at) => {
            const next = track.cues.find((k) => k.start > at + 1e-6);
            const end = next ? Math.min(next.start, at + CUE_SECONDS) : at + CUE_SECONDS;
            selectCue(track, addCue(track, at, Math.max(at + CUE_MIN, end), ''));
        }, 'cue-add'));
        if (!cue) {
            bits.push(el('span', { cls: 'dim',
                text: 'press a cue on the lane to edit its words, or drag its ends to ' +
                      'retime it against the waveform' }));
            return bits;
        }
        cueBarFor.when = el('span', { cls: 'cue-at',
                                      text: `${cue.start.toFixed(2)} → ${cue.end.toFixed(2)}` });
        bits.push(cueBarFor.when);
        bits.push(el('input', {
            type: 'text', 'data-f': 'cue-text', value: cue.text,
            title: 'What this cue says. A newline is a line break the player keeps.',
            on: {
                input: (e) => { setCueText(track, cue, e.target.value); drawCueLane(); },
                change: (e) => { setCueText(track, cue, e.target.value); cuesChanged(); },
            },
        }));
        bits.push(press('Split', 'Cut this cue in two at the playhead. The words stay with ' +
                                 'the first half and the second arrives empty, because where ' +
                                 'in the sentence the cut goes is not something this can know.',
                        (at) => { const half = splitCue(track, cue, at);
                                  if (half) selectCue(track, half); }, 'cue-split'));
        // **Offered only where there is a next cue to join.** A press that is
        // always there and does nothing on the last cue is a control that looks
        // broken; the last cue in a track simply has nothing after it, which is a
        // fact about the track rather than a failure to report.
        if (track.cues.indexOf(cue) < track.cues.length - 1)
            bits.push(press('Merge', 'Join this cue with the next one — the words become two ' +
                                     'lines and the span runs from this start to that end. ' +
                                     'A merge replaces the words, so it costs the override ' +
                                     'codes for the same reason retyping does.',
                            () => { mergeCue(track, cue); }, 'cue-merge'));
        bits.push(press('Delete', 'Take this cue out of the track',
                        () => { removeCue(track, cue); selectCue(null, null); }, 'cue-delete'));
        // Said here rather than only on the Write stage, because this is the
        // field somebody is about to type into and that press is when the codes
        // go. See `setCueText` in ui/cues.js for why the whole text field is
        // replaced rather than the words inside the codes.
        if (hasOverrides(cue))
            bits.push(el('span', { cls: 'cue-styled',
                text: 'styled — retyping drops this cue’s override codes',
                title: 'This cue carries ASS override codes ({\\i1}, {\\pos(…)}) that came ' +
                       'out of the file. They are written back exactly as they are until ' +
                       'the words are retyped, which replaces the whole text field. Its ' +
                       'style, layer and margins are kept either way.' }));
        return bits;
    });
}

/// The lane, for tests: what is on it, how tall a row is, and which cue is
/// selected. The same reader `whenLane()` is, and for the same reason — a canvas
/// cannot be asserted against, and a drag driven through `timeToX` plus this is
/// the gesture rather than an imitation of it.
export function cueLane() {
    return { lane: cueRow ? cueRow.lane : null, tracks: cueList,
             rowHeight: cueRowH, selected: cueSel };
}




function drawRuler() {
    const w = laneWidth();
    if (w <= 0) return put(ruler, () => []);

    // A label roughly every 90 px, landing on a round number of seconds.
    const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const want = (view.span * 90) / w;
    const step = steps.find((s) => s >= want) || steps[steps.length - 1];

    put(ruler, () => {
        const ticks = [];
        const first = Math.ceil(view.start / step) * step;
        for (let t = first; t <= view.start + view.span + 1e-9; t += step) {
            const x = timeToX(t);
            if (x < -2 || x > w) continue;
            ticks.push(el('div', { cls: 'tick', text: rulerLabel(t, view.span),
                                   style: { left: `${x.toFixed(1)}px` } }));
        }
        return ticks;
    });
}

function drawScrollbar() {
    if (!scrollThumb) return;
    const tot = total();
    const f = Math.min(1, view.span / tot);
    scrollThumb.style.width = (f * 100).toFixed(3) + '%';
    scrollThumb.style.left = ((view.start / tot) * 100).toFixed(3) + '%';
    scrollThumb.style.display = f >= 0.999 ? 'none' : 'block';
    if (zoomLabel) {
        const z = tot / view.span;
        zoomLabel.textContent = (z < 10 ? z.toFixed(1) : Math.round(z)) + '×' +
                                `  ${clock(view.start)}–${clock(view.start + view.span)}`;
    }
}

/// Tell the analysis which span of each clip's source is on screen.
///
/// A clip read over a link is read for what is being shown and no more (see
/// `ui/analysis.js`), and this is the one place that knows what that is. Once
/// per clip per draw rather than once per lane: both lanes show the same span
/// of the same clip, and a second caller would be a second answer to which
/// seconds are in view.
///
/// A width of zero is a hidden stage and not a clip nobody can see, which is
/// the standing rule about measuring anything in this frame loop.
function watchView() {
    const w = laneWidth();
    if (w <= 0) return;
    for (const clip of project.clips) {
        const l = Math.max(0, timeToX(clip.start));
        const r = Math.min(w, timeToX(clip.start + clip.length));
        if (r <= l) continue;
        showing(clip, sourceTime(clip, xToTime(l)), sourceTime(clip, xToTime(r)), r - l);
    }
}

export function draw() {
    syncLanes();
    syncHeads();
    syncSpanLane();
    syncCueLane();
    fitHeights();
    clampView();
    watchView();
    drawRuler();
    for (const l of lanes) drawVideoLane(l.track, l.canvas);
    drawAudioLane();
    drawSpanLane();
    drawCueLane();
    drawCueBar();
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
    const stack = laneStack + spanStack + cueStack;
    tracksEl.style.height = stack + 'px';
    // Everything above and below the box of lanes: the zoom bar, the ruler, the
    // waveform, the words strip when there is one, the scrollbar and the gaps.
    cueBarStack = cueList.length ? 4 + 24 : 0;
    timelineEl.style.height =
        (30 + 18 + 6 + stack + 4 + 44 + cueBarStack + 6 + 9 + 6) + 'px';
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

/// The When lane as it is on screen — `{ lane, rows, rowHeight }`, or `null` when
/// the edit has no spans and so has no lane.
///
/// A reader and nothing else, and it exists because everything this lane claims is
/// drawn into a canvas: which node a region belongs to, where its ends are, and
/// how many rows there are cannot be read off the DOM. So the rows a test drags on
/// are the rows the draw used, which is also what makes an assertion about the
/// lane an assertion about the picture rather than about the model a second time —
/// `ui/graph/spans.js` is where the model is checked.
export function whenLane() {
    if (!spanRow) return null;
    return { lane: spanRow.lane, rows: spanList, rowHeight: spanRowH };
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

    // The lane to measure against is looked up on every event rather than
    // captured, because a cross-track drag rebuilds the lanes underneath
    // itself: `moveClip` changes the track count, `syncLanes()` drops every
    // row, and the element the press started on is detached — where
    // `getBoundingClientRect()` reports `left: 0`. The scale would still be
    // right (`laneWidth()` comes from the new `lanes[0]`) and only the origin
    // wrong, so the clip jumped sideways by the width of the track heads the
    // instant it crossed tracks and stayed there, snapping to the wrong
    // neighbours for the rest of the drag. `laneOf` exists for exactly this.
    const liveLane = () => {
        const l = laneOf(entry.track);
        return l ? l.lane : entry.lane;
    };

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
            const other = grab && grab.what !== 'move' && e.altKey
                ? buttedAt(grab.clip, grab.what) : null;
            drag = grab ? {
                clip: grab.clip, what: grab.what,
                // The edit this press is, decided once. Read per move it would
                // change under a hand that let go of Alt half way through a
                // drag, which is a gesture turning into a different gesture
                // while it is being made.
                edit: !e.altKey ? 'plain' : other ? 'roll'
                    : grab.what === 'move' ? 'slip' : 'ripple',
                other,
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
            } else if (drag.what === 'move') {
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
                if (drag.edit === 'plain' && drag.what === 'move') resolveOverlaps(drag.clip);
                changed('moved');
            }
            // Always release, even after an edit: the press paused playback to
            // scrub, and only this puts it back.
            onSeek(undefined, false, true);
            drag = null;
        });
}

/// A whole span's move, snapped like a clip's.
///
/// The same targets `snapStart` uses and for the same reason: the answer somebody
/// wants out of this lane is almost always "cover exactly that shot", and the ends
/// of the shots are on the timeline to be snapped to. `by` is a *distance* and
/// comes back as one, so the caller can hand it to the model unmapped — both
/// clocks run at a second per second, and only their origins differ.
///
/// Both ends are tried, because a span is snapped by whichever of its edges lands
/// on something: dragging a span so its tail meets a cut is as much the gesture as
/// dragging its head there.
function snapShift(a, b, by) {
    const tolerance = (view.span / Math.max(1, laneWidth())) * 7;
    const targets = [0, playheadTime()];
    for (const c of project.clips) targets.push(c.start, c.start + c.length);
    let best = by, bestD = tolerance;
    for (const t of targets)
        for (const edge of [a + by, b + by]) {
            const d = Math.abs(edge - t);
            if (d < bestD) { bestD = d; best = by + (t - edge); }
        }
    return best;
}

/// The When lane: press to seek, drag an end to move it, drag the middle to move
/// the whole span.
///
/// **Committed on release and not on every move.** A write goes through
/// `overlay.edit`, which on a derived node records a lock and in every case
/// announces an edit — a step of undo, a redraw of the spine, the command bar, the
/// Graph stage and this lane. At sixty frames a second that would rebuild the lane
/// under the hand holding it and leave sixty steps of history behind one gesture.
/// So the regions follow the pointer from a working copy and one write ends the
/// drag. Same rule, and the same reason, as the strip in the column.
///
/// **And nothing is written when the pointer never moved**, which is the same trap
/// the strip fell into: `printEnable(parseEnable(text))` is not the text —
/// `between(t,1.00,2.00)` comes back `between(t,1,2)` — so a bare click on a
/// region would rewrite somebody's expression, and on a derived node it would
/// write a lock that outranks the edit for ever after.
function wireSpanLane(entry) {
    let drag = null;

    tracked(entry.lane,
        (e) => {
            const box = entry.lane.getBoundingClientRect();
            const x = e.clientX - box.left;
            const grab = spanGrabAt(x, e.clientY - box.top);
            // Pressing anywhere on a lane moves the playhead there, including on
            // a span — the same rule the video lanes follow, and it is worth more
            // here than there: the moment you pressed at is the moment `⇤`/`⇥` in
            // the column would place an edge at.
            onSeek(xToTime(x), true);
            drag = grab ? {
                // The key as well as the row: the row object may be replaced by a
                // redraw arriving mid-gesture, and the key is what survives one.
                // The clock cannot change without the range changing, so it is
                // read off the row that was pressed on.
                key: grab.row.key, row: grab.row, i: grab.at, what: grab.what,
                // The span as it was when the press began, for `editBody` —
                // measured from the press rather than accumulated, so a drag that
                // ran past the end of the ruler comes back the way it went out.
                held: Object.assign({}, grab.row.spans[grab.at]),
                a: grab.row.drawn[grab.at].a, b: grab.row.drawn[grab.at].b,
                grabTime: xToTime(x), working: grab.row.spans, moved: false,
            } : null;
        },
        (e) => {
            const x = e.clientX - entry.lane.getBoundingClientRect().left;
            if (!drag) { onSeek(xToTime(x), false); return; }
            const t = xToTime(x);
            const by = t - drag.grabTime;
            if (!drag.moved && Math.abs(by) * (laneWidth() / view.span) < 3) return;
            drag.moved = true;
            drag.working = drag.what === 'move'
                ? editBody(drag.row, drag.row.spans, drag.i, drag.held,
                           snapShift(drag.a, drag.b, by))
                : editEdge(drag.row, drag.row.spans, drag.i, drag.what, snapTime(t, null));
            // Placed by the model, not by this: where a span lands on the
            // timeline has one answer whether it is being dragged or drawn.
            drawSpanLane({ key: drag.key, drawn: placeSpans(drag.row.clk, drag.working) });
        },
        () => {
            if (drag && drag.moved) commitSpans(drag.row, drag.working);
            onSeek(undefined, false, true);
            drag = null;
        });
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
    cueBar = refs.cueBar;
    cueBarRow = refs.cueBarRow;
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
