// The settings, as the options ffmpeg would have been given.
//
// This is the join that makes the whole workspace one mechanism: a friendly
// control does not have a private path into the encoder, it produces a
// `-key value` pair here, and so does the raw option editor. They land in the
// same bag, the bag is applied with av_opt_set the way the ffmpeg command line
// applies its arguments, and neither can describe a render the other would not.

import { project } from '../project.js';
import { settings, outputFps } from './state.js';
import { audioInfo, hasOpt } from './capabilities.js';

/// Turn the rate-control choice into ffmpeg options. One place, so the summary
/// line, the preview and the export cannot describe three different renders.
function rateOptions(codec) {
    const out = {};
    const q = Math.round(settings.quality);
    switch (settings.rate) {
        case 'quality':
            if (hasOpt(codec, 'crf')) out.crf = q;
            else if (hasOpt(codec, 'cq')) {
                // nvenc's constant quality is a VBR mode with the bitrate
                // target taken out of the way; left in, it caps the quality
                // it was just told not to cap.
                out.cq = q;
                if (hasOpt(codec, 'rc')) out.rc = 'vbr';
                out.b = '0';
            } else if (hasOpt(codec, 'qp')) out.qp = q;
            break;
        case 'bitrate':
        // Two-pass is the same target said the same way; what differs is that
        // it is said twice, and `-pass`/`-passlogfile` are not encoder options
        // and so are not in this bag. They live on the passes — see
        // `passesFor()` in spec.js, which is the one place that decides a
        // render is two renders.
        case 'twopass':
            out.b = `${Math.max(1, Math.round(settings.videoBitrate))}k`;
            break;
        case 'constrained':
            out.b = `${Math.max(1, Math.round(settings.videoBitrate))}k`;
            out.maxrate = `${Math.max(1, Math.round(settings.maxrate || settings.videoBitrate * 1.5))}k`;
            out.bufsize = `${Math.max(1, Math.round(settings.bufsize || settings.videoBitrate * 3))}k`;
            break;
        case 'lossless':
            if (hasOpt(codec, 'lossless')) out.lossless = '1';
            else if (hasOpt(codec, 'crf')) out.crf = 0;
            else if (hasOpt(codec, 'qp')) out.qp = 0;
            break;
    }
    return out;
}

/// Everything the video encoder is being asked for, in one bag.
export function videoOptions(codec, over = {}) {
    const out = Object.assign({}, rateOptions(codec));

    if (settings.preset && hasOpt(codec, 'preset')) out.preset = settings.preset;
    if (settings.tune && hasOpt(codec, 'tune')) out.tune = settings.tune;
    if (settings.profile && hasOpt(codec, 'profile')) out.profile = settings.profile;

    const fps = over.fps || outputFps();
    if (settings.gopSeconds > 0) out.g = Math.max(1, Math.round(settings.gopSeconds * fps));
    if (settings.bframes >= 0) out.bf = settings.bframes;

    // Typed by hand, so it wins: the person who went looking for the option
    // name knows more about what they want than the slider does.
    return Object.assign(out, settings.extraVideo);
}

/// Where the edit is cut, in seconds from the start of the range.
///
/// **`-force_key_frames` is written against the output's clock**, not the
/// timeline's, because that is what makes a printed command run somewhere else
/// and produce the same file. So the range's start comes off every number here,
/// and a cut before the range or after it is not a cut in this render.
///
/// Derived on every call rather than stored, which is the whole point: a cut
/// point that was copied into a settings field when the button was pressed
/// would go on naming a moment nothing cuts at the first time a clip is
/// dragged. What is remembered is the *decision* — put keyframes where the edit
/// cuts — and this is that decision applied to the edit as it is now.
export function cutPoints(range) {
    const at = [];
    for (const c of project.clips) {
        for (const t of [c.start, c.start + c.length]) {
            if (t <= range.start + 1e-6 || t >= range.end - 1e-6) continue;
            const rel = t - range.start;
            if (!at.some((x) => Math.abs(x - rel) < 1e-3)) at.push(rel);
        }
    }
    at.sort((a, b) => a - b);
    return at;
}

/// `-force_key_frames`, resolved. One function for the same reason
/// `rateOptions` is one: the summary, the command bar, the preview and the
/// export each ask, and four readings of the same three settings is four
/// chances to describe different files.
export function forceKeyFrames(range) {
    switch (settings.keyframeMode) {
        case 'cuts': {
            const at = cutPoints(range);
            return at.map((t) => t.toFixed(3)).join(',');
        }
        case 'times':
            return String(settings.keyframeTimes || '').trim();
        case 'expr': {
            const e = String(settings.keyframeExpr || '').trim();
            // Written with the prefix ffmpeg wants, so what is stored is what
            // would be typed and the field holds the expression rather than the
            // expression plus a word about it.
            return e ? `expr:${e}` : '';
        }
        default:
            return '';
    }
}

export function audioOptions(codec) {
    const out = {};
    const info = audioInfo(codec);
    // A bitrate means nothing to a lossless encoder and FLAC rejects it.
    if (info && !info.lossless) out.b = `${Math.max(8, settings.audioCodecBitrate)}k`;
    return Object.assign(out, settings.extraAudio);
}

// There was a commandLine() here that printed this bag as `-key value` pairs
// for a line at the bottom of the export form. ui/command.js prints the whole
// invocation under every stage now, and two functions that turn options into a
// command line is one more than can be kept saying the same thing.
