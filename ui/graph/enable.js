// `enable=`, as a set of spans and as the text it is.
//
// libavfilter's timeline support is one option on a filter — `enable`, an
// expression evaluated per frame, the filter stepped over on frames it says no
// to. It is the nearest thing ffmpeg has to a keyframe and it is nothing like
// one: **it turns a filter on and off, it does not interpolate a value.** A
// blur that comes on at ten seconds comes on at full strength.
//
// The vocabulary is ffmpeg's own expression evaluator, so `enable` can say
// things no control could draw — `mod(t,2)`, `gt(n,300)*lt(pos,1e6)`,
// arithmetic on any of it. That is the whole of the design problem here, and
// this application already has one answer to it: the Quality slider produces
// `{crf: 20}`, the advanced editor produces `{crf: 20}`, and both go through
// `av_opt_set`. There is no private path and there is nothing to drift.
//
// So the control here writes an `enable` expression and nothing else. The
// expression stays editable as text, in the same field every other option is
// edited in, and the strip is a *reading* of it rather than a second copy: it
// is parsed on every draw, and nothing is written unless somebody drags or
// types. Which is what makes the honest failure honest — an expression this
// cannot represent is not rewritten, it is refused, the strip says so, and the
// text is left exactly as it was. The `mixed` state in the properties panel is
// the same idea: the control declines to state a value it does not have.
//
// **The quotes are part of the value.** A filtergraph separates filters in a
// chain with commas, so `enable=between(t,1,2)` is three filters and a syntax
// error. What ffmpeg's own documentation writes is `enable='between(t,1,2)'`,
// and since `print.js` writes an argument verbatim — deliberately, so what is
// printed is what was typed — the quotes have to be in the stored value. They
// are stripped on the way in so that a person who typed it without them still
// gets a strip, and put back the moment anything is committed.

import { infoOf } from './filters.js';

/// Does libavfilter say this filter honours `enable` at all?
///
/// `AVFILTER_FLAG_SUPPORT_TIMELINE` arrives as `f.timeline` on the registry
/// entry, so which filters can take one is a fact this build answers rather
/// than a list written down here. It matters more than most flags: a filter
/// without it takes `enable` without complaint and ignores it, which is the
/// exact failure this application exists to avoid.
export function supportsTimeline(filter) {
    const info = infoOf(filter);
    return !!(info && info.timeline);
}

/// Numbers, short — the same restraint `derive.js` uses on its own arguments.
function num(v) {
    const r = Number(Number(v).toFixed(3));
    return Object.is(r, -0) ? '0' : String(r);
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

/// The five shapes a span can be written in, and how many numbers each takes.
/// `gte`/`lte` are kept apart from `gt`/`lt` rather than folded into them
/// because printing one as the other would be a rewrite of somebody's
/// expression, which is the one thing this file is here not to do.
const OPS = {
    between: 2, gt: 1, gte: 1, lt: 1, lte: 1,
};

/// Take the quotes off, if there are any. Both kinds, because ffmpeg accepts
/// both and somebody typing this by hand will use whichever is under their
/// finger.
function unquote(text) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0])
        return t.slice(1, -1).trim();
    return t;
}

/// Split on the `+`s that are not inside brackets. `between(t,1,2)+between(t,5,6)`
/// is two terms; `between(t,1+1,2)` is one this cannot represent, and the depth
/// count is what tells them apart.
function terms(text) {
    const out = [];
    let depth = 0;
    let at = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '+' && depth === 0) { out.push(text.slice(at, i)); at = i + 1; }
    }
    out.push(text.slice(at));
    return out.map((s) => s.trim());
}

const CALL = /^([a-z]+)\s*\(([^()]*)\)$/;

/// One term → a span, or null for anything this cannot draw.
function spanOf(text) {
    const m = CALL.exec(text);
    if (!m) return null;
    const op = m[1];
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) return null;
    const args = m[2].split(',').map((s) => s.trim());
    if (args.length !== OPS[op] + 1) return null;
    // The variable has to be `t`. `n` and `pos` are perfectly good things to
    // write an enable against — a frame number and a byte position — and a
    // strip drawn in seconds cannot say anything true about either, so they go
    // down the same road as an expression: kept as text, drawn by nothing.
    if (args[0] !== 't') return null;
    const nums = args.slice(1);
    if (!nums.every((s) => NUMBER.test(s))) return null;
    const v = nums.map(Number);
    if (op === 'between') return v[1] > v[0] ? { op, from: v[0], to: v[1] } : null;
    if (op === 'gt' || op === 'gte') return { op, from: v[0], to: null };
    return { op, from: null, to: v[0] };
}

/// An `enable` value → the spans it describes.
///
/// `{ ok: true, spans }` — an empty list meaning "always on", which is what no
/// `enable` at all means — or `{ ok: false, reason }`, which the caller must
/// show rather than paper over.
export function parseEnable(value) {
    const text = unquote(value);
    if (!text) return { ok: true, spans: [] };
    const spans = [];
    for (const term of terms(text)) {
        const span = spanOf(term);
        if (!span)
            return { ok: false, reason: refusal(term), spans: [] };
        spans.push(span);
    }
    return { ok: true, spans };
}

/// Why one term could not be drawn, said in terms of what was written rather
/// than as "parse error". Somebody looking at this has an expression in front
/// of them and wants to know which part of it the strip gave up on.
function refusal(term) {
    const m = CALL.exec(term);
    if (!m) return `“${term}” is an expression, not a span`;
    if (!Object.prototype.hasOwnProperty.call(OPS, m[1]))
        return `${m[1]}() is not one of between, gt, gte, lt or lte`;
    const first = m[2].split(',')[0].trim();
    if (first !== 't')
        return `this is written against ${first || 'nothing'} — a strip can only draw t`;
    return `the numbers in ${m[1]}() are expressions, not times`;
}

/// Spans → the value to store, quotes and all. An empty list is an empty
/// string, which `overlay.edit` reads as "take the option off" — and a filter
/// with no `enable` is a filter that is always on, which is the same statement
/// as a strip with nothing on it.
export function printEnable(spans) {
    const list = (spans || []).filter((s) => s && (s.from !== null || s.to !== null));
    if (!list.length) return '';
    return `'${list.map(termOf).join('+')}'`;
}

function termOf(s) {
    if (s.op === 'between') return `between(t,${num(s.from)},${num(s.to)})`;
    if (s.op === 'gt' || s.op === 'gte') return `${s.op}(t,${num(s.from)})`;
    return `${s.op}(t,${num(s.to)})`;
}

/// Where a span lands on a ruler running `0 … length`. An open end is the end
/// of the ruler — which is a drawing decision and not a claim: `gt(t,4)` is
/// true forever and the render stops where it stops.
export function drawnSpan(s, length) {
    const a = s.from === null ? 0 : Math.max(0, Math.min(length, s.from));
    const b = s.to === null ? length : Math.max(0, Math.min(length, s.to));
    return { a: Math.min(a, b), b: Math.max(a, b) };
}

/// Is the filter on at `t`, on the render's own clock?
///
/// The one question a playback can answer that a still cannot: a node played
/// forward through the moment its filter comes on is the only way to see it
/// come on, and the readout over the picture says which side of the boundary
/// the frame on screen is. Open-ended spans are open — `gt(t,4)` is true
/// forever, which is what it says.
/// The comparisons are ffmpeg's own and not approximations of them: `between`
/// is inclusive at both ends, `gt` is strict and `gte` is not. A boundary
/// evaluated one way here and another way in libavfilter would make the readout
/// wrong on exactly the frame somebody is looking at.
export function isOnAt(spans, t) {
    if (!spans || !spans.length) return true;
    return spans.some((s) => {
        if (s.op === 'between') return t >= s.from && t <= s.to;
        if (s.op === 'gt') return t > s.from;
        if (s.op === 'gte') return t >= s.from;
        if (s.op === 'lt') return t < s.to;
        return t <= s.to;
    });
}

/// One span in words, for a card that has no room for a strip.
export function spanText(s) {
    if (s.op === 'between') return `${num(s.from)}–${num(s.to)}s`;
    if (s.op === 'gt' || s.op === 'gte') return `from ${num(s.from)}s`;
    return `until ${num(s.to)}s`;
}

/// What the whole expression says, in one line.
export function enableText(value) {
    const p = parseEnable(value);
    if (!p.ok) return 'a time expression';
    if (!p.spans.length) return 'always';
    if (p.spans.length === 1) return spanText(p.spans[0]);
    return `${p.spans.length} spans`;
}

/// Move one end of one span, keeping it a span. Used by the strip's drag and by
/// the numeric fields, so a dragged edge and a typed number cannot end up
/// meaning different things.
///
/// A `between` that is dragged past itself is clamped rather than flipped: an
/// edge you pushed too far coming back as the other edge is a gesture nobody
/// asked for, and `between(t,2,2)` is a filter that is never on.
export function moveEdge(spans, i, which, t, length) {
    const out = spans.map((s) => Object.assign({}, s));
    const s = out[i];
    if (!s) return out;
    const v = Math.max(0, Math.min(length, t));
    const gap = Math.max(0.02, length / 500);
    if (which === 'from') s.from = s.to === null ? v : Math.min(v, s.to - gap);
    else s.to = s.from === null ? v : Math.max(v, s.from + gap);
    return out;
}

/// A span to add when somebody asks for one, placed where there is room: after
/// the last one, or across the middle of the range when there are none.
export function nextSpan(spans, length) {
    const end = spans.reduce((at, s) => Math.max(at, s.to === null ? length : s.to), -1);
    const width = Math.max(0.1, Math.min(length / 4, 2));
    if (end < 0) return { op: 'between', from: Math.max(0, length / 2 - width / 2),
                          to: Math.min(length, length / 2 + width / 2) };
    const from = Math.min(length - width, end + width / 2);
    return { op: 'between', from: Math.max(0, from), to: Math.min(length, from + width) };
}
