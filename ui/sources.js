// What is actually in the files.
//
// The first stage of the pipeline, and the thing this binary is uniquely quick
// at: probe() is in-process, so the answer is already here by the time a clip
// reaches the timeline and nothing has to be shelled out to or waited for.
//
// **It reads every source, not the selected one.** This was the inspector's
// Media panel until the spine made it a stage, and a panel hanging off the
// selection could only ever describe one file — which is right for a sidebar
// beside a clip's properties and wrong for a stage whose own card in the spine
// says "3 files · 7 streams". A stage that counts three and shows one is
// asking to be disbelieved.
//
// Distinct by path, in the order the timeline first uses them: two clips cut
// from the same file are two clips and one source, and ffmpeg would open it
// once.

import { project } from './project.js';
import { div, span, put, row, head } from './dom.js';
import { clock, bytes, kbps, basename } from './format.js';

let host = null;

export function initSources(node) {
    host = node;
}

/// Every file on the timeline, once each, with how many clips came out of it.
function sources() {
    const byPath = new Map();
    for (const c of project.clips) {
        const at = byPath.get(c.path);
        if (at) at.clips++;
        else byPath.set(c.path, { path: c.path, probe: c.probe, clips: 1 });
    }
    return Array.from(byPath.values());
}

export function drawSources() {
    if (!host) return;
    const list = sources();
    host.classList.toggle('dim', !list.length);
    host.classList.toggle('pad', !list.length);
    if (!list.length) return put(host, () => 'Nothing loaded.');

    put(host, () => list.map((s) => div('source', [
        div('source-head', [
            span(basename(s.path), 'source-name'),
            span(s.clips === 1 ? '1 clip' : `${s.clips} clips`, 'dim'),
        ]),
        // The whole path, dimmed and under the name: it is what -i would be
        // given, and it is the only thing on this stage that distinguishes two
        // files with the same name.
        div('source-path dim', s.path),
        ...(s.probe ? fileRows(s.probe) : [div('dim', 'this file could not be read')]),
    ])));
}

function fileRows(p) {
    return [
        head('Container'),
        row('Format', p.format.longName || p.format.name),
        row('Duration', clock(p.format.duration)),
        row('Size', bytes(p.format.size)),
        row('Bitrate', p.format.bitRate ? kbps(p.format.bitRate) : '—'),
        row('Streams', String(p.streams.length)),
        ...p.streams.map(streamRows),
    ];
}

/// One stream, in the terms that stream is described in. Kept verbatim from
/// probe(): "Untagged" and "BT.601" are different facts, and this is the screen
/// where the difference is the point.
function streamRows(s) {
    const rows = [
        head(`${s.kind} #${s.index}` + (s.language ? ` · ${s.language}` : '')),
        row('Codec', s.codecLong || s.codec),
        s.profile && row('Profile', s.profile),
        s.duration && row('Duration', s.duration.toFixed(3) + ' s'),
    ];
    if (s.kind === 'video') {
        rows.push(row('Size', `${s.width}×${s.height}` +
            (s.rotation ? ` → ${s.displayWidth}×${s.displayHeight} (${s.rotation}°)` : '')));
        rows.push(row('Frame rate', s.fps ? s.fps.toFixed(3) + ' fps' : '—'));
        rows.push(row('Pixels', s.pixFmt || '—'));
        if (s.sampleAspect && Math.abs(s.sampleAspect - 1) > 0.001)
            rows.push(row('Pixel AR', s.sampleAspect.toFixed(4)));
        // What the render has to convert out of, and the reason the filtergraph
        // can be written faithfully at all — worth 13 dB, and invisible
        // everywhere else in the application.
        if (s.colorSpace || s.colorRange)
            rows.push(row('Colour', [s.colorSpace || 'untagged',
                                     s.colorRange || 'range untagged'].join(' · ')));
    } else if (s.kind === 'audio') {
        rows.push(row('Rate', s.sampleRate + ' Hz'));
        rows.push(row('Channels', `${s.channels} (${s.channelLayout || 'unknown'})`));
        rows.push(row('Samples', s.sampleFmt || '—'));
    }
    if (s.bitRate) rows.push(row('Bitrate', kbps(s.bitRate)));
    if (s.title) rows.push(row('Title', s.title));
    return rows;
}
