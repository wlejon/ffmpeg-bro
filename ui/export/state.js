// What the Output workspace is set to, and what its preview is holding.
//
// One module because these two objects are read by nearly everything else
// here — the form writes them, the spec reads them, the preview invalidates
// itself against them — and passing them down through every call would be
// ceremony around a single source of truth that already exists.
//
// The three readers at the bottom are here for the same reason. Each answers a
// question the settings do not answer literally — which encoder is in force
// when none has been picked, what rate the render actually runs at — and each
// was written out by hand in six or eight places before it was written down
// once. Six copies of a fallback chain is six chances for the summary, the
// command, the warnings and the spec to describe different renders.

import { project, projectFps } from '../project.js';
import { muxerInfo, extOf } from './capabilities.js';

export const PREVIEW_LENGTHS = [1, 2, 3, 5, 10];

// What the workspace was left set to. Remembered across exports because the
// second one is nearly always the first one again with a different range.
export const settings = {
    path: '',
    // The muxer, by the name `-f` takes: "mp4", "matroska", "mpegts". Not an
    // extension — nothing in libavformat is called "mkv", forty-seven muxers
    // have no extension at all and several share one, so a name is the only
    // thing that identifies one. `outputExt()` below is what a file gets
    // called, which is a different question.
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

    // `-force_key_frames`. The *mode* is what is remembered, never the answer:
    // `cuts` re-reads the timeline every time it is asked, so a keyframe stays
    // where the edit cuts after the edit has moved. See `forceKeyFrames()`.
    keyframeMode: 'none',       // none | cuts | times | expr
    keyframeTimes: '',          // "1.5,4,8" — seconds into the output
    keyframeExpr: '',           // the body of `expr:`, without the prefix

    // "" is progressive and is what a composited canvas is. `tt`/`bb` put the
    // encoder into field mode *and* mark the frames, which are two halves of
    // one statement — see ExportStream::fieldOrder.
    fieldOrder: '',
    threads: 0,                 // 0 = libavcodec's auto, which is the right default
    threadType: '',             // "" | frame | slice | frame+slice
    shortest: false,            // stop when the content does, not when the range does

    colorspace: 'auto',
    colorRange: 'tv',
    faststart: true,
    title: '',

    audio: true,
    audioCodecBitrate: 192,
    sampleRate: 48000,
    channels: 2,

    // ── what the file is made of ───────────────────────────────────────────
    //
    // One row per stream the muxer will number, in that order. The default is
    // the file this application has always written — the composite through one
    // video encoder, the mix through one audio encoder — and it arrives
    // without anyone asking for it, because that is what nearly every render
    // is and a Write stage that opened on an empty list would be a form.
    //
    // Everything a row does not say is taken from the settings above: a stream
    // with no codec uses the one the Encode stage is set to, and its options
    // are that stage's expressed against whatever encoder it ends up on. A
    // list that had to repeat all of it to say nothing new is a list nobody
    // would keep in step.
    //
    // `settings.audio` and the audio rows are two halves of one fact and
    // ui/export/streams.js keeps them so: turning sound off empties the audio
    // rows, and adding an audio row turns it back on. Two switches for one
    // decision is how a render comes out silent with a track menu insisting it
    // should not have.
    streams: [
        { id: 1, kind: 'video', source: 'composite' },
        { id: 2, kind: 'audio', source: 'mix' },
    ],

    // ── where it goes, when it goes to more than one place ─────────────────
    //
    // `-f tee` is one encode written to several destinations, each with its own
    // muxer and its own options. It is empty for every render that goes to one
    // place, which is nearly all of them, and it only means anything while the
    // container is `tee` — see ui/export/destination.js, which builds the
    // argument and owns the escaping.
    destinations: [],

    // Beside the streams, not among them: a chapter has no index, nothing is
    // mapped to it and it carries no packets. It is a table in the container,
    // which is exactly how ExportSettings holds it and how a muxer writes it.
    chapters: [],

    // The container's own metadata dictionary. `title` above stays a named
    // field because it is the one everybody sets.
    metadata: {},

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
    // What the settings cost, measured rather than judged: psnr, ssim and —
    // where the build has libvmaf — vmaf, computed on the very two files the
    // wipe is showing. Null until the third render has run, and thrown away the
    // moment the candidate is invalidated, because the previous settings' score
    // under the new settings' picture is the one way this could mislead.
    quality: null,
    // Which render the comparison was, as the host numbered it. The measurements
    // arrive in the report channel keyed to it, and every record there says
    // which render said it — so without this the reading would be over whatever
    // frames were in the series, including a previous comparison's.
    qualityJob: 0,
    measuring: false,
    wipe: 0.5,
    mode: 'wipe',               // wipe | side
    playing: true,
    error: '',
    fittedTo: '',               // the stage size the videos were last placed against
};

// Which render the host's one job slot is currently being used for. The export
// and both halves of the preview take turns through here rather than each
// keeping its own idea of what is going on.
let job = null;   // null | 'export' | 'reference' | 'candidate' | 'quality'
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

// ── what the settings come to ──────────────────────────────────────────────

/// The video encoder in force. Empty in `settings` means "whatever the
/// container's default is", which is a real answer and not an absence — the
/// form draws from it, the spec sends it and the command prints it.
export function activeVideoCodec() {
    return settings.videoCodec || (muxerInfo(settings.container) || {}).videoCodec || '';
}

export function activeAudioCodec() {
    return settings.audioCodec || (muxerInfo(settings.container) || {}).audioCodec || '';
}

/// The rate the render runs at: what was asked for, or the timeline's.
///
/// **Not the same question as `projectFps()`**, and the two are deliberately
/// not merged: this is what the encoder is asked for and that is what the ruler
/// steps by. A render at 60 fps off a 25 fps timeline is an ordinary thing to
/// want. What they share is the fallback, which now has one home rather than
/// eight points of use that had drifted into two answers.
export function outputFps() {
    return settings.fps || projectFps();
}

/// What a file written by the chosen muxer should be called. A reader for the
/// same reason as the three above: the muxer's first extension is the answer in
/// five places — the filename, the file dialog's filter, the preview's temp
/// name, the default path, the command bar — and a muxer with no extension of
/// its own has to fall back to something rather than producing `out.`.
export function outputExt() {
    return extOf(settings.container) || 'out';
}
