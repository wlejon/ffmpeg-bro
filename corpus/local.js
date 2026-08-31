// Footage that is already on this disk, made into a corpus.
//
// ── Why a folder is a channel ──────────────────────────────────────────────
//
// Everything downstream of a transcript in this repository — the Words tab, the
// Talking tab, `ui/phrase.js`'s matcher, `library.asClip`, the cut, the mix —
// asks the corpus one question: which recordings are there, what was said in
// them, and where. Not one part of that is about Twitch. What is about Twitch is
// two steps at the front: the listing, and the pull.
//
// So a folder of footage is a **channel whose listing is the folder** and whose
// pull already happened. That is not an analogy stretched to fit — it is the
// same store, the same `state.json`, the same `words.srt`, the same manifest,
// and the same `bro.ffmpeg.words` read. What this file adds is the two steps
// that are missing, and it adds them in the shape `corpus/pull.js` already has:
// `adopt` is synchronous and answers what it did, `tick` is synchronous and
// idempotent, nothing here waits for anything.
//
// The alternative was a second kind of thing beside a VOD — a "local file" the
// finder, the acquirer, the manifest writer and the row drawer would each have
// to learn — and it is the same mistake the repository has already paid for
// once: two descriptions of one fact, kept in step by hand.
//
// ── The file is not copied, and that is the whole design ──────────────────
//
// `corpus/store.js` pulls a recording *into* the store because it comes off the
// network and there is nowhere else for it to be. A folder somebody points this
// at is already here, it is tens of gigabytes, and copying it would double
// that to gain nothing at all. So the store holds the recording's `state.json`
// and its `words.srt`, and `mediaOf` answers with the path the file has always
// had.
//
// Two consequences, and both are honest rather than avoidable. **A file that
// moves loses its media and keeps its words** — which is exactly the condition
// `corpus/index.js` already reports as `without` and the finder already draws as
// a hit it cannot play, because a broadcast Twitch dropped does the same thing.
// And **nothing here is portable**: a corpus of adopted files describes this
// machine's disk. A pulled corpus is portable and this one is not, which is the
// price of not copying and is worth paying.
//
// ── Ids are allocated, and they have to be stable ─────────────────────────
//
// A VOD arrives with an id Twitch gave it. A file has a path, and a path is not
// a directory name. So an id is the next free integer in the channel — which
// keeps every existing reader working, `transcribed`'s numeric filter included —
// and **the path is written into the state file, which is what makes a second
// adoption of the same folder find its own work rather than duplicate it**.
// Re-scanning a folder after transcribing half of it is the ordinary way to use
// this, and an id that moved would re-transcribe everything.
//
// ── The probe is a thread, because a folder is not one file ───────────────
//
// `bro.ffmpeg.probe` is 50–130 ms on a long recording, so adopting a folder of
// fifty is five seconds of frozen window on a press — which is the one thing
// every part of this application refuses to do. `bro.ffmpeg.probes` is the
// asynchronous twin and this drives it one at a time from a caller's frame loop,
// exactly as `corpus/words.js` drives a read. Until a file's probe lands it has
// no length, `isPulled` is false, and nothing offers to transcribe it — which is
// true, and is better than a length this file guessed.
//
// ── What is not here ──────────────────────────────────────────────────────
//
// No watching, no re-scanning on a timer, no deleting. A folder is adopted when
// somebody asks and re-scanned when somebody asks; a file that has gone keeps
// its row and loses its media, which is a state the finder already draws. A
// corpus that quietly changed under a search would be the tool changing the
// question, which `ui/library.js` refuses one storey up for the same reason.
//
// `assert` is the headless runner's global and this is imported by a window, so
// everything that refuses here throws an `Error` carrying the sentence.

import { dirFor, channelFile, loadChannel, loadState, saveState, vodPaths }
    from './store.js';
import { abs, exists, mkdirp, readJson, writeJson, modifiedAt } from './files.js';
import { looksLikeMedia } from '../ui/inputs.js';

const fs = require('fs');

/// The channel loose files go into when nobody named one.
///
/// A folder brings its own name — `D:/footage/interviews` is the channel
/// `interviews`, which is what somebody would have called it — and files picked
/// one by one out of four directories have no such name between them. One
/// well-known bucket for those rather than a prompt: a dialog asking what to
/// call a channel, before there is anything in it, is a question with no
/// information in it (`GENERATOR_SECONDS` in `ui/project.js` states the same
/// rule about a colour card).
export const LOOSE = 'local';

/// The channel name a folder makes.
///
/// Folded the way `corpus/index.js` folds it, and for that reason: two files
/// carry the name and `pick()` in `ui/library.js` matches one against the other,
/// so `Interviews` written into one and `interviews` into the other is a channel
/// that lists and will not open. Everything that is not a letter or a digit
/// becomes a hyphen, because the name is also a directory.
export function channelNameFor(dir) {
    const parts = String(dir || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    const leaf = parts[parts.length - 1] || '';
    const name = leaf.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return name || LOOSE;
}

// ── what a local channel is ────────────────────────────────────────────────

/// Is this channel a folder of footage rather than a broadcaster?
///
/// **The one thing a caller must ask before reaching the network.** A local
/// channel's `channel.json` is written by this file and never refreshed from
/// Twitch; looking one up would replace the folder's own listing with an empty
/// answer about a broadcaster who does not exist, and take the recordings off
/// the screen with it.
export function isLocal(login) {
    const ch = loadChannel(String(login || '').toLowerCase());
    return !!(ch && ch.local);
}

/// The folder a local channel was adopted from, or '' — for the re-scan.
export function folderOf(login) {
    const ch = loadChannel(String(login || '').toLowerCase());
    return (ch && ch.local && ch.dir) || '';
}

/// Every local channel in the store, newest listing first.
///
/// A directory walk, which is the one place in `corpus/` that does one to answer
/// a question about *channels* rather than about a channel's recordings — and it
/// is here rather than in `store.js` because "which of these are folders" is
/// this file's distinction and nothing else asks it.
export function localChannels() {
    let names = [];
    try { names = fs.readdirSync(abs('build/corpus')); } catch (e) { return []; }
    const out = [];
    for (const name of names) {
        const ch = readJson(channelFile(name), null);
        if (ch && ch.local)
            out.push({ channel: name, dir: ch.dir || '', vods: (ch.vods || []).length });
    }
    return out.sort((a, b) => a.channel.localeCompare(b.channel));
}

// ── adopting ───────────────────────────────────────────────────────────────

/// The files in a folder that are worth probing.
///
/// One level deep, deliberately. A recursive walk of somewhere like `D:/footage`
/// is a walk of a whole disk on a press, and "the folder I pointed at" is what
/// somebody means by a folder — a subdirectory is another folder and adopting it
/// is another press.
///
/// The extension filter is `ui/inputs.js`'s set, asked of this build's demuxers,
/// so nothing about which formats count is written down here. It is a filter and
/// not a verdict: what passes is probed, and what will not open is refused by
/// name.
export function mediaIn(dir) {
    let names = [];
    try { names = fs.readdirSync(abs(dir)); } catch (e) {
        throw new Error(`cannot read ${dir}`);
    }
    const at = abs(dir).replace(/[\\/]+$/, '');
    return names.map((n) => `${at}/${n}`)
                .filter((p) => looksLikeMedia(p) && exists(p))
                .sort();
}

/// The recording in this channel that is already this file, or null.
///
/// **The path is the identity**, which is what makes adopting the same folder
/// twice cost nothing and keep every transcript. Compared against the state
/// file's own copy rather than against a listing, because the listing is
/// rewritten by every scan and the state file is what a transcription wrote
/// beside its words.
function alreadyHere(login, path) {
    const want = abs(path);
    let ids = [];
    try { ids = fs.readdirSync(dirFor(login)); } catch (e) { return null; }
    for (const id of ids) {
        if (!/^\d+$/.test(id)) continue;
        const st = loadState(login, id);
        if (st && st.local && st.local.path === want) return { id, state: st };
    }
    return null;
}

/// The next id free in this channel.
///
/// Integers, so that `transcribed`'s numeric filter and every existing reader of
/// an id go on working unchanged — see the header. Taken from the directories
/// rather than from a counter in a file: a counter is a second description of
/// what the directories already say, and the failure when the two disagree is a
/// state file written over somebody's transcript.
function nextId(login) {
    let ids = [];
    try { ids = fs.readdirSync(dirFor(login)); } catch (e) { /* new channel */ }
    let top = 0;
    for (const id of ids) if (/^\d+$/.test(id)) top = Math.max(top, +id);
    return String(top + 1);
}

const nameOf = (p) => String(p).split(/[\\/]/).pop() || String(p);

/// Take these files into the corpus, under `name`.
///
/// Answers `{ channel, added, already, refused }` — `added` and `already` are
/// lists of `{ id, path, name }` and `refused` is `[{ path, why }]`. Both halves
/// of that are worth saying out loud: adopting a folder for the second time is
/// the ordinary way to pick up what has been added to it, and a file that is not
/// media is a thing somebody dropped in and would otherwise wonder about.
///
/// **Nothing is probed here.** The state file is written with no length, which
/// is what `tick()` fills in and what `isPulled` refuses until it has. See the
/// header for why a press may not probe fifty files.
export function adopt(paths, name) {
    const login = String(name || LOOSE).toLowerCase();
    const added = [];
    const already = [];
    const refused = [];

    for (const raw of paths) {
        const path = abs(raw);
        if (!exists(path)) { refused.push({ path, why: 'is not there' }); continue; }
        const had = alreadyHere(login, path);
        if (had) { already.push({ id: had.id, path, name: nameOf(path) }); continue; }
        if (!looksLikeMedia(path)) {
            refused.push({ path, why: 'is not a format a demuxer in this build claims' });
            continue;
        }
        const id = nextId(login);
        mkdirp(vodPaths(login, id).dir);
        saveState(login, id, {
            id,
            title: nameOf(path),
            page: '',
            // The file's own date, which is the only ordering a folder has and
            // is what puts the newest footage at the top of the list beside the
            // newest broadcast. ISO, because that is what every other recording
            // in this store carries and what the rows are sorted on as text.
            publishedAt: new Date(modifiedAt(path) || Date.now()).toISOString(),
            // What makes this an adopted recording rather than a pulled one, and
            // the only field `corpus/store.js` reads to tell them apart.
            local: { path, name: nameOf(path), adoptedAt: new Date().toISOString() },
        });
        added.push({ id, path, name: nameOf(path) });
    }

    writeListing(login, undefined);
    return { channel: login, added, already, refused };
}

/// Adopt every media file directly inside a folder, under the folder's own name.
///
/// The folder is remembered on the channel so that `rescan` needs nothing but
/// the name — which is what the Recordings tab has when somebody presses it a
/// week later.
export function adoptFolder(dir) {
    const at = abs(dir).replace(/[\\/]+$/, '');
    const login = channelNameFor(at);
    const files = mediaIn(at);
    const got = adopt(files, login);
    writeListing(login, at);
    return { ...got, dir: at, looked: files.length };
}

/// Look at the folder again: take in what has appeared since.
///
/// **Nothing is removed.** A file that has gone keeps its row, its state and its
/// words, and loses only its media — the condition a dropped broadcast is
/// already in and which the finder already draws. Deleting the transcript of a
/// recording somebody moved would be the corpus throwing away the expensive half
/// because the cheap half moved.
export function rescan(login) {
    const dir = folderOf(login);
    if (!dir) throw new Error(`${login} is not a folder — nothing to re-scan`);
    return adoptFolder(dir);
}

/// Write the channel's listing: what this folder holds, newest first.
///
/// **The listing for a local channel is the store's own directories**, which is
/// the inversion that makes the whole thing work: for a broadcaster the listing
/// comes off the network and the directories are the archive, and here there is
/// no network and the directories are all there is. Written on every adoption so
/// that `loadChannel` — which `acquire.js` reads first and `transcribed` reads
/// for titles — answers with the whole folder rather than with the files of the
/// last press.
function writeListing(login, dir) {
    const had = loadChannel(login);
    let ids = [];
    try { ids = fs.readdirSync(dirFor(login)); } catch (e) { /* nothing yet */ }
    const vods = [];
    for (const id of ids) {
        if (!/^\d+$/.test(id)) continue;
        const st = loadState(login, id);
        if (!st || !st.local) continue;
        vods.push({
            id, title: st.title || st.local.name || '', page: '',
            seconds: (st.media && st.media.seconds) || 0,
            publishedAt: st.publishedAt || '',
        });
    }
    vods.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    writeJson(channelFile(login), {
        channel: login,
        local: true,
        dir: dir === undefined ? ((had && had.dir) || '') : dir,
        vods,
        fetchedAt: new Date().toISOString(),
    });
}

// ── the probes ─────────────────────────────────────────────────────────────

/// The adopted recordings still waiting to be measured, as `{ login, id }`.
///
/// One queue for the process rather than one per channel: the cost being spread
/// is a thread and a file handle, and which channel a probe belongs to is on the
/// record for the reason `acquire.js` puts `chan` on a job — a folder adopted
/// and then navigated away from must still finish measuring itself.
const queue = [];
let running = null;     // { login, id, probe, began }

/// How many probes are in flight at once.
///
/// One. A probe opens a file and reads its head, and a folder of fifty is fifty
/// files opened at once against one disk — which is slower than doing them in a
/// row and is a spike of handles for no gain. There is nothing waiting on the
/// answer: the row says `measuring` and the frame loop goes on running.
const AT_ONCE = 1;

/// Measure everything in this channel that has not been measured.
///
/// Called after an adoption and safe to call again: a recording that already has
/// a length is not queued, and one already queued is not queued twice.
export function measure(login) {
    const name = String(login || '').toLowerCase();
    let ids = [];
    try { ids = fs.readdirSync(dirFor(name)); } catch (e) { return 0; }
    let n = 0;
    for (const id of ids) {
        if (!/^\d+$/.test(id)) continue;
        const st = loadState(name, id);
        if (!st || !st.local) continue;
        if (st.media && st.media.seconds > 0) continue;
        if (queue.some((q) => q.login === name && q.id === id)) continue;
        if (running && running.login === name && running.id === id) continue;
        queue.push({ login: name, id });
        n++;
    }
    return n;
}

/// How many are still to be measured, for a caller that wants to say so.
export function measuring() { return queue.length + (running ? 1 : 0); }

/// Advance the probes. Answers true when something landed, so a caller knows to
/// re-read the store rather than re-reading it every frame.
///
/// Synchronous and idempotent, `pollTranscribe`'s shape: a command line pumps
/// this in a loop and a window calls it from its frame loop, and neither has to
/// know what the other does.
export function tick() {
    let changed = false;

    if (running) {
        let answer = null;
        try { answer = bro.ffmpeg.probes.poll(running.probe); }
        catch (e) { answer = { state: 'failed', error: String((e && e.message) || e) }; }
        // **A terminal answer is handed over exactly once** and the entry is
        // forgotten with it, so a poll that comes back null is a poll after the
        // one that landed — which cannot happen here, and is treated as the open
        // having gone rather than as an answer worth writing.
        if (!answer) { running = null; changed = true; }
        else if (answer.state !== 'opening') {
            settle(running, answer);
            running = null;
            changed = true;
        }
    }

    while (!running && queue.length && AT_ONCE > 0) {
        const next = queue.shift();
        // Adopted, then adopted again somewhere else, then deleted: a queue
        // entry outlives the thing it is about, and a probe of a state file that
        // has gone would fail with a sentence about a path nobody typed.
        const st = loadState(next.login, next.id);
        if (!st || !st.local) { changed = true; continue; }
        try {
            next.probe = bro.ffmpeg.probes.start(st.local.path, {});
            running = next;
        } catch (e) {
            settle(next, { state: 'failed', error: String((e && e.message) || e) });
            changed = true;
        }
    }
    return changed;
}

/// Write what a probe said into the recording's state file.
///
/// **A file that will not open keeps its row and says why.** The alternative —
/// dropping it back out of the channel — is a folder that adopts eleven of
/// twelve files and says nothing about the twelfth, which is the quiet failure
/// this whole corpus is arranged against. `error` on the state is what the row
/// draws, and re-adopting the folder after mending the file clears it.
function settle(job, answer) {
    const st = loadState(job.login, job.id);
    if (!st || !st.local) return;
    if (answer.state === 'done' && answer.result) {
        const probe = answer.result;
        const seconds = (probe.format && probe.format.duration) || 0;
        if (seconds > 0) {
            // The same three fields `corpus/pull.js` writes when a copy lands,
            // so that `isPulled`, `startTranscribe` and the row are asking one
            // shape of one question whatever put the recording here.
            //
            // **A file with no soundtrack is kept and flagged, not refused.** A
            // folder of footage holds b-roll, and b-roll is perfectly good
            // material to cut into a mix — so it keeps its row, it plays and it
            // adds. What it can never be is *searchable*, because a transcript
            // is read off a soundtrack; saying so on the row is the difference
            // between a recording somebody is waiting for words from and one
            // they know has none. The probe is the only place that can tell.
            saveState(job.login, job.id, {
                ...st,
                media: { path: st.local.path, seconds,
                         at: new Date().toISOString() },
                silent: !probe.audio,
                error: '',
            });
        } else {
            saveState(job.login, job.id, { ...st, error: 'reports no duration' });
        }
    } else {
        saveState(job.login, job.id,
                  { ...st, error: answer.error || 'would not open' });
    }
    writeListing(job.login, undefined);
}
