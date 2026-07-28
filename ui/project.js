// What is on the timeline.
//
// A stack of video tracks. A clip is a file placed at a time on a track, with a
// geometry saying how its picture sits inside the output canvas and how opaque
// it is. Everything else in the app reads this and nothing else: the viewer
// draws every clip the playhead is inside, bottom track first; the timeline
// draws them all in their lanes; the properties panel edits the selection.

import { basename } from './format.js';

export const project = {
    clips: [],              // sorted by track, then start
    selection: [],          // clips, in the order they were picked
    selected: null,         // the primary — the last one picked
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
///
/// **Two genuinely different questions**, and they are deliberately not merged:
/// `outputFps()` in `ui/export/state.js` is what the encoder is asked for, and
/// this is what the ruler steps by, what a timecode counts frames in and what
/// the spine's Compose card states. A render at 60 fps off a 25 fps timeline is
/// an ordinary thing to ask for.
///
/// One home each, because the fallback was written out at eight points of use
/// and had drifted into two answers — 25 at the ruler, the timecode and a new
/// clip, 30 at the spine, the rate menu and the spec. Nothing was ever visibly
/// wrong, and that is worth writing down rather than leaving as a fix: this
/// object is seeded at 25 and `makeClip` falls back to 25, so `project.fps` is
/// never zero and the `|| 30` arms were unreachable. What the one home buys is
/// that they cannot come apart if it ever is.
export function projectFps() { return project.fps || 25; }

const listeners = [];

/// Subscribe to any change to the model. Coarse on purpose: the redraws it
/// triggers are a ruler, a few canvases and a handful of style writes.
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
        opacity: 1,
    };
}

/// A clip of an input.
///
/// **A clip references an input rather than carrying a path.** What is opened,
/// with which demuxer, with which options and over which window is the input's
/// business — see ui/inputs.js — and two clips cut from one file are two clips
/// of one `-i`, which is what ffmpeg would open. What is copied here is what a
/// clip needs to lay itself out (`path` for a name, `src` for its `<video>`,
/// the probe for its size and rate), and `applyInput()` puts it back whenever
/// the input is reopened.
export function makeClip(input) {
    const probe = input.probe;
    // The video track's own duration, not the container's. They differ — an
    // audio track routinely runs a fraction of a second past the last picture
    // — and it is the pictures that decide how long a clip is.
    const media = (probe.video && probe.video.duration) || probe.format.duration || 0;
    return {
        id: nextId++,
        input,
        path: input.path,
        // What the `<video>` is pointed at: a token naming the input, not the
        // path, because an input's options have to reach playback and a src is
        // only a string. See src/native/ffmpeg_input.h.
        src: input.src,
        name: basename(input.path),
        probe,
        track: 0,
        start: 0,
        inPoint: 0,
        length: media,
        media,              // the whole file, which in and length are cut from
        width: probe.video ? probe.video.displayWidth : 0,
        height: probe.video ? probe.video.displayHeight : 0,
        fps: (probe.video && probe.video.fps) || 25,
        xform: defaultTransform(),
        volume: 1,
        muted: false,
        peaks: null,        // { buckets, min, max, rms, duration } once analysed
        film: null,         // { bitmap, width, height, count, times }
        video: null,        // the <video> element, owned by the viewer
        frame: null,        // its crop window, owned by the viewer
        ready: false,
    };
}

function sort() {
    project.clips.sort((a, b) => a.track - b.track || a.start - b.start || a.id - b.id);
}

/// Put an input's answer back into the clips cut from it, after it has been
/// reopened with a different demuxer, option or window.
///
/// The length is the interesting one: `-ss 30` on a ten-second input leaves
/// nothing, and a clip that kept its old length would lay out over footage that
/// is no longer in the input. Trimmed rather than removed — the clip is still
/// the edit somebody made, and a window they can widen again.
export function applyInput(input) {
    for (const c of project.clips) {
        if (c.input !== input) continue;
        c.path = input.path;
        c.src = input.src;
        c.probe = input.probe;
        c.name = basename(input.path);
        const media = input.probe
            ? (input.probe.video && input.probe.video.duration) ||
              input.probe.format.duration || 0
            : 0;
        c.media = media;
        if (input.probe && input.probe.video) {
            c.width = input.probe.video.displayWidth;
            c.height = input.probe.video.displayHeight;
            c.fps = input.probe.video.fps || c.fps;
        }
        c.inPoint = Math.max(0, Math.min(c.inPoint, Math.max(0, media)));
        c.length = Math.max(0, Math.min(c.length, media - c.inPoint));
    }
    sort();
}

/// The clips cut from one input, which is what makes it removable or not.
export function clipsOf(input) {
    return project.clips.filter((c) => c.input === input);
}

/// How many lanes the timeline shows: every track in use, plus one empty one
/// on top to drag a clip into. That spare lane is the whole gesture for
/// creating a track — there is no "add track" button to find.
export function trackCount() {
    let top = 0;
    for (const c of project.clips) top = Math.max(top, c.track);
    return Math.min(8, top + 2);
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
    if (track !== undefined) clip.track = Math.max(0, Math.min(7, track | 0));
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
///
/// Two clips overlapping on one track has no answer to "which one is the
/// playhead inside", so the dropped clip keeps where it landed and anything it
/// covers slides out of the way, cascading. Clips on other tracks are none of
/// this function's business — overlapping across tracks is the entire point of
/// having tracks. Clips that were already clear stay exactly where they were.
///
/// This is also what makes reordering work: drag the second clip in front of
/// the first and the first is pushed behind it.
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

/// Source time inside a clip's file for a timeline time.
export function sourceTime(clip, t) {
    return clip.inPoint + (t - clip.start);
}

// ── selection ──────────────────────────────────────────────────────────────
//
// A list rather than one clip, because the properties panel edits all of it at
// once. `selected` is the last one picked: the crop handles and the pan gesture
// need a single subject, and "the one you just clicked" is the only answer that
// is never surprising.

// Whether the current selection is one the playhead put there rather than one
// you picked. Only an automatic selection may be replaced automatically.
let autoSelected = false;

/// Selection following the playhead. With one track the panel should always
/// describe the picture on screen — that is what made this a player before it
/// was an editor. On a stack it must not: picking a clip on V1 and scrubbing
/// across a clip on V2 would silently re-point the panel at the thing on top,
/// and the crop handles with it.
export function selectFollow(clip) {
    if (!clip || project.selection.length > 1) return;
    if (project.selection.length === 1 && !autoSelected) return;
    if (project.selection[0] === clip) return;
    project.selection = [clip];
    project.selected = clip;
    autoSelected = true;
    changed('selection');
}

export function select(clip, mode) {
    autoSelected = mode === 'auto';
    if (!clip) {
        if (!project.selection.length) return;
        project.selection = [];
        project.selected = null;
        changed('selection');
        return;
    }
    if (mode === 'add') {
        const i = project.selection.indexOf(clip);
        if (i >= 0) {
            // Ctrl-clicking a selected clip takes it out again, unless it is
            // the only one — an empty selection from a click on a clip reads
            // as the click having missed.
            if (project.selection.length > 1) {
                project.selection.splice(i, 1);
                project.selected = project.selection[project.selection.length - 1];
                changed('selection');
            }
            return;
        }
        project.selection.push(clip);
    } else {
        if (project.selection.length === 1 && project.selection[0] === clip) return;
        project.selection = [clip];
    }
    project.selected = clip;
    changed('selection');
}

export function selectMany(clips) {
    autoSelected = false;
    project.selection = clips.slice();
    project.selected = clips.length ? clips[clips.length - 1] : null;
    changed('selection');
}

export function isSelected(clip) { return project.selection.indexOf(clip) >= 0; }

function deselect(clip) {
    const i = project.selection.indexOf(clip);
    if (i >= 0) project.selection.splice(i, 1);
    if (project.selected === clip)
        project.selected = project.selection[project.selection.length - 1] || null;
}

// ── editing ────────────────────────────────────────────────────────────────

/// Cut a clip in two at a timeline time. Both halves keep pointing at the same
/// file — a split costs nothing but a second <video> — and together they cover
/// exactly what the one clip covered, so nothing on the track moves.
///
/// Trimming is this plus deleting a half, which is why there is no separate
/// trim operation for the ends.
export function splitClip(clip, t, makeElement) {
    const local = t - clip.start;
    if (local <= 1e-3 || local >= clip.length - 1e-3) return null;

    const right = Object.assign({}, clip, {
        id: nextId++,
        start: clip.start + local,
        inPoint: clip.inPoint + local,
        length: clip.length - local,
        xform: JSON.parse(JSON.stringify(clip.xform)),
        video: null,
        frame: null,
        ready: false,
    });
    clip.length = local;
    project.clips.push(right);
    sort();
    if (makeElement) makeElement(right);
    return right;
}

/// Move one end of a clip. The other end stays put: trimming the head moves the
/// clip's start on the timeline *and* its in-point together, so the pictures
/// under the part you kept do not slide sideways.
export function trimClip(clip, edge, t) {
    const min = 1 / Math.max(1, clip.fps);
    // Growing an end into the neighbour would make two clips cover the same
    // moment on one track, which has no answer to "which one is on screen".
    // The neighbours are the wall a trim stops at.
    let before = 0, after = Infinity;
    for (const c of project.clips) {
        if (c === clip || c.track !== clip.track) continue;
        if (c.start + c.length <= clip.start + 1e-6) before = Math.max(before, c.start + c.length);
        else if (c.start >= clip.start + clip.length - 1e-6) after = Math.min(after, c.start);
    }

    if (edge === 'start') {
        const limit = clip.start + clip.length - min;
        let want = Math.min(limit, Math.max(before, t));
        // Cannot trim back past the head of the file: there is no footage there.
        want = Math.max(want, clip.start - clip.inPoint);
        const delta = want - clip.start;
        clip.start = want;
        clip.inPoint += delta;
        clip.length -= delta;
    } else {
        const maxLen = Math.min(clip.media - clip.inPoint, after - clip.start);
        clip.length = Math.max(min, Math.min(maxLen, t - clip.start));
    }
    sort();
}
