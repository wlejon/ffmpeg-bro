// What is on the timeline.
//
// A stack of video tracks. A clip is a file placed at a time on a track, with a
// geometry saying how its picture sits inside the output canvas and how opaque
// it is. Everything else in the app reads this and nothing else: the viewer
// draws every clip the playhead is inside, bottom track first; the timeline
// draws them all in their lanes; the properties panel edits the selection.
//
// **A track is not a thing here; it is a number a clip carries.** There is no
// list of tracks and no "add track" button — `trackCount()` derives how many
// lanes there are from the clips that exist, and dragging a clip into the spare
// lane at the top is the whole gesture for making one. `trackSettings` below is
// the one thing a track has of its own, and it is written so as not to become a
// second answer to that question.

import { basename } from './format.js';

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

/// How long the media behind a clip is, out of a probe.
///
/// **The video track's own duration, not the container's.** They differ — an
/// audio track routinely runs a fraction of a second past the last picture —
/// and it is the pictures that decide how long a clip is, because the playhead
/// runs out of frames before it runs out of file.
///
/// This is `lengthOf()` in `ui/inputs.js` written a second time, and that is a
/// decision rather than an oversight: `inputs.js` imports `changed` from here,
/// so importing back would close a cycle for one three-line function. Two
/// copies inside this file was the thing worth fixing — `makeClip` and
/// `applyInput` each had one, and a clip made one way could have disagreed
/// with the same clip after its input was reopened. If a third caller ever
/// wants it, the answer is a leaf module both can import, not a cycle.
function mediaLength(probe) {
    if (!probe) return 0;
    return (probe.video && probe.video.duration) || probe.format.duration || 0;
}

/// Does this clip put anything on the canvas?
///
/// **A clip with no picture is not a hole in the canvas.** It contributes to the
/// mix and to nothing else: no rectangle, no cell in the grid, no lane of
/// thumbnails, no `[0:v]` pad in the graph. That is what a music bed dropped on
/// a timeline is, and it is the whole of what "an audio-only file is an ordinary
/// clip" costs.
///
/// Asked of the probe rather than of `clip.width`, because the probe is the
/// answer the input gave and `applyInput()` keeps it in step; a size is
/// something derived from it. One home, because six files ask.
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

/// A clip's default geometry: the whole picture, fitted inside the canvas.
///
/// Exported for the document reader, which merges what was written over the top
/// of this rather than validating the shape field by field — one home for what a
/// clip's geometry *is*, so a document written by a version with one more field
/// in it does not come back through a second, shorter idea of the same object.
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
    const media = mediaLength(probe);
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
        const media = mediaLength(input.probe);
        c.media = media;
        // The *shown* size, which is the coded size swapped at a quarter turn:
        // a clip laid out at the coded size is a portrait picture in a
        // landscape box. And no size at all when the reopened input turned out
        // to have no picture in it — a demuxer forced or a window cut can take
        // the video stream away, and a clip that went on claiming the size it
        // used to have would be claiming a rectangle nothing renders into.
        if (input.probe && input.probe.video) {
            c.width = input.probe.video.displayWidth;
            c.height = input.probe.video.displayHeight;
            c.fps = input.probe.video.fps || c.fps;
        } else {
            c.width = 0;
            c.height = 0;
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
///
/// **The one home for how many tracks there are**, and it reads the clips and
/// nothing else. Anything per-track that gets stored — see `trackSettings` —
/// has to be arranged so that it cannot answer this question too, because a
/// record that could would let a leftover entry put a lane on the screen that no
/// clip is on.
export function trackCount() {
    let top = 0;
    for (const c of project.clips) top = Math.max(top, c.track);
    return Math.min(TRACK_LIMIT, top + 2);
}

// ── the sync lock ──────────────────────────────────────────────────────────
//
// Which tracks move together when one of them ripples. A lock means "ripple
// this track along with every other locked track"; off — which is the default
// and stays the default — means a ripple moves its own track alone.
//
// **This is a bag of settings for a track, not a list of tracks, and that is the
// whole design.** `trackCount()` above derives the number of lanes from the
// clips, so a `tracks` array would immediately be a second answer to it: eight
// entries would mean eight lanes whether or not anything was on them, and an
// entry left behind by a deleted clip would put a lane on the screen that no
// edit asked for. `ui/timeline.js` `laneOf()` states the same objection about
// the DOM — a per-lane record "would have to be invented per track and would go
// stale as tracks come and go" — and the three things that answer it here are:
//
//   - **Keyed by the track number**, which is the name the model already uses
//     for a lane. Nothing is invented per track, so nothing can be invented
//     twice or drift from what a clip's `track` says.
//   - **Sparse, and pruned.** An entry exists only where something has been set;
//     `setTrackLocked(t, false)` deletes rather than storing a false, so a
//     document does not accumulate a row of `{locked:false}` for lanes nobody
//     touched. `retainTracks()` drops everything above the lanes the timeline
//     shows, on the same channel and for the same reason
//     `graph/overlay.js`'s `retain()` drops a filter pinned to a clip that has
//     gone: there are several ways a track can empty out and the one that gets
//     missed is the one that grows the stored state forever.
//   - **Read by the clips, never by the lanes.** A ripple asks which *tracks*
//     move and then walks `project.clips`, so a lock on a track with nothing on
//     it matches nothing and moves nothing. A stale entry is at worst a lit
//     padlock, never a clip that moved.
//
// A lock is **part of the edit**, not part of the session: it changes what a
// drag does to the clips, so it is in `snapshot()` and it is *not* stripped by
// `ui/history.js` the way the playhead and the selection are. Locking a track is
// an undoable step.

/// Does this track ripple with the others that are locked?
export function isTrackLocked(track) {
    const s = project.trackSettings[Math.round(Number(track))];
    return !!(s && s.locked);
}

/// Lock or unlock one track. Answers whether anything changed, so a caller can
/// decide whether it has an edit to announce.
///
/// Off deletes the entry rather than storing `locked: false`. The alternative —
/// a record per lane, written as the lanes appear — is what the header above
/// rejects: it accumulates, it survives the track it describes, and the moment
/// something counts it, it is a second answer to `trackCount()`.
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
///
/// Its own track always, and every other locked track when the one it started on
/// is locked. Answered as a list of track numbers rather than as a set of clips
/// because two callers want it and they want different things from it: the
/// ripple walks the clips, and the timeline draws the lanes so that which of
/// them will move is visible *before* a drag rather than discovered after one.
export function ripplesWith(track) {
    const t = Math.round(Number(track));
    if (!isTrackLocked(t)) return [t];
    return Object.keys(project.trackSettings)
                 .map(Number)
                 .filter((n) => isTrackLocked(n))
                 .sort((a, b) => a - b);
}

/// Forget the settings of every track the timeline no longer shows.
///
/// **Stated in terms of `trackCount()` rather than beside it**, so there is one
/// answer to which lanes exist and this is downstream of it. A lock lasts as
/// long as its lane is on the screen: delete the last clip on V3 and V3 becomes
/// the spare lane, keeping its lock, because it is still a lane you can see the
/// padlock on and still the lane a clip dropped there lands on; delete enough
/// that V3 is not drawn at all and the lock goes with it. What that buys is that
/// this bag can never hold more entries than there are lanes, so nothing
/// accumulates and nothing outlives what it describes.
///
/// Called from the model's change channel in `ui/app.js` rather than from each
/// of `removeClip`, `moveClip` and the document reader — same argument as
/// `graph/overlay.js` `retain()`, which is called from the same place for the
/// same reason. Announces nothing itself: it runs *inside* the announcement, and
/// firing another would be a change channel calling itself.
export function retainTracks() {
    const lanes = trackCount();
    let dropped = false;
    for (const key of Object.keys(project.trackSettings)) {
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
///
/// `addClip` has an opinion about *where* — the end of its track, or the top of
/// it for a batch — because dropping a file is an act with one. Opening a
/// document is not: the arrangement is the thing being restored, and a clip that
/// arrived at the end of its track instead would be an edit nobody made. It
/// seeds no canvas either, for the same reason: a document brought its own.
export function placeClip(clip) {
    project.clips.push(clip);
    sort();
    return clip;
}

/// Put the list back in order after something outside this file has written
/// `track` or `start` straight onto a clip.
///
/// Everything in here that moves a clip sorts afterwards, and that is the rule —
/// `clipsAt()` relies on paint order and says so. The document reader is the one
/// caller that writes those fields in bulk, across clips it did not make, and
/// sorting once at the end of that is cheaper and clearer than routing a
/// hundred fields through `moveClip`.
export function sortClips() { sort(); }

/// Note that an id has been handed out, so this counter never issues it again.
///
/// A clip's id is written down outside this file — `clip:7/after-scale` is how
/// the graph overlay pins a filter to one — so opening a document has to put the
/// same ids back rather than renumber and quietly re-point every anchor at a
/// different shot. Told rather than set, because a document is not the only
/// thing handing ids out: a split has already taken one from this counter by the
/// time a document is opened over the top, and "never this one again" is the
/// only rule that is true whichever order they happen in. Same rule as `seq` in
/// ui/graph/overlay.js, for the same reason.
export function useClipId(id) {
    const n = Number(id);
    if (Number.isFinite(n) && n >= nextId) nextId = Math.floor(n) + 1;
}

/// The clip with this id, or null.
///
/// The other half of `useClipId`, and here for the same reason it is: an id is a
/// name written down *outside* this file, so several places have to turn one back
/// into a clip — a document's session says which clip was selected, a copied
/// stream on the Write stage says which clip it follows, and the graph's anchors
/// are parsed out of `clip:7/after-scale`. Three copies of `find` is three chances
/// for one of them to compare a string against a number and quietly answer
/// nothing; the coercion is the whole of what this adds.
///
/// Null rather than undefined, because every caller here is asking a yes/no
/// question about a clip that may have been deleted since the id was written.
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

// ── ripple, roll and slip ──────────────────────────────────────────────────
//
// The three edits that are about a *cut* rather than about a clip, and none of
// them needed anything added to the model: a clip already knows its in-point
// separately from where it sits, which is the whole of what they are arithmetic
// on. What was missing was the arithmetic and a gesture to reach it.
//
// They are three because they answer three different questions, and the thing
// they hold constant is what tells them apart:
//
//   - **Ripple** holds the *content* and moves everything after. Trim a clip
//     and the gap closes rather than being left as a hole to notice later.
//   - **Roll** holds the *total* and moves the boundary. The programme is the
//     same length afterwards; the cut is somewhere else in it.
//   - **Slip** holds the *window* and moves the content inside it. The clip
//     stays exactly where it is and starts somewhere else in the file.
//
// Each is written against `trimClip`'s own limits rather than beside them: the
// wall a trim stops at is the neighbour, the head of the file and one frame, and
// a second copy of those rules is a second answer to where an edit can go.

/// Trim, and take everything after it along.
///
/// **The gap is the point.** An ordinary trim leaves a hole where the footage
/// was, which is right when the clips after are placed against a soundtrack and
/// wrong when the programme is a sequence — and only the person editing knows
/// which. So this is the second gesture rather than the new behaviour of the
/// first.
///
/// **Which tracks move is a decision about which are locked together, and now
/// there is something that says.** Everything later on the clip's own track
/// moves, plus everything later on every other track carrying a sync lock —
/// `ripplesWith()` — when the track being trimmed carries one too.
///
/// **Unlocked is the default, and the default is one track.** That is not
/// timidity, it is the case the gesture is usually for: a title on V2 over a shot
/// on V1 is placed against that shot, and rippling one track under another
/// silently moves it off. What a lock says is that these tracks are one
/// programme — a cut across a stack, where the sound bed and the overlay are
/// meant to travel with the picture — and only the person editing knows which of
/// the two a given pair of tracks is. So it is a control on the track head
/// rather than a rule, and it is off until somebody says otherwise.
///
/// The rejected alternative was "ripple every track", which is what an NLE with
/// no lock does: it is right for a programme cut and quietly destroys every
/// placement in the title case, with nothing on screen having said it would.
export function rippleTrim(clip, edge, t) {
    const wasStart = clip.start;
    const wasEnd = clip.start + clip.length;
    trimClip(clip, edge, t);
    // What the trim actually did, which is not what it was asked for: the
    // neighbour, the head of the file and the one-frame floor all clamp it.
    const delta = edge === 'start' ? clip.start - wasStart
                                   : (clip.start + clip.length) - wasEnd;
    if (Math.abs(delta) < 1e-9) return;

    // Trimming the head moves the head, so the clip itself comes back to where
    // it was and the shift lands on everything after it — otherwise a ripple at
    // the head would leave the clip somewhere it was not dragged to.
    const from = edge === 'start' ? wasStart : wasEnd;
    if (edge === 'start') clip.start = wasStart;
    // The tracks, asked once. A locked track with nothing on it is in this list
    // and matches no clip, which is exactly why a leftover entry cannot move
    // anything.
    const tracks = ripplesWith(clip.track);
    for (const c of project.clips) {
        if (c === clip || tracks.indexOf(c.track) < 0) continue;
        if (c.start >= from - 1e-6) c.start = Math.max(0, c.start + delta);
    }
    sort();
}

/// Move the cut between two butted clips, leaving the programme the same length.
///
/// One boundary, two clips: the left one's out-point and the right one's
/// in-point are the same moment, and rolling moves both. Which is why it is a
/// gesture on *the cut* rather than on an edge — at a butt join the two edges
/// are the same x, and "the end of the left clip" and "the start of the right
/// clip" are two names for one thing.
///
/// Both sides have to have the footage. Rolling right needs frames after the
/// left clip's out-point and rolling left needs frames before the right clip's
/// in-point, and the limit is whichever runs out first — reported by doing
/// less, not by refusing, because a drag that stops moving says where the wall
/// is more clearly than a drag that does nothing.
export function rollCut(left, right, t) {
    if (!left || !right || left.track !== right.track) return;
    const minL = 1 / Math.max(1, left.fps);
    const minR = 1 / Math.max(1, right.fps);
    const cut = left.start + left.length;

    // How far the cut may travel each way, out of the four things that stop it:
    // footage left in the left clip's file, footage left before the right
    // clip's in-point, and one frame of each clip surviving.
    const laterMost = Math.min(left.media - left.inPoint - left.length,
                               right.length - minR);
    const earlierMost = Math.min(right.inPoint, left.length - minL);
    const want = Math.max(cut - earlierMost, Math.min(cut + laterMost, t));
    const delta = want - cut;
    if (Math.abs(delta) < 1e-9) return;

    left.length += delta;
    right.start += delta;
    right.inPoint += delta;
    right.length -= delta;
    sort();
}

/// Move the content inside a clip without moving the clip.
///
/// The one edit that changes nothing about the arrangement: `start`, `length`
/// and every clip around it are untouched, and what changes is which seconds of
/// the file are shown in that window. It is how a shot is re-framed in time —
/// the action happens a second later than the cut allows for, so the window
/// stays and the footage slides under it.
///
/// `delta` is in the file's seconds and is what the pointer moved, negated:
/// dragging *right* shows *earlier* footage, because the gesture is pushing the
/// film under the window rather than moving the window over the film. That is
/// the convention every editor uses and the sign is worth stating, because both
/// readings are defensible and only one of them matches what a hand expects.
///
/// Clamped to what the file has: a clip cannot start before the first frame or
/// run past the last, so a slip that would do either stops at the end of the
/// footage rather than shortening the clip. Shortening would be a slip that
/// silently became a trim.
export function slipClip(clip, delta) {
    const want = clip.inPoint + delta;
    clip.inPoint = Math.max(0, Math.min(clip.media - clip.length, want));
}
