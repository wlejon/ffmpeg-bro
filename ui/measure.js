// Filters whose output is information, and the verb that goes with each.
//
// A whole family of libavfilter's filters answers a question rather than
// changing a picture — `cropdetect`, `blackdetect`, `blackframe`,
// `freezedetect`, `scdet`, `silencedetect`, `ebur128`, `signalstats`, `astats`,
// `psnr`, `ssim`, `libvmaf`. **There is no list of them here and there must not
// be.** What distinguishes one is not its name, it is that it emits frame
// metadata or logs, and chunk 2's channel already captures both from every
// filter in the graph. Put any of the four hundred and eighty-eight on the
// graph and what it says arrives; that is the mechanism and it stays the
// mechanism.
//
// What *is* written down here is the **verb**, and it has to be, because a verb
// is a specific claim about a specific quantity. Nothing generic can know that
// `lavfi.cropdetect.w` is a width in pixels of the picture that filter was
// looking at, or that ebur128's summary is the four numbers `loudnorm` calls
// `measured_*`. So each entry below is one such claim, and every one of them
// follows the same three steps — the shape `graph/enable.js` uses for the same
// reason:
//
//   **parse → refuse-or-offer → apply.**
//
// - **Parse** what the filter said. Some of it is metadata and some of it is a
//   log line, and the two are read the same way: `cropdetect` prints its
//   rectangle and hangs the same numbers on the frame, `blackdetect` prints
//   spans and hangs `lavfi.black_start` on one. Parsing happens **here, in the
//   application, over records the channel already holds**, and it is safe for
//   the reason parsing an `enable` expression is safe: it reads, it never
//   writes, and what it produces is an *offer* that a person accepts. Nothing
//   is applied because something parsed.
// - **Refuse** rather than approximate. `cropdetect` that has not settled, an
//   `ebur128` that has not printed its summary, a scan that found nothing to
//   cut: each of those is a sentence saying which, not a button that does
//   something plausible. A measurement acted on too early is worse than one
//   that could not be acted on at all, because it looks like it worked.
// - **Apply** visibly, and never by rewriting what somebody typed. A crop
//   becomes a `crop` node on the graph, at the point the measurement was taken
//   at, carrying the four numbers exactly as `cropdetect` printed them — so the
//   raw value and the applied value are the same characters and there is
//   nothing to compare. Loudness becomes a `loudnorm` node on the sound. Cut
//   points become cuts on the timeline.
//
// The raw text every finding was read out of travels with it and is shown, for
// the reason the command bar prints the invocation: an application whose
// argument is that ffmpeg should stop being guessed at cannot hand somebody a
// number and hide where it came from.
//
// The one thing here that is not a verb or a parse is the **toggle at the bottom
// of the file**: whether a finding that has gone stale is allowed to measure
// itself again. It is off by default and it is stored on its own, and the block
// above it is why.

import * as overlay from './graph/overlay.js';
import { infoOf } from './graph/filters.js';
import { COMPOSITE_POINT, MIX_POINT } from './graph/derive.js';

// ── where a measurement goes ───────────────────────────────────────────────
//
// Two named points, because those are the two things anybody measures: the
// whole picture as it will be written, and the whole soundtrack as it will be
// written. Both are `derive.js`'s own anchors — taken from it rather than
// written out again, because an insert whose anchor no derivation declares is
// dropped in silence, so a name typed wrong here would be a button that does
// nothing at all — so a filter put here is a filter on the graph, visible on
// the Graph stage, printed by the command bar and run by libavfilter, rather
// than something this file does privately.
const PICTURE = COMPOSITE_POINT;
const SOUND = MIX_POINT;

/// What can be measured, offered where somebody would want it.
///
/// **This is a shortcut, not the mechanism.** Every one of these is an ordinary
/// filter that the Graph stage's palette already offers, with the options the
/// column already edits; what an offer adds is knowing *where* it goes and
/// which of its options make it answer at all — `ebur128` says nothing at all
/// without `metadata=1`, and its true peak needs `peak=true`, which is exactly
/// the sort of thing nobody should have to find out by getting an empty report.
///
/// Filtered against `bro.ffmpeg.filters`, so a build without one does not offer
/// it. There is no list of supported filters in this application and this is
/// not one: it is a list of *suggestions*, and the palette is still the whole
/// registry.
const OFFERS = [
    { filter: 'cropdetect', at: PICTURE, label: 'Crop',
      params: { limit: '24', round: '2', reset: '1' },
      hint: 'find the black bars — the numbers it settles on can be applied as a crop' },
    { filter: 'blackdetect', at: PICTURE, label: 'Black',
      params: { d: '0.1' },
      hint: 'find stretches of black — each becomes a point you can cut at' },
    { filter: 'scdet', at: PICTURE, label: 'Scenes',
      params: {},
      hint: 'find where the picture changes — each becomes a point you can cut at' },
    { filter: 'freezedetect', at: PICTURE, label: 'Freezes',
      params: { d: '0.5' },
      hint: 'find stretches where nothing moves' },
    { filter: 'signalstats', at: PICTURE, label: 'Levels',
      params: {},
      hint: 'luma and chroma statistics, frame by frame' },
    { filter: 'silencedetect', at: SOUND, label: 'Silence',
      params: { d: '0.5' },
      hint: 'find stretches of silence — each becomes a point you can cut at' },
    { filter: 'ebur128', at: SOUND, label: 'Loudness',
      // Both of these are the difference between a filter that answers and one
      // that runs and says nothing: without `metadata` there is no series, and
      // without `peak` there is no true peak, which is the one number
      // `loudnorm` cannot do without.
      params: { metadata: '1', peak: 'true' },
      hint: 'EBU R128 loudness — what it measures can be normalised with loudnorm' },
    { filter: 'astats', at: SOUND, label: 'Sound levels',
      params: { metadata: '1' },
      hint: 'peak, RMS and the rest, per audio frame' },
];

export function offers() {
    return OFFERS.filter((o) => !!infoOf(o.filter));
}

/// The insert records for a filter of this name, whatever point it is at.
///
/// A measurement somebody put on the graph by hand — through the palette, at a
/// point of their choosing — is the same thing as one this file offered, and
/// has to be found the same way. There is no separate register of "measurements
/// this application started".
export function measuring(filter) {
    return overlay.inserts().filter((r) => r.filter === filter);
}

/// Put one on the graph. Returns the insert record, so a caller can select it.
export function startMeasuring(id) {
    const o = OFFERS.find((x) => x.filter === id);
    if (!o) return null;
    return overlay.insert(o.at, o.filter, { params: o.params });
}

/// Take every copy of one off again.
export function stopMeasuring(filter) {
    let any = false;
    for (const rec of measuring(filter)) any = overlay.removeInsert(rec.id) || any;
    return any;
}

// ── reading what came back ─────────────────────────────────────────────────

/// The `AVClass` name libavfilter gives an instance of a filter, which is what
/// arrives on a log record as `source`: `Parsed_cropdetect_0`. It is the only
/// thing tying a line of text to the filter that said it, and it is libav's own
/// naming rather than ours.
function saidBy(messages, filter) {
    const head = `Parsed_${filter}_`;
    return messages.filter((m) => m.source && m.source.indexOf(head) === 0);
}

/// Everything one filter said in one render, as one blob.
///
/// libav writes a multi-line summary as one call and the channel keeps it as
/// one record; it also writes some lines in pieces. Joining every record from
/// the one source and reading the blob works either way, which is what makes
/// this robust rather than dependent on where libav happened to put its
/// newlines.
function blobOf(messages, filter, job) {
    return saidBy(messages, filter)
        .filter((m) => !job || m.job === job)
        .map((m) => m.text)
        .join('\n');
}

/// The last value of a series, as a number, or null.
function lastOf(series, key) {
    const s = series.get ? series.get(key) : null;
    if (!s || !s.points.length) return null;
    for (let i = s.points.length - 1; i >= 0; i--)
        if (Number.isFinite(s.points[i].v)) return s.points[i].v;
    return null;
}

/// A series as a list of `{t, v}` for reading spans out of.
function pointsOf(series, key) {
    const s = series.get ? series.get(key) : null;
    return s ? s.points : [];
}

// ── the verbs ──────────────────────────────────────────────────────────────

/// `cropdetect` → the crop it found, applied.
///
/// The numbers come from the metadata, which is the same four numbers the
/// filter prints as `crop=w:h:x:y` — and the printed line is carried through as
/// the raw text, because what gets put on the graph is those characters
/// unchanged. Nothing is normalised, rounded or re-derived on the way: a crop
/// that differed from the line `cropdetect` printed would be this application
/// having an opinion about somebody's footage.
function cropFinding(ctx) {
    const anchor = anchorFor('cropdetect');
    const f = { id: 'cropdetect', filter: 'cropdetect', title: 'Crop', anchor };
    const w = lastOf(ctx.series, 'lavfi.cropdetect.w');
    const h = lastOf(ctx.series, 'lavfi.cropdetect.h');
    const x = lastOf(ctx.series, 'lavfi.cropdetect.x');
    const y = lastOf(ctx.series, 'lavfi.cropdetect.y');
    const said = blobOf(ctx.messages, 'cropdetect', ctx.job);
    const printed = /crop=(\d+):(\d+):(-?\d+):(-?\d+)/.exec(said);

    if (w === null || h === null || x === null || y === null) {
        if (!printed)
            return refusal(f, 'cropdetect has measured nothing yet — render, and its ' +
                              'numbers arrive frame by frame');
        return offer(f, [Number(printed[1]), Number(printed[2]),
                         Number(printed[3]), Number(printed[4])], printed[0], ctx);
    }

    // **Has it settled?** cropdetect accumulates: its answer only widens as it
    // sees more of the picture, so the useful question is whether the last
    // third of the render still moved it. One that has not settled is offered
    // as a refusal naming both answers, because applying the running total of a
    // filter that is still finding letterbox is how a shot loses its edges.
    const ws = pointsOf(ctx.series, 'lavfi.cropdetect.w');
    const hs = pointsOf(ctx.series, 'lavfi.cropdetect.h');
    const settled = (pts, end) => {
        const from = Math.floor(pts.length * 0.66);
        for (let i = from; i < pts.length; i++)
            if (Number.isFinite(pts[i].v) && pts[i].v !== end) return pts[i].v;
        return null;
    };
    const movedW = ws.length > 6 ? settled(ws, w) : null;
    const movedH = hs.length > 6 ? settled(hs, h) : null;
    if (movedW !== null || movedH !== null)
        return refusal(f, `cropdetect has not settled — it was still finding ` +
            `${movedW === null ? w : movedW}×${movedH === null ? h : movedH} in the last ` +
            `third and ended on ${w}×${h}. Render more of it, or set reset=0 so one ` +
            `answer covers the whole range.`);

    return offer(f, [w, h, x, y], printed ? printed[0] : `crop=${w}:${h}:${x}:${y}`, ctx);
}

function offer(f, [w, h, x, y], raw, ctx) {
    const full = ctx.width > 0 && ctx.height > 0 && w >= ctx.width && h >= ctx.height;
    f.raw = raw;
    f.detail = `${w}×${h} at ${x},${y}`;
    if (full)
        return Object.assign(f, { ok: true, reason:
            'cropdetect found nothing to crop — the picture reaches every edge of the ' +
            'frame, so a crop here would take away something rather than nothing.' });
    f.ok = true;
    f.verb = {
        label: `Crop to ${w}×${h}`,
        hint: `puts crop=${w}:${h}:${x}:${y} on the graph, straight after the cropdetect ` +
              `that measured it`,
        apply(hooks) {
            // At cropdetect's own point, which puts it *after* cropdetect —
            // several filters at one point run in the order they were added.
            // Anywhere else would be a crop measured on one picture and applied
            // to another.
            const rec = overlay.insert(f.anchor || PICTURE, 'crop',
                                       { pos: [String(w), String(h), String(x), String(y)] });
            if (hooks && hooks.flash) hooks.flash(`crop=${w}:${h}:${x}:${y} is on the graph`);
            return rec;
        },
    };
    return f;
}

/// `ebur128` → `loudnorm`'s measured parameters.
///
/// This is ffmpeg's own two-pass loudness normalisation and the numbers are the
/// whole of it: measure with one filter, apply with another that is told what
/// the first found. Read out of ebur128's **summary**, which it prints at end
/// of input and nowhere else — so a render that is still going, or one that was
/// stopped, has not produced one and this refuses rather than normalising to
/// half a measurement.
function loudnessFinding(ctx) {
    const anchor = anchorFor('ebur128');
    const f = { id: 'ebur128', filter: 'ebur128', title: 'Loudness', anchor };
    const said = blobOf(ctx.messages, 'ebur128', ctx.job);
    // Structural rather than one regex over the blob: there are two lines
    // reading `Threshold:` and they belong to different measurements, so the
    // integrated one is found by looking after the heading it sits under.
    const iAt = said.indexOf('Integrated loudness');
    const lraAt = said.indexOf('Loudness range');
    const after = (from, re) => {
        if (from < 0) return null;
        const m = re.exec(said.slice(from));
        return m ? Number(m[1]) : null;
    };
    const I = after(iAt, /\bI:\s*(-?[\d.]+)\s*LUFS/);
    const thresh = after(iAt, /\bThreshold:\s*(-?[\d.]+)\s*LUFS/);
    const LRA = after(lraAt, /\bLRA:\s*(-?[\d.]+)\s*LU\b/);
    const TP = after(said.indexOf('True peak'), /\bPeak:\s*(-?[\d.]+)\s*dBFS/);

    const live = lastOf(ctx.series, 'lavfi.r128.I');
    if (I === null || thresh === null || LRA === null) {
        return refusal(f, live === null
            ? 'ebur128 has said nothing yet. It needs metadata=1 to report frame by ' +
              'frame, and it prints the summary loudnorm needs only at the end of a render.'
            : `the running loudness is ${live.toFixed(1)} LUFS, but ebur128 prints the ` +
              'summary loudnorm is told — integrated, range and threshold — only when it ' +
              'reaches the end of its input. Let the render finish.');
    }
    if (TP === null)
        return refusal(f, 'ebur128 measured the loudness but not the true peak, which ' +
            'loudnorm needs to know how much headroom there is. Set peak=true on the ' +
            'ebur128 node and measure again.');

    f.ok = true;
    f.raw = `I: ${I} LUFS · LRA: ${LRA} LU · Threshold: ${thresh} LUFS · Peak: ${TP} dBFS`;
    f.detail = `${I.toFixed(1)} LUFS, range ${LRA.toFixed(1)} LU, peak ${TP.toFixed(1)} dBFS`;
    const target = { I: -16, LRA: 11, TP: -1.5 };
    f.verb = {
        label: `Normalise to ${target.I} LUFS`,
        hint: 'puts loudnorm on the sound, told what ebur128 just measured — which is ' +
              "ffmpeg's own two-pass loudness normalisation, and the only version of it " +
              'that is not a guess',
        apply(hooks) {
            const rec = overlay.insert(f.anchor || SOUND, 'loudnorm', { params: {
                I: String(target.I), LRA: String(target.LRA), TP: String(target.TP),
                measured_I: String(I), measured_LRA: String(LRA),
                measured_TP: String(TP), measured_thresh: String(thresh),
                linear: 'true',
            } });
            if (hooks && hooks.flash)
                hooks.flash(`loudnorm is on the graph, measured at ${I.toFixed(1)} LUFS`);
            return rec;
        },
    };
    return f;
}

/// The three filters that answer with *spans* — a stretch of black, of silence,
/// of nothing moving — and the one that answers with instants.
///
/// All four are read the same way and the difference is only which keys they
/// hang on the frame, so this is one function taking the pair of names rather
/// than four near-copies. The verb is the same too: a span has two ends and a
/// cut point is an end, which is the thing an edit can be made to agree with.
function spanFinding(ctx, spec) {
    const anchor = anchorFor(spec.filter);
    const f = { id: spec.filter, filter: spec.filter, title: spec.title, anchor };
    const spans = [];
    let open = null;
    // Metadata first: `lavfi.black_start` and `lavfi.black_end` arrive on the
    // frames the transition happened on, which is more precise than the log
    // line and is in the render's own seconds either way.
    const starts = pointsOf(ctx.series, spec.start);
    const ends = pointsOf(ctx.series, spec.end);
    const events = starts.map((p) => ({ t: value(p), open: true }))
        .concat(ends.map((p) => ({ t: value(p), open: false })))
        .filter((e) => Number.isFinite(e.t))
        .sort((a, b) => a.t - b.t);
    for (const e of events) {
        if (e.open) { if (open === null) open = e.t; }
        else if (open !== null) { spans.push({ from: open, to: e.t }); open = null; }
        else spans.push({ from: e.t, to: e.t });
    }
    if (open !== null) spans.push({ from: open, to: null });

    // And the log, for the filters that only print — and as the raw text, which
    // travels with every finding here.
    const said = blobOf(ctx.messages, spec.filter, ctx.job);
    if (!spans.length && spec.logRe) {
        let m;
        const re = new RegExp(spec.logRe.source, 'g');
        while ((m = re.exec(said))) {
            const from = Number(m[1]);
            const to = m[2] === undefined ? null : Number(m[2]);
            if (Number.isFinite(from)) spans.push({ from, to });
        }
    }

    f.raw = said.split('\n').filter((l) => l.indexOf(spec.filter.slice(0, 5)) >= 0 ||
                                            /_start|_end|time:/.test(l)).join('\n') || said;
    if (!spans.length)
        return refusal(f, `${spec.filter} found nothing. That is an answer — ${spec.nothing}`);

    f.ok = true;
    f.spans = spans;
    f.detail = spans.length === 1
        ? spanText(spans[0])
        : `${spans.length} × ${spec.noun}, ${spanText(spans[0])} onwards`;

    // The cuts are the *ends* of the spans, deduplicated and sorted: a stretch
    // of black between two shots is two cuts, one at each edge, and cutting
    // only at the start would leave the black stuck to the head of the shot
    // after it.
    const cuts = [];
    for (const s of spans) {
        cuts.push(s.from);
        if (s.to !== null && s.to !== s.from) cuts.push(s.to);
    }
    cuts.sort((a, b) => a - b);
    const uniq = cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 1e-3);

    f.verb = {
        label: uniq.length === 1 ? 'Cut there' : `Cut at these ${uniq.length} points`,
        hint: 'splits every clip the point falls inside, on the timeline, where the cut ' +
              'is a thing you can then move or undo by joining nothing',
        apply(hooks) {
            let made = 0;
            // Back to front: a split changes where the clips after it begin, and
            // cutting from the end means every remaining point still names the
            // moment it named when it was measured.
            for (let i = uniq.length - 1; i >= 0; i--)
                made += (hooks && hooks.splitAt ? hooks.splitAt(uniq[i]) : 0);
            if (hooks && hooks.flash)
                hooks.flash(made ? `Cut at ${made} point${made === 1 ? '' : 's'}`
                                 : 'None of those points falls inside a clip');
            return made;
        },
    };
    return f;
}

/// A metadata value that is a time. `lavfi.black_start` carries the moment as
/// its *value*; `lavfi.scd.time` does the same. Where a filter carries no value
/// the frame's own timestamp is the moment, which is what `p.t` is.
function value(p) {
    const v = Number(p.raw);
    return Number.isFinite(v) ? v : p.t;
}

function spanText(s) {
    const a = s.from.toFixed(2);
    return s.to === null || s.to === s.from ? `at ${a}s` : `${a}–${s.to.toFixed(2)}s`;
}

function refusal(f, reason) {
    f.ok = false;
    f.reason = reason;
    return f;
}

/// Where a filter of this name sits on the graph, so that what is applied goes
/// in beside what measured it.
///
/// **Anchors, not positions** — the same rule the rest of the overlay follows.
/// A measurement inserted at a clip's `after-decode` point measured the source
/// at its own size, and a crop derived from it belongs there and nowhere else;
/// applying it after compositing would be four numbers about one picture
/// applied to a different one.
function anchorFor(filter) {
    const recs = measuring(filter);
    return recs.length ? recs[recs.length - 1].anchor : null;
}

// ── everything that can be read out of one render ──────────────────────────

const SPANS = [
    { filter: 'blackdetect', title: 'Black', noun: 'stretch of black',
      start: 'lavfi.black_start', end: 'lavfi.black_end',
      logRe: /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/,
      nothing: 'nothing in the range was black for as long as its d= says.' },
    { filter: 'silencedetect', title: 'Silence', noun: 'silence',
      start: 'lavfi.silence_start', end: 'lavfi.silence_end',
      logRe: /silence_start:\s*(-?[\d.]+)(?:[\s\S]*?silence_end:\s*([\d.]+))?/,
      nothing: 'nothing in the range was quieter than its noise= for as long as its d=.' },
    { filter: 'freezedetect', title: 'Freezes', noun: 'freeze',
      start: 'lavfi.freezedetect.freeze_start', end: 'lavfi.freezedetect.freeze_end',
      logRe: /freeze_start:\s*([\d.]+)(?:[\s\S]*?freeze_end:\s*([\d.]+))?/,
      nothing: 'the picture moved throughout.' },
    { filter: 'scdet', title: 'Scenes', noun: 'change',
      start: 'lavfi.scd.time', end: '',
      logRe: /lavfi\.scd\.time:\s*([\d.]+)()/,
      nothing: 'the picture never changed by more than its threshold.' },
];

/// Every finding one render supports, in the order they are worth reading.
///
/// `ctx` is `{ series, messages, job, width, height }` — the report's own state
/// and the size of the picture, which is the only thing here that is not in the
/// channel and is needed to say whether a crop would take anything off.
export function findings(ctx) {
    const out = [];
    // Three ways a measurement can be present, and all of them count: the
    // filter is on the graph, it said something in the log, or a series it
    // names arrived. The last matters because a filter's metadata keys are not
    // its name — `ebur128` hangs `lavfi.r128.*` on a frame — so a render whose
    // graph has since changed still has its answers read.
    const has = (filter, prefix) =>
        measuring(filter).length > 0 ||
        ctx.messages.some((m) => m.source && m.source.indexOf(`Parsed_${filter}_`) === 0) ||
        (ctx.series.keys ? Array.from(ctx.series.keys())
            .some((k) => k.indexOf(prefix) === 0) : false);
    if (has('cropdetect', 'lavfi.cropdetect.')) out.push(cropFinding(ctx));
    if (has('ebur128', 'lavfi.r128.')) out.push(loudnessFinding(ctx));
    for (const spec of SPANS)
        if (has(spec.filter, spec.start)) out.push(spanFinding(ctx, spec));
    return out;
}

// ── measuring again, without being asked ───────────────────────────────────
//
// A finding that has stopped describing the edit says so and stops being offered
// — `ui/report.js` withdraws the button and keeps the sentence, which is this
// file's own rule about a measurement acted on too late. `Measure now` puts it
// right in one press, and for a long time that press was the only way: deciding
// to spend a render unasked is a decision about somebody's machine and not about
// this code, and a 4K graph re-run every time a clip is nudged is a decision
// nobody would thank us for having taken for them.
//
// **A toggle, off by default**, is the whole of the answer. With it off nothing
// has changed and the press is still the only way. With it on, the question "is a
// render cheap enough to spend without being asked" has been answered by the
// person whose machine it is, which was the only thing missing.
//
// **It keeps its own storage key rather than going in `store.adopt`'s blob**,
// which is where every other remembered preference lives. Three reasons, and the
// last is the one that decides it:
//
//   - It is not a setting of the render. It names no muxer, no encoder and no
//     option, and in `ExportSettings` it would be a key nothing consumes.
//   - `remember()` writes that blob when a render *starts*, on purpose — so a
//     toggle pressed and never rendered with would be a toggle that did not stick,
//     and writing the blob on the press instead is precisely the hazard that rule
//     exists to prevent.
//   - Everything in that blob is in the Encode and Write stages' undo stack. A
//     `Ctrl-Z` there that silently turned re-measuring on is exactly the surprise
//     the two stacks exist to prevent, and this control is drawn in the report
//     drawer, which is under every stage rather than on either of those two.
//
// `ui/graph/overlay.js` keeps its own key for the same shape of reason. What is
// shared is the *rule* rather than the reader: the read is version-tolerant, which
// here means one boolean coerced out of whatever is in there and off when there is
// nothing.

const AUTO_KEY = 'ffmpeg-bro.measure';

let auto = readAuto();

function readAuto() {
    try {
        const saved = localStorage.getItem(AUTO_KEY);
        const blob = saved ? JSON.parse(saved) : null;
        return !!(blob && typeof blob === 'object' && blob.remeasure);
    } catch (e) {
        return false;      // never set, or written by a shape that is not this one
    }
}

/// Should a finding that has gone stale measure itself again?
///
/// Read rather than pushed, because the one caller asks it once per attempt and a
/// second copy of the flag on the drawing side is a second answer to what the
/// toggle says. **False on a machine that has never pressed it**, which is the
/// entire point: the alternative rejected was doing it always, and the objection
/// to that was never the mechanism.
export function autoRemeasure() { return auto; }

/// Say so, and remember it.
///
/// An object under the key rather than a bare `true`, so a second preference about
/// measuring has somewhere to go without a migration. Written on the press, which
/// is the opposite of the export blob's rule and safe for the opposite reason:
/// there is one boolean here, it belongs to no muxer, and there is no
/// half-finished state to catch on the way past.
export function setAutoRemeasure(on) {
    auto = !!on;
    try { localStorage.setItem(AUTO_KEY, JSON.stringify({ remeasure: auto })); }
    catch (e) { /* not fatal: the toggle still holds for this run */ }
    return auto;
}

/// The spans a set of findings would draw on a plot's ruler, so the numbers and
/// the moments a filter found are one picture rather than two panels.
export function marksOf(list) {
    const marks = [];
    for (const f of list)
        for (const s of (f.spans || []))
            marks.push({ t: s.from, to: s.to === null ? undefined : s.to });
    return marks;
}
