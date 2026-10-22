// The line: a sentence in somebody's voice, found in the corpus, paced, and
// heard — before it is ever looked at.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// The rest of this application assembles a mix by *finding* — a hit, a listen,
// a press, and the moment goes on the end of the row. That is the right loop
// when the material decides the shape. It is the wrong loop when the shape is
// already in somebody's head: *what the hell are you doing, man* in this
// streamer's voice is a thing a person can hear before a single word of it has
// been found, and building it by hand is seven searches, seven presses and then
// a trim per piece to a length nobody hits by eye.
//
// So the sentence is typed and the finding is done for you. A **line** is the
// text, and under it a packed sequence of **words** — each one a moment of the
// corpus, with the cut points inside that moment, the gap after it, how fast it
// is said and how loud — in seconds, the way the mix is. The ear is the
// instrument for every one of those, and the whole of this file exists so that
// every one of them can be judged and changed *before* anything is in the mix.
//
// ── Three stages, and the mix is the last ────────────────────────────────
//
// **Write.** Every word resolves as it is typed, and the word that just landed
// is heard, because the natural confirmation that a word exists in this voice
// is to hear it in this voice. **Hear and fix.** The line is said back whole;
// a wrong take is cycled, a clipped attack is slipped, a rushed half is paced,
// a loud word is brought down — and every change is heard on the change.
// **Then the mix.** `commit` lays the line into the row as clips, and only
// then: the cuts and the proxies that make a clip cheap to scrub are three
// seconds of work each, and an earlier version that mirrored the line into the
// mix on every edit started twenty of them for twenty takes auditioned. Files
// are made for what was chosen and nothing else. Pressing it again reconciles
// — the same take is the same clip adjusted, another take is another clip
// where it stood — and between presses the mix is not touched.
//
// ── Speech is not on a grid, and a grid is a thing you quantise to ────────
//
// The first version of this was a step sequencer: a tempo, a grid, words on
// steps. That is the right model for *no no no no, on the beat* and it was the
// only model, so a sentence was rounded to eighths of a second and came out
// as a machine reading it. The substrate is now time — a word is as long as
// its take, and the gap after it is the speaker's own (`library.naturalGap`,
// the median silence between neighbouring words in the corpus, which is what
// "the pacing that fits them all" is) — and the grid is a **quantiser** over
// it: switched on, every word and gap is rounded to a step and the beat use
// is one tick away; switched off, nothing is.
//
// ── What belongs to a word ────────────────────────────────────────────────
//
// Which take it is, where its cut points are, its gap, its pace and its gain
// live **on the word object** and not in a map keyed by position, so a word
// moved keeps its choices. The cut points are `head` and `tail`: offsets from
// the take's own start and end, so a nudge of twenty milliseconds means the
// same thing on the next take cycled to. Punctuation is pacing — a comma a
// short rest, a full stop a long one — and it is taken off the word, so
// `hell,` finds `hell`.

import { bare } from '../ui/phrase.js';
import * as waves from './waves.js';
import {
    PITCH_NEAR, PACE_MIN, PACE_MAX,
    bindLineState, resolve, plan, pieceOf, replan,
    note, busy, isCommitted, resetMixState, commit, mine,
    snapping, tick, forget,
} from './line-mix.js';

export {
    PITCH_NEAR, PACE_MIN, PACE_MAX,
    resolve, plan, pieceOf, replan,
    note, busy, isCommitted, commit, mine,
    snapping, tick, forget,
};

// ── the numbers ────────────────────────────────────────────────────────────

/// The tempo somebody types when they have not decided, and the grid under a
/// beat that puts both things people tap — one word a beat, four a beat — on
/// it without changing it.
const TEMPO = 120;
const STEPS = 4;
const BAR = 4;
export const GRIDS = [1, 2, 3, 4, 6, 8];

// ── the state ──────────────────────────────────────────────────────────────

/// The line as typed. The box draws it; `setText` is what changes it.
let text = '';

/// The words: `{ id, phrase, stop, take, head, tail, gap, pace, gain }`, in
/// the order they play. `stop` is the punctuation that followed the word
/// (`''`, `','`, `'.'` or `'¶'`), `gap` is a hand-set rest in seconds or
/// null for the one `stop` means, `take` is a position in the ranked list or
/// 0 for the engine's choice.
let words = [];
let nextId = 1;

let onBeat = false;
let tempo = TEMPO;
let per = STEPS;
let bar = BAR;
let loose = false;
/// Whether a rest holds the shot before it — the recording carried on, muted
/// — or is black. See `lay`.
let restHold = true;

const KEY = 'supercut.line';

let hooks = {};

bindLineState({
    words: () => words,
    loose: () => loose,
    onBeat: () => onBeat,
    stepSeconds: () => stepSeconds(),
    restHold: () => restHold,
    hooks: () => hooks,
});

export function initLine(h) {
    hooks = h || {};
    restore();
}

// ── the grid, which is a quantiser ─────────────────────────────────────────

export function stepSeconds() { return 60 / Math.max(1, tempo) / Math.max(1, per); }
export function onBeatOf() { return onBeat; }
export function tempoOf() { return tempo; }
export function stepsPerBeat() { return per; }
export function beatsPerBar() { return bar; }
export function stepsPerBar() { return per * bar; }
export function looseOf() { return loose; }
export function restHoldOf() { return restHold; }

export function setOnBeat(on) { onBeat = !!on; moved(); }
export function setTempo(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) tempo = Math.min(600, Math.max(20, n));
    moved();
}
export function setStepsPerBeat(v) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) per = Math.min(16, Math.max(1, n));
    moved();
}
export function setBeatsPerBar(v) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) bar = Math.min(16, Math.max(1, n));
    moved();
}
export function setLoose(on) {
    loose = !!on;
    // A pin is a position in a list of takes, and the list has changed.
    for (const w of words) w.take = 0;
    moved();
}
export function setRestHold(on) { restHold = !!on; moved(); }

/// Where a moment of the line is, the way a musician counts it. For the
/// ruler's readout while quantising.
export function whereIs(t) {
    const step = Math.max(0, Math.round(t / stepSeconds()));
    const S = per * bar;
    return { bar: Math.floor(step / S) + 1, beat: Math.floor((step % S) / per) + 1, step: (step % per) + 1 };
}

/// Every setter ends here: the plan is stale and the workspace is written.
function moved() {
    replan();
    remember();
}

// ── the words ──────────────────────────────────────────────────────────────

export function textOf() { return text; }
/// The words, as copies. What the ruler draws.
export function wordsOf() { return words.map((w) => ({ ...w })); }
export function count() { return words.length; }

function fresh(phrase, stop) {
    return { id: nextId++, phrase: String(phrase), stop: stop || '', take: 0,
             head: 0, tail: 0, gap: null, pace: 1, gain: 1 };
}

/// Split a line into tokens: `{ text, stop, quoted, complete }`.
export function tokensOf(src) {
    const s = String(src || '');
    const out = [];
    const re = /"([^"]*)"|"([^"]*)$|\[([^\]]*)\]|(\S+)/g;
    let m;
    while ((m = re.exec(s))) {
        if (m[3] !== undefined) continue;
        if (m[2] !== undefined) { out.push({ text: m[2], stop: '', quoted: true, complete: false }); continue; }
        const end = m.index + m[0].length;
        const rest = s.slice(end);
        const ws = /^\s*/.exec(rest)[0];
        let t = m[1] !== undefined ? m[1] : m[4];
        let stop = '';
        let complete = end < s.length;
        if (m[4] !== undefined) {
            const p = /^(.*?)([,;:.?]+)$/.exec(t);
            if (p) { t = p[1]; stop = /[.?;]/.test(p[2]) ? '.' : ','; complete = true; }
            t = t.replace(/^[("']+|[)"']+$/g, '');
        }
        if (/\n/.test(ws)) stop = '¶';
        if (!t.trim()) continue;
        out.push({ text: t.trim(), stop, quoted: m[1] !== undefined, complete });
    }
    return out;
}

/// The line changed. The words that are still there keep everything they had
/// — take, cut points, pace, gain — and the new ones are resolved.
export function setText(src, opts = {}) {
    text = String(src || '');
    const toks = tokensOf(text).filter((t) => t.complete || opts.all);
    const before = words;
    const a = before.map((w) => bare(w.phrase));
    const b = toks.map((t) => bare(t.text));
    // Longest common subsequence, then walk it.
    const n = a.length, m = b.length;
    const L = [];
    for (let i = 0; i <= n; i++) L.push(new Int16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const next = [];
    const landed = [];
    let i = 0, j = 0;
    while (j < m) {
        if (i < n && a[i] === b[j]) {
            const w = before[i];
            w.stop = toks[j].stop;
            if (w.phrase !== toks[j].text) w.phrase = toks[j].text;
            next.push(w);
            i++; j++;
        } else if (i < n && L[i + 1][j] >= L[i][j + 1]) {
            i++;
        } else {
            next.push(fresh(toks[j].text, toks[j].stop));
            landed.push(next.length - 1);
            j++;
        }
    }
    words = next;
    moved();
    return { landed };
}

/// Say the whole line: every token is a word, including the one at the end.
/// Answers how many words there are.
export function say(src) {
    setText(src === undefined ? text : src, { all: true });
    return words.length;
}

/// Rename a word. The take is dropped with the old phrase, because it was a
/// position in a list of moments *that* word was said at. The text follows.
export function setPhrase(i, phrase) {
    const w = words[i];
    const p = String(phrase || '').trim();
    if (!w || !p) return false;
    if (bare(w.phrase) !== bare(p)) { w.take = 0; w.head = 0; w.tail = 0; }
    w.phrase = p;
    text = textFromWords();
    moved();
    return true;
}

export function removeWord(i) {
    if (!words[i]) return false;
    words.splice(i, 1);
    text = textFromWords();
    moved();
    return true;
}

/// Move a word to another place in the line. Answers its new index.
export function moveWord(i, to) {
    const w = words[i];
    if (!w) return -1;
    const j = Math.max(0, Math.min(words.length - 1, Math.round(Number(to))));
    if (j === i) return i;
    words.splice(i, 1);
    words.splice(j, 0, w);
    text = textFromWords();
    moved();
    return j;
}

/// The line as text again, after an edit made on the ruler rather than in the
/// box: the box shows the words in their order with their punctuation.
function textFromWords() {
    const out = [];
    for (const w of words) {
        const p = /\s/.test(w.phrase) ? `"${w.phrase}"` : w.phrase;
        out.push(p + (w.stop === ',' ? ',' : w.stop === '.' ? '.' : w.stop === '¶' ? '.\n' : ''));
    }
    return out.join(' ').replace(/\n /g, '\n');
}

/// Everything off the line, and its clips out of the mix.
export function clear() {
    forget();
    for (const c of mine()) if (hooks.drop) hooks.drop(c);
    words = [];
    text = '';
    resetMixState();
    moved();
}

// ── what belongs to a word ─────────────────────────────────────────────────

export function takeOf(i) { return words[i] ? words[i].take : 0; }

export function setTake(i, take) {
    const w = words[i];
    if (!w) return 0;
    w.take = Math.max(1, Math.round(Number(take) || 1));
    moved();
    return w.take;
}

/// The next take, or the one before, in the ranked list. Wraps.
export function cycleTake(i, delta = 1) {
    const p = pieceOf(i);
    if (!p || !p.takes) return 0;
    const cur = words[i].take || p.take || 1;
    const next = ((cur - 1 + delta) % p.takes + p.takes) % p.takes + 1;
    return setTake(i, next);
}

export function headOf(i) { return words[i] ? words[i].head : 0; }
export function tailOf(i) { return words[i] ? words[i].tail : 0; }

/// Move the word's start inside its take, in seconds. Later is positive.
export function setHead(i, sec) {
    const w = words[i];
    if (!w) return 0;
    w.head = clampOffset(sec);
    moved();
    return w.head;
}

/// Move the word's end inside its take. Later is positive.
export function setTail(i, sec) {
    const w = words[i];
    if (!w) return 0;
    w.tail = clampOffset(sec);
    moved();
    return w.tail;
}

/// Both cut points together: the word slid inside the recording. What `,`
/// and `.` do.
export function nudge(i, deltaSec) {
    const w = words[i];
    if (!w) return 0;
    const d = Number(deltaSec) || 0;
    w.head = clampOffset(w.head + d);
    w.tail = clampOffset(w.tail + d);
    moved();
    return w.head;
}

/// How far a cut point may be moved from the transcript's, either way. Half a
/// second is the whole of the word before or after.
export const OFFSET_MAX = 0.5;
function clampOffset(v) {
    const x = Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, Number(v) || 0));
    return Math.abs(x) < 1e-6 ? 0 : x;
}

/// Back to the engine's choices for this word: its take, its cut points, its
/// pace, its gain and its rest.
export function reset(i) {
    const w = words[i];
    if (!w) return false;
    w.take = 0; w.head = 0; w.tail = 0; w.gap = null; w.pace = 1; w.gain = 1;
    moved();
    return true;
}

/// The rest after a word, in seconds. Set by hand it stays; null puts it back
/// to what the punctuation means.
export function gapOf(i) { const p = pieceOf(i); return p ? p.gap : 0; }
export function setGap(i, sec) {
    const w = words[i];
    if (!w) return 0;
    w.gap = sec === null ? null : Math.max(0, Math.min(5, Number(sec) || 0));
    moved();
    return w.gap;
}

/// The pace of a word, or of the line: how fast it is said, 1 as recorded.
/// Realised as its rate within `PITCH_NEAR` and as its gap beyond that.
export function paceOf(which) {
    const list = targets(which);
    return list.length ? list[0].pace : 1;
}

/// Set the pace of some words (`which`, indices) or of every word (nothing).
export function setPace(v, which) {
    const n = Math.min(PACE_MAX, Math.max(PACE_MIN, Number(v) || 1));
    for (const w of targets(which)) w.pace = n;
    moved();
    return n;
}

export function gainOf(i) { return words[i] ? words[i].gain : 1; }
export function setGain(v, which) {
    const n = Math.min(4, Math.max(0, Number(v)));
    if (!Number.isFinite(n)) return 1;
    for (const w of targets(which)) w.gain = n;
    moved();
    return n;
}

/// Bring some words to one level: each one's gain set so its loudest moment
/// matches the median over them. Read off the envelopes the ruler already
/// asked for; answers how many words were still unread, so the caller can say
/// so and ask again.
export function levelMatch(which) {
    const list = targets(which);
    const loud = [];
    let unread = 0;
    for (const w of list) {
        const p = pieceOf(words.indexOf(w));
        if (!p || !p.hit) continue;
        const wv = waves.wave(p.hit.vod.media, p.from, p.until, 32);
        if (!wv || wv.error) { unread++; continue; }
        let peak = 0;
        for (let k = 0; k < wv.rms.length; k++) if (wv.rms[k] > peak) peak = wv.rms[k];
        if (peak > 0) loud.push({ w, peak });
    }
    if (!loud.length) return unread;
    const sorted = loud.map((l) => l.peak).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const l of loud) l.w.gain = Math.min(4, Math.max(0.1, median / l.peak));
    moved();
    return unread;
}

function targets(which) {
    if (!which) return words;
    return which.map((i) => words[i]).filter(Boolean);
}

// ── the workspace ──────────────────────────────────────────────────────────

/// A version-tolerant read, which is the rule for everything in the workspace.
export function restore() {
    let blob = null;
    try { blob = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { blob = null; }
    // The version before this one kept a grid and the line typed into it.
    if (!blob) {
        try {
            const old = JSON.parse(localStorage.getItem('supercut.score') || 'null');
            if (old && typeof old.line === 'string') blob = { text: old.line, tempo: old.tempo, per: old.per, bar: old.bar, loose: old.loose };
        } catch (e) { /* nothing older either */ }
    }
    if (!blob || typeof blob !== 'object') return;
    const n = (v, lo, hi, dflt) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt; };
    tempo = n(blob.tempo, 20, 600, TEMPO);
    per = Math.round(n(blob.per, 1, 16, STEPS));
    bar = Math.round(n(blob.bar, 1, 16, BAR));
    onBeat = !!blob.onBeat;
    loose = !!blob.loose;
    restHold = blob.restHold === undefined ? true : !!blob.restHold;
    text = typeof blob.text === 'string' ? blob.text : '';
    words = [];
    if (Array.isArray(blob.words)) {
        for (const item of blob.words) {
            if (!item || typeof item !== 'object') continue;
            const phrase = String(item.phrase || '').trim();
            if (!phrase) continue;
            const w = fresh(phrase, ['', ',', '.', '¶'].indexOf(item.stop) >= 0 ? item.stop : '');
            w.take = Math.round(n(item.take, 0, 1e4, 0));
            w.head = n(item.head, -OFFSET_MAX, OFFSET_MAX, 0);
            w.tail = n(item.tail, -OFFSET_MAX, OFFSET_MAX, 0);
            w.gap = item.gap === null || item.gap === undefined ? null : n(item.gap, 0, 5, 0);
            w.pace = n(item.pace, PACE_MIN, PACE_MAX, 1);
            w.gain = n(item.gain, 0, 4, 1);
            words.push(w);
        }
    } else if (text) {
        setText(text, { all: true });
    }
    replan();
}

function remember() {
    try {
        localStorage.setItem(KEY, JSON.stringify({
            text, onBeat, tempo, per, bar, loose, restHold,
            words: words.map((w) => ({ phrase: w.phrase, stop: w.stop, take: w.take, head: w.head,
                                       tail: w.tail, gap: w.gap, pace: w.pace, gain: w.gain })),
        }));
    } catch (e) { /* no store; the line is still good for this session */ }
}
