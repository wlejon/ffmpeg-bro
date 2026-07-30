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
         settingsChanged, activeVideoCodec, activeAudioCodec,
         outputFps } from './export/state.js';
import { videoOptions } from './export/options.js';
import { buildSpec, previewSpec, range, defaultPath, specSources,
         renderSubject } from './export/spec.js';
import { noteRender } from './report.js';
import { intents, activeIntent, applyIntent, clampToEncoder } from './export/presets.js';
import { warnings } from './export/warnings.js';
import { restore, remember, isFirstRun, noLongerFirstRun } from './export/store.js';
import { initForm, drawForm } from './export/form.js';
import { initStreams, drawStreams, defaultStreams } from './export/streams.js';
import { initPreview, drawPreview, drawPreviewStats, chasePreview, startPreview,
         previewFinished, previewRange, invalidatePreview, invalidateCandidate,
         stopPreviewPlayback, renderCandidate, startQuality, togglePreviewPlay,
         stepPreviewBy } from './export/preview.js';
import { initStrip, drawStrip, refitStrip, markPreviewAt } from './export/strip.js';
import { initProgress, drawProgress } from './export/progress.js';
import * as destination from './export/destination.js';
// A measurement cut off at one node runs a subgraph of the export's graph, and
// a subgraph is not the graph the spec was built with — so which device its
// filters belong to has to be worked out again for the chains actually being
// run. One home for that question; the node previews ask it the same way.
import { deviceForRender } from './hardware.js';
import { syncFollowing } from './export/copy.js';

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

    // **Three hooks, and every one of them announces the same fact first.** The
    // three are consequences — see `settingsChanged` in export/state.js — and
    // wrapping them here is what makes that channel complete: a control cannot
    // reach the settings without going through one of these, so it cannot change
    // them without saying so.
    initForm({ settings: el_.settings, advanced: el_.advanced, dest: el_.dest,
               format: byId('ex-format-opts') }, {
        changed: said(after),
        tweaked: said(() => { invalidateCandidate(); updateSummary(); }),
        // The same third hook the stream list has, and it means the same thing:
        // a control that changes what is *in* the file rather than what the
        // picture looks like only re-says what will be written.
        restated: said(updateSummary),
    });
    // The stream list changes what is *in* the file and not what the picture
    // looks like, so a language or a disposition must not throw away a
    // candidate render that cost ten seconds. `changed` rebuilds the rows (a
    // stream was added, removed or re-coded); `restated` only re-says what will
    // be written, which is the summary, the spine and the command bar.
    initStreams(el_.streams, {
        changed: said(() => { drawStreams(); updateSummary(); }),
        restated: said(updateSummary),
    });
    initPreview({ stage: byId('ex-pv-stage-host'), controls: byId('ex-pv-controls'),
                  stats: byId('ex-pv-stats') }, {
        launch,
        status: () => lastPoll,
        mark: markPreviewAt,
    });
    // The range is in `settings` too — `rangeIn`/`rangeOut` are what the render
    // walks — so dragging an end of the strip is the settings changing.
    initStrip({ canvas: byId('ex-strip-c'), nums: byId('ex-range-nums'),
                marker: byId('ex-strip-head'), all: byId('ex-range-all') }, {
        previewRange,
        movePreviewTo: (t) => { preview.at = t; },
        changed: said(() => { invalidatePreview(); drawAll(); }),
        tweaked: said(updateSummary),
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

/// The one channel, in front of any of the three consequences.
///
/// **Announced after the consequence rather than before**, and that ordering is
/// load-bearing: `after()` calls `clampToEncoder()`, which is itself a change to
/// the settings — a preset's bitrate pulled inside what the encoder will take —
/// so announcing first would record a state the form was never actually in and
/// leave the clamp to be picked up by whatever changed next.
const said = (fn) => () => { fn(); settingsChanged(); };

// ── the intent row ─────────────────────────────────────────────────────────

function drawIntents() {
    const active = activeIntent();
    put(el_.intentList, () => intents().map((it) => el('button', {
        cls: 'tiny' + (it.id === active ? ' on' : ''),
        text: it.label,
        title: it.hint,
        'data-intent': it.id,
        // The press this application most needed an undo for: a preset rewrites
        // the codec, the rate control, the quality, the preset and the pixel
        // format at once, and "what was it before" has no other answer.
        on: { click: () => {
            if (applyIntent(it.id)) { invalidatePreview(); drawAll(); settingsChanged(); }
        } },
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
    // The reader, not the raw field. `settings.audioCodec` is blanked whenever
    // the container changes and again on load when the build lacks what was
    // stored, and "" there means "whatever this container's default is" rather
    // than "no sound" — so reading it directly made the summary say *silent*
    // about a render with a soundtrack in it. That is the whole reason
    // `activeAudioCodec()` exists, and the video half was already using its
    // counterpart one line up.
    const acodec = activeAudioCodec();

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
            (settings.audio && acodec ? ` + ${acodec}` : ' · silent') +
            ` · ${settings.container} · ${clips} clip${clips === 1 ? '' : 's'} flattened`),
    ]);
    put(el_.warnings, () => warnings().map((t) => div('warn', t)));
    if (hooks.described) hooks.described();
}

/// What the spine's Encode and Write cards say, and what they warn about.
export { warnings as currentWarnings };

/// The copy rows that follow a clip, brought up to date with the edit.
///
/// **Called from the model's own change channel, not at draw time and not while a
/// spec is being built.** That is the load-bearing part of the whole binding: what
/// a followed row keeps is `copyFrom` and `copyTo`, the same two numbers a person
/// typing in the fields writes, so `buildSpec()`, `command.js` and `warnings()`
/// cannot tell a followed row from a typed one and none of them had to learn that
/// a link exists. Derived at the far end instead, it would be the second source of
/// truth the press was written to avoid.
///
/// Returns `{ moved, broke }` — how many rows' spans changed, and a sentence per
/// link that broke. Both are the caller's business rather than this module's: it
/// has nothing to flash with, and only the caller knows that a change nobody made
/// has to become the encode side's history baseline.
export function followTimeline() {
    const answer = syncFollowing(settings.streams);
    // Redrawn only when something actually moved: this runs on every mouse
    // position of every drag, and rebuilding the stream list sixty times a second
    // to draw the same rows is the sort of thing that makes a drag stall under the
    // cursor.
    if (open && (answer.moved || answer.broke.length)) { drawStreams(); updateSummary(); }
    return answer;
}

// ── running ────────────────────────────────────────────────────────────────

/// Hand a spec to the host and remember what the slot is being used for.
/// Returns the number the host gave this render, so that whatever started it
/// can find what it said afterwards. `poll()`'s own `job` cannot answer that:
/// it is the render running *now* and is zero from the instant one ends, which
/// is the frame a caller comes to read.
function launch(spec, kind) {
    let job = 0;
    try {
        job = Number(bro.ffmpeg.render.start(spec)) || 0;
        // What this render is of, taken now — see `renderSubject()`. It has to
        // be recorded at the start and not when the first message arrives: the
        // channel says which render spoke and never what it was shown, and a
        // subject read later is a subject read after the edit could have moved.
        noteRender(job, renderSubject(spec));
        setJob(kind);
        lastPoll = bro.ffmpeg.render.poll();
    } catch (e) {
        setJob(null);
        preview.error = String(e.message || e);
        drawPreview();
        return 0;
    }
    if (kind === 'export') { showPanel('progress'); drawProgress(lastPoll); }
    else drawPreview();
    return job;
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
///
/// `cut` is `graph/subgraph.js`'s `measureGraph()` — **the graph stopped at one
/// node**, which is the same render over less of the same graph. Nothing here
/// changes for it except the chains and the files: what a measurement is, what
/// it costs and what it refuses are the same question either way, and a second
/// entry point would be a second answer to all three. The size comes from the
/// graph, because half way down one nothing out here knows how big the picture
/// is — the same reason a node preview says so.
export function startMeasurement(cut = null) {
    if (isRendering()) return 'something is already using the one render slot';
    const r = range();
    if (!(r.length > 0)) return 'the range to measure is empty';
    const spec = previewSpec({ start: r.start, end: r.end });
    if (cut) {
        spec.filterGraph = cut.filterGraph;
        spec.filterInputs = cut.filterInputs;
        spec.filterHwDevice = deviceForRender(cut.filterGraph, spec.inputs);
        spec.sizeFromGraph = true;
        // A cut at a sound pad has no picture in it at all, and one at a
        // picture has no sound: the pruning kept what the chosen node depends
        // on, and the other half of the graph is not in it to be encoded.
        spec.audio = !!cut.audio;
    }
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
        // The subject is taken from the spec *before* the output was stripped
        // off it, which is the same object either way: `renderSubject()` reads
        // only what the filters were shown, and none of the six lines above
        // touches that half.
        noteRender(Number(bro.ffmpeg.render.start(spec)) || 0, renderSubject(spec));
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
        noteRender(Number(bro.ffmpeg.render.start(spec)) || 0, renderSubject(spec));
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

/// The edit as a render's own subject would record it — what the Report drawer
/// compares against to know whether what it is showing still describes what is
/// on screen. One place builds a spec, so one place answers this.
export function currentSubject() { return renderSubject(buildSpec()); }

/// The list this application writes when nobody has said otherwise — one video
/// stream from the composite and one audio stream from the mix. On the surface
/// so that a test which has turned the output into a rewrap can put it back
/// without knowing what the default is made of.
export { defaultStreams };

/// The starting points on offer, as data rather than as buttons. On the surface
/// because what a test needs to say about them is a property of the *list* —
/// that a GPU preset is only offered for an encoder this machine has — and
/// reading that off the DOM would mean clicking one to find out what it applies.
export { intents };

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

/// Where the render goes, as a shape rather than a path. Pure — the kind, the
/// tee argument and its escaping are all functions of the settings — so a test
/// can state exactly what a destination becomes without driving a form or
/// starting a render, which is how ui_filtergraph.js is written against specs.
export { destination };

/// What is carried between runs, and the repair on the way back in.
///
/// On the surface because `restore()` runs once at boot and `remember()` runs
/// on a render, so the round trip — and everything it deliberately does *not*
/// carry — is otherwise reachable only by starting the application twice. It is
/// also the documented source of cross-run surprise in this repo: a run that
/// leaves the settings somewhere odd hands them to the next one.
export { restore as restoreSettings, remember as rememberSettings };
