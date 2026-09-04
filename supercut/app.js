// supercut — find what somebody said, cut it together, write a file.
//
// ── Why this is a second application ──────────────────────────────────────
//
// `ffmpeg-bro` is a workbench over ffmpeg's model, and its navigation *is* that
// model: Capture → Sources → Compose → Graph → Encode → Write. That shape is the
// whole value of it — anything ffmpeg can do has an obvious home in it — and it
// is the wrong shape for this job. Cutting a supercut is a loop between three
// things: find a moment, hear it, put it in the row. Six stages, a node graph
// and an encode form are all in the way of that loop, and none of them is
// answering a question anybody has while running it.
//
// So this shares everything below the interface and none of the interface.
//
// **What is shared, and why it is shared rather than copied.** The clips and
// their edits (`ui/project.js`), the inputs (`ui/inputs.js`), the corpus
// (`ui/library.js`), the analysis worker (`ui/analysis.js`), the render spec
// (`ui/export/spec.js`), the render preview (`ui/output.js`) and the document
// format (`ui/document.js`). Every one of those is a *fact* rather than a view,
// and a second copy of any of them is two answers to one question — which has
// already happened once in this repository and cost a day: the rule about what
// counts as one instance of a phrase lived in one of two places, and a panel and
// a command line reported fifteen and fourteen of the same phrase in the same
// recordings.
//
// The payoff is not only that they agree. A `.fbro` written here **opens in
// `ffmpeg-bro`**, because it is the same document by the same serialiser: this
// is where an edit starts, not a dead end you have to redo when it needs a
// filter on it.
//
// **What is not shared is every line of interface**, and that is the point of
// the exercise. Four gestures on a card, two search boxes, one player, one
// button that writes the file.
//
// ── The one thing this application adds to the model ──────────────────────
//
// A mix is a **packed sequence**: one lane, no gaps, no overlaps. That is
// `mix.js`'s rule and it is the only arithmetic here that the workbench does not
// have — everything else, including what a trim and a speed change mean, is the
// model's.

import {
    project, projectFps, duration, sortClips, makeClip, removeClip,
    select, useClipId, changed, onChange,
} from '../ui/project.js';
import * as inputsModel from '../ui/inputs.js';
import * as documentModel from '../ui/document.js';
import { settings } from '../ui/export/state.js';
import { buildSpec } from '../ui/export/spec.js';
import { tickAnalysis, readCount, useWorker } from '../ui/analysis.js';
import * as loudness from '../ui/loudness.js';
import { transport } from '../ui/transport.js';
import { clock } from '../ui/format.js';
import { byId, setText } from '../ui/dom.js';

import * as results from './results.js';
import * as acquire from './acquire.js';
import * as mix from './mix.js';
import * as screen from './screen.js';
import * as cuts from './cuts.js';
import * as rhythm from './rhythm.js';
import * as inflight from './inflight.js';

// **The analysis worker is `ui/`'s and is not copied here.** bro resolves a
// worker path against the running application's directory by plain
// concatenation, so this is a path out of `supercut/` and into the one home that
// script has. Said before the first analysis, which is what builds it.
useWorker('../ui/analyze-worker.js');
// The energy search reads spans of a recording off the *same* script, for the
// same reason and with the same path — see the block at the top of
// ui/loudness.js for why it is a second worker over one script rather than a
// second script.
loudness.useWorker('../ui/analyze-worker.js');

const nodes = {
    about: byId('about'), doc: byId('doc'),
    open: byId('btn-open'), save: byId('btn-save'), render: byId('btn-render'),
    flight: byId('btn-flight'), flightList: byId('flight'),
    chanWrap: byId('chan-wrap'),
    tabs: byId('f-tabs'), controls: byId('f-controls'),
    note: byId('f-note'), progress: byId('f-progress'), list: byId('f-list'),
    stage: byId('stage'), stageNote: byId('stage-note'),
    home: byId('t-home'), play: byId('t-play'), end: byId('t-end'),
    time: byId('t-time'), what: byId('t-what'), mute: byId('t-mute'),
    split: byId('split'),
    mix: byId('mix'),
    mixNote: byId('mix-note'), strip: byId('strip'), cards: byId('cards'),
    playhead: byId('playhead'), zoom: byId('zoom'),
    mixScroll: byId('mix-scroll'), mixThumb: byId('mix-thumb'),
    fit: byId('btn-fit'), clear: byId('btn-clear'),
    flash: byId('flash'),
};

// ── saying things ──────────────────────────────────────────────────────────

let flashUntil = 0;
function flash(text, bad) {
    nodes.flash.textContent = text;
    nodes.flash.classList.toggle('bad', !!bad);
    nodes.flash.classList.add('on');
    flashUntil = Date.now() + (bad ? 6000 : 3000);
}

// ── putting a found moment in the mix ──────────────────────────────────────

/// Inputs whose probe has not landed yet, and what to do when it does.
///
/// **A six-hour recording is probed on a thread**, so a moment added from the
/// list cannot become a clip on the frame the button was pressed. Refusing it
/// there would be the worst failure this application could have — a press that
/// silently added nothing — so the add is *finished* on the frame loop instead.
const waiting = [];

/// The `-i` for a path — the one already open, or a new one.
///
/// **Split out of `addMoment` for the builder next door.** `supercut/rhythm.js`
/// lays a whole score at once and therefore has to ask for every recording it
/// needs *before* it lays anything, so that the pieces go in the order they were
/// typed rather than in the order the probes land. Two callers, one rule about
/// what counts as the same input.
function openInput(spec) {
    return inputsModel.inputs.find((i) => i.path === spec.path)
        || inputsModel.addInput({ path: spec.path, name: spec.name });
}

/// Put a moment in the mix against an input that has already answered.
///
/// Answers the clip, which is what a caller that has more to do with it needs —
/// the rhythm builder measures each piece's onsets afterwards and holds the id.
/// Answers null when the input never opened.
function placeMoment(spec, input) {
    if (!input || !input.probe) return null;
    const clip = makeClip(input);
    // The canvas is the first thing put on it, which is what makes a mix of
    // one recording come out at that recording's size rather than at a
    // number this application chose. Everything after it is placed inside
    // that, exactly as on the workbench's timeline.
    if (!project.width && clip.width) {
        project.width = clip.width;
        project.height = clip.height;
        project.fps = clip.fps || projectFps();
    }
    mix.append(clip, spec);
    // **The clip is in the row before the cut exists**, which is the whole
    // shape of this: a press adds a piece and the copy that makes it cheap
    // catches up. See `cuts.js`.
    cuts.begin(clip, spec);
    touched();
    mix.draw();
    screen.refresh();
    // Here rather than at the first click on the card — see `screen.warm`.
    screen.warm();
    return clip;
}

function addMoment(spec) {
    if (!spec.path) return;
    const input = openInput(spec);
    const lay = () => placeMoment(spec, input);
    if (input.probe) lay();
    else waiting.push({ input, then: lay });
}

function settleWaiting() {
    for (let i = waiting.length - 1; i >= 0; i--) {
        const w = waiting[i];
        if (w.input.error) {
            waiting.splice(i, 1);
            flash(`cannot read ${w.input.name}: ${w.input.error}`, true);
        } else if (w.input.probe) {
            waiting.splice(i, 1);
            w.then();
        }
    }
}

// ── the document ───────────────────────────────────────────────────────────

function touched() {
    documentModel.touch();
    drawDoc();
}

function drawDoc() {
    nodes.doc.textContent = documentModel.documentName();
    nodes.doc.classList.toggle('modified', documentModel.isModified());
}

function doSave() {
    try {
        const path = documentModel.saveHere();
        if (path) flash(`saved ${path}`);
    } catch (e) {
        flash(String((e && e.message) || e), true);
    }
    drawDoc();
}

function doOpen() {
    let picked = null;
    try { picked = documentModel.openDialog(); }
    catch (e) { flash(String((e && e.message) || e), true); return; }
    if (!picked) return;
    if (!picked.isDocument) {
        // A media file is not a document, and opening one here is the same
        // thing as adding a moment that happens to be the whole file. There is
        // no Sources stage to put it on and no reason for one.
        addMoment({ path: picked.path, name: picked.path, from: 0, to: 0 });
        return;
    }
    adopt();
}

/// Make whatever was opened into something this application can show.
///
/// **A document from the workbench may have tracks, gaps and overlaps in it, and
/// this has one lane.** Flattening is the honest thing to do — the clips are all
/// still there, in the order they started — but it is a change to somebody's
/// edit, so it is *said*. Losing a track silently would be the version of this
/// that makes the shared document format a trap instead of a bridge.
function adopt() {
    const before = project.clips.length;
    let flattened = 0;
    for (const c of project.clips) if (c.track !== 0) { c.track = 0; flattened++; }
    sortClips();
    mix.reflow();
    select(null);
    transport.t = 0;
    mix.fit();
    mix.draw();
    screen.refresh();
    screen.warm();
    drawDoc();
    if (flattened)
        flash(`${before} clips, ${flattened} brought down from higher tracks into one row`);
}

// ── rendering ──────────────────────────────────────────────────────────────
//
// One button. The workbench has a whole stage for this because it is a stage of
// ffmpeg's model with several dozen real decisions in it; here the decision is
// where to put the file, and everything else is `ui/export/state.js`'s defaults —
// H.264 and AAC into an mp4 at the canvas's own size and rate. A tool for
// cutting speech together does not need a codec menu, and one that had one would
// be a Write stage with the rest of the workbench missing.

let rendering = false;

/// The render as `inflight.js` takes a job, or null. **Written by the poll that
/// already happens** rather than by a second `render.poll()` from the panel:
/// there is one render and one place that asks it how it is doing.
let renderJob = null;

function doRender() {
    if (rendering) {
        try { bro.ffmpeg.render.cancel(); } catch (e) { /* already finished */ }
        return;
    }
    if (!project.clips.length) { flash('nothing in the mix'); return; }
    // **One name and one extension**, because there is one thing this writes.
    // The filter is SDL's and it validates the pattern before it opens
    // anything: `[a-zA-Z0-9_.-]`, `;` between extensions, or a bare `*`, and
    // nothing else. `'MP4|mp4|All files|*'` — several filters, names and
    // patterns alternating — is what bro now reads it as; it used to split at
    // the first `|` and hand SDL a pattern with the rest inside it, which was
    // refused, and a refused dialog is one that never appears. Both halves of
    // that are fixed in bro (`filtersFrom`, and a refusal is thrown rather than
    // returned as an empty list, which is what a cancel is).
    const path = showSaveFileDialog('MP4|mp4', settings.path || 'supercut.mp4');
    if (!path) return;
    settings.path = /\.[A-Za-z0-9]+$/.test(path) ? path : `${path}.mp4`;
    let spec;
    try { spec = buildSpec(); }
    catch (e) { flash(String((e && e.message) || e), true); return; }
    try { bro.ffmpeg.render.start(spec); }
    catch (e) { flash(String((e && e.message) || e), true); return; }
    rendering = true;
    nodes.render.textContent = 'Stop';
}

function watchRender() {
    if (!rendering) return;
    const p = bro.ffmpeg.render.poll();
    if (p.state === 'running') {
        const pct = Math.round((p.progress || 0) * 100);
        const said = p.totalFrames ? `${pct}%` : `frame ${p.frames || 0}`;
        setText(nodes.render, `Stop · ${said}`);
        renderJob = {
            key: 'render', kind: 'Render',
            name: settings.path || 'the mix', note: said,
            progress: p.progress || 0, stop: doRender,
        };
        return;
    }
    rendering = false;
    renderJob = null;
    nodes.render.textContent = 'Render';
    if (p.state === 'done') flash(`wrote ${settings.path}`);
    else if (p.state === 'cancelled') flash('render stopped');
    else flash(p.error || 'the render failed', true);
}

// ── the transport ──────────────────────────────────────────────────────────

function seek(t) {
    screen.moveTo(t);
    drawBar();
}

/// `Space` is *the* stop, and what it stops is whatever is making a noise.
///
/// An audition owns the screen and the sound while it runs, so the mix is not
/// playing and starting it would be the second thing playing over the first.
/// Pressing the one key everything else stops with, and being answered by a
/// second recording, is the failure this avoids.
function togglePlay() {
    if (results.auditioning()) { results.hush(); drawBar(); return; }
    if (screen.isPlaying()) screen.play(false);
    else if (!screen.play(true)) flash('nothing in the mix');
    drawBar();
}

// Written through `setText` because this runs on every frame of playback and
// three of its four lines change on almost none of them.
function drawBar() {
    const total = duration();
    setText(nodes.time, `${clock(transport.t)} / ${clock(total)}`);
    setText(nodes.play, screen.isPlaying() ? '❚❚' : '▶');
    // The glyph does not change — a struck-through note is the same control
    // saying it is off, where two different emoji are two things to recognise.
    nodes.mute.classList.toggle('off', screen.muted());
    const st = screen.state();
    setText(nodes.what,
        st === 'audition' ? 'auditioning' :
        st === 'render' ? 'the render' :
        st === 'building' ? 'building the render…' :
        st === 'clip' ? 'the clip under the playhead' : '');
}

// ── wiring ─────────────────────────────────────────────────────────────────

screen.initScreen({ stage: nodes.stage, note: nodes.stageNote }, {
    changed: () => drawBar(),
});

mix.initMix({
    strip: nodes.strip, cards: nodes.cards, playhead: nodes.playhead,
    note: nodes.mixNote, zoom: nodes.zoom, fit: nodes.fit, clear: nodes.clear,
    scroll: nodes.mixScroll, thumb: nodes.mixThumb,
}, {
    seek,
    // Under a moving hand: the picture follows the edit, and nothing is written
    // down until the gesture ends.
    moved: () => screen.refresh(),
    edited: () => { touched(); screen.refresh(); },
    resized: () => mix.placePlayhead(transport.t),
    cleared: () => rhythm.forget(),
});

results.initResults({
    tabs: nodes.tabs, controls: nodes.controls, note: nodes.note,
    progress: nodes.progress,
    list: nodes.list, channel: nodes.chanWrap, about: nodes.about,
}, {
    audition: (path, from, until, rate) => { screen.audition(path, from, until, rate); drawBar(); },
    hush: () => { screen.stopAudition(); drawBar(); },
    add: addMoment,
});

// The builder, which is the one part of this application that lays several
// pieces in one frame — so it gets the two halves of `addMoment` rather than
// `addMoment` itself. See `openInput` above for why the split exists.
rhythm.initRhythm({
    openInput,
    place: (spec) => placeMoment(spec, openInput(spec)),
    // A rest is a clip added straight to the model rather than through
    // `mix.append`, so the one rule the mix adds has to be applied after it.
    packed: () => mix.reflow(),
    edited: () => { touched(); mix.draw(); mix.fit(); screen.refresh(); },
});

inflight.initFlight({ button: nodes.flight, panel: nodes.flightList },
                    { render: () => renderJob });

documentModel.initDocument({ detach: () => {} });
onChange(() => drawDoc());

nodes.open.addEventListener('click', doOpen);
nodes.save.addEventListener('click', doSave);
nodes.render.addEventListener('click', doRender);
nodes.play.addEventListener('click', togglePlay);
nodes.home.addEventListener('click', () => seek(0));
nodes.end.addEventListener('click', () => seek(duration()));
nodes.mute.addEventListener('click', () => { screen.setMuted(!screen.muted()); drawBar(); });

// ── how much room the mix gets ─────────────────────────────────────────────
//
// **Remembered, because it is a working preference and not a fact about the
// edit.** It has nothing to do with what is being cut, so it does not belong in
// the document — the same split `ui/document.js` draws between the workspace and
// the edit, one storey down.

const SPLIT_KEY = 'supercut.mixHeight';

function setMixHeight(px) {
    const lo = 140;
    const hi = Math.max(lo, window.innerHeight - 260);
    const h = Math.round(Math.max(lo, Math.min(px, hi)));
    nodes.mix.style.flexBasis = `${h}px`;
    try { localStorage.setItem(SPLIT_KEY, String(h)); } catch (e) { /* no store */ }
    // The cards are as tall as the strip and their pictures are drawn at that
    // height, so a canvas painted at the old one is a stretched thumbnail until
    // something else happens to touch it.
    mix.repaint();
    mix.placePlayhead(transport.t);
}

try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved > 0) setMixHeight(saved);
} catch (e) { /* no store, and the default in the stylesheet stands */ }

{
    let from = 0, base = 0;
    nodes.split.addEventListener('mousedown', (e) => {
        from = e.clientY;
        base = nodes.mix.getBoundingClientRect().height;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!from) return;
        setMixHeight(base + (from - e.clientY));
    });
    document.addEventListener('mouseup', () => { from = 0; });
}

// ── keys ───────────────────────────────────────────────────────────────────
//
// Few, and none of them a mode. Everything an edit does has a grab point on a
// card; what is here is the transport and the things a hand on the keyboard is
// already doing.

document.addEventListener('keydown', (e) => {
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 's') { doSave(); e.preventDefault(); return; }
        if (e.key === 'o') { doOpen(); e.preventDefault(); return; }
        if (e.key === 'r') { doRender(); e.preventDefault(); return; }
        return;
    }
    if (typing) {
        if (e.key === 'Escape') e.target.blur();
        return;
    }
    // The list of what is running is a thing put over the window, so it closes
    // the way everything put over a window closes.
    if (e.key === 'Escape' && inflight.isOpen()) { inflight.toggle(false); return; }
    if (e.key === ' ') { togglePlay(); e.preventDefault(); return; }
    if (e.key === 'Home') { seek(0); return; }
    if (e.key === 'End') { seek(duration()); return; }
    if (e.key === 'ArrowLeft') { seek(transport.t - (e.shiftKey ? 1 : 1 / projectFps())); return; }
    if (e.key === 'ArrowRight') { seek(transport.t + (e.shiftKey ? 1 : 1 / projectFps())); return; }
    if (e.key === 'm') { screen.setMuted(!screen.muted()); drawBar(); return; }
    if (e.key === '+' || e.key === '=') { mix.nudgeZoom(1, transport.t); return; }
    if (e.key === '-' || e.key === '_') { mix.nudgeZoom(-1, transport.t); return; }
    if (e.key === '0') { mix.fit(); mix.draw(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        for (const c of project.selection.slice()) removeClip(c);
        mix.reflow();
        touched();
        mix.draw();
        screen.refresh();
        return;
    }
    if (e.key === '[' || e.key === ']') {
        if (results.currentTab && results.currentTab() === 'rhythm') {
            if (results.cycleActiveTake(e.key === ']' ? 1 : -1)) {
                e.preventDefault();
                return;
            }
        }
    }
    if (e.key === '/') {
        // The box only exists on the Words tab, so `/` is what *goes* there —
        // a key that did nothing on two tabs out of three would be a key
        // nobody could rely on.
        results.setTab('words');
        const box = byId('f-phrase');
        if (box) { box.focus(); box.select(); }
        e.preventDefault();
    }
});

// ── the frame loop ─────────────────────────────────────────────────────────

let lastReads = -1;

/// Has the hardware been asked about yet — see the frame loop.
let warmed = 0;

function frame() {
    // **The 0.8 s that would otherwise land on the first press of play.**
    // `buildSpec()` asks `deviceForRender` which card a render would use, which
    // asks `bro.ffmpeg.hardware()`, which opens every hardware device there is to
    // find out: 781 ms here, once, cached natively afterwards. Nothing about it
    // depends on the edit, so the only question is which moment pays — and a
    // hitch on the second frame of a window nobody has touched is a hitch nobody
    // is waiting through, while the same hitch on Play is a button that does not
    // answer. Two frames in, so the finder is on the screen before it happens.
    if (warmed < 3 && ++warmed === 3) {
        try { bro.ffmpeg.hardware(); } catch (e) { /* asked again by buildSpec */ }
    }

    // **A probe is a thread and this is the only thing that reaps it.** An input
    // is added the moment a row is pressed and answers whenever a six-hour file
    // gets around to answering; without this the mix would stay empty for ever
    // and nothing would say why.
    if (inputsModel.tickInputs() || waiting.length) settleWaiting();

    // The reader that fills the cards in. On the frame loop rather than driven
    // by a draw, for `ui/analysis.js`'s own reason: a view that has come to rest
    // stops redrawing, and it is the settle that decides a read is wanted.
    tickAnalysis();
    // A reading landing is the one thing that changes what a card looks like
    // without anybody having touched it. Counted rather than watched, because
    // repainting forty canvases every frame to catch the one frame something
    // arrives is the cost this loop exists to avoid.
    const reads = readCount();
    if (reads !== lastReads) { lastReads = reads; mix.repaint(); }

    // A cut landing changes which file a clip is of, and therefore its in-point,
    // its length and what its lanes are read from — so the row is rebuilt for
    // that and only for that. A copy merely advancing is written onto the cards
    // that are already there; see `mix.markCuts`.
    //
    // **A proxy landing is the other answer and gets much less.** Nothing about
    // the edit moved — the same clip, of the same file, at the same length — so
    // rebuilding the row would destroy a card a hand might be on, and marking
    // the document unsaved would claim an edit nobody made. All it changes is
    // which file the picture comes from, which is `screen`'s alone.
    const settled = cuts.tick();
    if (settled === 'edit') {
        mix.draw();
        screen.refresh();
        screen.warm();
        touched();
    } else if (settled === 'screen') {
        screen.repoint();
        screen.warm();
    }
    if (cuts.pending()) mix.markCuts();

    // A pull advancing, a read landing, a look-up answering. **Ticked here and
    // drawn only when it says so, and only as much as it says**, which is
    // `needs()`/`drawPending()` in `ui/app.js` one storey down and `cuts.tick()`
    // beside it: a recording changing condition rebuilds the list, and a bar
    // moving writes two numbers into the list that is already there. Rebuilding
    // for the second is 140 elements thrown away per percentage point.
    const moved = acquire.tick();
    if (moved === 'rows') results.refresh();
    else if (moved === 'numbers') results.repaint();

    // The search itself, a recording at a time. **On the frame loop for the
    // reason the reader above it is**: a corpus is fifty hours and walking it
    // between two keystrokes is the frozen window this arrangement exists to
    // remove. It draws its own list when it has something new and nothing at all
    // when it has not — see `results.tick`.
    results.tick();

    // The score's two jobs: the inputs a build is waiting on, and the onset read
    // that puts each piece on the transient nearest its word. A slip moves no
    // card and changes no length — the grid is the same grid — so what it owes
    // is a repaint of the pictures and never a rebuild of the row.
    if (rhythm.tick()) { mix.repaint(); touched(); }
    if (results.currentTab() === 'rhythm') results.repaint();

    screen.tick();
    // An audition that ran to the end of its moment stops itself, and the row it
    // was on has no other way to hear about it — so it kept its highlight and its
    // `■`, and the next press on it was a stop of something that had already
    // stopped. One question a frame, asked of the thing that actually knows.
    if (results.auditioning() && !screen.isAuditioning()) { results.stopped(); drawBar(); }
    mix.placePlayhead(transport.t);
    if (screen.isPlaying()) { mix.follow(transport.t); drawBar(); }

    watchRender();
    // After `watchRender`, which is what the render's row is written by.
    inflight.tick();

    if (flashUntil && Date.now() > flashUntil) {
        flashUntil = 0;
        nodes.flash.classList.remove('on');
    }
    requestAnimationFrame(frame);
}

// ── start ──────────────────────────────────────────────────────────────────

// **No corpus is no longer a thing to be told about.** This flashed a command
// line to go and run; the Recordings tab now carries the box that does the same
// job, says `no corpus yet` on its own line, and is the first thing on the
// screen — so a flash over it would be the window saying twice what one of the
// two can act on.
results.start();
mix.draw();
drawBar();
drawDoc();

// A file named on the command line. A document becomes the edit; anything else
// is a recording, and the whole of it goes in the mix.
try {
    const start = bro.ffmpeg.openOnStart;
    if (start) {
        if (start.toLowerCase().endsWith(`.${documentModel.EXTENSION}`)) {
            documentModel.load(start);
            adopt();
        } else {
            addMoment({ path: start, name: start, from: 0, to: 0 });
        }
    }
} catch (e) {
    flash(String((e && e.message) || e), true);
}

requestAnimationFrame(frame);

/// What a suite drives this with. The application has no command line and no
/// scripting surface of its own; this is the same idea as `__ffmpegBro` next
/// door, kept to what a test actually has to reach.
globalThis.__supercut = {
    project, inputs: inputsModel.inputs, transport, settings,
    results, acquire, mix, screen, cuts, rhythm, inflight, doc: documentModel,
    addMoment, seek, togglePlay, flash, buildSpec,
    duration: () => duration(),
    useClipId,
    changed,
};
