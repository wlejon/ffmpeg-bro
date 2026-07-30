// ffmpeg-bro — the editing surface.
//
// Everything here drives plain <video> elements. There is no subprocess, no
// pipe and no proxy file: libavcodec is linked into this binary and registered
// as a bro media backend, so the engine decodes the real streams and hands the
// frames straight to the renderer. That is why the transport can be
// frame-accurate, why seeking is instant, and why several clips can sit on one
// timeline without any of them being transcoded first.

import * as doc from './document.js';
import * as history from './history.js';
import { project, projectFps, makeClip, addClip, removeClip, duration, clipsAt,
         resolveOverlaps, onChange, changed, select,
         selectMany, isSelected, splitClip, trackCount,
         applyInput, clipsOf, hasPicture,
         rippleTrim, rollCut, slipClip } from './project.js';
import * as inputsModel from './inputs.js';
import * as assemble from './sequence.js';
import { analyzeClip, pending } from './analysis.js';
import * as viewer from './viewer.js';
import * as output from './output.js';
import * as monitor from './monitor.js';
import * as timeline from './timeline.js';
import * as levels from './levels.js';
import * as exporter from './export.js';
// The one channel saying the Encode and Write stages are set to something else.
// Read from the module that owns the settings rather than through `exporter`,
// because it is the fact and `exporter` is the screen over it.
import { onSettingsChange } from './export/state.js';
import { initInspector, showProperties, showTransform, subjects } from './inspector.js';
import { clock, timecode, basename, bytes } from './format.js';
import { paintIcons, setIcon } from './icons.js';
import { filtergraph, renderGraph } from './filtergraph.js';
import { makeGraph, restore } from './graph/model.js';
import { derive } from './graph/derive.js';
import { print } from './graph/print.js';
import { layout, portY } from './graph/layout.js';
import { problems } from './graph/check.js';
import { supportsTimeline, parseEnable, printEnable, isOnAt } from './graph/enable.js';
import { padsOf } from './graph/filters.js';
import { socketAt } from './graph/canvas.js';
import { initGraphView, drawGraph, chaseGraph, graphSummary, graphPlacement,
         outrankedControls, tickGraph, graphKey, measureTo,
         currentGraph } from './graph/view.js';
import * as graphPreview from './graph/preview.js';
import { previewGraph, measureGraph } from './graph/subgraph.js';
import * as graphOverlay from './graph/overlay.js';
import * as graphPlayback from './graph/playback.js';
import * as shell from './shell.js';
import * as capture from './capture.js';
import { initSources, drawSources } from './sources.js';
import { transport, initTransport, setPlayhead, play, pause, togglePlay, step,
         applyAudioAll, tick as tickTransport } from './transport.js';
import * as command from './command.js';
import * as report from './report.js';
import { previewSpec, specSources } from './export/spec.js';
import { subtitleOrdinal, burnParams, burnAnchor, canBurn,
         cuesFor, cueWindow } from './export/subtitles.js';

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

// What the program monitor plays: each clip's input with that clip's own
// filters on it. The window is the **whole timeline**, because a clip outside
// the export range is still on the screen — and the origin is left to
// `buildSpec`, which puts it where the range starts, so a filter's `enable=`
// comes on at the moment the render will bring it on rather than a range's
// worth of seconds away from it. See ui/graph/playback.js.
graphPlayback.initPlayback({
    spec: () => previewSpec({ start: 0, end: Math.max(duration(), 1e-3) }),
    sources: specSources,
    overlay: graphOverlay.current,
});

// The other thing that can be on the program monitor: the render itself, made
// while you watch it, instead of one element per clip. See ui/output.js.
output.initOutput({ stage }, { changed: () => drawOutput() });

// And how loud what is leaving is, beside the picture. It reads the render's own
// mix while the preview is on and bro's master bus while it is not, which are two
// different claims and are labelled as such — see ui/monitor.js.
monitor.initMonitor({ levels: el('levels') });

initSources({
    list: el('src-list'),
    detail: el('src-detail'),
    foot: el('src-foot'),
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
    // One card per input, built and kept by capture.js — including the picture
    // and the marquee dragged on it, which is why neither is named here. A
    // fixed preview node would be one device's, and this stage reads several.
    cards: el('cap-cards'),
    add: el('cap-add'),
    comp: el('cap-comp'),
    meters: el('cap-meters'),
    graph: el('cap-graph'),
    bar: el('cap-bar'),
    note: el('cap-note'),
    options: el('cap-options'),
}, {
    flash,
    // The stage states what the graph says about this recording and offers the
    // door rather than a paragraph naming it: a filter belongs to the Graph
    // stage, and telling somebody to go there is worse than taking them.
    goTo: (id) => shell.goTo(id),
    // A recording is a file, and the arrow from Capture to Sources is followed
    // by opening it: the fastest way to see what you just recorded is to be
    // standing on the edit with it in front of you.
    open: (path) => { shell.goTo('compose'); open(path); },
    // What is set on this stage changes the two things that state it — the
    // spine's card, and the command underneath, which prints the capture as
    // the capture rather than the render.
    changed: () => { shell.drawSpine(); command.draw(); },
});

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
    // The graph stopped at one node, measured. Asked of the export workspace
    // for the reason the Report drawer's `Measure now` is: it owns the spec and
    // the one job slot, and there is one measurement render in this
    // application whatever part of the graph it is over.
    measure: (cut) => exporter.startMeasurement(cut),
    // Whether anything at all holds the one job slot — the host's render *and*
    // the workspace's own job, which stop being true a frame apart. What waits
    // on it is the measurement queue; see `runPending`.
    slotBusy: () => exporter.isRunning() || bro.ffmpeg.render.poll().state === 'running',
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
    // The canvas is what the output preview *is*, so a resize is both a
    // relayout and a different render — the second arrives on the change
    // channel, which is where `output.invalidate()` lives.
    canvasResized: () => { viewer.layout(); output.place(); updateCropUI(); syncUI(); },
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
    // The unsaved marker, for everything on this channel that is an *edit*.
    // Three things here are not one, and each for its own reason: a `selection`
    // is not in the document at all, an `analysis` is a waveform and a
    // filmstrip arriving off the worker minutes after the edit that asked for
    // them, and a `document` is the change a document *is* — it arrives here on
    // its way in and would otherwise mark a file unsaved the instant it was
    // opened.
    if (what !== 'selection' && what !== 'analysis' && what !== 'document')
        { doc.touch(); history.record(what); drawDocument(); }
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
    // And so is what the viewer is playing: a clip's filters are part of the
    // graph, and a clip moved along the timeline changes which moment its
    // filters think they are looking at.
    //
    // **Not while a drag is in flight.** Re-pointing an element builds a source,
    // a decoder and a filtergraph, and `move` arrives on every mouse move; the
    // `moved` that ends the drag is what puts it right. A clip whose filters are
    // a frame out of date for the length of a drag is a trade nobody notices,
    // and one that stalls under the cursor is a trade everybody does.
    //
    // This is also the one place that knows a drag is a drag, which is why
    // `defineSettled`'s "same chains, no work" rule stops short of it: moving a
    // clip moves the constant inside the `setpts` its chain carries, so every
    // mouse move is a chain nothing has settled before. Deciding that here costs
    // one settle per gesture; deciding it in there would mean the native half
    // knowing which parts of a chain are allowed to differ.
    if (what !== 'move') refreshPlayback();
});

/// Point the viewer's elements at the filtered inputs, where a clip has
/// filters this can show.
///
/// Here rather than inside the viewer because putting a re-pointed element
/// right is the transport's job — an element handed a new src is at zero with
/// the element's own volume — and the viewer deliberately does not reach for
/// the transport. Called from both change channels: the model's, above, and the
/// graph overlay's, which is where inserting a filter arrives.
function refreshPlayback() {
    const { moved: changedViews, resized } = graphPlayback.refresh();
    if (changedViews.length) {
        const moved = viewer.refreshSources(changedViews);
        if (moved.length) {
            applyAudioAll();
            setPlayhead(transport.t);
        }
    }
    // The `fx` badge is on the picture and says which clips are *not* showing
    // their filters, so it moves whenever the answer above does.
    viewer.refreshAll();
    // A clip whose chain resizes the picture is a clip of a different size, and
    // a size is upstream of every statement of the render: the rectangle the
    // clip is placed in, the `scale` the graph writes to reach it, the command
    // that prints both. Those are drawn on the model's channel, which runs
    // *before* this does — a view settles here — so a resize restates them
    // rather than leaving them a gesture out of date. Not `changed()`, which
    // would be an edit: nothing here is in the document.
    if (resized.length) {
        shell.drawSpine();
        command.draw();
        if (shell.currentStage() === 'graph') drawGraph();
    }
    // And the output preview is a render of the edit that has just changed, so
    // what is on the screen is of a render that no longer exists. It waits for
    // the edit to hold still before rebuilding — see `chase()` — so this is a
    // note rather than the work.
    output.invalidate();
}

// ── the output preview ─────────────────────────────────────────────────────
//
// The render on the program monitor instead of the clips. Everything about what
// it *is* lives in ui/output.js; here are the press, the key and the two things
// on the screen that have to follow it.

function setOutputPreview(on) {
    if (!output.setOn(on, transport.t)) return;
    viewer.setOutputMode(output.isOn());
    viewer.layout();
    output.place();
    // The preview is the clock while it is on and the clips are while it is not,
    // so both directions are a handover: whichever is taking over has to be put
    // where the playhead already is.
    setPlayhead(transport.t);
    if (transport.playing) { if (on) output.play(true); else play(); }
    drawOutput();
}

function drawOutput() {
    el('btn-output').classList.toggle('on', output.isOn());
    const note = el('out-note');
    const why = output.isOn() ? output.why() : '';
    note.textContent = why;
    note.classList.toggle('hidden', !why);
}

// A filter inserted, edited or taken off. The overlay has its own channel
// because a graph edit is not a change to the timeline, and this is the one
// thing outside the Graph stage that has to hear about it.
// ...and the document, for the same reason: a wire drawn is work, and it is the
// work the document exists to keep. `adopt` is the overlay a document just
// brought with it, so it is the one change on this channel that does not make
// the document unsaved.
graphOverlay.onChange((what) => {
    if (what !== 'adopt') { doc.touch(); history.record(what); drawDocument(); }
    refreshPlayback();
});

// ── the document ───────────────────────────────────────────────────────────
//
// The whole edit, saved and opened again. `ui/document.js` holds the object and
// the file; what is here is the three presses, the keys and everything that has
// to be put right afterwards — which is the same list `openBatch` puts right,
// because opening a document is opening files with the arrangement already
// decided.

doc.initDocument({
    attach: (clip) => { viewer.attachClip(clip); analyzeClip(clip); },
    detach: (clip) => viewer.detachClip(clip),
});

const docName = el('doc-name');

/// Put the screen back after the model has been replaced under it.
///
/// The half that is true of an undo as well as of an Open: the picture laid out
/// against a canvas that may be a different size, the crop handles over whatever
/// is selected now, the levels re-applied, and the encode side redrawn — because
/// it reads `settings` when it is drawn rather than on the model's change
/// channel, and `Ctrl-Z` works from the Write stage.
function documentApplied() {
    dropzone.classList.toggle('hidden', project.clips.length > 0);
    setControlsEnabled(project.clips.length > 0);
    viewer.layout();
    showProperties();
    updateCropUI();
    applyAudioAll();
    exporter.redraw();
    drawDocument();
}

/// And the half that is only true of an Open.
///
/// The two are separated by what an undo must *not* do. Fitting the ruler and
/// sending the playhead home is right for a document that has just arrived and
/// wrong for a step backwards inside the one in hand: undoing a crop while
/// looking at a shot two minutes in must leave you looking at that shot, at that
/// zoom. Same reason the history is reset here and not there.
function documentOpened(result) {
    timeline.fitView();
    setPlayhead(0);
    documentApplied();
    // A different edit, so there is nothing behind it worth going back to: an
    // undo across an Open would land in the middle of somebody else's document.
    history.reset();
    // What could not be laid out, named. A document with a file that has moved
    // is a document you still want the rest of — see `open()` — and the one
    // thing that must not happen is it opening short and saying nothing.
    const lost = (result && result.skipped) || [];
    if (lost.length)
        flash(lost.length === 1
                  ? `${lost[0].name}: ${lost[0].why}`
                  : `${lost.length} clips left out — see the Sources stage`);
    return result;
}

/// The name, and whether it has been touched since it was last written.
function drawDocument() {
    if (!docName) return;
    docName.textContent = doc.documentName();
    docName.classList.toggle('modified', doc.isModified());
}

/// Guarded the way the spine's doors are: a render or a recording holds the
/// host's one job slot, and replacing the timeline under one would leave it
/// rendering an edit that is no longer there. Returns true when it is safe.
function documentReady() {
    if (capture.isRecording()) { flash('A recording is running — stop it first'); return false; }
    if (!exporter.canLeave()) { flash('A render is running — stop it first'); return false; }
    return true;
}

function openDocument() {
    if (!documentReady()) return null;
    let result = null;
    try {
        result = doc.openDialog();
    } catch (e) {
        flash(String((e && e.message) || e));
        return null;
    }
    if (!result) return null;
    documentOpened(result);
    flash(`Opened ${doc.documentName()}`);
    return result;
}

function saveDocument(askWhere) {
    try {
        const path = askWhere ? doc.saveAs() : doc.saveHere();
        if (!path) return '';
        drawDocument();
        flash(`Saved ${doc.documentName()}`);
        return path;
    } catch (e) {
        flash(String((e && e.message) || e));
        return '';
    }
}

function newDocument() {
    if (!documentReady()) return false;
    doc.reset();
    documentOpened({ clips: [], skipped: [] });
    flash('New document');
    return true;
}

/// Which history a press belongs to: the stage you are standing on.
///
/// **The whole reason there are two.** A `Ctrl-Z` on the timeline that silently
/// reverted a codec three stages away would be worse than no undo; so would one
/// on the Write stage that quietly moved a clip. Asked here because the stage is
/// the shell's business and neither history knows one exists.
const historyTrack = () => {
    const at = shell.currentStage();
    return at === 'encode' || at === 'write' ? 'output' : 'edit';
};

/// One step back, and the screen put right afterwards.
///
/// Refused out loud rather than silently, because `Ctrl-Z` doing nothing is
/// indistinguishable from `Ctrl-Z` not being wired up — and this application had
/// no undo at all until now, so that is the reading somebody arrives with. The
/// refusal names the half it is about, since "nothing to undo" while the timeline
/// plainly has a stack behind it reads as a bug rather than as a boundary.
function stepHistory(back) {
    const which = historyTrack();
    if (back ? history.undo(which) : history.redo(which)) {
        if (which === 'edit') { documentApplied(); timeline.draw(); }
        return true;
    }
    const what = which === 'output' ? ' on this stage' : '';
    flash((back ? 'Nothing to undo' : 'Nothing to redo') + what);
    return false;
}

const btnUndo = el('doc-undo');
const btnRedo = el('doc-redo');

function drawHistory() {
    const which = historyTrack();
    if (btnUndo) btnUndo.disabled = !history.canUndo(which);
    if (btnRedo) btnRedo.disabled = !history.canRedo(which);
}
history.onChange(drawHistory);

// The settings changing is a step on the other track. One channel, announced by
// every one of the encode side's three consequence hooks — see
// `settingsChanged` in ui/export/state.js, which exists because recording this
// reliably was impossible while there were three places to listen and no
// guarantee of having found them all.
// **Undo and nothing else.** The obvious second consumer is the workspace, and
// it is deliberately not one: `remember()` runs when a render *starts*, so what
// carries into the next run is what you actually wrote a file with rather than
// whatever the form was last touched to. Writing it on every change looks like a
// free improvement and is not — an option bag belongs to the muxer it was set on,
// so a half-finished state saved on the way past comes back at boot attached to a
// container that has never heard of it, and "an unknown option is an error, not a
// shrug" then fails every render with a key nobody typed.
onSettingsChange(() => history.recordOutput());

// And what has to happen on the screen when they are put back. The form draws
// every control from `settings`, so an undo has changed the model behind its
// back in exactly the way a test that writes into `settings` does.
history.onOutputRestored(() => {
    exporter.redraw();
    shell.drawSpine();
    command.draw();
});

el('doc-open').addEventListener('click', openDocument);
el('doc-save').addEventListener('click', () => saveDocument(false));
el('doc-new').addEventListener('click', newDocument);
btnUndo.addEventListener('click', () => stepHistory(true));
btnRedo.addEventListener('click', () => stepHistory(false));
drawDocument();
drawHistory();

// A file named on the command line, handed over by the host binding. A document
// too: the same argument opens one, because "open this" is one act and which
// kind of file it is, is something the extension already says.
if (bro.ffmpeg.openOnStart) {
    const start = String(bro.ffmpeg.openOnStart);
    if (start.toLowerCase().endsWith(`.${doc.EXTENSION}`)) {
        try { documentOpened(doc.load(start)); }
        catch (e) { flash(String((e && e.message) || e)); }
    } else {
        open(start);
    }
}

// Everything above is where this edit started, so it is where the history
// starts. After `openOnStart`, because a file named on the command line is what
// you opened the application to look at rather than the first thing you did to
// it — an undo that took the picture away again would be answering a question
// nobody asked.
history.reset();

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
    // **The refusal is that there is nothing to play, not that there is no
    // picture.** A file with sound and no video is an ordinary clip: it
    // contributes to the mix and to nothing else, which is what a music bed
    // dropped on a timeline is. bro's `<video>` drives its clock from decoded
    // pictures where there are any and from the media clock where there are
    // not, so such a file reaches readyState 4, reports a duration off its
    // audio track and advances while it plays.
    if (!probe.video && !probe.audio) {
        flash('no audio or video track in this file');
        return null;
    }

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
function splitAtPlayhead() { splitAt(transport.t, true); }

/// The same cut, at a moment somebody handed over rather than at the playhead.
///
/// A measurement produces cut points — `blackdetect` found four stretches of
/// black, `scdet` found nine changes — and acting on one means cutting there,
/// which is this. It cuts every clip the moment falls inside rather than the
/// selection, because a list of moments is not a statement about what is
/// selected; `useSelection` is what the keyboard passes to keep `S` meaning
/// what it has always meant. Returns how many clips were actually cut, so a
/// caller applying nine points can say what happened rather than claiming nine.
function splitAt(t, useSelection) {
    const targets = ((useSelection && project.selection.length)
                        ? project.selection : clipsAt(t))
        .filter((c) => t > c.start + 1e-3 && t < c.start + c.length - 1e-3);
    if (!targets.length) {
        if (useSelection) flash('Nothing to split here');
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
    if (useSelection) flash(halves.length === 1 ? 'Split' : `Split ${halves.length} clips`);
    return halves.length;
}

function setLayout(mode) {
    if (project.layout === mode) return;
    project.layout = mode;
    el('btn-grid').classList.toggle('on', mode === 'grid');
    viewer.refreshAll();
    updateCropUI();
    showProperties();
    flash(mode === 'grid' ? 'Grid layout' : 'Stacked layout');
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
    // The document, from every stage, for the reason the report is: it is not
    // about any one of them. Above the per-stage handlers below so that Ctrl-S
    // saves while the Graph stage has the keyboard, and it takes the modifier so
    // that plain `s` goes on splitting a clip.
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        saveDocument(e.shiftKey);
        e.preventDefault();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        openDocument();
        e.preventDefault();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        newDocument();
        e.preventDefault();
        return;
    }
    // Undo from every stage, and the Graph stage is the one it is most wanted
    // on — a wire is work in the way a slider position is not. Both spellings of
    // redo, because both are somebody's muscle memory.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        stepHistory(!e.shiftKey);
        e.preventDefault();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        stepHistory(false);
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
        // `o` for output — the render on the monitor rather than the clips.
        case 'o':          setOutputPreview(!output.isOn()); break;
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
        output.place();
        updateCropUI();
    }
    // The output preview rebuilds only once the edit has held still, because
    // re-pointing it opens every input the render reads. Here rather than on the
    // change channel for exactly that reason — see ui/output.js.
    output.chase();
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
    tcCurrent.textContent = timecode(t, projectFps());
    tcDuration.textContent = timecode(d, projectFps());

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
el('btn-output').addEventListener('click', () => setOutputPreview(!output.isOn()));
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
            return 'Nothing on the timeline, and nothing in the graph says how long a ' +
                   'render would be — give a source a duration (d), or add a file';
        return null;
    },
    changed: (id, leaving) => {
        if (id === 'encode' || id === 'write') {
            exporter.prepare();
            // What `prepare()` fills in on the way over — a path, a size, the
            // codecs, and on a first run a whole preset — is the stage arriving
            // rather than a decision somebody took, so it becomes the baseline
            // instead of a step. An undo offering to go back to "no filename"
            // would be offering to undo having walked here.
            history.rebaseOutput();
        } else exporter.closeExport();
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
        // Which stack the buttons are about has just changed, even though
        // neither stack has.
        drawHistory();
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
}, {
    // The verbs. A measurement that can only be read is a number; one that can
    // be applied is a tool — and where it is applied is not the drawer. A crop
    // goes on the graph where cropping is done, cut points go on the timeline,
    // and loudnorm goes on the node beside the ebur128 that measured it. So the
    // reading happens in one place and the acting happens in another, which is
    // right, and these four calls are the whole of the join.
    splitAt: (t) => splitAt(t, false),
    seek: (t) => setPlayhead(Math.max(0, Math.min(duration(), t))),
    flash,
    // The size of the picture a measurement was taken *of*, which is the
    // render's and not the project canvas's: they differ for every preview, and
    // a crop that reaches every edge of a 320-wide render is not a crop that
    // reaches every edge of a 1920-wide one.
    picture: () => {
        const s = exporter.currentSettings();
        return { width: s.width || project.width, height: s.height || project.height };
    },
    // Running the graph over the range and keeping only what it measured. The
    // export workspace owns the spec and the one job slot, so it is asked
    // rather than a second spec being built here.
    measureNow: () => exporter.startMeasurement(),
    // What the edit *is*, right now, in the one form a render's own subject was
    // recorded in. Asked of the export workspace for the reason `measureNow` is
    // — it owns the spec — and asked at draw time rather than pushed on every
    // change, because the drawer is shut most of the time and nothing should be
    // rebuilding a spec behind it.
    subject: () => exporter.currentSubject(),
    // A filter put on the graph, or a value applied to one, is a change to the
    // edit in exactly the way dragging a clip is: the graph redraws, the
    // command bar reprints, and the spine re-counts.
    changed: () => changed('measure'),
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
        return [`${project.width}×${project.height} · ${projectFps().toFixed(0)}p`,
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
    // Where it goes, which is not always one filename. A `tee` has no path at
    // all — the destinations are the list — and a card that named `s.path`
    // there would name whatever file the muxer before it happened to leave
    // behind, which is the one thing this render is *not* writing.
    const dest = exporter.destination.isTee()
        ? `${(s.destinations || []).filter((d) => d.path).length} destinations`
        : (s.path ? basename(s.path) : '');
    return [s.container || '—', size || `${list}${dest ? ' · ' + dest : ''}`];
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
    // The edit as one object, plus the two presses that are not a dialog. A
    // test drives `save`/`load` with a path rather than `saveAs`/`openDialog`,
    // because SDL's pickers block the JS thread waiting for a person — so the
    // half that can be checked is the half either side of them.
    doc, documentOpened,
    // Undo, and the press that drives it. `history` is the model half and
    // `stepHistory` is that plus putting the screen back, which is the half a
    // test of "does the picture follow" has to go through — and the half that
    // knows which of the two stacks a press belongs to, since that is the stage
    // and the stage is the shell's.
    history, stepHistory,
    // The model's change channel. On the surface because the history's rule
    // about what counts as one step is stated in its vocabulary — a `move` is a
    // drag in flight and a `moved` is the end of one — and the only way to check
    // a rule about kinds is to send kinds, rather than to synthesise a drag and
    // hope it produced the pair.
    changed,
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
    timeline, viewer, levels,
    setCropMode, cropMode: () => cropMode,
    // The render on the program monitor. `setOutputPreview` rather than
    // `output.setOn` because turning it on is also a handover of the clock and a
    // relayout, and a test that pressed only half of that would be testing a
    // state the application never reaches.
    output, setOutputPreview,
    // The meter beside the viewer. On the surface because *which* of the two
    // things it is reading is the whole claim it makes about itself — the render's
    // own mix or bro's master bus — and that cannot be read off the bars.
    monitor,
    splitAtPlayhead, splitAt, setLayout, select, selectMany,
    // The three edits that are about a cut rather than a clip. On the surface
    // because they are pure model arithmetic — what each one holds constant is
    // the whole of what it is — and a test that had to synthesise an Alt-drag
    // to reach one would be testing the gesture rather than the edit.
    rippleTrim, rollCut, slipClip,
    showProperties, pending,
    // Burning a track into a clip, minus the panel. On the surface for the
    // reason `parseEnable` is: `si=` counts subtitle streams rather than
    // streams, which is a rule about shapes of file no fixture here has, and
    // the way to check a counting rule is to count something.
    // `cueWindow` is here on the same argument again: which cues a window keeps
    // differs between a copy and a conversion, and the way to check a rule
    // about which is to hand it rows of both kinds and count what survives.
    subtitles: { subtitleOrdinal, burnParams, burnAnchor, canBurn, cuesFor, cueWindow },
    exporter, capture,
    filtergraph, renderGraph, shell, command, report,
    // The graph beneath filtergraph(): tests written against the model itself
    // do not have to go through a spec and a printed string to reach it.
    graph: { makeGraph, restore, derive, print, layout, portY, problems, padsOf, socketAt,
             overlay: graphOverlay, draw: drawGraph, summary: graphSummary,
             placement: graphPlacement,
             outranked: outrankedControls, preview: graphPreview, previewGraph,
             measureGraph, measureTo, current: currentGraph,
             // What the viewer was last asked to play, per clip. The chain's
             // order and its clock are the two things that have to agree with
             // the render exactly, and a screenshot shows neither.
             playback: graphPlayback,
             // `enable=` as a set of spans and as the text it is. Pure, and on
             // the surface for the same reason the model is: the control and
             // the expression are one mechanism, and the only way to check that
             // is to round-trip one through the other without a screen.
             supportsTimeline, parseEnable, printEnable, isOnAt },
};
globalThis.__ffmpegBroReady = true;
