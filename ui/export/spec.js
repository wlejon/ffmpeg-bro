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
import { videoOptions, audioOptions, forceKeyFrames } from './options.js';
import { streamSpecs } from './streams.js';
import { outputTarget } from './destination.js';
import { renderGraph } from '../filtergraph.js';
import { deviceForRender } from '../hardware.js';
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

/// The same path with the frame number taken out of it.
///
/// **The grammar is `av_get_frame_filename2`'s and not printf's**, which is a
/// narrower thing than it looks: libavformat reads `%`, then a run of digits,
/// then one character — so `%d` and `%04d` are the number, `%%` is a literal
/// per cent, and the printf flags are not accepted at all. A regex written
/// against printf therefore stripped `%-3d` from `out%-3d.png`, which libav
/// reads as no pattern at all and this application correctly draws as "One
/// picture"; and it matched the second `%` of `100%%d bonus.png`, which is what
/// `escapePercent` in `ffmpeg_sequence.cpp` writes when a path has a per cent
/// in it, turning the name into `100% bonus.png`.
///
/// So the question is asked before it is answered: `hasFramePattern` is
/// `av_filename_number_test`, the same call image2 makes, and a name it does
/// not read as a run of files is handed back untouched.
export function withoutPattern(path) {
    const s = String(path || '');
    if (!s || !bro.ffmpeg.hasFramePattern(s)) return s;
    let out = '';
    for (let i = 0; i < s.length;) {
        if (s[i] !== '%') { out += s[i++]; continue; }
        let j = i + 1;
        while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
        if (s[j] === 'd') { out += s.slice(j + 1); return out; }
        if (s[j] === '%') { out += '%%'; i = j + 1; continue; }
        out += s[i++];
    }
    return out;
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

/// A render that is two renders, when the rate control asked for one.
///
/// **`-pass` and `-passlogfile` are not encoder options**, so they do not go in
/// the option bag — they are the two entries that differ between the passes,
/// which is exactly what `ExportPass` is for. A pass's `videoOptions` are merged
/// on top of the render's, so saying these two is the whole of what a two-pass
/// encode is.
///
/// Pass one is `discard`ed: `-f null -`, running everything and keeping
/// nothing, because what it produces is the statistics log beside the output
/// and not the pictures. The log is a real file in the temp directory, since
/// the handoff between passes is always a file on disk.
///
/// Here rather than at each `render.start` for the reason the filter graph is
/// attached here: there are three renders on this stage and a reference or a
/// preview that quietly ran one pass would be comparing against a different
/// encode.
export function passesFor(over = {}) {
    if (settings.rate !== 'twopass') return undefined;
    // The reference half of the A/B comparison names its own options — it is a
    // lossless render and there is no bitrate for a second pass to spend — so a
    // caller that has taken the option bag over has taken the passes with it.
    if (over.videoOptions !== undefined) return undefined;
    const log = bro.ffmpeg.tempPath('twopass');
    return [
        { label: 'pass 1 — finding where the bitrate is needed',
          discard: true,
          videoOptions: { pass: '1', passlogfile: log } },
        { label: 'pass 2 — spending it',
          videoOptions: { pass: '2', passlogfile: log } },
    ];
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
    // The seconds this particular render covers, which for a preview is a
    // window inside the range. Worked out before the spec because
    // `-force_key_frames` is written against the output's own clock: a cut
    // point is a moment in *this* file, so a preview of the middle of the range
    // forces its keyframes where the cuts fall inside the preview.
    const window = {
        start: over.start !== undefined ? over.start : r.start,
        end: over.end !== undefined ? over.end : r.end,
    };

    const spec = {
        // Where it goes, which is not always a path: `-f tee` takes its
        // destinations in the filename, and `outputTarget()` is the one place
        // that assembles them. A preview overrides it with a temp file, as it
        // overrides everything else about the output.
        path: over.path || outputTarget() || defaultPath(),
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
        // Where the zero of the render's clock is, which is the range's start
        // and *not* this window's. They differ for every preview: a node card
        // and the A/B comparison each render two seconds out of the middle of
        // the range, and a filter carrying `enable='between(t,10,20)'` means
        // ten seconds into the render, not ten seconds into whatever window
        // happens to be being drawn. Ignored by the renderer, which is given a
        // graph with the offset already in it; see `origin` in graph/derive.js.
        origin: over.origin !== undefined ? over.origin : r.start,
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
        // None of these four is an encoder option, which is why each is a named
        // field: `-force_key_frames` sets a frame's picture type before the
        // encoder sees it, the field order has to reach the frames as well as
        // the encoder, `-threads` was hardcoded, and `-shortest` ends the loop
        // the writer is being fed from.
        forceKeyFrames: over.forceKeyFrames !== undefined
            ? over.forceKeyFrames : forceKeyFrames(window),
        fieldOrder: settings.fieldOrder,
        threads: settings.threads,
        threadType: settings.threadType,
        shortest: settings.shortest,
        passes: over.passes !== undefined ? over.passes : passesFor(over),
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
    lastGraph = null;
    if (!isEmpty()) {
        const g = renderGraph(spec, specSources(), { overlay: overlayState() });
        lastGraph = g;
        if (g.ok) {
            spec.filterGraph = g.filterGraph;
            spec.filterInputs = g.filterInputs;
        }
    }

    // `-filter_hw_device`, derived rather than asked for. Two things in a
    // render name a device — an input that decodes on one, and a filter that
    // belongs to one — and `hwupload` takes no argument that could name a
    // third, so there is nothing for a separate control to add except a second
    // place that has to be set to agree. Derived here for the reason the graph
    // above is attached here: there are three `render.start`s and a preview
    // that ran without the device would be a preview of a graph that will not
    // configure.
    const device = deviceForRender(spec.filterGraph, spec.inputs);
    if (device) {
        spec.filterHwDevice = device;
        // Which one, when an input said. A graph that named a device by its
        // filters has no index to take, and the default device is what ffmpeg
        // would use for the same command.
        const named = (spec.inputs || []).find((i) => i.hwaccel === device && i.hwaccelDevice);
        if (named) spec.filterHwDeviceIndex = named.hwaccelDevice;
    }
    return spec;
}

// ── the same spec, asked for five times ────────────────────────────────────
//
// `warnings()` asked `buildSpec()` for one three times and derived a graph a
// fourth; `parts()` asks for a fifth. Both run on every redraw of the export
// panel, which redraws on every keystroke — so five full derivations of the
// same edit, each walking every clip through `viewer.placement()` and building
// a filtergraph, for one answer that could not have changed between them.
//
// **Nothing in `buildSpec()` is wrong to be there and it is deliberately not
// decomposed.** The three fields the renderer ignores — `clip.id`, `inputInfo`
// and `origin` — each exist for `graph/derive.js` and each are documented where
// they are set. It is simply not free, and it was being called as though it
// were.
//
// **The memo lives for exactly one answer.** Each of the two readers begins
// with `freshSpec()` and everything inside it takes `currentSpec()`, so the
// cache cannot outlive a synchronous call and there is no model change it could
// be stale across. The obvious alternative — invalidating from listeners — would
// have to name every place a setting is written, which is most of the export
// UI and all of the tests that write into `settings` directly, and a spec that
// is quietly one edit behind is worse than a slow one.

/// The `renderGraph()` answer the last `buildSpec()` made, or null where the
/// overlay was empty and there was nothing to derive.
///
/// A side channel rather than part of the return, because `buildSpec()`'s
/// answer is the spec — it is what `render.start` is handed and what five other
/// callers read — and wrapping it would touch every one of them. `currentGraph()`
/// is the only reader and it takes it in the same breath as the spec.
let lastGraph = null;
let cache = null;

/// Build one now, and hold it for whatever asks next. The entry point.
export function freshSpec() { cache = null; return currentSpec(); }

/// The spec this answer is being written about.
export function currentSpec() {
    if (!cache) cache = { spec: buildSpec(), graph: lastGraph };
    return cache.spec;
}

/// The derivation that spec was built with — `{ ok, filterGraph, graph }` or
/// `{ ok: false, reason }`, and null where there was no user graph to derive.
export function currentGraph() {
    currentSpec();
    return cache.graph;
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
