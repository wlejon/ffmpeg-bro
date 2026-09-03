// Finding the material, as a panel over the Compose stage.
//
// A supercut is two jobs and only one of them is editing. The other is *finding*
// — six hours of recording is not something anybody scrubs through, so the words
// have to be searchable and the search has to hand back moments you can hear
// before you commit to them. That is what this panel is: a search box, a list,
// something to play a hit with, and a button that puts it on the timeline.
//
// **What the answer is belongs to `library.js`; this file decides only how it
// is drawn.** There is a second view over the same library — the whole
// left-hand side of `supercut` — and the one thing the two must
// never do is disagree about what was said and where.
//
// ── Why this is a panel and not a stage ───────────────────────────────────
//
// **The spine is ffmpeg's pipeline and finding is not one of its stages.**
// Capture → Sources → Compose → Graph → Encode → Write is a picture of what
// ffmpeg does, and the value of it is that it stays exactly that; a seventh
// button called Find would make it a picture of this application's menus
// instead. So the finder opens *over* the Compose stage, the way the crop
// handles and the cue layer do, and closes again — and the answer to "where does
// a found moment go" is the timeline that is already on the screen behind it.
//
// ── One element, however many results ─────────────────────────────────────
//
// **Auditioning uses a single `<video>` that every row shares.** A list of two
// hundred hits with a player per row is two hundred decoders on six-hour files,
// which is precisely the cost `ui/residency.js` exists to refuse — and the same
// measurement applies here for the same reason: a decoder is a property of what
// is being watched, not of what is being listed. So the panel owns one element,
// points it at whichever recording the pressed row is in, and seeks. Rows are
// plain markup and cost nothing.

import { el, div, put } from './dom.js';
import { clock } from './format.js';
import * as library from './library.js';

/// A found list is long and the interesting part is the top of it. The cap is on
/// what is *drawn* rather than on what is found, so the count stays honest.
const SHOWN = 300;

let host = null;          // { addToMix }
let tab = 'words';
let results = [];
/// The search in flight, or null. **A reading rather than an answer**, because a
/// corpus is somebody's fifty hours and walking it is not something that can
/// happen between two keystrokes — see the block above `beginSearch` in
/// `ui/library.js`. `results` is its `hits`, which the library grows and reorders
/// in place, so the list on the screen is the search so far rather than a copy of
/// an older one.
let reading = null;
let audition = null;      // { item, stopAt, from }
let loaded = '';          // which recording the shared element holds

let nodes = null;

/// Wire the panel to the application. `addToMix(item)` lays a found moment out
/// as a clip; the panel does not know how a clip is made.
export function initFind(opts) {
    host = opts;
    nodes = {
        panel: document.getElementById('find'),
        head: document.getElementById('find-head'),
        controls: document.getElementById('find-controls'),
        note: document.getElementById('find-note'),
        progress: document.getElementById('find-progress'),
        list: document.getElementById('find-list'),
        video: document.getElementById('find-video'),
    };
    for (const b of document.querySelectorAll('[data-find-tab]'))
        b.addEventListener('click', () => setTab(b.dataset.findTab));
    const close = document.getElementById('find-close');
    if (close) close.addEventListener('click', () => setOn(false));
}

/// Read a corpus from somewhere other than the well-known path — see
/// `library.useCorpus`, which is where the reason for it is.
export function useCorpus(path) {
    library.useCorpus(path);
    library.cancelSearch(reading);
    reading = null;
    results = [];
}

/// Is there a corpus at all? An absent file is the ordinary case.
export function available() { return library.available(); }

export function isOn() { return !!(nodes && nodes.panel && !nodes.panel.hidden); }

/// Open or close the finder.
export function setOn(on) {
    if (!nodes || !nodes.panel) return;
    if (on && !available()) return;
    nodes.panel.hidden = !on;
    // Nothing may go on playing behind a closed panel: the audition element is
    // a decoder like any other and it is the one thing here that costs while
    // nobody is looking at it. A search in flight is the second thing — it is a
    // worker decoding spans of a six-hour file for a list nobody can see.
    if (!on) { stopAudition(); library.cancelSearch(reading); }
    else {
        library.pick();
        draw();
    }
}

// ── searching ──────────────────────────────────────────────────────────────

/// Ask a question of the corpus. Whatever was being asked is abandoned first:
/// a phrase typed over is a question nobody is waiting for the answer to any
/// more, and the recording its reading was in the middle of is work thrown away
/// rather than work finished for nothing.
function ask(kind, opts) {
    library.cancelSearch(reading);
    reading = library.beginSearch(kind, opts);
    results = reading.hits;
}

function runWords(phrase, loose) { ask('words', { phrase, loose }); }

/// Every stretch of talking in the corpus at these settings, longest first.
///
/// Separate from the drawing so that a caller can ask the question without the
/// panel having to be showing an answer to it. **Answered in one call**, because
/// a caller that wanted it a frame at a time would have asked for a reading;
/// what this costs is what a corpus search costs, and the panel itself no longer
/// pays it that way.
export function runsFor(opts = {}) { return library.searchTalking(opts); }

function runTalking(gap, min) { ask('talking', { gap, min }); }

// ── auditioning ────────────────────────────────────────────────────────────

/// Play one result, on the single element every row shares.
///
/// Seeking is done once the element can answer for the position: setting
/// `currentTime` on a source that has not opened is a seek into nothing, and a
/// six-hour file opened cold does not answer on the same frame it is asked.
function playItem(item) {
    const video = nodes.video;
    if (!video || !item.vod.media) return;
    const lead = item.kind === 'word' ? library.WORD_PAD : 0;
    const from = Math.max(0, item.at - lead);
    // Stop where the thing being auditioned stops, plus a little: a hit is over
    // in a second and the element would otherwise play on into the recording.
    audition = { item, stopAt: item.to + lead, from };

    const go = () => {
        try { video.currentTime = from; } catch (e) { /* not open yet */ }
        try { video.play(); } catch (e) { /* nothing to do */ }
    };
    // **What is loaded is remembered rather than read back off the element.**
    // The host is free to normalise `src` into something that is not the string
    // it was given, so comparing against it would reload the same recording on
    // every row — which on a six-hour file is the one thing this panel is built
    // to avoid.
    if (loaded === item.vod.media && video.readyState >= 1) go();
    else {
        loaded = item.vod.media;
        video.src = item.vod.media;
        video.addEventListener('loadedmetadata', go, { once: true });
    }
    drawRows();
}

function stopAudition() {
    audition = null;
    const video = nodes && nodes.video;
    if (!video) return;
    try { video.pause(); } catch (e) { /* fine */ }
}

/// Called on the element's own clock: an audition ends where the moment does.
function watchAudition() {
    const video = nodes && nodes.video;
    if (!video || !audition) return;
    if (video.currentTime >= audition.stopAt) {
        try { video.pause(); } catch (e) { /* fine */ }
        audition = null;
        // The row stops being the one playing, which is the only thing on screen
        // that says an audition is over.
        drawRows();
    }
}

// ── drawing ────────────────────────────────────────────────────────────────

/// What the list is showing, for a caller that has to check it rather than read
/// it — a suite, which cannot see the rows.
export function found() { return results.slice(); }

/// Which of the two questions the panel is asking.
export function currentTab() { return tab; }

export function setTab(next) {
    if (tab === next) return;
    tab = next;
    library.cancelSearch(reading);
    reading = null;
    results = [];
    draw();
}

let phraseValue = '';
let looseValue = false;
let gapValue = 2;
let minValue = 30;

function draw() {
    if (!nodes || !nodes.panel || nodes.panel.hidden) return;
    for (const b of document.querySelectorAll('[data-find-tab]'))
        b.classList.toggle('on', b.dataset.findTab === tab);

    put(nodes.controls, () => {
        const bits = [];
        const chans = library.channels();
        const here = library.current();
        if (chans.length > 1) {
            const sel = el('select', {
                on: { change: () => {
                    library.pick(sel.value);
                    library.cancelSearch(reading);
                    reading = null;
                    results = [];
                    draw();
                } },
            }, chans.map((c) => el('option', {
                value: c.channel, text: c.channel,
                selected: here && c.channel === here.channel,
            })));
            bits.push(sel);
        }
        if (tab === 'words') {
            const box = el('input', {
                type: 'text', id: 'find-phrase', value: phraseValue,
                placeholder: 'a word, or "one|the other"',
                on: {
                    input: () => {
                        phraseValue = box.value;
                        runWords(phraseValue, looseValue);
                        drawNote();
                        drawRows();
                    },
                },
            });
            const loose = el('label', { cls: 'find-check' }, [
                el('input', {
                    type: 'checkbox', checked: looseValue,
                    on: {
                        change: (e) => {
                            looseValue = !!e.target.checked;
                            runWords(phraseValue, looseValue);
                            drawNote();
                            drawRows();
                        },
                    },
                }),
                'inside longer words',
            ]);
            bits.push(box, loose);
        } else {
            const gap = el('input', {
                type: 'number', step: '0.5', min: '0.5', value: String(gapValue),
                title: 'the longest silence a stretch may contain, in seconds',
                on: { change: () => { gapValue = Number(gap.value) || 2; rerun(); } },
            });
            const min = el('input', {
                type: 'number', step: '10', min: '5', value: String(minValue),
                title: 'the shortest stretch worth listing, in seconds',
                on: { change: () => { minValue = Number(min.value) || 30; rerun(); } },
            });
            bits.push(el('span', { cls: 'dim', text: 'pause under' }), gap,
                      el('span', { cls: 'dim', text: 's · at least' }), min,
                      el('span', { cls: 'dim', text: 's' }),
                      el('button', { cls: 'text', text: 'Find', on: { click: rerun } }));
        }
        return bits;
    });
    drawNote();
    drawRows();
}

function rerun() {
    if (tab === 'words') runWords(phraseValue, looseValue);
    else runTalking(gapValue, minValue);
    drawNote();
    drawRows();
}

/// How far a search has got, as a bar and as nothing else.
///
/// **The bar is what says the window is not broken.** A list that fills in over
/// two seconds and a list that has finished look the same from the outside, and
/// the difference matters most on exactly the corpus this is for: fifty hours is
/// long enough that "nothing says that" arriving early and being wrong is a
/// tool somebody stops believing. So the bar is on whenever a reading is, and
/// off — not empty, off — the moment there is nothing left to wait for.
function drawProgress() {
    const bar = nodes.progress;
    if (!bar) return;
    const on = !!(reading && !reading.done);
    bar.hidden = !on;
    if (on) bar.firstChild.style.width = `${library.searchProgress(reading) * 100}%`;
}

/// What the list is, and what it is not. A statement rather than an
/// explanation: the numbers change with every search.
function drawNote() {
    if (!nodes.note) return;
    const base = library.about();
    drawProgress();
    if (!base) { nodes.note.textContent = ''; return; }
    if (reading && !reading.done) {
        // **What it is doing, and what it has so far.** A count that only
        // appeared at the end would make every long search look like a search
        // that had found nothing.
        nodes.note.textContent =
            (reading.phase === 'sound'
                ? `listening · ${reading.heard} of ${reading.hearing} stretches`
                : `searching · ${reading.read} of ${reading.total} recordings`) +
            ` · ${results.length} so far · ${base}`;
        return;
    }
    if (!results.length) {
        nodes.note.textContent = tab === 'words' && phraseValue
            ? `nothing says that · ${base}` : base;
        return;
    }
    const gone = results.filter((r) => !r.vod.media).length;
    nodes.note.textContent =
        `${results.length} found` +
        (results.length > SHOWN ? ` · ${SHOWN} shown` : '') +
        (gone ? ` · ${gone} whose recording is not on disk` : '') +
        ` · ${base}`;
}

function drawRows() {
    if (!nodes.list) return;
    put(nodes.list, () => results.slice(0, SHOWN).map((item) => {
        return div('find-row' + (audition && audition.item === item ? ' playing' : ''), [
            el('button', {
                cls: 'tiny', text: '▶', title: 'Listen',
                // A recording that has been deleted to reclaim the disk still
                // has its words, so the hit is real and only the playing is
                // impossible. Refused on the control rather than by leaving the
                // row out, which would make the count disagree with the list.
                disabled: !item.vod.media,
                on: { click: () => playItem(item) },
            }),
            el('span', { cls: 'find-at mono', text: clock(item.at) }),
            el('span', { cls: 'find-label', text: item.label }),
            el('span', { cls: 'find-detail dim', text: item.detail }),
            el('span', { cls: 'find-where dim', text: item.vod.title.slice(0, 28) }),
            el('button', {
                cls: 'tiny', text: 'Add', title: 'Put this on the timeline',
                disabled: !item.vod.media,
                on: { click: () => host && host.addToMix(library.asClip(item)) },
            }),
        ]);
    }));
}

/// Put the nth result on the timeline — what the row's Add button does, reachable
/// without a row to press.
export function addFound(n) {
    const item = results[n];
    if (!item || !item.vod.media || !host) return false;
    host.addToMix(library.asClip(item));
    return true;
}

/// Play the nth result on the shared element, likewise.
export function playFound(n) {
    if (!results[n]) return false;
    playItem(results[n]);
    return true;
}

/// How long a frame may spend walking the corpus. A frame is 16 ms and the
/// window has a timeline and a viewer to draw in it, so half of one — and a step
/// always finishes the recording it started, so this is where a step *stops*
/// rather than a promise about how long one takes.
const BUDGET_MS = 8;

/// And how long a frame may spend reading the corpus with nothing being asked of
/// it. Half of the above, because nobody is waiting for it: the whole point of
/// reading ahead is that the cost lands on frames where it is not noticed, and a
/// frame that gave a background read the same room as a search somebody typed
/// would be spending the budget on the wrong one.
const IDLE_MS = 4;

/// Called from the frame loop, which is what ends an audition where the moment
/// ends and what advances a search. Cheap enough to run every frame and does
/// nothing at all when the panel is closed, nothing is playing and nothing is
/// being looked for.
export function tick() {
    if (audition) watchAudition();
    // Redrawn only when the reading says something moved: a search whose worker
    // is still on its first span changes nothing on the screen, and rebuilding
    // three hundred rows to say so is the cost this whole arrangement exists to
    // avoid.
    if (reading && !reading.done) {
        if (library.stepSearch(reading, BUDGET_MS)) { drawNote(); drawRows(); }
        return;
    }
    // Nothing being looked for: read the corpus instead, so that the calls which
    // cannot be readings are not the ones that pay for it. **Only while the
    // panel is open** — a window on the Compose stage with the finder closed has
    // asked no question and should not be reading a hundred megabytes of
    // transcript to be ready for one.
    if (isOn()) library.warmSome(IDLE_MS);
}
