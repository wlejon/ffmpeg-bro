// UC06 — "Give me just the audio out of this, as an mp3."
//
// A podcast out of a recorded call, a backing track out of a video, a transcript
// source. The job is one sentence with two halves — *drop the picture* and *make
// it an mp3* — and this application splits those halves across two stages and
// three unrelated controls, none of which is named after either half.
//
// It does have the right model underneath: a file is a list of streams, so
// "no video" is `×` on the video row rather than a checkbox called "audio only".
// That is a better answer than most tools have. The cost is that you have to
// know a file is a list of streams before the control means anything.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc06_just_the_audio.js -- <file>

import { journey, pump, press, type, f, q, qq, exportAndWait, wrote,
         kindsOf, describe, freshWorkspace,
         openDocument } from './journey.js';

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc06-audio.mp3';

const J = journey({
    id: 'UC06',
    title: 'Get just the audio out, as an mp3',
    who: 'somebody making a podcast episode out of a recorded call',
    wants: 'the soundtrack on its own, in a format anything will play',
    shell: A.shell,
});

// Start where a new person starts — see `freshWorkspace`. Without it a journey
// inherits the container and stream list the previous one left in the workspace.
freshWorkspace(A);

J.step('open the recording', () => {
    openDocument(A, 'untouched');
});

J.step('go to Write', () => {
    A.shell.goTo('write');
    pump(400);
});

// **The good half.** The stream list says what the file will contain, so taking
// the picture out is removing a row. Once you know that a file is a list of
// streams this is obvious and better than a checkbox; until you know it, the
// row reads as a description rather than as something you can delete.
J.step('take the video row out of the file with ×', {
    needs: ['streamList'],
    friction: 'the row is called "V1  the composite through libx264". Nothing ' +
              'says it can be removed; the × beside it looks like it closes ' +
              'something.',
}, () => {
    const rows = qq('#ex-streams .ex-stream');
    const video = rows.find((r) => r.getAttribute('data-kind') === 'video');
    assert(video, 'no video row to remove');
    const x = q('[data-f="drop"]', video);
    assert(x, 'the video row has no remove button');
    x.click();
    pump(400);
});

// The container is on the Write stage; the audio codec is on Encode. They are
// one decision to the person ("make it an mp3") and two controls two stages
// apart, and doing only one of them produces an .mp3 file containing AAC or an
// MP4 containing mp3, both of which succeed.
J.step('open the picker and search "mp3"', {
    needs: ['muxer'],
    hidden: 'behind the Change button',
}, () => {
    press('[data-f="container-open"]', 'the Change button');
    type(f('fmtsearch'), 'mp3', 'the muxer search');
    const row = q('[data-muxer="mp3"]');
    assert(row, 'searching "mp3" did not find the mp3 muxer');
    row.click();
    pump(400);
});

J.step('name the file and Export', () => {
    type(f('path'), OUT, 'the path field');
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
const audioOnly = !!out && kindsOf(out) === 'audio';

J.got('an mp3 with only the sound in it', audioOnly, describe(out));

// Credit: picking the mp3 muxer narrowed the codec list to what mp3 will hold,
// so the codec followed the container without anybody choosing it. That is the
// capability query doing real work, and it is why this journey is five steps
// rather than seven.
J.friction('choosing the mp3 muxer narrowed the audio codec to what mp3 holds, ' +
           'so the codec followed without a second decision. That is the ' +
           'container query earning its keep.');

J.shortfall('"export the audio" as one thing',
            'the job is one intention. It is a row deletion on one stage and a ' +
            'muxer search on the same stage, with the audio codec on another — ' +
            'and every combination of doing only some of them succeeds and ' +
            'writes a file that is not what was asked for.');

J.finish();
