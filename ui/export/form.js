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

import { project, projectFps } from '../project.js';
import { el, div, span, put, select, segmented, show,
         row, head } from '../dom.js';
import { btns, num } from './controls.js';
import { settings, activeVideoCodec, activeAudioCodec } from './state.js';
import { remember } from './store.js';
import { videoEncoders, audioEncoders, encoderInfo, audioInfo,
         muxerInfo, optionsOf, rateModes, qualityRange } from './capabilities.js';
import { range, freshSpec, effectiveFpsMode } from './spec.js';
import { cutPoints } from './options.js';
import { isHardwareEncoder, deviceOfEncoder,
         chooseFor, applyChoice } from '../hardware.js';
import { inputs } from '../inputs.js';
import { optionColumn } from '../opttable.js';
import { setAudioIncluded } from './streams.js';
import { outputRows, formatOptionRows, isFormatOptionsShown } from './form-output.js';

let panes = {};
let hooks = {};

// Held between draws so the quality readout as the slider moves can be written
// without rebuilding the form under the pointer.
let qualityLabel = null;

const formCtx = {
    hooks: () => hooks,
    drawForm: () => drawForm(),
};

export function initForm(refs, h) {
    panes = refs;
    hooks = h || {};
}

const RATE_LABELS = {
    quality: 'Quality', bitrate: 'Bitrate', twopass: 'Two-pass',
    constrained: 'Capped', lossless: 'Lossless',
};
const RATE_HINTS = {
    quality: 'Constant quality: the bitrate lands wherever it needs to',
    bitrate: 'A target the encoder averages out to',
    twopass: 'The same target, measured first and then spent where it is needed',
    constrained: 'An average with a ceiling, for streaming',
    lossless: 'Nothing thrown away',
};

export function drawForm() {
    const codec = activeVideoCodec();
    const info = encoderInfo(codec) || { presets: [], tunes: [], profiles: [], pixelFormats: [] };
    const cont = muxerInfo(settings.container) || { videoCodecs: [], audioCodecs: [] };

    put(panes.dest, () => outputRows(formCtx));

    if (panes.format) {
        const shown = isFormatOptionsShown();
        show(panes.format, shown);
        put(panes.format, () => (shown ? formatOptionRows(formCtx) : []));
    }

    put(panes.settings, () => [
        head('Video'),
        ...videoRows(codec, info, cont),
        head('Audio'),
        ...audioRows(cont),
        head(`${settings.showAdvanced ? '▾' : '▸'} Advanced`, {
            'data-f': 'advanced',
            cls: 'section-head ex-toggle',
            on: { click: () => { settings.showAdvanced = !settings.showAdvanced; remember(); drawForm(); hooks.changed(); } },
        }),
    ]);

    show(panes.advanced, settings.showAdvanced);
    put(panes.advanced, () => (settings.showAdvanced ? advancedRows(codec) : []));
}

// ── video ──────────────────────────────────────────────────────────────────

function videoRows(codec, info, cont) {
    const rows = [];

    const label = (e, legal) =>
        e.label + (isHardwareEncoder(e.id) ? `  · ${deviceOfEncoder(e.id)}` : '') +
        (legal.indexOf(e.id) < 0 ? `  (not in ${settings.container})` : '');

    rows.push(row('Codec', select(
        { 'data-f': 'vcodec', on: { change: (e) => { settings.videoCodec = e.target.value; hooks.changed(); } } },
        videoEncoders().map((e) => ({ id: e.id, label: label(e, cont.videoCodecs) })),
        codec)));

    rows.push(...chooseRows(codec));
    rows.push(...rateRows(codec, info));

    if (info.presets && info.presets.length)
        rows.push(row('Speed', btns([
            span('fastest encode', 'dim tiny'),
            select({ 'data-f': 'preset', on: { change: set('preset') } },
                   info.presets, settings.preset),
            span('best compression', 'dim tiny'),
        ])));
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
        [{ id: 0, label: `Project (${projectFps().toFixed(3)})` },
         ...[23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map((f) => ({ id: f, label: String(f) }))],
        settings.fps)));

    return rows;
}

function chooseRows(codec) {
    const choice = chooseFor({ height: settings.height || project.height,
                               videoCodec: codec, inputs });
    return [row('', el('button', {
        cls: 'tiny', 'data-f': 'hwchoose', text: 'Choose for me',
        title: choice.why,
        on: { click: () => {
            const answer = chooseFor({ height: settings.height || project.height,
                                       videoCodec: activeVideoCodec(), inputs });
            for (const input of applyChoice(answer))
                if (hooks.reopened) hooks.reopened(input);
            if (answer.encoder) settings.videoCodec = answer.encoder;
            hooks.changed();
        } },
    }))];
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
        const slider = el('input', {
            'data-f': 'quality', type: 'range', min: q.min, max: q.max, value: settings.quality,
            on: { input: () => {
                settings.quality = Number(slider.value);
                refreshQualityLabel();
                hooks.tweaked();
            } },
        });
        rows.push(row('Quality', div('slider-row', [
            span('higher quality', 'dim tiny'),
            slider,
            span('smaller file', 'dim tiny'),
            qualityLabel,
        ])));
        refreshQualityLabel();
    }
    if (settings.rate === 'bitrate' || settings.rate === 'twopass' ||
        settings.rate === 'constrained') {
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
        on: { click: () => { setAudioIncluded(!settings.audio); hooks.changed(); } },
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
        on: { change: () => { settings.title = title.value; hooks.restated(); } },
    });

    return [
        head('Advanced'),
        row('Keyframes', num('gop', { min: 0, max: 60, step: 0.5, value: settings.gopSeconds,
                                         on: { change: number('gopSeconds', 0) } },
                             'seconds (0 = encoder default)')),
        ...keyframeRows(),
        row('B-frames', num('bf', { min: -1, max: 16, value: settings.bframes,
                                       on: { change: number('bframes', -1) } },
                            '-1 = leave alone')),
        ...timingRows(),
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
            title: 'Faststart',
            on: { click: () => { settings.faststart = !settings.faststart; hooks.changed(); } },
        }))),
        row('Title', title),
        ...rawOptionRows(codec),
        ...rawAudioOptionRows(),
    ];
}

// ── where the keyframes go ─────────────────────────────────────────────────

const KEYFRAME_MODES = [
    { v: 'none', l: 'Off', title: 'Off' },
    { v: 'cuts', l: 'Cut points', title: 'Cut points' },
    { v: 'times', l: 'Times', title: 'Times' },
    { v: 'expr', l: 'Expression', title: 'Expression' },
];

function keyframeRows() {
    const rows = [row('Force at', segmented('kfmode', KEYFRAME_MODES, settings.keyframeMode,
                                            (v) => { settings.keyframeMode = v; drawForm();
                                                     hooks.changed(); }))];

    if (settings.keyframeMode === 'cuts') {
        const at = cutPoints(range());
        rows.push(row('', span(at.length
            ? `${at.length} cut${at.length === 1 ? '' : 's'} (${at.map((t) => t.toFixed(2)).join(', ')} s)`
            : '0 cuts in range', 'dim')));
    }
    if (settings.keyframeMode === 'times') {
        const f = el('input', {
            cls: 'wide', 'data-f': 'kftimes', type: 'text', value: settings.keyframeTimes,
            placeholder: '1.5,4,00:00:08.5',
            on: { change: () => { settings.keyframeTimes = f.value.trim(); hooks.changed(); } },
        });
        rows.push(row('At', f));
    }
    if (settings.keyframeMode === 'expr') {
        const f = el('input', {
            cls: 'wide', 'data-f': 'kfexpr', type: 'text', value: settings.keyframeExpr,
            placeholder: 'gte(t,n_forced*2)',
            on: { change: () => { settings.keyframeExpr = f.value.trim(); hooks.changed(); } },
        });
        rows.push(row('expr:', f));
    }
    return rows;
}

// ── how the frames are timed and shaped ────────────────────────────────────

const FIELD_ORDERS = [
    { v: '', l: 'Progressive' },
    { v: 'tt', l: 'Top first' },
    { v: 'bb', l: 'Bottom first' },
];
const THREAD_TYPES = [{ id: '', label: 'auto' }, { id: 'frame', label: 'frame' },
                      { id: 'slice', label: 'slice' },
                      { id: 'frame+slice', label: 'frame + slice' }];

const FPS_MODES = [
    { v: 'cfr', l: 'Constant', title: 'Constant' },
    { v: 'vfr', l: 'Variable', title: 'Variable' },
];

function timingRows() {
    const rows = [];
    const spec = freshSpec();
    const inForce = effectiveFpsMode(spec);
    const padFed = (spec.streams || []).some((s) => s && s.kind === 'video' &&
                                                    String(s.source || '').startsWith('pad:'));
    const canVary = !!spec.filterGraph && !padFed;
    rows.push(row('Frame timing', btns([
        segmented('fpsmode', FPS_MODES.map(
            (m) => (m.v === 'vfr' && !canVary
                ? Object.assign({}, m, { disabled: true,
                                         title: 'Requires filter graph' })
                : m)), settings.fpsMode,
            (v) => { settings.fpsMode = v; drawForm(); hooks.changed(); }),
        span(`-fps_mode ${inForce}`, 'mono dim'),
    ])));

    rows.push(row('Field order', segmented('fieldorder', FIELD_ORDERS, settings.fieldOrder,
                                           (v) => { settings.fieldOrder = v; drawForm();
                                                    hooks.changed(); })));

    rows.push(row('Threads', btns([
        num('threads', { min: 0, max: 64, value: settings.threads,
                         on: { change: number('threads', 0) } }, '0 = all cores'),
        select({ 'data-f': 'threadtype', on: { change: set('threadType') } },
               THREAD_TYPES, settings.threadType),
    ])));

    rows.push(row('Shortest', btns(el('button', {
        cls: 'tiny' + (settings.shortest ? ' on' : ''), 'data-f': 'shortest',
        text: settings.shortest ? 'On' : 'Off',
        title: 'Shortest',
        on: { click: () => { settings.shortest = !settings.shortest; drawForm();
                             hooks.changed(); } },
    }))));

    return rows;
}

function rawOptionRows(codec) {
    const all = optionsOf(codec);
    return optionColumn({
        name: 'optsearch',
        title: `${codec} options · ${all.length}`,
        options: all,
        bag: settings.extraVideo,
        hint: 'Anything set here is passed straight to the encoder.',
        onChange: () => hooks.changed(),
    });
}

function rawAudioOptionRows() {
    const codec = activeAudioCodec();
    if (!settings.audio || !codec) return [];
    const all = optionsOf(codec);
    if (!all.length) return [];
    return optionColumn({
        name: 'aoptsearch',
        title: `${codec} options · ${all.length}`,
        options: all,
        bag: settings.extraAudio,
        hint: 'Anything set here is passed straight to the audio encoder.',
        onChange: () => hooks.changed(),
    });
}

// ── the small change handlers ──────────────────────────────────────────────

function set(key) {
    return (e) => { settings[key] = e.target.value; hooks.changed(); };
}

function number(key, min) {
    return (e) => { settings[key] = Math.max(min, Number(e.target.value) || 0); hooks.changed(); };
}

function refreshQualityLabel() {
    if (!qualityLabel) return;
    const r = qualityRange(activeVideoCodec());
    const t = (settings.quality - r.min) / Math.max(1, r.max - r.min);
    const word = t <= 0.02 ? 'lossless' : t < 0.3 ? 'near-lossless'
               : t < 0.45 ? 'high' : t < 0.62 ? 'good' : 'small file';
    qualityLabel.textContent = `${settings.quality} · ${word}`;
}
