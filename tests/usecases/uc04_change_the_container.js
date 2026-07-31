// UC04 — "My TV will not play .mkv. Make it an .mp4."
//
// Nothing about the video needs to change. The same streams go into a different
// wrapper, which takes about a second and loses nothing. The whole job is one
// sentence and the application can do it exactly — but the sentence has to be
// translated into two separate presses that live in different places and do not
// refer to each other: `Rewrap` (make every stream a copy) and `Change` (pick
// the muxer). Do the first without the second and you have rewrapped into the
// container you already had.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc04_change_the_container.js -- <file>

import { journey, pump, press, type, f, q, qq, exportAndWait, wrote,
         describe, freshWorkspace,
         openDocument } from './journey.js';

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc04-rewrapped.mkv';

const J = journey({
    id: 'UC04',
    title: 'Change the container without touching the video',
    who: 'somebody whose player will not open the file they have',
    wants: 'the same video in a different wrapper, quickly and with nothing lost',
    shell: A.shell,
});

// Start where a new person starts — see `freshWorkspace`. Without it a journey
// inherits the container and stream list the previous one left in the workspace.
freshWorkspace(A);

J.step('open the recording', () => {
    openDocument(A, 'untouched');
});

J.step('go to Write', {
    friction: 'the four stages between here and there — Sources, Compose, ' +
              'Graph, Encode — are all about changing the video, which is the ' +
              'one thing this job must not do.',
}, () => {
    A.shell.goTo('write');
    pump(400);
});

J.step('press "Rewrap <file>"', {
    needs: ['streamCopy'],
    hidden: 'below the stream list, under "Copy it instead"',
}, () => {
    const rewrap = qq('[data-rewrap]')[0];
    assert(rewrap, 'there is no Rewrap button');
    rewrap.click();
    pump(400);
});

// **And now the container is still the one it was.** `Rewrap` makes the streams
// copies; it deliberately does not choose a muxer, because that is "the whole of
// the remaining decision". Which is true, and means the button named after the
// job does half of it.
const containerAfterRewrap = A.exporter.currentSettings().container;

J.step('notice the container did not change, and go and change it', {
    needs: ['muxer'],
    hidden: 'behind Change, then a search over 180 muxers by libavformat name',
    friction: `pressing "Rewrap" left the container at ${containerAfterRewrap}. ` +
              'The button is named after the job and does half of it; the other ' +
              'half is a separate control in the band above, and nothing links ' +
              'the two.',
}, () => {
    press('[data-f="container-open"]', 'the Change button');
    type(f('fmtsearch'), 'mkv', 'the muxer search');
    const row = q('[data-muxer="matroska"]');
    assert(row, 'searching "mkv" did not find matroska');
    row.click();
    pump(300);
});

J.step('name the file and Export', () => {
    type(f('path'), OUT, 'the path field');
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
const sameCodec = !!out && out.streams.some((s) => s.codec === 'h264');

J.got('the same streams in a Matroska file', sameCodec, describe(out));

// Credit where it is due: searching "mkv" finds matroska even though nothing in
// libavformat is called mkv. That is the picker doing exactly the right thing.
J.friction('searching "mkv" does find Matroska, which is the picker being ' +
           'better than libavformat — nothing in it is called mkv.');

J.shortfall('one action for one job',
            '"put this in an mp4" is one intention and takes two unrelated ' +
            'presses in two places, in an order that is not stated. Doing only ' +
            'the first produces a file identical to the input, successfully, ' +
            'with nothing saying that nothing happened.');

J.finish();
