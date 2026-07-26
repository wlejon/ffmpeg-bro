// The settings, as the options ffmpeg would have been given.
//
// This is the join that makes the whole workspace one mechanism: a friendly
// control does not have a private path into the encoder, it produces a
// `-key value` pair here, and so does the raw option editor. They land in the
// same bag, the bag is applied with av_opt_set the way the ffmpeg command line
// applies its arguments, and neither can describe a render the other would not.

import { project } from '../project.js';
import { settings } from './state.js';
import { audioInfo, hasOpt } from './capabilities.js';

/// Turn the rate-control choice into ffmpeg options. One place, so the summary
/// line, the preview and the export cannot describe three different renders.
export function rateOptions(codec) {
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

    const fps = over.fps || settings.fps || project.fps || 30;
    if (settings.gopSeconds > 0) out.g = Math.max(1, Math.round(settings.gopSeconds * fps));
    if (settings.bframes >= 0) out.bf = settings.bframes;

    // Typed by hand, so it wins: the person who went looking for the option
    // name knows more about what they want than the slider does.
    return Object.assign(out, settings.extraVideo);
}

export function audioOptions(codec) {
    const out = {};
    const info = audioInfo(codec);
    // A bitrate means nothing to a lossless encoder and FLAC rejects it.
    if (info && !info.lossless) out.b = `${Math.max(8, settings.audioCodecBitrate)}k`;
    return Object.assign(out, settings.extraAudio);
}

/// The options as ffmpeg would have been given them. Shown because it is the
/// shortest complete statement of what is about to happen, and because anyone
/// who knows ffmpeg can read it faster than they can read the form.
export function commandLine(codec) {
    const v = videoOptions(codec);
    const parts = [];
    for (const k of Object.keys(v)) parts.push(`-${k} ${v[k]}`);
    if (settings.pixelFormat) parts.push(`-pix_fmt ${settings.pixelFormat}`);
    return parts.join(' ') || 'encoder defaults';
}
