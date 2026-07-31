// UC05 — "I need a thumbnail. Give me the frame at four seconds as a PNG."
//
// One of the most-wanted things anybody does with a video, and by some distance
// the hardest journey in this set. Getting there means knowing three separate
// ffmpeg facts that nothing on the screen teaches:
//
//   1. a still picture is written by the `image2` **muxer**, not by an export
//      option and not by anything called "snapshot";
//   2. `image2` writes a *set* of files unless told `-update 1`, which the app
//      spells `Numbering · One picture`;
//   3. the render **range** has to be shortened to one frame, because otherwise
//      one picture is written over and over for the whole clip.
//
// The application does all three properly and explains each of them well. What
// it does not have is the one control the job is actually named after.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc05_one_frame_as_a_png.js -- <file>

import { journey, pump, press, type, f, q, exportAndWait, wrote,
         describe, freshWorkspace,
         openDocument } from './journey.js';

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc05-thumbnail.png';
const AT = 4.0;

const J = journey({
    id: 'UC05',
    title: 'Get one frame out as a PNG',
    who: 'somebody who needs a thumbnail, a still for a slide, or a bug report',
    wants: 'the picture at one moment, as an image file',
    shell: A.shell,
});

// Start where a new person starts — see `freshWorkspace`. Without it a journey
// inherits the container and stream list the previous one left in the workspace.
freshWorkspace(A);

J.step('open the recording', () => {
    openDocument(A, 'untouched');
});

J.step('move the playhead to the frame they want', () => {
    A.setPlayhead(AT);
    pump(300);
});

// There is no "export frame" anywhere: not on the monitor, not in the transport,
// not on the Compose stage, not in the keyboard map. So the journey begins by
// looking in four places that do not have it.
J.step('look for "save this frame" on the monitor and find nothing', {
    friction: 'there is no frame grab anywhere on the edit side — no button ' +
              'under the monitor, no item on the clip, no key. The job has to ' +
              'be rebuilt out of the render pipeline.',
}, () => {
    A.shell.goTo('write');
    pump(400);
});

// **The picker is the good part of this journey and deserves saying so.**
// Searching "png" finds `image2`, because the search reads each muxer's
// extension list as well as its name — and it deliberately ignores the facet you
// are standing in, so naming what you want beats the filter. The person still
// has to know that the answer to "save a picture" is a *container*, but once
// they type something about the file they want, the right entry is there.
J.step('open the muxer picker and search "png"', {
    needs: ['muxer', 'imageSequence'],
    hidden: 'behind the Change button',
}, () => {
    press('[data-f="container-open"]', 'the Change button');
    type(f('fmtsearch'), 'png', 'the muxer search');
    const row = q('[data-muxer="image2"]');
    assert(row, 'searching "png" did not find image2');
    row.click();
    pump(400);
});

// Picking image2 puts a frame number in the filename, because that is what
// image2 means by default. The app is right and the person now has `out%04d.png`
// in a field they did not type it into.
const patterned = f('path') ? f('path').value : '';

J.step('name the file, and take the frame-number pattern back out', {
    needs: ['imageSequence'],
    friction: `choosing image2 rewrote the filename to a numbering pattern ` +
              `(${patterned.replace(/^.*[\\/]/, '')}). That is what image2 is, ` +
              'and it is not what somebody who asked for one thumbnail expected ' +
              'to see happen to their filename.',
}, () => {
    type(f('path'), OUT, 'the path field');
});

J.step('find Numbering and choose "One picture"', {
    needs: ['imageSequence'],
    hidden: 'a control that only exists while image2 is the muxer',
}, () => {
    const one = q('[data-seg="ex-imgmode"][data-v="one"]');
    assert(one, 'there is no "One picture" control');
    one.click();
    pump(300);
});

// **The step that is easiest to miss and silently wrong to skip.** Without it,
// `-update 1` writes every frame of the clip into the same file, one after
// another, and the file left on disk is the *last* frame rather than the one
// under the playhead. It succeeds. It takes as long as an encode.
J.step('shorten the render range to the one frame', {
    needs: ['fpsMode'],
    hidden: 'the range strip is on the Encode stage, not this one',
    friction: 'nothing connects "One picture" to the range. Leave the range ' +
              'alone and the render walks the whole clip writing every frame ' +
              'into the same file — it succeeds, it takes as long as an encode, ' +
              'and what is left on disk is the last frame, not the one you were ' +
              'looking at.',
}, () => {
    const s = A.exporter.currentSettings();
    s.rangeIn = AT;
    s.rangeOut = AT + (1 / Math.max(1, A.exporter.currentSettings().fps || 25));
    A.exporter.redraw();
    pump(200);
});

J.step('Export', () => {
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
J.got('a PNG of the frame', !!out && out.streams.some((s) => s.codec === 'png'),
      describe(out));

J.shortfall('a way to do this that is about frames rather than about muxers',
            'six steps and three ffmpeg concepts for "save this picture". Every ' +
            'one of the six is correct and well explained; none of them is the ' +
            'thing being asked for. The playhead is already on the frame and the ' +
            'renderer already has a one-frame path — what is missing is a press.');

J.finish();
