// The Rhythm tab: the pattern drawn as a grid and edited on it.
//
// `supercut/rhythm.js` decides every word of what a pattern *is* — which step a
// word is on, which take it gets, what a build lays — and this draws it, which
// is the same split `results.js` keeps with `ui/library.js`. What this file
// owns is the *gesture*: what a click on a cell does, what a drag on a block
// does, and what is heard while a hand is doing either.
//
// ── A step sequencer, because that is what a rhythm is typed on ───────────
//
// One row a bar, one cell a step, the beats marked. A word is a block over the
// cells it holds; an empty cell is a rest. There are four gestures and none of
// them is a mode:
//
//   - **click an empty cell** and type — the word lands on that step, and
//     *space* lands it and moves the caret to the next cell, so a line of words
//     is typed the way it is said. A phrase with a space in it goes in quotes.
//   - **click a word** to hear it and to select it; the panel under the grid is
//     about the selected word.
//   - **drag a word's right edge** to hold it for more steps, or fewer.
//   - **drag a word** to another step, on any bar. A step something else is on
//     refuses the drop and the word stays where it was.
//
// The previous version of this tab was a notation typed into a box, and it was
// replaced for the reason in `rhythm.js`'s header: a rhythm is a thing somebody
// taps, and dots are arithmetic.
//
// ── What a word's panel holds, and what it does not ───────────────────────
//
// The take, the fit, the slip and whether it is stretched — the four things a
// word has that the grid cannot show at thirty pixels a step. Everything in it
// is *heard* on change: the next take plays, releasing the slip plays, which is
// what makes dialling in a piece a loop rather than a form. There is no
// audition length in it: what plays is exactly what the mix would hold, and a
// control to play something else would be a control to preview a different mix.
//
// ── Listen is the pattern, in tempo, out of the finder's one element ──────
//
// A press on Listen plays the pattern step by step with `screen.audition`,
// which is the same one element every row shares (`screen.js`'s rule). It is
// not the render: nothing has been built, and building it is what Build is
// for. The cost of that honesty is a seam at every step — the element seeks —
// which is audible and is also the truth about what the words are.

import { el, div, put, setText, add } from '../ui/dom.js';
import { bare } from '../ui/phrase.js';
import * as library from '../ui/library.js';
import * as rhythm from './rhythm.js';

let hooks = {};
let nodes = {};

/// The word the panel is about, by index into the pattern. -1 for none.
let selected = -1;
/// The word being heard, for the block that lights up. -1 for none.
let playingWord = -1;
/// An open cell editor: `{ at, word, value, done }`. `word` is the index being
/// renamed, or -1 for a word being put on an empty cell.
let editing = null;
/// A drag on a block: `{ kind, i, x0, y0, at0, steps0, cellW, rowH, moved }`.
let gesture = null;
/// Recent presses of Tap, as timestamps.
let taps = [];

let listening = false;
let looping = false;
let listenTimer = null;
let stepLooping = false;
let stepTimer = null;

/// The grid and the panel, held so a keystroke into the panel can redraw the
/// one without rebuilding the other under the caret.
let gridNode = null;
let panelNode = null;

export function initPattern(refs, h) {
    nodes = refs;
    hooks = h || {};
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ── what the tab says ──────────────────────────────────────────────────────

/// A statement about the pattern, and every number in it changes as it is laid
/// out: how long it is, how many words nothing said, and what a build is still
/// doing. The one thing it must always carry is the length, because that is the
/// number nobody can work out by eye and is the whole reason for a grid.
export function drawNote() {
    const node = nodes.note;
    if (!node) return;
    node.classList.remove('bad');
    const plan = rhythm.plan();
    const bits = [];
    if (!library.available()) bits.push('no corpus');
    if (plan.steps) {
        const bars = Math.ceil(plan.steps / rhythm.stepsPerBar());
        bits.push(`${bars} bar${bars === 1 ? '' : 's'} · ${plan.seconds.toFixed(2)} s`);
    }
    bits.push(`${(rhythm.stepSeconds() * 1000).toFixed(0)} ms a step`);
    if (plan.missing.length)
        bits.push(`nothing says ${plan.missing.map((w) => `"${w}"`).join(', ')}`);
    const snapping = rhythm.snapping();
    if (snapping) bits.push(`finding the beat in ${snapping}`);
    const said = rhythm.note();
    if (said) bits.push(said);
    setText(node, bits.join(' · '));
}

/// The one line a refusal is said on.
function refuse(why) {
    setText(nodes.note, why);
    nodes.note.classList.add('bad');
}

// ── the controls ───────────────────────────────────────────────────────────

/// Tempo, the grid, and the two presses. **Build comes last**, because the
/// order on the screen is the order of the work: set the grid, lay the words,
/// press it.
export function drawControls() {
    put(nodes.controls, () => {
        const bpm = el('input', {
            type: 'number', id: 'r-tempo', step: '1', min: '20', max: '600',
            value: String(rhythm.tempoOf()),
            on: { change: () => {
                rhythm.setTempo(bpm.value);
                bpm.value = String(rhythm.tempoOf());
                changedGrid();
            } },
        });
        // Tapped rather than typed, because a tempo is a thing somebody has in
        // their hand before they have it as a number.
        const tap = el('button', {
            cls: 'text', id: 'r-tap', text: 'Tap',
            on: { click: () => {
                if (tapTempo()) { bpm.value = String(rhythm.tempoOf()); changedGrid(); }
            } },
        });
        const steps = el('select', {
            id: 'r-steps',
            on: { change: () => { rhythm.setStepsPerBeat(steps.value); changedGrid(); } },
        }, rhythm.GRIDS.map((n) => el('option', {
            value: String(n), text: `${n} a beat`, selected: n === rhythm.stepsPerBeat(),
        })));
        const bars = el('select', {
            id: 'r-bar',
            on: { change: () => { rhythm.setBeatsPerBar(bars.value); changedGrid(); } },
        }, [2, 3, 4, 5, 6, 7, 8].map((n) => el('option', {
            value: String(n), text: `${n} a bar`, selected: n === rhythm.beatsPerBar(),
        })));
        const loose = el('label', { cls: 'check' }, [
            el('input', {
                type: 'checkbox', id: 'r-loose', checked: rhythm.looseOf(),
                on: { change: (e) => { rhythm.setLoose(e.target.checked); changedGrid(); } },
            }),
            'inside longer words',
        ]);
        const listen = el('button', {
            cls: 'tiny' + (listening ? ' on' : ''), id: 'r-listen-all',
            text: listening ? '■ Stop' : '▶ Listen',
            title: listening ? 'Stop (Space)' : 'Listen (Space)',
            on: { click: () => toggleListen() },
        });
        const loop = el('label', { cls: 'check' }, [
            el('input', {
                type: 'checkbox', id: 'r-loop', checked: looping,
                on: { change: (e) => { setLooping(e.target.checked); } },
            }),
            'loop',
        ]);
        const clear = el('button', {
            cls: 'text', id: 'r-clear', text: 'Clear',
            disabled: !rhythm.words().length,
            on: { click: () => {
                stopAll();
                rhythm.clearWords();
                selected = -1;
                editing = null;
                drawControls();
                invite();
                drawNote();
            } },
        });
        const go = el('button', {
            cls: 'go', id: 'r-build', text: 'Build',
            disabled: rhythm.busy(),
            on: { click: () => {
                const why = rhythm.build();
                if (why) refuse(why); else drawNote();
                go.disabled = rhythm.busy();
            } },
        });
        return [
            el('span', { cls: 'dim', text: 'tempo' }), bpm, tap,
            el('span', { cls: 'dim', text: '· grid' }), steps, bars,
            loose,
            div('r-actions', [listen, loop, el('span', { cls: 'spacer' }), clear, go]),
        ];
    });
}

/// Average the last few presses. Answers whether there were enough to say.
///
/// A gap of two seconds starts again, because a pause that long is somebody
/// thinking rather than counting.
function tapTempo() {
    const now = Date.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 8) taps = taps.slice(-8);
    if (taps.length < 2) return false;
    const mean = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    rhythm.setTempo(Math.round(60000 / mean));
    return true;
}

/// The grid changed shape — a tempo, a division, a bar — so everything drawn
/// from it is drawn again. Not the controls, which are what changed it.
function changedGrid() {
    draw();
    drawNote();
}

// ── the grid ───────────────────────────────────────────────────────────────

/// Draw the tab: the grid, and the panel for the selected word under it.
export function draw() {
    if (!nodes.list) return;
    put(nodes.list, () => {
        gridNode = el('div', { id: 'r-grid' }, grid());
        panelNode = el('div', { id: 'r-panel' }, panel());
        return [gridNode, panelNode];
    });
    focusEditor();
}

function redrawGrid() {
    if (!gridNode) return draw();
    put(gridNode, grid);
    focusEditor();
}

function redrawPanel() {
    if (!panelNode) return draw();
    put(panelNode, panel);
}

function focusEditor() {
    if (!editing || !gridNode) return;
    const input = gridNode.querySelector('.r-edit');
    if (input) { input.focus(); try { input.select(); } catch (e) { /* fine */ } }
}

/// One row a bar, always one more than the pattern needs, so there is an empty
/// cell after the last word to put the next on.
function grid() {
    const words = rhythm.words();
    const plan = rhythm.plan();
    const pieces = new Map();
    for (const p of plan.pieces) if (p.kind === 'word') pieces.set(p.word, p);
    const S = rhythm.stepsPerBar();
    const per = rhythm.stepsPerBeat();
    let end = rhythm.lastStep();
    if (editing && editing.word < 0) end = Math.max(end, editing.at + 1);
    const bars = Math.floor(end / S) + 1;

    const rows = [];
    for (let b = 0; b < bars; b++) {
        const cells = [];
        const stop = (b + 1) * S;
        let s = b * S;
        while (s < stop) {
            const i = rhythm.wordAt(s);
            if (i >= 0) {
                const w = words[i];
                const to = Math.min(w.at + w.steps, stop);
                // The rests after it in this bar, which its label may run over.
                let free = 0;
                while (to + free < stop && rhythm.wordAt(to + free) < 0) free++;
                cells.push(block(i, w, pieces.get(i), s, to - s, w.at < s, w.at + w.steps > stop, per, free));
                s = to;
            } else {
                cells.push(cell(s, per));
                s++;
            }
        }
        rows.push(div('r-bar', [
            el('span', { cls: 'r-barno mono', text: String(b + 1) }),
            div('r-cells', cells),
        ]));
    }
    return rows;
}

/// An empty step. Click it and type.
function cell(s, per) {
    const c = div('r-cell' + (s % per === 0 ? ' beat' : ''));
    if (editing && editing.word < 0 && editing.at === s) add(c, editor(s));
    else c.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        openEditor(s, -1);
    });
    return c;
}

/// A word, over the steps it holds in this bar. `cont` is a word that began in
/// the bar above; `more` is one that goes on into the bar below. The handle is
/// on the last segment only, because that is the edge a length lives on.
///
/// **The label runs over the rests that follow**, `free` of them, because a
/// step is thirty pixels and a word is longer than that: a block exactly its
/// steps wide showed `hel` for `hello`, and a grid whose words cannot be read is
/// a grid nobody can check. The block stays its steps wide — the beats line up
/// — and only the text spills, to where the next word begins.
function block(i, w, p, s, span, cont, more, per, free = 0) {
    const cls = ['r-word'];
    if (s % per === 0) cls.push('beat');
    if (cont) cls.push('cont');
    if (more) cls.push('more');
    if (i === selected) cls.push('sel');
    if (i === playingWord) cls.push('playing');
    if (p && !p.hit) cls.push('bad');
    if (w.offset) cls.push('slipped');
    if (w.stretch && p && p.canStretch) cls.push('stretched');
    const kids = [];
    if (editing && editing.word === i && !cont) kids.push(editor(w.at));
    else {
        const txt = el('span', { cls: 'txt', text: cont ? '' : w.phrase });
        // As a share of the block, so it needs no measurement: its own steps
        // and the free ones after, less a margin before the next word.
        txt.style.width = `${(((span + free) / span) * 100 - 8).toFixed(1)}%`;
        kids.push(txt);
    }
    if (!more) {
        const grab = div('grab');
        grab.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            begin('size', i, e, b);
        });
        kids.push(grab);
    }
    const b = div(cls.join(' '), kids);
    b.style.flexGrow = String(span);
    b.dataset.word = String(i);
    b.dataset.span = String(span);
    b.title = w.phrase;
    b.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (editing && editing.word === i) return;
        e.preventDefault();
        begin('move', i, e, b);
    });
    b.addEventListener('dblclick', (e) => {
        e.preventDefault();
        openEditor(w.at, i);
    });
    return b;
}

// ── the editor ─────────────────────────────────────────────────────────────

/// Open the field on a cell, or over a word.
function openEditor(at, word) {
    if (editing) commit(false);
    const value = word >= 0 ? (rhythm.words()[word] || {}).phrase || '' : '';
    editing = { at, word, value, done: false };
    redrawGrid();
}

/// The field itself. **Space lands the word and moves on**, which is what makes
/// the grid typeable: `no no no no` is four presses of space. Inside an open
/// quote it is a space, so `"you cross"` is one phrase.
///
/// **Under it, what the corpus says about what is being typed**: the word so
/// far with how often it is said, then the words that begin with it. `hello ·
/// 0` while it is being typed is what stops a pattern being built out of words
/// nothing says and refused afterwards. The arrows pick one and Enter, Tab or
/// space land it; with nothing picked, what was typed lands as typed, so a
/// list can never put a word in that nobody wrote.
function editor(at) {
    const ed = editing;
    const S = rhythm.stepsPerBar();
    const right = (at % S) >= (S * 2) / 3;
    ed.hint = -1;
    ed.hints = hintsFor(ed.value);
    const hints = div('r-hints' + (right ? ' right' : ''));
    const showHints = () => put(hints, () => ed.hints.map((h, n) => {
        const row = div('r-hint' + (n === ed.hint ? ' on' : '') + (h.n ? '' : ' none'), [
            el('span', { cls: 'w', text: h.word }),
            el('span', { cls: 'n mono', text: `×${h.n}` }),
        ]);
        // On the press rather than the click: the press takes the caret off
        // the field, and the field's own answer to that is deferred below so
        // that this one lands first.
        row.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            ed.value = h.word;
            commit(true);
        });
        return row;
    }));
    showHints();
    const input = el('input', {
        type: 'text', cls: 'r-edit' + (right ? ' right' : ''), value: ed.value,
        placeholder: 'word',
        on: {
            input: () => {
                ed.value = input.value;
                ed.hint = -1;
                ed.hints = hintsFor(ed.value);
                showHints();
            },
            keydown: (e) => {
                e.stopPropagation();
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const n = ed.hints.length;
                    if (!n) return;
                    ed.hint = e.key === 'ArrowDown' ? (ed.hint + 1) % n : (ed.hint - 1 + n) % n;
                    showHints();
                    return;
                }
                const lands = e.key === 'Enter' || e.key === 'Tab' ||
                              (e.key === ' ' && !openQuote(input.value));
                if (lands && ed.hint >= 0) ed.value = ed.hints[ed.hint].word;
                if (e.key === 'Enter') { e.preventDefault(); commit(false); }
                else if (e.key === 'Tab') { e.preventDefault(); commit(true); }
                else if (e.key === ' ' && !openQuote(input.value)) { e.preventDefault(); commit(true); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
            },
            // Deferred by a turn, because the engine moves the caret *before* it
            // delivers the press that moved it: a press on a suggestion blurs
            // this field first, and committing here would land what was typed
            // over what was pressed. A turn later the press has had its say.
            blur: () => { setTimeout(() => { if (editing === ed && !ed.done) commit(false); }, 0); },
        },
    });
    return [input, hints];
}

/// What the field could mean, with how often each is said. Nothing for a
/// quoted phrase or one with `|` in it, whose count is a search's question.
function hintsFor(value) {
    const typed = String(value || '').trim();
    if (!typed || typed.includes('"') || typed.includes('|')) return [];
    if (!library.available() || !library.current()) return [];
    const key = bare(typed);
    if (key.length < 2) return [];
    const out = [{ word: key, n: library.saidCount(typed) }];
    for (const s of library.suggest(typed, 6)) if (s.word !== key) out.push(s);
    return out.slice(0, 6);
}

/// The words the corpus does have that come nearest to one it does not: the
/// longest beginning of it that begins anything.
function nearest(phrase) {
    const key = bare(phrase);
    if (!library.available() || !library.current()) return [];
    for (let n = key.length; n >= 2; n--) {
        const got = library.suggest(key.slice(0, n), 5).filter((s) => s.word !== key);
        if (got.length) return got;
    }
    return [];
}

const openQuote = (v) => (String(v).split('"').length - 1) % 2 === 1;

/// Put what was typed on the grid. `advance` opens the next cell if it is free.
function commit(advance) {
    const ed = editing;
    if (!ed || ed.done) return;
    ed.done = true;
    let phrase = String(ed.value || '').trim();
    const quoted = /^"(.*)"$/.exec(phrase);
    if (quoted) phrase = quoted[1].trim();

    let idx = -1;
    if (ed.word >= 0) {
        if (phrase) { rhythm.setPhrase(ed.word, phrase); idx = ed.word; }
        else { rhythm.removeWord(ed.word); if (selected === ed.word) selected = -1; }
    } else if (phrase) {
        idx = rhythm.putWord(ed.at, phrase);
    }
    editing = null;
    if (idx >= 0) selected = idx;

    if (advance && phrase && idx >= 0) {
        const w = rhythm.words()[idx];
        const next = w.at + w.steps;
        if (rhythm.wordAt(next) < 0) editing = { at: next, word: -1, value: '', done: false };
    }
    draw();
    drawNote();
    drawControls();
}

function close() {
    if (!editing) return;
    editing.done = true;
    editing = null;
    draw();
}

// ── the gestures ───────────────────────────────────────────────────────────

/// A press on a block: a move, or a size from its edge. What it is depends on
/// what happens next — a press that does not move is a click.
function begin(kind, i, e, node) {
    const w = rhythm.words()[i];
    if (!w) return;
    // A step is the row's width over the steps in a bar — measured off the row
    // and not off the block, because a block is as wide as its steps only when
    // the layout agrees, and a drag measured against a block that came out a
    // little wide would land a step short.
    const cells = node.parentNode;
    const row = cells && cells.parentNode;
    const next = row && row.nextSibling;
    const rect = (cells || node).getBoundingClientRect();
    const rowRect = row ? row.getBoundingClientRect() : rect;
    const rowH = next ? next.getBoundingClientRect().top - rowRect.top : rowRect.height + 5;
    gesture = {
        kind, i, x0: e.clientX, y0: e.clientY, at0: w.at, steps0: w.steps,
        cellW: Math.max(4, rect.width / rhythm.stepsPerBar()), rowH: Math.max(8, rowH),
        moved: false,
    };
}

function onMove(e) {
    if (!gesture) return;
    const dx = e.clientX - gesture.x0;
    const dy = e.clientY - gesture.y0;
    if (!gesture.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    gesture.moved = true;
    const dcol = Math.round(dx / gesture.cellW);
    if (gesture.kind === 'size') {
        const was = (rhythm.words()[gesture.i] || {}).steps;
        const now = rhythm.setSteps(gesture.i, gesture.steps0 + dcol);
        if (now !== was) { redrawGrid(); redrawPanel(); drawNote(); }
        return;
    }
    const drow = Math.round(dy / gesture.rowH);
    const at = gesture.at0 + dcol + drow * rhythm.stepsPerBar();
    const cur = rhythm.words()[gesture.i];
    if (!cur || cur.at === at) return;
    const j = rhythm.moveWord(gesture.i, at);
    if (j < 0) return;
    if (selected === gesture.i) selected = j;
    gesture.i = j;
    redrawGrid();
    redrawPanel();
    drawNote();
}

function onUp() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (!g.moved) click(g.i);
    else drawControls();
}

/// A word pressed and released: it is the one the panel is about, and it plays.
/// Pressed again while playing, it stops.
function click(i) {
    if (editing) commit(false);
    selected = i;
    if (playingWord === i && !listening && !stepLooping) hush();
    else hear(i);
    draw();
}

// ── hearing ────────────────────────────────────────────────────────────────

/// Play one word as the mix would hold it. Answers whether it could.
function hear(i) {
    const p = rhythm.pieceOf(i);
    if (!p || !p.hit || !p.hit.vod.media) return false;
    playingWord = i;
    hooks.audition(p.hit.vod.media, p.at, p.at + p.span, p.rate);
    markPlaying();
    return true;
}

/// Light the block being heard, and no other — a class toggled on what is
/// already there, because this happens on every step of a listen.
function markPlaying() {
    if (!gridNode) return;
    for (const b of gridNode.querySelectorAll('.r-word'))
        b.classList.toggle('playing', Number(b.dataset.word) === playingWord);
}

/// Stop whatever one word is doing. Answers whether anything was.
export function hush() {
    if (playingWord < 0 && !stepLooping) return false;
    stopStepLoop();
    if (hooks.hush) hooks.hush();
    playingWord = -1;
    markPlaying();
    return true;
}

export function auditioning() { return playingWord >= 0; }

/// The audition ended by itself, wherever it ended. Called by the app.
export function stopped() {
    if (listening || stepLooping) return;
    if (playingWord < 0) return;
    playingWord = -1;
    markPlaying();
}

/// The whole pattern, step by step, in tempo. Answers whether it started.
export function listen() {
    stopStepLoop();
    stopListen();
    const plan = rhythm.plan();
    if (!plan.pieces.length) return false;
    for (const p of plan.pieces)
        if (p.hit && p.hit.vod.media && hooks.warmPath) hooks.warmPath(p.hit.vod.media);
    listening = true;
    listenButton();
    const go = (idx) => {
        if (!listening) return;
        if (idx >= plan.pieces.length) {
            if (looping) { go(0); return; }
            stopListen();
            return;
        }
        const p = plan.pieces[idx];
        if (p.kind === 'word' && p.hit && p.hit.vod.media) {
            playingWord = p.word;
            hooks.audition(p.hit.vod.media, p.at, p.at + p.span, p.rate);
        } else {
            playingWord = -1;
            if (hooks.hush) hooks.hush();
        }
        markPlaying();
        listenTimer = setTimeout(() => go(idx + 1), Math.max(20, p.seconds * 1000));
    };
    go(0);
    return true;
}

export function isListening() { return listening; }

export function stopListen() {
    if (!listening && !listenTimer) return false;
    listening = false;
    if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
    if (hooks.hush) hooks.hush();
    playingWord = -1;
    markPlaying();
    listenButton();
    return true;
}

export function toggleListen() {
    if (listening) { stopListen(); return false; }
    return listen();
}

function listenButton() {
    const btn = document.getElementById('r-listen-all');
    if (!btn) return;
    setText(btn, listening ? '■ Stop' : '▶ Listen');
    btn.classList.toggle('on', listening);
    btn.title = listening ? 'Stop (Space)' : 'Listen (Space)';
}

export function isLooping() { return looping; }
export function setLooping(on) {
    looping = !!on;
    const box = document.getElementById('r-loop');
    if (box && box.checked !== looping) box.checked = looping;
}
export function toggleLooping() { setLooping(!looping); return looping; }

/// One word over and over, for dialling in its slip. Pressed on the word that
/// is looping, it stops.
export function loopWord(i) {
    if (stepLooping && selected === i) { stopStepLoop(); redrawPanel(); return false; }
    stopListen();
    stopStepLoop();
    selected = i;
    stepLooping = true;
    const again = () => {
        if (!stepLooping) return;
        const p = rhythm.pieceOf(selected);
        if (!p || !p.hit || !p.hit.vod.media) { stopStepLoop(); redrawPanel(); return; }
        hear(selected);
        stepTimer = setTimeout(again, p.seconds * 1000 + 150);
    };
    again();
    redrawPanel();
    return true;
}

export function isStepLooping() { return stepLooping; }

export function stopStepLoop() {
    if (!stepLooping && !stepTimer) return false;
    stepLooping = false;
    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    if (hooks.hush) hooks.hush();
    playingWord = -1;
    markPlaying();
    return true;
}

/// Stop everything this tab is making a noise with. Answers whether it was.
export function stopAll() {
    const a = stopListen();
    const b = stopStepLoop();
    const c = hush();
    return a || b || c;
}

// ── the panel ──────────────────────────────────────────────────────────────

export function selectedWord() { return selected; }

/// Select a word by index and hear it. -1 selects nothing.
export function select(i) {
    const words = rhythm.words();
    if (i < 0) { selected = -1; draw(); return true; }
    if (i >= words.length) return false;
    selected = i;
    hear(i);
    draw();
    return true;
}

/// The next word, or the one before. Selects and hears it.
export function selectRelative(delta) {
    const n = rhythm.words().length;
    if (!n) return false;
    const cur = selected >= 0 ? selected : (delta > 0 ? -1 : n);
    return select(Math.max(0, Math.min(n - 1, cur + delta)));
}

/// The panel: what the selected word is, and the four things about it.
function panel() {
    const words = rhythm.words();
    if (selected < 0 || selected >= words.length) return [];
    const w = words[selected];
    const p = rhythm.pieceOf(selected);
    const where = rhythm.whereIs(w.at);
    const ms = Math.round(w.steps * rhythm.stepSeconds() * 1000);

    const phrase = el('input', {
        type: 'text', id: 'r-phrase', value: w.phrase,
        // Per keystroke, for CLAUDE.md's reason: the panel is the answer to
        // what has been typed so far. The grid is redrawn and this field is not.
        on: { input: () => {
            if (!phrase.value.trim()) return;
            rhythm.setPhrase(selected, phrase.value);
            redrawGrid();
            put(body, () => bodyOf(w, rhythm.pieceOf(selected)));
            drawNote();
        } },
    });
    const head = div('r-line', [
        phrase,
        el('span', { cls: 'dim', text:
            `bar ${where.bar} · beat ${where.beat}${where.step > 1 ? `.${where.step}` : ''}` +
            ` · ${w.steps} step${w.steps === 1 ? '' : 's'} · ${ms} ms` }),
    ]);
    const body = div('r-body', bodyOf(w, p));
    return [div('r-piece', [head, body])];
}

function bodyOf(w, p) {
    const i = selected;
    const rows = [];
    if (!p || !p.hit) {
        const why = p && p.why ? `"${w.phrase}" — ${p.why}`
                  : library.available() ? `nothing says "${w.phrase}"` : 'no corpus';
        rows.push(div('r-line bad', [el('span', { text: why })]));
        // The nearest words it does have, as things to press: a refusal with
        // nothing beside it is a dead end, and the corpus knows the way out.
        const near = p && !p.why ? nearest(w.phrase) : [];
        if (near.length) rows.push(div('r-line r-near', near.map((s) => el('button', {
            cls: 'tiny', text: `${s.word} ×${s.n}`,
            on: { click: () => { rhythm.setPhrase(i, s.word); draw(); drawNote(); } },
        }))));
        rows.push(div('r-line', [
            el('span', { cls: 'spacer' }),
            el('button', { cls: 'tiny', text: 'Remove', on: { click: () => remove(i) } }),
        ]));
        return rows;
    }

    // Which take. Stepped, and heard on every step.
    const fitCls = p.fitScore >= 85 ? 'fit-good' : p.fitScore >= 65 ? 'fit-med' : 'fit-poor';
    rows.push(div('r-line', [
        el('span', { cls: 'dim', text: 'take' }),
        el('button', {
            cls: 'tiny', text: '◀', title: 'Previous take ([)', disabled: p.takes <= 1,
            on: { click: () => cycleTake(-1) },
        }),
        el('span', { cls: 'r-take mono', text: `${p.take} of ${p.takes}` }),
        el('button', {
            cls: 'tiny', text: '▶', title: 'Next take (])', disabled: p.takes <= 1,
            on: { click: () => cycleTake(1) },
        }),
        el('span', { cls: `badge ${fitCls} mono`, text: `${p.fitScore}%` }),
        el('span', { cls: 'dim', text: `said in ${Math.round(p.naturalDur * 1000)} ms` }),
        el('span', { cls: 'spacer' }),
        el('label', { cls: 'check' }, [
            el('input', {
                type: 'checkbox', id: 'r-byfit', checked: rhythm.sortByFitOf(),
                on: { change: (e) => { rhythm.setSortByFit(e.target.checked); redrawGrid(); redrawPanel(); drawNote(); } },
            }),
            'best fit first',
        ]),
    ]));

    // The slip. Dragged, and heard on release.
    const offMs = Math.round((w.offset || 0) * 1000);
    const val = el('span', { cls: 'r-val mono', text: `${offMs > 0 ? '+' : ''}${offMs} ms` });
    const slip = el('input', {
        type: 'range', id: 'r-slip', min: '-200', max: '200', step: '5', value: String(offMs),
        on: {
            input: () => {
                const v = rhythm.setOffset(i, Number(slip.value) / 1000);
                const m = Math.round(v * 1000);
                setText(val, `${m > 0 ? '+' : ''}${m} ms`);
                reset.disabled = !v;
                redrawGrid();
                drawNote();
            },
            change: () => hear(i),
        },
    });
    const reset = el('button', {
        cls: 'tiny text', text: '↺', title: 'No slip', disabled: !w.offset,
        on: { click: () => { rhythm.setOffset(i, 0); redrawGrid(); redrawPanel(); drawNote(); hear(i); } },
    });
    rows.push(div('r-line', [el('span', { cls: 'dim', text: 'slip' }), slip, val, reset]));

    // Cut, or stretched to the step.
    const on = w.stretch && p.canStretch;
    rows.push(div('r-line', [
        el('span', { cls: 'dim', text: 'fit' }),
        el('button', {
            cls: 'tiny' + (!on ? ' on' : ''), text: 'cut',
            on: { click: () => setStretch(false) },
        }),
        el('button', {
            cls: 'tiny' + (on ? ' on' : ''),
            text: `stretch ${p.fitRatio.toFixed(2)}×`,
            disabled: !p.canStretch,
            on: { click: () => setStretch(true) },
        }),
    ]));

    // What to do with it.
    const heard = playingWord === i && !listening && !stepLooping;
    rows.push(div('r-line', [
        el('button', {
            cls: 'tiny' + (heard ? ' on' : ''), id: 'r-hear', text: heard ? '■' : '▶',
            title: heard ? 'Stop' : 'Listen',
            on: { click: () => { if (heard) hush(); else { stopStepLoop(); hear(i); } redrawPanel(); } },
        }),
        el('button', {
            cls: 'tiny' + (stepLooping ? ' on' : ''), id: 'r-loop-word',
            text: stepLooping ? '■ loop' : '⟳ loop',
            title: stepLooping ? 'Stop looping' : 'Loop this word',
            on: { click: () => loopWord(i) },
        }),
        el('button', {
            cls: 'tiny', id: 'r-add', text: '+', title: 'Add this word to the mix',
            disabled: !p.hit.vod.media || rhythm.busy(),
            on: { click: () => { const why = rhythm.build(i); if (why) refuse(why); else drawNote(); } },
        }),
        el('span', { cls: 'spacer' }),
        el('button', { cls: 'tiny', text: 'Remove', on: { click: () => remove(i) } }),
    ]));
    return rows;
}

function remove(i) {
    stopStepLoop();
    if (playingWord === i) hush();
    rhythm.removeWord(i);
    selected = -1;
    draw();
    drawNote();
    drawControls();
}

function setStretch(on) {
    if (selected < 0) return;
    rhythm.setStretch(selected, on);
    redrawGrid();
    redrawPanel();
    hear(selected);
}

/// The next take of the selected word, heard. For the panel and for `]`.
export function cycleTake(delta = 1) {
    if (selected < 0) {
        if (!rhythm.words().length) return false;
        selected = 0;
    }
    rhythm.cycleTake(selected, delta);
    redrawGrid();
    redrawPanel();
    drawNote();
    stopStepLoop();
    hear(selected);
    return true;
}

/// Slip the selected word by a little, heard. For `,` and `.`.
export function nudgeOffset(deltaSec) {
    if (selected < 0) return 0;
    const v = rhythm.nudgeOffset(selected, deltaSec);
    redrawGrid();
    redrawPanel();
    drawNote();
    hear(selected);
    return v;
}

// ── the frame loop and the keys ────────────────────────────────────────────

/// Called every frame the tab is showing: the build's button and its line.
export function repaint() {
    const go = document.getElementById('r-build');
    if (go && go.disabled !== rhythm.busy()) go.disabled = rhythm.busy();
    drawNote();
}

/// The corpus changed under the pattern — a transcription landed — so what the
/// words resolve to is asked again.
export function reload() {
    rhythm.replan();
    draw();
    drawNote();
}

/// Arriving on the tab: an empty grid opens with the caret in its first cell.
export function arrive() {
    invite();
}

/// Leaving the tab: nothing it was doing goes on making a noise.
export function leave() {
    stopAll();
    if (editing) close();
}

/// An empty grid opens with the caret in its first cell, because a grid with
/// nothing on it and nothing pressed on it is a grid nobody can tell is typed
/// on. Only on arrival and after Clear, never on a redraw: a draw that opened
/// it would take the caret back from whatever had just been pressed.
function invite() {
    if (!editing && !gesture && !rhythm.words().length)
        editing = { at: 0, word: -1, value: '', done: false };
    draw();
}

/// A key while the tab is showing and nothing is being typed into. Answers
/// whether it was this tab's.
export function key(e) {
    if (e.key === ' ') {
        if (listening) stopListen();
        else if (stepLooping) stopStepLoop();
        else if (playingWord >= 0) hush();
        else listen();
        redrawPanel();
        return true;
    }
    if (e.key === 'l' || e.key === 'L') { toggleLooping(); return true; }
    if (e.key === 'ArrowLeft') { selectRelative(-1); return true; }
    if (e.key === 'ArrowRight') { selectRelative(1); return true; }
    if (e.key === '[') { cycleTake(-1); return true; }
    if (e.key === ']') { cycleTake(1); return true; }
    if (e.key === ',' || e.key === '<') { nudgeOffset(e.shiftKey ? -0.025 : -0.005); return true; }
    if (e.key === '.' || e.key === '>') { nudgeOffset(e.shiftKey ? 0.025 : 0.005); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) { remove(selected); return true; }
    if (e.key === 'Enter' && selected >= 0) {
        const w = rhythm.words()[selected];
        if (w) openEditor(w.at, selected);
        return true;
    }
    if (e.key === 'Escape' && editing) { close(); return true; }
    return false;
}
