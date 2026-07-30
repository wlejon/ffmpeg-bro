// Remembering what the workspace was last set to.
//
// localStorage, not bro.settings: bro's settings are a closed schema of engine
// keys and warn about anything else, so an application preference does not
// belong there. One key holding the whole block, because these fields are only
// ever read and written together.

import { settings } from './state.js';
import { muxers, hasMuxer, muxerForExtension, encoderInfo, audioInfo } from './capabilities.js';
import { normalizeStreams } from './streams.js';
import { newVersion } from './versions.js';

const SETTINGS_KEY = 'ffmpeg-bro.export';

// `chapters` is deliberately not in here. A chapter is a pair of times on
// *this* timeline, and carrying "Opening, 0 to 12.5s" into the next edit would
// put a mark somewhere that means nothing — unlike a codec or a language,
// which mean the same thing whatever is being written.
const REMEMBERED = ['container', 'videoCodec', 'audioCodec', 'rate', 'quality',
                    'videoBitrate', 'maxrate', 'bufsize', 'preset', 'tune', 'profile',
                    'pixelFormat', 'fps', 'scaler', 'gopSeconds', 'bframes',
                    // `keyframeMode` is remembered and the cut points are not,
                    // which is the whole design: what carries into the next
                    // edit is "put keyframes where it cuts", and where it cuts
                    // is read from that edit. A list of times *is* remembered,
                    // because a list somebody typed is a decision like a codec.
                    'keyframeMode', 'keyframeTimes', 'keyframeExpr',
                    'fpsMode', 'fieldOrder', 'threads', 'threadType', 'shortest',
                    'colorspace', 'colorRange', 'faststart', 'audio',
                    'audioCodecBitrate', 'sampleRate', 'channels',
                    'extraVideo', 'extraAudio', 'extraFormat', 'previewLength',
                    // Where it goes, when that is more than one place. It has
                    // to travel with `container`: a remembered `tee` and a
                    // forgotten destination list is a workspace that opens
                    // saying it will write to several places and naming none.
                    'destinations',
                    // And the versions, for the same reason: "always cut a 720p
                    // proxy beside the master" is a house rule, not a fact
                    // about this timeline, and it is exactly the sort of thing
                    // that is set once and expected to stay set.
                    'versions',
                    // `title` beside `metadata` for the reason it is a named
                    // field rather than a key in it: both reach the render, and
                    // a title carries into the next edit exactly as a language
                    // or a comment does. Unlike `chapters`, it names nothing on
                    // this particular timeline.
                    'streams', 'metadata', 'title'];

let fresh = true;

/// True until something has been restored — the caller starts a first run on a
/// named preset rather than on a pile of defaults that matches none of them
/// and reads as "custom" before anything has been customised.
export const isFirstRun = () => fresh;
export const noLongerFirstRun = () => { fresh = false; };

/// Everything a **document** carries, which is the workspace's list plus the
/// four things that only mean anything inside one edit.
///
/// The distinction is the one `REMEMBERED` is built on, read the other way
/// round: a chapter, a render range and an output path all name something about
/// *this* timeline, so carrying them into the next edit would put a mark
/// somewhere that means nothing — and carrying them inside the document that
/// timeline is in, is the whole point of there being a document. `width` and
/// `height` join them because a render size is measured against a canvas, and
/// the canvas is the document's.
export const DOCUMENT_KEYS = REMEMBERED.concat(
    ['chapters', 'rangeIn', 'rangeOut', 'path', 'width', 'height']);

export function restore() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            adopt(JSON.parse(saved), REMEMBERED);
            fresh = false;
            return;
        }
    } catch (e) { /* first run, or a stored blob from an older shape */ }
    sanitise();
}

/// Take a stored blob — from `localStorage`, or from a document — and become it.
///
/// The two callers differ in which keys they carry and in nothing else, which is
/// why the sanitising below has one home: what a document says about the
/// container it will write is no more trustworthy than what the workspace says,
/// because both were written by a version of this code that is not the one
/// reading them.
export function adopt(blob, keys) {
    const b = blob && typeof blob === 'object' ? blob : {};
    for (const k of keys || REMEMBERED) if (b[k] !== undefined) settings[k] = b[k];
    sanitise();
}

/// What is in `settings` now, made safe to use.
function sanitise() {
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
    // The bags, shape-checked for the same reason the container and the codecs
    // above are: what is in localStorage was written by some earlier version of
    // this application and is not a promise. A `metadata` that comes back
    // `null` reaches `Object.keys()` on the Write stage and takes the whole
    // stage down at boot, where nothing on the screen says which key did it.
    // Nothing writes those shapes today; this is the repair, not a report of
    // one.
    for (const k of ['metadata', 'extraVideo', 'extraAudio', 'extraFormat'])
        if (!settings[k] || typeof settings[k] !== 'object' || Array.isArray(settings[k]))
            settings[k] = {};
    if (!Array.isArray(settings.destinations)) settings.destinations = [];
    // **Two words and no others.** `-fps_mode` reaches the renderer as a string
    // and anything but `cfr` or `vfr` is refused there by name — which is right
    // for a spec somebody wrote and wrong for a workspace, where it would be a
    // render that will not start and a stage with nothing on it saying why. This
    // blob was written by a version of this code that is not the one reading it,
    // and `passthrough` is exactly the kind of value a later version might have
    // put here.
    if (settings.fpsMode !== 'vfr') settings.fpsMode = 'cfr';
    // A version's size reaches `ExportPass::width` as a number and is read
    // there as "zero means the render's", so a stored `"720"` — which is what a
    // text field writes if nothing coerces it — would arrive as a string and be
    // silently no size at all. Coerced here rather than trusted, because this
    // blob was written by a version of this code that is not the one reading
    // it.
    settings.versions = (Array.isArray(settings.versions) ? settings.versions : [])
        .filter((v) => v && typeof v === 'object')
        .map((v) => newVersion({
            path: String(v.path || ''),
            format: hasMuxer(v.format) ? v.format : '',
            width: Math.max(0, Math.round(Number(v.width) || 0)),
            height: Math.max(0, Math.round(Number(v.height) || 0)),
        }));
    // The four a document carries and the workspace does not. Nothing on this
    // list was ever read from storage before there was a document, so this is
    // where their reader is: a chapter reaches the muxer as a pair of times and
    // a title, and one that came back as a string would be written into the
    // container as `NaN`. `path` is left as whatever it says — a path that is
    // not there is a render that fails and says where, which is the answer, not
    // something to be repaired behind somebody's back.
    settings.chapters = (Array.isArray(settings.chapters) ? settings.chapters : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({ start: Math.max(0, Number(c.start) || 0),
                       end: Math.max(0, Number(c.end) || 0),
                       title: String(c.title || '') }));
    settings.path = String(settings.path || '');
    for (const k of ['rangeIn', 'rangeOut'])
        settings[k] = Math.max(0, Number(settings[k]) || 0);
    // Pixels, so whole ones: a size reaches the encoder as an int and half a
    // line is not a picture.
    for (const k of ['width', 'height'])
        settings[k] = Math.max(0, Math.round(Number(settings[k]) || 0));
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
