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
import { initPreview, drawPreview, drawPreviewStats, chasePreview, startPreview,
         previewFinished, previewRange, invalidatePreview, invalidateCandidate,
         stopPreviewPlayback, renderCandidate, startQuality, togglePreviewPlay,
         stepPreviewBy } from './export/preview.js';
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

    initForm({ settings: el_.settings, advanced: el_.advanced, dest: el_.dest,
               format: byId('ex-format-opts') }, {
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

/// Run the graph over the range and keep nothing but what it measured.
///
/// **How a measurement is started.** Today it meant knowing to put `cropdetect`
/// on the graph and then rendering a file you did not want, which is honest and
/// is most of a reason not to bother. This is the same render with the output
/// thrown away — `-f null -` through `wrapped_avframe`, exactly what an analysis
/// pass does — so it costs the decode and the filters and nothing else.
///
/// It is deliberately not a private path: the filters it runs are the ones on
/// the graph, through `buildSpec()` like every other render here, so what it
/// measures is what an export of the same edit would measure. A graph with
/// nothing of yours in it renders through the compositor, where there are no
/// filters to hang metadata on anything, and that is refused with the reason
/// rather than run to produce an empty report.
export function startMeasurement() {
    if (isRendering()) return 'something is already using the one render slot';
    const r = range();
    if (!(r.length > 0)) return 'the range to measure is empty';
    const spec = previewSpec({ start: r.start, end: r.end });
    if (!spec.filterGraph)
        return 'there is no measuring filter on the graph — this render would go through ' +
               'the internal compositor, where there is nothing to hang a measurement on';
    // Everything about the *output*, taken away. The encoder is the one that
    // encodes nothing and the muxer is the one that writes nothing, and the
    // option bags go with the encoder they were written for: an option table
    // belongs to an encoder, and x264's `preset` on `wrapped_avframe` is an
    // unknown option, which is an error here rather than a shrug.
    spec.path = bro.ffmpeg.tempPath('measure.null');
    spec.format = 'null';
    spec.videoCodec = 'wrapped_avframe';
    spec.audioCodec = 'pcm_s16le';
    spec.videoOptions = {};
    spec.audioOptions = {};
    spec.formatOptions = {};
    // And the passes, for the same reason: a two-pass encode is a decision
    // about how to spend a bitrate, and this render encodes nothing at all.
    // Walking the range twice would double what a measurement costs to learn
    // exactly what it learned the first time.
    spec.passes = [];
    spec.faststart = false;
    try {
        bro.ffmpeg.render.start(spec);
    } catch (e) {
        return String(e.message || e);
    }
    setJob('measure');
    lastPoll = bro.ffmpeg.render.poll();
    return '';
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

    // The quality measurement is a render with nothing on screen to show for
    // it: the two videos are already up and playing, and rebuilding the stage
    // under them to draw a progress bar would take away the picture it is
    // measuring. So it changes only the line of numbers, and only when it is
    // over.
    // A measurement writes nothing and has nothing on screen of its own: what
    // it produces arrives in the Report drawer, which drains the channel from
    // the frame loop whether or not this workspace is open.
    if (currentJob() === 'measure') {
        if (p.state === 'running') return;
        setJob(null);
        if (hooks.flash)
            hooks.flash(p.state === 'done' ? 'Measured — R for what it found'
                                           : `The measurement ${p.state}`);
        return;
    }

    if (currentJob() === 'quality') {
        if (p.state === 'running') return;
        previewFinished(p);
        setJob(null);
        drawPreviewStats();
        return;
    }

    if (p.state === 'running') { drawPreview(); return; }

    // Clearing the slot first: a failed preview that left it set would mean
    // the workspace spends the rest of its life believing a render is in
    // progress, with the Export button disabled and no way back.
    const next = previewFinished(p);
    setJob(null);
    // Straight on: one click renders the reference, the candidate, and then
    // measures one against the other.
    if (next === true) renderCandidate();
    else if (next === 'quality') { showPanel('form'); drawPreview(); updateSummary();
                                   startQuality(); }
    else { showPanel('form'); drawPreview(); updateSummary(); }
}

// ── what the app and the tests reach for ───────────────────────────────────

export { buildSpec, previewSpec, specSources, range, togglePreviewPlay, stepPreviewBy,
         startPreview };

/// The last thing poll() reported, for the status line and for tests.
export function lastStatus() { return lastPoll; }

/// For tests: the settings block, and what the encoder is being told.
export function currentSettings() { return settings; }

/// Redraw everything from the settings as they now are. The app itself never
/// needs this — every control redraws what it changed — but a test that writes
/// into `settings` directly has changed the model behind the form's back.
export function redraw() { if (open) drawAll(); }
export function currentOptions() { return videoOptions(activeVideoCodec()); }

/// Which objective metrics this build can compare the two halves with. Asked of
/// libavfilter rather than written down, so a build without libvmaf offers two
/// numbers instead of promising three.
export { metrics as qualityMetrics } from './export/quality.js';
export function previewState() { return preview; }
