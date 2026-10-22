// Destination, recovery (fifo), extra versions, image sequence numbering,
// and container/muxer picker rows for the Write/Encode form.

import { project } from '../project.js';
import { el, div, span, put, segmented, row, head } from '../dom.js';
import { basename } from '../format.js';
import { btns } from './controls.js';
import { settings, activeVideoCodec, activeAudioCodec, outputExt,
         outputFps } from './state.js';
import { muxers, muxerInfo, formatOptionsOf } from './capabilities.js';
import { defaultPath, withExtension, withPattern, withoutPattern,
         range } from './spec.js';
import { optionColumn } from '../opttable.js';
import { kindOf, schemeOf, protocolLinked,
         newDestination, destinationRows } from './destination.js';
import { newVersion, versionSize } from './versions.js';

let formatOpen = false;
let formatSearch = '';
let formatFacet = 'fits';
let showFormatOptions = false;
let fileLabel = null;

export function isFormatOptionsShown() { return showFormatOptions; }

export function outputRows(ctx) {
    const muxer = muxerInfo(settings.container) || { name: settings.container };
    const kind = kindOf(muxer);
    const all = formatOptionsOf(settings.container);

    const where = [head('Write to')];

    if (kind === 'several')
        where.push(...destinationRows({ list: settings.destinations,
                                        changed: () => ctx.hooks().changed(),
                                        first: 'matroska' }));
    else where.push(...oneTargetRows(kind, ctx));

    where.push(...keepTryingRows(kind, ctx));
    where.push(...versionRows(ctx));

    const what = [head('Format'),
                  ...formatRows(kind, ctx),
                  head(`${showFormatOptions ? '▾' : '▸'} ${settings.container} options · ` +
                       `${all.length}`, {
                      'data-f': 'formatopts',
                      cls: 'section-head ex-toggle',
                      on: { click: () => { showFormatOptions = !showFormatOptions;
                                           ctx.drawForm(); } },
                  })];

    return [div('ex-band', [div('ex-band-where', where), div('ex-band-what', what)])];
}

// ── a destination that is allowed to go away ───────────────────────────────

let fifoTable = null;
function fifoOption(name) {
    if (!fifoTable) {
        try { fifoTable = bro.ffmpeg.muxerOptions('fifo') || []; } catch (e) { fifoTable = []; }
    }
    return fifoTable.find((o) => o.name === name) || null;
}

const hasFifo = () => !!(bro.ffmpeg.muxers || []).some((m) => m.name === 'fifo');

function fifoNum(name, optionName, value, sentinel, apply, unit, ctx) {
    const o = fifoOption(optionName);
    const shown = value === sentinel ? '' : String(value);
    const field = el('input', {
        cls: 'num', 'data-f': name, type: 'number', value: shown,
        placeholder: o && o.default !== '' ? o.default : 'default',
        title: o ? `${optionName} — ${o.help}` : optionName,
        on: { change: () => {
            const v = field.value.trim();
            apply(v === '' ? sentinel : Number(v));
            ctx.hooks().changed();
        } },
    });
    return btns([field, unit ? span(unit, 'dim') : null]);
}

function keepTryingRows(kind, ctx) {
    if (!hasFifo()) return [];
    const k = settings.keepTrying;
    if (kind === 'several' || kind !== 'stream') return [];

    const rows = [
        row('If it drops', btns(el('button', {
            cls: 'tiny' + (k.on ? ' on' : ''), 'data-f': 'keeptrying',
            text: k.on ? 'Keep trying' : 'Fail the render',
            title: 'Keep trying',
            on: { click: () => { k.on = !k.on; ctx.hooks().changed(); } },
        }))),
    ];
    if (!k.on) return rows;

    rows.push(row('Queue', fifoNum('fifoqueue', 'queue_size', k.queueSize, 0,
                                   (v) => { k.queueSize = Math.max(0, Math.round(v) || 0); },
                                   'packets', ctx)));
    rows.push(row('Wait', fifoNum('fifowait', 'recovery_wait_time', k.waitSeconds, -1,
                                  (v) => { k.waitSeconds = Number.isFinite(v) && v >= 0 ? v : -1; },
                                  'seconds between attempts', ctx)));
    rows.push(row('Give up after', fifoNum('fifoattempts', 'max_recovery_attempts',
                                           k.maxAttempts, 0,
                                           (v) => { k.maxAttempts = Math.max(0, Math.round(v) || 0); },
                                           'attempts — blank never gives up', ctx)));
    rows.push(row('When it fills', segmented('fifofull', [
        { v: 'drop', l: 'Drop', title: 'drop_pkts_on_overflow' },
        { v: 'keyframe', l: 'Drop, resume on a keyframe', title: 'restart_with_keyframe' },
    ], k.restartWithKeyframe ? 'keyframe' : 'drop', (v) => {
        k.restartWithKeyframe = v === 'keyframe';
        ctx.hooks().changed();
    })));
    return rows;
}

const KIND_LABELS = {
    file: 'one file',
    files: 'a set of files',
    stream: 'a stream',
    several: 'several destinations',
};

function oneTargetRows(kind, ctx) {
    const path = el('input', {
        cls: 'ex-target-path', 'data-f': 'path', type: 'text', value: settings.path,
        placeholder: kind === 'stream' ? 'a URL to push the render to'
                                       : 'where the file goes',
        on: { change: () => {
            const wasPath = settings.path;
            settings.path = path.value.trim();
            const was = settings.videoCodec;
            followExtension();
            refreshFileLabel();
            if (settings.videoCodec !== was || schemeOf(settings.path) !== schemeOf(wasPath)) {
                ctx.hooks().changed();
            } else {
                ctx.hooks().restated();
                ctx.drawForm();
            }
        } },
    });

    fileLabel = span('', 'dim mono');
    fileLabel.classList.add('ex-dir');
    refreshFileLabel();

    const rows = [div('ex-target', path)];

    const scheme = schemeOf(settings.path);
    if (scheme) {
        const linked = protocolLinked(scheme);
        rows.push(row('Protocol', span(
            linked ? `${scheme} · linked in` : `${scheme} · not in this build`,
            linked ? 'mono' : 'mono src-missing')));
    } else {
        rows.push(div('ex-target-under', [
            el('button', { cls: 'tiny', 'data-f': 'browse', text: 'Choose…',
                           on: { click: () => browse(path, ctx) } }),
            fileLabel,
        ]));
    }

    rows.push(...numberingRows(path, ctx));
    return rows;
}

// ── the same edit, written twice ────────────────────────────────────────────

function versionRows(ctx) {
    const list = settings.versions || [];
    const rows = [head(`${list.length ? '▾' : '+'} Also write · ${list.length}`, {
        'data-f': 'versions',
        cls: 'section-head ex-head ex-toggle',
        on: { click: () => { if (!list.length) addVersion(ctx); } },
    })];

    if (!list.length) return rows;

    list.forEach((v, i) => {
        const target = el('input', {
            cls: 'wide', 'data-f': `ver-path-${i}`, type: 'text', value: v.path,
            placeholder: 'where this one goes',
            on: { change: () => { v.path = target.value.trim(); ctx.hooks().changed(); } },
        });
        const muxer = el('input', {
            cls: 'wide', 'data-f': `ver-format-${i}`, type: 'text', value: v.format,
            placeholder: 'the render’s, unless this says otherwise',
            on: { change: () => { v.format = muxer.value.trim(); ctx.hooks().changed(); } },
        });
        const w = el('input', {
            cls: 'num', 'data-f': `ver-w-${i}`, type: 'number', min: '0',
            value: String(v.width || ''), placeholder: 'auto',
            on: { change: () => {
                v.width = Math.max(0, Math.round(Number(w.value) || 0));
                ctx.hooks().changed();
            } },
        });
        const h = el('input', {
            cls: 'num', 'data-f': `ver-h-${i}`, type: 'number', min: '0',
            value: String(v.height || ''), placeholder: 'auto',
            on: { change: () => {
                v.height = Math.max(0, Math.round(Number(h.value) || 0));
                ctx.hooks().changed();
            } },
        });

        const size = versionSize(v, settings.width || project.width || 1920,
                                 settings.height || project.height || 1080);
        rows.push(head(`Version ${i + 1}`, { cls: 'section-head' }));
        rows.push(row('Size', btns([w, span('×', 'dim'), h])));
        rows.push(row('', span(`${size.width} × ${size.height}`, 'dim')));
        rows.push(row('Container', muxer));
        rows.push(row('To', target));
        rows.push(row('', btns([
            el('button', { cls: 'tiny', 'data-f': `ver-drop-${i}`, text: 'Remove',
                           on: { click: () => {
                               settings.versions.splice(i, 1);
                               ctx.hooks().changed();
                           } } }),
        ])));
    });

    rows.push(row('', btns([
        el('button', { cls: 'tiny', 'data-f': 'ver-add', text: '+ Version',
                       on: { click: () => addVersion(ctx) } }),
    ])));
    return rows;
}

function addVersion(ctx) {
    const w = settings.width || project.width || 1920;
    const half = Math.max(16, Math.round(w / 2) & ~1);
    settings.versions.push(newVersion({
        width: half,
        path: settings.path ? proxyPath(settings.path, half) : '',
    }));
    ctx.hooks().changed();
}

function proxyPath(path, width) {
    const cut = String(path).replace(/(\.[^./\\]*)$/, '');
    const ext = String(path).slice(cut.length);
    return `${cut}-${width}${ext}`;
}

// ── writing a run of files ─────────────────────────────────────────────────

function followExtension() {
    if (settings.container !== 'image2' || !settings.path) return;
    const guess = bro.ffmpeg.guessCodec('image2', settings.path);
    if (guess && guess !== settings.videoCodec) settings.videoCodec = guess;
}

function outputFrames() {
    const r = range();
    const fps = outputFps();
    return Math.max(0, Math.round(r.length * fps));
}

function startNumber() {
    const n = Number(settings.extraFormat.start_number);
    return Number.isFinite(n) && n >= 0 ? n : 1;
}

function numberingRows(pathInput, ctx) {
    if (settings.container !== 'image2') return [];

    const numbered = bro.ffmpeg.hasFramePattern(settings.path);
    const setPath = (next) => {
        settings.path = next;
        pathInput.value = next;
        refreshFileLabel();
        ctx.hooks().changed();
    };

    const rows = [
        head('Numbering'),
        row('Writes', segmented('ex-imgmode', [
            { v: 'seq', l: 'A file per frame', title: 'out%04d.png — a run of pictures' },
            { v: 'one', l: 'One picture', title: '-update 1 — the same file, rewritten' },
        ], numbered ? 'seq' : 'one', (v) => {
            if (v === 'seq') {
                delete settings.extraFormat.update;
                setPath(withPattern(settings.path));
                followExtension();
            } else {
                settings.extraFormat.update = '1';
                setPath(withoutPattern(settings.path));
            }
        })),
    ];

    if (!numbered) {
        rows.push(row('', span(
            'One picture, rewritten on every frame of the range — so what is left is the ' +
            'last frame. Set the range to a single frame for the picture at the playhead.',
            'dim')));
        return rows;
    }

    const start = startNumber();
    const startField = el('input', {
        cls: 'num', 'data-f': 'startnumber', type: 'text',
        value: settings.extraFormat.start_number !== undefined
                   ? String(settings.extraFormat.start_number) : '',
        placeholder: '1',
        on: { change: () => {
            const v = startField.value.trim();
            if (v) settings.extraFormat.start_number = v;
            else delete settings.extraFormat.start_number;
            ctx.hooks().changed();
        } },
    });
    rows.push(row('First frame number', startField));

    const total = outputFrames();
    let names = [];
    try {
        names = bro.ffmpeg.frameNames(settings.path, start, Math.min(total || 1, 3));
    } catch (e) { names = []; }
    if (names.length) {
        const last = total > names.length
            ? bro.ffmpeg.frameNames(settings.path, start + total - 1, 1)[0] : '';
        rows.push(row('Files', div('ex-filenames', [
            ...names.map((n) => div('mono dim', basename(n))),
            total > names.length + 1 ? div('dim', '…') : null,
            last ? div('mono dim', basename(last)) : null,
        ].filter(Boolean))));
        rows.push(row('', span(
            `${total} file${total === 1 ? '' : 's'} over ${range().length.toFixed(2)} s at ` +
            `${outputFps().toFixed(3)} fps`, 'dim')));
    }
    return rows;
}

function browse(pathInput, ctx) {
    if (typeof showSaveFileDialog !== 'function') return;
    const ext = outputExt();
    const chosen = showSaveFileDialog(`${ext.toUpperCase()}|${ext}`, settings.path || defaultPath());
    if (!chosen) return;
    settings.path = chosen;
    pathInput.value = chosen;
    refreshFileLabel();
    ctx.hooks().tweaked();
}

function refreshFileLabel() {
    if (fileLabel) fileLabel.textContent = settings.path ? basename(settings.path) : 'no file chosen';
}

// ── the muxer ──────────────────────────────────────────────────────────────

const FACETS = [
    { id: 'fits',   label: 'Fits',      hint: 'Will hold the codecs this render is set to' },
    { id: 'files',  label: 'Files',     hint: 'Writes a file, and has an extension for it' },
    { id: 'stills', label: 'Pictures',  hint: 'Writes pictures and no sound' },
    { id: 'stream', label: 'Streaming', hint: 'Writes through a protocol rather than a file' },
    { id: 'device', label: 'Devices',   hint: 'A screen, a window, a sound card' },
    { id: 'all',    label: 'All',       hint: 'Every muxer this build links' },
];

function fits(m) {
    const v = activeVideoCodec();
    const a = activeAudioCodec();
    const wantsVideo = settings.streams.some((s) => s.kind === 'video');
    const wantsAudio = settings.audio && settings.streams.some((s) => s.kind === 'audio');
    if (wantsVideo && (!v || m.videoCodecs.indexOf(v) < 0)) return false;
    if (wantsAudio && (!a || m.audioCodecs.indexOf(a) < 0)) return false;
    return true;
}

function inFacet(m, facet) {
    switch (facet) {
        case 'fits':   return fits(m) && !m.device;
        case 'files':  return !!m.extensions.length && !m.noFile && !m.device;
        case 'stills': return m.stills;
        case 'stream': return m.noFile && !m.device;
        case 'device': return m.device;
        default:       return true;
    }
}

function formatRows(kind, ctx) {
    const m = muxerInfo(settings.container) || { name: settings.container, label: '', extensions: [] };
    const stated = div('ex-fmt-current', [
        span(m.name, 'mono'),
        span(KIND_LABELS[kind] || '', 'ex-fmt-kind'),
        el('button', {
            cls: 'tiny', 'data-f': 'container-open', text: formatOpen ? 'Close' : 'Change',
            on: { click: () => { formatOpen = !formatOpen; formatSearch = ''; ctx.drawForm(); } },
        }),
    ]);

    const rows = [stated,
                  div('ex-note dim', [m.longName, describeMuxer(m)].filter(Boolean).join(' · '))];
    if (formatOpen) rows.push(formatPicker(ctx));
    return rows;
}

function describeMuxer(m) {
    const bits = [];
    bits.push(m.ext ? `.${m.ext}` : 'no file extension of its own');
    if (m.device) bits.push('a device');
    else if (m.noFile) bits.push('writes through a protocol');
    if (m.stills) bits.push('pictures only');
    if (!m.answersCodecs) bits.push('does not say which codecs it takes');
    else if (!m.videoCodecs.length) bits.push('no video encoder here fits it');
    else if (!m.audioCodecs.length) bits.push('no audio encoder here fits it');
    else if (!fits(m)) bits.push('will not hold what this render is set to');
    return bits.join(' · ');
}

const MUXER_LIMIT = 40;

function formatPicker(ctx) {
    const list = div('ex-fmt-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'fmtsearch', type: 'text', value: formatSearch,
        placeholder: 'name, description or extension',
        on: { input: () => {
            formatSearch = field.value;
            put(list, () => muxerRows(ctx));
        } },
    });
    put(list, () => muxerRows(ctx));

    return div('ex-fmt-picker', [
        div('ex-fmt-facets', FACETS.map((f) => el('button', {
            cls: 'tiny' + (f.id === formatFacet ? ' on' : ''),
            text: f.label, title: f.hint, 'data-facet': f.id,
            on: { click: () => { formatFacet = f.id; ctx.drawForm(); } },
        }))),
        row('Find', field),
        list,
    ]);
}

function muxerRows(ctx) {
    const term = formatSearch.trim().toLowerCase();
    let matching = term
        ? muxers().filter((m) =>
              m.name.toLowerCase().indexOf(term) >= 0 ||
              (m.longName || '').toLowerCase().indexOf(term) >= 0 ||
              m.extensions.some((e) => e.indexOf(term) >= 0))
        : muxers().filter((m) => inFacet(m, formatFacet));

    if (!term && formatFacet === 'fits') {
        matching = matching.filter((m) => m.answersCodecs)
                           .concat(matching.filter((m) => !m.answersCodecs));
    }
    const shown = matching.slice(0, MUXER_LIMIT);

    const out = [div('ex-note dim', term
        ? `${matching.length} of ${muxers().length} match “${formatSearch.trim()}”`
        : `${matching.length} of ${muxers().length} muxers — search to reach the rest`)];

    for (const m of shown) {
        const tail = [];
        if (m.ext) tail.push(`.${m.extensions.join(' .')}`);
        if (m.device) tail.push('device');
        else if (m.noFile) tail.push('no file');
        if (m.stills) tail.push('pictures');
        if (!m.answersCodecs) tail.push('does not say');
        else if (!fits(m)) tail.push('not for these codecs');
        out.push(el('button', {
            cls: 'ex-fmt-row' + (m.name === settings.container ? ' on' : '') +
                 (fits(m) ? '' : ' misfit'),
            'data-muxer': m.name,
            title: m.longName || m.name,
            on: { click: () => pickMuxer(m.name, ctx) },
        }, [
            span(m.name, 'ex-fmt-name mono'),
            span(m.longName || '', 'dim'),
            span(tail.join(' · '), 'ex-fmt-tail dim'),
        ]));
    }
    if (matching.length > MUXER_LIMIT)
        out.push(div('ex-note dim',
                     `and ${matching.length - MUXER_LIMIT} more — narrow the search`));
    return out;
}

function pickMuxer(name, ctx) {
    const previous = settings.container;
    settings.container = name;
    const c = muxerInfo(name);
    if (c) {
        if (c.videoCodecs.indexOf(settings.videoCodec) < 0) settings.videoCodec = c.videoCodec;
        if (c.audioCodecs.indexOf(settings.audioCodec) < 0) settings.audioCodec = c.audioCodec;
    }
    settings.extraFormat = {};
    if (settings.path && c && c.ext) settings.path = withExtension(settings.path, outputExt());

    if (name === 'tee' && !settings.destinations.length) {
        const was = muxerInfo(previous);
        settings.destinations = [
            newDestination({ format: previous === 'tee' ? '' : previous,
                             path: settings.path }),
            newDestination(),
        ];
        if (!was) settings.destinations[0].format = '';
    }

    if (name === 'image2' && settings.path) settings.path = withPattern(settings.path);
    followExtension();
    formatOpen = false;
    ctx.hooks().changed();
}

export function formatOptionRows(ctx) {
    const all = formatOptionsOf(settings.container);
    const out = optionColumn({
        name: 'fmtoptsearch',
        title: `${settings.container} options · ${all.length}`,
        note: `What ${settings.container} takes beyond its defaults, out of the muxer's own ` +
              'option table and libavformat’s generic one — both reach it the same way ' +
              'ffmpeg’s own arguments do.',
        options: all,
        bag: settings.extraFormat,
        hint: 'Anything set here is passed straight to the muxer.',
        onChange: () => ctx.hooks().changed(),
    });

    const scheme = kindOf(muxerInfo(settings.container) || {}) === 'stream'
        ? schemeOf(settings.path) : '';
    if (scheme) {
        let opts = [];
        try { opts = bro.ffmpeg.protocolOptions(scheme) || []; } catch (e) { opts = []; }
        if (opts.length)
            out.push(...optionColumn({
                name: 'protooptsearch',
                title: `${scheme} options · ${opts.length}`,
                note: 'The protocol’s own — timeouts, buffer sizes, certificates, latency. ' +
                      'They travel in the same bag the muxer’s do, and a key neither of ' +
                      'them has stops the render rather than being ignored.',
                options: opts,
                bag: settings.extraFormat,
                hint: 'Anything set here is passed straight to the protocol.',
                onChange: () => ctx.hooks().changed(),
            }));
    }
    return out;
}
