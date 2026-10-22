// Frame-coalesced redraws (`needs`/`drawPending`), model & graph-overlay change
// channels, output preview & soft cues state, document load/save/undo/redo, and
// input/clip opening (`open`/`openSpec`/`openInput`) for `ui/app.js`.

import * as doc from './document.js';
import * as history from './history.js';
import { project, makeClip, addClip, duration, onChange, changed,
         select, retainTracks } from './project.js';
import * as inputsModel from './inputs.js';
import * as assemble from './sequence.js';
import { analyzeClip } from './analysis.js';
import * as viewer from './viewer.js';
import * as output from './output.js';
import * as softcues from './softcues.js';
import * as timeline from './timeline.js';
import * as exporter from './export.js';
// The one channel saying the Encode and Write stages are set to something else.
// Read from the module that owns the settings rather than through `exporter`,
// because it is the fact and `exporter` is the screen over it.
import { onSettingsChange } from './export/state.js';
import { showProperties } from './inspector.js';
import { basename } from './format.js';
import { drawGraph } from './graph/view.js';
import * as graphOverlay from './graph/overlay.js';
import * as graphPlayback from './graph/playback.js';
import * as shell from './shell.js';
import * as capture from './capture.js';
import { drawSources } from './sources.js';
import { transport, setPlayhead, play, applyAudioAll } from './transport.js';
import * as command from './command.js';
import * as report from './report.js';

let ctx = null;
export function bindAppPlaybackContext(c) { ctx = c; }

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

export function targetPlayheadTimeOf() { return targetPlayheadTime; }
export function seekCountOf() { return seekCount; }

/// Where the playhead wants to be, to be answered on the next frame.
export function scheduleSeek(t) {
    if (t === undefined || t === null) return;
    targetPlayheadTime = Number(t);
    needs('seek');
}

/// Where the playhead is, now — the end of a gesture, and anything else that is
/// a decision rather than a hand moving. Cancels a marked one: the last position
/// is this one.
export function finalSeek(t) {
    targetPlayheadTime = null;
    dirty.seek = false;
    const target = (t !== undefined && t !== null && !Number.isNaN(Number(t))) ? Number(t) : transport.t;
    seekCount++;
    setPlayhead(target);
}

/// Mark one or more of them out of date.
export function needs(...what) { for (const k of what) dirty[k] = true; }

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
export function busyWord() {
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
export function drawPending() {
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
    if (dirty.readouts) { dirty.readouts = false; ctx.syncUI(); }
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

/// Point the viewer's elements at the filtered inputs, where a clip has
/// filters this can show.
///
/// Here rather than inside the viewer because putting a re-pointed element
/// right is the transport's job — an element handed a new src is at zero with
/// the element's own volume — and the viewer deliberately does not reach for
/// the transport. Called from both change channels: the model's, above, and the
/// graph overlay's, which is where inserting a filter arrives.
export function refreshPlayback() {
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

export function setOutputPreview(on) {
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
export function syncOutputPicture() {
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
export function setSoftCues(on) {
    if (!softcues.setOn(on)) return;
    // Immediately rather than on the next frame: this is a press, and a third of
    // a second of nothing reads as the mode not working.
    softcues.tick(transport.t);
    ctx.el('btn-cues').classList.toggle('on', softcues.isOn());
}

export function drawOutput() {
    // **`isWanted`, not `isOn`.** The button is the *mode* — did somebody choose
    // to watch the output — and playback engaging the same render for its own
    // reasons must not light it up, or pressing play would appear to have
    // switched a mode nobody asked for and pausing would appear to switch it
    // back.
    ctx.el('btn-output').classList.toggle('on', output.isWanted());
    const note = ctx.el('out-note');
    // The complaint, though, is about whatever is on the canvas whoever put it
    // there: a render that will not build is worth saying so about while
    // playback is the one that asked for it.
    const why = output.isOn() ? output.why() : '';
    note.textContent = why;
    note.classList.toggle('hidden', !why);
}

// ── the document ───────────────────────────────────────────────────────────
//
// The whole edit, saved and opened again. `ui/document.js` holds the object and
// the file; what is here is the three presses, the keys and everything that has
// to be put right afterwards — which is the same list `openBatch` puts right,
// because opening a document is opening files with the arrangement already
// decided.

/// Put the screen back after the model has been replaced under it.
///
/// The half that is true of an undo as well as of an Open: the picture laid out
/// against a canvas that may be a different size, the crop handles over whatever
/// is selected now, the levels re-applied, and the encode side redrawn — because
/// it reads `settings` when it is drawn rather than on the model's change
/// channel, and `Ctrl-Z` works from the Write stage.
export function documentApplied() {
    ctx.dropzone.classList.toggle('hidden', project.clips.length > 0);
    ctx.setControlsEnabled(project.clips.length > 0);
    viewer.layout();
    showProperties();
    ctx.updateCropUI();
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
export function documentOpened(result) {
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
        ctx.flash(lost.length === 1
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
export function drawDocument() {
    if (!ctx.docTitle) return;
    ctx.docTitle.textContent = doc.documentName();
    ctx.docTitle.classList.toggle('modified', doc.isModified());
}

/// Guarded the way the spine's doors are: a render or a recording holds the
/// host's one job slot, and replacing the timeline under one would leave it
/// rendering an edit that is no longer there. Returns true when it is safe.
function documentReady() {
    if (capture.isRecording()) { ctx.flash('A recording is running — stop it first'); return false; }
    if (!exporter.canLeave()) { ctx.flash('A render is running — stop it first'); return false; }
    return true;
}

export function openDocument() {
    if (!documentReady()) return null;
    let result = null;
    try {
        result = doc.openDialog();
    } catch (e) {
        ctx.flash(String((e && e.message) || e));
        return null;
    }
    if (!result) return null;
    if (result.isDocument) {
        documentOpened(result.data);
        ctx.flash(`Opened ${doc.documentName()}`);
        return result.data;
    }
    if (result.path) {
        const clip = open(result.path);
        if (clip) {
            needs('timeline', 'readouts', 'spine', 'command');
            viewer.refreshAll();
            ctx.flash(`Added ${basename(result.path)}`);
        }
        return clip;
    }
    return null;
}

export function saveDocument(askWhere) {
    try {
        const path = askWhere ? doc.saveAs() : doc.saveHere();
        if (!path) return '';
        drawDocument();
        ctx.flash(`Saved ${doc.documentName()}`);
        return path;
    } catch (e) {
        ctx.flash(String((e && e.message) || e));
        return '';
    }
}

export function newDocument() {
    if (!documentReady()) return false;
    doc.reset();
    documentOpened({ clips: [], skipped: [] });
    ctx.flash('New document');
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
export function stepHistory(back) {
    const which = historyTrack();
    if (back ? history.undo(which) : history.redo(which)) {
        if (which === 'edit') { documentApplied(); timeline.draw(); }
        return true;
    }
    const what = which === 'output' ? ' on this stage' : '';
    ctx.flash((back ? 'Nothing to undo' : 'Nothing to redo') + what);
    return false;
}

export function drawHistory() {
    const which = historyTrack();
    const btnUndo = ctx.el('doc-undo');
    const btnRedo = ctx.el('doc-redo');
    if (btnUndo) btnUndo.disabled = !history.canUndo(which);
    if (btnRedo) btnRedo.disabled = !history.canRedo(which);
}

// ── opening ────────────────────────────────────────────────────────────────

/// Open a path or a URL: an input if there is not already a plain one on it,
/// and then a clip of that input.
///
/// The two are separate acts and this is the one that does both, because
/// dropping a file on the timeline means both. `openInput()` below is the other
/// half on its own — an input that exists without a clip, which is an ordinary
/// state and the reason the Sources stage is not derived from the timeline any
/// more.
export function open(path, opts = {}) {
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
export function openSpec(spec, opts = {}) {
    const existing = spec.format || Object.keys(spec.options || {}).length
                         ? null
                         : inputsModel.plainInputFor(spec.path);
    const input = existing || inputsModel.addInput(spec);
    // A URL is opened on a thread of its own and has no answer yet, so there is
    // nothing to cut a clip from — and *nothing has gone wrong*. It stays on
    // the Sources stage, where the open is visible and `Use on the timeline` is
    // waiting for it, rather than being removed as a file that would not read.
    if (inputsModel.opening(input)) {
        ctx.flash(`connecting to ${input.name} — it will be on the Sources stage when it answers`);
        return null;
    }
    const clip = openInput(input, opts);
    // An input that was made here and turned out to be unusable goes away
    // again; one that was already on the list stays, because somebody put it
    // there.
    if (!clip && !existing) inputsModel.removeInput(input);
    return clip;
}

/// A clip of an input already on the list. Everything `open()` does past
/// deciding which input that is.
export function openInput(input, opts = {}) {
    if (input.error || !input.probe) {
        ctx.flash(input.error || `cannot read ${input.name}`);
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
        ctx.flash('no audio or video track in this file');
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
        ctx.flash(`${input.name} is a live device — Stop at gives it a length and does not ` +
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
        ctx.flash(`${input.name} is one picture and no time at all — Sources ▸ Still ` +
              'holds it for a chosen length');
        return null;
    }

    // What is left is an input that genuinely does not say how long it is, and
    // the two reasons are answered in different places: an endless one — a
    // `-loop`, a `-stream_loop` — is fixed on the input's own window, and
    // anything else is a file libavformat could put no duration on at all.
    if (inputsModel.lengthOf(input) <= 0) {
        ctx.flash(inputsModel.endless(input)
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

    ctx.dropzone.classList.add('hidden');
    ctx.setControlsEnabled(true);
    viewer.layout();
    if (!opts.quiet) {
        timeline.fitView();
        setPlayhead(project.clips.length === 1 ? 0 : clip.start);
        showProperties();
        changed('open');
    }
    return clip;
}

export function initAppPlayback() {
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
                ctx.flash(followed.broke.length === 1
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

    const btnUndo = ctx.el('doc-undo');
    const btnRedo = ctx.el('doc-redo');
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

    ctx.el('doc-open').addEventListener('click', openDocument);
    ctx.el('doc-save').addEventListener('click', () => saveDocument(false));
    ctx.el('doc-new').addEventListener('click', newDocument);
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
            catch (e) { ctx.flash(String((e && e.message) || e)); }
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
}
