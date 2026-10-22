// The column beside the graph: what a node is set to, what can be put on a
// wire, and what a wire is.
//
// Four modes over one panel, because they are all halves of one gesture. You
// click a `+` on a wire and pick a filter; the filter appears and is selected,
// and the panel is now showing its arguments. You let a wire go over empty
// canvas and pick a filter; it lands there, wired to where you came from, and
// the panel is showing *its* arguments. Splitting any of that into a second
// surface would mean the thing you just made is somewhere other than where you
// were looking.
//
// The fourth mode is a wire, which is not a node and still has something to
// say: which pads it joins, and whether it is the derivation's or yours —
// because that decides what deleting it means and how it comes back.
//
// **The option table is libavfilter's, not ours.** `bro.ffmpeg.filterOptions()`
// walks the filter's own `AVClass` — names, types, ranges, defaults, enum
// constants and help text — exactly as the encoder's advanced column walks an
// encoder's. There are five hundred filters in this build and no list of them
// is written down here; a filter that ffmpeg gains, this panel gains.
//
// **Positional arguments are edited as themselves.** A derived `crop` carries
// four numbers rather than `w=…:h=…:x=…:y=…`, because that is what was written
// and printing a normalisation of it would print something other than the
// command that runs. So the panel edits them in place, labelled with the names
// the derivation recorded — see `posNames` in model.js for why they cannot be
// recovered from the option table.
//
// **Editing anything locks it, and the lock is the point.** A value you typed
// that the next timeline drag silently reverted is the worst outcome available
// here. So a derived node you have touched keeps what you gave it, the skeleton
// around it still regenerates, and every place that could disagree — the node,
// this panel, the properties panel's own control, the spine — says which one
// won.

import { el, div, span, put, head, row } from '../dom.js';
import { optionsOf, infoOf } from './filters.js';
import { inputs as documentInputs } from '../inputs.js';
import { isUserOutput } from './check.js';
import { whenRows } from './when.js';
import { curveRows } from './curve.js';
import * as overlay from './overlay.js';
// The other half of renaming an output. A name is one fact and it is written in
// two places — the node, and every stream row fed from it — so the two move
// together at the moment the rename commits. This stage does not otherwise know
// the Write stage exists, and does not learn anything else about it here.
import { renamePad } from '../export/pads.js';
import { graphSummary } from './view.js';
import { namedRows, palette, padPalette, wirePanel, driftRows } from './panel-palette.js';

let refs = {};
let hooks = {};

/// `{ kind: 'node', key } | { kind: 'point', id } | null`. Both are held by
/// name rather than by object, because the object is thrown away and remade
/// every time the timeline moves — see `keyOf`.
let sel = null;
let search = '';
let graph = null;
/// The insert points the last derivation declared. Held so that an open one can
/// be re-resolved rather than trusted — see `contents`.
let points = [];
/// How many nodes are selected in total. The panel is about one of them — a
/// column of forty options for four nodes at once is not a thing — but it has to
/// say that there are others, or a `Delete` that takes four away is a surprise.
let selectedCount = 0;

/// What survives a rebuild. A user node's id does; a derived node's does not,
/// but its anchor does.
///
/// It lives in `model.js` now, because a hand-made wire's two ends are written
/// as exactly this and the overlay cannot import a panel. Re-exported here
/// because half the application asks the panel for it and renaming that would
/// be churn for nothing.
export { keyOf } from './model.js';
import { streamWord } from './model.js';

const panelCtx = {
    getSearch: () => search,
    setSearch: (v) => { search = v; },
    noteEdit: () => noteEdit(),
    changed: () => changed(),
    hooks: () => hooks,
    graph: () => graph,
    find: (g, k) => find(g, k),
    empty: () => empty(),
    clearSel: () => { sel = null; },
    cancel: () => { sel = null; draw(graph, trouble, points); },
    selectPlaced: (rec, pad) => {
        sel = { kind: 'node', key: rec.id };
        search = '';
        if (hooks.placed) hooks.placed(rec, pad);
        else changed();
    },
    selectInserted: (rec) => {
        sel = { kind: 'node', key: rec.id };
        search = '';
        changed();
    },
};

export function initPanel(r, h) {
    refs = r;
    hooks = h || {};
}

export function selectedPoint() { return sel && sel.kind === 'point' ? sel.id : null; }

export function selectNode(key, count) {
    sel = key ? { kind: 'node', key } : null;
    selectedCount = count === undefined ? (key ? 1 : 0) : count;
    draw(graph, trouble, points);
}

/// A `+` somebody clicked. Held **by id**, for the reason a node is held by
/// key: the object is thrown away and remade by the next derivation, and an
/// insert point is the one kind of selection that can stop existing while it is
/// open — the clip it names is one delete away.
export function openPoint(point) {
    sel = point ? { kind: 'point', id: point.id } : null;
    search = '';
    draw(graph, trouble, points);
}

/// A pad with a wire in the air, or a place on the canvas with nothing but a
/// position. Same palette either way — this is "what filter" — and what makes
/// them different is only what the view does with the answer.
export function openPad(pad) {
    sel = pad ? { kind: 'pad', pad } : null;
    search = '';
    draw(graph, trouble, points);
}

/// A wire somebody clicked. `{ key, port, stream }`, or null — names only, for
/// the reason a node is held by key: this outlives the graph it was clicked in.
export function selectWire(wire) {
    sel = wire ? { kind: 'wire', wire } : null;
    selectedCount = 0;
    draw(graph, trouble, points);
}

export function clearSelection() { sel = null; }

/// Draw against the graph as it is now. Called after every derivation, so a
/// selection that no longer exists — a clip trimmed out of the range, a node
/// removed — falls back to nothing rather than to a stale card.
export function draw(g, problems, ps) {
    graph = g;
    trouble = problems || [];
    points = ps || [];
    if (!refs.panel) return;
    noteFocus();
    put(refs.panel, () => contents(g));
    restoreFocus();
}

function contents(g) {
    if (!g || !sel) return empty();
    if (sel.kind === 'point') {
        const point = points.find((p) => p.id === sel.id);
        if (!point) return pointGone();
        return palette(point, panelCtx);
    }
    if (sel.kind === 'pad') return padPalette(sel.pad, panelCtx);
    if (sel.kind === 'wire') return wirePanel(sel.wire, panelCtx);

    const node = find(g, sel.key);
    if (!node) { sel = null; return empty(); }
    return nodePanel(node);
}

/// The wire a `+` was clicked on is not in this graph any more.
function pointGone() {
    return [
        head('Insert'),
        div('gp-desc dim',
            'Target wire is no longer present in graph (clip trimmed or deleted).'),
        el('button', { cls: 'tiny', text: 'Close', 'data-f': 'pointgone',
                       on: { click: () => { sel = null; draw(graph, trouble, points); } } }),
    ];
}

// ── the field being used, across a redraw ──────────────────────────────────

let wanted = null;

const FIELD_ATTRS = ['data-f', 'data-opt', 'data-pos', 'data-edge', 'data-span',
                     'data-point'];

function fieldName(node) {
    if (!node || !node.getAttribute) return '';
    if (node.tagName !== 'INPUT' && node.tagName !== 'SELECT') return '';
    for (const a of FIELD_ATTRS) {
        const v = node.getAttribute(a);
        if (v) return `${a}="${v}"`;
    }
    return '';
}

function noteEdit() { wanted = { name: fieldName(document.activeElement) }; }

function noteFocus() {
    if (wanted || !refs.panel) return;
    const active = document.activeElement;
    const name = fieldName(active);
    if (!name) return;
    if (!refs.panel.contains || !refs.panel.contains(active)) return;
    wanted = { name, value: active.value };
}

function restoreFocus() {
    if (!wanted || !refs.panel) return;
    const { name, value } = wanted;
    wanted = null;
    if (!name) return;
    const node = refs.panel.querySelector(`[${name}]`);
    if (!node) return;
    if (value !== undefined && node.value !== undefined && node.value !== value)
        node.value = value;
    if (node.focus) { try { node.focus(); } catch (e) { /* not focusable here */ } }
}

let trouble = [];

function find(g, key) {
    return g.node(key) || g.byAnchor(key);
}

function empty() {
    const sum = graphSummary();
    const stats = sum.ok ? [
        div('stat-row mono', [
            span(`nodes: ${sum.nodes}`, 'gp-badge'),
            span(`chains: ${sum.chains}`, 'gp-badge'),
            span(`inputs: ${sum.inputs}`, 'gp-badge'),
            span(`user: ${sum.mine}`, 'gp-badge'),
            span(`locks: ${sum.locks}`, 'gp-badge'),
        ])
    ] : [];

    return [
        head('Graph Summary'),
        ...stats,
        div('gp-actions', [
            el('button', {
                cls: 'tiny primary', text: '+ Add node',
                on: { click: () => {
                    openPad({ at: { x: 100, y: 100 } });
                } }
            }),
            el('button', {
                cls: 'tiny', text: 'Collapse',
                on: { click: () => {
                    if (refs.fold) refs.fold.click();
                } }
            })
        ]),
        overlay.isEmpty() ? null : el('button', {
            cls: 'tiny warn', text: 'Clear my filters and locks',
            on: { click: () => { overlay.clear(); sel = null; changed(); } },
        }),
    ].filter(Boolean);
}

// ── a node ─────────────────────────────────────────────────────────────────

function measureAction(node) {
    return el('button', {
        cls: 'tiny', text: 'Measure to here', 'data-f': 'measure-to',
        title: 'Measure to here',
        on: { click: () => { if (hooks.measureTo) hooks.measureTo(node); } },
    });
}

function nodePanel(node) {
    const name = node.kind === 'input' ? `input ${node.index}`
               : node.kind === 'sink' ? (isUserOutput(node)
                    ? (node.name ? `[${node.name}]` : 'an output')
                    : node.stream === 'a' ? 'audio out' : 'video out')
               : node.filter;
    const pads = node.kind === 'input'
        ? (node.outs || [{ stream: node.stream || 'v' }])
              .map((o) => `${node.index}:${o.stream}`).join(', ')
        : '';

    const out = [
        div('gp-head', [
            span(name, 'gp-name mono'),
            node.locked ? span('locked', 'gp-badge locked') : null,
            !node.derived ? span('yours', 'gp-badge user') : null,
            selectedCount > 1 ? span(`+${selectedCount - 1} more`, 'gp-badge') : null,
        ]),
    ];

    out.push(...problemRows(node));

    if (isUserOutput(node)) {
        out.push(...outputRows(node));
        return out;
    }

    if (node.kind !== 'filter') {
        out.push(div('gp-desc dim', node.kind === 'input'
            ? `Input file: ${node.path || ''} (${pads})`
            : 'Muxer output pad mapping.'));
        if (node.kind === 'input' && !node.derived) {
            out.push(div('gp-desc dim', 'Standalone graph input read directly by demuxer.'));
            out.push(...padRows(node));
            out.push(div('gp-actions', [
                el('button', {
                    cls: 'tiny primary', text: 'Sources stage →',
                    on: { click: () => {
                        if (globalThis.__ffmpegBro && globalThis.__ffmpegBro.switchStage) {
                            globalThis.__ffmpegBro.switchStage('sources');
                        }
                    } }
                }),
                el('button', {
                    cls: 'tiny', text: 'Remove', 'data-f': 'remove',
                    on: { click: () => { overlay.removeInsert(node.id); sel = null; changed(); } },
                }),
                measureAction(node)
            ]));
            return out;
        }
        out.push(div('gp-actions', [measureAction(node)]));
        return out;
    }

    const info = infoOf(node.filter);
    if (info && info.description) out.push(div('gp-desc dim', info.description));
    if (node.filter === 'movie' || node.filter === 'amovie') {
        const pathVal = String((node.params && node.params.filename) || (node.pos && node.pos[0]) || '');
        const validatePath = (p) => !p.includes(':') || p.includes('\\:');
        const escapePath = (p) => p.replace(/:/g, '\\:').replace(/,/g, '\\,');
        out.push(div('gp-movie-box', [
            el('input', {
                cls: 'wide mono', type: 'text', value: pathVal, placeholder: 'path…',
                on: {
                    input: (e) => {
                        if (!validatePath(e.target.value)) e.target.classList.add('invalid');
                        else e.target.classList.remove('invalid');
                    },
                    change: (e) => {
                        const val = escapePath(e.target.value.trim());
                        noteEdit();
                        overlay.edit(node, { params: { filename: val } });
                        changed();
                    }
                }
            }),
            el('button', {
                cls: 'tiny', text: 'Use as an input instead',
                on: { click: () => {
                    if (pathVal) {
                        const inp = documentInputs.find(i => i.path === pathVal || i.name === pathVal);
                        if (inp) {
                            overlay.removeInsert(node.id);
                            overlay.addSource(inp.id);
                            sel = null;
                            changed();
                        }
                    }
                } }
            })
        ]));
    }
    out.push(...padRows(node));

    const options = optionsOf(node.filter);
    out.push(...driftRows(node, options, panelCtx));
    out.push(...positionalRows(node, options));
    out.push(...whenRows(node, graph, (value) => {
        noteEdit();
        overlay.edit(node, { params: { enable: value } });
        changed();
    }));
    out.push(...curveRows(node, graph, (slot, value) => {
        noteEdit();
        if (slot.kind === 'pos') {
            const next = node.pos.slice();
            next[slot.index] = value || String(node.pos[slot.index]);
            overlay.edit(node, { pos: next });
        } else {
            overlay.edit(node, { params: { [slot.name]: value } });
        }
        changed();
    }));
    out.push(...namedRows(node, options, panelCtx));

    const actions = [];
    if (!node.derived)
        actions.push(el('button', {
            cls: 'tiny', text: 'Remove', 'data-f': 'remove',
            on: { click: () => { overlay.removeInsert(node.id); sel = null; changed(); } },
        }));
    if (node.locked && node.derived)
        actions.push(el('button', {
            cls: 'tiny', text: 'Unlock', 'data-f': 'unlock',
            title: 'Unlock',
            on: { click: () => { overlay.unlock(node.anchor); changed(); } },
        }));
    actions.push(measureAction(node));
    out.push(div('gp-actions', actions));

    if (node.locked && node.derived)
        out.push(div('gp-desc dim',
            'Locked: timeline trim/crop will not overwrite parameters until unlocked.'));

    return out;
}

function outputRows(node) {
    const out = [];
    const validateName = (n) => {
        if (!n) return true;
        if (n === 'vout' || n === 'aout') return false;
        return /^[a-zA-Z0-9_-]+$/.test(n);
    };
    const field = el('input', {
        cls: 'wide mono', 'data-f': 'outname', type: 'text', value: node.name || '',
        placeholder: 'out2',
        on: {
            input: (e) => {
                if (!validateName(e.target.value.trim())) e.target.classList.add('invalid');
                else e.target.classList.remove('invalid');
            },
            change: (e) => {
                const before = node.name || '';
                const next = e.target.value.trim();
                if (!validateName(next) || next === before) return;
                noteEdit();
                overlay.renameOutput(node.id, next);
                renamePad(before, next);
                changed();
            }
        }
    });
    out.push(row('Name', field));
    out.push(...padRows(node));
    out.push(div('gp-actions', [
        el('button', {
            cls: 'tiny primary', text: 'Map it on Write →',
            on: { click: () => {
                if (globalThis.__ffmpegBro && globalThis.__ffmpegBro.switchStage) {
                    globalThis.__ffmpegBro.switchStage('write');
                }
            } }
        }),
        el('button', {
            cls: 'tiny', text: 'Remove', 'data-f': 'remove',
            on: { click: () => { overlay.removeInsert(node.id); sel = null; changed(); } },
        }),
        measureAction(node)
    ]));
    return out;
}

function problemRows(node) {
    const mine = trouble.filter((p) => p.id === node.id);
    if (!mine.length) return [];
    return [div('gp-problems', mine.map((p) => div('gp-problem', p.reason)))];
}

function padRows(node) {
    const ins = node.ins || [];
    const outs = node.outs || [];
    if (!ins.length && !outs.length) return [];
    const wired = new Set(graph ? graph.inEdges(node).map((e) => e.port || 0) : []);
    const kind = streamWord;
    const rows = [head('Pads')];
    ins.forEach((p, i) => {
        rows.push(row(`in ${i + 1}`, [
            span(kind(p.stream), 'mono'),
            wired.has(i) ? span('wired', 'gp-badge')
                         : span('nothing wired here', 'gp-badge locked'),
        ]));
    });
    outs.forEach((p, i) => {
        const read = graph ? graph.outEdges(node).filter((e) => (e.fromPort || 0) === i).length : 0;
        rows.push(row(`out ${i + 1}`, [
            span(kind(p.stream), 'mono'),
            span(read === 1 ? 'read once' : read ? `read ${read} times` : 'read by nothing',
                 read === 1 ? 'gp-badge' : 'gp-badge locked'),
        ]));
    });
    return rows;
}

function positionalRows(node, options) {
    if (!node.pos.length) return [];
    const names = node.posNames || [];
    return [
        head('Arguments'),
        ...node.pos.map((v, i) => {
            const label = names[i] || `#${i + 1}`;
            const field = el('input', {
                cls: 'wide mono', 'data-pos': String(i), type: 'text', value: String(v),
                on: { change: () => {
                    noteEdit();
                    const next = node.pos.slice();
                    next[i] = field.value.trim() || String(v);
                    overlay.edit(node, { pos: next });
                    changed();
                } },
            });
            const o = options.find((x) => x.name === label);
            return row(label, [field, o && o.help ? div('gp-help dim', o.help) : null]);
        }),
    ];
}

function changed() { if (hooks.changed) hooks.changed(); }
