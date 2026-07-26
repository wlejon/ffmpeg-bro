// What this build can write, asked of libavcodec.
//
// Nothing here is a table of what encoders are like. Every answer comes from
// bro.ffmpeg, which got it from avcodec_get_supported_config, from the
// encoder's own AVOption table, or from avformat_query_codec — so the form
// drawn on top of this cannot offer a control the encoder does not have, and
// an ffmpeg upgrade changes the app without anyone editing it.

export const containers = () => (bro.ffmpeg.containers || []);
export const videoEncoders = () => (bro.ffmpeg.encoders || []);
export const audioEncoders = () => (bro.ffmpeg.audioEncoders || []);

export function encoderInfo(id) {
    return videoEncoders().find((e) => e.id === id) || null;
}

export function audioInfo(id) {
    return audioEncoders().find((e) => e.id === id) || null;
}

export function containerInfo(ext) {
    return containers().find((c) => c.ext === ext) || containers()[0] || null;
}

// bro.ffmpeg.encoderOptions() reads the encoder's AVOption table. Cached per
// encoder because x265 has some eighty options and the form redraws on every
// keystroke in the search box.
const optionCache = new Map();

export function optionsOf(codec) {
    if (!codec) return [];
    if (!optionCache.has(codec)) {
        try {
            optionCache.set(codec, bro.ffmpeg.encoderOptions(codec) || []);
        } catch (e) {
            optionCache.set(codec, []);
        }
    }
    return optionCache.get(codec);
}

export function optionNamed(codec, name) {
    return optionsOf(codec).find((o) => o.name === name) || null;
}

export const hasOpt = (codec, name) => optionNamed(codec, name) !== null;

/// The rate-control modes this encoder can actually be put into. Asked of the
/// options rather than assumed from the name: nvenc has no crf but has cq,
/// ProRes has neither, and offering a control that does nothing is worse than
/// offering none.
export function rateModes(codec) {
    const modes = [];
    if (hasOpt(codec, 'crf') || hasOpt(codec, 'cq') || hasOpt(codec, 'qp'))
        modes.push('quality');
    modes.push('bitrate');
    if (hasOpt(codec, 'maxrate') || hasOpt(codec, 'rc')) modes.push('constrained');
    const info = encoderInfo(codec);
    if (info && info.lossless &&
        (hasOpt(codec, 'lossless') || hasOpt(codec, 'crf') || hasOpt(codec, 'qp')))
        modes.push('lossless');
    return modes;
}

export function qualityRange(codec) {
    const info = encoderInfo(codec);
    if (hasOpt(codec, 'crf') && info) return { min: info.crfMin, max: info.crfMax };
    const cq = optionNamed(codec, 'cq') || optionNamed(codec, 'qp');
    if (cq && cq.hasRange) return { min: Math.max(0, cq.min), max: Math.min(63, cq.max) };
    return { min: 0, max: 51 };
}
