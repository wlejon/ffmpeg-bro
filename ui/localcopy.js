// A remote input's stream, copied to a file on this machine.
//
// The queue underneath is `bro.ffmpeg.fetch` (src/native/fetch_queue.h): a
// stream copy per pull, running beside the application rather than in the
// render's job slot, cancelable one at a time. The press returns immediately;
// the card says where each pull has got to and where the file lands.
//
// The job carries an `audio` slot beside the `video` one and the model carries
// `sameClock`, and both are currently dormant: they existed for the
// soundtrack-first pull of a page's audio-only rendition, and the page resolver
// (`ui/vod.js`) left the UI with the ffmpeg-only pass. Nothing supplies a
// second rendition now, so every pull reads the input's own path and
// `sameClock` is always true. The pair shape stays because the card and
// `tick()` read it and because the resolver is expected back; its story and
// the measurements behind the ordering are in git history with the file.
//
// ── What this module is not ────────────────────────────────────────────────
//
// It is not a download manager and it holds no files. What is on disk is on
// disk; this holds what was *asked for*, so the card can say where each pull has
// got to and offer to stop it. Nothing here is in the document — a local copy is
// a fact about this machine, not about the edit, which is `peaks`'s rule.

import { inputs } from './inputs.js';
import { copyRowsOf } from './export/copy.js';

/// One input's pulls, by input id. Not a Map keyed by the input object: an input
/// is reconciled in place by `ui/document.js` and the id is what survives it.
const jobs = new Map();

/// A pull, as the card reads it.
///
/// `state` is the fetch's own word — queued, running, done, failed, cancelled —
/// with two of ours in front of it: `probing` while the rendition is being
/// opened to find out what streams it has, and `''` for a pull that was never
/// asked for.
function blank() {
    return { state: '', path: '', label: '', probe: 0, fetch: 0,
             progress: 0, bytes: 0, error: '' };
}

/// Is anything at all known about this input's local copies?
export function copiesOf(input) {
    return (input && jobs.get(input.id)) || null;
}

/// Both pulls of every input, for the status line and for tests.
export function allCopies() {
    return Array.from(jobs.values());
}

/// The folder pulls are written to, when somebody has said which.
///
/// Empty means nobody has, and `ui/app.js` answers with the document's own
/// directory then. That is the right default and it has one bad case, which is
/// the case this exists for: an edit that has never been saved has no
/// directory, so the fallback is the folder the application was started in —
/// which is a real place and one nobody can point at. A fourteen-gigabyte
/// download nobody can name the destination of is a download you go and find
/// with a file search, and "where did it go" is the question this feature was
/// asked the first time it was used.
///
/// Remembered between runs under a key of its own, `ui/measure.js`'s rule:
/// which disk has room for
/// a five-hour recording is a property of the machine rather than of the edit.
/// Not in the document for the reason nothing else here is — a `.fbro` opened
/// on another machine would name a folder that is not there.
const FOLDER_KEY = 'ffmpeg-bro.copies';

let folder = readFolder();

function readFolder() {
    try {
        const saved = localStorage.getItem(FOLDER_KEY);
        const blob = saved ? JSON.parse(saved) : null;
        return blob && typeof blob === 'object' && typeof blob.folder === 'string'
            ? blob.folder : '';
    } catch (e) {
        return '';        // never set, or written by a shape that is not this one
    }
}

/// Where copies go, or '' for "wherever the document is".
export function copyFolder() { return folder; }

/// Say where they should go. An empty string puts it back to the document's own
/// directory, which is what the control's `Beside the document` offers.
export function useCopyFolder(dir) {
    folder = String(dir || '').replace(/[/\\]+$/, '');
    try { localStorage.setItem(FOLDER_KEY, JSON.stringify({ folder })); }
    catch (e) { /* not fatal: it still holds for this run */ }
    return folder;
}

/// Where a pull's file goes.
///
/// Named after the input rather than after the signed URL, which is five hundred
/// characters of token and is not a filename, and the sound is `.audio` so that
/// two pulls of one recording cannot land on one name. Matroska because a copy
/// has to go into a container that will hold what is being copied and Matroska
/// holds very nearly everything.
function pathFor(dir, name, which) {
    const slug = String(name || 'stream')
        .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'stream';
    return `${dir}/${slug}${which === 'audio' ? '.audio' : ''}.mkv`;
}

/// The rendition each pull reads.
///
/// The picture is the input's own path, and the sound is empty — there is no
/// separate sound pull without an audio-only rendition, and nothing supplies
/// one since the page resolver left the UI. Pulling the same bytes twice would
/// be worse than not having the shortcut, so the audio slot stays unasked.
function renditionsFor(input) {
    return {
        video: input ? input.path : '',
        videoName: input ? input.name : 'the stream',
        audio: '',
        audioName: '',
    };
}

/// Ask for a local copy. Returns a sentence when it could not, and '' when it is under
/// way. The press returns immediately: the first thing the pull does is open
/// the stream, and that happens on a thread.
export function save(input, dir) {
    if (!input) return 'there is no input to copy';
    if (!input.remote && !input.origin)
        return 'that input is already a file on this machine';
    const where = renditionsFor(input);
    if (!where.video) return 'nothing in it says what to read';

    const job = {
        input: input.id,
        name: input.name,
        sameClock: true,
        audio: blank(),
        video: blank(),
    };

    job.video.path = pathFor(dir, input.name, 'video');
    job.video.label = `${input.name}`;
    job.video.url = where.video;
    begin(job.video);

    jobs.set(input.id, job);
    return '';
}

/// Open a rendition on a thread so its stream list can become copy rows.
///
/// **Nothing is probed on the JS thread.** A rendition's streams are what the
/// rows are made of and the only way to learn them is to open the file — over
/// HTTPS, which is most of a second — so `probes.start` does it elsewhere and
/// `tick()` picks the answer up.
function begin(pull) {
    pull.state = 'probing';
    pull.probe = bro.ffmpeg.probes.start({ path: pull.url });
}

/// Stop one of them. A pull that has finished is left alone — there is nothing
/// to stop and the file is already there.
export function cancel(input, which) {
    const job = jobs.get(input && input.id);
    const pull = job && job[which];
    if (!pull) return;
    if (pull.probe) { bro.ffmpeg.probes.forget(pull.probe); pull.probe = 0; }
    if (pull.fetch) bro.ffmpeg.fetch.stop(pull.fetch);
    // `waiting` is in this list and that is the load-bearing part of it: a
    // picture stopped before it started has no probe and no fetch to carry the
    // stop, so the only thing that can remember it is the state — and left as
    // `waiting` the tick would begin it the moment the soundtrack finished,
    // which is a download somebody cancelled starting itself.
    if (pull.state === 'waiting' || pull.state === 'probing' || pull.state === '')
        pull.state = 'cancelled';
}

/// Forget what this input's pulls came to. The files stay where they are.
export function forget(input) {
    const job = jobs.get(input && input.id);
    if (!job) return;
    for (const which of ['audio', 'video']) {
        const pull = job[which];
        if (pull.probe) bro.ffmpeg.probes.forget(pull.probe);
        if (pull.fetch && (pull.state === 'queued' || pull.state === 'running'))
            bro.ffmpeg.fetch.stop(pull.fetch);
    }
    jobs.delete(input.id);
}

/// The copy rows for everything in a rendition worth carrying.
///
/// **Which streams become rows is `copyRowsOf`'s and not this file's**, because
/// the Write stage's `Rewrap` answers the same question and two lists of which
/// kinds are copyable is the pair that comes to disagree. What is decided here
/// is only what a *fetch into Matroska* then drops: Twitch's HLS carries a
/// `timed_id3` track of its own segment metadata, Matroska will not hold a data
/// stream and says so, and the track means nothing once the recording is off
/// Twitch. Dropped by kind, and the count is kept so the card can say what was
/// left out rather than the file quietly being shorter than the stream.
function copyRows(probe) {
    let n = 0;
    const all = copyRowsOf(probe, 0, () => ++n, null);
    const rows = all.filter((s) => s.kind !== 'data');
    return { rows, dropped: all.length - rows.length };
}

/// A probe landed: turn it into a queued fetch.
function queueFrom(pull, probe) {
    const { rows, dropped } = copyRows(probe);
    if (!rows.length) {
        pull.state = 'failed';
        pull.error = 'there is nothing in that rendition that can be copied';
        return;
    }
    pull.dropped = dropped;
    try {
        pull.fetch = bro.ffmpeg.fetch.start({
            path: pull.path,
            format: 'matroska',
            inputs: [{ path: pull.url }],
            streams: rows,
        }, { label: pull.label });
        pull.state = 'queued';
    } catch (e) {
        pull.state = 'failed';
        pull.error = String((e && e.message) || e);
    }
}

/// Take in whatever the threads have said. From the frame loop, for the reason
/// every other poll in this application is: nothing calls back into JS.
///
/// Returns true when something changed, which is the card's cue to redraw.
export function tickLocalCopies() {
    if (!jobs.size) return false;
    let moved = false;
    // One list read for every pull there is, rather than a `status(id)` each:
    // the answer is a lock and a copy either way, and the list is the call that
    // says what is *happening* — which is what a card showing two pulls wants.
    const running = new Map();
    for (const f of bro.ffmpeg.fetch.list()) running.set(f.id, f);

    for (const job of jobs.values()) {
        const input = inputs.find((i) => i.id === job.input) || null;
        // **The picture starts when the soundtrack is off the link, however the
        // soundtrack left it.** Done is the ordinary case; failed, stopped or
        // refused are the ones worth being careful about — a picture that only
        // began after a *successful* sound pull would mean that stopping the
        // soundtrack silently cancelled a download nobody asked to cancel.
        if (job.video.state === 'waiting' && job.audio.state &&
            job.audio.state !== 'probing' && job.audio.state !== 'queued' &&
            job.audio.state !== 'running') {
            begin(job.video);
            moved = true;
        }
        for (const which of ['audio', 'video']) {
            const pull = job[which];
            if (pull.state === 'probing' && pull.probe) {
                const p = bro.ffmpeg.probes.poll(pull.probe);
                // Null is an id nothing knows about, which after a terminal
                // answer is the ordinary case — the entry is forgotten with the
                // answer, so a poll that misses one is a poll that dropped it.
                if (!p) { pull.probe = 0; continue; }
                if (p.state === 'done' && p.result) {
                    pull.probe = 0;
                    queueFrom(pull, p.result);
                    moved = true;
                } else if (p.state === 'failed' || p.state === 'stopped') {
                    pull.probe = 0;
                    pull.state = p.state === 'stopped' ? 'cancelled' : 'failed';
                    pull.error = p.error || '';
                    moved = true;
                }
                continue;
            }
            if (!pull.fetch) continue;
            const f = running.get(pull.fetch);
            if (!f) continue;
            if (f.state !== pull.state || f.progress !== pull.progress) moved = true;
            pull.state = f.state;
            pull.progress = f.progress;
            pull.bytes = f.bytes;
            pull.error = f.error || pull.error;
            // **The input learns where the file is only when there is one.**
            // Written here rather than when the pull was asked for, because a
            // path that is going to exist and a path that does are different
            // claims and the card offers to *read* one of them.
            if (f.state === 'done' && input) {
                if (which === 'audio' && input.localAudio !== pull.path) {
                    input.localAudio = pull.path;
                    moved = true;
                } else if (which === 'video' && input.localCopy !== pull.path) {
                    input.localCopy = pull.path;
                    moved = true;
                }
            }
        }
    }
    return moved;
}

/// Is this input's soundtrack on this machine yet? The one question the whole
/// ordering exists to be able to answer yes to early.
export function soundIsHere(input) {
    return !!(input && input.localAudio);
}

/// What to call a pull's state in a sentence. One home, because the card, the
/// status line and the tests all say it.
export const PULL_WORDS = {
    waiting: 'after the sound',
    probing: 'opening it',
    queued: 'waiting its turn',
    running: 'pulling',
    done: 'here',
    failed: 'failed',
    cancelled: 'stopped',
};
