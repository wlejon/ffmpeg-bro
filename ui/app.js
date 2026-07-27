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
         selectMany, selectFollow, isSelected, splitClip, trackCount } from './project.js';
import { analyzeClip, pending } from './analysis.js';
import * as viewer from './viewer.js';
import * as timeline from './timeline.js';
import * as exporter from './export.js';
import { initInspector, showProperties, showTransform, subjects } from './inspector.js';
import { clock, timecode, basename, bytes } from './format.js';
import { paintIcons, setIcon } from './icons.js';
import { filtergraph } from './filtergraph.js';
import { makeGraph, restore } from './graph/model.js';
import { derive } from './graph/derive.js';
import { print } from './graph/print.js';
import { initGraphView, drawGraph, chaseGraph, graphSummary, fitView }
    from './graph/view.js';
import * as shell from './shell.js';
import { initSources, drawSources } from './sources.js';
import { transport, initTransport, setPlayhead, play, pause, togglePlay, step,
         applyAudio, applyAudioAll, tick as tickTransport } from './transport.js';
import * as command from './command.js';

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

initSources(el('sources'));

initGraphView({
    viewport: el('gr-viewport'),
    canvas: el('gr-wires'),
    nodes: el('gr-nodes'),
    note: el('gr-note'),
    status: el('gr-status'),
    fit: el('gr-fit'),
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

function open(path, opts = {}) {
    let probe;
    try {
        probe = bro.ffmpeg.probe(path);
    } catch (e) {
        flash(String(e.message || e));
        return null;
    }
    if (!probe.video) {
        // bro's <video> drives its clock from decoded pictures, so a track
        // list with no video has nothing to advance. Say so instead of
        // loading something that will sit at 0:00 forever.
        flash(probe.audio ? 'audio-only files are not playable yet — this needs a video track'
                          : 'no audio or video track in this file');
        return null;
    }

    // New clips land after everything already on their track, which is what
    // dropping a second file onto a player is asking for. `track` puts one on
    // a lane of its own instead — that is how a batch becomes a grid.
    const clip = makeClip(path, probe);
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

/// Open several files as one gesture. Dropping a morning's recordings is not
/// the same act as opening one file: past a couple of them the useful thing is
/// usually to see them all at once, so they go on separate tracks, all starting
/// at zero, and the canvas switches to a grid.
function openBatch(paths) {
    if (paths.length === 1) return [open(paths[0])];
    const grid = paths.length >= 3;
    // Stack the batch above whatever is already there, or start at V1 when the
    // timeline is empty — `trackCount()` counts the spare lane, which is not a
    // track anything lives on yet.
    const base = grid ? (project.clips.length ? trackCount() - 1 : 0) : 0;
    const made = [];
    for (const p of paths) {
        const clip = open(p, { quiet: true, track: grid ? base + made.length : undefined });
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
        if (right) halves.push(right);
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
    if (shell.currentStage() === 'sources') {
        if (e.key === 'Escape') { shell.goTo('compose'); e.preventDefault(); }
        return;
    }
    // The graph owns the keyboard while it is up, for the reason the encode
    // side does: Space must not start playback on a timeline nobody can see.
    // `0` frames the view, which is what it does on the timeline too.
    if (shell.currentStage() === 'graph') {
        if (e.key === 'Escape') { shell.goTo('compose'); e.preventDefault(); }
        else if (e.key === '0') { fitView(); e.preventDefault(); }
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
    // The render is on a thread of its own in the host binary; this is the
    // only thing that looks at it, and only while its dialog is up.
    exporter.tick();

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
        if (!exporter.canLeave() && id !== 'write')
            return 'A render is running — stop it first';
        if ((id === 'encode' || id === 'write') && !project.clips.length)
            return 'Nothing on the timeline to encode';
        return null;
    },
    changed: (id) => {
        if (id === 'encode' || id === 'write') exporter.prepare();
        else exporter.closeExport();
        if (id === 'compose') { viewer.layout(); timeline.draw(); }
        if (id === 'sources') drawSources();
        // Every height the layout needs measures zero while the stage is
        // hidden, so the graph is built on the way in and not before.
        if (id === 'graph') drawGraph();
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

/// The two lines under a stage's name: what it is set to, in the terms that
/// stage is about. Read from the model every time the spine is drawn, because
/// a bar that can disagree with the render is worse than one that is rebuilt.
function stageState(id) {
    const clips = project.clips;
    if (id === 'sources') {
        if (!clips.length) return ['nothing loaded', ''];
        const files = new Set(clips.map((c) => c.path)).size;
        const streams = clips.reduce(
            (n, c) => n + ((c.probe && c.probe.streams) ? c.probe.streams.length : 0), 0);
        return [`${files} file${files === 1 ? '' : 's'}`, `${streams} streams`];
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
        return [`${g.nodes} filter${g.nodes === 1 ? '' : 's'}`,
                `${g.inputs} in · ${g.chains} chain${g.chains === 1 ? '' : 's'}`];
    }
    if (!clips.length) return ['—', ''];
    const s = exporter.currentSettings();
    if (id === 'encode') {
        const rate = s.rate === 'quality' ? `q ${s.quality}`
                   : s.rate === 'lossless' ? 'lossless'
                   : `${s.videoBitrate}k`;
        return [s.videoCodec || '—', `${rate}${s.preset ? ' · ' + s.preset : ''}`];
    }
    const p = exporter.lastStatus();
    const size = p && p.state === 'done' && p.bytes ? bytes(p.bytes) : '';
    return [s.container || '—', size || (s.path ? basename(s.path) : 'no file chosen')];
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
    open, openBatch, removeSelection,
    video: () => { const c = viewer.activeClip(); return c ? c.video : null; },
    activeClip: () => viewer.activeClip(),
    activeClips: () => viewer.activeClips(),
    setPlayhead, play, pause, step,
    timeline, viewer,
    setCropMode, cropMode: () => cropMode,
    splitAtPlayhead, setLayout, select, selectMany,
    showProperties, pending,
    exporter,
    filtergraph, shell, command,
    // The graph beneath filtergraph(): tests written against the model itself
    // do not have to go through a spec and a printed string to reach it.
    graph: { makeGraph, restore, derive, print },
};
globalThis.__ffmpegBroReady = true;
