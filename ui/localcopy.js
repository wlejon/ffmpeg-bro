// A stream pulled off a page and written to this machine — the soundtrack
// first, and the picture after it.
//
// **Two pulls rather than one, and the order is the whole point.** A Twitch VOD
// resolves to several renditions of one recording, and the audio-only one is a
// few percent of the bytes: on the recording this was measured against, 0.4 GB
// against 14.7. Everything you would do *first* with a five-hour stream needs
// only the sound — transcribe it, search it for a phrase, find where something
// happens — and everything that needs the picture needs it at a handful of
// moments rather than all the way through. So the soundtrack comes first and the
// application says when it has landed; the picture goes on arriving behind it
// while you work.
//
// The queue underneath is `bro.ffmpeg.fetch` (src/native/fetch_queue.h): a
// stream copy per pull, running beside the application rather than in the
// render's job slot, cancelable one at a time.
//
// ── They run one after the other, and the measurement is why ───────────────
//
// The obvious arrangement is to queue both and let the small one finish first.
// It does not, and the reason is worth writing down because it is the opposite
// of what the sizes suggest. Measured against a six-hour Twitch VOD, each
// rendition pulled **alone**:
//
//   Audio Only   1.5 MB/s    78x realtime    ~0.4 GB    ~4.6 min
//   1080p60     69.6 MB/s    95x realtime   ~15.0 GB    ~3.8 min
//
// The soundtrack is not the faster of the two per second of recording — it is
// very slightly slower. It is **latency-bound**: forty times fewer bytes spread
// over the same number of segments, so what it spends is round trips rather than
// bandwidth. Queued together, the picture took the link and the soundtrack fell
// to a third of its own rate — 11% done where alone it would have been at 32%.
//
// So the wins are not the same win, and only one of them is what this is for:
// the soundtrack does not arrive *sooner than the picture would have*, it
// arrives sooner than **anything** can if the two are sharing a link. One after
// the other puts a searchable soundtrack on the machine in five minutes instead
// of fourteen. That is also why the pair is not simply handed to the queue with
// its two workers: the second worker is deliberately left for the short,
// urgent pull a cut makes (`soon` in fetch_queue.h), which is the one thing that
// must not wait behind either of these.
//
// ── The two clocks, carried rather than forgotten ──────────────────────────
//
// **The audio pull and the video pull are two transcodes of one stream and they
// do not share a zero.** Measured over sixteen consecutive words of the same
// recording, the audio-only rendition ran 0.80 s ahead of the 1080p60 one — and
// at three points of the same pair it was +0.80 s, +2.21 s and +2.57 s. That is
// a *step* rather than a drift: Twitch VODs carry discontinuities where the ads
// were, the renditions do not resolve them identically, and no offset and no
// slope corrects it. `tools/montage.js` is where the measurement lives.
//
// So a transcript of the audio pull is a **search hint** against the picture and
// never the cut itself, and that fact travels on the model here (`sameClock`)
// rather than being remembered by whoever comes to make a cut. A local copy made
// from the *same* rendition — the whole-input `Save a local copy` of a file that
// has no audio-only sibling — is on one clock and says so.
//
// ── What this module is not ────────────────────────────────────────────────
//
// It is not a download manager and it holds no files. What is on disk is on
// disk; this holds what was *asked for*, so the card can say where each pull has
// got to and offer to stop it. Nothing here is in the document — a local copy is
// a fact about this machine, not about the edit, which is `peaks`'s rule.

import { inputs } from './inputs.js';
import { forListening } from './vod.js';
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
/// The sound is `forListening`'s answer — the audio-only rendition where the
/// site published one — and the picture is whichever the input is set to, which
/// is the picker on the Sources card. When there is no audio-only rendition
/// there is no separate sound pull at all: pulling the same rendition twice
/// would be the same bytes twice, which is worse than not having the shortcut.
function renditionsFor(input) {
    const list = (input && input.renditions) || [];
    const video = list.find((r) => r.name === input.rendition) || list[0] || null;
    const audio = forListening({ renditions: list });
    return {
        video: video ? video.url : input.path,
        videoName: video ? video.name : 'the stream',
        audio: audio && audio.audioOnly ? audio.url : '',
        audioName: audio && audio.audioOnly ? audio.name : '',
    };
}

/// Ask for both. Returns a sentence when it could not, and '' when it is under
/// way. The press returns immediately: the first thing either pull does is open
/// a rendition, and that happens on a thread.
export function save(input, dir) {
    if (!input) return 'there is no input to copy';
    if (!input.renditions && !input.origin)
        return 'that input is already a file on this machine';
    const where = renditionsFor(input);
    if (!where.video) return 'nothing in it says what to read';

    const job = {
        input: input.id,
        name: input.name,
        // **Whether the two pulls are on one clock**, which is the fact a cut
        // taken against a transcript has to be told. See the header.
        sameClock: !where.audio,
        audio: blank(),
        video: blank(),
    };

    job.video.path = pathFor(dir, input.name, 'video');
    job.video.label = `${input.name} · ${where.videoName}`;
    job.video.url = where.video;
    if (where.audio) {
        job.audio.path = pathFor(dir, input.name, 'audio');
        job.audio.label = `${input.name} · ${where.audioName}`;
        job.audio.url = where.audio;
        // The picture is described but not started. `tick()` begins it when the
        // soundtrack is off the link — see the measurement in the header, and
        // note that `waiting` is this module's word rather than the queue's: the
        // fetch does not exist yet, so there is nothing queued to be behind.
        job.video.state = 'waiting';
        begin(job.audio);
    } else {
        begin(job.video);
    }

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
