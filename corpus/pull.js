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
// ── A killed pull is resumed, not started again ───────────────────────────
//
// Thirty gigabytes is twenty minutes of somebody's link. Closing the window used
// to throw all of it away, because the `.part` was invisible to `planPull` — it
// looks only for a finished `media.mkv` — so the next press began at zero and
// wrote over what was there. For an eight-hour broadcast that is the difference
// between finishing a corpus and giving up on one.
//
// Three measurements decided the shape, all taken on the real thing:
//
// **A killed Matroska does not say how long it is.** Its duration lives in a
// header libav writes when the muxer closes, so `probe` answers `0.0` for a
// 21 GB part — the streams are all readable, only the total is missing. What
// does answer is a keyframe walk: `bro.ffmpeg.keyframes(part, { ms: 0 })` came
// back `complete` with 11 199 keyframes and a last one at 22 396 s in **6.4 s**.
// So the file is asked rather than a running total being kept beside it, which
// would be a second thing to get right and would be wrong exactly when a process
// died without flushing it. The default `ms: 500` is what must be turned off:
// with it the walk stops early and cheerfully reports a last keyframe an hour
// short, which is a resume that silently loses an hour.
//
// **The part has to be trimmed where the tail begins, and the concat list is
// what does it.** A part runs on past its last complete keyframe — a partial GOP
// nobody can decode — and the tail can only start *at* a keyframe. Joined as
// they are, that overlap is duplicated: measured **+3.420 s** on a 24 s file cut
// with 3.454 s of slop. With `outpoint` on the first entry the same join is
// **−0.034 s**, a frame or two, which is as exact as a stream copy of a
// keyframe-aligned seam gets.
//
// **The join is libavformat's own `concat` demuxer**, not arithmetic here: one
// input, ordinary copy rows, `safe 0`, and the whole thing is the same stream
// copy every other path in this file performs. Writing a joiner would mean
// owning timestamp continuity across two containers, which is precisely what
// that demuxer exists to own. It costs one pass over the recording.
//
// ── Four calls, because two different things drive them ───────────────────
//
// `planPull` is async and asks the network what one recording is. `startPull` is
// synchronous and returns a job. `pollPull` is synchronous, idempotent, and is
// where the rename, the join and the state file happen. A command line drives
// that by pumping the engine in a loop; a window drives it from its frame loop;
// neither has to know what the other does, and nothing here waits for anything.

import { resolve, forWatching, mediaDuration } from './vod.js';
import { copyRowsOf } from '../ui/export/copy.js';
import { vodPaths, loadState, saveState, probeQuietly } from './store.js';
import { mkdirp, exists, sizeOf, unlink, rename, writeText, modifiedAt,
         abs, gb, span } from './files.js';

/// The four names one pull can have on disk at once. Derived rather than kept in
/// `vodPaths`, because only this file ever sees three of them: what the rest of
/// the store knows about is `media.mkv`, and that name appears the moment the
/// recording behind it is whole.
const partOf = (media) => `${media}.part`;
const tailOf = (media) => `${media}.tail`;
const joinOf = (media) => `${media}.join`;
const listOf = (media) => `${media}.join.txt`;

/// How still a `.part` has to be before it is treated as abandoned.
///
/// **There is no lock and this is the evidence there is.** A part being written
/// right now by the other face — the window while a batch runs, or the reverse —
/// is not something either process can ask the other about, and resuming from
/// the end of a file somebody else is still appending to would interleave two
/// copies into one container. A fetch writes continuously, so ten seconds of a
/// file not changing is a writer that has gone.
const kAbandonedMs = 10000;

/// Where a killed pull actually stopped: its last complete keyframe, or 0.
///
/// **Zero means "start again", and it is the answer for three different
/// reasons** — there is no part, the walk could not finish, or the file holds no
/// keyframe at all (a part killed inside its first GOP). A caller cannot act
/// differently on those and the honest response to every one of them is the same
/// pull from the beginning, so they are one answer.
///
/// Costs a full walk of the file — 6.4 s for 21 GB, synchronously, which is the
/// one blocking call a resume makes. It is paid once, on the press that is about
/// to spend twenty minutes downloading, and the alternative measured worse in
/// every way: a running total written beside the file is a second thing to keep
/// in step and is wrong precisely when a process dies without flushing it.
export function resumePoint(part) {
    if (!exists(part)) return 0;
    let k;
    try {
        // `ms: 0` for no deadline — see the block at the top; the default of 500
        // stops the walk early and reports a last keyframe an hour short of the
        // truth. `max` is generous rather than absent because this is somebody's
        // disk: a hundred hours at the two-second GOP Twitch writes.
        k = bro.ffmpeg.keyframes(part, { ms: 0, max: 200000 });
    } catch (e) {
        return 0;
    }
    if (!k || !k.complete || !k.times || !k.times.length) return 0;
    return k.times[k.times.length - 1] || 0;
}

/// Is this part something to carry on from, or something in the way?
///
/// Answers `{ from, why }`: `from` above zero is where a tail must start, and
/// `why` is filled in only when a part exists and cannot be used, so a caller can
/// say which of the two it did.
function resumable(part) {
    if (!exists(part)) return { from: 0, why: '' };
    if (Date.now() - modifiedAt(part) < kAbandonedMs)
        return { from: 0, why: 'something is still writing to this recording' };
    const from = resumePoint(part);
    if (!(from > 0))
        return { from: 0, why: 'what is on disk holds no whole keyframe to carry on from' };
    return { from, why: '' };
}

/// Ask the network what one recording is, and whether there is anything to do.
///
/// Answers `null` for a recording already on disk — which is also why the
/// already-pulled test lives here: there is no point resolving a signed URL for
/// something that is not going to be fetched. Otherwise `{ pick, real }`: the
/// rendition to copy and how long it is.
///
/// Resumable at two levels. A pull that already produced a file of a plausible
/// length is left alone — "plausible" asked of the file rather than of its size,
/// because a copy interrupted halfway leaves a valid container holding half a
/// broadcast and the only honest test of that is what libavformat says its
/// duration is. And a pull that was *killed* leaves a `.part`, which is carried
/// on from rather than written over: the plan then names `resumeFrom`, and the
/// block at the top of this file is why that is worth the machinery.
///
/// **A part something else is still writing is refused by name rather than
/// resumed.** Two processes appending to one container is the way to lose the
/// twenty minutes this feature exists to save, and the refusal is the only thing
/// standing between a window and a batch run started in another terminal.
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

    // Asked before the network is, because it decides what is asked *for* and
    // because a part somebody else is writing must stop this here rather than
    // after a signed URL has been spent on it.
    const part = partOf(p.media);
    const carry = resumable(part);
    if (carry.why) throw new Error(`${meta.id}: ${carry.why}`);
    if (carry.from > 0)
        log(`  ${meta.id} carrying on from ${span(carry.from)} ` +
            `(${gb(sizeOf(part))} already here)`);

    // **A resume that was itself interrupted loses only its own tail**, and that
    // is the one limit of this worth stating out loud. What is carried on from
    // is the part; a tail left behind by a stopped resume is dropped here rather
    // than carried on from in turn, because doing that needs each half to
    // remember where in the broadcast it began — the part's clock starts at zero
    // and a tail's does not. So closing the window during a resume costs that
    // resume's progress and never the twenty gigabytes underneath it. Making it
    // lossless is a numbered chain of parts and a join over all of them, which is
    // worth writing the day somebody is interrupted twice.
    if (exists(tailOf(p.media))) {
        log(`  ${meta.id} dropping ${gb(sizeOf(tailOf(p.media)))} from a resume ` +
            `that did not finish`);
        unlink(tailOf(p.media));
        unlink(listOf(p.media));
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
        `expect about ${gb(pick.bandwidth * Math.max(0, real.seconds - carry.from) / 8)}`);
    return { pick, real, resumeFrom: carry.from };
}

/// Start the copy a plan describes. Synchronous, and answers a job record.
///
/// The record is `{ id, path, part, state, … }` where **`id` is the fetch's
/// number** — the thing `pollPull` reads and the thing `bro.ffmpeg.fetch.stop`
/// takes — and the VOD is `meta`. `state` is one of:
///
///   `copying`  the fetch is queued or running
///   `joining`  a resumed pull, putting what was here and what just arrived
///              back into one file. Only ever reached when `resumeFrom` is set
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
    const job = { login, meta, id: 0, path: p.media, part: partOf(p.media),
                  state: 'copying', rendition: '', segments: 0,
                  // Above zero when there was a `.part` to carry on from. It is
                  // both the seam the join is made at and the offset every
                  // progress number below has to be read against.
                  resumeFrom: 0, held: 0,
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
    job.resumeFrom = plan.resumeFrom || 0;
    job.held = job.resumeFrom > 0 ? sizeOf(job.part) : 0;

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
        .filter((r) => r.kind !== 'data')
        // A resume asks for the rest of the broadcast and nothing else. The
        // copy begins at the keyframe at or before this — which here is the
        // keyframe the part *ends* on, since both files are copies of the same
        // rendition and share its keyframes, so the seam meets exactly.
        .map((r) => (job.resumeFrom > 0
            ? Object.assign(r, { copyFrom: job.resumeFrom }) : r));
    if (!rows.length) {
        job.state = 'failed';
        job.error = `there is nothing in ${plan.pick.name} that can be copied`;
        return job;
    }
    job.dropped = probe.streams.filter((s) => s.kind === 'data').length;

    mkdirp(p.dir);
    try {
        job.id = bro.ffmpeg.fetch.start({
            // A resume must not write over the thing it is carrying on from.
            path: job.resumeFrom > 0 ? tailOf(p.media) : job.part,
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
    if (!job) return job;
    if (job.state === 'joining') return pollJoin(job);
    if (job.state !== 'copying') return job;

    const f = bro.ffmpeg.fetch.status(job.id);
    // An id the queue does not know about answers with a blank status, whose id
    // is zero. That is `clearFinished` having run under this job rather than
    // anything about the copy, and there is nothing left to wait for.
    if (!f || !f.id) {
        job.state = 'failed';
        job.error = 'the fetch this was waiting on is no longer known';
        return job;
    }

    // **On a resume every one of these is about the tail alone**, so what was
    // already on disk is added back before anybody draws a bar from them. The
    // fetch is copying the rest of the broadcast and honestly reports itself
    // finished at the end of it; a progress bar that restarted at nothing after
    // twenty gigabytes would be describing the fetch rather than the recording.
    job.position = (f.position || 0) + job.resumeFrom;
    job.span = f.span ? f.span + job.resumeFrom : 0;
    job.progress = job.span > 0 ? job.position / job.span : (f.progress || 0);
    job.bytes = (f.bytes || 0) + job.held;
    job.elapsed = f.elapsedSec || (Date.now() - job.began) / 1000;

    if (f.state === 'failed' || f.state === 'cancelled') {
        job.state = 'failed';
        job.error = f.error || f.state;
        return job;
    }
    if (f.state !== 'done') return job;

    // Terminal state published, so the muxer has closed and the files can be
    // moved. See the block at the top: on Windows they cannot be, before.
    if (job.resumeFrom > 0) return beginJoin(job);
    if (!rename(job.part, job.path)) {
        job.state = 'failed';
        job.error = 'the recording could not be put in place';
        return job;
    }

    return finish(job);
}

/// The recording is under its real name: measure it and write it down.
///
/// Both endings come through here — the plain one and the join — so a resumed
/// recording is described by exactly the same numbers as one pulled in a single
/// run, which is the property that makes a resume invisible to everything
/// downstream.
///
/// **What goes in the state file is what the local file says, not what the
/// rendition said.** The two agree; the point is that this is the number
/// everything downstream measures a transcript and a cut against, and it is a
/// property of the file that is now on this disk.
function finish(job) {
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

/// Put what was already here and what has just arrived back into one file.
///
/// **libavformat's `concat` demuxer does it**, which is the whole reason this is
/// nine lines rather than a container-joining routine: what has to be got right
/// is timestamp continuity across two files, and that demuxer exists to own it.
/// One input, ordinary copy rows, and the same stream copy as everything else
/// here — nothing is decoded and nothing is re-encoded.
///
/// **`outpoint` on the first entry is not optional.** A killed part runs on past
/// its last complete keyframe and the tail begins *at* that keyframe, so without
/// the trim the overlap is written twice: measured **+3.420 s** against the
/// original on a file with 3.454 s of slop, against **−0.034 s** with it.
function beginJoin(job) {
    const list = listOf(job.path);
    // libavformat parses this, so it is libavformat's format: `ffconcat` with a
    // version, absolute paths, forward slashes. `safe 0` is what allows an
    // absolute path at all.
    writeText(list,
        'ffconcat version 1.0\n' +
        `file '${abs(job.part)}'\n` +
        `outpoint ${job.resumeFrom.toFixed(6)}\n` +
        `file '${abs(tailOf(job.path))}'\n`);

    const input = { path: list, format: 'concat', options: { safe: '0' } };
    let probe;
    try {
        probe = bro.ffmpeg.probe(input);
    } catch (e) {
        job.state = 'failed';
        job.error = `the two halves could not be read back: ${(e && e.message) || e}`;
        return job;
    }

    let n = 0;
    const rows = copyRowsOf(probe, 0, () => ++n, null).filter((r) => r.kind !== 'data');
    if (!rows.length) {
        job.state = 'failed';
        job.error = 'there is nothing in the two halves that can be copied';
        return job;
    }

    try {
        job.joinId = bro.ffmpeg.fetch.start({
            path: joinOf(job.path), format: 'matroska',
            inputs: [input], streams: rows,
        }, {
            label: `${job.login} ${job.meta.id} join`,
            // **`soon`, unlike the pull.** This is the last step of something
            // that has already taken twenty minutes and it reads local disk
            // rather than the shared link, so there is nothing for it to be
            // polite to and a queue of downloads to not sit behind.
            soon: true,
        });
    } catch (e) {
        job.state = 'failed';
        job.error = `the two halves could not be joined: ${(e && e.message) || e}`;
        return job;
    }
    job.state = 'joining';
    job.joinBegan = Date.now();
    return job;
}

/// The join, watched to its end. One pass over the recording, on local disk.
function pollJoin(job) {
    const f = bro.ffmpeg.fetch.status(job.joinId);
    if (!f || !f.id) {
        job.state = 'failed';
        job.error = 'the join this was waiting on is no longer known';
        return job;
    }
    job.progress = f.progress || 0;
    job.position = f.position || 0;
    job.span = f.span || 0;
    if (f.state === 'failed' || f.state === 'cancelled') {
        job.state = 'failed';
        job.error = f.error || f.state;
        return job;
    }
    if (f.state !== 'done') return job;

    if (!rename(joinOf(job.path), job.path)) {
        job.state = 'failed';
        job.error = 'the joined recording could not be put in place';
        return job;
    }
    // Only now, and in this order: the halves are what a *second* failure would
    // have carried on from, so they are not dropped until there is a whole
    // recording under the name everything looks for.
    unlink(job.part);
    unlink(tailOf(job.path));
    unlink(listOf(job.path));
    return finish(job);
}

/// Stop a pull that is still running. The part-file stays where it is and the
/// next run carries on from it — which is the point of leaving it.
export function stopPull(job) {
    if (!job) return;
    // **A join is not stopped.** It is a minute of local disk at the end of
    // twenty minutes of network, and stopping it would leave the two halves and
    // no recording — which is a worse place to be than the one the press was
    // trying to leave. The next run carries on from the part either way.
    if (job.state !== 'copying' || !job.id) return;
    try { bro.ffmpeg.fetch.stop(job.id); } catch (e) { /* already terminal */ }
}

/// Is there still something to wait for? The predicate both drivers ask.
export const running = (job) =>
    !!job && (job.state === 'copying' || job.state === 'joining');
