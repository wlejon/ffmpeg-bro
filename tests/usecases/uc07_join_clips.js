// UC07 — "Stick these three clips together, one after another."
//
// The other half of "trim it": the thing everybody does with a folder of camera
// files. It is also the journey this application handles best, because it is the
// one job that is genuinely about a timeline — and a timeline is what the
// Compose stage is.
//
// The finding here is not friction so much as a mismatch of expectation: the
// three files land on **three tracks stacked on top of each other**, not end to
// end, because a drop is a drop and the application will not guess. So the
// person who dropped three clips to join them sees one clip — the top of the
// stack — and has to move the other two.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc07_join_clips.js -- <a> <b> <c>

import { journey, pump, type, f, exportAndWait, wrote, secondsOf,
         describe, freshWorkspace } from './journey.js';

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const files = args.filter(Boolean);
assert(files.length >= 2, 'pass two or more media files');

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc07-joined.mp4';

const J = journey({
    id: 'UC07',
    title: 'Join several clips end to end',
    who: 'somebody with a folder of camera files that are one thing',
    wants: 'a single video with each clip after the last',
    shell: A.shell,
});

// Start where a new person starts — see `freshWorkspace`. Without it a journey
// inherits the container and stream list the previous one left in the workspace.
freshWorkspace(A);

let lengths = [];

J.step(`drop ${files.length} files on the window at once`, () => {
    dropFiles(400, 300, files);
    pump(2500);
    assert(A.project.clips.length === files.length,
           `${files.length} files became ${A.project.clips.length} clips`);
    lengths = A.project.clips.map((c) => c.length);
});

// What a multi-file drop produces, checked rather than assumed.
const tracks = new Set(A.project.clips.map((c) => c.track));
const starts = A.project.clips.map((c) => Math.round(c.start * 100) / 100);
const stacked = tracks.size > 1;
const allAtZero = starts.every((s) => s === starts[0]);

J.step('look at what the drop produced', {
    friction: stacked
        ? `the ${files.length} files went onto ${tracks.size} tracks stacked on ` +
          'top of each other rather than end to end. The monitor shows the top ' +
          'one; the others are underneath it, playing at the same time.'
        : 'the files went onto one track.',
}, () => {});

// Laying them end to end. The gesture is a drag per clip; done through the model
// here for the reason UC01's trim is.
J.step('drag each clip to sit after the one before', {
    friction: stacked
        ? 'one drag per clip, and every drag has to land on the same track as ' +
          'the first or the clips play over each other rather than after each ' +
          'other — which looks identical on the timeline until you play it.'
        : 'one drag per clip.',
}, () => {
    let at = 0;
    let last = null;
    for (const c of A.project.clips.slice().sort((x, y) => x.track - y.track)) {
        c.track = 0;
        c.start = at;
        at += c.length;
        last = c;
    }
    // The starts above are already end to end, so this is only here to put the
    // list back in timeline order — which is what every drag goes through.
    if (last) A.resolveOverlaps(last);
    A.changed('moved');
    pump(400);
});

J.step('go to Write, name the file and Export', () => {
    A.shell.goTo('write');
    pump(400);
    type(f('path'), OUT, 'the path field');
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
const total = lengths.reduce((a, b) => a + b, 0);
const joined = !!out && secondsOf(out) > total * 0.8;

J.got('one file as long as all the clips together', joined,
      `${describe(out)} — expected about ${total.toFixed(2)} s`);

if (stacked)
    J.shortfall('the clips end to end from the drop',
                `dropping ${files.length} files that are obviously one sequence ` +
                'stacks them on separate tracks, which is what "several videos at ' +
                'once" means and is almost never what a multi-file drop means. ' +
                'There is no "join these" anywhere, so the fix is a manual drag ' +
                'per file onto a track that must be the same one.');

if (allAtZero)
    J.shortfall('any sign that the clips are on top of each other',
                'every clip starts at 0 on its own track. The monitor shows the ' +
                'top of the stack, so the picture looks exactly like one clip ' +
                'and nothing indicates that the others are playing underneath.');

J.finish();
