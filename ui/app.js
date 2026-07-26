// ffmpeg-bro — the player surface.
//
// Everything here drives a plain <video> element. There is no subprocess, no
// pipe and no proxy file: libavcodec is linked into this binary and registered
// as a bro media backend, so the engine decodes the real stream and hands the
// frames straight to the renderer. That is why the transport can be
// frame-accurate and why seeking is instant.

const el = (id) => document.getElementById(id);

const video     = el('player');
const viewer    = el('viewer');
const dropzone  = el('dropzone');
const osd       = el('osd');
const filename  = el('filename');
const chips     = el('chips');
const libav     = el('libav');
const mediaInfo = el('mediainfo');
const stats     = el('stats');

const tcCurrent = el('tc-current');
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

const volume  = el('volume');
const volFill = el('vol-fill');

const timeline = el('timeline');
const ruler    = el('ruler');
const clipBox  = el('clip');
const clipLabel = el('clip-label');
const playhead = el('playhead');

// ── state ──────────────────────────────────────────────────────────────────

let info = null;        // bro.ffmpeg.probe() result for the open file
let fps = 25;           // frame rate, for frame stepping and timecode
let loaded = false;
let fullscreen = false;
let osdTimer = 0;

// ── startup ────────────────────────────────────────────────────────────────

libav.textContent = bro.ffmpeg.version;
video.volume = 1;

// A file named on the command line, handed over by the host binding.
if (bro.ffmpeg.openOnStart) open(bro.ffmpeg.openOnStart);

// ── opening ────────────────────────────────────────────────────────────────

function open(path) {
    let probe;
    try {
        probe = bro.ffmpeg.probe(path);
    } catch (e) {
        fail(String(e.message || e));
        return;
    }
    if (!probe.video && !probe.audio) {
        fail('no audio or video track in this file');
        return;
    }
    if (!probe.video) {
        // bro's <video> drives its clock from decoded pictures, so a track
        // list with no video has nothing to advance. Say so instead of
        // loading something that will sit at 0:00 forever.
        showInfo(probe);
        showChips(probe);
        filename.textContent = basename(path);
        fail('audio-only files are not playable yet — this needs a video track');
        return;
    }

    info = probe;
    fps = (probe.video && probe.video.fps) || 25;

    // Assigning src loads it; an explicit load() here would open the file a
    // second time and throw the first decode away.
    video.src = path;

    filename.textContent = basename(path);
    filename.classList.remove('dim');
    dropzone.classList.add('hidden');
    video.classList.add('loaded');
    clipBox.classList.add('loaded');
    clipLabel.textContent = basename(path);

    showChips(probe);
    showInfo(probe);
    loaded = true;
    setControlsEnabled(true);
    buildRuler(probe.format.duration);
    sync();
}

function fail(message) {
    loaded = false;
    setControlsEnabled(false);
    filename.textContent = message;
    filename.classList.remove('dim');
    chips.innerHTML = '';
    flash(message);
}

function basename(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}

// ── inspector ──────────────────────────────────────────────────────────────

function showChips(p) {
    const out = [];
    out.push(chip(p.format.name.split(',')[0], true));
    if (p.video) {
        out.push(chip(`${p.video.displayWidth}×${p.video.displayHeight}`));
        out.push(chip(p.video.codec));
        if (p.video.fps) out.push(chip(p.video.fps.toFixed(3) + ' fps'));
    }
    if (p.audio) {
        out.push(chip(`${p.audio.codec} ${p.audio.channels}ch`));
    }
    chips.innerHTML = out.join('');
}

function chip(text, hot) {
    return `<span class="chip${hot ? ' hot' : ''}">${escapeHtml(String(text))}</span>`;
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

function section(t) { return `<div class="section-head">${escapeHtml(t)}</div>`; }
function row(k, v) {
    return `<div class="row"><span class="key">${escapeHtml(k)}</span>` +
           `<span class="val">${escapeHtml(String(v))}</span></div>`;
}

// ── transport ──────────────────────────────────────────────────────────────

function setControlsEnabled(on) {
    for (const b of [btnStart, btnPrev, btnPlay, btnNext, btnEnd, btnLoop, btnMute])
        b.disabled = !on;
    rateSel.disabled = !on;
}
setControlsEnabled(false);

function togglePlay() {
    if (!loaded) return;
    if (video.paused) video.play();
    else video.pause();
    sync();
}

// Frame stepping pauses first: nudging while running would race the clock and
// land somewhere the user did not ask for.
function step(frames) {
    if (!loaded) return;
    if (!video.paused) video.pause();
    seek(video.currentTime + frames / fps);
}

function seek(seconds) {
    if (!loaded) return;
    const d = video.duration || 0;
    video.currentTime = Math.max(0, Math.min(d, seconds));
    sync();
}

btnPlay.addEventListener('click', togglePlay);
btnStart.addEventListener('click', () => seek(0));
btnEnd.addEventListener('click', () => seek((video.duration || 0) - 1 / fps));
btnPrev.addEventListener('click', () => step(-1));
btnNext.addEventListener('click', () => step(1));

btnLoop.addEventListener('click', () => {
    video.loop = !video.loop;
    btnLoop.classList.toggle('on', video.loop);
    flash(video.loop ? 'Loop on' : 'Loop off');
});

btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    syncVolume();
    flash(video.muted ? 'Muted' : 'Unmuted');
});

rateSel.addEventListener('change', () => {
    video.playbackRate = parseFloat(rateSel.value);
    flash(rateSel.value + '×');
});

btnFull.addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
    fullscreen = !fullscreen;
    document.body.classList.toggle('fs', fullscreen);
    bro.settings.set('graphics.fullscreen', fullscreen);
}

// ── dragging the scrubber, the timeline and the volume ─────────────────────
//
// One helper for all three: press anywhere on the surface to jump there, then
// keep tracking while the button is held even if the pointer leaves the
// element.
function draggable(surface, onFraction, opts) {
    let dragging = false;
    const scrubs = opts && opts.scrubs;
    let resumeAfter = false;

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
        if (scrubs && !video.paused) { resumeAfter = true; video.pause(); }
        onFraction(fractionAt(e.clientX), false);
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (dragging) onFraction(fractionAt(e.clientX), false);
    });
    document.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        onFraction(fractionAt(e.clientX), true);
        if (resumeAfter) { resumeAfter = false; video.play(); }
        sync();
    });
}

draggable(scrub, (f) => seek(f * (video.duration || 0)), { scrubs: true });
draggable(timeline, (f) => seek(f * (video.duration || 0)), { scrubs: true });
draggable(volume, (f) => {
    video.volume = f;
    if (f > 0 && video.muted) video.muted = false;
    syncVolume();
});

// ── keyboard ───────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Let the speed dropdown keep its own arrow keys.
    if (e.target && e.target.tagName === 'SELECT') return;

    switch (e.key) {
        case ' ':          togglePlay(); break;
        case 'ArrowLeft':  step(e.shiftKey ? -fps : -1); break;
        case 'ArrowRight': step(e.shiftKey ?  fps :  1); break;
        case 'Home':       seek(0); break;
        case 'End':        seek((video.duration || 0) - 1 / fps); break;
        case 'j':          nudgeRate(-1); break;
        case 'k':          if (!video.paused) video.pause(); sync(); break;
        case 'l':          nudgeRate(1); break;
        case 'm':          btnMute.click(); break;
        case 'f':          toggleFullscreen(); break;
        case 'Escape':     if (fullscreen) toggleFullscreen(); break;
        default: return;
    }
    e.preventDefault();
});

// J/L shuttle: each press moves one step through the speed list, playing
// forward. (Reverse playback needs backwards decode, which is a later job.)
const RATES = [0.25, 0.5, 1, 1.5, 2, 4];
function nudgeRate(dir) {
    if (!loaded) return;
    let i = RATES.indexOf(video.playbackRate);
    if (i < 0) i = RATES.indexOf(1);
    i = Math.max(0, Math.min(RATES.length - 1, i + dir));
    video.playbackRate = RATES[i];
    rateSel.value = String(RATES[i]);
    if (video.paused) video.play();
    flash(RATES[i] + '×');
    sync();
}

// ── drag and drop ──────────────────────────────────────────────────────────

document.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
});
document.addEventListener('dragleave', () => dropzone.classList.remove('over'));
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) open(files[0].path || files[0].name);
});

// ── the frame loop ─────────────────────────────────────────────────────────

video.addEventListener('loadedmetadata', () => { sync(); syncVolume(); });
video.addEventListener('ended', sync);
video.addEventListener('timeupdate', sync);

function sync() {
    const t = video.currentTime || 0;
    const d = video.duration || 0;

    btnPlay.textContent = video.paused ? '▶' : '❙❙';
    tcCurrent.textContent = timecode(t);
    tcDuration.textContent = timecode(d);

    const f = d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
    const pct = (f * 100).toFixed(3) + '%';
    scrubPlayed.style.width = pct;
    scrubHead.style.left = pct;
    playhead.style.left = pct;

    if (loaded && info) {
        stats.textContent =
            `${info.video ? info.video.displayWidth + '×' + info.video.displayHeight : 'audio only'}` +
            `  ${fps ? fps.toFixed(2) + 'fps' : ''}`;
    }
}

function syncVolume() {
    const v = video.muted ? 0 : video.volume;
    volFill.style.width = (v * 100).toFixed(1) + '%';
    btnMute.textContent = video.muted ? 'Mute' : 'Vol';
    btnMute.classList.toggle('on', video.muted);
}
syncVolume();

function frame() {
    if (loaded && !video.paused) sync();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── timeline ruler ─────────────────────────────────────────────────────────

function buildRuler(duration) {
    ruler.innerHTML = '';
    if (!duration || duration <= 0) return;

    // Pick a tick spacing that lands on a round number and leaves the labels
    // readable at any zoom the window happens to be.
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const want = duration / 10;
    const stepSec = steps.find((s) => s >= want) || steps[steps.length - 1];

    let html = '';
    for (let t = 0; t <= duration; t += stepSec) {
        html += `<div class="tick" style="left:${((t / duration) * 100).toFixed(3)}%">` +
                `${clock(t)}</div>`;
    }
    ruler.innerHTML = html;
}

// ── formatting ─────────────────────────────────────────────────────────────

// HH:MM:SS:FF — the frame-count form an edit suite uses, so a frame step is
// visibly one unit.
function timecode(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const frames = Math.floor((seconds - total) * fps);
    return `${clock(total)}:${pad(Math.min(frames, Math.ceil(fps) - 1))}`;
}

function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function kbps(bits) { return Math.round(bits / 1000) + ' kbps'; }

function bytes(n) {
    if (!n) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
}

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function flash(message) {
    osd.textContent = message;
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.add('hidden'), 1200);
}

// Tests poll for this rather than guessing when the module finished: app.js
// has top-level statements, so listeners are not registered until it ends.
globalThis.__ffmpegBroReady = true;
