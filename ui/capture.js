// Capture: the devices a recording reads, what they can see, and the file they
// become.
//
// **Why this is a stage of its own rather than a control on Sources.** A device
// *is* an input — `-f gdigrab -i desktop` is an `-i` with a demuxer and an
// option bag, and the model treats it as one — so the tempting place for it is
// the Sources stage beside the file picker. It is the wrong place, and the
// reason is not layout: what you do with a device is not configure it and move
// on, it is watch it and then press record. That is a moment, not a setting,
// and it wants a screen.
//
// **What it is not is a second input list, and that is the change this file has
// just been through.** It used to hold its own array of `{device, source,
// options, seconds}`, probe them itself, and register its own preview tokens —
// a parallel model of an `-i` that `ui/inputs.js` already had. The consequence
// was not duplication for its own sake, it was that a device activated here
// existed *nowhere else in the application*: not on Sources, not in the graph's
// source palette, not in a spec. It could be recorded and it could not be used.
//
// So a device now goes into the same list a file does. `capture.inputs` is a
// list of **document input ids**, `ui/inputs.js` owns the objects, and
// everything that reads that list — the Sources stage, `graph/panel.js`'s
// palette, `specInputs()` — sees a device the moment it is activated, without
// any of them being taught what a device is. They did not need teaching:
// `kindOf()` has answered `'device'` and `endless()` has answered true since
// inputs became first class.
//
// **Activating is the verb, and it is the only one.** Clicking a device in the
// left column adds an `-i`; the `×` on its card takes it out again. There is no
// blank card waiting to be filled in, because a blank card was a state the
// shared list cannot hold — an input with no path is an input that will not
// open, and it would sit on the Sources stage saying so. A recording of nothing
// is simply no cards.
//
// **A recording reads a list of inputs, and one device is that list with one in
// it.** There is no singular case in this file and none in the engine either:
// `record.start` is always given `sources`, and `CaptureSettings::sources`
// treats an empty list as `{source}` so that the one spelling and the many are
// the same call.
//
// **A card per input, each with its own picture, rather than one picture and a
// selector.** The whole argument for this stage is that you watch a device
// before you commit to recording it, and that argument does not weaken at two
// devices — it is the only moment you can see that the camera is pointed the
// right way *and* that the screen grab has the right monitor in it. A selector
// would show one of them and imply the other was fine. The cost is real and is
// paid deliberately: N `<video>` elements and two cameras held open at once
// before a recording that will want them both.
//
// What is *not* multiplied is the option table. It stays one column on the
// right, showing the focused card's device, because `optionColumn()` is a
// searchable table over a demuxer's whole option list and several of those side
// by side would be several search boxes and no room for a picture. The card
// shows which options are set; the column is where they are set.
//
// **A device's settings are its demuxer's options.** `video_size`, `framerate`,
// `draw_mouse`, `offset_x`, `rtbufsize` — every one of them comes out of
// `bro.ffmpeg.demuxerOptions(name)` and goes into the same bag `-probesize`
// travels in, drawn by the same `ui/opttable.js` column the encoder's, the
// muxer's and the file demuxer's use. There is no list of device settings
// written down here, and there could not be: this build has five devices and
// another platform's has different ones.
//
// **The graph is built on the Graph stage, and this stage only reports it.**
// A recording has been able to run a filter graph since the engine grew one,
// for one input as much as for several — `[0:v]crop=…[vout]` records one
// monitor out of a wide screen grab — and several inputs *require* one, because
// two pictures and nothing saying how they combine is not a composition
// anything could guess at, and the engine refuses rather than picking one.
//
// That string used to be typed into a textarea here, beside three buttons that
// wrote one by concatenation. Both are gone. An activated device is a node the
// Graph stage can place, wire, preview and check, so the composition has an
// editor; a textarea beside it would be a second description of one render, and
// the two would disagree the first time somebody edited the wrong one. What is
// left here is `graphOf()`, which asks `graph/record.js` what the graph says
// about *this* recording — and the three answers it can give are drawn below
// the cards, refusal included.
//
// **The preview is the real decode path.** A device in the input list is
// registered by `ui/inputs.js` like every other one, and is played through an
// ordinary `<video>` — the same backend, the same decoder and the same renderer
// everything else in this application uses. There is no preview-only path, for
// the reason the node previews have none: a preview that agreed with the
// recording most of the time would be worse than none, because it would be
// trusted. What it does *not* show is the graph — the picture on a card is that
// device, not the composition, for the same structural reason the viewer cannot
// show a filter.
//
// **Every device this build can open can be previewed**, `lavfi` included.
// It could not be until the crossing learned about `wrapped_avframe` — lavfi
// hands over pointers to decoded frames rather than packets of bytes, and bro's
// `MediaPacket` is a byte buffer because bro is codec-agnostic — so there was a
// refusal here, worded as a fact about the seam rather than about the device.
// The seam was the thing to fix: see `Wrapped` in `ffmpeg_backend.cpp`, where
// such a frame now travels as itself.
//
// ── What this stage says, and what it stopped saying ───────────────────────
//
// Everything above is why the stage is shaped as it is, and for a while every
// word of it was **on the screen**. Each panel carried the paragraph that
// justified it: why a device is an input, why the graph is edited elsewhere,
// what a region is in ffmpeg's vocabulary, why there is no percentage. Nine
// paragraphs, all true, and the stage was unusable — the Record button sat in
// the middle of them at the weight of an ordinary control, and the one fact
// somebody needs before pressing it (where the file goes) was scrolled off the
// bottom of the middle column.
//
// The rule now is: **a stage states, a manual explains.** What is on screen is
// a label, a value, and a door to whatever would change it. Where a sentence
// was load-bearing it is a `title` on the control it is about — attached to the
// thing, where somebody looking at the thing will find it — and the argument
// itself lives in docs/manual/capture.md and in these headers.
//
// The vocabulary went the same way. `-i` and `-t` were the *labels* of the two
// fields on a card, which is a UI that can only be read by somebody who did not
// need it: the field is called **Source** and **Stop after** now, and the `-f
// gdigrab -i desktop` spelling is a foot below in the command bar, exact and
// copyable, which is the honest place for it. The one piece of ffmpeg on the
// card that stayed is the `-i` **number** — `[0]`, `[1]` — because the graph
// genuinely calls them that and hiding it would make the Graph stage
// unreadable. It is drawn as a badge rather than written into a sentence.
//
// Three columns, in the order somebody works: what to capture, the pictures and
// the act, what comes out.

import { div, span, el, put, row } from './dom.js';
import { teeSpec } from './export/destination.js';
import { changed as projectChanged } from './project.js';
import { addInput, updateInput, removeInput as dropInput, byId,
         opening, openStoppable, stopOpening, asInput as inputSpec,
         inputs as projectInputs } from './inputs.js';
import { recordGraph, recordPads } from './graph/record.js';
import { current as overlayState, onChange as overlayChanged } from './graph/overlay.js';
import {
    bindCaptureSessionContext, stillOpening, closeSession, sessionId,
    syncPreviews, monitoring, releasePreview, stopPreviews, arrive, leave,
    isRecording, recordingStatus, lastRecorded, summary, startRecording,
    stopRecording, tick, wireRegionDrag, setRegionFromDrag,
} from './capture-session.js';
import {
    bindCaptureDrawContext, drawCapture, parseSourcePath, composeSourcePath,
    sourceArg, drawGraph, redraw, regionRows, blockerInfo, jumpToBlocker,
    tickRecording, drawRecording, fitPreviews, syncMarquee, commandParts,
} from './capture-draw.js';

export {
    stillOpening, sessionId, monitoring, stopPreviews, arrive, leave,
    isRecording, summary, startRecording, stopRecording, tick, setRegionFromDrag,
    drawCapture, parseSourcePath, composeSourcePath, sourceArg, blockerInfo,
    jumpToBlocker, drawRecording, commandParts,
};

let refs = {};
let hooks = {};

// ── what is being captured ─────────────────────────────────────────────────
//
// The `-i`s are **not here**: `inputs` is a list of ids into `ui/inputs.js`.
// What is here is everything about the file coming *out*, which is a decision
// this stage owns and no other list does — a recording is its own pipeline and
// the Encode stage describes a different render.

export const capture = {
    /// Document input ids, in the order that numbers them for the graph: the
    /// first is `[0:v]`/`[0:a]`, the second `[1:…]`. That order is this array's
    /// order and nothing else, which is why activating a device appends.
    inputs: [],
    path: '',               // where the recording goes
    format: 'matroska',     // the muxer, by name
    /// Where a `tee` recording goes: `{ id, format, path, options }` each, the
    /// same shape the Write stage's list holds and edited by the same rows.
    ///
    /// **`path` above is not this, and both are kept.** A recording writes
    /// through one muxer, and when that muxer is `tee` the filename it is opened
    /// with is the whole `-f tee` argument — built from this list by `teeSpec`,
    /// never typed. Switching the container back leaves the single path where it
    /// was, because changing your mind about how many files there are should not
    /// lose the name of the one.
    destinations: [],
    videoCodec: '',         // empty asks the muxer for its default
    audioCodec: '',
    quality: 23,
    /// Which end of the graph this recording writes, as an overlay sink id per
    /// stream — empty being the derivation's own video out and sound out.
    ///
    /// **A pad and not a filtergraph**, which is the distinction that keeps
    /// this stage out of the composition business: the graph says what the
    /// picture *is*, and this says which of its ends this file gets. Held by id
    /// rather than by name so that renaming an output on the Graph stage does
    /// not silently point the recording somewhere else.
    videoPad: '',
    audioPad: '',
    /// The other files this recording writes, in the order they were added.
    ///
    /// **One reading of the devices, several muxers on the end of it.** Each is
    /// `{ id, path, format, videoPad, audioPad }` — a destination and which ends
    /// of the graph it gets — because those are the two things that make it a
    /// second file rather than a second copy. Everything else is the
    /// recording's: the devices, the graph, `-t`, and the rate, since placing a
    /// frame is turning the moment it arrived into an output frame number.
    ///
    /// **Not a size**, which is the one thing a render's version row has and
    /// this does not: on this stage the picture's size is its pad's, and a
    /// second size is a `scale` in the graph with an output of its own. That is
    /// where a composition is described, and a size field here would be a
    /// second place to describe one.
    also: [],
};

/// Which card the left column and the option column are editing.
///
/// Not a selection in the timeline's sense — every card is live and every card
/// is recorded. It is only the answer to "when you click a source, which input
/// did you mean", and clicking anywhere on a card is how it moves.
let focus = 0;

// Which devices have been asked what they can see. `deviceSources` is the one
// query in this application that talks to hardware — enumerating DirectShow
// asks every camera driver on the machine — so it is asked once per device and
// re-asked only when somebody presses Rescan.
const seen = new Map();

/// The starting point for a device that will not list its sources.
///
/// **This is a hint and not a capability**, and the difference matters enough
/// to say out loud. Everything else on this stage is asked of libav: the device
/// list is `av_input_video_device_next`, the sources are
/// `avdevice_list_input_sources`, the settings are the demuxer's own option
/// table. What goes after `-i` for a device that has no `get_device_list` is
/// documented in ffmpeg's man page and nowhere in the library — there is no
/// call that returns "desktop" — so it cannot be asked, and a screen grabber
/// nobody can guess the argument to is a screen grabber nobody can use. It is
/// offered as placeholder text and as one button, never as a restriction: the
/// field takes anything.
const HINTS = {
    gdigrab: 'desktop',
    lavfi: 'testsrc=size=1280x720:rate=30',
    vfwcap: '0',
};

const cards = [];   // parallel to capture.inputs

const sharedContext = {
    capture,
    hints: HINTS,
    refs: () => refs,
    hooks: () => hooks,
    cards: () => cards,
    focus: () => focus,
    setFocus: (v) => { focus = v; },
    captureInputs,
    focused,
    devices,
    sourcesOf,
    asInput,
    asInputs,
    graphOf,
    alsoFiles,
    ready,
    recordTarget,
    clashingPath,
    effectiveVideo,
    codecMuxer,
    effectiveCodecs,
    takesRegion,
    defaultPath,
    activate,
    change,
    withDevicesFree,
    syncCards,
    pictureRefusal,
    openingLabel,
    drawCardRows,
    stillOpening,
    syncPreviews,
    isRecording,
    recordingStatus,
    lastRecorded,
    startRecording,
    stopRecording,
    drawCapture,
    drawGraph,
    tickRecording,
    fitPreviews,
    syncMarquee,
};
bindCaptureSessionContext(sharedContext);
bindCaptureDrawContext(sharedContext);

export function initCapture(nodes, h) {
    refs = nodes || {};
    hooks = h || {};
    if (!capture.path) capture.path = defaultPath();
    // **The graph is edited on another stage, so this one has to be told.** It
    // was self-contained while the composition was a textarea here; it is not
    // now, and a stage that only caught up when you clicked back onto it would
    // be a Record button that stayed dead after the wire that fixed it. The
    // spine is told too, because its Capture summary reads the same answer.
    //
    // Structure only, which is the same line `isEmpty()` draws and for the same
    // reason: a card dragged three pixels changes where you like looking at a
    // node and nothing about what would be recorded, and `pin` fires on every
    // frame of that drag.
    overlayChanged((what) => {
        if (what === 'pin' || what === 'size') return;
        forgetLostPads();
        drawCapture();
        // **The session is reopened, not merely redrawn.** The graph is what a
        // session runs, so a wire moved on the other stage changes what the
        // composition *is* — and `syncPreviews` is where that is noticed,
        // because `sessionKey()` has the graph text in it.
        syncPreviews();
        if (hooks.changed) hooks.changed();
    });
}

/// An output this recording was writing that is not on the stage any more.
///
/// Deleting a node is an ordinary gesture on the Graph stage and nothing there
/// knows a recording is pointed at one, so the pick is dropped back to the
/// derivation's own end here. **Silently, and that is deliberate**: the panel
/// redraws saying what it is mapped as now, which is the whole of what changed,
/// and a message about it would be a message about a stage the person is not
/// looking at. `recordGraph` still refuses a pick it cannot find — this is the
/// state getting tidied, not the state being checked.
function forgetLostPads() {
    const pads = recordPads(overlayState());
    const gone = (stream, id) => id && !pads[stream].some((p) => p.id === id);
    if (gone('v', capture.videoPad)) capture.videoPad = '';
    if (gone('a', capture.audioPad)) capture.audioPad = '';
    // Every file, and for the same reason: a row pointed at an output somebody
    // deleted drops back to the derivation's own end rather than refusing.
    for (const f of capture.also) {
        if (gone('v', f.videoPad)) f.videoPad = '';
        if (gone('a', f.audioPad)) f.audioPad = '';
    }
}

function defaultPath() {
    // Somewhere that always exists, named for when it was taken. A recording is
    // a real file and not a preview, so it is not overwritten on the next one:
    // the second take is not a correction of the first.
    const now = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
                  `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    try { return bro.ffmpeg.tempPath(`capture-${stamp}.mkv`); } catch (e) { return ''; }
}

/// The inputs this recording reads, as the document's own objects.
///
/// **Pruned on the way out, and that is not tidying.** An input can be removed
/// on the Sources stage — it is an ordinary `-i` there, and a device nothing is
/// recording is a reasonable thing to take out of the list — and an id left
/// pointing at nothing would be an `-i` the command bar prints as `undefined`
/// and the engine refuses. One list, one owner, and this is the cost of that:
/// the reference has to be checked rather than assumed.
export function captureInputs() {
    const out = [];
    for (let i = capture.inputs.length - 1; i >= 0; i--)
        if (!byId(capture.inputs[i])) capture.inputs.splice(i, 1);
    for (const id of capture.inputs) {
        const input = byId(id);
        if (input) out.push(input);
    }
    return out;
}

/// The input the left column and the option column are pointed at, or null when
/// nothing has been activated yet — which is the state this stage opens in.
export function focused() {
    const all = captureInputs();
    if (!all.length) return null;
    return all[Math.min(focus, all.length - 1)];
}

/// Every input device this build has, by name. Video and audio devices are
/// registered separately and `lavfi` is both, so the list is deduplicated —
/// two entries for one `-f` would read as two devices.
export function devices() {
    const out = [];
    for (const d of bro.ffmpeg.devices || []) {
        if (d.direction !== 'input') continue;
        const found = out.find((x) => x.name === d.name);
        if (found) { if (found.kinds.indexOf(d.kind) < 0) found.kinds.push(d.kind); continue; }
        out.push({ name: d.name, longName: d.longName, kinds: [d.kind] });
    }
    return out;
}

/// What one device can see, cached. `{ ok, error, sources }` verbatim from
/// libavdevice — an `ok: false` with a reason is an answer and not a failure,
/// and it is drawn as one.
export function sourcesOf(name, refresh) {
    if (!name) return { ok: false, error: '', sources: [] };
    if (!refresh && seen.has(name)) return seen.get(name);
    let list = { ok: false, error: '', sources: [] };
    try { list = bro.ffmpeg.deviceSources(name); } catch (e) {
        list = { ok: false, error: String((e && e.message) || e), sources: [] };
    }
    seen.set(name, list);
    return list;
}

/// One input as the native side wants it. `ui/inputs.js`'s own shape, so what
/// is probed, what is previewed and what is recorded cannot come to be
/// described differently — and so a `-hwaccel` or an `-ss` set on the Sources
/// stage reaches the recording rather than being quietly dropped on the way.
export function asInput(input) {
    return inputSpec(input || focused() || {});
}

/// Every input, in `-i` order.
export function asInputs() {
    return captureInputs().map((i) => inputSpec(i));
}

/// What the document's graph says about this recording.
///
/// Three answers, and the caller has to distinguish all three — see
/// `recordGraph()`. `null` is "nothing in the graph reads these devices", which
/// is the state a fresh recording is in and the one a single device is written
/// straight through in. Asked rather than stored, because the graph is edited
/// on another stage and a copy here would be a copy that goes stale the moment
/// a wire moves.
export function graphOf() {
    return recordGraph(capture.inputs, overlayState(), filePicks());
}

/// The files this recording writes, as `recordGraph` wants them: the recording
/// itself first, then every row of the Also-write list that has somewhere to go.
///
/// A row nobody has typed a path into yet is skipped, which is the rule
/// `activeVersions()` follows on the Write stage and for the same reason: a row
/// being filled in is the normal state of a list being filled in, and a
/// half-typed one must not make the Record button go dead.
function filePicks() {
    return [{ v: capture.videoPad, a: capture.audioPad }]
        .concat(alsoFiles().map((f) => ({ v: f.videoPad, a: f.audioPad })));
}

/// The rows of the Also-write list this recording would actually write.
export function alsoFiles() {
    return capture.also.filter((f) => f.path);
}

/// Is this recording ready to start? There has to be at least one device, each
/// needs something after the `-i`, the graph — if the graph is about this
/// recording at all — has to be one that runs, and several devices need one,
/// because two pictures and nothing saying how they combine is what the engine
/// refuses. Checked here so the button is honest rather than so the refusal is
/// avoided: `record.start` still refuses, this stops the press.
export function ready() {
    const all = captureInputs();
    if (!all.length) return false;
    for (const i of all) if (!i.format || !i.path) return false;
    // A recording opens the devices itself, on the thread that asked for it,
    // and a device already being opened by its own probe would refuse the
    // second handle. That is a wait, not a fault, so the press is held rather
    // than made to fail — the button comes alive of its own accord a moment
    // later. See `stillOpening()`.
    if (stillOpening()) return false;
    const g = graphOf();
    if (g && !g.ok) return false;
    if (all.length > 1 && !g) return false;
    if (clashingPath()) return false;
    // A tee with an empty list, which is the one way this can have nowhere to
    // go: a single blank path becomes `defaultPath()`.
    return !!recordTarget();
}

/// The filename the recording's muxer is opened with, which for a `tee` is not
/// a filename at all.
///
/// One place, for the reason `outputTarget()` is one place on the render side:
/// the spec, the command bar and the button that says where it is going all read
/// this, and a fourth answer assembled by hand would be a recording going
/// somewhere the screen does not say.
export function recordTarget() {
    return capture.format === 'tee' ? teeSpec(capture.destinations) : capture.path;
}

/// Every file this recording opens, in the order the command line has them.
///
/// **A tee's destinations count individually**, which is the point of the list:
/// two of them aimed at one path is the same fault as two muxers aimed at one
/// path, and the argument they come to is one string that would compare equal to
/// nothing.
function recordFiles() {
    const files = capture.format === 'tee'
        ? (capture.destinations || []).map((d) => d.path)
        : [capture.path];
    return files.concat(alsoFiles().map((f) => f.path));
}

/// A path two of this recording's files are both aimed at, or empty.
///
/// Two muxers on one file interleave into something no player reads, and the
/// engine refuses it by name — this is the same refusal made in time to stop
/// the press, which is the rule every other check on this stage follows.
export function clashingPath() {
    const seen = recordFiles();
    for (let i = 1; i < seen.length; ++i)
        if (seen[i] && seen.indexOf(seen[i]) < i) return seen[i];
    const inputPaths = projectInputs.map(i => i.path);
    for (const f of seen)
        if (f && inputPaths.includes(f)) return f;
    return '';
}

/// The encoder this recording will actually go through, and what it takes.
///
/// Nothing is chosen by default — a recording asks the muxer for its own —
/// which means neither the command bar nor the spec can say `-crf` without
/// knowing what the muxer would reach for. `MuxerOption::videoCodec` is that
/// answer, worked out at startup against what this build can encode, and the
/// encoder's own `crf` and `preset` booleans say whether those two words mean
/// anything to it. **A `-crf` the encoder has never heard of is an error and
/// not a shrug**, on both sides of this: the writer would refuse it and the
/// command bar would be printing an argument that stops the render.
function effectiveVideo() {
    const id = capture.videoCodec || (codecMuxer() || {}).videoCodec || '';
    return (bro.ffmpeg.encoders || []).find((c) => c.id === id) || null;
}

/// The muxer whose defaults decide what this recording is encoded with.
///
/// **Not always the container**, and `tee` is the reason: it does not encode
/// anything and has no default codec of its own — it opens the muxers in its
/// argument, and `ffmpeg -f tee` is given a `-c:v` for exactly that reason. So
/// the question is asked of the first destination, which is the file somebody
/// named and the one whose defaults they would recognise. Being asked in one
/// place is what keeps the picker, the `-crf` and the spec agreeing about which
/// encoder this is.
function codecMuxer() {
    const name = capture.format === 'tee'
        ? ((capture.destinations || []).find((d) => d.format) || {}).format || ''
        : capture.format;
    return (bro.ffmpeg.muxers || []).find((m) => m.name === name) || null;
}

/// The encoders this recording names out loud, which is not always the two
/// pickers' values.
///
/// **Empty means "the muxer's own default" and that is an answer a tee does not
/// have.** For every other container, saying nothing is right and is what the
/// picker's first entry means; for `tee` it is leaving the choice to a muxer
/// that encodes nothing, and the open fails with no encoder named. So there the
/// default resolved by `codecMuxer()` is written down, exactly as `ffmpeg -f
/// tee` is given a `-c:v`. One home, because the spec and the command bar must
/// not disagree about what is being encoded with.
function effectiveCodecs() {
    const m = codecMuxer() || {};
    const decides = capture.format !== 'tee';
    return {
        video: capture.videoCodec || (decides ? '' : m.videoCodec || ''),
        audio: capture.audioCodec || (decides ? '' : m.audioCodec || ''),
    };
}

/// Can this device be asked for a region?
///
/// Asked of the demuxer's own option table rather than decided by name: a
/// device takes a rectangle when it has `offset_x`, `offset_y` and
/// `video_size`, which is what a screen grabber has and a camera does not. The
/// same question on another platform's screen grabber answers the same way
/// without anything here being edited.
export function takesRegion(name) {
    if (!name) return false;
    let opts = [];
    try { opts = bro.ffmpeg.demuxerOptions(name) || []; } catch (e) { return false; }
    const has = (k) => opts.some((o) => o.name === k);
    return has('offset_x') && has('offset_y') && has('video_size');
}

// ── activating and releasing ───────────────────────────────────────────────

/// Turn a device into an `-i` the whole application can see.
///
/// **Appends rather than replacing the focused card.** Clicking a device used
/// to change what the current card was pointed at, which made sense while this
/// stage owned a private array of blanks. It does not now: an input is a thing
/// that exists, and the two gestures a person wants are "give me this one too"
/// and "take that one away". Changing a device is those two.
export function activate(name) {
    const list = sourcesOf(name);
    let path = '';
    if (list.ok && list.sources.length) {
        const first = list.sources.find((s) => (s.mediaTypes || []).indexOf('video') >= 0) ||
                      list.sources[0];
        path = sourceArg(first);
    } else if (HINTS[name]) {
        path = HINTS[name];
    }
    const input = addInput({ path, format: name, options: {} });
    capture.inputs.push(input.id);
    focus = capture.inputs.length - 1;
    projectChanged('inputs');
    if (hooks.changed) hooks.changed();
    drawCapture();
    syncPreviews();
    return input;
}

/// Take one input out of the recording **and out of the document**.
///
/// Both, because activating put it in both, and an `-i` left behind on the
/// Sources stage by a card being closed would be a file handle nobody asked
/// for. The graph is the exception the other way round: a node reading this
/// input is a node whose source has gone, which `graph/check.js` reports by
/// name — that is a problem to be shown, not a removal to be refused.
export function release(i) {
    const id = capture.inputs[i];
    const input = byId(id);
    if (!input) return;
    dropCard(i);
    capture.inputs.splice(i, 1);
    if (i < focus) focus--;
    dropInput(input);
    if (focus >= capture.inputs.length) focus = capture.inputs.length - 1;
    if (focus < 0) focus = 0;
    if (hooks.changed) hooks.changed();
    drawCapture();
    syncPreviews();
}

/// Change one of the referenced inputs, and put back everything that follows.
/// `updateInput` reopens it when the change is one that reopens a file, which
/// for a device is every change there is.
function change(input, patch) {
    withDevicesFree(() => updateInput(input, patch));
}

/// Open an input again with the devices given back first.
///
/// **The session holds every device on this stage, and a DirectShow device can
/// be opened once.** A probe that started while the session still had the
/// camera would be refused by the driver and would report that refusal as a
/// fact about the device — which is the failure this application can least
/// afford, because it looks exactly like the camera being in use by somebody
/// else. So the session is torn down before the probe starts and rebuilt by
/// `syncPreviews()` once it has settled. The cost is the picture going dark for
/// the length of one open, which is what a changed option cost anyway.
///
/// One helper and not two calls at each site, because the ordering *is* the
/// rule: a `reprobe` written the other way round works on `lavfi` and on a
/// screen grab and fails only on the camera nobody is testing with.
function withDevicesFree(fn) {
    closeSession();
    fn();
    projectChanged('inputs');
    redraw();
}

// ── the cards ──────────────────────────────────────────────────────────────
//
// One card per input, built once and kept. **Not rebuilt on every draw**, for
// the reason the stage views are never unmounted: the `<video>` in a card *is*
// the decoder, and `put()`ing over it would tear a device down and open it
// again every time a checkbox moved. So the roots are reconciled against the
// input list — create what is missing, remove what is extra — and only the rows
// inside them are redrawn.

/// Make the card list match the input list, then draw each card.
function syncCards() {
    if (!refs.cards) return;
    const all = captureInputs();

    while (cards.length > all.length) dropCard(cards.length - 1);
    while (cards.length < all.length) cards.push(buildCard());

    if (focus >= all.length) focus = all.length - 1;
    if (focus < 0) focus = 0;

    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (c.root.parentNode !== refs.cards) refs.cards.append(c.root);
        c.root.setAttribute('data-card', String(i));
        c.root.className = 'cap-card' + (i === focus ? ' on' : '');
        drawCardRows(i);
    }

    // **The empty state is the middle column, not a note under it.** Nothing
    // activated is the state this stage opens in and the one somebody sees
    // first, so it answers "what now" in one sentence at the size of a
    // heading — rather than leaving an empty strip above a form about a file
    // that has nothing going into it. Classes are toggled rather than leaning
    // on `:empty`, which is one more thing to be sure of in this engine.
    refs.cards.className = 'cap-cards' + (all.length ? '' : ' hidden');
    if (refs.add) {
        refs.add.className = 'cap-add' + (all.length ? '' : ' grow');
        put(refs.add, () => all.length ? [] : [emptyState()]);
    }
}

/// What to do when there is nothing to capture yet. Two fragments: a state and
/// the gesture that leaves it.
function emptyState() {
    const n = devices().length;
    return div('cap-empty', [
        div('cap-empty-title', n ? 'Nothing to capture' : 'No capture devices'),
        div('cap-empty-note dim', n ? 'Pick one on the left.'
                                    : 'libavdevice registered none.'),
    ]);
}

/// The DOM one card is, made once.
///
/// The picture and its marquee are the parts that must survive a redraw, so
/// they are created here and never replaced; the rows underneath are a `put()`
/// target like everything else on the stage.
function buildCard() {
    const pic = el('div', { cls: 'cap-pic' });
    const marquee = el('div', { cls: 'cap-marquee hidden' }, [
        el('div', { cls: 'cap-handle cap-handle-nw', 'data-handle': 'nw' }),
        el('div', { cls: 'cap-handle cap-handle-ne', 'data-handle': 'ne' }),
        el('div', { cls: 'cap-handle cap-handle-sw', 'data-handle': 'sw' }),
        el('div', { cls: 'cap-handle cap-handle-se', 'data-handle': 'se' }),
    ]);
    pic.append(marquee);
    const rows = el('div', { cls: 'cap-card-rows' });
    const title = el('div', { cls: 'cap-card-head' });
    const root = el('div', { cls: 'cap-card' }, [title, pic, rows]);
    const card = { root, pic, marquee, rows, title, video: null, key: '', waitNode: null, dragging: false };
    root.addEventListener('mousedown', () => {
        const i = cards.indexOf(card);
        if (i >= 0 && i !== focus) { focus = i; drawCapture(); }
    });
    wireRegionDrag(card);
    return card;
}

function dropCard(i) {
    const c = cards[i];
    if (!c) return;
    releasePreview(c);
    if (c.root.parentNode) c.root.parentNode.removeChild(c.root);
    cards.splice(i, 1);
}

/// Why this card has no picture, or '' when it has one.
///
/// Read off the input's own probe rather than kept here, because the probe is
/// the input's answer and there is one of it: run the device through a
/// different option bag and it says something else, which is exactly what the
/// option column on the right is for.
function pictureRefusal(input) {
    if (input.error) return input.error;
    const p = input.probe;
    if (!p) return '';
    if (!p.video)
        return p.audio ? 'Sound only — nothing to show, and it still records'
                       : 'Neither picture nor sound came out';
    return '';
}

/// "Opening · 1.2s of 10", or the same without the deadline until the first
/// poll has said what the deadline is. The Sources stage draws the same figure
/// from the same two fields; the words differ because a card is about a device
/// and that stage's row is about whatever the input turned out to be.
function openingLabel(input) {
    const o = input.opening || {};
    const secs = `${(o.elapsed || 0).toFixed(1)}s`;
    return o.timeout > 0 ? `Opening · ${secs} of ${o.timeout.toFixed(0)}` : `Opening · ${secs}`;
}

/// What a card says while its device is being opened, and the way to give up.
///
/// **The Stop does not abort the open and does not claim to.** libavdevice
/// talks to a driver, and nothing in that conversation polls libav's interrupt
/// callback — measured at zero polls across a 400 ms `dshow` open — so the
/// press ends this application's waiting and the thread is reaped whenever the
/// device finally answers. What the deadline does reach is the stream analysis
/// afterwards, which is most of an open on a screen grabber. See `OpenWatch` in
/// src/native/ffmpeg_input.h.
function openingRows(c, input) {
    c.waitNode = span(openingLabel(input), 'mono cap-waiting');
    return [
        row('Opening', c.waitNode),
        row('', el('button', {
            cls: 'tiny', 'data-f': 'capstop',
            text: openStoppable(input) ? 'Stop' : 'Stop waiting',
            title: openStoppable(input) ? 'Abandon open' : 'Stop waiting',
            on: { click: () => { stopOpening(input); redraw(); } },
        })),
        div('cap-note dim',
            'The open is on a thread of its own, so this window is not blocked. ' +
            'The preview and Record wait for it.'),
    ];
}

function drawCardRows(i) {
    const c = cards[i];
    const input = captureInputs()[i];
    if (!c || !input) return;
    const several = capture.inputs.length > 1;

    put(c.title, () => {
        const out = [
            // The `-i` number, which is the one piece of ffmpeg vocabulary that
            // had to stay on a card: the graph really does call this input
            // `[0:v]`, and a badge is how an identifier is drawn.
            el('span', {
                cls: 'cap-card-n', text: String(i),
                title: `Input ${i} ([${i}:v] / [${i}:a])`,
            }),
            el('span', {
                cls: 'cap-card-dev mono', text: input.format,
                title: `Opened with -f ${input.format}`,
            }),
        ];
        out.push(el('button', {
            cls: 'tiny cap-card-x', 'data-f': 'capremove', 'data-input': String(i),
            text: '×', title: 'Remove device',
            on: { click: () => release(i) },
        }));
        return out;
    });

    put(c.rows, () => {
        const source = el('input', {
            cls: 'wide', 'data-f': 'capsource', 'data-input': String(i), type: 'text',
            value: input.path,
            placeholder: HINTS[input.format] || 'what to capture',
            on: { change: () => change(input, { path: source.value.trim() }) },
        });
        const seconds = el('input', {
            cls: 'wide', 'data-f': 'capseconds', 'data-input': String(i), type: 'text',
            value: input.to ? String(input.to) : '',
            placeholder: 'never',
            on: { change: () => change(input, { to: Math.max(0, Number(seconds.value) || 0) }) },
        });
        const out = [row('Source', source), row('Stop after', seconds)];

        // The region, on the card whose picture it is dragged on. It used to be
        // a headed section in another column describing a rectangle you could
        // not see from there — and with two screen grabbers activated, one
        // section for whichever card happened to be focused.
        out.push(...regionRows(input));

        // What this input's option bag has in it. The bag is edited in the
        // column on the right, which shows one device at a time — so the card
        // is where you see that the *other* one has a region set on it without
        // having to click over to it and back.
        const keys = Object.keys(input.options)
            .filter((k) => input.options[k] !== '' && !REGION_KEYS[k]);
        if (keys.length)
            out.push(row('Options', span(
                keys.map((k) => `${k}=${input.options[k]}`).join('  '),
                'dim mono cap-card-opts')));

        // **Opening comes before the refusal**, because it is not one: a device
        // that has not answered yet has said nothing about itself, and "No
        // picture yet" beside a driver that is going to hang for a minute is
        // the state this whole path exists to stop being silent about.
        c.waitNode = null;
        if (opening(input)) out.push(...openingRows(c, input));
        else {
            const why = pictureRefusal(input);
            if (why) out.push(div('cap-error', why));
            else if (!c.video) out.push(div('cap-note dim', 'No picture yet.'));
        }
        if (several && !opening(input) && !pictureRefusal(input))
            out.push(row('', span(
                `→ [${i}:v]` +
                (input.probe && input.probe.audio ? ` [${i}:a]` : ''),
                'dim mono cap-card-pads')));
        return out;
    });
}

/// The three options a region is, so the Options line does not repeat what the
/// Region line above it already says in words.
const REGION_KEYS = { offset_x: true, offset_y: true, video_size: true };
