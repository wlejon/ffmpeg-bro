// Getting the recordings in the first place — the step this application used to
// send people to a command line for.
//
// ── Why this is here and not in `results.js` or `ui/library.js` ────────────
//
// `results.js` draws and decides nothing; `ui/library.js` decides what a *search*
// answers and is on the reading side of the corpus by design — the workbench
// searches a corpus and has no business making one, which is why nothing in
// `ui/` imports `corpus/`. Acquisition is a third thing: it writes, it takes
// minutes, and it has to be polled from the frame loop. So it gets its own file
// in `supercut/`, exactly as `supercut/cuts.js` owns cuts and is ticked from
// `app.js`, and it is the one module in this window that imports `corpus/` —
// which is what `corpus/` was split out of `tools/` to allow.
//
// ── The inventory is one place, and four things go into it ────────────────
//
// A recording can be in any of four conditions at once and no single source
// knows all four, which is exactly the bug this file exists to prevent: a row
// drawn from the listing says nothing about the disk, and a row drawn from the
// manifest says nothing about a broadcast that has never been pulled. So one
// merge, here, and `results.js` may only draw its answer:
//
//   1. **the listing** (`loadChannel`) — what Twitch says the channel has, which
//      is the only source that knows about a recording nobody has fetched;
//   2. **the disk** (`isPulled`, `loadState`, `transcribed`) — what is actually
//      here, which outlives the listing: a broadcast Twitch has dropped off its
//      retention is still on this machine and still searchable;
//   3. **the manifest** (`library.current()`) — the corpus as the finder sees it,
//      which is the fallback for a store kept somewhere other than
//      `build/corpus/` and is the only source a suite's fixture has;
//   4. **the jobs** below — what is being fetched or read *right now*, which is
//      on no disk at all.
//
// The one condition this cannot name is a recording pulled but not transcribed
// that Twitch has since dropped: it is in no listing, has no transcript for
// `transcribed()` to find and is in no manifest. Naming it would mean a
// directory walk here, which would be a second copy of the store's layout in a
// file that has no business holding one — `corpus/store.js` owns that, and the
// row would appear again the moment either half of it existed.
//
// ── Three rules that are decisions ────────────────────────────────────────
//
// **The press must return.** `planPull` resolves a signed URL over the network,
// which is a round trip; the row goes to `resolving` on the frame the button was
// pressed and the copy starts when the promise lands. Same rule `play()` states
// in `ui/output.js` and `cuts.js` states about `+`: a press that stops the window
// is a press somebody presses twice. (`startPull` then probes the rendition
// synchronously, 0.71 s — `corpus/pull.js` names that cost and says what moving
// it off the frame would take. It is paid when the plan lands rather than on the
// press, so nothing is waiting on it.)
//
// **One transcription at a time, and the rest say `queued`.** This is honesty
// rather than a throttle. brotensor's pool is a process-wide singleton, so
// `analysisLock()` serialises these reads natively (`src/native/sound_marks.h`)
// — ten started transcriptions would be ten rows all claiming to be reading
// while nine sat on a mutex, and the progress bars of the nine would say nothing
// for hours. Pulls are deliberately **not** queued this way: `bro.ffmpeg.fetch`'s
// own pool is two workers wide because they share one link, and several
// downloads at once is the whole point of a pull holding no job slot.
//
// **A landed transcription writes the manifest and re-reads the corpus.**
// Otherwise `index` is a step somebody has to remember, and the failure when
// they forget is the quietest one here — the Words tab finds nothing and nothing
// anywhere says that the recording it would have found was transcribed an hour
// ago. `corpus/index.js` moved out of `tools/` for exactly this call.
//
// ── What it does not do ───────────────────────────────────────────────────
//
// No `--last`, no `--skip`, no `--again`, no device menu. Those are the batch
// verbs' (`tools/supercut.js`), which are still the right thing for pulling five
// recordings overnight and are still there. What is here is one channel, one
// list, and a button per row — the loop somebody runs when they want *this*
// broadcast now.

import { loadChannel, refresh, transcribed, isPulled, loadState,
         vodPaths } from '../corpus/store.js';
import { planPull, startPull, pollPull, stopPull } from '../corpus/pull.js';
import { startTranscribe, pollTranscribe, stopTranscribe } from '../corpus/words.js';
import { writeManifest } from '../corpus/index.js';
import { exists, sizeOf, gb } from '../corpus/files.js';
import * as library from '../ui/library.js';

/// How many of the newest broadcasts a look-up asks Twitch for.
///
/// The command line's `--last` defaults to 5, which is right for a verb that
/// then *pulls* every one of them. Nothing is pulled here — a look-up is one
/// GraphQL round trip and the rows cost nothing — so this is the number that
/// makes the list worth reading, and a channel that streams daily is three
/// weeks of it. Twitch caps a page at 100 and `channel()` pages past that.
const LISTED = 20;

/// The channel the inventory is about. One at a time, because the question the
/// Recordings tab asks is about a channel and a merged list of two would have to
/// say which row belonged to which.
let login = '';

/// The inventory: one row per recording, merged from the four sources above.
let rows = [];

/// What is being fetched or read, by VOD id.
///
/// `{ chan, meta, kind, phase, job, error }` where `kind` is `'pull'` or
/// `'words'` and `phase` is `resolving` | `queued` | `running` | `failed`.
/// `phase` is this file's and `job.state` is `corpus/`'s: `resolving` and
/// `queued` are conditions no fetch and no read is in yet, which is precisely
/// why they are named here.
///
/// **`chan` and `meta` are on the record rather than looked up when needed**,
/// and both were bugs waiting to happen. A pull started on one channel and
/// landing after somebody has typed another would otherwise be written into the
/// channel that happens to be showing, and a queued read whose row is not on the
/// screen has no row to take its title from. What a job is about is settled on
/// the press.
const work = new Map();

/// The channel a look-up is in flight for, or ''.
let looking = '';

/// The last thing that went wrong, as one line. A statement, not a log: it is
/// replaced by the next thing and it is drawn beside the control it is about.
let said = '';

/// What the rows *are*, and what their numbers *say* — two descriptions, because
/// they change at completely different rates and cost completely different
/// things to answer.
///
/// **A row's shape changes a handful of times in a pull and its numbers change
/// several times a second.** The shape is which recordings there are and what
/// condition each is in, which decides the controls on the row and therefore has
/// to be built; the numbers are a percentage, a byte count, a word count and a
/// rate, which are text inside elements that already exist. Answering both with
/// one stamp meant a rebuild of the whole list every time a download crossed ten
/// megabytes — and a rebuilt list is elements thrown away, which is the most
/// expensive thing this window does per unit of nothing having happened.
let shapeStamp = '';
let numberStamp = '';

/// What the frame loop still owes the caller. See `tick()`.
let needRows = false;
let needNumbers = false;

// ── what is showing ────────────────────────────────────────────────────────

/// The channel in hand, for the box to show.
export function channelName() { return login; }

/// Is a look-up in flight? The press that started it is not repeatable.
export function busy() { return !!looking; }

/// The inventory, newest first. Each row is a **superset of a `ui/library.js`
/// item** — `kind`, `vod`, `at`, `to`, `label`, `detail` — so the one list in
/// `results.js` draws it, and `play()` and `add()` reach `item.vod.media`
/// exactly as they do for a hit. Everything past `detail` is this file's.
export function list() { return rows; }

/// The one line the tab says about the channel: what went wrong, or what is
/// here. A statement — every number in it changes.
export function note() {
    if (looking) return `looking up ${looking}…`;
    if (said) return said;
    if (!login) return library.available() ? '' : 'no corpus yet';
    if (!rows.length) return `nothing listed for ${login} yet`;
    const disk = rows.filter((r) => r.vod.media).length;
    const words = rows.filter((r) => r.state === 'transcribed').length;
    return `${rows.length} recordings · ${disk} on disk · ${words} transcribed`;
}

/// Show what is already known about a channel. Synchronous, and touches no
/// network — which is what makes the tab full on the frame the window opens and
/// what a suite drives. `lookUp` is the one call that asks Twitch anything.
export function open(name) {
    const next = String(name || '').trim().toLowerCase().replace(/^@/, '');
    if (next !== login) said = '';
    login = next;
    scan();
}

/// Ask Twitch what the channel has, and rebuild the inventory around the answer.
///
/// **A refusal still shows whatever that channel already has here**, which is
/// the difference between this and `refresh()` alone: Twitch being unreachable
/// must not empty a list of recordings that are on this disk and perfectly
/// searchable. The listing is the live answer and the directories are the
/// archive — `corpus/store.js`'s rule, drawn. A name nobody has is empty because
/// there is nothing of it here either, and the refusal says which it was.
export async function lookUp(name) {
    const next = String(name || '').trim().toLowerCase().replace(/^@/, '');
    if (!next || looking) return false;
    looking = next;
    said = '';
    needRows = true;
    let got = null;
    try {
        got = await refresh(next, LISTED);
    } catch (e) {
        said = String((e && e.message) || e);
    }
    looking = '';
    login = next;
    // The corpus may already hold this channel — a look-up of the one being
    // searched must leave the Words tab searching it rather than pointing the
    // finder somewhere nobody asked for.
    if (library.available()) library.pick(next);
    scan();
    needRows = true;
    return !!got;
}

// ── the merge ──────────────────────────────────────────────────────────────

/// Rebuild the inventory from the disk and the listing.
///
/// Called when something *transitions* rather than every frame: it reads a
/// directory and a `state.json` per recording, which is nothing once and is a
/// file system walk sixty times a second otherwise. What moves every frame — a
/// progress fraction, a word count — is written onto the rows by `apply()`.
function scan() {
    rows = [];
    if (!login) { shapeStamp = ''; numberStamp = ''; return; }

    // 1. the listing: the only source that knows about a broadcast nobody has.
    const drafts = new Map();
    const ch = loadChannel(login);
    for (const v of (ch && ch.vods) || [])
        drafts.set(String(v.id), { ...v, id: String(v.id), listed: true });

    // 2. the disk: `transcribed` walks the directories, so a recording Twitch
    // has forgotten keeps its row and its words.
    const words = new Map();
    for (const v of transcribed(login)) {
        const id = String(v.id);
        words.set(id, v);
        if (!drafts.has(id)) drafts.set(id, { ...v, id, listed: false });
    }

    // 3. the manifest: the corpus as the finder sees it. Its rows carry absolute
    // paths of their own, which is what a store kept somewhere other than
    // `build/corpus/` — and every suite fixture — is made of.
    //
    // Read through `library.recordings()` rather than off `current().vods`,
    // because what a manifest holds is that call's answer and this is a *merge*
    // rather than a second listing. The item wrapper is discarded and its `vod`
    // is what goes in.
    const man = library.current();
    const manifest = new Map();
    if (man && man.channel === login) {
        for (const it of library.recordings()) {
            const id = String(it.vod.id);
            manifest.set(id, it.vod);
            if (!drafts.has(id)) drafts.set(id, { ...it.vod, id, listed: false });
        }
    }

    for (const draft of drafts.values())
        rows.push(rowFor(draft, words.get(draft.id), manifest.get(draft.id)));

    rows.sort((a, b) => String(b.vod.publishedAt).localeCompare(String(a.vod.publishedAt)));
    apply();
}

/// One row: what the recording is, where its files are, and what state it is in.
///
/// **The store's path wins and the manifest's is the fallback**, in that order
/// and never merged: a recording pulled into this store is at `vodPaths`, and a
/// manifest row names wherever its corpus put one. Asked of the file rather than
/// assumed, so a recording deleted to reclaim the disk loses its `▶` and keeps
/// its words — which is the state `results.js` has always drawn.
function rowFor(draft, hasWords, fromManifest) {
    const p = vodPaths(login, draft.id);
    const st = loadState(login, draft.id);

    const pulled = isPulled(login, draft.id);
    const media = pulled ? p.media
                : fromManifest && fromManifest.media && exists(fromManifest.media)
                    ? fromManifest.media : '';
    const srt = hasWords ? p.srt
              : fromManifest && fromManifest.srt && exists(fromManifest.srt)
                  ? fromManifest.srt : '';

    const seconds = (st.media && st.media.seconds) || draft.seconds
                  || (fromManifest && fromManifest.seconds) || 0;
    // Never read to be counted: a transcript is a megabyte and the count is
    // already written down twice — in the manifest row and in the state file.
    // A `.srt` that has neither still says `transcribed` and simply has no
    // number, which is true and is better than a frame spent parsing one.
    const wordCount = (fromManifest && fromManifest.words)
                   || (st.transcript && st.transcript.words) || 0;

    const vod = {
        id: draft.id,
        page: draft.page || (fromManifest && fromManifest.page) || '',
        title: draft.title || (fromManifest && fromManifest.title) || '',
        publishedAt: draft.publishedAt || (fromManifest && fromManifest.publishedAt) || '',
        seconds, media, srt, words: wordCount,
    };

    return {
        // The `ui/library.js` item shape, so one list draws recordings and hits.
        kind: 'vod', vod, at: 0, to: seconds,
        label: String(vod.publishedAt).slice(0, 10),
        detail: vod.title,
        // And this file's half of it.
        id: draft.id,
        listed: !!draft.listed,
        state: srt ? 'transcribed' : media ? 'pulled' : 'listed',
        bytes: media ? sizeOf(media) : 0,
        progress: 0, read: 0, realtime: 0, error: '', failedAt: '',
    };
}

/// Write what the live jobs say onto the rows they are about.
///
/// Cheap by construction — no file is touched — because this runs on every frame
/// a job exists, which is what makes a progress line move.
function apply() {
    const shape = [];
    const moving = [];
    for (const row of rows) {
        const w = work.get(row.id);
        // A job of another channel that happens to share an id is not this row's.
        if (w && w.chan !== login) continue;
        row.progress = 0;
        row.read = 0;
        row.realtime = 0;
        row.error = '';
        row.failedAt = '';
        if (!w) continue;
        if (w.phase === 'failed') {
            row.state = 'failed';
            // Which press retries it: a pull that would not resolve and a read
            // that would not start are two different buttons on one row.
            row.failedAt = w.kind;
            row.error = w.error;
        } else if (w.kind === 'pull') {
            // Three phases of one press, and they are genuinely different work:
            // asking Twitch where the stream is, copying it, and — only when
            // this was a resume — putting what was already on disk back together
            // with what just arrived.
            row.state = w.phase === 'resolving' ? 'resolving'
                      : (w.job && w.job.state === 'joining') ? 'joining'
                      : 'pulling';
            row.progress = (w.job && w.job.progress) || 0;
            if (w.job && w.job.bytes) row.bytes = w.job.bytes;
        } else if (w.phase === 'queued') {
            row.state = 'queued';
        } else {
            row.state = 'transcribing';
            const job = w.job;
            row.read = (job && job.read) || 0;
            row.realtime = (job && job.realtime) || 0;
            row.vod.words = (job && job.words) || 0;
            row.progress = job && job.duration > 0 ? row.read / job.duration : 0;
        }
        // The two signatures `tick()` compares. What decides a *control* goes in
        // the first; everything a row merely says goes in the second. Whole
        // percents and whole words even so: a fraction that moved in the eighth
        // decimal would make every frame a repaint, which is the cost
        // `ui/app.js`'s `needs()` exists to avoid.
        shape.push(`${row.id}:${row.state}:${row.failedAt}`);
        moving.push(`${row.id}:${Math.round(row.progress * 100)}:${row.vod.words}:` +
                    `${row.bytes}:${(row.realtime || 0).toFixed(1)}:${row.error}`);
    }
    const nextShape = shape.join('|');
    if (nextShape !== shapeStamp) { shapeStamp = nextShape; needRows = true; }
    const nextMoving = moving.join('|');
    if (nextMoving !== numberStamp) { numberStamp = nextMoving; needNumbers = true; }
}

// ── pulling ────────────────────────────────────────────────────────────────

/// What `corpus/` needs to know about a recording: the five fields `pollPull`
/// and `pollTranscribe` write into its `state.json`, and no more.
const metaOf = (row) => ({ id: row.id, page: row.vod.page, title: row.vod.title,
                           seconds: row.vod.seconds,
                           publishedAt: row.vod.publishedAt });

/// Fetch one recording. Returns on the frame it is pressed; see the block above.
export function get(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || work.has(id)) return;
    const chan = login;
    const rec = { chan, meta: metaOf(row), kind: 'pull', phase: 'resolving',
                  job: null, error: '' };
    work.set(id, rec);
    needRows = true;
    apply();

    // Nothing is printed: `planPull`'s log is the command line's running
    // commentary, and this window says what it knows on the row.
    planPull(chan, rec.meta, () => {}).then((plan) => {
        // Stopped while the round trip was in flight. The press that stopped it
        // is the one that meant it.
        if (work.get(id) !== rec) return;
        const job = startPull(chan, rec.meta, plan);
        rec.job = job;
        if (job.state === 'failed') {
            rec.phase = 'failed';
            rec.error = job.error;
        } else if (job.state === 'skipped') {
            // Already on disk — the ordinary answer to a second press.
            work.delete(id);
            scan();
        } else {
            rec.phase = 'running';
        }
        needRows = true;
        apply();
    }).catch((e) => {
        if (work.get(id) !== rec) return;
        rec.phase = 'failed';
        rec.error = String((e && e.message) || e);
        needRows = true;
        apply();
    });
}

// ── transcribing ───────────────────────────────────────────────────────────

/// Read one pulled recording's words. Queued behind any read already running.
export function transcribe(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || work.has(id)) return;
    if (!row.vod.media) return;
    work.set(id, { chan: login, meta: metaOf(row), kind: 'words',
                   phase: 'queued', job: null, error: '' });
    needRows = true;
    apply();
}

/// Is a read already running? The queue is one deep because the lock underneath
/// it is process-wide — see the block at the top.
function readingNow() {
    for (const w of work.values())
        if (w.kind === 'words' && w.phase === 'running') return true;
    return false;
}

/// Start the head of the queue, if there is room for it.
function startQueued() {
    if (readingNow()) return false;
    for (const [id, w] of work) {
        if (w.kind !== 'words' || w.phase !== 'queued') continue;
        try {
            const job = startTranscribe(w.chan, w.meta, {});
            w.job = job;
            if (job.state === 'skipped') { work.delete(id); scan(); }
            else if (job.state === 'reading') w.phase = 'running';
            else { w.phase = 'failed'; w.error = job.error || job.state; }
        } catch (e) {
            // `startTranscribe` throws by name for a recording that is not
            // completely pulled, which is a real answer and belongs on the row.
            w.phase = 'failed';
            w.error = String((e && e.message) || e);
        }
        return true;
    }
    return false;
}

/// The transcript landed: put it in the manifest and re-read the corpus, so the
/// words are searchable in the Words tab without anybody restarting anything.
///
/// Both halves are needed and neither is enough. `writeManifest` is the file
/// `ui/library.js` reads; `library.reload()` is the re-read, because the roll
/// and the manifest are both parsed once and kept.
function published(chan) {
    try {
        writeManifest(chan);
        library.reload();
        library.pick(chan);
    } catch (e) {
        said = String((e && e.message) || e);
    }
}

// ── what is running, for the place that lists all of it ────────────────────

/// Every job this file has in flight, as the one list in `inflight.js` takes it.
///
/// **The sentence is written here because the states are named here.** A
/// Recordings row draws a condition as *what to do next* and this draws the same
/// condition as *what is happening*, which are two sentences about one fact — and
/// a second `switch` over the eight states, in a panel, is exactly the second
/// home this repository keeps paying for. So `results.js` draws whichever list it
/// is showing and neither of them decides what a state means.
///
/// Only the conditions something is *happening* in are listed. `listed`,
/// `pulled`, `transcribed` and `failed` are rows waiting for a press, and a
/// panel about what is running that filled up with things that are not is a
/// panel nobody would open twice.
export function inFlight() {
    const out = [];
    // A look-up is a round trip and belongs here for the same reason a pull does
    // — it is the one job with no row of its own to sit on, because until it
    // answers there may be no rows at all.
    if (looking)
        out.push({ key: `look:${looking}`, kind: 'Looking up', name: looking,
                   note: 'asking Twitch', progress: 0, stop: null });

    for (const r of rows) {
        const pct = `${Math.round((r.progress || 0) * 100)}%`;
        let kind = '';
        let note = '';
        let stoppable = true;
        switch (r.state) {
        case 'resolving':
            kind = 'Getting'; note = 'asking Twitch'; stoppable = false; break;
        case 'pulling':
            kind = 'Getting'; note = `${pct} · ${gb(r.bytes)}`; break;
        case 'joining':
            // No stop, here as on the row: stopping mid-join leaves two halves
            // and no recording. See `corpus/pull.js`.
            kind = 'Getting'; note = `${pct} · joining`; stoppable = false; break;
        case 'queued':
            kind = 'Reading'; note = 'queued'; break;
        case 'transcribing':
            kind = 'Reading';
            note = `${pct} · ${(r.vod.words || 0).toLocaleString()} words · ` +
                   `${(r.realtime || 0).toFixed(1)}×`;
            break;
        default:
            continue;
        }
        out.push({
            key: `${kind}:${r.id}`, kind,
            name: r.detail || String(r.id),
            note, progress: r.progress || 0,
            stop: stoppable ? () => stop(r.id) : null,
        });
    }
    return out;
}

// ── stopping ───────────────────────────────────────────────────────────────

/// Stop whatever is being done to this recording.
///
/// A stopped pull leaves its `.part` where it is and a stopped read writes
/// nothing — both are `corpus/`'s rules and neither leaves half a thing under a
/// real name, which is why this is a plain press with nothing to confirm.
export function stop(id) {
    const w = work.get(id);
    if (!w) return;
    if (w.kind === 'pull') stopPull(w.job);
    else stopTranscribe(w.job);
    work.delete(id);
    scan();
    needRows = true;
}

// ── the frame loop ─────────────────────────────────────────────────────────

/// Poll every live job. Answers what the list now needs: `'rows'`, `'numbers'`
/// or `false`.
///
/// **Answers rather than draws**, which is `ui/app.js`'s `needs()`/`drawPending()`
/// discipline one storey down, and it answers with *which* redraw for
/// `cuts.tick()`'s reason: a bar advancing and a recording changing condition are
/// two different amounts of work and the caller cannot tell them apart from a
/// boolean. `'rows'` rebuilds the list, `'numbers'` writes the moving text into
/// the rows already on the screen — see the two stamps above for why that
/// distinction is worth having a return value for.
export function tick() {
    let settled = false;

    for (const [id, w] of [...work]) {
        if (w.phase !== 'running') continue;
        if (w.kind === 'pull') {
            pollPull(w.job);
            if (w.job.state === 'done') { work.delete(id); settled = true; }
            else if (w.job.state === 'failed') { w.phase = 'failed'; w.error = w.job.error; settled = true; }
        } else {
            pollTranscribe(w.job);
            if (w.job.state === 'done') {
                work.delete(id);
                published(w.chan);
                settled = true;
            } else if (w.job.state !== 'reading') {
                // `stopped` is somebody's own press and is not a failure, but
                // nothing was written either way — the row goes back to being a
                // recording with no words, which is what it is.
                if (w.job.state === 'failed') { w.phase = 'failed'; w.error = w.job.error; }
                else work.delete(id);
                settled = true;
            }
        }
    }

    if (startQueued()) settled = true;
    if (settled) scan();
    else apply();

    if (!needRows && !needNumbers) return false;
    // Rows first when both are owed: building them writes the numbers on the way
    // past, and a repaint of elements that are about to be thrown away is a
    // repaint thrown away with them.
    const what = needRows ? 'rows' : 'numbers';
    needRows = false;
    needNumbers = false;
    return what;
}
