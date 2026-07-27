// The settings column, and the column of everything else.
//
// The form is drawn from what the encoder reports, so it changes shape per
// codec: x264 gets a CRF slider from 0 to 51 and ten presets, VP9's goes to
// 63, ProRes gets its six profiles and no quality slider at all. Nothing here
// decides what an encoder is like — capabilities.js asks libavcodec and this
// draws the answer.
//
// Every control carries its own listener, made at the same moment the control
// is. There is no second pass that finds elements again by id and attaches
// behaviour to them: that pass could always be one control behind the markup,
// and was — a segment that moved to the advanced column quietly stopped doing
// anything, because the code that wired it looked only in the left one.

import { project } from '../project.js';
import { el, div, span, put, select, segmented, show, fromTemplate,
         row, head } from '../dom.js';
import { basename } from '../format.js';
import { btns, num, note } from './controls.js';
import { settings, activeVideoCodec } from './state.js';
import { videoEncoders, audioEncoders, containers, encoderInfo, audioInfo,
         containerInfo, optionsOf, rateModes, qualityRange } from './capabilities.js';
import { defaultPath, withExtension } from './spec.js';

let panes = {};
let hooks = {};

let showAdvanced = false;
let optionSearch = '';

// Held between draws so the parts that update on their own — the quality
// readout as the slider moves, the filename beside "Choose…" — can be written
// without rebuilding the form under the pointer.
let qualityLabel = null;
let fileLabel = null;
let optionList = null;

export function initForm(refs, h) {
    panes = refs;
    hooks = h || {};
}

const RATE_LABELS = {
    quality: 'Quality', bitrate: 'Bitrate', constrained: 'Capped', lossless: 'Lossless',
};
const RATE_HINTS = {
    quality: 'Constant quality: the bitrate lands wherever it needs to',
    bitrate: 'A target the encoder averages out to',
    constrained: 'An average with a ceiling, for streaming',
    lossless: 'Nothing thrown away',
};

export function drawForm() {
    const codec = activeVideoCodec();
    const info = encoderInfo(codec) || { presets: [], tunes: [], profiles: [], pixelFormats: [] };
    const cont = containerInfo(settings.container) || { videoCodecs: [], audioCodecs: [] };

    // Where it goes belongs to the Write stage, not to this one. Encode is
    // about what the picture is put through, and a filename at the top of that
    // column was the first thing asked for and the last thing decided.
    put(panes.dest, () => [head('Destination'), ...outputRows()]);

    put(panes.settings, () => [
        head('Video'),
        ...videoRows(codec, info, cont),
        head('Audio'),
        ...audioRows(cont),
        head(`${showAdvanced ? '▾' : '▸'} Advanced`, {
            'data-f': 'advanced',
            cls: 'section-head ex-toggle',
            on: { click: () => { showAdvanced = !showAdvanced; drawForm(); } },
        }),
    ]);

    // The advanced block is a column of its own rather than a fold at the
    // bottom of this one. There are eighty options for x265; reading them
    // through a slot under twenty other controls is not reading them, and
    // scrolling away from the codec to reach them is worse.
    show(panes.advanced, showAdvanced);
    put(panes.advanced, () => (showAdvanced ? advancedRows(codec) : []));
}

// ── output ─────────────────────────────────────────────────────────────────

function outputRows() {
    const path = el('input', {
        cls: 'wide', 'data-f': 'path', type: 'text', value: settings.path,
        on: { change: () => { settings.path = path.value.trim(); refreshFileLabel(); hooks.tweaked(); } },
    });

    fileLabel = span('', 'dim mono');
    fileLabel.classList.add('ex-dir');
    refreshFileLabel();

    return [
        row('File', path),
        row('', btns([
            el('button', { cls: 'tiny', 'data-f': 'browse', text: 'Choose…',
                           on: { click: () => browse(path) } }),
            fileLabel,
        ])),
        row('Format', select({
            'data-f': 'container',
            on: { change: (e) => pickContainer(e.target.value) },
        }, containers().map((c) => ({ id: c.ext, label: c.label })), settings.container)),
    ];
}

function browse(pathInput) {
    // Only ever from a click. These dialogs block the JS thread until they
    // are dismissed, so anything automatic — a headless run included — would
    // hang with no window to dismiss it at.
    if (typeof showSaveFileDialog !== 'function') return;
    const ext = settings.container;
    const chosen = showSaveFileDialog(`${ext.toUpperCase()}|${ext}`, settings.path || defaultPath());
    if (!chosen) return;
    settings.path = chosen;
    pathInput.value = chosen;
    refreshFileLabel();
    hooks.tweaked();
}

function pickContainer(ext) {
    settings.container = ext;
    const c = containerInfo(ext);
    // The codecs follow the container when the ones in hand will not fit: VP9
    // in an mp4 is legal but nothing plays it, and AAC in a WebM is not legal
    // at all.
    if (c) {
        if (c.videoCodecs.indexOf(settings.videoCodec) < 0) settings.videoCodec = c.videoCodec;
        if (c.audioCodecs.indexOf(settings.audioCodec) < 0) settings.audioCodec = c.audioCodec;
    }
    if (settings.path) settings.path = withExtension(settings.path, ext);
    hooks.changed();
}

function refreshFileLabel() {
    if (fileLabel) fileLabel.textContent = settings.path ? basename(settings.path) : 'no file chosen';
}

// ── video ──────────────────────────────────────────────────────────────────

function videoRows(codec, info, cont) {
    const rows = [];

    // Codecs the chosen container will actually hold come first; the rest are
    // still listed, because refusing to show them hides the reason the one you
    // wanted is missing.
    const label = (e, legal) =>
        e.label + (legal.indexOf(e.id) < 0 ? `  (not in ${settings.container})` : '');

    rows.push(row('Codec', select(
        { 'data-f': 'vcodec', on: { change: (e) => { settings.videoCodec = e.target.value; hooks.changed(); } } },
        videoEncoders().map((e) => ({ id: e.id, label: label(e, cont.videoCodecs) })),
        codec)));
    if (info.longName) rows.push(row('', note(info.longName)));

    rows.push(...rateRows(codec, info));

    if (info.presets && info.presets.length)
        rows.push(row('Speed', select({ 'data-f': 'preset', on: { change: set('preset') } },
                                       info.presets, settings.preset)));
    if (info.tunes && info.tunes.length)
        rows.push(row('Tune', select({ 'data-f': 'tune', on: { change: set('tune') } },
                                     [{ id: '', label: 'none' }, ...info.tunes], settings.tune)));
    if (info.profiles && info.profiles.length)
        rows.push(row('Profile', select({ 'data-f': 'profile', on: { change: set('profile') } },
                                        [{ id: '', label: 'auto' }, ...info.profiles], settings.profile)));
    if (info.pixelFormats && info.pixelFormats.length) {
        const preferred = info.pixelFormats.indexOf('yuv420p') >= 0 ? 'yuv420p' : info.pixelFormats[0];
        rows.push(row('Pixels', select({ 'data-f': 'pixfmt', on: { change: set('pixelFormat') } },
                                       [{ id: '', label: `auto (${preferred})` }, ...info.pixelFormats],
                                       settings.pixelFormat)));
    }

    rows.push(...sizeRows());

    rows.push(row('Frame rate', select(
        { 'data-f': 'fps', on: { change: (e) => { settings.fps = Number(e.target.value) || 0; hooks.changed(); } } },
        [{ id: 0, label: `Project (${(project.fps || 30).toFixed(3)})` },
         ...[23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map((f) => ({ id: f, label: String(f) }))],
        settings.fps)));

    return rows;
}

function rateRows(codec, info) {
    if (info.alwaysLossless)
        return [row('Rate', span('always lossless — there is nothing to choose', 'dim'))];

    const modes = rateModes(codec);
    const rows = [row('Rate', segmented('rate',
        modes.map((m) => ({ v: m, l: RATE_LABELS[m], title: RATE_HINTS[m] })),
        settings.rate,
        (v) => { settings.rate = v; hooks.changed(); }))];

    if (settings.rate === 'quality' && modes.indexOf('quality') >= 0) {
        const q = qualityRange(codec);
        qualityLabel = span('', 'mono dim');
        qualityLabel.id = 'ex-qval';
        const slider = el('input', {
            'data-f': 'quality', type: 'range', min: q.min, max: q.max, value: settings.quality,
            on: { input: () => {
                settings.quality = Number(slider.value);
                // Not a full redraw: dragging a slider that rebuilds the form
                // under the pointer loses the drag on the first move.
                refreshQualityLabel();
                hooks.tweaked();
            } },
        });
        rows.push(row('Quality', btns([slider, qualityLabel])));
        refreshQualityLabel();
    }
    if (settings.rate === 'bitrate' || settings.rate === 'constrained') {
        rows.push(row('Bitrate', num('vbitrate',
            { min: 1, max: 500000, step: 500, value: settings.videoBitrate,
              on: { change: number('videoBitrate', 1) } }, 'kbps')));
    }
    if (settings.rate === 'constrained') {
        rows.push(row('Ceiling', num('maxrate',
            { min: 0, max: 500000, step: 500,
              value: settings.maxrate || Math.round(settings.videoBitrate * 1.5),
              on: { change: number('maxrate', 0) } }, 'kbps')));
        rows.push(row('Buffer', num('bufsize',
            { min: 0, max: 500000, step: 500,
              value: settings.bufsize || settings.videoBitrate * 3,
              on: { change: number('bufsize', 0) } }, 'kbit')));
    }
    return rows;
}

function sizeRows() {
    const w = el('input', { cls: 'num', 'data-f': 'w', type: 'number', min: 16, max: 16384,
                            value: settings.width, on: { change: resize } });
    const h = el('input', { cls: 'num', 'data-f': 'h', type: 'number', min: 16, max: 16384,
                            value: settings.height, on: { change: resize } });
    function resize() {
        settings.width = Math.max(16, Number(w.value) || project.width);
        settings.height = Math.max(16, Number(h.value) || project.height);
        hooks.changed();
    }

    const preset = (label, apply) => el('button', {
        cls: 'tiny', text: label, 'data-size': label.toLowerCase(),
        on: { click: () => { apply(); hooks.changed(); } },
    });

    return [
        row('Size', btns([w, span('×', 'dim'), h])),
        row('', btns([
            preset('Canvas', () => { settings.width = project.width; settings.height = project.height; }),
            preset('4K', () => { settings.width = 3840; settings.height = 2160; }),
            preset('1080p', () => { settings.width = 1920; settings.height = 1080; }),
            preset('720p', () => { settings.width = 1280; settings.height = 720; }),
            preset('Half', () => { settings.width = even(project.width / 2);
                                   settings.height = even(project.height / 2); }),
        ], 'btns even')),
    ];
}

function even(n) { return Math.max(16, Math.round(n / 2) * 2); }

// ── audio ──────────────────────────────────────────────────────────────────

function audioRows(cont) {
    const rows = [row('Include', btns(el('button', {
        cls: 'tiny' + (settings.audio ? ' on' : ''), 'data-f': 'audio',
        text: settings.audio ? 'On' : 'Off',
        on: { click: () => { settings.audio = !settings.audio; hooks.changed(); } },
    })))];
    if (!settings.audio) return rows;

    const info = audioInfo(settings.audioCodec) || { sampleRates: [], channelCounts: [] };
    const label = (e) =>
        e.label + (cont.audioCodecs.indexOf(e.id) < 0 ? `  (not in ${settings.container})` : '');

    rows.push(row('Codec', select(
        { 'data-f': 'acodec', on: { change: (e) => { settings.audioCodec = e.target.value; hooks.changed(); } } },
        audioEncoders().map((e) => ({ id: e.id, label: label(e) })), settings.audioCodec)));

    if (!info.lossless)
        rows.push(row('Bitrate', btns([
            select({ 'data-f': 'abitrate', on: { change: number('audioCodecBitrate', 8) } },
                   [64, 96, 128, 160, 192, 256, 320, 448].map(String),
                   String(settings.audioCodecBitrate)),
            span('kbps', 'dim'),
        ])));
    if (info.sampleRates.length > 1)
        rows.push(row('Rate', btns([
            select({ 'data-f': 'arate', on: { change: number('sampleRate', 1) } },
                   info.sampleRates.map(String), String(settings.sampleRate)),
            span('Hz', 'dim'),
        ])));
    if (info.channelCounts.length > 1)
        rows.push(row('Channels', select(
            { 'data-f': 'ach', on: { change: number('channels', 1) } },
            info.channelCounts.map((n) => ({
                id: String(n),
                label: n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`,
            })), String(settings.channels))));
    return rows;
}

// ── advanced ───────────────────────────────────────────────────────────────

const SCALERS = ['bicubic', 'bilinear', 'lanczos', 'spline', 'area', 'gauss', 'neighbor'];
const COLOURS = [{ id: 'auto', label: 'auto (by height)' }, { id: 'bt709', label: 'BT.709 (HD)' },
                 { id: 'bt601', label: 'BT.601 (SD)' }, { id: 'bt2020', label: 'BT.2020 (wide)' }];

function advancedRows(codec) {
    const title = el('input', {
        cls: 'wide', 'data-f': 'title', type: 'text', value: settings.title,
        placeholder: 'written as metadata',
        on: { change: () => { settings.title = title.value; } },
    });

    return [
        head('Advanced'),
        row('Keyframes', num('gop', { min: 0, max: 60, step: 0.5, value: settings.gopSeconds,
                                         on: { change: number('gopSeconds', 0) } },
                             'seconds (0 = encoder default)')),
        row('B-frames', num('bf', { min: -1, max: 16, value: settings.bframes,
                                       on: { change: number('bframes', -1) } },
                            '-1 = leave alone')),
        row('Scaler', select({ 'data-f': 'scaler', on: { change: set('scaler') } },
                             SCALERS, settings.scaler)),
        row('Colour', select({ 'data-f': 'cspace', on: { change: set('colorspace') } },
                             COLOURS, settings.colorspace)),
        row('Range', segmented('crange', [{ v: 'tv', l: 'Limited' }, { v: 'pc', l: 'Full' }],
                               settings.colorRange,
                               (v) => { settings.colorRange = v; hooks.changed(); })),
        row('Faststart', btns(el('button', {
            cls: 'tiny' + (settings.faststart ? ' on' : ''), 'data-f': 'faststart',
            text: settings.faststart ? 'On' : 'Off',
            title: 'Move the index to the front of an mp4',
            on: { click: () => { settings.faststart = !settings.faststart; hooks.changed(); } },
        }))),
        row('Title', title),
        ...rawOptionRows(codec),
    ];
}

/// Every option the chosen encoder has, straight from its AVOption table.
///
/// This is the part that earns the column: libavcodec knows exactly what x265
/// will take, complete with types, ranges, defaults and help text, and none of
/// it has to be duplicated here to be offered.
function rawOptionRows(codec) {
    const all = optionsOf(codec);
    const search = el('input', {
        cls: 'wide', 'data-f': 'optsearch', type: 'text', value: optionSearch,
        placeholder: 'name or description',
        on: { input: () => {
            optionSearch = search.value;
            // Only the list is rebuilt, so the field being typed into is never
            // replaced and never loses the caret.
            put(optionList, () => optionRows(codec, all));
        } },
    });

    optionList = div('ex-opt-list');
    put(optionList, () => optionRows(codec, all));

    return [
        head(`${codec} options · ${all.length}`),
        row('Find', search),
        optionList,
    ];
}

const OPTION_LIMIT = 40;

function optionRows(codec, all) {
    const set = settings.extraVideo;
    const term = optionSearch.trim().toLowerCase();
    // With nothing searched for, the list is what has been set — the rest is
    // eighty rows of noise until someone goes looking for one of them.
    const matching = term
        ? all.filter((o) => o.name.toLowerCase().indexOf(term) >= 0 ||
                            (o.help || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((o) => set[o.name] !== undefined);
    const shown = matching.slice(0, OPTION_LIMIT);

    const out = [];
    if (!term && !shown.length)
        out.push(div('ex-note dim', `Type above to search all ${all.length} options. ` +
                                    `Anything set here is passed straight to the encoder.`));

    for (const o of shown) out.push(optionRow(o, set));

    if (matching.length > OPTION_LIMIT)
        out.push(div('ex-note dim', `and ${matching.length - OPTION_LIMIT} more — narrow the search`));
    return out;
}

function optionRow(o, set) {
    const node = fromTemplate('tpl-option');
    const cur = set[o.name] !== undefined ? String(set[o.name]) : '';

    node.querySelector('.opt-name').textContent = o.name;
    node.querySelector('.opt-type').textContent = o.type;
    node.querySelector('.opt-range').textContent =
        o.hasRange && o.type !== 'enum' ? `[${o.min}…${o.max}]` : '';
    node.querySelector('.ex-opt-help').textContent = o.help || '';
    if (cur !== '') node.classList.add('set');

    const apply = (v) => {
        if (v === '') delete settings.extraVideo[o.name];
        else settings.extraVideo[o.name] = v;
        hooks.changed();
    };

    let control;
    if (o.values && o.values.length) {
        control = select({ cls: 'ex-opt', 'data-opt': o.name,
                           on: { change: (e) => apply(e.target.value.trim()) } },
                         [{ id: '', label: `default (${o.default})` },
                          ...o.values.map((v) => v.name)], cur);
    } else if (o.type === 'bool') {
        control = select({ cls: 'ex-opt', 'data-opt': o.name,
                           on: { change: (e) => apply(e.target.value.trim()) } },
                         [{ id: '', label: `default (${o.default})` }, '0', '1'], cur);
    } else {
        control = el('input', {
            cls: 'wide ex-opt', 'data-opt': o.name, type: 'text', value: cur,
            placeholder: String(o.default),
            on: { change: (e) => apply(e.target.value.trim()) },
        });
    }
    node.querySelector('.opt-control').append(control);
    return node;
}

// ── the small change handlers ──────────────────────────────────────────────

/// A select that writes one string setting.
function set(key) {
    return (e) => { settings[key] = e.target.value; hooks.changed(); };
}

/// A field that writes one number setting, floored.
function number(key, min) {
    return (e) => { settings[key] = Math.max(min, Number(e.target.value) || 0); hooks.changed(); };
}

function refreshQualityLabel() {
    if (!qualityLabel) return;
    const r = qualityRange(activeVideoCodec());
    // The scale runs backwards from every other quality control in the app and
    // its ends move with the encoder, so it says where you are on it rather
    // than showing a bare number.
    const t = (settings.quality - r.min) / Math.max(1, r.max - r.min);
    const word = t <= 0.02 ? 'lossless' : t < 0.3 ? 'near-lossless'
               : t < 0.45 ? 'high' : t < 0.62 ? 'good' : 'small file';
    qualityLabel.textContent = `${settings.quality} · ${word}`;
}
