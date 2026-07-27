// What a render is doing, while it does it.
//
// Three states with three different things worth saying. A finished render
// offers to put the result back on the timeline, which is the fastest way to
// see what you just made; a stopped one says what it managed to write and that
// the part it got to is playable, because a cancelled render here still lays
// down its trailer.

import { el, div, put, fromTemplate } from '../dom.js';
import { bytes, elapsed, basename } from '../format.js';
import { verdict, openReport } from '../report.js';

let pane = null;
let hooks = {};

export function initProgress(node, h) {
    pane = node;
    hooks = h || {};
}

export function drawProgress(p) {
    const pct = Math.round((p.progress || 0) * 100);
    if (p.state === 'running') return put(pane, () => running(p, pct));
    if (p.state === 'done') return put(pane, () => done(p));
    return put(pane, () => stopped(p, pct));
}

/// The bar, at a percentage and optionally in another colour.
function bar(pct, cls) {
    const node = fromTemplate('tpl-bar');
    const fill = node.querySelector('.ex-fill');
    fill.style.width = `${pct}%`;
    if (cls) fill.classList.add(cls);
    return node;
}

const line = (text, cls = '') => div(`ex-line ${cls}`.trim(), text);

/// What libav had to say about this render, where somebody is already looking.
///
/// A render can succeed and still have been told something worth knowing — a
/// profile the encoder refused, a bitrate it clamped, a tag the muxer would not
/// take. A green bar over a file that is not what was asked for is the failure
/// this whole channel exists to prevent, so the count is stated here and the
/// way to read it is one click. Absent entirely when there is nothing to say:
/// a panel that always carries a "0 warnings" line teaches people to skip the
/// place the real one will appear.
function said() {
    const v = verdict();
    if (!v.errors && !v.warnings) return null;
    const bits = [];
    if (v.errors) bits.push(`${v.errors} error${v.errors === 1 ? '' : 's'}`);
    if (v.warnings) bits.push(`${v.warnings} warning${v.warnings === 1 ? '' : 's'}`);
    return div('ex-line', [
        el('button', {
            cls: 'tiny', 'data-f': 'report',
            text: `${bits.join(' and ')} — what the render said`,
            on: { click: openReport },
        }),
    ]);
}

function running(p, pct) {
    const left = p.fps > 0 && p.totalFrames
        ? Math.max(0, (p.totalFrames - p.frames) / p.fps) : 0;
    return [
        bar(pct),
        line(`${pct}% · frame ${p.frames} of ${p.totalFrames}`, 'mono'),
        line(`${p.fps.toFixed(1)} fps · ${elapsed(p.elapsed)} so far` +
             (left > 0.5 ? ` · about ${elapsed(left)} left` : '') +
             ` · ${bytes(p.bytes)}`, 'mono dim'),
        line(p.path, 'dim'),
    ];
}

function done(p) {
    return [
        bar(100, 'done'),
        line(`Wrote ${basename(p.path)}`, 'good'),
        line(`${p.frames} frames · ${bytes(p.bytes)} · ` +
             `${elapsed(p.elapsed)} at ${p.fps.toFixed(1)} fps`, 'mono dim'),
        line(p.path, 'dim'),
        said(),
        div('ex-line', [
            el('button', { cls: 'tiny', 'data-f': 'import', text: 'Add it to the timeline',
                           on: { click: () => hooks.addToTimeline(p.path) } }),
            el('button', { cls: 'tiny', 'data-f': 'back', text: 'Back to settings',
                           on: { click: hooks.back } }),
        ]),
    ];
}

function stopped(p, pct) {
    const cancelled = p.state === 'cancelled';
    return [
        bar(pct, 'stopped'),
        line((cancelled ? 'Stopped' : 'Export failed') + (p.error ? `: ${p.error}` : ''),
             cancelled ? 'dim' : 'ex-failed'),
        cancelled ? line(`${p.frames} of ${p.totalFrames} frames were written, and the ` +
                         `part it got to is playable`, 'mono dim') : null,
        cancelled ? line(p.path, 'dim') : null,
        said(),
        div('ex-line', el('button', { cls: 'tiny', 'data-f': 'back', text: 'Back to settings',
                                      on: { click: hooks.back } })),
    ];
}
