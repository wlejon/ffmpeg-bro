// One utterance of a phrase, assembled out of every instance of it.
//
// The flipbook beside this takes a single frame per instance, which answers
// "how many times" and nothing else: it is silent by construction, and no
// instance is on screen long enough to be *heard*. This is the other thing to
// do with the same hits, and it is the one that keeps the sound. The word is
// spoken once, and every fragment of it comes from a different take.
//
// ── The rule ──────────────────────────────────────────────────────────────
//
// Instance i of N contributes exactly the i-th N-th **of its own utterance**:
// the first take gives its first fourteenth, the second take its second
// fourteenth, and so on, laid end to end. So the fragments line up
// *phonetically* — every take is cut at the same point through the word rather
// than at the same number of milliseconds in — which is what leaves the result
// still sounding like somebody saying the word, instead of fourteen unrelated
// syllables in a row.
//
// **That the takes are different lengths is the whole reason the split is by
// fraction and not by time.** Across these recordings the same word runs 0.48 s
// in one instance and 1.12 s in another; cutting both at a fixed 57 ms lands
// mid-vowel in the short one and barely past the consonant in the long one. A
// fraction lands in the same place in both.
//
// Nothing is time-stretched — each fragment plays at its own speed and lasts
// `span / N` — so the finished word comes out at exactly the **mean** of the
// utterances it was made from. That is a number that falls out of the material
// rather than one somebody has to choose, which is why there is no `--length`.
//
// `--rounds R` walks the instances R times instead of once, so the cut is R
// times faster while the word stays the same length: with rounds, slice k of
// `N×R` takes fraction `[k/(N·R), (k+1)/(N·R)]` of instance `k mod N`, and the
// total is still the mean however many rounds are asked for.
//
// ── Why this is one render and not a concatenation ────────────────────────
//
// `openInput` builds a fresh clip on every call, so one open recording carries
// as many clips as it has hits — four inputs, fourteen clips, one pass. Cutting
// fourteen files and joining them would encode every frame twice to no purpose,
// and these fragments are tens of milliseconds long, which is exactly the
// length at which a second generation shows.
//
// The edit is saved beside the video as a `.fbro`. A weave is a judgement call
// — a fragment that lands on a cough is obvious once you hear it and invisible
// beforehand — so the thing to hand somebody is an edit they can open and nudge,
// not only a file they can watch.

import { openMedia, clearEdit } from './corpus.js';
import { abs, mkdirp, exists, clock } from './drive.js';

// A transcript can hand back a zero or negative span where two word cues abut,
// and a fraction of nothing is nothing at all. The floor keeps such a take in
// the weave — with a plausible length — rather than dropping it silently, which
// for a supercut is the one failure that cannot be seen in the output.
const MIN_SPAN = 0.15;

/// Build the weave: every instance, cut at its own fraction of the word.
///
/// `hits` is what `corpus.search` answers, so each one already knows its local
/// recording and its time is on that recording's clock — there is no alignment
/// pass here for the same reason there is none in `clips.js`.
export function weave(A, drive, opts) {
    const { hits, out } = opts;
    const rounds = Math.max(1, Math.round(opts.rounds || 1));
    const log = opts.log || console.log;
    mkdirp(abs(out).slice(0, abs(out).lastIndexOf('/')));

    // **A transcript outlives its recording**: the store keeps the words after
    // the media has been deleted to reclaim the disk, so a hit with no file is
    // an ordinary state and the other instances still make a weave.
    const usable = hits.filter((h) => h.media && exists(h.media));
    const missed = hits.filter((h) => !(h.media && exists(h.media)))
                       .map((h) => ({ ...h, why: 'recording not on disk' }));
    assert(usable.length, 'not one instance is in a recording on disk');

    const N = usable.length;
    const K = N * rounds;
    const spans = usable.map((h) => Math.max(MIN_SPAN, (h.says || 0) - h.at));

    // ── open one input per recording ───────────────────────────────────────
    clearEdit(A, drive);
    const inputs = new Map();
    for (const h of usable) {
        if (inputs.has(h.vodId)) continue;
        log(`opening ${h.vodId}${h.title ? ` · ${h.title.slice(0, 44)}` : ''}`);
        inputs.set(h.vodId, openMedia(A, drive, h.media, { name: h.vodId }));
    }
    // `openMedia` lays a clip out to prove the file plays. The weave places its
    // own clips at its own trims, so those go before any of them are made.
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    drive.pump(200);

    // ── lay the fragments out ──────────────────────────────────────────────
    let at = 0;
    const placed = [];
    for (let k = 0; k < K; k++) {
        const i = k % N;
        const h = usable[i];
        const span = spans[i];
        const input = inputs.get(h.vodId);
        const end = input.probe.format.duration;

        // The fraction of *this* take's own word, which is the rule the whole
        // file is about, clamped so a take near the end of a recording cannot
        // ask for frames past it.
        const want = span / K;
        const from = Math.max(0, Math.min(h.at + (k / K) * span, end - want));
        if (!(want > 0) || !(from >= 0) || !(from + want <= end)) {
            log(`  – ${clock(h.at)} will not fit inside its recording — dropped`);
            missed.push({ ...h, why: 'outside the recording' });
            continue;
        }

        const clip = A.openInput(input);
        assert(clip, `${h.vodId} would not lay out a clip at ${clock(h.at)}`);
        clip.inPoint = from;
        clip.length = Math.min(want, clip.media - from);
        clip.start = at;
        clip.track = 0;
        at += clip.length;
        placed.push({ ...h, round: Math.floor(k / N) + 1, index: i,
                      from, length: clip.length, start: clip.start });
    }
    assert(placed.length, 'not one fragment could be laid out');
    // Laid end to end by construction, so there is nothing to collide and
    // nothing for `resolveOverlaps` to be asked about.
    if (A.sortClips) A.sortClips();
    drive.pump(400);

    const lengths = placed.map((p) => p.length);
    const shortest = Math.min(...lengths);
    log(`${placed.length} fragments · ${at.toFixed(2)} s · ` +
        `shortest ${(shortest * 1000).toFixed(0)} ms`);

    // ── save the edit, then render it ──────────────────────────────────────
    const docPath = abs(out).replace(/\.[^./\\]+$/, '.fbro');
    A.doc.save(docPath);
    drive.pump(300);

    A.shell.goTo('write');
    drive.pump(400);
    const S = A.exporter.currentSettings();
    S.container = 'mp4';
    S.videoCodec = opts.videoCodec || 'libx264';
    // The sound is the point of this one, and it is the half the flipbook
    // cannot have.
    S.audio = true;
    S.audioCodec = 'aac';
    S.sampleRate = 48000;
    S.channels = 2;
    S.path = abs(out);
    S.rangeIn = 0;
    S.rangeOut = 0;
    S.fps = opts.fps || 0;   // 0 follows the project, which is the recordings'
    S.width = opts.width || 0;
    S.height = opts.height || 0;
    S.streams = A.exporter.defaultStreams();
    A.exporter.redraw();
    drive.pump(250);

    log(`rendering ${abs(out)}`);
    document.getElementById('ex-go').click();
    drive.until('the weave',
                () => bro.ffmpeg.render.poll().state !== 'running', 60 * 60 * 1000);
    const done = bro.ffmpeg.render.poll();
    assert(done.state === 'done', `the weave ${done.state}: ${done.error || ''}`);

    const got = bro.ffmpeg.probe(abs(out));
    return { out: abs(out), doc: docPath, placed, missed, rounds, instances: N,
             shortest, seconds: got.format.duration, bytes: got.format.size,
             hasAudio: !!got.audio,
             width: got.video ? got.video.width : 0,
             height: got.video ? got.video.height : 0 };
}
