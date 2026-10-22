// Palette, option rows, source offers, and wire inspector for the graph panel.

import { el, div, span, put, head, row } from '../dom.js';
import { optionsOf, allFilters, padsOf, isSource, sourceFilters } from './filters.js';
import { inputs as documentInputs, streamKinds } from '../inputs.js';
import { nameOf } from './check.js';
import * as overlay from './overlay.js';
import { buildOptionRow } from '../opttable.js';
import { streamWord, padTakes } from './model.js';

const OPTION_LIMIT = 30;
const FILTER_LIMIT = 40;

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

/// Every named option the filter has, straight from its AVOption table.
///
/// With nothing searched for, the list is what is set — `scale` has thirty
/// options and `overlay` twenty, and a column that opens on all of them is one
/// nobody reads to the bottom of.
export function namedRows(node, options, ctx) {
    // Plenty of filters take nothing at all — `hflip`, `negate`, `null`. A
    // search box over an empty table, and a line offering to search all zero of
    // them, reads as something having gone wrong.
    if (!options.length)
        return [div('gp-desc dim', `libavfilter reports no options for ${node.filter}.`)];

    const list = div('gp-opt-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'optsearch', type: 'text', value: ctx.getSearch(),
        placeholder: `search ${options.length} options…`,
        on: { input: () => {
            ctx.setSearch(field.value);
            // Only the list is rebuilt, so the field being typed into keeps its
            // caret.
            put(list, () => optionRows(node, options, ctx));
        } },
    });
    put(list, () => optionRows(node, options, ctx));
    return [head(`${node.filter} options · ${options.length}`), row('Find', field), list];
}

function optionRows(node, options, ctx) {
    const term = ctx.getSearch().trim().toLowerCase();
    const matching = term
        ? options.filter((o) => o.name.toLowerCase().indexOf(term) >= 0 ||
                                (o.help || '').toLowerCase().indexOf(term) >= 0)
        : options.filter((o) => node.params[o.name] !== undefined);
    const shown = matching.slice(0, OPTION_LIMIT);

    const out = [];
    for (const o of shown) out.push(optionRow(node, o, ctx));
    if (matching.length > OPTION_LIMIT)
        out.push(div('gp-desc dim', `+${matching.length - OPTION_LIMIT} more matching options`));
    return out;
}

function optionRow(node, o, ctx) {
    const cur = node.params[o.name] !== undefined ? String(node.params[o.name]) : '';
    const apply = (v) => {
        ctx.noteEdit();
        overlay.edit(node, { params: { [o.name]: v } });
        ctx.changed();
    };
    return buildOptionRow(o, cur, apply);
}

// ── the palette ────────────────────────────────────────────────────────────

/// What can go on a wire: one input and one output, of the stream the wire
/// carries.
function spliceable(stream) {
    return allFilters().filter((f) => f.inputs === stream && f.outputs === stream &&
                                      !f.dynamicInputs && !f.dynamicOutputs);
}

export function palette(point, ctx) {
    const all = spliceable(point.stream);
    const list = div('gp-filter-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'filtersearch', type: 'text', value: ctx.getSearch(),
        placeholder: 'name or description',
        on: { input: () => { ctx.setSearch(field.value); put(list, () => filterRows(point, all, ctx)); } },
    });
    put(list, () => filterRows(point, all, ctx));

    return [
        div('gp-head', [span('Insert', 'gp-name'), span(point.title, 'gp-badge')]),
        div('gp-desc dim', `${streamWord(point.stream)} stream filter insert`),
        row('Find', field),
        list,
        el('button', { cls: 'tiny', text: 'Cancel', on: { click: () => ctx.cancel() } }),
    ];
}

// ── a pad, and a wire ──────────────────────────────────────────────────────

/// What can go on the end of a wire you let go over nothing — or anywhere at
/// all, when there is no wire.
function canTake(stream, dir) {
    return allFilters().filter((f) => {
        const pads = padsOf(f.name);
        if (!pads) return false;
        const want = dir === 'in' ? pads.outs : pads.ins;
        return want.some((s) => (dir === 'in' ? padTakes(s, stream)
                                             : padTakes(stream, s)));
    });
}

// ── sources ────────────────────────────────────────────────────────────────

function wantsSource(pad) { return !pad.key || pad.dir === 'in'; }

function inputRow(pad, input, ctx) {
    const streams = streamKinds(input);
    return el('button', {
        cls: 'gp-filter', 'data-input': input.id,
        on: { click: () => {
            const rec = overlay.addSource(input.id);
            ctx.selectPlaced(rec, pad);
        } },
    }, [span(input.name, 'gp-fname mono'),
        span(streams.map(streamWord).join(' · '), 'gp-badge'),
        span(input.path, 'dim')]);
}

export function driftRows(node, options, ctx) {
    if (!node || node.kind !== 'filter' || !isSource(node.filter)) return [];
    const want = sourceDefaults(node.filter, ctx);
    const keys = Object.keys(want);
    if (!keys.length) return [];

    const drifted = keys.filter((k) => node.params[k] !== undefined &&
                                       String(node.params[k]) !== String(want[k]));
    if (!drifted.length) return [];

    const label = { size: 'size', rate: 'frame rate', sample_rate: 'sample rate' };
    const said = drifted.map((k) => `${label[k] || k} ${node.params[k]} ≠ render ${want[k]}`).join('; ') +
                 ' (depends on what is wired after it)';
    return [
        div('gp-problems', div('gp-problem gp-drift mono', said)),
        div('gp-actions', el('button', {
            cls: 'tiny primary', text: 'Match the render', 'data-f': 'match-render',
            title: drifted.map((k) => `${k}=${want[k]}`).join(' '),
            on: { click: () => {
                ctx.noteEdit();
                const params = {};
                for (const k of drifted) params[k] = want[k];
                overlay.edit(node, { params });
                ctx.changed();
            } },
        })),
    ];
}

function sourceDefaults(filter, ctx) {
    const hooks = ctx.hooks();
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

function outputOffer(pad, term, ctx) {
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
                ctx.selectPlaced(rec, pad);
            } },
        }, [span(name, 'gp-fname mono'), span('a named pad', 'gp-badge')]),
    ];
}

function sourceRows(pad, term, ctx) {
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
    for (const i of files) rows.push(inputRow(pad, i, ctx));
    if (made.length) {
        rows.push(head(`Sources · ${made.length}`));
        for (const f of made.slice(0, FILTER_LIMIT)) rows.push(padRow(pad, f, ctx));
    }
    if (made.length > FILTER_LIMIT)
        rows.push(div('gp-desc dim', `+${made.length - FILTER_LIMIT} more source filters`));
    return rows;
}

export function padPalette(pad, ctx) {
    const all = pad.key ? canTake(pad.stream || 'v', pad.dir)
                        : allFilters().filter((f) => !!padsOf(f.name));
    const list = div('gp-filter-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'padsearch', type: 'text', value: ctx.getSearch(),
        placeholder: `search ${all.length} filters…`,
        on: { input: () => { ctx.setSearch(field.value); put(list, () => padRowsFor(pad, all, ctx)); } },
    });
    put(list, () => padRowsFor(pad, all, ctx));

    return [
        div('gp-head', [span('Place', 'gp-name'),
                        span(pad.key ? `from a ${streamWord(pad.stream)} pad`
                                     : 'on the canvas', 'gp-badge')]),
        row('Find', field),
        list,
        el('button', { cls: 'tiny', text: 'Cancel',
                       on: { click: () => ctx.cancel() } }),
    ];
}

function padRowsFor(pad, all, ctx) {
    const term = ctx.getSearch().trim().toLowerCase();
    const out = [];
    if (wantsOutput(pad) && pad.key) out.push(...outputOffer(pad, term, ctx));
    if (wantsSource(pad)) out.push(...sourceRows(pad, term, ctx));
    if (wantsOutput(pad) && !pad.key) out.push(...outputOffer(pad, term, ctx));

    const isMade = (f) => wantsSource(pad) && isSource(f.name);
    const matching = term
        ? all.filter((f) => !isMade(f) &&
                            (f.name.toLowerCase().indexOf(term) >= 0 ||
                             (f.description || '').toLowerCase().indexOf(term) >= 0))
        : all.filter((f) => MULTI.indexOf(f.name) >= 0);
    const shown = matching.slice(0, FILTER_LIMIT);

    if (out.length) out.push(head('Common Filters'));
    for (const f of shown) out.push(padRow(pad, f, ctx));
    if (matching.length > FILTER_LIMIT)
        out.push(div('gp-desc dim', `+${matching.length - FILTER_LIMIT} more matching filters`));
    return out;
}

/// One offer, with its shape on it. The pad counts are the thing being chosen
/// between here — `overlay` takes two and `amix` takes as many as you say — so
/// they are on the button rather than a click away.
function padRow(pad, f, ctx) {
    const pads = padsOf(f.name) || { ins: [], outs: [] };
    const shape = `${f.dynamicInputs ? 'n' : pads.ins.length} in · ` +
                  `${f.dynamicOutputs ? 'n' : pads.outs.length} out`;
    return el('button', {
        cls: 'gp-filter', 'data-filter': f.name,
        on: { click: () => {
            const rec = overlay.addNode(f.name, { params: sourceDefaults(f.name, ctx) });
            ctx.selectPlaced(rec, pad);
        } },
    }, [span(f.name, 'gp-fname mono'), span(shape, 'gp-badge'),
        span(f.description || '', 'dim')]);
}

/// What a selected wire is, and the two things that can be done to it.
export function wirePanel(wire, ctx) {
    const graph = ctx.graph();
    if (!graph || !wire) return ctx.empty();
    const node = ctx.find(graph, wire.key);
    if (!node) { ctx.clearSel(); return ctx.empty(); }
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
                on: { click: () => { overlay.unwire(wire.key, wire.port); ctx.clearSel(); ctx.changed(); } },
            }),
            mine || overlay.isCut(wire.key, wire.port) ? el('button', {
                cls: 'tiny', text: 'Give it back', 'data-f': 'rewire',
                on: { click: () => { overlay.reconnect(wire.key, wire.port); ctx.clearSel(); ctx.changed(); } },
            }) : null,
        ]),
    ];
}

function filterRows(point, all, ctx) {
    const term = ctx.getSearch().trim().toLowerCase();
    const matching = term
        ? all.filter((f) => f.name.toLowerCase().indexOf(term) >= 0 ||
                            (f.description || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((f) => COMMON.indexOf(f.name) >= 0);
    const shown = matching.slice(0, FILTER_LIMIT);

    const out = [];
    if (!term)
        out.push(div('gp-desc dim',
                     `Common filters (${all.length} available)`));
    for (const f of shown)
        out.push(el('button', {
            cls: 'gp-filter', 'data-filter': f.name,
            on: { click: () => {
                const rec = overlay.insert(point.id, f.name);
                ctx.selectInserted(rec);
            } },
        }, [span(f.name, 'gp-fname mono'), span(f.description || '', 'dim')]));
    if (matching.length > FILTER_LIMIT)
        out.push(div('gp-desc dim', `+${matching.length - FILTER_LIMIT} more matching filters`));
    return out;
}
