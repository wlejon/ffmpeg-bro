// What the Output workspace is set to, and what its preview is holding.
//
// One module because these two objects are read by nearly everything else
// here — the form writes them, the spec reads them, the preview invalidates
// itself against them — and passing them down through every call would be
// ceremony around a single source of truth that already exists.

export const PREVIEW_LENGTHS = [1, 2, 3, 5, 10];

// What the workspace was left set to. Remembered across exports because the
// second one is nearly always the first one again with a different range.
export const settings = {
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
export const preview = {
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

// Which render the host's one job slot is currently being used for. The export
// and both halves of the preview take turns through here rather than each
// keeping its own idea of what is going on.
let job = null;                 // null | 'export' | 'reference' | 'candidate'
const watchers = [];

export const currentJob = () => job;
export const isRendering = () => job !== null;

/// Every change to the slot goes through here. Leaving the workspace while a
/// render holds it would leave that render going with nothing watching it, and
/// the tab that offers to leave has to know on the frame it becomes true —
/// not the next time something happens to redraw.
export function setJob(v) {
    job = v;
    for (const w of watchers) w(v);
}

export function onJobChange(fn) { watchers.push(fn); }
