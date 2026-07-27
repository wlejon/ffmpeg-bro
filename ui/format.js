// Turning numbers into the strings an edit suite shows.

export function pad(n) { return String(n).padStart(2, '0'); }

export function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// HH:MM:SS:FF — the frame-count form, so a frame step is visibly one unit.
export function timecode(seconds, fps) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    if (!fps || !isFinite(fps)) fps = 25;
    const total = Math.floor(seconds);
    const frames = Math.floor((seconds - total) * fps);
    return `${clock(total)}:${pad(Math.min(frames, Math.ceil(fps) - 1))}`;
}

// A ruler label: drop the hours until there are some, and show tenths once
// the zoom is deep enough that whole seconds all read the same.
export function rulerLabel(seconds, spanSec) {
    const neg = seconds < 0;
    const t = Math.abs(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    // Sub-second digits only once whole seconds would all read the same:
    // "0:02.0" everywhere is noise when the window is half a minute wide.
    const fine = spanSec < 2 ? 2 : spanSec < 12 ? 1 : 0;
    const sub = fine ? s.toFixed(fine) : pad(Math.floor(s));
    const lead = fine && s < 10 ? '0' : '';
    const body = h > 0 ? `${h}:${pad(m)}:${lead}${sub}` : `${m}:${lead}${sub}`;
    return (neg ? '-' : '') + body;
}

// How long something took, rather than where it is on a timeline. clock() is
// the wrong shape for this: a render that took a quarter of a second reads as
// "00:00:00", which looks like it did not run.
export function elapsed(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    if (seconds < 10) return seconds.toFixed(1) + ' s';
    if (seconds < 60) return Math.round(seconds) + ' s';
    return clock(seconds);
}

export function kbps(bits) { return Math.round(bits / 1000) + ' kbps'; }

export function bytes(n) {
    if (!n) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
}

export function basename(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}
