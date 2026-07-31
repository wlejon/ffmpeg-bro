// UC02 — "This is 2 GB and the chat window will not take it. Make it small
// enough to send."
//
// The most common thing anybody asks a video tool for after "trim it", and the
// one this application is least shaped to answer, because the question is a
// **file size** and every control here is a quality. There is a `Small file`
// preset, a CRF slider labelled with words, and a bitrate mode — and none of the
// three takes a number in megabytes, which is the only number the person has.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc02_small_enough_to_send.js -- <file>

import { journey, pump, press, type, f, q, qq, exportAndWait, wrote,
         describe, freshWorkspace,
         openDocument } from './journey.js';

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc02-small.mp4';
const BUDGET_KB = 120;   // "it has to fit in the upload limit"

const J = journey({
    id: 'UC02',
    title: 'Make it small enough to send',
    who: 'somebody with a recording too big for the upload limit they have been given',
    wants: 'the same video, under a size they were told, without thinking about codecs',
    shell: A.shell,
});

// Start where a new person starts — see `freshWorkspace`. Without it a journey
// inherits the container and stream list the previous one left in the workspace.
freshWorkspace(A);

J.step('open the recording', () => {
    openDocument(A, 'untouched');
});

J.step('go to Encode, because that is where "quality" sounds like it lives', () => {
    A.shell.goTo('encode');
    pump(400);
});

// The presets are the one thing on this stage aimed at somebody who does not
// want to choose an encoder. `Small file` is the right press and it is right
// there — this is the app at its best.
J.step('press the "Small file" starting point', () => {
    const presets = A.exporter.intents().map((i) => i.label);
    const small = qq('#ex-intent-list button').find((b) => /small/i.test(b.textContent));
    assert(small, `no "small file" preset among: ${presets.join(', ')}`);
    small.click();
    pump(300);
});

// ...and then it stops helping. What the preset set is a CRF, which is a
// quality, and no arithmetic anybody can do in their head turns it into
// megabytes. The stage's own answer to "how big" is to *render a sample* — a
// measurement, which is honest and costs a render nobody asked for.
J.step('look for the file size', {
    needs: ['crf', 'rateControl'],
    friction: 'the quality readout says "34 · small file". There is no megabyte ' +
              'anywhere on the stage, and no field that takes one.',
}, () => {
    const s = A.exporter.currentSettings();
    assert(s.rate, 'no rate control mode is set');
});

J.step('go to Write and name the file', () => {
    A.shell.goTo('write');
    pump(400);
    type(f('path'), OUT, 'the path field');
});

// The read-back is the last thing before the button and it is where a size would
// go. It carries one only when the render is bitrate-driven or when a preview
// has been measured — neither of which is true after pressing a preset.
const saidSize = /≈/.test(q('#ex-summary').textContent);

J.step('press Export and find out', () => {
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
const kb = Math.round(((out && out.format.size) || 0) / 1024);

J.got('a smaller file than the original', !!out && kb > 0, describe(out));

if (!saidSize)
    J.shortfall('any estimate of the size before pressing Export',
                'the read-back carries one only for a bitrate-driven render or ' +
                'after a preview has been measured. A constant-quality render — ' +
                'the default, and what every preset sets — says nothing, so the ' +
                'answer to the only question being asked arrives with the file.');

J.shortfall(`a way to say "under ${BUDGET_KB} kB"`,
            'no control on either stage takes a size. The nearest thing is ' +
            'Bitrate mode, which takes kbps — so the person has to know that ' +
            'size = bitrate × duration ÷ 8, do it themselves, and get the ' +
            'audio track right too. ffmpeg cannot answer this either; the ' +
            'difference is that a tool with a timeline knows the duration and ' +
            'could.');

J.friction(`what came out was ${kb} kB. Whether that is under the limit was ` +
           'discovered by looking at the file.');

J.finish();
