// UC12 — "Put my logo in the bottom corner."
//
// A watermark, a bug, a channel ident. In ffmpeg it is an `overlay` filter and
// nothing else. In this application there are **two** places it can be done and
// they produce different renders:
//
//   - **Compose** — the PNG is a clip on a track above the video, placed by the
//     same fit/scale/position the viewer draws. The compositor stacks it.
//   - **Graph** — an `overlay` node, which is what ffmpeg means and what the
//     printed command says.
//
// Both are right. Nothing says which one you want, and the two stages sit next
// to each other on the spine with no statement of what divides them. This
// journey takes the Compose route, because a still dropped on the window becomes
// a clip whether you meant it to or not.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc12_logo_in_the_corner.js
//            -- <video> <logo.png>

import { journey, pump, type, f, exportAndWait, wrote, describe,
         freshWorkspace } from './journey.js';

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
const logo = args[1];
assert(media && logo, 'pass a video and a png: ... uc12_logo_in_the_corner.js -- <v> <png>');

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc12-logo.mp4';

const J = journey({
    id: 'UC12',
    title: 'Put a logo in the corner',
    who: 'somebody who has to put their channel mark on everything they publish',
    wants: 'the logo small, in one corner, over the whole video',
    shell: A.shell,
});

freshWorkspace(A);

J.step('drop the video on the window', () => {
    dropFiles(400, 300, [media]);
    pump(1800);
    assert(A.project.clips.length === 1, 'the video did not become a clip');
});

// A still becomes a clip, on its own track, at the playhead, at whatever length
// a still gets. That is a reasonable thing for it to do and it is also the
// moment the person discovers their logo is a *shot* with a duration.
J.step('drop the logo on the window', {
    friction: 'the PNG becomes a clip with a length, on a track of its own. ' +
              'A watermark is not a shot — it is over everything for the whole ' +
              'programme — so the first thing that has to be done to it is to ' +
              'make it as long as the video, by hand.',
}, () => {
    dropFiles(400, 300, [logo]);
    pump(1800);
    assert(A.project.clips.length === 2,
           `expected two clips, got ${A.project.clips.length}`);
});

const video = A.project.clips[0];
const mark = A.project.clips.find((c) => c !== video);

J.step('stretch the logo clip to cover the whole video', {
    friction: 'there is no "for the whole programme". The logo is a clip and a ' +
              'clip has a length, so covering the video means dragging its end ' +
              'to the end — and doing it again every time the edit gets longer.',
}, () => {
    mark.track = Math.max(video.track + 1, mark.track);
    mark.start = video.start;
    mark.length = video.length;
    A.changed('moved');
    pump(400);
});

// And this part is genuinely good: the rectangle the renderer uses is the one
// the viewer computed, so putting it in the corner is putting it in the corner.
J.step('scale it down and move it into the corner', {
    friction: 'the placement is the viewer\'s own rectangle, so what is on the ' +
              'monitor is what gets written — there is no second layout to ' +
              'disagree with it. This is the part of the job the application is ' +
              'shaped for.',
}, () => {
    const x = mark.xform || (mark.xform = {});
    x.scale = 0.2;
    x.x = 0.38;
    x.y = 0.38;
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
J.got('one video with the logo composited over it',
      !!out && !!out.video, describe(out));

J.shortfall('a statement of what Compose is for and what Graph is for',
            'the same job can be done on either stage and they are different ' +
            'renders — the compositor stacks rectangles, the graph runs an ' +
            'overlay filter. Both are correct and the app never says which one ' +
            'a given intention belongs to. The spine puts them side by side with ' +
            'an arrow between them, which reads as "and then", not as "or".');
J.shortfall('a watermark that is not a clip',
            'the only way to put something over everything is a clip as long as ' +
            'everything, re-lengthened by hand whenever the edit changes. The ' +
            'graph route has no such problem and is the one an ffmpeg user would ' +
            'take — which is another way of saying the easy route is the one ' +
            'that does not scale.');

J.finish();
