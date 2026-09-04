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
//
// ── Which take, and what "clean" means ────────────────────────────────────
//
// A word said three thousand times has three thousand takes, and pressing
// *next* three thousand times is nobody's plan. The ranking is by how cleanly
// the take will cut: how near its span is to the length the word is
// *typically* said in (the median over its takes), the **quiet either side**
// of it in the recording — the transcript's previous word's end and next
// word's start (`before`/`after` on a hit, `ui/phrase.js`) — and, when
// quantising, how well it fills a whole number of steps. The length weighs
// more than the quiet, and the reason is what a transcript's span is: a word
// runs to the next token, so a word before a pause is the pause too — `the`
// before a breath is 4.8 s of somebody breathing, and read as quiet on both
// sides it was the cleanest take of eighteen thousand. Such a span is **cut at
// twice the typical length** (`LONG`) and the rest of it counted as the quiet
// after the word, which is what it was. Repeats of a word walk to a take not
// yet used on the line, because a word said four times by one clip is not a
// supercut.
//
// ── Where the beat is, is measured ────────────────────────────────────────
//
// A transcript's time is Parakeet's frame (0.08 s) and is where the token was
// emitted, not where the sound starts. So every take asked for has its onsets
// read in a short window (`bro.ffmpeg.marks`, one read at a time — brotensor's
// pool is a process-wide singleton) and its start moved to the transient
// nearest the word. The answer is kept **by take**, not on a clip: the ruler,
// the audition and the mix all read the same number, and a take cycled back
// to is not read again. The window leads by 0.6 s because the flux baseline is
// an EMA starting at zero — the first half-second of anything analysed carries
// marks that are not in it. An onset is a transient and is not "the word";
// what is claimed is that the piece moved to the loudest nearby change, within
// `TOLERANCE`.
//
// ── The line is not in the document ───────────────────────────────────────
//
// A `.fbro` holds the *edit*: inputs, clips, canvas, graph, output. The line
// is what produced one, the way a search box is what produced a clip somebody
// added — so it is a working preference in `localStorage`, and what ties it to
// the mix is a tag on each clip (`clip.word`, the word's id; `clip.rest`, the
// id of the word a rest follows) that lives only as long as the session.

import { project, projectFps, duration, makeGenerator, addClip, slipClip, setSpeed, changed }
    from '../ui/project.js';
import * as generators from '../ui/generator.js';
import * as library from '../ui/library.js';
import { bare } from '../ui/phrase.js';
import * as waves from './waves.js';

// ── the numbers ────────────────────────────────────────────────────────────

/// The quiet either side of a take past which it is as clean as it gets, in
/// seconds. Three hundred milliseconds is a breath; more buys nothing.
const QUIET_ENOUGH = 0.3;

/// The shortest a word may be cut to, in seconds. Below this it is a click.
const MIN_WORD = 0.05;

/// How many times its typical length a take may run before the cut stops at
/// that and the rest of the span is read as the pause after the word. Twice:
/// a word drawn out is longer than usual, and a word before a silence is that
/// silence long.
const LONG = 2;

/// How far a word may be sped up or slowed before its pitch is somebody else's
/// voice: a whole tone, either way. The pace slider can ask for more, and what
/// it gets past this is gaps closing rather than words changing — until the
/// sound can be stretched with its pitch kept, which is native work this file
/// does not have yet (see `PLAN-supercut-line.md`).
export const PITCH_NEAR = 1.12;

/// The range the pace slider offers.
export const PACE_MIN = 0.5;
export const PACE_MAX = 2.0;

/// How far a word may be stretched to fill a step when quantising, either
/// way, before it is cut to the step instead. A quarter: past that the pitch
/// is a different voice, and `the` — one transcript frame on a step of a
/// hundred and twenty-five — came out at two thirds speed on every line.
const STRETCH_NEAR_MIN = 0.8;
const STRETCH_NEAR_MAX = 1.25;

/// The tempo somebody types when they have not decided, and the grid under a
/// beat that puts both things people tap — one word a beat, four a beat — on
/// it without changing it.
const TEMPO = 120;
const STEPS = 4;
const BAR = 4;
export const GRIDS = [1, 2, 3, 4, 6, 8];

/// The window a take's onsets are looked for in, either side of the word's
/// transcript time. Small on purpose: a wide window finds the word before.
const TOLERANCE = 0.2;
/// How long before the word the analysed window starts. See the header.
const WARMUP = 0.6;

/// How long a word nothing says is drawn as, so the line can be read with the
/// hole in it. Not in the mix.
const HOLE = 0.25;

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

/// Has the line been put in the mix this session? What decides whether an
/// onset landing has a clip to move.
let committed = false;

const KEY = 'supercut.line';

let hooks = {};
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
///
/// Whitespace separates, `"` groups a phrase with a space in it, `[...]` is
/// dropped. The punctuation after a token is its `stop` — `,` `;` `:` a short
/// rest, `.` `?` a long one, a line break the longest — and comes off the
/// word; `!` stays on it, because to the corpus it means the word was shouted
/// (`ui/phrase.js`). A token is **complete** when something follows it: the
/// one being typed at the end of the line is not a word yet, so that a line
/// does not flash a hole for every word on the way to being spelt.
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
///
/// **A diff, not a rebuild**, because the line is edited as text: retyping a
/// sentence to change one word must not throw away six takes somebody chose.
/// The words are matched to the tokens by the longest common run, so a word
/// inserted, removed or changed in the middle costs that word alone.
///
/// Answers `{ landed }`: the indices of the words that are new and complete,
/// which is what the ruler plays. With `all`, the token being typed at the
/// end counts too — that is Enter.
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
    committed = false;
    said = '';
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

// ── resolving ──────────────────────────────────────────────────────────────

/// The plan: every word with the moment it will be cut from, and the rests
/// between, packed in play order — `{ pieces, missing, seconds }`.
///
/// A word piece carries `word` (its index), `hit`, `candidates` (every take,
/// ranked), `take`/`takes`, `from`/`until` (the cut, in the recording's own
/// seconds), `rate`, `gain`, `seconds` (how long it is in the line) and
/// `start`. A word nothing says is a `hole` of nominal length, so the line can
/// still be read, and is named in `missing`. A rest piece carries `after`, the
/// id of the word it follows, and `word`, that word's index.
export function resolve() {
    const pieces = [];
    const missing = [];
    const found = new Map();
    const used = new Map();
    const have = library.available() && !!library.current();
    const g = have ? library.naturalGap() : library.NATURAL_GAP;
    const stepSec = stepSeconds();
    let t = 0;

    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const p = {
            kind: 'word', word: i, id: w.id, phrase: w.phrase, hit: null, takes: 0, take: 0,
            candidates: [], rate: 1, gain: w.gain, pace: w.pace, start: t, seconds: 0,
            from: 0, until: 0, hole: false,
        };
        pieces.push(p);
        if (have) {
            if (!found.has(w.phrase)) found.set(w.phrase, library.searchWords(w.phrase, { loose }));
            const hits = found.get(w.phrase).filter((h) => h.vod.media);
            p.takes = hits.length;
            if (!hits.length) {
                if (missing.indexOf(w.phrase) < 0) missing.push(w.phrase);
            } else {
                p.typical = typicalOf(hits);
                p.candidates = candidatesFor(hits, p.typical, stepSec);
                const taken = used.get(w.phrase) || new Set();
                let n = -1;
                if (w.take > 0) {
                    if (w.take <= p.candidates.length) n = w.take - 1;
                    else p.why = `only ${p.candidates.length} take${p.candidates.length === 1 ? '' : 's'}`;
                } else {
                    n = p.candidates.findIndex((c) => !taken.has(c.said));
                    if (n < 0) n = taken.size % p.candidates.length;
                }
                if (n >= 0) {
                    const c = p.candidates[n];
                    taken.add(c.said);
                    used.set(w.phrase, taken);
                    p.hit = c.hit; p.take = n + 1; p.said = c.said; p.quiet = c.quiet;
                    p.natural = c.dur; p.score = c.score;
                    place(p, w, stepSec);
                }
            }
        }
        if (!p.hit) { p.hole = true; p.seconds = HOLE; }
        t += p.seconds;
        p.gap = gapFor(w, g, stepSec);
        if (p.gap > 0) {
            // `after` is the word's id, which is what its clip is tagged with;
            // `word` its index, which is what the ruler draws it beside.
            pieces.push({ kind: 'rest', after: w.id, word: i, start: t, seconds: p.gap,
                          steps: onBeat ? Math.round(p.gap / stepSec) : 0 });
            t += p.gap;
        }
    }
    return { pieces, missing, seconds: t };
}

/// The cut, the rate and the length of one word from its take.
function place(p, w, stepSec) {
    const h = p.hit;
    const onset = onsetOf(h.vod.media, h.at);
    // The onset moves the whole take — it is where the transcript's frame was
    // late — so the end goes with the start; the hand's cut points are the
    // two edges on their own.
    const from = Math.max(0, h.at + onset + w.head);
    let until = Math.max(from + MIN_WORD, h.at + onset + p.natural + w.tail);
    let rate = Math.min(PITCH_NEAR, Math.max(1 / PITCH_NEAR, w.pace));
    let seconds = (until - from) / rate;
    if (onBeat) {
        // Quantised: a whole number of steps, filled by a stretch when the
        // stretch is small and cut or padded when it is not.
        const steps = Math.max(1, Math.round(seconds / stepSec));
        const target = steps * stepSec;
        const ratio = seconds / target;
        if (ratio >= STRETCH_NEAR_MIN && ratio <= STRETCH_NEAR_MAX) rate = (until - from) / target;
        else until = from + target * rate;
        seconds = target;
        p.steps = steps;
        p.stretched = ratio >= STRETCH_NEAR_MIN && ratio <= STRETCH_NEAR_MAX;
    }
    p.from = from; p.until = until; p.rate = rate; p.seconds = seconds;
}

/// The rest after a word, in seconds: set by hand, or what its punctuation
/// means at this speaker's natural gap, at the word's pace; on a beat, whole
/// steps with a floor per kind of stop.
function gapFor(w, g, stepSec) {
    let sec;
    if (w.gap !== null && w.gap !== undefined) sec = w.gap;
    else if (w.stop === ',') sec = Math.max(0.25, 2.5 * g);
    else if (w.stop === '.') sec = Math.max(0.5, 5 * g);
    else if (w.stop === '¶') sec = Math.max(0.9, 8 * g);
    else sec = g;
    sec /= Math.max(PACE_MIN, w.pace);
    if (!onBeat) return sec;
    const floor = w.stop === ',' ? 1 : w.stop === '.' ? 2 : w.stop === '¶' ? 4 : 0;
    return Math.max(floor, Math.round(sec / stepSec)) * stepSec;
}

function durOf(h) { return Math.max(0.04, (h.to || (h.at + 0.2)) - h.at); }

/// The length a word is usually said in: the median over its takes.
function typicalOf(hits) {
    const d = hits.map(durOf).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
}

/// Every take of a word, ranked. See the header for the rule, and for why the
/// length is weighted over the quiet. `said` is the take's position in the
/// order it was said; `take` is its position in this list, which is what a pin
/// is; `dur` is the cut and `raw` the transcript's span.
function candidatesFor(hits, typical, stepSec) {
    const cap = Math.max(LONG * typical, typical + 0.16);
    const list = hits.map((h, idx) => {
        const raw = durOf(h);
        // A span well past the typical length is the word and the pause after
        // it, so the cut stops at the cap and the rest of the span is what it
        // was: quiet after the word.
        const dur = Math.min(raw, cap);
        const q0 = h.quiet || { before: 0, after: 0 };
        const quiet = { before: q0.before, after: raw > dur ? Math.max(q0.after, raw - dur) : q0.after };
        const q = Math.min(quiet.before, quiet.after);
        const clean = Math.min(QUIET_ENOUGH, Number.isFinite(q) ? q : QUIET_ENOUGH) / QUIET_ENOUGH;
        const usual = Math.exp(-2 * Math.abs(Math.log(raw / typical)));
        let score;
        if (onBeat) {
            const steps = Math.max(1, Math.round(dur / stepSec));
            const fit = 1 - Math.min(1, (2 * Math.abs(dur - steps * stepSec)) / stepSec);
            score = 0.3 * clean + 0.45 * usual + 0.25 * fit;
        } else {
            score = 0.35 * clean + 0.65 * usual;
        }
        return { said: idx + 1, hit: h, dur, raw, quiet, clean, score: Math.round(score * 100) };
    });
    list.sort((a, b) => b.score - a.score || a.said - b.said);
    return list.map((c, i) => ({ ...c, take: i + 1 }));
}

let planned = { pieces: [], missing: [], seconds: 0 };
let plannedOver = null;

/// What the line resolves to. **Re-resolved when the corpus under it has
/// moved** — a channel opened after the line was restored, a confinement
/// changed — because a plan is an answer about a corpus, and one kept across a
/// change of corpus reported every word of a restored line missing.
export function plan() {
    if (plannedOver !== corpusKey()) replan();
    return planned;
}

function corpusKey() {
    const c = library.current();
    return `${c ? c.channel : ''}|${library.chosen().join(',')}`;
}

export function pieceOf(i) {
    for (const p of plan().pieces) if (p.kind === 'word' && p.word === i) return p;
    return null;
}

export function replan() {
    planned = resolve();
    plannedOver = corpusKey();
    return planned;
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

// ── the mix ────────────────────────────────────────────────────────────────

/// The commit in flight: the recordings still opening.
let job = null;
/// What the line says about the mix, as one statement.
let said = '';

export function note() { return said; }
export function busy() { return !!job; }
export function isCommitted() { return committed; }

/// Put the line in the mix — see the header for why this is a press.
///
/// Every recording the line needs is opened first, because a probe is a thread
/// and the pieces have to go in the order they were typed rather than the
/// order the disk answers in. Answers whether the mix changed now; a commit
/// waiting on a probe is finished by `tick`.
export function commit() {
    if (job) return false;
    if (!library.available() || !library.current()) { said = 'no corpus'; return false; }
    const pieces = plan().pieces;
    const inputs = new Map();
    for (const p of pieces) {
        if (p.kind !== 'word' || !p.hit) continue;
        const path = p.hit.vod.media;
        if (!inputs.has(path)) inputs.set(path, hooks.openInput({ path, name: path }));
    }
    const pending = [...inputs.values()].filter((i) => i && !i.probe && !i.error);
    if (pending.length) {
        job = { inputs: pending, began: Date.now() };
        said = `opening ${pending.length} recording${pending.length === 1 ? '' : 's'}…`;
        return false;
    }
    return lay(pieces);
}

/// The clips the line owns, in play order.
export function mine() {
    return project.clips.filter((c) => c.track === 0 && (c.word || c.rest))
                        .sort((a, b) => a.start - b.start);
}

/// Reconcile the row with the pieces.
///
/// A word's clip is tagged with its id and with the take it was cut from
/// (`clip.laid`): the same take is **adjusted in place** — slipped by how far
/// its cut moved, its speed, length and gain set — and another take is another
/// clip standing where it stood, the cut behind the old one forgotten with it.
///
/// **A rest holds the shot.** It is the previous word's recording carried on
/// from where the word ended, muted — a clip the model already expresses and
/// the render already plays — so the speaker pauses on the screen, which with
/// takes ranked by the quiet around them is what they were doing. Black is the
/// other choice (`restHold` off), and the rest after a word nothing says.
///
/// The line's clips are one block of the row in line order, standing where the
/// first of them stood; a clip added from the Words tab keeps its place beside
/// them. The canvas is settled from the first piece with a picture, which is
/// `app.js`'s rule for the first clip of a mix.
function lay(pieces) {
    const before = mine();
    const byWord = new Map();
    const byRest = new Map();
    const blacks = [];
    for (const c of before) {
        if (c.word) byWord.set(c.word, c);
        else if (c.rest && c.generator) blacks.push(c);
        else if (c.rest) byRest.set(c.rest, c);
    }
    const keep = [];
    let replaced = false;
    let adjusted = false;
    const missing = [];
    let lastWord = null;

    for (const p of pieces) {
        if (p.kind === 'word') {
            lastWord = null;
            if (!p.hit) { if (!p.why && missing.indexOf(p.phrase) < 0) missing.push(p.phrase); continue; }
            const path = p.hit.vod.media;
            const held = byWord.get(p.id);
            byWord.delete(p.id);
            if (held && held.laid && held.laid.path === path && held.laid.hitAt === p.hit.at) {
                if (adjust(held, p.from, p.rate, p.seconds, p.gain)) adjusted = true;
                keep.push(held);
                lastWord = { piece: p, clip: held };
                continue;
            }
            if (held) { hooks.drop(held); replaced = true; }
            const clip = hooks.place({
                path, name: `${p.hit.vod.id} ${p.phrase}`,
                from: p.from, to: p.until, vod: p.hit.vod.id, title: p.hit.vod.title || '',
            });
            if (!clip) continue;
            clip.word = p.id;
            clip.laid = { path, at: p.from, hitAt: p.hit.at };
            if (p.rate !== 1) setSpeed(clip, p.rate);
            clip.volume = p.gain;
            keep.push(clip);
            lastWord = { piece: p, clip };
            replaced = true;
            continue;
        }
        // A rest.
        const prev = lastWord;
        const heldRest = byRest.get(p.after);
        byRest.delete(p.after);
        if (restHold && prev) {
            const path = prev.piece.hit.vod.media;
            const from = prev.piece.until;
            if (heldRest && heldRest.laid && heldRest.laid.path === path) {
                if (adjust(heldRest, from, 1, p.seconds, 1)) adjusted = true;
                keep.push(heldRest);
                continue;
            }
            if (heldRest) { hooks.drop(heldRest); replaced = true; }
            const clip = hooks.place({
                path, name: `${prev.piece.hit.vod.id} ·`, from, to: from + p.seconds,
                vod: prev.piece.hit.vod.id, title: prev.piece.hit.vod.title || '',
            });
            if (clip) {
                clip.rest = p.after;
                clip.muted = true;
                clip.laid = { path, at: from, hitAt: 0 };
                keep.push(clip);
                replaced = true;
            }
            continue;
        }
        if (heldRest) { hooks.drop(heldRest); replaced = true; }
        let c = blacks.shift();
        if (!c) { c = black(p.seconds); if (!c) continue; replaced = true; }
        else if (Math.abs(c.length - p.seconds) > 1e-6) {
            c.media = Math.max(c.media, p.seconds);
            c.length = p.seconds;
            adjusted = true;
        }
        c.rest = p.after;
        keep.push(c);
    }
    for (const c of byWord.values()) { hooks.drop(c); replaced = true; }
    for (const c of byRest.values()) { hooks.drop(c); replaced = true; }
    for (const c of blacks) { hooks.drop(c); replaced = true; }

    if (replaced || adjusted) order(keep);
    committed = true;
    said = keep.length ? `${keep.length} in the mix` : '';
    if (missing.length) said += `${said ? ' · ' : ''}nothing says ${missing.map((m) => `"${m}"`).join(', ')}`;
    if (replaced && hooks.edited) hooks.edited();
    else if (adjusted && hooks.changed) hooks.changed();
    return replaced || adjusted;
}

/// The same clip, brought to the piece: slipped to its cut, at its rate, its
/// length and its gain. Answers whether anything changed.
function adjust(clip, from, rate, seconds, gain) {
    let did = false;
    const by = from - clip.laid.at;
    if (Math.abs(by) > 1e-6) { slipClip(clip, by); clip.laid.at = from; did = true; }
    const room = Math.max(0, (clip.media - clip.inPoint) / rate);
    const length = Math.max(1 / Math.max(1, clip.fps || 25), Math.min(seconds, room));
    if (Math.abs(clip.speed - rate) > 1e-9 || Math.abs(clip.length - length) > 1e-6) {
        clip.speed = rate; clip.length = length; did = true;
    }
    if (Math.abs((clip.volume === undefined ? 1 : clip.volume) - gain) > 1e-6) { clip.volume = gain; did = true; }
    return did;
}

/// Put the line's clips in line order as one block of the row, where the
/// first of them stood, and pack everything.
function order(block) {
    const seq = project.clips.filter((c) => c.track === 0).sort((a, b) => a.start - b.start);
    const others = seq.filter((c) => block.indexOf(c) < 0);
    let at = 0;
    for (const c of seq) { if (block.indexOf(c) >= 0) break; if (others.indexOf(c) >= 0) at++; }
    const merged = others.slice(0, at).concat(block, others.slice(at));
    let t = 0;
    for (const c of merged) { c.start = t; t += c.length; }
    if (hooks.packed) hooks.packed();
}

/// A rest of black: a generator clip, because the sequence is packed and there
/// is nowhere for an absence to be. A build that cannot make one goes on
/// without it, saying so.
function black(seconds) {
    const spec = generators.makeSpec('color', {
        width: project.width || 1920, height: project.height || 1080, fps: projectFps(),
    });
    const settled = generators.settle(spec);
    if (!settled.ok) { said = `no rest: ${settled.why}`; return null; }
    const clip = makeGenerator(settled);
    clip.track = 0;
    clip.muted = true;
    clip.media = Math.max(seconds, clip.media);
    clip.length = seconds;
    clip.start = duration();
    addClip(clip);
    return clip;
}

// ── snapping to the sound ──────────────────────────────────────────────────

/// The onset delta of every take asked about, by `path@at`; `0` for one read
/// and found nothing. Kept for the session.
const onsets = new Map();
const queue = [];
let reading = null;

const onsetKey = (path, at) => `${path}@${at.toFixed(3)}`;

/// What is known about a take's attack, in seconds from the transcript's time.
/// Asking is what queues the read.
function onsetOf(path, at) {
    const key = onsetKey(path, at);
    const known = onsets.get(key);
    if (known !== undefined) return known;
    if (!queue.some((q) => q.key === key) && !(reading && reading.key === key))
        queue.push({ key, path, want: at });
    return 0;
}

export function snapping() { return queue.length + (reading ? 1 : 0); }

function startRead() {
    if (reading || !queue.length) return;
    const next = queue.shift();
    const ss = Math.max(0, next.want - WARMUP);
    try {
        next.read = bro.ffmpeg.marks.reads.start(
            { path: next.path, ss, t: (next.want - ss) + TOLERANCE },
            { onsets: true, tonal: false, sound: true });
        next.ss = ss;
        reading = next;
    } catch (e) {
        // A recording that will not open here keeps the transcript's timing.
        onsets.set(next.key, 0);
    }
}

/// Advance the commit and the onset reads. Answers true when something in the
/// mix or the plan moved. Synchronous and idempotent.
export function tick() {
    let moved = false;
    if (job) {
        const timedOut = (Date.now() - job.began) > 8000;
        if (timedOut || job.inputs.every((i) => !i || i.probe || i.error)) {
            const bad = job.inputs.filter((i) => !i || i.error || (!i.probe && timedOut));
            job = null;
            lay(plan().pieces);
            if (bad.length) said += ` · ${bad.length} would not open`;
            moved = true;
        }
    }
    if (reading) {
        let answer = null;
        try { answer = bro.ffmpeg.marks.reads.poll(reading.read); } catch (e) { answer = null; }
        if (!answer) { onsets.set(reading.key, 0); reading = null; }
        else if (answer.state !== 'reading') {
            const delta = answer.state === 'done' && answer.result ? measure(reading, answer.result) : 0;
            onsets.set(reading.key, delta);
            if (delta) { apply(reading, delta); moved = true; }
            reading = null;
        }
    }
    startRead();
    return moved;
}

/// The transient nearest the word, weighted by the sound gate and by how loud
/// a change each was; the consonant just before it kept. Answers the delta.
function measure(item, result) {
    const onsets_ = [];
    const runs = [];
    for (const m of (result && result.marks) || []) {
        if (m.kind === 'onset') onsets_.push(m);
        else if (m.kind === 'sound') runs.push(m);
    }
    const near = [];
    for (const s of runs) {
        const start = item.ss + s.at;
        const end = start + s.length;
        if (end >= item.want - 0.15 && start <= item.want + 0.35) near.push({ start, end });
    }
    const candidates = [];
    let maxFlux = 0.01;
    for (const m of onsets_) {
        const t = item.ss + m.at;
        const d = Math.abs(t - item.want);
        if (d > TOLERANCE) continue;
        const flux = Math.max(0, m.flux || 0);
        if (flux > maxFlux) maxFlux = flux;
        let inSound = !near.length;
        for (const sr of near) if (t >= sr.start - 0.04 && t <= sr.end) { inSound = true; break; }
        candidates.push({ t, d, flux, inSound });
    }
    if (!candidates.length) return 0;
    let best = candidates[0].t;
    let bestScore = -1;
    for (const c of candidates) {
        const score = (0.45 * (1 - c.d / TOLERANCE) + 0.55 * ((c.flux + 0.1) / (maxFlux + 0.1))) *
                      (c.inSound ? 1 : 0.35);
        if (score > bestScore) { bestScore = score; best = c.t; }
    }
    for (const sr of near) {
        if (sr.start < best && (best - sr.start) <= 0.12) {
            best = Math.max(item.ss, best - Math.min(0.06, best - sr.start));
            break;
        }
    }
    const delta = best - item.want;
    return Math.abs(delta) < 1e-4 ? 0 : delta;
}

/// A measurement landed: the plan reads it on its next resolve, and a clip
/// already in the mix of that take is slipped by it, in place. **A slip, so
/// the row does not move** — and nothing else about the mix is touched, because
/// a measurement is not an edit.
function apply(item, delta) {
    replan();
    if (!committed) return;
    let did = false;
    for (const c of mine()) {
        if (!c.word || !c.laid || c.laid.path !== item.path || Math.abs(c.laid.hitAt - item.want) > 1e-6) continue;
        slipClip(c, delta);
        c.laid.at += delta;
        did = true;
    }
    if (did) changed('edit');
}

/// Forget every outstanding read. Required rather than tidy: a terminal read
/// on this surface is handed over exactly once and one nobody polls again sits
/// in the table for the life of the process.
export function forget() {
    for (const q of queue) if (q.read) { try { bro.ffmpeg.marks.reads.forget(q.read); } catch (e) { /* gone */ } }
    queue.length = 0;
    if (reading) {
        try { bro.ffmpeg.marks.reads.forget(reading.read); } catch (e) { /* gone */ }
        reading = null;
    }
}
