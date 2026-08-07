// The A/B stage: what the settings cost, as a picture.
//
// Two renders of the same few seconds — one at the settings being chosen, one
// lossless — laid on top of each other with a wipe between them. The lossless
// one is what the compositor produced before any encoder saw it, so the
// difference on screen is exactly what the settings cost and nothing else.
//
// It plays, and the two halves run together to the frame. That matters more
// than it sounds: banding crawls and grass smears, neither shows on a still,
// and a wipe between two moments a fraction of a second apart shows the
// movement between them rather than anything about the encoder.

import { project, duration } from '../project.js';
import { specInputs } from '../inputs.js';
import { el, div, span, put, segmented, fromTemplate } from '../dom.js';
import { bytes, clock, elapsed, timecode } from '../format.js';
import { settings, preview, PREVIEW_LENGTHS, currentJob, outputFps,
         outputExt } from './state.js';
import { previewSpec, range } from './spec.js';
import { qualitySpec, qualityResult, qualityReason, metrics } from './quality.js';

let panes = {};
let hooks = {};

// The elements the stage and the transport are made of, kept as references.
//
// Not looked up by id: bro's getElementById index is keyed by the id string
// and is not updated when a replacement element claims an id the index
// already knows, so after a redraw it hands back the *previous* element —
// still answering to `.style` and `.currentTime`, detached, measuring zero,
// and driving nothing. Anything rebuilt has to be held, not found.
const node = {
    ref: null, cand: null,          // the two videos
    play: null,                     // the play/pause button
    time: null, length: null,       // the timecode and the x / y s readout
    played: null, head: null,       // the scrub bar's fill and grip
};

export function initPreview(refs, h) {
    panes = refs;
    hooks = h || {};
}

// ── what a reference is a reference of ─────────────────────────────────────

/// The lossless render only has to be redone when the picture itself changes:
/// a different quality, preset or codec does not move it, which is the case
/// that matters because it is the one being compared.
function referenceKey() {
    return JSON.stringify([
        // The inputs as well as the clips: a demuxer forced or a `-probesize`
        // set changes what a clip decodes to without changing anything about
        // the clip, and a reference that outlived it would be a comparison
        // against the file as it used to open.
        specInputs(),
        // `speed` beside `length`, because the two together are what footage this
        // clip is: a reference that outlived a speed change would be a comparison
        // against different frames.
        project.clips.map((c) => [c.path, c.start, c.length, c.speed, c.inPoint, c.track,
                                  c.xform.opacity, c.xform.scale, c.xform.x, c.xform.y,
                                  c.xform.fit, c.xform.crop, project.layout]),
        settings.width, settings.height, outputFps(),
        preview.at, settings.previewLength, project.width, project.height,
    ]);
}

export function invalidatePreview() {
    preview.refReady = false;
    preview.candReady = false;
    preview.stats = null;
    preview.quality = null;
}

/// The candidate is stale but the reference is not: changing the quality does
/// not change what the picture was before it was encoded.
export function invalidateCandidate() {
    preview.candReady = false;
    preview.stats = null;
    // The numbers are about a candidate that no longer exists. Kept, they would
    // be the previous settings' score sitting under the new settings' picture,
    // which is the one way this feature could mislead rather than inform.
    preview.quality = null;
    if (preview.refKey !== referenceKey()) preview.refReady = false;
}

export function previewRange() {
    const total = Math.max(0, duration());
    const start = Math.max(0, Math.min(preview.at, Math.max(0, total - 0.2)));
    return { start, end: Math.min(total, start + settings.previewLength) };
}

// ── rendering the two halves ───────────────────────────────────────────────

export function startPreview() {
    if (currentJob()) return;
    preview.error = '';
    const key = referenceKey();
    if (preview.refKey !== key) { preview.refReady = false; preview.refKey = key; }
    if (!preview.refReady) renderReference();
    else renderCandidate();
}

function renderReference() {
    const r = previewRange();
    preview.refPath = bro.ffmpeg.tempPath('reference.mkv');
    // Lossless H.264 rather than a raw format: it is exact, it is a tenth the
    // size of FFV1, and it decodes fast enough to play beside the candidate.
    // yuv444p so that the reference does not itself throw away the chroma the
    // candidate is about to be judged on.
    hooks.launch(previewSpec({
        path: preview.refPath,
        start: r.start, end: r.end,
        container: 'matroska',
        videoCodec: 'libx264',
        audio: false,
        pixelFormat: 'yuv444p',
        videoOptions: { crf: 0, preset: 'ultrafast' },
        audioOptions: {},
    }), 'reference');
}

export function renderCandidate() {
    const r = previewRange();
    preview.candPath = bro.ffmpeg.tempPath(`candidate.${outputExt()}`);
    hooks.launch(previewSpec({ path: preview.candPath, start: r.start, end: r.end }), 'candidate');
}

/// Called when the render slot reports a terminal state and the job was one of
/// ours. Returns true when the caller should carry straight on to the next
/// half, which is what makes one click render both.
export function previewFinished(p) {
    if (p.state !== 'done') {
        preview.error = p.state === 'cancelled' ? '' : (p.error || 'the preview render failed');
        drawPreview();
        return false;
    }
    if (currentJob() === 'reference') {
        preview.refReady = true;
        return true;
    }
    if (currentJob() === 'quality') {
        // The answers are in the report as series; this is a reading of them
        // rather than a second copy. `preview.qualityJob` is the number the
        // host gave *this* comparison when it started, so an earlier one's
        // frames cannot be mistaken for it — `p.job` cannot be used for that,
        // because it is the render running now and this render has just ended.
        preview.quality = qualityResult(preview.qualityJob);
        preview.measuring = false;
        return false;
    }
    const r = previewRange();
    preview.candReady = true;
    preview.stats = {
        bytes: p.bytes,
        seconds: Math.max(0.001, r.end - r.start),
        encodeFps: p.fps,
        elapsed: p.elapsed,
        frames: p.frames,
    };
    // Straight on into the measurement, on the same one slot. It writes nothing
    // and shows nothing while it runs — the two videos are already on screen
    // and being played, and rebuilding the stage under them to say "measuring"
    // would take the picture away to describe it.
    return 'quality';
}

/// The third render: what the settings cost, measured on the very two files the
/// wipe is showing.
export function startQuality() {
    const spec = qualitySpec(previewRange());
    if (!spec) return false;
    preview.measuring = true;
    preview.qualityJob = hooks.launch(spec, 'quality') || 0;
    return true;
}

/// Only the numbers under the stage. Redrawing the whole preview would rebuild
/// the two `<video>` elements, which are the decoders — so a measurement
/// arriving would stop the playback it was measuring.
export function drawPreviewStats() {
    put(panes.stats, () => statLines());
}

// ── drawing ────────────────────────────────────────────────────────────────

/// What the stage is currently showing, so that it is rebuilt only when that
/// changes.
///
/// **The two `<video>` elements are the decoders.** `put()` throws them away
/// and a fresh `tpl-pv-wipe` starts both files again from frame 0 — and
/// `prepare()` draws everything and runs for the Encode stage *and* for the
/// Write stage, stepping between the two being one visit. So walking over to
/// set a filename and back restarted the comparison you were half way through
/// watching. `drawPreviewStats()` exists for exactly this reason on the
/// measurement path; this is the same rule for the redraw the shell causes.
///
/// A busy stage is a progress bar with a percentage on it and is redrawn every
/// frame, which is what the empty key says.
let showing = null;

export function drawPreview() {
    const busy = currentJob() === 'reference' || currentJob() === 'candidate';
    const have = preview.refReady && preview.candReady;

    const key = busy ? null
        : `${have}|${preview.mode}|${preview.refPath}|${preview.candPath}|` +
          `${preview.error}|${settings.previewLength}`;
    if (key === null || key !== showing || !node.ref || !node.ref.parentNode) {
        showing = key;
        put(panes.stage, () => stage(busy, have));
        if (have) attachPreviewVideos();
    }
    put(panes.controls, () => controls(busy, have));
    put(panes.stats, () => statLines());
}

function stage(busy, have) {
    if (busy) {
        const busyNode = fromTemplate('tpl-pv-busy');
        const poll = hooks.status();
        busyNode.querySelector('.what').textContent = currentJob() === 'reference'
            ? 'Rendering the reference' : 'Encoding at your settings';
        const pct = Math.round((poll ? poll.progress : 0) * 100);
        busyNode.querySelector('.ex-fill').style.width = `${pct}%`;
        busyNode.querySelector('.pct').textContent = `${pct}%`;
        node.ref = node.cand = null;
        return busyNode;
    }
    if (have) {
        const stageNode = fromTemplate(preview.mode === 'side' ? 'tpl-pv-side' : 'tpl-pv-wipe');
        node.ref = stageNode.querySelector('.pv-ref');
        node.cand = stageNode.querySelector('.pv-cand');
        if (preview.mode !== 'side') {
            const pct = `${preview.wipe * 100}%`;
            stageNode.querySelector('.ex-pv-window').style.width = pct;
            stageNode.querySelector('.ex-pv-handle').style.left = pct;
            stageNode.addEventListener('mousedown', (e) => wipeDrag(stageNode, e));
        }
        return stageNode;
    }
    node.ref = node.cand = null;
    const idle = fromTemplate('tpl-pv-idle');
    const message = idle.querySelector('.message');
    message.textContent = preview.error || '';
    if (preview.error) message.className = 'message ex-failed';
    return idle;
}

function wipeDrag(area, down) {
    const move = (e) => {
        const box = area.getBoundingClientRect();
        if (!box.width) return;
        preview.wipe = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
        const pct = `${preview.wipe * 100}%`;
        const win = area.querySelector('.ex-pv-window');
        const handle = area.querySelector('.ex-pv-handle');
        if (win) win.style.width = pct;
        if (handle) handle.style.left = pct;
    };
    move(down);
    const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function controls(busy, have) {
    const r = previewRange();
    const rows = [div('ex-pv-row', [
        el('button', {
            cls: 'tiny primary pv-render', disabled: busy,
            text: busy ? 'Rendering…' : (have ? 'Render again' : 'Render preview'),
            on: { click: startPreview },
        }),
        span(`from ${clock(r.start)}`, 'dim'),
        segmented('pvlen', PREVIEW_LENGTHS.map((n) => ({ v: n, l: `${n}s` })), settings.previewLength,
                  (v) => { settings.previewLength = Number(v); invalidatePreview(); drawPreview(); }),
    ])];

    if (!have) {
        node.play = node.time = node.length = node.played = node.head = null;
        return rows;
    }

    // A transport, not a play button. What a comparison is for is a particular
    // frame — the one where the gradient bands or the smeared grass are — and
    // finding it means scrubbing to it and stepping around it.
    const scrub = fromTemplate('tpl-pv-scrub');
    scrub.addEventListener('mousedown', (e) => scrubDrag(scrub, e));
    node.played = scrub.querySelector('.ex-pv-scrub-played');
    node.head = scrub.querySelector('.ex-pv-scrub-head');

    node.play = el('button', { cls: 'tiny primary pv-play',
                               text: preview.playing ? 'Pause' : 'Play',
                               title: 'Play / pause (Space)',
                               on: { click: () => setPreviewPlaying(!preview.playing) } });
    // Two children of the row, not one holding two: a span that is a flex item
    // does not lay its own inline children out — they come out drawn on top of
    // each other.
    node.time = el('span', { cls: 'mono pv-time' });
    node.length = el('span', { cls: 'mono dim pv-len' });

    rows.push(scrub);
    rows.push(div('ex-pv-row', [
        el('button', { cls: 'tiny pv-start', text: '|◀',
                       title: 'Back to the start of the preview',
                       on: { click: () => seekPreview(0) } }),
        el('button', { cls: 'tiny pv-prev', text: '◀', title: 'Previous frame',
                       on: { click: () => stepPreview(-1) } }),
        node.play,
        el('button', { cls: 'tiny pv-next', text: '▶', title: 'Next frame',
                       on: { click: () => stepPreview(1) } }),
        node.time,
        node.length,
        segmented('pvmode', [{ v: 'wipe', l: 'Wipe' }, { v: 'side', l: 'Side by side' }], preview.mode,
                  (v) => { preview.mode = v; drawPreview(); }),
        span('drag the divider', 'dim'),
    ]));
    return rows;
}

function statLines() {
    const s = preview.stats;
    if (!s) return [];
    const kbps = (s.bytes * 8) / s.seconds / 1000;
    const r = range();
    // The whole point: what this costs over the length actually being written.
    const projected = r.length > 0 ? s.bytes * (r.length / s.seconds) : 0;
    const speed = s.elapsed > 0 ? s.seconds / s.elapsed : 0;
    const rate = kbps < 1000 ? `${kbps.toFixed(0)} kbps` : `${(kbps / 1000).toFixed(1)} Mbps`;

    return [
        qualityLine(),
        div('', [span(`this ${s.seconds.toFixed(1)} s`, 'dim'), ` ${bytes(s.bytes)} · ${rate}`]),
        div('', [span('whole render', 'dim'), ' ', span(`≈ ${bytes(projected)}`, 'good'),
                 ` over ${clock(r.length)}`]),
        div('', [span('speed', 'dim'), ` ${s.encodeFps.toFixed(1)} fps · ` +
                 (speed >= 1 ? `${speed.toFixed(1)}× real time`
                             : `${(1 / Math.max(speed, 0.001)).toFixed(1)}× slower than real time`) +
                 (r.length > 0 && speed > 0 ? ` · about ${elapsed(r.length / speed)} for the lot` : '')]),
    ];
}

/// What the settings cost, in the terms a codec is argued about in.
///
/// It leads the stats because it is the answer to the question the whole stage
/// exists for. Each figure carries what it means in its tooltip rather than in
/// the line — three sentences under a wipe is a paragraph nobody reads — and
/// the metric names are libavfilter's own, so a number here can be checked
/// against `ffmpeg -lavfi psnr` on the same two files.
function qualityLine() {
    if (preview.measuring)
        return div('', [span('measured', 'dim'),
                        ' comparing the two halves, frame by frame…']);
    const q = preview.quality;
    if (!q || !q.length) {
        const no = qualityReason();
        return no && metrics().length === 0 ? div('dim', no) : null;
    }
    const bits = [];
    for (const m of q) {
        bits.push(el('span', { cls: 'ex-q', title: `${m.key} — ${m.hint}` },
                     [span(m.label, 'dim'), ' ', span(m.text, 'good')]));
    }
    return div('ex-quality', [span('measured', 'dim'), ...bits,
                              span('against the lossless half', 'dim')]);
}

// ── the two videos ─────────────────────────────────────────────────────────

const refVideo = () => node.ref;
const candVideo = () => node.cand;

/// Both files into their elements, sized to the stage.
function attachPreviewVideos() {
    const ref = refVideo(), cand = candVideo();
    if (!ref || !cand) return;
    if (ref.src !== preview.refPath) ref.src = preview.refPath;
    if (cand.src !== preview.candPath) cand.src = preview.candPath;
    ref.loop = true;
    cand.loop = true;
    fitPreviewVideos();
    syncPlayback();
}

/// Place both videos on the same pixels.
///
/// The wipe only means anything if the two pictures line up exactly, so they
/// are fitted in pixels against the *stage* — not against the window the top
/// one is clipped by, which is narrower and would squash it into a comparison
/// between a picture and a squeezed copy of itself.
function fitPreviewVideos() {
    const ref = refVideo(), cand = candVideo();
    if (!ref || !cand) return;

    // In wipe mode both are measured against the stage, because the encoded
    // one's own parent is the clipping window. Side by side, each half is its
    // own box.
    const stageEl = preview.mode === 'side' ? null : ref.parentNode;
    const aspect = (settings.width || 16) / Math.max(1, settings.height || 9);

    for (const v of [ref, cand]) {
        const host = stageEl || v.parentNode;
        const box = host ? host.getBoundingClientRect() : null;
        if (!box || !box.width || !box.height) continue;

        let w = box.width, h = w / aspect;
        if (h > box.height) { h = box.height; w = h * aspect; }
        v.style.left = `${Math.round((box.width - w) / 2)}px`;
        v.style.top = `${Math.round((box.height - h) / 2)}px`;
        v.style.width = `${Math.round(w)}px`;
        v.style.height = `${Math.round(h)}px`;
    }
}

/// Ask both to play or both to stop.
///
/// Asking once is not enough. This runs in the same turn as the `src` that
/// created them, when the file has not been opened yet and there is nothing to
/// play — the request is simply dropped, and the preview sits on its first
/// frame with the button reading "Pause". So the wanted state is remembered
/// and chase() keeps asking until it takes.
function syncPlayback() {
    const ref = refVideo(), cand = candVideo();
    if (!ref || !cand) return;
    if (preview.playing) { ref.play(); cand.play(); }
    else { ref.pause(); cand.pause(); }
}

export function stopPreviewPlayback() {
    for (const v of [refVideo(), candVideo()]) if (v && v.pause) v.pause();
}

function setPreviewPlaying(on) {
    preview.playing = on;
    if (node.play) node.play.textContent = on ? 'Pause' : 'Play';
    syncPlayback();
}

/// Both to the same time, exactly. While the pictures are still this is a
/// straight seek rather than the drift correction playback uses.
function seekPreview(t) {
    const ref = refVideo(), cand = candVideo();
    if (!ref || !cand) return;
    const len = cand.duration > 0 ? cand.duration : settings.previewLength;
    const at = Math.max(0, Math.min(len - 1e-3, t));
    ref.currentTime = at;
    cand.currentTime = at;
    updatePreviewTime();
}

/// One frame, on both. `stepFrame()` rather than `currentTime += 1/fps`,
/// because fps is an average and the seconds round-trip misses frame
/// boundaries — a back-step lands where it started.
function stepPreview(dir) {
    const ref = refVideo(), cand = candVideo();
    if (!ref || !cand) return;
    setPreviewPlaying(false);
    for (const v of [cand, ref]) {
        if (v.stepFrame) v.stepFrame(dir);
        else v.currentTime = Math.max(0, v.currentTime + dir / outputFps());
    }
    // Whatever the candidate landed on is the frame being compared; the
    // reference is put on the same one rather than trusted to have stepped the
    // same distance, because the two files can have different frame layouts.
    if (Math.abs(ref.currentTime - cand.currentTime) > 1e-3) ref.currentTime = cand.currentTime;
    updatePreviewTime();
}

function scrubDrag(bar, down) {
    // Scrubbing means looking, so it stops. Resuming from wherever the hand
    // let go is what every other transport in the app does.
    setPreviewPlaying(false);
    const move = (e) => {
        const box = bar.getBoundingClientRect();
        if (!box.width) return;
        const cand = candVideo();
        const len = cand && cand.duration > 0 ? cand.duration : settings.previewLength;
        seekPreview(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * len);
    };
    move(down);
    const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

/// Where the comparison is, said in the timeline's own terms. The preview file
/// starts at zero; the frame in it is somewhere in the middle of the edit, and
/// that is the number worth showing.
function updatePreviewTime() {
    const cand = candVideo();
    if (!cand) return;
    const len = cand.duration > 0 ? cand.duration : Math.max(0.001, settings.previewLength);
    const at = Math.max(0, Math.min(len, cand.currentTime || 0));
    const fps = outputFps();

    if (node.time) node.time.textContent = timecode(previewRange().start + at, fps);
    if (node.length) node.length.textContent = `${at.toFixed(2)} / ${len.toFixed(2)} s`;

    const frac = at / len;
    if (node.played) node.played.style.width = `${(frac * 100).toFixed(2)}%`;
    if (node.head) node.head.style.left = `${(frac * 100).toFixed(2)}%`;

    // And on the strip, against the whole timeline — which is what makes it
    // playback of a part of the edit rather than of an unrelated little file.
    hooks.mark(previewRange().start + at);
}

// ── every frame ────────────────────────────────────────────────────────────

/// Keep the two videos on the same frame, the right size, and playing if they
/// are supposed to be.
export function chasePreview() {
    if (!preview.refReady || !preview.candReady) return;
    const ref = refVideo(), cand = candVideo();
    if (!ref || !cand) return;

    // The first fit runs in the same turn as the markup that created the
    // elements, when the stage has not been laid out and measures zero. And
    // again whenever the stage changes size, which it does: the stage takes
    // whatever the window leaves, so resizing the window or opening the
    // advanced column moves it. Videos placed in pixels do not follow on their
    // own — that is the price of placing them exactly.
    const box = ref.parentNode && ref.parentNode.getBoundingClientRect
        ? ref.parentNode.getBoundingClientRect() : null;
    const size = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '';
    if (!ref.style.width || size !== preview.fittedTo) {
        preview.fittedTo = size;
        fitPreviewVideos();
    }

    // Keep asking. play() in the turn the src was set is asked of a file that
    // is not open yet and is simply dropped.
    if (preview.playing && cand.paused && cand.duration > 0) syncPlayback();

    updatePreviewTime();

    if (!preview.playing) return;
    // A frame, not a tenth of a second. The candidate is the clock and the
    // reference is chased — writing currentTime every frame fights the decoder
    // — but the tolerance has to be smaller than the thing being looked for:
    // half a second of motion across the wipe hides any amount of ringing.
    const limit = 1 / Math.max(1, outputFps());
    if (Math.abs(ref.currentTime - cand.currentTime) > limit)
        ref.currentTime = cand.currentTime;
}

// ── the keyboard ───────────────────────────────────────────────────────────
//
// No-ops until there is a preview to play, which is the right answer rather
// than an error.

export function togglePreviewPlay() {
    if (!preview.refReady || !preview.candReady) return;
    setPreviewPlaying(!preview.playing);
}

export function stepPreviewBy(dir) {
    if (!preview.refReady || !preview.candReady) return;
    stepPreview(dir);
}
