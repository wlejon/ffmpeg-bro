// The timeline: a ruler, a video track and an audio track, over a window of
// time you can zoom into.
//
// Everything is drawn from the visible window rather than from the whole file,
// which is what makes zooming mean anything: at 1× the strip is a summary of
// the clip, at 200× it is the individual frames around the playhead, and the
// waveform under it is the sound at that moment rather than a smear of the
// whole take.

import { project, duration, moveClip, resolveOverlaps, changed } from './project.js';
import { rulerLabel, clock } from './format.js';

let ruler, film, wave, laneVideo, laneAudio, playhead, scrollTrack, scrollThumb, zoomLabel;
let onSeek = () => {};

// The visible window, in seconds.
const view = { start: 0, span: 10 };

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
    const fps = project.fps || 25;
    return Math.max(0.02, 4 / fps);
}

function laneWidth() { return film ? (film.clientWidth || 0) : 0; }

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

export function clipAtX(x) {
    const t = xToTime(x);
    for (const c of project.clips)
        if (t >= c.start && t <= c.start + c.length) return c;
    return null;
}

// ── drawing ────────────────────────────────────────────────────────────────

// Size a canvas to its box and hand back a cleared context.
function laneContext(canvas) {
    const w = canvas.clientWidth | 0;
    const h = canvas.clientHeight | 0;
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

function drawVideoLane() {
    const c = laneContext(film);
    if (!c) return;
    const { ctx, w, h } = c;

    for (const clip of project.clips) {
        const x0 = timeToX(clip.start);
        const x1 = timeToX(clip.start + clip.length);
        const l = Math.max(0, x0), r = Math.min(w, x1);
        if (r <= l) continue;
        const selected = project.selected === clip;

        ctx.fillStyle = selected ? '#2a4666' : '#223449';
        ctx.fillRect(l, 0, r - l, h);

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

        ctx.strokeStyle = selected ? '#ff8c42' : '#3d6183';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(l + 0.5, 0.5, Math.max(1, r - l - 1), h - 1);

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

function drawAudioLane() {
    const c = laneContext(wave);
    if (!c) return;
    const { ctx, w, h } = c;
    const mid = h / 2;

    for (const clip of project.clips) {
        const x0 = timeToX(clip.start);
        const x1 = timeToX(clip.start + clip.length);
        const l = Math.max(0, Math.floor(x0)), r = Math.min(w, Math.ceil(x1));
        if (r <= l) continue;
        const selected = project.selected === clip;
        const p = clip.peaks;

        ctx.fillStyle = p ? (selected ? '#24422f' : '#1d3227') : '#20242c';
        ctx.fillRect(l, 0, r - l, h);

        if (!p || !p.buckets || !p.duration) {
            if (clip.ready && r - l > 60) {
                ctx.font = '10px Consolas, monospace';
                ctx.fillStyle = '#8a92a0';
                ctx.fillText(clip.probe.audio ? 'reading…' : 'no audio track', l + 6, mid + 3);
            }
            continue;
        }

        const n = p.buckets;
        const bucketAt = (x) => {
            const t = clip.inPoint + (xToTime(x) - clip.start);
            const b = Math.floor((t / p.duration) * n);
            return b < 0 ? 0 : b >= n ? n - 1 : b;
        };

        // The RMS body first, then the peak envelope over it: the body is what
        // the sound feels like, the envelope is what it actually reaches.
        ctx.fillStyle = 'rgba(126, 214, 160, 0.35)';
        for (let x = l; x < r; x++) {
            const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
            let m = 0;
            for (let b = b0; b < b1 && b < n; b++) if (p.rms[b] > m) m = p.rms[b];
            const y = Math.min(mid, m * mid * 1.6);
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        ctx.fillStyle = 'rgba(126, 214, 160, 0.9)';
        for (let x = l; x < r; x++) {
            const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
            let lo = 0, hi = 0;
            for (let b = b0; b < b1 && b < n; b++) {
                if (p.min[b] < lo) lo = p.min[b];
                if (p.max[b] > hi) hi = p.max[b];
            }
            const top = mid - Math.min(mid, hi * mid);
            const bot = mid + Math.min(mid, -lo * mid);
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }

        ctx.strokeStyle = selected ? '#ff8c42' : '#35604a';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(l + 0.5, 0.5, Math.max(1, r - l - 1), h - 1);
    }
}

function drawRuler() {
    const w = laneWidth();
    if (w <= 0) { ruler.innerHTML = ''; return; }

    // A label roughly every 90 px, landing on a round number of seconds.
    const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const want = (view.span * 90) / w;
    const step = steps.find((s) => s >= want) || steps[steps.length - 1];

    let html = '';
    const first = Math.ceil(view.start / step) * step;
    for (let t = first; t <= view.start + view.span + 1e-9; t += step) {
        const x = timeToX(t);
        if (x < -2 || x > w) continue;
        html += `<div class="tick" style="left:${x.toFixed(1)}px">` +
                `${rulerLabel(t, view.span)}</div>`;
    }
    ruler.innerHTML = html;
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
    clampView();
    drawRuler();
    drawVideoLane();
    drawAudioLane();
    drawScrollbar();
}

export function setPlayhead(t) {
    if (!playhead) return;
    const x = timeToX(t);
    const w = laneWidth();
    // Off-window, park it just outside rather than letting it sit on an edge
    // pretending to be at a time it is not.
    const visible = x >= -1 && x <= w + 1;
    playhead.style.display = visible ? 'block' : 'none';
    if (visible) playhead.style.left = (laneVideo.offsetLeft + x).toFixed(1) + 'px';
}

// ── input ──────────────────────────────────────────────────────────────────

// One helper for press-and-track: the pointer leaving the element mid-drag is
// normal, and losing the drag when it does is not.
function tracked(el, onDown, onMove, onUp) {
    let live = false;
    el.addEventListener('mousedown', (e) => {
        if (onDown(e) === false) return;
        live = true;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => { if (live) onMove(e); });
    document.addEventListener('mouseup', (e) => {
        if (!live) return;
        live = false;
        if (onUp) onUp(e);
    });
}

function localX(e, el) {
    const r = el.getBoundingClientRect();
    return e.clientX - r.left;
}

// Snap a dragged clip to the things an edit is usually trying to line up with:
// the start of the timeline, the playhead, and the other clips' edges.
function snapStart(clip, start, playheadTime) {
    const tolerance = (view.span / Math.max(1, laneWidth())) * 7;   // 7 px
    const targets = [0, playheadTime];
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

export function initTimeline(refs) {
    ruler = refs.ruler;
    film = refs.film;
    wave = refs.wave;
    laneVideo = refs.laneVideo;
    laneAudio = refs.laneAudio;
    playhead = refs.playhead;
    scrollTrack = refs.scrollTrack;
    scrollThumb = refs.scrollThumb;
    zoomLabel = refs.zoomLabel;
    onSeek = refs.onSeek || onSeek;

    const scrubOn = (el) => tracked(el,
        (e) => { onSeek(xToTime(localX(e, el)), true); },
        (e) => { onSeek(xToTime(localX(e, el)), false); },
        () => onSeek(undefined, false, true));

    scrubOn(ruler);
    scrubOn(laneAudio);

    // V1 is the one lane where a press might mean "move this", so it decides
    // between scrubbing and dragging by what is under the pointer.
    let drag = null;
    tracked(laneVideo,
        (e) => {
            const x = localX(e, laneVideo);
            const clip = clipAtX(x);
            // Pressing anywhere on V1 moves the playhead there — including on
            // a clip, so the picture and the inspector are about the thing you
            // just grabbed. Moving the pointer then drags the clip instead of
            // scrubbing on.
            onSeek(xToTime(x), true);
            drag = clip ? { clip, grabTime: xToTime(x), origin: clip.start, moved: false } : null;
        },
        (e) => {
            const x = localX(e, laneVideo);
            if (!drag) { onSeek(xToTime(x), false); return; }
            const delta = xToTime(x) - drag.grabTime;
            if (!drag.moved && Math.abs(delta) * (laneWidth() / view.span) < 3) return;
            drag.moved = true;
            moveClip(drag.clip, snapStart(drag.clip, drag.origin + delta, refs.playheadTime()));
            changed('move');
        },
        () => {
            if (drag && drag.moved) { resolveOverlaps(drag.clip); changed('moved'); }
            // Always release, even after a move: the press paused playback to
            // scrub, and only this puts it back.
            onSeek(undefined, false, true);
            drag = null;
        });

    // Wheel: zoom about the pointer, or pan with shift held. Zooming about the
    // pointer is the only version that lets you dive into a specific moment
    // instead of steering the window back after every notch.
    for (const el of [refs.timeline]) {
        el.addEventListener('wheel', (e) => {
            const x = localX(e, film);
            if (e.shiftKey) panBy((e.deltaY > 0 ? 0.2 : -0.2) * view.span);
            else zoomBy(e.deltaY > 0 ? 1.25 : 1 / 1.25, xToTime(x));
            e.preventDefault();
        });
    }

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
