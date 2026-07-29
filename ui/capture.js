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

import { div, span, el, put, row, head } from './dom.js';
import { clock, bytes, basename, shellArg } from './format.js';
import { dbHeight, dbLabel, ZERO_DBFS } from './levels.js';
import { optionColumn } from './opttable.js';
import { qualityRange } from './export/capabilities.js';
import { schemeOf, protocolLinked } from './export/destination.js';
import { changed as projectChanged } from './project.js';
import { addInput, updateInput, removeInput as dropInput, reprobe, byId,
         asInput as inputSpec } from './inputs.js';
import { recordGraph, recordPads } from './graph/record.js';
import { current as overlayState, onChange as overlayChanged } from './graph/overlay.js';

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

let nextAlso = 1;

/// Which card the left column and the option column are editing.
///
/// Not a selection in the timeline's sense — every card is live and every card
/// is recorded. It is only the answer to "when you click a source, which input
/// did you mean", and clicking anywhere on a card is how it moves.
let focus = 0;

// What was recorded last, so the stage can say where it went and offer to open
// it. Not the job status: the job is over and its slot has been reused by then.
let lastFile = '';
let lastBytes = 0;
let recording = false;
let status = null;

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
    const g = graphOf();
    if (g && !g.ok) return false;
    if (all.length > 1 && !g) return false;
    return !clashingPath();
}

/// A path two of this recording's files are both aimed at, or empty.
///
/// Two muxers on one file interleave into something no player reads, and the
/// engine refuses it by name — this is the same refusal made in time to stop
/// the press, which is the rule every other check on this stage follows.
export function clashingPath() {
    const seen = [capture.path].concat(alsoFiles().map((f) => f.path));
    for (let i = 1; i < seen.length; ++i)
        if (seen[i] && seen.indexOf(seen[i]) < i) return seen[i];
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
    const id = capture.videoCodec ||
        ((bro.ffmpeg.muxers || []).find((m) => m.name === capture.format) || {}).videoCodec || '';
    return (bro.ffmpeg.encoders || []).find((c) => c.id === id) || null;
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
    updateInput(input, patch);
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

const cards = [];   // parallel to capture.inputs

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
    const marquee = el('div', { cls: 'cap-marquee hidden' });
    pic.append(marquee);
    const rows = el('div', { cls: 'cap-card-rows' });
    const title = el('div', { cls: 'cap-card-head' });
    const root = el('div', { cls: 'cap-card' }, [title, pic, rows]);
    const card = { root, pic, marquee, rows, title, video: null, key: '' };
    // Clicking anywhere on a card is how the left column and the option column
    // come to be about it — including on the picture, which is also where a
    // region is dragged. A drag is not a click, so the focus is taken on
    // mousedown and the drag decides for itself whether anything was dragged.
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
                title: `Input ${i} — the graph reads it as [${i}:v] and [${i}:a]`,
            }),
            el('span', {
                cls: 'cap-card-dev mono', text: input.format,
                title: `Opened with -f ${input.format}`,
            }),
        ];
        out.push(el('button', {
            cls: 'tiny cap-card-x', 'data-f': 'capremove', 'data-input': String(i),
            text: '×', title: 'Remove this device — it leaves the recording and the input list',
            on: { click: () => release(i) },
        }));
        return out;
    });

    put(c.rows, () => {
        const source = el('input', {
            cls: 'wide', 'data-f': 'capsource', 'data-input': String(i), type: 'text',
            value: input.path,
            placeholder: HINTS[input.format] || 'what to capture',
            title: 'What this device is asked for — the argument after -i',
            on: { change: () => change(input, { path: source.value.trim() }) },
        });
        // `-t` is the input's own window, which `ui/inputs.js` carries as an end
        // time: with no `-ss` in front of it those are the same number, and the
        // native reader takes either. Holding both here would be holding two
        // fields that can disagree.
        const seconds = el('input', {
            cls: 'wide', 'data-f': 'capseconds', 'data-input': String(i), type: 'text',
            value: input.to ? String(input.to) : '',
            placeholder: 'never',
            title: 'Seconds to read this input for. Blank runs until you press Stop. ' +
                   'It belongs to the input, as -t does on a command line, and the ' +
                   'shortest of them ends the recording.',
            on: { change: () => change(input, { to: Number(seconds.value) || 0 }) },
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

        const why = pictureRefusal(input);
        if (why) out.push(div('cap-error', why));
        else if (!c.video) out.push(div('cap-note dim', 'No picture yet.'));
        if (several && !why)
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

// ── the previews ───────────────────────────────────────────────────────────

// ── One session, and every picture on the stage is a pad of it ─────────────
//
// A card used to play its own `<video src="/@input/in5">`, which opened that
// device a second time. That was fine while the cards were the only things
// watching and stopped being fine the moment the *composition* wanted the same
// cameras: a DirectShow device can be opened once, so two pictures of one
// camera is not a slow path, it is an error.
//
// So `bro.ffmpeg.live` opens each device exactly once and publishes what it
// sees — each input as `in0`, `in1`, … and whatever the graph makes as `vout`.
// A card plays its own pad and the panel below plays the composition, and the
// devices are open once however many pictures are on the screen.
//
// **The composition is the thing that could not be shown before.** A card is
// one device; what two of them make together only existed in the file
// afterwards, and "judge it by its numbers and then play back the take" was the
// honest advice. It is the same `CaptureGraph` a recording runs, on the same
// text the Graph stage built — see the note above `LiveSettings`.

/// The open session: its id, its pads, and the key that says whether it still
/// describes what is on the stage.
let session = { id: 0, pads: [], key: '' };

/// Everything that would make the session wrong if it changed: which devices,
/// how each opens, and the graph they run through. Not the pad choice — that
/// decides which end a *recording* writes and the session publishes all of them.
function sessionKey() {
    const g = graphOf();
    return captureInputs().map((i) => i.key).join('|') + '::' +
           (g && g.ok ? g.filterGraph : '');
}

/// Open the session this stage needs, or leave the one that already fits.
///
/// Refusals are quiet on purpose. A device that will not open is already said
/// on its own card by the probe, and a graph that will not run is already said
/// under **The graph**; a third sentence here would be the same news in a
/// worse place. What happens instead is that there is no picture, which is
/// what "it did not open" looks like.
function openSession() {
    const want = sessionKey();
    if (session.id && session.key === want) return;
    closeSession();
    const live = captureInputs();
    if (!live.length || live.some((i) => !i.path)) return;

    const g = graphOf();
    try {
        session.id = bro.ffmpeg.live.open({
            sources: live.map((i) => asInput(i)),
            filterGraph: g && g.ok ? g.filterGraph : '',
            fps: 30,
        });
        session.key = want;
    } catch (e) {
        session.id = 0;
        session.key = want;   // do not retry every frame on a device that refuses
    }
}

function closeSession() {
    if (session.id) { try { bro.ffmpeg.live.close(session.id); } catch (e) { /* gone */ } }
    session = { id: 0, pads: [], key: '' };
    // The meters belong to the session that was running: a bar left standing at
    // -12 while nothing is open is a reading of a device that has been given
    // back. `syncMeters` rebuilds from the next session's pads.
    meterKey = '';
    meters.clear();
    if (refs.meters) put(refs.meters, () => []);
}

/// The pads the session is publishing, re-asked each time because a pad's size
/// is not known until libavfilter has configured the graph — which is a moment
/// after the session opened, not at it.
function padsNow() {
    if (!session.id) return [];
    try { session.pads = bro.ffmpeg.live.pads(session.id); } catch (e) { session.pads = []; }
    return session.pads;
}

function padNamed(name) {
    for (const p of padsNow()) if (p.name === name) return p;
    return null;
}

/// Which session is open, for a test that wants to ask the host directly. Zero
/// where none is — no device, or one that would not open.
export function sessionId() { return session.id; }

/// Point every picture on the stage at its pad, opening and closing only what
/// changed.
function syncPreviews() {
    if (!refs.cards) return;
    openSession();
    const all = captureInputs();
    for (let i = 0; i < cards.length; i++) syncPreview(cards[i], all[i], i);
    syncComposite();
    // **Drawn again here, and this order is the whole reason it is right.**
    // What the panel says about the graph depends on the probes, which
    // `updateInput` has only just refreshed, and on the pads, which the session
    // has only just published.
    drawGraph();
}

function syncPreview(c, input, i) {
    if (!c || !input) return;
    const pad = padNamed(`in${i}`);
    const key = `${input.key}#${pad ? pad.src : ''}`;
    if (key === c.key) return;
    c.key = key;

    if (!input.path || pictureRefusal(input) || !pad) {
        releasePreview(c);
        c.key = key;
        drawCardRows(i);
        return;
    }

    if (!c.video) {
        c.video = el('video', { cls: 'cap-video', 'data-f': 'preview', 'data-input': String(i) });
        c.pic.append(c.video);
    }
    // Reused rather than rebuilt: `src = next` is a reload, and a preview that
    // blinked every time a checkbox moved would be unwatchable.
    c.video.setAttribute('src', pad.src);
    try { c.video.play(); } catch (e) { /* it starts on the next frame */ }
    drawCardRows(i);
}

/// The composition, playing — or nothing, where the graph does not make one.
///
/// Kept outside the panel that describes the graph because that panel is
/// redrawn on every edit and this element is a reader of a live session: put
/// over, it would tear the session's pad down and open it again on every
/// keystroke in the options column.
function syncComposite() {
    if (!refs.comp) return;
    const pad = padNamed('vout');
    if (!pad) {
        if (composite) {
            if (composite.parentNode) composite.parentNode.removeChild(composite);
            composite = null;
        }
        compKey = '';
        put(refs.comp, () => []);
        return;
    }
    if (pad.src === compKey) return;
    compKey = pad.src;
    // A caption and not a section head: it sits directly on the picture it
    // names, and a bordered heading here read as the start of another panel.
    put(refs.comp, () => [div('cap-comp-head dim', 'What the graph makes')]);
    if (!composite) composite = el('video', { cls: 'cap-composite', 'data-f': 'composite' });
    refs.comp.append(composite);
    composite.setAttribute('src', pad.src);
    try { composite.play(); } catch (e) { /* it starts on the next frame */ }
}

let composite = null;
let compKey = '';

// ── the levels ─────────────────────────────────────────────────────────────
//
// **The half of a composition that cannot be seen.** The picture a session
// makes has been on this stage since the graph's pad was published; its sound
// was drained and dropped, so a capture with a microphone in it said nothing at
// all about the microphone. Whether a level is right is the one question about
// a take that cannot be answered afterwards — a picture that was framed badly
// is a picture, sound recorded ten decibels into the limiter is gone — so it is
// the reading worth having before you commit and it is what these are.
//
// **This is not monitoring, and the distinction is the reason it could be
// built.** Playing the mix asks questions this does not: whose speakers, and
// what happens when the microphone can hear them. Nothing here makes a sound.
// Sound pads publish a level and no frames — see `LivePadTap` — so there is
// nothing to point a `<video>` at even if one wanted to.
//
// Drawn on the same scale as A1, from `levels.js`, because somebody looking at
// one and then the other is comparing them.

/// What each meter is showing, between readings: the falling bar, the held
/// peak, the loudest it has been, and whether it has been over — the last two
/// since the latches were cleared rather than since the session opened.
///
/// Held here rather than read off the DOM, because a decay is a value with a
/// history and `style.width` is a rounded string.
const meters = new Map();

/// How fast the bar falls, per tick, as a multiplier on amplitude — which is a
/// *fixed number of decibels* per tick, since the scale is logarithmic, and is
/// what makes the fall look even. About 20 dB a second at sixty ticks, which is
/// the rate a peak-programme meter falls at and slow enough to read a transient
/// off rather than watch it flicker.
const FALL = 0.962;

/// And the peak mark, held five times as long. A peak that fell with the bar
/// would tell you nothing the bar did not; one that never fell would be a
/// high-water mark for the whole session, which is what the over light is for.
const PEAK_FALL = 0.992;

/// One row per sound pad, then written by `tickMeters` and never rebuilt.
///
/// Rebuilt only when the *pads* change — a session reopening, a wire moved on
/// the Graph stage. Redrawing a meter's markup sixty times a second to move a
/// bar would be rebuilding a panel to change a number in it.
function syncMeters() {
    if (!refs.meters) return;
    const pads = padsNow().filter((p) => p.sound);
    const key = pads.map((p) => p.name).join('|');
    if (key === meterKey) return;
    meterKey = key;
    meters.clear();
    if (!pads.length) { put(refs.meters, () => []); return; }

    put(refs.meters, () => [
        div('cap-comp-head dim', 'What the sound is doing'),
        ...pads.map((p) => {
            const bar = div('cap-m-bar');
            const peak = div('cap-m-peak');
            const read = span('', 'cap-m-read mono');
            const over = el('div', {
                cls: 'cap-m-over', text: 'over', 'data-f': `over-${p.name}`,
                title: 'Lit when this pad has gone past full scale. Click to forget ' +
                       'it, and the loudest-so-far reading beside it with it.',
                on: { click: clearHolds },
            });
            meters.set(p.name, { bar, peak, read, over,
                                 level: 0, held: 0, top: 0, clipped: false });
            return div('cap-m-row', [
                // `aout` is what the graph calls its mix and what `-map` names,
                // so it is what the row is called: a friendlier word here would
                // be a second name for the pad the command bar prints.
                span(p.name, 'cap-m-name mono'),
                div('cap-m-track', [
                    bar, peak,
                    // Full scale, at the fraction `levels.js` puts it — the one
                    // mark on the meter that does not depend on the session.
                    el('div', { cls: 'cap-m-zero',
                                style: { left: `${(ZERO_DBFS * 100).toFixed(2)}%` } }),
                ]),
                read, over,
            ]);
        }),
    ]);
}

let meterKey = '';

/// Read every level once and move every bar. **Once**, because the read clears
/// what it read — see `liveLevels` — and a second caller would halve this one's
/// window and draw a meter that disagreed with it.
function tickMeters() {
    if (!meters.size || !session.id) return;
    let levels = [];
    try { levels = bro.ffmpeg.live.levels(session.id); } catch (e) { return; }
    const seen = new Map();
    for (const l of levels) seen.set(l.name, l);

    for (const [name, m] of meters) {
        const l = seen.get(name);
        // **Nothing heard is not silence.** A device that has stopped
        // delivering would otherwise read as one delivering quiet, so the bar
        // falls from where it was rather than being driven to zero: what you
        // see is a meter going still, which is what has happened.
        const now = l && l.heard ? l.rms : 0;
        const hit = l && l.heard ? l.peak : 0;
        m.level = Math.max(now, m.level * FALL);
        m.held = Math.max(hit, m.held * PEAK_FALL);
        if (hit > m.top) m.top = hit;
        if (hit > 1) m.clipped = true;

        m.bar.style.width = `${(dbHeight(m.level) * 100).toFixed(2)}%`;
        m.peak.style.left = `${(dbHeight(m.held) * 100).toFixed(2)}%`;
        m.peak.classList.toggle('hidden', m.held <= 0);
        m.bar.classList.toggle('cap-m-hot', m.held > 1);
        m.over.classList.toggle('on', m.clipped);
        // **The number is the high-water mark, not the falling mark.** Three
        // readings and three questions: the bar is what it is doing, the mark
        // is what it just did, and this is the loudest it has been since you
        // last cleared it — which is the one a person setting a gain wants,
        // and the only one of the three that is a *measurement* rather than a
        // drawing. Put on the decaying hold instead it read -6.2 for a source
        // that was exactly -6.02, because a decay sampled at an arbitrary
        // moment is a number with a tick count in it.
        m.read.textContent = dbLabel(m.top);
    }
}

/// Forget both latches: the over light and the high-water number beside it.
///
/// One gesture for the two because they answer the same question at different
/// resolutions — "has this been too loud, and how loud" — and clearing one
/// without the other would leave a reading nobody could place. A latch that
/// could not be cleared is a light on for the rest of the session after one
/// accident, which stops being a reading of anything.
function clearHolds() {
    for (const m of meters.values()) {
        m.clipped = false;
        m.top = 0;
        m.over.classList.remove('on');
        m.read.textContent = dbLabel(0);
    }
}

/// Let one card's device go.
///
/// Not optional and not tidy-up: a camera opened by the preview is a camera
/// that cannot be opened by the recording, because a DirectShow device is
/// exclusive. So the previews are torn down before `record.start` and put back
/// afterwards, and leaving this stage releases them too.
///
/// **What is released is the element, not the registration.** The token belongs
/// to the input and the input outlives this stage; forgetting it here would
/// unregister an `-i` that the Sources stage, the graph and a render are
/// entitled to open. It is playing that holds a device, not being defined.
function releasePreview(c) {
    if (c.video) {
        try { c.video.pause(); } catch (e) { /* already gone */ }
        if (c.video.parentNode) c.video.parentNode.removeChild(c.video);
        c.video = null;
    }
    c.key = '';
}

/// Give every device back.
///
/// **The session goes with the elements, and that is the whole of it.** What
/// held a camera used to be a card's `<video>`; what holds one now is the
/// session behind every card, so releasing the elements alone would release
/// nothing. Called before `record.start`, because a recording opens its own
/// devices — see the note above `LiveSettings` — and on the way off the stage.
export function stopPreviews() {
    for (const c of cards) releasePreview(c);
    if (composite) {
        try { composite.pause(); } catch (e) { /* already gone */ }
        if (composite.parentNode) composite.parentNode.removeChild(composite);
        composite = null;
    }
    compKey = '';
    if (refs.comp) put(refs.comp, () => []);
    closeSession();
}

/// Coming to the stage: take a picture of each device. Leaving it: give them
/// all back.
export function arrive() {
    for (const c of cards) c.key = '';
    drawCapture();
    syncPreviews();
}

export function leave() {
    stopPreviews();
    drawCapture();
}

export function isRecording() { return recording; }

/// What the stage is doing, for the spine.
export function summary() {
    if (recording) {
        const st = status || {};
        const secs = st.elapsed || 0;
        return ['recording', `${clock(secs)} · ${bytes(st.bytes || 0)}`];
    }
    const live = captureInputs();
    if (!live.length) return ['no device', `${devices().length} available`];
    if (live.length > 1) {
        const g = graphOf();
        return [`${live.length} inputs`,
                !g ? 'no graph — they have nowhere to meet'
                   : g.ok ? live.map((i) => i.format).join(' + ')
                          : g.reason];
    }
    // The device and what it is pointed at, in the words the stage uses. It
    // read `-f gdigrab` / `desktop · -t 5`, which put command-line spelling in
    // the one place on screen that is meant to be scannable — and the command
    // itself is printed in full along the bottom of every stage anyway.
    const bits = [live[0].path || 'nothing chosen'];
    if (live[0].to) bits.push(`${live[0].to}s`);
    return [live[0].format, bits.join(' · ')];
}

// ── recording ──────────────────────────────────────────────────────────────

/// The `also` half of the recording's spec: one output object per extra file.
///
/// `g` is `graphOf()`, whose `files` array is parallel to `filePicks()` — entry
/// zero is the recording itself and the rest are these rows in order. The
/// labels come from there rather than from the row, because what a pad is
/// *called* is `recordGraph`'s answer: it imposes `vout`/`aout` on the first
/// file's ends and settles the collisions among the rest, and a second
/// implementation of that here would be a second answer to it.
///
/// **With no graph there is nothing to map**, and a row is a second encode of
/// the device straight through — which is a proxy, and worth having: the
/// stream list is left off and the engine writes the composite into it exactly
/// as it does into the first file.
function alsoSpecs(g) {
    const rows = alsoFiles();
    const enc = effectiveVideo();
    return rows.map((f, i) => {
        const out = { path: f.path, format: f.format };
        if (enc && enc.crf) out.crf = capture.quality;
        if (enc && enc.preset) out.preset = 'veryfast';
        if (capture.videoCodec) out.videoCodec = capture.videoCodec;
        if (capture.audioCodec) out.audioCodec = capture.audioCodec;
        const pads = g && g.ok && g.files ? g.files[i + 1] : null;
        if (!pads) return out;
        // No `codec` on the rows: an empty one is the output's, which is what
        // the two lines above already set, and naming it twice would be two
        // places for it to be changed.
        out.streams = [];
        if (pads.video) out.streams.push({ kind: 'video', source: `pad:${pads.video}` });
        if (pads.audio) out.streams.push({ kind: 'audio', source: `pad:${pads.audio}` });
        return out;
    });
}

export function startRecording() {
    if (recording) return;
    if (!ready()) {
        const g = graphOf();
        const clash = clashingPath();
        if (hooks.flash)
            hooks.flash(g && !g.ok ? `The graph will not run: ${g.reason}`
                : clash
                    ? `Two of this recording’s files are both ${basename(clash)} — one ` +
                      'muxer per file, and two writing to one interleave into something ' +
                      'no player reads.'
                : capture.inputs.length > 1
                    ? 'Several inputs need a filter graph — it is what says how they ' +
                      'combine. Build one on the Graph stage: the devices are in its ' +
                      'source list.'
                    : 'Activate a device first');
        return;
    }
    if (!capture.path) capture.path = defaultPath();

    // The devices go to the recording, not to the previews. A camera is
    // exclusive on Windows and the second open fails; letting a preview keep
    // one would make every recording fail with a message about the device being
    // in use, which reads as a broken application.
    stopPreviews();

    const enc = effectiveVideo();
    const g = graphOf();
    // **`sources` and not `source`, at one input as much as at several.** The
    // engine reads an absent list as `{source}` and a present one as itself, so
    // the singular spelling buys nothing here except a second shape to keep in
    // step. See src/native/ffmpeg_capture.h.
    const spec = Object.assign({
        sources: asInputs(),
        path: capture.path,
        format: capture.format,
    }, g && g.ok ? { filterGraph: g.filterGraph } : {},
       enc && enc.crf ? { crf: capture.quality } : {},
       // Fast on purpose and only where the encoder has the word: a capture
       // encodes in real time beside whatever is being recorded, and a preset
       // that cannot keep up drops frames off the front of the queue.
       enc && enc.preset ? { preset: 'veryfast' } : {},
       capture.videoCodec ? { videoCodec: capture.videoCodec } : {},
       capture.audioCodec ? { audioCodec: capture.audioCodec } : {});

    // **The other files, each mapping the pads it named.** They are not given
    // the graph — there is one, and it belongs to the session — and they are
    // not given a size, because a picture's size here is its pad's. What they
    // do carry is a stream list, which is the only way a second file can say
    // which of the graph's ends it is of: `pad:<label>` is `-map [label]`, and
    // `g.files[n]` is what the labels turned out to be. See ffmpeg_capture.h.
    const also = alsoSpecs(g);
    if (also.length) spec.also = also;

    try {
        bro.ffmpeg.record.start(spec);
    } catch (e) {
        if (hooks.flash) hooks.flash(String((e && e.message) || e));
        for (const c of cards) c.key = '';
        syncPreviews();
        return;
    }
    recording = true;
    lastFile = '';
    lastBytes = 0;
    status = null;
    if (hooks.changed) hooks.changed();
    drawCapture();
}

/// Stop is how a recording ends, and the native side agrees: a stopped
/// recording reports `done`, not `cancelled`. See src/native/ffmpeg_capture.h.
export function stopRecording() {
    if (!recording) return;
    try { bro.ffmpeg.record.stop(); } catch (e) { /* already over */ }
}

/// Watched from the frame loop, the way the export's job is: nothing calls
/// back into JS because QuickJS has one thread and a callback would have to be
/// marshalled onto it anyway.
export function tick() {
    if (!recording) {
        // A device element that is sitting paused is a preview nobody can see.
        // `play()` is asked for again rather than once at creation because the
        // element is pointed at the device before the demuxer has opened it —
        // a camera takes a moment — and because a recording takes the devices
        // away and gives them back. Cheap, and only while the stage is up:
        // there are no elements anywhere else.
        for (const c of cards) {
            if (c.video && c.video.paused)
                try { c.video.play(); } catch (e) { /* not ready yet */ }
        }
        if (composite && composite.paused)
            try { composite.play(); } catch (e) { /* not ready yet */ }
        // **The graph's pad arrives late, and nothing else would notice.** A
        // session's device pads exist the moment it opens; the composition's
        // does not, because libavfilter cannot say how big a pad is until it
        // has configured the graph and it cannot configure until a camera has
        // handed over a frame. So this is where the picture appears — the same
        // frame loop that keeps the previews playing, asking a question that
        // costs a lookup and answers itself once.
        if (session.id && !compKey) syncComposite();
        // The sound pads arrive with the graph's, and for the same reason.
        syncMeters();
        tickMeters();
        fitPreviews();
        return;
    }
    let p = null;
    try { p = bro.ffmpeg.render.poll(); } catch (e) { return; }
    status = p;
    if (p.state === 'running') { drawRecording(); return; }

    recording = false;
    lastFile = p.path || capture.path;
    lastBytes = p.bytes || 0;
    if (hooks.flash)
        hooks.flash(p.state === 'failed' ? `Recording failed: ${p.error}`
                                         : `Recorded ${basename(lastFile)}`);
    if (hooks.changed) hooks.changed();
    // The devices are free again, so the pictures come back.
    for (const c of cards) c.key = '';
    syncPreviews();
    drawCapture();
}

// ── drawing ────────────────────────────────────────────────────────────────

export function drawCapture() {
    if (!refs.list) return;
    drawDevices();
    syncCards();
    drawGraph();
    drawSettings();
    drawRecording();
    put(refs.options, () => optionRows());
}

/// The left column: what this machine can capture, and what the focused one of
/// them can see.
///
/// **libav's own human name is the label and the `-f` name is underneath it.**
/// It was the other way round, and a column headed `dshow / gdigrab / lavfi /
/// vfwcap` is a list only somebody who already knows the answer can read. Both
/// strings come out of the registry — `long_name` and `name` — so nothing here
/// is a table of nice names that a different build would fall off the end of.
function drawDevices() {
    put(refs.list, () => {
        const all = devices();
        const active = captureInputs();
        const out = [head('Capture from')];
        if (!all.length) {
            out.push(div('cap-note dim', 'This build registered no capture devices.'));
            return out;
        }
        for (const d of all) {
            const using = active.filter((i) => i.format === d.name).length;
            // A div and not a `<button>`, for the reason `.src-row` on the
            // Sources stage is one: the base button rule is a 26px single-line
            // control and this engine will not grow one past it however the
            // display and the height are written, so the second line lands on
            // whatever is underneath. A row that is a row lays out correctly and
            // takes its own click listener like anything else here.
            out.push(el('div', {
                cls: 'cap-device' + (using ? ' on' : ''),
                'data-device': d.name,
                title: `Add ${d.name} to this recording. It becomes an input the rest of ` +
                       'the application can read — the Sources stage and the graph’s ' +
                       'source list get it at the same moment.',
                on: { click: () => activate(d.name) },
            }, [
                div('cap-device-text', [
                    div('cap-device-name', d.longName || d.name),
                    div('cap-device-what dim mono', `${d.name} · ${d.kinds.join(' · ')}`),
                ]),
                using ? span(`${using}×`, 'cap-device-n') : null,
                span('+', 'cap-device-add'),
            ]));
        }
        const inp = focused();
        if (inp) {
            // Which card the sources below and the option column on the right
            // are about. Only where there is a choice — with one card it is a
            // sentence about the only thing on the screen.
            if (active.length > 1)
                out.push(el('div', {
                    cls: 'cap-note dim', text: `Editing [${focus}]`,
                    title: 'Click a card to point this column and the options at another input',
                }));
            out.push(...sourceRows(inp));
        }
        return out;
    });
}

/// What one enumerated source is called after the `-i`.
///
/// `video=` / `audio=` is dshow's syntax and it is the reason `mediaTypes` is
/// reported at all: `avdevice_list_input_sources` hands back the cameras and
/// the sound cards in one list, and without the media type a capture UI has to
/// guess which is which from the description. A device that lists sources
/// without typing them is named directly, which is what every other one does.
function sourceArg(s) {
    if (!s) return '';
    const kinds = s.mediaTypes || [];
    if (kinds.indexOf('video') >= 0) return `video=${s.description || s.name}`;
    if (kinds.indexOf('audio') >= 0) return `audio=${s.description || s.name}`;
    return s.description || s.name;
}

function sourceRows(inp) {
    const list = sourcesOf(inp.format);
    const out = [head(`What ${inp.format} can see`)];

    if (!list.ok) {
        // An answer, not a failure. gdigrab takes a rectangle rather than a
        // device name and says so; an empty list here would read as a machine
        // with no cameras in it.
        out.push(el('div', {
            cls: 'cap-note dim',
            text: list.error || `${inp.format} does not list its sources.`,
            title: 'It is named directly instead — libavdevice has no get_device_list for ' +
                   'this demuxer, so there is nothing to enumerate. The field takes anything.',
        }));
        if (HINTS[inp.format])
            out.push(div('btns', [el('button', {
                cls: 'tiny', 'data-f': 'caphint',
                text: `Use “${HINTS[inp.format]}”`,
                title: 'A starting point out of ffmpeg’s documentation — libavdevice has no ' +
                       'call that returns it, so it is a hint and not a capability. The field ' +
                       'takes anything.',
                on: { click: () => setSource(HINTS[inp.format], inp) },
            })]));
        return out;
    }

    for (const s of list.sources) {
        const arg = sourceArg(s);
        out.push(el('div', {
            cls: 'cap-device' + (arg === inp.path ? ' on' : ''),
            'data-source': s.description || s.name,
            title: `Capture from ${s.description || s.name}`,
            on: { click: () => setSource(arg, inp) },
        }, [
            div('cap-device-text', [
                div('cap-device-name', s.description || s.name),
                div('cap-device-what dim mono', (s.mediaTypes || []).join(' · ') || 'unknown'),
            ]),
        ]));
    }
    if (!list.sources.length)
        out.push(div('cap-note dim', 'Nothing plugged in.'));

    // Two of them at once is one `-i`, which is what a camera and a microphone
    // recorded together actually is — one demuxer, one seek, one file. That is
    // a different thing from two *devices*, which is two `-i`s and a card each.
    const audio = list.sources.filter((s) => (s.mediaTypes || []).indexOf('audio') >= 0);
    if (audio.length && inp.path.indexOf('video=') === 0)
        out.push(el('div', {
            cls: 'cap-note dim', text: 'Click a sound source to add a mic.',
            title: 'A camera and a microphone are one -i — video=…:audio=… — which is what ' +
                   'dshow means by it: one demuxer, one file, two streams. A separate ' +
                   'device is a separate input.',
        }));

    out.push(div('btns', [el('button', {
        cls: 'tiny', 'data-f': 'caprescan', text: 'Rescan',
        title: 'Ask the device again — this is the one query here that talks to hardware, ' +
               'so it is asked once and cached until you press this',
        on: { click: () => { sourcesOf(inp.format, true); drawCapture(); } },
    })]));
    return out;
}

function setSource(arg, inp) {
    if (!inp) return;
    // A sound source clicked while a camera is chosen joins it rather than
    // replacing it: `video=Cam:audio=Mic` is one input and two streams, which
    // is what dshow means by it.
    const path = (arg.indexOf('audio=') === 0 && inp.path.indexOf('video=') === 0 &&
                  inp.path.indexOf(':audio=') < 0)
        ? `${inp.path}:${arg}`
        : arg;
    change(inp, { path });
}

// ── the graph ──────────────────────────────────────────────────────────────

/// What the Graph stage says about this recording, in the three states it can
/// be in.
///
/// **Read-only, and that is the change.** There was a textarea here, and three
/// buttons that wrote a chain into it out of the devices' probes. What the
/// buttons did — scale two pictures to one height, stack them, mix whatever
/// sound there is — the Graph stage does with nodes, on a canvas that checks the
/// wiring against libavfilter's own pad lists and can render a preview of any
/// point in it. Keeping the field as well would mean two descriptions of one
/// recording and no rule about which wins.
///
/// The chains are shown rather than hidden because this is where somebody
/// decides whether to press Record, and "what will actually run" is the
/// question they are asking. It is the same text the command bar prints, from
/// the same call.
///
/// **One line, with the door on the end of it.** This was a headed panel and a
/// paragraph, and the paragraph was permanent: "nothing in the graph reads this
/// device" is the ordinary state of a one-device recording, so the commonest
/// screen in the stage carried four lines explaining the case where there is
/// nothing to explain. What a person needs here is the answer — none, this, or
/// this is broken — and a way to go and change it. The argument is in
/// docs/manual/capture.md and in the header above.
function drawGraph() {
    if (!refs.graph) return;
    put(refs.graph, () => {
        if (!capture.inputs.length) return [];
        const g = graphOf();
        const n = capture.inputs.length;
        const door = (text) => el('button', {
            cls: 'tiny', 'data-f': 'capgraphstage', text,
            title: 'Open the Graph stage. Every activated device is already in its source ' +
                   'list, so placing one gives a node that can be wired, checked and ' +
                   'previewed.',
            on: { click: () => { if (hooks.goTo) hooks.goTo('graph'); } },
        });

        const strip = (cls, text, why, label) => div(`cap-strip${cls}`, [
            span('Filters', 'cap-strip-k'),
            el('span', { cls: `cap-strip-v${cls ? ' warn' : ' dim'}`, text, title: why }),
            door(label),
        ]);

        if (!g)
            // No picker here even where the graph has ends of its own: nothing
            // it holds reads these devices, so every one of them would be a
            // choice that leads straight to a refusal.
            return n > 1
                ? [strip(' bad', `${n} inputs, nothing joining them`,
                         'Two pictures and nothing saying how they combine is refused ' +
                         'rather than guessed at. Place them on the Graph stage and wire ' +
                         'them to video out.', 'Build')]
                : [strip('', 'none',
                         'Nothing in the graph reads this device, so it is recorded exactly ' +
                         'as it comes. To crop it, or to put a camera in the corner of it, ' +
                         'place it on the Graph stage.', 'Add…')];
        if (!g.ok)
            return [strip(' bad', `will not run — ${g.reason}`,
                          'The Graph stage draws the same problem against the node it is ' +
                          'about.', 'Fix'),
                    ...padRows()];

        // One line per chain, because that is how a person reads a filtergraph —
        // the semicolons are where it breaks and joining them into one line is
        // what makes a five-chain graph unreadable.
        const chains = g.filterGraph.split(';');
        return [
            div('cap-strip', [
                span('Filters', 'cap-strip-k'),
                el('span', {
                    cls: 'cap-strip-v',
                    text: `${n} input${n === 1 ? '' : 's'} → ` +
                          [g.video && `[${g.video}]`, g.audio && `[${g.audio}]`]
                              .filter(Boolean).join(' + '),
                    title: 'What the writer maps. The same text the command bar prints, from ' +
                           'the same call.',
                }),
                door('Edit'),
            ]),
            div('cap-chains', chains.map((chain) => span(chain, 'mono dim cap-chain'))),
            ...padRows(),
        ];
    });
}

/// Which end of the graph this recording writes — where there is a choice.
///
/// **Absent until the graph offers one**, which is the same rule the region
/// fields and the CRF field follow: a control with one option is a statement
/// dressed as a question. A graph whose only ends are the derivation's own is
/// the ordinary case and the pickers would say nothing there.
///
/// The choice exists because video out is where a *render* ends too. One pad
/// cannot be both the timeline's composite and the cameras' — wiring the
/// cameras into it leaves the composite feeding nothing, which the Graph stage
/// correctly complains about — so a recording that wants its own picture places
/// an output of its own and writes that instead. It is `-map [out2]` and
/// nothing more; the composition is still described once, on the Graph stage.
function padRows() {
    const pads = recordPads(overlayState());
    if (pads.v.length < 2 && pads.a.length < 2) return [];
    const pick = (stream) => {
        const list = pads[stream];
        const now = stream === 'v' ? capture.videoPad : capture.audioPad;
        return el('select', {
            cls: 'wide', 'data-f': stream === 'v' ? 'capvpad' : 'capapad',
            title: 'Which end of the graph this file gets. Video out is where a render of ' +
                   'the timeline ends too, so cameras wired there leave the composite ' +
                   'feeding nothing — give them an output of their own and pick it here.',
            on: { change: (e) => {
                if (stream === 'v') capture.videoPad = e.target.value;
                else capture.audioPad = e.target.value;
                redraw();
            } },
        }, list.map((p) => el('option', {
            value: p.id, text: p.label, selected: p.id === now,
        })));
    };
    const rows = [];
    if (pads.v.length > 1) rows.push(row('Picture from', pick('v')));
    if (pads.a.length > 1) rows.push(row('Sound from', pick('a')));
    return rows;
}

// ── the file ───────────────────────────────────────────────────────────────

/// The right column: what comes out.
///
/// **Always drawn, including with nothing activated.** It used to be replaced
/// by a paragraph about what a device is, which put the one thing somebody
/// might reasonably set in advance — where the file goes — behind activating a
/// camera. The paragraph is now the middle column's empty state, where a
/// person is already looking.
function drawSettings() {
    put(refs.settings, () => {
        const path = el('input', {
            cls: 'wide', 'data-f': 'cappath', type: 'text', value: capture.path,
            title: 'A path, or a URL, or a tee argument — a recording is a device into a ' +
                   'muxer, so anything the Write stage can write to works here',
            on: { change: () => { capture.path = path.value.trim(); redraw(); } },
        });

        const rows = [head('The recording')];
        rows.push(row('Save to', path));
        rows.push(row('Container', muxerPicker()));
        // Where a recording goes is the same question the Write stage asks, and
        // the same answer: a recording is a device into a `Writer`, and a
        // `Writer` is a muxer, so `-f tee` and a URL work here for the reason
        // they work there. What is *not* here is the destination editor — one
        // encode to a file and a stream at once is exactly the case tee exists
        // for and is two lines to type, and a second copy of that editor would
        // be a second answer to how the argument is escaped.
        rows.push(...destinationRows());
        rows.push(row('Video', codecPicker(false)));
        rows.push(row('Audio', codecPicker(true)));
        // Only where the encoder has the word. An encoder with no `crf` — a
        // hardware one, ProRes, FFV1 — would be handed a key it has never heard
        // of, which is an error at both ends of this application, and a control
        // that quietly did nothing would be worse than its absence.
        const enc = effectiveVideo();
        if (enc && enc.crf) rows.push(row('Quality', qualityField(enc)));
        else rows.push(row('Quality', el('span', {
            cls: 'dim', text: enc ? 'fixed' : 'the container decides',
            title: enc
                ? `${enc.label || enc.id} has no CRF — it is written at its own quality, and ` +
                  'handing it one would be an option the encoder has never heard of'
                : 'Nothing is chosen, so the muxer reaches for its own default encoder',
        })));

        // When it stops, where that is a fact rather than a setting: `-t`
        // belongs to an input and is set on its card, so this states what the
        // inputs between them come to.
        const ends = shortest();
        rows.push(row('Length', el('span', {
            cls: 'dim', text: ends ? clock(ends) : 'until you stop',
            title: ends
                ? 'The shortest input’s — one that has run out has nothing further to offer ' +
                  'the graph. Set it on a card.'
                : 'No input has a Stop after set',
        })));
        rows.push(...alsoRows());
        return rows;
    });
}

/// The Also-write list: the other files this one reading of the devices writes.
///
/// **The third answer to "two outputs", and the one only a capture has.** The
/// Write stage has the other two and says how they differ: `tee` is one encode
/// to several places, a version is several encodes of one edit run one after
/// another. A recording cannot run anything twice — what it was reading has
/// happened — so its several encodes are several muxers open at once on the end
/// of one pass, which is why this is a list here rather than the Write stage's.
///
/// A row is a path, a container and which ends of the graph it gets. Not a
/// size: on this stage a picture's size is its pad's, and another size is a
/// `scale` on the Graph stage with an output of its own — which this row can
/// then be pointed at.
///
/// Collapsed to a heading until there is one, like the Write stage's list, and
/// costing nothing to have open: a row somebody is still typing a path into is
/// simply not part of the recording yet.
function alsoRows() {
    const pads = recordPads(overlayState());
    const list = capture.also;
    const rows = [head(`${list.length ? '▾' : '▸'} Also write · ${list.length}`, {
        cls: 'section-head ex-toggle', 'data-f': 'capalso',
        // The list is its own disclosure, as the Write stage's is: empty it is
        // one line, and pressing it is how the first row arrives.
        on: { click: () => { if (!list.length) addAlso(); } },
    })];

    if (!list.length) {
        rows.push(row('', el('span', { cls: 'dim', text:
            'One encode to several places is the tee muxer, above. This is the other one, ' +
            'and only a recording has it: a second muxer open beside the first, of another ' +
            'end of the same graph. The cameras into one file, a cropped copy into the ' +
            'next — one reading of the devices, because there is no second one to have.' })));
        return rows;
    }

    list.forEach((f, i) => {
        const path = el('input', {
            cls: 'wide', 'data-f': `capalso-path-${i}`, type: 'text', value: f.path,
            placeholder: 'where this one goes',
            on: { change: () => { f.path = path.value.trim(); redraw(); } },
        });
        const muxers = (bro.ffmpeg.muxers || []).filter((m) => m.ext && !m.noFile);
        const format = el('select', {
            cls: 'wide', 'data-f': `capalso-format-${i}`,
            on: { change: (e) => { f.format = e.target.value; redraw(); } },
        }, muxers.map((m) => el('option', {
            value: m.name, text: `${m.label || m.name} (.${m.ext})`,
            selected: m.name === f.format,
        })));
        // **Drawn whatever the graph has, unlike the recording's own pickers**
        // — those appear only where there is a choice, because with one end
        // they would be a statement dressed as a question. Here the statement
        // is the point: a file left on the same end as the recording is a
        // second encode of the same picture, and a row that did not say so
        // would be a copy nobody could see they had asked for.
        const pick = (stream) => el('select', {
            cls: 'wide', 'data-f': `capalso-${stream}pad-${i}`,
            title: 'Which end of the graph this file gets. Another one is what makes it a ' +
                   'different file rather than a second copy of the same picture.',
            on: { change: (e) => {
                if (stream === 'v') f.videoPad = e.target.value;
                else f.audioPad = e.target.value;
                redraw();
            } },
        }, pads[stream].map((p) => el('option', {
            value: p.id, text: p.label,
            selected: p.id === (stream === 'v' ? f.videoPad : f.audioPad),
        })));

        rows.push(head(`File ${i + 2}`, { cls: 'section-head' }));
        rows.push(row('Picture from', pick('v')));
        rows.push(row('Sound from', pick('a')));
        rows.push(row('-f', format));
        rows.push(row('To', path));
        rows.push(row('', div('btns', [el('button', {
            cls: 'tiny', 'data-f': `capalso-drop-${i}`, text: 'Remove',
            on: { click: () => { capture.also.splice(i, 1); redraw(); } },
        })])));
    });

    rows.push(row('', div('btns', [el('button', {
        cls: 'tiny', 'data-f': 'capalso-add', text: '+ File', on: { click: addAlso },
    })])));
    rows.push(row('', el('span', { cls: 'dim', text:
        'The encoders, the quality and the devices are the recording’s — what a file of ' +
        'its own has is a container, somewhere to go, and which ends of the graph it ' +
        'takes. The size is the pad’s: another size is a scale on the Graph stage with ' +
        'an output to point at.' })));
    return rows;
}

/// A file pre-filled with the recording's own container, and pointed at the
/// same ends it is: a row arrives meaning something, and what makes it a
/// second *file* rather than a second copy is the one thing left to say.
function addAlso() {
    capture.also.push({ id: nextAlso++, path: '', format: capture.format,
                        videoPad: capture.videoPad, audioPad: capture.audioPad });
    redraw();
}

function redraw() {
    if (hooks.changed) hooks.changed();
    drawCapture();
    syncPreviews();
}

/// What the recording's destination turns out to be, when it is not one file.
///
/// **Stated, not offered.** A recording is a device into a `Writer` and a
/// `Writer` is a muxer, so a URL and a `-f tee` argument reach one here exactly
/// as they do from the Write stage. What this adds is the two things somebody
/// cannot see by looking at the field: whether the protocol a URL names is in
/// this build — it fails at open with a message about a filename otherwise —
/// and, for a tee, how many destinations the argument comes to, since a
/// mistyped separator reads as one destination with a strange name.
function destinationRows() {
    const rows = [];
    const scheme = schemeOf(capture.path);
    if (scheme) {
        const linked = protocolLinked(scheme);
        rows.push(row('Protocol', el('span', {
            cls: linked ? 'mono' : 'mono src-missing',
            text: linked ? `${scheme} · linked in` : `${scheme} · not in this build`,
            title: linked
                ? 'Sent rather than written, so there is no size and no percentage — what ' +
                  'it reports is what went out.'
                : 'This build has no such protocol, so the open will fail with a message ' +
                  'about a filename',
        })));
    }
    if (capture.format === 'tee') {
        // Counted by hand rather than with a split, because the separator can
        // be escaped and a lookbehind is not something to rely on here.
        const text = String(capture.path || '');
        let n = text ? 1 : 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === '|') n++;
        }
        rows.push(row('Writes to', el('span', {
            cls: 'dim', text: `${n} destination${n === 1 ? '' : 's'}`,
            title: 'Recording and streaming at once is one encode through tee, written ' +
                   '[f=matroska]take1.mkv|[f=flv]rtmp://…  The Write stage has an editor ' +
                   'for the argument; here it is typed, because a second copy of the ' +
                   'escaping would be a second answer to it.',
        })));
    }
    return rows;
}

/// The region, on the card whose picture it is dragged on.
///
/// **Picked rather than typed**, by dragging on that card's live picture —
/// which is the only way it could be picked in this engine, and it turns out to
/// be the right way anyway: the thing being framed is on the screen in front of
/// you. The numbers are shown as well as set, because `offset_x` is what the
/// command bar prints and a rectangle nobody can read off is a rectangle nobody
/// can reproduce.
///
/// **On the card and not in a column**, which is where it was: a headed section
/// in the right-hand column, describing a rectangle on a picture two columns
/// away, and — with two screen grabbers activated — one section for whichever
/// card happened to be focused. A region belongs to an input the way its source
/// does.
function regionRows(inp) {
    if (!inp || !takesRegion(inp.format)) return [];
    const o = inp.options;
    const set = o.video_size || o.offset_x || o.offset_y;
    const reset = el('button', {
        cls: 'tiny', 'data-f': 'capwhole', text: 'Reset',
        title: 'Capture the whole screen again',
        on: { click: () => {
            const next = Object.assign({}, inp.options);
            delete next.video_size;
            delete next.offset_x;
            delete next.offset_y;
            change(inp, { options: next });
        } },
    });
    // One row, because two — a value and a line under it saying how to change
    // the value — is the shape this whole stage was made of.
    return [row('Region', el('div', { cls: 'btns' }, [
        el('span', {
            cls: 'mono',
            text: set
                ? `${o.video_size || 'full'} at ${o.offset_x || 0},${o.offset_y || 0}`
                : 'the whole screen',
            title: 'This device’s own -offset_x, -offset_y and -video_size, in the screen’s ' +
                   'pixels. They are in the option table on the right beside everything ' +
                   'else it takes.',
        }),
        set ? reset : span('· Drag to crop', 'dim'),
    ]))];
}

function muxerPicker() {
    const all = (bro.ffmpeg.muxers || []).filter((m) => m.ext && !m.noFile);
    return el('select', {
        cls: 'wide', 'data-f': 'capformat',
        on: { change: (e) => { capture.format = e.target.value; redraw(); } },
    }, all.map((m) => el('option', {
        value: m.name, text: `${m.label || m.name} (.${m.ext})`,
        selected: m.name === capture.format,
    })));
}

function codecPicker(audio) {
    const all = audio ? (bro.ffmpeg.audioEncoders || []) : (bro.ffmpeg.encoders || []);
    const chosen = audio ? capture.audioCodec : capture.videoCodec;
    // Narrowed to what the chosen muxer will hold, asked of
    // `avformat_query_codec` at startup exactly as the Encode stage's is — and
    // left alone for a muxer that has never been taught to answer, because
    // reading its shrug as a refusal is how a picker comes to insist MPEG-TS
    // will not hold H.264.
    const m = (bro.ffmpeg.muxers || []).find((x) => x.name === capture.format);
    const ok = m && m.answersCodecs
        ? all.filter((c) => (audio ? m.audioCodecs : m.videoCodecs).indexOf(c.id) >= 0)
        : all;
    return el('select', {
        cls: 'wide', 'data-f': audio ? 'capacodec' : 'capvcodec',
        on: { change: (e) => {
            if (audio) capture.audioCodec = e.target.value;
            else capture.videoCodec = e.target.value;
            redraw();
        } },
    }, [el('option', { value: '', text: 'the muxer’s default', selected: !chosen })]
        .concat(ok.map((c) => el('option', {
            value: c.id, text: c.label || c.id, selected: c.id === chosen,
        }))));
}

/// Constant quality, as the encoder's own range rather than a number to know.
///
/// It was a text box containing `23`, which is a control only somebody who
/// already knows what CRF is can use — and knowing that it runs the *other* way
/// from every other quality control in the world is exactly the thing a slider
/// can show and a number cannot. The label under it is the encoder's ends
/// named, and the value stays visible in `crf` spelling because that is what
/// the command bar prints.
///
/// The range comes from `qualityRange()` — the Encode stage's, the same
/// question of the same option table — so an encoder with a different scale
/// gets its own ends and not x264's.
function qualityField(enc) {
    const q = qualityRange(enc.id);
    const value = span(`crf ${capture.quality}`, 'mono');
    const slider = el('input', {
        'data-f': 'capquality', type: 'range', min: q.min, max: q.max,
        value: String(capture.quality),
        title: `Constant quality. ${q.min} is the best this encoder does and ${q.max} the ` +
               'smallest file; it is -crf on the command line.',
        // Not a full redraw: rebuilding the form under a dragging pointer loses
        // the drag on the first move. The command bar is told, because it
        // prints the number.
        on: { input: () => {
            capture.quality = Number(slider.value) || capture.quality;
            value.textContent = `crf ${capture.quality}`;
            if (hooks.changed) hooks.changed();
        }, change: () => redraw() },
    });
    return el('div', { cls: 'btns' }, [slider, value]);
}

// ── the record bar ─────────────────────────────────────────────────────────

/// Why the Record button is dead, in one clause, or '' when it is live.
///
/// **The same conditions `ready()` checks, in the same order**, so that a
/// disabled button always has a reason and a live one never shows one. It is
/// one function and not two because the two drifting apart is a button that is
/// dead with nothing next to it, which is the worst state a stage can be in.
function blocker() {
    const all = captureInputs();
    if (!all.length) return 'Pick a device';
    for (const i of all) if (!i.format || !i.path) return 'A source is empty';
    const g = graphOf();
    // Short, because the strip directly above already carries the reason —
    // twice on one screen is the habit this whole stage was rewritten out of.
    if (g && !g.ok) return 'Graph won’t run';
    if (all.length > 1 && !g) return 'Needs a graph';
    // Two muxers at one path interleave into something no player reads, and the
    // engine refuses it by name. Short here for the reason above; the sentence
    // is on the press.
    if (clashingPath()) return 'Two files, one path';
    return '';
}

/// What the file will be, in the words the pickers on the right use.
function destinationWhat() {
    const m = (bro.ffmpeg.muxers || []).find((x) => x.name === capture.format);
    const enc = effectiveVideo();
    return [m ? (m.label || m.name) : capture.format, enc && (enc.label || enc.id)]
        .filter(Boolean).join(' · ');
}

/// The act, and what a recording can honestly say about itself.
///
/// **The bottom of the middle column, at the weight of the thing it is.** The
/// button used to be an ordinary-looking control in the middle of the page with
/// prose either side, and the file it was about to write was scrolled off the
/// bottom of the same column. Now the destination is beside the button that
/// sends it there and the reason it is dead — where there is one — is beside it
/// too, rather than in a panel somebody has to go and find.
export function drawRecording() {
    if (!refs.bar) return;
    put(refs.bar, () => {
        const out = [];
        if (recording) {
            const st = status || {};
            out.push(el('button', {
                cls: 'cap-go', 'data-f': 'capstop',
                title: 'Stop recording and close the file',
                on: { click: stopRecording },
            }, [div('cap-go-dot stop'), span('Stop')]));
            // **No percentage.** Elapsed, frames and size are facts; a fraction
            // of a total nobody knows is not one. With a `-t` on the device the
            // job does have a total and says so, and then the bar means
            // something — which is why this reads `openEnded` rather than
            // assuming.
            out.push(span(clock(st.elapsed || 0), 'cap-elapsed mono'));
            out.push(span(`${st.frames || 0} frames`, 'dim mono'));
            out.push(span(bytes(st.bytes || 0), 'dim mono'));
            out.push(div('spacer'));
            out.push(el('span', {
                cls: 'dim',
                text: st.openEnded
                    ? 'runs until you stop it'
                    : `${Math.round((st.progress || 0) * 100)}% of ${clock(shortest())}`,
                title: st.openEnded
                    ? 'No -t on any input, so nobody knows how long this will be — a ' +
                      'percentage of an unknown total would be an invention.'
                    : undefined,
            }));
        } else {
            const why = blocker();
            out.push(el('button', {
                cls: 'cap-go', 'data-f': 'caprecord', disabled: !!why,
                title: why || `Record to ${capture.path}`,
                on: { click: startRecording },
            }, [div('cap-go-dot'), span('Record')]));
            if (why) out.push(span(why, 'cap-why'));
            else out.push(div('cap-dest', [
                el('div', {
                    cls: 'cap-dest-name mono', text: basename(capture.path) || 'unnamed',
                    title: capture.path,
                }),
                div('cap-dest-what dim', destinationWhat()),
            ]));
            out.push(div('spacer'));
            if (lastFile) {
                out.push(el('span', {
                    cls: 'mono', text: basename(lastFile),
                    title: `Just recorded: ${lastFile}`,
                }));
                out.push(span(bytes(lastBytes), 'dim mono'));
                out.push(el('button', {
                    cls: 'tiny', 'data-f': 'capuse', text: 'Add to timeline',
                    title: 'Open what was just recorded as an input and lay it on the edit — ' +
                           'the arrow from Capture to Sources, followed',
                    on: { click: () => { if (hooks.open) hooks.open(lastFile); } },
                }));
            }
        }
        return out;
    });

    if (refs.note) {
        put(refs.note, () => {
            if (recording)
                return [el('div', {
                    cls: 'cap-note dim', text: 'Previews are dark while recording.',
                    title: 'The devices are going to the recording rather than to a preview ' +
                           '— a camera is exclusive, and a picture of one here would be the ' +
                           'recording failing.',
                })];
            return [];
        });
    }
}

/// The `-t` that ends the session: the shortest of the inputs', or zero when
/// any of them runs until stopped. The engine's rule, said the same way here —
/// see `limitOf` in ffmpeg_capture.cpp.
function shortest() {
    let best = 0;
    for (const i of captureInputs()) {
        if (!i.to) continue;
        if (!best || i.to < best) best = i.to;
    }
    return best;
}

// ── the pictures, fitted ───────────────────────────────────────────────────

/// Place each preview inside its card at its own aspect.
///
/// Not `object-fit`, and not left to stretch. Stretching matters here more than
/// it does anywhere else in this application: a region is dragged on this
/// picture, so a picture that is not the shape of the screen is a rectangle
/// that is not the shape of the one you drew. Fitted, the drag is one ratio in
/// both axes and the box on screen is the box that gets captured.
function fitPreviews() {
    for (const c of cards) fitOne(c);
}

function fitOne(c) {
    if (!c.video) return;
    const vw = c.video.videoWidth, vh = c.video.videoHeight;
    const cw = c.pic.clientWidth, ch = c.pic.clientHeight;
    // A card of a stage that is `display:none` measures zero, and every stage
    // view in this application is hidden rather than unmounted — so a zero is a
    // measurement of a hidden panel and not a picture with no size.
    if (!vw || !vh || !cw || !ch) return;
    const scale = Math.min(cw / vw, ch / vh);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (c.video.clientWidth === w && c.video.clientHeight === h) return;
    c.video.style.width = `${w}px`;
    c.video.style.height = `${h}px`;
    c.video.style.left = `${Math.round((cw - w) / 2)}px`;
    c.video.style.top = `${Math.round((ch - h) / 2)}px`;
}

// ── the region drag ────────────────────────────────────────────────────────
//
// A rectangle dragged on a card's preview, turned into that input's own
// options. Measured against the *picture* rather than against the card it sits
// in — the picture is fitted, so there is letterboxing around it, and a drag
// measured against the card would put the region a little off in whichever
// direction the black bars are.
//
// Wired per card at the moment the card is built, and it closes over the card
// rather than over its index: releasing an input renumbers every card after it,
// and a listener holding the old number would set a region on the wrong device.

function wireRegionDrag(card) {
    let from = null;

    const at = (e) => {
        const box = card.video.getBoundingClientRect();
        return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const inCard = (p) => {
        const panel = card.pic.getBoundingClientRect();
        const pic = card.video.getBoundingClientRect();
        return { x: p.x + (pic.left - panel.left), y: p.y + (pic.top - panel.top) };
    };

    card.pic.addEventListener('mousedown', (e) => {
        const i = cards.indexOf(card);
        const input = captureInputs()[i];
        if (i < 0 || !input || !takesRegion(input.format) || !card.video || recording) return;
        from = at(e);
        card.marquee.classList.remove('hidden');
        e.preventDefault();
    });
    card.pic.addEventListener('mousemove', (e) => {
        if (!from) return;
        const a = inCard(from), b = inCard(at(e));
        card.marquee.style.left = `${Math.min(a.x, b.x)}px`;
        card.marquee.style.top = `${Math.min(a.y, b.y)}px`;
        card.marquee.style.width = `${Math.abs(b.x - a.x)}px`;
        card.marquee.style.height = `${Math.abs(b.y - a.y)}px`;
    });
    card.pic.addEventListener('mouseup', (e) => {
        if (!from) return;
        const now = at(e);
        const start = from;
        from = null;
        card.marquee.classList.add('hidden');
        setRegionFromDrag(start, now, cards.indexOf(card));
    });
}

/// The dragged box, in the screen's own pixels.
///
/// Coordinates are relative to the *picture*, not to the card. Exported so a
/// test can do what a person does with a mouse: the drag itself is three
/// listeners and the arithmetic is the part worth checking. The index defaults
/// to the first input, which is the only one a single-device recording has.
export function setRegionFromDrag(from, to, index) {
    const i = index || 0;
    const c = cards[i];
    const input = captureInputs()[i];
    if (!c || !c.video || !input) return;
    const shownW = c.video.clientWidth || 1;
    const shownH = c.video.clientHeight || 1;
    const realW = c.video.videoWidth || shownW;
    const realH = c.video.videoHeight || shownH;

    const x = Math.max(0, Math.round(Math.min(from.x, to.x) * realW / shownW));
    const y = Math.max(0, Math.round(Math.min(from.y, to.y) * realH / shownH));
    // **Clamped to the picture, and it is not a formality.** A card is as wide
    // as the room the other cards left it, so one picture of a wide desktop can
    // be a couple of hundred pixels across — and then a drag is thirty-five
    // screen pixels per pixel of mouse, and a box dragged past the edge asks
    // gdigrab for a rectangle outside the screen. libavdevice refuses that at
    // the open ("capture area extends outside window area"), so the unclamped
    // version turned a slightly long drag into a device that would not reopen.
    // Even numbers, because yuv420p has no half pixels and gdigrab hands the
    // rectangle straight to the encoder.
    const w = Math.max(2, Math.min(realW - x, Math.round(
        Math.abs(to.x - from.x) * realW / shownW)) & ~1);
    const h = Math.max(2, Math.min(realH - y, Math.round(
        Math.abs(to.y - from.y) * realH / shownH)) & ~1);
    if (w < 16 || h < 16) return;   // a click, not a drag

    const next = Object.assign({}, input.options);
    next.offset_x = String(Math.max(0, x));
    next.offset_y = String(Math.max(0, y));
    next.video_size = `${w}x${h}`;
    change(input, { options: next });
}

// ── the option column ──────────────────────────────────────────────────────

function optionRows() {
    const inp = focused();
    if (!inp) return [];
    let all = [];
    try { all = bro.ffmpeg.demuxerOptions(inp.format) || []; } catch (e) { all = []; }
    return optionColumn({
        name: 'capoptsearch',
        title: capture.inputs.length > 1
            ? `[${focus}] ${inp.format} options · ${all.length}`
            : `${inp.format} options · ${all.length}`,
        // No note. The column used to open with three sentences about where the
        // table comes from and what an unknown key does — permanently on
        // screen, above a search box, for a table most recordings never touch.
        // The one consequence worth knowing rides on the hint line, which is
        // only drawn while the list is empty anyway.
        note: '',
        options: all,
        bag: inp.options,
        hint: 'An unknown key stops the open.',
        // The bag is edited in place, so the input has to be told to open
        // again with it — the same call the Sources stage makes after editing
        // a file's demuxer options, and for the same reason.
        onChange: () => { reprobe(inp); projectChanged('inputs'); redraw(); },
    });
}

// ── the command ────────────────────────────────────────────────────────────

/// The capture as the command it is, or null when this stage is not the one
/// being described.
///
/// Read by ui/command.js, which prefers it to the render's while the Capture
/// stage is up. The shape is the same `{ pre, inputs, out }` the render's is,
/// so the bar draws one the way it draws the other.
///
/// **Every `-i` here is exact and the `-filter_complex` is exact too**, which
/// is the difference between this bar and the render's: a render's composition
/// is *equivalent* because the compositor stacks RGBA rather than building a
/// graph, and a recording has no compositor — the string in the field is handed
/// to `avfilter_graph_parse2` and nothing rewrites it on the way.
export function commandParts() {
    const all = captureInputs().filter((i) => i.format && i.path);
    if (!all.length) return null;

    const inputs = [];
    for (const input of all) {
        inputs.push('-f', shellArg(input.format));
        // Everything the input carries that goes in front of the `-i`, and not
        // only the demuxer bag: a `-hwaccel` or a `-probesize` set on the
        // Sources stage is part of this `-i` now, and a bar that printed the
        // device without them would be printing a different open from the one
        // the recording performs.
        for (const bag of [input.options, input.decoderOptions || {}])
            for (const k of Object.keys(bag))
                if (bag[k] !== '' && bag[k] !== undefined)
                    inputs.push(`-${k}`, shellArg(bag[k]));
        if (input.hwaccel) inputs.push('-hwaccel', shellArg(input.hwaccel));
        if (input.hwaccelDevice) inputs.push('-hwaccel_device', shellArg(input.hwaccelDevice));
        if (input.hwaccelOutputFormat)
            inputs.push('-hwaccel_output_format', shellArg(input.hwaccelOutputFormat));
        // `-t` in front of the `-i`, where it belongs: after it, it would limit
        // the *output* — nearly the same file and a different instruction,
        // which is exactly the kind of thing this bar exists to stop somebody
        // guessing at.
        if (input.to) inputs.push('-t', String(input.to));
        inputs.push('-i', shellArg(input.path));
    }

    const enc = effectiveVideo();
    const out = [];
    // The same call `startRecording` makes, so the bar cannot print a graph the
    // recording would not run. A refusal prints nothing rather than a chain
    // that does not parse: the Record button is disabled and the reason is on
    // the stage, and a command bar repeating it in ffmpeg's vocabulary would be
    // offering a line to copy that fails the same way.
    const graph = graphOf();
    if (graph && graph.ok) {
        out.push('-filter_complex', shellArg(graph.filterGraph));
        // What the writer maps. A pad labelled `[vout]`/`[aout]` is the one the
        // muxer takes, which is `resolvePads`' rule stated in the vocabulary of
        // the command line — and a graph that labels neither leaves its single
        // pad as the composite, which `-map` does not need to say.
        for (const label of [graph.video, graph.audio])
            if (label) out.push('-map', `[${label}]`);
    }
    // Everything a file is encoded with, which is the same for all of them: a
    // second file is another muxer and another set of pads, not another set of
    // encode settings — see `capture.also`.
    const encoded = () => {
        const bits = [];
        if (capture.videoCodec) bits.push('-c:v', capture.videoCodec);
        if (capture.audioCodec) bits.push('-c:a', capture.audioCodec);
        if (enc && enc.crf && capture.quality) bits.push('-crf', String(capture.quality));
        if (enc && enc.preset) bits.push('-preset', 'veryfast');
        return bits;
    };
    out.push(...encoded());
    if (capture.format) out.push('-f', capture.format);
    out.push(shellArg(capture.path || 'capture.mkv'));

    // **Several files is several outputs on one command line**, which is what
    // ffmpeg has always been able to do and this application could not say
    // until now. Each carries its own `-map` because the first output's is the
    // graph's default and the rest have to name the pad they are of — which is
    // exactly what the spec sends, so the bar and the recording cannot
    // disagree about which end goes where.
    const files = graph && graph.ok && graph.files ? graph.files : [];
    alsoFiles().forEach((f, i) => {
        const pads = files[i + 1];
        if (pads) for (const label of [pads.video, pads.audio])
            if (label) out.push('-map', `[${label}]`);
        out.push(...encoded());
        if (f.format) out.push('-f', f.format);
        out.push(shellArg(f.path));
    });

    return { pre: ['ffmpeg'], inputs, out };
}
