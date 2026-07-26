// Remembering what the workspace was last set to.
//
// localStorage, not bro.settings: bro's settings are a closed schema of engine
// keys and warn about anything else, so an application preference does not
// belong there. One key holding the whole block, because these fields are only
// ever read and written together.

import { settings } from './state.js';
import { containers, containerInfo, encoderInfo, audioInfo } from './capabilities.js';

const SETTINGS_KEY = 'ffmpeg-bro.export';

const REMEMBERED = ['container', 'videoCodec', 'audioCodec', 'rate', 'quality',
                    'videoBitrate', 'maxrate', 'bufsize', 'preset', 'tune', 'profile',
                    'pixelFormat', 'fps', 'scaler', 'gopSeconds', 'bframes',
                    'colorspace', 'colorRange', 'faststart', 'audio',
                    'audioCodecBitrate', 'sampleRate', 'channels',
                    'extraVideo', 'extraAudio', 'extraFormat', 'previewLength'];

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
    // The remembered container and codec may not exist in this build.
    if (!containerInfo(settings.container))
        settings.container = (containers()[0] || {}).ext || 'mp4';
    if (settings.videoCodec && !encoderInfo(settings.videoCodec)) settings.videoCodec = '';
    if (settings.audioCodec && !audioInfo(settings.audioCodec)) settings.audioCodec = '';
}

export function remember() {
    try {
        const blob = {};
        for (const k of REMEMBERED) blob[k] = settings[k];
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(blob));
    } catch (e) { /* not fatal: the export still runs */ }
}
