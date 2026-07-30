// A generator, as something a clip can be cut from.
//
// `ffmpeg -f lavfi -i testsrc` is one of the first commands anybody runs, and
// until now this application could only hold the *filter* half of it: a `color`
// or a `testsrc` placed by hand on the Graph stage, feeding an `overlay`, with
// no lane, no bar and no in point. The timeline is where "where does this
// picture go, for how long, from which moment of it" is said, and a generator
// had none of those.
//
// So a generator is a **clip** — see `makeGenerator` in ui/project.js for the
// argument — and this file is the one thing a clip of one needs that a clip of a
// file gets from `ui/inputs.js`: what it *is*, what libavfilter says it produces,
// and something a `<video>` can be pointed at.
//
// **Two of ffmpeg's own spellings of one picture, and this uses both on
// purpose.** `testsrc=size=640x360` is a filter, and it is what the render runs:
// `graph/derive.js` puts that node at the head of the clip's chain exactly where
// a file clip's `-i` goes, so the render is `-filter_complex` and there is no
// second mechanism. The *same string* is also what the `lavfi` demuxer takes as
// its filename — `-f lavfi -i testsrc=size=640x360` — which is an `-i` like any
// other, registered with `bro.ffmpeg.inputs.define` and played by an ordinary
// `<video>`. That is why a generator clip has a picture on the Compose stage
// rather than a bar and a blank rectangle: it is the same backend, the same
// decoder and the same renderer every other clip uses, and the frames cross as
// `wrapped_avframe` through the `Wrapped` payload in ffmpeg_backend.cpp — the
// crossing that already makes a lavfi *device* play in its card on the Capture
// stage. Nothing here is a preview path.
//
// **What one registration is keyed by is the arguments, not the clip.** Two
// clips of one `testsrc=size=1920x1080` are two clips of one `-i`, which is what
// ffmpeg would open and what `plainInputFor` already says about two drops of one
// file. It also makes a split free — both halves are the same generator — and it
// makes reopening a document cost nothing when the generator has not changed.
// The map grows by one entry per *distinct* generator an edit has held, and an
// entry is a filter name, an option bag and a probe: it holds no file, no
// decoder and no thread, which is why there is nothing here shaped like
// `retain()`.
//
// **A generator that will not open is not laid out.** `probe()` is the moment
// libavfilter reads the arguments, and it answers with its own sentence — "No
// option name near '1'" — so a filter this build does not have, an option it
// does not take and a value out of range are all refused with the reason before
// there is a clip, exactly as a file that will not open is. That is the same
// rule as everywhere else here: an unknown option is an error, not a shrug.

import { infoOf, isSource, optionOf, padsOf } from './graph/filters.js';
import { filterArgs } from './graph/print.js';

/// Every filter that could be a clip: one that makes **pictures** out of
/// nothing.
///
/// **Discovered, never listed.** `isSource` is libavfilter's own answer — no
/// input pads and no dynamic ones — and the extra term here is that the pad it
/// writes is a picture, because a clip on the timeline is somewhere a picture
/// goes. `sine` and `anullsrc` are sources and are not offered: a clip that
/// contributed to the mix and to nothing else would need a lane it cannot be
/// drawn on and a length nothing on screen states, and the Graph stage already
/// holds one wired straight to the mix. That is a decision about the *timeline*
/// rather than a claim about the filters, and it is the whole of the difference
/// between this list and `sourceFilters()`.
///
/// A filter that cannot actually run on its own — `buffer` is the graph API's
/// own entry point and wants frames fed to it — is still in the list, for the
/// reason the Graph stage's palette keeps it: libavfilter is the authority on
/// what a filter is, and picking one that will not open is refused in libav's
/// own words rather than hidden behind a table maintained here.
export function pictureSources() {
    const out = [];
    for (const f of (typeof bro !== 'undefined' && bro.ffmpeg && bro.ffmpeg.filters) || []) {
        if (!isSource(f.name)) continue;
        if (String(f.outputs || '') !== 'v') continue;
        out.push(f);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/// A generator spec, ready to be settled: `{ filter, pos, params }`.
///
/// The shape is a graph node's, deliberately — `graph/print.js`'s `filterArgs`
/// prints it and `graph/derive.js` adds it to the graph — so there is one answer
/// to how a filter and its arguments are spelled and the bar, the graph and the
/// lavfi filename cannot come apart.
///
/// **The canvas's size and rate, where the filter has somewhere to put them.**
/// A `testsrc` at its own 320×240 default laid on a 1080p timeline is a picture
/// the derivation's `scale` blows up four times over, which is not what anybody
/// dropping a test pattern on a 1080p edit meant. Which option carries it is
/// *found* rather than tabled — the same restraint `padsOf` applies to a pad
/// count: `size` and `rate` are the names ffmpeg's source filters use, at most
/// one of each is in any given filter's own option table, and a filter that has
/// neither (`haldclutsrc` has no rate; `buffer` has neither) is left exactly as
/// libavfilter would default it. Setting an option a filter does not have would
/// be refused by `av_opt_set`, which is why this asks first.
///
/// **No `duration`/`d` is written, and that is load-bearing.** How long a
/// generator is is the *clip's* length — `trim` in the derived chain is what
/// bounds it, the same node that bounds a clip of a file — and a `d` on the
/// source would be a second answer to it, differing from the first the moment
/// somebody dragged the bar's end.
export function makeSpec(filter, canvas = {}) {
    const params = {};
    const size = Math.round(canvas.width) > 0 && Math.round(canvas.height) > 0
        ? `${Math.round(canvas.width)}x${Math.round(canvas.height)}` : '';
    const rate = Number(canvas.fps) > 0 ? String(Number(canvas.fps)) : '';
    if (size && optionOf(filter, 'size')) params.size = size;
    if (rate && optionOf(filter, 'rate')) params.rate = rate;
    return { filter: String(filter), pos: [], params };
}

/// The same spec with a different argument string, as a person typed it.
///
/// Refused rather than corrected for a filter name that is not one: the name is
/// not editable here — a different generator is a different clip — so this only
/// ever re-reads the arguments.
export function withArgs(gen, text) {
    const { pos, params } = parseArgs(text);
    return { filter: gen.filter, pos, params };
}

/// `size=640x360:rate=25` → `{ pos, params }`.
///
/// **ffmpeg's own grammar, which is narrower than it looks**: arguments are
/// separated by `:`, a `\:` is a literal colon, and each argument is either
/// `key=value` — split at the *first* `=`, so a value may contain more of them —
/// or a bare value, which is positional. That is `av_opt_set_from_string`, and
/// writing a second grammar here would mean a field that accepts what
/// libavfilter refuses.
///
/// A bare argument keeps its place in `pos`, because positional and named
/// arguments are the same option table entered two ways and `crop=iw/2:ih/2` has
/// to come back out as itself.
export function parseArgs(text) {
    const pos = [];
    const params = {};
    const s = String(text === undefined || text === null ? '' : text);
    let cur = '';
    const parts = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
        if (s[i] === ':') { parts.push(cur); cur = ''; continue; }
        cur += s[i];
    }
    parts.push(cur);
    for (const part of parts) {
        const one = part.trim();
        if (!one) continue;
        const at = one.indexOf('=');
        if (at <= 0) pos.push(one);
        else params[one.slice(0, at)] = one.slice(at + 1);
    }
    return { pos, params };
}

/// The whole filter, as ffmpeg would write it — `testsrc=size=640x360:rate=25`.
///
/// Both the lavfi demuxer's filename and the name a bar carries, which is why
/// there is one of these: what a generator clip is *called* on the timeline is
/// the command that makes it.
export function describe(gen) {
    return gen && gen.filter ? filterArgs({ filter: gen.filter, pos: gen.pos || [],
                                            params: gen.params || {} })
                             : '';
}

/// Just the arguments, for the field that edits them. Empty for a filter
/// configured with nothing, which is a real state — `allrgb` takes no size.
export function argsOf(gen) {
    const all = describe(gen);
    const at = all.indexOf('=');
    return at < 0 ? '' : all.slice(at + 1);
}

/// The `-i` a generator is: `-f lavfi -i testsrc=size=640x360`.
///
/// **One home, because two things open it.** `settle()` below registers it for
/// the program monitor, and `ui/graph/playback.js` hands the same description to
/// `views.define` when a filter of somebody's has been put on the clip — a view
/// being an input plus a chain. Written twice, a `hue` on a colour card would be
/// shown over a differently-opened source from the one the bar was playing.
///
/// It is deliberately *not* the shape a render uses: the render puts the filter
/// in the graph, where it belongs, and never opens the demuxer at all. This is
/// the same picture spelled the other of ffmpeg's two ways, for the one consumer
/// that takes a src string — see the header.
export function inputFor(gen) {
    return { path: describe(gen), format: 'lavfi' };
}

/// What this build says the filter is for, for the picker.
export function summaryOf(filter) {
    const info = infoOf(filter);
    return (info && info.description) || '';
}

/// Why this filter cannot be what a clip is cut from, or '' when it can.
///
/// **One home, and both callers need it for different reasons.** This is the door
/// — `settle()` below says no before there is a clip, and `addGenerator` puts the
/// sentence on the screen. `graph/derive.js` asks the same question of a *spec*,
/// because it is a pure function of one and a spec written by hand in a test never
/// came through here; without it the derivation would draw a graph with an empty
/// socket in it and let libavfilter refuse the render afterwards, with a message
/// about a pad rather than about the thing somebody did.
///
/// All three refusals are statements about the **timeline** rather than about the
/// filter. libavfilter would open `sine` quite happily; what it hands back is a
/// clip with no picture, which is a bar the viewer has nothing to put on the
/// canvas for. See `pictureSources()`.
export function whyNotAClip(gen) {
    const pads = padsOf(gen.filter, gen.params, gen.pos);
    if (!pads) return `this build of ffmpeg has no filter called ${gen.filter}`;
    if (!isSource(gen.filter) || pads.ins.length)
        return `${gen.filter} reads a pad, so it cannot be what a clip is cut from — ` +
               'wire one up on the Graph stage instead';
    if ((pads.outs[0] || '') !== 'v')
        return `${gen.filter} makes sound rather than pictures, and a clip on the ` +
               'timeline is somewhere a picture goes';
    return '';
}

// ── the registry ───────────────────────────────────────────────────────────
//
// One entry per distinct set of arguments; see the header for why it is keyed
// that way and why nothing prunes it.
//
// **A record is treated as immutable.** `withArgs()` builds a new one rather than
// writing into the old, `makeGenerator` hands it to the clip as it is, and
// `derive.js` copies its `pos` and `params` into the graph node like every other
// node's. That is what makes it safe for two clips of one generator to hold the
// same object — exactly as two clips of one file hold the same input.

const settled = new Map();

let seq = 0;

/// Open a generator: ask libavfilter what it produces, and register it so that a
/// `<video>` can play it.
///
/// Returns `{ ok: true, gen, name, src, probe, width, height, fps }` or
/// `{ ok: false, why }` with libav's own sentence in it. The caller decides what
/// to do about a refusal, because the two callers want different things: adding
/// one says so on the screen and makes no clip, and opening a document lists it
/// among the clips it could not lay out.
///
/// Idempotent, and that is what makes it callable from a document reconcile: the
/// same arguments answer with the same registration and open nothing. A refusal
/// is remembered too — a generator whose filter this build does not have would
/// otherwise be re-probed on every undo, each time writing libav's four lines
/// into the report.
export function settle(gen) {
    if (!gen || !gen.filter) return { ok: false, why: 'no generator' };
    // Refused before libavfilter is asked to open anything, because these three
    // are about the timeline rather than about the filter.
    const bad = whyNotAClip(gen);
    if (bad) return { ok: false, why: bad };

    const name = describe(gen);
    const had = settled.get(name);
    if (had) return had;

    // The one `-i` this generator is, which is the same string again with `-f
    // lavfi` in front of it. Probed first: the answer is what the clip is laid
    // out at, and a spec that will not parse must not become a registration
    // something can be pointed at.
    const input = inputFor(gen);
    let answer;
    try {
        const probe = bro.ffmpeg.probe(input);
        if (!probe || !probe.video) throw new Error(`${gen.filter} produced no picture`);
        answer = {
            ok: true,
            gen: { filter: gen.filter, pos: (gen.pos || []).slice(),
                   params: Object.assign({}, gen.params) },
            name, probe,
            src: bro.ffmpeg.inputs.define(`gen-${++seq}`, input),
            width: probe.video.displayWidth,
            height: probe.video.displayHeight,
            fps: probe.video.fps || 0,
        };
    } catch (e) {
        answer = { ok: false, why: String((e && e.message) || e) };
    }
    settled.set(name, answer);
    return answer;
}
