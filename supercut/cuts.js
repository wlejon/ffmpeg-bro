// A moment, cut out of the recording it came from — and made scrubbable, which
// is a second file and not the same problem.
//
// ── Why a clip of a six-hour file is not good enough ──────────────────────
//
// A hit lands an hour into a fifteen-gigabyte recording, and a clip of it is a
// clip of the whole recording with an in-point. A supercut of thirteen moments
// is then an edit that reads **sixty gigabytes** to play fifty-two seconds, and
// a document that cannot be opened anywhere the recordings are not.
//
// So the moment is copied out. `-c copy`: packets, never decoded, into a
// Matroska file of its own — measured at **70 ms for a 25-second cut of a
// six-hour 1080p60 recording, 21 MB**. The same thirteen moments then read
// 270 MB, and the recordings are not needed again.
//
// **What this does not buy, measured, is a faster open or a faster seek.** That
// was the expectation and it is wrong: a 27-second 20 MB cut opens in ~110 ms
// and seeks in ~55 ms, and the six-hour 15 GB recording it came out of opens in
// ~129 ms and seeks in ~59 ms. Almost all of it is `avformat_find_stream_info`
// and opening an H.264 decoder, and neither cares how long the file is. What
// the cut changes is the *bytes*, the portability, and the guarantee below about
// having footage to edit with — and it makes one thing measurably worse, which
// is that thirteen moments of four recordings become thirteen distinct inputs
// rather than four. That is answered where it lands, by opening them at once
// (`TimelineSource::openTheFirstOfEach`), and it is named here so nobody comes
// looking for a speed-up this file does not provide.
//
// ── And a cut is still not something you can scrub ────────────────────────
//
// That paragraph was the answer to "make it instant" and it was the wrong
// answer, because the cost it names is real and is not where the time goes.
// **Setting `currentTime` blocks the UI thread until the picture arrives** —
// bro's `ElVideo::seekTo` calls `VideoPipeline::settleAt`, deliberately, because
// the documented answer to "what is at t?" is read back on the line after the
// assignment — so a hand dragging a trim edge pays a decode per position. On a
// 1080p60 recording with a two-second GOP that is **50 ms a seek**, and a stream
// copy of it is the same file with the same GOP, so cutting changed nothing
// about it.
//
// What does change it is the *format*, and only one property of it matters.
// Measured, forty seeks in a row on the same twenty-five seconds:
//
//     1080p60, GOP 120 — the recording, and the cut of it          50 ms
//     1080p60, GOP 4                                               46 ms
//     1080p60, every frame a keyframe                              24 ms
//      720p60, GOP 120                                             40 ms
//      720p60, every frame a keyframe                              11 ms
//
// Shortening the GOP does nothing until it reaches *none*: a seek lands on a
// keyframe and walks, and the walk is about 0.45 ms a picture whatever its size.
// The rest is per pixel. So the file that can be scrubbed is all-keyframe and
// about the size it is looked at, and it is a **proxy** — a second file beside
// the cut, made once, never rendered from, never in a document, deletable at any
// time. `src/native/proxy_queue.h` is why it is neither a render nor a fetch and
// what it measured; `supercut/screen.js` is the only reader.
//
// Three things about the proxy stage here. It is of the **cut**, not of the
// recording, so it reads twenty megabytes and takes about **1.9 s for a
// twenty-five second piece** (`h264_nvenc`; libx264 is 2.6 s) — which is why it
// waits for the cut rather than racing it. It is asked for **by file and not by
// clip**, because that is what it is a fact about, which is `screen.js`'s own
// rule and means two clips of one recording share one. And an input longer than
// `PROXY_LONGEST` does not get one at all: a proxy of six hours is twenty-eight
// minutes of encoding to speed up scrubbing somebody is doing *now*.
//
// ── The four decisions ────────────────────────────────────────────────────
//
// **The press does not wait for it.** The clip goes into the mix on the frame
// the button was pressed, against the recording, holding its place in the row
// and playable — slowly — while the copy runs. Then it is repointed. A press
// that put nothing on the screen for a second would be a press somebody pressed
// twice, and the whole shape of this application is somebody walking a list and
// pressing `+` on one row after another.
//
// **Ten seconds either side** (`PAD`). A cut taken to the word is a cut that
// cannot be fixed: the four gestures on a card — trim, slip, speed, reorder —
// all need footage outside the piece to work with, and a transcript is a search
// hint rather than the cut (see `docs/manual/find.md`). Ten seconds is enough
// for the sentence before and after; the cost is about 8 MB per side at these
// bitrates, which is nothing against not being able to fix a cut.
//
// **The in-point is snapped to a keyframe, before the copy rather than after
// it.** A stream copy can only begin at a keyframe — `av_seek_frame` is
// `AVSEEK_FLAG_BACKWARD` — so a copy asked to start at 3590.000 begins at
// 3589.983 and *that* is where the new file's zero is. Asking
// `bro.ffmpeg.keyframes` first makes the offset a number this file knows rather
// than one it would have to infer from the cut's duration afterwards, and an
// offset inferred wrongly is a clip whose sound is a frame out of its picture.
// The scan is 60 ms over a twenty-second window on these recordings, and it is
// synchronous — which is affordable exactly once per press.
//
// **A cut that fails leaves the clip on the recording.** Every failure here —
// no keyframe found, the fetch refused, the copy failed, the probe of the result
// failed — ends with the clip exactly as it was: correct, playable, slow. There
// is nothing in this file whose absence loses an edit.
//
// ── What it is not ────────────────────────────────────────────────────────
//
// **It is not a download and it does not hold the job slot.** `bro.ffmpeg.fetch`
// (src/native/fetch_queue.h) is the queue underneath, which is a stream copy
// running beside the application rather than in the render's one slot — so
// cutting goes on while the mix plays and while a render runs. `soon: true`,
// because a cut is the case the flag was put there for: "a cut taken against a
// transcript needs a few seconds of video *now*, and making it wait behind the
// forty-minute pull of the same recording would defeat the reason the transcript
// was made first."
//
// **The cut files are not the corpus and not the document's.** They are written
// under `build/cuts/`, named after the recording and the window, so the same
// moment added twice is the same file and the second press costs a probe. They
// are `ui/localcopy.js`'s rule one step on: a copy is a fact about this machine.
// What *is* in the document is the clip pointing at one — which is the one place
// this differs from that rule, and it is deliberate: a supercut **is** its cuts,
// and a document naming twelve twenty-megabyte files is a document you can move.
// Delete `build/cuts/` and the documents that name it stop opening; that is the
// trade, and it is why they are named deterministically rather than by a counter.
//
// The proxies live there too and are the opposite case: **deleting one costs
// nothing**, because the next session makes it again and everything works
// meanwhile at the speed it worked at before there were any. That is what lets
// them be adopted from disk on sight — and why both kinds are written to
// `<name>.part` and renamed when the writer says Done, so a name that exists is
// a file that finished. A session killed mid-copy used to leave a truncated file
// under the name the next press looked for.

import { project, applyInput, clipsOf, changed } from '../ui/project.js';
import * as inputsModel from '../ui/inputs.js';
import { copyRowsOf } from '../ui/export/copy.js';
import { analyzeClip } from '../ui/analysis.js';

/// How much of the recording either side of the moment goes into the cut.
export const PAD = 10;

/// How long the keyframe scan may take before it answers with what it has.
///
/// A window rather than a file: only the keyframes around the in-point matter,
/// and 60 ms is what twenty seconds of these recordings measured. Not `0` — this
/// runs on the press, and a recording whose index is missing and whose bitrate
/// is high would otherwise stop the window for as long as it liked.
const SCAN_MS = 400;

/// How far back to look for the keyframe the copy will land on.
///
/// Wider than any sane GOP and narrow enough to scan: at the two-second spacing
/// these recordings use it holds ten of them, and a file with a twenty-second
/// GOP is one this will decline to cut rather than one it will cut wrongly.
const SCAN_BACK = 20;

/// How tall a proxy is. The width follows the source's aspect.
///
/// 720 puts a seek at 11 ms — inside a 60 Hz frame, which is the whole
/// requirement — against 24 ms at 1080 and 6 ms at 540. The picture is what you
/// judge an edit by, so this is the largest of the three that still fits in a
/// frame rather than the smallest that is fastest.
export const PROXY_HEIGHT = 720;

/// The longest input worth making a proxy of, in seconds.
///
/// A proxy runs at about thirteen times realtime here, so five minutes is under
/// half a minute of background encoding and a six-hour recording would be
/// twenty-eight. A clip of something that long stays on the file it is on and
/// scrubs at that file's speed; nothing is refused and nothing is said, because
/// what it costs is a slower drag rather than an answer somebody is missing.
const PROXY_LONGEST = 300;

const fs = require('fs');

/// Every cut asked for, by clip id. Not on the clip: a cut is a fact about this
/// machine and the clip is what gets written to the document — `peaks`'s rule
/// and `ui/localcopy.js`'s, and the reason neither of those is a clip field.
const jobs = new Map();

/// Every proxy asked for, **by input path** and not by clip.
///
/// A proxy is a fact about a file, so two clips of one recording share one and a
/// clip that moves from the recording to its cut asks for a different one. Same
/// reason `supercut/screen.js` keys its decoder pool by path; the entry is
/// `{ path, id, state, progress }` and `state` is
/// `making` | `ready` | `failed` | `long`.
const proxies = new Map();

/// Where cuts are written. Under the repository root rather than beside the
/// document, because `require('fs')` resolves a relative path against the *app*
/// directory (`supercut/`) and a cut written to `supercut/build/` is a cut
/// nobody can find. Same root `build/corpus/` is read from.
let root = '';
function dir() {
    if (!root) {
        try { root = fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/'); }
        catch (e) { root = '.'; }
        try { fs.mkdirSync(`${root}/build`); } catch (e) { /* there already */ }
        try { fs.mkdirSync(`${root}/build/cuts`); } catch (e) { /* there already */ }
    }
    return `${root}/build/cuts`;
}

/// What a card asks to know: is this clip a cut, is one being made, did one fail.
///
/// `null` for a clip nothing was ever asked about, which is every clip of a
/// document opened from disk — those are already cuts, or are clips of whatever
/// they are clips of, and neither is this file's business.
export function stateOf(clipId) {
    const job = jobs.get(clipId);
    if (job && job.state !== 'done') return job.state;
    // The cut has landed and the proxy has not: the same wait as far as a card
    // is concerned — something about this clip is still being made and the bar
    // says how far. A *failed* proxy is deliberately not reported here: the clip
    // is correct and playable and only scrubs at the speed it always did, which
    // is not a thing to put an amber border round.
    const clip = project.clips.find((c) => c.id === clipId);
    const rec = clip && proxies.get(clip.path);
    if (rec && rec.state === 'making') return 'proxying';
    return job ? job.state : null;
}

/// How many clips have something still being made for them, for the mix head.
export function pending() {
    let n = 0;
    for (const clip of project.clips) {
        const s = stateOf(clip.id);
        if (s === 'cutting' || s === 'copied' || s === 'opening' || s === 'proxying') n++;
    }
    return n;
}

/// The proxy to scrub `path` with, or `''` for "use the file itself".
///
/// `supercut/screen.js` is the one caller: the picture it parks is the only
/// thing a proxy is for, and everything else in this application — the render,
/// the export, the analysis, the document — reads the real file.
export function proxyFor(path) {
    const rec = proxies.get(path);
    return rec && rec.state === 'ready' ? rec.path : '';
}

/// Forget what is known about a clip that has gone.
export function forget(clipId) {
    const job = jobs.get(clipId);
    if (job && job.fetch && job.state === 'cutting') {
        try { bro.ffmpeg.fetch.stop(job.fetch); } catch (e) { /* already done */ }
    }
    jobs.delete(clipId);
}

// ── asking for one ─────────────────────────────────────────────────────────

/// At most this much of a recording is worth taking out of it.
///
/// **A cut exists to make a moment its own file, and past a point there is no
/// moment left to take.** Two presses reach this: `+` on a *Recordings* row,
/// which adds the whole six-hour broadcast, and a document opened as a media
/// file, which names no span at all — copying fifteen gigabytes to save nothing
/// is the one thing this must never do on a keypress. Half, because that is
/// where the copy stops paying for itself in bytes and the answer stops being
/// "a piece of a recording".
const MOST = 0.5;

/// The window to copy: the moment with `PAD` either side, inside the recording.
///
/// Null for anything that is not a moment — no span named, or a span that is
/// most of the recording — and a null here is a clip that stays a clip of the
/// file, which is exactly right for somebody who asked for the whole of it.
function windowFor(clip, spec) {
    const media = clip.media || 0;
    if (!(spec.to > spec.from)) return null;
    const from = Math.max(0, spec.from - PAD);
    const to = Math.min(media, spec.to + PAD);
    if (!(to > from)) return null;
    return media > 0 && to - from > media * MOST ? null : { from, to };
}

/// The keyframe the copy will actually begin at, or -1 when none can be found.
///
/// **Asked of the video stream**, because that is the only one with sparse
/// keyframes — a soundtrack is keyframes all the way down and a number snapped
/// against one would say nothing about where the picture can start.
function keyframeFor(clip, at) {
    const v = clip.probe && clip.probe.video;
    if (!v) return at;      // no picture: any packet will do, so the ask stands
    let answer;
    try {
        answer = bro.ffmpeg.keyframes(clip.path, {
            stream: v.index,
            from: Math.max(0, at - SCAN_BACK),
            to: at + 1,
            ms: SCAN_MS,
        });
    } catch (e) {
        return -1;
    }
    let best = -1;
    for (const k of (answer && answer.times) || []) if (k <= at + 1e-6) best = k;
    return best;
}

/// A name that is the same every time the same window of the same recording is
/// asked for, so adding a moment twice writes one file and the second press
/// finds it already there.
function nameFor(clip, from, to) {
    const stem = String(clip.path).replace(/\\/g, '/').split('/')
                                  .filter((p) => p && p !== '.').slice(-2)
                                  .join('-').replace(/\.[^.]*$/, '')
                                  .replace(/[^A-Za-z0-9_-]+/g, '_');
    return `${stem}-${from.toFixed(3)}-${to.toFixed(3)}.mkv`;
}

/// The stream rows a copy of this recording is made of.
///
/// `copyRowsOf` is the one home for which streams can be copied at all — the
/// Write stage's Rewrap asks the same question — and what is decided here is
/// only what a copy *into Matroska* then drops, which is `ui/localcopy.js`'s
/// finding: Matroska will not hold a data stream and says so at the muxer.
function rowsFor(clip, from, to) {
    let n = 0;
    return copyRowsOf(clip.probe, 0, () => ++n, null)
        .filter((r) => r.kind !== 'data')
        .map((r) => Object.assign(r, { copyFrom: from, copyTo: to }));
}

/// Cut `clip`'s moment out of the recording it is a clip of.
///
/// Called once, when the clip lands. Answers nothing: what happens next is
/// `tick()`'s, and everything that can go wrong leaves the clip alone.
export function begin(clip, spec) {
    if (!clip || jobs.has(clip.id)) return;
    const want = windowFor(clip, spec);
    if (!want) return;

    const cut = keyframeFor(clip, want.from);
    if (cut < 0) return;    // no keyframe to start at: this stays a clip of the file

    const path = `${dir()}/${nameFor(clip, cut, want.to)}`;
    const job = { clip: clip.id, path, cut, to: want.to, state: 'cutting',
                  fetch: 0, input: null, progress: 0, error: '' };
    jobs.set(clip.id, job);

    // Already on disk from an earlier session or an earlier press of the same
    // row: there is nothing to copy and the only thing left is to open it. Left
    // to `tick()` rather than done here, because opening it probes it and the
    // press is not the place for that — the whole point of this file is that a
    // press adds a piece and everything else catches up.
    if (size(path) > 0) { job.state = 'copied'; return; }

    const rows = rowsFor(clip, cut, want.to);
    if (!rows.length) { jobs.delete(clip.id); return; }
    try {
        job.fetch = bro.ffmpeg.fetch.start({
            path: `${path}.part`,
            format: 'matroska',
            inputs: [{ path: clip.path }],
            streams: rows,
        }, { label: `cut ${clip.name}`, soon: true });
    } catch (e) {
        job.state = 'failed';
        job.error = String((e && e.message) || e);
    }
}

function size(path) {
    try { return fs.statSync(path).size; } catch (e) { return 0; }
}

/// Put a finished file under the name everything looks for.
///
/// **A name that exists is a file that finished**, which is what makes both
/// kinds adoptable on sight. Everything here writes `<name>.part` and this is
/// the only place either name is joined up; a session killed mid-write leaves a
/// `.part` that the next press simply writes over.
function finish(path) {
    try { fs.renameSync(`${path}.part`, path); return true; }
    catch (e) { return false; }
}

// ── taking the answer ──────────────────────────────────────────────────────

/// The copy landed: open the file it wrote. The probe is a thread like every
/// other one here, so this only starts it.
function open(job) {
    if (job.state === 'cutting' && !finish(job.path)) {
        job.state = 'failed';
        job.error = 'the cut could not be put in place';
        return;
    }
    job.state = 'opening';
    job.input = inputsModel.addInput({ path: job.path });
}

/// The cut is open: the clip becomes a clip of it.
///
/// **The in-point moves and nothing else does.** The packets are the same
/// packets, so the picture, the size and the rate are what they were; what
/// changed is which file they are in and therefore where its zero is. A trim or
/// a slip made while the copy ran is carried through by the same subtraction,
/// which is the reason this reads `clip.inPoint` now rather than remembering it
/// at the press.
function adopt(job) {
    const clip = project.clips.find((c) => c.id === job.clip);
    const input = job.input;
    if (!clip || !input || !input.probe) { job.state = 'failed'; return; }
    const was = clip.input;

    clip.input = input;
    clip.inPoint = Math.max(0, clip.inPoint - job.cut);
    // Everything else a clip takes from its input — path, src, probe, media,
    // size, rate — plus the clamp of the in-point and the length against what
    // the new file actually holds. One home, and it is the model's.
    applyInput(input);

    // A reading is of a *file*, and this is a different file: the envelope and
    // the strip are re-read against the cut, which is a window of it rather than
    // a seek into six hours.
    clip.peaks = null;
    clip.film = null;
    analyzeClip(clip);

    // **The recording goes when the last clip of it has.** Left on the list it
    // would be an `-i` in every spec built from the document, and a document
    // naming a fifteen-gigabyte file no clip is cut from is a document that
    // cannot be opened anywhere the recording is not.
    if (was && was !== input && !clipsOf(was).length) inputsModel.removeInput(was);

    job.state = 'done';
    changed('edit');
}

/// How far the copy has got, 0 to 1, for the bar on the card.
export function progressOf(clipId) {
    const job = jobs.get(clipId);
    if (job && job.state !== 'done') return job.progress || 0;
    const clip = project.clips.find((c) => c.id === clipId);
    const rec = clip && proxies.get(clip.path);
    return rec && rec.state === 'making' ? rec.progress || 0 : (job ? job.progress || 0 : 0);
}

// ── the proxy ──────────────────────────────────────────────────────────────

/// The proxy's name for a file: the file's own, plus the height.
///
/// Deterministic for `nameFor`'s reason and one more: a proxy adopted from disk
/// costs nothing, so the second time a document is opened there is no wait at
/// all. The height is in the name because changing `PROXY_HEIGHT` has to make
/// the old ones stop being the answer rather than quietly leave a smaller
/// picture on the screen.
function proxyNameFor(path) {
    const stem = String(path).replace(/\\/g, '/').split('/').pop()
                             .replace(/\.[^.]*$/, '')
                             .replace(/[^A-Za-z0-9_-]+/g, '_');
    return `${stem}-p${PROXY_HEIGHT}.mkv`;
}

/// Ask for the proxies the mix is missing, and take in the ones that landed.
///
/// Walked over the clips every frame rather than driven by an event, for the
/// reason `settleProxies()` in `ui/app.js` is: what a clip is a clip *of*
/// changes without anything announcing it — a cut lands, a document opens, a
/// file is dropped — and one pass over thirteen clips is nothing beside being
/// wrong about which file is on the screen.
function settleProxies() {
    let touched = false;

    const wanted = new Set();
    for (const c of project.clips) {
        const path = c.path;
        if (!path) continue;
        wanted.add(path);
        if (proxies.has(path)) continue;
        // Not probed yet: ask again next frame rather than deciding "too long"
        // about a file nobody has measured.
        const media = c.media || 0;
        if (!(media > 0)) continue;
        if (media > PROXY_LONGEST) { proxies.set(path, { state: 'long' }); continue; }

        const out = `${dir()}/${proxyNameFor(path)}`;
        if (size(out) > 0) {
            proxies.set(path, { path: out, state: 'ready', progress: 1 });
            touched = true;
            continue;
        }
        const rec = { path: out, id: 0, state: 'making', progress: 0, error: '' };
        proxies.set(path, rec);
        try {
            rec.id = bro.ffmpeg.proxy.start({
                path: `${out}.part`,
                input: path,
                height: PROXY_HEIGHT,
                label: `proxy ${c.name || ''}`,
            });
        } catch (e) {
            rec.state = 'failed';
            rec.error = String((e && e.message) || e);
        }
    }

    let running = null;
    for (const [path, rec] of proxies) {
        if (rec.state !== 'making') continue;
        // Nothing in the mix is of this file any more — a Clear, or a clip
        // dropped while its proxy was being made. Stopping it is the point of
        // this branch: thirteen encodes for an empty row is the one way this
        // could be felt.
        if (!wanted.has(path)) {
            try { bro.ffmpeg.proxy.stop(rec.id); } catch (e) { /* already gone */ }
            proxies.delete(path);
            continue;
        }
        if (!running) {
            running = new Map();
            for (const p of bro.ffmpeg.proxy.list()) running.set(p.id, p);
        }
        const p = running.get(rec.id);
        if (!p) continue;
        rec.progress = p.progress || 0;
        if (p.state === 'done') {
            if (finish(rec.path)) { rec.state = 'ready'; touched = true; }
            else { rec.state = 'failed'; rec.error = 'the proxy could not be put in place'; }
        } else if (p.state === 'failed' || p.state === 'cancelled') {
            rec.state = 'failed';
            rec.error = p.error || p.state;
        }
    }
    return touched;
}

/// Why a cut failed, for the card that is still a clip of the recording.
export function errorOf(clipId) {
    const job = jobs.get(clipId);
    return job && job.state === 'failed' ? job.error : '';
}

/// Take in whatever the threads have said. From the frame loop, for the reason
/// every other poll in this application is: nothing calls back into JS.
///
/// **Answers what settled, and the two are not the same event.** `'edit'` is a
/// cut landing: the clip is now a clip of another file, with a new in-point and
/// a new length, so the row is rebuilt and the document is dirty. `'screen'` is
/// a proxy landing: nothing about the edit changed at all — only which file the
/// picture should be read from — so the row is left exactly as it is and the
/// document is not touched. `''` is neither.
///
/// Progress moving is neither of them: the bar on the card is written in place
/// by `mix.markCuts()`, because rebuilding the row on every frame a copy
/// advances would destroy the card a hand is dragging.
export function tick() {
    const screen = settleProxies();
    let settled = false;
    if (!jobs.size) return screen ? 'screen' : '';

    let running = null;
    for (const job of jobs.values()) {
        if (job.state === 'copied') {
            open(job);
        } else if (job.state === 'cutting') {
            // One list read for every cut there is, rather than a `status(id)`
            // each — the same choice `ui/localcopy.js` makes and for the same
            // reason: the answer is a lock and a copy either way.
            if (!running) {
                running = new Map();
                for (const f of bro.ffmpeg.fetch.list()) running.set(f.id, f);
            }
            const f = running.get(job.fetch);
            if (!f) continue;
            job.progress = f.progress || 0;
            if (f.state === 'done') open(job);
            else if (f.state === 'failed' || f.state === 'cancelled') {
                job.state = 'failed';
                job.error = f.error || f.state;
                settled = true;
            }
        } else if (job.state === 'opening') {
            const input = job.input;
            if (!input) { job.state = 'failed'; settled = true; }
            else if (input.error) {
                job.state = 'failed';
                job.error = input.error;
                inputsModel.removeInput(input);
                settled = true;
            } else if (input.probe) {
                adopt(job);
                settled = true;
            }
        }
    }
    return settled ? 'edit' : (screen ? 'screen' : '');
}
