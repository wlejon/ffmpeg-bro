// The Output workspace: writing the timeline out.
//
// The edit is already a complete description of an output frame — every clip
// has a rectangle in the canvas, a crop, an opacity and a place in the track
// stack, and the viewer draws exactly that. Exporting is that same description
// handed to an encoder instead of to the screen, which is why the rectangles
// sent to the renderer come from viewer.placement() rather than from a second
// implementation of fit/zoom/pan/grid that could disagree with what you were
// just looking at.
//
// Everything that is not geometry is an ffmpeg option. The friendly controls
// do not have a private path into the encoder: a Quality slider produces
// `{crf: 20}` and the raw option editor produces `{crf: 20}`, both land in the
// same bag, and the bag is applied with av_opt_set the way the ffmpeg command
// line applies its arguments. Which is why the advanced column can offer every
// option libavcodec reports without any of them needing to be plumbed.
//
// The hard part of encoding is not finding the settings, it is knowing what
// they cost — which is what the preview is for, and why this is a screen and
// not a dialog. The parts live in ./export/; this file is the wiring between
// them, and the only thing that knows the workspace as a whole.

import { project, duration } from './project.js';
import { el, div, put, byId, show } from './dom.js';
import { bytes, clock } from './format.js';

import { settings, preview, currentJob, setJob, onJobChange, isRendering } from './export/state.js';
import { containerInfo } from './export/capabilities.js';
import { videoOptions, commandLine } from './export/options.js';
import { buildSpec, range, defaultPath } from './export/spec.js';
import { intents, activeIntent, applyIntent, clampToEncoder } from './export/presets.js';
import { warnings } from './export/warnings.js';
import { restore, remember, isFirstRun, noLongerFirstRun } from './export/store.js';
import { initForm, drawForm } from './export/form.js';
import { initPreview, drawPreview, chasePreview, startPreview, previewFinished,
         previewRange, invalidatePreview, invalidateCandidate, stopPreviewPlayback,
         renderCandidate, togglePreviewPlay, stepPreviewBy } from './export/preview.js';
import { initStrip, drawStrip, refitStrip, markPreviewAt } from './export/strip.js';
import { initProgress, drawProgress } from './export/progress.js';

let el_ = {};
let hooks = {};
let open = false;
let lastPoll = null;

export function initExport(refs, h) {
    el_ = refs;
    hooks = h || {};

    el_.cancel.addEventListener('click', () => {
        if (isRendering()) bro.ffmpeg.render.cancel();
        else closeExport();
    });
    el_.go.addEventListener('click', begin);

    // The tab that offers to leave has to know a render is holding the slot on
    // the frame that becomes true, not the next time something redraws.
    onJobChange(() => { if (hooks.workspace) hooks.workspace(); });

    initForm({ settings: el_.settings, advanced: el_.advanced }, {
        changed: after,
        tweaked: () => { invalidateCandidate(); updateSummary(); },
    });
    initPreview({ stage: byId('ex-pv-stage-host'), controls: byId('ex-pv-controls'),
                  stats: byId('ex-pv-stats') }, {
        launch,
        status: () => lastPoll,
        mark: markPreviewAt,
    });
    initStrip({ canvas: byId('ex-strip-c'), nums: byId('ex-range-nums'),
                marker: byId('ex-strip-head'), all: byId('ex-range-all') }, {
        previewRange,
        movePreviewTo: (t) => { preview.at = t; },
        changed: () => { invalidatePreview(); drawAll(); },
        tweaked: updateSummary,
    });
    initProgress(el_.progress, {
        back: () => { showPanel('form'); drawAll(); },
        addToTimeline: (path) => { closeExport(); if (hooks.open) hooks.open(path); },
    });

    restore();
}

export function isOpen() { return open; }
export { isRendering as isRunning };

export function openExport() {
    if (!project.clips.length) {
        if (hooks.flash) hooks.flash('Nothing on the timeline to export');
        return;
    }
    if (hooks.pause) hooks.pause();
    open = true;
    // The class on <body> is what hides the edit; the section's own `hidden`
    // is what stops it being measured while it is not on screen.
    document.body.classList.add('ws-output');
    show(el_.screen, true);

    if (!settings.path) settings.path = defaultPath();
    if (!settings.width) { settings.width = project.width; settings.height = project.height; }
    if (!settings.videoCodec)
        settings.videoCodec = (containerInfo(settings.container) || {}).videoCodec || '';
    if (!settings.audioCodec)
        settings.audioCodec = (containerInfo(settings.container) || {}).audioCodec || '';

    // Nothing has ever been saved, so start somewhere named rather than on a
    // pile of defaults that happens to match none of the presets and reads as
    // "custom" before anything has been customised.
    if (isFirstRun()) {
        noLongerFirstRun();
        const first = intents()[0];
        if (first) applyIntent(first.id);
    }

    // The range is measured against a timeline that may have changed since it
    // was set, so an out point past the end is quietly the end.
    const total = Math.max(0, duration());
    if (settings.rangeOut > total) settings.rangeOut = 0;
    preview.at = Math.min(Math.max(0, hooks.playhead ? hooks.playhead() : 0),
                          Math.max(0, total - 0.1));

    clampToEncoder();
    showPanel('form');
    drawAll();
    if (hooks.workspace) hooks.workspace();
}

export function closeExport() {
    if (isRendering()) return;     // the Stop button is the way out of a render
    open = false;
    stopPreviewPlayback();
    show(el_.screen, false);
    document.body.classList.remove('ws-output');
    if (hooks.workspace) hooks.workspace();
}

function showPanel(which) {
    show(el_.form, which === 'form');
    show(el_.progress, which === 'progress');
    show(el_.go, which === 'form');
    // The range belongs to the settings, not to the render: while one is
    // running it is a picture of a decision already taken.
    show(el_.strip, which === 'form');
    // The button is Stop only while there is something to stop. A finished
    // render leaving "Stop" under a green bar reads as though it is still
    // going.
    el_.cancel.textContent = isRendering() ? 'Stop' : 'Close';
}

function drawAll() {
    drawIntents();
    drawForm();
    drawPreview();
    drawStrip();
    updateSummary();
}

/// After any change that could alter what gets written.
function after() {
    clampToEncoder();
    invalidateCandidate();
    drawAll();
}

// ── the intent row ─────────────────────────────────────────────────────────

function drawIntents() {
    const active = activeIntent();
    put(el_.intentList, () => intents().map((it) => el('button', {
        cls: 'tiny' + (it.id === active ? ' on' : ''),
        text: it.label,
        title: it.hint,
        'data-intent': it.id,
        on: { click: () => { if (applyIntent(it.id)) { invalidatePreview(); drawAll(); } } },
    })));
    show(el_.intentCustom, !active);
}

// ── the summary ────────────────────────────────────────────────────────────

function updateSummary() {
    const r = range();
    const fps = settings.fps || project.fps || 30;
    const frames = Math.max(1, Math.round(r.length * fps));
    const clips = project.clips.length;
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;

    // What the file will be, in the terms the file will be described in by
    // whatever opens it next. A measurement beats an estimate, so the preview's
    // is used whenever there is one.
    let size = '';
    if (preview.stats && preview.stats.seconds > 0)
        size = ` · ≈ ${bytes(preview.stats.bytes * (r.length / preview.stats.seconds))} (measured)`;
    else if (settings.rate === 'bitrate' || settings.rate === 'constrained')
        size = ` · ≈ ${bytes((settings.videoBitrate +
                              (settings.audio ? settings.audioCodecBitrate : 0)) * 1000 * r.length / 8)}`;

    put(el_.summary, () => [
        div('mono', `${settings.width}×${settings.height} · ${fps.toFixed(3)} fps · ` +
                    `${clock(r.length)} · ${frames} frames${size}`),
        div('mono dim', `${codec || '?'}` +
            (settings.audio && settings.audioCodec ? ` + ${settings.audioCodec}` : ' · silent') +
            ` · ${settings.container} · ${clips} clip${clips === 1 ? '' : 's'} flattened · ` +
            commandLine(codec)),
        ...warnings().map((t) => div('warn', t)),
    ]);
}

// ── running ────────────────────────────────────────────────────────────────

/// Hand a spec to the host and remember what the slot is being used for.
function launch(spec, kind) {
    try {
        bro.ffmpeg.render.start(spec);
        setJob(kind);
        lastPoll = bro.ffmpeg.render.poll();
    } catch (e) {
        setJob(null);
        preview.error = String(e.message || e);
        drawPreview();
        return;
    }
    if (kind === 'export') { showPanel('progress'); drawProgress(lastPoll); }
    else drawPreview();
}

function begin() {
    if (isRendering()) return;
    const spec = buildSpec();
    if (!spec.path) {
        if (hooks.flash) hooks.flash('Choose a file to write to');
        return;
    }
    settings.path = spec.path;
    remember();

    try {
        bro.ffmpeg.render.start(spec);
    } catch (e) {
        put(el_.progress, () => div('ex-failed', String(e.message || e)));
        showPanel('progress');
        setJob(null);
        return;
    }
    setJob('export');
    showPanel('progress');
    // The first draw comes from a real poll rather than a hand-made stand-in:
    // one shape, filled in by one place, so a field added to the status cannot
    // be missing from the frame the progress panel opens on.
    lastPoll = bro.ffmpeg.render.poll();
    drawProgress(lastPoll);
}

/// Called once a frame while the workspace is up. The render is on its own
/// thread; this is the only thing that looks at it.
export function tick() {
    if (!isRendering()) {
        if (open) { chasePreview(); refitStrip(); }
        return;
    }
    const p = bro.ffmpeg.render.poll();
    lastPoll = p;

    if (currentJob() === 'export') {
        drawProgress(p);
        if (p.state !== 'running') {
            setJob(null);
            showPanel('progress');
            if (hooks.finished) hooks.finished(p);
        }
        return;
    }

    if (p.state === 'running') { drawPreview(); return; }

    // Clearing the slot first: a failed preview that left it set would mean
    // the workspace spends the rest of its life believing a render is in
    // progress, with the Export button disabled and no way back.
    const chain = previewFinished(p);
    setJob(null);
    if (chain) renderCandidate();       // straight on: one click, both halves
    else { showPanel('form'); drawPreview(); updateSummary(); }
}

// ── what the app and the tests reach for ───────────────────────────────────

export { buildSpec, range, togglePreviewPlay, stepPreviewBy, startPreview };

/// The last thing poll() reported, for the status line and for tests.
export function lastStatus() { return lastPoll; }

/// For tests: the settings block, and what the encoder is being told.
export function currentSettings() { return settings; }
export function currentOptions() {
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;
    return videoOptions(codec);
}
export function previewState() { return preview; }
