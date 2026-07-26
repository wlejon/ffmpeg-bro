// ffmpeg-bro — the editing surface.
//
// Everything here drives plain <video> elements. There is no subprocess, no
// pipe and no proxy file: libavcodec is linked into this binary and registered
// as a bro media backend, so the engine decodes the real streams and hands the
// frames straight to the renderer. That is why the transport can be
// frame-accurate, why seeking is instant, and why several clips can sit on one
// timeline without any of them being transcoded first.

import { project, makeClip, addClip, removeClip, duration, clipAt, nextClipAfter,
         sourceTime, resolveOverlaps, onChange, changed, select } from './project.js';
import { analyzeClip, pending } from './analysis.js';
import * as viewer from './viewer.js';
import * as timeline from './timeline.js';
import { clock, timecode, bytes, kbps, escapeHtml, basename } from './format.js';

const el = (id) => document.getElementById(id);

const viewerEl = el('viewer');
const stage    = el('stage');
const dropzone = el('dropzone');
const osd      = el('osd');
const filename = el('filename');
const chips    = el('chips');
const mediaInfo = el('mediainfo');
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

const cropbox = el('cropbox');

// ── state ──────────────────────────────────────────────────────────────────

const transport = { t: 0, playing: false, rate: 1, volume: 1, muted: false, loop: false };
let fullscreen = false;
let cropMode = false;
let osdTimer = 0;

el('libav').textContent = bro.ffmpeg.version;

viewer.initViewer({ stage, viewer: viewerEl });
timeline.initTimeline({
    timeline: el('timeline'),
    ruler: el('ruler'), film: el('film'), wave: el('wave'),
    laneVideo: el('lane-video'), laneAudio: el('lane-audio'),
    playhead: el('playhead'),
    scrollTrack: el('tl-scroll'), scrollThumb: el('tl-thumb'),
    zoomLabel: el('tl-zoom'),
    playheadTime: () => transport.t,
    onSeek: (t, press, release) => {
        if (release) { if (resumeAfterScrub) { resumeAfterScrub = false; play(); } return; }
        if (press && transport.playing) { resumeAfterScrub = true; pause(); }
        setPlayhead(t);
    },
});

let resumeAfterScrub = false;

onChange((what) => {
    if (what === 'selection' || what === 'move' || what === 'moved') {
        showClip(project.selected);
        if (what !== 'selection') setPlayhead(transport.t);
    }
    timeline.draw();
    syncUI();
});

// A file named on the command line, handed over by the host binding.
if (bro.ffmpeg.openOnStart) open(bro.ffmpeg.openOnStart);

// ── opening ────────────────────────────────────────────────────────────────

function open(path) {
    let probe;
    try {
        probe = bro.ffmpeg.probe(path);
    } catch (e) {
        flash(String(e.message || e));
        return null;
    }
    if (!probe.video) {
        // bro's <video> drives its clock from decoded pictures, so a track
        // list with no video has nothing to advance. Say so instead of
        // loading something that will sit at 0:00 forever.
        flash(probe.audio ? 'audio-only files are not playable yet — this needs a video track'
                          : 'no audio or video track in this file');
        return null;
    }

    // New clips land after everything already on the timeline, which is what
    // dropping a second file onto a player is asking for.
    const clip = addClip(makeClip(path, probe));
    viewer.attachClip(clip);
    analyzeClip(clip);
    project.selected = clip;

    dropzone.classList.add('hidden');
    setControlsEnabled(true);
    viewer.layout();
    if (project.clips.length === 1) {
        timeline.fitView();
        setPlayhead(0);
    } else {
        timeline.fitView();
        setPlayhead(clip.start);
    }
    showClip(clip);
    changed('open');
    return clip;
}

function removeSelected() {
    const clip = project.selected;
    if (!clip) return;
    viewer.detachClip(clip);
    removeClip(clip);
    if (!project.clips.length) {
        dropzone.classList.remove('hidden');
        setControlsEnabled(false);
        project.width = project.height = 0;
    }
    timeline.fitView();
    setPlayhead(Math.min(transport.t, duration()));
    showClip(project.selected);
    changed('remove');
    flash('Removed ' + clip.name);
}

// ── transport ──────────────────────────────────────────────────────────────

function setControlsEnabled(on) {
    for (const b of [btnStart, btnPrev, btnPlay, btnNext, btnEnd, btnLoop, btnMute])
        b.disabled = !on;
    rateSel.disabled = !on;
}
setControlsEnabled(false);

/// Move the playhead. `seek` is false while playback is driving it — the
/// active clip's own clock is the master then, and writing currentTime back
/// would fight it.
function setPlayhead(t, seek = true) {
    const d = duration();
    transport.t = Math.max(0, Math.min(d, t));
    const clip = clipAt(transport.t);
    viewer.setActive(clip);
    // Selection follows the playhead. With one video track and an inspector
    // that edits the selected clip, a selection pointing somewhere other than
    // the picture on screen means the crop handles are over the wrong frame
    // and the panel describes a file you are not looking at.
    if (clip && project.selected !== clip) select(clip);
    if (clip) {
        applyAudio(clip);
        const want = sourceTime(clip, transport.t);
        if (seek && Math.abs(clip.video.currentTime - want) > 0.0005)
            clip.video.currentTime = want;
        if (transport.playing && clip.video.paused) clip.video.play();
    }
    syncUI();
}

function applyAudio(clip) {
    if (!clip || !clip.video) return;
    clip.video.muted = transport.muted;
    clip.video.volume = transport.volume;
    clip.video.playbackRate = transport.rate;
    // Looping is a property of the timeline, not of any one clip: a clip that
    // looped itself would never hand over to the next one.
    clip.video.loop = false;
}

function play() {
    if (!project.clips.length) return;
    if (transport.t >= duration() - 1e-4) setPlayhead(0);
    transport.playing = true;
    const clip = viewer.activeClip() || clipAt(transport.t);
    if (clip) { applyAudio(clip); clip.video.play(); }
    syncUI();
}

function pause() {
    transport.playing = false;
    const clip = viewer.activeClip();
    if (clip) clip.video.pause();
    syncUI();
}

function togglePlay() { transport.playing ? pause() : play(); }

// Frame stepping pauses first: nudging while running would race the clock and
// land somewhere nobody asked for.
//
// video.stepFrame() moves by decoded pictures. Doing it the usual way —
// currentTime += 1/fps — does not work: the frame rate is an average, and the
// seconds round trip misses the frame boundary, so a back step lands on the
// frame it started from and nothing happens.
function step(frames) {
    if (transport.playing) pause();
    let clip = viewer.activeClip();
    if (!clip) {
        // In a gap: step into the neighbouring clip rather than doing nothing.
        clip = frames > 0 ? nextClipAfter(transport.t) : lastClipBefore(transport.t);
        if (!clip) return;
        setPlayhead(frames > 0 ? clip.start : clip.start + clip.length - 1e-4);
        return;
    }
    if (clip.video.stepFrame(frames)) {
        transport.t = clip.start + clip.video.currentTime - clip.inPoint;
        syncUI();
        if (timeline.revealTime(transport.t)) timeline.draw();
        return;
    }
    // Off the end of this clip — carry on into the next one, so stepping
    // walks the whole timeline and not just one file.
    const next = frames > 0 ? nextClipAfter(transport.t) : lastClipBefore(clip.start);
    if (next) setPlayhead(frames > 0 ? next.start : next.start + next.length - 1e-4);
}

function lastClipBefore(t) {
    let best = null;
    for (const c of project.clips) if (c.start + c.length <= t + 1e-6) best = c;
    return best;
}

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
    applyAudio(viewer.activeClip());
    syncVolume();
    flash(transport.muted ? 'Muted' : 'Unmuted');
});

rateSel.addEventListener('change', () => {
    transport.rate = parseFloat(rateSel.value);
    applyAudio(viewer.activeClip());
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

    surface.addEventListener('mousedown', (e) => {
        dragging = true;
        // Dragging a playhead stops playback, the way every edit suite does.
        // It is also what keeps a drag cheap: while paused, a seek costs one
        // decode instead of also tearing down and refilling the audio ring.
        if (scrubs && transport.playing) { resume = true; pause(); }
        onFraction(fractionAt(e.clientX));
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => { if (dragging) onFraction(fractionAt(e.clientX)); });
    document.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        onFraction(fractionAt(e.clientX));
        if (resume) { resume = false; play(); }
    });
}

draggable(scrub, (f) => setPlayhead(f * duration()), { scrubs: true });
draggable(volume, (f) => {
    transport.volume = f;
    if (f > 0 && transport.muted) transport.muted = false;
    applyAudio(viewer.activeClip());
    syncVolume();
});

// ── the viewer: pan, zoom and crop the picture ─────────────────────────────

stage.addEventListener('wheel', (e) => {
    const c = project.selected;
    if (!c) return;
    c.xform.zoom = Math.max(0.05, Math.min(20, c.xform.zoom * (e.deltaY > 0 ? 1 / 1.1 : 1.1)));
    viewer.refresh(c);
    updateCropUI();
    showTransform(c);
    e.preventDefault();
});

// Dragging the picture pans it. In crop mode the same gesture on a handle
// trims an edge instead, which is why the handles sit above this.
{
    let pan = null;
    stage.addEventListener('mousedown', (e) => {
        const c = project.selected;
        if (!c || cropMode) return;
        pan = { x: e.clientX, y: e.clientY, px: c.xform.panX, py: c.xform.panY };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!pan) return;
        const c = project.selected;
        const s = viewer.stageSize();
        c.xform.panX = pan.px + (e.clientX - pan.x) / Math.max(1, s.w);
        c.xform.panY = pan.py + (e.clientY - pan.y) / Math.max(1, s.h);
        viewer.refresh(c);
        showTransform(c);
    });
    document.addEventListener('mouseup', () => { pan = null; });
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
    if (!cropMode || !c || !c.frame) { cropbox.classList.add('hidden'); return; }
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
    if (tag === 'SELECT' || tag === 'INPUT') return;

    switch (e.key) {
        case ' ':          togglePlay(); break;
        // Shift is a second of time, not a second's worth of frames: one seek
        // instead of `fps` of them, and it means the same thing.
        case 'ArrowLeft':  if (e.shiftKey) setPlayhead(transport.t - 1); else step(-1); break;
        case 'ArrowRight': if (e.shiftKey) setPlayhead(transport.t + 1); else step(1); break;
        case 'Home':       setPlayhead(0); break;
        case 'End':        setPlayhead(Math.max(0, duration() - 1e-4)); break;
        case 'j':          nudgeRate(-1); break;
        case 'k':          pause(); break;
        case 'l':          nudgeRate(1); break;
        case 'm':          btnMute.click(); break;
        case 'f':          toggleFullscreen(); break;
        case 'c':          setCropMode(!cropMode); break;
        case 'Delete':     removeSelected(); break;
        case '+': case '=': timeline.zoomBy(1 / 1.5, transport.t); break;
        case '-':          timeline.zoomBy(1.5, transport.t); break;
        case '0':          timeline.fitView(); break;
        case 'Escape':     if (cropMode) setCropMode(false);
                           else if (fullscreen) toggleFullscreen(); break;
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
    applyAudio(viewer.activeClip());
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
    for (const f of files) open(f.path || f.name);
});

// ── the frame loop ─────────────────────────────────────────────────────────

let lastTick = 0;
let lastViewerW = -1, lastViewerH = -1, lastLaneW = -1;

function frame(now) {
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;

    if (transport.playing) advance(dt);
    else adoptDecoderTime();

    // A panel that changed size (window resize, fullscreen) has to be redrawn
    // from the analysis rather than stretched — a stretched waveform lies
    // about where the sound is.
    if (viewerEl.clientWidth !== lastViewerW || viewerEl.clientHeight !== lastViewerH) {
        lastViewerW = viewerEl.clientWidth;
        lastViewerH = viewerEl.clientHeight;
        viewer.layout();
        updateCropUI();
    }
    if (el('film').clientWidth !== lastLaneW) {
        lastLaneW = el('film').clientWidth;
        timeline.draw();
    }
    if (transport.playing) syncUI();

    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/// A seek asks for a time; what comes back is the frame whose interval
/// contains it, which is generally a little earlier. The readout has to say
/// where the picture actually is — otherwise the timecode is a request rather
/// than a fact, and a frame step from a scrubbed position appears to move by
/// some odd fraction of a frame because the step really started somewhere else.
function adoptDecoderTime() {
    const clip = viewer.activeClip();
    if (!clip || !clip.video || !(clip.video.duration > 0)) return;
    const t = clip.start + clip.video.currentTime - clip.inPoint;
    if (Math.abs(t - transport.t) < 1e-6) return;
    transport.t = t;
    syncUI();
}

/// Where the playhead goes next. The active clip's own clock is the master
/// while it is playing — it is the thing that knows which picture is on
/// screen. A gap between clips has no clock of its own, so it runs on the
/// wall.
function advance(dt) {
    const d = duration();
    const clip = viewer.activeClip();

    if (clip) {
        const local = clip.video.currentTime - clip.inPoint;
        if (clip.video.ended || local >= clip.length - 1e-4) {
            handOver(clip.start + clip.length);
            return;
        }
        transport.t = clip.start + local;
    } else {
        transport.t += dt * transport.rate;
        if (clipAt(transport.t)) { setPlayhead(transport.t); return; }
    }

    if (transport.t >= d - 1e-6) { handOver(d); return; }
    if (timeline.revealTime(transport.t)) timeline.draw();
}

function handOver(t) {
    const d = duration();
    if (t >= d - 1e-6) {
        if (transport.loop) { setPlayhead(0); return; }
        pause();
        setPlayhead(Math.max(0, d - 1e-4));
        return;
    }
    setPlayhead(t);
}

// ── readouts ───────────────────────────────────────────────────────────────

function syncUI() {
    const t = transport.t;
    const d = duration();

    btnPlay.textContent = transport.playing ? '❙❙' : '▶';
    tcCurrent.textContent = timecode(t, project.fps);
    tcDuration.textContent = timecode(d, project.fps);

    const f = d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
    const pct = (f * 100).toFixed(3) + '%';
    scrubPlayed.style.width = pct;
    scrubHead.style.left = pct;
    timeline.setPlayhead(t);

    const n = project.clips.length;
    const waiting = pending();
    stats.textContent = n
        ? `${project.width}×${project.height}  ${n} clip${n === 1 ? '' : 's'}` +
          (waiting ? `  reading ${waiting}…` : '')
        : '';
}

function syncVolume() {
    const v = transport.muted ? 0 : transport.volume;
    volFill.style.width = (v * 100).toFixed(1) + '%';
    btnMute.textContent = transport.muted ? 'Mute' : 'Vol';
    btnMute.classList.toggle('on', transport.muted);
}
syncVolume();

// ── the inspector ──────────────────────────────────────────────────────────

function showClip(clip) {
    if (!clip) {
        filename.textContent = 'no media';
        filename.classList.add('dim');
        chips.innerHTML = '';
        mediaInfo.innerHTML = 'Nothing loaded.';
        mediaInfo.classList.add('dim', 'pad');
        xformPanel.innerHTML = '';
        cropbox.classList.add('hidden');
        return;
    }
    filename.textContent = clip.name;
    filename.classList.remove('dim');
    showChips(clip.probe);
    showInfo(clip.probe);
    showTransform(clip);
    updateCropUI();
}

function showChips(p) {
    const out = [];
    out.push(chip(p.format.name.split(',')[0], true));
    if (p.video) {
        out.push(chip(`${p.video.displayWidth}×${p.video.displayHeight}`));
        out.push(chip(p.video.codec));
        if (p.video.fps) out.push(chip(p.video.fps.toFixed(3) + ' fps'));
    }
    if (p.audio) out.push(chip(`${p.audio.codec} ${p.audio.channels}ch`));
    chips.innerHTML = out.join('');
}

function chip(text, hot) {
    return `<span class="chip${hot ? ' hot' : ''}">${escapeHtml(String(text))}</span>`;
}

function section(t) { return `<div class="section-head">${escapeHtml(t)}</div>`; }
function row(k, v) {
    return `<div class="row"><span class="key">${escapeHtml(k)}</span>` +
           `<span class="val">${escapeHtml(String(v))}</span></div>`;
}

function showInfo(p) {
    const parts = [];
    parts.push(section('Container'));
    parts.push(row('Format', p.format.longName || p.format.name));
    parts.push(row('Duration', clock(p.format.duration)));
    parts.push(row('Size', bytes(p.format.size)));
    parts.push(row('Bitrate', p.format.bitRate ? kbps(p.format.bitRate) : '—'));
    parts.push(row('Streams', String(p.streams.length)));

    for (const s of p.streams) {
        const label = `${s.kind} #${s.index}` + (s.language ? ` · ${s.language}` : '');
        parts.push(section(label));
        parts.push(row('Codec', s.codecLong || s.codec));
        if (s.profile) parts.push(row('Profile', s.profile));
        if (s.duration) parts.push(row('Duration', s.duration.toFixed(3) + ' s'));
        if (s.kind === 'video') {
            parts.push(row('Size', `${s.width}×${s.height}` +
                (s.rotation ? ` → ${s.displayWidth}×${s.displayHeight} (${s.rotation}°)` : '')));
            parts.push(row('Frame rate', s.fps ? s.fps.toFixed(3) + ' fps' : '—'));
            parts.push(row('Pixels', s.pixFmt || '—'));
            if (s.sampleAspect && Math.abs(s.sampleAspect - 1) > 0.001)
                parts.push(row('Pixel AR', s.sampleAspect.toFixed(4)));
        } else if (s.kind === 'audio') {
            parts.push(row('Rate', s.sampleRate + ' Hz'));
            parts.push(row('Channels', `${s.channels} (${s.channelLayout || 'unknown'})`));
            parts.push(row('Samples', s.sampleFmt || '—'));
        }
        if (s.bitRate) parts.push(row('Bitrate', kbps(s.bitRate)));
        if (s.title) parts.push(row('Title', s.title));
    }

    mediaInfo.classList.remove('dim', 'pad');
    mediaInfo.innerHTML = parts.join('');
}

// The transform panel is rebuilt from the clip rather than kept in sync field
// by field: it is a dozen elements, and a panel that can disagree with the
// picture is worse than one that is redrawn.
function showTransform(clip) {
    if (!clip) { xformPanel.innerHTML = ''; return; }
    const x = clip.xform, c = x.crop;
    const pc = (v) => (v * 100).toFixed(1);
    const fitBtn = (id, label) =>
        `<button class="tiny${x.fit === id ? ' on' : ''}" data-fit="${id}">${label}</button>`;

    xformPanel.innerHTML =
        section('Canvas') +
        `<div class="row"><span class="key">Size</span><span class="val">` +
        `<input class="num" id="pw" type="number" value="${project.width}" min="16" max="16384">` +
        ` × <input class="num" id="ph" type="number" value="${project.height}" min="16" max="16384">` +
        `</span></div>` +
        `<div class="row"><span class="key"></span><span class="val btns">` +
        `<button class="tiny" data-canvas="source">Match clip</button>` +
        `<button class="tiny" data-canvas="1920x1080">1080p</button>` +
        `<button class="tiny" data-canvas="1080x1920">Vertical</button>` +
        `<button class="tiny" data-canvas="3840x2160">4K</button>` +
        `</span></div>` +

        section('Transform · ' + clip.name) +
        `<div class="row"><span class="key">Fit</span><span class="val btns">` +
        fitBtn('contain', 'Fit') + fitBtn('cover', 'Fill') +
        fitBtn('stretch', 'Stretch') + fitBtn('actual', '1:1') +
        `</span></div>` +
        `<div class="row"><span class="key">Scale</span><span class="val btns">` +
        `<input id="zoom" type="range" min="5" max="400" value="${Math.round(x.zoom * 100)}">` +
        `<span id="zoomval" class="mono dim">${Math.round(x.zoom * 100)}%</span></span></div>` +
        `<div class="row"><span class="key">Position</span><span class="val btns">` +
        `<span class="mono dim">${pc(x.panX)}%, ${pc(x.panY)}%</span>` +
        `<button class="tiny" data-reset="pan">Reset</button>` +
        `</span></div>` +

        section('Crop') +
        `<div class="row"><span class="key">Left / Top</span><span class="val btns">` +
        `<input class="num" id="cl" type="number" value="${pc(c.l)}" min="0" max="95" step="0.5">` +
        `<input class="num" id="ct" type="number" value="${pc(c.t)}" min="0" max="95" step="0.5">` +
        `</span></div>` +
        `<div class="row"><span class="key">Right / Bot</span><span class="val btns">` +
        `<input class="num" id="cr" type="number" value="${pc(c.r)}" min="0" max="95" step="0.5">` +
        `<input class="num" id="cb" type="number" value="${pc(c.b)}" min="0" max="95" step="0.5">` +
        `</span></div>` +
        `<div class="row"><span class="key"></span><span class="val btns">` +
        `<button class="tiny${cropMode ? ' on' : ''}" data-crop="handles">Handles (C)</button>` +
        `<button class="tiny" data-reset="crop">Reset</button>` +
        `</span></div>`;

    wireTransform(clip);
}

function wireTransform(clip) {
    const x = clip.xform;
    const apply = () => { viewer.refresh(clip); updateCropUI(); };

    for (const b of xformPanel.querySelectorAll('button[data-fit]'))
        b.addEventListener('click', () => {
            x.fit = b.getAttribute('data-fit');
            apply(); showTransform(clip);
        });

    for (const b of xformPanel.querySelectorAll('button[data-canvas]')) {
        b.addEventListener('click', () => {
            const v = b.getAttribute('data-canvas');
            if (v === 'source') { project.width = clip.width; project.height = clip.height; }
            else {
                const [w, h] = v.split('x').map(Number);
                project.width = w; project.height = h;
            }
            viewer.layout(); updateCropUI(); showTransform(clip); syncUI();
        });
    }

    const zoom = el('zoom');
    if (zoom) zoom.addEventListener('input', () => {
        x.zoom = Math.max(0.05, Number(zoom.value) / 100);
        apply();
        // Only the readout, not the whole panel: rebuilding it mid-drag would
        // replace the slider under the pointer.
        el('zoomval').textContent = `${Math.round(x.zoom * 100)}%`;
    });

    const size = () => {
        const w = Number(el('pw').value), h = Number(el('ph').value);
        if (w >= 16 && h >= 16) { project.width = w; project.height = h; viewer.layout(); updateCropUI(); syncUI(); }
    };
    for (const id of ['pw', 'ph']) {
        const f = el(id);
        if (f) f.addEventListener('change', size);
    }

    const crops = { cl: 'l', ct: 't', cr: 'r', cb: 'b' };
    for (const id of Object.keys(crops)) {
        const f = el(id);
        if (!f) continue;
        f.addEventListener('change', () => {
            x.crop[crops[id]] = Math.max(0, Math.min(0.95, Number(f.value) / 100));
            apply();
        });
    }

    for (const b of xformPanel.querySelectorAll('button[data-reset]'))
        b.addEventListener('click', () => {
            if (b.getAttribute('data-reset') === 'pan') { x.panX = x.panY = 0; x.zoom = 1; }
            else x.crop = { l: 0, t: 0, r: 0, b: 0 };
            apply(); showTransform(clip);
        });

    const handles = xformPanel.querySelector('button[data-crop]');
    if (handles) handles.addEventListener('click', () => setCropMode(!cropMode));
}

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

function flash(message) {
    osd.textContent = message;
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.add('hidden'), 1400);
}

// Tests drive the app through this rather than reaching for a DOM id that
// only exists while one particular clip is selected.
globalThis.__ffmpegBro = {
    project, transport, resolveOverlaps,
    open, removeSelected,
    video: () => { const c = viewer.activeClip(); return c ? c.video : null; },
    activeClip: () => viewer.activeClip(),
    setPlayhead, play, pause, step,
    timeline, viewer,
    setCropMode, cropMode: () => cropMode,
};
globalThis.__ffmpegBroReady = true;
