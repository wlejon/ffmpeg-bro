// UC01 — "I recorded my screen, the first bit is me getting set up, I want to
// post the rest."
//
// The most common video job there is, and the one to measure everything else
// against: nothing composited, nothing filtered, no setting chosen. The person
// wants the same recording with a piece taken off the front.
//
// **It opens a document, and the document is the finding.** `trimmed-with-a-gap`
// is what the plain drag on a clip's left edge leaves behind, saved as a `.fbro`
// and reopened here exactly as `File ▸ Open` would. Rendering it produces a file
// the *original length* with black on the front, because trimming a head moves
// the clip's start forward and leaves a gap at zero that the render range still
// covers. The defect survives being saved and reopened, which is the strongest
// form of it: it is in the edit, not in a transient state of the screen.
//
// `trimmed-rippled` is the same cut made with the gesture that closes the gap.
// Both are rendered here, so the difference is a measurement rather than a claim.
//
// The footage is a recording of ffmpeg-bro being operated — see
// `make_screencast.js`.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc01_trim_and_post.js

import { journey, pump, type, f, exportAndWait, wrote, kindsOf, secondsOf,
         describe, freshWorkspace, openDocument } from './journey.js';

const A = globalThis.__ffmpegBro;
const GAPPED = 'out/uc01-trimmed-with-a-gap.mp4';
const RIPPLED = 'out/uc01-trimmed-rippled.mp4';

const J = journey({
    id: 'UC01',
    title: 'Trim the dead air off a recording and post it',
    who: 'somebody who screen-recorded a demo and spent the first seconds ' +
         'getting settled',
    wants: 'the same recording with the front taken off, as a file they can upload',
    shell: A.shell,
});

freshWorkspace(A);

let trimmedLength = 0;
let contentStart = 0;

J.step('open the edit they saved after trimming the front off', {
    friction: 'the document opens with a gap at the start of the timeline. It ' +
              'is drawn — there is visibly nothing under the playhead at zero — ' +
              'and nothing anywhere says it will be rendered.',
}, () => {
    openDocument(A, 'trimmed-with-a-gap');
    const clip = A.project.clips[0];
    contentStart = clip.start;
    trimmedLength = A.duration();
    assert(clip.inPoint > 0, 'the document is not trimmed');
    assert(clip.start > 0, 'the document has no gap in it, so this is the wrong one');
});

// The person's next thought is "save it". The next stage along the spine is
// Encode, which is a question about the picture they have not asked.
J.step('go looking for how to save it', {
    friction: 'the next thought after trimming is "save it", and the next stage ' +
              'along the spine is Encode — a question about the picture nobody ' +
              'asked. Write is one further on.',
}, () => {
    A.shell.goTo('write');
    pump(400);
});

J.step('type where it goes', () => {
    type(f('path'), GAPPED, 'the path field');
});

J.step('press Export', () => {
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const gapped = wrote(GAPPED);

J.got('an mp4 with the picture and the sound in it',
      !!gapped && kindsOf(gapped).indexOf('video') >= 0 &&
      kindsOf(gapped).indexOf('audio') >= 0,
      describe(gapped));

// ── and the same cut, made the other way ───────────────────────────────────
//
// Rendered here rather than described, so the difference between the two
// gestures is a pair of durations rather than an assertion about the model.

J.step('open the same cut made with the gesture that closes the gap', {
    friction: 'the two gestures are a drag and an Alt-drag on the same edge of ' +
              'the same clip. Only one of them means "cut the front off".',
}, () => {
    openDocument(A, 'trimmed-rippled');
    A.shell.goTo('write');
    pump(400);
    type(f('path'), RIPPLED, 'the path field');
});

J.step('Export that one too', () => {
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const rippled = wrote(RIPPLED);
const gappedSeconds = secondsOf(gapped);
const rippledSeconds = secondsOf(rippled);

J.got('the rippled cut is genuinely shorter than the gapped one',
      rippledSeconds > 0 && gappedSeconds > rippledSeconds + 0.2,
      `gapped ${gappedSeconds.toFixed(2)} s vs rippled ${rippledSeconds.toFixed(2)} s`);

if (gappedSeconds > rippledSeconds + 0.2)
    J.shortfall(
        `a file that starts where they cut — it is ${gappedSeconds.toFixed(2)} s ` +
        `against the ${rippledSeconds.toFixed(2)} s they meant, the extra ` +
        `${contentStart.toFixed(2)} s being black`,
        'trimming a clip\'s head moves its start forward and leaves a gap at 0. ' +
        'The render range is still the whole timeline, so the gap is rendered. ' +
        'Nothing between the drag and the button says the file will begin with ' +
        'black — not the monitor, not the range strip, and not "what will be ' +
        `written", which states ${trimmedLength.toFixed(2)} s and presents it ` +
        'as correct. It is describing the render faithfully; the render is not ' +
        'what was asked for.');

J.shortfall('a file that took a second to make',
            'every frame was re-encoded to take the front off. The same cut at ' +
            'a keyframe would have been instant and lossless — UC03 — and ' +
            'nothing on this path mentions that it is possible.');
J.shortfall('any idea how big it would be',
            'no size is offered before the render for a constant-quality encode, ' +
            'which is the default. The number arrives when the file does.');

J.finish();
