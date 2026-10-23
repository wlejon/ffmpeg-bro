// What is on the timeline.
//
// A stack of video tracks. A clip is a file placed at a time on a track, with a
// geometry saying how its picture sits inside the output canvas and how opaque
// it is. Everything else in the app reads this and nothing else: the viewer
// draws every clip the playhead is inside, bottom track first; the timeline
// draws them all in their lanes; the properties panel edits the selection.
//
// **A generator is a clip, not a fourth kind of thing.** A `testsrc` or a
// `color` laid out here carries a *generator spec* — a filter name and its
// options — where a clip of a file carries an input and a path, and everything
// else about it is a clip's: a track, a start, a length, in and out points,
// selection, overlap resolution, ripple, the sync lock, and its place in
// `clipsAt()`'s paint order. The alternative was a parallel list of generators
// with a lane of their own, and the objection to it is that every one of those
// nine things would have to be written a second time — and the second copy is
// where they drift apart. See `makeGenerator` for what the two sources have in
// common and `isGenerator` for the three places the difference is real.
//
// **A track is not a thing here; it is a number a clip carries.** There is no
// list of tracks and no "add track" button — `trackCount()` derives how many
// lanes there are from the clips that exist, and dragging a clip into the spare
// lane at the top is the whole gesture for making one. `trackSettings` below is
// the one thing a track has of its own, and it is written so as not to become a
// second answer to that question.

import { basename } from './format.js';
import {
    bindProjectCore,
    SPEED_MIN, SPEED_MAX, speedOf, sourceSpan, sourceTime, timelineTime, setSpeed,
    selectFollow, select, selectMany, isSelected, deselect,
    splitClip, trimClip, rippleTrim, rollCut, rateStretch, slipClip,
} from './project-edits.js';

export {
    SPEED_MIN, SPEED_MAX, speedOf, sourceSpan, sourceTime, timelineTime, setSpeed,
    selectFollow, select, selectMany, isSelected,
    splitClip, trimClip, rippleTrim, rollCut, rateStretch, slipClip,
};

/// How many video tracks there can be, which is a fact about this file and was
/// written out at four points of use — `trackCount`'s cap, `moveClip`'s clamp,
/// the document reader's clamp on a saved clip, and the loop that writes the
/// per-track settings out. Four copies of a ceiling is four chances for a clip
/// to be clamped onto a lane the timeline never draws.
export const TRACK_LIMIT = 8;

export const project = {
    clips: [],              // sorted by track, then start
    selection: [],          // clips, in the order they were picked
    selected: null,         // the primary — the last one picked
    // Settings for a track, for the tracks any have been set on. See the sync
    // lock section below: a bag keyed by track number, sparse on purpose, and
    // deliberately **not** a list of tracks.
    trackSettings: {},
    // Output canvas. Seeded from the first clip so a single file behaves the
    // way it always did, then editable — that is what "resize the canvas"
    // means here, and it is why a portrait phone capture and a 16:9 clip can
    // share one timeline without one of them being wrong.
    width: 0,
    height: 0,
    fps: 25,
    // 'stack' composites the tracks over each other, bottom to top. 'grid'
    // ignores each clip's placement and gives every clip an equal cell — for
    // looking through a morning's recordings at once rather than editing.
    layout: 'stack',
};

/// The rate the *timeline* runs at, which is not the rate the render comes out
/// at.
export function projectFps() { return project.fps || 25; }

/// How long the media behind a clip is, out of a probe.
function mediaLength(probe) {
    if (!probe) return 0;
    return (probe.video && probe.video.duration) || probe.format.duration || 0;
}

/// Is this clip a generator rather than a cut of a file?
export function isGenerator(clip) { return !!(clip && clip.generator); }

/// Does this clip put anything on the canvas?
export function hasPicture(clip) {
    return !!(clip && clip.probe && clip.probe.video);
}

const listeners = [];

/// Subscribe to any change to the model. Coarse on purpose: the redraws it
/// triggers are a ruler, a few canvases and a handful of style writes.
export function onChange(fn) { listeners.push(fn); }

export function changed(what) {
    for (const fn of listeners) fn(what);
}

let nextId = 1;

bindProjectCore({
    project,
    sort: () => sort(),
    changed: (what) => changed(what),
    isGenerator: (clip) => isGenerator(clip),
    ripplesWith: (track) => ripplesWith(track),
    allocateId: () => nextId++,
});

/// A clip's default geometry: the whole picture, fitted inside the canvas.
export function defaultTransform() {
    return {
        fit: 'contain',                     // contain | cover | stretch | actual
        zoom: 1,
        panX: 0, panY: 0,                   // fractions of the canvas
        crop: { l: 0, t: 0, r: 0, b: 0 },   // fractions cut off each edge
        opacity: 1,
    };
}

/// A clip of an input.
export function makeClip(input) {
    const probe = input.probe;
    const media = mediaLength(probe);
    return {
        id: nextId++,
        input,
        path: input.path,
        src: input.src,
        name: basename(input.path),
        probe,
        track: 0,
        start: 0,
        inPoint: 0,
        length: media,
        speed: 1,
        media,              // the whole file, which in and length are cut from
        width: probe.video ? probe.video.displayWidth : 0,
        height: probe.video ? probe.video.displayHeight : 0,
        fps: (probe.video && probe.video.fps) || 25,
        xform: defaultTransform(),
        volume: 1,
        muted: false,
        peaks: null,
        film: null,
        video: null,        // the <video> element, owned by the viewer
        frame: null,        // its crop window, owned by the viewer
    };
}

/// How long a generator is when nobody has said.
export const GENERATOR_SECONDS = 5;

/// A clip of a generator.
export function makeGenerator(settled) {
    const probe = settled.probe;
    return {
        id: nextId++,
        input: null,
        path: '',
        generator: settled.gen,
        src: settled.src,
        name: settled.name,
        probe,
        track: 0,
        start: 0,
        inPoint: 0,
        length: GENERATOR_SECONDS,
        speed: 1,
        media: GENERATOR_SECONDS,
        width: settled.width,
        height: settled.height,
        fps: settled.fps || 25,
        xform: defaultTransform(),
        volume: 1,
        muted: false,
        peaks: null,
        film: null,
        video: null,
        frame: null,
    };
}

/// A generator's arguments have changed: put back everything that follows from
/// them.
export function applyGenerator(clip, settled) {
    clip.generator = settled.gen;
    clip.name = settled.name;
    clip.src = settled.src;
    clip.probe = settled.probe;
    clip.width = settled.width;
    clip.height = settled.height;
    clip.fps = settled.fps || clip.fps;
}

function sort() {
    project.clips.sort((a, b) => a.track - b.track || a.start - b.start || a.id - b.id);
}

/// Put an input's answer back into the clips cut from it, after it has been
/// reopened with a different demuxer, option or window.
export function applyInput(input) {
    for (const c of project.clips) {
        if (c.input !== input) continue;
        c.path = input.path;
        c.src = input.src;
        c.probe = input.probe;
        c.name = basename(input.path);
        const media = mediaLength(input.probe);
        c.media = media;
        if (input.probe && input.probe.video) {
            c.width = input.probe.video.displayWidth;
            c.height = input.probe.video.displayHeight;
            c.fps = input.probe.video.fps || c.fps;
        } else {
            c.width = 0;
            c.height = 0;
        }
        c.inPoint = Math.max(0, Math.min(c.inPoint, Math.max(0, media)));
        c.length = Math.max(0, Math.min(c.length, (media - c.inPoint) / speedOf(c)));
    }
    sort();
}

/// The clips cut from one input, which is what makes it removable or not.
export function clipsOf(input) {
    return project.clips.filter((c) => c.input === input);
}

/// How many lanes the timeline shows: every track in use, plus one empty one
/// on top to drag a clip into.
export function trackCount() {
    let top = 0;
    for (const c of project.clips) top = Math.max(top, c.track);
    return Math.min(TRACK_LIMIT, top + 2);
}

// ── the sync lock ──────────────────────────────────────────────────────────

/// Does this track ripple with the others that are locked?
export function isTrackLocked(track) {
    const s = project.trackSettings[Math.round(Number(track))];
    return !!(s && s.locked);
}

/// Lock or unlock one track.
export function setTrackLocked(track, on) {
    const t = Math.round(Number(track));
    if (!(t >= 0 && t < TRACK_LIMIT)) return false;
    if (isTrackLocked(t) === !!on) return false;
    if (on) project.trackSettings[t] = Object.assign(project.trackSettings[t] || {},
                                                    { locked: true });
    else delete project.trackSettings[t];
    return true;
}

/// The tracks a ripple started on `track` moves, lowest first.
export function ripplesWith(track) {
    const t = Math.round(Number(track));
    if (!isTrackLocked(t)) return [t];
    return Object.keys(project.trackSettings)
                 .sort()
                 .map(Number)
                 .filter((n) => isTrackLocked(n))
                 .sort((a, b) => a - b);
}

/// Forget the settings of every track the timeline no longer shows.
export function retainTracks() {
    const lanes = trackCount();
    let dropped = false;
    for (const key of Object.keys(project.trackSettings).sort()) {
        const n = Number(key);
        const s = project.trackSettings[key];
        const set = !!(s && s.locked);
        if (set && n >= 0 && n < lanes) continue;
        delete project.trackSettings[key];
        dropped = true;
    }
    return dropped;
}

export function addClip(clip, atEnd = true) {
    clip.start = atEnd ? trackEnd(clip.track) : 0;
    project.clips.push(clip);
    sort();
    if (!project.width && clip.width) {
        project.width = clip.width;
        project.height = clip.height;
    }
    if (project.clips.length === 1) project.fps = clip.fps;
    return clip;
}

/// Put a clip back exactly where it says it is.
export function placeClip(clip) {
    project.clips.push(clip);
    sort();
    return clip;
}

/// Put the list back in order after something outside this file has written
/// `track` or `start` straight onto a clip.
export function sortClips() { sort(); }

/// Note that an id has been handed out, so this counter never issues it again.
export function useClipId(id) {
    const n = Number(id);
    if (Number.isFinite(n) && n >= nextId) nextId = Math.floor(n) + 1;
}

/// The clip with this id, or null.
export function clipById(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    return project.clips.find((c) => c.id === n) || null;
}

export function removeClip(clip) {
    const i = project.clips.indexOf(clip);
    if (i < 0) return false;
    project.clips.splice(i, 1);
    deselect(clip);
    if (!project.selected) project.selected = project.clips[Math.min(i, project.clips.length - 1)] || null;
    if (project.selected && !project.selection.length) project.selection = [project.selected];
    return true;
}

export function moveClip(clip, start, track) {
    clip.start = Math.max(0, start);
    if (track !== undefined) clip.track = Math.max(0, Math.min(TRACK_LIMIT - 1, track | 0));
    sort();
}

/// Where a track's clips currently run out.
function trackEnd(track) {
    let d = 0;
    for (const c of project.clips)
        if (c.track === track) d = Math.max(d, c.start + c.length);
    return d;
}

/// Make room for a clip that was just dropped somewhere on its own track.
export function resolveOverlaps(moved) {
    let edge = moved.start + moved.length;
    for (const c of project.clips.slice().sort((a, b) => a.start - b.start)) {
        if (c === moved || c.track !== moved.track) continue;
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

/// Every clip the playhead is inside, bottom track first — which is paint
/// order. Ends are exclusive so a playhead exactly on a boundary belongs to the
/// clip that starts there.
export function clipsAt(t) {
    const out = [];
    for (const c of project.clips)
        if (t >= c.start && t < c.start + c.length) out.push(c);
    return out;      // already sorted: project.clips is kept in track order
}

export function nextClipAfter(t) {
    let best = null;
    for (const c of project.clips)
        if (c.start > t + 1e-6 && (!best || c.start < best.start)) best = c;
    return best;
}
