// ffmpeg-bro — wiring the UI to the tools and the player.

import { locateTools } from '/app/src/ffmpeg.js';
import { Player } from '/app/src/player.js';

const el = (id) => document.getElementById(id);
const toolStatus = el('toolstatus');
const dropzone = el('dropzone');
const canvas = el('video');
const details = el('details');
const mediaInfo = el('mediainfo');
const playPause = el('playpause');
const scrub = el('scrub');
const timecode = el('timecode');

let tools = null;
let player = null;
let scrubbing = false;

// ── startup ────────────────────────────────────────────────────────────────

tools = await locateTools();
if (!tools.ok) {
    toolStatus.textContent = tools.error;
    toolStatus.classList.add('bad');
} else {
    const f = tools.ffmpeg;
    const accel = Object.entries(f.encoders)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .join(', ');
    toolStatus.textContent = `ffmpeg ${f.version}${f.gpl ? ' (GPL)' : ''} — ${accel}`;
    toolStatus.classList.add('good');

    player = new Player({ tools, canvas, audio: new AudioContext() });
    player.onstatus = (m) => { toolStatus.textContent = m; toolStatus.classList.add('bad'); };
    player.onended = () => syncTransport();
}

// ── opening a file ─────────────────────────────────────────────────────────

async function openFile(path) {
    if (!player) return;
    try {
        toolStatus.classList.remove('bad');
        const info = await player.open(path);
        showInfo(info);
        dropzone.classList.add('hidden');
        canvas.classList.add('loaded');
        details.classList.remove('hidden');
        playPause.disabled = false;
        scrub.disabled = false;
        syncTransport();
    } catch (e) {
        toolStatus.textContent = e.message;
        toolStatus.classList.add('bad');
    }
}

function showInfo(info) {
    const rows = [
        ['File', info.name],
        ['Container', info.format.longName || info.format.name],
        ['Duration', formatTime(info.format.duration)],
        ['Size', formatBytes(info.format.size)],
        ['Bitrate', info.format.bitRate ? Math.round(info.format.bitRate / 1000) + ' kbps' : '—'],
    ];
    if (info.video) {
        rows.push(['Video', `${info.video.codec} ${info.video.profile} · ` +
                            `${info.video.width}×${info.video.height} · ` +
                            `${info.video.fps.toFixed(3)} fps · ${info.video.pixFmt}` +
                            (info.video.rotation ? ` · rotated ${info.video.rotation}°` : '')]);
    }
    if (info.audio) {
        rows.push(['Audio', `${info.audio.codec} · ${info.audio.channels} ch ` +
                            `(${info.audio.layout || 'unknown layout'}) · ` +
                            `${info.audio.sampleRate} Hz`]);
    }
    mediaInfo.innerHTML = rows
        .map(([k, v]) => `<div class="row"><span class="key">${k}</span>` +
                         `<span class="val">${escapeHtml(String(v))}</span></div>`)
        .join('');
}

// ── transport ──────────────────────────────────────────────────────────────

playPause.addEventListener('click', () => {
    if (!player || !player.info) return;
    if (player.playing) player.pause();
    else player.play();
    syncTransport();
});

// Scrubbing pauses the feeds while the thumb moves and seeks once, on release:
// respawning ffmpeg for every intermediate value would queue up dozens of
// processes to answer a question the user already moved past.
scrub.addEventListener('input', () => {
    if (!player || !player.info) return;
    scrubbing = true;
    const t = (scrub.value / 1000) * player.duration;
    timecode.textContent = `${formatTime(t)} / ${formatTime(player.duration)}`;
});
scrub.addEventListener('change', () => {
    if (!player || !player.info) return;
    player.seek((scrub.value / 1000) * player.duration);
    scrubbing = false;
    syncTransport();
});

function syncTransport() {
    if (!player || !player.info) return;
    playPause.textContent = player.playing ? 'Pause' : 'Play';
    if (!scrubbing) {
        scrub.value = player.duration ? (player.time / player.duration) * 1000 : 0;
    }
    timecode.textContent = `${formatTime(player.time)} / ${formatTime(player.duration)}`;
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
    if (files && files.length) openFile(files[0].path || files[0].name);
});

// A file named on the command line, for `bro . some-clip.mp4`.
if (globalThis.scriptArgs && globalThis.scriptArgs.length) {
    openFile(globalThis.scriptArgs[globalThis.scriptArgs.length - 1]);
}

// ── the frame loop ─────────────────────────────────────────────────────────

function frame() {
    if (player) {
        player.tick();
        if (player.playing) syncTransport();
    }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── formatting ─────────────────────────────────────────────────────────────

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatBytes(n) {
    if (!n) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
}

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
