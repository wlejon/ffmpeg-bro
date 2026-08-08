// The playhead, and what has to be true of every decoder while it moves.
//
// This is the one part of the application that is *not* an edit. Nothing here
// changes what would be rendered — play, pause, step, shuttle and loop are how
// you look at the timeline, not what it says — and none of it belongs to the
// model.
//
// **`transport.rate` and a clip's `speed` are two different things and stay
// two.** A clip now has a speed of its own, which is part of the edit and is
// rendered; `J`/`K`/`L` and the rate selector are still how fast you are
// *watching*, and they reach no render. The two meet in exactly one place —
// `applyAudio`, where they multiply into the element's `playbackRate`, exactly as
// the transport's volume and the clip's do — because what is on screen is the
// edit seen at whatever rate you are looking at it. Merging them would make
// shuttling an edit, which is the whole reason they are separate.
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

import { project, duration, clipsAt, nextClipAfter, sourceTime, timelineTime,
         speedOf, selectFollow, isGenerator } from './project.js';
import * as viewer from './viewer.js';
import * as output from './output.js';
import * as residency from './residency.js';

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
    t = Number(t);
    if (Number.isNaN(t)) return;
    const d = duration();
    transport.t = Math.max(0, Math.min(d, t));
    const here = clipsAt(transport.t);
    // Before the active set, and before the loop below reads `clip.video`: a
    // clip only holds a decoder while the playhead is near it (ui/residency.js),
    // and the ones it has just landed on may not have had one a moment ago.
    residency.retain(transport.t);
    const changedSet = viewer.setActiveSet(here);
    // A clip that has just come into view has its decoder parked wherever it
    // was left, so it always needs the seek even when the caller said not to.
    // The clips are kept parked where the playhead is even while the output
    // preview is what is being watched, so that turning it off is instant
    // rather than a seek per decoder. What they are not is *played*: the preview
    // carries the render's own soundtrack now, so a clip playing underneath it
    // would be that clip heard twice — once as itself and once through the mix,
    // a third of a second apart.
    // `isShowing`, not `isOn`: a render kept warm but not watched leaves the
    // clips as the picture, and a clip that is the picture while playing is a
    // clip that has to be playing.
    const shown = !output.isShowing();
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
    // **Only when somebody is actually watching the render.** A graph cannot
    // seek — moving the playhead means building a source that begins there — so
    // telling a preview about a scrub costs a rebuild, and a rebuild is over a
    // second on a large edit. While playback merely has one cached and is not
    // running, the scrub is answered by the clips and the render is left alone
    // to go stale; the next `play()` is what moves it, at the moment it is worth
    // paying for.
    if (seek && (output.isWanted() || transport.playing)) output.moveTo(transport.t);
    if (here.length) selectFollow(here[here.length - 1]);
    tell();
}

/// **Playback runs on the render, not on the clips.**
///
/// The viewer composites by placing an element per clip, so playing an edit
/// means crossing from one decoder to the next at every cut — and each crossing
/// is an element being opened and seeked, which is ~65 ms of the thread that
/// draws. Measured on a 75-clip montage of 1.6 s clips: 23 frames over 40 ms in
/// fifteen seconds, about one visible hitch a second, and half of them were the
/// crossings themselves. The render has no crossings in it. It is one source for
/// the whole edit, cuts are the compositor's business, and the same fifteen
/// seconds cost 10 slow frames in a thousand.
///
/// So this asks for one and starts it. Three things follow and each is here
/// rather than in `ui/output.js` because each is the transport's business.
///
/// **The clips carry it until the render exists.** Building one opens every
/// input it reads, which is over a second on an edit that size, so playback
/// starts the way it always did and `advance()` moves the clock across the frame
/// the picture arrives. Waiting instead would be a play button that did nothing
/// for a second and a half.
///
/// **It is asked for under playback's own name.** A preview somebody opened to
/// study is the same mechanism for a different reason, and `pause()` below must
/// not close it — see `holders` in ui/output.js.
///
/// **It is not dropped on pause.** A paused element resumes where it stopped and
/// its range still covers that moment, so keeping it is what makes stop-and-go
/// instant instead of a second and a half each way. It costs ~1 GB on that
/// montage, which is why `tick()` lets it go once nobody has played for a while.
export function play() {
    if (!project.clips.length) return;
    if (transport.t >= duration() - 1e-4) setPlayhead(0);
    transport.playing = true;
    idleSince = 0;
    // **Engaged at the playhead, and that is one call rather than two.**
    // `setOn` re-points a render that is already held — resuming a cached one
    // where it stopped, which is what makes stop-and-go free, and rebuilding it
    // wherever the playhead has been moved to since. It used to answer nothing
    // at all when the holder set was unchanged, so a click on the timeline
    // during playback (press → `pause()` → seek → release → here) resumed the
    // render of the moment playback had stopped at, over a playhead somebody had
    // just moved: the picture and the sound both snapped back.
    output.setOn(true, transport.t, 'play');
    // After it, never before: `output.play` starts nothing that is not the
    // render of where the playhead is now, so what this resumes is a render that
    // was already right — and what it does not resume is one waiting to be
    // rebuilt. The clips carry both halves until it lands.
    output.play(true);
    // Not `else`: while the render is still being built there is nothing else to
    // hear or see, and `advance()` parks these the moment it takes over.
    if (!output.isShowing())
        for (const c of viewer.activeClips()) {
            if (!c.video) continue;
            applyAudio(c);
            try { c.video.play(); } catch (e) { /* not open yet */ }
        }
    tell();
}

export function pause() {
    // **The render's clock is handed back to the clips, and this is the one
    // moment it can be.** While the render is the picture the playhead is the
    // render's own — `advance()` reads it off the element every frame — and the
    // clips are left parked wherever playback began, because parking twelve
    // decoders on every frame is a seek per clip per frame. Releasing playback's
    // claim makes the clips the picture again, so without this the picture *and*
    // `adoptDecoderTime`'s reading both fall back to that stale moment: measured,
    // a pause after a second and a half of playing dragged the playhead from
    // 1.64 s to 0.08.
    const wasShowing = output.isShowing();
    transport.playing = false;
    idleSince = Date.now();
    output.play(false);
    for (const c of viewer.activeClips()) if (c.video) c.video.pause();
    if (wasShowing) setPlayhead(transport.t);
    tell();
}

/// When playback stopped, for the release below. Zero while it is running.
let idleSince = 0;

/// How long a render is kept after playback stops, in milliseconds.
///
/// It is a cache, and this is its only eviction rule. Long enough that stopping
/// to look at something and starting again is free; short enough that a gigabyte
/// is not held by an application somebody walked away from twenty seconds ago.
const KEEP_MS = 20000;

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
    //
    // `isShowing`, not `isOn`: `pause()` above has just released playback's claim
    // on any render it was using, so unless somebody pressed `O` the picture is
    // the clips again and it is the clips that have to step.
    if (output.isShowing()) {
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
        transport.t = timelineTime(clip, clip.video.currentTime);
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

/// Put a decoder that has just been built where the playhead is.
///
/// **A clip can get its element without anybody having moved the playhead**, and
/// that is not an edge case: `residency.tick()` opens what the playhead is
/// approaching, once a frame, and playback moves the playhead through `advance()`
/// rather than through `setPlayhead`. A fresh element is a paused one at zero, so
/// a clip that arrived that way and then became the master clock reported
/// `currentTime` 0 — and `advance()` turns that into `clip.start + (0 - inPoint)`,
/// which is *negative* for any clip trimmed in. Measured: the playhead landing at
/// −3.48 s a moment after pressing play.
///
/// So the element is parked on arrival, by the same map `setPlayhead` uses. Not
/// *played*: whether it should be running is a question about what is on the
/// monitor, and the frame loop is about to answer it.
export function parkClip(clip) {
    if (!clip || !clip.video) return;
    applyAudio(clip);
    // A generator is not sent anywhere — libavfilter's sources produce forward
    // and the `lavfi` demuxer has no `read_seek`. Same rule as `setPlayhead`.
    if (isGenerator(clip)) return;
    const want = sourceTime(clip, transport.t);
    if (Math.abs(clip.video.currentTime - want) > 0.0005) clip.video.currentTime = want;
}

export function applyAudio(clip) {
    if (!clip || !clip.video) return;
    // Two volumes multiply: the clip's own level, which is part of the edit,
    // and the transport's, which is just how loud you are listening.
    clip.video.muted = transport.muted || clip.muted;
    clip.video.volume = transport.volume * clip.volume;
    // Two rates multiply, exactly as the two volumes above do, and for the same
    // reason: the clip's own speed is part of the edit and the transport's is how
    // fast you are watching. bro's `<video>` honours `playbackRate` for real — it
    // reaches the pipeline's rate and the audio engine's — so a sped-up clip
    // previews at its rate rather than wearing a badge saying it will not.
    clip.video.playbackRate = transport.rate * speedOf(clip);
    // Looping is a property of the timeline, not of any one clip: a clip that
    // looped itself would never hand over to the next one.
    clip.video.loop = false;
}

export function applyAudioAll() {
    for (const c of viewer.activeClips()) applyAudio(c);
    output.applyAudio();
}

// ── the clock ──────────────────────────────────────────────────────────────

/// About two frames. See the note at the top on why this is a tolerance and
/// not a correction.
const DRIFT_LIMIT = 0.12;

/// Called once a frame with the wall-clock delta. The only thing the frame
/// loop has to know about the transport.
export function tick(dt) {
    if (transport.playing) advance(dt);
    else adoptDecoderTime();
    // Let a render go once nobody has played for a while — see `KEEP_MS`. Only
    // playback's own claim on it: a preview somebody is looking at is not idle
    // just because the playhead is still.
    if (idleSince && !transport.playing && Date.now() - idleSince > KEEP_MS) {
        idleSince = 0;
        output.setOn(false, transport.t, 'play');
    }
}

/// A seek asks for a time; what comes back is the frame whose interval
/// contains it, which is generally a little earlier. The readout has to say
/// where the picture actually is — otherwise the timecode is a request rather
/// than a fact, and a frame step from a scrubbed position appears to move by
/// some odd fraction of a frame because the step really started somewhere else.
function adoptDecoderTime() {
    // `isShowing`, not `isOn`: a render kept warm after playback stopped is not
    // what anybody is looking at, and letting it answer here dragged the
    // playhead back to wherever it had been paused every time somebody scrubbed.
    if (output.isShowing()) {
        const t = output.at();
        if (t === null || Math.abs(t - transport.t) < 1e-6) return;
        transport.t = t;
        tell();
        return;
    }
    const clip = viewer.activeClip();
    if (!clip || !clip.video || !(clip.video.duration > 0)) return;
    // Through `timelineTime`, which is `sourceTime` inverted — including its
    // speed. The element's clock is always the file's, whatever rate it is being
    // played at, so this is where a sped-up clip's picture becomes a timecode.
    const t = timelineTime(clip, clip.video.currentTime);
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
    // **`ready` rather than `isOn`, and that is the whole of the handover.**
    // Engaging a preview builds a render, which opens every input it reads —
    // 1.2 s on a 75-clip edit — and playback now engages one itself (see
    // `play()`). Waiting for it would mean pressing play and watching nothing
    // move for over a second. So while it is warming the clips go on driving,
    // exactly as they always did, and the clock moves across the moment there is
    // a picture to take it.
    if (output.isShowing()) {
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
        if (t === null) return;             // it was open a moment ago
        // The clips were carrying playback until this frame and are now a second
        // soundtrack under an authoritative one — the preview carries the
        // render's own mix. Parked rather than left running, which is the same
        // rule `setPlayhead` follows and the reason it asks `isOn`.
        if (transport.playing) for (const c of viewer.activeClips())
            if (c.video && !c.video.paused) { try { c.video.pause(); } catch (e) {} }
        transport.t = Math.max(0, Math.min(d, t));
        if (transport.t >= d - 1e-6) { handOver(d); return; }
        if (hooks.reveal) hooks.reveal(transport.t);
        return;
    }

    const clip = viewer.activeClip();

    if (clip) {
        // On the timeline, not in the file: at 2× the element runs out of the
        // clip's window in half the seconds, and a `local` in the file's would
        // hand over half way through the bar.
        const local = timelineTime(clip, clip.video.currentTime) - clip.start;
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
