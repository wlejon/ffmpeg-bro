// The finder, which in this application is half the window rather than a panel
// over something else.
//
// Six hours of somebody talking is not a thing anybody scrubs through, so the
// words are the index and the list is where every edit starts. Four tabs,
// because there are four questions and they are not the same shape:
//
//   - **Recordings** — what is in the corpus at all, and what a channel has that
//     is not in it yet. The one this opens on.
//   - **Words** — you know what was said and want every time it was said.
//   - **Talking** — you do not know what is in there, and want the stretches
//     worth listening to. A stretch is defined by its *gaps* and by nothing
//     else; see `monologues` in `ui/phrase.js` for why it is named after the
//     measurement and claims nothing about what is in it.
//   - **Line** — you know what it should say. The one tab whose input is a
//     *sentence* rather than a search: typed whole, every word found and paced,
//     heard and adjusted by ear, and then put in the mix. `supercut/line.js`
//     decides every word of that and `supercut/ruler.js` draws it, which is
//     the same split the other three keep with `ui/library.js`; this file only
//     hands the tab over.
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

import { el, div, put, setText } from '../ui/dom.js';
import { clock } from '../ui/format.js';
import { gb } from '../corpus/files.js';
import * as library from '../ui/library.js';
import * as acquire from './acquire.js';
import * as ruler from './ruler.js';

/// A found list is long and the interesting part is the top of it. The cap is on
/// what is *drawn* rather than on what is found, so the count stays honest.
const SHOWN = 300;

let nodes = null;
let hooks = {};
let tab = 'recordings';
let results = [];
/// The search in flight, or null.
///
/// **A corpus is fifty hours and a keystroke is not long enough to walk it** —
/// the block above `beginSearch` in `ui/library.js` has the measurements. So the
/// two tabs that ask the corpus a question ask for a reading and `tick()`
/// advances it; `results` is that reading's `hits`, which the library grows and
/// reorders in place, so what is drawn is the search so far rather than a copy
/// of an older answer. The other two tabs answer instantly and are not readings:
/// the inventory is a listing, and the score is arithmetic over answers the
/// library has already given.
let reading = null;

/// The nodes on each recording row that carry a number, by VOD id — what
/// `repaint()` writes into. Rebuilt with the rows and cleared with them, so it
/// can never name an element that has left the screen. Only recordings have any:
/// a hit says a timecode and a phrase, and neither of those moves.
const moving = new Map();
let playing = null;      // the item being auditioned, for the row to show it

let phrase = '';
let loose = false;
let gap = 2;
let least = 30;
let talkingMode = 'longest';
let minPace = 2.8;

export function initResults(refs, h) {
    nodes = refs;
    hooks = h || {};
    for (const b of nodes.tabs.querySelectorAll('[data-tab]'))
        b.addEventListener('click', () => setTab(b.dataset.tab));
    // The fourth tab draws into the same three nodes and is told which they are
    // once; the finder itself is handed over so the tab can ask for more width.
    ruler.initRuler({
        controls: nodes.controls, note: nodes.note, list: nodes.list,
        finder: nodes.tabs.parentNode,
    }, hooks);
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
    library.cancelSearch(reading);
    reading = null;
    results = [];
}

export function currentTab() { return tab; }

export function setTab(next) {
    if (tab === next) return;
    if (tab === 'line') ruler.leave();
    tab = next;
    // **Answered on arrival, not on a press.** Two of the three questions have an
    // answer already — what is in the corpus, and where the talking is — and a
    // tab that came up empty with a Find button beside it would be asking
    // somebody to confirm they meant to press the tab they just pressed.
    search();
    draw();
    // The one tab that needs typing before it answers, and the box is the
    // whole of it: the caret goes there on arrival so the press is the search.
    if (tab === 'words') {
        const box = document.getElementById('f-phrase');
        if (box) box.focus();
    }
    // The other one: the line arrives with the caret in its box.
    if (tab === 'line') ruler.arrive();
}

/// What the list is showing, for a caller that has to check it rather than read
/// it — a suite, which cannot see the rows.
export function found() { return results.slice(); }

/// Ask the talking question without the pane having to be showing an answer.
export function runsFor(opts) { return library.searchTalking(opts); }

function search() {
    // Whatever was being looked for is abandoned first: a phrase typed over is a
    // question nobody is waiting for an answer to, and the recording its reading
    // was in the middle of is work thrown away rather than work finished for
    // nothing.
    library.cancelSearch(reading);
    reading = null;
    // **The first tab is the inventory and not `library.recordings()`.** The
    // manifest knows about a recording that has words; the tab is about every
    // recording the channel has, including the five nobody has fetched. The
    // inventory is a superset of the manifest and its rows are the same shape,
    // which is why one list still draws all three tabs.
    if (tab === 'recordings') results = acquire.list();
    else if (tab === 'line') results = [];
    else {
        reading = tab === 'words'
            ? library.beginSearch('words', { phrase, loose })
            : library.beginSearch('talking', {
                gap,
                min: least,
                mode: talkingMode,
                minRate: talkingMode === 'activated' ? minPace : 0,
            });
        results = reading.hits;
    }
    drawNote();
    drawRows();
}

/// How long a frame may spend walking the corpus — `ui/find.js`'s number and its
/// reason. This window has less to draw than the workbench does and could afford
/// more; it is the same number anyway, because the two are the same search and a
/// list that filled in at two different speeds in two windows would be one of
/// them looking broken.
const BUDGET_MS = 8;

/// And how long a frame may spend reading the corpus with nothing being asked of
/// it — `ui/find.js`'s number and its reason: nobody is waiting for a read
/// nobody asked for, and it must not take the room a search somebody typed
/// would use.
const IDLE_MS = 4;

/// Advance the search, and say whether the list moved. Called from the frame
/// loop, which is the only thing that advances a reading — see `search`.
///
/// **Redrawn only when something changed.** A reading whose worker is still on
/// its first span moves nothing on the screen, and rebuilding three hundred rows
/// to say so is exactly the cost `repaint()` exists to refuse one storey along.
export function tick() {
    if (!reading || reading.done) {
        // Nothing being looked for: read the corpus instead, so that the calls
        // which cannot be readings do not pay for it. The score is the one that
        // matters here — `supercut/line.js` resolves every word of it through
        // `searchWords` on the keystroke that changed it, and what made that
        // slow was the first read of the transcripts and never the search.
        library.warmSome(IDLE_MS);
        return false;
    }
    if (!library.stepSearch(reading, BUDGET_MS)) return false;
    drawNote();
    drawRows();
    return true;
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
    // A transcription landing changes what every word of the line resolves to.
    if (tab === 'line') { ruler.reload(); return; }
    // **Except the two the machine changes by itself.** A checkpoint landing
    // takes the model controls away and starting to fetch one turns them into a
    // Stop, and neither is a press on this row — so what the row *should* be
    // offering is compared with what is there, and it is rebuilt only when they
    // disagree. Two lookups against the caret in the channel box, which is what
    // the paragraph above is protecting.
    if (tab === 'recordings' &&
        (!acquire.speech() !== !!document.getElementById('f-model') ||
         !!acquire.gettingModel() !== !!document.getElementById('f-model-stop')))
        drawControls();
    drawNote();
    drawRows();
}

/// Write the moving numbers into the rows that are already on the screen.
///
/// **The redraw a progress bar is allowed to ask for.** A pull crosses ten
/// megabytes a few times a second and a read lands a window of words about as
/// often, and every one of those used to rebuild the whole list — twenty rows of
/// seven elements each, thrown away and made again to move one percentage. That
/// is 140 elements a redraw for text that fits in two writes, and elements
/// thrown away are the expensive kind: they are detached, and detached is the
/// state a document pays for until the engine collects them.
///
/// So `acquire.tick()` says which kind of change happened and this is the cheap
/// one: `whereOf` for the sentence, one style write for the bar, and nothing
/// built. A row whose *condition* changed — a pull that finished, a Transcribe
/// button that became a Stop — is not this; that is `refresh()`, and
/// `acquire.tick()` answers `'rows'` for it.
export function repaint() {
    // **The Line tab's moving part is its note and the envelopes landing.** A
    // commit's inputs opening and its onset reads landing change the note and
    // nothing else — the words are what was typed and nobody has touched them —
    // so this is one write per frame, and a repaint of the blocks whose sound
    // just arrived, rather than the ruler rebuilt.
    if (tab === 'line') { ruler.repaint(); return; }
    if (tab !== 'recordings') return;
    for (const item of results) {
        const node = moving.get(item.id);
        if (!node) continue;
        const text = whereOf(item);
        // Compared before writing: `textContent=` replaces the text node, so an
        // unconditional write would be exactly the churn this call exists to
        // stop, one node smaller.
        setText(node.where, text);
        if (node.fill) node.fill.style.width = `${(item.progress || 0) * 100}%`;
    }
    // The channel's own line carries counts that a landing read changes, and it
    // is one write.
    drawNote();
}

// ── the two things a row does ──────────────────────────────────────────────

/// Hear it. One element, shared with everything else on the screen — see
/// `screen.js`, where the rule about a decoder being a property of a *file* is.
/// Hear it — or stop hearing it, if this is the row already playing.
///
/// **The same control, because it is the same thing.** An audition ends by
/// itself at the end of the moment, which is right for a two-second hit and
/// useless for a six-hour recording: pressing `▶` on one and then having no way
/// to stop it is the window carrying on talking over everything done next. So
/// the button on the row that is playing is the stop, in the place the hand is
/// already on.
export function play(n) {
    const item = results[n];
    if (!item || !item.vod.media) return false;
    if (isPlaying(item)) { hush(); return true; }
    playing = item;
    const lead = item.kind === 'word' ? library.WORD_PAD : 0;
    hooks.audition(item.vod.media, Math.max(0, item.at - lead), item.to + lead);
    drawRows();
    return true;
}

/// Stop the audition, whichever row it is on — or whichever word of the line.
/// The app's `Space` reaches this too.
export function hush() {
    const word = ruler.hush();
    if (!playing) return word;
    if (hooks.hush) hooks.hush();
    playing = null;
    drawRows();
    return true;
}

/// Is anything being auditioned? For the caller that has to decide what a key
/// means — see `app.js`.
export function auditioning() { return !!playing || ruler.auditioning(); }

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
    ruler.stopped();
    if (!playing) return;
    playing = null;
    drawRows();
}

// ── drawing ────────────────────────────────────────────────────────────────

function draw() {
    for (const b of nodes.tabs.querySelectorAll('[data-tab]'))
        b.classList.toggle('on', b.dataset.tab === tab);
    // The ruler is a row of seconds and wants the room; the other three are
    // lists and do not.
    if (nodes.tabs.parentNode) nodes.tabs.parentNode.classList.toggle('line', tab === 'line');
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
            const folder = acquire.showingFolder();
            const box = el('input', {
                type: 'text', id: 'f-channel', value: acquire.channelName(),
                placeholder: 'a Twitch channel',
                // **Committed on the press and on Enter, never on `input`.**
                // Every commit is an HTTP request to Twitch, which is the one
                // case CLAUDE.md's note about `change` excludes from the rule
                // that a field which can commit per keystroke should.
                on: { keydown: (e) => { if (e.key === 'Enter') go(); } },
            });
            // **The same press, and a different word for it.** A broadcaster is
            // looked up over the network and a folder is looked at again on this
            // disk; both are "what has this channel got now", both are
            // `acquire.lookUp`, and a second button for the second one would be
            // a control that is dead for every channel the other is alive for.
            const btn = el('button', {
                cls: 'text', text: folder ? 'Re-scan' : 'Look up',
                disabled: acquire.busy(),
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
            // **Footage that is already here is one press, beside the one that
            // goes and gets some.** This tab's whole question is "what is there
            // to search", and until now the only answer it could take was a
            // broadcaster's — so a folder of footage on this disk was a corpus
            // the application could search and had no way to be told about.
            //
            // Two buttons and not one, because they are two different pickers:
            // SDL has a folder dialog and a file dialog and neither can do the
            // other's job. What happens after them is the same call.
            const adopt = (run) => {
                const line = run();
                if (!line) return;       // cancelled: nothing to say
                search();
                drawControls();
                drawChannel();
                drawNote();
            };
            // Wrapped together, because they are one offer in two pickers: the
            // controls row wraps, and a `Folder…` on one line with its `Files…`
            // on the next reads as two unrelated buttons.
            const kids = [box, btn, el('span', { cls: 'pair' }, [
                el('button', {
                    cls: 'text', id: 'f-folder', text: 'Folder…',
                    title: 'Add every video in a folder',
                    on: { click: () => adopt(acquire.addFolder) },
                }),
                el('button', {
                    cls: 'text', id: 'f-files', text: 'Files…',
                    title: 'Add video files',
                    on: { click: () => adopt(acquire.addFiles) },
                }),
            ])];
            // **Only when there is none**, which is what makes these an
            // affordance rather than a setting: a machine with a checkpoint
            // where the search looks never sees them, and one without has the
            // two presses that mend every row on the list standing beside the
            // statement saying so. `acquire.js` says why they are here and not
            // on a row.
            //
            // **Two presses, because there are two answers.** The weights are
            // 2.5 GB and either you have them somewhere already, in which case
            // pointing at them is instant and copies nothing, or you do not, in
            // which case somebody has to go and get them — and sending a person
            // to a shell script for that is what this pair replaces. `Get` is
            // first because it is the one that works on a machine that has
            // nothing.
            if (!acquire.speech()) {
                const done = (run) => () => {
                    run();
                    drawRows();
                    drawControls();
                    drawNote();
                };
                const pair = [];
                if (acquire.gettingModel())
                    // The same rule the row states: while it runs, the button is
                    // the one that stops it, so a second press means the first.
                    pair.push(el('button', {
                        cls: 'text', id: 'f-model-stop', text: 'Stop',
                        title: 'Stop fetching the speech model',
                        on: { click: done(acquire.stopModelFetch) },
                    }));
                else
                    pair.push(el('button', {
                        cls: 'text', id: 'f-model-get', text: 'Get model',
                        title: 'Fetch the speech model (2.5 GB)',
                        on: { click: done(acquire.getModel) },
                    }));
                pair.push(el('button', {
                    cls: 'text', id: 'f-model', text: 'Model…',
                    title: acquire.speechWhy(),
                    on: { click: done(acquire.chooseSpeechModel) },
                }));
                kids.push(el('span', { cls: 'pair' }, pair));
            }
            // The way back, and only when there is something to come back from.
            // What is *currently* being searched is said by `about()` in the
            // header — a statement that changes — so this is the control and
            // nothing here restates the count.
            if (library.chosen().length)
                kids.push(el('button', {
                    cls: 'text', text: 'All', title: 'Search every recording',
                    on: { click: () => { library.choose([]); search(); draw(); } },
                }));
            return kids;
        }
        if (tab === 'line') { ruler.drawControls(); return []; }
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
        const modeSelect = el('select', {
            id: 'f-talking-mode',
            on: { change: () => {
                talkingMode = modeSelect.value;
                if (talkingMode === 'yelling' && least > 15) least = 10;
                else if (talkingMode === 'activated' && least > 20) least = 15;
                else if (talkingMode === 'longest' && least < 20) least = 30;
                search();
                drawControls();
            } },
        }, [
            el('option', { value: 'longest', selected: talkingMode === 'longest' ? 'selected' : null }, 'Longest stretches'),
            el('option', { value: 'activated', selected: talkingMode === 'activated' ? 'selected' : null }, 'Activated / fast pace'),
            el('option', { value: 'yelling', selected: talkingMode === 'yelling' ? 'selected' : null }, 'Yelling / high energy'),
        ]);
        const g = el('input', {
            type: 'number', id: 'f-gap', step: '0.5', min: '0.5', value: String(gap),
            on: { change: () => { gap = Number(g.value) || 2; search(); } },
        });
        const m = el('input', {
            type: 'number', id: 'f-least', step: '5', min: '3', value: String(least),
            on: { change: () => { least = Number(m.value) || 10; search(); } },
        });
        // Each number with its unit, as one thing that wraps whole: a row that
        // broke between `30` and `s` read as a stray letter on a line of its own.
        const kids = [
            modeSelect,
            el('span', { cls: 'pair' }, [el('span', { cls: 'dim', text: 'pause under' }), g,
                                         el('span', { cls: 'dim', text: 's' })]),
            el('span', { cls: 'pair' }, [el('span', { cls: 'dim', text: 'at least' }), m,
                                         el('span', { cls: 'dim', text: 's' })]),
        ];
        if (talkingMode === 'activated') {
            const p = el('input', {
                type: 'number', id: 'f-min-pace', step: '0.2', min: '1.5', value: String(minPace),
                on: { change: () => { minPace = Number(p.value) || 2.5; search(); } },
            });
            kids.push(el('span', { cls: 'pair' }, [el('span', { cls: 'dim', text: 'faster than' }), p,
                                                   el('span', { cls: 'dim', text: 'words/s' })]));
        }
        return kids;
    });
}

/// What the list is, and what it is not. A statement rather than an explanation:
/// the numbers change with every search.
/// How far a search has got, as a bar and as nothing else.
///
/// **The bar is what says the window is not broken.** A list that fills in over
/// two seconds and a list that has finished look the same from the outside, and
/// on the corpus this application is for — hours of somebody talking, not
/// minutes — that is the difference between a tool that is thinking and a tool
/// that is wrong. So it is on whenever a reading is, and off, not empty, the
/// moment there is nothing left to wait for.
function drawProgress() {
    const bar = nodes && nodes.progress;
    if (!bar) return;
    const on = !!(reading && !reading.done);
    bar.hidden = !on;
    if (on) bar.firstChild.style.width = `${library.searchProgress(reading) * 100}%`;
}

function drawNote() {
    const base = library.about();
    if (nodes.about) setText(nodes.about, base);
    drawProgress();
    // **The first tab says its own line**, because it is the one that has
    // something to report before there is a corpus at all — what a look-up is
    // doing, what it refused, and how much of the channel is actually here.
    if (tab === 'recordings') { setText(nodes.note, acquire.note()); return; }
    if (tab === 'line') { ruler.drawNote(); return; }
    if (!base) {
        // The other two questions cannot be asked of a corpus that does not
        // exist, and saying so is not the same as saying nothing.
        setText(nodes.note, 'no corpus');
        return;
    }
    if (reading && !reading.done) {
        // **What it is doing, and what it has so far.** A count that appeared
        // only at the end would make every long search look like a search that
        // had found nothing — which on fifty hours is the reading somebody
        // takes, and then stops trusting the tool.
        setText(nodes.note,
            (reading.phase === 'sound'
                ? `listening · ${reading.heard} of ${reading.hearing} stretches`
                : `searching · ${reading.read} of ${reading.total} recordings`) +
            ` · ${results.length} so far`);
        return;
    }
    if (!results.length) {
        setText(nodes.note, tab === 'words' && phrase ? 'nothing says that' : '');
        return;
    }
    // A recording whose media has been deleted to reclaim the disk still has its
    // words, so it is still listed and still counted — only playing it is
    // impossible, which the row's own controls say. Counted here because a list
    // whose Add buttons are half dead with nothing saying why is worse than a
    // number.
    const gone = results.filter((r) => !r.vod.media).length;
    if (tab === 'talking') {
        const modeLabel = talkingMode === 'activated' ? 'activated stretches'
                        : talkingMode === 'yelling'   ? 'yelling / high-energy stretches'
                        : 'stretches';
        nodes.note.textContent =
            `${results.length} ${modeLabel} found` +
            (results.length > SHOWN ? ` · ${SHOWN} shown` : '') +
            (gone ? ` · ${gone} not on disk` : '');
        return;
    }
    nodes.note.textContent =
        `${results.length} found` +
        (results.length > SHOWN ? ` · ${SHOWN} shown` : '') +
        (gone ? ` · ${gone} not on disk` : '');
}

// ── which recordings a search runs over ───────────────────────────────────

/// Every recording that has words in it, which is every one a search can reach.
const searchable = () => acquire.list().filter((r) => r.state === 'transcribed');

/// Tick or untick one recording, and say what the search is now over.
///
/// **The unconfined state renders as every box ticked**, because that is what is
/// true — a search does run over all of them — and a row of empty boxes above a
/// list of results would be a lie about where they came from. So the first
/// untick starts from everything and takes one away, and a selection that grows
/// back to cover every recording goes back to being unconfined rather than being
/// a list that happens to name them all.
///
/// **The last ticked box cannot be unticked.** `ui/library.js` has no way to
/// express "search nothing" on purpose, and the alternative here — treating it
/// as "search everything" — would make the box bounce back on, which reads as a
/// bug rather than as a rule.
function toggleSearch(id, on) {
    const all = searchable().map((r) => String(r.id));
    let sel = library.chosen();
    if (!sel.length) sel = all.slice();
    sel = on ? [...new Set([...sel, String(id)])]
             : sel.filter((x) => String(x) !== String(id));
    if (!sel.length) return;
    library.choose(sel.length >= all.length ? [] : sel);
    search();
    draw();
}

/// The tick, or the room where it would be.
///
/// A recording with no transcript is not something a search can be confined to,
/// so it gets no box — and it gets the width of one anyway, because four rows
/// whose dates do not line up read as four different kinds of thing.
function searchBox(item) {
    if (item.state !== 'transcribed')
        return el('span', { cls: 'pick-gap' });
    const box = el('input', {
        cls: 'pick', type: 'checkbox', checked: library.searching(item.id),
        title: 'Search this recording',
        on: { change: () => toggleSearch(item.id, !!box.checked) },
    });
    return box;
}

// ── a recording, in whatever condition it is in ────────────────────────────

/// The one moving line on a recording's row: what is happening to it, in
/// numbers. **One home for the sentence**, because it is read twice — once when
/// the row is built and again on every repaint — and two copies of it would be a
/// row whose text stopped agreeing with itself the moment either was touched. A
/// pure function of the row, which is what lets `repaint()` write it without
/// rebuilding anything.
///
/// **Transcribing shows two numbers because they answer two questions**: how far
/// down the recording it has got, and how fast. A six-hour recording at 11× is
/// half an hour, and the multiplier is the one that tells somebody whether to
/// wait or to go and do something else.
function whereOf(item) {
    const pct = `${Math.round((item.progress || 0) * 100)}%`;
    const words = (item.vod.words || 0).toLocaleString();
    let where = span(item.to);
    switch (item.state) {
    case 'resolving':    where = `${where} · asking Twitch`; break;
    case 'pulling':      where = `${pct} · ${gb(item.bytes)}`; break;
    case 'joining':      where = `${pct} · joining`; break;
    case 'pulled':       where = `${where} · ${gb(item.bytes)}`; break;
    case 'queued':       where = `${where} · queued`; break;
    case 'transcribing':
        where = `${pct} · ${words} words · ${(item.realtime || 0).toFixed(1)}×`;
        break;
    case 'transcribed':  where = `${where} · ${words} words`; break;
    // The three a folder's file can be in and a broadcast cannot. `measuring` is
    // the probe that has not landed, which is why this row has no length yet;
    // the other two are files that will not open and files that have moved, and
    // both say which rather than going quiet.
    case 'measuring':    where = 'measuring'; break;
    // Playable and addable and never searchable, which is a fact about the file
    // and not a failure — see `settle` in `corpus/local.js`.
    case 'silent':       where = `${where} · no soundtrack`; break;
    case 'unreadable':   where = item.why || 'would not open'; break;
    case 'missing':      where = 'not where it was'; break;
    // The error as it was given, on the row it is about.
    case 'failed':       where = item.error; break;
    default: break;
    }
    if (!item.vod.media && item.state === 'transcribed') where += ' · not on disk';
    return where;
}

/// One recording's row: the state as a **statement** and the next step as a
/// **control**, and nothing anywhere telling anybody what to do. The statement
/// is `whereOf` above; this builds the control beside it.
///
/// The eight conditions `acquire.js` can report are eight different pairs of
/// those, which is why this is a table rather than a chain of ifs — a row
/// carrying the wrong button is the failure mode, and a table is the shape that
/// can be read against `acquire.js`'s own list.
function recording(item, listen, put_) {
    const id = item.id;

    const act = (text, title, on) =>
        el('button', { cls: 'tiny', text, title, on: { click: on } });

    let control = null;
    let running = false;

    // **No Transcribe without a checkpoint to read with**, which is the rule two
    // cases below state about a soundless file, arriving from the other
    // direction: there the file can never be read, here nothing on this machine
    // can read it yet. Either way a button that could only fail is worse than no
    // button, and what mends this one is `Model…` beside the channel box rather
    // than anything on a row. The statement is on the tab, said once.
    const canRead = !!acquire.speech();

    // What the row *does*, which is the half that needs building. What it
    // *says* is `whereOf` above and is written in place.
    switch (item.state) {
    case 'listed':
        control = act('Get', 'Fetch this recording', () => { acquire.get(id); refresh(); });
        break;
    case 'resolving':
        // Pressed, and working on it: the same button with nothing behind it, so
        // the row shows the press landed and a second one does nothing.
        control = el('button', { cls: 'tiny', text: 'Get', disabled: true });
        running = true;
        break;
    case 'pulling':
        control = act('Stop', 'Stop the copy', () => { acquire.stop(id); refresh(); });
        running = true;
        break;
    case 'joining':
        // The last minute of a resumed pull: what was already here and what has
        // just arrived, being put back into one file. **No Stop**, and
        // `stopPull` refuses one anyway — stopping here would leave two halves
        // and no recording, which is worse than the place the press was trying
        // to leave.
        running = true;
        break;
    case 'pulled':
        if (canRead)
            control = act('Transcribe', 'Read every word of it',
                          () => { acquire.transcribe(id); refresh(); });
        break;
    case 'queued':
        // **Not a throttle and not a wait to be apologised for**: one read runs
        // at a time because the pool underneath is process-wide. See
        // `acquire.js`.
        control = act('Stop', 'Take it out of the queue',
                      () => { acquire.stop(id); refresh(); });
        break;
    case 'transcribing':
        control = act('Stop', 'Stop reading', () => { acquire.stop(id); refresh(); });
        running = true;
        break;
    case 'transcribed':
        break;
    // **A file that is already here has no `Get`**, and the three conditions
    // below are the ones a fetch cannot be the answer to. `measuring` is a probe
    // in flight and is over in a moment; the other two are conditions of the
    // *disk*, and the press that mends either is the folder's own re-scan rather
    // than anything on the row — which is why they carry the statement and no
    // control. Left on the list saying so, because a file dropped into a folder
    // and silently ignored is the failure this whole tab is arranged against.
    case 'measuring':
        running = true;
        break;
    // **No Transcribe, because there is nothing to read.** A button that started
    // a read of a soundless file would fail a minute later with a sentence
    // nobody could have predicted from the row; the row says it now instead.
    case 'silent':
    case 'unreadable':
    case 'missing':
        break;
    case 'failed':
        // The control beside the error is the one that tries again, which is the
        // press that failed.
        control = item.failedAt === 'words'
            ? (canRead ? act('Transcribe', 'Try reading it again',
                             () => { acquire.transcribe(id); refresh(); }) : null)
            : act('Get', 'Try fetching it again', () => { acquire.get(id); refresh(); });
        break;
    default:
        break;
    }
    const where = whereOf(item);

    // A refusal reads as one wherever it came from: a fetch that failed, a file
    // that would not open, and a file that has moved are three sentences of the
    // same kind and are drawn the same way.
    const bad = item.state === 'failed' || item.state === 'unreadable'
             || item.state === 'missing';
    const whereNode = el('span', { cls: bad ? 'why bad' : 'where dim', text: where });
    const kids = [
        searchBox(item),
        listen,
        el('span', { cls: 'at mono', text: item.label }),
        el('span', { cls: 'detail', text: item.detail }),
        whereNode,
    ];
    if (control) kids.push(control);
    kids.push(put_);
    // A line along the bottom of the row, which is `supercut/cuts.js`'s bar on a
    // card moved one place: the row is a working row the whole time — it plays,
    // it adds — and what the line says is only how much longer something about it
    // will still be arriving. A veil over it would claim it could not be used.
    let fillNode = null;
    if (running) {
        fillNode = el('div', { cls: 'fill',
                               style: { width: `${(item.progress || 0) * 100}%` } });
        kids.push(div('getbar', [fillNode]));
    }
    // The two things a repaint writes. Held by id rather than looked up with a
    // selector, so a repaint costs a map lookup and two writes per row instead
    // of a query over the list.
    moving.set(id, { where: whereNode, fill: fillNode });

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
    // Whatever the last list left behind is gone with it. Cleared here rather
    // than in `repaint()` so that a row taken off the screen can never be
    // written to afterwards.
    moving.clear();
    // The line is not a list, and the fourth tab draws it into the same node.
    if (tab === 'line') { ruler.draw(); return; }
    put(nodes.list, () => results.slice(0, SHOWN).map((item, n) => {
        const dead = !item.vod.media;
        const on = isPlaying(item);
        const listen = el('button', {
            cls: 'tiny' + (on ? ' on' : ''), text: on ? '■' : '▶',
            title: on ? 'Stop' : 'Listen',
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

        return div('row' + (item.kind === 'run' ? ' run' : '') +
                   (isPlaying(item) ? ' playing' : ''), [
            listen,
            el('span', { cls: 'at mono', text: clock(item.at) }),
            el('span', { cls: 'label', text: item.label }),
            el('span', { cls: 'detail dim', text: item.detail }),
            el('span', { cls: 'where dim', text: (item.vod.title || '').slice(0, 22) }),
            put_,
        ]);
    }));
}
