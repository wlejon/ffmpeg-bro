// What libavfilter says about a filter, asked once.
//
// **There is no list of filters in this application.** `bro.ffmpeg.filters` is
// libavfilter's own registry — names and pad shapes, built at startup because it
// is small — and `bro.ffmpeg.filterOptions(name)` walks one filter's `AVClass`
// for its option table: names, types, ranges, defaults, enum constants and help
// text. A filter that this ffmpeg gains, this application gains.
//
// Cached here rather than at each point of use because there are now two, and
// they must agree. The card draws a `<select>` where an option has constants and
// an `<input>` where it does not; the panel decides the same thing about the same
// option; two caches would be two answers to what a filter takes, arrived at from
// the same data by different routes. The option tables are also the reason the
// caching is not optional — `filterOptions` is built on demand precisely because
// building all five hundred at startup was most of a second, and a card rebuilt
// on every keystroke would spend it a character at a time.

const optionCache = new Map();
const infoCache = new Map();

/// One filter's option table, or an empty list. Plenty of filters have none —
/// `hflip`, `negate`, `null` — and that is an answer, not a failure.
export function optionsOf(name) {
    if (!name) return [];
    if (!optionCache.has(name)) {
        let list = [];
        try { list = bro.ffmpeg.filterOptions(name) || []; } catch (e) { list = []; }
        optionCache.set(name, list);
    }
    return optionCache.get(name);
}

/// The registry entry: `{ name, description, inputs, outputs, … }`, or null.
export function infoOf(name) {
    if (!infoCache.size) {
        for (const f of allFilters()) infoCache.set(f.name, f);
    }
    return infoCache.get(name) || null;
}

export function allFilters() {
    return (typeof bro !== 'undefined' && bro.ffmpeg && bro.ffmpeg.filters) || [];
}

/// One option out of a filter's table, by name.
export function optionOf(filter, name) {
    return optionsOf(filter).find((o) => o.name === name) || null;
}

// ── how many pads a filter has ─────────────────────────────────────────────
//
// libavfilter answers most of this itself: `bro.ffmpeg.filters` carries one
// character per pad — `overlay` is `vv` in and `v` out — and for a filter whose
// shape is fixed that is the whole answer.
//
// The awkward ones are the dynamic ones, where **the pad count is a function of
// an option value**. `amix=inputs=3` has three inputs, `split=4` has four
// outputs, and there is nothing in libavfilter's metadata that says which
// option decides it: each of those filters works it out in its own `init`, from
// a field it named itself. ffmpeg's own CLI does not know either.
//
// So the option is *found* rather than tabled: among the four names ffmpeg has
// ever used for a pad count, at most one is in any given filter's own option
// table, and what it defaults to is in that table too. A filter this build gains
// works here without being mentioned.
//
// **The dynamic flag is not the count.** That was the first version of this and
// it was wrong on the very first graph it met: `scale` carries
// AVFILTER_FLAG_DYNAMIC_INPUTS — it grows a second pad for `scale2ref` — while
// declaring one `v` input and having nothing in its table that says how many.
// So the declared pads are the answer unless a counting option is actually
// found, and the same restraint covers the other filters shaped that way
// (`decimate`'s `ppsrc`, and whatever ffmpeg does next): a filter that can grow
// a pad in a way nothing can count is drawn with the pads it declares, which is
// the conservative answer and the one that is right until somebody uses the
// feature.
//
// The positional fallback is narrower still — `amix=3` is the same filter as
// `amix=inputs=3`, but only because `inputs` is the *first* entry of amix's
// table, and reading `pos[0]` as a count without checking that is what turned
// `scale=1920:1080` into a node with sixty-four sockets.
//
// `concat` is the one that does not fit, and it does not fit for a real reason:
// its count *multiplies*. `concat=n=3:v=1:a=1` is nine pads in and two out,
// grouped per segment, and no rule about a single count expresses that. It is
// written out below rather than approximated, because a graph drawn with the
// wrong number of sockets is a graph you cannot wire.

const IN_COUNT = ['inputs', 'nb_inputs', 'n'];
const OUT_COUNT = ['outputs', 'nb_outputs', 'n'];

/// A pad count, clamped to something a screen can draw. libavfilter's own
/// maxima run to thousands; a node with a thousand sockets is not a node.
function count(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(64, n) : 0;
}

/// The option that says how many pads there are, if the filter has one — and
/// whether it is the first of the table, which is what makes it also the first
/// positional argument.
function countOption(filter, names) {
    const table = optionsOf(filter);
    for (const o of table)
        if (names.indexOf(o.name) >= 0) return { option: o, first: table[0] === o };
    return null;
}

/// What a dynamic filter was told, or what it does by default, or — when
/// nothing in its table counts anything — the pads it declared.
function padCount(filter, names, params, pos, declared) {
    const found = countOption(filter, names);
    if (!found) return declared;
    const name = found.option.name;
    if (params && params[name] !== undefined) {
        const n = count(params[name]);
        if (n) return n;
    }
    if (found.first && pos && pos.length && /^\s*\d+\s*$/.test(String(pos[0]))) {
        const n = count(pos[0]);
        if (n) return n;
    }
    return count(found.option.default) || declared;
}

/// Which stream a dynamic filter's pads carry. `amix` declares no inputs and
/// one `a` output; `hstack` declares none and one `v`. The declared side is the
/// answer for the side that is not declared — a filter does not mix streams
/// across its own dynamic pads.
function streamOf(info) {
    return (info.inputs && info.inputs[0]) || (info.outputs && info.outputs[0]) || 'v';
}

/// `{ ins, outs }` — one stream character per pad — or null for a filter this
/// build does not have.
///
/// Null rather than a guess, because "there is no filter called that" is a
/// thing to say to somebody rather than a shape to invent: a graph printed with
/// a filter ffmpeg will refuse is a command that cannot be run, which is the
/// one thing printing a command has to be good for.
export function padsOf(filter, params, pos) {
    const info = infoOf(filter);
    if (!info) return null;
    const chars = (s) => String(s || '').split('');

    if (filter === 'concat') {
        const n = padCount(filter, ['n'], params, pos, 2) || 2;
        const v = params && params.v !== undefined ? count(params.v)
                : count((optionOf(filter, 'v') || {}).default);
        const a = params && params.a !== undefined ? count(params.a)
                : count((optionOf(filter, 'a') || {}).default);
        const seg = [];
        for (let i = 0; i < v; i++) seg.push('v');
        for (let i = 0; i < a; i++) seg.push('a');
        const ins = [];
        for (let i = 0; i < n; i++) ins.push(...seg);
        return { ins, outs: seg.slice() };
    }

    let ins = chars(info.inputs);
    let outs = chars(info.outputs);
    if (info.dynamicInputs) {
        const n = padCount(filter, IN_COUNT, params, pos, ins.length);
        if (n !== ins.length) ins = new Array(n).fill(streamOf(info));
    }
    if (info.dynamicOutputs) {
        const n = padCount(filter, OUT_COUNT, params, pos, outs.length);
        if (n !== outs.length) outs = new Array(n).fill(streamOf(info));
    }
    return { ins, outs };
}
