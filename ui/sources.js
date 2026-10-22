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

import { div, span, el, put, row, head, fromTemplate, show } from './dom.js';
import { clock } from './format.js';
import { inputs, addInput, updateInput, summary, schemeOf,
         lengthOf, kindOf, opening, stopOpening, tickInputs,
         pickerPattern } from './inputs.js';
import { typedSpec, concatSpec } from './sequence.js';
import { tickLocalCopies } from './localcopy.js';
import { capture } from './capture.js';
import * as graph from './graph/overlay.js';
import { streamsOf } from './export/streams.js';
import { readsInput } from './export/subtitles.js';
import { assemblyRows, decodeRows, windowRows, blocked, footRows,
         localCopySection, optionRows, contentRows } from './sources-detail.js';

let refs = {};
let hooks = {};
let chosenId = '';
let demuxerOpen = false;
let demuxerSearch = '';

const detailCtx = {
    hooks: () => hooks,
    change: (input, patch) => change(input, patch),
    reopened: (input) => reopened(input),
    drawSources: () => drawSources(),
    clearChosen: () => { chosenId = ''; },
    graphReads: () => graphReads(),
    waitingOn: (input) => waitingOn(input),
};

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
                    if (hooks.use && !blocked(input, waitingOn)) hooks.use(input);
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
        ...localCopySection(input, detailCtx),
        ...demuxerRows(input),
        ...assemblyRows(input, detailCtx),
        ...decodeRows(input, detailCtx),
        ...windowRows(input, detailCtx),
        ...contentRows(input),
    ]);

    put(refs.foot, () => footRows(input, detailCtx));
    put(refs.options, () => optionRows(input, detailCtx));
}

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
