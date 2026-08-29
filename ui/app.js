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
import { project, projectFps, makeClip, makeGenerator, applyGenerator, isGenerator,
         addClip, removeClip, duration, clipsAt,
         resolveOverlaps, onChange, changed, select,
         selectMany, isSelected, splitClip, trackCount,
         applyInput, clipsOf, hasPicture, retainTracks,
         isTrackLocked, setTrackLocked, ripplesWith, sortClips,
         rippleTrim, rollCut, slipClip, rateStretch, trimClip,
         SPEED_MIN, SPEED_MAX, setSpeed, speedOf, sourceSpan, sourceTime, timelineTime } from './project.js';
import * as inputsModel from './inputs.js';
import * as generators from './generator.js';
import * as localcopy from './localcopy.js';
import * as assemble from './sequence.js';
import { analyzeClip, pending, tickAnalysis } from './analysis.js';
import * as analysis from './analysis.js';
import * as viewer from './viewer.js';
import { initResidency, tick as tickResidency,
         pending as decodersPending, resident } from './residency.js';
import * as output from './output.js';
import * as softcues from './softcues.js';
import * as monitor from './monitor.js';
import * as find from './find.js';
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
import { supportsTimeline, parseEnable, printEnable, isOnAt,
         shiftSpan } from './graph/enable.js';
import * as graphSpans from './graph/spans.js';
import { clockOf, onClock, onTimeline } from './graph/when.js';
import * as graphExpr from './graph/expr.js';
import { padsOf } from './graph/filters.js';
import { socketAt } from './graph/canvas.js';
import { initGraphView, drawGraph, chaseGraph, graphSummary, graphPlacement,
         outrankedControls, tickGraph, graphKey, measureTo,
         currentGraph, setFold } from './graph/view.js';
import * as graphPreview from './graph/preview.js';
import { previewGraph, measureGraph } from './graph/subgraph.js';
import * as graphOverlay from './graph/overlay.js';
import * as graphPlayback from './graph/playback.js';
import * as shell from './shell.js';
import * as capture from './capture.js';
import { initSources, drawSources, tickSources } from './sources.js';
import { transport, initTransport, setPlayhead, play, pause, togglePlay, step,
         applyAudioAll, parkClip, tick as tickTransport } from './transport.js';
import * as command from './command.js';
import * as report from './report.js';
import * as hardware from './hardware.js';
import { previewSpec, specSources } from './export/spec.js';
import { subtitleOrdinal, burnParams, burnAnchor, canBurn,
         cuesFor, cueWindow, cueTextFor, cueSaying } from './export/subtitles.js';

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
    cropHandlesOn: () => cropMode,
    toggleCropHandles: () => setCropMode(!cropMode),
    addFilter: (filterName) => {
        const clip = project.selected;
        if (!clip) return;
        const anchor = `clip:${clip.id}/audio`;
        graph.insert(anchor, filterName);
        changed('edit');
        viewer.refreshAll();
        timeline.draw();
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

// ── what has to be redrawn, drawn once a frame ─────────────────────────────
//
// Every one of these restates the *whole* edit: the timeline draws a lane per
// clip, the spine and the command bar each build a render spec out of all of
// them, and `refreshPlayback` settles a filter chain per clip. Each is therefore
// priced in the size of the project: at seventy-five clips they are 0.6 s,
// 0.5 s, 0.8 s and 2.3 s.
//
// That is affordable once and ruinous several times, and opening a document did
// it several times: the overlay a document brings says so on its own channel,
// the document says so on the model's, the session restores a selection which
// says so again, and the stage it walks to draws itself on the way in. Measured
// on a 75-clip montage, that was 8.0 s inside `doc.load()` alone — with no
// decoders built and no analysis started, so none of it was the files.
//
// So a change *marks* what is now out of date and the frame loop draws it, which
// collapses any number of changes in one turn into one redraw. It is the same
// move the derived channels make one paragraph down, and it has the same second
// benefit: an edit on a large project is one redraw per frame rather than one
// per gesture, which is the difference between a timeline that drags and one
// that stutters.
//
// **`refreshPlayback` is in here and is not only drawing** — it re-points
// elements at their filtered sources — so putting it off by a frame is a real
// change and not a cosmetic one. It is the change this file already argued for
// in the other direction: a drag deliberately skips it entirely, because "a clip
// whose filters are a frame out of date is a trade nobody notices, and one that
// stalls under the cursor is a trade everybody does".
//
// **The Sources stage is deliberately not in here.** It is the one whole-edit
// redraw that is not priced in the size of the project: seventy-five inputs draw
// in 7 ms, because the list is one row each and the detail column is the
// *selected* input only. Marking it would buy nothing and would make a drop's
// card arrive a frame after the drop, which is a real thing to be able to
// assert.
const dirty = {
    playback: false, timeline: false, readouts: false, spine: false,
    command: false, document: false, graph: false, seek: false,
};

// ── one seek per frame, and one more at the end of the gesture ─────────────
//
// **A drag is a stream of positions; a seek is a decode.** A mouse hands over a
// move per pixel and `setPlayhead` opens, seeks and settles every clip under the
// playhead, so a scrub that answered each one did that work tens of times
// between two drawn frames and the window stopped answering — the thing the
// worker thread underneath cannot fix, because the work was asked for rather
// than being slow.
//
// So a moving hand *marks* where it wants to be and the frame loop performs the
// last one (`drawPending`, with the five redraws), which is the same rule
// everything else on that list follows. The gesture's end is not marked but
// performed: `finalSeek` is where the playhead actually settles, and a release
// that only marked would leave the last position waiting on a frame that a
// stopped hand no longer causes.
let targetPlayheadTime = null;
/// How many seeks have actually been performed. Read by tests/ui_load.js, which
/// asserts the whole of the above: no seeks between two frames however many
/// moves arrive, and at most one on the frame that follows.
let seekCount = 0;

/// Where the playhead wants to be, to be answered on the next frame.
function scheduleSeek(t) {
    if (t === undefined || t === null) return;
    targetPlayheadTime = Number(t);
    needs('seek');
}

/// Where the playhead is, now — the end of a gesture, and anything else that is
/// a decision rather than a hand moving. Cancels a marked one: the last position
/// is this one.
function finalSeek(t) {
    targetPlayheadTime = null;
    dirty.seek = false;
    const target = (t !== undefined && t !== null && !Number.isNaN(Number(t))) ? Number(t) : transport.t;
    seekCount++;
    setPlayhead(target);
}

/// Mark one or more of them out of date.
function needs(...what) { for (const k of what) dirty[k] = true; }

/// The five that are priced in the size of the edit, and how to draw one.
///
/// Playback is first because settling a chain can resize a picture and move the
/// playhead, and every one below it draws one or the other. The graph is last
/// because it is the only one that is usually not on the screen at all.
const HEAVY = [
    ['playback', () => refreshPlayback()],
    ['timeline', () => timeline.draw()],
    ['spine',    () => shell.drawSpine()],
    ['command',  () => command.draw()],
    // Only while it is up: everything the layout measures is zero behind a
    // `display:none`, and it is rebuilt on the way in anyway.
    ['graph',    () => { if (shell.currentStage() === 'graph') drawGraph(); }],
];
let turn = 0;

/// How long each of them took the last time it was drawn, and what to call it
/// while it is owed.
///
/// **Measured rather than predicted, which is the whole point.** The obvious
/// design is a rule — "over N clips, show a spinner" — and it is wrong twice: N
/// is a guess about somebody else's machine, and the number that actually
/// matters is not the clip count but what the redraw *costs*, which differs by a
/// factor of thirty between these five and by another factor between a laptop
/// and this one. So each draw times itself and the readout speaks when the last
/// one was slow. It calibrates itself, it says which thing is late rather than
/// spinning, and on a small edit it never appears at all.
const took = {};
const BUSY_WORDS = {
    playback: 'settling playback',
    timeline: 'redrawing the timeline',
    spine: 'restating the render',
    command: 'restating the command',
    graph: 'laying out the graph',
};

/// Above this, a redraw is worth saying out loud. Well past a frame at 60 Hz, so
/// nothing that keeps up ever speaks, and well under the point at which somebody
/// has decided the window is broken.
const BUSY_MS = 120;

/// What is out of date and known to be slow, as a phrase — or '' for the case
/// this is designed to be, which is everything keeping up.
///
/// The slowest owed thing rather than a list: two of them are usually owed at
/// once and "restating the render, restating the command, laying out the graph"
/// is a sentence nobody reads. What somebody wants to know is that the window is
/// working and roughly on what.
///
/// **The first slow draw is silent, and that is not a bug to be fixed.** Nothing
/// can be said about how long something takes until it has taken it once, and
/// the alternative — guessing from the clip count — is the thing this measures
/// its way out of. What it costs is that the very first arrival at a large graph
/// says nothing and every one after it does, which is the right way round: the
/// first is one frame late and the rest are the ones somebody is waiting on.
function busyWord() {
    let word = '', worst = BUSY_MS;
    for (const key of Object.keys(BUSY_WORDS))
        if (dirty[key] && (took[key] || 0) > worst) { worst = took[key]; word = BUSY_WORDS[key]; }
    return word;
}

/// Draw whatever is out of date: the cheap ones always, and **one** of the
/// expensive ones. Called once a frame, from the frame loop.
///
/// Marking instead of drawing collapsed a document's several redraws into one —
/// and then that one landed in a single frame of 5.6 s, which is the same freeze
/// one level up and wants the same answer. So the burst is spread: the window
/// keeps taking input while a large edit finishes drawing itself, and a
/// seventy-five-clip document arrives over a handful of frames instead of
/// stopping the world for one.
///
/// **Round-robin rather than in priority order**, and that is the load-bearing
/// part. Straight priority starves: readings landing off the analysis worker
/// mark the timeline on *every* frame for as long as a large document is being
/// read, so a command bar below it in a fixed order would go minutes without
/// being drawn — and a command bar that does not say what will be rendered is
/// the one failure this application refuses to have. Starting each pass where
/// the last one stopped means every marked thing is drawn within a turn of the
/// wheel, whatever else is being marked.
function drawPending() {
    // Before the five, and in full rather than in rotation: it is what the rest
    // of the frame draws *from*, and a redraw of a playhead position that is
    // about to change is a redraw thrown away. See `scheduleSeek`.
    if (dirty.seek) {
        dirty.seek = false;
        if (targetPlayheadTime !== null) {
            const t = targetPlayheadTime;
            targetPlayheadTime = null;
            seekCount++;
            setPlayhead(t);
        }
    }
    // The cheap two, always and in full: a readout is a line of text and the
    // document's name is two words.
    if (dirty.readouts) { dirty.readouts = false; syncUI(); }
    if (dirty.document) { dirty.document = false; drawDocument(); }
    for (let i = 0; i < HEAVY.length; i++) {
        const [key, draw] = HEAVY[(turn + i) % HEAVY.length];
        if (!dirty[key]) continue;
        dirty[key] = false;
        turn = (turn + i + 1) % HEAVY.length;
        // Timed on the way past, which is what `busyWord` reads. The cost of
        // asking is one clock read per frame and it buys the only honest answer
        // to "is this one of the slow ones" — measuring this machine drawing
        // this edit.
        const at = Date.now();
        draw();
        took[key] = Date.now() - at;
        return;
    }
}

onChange((what) => {
    // ── the three channels that are not edits ──
    //
    // A waveform or a filmstrip arriving off the analysis worker, a telemetry
    // track parsed on its thread, a run of sound marks measured on another.
    // Everything below this line is about *an edit having happened* — pruning
    // what an edit can orphan, marking the file unsaved, restating the render —
    // and none of it is true of a measurement landing. The rest of this function
    // already knew that and said so three times over, in the three places it
    // excluded them one at a time; what it did not do was stop early, so each
    // one still rebuilt the Sources cards, the spine, the command bar, the
    // export rows and every element's source.
    //
    // That is what froze the window on a large document. Seventy-five clips
    // answer with a hundred and fifty of these, they arrive in one drain, and at
    // twenty-two clips the drain was a **single frame of 12.9 s** against a
    // median frame of 1 ms. The only thing on the screen that draws any of the
    // three is the timeline, and even that is marked rather than drawn, because
    // a hundred and fifty redraws of the same lanes in one frame is the same
    // mistake one level down.
    if (what === 'analysis') {
        // ...and the readouts, which count how many clips are still being read.
        needs('timeline', 'readouts');
        return;
    }

    // **A clip being dragged is not a clip that has moved**, and the difference
    // is what this whole block costs. `move` arrives per mouse move and `moved`
    // once, at the end of the gesture, so everything here that is a pass over
    // the *whole* edit waits for the second one — the overlay's retain, the
    // Write stage's copied rows, the encode side's baseline, the Sources cards
    // and the unsaved marker below. None of it can miss anything: a `moved`
    // always follows, and `history.record` already ignores a `move` for the same
    // reason and says so.
    if (what !== 'move') {
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
        // And the settings of a track the timeline no longer shows — a sync lock on
        // V4 after the last clip on it was deleted. Here for the same argument as the
        // line above and stated where that argument already is: a track can empty out
        // through a delete, a drag to another lane, a batch drop that clears the
        // timeline, an undo and an opened document, and the one that gets missed is
        // the one that leaves a lock nothing on screen accounts for. Before
        // `history.record` below, so the pruning is part of the step that caused it
        // rather than a change that arrives on its own afterwards.
        retainTracks();
        // And the copied rows on the Write stage that follow a clip. Same shape of
        // problem as the line above and answered in the same place for the same
        // reason: a trim, a move, a ripple, an undo and an opened document all arrive
        // here, and a row updated in four of those and not the fifth would be a span
        // that is right most of the time. A clip that has gone breaks the link and is
        // said out loud — a row left naming an id nothing answers to is the invisible
        // mode the press this replaces was written against.
        const followed = exporter.followTimeline();
        if (followed.broke.length)
            flash(followed.broke.length === 1
                      ? followed.broke[0].why
                      : `${followed.broke.length} copied rows stopped following a clip that has gone`);
        // The Write stage's settings have just changed without anybody having decided
        // anything, so the encode side's history takes them as the baseline rather than
        // offering to go back to a span that describes a trim the timeline no longer
        // has. Same call and same reason as arriving on the encode side.
        if (followed.moved || followed.broke.length) history.rebaseOutput();
    }
    // The unsaved marker, for everything on this channel that is an *edit*.
    // Three things here are not one, and each for its own reason: a `selection`
    // is not in the document at all, an `analysis` is a waveform and a
    // filmstrip arriving off the worker minutes after the edit that asked for
    // them, and a `document` is the change a document *is* — it arrives here on
    // its way in and would otherwise mark a file unsaved the instant it was
    // opened. `telemetry` is the fourth and joins `analysis`: a reading is what
    // a file says, it is not in the document for that reason, and a track
    // parsed a minute after the cut that used it did not change the edit.
    // `marks` is the fifth and joins it exactly: a detected onset is a
    // measurement of a soundtrack, and undo answers "does this change the
    // clips".
    if (what !== 'selection' && what !== 'analysis' && what !== 'document' && what !== 'move')
        { doc.touch(); history.record(what); needs('document'); }
    if (what === 'selection' || what === 'moved') {
        showProperties();
        // The selection ring lives on the picture, so a change of selection is
        // a change to the stage as well as to the panel.
        if (what === 'selection') viewer.refreshAll();
        else finalSeek(transport.t);
    } else if (what === 'move') {
        scheduleSeek(transport.t);
    }
    // The spine states the whole render and the command states it exactly, so
    // both are downstream of every change to the model — not just the ones
    // made on the encode side. The Sources stage is downstream of the same
    // thing: which files are on the timeline. And so is the graph, which is the
    // same statement as the command bar's drawn as the shape it is.
    //
    // All of them are *marked* rather than drawn — see `needs` above. They used
    // to be drawn here, which is what made one change to a large edit cost a
    // second and a document's several changes cost eight.
    needs('timeline', 'readouts', 'spine', 'command', 'graph');
    // Drawn rather than marked — see `dirty`: it is cheap, and a card that
    // arrived a frame after the file did would be a worse thing to explain than
    // the 7 ms it costs.
    if (what !== 'move') drawSources();
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
    // And a measurement in the drawer is now about a render that no longer
    // describes this. Told rather than asked, because the drawer is shut most of
    // the time and nothing should be rebuilding a spec behind it — see
    // `editMoved()`, which notes the moment and waits for the edit to hold still.
    report.editMoved();
    if (what !== 'move') needs('playback');
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
    if (resized.length) needs('spine', 'command', 'graph');
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
    if (!output.setOn(on, transport.t, 'user')) return;
    // The preview is the clock while it is on and the clips are while it is not,
    // so both directions are a handover: whichever is taking over has to be put
    // where the playhead already is.
    setPlayhead(transport.t);
    if (transport.playing) { if (on) output.play(true); else play(); }
    // The picture itself follows from the frame loop — see `syncOutputPicture`,
    // which is the one place that decides it now that a press is no longer the
    // only thing that can put a render on the canvas.
    syncOutputPicture();
    drawOutput();
}

/// Which picture is on the canvas: the render, or the clips.
///
/// **Asked rather than pushed, because there are two ways to get a render onto
/// it and only one of them is a press.** `O` is somebody choosing to look at the
/// output; playback engages the same source because one source has no cut in it
/// to hitch on (see `play()` in ui/transport.js). Driving the viewer from the
/// press alone would leave the clips on screen underneath a render that
/// playback had built.
///
/// **`isShowing`, not `isOn` and not `ready`.** Engaging a render takes over a
/// second on a large edit and the clips are what is being watched for the whole
/// of that, so `isOn` would black the canvas on the play button. And a render
/// kept warm after playback stopped is `ready` without being watched, so that
/// would leave the clips hidden behind a still picture nobody is at.
let showingRender = false;
function syncOutputPicture() {
    const want = output.isShowing();
    if (want === showingRender) return;
    showingRender = want;
    viewer.setOutputMode(want);
    viewer.layout();
    output.place();
    // The strip beside the picture meters whichever mix is authoritative, and
    // that has just changed hands.
    needs('readouts');
    drawOutput();
}

/// The soft tracks over the picture, or not.
///
/// A separate switch from `O` and not a part of it, because the two answer
/// different questions: `O` is *which picture* is on the monitor, and this is
/// whether the stream written beside that picture is drawn over it. A soft track
/// is a fact about the finished file whether you are watching the clips or the
/// render, so it is over both.
function setSoftCues(on) {
    if (!softcues.setOn(on)) return;
    // Immediately rather than on the next frame: this is a press, and a third of
    // a second of nothing reads as the mode not working.
    softcues.tick(transport.t);
    el('btn-cues').classList.toggle('on', softcues.isOn());
}

function drawOutput() {
    // **`isWanted`, not `isOn`.** The button is the *mode* — did somebody choose
    // to watch the output — and playback engaging the same render for its own
    // reasons must not light it up, or pressing play would appear to have
    // switched a mode nobody asked for and pausing would appear to switch it
    // back.
    el('btn-output').classList.toggle('on', output.isWanted());
    const note = el('out-note');
    // The complaint, though, is about whatever is on the canvas whoever put it
    // there: a render that will not build is worth saying so about while
    // playback is the one that asked for it.
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
    if (what !== 'adopt') { doc.touch(); history.record(what); needs('document'); }
    // **A pin is where a card sits on this screen, and stops there.** It is in the
    // document — a node dragged somewhere deliberate should still be there
    // tomorrow, and should come back with an undo — but nothing below this line
    // is about the *edit*, and a node's position cannot reach any of it. Letting
    // it through cost the two redraws that are priced in the size of the project:
    // at 75 clips the timeline is 0.5 s and the playback settle is 0.6 s, so
    // moving one box on the graph queued a second of work about a filter chain
    // that had not changed and a lane that draws none of this.
    if (what === 'pin') return;
    // The graph is half of what a measurement's subject *is* — `renderSubject()`
    // keeps the printed chain — so a filter inserted or edited moves the edit under
    // every finding in the drawer exactly as dragging a clip does.
    report.editMoved();
    // And the timeline, because the graph now draws part of itself there: a filter
    // whose `enable=` turns it on for a span has a row on the When lane, and the
    // lane exists exactly when there are spans. This is the one channel every way
    // of changing that arrives on — the column beside the graph, the lane itself,
    // an undo, and a document being opened — so it is the one place the redraw
    // belongs. Marked rather than drawn, for the reason `needs` gives: `adopt` is
    // a document arriving, and drawing here made that 3.5 s of the open on a
    // 75-clip edit whose graph was empty.
    needs('timeline', 'playback');
});

// ── the document ───────────────────────────────────────────────────────────
//
// The whole edit, saved and opened again. `ui/document.js` holds the object and
// the file; what is here is the three presses, the keys and everything that has
// to be put right afterwards — which is the same list `openBatch` puts right,
// because opening a document is opening files with the arrangement already
// decided.

doc.initDocument({
    // **Not an attach any more, and the name is the document's rather than the
    // viewer's.** What the document is saying is that this clip's source has
    // changed under it — a new clip, a reopened input, a generator with new
    // arguments — and the two things that follow from that are read again. The
    // *element* is not one of them: which clips hold a decoder is the playhead's
    // business now (ui/residency.js), and a document that built one per clip is
    // what made opening this montage 26 s of frozen window and 9.1 GB.
    //
    // A clip that already has an element does get it rebuilt, because a src that
    // has changed under a live decoder is the one case `refreshSources` cannot
    // reach: the token is the same string.
    attach: (clip) => {
        if (clip.video) { viewer.detachClip(clip); viewer.attachClip(clip); }
        // Read once, when the source changes, and kept on the clip rather than on
        // the element — so the lanes survive the decoder being evicted.
        analyzeClip(clip);
    },
    detach: (clip) => viewer.detachClip(clip),
    // Where you were in the edit, which is the one part of a document that lives
    // in four different modules and in none of the model. Asked here because this
    // is the only file that knows all four exist — the same reason `attach` is a
    // hook rather than an import.
    session: () => ({
        clip: project.selected ? project.selected.id : 0,
        playhead: transport.t,
        stage: shell.currentStage(),
        view: timeline.getView(),
    }),
});

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
/// The two are separated by what an undo must *not* do. Putting the ruler and the
/// playhead somewhere is right for a document that has just arrived and wrong for
/// a step backwards inside the one in hand: undoing a crop while looking at a shot
/// two minutes in must leave you looking at that shot, at that zoom. Same reason
/// the history is reset here and not there.
///
/// **Where it puts them is what the document says**, when the document says —
/// see `session` in ui/document.js. A `.fbro` is a handoff of work in progress, so
/// it opens where the last person left off: their clip selected, their playhead,
/// their stage, their zoom. A document that carries no session — one written before
/// there was one, one hand-written, and every state `open()` is handed by the
/// history or by `reset()` — falls back to the top of the timeline fitted, which is
/// what this always did.
function documentOpened(result) {
    const was = (result && result.session) || null;
    if (was) enterSession(was);
    else { timeline.fitView(); setPlayhead(0); }
    documentApplied();
    // The stage last, so that whatever it does on the way in — `prepare()` on the
    // encode side, building the graph, opening the capture devices — happens over
    // a screen that is already the document's.
    if (was && was.stage) shell.goTo(was.stage);
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

/// Stand where a document says it was being worked on.
///
/// Everything except the stage, which `documentOpened` does last for the reason
/// stated there.
///
/// The clip is already sanitised to an id this edit has, or to zero — see
/// `readSession()`. `select(null)` for zero rather than leaving whatever was
/// selected before: opening a document is a replacement, and a selection left over
/// from the previous edit would be pointing the crop handles at a shot from it.
///
/// The playhead is clamped to the edit rather than trusted. A document written
/// against footage that has since been re-encoded shorter names a moment past the
/// end of it, and a playhead there is a viewer with no clip under it.
function enterSession(s) {
    const clip = s.clip ? project.clips.find((c) => c.id === s.clip) : null;
    select(clip || null);
    setPlayhead(Math.max(0, Math.min(s.playhead, Math.max(0, duration()))));
    // A document that named no window is answered the way one with no session at
    // all is: the whole edit, fitted. Kept as two cases rather than clamped into
    // one, because a span of zero is "did not say" and not "a window of nothing".
    if (!timeline.setView(s.view.start, s.view.span)) timeline.fitView();
}

/// The name, and whether it has been touched since it was last written.
function drawDocument() {
    if (!docTitle) return;
    docTitle.textContent = doc.documentName();
    docTitle.classList.toggle('modified', doc.isModified());
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
    if (result.isDocument) {
        documentOpened(result.data);
        flash(`Opened ${doc.documentName()}`);
        return result.data;
    }
    if (result.path) {
        const clip = open(result.path);
        if (clip) {
            needs('timeline', 'readouts', 'spine', 'command');
            viewer.refreshAll();
            flash(`Added ${basename(result.path)}`);
        }
        return clip;
    }
    return null;
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
    needs('spine', 'command');
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
    // A URL is opened on a thread of its own and has no answer yet, so there is
    // nothing to cut a clip from — and *nothing has gone wrong*. It stays on
    // the Sources stage, where the open is visible and `Use on the timeline` is
    // waiting for it, rather than being removed as a file that would not read.
    if (inputsModel.opening(input)) {
        flash(`connecting to ${input.name} — it will be on the Sources stage when it answers`);
        return null;
    }
    const clip = openInput(input, opts);
    // An input that was made here and turned out to be unusable goes away
    // again; one that was already on the list stays, because somebody put it
    // there.
    if (!clip && !existing) inputsModel.removeInput(input);
    return clip;
}

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

    // **A live device is refused first, and on what it is rather than on what
    // it measures.** This used to be one of three answers to "no length", which
    // let a device through the moment somebody set `Stop at` on it: `-t` is what
    // gives an endless input a length — the same rule `-loop 1` follows — so the
    // length question stopped asking, and a camera landed on the timeline as an
    // ordinary clip. It very nearly worked, which is the reason it has to be
    // refused rather than left: the compositor asks a source for the picture at
    // `inPoint + (t − start) × speed`, and a device answers only for now. Every
    // seek the viewer makes comes back `Invalid argument` — a libavdevice
    // demuxer has no `read_seek` — and a trim on one costs its own length in
    // real time with nothing written (3040 ms for two seconds trimmed one second
    // in, 5061 ms trimmed three seconds in; see `deviceClip` in
    // src/native/ffmpeg_export.h, which is the other end of this refusal).
    if (inputsModel.kindOf(input) === 'device') {
        flash(`${input.name} is a live device — Stop at gives it a length and does not ` +
              'make it a clip: there is no seeking back to a moment that has gone, so a ' +
              'trim on one is a wait. Record it on the Capture stage, and the recording ' +
              'is a file.');
        return null;
    }

    // **A still is refused on what it is, not on what it measures** — the same
    // correction the device refusal above went through, and it was hiding the
    // same kind of hole. A picture has no length of its own; `-loop 1` with a
    // `-t` is the decision that gives it one, and that is what a dropped
    // picture becomes (see `stillSpec` in ui/sequence.js). Take the loop away
    // and the length test was supposed to catch it — but it only did for a
    // picture opened *bare*, which libavformat reads through `png_pipe` and
    // reports as 0. This application forces `image2` for a still, and `image2`
    // measures one frame at the declared rate: 0.04 s at 25 fps, which is
    // greater than zero. So a still whose loop had been cleared from the option
    // column laid out as a clip forty milliseconds long — precisely the clip of
    // nothing this refusal exists to prevent. `blocked()` in ui/sources.js
    // states the same rule for the button.
    if (inputsModel.kindOf(input) === 'still' && !inputsModel.endless(input)) {
        flash(`${input.name} is one picture and no time at all — Sources ▸ Still ` +
              'holds it for a chosen length');
        return null;
    }

    // What is left is an input that genuinely does not say how long it is, and
    // the two reasons are answered in different places: an endless one — a
    // `-loop`, a `-stream_loop` — is fixed on the input's own window, and
    // anything else is a file libavformat could put no duration on at all.
    if (inputsModel.lengthOf(input) <= 0) {
        flash(inputsModel.endless(input)
                  ? `${input.name} never ends — set -to on the Sources stage to say how ` +
                    'long it is'
                  : `nothing in ${input.name} says how long it is — set -to on the ` +
                    'Sources stage to say where to stop reading');
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
function addGenerator(filter) {
    const settled = generators.settle(generators.makeSpec(filter, {
        width: project.width || 1920,
        height: project.height || 1080,
        fps: projectFps(),
    }));
    if (!settled.ok) { flash(settled.why); return null; }

    const clip = makeGenerator(settled);
    addClip(clip);
    viewer.attachClip(clip);
    select(clip, 'auto');
    dropzone.classList.add('hidden');
    setControlsEnabled(true);
    viewer.layout();
    timeline.fitView();
    setPlayhead(clip.start);
    showProperties();
    changed('open');
    flash(`${clip.name} on V${clip.track + 1}`);
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
function setGeneratorArgs(clip, text) {
    const want = generators.withArgs(clip.generator, text);
    const settled = generators.settle(want);
    if (!settled.ok) { flash(settled.why); return false; }
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

draggable(scrub, (f, press, release) => {
    const t = f * duration();
    if (release) {
        finalSeek(t);
    } else if (press) {
        setPlayhead(t);
    } else {
        scheduleSeek(t);
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
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;

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
        case 'o':          if (shell.currentStage() === 'compose') setOutputPreview(!output.isOn()); else return; break;
        case 't':          if (shell.currentStage() === 'compose') setSoftCues(!softcues.isOn()); else return; break;
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
    if (awaitingProbe.length) settleProbes();
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
    syncOutputPicture();
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
    if (waiting !== lastWaiting) { lastWaiting = waiting; needs('readouts'); }
    // ...and whether one of the five redraws is owed and known to be slow. Read
    // *before* `drawPending`, so the phrase goes up on the frame the work is
    // still owed rather than on the one after it has been done — which for
    // something that takes a single frame would be never. See `busyWord`.
    const busy = busyWord();
    if (busy !== lastBusy) { lastBusy = busy; needs('readouts'); }
    // And everything a change since the last frame marked out of date, drawn
    // once however many times it was marked. See `needs` for why this is here
    // rather than at each of the places that change something.
    drawPending();
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
    // Beside "reading 12…" rather than anywhere new, because they are the same
    // kind of sentence: this line is where this application says what it is
    // doing that you did not ask about and have not been given yet.
    const busy = busyWord();
    stats.textContent = n
        ? `${project.width}×${project.height}  ${n} clip${n === 1 ? '' : 's'}` +
          (live > 1 ? `  ${live} playing` : '') +
          (waiting ? `  reading ${waiting}…` : '') +
          (busy ? `  ${busy}…` : '')
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
for (const b of document.querySelectorAll('[data-edit-mode]'))
    b.addEventListener('click', () => timeline.setEditMode(b.dataset.editMode));

el('btn-split').addEventListener('click', splitAtPlayhead);
el('btn-grid').addEventListener('click',
    () => setLayout(project.layout === 'grid' ? 'stack' : 'grid'));
el('btn-output').addEventListener('click', () => setOutputPreview(!output.isOn()));
el('btn-cues').addEventListener('click', () => setSoftCues(!softcues.isOn()));
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
    targetPlayheadTime: () => targetPlayheadTime,
    seekCount: () => seekCount,
    play, pause, step,
    timeline, viewer, levels,
    setCropMode, cropMode: () => cropMode,
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
