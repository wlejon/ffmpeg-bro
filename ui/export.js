// Writing the timeline out.
//
// The edit is already a complete description of an output frame: every clip
// has a rectangle in the canvas, a crop, an opacity and a place in the track
// stack, and the viewer draws exactly that. Exporting is that same description
// handed to an encoder instead of to the screen — which is why the placement
// rectangles sent to the renderer come from viewer.placement() rather than
// from a second implementation of fit/zoom/pan/grid that could disagree with
// what you were just looking at.
//
// Everything that is not geometry is an ffmpeg option. The friendly controls
// here do not have a private path into the encoder: a Quality slider produces
// `{crf: 20}` and the raw option editor produces `{crf: 20}`, both land in the
// same bag, and the bag is applied with av_opt_set the way the ffmpeg command
// line applies its arguments. Which is why the advanced editor can offer every
// option libavcodec reports without any of them needing to be plumbed.
//
// The hard part of encoding is not finding the settings, it is knowing what
// they cost. That is what the preview is for: it renders a few seconds at the
// exact settings, and a few seconds losslessly, and puts one on top of the
// other. Then "crf 20 or crf 28" stops being a guess about a number and
// becomes a picture and a file size.
//
// Which is also why this is a workspace and not a dialog. A comparison you
// have to squint at is not a comparison, and the difference between crf 20 and
// crf 28 lives in the parts of the frame a modal has no room for.
//
// The render itself runs on a thread in the host binary. Nothing here blocks:
// the screen polls it once a frame.

import { project, duration } from './project.js';
import * as viewer from './viewer.js';
import { bytes, clock, elapsed, basename, timecode } from './format.js';

let el = {};
let hooks = {};
let open = false;
let lastPoll = null;

// Which render the one render slot is currently being used for. The host runs
// one job at a time, so the export and both halves of the preview take turns
// through here rather than each keeping their own idea of what is going on.
let job = null;         // null | 'export' | 'reference' | 'candidate'

/// Every change to the slot goes through here, because leaving the workspace
/// while a render holds it would leave it running with nothing watching it —
/// and the tab that offers to leave has to know that on the frame it becomes
/// true, not the next time something happens to redraw.
function setJob(v) {
    job = v;
    if (hooks.workspace) hooks.workspace();
}

const PREVIEW_LENGTHS = [1, 2, 3, 5, 10];

// What the workspace was left set to. Remembered across exports because the
// second one is nearly always the first one again with a different range.
const settings = {
    path: '',
    container: 'mp4',
    videoCodec: '',
    audioCodec: '',

    // How the encoder is told what to spend. Which of these are offered
    // depends on what the encoder has: x264 has crf, nvenc has cq, ProRes has
    // neither and takes a profile instead.
    rate: 'quality',            // quality | bitrate | constrained | lossless
    quality: 20,
    videoBitrate: 8000,         // kbps
    maxrate: 0,
    bufsize: 0,

    preset: 'medium',
    tune: '',
    profile: '',
    pixelFormat: '',            // '' = the encoder's own preference

    width: 0,
    height: 0,
    fps: 0,                     // 0 = follow the project
    scaler: 'bicubic',

    gopSeconds: 0,              // 0 = the encoder's default
    bframes: -1,                // -1 = leave alone
    colorspace: 'auto',
    colorRange: 'tv',
    faststart: true,
    title: '',

    audio: true,
    audioCodecBitrate: 192,
    sampleRate: 48000,
    channels: 2,

    // Raw ffmpeg options, by name. Anything the controls above cannot say.
    extraVideo: {},
    extraAudio: {},
    extraFormat: {},

    // The slice of timeline to write. Both zero means all of it, which keeps
    // a saved range from outliving the project it was measured against.
    rangeIn: 0,
    rangeOut: 0,

    previewLength: 3,
};

// Everything about the preview: the two files, whether they are current, and
// what the last candidate render cost.
const preview = {
    at: 0,                      // where in the timeline it starts
    refPath: '',
    candPath: '',
    refKey: '',                 // what the reference on disk is a reference *of*
    candReady: false,
    refReady: false,
    stats: null,                // {bytes, seconds, fps, elapsed}
    wipe: 0.5,
    mode: 'wipe',               // wipe | side
    playing: true,
    error: '',
    fittedTo: '',               // the stage size the videos were last placed against
};

const containers = () => (bro.ffmpeg.containers || []);
const videoEncoders = () => (bro.ffmpeg.encoders || []);
const audioEncoders = () => (bro.ffmpeg.audioEncoders || []);

function encoderInfo(id) {
    return videoEncoders().find((e) => e.id === id) || null;
}

function audioInfo(id) {
    return audioEncoders().find((e) => e.id === id) || null;
}

function containerInfo(ext) {
    return containers().find((c) => c.ext === ext) || containers()[0] || null;
}

// ── What the current encoder will take ─────────────────────────────────────
//
// bro.ffmpeg.encoderOptions() reads the encoder's AVOption table, so this is
// libavcodec answering rather than a table here claiming. Cached per encoder
// because x265 has some eighty options and the form redraws on every keystroke.

const optionCache = new Map();

function optionsOf(codec) {
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

function optionNamed(codec, name) {
    return optionsOf(codec).find((o) => o.name === name) || null;
}

const hasOpt = (codec, name) => optionNamed(codec, name) !== null;

/// The rate-control modes this encoder can actually be put into. Asked of the
/// options rather than assumed from the name: nvenc has no crf but has cq,
/// ProRes has neither, and offering a control that does nothing is worse than
/// offering none.
function rateModes(codec) {
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

function qualityRange(codec) {
    const info = encoderInfo(codec);
    if (hasOpt(codec, 'crf') && info) return { min: info.crfMin, max: info.crfMax };
    const cq = optionNamed(codec, 'cq') || optionNamed(codec, 'qp');
    if (cq && cq.hasRange) return { min: Math.max(0, cq.min), max: Math.min(63, cq.max) };
    return { min: 0, max: 51 };
}

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
function videoOptions(codec, over = {}) {
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

function audioOptions(codec) {
    const out = {};
    const info = audioInfo(codec);
    // A bitrate means nothing to a lossless encoder and FLAC rejects it.
    if (info && !info.lossless) out.b = `${Math.max(8, settings.audioCodecBitrate)}k`;
    return Object.assign(out, settings.extraAudio);
}

// ── the spec ───────────────────────────────────────────────────────────────

/// Swap a path's extension, keeping the directory and the name. Written
/// against both separators because a path here came from a native file dialog
/// on Windows and from a drop on everything else.
function withExtension(path, ext) {
    const cut = path.replace(/\.[^./\\]*$/, '');
    return `${cut}.${ext}`;
}

/// Beside the first clip, named after it. Somewhere is better than nowhere:
/// the file picker is one click away, and this is right often enough that the
/// click is usually unnecessary.
function defaultPath() {
    const first = project.clips[0];
    if (!first) return '';
    return `${first.path.replace(/\.[^./\\]*$/, '')}-export.${settings.container}`;
}

/// The part of the timeline that will be written.
export function range() {
    const total = Math.max(0, duration());
    let a = Math.max(0, Math.min(settings.rangeIn, total));
    let b = settings.rangeOut > 0 ? Math.min(settings.rangeOut, total) : total;
    if (b <= a) { a = 0; b = total; }
    return { start: a, end: b, length: b - a };
}

/// Everything the renderer needs, in the shape bro.ffmpeg.render.start wants.
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

    const container = containerInfo(over.container || settings.container);
    const vcodec = over.videoCodec || settings.videoCodec ||
                   (container ? container.videoCodec : 'libx264');
    const acodec = over.audioCodec || settings.audioCodec ||
                   (container ? container.audioCodec : 'aac');
    const r = range();

    return {
        path: over.path || settings.path || defaultPath(),
        width: outW,
        height: outH,
        fps: over.fps || settings.fps || project.fps || 30,
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
        clips,
    };
}

// ── presets ────────────────────────────────────────────────────────────────
//
// The point of these is that most renders are one of about six things, and
// picking the six well is worth more than any single control. Each one is
// filtered against what this build has rather than assumed: a machine without
// an NVIDIA card does not get offered the NVIDIA one.

function firstAvailable(...ids) {
    for (const id of ids) if (encoderInfo(id)) return id;
    return '';
}

function intents() {
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

function firstAudio(...ids) {
    for (const id of ids) if (audioInfo(id)) return id;
    return (audioEncoders()[0] || {}).id || '';
}

/// Which intent, if any, the settings currently match. Compared field by field
/// so that changing one control lights the button off rather than leaving a
/// preset looking selected when it no longer describes anything.
function activeIntent() {
    for (const it of intents()) {
        let same = true;
        for (const k of Object.keys(it.apply)) {
            if (String(settings[k]) !== String(it.apply[k])) { same = false; break; }
        }
        if (same) return it.id;
    }
    return '';
}

function applyIntent(id) {
    const it = intents().find((x) => x.id === id);
    if (!it) return;
    Object.assign(settings, it.apply);
    if (settings.path) settings.path = withExtension(settings.path, settings.container);
    clampToEncoder();
    invalidatePreview();
    drawAll();
}

/// Pull the settings back to something the chosen encoder and container can
/// actually do. Called after anything that changes which encoder is in use,
/// because a preset carried over from x264 is meaningless to ProRes and a
/// silently-ignored one is how a render ends up not being what was asked for.
function clampToEncoder() {
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

// ── warnings ───────────────────────────────────────────────────────────────
//
// Everything here is a thing that produces a file which is technically valid
// and practically wrong, which is the failure worth catching: an encoder that
// refuses says so itself.

function warnings() {
    const out = [];
    const c = containerInfo(settings.container);
    const codec = settings.videoCodec || (c || {}).videoCodec;
    const info = encoderInfo(codec);
    const w = settings.width, h = settings.height;

    if (c && info && c.videoCodecs.indexOf(codec) < 0)
        out.push(`${c.label} cannot hold ${info.label} — the muxer will refuse it`);
    if (c && settings.audio && settings.audioCodec && c.audioCodecs.indexOf(settings.audioCodec) < 0)
        out.push(`${c.label} cannot hold ${(audioInfo(settings.audioCodec) || {}).label}`);

    const pix = settings.pixelFormat || (info && info.pixelFormats[0]) || 'yuv420p';
    if (/420/.test(pix) && ((w % 2) || (h % 2)))
        out.push(`${pix} needs even dimensions — ${w}×${h} will fail`);

    const canvasAspect = project.height ? project.width / project.height : 0;
    const outAspect = h ? w / h : 0;
    if (canvasAspect && Math.abs(outAspect - canvasAspect) > 0.01)
        out.push('the output is a different shape from the canvas — the picture will be stretched');

    const fps = settings.fps || project.fps || 30;
    if (project.fps && fps > project.fps + 0.01)
        out.push(`${fps} fps from a ${project.fps.toFixed(3)} fps timeline duplicates frames`);

    if (info && info.hardware && settings.rate === 'quality')
        out.push('a GPU encoder trades quality per bit for speed — compare it against x264 before trusting the number');

    if (settings.rate === 'lossless')
        out.push('lossless output is commonly ten to thirty times larger than CRF 20');

    return out;
}

// ── the workspace ──────────────────────────────────────────────────────────

export function initExport(refs, h) {
    el = refs;
    hooks = h || {};

    el.cancel.addEventListener('click', () => {
        if (job) bro.ffmpeg.render.cancel();
        else closeExport();
    });
    el.go.addEventListener('click', begin);

    restore();
}

// localStorage, not bro.settings: bro's settings are a closed schema of engine
// keys and warn about anything else, so an application preference does not
// belong there. This is one key holding the block, because the fields are only
// ever read and written together.
const SETTINGS_KEY = 'ffmpeg-bro.export';

const REMEMBERED = ['container', 'videoCodec', 'audioCodec', 'rate', 'quality',
                    'videoBitrate', 'maxrate', 'bufsize', 'preset', 'tune', 'profile',
                    'pixelFormat', 'fps', 'scaler', 'gopSeconds', 'bframes',
                    'colorspace', 'colorRange', 'faststart', 'audio',
                    'audioCodecBitrate', 'sampleRate', 'channels',
                    'extraVideo', 'extraAudio', 'extraFormat', 'previewLength'];

let firstRun = true;

function restore() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            const blob = JSON.parse(saved);
            for (const k of REMEMBERED) if (blob[k] !== undefined) settings[k] = blob[k];
            firstRun = false;
        }
    } catch (e) { /* first run, or a stored blob from an older shape */ }
    // The remembered container and codec may not exist in this build.
    if (!containerInfo(settings.container))
        settings.container = (containers()[0] || {}).ext || 'mp4';
    if (settings.videoCodec && !encoderInfo(settings.videoCodec)) settings.videoCodec = '';
    if (settings.audioCodec && !audioInfo(settings.audioCodec)) settings.audioCodec = '';
}

function remember() {
    try {
        const blob = {};
        for (const k of REMEMBERED) blob[k] = settings[k];
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(blob));
    } catch (e) { /* not fatal: the export still runs */ }
}

export function isOpen() { return open; }
export function isRunning() { return job !== null; }

export function openExport() {
    if (!project.clips.length) {
        if (hooks.flash) hooks.flash('Nothing on the timeline to export');
        return;
    }
    if (hooks.pause) hooks.pause();
    open = true;
    // The class on <body> is what hides the edit; the section's own `hidden`
    // is what stops it being measured while it is not on screen.
    document.body.classList.add('ws-output');
    el.screen.classList.remove('hidden');
    if (!settings.path) settings.path = defaultPath();
    if (!settings.width) { settings.width = project.width; settings.height = project.height; }
    if (!settings.videoCodec)
        settings.videoCodec = (containerInfo(settings.container) || {}).videoCodec || '';
    if (!settings.audioCodec)
        settings.audioCodec = (containerInfo(settings.container) || {}).audioCodec || '';

    // Nothing has ever been saved, so start somewhere named rather than on a
    // pile of defaults that happens to match none of the presets and reads as
    // "custom" before anything has been customised.
    if (firstRun) {
        firstRun = false;
        const first = intents()[0];
        if (first) Object.assign(settings, first.apply);
    }

    // The range is measured against a timeline that may have changed since it
    // was set, so an out point past the end is quietly the end.
    const total = Math.max(0, duration());
    if (settings.rangeOut > total) settings.rangeOut = 0;
    preview.at = Math.min(Math.max(0, hooks.playhead ? hooks.playhead() : 0),
                          Math.max(0, total - 0.1));

    clampToEncoder();
    showPanel('form');
    drawAll();
    if (hooks.workspace) hooks.workspace();
}

export function closeExport() {
    if (job) return;     // the Stop button is the way out of a render
    open = false;
    stopPreviewPlayback();
    el.screen.classList.add('hidden');
    document.body.classList.remove('ws-output');
    if (hooks.workspace) hooks.workspace();
}

function showPanel(which) {
    el.form.classList.toggle('hidden', which !== 'form');
    el.progress.classList.toggle('hidden', which !== 'progress');
    el.go.classList.toggle('hidden', which !== 'form');
    // The range belongs to the settings, not to the render: while one is
    // running it is a picture of a decision already taken.
    el.strip.classList.toggle('hidden', which !== 'form');
    // The button is Stop only while there is something to stop. A finished
    // render leaving "Stop" under a green bar reads as though it is still
    // going.
    el.cancel.textContent = job ? 'Stop' : 'Close';
}

function drawAll() {
    drawIntents();
    drawForm();
    drawPreview();
    drawStrip();
    updateSummary();
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function id(x) { return document.getElementById(x); }

function row(key, val) {
    return `<div class="row"><span class="key">${key}</span><span class="val">${val}</span></div>`;
}

function opts(list, sel, idKey = 'id', labelKey = 'label') {
    return list.map((o) => {
        const v = typeof o === 'string' ? o : o[idKey];
        const l = typeof o === 'string' ? o : o[labelKey];
        return `<option value="${escapeAttr(v)}"${String(v) === String(sel) ? ' selected' : ''}>` +
               `${escapeAttr(l)}</option>`;
    }).join('');
}

function seg(name, items, sel) {
    return `<span class="seg">` + items.map((it) =>
        `<button class="tiny${String(it.v) === String(sel) ? ' on' : ''}" ` +
        `data-seg="${name}" data-v="${escapeAttr(it.v)}"` +
        (it.title ? ` title="${escapeAttr(it.title)}"` : '') +
        `>${escapeAttr(it.l)}</button>`).join('') + `</span>`;
}

// ── the intent row ─────────────────────────────────────────────────────────

function drawIntents() {
    const active = activeIntent();
    el.intent.innerHTML =
        `<span class="ex-intent-label dim">Start from</span>` +
        intents().map((it) =>
            `<button class="tiny${it.id === active ? ' on' : ''}" data-intent="${it.id}" ` +
            `title="${escapeAttr(it.hint)}">${escapeAttr(it.label)}</button>`).join('') +
        (active ? '' : `<span class="dim ex-intent-label">custom</span>`);

    for (const b of el.intent.querySelectorAll('button[data-intent]'))
        b.addEventListener('click', () => applyIntent(b.getAttribute('data-intent')));
}

// ── the settings column ────────────────────────────────────────────────────

let showAdvanced = false;
let optionSearch = '';

function drawForm() {
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;
    const info = encoderInfo(codec) || { presets: [], tunes: [], profiles: [], pixelFormats: [] };
    const cont = containerInfo(settings.container) || { videoCodecs: [], audioCodecs: [] };
    const modes = rateModes(codec);
    const q = qualityRange(codec);

    // Codecs the chosen container will actually hold come first; the rest are
    // still listed, because refusing to show them hides the reason the one you
    // wanted is missing.
    const vlist = videoEncoders().map((e) => ({
        id: e.id,
        label: e.label + (cont.videoCodecs.indexOf(e.id) < 0 ? '  (not in ' + settings.container + ')' : ''),
    }));
    const alist = audioEncoders().map((e) => ({
        id: e.id,
        label: e.label + (cont.audioCodecs.indexOf(e.id) < 0 ? '  (not in ' + settings.container + ')' : ''),
    }));

    let html =
        `<div class="section-head">Output</div>` +
        row('File', `<input class="wide" id="ex-path" type="text" value="${escapeAttr(settings.path)}">`) +
        row('', `<span class="btns"><button class="tiny" id="ex-browse">Choose&hellip;</button>` +
                `<span class="dim mono" id="ex-dir"></span></span>`) +
        row('Format', `<select id="ex-container">${opts(containers(), settings.container, 'ext')}</select>`) +

        `<div class="section-head">Video</div>` +
        row('Codec', `<select id="ex-vcodec">${opts(vlist, codec)}</select>`) +
        (info.longName ? row('', `<span class="dim tiny-note">${escapeAttr(info.longName)}</span>`) : '');

    if (info.alwaysLossless) {
        html += row('Rate', `<span class="dim">always lossless — there is nothing to choose</span>`);
    } else {
        html += row('Rate', seg('rate', modes.map((m) => ({
            v: m,
            l: { quality: 'Quality', bitrate: 'Bitrate', constrained: 'Capped', lossless: 'Lossless' }[m],
            title: {
                quality: 'Constant quality: the bitrate lands wherever it needs to',
                bitrate: 'A target the encoder averages out to',
                constrained: 'An average with a ceiling, for streaming',
                lossless: 'Nothing thrown away',
            }[m],
        })), settings.rate));

        if (settings.rate === 'quality' && modes.indexOf('quality') >= 0) {
            html += row('Quality',
                `<span class="btns"><input id="ex-q" type="range" min="${q.min}" max="${q.max}" ` +
                `value="${settings.quality}"><span id="ex-qval" class="mono dim"></span></span>`);
        }
        if (settings.rate === 'bitrate' || settings.rate === 'constrained') {
            html += row('Bitrate', `<span class="btns"><input class="num" id="ex-vbitrate" type="number" ` +
                `min="1" max="500000" step="500" value="${settings.videoBitrate}">` +
                `<span class="dim">kbps</span></span>`);
        }
        if (settings.rate === 'constrained') {
            html += row('Ceiling', `<span class="btns"><input class="num" id="ex-maxrate" type="number" ` +
                `min="0" max="500000" step="500" value="${settings.maxrate || Math.round(settings.videoBitrate * 1.5)}">` +
                `<span class="dim">kbps</span></span>`) +
                row('Buffer', `<span class="btns"><input class="num" id="ex-bufsize" type="number" ` +
                `min="0" max="500000" step="500" value="${settings.bufsize || settings.videoBitrate * 3}">` +
                `<span class="dim">kbit</span></span>`);
        }
    }

    if (info.presets && info.presets.length)
        html += row('Speed', `<select id="ex-preset">${opts(info.presets, settings.preset)}</select>`);
    if (info.tunes && info.tunes.length)
        html += row('Tune', `<select id="ex-tune"><option value="">none</option>` +
                            `${opts(info.tunes, settings.tune)}</select>`);
    if (info.profiles && info.profiles.length)
        html += row('Profile', `<select id="ex-profile"><option value="">auto</option>` +
                               `${opts(info.profiles, settings.profile)}</select>`);
    if (info.pixelFormats && info.pixelFormats.length)
        html += row('Pixels', `<select id="ex-pixfmt"><option value="">` +
                              `auto (${escapeAttr(info.pixelFormats.indexOf('yuv420p') >= 0 ? 'yuv420p' : info.pixelFormats[0])})</option>` +
                              `${opts(info.pixelFormats, settings.pixelFormat)}</select>`);

    html +=
        row('Size', `<span class="btns">` +
            `<input class="num" id="ex-w" type="number" min="16" max="16384" value="${settings.width}">` +
            `<span class="dim">&times;</span>` +
            `<input class="num" id="ex-h" type="number" min="16" max="16384" value="${settings.height}">` +
            `</span>`) +
        row('', `<span class="btns even">` +
            `<button class="tiny" data-size="canvas">Canvas</button>` +
            `<button class="tiny" data-size="3840x2160">4K</button>` +
            `<button class="tiny" data-size="1920x1080">1080p</button>` +
            `<button class="tiny" data-size="1280x720">720p</button>` +
            `<button class="tiny" data-size="half">Half</button></span>`) +
        row('Frame rate', `<select id="ex-fps">` +
            `<option value="0"${!settings.fps ? ' selected' : ''}>` +
            `Project (${(project.fps || 30).toFixed(3)})</option>` +
            [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map((f) =>
                `<option value="${f}"${settings.fps === f ? ' selected' : ''}>${f}</option>`).join('') +
            `</select>`) +

        `<div class="section-head">Audio</div>` +
        row('Include', `<span class="btns">` +
            `<button class="tiny${settings.audio ? ' on' : ''}" id="ex-audio">` +
            `${settings.audio ? 'On' : 'Off'}</button></span>`);

    if (settings.audio) {
        const ainfo = audioInfo(settings.audioCodec) || { sampleRates: [], channelCounts: [] };
        html += row('Codec', `<select id="ex-acodec">${opts(alist, settings.audioCodec)}</select>`);
        if (!ainfo.lossless)
            html += row('Bitrate', `<span class="btns"><select id="ex-abitrate">` +
                opts([64, 96, 128, 160, 192, 256, 320, 448].map(String),
                     String(settings.audioCodecBitrate)) +
                `</select><span class="dim">kbps</span></span>`);
        if (ainfo.sampleRates.length > 1)
            html += row('Rate', `<span class="btns"><select id="ex-arate">` +
                opts(ainfo.sampleRates.map(String), String(settings.sampleRate)) +
                `</select><span class="dim">Hz</span></span>`);
        if (ainfo.channelCounts.length > 1)
            html += row('Channels', `<select id="ex-ach">` +
                opts(ainfo.channelCounts.map((n) => ({
                    id: String(n),
                    label: n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`,
                })), String(settings.channels)) + `</select>`);
    }

    html += `<div class="section-head ex-toggle" id="ex-adv-head">` +
            `${showAdvanced ? '▾' : '▸'} Advanced</div>`;

    // The advanced block is a column of its own rather than a fold at the
    // bottom of this one. There are eighty options for x265; reading them
    // through a slot under twenty other controls is not reading them, and
    // scrolling away from the codec to reach them is worse.
    let adv = '';
    if (showAdvanced) {
        adv =
            `<div class="section-head">Advanced</div>` +
            row('Keyframes', `<span class="btns"><input class="num" id="ex-gop" type="number" ` +
                `min="0" max="60" step="0.5" value="${settings.gopSeconds}">` +
                `<span class="dim">seconds (0 = encoder default)</span></span>`) +
            row('B-frames', `<span class="btns"><input class="num" id="ex-bf" type="number" ` +
                `min="-1" max="16" value="${settings.bframes}">` +
                `<span class="dim">-1 = leave alone</span></span>`) +
            row('Scaler', `<select id="ex-scaler">` +
                opts(['bicubic', 'bilinear', 'lanczos', 'spline', 'area', 'gauss', 'neighbor'],
                     settings.scaler) + `</select>`) +
            row('Colour', `<select id="ex-cspace">` +
                opts([{ id: 'auto', label: 'auto (by height)' }, { id: 'bt709', label: 'BT.709 (HD)' },
                      { id: 'bt601', label: 'BT.601 (SD)' }, { id: 'bt2020', label: 'BT.2020 (wide)' }],
                     settings.colorspace) + `</select>`) +
            row('Range', seg('crange', [{ v: 'tv', l: 'Limited' }, { v: 'pc', l: 'Full' }],
                             settings.colorRange)) +
            row('Faststart', `<span class="btns"><button class="tiny${settings.faststart ? ' on' : ''}" ` +
                `id="ex-faststart" title="Move the index to the front of an mp4">` +
                `${settings.faststart ? 'On' : 'Off'}</button></span>`) +
            row('Title', `<input class="wide" id="ex-title" type="text" ` +
                `value="${escapeAttr(settings.title)}" placeholder="written as metadata">`) +
            drawRawOptions(codec);
    }

    el.settings.innerHTML = html;
    el.advanced.innerHTML = adv;
    el.advanced.classList.toggle('hidden', !showAdvanced);
    wireForm();
}

/// Both halves of the form, as one list. The controls are split across two
/// columns but they are one form, so anything that wires them up has to look
/// in both — a `crange` segment or a raw option that only got a listener when
/// it happened to be in the left column would silently stop working the day it
/// moved to the right one.
function formEls(sel) {
    const out = [];
    for (const pane of [el.settings, el.advanced])
        if (pane) for (const node of pane.querySelectorAll(sel)) out.push(node);
    return out;
}

/// Every option the chosen encoder has, straight from its AVOption table.
///
/// This is the part that earns the column: libavcodec knows
/// exactly what x265 will take, complete with types, ranges, defaults and help
/// text, and none of it has to be duplicated here to be offered.
function drawRawOptions(codec) {
    const all = optionsOf(codec);
    const set = settings.extraVideo;
    const term = optionSearch.trim().toLowerCase();
    const matching = term
        ? all.filter((o) => o.name.toLowerCase().indexOf(term) >= 0 ||
                            (o.help || '').toLowerCase().indexOf(term) >= 0)
        : all.filter((o) => set[o.name] !== undefined);

    const LIMIT = 40;
    const shown = matching.slice(0, LIMIT);

    let html = `<div class="section-head">${escapeAttr(codec)} options ` +
               `<span class="dim">· ${all.length}</span></div>` +
        row('Find', `<input class="wide" id="ex-optsearch" type="text" ` +
            `value="${escapeAttr(optionSearch)}" placeholder="name or description">`);

    if (!term && !shown.length)
        html += `<div class="ex-note dim">Type above to search all ${all.length} options. ` +
                `Anything set here is passed straight to the encoder.</div>`;

    for (const o of shown) {
        const cur = set[o.name] !== undefined ? set[o.name] : '';
        let control;
        if (o.values && o.values.length) {
            control = `<select class="ex-opt" data-opt="${escapeAttr(o.name)}">` +
                      `<option value="">default (${escapeAttr(o.default)})</option>` +
                      opts(o.values.map((v) => v.name), String(cur)) + `</select>`;
        } else if (o.type === 'bool') {
            control = `<select class="ex-opt" data-opt="${escapeAttr(o.name)}">` +
                      `<option value="">default (${escapeAttr(o.default)})</option>` +
                      opts(['0', '1'], String(cur)) + `</select>`;
        } else {
            control = `<input class="wide ex-opt" data-opt="${escapeAttr(o.name)}" type="text" ` +
                      `value="${escapeAttr(cur)}" placeholder="${escapeAttr(o.default)}">`;
        }
        const rangeNote = o.hasRange && o.type !== 'enum'
            ? ` <span class="dim">[${o.min}…${o.max}]</span>` : '';
        html += `<div class="ex-opt-row${cur !== '' ? ' set' : ''}">` +
                `<div class="ex-opt-name mono">${escapeAttr(o.name)} ` +
                `<span class="dim">${escapeAttr(o.type)}</span>${rangeNote}</div>` +
                `<div class="ex-opt-help dim">${escapeAttr(o.help || '')}</div>` +
                `<div>${control}</div></div>`;
    }
    if (matching.length > LIMIT)
        html += `<div class="ex-note dim">and ${matching.length - LIMIT} more — narrow the search</div>`;

    return html;
}

function wireForm() {
    const path = id('ex-path');
    if (path) path.addEventListener('change', () => {
        settings.path = path.value.trim();
        updateFileLabel();
        updateSummary();
    });

    const browse = id('ex-browse');
    if (browse) browse.addEventListener('click', () => {
        // Only ever from a click. These dialogs block the JS thread until they
        // are dismissed, so anything automatic — a headless run included —
        // would hang with no window to dismiss.
        if (typeof showSaveFileDialog !== 'function') return;
        const ext = settings.container;
        const chosen = showSaveFileDialog(`${ext.toUpperCase()}|${ext}`,
                                          settings.path || defaultPath());
        if (chosen) {
            settings.path = chosen;
            if (path) path.value = chosen;
            updateFileLabel();
            updateSummary();
        }
    });

    const container = id('ex-container');
    if (container) container.addEventListener('change', () => {
        settings.container = container.value;
        const c = containerInfo(settings.container);
        // The codecs follow the container when the ones in hand will not fit:
        // VP9 in an mp4 is legal but nothing plays it, and AAC in a WebM is not
        // legal at all.
        if (c) {
            if (c.videoCodecs.indexOf(settings.videoCodec) < 0) settings.videoCodec = c.videoCodec;
            if (c.audioCodecs.indexOf(settings.audioCodec) < 0) settings.audioCodec = c.audioCodec;
        }
        if (settings.path) settings.path = withExtension(settings.path, settings.container);
        after();
    });

    const vcodec = id('ex-vcodec');
    if (vcodec) vcodec.addEventListener('change', () => {
        settings.videoCodec = vcodec.value;
        after();
    });

    const q = id('ex-q');
    if (q) q.addEventListener('input', () => {
        settings.quality = Number(q.value);
        // Not a full redraw: dragging a slider that rebuilds the form under
        // the pointer loses the drag on the first move.
        updateQualityLabel();
        updateSummary();
        invalidateCandidate();
    });

    bindNumber('ex-vbitrate', (v) => { settings.videoBitrate = Math.max(1, v); });
    bindNumber('ex-maxrate', (v) => { settings.maxrate = Math.max(0, v); });
    bindNumber('ex-bufsize', (v) => { settings.bufsize = Math.max(0, v); });
    bindNumber('ex-gop', (v) => { settings.gopSeconds = Math.max(0, v); });
    bindNumber('ex-bf', (v) => { settings.bframes = Math.max(-1, Math.round(v)); });

    bindSelect('ex-preset', (v) => { settings.preset = v; });
    bindSelect('ex-tune', (v) => { settings.tune = v; });
    bindSelect('ex-profile', (v) => { settings.profile = v; });
    bindSelect('ex-pixfmt', (v) => { settings.pixelFormat = v; });
    bindSelect('ex-scaler', (v) => { settings.scaler = v; });
    bindSelect('ex-cspace', (v) => { settings.colorspace = v; });
    bindSelect('ex-acodec', (v) => { settings.audioCodec = v; clampToEncoder(); });
    bindSelect('ex-abitrate', (v) => { settings.audioCodecBitrate = Number(v); });
    bindSelect('ex-arate', (v) => { settings.sampleRate = Number(v); });
    bindSelect('ex-ach', (v) => { settings.channels = Number(v); });

    for (const f of ['ex-w', 'ex-h']) {
        const input = id(f);
        if (!input) continue;
        input.addEventListener('change', () => {
            settings.width = Math.max(16, Number(id('ex-w').value) || project.width);
            settings.height = Math.max(16, Number(id('ex-h').value) || project.height);
            after();
        });
    }

    for (const b of el.settings.querySelectorAll('button[data-size]')) {
        b.addEventListener('click', () => {
            const v = b.getAttribute('data-size');
            if (v === 'canvas') { settings.width = project.width; settings.height = project.height; }
            else if (v === 'half') {
                settings.width = even(project.width / 2);
                settings.height = even(project.height / 2);
            } else {
                const [w, h] = v.split('x').map(Number);
                settings.width = w; settings.height = h;
            }
            after();
        });
    }

    for (const b of formEls('button[data-seg]')) {
        b.addEventListener('click', () => {
            const name = b.getAttribute('data-seg');
            const v = b.getAttribute('data-v');
            if (name === 'rate') settings.rate = v;
            else if (name === 'crange') settings.colorRange = v;
            after();
        });
    }

    const fps = id('ex-fps');
    if (fps) fps.addEventListener('change', () => { settings.fps = Number(fps.value) || 0; after(); });

    const audio = id('ex-audio');
    if (audio) audio.addEventListener('click', () => { settings.audio = !settings.audio; after(); });

    const fast = id('ex-faststart');
    if (fast) fast.addEventListener('click', () => { settings.faststart = !settings.faststart; after(); });

    const title = id('ex-title');
    if (title) title.addEventListener('change', () => { settings.title = title.value; });

    const advHead = id('ex-adv-head');
    if (advHead) advHead.addEventListener('click', () => { showAdvanced = !showAdvanced; drawForm(); });

    const search = id('ex-optsearch');
    if (search) search.addEventListener('input', () => {
        optionSearch = search.value;
        drawForm();
        // Redrawing the list takes the focus with it; put it back so typing a
        // search term does not stop after the first letter.
        const again = id('ex-optsearch');
        if (again && again.focus) again.focus();
    });

    for (const c of formEls('.ex-opt')) {
        c.addEventListener('change', () => {
            const name = c.getAttribute('data-opt');
            const v = c.value.trim();
            if (v === '') delete settings.extraVideo[name];
            else settings.extraVideo[name] = v;
            after();
        });
    }

    updateQualityLabel();
    updateFileLabel();
}

/// Belongs to the form, not to the summary: redrawing the form on its own —
/// which opening the Advanced section does — used to leave this blank.
function updateFileLabel() {
    const dir = id('ex-dir');
    if (dir) dir.textContent = settings.path ? basename(settings.path) : 'no file chosen';
}

function even(n) { return Math.max(16, Math.round(n / 2) * 2); }

function bindNumber(elId, set) {
    const input = id(elId);
    if (!input) return;
    input.addEventListener('change', () => { set(Number(input.value) || 0); after(); });
}

function bindSelect(elId, set) {
    const input = id(elId);
    if (!input) return;
    input.addEventListener('change', () => { set(input.value); after(); });
}

/// After any change that could alter what gets written.
function after() {
    clampToEncoder();
    invalidateCandidate();
    drawAll();
}

function updateQualityLabel() {
    const out = id('ex-qval');
    if (!out) return;
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;
    const r = qualityRange(codec);
    // The scale runs backwards from every other quality control in the app and
    // its ends move with the encoder, so it says where you are on it rather
    // than showing a bare number.
    const t = (settings.quality - r.min) / Math.max(1, r.max - r.min);
    const word = t <= 0.02 ? 'lossless' : t < 0.3 ? 'near-lossless'
               : t < 0.45 ? 'high' : t < 0.62 ? 'good' : 'small file';
    out.textContent = `${settings.quality} · ${word}`;
}

// ── the preview ────────────────────────────────────────────────────────────
//
// Two renders of the same few seconds — one at the settings being chosen, one
// lossless — laid on top of each other with a wipe between them. The lossless
// one is what the compositor produced before any encoder saw it, so the
// difference on screen is exactly what the settings cost and nothing else.

/// What a reference is a reference *of*. The lossless render only has to be
/// redone when the picture itself changes: a different quality, preset or
/// codec does not move it, which is the case that matters because it is the
/// one being compared.
function referenceKey() {
    return JSON.stringify([
        project.clips.map((c) => [c.path, c.start, c.length, c.inPoint, c.track,
                                  c.xform.opacity, c.xform.scale, c.xform.x, c.xform.y,
                                  c.xform.fit, c.xform.crop, project.layout]),
        settings.width, settings.height, settings.fps || project.fps,
        preview.at, settings.previewLength, project.width, project.height,
    ]);
}

function invalidatePreview() {
    preview.refReady = false;
    preview.candReady = false;
    preview.stats = null;
}

/// The candidate is stale but the reference is not: changing the quality does
/// not change what the picture was before it was encoded.
function invalidateCandidate() {
    preview.candReady = false;
    preview.stats = null;
    if (preview.refKey !== referenceKey()) preview.refReady = false;
}

function previewRange() {
    const total = Math.max(0, duration());
    const start = Math.max(0, Math.min(preview.at, Math.max(0, total - 0.2)));
    return { start, end: Math.min(total, start + settings.previewLength) };
}

function startPreview() {
    if (job) return;
    preview.error = '';
    const key = referenceKey();
    if (preview.refKey !== key) { preview.refReady = false; preview.refKey = key; }
    if (!preview.refReady) renderReference();
    else renderCandidate();
}

function renderReference() {
    const r = previewRange();
    preview.refPath = bro.ffmpeg.tempPath('reference.mkv');
    // Lossless H.264 rather than a raw format: it is exact, it is a tenth the
    // size of FFV1, and it decodes fast enough to play beside the candidate.
    // yuv444p so that the reference does not itself throw away the chroma the
    // candidate is about to be judged on.
    const spec = buildSpec({
        path: preview.refPath,
        start: r.start, end: r.end,
        container: 'mkv',
        videoCodec: 'libx264',
        audio: false,
        pixelFormat: 'yuv444p',
        videoOptions: { crf: 0, preset: 'ultrafast' },
        audioOptions: {},
    });
    launch(spec, 'reference');
}

function renderCandidate() {
    const r = previewRange();
    const ext = settings.container;
    preview.candPath = bro.ffmpeg.tempPath(`candidate.${ext}`);
    launch(buildSpec({ path: preview.candPath, start: r.start, end: r.end }), 'candidate');
}

function launch(spec, kind) {
    try {
        bro.ffmpeg.render.start(spec);
        setJob(kind);
        lastPoll = bro.ffmpeg.render.poll();
    } catch (e) {
        setJob(null);
        preview.error = String(e.message || e);
        drawPreview();
        return;
    }
    if (kind === 'export') { showPanel('progress'); drawProgress(lastPoll); }
    else drawPreview();
}

function stopPreviewPlayback() {
    for (const v of [id('ex-pv-ref'), id('ex-pv-cand')])
        if (v && v.pause) v.pause();
}

function previewFinished(p) {
    if (p.state !== 'done') {
        // Clearing the slot first: a failed preview that leaves `job` set
        // means the workspace spends the rest of its life believing a render is
        // in progress, with the Export button disabled and no way back.
        setJob(null);
        preview.error = p.state === 'cancelled' ? '' : (p.error || 'the preview render failed');
        drawPreview();
        showPanel('form');
        return;
    }
    const r = previewRange();
    if (job === 'reference') {
        preview.refReady = true;
        setJob(null);
        renderCandidate();          // straight on: one click, both halves
        return;
    }
    preview.candReady = true;
    preview.stats = {
        bytes: p.bytes,
        seconds: Math.max(0.001, r.end - r.start),
        encodeFps: p.fps,
        elapsed: p.elapsed,
        frames: p.frames,
    };
    setJob(null);
    drawPreview();
    updateSummary();
}

function drawPreview() {
    const r = previewRange();
    const busy = job === 'reference' || job === 'candidate';
    const have = preview.refReady && preview.candReady;

    let head = `<div class="section-head">Preview</div>`;

    let stage;
    if (busy) {
        const pct = Math.round((lastPoll ? lastPoll.progress : 0) * 100);
        stage = `<div class="ex-pv-stage empty">` +
                `<div class="ex-pv-busy">${job === 'reference' ? 'Rendering the reference' : 'Encoding at your settings'}` +
                `<div class="ex-bar"><div class="ex-fill" style="width:${pct}%"></div></div>` +
                `<div class="mono dim">${pct}%</div></div></div>`;
    } else if (have) {
        // Two absolutely-placed videos; the top one lives in a window with
        // overflow:hidden whose width is the wipe. Same trick the viewer uses
        // for a crop, and it costs nothing per frame.
        const w = Math.round(preview.wipe * 100);
        stage = preview.mode === 'side'
            ? `<div class="ex-pv-stage side">` +
              `<div class="ex-pv-half"><video id="ex-pv-ref" muted></video><span class="ex-pv-tag">before</span></div>` +
              `<div class="ex-pv-half"><video id="ex-pv-cand" muted></video><span class="ex-pv-tag">encoded</span></div>` +
              `</div>`
            : `<div class="ex-pv-stage" id="ex-pv-wipearea">` +
              `<video id="ex-pv-ref" muted></video>` +
              `<div class="ex-pv-window" style="width:${w}%"><video id="ex-pv-cand" muted></video></div>` +
              `<div class="ex-pv-handle" style="left:${w}%"></div>` +
              `<span class="ex-pv-tag right">before</span>` +
              `<span class="ex-pv-tag">encoded</span>` +
              `</div>`;
    } else if (preview.error) {
        stage = `<div class="ex-pv-stage empty"><div class="ex-failed">${escapeAttr(preview.error)}</div></div>`;
    } else {
        stage = `<div class="ex-pv-stage empty"><div class="dim">` +
                `Render ${settings.previewLength} s at these settings and compare it, ` +
                `pixel for pixel, against the same frames unencoded.</div></div>`;
    }

    let controls =
        `<div class="ex-pv-row">` +
        `<button class="tiny primary" id="ex-pv-go"${busy ? ' disabled' : ''}>` +
        `${busy ? 'Rendering…' : (have ? 'Render again' : 'Render preview')}</button>` +
        `<span class="dim">from ${clock(r.start)}</span>` +
        seg('pvlen', PREVIEW_LENGTHS.map((n) => ({ v: n, l: `${n}s` })), settings.previewLength) +
        `</div>`;

    // A transport, not a play button. What a comparison is for is a particular
    // frame — the one where the gradient bands or the smeared grass are — and
    // finding it means scrubbing to it and stepping around it. The timecode is
    // the timeline's, not the preview file's, so the frame you are looking at
    // is a frame you can go back to on the edit.
    if (have) {
        controls +=
            `<div class="ex-pv-scrub" id="ex-pv-scrub">` +
            `<div class="ex-pv-scrub-track">` +
            `<div class="ex-pv-scrub-played" id="ex-pv-played"></div>` +
            `<div class="ex-pv-scrub-head" id="ex-pv-head"></div>` +
            `</div></div>` +
            `<div class="ex-pv-row">` +
            `<button class="tiny" id="ex-pv-start" title="Back to the start of the preview">&#124;&#9664;</button>` +
            `<button class="tiny" id="ex-pv-prev" title="Previous frame">&#9664;</button>` +
            `<button class="tiny primary" id="ex-pv-play" title="Play / pause (Space)">` +
            `${preview.playing ? 'Pause' : 'Play'}</button>` +
            `<button class="tiny" id="ex-pv-next" title="Next frame">&#9654;</button>` +
            // Two children of the row, not one holding two: a span that is a
            // flex item does not lay its own inline children out — they come
            // out drawn on top of each other.
            `<span class="mono" id="ex-pv-time"></span>` +
            `<span class="mono dim" id="ex-pv-len"></span>` +
            seg('pvmode', [{ v: 'wipe', l: 'Wipe' }, { v: 'side', l: 'Side by side' }], preview.mode) +
            `<span class="dim">drag the divider</span>` +
            `</div>`;
    }

    el.preview.innerHTML = head + stage + controls + previewStats();

    const go = id('ex-pv-go');
    if (go) go.addEventListener('click', startPreview);

    const play = id('ex-pv-play');
    if (play) play.addEventListener('click', () => setPreviewPlaying(!preview.playing));

    const toStart = id('ex-pv-start');
    if (toStart) toStart.addEventListener('click', () => seekPreview(0));

    const prev = id('ex-pv-prev');
    if (prev) prev.addEventListener('click', () => stepPreview(-1));
    const next = id('ex-pv-next');
    if (next) next.addEventListener('click', () => stepPreview(1));

    const scrub = id('ex-pv-scrub');
    if (scrub) {
        const move = (e) => {
            const box = scrub.getBoundingClientRect();
            if (!box.width) return;
            const cand = id('ex-pv-cand');
            const len = cand && cand.duration > 0 ? cand.duration : settings.previewLength;
            seekPreview(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * len);
        };
        scrub.addEventListener('mousedown', (e) => {
            // Scrubbing means looking, so it stops. Resuming from wherever the
            // hand let go is what every other transport in the app does.
            setPreviewPlaying(false);
            move(e);
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });
    }

    for (const b of el.preview.querySelectorAll('button[data-seg]')) {
        b.addEventListener('click', () => {
            const name = b.getAttribute('data-seg');
            const v = b.getAttribute('data-v');
            if (name === 'pvlen') {
                settings.previewLength = Number(v);
                invalidatePreview();
            } else if (name === 'pvmode') {
                preview.mode = v;
            }
            drawPreview();
        });
    }

    const area = id('ex-pv-wipearea');
    if (area) {
        const move = (e) => {
            const box = area.getBoundingClientRect();
            if (!box.width) return;
            preview.wipe = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
            const win = area.querySelector('.ex-pv-window');
            const handle = area.querySelector('.ex-pv-handle');
            if (win) win.style.width = `${preview.wipe * 100}%`;
            if (handle) handle.style.left = `${preview.wipe * 100}%`;
        };
        area.addEventListener('mousedown', (e) => {
            move(e);
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });
    }

    if (have) attachPreviewVideos();
}

/// Both files into their elements, sized to the stage. The candidate drives;
/// the reference is corrected only when it drifts, for the same reason the
/// viewer chases rather than seeks — a seek per frame per video comes apart
/// within seconds.
function attachPreviewVideos() {
    const ref = id('ex-pv-ref');
    const cand = id('ex-pv-cand');
    if (!ref || !cand) return;
    if (ref.src !== preview.refPath) ref.src = preview.refPath;
    if (cand.src !== preview.candPath) cand.src = preview.candPath;
    ref.loop = true;
    cand.loop = true;
    fitPreviewVideos();
    syncPlayback();
}

/// Place both videos on the same pixels.
///
/// The wipe only means anything if the two pictures line up exactly, so they
/// are fitted in pixels against the *stage* — not against the window the top
/// one is clipped by, which is narrower and would squash it into a comparison
/// between a picture and a squeezed copy of itself.
function fitPreviewVideos() {
    const ref = id('ex-pv-ref');
    const cand = id('ex-pv-cand');
    if (!ref || !cand) return;

    // In wipe mode both are measured against the stage, because the encoded
    // one's own parent is the clipping window. Side by side, each half is its
    // own box.
    const stage = id('ex-pv-wipearea');
    const aspect = (settings.width || 16) / Math.max(1, settings.height || 9);

    for (const v of [ref, cand]) {
        const host = stage || v.parentNode;
        const box = host ? host.getBoundingClientRect() : null;
        if (!box || !box.width || !box.height) continue;

        let w = box.width, h = w / aspect;
        if (h > box.height) { h = box.height; w = h * aspect; }
        v.style.left = `${Math.round((box.width - w) / 2)}px`;
        v.style.top = `${Math.round((box.height - h) / 2)}px`;
        v.style.width = `${Math.round(w)}px`;
        v.style.height = `${Math.round(h)}px`;
    }
}

/// Ask both to play or both to stop.
///
/// Asking once is not enough. This runs in the same turn as the `src` that
/// created them, when the file has not been opened yet and there is nothing to
/// play — the request is simply dropped, and the preview sits on its first
/// frame with the button reading "Pause". So the wanted state is remembered
/// and `chasePreview()` keeps asking until it takes.
function syncPlayback() {
    const ref = id('ex-pv-ref');
    const cand = id('ex-pv-cand');
    if (!ref || !cand) return;
    if (preview.playing) { ref.play(); cand.play(); }
    else { ref.pause(); cand.pause(); }
}

function setPreviewPlaying(on) {
    preview.playing = on;
    const b = id('ex-pv-play');
    if (b) b.textContent = on ? 'Pause' : 'Play';
    syncPlayback();
}

/// Both to the same time, exactly. While the pictures are still this is a
/// straight seek rather than the drift correction playback uses: a wipe
/// between two frames a fraction of a second apart shows the movement between
/// them, not what the encoder did, and that is the whole comparison lost.
function seekPreview(t) {
    const ref = id('ex-pv-ref');
    const cand = id('ex-pv-cand');
    if (!ref || !cand) return;
    const len = cand.duration > 0 ? cand.duration : settings.previewLength;
    const at = Math.max(0, Math.min(len - 1e-3, t));
    ref.currentTime = at;
    cand.currentTime = at;
    updatePreviewTime();
}

/// One frame, on both. `stepFrame()` rather than `currentTime += 1/fps`,
/// because fps is an average and the seconds round-trip misses frame
/// boundaries — a back-step lands where it started.
function stepPreview(dir) {
    const ref = id('ex-pv-ref');
    const cand = id('ex-pv-cand');
    if (!ref || !cand) return;
    setPreviewPlaying(false);
    for (const v of [cand, ref]) {
        if (v.stepFrame) v.stepFrame(dir);
        else v.currentTime = Math.max(0, v.currentTime + dir / (settings.fps || project.fps || 30));
    }
    // Whatever the candidate landed on is the frame being compared; the
    // reference is put on the same one rather than trusted to have stepped the
    // same distance, because the two files can have different frame layouts.
    if (Math.abs(ref.currentTime - cand.currentTime) > 1e-3) ref.currentTime = cand.currentTime;
    updatePreviewTime();
}

/// Where the comparison is, said in the timeline's own terms. The preview file
/// starts at zero; the frame in it is somewhere in the middle of the edit, and
/// that is the number worth showing.
function updatePreviewTime() {
    const cand = id('ex-pv-cand');
    const out = id('ex-pv-time');
    if (!cand) return;
    const len = cand.duration > 0 ? cand.duration : Math.max(0.001, settings.previewLength);
    const at = Math.max(0, Math.min(len, cand.currentTime || 0));
    const fps = settings.fps || project.fps || 30;

    if (out) out.textContent = timecode(previewRange().start + at, fps);
    const lenOut = id('ex-pv-len');
    if (lenOut) lenOut.textContent = `${at.toFixed(2)} / ${len.toFixed(2)} s`;

    const frac = at / len;
    const played = id('ex-pv-played');
    const head = id('ex-pv-head');
    if (played) played.style.width = `${(frac * 100).toFixed(2)}%`;
    if (head) head.style.left = `${(frac * 100).toFixed(2)}%`;

    // And on the strip, against the whole timeline — which is what makes it
    // playback of a part of the edit rather than of an unrelated little file.
    const marker = id('ex-strip-head');
    if (marker) {
        const total = Math.max(0.001, duration());
        marker.style.left = `${(((previewRange().start + at) / total) * 100).toFixed(3)}%`;
        marker.classList.remove('hidden');
    }
}

function previewStats() {
    const s = preview.stats;
    if (!s) return '';
    const kbps = (s.bytes * 8) / s.seconds / 1000;
    const r = range();
    // The whole point: what this costs over the length actually being written.
    const projected = r.length > 0 ? s.bytes * (r.length / s.seconds) : 0;
    const speed = s.elapsed > 0 ? s.seconds / s.elapsed : 0;

    return `<div class="ex-pv-stats mono">` +
        `<div><span class="dim">this ${s.seconds.toFixed(1)} s</span> ` +
        `${bytes(s.bytes)} · ${kbps < 1000 ? kbps.toFixed(0) + ' kbps' : (kbps / 1000).toFixed(1) + ' Mbps'}</div>` +
        `<div><span class="dim">whole render</span> <span class="good">≈ ${bytes(projected)}</span> ` +
        `over ${clock(r.length)}</div>` +
        `<div><span class="dim">speed</span> ${s.encodeFps.toFixed(1)} fps · ` +
        `${speed >= 1 ? speed.toFixed(1) + '× real time' : (1 / Math.max(speed, 0.001)).toFixed(1) + '× slower than real time'}` +
        (r.length > 0 && speed > 0 ? ` · about ${elapsed(r.length / speed)} for the lot` : '') +
        `</div></div>`;
}

// ── the range strip ────────────────────────────────────────────────────────
//
// The timeline, small, with the part being written picked out. Dragging the
// ends sets the in and out points; dragging the middle moves where the preview
// samples from, which is nearly always the thing you want to look at.

let stripDrag = null;
let laneTop = 0.8;      // where the preview lane starts, as a fraction of the height

/// The markup, once. Painting is a separate job, because a canvas cannot
/// measure itself in the same turn it was created in — it has not been laid
/// out yet — and rebuilding the markup to resize it would mean it never could.
function drawStrip() {
    const r = range();

    el.strip.innerHTML =
        `<div class="section-head">Range</div>` +
        `<div class="ex-strip-wrap">` +
        `<canvas id="ex-strip-c" class="ex-strip"></canvas>` +
        // Where the preview has got to, against the whole edit. A div over the
        // canvas rather than part of it: this moves every frame, and repainting
        // a window-wide canvas to shift one line is work for nothing.
        `<div id="ex-strip-head" class="ex-strip-head hidden"></div>` +
        `</div>` +
        `<div class="ex-pv-row mono">` +
        `<span id="ex-range-nums">${rangeNumbers(r)}</span>` +
        `<span class="spacer"></span>` +
        `<button class="tiny" id="ex-range-all">Whole timeline</button>` +
        `</div>`;

    const all = id('ex-range-all');
    if (all) all.addEventListener('click', () => {
        settings.rangeIn = 0; settings.rangeOut = 0;
        invalidatePreview();
        drawAll();
    });

    const canvas = id('ex-strip-c');
    if (canvas) canvas.addEventListener('mousedown', stripPress);

    paintStrip();
}

/// Spaced with non-breaking spaces: these used to be separate children of a
/// flex row, which spaced them itself. Inside one element they are inline, and
/// the whitespace between an element and a text node does not survive.
function rangeNumbers(r) {
    return `<span class="dim">in</span>&#160;${clock(r.start)}&#160;&#160;` +
           `<span class="dim">out</span>&#160;${clock(r.end)}&#160;&#160;` +
           `<span class="dim">·</span>&#160;${clock(r.length)}`;
}

function paintStrip() {
    const total = Math.max(0.001, duration());
    const r = range();

    const nums = id('ex-range-nums');
    if (nums) nums.innerHTML = rangeNumbers(r);

    const canvas = id('ex-strip-c');
    if (!canvas) return;

    // Sized from the element, not from a number here: it is as wide as the
    // window now, and a canvas drawn at one size and stretched to another is a
    // blurred one.
    const box = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(box.width || 420));
    const h = Math.max(30, Math.round(box.height || 62));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const RULER = 13;                 // ticks along the top
    const LANE = 12;                  // where the preview samples from, along the bottom
    const bodyTop = RULER, bodyBot = h - LANE;

    const x = (t) => (t / total) * w;

    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);

    // A ruler, because the strip is wide enough to read one off. The step is
    // the first round number that leaves the labels a clear 70 px apart, so it
    // stays legible from a two-second edit to a two-hour one.
    const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const wanted = (70 / w) * total;
    const step = STEPS.find((s) => s >= wanted) || Math.ceil(wanted / 3600) * 3600;
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= total; t += step) {
        ctx.fillStyle = '#2f3540';
        ctx.fillRect(Math.round(x(t)), 0, 1, RULER);
        ctx.fillStyle = '#6c7482';
        ctx.fillText(clock(t), Math.round(x(t)) + 3, 1);
    }

    // One row per track, bottom track at the bottom, so the strip reads the
    // same way round as the timeline it is standing in for.
    const tracks = new Set();
    for (const c of project.clips) tracks.add(c.track);
    const list = Array.from(tracks).sort((a, b) => a - b);
    // Capped as well as divided: one track left to itself would fill the band
    // with a slab, and a clip reads as a clip when it is a bar on a lane.
    const rowH = Math.max(4, Math.min(16,
        Math.floor((bodyBot - bodyTop - 2) / Math.max(1, list.length))));

    for (const c of project.clips) {
        const i = list.indexOf(c.track);
        const y = bodyBot - (i + 1) * rowH;
        ctx.fillStyle = '#3a4a5a';
        ctx.fillRect(x(c.start), y, Math.max(1, x(c.length)), rowH - 1);
    }

    // Outside the range, dimmed; inside, left alone.
    ctx.fillStyle = 'rgba(10,10,10,0.72)';
    ctx.fillRect(0, bodyTop, x(r.start), bodyBot - bodyTop);
    ctx.fillRect(x(r.end), bodyTop, w - x(r.end), bodyBot - bodyTop);

    ctx.strokeStyle = '#ff8c42';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(r.start) + 1, bodyTop); ctx.lineTo(x(r.start) + 1, bodyBot);
    ctx.moveTo(x(r.end) - 1, bodyTop);   ctx.lineTo(x(r.end) - 1, bodyBot);
    ctx.stroke();

    // Where the preview samples from, and how much of it.
    const pr = previewRange();
    ctx.fillStyle = 'rgba(120, 200, 255, 0.35)';
    ctx.fillRect(x(pr.start), bodyBot, Math.max(2, x(pr.end - pr.start)), LANE);
    ctx.strokeStyle = '#78c8ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(pr.start) + 0.5, bodyBot); ctx.lineTo(x(pr.start) + 0.5, h);
    ctx.stroke();

    // What the bottom lane is, in the canvas's own pixels, so the press
    // handler can tell the range apart from the preview marker.
    laneTop = bodyBot / h;
}

/// The strip is a canvas the width of the window, and a canvas drawn at one
/// size and stretched to another is a blurred one. Its first paint happens in
/// the same turn as the markup that created it, before it has been laid out at
/// all, so the size it wants is not knowable until a frame later — and the
/// window is entitled to change size after that.
function refitStrip() {
    if (!open) return;
    const canvas = id('ex-strip-c');
    if (!canvas) return;
    const w = Math.round(canvas.getBoundingClientRect().width);
    if (w > 0 && w !== canvas.width) paintStrip();
}

/// Which of the three things under the pointer is being dragged.
function stripPress(e) {
    const canvas = id('ex-strip-c');
    if (!canvas) return;
    const total = Math.max(0.001, duration());
    const r = range();
    const bb = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(total, ((e.clientX - bb.left) / Math.max(1, bb.width)) * total));
    // In pixels, not in a fraction of the timeline: a tenth of an hour is an
    // enormous grab radius and a tenth of two seconds is an invisible one, and
    // what the hand is aiming at is a line on the screen.
    const grab = (10 / Math.max(1, bb.width)) * total;
    const nearIn = Math.abs(t - r.start) < grab;
    const nearOut = Math.abs(t - r.end) < grab;
    // Below the clip rows is the preview lane; above it, the range.
    const inPreviewLane = (e.clientY - bb.top) > laneTop * bb.height;
    stripDrag = inPreviewLane ? 'preview' : nearIn ? 'in' : nearOut ? 'out' : 'preview';
    stripMove(e);

    const up = () => {
        stripDrag = null;
        window.removeEventListener('mousemove', stripMove);
        window.removeEventListener('mouseup', up);
        invalidatePreview();
        drawAll();
    };
    window.addEventListener('mousemove', stripMove);
    window.addEventListener('mouseup', up);
}

function stripMove(e) {
    if (!stripDrag) return;
    const canvas = id('ex-strip-c');
    if (!canvas) return;
    const total = Math.max(0.001, duration());
    const bb = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(total, ((e.clientX - bb.left) / Math.max(1, bb.width)) * total));

    if (stripDrag === 'in') {
        const out = settings.rangeOut > 0 ? settings.rangeOut : total;
        settings.rangeIn = Math.min(t, out - 0.1);
    } else if (stripDrag === 'out') {
        settings.rangeOut = Math.max(t, settings.rangeIn + 0.1);
    } else {
        preview.at = Math.min(t, Math.max(0, total - 0.2));
    }
    paintStrip();
    updateSummary();
}

// ── the summary ────────────────────────────────────────────────────────────

function updateSummary() {
    const r = range();
    const fps = settings.fps || project.fps || 30;
    const frames = Math.max(1, Math.round(r.length * fps));
    const clips = project.clips.length;
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;

    // What the file will be, in the terms the file will be described in by
    // whatever opens it next.
    let size = '';
    if (preview.stats && preview.stats.seconds > 0) {
        size = ` · ≈ ${bytes(preview.stats.bytes * (r.length / preview.stats.seconds))} (measured)`;
    } else if (settings.rate === 'bitrate' || settings.rate === 'constrained') {
        const kbps = settings.videoBitrate + (settings.audio ? settings.audioCodecBitrate : 0);
        size = ` · ≈ ${bytes(kbps * 1000 * r.length / 8)}`;
    }

    const warn = warnings();
    el.summary.innerHTML =
        `<div class="mono">${settings.width}&times;${settings.height} · ${fps.toFixed(3)} fps · ` +
        `${clock(r.length)} · ${frames} frames${size}</div>` +
        `<div class="mono dim">${escapeAttr(codec || '?')}` +
        (settings.audio && settings.audioCodec ? ` + ${escapeAttr(settings.audioCodec)}` : ' · silent') +
        ` · ${settings.container} · ${clips} clip${clips === 1 ? '' : 's'} flattened · ` +
        `${escapeAttr(commandLine())}</div>` +
        warn.map((t) => `<div class="warn">${escapeAttr(t)}</div>`).join('');
    updateFileLabel();
}

/// The options as ffmpeg would have been given them. Shown because it is the
/// shortest complete statement of what is about to happen, and because anyone
/// who knows ffmpeg can read it faster than they can read the form.
function commandLine() {
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;
    const v = videoOptions(codec);
    const parts = [];
    for (const k of Object.keys(v)) parts.push(`-${k} ${v[k]}`);
    if (settings.pixelFormat) parts.push(`-pix_fmt ${settings.pixelFormat}`);
    return parts.join(' ') || 'encoder defaults';
}

// ── running ────────────────────────────────────────────────────────────────

function begin() {
    if (job) return;
    const spec = buildSpec();
    if (!spec.path) {
        if (hooks.flash) hooks.flash('Choose a file to write to');
        return;
    }
    settings.path = spec.path;
    remember();

    try {
        bro.ffmpeg.render.start(spec);
    } catch (e) {
        el.progress.innerHTML = `<div class="ex-failed">${escapeAttr(String(e.message || e))}</div>`;
        showPanel('progress');
        setJob(null);
        return;
    }
    setJob('export');
    showPanel('progress');
    // The first draw comes from a real poll rather than a hand-made stand-in:
    // one shape, filled in by one place, so a field added to the status cannot
    // be missing from the frame the progress panel opens on.
    lastPoll = bro.ffmpeg.render.poll();
    drawProgress(lastPoll);
}

/// Called once a frame while the workspace is up. The render is on its own
/// thread; this is the only thing that looks at it.
export function tick() {
    if (!job) { chasePreview(); refitStrip(); return; }
    const p = bro.ffmpeg.render.poll();
    lastPoll = p;

    if (job === 'export') {
        drawProgress(p);
        if (p.state !== 'running') {
            setJob(null);
            showPanel('progress');
            if (hooks.finished) hooks.finished(p);
        }
        return;
    }

    if (p.state === 'running') { drawPreview(); return; }
    previewFinished(p);
}

/// Keep the two preview videos on the same frame. The candidate is the clock;
/// the reference is nudged only when it has drifted far enough to be visible
/// across the wipe, because writing currentTime every frame fights the decoder.
function chasePreview() {
    if (!open || !preview.refReady || !preview.candReady) return;
    const ref = id('ex-pv-ref');
    const cand = id('ex-pv-cand');
    if (!ref || !cand) return;
    // The first fit runs in the same turn as the innerHTML that created the
    // elements, when the stage has not been laid out and measures zero. Retry
    // until it measures something rather than guessing at a size.
    //
    // And again whenever the stage changes size, which it now does: the stage
    // takes whatever the window leaves, so resizing the window or opening the
    // advanced column moves it. Videos placed in pixels do not follow on their
    // own — that is the price of placing them exactly.
    const stage = ref.parentNode && ref.parentNode.getBoundingClientRect
        ? ref.parentNode.getBoundingClientRect() : null;
    const size = stage ? `${Math.round(stage.width)}x${Math.round(stage.height)}` : '';
    if (!ref.style.width || size !== preview.fittedTo) {
        preview.fittedTo = size;
        fitPreviewVideos();
    }
    // Keep asking. `play()` in the turn the src was set is asked of a file
    // that is not open yet and is simply dropped — which is why the preview
    // used to sit on its first frame with the button reading "Pause". A
    // <video> that has stopped for any other reason wants the same treatment.
    if (preview.playing && cand.paused && cand.duration > 0) syncPlayback();

    updatePreviewTime();

    if (!preview.playing) return;
    // A frame, not a tenth of a second. The candidate is the clock and the
    // reference is chased — writing currentTime every frame fights the decoder
    // — but the tolerance has to be smaller than the thing being looked for:
    // half a second of motion across the wipe hides any amount of ringing.
    const limit = 1 / Math.max(1, settings.fps || project.fps || 30);
    if (Math.abs(ref.currentTime - cand.currentTime) > limit)
        ref.currentTime = cand.currentTime;
}

function drawProgress(p) {
    const pct = Math.round((p.progress || 0) * 100);
    const left = p.fps > 0 && p.totalFrames
        ? Math.max(0, (p.totalFrames - p.frames) / p.fps) : 0;

    if (p.state === 'running') {
        el.progress.innerHTML =
            `<div class="ex-bar"><div class="ex-fill" style="width:${pct}%"></div></div>` +
            `<div class="ex-line mono">${pct}% · frame ${p.frames} of ${p.totalFrames}</div>` +
            `<div class="ex-line mono dim">${p.fps.toFixed(1)} fps · ${elapsed(p.elapsed)} so far` +
            (left > 0.5 ? ` · about ${elapsed(left)} left` : '') +
            ` · ${bytes(p.bytes)}</div>` +
            `<div class="ex-line dim">${escapeAttr(p.path)}</div>`;
        return;
    }

    if (p.state === 'done') {
        el.progress.innerHTML =
            `<div class="ex-bar"><div class="ex-fill done" style="width:100%"></div></div>` +
            `<div class="ex-line good">Wrote ${escapeAttr(basename(p.path))}</div>` +
            `<div class="ex-line mono dim">${p.frames} frames · ${bytes(p.bytes)} · ` +
            `${elapsed(p.elapsed)} at ${p.fps.toFixed(1)} fps</div>` +
            `<div class="ex-line dim">${escapeAttr(p.path)}</div>` +
            `<div class="ex-line"><button class="tiny" id="ex-import">Add it to the timeline</button>` +
            `<button class="tiny" id="ex-back">Back to settings</button></div>`;
        const add = id('ex-import');
        if (add) add.addEventListener('click', () => {
            closeExport();
            if (hooks.open) hooks.open(p.path);
        });
        const back = id('ex-back');
        if (back) back.addEventListener('click', () => { showPanel('form'); drawAll(); });
        return;
    }

    const label = p.state === 'cancelled' ? 'Stopped' : 'Export failed';
    const cls = p.state === 'cancelled' ? 'dim' : 'ex-failed';
    el.progress.innerHTML =
        `<div class="ex-bar"><div class="ex-fill stopped" style="width:${pct}%"></div></div>` +
        `<div class="ex-line ${cls}">${label}${p.error ? ': ' + escapeAttr(p.error) : ''}</div>` +
        (p.state === 'cancelled'
            ? `<div class="ex-line mono dim">${p.frames} of ${p.totalFrames} frames were ` +
              `written, and the part it got to is playable</div>` +
              `<div class="ex-line dim">${escapeAttr(p.path)}</div>`
            : '') +
        `<div class="ex-line"><button class="tiny" id="ex-back">Back to settings</button></div>`;
    const back = id('ex-back');
    if (back) back.addEventListener('click', () => { showPanel('form'); drawAll(); });
}

/// The last thing poll() reported, for the status line and for tests.
export function lastStatus() { return lastPoll; }

/// The keyboard, for the keys that mean something here. No-ops until there is
/// a preview to play, which is the right answer rather than an error.
export function togglePreviewPlay() {
    if (!preview.refReady || !preview.candReady) return;
    setPreviewPlaying(!preview.playing);
}
export function stepPreviewBy(dir) {
    if (!preview.refReady || !preview.candReady) return;
    stepPreview(dir);
}

/// For tests: the settings block, and what the encoder is being told.
export function currentSettings() { return settings; }
export function currentOptions() {
    const codec = settings.videoCodec || (containerInfo(settings.container) || {}).videoCodec;
    return videoOptions(codec);
}
export function previewState() { return preview; }
