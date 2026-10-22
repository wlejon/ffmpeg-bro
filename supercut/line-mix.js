// Resolving words to corpus takes, laying the line into the mix, and snapping
// take cut points to measured audio onsets.

import { project, projectFps, duration, makeGenerator, addClip, slipClip, setSpeed, changed }
    from '../ui/project.js';
import * as generators from '../ui/generator.js';
import * as library from '../ui/library.js';

const QUIET_ENOUGH = 0.3;
const MIN_WORD = 0.05;
const LONG = 2;
export const PITCH_NEAR = 1.12;
export const PACE_MIN = 0.5;
export const PACE_MAX = 2.0;
const STRETCH_NEAR_MIN = 0.8;
const STRETCH_NEAR_MAX = 1.25;
const TOLERANCE = 0.2;
const WARMUP = 0.6;
const HOLE = 0.25;

let state = null;
export function bindLineState(s) { state = s; }

// ── resolving ──────────────────────────────────────────────────────────────

/// The plan: every word with the moment it will be cut from, and the rests
/// between, packed in play order — `{ pieces, missing, seconds }`.
export function resolve() {
    const words = state.words();
    const loose = state.loose();
    const onBeat = state.onBeat();
    const stepSec = state.stepSeconds();
    const pieces = [];
    const missing = [];
    const found = new Map();
    const used = new Map();
    const have = library.available() && !!library.current();
    const g = have ? library.naturalGap() : library.NATURAL_GAP;
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
                p.candidates = candidatesFor(hits, p.typical, stepSec, onBeat);
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
                    place(p, w, stepSec, onBeat);
                }
            }
        }
        if (!p.hit) { p.hole = true; p.seconds = HOLE; }
        t += p.seconds;
        p.gap = gapFor(w, g, stepSec, onBeat);
        if (p.gap > 0) {
            pieces.push({ kind: 'rest', after: w.id, word: i, start: t, seconds: p.gap,
                          steps: onBeat ? Math.round(p.gap / stepSec) : 0 });
            t += p.gap;
        }
    }
    return { pieces, missing, seconds: t };
}

function place(p, w, stepSec, onBeat) {
    const h = p.hit;
    const onset = onsetOf(h.vod.media, h.at);
    const from = Math.max(0, h.at + onset + w.head);
    let until = Math.max(from + MIN_WORD, h.at + onset + p.natural + w.tail);
    let rate = Math.min(PITCH_NEAR, Math.max(1 / PITCH_NEAR, w.pace));
    let seconds = (until - from) / rate;
    if (onBeat) {
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

function gapFor(w, g, stepSec, onBeat) {
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

function typicalOf(hits) {
    const d = hits.map(durOf).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
}

function candidatesFor(hits, typical, stepSec, onBeat) {
    const cap = Math.max(LONG * typical, typical + 0.16);
    const list = hits.map((h, idx) => {
        const raw = durOf(h);
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

// ── the mix ────────────────────────────────────────────────────────────────

let job = null;
let said = '';
let committed = false;

export function note() { return said; }
export function busy() { return !!job; }
export function isCommitted() { return committed; }
export function resetMixState() {
    committed = false;
    said = '';
}

export function commit() {
    if (job) return false;
    if (!library.available() || !library.current()) { said = 'no corpus'; return false; }
    const pieces = plan().pieces;
    const hooks = state.hooks();
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

function lay(pieces) {
    const hooks = state.hooks();
    const restHold = state.restHold();
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

    if (replaced || adjusted) order(keep, hooks);
    committed = true;
    said = keep.length ? `${keep.length} in the mix` : '';
    if (missing.length) said += `${said ? ' · ' : ''}nothing says ${missing.map((m) => `"${m}"`).join(', ')}`;
    if (replaced && hooks.edited) hooks.edited();
    else if (adjusted && hooks.changed) hooks.changed();
    return replaced || adjusted;
}

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

function order(block, hooks) {
    const seq = project.clips.filter((c) => c.track === 0).sort((a, b) => a.start - b.start);
    const others = seq.filter((c) => block.indexOf(c) < 0);
    let at = 0;
    for (const c of seq) { if (block.indexOf(c) >= 0) break; if (others.indexOf(c) >= 0) at++; }
    const merged = others.slice(0, at).concat(block, others.slice(at));
    let t = 0;
    for (const c of merged) { c.start = t; t += c.length; }
    if (hooks.packed) hooks.packed();
}

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

const onsets = new Map();
const queue = [];
let reading = null;

const onsetKey = (path, at) => `${path}@${at.toFixed(3)}`;

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
        onsets.set(next.key, 0);
    }
}

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

export function forget() {
    for (const q of queue) if (q.read) { try { bro.ffmpeg.marks.reads.forget(q.read); } catch (e) { /* gone */ } }
    queue.length = 0;
    if (reading) {
        try { bro.ffmpeg.marks.reads.forget(reading.read); } catch (e) { /* gone */ }
        reading = null;
    }
}
