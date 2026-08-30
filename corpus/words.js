// Turning one pulled recording into the words that were said in it — the step
// between a pull and a search, and the only expensive thing the corpus does
// twice a day.
//
// ── Two calls, because two different things drive them ─────────────────────
//
// `corpus/pull.js`'s shape with its async phase taken off: nothing here asks the
// network, so there is no `planTranscribe` and nothing to resolve up front.
// `startTranscribe` is synchronous and answers a job. `pollTranscribe` is
// synchronous, idempotent, and is where the `.srt` and the state file are
// written. `stopTranscribe` cancels. A command line drives that by pumping the
// engine in a loop; a window drives it from its frame loop; neither has to know
// what the other does and nothing here waits for anything.
//
// That mattered less for a pull than it does here. A pull is the network and can
// be watched; a transcription is **the GPU for half an hour** on a six-hour
// recording, and the old path (`transcribeVod` in `tools/corpus.js`) stood on
// the JS thread for every second of it, driving the workbench's Write stage to
// render five-minute wavs and handing each to a synchronous `bro.stt` call. That
// is a command line and could never have been anything else.
//
// ── Why the reading itself is native ───────────────────────────────────────
//
// `bro.ffmpeg.words` is the whole of it, and `src/native/spoken_words.h` carries
// the reasoning. What matters to this file is what that surface promises:
//
//   · it **never blocks** — the decode, the windowing and Parakeet all run on a
//     thread, so a window polling this stays at sixty frames;
//   · `result` is filled in **while it reads**, and `read` says how far down the
//     recording it has got, which is what a progress bar is drawn from;
//   · a word is timed to the encoder frame it was emitted at (0.08 s), on the
//     input's own clock — the clock the pictures are cut on, which is the whole
//     point of pulling the picture rendition (see `corpus/store.js`);
//   · the model is loaded once per directory and kept, so transcribing five
//     recordings in a row pays for 2.4 GB of weights once;
//   · a terminal read **keeps answering until `forget`**, which is why `forget`
//     is required rather than tidy and why `pollTranscribe` calls it on the
//     frame the read lands.
//
// ── A transcript is either finished or absent ──────────────────────────────
//
// `transcribeVod`'s rule, carried over unchanged, and it is the reason the
// `.srt` is written on `done` and on nothing else. Part of a transcript is worse
// than none: a search over it answers "he never said that" about the half nobody
// read, and unlike a truncated download there is nothing *in the file* that says
// so. So a `stopped` read keeps its words in memory for whoever asked to stop
// it, and writes none of them; a `failed` read that died an hour in writes none
// either.
//
// **One thing about that is now different and it does not change the answer.**
// The old path could not describe a partial transcript at all; this one can, and
// `read` is exactly that description — "the first 2 h 14 m of this recording
// were transcribed" is a true and useful sentence, and a caller holding a job
// can say it. But it is a property of the *job*, and the job ends with the
// process. An `.srt` on disk carries no such field and no reader of one asks for
// it, so what is written stays all-or-nothing until the file format grows a way
// to say how far it got — which it should not, because every reader in this
// repository would then have to check.

import { vodPaths, loadState, saveState, isPulled } from './store.js';
import { readSrt, writeSrt } from './srt.js';
import { ROOT, exists } from './files.js';

// ── where the model is ─────────────────────────────────────────────────────

/// The Parakeet checkpoint, beside this repository rather than inside it.
///
/// **One home for this path**, which it did not have: `loadSpeech` in
/// `tools/speech.js` derived it from a `root` argument its three callers each
/// passed, so the answer was written down once and reached four ways. It is here
/// because this is the file that reads speech, and `tools/speech.js` now asks.
///
/// Beside the repo, the way CLAUDE.md's build instructions expect bro to be —
/// `brosoundml/scripts/download-parakeet.sh` puts one there. Nothing downloads
/// it and nothing ships it; an absent one is refused **by name** by the native
/// side, naming the file it could not find, which is a better answer than
/// anything this file could check for.
export const SPEECH_MODEL =
    `${ROOT.slice(0, ROOT.lastIndexOf('/'))}/brosoundml/weights/parakeet/0.6b-v3`;

/// The model directory to read with: what the caller named, or the one above.
export const speechModel = (over) => String(over || SPEECH_MODEL);

// ── one read, whatever it is over ──────────────────────────────────────────

/// Start reading the words out of a path or an input spec. Never blocks.
///
/// The low half of this file: no store, no `.srt`, no state — just the native
/// read with a job record around it, because `tools/transcribe.js` reads a file
/// somebody named and `tools/montage.js` reads a rendered span of a timeline,
/// and neither is a recording in a channel's store.
///
/// `opts` is `{ model, device, duration }`. `duration` is what the caller
/// already knows the soundtrack's length to be, so a progress bar is right on
/// the first frame rather than after the reader has opened the file; it is
/// replaced by the reader's own answer as soon as there is one.
///
/// **Nothing is probed here.** The old path opened the file to refuse "no
/// soundtrack" by name, which is 130 ms of blocking on an 18 GB Matroska for a
/// refusal the native reader already makes by name a moment later, on its own
/// thread. A caller who is going to open the file anyway passes `duration`.
export function startRead(source, opts = {}) {
    const job = { source, id: 0, state: 'reading',
                  read: 0, duration: opts.duration || 0,
                  words: 0, total: 0, truncated: false,
                  realtime: 0, elapsed: 0, error: '',
                  began: Date.now(), said: [], result: null };
    try {
        job.id = bro.ffmpeg.words.reads.start(source, {
            model: speechModel(opts.model),
            device: opts.device || '',
        });
    } catch (e) {
        job.state = 'failed';
        job.error = String((e && e.message) || e);
        return job;
    }
    if (!job.id) {
        job.state = 'failed';
        job.error = 'the read would not start';
    }
    return job;
}

/// Read where a read has got to, and finish it on the frame it lands.
///
/// **Idempotent**, for `pollPull`'s reason: both drivers call this in a loop
/// with no memory of having called it, so a job that has already been forgotten
/// must answer with itself and touch nothing. The state is what says so — and
/// here it is load-bearing twice over, because a forgotten id polls as `null`
/// and a second pass would otherwise turn a finished read into a failed one.
///
/// **Only the words nobody has seen yet are asked for.** `since` is how a frame
/// loop polls this: without it the answer carries every word read so far, copied
/// out from under the reader's own lock and built into a JS object apiece, and
/// that list only grows — 0.080 ms at 434 words, 0.660 ms at 2 824, and a
/// six-hour recording ends at 24 343, which is 5.7 ms of a frame sixty times a
/// second for words the caller was handed minutes ago. So the count already held
/// is what is asked from, and `result.from` says where the answer starts.
///
/// The words are converted from the native shape (`{ start, end, text }`) to the
/// one an `.srt` and `ui/phrase.js` are written in (`{ from, to, text }`) as they
/// arrive, into `job.said`, which is the accumulated transcript and becomes
/// `job.result` on the frame the read turns terminal. Converting a tail is a few
/// objects; it was deferred to the end only because the whole list used to come
/// back every time.
export function pollRead(job) {
    if (!job || job.state !== 'reading') return job;

    if (!job.said) job.said = [];
    const p = bro.ffmpeg.words.reads.poll(job.id, { since: job.said.length });
    if (!p) {
        job.state = 'failed';
        job.error = 'the read this was waiting on is no longer known';
        return job;
    }

    const r = p.result || {};
    job.read = r.read || 0;
    if (r.duration > 0) job.duration = r.duration;
    // Placed at the index the reader says it started copying from rather than
    // appended, so an answer that began further back than was asked for
    // overwrites those words instead of doubling them.
    const got = r.words || [];
    for (let i = 0; i < got.length; i++) {
        const w = got[i];
        job.said[(r.from || 0) + i] = { from: w.start, to: w.end, text: w.text };
    }
    job.words = job.said.length;
    job.total = r.total || 0;
    job.truncated = !!r.truncated;
    job.elapsed = p.elapsed || (Date.now() - job.began) / 1000;
    // Audio seconds per wall second — the number people actually watch, and the
    // one the time left is worked out from. Not words per second: a quiet hour
    // reads as fast as a loud one and would look like a stall.
    job.realtime = job.read / Math.max(0.001, job.elapsed);

    if (p.state === 'reading') return job;

    job.result = job.said;
    job.state = p.state;
    if (p.state === 'failed') job.error = p.error || 'the read failed';
    // Required rather than tidy: a terminal read keeps answering until this.
    try { bro.ffmpeg.words.reads.forget(job.id); } catch (e) { /* already gone */ }
    return job;
}

/// Ask a read to stop. It stops at the next window and keeps what it has, so the
/// press that asked still gets the words that were read.
export function stopRead(job) {
    if (!job || job.state !== 'reading' || !job.id) return;
    try { bro.ffmpeg.words.reads.cancel(job.id); } catch (e) { /* already terminal */ }
}

/// Is there still something to wait for? The predicate both drivers ask.
export const reading = (job) => !!job && job.state === 'reading';

// ── one recording in the store ─────────────────────────────────────────────

/// Start transcribing one VOD's pulled recording. Synchronous; answers a job.
///
/// The record is `{ login, meta, id, path, state, read, duration, words,
/// realtime, elapsed, error }` where `path` is where the `.srt` will go and `id`
/// is the native read's. `state` is one of:
///
///   `reading`  the read is running
///   `done`     the `.srt` is written and the state file with it
///   `failed`   `error` says what happened; nothing was written
///   `stopped`  somebody cancelled; nothing was written — see the block above
///   `skipped`  there is already a transcript and `opts.again` was not set
///
/// `opts` is `{ again, model, device }`. There is deliberately no `from`/`to`:
/// the native reader reads a whole soundtrack and the store has never held
/// anything else — `state.json`'s `transcript.from`/`to` were 0 and the duration
/// on every recording ever transcribed into it.
///
/// **Refuses a recording that is not completely pulled, and the refusal is not a
/// nicety.** A pull in flight has a valid, growing Matroska on disk from its
/// first second, so `exists()` says yes about a file holding twenty minutes of a
/// six-hour broadcast — and the transcript of that has nothing wrong with it and
/// answers "he never said that" about the rest. `isPulled` asks the state, which
/// is written only after the fetch reported done; its comment says why. Thrown
/// rather than asserted, because `assert` is the headless runner's global and
/// this module is imported by a window (`corpus/store.js`).
export function startTranscribe(login, meta, opts = {}) {
    const p = vodPaths(login, meta.id);
    const st = loadState(login, meta.id);
    const job = { login, meta, id: 0, path: p.srt, state: 'reading',
                  read: 0, duration: (st.media && st.media.seconds) || 0,
                  words: 0, total: 0, truncated: false,
                  realtime: 0, elapsed: 0, error: '',
                  began: Date.now(), said: [], result: null };

    if (exists(p.srt) && !opts.again) {
        job.state = 'skipped';
        job.words = readSrt(p.srt).length;
        job.read = job.duration;
        return job;
    }
    if (!isPulled(login, meta.id))
        throw new Error(`${meta.id} has not been pulled completely yet`);

    // The length comes off the state file rather than off a probe, and it is the
    // same number a probe would give: `corpus/pull.js` wrote it from the local
    // file's own `format.duration` on the frame the copy landed, deliberately,
    // because that is what everything downstream measures a transcript against.
    const read = startRead(p.media, { ...opts, duration: job.duration });
    job.id = read.id;
    job.state = read.state;
    job.error = read.error;
    return job;
}

/// Read where a transcription has got to, and finish it on the frame it lands.
///
/// Idempotent for `pollRead`'s reason and one of its own: this is where the
/// `.srt` and `state.json` are written, and a second pass would rewrite both —
/// the transcript identically and the state file with a later `at`, which is the
/// one field in it that is a fact about *when the work was done*.
export function pollTranscribe(job) {
    if (!job || job.state !== 'reading') return job;

    pollRead(job);
    if (job.state === 'reading') return job;
    // Cancelled, or died partway: keep the words on the job for whoever asked,
    // and write nothing. See the block at the top of this file for why a
    // half-read recording must not leave a transcript behind.
    if (job.state !== 'done') return job;

    writeSrt(job.path, job.result);

    const meta = job.meta;
    saveState(job.login, meta.id, {
        ...loadState(job.login, meta.id),
        id: meta.id, title: meta.title, page: meta.page,
        seconds: meta.seconds, publishedAt: meta.publishedAt,
        // The shape an existing store already holds, unchanged so that one keeps
        // working. `from`/`to` are 0 and the length of what was read: this reads
        // whole files, and it always did.
        transcript: { path: job.path, words: job.result.length,
                      from: 0, to: job.read,
                      realtime: job.realtime, seconds: job.elapsed,
                      at: new Date().toISOString() },
    });
    return job;
}

/// Stop a transcription that is still running. Nothing is written — the words it
/// had are on the job, and the next run starts the recording again.
export const stopTranscribe = stopRead;

/// Is there still something to wait for?
export const running = reading;
