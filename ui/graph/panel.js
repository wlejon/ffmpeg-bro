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

import { el, div, span, put, head, row, fromTemplate } from '../dom.js';
import { optionsOf, infoOf, allFilters, padsOf, isSource, sourceFilters } from './filters.js';
import { inputs as documentInputs, streamKinds } from '../inputs.js';
import { nameOf, isUserOutput } from './check.js';
import { whenRows } from './when.js';
import { curveRows } from './curve.js';
import * as overlay from './overlay.js';
// The other half of renaming an output. A name is one fact and it is written in
// two places — the node, and every stream row fed from it — so the two move
// together at the moment the rename commits. This stage does not otherwise know
// the Write stage exists, and does not learn anything else about it here.
import { renamePad } from '../export/pads.js';
// The same question about the same shape of data. There were two copies with
// two thresholds and only one of them suppressed a `flags` range, so every
// int32 AVOption printed ±2147483648 here and nowhere else.
import { rangeOf, buildOptionRow } from '../opttable.js';
import { graphSummary } from './view.js';

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
import { streamWord, padTakes } from './model.js';

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
        // Re-resolved rather than held. `derive()` rebuilds the point list from
        // scratch every time, so a `+` opened on a clip's wire and then left
        // open while that clip is deleted names an anchor no derivation
        // declares — and picking a filter would record an insert that
        // `applyOverlay` skips without a word, leaving a record stuck in the
        // overlay for ever and an edit that went to nothing.
        const point = points.find((p) => p.id === sel.id);
        if (!point) return pointGone();
        return palette(point);
    }
    if (sel.kind === 'pad') return padPalette(sel.pad);
    if (sel.kind === 'wire') return wirePanel(sel.wire);

    const node = find(g, sel.key);
    if (!node) { sel = null; return empty(); }
    return nodePanel(node);
}

/// The wire a `+` was clicked on is not in this graph any more.
function pointGone() {
    return [
        head('Insert'),
        div('gp-hint dim',
            'The wire you opened this on is not in the graph any more — the clip it ' +
            'belonged to has been trimmed out of the range, deleted, or had the stream ' +
            'this point was on taken off it. Nothing was put anywhere.'),
        el('button', { cls: 'tiny', text: 'Close', 'data-f': 'pointgone',
                       on: { click: () => { sel = null; draw(graph, trouble, points); } } }),
    ];
}

// ── the field being used, across a redraw ──────────────────────────────────
//
// This column is rebuilt whole on every derivation, and a derivation is not
// only something you asked for: a node preview finishing a second later
// rebuilds the stage too, and it does it while somebody is half way through
// typing `iw*0.5` into a `scale`. Values here commit on `change` —
// deliberately, because committing on `input` locks the node between
// keystrokes — so what has been typed and not yet committed is not in the
// model, and a column rebuilt from the model silently eats it.
//
// The same pair `card.js` has, one column to the right, with the same two
// rules: the field is remembered by *what it is* rather than by which element
// it was, since the element is gone by the time this matters; and an edit that
// has already recorded an intent stands this down, because putting the old
// text back over the value that edit just committed would be undoing it.
//
// Not extracted into something both files call. They identify a field
// differently — a card's is a node key and a param name, this one's is
// whichever attribute the control was built with — and the shared part is four
// lines of `document.activeElement`.
let wanted = null;

/// How a control in this column is named, in the order the attributes are
/// looked for. Every one is written by the code that builds the control, so a
/// control that moves keeps its name. Only fields: a button carries `data-f`
/// too and refocusing one after a redraw would be taking focus rather than
/// keeping it.
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

/// Called from a commit, before the write: keep the focus where it is, and do
/// *not* put the text back — the value the redraw builds is the one that was
/// just committed, and a blank positional argument deliberately comes back as
/// the derived value rather than as the blank.
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

/// Every problem the last derivation found, so the column can say what is wrong
/// with the node it is about — where somebody is looking at that node, rather
/// than only in the bar along the bottom.
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

/// Said here rather than left to be found out.
///
/// The viewer plays a clip's own filters now — its element is pointed at the
/// input with the chain on it, see ui/graph/playback.js — so what is left to
/// say is which filters it does *not* show: the ones over the whole canvas,
/// which belong to no clip and have no element to be played by. A clip whose own
/// chain cannot be shown wears the `fx` badge and says why on the picture, so
/// that half needs nothing here.
function filtersNote() {
    return 'A clip’s own filters play in the viewer. Filters over the whole picture — ' +
           'after compositing, after mixing — run when you render and in the export preview.';
}

// ── a node ─────────────────────────────────────────────────────────────────

/// Run the graph as far as this node and no further, keeping what it measured.
///
/// **The pair of the ▶ on the card.** A preview answers "what does this node
/// produce" with a picture; this answers it with whatever the measuring filters
/// among its ancestors said, which is the half that was missing — `Measure now`
/// on the Report drawer runs the *whole* graph, so a `cropdetect` on one clip's
/// decoded picture cost every other clip, every filter after it, the composite
/// and the mix.
///
/// It is offered on every node rather than only on the ones that measure,
/// because this file does not know which filters measure and must not learn:
/// what makes a filter a measurement is that it emits metadata or logs, and the
/// channel captures both from all of them — see `ui/measure.js`. What is being
/// chosen here is **where the render stops**, which is a fact about the graph
/// and not about the filter.
function measureAction(node) {
    return el('button', {
        cls: 'tiny', text: 'Measure to here', 'data-f': 'measure-to',
        title: 'render the range as far as this node — the filters it depends on and no ' +
               'others — and keep nothing but what they measured. The Report drawer says ' +
               'what came back.',
        on: { click: () => { if (hooks.measureTo) hooks.measureTo(node); } },
    });
}

function nodePanel(node) {
    // An input is a file with a pad per stream it is read for, so it is named
    // for the input it is rather than for one of its pads.
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
        out.push(div('gp-hint dim', node.kind === 'input'
            ? `One file, as ffmpeg would open it — ${pads} — ${node.path || ''}`
            : 'The pad the muxer maps. What leaves here is what gets written.'));
        // An input the graph reads on its own account rather than one a clip is
        // cut from. Worth saying, because everything that decides how it opens
        // is on another stage and this is where somebody is looking at it.
        if (node.kind === 'input' && !node.derived) {
            out.push(div('gp-hint dim',
                'The graph reads this one; nothing on the timeline is cut from it. The ' +
                'demuxer, its options and the window are the input’s — edit them on the ' +
                'Sources stage and this follows.'));
            out.push(...padRows(node));
            out.push(div('gp-actions', [el('button', {
                cls: 'tiny', text: 'Remove', 'data-f': 'remove',
                on: { click: () => { overlay.removeInsert(node.id); sel = null; changed(); } },
            }), measureAction(node)]));
            return out;
        }
        out.push(div('gp-actions', [measureAction(node)]));
        return out;
    }

    const info = infoOf(node.filter);
    if (info && info.description) out.push(div('gp-hint dim', info.description));
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
    out.push(...driftRows(node, options));
    out.push(...positionalRows(node, options));
    // **`enable` is written by a control and edited as text, and they are the
    // same mechanism** — the strip parses the expression and prints one back,
    // exactly as the Quality slider and the advanced editor both produce
    // `{crf: 20}`. It is above the option table rather than in it because
    // `enable` is not in a filter's own AVOption table at all: it belongs to
    // every filter, out of `AVFilterContext`'s class, and whether *this* filter
    // honours it is a flag the registry carries.
    out.push(...whenRows(node, graph, (value) => {
        noteEdit();
        overlay.edit(node, { params: { enable: value } });
        changed();
    }));
    // **`enable` says when the filter is on; this says what its values do while
    // it is.** Beside the When section rather than in the option table, and for
    // the same reason: a value written as an expression is not one more entry to
    // be typed into, it is a shape over the render, and the answer to a question
    // about a shape is a picture of it. Only the options that hold one appear —
    // `curveRows` answers with nothing at all for a filter whose values are
    // numbers, which is almost every filter on the stage.
    out.push(...curveRows(node, graph, (slot, value) => {
        noteEdit();
        if (slot.kind === 'pos') {
            const next = node.pos.slice();
            // A blank positional argument is a parse error rather than an
            // omission — `crop=iw*0.8::0:0` — so an empty answer keeps what was
            // there, exactly as `positionalRows` does.
            next[slot.index] = value || String(node.pos[slot.index]);
            overlay.edit(node, { pos: next });
        } else {
            overlay.edit(node, { params: { [slot.name]: value } });
        }
        changed();
    }));
    out.push(...namedRows(node, options));

    const actions = [];
    if (!node.derived)
        actions.push(el('button', {
            cls: 'tiny', text: 'Remove', 'data-f': 'remove',
            on: { click: () => { overlay.removeInsert(node.id); sel = null; changed(); } },
        }));
    if (node.locked && node.derived)
        actions.push(el('button', {
            cls: 'tiny', text: 'Unlock', 'data-f': 'unlock',
            title: 'Hand this node back to the derivation',
            on: { click: () => { overlay.unlock(node.anchor); changed(); } },
        }));
    // Last, and unconditional — every filter node can be measured to, so the
    // row is never empty and the guard that used to be here never fired.
    actions.push(measureAction(node));
    out.push(div('gp-actions', actions));

    if (node.locked && node.derived)
        out.push(div('gp-hint dim',
            'These values outrank the edit: moving, trimming or cropping this clip ' +
            'will not change them until it is unlocked.'));

    return out;
}

/// An output of your own: what it is called, and what is on it.
///
/// **The name is the whole of the node**, which is why this column is one field.
/// It becomes the pad label the chain feeding it is printed with, and it is what
/// a stream on the Write stage names to be fed from here — so renaming it moves
/// every row that was, in the same commit. A row left behind would be refused by
/// the renderer for a pad that no longer exists, over a rename that changed
/// nothing about the graph.
///
/// Commits on `change`, like everything else on this stage: on `input` the node
/// would be renamed once per keystroke and the rows would chase it.
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

/// What this node will not run for, in the column beside it.
///
/// The card carries it too, and both are worth having: the card is where you see
/// that *this* node is the one, and the column is where the sentence has room to
/// say what to do about it.
function problemRows(node) {
    const mine = trouble.filter((p) => p.id === node.id);
    if (!mine.length) return [];
    return [div('gp-problems', mine.map((p) => div('gp-problem', p.reason)))];
}

/// What the filter reads and writes, and what is currently on each pad.
///
/// Stated because it is the thing you need in front of you while wiring and the
/// one thing a card cannot show at a glance: `overlay`'s two inputs are the
/// canvas and the clip *in that order*, and an `amix` has as many as its
/// `inputs` option says — which is an option in the table below, so the way to
/// give it another pad is right here.
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

/// The arguments written without names, edited in place.
///
/// A blank one is not dropped — `crop=iw*0.8::0:0` is not `crop` with three
/// arguments, it is a parse error — so an emptied field keeps its derived value
/// and the way to get rid of a positional argument is to unlock the node.
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

const OPTION_LIMIT = 30;

/// Every named option the filter has, straight from its AVOption table.
///
/// With nothing searched for, the list is what is set — `scale` has thirty
/// options and `overlay` twenty, and a column that opens on all of them is one
/// nobody reads to the bottom of.
function namedRows(node, options) {
    // Plenty of filters take nothing at all — `hflip`, `negate`, `null`. A
    // search box over an empty table, and a line offering to search all zero of
    // them, reads as something having gone wrong.
    if (!options.length)
        return [div('gp-hint dim', `libavfilter reports no options for ${node.filter}.`)];

    const list = div('gp-opt-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'optsearch', type: 'text', value: search,
        placeholder: `search ${options.length} options…`,
        on: { input: () => {
            search = field.value;
            // Only the list is rebuilt, so the field being typed into keeps its
            // caret.
            put(list, () => optionRows(node, options));
        } },
    });
    put(list, () => optionRows(node, options));
    return [head(`${node.filter} options · ${options.length}`), row('Find', field), list];
}

function optionRows(node, options) {
    const term = search.trim().toLowerCase();
    const matching = term
        ? options.filter((o) => o.name.toLowerCase().indexOf(term) >= 0 ||
                                (o.help || '').toLowerCase().indexOf(term) >= 0)
        : options.filter((o) => node.params[o.name] !== undefined);
    const shown = matching.slice(0, OPTION_LIMIT);

    const out = [];
    for (const o of shown) out.push(optionRow(node, o));
    if (matching.length > OPTION_LIMIT)
        out.push(div('gp-hint dim', `and ${matching.length - OPTION_LIMIT} more — narrow the search`));
    return out;
}

function optionRow(node, o) {
    const cur = node.params[o.name] !== undefined ? String(node.params[o.name]) : '';
    const apply = (v) => {
        noteEdit();
        overlay.edit(node, { params: { [o.name]: v } });
        changed();
    };
    return buildOptionRow(o, cur, apply);
}

// ── the palette ────────────────────────────────────────────────────────────

/// What can go on a wire: one input and one output, of the stream the wire
/// carries.
///
/// That is not a simplification of ffmpeg, it is what splicing means. A filter
/// with two inputs has nothing to read from the second and one with two outputs
/// has nowhere to send the second, so neither can be dropped *onto* a wire
/// however much you would like it to be.
///
/// They are not unreachable any more, which is what this comment used to say
/// they were: they are placed on the canvas and wired, which is the other
/// gesture — `Add filter`, or letting a wire go over empty space. What is
/// offered here is still exactly what can be spliced, because that is still what
/// this `+` does.
function spliceable(stream) {
    return allFilters().filter((f) => f.inputs === stream && f.outputs === stream &&
                                      !f.dynamicInputs && !f.dynamicOutputs);
}

function palette(point) {
    const all = spliceable(point.stream);
    const list = div('gp-filter-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'filtersearch', type: 'text', value: search,
        placeholder: 'name or description',
        on: { input: () => { search = field.value; put(list, () => filterRows(point, all)); } },
    });
    put(list, () => filterRows(point, all));

    return [
        div('gp-head', [span('Insert', 'gp-name'), span(point.title, 'gp-badge')]),
        div('gp-hint dim',
            point.stream === 'a' ? 'A filter here reads the clip’s sound as it is at this point.'
                                 : 'A filter here reads the picture as it is at this point.'),
        row('Find', field),
        list,
        el('button', { cls: 'tiny', text: 'Cancel', on: { click: () => { sel = null; draw(graph, trouble, points); } } }),
    ];
}

// ── a pad, and a wire ──────────────────────────────────────────────────────

/// What can go on the end of a wire you let go over nothing — or anywhere at
/// all, when there is no wire.
///
/// **This is where everything that cannot be spliced arrives.** The insert
/// palette above offers one-in-one-out filters because that is what splicing
/// means; this one offers anything with a pad that can take what you are
/// holding, which is `overlay`, `amix`, `concat`, `xfade`, `hstack`, `split` and
/// the four hundred others. A filter with two inputs is placed and then wired,
/// and the wire you were already drawing is the first of them.
function canTake(stream, dir) {
    // `dir` is the direction of the pad the wire *left*, so an out pad needs a
    // filter with an input and an in pad needs one with an output.
    return allFilters().filter((f) => {
        const pads = padsOf(f.name);
        if (!pads) return false;
        const want = dir === 'in' ? pads.outs : pads.ins;
        // `padTakes` rather than equality, so a wire of cues in the air offers
        // the filters that draw pictures — an `overlay` above all — which is the
        // whole of what can be done with one. See model.js.
        return want.some((s) => (dir === 'in' ? padTakes(s, stream)
                                             : padTakes(stream, s)));
    });
}

// ── sources ────────────────────────────────────────────────────────────────
//
// **A source is a filter with no inputs, and libavfilter says which.** There is
// no list of generators written down here any more than there is a list of
// filters: `color`, `testsrc`, `smptebars`, `sine`, `anullsrc`, `mandelbrot`,
// `movie` and the rest are simply the entries in the registry that read nothing,
// so a build that gains one gains it here.
//
// They belong in this palette rather than beside it because placing one is the
// same gesture as placing an `overlay`: it lands on the canvas, or on the end of
// a wire you are dragging *backwards* out of an empty input. That second case is
// what makes a watermark short — drag from `overlay`'s empty second input, let
// go, and pick the file.
//
// The document's own inputs are offered first, and that is the `movie` decision
// made visible: a file the graph reads is an `-i` with a demuxer, an option bag
// and a window, already probed and already on the Sources stage. `movie` is
// underneath with the other generators for anyone who wants it.

/// Can a source of `stream` be attached to what is being held?
///
/// Nothing when the wire came off an *output* pad: a source has no input for it
/// to land on, and offering one would be offering a connection that cannot be
/// made.
function wantsSource(pad) { return !pad.key || pad.dir === 'in'; }

function sourceRows(pad, term) {
    const stream = pad.key ? (pad.stream || 'v') : null;
    const hit = (a, b) => !term || String(a).toLowerCase().indexOf(term) >= 0 ||
                          String(b || '').toLowerCase().indexOf(term) >= 0;

    // An input is offered for a pad one of its own streams can fill, which for
    // a picture pad now includes a file whose only usable stream is a bitmap
    // subtitle track — those cues *are* pictures once painted.
function inputRow(pad, input) {
    const streams = streamKinds(input);
    return el('button', {
        cls: 'gp-filter', 'data-input': input.id,
        on: { click: () => {
            const rec = overlay.addSource(input.id);
            sel = { kind: 'node', key: rec.id };
            search = '';
            if (hooks.placed) hooks.placed(rec, pad);
            else changed();
        } },
    }, [span(input.name, 'gp-fname mono'),
        span(streams.map(streamWord).join(' · '), 'gp-badge'),
        span(input.path, 'dim')]);
}

function sourceDefaults(filter) {
    if (!isSource(filter) || !hooks.canvas) return {};
    const c = hooks.canvas() || {};
    const table = optionsOf(filter);
    const has = (name) => table.some((o) => o.name === name);
    const params = {};
    if (c.width > 0 && c.height > 0 && has('size'))
        params.size = `${Math.round(c.width)}x${Math.round(c.height)}`;
    if (c.fps > 0 && has('rate')) params.rate = String(c.fps);
    if (c.sampleRate > 0 && has('sample_rate')) params.sample_rate = String(c.sampleRate);
    return params;
}

function wantsOutput(pad) { return !pad.key || pad.dir === 'out'; }

function outputOffer(pad, term) {
    const name = overlay.freeOutputName();
    if (term && name.indexOf(term) < 0 && 'output'.indexOf(term) < 0 &&
        'pad'.indexOf(term) < 0) return [];
    const stream = pad.key ? (pad.stream || 'v') : '';
    return [
        head('An output'),
        el('button', {
            cls: 'gp-filter', 'data-output': name,
            on: { click: () => {
                const rec = overlay.addOutput(stream, name);
                sel = { kind: 'node', key: rec.id };
                search = '';
                if (hooks.placed) hooks.placed(rec, pad);
                else changed();
            } },
        }, [span(name, 'gp-fname mono'), span('a named pad', 'gp-badge')]),
    ];
}

function sourceRows(pad, term) {
    const stream = pad.key ? (pad.stream || 'v') : null;
    const hit = (a, b) => !term || String(a).toLowerCase().indexOf(term) >= 0 ||
                          String(b || '').toLowerCase().indexOf(term) >= 0;

    const files = documentInputs.filter((i) =>
        (!stream || streamKinds(i).some((k) => padTakes(k, stream))) &&
        hit(i.name, i.path));
    const made = sourceFilters().filter((f) => {
        const pads = padsOf(f.name);
        return pads && (!stream || pads.outs.indexOf(stream) >= 0) &&
               hit(f.name, f.description);
    });
    if (!files.length && !made.length) return [];

    const rows = [head(`Your files · ${files.length}`)];
    for (const i of files) rows.push(inputRow(pad, i));
    if (made.length) {
        rows.push(head(`Sources · ${made.length}`));
        for (const f of made.slice(0, FILTER_LIMIT)) rows.push(padRow(pad, f));
    }
    if (made.length > FILTER_LIMIT)
        rows.push(div('gp-hint dim', `and ${made.length - FILTER_LIMIT} more — narrow the search`));
    return rows;
}

function padPalette(pad) {
    const all = pad.key ? canTake(pad.stream || 'v', pad.dir)
                        : allFilters().filter((f) => !!padsOf(f.name));
    const list = div('gp-filter-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'padsearch', type: 'text', value: search,
        placeholder: `search ${all.length} filters…`,
        on: { input: () => { search = field.value; put(list, () => padRowsFor(pad, all)); } },
    });
    put(list, () => padRowsFor(pad, all));

    return [
        div('gp-head', [span('Place', 'gp-name'),
                        span(pad.key ? `from a ${streamWord(pad.stream)} pad`
                                     : 'on the canvas', 'gp-badge')]),
        row('Find', field),
        list,
        el('button', { cls: 'tiny', text: 'Cancel',
                       on: { click: () => { sel = null; draw(graph, trouble, points); } } }),
    ];
}

function padRowsFor(pad, all) {
    const term = search.trim().toLowerCase();
    const out = [];
    if (wantsOutput(pad) && pad.key) out.push(...outputOffer(pad, term));
    if (wantsSource(pad)) out.push(...sourceRows(pad, term));
    if (wantsOutput(pad) && !pad.key) out.push(...outputOffer(pad, term));

    const isMade = (f) => wantsSource(pad) && isSource(f.name);
    const matching = term
        ? all.filter((f) => !isMade(f) &&
                            (f.name.toLowerCase().indexOf(term) >= 0 ||
                             (f.description || '').toLowerCase().indexOf(term) >= 0))
        : all.filter((f) => MULTI.indexOf(f.name) >= 0);
    const shown = matching.slice(0, FILTER_LIMIT);

    if (out.length) out.push(head('Common Filters'));
    for (const f of shown) out.push(padRow(pad, f));
    if (matching.length > FILTER_LIMIT)
        out.push(div('gp-hint dim', `and ${matching.length - FILTER_LIMIT} more — narrow the search`));
    return out;
}

/// One offer, with its shape on it. The pad counts are the thing being chosen
/// between here — `overlay` takes two and `amix` takes as many as you say — so
/// they are on the button rather than a click away.
function padRow(pad, f) {
    const pads = padsOf(f.name) || { ins: [], outs: [] };
    const shape = `${f.dynamicInputs ? 'n' : pads.ins.length} in · ` +
                  `${f.dynamicOutputs ? 'n' : pads.outs.length} out`;
    return el('button', {
        cls: 'gp-filter', 'data-filter': f.name,
        on: { click: () => {
            const rec = overlay.addNode(f.name, { params: sourceDefaults(f.name) });
            sel = { kind: 'node', key: rec.id };
            search = '';
            if (hooks.placed) hooks.placed(rec, pad);
            else changed();
        } },
    }, [span(f.name, 'gp-fname mono'), span(shape, 'gp-badge'),
        span(f.description || '', 'dim')]);
}

/// What a selected wire is, and the two things that can be done to it.
///
/// A wire is not a node and does not get a node's panel, but it is a thing with
/// a state worth stating: which pad it leaves, which it arrives at, and whether
/// it is the derivation's or yours. That last one is what decides what Delete
/// means — forgetting a wire of your own, or *recording the absence* of a
/// derived one, which is a different act and comes back differently.
function wirePanel(wire) {
    if (!graph || !wire) return empty();
    const node = find(graph, wire.key);
    if (!node) { sel = null; return empty(); }
    const e = graph.inEdges(node).find((x) => (x.port || 0) === wire.port);
    const from = e ? graph.node(e.from) : null;
    const ins = graph.inPorts(node);
    const mine = overlay.wires().some((w) => w.to === wire.key && w.port === wire.port);

    return [
        div('gp-head', [span('Wire', 'gp-name'),
                        mine ? span('yours', 'gp-badge user') : span('derived', 'gp-badge')]),
        row('from', span(from ? `${nameOf(from)}${
            graph.outPorts(from) > 1 ? ` · out ${(e.fromPort || 0) + 1}` : ''}` : '—', 'mono')),
        row('to', span(`${nameOf(node)}${ins > 1 ? ` · in ${wire.port + 1}` : ''}`, 'mono')),
        div('gp-actions', [
            el('button', {
                cls: 'tiny', text: 'Delete', 'data-f': 'unwire',
                on: { click: () => { overlay.unwire(wire.key, wire.port); sel = null; changed(); } },
            }),
            mine || overlay.isCut(wire.key, wire.port) ? el('button', {
                cls: 'tiny', text: 'Give it back', 'data-f': 'rewire',
                on: { click: () => { overlay.reconnect(wire.key, wire.port); sel = null; changed(); } },
            }) : null,
        ]),
    ];
}

const FILTER_LIMIT = 40;

function filterRows(point, all) {
    const term = search.trim().toLowerCase();
    const matching = term
        ? all.filter((f) => f.name.toLowerCase().indexOf(term) >= 0 ||
                            (f.description || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((f) => COMMON.indexOf(f.name) >= 0);
    const shown = matching.slice(0, FILTER_LIMIT);

    const out = [];
    if (!term)
        out.push(div('gp-hint dim',
                     `A few to start with. Type to search all ${all.length} this build has.`));
    for (const f of shown)
        out.push(el('button', {
            cls: 'gp-filter', 'data-filter': f.name,
            on: { click: () => {
                const rec = overlay.insert(point.id, f.name);
                sel = { kind: 'node', key: rec.id };
                search = '';
                changed();
            } },
        }, [span(f.name, 'gp-fname mono'), span(f.description || '', 'dim')]));
    if (matching.length > FILTER_LIMIT)
        out.push(div('gp-hint dim', `and ${matching.length - FILTER_LIMIT} more — narrow the search`));
    return out;
}

/// What an empty search offers. Not a curated set of "supported" filters —
/// every one of the five hundred is one search away — but a list that opens
/// on nothing is a list that reads as broken.
/// The same idea for the pad palette: what a person reaching for a node with
/// more than one pad is most likely reaching for. Everything else is one search
/// away, and none of it is a list of what is *supported* — `padsOf` answers that
/// from libavfilter's own registry.
const MULTI = ['overlay', 'amix', 'concat', 'blend', 'xfade', 'acrossfade',
               'hstack', 'vstack', 'xstack', 'split', 'asplit', 'amerge',
               'sidechaincompress', 'alphamerge', 'maskedmerge', 'mix',
               'premultiply', 'streamselect', 'astreamselect', 'interleave'];

const COMMON = ['hflip', 'vflip', 'eq', 'curves', 'colorbalance', 'hue', 'unsharp',
                'gblur', 'noise', 'negate', 'lut3d', 'drawtext', 'drawbox', 'fade',
                'transpose', 'rotate', 'deshake', 'hqdn3d',
                'volume', 'highpass', 'lowpass', 'acompressor', 'afade', 'aecho',
                'anlmdn', 'atempo', 'dynaudnorm', 'loudnorm', 'speechnorm'];

function changed() { if (hooks.changed) hooks.changed(); }
