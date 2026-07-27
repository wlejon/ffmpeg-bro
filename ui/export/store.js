// Remembering what the workspace was last set to.
//
// localStorage, not bro.settings: bro's settings are a closed schema of engine
// keys and warn about anything else, so an application preference does not
// belong there. One key holding the whole block, because these fields are only
// ever read and written together.

import { settings } from './state.js';
import { muxers, hasMuxer, muxerForExtension, encoderInfo, audioInfo } from './capabilities.js';
import { normalizeStreams } from './streams.js';

const SETTINGS_KEY = 'ffmpeg-bro.export';

// `chapters` is deliberately not in here. A chapter is a pair of times on
// *this* timeline, and carrying "Opening, 0 to 12.5s" into the next edit would
// put a mark somewhere that means nothing — unlike a codec or a language,
// which mean the same thing whatever is being written.
const REMEMBERED = ['container', 'videoCodec', 'audioCodec', 'rate', 'quality',
                    'videoBitrate', 'maxrate', 'bufsize', 'preset', 'tune', 'profile',
                    'pixelFormat', 'fps', 'scaler', 'gopSeconds', 'bframes',
                    'colorspace', 'colorRange', 'faststart', 'audio',
                    'audioCodecBitrate', 'sampleRate', 'channels',
                    'extraVideo', 'extraAudio', 'extraFormat', 'previewLength',
                    'streams', 'metadata'];

let fresh = true;

/// True until something has been restored — the caller starts a first run on a
/// named preset rather than on a pile of defaults that matches none of them
/// and reads as "custom" before anything has been customised.
export const isFirstRun = () => fresh;
export const noLongerFirstRun = () => { fresh = false; };

export function restore() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            const blob = JSON.parse(saved);
            for (const k of REMEMBERED) if (blob[k] !== undefined) settings[k] = blob[k];
            fresh = false;
        }
    } catch (e) { /* first run, or a stored blob from an older shape */ }
    // The remembered container and codec may not exist in this build — and
    // `container` used to hold an *extension*, so a blob written before muxers
    // were asked for by name says "mkv", which libavformat has never heard of.
    // Guessing the muxer from the extension is what libavformat itself does
    // with a filename, so one answer covers both the migration and a build
    // that has genuinely lost a muxer.
    if (!hasMuxer(settings.container)) {
        settings.container = muxerForExtension(settings.container) ||
                             (hasMuxer('mp4') ? 'mp4' : (muxers()[0] || {}).name || '');
    }
    if (settings.videoCodec && !encoderInfo(settings.videoCodec)) settings.videoCodec = '';
    if (settings.audioCodec && !audioInfo(settings.audioCodec)) settings.audioCodec = '';
    // A stored blob outlives the shape it was stored in, and a stream row with
    // a kind this build cannot write would reach render.start and be refused
    // there — on the far side of a stage where nothing looks wrong.
    normalizeStreams();
}

export function remember() {
    try {
        const blob = {};
        for (const k of REMEMBERED) blob[k] = settings[k];
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(blob));
    } catch (e) { /* not fatal: the export still runs */ }
}
