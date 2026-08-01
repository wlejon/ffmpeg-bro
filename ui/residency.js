// Which clips hold a decoder, and when.
//
// The viewer's `<video>` elements *are* the decoders. That is the decision the
// whole viewer is built on and it is not in question here — what is in question
// is how many of them exist at once. The rule used to be one per clip, built
// when the clip arrived and never taken back, and at a handful of clips that is
// exactly right: turning the output preview on and off costs a repaint rather
// than a seek per decoder, and stage views can hide each other with
// `display:none` without unmounting anything.
//
// At seventy-five clips it is 9.1 GB and twenty-six seconds of frozen window.
// Measured, opening a 75-clip montage of 1080p60 segments: 15.5 s building the
// elements, 10.4 s laying them out, 9147 MB resident. The same open with the
// elements suppressed and nothing else changed is 17 ms, and every part of the
// apply — `viewer.layout()`, `exporter.redraw()`, `timeline.draw()`,
// `showProperties()` — comes in under 10 ms. So the elements are not *a* cost of
// opening a large document; they are the whole of it.
//
// The rule therefore survives and its scope narrows: a decoder is held by a clip
// **near the playhead**, not by every clip in the edit. Memory becomes a
// property of the window rather than of the project, which is the same statement
// `ffmpeg_data.h` makes about a telemetry reading and the grid it is bucketed
// on, and the same one `ui/analysis.js` does not get to make — peaks and
// filmstrips are kept, because they are what the timeline draws for a clip
// nobody is looking at.
//
// Four things about it are load-bearing.
//
// **The clips under the playhead are attached synchronously and are never
// capped.** `setPlayhead` reads `clip.video.currentTime` on the line after it
// asks for them, so an element that arrived a frame later would be a crash
// rather than a hitch — and a composite of twelve clips genuinely needs twelve
// decoders, so a cap that could refuse one would be a missing layer in the
// picture rather than a saving. What is bounded is the *look-ahead*.
//
// **The look-ahead is the reason this is not simply "attach whatever is
// showing".** An element handed a src takes ~65 ms to open its demuxer and fill
// its audio ring, so a clip attached at the moment the playhead reached it would
// be a stutter at every cut. Clips within `NEAR` seconds are opened before they
// are needed, at most `PER_FRAME` of them in any one frame, so the element is
// already parked in position when the playhead arrives.
//
// **Eviction is hysteretic, and that is what stops a scrub thrashing.** `FAR` is
// three times `NEAR`, so dragging the playhead back and forth across a cut does
// not tear down and rebuild the same decoder twice a second. The gap between the
// two numbers is the whole of the mechanism; the numbers themselves are not
// precious.
//
// **Analysis is not residency and must not be driven from here.** A clip's
// waveform and filmstrip are read once, when it joins the edit, and they are
// held on the clip rather than on the element — so evicting a decoder leaves the
// timeline lanes exactly as they were. Tying the two together would make
// scrolling the timeline re-decode files, which is the cost this file exists to
// remove rather than move.
//
// **The look-ahead is off while the clips are not the picture.** It exists so a
// cut does not stutter, and there is no cut to cross when what is on the monitor
// is the render (`ui/output.js`): the clips are parked and hidden behind it, so a
// decoder opened for one of them is 65 ms of the drawing thread and a demuxer
// held, spent on a shot nobody will see the crossing into. Measured while playing
// a 75-clip montage on the render: **29 elements built in 45 seconds**, every one
// of them for a clip behind the preview. What does *not* stop is `retain()` — the
// clips under the playhead keep their decoders whatever is on screen, because
// turning the preview off has to be a repaint rather than a seek per clip, and
// because `setPlayhead` reads `clip.video.currentTime` on the line after it asks
// for them.

import { project, clipsAt } from './project.js';

/// Seconds either side of the playhead in which a clip is opened before it is
/// needed. Four is a little over a second of headroom at the one-per-frame rate
/// below, which is enough for the montage case — a run of short clips — without
/// holding open a decoder for a cut a minute away.
const NEAR = 4;

/// And the distance at which one is closed again. Three times `NEAR` rather than
/// equal to it: with no gap, a playhead sitting exactly on the boundary would
/// attach and detach the same clip on alternate frames.
const FAR = 12;

/// How many elements may be built in one frame. One, because an attach is ~65 ms
/// — four in a frame would be a quarter-second stall, which is the thing being
/// fixed rather than a way of fixing it.
const PER_FRAME = 1;

/// How many clips may be held open ahead of the playhead, over and above the
/// ones under it. A bound on the look-ahead only: `retain()` is never refused.
const AHEAD_CAP = 4;

let hooks = {};
let queue = [];

/// `attach(clip)` and `detach(clip)` — the viewer's element lifecycle.
export function initResidency(h) { hooks = h || {}; }

/// How far the playhead is from a clip, in timeline seconds. Zero while it is
/// inside one, which is the same span `clipsAt()` reports and deliberately the
/// same arithmetic.
function distance(clip, t) {
    if (t < clip.start) return clip.start - t;
    const end = clip.start + clip.length;
    return t > end ? t - end : 0;
}

/// Give the playhead the decoders it is about to be asked for. Called from
/// `setPlayhead`, before the active set is computed.
///
/// Synchronous and unbounded on purpose — see the header. Everything else this
/// file does is deferred to `tick()`, so a seek costs exactly the elements the
/// seek actually lands on and nothing else.
export function retain(t) {
    for (const clip of clipsAt(t))
        if (!clip.video && hooks.attach) hooks.attach(clip);
}

/// Open what is coming, close what has gone. Called once a frame.
///
/// `ahead` is whether to open anything the playhead has not reached yet — false
/// while the render is the picture, because there is then no cut to cross. See
/// the header.
///
/// The eviction runs before the queue is refilled, so a frame in which something
/// left the window and something else entered it does both rather than putting
/// the second off until the next one.
export function tick(t, ahead = true) {
    if (!hooks.attach) return;
    // **The invariant first, every frame, however it came to be broken.** A seek
    // is not the only way a clip under the playhead can lose its element: an
    // undo, a reopened input and a generator given new arguments all tear one
    // down through `hooks.detach` and leave putting it back to whoever moves the
    // playhead next — which, standing still, is nobody. Restoring it here costs
    // a `clipsAt` and a field test per frame and means the rule holds without
    // anything having to remember to ask.
    retain(t);
    const here = clipsAt(t);

    // Gone far enough to be worth the teardown. Never a clip under the playhead,
    // whatever the arithmetic says — `retain()` would only build it again on the
    // next seek, and between the two there would be a frame with no picture.
    for (const clip of project.clips)
        if (clip.video && here.indexOf(clip) < 0 && distance(clip, t) > FAR)
            hooks.detach(clip);

    // What is worth opening now, nearest first, so a queue that never drains
    // still drains in the order the playhead will want.
    queue = !ahead ? [] : project.clips
        .filter((c) => !c.video && here.indexOf(c) < 0 && distance(c, t) <= NEAR)
        .sort((a, b) => distance(a, t) - distance(b, t))
        .slice(0, AHEAD_CAP);

    for (let i = 0; i < PER_FRAME && queue.length; i++) hooks.attach(queue.shift());
}

/// How many clips are waiting for a decoder. For the status line, and for the
/// tests, which is the only way to check that a document opened with a bounded
/// number of elements rather than all of them.
export function pending() { return queue.length; }

/// How many decoders are open. The number this file exists to keep small.
export function resident() {
    let n = 0;
    for (const clip of project.clips) if (clip.video) n++;
    return n;
}
