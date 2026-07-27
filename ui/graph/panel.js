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
import { optionsOf, infoOf, allFilters, padsOf } from './filters.js';
import { nameOf } from './check.js';
import * as overlay from './overlay.js';

let refs = {};
let hooks = {};

/// `{ kind: 'node', key } | { kind: 'point', point } | null`. A node is held by
/// key rather than by object, because the object is thrown away and remade
/// every time the timeline moves — see `keyOf`.
let sel = null;
let search = '';
let graph = null;
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

export function selectedKey() { return sel && sel.kind === 'node' ? sel.key : null; }
export function selectedPoint() { return sel && sel.kind === 'point' ? sel.point.id : null; }

export function selectNode(key, count) {
    sel = key ? { kind: 'node', key } : null;
    selectedCount = count === undefined ? (key ? 1 : 0) : count;
    draw(graph, trouble);
}

export function openPoint(point) {
    sel = point ? { kind: 'point', point } : null;
    search = '';
    draw(graph, trouble);
}

/// A pad with a wire in the air, or a place on the canvas with nothing but a
/// position. Same palette either way — this is "what filter" — and what makes
/// them different is only what the view does with the answer.
export function openPad(pad) {
    sel = pad ? { kind: 'pad', pad } : null;
    search = '';
    draw(graph, trouble);
}

/// A wire somebody clicked. `{ key, port, node, stream }`, or null.
export function selectWire(wire) {
    sel = wire ? { kind: 'wire', wire } : null;
    selectedCount = 0;
    draw(graph, trouble);
}

export function clearSelection() { sel = null; }

/// Draw against the graph as it is now. Called after every derivation, so a
/// selection that no longer exists — a clip trimmed out of the range, a node
/// removed — falls back to nothing rather than to a stale card.
export function draw(g, problems) {
    graph = g;
    trouble = problems || [];
    if (!refs.panel) return;
    if (!g || !sel) return put(refs.panel, () => empty());
    if (sel.kind === 'point') return put(refs.panel, () => palette(sel.point));
    if (sel.kind === 'pad') return put(refs.panel, () => padPalette(sel.pad));
    if (sel.kind === 'wire') return put(refs.panel, () => wirePanel(sel.wire));

    const node = find(g, sel.key);
    if (!node) { sel = null; return put(refs.panel, () => empty()); }
    put(refs.panel, () => nodePanel(node));
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

function nodePanel(node) {
    // An input is a file with a pad per stream it is read for, so it is named
    // for the input it is rather than for one of its pads.
    const name = node.kind === 'input' ? `input ${node.index}`
               : node.kind === 'sink' ? (node.stream === 'a' ? 'audio out' : 'video out')
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

    if (node.kind !== 'filter') {
        out.push(div('gp-hint dim', node.kind === 'input'
            ? `One file, as ffmpeg would open it — ${pads} — ${node.path || ''}`
            : 'The pad the muxer maps. What leaves here is what gets written.'));
        return out;
    }

    const info = infoOf(node.filter);
    if (info && info.description) out.push(div('gp-hint dim', info.description));
    out.push(...padRows(node));

    const options = optionsOf(node.filter);
    out.push(...positionalRows(node, options));
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
    if (actions.length) out.push(div('gp-actions', actions));

    if (node.locked && node.derived)
        out.push(div('gp-hint dim',
            'These values outrank the edit: moving, trimming or cropping this clip ' +
            'will not change them until it is unlocked.'));

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

/// The bounds, where they are worth stating.
///
/// libavfilter gives every unbounded numeric option the whole of its type as a
/// range, so `trim`'s `start` reports ±9223372036854775807 — twenty digits of
/// nothing, twice, wrapping onto three lines and pushing the column about. That
/// is not a range, it is the absence of one, and saying so at that length is
/// worse than not saying it.
function rangeOf(o) {
    if (!o.hasRange || o.type === 'enum') return '';
    if (Math.abs(Number(o.min)) > 1e15 && Math.abs(Number(o.max)) > 1e15) return '';
    return `[${o.min}…${o.max}]`;
}

function optionRow(node, o) {
    const item = fromTemplate('tpl-option');
    const cur = node.params[o.name] !== undefined ? String(node.params[o.name]) : '';

    item.querySelector('.opt-name').textContent = o.name;
    item.querySelector('.opt-type').textContent = o.type;
    item.querySelector('.opt-range').textContent = rangeOf(o);
    item.querySelector('.ex-opt-help').textContent = o.help || '';
    if (cur !== '') item.classList.add('set');

    const apply = (v) => { overlay.edit(node, { params: { [o.name]: v } }); changed(); };

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
        el('button', { cls: 'tiny', text: 'Cancel', on: { click: () => { sel = null; draw(graph, trouble); } } }),
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
                       on: { click: () => { sel = null; draw(graph, trouble); } } }),
    ];
}

function padRowsFor(pad, all) {
    const term = search.trim().toLowerCase();
    const matching = term
        ? all.filter((f) => f.name.toLowerCase().indexOf(term) >= 0 ||
                            (f.description || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((f) => MULTI.indexOf(f.name) >= 0);
    const shown = matching.slice(0, FILTER_LIMIT);

    const out = [];
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
            const rec = overlay.addNode(f.name);
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
