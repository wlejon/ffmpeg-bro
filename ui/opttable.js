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
const searches = new Map();

const OPTION_LIMIT = 40;

/// The bounds, where they are worth stating.
export function rangeOf(o) {
    if (!o || !o.hasRange || o.type === 'enum' || o.type === 'flags' || o.type === 'bool') return '';
    const min = Number(o.min);
    const max = Number(o.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
    if (Math.abs(min) > 1e6 || Math.abs(max) > 1e6) return '';
    if (min <= -2147483647 || max >= 2147483647) return '';
    if (min === -1 && max >= 1e8) return '';
    return `[${min}…${max}]`;
}

export function isSaneRange(o) {
    if (!o || !o.hasRange || o.type === 'enum' || o.type === 'flags' || o.type === 'bool') return false;
    const min = Number(o.min);
    const max = Number(o.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
    if (Math.abs(min) > 1e6 || Math.abs(max) > 1e6) return false;
    if (min <= -2147483647 || max >= 2147483647) return false;
    if (max <= min) return false;
    return true;
}

/// Synthesize a typed control from AVOption metadata. Shared between opttable and graph panel.
export function buildOptionRow(o, cur, apply) {
    const node = fromTemplate('tpl-option');
    node.querySelector('.opt-name').textContent = o.name;

    const typeEl = node.querySelector('.opt-type');
    if (typeEl) typeEl.textContent = ''; // C type name suppressed per plan

    const rangeEl = node.querySelector('.opt-range');
    if (rangeEl) rangeEl.textContent = rangeOf(o);

    node.querySelector('.ex-opt-help').textContent = o.help || '';
    if (cur !== '') node.classList.add('set');

    const controlBox = node.querySelector('.opt-control');

    const validate = (valStr, inputEl) => {
        let valid = true;
        if (o.hasRange && valStr !== '') {
            const num = Number(valStr);
            if (Number.isFinite(num)) {
                if (o.min !== undefined && num < Number(o.min)) valid = false;
                if (o.max !== undefined && num > Number(o.max)) valid = false;
            }
        }
        if (inputEl && inputEl.classList) {
            if (!valid) inputEl.classList.add('invalid');
            else inputEl.classList.remove('invalid');
        }
        return valid;
    };

    let control;
    if (o.values && o.values.length) {
        control = select({
            cls: 'ex-opt', 'data-opt': o.name,
            on: { change: (e) => apply(e.target.value.trim()) }
        }, [{ id: '', label: `default (${o.default})` }, ...o.values.map(v => v.name)], cur);
    } else if (o.type === 'bool') {
        control = select({
            cls: 'ex-opt', 'data-opt': o.name,
            on: { change: (e) => apply(e.target.value.trim()) }
        }, [{ id: '', label: `default (${o.default})` }, '0', '1'], cur);
    } else if (o.type === 'image_size') {
        const parts = cur ? cur.split('x') : ['', ''];
        const wInput = el('input', {
            cls: 'tiny ex-opt', type: 'text', placeholder: 'W', value: parts[0] || '',
            on: { input: () => updateImg() }
        });
        const hInput = el('input', {
            cls: 'tiny ex-opt', type: 'text', placeholder: 'H', value: parts[1] || '',
            on: { input: () => updateImg() }
        });
        const updateImg = () => {
            const w = wInput.value.trim();
            const h = hInput.value.trim();
            if (w && h) apply(`${w}x${h}`);
            else if (!w && !h) apply('');
        };
        control = div('opt-pair', [wInput, el('span', { text: '×' }), hInput]);
    } else if (o.type === 'color') {
        const textInput = el('input', {
            cls: 'ex-opt wide', 'data-opt': o.name, type: 'text', value: cur, placeholder: String(o.default || ''),
            on: { change: (e) => apply(e.target.value.trim()) }
        });
        const swatch = el('input', {
            type: 'color', cls: 'opt-color-swatch', value: cur.startsWith('#') ? cur : '#000000',
            on: { input: (e) => { textInput.value = e.target.value; apply(e.target.value); } }
        });
        control = div('opt-pair', [swatch, textInput]);
    } else if (o.type === 'rational') {
        const parts = cur ? cur.split('/') : ['', ''];
        const numInput = el('input', {
            cls: 'tiny ex-opt', type: 'text', placeholder: 'num', value: parts[0] || '',
            on: { input: () => updateRat() }
        });
        const denInput = el('input', {
            cls: 'tiny ex-opt', type: 'text', placeholder: 'den', value: parts[1] || '',
            on: { input: () => updateRat() }
        });
        const updateRat = () => {
            const n = numInput.value.trim();
            const d = denInput.value.trim();
            if (n && d) apply(`${n}/${d}`);
            else if (!n && !d) apply('');
        };
        control = div('opt-pair', [numInput, el('span', { text: '/' }), denInput]);
    } else if ((o.type === 'int' || o.type === 'float' || o.type === 'double' || o.type === 'int64') && isSaneRange(o)) {
        const step = (o.type === 'float' || o.type === 'double') ? '0.01' : '1';
        const numInput = el('input', {
            cls: 'short ex-opt', 'data-opt': o.name, type: 'number',
            min: String(o.min), max: String(o.max), step,
            value: cur, placeholder: String(o.default !== undefined ? o.default : ''),
            on: {
                input: (e) => {
                    const v = e.target.value.trim();
                    validate(v, numInput);
                    slider.value = v !== '' ? v : String(o.default || o.min);
                    apply(v);
                },
                change: (e) => {
                    const v = e.target.value.trim();
                    validate(v, numInput);
                    slider.value = v !== '' ? v : String(o.default || o.min);
                    apply(v);
                }
            }
        });
        const slider = el('input', {
            cls: 'opt-slider', type: 'range',
            min: String(o.min), max: String(o.max), step,
            value: cur !== '' ? cur : String(o.default !== undefined ? o.default : o.min),
            on: {
                input: (e) => {
                    numInput.value = e.target.value;
                    validate(e.target.value, numInput);
                    apply(e.target.value);
                }
            }
        });
        validate(cur, numInput);
        control = div('opt-pair', [slider, numInput]);
    } else {
        const isNum = (o.type === 'int' || o.type === 'float' || o.type === 'double' || o.type === 'int64');
        const inputType = isNum ? 'number' : 'text';
        control = el('input', {
            cls: 'wide ex-opt', 'data-opt': o.name, type: inputType, value: cur,
            placeholder: String(o.default !== undefined ? o.default : ''),
            on: {
                input: (e) => {
                    const v = e.target.value.trim();
                    validate(v, control);
                },
                change: (e) => {
                    const v = e.target.value.trim();
                    validate(v, control);
                    apply(v);
                }
            }
        });
        validate(cur, control);
    }

    controlBox.append(control);
    return node;
}

export function optionRow(o, bag, onChange) {
    const cur = bag[o.name] !== undefined ? String(bag[o.name]) : '';
    const apply = (v) => {
        if (v === '') delete bag[o.name];
        else bag[o.name] = v;
        onChange();
    };
    return buildOptionRow(o, cur, apply);
}

export function bagRows(all, bag, searchText, hint, onChange) {
    const term = String(searchText || '').trim().toLowerCase();
    const matching = term
        ? all.filter((o) => o.name.toLowerCase().indexOf(term) >= 0 ||
                            (o.help || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((o) => bag[o.name] !== undefined);
    const shown = matching.slice(0, OPTION_LIMIT);

    const out = [];
    for (const o of shown) out.push(optionRow(o, bag, onChange));

    if (matching.length > OPTION_LIMIT)
        out.push(div('ex-note dim', `and ${matching.length - OPTION_LIMIT} more — narrow the search`));
    return out;
}

export function optionColumn({ name, title, note, options, bag, hint, onChange }) {
    const list = div('ex-opt-list');
    const redraw = () => put(list, () => bagRows(options, bag, searches.get(name), hint, onChange));
    const search = el('input', {
        cls: 'wide', 'data-f': name, type: 'text', value: searches.get(name) || '',
        placeholder: `search ${options.length} options…`,
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
