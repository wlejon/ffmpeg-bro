// What is about to happen, in ffmpeg's own words.
//
// This application's argument is that ffmpeg should stop being a thing you
// guess at. That argument is not made by a friendly form — every ffmpeg GUI
// has one — it is made by never hiding the invocation. So the command runs
// under every stage, it is live, and it is complete enough to be taken
// somewhere else and run.
//
// **It is two kinds of statement and it has to be drawn as two.** Everything
// past the compositor is *exact*: those keys are literally what
// `av_opt_set(ctx, k, v, AV_OPT_SEARCH_CHILDREN)` is called with, which is the
// same path the ffmpeg CLI uses for its own `-key value` arguments. The
// composition is *equivalent*: ffmpeg_export.cpp decodes into an RGBA canvas
// and composites there rather than building a filter graph, so the graph shown
// is a translation — see ui/filtergraph.js, which says how good a one and how
// that was measured. Printing them in one undifferentiated colour would be a
// lie of exactly the kind this screen exists to stop.
//
// Three things reach the encoder that are *not* in `videoOptions()`, and every
// one of them changes the picture. They are named fields on the spec that the
// renderer turns into settings of its own, so a command built only from the
// option bag would be quietly incomplete — which is worse than obviously so:
//
//   - the colour tags and the conversion into them (worth ~13 dB, measured);
//   - the keyframe interval, which defaults to two seconds of frames here and
//     to 250 in x264;
//   - the scaler, which is a flag and not an option.

import { project } from './project.js';
import { div, span, put, show } from './dom.js';
import { shellArg as arg } from './format.js';
import { filtergraph, outputColor } from './filtergraph.js';
import { settings, outputExt } from './export/state.js';
import { freshSpec, specSources, needsGraph } from './export/spec.js';
import { parseCopy } from './export/copy.js';
import { parseDecode, defaultSubtitleCodec } from './export/subtitles.js';
import { parsePad } from './export/pads.js';
import { kindOf, escapeDictArg } from './export/destination.js';
import { muxerInfo } from './export/capabilities.js';
import { current as overlayState, isEmpty as noUserNodes } from './graph/overlay.js';
import { commandParts as captureParts } from './capture.js';
import { currentStage } from './shell.js';

// The space between one span and the next, non-breaking on purpose. The line
// is three spans because it is three kinds of statement, and an ordinary space
// at the end of an inline box is whitespace at a seam: collapsed away, it drew
// `…/clip.mp4-filter_complex"color=…` — one argument where the command has
// two. The copied string was always right, which is the worse way round, since
// the thing on screen is the thing that gets read. It never reaches the
// clipboard: `commandText()` is assembled separately, from the same parts.
const GAP = '\u00a0';

/// What shape the destination is, for the notes below. Asked of the muxer and
/// the path rather than stated, exactly as the Write stage asks it.
const destinationKind = () => kindOf(muxerInfo(settings.container) || {});

let refs = {};
let open = false;
let lastText = '';

export function initCommand(r) {
    refs = r;
    refs.toggle.addEventListener('click', () => {
        open = !open;
        refs.bar.classList.toggle('open', open);
        refs.toggle.textContent = open ? '\u25BE' : '\u25B8';
        draw();
    });
    refs.copy.addEventListener('click', copy);
}

// The video options that an audio encoder also has, and so the ones that have
// to say which stream they are for. Unqualified, `-b 8000k` in a command line
// means every stream — and a command whose audio bitrate depends on ffmpeg
// reading `-b` before `-b:a` is not one worth handing to anybody. The renderer
// has no such ambiguity, since it calls av_opt_set on one context at a time,
// which is why this belongs here and not in the option bag.
const PER_STREAM = new Set(['b', 'maxrate', 'bufsize', 'q', 'qscale', 'profile', 'level']);

/// The stream specifier one output stream is addressed by: `v`, or `v:1` once
/// there is more than one of that kind.
///
/// Indexed only when it has to be. `-c:v libx264` is what everybody writes and
/// what everybody reads, and a bar that printed `-c:v:0` for the file that is a
/// picture and a soundtrack would be paying for the four-track case on every
/// render. With two audio streams the index is not decoration: unqualified,
/// `-metadata:s:a language=fra` claims both of them.
const sel = (kind, idx, count) => (count > 1 ? `${kind}:${idx}` : kind);

/// A key for one stream. Some options belong to every stream unless they say
/// otherwise — `-b 8000k` in a command line means the audio too — so those
/// carry the specifier even when there is only one stream to carry it.
function keyFor(name, kind, idx, count) {
    if (count > 1) return `${name}:${sel(kind, idx, count)}`;
    return PER_STREAM.has(name) ? `${name}:${kind}` : name;
}

/// `-metadata:s:v:0 title=…`, `-disposition:a:1 +forced`, `-tag:v hvc1`.
///
/// Everything a stream is told that is not its bitstream. Printed here because
/// it reaches the muxer: the whole claim of this bar is that nothing does so
/// silently, and a language written into a file by a form nobody can see the
/// command for is exactly the thing this application exists to stop.
function describe(out, s, kind, idx, count) {
    const at = sel(kind, idx, count);
    const meta = s.metadata || {};
    if (s.language) out.push(`-metadata:s:${at}`, arg(`language=${s.language}`));
    for (const k of Object.keys(meta))
        if (meta[k] !== '' && meta[k] !== undefined)
            out.push(`-metadata:s:${at}`, arg(`${k}=${meta[k]}`));
    if (s.disposition) out.push(`-disposition:${at}`, arg(s.disposition));
    if (s.tag) out.push(`-tag:${at}`, arg(s.tag));
}

/// `-bsf:v h264_mp4toannexb,dump_extra=freq=k`.
///
/// One argument for the whole chain, comma-separated in the order it runs, with
/// each filter's own options after an `=` and separated by `:` — which is
/// libavcodec's `av_bsf_list_parse_str` syntax and therefore what the renderer
/// builds by hand out of the same list. Printed as one argument because that is
/// what it is: `-bsf:v a -bsf:v b` on a command line is not two filters, it is
/// the second one overriding the first.
function bsfArgs(out, s, kind, idx, count) {
    const chain = (s.bsf || []).filter((b) => b.name);
    if (!chain.length) return;
    const text = chain.map((b) => {
        const opts = Object.keys(b.options || {})
            .filter((k) => b.options[k] !== '' && b.options[k] !== undefined)
            .map((k) => `${k}=${b.options[k]}`);
        return opts.length ? `${b.name}=${opts.join(':')}` : b.name;
    }).join(',');
    out.push(`-bsf:${sel(kind, idx, count)}`, arg(text));
}

/// Everything the encoder is told, as `-key value` pairs. Assembled from the
/// spec rather than from the option bag alone, because the bag is not the whole
/// of what the encoder ends up configured with — the named fields below are
/// settings of the renderer's own, and a command missing them describes a
/// different file from the one about to be written.
export function parts() {
    // One derivation for this whole invocation. `warnings()` opens its own for
    // the same reason: a memo that lived past a synchronous answer would have
    // to know about every place a setting is written.
    const spec = freshSpec();
    const codec = spec.videoCodec;
    const g = filtergraph(spec, specSources(), { overlay: overlayState() });
    const colour = outputColor(spec);

    /// The graph a pass prints, which for a version is not the render's.
    ///
    /// **Only the chains differ, and that is a fact rather than an economy.** A
    /// version is the same edit at another size: the same clips out of the same
    /// `-i`s, so the same input list, the same numbering and the same output
    /// labels — everything the `-map`s are planned against. What changes is
    /// what the chains scale *to*, which is inside the `-filter_complex`
    /// argument and nowhere else.
    ///
    /// Derived here rather than carried on the pass because `derive.js` is a
    /// pure function of a spec: given the same size and the same rectangles it
    /// cannot come to a different graph from the one `buildSpec` attached, and
    /// a printed string that was handed over instead of worked out is the one
    /// thing this bar exists not to be.
    const graphOf = (pass) => {
        if (!pass || !pass.clips || !pass.clips.length) return g;
        return filtergraph(Object.assign({}, spec, {
            width: pass.width || spec.width,
            height: pass.height || spec.height,
            clips: pass.clips,
        }), specSources(), { overlay: overlayState() });
    };

    const pre = ['ffmpeg'];
    if (settings.scaler && settings.scaler !== 'bicubic')
        pre.push('-sws_flags', settings.scaler);
    // `-filter_hw_device`, which is a *global* option in ffmpeg's grammar and
    // is therefore here rather than in front of an `-i` or after the graph.
    // `hwupload` takes no argument that could name a device and reads this
    // instead, so a command that left it out would parse and then refuse with
    // "A hardware device reference is required to upload frames to".
    if (spec.filterHwDevice)
        pre.push('-filter_hw_device', spec.filterHwDevice +
                 (spec.filterHwDeviceIndex ? ':' + spec.filterHwDeviceIndex : ''));

    // Which `-i`s a copied stream needs, and where they land in the printed
    // numbering.
    //
    // **A `-map` counts input files on the command line**, and the graph's own
    // `[0:v]` counts the same list — so a copy has to be printed as one of these
    // inputs and know its own index, not the index it happens to have in the
    // document. Graph inputs first, because their labels are already written
    // against that order; a copied input that is not among them is appended and
    // takes the next number. A copy of a file the graph is also reading is one
    // `-i` and not two, which is the same rule the renderer follows: one input,
    // one demuxer, one seek.
    // A converted subtitle track reads an input too — `-map 1:0 -c:s mov_text`
    // — so it needs an `-i` and an index for exactly the same reason a copy
    // does. One list, because "which streams read a file directly" is one
    // question and two lists would be two answers to it.
    const copies = (spec.streams || [])
        .map((s) => ({ s, at: parseCopy(s.source) || parseDecode(s.source),
                       copied: !!parseCopy(s.source) }))
        .filter((c) => c.at);
    const order = g.ok ? (g.inputRefs || []).slice() : [];
    const printedPath = g.ok ? g.inputs.slice() : [];
    for (const c of copies) {
        if (order.indexOf(c.at.input) >= 0) continue;
        const src = (spec.inputs || [])[c.at.input];
        order.push(c.at.input);
        printedPath.push(src ? src.path : '');
    }
    // What each printed input has to seek to, when a copy is what reads it.
    // `-ss` before the `-i` is an *input* seek: the demuxer jumps to the
    // keyframe at or before it, which is exactly what a copy can do and is why
    // a lossless cut is instant. The same word after the `-i` is an output seek
    // — every packet read from the start of the file and then thrown away —
    // which is slower and, with `-c copy`, starts the file on a frame nothing
    // can decode.
    const copySeek = new Map();
    for (const c of copies) {
        const cur = copySeek.get(c.at.input) || { ss: Infinity, to: 0 };
        cur.ss = Math.min(cur.ss, Number(c.s.copyFrom) || 0);
        cur.to = Number(c.s.copyTo) > 0 ? Math.max(cur.to, Number(c.s.copyTo)) : cur.to;
        copySeek.set(c.at.input, cur);
    }

    // Each `-i` with what belongs *in front of* it. That order is most of what
    // makes a printed command runnable: `-f`, the demuxer's options, `-ss`,
    // `-to` and `-itsoffset` are input options, and the same words after the
    // `-i` are output options meaning something else entirely — `-ss` after it
    // seeks the *output*, and a command that put them there would produce a
    // different file while looking almost right.
    const inputs = [];
    {
        printedPath.forEach((p, i) => {
            const which = order[i];
            const src = (spec.inputs || [])[which];
            const seek = copySeek.get(which);
            if (src) {
                // First of the input options, because it is the one that says
                // there is more of this input than the file has in it. The
                // rest — `-framerate`, `-start_number`, `-loop`, `-safe` —
                // arrive through the option bag below, since every one of them
                // is a demuxer option and travels the way `-probesize` does.
                if (src.streamLoop) inputs.push('-stream_loop', String(src.streamLoop));
                if (src.format) inputs.push('-f', arg(src.format));
                // Where this input's pictures are decoded, and whether they
                // come back down. In front of the `-i` like everything else
                // here, and for the same reason: they configure the decoder
                // this input's packets go through, and there is no such thing
                // as choosing that afterwards. `-hwaccel_output_format` is the
                // one that changes what the *graph* is handed, so a command
                // that printed it in the wrong place would run and produce
                // something else.
                if (src.hwaccel) inputs.push('-hwaccel', arg(src.hwaccel));
                if (src.hwaccelDevice)
                    inputs.push('-hwaccel_device', arg(src.hwaccelDevice));
                if (src.hwaccelOutputFormat)
                    inputs.push('-hwaccel_output_format', arg(src.hwaccelOutputFormat));
                for (const k of Object.keys(src.options || {}))
                    if (src.options[k] !== '' && src.options[k] !== undefined)
                        inputs.push(`-${k}`, arg(src.options[k]));
                // The decoders reading this input, and so also in front of the
                // `-i`: `-skip_frame` after it would be an output option that
                // means nothing. A different bag from the demuxer's above
                // because they are different objects with different tables,
                // printed together because that is where ffmpeg wants both.
                for (const k of Object.keys(src.decoderOptions || {}))
                    if (src.decoderOptions[k] !== '' && src.decoderOptions[k] !== undefined)
                        inputs.push(`-${k}`, arg(src.decoderOptions[k]));
                // The input's own window, and then the copy's on top of it. A
                // copy's `copyFrom` is measured on the input's clock — after
                // its `-ss` — and a command line has only one `-ss` per input,
                // so the two are added. Both are input options and both have to
                // stay in front of the `-i`: after it, `-ss` would read the
                // whole file and throw the front away, and the copy would begin
                // on a frame with no keyframe behind it.
                const ss = (src.ss || 0) + (seek && isFinite(seek.ss) ? seek.ss : 0);
                const to = seek && seek.to > 0 ? (src.ss || 0) + seek.to : (src.to || 0);
                if (ss) inputs.push('-ss', String(Number(ss.toFixed(3))));
                if (to) inputs.push('-to', String(Number(to.toFixed(3))));
                if (src.itsoffset) inputs.push('-itsoffset', String(src.itsoffset));
            }
            inputs.push('-i', arg(p));
        });
    }
    /// Where a printed `-i` sits in the command's own numbering.
    const printedIndex = (specIndex) => order.indexOf(specIndex);

    // What the file is made of, in the order the muxer will number it. The
    // spec's list is authoritative — it is what `render.start` is handed — so
    // the command is written from it rather than from the settings the list was
    // built out of, and the two cannot come to describe different files.
    const streams = spec.streams && spec.streams.length ? spec.streams : [];
    const nVideo = streams.filter((s) => s.kind === 'video').length;
    const nAudio = streams.filter((s) => s.kind === 'audio').length;
    const nSub = streams.filter((s) => s.kind === 'subtitle').length;
    const nData = streams.filter((s) => s.kind === 'data').length;

    // Whether anything maps the graph at all. A rewrap maps input pads and
    // nothing else, so printing a `-filter_complex` beside it would be printing
    // a composition nothing reads — a command that is longer, slower and
    // describes work the render is not doing.
    const graphUsed = g.ok && streams.some(
        (s) => !parseCopy(s.source) && (s.kind === 'video' || s.kind === 'audio'));
    // `-sn` for the same reason `-vn` and `-an` are printed: a command that
    // says nothing about subtitles lets ffmpeg's own stream selection put one
    // in, and an mp4 built from a source that had a text track would come out
    // with a track this render did not write.
    //
    // **There is deliberately no `-dn` beside them.** ffmpeg's automatic
    // selection picks one video, one audio and one subtitle stream and never a
    // data one, so a render with no data row is already a file with no data
    // track in it. Printed anyway it would read as this application turning
    // something off, which is the opposite of what happens: a telemetry track
    // is carried only because a row on the list says to.
    const noSubs = nSub === 0;

    // The output half, once per pass.
    //
    // **A two-pass render is two invocations and this prints two.** ffmpeg has
    // no way to say it in one, and the halves genuinely differ — the first
    // writes statistics through `-f null -` and keeps no file, the second reads
    // them and writes the output — so folding them into one line would print a
    // command that produces a different result from the render.
    const tail = (pass) => {
    const out = [];
    // One `-map` per stream, which is what a stream list *is* in ffmpeg's
    // terms. Two video streams of the same pad is a legitimate thing to want —
    // one h264 for compatibility, one HEVC for size — and it is the same label
    // mapped twice.
    //
    // A copied stream maps an *input pad* rather than a filtergraph label —
    // `-map 0:1` — and the number is the printed input's, which is why the
    // `-i`s were planned before this. Everything else maps the graph's output.
    for (const s of streams) {
        const at = parseCopy(s.source) || parseDecode(s.source);
        if (at) {
            const n = printedIndex(at.input);
            if (n >= 0) out.push('-map', `${n}:${at.stream}`);
            continue;
        }
        if (!g.ok) continue;
        // A pad of the graph, named by whoever placed the output it leaves by.
        // It reads no input directly, so nothing about the plan above changes:
        // the label is produced by a chain in the `-filter_complex` that is
        // already being printed.
        const pad = parsePad(s.source);
        if (pad) { out.push('-map', arg(`[${pad}]`)); continue; }
        if (s.kind === 'video' && g.video) out.push('-map', arg(g.video));
        else if (s.kind === 'audio' && g.audio) out.push('-map', arg(g.audio));
    }
    if (noSubs) out.push('-sn');
    if (!nVideo) out.push('-vn');
    // A soundtrack can now arrive three ways, and `-an` has to answer for all
    // three: the mix, a copied track, and a pad of the graph. Left out, a render
    // whose only sound is a `sine` on a named output printed `-map "[bed]"` and
    // `-an` in the same command.
    const padAudio = streams.some((s) => s.kind === 'audio' && parsePad(s.source));
    if (!nAudio || (!copies.some((c) => c.s.kind === 'audio') && !padAudio &&
                    (!g.ok || !g.audio)))
        out.push('-an');

    let vi = 0, ai = 0, ti = 0, si = 0, di = 0;
    for (const s of streams) {
        // A subtitle stream, either way it is read. `-c:s copy` carries the
        // packets and `-c:s mov_text` decodes and writes them again, and the
        // `-map` above is the same line for both — which is exactly the
        // distinction ffmpeg's own command line draws and the reason this is
        // one branch rather than two.
        if (s.kind === 'subtitle') {
            const idx = si++;
            out.push(`-c:${sel('s', idx, nSub)}`,
                     parseCopy(s.source) ? 'copy'
                                         : (s.codec || defaultSubtitleCodec(settings.container)));
            bsfArgs(out, s, 's', idx, nSub);
            describe(out, s, 's', idx, nSub);
            continue;
        }
        // `-c:v copy` and nothing else. Not one of the encoder options below
        // applies — there is no encoder — and printing a `-crf` beside a
        // `copy` would be printing a command that means something different
        // from the render.
        const at = parseCopy(s.source);
        if (at) {
            // `d` is a stream specifier like any other, and a data stream is
            // the one kind that can only ever appear here: there is no encoder
            // to print an alternative branch for.
            const kind = s.kind === 'audio' ? 'a' : s.kind === 'data' ? 'd' : 'v';
            const n = kind === 'a' ? nAudio : kind === 'd' ? nData : nVideo;
            const idx = kind === 'a' ? ai++ : kind === 'd' ? di++ : vi++;
            out.push(`-c:${sel(kind, idx, n)}`, 'copy');
            bsfArgs(out, s, kind, idx, n);
            describe(out, s, kind, idx, n);
            continue;
        }
        if (s.kind === 'attachment') {
            // `-attach` is an output option, and the mimetype rides on the
            // attachment's own stream index — `t` counts attachments, not
            // streams, exactly as `v` counts video.
            out.push('-attach', arg(s.path));
            if (s.mimeType) out.push(`-metadata:s:t:${ti}`, arg(`mimetype=${s.mimeType}`));
            ti++;
            continue;
        }
        if (s.kind === 'video') {
            const idx = vi++;
            out.push(`-c:${sel('v', idx, nVideo)}`, s.codec || codec);
            const v = Object.assign({}, s.options, (pass && pass.videoOptions) || {});
            for (const k of Object.keys(v)) out.push(`-${keyFor(k, 'v', idx, nVideo)}`, arg(v[k]));
            if (settings.pixelFormat)
                out.push(`-pix_fmt:${sel('v', idx, nVideo)}`, settings.pixelFormat);
            // The renderer sets a two-second GOP unless told otherwise; x264
            // left alone uses 250 frames. A command without this writes a
            // differently-keyframed file from the one the preview measured.
            if (v.g === undefined)
                out.push(`-${keyFor('g', 'v', idx, nVideo)}`,
                         String(Math.max(1, Math.round((spec.fps || 30) * 2))));
            out.push('-colorspace', colour.matrix,
                     '-color_primaries', colour.primaries,
                     '-color_trc', colour.transfer,
                     '-color_range', colour.range);
            // Everything else the video stream is told that is not an encoder
            // option, and so not in the bag above. Each of these is a decision
            // the writer takes on its own account, which is exactly why a
            // command built from the option bag alone would be incomplete.
            if (spec.forceKeyFrames)
                out.push(`-force_key_frames:${sel('v', idx, nVideo)}`, arg(spec.forceKeyFrames));
            if (spec.fieldOrder) {
                out.push(`-flags:${sel('v', idx, nVideo)}`, '+ildct+ilme');
                out.push(`-field_order:${sel('v', idx, nVideo)}`, spec.fieldOrder);
            }
            if (spec.threads) out.push(`-threads:${sel('v', idx, nVideo)}`, String(spec.threads));
            if (spec.threadType)
                out.push(`-thread_type:${sel('v', idx, nVideo)}`, spec.threadType);
            // **Which walk this render is, and `-r` beside it where it is the
            // fixed one.** `cfr` is the range walked at the output rate with each
            // frame stamped by its number, and ffmpeg needs to be told what rate
            // that is or it takes the filter output's — which for a graph with an
            // `fps` in it is a different number and therefore a different file.
            // `vfr` keeps the graph's own frame times, so naming a rate is
            // precisely what must not be printed. `spec.fpsMode` rather than the
            // setting, because a render that composites is `cfr` whatever the
            // setting says: one home, in `effectiveFpsMode()`.
            if (spec.fpsMode === 'vfr') {
                out.push(`-fps_mode:${sel('v', idx, nVideo)}`, 'vfr');
            } else {
                out.push(`-r:${sel('v', idx, nVideo)}`, String(spec.fps || 30));
                out.push(`-fps_mode:${sel('v', idx, nVideo)}`, 'cfr');
            }
            bsfArgs(out, s, 'v', idx, nVideo);
            describe(out, s, 'v', idx, nVideo);
            continue;
        }
        // The mix, or a pad of the graph. Either way there is an encoder and it
        // has to be named; what there has to be is a graph for it to read.
        if (!g.ok || (!g.audio && !parsePad(s.source))) continue;
        const idx = ai++;
        out.push(`-c:${sel('a', idx, nAudio)}`, s.codec || spec.audioCodec);
        const a = s.options || {};
        for (const k of Object.keys(a)) out.push(`-${k}:${sel('a', idx, nAudio)}`, arg(a[k]));
        if (spec.sampleRate) out.push(`-ar:${sel('a', idx, nAudio)}`, String(spec.sampleRate));
        if (spec.channels) out.push(`-ac:${sel('a', idx, nAudio)}`, String(spec.channels));
        bsfArgs(out, s, 'a', idx, nAudio);
        describe(out, s, 'a', idx, nAudio);
    }

    // Output-wide, so after the streams and before the muxer's own options.
    if (spec.shortest) out.push('-shortest');

    // A pass that keeps nothing: everything above it runs, and the pictures go
    // to the null muxer. Nothing after this point applies — there is no file to
    // put an index at the front of and no metadata to write into it.
    if (pass && pass.discard) {
        out.push('-f', 'null', '-');
        return out;
    }

    // Whatever the muxer was told beyond its defaults, gathered before it is
    // written because *where* it goes on the line depends on whether the muxer
    // is wrapped. These reach it through the same `av_opt_set`-with-children
    // route the encoder options take, so they are as exact as the rest of this
    // line — and a `-hls_time` the file was written with but the command did not
    // mention is the sort of omission this bar exists to make impossible.
    const muxerArgs = [];
    if (settings.faststart && spec.format === 'mp4')
        muxerArgs.push(['movflags', '+faststart']);
    for (const k of Object.keys(spec.formatOptions || {}))
        if (spec.formatOptions[k] !== '' && spec.formatOptions[k] !== undefined)
            muxerArgs.push([k, String(spec.formatOptions[k])]);

    // `-metadata` is not one of them and stays where it always was: ffmpeg
    // writes it into the output context's own dictionary rather than through an
    // option table, and `fifo_mux_init` copies that dictionary into the muxer it
    // wraps — so a wrapped render's title reaches the file by the same route.
    if (settings.title) out.push('-metadata', arg(`title=${settings.title}`));
    for (const k of Object.keys(spec.metadata || {}))
        if (spec.metadata[k] !== '') out.push('-metadata', arg(`${k}=${spec.metadata[k]}`));

    // `-f` last before the path, where ffmpeg wants it, and always — not only
    // when the extension disagrees. The render is told which muxer by name, so
    // a command that left it to be guessed from the filename would be a
    // different invocation from the one being run.
    // The pass's own muxer and its own path, where it has them. A version is
    // another output of the same render, so this is the one place the two
    // invocations genuinely part company — and a bar that printed the master's
    // filename twice would be printing a command that writes one file.
    const format = (pass && pass.format) || spec.format;
    // A destination that is allowed to go away is written the way ffmpeg writes
    // one: `-f fifo` is the muxer on the command line and the real muxer is
    // `-fifo_format`'s argument. Exactly what the render does — `Writer::open`
    // allocates a `fifo` context and sets the same keys with `av_opt_set` — so
    // this belongs in the exact half of the bar and the line runs as printed.
    //
    // **A pass writes its own file and answers for itself.** A version at
    // another size is another output with another path, and only a pass whose
    // path is the URL gets the wrapping; the spec's `keepTrying.on` was already
    // decided against the path this spec is writing to (see `keepTrying()` in
    // export/spec.js), so a pass that overrides the path overrides this with it.
    const fifo = (pass && pass.keepTrying) || spec.keepTrying;
    if (fifo && fifo.on && !(pass && pass.path && pass.path !== spec.path)) {
        out.push('-f', 'fifo');
        if (format) out.push('-fifo_format', format);
        out.push('-attempt_recovery', '1');
        if (fifo.queueSize > 0) out.push('-queue_size', String(fifo.queueSize));
        // Seconds here and on the stage; a bare number in an ffmpeg duration is
        // microseconds, so it is printed the way libav reads it.
        if (fifo.waitSeconds >= 0)
            out.push('-recovery_wait_time', String(Math.round(fifo.waitSeconds * 1e6)));
        if (fifo.maxAttempts > 0)
            out.push('-max_recovery_attempts', String(fifo.maxAttempts));
        if (fifo.dropOnOverflow) out.push('-drop_pkts_on_overflow', '1');
        if (fifo.restartWithKeyframe) out.push('-restart_with_keyframe', '1');
        // **The wrapped muxer's own options cannot be written as flags**, and
        // that is not a stylistic choice: the muxer on the command line is
        // `fifo`, ffmpeg applies its output options to *that* context, and
        // `-movflags` on a fifo is "Option movflags not found" and an exit. They
        // travel in fifo's `format_opts`, which is a dictionary spelt as one
        // argument — see `escapeDictArg`. The renderer does the same thing
        // without the string, through `av_opt_set_dict_val`.
        if (muxerArgs.length)
            out.push('-format_opts',
                     arg(muxerArgs
                             .map(([k, v]) => `${escapeDictArg(k)}=${escapeDictArg(v)}`)
                             .join(':')));
    } else {
        for (const [k, v] of muxerArgs) out.push(`-${k}`, arg(v));
        if (format) out.push('-f', format);
    }
    out.push(arg((pass && pass.path) || spec.path || `out.${outputExt()}`));
    return out;
    };

    // One tail for an ordinary render, one per pass for a render that is two.
    // The list is the spec's, so this cannot come to disagree with what the
    // renderer was handed about how many times the range is walked.
    const passes = spec.passes && spec.passes.length ? spec.passes : [null];
    const tails = passes.map(tail);
    const graphs = passes.map(graphOf);

    return { spec, graph: g, graphs, graphUsed, pre, inputs,
             out: tails[tails.length - 1], tails, passes };
}

/// What the bar is describing right now.
///
/// The Capture stage is not part of the render being configured — it is its
/// own pipeline, one device into one file — so while it is up the bar prints
/// *that*, and printing the timeline's render under it would be describing a
/// command nobody is about to run. Everything in a capture is exact: there is
/// no compositing and therefore no filtergraph to translate, which is why the
/// shape is the same minus the one dimmed part.
function describing() {
    if (currentStage() !== 'capture') return null;
    return captureParts();
}

/// The whole thing as one runnable string, which is what Copy puts on the
/// clipboard. Anything outside this module wants `currentCommand()` — the
/// string the bar is actually showing, rather than one built again from a
/// model that may have moved since.
function commandText() {
    const cap = describing();
    if (cap) return cap.pre.concat(cap.inputs, cap.out).join(' ');
    const p = parts();
    // One line per pass, in order, because that is how a two-pass render is run
    // by hand. Pasted into a shell they run one after the other, which is what
    // this binary does with them in one job.
    //
    // The head is rebuilt per line rather than shared, because a version's
    // `-filter_complex` scales to its own size: the `-i`s are the same and the
    // graph is not.
    return p.tails.map((t, i) => {
        const head = p.pre.concat(p.inputs);
        if (p.graphUsed) head.push('-filter_complex',
                                   arg((p.graphs[i] || p.graph).chains.join(';')));
        return head.concat(t).join(' ');
    }).join('\n');
}

export function draw() {
    if (!refs.line) return;

    const cap = describing();
    if (cap) {
        show(refs.copy, true);
        refs.bar.classList.remove('empty');
        lastText = commandText();
        put(refs.line, () => [
            span(cap.pre.concat(cap.inputs).join(' ') + GAP, 'cmd-exact'),
            span(cap.out.join(' '), 'cmd-exact'),
            open ? div('cmd-note', [div('', [
                span('Exact: ', 'lead'),
                'all of it. A capture is one device into one file with nothing composited ' +
                'in between, so there is no filtergraph here to be a translation of ' +
                'anything — the device options are what av_opt_set is called with and the ' +
                'encoder options are what the writer is given.',
            ]), div('', [
                span('Before the -i: ', 'lead'),
                'everything the device is opened with, including -t. After it those same ' +
                'words are output options meaning something else — -t after the -i limits ' +
                'the output rather than the capture.',
            ])]) : null,
        ].filter(Boolean));
        return;
    }

    // A render that copies packets has no timeline behind it — a rewrap is one
    // input and one muxer — so an empty edit is not an empty command.
    const empty = !project.clips.length &&
                  !(settings.streams || []).some((s) => parseCopy(s.source));
    show(refs.copy, !empty);
    refs.bar.classList.toggle('empty', empty);
    if (empty) { put(refs.line, () => []); lastText = ''; return; }

    const p = parts();
    lastText = commandText();

    put(refs.line, () => {
        const bits = [];
        // A pass at a time, each a whole invocation. With one pass — every
        // render that is not two-pass — this is the single line it always was,
        // because `tails` has one entry and nothing is labelled.
        p.tails.forEach((t, i) => {
            if (p.passes[i] && p.passes[i].label)
                bits.push(span(`# ${p.passes[i].label}\n`, 'cmd-pass'));
            bits.push(span(p.pre.concat(p.inputs).join(' ') + GAP, 'cmd-exact'));
            if (p.graphUsed) {
                bits.push(span('-filter_complex' + GAP, 'cmd-exact'));
                // Dimmed, and on its own lines when opened, because this is the
                // half that is a translation rather than a transcript.
                bits.push(span(arg((p.graphs[i] || p.graph).chains.join(open ? ';\n  ' : ';')) +
                               GAP, 'cmd-equiv'));
            }
            bits.push(span(t.join(' ') + (i + 1 < p.tails.length ? '\n' : ''), 'cmd-exact'));
        });
        if (open) bits.push(notes(p));
        return bits;
    });
}

/// Does any chain read an input's **subtitle** pad?
///
/// Asked of the graph rather than of the spec's inputs, because what matters is
/// whether a wire leaves such a pad: an `-i` with a `dvdsub` track in it that
/// nothing is drawing says nothing about the command. Exported nowhere — the note
/// below is the only caller and the graph is already in hand.
function drawsCues(g) {
    if (!g || !g.ok || !g.graph) return false;
    return g.graph.edges.some((e) => {
        const from = g.graph.node(e.from);
        if (!from || from.kind !== 'input' || !from.outs) return false;
        const pad = from.outs[e.fromPort || 0];
        return !!pad && pad.stream === 's';
    });
}

/// What is exact, what is not, and what is known to differ about *this*
/// render. Only when the bar is open: it is the explanation, not the headline,
/// and a disclaimer that is always on screen is one nobody reads.
function notes(p) {
    const lines = [
        [span('Exact: ', 'lead'),
         'everything but the filtergraph — those keys are what av_opt_set is called with.'],
        // Which of the two the graph is depends on which path this render takes,
        // and the whole point of printing a command is that the claim about it
        // is true. With a filter of your own in the graph the render *is* the
        // graph, and saying "translation" would be underselling it by exactly
        // the amount that matters.
        //
        // Asked of `needsGraph()` rather than of the overlay, because there are
        // two reasons the render is the graph and only one of them is a filter
        // somebody placed: a generator clip has no `-i` to composite from, so an
        // edit holding one is run through libavfilter with nothing on the Graph
        // stage at all. One home for that question, or this bar would call a
        // graph a translation while the renderer parsed it.
        !needsGraph(p.spec)
            ? [span('Equivalent: ', 'lead'),
               'this binary composites internally rather than running a filter graph, so ' +
               'the graph above is a translation. Measured against the render it describes, ' +
               'it comes out around 39 dB — the same picture, not the same bits.']
            : [span('Run, not translated: ', 'lead'),
               'this render goes through libavfilter and these are the chains it parses — ' +
               'all but the last, which converts into the encoder’s colour and is the ' +
               'writer’s job here.'],
    ];
    // **The one pad in a printed chain that libavfilter does not make.** Said
    // rather than left in the graph looking like every other wire, because the
    // line above it claims the chains are what libavfilter parses and for this
    // one pad that is not true: `[0:s]` is ffmpeg's *CLI* painting cues into
    // frames (sub2video), which is what this renderer does too — so the command
    // runs and draws the same pictures, and the chain pasted into something that
    // only parses a filtergraph does not.
    if (drawsCues(p.graph))
        lines.push([span('Cues, drawn: ', 'lead'),
                    'libavfilter has no subtitle input — [0:s] reaching an overlay is ' +
                    'ffmpeg’s own sub2video, which decodes the cues and paints each one into ' +
                    'a frame the size of the picture it was authored against before feeding ' +
                    'an ordinary buffer source. This render does exactly that, so the command ' +
                    'above runs and draws the same cues; what that one wire is not is a link ' +
                    'libavfilter makes, so a tool that parses only a filtergraph will refuse ' +
                    'it. A text track cannot go this way at all — drawing characters is ' +
                    'libass’s job, which is the subtitles filter.']);

    const streams = p.spec.streams || [];
    const copied = streams.filter((s) => parseCopy(s.source));
    const allCopied = copied.length && copied.length === streams.length;

    // No graph means the second line is about something that is not on screen,
    // so it goes and the refusal takes its place — unless there is nothing for
    // a graph to describe, which is what a render made entirely of copied
    // streams is. A rewrap has no composition to translate and saying "the
    // graph cannot be expressed" about it would be reporting a problem that
    // does not exist.
    if (!p.graphUsed) {
        lines.length = 1;
        if (!allCopied)
            lines.push([span('No graph: ', 'lead'),
                        `${p.graph.reason}, so the command above is incomplete.`]);
    }

    // **A clip's speed resamples its sound**, and that is worth one line because it
    // is the one thing about a speed nobody can read off the command:
    // `asetrate=<rate>*<speed>,aresample=<rate>` is in the printed chain and what
    // it means is not obvious from it. Said only where there is a sped-up clip,
    // like everything else in this list — and said *after* the truncation above,
    // because it is true of the render whether or not there is a graph on screen to
    // read it out of. The pitch-preserving alternative is named because it is real
    // and one stage away; see `ui/project.js`'s speed section for why it is not the
    // default.
    const fast = (p.spec.clips || []).filter((c) => Number(c.speed) > 0 &&
                                                    Number(c.speed) !== 1);
    if (fast.length)
        lines.push([span('Speed: ', 'lead'),
                    `${fast.length === 1 ? 'a clip plays' : `${fast.length} clips play`} at a ` +
                    'speed of its own, which is a divisor on the setpts that puts it on the ' +
                    'render’s clock and a resample of its sound — so the pitch moves with the ' +
                    'speed. Preserving it is atempo, a filter you can place on the Graph ' +
                    'stage; the compositor has no graph to hold one, and the two paths have ' +
                    'to describe one render. A copied stream cannot be sped up at all.']);

    // The one distinction people get wrong about a copy, said where the two
    // arguments are a foot apart on the screen. It is not trivia: the same
    // three characters on either side of the `-i` are two different operations,
    // and only one of them can produce a lossless cut.
    if (allCopied)
        lines[0] = [span('Exact: ', 'lead'),
                    'all of it — a render made only of copied streams has no composition ' +
                    'in it to be a translation of.'];
    if (copied.length)
        lines.push([span('Copied: ', 'lead'),
                    `${copied.length} stream${copied.length === 1 ? '' : 's'} go in as the ` +
                    'packets that are already there — no decode, no filter, no encoder, and ' +
                    'nothing from the Compose or Graph stages reaches them. The -ss and -to ' +
                    'sit before the -i, which is an input seek: the demuxer jumps to the ' +
                    'keyframe at or before it, and that is why a copy starts there. After ' +
                    'the -i they would be an output seek — the whole file read and the front ' +
                    'discarded, slower and beginning on a frame nothing can decode.']);
    // Where it goes, when that is not a filename. Both of these change what the
    // last argument on the line *is*, and neither is legible from the argument
    // itself: a tee spec looks like a filename with punctuation in it, and a
    // URL looks like a filename that happens to have a scheme.
    const kind = destinationKind();
    if (kind === 'several')
        lines.push([span('Several destinations: ', 'lead'),
                    'the last argument is not a filename — it is tee’s own list, separated ' +
                    'by | with each destination’s muxer in [ ]. It is escaped twice on the ' +
                    'way here: once for tee, which reads a backslash, and once for the ' +
                    'shell, which is what the quotes are. One encode reaches all of them.']);
    if (kind === 'stream')
        lines.push([span('A stream: ', 'lead'),
                    'the output is a URL, so the render is pushed as it is made. The ' +
                    'protocol’s options are the ones the muxer did not recognise, printed ' +
                    'in the same place — libavformat hands them down to the AVIO layer, ' +
                    'which is the same route they take at the reading end.']);
    if (p.spec.keepTrying && p.spec.keepTrying.on)
        lines.push([span('Wrapped in a fifo: ', 'lead'),
                    'the muxer on the line is fifo and the real one is -fifo_format’s ' +
                    'argument, which is exactly what the render allocates. Its own options ' +
                    'go in -format_opts rather than as flags, because ffmpeg applies output ' +
                    'options to the muxer it was named with and fifo has never heard of ' +
                    'them. A render that reconnects has a gap in the file where the ' +
                    'destination was gone, and the report says how many times.']);
    if (kind === 'files')
        lines.push([span('A set of files: ', 'lead'),
                    'this muxer writes more than the file it is named with. What the ' +
                    'command says is what it is told; how many files come out is decided ' +
                    'by its own options and by where the keyframes are.']);

    for (const c of (p.graph.caveats || []))
        lines.push([span('Differs: ', 'lead'), c + '.']);

    if (p.tails.length > 1)
        lines.push([span('Two commands: ', 'lead'),
                    'a two-pass render is two invocations and ffmpeg has no way to say it ' +
                    'in one. The first writes the statistics through -f null - and keeps ' +
                    'no file; the second reads them and writes the output. This binary ' +
                    'runs both as one job, with one Stop and one progress bar.']);

    // **Cues this document holds, and the `-i` that is how they get there.**
    // ffmpeg has no way to receive cues except as a file, so a render writes one
    // and reads it back — which is not a compromise but the only exact form, and
    // it is why the command above stays *runnable* rather than joining the
    // chapters below in the "not expressible" line. Said because the `-i` looks
    // like a file somebody added on the Sources stage and is not: nothing put it
    // there, this render did.
    const cueFiles = p.spec.cueFiles || [];
    if (cueFiles.length)
        lines.push([span('Cues, written: ', 'lead'),
                    `${cueFiles.length === 1 ? 'one of the -i files above is'
                                             : `${cueFiles.length} of the -i files above are`} ` +
                    'not something you added — the render writes ' +
                    `${cueFiles.length === 1 ? 'it' : 'them'} beside the output from the cues ` +
                    'this document holds, because ffmpeg takes cues from an input and there ' +
                    'is nowhere else to put them. The times in the file are already the ' +
                    'output’s, which is why there is no -ss in front of it. Run this command ' +
                    'after a render and the file is there; run it before one and it is not.']);

    // The one thing on this stage that an ffmpeg command line genuinely cannot
    // say. There is no `-chapter` option: ffmpeg takes chapters from an input,
    // so the equivalent is an FFMETADATA file and a second `-i`. Printing one
    // would be printing a file that does not exist, and quietly dropping them
    // would make the command describe a different output — so it is said.
    if ((p.spec.chapters || []).length)
        lines.push([span('Not expressible: ', 'lead'),
                    `the ${p.spec.chapters.length} chapter marks. ffmpeg reads chapters from ` +
                    'an input rather than from an option, so a command that wrote them would ' +
                    'need an FFMETADATA file and a second -i; this render writes them directly.']);
    return div('cmd-note', lines.map((l) => div('', l)));
}

function copy() {
    if (!lastText) return;
    // bro's clipboard where there is one; the field is a fallback that at least
    // lets the command be selected by hand.
    try {
        if (typeof bro !== 'undefined' && bro.clipboard && bro.clipboard.setText) {
            bro.clipboard.setText(lastText);
            if (refs.flash) refs.flash('Command copied');
            return;
        }
    } catch (e) { /* fall through to saying so */ }
    if (refs.flash) refs.flash('No clipboard here — the command is above, in full');
    if (!open) refs.toggle.click();
}

/// For the tests, and for anything that wants the string without the panel.
export function currentCommand() { return lastText || commandText(); }
