// The program monitor: an output canvas with the clips under the playhead
// placed inside it.
//
// Each clip owns a <video> inside a crop window — a div with overflow:hidden.
// The video is sized and offset so the whole picture would land where fit,
// zoom and pan put it; the window then cuts the cropped edges away. The engine
// clips replaced content against an ancestor's overflow the same as anything
// else, so this costs one style write per change and nothing per frame — no
// readback, no per-frame composite, the decoded frame goes straight to the
// renderer as it always did. Stacking and opacity are the same deal: z-index
// and an opacity on the window, both free.

import { project, isSelected, hasPicture } from './project.js';
import { inserts } from './graph/overlay.js';
import { srcFor, whyFor } from './graph/playback.js';

/// Does this clip have filters of its own on the graph? Read here rather than
/// pushed in, because the overlay is small and this runs once per clip per
/// layout rather than once per frame.
function hasFilters(id) {
    const key = `clip:${id}/`;
    return inserts().some((n) => n.anchor.indexOf(key) === 0);
}

/// What this clip's `<video>` should be playing: the filtered view of its input
/// where there is one, and the input's own token where there is not.
///
/// One place, because two callers set a src — the element is built once and
/// re-pointed whenever the filters change — and a clip playing the file while
/// the badge says it is filtered would be the worst of both.
function wantedSrc(clip) {
    return srcFor(clip.id) || clip.src || clip.path;
}

let stage = null;       // the output canvas, sized to the project aspect
let viewerEl = null;    // the box it is centred in
let active = [];        // the clips currently shown, bottom track first

/// Is the canvas showing the render instead of the clips? See `ui/output.js`.
///
/// A flag here rather than an import of it, because the preview's spec comes
/// from `export/spec.js`, which takes every clip's rectangle from this file —
/// so a viewer that reached the other way would close the loop. What the viewer
/// needs to know is one bit, and the caller that turned the mode on is holding
/// it.
let outputMode = false;

export function initViewer(refs) {
    stage = refs.stage;
    viewerEl = refs.viewer;
}

/// The clip that owns the moment — the topmost one with a picture, so it is
/// literally the picture in front.
///
/// **A clip with no picture is only the answer when nothing else is**, and that
/// is a deliberate choice rather than a fallback nobody thought about. The
/// transport takes this as the master clock, and a clock exists to say what
/// moment is *on screen*: a music bed dropped on a lane above the footage would
/// otherwise take the clock away from the thing being watched — and take frame
/// stepping with it, since `stepFrame()` moves by decoded pictures and a
/// soundtrack has none to move by. With nothing but sound under the playhead the
/// topmost clip is still the answer, because bro drives `currentTime` from the
/// media clock where there is no picture, which is the whole of what makes an
/// audio-only timeline play.
export function activeClip() {
    for (let i = active.length - 1; i >= 0; i--)
        if (hasPicture(active[i])) return active[i];
    return active.length ? active[active.length - 1] : null;
}
export function activeClips() { return active; }

/// Build a clip's picture: a crop window with a video inside it. Sizing waits
/// for layout(); src waits for the element to actually exist in the tree,
/// which is why this appends before assigning.
export function attachClip(clip) {
    if (clip.video) return;
    const frame = document.createElement('div');
    frame.className = 'clipframe';
    const video = document.createElement('video');
    frame.appendChild(video);
    // The selection ring is its own element, after the video, because a
    // box-shadow on the window would be painted underneath its own child and a
    // border would move the picture inside it.
    const ring = document.createElement('div');
    ring.className = 'ring';
    frame.appendChild(ring);
    stage.appendChild(frame);
    clip.frame = frame;
    clip.video = video;
    // The token naming the clip's input, not its path: an input's forced
    // demuxer, options and window have to reach playback, and a `<video>` src
    // is only a string. See src/native/ffmpeg_input.h — and playback_filter.h
    // for the other token this can be, which is that input with the clip's own
    // filters on it.
    video.src = wantedSrc(clip);
    video.volume = 1;
    setVisible(clip, false);
}

export function detachClip(clip) {
    if (!clip.frame) return;
    // Stopping first releases the decoder and the audio stream; dropping the
    // element alone would leave both running until the next GC.
    try { clip.video.pause(); clip.video.src = ''; } catch (e) {}
    stage.removeChild(clip.frame);
    clip.frame = null;
    clip.video = null;
    const i = active.indexOf(clip);
    if (i >= 0) active.splice(i, 1);
}

/// A clip's crop window is shown while the playhead is inside it — unless there
/// is no picture in it, in which case it never is.
///
/// The element stays: it *is* the decoder and it *is* the sound, and the clip is
/// active in every other respect. What it must not be is laid out, because a
/// `<video>` with no picture keeps the 300×150 replaced-element box and would
/// sit as a black rectangle over whatever is beneath it. One place writes
/// `display`, so this is the one place that has to know.
function setVisible(clip, on) {
    if (clip.frame)
        clip.frame.style.display = on && !outputMode && hasPicture(clip) ? 'block' : 'none';
}

/// Show the render instead of the clips, or the clips again.
///
/// The elements stay either way, for the reason they stay when the playhead is
/// off them: each one *is* a decoder, and a mode that tore them down would make
/// turning the preview off a seek per clip rather than a repaint.
export function setOutputMode(on) {
    outputMode = !!on;
    for (const c of active) setVisible(c, true);
}

/// Show exactly this set of clips and no others. Everything else is paused —
/// several decoders running for pictures nobody sees is the one cost in this
/// design that is not free.
///
/// Returns true when the set changed, which is the caller's cue that the newly
/// shown clips need seeking into position.
export function setActiveSet(clips) {
    let same = clips.length === active.length;
    if (same) for (let i = 0; i < clips.length; i++) if (clips[i] !== active[i]) { same = false; break; }
    if (same) return false;

    for (const c of active) {
        if (clips.indexOf(c) >= 0) continue;
        try { c.video.pause(); } catch (e) {}
        setVisible(c, false);
    }
    for (const c of clips) if (active.indexOf(c) < 0) setVisible(c, true);
    active = clips.slice();
    // Paint order: the array is already bottom-track-first, and z-index by
    // position keeps two clips on the same track from flickering past each
    // other when one is replaced.
    for (let i = 0; i < active.length; i++)
        if (active[i].frame) active[i].frame.style.zIndex = String(i + 1);
    return true;
}

/// Size the output canvas to fit the viewer, then place every clip inside it.
export function layout() {
    if (!stage || !viewerEl) return;
    const availW = Math.max(16, viewerEl.clientWidth - 24);
    const availH = Math.max(16, viewerEl.clientHeight - 24);
    const pw = project.width || 16;
    const ph = project.height || 9;
    const s = Math.min(availW / pw, availH / ph);
    const w = Math.max(16, Math.round(pw * s));
    const h = Math.max(16, Math.round(ph * s));
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    for (const c of project.clips) place(c, w, h);
}

// ── grid ───────────────────────────────────────────────────────────────────

/// Rows and columns for n cells in a canvas of this shape. Squarest wins: the
/// aim is cells as close to the canvas's own aspect as possible, so twelve
/// 16:9 clips on a 16:9 canvas come out 4×3 rather than 12×1.
export function gridShape(n, aspect) {
    if (n <= 1) return { cols: 1, rows: 1 };
    let best = { cols: n, rows: 1 }, bestScore = Infinity;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        // A cell's aspect is the canvas's, scaled by rows/cols. The clips came
        // out of the same canvas, so a cell shaped like the canvas is a cell
        // the picture fills — which makes this a search for a square grid, not
        // a square cell. Empty cells in the last row cost a little, but not
        // enough to beat a good shape: three 16:9 clips look better two-up with
        // a gap than in one tall row of slivers.
        const cell = (aspect * rows) / cols;
        // The last term breaks ties toward the wider layout — 4×3 rather than
        // 3×4 for a dozen, the way a wall of monitors is always arranged. It is
        // orders of magnitude below any real difference in shape, so it decides
        // nothing else.
        const score = Math.abs(Math.log(cell / aspect)) + (cols * rows - n) * 0.06
                      - cols * 1e-4;
        if (score < bestScore) { bestScore = score; best = { cols, rows }; }
    }
    return best;
}

/// The cell a clip gets in grid layout, or null when the layout is 'stack'.
/// Cells are handed out in timeline order, so the grid reads the way the
/// timeline does rather than jumping around as clips are added.
function cellFor(clip, sw, sh) {
    if (project.layout !== 'grid') return null;
    // Only the clips with pictures get cells. A grid is a wall of monitors, and
    // a sound file among them is not a dark monitor — it is not a monitor.
    const order = project.clips.filter(hasPicture);
    const i = order.indexOf(clip);
    if (i < 0) return null;
    const { cols, rows } = gridShape(order.length, sw / sh);
    const cw = sw / cols, ch = sh / rows;
    // A gutter, so twelve recordings of the same green-screen desk read as
    // twelve pictures instead of one. The stage behind is black, so the gap
    // needs no colour of its own.
    const g = Math.min(GRID_GUTTER, cw / 8, ch / 8);
    return { x: (i % cols) * cw + g, y: Math.floor(i / cols) * ch + g,
             w: cw - g * 2, h: ch - g * 2 };
}

const GRID_GUTTER = 3;

// ── placement ──────────────────────────────────────────────────────────────

/// Where the whole picture lands inside the canvas, before cropping. Returned
/// separately because the crop UI needs it to turn a dragged handle back into
/// a fraction of the source.
export function placement(clip, sw, sh) {
    // **A clip with no picture has no rectangle**, and this is where that is
    // decided because this is where layout is resolved: the renderer is handed
    // what this returns, so the export follows for free and nothing downstream
    // has to learn that a clip can be sound only. Not a rectangle of zero
    // opacity and not one off the edge of the canvas — no rectangle, so that
    // anything asking "where does this go" gets the honest answer nowhere.
    if (!hasPicture(clip)) return { w: 0, h: 0, x: 0, y: 0, cell: null };

    // In a grid the clip's own placement is set aside: every cell is the same
    // size and every picture is fitted inside its cell. Zoom and pan still
    // apply, so one cell can be pushed in on a detail while the others stay put.
    const cell = cellFor(clip, sw, sh);
    const bx = cell ? cell.x : 0, by = cell ? cell.y : 0;
    const bw = cell ? cell.w : sw, bh = cell ? cell.h : sh;

    const W = clip.width || 16, H = clip.height || 9;
    const x = clip.xform;
    const fit = cell ? 'contain' : x.fit;
    let dw, dh;
    if (fit === 'stretch') { dw = bw; dh = bh; }
    else {
        const s = fit === 'cover'  ? Math.max(bw / W, bh / H)
                : fit === 'actual' ? 1
                                   : Math.min(bw / W, bh / H);
        dw = W * s; dh = H * s;
    }
    dw *= x.zoom; dh *= x.zoom;
    return {
        w: dw, h: dh,
        x: bx + (bw - dw) / 2 + x.panX * bw,
        y: by + (bh - dh) / 2 + x.panY * bh,
        cell,
    };
}

function place(clip, sw, sh) {
    if (!clip.frame) return;
    // Nothing to place. `setVisible` keeps its window hidden whatever the
    // active set says, so there is no box here to size.
    if (!hasPicture(clip)) return;
    const p = placement(clip, sw, sh);
    const c = clip.xform.crop;
    const fw = Math.max(1, p.w * (1 - c.l - c.r));
    const fh = Math.max(1, p.h * (1 - c.t - c.b));

    // The window shows the kept part of the picture...
    clip.frame.style.left = (p.x + p.w * c.l).toFixed(2) + 'px';
    clip.frame.style.top = (p.y + p.h * c.t).toFixed(2) + 'px';
    clip.frame.style.width = fw.toFixed(2) + 'px';
    clip.frame.style.height = fh.toFixed(2) + 'px';
    clip.frame.style.opacity = String(clip.xform.opacity);
    // Which picture is picked has to be visible on the picture itself. In a
    // grid the timeline lane is a sliver and the panel names one file; without
    // a ring on the cell there is nothing tying the two together.
    clip.frame.classList.toggle('sel', project.clips.length > 1 && isSelected(clip));
    clip.frame.classList.toggle('primary', project.selected === clip);
    // A clip whose filters this picture is *not* showing. Most of them are now
    // — the element is playing the chain rather than the file, see
    // graph/playback.js — so the badge is the exception it was always meant to
    // be: a chain that forks, or one that changes the size of the picture and
    // would have to be drawn into a rectangle the render never puts it in.
    // Leaving those unmarked would read as the filter not working.
    clip.frame.classList.toggle('filtered', hasFilters(clip.id) && !srcFor(clip.id));
    clip.frame.title = whyFor(clip.id);

    // ...and the picture inside it stays whole, pushed up and left so the
    // cropped edges fall outside.
    clip.video.style.width = p.w.toFixed(2) + 'px';
    clip.video.style.height = p.h.toFixed(2) + 'px';
    clip.video.style.left = (-p.w * c.l).toFixed(2) + 'px';
    clip.video.style.top = (-p.h * c.t).toFixed(2) + 'px';
}

/// Re-place one clip after its geometry changed.
export function refresh(clip) {
    place(clip, stage.clientWidth, stage.clientHeight);
}

/// Re-point every element at what it should be playing, after the filters on a
/// clip have changed.
///
/// Setting a src builds a new source and a new decoder — the element *is* the
/// decoder — so this is done only for the clips whose answer actually changed.
///
/// **The clips it re-pointed come back**, and putting them right is the
/// caller's: an element handed a new src is an element at zero with the
/// element's own default volume, and both the playhead and the mix are the
/// transport's business rather than this file's. Returning them rather than
/// reaching for `transport` also keeps the import going one way.
/// `rebuild` is the clips whose src has to be set again *whether or not the
/// string changed*: a filtered view can be redefined under the token it already
/// had — a clip dragged along the timeline moves what moment its filters think
/// they are looking at — and a source that resolved the old one holds it for as
/// long as it is open.
export function refreshSources(rebuild) {
    const moved = [];
    const again = new Set(rebuild || []);
    for (const c of project.clips) {
        if (!c.video) continue;
        const want = wantedSrc(c);
        if (c.video.src === want && !again.has(c.id)) continue;
        try {
            c.video.pause();
            c.video.src = want;
        } catch (e) { /* the element has gone */ }
        moved.push(c);
    }
    return moved;
}

/// Re-place everything — what a layout-mode or canvas-size change needs.
export function refreshAll() {
    for (const c of project.clips) place(c, stage.clientWidth, stage.clientHeight);
}

export function stageSize() {
    return { w: stage ? stage.clientWidth : 0, h: stage ? stage.clientHeight : 0 };
}

/// Which clip's picture is under a point on the stage, topmost first. Grid
/// layout needs it: clicking a cell should select the clip in that cell.
export function clipAtPoint(sx, sy) {
    for (let i = active.length - 1; i >= 0; i--) {
        const c = active[i];
        if (!c.frame || !hasPicture(c)) continue;
        const l = parseFloat(c.frame.style.left) || 0;
        const t = parseFloat(c.frame.style.top) || 0;
        const w = parseFloat(c.frame.style.width) || 0;
        const h = parseFloat(c.frame.style.height) || 0;
        if (sx >= l && sx <= l + w && sy >= t && sy <= t + h) return c;
    }
    return null;
}
