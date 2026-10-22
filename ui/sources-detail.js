// Detail, assembly, decode, window, local copy, option, and content rows for ui/sources.js.

import { div, span, el, row, head, segmented, select } from './dom.js';
import { devicesFor, deviceNamed, decodeCost, deviceIndices,
         unknownDeviceIndex } from './hardware.js';
import { clock, bytes, kbps, basename } from './format.js';
import { reprobe, removeInput, schemeOf, lengthOf, kindOf, endless, opening } from './inputs.js';
import { SEQUENCE_FPS } from './sequence.js';
import { copiesOf, cancel as cancelCopy, copyFolder, useCopyFolder, PULL_WORDS } from './localcopy.js';
import { optionColumn } from './opttable.js';
import { note } from './export/controls.js';
import * as graph from './graph/overlay.js';
import { COMPOSITE_POINT } from './graph/derive.js';
import { filterPath } from './export/subtitles.js';
import { goTo } from './shell.js';

function strip(key, text, why, door) {
    return div('src-strip', [
        span(key, 'src-strip-k'),
        el('span', { cls: 'src-strip-v dim', text, title: why || '' }),
        door || null,
    ]);
}

const doorTo = (label, stage, why) => el('button', {
    cls: 'tiny', 'data-f': `srcgo${stage}`, text: label, title: why,
    on: { click: () => goTo(stage) },
});

function optionField(input, key, opts, ctx) {
    const field = el('input', {
        cls: opts.wide ? 'wide' : 'num', 'data-f': opts.name || key, type: 'text',
        value: input.options[key] !== undefined ? String(input.options[key]) : '',
        placeholder: opts.hint || '',
        title: opts.title || `-${key}`,
        on: { change: () => {
            const next = Object.assign({}, input.options);
            const v = field.value.trim();
            if (v) next[key] = v; else delete next[key];
            ctx.change(input, { options: next });
        } },
    });
    return field;
}

export function assemblyRows(input, ctx) {
    switch (kindOf(input)) {
        case 'sequence':  return sequenceRows(input, ctx);
        case 'still':     return stillRows(input, ctx);
        case 'concat':    return concatRows(input);
        case 'device':    return deviceRows();
        case 'subtitles': return subtitleRows(input, ctx);
        default:          return [];
    }
}

function subtitleRows(input, ctx) {
    const cues = (input.probe ? input.probe.streams : [])
        .map((s) => `${s.index}: ${s.codec}${s.language ? ` (${s.language})` : ''}`);
    return [
        head('Subtitles'),
        row('Tracks', span(cues.join(' · ') || 'none libavformat could read', 'mono')),
        strip('Cues', 'no picture and no sound — nothing to lay out',
              '',
              doorTo('Write', 'write', 'Carry it as a track the player can turn off')),
        row('Burn in', div('src-demux', [
            el('span', {
                cls: 'mono dim src-filter', text: `subtitles=${filterPath(input.path)}`,
            }),
            el('button', {
                cls: 'tiny', 'data-f': 'srcburn', text: 'Place it',
                title: 'Place subtitles node on graph',
                on: { click: () => burnIn(input, ctx) },
            }),
        ])),
    ];
}

function burnIn(input, ctx) {
    graph.insert(COMPOSITE_POINT, 'subtitles',
                 { params: { filename: filterPath(input.path) } });
    const hooks = ctx.hooks();
    if (hooks.changed) hooks.changed();
    goTo('graph');
}

function deviceRows() {
    return [
        strip('Live', 'plays now and cannot be cut',
              'Stop at gives one a length, but a device cannot seek. Record a segment on the Capture stage and use that file instead.',
              doorTo('Capture', 'capture', 'Watch it, compose it, record or stream it')),
    ];
}

function sequenceRows(input, ctx) {
    const seq = input.sequence;
    const rows = [head('Image sequence')];

    if (seq && seq.count) {
        rows.push(row('Frames', span(`${seq.count} · ${seq.start}…${seq.end}`, 'mono')));
        if (seq.missing)
            rows.push(row('', el('span', {
                cls: 'src-missing',
                text: `${seq.missing} missing — the sequence ends at the first gap`,
                title: `${seq.missing} frame gap(s) detected`,
            })));
    }

    rows.push(row('Rate', [
        optionField(input, 'framerate', {
            name: 'seqfps', hint: String(SEQUENCE_FPS),
            title: '-framerate',
        }, ctx),
        span('fps', 'dim'),
    ]));

    rows.push(row('First number', optionField(input, 'start_number', {
        name: 'seqstart', hint: '0',
        title: '-start_number',
    }, ctx)));

    const pattern = input.options.pattern_type || 'sequence';
    rows.push(row('Named by', div('src-demux', [
        segmented('src-pattern', [
            { v: 'sequence', l: 'number', title: 'pattern_type sequence' },
            { v: 'glob', l: 'pattern', disabled: !bro.ffmpeg.globPatterns,
              title: bro.ffmpeg.globPatterns
                  ? 'pattern_type glob'
                  : 'glob pattern not available in this build' },
        ], pattern, (id) => {
            const next = Object.assign({}, input.options);
            if (id === 'sequence') delete next.pattern_type; else next.pattern_type = id;
            ctx.change(input, { options: next });
        }),
    ])));
    return rows;
}

function stillRows(input, ctx) {
    const seconds = el('input', {
        cls: 'num', 'data-f': 'stillhold', type: 'text',
        value: input.to ? String(input.to) : '',
        placeholder: '0',
        title: '-loop 1 -t',
        on: { change: () => {
            const next = Object.assign({}, input.options, { loop: '1' });
            if (!next.framerate) next.framerate = String(SEQUENCE_FPS);
            ctx.change(input, { to: Number(seconds.value) || 0, options: next,
                                format: input.format || 'image2' });
        } },
    });

    return [
        head('Still'),
        row('Hold for', [seconds, span('s', 'dim')]),
        row('Rate', [
            optionField(input, 'framerate', {
                name: 'stillfps', hint: String(SEQUENCE_FPS),
                title: '-framerate',
            }, ctx),
            span('fps', 'dim'),
        ]),
    ].filter(Boolean);
}

function concatRows(input) {
    const parts = input.parts || [];
    return [
        head('Read end to end'),
        ...parts.map((p, i) => row(String(i), span(p, 'mono dim'))),
        row('List', el('span', {
            cls: 'mono dim', text: input.path,
        })),
    ];
}

export function decodeRows(input, ctx) {
    if (input.probe && !input.probe.video) return [];

    const codec = input.probe && input.probe.video && input.probe.video.codec;
    const usable = devicesFor(input);
    const rows = [head('Decoding')];

    const choices = [{ id: '', label: 'CPU' }]
        .concat(usable.map((d) => ({ id: d.name, label: d.name })));
    const picker = select({
        'data-f': 'srchw',
        title: usable.length
            ? `-hwaccel. ${decodeCost}`
            : codec ? `-hwaccel. Nothing on this machine decodes ${codec} on a device.`
                    : '-hwaccel. Nothing on this machine has a decoder for this input.',
        on: { change: () => ctx.change(input, {
            hwaccel: picker.value,
            hwaccelOutputFormat: '',
        }) },
    }, choices, input.hwaccel || '');
    rows.push(row('Decode on', picker));

    if (input.hwaccel) {
        const dev = deviceNamed(input.hwaccel);
        const indices = deviceIndices(input.hwaccel);
        const stored = String(input.hwaccelDevice || '');
        const absent = unknownDeviceIndex(input.hwaccel, stored);
        const choices = [{ id: '', label: 'the default' }]
            .concat(indices.map((i) => ({ id: i, label: `${input.hwaccel} ${i}` })));
        if (absent) choices.push({ id: stored, label: `${stored} — not on this machine` });
        const which = select({
            'data-f': 'srchwdev',
            cls: absent ? 'bad' : '',
            title: `-hwaccel_device (${indices.length} available)`,
            on: { change: () => ctx.change(input, { hwaccelDevice: which.value }) },
        }, choices, stored);
        rows.push(row('Which one', which));

        rows.push(row('Pictures', segmented('srchwkeep', [
            { v: '', l: 'bring down', title: 'Decode to system memory' },
            { v: dev ? dev.pixelFormat : '', l: 'keep on the card', title: '-hwaccel_output_format' },
        ], input.hwaccelOutputFormat || '',
            (v) => ctx.change(input, { hwaccelOutputFormat: v }))));
    }
    return rows;
}

// B5. Dual-handle range bar control for input read window
export function windowRows(input, ctx) {
    const number = (name, key, value, hint, why, unit) => {
        const field = el('input', {
            cls: 'num', 'data-f': name, type: 'text', value: value ? String(value) : '',
            placeholder: hint, title: why,
            on: { change: () => ctx.change(input, { [key]: Number(field.value) || 0 }) },
        });
        return [field, span(unit || 's', 'dim')];
    };

    const dur = (input.probe && input.probe.format && input.probe.format.duration) ? input.probe.format.duration : lengthOf(input);
    const windowControls = [];

    if (dur > 0) {
        const ssVal = Math.min(dur, Math.max(0, input.ss || 0));
        const toVal = (input.to && input.to > 0) ? Math.min(dur, input.to) : dur;

        const minSlider = el('input', {
            cls: 'dual-range-min', type: 'range', min: '0', max: String(dur), step: '0.01',
            value: String(ssVal),
            on: { input: () => {
                const val = Math.min(Number(minSlider.value) || 0, (input.to || dur) - 0.01);
                ctx.change(input, { ss: Math.max(0, val) });
            } }
        });
        const maxSlider = el('input', {
            cls: 'dual-range-max', type: 'range', min: '0', max: String(dur), step: '0.01',
            value: String(toVal),
            on: { input: () => {
                const val = Math.max(Number(maxSlider.value) || 0, (input.ss || 0) + 0.01);
                ctx.change(input, { to: Math.min(dur, val) });
            } }
        });
        const leftPct = (ssVal / dur) * 100;
        const rightPct = 100 - (toVal / dur) * 100;
        const fill = div('dual-range-fill');
        fill.style.left = `${leftPct}%`;
        fill.style.right = `${rightPct}%`;

        windowControls.push(row('Range', div('src-window-range', [
            div('dual-range', [
                div('dual-range-track'),
                fill,
                minSlider,
                maxSlider
            ])
        ])));
    }

    return [
        head('Window'),
        ...windowControls,
        row('Start at', number('srcss', 'ss', input.ss, '0', '-ss. An input seek is not a clip’s in-point')),
        row('Stop at', number('srcto', 'to', input.to, 'the end', '-to')),
        row('Delay by', number('srcoffset', 'itsoffset', input.itsoffset, '0', '-itsoffset')),
        row('Repeat', number('srcloop', 'streamLoop', input.streamLoop, '0', '-stream_loop', '× more')),
        dur ? row('Length', el('span', {
            cls: 'mono', text: clock(lengthOf(input)),
            title: endless(input) ? 'Input never ends' : 'Window duration',
        })) : null,
    ].filter(Boolean);
}

export function blocked(input, waitingOn) {
    if (opening(input))
        return waitingOn(input) === 'device' ? 'Still opening' : 'Still connecting';
    if (input.error || !input.probe) return 'Will not open';
    const p = input.probe;
    if (!p.video && !p.audio) return 'Nothing to play';
    if (kindOf(input) === 'device') return 'A device cannot be cut';
    if (kindOf(input) === 'still' && !endless(input)) return 'One picture, no time at all';
    if (lengthOf(input) <= 0)
        return endless(input) ? 'Never ends — set Stop at'
             : 'No length to cut';
    return '';
}

export function footRows(input, ctx) {
    const hooks = ctx.hooks();
    const used = hooks.clipsOf ? hooks.clipsOf(input) : [];
    const inGraph = ctx.graphReads().has(input.id);
    const why = blocked(input, ctx.waitingOn);
    return [
        el('button', {
            cls: 'src-go', 'data-f': 'srcuse', text: 'Use on the timeline',
            disabled: !!why,
            title: why || 'Cut a clip of the whole window and lay it on the timeline',
            on: { click: () => { if (hooks.use) hooks.use(input); } },
        }),
        why ? el('span', { cls: 'src-why', text: why }) : null,
        div('spacer'),
        ...localCopyButtons(input, ctx),
        el('button', {
            cls: 'tiny', 'data-f': 'srcreopen', text: 'Re-probe',
            title: 'Re-probe input',
            on: { click: () => { reprobe(input); ctx.reopened(input); } },
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'srcremove',
            text: used.length ? `In use by ${used.length}` : inGraph ? 'In the graph' : 'Remove',
            disabled: used.length > 0 || inGraph,
            title: used.length
                ? 'In use by timeline clips'
                : inGraph
                ? 'Used by graph node'
                : 'Remove input',
            on: { click: () => {
                removeInput(input);
                ctx.clearChosen();
                if (hooks.changed) hooks.changed();
                ctx.drawSources();
            } },
        }),
    ];
}

function localCopyButtons(input, ctx) {
    if (!input.origin && !input.renditions) return [];
    const hooks = ctx.hooks();
    const out = [];
    if (input.localCopy)
        out.push(el('button', {
            cls: 'tiny', 'data-f': 'srclocaluse', text: 'Use the local copy',
            title: `Use local copy ${basename(input.localCopy)}`,
            on: { click: () => {
                ctx.change(input, { path: input.localCopy });
                if (hooks.flash) hooks.flash(`Reading ${basename(input.localCopy)} locally now`);
            } },
        }));
    const job = copiesOf(input);
    const busy = job && ['audio', 'video'].some(
        (w) => job[w].state === 'waiting' || job[w].state === 'probing' ||
               job[w].state === 'queued' || job[w].state === 'running');
    out.push(el('button', {
        cls: 'tiny', 'data-f': 'srclocal',
        text: busy ? 'Pulling…' : (job ? 'Pull it again' : 'Save a local copy'),
        disabled: !input.probe || !!busy,
        title: input.probe ? 'Save local copy of stream' : 'Not opened yet',
        on: { click: () => { if (hooks.saveLocally) hooks.saveLocally(input); } },
    }));
    out.push(el('button', {
        cls: 'tiny', 'data-f': 'srclocalhand', text: 'Describe it…',
        disabled: !input.probe,
        title: 'Configure copy on Write stage',
        on: { click: () => { if (hooks.describeCopy) hooks.describeCopy(input); } },
    }));
    return out;
}

export function localCopySection(input, ctx) {
    if (!input.origin && !input.renditions) return [];
    return [head('On this machine'), copyFolderRow(ctx), ...localCopyRows(input, ctx)];
}

function copyFolderRow(ctx) {
    const hooks = ctx.hooks();
    const dir = hooks.copiesGo ? hooks.copiesGo() : '.';
    const chosen = copyFolder();
    const why = chosen
        ? 'chosen — every copy goes here'
        : dir === '.'
        ? 'the folder this application was started in — save the document, or choose one'
        : 'beside the document';
    const nodes = [
        span(dir, 'mono'),
        span(why, 'dim'),
        el('button', {
            cls: 'tiny', 'data-f': 'srccopydir', text: 'Choose…',
            title: 'Choose local copy folder',
            on: { click: () => {
                if (typeof showOpenFolderDialog !== 'function') return;
                const picked = showOpenFolderDialog(dir === '.' ? null : dir);
                if (!picked || !picked.length) return;
                useCopyFolder(String(picked[0]));
                ctx.drawSources();
            } },
        }),
    ];
    if (chosen)
        nodes.push(el('button', {
            cls: 'tiny', 'data-f': 'srccopydirclear', text: 'Beside the document',
            title: 'Use document folder',
            on: { click: () => { useCopyFolder(''); ctx.drawSources(); } },
        }));
    return row('Folder', nodes);
}

function localCopyRows(input, ctx) {
    const job = copiesOf(input);
    if (!job) return [];
    const rows = [];
    const line = (which, what) => {
        const pull = job[which];
        if (!pull.state) return;
        const word = PULL_WORDS[pull.state] || pull.state;
        const pct = pull.state === 'running'
            ? ` ${Math.round(pull.progress * 100)}%` : '';
        const size = pull.bytes ? ` · ${bytes(pull.bytes)}` : '';
        const stoppable = pull.state === 'waiting' || pull.state === 'probing' ||
                          pull.state === 'queued' || pull.state === 'running';
        rows.push(row(what, [
            span(`${word}${pct}${size}`, 'mono' + (pull.state === 'failed' ? ' warn' : '')),
            pull.path ? el('span', { cls: 'dim', text: basename(pull.path),
                                     title: pull.path }) : null,
            stoppable ? el('button', {
                cls: 'tiny', 'data-f': `srcstop-${which}`, text: 'Stop',
                title: 'Stop pull',
                on: { click: () => { cancelCopy(input, which); ctx.drawSources(); } },
            }) : null,
            pull.error ? note(pull.error) : null,
        ]));
    };
    line('audio', 'Sound');
    line('video', 'Picture');
    if (job.audio.state === 'done')
        rows.push(note('The soundtrack is on this machine — the picture can go on arriving.'));
    if (!job.sameClock && job.audio.state === 'done')
        rows.push(note('These are two renditions of one recording and they do not share a zero.'));
    return rows;
}

const decoderOptionCache = new Map();

function decoderOptionsFor(name) {
    if (!decoderOptionCache.has(name)) {
        try {
            decoderOptionCache.set(name, bro.ffmpeg.decoderOptions(name) || []);
        } catch (e) {
            decoderOptionCache.set(name, []);
        }
    }
    return decoderOptionCache.get(name);
}

function decoderNames(input) {
    const p = input.probe;
    if (!p) return [];
    const out = [];
    for (const s of p.streams)
        if (s.codec && (s.kind === 'video' || s.kind === 'audio') && out.indexOf(s.codec) < 0)
            out.push(s.codec);
    return out;
}

export function optionRows(input, ctx) {
    const demuxer = input.format || (input.probe ? input.probe.format.name : '');
    const out = [];
    if (demuxer) {
        const all = bro.ffmpeg.demuxerOptions(demuxer) || [];
        out.push(...optionColumn({
            name: 'demuxoptsearch',
            title: `${demuxer} options · ${all.length}`,
            options: all,
            bag: input.options,
            hint: 'An unknown key stops the open rather than being ignored.',
            onChange: () => { reprobe(input); ctx.reopened(input); },
        }));
    }

    for (const codec of decoderNames(input)) {
        const all = decoderOptionsFor(codec);
        if (!all.length) continue;
        out.push(...optionColumn({
            name: `decoptsearch-${codec}`,
            title: `${codec} decoder options · ${all.length}`,
            options: all,
            bag: input.decoderOptions,
            hint: 'These reach playback and the render alike.',
            onChange: () => { reprobe(input); ctx.reopened(input); },
        }));
    }

    const scheme = schemeOf(input.path);
    if (scheme) {
        const all = bro.ffmpeg.protocolOptions(scheme) || [];
        if (all.length)
            out.push(...optionColumn({
                name: 'protooptsearch',
                title: `${scheme} options · ${all.length}`,
                options: all,
                bag: input.options,
                hint: 'Timeouts, certificates, buffer sizes.',
                onChange: () => { reprobe(input); ctx.reopened(input); },
            }));
    }
    return out;
}

// ── what it turned out to contain ──────────────────────────────────────────

export function contentRows(input) {
    if (opening(input)) return [];
    if (input.error)
        return [
            head('Refused'),
            div('src-error', input.error),
        ];
    if (!input.probe) return [];
    return fileRows(input.probe);
}

function fileRows(p) {
    return [
        head('What came back'),
        div('src-file', [
            el('span', { cls: 'mono src-file-name', text: p.format.name,
                         title: p.format.longName || p.format.name }),
            span([p.format.duration ? clock(p.format.duration) : '',
                  p.format.size ? bytes(p.format.size) : '',
                  p.format.bitRate ? kbps(p.format.bitRate) : ''].filter(Boolean).join(' · '),
                 'dim'),
        ]),
        ...p.streams.map(streamLine),
    ];
}

function streamLine(s) {
    const kind = s.kind === 'video' ? 'V' : s.kind === 'audio' ? 'A'
               : s.kind === 'data' ? 'D' : 'S';
    const bits = [];
    const more = [s.codecLong || s.codec];
    if (s.tag) (s.kind === 'data' ? bits : more).push(s.tag);
    if (s.kind === 'video') {
        bits.push(`${s.width}×${s.height}` +
                  (s.rotation ? ` → ${s.displayWidth}×${s.displayHeight}` : ''));
        if (s.fps) bits.push(`${s.fps.toFixed(2)} fps`);
        if (s.pixFmt) bits.push(s.pixFmt);
        if (s.colorSpace || s.colorRange) {
            bits.push(s.colorSpace || 'untagged');
            more.push(`colour ${s.colorSpace || 'untagged'} · ` +
                      `${s.colorRange || 'range untagged'}`);
        }
        if (s.rotation) more.push(`rotated ${s.rotation}°`);
        if (s.sampleAspect && Math.abs(s.sampleAspect - 1) > 0.001)
            more.push(`pixel aspect ${s.sampleAspect.toFixed(4)}`);
    } else if (s.kind === 'audio') {
        bits.push(`${s.sampleRate} Hz`);
        bits.push(s.channelLayout || `${s.channels} ch`);
        if (s.sampleFmt) more.push(`samples ${s.sampleFmt}`);
    }
    if (s.bitRate) bits.push(kbps(s.bitRate));
    if (s.profile) more.push(`profile ${s.profile}`);
    if (s.language) more.push(s.language);
    if (s.title) more.push(s.title);
    if (s.duration) more.push(`${s.duration.toFixed(3)} s`);

    return el('div', { cls: 'src-stream', title: more.join('\n') }, [
        span(`${kind}${s.index}`, 'src-stream-n'),
        span(s.codec, 'mono'),
        span(bits.join(' · '), 'src-stream-what dim'),
    ]);
}
