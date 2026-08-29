// A clip per hit, cut out of the local recording and kept.
//
// This is the verb the corpus exists for. `search` says where a word was said;
// this hands you the seconds around it as a file you can watch, drop on a
// timeline, or send to somebody. Everything expensive — the pull, the
// transcription — has already happened, so a search you thought of a minute ago
// costs a few seconds of encoding per hit and nothing else.
//
// ── Cached by name, and the name is the fact ──────────────────────────────
//
// A clip is `<vodId>-<seconds>.mp4`, which is exactly the two things that
// identify the moment: which recording, and where in it. So asking for the same
// search twice writes nothing the second time, two different searches that both
// land on one moment share the file rather than making it twice, and widening
// the padding is a different file rather than a silent overwrite of a clip
// somebody may already have used.
//
// **The word's own time is where the clip is cut from**, with no re-location and
// no alignment pass, because the transcript was read from this same file — see
// the block at the top of `corpus.js`. That is the whole payoff of pulling the
// picture rather than the audio-only rendition.
//
// ── Re-encoded, not copied ────────────────────────────────────────────────
//
// A stream copy can only begin at a keyframe, so it arrives with up to a GOP of
// lead-in and cannot give the span asked for. For a clip built around a single
// word — where the whole point is that the word is *in* it, near the middle —
// that is the wrong trade: at 1080p60 a GOP can be two seconds, which is longer
// than the clip. `--copy` is there for when speed matters more than the edges.

import { openMedia, clearEdit } from './corpus.js';
import { mkdirp, exists, abs, clock, mb } from './drive.js';

/// Cut one clip out of whatever is on the timeline.
export function cutOne(A, drive, from, to, path, opts = {}) {
    A.shell.goTo('write');
    drive.pump(250);
    const S = A.exporter.currentSettings();
    S.container = 'mp4';
    S.videoCodec = opts.videoCodec || 'libx264';
    S.audio = true;
    S.audioCodec = 'aac';
    S.sampleRate = 48000;
    S.channels = 2;
    S.path = abs(path);
    S.rangeIn = from;
    S.rangeOut = to;
    S.fps = 0;              // follow the project, which is this recording's rate
    S.width = 0;
    S.height = 0;
    S.streams = A.exporter.defaultStreams();
    A.exporter.redraw();
    drive.pump(200);

    document.getElementById('ex-go').click();
    drive.until(`the clip at ${clock(from)}`,
                () => bro.ffmpeg.render.poll().state !== 'running', 30 * 60 * 1000);
    const p = bro.ffmpeg.render.poll();
    assert(p.state === 'done', `the clip at ${clock(from)} ${p.state}: ${p.error || ''}`);
    return abs(path);
}

/// Cut every hit into its own file, skipping the ones already on disk.
///
/// `hits` is what `corpus.search` answers, so each already knows the local
/// recording it came from and the time is on that recording's clock.
export function cutClips(A, drive, opts) {
    const { hits, dir } = opts;
    const pad = opts.pad === undefined ? 1.5 : opts.pad;
    const tail = opts.tail === undefined ? 1.5 : opts.tail;
    const log = opts.log || console.log;
    mkdirp(dir);

    const byVod = new Map();
    for (const h of hits) {
        if (!byVod.has(h.vodId)) byVod.set(h.vodId, []);
        byVod.get(h.vodId).push(h);
    }

    const made = [];
    const skipped = [];
    const missing = [];

    for (const [vodId, group] of byVod) {
        group.sort((a, b) => a.at - b.at);

        // Which of this recording's hits are not already on disk. Worked out
        // before the file is opened, so a search whose clips all exist costs no
        // decoder at all — which is what makes re-running one free.
        const todo = [];
        for (const h of group) {
            const path = `${dir}/${vodId}-${Math.floor(h.at)}.mp4`;
            if (exists(path)) { skipped.push({ ...h, path }); continue; }
            todo.push({ h, path });
        }
        if (!todo.length) continue;

        if (!group[0].media || !exists(group[0].media)) {
            // A transcript outlives its recording: the words are still
            // searchable after the media has been deleted to reclaim the disk.
            for (const h of group) missing.push(h);
            continue;
        }

        clearEdit(A, drive);
        const source = openMedia(A, drive, group[0].media, { name: vodId });
        const end = source.probe.format.duration;
        log(`${vodId} · ${todo.length} to cut` +
            (group.length - todo.length ? ` · ${group.length - todo.length} already there` : ''));

        for (const { h, path } of todo) {
            const from = Math.max(0, h.at - pad);
            const to = Math.min(end, (h.says || h.at) + tail);
            if (!(to > from)) continue;
            cutOne(A, drive, from, to, path, opts);
            made.push({ ...h, path, from, to });
        }
    }

    return { made, skipped, missing };
}
