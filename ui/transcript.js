// What was said in a soundtrack, and how to find a word in six hours of it.
//
// A Twitch VOD is the case this exists for. Six hours of somebody talking is a
// recording nobody will scrub through, and neither of the two lanes that already
// read a soundtrack helps: a waveform says where it is loud and `ui/marks.js`
// says where something happened, and neither can find the minute somebody said
// a name. `bro.ffmpeg.transcribe` is the other half — Whisper over a soundtrack
// libav decoded, on a thread (`src/native/transcribe.h`) — and this is the model
// between it and the screen.
//
// **A transcript is a search hint. It is never the cut.** The most important
// line in this file, and it is not a matter of taste. The audio-only and the
// video renditions of a Twitch VOD do not share a zero — measured at +0.80 s,
// +2.21 s and +2.57 s at three points of one recording, and a *step* rather than
// a drift, because an ad break is discontinuous in one and not the other. A
// transcript read from the cheap audio-only copy therefore carries that
// rendition's seconds, and a cut placed on a word boundary would be placed on
// the wrong file's clock. `ui/inputs.js` carries `sameClock` for exactly this.
// So a hit moves the *playhead* and a human agrees; nothing here trims anything.
//
// Three decisions it shares with `ui/marks.js`, arrived at for the same reasons,
// which is why this file is shaped like that one.
//
// **A transcript belongs to an input, not to a clip.** The speech is in the
// file: two clips cut from one recording are two views of one set of words, and
// reading it twice would decode the same soundtrack twice for the same answer.
// So it is keyed by input, and a hit reaches the timeline through each clip's
// own placement and speed with `timelineTime` — the same map the waveform, the
// Data lane and the Marks lane use.
//
// **It is not in the document**, for the reason `peaks` is not: derived from a
// file, and a second read gives the same answer. Not in `ui/.storage.json`, not
// on the undo track.
//
// **The read is asked for and never automatic.** Not because it is expensive to
// start but because it is expensive to run: measured at 4x realtime on an RTX
// 4090 with whisper-large-v3, so a six-hour VOD is about ninety minutes of GPU.
// Nothing should spend that without being asked.
//
// And one decision that is this file's alone, because the underlying read is
// unlike every other one on that surface. **A transcript arrives while it is
// being made.** `bro.ffmpeg.transcribe.reads.poll` answers with the words so far
// rather than with nothing, so `tickTranscripts` takes the result on *every*
// poll and not only at the end — which is what makes a six-hour recording
// searchable seconds after the press instead of ninety minutes after it. It is
// also why `read` is carried and shown: without it there is no way to tell "the
// last hour is silent" from "the last hour has not been read yet", and a search
// that quietly meant the second while looking like the first would be worse than
// no search at all.

import { changed, timelineTime } from './project.js';
import { asInput, hasSound } from './inputs.js';
import { copyRowsOf } from './export/copy.js';

/// Every read, in flight or finished, by input id.
///
/// `{ inputId, id, state, elapsed, error, result }` where `state` is
/// `reading` | `done` | `failed` | `stopped`, and `result` is the growing
/// transcript. Held here rather than on the input for `ui/marks.js`'s reason:
/// several views want the same object, and hanging it off the input would put a
/// derived answer inside the thing `ui/document.js` walks.
const reads = new Map();

/// Where the weights are. One string, and it is deliberately not a constant
/// buried in the call: a user with large-v3 on one disk and tiny on another is
/// choosing between quality and time, which is a real choice, and the Sources
/// stage offers it.
///
/// Empty means nothing has been chosen and the control says so. It is *not*
/// defaulted to a guess at a path — a wrong guess produces "there is no
/// '<path>/config.json'" pointing at a directory the user never named, which
/// reads as a bug in the application rather than as a thing to go and fix.
///
/// **Remembered between runs**, under a key of its own the way `ui/measure.js`
/// keeps its toggle: the weights are a 3 GB directory somebody put on a
/// particular disk once, it is a property of the machine rather than of the
/// edit, and finding it again on every launch is the difference between a
/// feature you use and one you mean to. Not in the document for the reason a
/// transcript is not in it — a `.fbro` opened on another machine would name a
/// path that is not there. Version-tolerant on the way in, like every other
/// read of persisted state here: whatever is under the key becomes a string or
/// becomes nothing.
const MODEL_KEY = 'ffmpeg-bro.transcript';

let modelDir = readModelDir();

function readModelDir() {
    try {
        const saved = localStorage.getItem(MODEL_KEY);
        const blob = saved ? JSON.parse(saved) : null;
        return blob && typeof blob === 'object' && typeof blob.model === 'string'
            ? blob.model : '';
    } catch (e) {
        return '';         // never set, or written by a shape that is not this one
    }
}

/// Which language the model is told it is hearing. Whisper does not detect here;
/// it is told, and being told the wrong one produces confident nonsense rather
/// than an error, which is why this is offered rather than assumed.
let language = 'en';

export function modelPath() { return modelDir; }
export function useModel(path) {
    modelDir = String(path || '');
    // Written on the press rather than at the read, `ui/measure.js`'s rule and
    // for its reason: a path chosen and never transcribed with is still the
    // path this machine has, and losing it would be the friction all over
    // again. An object under the key so a second thing about transcribing has
    // somewhere to go without a migration.
    try { localStorage.setItem(MODEL_KEY, JSON.stringify({ model: modelDir })); }
    catch (e) { /* not fatal: the path still holds for this run */ }
    changed('transcript');
}
export function languageUsed() { return language; }
export function useLanguage(code) { language = String(code || 'en'); changed('transcript'); }

/// Is there anything in this input to transcribe? The same test `ui/marks.js`
/// asks, and the same answer: a file with no soundtrack is refused by name on
/// the read, but there is no reason to offer the press.
export function worthReading(input) {
    return hasSound(input);
}

/// The read for one input, whatever state it is in, or null.
export function readOf(inputId) { return reads.get(inputId) || null; }

/// Start transcribing one, or do nothing if it is already in flight.
///
/// Returns the entry, and an entry exists from the moment the press lands, so a
/// card can say "listening" rather than staying blank — `ui/marks.js`'s rule.
export function transcribe(input) {
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
    if (!modelDir) {
        entry.state = 'failed';
        entry.error = 'no model has been chosen';
        reads.set(input.id, entry);
        changed('transcript');
        return entry;
    }
    try {
        // **The input whole, not its path**, through `ui/inputs.js`'s own
        // `asInput`: a soundtrack read out of a file opened with a forced
        // demuxer, a `-probesize` or an `-ss` is a different soundtrack, and
        // what is transcribed has to be what would be rendered. `ui/marks.js`
        // says the same and for the same reason.
        entry.id = bro.ffmpeg.transcribe.reads.start(asInput(input), {
            model: modelDir,
            language,
        });
    } catch (e) {
        entry.state = 'failed';
        entry.error = String((e && e.message) || e);
    }
    reads.set(input.id, entry);
    changed('transcript');
    return entry;
}

/// Ask a read to stop, keeping what it has. Distinct from `dropTranscript`: the
/// words already found are worth having and a six-hour read is a thing somebody
/// will genuinely change their mind about half way through.
export function stopTranscribing(inputId) {
    const e = reads.get(inputId);
    if (!e || e.state !== 'reading' || !e.id) return;
    try { bro.ffmpeg.transcribe.reads.cancel(e.id); } catch (err) { /* already gone */ }
}

/// Give up on one and forget it.
///
/// The `forget` here is **required** rather than tidy, unlike every other read
/// on that surface: a finished transcribe keeps answering its poll (so a growing
/// answer does not vanish on the frame after it completes), so nothing else ever
/// releases it. See the top of `src/native/bindings_transcribe.cpp`.
export function dropTranscript(inputId) {
    const e = reads.get(inputId);
    if (!e) return;
    if (e.id) {
        try { bro.ffmpeg.transcribe.reads.forget(e.id); } catch (err) { /* already gone */ }
    }
    reads.delete(inputId);
    changed('transcript');
}

/// Drop every read whose input is not in this list any more. One call from one
/// place, for `ui/marks.js` `retain()`'s reason.
export function retain(inputIds) {
    const keep = new Set(inputIds);
    for (const e of [...reads.values()])
        if (!keep.has(e.inputId)) dropTranscript(e.inputId);
}

/// Take in whatever the reads in flight have to say. Called once a frame.
///
/// **Unlike `tickMarks`, the result is taken on every poll and not only at the
/// end**, because a transcript is useful before it is finished — that is the
/// whole feature. Otherwise this is that function's shape: a poll answering
/// `null` is terminal, the state is written once, and it returns true only when
/// something changed, because a read that merely advanced its clock is not a
/// redraw.
export function tickTranscripts() {
    let moved = false;
    for (const e of reads.values()) {
        if (e.state !== 'reading') continue;
        let p = null;
        try { p = bro.ffmpeg.transcribe.reads.poll(e.id); } catch (err) { p = null; }
        if (!p) {
            e.state = 'failed';
            e.error = e.error || 'the read went away before it answered';
            moved = true;
            continue;
        }
        e.elapsed = p.elapsed;
        // Growing. Compared by segment count rather than by identity, because
        // the poll builds a fresh object every frame and `!==` would be true
        // forever — which would mark every derived view for redraw on every
        // frame for ninety minutes.
        const had = e.result ? e.result.segments.length : -1;
        if (p.result && p.result.segments.length !== had) {
            e.result = p.result;
            moved = true;
        }
        if (p.reading) continue;
        e.state = p.state;
        e.result = p.result || e.result;
        if (p.state !== 'done')
            e.error = p.error || (p.state === 'stopped' ? 'stopped' : 'will not read');
        moved = true;
    }
    if (moved) changed('transcript');
    return moved;
}

// ── finding a word ────────────────────────────────────────────────────────

/// Fold a string for comparison. Case and the punctuation Whisper attaches to
/// words — a transcript says "Ashes," and somebody searching types "ashes" — but
/// **not** the spaces, because collapsing those would make "on air" match
/// "onair" and a phrase search is the main thing this is for.
function fold(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[.,!?;:"'()\[\]{}…—–-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/// Every place `phrase` was said, over every transcript there is.
///
/// A hit is `{ inputId, start, end, text, at }` where `at` is a *character*
/// offset into the folded segment text — enough for a list to show the phrase in
/// its sentence, and deliberately not a time within the segment. Whisper times a
/// *segment*, not a word: claiming a second-accurate position for a word inside
/// a six-second phrase would be this file inventing a measurement, which is the
/// same failure `ui/marks.js` refuses when it will not call a gate a voice.
///
/// Searching only what has been read is not a caveat to hide — `coverage()` is
/// what a caller shows beside the count.
export function search(phrase) {
    const want = fold(phrase);
    const hits = [];
    if (!want) return hits;
    for (const e of reads.values()) {
        if (!e.result || !e.result.segments) continue;
        for (const s of e.result.segments) {
            const hay = fold(s.text);
            let from = 0;
            for (;;) {
                const at = hay.indexOf(want, from);
                if (at < 0) break;
                hits.push({
                    inputId: e.inputId,
                    start: s.start,
                    end: s.end,
                    text: s.text,
                    at,
                });
                from = at + want.length;
            }
        }
    }
    hits.sort((a, b) => (a.inputId === b.inputId
        ? a.start - b.start
        : String(a.inputId).localeCompare(String(b.inputId))));
    return hits;
}

/// How much of everything there is to search has actually been searched, as
/// `{ read, duration }` in seconds summed over every transcript.
///
/// Shown beside a result count, always. A search that found nothing over the
/// first ten minutes of a six-hour recording and a search that found nothing
/// over all of it are completely different answers, and a count alone cannot
/// tell them apart.
export function coverage() {
    let read = 0, duration = 0;
    for (const e of reads.values()) {
        if (!e.result) continue;
        read += e.result.read || 0;
        duration += e.result.duration || 0;
    }
    return { read, duration };
}

/// Where a hit lands on the timeline, given the clips. A hit is on the *input's*
/// clock, so it appears once per clip that covers that moment — a recording cut
/// into three shots can say the same sentence in three places — and `null` from
/// `timelineTime` means this clip does not cover it, which is not a hit.
///
/// The same map the waveform, the Marks lane and the Data lane use, which is
/// what makes a hit follow a clip that is trimmed, moved or sped up without the
/// soundtrack being read again.
export function hitRows(hit, clips) {
    const rows = [];
    for (const clip of clips) {
        if (!clip.input || clip.input.id !== hit.inputId) continue;
        const t = timelineTime(clip, hit.start);
        if (t === null || t === undefined) continue;
        rows.push({ clip, t, hit });
    }
    return rows;
}

// ── a hit becomes a window somebody can actually cut ───────────────────────

/// How much either side of a hit a pulled window carries, in seconds.
///
/// **This number is the two clocks, and it is not a comfort margin.** A
/// transcript is read from whatever soundtrack was cheapest — for a Twitch VOD
/// that is the audio-only rendition — and the video rendition it will be cut
/// from does not share its zero. Measured on one recording: +0.80 s, +2.21 s and
/// +2.57 s at three points, a *step* rather than a drift, because an ad break is
/// discontinuous in one and not the other. So a window that hugged the hit would
/// sometimes not contain it at all.
///
/// Ten seconds is comfortably past the largest offset seen and is still a small
/// file: at a stream's bitrate a twenty-second window is a few megabytes against
/// the whole recording's several gigabytes, which is the entire point of pulling
/// one. The pad is *stated* wherever a window is offered — an unexplained ten
/// seconds looks like sloppiness rather than like the measurement it is.
export const WINDOW_PAD = 10;

/// The span to pull for a hit, clamped to the recording. `pad` is `WINDOW_PAD`
/// unless a caller has a reason; there is currently none.
export function windowFor(hit, duration, pad = WINDOW_PAD) {
    const from = Math.max(0, hit.start - pad);
    let to = hit.end + pad;
    if (duration > 0) to = Math.min(to, duration);
    return { from, to: Math.max(to, from + 1) };
}

/// Every window pull, by a key of its own. `{ key, inputId, hit, from, to, path,
/// fetch, state, error }`.
///
/// Keyed by input **and window** rather than by input, because pulling two
/// moments out of one six-hour recording is the ordinary use of this: you search
/// for a word, and the three places it was said are three files.
const pulls = new Map();

const keyOf = (inputId, from) => `${inputId}@${from.toFixed(2)}`;

export function pullsOf(inputId) {
    return [...pulls.values()].filter((p) => p.inputId === inputId);
}

export function pullFor(inputId, from) {
    return pulls.get(keyOf(inputId, from)) || null;
}

/// Pull just this window of the recording to a local file.
///
/// **The point of the whole feature.** A six-hour VOD is tens of gigabytes and
/// the twenty seconds somebody actually wants is a few megabytes. The transcript
/// found the moment; this fetches only that moment. `soon` puts it in front of
/// any whole-recording copy already queued, because a window is what you are
/// waiting on and a full copy is what you started so that you could get on —
/// and `soon` jumps the queue without preempting, so nothing already running is
/// left half-written.
///
/// It is a **fetch and not a render**: a stream copy, no compositor, no encoder,
/// so it does not take the one job slot and the Render button stays live. See
/// `src/native/fetch_queue.h`.
export function pullWindow(input, hit, dir) {
    // **Which streams a copy carries is `copyRowsOf`'s and not this file's**,
    // for `ui/localcopy.js`'s reason: the Write stage's `Rewrap` answers the
    // same question, and two lists of what is copyable are the pair that comes
    // to disagree. What is dropped after it is what a fetch into Matroska will
    // not hold — a data stream, which for a Twitch VOD is its own segment
    // metadata and means nothing off Twitch.
    let n = 0;
    const rows = copyRowsOf(input.probe, 0, () => ++n, null)
                     .filter((r) => r.kind !== 'data');
    if (!rows.length) {
        return { key: '', inputId: input.id, state: 'failed',
                 error: 'there is nothing in that input that can be copied' };
    }
    const duration = (input.probe && input.probe.duration) || 0;
    const { from, to } = windowFor(hit, duration);
    const key = keyOf(input.id, from);
    const have = pulls.get(key);
    if (have && have.state !== 'failed') return have;

    const stamp = `${Math.floor(from / 60)}m${String(Math.floor(from % 60)).padStart(2, '0')}s`;
    const pull = {
        key,
        inputId: input.id,
        hit,
        from,
        to,
        path: `${dir}/${slug(input.name)}-${stamp}.mkv`,
        fetch: 0,
        state: 'queued',
        error: '',
    };
    try {
        pull.fetch = bro.ffmpeg.fetch.start({
            path: pull.path,
            format: 'matroska',
            // **`ss` and `t` on the input**, which is what makes this a window
            // rather than a whole recording that is stopped early: the demuxer
            // seeks and the copy begins there, so what comes down the link is
            // the window. `to` would be equivalent; `t` is used because the
            // length is what was computed.
            inputs: [{ path: input.path, ss: from, t: to - from }],
            streams: rows,
        }, { label: `${input.name} @ ${stamp}`, soon: true });
    } catch (e) {
        pull.state = 'failed';
        pull.error = String((e && e.message) || e);
    }
    pulls.set(key, pull);
    changed('transcript');
    return pull;
}

/// Give up on a window pull, or forget a finished one.
export function dropPull(key) {
    const p = pulls.get(key);
    if (!p) return;
    if (p.fetch && (p.state === 'queued' || p.state === 'running')) {
        try { bro.ffmpeg.fetch.stop(p.fetch); } catch (e) { /* already gone */ }
    }
    pulls.delete(key);
    changed('transcript');
}

/// Take in what the fetch queue has to say about the windows. Called from
/// `tickTranscripts`' caller for the reason every poll in this application is
/// called from there: nothing calls back into JS.
///
/// One `list()` for every pull rather than a status call each — `ui/localcopy.js`
/// reads the queue the same way and for the same reason: the answer is a lock
/// and a copy either way.
export function tickPulls() {
    if (!pulls.size) return false;
    let moved = false;
    const running = new Map();
    for (const f of bro.ffmpeg.fetch.list()) running.set(f.id, f);

    for (const p of pulls.values()) {
        if (p.state === 'done' || p.state === 'failed') continue;
        const f = running.get(p.fetch);
        if (!f) {
            // Off the list is terminal: the queue forgets a fetch once it has
            // answered, so this is done unless it said otherwise.
            p.state = 'done';
            moved = true;
            continue;
        }
        const was = p.state;
        p.state = f.state || p.state;
        p.progress = f.progress || 0;
        if (f.error) { p.state = 'failed'; p.error = f.error; }
        if (p.state !== was) moved = true;
    }
    if (moved) changed('transcript');
    return moved;
}

/// A filename out of an input's name. The same shape `ui/app.js` `slugOf` makes,
/// kept here rather than imported because that one is not exported and a window
/// file wants the same treatment for the same reason: a stream's title is a
/// sentence with punctuation in it and a path is not.
function slug(name) {
    return String(name || 'window')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'window';
}
