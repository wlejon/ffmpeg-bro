// One AVOption table, edited into one bag of `-key value` pairs.
//
// libavutil describes an encoder, a muxer, a demuxer, a decoder, a protocol and
// a filter with the same structure — a walk over an `AVClass` giving a name, a
// type, a range, a default, help text and named values — so a column that reads
// one reads all of them. There are three of these columns now (the encoder's on
// the Encode stage, the muxer's on Write, the demuxer's on Sources) and there
// will be more: decoder options and bitstream filters are on the list, and a
// protocol's are already asked for beside a URL.
//
// It is one component rather than three copies because the copies would be
// three sets of decisions about which control a type gets, arrived at from the
// same table by different routes — and they would drift, silently, in the
// direction of whichever one someone last had a reason to touch.
//
// **What is set here goes to `av_opt_set` and an unknown key is an error.**
// That is the same rule at both ends of the pipeline, and it is what makes this
// worth offering at all: a render that succeeded while ignoring half of what it
// was told is the worst of the three outcomes.

import { el, div, row, head, select, put, fromTemplate } from './dom.js';

/// What has been typed into each column's search box, by the column's name.
///
/// Module state rather than the caller's, because a column is rebuilt whenever
/// anything it describes changes and the search term must survive that — it is
/// about the *list*, not about the thing being configured.
const searches = new Map();

const OPTION_LIMIT = 40;

/// The bounds, where they are worth stating.
///
/// libav gives every unbounded numeric option the whole of its type as a range,
/// so a muxer's `movflags` reports ±2147483648 and `trim`'s `start` reports
/// ±9223372036854775807 — which is not a range, it is the absence of one, and
/// printing it at that length pushes the column about for no information at
/// all.
///
/// Exported because the Graph stage's option column asks the same question of
/// the same shape of data, and had its own copy with a threshold three orders
/// of magnitude higher and no `flags` arm: every int32 option in libavfilter
/// printed its whole type as a range there and was correctly suppressed here.
export function rangeOf(o) {
    if (!o.hasRange || o.type === 'enum' || o.type === 'flags') return '';
    if (Math.abs(Number(o.min)) > 1e9 && Math.abs(Number(o.max)) > 1e9) return '';
    return `[${o.min}…${o.max}]`;
}

/// One option: what it is called, what libav says it does, and somewhere to put
/// a value. Setting it to nothing removes the key rather than passing an empty
/// string, which is a different instruction.
export function optionRow(o, bag, onChange) {
    const node = fromTemplate('tpl-option');
    const cur = bag[o.name] !== undefined ? String(bag[o.name]) : '';

    node.querySelector('.opt-name').textContent = o.name;
    node.querySelector('.opt-type').textContent = o.type;
    node.querySelector('.opt-range').textContent = rangeOf(o);
    node.querySelector('.ex-opt-help').textContent = o.help || '';
    if (cur !== '') node.classList.add('set');

    const apply = (v) => {
        if (v === '') delete bag[o.name];
        else bag[o.name] = v;
        onChange();
    };

    let control;
    if (o.values && o.values.length) {
        control = select({ cls: 'ex-opt', 'data-opt': o.name,
                           on: { change: (e) => apply(e.target.value.trim()) } },
                         [{ id: '', label: `default (${o.default})` },
                          ...o.values.map((v) => v.name)], cur);
    } else if (o.type === 'bool') {
        control = select({ cls: 'ex-opt', 'data-opt': o.name,
                           on: { change: (e) => apply(e.target.value.trim()) } },
                         [{ id: '', label: `default (${o.default})` }, '0', '1'], cur);
    } else {
        control = el('input', {
            cls: 'wide ex-opt', 'data-opt': o.name, type: 'text', value: cur,
            placeholder: String(o.default),
            on: { change: (e) => apply(e.target.value.trim()) },
        });
    }
    node.querySelector('.opt-control').append(control);
    return node;
}

/// The rows themselves: what is set, or what a search matches.
///
/// With nothing searched for the list is what has been set — the rest is eighty
/// rows of noise until somebody goes looking for one of them.
export function bagRows(all, bag, searchText, hint, onChange) {
    const term = String(searchText || '').trim().toLowerCase();
    const matching = term
        ? all.filter((o) => o.name.toLowerCase().indexOf(term) >= 0 ||
                            (o.help || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((o) => bag[o.name] !== undefined);
    const shown = matching.slice(0, OPTION_LIMIT);

    const out = [];
    if (!term && !shown.length)
        out.push(div('ex-note dim', `Type above to search all ${all.length} options. ${hint}`));

    for (const o of shown) out.push(optionRow(o, bag, onChange));

    if (matching.length > OPTION_LIMIT)
        out.push(div('ex-note dim', `and ${matching.length - OPTION_LIMIT} more — narrow the search`));
    return out;
}

/// A whole column: a heading, a sentence about where the table came from, a
/// search box and the rows.
///
/// `name` is the `data-f` the search field carries — the only thing about a
/// column anything outside can name, and what a test points at.
///
/// The list is rebuilt on search and the field is not, so the caret never moves
/// under the person typing: replacing the field between keystrokes is the bug
/// this shape exists to avoid.
export function optionColumn({ name, title, note, options, bag, hint, onChange }) {
    const list = div('ex-opt-list');
    const redraw = () => put(list, () => bagRows(options, bag, searches.get(name), hint, onChange));
    const search = el('input', {
        cls: 'wide', 'data-f': name, type: 'text', value: searches.get(name) || '',
        placeholder: 'name or description',
        on: { input: () => { searches.set(name, search.value); redraw(); } },
    });
    redraw();

    return [
        head(title),
        note ? div('ex-note dim', note) : null,
        row('Find', search),
        list,
    ].filter(Boolean);
}
