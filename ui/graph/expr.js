// A filter option written as an expression: what libav makes of it, and the one
// shape of it this application can also write.
//
// `enable` turns a filter on and off and that is the whole of what it does —
// there is no interpolation anywhere in ffmpeg's timeline support. What ffmpeg
// has instead is **expressions in a filter's own options**, re-read per frame:
// `crop`'s `x`, `overlay`'s, `rotate`'s angle, `volume`'s gain. Those have
// always worked here, because an option is a string and `print.js` writes a
// string verbatim. What was missing was any way to see one.
//
// **The evaluation is libav's, and it is libav's in exactly one place.**
// `bro.ffmpeg.expr.evaluate` is `av_expr_parse`/`av_expr_eval` —
// `src/native/bindings_expr.cpp` — which is the same pair libavfilter calls on
// the option itself. A second evaluator written here would draw a curve the
// render does not perform and would diverge on precisely the cases somebody
// reaches for an expression to get: integer division, `between`, `mod`, `clip`
// at its ends. Measured rather than asserted: `crop=x='lerp(0,160,clip(t/2,0,1))'`
// over a 320×240 `testsrc` produces at t=1.0 a frame byte-identical (framemd5)
// to `crop=x=80`, which is what this evaluator answers for that expression at
// that instant.
//
// **Which variables are in scope cannot be asked.** `av_expr_parse` wants the
// names up front and fails on one it was not given, and libav publishes no way
// to find out what a filter takes: the names are `static const char *const
// var_names[]` in each filter's own C file, not in the AVOption table and not on
// the AVFilter. `av_expr_count_vars` answers a different question — which of the
// names *you supplied* occur — and there is no `av_expr_list_vars`. So the set
// below is this application's, and being an incomplete list of somebody else's
// private arrays is the honest description of it. It is used for one thing only:
// deciding whether a string is an expression and which variables it needs. The
// values are a much shorter story — see `VALUED`.

import { optionsOf } from './filters.js';

/// The variable names handed to libav's parser.
///
/// **Where this came from, and why it is a list.** Read off ffmpeg's own filter
/// documentation for the filters whose options are expressions — `crop`,
/// `scale`, `overlay`, `pad`, `rotate`, `zoompan`, `drawtext`, `drawbox`,
/// `drawgrid`, `swaprect`, `volume`, `eq`, `vignette`, `fftfilt`, `geq`,
/// `setpts`/`asetpts` — plus the four `-force_key_frames expr:` already names in
/// `export_writer.cpp`. It **is not complete and cannot be**: a filter this
/// build gains brings its own names and nothing in libav will say what they are.
///
/// The cost of an omission is bounded and stated: a name missing from here makes
/// `read()` say the value is not an expression, so no curve is drawn and no
/// control is offered — the string still goes through to the render verbatim,
/// exactly as it did before any of this existed. The cost of a *spurious* name
/// is smaller still: a curve is not drawn for it either, because `VALUED` is the
/// only thing that decides that.
const KNOWN_NAMES = [
    // Time and position, in every filter that reads a frame.
    't', 'n', 'pos', 'pts', 'duration', 'tb', 'startpts', 'startt', 'rand',
    'pict_type', 'nb_frames', 'frame_num',
    // Geometry, in every filter that resizes, crops, pads or places.
    'w', 'h', 'a', 'sar', 'dar', 'hsub', 'vsub', 'ohsub', 'ovsub',
    'iw', 'ih', 'in_w', 'in_h', 'ow', 'oh', 'out_w', 'out_h', 'x', 'y',
    'main_w', 'main_h', 'main_a', 'W', 'H',
    'overlay_w', 'overlay_h', 'overlay_x', 'overlay_y',
    // drawtext's own measurements of the text it is about to draw.
    'text_w', 'tw', 'text_h', 'th', 'line_h', 'lh', 'ascent', 'descent',
    'max_glyph_a', 'max_glyph_d', 'max_glyph_h', 'max_glyph_w',
    // zoompan counts in frames of its own and carries the previous one.
    'in', 'on', 'in_time', 'it', 'out_time', 'ot', 'pduration',
    'zoom', 'z', 'pzoom', 'px', 'py',
    // volume and the sound filters.
    'nb_channels', 'nb_consumed_samples', 'nb_samples', 'sample_rate', 'volume',
    // fftfilt and geq, which are written in capitals.
    'X', 'Y', 'N', 'SW', 'SH', 'T', 'WS', 'HS',
    // setpts, which is a string option that is nothing but an expression.
    'PTS', 'PREV_INPTS', 'PREV_INT', 'PREV_OUTPTS', 'PREV_OUTT', 'RTCSTART',
    'RTCTIME', 'S', 'SAMPLE_RATE', 'SR', 'STARTPTS', 'STARTT', 'TB', 'FR',
    'FRAME_RATE', 'INTERLACED', 'NB_CONSUMED_SAMPLES',
    // …and the four `-force_key_frames expr:` takes, so the same reader can be
    // pointed at one. See `Writer::KeyFrames::parse`.
    'n_forced', 'prev_forced_n', 'prev_forced_t',
];

/// The ones this application can put a number to, which is one.
///
/// **`t` and nothing else, deliberately.** A curve is drawn against seconds
/// because seconds are what this application knows about a node: `when.js`'s
/// `clockOf` says which clock the node's `t` is on and over what window, and
/// that is a fact about the graph rather than a guess.
///
/// `n` is the one that looks easy and is not. It counts frames arriving *at that
/// filter*, and this application has two frame rates that are deliberately not
/// merged — `projectFps()` for the timeline and `outputFps()` for the encoder —
/// with a derived `setpts`, a clip's speed and any `fps` of yours in between. A
/// curve drawn against a guessed rate would be right at 0 and wrong everywhere
/// else, in the direction nobody would notice. So `n` is refused by name, and
/// the refusal says that rather than pretending.
///
/// Everything geometric is refused for a plainer reason: `in_w` at an arbitrary
/// point in a graph is what the chain above it makes, which this application
/// only learns by running the graph — which is what the node previews do and
/// what nothing joins up to this yet.
const VALUED = ['t'];

/// Is `t` in this filter's expressions the timestamp?
///
/// **Asked of the option table, because there is a filter in this build where it
/// is not.** `drawbox` and `drawgrid` expose their own string options as
/// expression variables — `x`, `y`, `w`, `h` and `t`, where `t` is the *box
/// thickness* — so a curve drawn against seconds there would be a curve about
/// something else entirely. Measured before it was believed:
/// `drawbox=x='t*10':y=0:w=20:h=20:t=3` produces, at every timestamp over two
/// seconds at 10 fps, frames byte-identical (framemd5) to `drawbox=x=30` — which
/// is thickness × 10 and not time × 10.
///
/// The signal is `t` being a **string** option of the filter's own, which in
/// this build is exactly those two out of the thirty filters carrying an option
/// called `t` at all; the other twenty-eight are a threshold, a fade direction
/// or a tap count, and a scalar option is not something a filter hands its
/// expression evaluator. So this is asked rather than listed, and a filter that
/// ffmpeg gains with the same habit is covered without an edit here.
export function tIsTime(filter) {
    return !optionsOf(filter).some((o) => o.name === 't' && o.type === 'string');
}

/// Take the quotes off, if there are any — the same pair `enable.js` strips, for
/// the same reason: a filtergraph separates filters with commas, so an
/// expression containing one has to be quoted in the stored value and the quotes
/// are part of it.
export function unquote(text) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0])
        return t.slice(1, -1).trim();
    return t;
}

/// Put them back. An empty expression is an empty string, which `overlay.edit`
/// reads as "take the option off".
export function quote(text) {
    const t = String(text || '').trim();
    return t ? `'${t}'` : '';
}

/// Numbers, short — `enable.js`'s restraint, for the reason it gives: an edge is
/// a number somebody reads back off a field and off the printed
/// `-filter_complex`, and a float says 2.4000000000000004 in both.
export function num(v) {
    const r = Number(Number(v).toFixed(3));
    return Object.is(r, -0) ? '0' : String(r);
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

// ── what libav makes of one ────────────────────────────────────────────────

/// One option's value, read as an expression.
///
/// Answers one of four states, and every one of them is libav's verdict rather
/// than a guess about the text:
///
///   - `'plain'` — libav will not parse it. Which is the ordinary answer for
///     most of a filter's string options: `drawtext`'s `fontfile` is a path and
///     `movie`'s is a filename. Nothing is drawn and nothing is offered.
///   - `'constant'` — it parses and uses no variable. `crop=x=80` is an
///     expression that never moves, and it is exactly where an animation starts.
///   - `'varies'` — it parses and uses only variables this application can put a
///     number to, which is `t`. This is the one that gets a curve.
///   - `'unreadable'` — it parses and uses something else. `names` says which,
///     and the caller must show them: an expression whose value depends on
///     `in_w` is a real expression that this cannot draw, which is a different
///     thing from a broken one.
///
/// `filter` is needed for `tIsTime` and for nothing else.
export function read(filter, value) {
    const text = unquote(value);
    if (!text) return { state: 'plain', text: '', names: [], reason: '' };

    const answer = evaluate(text, KNOWN_NAMES, []);
    if (!answer || !answer.ok)
        return { state: 'plain', text, names: (answer && answer.unknown) || [],
                 reason: (answer && answer.reason) || 'libav’s evaluator will not parse this' };

    const uses = answer.uses || [];
    if (!uses.length) return { state: 'constant', text, names: [], reason: '' };

    const strange = uses.filter((n) => VALUED.indexOf(n) < 0);
    if (strange.length)
        return { state: 'unreadable', text, names: strange,
                 reason: `this application has no value for ${strange.join(', ')} at this ` +
                         'node, so there is nothing true to draw' };

    if (!tIsTime(filter))
        return { state: 'unreadable', text, names: ['t'],
                 reason: `t in ${filter}’s expressions is its own t option — the thickness — ` +
                         'and not the timestamp, so a curve against seconds would be about ' +
                         'the wrong quantity' };

    return { state: 'varies', text, names: uses, reason: '' };
}

/// The one call, so there is one place a `bro.ffmpeg` that does not have this
/// surface is coped with. A build without it answers `null` and every reader
/// above degrades to "not an expression", which is what this application did
/// before any of it existed.
function evaluate(text, names, rows) {
    try {
        if (typeof bro === 'undefined' || !bro.ffmpeg || !bro.ffmpeg.expr) return null;
        return bro.ffmpeg.expr.evaluate(text, names, rows);
    } catch (e) {
        return null;
    }
}

/// `steps` values of the expression, `t` running across a window.
///
/// The window is a `clockOf` clock — `{ start, length }` — because that is the
/// one answer to which seconds a node's `t` is written in, and a strip that
/// worked it out for itself would be the third reader of that question to get it
/// wrong while agreeing with the other two. See `when.js`.
///
/// A row per sample rather than a sweep argument: the native call takes names
/// and rows and knows nothing about time, which keeps `av_expr_eval` a general
/// call and this the only place that decides what a sample means.
export function sample(text, win, steps) {
    const n = Math.max(2, Math.min(512, Math.round(steps || 120)));
    const rows = [];
    for (let i = 0; i < n; i++)
        rows.push([win.start + (win.length * i) / (n - 1)]);
    const answer = evaluate(unquote(text), VALUED, rows);
    if (!answer || !answer.ok) return null;
    return { values: answer.values || [], at: (i) => win.start + (win.length * i) / (n - 1) };
}

/// What the expression comes to at one moment, or null.
export function valueAt(text, t) {
    const answer = evaluate(unquote(text), VALUED, [[t]]);
    if (!answer || !answer.ok) return null;
    const v = (answer.values || [])[0];
    return v === null || v === undefined ? null : v;
}

// ── the one shape this can also write ──────────────────────────────────────
//
// **A generator that cannot read back what it wrote is a one-way door.** Somebody
// edits the text by hand once — which they are meant to be able to do, the text
// field is the point — and the control can never show it again. This repository
// already has the rule in two places: `enable.js` parses what it prints, and
// `ui/document.js` is a serialiser because the file format was written first.
//
// So the points editor writes one shape and one only, and parses that exact
// shape back. It is not a general reader of ffmpeg's expression language and
// does not pretend to be: anything else — including a hand-edited version of its
// own output — comes back as "not points", the editor stands down, the curve is
// still drawn from libav's evaluation, and the text is left exactly as written.
// That is the same division `enable.js`'s strip already makes.
//
// The shape is `lerp` and `clip`, which are libavutil's own — no `if` for the
// two-point case, because `clip` already flattens outside the span, and the
// value therefore holds at its first and last point rather than shooting off.
// Beyond two points it is a nest of `if(lt(t,…))`, which is how ffmpeg's own
// documentation writes a piecewise value. Both were run through ffmpeg 8.0.1
// before anything was built on them.

/// Split on top-level commas, ignoring the ones inside brackets. The same depth
/// count `enable.js` uses to tell `between(t,1,2)+between(t,5,6)` from
/// `between(t,1+1,2)`.
function args(text) {
    const out = [];
    let depth = 0, at = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) { out.push(text.slice(at, i)); at = i + 1; }
    }
    out.push(text.slice(at));
    return out.map((s) => s.trim());
}

/// `name(...)` → what is inside, or null. Bracket-matched rather than
/// regex-matched, since every argument here can itself be a call.
function call(name, text) {
    const t = text.trim();
    if (t.indexOf(`${name}(`) !== 0 || t[t.length - 1] !== ')') return null;
    const inner = t.slice(name.length + 1, -1);
    let depth = 0;
    for (const c of inner) {
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth < 0) return null; }
    }
    return depth === 0 ? inner : null;
}

/// One segment: the value moving from `(t0,v0)` to `(t1,v1)`, held flat outside.
function segment(t0, v0, t1, v1) {
    return `lerp(${num(v0)},${num(v1)},clip((t-${num(t0)})/(${num(t1)}-${num(t0)}),0,1))`;
}

/// A segment back to its four numbers, or null.
function readSegment(text) {
    const inner = call('lerp', text);
    if (inner === null) return null;
    const a = args(inner);
    if (a.length !== 3 || !NUMBER.test(a[0]) || !NUMBER.test(a[1])) return null;
    const c = call('clip', a[2]);
    if (c === null) return null;
    const ca = args(c);
    if (ca.length !== 3 || ca[1] !== '0' || ca[2] !== '1') return null;
    // `(t-T0)/(T1-T0)`, exactly as printed. Split on the one top-level `/`.
    const slash = topLevelSlash(ca[0]);
    if (slash < 0) return null;
    const lhs = ca[0].slice(0, slash).trim();
    const rhs = ca[0].slice(slash + 1).trim();
    const numerator = /^\(t-(-?[\d.]+)\)$/.exec(lhs);
    const denominator = /^\((-?[\d.]+)-(-?[\d.]+)\)$/.exec(rhs);
    if (!numerator || !denominator) return null;
    const t0 = Number(numerator[1]);
    if (Number(denominator[2]) !== t0) return null;
    const t1 = Number(denominator[1]);
    if (!(t1 > t0)) return null;
    return { t0, v0: Number(a[0]), t1, v1: Number(a[1]) };
}

function topLevelSlash(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '/' && depth === 0) return i;
    }
    return -1;
}

/// Points → the expression to store, quotes and all.
///
/// Fewer than two points is not a curve: one point is a constant and is printed
/// as the number, which is what an animation taken back down to a single value
/// should become rather than a `lerp` from a value to itself.
export function printPoints(points) {
    const list = (points || []).slice()
        .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t);
    if (!list.length) return '';
    if (list.length === 1) return quote(num(list[0].v));
    const body = (i) => {
        const seg = segment(list[i].t, list[i].v, list[i + 1].t, list[i + 1].v);
        if (i + 2 >= list.length) return seg;
        return `if(lt(t,${num(list[i + 1].t)}),${seg},${body(i + 1)})`;
    };
    return quote(body(0));
}

/// And back: an expression → the points it was printed from, or null.
///
/// Null for everything this did not write, including a hand-edited version of
/// something it did. That is the whole contract — see the note above — and the
/// caller shows the curve and the text either way.
export function parsePoints(value) {
    const text = unquote(value);
    if (!text) return null;
    const points = [];
    let rest = text;
    for (let guard = 0; guard < 64; guard++) {
        const inner = call('if', rest);
        if (inner === null) break;
        const a = args(inner);
        if (a.length !== 3) return null;
        const cut = call('lt', a[0]);
        if (cut === null) return null;
        const ca = args(cut);
        if (ca.length !== 2 || ca[0] !== 't' || !NUMBER.test(ca[1])) return null;
        const seg = readSegment(a[1]);
        if (!seg || seg.t1 !== Number(ca[1])) return null;
        if (!push(points, seg)) return null;
        rest = a[2];
    }
    const last = readSegment(rest);
    if (!last) return null;
    if (!push(points, last)) return null;
    return points;
}

/// Add a segment's two ends, insisting that it starts where the last one ended.
/// A nest whose middle does not join up was not printed by `printPoints`, and
/// reading it as points would be inventing a curve.
function push(points, seg) {
    if (!points.length) {
        points.push({ t: seg.t0, v: seg.v0 }, { t: seg.t1, v: seg.v1 });
        return true;
    }
    const end = points[points.length - 1];
    if (end.t !== seg.t0 || end.v !== seg.v0) return false;
    points.push({ t: seg.t1, v: seg.v1 });
    return true;
}

/// Two points to start from, across the window, holding whatever the value is
/// now. The second is nudged so a ramp begins as a flat line at the value that
/// was already there rather than as a jump to zero — the first thing somebody
/// does is drag one end, and starting from the current value means the other end
/// is still what it was.
export function firstPoints(win, value) {
    const v = Number.isFinite(value) ? value : 0;
    return [{ t: round(win.start), v: round(v) },
            { t: round(win.start + win.length), v: round(v) }];
}

/// Two decimal places, for the reason `when.js` rounds: these numbers are read
/// back off a field and out of the printed command.
export const round = (v) => Math.round(v * 100) / 100;

// ── whether the render will re-read it ─────────────────────────────────────

/// What a filter's own `eval` option says about re-reading its expressions.
///
/// **This is what the `eval` option is a signal for, and it is not "this option
/// is an expression".** Nine filters in this build carry one — `scale`,
/// `overlay`, `pad`, `volume`, `eq`, `fftfilt`, `perspective`, `vignette`,
/// `scale2ref` — and `crop`, `drawtext`, `zoompan`, `rotate`, `geq` and
/// `drawbox`, which are the ones most obviously written in expressions, carry
/// none at all and re-read unconditionally. So `eval` cannot say which options
/// take an expression; what it says is whether an expression that is there will
/// be evaluated once at init or on every frame, which is the difference between
/// a curve the render performs and a curve it does not.
///
/// Answers `{ has, per, value, options }`: whether the filter has one, whether
/// it is set to the per-frame constant, what it is set to *by name*, and what it
/// can be set to. All of it out of the option table — the constant is whichever
/// is called `frame`, which is `once`/`frame` on `volume` and `init`/`frame` on
/// the other eight, and neither spelling is written down here.
///
/// **An unset enum arrives as its number, not its name.** `optionsOf` reports an
/// AVOption's default as libav renders it, and for an int-with-constants that is
/// `"0"` — so a filter left on its default would have compared unequal to
/// `frame` and been reported as per-frame when it is not, on every filter with
/// an `eval` option, which is all nine of them. So the value is resolved against
/// the constants by name *and* by number before anything is said about it.
export function evalMode(filter, params) {
    const option = optionsOf(filter).find((o) => o.name === 'eval');
    if (!option) return { has: false, per: true, value: '', options: [] };
    const values = option.values || [];
    const set = params && params.eval !== undefined ? String(params.eval).trim() : '';
    const raw = set || String(option.default === undefined ? '' : option.default);
    const named = values.find((v) => v.name === raw) ||
                  values.find((v) => String(v.value) === raw);
    const frame = values.find((v) => v.name === 'frame');
    return {
        has: true,
        per: !!frame && !!named && named.name === frame.name,
        value: named ? named.name : raw,
        frame: frame ? frame.name : '',
        options: values.map((v) => v.name),
    };
}
