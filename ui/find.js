// Finding the material: every place a word was said, and every stretch where
// somebody talked without stopping.
//
// A supercut is two jobs and only one of them is editing. The other is *finding*
// — six hours of recording is not something anybody scrubs through, so the words
// have to be searchable and the search has to hand back moments you can hear
// before you commit to them. That is what this panel is: a search box, a list,
// something to play a hit with, and a button that puts it on the timeline.
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
// ── Where the corpus comes from ───────────────────────────────────────────
//
// **A file is the seam.** `tools/supercut.js index <channel>` writes
// `build/corpus/find.json`, a list of channels and the manifests describing
// them; this reads that and nothing else. The store's layout, the Twitch API,
// the pulling and the transcribing all stay in `tools/`, which is deliberately
// not part of this application — see the block at the top of `tools/README.md`.
// An absent file is the ordinary case and not an error: there is no corpus, so
// there is no panel, and nothing anywhere has to explain why.
//
// The manifest carries paths and counts, not words. The transcripts are a
// megabyte each and already on disk in a form this application can read, so they
// are read from here directly — copying ninety thousand words into a second file
// would make a stale copy the first time a recording was transcribed again.
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
//
// The search itself is `phrase.js`'s, which is also what `tools/clips.js` cuts
// with. The two must not be able to disagree: this list says where the moments
// are and that file turns them into files.

import { el, div, put } from './dom.js';
import { clock } from './format.js';
import { parseSrt, streamOf, find, monologues } from './phrase.js';

const fs = require('fs');

// The one well-known path. Relative to the working directory, which is where
// `build/` is for anybody running this out of the repository.
const ROLL = 'build/corpus/find.json';
let rollPath = ROLL;

// A found list is long and the interesting part is the top of it. The cap is on
// what is *drawn* rather than on what is found, so the count stays honest.
const SHOWN = 300;

let host = null;          // { addToMix, note }
let roll = null;          // the parsed roll-up, or null
let channel = null;       // the manifest in hand
const streams = new Map();  // vodId → search stream, built once
let tab = 'words';
let results = [];
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
        list: document.getElementById('find-list'),
        video: document.getElementById('find-video'),
    };
    for (const b of document.querySelectorAll('[data-find-tab]'))
        b.addEventListener('click', () => setTab(b.dataset.findTab));
    const close = document.getElementById('find-close');
    if (close) close.addEventListener('click', () => setOn(false));
}

/// Read a corpus from somewhere other than the well-known path.
///
/// The default is one fixed path, which is what makes "there is no corpus" an
/// absent file rather than a setting. It is overridable for the two callers a
/// fixed path would otherwise shut out: a suite, which must not write over
/// somebody's real manifest to prove the panel works, and a corpus kept
/// somewhere other than beside the repository.
export function useCorpus(path) {
    rollPath = path || ROLL;
    roll = null;
    channel = null;
    streams.clear();
    results = [];
}

/// Is there a corpus at all? An absent file is the ordinary case.
export function available() {
    if (roll === null) {
        try { roll = JSON.parse(fs.readFileSync(rollPath, 'utf-8')); }
        catch (e) { roll = false; }
    }
    return !!(roll && roll.channels && roll.channels.length);
}

export function isOn() { return !!(nodes && nodes.panel && !nodes.panel.hidden); }

/// Open or close the finder.
export function setOn(on) {
    if (!nodes || !nodes.panel) return;
    if (on && !available()) return;
    nodes.panel.hidden = !on;
    // Nothing may go on playing behind a closed panel: the audition element is
    // a decoder like any other and it is the one thing here that costs while
    // nobody is looking at it.
    if (!on) stopAudition();
    else {
        if (!channel) pick(roll.channels[0].channel);
        draw();
    }
}

// ── the corpus ─────────────────────────────────────────────────────────────

function pick(name) {
    const entry = (roll.channels || []).find((c) => c.channel === name);
    if (!entry) return;
    try { channel = JSON.parse(fs.readFileSync(entry.manifest, 'utf-8')); }
    catch (e) { channel = null; return; }
    streams.clear();
    results = [];
}

/// The search stream for one recording, built once and kept.
///
/// A megabyte of cues parsed per recording, which is why this is memoised rather
/// than done per search: somebody typing into the box asks a new phrase of the
/// same words on every keystroke.
function streamFor(v) {
    let s = streams.get(v.id);
    if (!s) {
        try { s = streamOf(parseSrt(fs.readFileSync(v.srt, 'utf-8'))); }
        catch (e) { s = streamOf([]); }
        streams.set(v.id, s);
    }
    return s;
}

// ── searching ──────────────────────────────────────────────────────────────

function runWords(phrase, loose) {
    results = [];
    if (!channel || !phrase || phrase.replace(/[^a-z0-9|]/gi, '').length < 2) return;
    for (const v of channel.vods) {
        for (const h of find(streamFor(v), phrase, { loose })) {
            results.push({
                kind: 'word', vod: v, at: h.at, to: h.says,
                label: h.matched, detail: h.context,
            });
        }
    }
    // Newest recording first, then in time order inside it, which is the order
    // somebody thinks about their own recordings in.
    results.sort((a, b) => String(b.vod.publishedAt).localeCompare(String(a.vod.publishedAt))
                        || a.at - b.at);
}

/// Every stretch of talking in the corpus at these settings, longest first.
///
/// Separate from the drawing so that a caller can ask the question without the
/// panel having to be showing an answer to it.
export function runsFor(opts = {}) {
    const out = [];
    if (!channel) return out;
    for (const v of channel.vods) {
        for (const m of monologues(streamFor(v).words, opts)) {
            out.push({
                kind: 'run', vod: v, at: m.at, to: m.to,
                label: `${Math.round(m.seconds)}s · ${m.words} words · ` +
                       `${m.rate.toFixed(1)}/s`,
                detail: m.opening,
                seconds: m.seconds,
            });
        }
    }
    // Longest first: the whole point of the list is that you cannot know what is
    // in a stretch before playing it, so the only ranking available is size.
    return out.sort((a, b) => b.seconds - a.seconds);
}

function runTalking(gap, min) {
    results = runsFor({ gap, min });
}

// ── auditioning ────────────────────────────────────────────────────────────

/// Play one result, on the single element every row shares.
///
/// Seeking is done once the element can answer for the position: setting
/// `currentTime` on a source that has not opened is a seek into nothing, and a
/// six-hour file opened cold does not answer on the same frame it is asked.
function playItem(item) {
    const video = nodes.video;
    if (!video || !item.vod.media) return;
    const lead = item.kind === 'word' ? 1.5 : 0;
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
        if (roll && roll.channels.length > 1) {
            const sel = el('select', {
                on: { change: () => { pick(sel.value); results = []; draw(); } },
            }, roll.channels.map((c) => el('option', {
                value: c.channel, text: c.channel,
                selected: channel && c.channel === channel.channel,
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

/// What the list is, and what it is not. A statement rather than an
/// explanation: the numbers change with every search.
function drawNote() {
    if (!nodes.note) return;
    if (!channel) { nodes.note.textContent = ''; return; }
    const hours = channel.vods.reduce((n, v) => n + (v.seconds || 0), 0) / 3600;
    const words = channel.vods.reduce((n, v) => n + (v.words || 0), 0);
    const base = `${channel.vods.length} recordings · ${hours.toFixed(1)} h · ${words} words`;
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
                on: { click: () => host && host.addToMix(asClip(item)) },
            }),
        ]);
    }));
}

/// A result as the thing a timeline takes: a file, and a span of it.
///
/// The padding is the same 1.5 s `tools/clips.js` cuts with, and for the same
/// reason — a word with nothing before it arrives already half said. A stretch
/// of talking is taken as it is: its edges are silences by construction.
function asClip(item) {
    const pad = item.kind === 'word' ? 1.5 : 0;
    return {
        path: item.vod.media,
        name: `${item.vod.id} ${clock(item.at)}`,
        from: Math.max(0, item.at - pad),
        to: item.to + pad,
    };
}

/// Put the nth result on the timeline — what the row's Add button does, reachable
/// without a row to press.
export function addFound(n) {
    const item = results[n];
    if (!item || !item.vod.media || !host) return false;
    host.addToMix(asClip(item));
    return true;
}

/// Play the nth result on the shared element, likewise.
export function playFound(n) {
    if (!results[n]) return false;
    playItem(results[n]);
    return true;
}

/// Called from the frame loop, which is what ends an audition where the moment
/// ends. Cheap enough to run every frame and does nothing at all when the panel
/// is closed or nothing is playing.
export function tick() {
    if (audition) watchAudition();
}
