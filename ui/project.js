// What is on the timeline.
//
// One video track. A clip is a file placed at a time, with a geometry saying
// how its picture sits inside the output canvas. Everything else in the app
// reads this and nothing else: the viewer draws whichever clip the playhead is
// inside, the timeline draws them all, the inspector edits the selected one.

import { basename } from './format.js';

export const project = {
    clips: [],              // sorted by start
    selected: null,
    // Output canvas. Seeded from the first clip so a single file behaves the
    // way it always did, then editable — that is what "resize the canvas"
    // means here, and it is why a portrait phone capture and a 16:9 clip can
    // share one timeline without one of them being wrong.
    width: 0,
    height: 0,
    fps: 25,
};

const listeners = [];

/// Subscribe to any change to the model. Coarse on purpose: the redraws it
/// triggers are a ruler, two canvases and a handful of style writes.
export function onChange(fn) { listeners.push(fn); }

export function changed(what) {
    for (const fn of listeners) fn(what);
}

let nextId = 1;

/// A clip's default geometry: the whole picture, fitted inside the canvas.
function defaultTransform() {
    return {
        fit: 'contain',                     // contain | cover | stretch | actual
        zoom: 1,
        panX: 0, panY: 0,                   // fractions of the canvas
        crop: { l: 0, t: 0, r: 0, b: 0 },   // fractions cut off each edge
    };
}

export function makeClip(path, probe) {
    // The video track's own duration, not the container's. They differ — an
    // audio track routinely runs a fraction of a second past the last picture
    // — and it is the pictures that decide how long a clip is.
    const length = (probe.video && probe.video.duration) || probe.format.duration || 0;
    return {
        id: nextId++,
        path,
        name: basename(path),
        probe,
        start: 0,
        inPoint: 0,
        length,
        media: length,
        width: probe.video ? probe.video.displayWidth : 0,
        height: probe.video ? probe.video.displayHeight : 0,
        fps: (probe.video && probe.video.fps) || 25,
        xform: defaultTransform(),
        peaks: null,        // { buckets, min, max, rms, duration } once analysed
        film: null,         // { bitmap, width, height, count, times }
        video: null,        // the <video> element, owned by the viewer
        frame: null,        // its crop window, owned by the viewer
        ready: false,
    };
}

function sort() { project.clips.sort((a, b) => a.start - b.start || a.id - b.id); }

export function addClip(clip, atEnd = true) {
    clip.start = atEnd ? duration() : 0;
    project.clips.push(clip);
    sort();
    if (!project.width && clip.width) {
        project.width = clip.width;
        project.height = clip.height;
    }
    if (project.clips.length === 1) project.fps = clip.fps;
    return clip;
}

export function removeClip(clip) {
    const i = project.clips.indexOf(clip);
    if (i < 0) return false;
    project.clips.splice(i, 1);
    if (project.selected === clip) project.selected = project.clips[Math.min(i, project.clips.length - 1)] || null;
    return true;
}

export function moveClip(clip, start) {
    clip.start = Math.max(0, start);
    sort();
}

/// Make room for a clip that was just dropped somewhere.
///
/// Two clips overlapping on one track has no answer to "which one is the
/// playhead inside", so the dropped clip keeps where it landed and anything it
/// covers slides out of the way, cascading. Clips that were already clear stay
/// exactly where they were — a drop at the end of the timeline moves nothing.
///
/// This is also what makes reordering work: drag the second clip in front of
/// the first and the first is pushed behind it.
export function resolveOverlaps(moved) {
    let edge = moved.start + moved.length;
    for (const c of project.clips.slice().sort((a, b) => a.start - b.start)) {
        if (c === moved) continue;
        if (c.start + c.length <= moved.start + 1e-6) continue;   // wholly before
        if (c.start >= edge - 1e-6) { edge = Math.max(edge, c.start + c.length); continue; }
        c.start = edge;
        edge = c.start + c.length;
    }
    sort();
}

export function duration() {
    let d = 0;
    for (const c of project.clips) d = Math.max(d, c.start + c.length);
    return d;
}

/// The clip the playhead is inside, or null in a gap. Ends are exclusive so a
/// playhead exactly on a boundary belongs to the clip that starts there.
export function clipAt(t) {
    for (const c of project.clips)
        if (t >= c.start && t < c.start + c.length) return c;
    return null;
}

export function nextClipAfter(t) {
    for (const c of project.clips) if (c.start > t) return c;
    return null;
}

/// Source time inside a clip's file for a timeline time.
export function sourceTime(clip, t) {
    return clip.inPoint + (t - clip.start);
}

export function select(clip) {
    if (project.selected === clip) return;
    project.selected = clip;
    changed('selection');
}
