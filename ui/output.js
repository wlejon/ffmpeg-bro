// The output, in the program monitor — the render as one picture rather than
// one `<video>` per clip.
//
// The viewer composites by placing an element per clip inside the output
// canvas. That is free, it is exact for everything a clip does on its own, and
// there are three things it structurally cannot show, all of them things that
// are not about one clip:
//
//   - a **generated source** — a `testsrc` or a `color` feeding an `overlay` —
//     which is a node with no clip, so there is no element for it to be;
//   - a **filter over the whole canvas**, a burn-in after the composite, which
//     has no single picture to run on because the composite is the browser's;
//   - a **filter that resizes a clip's picture below the point where the clip
//     is placed**, which the render lays over the canvas at its own size rather
//     than in a rectangle — so there is nothing for the viewer to place, and it
//     says so instead of guessing. A resize on the way *in* is a rectangle, and
//     the viewer does show that one.
//
// All three are questions about what the *output* is, and the only honest answer
// to those is the output. So this points one element at
// `bro.ffmpeg.output` — the render's own `FrameSource`, made frame by frame as
// the element asks for it, with no encoder and no file on the end of it. See
// `src/native/playback_output.h`.
//
// Four rules, each of which is why this file is shaped the way it is.
//
// **The spec is `buildSpec()`'s**, taken through `previewSpec()` with the window
// moved to the playhead — the same call the A/B comparison and a node card make.
// A preview built any other way could describe a render this application would
// not perform, which is the one thing it must never do.
//
// **The playhead is the range's start, and moving it is a redefinition.** A
// filter graph pulls: it produces the frames it produces, in order, and there is
// no seeking inside one — only building one whose inputs begin where you want to
// start. The token therefore carries the range, so a moved playhead is a
// different src and a fresh source, and that is the whole of the seek.
//
// **Nothing rebuilds under a moving hand.** Re-pointing means opening every
// input the render reads and configuring libavfilter, so a scrub that did it per
// mouse-move would be unusable. Like a node preview, this waits for things to
// hold still. It is the same rule the viewer's per-clip filters follow for the
// same reason.
//
// **It is the clock and the sound while it is on**, because it is the picture on
// the screen and the mix coming out of it — which is exactly the rule
// `transport.js` already states about the topmost clip, now true of both halves.
// The clips underneath stay paused: they are the same sound by a cheaper route
// for everything except the thing this is for, and playing them as well would be
// every clip heard twice, once as itself and once through the mix.
//
// So the element is **not muted**, and that is the only line of this file the
// sound cost. What it bought is the half of a render no clip element can play: an
// `-af` chain on the whole programme, a `loudnorm`, an `amix` with a generator in
// it. What it did *not* buy is a soundtrack that stretches when the render cannot
// keep up — the sound is the authoritative half and pictures are dropped to keep
// it real time, which is argued in `playback_output.h` and is why a slow graph
// preview shows an older picture than the playhead claims.

import { previewSpec, range } from './export/spec.js';

/// The id the render is registered under. One, because there is one program
/// monitor: a second preview would be a second render of the same edit
/// competing with this one for the same decoders.
const ID = 'edit';

/// How long the edit has to hold still before anything is rebuilt, in
/// milliseconds. The same number and the same reason as `graph/preview.js`'s:
/// dragging a slider walks through fifty values and rendering all fifty would
/// make the application unusable to save the last one.
const QUIET_MS = 350;

let stage = null;
let hooks = {};
let el = null;

let on = false;
let reason = '';          ///< why there is no picture, when there is none
let showing = 0;          ///< where the current source's first frame sits
let want = 0;             ///< where it is supposed to sit
let dirty = false;
let since = 0;            ///< when the want last changed
let settledKey = '';      ///< the graph last put to libavfilter
let facts = null;         ///< what the render on screen turned out to be
/// What the transport last asked for, which is not the same as what the element
/// is doing. A preview is re-pointed whenever the edit changes, and an element
/// handed a new src is a *paused* element at zero — so the wanted state has to
/// be remembered and put back, or an edit made while watching would silently
/// stop the playback it was made during.
let running = false;

/// `changed()` — the button and the message are out of date.
export function initOutput(refs, h) {
    stage = refs && refs.stage;
    hooks = h || {};
}

const tell = () => { if (hooks.changed) hooks.changed(); };

export function isOn() { return on; }

/// Why the preview has no picture, or '' when it has one. Shown on the stage,
/// so it is libavfilter's own sentence where libavfilter is the one refusing.
export function why() { return reason; }

/// The timeline moment the picture is at, or null when there is no picture.
///
/// The element's own clock starts at zero — its source is a render of the range
/// beginning where the playhead was — so the moment is that plus where the range
/// begins. This is what makes the preview the master clock rather than something
/// chased.
export function at() {
    if (!on || !el || !(el.duration > 0)) return null;
    return showing + (el.currentTime || 0);
}

export function ended() { return !!(on && el && el.ended); }

/// What the render on the screen turned out to be — `{ width, height, fps,
/// start, length, graph }` — or null when there is none.
///
/// `graph` is which of the renderer's two paths this preview is of, and it is
/// the one fact here that is not simply a copy of the spec: the rule that
/// decides it lives in `runExport`, and `bro.ffmpeg.output.settle` is where it
/// is answered. It matters because the two are different things to look at —
/// they agree to 43 dB and one of them is libavfilter — and because it is the
/// whole claim this feature makes about itself.
export function currentFacts() { return facts; }

// ── turning it on ──────────────────────────────────────────────────────────

/// Show the render instead of the clips, or stop.
///
/// Returns true when the mode changed, which is the caller's cue to re-place
/// everything: the clips have to be hidden and the preview sized to the canvas,
/// and both of those are the viewer's business rather than this file's.
export function setOn(value, t) {
    const next = !!value;
    if (next === on) return false;
    on = next;
    reason = '';
    if (!on) {
        running = false;
        drop();
        tell();
        return true;
    }
    // Straight away rather than after the quiet period: this is a press, so
    // there is nothing to wait for and a blank canvas for a third of a second
    // would read as the mode not working.
    want = Number(t) || 0;
    dirty = true;
    apply();
    tell();
    return true;
}

/// The playhead moved. Recorded rather than acted on — see the note at the top
/// about a moving hand.
export function moveTo(t) {
    if (!on) return;
    const next = Math.max(0, Number(t) || 0);
    if (Math.abs(next - want) < 1e-6) return;
    want = next;
    dirty = true;
    since = Date.now();
}

/// The edit changed under the preview: whatever is on the screen is of a render
/// that no longer exists. Re-pointed from wherever the picture had got to, so
/// that an edit made while watching does not throw the playhead back to where
/// the last one started.
export function invalidate() {
    if (!on) return;
    const here = at();
    if (here !== null) want = here;
    dirty = true;
    since = Date.now();
}

// ── the element ────────────────────────────────────────────────────────────

function element() {
    if (el) return el;
    el = document.createElement('video');
    el.className = 'outframe';
    // Ahead of every clip's window. The clips are hidden while this is on, but
    // they are hidden by the viewer and this must be in front of them even for
    // the frame between the two happening.
    el.style.zIndex = '900';
    stage.appendChild(el);
    // Sized on the way in as well as on every resize. An element built by a
    // rebuild rather than by the press — the first spec having had nothing to
    // render — would otherwise be a picture with no box until the window
    // happened to change size.
    place();
    return el;
}

function drop() {
    if (!el) return;
    // Stopping first releases the source, which is a render holding every input
    // it reads open; dropping the element alone would leave it running until the
    // next collection.
    try { el.pause(); el.src = ''; } catch (e) { /* already gone */ }
    stage.removeChild(el);
    el = null;
    try { bro.ffmpeg.output.forget(ID); } catch (e) { /* never defined */ }
    settledKey = '';
    facts = null;
}

/// Size the preview to the output canvas.
///
/// It *is* the canvas — the whole picture, at the size the render makes it — so
/// unlike a clip there is no placement to work out and no argument to take: the
/// stage is the canvas, and asking it is one fact rather than two that have to
/// agree.
export function place() {
    if (!el || !stage) return;
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = `${stage.clientWidth}px`;
    el.style.height = `${stage.clientHeight}px`;
}

// ── transport ──────────────────────────────────────────────────────────────

export function play(yes) {
    running = !!yes && on;
    if (!on || !el) return;
    try { if (yes) el.play(); else el.pause(); } catch (e) { /* not open yet */ }
}

/// One frame of the render. `stepFrame` moves by decoded pictures, which for
/// this source is exactly one canvas — so unlike a file there is no averaged
/// frame rate to miss a boundary by.
///
/// Backwards is a rebuild and not a step: the source only goes forward, so a
/// step back is a preview of the moment before this one, which is a new range.
export function step(dir) {
    if (!on || !el) return false;
    if (dir > 0) return !!(el.stepFrame && el.stepFrame(1));
    const here = at();
    if (here === null) return false;
    const fps = facts && facts.fps > 0 ? facts.fps : 25;
    want = Math.max(0, here - 1 / fps);
    dirty = true;
    since = 0;      // a key press is not a gesture; there is nothing to settle
    return true;
}

// ── every frame ────────────────────────────────────────────────────────────

/// Keep the preview running, and rebuild it once the edit has held still.
/// Called once a frame.
export function chase() {
    if (!on) return;

    // **Keep asking.** `play()` in the turn a src was set is asked of a source
    // that is not open yet and is simply dropped — the same thing the A/B
    // comparison has to do, and the reason `running` is remembered rather than
    // issued once. Every re-point is that turn again: an edit made while
    // watching would otherwise stop the playback it was made during.
    //
    // Not an ended one. This source runs out where its range does, and asking a
    // finished element to play starts it again from the top — a preview that
    // looped instead of stopping, which is a decision the transport makes and
    // not this file.
    if (running && el && el.paused && !el.ended && el.duration > 0) {
        try { el.play(); } catch (e) { /* still not open */ }
    }

    if (!dirty) return;
    if (since && Date.now() - since < QUIET_MS) return;
    apply();
}

/// The spec for a render starting here, or null when there is nothing to render.
///
/// `passes: null` because a preview is not two walks of anything and versions
/// are a second *output* — both are answers about writing files, and there is no
/// file here. Building them would cost a whole second derivation of the edit per
/// version for a field this path never reads.
function specFrom(t) {
    const r = range();
    const start = Math.max(r.start, Math.min(t, Math.max(r.start, r.end - 1e-3)));
    if (!(r.end > start)) return null;
    return previewSpec({ start, end: r.end, passes: null });
}

function apply() {
    dirty = false;
    const spec = specFrom(want);
    if (!spec) {
        reason = 'there is nothing in the range to render';
        facts = null;
        if (el) { try { el.pause(); el.src = ''; } catch (e) {} }
        tell();
        return;
    }

    // **Settled only when the graph changed.** Building the source opens every
    // input the render reads and configures libavfilter, and doing it here as
    // well as when the element opens would be doing it twice — worth paying for
    // a graph, whose refusal is a sentence somebody needs to read, and worth
    // nothing at all for the compositor, which cannot fail to build.
    const graph = String(spec.filterGraph || '');
    const key = graph && JSON.stringify([graph, spec.inputs, spec.width, spec.height]);
    if (key && key !== settledKey) {
        try {
            facts = bro.ffmpeg.output.settle(spec);
            settledKey = key;
        } catch (e) {
            settledKey = '';
            facts = null;
            reason = String((e && e.message) || e);
            if (el) { try { el.pause(); el.src = ''; } catch (err) {} }
            tell();
            return;
        }
    } else if (!graph) {
        // The compositor cannot fail to build, so there is nothing to ask: what
        // it produces is what the spec says, and saying so here rather than
        // opening every input to be told the same thing is the whole reason
        // settling is a separate call.
        settledKey = '';
        facts = { width: spec.width, height: spec.height, fps: spec.fps,
                  start: spec.start, length: Math.max(0, spec.end - spec.start),
                  graph: false };
    }
    reason = '';
    // The range is this preview's and not the settled graph's: a graph settled
    // once stands for every position of the playhead, which is exactly what
    // makes settling worth skipping.
    if (facts) { facts.start = spec.start; facts.length = Math.max(0, spec.end - spec.start); }

    const src = bro.ffmpeg.output.define(ID, spec);
    const v = element();
    showing = spec.start;
    if (v.src !== src) {
        try { v.pause(); } catch (e) {}
        v.src = src;
        // Audible, and full scale: what comes out of this element is the render's
        // own mix, so anything less than 1.0 would be a gain nobody asked for
        // sitting between the numbers on the Encode stage and the sound in the
        // room. Said on every re-point rather than once, because an element handed
        // a new src is a fresh one in every respect.
        v.muted = false;
        v.volume = 1;
    }
    tell();
}
