// Where something happens in a soundtrack, and which of it is on the timeline.
//
// Reviewing wildlife footage the birds are audible long before anything is
// visible, and a waveform is no help: at a lane's zoom a call and the wind under
// it are the same two pixels. `bro.ffmpeg.marks` is the other half of that —
// bro's acoustic sensor bus (`src/native/sound_marks.h`) run over a soundtrack
// libav decoded, on a thread — and this is the model between it and the screen.
//
// **What a mark claims is the most important thing in this file.** Three kinds,
// and each is named after the measurement rather than after what made it:
//
//   - `onset` — a spectral-flux transient. Something in the spectrum changed
//     sharply. It is not a bird, a word or a door; it is *something happened*.
//   - `tonal` — a run of sustained periodicity, with a dominant frequency in
//     hertz that is a real measurement. A whistle, a hum, an engine and a bird
//     call all read as one.
//   - `sound` — a run above the measured noise floor. bro's own snapshot calls
//     that flag `voice`; it is **not** called that here, because nothing in an
//     energy gate decided anything was a voice.
//
// Every label this module hands out, and every word in `docs/manual/sources.md`
// about it, holds that line. A control called "find the birds" would be this
// application claiming a classification the DSP never made, and there would be
// no way for somebody looking at the result to know.
//
// Three decisions beyond that, and they are `ui/telemetry.js`'s, arrived at for
// the same reasons — which is why this file is shaped like that one.
//
// **A set of marks belongs to an input, not to a clip.** The sound is in the
// file: two clips cut from one recording are two views of one set of moments,
// and reading it twice would decode the same soundtrack twice for the same
// answer. So it is keyed by input, and the lane maps it through each clip's own
// placement and speed with `timelineTime` — the same map the waveform and the
// Data lane use, and what makes a mark follow a clip that is trimmed, moved or
// sped up without being re-measured.
//
// **It is not in the document, for the reason `peaks` is not.** A mark is
// derived from a file and a second read gives the same answer, so `ui/document.js`
// does not carry it, `ui/.storage.json` does not cache it, and it never reaches
// `ui/history.js` — undo answers "does this change the clips", and a detected
// onset does not.
//
// **The read is asked for and never automatic.** A probe happens because a file
// was added; this happens because somebody pressed `Find sounds` on the Sources
// stage. The difference is cost: a probe is a few hundred microseconds of
// headers and this is seconds of arithmetic over the whole soundtrack — measured
// at about fifty times realtime on this machine, decode included, so roughly a
// minute per hour of sound.

import { changed, timelineTime, speedOf } from './project.js';
import { asInput, hasSound } from './inputs.js';

/// Every read, in flight or finished, by input id.
///
/// `{ inputId, id, state, elapsed, error, result }` where `state` is
/// `reading` | `done` | `failed` | `stopped`. Held here rather than on the input
/// for the reason the whole module exists: the Sources stage, the timeline lane
/// and the poll all want the same object, and hanging it off the input would put
/// a derived answer inside the thing `ui/document.js` walks.
const reads = new Map();

/// Which kinds are drawn and jumped between. Not persisted, for the reason
/// `telemetry.js`'s `picked` is not: it is an editorial choice like a selected
/// clip, and losing it on reopen costs a press rather than any work.
const shown = { onset: true, tonal: true, sound: true };

/// What each kind is drawn in. Chosen clear of the three a *clip* is drawn in —
/// blue for a filmstrip, green for sound, violet for a generator — and clear of
/// the accent, which everywhere on this timeline means "selected".
///
/// **These are three of `SPAN_TINTS`' line colours** (ui/timeline.js), which is
/// the same validated palette one lane up — so if that palette changes, this
/// changes with it. They are not shared as one constant because the two mean
/// different things: a span's colour is arbitrary and per *node*, handed out in
/// pick order so two rows read as two, and a mark's is fixed and per *kind*, so
/// that yellow means "a transient" on every timeline anybody opens. A colour
/// that meant a kind here and a node there only when the two lanes happened to
/// be adjacent would be worse than a repeat.
export const MARK_COLORS = {
    onset: '#ffcf5c',
    tonal: '#7cc4ff',
    sound: '#6fdcb0',
};

/// What each kind is, in the words that are true of it.
///
/// One home, because these strings are the whole of what stops this feature
/// being a lie: they go on the lane's tooltip, on the Sources stage's legend and
/// into `docs/manual/sources.md`, and a second copy is how one of them comes to
/// say "bird".
export const MARK_WORDS = {
    onset: 'a sharp change in the spectrum — something happened here',
    tonal: 'a run of steady pitch, with the frequency it was measured at',
    sound: 'a run louder than the noise floor around it',
};

/// Whether this build can look at all.
///
/// Cached because it cannot change while the process runs — it is a fact about
/// how the binary was configured, the same kind of answer as `bro.ffmpeg.muxers`
/// — and because the Sources stage asks it once per card per redraw. A build
/// with `-DBRO_WITH_SOUNDML=OFF` answers false and the control is not drawn,
/// which is `data.parsers()`'s rule: offer an affordance where it will work.
let canLook = null;
export function available() {
    if (canLook === null) {
        try { canLook = !!bro.ffmpeg.marks.available(); } catch (e) { canLook = false; }
    }
    return canLook;
}

/// Is there anything here to listen to?
///
/// Two questions, because the control has to be absent for either answer: can
/// this build look at all, and does this input carry a soundtrack. The second is
/// `hasSound` in ui/inputs.js — the one-word form of `streamKinds`, which exists
/// precisely so that `indexOf('a') >= 0` is not written out at each of the
/// places that ask. An input with no probe yet answers false, which keeps a card
/// that is still opening from offering a button.
export function worthReading(input) {
    return available() && hasSound(input);
}

/// The read for one input, whatever state it is in, or null.
export function readOf(inputId) { return reads.get(inputId) || null; }

/// Start reading one, or do nothing if it is already in flight.
///
/// Returns the entry, and an entry exists from the moment the press lands — so
/// a card can say "listening" rather than staying blank for several seconds,
/// whether it takes the entry from here or reads it back through `readOf` on the
/// redraw the press causes, which is what the Sources stage does.
export function findSounds(input) {
    const have = reads.get(input.id);
    if (have && have.state === 'reading') return have;

    const entry = {
        inputId: input.id,
        id: 0,
        state: 'reading',
        elapsed: 0,
        error: '',
        result: null,
    };
    try {
        // **The input whole, not its path**, and through `ui/inputs.js`'s own
        // `asInput` rather than a shape written out here: a soundtrack read out
        // of a file opened with a forced demuxer, a `-probesize`, an `-ss` or a
        // `-to` is a different soundtrack, and what is marked has to be what
        // would be rendered. A private copy of that shape is how a marks read
        // comes to ignore a window the render honours.
        entry.id = bro.ffmpeg.marks.reads.start(asInput(input));
    } catch (e) {
        entry.state = 'failed';
        entry.error = String(e && e.message || e);
    }
    reads.set(input.id, entry);
    changed('marks');
    return entry;
}

/// Give up on one, and forget it.
export function dropMarks(inputId) {
    const e = reads.get(inputId);
    if (!e) return;
    if (e.state === 'reading' && e.id) {
        try { bro.ffmpeg.marks.reads.forget(e.id); } catch (err) { /* already gone */ }
    }
    reads.delete(inputId);
    changed('marks');
}

/// Drop every read whose input is not in this list any more.
///
/// **One call from one place**, for `telemetry.js` `retain()`'s reason: an input
/// can go away through the Sources stage, through an opened document, through an
/// undo and through a project reset, and the one that gets missed is the one
/// that leaves a row on the lane naming a file nothing answers to.
export function retain(inputIds) {
    const keep = new Set(inputIds);
    for (const e of [...reads.values()])
        if (!keep.has(e.inputId)) dropMarks(e.inputId);
}

/// Take in whatever the reads in flight have to say. Called once a frame.
///
/// `tickTelemetry`'s shape, deliberately: the id lives on the entry, a poll that
/// answers `null` is terminal (the answer was taken already, or the process lost
/// it — either way this is not reading any more), the state is cleared before
/// the answer is written so nothing can settle twice, and it returns true only
/// when something **settled**. A read that merely advanced its clock is not a
/// redraw.
export function tickMarks() {
    let settled = false;
    for (const e of reads.values()) {
        if (e.state !== 'reading') continue;
        let p = null;
        try { p = bro.ffmpeg.marks.reads.poll(e.id); } catch (err) { p = null; }
        if (!p) {
            e.state = 'failed';
            e.error = e.error || 'the read went away before it answered';
            settled = true;
            continue;
        }
        if (p.reading) { e.elapsed = p.elapsed; continue; }
        settled = true;
        e.state = p.state;
        if (p.state === 'done') e.result = p.result;
        else e.error = p.error || (p.state === 'stopped' ? 'stopped' : 'will not read');
    }
    if (settled) changed('marks');
    return settled;
}

// ── which kinds are on the lane ───────────────────────────────────────────

/// Is this kind drawn and jumped to?
export function isShown(kind) { return !!shown[kind]; }

/// Turn one kind on or off. Every kind at once is not offered and does not need
/// to be: three checkboxes are three presses, and a "none" state would be a lane
/// that is there and empty.
export function showKind(kind, on) {
    if (!(kind in shown)) return;
    const next = !!on;
    if (shown[kind] === next) return;
    shown[kind] = next;
    changed('marks');
}

// ── what the lane and the keys read ───────────────────────────────────────

/// Every mark in the edit, on the **timeline's** clock, in time order.
///
/// The one map from a file's seconds to the timeline's, and it is
/// `timelineTime` in `ui/project.js` — the same one the Data lane and the
/// waveform go through, which is what makes a mark follow a trim, a move and a
/// speed without being re-measured. A mark outside the clip's own window is
/// dropped rather than clamped: a clip trimmed to its last two seconds does not
/// contain what happened in its first, and drawing it at the edge would put a
/// moment where nothing happened.
///
/// Built fresh per call rather than cached, for `telemetryRows`'s reason: the
/// clips move on every drag and a cache would be a second thing to invalidate.
/// What makes that affordable is that the *window* is found rather than
/// filtered for: a mark's `at` is in the source file's seconds and the native
/// side hands the list back in that order, so the marks a clip contains are a
/// contiguous run of it. Comparing in **source** seconds — the clip's own window
/// worked out once, above the loop — skips the ones before it and stops at the
/// first one after, so a twelve-clip edit off one recording costs about what the
/// clips contain rather than twelve walks of the whole list. The cap on that
/// list is twenty thousand (`kMaxSoundMarks`), which is what the difference is
/// worth guarding against.
///
/// A row carries what the lane and `markLabel` read and nothing else. The
/// per-mark measurements — the flux of a transient, the periodicity of a run —
/// stay on the reading, where anything that wants to filter or explain them can
/// ask; putting them here would be nine slots allocated sixty times a second for
/// a lane that has no hit test to show them in.
export function markRows(clips) {
    const out = [];
    for (const clip of clips || []) {
        // The input **object**, which is what a clip holds — `clipsOf()` in
        // ui/project.js compares against one and `ui/document.js` writes
        // `c.input.id`. A generator has none, and null is the honest answer
        // there: there is no `-i` and so no soundtrack of a file to have marked.
        if (!clip.input) continue;
        const e = reads.get(clip.input.id);
        if (!e || !e.result) continue;
        const end = clip.start + clip.length;
        // The clip's window in the *source file's* seconds, which is the clock
        // every `mark.at` is on. `speedOf` is the same factor `sourceTime` uses
        // and the epsilon is the one the timeline comparison used, moved to
        // where the comparison now is.
        const srcLo = clip.inPoint - 1e-6;
        const srcHi = clip.inPoint + clip.length * speedOf(clip) + 1e-6;
        for (const m of e.result.marks) {
            if (m.at < srcLo) continue;
            if (m.at > srcHi) break;      // the list is in source order
            if (!shown[m.kind]) continue;
            const at = timelineTime(clip, m.at);
            out.push({
                at,
                // A run is drawn as a band, so its end is mapped through the
                // same clip and then clamped to it — a call that starts inside
                // the shot and finishes after the cut is a band that stops at
                // the cut, which is what the edit actually contains.
                end: m.length > 0
                        ? Math.min(end, timelineTime(clip, m.at + m.length))
                        : at,
                kind: m.kind,
                hz: m.hz,
                length: m.length,
            });
        }
    }
    // Each clip's contribution is already ordered; this puts the clips in order
    // with each other, which a straight concatenation would not for clips laid
    // out on two tracks or cut out of order. Over what the edit *contains*
    // rather than over what was read.
    out.sort((a, b) => a.at - b.at);
    return out;
}

/// The mark before or after `t`, out of rows the caller already has.
///
/// Takes the rows rather than the clips because every caller wants the list too
/// — to say how many there were when there is nothing to jump to — and building
/// it twice for one key press is two walks of the edit at key-repeat rate.
///
/// **A small epsilon, so a jump is repeatable.** Landing exactly on a mark and
/// pressing the same key again has to move: the playhead is set to the mark's
/// own time, so "strictly after" against a float that is now equal would find
/// the same one for ever. It is also what makes a transient and the run it opens
/// — two marks at one instant — one stop rather than two. A millisecond is under
/// a frame at any rate this application deals in and over the error of the
/// arithmetic that got here.
export function markNear(rows, t, dir) {
    if (dir < 0) {
        for (let i = rows.length - 1; i >= 0; i--)
            if (rows[i].at < t - 0.001) return rows[i];
        return null;
    }
    for (const r of rows) if (r.at > t + 0.001) return r;
    return null;
}

/// What to say about one mark, in words that are true of it.
///
/// The frequency is shown only on a tonal run, because `dominant_hz` on any
/// other kind is whatever the autocorrelation last liked and means nothing — the
/// native side reports zero there for exactly that reason, and printing "0 Hz"
/// would be a measurement nobody made.
export function markLabel(row) {
    const words = MARK_WORDS[row.kind] || row.kind;
    if (row.kind === 'tonal')
        return `${words} — ${Math.round(row.hz)} Hz, ${row.length.toFixed(2)}s`;
    if (row.kind === 'sound') return `${words} — ${row.length.toFixed(2)}s`;
    return words;
}

/// A one-line summary of what a finished read found, for the card.
///
/// It says what the numbers *are*, and it says the totals rather than what was
/// kept where the two differ — a run too short to be a place was still a run,
/// and a card that reported only the kept ones would be understating the file.
export function summaryOf(entry) {
    const r = entry && entry.result;
    if (!r) return '';
    const bits = [];
    if (r.onsets) bits.push(`${r.onsets} transient${r.onsets === 1 ? '' : 's'}`);
    if (r.tonalRuns) bits.push(`${r.tonalRuns} tonal run${r.tonalRuns === 1 ? '' : 's'}`);
    if (r.soundRuns) bits.push(`${r.soundRuns} above the noise floor`);
    if (!bits.length) return 'nothing stood out of this soundtrack';
    const kept = r.marks.length;
    const tail = r.truncated ? `, ${kept} kept (the list was capped)` : '';
    return bits.join(', ') + tail;
}
