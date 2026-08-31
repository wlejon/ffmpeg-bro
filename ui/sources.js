// The inputs: what will be opened, how, and what came back.
//
// This stage was a read-only list derived from the timeline — distinct paths,
// one card each, straight out of `probe()`. That is a description of an NLE's
// idea of a source, and it is the wrong end of ffmpeg: an input is an `-i`, it
// carries a demuxer and an option bag and a window, and it exists whether or
// not anything is cut from it. So the stage is where inputs are *added,
// configured and understood*.
//
// Three columns, in the order the questions are asked. Which inputs there are,
// what this one is set to and what it turned out to contain, and — beside it —
// the demuxer's own option table, drawn by the component the encoder's and the
// muxer's columns use (see ui/opttable.js).

import { div, span, el, put, row, head, fromTemplate, show, segmented,
         select } from './dom.js';
import { devicesFor, deviceNamed, decodeCost, deviceIndices,
         unknownDeviceIndex } from './hardware.js';
import { clock, bytes, kbps, basename } from './format.js';
import { inputs, addInput, updateInput, reprobe, removeInput, summary, schemeOf,
         lengthOf, kindOf, endless, opening, stopOpening, tickInputs,
         pickerPattern } from './inputs.js';
import { typedSpec, concatSpec, SEQUENCE_FPS } from './sequence.js';
import { copiesOf, cancel as cancelCopy, tickLocalCopies,
         copyFolder, useCopyFolder, PULL_WORDS } from './localcopy.js';
import { capture } from './capture.js';
import { optionColumn } from './opttable.js';
import { note } from './export/controls.js';
import * as graph from './graph/overlay.js';
import { COMPOSITE_POINT } from './graph/derive.js';
import { streamsOf } from './export/streams.js';
import { readsInput, filterPath } from './export/subtitles.js';
import { goTo } from './shell.js';

let refs = {};
let hooks = {};
let chosenId = '';
let demuxerOpen = false;
let demuxerSearch = '';

export function initSources(nodes, h) {
    refs = nodes || {};
    hooks = h || {};

    if (refs.add && refs.addPath) {
        const added = (input) => {
            refs.addPath.value = '';
            chosenId = input.id;
            if (input.error && hooks.flash) hooks.flash(input.error);
            if (hooks.changed) hooks.changed();
            drawSources();
        };
        const add = () => {
            const path = refs.addPath.value.trim();
            if (!path) return;
            added(addInput(typedSpec(path)));
        };

        refs.add.addEventListener('click', add);
        refs.addPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    }

    if (refs.browse) {
        refs.browse.addEventListener('click', () => {
            const openFn = typeof showOpenFileDialog === 'function'
                ? showOpenFileDialog
                : (typeof window !== 'undefined' && typeof window.showOpenFileDialog === 'function' ? window.showOpenFileDialog : null);
            if (openFn) {
                // **Asked, and in two filters.** The nine extensions written
                // here by hand were the mistake `containersFor` names — MXF and
                // MPEG-TS compiled in and unreachable from the one button that
                // browses for them — and the `*` on the end was worse than
                // useless: SDL takes `*` only as a whole pattern, so it refused
                // the filter, and a refused dialog never opens and answers with
                // no files. This press did nothing at all.
                const res = openFn(`Media files|${pickerPattern()}|All files|*`, true);
                const paths = Array.isArray(res) ? res : (res ? [res] : []);
                for (const p of paths) {
                    const inp = addInput(typedSpec(p));
                    if (inp) {
                        chosenId = inp.id;
                        if (inp.error && hooks.flash) hooks.flash(inp.error);
                    }
                }
                if (paths.length) {
                    if (hooks.changed) hooks.changed();
                    drawSources();
                }
            }
        });
    }

    if (refs.join) refs.join.addEventListener('click', () => {
        joinOpen = !joinOpen;
        drawSources();
    });

    // B3. Stage drop target for dragging and dropping media files
    const stage = refs.stage || (typeof document !== 'undefined' ? document.getElementById('st-sources') : null);
    if (stage) {
        stage.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            stage.classList.add('drop-over');
        });
        stage.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            stage.classList.add('drop-over');
        });
        stage.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!stage.contains(e.relatedTarget)) {
                stage.classList.remove('drop-over');
            }
        });
        stage.addEventListener('dragend', () => {
            stage.classList.remove('drop-over');
        });
        stage.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            stage.classList.remove('drop-over');
            const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
            let addedAny = false;
            for (const f of files) {
                const p = f.path || f.name;
                if (p) {
                    const inp = addInput(typedSpec(p));
                    if (inp) {
                        chosenId = inp.id;
                        if (inp.error && hooks.flash) hooks.flash(inp.error);
                        addedAny = true;
                    }
                }
            }
            if (addedAny) {
                if (hooks.changed) hooks.changed();
                drawSources();
            }
        });
    }
}

let joinOpen = false;
const joining = new Set();

function chosen() {
    return inputs.find((i) => i.id === chosenId) || inputs[0] || null;
}

export function drawSources() {
    if (!refs.list) return;
    if (refs.join) refs.join.classList.toggle('on', joinOpen);
    drawList();
    drawDetail();
}

const waitingText = new Map();

export function tickSources() {
    const opened = tickInputs();
    const pulled = tickLocalCopies();
    const settled = opened || pulled;
    if (settled) {
        waitingText.clear();
        drawSources();
        if (hooks.changed) hooks.changed();
        return;
    }
    for (const [id, node] of waitingText) {
        const input = inputs.find((i) => i.id === id);
        if (input && input.opening) node.textContent = waitingLabel(input);
    }
}

function waitingOn(input) { return kindOf(input) === 'device' ? 'device' : 'url'; }

function waitingLabel(input) {
    const o = input.opening || {};
    const secs = `${(o.elapsed || 0).toFixed(1)}s`;
    const verb = waitingOn(input) === 'device' ? 'Opening' : 'Connecting';
    return o.timeout > 0 ? `${verb} · ${secs} of ${o.timeout.toFixed(0)}` : `${verb} · ${secs}`;
}

// ── the list ───────────────────────────────────────────────────────────────

function graphReads() {
    return new Set(graph.sourceInputs());
}

function streamReads() {
    const out = new Set();
    for (const s of streamsOf()) {
        const at = readsInput(s);
        if (at) out.add(at.input);
    }
    return out;
}

function drawList() {
    const current = chosen();
    const reads = graphReads();
    const subtitleWriters = streamReads();
    put(refs.list, () => {
        // B4. Visible status chip/banner when Join mode is armed
        const joinBannerNode = joinOpen ? div('src-join-banner', [
            span(`Join mode armed · ${joining.size} selected`, 'src-join-chip'),
            el('button', {
                cls: 'tiny btn-cancel-join',
                text: '✕',
                title: 'Cancel Join mode',
                on: { click: () => { joining.clear(); joinOpen = false; drawSources(); } },
            }),
        ]) : null;

        if (!inputs.length)
            return [
                joinBannerNode,
                div('src-empty', [
                    div('src-empty-title', 'No inputs'),
                    div('src-empty-note dim', 'Drop media files here'),
                ]),
                ...graphFileRows(),
            ].filter(Boolean);

        if (joinOpen) return [joinBannerNode, ...joinRows()].filter(Boolean);

        return [joinBannerNode, ...inputs.map((input) => {
            const node = fromTemplate('tpl-input');
            const used = hooks.clipsOf ? hooks.clipsOf(input).length : 0;
            const inGraph = reads.has(input.id);
            node.classList.toggle('on', input === current);
            node.classList.toggle('bad', !!input.error);
            node.setAttribute('data-input', input.id);
            node.tabIndex = 0;
            node.querySelector('.src-n').textContent = `${inputs.indexOf(input)}`;
            node.querySelector('.src-name').textContent = input.name;
            node.querySelector('.src-where').textContent = input.path;

            const setEl = node.querySelector('.src-set');
            setEl.innerHTML = '';
            const rawParts = (summary(input) || '').trim().split(/\s+/).filter(Boolean);
            const flags = [];
            for (let i = 0; i < rawParts.length; i++) {
                if (rawParts[i].startsWith('-') && i + 1 < rawParts.length && !rawParts[i + 1].startsWith('-')) {
                    flags.push(`${rawParts[i]} ${rawParts[i + 1]}`);
                    i++;
                } else if (rawParts[i]) {
                    flags.push(rawParts[i]);
                }
            }
            for (const flag of flags) {
                setEl.appendChild(el('span', { cls: 'src-chip mono', text: flag }));
            }

            const written = subtitleWriters.has(inputs.indexOf(input));
            const recorded = capture.inputs.indexOf(input.id) >= 0;
            const use = node.querySelector('.src-used');
            use.textContent =
                opening(input) ? (waitingOn(input) === 'device' ? 'opening' : 'connecting')
                : input.error ? 'unreadable'
                : [used ? `${used} clip${used === 1 ? '' : 's'}` : '',
                   recorded ? 'recording' : '',
                   written ? 'written' : '',
                   inGraph ? 'in the graph' : ''].filter(Boolean).join(' · ') || 'unused';

            node.addEventListener('click', () => {
                chosenId = input.id;
                demuxerOpen = false;
                drawSources();
            });
            node.addEventListener('keydown', (e) => {
                const idx = inputs.indexOf(input);
                if (e.key === 'ArrowDown' && idx < inputs.length - 1) {
                    e.preventDefault();
                    chosenId = inputs[idx + 1].id;
                    drawSources();
                } else if (e.key === 'ArrowUp' && idx > 0) {
                    e.preventDefault();
                    chosenId = inputs[idx - 1].id;
                    drawSources();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (hooks.use && !blocked(input)) hooks.use(input);
                }
            });
            return node;
        }), ...graphFileRows()].filter(Boolean);
    });
}

function unescapePath(text) {
    let s = String(text || '').trim();
    if (s.length > 1 && s[0] === '\'' && s[s.length - 1] === '\'') s = s.slice(1, -1);
    return s.replace(/\\(.)/g, '$1');
}

function graphFileRows() {
    const nodes = graph.nodes().filter((n) => n.filter === 'movie' || n.filter === 'amovie');
    if (!nodes.length) return [];
    return [
        head('Opened by the graph'),
        ...nodes.map((n) => {
            const named = (n.params && n.params.filename) || (n.pos && n.pos[0]) || '';
            const path = unescapePath(named);
            return div('src-demux', [
                span(n.filter, 'mono'),
                span(path || 'no file named yet', path ? 'dim' : 'src-missing'),
                path ? el('button', {
                    cls: 'tiny', 'data-f': 'srcadopt', text: 'Add',
                    title: 'Add as input',
                    on: { click: () => {
                        const made = addInput(typedSpec(path));
                        chosenId = made.id;
                        if (made.error && hooks.flash) hooks.flash(made.error);
                        if (hooks.changed) hooks.changed();
                        drawSources();
                    } },
                }) : null,
            ]);
        }),
    ];
}

function joinRows() {
    const candidates = inputs.filter((i) => kindOf(i) !== 'concat' && i.probe);
    const chosenPaths = () =>
        candidates.filter((i) => joining.has(i.id)).map((i) => i.path);

    const rows = [
        head('Read end to end', { title: 'Read files end to end before decoding, on the timeline' }),
        ...candidates.map((input) => el('button', {
            cls: `src-demuxer tiny${joining.has(input.id) ? ' on' : ''}`,
            'data-join': input.id,
            on: { click: () => {
                if (joining.has(input.id)) joining.delete(input.id);
                else joining.add(input.id);
                drawSources();
            } },
        }, [
            span(joining.has(input.id) ? '✓' : '·', 'mono'),
            span(input.name),
            span(clock(lengthOf(input)), 'dim mono'),
        ])),
    ];

    if (!candidates.length)
        rows.push(div('dim pad', 'Add two files first.'));

    rows.push(div('src-actions', [
        el('button', {
            cls: 'tiny primary', 'data-f': 'srcjoingo', text: 'Join',
            title: 'Join selected inputs',
            disabled: chosenPaths().length < 2,
            on: { click: () => {
                const made = addInput(concatSpec(chosenPaths()));
                joining.clear();
                joinOpen = false;
                chosenId = made.id;
                if (made.error && hooks.flash) hooks.flash(made.error);
                if (hooks.changed) hooks.changed();
                drawSources();
            } },
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'srcjoincancel', text: 'Cancel',
            on: { click: () => { joining.clear(); joinOpen = false; drawSources(); } },
        }),
    ]));
    return rows;
}

// ── the input ──────────────────────────────────────────────────────────────

function drawDetail() {
    const input = chosen();
    show(refs.options, !!input);
    if (!input) {
        put(refs.detail, () => []);
        put(refs.options, () => []);
        put(refs.foot, () => []);
        return;
    }

    put(refs.detail, () => [
        head(input.name, { cls: 'section-head src-title', title: input.path }),
        ...whereRows(input),
        ...localCopySection(input),
        ...demuxerRows(input),
        ...assemblyRows(input),
        ...decodeRows(input),
        ...windowRows(input),
        ...contentRows(input),
    ]);

    put(refs.foot, () => footRows(input));
    put(refs.options, () => optionRows(input));
}

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

function whereRows(input) {
    const path = el('input', {
        cls: 'wide', 'data-f': 'srcpath', type: 'text', value: input.path,
        title: 'File path or URL',
        on: { change: () => change(input, { path: path.value.trim() }) },
    });
    const rows = [row('From', path)];

    const scheme = schemeOf(input.path);
    const protocols = (bro.ffmpeg.protocols && bro.ffmpeg.protocols.input) || [];
    if (scheme) {
        const known = protocols.indexOf(scheme) >= 0;
        rows.push(row('Over', el('span', {
            cls: known ? 'mono' : 'mono src-missing',
            text: known ? scheme : `${scheme} — not in this build`,
            title: known
                ? `libavformat links ${scheme}, one of ${protocols.length} input protocols`
                : `This build has no ${scheme} protocol, so the open fails with a message about a filename`,
        })));
    }
    if (opening(input)) rows.push(...waitingRows(input));
    return rows;
}

function waitingRows(input) {
    const readout = span(waitingLabel(input), 'mono src-waiting');
    waitingText.set(input.id, readout);
    const device = waitingOn(input) === 'device';
    return [
        row(device ? 'Opening' : 'Connecting', readout),
        row('', el('button', {
            cls: 'tiny', 'data-f': 'srcstop', text: device ? 'Stop waiting' : 'Stop',
            title: device ? 'Stop waiting for device' : 'Abandon opening',
            on: { click: () => { stopOpening(input); } },
        })),
    ];
}

function demuxerRows(input) {
    const probed = input.probe ? input.probe.format.name : '';
    const rows = [row('Read as', div('src-demux', [
        el('span', {
            cls: input.format ? 'mono' : 'mono dim',
            text: input.format || probed || 'not read yet',
            title: input.format
                ? `-f ${input.format} — forced, so libavformat is not asked`
                : 'Probed: libavformat worked it out from the file itself',
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'demuxpick',
            text: demuxerOpen ? 'Close' : 'Change…',
            title: 'Select demuxer (-f)',
            on: { click: () => { demuxerOpen = !demuxerOpen; drawSources(); } },
        }),
        input.format && el('button', {
            cls: 'tiny', 'data-f': 'demuxprobe', text: 'Auto',
            title: 'Auto-detect demuxer',
            on: { click: () => change(input, { format: '' }) },
        }),
    ]))];

    if (demuxerOpen) rows.push(demuxerPicker(input));
    return rows;
}

function demuxerPicker(input) {
    const list = div('src-picker');
    const draw = () => put(list, () => {
        const term = demuxerSearch.trim().toLowerCase();
        const all = bro.ffmpeg.demuxers || [];
        const matching = term
            ? all.filter((d) => d.name.toLowerCase().indexOf(term) >= 0 ||
                                (d.longName || '').toLowerCase().indexOf(term) >= 0 ||
                                (d.extensions || []).some((e) => e.indexOf(term) >= 0))
            : all;
        const shown = matching.slice(0, 24);
        const out = shown.map((d) => el('button', {
            cls: 'src-demuxer tiny' + (d.name === input.format ? ' on' : ''),
            'data-demuxer': d.name,
            on: { click: () => { demuxerOpen = false; change(input, { format: d.name }); } },
        }, [
            span(d.name, 'mono'),
            span(d.longName || '', 'dim'),
            d.extensions && d.extensions.length ? span(d.extensions.join(' '), 'dim mono') : null,
        ]));
        if (matching.length > shown.length)
            out.push(div('ex-note dim',
                         `and ${matching.length - shown.length} more — narrow the search`));
        return out;
    });

    const search = el('input', {
        cls: 'wide', 'data-f': 'demuxsearch', type: 'text', value: demuxerSearch,
        placeholder: `name, description or extension`,
        on: { input: () => { demuxerSearch = search.value; draw(); } },
    });
    draw();
    return div('src-pick', [row('Find', search), list]);
}

function optionField(input, key, opts = {}) {
    const field = el('input', {
        cls: opts.wide ? 'wide' : 'num', 'data-f': opts.name || key, type: 'text',
        value: input.options[key] !== undefined ? String(input.options[key]) : '',
        placeholder: opts.hint || '',
        title: opts.title || `-${key}`,
        on: { change: () => {
            const next = Object.assign({}, input.options);
            const v = field.value.trim();
            if (v) next[key] = v; else delete next[key];
            change(input, { options: next });
        } },
    });
    return field;
}

function assemblyRows(input) {
    switch (kindOf(input)) {
        case 'sequence': return sequenceRows(input);
        case 'still':    return stillRows(input);
        case 'concat':   return concatRows(input);
        case 'device':   return deviceRows(input);
        case 'subtitles': return subtitleRows(input);
        default:         return [];
    }
}

function subtitleRows(input) {
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
                on: { click: () => burnIn(input) },
            }),
        ])),
    ];
}

function burnIn(input) {
    graph.insert(COMPOSITE_POINT, 'subtitles',
                 { params: { filename: filterPath(input.path) } });
    if (hooks.changed) hooks.changed();
    goTo('graph');
}

function deviceRows(input) {
    return [
        strip('Live', 'plays now and cannot be cut',
              'Stop at gives one a length, but a device cannot seek. Record a segment on the Capture stage and use that file instead.',
              doorTo('Capture', 'capture', 'Watch it, compose it, record or stream it')),
    ];
}

function sequenceRows(input) {
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
        }),
        span('fps', 'dim'),
    ]));

    rows.push(row('First number', optionField(input, 'start_number', {
        name: 'seqstart', hint: '0',
        title: '-start_number',
    })));

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
            change(input, { options: next });
        }),
    ])));
    return rows;
}

function stillRows(input) {
    const seconds = el('input', {
        cls: 'num', 'data-f': 'stillhold', type: 'text',
        value: input.to ? String(input.to) : '',
        placeholder: '0',
        title: '-loop 1 -t',
        on: { change: () => {
            const next = Object.assign({}, input.options, { loop: '1' });
            if (!next.framerate) next.framerate = String(SEQUENCE_FPS);
            change(input, { to: Number(seconds.value) || 0, options: next,
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
            }),
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

function decodeRows(input) {
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
        on: { change: () => change(input, {
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
            on: { change: () => change(input, { hwaccelDevice: which.value }) },
        }, choices, stored);
        rows.push(row('Which one', which));

        rows.push(row('Pictures', segmented('srchwkeep', [
            { v: '', l: 'bring down', title: 'Decode to system memory' },
            { v: dev ? dev.pixelFormat : '', l: 'keep on the card', title: '-hwaccel_output_format' },
        ], input.hwaccelOutputFormat || '',
            (v) => change(input, { hwaccelOutputFormat: v }))));
    }
    return rows;
}

// B5. Dual-handle range bar control for input read window
function windowRows(input) {
    const number = (name, key, value, hint, why, unit) => {
        const field = el('input', {
            cls: 'num', 'data-f': name, type: 'text', value: value ? String(value) : '',
            placeholder: hint, title: why,
            on: { change: () => change(input, { [key]: Number(field.value) || 0 }) },
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
                change(input, { ss: Math.max(0, val) });
            } }
        });
        const maxSlider = el('input', {
            cls: 'dual-range-max', type: 'range', min: '0', max: String(dur), step: '0.01',
            value: String(toVal),
            on: { input: () => {
                const val = Math.max(Number(maxSlider.value) || 0, (input.ss || 0) + 0.01);
                change(input, { to: Math.min(dur, val) });
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

function blocked(input) {
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

function footRows(input) {
    const used = hooks.clipsOf ? hooks.clipsOf(input) : [];
    const inGraph = graphReads().has(input.id);
    const why = blocked(input);
    return [
        el('button', {
            cls: 'src-go', 'data-f': 'srcuse', text: 'Use on the timeline',
            disabled: !!why,
            title: why || 'Cut a clip of the whole window and lay it on the timeline',
            on: { click: () => { if (hooks.use) hooks.use(input); } },
        }),
        why ? el('span', { cls: 'src-why', text: why }) : null,
        div('spacer'),
        ...localCopyButtons(input),
        el('button', {
            cls: 'tiny', 'data-f': 'srcreopen', text: 'Re-probe',
            title: 'Re-probe input',
            on: { click: () => { reprobe(input); reopened(input); } },
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
                chosenId = '';
                if (hooks.changed) hooks.changed();
                drawSources();
            } },
        }),
    ];
}

function localCopyButtons(input) {
    if (!input.origin && !input.renditions) return [];
    const out = [];
    if (input.localCopy)
        out.push(el('button', {
            cls: 'tiny', 'data-f': 'srclocaluse', text: 'Use the local copy',
            title: `Use local copy ${basename(input.localCopy)}`,
            on: { click: () => {
                change(input, { path: input.localCopy });
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

function localCopySection(input) {
    if (!input.origin && !input.renditions) return [];
    return [head('On this machine'), copyFolderRow(), ...localCopyRows(input)];
}

function copyFolderRow() {
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
                drawSources();
            } },
        }),
    ];
    if (chosen)
        nodes.push(el('button', {
            cls: 'tiny', 'data-f': 'srccopydirclear', text: 'Beside the document',
            title: 'Use document folder',
            on: { click: () => { useCopyFolder(''); drawSources(); } },
        }));
    return row('Folder', nodes);
}

function localCopyRows(input) {
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
                on: { click: () => { cancelCopy(input, which); drawSources(); } },
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

function optionRows(input) {
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
            onChange: () => { reprobe(input); reopened(input); },
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
            onChange: () => { reprobe(input); reopened(input); },
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
                onChange: () => { reprobe(input); reopened(input); },
            }));
    }
    return out;
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

function change(input, patch) {
    if (updateInput(input, patch)) reopened(input);
    else drawSources();
}

// B6. Re-probe feedback triggers OSD toast
function reopened(input) {
    if (hooks.flash) {
        hooks.flash(input.error || `Re-probed ${input.name}`);
    }
    if (hooks.reopened) hooks.reopened(input);
    drawSources();
}

// ── what it turned out to contain ──────────────────────────────────────────

function contentRows(input) {
    if (opening(input)) return [];
    if (input.error)
        return [
            head('Refused'),
            div('src-error', input.error),
        ];
    if (!input.probe) return [];
    return fileRows(input.probe, input);
}

function fileRows(p, input) {
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
