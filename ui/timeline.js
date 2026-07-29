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

import { project, projectFps, duration, moveClip, resolveOverlaps, changed, trackCount,
         isSelected, select, trimClip, rippleTrim, rollCut, slipClip,
         hasPicture } from './project.js';
import { rulerLabel, clock } from './format.js';
import { el, put } from './dom.js';

let ruler, tracksEl, wave, laneAudio, playhead, scrollTrack, scrollThumb, zoomLabel, timelineEl;
let lanes = [];                 // [{ row, head, lane, canvas }] bottom track first
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

/// Last thumbnail grabbed at or before `t` seconds into the file.
function thumbAt(times, t) {
    let lo = 0, hi = times.length - 1, best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
}

function drawVideoLane(track, canvas) {
    const c = laneContext(canvas);
    if (!c) return;
    const { ctx, w, h } = c;

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

        ctx.fillStyle = sound ? (selected ? '#24422f' : '#1d3227')
                              : (selected ? '#2a4666' : '#223449');
        ctx.fillRect(l, 0, r - l, h);

        if (sound && r - l > 60 && h > 14) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#8a92a0';
            ctx.fillText('sound only', l + 6, h / 2 + 3);
        }

        if (clip.film && clip.film.count > 0) {
            const { bitmap, width: tw, height: th, count, times } = clip.film;
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
                const t = clip.inPoint + (xToTime(sx) - clip.start);
                const i = Math.min(count - 1, thumbAt(times, t));
                // Partial slots at either edge crop the source rather than
                // squeezing a whole thumbnail into fewer pixels.
                const u0 = (dl - sx) / slot, u1 = (dr - sx) / slot;
                ctx.drawImage(bitmap,
                              i * tw + u0 * tw, 0, Math.max(1, (u1 - u0) * tw), th,
                              dl, 0, dr - dl, h);
            }
        }

        // A clip that is not fully opaque says so, since on a lower track that
        // is the difference between "hidden" and "gone".
        if (clip.xform.opacity < 0.999) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(l, 0, r - l, 13);
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#ffb37a';
            ctx.fillText(Math.round(clip.xform.opacity * 100) + '%', l + 5, 10);
        }

        ctx.strokeStyle = selected ? '#ff8c42' : (sound ? '#35604a' : '#3d6183');
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

/// Which columns of the lane a clip covers, and how to read its peaks there.
///
/// One helper because three passes ask the same two questions, and a second
/// copy of the bucket arithmetic would be a second answer to which sample of
/// the file is under a pixel.
function columnsOf(clip, w) {
    const p = clip.peaks;
    const l = Math.max(0, Math.floor(timeToX(clip.start)));
    const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
    if (r <= l || !p || !p.buckets || !p.duration) return null;
    const n = p.buckets;
    const bucketAt = (x) => {
        const t = clip.inPoint + (xToTime(x) - clip.start);
        const b = Math.floor((t / p.duration) * n);
        return b < 0 ? 0 : b >= n ? n - 1 : b;
    };
    return { l, r, n, p, bucketAt };
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
export function mixColumns(w) {
    const power = new Float32Array(w);      // sum of (rms*gain)^2 while accumulating
    const lo = new Float32Array(w), hi = new Float32Array(w);
    const quiet = [];
    let mixed = false;

    for (const clip of project.clips) {
        const col = columnsOf(clip, w);
        if (!col) continue;
        if (clip.muted || clip.volume < 0.02) { quiet.push(col); continue; }
        mixed = true;
        const g = clip.volume;
        const { l, r, n, p, bucketAt } = col;
        for (let x = l; x < r; x++) {
            const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
            let m = 0, a = 0, b2 = 0;
            for (let b = b0; b < b1 && b < n; b++) {
                if (p.rms[b] > m) m = p.rms[b];
                if (p.min[b] < a) a = p.min[b];
                if (p.max[b] > b2) b2 = p.max[b];
            }
            power[x] += (m * g) * (m * g);
            lo[x] += a * g;
            hi[x] += b2 * g;
        }
    }
    for (let x = 0; x < w; x++) power[x] = Math.sqrt(power[x]);
    return { rms: power, lo, hi, quiet, mixed };
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
        const l = Math.max(0, Math.floor(timeToX(clip.start)));
        const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
        if (r <= l) continue;
        const p = clip.peaks;
        ctx.fillStyle = p ? (isSelected(clip) ? '#24422f' : '#1d3227') : '#20242c';
        ctx.fillRect(l, 0, r - l, h);
        if ((!p || !p.buckets || !p.duration) && clip.ready && r - l > 60) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#8a92a0';
            ctx.fillText(clip.probe.audio ? 'reading…' : 'no audio track', l + 6, mid + 3);
        }
    }

    const { rms, lo, hi, quiet, mixed } = mixColumns(w);

    if (mixed) {
        // The RMS body first, then the peak envelope over it: the body is what
        // the sound feels like, the envelope is what it actually reaches.
        ctx.fillStyle = 'rgba(126, 214, 160, 0.35)';
        for (let x = 0; x < w; x++) {
            if (!rms[x]) continue;
            const y = Math.min(mid, rms[x] * mid * 1.6);
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        ctx.fillStyle = 'rgba(126, 214, 160, 0.9)';
        for (let x = 0; x < w; x++) {
            if (!hi[x] && !lo[x]) continue;
            const top = mid - Math.min(mid, hi[x] * mid);
            const bot = mid + Math.min(mid, -lo[x] * mid);
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
    }

    // What is not in it, in its own colour and one clip at a time — there is no
    // mix for it to be part of, so there is nothing to sum.
    for (const col of quiet) {
        const { l, r, n, p, bucketAt } = col;
        ctx.fillStyle = 'rgba(126, 214, 160, 0.12)';
        for (let x = l; x < r; x++) {
            const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
            let m = 0;
            for (let b = b0; b < b1 && b < n; b++) if (p.rms[b] > m) m = p.rms[b];
            const y = Math.min(mid, m * mid * 1.6);
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        ctx.fillStyle = 'rgba(126, 214, 160, 0.3)';
        for (let x = l; x < r; x++) {
            const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
            let a = 0, b2 = 0;
            for (let b = b0; b < b1 && b < n; b++) {
                if (p.min[b] < a) a = p.min[b];
                if (p.max[b] > b2) b2 = p.max[b];
            }
            const top = mid - Math.min(mid, b2 * mid);
            const bot = mid + Math.min(mid, -a * mid);
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
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

export function draw() {
    syncLanes();
    clampView();
    drawRuler();
    for (const l of lanes) drawVideoLane(l.track, l.canvas);
    drawAudioLane();
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
        const head = el('div', { cls: 'track-head' },
                        el('span', { cls: 'track-name', text: `V${track + 1}` }));
        const lane = document.createElement('div');
        lane.className = 'track-lane';
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        // Prepend so V1 ends up at the bottom of the stack of rows.
        tracksEl.insertBefore(row, tracksEl.firstChild);
        const entry = { track, row, head, lane, canvas };
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
    const stack = want * h + (want - 1) * 4;
    tracksEl.style.height = stack + 'px';
    // Everything above and below the video lanes: the zoom bar, the ruler, the
    // waveform, the scrollbar and the gaps between them.
    timelineEl.style.height = (30 + 18 + 6 + stack + 4 + 44 + 6 + 9 + 6) + 'px';
    // A short lane has no room for a pill with a name in it.
    for (const l of lanes) l.head.classList.toggle('tiny', h < 22);
}

/// The DOM for one video track — the lane box and its canvas. Tests and the
/// app reach lanes through this rather than by id, because the ids would have
/// to be invented per track and would go stale as tracks come and go.
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
                slipClip(drag.clip, -delta);
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

    const scrubOn = (el) => tracked(el,
        (e) => { onSeek(xToTime(localX(e, el)), true); },
        (e) => { onSeek(xToTime(localX(e, el)), false); },
        () => onSeek(undefined, false, true));

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
