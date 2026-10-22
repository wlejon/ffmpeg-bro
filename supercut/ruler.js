// The Line tab: the sentence typed, and under it the line drawn on a ruler of
// time and adjusted by ear.
//
// `supercut/line.js` decides every word of what a line *is* — which take, where
// the cut is, how long the rest after it lasts, what → Mix lays — and this draws
// it and owns the gestures, which is the same split `results.js` keeps with
// `ui/library.js`.

import { el, div, put, setText } from '../ui/dom.js';
import { bare } from '../ui/phrase.js';
import * as library from '../ui/library.js';
import * as line from './line.js';
import * as waves from './waves.js';
import {
    bindRulerContext, paintAll, paintPanel, panel, syncBox, remove,
    commit, selectedWord, sectionOf, select, selectRelative,
    cycleTake, nudge, repaint, reload, arrive, leave, key,
} from './ruler-panel.js';

export {
    commit, selectedWord, sectionOf, select, selectRelative,
    cycleTake, nudge, repaint, reload, arrive, leave, key,
};

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

bindRulerContext({
    nodes: () => nodes, rulerNode: () => rulerNode, panelNode: () => panelNode,
    selected: () => selected, setSelected: (v) => { selected = v; },
    section: () => section, setSection: (v) => { section = v; },
    playingWord: () => playingWord, sectionIndices: () => sectionIndices(),
    clearSelectionState: () => { selected = -1; section = null; },
    draw: () => draw(), redraw: () => redraw(),
    redrawRuler: () => redrawRuler(), redrawPanel: () => redrawPanel(),
    drawControls: () => drawControls(), drawNote: () => drawNote(),
    hear: (i) => hear(i), hush: () => hush(), say: () => say(), stopSay: () => stopSay(),
    loopWord: (i) => loopWord(i), stopWordLoop: () => stopWordLoop(), stopAll: () => stopAll(),
    toggleLooping: () => toggleLooping(), isSaying: () => saying, isWordLooping: () => wordLooping,
});

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

function rowSeconds() {
    return line.onBeatOf() ? line.stepsPerBar() * line.stepSeconds() : ROW_SECONDS;
}

function rowWidth() {
    const w = nodes.list ? nodes.list.clientWidth : 0;
    return Math.max(300, (w || 680) - 30);
}

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
                ? block(p, (to - from) * pxPerSec, a < r0, b > r1)
                : gap(p, (to - from) * pxPerSec));
        }
        out.push(div('l-rowt', [
            el('span', { cls: 'l-rowno mono', text: line.onBeatOf() ? String(r + 1) : `${r0.toFixed(0)}s` }),
            div('l-cells', kids),
        ]));
    }
    return out;
}

function block(p, w, cont, more) {
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

function sectionIndices() {
    if (!section) return null;
    const a = Math.min(section.a, section.b), b = Math.max(section.a, section.b);
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
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
