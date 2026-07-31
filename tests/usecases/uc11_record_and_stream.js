// UC11 — "Record to a file and push the same thing to my streaming URL, at the
// same time."
//
// This is the case `-f tee` exists for and the application does it exactly
// right: one reading of the devices, one encode, one real-time deadline, the
// same packets into two muxers. Two encodes would be twice the CPU and two
// different bitstreams, and the app refuses to pretend otherwise.
//
// The finding is where the editor for it lives. `Several destinations (tee)` is
// the last entry of the Capture stage's **Container** menu — a menu otherwise
// full of file formats — so "how many places does this go" is answered by a
// control labelled "what kind of file is this". The rows it opens are literally
// the Write stage's rows (`destinationRows` in ui/export/destination.js, shared),
// which is the clearest possible evidence that the two stages are asking one
// question, and the only place in the application where that is acted on.
//
// Both destinations here are files. The real second one is an RTMP URL and the
// mechanism is identical — a tee slave is a muxer and a target — but a test that
// needed a streaming server would not run anywhere.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc11_record_and_stream.js

import { journey, pump, press, type, f, q, qq, until, wrote, describe,
         freshWorkspace } from './journey.js';

const A = globalThis.__ffmpegBro;
const cap = A.capture;
const KEEP = `${bro.appDir}/../out/uc11-kept.mkv`;
const SEND = `${bro.appDir}/../out/uc11-sent.mkv`;

const J = journey({
    id: 'UC11',
    title: 'Record and stream at the same time',
    who: 'somebody going live who also wants the file afterwards',
    wants: 'one recording that lands on disk and goes out to a URL at once',
    shell: A.shell,
});

freshWorkspace(A);

J.step('go to Capture and pick a device', {
    needs: ['lavfi'],
}, () => {
    A.shell.goTo('capture');
    pump(400);
    press('[data-device="lavfi"]', 'the lavfi device');
    until('the device to open', () => !cap.stillOpening());
    pump(200);
});

J.step('name the file to keep', () => {
    type(f('cappath'), KEEP, 'the Save to field');
});

// **The control that answers "how many places" is the one labelled "Container".**
J.step('look in the Container menu for a second destination', {
    needs: ['tee', 'muxer'],
    hidden: 'the last entry of a menu of file formats',
    friction: '"how many places does this go" is answered inside a menu called ' +
              'Container, under twenty entries that are all file formats. The ' +
              'entry is honest — several destinations (tee) — and it is filed ' +
              'under a different question.',
}, () => {
    const picker = f('capformat');
    assert(picker, 'there is no container picker on Capture');
    picker.value = 'tee';
    picker.dispatchEvent(new Event('change'));
    pump(400);
    assert(cap.capture.format === 'tee', 'the container did not become tee');
});

// Picking tee with a filename already typed makes that file the first
// destination, which is exactly right and is the app anticipating the move.
const firstKept = (cap.capture.destinations || [])[0];

J.step('add the second destination', {
    needs: ['tee'],
}, () => {
    const add = q('[data-f="capdest-add"]');
    assert(add, 'there is no way to add a destination');
    add.click();
    pump(300);
    const list = cap.capture.destinations || [];
    assert(list.length >= 2, `expected two destinations, got ${list.length}`);
    type(q('[data-f="capdest-path-1"]'), SEND, 'the second destination path');
    type(q('[data-f="capdest-format-1"]'), 'matroska', 'the second destination muxer');
});

J.step('record briefly, then stop', () => {
    press('[data-f="caprecord"]', 'the Record button');
    until('some frames', () => (bro.ffmpeg.render.poll().frames || 0) > 15);
    press('[data-f="capstop"]', 'the Stop button');
    until('the recording to finish', () => !cap.isRecording());
    pump(400);
});

const kept = wrote(KEEP);
const sent = wrote(SEND);

J.got('both destinations written from one recording',
      !!kept && !!sent && !!kept.video && !!sent.video,
      `kept ${describe(kept)} · sent ${describe(sent)}`);

J.friction('picking tee with a filename already typed turned that filename into ' +
           'the first destination rather than throwing it away. That is the app ' +
           'anticipating the move correctly, and it is the sort of thing the ' +
           'rest of this journey does not do.');

if (firstKept)
    J.friction('the built -f tee argument is shown in full under the list, ' +
               'which is right — it is a small language with two layers of ' +
               'escaping and it was assembled on the person\'s behalf.');

J.shortfall('"also send this somewhere" as a thing you can ask for',
            'the question is "how many places does this go", and it is answered ' +
            'inside a control called Container. There is no destination *list* ' +
            'until you have changed what kind of file you are writing, which is ' +
            'a different decision that happens to be where the mechanism lives.');
J.shortfall('one destination editor, named once',
            'these rows are the Write stage\'s rows — the same function, shared ' +
            'deliberately so the escaping has one home. Everything around them ' +
            'is duplicated: Save to versus Write to, Container versus Format, ' +
            'this stage\'s Also write versus that stage\'s. The one thing the ' +
            'two stages share is the proof that they should share more.');

J.finish();
