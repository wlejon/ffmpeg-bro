// Live preview session (`bro.ffmpeg.live`), audio level meters, monitoring,
// recording lifecycle (`startRecording`/`stopRecording`/`tick`), and region
// drag handling for `ui/capture.js`.

import { div, span, el, put } from './dom.js';
import { clock, bytes, basename } from './format.js';
import { createMeter } from './meter.js';
import { schemeOf } from './export/destination.js';
import { opening } from './inputs.js';

let ctx = null;
export function bindCaptureSessionContext(c) { ctx = c; }

// What was recorded last, so the stage can say where it went and offer to open
// it. Not the job status: the job is over and its slot has been reused by then.
let lastFile = '';
let lastBytes = 0;
let recording = false;
let status = null;

/// Which inputs were opening the last time the frame loop looked, so that the
/// moment one settles is a redraw and no other moment is.
let lastWaits = '';

export function isRecording() { return recording; }
export function recordingStatus() { return status; }
export function lastRecorded() { return { file: lastFile, bytes: lastBytes }; }

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
///
/// **The probe in flight is in it**, which is the one entry that is not a
/// setting. A device's own open is asynchronous now, and a session opened while
/// one is outstanding would be this application asking a DirectShow camera for
/// a second handle on itself — an error rather than a slow path. So "still
/// opening" is part of what the session describes, and settling is what makes
/// `openSession` try.
function sessionKey() {
    const g = ctx.graphOf();
    return ctx.captureInputs().map((i) => `${i.key}${opening(i) ? '@opening' : ''}`).join('|') +
           '::' + (g && g.ok ? g.filterGraph : '');
}

/// Is some device on this stage still being opened by its probe?
///
/// One question, three readers — the session, the Record button and the card —
/// because all three have to hold off for the same moment and three spellings
/// of it is how one of them comes to act a frame early.
export function stillOpening() {
    return ctx.captureInputs().find((i) => opening(i)) || null;
}

/// Open the session this stage needs, or leave the one that already fits.
///
/// Refusals are quiet on purpose. A device that will not open is already said
/// on its own card by the probe, and a graph that will not run is already said
/// under **The graph**; a third sentence here would be the same news in a
/// worse place. What happens instead is that there is no picture, which is
/// what "it did not open" looks like.
export function openSession() {
    const want = sessionKey();
    if (session.id && session.key === want) return;
    closeSession();
    const live = ctx.captureInputs();
    if (!live.length || live.some((i) => !i.path)) return;
    // A device whose probe is still holding it open cannot be opened again —
    // that is what makes this a wait rather than a retry. `sessionKey()` carries
    // the state, so the frame it settles is the frame this runs for real.
    if (stillOpening()) return;

    const g = ctx.graphOf();
    try {
        session.id = bro.ffmpeg.live.open({
            sources: live.map((i) => ctx.asInput(i)),
            filterGraph: g && g.ok ? g.filterGraph : '',
            fps: 30,
        });
        session.key = want;
    } catch (e) {
        session.id = 0;
        session.key = want;   // do not retry every frame on a device that refuses
    }
}

export function closeSession() {
    const refs = ctx.refs();
    if (session.id) { try { bro.ffmpeg.live.close(session.id); } catch (e) { /* gone */ } }
    session = { id: 0, pads: [], key: '' };
    // The meters belong to the session that was running: a bar left standing at
    // -12 while nothing is open is a reading of a device that has been given
    // back. `syncMeters` rebuilds from the next session's pads.
    meterKey = '';
    meters.clear();
    // **And so does the monitoring.** A session closes because the devices are
    // going somewhere else — a recording, another stage — so the sound stops
    // whatever happens; what is decided here is that it does not come back on by
    // itself when the next session opens under the same pad name. Monitoring is a
    // press, and the press was about the session that has just ended.
    listening = '';
    syncMonitor();
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
export function syncPreviews() {
    const refs = ctx.refs();
    if (!refs.cards) return;
    openSession();
    const all = ctx.captureInputs();
    const cards = ctx.cards();
    for (let i = 0; i < cards.length; i++) syncPreview(cards[i], all[i], i);
    syncComposite();
    // **Drawn again here, and this order is the whole reason it is right.**
    // What the panel says about the graph depends on the probes, which
    // `updateInput` has only just refreshed, and on the pads, which the session
    // has only just published.
    ctx.drawGraph();
}

function syncPreview(c, input, i) {
    if (!c || !input) return;
    const pad = padNamed(`in${i}`);
    const key = `${input.key}#${pad ? pad.src : ''}`;
    if (key === c.key) return;
    c.key = key;

    if (!input.path || ctx.pictureRefusal(input) || !pad) {
        releasePreview(c);
        c.key = key;
        ctx.drawCardRows(i);
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
    ctx.drawCardRows(i);
}

/// The composition, playing — or nothing, where the graph does not make one.
///
/// Kept outside the panel that describes the graph because that panel is
/// redrawn on every edit and this element is a reader of a live session: put
/// over, it would tear the session's pad down and open it again on every
/// keystroke in the options column.
function syncComposite() {
    const refs = ctx.refs();
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
// **The meter is not the monitor, and it still is not.** A reading is what you
// can have without deciding anything; hearing it is a decision, and it is the one
// below this — `Listen`. The two are drawn in one row because they are two
// answers about one pad, and they are separately true: the meter is running on
// every sound pad of the session whether or not anything is being played, which
// is what makes it the thing you glance at.
//
// Drawn by `ui/meter.js`, which is the one meter in this application — the
// Compose stage has one too now, of what is leaving the output, and two
// implementations of a decay and a clipping line would come apart. What is left
// here is what belongs to *this* stage: which pads there are, `Listen`, and the
// sentence about feedback.
//
// **A bar per channel of each pad**, which is what asking the sound rather than
// assuming gets you: a stereo microphone with a dead side reads perfectly healthy
// as one number, and that is the one fault this meter exists to catch that nothing
// else on the stage can.

/// One meter per sound pad, by pad name.
const meters = new Map();

/// One meter per sound pad, then written by `tickMeters` and never rebuilt.
///
/// Rebuilt only when the *pads* change — a session reopening, a wire moved on
/// the Graph stage. Redrawing a meter's markup sixty times a second to move a
/// bar would be rebuilding a panel to change a number in it.
function syncMeters() {
    const refs = ctx.refs();
    if (!refs.meters) return;
    const pads = padsNow().filter((p) => p.sound);
    // `listening` is in the key because the panel says which pad is being heard
    // — the pressed button, and the sentence about feedback under it — and both
    // of those are markup rather than a number in a style attribute.
    const key = pads.map((p) => p.name).join('|') + '::' + listening;
    if (key === meterKey) return;
    meterKey = key;
    meters.clear();
    if (!pads.length) { put(refs.meters, () => []); return; }

    for (const p of pads) {
        meters.set(p.name, createMeter({
            // `aout` is what the graph calls its mix and what `-map` names, so it
            // is what the meter is called: a friendlier word here would be a
            // second name for the pad the command bar prints.
            name: p.name,
            title: `${p.name} level (true peak)`,
            // The pad's own controls sit on its head row, which is how `Listen`
            // gets beside a meter without `ui/meter.js` knowing what monitoring is.
            trailing: () => [listenButton(p)],
            // One press clears every latch on the stage, not just this pad's: the
            // question "has anything been too loud" is asked of the take.
            onClear: clearHolds,
        }));
    }
    put(refs.meters, () => [
        div('cap-comp-head dim', 'What the sound is doing'),
        ...pads.map((p) => meters.get(p.name).root),
        ...feedbackNote(),
    ]);
}

let meterKey = '';

// ── monitoring ─────────────────────────────────────────────────────────────
//
// **Hearing it, which the meter deliberately was not.** A sound pad carries its
// blocks to whoever listens now — see `LivePadTap` — so the two questions that
// stood in the way are answered here, and this is where they are answered:
//
// **Whose speakers: the machine's own, chosen nowhere.** There is no output
// device control on this stage, because bro's mixer plays to the system default
// and picking another is a decision nobody has asked to make yet. That is not a
// gap dressed up as a decision — it is the smallest thing that is true, and the
// day somebody wants a second interface it is a control here and nothing else
// changes.
//
// **Feedback: said, never suppressed.** A microphone in the room can hear the
// speakers this plays out of, and the answer to that is a sentence — see
// `feedbackNote`. Ducking the monitor, gating it or muting the input while
// something is recorded would all be this application deciding that two devices
// are in the same room, which it cannot know: a camera on a desk and a monitor
// on headphones is the ordinary case and would be silently ruined by any of the
// three. So the risk is stated with the device named and the choice is left where
// it belongs.
//
// **One pad at a time, and it is off to begin with.** Off, because sound that
// starts by itself is sound somebody did not ask for — on a stage whose whole
// purpose is judging a take, at whatever gain the last session left. One,
// because two pads playing together is a mix of a mix: `in0:a` under `aout` is
// the microphone twice, and neither meter beside them would be a reading of what
// you were hearing. So pressing `Listen` on another pad moves it.

/// Which pad is being monitored, by name. Empty for none, which is where every
/// session starts.
let listening = '';

/// The element that is doing it, or null. One, because there is one monitor.
let monitor = null;

/// Is anything being monitored, and what? For a test, and for the stage's own
/// summary — there is nothing else on screen that says a session is audible.
export function monitoring() { return listening; }

function listenButton(pad) {
    const on = listening === pad.name;
    return el('button', {
        cls: 'tiny cap-m-listen' + (on ? ' on' : ''),
        'data-f': `listen-${pad.name}`,
        text: on ? 'Listening' : 'Listen',
        title: on ? 'Stop monitoring' : `Monitor ${pad.name}`,
        on: { click: () => listenTo(on ? '' : pad.name) },
    });
}

/// Start monitoring `name`, or stop with ''.
///
/// The element is reconciled here rather than on the next frame so that the
/// sound starts on the press: `syncMonitor` is idempotent and the frame loop
/// calls it too, which is what puts the monitor back when a session reopens
/// under it.
function listenTo(name) {
    const hooks = ctx.hooks();
    listening = name || '';
    // The panel first and the element second, which is the order `syncComposite`
    // uses and for the same reason: `put` replaces what is in the panel, so an
    // element appended before it is an element thrown away by it.
    syncMeters();
    syncMonitor();
    if (hooks.changed) hooks.changed();
}

/// Point the monitor at the pad being listened to, or take it away.
///
/// **The element is created and destroyed rather than muted**, because the
/// element *is* the monitoring: a session queues a pad's sound only while
/// something is listening to it, so an element left in place with `volume = 0`
/// would go on copying every block of a microphone into a queue for nobody. See
/// `LivePadTap::listen`.
///
/// It has no box and never will — `display:none` — and that is not a hidden
/// picture: a sound pad has no picture, and bro pumps a media element's audio
/// from the event walk rather than from the draw, so an element nobody can see
/// plays exactly as one in the middle of the stage would.
function syncMonitor() {
    const refs = ctx.refs();
    const pad = listening ? padNamed(listening) : null;
    if (!pad || !pad.src || !pad.sound) {
        // The pad has gone: a session reopened, a wire moved, a device released.
        // The monitoring goes with it rather than silently moving to whatever is
        // published under that name next.
        if (monitor) {
            try { monitor.pause(); } catch (e) { /* already gone */ }
            if (monitor.parentNode) monitor.parentNode.removeChild(monitor);
            monitor = null;
        }
        if (listening && !pad) listening = '';
        return;
    }
    if (!monitor) {
        monitor = el('video', { cls: 'cap-monitor', 'data-f': 'monitor' });
        monitor.style.display = 'none';
    }
    // Put back rather than rebuilt, whenever the panel around it has been
    // redrawn: this element is a reader of a live session, and making a new one
    // would tear the pad's queue down and open another — a click of silence for
    // every rebuild of a panel it happens to live in.
    if (monitor.parentNode !== refs.meters) refs.meters.appendChild(monitor);
    if (monitor.getAttribute('src') !== pad.src) monitor.setAttribute('src', pad.src);
    try { monitor.play(); } catch (e) { /* it starts on the next frame */ }
}

/// What is being recorded that can hear what is being played, as a sentence.
///
/// Empty when nothing is being monitored — there is nothing to warn about — and
/// empty when no device in the session carries sound, which is the screen-grab
/// case and is why this is not simply printed beside the button.
///
/// **It names the devices and stops there.** Whether they can actually hear the
/// speakers depends on the room, on whether anybody is wearing headphones, and
/// on which way a shotgun mic is pointed; none of that is knowable from here, and
/// a warning that pretended to know would be either ignored or wrong. What is
/// knowable is that sound is going out of this machine while a device is being
/// read for sound, and that is exactly what this says.
function feedbackNote() {
    if (!listening) return [];
    const mics = ctx.captureInputs()
        .map((input, i) => ({ input, i }))
        .filter(({ input }) => input.probe && input.probe.audio);
    if (!mics.length) return [];
    const which = mics.map(({ input, i }) => `[${i}:a] ${input.format}`).join(', ');
    return [div('cap-m-note dim',
                `Playing ${listening} out of this machine while ${which} ` +
                'is being read for sound — anything the speakers play, a microphone ' +
                'in the room records. Nothing is ducked or gated: use headphones, or ' +
                'stop listening while you take.')];
}

/// Read every level once and write it to every meter. **Once**, because the read
/// clears what it read — see `liveLevels` — and a second caller would halve this
/// one's window and draw a meter that disagreed with it.
function tickMeters() {
    if (!meters.size || !session.id) return;
    let levels = [];
    try { levels = bro.ffmpeg.live.levels(session.id); } catch (e) { return; }
    const seen = new Map();
    for (const l of levels) seen.set(l.name, l);
    // A pad with nothing in `seen` is written a null, which is not the same as
    // silence: the bars fall from where they were rather than being driven to
    // zero, so a device that has stopped delivering looks like a meter going
    // still. See `ui/meter.js`.
    for (const [name, m] of meters) m.write(seen.get(name) || null);
}

/// Forget every latch on the stage, on all of its pads at once.
///
/// The meter forgets its own when its light is clicked; this is what makes the
/// *other* pads forget theirs at the same time, because "has anything been too
/// loud" is a question about the take rather than about one microphone in it.
function clearHolds() {
    for (const m of meters.values()) m.clear();
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
export function releasePreview(c) {
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
    const refs = ctx.refs();
    for (const c of ctx.cards()) releasePreview(c);
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
    for (const c of ctx.cards()) c.key = '';
    ctx.drawCapture();
    syncPreviews();
}

export function leave() {
    stopPreviews();
    ctx.drawCapture();
}

/// What the stage is doing, for the spine.
export function summary() {
    if (recording) {
        const st = status || {};
        const secs = st.elapsed || 0;
        return ['recording', `${clock(secs)} · ${bytes(st.bytes || 0)}`];
    }
    const live = ctx.captureInputs();
    if (!live.length) return ['no device', `${ctx.devices().length} available`];
    if (live.length > 1) {
        const g = ctx.graphOf();
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
    const capture = ctx.capture;
    const rows = ctx.alsoFiles();
    const enc = ctx.effectiveVideo();
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
    const capture = ctx.capture;
    const hooks = ctx.hooks();
    const cards = ctx.cards();
    if (!ctx.ready()) {
        const g = ctx.graphOf();
        const clash = ctx.clashingPath();
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
    // Only the single-file case has a name to invent: a tee's destinations are
    // typed, and a default one of those would be a file nobody asked for.
    if (!capture.path && capture.format !== 'tee') capture.path = ctx.defaultPath();

    // The devices go to the recording, not to the previews. A camera is
    // exclusive on Windows and the second open fails; letting a preview keep
    // one would make every recording fail with a message about the device being
    // in use, which reads as a broken application.
    stopPreviews();

    const enc = ctx.effectiveVideo();
    const codecs = ctx.effectiveCodecs();
    const g = ctx.graphOf();
    // **`sources` and not `source`, at one input as much as at several.** The
    // engine reads an absent list as `{source}` and a present one as itself, so
    // the singular spelling buys nothing here except a second shape to keep in
    // step. See src/native/ffmpeg_capture.h.
    const spec = Object.assign({
        sources: ctx.asInputs(),
        path: ctx.recordTarget(),
        format: capture.format,
    }, g && g.ok ? { filterGraph: g.filterGraph } : {},
       enc && enc.crf ? { crf: capture.quality } : {},
       // Fast on purpose and only where the encoder has the word: a capture
       // encodes in real time beside whatever is being recorded, and a preset
       // that cannot keep up drops frames off the front of the queue.
       enc && enc.preset ? { preset: 'veryfast' } : {},
       codecs.video ? { videoCodec: codecs.video } : {},
       codecs.audio ? { audioCodec: codecs.audio } : {});

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
    ctx.drawCapture();
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
    const cards = ctx.cards();
    const hooks = ctx.hooks();
    const capture = ctx.capture;
    if (!recording) {
        // **A device's own open is asynchronous now, and this is where the
        // stage notices it finish.** `tickInputs` settles the probe from the
        // frame loop wherever you are standing — it has to, because a card
        // started on this stage goes on opening while you walk to the timeline
        // — and everything here reads the probe it produces: the picture, the
        // graph panel, the Record button. Compared rather than acted on every
        // frame, because opening a session is opening devices and doing that
        // sixty times a second is not a redraw, it is a camera being taken and
        // given back.
        const waits = ctx.captureInputs().filter((i) => opening(i)).map((i) => i.id).join(',');
        if (waits !== lastWaits) { lastWaits = waits; ctx.drawCapture(); syncPreviews(); }
        // The seconds, into one text node each. Same trade the Sources stage
        // makes: a card redrawn to move one number relays out the column.
        if (waits) {
            const all = ctx.captureInputs();
            for (let i = 0; i < cards.length; i++)
                if (cards[i].waitNode && all[i] && opening(all[i]))
                    cards[i].waitNode.textContent = ctx.openingLabel(all[i]);
        }
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
        // And the monitor keeps asking to play, for the reason the cards above
        // do: an element pointed at a pad in the turn the button was pressed is
        // an element whose source is not open yet, and `play()` on one is
        // dropped. Idempotent, so it costs a lookup a frame.
        syncMonitor();
        ctx.fitPreviews();
        return;
    }
    let p = null;
    try { p = bro.ffmpeg.render.poll(); } catch (e) { return; }
    status = p;
    if (p.state === 'running') { ctx.tickRecording(); return; }

    recording = false;
    // What there is to look at afterwards, which for a tee is not what was
    // opened: the argument names several places and the ones that are URLs have
    // gone. The first local destination, for the same reason `openable()` picks
    // it on the render side — not because it matters more but because the other
    // is the same bitstream.
    lastFile = capture.format === 'tee'
        ? ((capture.destinations || []).find((d) => d.path && !schemeOf(d.path)) || {}).path || ''
        : p.path || capture.path;
    lastBytes = p.bytes || 0;
    if (hooks.flash)
        hooks.flash(p.state === 'failed' ? `Recording failed: ${p.error}`
                    : lastFile ? `Recorded ${basename(lastFile)}`
                               : 'Recording finished — every destination was a stream, so ' +
                                 'there is nothing here to open');
    if (hooks.changed) hooks.changed();
    // The devices are free again, so the pictures come back.
    for (const c of cards) c.key = '';
    syncPreviews();
    ctx.drawCapture();
}

// ── region drag ────────────────────────────────────────────────────────────

export function wireRegionDrag(card) {
    let mode = null;
    let activeHandle = null;
    let dragStart = null;
    let origRect = null;

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
        const cards = ctx.cards();
        const i = cards.indexOf(card);
        const input = ctx.captureInputs()[i];
        if (i < 0 || !input || !ctx.takesRegion(input.format) || !card.video || recording) return;

        const handle = e.target && e.target.getAttribute && e.target.getAttribute('data-handle');
        if (handle) {
            mode = 'handle';
            activeHandle = handle;
            dragStart = at(e);
            const o = input.options || {};
            const parts = String(o.video_size || '0x0').split('x');
            origRect = {
                x: Number(o.offset_x) || 0,
                y: Number(o.offset_y) || 0,
                w: Number(parts[0]) || 0,
                h: Number(parts[1]) || 0
            };
            card.dragging = true;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (e.target === card.marquee || card.marquee.contains(e.target)) {
            mode = 'move';
            dragStart = at(e);
            const o = input.options || {};
            const parts = String(o.video_size || '0x0').split('x');
            origRect = {
                x: Number(o.offset_x) || 0,
                y: Number(o.offset_y) || 0,
                w: Number(parts[0]) || 0,
                h: Number(parts[1]) || 0
            };
            card.dragging = true;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        mode = 'draw';
        dragStart = at(e);
        card.dragging = true;
        card.marquee.classList.remove('hidden');
        e.preventDefault();
    });

    card.pic.addEventListener('mousemove', (e) => {
        if (!mode || !dragStart) return;
        const i = ctx.cards().indexOf(card);
        const input = ctx.captureInputs()[i];
        if (!input) return;

        if (mode === 'draw') {
            const a = inCard(dragStart), b = inCard(at(e));
            card.marquee.style.left = `${Math.min(a.x, b.x)}px`;
            card.marquee.style.top = `${Math.min(a.y, b.y)}px`;
            card.marquee.style.width = `${Math.abs(b.x - a.x)}px`;
            card.marquee.style.height = `${Math.abs(b.y - a.y)}px`;
            return;
        }

        const shownW = card.video.clientWidth || 1;
        const shownH = card.video.clientHeight || 1;
        const realW = card.video.videoWidth || shownW;
        const realH = card.video.videoHeight || shownH;

        const cur = at(e);
        const dx = Math.round((cur.x - dragStart.x) * realW / shownW);
        const dy = Math.round((cur.y - dragStart.y) * realH / shownH);

        if (mode === 'move') {
            const newX = Math.max(0, Math.min(realW - origRect.w, origRect.x + dx));
            const newY = Math.max(0, Math.min(realH - origRect.h, origRect.y + dy));
            const next = Object.assign({}, input.options);
            next.offset_x = String(newX);
            next.offset_y = String(newY);
            input.options = next;
            ctx.syncMarquee(card, input);
        } else if (mode === 'handle') {
            let x = origRect.x, y = origRect.y, w = origRect.w, h = origRect.h;
            if (activeHandle.indexOf('e') >= 0) w = Math.max(16, origRect.w + dx);
            if (activeHandle.indexOf('s') >= 0) h = Math.max(16, origRect.h + dy);
            if (activeHandle.indexOf('w') >= 0) {
                const nw = Math.max(16, origRect.w - dx);
                x = origRect.x + (origRect.w - nw);
                w = nw;
            }
            if (activeHandle.indexOf('n') >= 0) {
                const nh = Math.max(16, origRect.h - dy);
                y = origRect.y + (origRect.h - nh);
                h = nh;
            }
            const next = Object.assign({}, input.options);
            next.offset_x = String(Math.max(0, x));
            next.offset_y = String(Math.max(0, y));
            next.video_size = `${w & ~1}x${h & ~1}`;
            input.options = next;
            ctx.syncMarquee(card, input);
        }
    });

    card.pic.addEventListener('mouseup', (e) => {
        if (!mode || !dragStart) return;
        const i = ctx.cards().indexOf(card);
        const input = ctx.captureInputs()[i];

        if (mode === 'draw') {
            const now = at(e);
            const start = dragStart;
            mode = null;
            dragStart = null;
            card.dragging = false;
            card.marquee.classList.add('hidden');
            setRegionFromDrag(start, now, i);
        } else {
            mode = null;
            dragStart = null;
            activeHandle = null;
            origRect = null;
            card.dragging = false;
            if (input) ctx.change(input, { options: input.options });
        }
    });
}

export function setRegionFromDrag(from, to, index) {
    const i = index || 0;
    const c = ctx.cards()[i];
    const input = ctx.captureInputs()[i];
    if (!c || !c.video || !input) return;
    const shownW = c.video.clientWidth || 1;
    const shownH = c.video.clientHeight || 1;
    const realW = c.video.videoWidth || shownW;
    const realH = c.video.videoHeight || shownH;

    from.x = Math.max(0, Math.min(shownW, from.x));
    from.y = Math.max(0, Math.min(shownH, from.y));
    to.x = Math.max(0, Math.min(shownW, to.x));
    to.y = Math.max(0, Math.min(shownH, to.y));

    const x = Math.max(0, Math.round(Math.min(from.x, to.x) * realW / shownW));
    const y = Math.max(0, Math.round(Math.min(from.y, to.y) * realH / shownH));
    const w = Math.max(2, Math.min(realW - x, Math.round(
        Math.abs(to.x - from.x) * realW / shownW)) & ~1);
    const h = Math.max(2, Math.min(realH - y, Math.round(
        Math.abs(to.y - from.y) * realH / shownH)) & ~1);
    if (w < 16 || h < 16) return;

    const next = Object.assign({}, input.options);
    next.offset_x = String(Math.max(0, x));
    next.offset_y = String(Math.max(0, y));
    next.video_size = `${w}x${h}`;
    ctx.change(input, { options: next });
}
