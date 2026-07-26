// Six named starting points, and keeping the settings honest afterwards.
//
// Most renders are one of about six things, and picking the six well is worth
// more than any single control. Each one is filtered against what this build
// has rather than assumed: a machine without an NVIDIA card does not get
// offered the NVIDIA one.

import { settings } from './state.js';
import { encoderInfo, audioInfo, containerInfo, audioEncoders,
         rateModes, qualityRange } from './capabilities.js';
import { withExtension } from './spec.js';

function firstAvailable(...ids) {
    for (const id of ids) if (encoderInfo(id)) return id;
    return '';
}

function firstAudio(...ids) {
    for (const id of ids) if (audioInfo(id)) return id;
    return (audioEncoders()[0] || {}).id || '';
}

export function intents() {
    const out = [];
    const h264 = firstAvailable('libx264');
    const h265 = firstAvailable('libx265');
    const gpu = firstAvailable('h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv');
    const prores = firstAvailable('prores_ks');

    if (h264) out.push({
        id: 'web', label: 'Web / YouTube',
        hint: 'H.264 High, CRF 20 — plays everywhere',
        apply: { container: 'mp4', videoCodec: h264, rate: 'quality', quality: 20,
                 preset: 'medium', profile: 'high', pixelFormat: 'yuv420p',
                 audioCodec: 'aac', audioCodecBitrate: 192, faststart: true },
    });
    if (h264) out.push({
        id: 'small', label: 'Small file',
        hint: 'Same codec, slower and thriftier',
        apply: { container: 'mp4', videoCodec: h264, rate: 'quality', quality: 28,
                 preset: 'slow', profile: 'high', pixelFormat: 'yuv420p',
                 audioCodec: 'aac', audioCodecBitrate: 128, faststart: true },
    });
    if (h265) out.push({
        id: 'hevc', label: 'HEVC',
        hint: 'About half the size of H.264, fussier to play',
        apply: { container: 'mp4', videoCodec: h265, rate: 'quality', quality: 24,
                 preset: 'medium', profile: 'main', pixelFormat: 'yuv420p',
                 audioCodec: 'aac', audioCodecBitrate: 192, faststart: true },
    });
    if (prores) out.push({
        id: 'master', label: 'Master',
        hint: 'ProRes HQ and uncompressed audio, for editing on',
        apply: { container: 'mov', videoCodec: prores, rate: 'quality',
                 profile: 'hq', pixelFormat: 'yuv422p10le',
                 audioCodec: 'pcm_s16le', faststart: false },
    });
    if (gpu) out.push({
        id: 'gpu', label: 'Fast (GPU)',
        hint: `${encoderInfo(gpu).label} — many times quicker, a little bigger`,
        apply: { container: 'mp4', videoCodec: gpu, rate: 'quality', quality: 24,
                 preset: (encoderInfo(gpu).presets.indexOf('p5') >= 0 ? 'p5' : ''),
                 pixelFormat: 'yuv420p', audioCodec: 'aac', audioCodecBitrate: 192 },
    });
    if (h264) out.push({
        id: 'lossless', label: 'Lossless',
        hint: 'Nothing thrown away, and very large',
        apply: { container: 'mkv', videoCodec: h264, rate: 'lossless',
                 preset: 'veryfast', pixelFormat: 'yuv444p',
                 audioCodec: firstAudio('flac', 'pcm_s16le'), faststart: false },
    });
    return out;
}

/// Which intent, if any, the settings currently match. Compared field by field
/// so that changing one control lights the button off rather than leaving a
/// preset looking selected when it no longer describes anything.
export function activeIntent() {
    for (const it of intents()) {
        let same = true;
        for (const k of Object.keys(it.apply)) {
            if (String(settings[k]) !== String(it.apply[k])) { same = false; break; }
        }
        if (same) return it.id;
    }
    return '';
}

/// Settings only — whoever calls this owns the redraw.
export function applyIntent(id) {
    const it = intents().find((x) => x.id === id);
    if (!it) return false;
    Object.assign(settings, it.apply);
    if (settings.path) settings.path = withExtension(settings.path, settings.container);
    clampToEncoder();
    return true;
}

/// Pull the settings back to something the chosen encoder and container can
/// actually do. Called after anything that changes which encoder is in use,
/// because a preset carried over from x264 is meaningless to ProRes and a
/// silently-ignored one is how a render ends up not being what was asked for.
export function clampToEncoder() {
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;
    const info = encoderInfo(codec);
    if (!info) return;

    const modes = rateModes(codec);
    if (modes.indexOf(settings.rate) < 0) settings.rate = modes[0] || 'bitrate';

    const q = qualityRange(codec);
    if (settings.quality < q.min || settings.quality > q.max) {
        settings.quality = Math.round(info.crfDefault >= q.min && info.crfDefault <= q.max
            ? info.crfDefault : (q.min + q.max) / 2);
    }
    if (settings.preset && info.presets.indexOf(settings.preset) < 0)
        settings.preset = info.presets.indexOf('medium') >= 0 ? 'medium' : (info.presets[0] || '');
    if (settings.tune && info.tunes.indexOf(settings.tune) < 0) settings.tune = '';
    if (settings.profile && info.profiles.indexOf(settings.profile) < 0) settings.profile = '';
    if (settings.pixelFormat && info.pixelFormats.indexOf(settings.pixelFormat) < 0)
        settings.pixelFormat = '';

    const ainfo = audioInfo(settings.audioCodec);
    if (ainfo) {
        if (ainfo.sampleRates.length && ainfo.sampleRates.indexOf(settings.sampleRate) < 0)
            settings.sampleRate = nearest(ainfo.sampleRates, settings.sampleRate);
        if (ainfo.channelCounts.length && ainfo.channelCounts.indexOf(settings.channels) < 0)
            settings.channels = nearest(ainfo.channelCounts, settings.channels);
    }
}

function nearest(list, want) {
    let best = list[0];
    for (const v of list) if (Math.abs(v - want) < Math.abs(best - want)) best = v;
    return best;
}
