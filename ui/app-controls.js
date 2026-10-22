// Clip & generator editing actions, transport controls, slider dragging, viewer
// pan/zoom/crop, keyboard shortcuts, drag-and-drop, frame loop (`frame`),
// readouts (`syncUI`/`syncVolume`), and generator picker for `ui/app.js`.

import { project, projectFps, makeGenerator, applyGenerator,
         addClip, removeClip, duration, clipsAt, changed, select,
         selectMany, isSelected, splitClip, trackCount,
         applyInput, clipsOf, hasPicture } from './project.js';
import * as generators from './generator.js';
import * as assemble from './sequence.js';
import { analyzeClip, pending, tickAnalysis } from './analysis.js';
import * as viewer from './viewer.js';
import { initResidency, tick as tickResidency } from './residency.js';
import * as output from './output.js';
import * as softcues from './softcues.js';
import * as monitor from './monitor.js';
import * as find from './find.js';
import * as timeline from './timeline.js';
import * as exporter from './export.js';
import { showProperties, showTransform, subjects } from './inspector.js';
import { timecode } from './format.js';
import { setText } from './dom.js';
import { setIcon } from './icons.js';
import { chaseGraph, tickGraph, graphKey } from './graph/view.js';
import * as graphOverlay from './graph/overlay.js';
import * as shell from './shell.js';
import * as capture from './capture.js';
import { tickSources } from './sources.js';
import { transport, initTransport, setPlayhead, play, pause, togglePlay, step,
         applyAudioAll, parkClip, tick as tickTransport } from './transport.js';
import * as report from './report.js';

let ctx = null;
export function bindAppControlsContext(c) { ctx = c; }

let fullscreen = false;
let cropMode = false;

export function cropModeOf() { return cropMode; }

/// Lay a generator out: a clip whose source is a filter rather than a file.
///
/// **Everything past deciding what it is, is `openInput`'s path with the input
/// half taken out** — the same `addClip`, the same element, the same selection,
/// the same fit of the ruler. That is the whole claim `ui/project.js`'s header
/// makes about a generator being a clip, and it is worth noticing that this
/// function is short because of it.
///
/// The canvas's size and rate, where the filter has options to take them (see
/// `makeSpec`), falling back to the same 1920×1080 `buildSpec()` does for an
/// empty timeline — so a `testsrc` dropped first *is* the canvas rather than
/// making a 320×240 one out of libavfilter's default.
///
/// A generator that will not open says so and lays out nothing, exactly as a file
/// that will not open does: the message is libavfilter's own, which for a filter
/// this build does not have or an option it does not take is the only sentence
/// worth showing.
export function addGenerator(filter) {
    const settled = generators.settle(generators.makeSpec(filter, {
        width: project.width || 1920,
        height: project.height || 1080,
        fps: projectFps(),
    }));
    if (!settled.ok) { ctx.flash(settled.why); return null; }

    const clip = makeGenerator(settled);
    addClip(clip);
    viewer.attachClip(clip);
    select(clip, 'auto');
    ctx.dropzone.classList.add('hidden');
    setControlsEnabled(true);
    viewer.layout();
    timeline.fitView();
    setPlayhead(clip.start);
    showProperties();
    changed('open');
    ctx.flash(`${clip.name} on V${clip.track + 1}`);
    return clip;
}

/// New arguments for a generator clip, as somebody typed them.
///
/// Refused as a whole or applied as a whole: libavfilter reads the string when the
/// input is opened, so a filter that will not take it leaves the clip exactly as
/// it was and the reason is said out loud. `media` is untouched — how long the
/// clip is is the edit's number and not the filter's — but the picture's *size*
/// may well have changed, which is why the layout and the render's statements are
/// put back afterwards.
export function setGeneratorArgs(clip, text) {
    const want = generators.withArgs(clip.generator, text);
    const settled = generators.settle(want);
    if (!settled.ok) { ctx.flash(settled.why); return false; }
    if (settled.src === clip.src) return false;         // the same generator, retyped
    applyGenerator(clip, settled);
    // The element *is* the decoder and it is now decoding a different source, so
    // it is rebuilt rather than re-pointed — the same rule `reloadInput` follows.
    viewer.detachClip(clip);
    viewer.attachClip(clip);
    viewer.layout();
    setPlayhead(transport.t);
    changed('generator');
    return true;
}

/// An input has been reopened — a demuxer forced, an option set, a window
/// moved — so everything downstream of what it contains is put back.
///
/// The `<video>` is rebuilt rather than re-pointed: the element *is* the
/// decoder, and a decoder holding the file as it was opened before is exactly
/// what has just stopped being true.
export function reloadInput(input) {
    applyInput(input);
    for (const clip of clipsOf(input)) {
        viewer.detachClip(clip);
        viewer.attachClip(clip);
        clip.peaks = null;
        clip.film = null;
        analyzeClip(clip);
    }
    viewer.layout();
    setPlayhead(Math.min(transport.t, duration()));
    changed('inputs');
}

/// Open several files as one gesture. Dropping a morning's recordings is not
/// the same act as opening one file: past a couple of them the useful thing is
/// usually to see them all at once, so they go on separate tracks, all starting
/// at zero, and the canvas switches to a grid.
export function openBatch(paths) {
    // What was dropped is files; what is opened is inputs, and the two are not
    // the same count. Three hundred numbered PNGs are one input, so the rule
    // about a batch becoming a grid has to be counted after the grouping and
    // not before it — dropping a folder of frames is one clip, and it would
    // otherwise be three hundred tracks.
    const items = assemble.openables(paths);
    if (items.length === 1) return [ctx.openSpec(items[0].spec)];
    const grid = items.length >= 3;
    // Stack the batch above whatever is already there, or start at V1 when the
    // timeline is empty — `trackCount()` counts the spare lane, which is not a
    // track anything lives on yet.
    const base = grid ? (project.clips.length ? trackCount() - 1 : 0) : 0;
    const made = [];
    for (const item of items) {
        const clip = ctx.openSpec(item.spec,
                                  { quiet: true, track: grid ? base + made.length : undefined });
        if (clip) { if (grid) clip.start = 0; made.push(clip); }
    }
    if (!made.length) return made;
    if (grid) setLayout('grid');
    selectMany(made);
    timeline.fitView();
    // A grid starts at the top; a run of clips appended to the timeline starts
    // at the first one you just dropped, which is what you came to look at.
    setPlayhead(grid ? 0 : made[0].start);
    showProperties();
    changed('open');
    ctx.flash(`Opened ${made.length} clips` + (grid ? ' as a grid' : ''));
    return made;
}

export function removeSelection() {
    const doomed = project.selection.slice();
    if (!doomed.length) return;
    for (const clip of doomed) {
        viewer.detachClip(clip);
        removeClip(clip);
    }
    if (!project.clips.length) {
        ctx.dropzone.classList.remove('hidden');
        setControlsEnabled(false);
        project.width = project.height = 0;
        project.layout = 'stack';
    }
    timeline.fitView();
    setPlayhead(Math.min(transport.t, duration()));
    showProperties();
    changed('remove');
    ctx.flash(doomed.length === 1 ? 'Removed ' + doomed[0].name : `Removed ${doomed.length} clips`);
}

/// Split every selected clip the playhead is inside. Splitting the selection
/// rather than "the clip under the playhead" is what makes it work on a stack:
/// one keypress can cut through four tracks at the same instant, or through
/// exactly the one you picked.
export function splitAtPlayhead() { splitAt(transport.t, true); }

/// The same cut, at a moment somebody handed over rather than at the playhead.
///
/// A measurement produces cut points — `blackdetect` found four stretches of
/// black, `scdet` found nine changes — and acting on one means cutting there,
/// which is this. It cuts every clip the moment falls inside rather than the
/// selection, because a list of moments is not a statement about what is
/// selected; `useSelection` is what the keyboard passes to keep `S` meaning
/// what it has always meant. Returns how many clips were actually cut, so a
/// caller applying nine points can say what happened rather than claiming nine.
export function splitAt(t, useSelection) {
    const targets = ((useSelection && project.selection.length)
                        ? project.selection : clipsAt(t))
        .filter((c) => t > c.start + 1e-3 && t < c.start + c.length - 1e-3);
    if (!targets.length) {
        if (useSelection) ctx.flash('Nothing to split here');
        return 0;
    }
    const halves = [];
    for (const c of targets) {
        const right = splitClip(c, t, (n) => { n.peaks = c.peaks; n.film = c.film; viewer.attachClip(n); });
        if (!right) continue;
        // A cut should not change how either half looks, and the graph's nodes
        // are pinned to clip ids — so the new half gets its own copy of
        // whatever was pinned to the whole. Without this, splitting a clip you
        // had put a filter on silently drops the filter off everything after
        // the cut.
        graphOverlay.cloneClip(c.id, right.id);
        halves.push(right);
    }
    // The right-hand halves become the selection: after a cut you are almost
    // always about to do something to what comes after it.
    if (halves.length) selectMany(halves);
    viewer.layout();
    setPlayhead(t);
    changed('split');
    if (useSelection) ctx.flash(halves.length === 1 ? 'Split' : `Split ${halves.length} clips`);
    return halves.length;
}

export function setLayout(mode) {
    if (project.layout === mode) return;
    project.layout = mode;
    ctx.el('btn-grid').classList.toggle('on', mode === 'grid');
    viewer.refreshAll();
    updateCropUI();
    showProperties();
    ctx.flash(mode === 'grid' ? 'Grid layout' : 'Stacked layout');
    // A grid ignores every clip's placement and gives each an equal cell, so
    // this is a change to what the render produces and not to how it is being
    // looked at — which means the spine, the command bar and the document's
    // unsaved marker are all downstream of it. It went without saying while
    // nothing outside this file read `project.layout`; the compositor does.
    changed('edit');
}

// ── transport ──────────────────────────────────────────────────────────────
//
// The playhead itself is ui/transport.js — what moves, what is chased and what
// is adopted from a decoder. What is here is the strip of controls that drives
// it, and the readouts it drives back.

export function setControlsEnabled(on) {
    for (const b of [ctx.btnStart, ctx.btnPrev, ctx.btnPlay, ctx.btnNext, ctx.btnEnd, ctx.btnLoop, ctx.btnMute])
        b.disabled = !on;
    ctx.rateSel.disabled = !on;
}

export function toggleFullscreen() {
    fullscreen = !fullscreen;
    document.body.classList.toggle('fs', fullscreen);
    bro.settings.set('graphics.fullscreen', fullscreen);
    // The viewer changes size when the panels go away, so the canvas has to
    // be re-fitted before the next frame is presented.
    requestAnimationFrame(() => { viewer.layout(); updateCropUI(); });
}

// ── press-and-track, for every slider-shaped thing ─────────────────────────

function draggable(surface, onFraction, opts) {
    let dragging = false;
    const scrubs = opts && opts.scrubs;
    let resume = false;

    const fractionAt = (clientX) => {
        const r = surface.getBoundingClientRect();
        if (r.width <= 0) return 0;
        return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    };

    // `(fraction, press, release)`, which is the timeline's `onSeek` contract
    // and is one contract on purpose: the two surfaces that scrub are the only
    // callers that care, and both have to tell a hand that is still moving from
    // one that has stopped — the first marks a seek and the frame loop performs
    // it, the last performs it there and then, because a stopped hand causes no
    // further frames. A caller that does not care (the volume slider) reads the
    // fraction and ignores the rest.
    surface.addEventListener('mousedown', (e) => {
        dragging = true;
        // Dragging a playhead stops playback, the way every edit suite does.
        // It is also what keeps a drag cheap: while paused, a seek costs one
        // decode instead of also tearing down and refilling the audio ring.
        if (scrubs && transport.playing) { resume = true; pause(); }
        onFraction(fractionAt(e.clientX), true, false);
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (dragging) onFraction(fractionAt(e.clientX), false, false);
    });
    document.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        onFraction(fractionAt(e.clientX), false, true);
        if (resume) { resume = false; play(); }
    });
}

export function updateCropUI() {
    const cropbox = ctx.cropbox;
    const c = project.selected;
    // Nothing to crop where there is no picture: `placement()` hands back no
    // rectangle for one, and a crop box drawn against it would be a two-pixel
    // square in the corner of the stage inviting a gesture with no meaning.
    if (!cropMode || !c || !c.frame || !hasPicture(c)) {
        cropbox.classList.add('hidden');
        return;
    }
    const s = viewer.stageSize();
    const p = viewer.placement(c, s.w, s.h);
    const cr = c.xform.crop;
    cropbox.classList.remove('hidden');
    cropbox.style.left = (p.x + p.w * cr.l).toFixed(1) + 'px';
    cropbox.style.top = (p.y + p.h * cr.t).toFixed(1) + 'px';
    cropbox.style.width = Math.max(2, p.w * (1 - cr.l - cr.r)).toFixed(1) + 'px';
    cropbox.style.height = Math.max(2, p.h * (1 - cr.t - cr.b)).toFixed(1) + 'px';
}

// J/L shuttle: each press moves one step through the speed list, playing
// forward. (Reverse playback needs backwards decode, which is a later job.)
const RATES = [0.25, 0.5, 1, 1.5, 2, 4];
function nudgeRate(dir) {
    if (!project.clips.length) return;
    let i = RATES.indexOf(transport.rate);
    if (i < 0) i = RATES.indexOf(1);
    i = Math.max(0, Math.min(RATES.length - 1, i + dir));
    transport.rate = RATES[i];
    ctx.rateSel.value = String(RATES[i]);
    applyAudioAll();
    if (!transport.playing) play();
    ctx.flash(RATES[i] + '×');
}

// ── the frame loop ─────────────────────────────────────────────────────────

let lastTick = 0;
let lastViewerW = -1, lastViewerH = -1, lastLaneW = -1;
let lastWaiting = -1;
let lastBusy = '';

function frame(now) {
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;

    tickTransport(dt);

    // Open the clips the playhead is about to reach and close the ones it has
    // left. After the transport, so it works from where the playhead is *now*
    // rather than a frame behind — and from here rather than from `setPlayhead`,
    // because playback inside a long clip moves the playhead without seeking and
    // a look-ahead computed only on seeks would go stale exactly where the next
    // cut is.
    // The look-ahead is only worth having while the clips are what is on the
    // monitor — see ui/residency.js. What is under the playhead is opened either
    // way, which is what `tick` does before it looks at anything else.
    tickResidency(transport.t, !output.isShowing());

    // Two things that were not ready last frame: an input the finder is waiting
    // on, and an audition that has reached the end of the moment it was playing.
    if (ctx.hasAwaitingProbes()) ctx.settleProbes();
    find.tick();

    // A panel that changed size (window resize, fullscreen) has to be redrawn
    // from the analysis rather than stretched — a stretched waveform lies
    // about where the sound is.
    //
    // A panel that is not on screen measures zero, which is not a size it ever
    // has to be laid out for: the Output workspace hides the edit, and
    // relaying everything out to nothing and back costs a full re-layout each
    // way for a picture nobody was looking at. Remembering the last real size
    // also means coming back only redraws if the window actually changed.
    const viewerEl = ctx.viewerEl;
    if (viewerEl.clientWidth > 0 &&
        (viewerEl.clientWidth !== lastViewerW || viewerEl.clientHeight !== lastViewerH)) {
        lastViewerW = viewerEl.clientWidth;
        lastViewerH = viewerEl.clientHeight;
        viewer.layout();
        output.place();
        updateCropUI();
    }
    // The output preview rebuilds only once the edit has held still, because
    // re-pointing it opens every input the render reads. Here rather than on the
    // change channel for exactly that reason — see ui/output.js.
    output.chase();
    // Which picture is on the canvas. After `chase()`, because that is what
    // builds a render, and the answer is "is there one" — see the note there.
    ctx.syncOutputPicture();
    // Which cues are on screen now. Every frame and from here rather than from
    // the change channel, because what it draws is a function of the playhead
    // and the playhead moves without anything changing — and it writes to the
    // DOM only when the answer differs from the one already on the screen.
    softcues.tick(transport.t);
    // How loud what is leaving is. Every frame and from here rather than from a
    // change channel, because a level is what is happening *now* — and it is the
    // one caller of either reading, both of which clear as they are read.
    monitor.tick();
    // Watch the video lanes, not the waveform: the waveform is in the markup
    // and laid out from the first frame, so it never notices a lane that was
    // built a moment ago and has not been measured yet.
    const laneW = timeline.laneWidthPx();
    if (laneW > 0 && laneW !== lastLaneW) {
        lastLaneW = laneW;
        timeline.draw();
    }
    if (transport.playing) syncUI();
    // How many clips are still being read. It changes without the playhead
    // moving and without the model changing — a document of seventy-five arrives
    // over the best part of a minute while nothing is playing — so nothing else
    // on this list would notice, and it is the only thing on the screen saying
    // that an edit which is already laid out is not yet fully drawn.
    const waiting = pending();
    if (waiting !== lastWaiting) { lastWaiting = waiting; ctx.needs('readouts'); }
    // ...and whether one of the five redraws is owed and known to be slow. Read
    // *before* `drawPending`, so the phrase goes up on the frame the work is
    // still owed rather than on the one after it has been done — which for
    // something that takes a single frame would be never. See `busyWord`.
    const busy = ctx.busyWord();
    if (busy !== lastBusy) { lastBusy = busy; ctx.needs('readouts'); }
    // And everything a change since the last frame marked out of date, drawn
    // once however many times it was marked. See `needs` for why this is here
    // rather than at each of the places that change something.
    ctx.drawPending();
    // The wires are drawn in screen coordinates against a canvas the size of
    // the viewport, so a stage that changed size has to redraw them. Same rule
    // as everything above: a measurement of zero is a hidden stage, not a
    // small one.
    chaseGraph();
    // The node previews are renders, and a render is watched from here for the
    // same reason the export's is: nothing calls back into JS.
    if (shell.currentStage() === 'graph') tickGraph();
    // The render is on a thread of its own in the host binary; this is the
    // only thing that looks at it, and only while its dialog is up.
    exporter.tick();
    // A recording is the same job slot watched from the same place, and it is
    // watched wherever you are standing: unlike a preview it cannot be
    // abandoned by walking away from the stage that started it.
    capture.tick();
    // What the render said, drained here rather than beside the progress bar:
    // a render started from the Write stage keeps going while you walk back to
    // the edit, and probing and playback log from wherever you are, so a
    // channel that only listened while one panel was up would have holes in it
    // exactly where somebody went to look at something.
    report.tick();
    report.chaseReport();
    // An input opened over a network answers on a thread of its own, and this
    // is the only thing that looks at it — from here rather than from the
    // Sources stage's own code for the reason the render's poll is here: a URL
    // typed on that stage goes on connecting while you walk to the timeline,
    // and a watcher that only ran while one panel was up would leave the card
    // saying "connecting" until somebody went back to look at it.
    tickSources();
    // What a clip looks and sounds like, for the span the timeline is showing.
    // From here rather than from `timeline.draw()` because a view that has come
    // to rest stops redrawing and it is the settling that decides a read is
    // wanted — and because a source *improving* under a clip, which is what a
    // local copy landing is, is not a view change at all.
    tickAnalysis();

    requestAnimationFrame(frame);
}

// ── readouts ───────────────────────────────────────────────────────────────

export function syncUI() {
    const t = transport.t;
    const d = duration();

    // Through `setText` because this runs on every frame of playback and only
    // the first of the three changes on one: `textContent =` replaces the text
    // node and marks the subtree for layout whether or not the words differ, so
    // the duration and the stats line were relaying themselves sixty times a
    // second to go on saying exactly what they said before.
    setIcon(ctx.btnPlay, transport.playing ? 'pause' : 'play');
    setText(ctx.tcCurrent, timecode(t, projectFps()));
    setText(ctx.tcDuration, timecode(d, projectFps()));

    const f = d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
    const pct = (f * 100).toFixed(3) + '%';
    ctx.scrubPlayed.style.width = pct;
    ctx.scrubHead.style.left = pct;
    timeline.setPlayhead(t);

    const n = project.clips.length;
    const waiting = pending();
    const live = viewer.activeClips().length;
    // Beside "reading 12…" rather than anywhere new, because they are the same
    // kind of sentence: this line is where this application says what it is
    // doing that you did not ask about and have not been given yet.
    const busy = ctx.busyWord();
    setText(ctx.stats, n
        ? `${project.width}×${project.height}  ${n} clip${n === 1 ? '' : 's'}` +
          (live > 1 ? `  ${live} playing` : '') +
          (waiting ? `  reading ${waiting}…` : '') +
          (busy ? `  ${busy}…` : '')
        : '');
}

export function syncVolume() {
    const v = transport.muted ? 0 : transport.volume;
    const pct = (v * 100).toFixed(1) + '%';
    ctx.volFill.style.width = pct;
    ctx.volHead.style.left = pct;
    setIcon(ctx.btnMute, transport.muted ? 'muted' : 'volume');
    ctx.btnMute.classList.toggle('on', transport.muted);
}

export function setCropMode(on) {
    cropMode = on;
    document.body.classList.toggle('cropping', on);
    const btn = ctx.el('btn-crop');
    if (btn) btn.classList.toggle('on', on);
    updateCropUI();
    if (project.selected) showTransform(project.selected);
    ctx.flash(on ? 'Crop handles on' : 'Crop handles off');
}

export function initAppControls() {
    const {
        el, stage, cropbox, dropzone, scrub, volume,
        btnStart, btnPrev, btnPlay, btnNext, btnEnd, btnLoop, btnMute, btnFull, rateSel,
    } = ctx;

    setControlsEnabled(false);

    // Which clips hold a decoder. The two presses are the viewer's own, handed over
    // whole — `ui/residency.js` decides *when*, and deliberately knows nothing about
    // how an element is built or what it costs to place one.
    initResidency({
        // Built *and put where the playhead is*, because the two are one act: a
        // decoder that arrived without a seek is a decoder at zero, and playback
        // reads one as a timecode. See `parkClip`.
        attach: (clip) => { viewer.attachClip(clip); parkClip(clip); },
        detach: (clip) => viewer.detachClip(clip),
    });

    initTransport({
        changed: () => syncUI(),
        // Keeping the playhead in view is the timeline's business, and it only
        // redraws when the window it is showing actually moved.
        reveal: (t) => { if (timeline.revealTime(t)) timeline.draw(); },
    });

    btnPlay.addEventListener('click', togglePlay);
    btnStart.addEventListener('click', () => setPlayhead(0));
    btnEnd.addEventListener('click', () => setPlayhead(Math.max(0, duration() - 1e-4)));
    btnPrev.addEventListener('click', () => step(-1));
    btnNext.addEventListener('click', () => step(1));

    btnLoop.addEventListener('click', () => {
        transport.loop = !transport.loop;
        btnLoop.classList.toggle('on', transport.loop);
        ctx.flash(transport.loop ? 'Loop on' : 'Loop off');
    });

    btnMute.addEventListener('click', () => {
        transport.muted = !transport.muted;
        applyAudioAll();
        syncVolume();
        ctx.flash(transport.muted ? 'Muted' : 'Unmuted');
    });

    rateSel.addEventListener('change', () => {
        transport.rate = parseFloat(rateSel.value);
        applyAudioAll();
        ctx.flash(rateSel.value + '×');
    });

    btnFull.addEventListener('click', toggleFullscreen);

    draggable(scrub, (f, press, release) => {
        const t = f * duration();
        if (release) {
            ctx.finalSeek(t);
        } else if (press) {
            setPlayhead(t);
        } else {
            ctx.scheduleSeek(t);
        }
    }, { scrubs: true });
    draggable(volume, (f) => {
        transport.volume = f;
        if (f > 0 && transport.muted) transport.muted = false;
        applyAudioAll();
        syncVolume();
    });

    // ── the viewer: pan, zoom and crop the picture ─────────────────────────────

    stage.addEventListener('wheel', (e) => {
        const r = stage.getBoundingClientRect();
        const hit = viewer.clipAtPoint(e.clientX - r.left, e.clientY - r.top);
        const c = hit || project.selected;
        if (!c) return;
        const f = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        // Scaling the whole selection at once is the useful version when a grid of
        // twelve wants pushing in together — but only when the pointer is over one
        // of them, so a stray wheel on the background changes nothing.
        const list = hit && isSelected(hit) ? subjects() : [c];
        for (const k of list) k.xform.zoom = Math.max(0.05, Math.min(20, k.xform.zoom * f));
        viewer.refreshAll();
        updateCropUI();
        showTransform(project.selected || c);
        e.preventDefault();
    });

    // Dragging the picture pans it. In crop mode the same gesture on a handle
    // trims an edge instead, which is why the handles sit above this.
    {
        let pan = null;
        stage.addEventListener('mousedown', (e) => {
            if (cropMode) return;
            // Clicking a picture picks it. With several clips on screen — a stack
            // or a grid — "the selected one" and "the one you are pointing at"
            // have to be the same thing or panning moves the wrong picture.
            const r = stage.getBoundingClientRect();
            const hit = viewer.clipAtPoint(e.clientX - r.left, e.clientY - r.top);
            if (hit) select(hit, (e.ctrlKey || e.metaKey || e.shiftKey) ? 'add' : 'set');
            const c = project.selected;
            if (!c) return;
            pan = { x: e.clientX, y: e.clientY, px: c.xform.panX, py: c.xform.panY, clip: c };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!pan) return;
            const s = viewer.stageSize();
            // In a grid the pan is a fraction of the cell, not of the canvas, so
            // the picture keeps up with the pointer in a small cell too.
            const p = viewer.placement(pan.clip, s.w, s.h);
            const bw = p.cell ? p.cell.w : s.w, bh = p.cell ? p.cell.h : s.h;
            // Only the picture under the pointer moves, even with several clips
            // selected: a drag is aimed at a thing on screen, and sliding the other
            // three by the same amount is never what it meant.
            pan.clip.xform.panX = pan.px + (e.clientX - pan.x) / Math.max(1, bw);
            pan.clip.xform.panY = pan.py + (e.clientY - pan.y) / Math.max(1, bh);
            viewer.refresh(pan.clip);
            updateCropUI();
        });
        document.addEventListener('mouseup', () => {
            if (pan) showTransform(project.selected);
            pan = null;
        });
    }

    // Crop handles. Each edge maps a pixel drag back to a fraction of the placed
    // picture, so a handle stays under the pointer whatever the zoom is.
    {
        let grab = null;
        for (const h of cropbox.querySelectorAll('.ch')) {
            h.addEventListener('mousedown', (e) => {
                const c = project.selected;
                if (!c) return;
                const s = viewer.stageSize();
                grab = {
                    clip: c, edge: h.getAttribute('data-h'),
                    x: e.clientX, y: e.clientY,
                    crop: Object.assign({}, c.xform.crop),
                    place: viewer.placement(c, s.w, s.h),
                };
                e.preventDefault();
                e.stopPropagation();
            });
        }
        document.addEventListener('mousemove', (e) => {
            if (!grab) return;
            const dx = (e.clientX - grab.x) / Math.max(1, grab.place.w);
            const dy = (e.clientY - grab.y) / Math.max(1, grab.place.h);
            const c = grab.clip.xform.crop;
            const o = grab.crop;
            const lim = 0.98;
            if (grab.edge === 'move') {
                const mx = Math.max(-o.l, Math.min(o.r, dx));
                const my = Math.max(-o.t, Math.min(o.b, dy));
                c.l = o.l + mx; c.r = o.r - mx;
                c.t = o.t + my; c.b = o.b - my;
            } else {
                if (grab.edge.indexOf('w') >= 0) c.l = Math.max(0, Math.min(lim - o.r, o.l + dx));
                if (grab.edge.indexOf('e') >= 0) c.r = Math.max(0, Math.min(lim - o.l, o.r - dx));
                if (grab.edge.indexOf('n') >= 0) c.t = Math.max(0, Math.min(lim - o.b, o.t + dy));
                if (grab.edge.indexOf('s') >= 0) c.b = Math.max(0, Math.min(lim - o.t, o.b - dy));
            }
            viewer.refresh(grab.clip);
            updateCropUI();
            showTransform(grab.clip);
        });
        document.addEventListener('mouseup', () => { grab = null; });
    }

    // ── keyboard ───────────────────────────────────────────────────────────────

    document.addEventListener('keydown', (e) => {
        const tag = e.target && e.target.tagName;
        const active = document.activeElement;
        const activeTag = active && active.tagName;
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' ||
            activeTag === 'SELECT' || activeTag === 'INPUT' || activeTag === 'TEXTAREA' ||
            (active && active.isContentEditable)) return;

        // Along the chain, wherever you are.
        if (e.key === '[' || e.key === ']') {
            shell.step(e.key === ']' ? 1 : -1);
            e.preventDefault();
            return;
        }
        // Number keys 1-6 switch stages globally.
        if (['1', '2', '3', '4', '5', '6'].includes(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const idx = parseInt(e.key, 10) - 1;
            const stList = shell.stages();
            if (stList[idx]) {
                shell.goTo(stList[idx]);
                e.preventDefault();
                return;
            }
        }
        // The document, from every stage.
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            ctx.saveDocument(e.shiftKey);
            e.preventDefault();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
            ctx.openDocument();
            e.preventDefault();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
            ctx.newDocument();
            e.preventDefault();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
            ctx.stepHistory(!e.shiftKey);
            e.preventDefault();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
            ctx.stepHistory(false);
            e.preventDefault();
            return;
        }
        // The report drawer is reachable from every stage.
        if (e.key === 'r' || e.key === 'R') {
            report.setOpen(!report.isOpen());
            e.preventDefault();
            return;
        }

        // Graph stage gets first option to handle node-level keyboard events.
        if (shell.currentStage() === 'graph') {
            if (graphKey(e)) { e.preventDefault(); return; }
        }

        // Exporter (Encode stage) has its own preview player keyboard controls.
        if (exporter.isOpen()) {
            if (e.key === ' ') { exporter.togglePreviewPlay(); e.preventDefault(); return; }
            if (e.key === 'ArrowLeft') { exporter.stepPreviewBy(-1); e.preventDefault(); return; }
            if (e.key === 'ArrowRight') { exporter.stepPreviewBy(1); e.preventDefault(); return; }
        }

        // Letter-based stage navigation shortcuts (when plain keys pressed).
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.key === 'e') { shell.goTo('encode'); e.preventDefault(); return; }
            if (e.key === 'i') { shell.goTo('sources'); e.preventDefault(); return; }
            if (e.key === 'd') { shell.goTo('capture'); e.preventDefault(); return; }
            if (e.key === 'n') { shell.goTo('graph'); e.preventDefault(); return; }
        }

        // Global transport & stage-local shortcuts
        switch (e.key) {
            // Transport controls (global across stages)
            case ' ':          togglePlay(); break;
            case 'ArrowLeft':  if (e.shiftKey) setPlayhead(transport.t - 1); else step(-1); break;
            case 'ArrowRight': if (e.shiftKey) setPlayhead(transport.t + 1); else step(1); break;
            case 'Home':       setPlayhead(0); break;
            case 'End':        setPlayhead(Math.max(0, duration() - 1e-4)); break;
            case 'j':          nudgeRate(-1); break;
            case 'k':          pause(); break;
            case 'l':          nudgeRate(1); break;
            case 'm':          btnMute.click(); break;

            // Stage-local hotkeys (Compose stage only)
            case 'f':          if (shell.currentStage() === 'compose') toggleFullscreen(); else return; break;
            case 'c':          if (shell.currentStage() === 'compose') setCropMode(!cropMode); else return; break;
            case 's':          if (shell.currentStage() === 'compose') splitAtPlayhead(); else return; break;
            case 'g':          if (shell.currentStage() === 'compose') setLayout(project.layout === 'grid' ? 'stack' : 'grid'); else return; break;
            case 'o':          if (shell.currentStage() === 'compose') ctx.setOutputPreview(!output.isOn()); else return; break;
            case 't':          if (shell.currentStage() === 'compose') ctx.setSoftCues(!softcues.isOn()); else return; break;
            // What a drag on a clip means. The letters are the ones every editor
            // uses for these four, which is worth more than any letter this
            // application could pick on its own.
            // The finder, on the key every list of things has used for a search box
            // since before this application existed. Silently nothing when there is
            // no corpus, because the absence of one is the ordinary case and not a
            // condition worth a message.
            case '/':          if (shell.currentStage() === 'compose') find.setOn(!find.isOn()); else return; break;
            case 'v':          if (shell.currentStage() === 'compose') timeline.setEditMode('select'); else return; break;
            case 'b':          if (shell.currentStage() === 'compose') timeline.setEditMode('ripple'); else return; break;
            case 'y':          if (shell.currentStage() === 'compose') timeline.setEditMode('slip'); else return; break;
            case 'x':          if (shell.currentStage() === 'compose') timeline.setEditMode('rate'); else return; break;
            case 'a':          if ((e.ctrlKey || e.metaKey) && shell.currentStage() === 'compose') selectMany(project.clips.slice());
                               else return;
                               break;
            case 'Delete':     if (shell.currentStage() === 'compose') removeSelection(); else return; break;
            case '+': case '=': if (shell.currentStage() === 'compose') timeline.zoomBy(1 / 1.5, transport.t); else return; break;
            case '-':          if (shell.currentStage() === 'compose') timeline.zoomBy(1.5, transport.t); else return; break;
            case '0':          if (shell.currentStage() === 'compose') timeline.fitView(); else return; break;
            case 'Escape':     if (cropMode) setCropMode(false);
                               else if (project.selection.length > 1) select(project.selected);
                               else if (fullscreen) toggleFullscreen();
                               else if (shell.currentStage() !== 'compose') shell.goTo('compose');
                               else return;
                               break;
            default: return;
        }
        e.preventDefault();
    });

    // ── drag and drop ──────────────────────────────────────────────────────────

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!project.clips.length) dropzone.classList.add('over');
    });
    document.addEventListener('dragleave', () => dropzone.classList.remove('over'));
    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        openBatch(Array.from(files, (f) => f.path || f.name));
    });

    requestAnimationFrame(frame);
    syncVolume();

    el('btn-zoom-in').addEventListener('click', () => timeline.zoomBy(1 / 1.5, transport.t));
    el('btn-zoom-out').addEventListener('click', () => timeline.zoomBy(1.5, transport.t));
    el('btn-zoom-fit').addEventListener('click', () => timeline.fitView());
    for (const b of document.querySelectorAll('[data-edit-mode]'))
        b.addEventListener('click', () => timeline.setEditMode(b.dataset.editMode));

    el('btn-split').addEventListener('click', splitAtPlayhead);
    el('btn-crop').addEventListener('click', () => setCropMode(!cropMode));
    el('btn-grid').addEventListener('click',
        () => setLayout(project.layout === 'grid' ? 'stack' : 'grid'));
    el('btn-output').addEventListener('click', () => ctx.setOutputPreview(!output.isOn()));
    el('btn-cues').addEventListener('click', () => ctx.setSoftCues(!softcues.isOn()));
    el('btn-export').addEventListener('click', () => shell.goTo('encode'));

    // ── the generator picker ───────────────────────────────────────────────────
    //
    // **The list is libavfilter's**, filtered to the sources that write a picture —
    // see `pictureSources()`. Filled in once at startup, because the registry does
    // not change while the process is running, and it is the same walk the Graph
    // stage's palette does.
    //
    // A `<select>` rather than a button and a dialog: the choice *is* which filter,
    // there is nothing else to ask (the length is `GENERATOR_SECONDS` and the
    // arguments are the canvas's), and a dialog in front of a colour card would be a
    // question with no information in it. It falls back to its own first entry after
    // every pick so that picking the same one twice lays out two.
    const btnAddGen = el('btn-add-gen');
    if (btnAddGen) {
        let popover = null;
        const closePopover = () => {
            if (popover && popover.parentNode) {
                popover.parentNode.removeChild(popover);
            }
            popover = null;
        };

        btnAddGen.addEventListener('click', (e) => {
            e.stopPropagation();
            if (popover) {
                closePopover();
                return;
            }
            const gens = generators.pictureSources();
            if (!gens.length) return;

            popover = document.createElement('div');
            popover.className = 'gen-popover';

            for (const f of gens) {
                const item = document.createElement('div');
                item.className = 'gen-popover-item';

                const nameEl = document.createElement('span');
                nameEl.className = 'gen-popover-name';
                nameEl.textContent = f.name;

                item.appendChild(nameEl);

                if (f.description) {
                    const descEl = document.createElement('span');
                    descEl.className = 'gen-popover-desc';
                    descEl.textContent = f.description;
                    item.appendChild(descEl);
                }

                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    addGenerator(f.name);
                    closePopover();
                });
                popover.appendChild(item);
            }

            const parent = btnAddGen.parentNode || document.body;
            parent.appendChild(popover);

            const onOutsideClick = (ev) => {
                if (popover && !popover.contains(ev.target) && ev.target !== btnAddGen) {
                    closePopover();
                    document.removeEventListener('click', onOutsideClick);
                }
            };
            setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
        });
    }
}
