// The program monitor: an output canvas with one clip's picture placed inside
// it.
//
// Each clip owns a <video> inside a crop window — a div with overflow:hidden.
// The video is sized and offset so the whole picture would land where fit,
// zoom and pan put it; the window then cuts the cropped edges away. The engine
// clips replaced content against an ancestor's overflow the same as anything
// else, so this costs one style write per change and nothing per frame — no
// readback, no per-frame composite, the decoded frame goes straight to the
// renderer as it always did.

import { project } from './project.js';

let stage = null;       // the output canvas, sized to the project aspect
let viewerEl = null;    // the box it is centred in
let active = null;

export function initViewer(refs) {
    stage = refs.stage;
    viewerEl = refs.viewer;
}

export function activeClip() { return active; }

/// Build a clip's picture: a crop window with a video inside it. Sizing waits
/// for layout(); src waits for the element to actually exist in the tree,
/// which is why this appends before assigning.
export function attachClip(clip) {
    if (clip.video) return;
    const frame = document.createElement('div');
    frame.className = 'clipframe';
    const video = document.createElement('video');
    frame.appendChild(video);
    stage.appendChild(frame);
    clip.frame = frame;
    clip.video = video;
    video.src = clip.path;
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
    if (active === clip) active = null;
}

function setVisible(clip, on) {
    if (clip.frame) clip.frame.style.display = on ? 'block' : 'none';
}

/// Show exactly one clip. Everything else is paused — several decoders running
/// at once would each be doing full-rate work for a picture nobody sees.
export function setActive(clip) {
    if (active === clip) return active;
    if (active) { try { active.video.pause(); } catch (e) {} setVisible(active, false); }
    active = clip;
    if (active) setVisible(active, true);
    return active;
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

/// Where the whole picture lands inside the canvas, before cropping. Returned
/// separately because the crop UI needs it to turn a dragged handle back into
/// a fraction of the source.
export function placement(clip, sw, sh) {
    const W = clip.width || 16, H = clip.height || 9;
    const x = clip.xform;
    let dw, dh;
    if (x.fit === 'stretch') { dw = sw; dh = sh; }
    else {
        const s = x.fit === 'cover'  ? Math.max(sw / W, sh / H)
                : x.fit === 'actual' ? 1
                                     : Math.min(sw / W, sh / H);
        dw = W * s; dh = H * s;
    }
    dw *= x.zoom; dh *= x.zoom;
    return {
        w: dw, h: dh,
        x: (sw - dw) / 2 + x.panX * sw,
        y: (sh - dh) / 2 + x.panY * sh,
    };
}

function place(clip, sw, sh) {
    if (!clip.frame) return;
    const p = placement(clip, sw, sh);
    const c = clip.xform.crop;
    const fw = Math.max(1, p.w * (1 - c.l - c.r));
    const fh = Math.max(1, p.h * (1 - c.t - c.b));

    // The window shows the kept part of the picture...
    clip.frame.style.left = (p.x + p.w * c.l).toFixed(2) + 'px';
    clip.frame.style.top = (p.y + p.h * c.t).toFixed(2) + 'px';
    clip.frame.style.width = fw.toFixed(2) + 'px';
    clip.frame.style.height = fh.toFixed(2) + 'px';

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

export function stageSize() {
    return { w: stage ? stage.clientWidth : 0, h: stage ? stage.clientHeight : 0 };
}
