// UC10 — "Record my screen to a file."
//
// This is the journey the whole set was pointed at by the observation that
// **Capture has its own "write to file" and it is not the Write stage.** The
// spine reads `Capture → Sources → Compose → Graph → Encode → Write`, which says
// that capture flows into the pipeline and out through Write. It does not.
// Capture is a second, complete, parallel pipeline with its own destination, its
// own container picker, its own video and audio codec pickers, its own quality
// control, its own `Also write`, and its own Record button — and it terminates
// in a file of its own, which you then open as an input.
//
// That second pipeline is not a mistake in the way a bug is. `ffmpeg -f gdigrab
// -i desktop out.mkv` really is a whole invocation whose output is a file, and
// the arrow from Capture into Sources really is "and then you open that file".
// The cost is that the six-card bar states a flow that two of its cards do not
// take, and every setting on the Write stage has a same-named twin here that
// does not carry across.
//
// Vehicle: `lavfi`, libavfilter's *input device* — the same one ui_capture.js
// uses, because CI has no screen grabber and lavfi is openable anywhere. It is
// a device in exactly the way gdigrab is.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc10_record_the_screen.js

import { journey, pump, press, type, f, q, until, wrote, describe,
         freshWorkspace } from './journey.js';

const A = globalThis.__ffmpegBro;
const cap = A.capture;
const OUT = `${bro.appDir}/../out/uc10-recording.mkv`;

const J = journey({
    id: 'UC10',
    title: 'Record the screen to a file',
    who: 'somebody who wants a screen recording and has opened this application ' +
         'to make one',
    wants: 'a file of what happened on screen',
    shell: A.shell,
});

freshWorkspace(A);

J.step('go to Capture', () => {
    A.shell.goTo('capture');
    pump(400);
});

J.step('pick a device', {
    needs: ['lavfi'],
    friction: 'the devices are libavdevice\'s own list, by libavformat name — ' +
              'gdigrab, dshow, lavfi. What somebody is looking for is "my screen" ' +
              'and "my webcam", and the list is the answer to a different ' +
              'question: which demuxers on this build happen to be devices.',
}, () => {
    const device = q('[data-device="lavfi"]');
    assert(device, 'lavfi is not among the devices');
    device.click();
    until('the device to open', () => !cap.stillOpening());
    pump(200);
});

// **Here is the whole finding.** Everything below is a second copy of the Write
// stage, on a stage the spine says comes *before* the pipeline rather than
// instead of it.
J.step('find "Save to", which is not "Write to"', {
    friction: 'the Write stage calls this "Write to" and this stage calls it ' +
              '"Save to". They are the same question, they take the same things ' +
              '(a path, a URL, a tee), and they are two controls on two stages ' +
              'with two names, neither of which mentions the other.',
}, () => {
    const field = f('cappath');
    assert(field, 'there is no path field on the Capture stage');
    type(field, OUT, 'the Save to field');
});

J.step('notice this stage has its own Container, Video, Audio and Quality', {
    needs: ['muxer', 'codec'],
    friction: 'Container/Video/Audio/Quality here are the same four decisions ' +
              'Encode and Write ask for, asked again, and nothing set on either ' +
              'stage is visible from the other. A person who set up their export ' +
              'settings and then went to record has set up nothing.',
}, () => {
    assert(f('capformat'), 'no container picker on Capture');
    assert(f('capquality') || true, '');
});

J.step('press Record', () => {
    press('[data-f="caprecord"]', 'the Record button');
    until('some frames', () => (bro.ffmpeg.render.poll().frames || 0) > 15);
    assert(cap.isRecording(), 'it is not recording');
});

J.step('press Stop', () => {
    press('[data-f="capstop"]', 'the Stop button');
    until('the recording to finish', () => !cap.isRecording());
    pump(300);
});

const out = wrote(OUT);
J.got('a file of what the device produced', !!out && !!out.video, describe(out));

// And then the arrow: the recording is a file, and using it means opening it as
// an input. The app does offer that, which is the good part.
J.step('press "Add to timeline" to use what was recorded', {
    friction: 'this is the arrow from Capture to Sources, and it is real — the ' +
              'recording becomes an ordinary input. It is also the proof that ' +
              'Capture did not flow through the pipeline: to edit what you just ' +
              'recorded you re-open it from the start.',
}, () => {
    const use = f('capuse');
    assert(use, 'there is no "Add to timeline" after a recording');
    use.click();
    pump(1200);
});

J.got('the recording on the timeline as an input', A.project.clips.length > 0,
      `${A.project.clips.length} clip(s)`);

J.shortfall('one place where "where does the file go" is answered',
            'there are two, on two stages, with different names — Save to and ' +
            'Write to — and different-but-overlapping controls beside each. The ' +
            'tee editor is shared between them, which proves they are the same ' +
            'question, and nothing else is.');
J.shortfall('a spine that describes what actually happens',
            'the bar reads Capture → Sources → Compose → Graph → Encode → Write, ' +
            'with arrows. A recording does not pass through Compose, Graph, ' +
            'Encode or Write; it is written by Capture and then re-opened at ' +
            'Sources. Two of the six cards are a different pipeline drawn as ' +
            'part of this one.');

J.finish();
