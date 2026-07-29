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
import * as overlay from './overlay.js';
// The other half of renaming an output. A name is one fact and it is written in
// two places — the node, and every stream row fed from it — so the two move
// together at the moment the rename commits. This stage does not otherwise know
// the Write stage exists, and does not learn anything else about it here.
import { renamePad } from '../export/pads.js';
// The same question about the same shape of data. There were two copies with
// two thresholds and only one of them suppressed a `flags` range, so every
// int32 AVOption printed ±2147483648 here and nowhere else.
import { rangeOf } from '../opttable.js';

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
const FIELD_ATTRS = ['data-f', 'data-opt', 'data-pos', 'data-edge', 'data-span'];

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
    return [
        head('Graph'),
        div('gp-hint dim',
            'Click a node to see what it is set to, or hover a wire and click its + to put ' +
            'a filter there. Values can be typed on the cards themselves; this column is ' +
            'every other option the filter has. Everything here is derived from the edit ' +
            'until you change it.'),
        div('gp-hint dim',
            'Drag a node’s title bar to place it and Re-layout gives the whole graph ' +
            'back. Drag the background to select several, middle-drag to pan, wheel ' +
            'to zoom.'),
        // A recipe rather than a feature. The whole argument of this stage is
        // that the graph is the mechanism, so the common case is worth naming
        // and is worth *not* being a button that does something private.
        div('gp-hint dim',
            'A watermark is two nodes and two wires: Add node offers every file you have ' +
            'loaded and every source libavfilter has — place the logo, drag from the ' +
            'composite into empty canvas and pick overlay, then drag the logo’s picture ' +
            'socket onto overlay’s second input. A testsrc or a colour goes on the same ' +
            'way, and a graph with nothing on the timeline behind it still renders.'),
        overlay.isEmpty() ? null : div('gp-hint dim', filtersNote()),
        overlay.isEmpty() ? null : el('button', {
            cls: 'tiny', text: 'Clear my filters and locks',
            on: { click: () => { overlay.clear(); sel = null; changed(); } },
        }),
    ];
}

/// Said here rather than left to be found out. Playback decodes through
/// `<video>` and has no filter path, so a filter you insert is invisible until
/// you render — which, without saying so, reads as the filter not working.
function filtersNote() {
    return 'Filters run when you render, and in the export preview. The viewer plays ' +
           'the source files directly and cannot show them.';
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
    if (node.filter === 'movie' || node.filter === 'amovie')
        out.push(div('gp-hint dim',
            'A movie opens the file itself, outside the input list — so nothing on the ' +
            'Sources stage reaches it: no forced demuxer, no -probesize, no window. Write ' +
            'the path the way libavfilter reads one, quoted with its colon escaped ' +
            '(\'C\\:/logo.png\'): a colon separates a filter’s arguments and a comma ends ' +
            'the filter, so a bare path with a drive letter fails and a bare path with a ' +
            'comma in it fails differently. The same picture as an input node, with all of ' +
            'that and a row of its own, is one drag from a socket away.'));
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
    const out = [
        div('gp-hint dim',
            'A pad of your own. Whatever is wired here comes out of the render as a stream ' +
            'of its own — add one on the Write stage and pick “the graph’s ' +
            `[${node.name || '…'}]” as its source. The chain feeding it is printed ending ` +
            'in that name, so the command above and the render are the same thing.'),
    ];
    const field = el('input', {
        cls: 'wide mono', 'data-f': 'outname', type: 'text', value: node.name || '',
        placeholder: 'out2',
        on: { change: () => {
            noteEdit();
            const before = node.name || '';
            const next = field.value.trim();
            if (next === before) return;
            overlay.renameOutput(node.id, next);
            renamePad(before, next);
            changed();
        } },
    });
    out.push(row('Name', field));
    out.push(div('gp-hint dim',
        'Letters, digits and underscores — it is a filtergraph pad label. vout and aout ' +
        'are the derivation’s own names for the composite and the mix and cannot be used.'));
    out.push(...padRows(node));
    out.push(div('gp-actions', [el('button', {
        cls: 'tiny', text: 'Remove', 'data-f': 'remove',
        on: { click: () => { overlay.removeInsert(node.id); sel = null; changed(); } },
    }), measureAction(node)]));
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
    const kind = (s) => (s === 'a' ? 'sound' : 'picture');
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
        placeholder: 'name or description',
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
    if (!term && !shown.length)
        out.push(div('gp-hint dim',
                     `Nothing set by hand. Type above to search all ${options.length} — ` +
                     'anything set here goes into the filtergraph as written.'));
    for (const o of shown) out.push(optionRow(node, o));
    if (matching.length > OPTION_LIMIT)
        out.push(div('gp-hint dim', `and ${matching.length - OPTION_LIMIT} more — narrow the search`));
    return out;
}

function optionRow(node, o) {
    const item = fromTemplate('tpl-option');
    const cur = node.params[o.name] !== undefined ? String(node.params[o.name]) : '';

    item.querySelector('.opt-name').textContent = o.name;
    item.querySelector('.opt-type').textContent = o.type;
    item.querySelector('.opt-range').textContent = rangeOf(o);
    item.querySelector('.ex-opt-help').textContent = o.help || '';
    if (cur !== '') item.classList.add('set');

    const apply = (v) => {
        noteEdit();
        overlay.edit(node, { params: { [o.name]: v } });
        changed();
    };

    let control;
    if (o.values && o.values.length) {
        control = el('select', {
            cls: 'ex-opt', 'data-opt': o.name,
            on: { change: (e) => apply(e.target.value.trim()) },
        }, [{ id: '', label: `default (${o.default})` }, ...o.values.map((v) => v.name)]
            .map((c) => {
                const value = String(c && c.id !== undefined ? c.id : c);
                const label = String(c && c.label !== undefined ? c.label : c);
                return el('option', { value, text: label, selected: value === cur });
            }));
        control.value = cur;
    } else {
        control = el('input', {
            cls: 'wide ex-opt', 'data-opt': o.name, type: 'text', value: cur,
            placeholder: String(o.default),
            on: { change: (e) => apply(e.target.value.trim()) },
        });
    }
    item.querySelector('.opt-control').append(control);
    return item;
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
        return want.some((s) => s === stream);
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

    const files = documentInputs.filter((i) =>
        (!stream || streamKinds(i).indexOf(stream) >= 0) && hit(i.name, i.path));
    const made = sourceFilters().filter((f) => {
        const pads = padsOf(f.name);
        return pads && (!stream || pads.outs.indexOf(stream) >= 0) &&
               hit(f.name, f.description);
    });
    if (!files.length && !made.length) return [];

    const rows = [head(`Sources · ${files.length + made.length}`)];
    if (!term)
        rows.push(div('gp-hint dim',
            'A file the graph reads is an -i, with the demuxer, options and window it ' +
            'has on the Sources stage — which is why it is here rather than a movie=. ' +
            'Below it, everything libavfilter makes out of nothing.'));
    for (const i of files) rows.push(inputRow(pad, i));
    for (const f of made.slice(0, FILTER_LIMIT)) rows.push(padRow(pad, f));
    if (made.length > FILTER_LIMIT)
        rows.push(div('gp-hint dim', `and ${made.length - FILTER_LIMIT} more — narrow the search`));
    return rows;
}

/// One of the document's inputs, offered as a node the graph reads.
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
        span(streams.map((s) => (s === 'a' ? 'sound' : 'picture')).join(' · '), 'gp-badge'),
        span(input.path, 'dim')]);
}

/// A generator still carrying the numbers the render had when it was placed.
///
/// **The other half of a refusal.** `sourceDefaults` fills a `testsrc`'s size
/// and rate in from the render at the moment it is placed, so the ordinary case
/// simply agrees; change the output size afterwards and the two disagree, and
/// the render is refused with both numbers. Refusing is right — a writer opened
/// for one size being handed another is a scaler quietly resizing every frame —
/// but being told at render time about a decision taken twenty minutes earlier
/// is being told in the wrong place.
///
/// **It states the disagreement rather than predicting a failure.** Whether a
/// particular generator's size actually reaches the output depends on what is
/// wired downstream of it — a `color` feeding an `overlay` as a badge is
/// legitimately a different size from the render, and a `scale` in between
/// settles it either way. So this says what the two numbers are and where each
/// came from, which cannot be wrong, and leaves the refusal at render time to
/// be the authority on what the graph does.
///
/// The button is the "follows the render" half: one press writes what
/// `sourceDefaults` would have written today. It is a press and not a binding
/// for the reason `Follow the clip` is — a value that silently rewrote itself
/// would stop being the value somebody typed.
function driftRows(node, options) {
    if (!node || node.kind !== 'filter' || !isSource(node.filter)) return [];
    const want = sourceDefaults(node.filter);
    const keys = Object.keys(want);
    if (!keys.length) return [];

    // Only what was actually set: a generator left on its own default is not a
    // generator carrying a stale number, it is one nobody has told anything.
    const drifted = keys.filter((k) => node.params[k] !== undefined &&
                                       String(node.params[k]) !== String(want[k]));
    if (!drifted.length) return [];

    const label = { size: 'size', rate: 'frame rate', sample_rate: 'sample rate' };
    const said = drifted.map((k) => `${label[k] || k} ${node.params[k]}, and the render is ` +
                                    `${want[k]}`).join('; ');
    return [
        div('gp-problems', div('gp-problem gp-drift',
            `This ${node.filter} was placed carrying the render's numbers and they have ` +
            `changed since: ${said}. Whether that matters depends on what is wired after ` +
            `it — a generator feeding an overlay is meant to be its own size — but a graph ` +
            `whose last pad is not the render's size is refused when it runs.`)),
        div('gp-actions', el('button', {
            cls: 'tiny', text: 'Match the render', 'data-f': 'match-render',
            title: drifted.map((k) => `${k}=${want[k]}`).join(' '),
            on: { click: () => {
                noteEdit();
                const params = {};
                for (const k of drifted) params[k] = want[k];
                overlay.edit(node, { params });
                changed();
            } },
        })),
    ];
}

/// What the render already knows, written into a generator as it is placed.
///
/// A `testsrc` is 320x240 and 25 fps until it is told otherwise, and a graph
/// whose last pad is a different size from the render is refused — correctly,
/// because a writer opened for one size being handed another is a scaler
/// quietly resizing every frame. Filling the size and rate in at the moment of
/// placing means the ordinary case simply agrees, and changing them afterwards
/// is a decision that gets said out loud.
///
/// Which options those are is read out of the filter's own table rather than
/// tabled here: a video source has `size` and `rate`, a sound source has
/// `sample_rate`, and a source with neither gets nothing.
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

function padPalette(pad) {
    const all = pad.key ? canTake(pad.stream || 'v', pad.dir)
                        : allFilters().filter((f) => !!padsOf(f.name));
    const list = div('gp-filter-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'padsearch', type: 'text', value: search,
        placeholder: 'name or description',
        on: { input: () => { search = field.value; put(list, () => padRowsFor(pad, all)); } },
    });
    put(list, () => padRowsFor(pad, all));

    return [
        div('gp-head', [span('Place', 'gp-name'),
                        span(pad.key ? `from a ${pad.stream === 'a' ? 'sound' : 'picture'} pad`
                                     : 'on the canvas', 'gp-badge')]),
        div('gp-hint dim', pad.key
            ? 'It lands where you let go and is wired to the pad you dragged from. ' +
              'A filter with more inputs than that arrives with the rest empty — drag ' +
              'a wire to each of them.'
            : 'It lands unwired. Drag from a socket to a socket to join it up.'),
        row('Find', field),
        list,
        el('button', { cls: 'tiny', text: 'Cancel',
                       on: { click: () => { sel = null; draw(graph, trouble, points); } } }),
    ];
}

// ── outputs ────────────────────────────────────────────────────────────────
//
// **The forward analogue of the sources above.** Dragging backwards out of an
// empty input pad asks "where does this come from", and the answer that leads
// the palette is a file or a generator. Dragging *forwards* out of an output pad
// asks "where does this go", and the answer nothing could give until now is
// "out of the render, as a stream of its own" — every other entry is a filter
// that does something to it on the way to somewhere else.
//
// Placing one names it, because a pad with no label is a pad nothing can be
// mapped to; the name is editable the moment it lands, since the panel is
// showing the node it just made.

/// Can an output be attached to what is being held? Nothing when the wire came
/// off an *input* pad: an output produces nothing for that wire to land on.
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
        }, [span(name, 'gp-fname mono'), span('a named pad', 'gp-badge'),
            span('this pad leaves the render as a stream of its own — map it on the ' +
                 'Write stage', 'dim')]),
    ];
}

function padRowsFor(pad, all) {
    const term = search.trim().toLowerCase();
    const out = [];
    // Forward out of a pad: where it goes, before what happens to it on the way.
    if (wantsOutput(pad) && pad.key) out.push(...outputOffer(pad, term));
    // Sources first, because a pad with nothing on it and a canvas with nothing
    // on it are both places where the question is "where does the picture come
    // from" before it is "what happens to it".
    if (wantsSource(pad)) out.push(...sourceRows(pad, term));
    // ...and on the bare canvas, after them: nothing is being held, so neither
    // question is the one being asked and the order is arbitrary — an output is
    // the rarer thing to be reaching for with no wire in the air.
    if (wantsOutput(pad) && !pad.key) out.push(...outputOffer(pad, term));

    const isMade = (f) => wantsSource(pad) && isSource(f.name);
    const matching = term
        ? all.filter((f) => !isMade(f) &&
                            (f.name.toLowerCase().indexOf(term) >= 0 ||
                             (f.description || '').toLowerCase().indexOf(term) >= 0))
        : all.filter((f) => MULTI.indexOf(f.name) >= 0);
    const shown = matching.slice(0, FILTER_LIMIT);

    if (out.length) out.push(head('Filters'));
    if (!term)
        out.push(div('gp-hint dim',
                     `The ones this is for, to start with. Type to search all ${all.length} ` +
                     'that can take this pad.'));
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
                title: mine ? 'Forget this wire'
                            : 'Take this wire off — the rebuild will not put it back',
                on: { click: () => { overlay.unwire(wire.key, wire.port); sel = null; changed(); } },
            }),
            mine || overlay.isCut(wire.key, wire.port) ? el('button', {
                cls: 'tiny', text: 'Give it back', 'data-f': 'rewire',
                title: 'Let the derivation decide what arrives here',
                on: { click: () => { overlay.reconnect(wire.key, wire.port); sel = null; changed(); } },
            }) : null,
        ]),
        div('gp-hint dim', mine
            ? 'You made this one. Deleting it leaves the pad empty; the derivation ' +
              'will not fill it back in unless you give the pad back.'
            : 'The derivation made this one, and makes it again on every timeline ' +
              'edit — so taking it off is remembered as a cut rather than as nothing.'),
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
