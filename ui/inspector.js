// The right-hand panel, and the chips beside the filename.
//
// Two halves with different jobs. The Media half always describes exactly one
// file — the primary selection — because a codec list averaged over four clips
// would be nonsense. The Properties half edits all of them at once, which is
// where the care goes: a field whose selection disagrees shows blank rather
// than one clip's value, because an inherited number that silently applies to
// three other clips the moment you tab past it is the classic multi-select
// trap.
//
// The panel is rebuilt from the model rather than kept in sync field by field.
// It is a dozen controls, and a panel that can disagree with the picture is
// worse than one that is redrawn.

import { project } from './project.js';
import { el, div, span, put } from './dom.js';
import { clock, bytes, kbps } from './format.js';

let panel = {};
let hooks = {};

export function initInspector(refs, h) {
    panel = refs;
    hooks = h || {};
}

// ── what is selected ───────────────────────────────────────────────────────

/// Every clip an edit applies to: the whole selection, or the primary alone if
/// somehow nothing is selected. Exported because dragging the picture is an
/// edit to the same set, and there should be one answer to what "the same set"
/// means.
export function subjects() {
    return project.selection.length ? project.selection
         : project.selected ? [project.selected] : [];
}

/// Read a property across the selection. Returns the value when they agree and
/// `undefined` when they do not — which is what a field showing "—" means, and
/// what stops a panel from quietly claiming four clips are all at 100%.
function common(read) {
    const list = subjects();
    if (!list.length) return undefined;
    const first = read(list[0]);
    for (const c of list) if (read(c) !== first) return undefined;
    return first;
}

/// Write a property to every selected clip and put the picture back in step.
function edit(write) {
    for (const c of subjects()) write(c);
    hooks.edited();
}

// ── the whole panel ────────────────────────────────────────────────────────

export function showProperties() {
    const clip = project.selected;
    if (!clip) {
        panel.filename.textContent = 'no media';
        panel.filename.classList.add('dim');
        put(panel.chips, () => []);
        put(panel.media, () => 'Nothing loaded.');
        panel.media.classList.add('dim', 'pad');
        put(panel.transform, () => []);
        return;
    }
    panel.filename.textContent = clip.name;
    panel.filename.classList.remove('dim');
    showChips(clip.probe);
    showInfo(clip.probe);
    showTransform(clip);
}

// ── the chips, in the title bar ────────────────────────────────────────────

function showChips(p) {
    const chip = (text, hot) => span(String(text), 'chip' + (hot ? ' hot' : ''));
    put(panel.chips, () => [
        chip(p.format.name.split(',')[0], true),
        p.video && chip(`${p.video.displayWidth}×${p.video.displayHeight}`),
        p.video && chip(p.video.codec),
        p.video && p.video.fps && chip(p.video.fps.toFixed(3) + ' fps'),
        p.audio && chip(`${p.audio.codec} ${p.audio.channels}ch`),
    ]);
}

// ── what is in the file ────────────────────────────────────────────────────

const head = (text) => div('section-head', text);

function row(key, value) {
    return div('row', [span(key, 'key'), span(String(value), 'val')]);
}

function showInfo(p) {
    panel.media.classList.remove('dim', 'pad');
    put(panel.media, () => [
        head('Container'),
        row('Format', p.format.longName || p.format.name),
        row('Duration', clock(p.format.duration)),
        row('Size', bytes(p.format.size)),
        row('Bitrate', p.format.bitRate ? kbps(p.format.bitRate) : '—'),
        row('Streams', String(p.streams.length)),
        ...p.streams.map(streamRows),
    ]);
}

function streamRows(s) {
    const rows = [
        head(`${s.kind} #${s.index}` + (s.language ? ` · ${s.language}` : '')),
        row('Codec', s.codecLong || s.codec),
        s.profile && row('Profile', s.profile),
        s.duration && row('Duration', s.duration.toFixed(3) + ' s'),
    ];
    if (s.kind === 'video') {
        rows.push(row('Size', `${s.width}×${s.height}` +
            (s.rotation ? ` → ${s.displayWidth}×${s.displayHeight} (${s.rotation}°)` : '')));
        rows.push(row('Frame rate', s.fps ? s.fps.toFixed(3) + ' fps' : '—'));
        rows.push(row('Pixels', s.pixFmt || '—'));
        if (s.sampleAspect && Math.abs(s.sampleAspect - 1) > 0.001)
            rows.push(row('Pixel AR', s.sampleAspect.toFixed(4)));
    } else if (s.kind === 'audio') {
        rows.push(row('Rate', s.sampleRate + ' Hz'));
        rows.push(row('Channels', `${s.channels} (${s.channelLayout || 'unknown'})`));
        rows.push(row('Samples', s.sampleFmt || '—'));
    }
    if (s.bitRate) rows.push(row('Bitrate', kbps(s.bitRate)));
    if (s.title) rows.push(row('Title', s.title));
    return rows;
}

// ── the transform panel ────────────────────────────────────────────────────

export function showTransform(clip) {
    if (!clip) return put(panel.transform, () => []);
    const list = subjects();
    const many = list.length > 1;
    const gridOn = project.layout === 'grid';
    const again = () => showTransform(clip);

    put(panel.transform, () => [
        head('Canvas'),
        controlRow('Size', canvasSize()),
        controlRow('Preset', evenButtons([
            ['Match clip', () => resizeCanvas(clip.width, clip.height, again)],
            ['1080p', () => resizeCanvas(1920, 1080, again)],
        ])),
        controlRow('', evenButtons([
            ['Vertical', () => resizeCanvas(1080, 1920, again)],
            ['4K', () => resizeCanvas(3840, 2160, again)],
        ])),
        controlRow('Layout', div('seg', [
            toggleButton('Stack', !gridOn, () => hooks.setLayout('stack')),
            toggleButton('Grid', gridOn, () => hooks.setLayout('grid')),
        ])),

        head(many ? `Properties · ${list.length} clips` : `Properties · ${clip.name}`),
        controlRow('Track', div('btns', [
            el('button', { cls: 'tiny', text: 'Down', 'data-track': -1,
                           on: { click: () => nudgeTrack(-1) } }),
            el('button', { cls: 'tiny', text: 'Up', 'data-track': 1,
                           on: { click: () => nudgeTrack(1) } }),
            span(common((k) => k.track) === undefined ? 'mixed' : 'V' + (clip.track + 1), 'mono dim'),
        ])),
        controlRow('Opacity', percentSlider('opacity',
            common((k) => k.xform.opacity),
            (f) => { for (const k of subjects()) k.xform.opacity = f; })),
        controlRow('Audio', div('btns', [
            toggleButton('Mute', common((k) => k.muted) === true, () => {
                const on = !(common((k) => k.muted) === true);
                for (const k of subjects()) k.muted = on;
                hooks.audioChanged();
                again();
            }, 'data-mute'),
            slider('clipvol', Math.round((common((k) => k.volume) ?? 1) * 100), (f) => {
                for (const k of subjects()) { k.volume = f; if (f > 0) k.muted = false; }
                hooks.audioChanged();
            }),
        ])),

        head(gridOn ? 'Transform (grid: cell-relative)' : 'Transform'),
        controlRow('Fit', div('seg', ['contain', 'cover', 'stretch', 'actual'].map((id, i) =>
            el('button', {
                cls: 'tiny' + (common((k) => k.xform.fit) === id ? ' on' : ''),
                text: ['Fit', 'Fill', 'Stretch', '1:1'][i],
                'data-fit': id,
                on: { click: () => { edit((k) => { k.xform.fit = id; }); again(); } },
            })))),
        controlRow('Scale', percentSlider('zoom', common((k) => k.xform.zoom),
            (f) => { for (const k of subjects()) k.xform.zoom = Math.max(0.05, f); },
            5, 400)),
        controlRow('Position', div('btns', [
            span(many ? '—' : `${pc(clip.xform.panX)}%, ${pc(clip.xform.panY)}%`, 'mono dim'),
            el('button', { cls: 'tiny', text: 'Reset', 'data-reset': 'pan',
                           on: { click: () => {
                               edit((k) => { k.xform.panX = k.xform.panY = 0; k.xform.zoom = 1; });
                               again();
                           } } }),
        ])),

        head('Crop'),
        controlRow('Left / Top', div('btns', [cropField('l'), cropField('t')])),
        controlRow('Right / Bot', div('btns', [cropField('r'), cropField('b')])),
        controlRow('', div('btns', [
            toggleButton('Handles (C)', hooks.cropHandlesOn(), () => hooks.toggleCropHandles(),
                         'data-crop'),
            el('button', { cls: 'tiny', text: 'Reset', 'data-reset': 'crop',
                           on: { click: () => {
                               edit((k) => { k.xform.crop = { l: 0, t: 0, r: 0, b: 0 }; });
                               again();
                           } } }),
        ])),
    ]);
}

const pc = (v) => (v * 100).toFixed(1);

function controlRow(key, control) {
    return div('row', [span(key, 'key'), control]);
}

/// A cluster whose buttons share the row evenly. `.val` as well, because it is
/// still the right-hand half of a labelled row.
const evenButtons = (pairs) => div('val btns even', pairs.map(([label, onClick]) =>
    el('button', { cls: 'tiny', text: label, 'data-canvas': label, on: { click: onClick } })));

function toggleButton(label, on, onClick, hook) {
    const opts = { cls: 'tiny' + (on ? ' on' : ''), text: label, on: { click: onClick } };
    if (hook) opts[hook] = '1';
    return el('button', opts);
}

function canvasSize() {
    const w = sizeField(project.width);
    const h = sizeField(project.height);
    const apply = () => {
        const nw = Number(w.value), nh = Number(h.value);
        if (nw >= 16 && nh >= 16) {
            project.width = nw; project.height = nh;
            hooks.canvasResized();
        }
    };
    w.addEventListener('change', apply);
    h.addEventListener('change', apply);
    return div('val btns', [w, span('×', 'dim'), h]);
}

const sizeField = (value) =>
    el('input', { cls: 'num', type: 'number', value, min: 16, max: 16384 });

function resizeCanvas(w, h, again) {
    project.width = w;
    project.height = h;
    hooks.canvasResized();
    again();
}

function nudgeTrack(d) {
    edit((k) => { k.track = Math.max(0, Math.min(7, k.track + d)); });
    hooks.moved();
}

/// Sliders write on every input event, so they only ever update their own
/// readout: rebuilding the panel mid-drag would replace the slider under the
/// pointer and the drag would end there.
function slider(name, value, apply) {
    const node = el('input', { type: 'range', min: 0, max: 100, value, 'data-s': name });
    node.addEventListener('input', () => {
        apply(Number(node.value) / 100);
        hooks.redraw();
    });
    return node;
}

function percentSlider(name, value, apply, min = 0, max = 100) {
    const mixed = value === undefined;
    const readout = span(mixed ? '—' : `${Math.round(value * 100)}%`, 'mono dim');
    const node = el('input', { type: 'range', min, max,
                               value: Math.round((mixed ? 1 : value) * 100), 'data-s': name });
    node.addEventListener('input', () => {
        const f = Number(node.value) / 100;
        apply(f);
        readout.textContent = `${Math.round(f * 100)}%`;
        hooks.redraw();
    });
    return div('btns', [node, readout]);
}

/// A crop edge, in per cent. Blank when the selection disagrees — and a blank
/// left blank changes nothing, which is the point.
function cropField(edge) {
    const v = common((k) => +pc(k.xform.crop[edge]));
    const node = el('input', {
        cls: 'num' + (v === undefined ? ' mixed' : ''), type: 'number',
        value: v === undefined ? '' : v, min: 0, max: 95, step: 0.5, placeholder: '—',
        'data-crop-edge': edge,
    });
    node.addEventListener('change', () => {
        if (node.value === '') return;              // still mixed, left alone
        const f = Math.max(0, Math.min(0.95, Number(node.value) / 100));
        edit((k) => { k.xform.crop[edge] = f; });
    });
    return node;
}
