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

import { settings, preview, currentJob, setJob, onJobChange, isRendering,
         activeVideoCodec, activeAudioCodec, outputFps } from './export/state.js';
import { videoOptions } from './export/options.js';
import { buildSpec, previewSpec, range, defaultPath, specSources } from './export/spec.js';
import { intents, activeIntent, applyIntent, clampToEncoder } from './export/presets.js';
import { warnings } from './export/warnings.js';
import { restore, remember, isFirstRun, noLongerFirstRun } from './export/store.js';
import { initForm, drawForm } from './export/form.js';
import { initStreams, drawStreams } from './export/streams.js';
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
        else if (hooks.leave) hooks.leave();
    });
    el_.go.addEventListener('click', begin);

    // The tab that offers to leave has to know a render is holding the slot on
    // the frame that becomes true, not the next time something redraws.
    onJobChange(() => { if (hooks.workspace) hooks.workspace(); });

    initForm({ settings: el_.settings, advanced: el_.advanced, dest: el_.dest }, {
        changed: after,
        tweaked: () => { invalidateCandidate(); updateSummary(); },
    });
    // The stream list changes what is *in* the file and not what the picture
    // looks like, so a language or a disposition must not throw away a
    // candidate render that cost ten seconds. `changed` rebuilds the rows (a
    // stream was added, removed or re-coded); `restated` only re-says what will
    // be written, which is the summary, the spine and the command bar.
    initStreams(el_.streams, {
        changed: () => { drawStreams(); updateSummary(); },
        restated: updateSummary,
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

/// Everything that has to be true before the Encode or Write stage is looked
/// at. Called by the shell on the way in rather than by a tab: which stage is
/// up is the shell's business, and this module's is what is on it.
///
/// **Encode and Write are two stages of one arrival.** The shell calls this for
/// each of them, and stepping between the two is not a fresh visit — so the
/// half of this that reads the edit runs only when coming from outside. It
/// used to run both times, and the casualty was where the preview samples
/// from: dragged to a moment worth checking on the Encode stage, it snapped
/// back to the playhead on the way back from setting a filename, leaving the
/// A/B stage showing frames from somewhere the strip no longer pointed at and
/// the next preview paying for a lossless render it already had.
export function prepare() {
    if (!project.clips.length) return false;
    if (!open) arrive();
    open = true;

    clampToEncoder();
    showPanel('form');
    drawAll();
    if (hooks.workspace) hooks.workspace();
    return true;
}

/// Coming to the encode side from the edit: what the settings should say about
/// a timeline they may not have seen before.
function arrive() {
    if (hooks.pause) hooks.pause();

    if (!settings.path) settings.path = defaultPath();
    if (!settings.width) { settings.width = project.width; settings.height = project.height; }
    // Pinned rather than left to the container's default, so the form shows
    // the codec it is about to use rather than a blank that reads as "none".
    if (!settings.videoCodec) settings.videoCodec = activeVideoCodec();
    if (!settings.audioCodec) settings.audioCodec = activeAudioCodec();

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
}

/// Leaving the encode side altogether. Refused while a render holds the host's
/// one job slot — Stop is the way out of one — so the shell can ask first.
export function canLeave() { return !isRendering(); }

export function closeExport() {
    if (isRendering()) return;
    open = false;
    stopPreviewPlayback();
    if (hooks.workspace) hooks.workspace();
}

/// Within the Write stage: the destination and the verdict, or the render in
/// progress. Not a stage of its own — a render is the Write stage happening,
/// not a fifth thing.
function showPanel(which) {
    show(el_.write, which === 'form');
    show(el_.progress, which === 'progress');
    show(el_.go, which === 'form');
    // The button is Stop only while there is something to stop. A finished
    // render leaving "Stop" under a green bar reads as though it is still
    // going.
    el_.cancel.textContent = isRendering() ? 'Stop' : 'Back';
}

function drawAll() {
    drawIntents();
    drawForm();
    drawStreams();
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
    const fps = outputFps();
    const frames = Math.max(1, Math.round(r.length * fps));
    const clips = project.clips.length;
    const codec = activeVideoCodec();

    // What the file will be, in the terms the file will be described in by
    // whatever opens it next. A measurement beats an estimate, so the preview's
    // is used whenever there is one.
    let size = '';
    if (preview.stats && preview.stats.seconds > 0)
        size = ` · ≈ ${bytes(preview.stats.bytes * (r.length / preview.stats.seconds))} (measured)`;
    else if (settings.rate === 'bitrate' || settings.rate === 'constrained')
        size = ` · ≈ ${bytes((settings.videoBitrate +
                              (settings.audio ? settings.audioCodecBitrate : 0)) * 1000 * r.length / 8)}`;

    // No command line here any more. It runs under every stage now, in full and
    // in two colours, which is the whole of what this line was gesturing at.
    put(el_.summary, () => [
        div('mono', `${settings.width}×${settings.height} · ${fps.toFixed(3)} fps · ` +
                    `${clock(r.length)} · ${frames} frames${size}`),
        div('mono dim', `${codec || '?'}` +
            (settings.audio && settings.audioCodec ? ` + ${settings.audioCodec}` : ' · silent') +
            ` · ${settings.container} · ${clips} clip${clips === 1 ? '' : 's'} flattened`),
    ]);
    put(el_.warnings, () => warnings().map((t) => div('warn', t)));
    if (hooks.described) hooks.described();
}

/// What the spine's Encode and Write cards say, and what they warn about.
export { warnings as currentWarnings };

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

export { buildSpec, previewSpec, specSources, range, togglePreviewPlay, stepPreviewBy,
         startPreview };

/// The last thing poll() reported, for the status line and for tests.
export function lastStatus() { return lastPoll; }

/// For tests: the settings block, and what the encoder is being told.
export function currentSettings() { return settings; }
export function currentOptions() { return videoOptions(activeVideoCodec()); }
export function previewState() { return preview; }
