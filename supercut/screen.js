// What is on the screen, which in this application is one of three things and
// never two.
//
// ── Residency here is per *file*, not per clip ────────────────────────────
//
// `ui/residency.js` holds a decoder for a clip near the playhead, because the
// workbench's hard case is a montage — seventy-five clips of seventy-five
// different files, where one element per clip cost 26 s of frozen window and
// 9.1 GB. This application's hard case is the exact inverse: **forty clips of
// four recordings**, because a supercut is many small pieces of a few long
// files. One element per clip would open the same six-hour file forty times;
// one element per *file* opens it once and every clip of it is a seek.
//
// So the pool is keyed by path and is small (`MAX_OPEN`), and crossing from one
// clip to the next inside a recording costs nothing at all. That is a different
// rule from the workbench's and it is not a contradiction of it — both say a
// decoder is a property of what is being *watched*; they differ on what "the
// same thing" is, and here it is the file.
//
// ── The three things ──────────────────────────────────────────────────────
//
// **A recording being auditioned.** A row in the finder, played with its own
// sound, from the pool.
//
// **The clip under the playhead, muted.** Parked, scrubbed, trimmed, slipped:
// what you are looking at while you edit is a frame of a file, and it is silent
// because there is nothing to hear in a still.
//
// **The render, while the mix plays.** `ui/output.js` — the render with the
// writer taken off the end, played through one element. This application plays
// *only* that, which is a decision worth stating because the workbench does not:
// there, the clips carry playback until the preview is ready, and crossing
// between them at a cut is what the preview exists to smooth over. Here a mix is
// nothing but cuts — fourteen fragments of a second each is the ordinary case —
// so playing the clips would be almost entirely the seams. The cost is that
// pressing play waits for the render to build (measured at 0.4 s on a fourteen
// clip mix of four inputs, 1.2 s on seventy-five); the bar says so while it
// does, which is a wait somebody can see rather than a stutter they cannot fix.

import { project, clipsAt, sourceTime, duration } from '../ui/project.js';
import { transport } from '../ui/transport.js';
import * as output from '../ui/output.js';

/// The most recordings that may be open at once, whatever the mix asks for.
///
/// At about 120 MB of demuxer and decoder per open six-hour recording, eight is
/// a gigabyte — the same ceiling `ui/output.js` accepts for a kept render, and
/// past the point where a supercut is drawing on that many sources at once.
const MAX_OPEN = 8;

/// How many to actually hold: what the mix is made of, plus one for an audition.
///
/// **A fixed three was a stutter and not a saving.** A thirteen-clip mix of four
/// recordings walked the playhead through four paths and a pool of three, so
/// every crossing evicted the file it was about to need again — closing and
/// reopening a fifteen-gigabyte demuxer per cut, which is exactly the cost
/// keying the pool by file was supposed to remove. The pool has to be able to
/// hold the whole mix or it holds none of it.
function room() {
    const paths = new Set();
    for (const c of project.clips) paths.add(c.path);
    return Math.min(MAX_OPEN, Math.max(2, paths.size + 1));
}

let stage = null;
let note = null;
let hooks = {};

const pool = new Map();     // path → { video, used }
let clock = 0;              // a counter, for least-recently-used
let auditioning = null;     // { path, until }
let shown = '';             // which pooled element is visible, by path
let building = false;       // play was pressed and the render is not up yet

export function initScreen(refs, h) {
    stage = refs.stage;
    note = refs.note;
    hooks = h || {};
    output.initOutput({ stage }, { changed: () => hooks.changed && hooks.changed() });
    window.addEventListener('resize', () => output.place());
}

// ── the pool ───────────────────────────────────────────────────────────────

function elementFor(path) {
    let held = pool.get(path);
    if (held) { held.used = ++clock; return held.video; }

    // Evict before opening rather than after, so the peak is `MAX_OPEN` files
    // and not one more. A file about to be opened is the least useful moment to
    // be holding the one nobody has looked at in longest.
    while (pool.size >= room()) {
        let oldest = null;
        for (const [p, h] of pool) if (!oldest || h.used < pool.get(oldest).used) oldest = p;
        if (oldest === null) break;
        const h = pool.get(oldest);
        try { h.video.pause(); h.video.src = ''; } catch (e) { /* already gone */ }
        if (h.video.parentNode) stage.removeChild(h.video);
        pool.delete(oldest);
    }

    const video = document.createElement('video');
    video.src = path;
    video.muted = true;
    video.style.display = 'none';
    stage.appendChild(video);
    pool.set(path, { video, used: ++clock });
    return video;
}

/// Open the recordings the mix is made of, before anybody clicks on one.
///
/// **The open is the click delay, and it does not have to be.** Pointing an
/// element at a fifteen-gigabyte recording costs about 300 ms the first time,
/// and doing it inside `park` means the first click on each card pays for it —
/// which reads as a window that hesitates every time you touch a different part
/// of the mix. Called instead when a clip lands, where somebody is already
/// waiting for a probe and one more open is invisible.
export function warm() {
    const paths = [];
    for (const c of project.clips) if (paths.indexOf(c.path) < 0) paths.push(c.path);
    // Never more than the pool will hold, or warming one would evict another and
    // the last few would be worse off than if nothing had been done at all.
    for (const p of paths.slice(0, Math.max(1, room() - 1))) elementFor(p);
}

/// Show exactly one pooled element, or none.
function reveal(path) {
    if (shown === path) return;
    shown = path;
    for (const [p, h] of pool) h.video.style.display = p === path ? 'block' : 'none';
}

/// Seek once the element can answer for the position.
///
/// Setting `currentTime` on a source that has not opened is a seek into nothing,
/// and a six-hour file opened cold does not answer on the frame it is asked.
function seek(video, t) {
    if (video.readyState >= 1) {
        try { video.currentTime = t; } catch (e) { /* between sources */ }
    } else {
        video.addEventListener('loadedmetadata', () => {
            try { video.currentTime = t; } catch (e) { /* gone already */ }
        }, { once: true });
    }
}

// ── auditioning ────────────────────────────────────────────────────────────

/// Play a span of a recording, with its own sound. Stops the mix first: two
/// things playing is two things to listen to.
export function audition(path, from, until) {
    if (!path) return false;
    stop();
    // **The one already running, first.** A second row pressed while the first
    // is playing takes a different element out of the pool, and the one it left
    // behind is unmuted and still going — two recordings at once, only one of
    // them on the screen.
    stopAudition();
    const video = elementFor(path);
    auditioning = { path, until };
    video.muted = false;
    reveal(path);
    seek(video, Math.max(0, from));
    const go = () => { try { video.play(); } catch (e) { /* not open yet */ } };
    if (video.readyState >= 1) go();
    else video.addEventListener('loadedmetadata', go, { once: true });
    return true;
}

export function isAuditioning() { return !!auditioning; }

export function stopAudition() {
    if (!auditioning) return;
    const held = pool.get(auditioning.path);
    if (held) {
        try { held.video.pause(); } catch (e) { /* fine */ }
        held.video.muted = true;
    }
    auditioning = null;
    shown = '';           // the mix decides again, on the next frame
    parked = { path: '', at: -1 };
}

// ── the mix ────────────────────────────────────────────────────────────────

/// Where the parked picture is, so the frame loop can tell "still there" from
/// "somewhere else". **Without this the idle path issues a seek per frame on a
/// six-hour file**, which is sixty demuxer seeks a second to show a still that
/// was already on the screen.
let parked = { path: '', at: -1 };

/// The shortest gap between two seeks of the parked picture, in milliseconds.
///
/// A hand dragging a card asks for a different frame *per pixel*, and a seek
/// into a long recording is a keyframe plus everything up to the target — up to
/// a couple of hundred frames of 1080p60. Answering every one of them puts the
/// decode thread permanently behind the hand, which is what a scrub that lags
/// and then catches up in jumps is. Dropping the ones in between costs nothing:
/// the frame loop calls `park` again every frame, so the position the hand
/// stopped at is picked up on the next tick either way.
const SEEK_MS = 120;
let lastSeek = 0;

/// Park the picture at `t` on the timeline: the topmost clip covering it, seeked.
///
/// Called every frame while nothing is playing, and per mouse-move under a drag,
/// so the guard above is what makes it cheap. The tolerance is half a frame at
/// 25 fps — finer than that is not a different picture.
function park(t) {
    const under = clipsAt(t);
    const clip = under.length ? under[under.length - 1] : null;
    if (!clip) {
        parked = { path: '', at: -1 };
        reveal('');
        return null;
    }
    const want = sourceTime(clip, t);
    if (parked.path === clip.path && Math.abs(parked.at - want) < 0.02) return clip;
    const now = Date.now();
    // Not this frame. The next one that is far enough from the last takes
    // whatever position the hand has reached by then — see `SEEK_MS`.
    if (parked.path === clip.path && now - lastSeek < SEEK_MS) return clip;
    lastSeek = now;
    parked = { path: clip.path, at: want };
    const video = elementFor(clip.path);
    video.muted = true;
    reveal(clip.path);
    seek(video, want);
    return clip;
}

/// Start or stop the mix.
///
/// The render is *asked for* here and arrives later — see the header. `building`
/// is what the bar reads to say so.
export function play(on) {
    if (on) {
        if (!project.clips.length) return false;
        stopAudition();
        if (transport.t >= duration() - 1e-3) transport.t = 0;
        transport.playing = true;
        building = true;
        // Everything the edit and the playhead did while this was stopped,
        // settled in one go — see `moveTo`. Before `setOn`, because that is
        // what decides whether there is anything to rebuild.
        if (stale) { output.invalidate(); stale = false; }
        output.setOn(true, transport.t, 'play');
        output.play(true);
        return true;
    }
    transport.playing = false;
    building = false;
    output.play(false);
    // **Kept for a while rather than dropped, and not for ever.** A paused
    // element resumes where it stopped and its range still covers that moment,
    // so stop-and-go is free — which is most of what anybody does here. It
    // costs about a gigabyte and holds every input it reads open, so `tick`
    // lets it go once nobody has come back to it. The same trade `KEEP_MS` in
    // `ui/transport.js` makes, and the same number.
    idleSince = Date.now();
    return true;
}

/// How long a stopped render is kept before it is let go, in milliseconds.
const KEEP_MS = 30000;
let idleSince = 0;

export function stop() { if (transport.playing) play(false); }
export function isPlaying() { return transport.playing; }

/// The kept render is of an edit, or a position, that is no longer the one on
/// screen. See `refresh` for why this is a flag and not a rebuild.
let stale = false;

/// The mix is not what it was: whatever the render is of, it is not this.
export function invalidate() {
    if (transport.playing) output.invalidate();
    else stale = true;
}

/// The playhead was moved by hand.
///
/// **The render is deliberately not told while playback is stopped.** Repointing
/// it hands the element a new src, and opening one is an open of every recording
/// in the mix — four fifteen-gigabyte files on an ordinary supercut. Doing that
/// on every click made clicking the strip take about a second, and the render
/// being *kept* for half a minute after playback stopped meant it went on
/// happening long after anything was playing. Nothing is looking at the render
/// while it is stopped: the parked picture is. So the move is remembered, and
/// `play()` is where it is paid for.
export function moveTo(t) {
    transport.t = Math.max(0, Math.min(t, duration()));
    if (transport.playing) output.moveTo(transport.t);
    else stale = true;
    park(transport.t);
}

export function muted() { return transport.muted; }
export function setMuted(on) {
    transport.muted = !!on;
    output.applyAudio();
}

/// What the screen is showing, for the bar to say and a suite to check.
export function state() {
    if (auditioning) return 'audition';
    if (output.isShowing()) return 'render';
    if (building) return 'building';
    return project.clips.length ? 'clip' : 'nothing';
}

// ── every frame ────────────────────────────────────────────────────────────

/// Keep the clock, the render and the audition honest. Called once a frame.
export function tick() {
    if (auditioning) {
        const held = pool.get(auditioning.path);
        if (held && held.video.currentTime >= auditioning.until) {
            stopAudition();
            if (hooks.changed) hooks.changed();
        }
        // An audition owns the screen while it runs, and the render is not
        // being watched — but it is also not thrown away, because coming back
        // from a row to the mix is the commonest thing anybody does here.
        output.chase();
        return;
    }

    output.chase();

    if (transport.playing) {
        // **The render is the clock while it is up.** Its element carries the
        // mix's own soundtrack and the sound is the authoritative half, so
        // reading the position off it rather than counting frames is what keeps
        // the playhead on the thing being heard.
        const at = output.at();
        if (at !== null) {
            building = false;
            transport.t = Math.min(at, duration());
            if (transport.t >= duration() - 1e-3 || output.ended()) {
                play(false);
                transport.t = duration();
            }
        }
        // While `at()` is null the render is still opening its inputs. Nothing
        // moves and nothing plays; the bar says `building`.
        //
        // Unless it is never going to build. `ui/output.js` puts a sentence in
        // `why()` when the spec would not settle — an input that will not open,
        // a range with nothing in it — and playback that sat on ❚❚ for ever
        // waiting for a render that had already failed would be the one state
        // with nothing to do about it. Stop, and let the note say why.
        else if (building && output.why()) play(false);
    } else {
        park(transport.t);
        // Let a stopped render go once nobody has come back to it — see
        // `KEEP_MS`. `setOn(false, …, 'play')` releases only this holder, which
        // is the only one this application ever takes.
        if (idleSince && Date.now() - idleSince > KEEP_MS) {
            idleSince = 0;
            output.setOn(false, 0, 'play');
        }
    }

    if (note) {
        const why = state() === 'nothing' ? 'nothing in the mix yet'
                  : state() === 'building' ? 'building the render…'
                  : output.why() || '';
        note.textContent = why;
        note.hidden = !why;
    }
}

/// Put the picture back where the playhead is, whatever happened.
///
/// The one call an edit makes: a trim, a slip or a reorder changes what is under
/// the playhead without the playhead moving, and the frame on screen is then of
/// a moment that is no longer there.
export function refresh() {
    invalidate();
    // **`park`'s own comparison decides**, and clearing it here was the second
    // half of the drag stutter: this is called per mouse-move, and a cleared
    // comparison is a demuxer seek into a fifteen-gigabyte file per mouse-move
    // — which is what made fine-tuning an edge impossible. `park` already reads
    // the edit (`clipsAt`, `sourceTime`), so an edit that moved the picture
    // under the playhead moves the answer and an edit that did not, does not.
    if (!auditioning && !transport.playing) park(transport.t);
}
