// The edit, in the shape bro.ffmpeg.render.start wants.
//
// The placement rectangles come from viewer.placement() rather than from a
// second implementation of fit/zoom/pan/grid: the renderer must never learn
// about layout, and anything that changes how a clip is placed on screen has
// to change one function and let the export follow for free.

import { project, duration } from '../project.js';
import { inputs as documentInputs, specInputs, indexOf as inputIndex,
         lengthOf as inputLength, streamKinds } from '../inputs.js';
import * as viewer from '../viewer.js';
import { settings, outputFps, outputExt } from './state.js';
import { muxerInfo } from './capabilities.js';
import { videoOptions, audioOptions } from './options.js';
import { streamSpecs } from './streams.js';
import { renderGraph } from '../filtergraph.js';
import { current as overlayState, isEmpty, nodes as overlayNodes } from '../graph/overlay.js';

/// Swap a path's extension, keeping the directory and the name. Written
/// against both separators because a path here came from a native file dialog
/// on Windows and from a drop on everything else.
export function withExtension(path, ext) {
    const cut = path.replace(/\.[^./\\]*$/, '');
    return `${cut}.${ext}`;
}

/// A path with a frame-number pattern in it, or the same path without one.
///
/// **`image2` writes a run of files, one per frame, and the numbering is in
/// the filename** — there is no other place for it, which is why this is a
/// question about the path and not an option. Without a pattern the muxer
/// writes one file and overwrites it on every frame, which is a legitimate
/// thing to want (`-update 1`) and a disastrous thing to get by accident.
export function withPattern(path, digits = 4) {
    if (!path || bro.ffmpeg.hasFramePattern(path)) return path;
    const cut = /^(.*?)(\.[^./\\]*)?$/.exec(path);
    return `${cut[1]}%0${digits}d${cut[2] || ''}`;
}

export function withoutPattern(path) {
    return String(path || '').replace(/%[-+ #0]*\d*d/, '');
}

/// Beside the first clip, named after it. Somewhere is better than nowhere:
/// the file picker is one click away, and this is right often enough that the
/// click is usually unnecessary.
export function defaultPath() {
    const first = project.clips[0];
    if (!first) return '';
    return `${first.path.replace(/\.[^./\\]*$/, '')}-export.${outputExt()}`;
}

/// How long the graph says it is, for a render the timeline does not account
/// for.
///
/// A `testsrc` into an encoder is a legitimate render and ffmpeg does it every
/// day, but nothing about a generator says when it stops — it goes on producing
/// for as long as it is asked to. That is the same problem a still and an
/// endless `-stream_loop` posed two chunks ago, and the convention they left is
/// followed rather than a third one invented: **`-t` is the only thing that can
/// answer, and zero means nobody knows.** So a `color` or a `testsrc` is as long
/// as its own `duration`/`d` argument, an input the graph reads is as long as
/// the input is, and a graph that says neither has no length — which is refused
/// with a sentence about `d` rather than papered over with a number somebody
/// would have to notice was invented.
export function graphLength() {
    let best = 0;
    for (const rec of overlayNodes()) {
        if (rec.kind === 'input') {
            const input = documentInputs.find((i) => i.id === rec.input);
            if (input) best = Math.max(best, inputLength(input));
            continue;
        }
        const p = rec.params || {};
        const d = Number(p.duration !== undefined ? p.duration : p.d);
        if (Number.isFinite(d) && d > 0) best = Math.max(best, d);
    }
    return best;
}

/// The part of the timeline that will be written.
///
/// With nothing on the timeline the graph's own length stands in, which is what
/// makes a render rooted only in generators reachable at all — every range on
/// this stage is measured against the document's duration, and a document whose
/// content is in the graph has none.
export function range() {
    const total = Math.max(0, duration()) || graphLength();
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

/// What the graph has to know about each `-i` beyond how to open it: which
/// input it is, what streams came back, and its name.
///
/// Index-aligned with `specInputs()` — the same list, so the `-i` number is one
/// fact rather than two. The streams are the probe's, because that is what
/// decides how many sockets a source card draws: an input with no sound in it
/// must not offer a pad the render cannot fill.
function specInputInfo() {
    return documentInputs.map((i) => ({
        id: i.id,
        name: i.name,
        path: i.path,
        streams: streamKinds(i),
    }));
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
            // Which `-i` this clip is cut from. The path travels too, for the
            // log and for a spec written by hand, but the index is what the
            // renderer opens: the demuxer, the options and the window are the
            // input's and a path cannot carry them.
            input: inputIndex(c.input),
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
    const container = muxerInfo(over.container || settings.container);
    const vcodec = over.videoCodec || settings.videoCodec ||
                   (container ? container.videoCodec : 'libx264');
    const acodec = over.audioCodec || settings.audioCodec ||
                   (container ? container.audioCodec : 'aac');
    const r = range();

    const spec = {
        path: over.path || settings.path || defaultPath(),
        // The `-i`s, in the order they are numbered. All of them, not only the
        // ones a clip reads: the list is the document's, the indices are what
        // the clips point at, and dropping the unused ones would renumber the
        // rest. The renderer opens what is referenced and nothing else.
        inputs: over.inputs !== undefined ? over.inputs : specInputs(),
        // The same list again, as the *document* knows it: an id that survives
        // the list being reordered, the streams the probe found, and what to
        // call it. Carried for `graph/derive.js`, which needs all three to build
        // an input node the graph reads on its own account; the renderer ignores
        // it exactly as it ignores `clip.id`, and for the same reason — it is a
        // fact about the document rather than about the render.
        inputInfo: over.inputInfo !== undefined ? over.inputInfo : specInputInfo(),
        // Which muxer, by name. Sent rather than left to the extension because
        // that is what `-f` means and because a hundred and eighty muxers
        // share about forty extensions between them — the file's name cannot
        // carry the choice.
        format: over.container || settings.container,
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
        // What the file is made of. An empty list is not "no streams" — it is
        // the renderer's own default of one video stream from the composite and
        // one audio stream from the mix, which is what `previewSpec()` below
        // asks for and why it can ask for it by handing over an empty array.
        streams: over.streams !== undefined ? over.streams : streamSpecs(over),
        chapters: over.chapters !== undefined ? over.chapters : settings.chapters,
        metadata: settings.metadata,
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

/// A render that is about the *picture*, not about the output file: the A/B
/// comparison on the Encode stage, and the node previews on the Graph stage.
///
/// **A preview must not inherit an eight-stream output.** Both of these exist
/// to show what something does to one picture — what the encoder costs it, what
/// a filter makes of it — and neither is a rehearsal of the file. A second
/// language track proves nothing about a wipe, a chapter table measured against
/// the whole timeline means nothing inside three seconds of it, and an
/// attachment re-read from disk for every node card on the Graph stage is work
/// for a picture nobody is looking at. Worse, an audio-only stream list would
/// leave the preview with no picture to compare at all.
///
/// So they ask for an empty list, which is the renderer's own sentinel for "one
/// video stream from the composite and one audio stream from the mix" — the
/// same file this application wrote before there was a list. One place decides
/// it, for the same reason `buildSpec()` is one place: there are four callers
/// and a preview rendered from a different description is a preview of
/// something else.
export function previewSpec(over = {}) {
    return buildSpec(Object.assign({ streams: [], chapters: [] }, over));
}
