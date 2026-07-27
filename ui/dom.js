// Building DOM without building HTML.
//
// Markup assembled by concatenating strings has three problems and this app
// hit all of them. Any value dropped into one has to be escaped by hand, and
// the escaping is only ever as good as the last person to remember it — a
// filename with an `&` in it is enough. Every rebuild throws away the elements
// and makes new ones, so every listener has to be re-attached and anything the
// user was in the middle of (a focused field, a caret position, a drag) is
// gone. And a template literal is opaque: nothing checks that the tag you
// opened is the tag you closed, and a missing `</div>` reads as a layout bug.
//
// So: markup that never changes lives in index.html, repeating structures live
// in <template> elements there, and everything else is built here. These are
// the pieces — deliberately few, because a DOM builder that grows features
// becomes a framework, and this application does not need one.

export const byId = (id) => document.getElementById(id);

/// Properties, not attributes, for the ones the DOM exposes as properties:
/// `value` set as an attribute is only the *default* value, which is a
/// difference that does not show up until a control is rebuilt under someone's
/// hands. Everything else — `data-*` above all — goes through setAttribute.
const PROPS = new Set(['id', 'value', 'type', 'checked', 'disabled', 'title',
                       'placeholder', 'min', 'max', 'step', 'src', 'loop',
                       'muted', 'width', 'height', 'selected', 'textContent',
                       'className', 'htmlFor', 'name']);

/// One element. `cls` and `text` are named rather than passed as `className`
/// and `textContent` because between them they are most of every call.
///
///     el('button', { cls: 'tiny', text: 'Choose…', on: { click: browse } })
export function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    for (const k of Object.keys(opts)) {
        const v = opts[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'cls') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'on') for (const ev of Object.keys(v)) node.addEventListener(ev, v[ev]);
        else if (k === 'style') for (const s of Object.keys(v)) node.style[s] = v[s];
        else if (PROPS.has(k)) node[k] = v;
        else node.setAttribute(k, String(v));
    }
    add(node, children);
    return node;
}

/// Append children, flattening arrays and skipping nothing-in-particular, so
/// a caller can write `[a, cond && b, list.map(...)]` without filtering first.
export function add(node, children) {
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
        if (c === null || c === undefined || c === false || c === '') continue;
        if (Array.isArray(c)) add(node, c);
        else node.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    }
    return node;
}

/// Replace everything under a node.
///
/// `build` is a function and not a list of children, so that the old content
/// is gone before the new content is made. Passing an array evaluates it
/// first, which means both generations of the panel exist at once, in the same
/// document, for the length of the call — and anything keyed on something they
/// share (bro's id index was, and answered with the wrong one for it) sees two
/// claimants where the code plainly meant one to replace the other. That bug
/// is fixed upstream; the order is still the honest one, and a signature that
/// only accepts a builder cannot be called the other way round.
export function put(node, build) {
    if (!node) return node;
    node.replaceChildren();
    return add(node, build());
}

/// A working copy of a <template>'s content, as an element rather than a
/// fragment: a fragment loses its identity the moment it is appended, and
/// every caller here wants to hold on to what it just made.
export function fromTemplate(id) {
    const t = byId(id);
    if (!t || !t.content) throw new Error(`no <template id="${id}">`);
    const first = t.content.querySelector('*');
    if (!first) throw new Error(`<template id="${id}"> is empty`);
    return first.cloneNode(true);
}

/// Shorthands for the two things almost every readout is.
export const span = (text, cls) => el('span', { cls, text });
export const div = (cls, children) => el('div', { cls }, children);

/// `<select>` from a list of choices, with one of them chosen. A choice is
/// either a string or `{ id, label }`; anything else the caller can map first.
export function select(opts, choices, chosen) {
    const node = el('select', opts);
    for (const c of choices) {
        const value = String(c && c.id !== undefined ? c.id : c);
        const label = String(c && c.label !== undefined ? c.label : c);
        node.append(el('option', { value, text: label, selected: value === String(chosen) }));
    }
    // Set afterwards as well: `selected` on an option is the markup default,
    // and a rebuilt control has to end up showing the value it was given.
    if (chosen !== undefined && chosen !== null) node.value = String(chosen);
    return node;
}

/// A row of buttons that are one choice — the segmented control. `items` are
/// `{ v, l, title }`; `onPick` gets the value.
///
/// `name` goes on each button as `data-seg`. Nothing in the app reads it —
/// every button carries its own listener — but it is what a test and a
/// stylesheet have to point at, and a control nothing can name is a control
/// nothing can check.
export function segmented(name, items, chosen, onPick) {
    return div('seg', items.map((it) => el('button', {
        cls: 'tiny' + (String(it.v) === String(chosen) ? ' on' : ''),
        text: it.l,
        title: it.title,
        'data-seg': name,
        'data-v': it.v,
        on: { click: () => onPick(it.v) },
    })));
}

export function show(node, on) {
    if (node) node.classList.toggle('hidden', !on);
}

/// A labelled row: `<div class="row"><span class="key">…</span><span
/// class="val">…</span></div>`. `value` is anything `add()` takes, so the same
/// row holds a string in the Sources stage and a slider in the encode form.
///
/// Here rather than beside either of them because it was written twice — once
/// for the form and once for the panel that reads a file out — and two
/// implementations of the same three elements is how two panels that should
/// line up stop lining up.
export function row(key, value) {
    const node = fromTemplate('tpl-row');
    node.querySelector('.key').textContent = key;
    add(node.querySelector('.val'), value);
    return node;
}

/// A heading inside a column.
export const head = (text, opts = {}) =>
    el('div', Object.assign({ cls: 'section-head', text }, opts));
