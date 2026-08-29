// The finder, which in this application is half the window rather than a panel
// over something else.
//
// Six hours of somebody talking is not a thing anybody scrubs through, so the
// words are the index and the list is where every edit starts. Three tabs,
// because there are three questions and they are not the same shape:
//
//   - **Recordings** — what is in the corpus at all, and what a channel has that
//     is not in it yet. The one this opens on.
//   - **Words** — you know what was said and want every time it was said.
//   - **Talking** — you do not know what is in there, and want the stretches
//     worth listening to. A stretch is defined by its *gaps* and by nothing
//     else; see `monologues` in `ui/phrase.js` for why it is named after the
//     measurement and claims nothing about what is in it.
//
// **The list is never empty when there is a corpus, and that is the point of the
// first tab.** This opened on Words with nothing typed, which meant a window
// reporting four recordings and ninety thousand words in the top bar and showing
// none of it — the state somebody is in the moment they launch it. Two of the
// three questions have an answer before anybody asks: what is here, and where
// the talking is. Only Words needs a phrase, and it is not where this starts.
//
// **What the answer is belongs to `ui/library.js`.** This file draws it and
// nothing more, which is what stops this list and the one the workbench's panel
// draws — and the files `tools/clips.js` cuts — from describing three different
// sets of moments.
//
// **And what state a recording is in belongs to `supercut/acquire.js`**, for the
// same reason one storey along: a row is drawn from four sources — Twitch's
// listing, this disk, the manifest, and whatever is being fetched or read right
// now — and a second opinion about which of them wins would be a list that says
// `Get` beside a recording that is already here. So the first tab draws
// `acquire.list()` and decides only how a row looks.

import { el, div, put } from '../ui/dom.js';
import { clock } from '../ui/format.js';
import { gb } from '../corpus/files.js';
import * as library from '../ui/library.js';
import * as acquire from './acquire.js';

/// A found list is long and the interesting part is the top of it. The cap is on
/// what is *drawn* rather than on what is found, so the count stays honest.
const SHOWN = 300;

let nodes = null;
let hooks = {};
let tab = 'recordings';
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

/// Open the corpus and draw. Answers false when there is none.
///
/// **A machine with no corpus is no longer a dead end**, which is the one thing
/// that changed here: the Recordings tab draws its channel box either way, so
/// the first thing this window can do is go and get a recording. The answer is
/// still returned because a caller may want to say so.
export function start() {
    const had = library.available();
    if (had) library.pick();
    const here = library.current();
    acquire.open(here ? here.channel : '');
    search();
    draw();
    return had;
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
    // **Answered on arrival, not on a press.** Two of the three questions have an
    // answer already — what is in the corpus, and where the talking is — and a
    // tab that came up empty with a Find button beside it would be asking
    // somebody to confirm they meant to press the tab they just pressed.
    search();
    draw();
}

/// What the list is showing, for a caller that has to check it rather than read
/// it — a suite, which cannot see the rows.
export function found() { return results.slice(); }

/// Ask the talking question without the pane having to be showing an answer.
export function runsFor(opts) { return library.searchTalking(opts); }

function search() {
    // **The first tab is the inventory and not `library.recordings()`.** The
    // manifest knows about a recording that has words; the tab is about every
    // recording the channel has, including the five nobody has fetched. The
    // inventory is a superset of the manifest and its rows are the same shape,
    // which is why one list still draws all three tabs.
    results = tab === 'recordings' ? acquire.list()
            : tab === 'words'      ? library.searchWords(phrase, { loose })
                                   : library.searchTalking({ gap, min: least });
    drawNote();
    drawRows();
}

/// Draw the list again because something landed — a copy advanced, a read
/// finished, a look-up answered. Called from the frame loop when `acquire.tick()`
/// says so, and never on a frame where nothing moved.
///
/// **The controls are deliberately not redrawn**: the channel box is one of them
/// and rebuilding it under a hand that is typing into it would take the focus and
/// the caret away every time a progress bar moved a percent.
export function refresh() {
    if (tab === 'recordings') results = acquire.list();
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

/// Is this the row being auditioned?
///
/// **By identity, and by id for a recording**, because the inventory hands over
/// fresh row objects every time a job settles — so a copy landing on one row
/// would otherwise take the highlight off another that is still playing.
const isPlaying = (item) =>
    playing === item || !!(playing && playing.kind === 'vod' &&
                           item.kind === 'vod' && playing.id === item.id);

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
            on: { change: () => {
                library.pick(sel.value);
                // The inventory is about a channel too, and the two must be the
                // same one: a menu that moved the search and left the first tab
                // listing somebody else's broadcasts would be two answers to one
                // question.
                acquire.open(sel.value);
                search();
                drawNote();
            } },
        }, chans.map((c) => el('option', {
            value: c.channel, text: c.channel,
            selected: here && c.channel === here.channel,
        })));
        return [sel];
    });
}

function drawControls() {
    put(nodes.controls, () => {
        // **One parameter: which channel.** This said "nothing to set — what the
        // corpus holds is not a question with parameters", and that was true
        // exactly as long as the only corpus was one a command line had already
        // built. The question the tab asks is now "what has this channel got",
        // and a channel nobody has pulled is a valid answer to it.
        if (tab === 'recordings') {
            const box = el('input', {
                type: 'text', id: 'f-channel', value: acquire.channelName(),
                placeholder: 'a Twitch channel',
                // **Committed on the press and on Enter, never on `input`.**
                // Every commit is an HTTP request to Twitch, which is the one
                // case CLAUDE.md's note about `change` excludes from the rule
                // that a field which can commit per keystroke should.
                on: { keydown: (e) => { if (e.key === 'Enter') go(); } },
            });
            const btn = el('button', {
                cls: 'text', text: 'Look up', disabled: acquire.busy(),
                on: { click: () => go() },
            });
            function go() {
                if (acquire.busy()) return;
                btn.disabled = true;
                drawNote();
                acquire.lookUp(box.value).then(() => {
                    // The whole tab, because a look-up changes the channel the
                    // box is showing as well as every row under it.
                    search();
                    drawControls();
                    drawChannel();
                });
            }
            return [box, btn];
        }
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
    if (nodes.about) nodes.about.textContent = base;
    // **The first tab says its own line**, because it is the one that has
    // something to report before there is a corpus at all — what a look-up is
    // doing, what it refused, and how much of the channel is actually here.
    if (tab === 'recordings') { nodes.note.textContent = acquire.note(); return; }
    if (!base) {
        // The other two questions cannot be asked of a corpus that does not
        // exist, and saying so is not the same as saying nothing.
        nodes.note.textContent = 'no corpus';
        return;
    }
    if (!results.length) {
        nodes.note.textContent = tab === 'words' && phrase ? 'nothing says that' : '';
        return;
    }
    // A recording whose media has been deleted to reclaim the disk still has its
    // words, so it is still listed and still counted — only playing it is
    // impossible, which the row's own controls say. Counted here because a list
    // whose Add buttons are half dead with nothing saying why is worse than a
    // number.
    const gone = results.filter((r) => !r.vod.media).length;
    nodes.note.textContent =
        `${results.length} found` +
        (results.length > SHOWN ? ` · ${SHOWN} shown` : '') +
        (gone ? ` · ${gone} not on disk` : '');
}

// ── a recording, in whatever condition it is in ────────────────────────────

/// One recording's row: the state as a **statement** and the next step as a
/// **control**, and nothing anywhere telling anybody what to do.
///
/// The eight conditions `acquire.js` can report are eight different pairs of
/// those, which is why this is a table rather than a chain of ifs — a row
/// carrying the wrong button is the failure mode, and a table is the shape that
/// can be read against `acquire.js`'s own list.
///
/// **Transcribing shows two numbers because they answer two questions**: how far
/// down the recording it has got, and how fast. A six-hour recording at 11× is
/// half an hour, and the multiplier is the one that tells somebody whether to
/// wait or to go and do something else.
function recording(item, listen, put_) {
    const id = item.id;
    const pct = `${Math.round((item.progress || 0) * 100)}%`;
    const words = (item.vod.words || 0).toLocaleString();

    const act = (text, title, on) =>
        el('button', { cls: 'tiny', text, title, on: { click: on } });

    let where = span(item.to);
    let control = null;
    let running = false;

    switch (item.state) {
    case 'listed':
        control = act('Get', 'Fetch this recording', () => { acquire.get(id); refresh(); });
        break;
    case 'resolving':
        where = `${where} · asking Twitch`;
        // Pressed, and working on it: the same button with nothing behind it, so
        // the row shows the press landed and a second one does nothing.
        control = el('button', { cls: 'tiny', text: 'Get', disabled: true });
        running = true;
        break;
    case 'pulling':
        where = `${pct} · ${gb(item.bytes)}`;
        control = act('Stop', 'Stop the copy', () => { acquire.stop(id); refresh(); });
        running = true;
        break;
    case 'joining':
        // The last minute of a resumed pull: what was already here and what has
        // just arrived, being put back into one file. **No Stop**, and
        // `stopPull` refuses one anyway — stopping here would leave two halves
        // and no recording, which is worse than the place the press was trying
        // to leave.
        where = `${pct} · joining`;
        running = true;
        break;
    case 'pulled':
        where = `${where} · ${gb(item.bytes)}`;
        control = act('Transcribe', 'Read every word of it',
                      () => { acquire.transcribe(id); refresh(); });
        break;
    case 'queued':
        // **Not a throttle and not a wait to be apologised for**: one read runs
        // at a time because the pool underneath is process-wide. See
        // `acquire.js`.
        where = `${where} · queued`;
        control = act('Stop', 'Take it out of the queue',
                      () => { acquire.stop(id); refresh(); });
        break;
    case 'transcribing':
        where = `${pct} · ${words} words · ${(item.realtime || 0).toFixed(1)}×`;
        control = act('Stop', 'Stop reading', () => { acquire.stop(id); refresh(); });
        running = true;
        break;
    case 'transcribed':
        where = `${where} · ${words} words`;
        break;
    case 'failed':
        // The error as it was given, on the row it is about. The control beside
        // it is the one that tries again, which is the press that failed.
        where = item.error;
        control = item.failedAt === 'words'
            ? act('Transcribe', 'Try reading it again',
                  () => { acquire.transcribe(id); refresh(); })
            : act('Get', 'Try fetching it again', () => { acquire.get(id); refresh(); });
        break;
    default:
        break;
    }
    if (!item.vod.media && item.state === 'transcribed') where += ' · not on disk';

    const kids = [
        listen,
        el('span', { cls: 'at mono', text: item.label }),
        el('span', { cls: 'detail', text: item.detail }),
        el('span', { cls: item.state === 'failed' ? 'why bad' : 'where dim', text: where }),
    ];
    if (control) kids.push(control);
    kids.push(put_);
    // A line along the bottom of the row, which is `supercut/cuts.js`'s bar on a
    // card moved one place: the row is a working row the whole time — it plays,
    // it adds — and what the line says is only how much longer something about it
    // will still be arriving. A veil over it would claim it could not be used.
    if (running) kids.push(div('getbar', [
        el('div', { cls: 'fill', style: { width: `${(item.progress || 0) * 100}%` } }),
    ]));

    return div('row rec' + (isPlaying(item) ? ' playing' : '') +
               (running ? ' getting' : ''), kids);
}

/// How long something is, said the way somebody says it out loud.
function span(seconds) {
    const s = Math.round(seconds || 0);
    return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
         : s >= 60    ? `${Math.floor(s / 60)}m ${s % 60}s`
                      : `${s}s`;
}

function drawRows() {
    put(nodes.list, () => results.slice(0, SHOWN).map((item, n) => {
        const dead = !item.vod.media;
        const listen = el('button', {
            cls: 'tiny', text: '▶', title: 'Listen',
            // A recording deleted to reclaim the disk still has its words, so
            // the row is real and only the playing is impossible. Refused on
            // the control rather than by leaving the row out, which would make
            // the count disagree with the list.
            disabled: dead,
            on: { click: () => play(n) },
        });
        const put_ = el('button', {
            cls: 'tiny', text: '+', title: 'Add to the mix',
            disabled: dead,
            on: { click: () => add(n) },
        });

        // **A recording is not a hit and is not drawn as one.** There is no
        // moment in it to give a timecode to and no words around it to quote —
        // what it has is a date, a name, a size and a *condition*, and those are
        // what the columns are.
        if (item.kind === 'vod') return recording(item, listen, put_);

        return div('row' + (isPlaying(item) ? ' playing' : ''), [
            listen,
            el('span', { cls: 'at mono', text: clock(item.at) }),
            el('span', { cls: 'label', text: item.label }),
            el('span', { cls: 'detail dim', text: item.detail }),
            el('span', { cls: 'where dim', text: (item.vod.title || '').slice(0, 22) }),
            put_,
        ]);
    }));
}
