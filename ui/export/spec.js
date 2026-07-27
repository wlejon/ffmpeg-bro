// The edit, in the shape bro.ffmpeg.render.start wants.
//
// The placement rectangles come from viewer.placement() rather than from a
// second implementation of fit/zoom/pan/grid: the renderer must never learn
// about layout, and anything that changes how a clip is placed on screen has
// to change one function and let the export follow for free.

import { project, duration } from '../project.js';
import * as viewer from '../viewer.js';
import { settings, outputFps } from './state.js';
import { containerInfo } from './capabilities.js';
import { videoOptions, audioOptions } from './options.js';
import { renderGraph } from '../filtergraph.js';
import { current as overlayState, isEmpty } from '../graph/overlay.js';

/// Swap a path's extension, keeping the directory and the name. Written
/// against both separators because a path here came from a native file dialog
/// on Windows and from a drop on everything else.
export function withExtension(path, ext) {
    const cut = path.replace(/\.[^./\\]*$/, '');
    return `${cut}.${ext}`;
}

/// Beside the first clip, named after it. Somewhere is better than nowhere:
/// the file picker is one click away, and this is right often enough that the
/// click is usually unnecessary.
export function defaultPath() {
    const first = project.clips[0];
    if (!first) return '';
    return `${first.path.replace(/\.[^./\\]*$/, '')}-export.${settings.container}`;
}

/// The part of the timeline that will be written.
export function range() {
    const total = Math.max(0, duration());
    let a = Math.max(0, Math.min(settings.rangeIn, total));
    let b = settings.rangeOut > 0 ? Math.min(settings.rangeOut, total) : total;
    if (b <= a) { a = 0; b = total; }
    return { start: a, end: b, length: b - a };
}

/// What `probe()` said about each clip's video stream, in the same order as
/// `buildSpec().clips` — which is where the filtergraph's source colour tags
/// come from, and the single biggest thing standing between the graph and the
/// render it describes.
///
/// Here rather than beside either caller because there are two now, the command
/// bar and the graph stage, and they must be looking at the same sources: a
/// screen that draws one matrix while the command prints another is worse than
/// either of them being wrong on its own.
export function specSources() {
    return project.clips.map((c) => (c.probe && c.probe.video) || null);
}

/// Everything the renderer needs.
///
/// Exported because the headless test builds one directly: driving the form
/// proves the form, and driving this proves the geometry.
export function buildSpec(over = {}) {
    const canvasW = project.width || 1920;
    const canvasH = project.height || 1080;
    const outW = Math.max(16, Math.round(over.width || settings.width || canvasW));
    const outH = Math.max(16, Math.round(over.height || settings.height || canvasH));
    // The canvas is the frame the edit was made in; a different output size is
    // the same picture at a different number of pixels, so every rectangle
    // scales with it rather than being re-fitted (which would move the crop
    // handles out from under what you set them to).
    const sx = outW / canvasW;
    const sy = outH / canvasH;

    const clips = project.clips.map((c, i) => {
        const p = viewer.placement(c, canvasW, canvasH);
        return {
            // Carried so the graph can name a node for the clip it came from
            // and find it again after the skeleton is rebuilt. The renderer
            // ignores it; `graph/derive.js` cannot work without it.
            id: c.id,
            path: c.path,
            start: c.start,
            length: c.length,
            inPoint: c.inPoint,
            x: p.x * sx, y: p.y * sy, w: p.w * sx, h: p.h * sy,
            crop: { l: c.xform.crop.l, t: c.xform.crop.t,
                    r: c.xform.crop.r, b: c.xform.crop.b },
            opacity: c.xform.opacity,
            volume: c.volume,
            muted: c.muted,
            // project.clips is kept sorted by track, so its own order is paint
            // order: bottom track first, exactly as the viewer stacks them.
            z: i,
        };
    });

    // Not activeVideoCodec(): `over` is the preview's, and the reference render
    // is this edit in a *different* container, so the fallback has to be that
    // container's default rather than the one the settings are pointing at.
    const container = containerInfo(over.container || settings.container);
    const vcodec = over.videoCodec || settings.videoCodec ||
                   (container ? container.videoCodec : 'libx264');
    const acodec = over.audioCodec || settings.audioCodec ||
                   (container ? container.audioCodec : 'aac');
    const r = range();

    const spec = {
        path: over.path || settings.path || defaultPath(),
        width: outW,
        height: outH,
        fps: over.fps || outputFps(),
        start: over.start !== undefined ? over.start : r.start,
        end: over.end !== undefined ? over.end : r.end,
        videoCodec: vcodec,
        audioCodec: acodec,
        // The named fields the renderer has always taken. The option bag is
        // applied after them and wins, which is what makes the controls above
        // and the raw editor the same mechanism.
        crf: over.crf !== undefined ? over.crf : settings.quality,
        videoBitrate: 0,
        preset: '',
        audio: over.audio !== undefined ? over.audio : settings.audio,
        audioBitrate: settings.audioCodecBitrate,
        sampleRate: settings.sampleRate,
        channels: settings.channels,
        pixelFormat: over.pixelFormat !== undefined ? over.pixelFormat : settings.pixelFormat,
        scaler: settings.scaler,
        colorspace: settings.colorspace === 'auto' ? '' : settings.colorspace,
        colorRange: settings.colorRange,
        faststart: settings.faststart,
        title: settings.title,
        videoOptions: over.videoOptions !== undefined
            ? over.videoOptions : videoOptions(vcodec, over),
        audioOptions: over.audioOptions !== undefined ? over.audioOptions : audioOptions(acodec),
        formatOptions: settings.extraFormat,
        clips,
    };

    // Which of the renderer's two paths this render takes, decided in one
    // place: a graph with nothing of the user's in it is the internal
    // compositor, and a graph with a filter in it is libavfilter. The two are
    // measured against each other in tests/export_test.cpp and agree to 43 dB,
    // so this is a choice about what is *expressible* rather than about which
    // is better — the compositor cannot run an `hflip`, and the graph path
    // decodes every input from the start of its file.
    //
    // Attached here rather than at each `render.start`, because there are three
    // of them — the export, and both halves of the A/B preview — and a
    // reference rendered without the filters would be comparing the picture
    // against a different picture.
    if (!isEmpty()) {
        const g = renderGraph(spec, specSources(), { overlay: overlayState() });
        if (g.ok) {
            spec.filterGraph = g.filterGraph;
            spec.filterInputs = g.filterInputs;
        }
    }
    return spec;
}
