// What a data stream turned out to carry, and which of it is on the timeline.
//
// A data track is the one stream this application could describe and never
// read: `gpmd`, `tmcd` and `mebx` all probe as `bin_data`, and the fourcc is the
// whole identity of one. `bro.ffmpeg.data` is the other half of that now —
// there is a parser for `gpmd` and the dispatch is the tag — and this is the
// model between it and the screen.
//
// Three decisions are worth stating.
//
// **A reading belongs to an input, not to a clip.** The telemetry is in the
// file: two clips cut from one recording are two views of one set of samples,
// and reading it twice would be reading the same 4.5 MB twice to get the same
// answer. So the reading is keyed by input and stream, and the lane maps it
// through each clip's own placement and speed the way `columnsOf` maps a
// waveform — which is also what makes a series follow a clip that is trimmed,
// moved or sped up without being re-read.
//
// **It is not in the document, for the reason `peaks` is not.** A reading is
// derived from a file: `ui/document.js` writes nothing derived, because storing
// an answer the next reopen may contradict is how a document comes to disagree
// with the file it describes. What is *not* saved either is which series you
// picked, and that one is a genuine loss rather than a rule — see the note on
// `picked` below.
//
// **The read is asked for and never automatic.** A probe happens because a file
// was added; this happens because somebody pressed `Read` on the Sources stage.
// The difference is that a probe is what makes an input usable at all, and this
// is 32 ms of disk for a 4 GB file that most edits have no use for. Offering it
// where it will work — and only there — is `bro.ffmpeg.data.parsers()`, asked of
// the native registry rather than written down here, so a second parser needs no
// edit in this file.

import { changed } from './project.js';
import { nextColor, MAX_SERIES } from './plot.js';

/// Every reading, in flight or finished, by `${input.id}:${streamIndex}`.
///
/// `{ inputId, streamIndex, tag, id, state, elapsed, error, reading }` where
/// `state` is `reading` | `done` | `failed` | `stopped`. Held here rather than
/// on the input for the reason the whole module exists: the Sources stage, the
/// timeline lane and the poll all want the same object, and hanging it off the
/// input would put a derived answer inside the thing `ui/document.js` walks.
const readings = new Map();

/// Which series are drawn, in the order they were picked, with the colour each
/// was given.
///
/// `{ id, inputId, streamIndex, key, component, color }`. **Not persisted**,
/// which is the one thing here that is a gap rather than a decision: a pick is
/// an editorial choice like a selected clip, and losing it on reopen costs a
/// press rather than any work. Putting it in the document would mean it
/// surviving an Open — and then meaning nothing when the reading it names has
/// not been taken yet.
const picked = [];

function keyOf(inputId, streamIndex) { return `${inputId}:${streamIndex}`; }

/// Which fourccs this build can read, asked of the native registry.
///
/// Cached because it cannot change while the process runs — it is a list of
/// what is compiled in, the same kind of answer as `bro.ffmpeg.muxers` — and
/// because `streamsWorthReading` is called once per stream per redraw of the
/// Sources stage.
let parserTags = null;
function tags() {
    if (parserTags) return parserTags;
    try { parserTags = bro.ffmpeg.data.parsers() || []; } catch (e) { parserTags = []; }
    return parserTags;
}

/// The data streams of one input that something here knows how to read.
///
/// A real GoPro file carries three — `gpmd`, `tmcd` and `fdsc` — and one of them
/// is parseable, so this is a filter and not a formality. An input with no probe
/// yet has none, which is what keeps a card that is still opening from offering
/// a button that would fail.
export function streamsWorthReading(input) {
    if (!input || !input.probe || !input.probe.streams) return [];
    const known = tags();
    return input.probe.streams.filter(
        (s) => s.kind === 'data' && s.tag && known.indexOf(s.tag) >= 0);
}

/// The reading for one input's stream, whatever state it is in, or null.
export function readingOf(inputId, streamIndex) {
    return readings.get(keyOf(inputId, streamIndex)) || null;
}

/// Start reading one, or do nothing if it is already in flight.
///
/// Returns the entry, so a caller can put it straight on screen — an entry
/// exists from the moment the read starts, which is what lets a card say
/// "reading" rather than staying blank for a third of a second.
export function readStream(input, streamIndex) {
    const k = keyOf(input.id, streamIndex);
    const have = readings.get(k);
    if (have && have.state === 'reading') return have;

    const stream = (input.probe && input.probe.streams || [])
        .find((s) => s.index === streamIndex);
    const entry = {
        inputId: input.id,
        streamIndex,
        tag: stream ? stream.tag : '',
        id: 0,
        state: 'reading',
        elapsed: 0,
        error: '',
        reading: null,
    };
    try {
        entry.id = bro.ffmpeg.data.reads.start(asInput(input), streamIndex);
    } catch (e) {
        entry.state = 'failed';
        entry.error = String(e && e.message || e);
    }
    readings.set(k, entry);
    changed('telemetry');
    return entry;
}

/// The `-i` the read is made against.
///
/// **The input whole, not its path.** A track read out of a file opened with a
/// forced demuxer, a `-probesize` or an `-ss` is a different track from the same
/// file opened with libavformat's defaults — which is the argument the Sources
/// stage is built on, restated here so that what is plotted is what would be
/// rendered.
function asInput(input) {
    return {
        path: input.path,
        format: input.format || '',
        options: input.options || [],
        ss: input.ss || 0,
        t: input.t || 0,
    };
}

/// Give up on one, and forget it.
export function dropReading(inputId, streamIndex) {
    const k = keyOf(inputId, streamIndex);
    const e = readings.get(k);
    if (!e) return;
    if (e.state === 'reading' && e.id) {
        try { bro.ffmpeg.data.reads.forget(e.id); } catch (err) { /* already gone */ }
    }
    readings.delete(k);
    for (let i = picked.length - 1; i >= 0; i--)
        if (picked[i].inputId === inputId && picked[i].streamIndex === streamIndex)
            picked.splice(i, 1);
    changed('telemetry');
}

/// Drop every reading whose input is not in this list any more.
///
/// **One call from one place**, for `graph/overlay.js` `retain()`'s reason: an
/// input can go away through the Sources stage, through an opened document,
/// through an undo and through a project reset, and the one that gets missed is
/// the one that leaves a reading — and a row on the timeline lane — naming a
/// file nothing answers to.
export function retain(inputIds) {
    const keep = new Set(inputIds);
    for (const e of [...readings.values()])
        if (!keep.has(e.inputId)) dropReading(e.inputId, e.streamIndex);
}

/// Take in whatever the reads in flight have to say. Called once a frame.
///
/// The shape `tickInputs()` established, and deliberately the same one: the id
/// lives on the entry, a poll that answers `null` is terminal (the answer was
/// taken already, or the process lost it — either way this is not reading any
/// more, and leaving it that way is a card that says so for ever), the entry's
/// state is cleared before the answer is written so nothing can settle twice,
/// and it returns true only when something **settled**. A read that merely
/// advanced its clock is not a redraw.
export function tickTelemetry() {
    let settled = false;
    for (const e of readings.values()) {
        if (e.state !== 'reading') continue;
        let p = null;
        try { p = bro.ffmpeg.data.reads.poll(e.id); } catch (err) { p = null; }
        if (!p) {
            e.state = 'failed';
            e.error = e.error || 'the read went away before it answered';
            settled = true;
            continue;
        }
        if (p.reading) { e.elapsed = p.elapsed; continue; }
        settled = true;
        e.state = p.state;
        if (p.state === 'done') {
            e.reading = p.result;
            // The first series is put on the lane by itself, because a read
            // that finished and drew nothing is indistinguishable from one that
            // found nothing. Anything else is a press.
            if (e.reading.series && e.reading.series.length)
                pick(e.inputId, e.streamIndex, e.reading.series[0]);
        } else {
            e.error = p.error || (p.state === 'stopped' ? 'stopped' : 'will not read');
        }
    }
    if (settled) changed('telemetry');
    return settled;
}

// ── which series are drawn ────────────────────────────────────────────────

function pickId(inputId, streamIndex, s) {
    return `${inputId}:${streamIndex}:${s.key}:${s.component}`;
}

/// Is this one on the lane?
export function isPicked(inputId, streamIndex, s) {
    const id = pickId(inputId, streamIndex, s);
    return picked.some((p) => p.id === id);
}

/// Put one on the lane, or take it off. Returns a refusal in words, or ''.
///
/// **Six at once, because that is how many colours there are.** The palette in
/// `ui/plot.js` was validated pair by pair *as an adjacent sequence*, so a
/// seventh line is either a repeat or a hue nobody checked — and a lane of seven
/// lines is not a thing anybody reads anyway. Refused in words rather than by
/// dropping the oldest, which would take away a row somebody was watching.
export function pick(inputId, streamIndex, s) {
    const id = pickId(inputId, streamIndex, s);
    const at = picked.findIndex((p) => p.id === id);
    if (at >= 0) {
        picked.splice(at, 1);
        changed('telemetry');
        return '';
    }
    if (picked.length >= MAX_SERIES)
        return `Six series at once is what the colours run to — take one off first.`;
    picked.push({
        id, inputId, streamIndex, key: s.key, component: s.component,
        // Taken in the palette's fixed order and then **remembered**, so that
        // unpicking one line does not repaint the others. The order is the
        // colourblind-safety mechanism; see `nextColor`.
        color: nextColor(new Set(picked.map((p) => p.color))),
    });
    changed('telemetry');
    return '';
}

/// Take everything off the lane.
export function clearPicked() {
    if (!picked.length) return;
    picked.length = 0;
    changed('telemetry');
}

/// The rows the timeline lane draws, bottom to top in pick order.
///
/// Each is everything one row needs and nothing about where it goes: the
/// reading it came out of (for `t0`/`t1`/`buckets`), the series itself (whose
/// `lo`/`hi`/`mean`/`filled` are the typed arrays the native side handed over),
/// the label, and the colour. A row whose reading has gone — an input removed
/// mid-look — is simply absent, which is what makes this safe to call every
/// frame without the pick list and the reading list having to be kept in step.
export function telemetryRows() {
    const out = [];
    for (const p of picked) {
        const e = readings.get(keyOf(p.inputId, p.streamIndex));
        if (!e || !e.reading) continue;
        const s = e.reading.series.find(
            (x) => x.key === p.key && x.component === p.component);
        if (!s) continue;
        out.push({
            id: p.id,
            inputId: p.inputId,
            streamIndex: p.streamIndex,
            color: p.color,
            label: labelOf(s),
            units: s.units || '',
            series: s,
            reading: e.reading,
        });
    }
    return out;
}

/// What to call a series on a lane, a legend or a picker.
///
/// **The fourcc first, always.** It is the only name that is certainly this
/// quantity's: `STNM` describes a *stream*, and a stream carries items beside
/// its sample data — a HERO8's `TMPC` sits inside the accelerometer stream and
/// comes back with no name at all, correctly, because the file never says what
/// it is. So the fourcc is the identity and the name is the gloss.
///
/// The component index is shown only where there is more than one, because
/// `SHUT/0` is noise and `ACCL/0` is which axis.
export function labelOf(s) {
    const comp = s.components > 1 ? `/${s.component}` : '';
    return s.name ? `${s.key}${comp} ${s.name}` : `${s.key}${comp}`;
}

/// A short label for a lane head, where there is room for about ten characters.
export function shortLabelOf(s) {
    return s.components > 1 ? `${s.key}/${s.component}` : s.key;
}

/// Which bucket of a reading a moment in the *file* falls in, or -1.
///
/// The one place the map from seconds to buckets lives, for `columnsOf`'s
/// reason: a second copy of the arithmetic is a second answer to which sample is
/// under a pixel. Out of range is -1 rather than clamped, because a clip may
/// reach past the end of a data track that stopped early and drawing the last
/// bucket across the rest of it would be inventing a measurement.
export function bucketAt(reading, t) {
    const span = reading.t1 - reading.t0;
    if (!(span > 0) || !reading.buckets) return -1;
    const b = Math.floor(((t - reading.t0) / span) * reading.buckets);
    return b < 0 || b >= reading.buckets ? -1 : b;
}
