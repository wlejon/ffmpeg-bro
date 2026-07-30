// The edit, in the shape bro.ffmpeg.render.start wants.
//
// The placement rectangles come from viewer.placement() rather than from a
// second implementation of fit/zoom/pan/grid: the renderer must never learn
// about layout, and anything that changes how a clip is placed on screen has
// to change one function and let the export follow for free.

import { project, duration } from '../project.js';
import { inputs as documentInputs, specInputs, indexOf as inputIndex,
         lengthOf as inputLength, specInputInfo } from '../inputs.js';
import * as viewer from '../viewer.js';
import { settings, outputFps, outputExt } from './state.js';
import { muxerInfo, muxerForExtension } from './capabilities.js';
import { activeVersions, versionSize } from './versions.js';
import { videoOptions, audioOptions, forceKeyFrames } from './options.js';
import { streamSpecs } from './streams.js';
import { outputTarget, schemeOf, isTee } from './destination.js';
import { renderGraph } from '../filtergraph.js';
import { deviceForRender } from '../hardware.js';
import { parseCueTrack } from './subtitles.js';
import { trackById, cuesIn, cueFilePath, fileExtension, demuxerFor } from '../cues.js';
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
    // **A generator answers nothing, deliberately.** It has a probe like any
    // other clip — libavfilter's own answer about the pictures it makes — and it
    // is not a *source colour*: the tags this list carries exist so that the
    // graph can write the `in_color_matrix` the renderer reads off the file, and
    // a generator has no file to have been tagged. Left in, an untagged
    // `color=c=red` would be handed swscale's height-based guess as though it
    // were a statement, on frames libavfilter has just made. Absent, the
    // conversion is swscale's own default — which is exactly what
    // `ffmpeg -f lavfi -i color=c=red,scale=…` does, so the render and the
    // printed command are the same picture, which is the only claim this list is
    // for. `graph/derive.js` keeps it out of `caveats` for the same reason.
    return project.clips.map((c) => (!c.generator && c.probe && c.probe.video) || null);
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

/// The same edit again, at another size and under another name.
///
/// **Each version is a whole second spec, built by this same function**, and
/// only then flattened into an `ExportPass`. Deriving one by hand — scaling the
/// rectangles here, re-printing the graph there — would be a second
/// implementation of `buildSpec` living beside the first, and the two would
/// come to disagree the first time a placement rule changed. So the recursion
/// is the point rather than an economy: a version is *what this application
/// would render if you had asked for that size*, by construction.
///
/// The pass carries the size, the rectangles and the graph, because those three
/// are the whole of what a size changes. Everything else — the codec, the rate
/// control, the streams, the range — is left absent and read as the render's,
/// which is what makes a proxy the same render rather than a second one.
///
/// **Two versions and a two-pass encode is four walks, and this composes them
/// that way.** Each output gets the render's own pass list applied to it, so
/// the master's two passes are followed by the proxy's two, each with its own
/// statistics log — which is what a two-pass encode of a different size needs,
/// since the log is a record of where the bitrate went in *those* pictures.
function versionPasses(over, base) {
    // **A render aimed somewhere else has no versions.** Both halves of the A/B
    // preview are this render written to a temp file, and a proxy is a second
    // output *beside this render's own* — so a preview that carried one would
    // spend a second encode writing three seconds of timeline over the file
    // somebody is keeping. Read off `over.path` rather than a flag of its own
    // because that is the fact in question: a caller that named the
    // destination is not asking for this destination's companion.
    if (over.path !== undefined) return base;
    const list = activeVersions();
    if (!list.length) return base;

    // What one output is: the base list if there is one, or a single pass that
    // overrides nothing. `[{}]` and `undefined` are the same render, which is
    // what makes this safe to build unconditionally.
    const walks = base && base.length ? base : [{}];
    // Said in full on every pass, because with more than one output "pass 2" on
    // its own does not say which file is being written — and the status line
    // has room for one label.
    const label = (which, w, i) =>
        walks.length > 1 ? `${which} — ${w.label || `pass ${i + 1}`}` : which;

    const out = walks.map((w, i) => Object.assign({}, w, { label: label('the master', w, i) }));
    for (const v of list) {
        // Built with the version's size in hand, so every rectangle and every
        // chain of the filter graph is that version's rather than the master's
        // scaled afterwards.
        const size = versionSize(v, over.width || settings.width || project.width || 1920,
                                 over.height || settings.height || project.height || 1080);
        const sub = buildSpec(Object.assign({}, over, {
            width: size.width, height: size.height,
            // Not `path`: naming one is what tells this function it is building
            // a preview rather than the render, and a version is only ever the
            // render's companion.
            passes: null,
        }));
        for (let i = 0; i < walks.length; i++) {
            const w = walks[i];
            out.push(Object.assign({}, w, {
                label: label(`${sub.width}×${sub.height}`, w, i),
                path: v.path,
                format: v.format || formatFor(v.path),
                width: sub.width,
                height: sub.height,
                clips: sub.clips,
                filterGraph: sub.filterGraph,
                filterInputs: sub.filterInputs,
                // A two-pass version keeps its statistics somewhere of its own.
                // Sharing the master's log would have pass 2 of the proxy
                // spending a bitrate map measured on pictures three times the
                // size, which is not a smaller version of the same decision —
                // it is a different one.
                videoOptions: w.videoOptions && w.videoOptions.passlogfile
                    ? Object.assign({}, w.videoOptions,
                                    { passlogfile: `${w.videoOptions.passlogfile}-${v.id}` })
                    : w.videoOptions,
            }));
        }
    }
    return out;
}

/// The muxer for a version that named none: the same question libavformat asks
/// of a filename, asked here so the answer is on the pass rather than left to
/// be guessed twice.
function formatFor(path) {
    const ext = String(path || '').replace(/^.*\./, '');
    // Falling back to the render's muxer, **except when that muxer is `tee`**.
    // A tee's "path" is a list of destinations with an escaping language over
    // it, and a version has one plain path; handing it `tee` would open a
    // muxer that reads its filename as something it is not.
    const mine = settings.container === 'tee' ? '' : settings.container;
    return (ext && muxerForExtension(ext)) || mine || '';
}

/// Whether *this* destination gets a `fifo` in front of its muxer, and with
/// what.
///
/// **Three refusals, and each of them is a statement rather than a guard.**
///
///   - **Only a URL.** A `fifo` around a file on this machine is a queue and a
///     thread and nothing else: a local disk does not drop and come back, so the
///     wrapping would buy a second thread, an asynchronous open and a render
///     whose option errors arrive at the end instead of the start, in exchange
///     for nothing. Read off the path this spec is writing to, which is what
///     makes a preview to a temp file and a version to a local proxy answer
///     honestly without either being told about the other.
///   - **Not a `tee`.** One fifo in front of several destinations is one queue
///     and one recovery for all of them, so a single flaky endpoint would take
///     every other destination down and back with it — which is not what
///     "keep trying" means and is not what anybody asking for it wants. The
///     per-destination form is what ffmpeg's own documentation writes,
///     `[f=fifo:fifo_format=flv]rtmp://…`, and the destination rows can already
///     say exactly that: `-f fifo` on the row and `fifo_format` in its options.
///     Stated in the warnings rather than silently dropped.
///   - **The queue always drops rather than blocks.** fifo's own default is to
///     block, and a blocking fifo whose destination never comes up cannot be
///     stopped: its recovery loop spins on `EAGAIN` while
///     `!drop_pkts_on_overflow`, so the render thread waits inside
///     `av_interleaved_write_frame` on a full queue and the job's Stop — which
///     is checked once per output frame — never arrives. Measured: twenty
///     seconds of a four-second render, and a cancel that did nothing. Blocking
///     is right for a destination that is merely *slow* and stays reachable to a
///     spec written by hand; nothing this stage can do produces one.
///     `restart_with_keyframe` then always has something to drop, which is the
///     pair fifo refuses to have half-set.
function keepTrying(path) {
    const k = settings.keepTrying || {};
    const on = !!k.on && !!schemeOf(path) && !isTee();
    return {
        on,
        queueSize: k.queueSize || 0,
        waitSeconds: k.waitSeconds >= 0 ? k.waitSeconds : -1,
        maxAttempts: k.maxAttempts || 0,
        dropOnOverflow: true,
        restartWithKeyframe: !!k.restartWithKeyframe,
    };
}

/// Does this render have to go through libavfilter rather than the internal
/// compositor?
///
/// **One home, because there are two reasons now and they must not be asked
/// separately.** The two paths are measured against each other in
/// tests/export_test.cpp and agree to 43 dB, so this is a question about what is
/// *expressible* rather than about which is better:
///
///   - **A filter somebody placed.** The compositor cannot run an `hflip`. That
///     is `graph/overlay.js`'s `isEmpty()`, and it was the whole answer.
///   - **A generator clip.** The compositor composites frames read from `-i`s,
///     and a generator has no `-i` — its picture *is* a filter. Nothing about a
///     `testsrc` on the timeline is expressible on that path, so an edit holding
///     one is performed by libavfilter whether or not anybody has opened the
///     Graph stage. Asked of the spec's clips rather than of the model, so this
///     stays a function of the same object the render is driven from.
///
/// A render that needs the graph and cannot derive one is a warning rather than a
/// silent fallback — see `ui/export/warnings.js`, which asks this — because on
/// the compositor path a generator clip is a clip with no reader to open, and
/// libav's message about an empty path is not a sentence about what is wrong.
export function needsGraph(spec) {
    if (!isEmpty()) return true;
    return ((spec && spec.clips) || []).some((c) => c && c.generator);
}

/// What `-fps_mode` this render actually is, which is not always what the
/// setting says.
///
/// **`vfr` is the filter graph's own frame times, so a render with no graph in it
/// has none to keep.** `TimelineSource` composites the edit at whatever instant
/// it is handed — it can answer for any of them, so there is no set of timestamps
/// belonging to it, and a stack of clips at different rates has no answer to
/// "whose?" that is not invented. The same is true of a second picture leaving
/// the graph by a named pad: each pad produces at its own moments and one walk
/// over the frames has one timestamp to hand over.
///
/// So the setting is a *preference* and this is the answer for this render. The
/// renderer refuses `vfr` in either of those cases, by name and before a file is
/// opened, and it is right to — but a workspace left set to `vfr` that then has a
/// clip dropped on it must not become a render that will not start. The control
/// on the Encode stage says which of the two is in force and why, which is where
/// a refusal belongs when nothing is wrong.
///
/// One home, because three things read it: the spec sent to the renderer,
/// `ui/command.js`'s `-fps_mode` and the form's own sentence.
export function effectiveFpsMode(spec) {
    if (settings.fpsMode !== 'vfr') return 'cfr';
    if (!spec || !spec.filterGraph) return 'cfr';
    if ((spec.streams || []).some((s) => s && s.kind === 'video' &&
                                         String(s.source || '').startsWith('pad:')))
        return 'cfr';
    return 'vfr';
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
            // What this clip is *of*, when it is not of a file: a filter name and
            // its options. Carried for `graph/derive.js`, which puts that filter
            // at the head of the clip's run where an `-i` would go — and read by
            // nothing native, exactly as `clip.id` is, because it is a fact about
            // the edit and not about a reader the renderer has to open. A clip of
            // a file carries `undefined` and everything reads as it always did.
            generator: c.generator,
            start: c.start,
            // **The timeline length, and the source span is `length * speed`** —
            // the model's rounding, carried verbatim so that the renderer, the
            // derivation and the printed command all read it the one way. See
            // `ui/project.js`'s speed section; `ExportClip::speed` is the other
            // end of it.
            length: c.length,
            speed: c.speed,
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
        // Whether this destination is allowed to go away and come back. Decided
        // from the path this spec is actually writing to rather than from the
        // settings alone, which is what makes a preview to a temp file, a
        // version at another size and the master all get the honest answer
        // without any of them being told about the others.
        keepTrying: keepTrying(over.path || outputTarget() || defaultPath()),
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
        // Two reasons a render is more than one run over the frames, composed
        // in that order: a two-pass encode is two walks of one output, and a
        // version is another output. `null` is how the recursion inside
        // `versionPasses` says "this one, on its own" without being read as
        // "the settings' passes".
        passes: over.passes !== undefined
            ? (over.passes || undefined) : versionPasses(over, passesFor(over)),
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

    // Cues the document holds, turned into the one thing ffmpeg can read them
    // from. Before the graph below, because it adds `-i`s and the derivation
    // counts that list.
    attachCueFiles(spec);

    // Which of the renderer's two paths this render takes, decided in one
    // place — see `needsGraph()` for the two reasons it can be libavfilter.
    //
    // Attached here rather than at each `render.start`, because there are three
    // of them — the export, and both halves of the A/B preview — and a
    // reference rendered without the filters would be comparing the picture
    // against a different picture.
    lastGraph = null;
    if (needsGraph(spec)) {
        const g = renderGraph(spec, specSources(), { overlay: overlayState() });
        lastGraph = g;
        if (g.ok) {
            spec.filterGraph = g.filterGraph;
            spec.filterInputs = g.filterInputs;
        }
    }

    // `-fps_mode`, after the graph because it is a question about whether there
    // is one — see `effectiveFpsMode()`. A caller may name it, which is what the
    // headless test does; nothing in the UI does, because the setting is where
    // that decision lives.
    spec.fpsMode = over.fpsMode !== undefined ? over.fpsMode : effectiveFpsMode(spec);

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

/// A subtitle row reading the document's own cues, turned into an `-i` and a
/// `decode:` of it.
///
/// **ffmpeg has no way to receive cues except as a file**, so this is not a
/// translation of the edit into something approximate — it is the only exact
/// form the render has. What comes out the far side is an ordinary extra input
/// and an ordinary converted subtitle stream, which is why the renderer,
/// `ui/graph/derive.js` and `ui/command.js` have all needed no change: by the
/// time any of them sees the spec, `cues:3` is `decode:4:0` and the file is
/// named in `inputs`.
///
/// Four things this is careful about:
///
///   - **The file is named here and written by `ui/export.js`.** This function
///     runs on every keystroke on the Encode and Write stages, and a `writeFileSync`
///     from here would be a disk write per character typed into the output path.
///     `spec.cueFiles` is the handover — read by the render on the way past and
///     by the command bar's note, and ignored by the renderer exactly as
///     `clip.id` is.
///   - **The window is applied to the file, not to the row.** `copyFrom`/`copyTo`
///     go back to zero, because `cueFileText` has already shifted the cues onto
///     the output's clock and clamped one straddling the start; a `-ss` in front
///     of the `-i` as well would move every cue twice.
///   - **A track with nothing in the range writes no stream at all.** An empty
///     subtitle file is a stream a muxer writes a header for and no cues into,
///     which in a player looks exactly like a track that failed.
///   - **One file per track, however many outputs there are.** A version is
///     built by recursing through `buildSpec()` at another size, and the pass it
///     becomes overrides `path`, `clips` and the graph — never `inputs` or
///     `streams`. So both outputs read the one file, which is right: the cues do
///     not change with the picture's size, and two versions naming one filename
///     would otherwise be two writers racing for it.
function attachCueFiles(spec) {
    const rows = spec.streams || [];
    if (!rows.some((s) => parseCueTrack(s && s.source) !== null)) return;
    // Copied rather than pushed into, because a caller may have handed its own
    // `inputs` in through `over` and this must not grow somebody else's array.
    const inputs = (spec.inputs || []).slice();
    const info = (spec.inputInfo || []).slice();
    const files = [];
    const kept = [];
    for (const s of rows) {
        const id = parseCueTrack(s && s.source);
        if (id === null) { kept.push(s); continue; }
        const track = trackById(id);
        // A row naming a track that is not there, one with nothing in the range,
        // and one whose format this build cannot read back. All three are said by
        // `warnings()` rather than sent — a render refused over a row is a
        // refusal about the form, which is the same rule a pathless attachment
        // follows.
        if (!track || !cuesIn(track, spec.start, spec.end)) continue;
        const format = demuxerFor(fileExtension(track));
        if (!format) continue;
        const path = cueFilePath(track, spec.path);
        const at = inputs.length;
        inputs.push({ path, format, options: {}, decoderOptions: {},
                      hwaccel: '', hwaccelDevice: '', hwaccelOutputFormat: '',
                      ss: 0, to: 0, itsoffset: 0, streamLoop: 0 });
        // Index-aligned with `inputs`, which is the contract `specInputInfo()`
        // states. `streams: []` rather than `['v']`: this list is what decides
        // how many sockets a source card draws, and a file of cues offers a graph
        // nothing — a text track grows no pad, for the reason `streamKinds` gives.
        info.push({ id: `cues:${track.id}`, name: track.name, path,
                    streams: [], sampleRate: 0 });
        files.push({ id: track.id, path, from: spec.start, to: spec.end });
        kept.push(Object.assign({}, s, { source: `decode:${at}:0`,
                                         copyFrom: 0, copyTo: 0 }));
    }
    spec.inputs = inputs;
    spec.inputInfo = info;
    spec.streams = kept;
    if (files.length) spec.cueFiles = files;
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

/// What a render was *of* — the pictures and samples that went through it — as
/// one string that can be compared with a later one.
///
/// **The subject of a measurement, and the reason it can go stale.** A filter
/// that answers a question answers it about a particular render: `cropdetect`
/// found those black bars in the picture it was shown, and `ebur128` measured
/// the mix it was handed. Move a clip afterwards and the numbers stay on the
/// screen describing an edit that no longer exists, which is the one failure
/// this application's whole argument is against — a number that looks like it
/// worked.
///
/// **Derived from the spec rather than from a list of what counts as an edit.**
/// A hand-written list of fields would have to be extended by whoever adds the
/// next kind of edit, and the failure of forgetting is silent: a measurement
/// that goes on looking current. So this reads the spec, which is already the
/// one description everything downstream agrees on. Between the two paths that
/// covers everything either of them sees — `filterGraph` is the printed chain,
/// so on the libavfilter path the trims, the scales and the overlays are all in
/// that one string, and on the compositor path `clips` carries the same facts.
///
/// **What is deliberately left out is the output.** The container, the codecs,
/// the bitrate, the stream list and the file's name change how the result is
/// written and not what the filters were shown, so folding them in would mark
/// an hour-old loudness measurement stale because somebody typed a title. The
/// exception people will reach for is `psnr`/`ssim` in the A/B comparison,
/// which genuinely is about an encoder — and it is not measured through this
/// path at all: it renders both halves itself and reports them together.
/// **Two fields and not one string**, because "what changed" decides the
/// sentence. The A/B comparison and the node previews render the same edit over
/// a two-second window of it, so a single blob would come back different the
/// moment one ran and report "the edit has changed" about an edit nobody
/// touched. The window is a real difference — a `cropdetect` from two seconds
/// in the middle is not a measurement of the whole range, and offering it as
/// one is the failure this exists to stop — so it is kept and named separately
/// rather than dropped to make the comparison quiet.
export function renderSubject(spec) {
    const s = spec || currentSpec();
    return {
        edit: JSON.stringify({
            inputs: s.inputs,
            clips: s.clips,
            graph: s.filterGraph || '',
            graphInputs: s.filterInputs || null,
            width: s.width, height: s.height, fps: s.fps,
        }),
        from: s.start,
        to: s.end,
    };
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
