// The pipeline, as the thing you navigate.
//
// ffmpeg's model is inputs → streams → a filter graph → encoders → a muxer →
// an output file. This application's model was a timeline and an export
// dialog, which is an NLE's, and the mismatch is where everything it cannot do
// yet lives: stream copy, per-stream mapping, two-pass, filters and the
// hardware paths all have an obvious place in the first model and nowhere at
// all in the second.
//
// So the chain is the spine, and it is both the diagram and the navigation.
// Each stage carries what it is currently set to, so the bar states the whole
// render at a glance and clicking a part of that statement is how you go and
// change it. Warnings belong to the stage that caused them rather than to a
// blob at the bottom of a form.
//
// The views hide each other with `display:none` and are never unmounted, for
// the reason the two workspaces before them were: the viewer's <video>
// elements *are* the decoders, and tearing them down to look at an encoder
// setting would mean rebuilding and re-seeking every one on the way back. The
// consequence is unchanged and still bites — anything in the frame loop that
// measures a panel has to ignore a measurement of zero, because four fifths of
// the window is display:none at any moment.

import { el, div, span, put, show } from './dom.js';

/// The stages, in the order the data flows. `state` is a function rather than
/// a string because the bar is redrawn from the model and never kept in sync
/// field by field — a spine that can disagree with the render is worse than
/// one that is rebuilt.
const STAGES = [
    // Before Sources, because it is where an input comes from when there is
    // not one yet — and it is the one card on this bar that is not a question
    // about the file coming out. `ffmpeg -f gdigrab -i desktop out.mkv` is a
    // whole pipeline whose output is a file, and then you open that file; the
    // arrow into Sources is that, crossed at a different time. When nothing is
    // being recorded the card says so, which is a statement about the machine
    // rather than a claim about this render.
    { id: 'capture', name: 'Capture' },
    { id: 'sources', name: 'Sources' },
    { id: 'compose', name: 'Compose' },
    // Between the edit and the encoder, which is where it is in ffmpeg: the
    // filter graph is what the decoded streams are put through on the way to
    // being encoded, and putting it anywhere else in this bar would be a
    // picture of a pipeline that does not exist.
    { id: 'graph',   name: 'Graph' },
    { id: 'encode',  name: 'Encode' },
    { id: 'write',   name: 'Write' },
];

let bar = null;
let views = {};
let hooks = {};
let current = 'compose';

export function initShell(refs, h) {
    bar = refs.bar;
    views = refs.views;
    hooks = h || {};
    drawSpine();
    apply();
}

export function currentStage() { return current; }

export function stages() { return STAGES.map((s) => s.id); }

/// Move to a stage. Refused rather than half-done when the stage says it is
/// not ready: offering a door that will not open is worse than not offering
/// one, and the caller gets told so it can say why.
export function goTo(id) {
    if (id === current) return true;
    if (!STAGES.some((s) => s.id === id)) return false;
    const why = hooks.blocked ? hooks.blocked(id) : null;
    if (why) { if (hooks.flash) hooks.flash(why); return false; }
    const leaving = current;
    current = id;
    apply();
    if (hooks.changed) hooks.changed(id, leaving);
    drawSpine();
    return true;
}

/// One step along the chain, which is what a keyboard shortcut wants: the
/// pipeline has an order and moving through it should follow that order rather
/// than cycling through a list of tabs.
export function step(delta) {
    const i = STAGES.findIndex((s) => s.id === current);
    const next = STAGES[Math.max(0, Math.min(STAGES.length - 1, i + delta))];
    if (next) goTo(next.id);
}

function apply() {
    for (const s of STAGES) show(views[s.id], s.id === current);
    // A class per stage as well as the visibility, because plenty of chrome
    // outside these four boxes has an opinion about which one is up — the
    // command bar is not worth drawing while there is nothing to describe.
    const body = document.body;
    for (const s of STAGES) body.classList.toggle(`stage-${s.id}`, s.id === current);
}

/// The bar. Rebuilt whole rather than patched: it is eight short strings, and
/// the failure it is there to prevent is describing a render that is not the
/// one about to happen.
export function drawSpine() {
    if (!bar) return;
    put(bar, () => STAGES.map((s, i) => {
        const keyNum = String(i + 1);
        const state = hooks.state ? hooks.state(s.id) : null;
        const warn = hooks.warnings ? hooks.warnings(s.id) : null;
        const texts = warn && warn.length ? warn.map((w) => (typeof w === 'string' ? w : w.text)) : [];
        const hasErr = warn && warn.some((w) => typeof w !== 'string' && w.level === 'error');
        const card = el('button', {
            cls: 'st' + (s.id === current ? ' on' : '') + (texts.length ? (hasErr ? ' warn error' : ' warn') : ''),
            'data-stage': s.id,
            'data-key': keyNum,
            'data-shortcut': keyNum,
            title: texts.length ? texts.join('\n') : undefined,
            on: { click: () => goTo(s.id) },
        }, [
            div('st-head', [
                span(s.name, 'st-name'),
                span(keyNum, 'st-key'),
            ]),
            // Two lines, always both present even when empty, so a stage does
            // not change height as its state fills in and shove the picture
            // below it up and down.
            div('st-state', (state && state[0]) || ' '),
            div('st-state dim', (state && state[1]) || ' '),
        ]);
        return i === 0 ? card : [span('→', 'st-arrow'), card];
    }));
}
