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
import { project, projectFps, isGenerator, duration,
         resolveOverlaps, changed, select, selectMany, trackCount,
         clipsOf, retainTracks, isTrackLocked, setTrackLocked, ripplesWith, sortClips,
         rippleTrim, rollCut, slipClip, rateStretch, trimClip,
         SPEED_MIN, SPEED_MAX, setSpeed, speedOf, sourceSpan, sourceTime, timelineTime } from './project.js';
import * as inputsModel from './inputs.js';
import * as generators from './generator.js';
import * as localcopy from './localcopy.js';
import * as assemble from './sequence.js';
import { pending } from './analysis.js';
import * as analysis from './analysis.js';
import * as viewer from './viewer.js';
import { pending as decodersPending, resident } from './residency.js';
import * as output from './output.js';
import * as softcues from './softcues.js';
import * as monitor from './monitor.js';
import * as find from './find.js';
import * as timeline from './timeline.js';
import * as levels from './levels.js';
import * as exporter from './export.js';
import { initInspector, showProperties, subjects } from './inspector.js';
import { clock, basename, bytes } from './format.js';
import { paintIcons } from './icons.js';
import { filtergraph, renderGraph } from './filtergraph.js';
import { makeGraph, restore } from './graph/model.js';
import { derive } from './graph/derive.js';
import { print } from './graph/print.js';
import { layout, portY } from './graph/layout.js';
import { problems } from './graph/check.js';
import { supportsTimeline, parseEnable, printEnable, isOnAt,
         shiftSpan } from './graph/enable.js';
import * as graphSpans from './graph/spans.js';
import { clockOf, onClock, onTimeline } from './graph/when.js';
import * as graphExpr from './graph/expr.js';
import { padsOf } from './graph/filters.js';
import { socketAt } from './graph/canvas.js';
import { initGraphView, drawGraph, graphSummary, graphPlacement,
         outrankedControls, measureTo, currentGraph, setFold } from './graph/view.js';
import * as graphPreview from './graph/preview.js';
import { previewGraph, measureGraph } from './graph/subgraph.js';
import * as graphOverlay from './graph/overlay.js';
import * as graphPlayback from './graph/playback.js';
import * as shell from './shell.js';
import * as capture from './capture.js';
import { initSources, drawSources } from './sources.js';
import { transport, setPlayhead, play, pause, step, applyAudioAll } from './transport.js';
import * as command from './command.js';
import * as report from './report.js';
import * as hardware from './hardware.js';
import { previewSpec, specSources } from './export/spec.js';
import { subtitleOrdinal, burnParams, burnAnchor, canBurn,
         cuesFor, cueWindow, cueTextFor, cueSaying } from './export/subtitles.js';
import {
    bindAppPlaybackContext, initAppPlayback,
    scheduleSeek, finalSeek, targetPlayheadTimeOf, seekCountOf,
    needs, busyWord, drawPending,
    setOutputPreview, syncOutputPicture, setSoftCues, drawOutput,
    documentOpened, openDocument, saveDocument, newDocument,
    stepHistory, drawHistory,
    open, openSpec, openInput,
} from './app-playback.js';
import {
    bindAppControlsContext, initAppControls,
    addGenerator, setGeneratorArgs, reloadInput, openBatch,
    removeSelection, splitAtPlayhead, splitAt, setLayout,
    setControlsEnabled, updateCropUI, syncUI, setCropMode, cropModeOf,
} from './app-controls.js';

const el = (id) => document.getElementById(id);

const viewerEl = el('viewer');
const stage    = el('stage');
const dropzone = el('dropzone');
const osd      = el('osd');
const docTitle = el('doc-title');
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

let osdTimer = 0;

// ── an input that has not answered yet ─────────────────────────────────────
//
// A six-hour recording is probed on a thread of its own, so an input added this
// frame has no `probe` on it and nothing can be cut from it yet. `openSpec`
// answers that by refusing and saying the input will be on the Sources stage,
// which is right for a URL somebody pasted and wrong for the finder: every file
// it adds is a long local recording, so refusing on the press would be an Add
// button that reliably did nothing the first time it was used.
//
// So the intent is held and finished when the answer lands. Checked on the frame
// loop rather than by polling, because that is the one place this application
// already looks at things that were not ready last time.
const awaitingProbe = [];

/// Do `then` once `input` can be read, or say why it never will be.
function waitForProbe(input, then) { awaitingProbe.push({ input, then }); }
function hasAwaitingProbes() { return awaitingProbe.length > 0; }

function settleProbes() {
    for (let i = awaitingProbe.length - 1; i >= 0; i--) {
        const w = awaitingProbe[i];
        if (w.input.error) {
            awaitingProbe.splice(i, 1);
            flash(`cannot read ${w.input.name}: ${w.input.error}`);
        } else if (w.input.probe) {
            awaitingProbe.splice(i, 1);
            w.then();
        }
    }
}

const sharedContext = {
    el, viewerEl, stage, dropzone, osd, docTitle, chips, xformPanel, stats,
    tcCurrent, tcDuration, scrub, scrubPlayed, scrubHead,
    btnStart, btnPrev, btnPlay, btnNext, btnEnd, btnLoop, btnMute, btnFull,
    rateSel, volume, volFill, volHead, cropbox,
    flash,
    scheduleSeek, finalSeek, needs, busyWord, drawPending,
    setOutputPreview, syncOutputPicture, setSoftCues,
    openDocument, saveDocument, newDocument, stepHistory,
    openSpec, settleProbes, hasAwaitingProbes,
    setControlsEnabled, updateCropUI, syncUI,
};
bindAppPlaybackContext(sharedContext);
bindAppControlsContext(sharedContext);

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

// And the third thing that can be over it: the output's soft subtitle tracks,
// drawn as the cues they are. Over the picture whichever picture it is — the
// clips or the render — because a soft track is a statement about the finished
// file either way. See ui/softcues.js for what it does and does not claim.
softcues.initSoftCues({ layer: el('cuelayer'), note: el('cuenote') });

// And how loud what is leaving is, beside the picture. It reads the render's own
// mix while the preview is on and bro's master bus while it is not, which are two
// different claims and are labelled as such — see ui/monitor.js.
monitor.initMonitor({ levels: el('levels') });

// Finding the material, which is the half of a supercut that is not editing.
// It knows where a moment is and nothing about how a clip is made, so laying
// one out is handed back here — see the block at the top of ui/find.js.
find.initFind({
    addToMix: (item) => {
        const input = inputsModel.inputs.find((i) => i.path === item.path)
            || inputsModel.addInput({ path: item.path, name: item.name });
        // The input may be opening still — a six-hour file probed cold — so the
        // clip is laid out when it can be, rather than refused for arriving
        // early. A found moment that silently added nothing would be the worst
        // failure this panel could have.
        const lay = () => {
            const clip = openInput(input, { quiet: true });
            if (!clip) return;
            clip.inPoint = Math.max(0, item.from);
            clip.length = Math.max(1 / Math.max(1, clip.fps), item.to - item.from);
            // After everything already there: the finder appends, because a list
            // auditioned in order is a mix assembled in that order.
            clip.start = project.clips.reduce(
                (n, c) => (c === clip || c.track !== clip.track
                           ? n : Math.max(n, c.start + c.length)), 0);
            sortClips();
            needs('timeline', 'spine', 'command', 'playback');
            changed('open');
        };
        if (input.probe) lay();
        else waitForProbe(input, lay);
    },
});

initSources({
    stage: el('st-sources'),
    list: el('src-list'),
    detail: el('src-detail'),
    foot: el('src-foot'),
    options: el('src-options'),
    add: el('src-add'),
    addPath: el('src-path'),
    browse: el('src-browse'),
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
    // Where a copy would go, for the card to say before anybody presses. The
    // resolver is here rather than in `ui/sources.js` for `saveLocally`'s
    // reason: one of the three answers is the document's own directory, and
    // that stage does not own the document.
    copiesGo: () => whereCopiesGo(),

    // A stream pulled off a page, written to this machine — the soundtrack
    // first, the picture behind it. Here rather than in `ui/sources.js` for the
    // one thing that stage does not own: where the files go, which is beside the
    // *document*.
    //
    // **It starts them and stays where it is.** This used to lay a clip out, walk
    // to the Write stage and fill a render in — because a copy is a render and
    // this application has one place where renders are described. That was right
    // about the description and wrong about the machinery: the render is the one
    // job slot, so a download held it for as long as it took, and the timeline
    // gained five hours of stream as a side effect of asking for a file. A fetch
    // is not a render (src/native/fetch_queue.h), so there is nothing to make
    // room for and nothing to walk to.
    saveLocally: (input) => {
        const why = localcopy.save(input, whereCopiesGo());
        if (why) return flash(`Cannot copy it: ${why}`);
        const job = localcopy.copiesOf(input);
        // Naming the folder in the sentence, because the press is the moment
        // somebody wants to know where it is going and the card is behind the
        // message. It says it on the card too — this is the same fact twice on
        // purpose, once where it is asked and once where it is looked up.
        flash(job.audio.state
                  ? `Pulling ${input.name} into ${whereCopiesGo()} — the soundtrack ` +
                    'first, then the picture. Both run in the background; the card ' +
                    'says where each has got to.'
                  : `Pulling ${input.name} into ${whereCopiesGo()}. It runs in the ` +
                    'background — nothing here waits for it, and the card offers to ' +
                    'stop it.');
    },
    // The same copy, described rather than started. Here for `saveLocally`'s
    // reason and one more: it walks to another stage, which is the shell's, and
    // it needs a clip because `exporter.prepare()` refuses an empty timeline —
    // right for every other render and beside the point for this one. Rather
    // than loosening that rule for one press, the press lays a clip out, and
    // only when this input has none *and* the timeline is empty: appending five
    // hours of stream to somebody's montage as a side effect of asking to read
    // a command is worse than refusing with a sentence.
    describeCopy: (input) => {
        if (!clipsOf(input).length) {
            if (project.clips.length)
                return flash('Use it on the timeline first — the Write stage describes the ' +
                             'edit, and adding it here would put five hours on the end of ' +
                             'what you have. Save a local copy needs none of that.');
            openInput(input, { quiet: true });
        }
        if (!shell.goTo('write')) return;
        const why = exporter.prepareLocalCopy(
            input, `${whereCopiesGo()}/${slugOf(input.name)}.mkv`, null);
        if (why) return flash(`Cannot copy it: ${why}`);
        const dropped = (exporter.lastLocalCopy() || {}).dropped || 0;
        flash(`${input.name} as a copy` +
              (dropped ? ` — leaving out ${dropped} data stream${dropped === 1 ? '' : 's'} ` +
                         'Matroska will not hold' : '') +
              '. Set a range on a row if you want part of it, then Render.');
    },
    changed: () => { changed('inputs'); },
});

/// A name that is a filename. Named after the input rather than after the signed
/// URL, which is five hundred characters of token and is not one.
function slugOf(name) {
    return String(name || 'stream')
        .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'stream';
}

/// Where a saved stream goes: the folder somebody chose, else beside the
/// document, else beside the application.
///
/// The directory only — what each pull is *called* is `ui/localcopy.js`'s, since
/// there are two of them and they must not land on one name.
///
/// **The chosen folder wins over the document's**, which is the opposite of how
/// a default normally gives way: it is the answer to "put my downloads on the
/// big disk", and a document saved somewhere else afterwards must not silently
/// move fourteen gigabytes of them. Choosing `Beside the document` clears it and
/// puts the first rule back.
function whereCopiesGo() {
    const chosen = localcopy.copyFolder();
    if (chosen) return chosen;
    const here = doc.documentPath();
    return here ? here.replace(/[/\\][^/\\]*$/, '') : '.';
}

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
    changed: () => needs('spine', 'command'),
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
    fold: el('gr-fold'),
    add: el('gr-add'),
    zoomIn: el('gr-zoom-in'),
    zoomOut: el('gr-zoom-out'),
    zoomLabel: el('gr-zoom'),
}, {
    flash,
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
        needs('spine', 'command');
        showProperties();
        viewer.refreshAll();
    },
});

initInspector({ chips, transform: xformPanel }, {
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
    cropHandlesOn: () => cropModeOf(),
    toggleCropHandles: () => setCropMode(!cropModeOf()),
    addFilter: (filterName) => {
        const list = subjects();
        if (!list.length) return;
        for (const clip of list) {
            const anchor = `clip:${clip.id}/audio`;
            if (!graphOverlay.inserts().some((ins) => ins.anchor === anchor && (ins.filter === filterName || ins.filterName === filterName))) {
                graphOverlay.insert(anchor, filterName);
            }
        }
        changed('edit');
        showProperties();
        viewer.refreshAll();
        timeline.draw();
    },
    hasFilter: (filterName) => {
        const list = subjects();
        return list.length > 0 && list.every((clip) => {
            const anchor = `clip:${clip.id}/audio`;
            return graphOverlay.inserts().some((ins) => ins.anchor === anchor && (ins.filter === filterName || ins.filterName === filterName));
        });
    },
    // Which of the panel's controls a lock on the graph has taken over. Asked
    // rather than pushed, because it is a function of the edit and the overlay
    // together and both move.
    outranked: outrankedControls,
    // A generator's arguments. Through a hook rather than done in the panel
    // because it is a reopen — a new registration, a new element, a picture that
    // may be a different size — and putting an element back is this file's.
    setGeneratorArgs: (clip, text) => setGeneratorArgs(clip, text),
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
        if (release) {
            finalSeek(t !== undefined ? t : transport.t);
            if (resumeAfterScrub) { resumeAfterScrub = false; play(); }
            return;
        }
        if (press) {
            if (transport.playing) { resumeAfterScrub = true; pause(); }
            setPlayhead(t);
            return;
        }
        scheduleSeek(t);
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
    manifest: el('ex-manifest'),
    warnings: el('ex-warnings'),
    progress: el('ex-progress'),
    cancel: el('ex-cancel'),
    go: el('ex-go'),
    goReason: el('ex-go-reason'),
}, {
    pause,
    flash,
    workspace: syncWorkspace,
    // "Back" from Write is a step along the chain, not a door out of a dialog.
    leave: () => shell.goTo('encode'),
    // Anything that changes what will be written changes the two things that
    // state it: the spine's cards and the command underneath them.
    described: () => needs('spine', 'command'),
    // The preview starts where you were looking, which is nearly always the
    // part of the render worth checking.
    playhead: () => transport.t,
    // Putting the result back on the timeline is a move along the chain as
    // well as an import: the fastest way to see what you just made is to be
    // standing on the edit with it in front of you.
    open: (path) => { shell.goTo('compose'); open(path); },
    // The same handler the Sources stage has, and for the same reason: `Choose
    // for me` on the Encode stage takes an input off its device, and an input
    // reopened is a different input under whatever is cut from it. One home for
    // what that costs — the elements, the waveforms and the playhead.
    reopened: reloadInput,
    finished: (p) => {
        if (p.state === 'done') flash(`Exported ${basename(p.path)}`);
        else if (p.state === 'cancelled') flash('Export stopped');
        else if (p.state === 'failed') flash(`Export failed: ${p.error}`);
    },
});

let resumeAfterScrub = false;

initAppPlayback();
initAppControls();

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
        // **Marked, not drawn.** Laying the graph out is the one arrival in this
        // application that is priced in the size of the edit — 187 ms at
        // seventy-five clips, and 668 with the folds opened — so drawing it
        // inside the press means the window does not change until it is over,
        // and what somebody sees is a button that did not work. Marked, the
        // stage is up on this frame and the graph arrives on a later one with
        // the readout saying which. `drawPending` only draws it while this stage
        // is the one showing, which it now is.
        if (id === 'graph') {
            graphPreview.setRange(transport.t, transport.t + graphPreview.previewSeconds);
            needs('graph');
        }
        needs('command');
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
    //
    // A recording holds the host's slot without the encode side's own flag ever
    // being set — it goes through `record.start`, which is a different call into
    // the same `ffmpeg_job.h` slot — so the refusal for one is here, where both
    // modules are visible. It matters twice over now that a measurement can start
    // itself: handed to the native side to refuse, an automatic re-measure would be
    // an exception thrown out of the frame loop.
    measureNow: () => (capture.isRecording()
        ? 'a recording is using the machine — stop it first'
        : exporter.startMeasurement()),
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
/// What the render will be has changed, so the two things that state it are out
/// of date: the spine's cards and the command underneath them.
///
/// **Marked rather than drawn** — see `needs`. Both restate the whole render out
/// of a spec built from every clip, which on a 75-clip edit is 0.8 s and 2.3 s,
/// and this is called from `closeExport()`, which every walk *away* from the
/// encode side goes through. Walking to the Sources stage drew both of them
/// twice, once here and once from the stage hook, for 6.5 s of the open.
function syncWorkspace() { needs('spine', 'command'); }

function flash(message) {
    osd.textContent = message;
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.add('hidden'), 1400);
}

// Tests drive the app through this rather than reaching for a DOM id that
// only exists while one particular clip is selected.
globalThis.__ffmpegBro = {
    project, transport, resolveOverlaps, find,
    open, openBatch, openInput, removeSelection,
    // A generator laid out on the timeline, and its arguments retyped. On the
    // surface because everything a test wants to check about one is downstream of
    // there being a clip — what it derives to, what the document does with it,
    // what the render makes of it — and the picker is a `<select>` whose whole
    // content is a walk of libavfilter's registry.
    addGenerator, setGeneratorArgs, isGenerator, generators,
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
    setPlayhead, scheduleSeek, finalSeek,
    targetPlayheadTime: targetPlayheadTimeOf,
    seekCount: seekCountOf,
    play, pause, step,
    timeline, viewer, levels,
    setCropMode, cropMode: cropModeOf,
    // The render on the program monitor. `setOutputPreview` rather than
    // `output.setOn` because turning it on is also a handover of the clock and a
    // relayout, and a test that pressed only half of that would be testing a
    // state the application never reaches.
    output, setOutputPreview,
    // The output's soft subtitle tracks, over the picture. On the surface whole
    // because the claim it makes is `showingAt(t)` — which cues are on screen at
    // a moment, and which of them are pictures nothing can draw — and that is a
    // pure answer about two clocks. Reading it off the stage would mean reading
    // rendered text to check arithmetic. `setSoftCues` beside it for
    // `setOutputPreview`'s reason: the press also redraws the button.
    softcues, setSoftCues,
    // The meter beside the viewer. On the surface because *which* of the two
    // things it is reading is the whole claim it makes about itself — the render's
    // own mix or bro's master bus — and that cannot be read off the bars.
    monitor,
    splitAtPlayhead, splitAt, setLayout, select, selectMany,
    // The three edits that are about a cut rather than a clip. On the surface
    // because they are pure model arithmetic — what each one holds constant is
    // the whole of what it is — and a test that had to synthesise an Alt-drag
    // to reach one would be testing the gesture rather than the edit.
    rippleTrim, rollCut, slipClip, rateStretch, trimClip,
    // How fast a clip runs, and the map that follows from it. On the surface for
    // the same reason those four are: it is pure model arithmetic, and what a
    // speed change *holds constant* — the footage the clip covers — is the whole
    // of what it is. `sourceTime`/`timelineTime` are the pair the two clocks are
    // read through, and a test that computed either for itself would be a fourth
    // copy of the map this commit exists to have one of.
    SPEED_MIN, SPEED_MAX, setSpeed, speedOf, sourceSpan, sourceTime, timelineTime, duration,
    // The sync lock. On the surface for the same reason those three are — which
    // tracks move together is model arithmetic and `ripplesWith` is the whole of
    // it — plus one this side has that they do not: the record is deliberately not
    // a list of tracks, and the way to check that a leftover entry cannot
    // resurrect a lane is to leave one behind and count the lanes.
    isTrackLocked, setTrackLocked, ripplesWith, retainTracks,
    showProperties, pending,
    // How many clips hold a decoder, and how many are waiting for one. On the
    // surface because the fact `ui/residency.js` exists to establish — that a
    // document opens with a bounded number of elements rather than one per clip
    // — is not visible in the model, the document or the screen. Counting the
    // elements is the only way to check it.
    resident, decodersPending,
    // Burning a track into a clip, minus the panel. On the surface for the
    // reason `parseEnable` is: `si=` counts subtitle streams rather than
    // streams, which is a rule about shapes of file no fixture here has, and
    // the way to check a counting rule is to count something.
    // `cueWindow` is here on the same argument again: which cues a window keeps
    // differs between a copy and a conversion, and the way to check a rule
    // about which is to hand it rows of both kinds and count what survives.
    // `cueTextFor` and `cueSaying` for a third: the words are joined to the times
    // by *when*, and the way to check that two lists line up is to ask both.
    subtitles: { subtitleOrdinal, burnParams, burnAnchor, canBurn, cuesFor, cueWindow,
                 cueTextFor, cueSaying },
    exporter, capture,
    // What has been pulled off a page onto this machine, and where each pull has
    // got to. On the surface because the claim it makes is about *order* — the
    // soundtrack lands first and the work that needs only sound can start against
    // it while the picture is still arriving — and order is a thing a test has to
    // watch happen rather than read off a card.
    localcopy,
    // What a clip looks and sounds like, and how much of it has been read. On
    // the surface because the claim it makes is about *how little* is read for
    // an input on a link — a lane that fills in for the span on screen and no
    // further — and "no further" is only checkable by asking what was read.
    analysis,
    // What this machine turned out to have, and the rule applied to it. On the
    // surface because the rule is a *pure* answer — a decision plus the sentence
    // that pays for having taken it — and reading it off the note under the button
    // would mean pressing the button to find out what it was going to do.
    hardware,
    filtergraph, renderGraph, shell, command, report,
    // The graph beneath filtergraph(): tests written against the model itself
    // do not have to go through a spec and a printed string to reach it.
    graph: { makeGraph, restore, derive, print, layout, portY, problems, padsOf, socketAt,
             overlay: graphOverlay, draw: drawGraph, summary: graphSummary,
             placement: graphPlacement, setFold,
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
             supportsTimeline, parseEnable, printEnable, isOnAt, shiftSpan,
             // Every span in the edit, on the timeline's clock — what the When
             // lane is drawn from. On the surface beside the model above and for
             // the same reason: the list, the two-way clock mapping and the
             // write-back are pure, and the way to check that a region on the
             // lane is the span the expression describes is to read one against
             // the other without a screen.
             spans: graphSpans,
             // Which clock a node's `t` is on, and the map between that clock and
             // the timeline's, both ways. On the surface because it is the one
             // answer *both* readers of it take — the When strip in the column and
             // the When lane on the timeline — so a wrong answer here is one they
             // would agree about: the only way to catch that is to ask it
             // directly, rather than to compare two screens that cannot disagree.
             when: { clockOf, onClock, onTimeline },
             // A filter option written as an expression: what libav makes of it,
             // and the one shape of it this application also writes. On the
             // surface for the reason `parseEnable` is — the control and the text
             // are one mechanism, and the only way to check that a generator
             // reads back what it wrote is to round-trip one through the other
             // without a screen. It carries the evaluation too, which is the half
             // that has to be libav's rather than a second opinion.
             expr: graphExpr },
};
globalThis.__ffmpegBroReady = true;
