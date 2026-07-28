// Capture: the devices a recording reads, what they can see, and the file they
// become.
//
// **Why this is a stage of its own rather than a control on Sources.** A device
// *is* an input — `-f gdigrab -i desktop` is an `-i` with a demuxer and an
// option bag, and the model treats it as one — so the tempting place for it is
// the Sources stage beside the file picker. It is the wrong place, and the
// reason is not layout: an input on that stage is something the render about to
// happen will *read*, and a device cannot be. It never ends, so nothing can be
// cut from it and it cannot go on a timeline; and what you do with a device is
// not configure it and move on, it is watch it and then press record. That is a
// moment, not a setting, and it wants a screen.
//
// **Why it is first on the spine.** The spine is the pipeline, and every other
// card on it is a question about the file that comes *out*. Capture is the one
// question about the file that goes *in*: it is where an input comes from when
// there is not one yet. The arrow from Capture to Sources is real — what a
// recording writes is opened as an input, and `Add to the timeline` is that
// arrow being followed — it is simply crossed at a different time from the
// others. When nothing is being recorded the card says so, which is a statement
// about this machine rather than a claim about the render.
//
// **A recording reads a list of inputs, and one device is that list with one in
// it.** There is no singular case in this file and none in the engine either:
// `capture.inputs` is always an array, `record.start` is always given `sources`,
// and `CaptureSettings::sources` treats an empty list as `{source}` so that the
// one spelling and the many are the same call. Writing the single device as a
// special case is how a stage comes to have two code paths that disagree about
// what `-t` means.
//
// **A card per input, each with its own picture, rather than one picture and a
// selector.** The whole argument for this stage is that you watch a device
// before you commit to recording it, and that argument does not weaken at two
// devices — it is the only moment you can see that the camera is pointed the
// right way *and* that the screen grab has the right monitor in it. A selector
// would show one of them and imply the other was fine. The cost is real and is
// paid deliberately: N `<video>` elements, N preview registrations, and two
// cameras held open at once before a recording that will want them both.
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
// **The graph is a field, and with several inputs it is not optional.** A
// recording has been able to run a filter graph since the engine grew one, for
// one input as much as for several — `[0:v]crop=…[vout]` records one monitor
// out of a wide screen grab — and nothing here offered it. Now it is a field,
// and it is the same string `-filter_complex` takes. Several inputs *require*
// one, because two pictures and nothing saying how they combine is not a
// composition anything could guess at, and the engine refuses rather than
// picking one.
//
// The preset buttons write a real graph into that field and then get out of the
// way. They are not modes and there is no layout the field cannot express: what
// a button does is type for you, the string it typed is the string that runs,
// and editing it afterwards keeps the edit. They are built from what the
// devices actually *are* — an input with no sound contributes no `[n:a]` — for
// the same reason nothing else here is a hardcoded list.
//
// **The preview is the real decode path.** A device registered as an input
// (`bro.ffmpeg.inputs.define`) is played through an ordinary `<video>`, which
// is the same backend, the same decoder and the same renderer everything else
// in this application uses. There is no preview-only path, for the reason the
// node previews have none: a preview that agreed with the recording most of the
// time would be worse than none, because it would be trusted. What it does
// *not* show is the graph — the picture on a card is that device, not the
// composition, for the same structural reason the viewer cannot show a filter.
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

let refs = {};
let hooks = {};

// ── what is being captured ─────────────────────────────────────────────────
//
// One object, because it is a list of `-i`s plus where they go. Held here
// rather than in project.js on purpose: a capture is not part of the edit and
// does not belong in a project file — the recording it produces does.

/// One input. Exactly the four things that belong to an `-i` and nothing about
/// the file coming out, which is why adding a device cannot disturb the
/// encoder settings and removing one cannot take the path with it.
function newInput() {
    return {
        device: '',         // the libavdevice demuxer: `-f gdigrab`
        source: '',         // what goes after the `-i`
        options: {},        // the demuxer's own options
        seconds: 0,         // `-t`; 0 is until stopped
    };
}

export const capture = {
    inputs: [newInput()],   // never empty: a recording of nothing is not a state
    graph: '',              // `-filter_complex`, and required once there are two
    path: '',               // where the recording goes
    format: 'matroska',     // the muxer, by name
    videoCodec: '',         // empty asks the muxer for its default
    audioCodec: '',
    quality: 23,
};

/// Which card the left column and the option column are editing.
///
/// Not a selection in the timeline's sense — every card is live and every card
/// is recorded. It is only the answer to "when you click a device, which input
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

/// The input the left column and the option column are pointed at.
export function focused() {
    return capture.inputs[focus] || capture.inputs[0];
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

/// One input as an `-i`, in the shape `probe`, `inputs.define` and
/// `record.start` all take. One function, so what is previewed and what is
/// recorded cannot come to be different inputs.
export function asInput(inp) {
    const i = inp || focused();
    return {
        path: i.source,
        format: i.device,
        options: Object.assign({}, i.options),
        t: i.seconds || 0,
    };
}

/// Every input, in the order that numbers them for the graph: the first is
/// `[0:v]`/`[0:a]`, the second `[1:…]`. That order is the array's order and
/// nothing else, which is why adding a device appends rather than sorting.
export function asInputs() {
    return capture.inputs.map((i) => asInput(i));
}

/// Is this recording ready to start? Every input needs a device and something
/// after the `-i`, and several of them need a graph — the last is the engine's
/// rule, checked here so the button is honest rather than so the refusal is
/// avoided. `record.start` still refuses; this stops the press.
export function ready() {
    if (!capture.inputs.length) return false;
    for (const i of capture.inputs) if (!i.device || !i.source) return false;
    if (capture.inputs.length > 1 && !capture.graph.trim()) return false;
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

// ── the cards ──────────────────────────────────────────────────────────────
//
// One card per input, built once and kept. **Not rebuilt on every draw**, for
// the reason the stage views are never unmounted: the `<video>` in a card *is*
// the decoder, and `put()`ing over it would tear a device down and open it
// again every time a checkbox moved. So the roots are reconciled against
// `capture.inputs` — create what is missing, remove what is extra — and only
// the rows inside them are redrawn.

const cards = [];   // parallel to capture.inputs

/// Make the card list match the input list, then draw each card.
function syncCards() {
    if (!refs.cards) return;

    while (cards.length > capture.inputs.length) dropCard(cards.length - 1);
    while (cards.length < capture.inputs.length) cards.push(buildCard());

    if (focus >= capture.inputs.length) focus = capture.inputs.length - 1;
    if (focus < 0) focus = 0;

    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (c.root.parentNode !== refs.cards) refs.cards.append(c.root);
        c.root.setAttribute('data-card', String(i));
        c.root.className = 'cap-card' + (i === focus ? ' on' : '');
        drawCardRows(i);
    }
    put(refs.add, () => [el('button', {
        cls: 'tiny', 'data-f': 'capadd', text: '+ another device',
        title: 'A second -i. Several inputs are composited by the filter graph — which is ' +
               'why the graph stops being optional the moment there are two.',
        on: { click: addInput },
    })]);
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
    const card = { root, pic, marquee, rows, title, video: null, error: '', key: '', probe: null };
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
    releasePreview(c, i);
    if (c.root.parentNode) c.root.parentNode.removeChild(c.root);
    cards.splice(i, 1);
}

export function addInput() {
    capture.inputs.push(newInput());
    focus = capture.inputs.length - 1;
    if (hooks.changed) hooks.changed();
    drawCapture();
    syncPreviews();
}

/// Remove one input. Refused at the last one, because a recording of nothing is
/// not a state this stage can be in — the empty case is a device not yet
/// chosen, which is what a blank card already says.
export function removeInput(i) {
    if (capture.inputs.length <= 1) return;
    capture.inputs.splice(i, 1);
    dropCard(i);
    if (focus >= capture.inputs.length) focus = capture.inputs.length - 1;
    if (hooks.changed) hooks.changed();
    drawCapture();
    syncPreviews();
}

function drawCardRows(i) {
    const c = cards[i];
    const inp = capture.inputs[i];

    put(c.title, () => {
        const out = [
            span(`[${i}]`, 'cap-card-n mono'),
            span(inp.device ? `-f ${inp.device}` : 'no device yet',
                 inp.device ? 'mono cap-card-dev' : 'dim cap-card-dev'),
        ];
        if (capture.inputs.length > 1)
            out.push(el('button', {
                cls: 'tiny cap-card-x', 'data-f': 'capremove', 'data-input': String(i),
                text: '×', title: 'Take this input out of the recording',
                on: { click: () => removeInput(i) },
            }));
        return out;
    });

    put(c.rows, () => {
        const source = el('input', {
            cls: 'wide', 'data-f': 'capsource', 'data-input': String(i), type: 'text',
            value: inp.source,
            placeholder: HINTS[inp.device] || 'what this device is asked for after -i',
            on: { change: () => setSource(source.value.trim(), i) },
        });
        const seconds = el('input', {
            cls: 'num', 'data-f': 'capseconds', 'data-input': String(i), type: 'text',
            value: inp.seconds ? String(inp.seconds) : '',
            placeholder: 'until stopped',
            on: { change: () => {
                inp.seconds = Number(seconds.value) || 0;
                redraw();
            } },
        });
        const out = [row('-i', source), row('-t', seconds)];

        // What this input's option bag has in it. The bag is edited in the
        // column on the right, which shows one device at a time — so the card
        // is where you see that the *other* one has a region set on it without
        // having to click over to it and back.
        const keys = Object.keys(inp.options).filter((k) => inp.options[k] !== '');
        if (keys.length)
            out.push(row('', span(
                keys.map((k) => `-${k} ${inp.options[k]}`).join('  '), 'dim mono cap-card-opts')));

        if (c.error) out.push(div('cap-error', c.error));
        else if (!c.video && inp.device) out.push(div('cap-note dim', 'No picture yet.'));
        return out;
    });
}

// ── the previews ───────────────────────────────────────────────────────────

/// One registration per card, under an id of its own.
///
/// `inputs.define` resolves a token to an input, so two cards sharing one id
/// would be two pictures of whichever device was defined last. The id carries
/// the card's index for the same reason the pad labels do: it is the only thing
/// that distinguishes them.
function previewId(i) { return `capture-preview-${i}`; }

/// Point every card's `<video>` at its device, opening and closing only what
/// changed.
///
/// Keyed on everything that changes what is opened, so that typing in the
/// option column re-opens the device and moving the mouse does not. The element
/// is reused rather than rebuilt: `src = next` is a reload, and a preview that
/// blinked every time a checkbox moved would be unwatchable.
function syncPreviews() {
    if (!refs.cards) return;
    for (let i = 0; i < cards.length; i++) syncPreview(i);
    // **The presets are drawn again here, and this order is the whole reason
    // they work.** What a preset can write depends on which inputs have a
    // picture and which have sound, and that is not known until each device has
    // been probed — which happens here, after `drawCapture()` has already been
    // over the panel once. Drawn only from `drawCapture()`, the buttons would
    // be built against last edit's answer and a device just chosen would offer
    // nothing.
    drawGraph();
}

function syncPreview(i) {
    const c = cards[i];
    const inp = capture.inputs[i];
    if (!c || !inp) return;

    const input = asInput(inp);
    const key = JSON.stringify(input);
    if (key === c.key) return;
    c.key = key;
    c.error = '';
    c.probe = null;

    if (!inp.device || !inp.source) { releasePreview(c, i); drawCardRows(i); return; }

    // Probed first, because the failure that matters — a camera name that is
    // not exactly right — arrives here as a sentence and arrives at the
    // `<video>` as a black rectangle. The answer is kept: what the presets can
    // write depends on which inputs have a picture and which have sound, and
    // this is where that is known.
    let probe = null;
    try { probe = bro.ffmpeg.probe(input); } catch (e) {
        c.error = String((e && e.message) || e);
        releasePreview(c, i);
        drawCardRows(i);
        return;
    }
    c.probe = probe;

    if (!probe.video) {
        c.error = probe.audio
            ? 'this device produces sound and no picture — there is nothing to show, ' +
              'but it can still be recorded'
            : 'this device produced neither pictures nor sound';
        releasePreview(c, i);
        drawCardRows(i);
        return;
    }
    // The one refusal that is about the seam rather than about the device. See
    // the note at the top of this file: lavfi's packets are pointers to decoded
    // frames and bro's are bytes, so the crossing loses them.
    if (probe.video.codec === 'wrapped_avframe') {
        c.error = 'the lavfi device hands over decoded frames rather than packets, and ' +
                  'the media interface between this binary and the engine carries bytes ' +
                  '— so it cannot be played here. It records normally.';
        releasePreview(c, i);
        drawCardRows(i);
        return;
    }

    let src = '';
    try { src = bro.ffmpeg.inputs.define(previewId(i), input); } catch (e) {
        c.error = String((e && e.message) || e);
        releasePreview(c, i);
        drawCardRows(i);
        return;
    }

    if (!c.video) {
        c.video = el('video', { cls: 'cap-video', 'data-f': 'preview', 'data-input': String(i) });
        c.pic.append(c.video);
    }
    c.video.setAttribute('src', src);
    try { c.video.play(); } catch (e) { /* it starts on the next frame */ }
    drawCardRows(i);
}

/// Let one card's device go.
///
/// Not optional and not tidy-up: a camera opened by the preview is a camera
/// that cannot be opened by the recording, because a DirectShow device is
/// exclusive. So the previews are torn down before `record.start` and put back
/// afterwards, and leaving this stage releases them too.
function releasePreview(c, i) {
    if (c.video) {
        try { c.video.pause(); } catch (e) { /* already gone */ }
        if (c.video.parentNode) c.video.parentNode.removeChild(c.video);
        c.video = null;
    }
    try { bro.ffmpeg.inputs.forget(previewId(i)); } catch (e) { /* not registered */ }
    c.key = '';
}

export function stopPreviews() {
    for (let i = 0; i < cards.length; i++) releasePreview(cards[i], i);
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
    const live = capture.inputs.filter((i) => i.device);
    if (!live.length) return ['no device', `${devices().length} available`];
    if (live.length > 1)
        return [`${live.length} inputs`,
                capture.graph.trim() ? live.map((i) => i.device).join(' + ')
                                     : 'no graph — they have nowhere to meet'];
    const bits = [live[0].source || 'nothing chosen'];
    if (live[0].seconds) bits.push(`-t ${live[0].seconds}`);
    return [`-f ${live[0].device}`, bits.join(' · ')];
}

// ── recording ──────────────────────────────────────────────────────────────

export function startRecording() {
    if (recording) return;
    if (!ready()) {
        if (hooks.flash)
            hooks.flash(capture.inputs.length > 1 && !capture.graph.trim()
                ? 'Several inputs need a filter graph — it is what says how they combine'
                : 'Choose a device first');
        return;
    }
    if (!capture.path) capture.path = defaultPath();

    // The devices go to the recording, not to the previews. A camera is
    // exclusive on Windows and the second open fails; letting a preview keep
    // one would make every recording fail with a message about the device being
    // in use, which reads as a broken application.
    stopPreviews();

    const enc = effectiveVideo();
    // **`sources` and not `source`, at one input as much as at several.** The
    // engine reads an absent list as `{source}` and a present one as itself, so
    // the singular spelling buys nothing here except a second shape to keep in
    // step. See src/native/ffmpeg_capture.h.
    const spec = Object.assign({
        sources: asInputs(),
        path: capture.path,
        format: capture.format,
    }, capture.graph.trim() ? { filterGraph: capture.graph.trim() } : {},
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
        const out = [head(capture.inputs.length > 1
            ? `Devices · ${all.length} · editing [${focus}]`
            : `Devices · ${all.length}`)];
        if (!all.length)
            return [div('dim pad', 'This build registered no capture devices.')];
        for (const d of all) {
            // A div and not a `<button>`, for the reason `.src-row` on the
            // Sources stage is one: the base button rule is a 26px single-line
            // control and this engine will not grow one past it however the
            // display and the height are written, so the second line lands on
            // whatever is underneath. A row that is a row lays out correctly and
            // takes its own click listener like anything else here.
            out.push(el('div', {
                cls: 'cap-device' + (d.name === focused().device ? ' on' : ''),
                'data-device': d.name,
                on: { click: () => pickDevice(d.name) },
            }, [
                div('cap-device-name mono', d.name),
                div('cap-device-what dim', `${d.longName || ''} · ${d.kinds.join(' · ')}`),
            ]));
        }
        if (focused().device) out.push(...sourceRows());
        return out;
    });
}

function pickDevice(name) {
    const inp = focused();
    if (inp.device === name) return;
    inp.device = name;
    // The options belong to the demuxer that is going away with it. Carrying
    // `draw_mouse` over to a camera would be carrying a key that stops the open
    // — the same reason changing the muxer empties its bag one stage along.
    inp.options = {};
    inp.source = '';
    const list = sourcesOf(name);
    if (list.ok && list.sources.length) {
        const first = list.sources.find((s) => (s.mediaTypes || []).indexOf('video') >= 0) ||
                      list.sources[0];
        inp.source = sourceArg(first);
    } else if (HINTS[name]) {
        inp.source = HINTS[name];
    }
    if (hooks.changed) hooks.changed();
    drawCapture();
    syncPreviews();
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

function sourceRows() {
    const inp = focused();
    const list = sourcesOf(inp.device);
    const out = [head('What it can see')];

    if (!list.ok) {
        // An answer, not a failure. gdigrab takes a rectangle rather than a
        // device name and says so; an empty list here would read as a machine
        // with no cameras in it.
        out.push(div('cap-note dim', list.error ||
            `${inp.device} does not list its sources.`));
        if (HINTS[inp.device])
            out.push(el('button', {
                cls: 'tiny', 'data-f': 'caphint',
                text: `Use ${HINTS[inp.device]}`,
                title: 'A starting point out of ffmpeg’s documentation — libavdevice has no ' +
                       'call that returns it, so it is a hint and not a capability. The field ' +
                       'takes anything.',
                on: { click: () => setSource(HINTS[inp.device], focus) },
            }));
        return out;
    }

    for (const s of list.sources) {
        const arg = sourceArg(s);
        out.push(el('div', {
            cls: 'cap-device' + (arg === inp.source ? ' on' : ''),
            'data-source': s.description || s.name,
            on: { click: () => setSource(arg, focus) },
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
    if (audio.length && inp.source.indexOf('video=') === 0)
        out.push(div('cap-note dim',
            'A camera and a microphone are one -i: video=… and audio=… joined with a colon. ' +
            'Click a sound source to add it. A separate device is a separate input — ' +
            '“+ another device” below.'));

    out.push(el('button', {
        cls: 'tiny', 'data-f': 'caprescan', text: 'Rescan',
        title: 'Ask the device again — this is the one query here that talks to hardware',
        on: { click: () => { sourcesOf(inp.device, true); drawCapture(); } },
    }));
    return out;
}

function setSource(arg, i) {
    const inp = capture.inputs[i] || focused();
    // A sound source clicked while a camera is chosen joins it rather than
    // replacing it: `video=Cam:audio=Mic` is one input and two streams, which
    // is what dshow means by it.
    if (arg.indexOf('audio=') === 0 && inp.source.indexOf('video=') === 0 &&
        inp.source.indexOf(':audio=') < 0)
        inp.source = `${inp.source}:${arg}`;
    else
        inp.source = arg;
    redraw();
}

// ── the graph ──────────────────────────────────────────────────────────────

/// What the recording's filter graph is, and the buttons that write one.
///
/// The field is the truth and the buttons are a keyboard. A preset composes the
/// string out of what the devices actually are — an input with no sound
/// contributes no `[n:a]`, which matters because with several inputs **every**
/// stream has to reach the graph or the engine refuses by name — and then puts
/// it in the field, where it can be edited like anything typed.
function drawGraph() {
    if (!refs.graph) return;
    put(refs.graph, () => {
        const several = capture.inputs.length > 1;
        const field = el('textarea', {
            cls: 'cap-graph-field mono', 'data-f': 'capgraph', rows: '3',
            placeholder: several
                ? 'required: [0:v][1:v]overlay=…[vout]'
                : 'optional: [0:v]crop=…[vout]',
            on: { change: () => { capture.graph = field.value; redraw(); } },
        });
        field.value = capture.graph;

        const out = [head('The graph'), row('-filter_complex', field)];

        const buttons = presetButtons();
        if (buttons.length) out.push(row('', div('cap-presets', buttons)));

        out.push(row('', span(several
            ? 'Several inputs are composited here or not at all — two pictures and nothing ' +
              'saying how they combine is refused rather than guessed at, and every stream ' +
              'of every input has to reach a pad.'
            : 'A recording can run a filter graph like a render can: one screen grab cropped ' +
              'to one monitor is [0:v]crop=…[vout]. Leave it empty and the device is written ' +
              'as it comes.', 'dim')));
        return out;
    });
}

/// What the graph would be for a layout, given the devices that are actually
/// there. Empty when the layout does not apply — two pictures cannot be put
/// side by side when only one input has one.
function presetButtons() {
    const vids = [], auds = [];
    capture.inputs.forEach((inp, i) => {
        const p = cards[i] && cards[i].probe;
        if (!p) return;
        if (p.video) vids.push(i);
        if (p.audio) auds.push(i);
    });
    if (capture.inputs.length < 2) return [];

    const out = [];
    const offer = (id, label, title, text) => {
        if (!text) return;
        out.push(el('button', {
            cls: 'tiny', 'data-f': 'cappreset', 'data-preset': id, text: label, title,
            on: { click: () => { capture.graph = text; redraw(); } },
        }));
    };
    offer('pip', 'Picture in picture',
          'The second picture scaled into the corner of the first, and the sound mixed',
          pictureInPicture(vids, auds));
    offer('side', 'Side by side',
          'Every picture scaled to one height and stacked across, and the sound mixed',
          sideBySide(vids, auds));
    offer('sound', 'Just the sound mixed',
          'Every input is a microphone: one mixed soundtrack and no picture',
          soundOnly(vids, auds));
    return out;
}

/// The sound half of a preset: every input that has any, mixed into `[aout]`.
///
/// One sound input still gets a chain rather than being left alone, because
/// with several inputs a stream the graph does not read is refused — there is
/// no bypass to fall back on once there is more than one device.
function mixChain(auds) {
    if (!auds.length) return '';
    if (auds.length === 1) return `[${auds[0]}:a]anull[aout]`;
    return `${auds.map((i) => `[${i}:a]`).join('')}amix=inputs=${auds.length}:normalize=0[aout]`;
}

function join(chains) { return chains.filter(Boolean).join(';'); }

function pictureInPicture(vids, auds) {
    // Exactly two pictures. With three there is no obvious corner for the third
    // and a button that quietly used two of them would be a button that
    // recorded less than it was asked to.
    if (vids.length !== 2) return '';
    const w = cards[vids[0]] && cards[vids[0]].probe && cards[vids[0]].probe.video
        ? cards[vids[0]].probe.video.width : 0;
    // A quarter of the width it is going over, rounded even because yuv420p has
    // no half pixels. `-2` keeps the aspect and lands on an even height.
    const pip = Math.max(2, Math.round((w ? w / 4 : 480) / 2) * 2);
    return join([
        `[${vids[1]}:v]scale=${pip}:-2[pip]`,
        `[${vids[0]}:v][pip]overlay=W-w-32:H-h-32[vout]`,
        mixChain(auds),
    ]);
}

function sideBySide(vids, auds) {
    if (vids.length < 2) return '';
    // `hstack` wants one height across every input, so they are scaled to it
    // rather than being handed to a filter that would refuse them. The first
    // picture's height is the one that does not change.
    const p = cards[vids[0]] && cards[vids[0]].probe && cards[vids[0]].probe.video;
    const h = p && p.height ? Math.max(2, Math.round(p.height / 2) * 2) : 720;
    return join([
        ...vids.map((i) => `[${i}:v]scale=-2:${h}[s${i}]`),
        `${vids.map((i) => `[s${i}]`).join('')}hstack=inputs=${vids.length}[vout]`,
        mixChain(auds),
    ]);
}

function soundOnly(vids, auds) {
    // Only when there is no picture anywhere. With one, this graph would leave
    // its stream unread and the engine would refuse — correctly, and it is
    // better not to offer the button than to offer one that cannot run.
    if (vids.length || auds.length < 2) return '';
    return mixChain(auds);
}

// ── the file ───────────────────────────────────────────────────────────────

function drawSettings() {
    put(refs.settings, () => {
        if (!capture.inputs.some((i) => i.device))
            return [div('dim pad',
                'Choose a device on the left. A device is an input — `-f gdigrab -i desktop` ' +
                'is an -i with a demuxer and that demuxer’s options, exactly like a file — ' +
                'and what makes it different is that it never ends.')];

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
    if (!takesRegion(inp.device)) return [];
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
                inp.options = next;
                redraw();
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
            if (capture.inputs.length > 1 && !capture.graph.trim())
                out.push(span(
                    'Two inputs and no graph: the graph is what says how they combine, so ' +
                    'there is nowhere for [0:v] and [1:v] to meet.', 'dim'));
            if (lastFile) {
                out.push(span(basename(lastFile), 'mono'));
                out.push(span(bytes(lastBytes), 'dim mono'));
                out.push(el('button', {
                    cls: 'tiny', 'data-f': 'capuse', text: 'Add to the timeline',
                    on: { click: () => { if (hooks.open) hooks.open(lastFile); } },
                }));
            } else if (capture.inputs.some((i) => i.device)) {
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
    for (const i of capture.inputs) {
        if (!i.seconds) continue;
        if (!best || i.seconds < best) best = i.seconds;
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
// rather than over its index: removing an input renumbers every card after it,
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
        if (i < 0 || !takesRegion(capture.inputs[i].device) || !card.video || recording) return;
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
    const inp = capture.inputs[i];
    if (!c || !c.video || !inp) return;
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

    const next = Object.assign({}, inp.options);
    next.offset_x = String(Math.max(0, x));
    next.offset_y = String(Math.max(0, y));
    next.video_size = `${w}x${h}`;
    inp.options = next;
    redraw();
}

// ── the option column ──────────────────────────────────────────────────────

function optionRows() {
    const inp = focused();
    if (!inp.device) return [];
    let all = [];
    try { all = bro.ffmpeg.demuxerOptions(inp.device) || []; } catch (e) { all = []; }
    return optionColumn({
        name: 'capoptsearch',
        title: capture.inputs.length > 1
            ? `[${focus}] ${inp.device} options · ${all.length}`
            : `${inp.device} options · ${all.length}`,
        note: 'What this device takes, out of its own option table and libavformat’s generic ' +
              'one — the same column the encoder’s and the muxer’s options get. An unknown ' +
              'key stops the open rather than being ignored.',
        options: all,
        bag: inp.options,
        hint: 'Anything set here is passed straight to the device.',
        onChange: () => redraw(),
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
    if (!capture.inputs.some((i) => i.device && i.source)) return null;

    const inputs = [];
    for (const inp of capture.inputs) {
        if (!inp.device || !inp.source) continue;
        inputs.push('-f', shellArg(inp.device));
        for (const k of Object.keys(inp.options))
            if (inp.options[k] !== '' && inp.options[k] !== undefined)
                inputs.push(`-${k}`, shellArg(inp.options[k]));
        // `-t` in front of the `-i`, where it belongs: after it, it would limit
        // the *output* — nearly the same file and a different instruction,
        // which is exactly the kind of thing this bar exists to stop somebody
        // guessing at.
        if (inp.seconds) inputs.push('-t', String(inp.seconds));
        inputs.push('-i', shellArg(inp.source));
    }

    const enc = effectiveVideo();
    const out = [];
    const graph = capture.graph.trim();
    if (graph) {
        out.push('-filter_complex', shellArg(graph));
        // What the writer maps. A pad labelled `[vout]`/`[aout]` is the one the
        // muxer takes, which is `resolvePads`' rule stated in the vocabulary of
        // the command line — and a graph that labels neither leaves its single
        // pad as the composite, which `-map` does not need to say.
        for (const label of ['vout', 'aout'])
            if (graph.indexOf(`[${label}]`) >= 0) out.push('-map', `[${label}]`);
    }
    if (capture.videoCodec) out.push('-c:v', capture.videoCodec);
    if (capture.audioCodec) out.push('-c:a', capture.audioCodec);
    if (enc && enc.crf && capture.quality) out.push('-crf', String(capture.quality));
    if (enc && enc.preset) out.push('-preset', 'veryfast');
    if (capture.format) out.push('-f', capture.format);
    out.push(shellArg(capture.path || 'capture.mkv'));

    return { pre: ['ffmpeg'], inputs, out };
}
