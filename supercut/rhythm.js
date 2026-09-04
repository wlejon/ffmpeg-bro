// Words on a beat: a pattern laid on a grid, cut out of the corpus, packed into
// the mix.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// The rest of this application assembles a mix by *finding* — a hit, a listen, a
// press, and the moment goes on the end of the row. That is the right loop when
// the material decides the shape. It is the wrong loop entirely when the shape
// decides the material: "no no no no, on the beat" is a thing somebody can hear
// before they have found a single one of them, and building it by hand is
// twenty presses and then a trim per piece to a length nobody can hit by eye.
//
// So the shape is laid out and the finding is done for you. A **pattern** is a
// tempo, a grid, and words — each on a step and each some steps long; a
// **build** is that pattern turned into clips whose lengths are exact multiples
// of the step and whose in-points are the moments those words were said.
//
// ── A word is on a step, and a rest is where no word is ───────────────────
//
// The model is the grid's. `words` is a list of `{ phrase, at, steps }` sorted
// by `at`, where `at` is the step a word starts on and `steps` is how many it
// holds for. Nothing is written down for a rest: a rest is a step no word
// covers, which is what a step sequencer means by an empty cell and is why two
// words can never be on one step.
//
// The first version of this was a *notation* typed into a box —
// `what . the - hell . . -`, a dot to hold and a dash to rest — and it was a
// good notation and a bad control: a rhythm is a thing somebody taps out, and
// counting dots to move a word two steps later is arithmetic the grid does by
// being looked at. The notation survives as `parse` and `serialize`, because a
// line of text is still the quickest way for a suite — or a paste — to describe
// a pattern; nothing in the window draws it any more.
//
// **Which take a word is, how far it is slipped and whether it is stretched
// belong to the word**, on the word object, and not in a map keyed by position.
// A word moved two steps later is the same word with the same take, and a map
// keyed by index forgot that on every edit — which is also what made the
// notation's `hell#2` a dead end: retyping the line threw every choice away.
//
// ── A rest is a real clip, because a mix has no holes ─────────────────────
//
// `supercut/mix.js`'s one rule is that the sequence is packed: no gaps, no
// overlaps. A rest is therefore not an absence — there is nowhere for an absence
// to be — it is a **generator clip**, `color=c=black`, which this application
// already knows how to hold, play, render and write into a document because
// `ui/generator.js` and `makeGenerator` are the model's. A silence in a supercut
// is a picture of nothing for exactly one step, which is what a rest is.
//
// ── Cut to the step, or stretched into it, and the choice is the word's ───
//
// A word is longer or shorter than the step it is given, always. By default the
// piece is **cut to the step**: the clip is exactly `steps × step` seconds long,
// so a long word is cut off mid-syllable and a short one runs on into whatever
// followed it in the recording. A word can instead be **stretched**: its speed
// is set so its own span fills the step. That moves the pitch — audibly past
// about ±15%, and a supercut where every word is a different person is a
// supercut of nobody — which is why it is off by default and decided per word,
// and why a word that would need more than `STRETCH_MAX` or less than
// `STRETCH_MIN` is cut instead.
//
// **What the audition plays is exactly what the mix would hold**: the step's
// span at the piece's rate. An earlier version played the whole word at a rate
// the build never applied, which was a preview of a different mix.
//
// ── Where the beat actually is, which is the whole of "precisely" ─────────
//
// A transcript says a word began at `t`. That number is Parakeet's frame — 0.08 s
// — and the frame is where the *token* was emitted, not where the sound starts.
// At 120 bpm a sixteenth is 125 ms, so an error of one frame is most of a step:
// cutting at the transcript's own number gives a mix that is nearly on the beat
// and sounds like a mistake.
//
// The measurement that says where a sound *starts* is already in this binary and
// had no reader: `bro.ffmpeg.marks` is brosoundml's spectral-flux onset
// detector, native, on a thread (`src/native/sound_marks.h`). So after the clips
// are placed, each one asks for the onsets in a short window around its word and
// **slips** to the nearest one. Four things about that:
//
//   - It is a **slip and not a trim**, which is what makes it safe to do late: a
//     slip moves the footage inside a card whose length and position do not
//     change, so the grid is untouched whatever the answer is and a read that
//     never lands leaves a mix that is merely on the transcript's timing.
//   - The window **starts 0.6 s before the word**, and that is not padding. The
//     flux baseline is an EMA starting at zero with a ~0.5 s time constant, so
//     the first half-second of anything analysed carries marks that are not in
//     it — `docs/api.md` says so and refuses to filter them, because a warm-up
//     here would make this and `bro.sense.analyze()` disagree about one file. The
//     lead puts that half-second before the part being asked about.
//   - The offset is applied **relative**, so it composes with `supercut/cuts.js`:
//     a clip repointed at its cut mid-flight carries a slip through the same
//     subtraction, which is the property `adopt()` there already states.
//   - **An onset is a transient and is not "the word".** Nothing here decides
//     that the nearest transient is the word's own attack; what is claimed is
//     that the piece was moved to the loudest change nearby, and a `TOLERANCE`
//     it cannot exceed is what keeps that claim small. `sound_marks.h` names its
//     marks after the measurement for this reason and so does this.
//
// A word somebody has slipped by hand is not measured: the hand's number is
// the answer, and a read that moved it again would be the tool arguing.
//
// ── One read at a time, because brotensor says so ─────────────────────────
//
// The mel front-end reaches brotensor's CPU pool, which is a process-wide
// singleton that assumes it is not re-entered — `readSoundMarks` takes a lock
// for it. So sixteen reads started at once would be sixteen rows waiting on a
// mutex, and this queues them one deep exactly as `supercut/acquire.js` queues
// transcriptions and for the same reason.
//
// ── The pattern is not in the document ────────────────────────────────────
//
// A `.fbro` holds the *edit*: inputs, clips, canvas, graph, output. The pattern
// is what produced one, the way a search box is what produced a clip somebody
// added — and the mix outlives it in exactly the same way, because it is a mix
// like any other from the moment it exists. So the pattern is a working
// preference in `localStorage` beside the split height, and the artifact is the
// clips. Building again does not remember what it built last time and does not
// try to: it appends, and `Clear` on the mix is one press.

import { project, projectFps, duration, makeGenerator, addClip, slipClip, setSpeed, changed }
    from '../ui/project.js';
import * as generators from '../ui/generator.js';
import * as library from '../ui/library.js';

// ── the grid ───────────────────────────────────────────────────────────────

/// Beats a minute. 120 because it is the tempo somebody types when they have not
/// decided, and because a sixteenth of it is 125 ms — long enough to hear a word
/// in and short enough that four of them are a bar.
const TEMPO = 120;

/// Steps a beat. Four, so a step is a sixteenth and the two things people
/// actually tap — one word a beat, or four words a beat — are both on the grid
/// without changing it.
const STEPS = 4;

/// Beats a bar. Four, because it is what a bar is until somebody says otherwise.
const BAR = 4;

/// The grids offered: what a beat may be divided into. Six and eight are there
/// for a triplet feel at speed and for the one person who needs thirty-seconds;
/// anything finer is a step shorter than a syllable.
export const GRIDS = [1, 2, 3, 4, 6, 8];

/// How far a word may be stretched to fill its step, either way. Half speed and
/// double: past those a word is a sound effect, and the cut is the better lie.
export const STRETCH_MIN = 0.5;
export const STRETCH_MAX = 2.0;

/// How far a word may be slipped by hand, in seconds either way. Half a second
/// is the whole of the word before or after it.
export const OFFSET_MAX = 0.5;

/// The window a piece's onsets are looked for in, in seconds either side of the
/// word's transcript time. Small on purpose: this is a refinement of a number
/// that is nearly right, and a wide window would find the transient of the word
/// *before* and move the piece onto it.
const TOLERANCE = 0.2;

/// How long before the word the analysed window starts.
///
/// The flux EMA's warm-up, and the whole reason this is not simply `TOLERANCE`.
/// See the header.
const WARMUP = 0.6;

let tempo = TEMPO;
let per = STEPS;
let bar = BAR;
let loose = false;
let sortByFit = true;

/// The pattern: `{ phrase, at, steps, pin, offset, stretch }`, sorted by `at`,
/// never overlapping. See the header for why the rests are not in it. `words()`
/// is what everything outside reads, as copies.
let laid = [];

const KEY = 'supercut.score';

/// How long one step is, in seconds. The one home for the arithmetic — the
/// parse, the placement, the tab's own line and the suite all ask here.
export function stepSeconds() {
    return 60 / Math.max(1, tempo) / Math.max(1, per);
}

export function tempoOf() { return tempo; }
export function stepsPerBeat() { return per; }
export function beatsPerBar() { return bar; }
export function stepsPerBar() { return per * bar; }
export function looseOf() { return loose; }
export function sortByFitOf() { return sortByFit; }

export function setTempo(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) tempo = Math.min(600, Math.max(20, n));
    replan();
    remember();
}
export function setStepsPerBeat(v) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) per = Math.min(16, Math.max(1, n));
    replan();
    remember();
}
export function setBeatsPerBar(v) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) bar = Math.min(16, Math.max(1, n));
    replan();
    remember();
}
export function setLoose(on) { loose = !!on; replan(); remember(); }

/// Whether the takes of a word are offered best-fitting first, or in the order
/// they were said. A property of the whole pattern rather than of a word,
/// because it is a way of walking the corpus and not a choice about one piece.
export function setSortByFit(on) {
    const next = !!on;
    if (next === sortByFit) return;
    sortByFit = next;
    // A pin is a position in a list, and the list has just been reordered.
    for (const w of laid) w.pin = 0;
    replan();
    remember();
}

// ── the words ──────────────────────────────────────────────────────────────

/// The pattern, as copies. What the grid draws.
export function words() { return laid.map((w) => ({ ...w })); }

/// The step after the last word, which is how long the pattern is in steps.
export function lastStep() {
    let end = 0;
    for (const w of laid) end = Math.max(end, w.at + w.steps);
    return end;
}

/// Which word covers a step, or -1. The grid asks per cell.
export function wordAt(step) {
    for (let i = 0; i < laid.length; i++) {
        const w = laid[i];
        if (step >= w.at && step < w.at + w.steps) return i;
    }
    return -1;
}

/// Where a step is, the way a musician counts it: bar, beat and step within the
/// beat, all from one.
export function whereIs(step) {
    const s = Math.max(0, Math.round(step));
    return {
        bar: Math.floor(s / (per * bar)) + 1,
        beat: Math.floor((s % (per * bar)) / per) + 1,
        step: (s % per) + 1,
    };
}

function fresh(phrase, at, steps) {
    return { phrase: String(phrase), at, steps, pin: 0, offset: 0, stretch: false };
}

/// Keep the list sorted and answer where one word ended up in it.
function settle(w) {
    laid.sort((a, b) => a.at - b.at);
    replan();
    remember();
    return laid.indexOf(w);
}

/// Is a span free of every word but `except`?
function free(at, steps, except) {
    if (at < 0) return false;
    for (const w of laid) {
        if (w === except) continue;
        if (at < w.at + w.steps && w.at < at + steps) return false;
    }
    return true;
}

/// Put a word on a step. Answers its index, or -1 for a step something is on.
///
/// One step long, always: a length is a drag on the grid, and a word that
/// arrived at some other length would be a guess about the rhythm nobody typed.
export function putWord(at, phrase) {
    const p = String(phrase || '').trim();
    const s = Math.max(0, Math.round(Number(at) || 0));
    if (!p) return -1;
    const on = wordAt(s);
    if (on >= 0) {
        // Typed onto the first step of a word: that word, renamed. Anywhere
        // else inside one is refused — the cell is not empty.
        if (laid[on].at !== s) return -1;
        setPhrase(on, p);
        return on;
    }
    const w = fresh(p, s, 1);
    laid.push(w);
    return settle(w);
}

/// Rename a word. The take is dropped with the old phrase, because it was a
/// position in a list of moments *that* word was said at.
export function setPhrase(i, phrase) {
    const w = laid[i];
    const p = String(phrase || '').trim();
    if (!w || !p) return false;
    if (w.phrase !== p) { w.phrase = p; w.pin = 0; }
    replan();
    remember();
    return true;
}

/// How many steps a word holds for. Clamped to at least one and to the step
/// before the next word, so a hold can never run over a neighbour. Answers the
/// length it ended up with.
export function setSteps(i, steps) {
    const w = laid[i];
    if (!w) return 0;
    let n = Math.max(1, Math.round(Number(steps) || 1));
    for (const o of laid) if (o !== w && o.at >= w.at + 1) n = Math.min(n, o.at - w.at);
    if (n !== w.steps) { w.steps = n; replan(); remember(); }
    return w.steps;
}

/// Move a word to another step. Answers its new index, or -1 when the span it
/// would take is not free — in which case nothing moved, which is what lets a
/// drag be answered per pixel and refused per pixel.
export function moveWord(i, at) {
    const w = laid[i];
    const s = Math.round(Number(at));
    if (!w || !Number.isFinite(s)) return -1;
    if (s === w.at) return i;
    if (!free(s, w.steps, w)) return -1;
    w.at = s;
    return settle(w);
}

export function removeWord(i) {
    if (!laid[i]) return false;
    laid.splice(i, 1);
    replan();
    remember();
    return true;
}

export function clearWords() {
    laid = [];
    replan();
    remember();
}

// ── what belongs to a word ─────────────────────────────────────────────────

/// The take pinned on a word, one-based, or 0 when it walks the takes.
export function takeOf(i) { return laid[i] ? laid[i].pin : 0; }

export function setTake(i, take) {
    const w = laid[i];
    if (!w) return 0;
    w.pin = Math.max(1, Math.round(Number(take) || 1));
    replan();
    remember();
    return w.pin;
}

/// The next take, or the one before. Wraps, so pressing on is never a dead end.
export function cycleTake(i, delta = 1) {
    const p = pieceOf(i);
    if (!p || !p.takes) return 0;
    const cur = laid[i].pin || p.take || 1;
    const next = ((cur - 1 + delta) % p.takes + p.takes) % p.takes + 1;
    return setTake(i, next);
}

export function offsetOf(i) { return laid[i] ? laid[i].offset : 0; }

/// Slip a word's in-point by hand, in seconds. Clamped; answers the offset set.
export function setOffset(i, sec) {
    const w = laid[i];
    if (!w) return 0;
    const v = Number(sec) || 0;
    w.offset = Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, v));
    if (Math.abs(w.offset) < 1e-6) w.offset = 0;
    replan();
    remember();
    return w.offset;
}

export function nudgeOffset(i, deltaSec) {
    return setOffset(i, offsetOf(i) + (Number(deltaSec) || 0));
}

export function stretchOf(i) { return laid[i] ? !!laid[i].stretch : false; }

export function setStretch(i, on) {
    const w = laid[i];
    if (!w) return false;
    w.stretch = !!on;
    replan();
    remember();
    return w.stretch;
}

// ── the notation ───────────────────────────────────────────────────────────

/// Split a line into tokens, keeping a quoted phrase whole and dropping
/// bracketed text. Whitespace separates, `"` groups, and a line break is
/// whitespace like any other.
function tokensOf(src) {
    const out = [];
    const re = /"([^"]*)"|\[([^\]]*)\]|(\S+)/g;
    let m;
    while ((m = re.exec(String(src || '')))) {
        if (m[1] !== undefined) out.push({ text: m[1], quoted: true });
        else if (m[2] !== undefined) continue;
        else out.push({ text: m[3], quoted: false });
    }
    return out;
}

/// A pattern from a line of notation.
///
/// A token is one step: a word starts a piece, `.` holds the piece before it a
/// step longer, `-` rests, `"you cross"` is a phrase with a space in it, and
/// `hell#2` pins the second take. A hold with nothing before it is a rest, and
/// `[...]` is ignored — an older version used it for tempo changes inside a
/// score, which a grid with one tempo has no place for.
export function parse(src) {
    const out = [];
    let at = 0;
    for (const tok of tokensOf(src)) {
        const t = tok.text;
        if (!tok.quoted && (t === '.' || t === '..')) {
            const last = out[out.length - 1];
            if (last && last.at + last.steps === at) last.steps++;
            at++;
            continue;
        }
        if (!tok.quoted && (t === '-' || t === '_')) { at++; continue; }
        let phrase = t;
        let pin = 0;
        const pinned = /^(.*[^#])#(\d+)$/.exec(t);
        if (!tok.quoted && pinned) { phrase = pinned[1]; pin = +pinned[2]; }
        const w = fresh(phrase, at, 1);
        w.pin = pin;
        out.push(w);
        at++;
    }
    return out;
}

/// The same line back. Not a bar structure — spaces between tokens, and that is
/// all — because what reads it is the parse above and not a person.
export function serialize(list = laid) {
    const out = [];
    let at = 0;
    for (const w of list) {
        while (at < w.at) { out.push('-'); at++; }
        const phrase = /\s/.test(w.phrase) ? `"${w.phrase}"` : w.phrase;
        out.push(w.pin > 0 && !/\s/.test(w.phrase) ? `${phrase}#${w.pin}` : phrase);
        for (let k = 1; k < w.steps; k++) out.push('.');
        at = w.at + w.steps;
    }
    return out.join(' ');
}

export function score() { return serialize(); }

/// Replace the pattern with what a line of notation says.
export function setScore(t) {
    laid = parse(t);
    replan();
    remember();
}

// ── the workspace ──────────────────────────────────────────────────────────

/// Read back what was last laid out.
///
/// **A version-tolerant read**, which is the rule for everything in the
/// workspace: what is in there was written by an earlier version of this code
/// and every field is sanitised — a tempo of `"fast"` or of `1e9` is the default
/// rather than a grid nothing can be placed on, a word off the grid or on top of
/// another is dropped, and a blob holding the notation the previous version
/// wrote is parsed rather than lost.
export function restore() {
    let blob = null;
    try { blob = JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch (e) { blob = null; }
    if (!blob || typeof blob !== 'object') return;
    const n = (v, lo, hi, dflt) => {
        const x = Number(v);
        return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
    };
    tempo = n(blob.tempo, 20, 600, TEMPO);
    per = Math.round(n(blob.per, 1, 16, STEPS));
    bar = Math.round(n(blob.bar, 1, 16, BAR));
    loose = !!blob.loose;
    sortByFit = blob.sortByFit === undefined ? true : !!blob.sortByFit;
    laid = [];
    if (Array.isArray(blob.words)) {
        for (const item of blob.words) {
            if (!item || typeof item !== 'object') continue;
            const phrase = String(item.phrase || '').trim();
            const at = Math.round(n(item.at, 0, 1e6, -1));
            const steps = Math.round(n(item.steps, 1, 1e4, 1));
            if (!phrase || at < 0 || !free(at, steps, null)) continue;
            const w = fresh(phrase, at, steps);
            w.pin = Math.round(n(item.pin, 0, 1e4, 0));
            w.offset = n(item.offset, -OFFSET_MAX, OFFSET_MAX, 0);
            w.stretch = !!item.stretch;
            laid.push(w);
        }
        laid.sort((a, b) => a.at - b.at);
    } else if (typeof blob.text === 'string') {
        laid = parse(blob.text);
    }
    replan();
}

function remember() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ tempo, per, bar, loose, sortByFit, words: laid }));
    } catch (e) { /* no store; the pattern is still good for this session */ }
}

// ── resolving ──────────────────────────────────────────────────────────────

/// The plan: every piece with the moment it will be cut from, or the reason it
/// cannot be.
///
/// Answers `{ pieces, missing, steps, seconds }`: the pattern as a packed list
/// of words and rests in the order they play — `pieces` — and `missing`, the
/// phrases nothing said, which is what a refusal names. A word piece carries
/// `word`, its index in the pattern, which is how the grid and the plan agree
/// about which is which.
///
/// **Repeats take a different moment each time.** `no no no no` off one hit four
/// times is one clip repeated, which is not what anybody means by it and is
/// what a loop pedal is for; four takes of the same word is the thing this
/// exists to make. So each phrase carries a cursor and walks its own hits,
/// wrapping when it runs out — a phrase said twice and typed five times is
/// takes 1, 2, 1, 2, 1, which is honest and is better than four copies of one.
///
/// The hits themselves are `ui/library.js`'s, spaced by its rule and confined to
/// whatever the finder is confined to. **Nothing about what counts as an
/// instance is decided here**, which is the rule this repository has already paid
/// for breaking once.
export function resolve() {
    const pieces = [];
    const found = new Map();     // phrase (as typed) → hits
    const cursor = new Map();
    const missing = [];
    const stepSec = stepSeconds();
    // A corpus with no channel open yet is not a corpus that says nothing: the
    // words are unresolved rather than missing, and `plan` asks again once one
    // is open.
    const have = library.available() && !!library.current();
    let at = 0;

    for (let i = 0; i < laid.length; i++) {
        const w = laid[i];
        if (w.at > at) {
            const n = w.at - at;
            pieces.push({ kind: 'rest', word: -1, phrase: '', from: at, steps: n,
                          seconds: n * stepSec });
        }
        const p = {
            kind: 'word', word: i, phrase: w.phrase, from: w.at, steps: w.steps,
            seconds: w.steps * stepSec, offset: w.offset, stretch: w.stretch,
            hit: null, takes: 0, take: 0, rate: 1, span: w.steps * stepSec,
        };
        pieces.push(p);
        at = w.at + w.steps;
        if (!have) continue;

        if (!found.has(w.phrase))
            found.set(w.phrase, library.searchWords(w.phrase, { loose }));
        const hits = found.get(w.phrase);
        p.takes = hits.length;
        if (!hits.length) {
            if (missing.indexOf(w.phrase) < 0) missing.push(w.phrase);
            continue;
        }

        // Every take, rated against the step it is being asked to fill: how
        // far the word's own length is from the piece's. The rating is what
        // `sortByFit` orders by and what the badge says.
        const candidates = hits.map((h, idx) => {
            const dur = Math.max(0.04, (h.to || (h.at + 0.2)) - h.at);
            const ratio = dur / Math.max(0.01, p.seconds);
            const score = Math.max(0, Math.min(100, Math.round((1 - 1.6 * Math.abs(1 - ratio)) * 100)));
            return { said: idx + 1, hit: h, dur, ratio, score };
        });
        if (sortByFit) candidates.sort((a, b) => b.score - a.score || a.said - b.said);
        p.candidates = candidates.map((c, idx) => ({ ...c, take: idx + 1 }));

        let n;
        if (w.pin > 0) {
            // A pin past the end is not silently wrapped: somebody who pinned
            // take 7 was looking at a list, and giving them take 1 instead
            // would be the tool answering a different question without saying so.
            if (w.pin > p.candidates.length) {
                p.why = `only ${p.candidates.length} take${p.candidates.length === 1 ? '' : 's'}`;
                continue;
            }
            n = w.pin - 1;
        } else {
            n = (cursor.get(w.phrase) || 0) % p.candidates.length;
            cursor.set(w.phrase, n + 1);
        }
        const chosen = p.candidates[n];
        p.hit = chosen.hit;
        p.take = chosen.take;
        p.said = chosen.said;
        p.fitRatio = chosen.ratio;
        p.fitScore = chosen.score;
        p.naturalDur = chosen.dur;
        p.at = Math.max(0, chosen.hit.at + w.offset);
        // Stretched: the word's own span fills the step, at the speed that
        // makes it. Outside the range it is cut like any other, and `canStretch`
        // is what the control reads to say so.
        p.canStretch = chosen.ratio >= STRETCH_MIN && chosen.ratio <= STRETCH_MAX;
        p.rate = w.stretch && p.canStretch ? chosen.ratio : 1;
        p.span = p.seconds * p.rate;
    }
    return { pieces, missing, steps: at, seconds: at * stepSec };
}

/// The last plan, for the tab to draw. Recomputed when the pattern changes
/// rather than on every frame: a resolve is a search of the whole corpus per
/// distinct word, which is milliseconds and is not free.
let planned = { pieces: [], missing: [], steps: 0, seconds: 0 };
/// What the pattern would build.
///
/// **Re-resolved when the corpus under it has moved** — a channel opened after
/// the pattern was restored, another picked since, a confinement changed —
/// because a plan is an answer about a corpus, and one kept across a change of
/// corpus was the bug that reported every word of a restored pattern missing:
/// it had been resolved on the first frame, against no channel at all, and
/// nothing ever asked again. What the plan was made over is written down with
/// it, and a plan over something else is made again on the read.
export function plan() {
    if (plannedOver !== corpusKey()) replan();
    return planned;
}

/// The corpus a plan is an answer about: the channel and the recordings a
/// search is confined to. Cheap enough to ask on every read.
function corpusKey() {
    const c = library.current();
    return `${c ? c.channel : ''}|${library.chosen().join(',')}`;
}
let plannedOver = null;

/// The plan's piece for a word of the pattern, or null.
export function pieceOf(i) {
    for (const p of plan().pieces) if (p.kind === 'word' && p.word === i) return p;
    return null;
}

/// Work out what the pattern would build, and answer it.
export function replan() {
    planned = resolve();
    plannedOver = corpusKey();
    return planned;
}

// ── building ───────────────────────────────────────────────────────────────

let hooks = {};
/// The build in flight: the pieces still waiting for their inputs to open.
let job = null;
/// What is being said about the build, as one line. A statement.
let said = '';

export function initRhythm(h) {
    hooks = h || {};
    restore();
}

/// What the tab says about the build. '' when nothing is happening.
export function note() { return said; }

/// Is a build waiting on anything? The press that started it is not repeatable.
export function busy() { return !!job; }

/// Turn the pattern into clips — the whole of it, or one word of it.
///
/// Answers '' when it started and a sentence when it refused.
///
/// **It refuses rather than approximating**, which is `ui/graph/derive.js`'s rule
/// in another place: a build that quietly left out the two words nothing said
/// would produce a rhythm with two holes in it and nothing on the screen saying
/// which. Every missing word is named at once, because fixing them one press at
/// a time is the version of this nobody would use twice.
///
/// **The press returns.** Opening a recording is a probe on a thread and a
/// six-hour file takes a moment, so the build is a job the frame loop finishes:
/// the inputs are asked for here and the clips are laid when every one of them
/// has answered. They are laid **all at once, in pattern order** — not one per
/// probe as it lands — because the order of a mix is the order of the words and
/// probes land in whatever order the disk feels like.
///
/// `only` is one word's index: that piece alone, with no rests, which is what
/// somebody does when one take is right and the rest of the pattern is not.
export function build(only) {
    if (job) return 'still building';
    if (!library.available()) return 'no corpus to build from';

    const got = replan();
    let pieces = got.pieces;
    if (only !== undefined && only !== null)
        pieces = pieces.filter((p) => p.kind === 'word' && p.word === only);
    if (!pieces.length) return 'nothing on the grid';

    const missing = [];
    for (const p of pieces)
        if (p.kind === 'word' && !p.hit && !p.why && missing.indexOf(p.phrase) < 0)
            missing.push(p.phrase);
    if (missing.length)
        return `nothing says ${missing.map((w) => `"${w}"`).join(', ')}`;
    const pinned = pieces.filter((p) => p.kind === 'word' && !p.hit && p.why);
    if (pinned.length)
        return pinned.map((p) => `"${p.phrase}" — ${p.why}`).join(' · ');
    const noMedia = pieces.filter((p) => p.kind === 'word' && p.hit && !p.hit.vod.media);
    if (noMedia.length)
        return `${noMedia.length} of those are in recordings that are not on disk`;

    // One input per distinct recording, asked for now so the opens overlap.
    const paths = [];
    for (const p of pieces)
        if (p.kind === 'word' && paths.indexOf(p.hit.vod.media) < 0)
            paths.push(p.hit.vod.media);
    const inputs = paths.map((path) => hooks.openInput({ path, name: path }));

    job = { pieces, inputs, began: Date.now() };
    said = `building ${pieces.length} piece${pieces.length === 1 ? '' : 's'}…`;
    return '';
}

/// Every input the build is waiting on has answered — lay the whole pattern.
///
/// The canvas is settled from the first piece that has a picture, which is
/// `app.js`'s rule for the first clip of a mix and is stated there; a pattern
/// that begins with a rest would otherwise size the project from a `color`
/// filter this file chose the dimensions of.
function lay() {
    let laid = 0;
    for (const p of job.pieces) {
        if (p.kind === 'rest') {
            if (rest(p.seconds)) laid++;
            continue;
        }
        // **The in-point is the word's own start and nothing is subtracted from
        // it.** `library.asClip` pads a single word by `WORD_PAD` because a word
        // taken to its edge arrives half said — which is right when the moment
        // is what matters and is exactly wrong here, where the beat *is* the
        // word's start. The pad the cut takes either side is `cuts.js`'s and is
        // material, not in-point. The span is the step's at the piece's rate,
        // so a stretched word brings the footage its speed will fit.
        const clip = hooks.place({
            path: p.hit.vod.media,
            name: `${p.hit.vod.id} ${p.phrase}`,
            from: p.at,
            to: p.at + p.span,
            vod: p.hit.vod.id,
            title: p.hit.vod.title || '',
        });
        if (!clip) continue;
        laid++;
        if (p.rate !== 1) {
            // The speed that makes the span fill the step. `setSpeed` keeps the
            // source span and works the length out from it, which lands on
            // exactly `seconds`; the pack afterwards is for the clips behind.
            setSpeed(clip, p.rate);
            if (hooks.packed) hooks.packed();
        }
        // The onset read for this piece, queued rather than started: one runs at
        // a time process-wide. A word slipped by hand is not measured — see the
        // header.
        if (!p.offset) {
            queue.push({ clip: clip.id, path: p.hit.vod.media, want: p.at,
                         read: 0, phrase: p.phrase });
        }
    }
    job = null;
    said = `${laid} piece${laid === 1 ? '' : 's'} on the grid`;
    if (hooks.edited) hooks.edited();
    return laid;
}

/// One step of black.
///
/// A generator clip, for the reason in the header: the sequence is packed and
/// there is nowhere for an absence to be. `color` at the project's own size and
/// rate, so a rest is the same shape of picture as everything around it and the
/// render has nothing to reconcile.
///
/// **A build that cannot make one goes on without it**, saying so — a filter
/// this build does not have is a real possibility (`whyNotAClip` refuses by
/// name) and losing the whole pattern to a missing `color` would be worse than a
/// mix that is short a silence.
function rest(seconds) {
    const spec = generators.makeSpec('color', {
        width: project.width || 1920,
        height: project.height || 1080,
        fps: projectFps(),
    });
    const settled = generators.settle(spec);
    if (!settled.ok) { said = `no rest: ${settled.why}`; return false; }
    const clip = makeGenerator(settled);
    clip.track = 0;
    clip.muted = true;
    // A generator has no length of its own — `media` is the edit's number, which
    // is what `makeGenerator` says at length — so it is set to what is being
    // asked for rather than trimmed down to it.
    clip.media = Math.max(seconds, clip.media);
    clip.length = seconds;
    clip.start = duration();
    addClip(clip);
    if (hooks.packed) hooks.packed();
    return true;
}

// ── snapping to the sound ──────────────────────────────────────────────────

/// Pieces waiting for their onsets, and the one read in flight.
const queue = [];
let reading = null;

/// How many pieces are still to be measured, for the line that says so.
export function snapping() { return queue.length + (reading ? 1 : 0); }

/// Start the next onset read, if there is room.
///
/// One at a time — see the header. The window is `[want - WARMUP, want +
/// TOLERANCE]`, so the flux baseline warms up on material before the word rather
/// than on the word itself.
function startRead() {
    if (reading || !queue.length) return false;
    const next = queue.shift();
    const clip = project.clips.find((c) => c.id === next.clip);
    // Removed while the queue waited: a piece somebody deleted is not measured,
    // and the read that would have been started is the cheapest one to not do.
    if (!clip) return true;
    const ss = Math.max(0, next.want - WARMUP);
    try {
        next.read = bro.ffmpeg.marks.reads.start(
            { path: next.path, ss, t: (next.want - ss) + TOLERANCE },
            // Onsets and sound runs (the energy gate). A run of sound gates the
            // onsets so that a word's own attack is preferred over a transient
            // in the room around it.
            { onsets: true, tonal: false, sound: true });
        next.ss = ss;
        reading = next;
    } catch (e) {
        // A recording that will not open here is one the clip is already playing
        // from, so there is nothing to report and nothing to mend: the piece
        // keeps the transcript's timing.
        return true;
    }
    return true;
}

/// Advance the build and the onset reads. Answers true when a piece moved.
///
/// Synchronous and idempotent, the shape every poll in this application has.
export function tick() {
    let moved = false;

    if (job) {
        // Still opening. An input that refused is not a reason to lose the
        // pattern — the piece is laid against a file that will not play, which
        // is visible — so what is waited for is an *answer*, either way.
        const timedOut = (Date.now() - job.began) > 8000;
        if (timedOut || job.inputs.every((i) => !i || i.probe || i.error)) {
            const bad = job.inputs.filter((i) => !i || i.error || (!i.probe && timedOut));
            lay();
            if (bad.length) said += ` · ${bad.length} would not open`;
            moved = true;
        }
    }

    if (reading) {
        let answer = null;
        try { answer = bro.ffmpeg.marks.reads.poll(reading.read); }
        catch (e) { answer = null; }
        if (!answer) { reading = null; }
        else if (answer.state !== 'reading') {
            if (answer.state === 'done' && answer.result) {
                if (apply(reading, answer.result)) moved = true;
            }
            reading = null;
        }
    }
    // Starting the next read is not itself a change worth a redraw — nothing on
    // the screen moved — so its answer is deliberately dropped.
    startRead();

    return moved;
}

/// Move one piece onto the transient nearest its word, weighted by the sound
/// gate and by how loud a change each transient was.
///
/// **A slip, so the grid does not move** — see the header. Answers whether it
/// moved anything, which is the difference between a redraw and a frame spent
/// on nothing.
function apply(item, result) {
    const clip = project.clips.find((c) => c.id === item.clip);
    if (!clip) return false;

    const onsets = [];
    const runs = [];
    for (const m of (result && result.marks) || []) {
        if (m.kind === 'onset') onsets.push(m);
        else if (m.kind === 'sound') runs.push(m);
    }

    // The runs of sound near the word: what the gate is.
    const near = [];
    for (const s of runs) {
        const start = item.ss + s.at;
        const end = start + s.length;
        if (end >= item.want - 0.15 && start <= item.want + 0.35) near.push({ start, end });
    }

    const candidates = [];
    let maxFlux = 0.01;
    for (const m of onsets) {
        const t = item.ss + m.at;
        const d = Math.abs(t - item.want);
        if (d > TOLERANCE) continue;
        const flux = Math.max(0, m.flux || 0);
        if (flux > maxFlux) maxFlux = flux;
        let inSound = !near.length;
        for (const sr of near) {
            if (t >= sr.start - 0.04 && t <= sr.end) { inSound = true; break; }
        }
        candidates.push({ t, d, flux, inSound });
    }
    if (!candidates.length) return false;

    let best = candidates[0].t;
    let bestScore = -1;
    for (const c of candidates) {
        const sDist = 1 - (c.d / TOLERANCE);
        const sFlux = (c.flux + 0.1) / (maxFlux + 0.1);
        const sSound = c.inSound ? 1 : 0.35;
        const score = (0.45 * sDist + 0.55 * sFlux) * sSound;
        if (score > bestScore) { bestScore = score; best = c.t; }
    }

    // Keep the consonant: sound that began just before the transient is the
    // fricative or the pre-voicing of the word, so up to 60 ms of it is kept
    // rather than cut off at the loudest change.
    for (const sr of near) {
        if (sr.start < best && (best - sr.start) <= 0.12) {
            best = Math.max(item.ss, best - Math.min(0.06, best - sr.start));
            break;
        }
    }

    const delta = best - item.want;
    if (Math.abs(delta) < 1e-4) return false;
    slipClip(clip, delta);
    changed('edit');
    return true;
}

/// Forget every outstanding read.
///
/// **`forget` rather than `cancel`**, and required rather than tidy: a terminal
/// read on this surface is handed over exactly once and one nobody polls again
/// sits in the table for the life of the process. Called when the mix is
/// cleared, because a piece that has gone is a piece whose onsets nothing will
/// ever apply.
export function forget() {
    for (const q of queue) if (q.read) { try { bro.ffmpeg.marks.reads.forget(q.read); } catch (e) { /* gone */ } }
    queue.length = 0;
    if (reading) {
        try { bro.ffmpeg.marks.reads.forget(reading.read); } catch (e) { /* gone */ }
        reading = null;
    }
}
