// The same edit written twice, at two sizes.
//
// This is the other half of a question `destination.js` answers half of, and
// the two are constantly mistaken for each other:
//
//   | | |
//   |---|---|
//   | one encode, several places | `-f tee` — `destination.js` |
//   | several encodes, one edit | this |
//
// **The difference is an encoder, and it is not a detail.** `tee` writes one
// bitstream into several containers: the mp4 and the mkv hold the same frames,
// the same bytes, and cost one encode between them. Two versions are two
// encodes of the same pictures — twice the CPU and two genuinely different
// bitstreams — and there is no way to get a 1080p master and a 720p proxy out
// of one encoder, because an encoder has one frame size. So asking for `tee`
// when you meant this gives you two copies of the same file, and asking for
// this when you meant `tee` costs twice as long for nothing.
//
// **A version is a size and somewhere to put it, and nothing else.** Not a
// second Write stage: the muxer, the codec, the rate control, the stream list
// and the range are the render's, because the thing that makes a proxy a proxy
// is that it is *the same render*, smaller. CRF carries across sizes on its own
// terms — it is a quality target, not a bitrate — so a 720p pass at the
// master's CRF is already the smaller file somebody wanted. The one exception
// is the muxer, which is offered because a proxy in a different container is a
// real thing to want and `ExportPass` already carries one.
//
// **Why a pass and not a second job.** `ffmpeg_job.h` has one slot, and two
// versions are one thing to the person who asked for them: one Stop button,
// one row of progress, one answer at the end. `ExportPass` already means "one
// run over the frames, as a set of overrides", which is exactly what this is —
// see `versionPasses` in spec.js for how the two compose with a two-pass
// encode, which is the case where a render is four walks.

import { settings } from './state.js';

let nextId = 1;

/// A version, with everything absent meaning "the render's".
///
/// Zero rather than null for the size, because that is what the renderer reads
/// it as (`ExportPass::width`) and a second spelling of absence between here
/// and there is a conversion waiting to be got wrong.
export const newVersion = (over = {}) =>
    Object.assign({ id: nextId++, path: '', format: '', width: 0, height: 0 }, over);

/// The versions that describe a render, which is not the same list as the one
/// on screen: a row somebody is still typing is not a render, and half-typed
/// rows are the normal state of a list being filled in.
///
/// A version that names no path is skipped for the reason a `tee` destination
/// with no path is — there is nowhere to write it. A version that names *no
/// size and no muxer* is skipped for a different and better reason: it is a
/// second render of exactly the master, which is a file copy done the
/// expensive way, and doing it silently is worse than not offering it.
export function activeVersions(list = settings.versions) {
    return (list || []).filter(
        (v) => v.path && (v.width > 0 || v.height > 0 || v.format));
}

/// What is wrong with the list, as sentences.
///
/// Only the things that make a render write the wrong file, which for a second
/// output is one thing said twice: two encodes aimed at one path. The last one
/// to finish wins and the other has been thrown away — after paying for it,
/// which is the whole cost of this feature spent on nothing.
export function versionProblems(list = settings.versions, master = settings.path) {
    const said = [];
    const seen = new Map();
    if (master) seen.set(master.toLowerCase(), 'the render itself');
    (list || []).forEach((v, i) => {
        if (!v.path) return;
        const key = v.path.toLowerCase();
        const clash = seen.get(key);
        if (clash)
            said.push(`Version ${i + 1} writes where ${clash} writes. Two encodes to one ` +
                      `path is one file: whichever finishes last, and the other one paid for.`);
        else seen.set(key, `version ${i + 1}`);
    });
    return said;
}

/// A version's size, filled in from the render's where it says nothing.
///
/// One side is enough, and giving one is the ordinary way to ask: a proxy is
/// "720 high" far more often than it is "1280 by 720", and working the other
/// side out from the render's aspect is arithmetic nobody should be made to do
/// in their head. `buildSpec` rounds and clamps whatever comes back, so this
/// does neither — a second implementation of `Math.max(16, …)` is a second
/// answer that could come to differ.
export function versionSize(v, w, h) {
    const aspect = h > 0 ? w / h : 16 / 9;
    if (v.width > 0 && v.height > 0) return { width: v.width, height: v.height };
    if (v.width > 0) return { width: v.width, height: Math.round(v.width / aspect) };
    if (v.height > 0) return { width: Math.round(v.height * aspect), height: v.height };
    return { width: w, height: h };
}
