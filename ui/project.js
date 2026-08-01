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

/// Is this clip a generator rather than a cut of a file?
///
/// One home, because the difference is real in exactly three places and invented
/// nowhere else: there is no `-i` to open (`graph/derive.js` puts the filter
/// itself at the head of the chain), there is no sound to mix, and there is no
/// seeking — libavfilter's sources produce forward and the `lavfi` demuxer has no
/// `read_seek`, so a generator's element is never the transport's master clock
/// (`viewer.activeClip()`). Everything else asks a clip the questions it always
/// asked.
export function isGenerator(clip) { return !!(clip && clip.generator); }

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
        // **The `length` is the timeline length and the source span is
        // `length * speed`.** See the speed section below for why round that way
        // and not the other: every layout, ripple, collision and drag calculation
        // in this file and in ui/timeline.js reads `length` as "how much of the
        // programme this occupies", and a field that sometimes meant seconds of
        // the file would have to be un-learned in about thirty places.
        length: media,
        speed: 1,
        media,              // the whole file, which in and length are cut from
        width: probe.video ? probe.video.displayWidth : 0,
        height: probe.video ? probe.video.displayHeight : 0,
        fps: (probe.video && probe.video.fps) || 25,
        xform: defaultTransform(),
        volume: 1,
        muted: false,
        // What the clip looks and sounds like, filled in by ui/analysis.js and
        // never by this file. `peaks` is one envelope over the whole file, with
        // a `have` mask when it was read a window at a time; `film` is a short
        // list of strips, because a clip on a link is read for the span on
        // screen and holds several of them.
        peaks: null,
        film: null,
        video: null,        // the <video> element, owned by the viewer
        frame: null,        // its crop window, owned by the viewer
    };
}

/// How long a generator is when nobody has said.
///
/// Five seconds, and the number is a decision rather than a measurement — which
/// is the whole difficulty a generator brings and is stated here because there is
/// nowhere else it could come from. A `color` is infinite: libavfilter goes on
/// producing frames for as long as something pulls them, so unlike a file there
/// is no length to discover. Long enough to see the bar and scrub inside it,
/// short enough that trimming it down is the ordinary gesture rather than a
/// chore, and it is a **prompt nobody is asked**: a dialog before a colour card
/// exists would be a question with no information in it.
export const GENERATOR_SECONDS = 5;

/// A clip of a generator.
///
/// Takes what `ui/generator.js` `settle()` answered rather than a filter name,
/// for the reason `makeClip` takes an input rather than a path: what libavfilter
/// says the pictures are — their size, their rate, and a token a `<video>` can
/// play — is the generator's answer, and asking for it here would put a
/// `bro.ffmpeg` call in the middle of the model.
///
/// **`media` is a decision, and it is the one thing about a generator clip that
/// is not like a file clip.** For a file, `media` is "the whole file, which in
/// and length are cut from" — a measurement, and a ceiling the edit may not
/// raise. A generator has no such number, so this holds the same convention the
/// rest of the application already reaches for when something has no length of
/// its own (`inputIsEndless` in src/native/ffmpeg_input.h, `graphLength()` in
/// ui/export/spec.js): **`-t` is the only thing that can say**, so the number is
/// the edit's, it starts at `GENERATOR_SECONDS`, and `roomFor()` raises it when a
/// trim asks for more — because asking a `testsrc` for another ten seconds is a
/// request it answers rather than one it runs out of.
///
/// `Infinity` was the obvious way to write "no end" and is the wrong one to put
/// in the model: it reaches `duration()`, which is what the ruler, the scrollbar
/// and every range on the Encode stage are measured against; it reaches the
/// document, where `JSON.stringify` turns it into `null`; and it reaches
/// `slipClip`'s clamp, one arithmetic step from a `NaN` position nobody can
/// trace. A real number that the edit is allowed to revise says the same thing
/// and cannot do any of that — so `duration()` is always finite.
export function makeGenerator(settled) {
    const probe = settled.probe;
    return {
        id: nextId++,
        // No input and no path: there is no `-i`, which is what makes this a
        // generator. Everything that reads `clip.input` is asking about a file,
        // and null is the honest answer — `indexOf()` in ui/inputs.js answers -1
        // for it, which is what the spec carries and what the graph reads as "no
        // input of the document's".
        input: null,
        path: '',
        // The filter and its options, which is what this clip is *of*. The one
        // field a clip of a file does not have, and the one a document writes in
        // place of an input id.
        generator: settled.gen,
        // The `-f lavfi -i <filter>` registered for it, so the program monitor
        // plays the real thing through the real backend. See ui/generator.js.
        src: settled.src,
        name: settled.name,
        // What libavfilter says it produces. Kept exactly as a clip of a file
        // keeps its input's answer, so that every reader of `clip.probe` — the
        // chips, `hasPicture`, the waveform lane's "no audio track" — is telling
        // the truth about a generator rather than merely surviving it.
        probe,
        track: 0,
        start: 0,
        inPoint: 0,
        length: GENERATOR_SECONDS,
        // A generator has a speed like any clip, and it means what it means for a
        // file: the same span of the filter's own seconds in less of the
        // programme. A `mandelbrot` at 2× zooms twice as fast.
        speed: 1,
        media: GENERATOR_SECONDS,
        width: settled.width,
        height: settled.height,
        fps: settled.fps || 25,
        xform: defaultTransform(),
        volume: 1,
        muted: false,
        // Neither is ever filled in: a generator has no sound to draw an
        // envelope of, and a filmstrip is grabbed by seeking, which is the one
        // thing a lavfi source cannot do. `analysis.js` asks for neither.
        peaks: null,
        film: null,
        video: null,
        frame: null,
    };
}

/// A generator's arguments have changed: put back everything that follows from
/// them.
///
/// The mirror of `applyInput()`, and shorter than it by exactly the thing that
/// makes a generator a generator. `applyInput` clamps the in-point and the length,
/// because a file reopened through a different demuxer or a narrower window is a
/// *shorter file* than the trim was made against — and nothing about a generator's
/// arguments can shorten it. How long there is of one is `media`, which is the
/// edit's number rather than the filter's, so re-typing the size must leave the bar
/// exactly where it is. What does change is the picture's size and rate, which the
/// layout reads and which the render's rectangle comes from.
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
        // Against the *source span*, because that is what has to fit inside the
        // file: a clip at 2× on a ten-second window is five seconds of programme.
        c.length = Math.max(0, Math.min(c.length, (media - c.inPoint) / speedOf(c)));
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

// ── speed ──────────────────────────────────────────────────────────────────
//
// How fast a clip's source runs through the window the edit gives it. One number
// on the clip, and the three functions below are every consequence of it.
//
// **`length` stays the timeline length**, so nothing that lays out, ripples,
// resolves an overlap or drags has to learn anything: the source span is
// `length * speed` and the trim constraint is `inPoint + length * speed <=
// media`. The other rounding — `length` as seconds of the file — would have made
// `duration()`, `clipsAt()`, `resolveOverlaps()`, `trackEnd()` and every pixel of
// ui/timeline.js multiply by a speed they have no business knowing about.
//
// **When the speed changes, the source span is what is preserved.** "Play this
// shot at 2×" means the same footage in half the programme, which is the gesture
// people have; the alternative — keeping the timeline length and taking twice as
// much footage — is a trim wearing a speed control's name, and it runs off the end
// of the file the moment there is not twice as much left. A speed *decrease*
// therefore grows the clip, so it can reach its neighbour, and it stops there
// exactly as a trim does rather than refusing or overlapping.
//
// **The pitch moves, and it is not an oversight.** Speed here is a *resample* —
// `asetrate=<rate>*<speed>,aresample=<rate>` in the graph and libav's own `swr`
// fed the input rate multiplied by the speed in the compositor. Preserving the
// pitch means time-stretching, which is `atempo` (WSOLA), which is a libavfilter
// filter — and `TimelineSource::mixInto` has no graph to put one in, so the two
// paths would have to disagree about what the render is. They must not: the whole
// claim of ui/graph/derive.js is that it turns the same spec into the graph, so
// the graph cannot describe a render this application would not perform. A
// compositor that resampled while the printed chain said `atempo` would be
// exactly that lie. `atempo` is still the pitch-preserving answer and it is a
// filter somebody can place on the Graph stage; what the controls and the manual
// do is say so rather than apologise.
//
// **Reverse and freeze are refused by name**, in `setSpeed`.

/// The narrowest and widest a control will offer. **A convenience range and not a
/// limit** — `asetrate` has no upper bound and neither does dividing a
/// timestamp — so this is only what a field is willing to read out of a person's
/// keystroke, and the comment is here so nobody later mistakes it for a fact
/// about libav.
export const SPEED_MIN = 0.05;
export const SPEED_MAX = 20;

/// How fast this clip runs. One home, because "a clip written by a version that
/// had no speed" is every document and every `localStorage` entry that predates
/// this, and `clip.speed || 1` written out at fifteen points of use is fifteen
/// chances for a zero to become a freeze nobody asked for.
export function speedOf(clip) {
    const s = clip ? Number(clip.speed) : 1;
    return Number.isFinite(s) && s > 0 ? s : 1;
}

/// How much of the source this clip covers, in the source's own seconds.
///
/// The other half of "length is the timeline length". Everything that asks *what
/// does this clip take out of its file* — the trim's ceiling, a slip's clamp, the
/// span a copied stream would have to cover — asks this, and everything that asks
/// where the clip sits reads `length`.
export function sourceSpan(clip) {
    return Math.max(0, clip.length) * speedOf(clip);
}

/// Source time inside a clip's file for a timeline time.
export function sourceTime(clip, t) {
    return clip.inPoint + (t - clip.start) * speedOf(clip);
}

/// And back: where a moment of the source lands on the timeline.
///
/// **The inverse of `sourceTime`, written beside it.** It was `c.start + (at -
/// c.inPoint)` in `ui/graph/when.js` and `clip.video.currentTime - clip.inPoint`
/// twice in `ui/transport.js`, which was three copies of a map with no scale in
/// it — and a scale dropped in one direction only is the mistake that cannot be
/// seen, because both readers of the pair agree at speed 1 and disagree by a
/// factor nobody is looking for at any other speed.
export function timelineTime(clip, srcT) {
    return clip.start + (srcT - clip.inPoint) / speedOf(clip);
}

/// Play this clip at another speed, keeping the footage it covers.
///
/// Answers `''` when it did it and the reason when it would not, so a control can
/// say so where somebody is standing rather than failing silently or throwing.
///
/// **Two speeds are refused by name rather than clamped**, because each is a
/// different feature wearing this one's clothes:
///
///   - **negative is reverse**, and it is not expressible here at all: decoders
///     walk forward, and libavfilter's `reverse`/`areverse` buffer the whole
///     stream in memory before emitting a frame, so it is a different render
///     rather than a different number.
///   - **zero is a freeze frame**, which is a real feature and is not this one. It
///     also makes the arithmetic degenerate: the source span goes to nothing and
///     the length that would preserve it is `Infinity`, which `makeGenerator`
///     already records as unusable in a clip — it reaches `duration()`,
///     `JSON.stringify` turns it into `null`, and `slipClip`'s clamp becomes
///     `NaN`.
///
/// Beyond that it clamps rather than refuses, exactly as a trim does: a *slower*
/// clip is a longer one and can reach the clip after it, and a drag that stops
/// dead against the neighbour says where the wall is more clearly than one that
/// does nothing.
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
    // The source span is what is preserved, so this is the length that covers the
    // same footage. Everything after it is a clamp.
    const wanted = clip.length * was / next;
    const min = 1 / Math.max(1, clip.fps);
    const { after } = walls(clip);
    // What the *source* has, asked at the new speed. Preserving the span cannot
    // exceed it — that is the point of preserving it — but the one-frame floor
    // below can, on a clip made very short by a very high speed.
    const source = Math.max(0, (clip.media - clip.inPoint) / next);
    clip.speed = next;
    clip.length = Math.max(min, Math.min(wanted, after - clip.start, source));
    sort();
    return '';
}

/// The clips either side of this one on its own track, as the two times an edit
/// to it may not cross.
///
/// One home, because two edits ask: a trim, and a speed decrease — which grows
/// the clip and is therefore the same question about the same wall. `after` is
/// `Infinity` where nothing follows, which is what makes both callers' `Math.min`
/// read as "no limit".
function walls(clip) {
    let before = 0, after = Infinity;
    for (const c of project.clips) {
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
/// A generator splits the same way and for the same reason: the two halves share
/// one generator spec and therefore one registered `-f lavfi -i`, exactly as two
/// halves of a file share one `-i`. Nothing here has to know which kind it is,
/// which is the point of a generator being a clip.
///
/// Trimming is this plus deleting a half, which is why there is no separate
/// trim operation for the ends.
export function splitClip(clip, t, makeElement) {
    const local = t - clip.start;
    if (local <= 1e-3 || local >= clip.length - 1e-3) return null;

    const right = Object.assign({}, clip, {
        id: nextId++,
        start: clip.start + local,
        // `local` is on the timeline and an in-point is in the file, so the cut
        // moves by the source distance the two halves share — which is the whole
        // of what `speed` changes about a split.
        inPoint: clip.inPoint + local * speedOf(clip),
        length: clip.length - local,
        xform: JSON.parse(JSON.stringify(clip.xform)),
        video: null,
        frame: null,
    });
    clip.length = local;
    project.clips.push(right);
    sort();
    if (makeElement) makeElement(right);
    return right;
}

/// How much of a clip's source there is to cut from, given how much the edit is
/// about to ask for.
///
/// **A file's answer is a measurement and a generator's is a decision**, which is
/// why this is a function rather than a field read. For a clip of a file it is
/// `clip.media` and nothing happens: the edit cannot conjure footage past the end
/// of a file, and a trim that tried stops there. For a generator it *raises* the
/// number, because libavfilter goes on producing for as long as it is asked to —
/// so dragging the end of a colour card out to twenty seconds is a request that
/// is answered, and the edit's declared length grows to match. See
/// `makeGenerator` for why that number is finite rather than `Infinity`.
///
/// Two callers, and both edits are "make this end later": a trim of the tail and
/// a roll of the cut after it. Written once so that a generator cannot grow under
/// one gesture and refuse under the other.
function roomFor(clip, wanted) {
    if (isGenerator(clip) && wanted > clip.media) clip.media = wanted;
    return clip.media;
}

/// Move one end of a clip. The other end stays put: trimming the head moves the
/// clip's start on the timeline *and* its in-point together, so the pictures
/// under the part you kept do not slide sideways.
export function trimClip(clip, edge, t) {
    const min = 1 / Math.max(1, clip.fps);
    // Growing an end into the neighbour would make two clips cover the same
    // moment on one track, which has no answer to "which one is on screen".
    // The neighbours are the wall a trim stops at — see `walls`, which a speed
    // change asks the same question of.
    const { before, after } = walls(clip);
    // Every distance below is on the *timeline*; the source distance it comes to
    // is that times the speed. One term, at each of the two places where a
    // timeline second has to be spent out of the file.
    const speed = speedOf(clip);

    if (edge === 'start') {
        const limit = clip.start + clip.length - min;
        let want = Math.min(limit, Math.max(before, t));
        // Cannot trim back past the head of the file: there is no footage there.
        // At 2× a second of programme costs two of footage, so the head is half
        // as far back as the in-point suggests.
        want = Math.max(want, clip.start - clip.inPoint / speed);
        const delta = want - clip.start;
        clip.start = want;
        clip.inPoint += delta * speed;
        clip.length -= delta;
    } else {
        // How far the *neighbour* lets this end go, asked before the source is:
        // a generator's `media` is raised by what a trim did and not by what the
        // pointer asked for, so a drag that stopped dead against the clip after it
        // has not asked for another ten seconds of `testsrc`.
        const reach = Math.min(t - clip.start, after - clip.start);
        const room = roomFor(clip, clip.inPoint + reach * speed);
        const maxLen = Math.min((room - clip.inPoint) / speed, after - clip.start);
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
    //
    // **Both limits are on the timeline and both sources are in their own
    // seconds, and the two clips need not run at the same speed** — so each
    // side's footage is divided by its own. A cut rolled one second later spends
    // `leftSpeed` seconds of the left file and gives back `rightSpeed` of the
    // right.
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
/// Clamped against the *source span* rather than the length, which is the same
/// statement it always was: what may not run past the last frame is the footage
/// the window covers, and at 2× that is twice the window. A caller with a pointer
/// distance rather than a footage distance scales it — see `ui/timeline.js`, which
/// is the one such caller.
export function slipClip(clip, delta) {
    const want = clip.inPoint + delta;
    clip.inPoint = Math.max(0, Math.min(clip.media - sourceSpan(clip), want));
}
