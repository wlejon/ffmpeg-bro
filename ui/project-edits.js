// Speed, selection, splitting, trimming, ripple, roll, rate-stretch, and slip
// operations on timeline clips.

let core = null;
export function bindProjectCore(c) { core = c; }

// ── speed ──────────────────────────────────────────────────────────────────
//
// How fast a clip's source runs through the window the edit gives it. One number
// on the clip, and the three functions below are every consequence of it.
//
// **`length` stays the timeline length**, so nothing that lays out, ripples,
// resolves an overlap or drags has to learn anything: the source span is
// `length * speed` and the trim constraint is `inPoint + length * speed <=
// media`.
//
// **When the speed changes, the source span is what is preserved.** "Play this
// shot at 2×" means the same footage in half the programme, which is the gesture
// people have.
//
// **The pitch moves, and it is not an oversight.** Speed here is a *resample* —
// `asetrate=<rate>*<speed>,aresample=<rate>` in the graph and libav's own `swr`
// fed the input rate multiplied by the speed in the compositor.
//
// **Reverse and freeze are refused by name**, in `setSpeed`.

/// The narrowest and widest a control will offer. **A convenience range and not a
/// limit** — `asetrate` has no upper bound and neither does dividing a
/// timestamp — so this is only what a field is willing to read out of a person's
/// keystroke, and the comment is here so nobody later mistakes it for a fact
/// about libav.
export const SPEED_MIN = 0.05;
export const SPEED_MAX = 20;

/// How fast this clip runs.
export function speedOf(clip) {
    const s = clip ? Number(clip.speed) : 1;
    return Number.isFinite(s) && s > 0 ? s : 1;
}

/// How much of the source this clip covers, in the source's own seconds.
export function sourceSpan(clip) {
    return Math.max(0, clip.length) * speedOf(clip);
}

/// Source time inside a clip's file for a timeline time.
export function sourceTime(clip, t) {
    return clip.inPoint + (t - clip.start) * speedOf(clip);
}

/// And back: where a moment of the source lands on the timeline.
export function timelineTime(clip, srcT) {
    return clip.start + (srcT - clip.inPoint) / speedOf(clip);
}

/// Play this clip at another speed, keeping the footage it covers.
export function setSpeed(clip, speed) {
    if (!clip) return 'there is no clip to set a speed on';
    const next = Number(speed);
    if (!Number.isFinite(next))
        return 'a speed is a number of times normal — 2 is twice as fast';
    if (next < 0)
        return 'a negative speed is reverse playback, which is not expressible here: ' +
               'decoders walk forward, and libavfilter’s reverse buffers the whole stream ' +
               'in memory before it emits a frame';
    if (next === 0)
        return 'a speed of zero is a freeze frame, which is a different feature — it makes ' +
               'a clip of no footage and a length of Infinity, and Infinity is not a number ' +
               'this model can hold';

    const was = speedOf(clip);
    if (Math.abs(next - was) < 1e-9) return '';
    const wanted = clip.length * was / next;
    const min = 1 / Math.max(1, clip.fps);
    const { after } = walls(clip);
    const source = Math.max(0, (clip.media - clip.inPoint) / next);
    clip.speed = next;
    clip.length = Math.max(min, Math.min(wanted, after - clip.start, source));
    core.sort();
    return '';
}

/// The clips either side of this one on its own track, as the two times an edit
/// to it may not cross.
function walls(clip) {
    let before = 0, after = Infinity;
    for (const c of core.project.clips) {
        if (c === clip || c.track !== clip.track) continue;
        if (c.start + c.length <= clip.start + 1e-6) before = Math.max(before, c.start + c.length);
        else if (c.start >= clip.start + clip.length - 1e-6) after = Math.min(after, c.start);
    }
    return { before, after };
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

/// Selection following the playhead.
export function selectFollow(clip) {
    const project = core.project;
    if (!clip || project.selection.length > 1) return;
    if (project.selection.length === 1 && !autoSelected) return;
    if (project.selection[0] === clip) return;
    project.selection = [clip];
    project.selected = clip;
    autoSelected = true;
    core.changed('selection');
}

export function select(clip, mode) {
    const project = core.project;
    autoSelected = mode === 'auto';
    if (!clip) {
        if (!project.selection.length) return;
        project.selection = [];
        project.selected = null;
        core.changed('selection');
        return;
    }
    if (mode === 'add') {
        const i = project.selection.indexOf(clip);
        if (i >= 0) {
            if (project.selection.length > 1) {
                project.selection.splice(i, 1);
                project.selected = project.selection[project.selection.length - 1];
                core.changed('selection');
            }
            return;
        }
        project.selection.push(clip);
    } else {
        if (project.selection.length === 1 && project.selection[0] === clip) return;
        project.selection = [clip];
    }
    project.selected = clip;
    core.changed('selection');
}

export function selectMany(clips) {
    const project = core.project;
    autoSelected = false;
    project.selection = clips.slice();
    project.selected = clips.length ? clips[clips.length - 1] : null;
    core.changed('selection');
}

export function isSelected(clip) { return core.project.selection.indexOf(clip) >= 0; }

export function deselect(clip) {
    const project = core.project;
    const i = project.selection.indexOf(clip);
    if (i >= 0) project.selection.splice(i, 1);
    if (project.selected === clip)
        project.selected = project.selection[project.selection.length - 1] || null;
}

// ── editing ────────────────────────────────────────────────────────────────

/// Cut a clip in two at a timeline time. Both halves keep pointing at the same
/// file — a split costs nothing but a second <video> — and together they cover
/// exactly what the one clip covered, so nothing on the track moves.
export function splitClip(clip, t, makeElement) {
    const local = t - clip.start;
    if (local <= 1e-3 || local >= clip.length - 1e-3) return null;

    const right = Object.assign({}, clip, {
        id: core.allocateId(),
        start: clip.start + local,
        inPoint: clip.inPoint + local * speedOf(clip),
        length: clip.length - local,
        xform: JSON.parse(JSON.stringify(clip.xform)),
        video: null,
        frame: null,
    });
    clip.length = local;
    core.project.clips.push(right);
    core.sort();
    if (makeElement) makeElement(right);
    return right;
}

/// How much of a clip's source there is to cut from, given how much the edit is
/// about to ask for.
function roomFor(clip, wanted) {
    if (core.isGenerator(clip) && wanted > clip.media) clip.media = wanted;
    return clip.media;
}

/// Move one end of a clip. The other end stays put: trimming the head moves the
/// clip's start on the timeline *and* its in-point together, so the pictures
/// under the part you kept do not slide sideways.
export function trimClip(clip, edge, t) {
    const min = 1 / Math.max(1, clip.fps);
    const { before, after } = walls(clip);
    const speed = speedOf(clip);

    if (edge === 'start') {
        const limit = clip.start + clip.length - min;
        let want = Math.min(limit, Math.max(before, t));
        want = Math.max(want, clip.start - clip.inPoint / speed);
        const delta = want - clip.start;
        clip.start = want;
        clip.inPoint += delta * speed;
        clip.length -= delta;
    } else {
        const reach = Math.min(t - clip.start, after - clip.start);
        const room = roomFor(clip, clip.inPoint + reach * speed);
        const maxLen = Math.min((room - clip.inPoint) / speed, after - clip.start);
        clip.length = Math.max(min, Math.min(maxLen, t - clip.start));
    }
    core.sort();
}

// ── ripple, roll and slip ──────────────────────────────────────────────────
//
//   - **Ripple** holds the *content* and moves everything after.
//   - **Roll** holds the *total* and moves the boundary.
//   - **Slip** holds the *window* and moves the content inside it.

/// Trim, and take everything after it along.
export function rippleTrim(clip, edge, t) {
    const wasStart = clip.start;
    const wasEnd = clip.start + clip.length;
    trimClip(clip, edge, t);
    const delta = edge === 'start' ? clip.start - wasStart
                                   : (clip.start + clip.length) - wasEnd;
    if (Math.abs(delta) < 1e-9) return;

    const from = edge === 'start' ? wasStart : wasEnd;
    if (edge === 'start') clip.start = wasStart;
    const tracks = core.ripplesWith(clip.track);
    for (const c of core.project.clips) {
        if (c === clip || tracks.indexOf(c.track) < 0) continue;
        if (c.start >= from - 1e-6) c.start = Math.max(0, c.start + delta);
    }
    core.sort();
}

/// Move the cut between two butted clips, leaving the programme the same length.
export function rollCut(left, right, t) {
    if (!left || !right || left.track !== right.track) return;
    const minL = 1 / Math.max(1, left.fps);
    const minR = 1 / Math.max(1, right.fps);
    const cut = left.start + left.length;

    const leftSpeed = speedOf(left), rightSpeed = speedOf(right);
    const laterMost = Math.min(
        (roomFor(left, left.inPoint + (left.length + (t - cut)) * leftSpeed) -
             left.inPoint) / leftSpeed - left.length,
        right.length - minR);
    const earlierMost = Math.min(right.inPoint / rightSpeed, left.length - minL);
    const want = Math.max(cut - earlierMost, Math.min(cut + laterMost, t));
    const delta = want - cut;
    if (Math.abs(delta) < 1e-9) return;

    left.length += delta;
    right.start += delta;
    right.inPoint += delta * rightSpeed;
    right.length -= delta;
    core.sort();
}

/// Drag an edge and change the *speed*, so the same footage fills the new length.
export function rateStretch(clip, edge, t) {
    if (!clip) return;
    const span = sourceSpan(clip);
    if (!(span > 0)) return;
    const { before, after } = walls(clip);
    const min = 1 / Math.max(1, clip.fps);

    const end = clip.start + clip.length;
    let length = edge === 'start' ? end - Math.max(before, Math.min(t, end - min))
                                  : Math.min(t, after) - clip.start;
    length = Math.max(min, length);
    const speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, span / length));
    length = span / speed;
    if (edge === 'start') {
        clip.start = Math.max(before, end - length);
        clip.length = end - clip.start;
    } else {
        clip.length = Math.min(length, after - clip.start);
    }
    clip.speed = span / Math.max(min, clip.length);
    core.sort();
}

/// Move the content inside a clip without moving the clip.
export function slipClip(clip, delta) {
    const want = clip.inPoint + delta;
    clip.inPoint = Math.max(0, Math.min(clip.media - sourceSpan(clip), want));
}
