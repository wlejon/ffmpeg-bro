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
// The one device that cannot be previewed is `lavfi`, and it is worth knowing
// why because it is a fact about the seam rather than about the device. lavfi's
// packets are not bytes — the demuxer emits `wrapped_avframe`, which is a
// pointer to a decoded AVFrame — and bro's `MediaPacket` is a byte buffer,
// because bro is codec-agnostic and knows nothing about libav's types. So the
// pointer does not survive the crossing and the decoder answers EPERM. It is
// detected by asking `probe()` what the codec is, not by a list.

import { div, span, el, put, row, head } from './dom.js';
import { clock, bytes, basename, shellArg } from './format.js';
import { optionColumn } from './opttable.js';
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
};

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
    if (capture.videoPad && !pads.v.some((p) => p.id === capture.videoPad))
        capture.videoPad = '';
    if (capture.audioPad && !pads.a.some((p) => p.id === capture.audioPad))
        capture.audioPad = '';
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
    return recordGraph(capture.inputs, overlayState(),
                       { v: capture.videoPad, a: capture.audioPad });
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
    return true;
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
    put(refs.add, () => all.length ? [span(
        'Every activated device is an -i of this recording, numbered above in the order the ' +
        'graph reads them. Click another device on the left to add one; it appears on the ' +
        'Sources stage and in the graph’s source list at the same moment.', 'dim')] : []);
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
        return p.audio
            ? 'this device produces sound and no picture — there is nothing to show, ' +
              'but it can still be recorded'
            : 'this device produced neither pictures nor sound';
    // The one refusal that is about the seam rather than about the device. See
    // the note at the top of this file: lavfi's packets are pointers to decoded
    // frames and bro's are bytes, so the crossing loses them.
    if (p.video.codec === 'wrapped_avframe')
        return 'the lavfi device hands over decoded frames rather than packets, and the ' +
               'media interface between this binary and the engine carries bytes — so it ' +
               'cannot be played here. It records normally.';
    return '';
}

function drawCardRows(i) {
    const c = cards[i];
    const input = captureInputs()[i];
    if (!c || !input) return;
    const several = capture.inputs.length > 1;

    put(c.title, () => {
        const out = [
            span(`[${i}]`, 'cap-card-n mono'),
            span(`-f ${input.format}`, 'mono cap-card-dev'),
        ];
        out.push(el('button', {
            cls: 'tiny cap-card-x', 'data-f': 'capremove', 'data-input': String(i),
            text: '×', title: 'Release this device — it leaves the recording and the input list',
            on: { click: () => release(i) },
        }));
        return out;
    });

    put(c.rows, () => {
        const source = el('input', {
            cls: 'wide', 'data-f': 'capsource', 'data-input': String(i), type: 'text',
            value: input.path,
            placeholder: HINTS[input.format] || 'what this device is asked for after -i',
            on: { change: () => change(input, { path: source.value.trim() }) },
        });
        // `-t` is the input's own window, which `ui/inputs.js` carries as an end
        // time: with no `-ss` in front of it those are the same number, and the
        // native reader takes either. Holding both here would be holding two
        // fields that can disagree.
        const seconds = el('input', {
            cls: 'num', 'data-f': 'capseconds', 'data-input': String(i), type: 'text',
            value: input.to ? String(input.to) : '',
            placeholder: 'until stopped',
            on: { change: () => change(input, { to: Number(seconds.value) || 0 }) },
        });
        const out = [row('-i', source), row('-t', seconds)];

        // What this input's option bag has in it. The bag is edited in the
        // column on the right, which shows one device at a time — so the card
        // is where you see that the *other* one has a region set on it without
        // having to click over to it and back.
        const keys = Object.keys(input.options).filter((k) => input.options[k] !== '');
        if (keys.length)
            out.push(row('', span(
                keys.map((k) => `-${k} ${input.options[k]}`).join('  '), 'dim mono cap-card-opts')));

        const why = pictureRefusal(input);
        if (why) out.push(div('cap-error', why));
        else if (!c.video) out.push(div('cap-note dim', 'No picture yet.'));
        if (several && !why)
            out.push(row('', span(
                `reaches the graph as [${i}:v]` +
                (input.probe && input.probe.audio ? ` and [${i}:a]` : ''), 'dim mono')));
        return out;
    });
}

// ── the previews ───────────────────────────────────────────────────────────

/// Point every card's `<video>` at its device, opening and closing only what
/// changed.
///
/// **There is no registration here any more.** `ui/inputs.js` defines every
/// input under its own id and hands back `input.src`, so a card plays the same
/// token the Sources stage and the viewer would — one registration per `-i`
/// rather than one per place it is shown. Keyed on `input.key`, which is that
/// module's own answer to "would this open differently", so typing in the
/// option column re-opens the device and moving the mouse does not.
function syncPreviews() {
    if (!refs.cards) return;
    const all = captureInputs();
    for (let i = 0; i < cards.length; i++) syncPreview(cards[i], all[i], i);
    // **The presets are drawn again here, and this order is the whole reason
    // they work.** What a preset can write depends on which inputs have a
    // picture and which have sound, and that is `probe()`'s answer — which
    // `updateInput` has only just refreshed. Drawn only from `drawCapture()`,
    // the buttons would be built against last edit's answer.
    drawGraph();
}

function syncPreview(c, input, i) {
    if (!c || !input) return;
    if (input.key === c.key) return;
    c.key = input.key;

    if (!input.path || pictureRefusal(input) || !input.src) {
        releasePreview(c);
        c.key = input.key;
        drawCardRows(i);
        return;
    }

    if (!c.video) {
        c.video = el('video', { cls: 'cap-video', 'data-f': 'preview', 'data-input': String(i) });
        c.pic.append(c.video);
    }
    // Reused rather than rebuilt: `src = next` is a reload, and a preview that
    // blinked every time a checkbox moved would be unwatchable.
    c.video.setAttribute('src', input.src);
    try { c.video.play(); } catch (e) { /* it starts on the next frame */ }
    drawCardRows(i);
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

export function stopPreviews() {
    for (const c of cards) releasePreview(c);
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
    const bits = [live[0].path || 'nothing chosen'];
    if (live[0].to) bits.push(`-t ${live[0].to}`);
    return [`-f ${live[0].format}`, bits.join(' · ')];
}

// ── recording ──────────────────────────────────────────────────────────────

export function startRecording() {
    if (recording) return;
    if (!ready()) {
        const g = graphOf();
        if (hooks.flash)
            hooks.flash(g && !g.ok ? `The graph will not run: ${g.reason}`
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

function drawDevices() {
    put(refs.list, () => {
        const all = devices();
        const active = captureInputs();
        const out = [head(active.length > 1
            ? `Devices · ${all.length} · editing [${focus}]`
            : `Devices · ${all.length}`)];
        if (!all.length)
            return [div('dim pad', 'This build registered no capture devices.')];
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
                title: 'Activate this device — it becomes an -i of this recording and an ' +
                       'input the rest of the application can read',
                on: { click: () => activate(d.name) },
            }, [
                div('cap-device-name mono', d.name +
                    (using > 1 ? ` · ${using} activated` : using ? ' · activated' : '')),
                div('cap-device-what dim', `${d.longName || ''} · ${d.kinds.join(' · ')}`),
            ]));
        }
        const inp = focused();
        if (inp) out.push(...sourceRows(inp));
        else out.push(div('cap-note dim',
            'Click a device to activate it. Activating is what adds the -i — it appears here ' +
            'as a card, on the Sources stage as an input, and in the graph’s source list.'));
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
    const out = [head('What it can see')];

    if (!list.ok) {
        // An answer, not a failure. gdigrab takes a rectangle rather than a
        // device name and says so; an empty list here would read as a machine
        // with no cameras in it.
        out.push(div('cap-note dim', list.error ||
            `${inp.format} does not list its sources.`));
        if (HINTS[inp.format])
            out.push(el('button', {
                cls: 'tiny', 'data-f': 'caphint',
                text: `Use ${HINTS[inp.format]}`,
                title: 'A starting point out of ffmpeg’s documentation — libavdevice has no ' +
                       'call that returns it, so it is a hint and not a capability. The field ' +
                       'takes anything.',
                on: { click: () => setSource(HINTS[inp.format], inp) },
            }));
        return out;
    }

    for (const s of list.sources) {
        const arg = sourceArg(s);
        out.push(el('div', {
            cls: 'cap-device' + (arg === inp.path ? ' on' : ''),
            'data-source': s.description || s.name,
            on: { click: () => setSource(arg, inp) },
        }, [
            div('cap-device-name', s.description || s.name),
            div('cap-device-what dim mono', (s.mediaTypes || []).join(' · ') || 'unknown'),
        ]));
    }
    if (!list.sources.length)
        out.push(div('cap-note dim', 'Nothing plugged in that this device can see.'));

    // Two of them at once is one `-i`, which is what a camera and a microphone
    // recorded together actually is — one demuxer, one seek, one file. That is
    // a different thing from two *devices*, which is two `-i`s and a card each.
    const audio = list.sources.filter((s) => (s.mediaTypes || []).indexOf('audio') >= 0);
    if (audio.length && inp.path.indexOf('video=') === 0)
        out.push(div('cap-note dim',
            'A camera and a microphone are one -i: video=… and audio=… joined with a colon. ' +
            'Click a sound source to add it. A separate device is a separate input — click ' +
            'it above.'));

    out.push(el('button', {
        cls: 'tiny', 'data-f': 'caprescan', text: 'Rescan',
        title: 'Ask the device again — this is the one query here that talks to hardware',
        on: { click: () => { sourcesOf(inp.format, true); drawCapture(); } },
    }));
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
function drawGraph() {
    if (!refs.graph) return;
    put(refs.graph, () => {
        if (!capture.inputs.length) return [];
        const g = graphOf();
        const out = [head('The graph')];

        if (!g) {
            out.push(row('', span(capture.inputs.length > 1
                ? 'Nothing in the graph reads these devices, and with several of them that ' +
                  'is not a recording: two pictures and nothing saying how they combine is ' +
                  'refused rather than guessed at. Open the Graph stage — every activated ' +
                  'device is in its source list — place them, and wire them to video out.'
                : 'Nothing in the graph reads this device, so it is written as it comes. ' +
                  'To crop a screen grab to one monitor, or to put a camera in the corner ' +
                  'of it, place it on the Graph stage: it is in the source list there like ' +
                  'any other -i.', 'dim')));
            // No picker here even where the graph has ends of its own: nothing
            // it holds reads these devices, so every one of them would be a
            // choice that leads straight to a refusal.
            return out;
        }
        const pads = padRows();
        if (!g.ok) {
            out.push(row('', span(`This will not run: ${g.reason}`, 'warn')));
            out.push(row('', span(
                'The graph is edited on the Graph stage, which draws the same problem ' +
                'against the node it is about.', 'dim')));
            out.push(...pads);
            return out;
        }

        // One row per chain, because that is how a person reads a filtergraph —
        // the semicolons are where it breaks and joining them into one line is
        // what makes a five-chain graph unreadable.
        for (const chain of g.filterGraph.split(';'))
            out.push(row('', span(chain, 'mono cap-chain')));
        out.push(row('', span(
            `Built on the Graph stage from ${capture.inputs.length} ` +
            `input${capture.inputs.length === 1 ? '' : 's'}, and mapped as ` +
            [g.video && `[${g.video}]`, g.audio && `[${g.audio}]`].filter(Boolean).join(' + ') +
            '.', 'dim')));
        out.push(...pads);
        return out;
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
    rows.push(row('', span(
        'This graph has outputs of its own. A recording writes one end of it, and video ' +
        'out is where a render of the timeline ends as well — give the cameras an output ' +
        'to themselves and the two stop competing for it.', 'dim')));
    return rows;
}

// ── the file ───────────────────────────────────────────────────────────────

function drawSettings() {
    put(refs.settings, () => {
        if (!capture.inputs.length)
            return [div('dim pad',
                'Click a device on the left to activate it. A device is an input — ' +
                '`-f gdigrab -i desktop` is an -i with a demuxer and that demuxer’s options, ' +
                'exactly like a file — and what makes it different is that it never ends. ' +
                'Activating one puts it in the same list every file is in.')];

        const path = el('input', {
            cls: 'wide', 'data-f': 'cappath', type: 'text', value: capture.path,
            on: { change: () => { capture.path = path.value.trim(); redraw(); } },
        });

        const rows = [];
        rows.push(...regionRows());

        if (capture.inputs.length > 1)
            rows.push(head('The inputs'),
                      row('', span(
                          `${capture.inputs.length} of them, numbered above in the order the ` +
                          'graph reads them. -t belongs to an input rather than to the ' +
                          'recording, and the shortest of them is when the session ends — an ' +
                          'input that has run out has nothing further to offer the graph.',
                          'dim')));

        rows.push(head('The file'));
        rows.push(row('Path', path));
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
        if (enc && enc.crf) rows.push(row('Quality', qualityField()));
        else rows.push(row('Quality', span(
            enc ? `${enc.label || enc.id} has no CRF — it is written at its own quality`
                : 'the muxer’s default encoder decides', 'dim')));
        rows.push(row('', span(
            'A recording is its own pipeline: its devices, its graph, straight into the ' +
            'encoder. The Encode stage describes the render of the timeline, which is a ' +
            'different file, so the settings are not shared.', 'dim')));
        return rows;
    });
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
        rows.push(row('Protocol', span(
            linked ? `${scheme} · linked in` : `${scheme} · not in this build`,
            linked ? 'mono' : 'mono src-missing')));
        rows.push(row('', span(
            'A recording pushed through a protocol has no size and no percentage, for the ' +
            'same reason it has none without a -t: there is no file to measure. What it ' +
            'reports is what it has sent.', 'dim')));
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
        rows.push(row('', span(
            `${n} destination${n === 1 ? '' : 's'} — recording and streaming the same ` +
            'capture is one encode through tee, written [f=matroska]take1.mkv|' +
            '[f=flv]rtmp://…  The Write stage has an editor for the argument; here it is ' +
            'typed, because a second copy of the escaping would be a second answer to it.',
            'dim')));
    }
    return rows;
}

/// The region, when the focused input's demuxer has one.
///
/// **Picked rather than typed**, by dragging on that card's live picture —
/// which is the only way it could be picked in this engine, and it turns out to
/// be the right way anyway: the thing being framed is on the screen in front of
/// you. The numbers are shown as well as set, because `offset_x` is what the
/// command bar prints and a rectangle nobody can read off is a rectangle nobody
/// can reproduce.
function regionRows() {
    const inp = focused();
    if (!inp || !takesRegion(inp.format)) return [];
    const o = inp.options;
    const set = o.video_size || o.offset_x || o.offset_y;
    return [
        head(capture.inputs.length > 1 ? `Region · input [${focus}]` : 'Region'),
        row('Now', span(set
            ? `${o.video_size || 'the whole screen'} at ${o.offset_x || 0},${o.offset_y || 0}`
            : 'the whole screen', 'mono')),
        row('', span(
            'Drag a box on that input’s picture to capture part of the screen. It sets ' +
            '-offset_x, -offset_y and -video_size, which are this demuxer’s own options and ' +
            'are in the column on the right beside everything else it takes.', 'dim')),
        set ? row('', el('button', {
            cls: 'tiny', 'data-f': 'capwhole', text: 'The whole screen',
            on: { click: () => {
                const next = Object.assign({}, inp.options);
                delete next.video_size;
                delete next.offset_x;
                delete next.offset_y;
                change(inp, { options: next });
            } },
        })) : null,
    ].filter(Boolean);
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

function qualityField() {
    const field = el('input', {
        cls: 'num', 'data-f': 'capquality', type: 'text', value: String(capture.quality),
        on: { change: () => { capture.quality = Number(field.value) || 23; redraw(); } },
    });
    return field;
}

// ── the record bar ─────────────────────────────────────────────────────────

export function drawRecording() {
    if (!refs.bar) return;
    put(refs.bar, () => {
        const out = [];
        if (recording) {
            const st = status || {};
            out.push(el('button', {
                cls: 'primary', 'data-f': 'capstop', text: 'Stop',
                on: { click: stopRecording },
            }));
            // **No percentage.** Elapsed, frames and size are facts; a fraction
            // of a total nobody knows is not one. With a `-t` on the device the
            // job does have a total and says so, and then the bar means
            // something — which is why this reads `openEnded` rather than
            // assuming.
            out.push(span(clock(st.elapsed || 0), 'cap-elapsed mono'));
            out.push(span(`${st.frames || 0} frames`, 'dim mono'));
            out.push(span(bytes(st.bytes || 0), 'dim mono'));
            out.push(span(st.openEnded
                ? 'recording — there is no end until you stop it, so there is no percentage'
                : `${Math.round((st.progress || 0) * 100)}% of ${clock(shortest())}`,
                'dim'));
        } else {
            out.push(el('button', {
                cls: 'primary', 'data-f': 'caprecord', text: 'Record',
                disabled: !ready(),
                on: { click: startRecording },
            }));
            const g = graphOf();
            if (g && !g.ok)
                out.push(span(`The graph will not run: ${g.reason}`, 'dim'));
            else if (capture.inputs.length > 1 && !g)
                out.push(span(
                    'Two inputs and no graph: the graph is what says how they combine, so ' +
                    'there is nowhere for [0:v] and [1:v] to meet. They are both in the ' +
                    'Graph stage’s source list.', 'dim'));
            if (lastFile) {
                out.push(span(basename(lastFile), 'mono'));
                out.push(span(bytes(lastBytes), 'dim mono'));
                out.push(el('button', {
                    cls: 'tiny', 'data-f': 'capuse', text: 'Add to the timeline',
                    on: { click: () => { if (hooks.open) hooks.open(lastFile); } },
                }));
            } else if (capture.inputs.length) {
                out.push(span('Nothing recorded yet.', 'dim'));
            }
        }
        return out;
    });

    if (refs.note) {
        put(refs.note, () => {
            if (recording)
                return [div('cap-note dim',
                    'The devices are going to the recording rather than to a preview — a ' +
                    'camera is exclusive, and a picture of one here would be the recording ' +
                    'failing.')];
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
        note: 'What this device takes, out of its own option table and libavformat’s generic ' +
              'one — the same column the encoder’s and the muxer’s options get. An unknown ' +
              'key stops the open rather than being ignored.',
        options: all,
        bag: inp.options,
        hint: 'Anything set here is passed straight to the device.',
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
    if (capture.videoCodec) out.push('-c:v', capture.videoCodec);
    if (capture.audioCodec) out.push('-c:a', capture.audioCodec);
    if (enc && enc.crf && capture.quality) out.push('-crf', String(capture.quality));
    if (enc && enc.preset) out.push('-preset', 'veryfast');
    if (capture.format) out.push('-f', capture.format);
    out.push(shellArg(capture.path || 'capture.mkv'));

    return { pre: ['ffmpeg'], inputs, out };
}
