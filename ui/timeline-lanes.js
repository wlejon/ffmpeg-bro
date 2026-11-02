// Marks lane (`bro.ffmpeg.marks`) and Telemetry Data lane (`bro.ffmpeg.data`)
// for `ui/timeline.js`.
//
// Extracted into a dedicated module to keep `ui/timeline.js` and
// `ui/timeline-draw.js` strictly under 1,000 lines.

import { project, sourceTime } from './project.js';
import { el } from './dom.js';
import { telemetryRows, bucketAt, shortLabelOf } from './telemetry.js';
import { markRows, MARK_COLORS, MARK_WORDS } from './marks.js';

// The Telemetry lane: one 10px label with a 14px plot under it.
const TEL_ROW = 26;
const TEL_BUDGET = 84;
const TEL_FLOOR = 12;

// The Marks lane is one row and a fixed height: every mark in the edit is on one
// row, told apart by colour, because what you do with one is jump or snap to it.
const MARK_LANE_H = 14;

let ctxRef = null;
export function bindTimelineLanesContext(c) { ctxRef = c; }

function laneContext(canvas) {
    const box = canvas.parentNode;
    const w = (box ? box.clientWidth : 0) | 0;
    const h = (box ? box.clientHeight : 0) | 0;
    if (w <= 0 || h <= 0) return null;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

// ── the Marks lane ─────────────────────────────────────────────────────────
//
// Where something happens in the sound, drawn against the same ruler as
// everything else. Every mark in the edit sits on one row, told apart by
// colour, and `,` / `.` walk every mark in the edit in time order whatever kind
// it is. Clips and cuts on the timeline also snap to marks within the 7px snap
// tolerance.

let markRow = null;
let markList = [];
let markStack = 0;

export function markStackOf() { return markStack; }

export function syncMarksLane() {
    const tracksEl = ctxRef.tracksEl();
    const playhead = ctxRef.playhead();
    markList = markRows(project.clips);
    if (!markList.length) {
        if (markRow && markRow.row.parentNode === tracksEl) {
            tracksEl.removeChild(markRow.row);
        }
        markRow = null;
        markStack = 0;
        return;
    }
    if (!markRow) {
        const row = el('div', { cls: 'track-row mark-row' });
        // The kinds are described out of `MARK_WORDS`, never written out here.
        const head = el('div', { cls: 'track-head tiny',
            title: 'Where something happens in the sound, found by bro\'s acoustic ' +
                   'sensors. None of them is a classification: nothing here ' +
                   'decided what made a sound.\n' +
                   Object.keys(MARK_COLORS)
                         .map((k) => `${k}: ${MARK_WORDS[k]}`).join('\n') +
                   '\n"," and "." jump between them.' },
            [el('span', { cls: 'track-name', text: 'Marks' })]);
        const lane = el('div', { cls: 'track-lane', id: 'lane-marks' });
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        tracksEl.appendChild(row);
        tracksEl.appendChild(playhead);
        markRow = { row, lane, canvas };
        ctxRef.scrubOn(lane);
        ctxRef.markRebuilt();
    }
    markRow.lane.style.height = MARK_LANE_H + 'px';
    markRow.row.style.height = MARK_LANE_H + 'px';
    markStack = 4 + MARK_LANE_H;
}

export function drawMarksLane() {
    if (!markRow) return;
    const c = laneContext(markRow.canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const { timeToX } = ctxRef;

    for (const m of markList) {
        const x = timeToX(m.at);
        if (x < -4 || x > w + 4) continue;
        const color = MARK_COLORS[m.kind] || '#9aa3ad';
        if (m.end > m.at) {
            const r = Math.min(w, timeToX(m.end));
            if (r > x) {
                ctx.globalAlpha = 0.25;
                ctx.fillStyle = color;
                ctx.fillRect(x, h - 4, Math.max(1, r - x), 3);
                ctx.globalAlpha = 1;
            }
        }
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x), 1, 1, h - 6);
    }
}

export function marksLane() {
    return { lane: markRow ? markRow.lane : null, rows: markList };
}

// ── the Telemetry lane ─────────────────────────────────────────────────────
//
// One row per series somebody picked off a data stream (`ui/telemetry.js`),
// drawn against the same ruler as everything else.

let telRow = null;
let telList = [];
let telRowH = 0;
let telStack = 0;

export function telStackOf() { return telStack; }

export function syncTelemetryLane() {
    const tracksEl = ctxRef.tracksEl();
    const playhead = ctxRef.playhead();
    telList = telemetryRows();
    const want = telList.length;
    if (!want) {
        if (telRow && telRow.row.parentNode === tracksEl) {
            tracksEl.removeChild(telRow.row);
        }
        telRow = null;
        telRowH = 0;
        telStack = 0;
        return;
    }
    if (!telRow) {
        const row = el('div', { cls: 'track-row tel-row' });
        const head = el('div', { cls: 'track-head',
            title: 'Numbers read out of a data track - one row per series, drawn ' +
                   'where the clip it came out of is. The band is the reach of ' +
                   'every sample under that pixel and the line is their mean. ' +
                   'Pick series on the Sources stage.' },
            [el('span', { cls: 'track-name', text: 'Data' })]);
        const lane = el('div', { cls: 'track-lane', id: 'lane-telemetry' });
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        tracksEl.appendChild(row);
        tracksEl.appendChild(playhead);
        telRow = { row, head, lane, canvas };
        ctxRef.scrubOn(lane);
        ctxRef.markRebuilt();
    }
    if (telRow.row.nextSibling !== playhead) {
        tracksEl.appendChild(telRow.row);
        tracksEl.appendChild(playhead);
    }
    const pitch = Math.max(TEL_FLOOR, Math.min(TEL_ROW, Math.floor(TEL_BUDGET / want)));
    const h = want * pitch + 2;
    telRow.lane.style.height = h + 'px';
    telRow.row.style.height = h + 'px';
    telRow.head.classList.toggle('tiny', pitch < 22);
    telStack = 4 + h;
}

function telScale(s) {
    let lo = s.min, hi = s.max;
    if (!(hi > lo)) {
        const pad = Math.max(1e-6, Math.abs(hi) * 0.1 || 1);
        lo -= pad; hi += pad;
    }
    return { lo, hi };
}

export function drawTelemetryLane() {
    if (!telRow) return;
    const c = laneContext(telRow.canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const { timeToX } = ctxRef;
    const rh = telRowH = h / Math.max(1, telList.length);

    telList.forEach((row, i) => {
        const top = i * rh;
        if (i % 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            ctx.fillRect(0, top, w, rh);
        }

        const { lo, hi } = telScale(row.series);
        const plotTop = top + (rh >= 20 ? 11 : 2);
        const plotH = Math.max(2, top + rh - 2 - plotTop);
        const Y = (v) => plotTop + plotH - ((v - lo) / (hi - lo)) * plotH;

        if (rh >= 20) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = row.color;
            const name = shortLabelOf(row.series);
            ctx.fillText(name, 4, top + 9);
            ctx.fillStyle = '#7c838f';
            const reach = fmtValue(row.series.min) + '..' + fmtValue(row.series.max) +
                          (row.units ? ' ' + row.units : '');
            ctx.fillText(reach, 4 + ctx.measureText(name).width + 6, top + 9);
        }

        for (const clip of project.clips) {
            if (!clip.input || clip.input.id !== row.inputId) continue;
            const l = Math.max(0, Math.floor(timeToX(clip.start)));
            const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
            if (r <= l) continue;
            drawSeriesOver(ctx, row, l, r, clip, Y);
        }
    });
}

function drawSeriesOver(ctx, row, l, r, clip, Y) {
    const series = row.series, reading = row.reading;
    const { xToTime } = ctxRef;
    const bAt = (x) => bucketAt(reading, sourceTime(clip, xToTime(x)));

    ctx.fillStyle = row.color;
    ctx.globalAlpha = 0.22;
    for (let x = l; x < r; x++) {
        const b0 = bAt(x);
        if (b0 < 0) continue;
        const next = bAt(x + 1);
        const b1 = Math.max(b0 + 1, next < 0 ? b0 + 1 : next);
        let a = Infinity, b2 = -Infinity;
        for (let b = b0; b < b1 && b < reading.buckets; b++) {
            if (!series.filled[b]) continue;
            if (series.lo[b] < a) a = series.lo[b];
            if (series.hi[b] > b2) b2 = series.hi[b];
        }
        if (!(b2 >= a)) continue;
        const yTop = Y(b2), yBot = Y(a);
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = row.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let open = false;
    for (let x = l; x < r; x++) {
        const b0 = bAt(x);
        if (b0 < 0) { open = false; continue; }
        const next = bAt(x + 1);
        const b1 = Math.max(b0 + 1, next < 0 ? b0 + 1 : next);
        let sum = 0, n = 0;
        for (let b = b0; b < b1 && b < reading.buckets; b++) {
            if (!series.filled[b]) continue;
            sum += series.mean[b];
            n++;
        }
        if (!n) { open = false; continue; }
        const y = Y(sum / n) + 0.5;
        if (open) ctx.lineTo(x + 0.5, y);
        else { ctx.moveTo(x + 0.5, y); open = true; }
    }
    ctx.stroke();
}

function fmtValue(v) {
    if (!Number.isFinite(v)) return '--';
    const a = Math.abs(v);
    if (a >= 10000) return v.toExponential(1);
    if (a >= 100) return String(Math.round(v));
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

export function telemetryLane() {
    return { lane: telRow ? telRow.lane : null, rows: telList, rowHeight: telRowH };
}
