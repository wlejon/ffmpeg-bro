// The pieces the settings form is made of.
//
// A labelled row, a number field with its unit, a cluster of buttons. They are
// here rather than inline in the form because the form is a hundred rows and
// the difference between reading it and not is whether each row is one line.

import { el, div, span } from '../dom.js';

// `row` and `head` used to live here. They are in dom.js now, beside the other
// builders: the Sources stage reads a file out in the same rows this form is
// made of, and one of them had to be the copy.

/// A cluster of controls that belong together on one line. The class matters:
/// without it the row wraps prose, which is what the rest of a row is for.
export const btns = (children, cls = 'btns') => div(cls, children);

/// A number input, its unit, and the note that goes with it. `name` is the
/// `data-f` hook — see dom.js on why nothing built at runtime carries an id.
export function num(name, opts, after) {
    return btns([
        el('input', Object.assign({ cls: 'num', 'data-f': name, type: 'number' }, opts)),
        after ? span(after, 'dim') : null,
    ]);
}

/// A note under a control: what libavcodec called this thing, mostly.
export const note = (text) => span(text, 'dim tiny-note');
