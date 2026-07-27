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
import { el, div, span, put, show } from './dom.js';
import { filtergraph, outputColor } from './filtergraph.js';
import { settings } from './export/state.js';
import { videoOptions, audioOptions } from './export/options.js';
import { buildSpec } from './export/spec.js';
import { containerInfo } from './export/capabilities.js';

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

/// The spec, plus what probe() said about each clip's video stream — which is
/// where the source colour tags come from, and the single biggest thing
/// standing between the graph and the render it describes.
function sourcesFor() {
    return project.clips.map((c) => (c.probe && c.probe.video) || null);
}

/// Everything the encoder is told, as `-key value` pairs. Assembled here rather
/// than taken from `commandLine()` in options.js because that one answers a
/// different question — what the *options bag* holds — and this one has to
/// answer what the encoder ends up configured with, named fields included.
export function parts() {
    const spec = buildSpec();
    const codec = spec.videoCodec;
    const g = filtergraph(spec, sourcesFor());
    const colour = outputColor(spec);

    const pre = ['ffmpeg'];
    if (settings.scaler && settings.scaler !== 'bicubic')
        pre.push('-sws_flags', settings.scaler);

    const inputs = [];
    if (g.ok) for (const p of g.inputs) inputs.push('-i', arg(p));

    const out = [];
    if (g.ok) {
        out.push('-map', arg(g.video));
        if (g.audio) out.push('-map', arg(g.audio));
    }
    if (!g.ok || !g.audio) out.push('-an');

    out.push('-c:v', codec);
    const v = videoOptions(codec);
    for (const k of Object.keys(v)) out.push(`-${k}`, arg(v[k]));
    if (settings.pixelFormat) out.push('-pix_fmt', settings.pixelFormat);
    // The renderer sets a two-second GOP unless told otherwise; x264 left alone
    // uses 250 frames. A command without this writes a differently-keyframed
    // file from the one the preview measured.
    if (v.g === undefined)
        out.push('-g', String(Math.max(1, Math.round((spec.fps || 30) * 2))));
    out.push('-colorspace', colour.matrix,
             '-color_primaries', colour.primaries,
             '-color_trc', colour.transfer,
             '-color_range', colour.range);

    if (g.ok && g.audio) {
        out.push('-c:a', spec.audioCodec);
        const a = audioOptions(spec.audioCodec);
        for (const k of Object.keys(a)) out.push(`-${k}:a`, arg(a[k]));
        if (spec.sampleRate) out.push('-ar', String(spec.sampleRate));
        if (spec.channels) out.push('-ac', String(spec.channels));
    }
    if (settings.faststart && (containerInfo(settings.container) || {}).ext === 'mp4')
        out.push('-movflags', '+faststart');
    if (settings.title) out.push('-metadata', arg(`title=${settings.title}`));
    out.push(arg(spec.path || 'out.' + settings.container));

    return { spec, graph: g, pre, inputs, out };
}

/// The whole thing as one runnable string. What Copy puts on the clipboard, and
/// what the tests compare against.
export function commandText() {
    const p = parts();
    const bits = p.pre.concat(p.inputs);
    if (p.graph.ok) bits.push('-filter_complex', arg(p.graph.chains.join(';')));
    return bits.concat(p.out).join(' ');
}

export function draw() {
    if (!refs.line) return;
    const empty = !project.clips.length;
    show(refs.copy, !empty);
    refs.bar.classList.toggle('empty', empty);
    if (empty) { put(refs.line, () => []); lastText = ''; return; }

    const p = parts();
    lastText = commandText();

    put(refs.line, () => {
        const bits = [span(p.pre.concat(p.inputs).join(' ') + ' ', 'cmd-exact')];
        if (p.graph.ok) {
            bits.push(span('-filter_complex ', 'cmd-exact'));
            // Dimmed, and on its own lines when opened, because this is the
            // half that is a translation rather than a transcript.
            bits.push(span(arg(p.graph.chains.join(open ? ';\n  ' : ';')) + ' ', 'cmd-equiv'));
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
        [span('Equivalent: ', 'lead'),
         'this binary composites internally rather than running a filter graph, so ' +
         'the graph above is a translation. Measured against the render it describes, ' +
         'it comes out around 39 dB — the same picture, not the same bits.'],
    ];
    if (!p.graph.ok)
        lines.length = 1, lines.push([span('No graph: ', 'lead'), p.graph.reason +
                                      ', so the command above is incomplete.']);
    for (const c of (p.graph.caveats || []))
        lines.push([span('Differs: ', 'lead'), c + '.']);
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
