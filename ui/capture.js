// Capture: a device, what it can see, and the recording it becomes.
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
// **A device's settings are its demuxer's options.** `video_size`, `framerate`,
// `draw_mouse`, `offset_x`, `rtbufsize` — every one of them comes out of
// `bro.ffmpeg.demuxerOptions(name)` and goes into the same bag `-probesize`
// travels in, drawn by the same `ui/opttable.js` column the encoder's, the
// muxer's and the file demuxer's use. There is no list of device settings
// written down here, and there could not be: this build has five devices and
// another platform's has different ones.
//
// **The preview is the real decode path.** A device registered as an input
// (`bro.ffmpeg.inputs.define`) is played through an ordinary `<video>`, which
// is the same backend, the same decoder and the same renderer everything else
// in this application uses. There is no preview-only path, for the reason the
// node previews have none: a preview that agreed with the recording most of the
// time would be worse than none, because it would be trusted.
//
// The one device that cannot be previewed is `lavfi`, and it is worth knowing
// why because it is a fact about the seam rather than about the device. lavfi's
// packets are not bytes — the demuxer emits `wrapped_avframe`, which is a
// pointer to a decoded AVFrame — and bro's `MediaPacket` is a byte buffer,
// because bro is codec-agnostic and knows nothing about libav's types. So the
// pointer does not survive the crossing and the decoder answers EPERM. It is
// detected by asking `probe()` what the codec is, not by a list.

import { div, span, el, put, row, head, show, segmented } from './dom.js';
import { clock, bytes, basename } from './format.js';
import { optionColumn } from './opttable.js';

let refs = {};
let hooks = {};

// ── what is being captured ─────────────────────────────────────────────────
//
// One object, because it is one `-i` plus where it goes. Held here rather than
// in project.js on purpose: a capture is not part of the edit and does not
// belong in a project file — the recording it produces does.

export const capture = {
    device: '',             // the libavdevice demuxer: `-f gdigrab`
    source: '',             // what goes after the `-i`
    options: {},            // the demuxer's own options
    seconds: 0,             // `-t`; 0 is until stopped
    path: '',               // where the recording goes
    format: 'matroska',     // the muxer, by name
    videoCodec: '',         // empty asks the muxer for its default
    audioCodec: '',
    quality: 23,
};

// The live preview: an input registered under a fixed id, and the `<video>`
// playing it. One id, because there is one preview — re-registering replaces
// what the token resolves to, which is exactly what changing a setting should
// do to a picture of it.
const PREVIEW_ID = 'capture-preview';
let previewVideo = null;
let previewError = '';
let previewKey = '';

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

/// The device as an `-i`, in the shape `probe`, `inputs.define` and
/// `record.start` all take. One function, so what is previewed and what is
/// recorded cannot come to be different inputs.
export function asInput() {
    return {
        path: capture.source,
        format: capture.device,
        options: Object.assign({}, capture.options),
        t: capture.seconds || 0,
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

// ── the preview ────────────────────────────────────────────────────────────

/// Register the device and point the `<video>` at it.
///
/// Keyed on everything that changes what is opened, so that typing in the
/// option column re-opens the device and moving the mouse does not. The
/// element is reused rather than rebuilt: `src = next` is a reload, and a
/// preview that blinked every time a checkbox moved would be unwatchable.
function syncPreview() {
    if (!refs.preview) return;
    const input = asInput();
    const key = JSON.stringify(input);
    if (key === previewKey) return;
    previewKey = key;
    previewError = '';

    if (!capture.device || !capture.source) {
        stopPreview();
        return;
    }

    // Probed first, because the failure that matters — a camera name that is
    // not exactly right — arrives here as a sentence and arrives at the
    // `<video>` as a black rectangle.
    let probe = null;
    try { probe = bro.ffmpeg.probe(input); } catch (e) {
        previewError = String((e && e.message) || e);
        stopPreview();
        drawCapture();
        return;
    }

    if (!probe.video) {
        previewError = probe.audio
            ? 'this device produces sound and no picture — there is nothing to show, ' +
              'but it can still be recorded'
            : 'this device produced neither pictures nor sound';
        stopPreview();
        drawCapture();
        return;
    }
    // The one refusal that is about the seam rather than about the device. See
    // the note at the top of this file: lavfi's packets are pointers to decoded
    // frames and bro's are bytes, so the crossing loses them.
    if (probe.video.codec === 'wrapped_avframe') {
        previewError = 'the lavfi device hands over decoded frames rather than packets, and ' +
                       'the media interface between this binary and the engine carries bytes ' +
                       '— so it cannot be played here. It records normally.';
        stopPreview();
        drawCapture();
        return;
    }

    let src = '';
    try { src = bro.ffmpeg.inputs.define(PREVIEW_ID, input); } catch (e) {
        previewError = String((e && e.message) || e);
        stopPreview();
        drawCapture();
        return;
    }

    if (!previewVideo) {
        previewVideo = el('video', { cls: 'cap-video', 'data-f': 'preview' });
        refs.preview.append(previewVideo);
    }
    previewVideo.setAttribute('src', src);
    try { previewVideo.play(); } catch (e) { /* it starts on the next frame */ }
    drawCapture();
}

/// Let the device go.
///
/// Not optional and not tidy-up: a camera opened by the preview is a camera
/// that cannot be opened by the recording, because a DirectShow device is
/// exclusive. So the preview is torn down before `record.start` and put back
/// afterwards, and leaving this stage releases it too.
export function stopPreview() {
    if (previewVideo) {
        try { previewVideo.pause(); } catch (e) { /* already gone */ }
        if (previewVideo.parentNode) previewVideo.parentNode.removeChild(previewVideo);
        previewVideo = null;
    }
    try { bro.ffmpeg.inputs.forget(PREVIEW_ID); } catch (e) { /* not registered */ }
    previewKey = '';
}

/// Coming to the stage: take a picture. Leaving it: give the device back.
export function arrive() {
    previewKey = '';
    syncPreview();
    drawCapture();
}

export function leave() {
    stopPreview();
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
    if (!capture.device) return ['no device', `${devices().length} available`];
    const bits = [capture.source || 'nothing chosen'];
    if (capture.seconds) bits.push(`-t ${capture.seconds}`);
    return [`-f ${capture.device}`, bits.join(' · ')];
}

// ── recording ──────────────────────────────────────────────────────────────

export function startRecording() {
    if (recording) return;
    if (!capture.device || !capture.source) {
        if (hooks.flash) hooks.flash('Choose a device first');
        return;
    }
    if (!capture.path) capture.path = defaultPath();

    // The device goes to the recording, not to the preview. A camera is
    // exclusive on Windows and the second open fails; letting the preview keep
    // it would make every recording fail with a message about the device being
    // in use, which reads as a broken application.
    stopPreview();

    const spec = Object.assign({
        source: asInput(),
        path: capture.path,
        format: capture.format,
        crf: capture.quality,
        preset: 'veryfast',
    }, capture.videoCodec ? { videoCodec: capture.videoCodec } : {},
       capture.audioCodec ? { audioCodec: capture.audioCodec } : {});

    try {
        bro.ffmpeg.record.start(spec);
    } catch (e) {
        if (hooks.flash) hooks.flash(String((e && e.message) || e));
        previewKey = '';
        syncPreview();
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
        // a camera takes a moment — and because a recording takes the device
        // away and gives it back. Cheap, and only while the stage is up: there
        // is no element anywhere else.
        if (previewVideo && previewVideo.paused)
            try { previewVideo.play(); } catch (e) { /* not ready yet */ }
        fitPreview();
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
    // The device is free again, so the picture comes back.
    previewKey = '';
    syncPreview();
    drawCapture();
}

// ── drawing ────────────────────────────────────────────────────────────────

export function drawCapture() {
    if (!refs.list) return;
    drawDevices();
    drawSettings();
    drawRecording();
    put(refs.options, () => optionRows());
}

function drawDevices() {
    put(refs.list, () => {
        const all = devices();
        const out = [head(`Devices · ${all.length}`)];
        if (!all.length)
            return [div('dim pad', 'This build registered no capture devices.')];
        for (const d of all) {
            out.push(el('button', {
                cls: 'cap-device tiny' + (d.name === capture.device ? ' on' : ''),
                'data-device': d.name,
                on: { click: () => pickDevice(d.name) },
            }, [
                span(d.name, 'mono'),
                span(d.longName || '', 'dim'),
                span(d.kinds.join(' · '), 'dim mono'),
            ]));
        }
        if (capture.device) out.push(...sourceRows());
        return out;
    });
}

function pickDevice(name) {
    if (capture.device === name) return;
    capture.device = name;
    // The options belong to the demuxer that is going away with it. Carrying
    // `draw_mouse` over to a camera would be carrying a key that stops the open
    // — the same reason changing the muxer empties its bag one stage along.
    capture.options = {};
    capture.source = '';
    const list = sourcesOf(name);
    if (list.ok && list.sources.length) {
        const first = list.sources.find((s) => (s.mediaTypes || []).indexOf('video') >= 0) ||
                      list.sources[0];
        capture.source = sourceArg(first);
    } else if (HINTS[name]) {
        capture.source = HINTS[name];
    }
    syncPreview();
    if (hooks.changed) hooks.changed();
    drawCapture();
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
    const list = sourcesOf(capture.device);
    const out = [head('What it can see')];

    if (!list.ok) {
        // An answer, not a failure. gdigrab takes a rectangle rather than a
        // device name and says so; an empty list here would read as a machine
        // with no cameras in it.
        out.push(div('cap-note dim', list.error ||
            `${capture.device} does not list its sources.`));
        if (HINTS[capture.device])
            out.push(el('button', {
                cls: 'tiny', 'data-f': 'caphint',
                text: `Use ${HINTS[capture.device]}`,
                title: 'A starting point out of ffmpeg’s documentation — libavdevice has no ' +
                       'call that returns it, so it is a hint and not a capability. The field ' +
                       'takes anything.',
                on: { click: () => setSource(HINTS[capture.device]) },
            }));
        return out;
    }

    for (const s of list.sources) {
        const arg = sourceArg(s);
        out.push(el('button', {
            cls: 'cap-source tiny' + (arg === capture.source ? ' on' : ''),
            'data-source': s.description || s.name,
            on: { click: () => setSource(arg) },
        }, [
            span((s.mediaTypes || []).join('/') || '?', 'dim mono'),
            span(s.description || s.name),
        ]));
    }
    if (!list.sources.length)
        out.push(div('cap-note dim', 'Nothing plugged in that this device can see.'));

    // Two of them at once is one `-i`, which is what a camera and a microphone
    // recorded together actually is — one demuxer, one seek, one file.
    const audio = list.sources.filter((s) => (s.mediaTypes || []).indexOf('audio') >= 0);
    if (audio.length && capture.source.indexOf('video=') === 0)
        out.push(div('cap-note dim',
            'A camera and a microphone are one -i: video=… and audio=… joined with a colon. ' +
            'Click a sound source to add it.'));

    out.push(el('button', {
        cls: 'tiny', 'data-f': 'caprescan', text: 'Rescan',
        title: 'Ask the device again — this is the one query here that talks to hardware',
        on: { click: () => { sourcesOf(capture.device, true); drawCapture(); } },
    }));
    return out;
}

function setSource(arg) {
    // A sound source clicked while a camera is chosen joins it rather than
    // replacing it: `video=Cam:audio=Mic` is one input and two streams, which
    // is what dshow means by it.
    if (arg.indexOf('audio=') === 0 && capture.source.indexOf('video=') === 0 &&
        capture.source.indexOf(':audio=') < 0)
        capture.source = `${capture.source}:${arg}`;
    else
        capture.source = arg;
    syncPreview();
    if (hooks.changed) hooks.changed();
    drawCapture();
}

// ── the middle: what it is set to, and the picture ─────────────────────────

function drawSettings() {
    put(refs.settings, () => {
        if (!capture.device)
            return [div('dim pad',
                'Choose a device on the left. A device is an input — `-f gdigrab -i desktop` ' +
                'is an -i with a demuxer and that demuxer’s options, exactly like a file — ' +
                'and what makes it different is that it never ends.')];

        const source = el('input', {
            cls: 'wide', 'data-f': 'capsource', type: 'text', value: capture.source,
            placeholder: HINTS[capture.device] || 'what this device is asked for after -i',
            on: { change: () => setSource(source.value.trim()) },
        });

        const seconds = el('input', {
            cls: 'num', 'data-f': 'capseconds', type: 'text',
            value: capture.seconds ? String(capture.seconds) : '',
            placeholder: 'until stopped',
            on: { change: () => {
                capture.seconds = Number(seconds.value) || 0;
                syncPreview();
                if (hooks.changed) hooks.changed();
                drawCapture();
            } },
        });

        const path = el('input', {
            cls: 'wide', 'data-f': 'cappath', type: 'text', value: capture.path,
            on: { change: () => { capture.path = path.value.trim(); redraw(); } },
        });

        const rows = [
            head('The input'),
            row('-i', source),
            row('', span(
                'This is the whole of what the device is asked for. Everything else about ' +
                'it — the size, the rate, the buffer — is an option of its demuxer and is in ' +
                'the column on the right, where the command bar prints it in front of the -i.',
                'dim')),
            row('-t', seconds),
            row('', span(
                'How long to record for. Empty means until you press stop, and then there is ' +
                'no total, no percentage and no estimate — a device has no end, so a bar ' +
                'creeping towards one would be inventing it.', 'dim')),
        ];

        rows.push(...regionRows());

        rows.push(head('The file'));
        rows.push(row('Path', path));
        rows.push(row('Container', muxerPicker()));
        rows.push(row('Video', codecPicker(false)));
        rows.push(row('Audio', codecPicker(true)));
        rows.push(row('Quality', qualityField()));
        rows.push(row('', span(
            'A recording is its own pipeline: one input, no compositing, straight into the ' +
            'encoder. The Encode stage describes the render of the timeline, which is a ' +
            'different file, so the settings are not shared.', 'dim')));
        return rows;
    });
}

function redraw() {
    syncPreview();
    if (hooks.changed) hooks.changed();
    drawCapture();
}

/// The region, when the demuxer has one.
///
/// **Picked rather than typed**, by dragging on the live picture — which is
/// the only way it could be picked in this engine, and it turns out to be the
/// right way anyway: the thing being framed is on the screen in front of you.
/// The numbers are shown as well as set, because `offset_x` is what the command
/// bar prints and a rectangle nobody can read off is a rectangle nobody can
/// reproduce.
function regionRows() {
    if (!takesRegion(capture.device)) return [];
    const o = capture.options;
    const set = o.video_size || o.offset_x || o.offset_y;
    return [
        head('Region'),
        row('Now', span(set
            ? `${o.video_size || 'the whole screen'} at ${o.offset_x || 0},${o.offset_y || 0}`
            : 'the whole screen', 'mono')),
        row('', span(
            'Drag a box on the picture below to capture part of the screen. It sets ' +
            '-offset_x, -offset_y and -video_size, which are this demuxer’s own options and ' +
            'are in the column on the right beside everything else it takes.', 'dim')),
        set ? row('', el('button', {
            cls: 'tiny', 'data-f': 'capwhole', text: 'The whole screen',
            on: { click: () => {
                const next = Object.assign({}, capture.options);
                delete next.video_size;
                delete next.offset_x;
                delete next.offset_y;
                capture.options = next;
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

// ── the picture, and the record bar ────────────────────────────────────────

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
                : `${Math.round((st.progress || 0) * 100)}% of ${clock(capture.seconds)}`,
                'dim'));
        } else {
            out.push(el('button', {
                cls: 'primary', 'data-f': 'caprecord', text: 'Record',
                disabled: !capture.device || !capture.source,
                on: { click: startRecording },
            }));
            if (lastFile) {
                out.push(span(basename(lastFile), 'mono'));
                out.push(span(bytes(lastBytes), 'dim mono'));
                out.push(el('button', {
                    cls: 'tiny', 'data-f': 'capuse', text: 'Add to the timeline',
                    on: { click: () => { if (hooks.open) hooks.open(lastFile); } },
                }));
            } else if (capture.device) {
                out.push(span('Nothing recorded yet.', 'dim'));
            }
        }
        return out;
    });

    if (refs.note) {
        put(refs.note, () => {
            if (previewError) return [div('cap-error', previewError)];
            if (recording)
                return [div('cap-note dim',
                    'The device is going to the recording rather than to a preview — a camera ' +
                    'is exclusive, and a picture of it here would be the recording failing.')];
            if (!previewVideo && capture.device)
                return [div('cap-note dim', 'No picture yet.')];
            return [];
        });
    }
}

// ── the picture, fitted ────────────────────────────────────────────────────

/// Place the preview inside its box at its own aspect.
///
/// Not `object-fit`, and not left to stretch. Stretching matters here more than
/// it does anywhere else in this application: a region is dragged on this
/// picture, so a picture that is not the shape of the screen is a rectangle
/// that is not the shape of the rectangle you drew. Fitted, the drag is one
/// ratio in both axes and the box on screen is the box that gets captured.
function fitPreview() {
    if (!previewVideo || !refs.preview) return;
    const vw = previewVideo.videoWidth, vh = previewVideo.videoHeight;
    const cw = refs.preview.clientWidth, ch = refs.preview.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    const scale = Math.min(cw / vw, ch / vh);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (previewVideo.clientWidth === w && previewVideo.clientHeight === h) return;
    previewVideo.style.width = `${w}px`;
    previewVideo.style.height = `${h}px`;
    previewVideo.style.left = `${Math.round((cw - w) / 2)}px`;
    previewVideo.style.top = `${Math.round((ch - h) / 2)}px`;
}

// ── the region drag ────────────────────────────────────────────────────────
//
// A rectangle dragged on the preview, turned into the demuxer's own options.
// Measured against the *picture* rather than against the panel it sits in —
// the picture is fitted, so there is letterboxing around it, and a drag
// measured against the panel would put the region a little off in whichever
// direction the black bars are.

export function initRegionDrag(node, marquee) {
    if (!node) return;
    let from = null;

    // Relative to the picture, which is what the numbers are a fraction of.
    const at = (e) => {
        const box = previewVideo.getBoundingClientRect();
        return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const inPanel = (p) => {
        const panel = node.getBoundingClientRect();
        const pic = previewVideo.getBoundingClientRect();
        return { x: p.x + (pic.left - panel.left), y: p.y + (pic.top - panel.top) };
    };

    node.addEventListener('mousedown', (e) => {
        if (!takesRegion(capture.device) || !previewVideo || recording) return;
        from = at(e);
        if (marquee) marquee.classList.remove('hidden');
        e.preventDefault();
    });
    node.addEventListener('mousemove', (e) => {
        if (!from || !marquee) return;
        const a = inPanel(from), b = inPanel(at(e));
        marquee.style.left = `${Math.min(a.x, b.x)}px`;
        marquee.style.top = `${Math.min(a.y, b.y)}px`;
        marquee.style.width = `${Math.abs(b.x - a.x)}px`;
        marquee.style.height = `${Math.abs(b.y - a.y)}px`;
    });
    node.addEventListener('mouseup', (e) => {
        if (!from) return;
        const now = at(e);
        const start = from;
        from = null;
        if (marquee) marquee.classList.add('hidden');
        setRegionFromDrag(start, now);
    });
}

/// The dragged box, in the screen's own pixels.
///
/// Coordinates are relative to the *picture*, not to the panel. Exported so a
/// test can do what a person does with a mouse: the drag itself is three
/// listeners and the arithmetic is the part worth checking.
export function setRegionFromDrag(from, to) {
    if (!previewVideo) return;
    const shownW = previewVideo.clientWidth || 1;
    const shownH = previewVideo.clientHeight || 1;
    const realW = previewVideo.videoWidth || shownW;
    const realH = previewVideo.videoHeight || shownH;

    const x = Math.round(Math.min(from.x, to.x) * realW / shownW);
    const y = Math.round(Math.min(from.y, to.y) * realH / shownH);
    // Even numbers, because yuv420p has no half pixels and gdigrab hands the
    // rectangle straight to the encoder.
    const w = Math.max(2, Math.round(Math.abs(to.x - from.x) * realW / shownW) & ~1);
    const h = Math.max(2, Math.round(Math.abs(to.y - from.y) * realH / shownH) & ~1);
    if (w < 16 || h < 16) return;   // a click, not a drag

    const next = Object.assign({}, capture.options);
    next.offset_x = String(Math.max(0, x));
    next.offset_y = String(Math.max(0, y));
    next.video_size = `${w}x${h}`;
    capture.options = next;
    redraw();
}

// ── the option column ──────────────────────────────────────────────────────

function optionRows() {
    if (!capture.device) return [];
    let all = [];
    try { all = bro.ffmpeg.demuxerOptions(capture.device) || []; } catch (e) { all = []; }
    return optionColumn({
        name: 'capoptsearch',
        title: `${capture.device} options · ${all.length}`,
        note: 'What this device takes, out of its own option table and libavformat’s generic ' +
              'one — the same column the encoder’s and the muxer’s options get. An unknown ' +
              'key stops the open rather than being ignored.',
        options: all,
        bag: capture.options,
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
/// so the bar draws one the way it draws the other — every one of these is
/// exact, because there is no filtergraph in a capture at all.
export function commandParts() {
    if (!capture.device || !capture.source) return null;
    const arg = (v) => {
        const s = String(v);
        return /[\s"'\\$`&|;<>(){}[\]*?!#~]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
    };

    const inputs = ['-f', arg(capture.device)];
    for (const k of Object.keys(capture.options))
        if (capture.options[k] !== '' && capture.options[k] !== undefined)
            inputs.push(`-${k}`, arg(capture.options[k]));
    // `-t` in front of the `-i`, where it belongs: after it, it would limit the
    // *output* — nearly the same file and a different instruction, which is
    // exactly the kind of thing this bar exists to stop somebody guessing at.
    if (capture.seconds) inputs.push('-t', String(capture.seconds));
    inputs.push('-i', arg(capture.source));

    const out = [];
    if (capture.videoCodec) out.push('-c:v', capture.videoCodec);
    if (capture.audioCodec) out.push('-c:a', capture.audioCodec);
    if (capture.quality) out.push('-crf', String(capture.quality));
    out.push('-preset', 'veryfast');
    if (capture.format) out.push('-f', capture.format);
    out.push(arg(capture.path || 'capture.mkv'));

    return { pre: ['ffmpeg'], inputs, out };
}
