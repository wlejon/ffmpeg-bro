// The decision to copy a stream rather than encode it.
//
// A copied stream is the bytes that were already there: no decode, no filter,
// no scale, no encoder. That is what makes a rewrap instant and a cut lossless,
// and it is also what makes it the one row on the Write stage that **conflicts
// with the edit**. A crop, a filter, a canvas of a different size, a second clip
// — none of them reach a stream that is not decoded, so each has to be refused
// where the decision is taken rather than discovered in the file afterwards.
//
// Two things live here because three places need them and a second copy of
// either would be a second answer:
//
//   - **What `copy:0:1` means**, written and read in one place. It is `-map 0:1`
//     and nothing else: an input index and a stream index in it.
//   - **Where the keyframes are.** A copy can only begin at one, so the
//     in-point has to be snapped to a keyframe or the difference has to be said
//     out loud. The list comes from `bro.ffmpeg.keyframes`, which asks the
//     demuxer's own index, and it is cached per input and stream because the
//     stream list is rebuilt on every keystroke in a language field.

import { inputs, asInput, lengthOf } from '../inputs.js';

/// `copy:0:1` → `{ input: 0, stream: 1 }`, or null for a composed source.
export function parseCopy(source) {
    const m = /^copy:(\d+):(\d+)$/.exec(String(source || ''));
    if (!m) return null;
    return { input: Number(m[1]), stream: Number(m[2]) };
}

export function isCopy(row) {
    return !!parseCopy(row && row.source);
}

export const copySource = (input, stream) => `copy:${input}:${stream}`;

/// Every input stream a row of this kind could be fed from, in `-map` order.
///
/// Read out of the probe rather than out of a list here, so an input this build
/// cannot decode is still offered — a copy does not decode, which is exactly
/// the case where copying is the only thing that will work at all.
export function copyChoices(kind) {
    const out = [];
    inputs.forEach((input, i) => {
        const probe = input.probe;
        if (!probe) return;
        for (const s of probe.streams) {
            if (s.kind !== kind) continue;
            out.push({
                input: i,
                stream: s.index,
                id: copySource(i, s.index),
                label: `${input.name} · ${s.index}: ${s.codec}` +
                       (s.kind === 'video' && s.width
                            ? ` ${s.width}×${s.height}`
                            : s.kind === 'audio' && s.channels
                                ? ` ${s.channels}ch` : ''),
            });
        }
    });
    return out;
}

/// What `probe()` said about the stream a row copies, or null.
export function copiedStream(row) {
    const at = parseCopy(row && row.source);
    if (!at) return null;
    const input = inputs[at.input];
    if (!input || !input.probe) return null;
    return input.probe.streams.find((s) => s.index === at.stream) || null;
}

export function copiedInput(row) {
    const at = parseCopy(row && row.source);
    return at ? inputs[at.input] || null : null;
}

// ── Where a copy can start ─────────────────────────────────────────────────
//
// Cached against the input's opening key and the stream, so a re-probe with a
// different demuxer answers again and a redraw does not. The answer carries
// `how` and `complete` from the native side: an index is exact and instant, a
// scan costs the window, and a list that was cut short must not be snapped to
// its last entry as though that were the end of the file.

const cache = new Map();

export function keyframesFor(row) {
    const at = parseCopy(row && row.source);
    if (!at) return null;
    const input = inputs[at.input];
    if (!input || !input.path) return null;
    const key = `${input.key}#${at.stream}`;
    if (!cache.has(key)) {
        try {
            cache.set(key, bro.ffmpeg.keyframes(asInput(input), { stream: at.stream }));
        } catch (e) {
            cache.set(key, null);
        }
    }
    return cache.get(key);
}

export function forgetKeyframes() { cache.clear(); }

/// The keyframe a copy starting at `t` would actually begin on.
///
/// At or *before*, never after: the seek is backward, because landing after
/// would drop frames the copy was asked for. Null when nothing is known, which
/// is a different answer from zero and must stay one.
export function keyframeAtOrBefore(list, t) {
    if (!list || !list.times || !list.times.length) return null;
    let best = null;
    for (const k of list.times) {
        if (k <= t + 1e-6) best = k;
        else break;
    }
    return best;
}

export function keyframeAtOrAfter(list, t) {
    if (!list || !list.times) return null;
    for (const k of list.times) if (k >= t - 1e-6) return k;
    return null;
}

/// What the in-point costs, as a sentence, or '' when it costs nothing.
///
/// **This is the whole reason the keyframes are on screen.** A copy that begins
/// a second and a half before the cut somebody made is not a bug in the render,
/// it is what a copy is — and the only unacceptable version is the one where
/// nobody was told.
export function inPointNote(row) {
    const list = keyframesFor(row);
    if (!list) return '';
    const stream = copiedStream(row);
    if (stream && stream.kind === 'audio')
        return 'every packet of a sound stream is a keyframe, so a copy starts exactly here';
    const want = Number(row.copyFrom) || 0;
    const land = keyframeAtOrBefore(list, want);
    if (land === null) return '';
    const slip = want - land;
    if (slip < 0.001)
        return `${want.toFixed(2)} s is a keyframe, so the copy starts exactly there`;
    return `the nearest keyframe at or before ${want.toFixed(2)} s is ${land.toFixed(2)} s — ` +
           `a copy can only start on one, so ${slip.toFixed(2)} s more than you asked for ` +
           'will be at the front of the file';
}

/// How long this row's copy is, in seconds, or 0 for "to the end".
export function copyLength(row) {
    const to = Number(row.copyTo) || 0;
    if (to > 0) return Math.max(0, to - (Number(row.copyFrom) || 0));
    const input = copiedInput(row);
    const total = input ? lengthOf(input) : 0;
    return total > 0 ? Math.max(0, total - (Number(row.copyFrom) || 0)) : 0;
}

/// Turn the whole output into a copy of one input — the rewrap.
///
/// **A shortcut has to leave the stream list saying what it did.** This is not
/// a mode and there is no hidden flag: it writes ordinary rows with ordinary
/// `copy:` sources, and everything about them can be read, changed and undone on
/// the rows themselves afterwards. That is the same rule the Report drawer's
/// measurement shortcuts follow — the node they add is an ordinary node.
export function rewrapRows(inputIndex, newId, span) {
    const input = inputs[inputIndex];
    if (!input || !input.probe) return [];
    const rows = [];
    for (const s of input.probe.streams) {
        if (s.kind !== 'video' && s.kind !== 'audio') continue;
        rows.push({
            id: newId(),
            kind: s.kind,
            source: copySource(inputIndex, s.index),
            metadata: {},
            bsf: [],
            copyFrom: span ? span.from : 0,
            copyTo: span ? span.to : 0,
        });
    }
    return rows;
}

/// The muxer this input's own container corresponds to, or ''.
///
/// A demuxer's name is the comma-separated list of formats it reads
/// (`mov,mp4,m4a,3gp,3g2,mj2`) and a muxer's is one name, so the first entry
/// that is also a muxer is the honest answer rather than the whole string.
/// Used to say when a rewrap is not changing the container at all, which is a
/// rewrap that does nothing.
export function containerOf(inputIndex) {
    const input = inputs[inputIndex];
    const name = input && input.probe ? input.probe.format.name : '';
    for (const part of String(name || '').split(',')) {
        if ((bro.ffmpeg.muxers || []).some((m) => m.name === part)) return part;
    }
    return '';
}
