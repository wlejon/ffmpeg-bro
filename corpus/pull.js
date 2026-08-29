// Getting one recording onto this machine — the step everything else in a
// corpus waits for.
//
// ── Why the pull is a stream copy and not a download ──────────────────────
//
// The packets already on the CDN are written into a local container without
// being decoded — no compositor, no encoder, no filter graph — so it runs at
// whatever the network gives rather than at whatever an encoder would, and what
// lands on disk is bit-identical to what Twitch served. Matroska, because a copy
// has to go into a container that will hold what is being copied and an mp4
// would refuse the timed-ID3 track Twitch carries alongside the picture. That
// track is dropped rather than the container changed to suit it: what it carries
// is Twitch's own segment metadata, which means nothing once the recording is
// off Twitch and is not what anybody came for.
//
// ── Why it is a fetch and no longer a drive of the Write stage ────────────
//
// **This used to press `Rewrap` and then `#ex-go` on the workbench's Write
// stage**, which is why it lived in `tools/`: it needed an application with six
// stages in it, and the supercut window has none of them. That was the one thing
// standing between "the mechanics of building a corpus" and "a module either
// face can import", and `bro.ffmpeg.fetch` is the same copy with the interface
// taken off the front of it. Three things follow, and all three are gains:
//
// **It holds no job slot** (`src/native/fetch_queue.h`). A render's one slot is
// the thing you came to the application to do; a forty-minute pull sitting in it
// would lock out the Render button for forty minutes, which is backwards — the
// download is what you start *so that* you can get on. So a pull now runs while
// a render runs, and while somebody is using the window.
//
// **Several run at once.** The queue is two workers wide, and the number is
// deliberately small: every fetch is a download, they share one link, and three
// concurrent pulls of one CDN finish later in total than two do. Nothing here
// states a second number — the pool is `fetch_queue.h`'s and stating one here
// would be a second answer to one question.
//
// **The progress is honest for free.** `fetch.status(id)` answers `position`,
// `span` and `progress` on the *output's* clock — what has been written and how
// much was asked for — so a caller has a real bar without a second request and
// without timing anything itself.
//
// Measured end to end against a real Twitch VOD: sixty seconds of 1080p60 in
// **2.7 s of wall time, 17 MB/s**.
//
// ── The file is written `.part` and renamed on Done ───────────────────────
//
// `supercut/cuts.js`'s rule, for its reason exactly: a rename of a file libav
// still holds fails silently on Windows, so it happens after the fetch has
// published a terminal state and not a moment before. What that buys is that a
// `media.mkv` which exists is a `media.mkv` that finished — a session killed
// mid-pull used to leave a valid Matroska holding twenty minutes of a six-hour
// broadcast under the name the next run would take for the whole thing.
// `isPulled` still asks the *state* rather than the name, because a store on
// this machine holds recordings written before that was true.
//
// ── Three calls, because two different things drive them ──────────────────
//
// `planPull` is async and asks the network what one recording is. `startPull` is
// synchronous and returns a job. `pollPull` is synchronous, idempotent, and is
// where the rename and the state file happen. A command line drives that by
// pumping the engine in a loop; a window drives it from its frame loop; neither
// has to know what the other does, and nothing here waits for anything.

import { resolve, forWatching, mediaDuration } from './vod.js';
import { copyRowsOf } from '../ui/export/copy.js';
import { vodPaths, loadState, saveState, probeQuietly } from './store.js';
import { mkdirp, exists, sizeOf, unlink, rename, gb, span } from './files.js';

/// Ask the network what one recording is, and whether there is anything to do.
///
/// Answers `null` for a recording already on disk — which is also why the
/// already-pulled test lives here: there is no point resolving a signed URL for
/// something that is not going to be fetched. Otherwise `{ pick, real }`: the
/// rendition to copy and how long it is.
///
/// Resumable: a pull that already produced a file of a plausible length is left
/// alone. "Plausible" is asked of the file rather than of its size — a copy
/// interrupted halfway leaves a valid container holding half a broadcast, and
/// the only honest test of that is what libavformat says its duration is.
///
/// **Every `await` in a batch still has to happen before the first copy is
/// driven, and the rule survived the move for a reason that was never about
/// copying.** It reads: a `fetch` issued *after* a long stretch of synchronous
/// pumping never starts, and the run dies with "top-level await did not settle …
/// no pending jobs, timers, or async work remaining" — the engine correctly
/// reporting a promise nothing will ever resolve. What causes that is a caller
/// standing on the JS thread for twenty minutes (`drive.until`), not what it is
/// standing there for; the copy being a fetch rather than a render changes
/// nothing about it. So a **command line** still resolves every plan up front,
/// and `tools/supercut.js` does. A **window** never blocks the engine at all, so
/// it may resolve a plan whenever somebody presses the button — which is the
/// difference this split exists to allow, and the reason the rule is stated as a
/// fact about the driver rather than as a shape this file imposes.
export async function planPull(login, meta, log = console.log) {
    const p = vodPaths(login, meta.id);
    mkdirp(p.dir);

    if (exists(p.media)) {
        const got = probeQuietly(p.media);
        // Thirty seconds of slack: a transcode can genuinely end a moment early,
        // and the playlist's total is not the broadcast's to the frame.
        if (got && got.format.duration >= meta.seconds - 30) {
            log(`  ${meta.id} already pulled · ${gb(sizeOf(p.media))} · ` +
                `${span(got.format.duration)}`);
            return null;
        }
        log(`  ${meta.id} stopped at ${span(got ? got.format.duration : 0)} ` +
            `of ${span(meta.seconds)} — pulling again`);
        unlink(p.media);
    }

    const vod = await resolve(meta.page);
    const pick = forWatching(vod);
    if (!pick) throw new Error(`${meta.page} has no picture rendition`);
    // **The playlist's own sum, even though the probe now answers a duration.**
    // `startPull` opens this rendition a moment later and gets the same number
    // (9350 s for a 935-segment VOD, both) — but this is the pass that runs
    // before anything long has, it is where the expected size is printed, and
    // `segments` is a fact only the manifest holds. See `mediaDuration`.
    const real = await mediaDuration(pick.url);
    log(`  ${meta.id} ${pick.name} · ${Math.round(pick.bandwidth / 1000)} kb/s · ` +
        `${real.segments} segments · ${span(real.seconds)} · ` +
        `expect about ${gb(pick.bandwidth * real.seconds / 8)}`);
    return { pick, real };
}

/// Start the copy a plan describes. Synchronous, and answers a job record.
///
/// The record is `{ id, path, part, state, … }` where **`id` is the fetch's
/// number** — the thing `pollPull` reads and the thing `bro.ffmpeg.fetch.stop`
/// takes — and the VOD is `meta`. `state` is one of:
///
///   `copying`  the fetch is queued or running
///   `done`     the file is under its real name and the state file is written
///   `failed`   `error` says what happened; nothing was renamed
///   `skipped`  `planPull` answered null, so this is already on disk
///
/// A null plan is not an error and is the ordinary case on a second run, which
/// is why it answers a job rather than nothing: a caller walking a batch wants
/// one row per recording whether or not anything was copied.
///
/// **The rendition is probed synchronously**, which is 0.71 s over HTTPS and is
/// the one blocking call here. It is what the copy rows are made of and there is
/// no other way to learn a stream list. A window that must not spend a frame on
/// it should open it on a thread the way `ui/localcopy.js` does
/// (`bro.ffmpeg.probes.start`) and call this when the answer lands; that is a
/// change to this signature, not to anything below it, and it is not made
/// speculatively.
export function startPull(login, meta, plan) {
    const p = vodPaths(login, meta.id);
    const job = { login, meta, id: 0, path: p.media, part: `${p.media}.part`,
                  state: 'copying', rendition: '', segments: 0,
                  progress: 0, position: 0, span: 0, bytes: 0, seconds: 0,
                  error: '', began: Date.now() };

    if (!plan) {
        const got = probeQuietly(p.media);
        job.state = 'skipped';
        job.bytes = sizeOf(p.media);
        job.seconds = got ? got.format.duration : 0;
        return job;
    }

    job.rendition = plan.pick.name;
    job.segments = plan.real.segments;

    let probe;
    try {
        probe = bro.ffmpeg.probe(plan.pick.url);
    } catch (e) {
        job.state = 'failed';
        job.error = `could not open ${plan.pick.name}: ${(e && e.message) || e}`;
        return job;
    }

    // **Which streams can be copied at all is `copyRowsOf`'s and not this
    // file's** — the Write stage's `Rewrap`, `ui/localcopy.js` and
    // `supercut/cuts.js` ask the same question, and a second list of copyable
    // kinds is the pair that comes to disagree the day a fifth kind exists.
    // What is decided here is only what a copy *into Matroska* then drops.
    let n = 0;
    const rows = copyRowsOf(probe, 0, () => ++n, null)
        .filter((r) => r.kind !== 'data');
    if (!rows.length) {
        job.state = 'failed';
        job.error = `there is nothing in ${plan.pick.name} that can be copied`;
        return job;
    }
    job.dropped = probe.streams.filter((s) => s.kind === 'data').length;

    mkdirp(p.dir);
    try {
        job.id = bro.ffmpeg.fetch.start({
            path: job.part,
            format: 'matroska',
            inputs: [{ path: plan.pick.url }],
            streams: rows,
        }, {
            // Never a signed URL: the label is read back by anything listing
            // fetches, and a token is five hundred characters and not a name.
            label: `${login} ${meta.id}`,
            // **Never `soon`.** That flag is for a cut taken against a
            // transcript, which needs a few seconds of video now; a pull is the
            // forty-minute job it exists to jump ahead of.
            soon: false,
        });
    } catch (e) {
        job.state = 'failed';
        job.error = String((e && e.message) || e);
    }
    return job;
}

/// Read where a job has got to, and finish it on the frame it lands.
///
/// **Idempotent, and that is load-bearing rather than tidy.** Both drivers call
/// this in a loop with no memory of having called it — a frame loop by
/// construction, and `drive.until`'s predicate about eight times a second — so a
/// job that has already been renamed and written down must answer with itself
/// and touch nothing. The state is what says so; a second rename would fail and
/// a second `saveState` would rewrite the file with a later `at`.
export function pollPull(job) {
    if (!job || job.state !== 'copying') return job;

    const f = bro.ffmpeg.fetch.status(job.id);
    // An id the queue does not know about answers with a blank status, whose id
    // is zero. That is `clearFinished` having run under this job rather than
    // anything about the copy, and there is nothing left to wait for.
    if (!f || !f.id) {
        job.state = 'failed';
        job.error = 'the fetch this was waiting on is no longer known';
        return job;
    }

    job.progress = f.progress || 0;
    job.position = f.position || 0;
    job.span = f.span || 0;
    job.bytes = f.bytes || 0;
    job.elapsed = f.elapsedSec || (Date.now() - job.began) / 1000;

    if (f.state === 'failed' || f.state === 'cancelled') {
        job.state = 'failed';
        job.error = f.error || f.state;
        return job;
    }
    if (f.state !== 'done') return job;

    // Terminal state published, so the muxer has closed and the file can be
    // moved. See the block at the top: on Windows it cannot be, before.
    if (!rename(job.part, job.path)) {
        job.state = 'failed';
        job.error = 'the recording could not be put in place';
        return job;
    }

    // **What goes in the state file is what the local file says, not what the
    // rendition said.** The two agree; the point is that this is the number
    // everything downstream measures a transcript and a cut against, and it is a
    // property of the file that is now on this disk.
    const got = probeQuietly(job.path);
    job.bytes = got ? got.format.size : sizeOf(job.path);
    job.seconds = got ? got.format.duration : 0;

    const meta = job.meta;
    saveState(job.login, meta.id, {
        ...loadState(job.login, meta.id),
        id: meta.id, title: meta.title, page: meta.page,
        seconds: meta.seconds, publishedAt: meta.publishedAt,
        media: { path: job.path, bytes: job.bytes, seconds: job.seconds,
                 rendition: job.rendition, segments: job.segments,
                 at: new Date().toISOString() },
    });
    job.state = 'done';
    return job;
}

/// Stop a pull that is still running. The part-file stays where it is and the
/// next run writes over it — there is no half-recording under a real name.
export function stopPull(job) {
    if (!job || job.state !== 'copying' || !job.id) return;
    try { bro.ffmpeg.fetch.stop(job.id); } catch (e) { /* already terminal */ }
}

/// Is there still something to wait for? The predicate both drivers ask.
export const running = (job) => !!job && job.state === 'copying';
