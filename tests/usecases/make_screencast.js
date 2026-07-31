// The footage every use case is cut from: **a recording of ffmpeg-bro being
// operated, made by ffmpeg-bro.**
//
// Two reasons this is the right media rather than a synthetic fixture. It is
// honest — the use cases below demonstrate the application on video of the
// application, so the thing being edited is the thing doing the editing, and
// nothing here is a contrived pattern chosen because it was easy to generate.
// And it exercises the whole chain in one go: bro's own frame capture, the
// `image2` demuxer reading a numbered run, a two-track edit, and the renderer.
//
// **Nothing is checked in.** This writes into `build/screencast/`, on the same
// rule `tests/make_fixture.cpp` follows for `build/fixtures/` — test media is
// generated. The `.fbro` documents are generated here too, and for a reason
// beyond tidiness: a document records the *paths* of its inputs, so a document
// checked in would name a directory on the machine that made it.
//
// What it produces:
//
//   build/screencast/frames/shot_%04d.png    the recording, frame by frame
//   build/screencast/operating.mp4           those frames, plus a soundtrack
//   build/screencast/*.fbro                  a document per use case
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/make_screencast.js -- <sound-file>

import { pump, until } from './journey.js';

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const soundFile = args[0] || '';

const A = globalThis.__ffmpegBro;
const fs = require('fs');
// Normalised, because these paths are written into documents somebody may open
// and read. `bro.appDir` ends in a separator, so the obvious `${bro.appDir}/..`
// produces `…\ui\/../build`, which works everywhere and looks like a defect in
// the one place a document is meant to be legible.
const ROOT = fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/');
const DIR = `${ROOT}/build/screencast`;
const FRAMES = `${DIR}/frames`;
const FOOTAGE = `${DIR}/operating.mp4`;

// 25 fps, because that is what `openBatch` gives a numbered run and there is no
// reason to argue with it — a sequence has no frame rate of its own and this is
// the one the reading end assumes.
const FPS = 25;

for (const d of [`${ROOT}/build`, DIR, FRAMES]) {
    try { fs.mkdirSync(d); } catch (e) { /* already there */ }
}
// A previous run's frames would be read as part of this one: `image2` walks the
// numbering and stops at the first gap, so a longer old run leaves a tail.
for (const name of fs.readdirSync(FRAMES)) {
    if (/\.png$/.test(name)) fs.unlinkSync(`${FRAMES}/${name}`);
}

// ── the recording ──────────────────────────────────────────────────────────

let frame = 0;
/// One frame of the screencast, at the moment it is called.
function shoot() {
    frame++;
    screenshot(`${FRAMES}/shot_${String(frame).padStart(4, '0')}.png`);
    // A frame of wall clock between shots, so what is captured is the
    // application actually redrawing rather than the same buffer twice.
    pump(1000 / FPS);
}

/// A stretch of the recording spent on one stage, doing one thing.
///
/// The scenes are deliberately four *different stages*, because the footage has
/// to be worth cutting: a use case that trims "the first bit" off this recording
/// should visibly lose something, and four near-identical seconds of one panel
/// would make every journey below untestable by eye.
function scene(stage, frames, during) {
    A.shell.goTo(stage);
    pump(300);
    for (let i = 0; i < frames; i++) {
        if (during) during(i, frames);
        shoot();
    }
}

console.log('recording ffmpeg-bro being operated…');

// Something to be operating *on*. The bars fixture is the one input that is the
// same on every machine, and what it is does not matter — it is what the
// application is holding while it gets photographed.
dropFiles(400, 300, [args[1] || `${ROOT}/build/fixtures/landscape.mp4`]);
pump(1600);

// Scene one: the edit, with the playhead running. The clip, the monitor and the
// timeline all move together, so this is the part of the recording with the most
// happening in it.
scene('compose', 20, (i, n) => { A.setPlayhead((i / n) * 4); });

// Scene two: the graph. A completely different screen, which is the point.
scene('graph', 15);

// Scene three: the encoder settings, with the quality slider walked so the
// numbers on screen change from frame to frame.
scene('encode', 20, (i) => {
    const s = A.exporter.currentSettings();
    s.quality = 18 + (i % 12);
    A.exporter.redraw();
});

// Scene four: the Write stage, which is where the person pressing Export ends up
// and is the half of the application these use cases are mostly about.
scene('write', 20);

console.log(`  ${frame} frames at ${FPS} fps — ${(frame / FPS).toFixed(2)} s`);

// ── the frames become footage ──────────────────────────────────────────────

/// Everything off the timeline and out of the inputs, so what is assembled below
/// is the recording and nothing else. `removeSelection` takes the clips and
/// `removeInput` takes the `-i`s; leaving either behind would put the file that
/// was being photographed into the footage as well.
function clearAll() {
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    for (const input of A.inputs.inputs.slice()) A.inputs.removeInput(input);
    pump(200);
}

clearAll();

const paths = [];
for (let n = 1; n <= frame; n++)
    paths.push(`${FRAMES}/shot_${String(n).padStart(4, '0')}.png`);

// The most-used path into an image sequence, and the one a person takes: hand
// over the numbered files and let the application recognise the run. It comes
// back as a single `-f image2 -i shot_%04d.png`, which is what ffmpeg would have
// been told.
A.openBatch(paths);
pump(800);
assert(A.inputs.inputs.length === 1,
       `the frames should be one input, got ${A.inputs.inputs.length}`);
assert(A.inputs.kindOf(A.inputs.inputs[0]) === 'sequence',
       'the frames were not recognised as a sequence');
assert(A.project.clips.length === 1, 'the sequence did not become a clip');

const picture = A.project.clips[0];
const seconds = picture.length;
console.log(`  the recording is one input: ${A.inputs.inputs[0].path}`);

// **A soundtrack, so the audio use cases are about something.** A screencast
// with a voice-over is the ordinary shape of this kind of footage, and a
// picture-only fixture would make "export just the audio" untestable. Trimmed to
// the picture, because the timeline is as long as its longest clip and a
// soundtrack running past the end would render seconds of black.
if (soundFile) {
    A.open(soundFile);
    pump(1200);
    const sound = A.project.clips.find((c) => c !== picture);
    if (sound) {
        sound.start = 0;
        if (sound.length > seconds) A.trimClip(sound, 'end', seconds);
        A.changed('moved');
        pump(300);
        console.log(`  with a soundtrack from ${soundFile.split(/[\\/]/).pop()}`);
    }
}

const S = A.exporter.currentSettings();
S.container = 'mp4';
S.videoCodec = 'libx264';
S.audioCodec = soundFile ? 'aac' : '';
S.audio = !!soundFile;
S.rate = 'quality';
S.quality = 20;
S.width = 1280;
S.height = 720;
S.rangeIn = 0;
S.rangeOut = 0;
S.streams = A.exporter.defaultStreams();
S.path = FOOTAGE;
A.exporter.redraw();
pump(200);

A.shell.goTo('write');
pump(300);
console.log('rendering the footage…');
document.getElementById('ex-go').click();
until('the footage to render', () => bro.ffmpeg.render.poll().state !== 'running', 180000);

const done = bro.ffmpeg.render.poll();
assert(done.state === 'done', `the footage ${done.state}: ${done.error || ''}`);

const probe = bro.ffmpeg.probe(FOOTAGE);
console.log(`  ${FOOTAGE}`);
console.log(`  ${probe.streams.map((s) => `${s.kind}/${s.codec}`).join(' + ')} · ` +
            `${probe.format.duration.toFixed(2)} s · ` +
            `${Math.round(probe.format.size / 1024)} kB`);

// ── the documents ──────────────────────────────────────────────────────────
//
// One `.fbro` per use case: the edit that use case starts from, saved as the
// application's own file. `snapshot()` is the whole edit as one object and a
// `.fbro` is that object stringified, so these are ordinary documents — openable
// from the File menu, undoable, and exactly what the journey scripts load.

/// Start from nothing but the footage, laid out on the timeline.
function justTheFootage() {
    clearAll();
    A.open(FOOTAGE);
    pump(1500);
    assert(A.project.clips.length === 1,
           `the footage should be one clip, got ${A.project.clips.length}`);
    return A.project.clips[0];
}

/// Write the document, and say what it holds.
///
/// Not called `document`: a function declaration by that name is hoisted over
/// the global `document` for the whole module, and the next thing this file does
/// is `document.getElementById('ex-go')`.
function saveDocument(name, note) {
    const path = `${DIR}/${name}.fbro`;
    A.doc.save(path);
    console.log(`  ${name}.fbro — ${note}`);
    return path;
}

console.log('writing the documents…');

// The plain one: the recording on the timeline, nothing done to it. Six of the
// journeys start here, because six of these jobs are about the *output* and not
// about the edit.
justTheFootage();
saveDocument('untouched', 'the recording on the timeline, nothing done to it');

// Trimmed the way somebody trims: the first stretch taken off. Saved with the
// gap left in, because that is what the gesture produces and UC01 is about what
// happens next.
{
    const clip = justTheFootage();
    A.trimClip(clip, 'start', clip.start + 0.8);
    pump(200);
    saveDocument('trimmed-with-a-gap',
             'the head trimmed and the gap left at zero, as the plain drag leaves it');
}

// The same trim done with the gesture that closes the gap, so a journey can put
// the two side by side and render both.
{
    const clip = justTheFootage();
    A.rippleTrim(clip, 'start', 0.8);
    pump(200);
    saveDocument('trimmed-rippled', 'the same trim, rippled, so the clip starts at zero');
}

// An excerpt, for the copy path: a span out of the middle with both ends moved.
{
    const clip = justTheFootage();
    A.rippleTrim(clip, 'start', 0.8);
    pump(200);
    A.trimClip(A.project.clips[0], 'end', 2.4);
    pump(200);
    saveDocument('an-excerpt', 'a span out of the middle, both ends moved');
}

// Three copies of the recording, stacked the way a multi-file drop leaves them:
// three tracks, all starting at zero, all playing at once. The document is what
// UC07 opens, because the finding there is about what a drop *produces* and a
// document is the honest way to hold that state still.
{
    clearAll();
    for (let i = 0; i < 3; i++) { A.open(FOOTAGE); pump(1200); }
    A.project.clips.forEach((c, i) => { c.track = i; c.start = 0; });
    A.changed('moved');
    pump(300);
    saveDocument('three-stacked',
                 'three copies on three tracks at zero, as a multi-file drop leaves them');
}

// The same three, laid end to end, so a journey can render what the person
// meant and compare the two.
{
    clearAll();
    for (let i = 0; i < 3; i++) { A.open(FOOTAGE); pump(1200); }
    let at = 0;
    let last = null;
    for (const c of A.project.clips.slice()) {
        c.track = 0; c.start = at; at += c.length; last = c;
    }
    if (last) A.resolveOverlaps(last);
    A.changed('moved');
    pump(300);
    saveDocument('three-in-a-row', 'the same three, end to end on one track');
}

// A watermark over the recording: the footage on V1 and a still scaled into a
// corner on V2, which is the Compose answer to a logo.
if (args[2]) {
    clearAll();
    A.open(FOOTAGE);
    pump(1200);
    const under = A.project.clips[0];
    A.open(args[2]);
    pump(1200);
    const mark = A.project.clips.find((c) => c !== under);
    if (mark) {
        mark.track = under.track + 1;
        mark.start = under.start;
        mark.length = under.length;
        const x = mark.xform || (mark.xform = {});
        x.scale = 0.2; x.x = 0.38; x.y = 0.38;
        A.changed('moved');
        pump(300);
        saveDocument('with-a-watermark',
                     'the recording on V1 and a still scaled into the corner on V2');
    }
}

console.log('done');
