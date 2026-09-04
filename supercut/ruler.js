// The Line tab: the sentence typed, and under it the line drawn on a ruler of
// time and adjusted by ear.
//
// `supercut/line.js` decides every word of what a line *is* — which take, where
// the cut is, how long the rest after it lasts, what → Mix lays — and this draws
// it and owns the gestures, which is the same split `results.js` keeps with
// `ui/library.js`.
//
// ── The box is the way in, and the ruler is the way to adjust ─────────────
//
// The line is typed into one box. Every word resolves as it is completed and
// the word that just landed is heard, because the natural way to be told that
// a word exists in this voice is to hear it in this voice. Enter says the
// whole line back; `→ Mix` is a separate press, because the mix is the final
// step and the line is tuned by ear before it is looked at.
//
// Under the box the line is drawn as blocks on rows of time: a block's width
// is how long the word is, the space after it is its rest, and each block
// carries the shape of its own sound. That is what a person reads pacing off,
// and it is what the step sequencer this replaced could not show — a grid
// drew every word as a count of cells, and speech is not counted. When *on a
// beat* is ticked the rows become bars and the beats are drawn on them; the
// blocks are the same blocks, rounded to the grid.
//
// ── The gestures, none of them a mode ─────────────────────────────────────
//
//   - **click a word** — selects it and plays it; the panel is about it.
//   - **drag across words** — a section; the pace and the gain apply to it,
//     and Space plays it.
//   - **drag a word by its top edge** — moves it along the line.
//   - **drag a word's right edge** — where the word ends in the recording.
//   - **drag the space after a word** — how long its rest is.
//   - in the panel, **drag the edges of the word's own waveform** — where the
//     cut is, either end; drag inside it to slide both.
//
// Everything is heard on the change: the next take plays, a released edge
// plays, a slid word plays. The panel has no audition length in it, because
// what plays is exactly what the mix would hold.
//
// ── Say is the line out of the pool, for now ──────────────────────────────
//
// Say plays the line piece by piece through `screen.audition`, the one element
// every row shares. It is not the render — nothing has been built — so there
// is a seam at every join, which is also the truth about what the words are.
// The plan is for Say to be the render of the line's clips before they are in
// the mix (`PLAN-supercut-line.md`), which is what makes fades and gain
// audible; until then the mix's own playback is where those are heard.

import { el, div, put, setText } from '../ui/dom.js';
import { bare } from '../ui/phrase.js';
import * as library from '../ui/library.js';
import * as line from './line.js';
import * as waves from './waves.js';

let hooks = {};
let nodes = {};

/// The word the panel is about, by index. -1 for none.
let selected = -1;
/// A section: `{ a, b }` inclusive indices, or null. When set, `selected`
/// is one end of it.
let section = null;
/// The word being heard, for the block that lights up.
let playingWord = -1;
/// A drag: `{ kind, i, x0, y0, moved, ... }`.
let gesture = null;
let taps = [];

let saying = false;
let looping = false;
let sayTimer = null;
let wordLooping = false;
let wordTimer = null;

let rulerNode = null;
let panelNode = null;
let pxPerSec = 150;

/// How many seconds a row holds when the line is not on a beat. Four: a
/// sentence a row, and a word of a third of a second is fifty pixels.
const ROW_SECONDS = 4;
/// How much of the recording is drawn either side of the word in the panel.
const CONTEXT = 0.5;

export function initRuler(refs, h) {
    nodes = refs;
    hooks = h || {};
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ── what the tab says ──────────────────────────────────────────────────────

/// One statement: how long the line is, what nothing says, what is still
/// being measured, and what the mix holds of it.
export function drawNote() {
    const node = nodes.note;
    if (!node) return;
    node.classList.remove('bad');
    const plan = line.plan();
    const bits = [];
    if (!library.available()) bits.push('no corpus');
    const n = line.count();
    if (n) bits.push(`${n} word${n === 1 ? '' : 's'} · ${plan.seconds.toFixed(2)} s`);
    if (line.onBeatOf()) bits.push(`${(line.stepSeconds() * 1000).toFixed(0)} ms a step`);
    if (plan.missing.length) bits.push(`nothing says ${plan.missing.map((w) => `"${w}"`).join(', ')}`);
    const snapping = line.snapping();
    if (snapping) bits.push(`finding the beat in ${snapping}`);
    const said = line.note();
    if (said) bits.push(said);
    setText(node, bits.join(' · '));
}

// ── the controls ───────────────────────────────────────────────────────────

export function drawControls() {
    put(nodes.controls, () => {
        const box = el('input', {
            type: 'text', id: 'l-text', value: line.textOf(), placeholder: 'the line',
            on: {
                input: () => typed(box),
                keydown: (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        if (e.ctrlKey || e.metaKey) { commit(); return; }
                        if (hint >= 0 && hints.length) { takeHint(box); return; }
                        line.setText(box.value, { all: true });
                        hintsOff();
                        redraw();
                        say();
                        return;
                    }
                    if (e.key === 'Tab' && hints.length) { e.preventDefault(); if (hint < 0) hint = 0; takeHint(box); return; }
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        if (!hints.length) return;
                        e.preventDefault();
                        hint = e.key === 'ArrowDown' ? (hint + 1) % hints.length : (hint - 1 + hints.length) % hints.length;
                        showHints();
                        return;
                    }
                    if (e.key === 'Escape') { hintsOff(); box.blur(); }
                },
                blur: () => { setTimeout(hintsOff, 0); },
            },
        });
        hintsNode = div('l-hints');
        const sayBtn = el('button', {
            cls: 'tiny' + (saying ? ' on' : ''), id: 'l-say',
            text: saying ? '■ Stop' : '▶ Say', title: saying ? 'Stop (Space)' : 'Say (Space)',
            on: { click: () => toggleSay() },
        });
        const loop = el('label', { cls: 'check' }, [
            el('input', { type: 'checkbox', id: 'l-loop', checked: looping,
                          on: { change: (e) => setLooping(e.target.checked) } }),
            'loop',
        ]);
        const paceVal = el('span', { cls: 'l-val mono', text: `${line.paceOf(sectionIndices()).toFixed(2)}×` });
        const pace = el('input', {
            type: 'range', id: 'l-pace', min: String(line.PACE_MIN), max: String(line.PACE_MAX),
            step: '0.05', value: String(line.paceOf(sectionIndices())),
            on: {
                input: () => {
                    const v = line.setPace(Number(pace.value), sectionIndices());
                    setText(paceVal, `${v.toFixed(2)}×`);
                    redrawRuler(); redrawPanel(); drawNote();
                },
                change: () => { if (line.count()) say(); },
            },
        });
        const beat = el('label', { cls: 'check' }, [
            el('input', { type: 'checkbox', id: 'l-beat', checked: line.onBeatOf(),
                          on: { change: (e) => { line.setOnBeat(e.target.checked); drawControls(); redraw(); } } }),
            'on a beat',
        ]);
        const grid = [];
        if (line.onBeatOf()) {
            const bpm = el('input', {
                type: 'number', id: 'l-tempo', step: '1', min: '20', max: '600', value: String(line.tempoOf()),
                on: { change: () => { line.setTempo(bpm.value); bpm.value = String(line.tempoOf()); redraw(); } },
            });
            const tap = el('button', {
                cls: 'text', id: 'l-tap', text: 'Tap',
                on: { click: () => { if (tapTempo()) { bpm.value = String(line.tempoOf()); redraw(); } } },
            });
            const steps = el('select', { id: 'l-steps', on: { change: () => { line.setStepsPerBeat(steps.value); redraw(); } } },
                line.GRIDS.map((n) => el('option', { value: String(n), text: `${n} a beat`, selected: n === line.stepsPerBeat() })));
            const bars = el('select', { id: 'l-bar', on: { change: () => { line.setBeatsPerBar(bars.value); redraw(); } } },
                [2, 3, 4, 5, 6, 7, 8].map((n) => el('option', { value: String(n), text: `${n} a bar`, selected: n === line.beatsPerBar() })));
            grid.push(bpm, tap, steps, bars);
        }
        const loose = el('label', { cls: 'check' }, [
            el('input', { type: 'checkbox', id: 'l-loose', checked: line.looseOf(),
                          on: { change: (e) => { line.setLoose(e.target.checked); redraw(); } } }),
            'inside longer words',
        ]);
        const hold = el('label', { cls: 'check', title: 'A rest holds the shot' }, [
            el('input', { type: 'checkbox', id: 'l-hold', checked: line.restHoldOf(),
                          on: { change: (e) => { line.setRestHold(e.target.checked); } } }),
            'hold',
        ]);
        const mix = el('button', {
            cls: 'go', id: 'l-mix', text: '→ Mix', title: 'Put the line in the mix (Ctrl+Enter)',
            disabled: !line.count() || line.busy(),
            on: { click: () => commit() },
        });
        const clear = el('button', {
            cls: 'text', id: 'l-clear', text: 'Clear', disabled: !line.count(),
            on: { click: () => { stopAll(); line.clear(); selected = -1; section = null; drawControls(); redraw(); arrive(); } },
        });
        return [
            div('l-textrow', [box, hintsNode]),
            div('l-row', [sayBtn, loop, el('span', { cls: 'dim', text: '· pace' }), pace, paceVal, beat, ...grid]),
            div('l-row', [loose, hold, el('span', { cls: 'spacer' }), clear, mix]),
        ];
    });
}

/// The box changed: the words follow, and the one that just landed is heard.
function typed(box) {
    const { landed } = line.setText(box.value);
    hintsFor(box.value);
    // The two presses that depend on there being words, without rebuilding
    // the box under the caret.
    for (const id of ['l-mix', 'l-clear']) {
        const b = document.getElementById(id);
        if (b) b.disabled = !line.count() || (id === 'l-mix' && line.busy());
    }
    if (landed.length) {
        const i = landed[landed.length - 1];
        selected = i;
        section = null;
        hear(i);
    }
    redraw();
}

// ── what the corpus says about what is being typed ─────────────────────────

let hintsNode = null;
let hints = [];
let hint = -1;

/// The word being typed at the end of the box, with how often it is said,
/// then the words that begin with it. Nothing for a closed word.
function hintsFor(value) {
    hints = [];
    hint = -1;
    const m = /(\S+)$/.exec(String(value || ''));
    const typed_ = m ? m[1] : '';
    if (typed_ && !typed_.includes('"') && !typed_.includes('|') && library.available() && library.current()) {
        const key = bare(typed_);
        if (key.length >= 2) {
            hints.push({ word: key, n: library.saidCount(typed_) });
            for (const s of library.suggest(typed_, 6)) if (s.word !== key) hints.push(s);
            hints = hints.slice(0, 6);
        }
    }
    showHints();
}

function showHints() {
    if (!hintsNode) return;
    put(hintsNode, () => hints.map((h, n) => {
        const row = div('l-hint' + (n === hint ? ' on' : '') + (h.n ? '' : ' none'), [
            el('span', { cls: 'w', text: h.word }),
            el('span', { cls: 'n mono', text: `×${h.n}` }),
        ]);
        row.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            hint = n;
            takeHint(document.getElementById('l-text'));
        });
        return row;
    }));
}

function hintsOff() { hints = []; hint = -1; showHints(); }

/// Put the picked word in place of the one being typed, and a space after it.
function takeHint(box) {
    if (!box || hint < 0 || !hints[hint]) return;
    box.value = String(box.value).replace(/(\S+)$/, hints[hint].word) + ' ';
    hintsOff();
    typed(box);
    box.focus();
}

function tapTempo() {
    const now = Date.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 8) taps = taps.slice(-8);
    if (taps.length < 2) return false;
    line.setTempo(Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))));
    return true;
}

// ── the ruler ──────────────────────────────────────────────────────────────

export function draw() {
    if (!nodes.list) return;
    put(nodes.list, () => {
        rulerNode = el('div', { id: 'l-ruler' }, rows());
        panelNode = el('div', { id: 'l-panel' }, panel());
        return [rulerNode, panelNode];
    });
    paintAll();
}

function redraw() { draw(); drawNote(); }
function redrawRuler() { if (!rulerNode) return draw(); put(rulerNode, rows); paintAll(); }
function redrawPanel() { if (!panelNode) return draw(); put(panelNode, panel); paintPanel(); }

/// How many seconds a row is, and how wide.
function rowSeconds() {
    return line.onBeatOf() ? line.stepsPerBar() * line.stepSeconds() : ROW_SECONDS;
}

function rowWidth() {
    const w = nodes.list ? nodes.list.clientWidth : 0;
    return Math.max(300, (w || 680) - 30);
}

/// Rows of time, each holding `rowSeconds` of the line; a piece that crosses
/// a row boundary is drawn in both. Always one row more than the line needs
/// when it ends exactly on one, so there is room to see the end.
function rows() {
    const plan = line.plan();
    const R = rowSeconds();
    pxPerSec = rowWidth() / R;
    const total = plan.seconds;
    const count = Math.max(1, Math.ceil((total + 1e-9) / R));
    const out = [];
    for (let r = 0; r < count; r++) {
        const r0 = r * R, r1 = r0 + R;
        const kids = [];
        // The beats, when on one.
        if (line.onBeatOf()) {
            const step = line.stepSeconds();
            for (let s = 1; s < line.stepsPerBar(); s++) {
                const mark = div('l-beat' + (s % line.stepsPerBeat() === 0 ? ' major' : ''));
                mark.style.left = `${(s * step * pxPerSec).toFixed(1)}px`;
                kids.push(mark);
            }
        }
        for (const p of plan.pieces) {
            const a = p.start, b = p.start + p.seconds;
            if (b <= r0 + 1e-9 || a >= r1 - 1e-9) continue;
            const from = Math.max(a, r0), to = Math.min(b, r1);
            kids.push(p.kind === 'word'
                ? block(p, (to - from) * pxPerSec, a < r0, b > r1, plan)
                : gap(p, (to - from) * pxPerSec));
        }
        out.push(div('l-rowt', [
            el('span', { cls: 'l-rowno mono', text: line.onBeatOf() ? String(r + 1) : `${r0.toFixed(0)}s` }),
            div('l-cells', kids),
        ]));
    }
    return out;
}

/// A word, `w` pixels of it. The label may run over the rest that follows it
/// — a word is longer than the sound it names at this scale.
function block(p, w, cont, more, plan) {
    const i = p.word;
    const cls = ['l-word'];
    if (cont) cls.push('cont');
    if (more) cls.push('more');
    if (i === selected || inSection(i)) cls.push('sel');
    if (i === playingWord) cls.push('playing');
    if (p.hole) cls.push('bad');
    if (p.stretched) cls.push('stretched');
    const wd = line.wordsOf()[i];
    if (wd && (wd.head || wd.tail)) cls.push('slipped');
    const b = div(cls.join(' '));
    b.style.width = `${Math.max(2, w).toFixed(1)}px`;
    b.dataset.word = String(i);
    b.title = p.phrase;
    if (!p.hole) {
        const canvas = el('canvas', { cls: 'wave' });
        canvas.dataset.path = p.hit.vod.media;
        canvas.dataset.from = String(p.from);
        canvas.dataset.until = String(p.until);
        canvas.dataset.w = String(Math.round(w));
        b.appendChild(canvas);
    }
    if (!cont) {
        const txt = el('span', { cls: 'txt', text: p.phrase });
        // Over its own width and the rest after, less a margin.
        const spill = p.gap ? ((p.seconds + p.gap) / p.seconds) * 100 - 6 : 96;
        txt.style.width = `${Math.max(40, spill).toFixed(1)}%`;
        b.appendChild(txt);
    }
    const grip = div('grip');
    grip.title = 'Move';
    grip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        begin('move', i, e);
    });
    b.appendChild(grip);
    if (!more) {
        const grab = div('grab');
        grab.title = 'Where the word ends';
        grab.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            begin('tail', i, e);
        });
        b.appendChild(grab);
    }
    b.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        begin(e.shiftKey ? 'extend' : 'select', i, e);
    });
    b.addEventListener('dblclick', (e) => {
        e.preventDefault();
        selected = i; section = null;
        redraw();
        const f = document.getElementById('l-phrase');
        if (f) { f.focus(); try { f.select(); } catch (err) { /* fine */ } }
    });
    return b;
}

/// The rest after a word: dragged sideways, it is longer or shorter.
function gap(p, w) {
    const g = div('l-gap');
    g.style.width = `${Math.max(1, w).toFixed(1)}px`;
    g.title = `${Math.round(p.seconds * 1000)} ms`;
    g.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        begin('gap', p.word, e);
    });
    return g;
}

function inSection(i) { return !!section && i >= Math.min(section.a, section.b) && i <= Math.max(section.a, section.b); }

/// The indices a section covers, or null for the whole line.
function sectionIndices() {
    if (!section) return null;
    const a = Math.min(section.a, section.b), b = Math.max(section.a, section.b);
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
}

// ── the sound on the blocks ────────────────────────────────────────────────

/// Paint every block's envelope that has an answer. Called after a draw and
/// on the frames an answer lands.
function paintAll() {
    if (!rulerNode) return;
    for (const canvas of rulerNode.querySelectorAll('canvas.wave')) {
        const path = canvas.dataset.path;
        const from = Number(canvas.dataset.from), until = Number(canvas.dataset.until);
        const w = Math.max(4, Number(canvas.dataset.w) || 4);
        const n = Math.max(8, Math.round(w / 2));
        const wv = waves.wave(path, from, until, n);
        if (!wv || wv.error || canvas.dataset.done === 'yes') continue;
        canvas.dataset.done = 'yes';
        const h = canvas.clientHeight || 28;
        canvas.width = w; canvas.height = h;
        paintWave(canvas.getContext('2d'), wv, 0, w, h, null);
    }
    paintPanel();
}

/// An envelope into a rectangle. `kept`, when given, is `[x0, x1]` — the span
/// inside it that is the cut, drawn brighter than the rest.
function paintWave(ctx, wv, x, w, h, kept) {
    const n = wv.rms.length;
    const mid = h / 2;
    const half = h / 2 - 1;
    for (let i = 0; i < n; i++) {
        const px = x + (i / n) * w;
        const pw = Math.max(1, w / n);
        const inside = !kept || (px >= kept[0] && px <= kept[1]);
        const lo = Math.max(-1, wv.min[i]) * half;
        const hi = Math.min(1, wv.max[i]) * half;
        ctx.fillStyle = inside ? 'rgba(74,158,255,.40)' : 'rgba(120,130,150,.22)';
        ctx.fillRect(px, mid + lo, pw, Math.max(1, hi - lo));
        const r = Math.min(1, wv.rms[i]) * half;
        ctx.fillStyle = inside ? 'rgba(120,190,255,.85)' : 'rgba(150,160,180,.45)';
        ctx.fillRect(px, mid - r, pw, Math.max(1, r * 2));
    }
}

// ── the gestures ───────────────────────────────────────────────────────────

function begin(kind, i, e) {
    const p = line.pieceOf(i);
    gesture = {
        kind, i, x0: e.clientX, y0: e.clientY, moved: false,
        tail0: line.tailOf(i), head0: line.headOf(i), gap0: p ? p.gap : 0,
    };
}

function onMove(e) {
    if (!gesture) return;
    const dx = e.clientX - gesture.x0;
    const dy = e.clientY - gesture.y0;
    if (!gesture.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    gesture.moved = true;
    const dt = dx / pxPerSec;
    if (gesture.kind === 'tail') {
        line.setTail(gesture.i, gesture.tail0 + dt);
        redrawRuler(); redrawPanel(); drawNote();
        return;
    }
    if (gesture.kind === 'gap') {
        line.setGap(gesture.i, gesture.gap0 + dt);
        redrawRuler(); drawNote();
        return;
    }
    const under = wordAt(e.clientX, e.clientY);
    if (gesture.kind === 'move') {
        if (under < 0 || under === gesture.i) return;
        const j = line.moveWord(gesture.i, under);
        if (j < 0) return;
        if (selected === gesture.i) selected = j;
        gesture.i = j;
        section = null;
        drawControls();
        redrawRuler(); redrawPanel();
        return;
    }
    // A select or an extend that moved: a section from where it began.
    if (under < 0) return;
    const a = gesture.kind === 'extend' && section ? section.a : gesture.i;
    if (!section || section.a !== a || section.b !== under) {
        section = { a, b: under };
        selected = under;
        redrawRuler(); redrawPanel();
        drawControls();
    }
}

function onUp() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.kind === 'tail' || g.kind === 'gap') { if (g.moved) hear(g.i); return; }
    if (g.kind === 'move') { if (g.moved) drawControls(); return; }
    if (!g.moved) {
        if (g.kind === 'extend' && selected >= 0) {
            section = { a: section ? section.a : selected, b: g.i };
            selected = g.i;
            redraw(); drawControls();
            return;
        }
        click(g.i);
    }
}

/// Which word is under a point on the screen, or -1.
function wordAt(x, y) {
    if (!rulerNode) return -1;
    let best = -1;
    let dist = Infinity;
    for (const b of rulerNode.querySelectorAll('.l-word')) {
        const r = b.getBoundingClientRect();
        if (y < r.top - 6 || y > r.bottom + 6) continue;
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (d < dist) { dist = d; best = Number(b.dataset.word); }
    }
    return best;
}

/// A word pressed and released: selected and heard; pressed again while
/// playing, stopped.
function click(i) {
    selected = i;
    section = null;
    if (playingWord === i && !saying && !wordLooping) hush();
    else hear(i);
    drawControls();
    redraw();
}

// ── hearing ────────────────────────────────────────────────────────────────

function hear(i) {
    const p = line.pieceOf(i);
    if (!p || !p.hit) return false;
    playingWord = i;
    hooks.audition(p.hit.vod.media, p.from, p.until, p.rate);
    markPlaying();
    return true;
}

function markPlaying() {
    if (!rulerNode) return;
    for (const b of rulerNode.querySelectorAll('.l-word'))
        b.classList.toggle('playing', Number(b.dataset.word) === playingWord);
}

export function hush() {
    if (playingWord < 0 && !wordLooping) return false;
    stopWordLoop();
    if (hooks.hush) hooks.hush();
    playingWord = -1;
    markPlaying();
    return true;
}

export function auditioning() { return playingWord >= 0; }

export function stopped() {
    if (saying || wordLooping) return;
    if (playingWord < 0) return;
    playingWord = -1;
    markPlaying();
}

/// Say the line — or the section — piece by piece, in time.
export function say() {
    stopWordLoop();
    stopSay();
    const plan = line.plan();
    let pieces = plan.pieces;
    const idx = sectionIndices();
    if (idx) {
        const a = idx[0], b = idx[idx.length - 1];
        pieces = pieces.filter((p) => p.word >= a && p.word <= b);
    }
    if (!pieces.length) return false;
    for (const p of pieces) if (p.hit && hooks.warmPath) hooks.warmPath(p.hit.vod.media);
    saying = true;
    sayButton();
    const go = (k) => {
        if (!saying) return;
        if (k >= pieces.length) {
            if (looping) { go(0); return; }
            stopSay();
            return;
        }
        const p = pieces[k];
        if (p.kind === 'word' && p.hit) {
            playingWord = p.word;
            hooks.audition(p.hit.vod.media, p.from, p.until, p.rate);
        } else {
            playingWord = -1;
            if (hooks.hush) hooks.hush();
        }
        markPlaying();
        sayTimer = setTimeout(() => go(k + 1), Math.max(20, p.seconds * 1000));
    };
    go(0);
    return true;
}

export function isSaying() { return saying; }

export function stopSay() {
    if (!saying && !sayTimer) return false;
    saying = false;
    if (sayTimer) { clearTimeout(sayTimer); sayTimer = null; }
    if (hooks.hush) hooks.hush();
    playingWord = -1;
    markPlaying();
    sayButton();
    return true;
}

export function toggleSay() {
    if (saying) { stopSay(); return false; }
    return say();
}

function sayButton() {
    const btn = document.getElementById('l-say');
    if (!btn) return;
    setText(btn, saying ? '■ Stop' : '▶ Say');
    btn.classList.toggle('on', saying);
    btn.title = saying ? 'Stop (Space)' : 'Say (Space)';
}

export function isLooping() { return looping; }
export function setLooping(on) {
    looping = !!on;
    const box = document.getElementById('l-loop');
    if (box && box.checked !== looping) box.checked = looping;
}
export function toggleLooping() { setLooping(!looping); return looping; }

/// One word over and over, for dialling in its cut.
export function loopWord(i) {
    if (wordLooping && selected === i) { stopWordLoop(); redrawPanel(); return false; }
    stopSay();
    stopWordLoop();
    selected = i;
    wordLooping = true;
    const again = () => {
        if (!wordLooping) return;
        const p = line.pieceOf(selected);
        if (!p || !p.hit) { stopWordLoop(); redrawPanel(); return; }
        hear(selected);
        wordTimer = setTimeout(again, p.seconds * 1000 + 150);
    };
    again();
    redrawPanel();
    return true;
}

export function isWordLooping() { return wordLooping; }

export function stopWordLoop() {
    if (!wordLooping && !wordTimer) return false;
    wordLooping = false;
    if (wordTimer) { clearTimeout(wordTimer); wordTimer = null; }
    if (hooks.hush) hooks.hush();
    playingWord = -1;
    markPlaying();
    return true;
}

export function stopAll() {
    const a = stopSay();
    const b = stopWordLoop();
    const c = hush();
    return a || b || c;
}

// ── the mix ────────────────────────────────────────────────────────────────

/// → Mix. The word still being typed at the end of the box counts, as it does
/// for Enter. The line's own text is what is said rather than the box's, and
/// the two are the same string whenever the box was the last thing to change
/// it — `typed` puts every keystroke there — so what this decides is only the
/// other case, a line changed under the box, which the box then follows.
export function commit() {
    stopAll();
    line.say();
    syncBox();
    const did = line.commit();
    drawControls();
    redraw();
    return did;
}

// ── the panel ──────────────────────────────────────────────────────────────

export function selectedWord() { return selected; }
export function sectionOf() { return section ? { ...section } : null; }

export function select(i) {
    const n = line.count();
    section = null;
    if (i < 0) { selected = -1; draw(); return true; }
    if (i >= n) return false;
    selected = i;
    hear(i);
    draw();
    return true;
}

export function selectRelative(delta, extend = false) {
    const n = line.count();
    if (!n) return false;
    const cur = selected >= 0 ? selected : (delta > 0 ? -1 : n);
    const next = Math.max(0, Math.min(n - 1, cur + delta));
    if (extend) {
        section = { a: section ? section.a : (selected >= 0 ? selected : next), b: next };
        selected = next;
        drawControls();
        draw();
        return true;
    }
    return select(next);
}

function panel() {
    const n = line.count();
    if (selected < 0 || selected >= n) return [];
    const idx = sectionIndices();
    if (idx && idx.length > 1) return sectionPanel(idx);
    const w = line.wordsOf()[selected];
    const p = line.pieceOf(selected);
    return [div('l-piece', [head(w, p), div('l-body', body(w, p))])];
}

function head(w, p) {
    const phrase = el('input', {
        type: 'text', id: 'l-phrase', value: w.phrase,
        on: {
            input: () => {
                if (!phrase.value.trim()) return;
                line.setPhrase(selected, phrase.value);
                const box = document.getElementById('l-text');
                if (box) box.value = line.textOf();
                redrawRuler();
                const body_ = panelNode && panelNode.querySelector('.l-body');
                if (body_) { put(body_, () => body(line.wordsOf()[selected], line.pieceOf(selected))); paintPanel(); }
                drawNote();
            },
            keydown: (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') phrase.blur(); },
        },
    });
    const bits = [];
    if (p && p.hit) {
        bits.push(`take ${p.take} of ${p.takes}`);
        bits.push(`${Math.round((p.until - p.from) * 1000)} ms`);
        if (line.onBeatOf() && p.steps) bits.push(`${p.steps} step${p.steps === 1 ? '' : 's'}`);
        const q = p.quiet || {};
        const ms = (v) => (Number.isFinite(v) ? `${Math.round(v * 1000)} ms` : '∞');
        bits.push(`quiet ${ms(q.before)} · ${ms(q.after)}`);
    }
    return div('l-line', [phrase, el('span', { cls: 'dim', text: bits.join(' · ') })]);
}

function body(w, p) {
    const i = selected;
    const rows_ = [];
    if (!p || !p.hit) {
        const why = p && p.why ? `"${w.phrase}" — ${p.why}`
                  : library.available() ? `nothing says "${w.phrase}"` : 'no corpus';
        rows_.push(div('l-line bad', [el('span', { text: why })]));
        const near = p && !p.why ? nearest(w.phrase) : [];
        if (near.length) rows_.push(div('l-line l-near', near.map((s) => el('button', {
            cls: 'tiny', text: `${s.word} ×${s.n}`,
            on: { click: () => { line.setPhrase(i, s.word); syncBox(); redraw(); } },
        }))));
        rows_.push(div('l-line', [el('span', { cls: 'spacer' }),
                                  el('button', { cls: 'tiny', text: 'Remove', on: { click: () => remove(i) } })]));
        return rows_;
    }

    // The word's own sound, with the recording either side of it: the cut is
    // the bright part, and its edges are the cut points.
    const wave = el('canvas', { id: 'l-wave' });
    wave.dataset.path = p.hit.vod.media;
    wave.dataset.from = String(p.from);
    wave.dataset.until = String(p.until);
    wave.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = wave.getBoundingClientRect();
        const scale = r.width / ((p.until - p.from) + 2 * CONTEXT);
        const x0 = CONTEXT * scale, x1 = r.width - CONTEXT * scale;
        const x = e.clientX - r.left;
        const kind = Math.abs(x - x0) <= 8 ? 'head' : Math.abs(x - x1) <= 8 ? 'tailw' : 'slide';
        cutGesture = { kind, i, x0: e.clientX, head0: w.head, tail0: w.tail, scale, moved: false };
    });
    rows_.push(div('l-line l-wavebox', [wave]));

    // Every take, ranked: the one in the line marked, any other a press away.
    if (p.takes > 1) rows_.push(takesOf(p));

    const gainVal = el('span', { cls: 'l-val mono', text: `${w.gain.toFixed(2)}×` });
    const gain = el('input', {
        type: 'range', id: 'l-gain', min: '0', max: '2', step: '0.05', value: String(w.gain),
        on: {
            input: () => { const v = line.setGain(Number(gain.value), [i]); setText(gainVal, `${v.toFixed(2)}×`); },
            change: () => hear(i),
        },
    });
    const heard = playingWord === i && !saying && !wordLooping;
    rows_.push(div('l-line', [
        el('span', { cls: 'dim', text: 'gain' }), gain, gainVal,
        el('span', { cls: 'dim', text: `· ${p.rate.toFixed(2)}×` }),
        el('span', { cls: 'spacer' }),
        el('button', {
            cls: 'tiny' + (heard ? ' on' : ''), id: 'l-hear', text: heard ? '■' : '▶',
            title: heard ? 'Stop' : 'Listen',
            on: { click: () => { if (heard) hush(); else { stopWordLoop(); hear(i); } redrawPanel(); } },
        }),
        el('button', {
            cls: 'tiny' + (wordLooping ? ' on' : ''), id: 'l-loop-word',
            text: wordLooping ? '■ loop' : '⟳ loop', title: wordLooping ? 'Stop looping' : 'Loop this word',
            on: { click: () => loopWord(i) },
        }),
        el('button', { cls: 'tiny text', text: '↺', title: 'As found', id: 'l-reset',
                       on: { click: () => { line.reset(i); redraw(); hear(i); } } }),
        el('button', { cls: 'tiny', text: 'Remove', on: { click: () => remove(i) } }),
    ]));
    return rows_;
}

/// The section's panel: the pace and the gain of every word in it.
function sectionPanel(idx) {
    const a = idx[0], b = idx[idx.length - 1];
    const plan = line.plan();
    let secs = 0;
    for (const p of plan.pieces) if (p.word >= a && p.word <= b) secs += p.seconds;
    const words = line.wordsOf();
    const label = `${words[a].phrase} … ${words[b].phrase}`;
    const rows_ = [];
    rows_.push(div('l-line', [
        el('span', { cls: 'l-secname', text: label }),
        el('span', { cls: 'dim', text: `${idx.length} words · ${secs.toFixed(2)} s` }),
    ]));
    const gainVal = el('span', { cls: 'l-val mono', text: `${line.gainOf(a).toFixed(2)}×` });
    const gain = el('input', {
        type: 'range', id: 'l-gain', min: '0', max: '2', step: '0.05', value: String(line.gainOf(a)),
        on: { input: () => { const v = line.setGain(Number(gain.value), idx); setText(gainVal, `${v.toFixed(2)}×`); } },
    });
    rows_.push(div('l-line', [
        el('span', { cls: 'dim', text: 'gain' }), gain, gainVal,
        el('button', { cls: 'tiny', id: 'l-match', text: 'match levels', title: 'Bring these words to one level',
                       on: { click: () => { const left = line.levelMatch(idx); redraw(); if (left) setText(nodes.note, `${left} still being read`); } } }),
        el('button', { cls: 'tiny', id: 'l-reroll', text: 'other takes', title: 'The next take of each',
                       on: { click: () => { for (const i of idx) line.cycleTake(i, 1); redraw(); say(); } } }),
        el('span', { cls: 'spacer' }),
        el('button', { cls: 'tiny', text: 'Remove', on: { click: () => { for (let i = b; i >= a; i--) line.removeWord(i); selected = -1; section = null; syncBox(); drawControls(); redraw(); } } }),
    ]));
    return [div('l-piece', rows_)];
}

/// A drag on the panel's waveform: an edge moves a cut point, the inside
/// slides both.
let cutGesture = null;
document.addEventListener('mousemove', (e) => {
    if (!cutGesture) return;
    const dx = e.clientX - cutGesture.x0;
    if (!cutGesture.moved && Math.abs(dx) < 3) return;
    cutGesture.moved = true;
    const dt = dx / cutGesture.scale;
    const g = cutGesture;
    if (g.kind === 'head') line.setHead(g.i, g.head0 + dt);
    else if (g.kind === 'tailw') line.setTail(g.i, g.tail0 + dt);
    else { line.setHead(g.i, g.head0 + dt); line.setTail(g.i, g.tail0 + dt); }
    redrawRuler();
    paintPanel();
    drawNote();
});
document.addEventListener('mouseup', () => {
    if (!cutGesture) return;
    const g = cutGesture;
    cutGesture = null;
    if (g.moved) { redrawPanel(); hear(g.i); }
});

/// Paint the panel's waveform: the recording either side of the word, the
/// cut bright in the middle.
function paintPanel() {
    const canvas = document.getElementById('l-wave');
    if (!canvas) return;
    const p = line.pieceOf(selected);
    if (!p || !p.hit) return;
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 56;
    const a = Math.max(0, p.from - CONTEXT);
    const b = p.until + CONTEXT;
    const wv = waves.wave(p.hit.vod.media, a, b, Math.max(64, Math.round(w / 2)));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, 0, w, h);
    const scale = w / (b - a);
    const x0 = (p.from - a) * scale, x1 = (p.until - a) * scale;
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    if (wv && !wv.error) paintWave(ctx, wv, 0, w, h, [x0, x1]);
    ctx.fillStyle = '#ff9a4a';
    ctx.fillRect(Math.round(x0), 0, 2, h);
    ctx.fillRect(Math.round(x1) - 1, 0, 2, h);
}

function takesOf(p) {
    const list = p.candidates || [];
    const shown = list.slice(0, 24);
    const kids = shown.map((c) => el('button', {
        cls: 'tiny l-takebtn' + (c.take === p.take ? ' on' : ''),
        text: `${c.take}`,
        title: `${Math.round(c.dur * 1000)} ms · ${c.score}%`,
        on: { click: () => { line.setTake(selected, c.take); redraw(); hear(selected); } },
    }));
    if (list.length > shown.length) kids.push(el('span', { cls: 'dim', text: `+${list.length - shown.length}` }));
    return div('l-line l-takes', kids);
}

function nearest(phrase) {
    const key = bare(phrase);
    if (!library.available() || !library.current()) return [];
    for (let n = key.length; n >= 2; n--) {
        const got = library.suggest(key.slice(0, n), 5).filter((s) => s.word !== key);
        if (got.length) return got;
    }
    return [];
}

/// The box shows the line as the words now are.
function syncBox() {
    const box = document.getElementById('l-text');
    if (box) box.value = line.textOf();
}

function remove(i) {
    stopWordLoop();
    if (playingWord === i) hush();
    line.removeWord(i);
    selected = -1;
    section = null;
    syncBox();
    drawControls();
    redraw();
}

export function cycleTake(delta = 1) {
    if (selected < 0) {
        if (!line.count()) return false;
        selected = 0;
    }
    line.cycleTake(selected, delta);
    redraw();
    stopWordLoop();
    hear(selected);
    return true;
}

export function nudge(deltaSec) {
    if (selected < 0) return 0;
    const v = line.nudge(selected, deltaSec);
    redraw();
    hear(selected);
    return v;
}

// ── the frame loop and the keys ────────────────────────────────────────────

/// Every frame the tab is showing: the note, and the envelopes that landed.
export function repaint() {
    drawNote();
    if (waves.poll()) paintAll();
    if (line.busy() !== busyWas) { busyWas = line.busy(); drawControls(); }
}
let busyWas = false;

export function reload() {
    line.replan();
    redraw();
}

/// Arriving on the tab: the caret goes in the box.
export function arrive() {
    draw();
    syncBox();
    const box = document.getElementById('l-text');
    if (box) box.focus();
}

export function leave() { stopAll(); }

/// A key while the tab is showing and nothing is being typed into.
export function key(e) {
    if (e.key === ' ') {
        if (saying) stopSay();
        else if (wordLooping) stopWordLoop();
        else if (playingWord >= 0) hush();
        else say();
        redrawPanel();
        return true;
    }
    if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) { commit(); return true; }
        const box = document.getElementById('l-text');
        if (box) { box.focus(); return true; }
        return false;
    }
    if (e.key === 'l' || e.key === 'L') { toggleLooping(); return true; }
    if (e.key === 'ArrowLeft') { selectRelative(-1, e.shiftKey); return true; }
    if (e.key === 'ArrowRight') { selectRelative(1, e.shiftKey); return true; }
    if (e.key === '[') { cycleTake(-1); return true; }
    if (e.key === ']') { cycleTake(1); return true; }
    if (e.key === ',' || e.key === '<') { nudge(e.shiftKey ? -0.025 : -0.005); return true; }
    if (e.key === '.' || e.key === '>') { nudge(e.shiftKey ? 0.025 : 0.005); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) {
        const idx = sectionIndices();
        if (idx && idx.length > 1) { for (let i = idx[idx.length - 1]; i >= idx[0]; i--) line.removeWord(i); selected = -1; section = null; syncBox(); drawControls(); redraw(); }
        else remove(selected);
        return true;
    }
    if (e.key === 'Escape' && (section || selected >= 0)) { section = null; selected = -1; drawControls(); redraw(); return true; }
    return false;
}
