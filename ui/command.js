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
import { filtergraph, outputColor } from './filtergraph.js';
import { settings, outputExt } from './export/state.js';
import { buildSpec, specSources } from './export/spec.js';
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

/// Quoting for a shell. Only when it is needed, because a command line full of
/// quotes that do nothing is harder to read and this one is meant to be read.
function arg(v) {
    const s = String(v);
    return /[\s"'\\$`&|;<>(){}[\]*?!#~]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
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

/// Everything the encoder is told, as `-key value` pairs. Assembled from the
/// spec rather than from the option bag alone, because the bag is not the whole
/// of what the encoder ends up configured with — the named fields below are
/// settings of the renderer's own, and a command missing them describes a
/// different file from the one about to be written.
export function parts() {
    const spec = buildSpec();
    const codec = spec.videoCodec;
    const g = filtergraph(spec, specSources(), { overlay: overlayState() });
    const colour = outputColor(spec);

    const pre = ['ffmpeg'];
    if (settings.scaler && settings.scaler !== 'bicubic')
        pre.push('-sws_flags', settings.scaler);

    // Each `-i` with what belongs *in front of* it. That order is most of what
    // makes a printed command runnable: `-f`, the demuxer's options, `-ss`,
    // `-to` and `-itsoffset` are input options, and the same words after the
    // `-i` are output options meaning something else entirely — `-ss` after it
    // seeks the *output*, and a command that put them there would produce a
    // different file while looking almost right.
    const inputs = [];
    if (g.ok) {
        g.inputs.forEach((p, i) => {
            const src = (spec.inputs || [])[(g.inputRefs || [])[i]];
            if (src) {
                // First of the input options, because it is the one that says
                // there is more of this input than the file has in it. The
                // rest — `-framerate`, `-start_number`, `-loop`, `-safe` —
                // arrive through the option bag below, since every one of them
                // is a demuxer option and travels the way `-probesize` does.
                if (src.streamLoop) inputs.push('-stream_loop', String(src.streamLoop));
                if (src.format) inputs.push('-f', arg(src.format));
                for (const k of Object.keys(src.options || {}))
                    if (src.options[k] !== '' && src.options[k] !== undefined)
                        inputs.push(`-${k}`, arg(src.options[k]));
                if (src.ss) inputs.push('-ss', String(src.ss));
                if (src.to) inputs.push('-to', String(src.to));
                if (src.itsoffset) inputs.push('-itsoffset', String(src.itsoffset));
            }
            inputs.push('-i', arg(p));
        });
    }

    // What the file is made of, in the order the muxer will number it. The
    // spec's list is authoritative — it is what `render.start` is handed — so
    // the command is written from it rather than from the settings the list was
    // built out of, and the two cannot come to describe different files.
    const streams = spec.streams && spec.streams.length ? spec.streams : [];
    const nVideo = streams.filter((s) => s.kind === 'video').length;
    const nAudio = streams.filter((s) => s.kind === 'audio').length;

    const out = [];
    // One `-map` per stream, which is what a stream list *is* in ffmpeg's
    // terms. Two video streams of the same pad is a legitimate thing to want —
    // one h264 for compatibility, one HEVC for size — and it is the same label
    // mapped twice.
    if (g.ok) {
        for (let i = 0; i < nVideo; i++) out.push('-map', arg(g.video));
        if (g.audio) for (let i = 0; i < nAudio; i++) out.push('-map', arg(g.audio));
    }
    if (!nVideo) out.push('-vn');
    if (!g.ok || !g.audio || !nAudio) out.push('-an');

    let vi = 0, ai = 0, ti = 0;
    for (const s of streams) {
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
            const v = s.options || {};
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
            describe(out, s, 'v', idx, nVideo);
            continue;
        }
        if (!g.ok || !g.audio) continue;
        const idx = ai++;
        out.push(`-c:${sel('a', idx, nAudio)}`, s.codec || spec.audioCodec);
        const a = s.options || {};
        for (const k of Object.keys(a)) out.push(`-${k}:${sel('a', idx, nAudio)}`, arg(a[k]));
        if (spec.sampleRate) out.push(`-ar:${sel('a', idx, nAudio)}`, String(spec.sampleRate));
        if (spec.channels) out.push(`-ac:${sel('a', idx, nAudio)}`, String(spec.channels));
        describe(out, s, 'a', idx, nAudio);
    }

    if (settings.faststart && spec.format === 'mp4')
        out.push('-movflags', '+faststart');
    if (settings.title) out.push('-metadata', arg(`title=${settings.title}`));
    for (const k of Object.keys(spec.metadata || {}))
        if (spec.metadata[k] !== '') out.push('-metadata', arg(`${k}=${spec.metadata[k]}`));
    // Whatever the muxer was told beyond its defaults. These reach it through
    // the same `av_opt_set`-with-children route the encoder options take, so
    // they are as exact as the rest of this line — and a `-hls_time` the file
    // was written with but the command did not mention is the sort of omission
    // this bar exists to make impossible.
    for (const k of Object.keys(spec.formatOptions || {}))
        if (spec.formatOptions[k] !== '' && spec.formatOptions[k] !== undefined)
            out.push(`-${k}`, arg(spec.formatOptions[k]));
    // `-f` last before the path, where ffmpeg wants it, and always — not only
    // when the extension disagrees. The render is told which muxer by name, so
    // a command that left it to be guessed from the filename would be a
    // different invocation from the one being run.
    if (spec.format) out.push('-f', spec.format);
    out.push(arg(spec.path || `out.${outputExt()}`));

    return { spec, graph: g, pre, inputs, out };
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
    const bits = p.pre.concat(p.inputs);
    if (p.graph.ok) bits.push('-filter_complex', arg(p.graph.chains.join(';')));
    return bits.concat(p.out).join(' ');
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

    const empty = !project.clips.length;
    show(refs.copy, !empty);
    refs.bar.classList.toggle('empty', empty);
    if (empty) { put(refs.line, () => []); lastText = ''; return; }

    const p = parts();
    lastText = commandText();

    put(refs.line, () => {
        const bits = [span(p.pre.concat(p.inputs).join(' ') + GAP, 'cmd-exact')];
        if (p.graph.ok) {
            bits.push(span('-filter_complex' + GAP, 'cmd-exact'));
            // Dimmed, and on its own lines when opened, because this is the
            // half that is a translation rather than a transcript.
            bits.push(span(arg(p.graph.chains.join(open ? ';\n  ' : ';')) + GAP, 'cmd-equiv'));
        }
        bits.push(span(p.out.join(' '), 'cmd-exact'));
        if (open) bits.push(notes(p));
        return bits;
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
        noUserNodes()
            ? [span('Equivalent: ', 'lead'),
               'this binary composites internally rather than running a filter graph, so ' +
               'the graph above is a translation. Measured against the render it describes, ' +
               'it comes out around 39 dB — the same picture, not the same bits.']
            : [span('Run, not translated: ', 'lead'),
               'there are filters of your own in this graph, so the render goes through ' +
               'libavfilter and these are the chains it parses — all but the last, which ' +
               'converts into the encoder’s colour and is the writer’s job here.'],
    ];
    // No graph means the second line is about something that is not on screen,
    // so it goes and the refusal takes its place.
    if (!p.graph.ok) {
        lines.length = 1;
        lines.push([span('No graph: ', 'lead'),
                    `${p.graph.reason}, so the command above is incomplete.`]);
    }
    for (const c of (p.graph.caveats || []))
        lines.push([span('Differs: ', 'lead'), c + '.']);

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
