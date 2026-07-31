// UC03 — "I want a thirty-second excerpt out of this, without wrecking the
// quality, and I do not want to wait."
//
// The answer is a stream copy: the packets that are already in the file, moved
// into a new one, starting at a keyframe. It is instant, it is lossless, and it
// is the right answer to a very large share of everything anybody asks a video
// tool for.
//
// This application does it, does it properly, and follows the clip on the
// timeline so re-trimming moves the cut. What it does not do is offer it: the
// control is on the *last* stage, below the stream list, under a heading named
// after the mechanism (`Copy it instead`) rather than the goal, and nothing on
// the ordinary path — UC01 — mentions that it exists.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc03_lossless_cut.js -- <file>

import { journey, pump, press, type, f, q, qq, exportAndWait, wrote,
         describe, secondsOf, freshWorkspace } from './journey.js';

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... uc03_lossless_cut.js -- <file>');

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc03-cut.mkv';

const J = journey({
    id: 'UC03',
    title: 'Cut an excerpt out without re-encoding it',
    who: 'somebody who wants a piece of a long recording at the quality it ' +
         'already has',
    wants: 'the same bitstream, cut, in seconds rather than minutes',
    shell: A.shell,
});

// Start where a new person starts — see `freshWorkspace`. Without it a journey
// inherits the container and stream list the previous one left in the workspace.
freshWorkspace(A);

J.step('drop the recording on the window', () => {
    dropFiles(400, 300, [media]);
    pump(1500);
});

// Ripple, not plain trim — see UC01. Done correctly here so that this journey
// measures the copy path rather than re-finding UC01's gap.
J.step('ripple-trim the clip down to the excerpt', () => {
    const clip = A.project.clips[0];
    A.rippleTrim(clip, 'start', 2.0);
    pump(200);
    A.trimClip(A.project.clips[0], 'end', 6.0);
    pump(200);
});

J.step('go to Write', () => {
    A.shell.goTo('write');
    pump(400);
});

// **Here is the whole of the finding.** Everything above this point is what
// anybody would do. What follows is only reachable by somebody who already knows
// that a stream copy is a thing, because nothing above says so.
J.step('scroll past the stream list and find "Copy it instead"', {
    needs: ['streamCopy'],
    hidden: 'below the stream list on the last stage, named after the mechanism',
    friction: 'the fastest and highest-quality answer to this job is the fourth ' +
              'thing down the third column of the last stage. Somebody who does ' +
              'not know the phrase "stream copy" has no reason to look at it.',
}, () => {
    // Found by the buttons in it rather than by the heading: the section's
    // heading carries no handle of its own — only its ⓘ does (`data-why`) — so
    // there is nothing on this stage that names the section itself.
    assert(qq('[data-rewrap]').length > 0, 'there is no "Copy it instead" section');
});

J.step('press "Cut <file>"', {
    needs: ['streamCopy', 'keyframe'],
    friction: 'there are two buttons — Rewrap and Cut — and the difference ' +
              '(one takes the whole file, one takes the trim) is in a tooltip.',
}, () => {
    const cut = qq('[data-cut]')[0];
    assert(cut, 'there is no Cut button — the clip may not be trimmed');
    cut.click();
    pump(400);
});

// A copy cannot go into just any container: the codecs in the file decide. The
// fixture is h264+aac, which mp4 takes, but Matroska is the honest default for a
// copy of anything and the app does *not* change the container for you — it says
// so in the warnings if the muxer will not hold what is being copied.
J.step('change the container to one that will hold it', {
    needs: ['muxer', 'codec'],
    hidden: 'behind the Change button, then a search over 180 muxers',
}, () => {
    press('[data-f="container-open"]', 'the Change button');
    type(f('fmtsearch'), 'matroska', 'the muxer search');
    const row = q('[data-muxer="matroska"]');
    assert(row, 'matroska is not in the picker');
    row.click();
    pump(300);
});

J.step('name the file and Export', () => {
    type(f('path'), OUT, 'the path field');
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
const copied = !!out && out.streams.some((s) => s.codec === 'h264');

J.got('a cut file carrying the original bitstream', copied, describe(out));

// The keyframe rule is real and correct, and it is stated *after* the choice.
J.shortfall('a cut at exactly the moment asked for',
            'a copied stream can only begin at a keyframe, so the cut lands at ' +
            'the nearest one before the in point. That is right and unavoidable, ' +
            'and it is said in the opened row after the press rather than beside ' +
            `the button that takes it — the file is ${secondsOf(out).toFixed(2)} s.`);
J.shortfall('any of this from the ordinary path',
            'UC01 is the same person one decision earlier, and nothing on that ' +
            'path — not the timeline, not Encode, not the read-back — says that ' +
            'a cut without re-encoding is possible at all.');

J.finish();
