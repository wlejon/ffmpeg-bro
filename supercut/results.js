// The finder, which in this application is half the window rather than a panel
// over something else.
//
// Six hours of somebody talking is not a thing anybody scrubs through, so the
// words are the index and the list is where every edit starts. Two questions,
// because there are two and they are not the same shape:
//
//   - **Words** — you know what was said and want every time it was said.
//   - **Talking** — you do not know what is in there, and want the stretches
//     worth listening to. A stretch is defined by its *gaps* and by nothing
//     else; see `monologues` in `ui/phrase.js` for why it is named after the
//     measurement and claims nothing about what is in it.
//
// **What the answer is belongs to `ui/library.js`.** This file draws it and
// nothing more, which is what stops this list and the one the workbench's panel
// draws — and the files `tools/clips.js` cuts — from describing three different
// sets of moments.

import { el, div, put } from '../ui/dom.js';
import { clock } from '../ui/format.js';
import * as library from '../ui/library.js';

/// A found list is long and the interesting part is the top of it. The cap is on
/// what is *drawn* rather than on what is found, so the count stays honest.
const SHOWN = 300;

let nodes = null;
let hooks = {};
let tab = 'words';
let results = [];
let playing = null;      // the item being auditioned, for the row to show it

let phrase = '';
let loose = false;
let gap = 2;
let least = 30;

export function initResults(refs, h) {
    nodes = refs;
    hooks = h || {};
    for (const b of nodes.tabs.querySelectorAll('[data-tab]'))
        b.addEventListener('click', () => setTab(b.dataset.tab));
}

/// Open the corpus and draw. Answers false when there is none, which is the
/// ordinary case on a machine that has never run `tools/supercut.js`.
export function start() {
    if (!library.available()) { drawEmpty(); return false; }
    library.pick();
    draw();
    return true;
}

export function available() { return library.available(); }

/// Read a corpus from somewhere other than the well-known path — a suite, or a
/// store kept somewhere else. See `library.useCorpus`.
export function useCorpus(path) {
    library.useCorpus(path);
    results = [];
}

export function currentTab() { return tab; }

export function setTab(next) {
    if (tab === next) return;
    tab = next;
    results = [];
    draw();
}

/// What the list is showing, for a caller that has to check it rather than read
/// it — a suite, which cannot see the rows.
export function found() { return results.slice(); }

/// Ask the talking question without the pane having to be showing an answer.
export function runsFor(opts) { return library.searchTalking(opts); }

function search() {
    results = tab === 'words' ? library.searchWords(phrase, { loose })
                              : library.searchTalking({ gap, min: least });
    drawNote();
    drawRows();
}

// ── the two things a row does ──────────────────────────────────────────────

/// Hear it. One element, shared with everything else on the screen — see
/// `screen.js`, where the rule about a decoder being a property of a *file* is.
export function play(n) {
    const item = results[n];
    if (!item || !item.vod.media) return false;
    const lead = item.kind === 'word' ? library.WORD_PAD : 0;
    playing = item;
    hooks.audition(item.vod.media, Math.max(0, item.at - lead), item.to + lead);
    drawRows();
    return true;
}

/// Put it at the end of the mix.
export function add(n) {
    const item = results[n];
    if (!item || !item.vod.media) return false;
    hooks.add(library.asClip(item));
    return true;
}

/// The audition ended, wherever it ended. Called by the app.
export function stopped() {
    if (!playing) return;
    playing = null;
    drawRows();
}

// ── drawing ────────────────────────────────────────────────────────────────

function draw() {
    for (const b of nodes.tabs.querySelectorAll('[data-tab]'))
        b.classList.toggle('on', b.dataset.tab === tab);
    drawControls();
    drawNote();
    drawRows();
    drawChannel();
}

/// The channel picker, which is not drawn at all for a corpus of one channel —
/// the ordinary case, and a menu with one item in it is a menu that asks a
/// question with one answer.
function drawChannel() {
    if (!nodes.channel) return;
    const chans = library.channels();
    const here = library.current();
    put(nodes.channel, () => {
        if (chans.length < 2) return [];
        const sel = el('select', {
            on: { change: () => { library.pick(sel.value); search(); drawNote(); } },
        }, chans.map((c) => el('option', {
            value: c.channel, text: c.channel,
            selected: here && c.channel === here.channel,
        })));
        return [sel];
    });
}

function drawControls() {
    put(nodes.controls, () => {
        if (tab === 'words') {
            const box = el('input', {
                type: 'text', id: 'f-phrase', value: phrase,
                placeholder: 'a word, or "one|the other"',
                on: { input: () => { phrase = box.value; search(); } },
            });
            const check = el('label', { cls: 'check' }, [
                el('input', {
                    type: 'checkbox', checked: loose,
                    on: { change: (e) => { loose = !!e.target.checked; search(); } },
                }),
                'inside longer words',
            ]);
            return [box, check];
        }
        const g = el('input', {
            type: 'number', id: 'f-gap', step: '0.5', min: '0.5', value: String(gap),
            on: { change: () => { gap = Number(g.value) || 2; search(); } },
        });
        const m = el('input', {
            type: 'number', id: 'f-least', step: '10', min: '5', value: String(least),
            on: { change: () => { least = Number(m.value) || 30; search(); } },
        });
        return [
            el('span', { cls: 'dim', text: 'pause under' }), g,
            el('span', { cls: 'dim', text: 's · at least' }), m,
            el('span', { cls: 'dim', text: 's' }),
            el('button', { cls: 'text', text: 'Find', on: { click: search } }),
        ];
    });
}

/// What the list is, and what it is not. A statement rather than an explanation:
/// the numbers change with every search.
function drawNote() {
    const base = library.about();
    if (!base) { nodes.note.textContent = ''; return; }
    if (nodes.about) nodes.about.textContent = base;
    if (!results.length) {
        nodes.note.textContent = tab === 'words' && phrase ? 'nothing says that' : '';
        return;
    }
    const gone = results.filter((r) => !r.vod.media).length;
    nodes.note.textContent =
        `${results.length} found` +
        (results.length > SHOWN ? ` · ${SHOWN} shown` : '') +
        (gone ? ` · ${gone} whose recording is not on disk` : '');
}

function drawEmpty() {
    put(nodes.controls, () => []);
    nodes.note.textContent = '';
    put(nodes.list, () => [
        div('note dim', 'no corpus'),
        div('note dim selectable',
            'tools/supercut.js pull <channel> · transcribe <channel> · index <channel>'),
    ]);
}

function drawRows() {
    put(nodes.list, () => results.slice(0, SHOWN).map((item, n) => (
        div('row' + (playing === item ? ' playing' : ''), [
            el('button', {
                cls: 'tiny', text: '▶', title: 'Listen',
                // A recording deleted to reclaim the disk still has its words,
                // so the hit is real and only the playing is impossible.
                // Refused on the control rather than by leaving the row out,
                // which would make the count disagree with the list.
                disabled: !item.vod.media,
                on: { click: () => play(n) },
            }),
            el('span', { cls: 'at mono', text: clock(item.at) }),
            el('span', { cls: 'label', text: item.label }),
            el('span', { cls: 'detail dim', text: item.detail }),
            el('span', { cls: 'where dim', text: (item.vod.title || '').slice(0, 22) }),
            el('button', {
                cls: 'tiny', text: '+', title: 'Add to the mix',
                disabled: !item.vod.media,
                on: { click: () => add(n) },
            }),
        ])
    )));
}
