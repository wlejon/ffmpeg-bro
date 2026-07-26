// The timeline, small, with the part being written picked out.
//
// Dragging the ends sets the in and out points; dragging the lane underneath
// moves where the preview samples from, which is nearly always the thing you
// actually want to look at.
//
// The markup is in index.html and never rebuilt — a canvas cannot measure
// itself in the turn it was created in, so a repaint that recreated its own
// element would measure an unlaid-out canvas every time, fall back to a
// default width forever, and be stretched across the window.

import { project, duration } from '../project.js';
import { byId, put, span, show } from '../dom.js';
import { clock } from '../format.js';
import { settings } from './state.js';
import { range } from './spec.js';

const RULER = 13;                 // ticks along the top
const LANE = 12;                  // where the preview samples from, along the bottom

let hooks = {};
let canvas = null;
let nums = null;
let marker = null;
let laneTop = 0.8;                // where the preview lane starts, as a fraction
let drag = null;

export function initStrip(refs, h) {
    hooks = h || {};
    canvas = refs.canvas;
    nums = refs.nums;
    marker = refs.marker;
    canvas.addEventListener('mousedown', press);
    refs.all.addEventListener('click', () => {
        settings.rangeIn = 0;
        settings.rangeOut = 0;
        hooks.changed();
    });
}

/// Where the preview has got to, in timeline seconds. Its own element over the
/// canvas, so following playback costs a style write rather than a repaint of
/// something as wide as the window.
export function markPreviewAt(t) {
    if (!marker) return;
    const total = Math.max(0.001, duration());
    marker.style.left = `${((t / total) * 100).toFixed(3)}%`;
    show(marker, true);
}

export function drawStrip() {
    const r = range();
    put(nums, () => [span('in', 'dim'), ` ${clock(r.start)}  `,
               span('out', 'dim'), ` ${clock(r.end)}  `,
               span('·', 'dim'), ` ${clock(r.length)}`]);
    paintStrip();
}

export function paintStrip() {
    if (!canvas) return;
    const total = Math.max(0.001, duration());
    const r = range();

    // Sized from the element, not from a number here: it is as wide as the
    // window, and a canvas drawn at one size and stretched to another is a
    // blurred one.
    const box = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(box.width || 420));
    const h = Math.max(30, Math.round(box.height || 62));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bodyTop = RULER, bodyBot = h - LANE;
    laneTop = bodyBot / h;
    const x = (t) => (t / total) * w;

    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);

    // A ruler, because the strip is wide enough to read one off. The step is
    // the first round number that leaves the labels a clear 70 px apart, so it
    // stays legible from a two-second edit to a two-hour one.
    const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const wanted = (70 / w) * total;
    const step = STEPS.find((s) => s >= wanted) || Math.ceil(wanted / 3600) * 3600;
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= total; t += step) {
        ctx.fillStyle = '#2f3540';
        ctx.fillRect(Math.round(x(t)), 0, 1, RULER);
        ctx.fillStyle = '#6c7482';
        ctx.fillText(clock(t), Math.round(x(t)) + 3, 1);
    }

    // One row per track, bottom track at the bottom, so the strip reads the
    // same way round as the timeline it is standing in for. Capped as well as
    // divided: one track left to itself would fill the band with a slab, and a
    // clip reads as a clip when it is a bar on a lane.
    const tracks = new Set();
    for (const c of project.clips) tracks.add(c.track);
    const list = Array.from(tracks).sort((a, b) => a - b);
    const rowH = Math.max(4, Math.min(16,
        Math.floor((bodyBot - bodyTop - 2) / Math.max(1, list.length))));

    for (const c of project.clips) {
        const i = list.indexOf(c.track);
        ctx.fillStyle = '#3a4a5a';
        ctx.fillRect(x(c.start), bodyBot - (i + 1) * rowH, Math.max(1, x(c.length)), rowH - 1);
    }

    // Outside the range, dimmed; inside, left alone.
    ctx.fillStyle = 'rgba(10,10,10,0.72)';
    ctx.fillRect(0, bodyTop, x(r.start), bodyBot - bodyTop);
    ctx.fillRect(x(r.end), bodyTop, w - x(r.end), bodyBot - bodyTop);

    ctx.strokeStyle = '#ff8c42';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(r.start) + 1, bodyTop); ctx.lineTo(x(r.start) + 1, bodyBot);
    ctx.moveTo(x(r.end) - 1, bodyTop);   ctx.lineTo(x(r.end) - 1, bodyBot);
    ctx.stroke();

    // Where the preview samples from, and how much of it.
    const pr = hooks.previewRange();
    ctx.fillStyle = 'rgba(120, 200, 255, 0.35)';
    ctx.fillRect(x(pr.start), bodyBot, Math.max(2, x(pr.end - pr.start)), LANE);
    ctx.strokeStyle = '#78c8ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(pr.start) + 0.5, bodyBot); ctx.lineTo(x(pr.start) + 0.5, h);
    ctx.stroke();
}

/// The strip is as wide as the window, and the window is entitled to change
/// size. Called once a frame; a repaint only happens when the size moved.
export function refitStrip() {
    if (!canvas) return;
    const w = Math.round(canvas.getBoundingClientRect().width);
    if (w > 0 && w !== canvas.width) paintStrip();
}

/// Which of the three things under the pointer is being dragged.
function press(e) {
    const total = Math.max(0.001, duration());
    const r = range();
    const box = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(total, ((e.clientX - box.left) / Math.max(1, box.width)) * total));
    // In pixels, not in a fraction of the timeline: a tenth of an hour is an
    // enormous grab radius and a tenth of two seconds is an invisible one, and
    // what the hand is aiming at is a line on the screen.
    const grab = (10 / Math.max(1, box.width)) * total;
    const inPreviewLane = (e.clientY - box.top) > laneTop * box.height;
    drag = inPreviewLane ? 'preview'
         : Math.abs(t - r.start) < grab ? 'in'
         : Math.abs(t - r.end) < grab ? 'out' : 'preview';
    move(e);

    const up = () => {
        drag = null;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        hooks.changed();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function move(e) {
    if (!drag) return;
    const total = Math.max(0.001, duration());
    const box = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(total, ((e.clientX - box.left) / Math.max(1, box.width)) * total));

    if (drag === 'in') {
        const out = settings.rangeOut > 0 ? settings.rangeOut : total;
        settings.rangeIn = Math.min(t, out - 0.1);
    } else if (drag === 'out') {
        settings.rangeOut = Math.max(t, settings.rangeIn + 0.1);
    } else {
        hooks.movePreviewTo(Math.min(t, Math.max(0, total - 0.2)));
    }
    drawStrip();
    hooks.tweaked();
}

export function stripCanvas() { return canvas; }
