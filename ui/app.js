// ffmpeg-bro — the editing surface.
//
// Everything here drives plain <video> elements. There is no subprocess, no
// pipe and no proxy file: libavcodec is linked into this binary and registered
// as a bro media backend, so the engine decodes the real streams and hands the
// frames straight to the renderer. That is why the transport can be
// frame-accurate, why seeking is instant, and why several clips can sit on one
// timeline without any of them being transcoded first.

import { project, makeClip, addClip, removeClip, duration, clipsAt,
         nextClipAfter, sourceTime, resolveOverlaps, onChange, changed, select,
         selectMany, selectFollow, isSelected, splitClip, trackCount,
         applyInput, clipsOf } from './project.js';
import * as inputsModel from './inputs.js';
import * as assemble from './sequence.js';
import { analyzeClip, pending } from './analysis.js';
import * as viewer from './viewer.js';
import * as timeline from './timeline.js';
import * as exporter from './export.js';
import { initInspector, showProperties, showTransform, subjects } from './inspector.js';
import { clock, timecode, basename, bytes } from './format.js';
import { paintIcons, setIcon } from './icons.js';
import { filtergraph, renderGraph } from './filtergraph.js';
import { makeGraph, restore } from './graph/model.js';
import { derive } from './graph/derive.js';
import { print } from './graph/print.js';
import { layout, portY } from './graph/layout.js';
import { problems } from './graph/check.js';
import { padsOf } from './graph/filters.js';
import { socketAt } from './graph/canvas.js';
import { initGraphView, drawGraph, chaseGraph, graphSummary, graphPlacement,
         outrankedControls, tickGraph, graphKey } from './graph/view.js';
import * as graphPreview from './graph/preview.js';
import { previewGraph } from './graph/subgraph.js';
import * as graphOverlay from './graph/overlay.js';
import * as shell from './shell.js';
import * as capture from './capture.js';
import { initSources, drawSources } from './sources.js';
import { transport, initTransport, setPlayhead, play, pause, togglePlay, step,
         applyAudio, applyAudioAll, tick as tickTransport } from './transport.js';
import * as command from './command.js';
import * as report from './report.js';

const el = (id) => document.getElementById(id);

const viewerEl = el('viewer');
const stage    = el('stage');
const dropzone = el('dropzone');
const osd      = el('osd');
const filename = el('filename');
const chips    = el('chips');
const xformPanel = el('transform');
const stats    = el('stats');

const tcCurrent  = el('tc-current');
const tcDuration = el('tc-duration');
const scrub      = el('scrub');
const scrubPlayed = el('scrub-played');
const scrubHead   = el('scrub-head');

const btnStart = el('btn-start');
const btnPrev  = el('btn-prev');
const btnPlay  = el('btn-play');
const btnNext  = el('btn-next');
const btnEnd   = el('btn-end');
const btnLoop  = el('btn-loop');
const btnMute  = el('btn-mute');
const btnFull  = el('btn-full');
const rateSel  = el('rate');
const volume   = el('volume');
const volFill  = el('vol-fill');
const volHead  = el('vol-head');

paintIcons();

const cropbox = el('cropbox');

// ── state ──────────────────────────────────────────────────────────────────

let fullscreen = false;
let cropMode = false;
let osdTimer = 0;

el('libav').textContent = bro.ffmpeg.version;

viewer.initViewer({ stage, viewer: viewerEl });

initSources({
    list: el('src-list'),
    detail: el('src-detail'),
    options: el('src-options'),
    add: el('src-add'),
    addPath: el('src-path'),
    join: el('src-join'),
}, {
    flash,
    // An input that was reopened with a different demuxer, option or window is
    // a different input under whatever is cut from it, so the clips have to be
    // reloaded rather than left decoding the file as it was.
    reopened: reloadInput,
    // "Use on the timeline" is an action *from* this stage, because an input
    // with no clip is an ordinary thing to have and the timeline is not where
    // inputs come from any more.
    use: (input) => {
        const clip = openInput(input);
        if (clip) { shell.goTo('compose'); flash(`Added ${clip.name}`); }
        return clip;
    },
    clipsOf,
    changed: () => { changed('inputs'); },
});

capture.initCapture({
    list: el('cap-list'),
    settings: el('cap-settings'),
    preview: el('cap-preview'),
    marquee: el('cap-marquee'),
    bar: el('cap-bar'),
    note: el('cap-note'),
    options: el('cap-options'),
}, {
    flash,
    // A recording is a file, and the arrow from Capture to Sources is followed
    // by opening it: the fastest way to see what you just recorded is to be
    // standing on the edit with it in front of you.
    open: (path) => { shell.goTo('compose'); open(path); },
    // What is set on this stage changes the two things that state it — the
    // spine's card, and the command underneath, which prints the capture as
    // the capture rather than the render.
    changed: () => { shell.drawSpine(); command.draw(); },
});
capture.initRegionDrag(el('cap-preview'), el('cap-marquee'));

// What was inserted and locked last time, before anything asks for a graph.
graphOverlay.restore();

initGraphView({
    viewport: el('gr-viewport'),
    canvas: el('gr-wires'),
    nodes: el('gr-nodes'),
    note: el('gr-note'),
    status: el('gr-status'),
    panel: el('gr-panel'),
    mini: el('gr-mini'),
    fit: el('gr-fit'),
    previews: el('gr-previews'),
    atPlayhead: el('gr-at-playhead'),
    relayout: el('gr-relayout'),
    add: el('gr-add'),
    zoomIn: el('gr-zoom-in'),
    zoomOut: el('gr-zoom-out'),
    zoomLabel: el('gr-zoom'),
}, {
    // A node preview is the least important render in the application, so it
    // waits for anything that wants the host's one job slot.
    busy: () => !exporter.canLeave() || exporter.isOpen(),
    playhead: () => transport.t,
    // A filter inserted or a value locked changes what will be rendered, so it
    // changes the three things that state that: the spine's cards, the command
    // underneath them, and the properties panel, whose controls may just have
    // stopped applying. The picture too — not because it can show a filter, but
    // because it has to say that it cannot.
    changed: () => {
        shell.drawSpine();
        command.draw();
        showProperties();
        viewer.refreshAll();
    },
});

initInspector({ filename, chips, transform: xformPanel }, {
    // The panel edits the model; putting the picture and the timeline back in
    // step with it is the application's job, not the panel's.
    edited: () => { viewer.refreshAll(); updateCropUI(); changed('edit'); },
    moved: () => { setPlayhead(transport.t); changed('moved'); },
    canvasResized: () => { viewer.layout(); updateCropUI(); syncUI(); },
    audioChanged: () => { applyAudioAll(); timeline.draw(); },
    setLayout: (mode) => setLayout(mode),
    redraw: () => { viewer.refreshAll(); updateCropUI(); timeline.draw(); },
    cropHandlesOn: () => cropMode,
    toggleCropHandles: () => setCropMode(!cropMode),
    // Which of the panel's controls a lock on the graph has taken over. Asked
    // rather than pushed, because it is a function of the edit and the overlay
    // together and both move.
    outranked: outrankedControls,
});
timeline.initTimeline({
    timeline: el('timeline'),
    ruler: el('ruler'), tracks: el('tracks'), wave: el('wave'),
    laneAudio: el('lane-audio'),
    playhead: el('playhead'),
    scrollTrack: el('tl-scroll'), scrollThumb: el('tl-thumb'),
    zoomLabel: el('tl-zoom'),
    playheadTime: () => transport.t,
    onSeek: (t, press, release) => {
        if (release) { if (resumeAfterScrub) { resumeAfterScrub = false; play(); } return; }
        if (press && transport.playing) { resumeAfterScrub = true; pause(); }
        setPlayhead(t);
    },
});

exporter.initExport({
    settings: el('ex-settings'),
    advanced: el('ex-advanced'),
    dest: el('ex-dest'),
    streams: el('ex-streams'),
    write: el('ex-write'),
    intentList: el('ex-intent-list'),
    intentCustom: el('ex-intent-custom'),
    strip: el('ex-strip'),
    summary: el('ex-summary'),
    warnings: el('ex-warnings'),
    progress: el('ex-progress'),
    cancel: el('ex-cancel'),
    go: el('ex-go'),
}, {
    pause,
    flash,
    workspace: syncWorkspace,
    // "Back" from Write is a step along the chain, not a door out of a dialog.
    leave: () => shell.goTo('encode'),
    // Anything that changes what will be written changes the two things that
    // state it: the spine's cards and the command underneath them.
    described: () => { shell.drawSpine(); command.draw(); },
    // The preview starts where you were looking, which is nearly always the
    // part of the render worth checking.
    playhead: () => transport.t,
    // Putting the result back on the timeline is a move along the chain as
    // well as an import: the fastest way to see what you just made is to be
    // standing on the edit with it in front of you.
    open: (path) => { shell.goTo('compose'); open(path); },
    finished: (p) => {
        if (p.state === 'done') flash(`Exported ${basename(p.path)}`);
        else if (p.state === 'cancelled') flash('Export stopped');
        else if (p.state === 'failed') flash(`Export failed: ${p.error}`);
    },
});

let resumeAfterScrub = false;

onChange((what) => {
    // Nodes pinned to a clip that is no longer open. Here rather than in each
    // place a clip can go away — delete, a batch drop that clears the timeline,
    // a project reset — because there are several and the one that is missed is
    // the one that grows the stored overlay forever.
    // ...and a source node naming an input that has been taken off the Sources
    // stage. The inputs are passed as well as the clips because the graph can
    // now read a file no clip is cut from, which is exactly the file nothing
    // else in this call would have noticed going away.
    graphOverlay.retain(project.clips.map((c) => c.id),
                        inputsModel.inputs.map((i) => i.id));
    if (what === 'selection' || what === 'move' || what === 'moved') {
        showProperties();
        // The selection ring lives on the picture, so a change of selection is
        // a change to the stage as well as to the panel.
        if (what === 'selection') viewer.refreshAll();
        else setPlayhead(transport.t);
    }
    timeline.draw();
    syncUI();
    // The spine states the whole render and the command states it exactly, so
    // both are downstream of every change to the model — not just the ones
    // made on the encode side. Here rather than in syncUI() because that runs
    // from the frame loop, and rebuilding a spec sixty times a second to
    // discover it has not changed is work for nothing. The Sources stage is
    // downstream of the same thing: which files are on the timeline.
    shell.drawSpine();
    command.draw();
    drawSources();
    // And so is the graph, which is the same statement as the command bar's
    // drawn as the shape it is. Only while it is up: everything the layout
    // measures is zero behind a `display:none`, and it is rebuilt on the way
    // in anyway.
    if (shell.currentStage() === 'graph') drawGraph();
});

// A file named on the command line, handed over by the host binding.
if (bro.ffmpeg.openOnStart) open(bro.ffmpeg.openOnStart);

// ── opening ────────────────────────────────────────────────────────────────

/// Open a path or a URL: an input if there is not already a plain one on it,
/// and then a clip of that input.
///
/// The two are separate acts and this is the one that does both, because
/// dropping a file on the timeline means both. `openInput()` below is the other
/// half on its own — an input that exists without a clip, which is an ordinary
/// state and the reason the Sources stage is not derived from the timeline any
/// more.
function open(path, opts = {}) {
    // Through the same rules a drop goes through: `shot_%04d.png` is a
    // sequence and a lone picture is a still, whether it arrived on a drop, on
    // the command line or typed into the Sources stage. One path that decided
    // it per entry point would be three answers to what a `.png` is.
    return openSpec(assemble.typedSpec(path), opts);
}

/// The same, given the whole `-i` rather than only a path.
///
/// A drop of three hundred numbered PNGs is one input carrying `-f image2
/// -framerate 25 -start_number 1`, and a single picture is one carrying
/// `-loop 1 -t 5` — see ui/sequence.js, which decides which. The reuse rule is
/// unchanged and is the reason this takes a spec rather than setting the
/// options afterwards: `plainInputFor` matches only an input nothing has been
/// said about, so an assembled one is never silently shared with a second drop.
function openSpec(spec, opts = {}) {
    const existing = spec.format || Object.keys(spec.options || {}).length
                         ? null
                         : inputsModel.plainInputFor(spec.path);
    const input = existing || inputsModel.addInput(spec);
    const clip = openInput(input, opts);
    // An input that was made here and turned out to be unusable goes away
    // again; one that was already on the list stays, because somebody put it
    // there.
    if (!clip && !existing) inputsModel.removeInput(input);
    return clip;
}

/// A clip of an input already on the list. Everything `open()` does past
/// deciding which input that is.
function openInput(input, opts = {}) {
    if (input.error || !input.probe) {
        flash(input.error || `cannot read ${input.name}`);
        return null;
    }
    const probe = input.probe;
    if (!probe.video) {
        // bro's <video> drives its clock from decoded pictures, so a track
        // list with no video has nothing to advance. Say so instead of
        // loading something that will sit at 0:00 forever.
        flash(probe.audio ? 'audio-only files are not playable yet — this needs a video track'
                          : 'no audio or video track in this file');
        return null;
    }

    // An input with no length cannot be laid out, and there are two ways to
    // have one. A single picture *is* no time at all: libavformat says so, and
    // bro's `<video>` agrees, since it drives its clock from decoded pictures
    // and one picture is nothing to advance through. An endless input — a
    // `-loop` or a `-stream_loop` — is the other way round and has no length
    // for the opposite reason. Both are said plainly, and both are fixed in the
    // one place the number belongs, which is the input's own window.
    // There are three ways for an input to have no length, and this is where
    // they are told apart, because the answer to each is somewhere different.
    // A single picture *is* no time at all: libavformat says so, and bro's
    // `<video>` agrees, since it drives its clock from decoded pictures and one
    // picture is nothing to advance through. An endless input — a `-loop` or a
    // `-stream_loop` — is the other way round and is fixed on the input's own
    // window. And a **live device** has no length that a number could give it:
    // nothing has happened yet, so there is nothing to cut. Its answer is not
    // "set -to", it is "record it, and then this is a file".
    if (inputsModel.lengthOf(input) <= 0) {
        flash(inputsModel.kindOf(input) === 'device'
                  ? `${input.name} is a live device — it has no end, so there is nothing to ` +
                    'lay out. Record it on the Capture stage and the recording is a file.'
              : inputsModel.endless(input)
                  ? `${input.name} never ends — set -to on the Sources stage to say how ` +
                    'long it is'
                  : `${input.name} is one picture and no time at all — Sources ▸ Still ` +
                    'holds it for a chosen length');
        return null;
    }

    // New clips land after everything already on their track, which is what
    // dropping a second file onto a player is asking for. `track` puts one on
    // a lane of its own instead — that is how a batch becomes a grid.
    const clip = makeClip(input);
    if (opts.track !== undefined) clip.track = opts.track;
    addClip(clip);
    viewer.attachClip(clip);
    analyzeClip(clip);
    select(clip, 'auto');

    dropzone.classList.add('hidden');
    setControlsEnabled(true);
    viewer.layout();
    if (!opts.quiet) {
        timeline.fitView();
        setPlayhead(project.clips.length === 1 ? 0 : clip.start);
        showProperties();
        changed('open');
    }
    return clip;
}

/// An input has been reopened — a demuxer forced, an option set, a window
/// moved — so everything downstream of what it contains is put back.
///
/// The `<video>` is rebuilt rather than re-pointed: the element *is* the
/// decoder, and a decoder holding the file as it was opened before is exactly
/// what has just stopped being true.
function reloadInput(input) {
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
function openBatch(paths) {
    // What was dropped is files; what is opened is inputs, and the two are not
    // the same count. Three hundred numbered PNGs are one input, so the rule
    // about a batch becoming a grid has to be counted after the grouping and
    // not before it — dropping a folder of frames is one clip, and it would
    // otherwise be three hundred tracks.
    const items = assemble.openables(paths);
    if (items.length === 1) return [openSpec(items[0].spec)];
    const grid = items.length >= 3;
    // Stack the batch above whatever is already there, or start at V1 when the
    // timeline is empty — `trackCount()` counts the spare lane, which is not a
    // track anything lives on yet.
    const base = grid ? (project.clips.length ? trackCount() - 1 : 0) : 0;
    const made = [];
    for (const item of items) {
        const clip = openSpec(item.spec,
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
    flash(`Opened ${made.length} clips` + (grid ? ' as a grid' : ''));
    return made;
}

function removeSelection() {
    const doomed = project.selection.slice();
    if (!doomed.length) return;
    for (const clip of doomed) {
        viewer.detachClip(clip);
        removeClip(clip);
    }
    if (!project.clips.length) {
        dropzone.classList.remove('hidden');
        setControlsEnabled(false);
        project.width = project.height = 0;
        project.layout = 'stack';
    }
    timeline.fitView();
    setPlayhead(Math.min(transport.t, duration()));
    showProperties();
    changed('remove');
    flash(doomed.length === 1 ? 'Removed ' + doomed[0].name : `Removed ${doomed.length} clips`);
}

/// Split every selected clip the playhead is inside. Splitting the selection
/// rather than "the clip under the playhead" is what makes it work on a stack:
/// one keypress can cut through four tracks at the same instant, or through
/// exactly the one you picked.
function splitAtPlayhead() {
    const t = transport.t;
    const targets = (project.selection.length ? project.selection : clipsAt(t))
        .filter((c) => t > c.start + 1e-3 && t < c.start + c.length - 1e-3);
    if (!targets.length) { flash('Nothing to split here'); return; }
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
    flash(halves.length === 1 ? 'Split' : `Split ${halves.length} clips`);
}

function setLayout(mode) {
    if (project.layout === mode) return;
    project.layout = mode;
    el('btn-grid').classList.toggle('on', mode === 'grid');
    viewer.refreshAll();
    updateCropUI();
    showProperties();
    flash(mode === 'grid' ? 'Grid layout' : 'Stacked layout');
}

// ── transport ──────────────────────────────────────────────────────────────
//
// The playhead itself is ui/transport.js — what moves, what is chased and what
// is adopted from a decoder. What is here is the strip of controls that drives
// it, and the readouts it drives back.

function setControlsEnabled(on) {
    for (const b of [btnStart, btnPrev, btnPlay, btnNext, btnEnd, btnLoop, btnMute])
        b.disabled = !on;
    rateSel.disabled = !on;
}
setControlsEnabled(false);

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
    flash(transport.loop ? 'Loop on' : 'Loop off');
});

btnMute.addEventListener('click', () => {
    transport.muted = !transport.muted;
    applyAudioAll();
    syncVolume();
    flash(transport.muted ? 'Muted' : 'Unmuted');
});

rateSel.addEventListener('change', () => {
    transport.rate = parseFloat(rateSel.value);
    applyAudioAll();
    flash(rateSel.value + '×');
});

btnFull.addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
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

    surface.addEventListener('mousedown', (e) => {
        dragging = true;
        // Dragging a playhead stops playback, the way every edit suite does.
        // It is also what keeps a drag cheap: while paused, a seek costs one
        // decode instead of also tearing down and refilling the audio ring.
        if (scrubs && transport.playing) { resume = true; pause(); }
        onFraction(fractionAt(e.clientX));
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => { if (dragging) onFraction(fractionAt(e.clientX)); });
    document.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        onFraction(fractionAt(e.clientX));
        if (resume) { resume = false; play(); }
    });
}

draggable(scrub, (f) => setPlayhead(f * duration()), { scrubs: true });
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

function updateCropUI() {
    const c = project.selected;
    if (!cropMode || !c || !c.frame) { cropbox.classList.add('hidden'); return; }
    const s = viewer.stageSize();
    const p = viewer.placement(c, s.w, s.h);
    const cr = c.xform.crop;
    cropbox.classList.remove('hidden');
    cropbox.style.left = (p.x + p.w * cr.l).toFixed(1) + 'px';
    cropbox.style.top = (p.y + p.h * cr.t).toFixed(1) + 'px';
    cropbox.style.width = Math.max(2, p.w * (1 - cr.l - cr.r)).toFixed(1) + 'px';
    cropbox.style.height = Math.max(2, p.h * (1 - cr.t - cr.b)).toFixed(1) + 'px';
}

// ── keyboard ───────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Let form controls keep their own keys.
    const tag = e.target && e.target.tagName;
    if (tag === 'SELECT' || tag === 'INPUT') return;

    // Along the chain, wherever you are. The pipeline has an order and this
    // follows it, rather than cycling a list of tabs.
    if (e.key === '[' || e.key === ']') {
        shell.step(e.key === ']' ? 1 : -1);
        e.preventDefault();
        return;
    }
    // The report is under every stage, so it is reachable from every stage —
    // including the two that otherwise take the keyboard for themselves, which
    // are the two a render is started and watched from.
    if (e.key === 'r' || e.key === 'R') {
        report.setOpen(!report.isOpen());
        e.preventDefault();
        return;
    }
    if (shell.currentStage() === 'sources' || shell.currentStage() === 'capture') {
        if (e.key === 'Escape') { shell.goTo('compose'); e.preventDefault(); }
        return;
    }
    // The graph owns the keyboard while it is up, for the reason the encode
    // side does: Space must not start playback on a timeline nobody can see.
    // It is asked first and says whether it took the key, so that Escape clears
    // a selection when there is one and leaves the stage when there is not —
    // which is the order every editor uses and the only one that lets you both.
    if (shell.currentStage() === 'graph') {
        if (graphKey(e)) { e.preventDefault(); return; }
        if (e.key === 'Escape') { shell.goTo('compose'); e.preventDefault(); }
        return;
    }

    // The encode side owns the keyboard while it is the stage you are on:
    // Space must not start playback on a timeline nobody can see, and Delete
    // must not remove the clips being rendered. Escape is the way back.
    // ...except for the keys that mean the same thing there. Space plays the
    // comparison rather than the timeline, and the arrows step it.
    if (exporter.isOpen()) {
        if (e.key === 'Escape') { shell.goTo('compose'); e.preventDefault(); }
        else if (e.key === ' ') { exporter.togglePreviewPlay(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { exporter.stepPreviewBy(-1); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { exporter.stepPreviewBy(1); e.preventDefault(); }
        return;
    }

    switch (e.key) {
        case ' ':          togglePlay(); break;
        // Shift is a second of time, not a second's worth of frames: one seek
        // instead of `fps` of them, and it means the same thing.
        case 'ArrowLeft':  if (e.shiftKey) setPlayhead(transport.t - 1); else step(-1); break;
        case 'ArrowRight': if (e.shiftKey) setPlayhead(transport.t + 1); else step(1); break;
        case 'Home':       setPlayhead(0); break;
        case 'End':        setPlayhead(Math.max(0, duration() - 1e-4)); break;
        case 'j':          nudgeRate(-1); break;
        case 'k':          pause(); break;
        case 'l':          nudgeRate(1); break;
        case 'm':          btnMute.click(); break;
        case 'f':          toggleFullscreen(); break;
        case 'c':          setCropMode(!cropMode); break;
        case 's':          splitAtPlayhead(); break;
        case 'g':          setLayout(project.layout === 'grid' ? 'stack' : 'grid'); break;
        case 'e':          shell.goTo('encode'); break;
        case 'i':          shell.goTo('sources'); break;
        // `d` for device: `c` is the crop handles and `r` is the report.
        case 'd':          shell.goTo('capture'); break;
        // `n` for node graph: `g` is the grid layout and `f` is fullscreen.
        case 'n':          shell.goTo('graph'); break;
        case 'a':          if (e.ctrlKey || e.metaKey) selectMany(project.clips.slice());
                           else return;
                           break;
        case 'Delete':     removeSelection(); break;
        case '+': case '=': timeline.zoomBy(1 / 1.5, transport.t); break;
        case '-':          timeline.zoomBy(1.5, transport.t); break;
        case '0':          timeline.fitView(); break;
        case 'Escape':     if (cropMode) setCropMode(false);
                           else if (project.selection.length > 1) select(project.selected);
                           else if (fullscreen) toggleFullscreen(); break;
        default: return;
    }
    e.preventDefault();
});

// J/L shuttle: each press moves one step through the speed list, playing
// forward. (Reverse playback needs backwards decode, which is a later job.)
const RATES = [0.25, 0.5, 1, 1.5, 2, 4];
function nudgeRate(dir) {
    if (!project.clips.length) return;
    let i = RATES.indexOf(transport.rate);
    if (i < 0) i = RATES.indexOf(1);
    i = Math.max(0, Math.min(RATES.length - 1, i + dir));
    transport.rate = RATES[i];
    rateSel.value = String(RATES[i]);
    applyAudioAll();
    if (!transport.playing) play();
    flash(RATES[i] + '×');
}

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

// ── the frame loop ─────────────────────────────────────────────────────────

let lastTick = 0;
let lastViewerW = -1, lastViewerH = -1, lastLaneW = -1;

function frame(now) {
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;

    tickTransport(dt);

    // A panel that changed size (window resize, fullscreen) has to be redrawn
    // from the analysis rather than stretched — a stretched waveform lies
    // about where the sound is.
    //
    // A panel that is not on screen measures zero, which is not a size it ever
    // has to be laid out for: the Output workspace hides the edit, and
    // relaying everything out to nothing and back costs a full re-layout each
    // way for a picture nobody was looking at. Remembering the last real size
    // also means coming back only redraws if the window actually changed.
    if (viewerEl.clientWidth > 0 &&
        (viewerEl.clientWidth !== lastViewerW || viewerEl.clientHeight !== lastViewerH)) {
        lastViewerW = viewerEl.clientWidth;
        lastViewerH = viewerEl.clientHeight;
        viewer.layout();
        updateCropUI();
    }
    // Watch the video lanes, not the waveform: the waveform is in the markup
    // and laid out from the first frame, so it never notices a lane that was
    // built a moment ago and has not been measured yet.
    const laneW = timeline.laneWidthPx();
    if (laneW > 0 && laneW !== lastLaneW) {
        lastLaneW = laneW;
        timeline.draw();
    }
    if (transport.playing) syncUI();
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

    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── readouts ───────────────────────────────────────────────────────────────

function syncUI() {
    const t = transport.t;
    const d = duration();

    setIcon(btnPlay, transport.playing ? 'pause' : 'play');
    tcCurrent.textContent = timecode(t, project.fps);
    tcDuration.textContent = timecode(d, project.fps);

    const f = d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
    const pct = (f * 100).toFixed(3) + '%';
    scrubPlayed.style.width = pct;
    scrubHead.style.left = pct;
    timeline.setPlayhead(t);

    const n = project.clips.length;
    const waiting = pending();
    const live = viewer.activeClips().length;
    stats.textContent = n
        ? `${project.width}×${project.height}  ${n} clip${n === 1 ? '' : 's'}` +
          (live > 1 ? `  ${live} playing` : '') +
          (waiting ? `  reading ${waiting}…` : '')
        : '';
}

function syncVolume() {
    const v = transport.muted ? 0 : transport.volume;
    const pct = (v * 100).toFixed(1) + '%';
    volFill.style.width = pct;
    volHead.style.left = pct;
    setIcon(btnMute, transport.muted ? 'muted' : 'volume');
    btnMute.classList.toggle('on', transport.muted);
}
syncVolume();

function setCropMode(on) {
    cropMode = on;
    document.body.classList.toggle('cropping', on);
    updateCropUI();
    if (project.selected) showTransform(project.selected);
    flash(on ? 'Crop handles on' : 'Crop handles off');
}

// ── zoom controls ──────────────────────────────────────────────────────────

el('btn-zoom-in').addEventListener('click', () => timeline.zoomBy(1 / 1.5, transport.t));
el('btn-zoom-out').addEventListener('click', () => timeline.zoomBy(1.5, transport.t));
el('btn-zoom-fit').addEventListener('click', () => timeline.fitView());
el('btn-split').addEventListener('click', splitAtPlayhead);
el('btn-grid').addEventListener('click',
    () => setLayout(project.layout === 'grid' ? 'stack' : 'grid'));
el('btn-export').addEventListener('click', () => shell.goTo('encode'));

// ── the pipeline ───────────────────────────────────────────────────────────
//
// Four stages over one project, and the spine is both the map and the way
// through. Each card says what its stage is currently set to, so the bar reads
// as one statement of the whole render — which is the thing this application
// is for, and the reason the command runs underneath it rather than in a
// footnote on one screen.

shell.initShell({
    bar: el('spine'),
    views: {
        capture: el('st-capture'),
        sources: el('st-sources'),
        compose: el('st-compose'),
        graph: el('st-graph'),
        encode: el('st-encode'),
        write: el('st-write'),
    },
}, {
    flash,
    // A render holds the host's one job slot and Stop is the only way out of
    // one, so the door is refused with a reason rather than offered and then
    // found locked.
    blocked: (id) => {
        // A recording holds the one job slot, and that is deliberate rather
        // than a limitation to work around: a capture is the only job in this
        // application with a real-time deadline and it cannot be re-run, so it
        // gets the machine. The door is refused with the reason rather than
        // offered and then found locked.
        if (capture.isRecording() && id !== 'capture')
            return 'A recording is running — stop it first';
        if (!exporter.canLeave() && id !== 'write')
            return 'A render is running — stop it first';
        // A timeline with nothing on it is not necessarily a render with
        // nothing in it: a graph rooted in a generator produces pictures no
        // clip accounts for, which is what `range()` falls back to. Refused
        // only when neither has anything to say.
        if ((id === 'encode' || id === 'write') &&
            !project.clips.length && !exporter.range().length)
            return 'Nothing on the timeline to encode, and nothing in the graph either';
        return null;
    },
    changed: (id, leaving) => {
        if (id === 'encode' || id === 'write') exporter.prepare();
        else exporter.closeExport();
        if (id === 'compose') { viewer.layout(); timeline.draw(); }
        if (id === 'sources') drawSources();
        // The device is opened when you arrive and given back when you leave.
        // A camera held by a preview on a stage nobody is looking at is a
        // camera the recording — or another application — cannot open.
        if (id === 'capture') capture.arrive();
        else if (leaving === 'capture') capture.leave();
        // Every height the layout needs measures zero while the stage is
        // hidden, so the graph is built on the way in and not before. The
        // previews are taken from wherever the playhead is standing, snapshotted
        // now rather than followed: a playhead that moved would otherwise
        // re-render every node for a picture nobody asked to change.
        if (id === 'graph') {
            graphPreview.setRange(transport.t, transport.t + graphPreview.previewSeconds);
            drawGraph();
        }
        command.draw();
    },
    state: stageState,
    warnings: (id) => (id === 'encode' || id === 'write' ? exporter.currentWarnings() : null),
});

command.initCommand({
    bar: el('commandbar'),
    line: el('cmd-line'),
    toggle: el('cmd-toggle'),
    copy: el('cmd-copy'),
    flash,
});

// What came back, under every stage for the same reason the command is: the
// application's argument is that nothing about a render should be hidden, and
// half of that argument is about the half that has already happened.
report.initReport({
    bar: el('reportbar'),
    head: el('rep-head'),
    body: el('rep-body'),
    toggle: el('rep-toggle'),
});

/// The two lines under a stage's name: what it is set to, in the terms that
/// stage is about. Read from the model every time the spine is drawn, because
/// a bar that can disagree with the render is worse than one that is rebuilt.
function stageState(id) {
    const clips = project.clips;
    if (id === 'capture') return capture.summary();
    if (id === 'sources') {
        // The inputs, not the files on the timeline: an input with no clip is
        // an ordinary state and a card that only counted what was in use would
        // be the old timeline-derived list wearing the new name.
        const list = inputsModel.inputs;
        if (!list.length) return ['nothing loaded', ''];
        const streams = list.reduce(
            (n, i) => n + ((i.probe && i.probe.streams) ? i.probe.streams.length : 0), 0);
        const set = list.filter((i) => inputsModel.summary(i)).length;
        // An input the graph reads is in use even with no clip cut from it, so
        // it is not counted here — the card says which, and a spine that called
        // a watermark unused would be the same lie one line shorter.
        const read = new Set(graphOverlay.sourceInputs());
        const unused = list.filter((i) => !clipsOf(i).length && !read.has(i.id)).length;
        const tail = [set ? `${set} configured` : '', unused ? `${unused} unused` : '',
                      `${streams} streams`].filter(Boolean).join(' · ');
        return [`${list.length} input${list.length === 1 ? '' : 's'}`, tail];
    }
    if (id === 'compose') {
        if (!clips.length) return ['empty', ''];
        const v = trackCount();
        return [`${project.width}×${project.height} · ${(project.fps || 30).toFixed(0)}p`,
                `${v} V · ${clips.length} clip${clips.length === 1 ? '' : 's'} · ` +
                clock(duration())];
    }
    if (id === 'graph') {
        if (!clips.length) return ['—', ''];
        const g = graphSummary();
        if (!g.ok) return ['cannot be described', g.reason];
        // A graph that will not run is the one thing on this card worth saying
        // ahead of everything else: the render falls back to the compositor
        // without your filters, and the spine is where you look when you are on
        // some other stage entirely.
        if (g.problems && g.problems.length)
            return ['will not run', g.problems[0].reason];
        // What is yours is counted separately from what was derived, on the
        // card as well as on the stage: a lock that is silently in force is the
        // failure this whole milestone is designed against, and the spine is
        // where you look when you are not on the Graph stage.
        const mine = g.mine ? `${g.mine} yours` : '';
        const locks = g.locks ? `${g.locks} locked` : '';
        const extra = [mine, locks].filter(Boolean).join(' · ');
        return [`${g.nodes} filter${g.nodes === 1 ? '' : 's'}`,
                extra || `${g.inputs} in · ${g.chains} chain${g.chains === 1 ? '' : 's'}`];
    }
    if (!clips.length) return ['—', ''];
    const s = exporter.currentSettings();
    if (id === 'encode') {
        const rate = s.rate === 'quality' ? `q ${s.quality}`
                   : s.rate === 'lossless' ? 'lossless'
                   : `${s.videoBitrate}k`;
        return [s.videoCodec || '—', `${rate}${s.preset ? ' · ' + s.preset : ''}`];
    }
    // Write is the stream list now, so the card counts it: "mp4 · 3 streams"
    // is the statement of that stage, and a file that gained a commentary
    // track has to say so from the bar rather than only from the stage.
    const p = exporter.lastStatus();
    const size = p && p.state === 'done' && p.bytes ? bytes(p.bytes) : '';
    const n = (s.streams || []).length;
    const list = `${n} stream${n === 1 ? '' : 's'}`;
    return [s.container || '—', size || `${list}${s.path ? ' · ' + basename(s.path) : ''}`];
}

/// Kept because the export module still calls it when its job state changes:
/// the spine has to know a render is holding the slot on the frame that
/// becomes true, not the next time something redraws.
function syncWorkspace() {
    shell.drawSpine();
    command.draw();
}

function flash(message) {
    osd.textContent = message;
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.add('hidden'), 1400);
}

// Tests drive the app through this rather than reaching for a DOM id that
// only exists while one particular clip is selected.
globalThis.__ffmpegBro = {
    project, transport, resolveOverlaps,
    open, openBatch, openInput, removeSelection,
    // The `-i`s, which are the document now: a test that wants to know what
    // will be opened asks this rather than walking the timeline for paths.
    inputs: inputsModel,
    // What a drop of files amounts to, and the three inputs whose content is
    // assembled rather than opened. Exposed because the grouping is the most
    // used path into them and a test of it should not have to go through a
    // drop to reach it.
    assemble,
    drawSources,
    video: () => { const c = viewer.activeClip(); return c ? c.video : null; },
    activeClip: () => viewer.activeClip(),
    activeClips: () => viewer.activeClips(),
    setPlayhead, play, pause, step,
    timeline, viewer,
    setCropMode, cropMode: () => cropMode,
    splitAtPlayhead, setLayout, select, selectMany,
    showProperties, pending,
    exporter, capture,
    filtergraph, renderGraph, shell, command, report,
    // The graph beneath filtergraph(): tests written against the model itself
    // do not have to go through a spec and a printed string to reach it.
    graph: { makeGraph, restore, derive, print, layout, portY, problems, padsOf, socketAt,
             overlay: graphOverlay, draw: drawGraph, summary: graphSummary,
             placement: graphPlacement,
             outranked: outrankedControls, preview: graphPreview, previewGraph },
};
globalThis.__ffmpegBroReady = true;
