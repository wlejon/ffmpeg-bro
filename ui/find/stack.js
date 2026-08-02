// What a search finds: a candidate, and a stack of them.
//
// A six-hour recording is not scrubbed through, it is *queried*. `ui/marks.js`
// says where something happened and `ui/transcript.js` says what was said, and
// both answer in places — a time, and a sentence, and nothing you can cut. This
// file is the step after that: the unit an editorial pass actually produces,
// which is **a span of a recording with a reason attached**, and an ordered list
// of them.
//
// **A candidate is not a clip and the difference is the whole file.** A clip is
// on the timeline, has a track, a start, a speed and a `<video>` behind it; a
// candidate is a claim that this span of this input is worth looking at. Twelve
// hundred of them come out of one word search and putting twelve hundred clips
// on a timeline to find that out would be `ui/residency.js`'s ruinous case
// reached deliberately. So a stack is plain data, costs nothing to hold, and
// becomes clips only at the one press that says so.
//
// **`why` is not decoration.** A stack that came out of four rules composed
// together is unreadable without it: "the third `yeah`", "a 6.2 s run above the
// noise floor", "*and then I said*". It is what the rows print, it is what makes
// a mix reviewable rather than a shuffle you have to trust, and it is what
// survives into the clip's name when a stack is sent to the timeline. A stack of
// anonymous spans is a stack nobody can edit with.
//
// **The clocks.** `in` and `out` are on the **input's** own seconds — the clock
// `clip.inPoint` is written against and the one `timelineTime` maps from — for
// `ui/marks.js`'s and `ui/transcript.js`'s stated reason: the span belongs to
// the file, and where it lands on a timeline is the clip's business. A candidate
// off a transcript carries the transcript's rendition's clock, which for a
// Twitch VOD is not the picture's; that is what `PAD_MIN` below is about and it
// is a measurement rather than a margin.
//
// Everything in here is **pure**: a list in, a list out, nothing mutated and
// nothing read from the world. That is what lets `ui/find/model.js` evaluate a
// whole graph on a change and lets `tests/ui_find.js` assert the arrangements
// without a document, an input or a screen.

import { WINDOW_PAD } from '../transcript.js';

/// The smallest pad a candidate off a *transcript* may carry, in seconds.
///
/// **`ui/transcript.js`'s `WINDOW_PAD` under another name, and deliberately the
/// same number.** That constant is documented there as the two clocks — the
/// audio-only and picture renditions of one Twitch VOD were measured at +0.80 s,
/// +2.21 s and +2.57 s apart, a step rather than a drift — so a span cut to the
/// word boundary is a span that sometimes does not contain the word. It is
/// imported rather than restated because it is one fact: if the measurement
/// changes, both move.
///
/// It binds a `said` candidate and not a `sound` one, and that asymmetry is the
/// point: a marks read decodes the *same* soundtrack the picture will be cut
/// from, so its seconds are already the right ones.
export const PAD_MIN = WINDOW_PAD;

/// One span of one input, with the reason it is here.
///
/// `rule` is which node produced it and `detail` is what that node found — the
/// phrase, the frequency, the length. Both are strings and both are shown; a
/// row that said only "candidate 41" would be a row nobody can act on.
export function candidate(inputId, from, to, rule, detail) {
    const a = Math.max(0, Math.min(from, to));
    const b = Math.max(from, to);
    return {
        inputId,
        in: a,
        out: b,
        rule: String(rule || ''),
        detail: String(detail || ''),
        // Where the *thing itself* is, inside the span. A padded word sits ten
        // seconds into a twenty-second candidate, and a row that could not say
        // so would be a row you have to scrub to use. Defaults to the start,
        // which is true of an unpadded one.
        at: a,
    };
}

/// How long one is.
export const lengthOf = (c) => Math.max(0, c.out - c.in);

/// The total, in seconds. What a stack's card prints beside its count, because
/// forty candidates is not a quantity anybody can picture and four minutes is.
export function totalOf(list) {
    let n = 0;
    for (const c of list) n += lengthOf(c);
    return n;
}

// ── shaping one stack ─────────────────────────────────────────────────────

/// Widen every candidate by `before` and `after`, clamped to the recording.
///
/// `durationOf(inputId)` is asked rather than passed as one number because a
/// stack can hold candidates from several inputs — a mix of two recordings is
/// the ordinary case — and clamping all of them to one file's length would run
/// the shorter one off its end. A caller with no way to answer passes null and
/// nothing is clamped, which is right for a stack whose lengths are not known
/// yet rather than a reason to invent a bound.
export function padded(list, before, after, durationOf) {
    return list.map((c) => {
        const dur = durationOf ? durationOf(c.inputId) : 0;
        const from = Math.max(0, c.in - Math.max(0, before));
        let to = c.out + Math.max(0, after);
        if (dur > 0) to = Math.min(to, dur);
        const out = Object.assign({}, c, { in: from, out: Math.max(to, from) });
        // The moment keeps its place in the file, so a padded candidate still
        // knows where its word is. Clamped into the span for the case where the
        // pad ran off the end of the recording and took the span with it.
        out.at = Math.max(from, Math.min(c.at, out.out));
        return out;
    });
}

/// Fold candidates that touch into one.
///
/// **The thing every finder needs and no finder should do itself.** A word said
/// three times in one breath is three hits ten seconds apart, and padded by ten
/// seconds each they are three overlapping twenty-second spans of the same
/// moment — cut, that is the same clip three times. `gap` is how far apart two
/// may be and still be one thing; zero means only genuine overlap merges.
///
/// Merged **within an input and in time order**, which is why it sorts first:
/// two spans of two different recordings cannot overlap however close their
/// numbers are, and a list arriving out of order — which is what `mix` produces
/// — would fold only the neighbours that happened to be adjacent.
///
/// The survivor keeps the first one's `rule` and says how many went into it,
/// because "3 hits" is the honest label for a span that contains three and
/// printing only the first would quietly under-report the recording.
export function merged(list, gap = 0) {
    const byInput = new Map();
    for (const c of list) {
        const arr = byInput.get(c.inputId) || [];
        arr.push(c);
        byInput.set(c.inputId, arr);
    }
    const out = [];
    for (const arr of byInput.values()) {
        arr.sort((a, b) => a.in - b.in);
        let cur = null;
        let held = 0;
        for (const c of arr) {
            if (cur && c.in <= cur.out + Math.max(0, gap)) {
                cur.out = Math.max(cur.out, c.out);
                held++;
                cur.detail = held > 1 ? `${held} hits` : cur.detail;
                continue;
            }
            if (cur) out.push(cur);
            cur = Object.assign({}, c);
            held = 1;
        }
        if (cur) out.push(cur);
    }
    out.sort((a, b) => (a.inputId === b.inputId
        ? a.in - b.in
        : String(a.inputId).localeCompare(String(b.inputId))));
    return out;
}

/// Drop the ones that are too short or too long. Both bounds optional; zero and
/// anything falsy mean "no bound", which is what an empty field means.
export function within(list, min, max) {
    return list.filter((c) => {
        const n = lengthOf(c);
        if (min > 0 && n < min) return false;
        if (max > 0 && n > max) return false;
        return true;
    });
}

/// The orders a stack can be put in. Named here rather than at the node so the
/// node's picker and the arrangement read from one list.
export const ORDERS = ['found', 'longest', 'shortest', 'scattered'];

/// Put a stack in an order.
///
/// `found` is the order the recording said them, which is the only one that is
/// not a rearrangement — so it is the default and the others are decisions.
///
/// **`scattered` is seeded and is not `Math.random`.** A shuffle that came out
/// differently on every redraw would make the stage flicker under the frame
/// loop and would make a document irreproducible; the seed is the caller's, so
/// re-pressing the node's die is what changes the order and a redraw never is.
export function sorted(list, order, seed = 1) {
    const out = list.slice();
    if (order === 'longest') out.sort((a, b) => lengthOf(b) - lengthOf(a));
    else if (order === 'shortest') out.sort((a, b) => lengthOf(a) - lengthOf(b));
    else if (order === 'scattered') {
        // A small xorshift, so the same seed is the same order on every machine
        // and in every run. Fisher-Yates over it.
        let s = (seed | 0) || 1;
        const rnd = () => {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            return ((s >>> 0) % 100000) / 100000;
        };
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            const t = out[i]; out[i] = out[j]; out[j] = t;
        }
    }
    return out;
}

/// A run of a stack: `count` items from `from`, both counted in items.
///
/// **Items and not seconds**, because that is what the region of an *array*
/// means and this is the operation that lets a rule apply to part of a stack —
/// "the monologues go in the second half" is `slice` feeding `every`. A count of
/// zero means to the end, so an empty field is "the rest" rather than "none".
export function slice(list, from, count) {
    const a = Math.max(0, Math.floor(from || 0));
    const n = count > 0 ? Math.floor(count) : list.length;
    return list.slice(a, a + n);
}

// ── putting two stacks together ───────────────────────────────────────────

/// Interleave: `takeA` of the first, then `takeB` of the second, over and over.
///
/// **The pattern the whole stage was asked for** — "for every 1 usage of this
/// word, play 3 of this other" is `mix(a, b, 1, 3)`. Both stacks are consumed in
/// their own order, so ordering one is a separate node and this one is only the
/// weave.
///
/// **It runs until both are empty, not until the shorter one is.** Stopping at
/// the shorter would silently discard the tail of the longer, which for a 1:3
/// against stacks of 40 and 60 is twenty candidates that were found and never
/// appeared — the kind of loss that is invisible in the result and only shows up
/// as a montage that is mysteriously short. When one side runs out the other
/// simply keeps coming, and the node's card says so by printing both counts.
export function mixed(a, b, takeA = 1, takeB = 1) {
    const na = Math.max(0, Math.floor(takeA));
    const nb = Math.max(0, Math.floor(takeB));
    const out = [];
    let i = 0, j = 0;
    // Both zero would be a loop that never ends and never emits. It is a
    // setting somebody can type, so it is answered rather than guarded against:
    // taking none of either is an empty stack.
    if (!na && !nb) return out;
    while (i < a.length || j < b.length) {
        const startI = i, startJ = j;
        for (let k = 0; k < na && i < a.length; k++) out.push(a[i++]);
        for (let k = 0; k < nb && j < b.length; k++) out.push(b[j++]);
        if (i === startI && j === startJ) break;
    }
    return out;
}

/// Put one of `b` after every `n`th of `a`.
///
/// The other half of what was asked for — "the monologues get fit in every
/// third" — and it is **not** `mixed` with a ratio, which is the distinction
/// worth keeping. `mixed` weaves two streams and both run out when they run out;
/// this one treats `a` as the spine and `b` as something placed *into* it, so
/// the result is `a` in its own order with `b` interposed, and `b` running out
/// leaves the rest of `a` intact and continuous.
///
/// What is left of `b` when `a` ends is appended rather than dropped, for
/// `mixed`'s reason: a candidate that was found and then silently discarded is
/// the failure this file is trying not to have.
export function everyNth(a, b, n = 3) {
    const step = Math.max(1, Math.floor(n));
    const out = [];
    let j = 0;
    for (let i = 0; i < a.length; i++) {
        out.push(a[i]);
        if ((i + 1) % step === 0 && j < b.length) out.push(b[j++]);
    }
    while (j < b.length) out.push(b[j++]);
    return out;
}

// ── what a stack says about itself ────────────────────────────────────────

/// A one-line summary for a card: how many, how long, and out of how many files.
///
/// The seconds are there because a count alone cannot be judged — forty
/// candidates is four minutes at six seconds each and forty minutes at sixty,
/// and those are different things to be about to put on a timeline.
export function summaryOf(list) {
    if (!list || !list.length) return 'nothing';
    const secs = totalOf(list);
    const files = new Set(list.map((c) => c.inputId)).size;
    const bits = [`${list.length} clip${list.length === 1 ? '' : 's'}`, showTime(secs)];
    if (files > 1) bits.push(`${files} recordings`);
    return bits.join(' · ');
}

/// Seconds as something readable at both ends of the range this deals in — a
/// two-second candidate and a six-hour recording — without pulling in the
/// timecode formatter, which is frame-accurate and about a *position* where this
/// is a duration.
export function showTime(s) {
    const n = Math.max(0, s);
    if (n < 60) return `${n.toFixed(1)}s`;
    const m = Math.floor(n / 60);
    if (m < 60) return `${m}m ${String(Math.round(n % 60)).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/// Where a candidate is in its recording, as a stamp a person can read back to
/// the source. `1:04:12`, and hours only when there are any.
export function showAt(s) {
    const n = Math.max(0, Math.floor(s));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = n % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0');
    return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}
