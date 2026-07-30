// The playhead, and what has to be true of every decoder while it moves.
//
// This is the one part of the application that is *not* an edit. Nothing here
// changes what would be rendered — play, pause, step, shuttle and loop are how
// you look at the timeline, not what it says — which is why a render exports a
// clip at its own rate whatever the viewer was last playing at, and why none of
// this belongs to the model.
//
// Three invariants earn their comments, because each was arrived at from a
// failure that looked like something else:
//
//   - **Whatever is on screen is the master clock**, which is normally the
//     topmost clip under the playhead *with a picture in it*. It is the picture
//     in front, so it is the thing that knows what moment is on screen — and
//     when the output preview is on, the picture in front is the render, so it
//     is the master instead (`output.js`). One rule, stated the way it was
//     always meant, rather than a mode: everything below is written against
//     *the* clock and does not care which of the two it is.
//     The qualification arrived with audio-only
//     clips and is a decision rather than a detail: bro will now drive
//     `currentTime` from the media clock for a source with no picture, so a
//     music bed dropped on a lane above the footage *could* be the master —
//     and taking the clock away from the thing being watched would take frame
//     stepping with it, `stepFrame()` moving by decoded pictures that a
//     soundtrack does not have. With nothing but sound under the playhead the
//     topmost clip is the master, which is what makes an audio-only timeline
//     play at all. `viewer.activeClip()` is where the rule lives.
//   - **Everything else is chased, not driven.** Several decoders each
//     free-running on their own audio clock come apart within a minute, and
//     correcting every frame would mean a seek per clip per frame. A seek only
//     when a clip drifts past a couple of frames holds a grid of a dozen videos
//     together for the cost of the occasional correction.
//   - **Writing `currentTime` while the decoder drives the clock fights it.**
//     Hence `setPlayhead(t, seek)`, and hence `adoptDecoderTime()` when paused:
//     a seek asks for a time and gets back the frame whose interval contains
//     it, so the readout has to say where the picture actually is rather than
//     what was asked for.

import { project, duration, clipsAt, nextClipAfter, sourceTime,
         selectFollow, isGenerator } from './project.js';
import * as viewer from './viewer.js';
import * as output from './output.js';

/// Where the playhead is and how it is being watched. One object, exported by
/// reference: the frame loop, the readouts and the tests all read it, and a
/// copy would be a second answer to "what time is it".
export const transport = {
    t: 0,
    playing: false,
    rate: 1,
    volume: 1,
    muted: false,
    loop: false,
};

let hooks = {};

/// `changed()` — the readouts are out of date. `reveal(t)` — the timeline may
/// need to scroll to keep the playhead in view; return true if it moved.
export function initTransport(h) { hooks = h || {}; }

const tell = () => { if (hooks.changed) hooks.changed(); };

// ── moving ─────────────────────────────────────────────────────────────────

/// Move the playhead. `seek` is false while playback is driving it — the
/// active clip's own clock is the master then, and writing currentTime back
/// would fight it.
export function setPlayhead(t, seek = true) {
    const d = duration();
    transport.t = Math.max(0, Math.min(d, t));
    const here = clipsAt(transport.t);
    const changedSet = viewer.setActiveSet(here);
    // A clip that has just come into view has its decoder parked wherever it
    // was left, so it always needs the seek even when the caller said not to.
    // The clips are kept parked where the playhead is even while the output
    // preview is what is being watched, so that turning it off is instant
    // rather than a seek per decoder. What they are not is *played*: the preview
    // carries the render's own soundtrack now, so a clip playing underneath it
    // would be that clip heard twice — once as itself and once through the mix,
    // a third of a second apart.
    const shown = !output.isOn();
    for (const clip of here) {
        applyAudio(clip);
        // **A generator is not sent anywhere.** libavfilter's sources produce
        // forward and the `lavfi` demuxer has no `read_seek`, so a `currentTime`
        // written here is a seek libav refuses with a line in the log — and the
        // frames it is already making are the frames the generator makes. It is
        // played and left alone, which is also why `viewer.activeClip()` will not
        // take one as the master clock.
        if (!isGenerator(clip)) {
            const want = sourceTime(clip, transport.t);
            if ((seek || changedSet) && Math.abs(clip.video.currentTime - want) > 0.0005)
                clip.video.currentTime = want;
        }
        if (transport.playing && shown && clip.video.paused) clip.video.play();
    }
    if (seek) output.moveTo(transport.t);
    if (here.length) selectFollow(here[here.length - 1]);
    tell();
}

export function play() {
    if (!project.clips.length) return;
    if (transport.t >= duration() - 1e-4) setPlayhead(0);
    transport.playing = true;
    if (output.isOn()) output.play(true);
    else for (const c of viewer.activeClips()) { applyAudio(c); c.video.play(); }
    tell();
}

export function pause() {
    transport.playing = false;
    output.play(false);
    for (const c of viewer.activeClips()) c.video.pause();
    tell();
}

export function togglePlay() { transport.playing ? pause() : play(); }

// Frame stepping pauses first: nudging while running would race the clock and
// land somewhere nobody asked for.
//
// video.stepFrame() moves by decoded pictures. Doing it the usual way —
// currentTime += 1/fps — does not work: the frame rate is an average, and the
// seconds round trip misses the frame boundary, so a back step lands on the
// frame it started from and nothing happens.
export function step(frames) {
    if (transport.playing) pause();
    // The render's own frames, when the render is what is on screen. One
    // decoded picture is exactly one canvas here, so unlike a file there is no
    // averaged frame rate for the seconds round trip to miss a boundary by —
    // and a step backwards is a preview of the moment before this one, which is
    // a new range rather than a step. `output.js` says so.
    if (output.isOn()) {
        if (output.step(frames)) {
            const t = output.at();
            if (t !== null) { transport.t = t; tell(); }
            if (hooks.reveal) hooks.reveal(transport.t);
        }
        return;
    }
    let clip = viewer.activeClip();
    if (!clip) {
        // In a gap: step into the neighbouring clip rather than doing nothing.
        clip = frames > 0 ? nextClipAfter(transport.t) : lastClipBefore(transport.t);
        if (!clip) return;
        setPlayhead(frames > 0 ? clip.start : clip.start + clip.length - 1e-4);
        return;
    }
    // A clip with no picture has no frames to step, and `stepFrame` says so by
    // returning 0 — so a timeline of nothing but sound steps clip to clip
    // rather than by some invented fraction of a second. There is no frame
    // boundary to land on and pretending otherwise is what the whole of this
    // function exists not to do.
    if (clip.video.stepFrame(frames)) {
        transport.t = clip.start + clip.video.currentTime - clip.inPoint;
        tell();
        if (hooks.reveal) hooks.reveal(transport.t);
        return;
    }
    // Off the end of this clip — carry on into the next one, so stepping walks
    // the whole timeline and not just one file.
    const next = frames > 0 ? nextClipAfter(transport.t) : lastClipBefore(clip.start);
    if (next) setPlayhead(frames > 0 ? next.start : next.start + next.length - 1e-4);
}

function lastClipBefore(t) {
    let best = null;
    for (const c of project.clips) if (c.start + c.length <= t + 1e-6) best = c;
    return best;
}

// ── sound ──────────────────────────────────────────────────────────────────

export function applyAudio(clip) {
    if (!clip || !clip.video) return;
    // Two volumes multiply: the clip's own level, which is part of the edit,
    // and the transport's, which is just how loud you are listening.
    clip.video.muted = transport.muted || clip.muted;
    clip.video.volume = transport.volume * clip.volume;
    clip.video.playbackRate = transport.rate;
    // Looping is a property of the timeline, not of any one clip: a clip that
    // looped itself would never hand over to the next one.
    clip.video.loop = false;
}

export function applyAudioAll() { for (const c of viewer.activeClips()) applyAudio(c); }

// ── the clock ──────────────────────────────────────────────────────────────

/// About two frames. See the note at the top on why this is a tolerance and
/// not a correction.
const DRIFT_LIMIT = 0.12;

/// Called once a frame with the wall-clock delta. The only thing the frame
/// loop has to know about the transport.
export function tick(dt) {
    if (transport.playing) advance(dt);
    else adoptDecoderTime();
}

/// A seek asks for a time; what comes back is the frame whose interval
/// contains it, which is generally a little earlier. The readout has to say
/// where the picture actually is — otherwise the timecode is a request rather
/// than a fact, and a frame step from a scrubbed position appears to move by
/// some odd fraction of a frame because the step really started somewhere else.
function adoptDecoderTime() {
    if (output.isOn()) {
        const t = output.at();
        if (t === null || Math.abs(t - transport.t) < 1e-6) return;
        transport.t = t;
        tell();
        return;
    }
    const clip = viewer.activeClip();
    if (!clip || !clip.video || !(clip.video.duration > 0)) return;
    const t = clip.start + clip.video.currentTime - clip.inPoint;
    if (Math.abs(t - transport.t) < 1e-6) return;
    transport.t = t;
    tell();
}

/// Where the playhead goes next. The topmost clip's own clock is the master
/// while it is playing. A gap between clips has no clock of its own, so it
/// runs on the wall.
function advance(dt) {
    const d = duration();

    // The render is the picture, so the render is the clock. It runs at
    // whatever rate the frames can be made at rather than on the wall, which is
    // the honest reading: a preview that ran the playhead at real time past a
    // picture arriving at half of it would be a timecode describing something
    // nobody is looking at.
    if (output.isOn()) {
        // **It stops where its own range stops**, which is not always the end
        // of the timeline: a render of seconds 10 to 20 runs out at 20 with
        // half the edit still to come. `handOver` is the wrong end of that —
        // it would step into the clip after the range, which is not on the
        // screen and is not being previewed. Looping is still the timeline's
        // own answer, because the loop is a property of the transport.
        if (output.ended()) {
            if (transport.loop) setPlayhead(0);
            else pause();
            return;
        }
        const t = output.at();
        if (t === null) return;             // not open yet; nothing has moved
        transport.t = Math.max(0, Math.min(d, t));
        if (transport.t >= d - 1e-6) { handOver(d); return; }
        if (hooks.reveal) hooks.reveal(transport.t);
        return;
    }

    const clip = viewer.activeClip();

    if (clip) {
        const local = clip.video.currentTime - clip.inPoint;
        if (clip.video.ended || local >= clip.length - 1e-4) {
            handOver(clip.start + clip.length);
            return;
        }
        transport.t = clip.start + local;
        resync(clip);
    } else {
        transport.t += dt * transport.rate;
        if (clipsAt(transport.t).length) { setPlayhead(transport.t); return; }
    }

    if (transport.t >= d - 1e-6) { handOver(d); return; }
    if (hooks.reveal) hooks.reveal(transport.t);
}

function resync(master) {
    const all = viewer.activeClips();
    if (all.length < 2) return;
    for (const c of all) {
        if (c === master || !c.video) continue;
        // A generator has nowhere to be chased to — see `setPlayhead`. It is
        // still kept running, because it is on the screen.
        if (!isGenerator(c)) {
            const want = sourceTime(c, transport.t);
            if (Math.abs(c.video.currentTime - want) > DRIFT_LIMIT) c.video.currentTime = want;
        }
        if (c.video.paused && !c.video.ended) c.video.play();
    }
}

function handOver(t) {
    const d = duration();
    if (t >= d - 1e-6) {
        if (transport.loop) { setPlayhead(0); return; }
        pause();
        setPlayhead(Math.max(0, d - 1e-4));
        return;
    }
    setPlayhead(t);
}
