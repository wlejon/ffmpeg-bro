// Drive the real UI the way a person does: drop files on it, press play,
// scrub, step, zoom the timeline, move and trim and split clips, stack them on
// tracks, crop the picture, drop a batch as a grid — and check what the app
// says afterwards.
//
// Video runs on the REAL clock — advanceTime() moves bro's virtual time and
// the decoder ignores it — so every wait here is wallSleep() plus a flush to
// pump media events and present a frame.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_player.js -- <media-file> [<second-file>]

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
const second = args[1];
assert(media, 'pass a media file: ... tests/ui_player.js -- <file> [<file2>]');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const el = (id) => document.getElementById(id);

/// A key press, the way the app hears one. Dispatched on <body> rather than on
/// `document` — which is where app.js listens — because this engine implements
/// Document.addEventListener but not Document.dispatchEvent. It bubbles, so it
/// arrives; a real key press takes the same route.
const key = (k, opts) =>
    document.body.dispatchEvent(
        new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opts)));
let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

// ── the host bindings are really there ─────────────────────────────────────

console.log('\nbindings');
ok(!!globalThis.bro && !!bro.ffmpeg, 'bro.ffmpeg exists');
ok(bro.ffmpeg.available && bro.ffmpeg.linked, 'reports linked + available');
ok(typeof bro.ffmpeg.version === 'string' && bro.ffmpeg.version.length > 0,
   `version: ${bro.ffmpeg.version}`);
ok(Array.isArray(bro.ffmpeg.hwaccels), `hwaccels: ${bro.ffmpeg.hwaccels.join(' ') || 'none'}`);

console.log('\nprobe');
const p = bro.ffmpeg.probe(media);
ok(p.format.duration > 0, `duration ${p.format.duration.toFixed(3)}s`);
ok(p.streams.length > 0, `${p.streams.length} streams`);
ok(!!p.video, p.video ? `video ${p.video.codec} ${p.video.width}x${p.video.height} ` +
                        `${p.video.fps.toFixed(3)}fps ${p.video.pixFmt}` : 'no video stream');
// A stream's own duration, which is what a clip's length comes from. It is
// routinely shorter than the container's — the recording stops the audio after
// the last picture — and using the container's leaves the playhead running
// past the end of the video.
ok(p.video.duration > 0 && p.video.duration <= p.format.duration + 0.01,
   `video track duration ${p.video.duration.toFixed(3)}s ` +
   `(container ${p.format.duration.toFixed(3)}s)`);
if (p.audio) console.log(`        audio ${p.audio.codec} ${p.audio.channels}ch ${p.audio.sampleRate}Hz`);

let threw = false;
try { bro.ffmpeg.probe(bro.appDir + '/index.html'); } catch (e) { threw = true; }
ok(threw, 'probe throws on a file that is not media');

// ── the app boots ──────────────────────────────────────────────────────────

console.log('\nui');
waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
ok(!!A && !!A.project, 'the app exposes its model');
ok(el('dropzone').className.indexOf('hidden') < 0, 'dropzone visible before a file');

// Filters and locks are remembered in localStorage, which outlives a process —
// so a suite that inserted one and then died would leave the next run of this
// one rendering through libavfilter for reasons nothing on screen explains.
A.graph.overlay.clear();

// ── dropping a file loads it ───────────────────────────────────────────────

dropFiles(400, 300, [media]);
waitFor('the file to load', () => A.project.clips.length > 0);
const clip = A.project.clips[0];
waitFor('a decoded frame', () => A.video() && A.video().videoWidth > 0);
const video = A.video();

ok(el('dropzone').className.indexOf('hidden') >= 0, 'dropzone hidden after drop');
ok(video.videoWidth > 0 && video.videoHeight > 0,
   `frame size ${video.videoWidth}x${video.videoHeight}`);
ok(Math.abs(clip.length - p.video.duration) < 0.01,
   `clip is as long as its video track (${clip.length.toFixed(3)}s)`);
ok(el('sources').textContent.indexOf('Container') >= 0, 'the Sources stage read the file');
ok(el('chips').textContent.length > 0, `chips: ${el('chips').textContent.replace(/\s+/g, ' ').trim()}`);
ok(el('tc-duration').textContent !== '00:00:00:00',
   `duration timecode ${el('tc-duration').textContent}`);

screenshot('out/01-loaded.png');

// ── playback actually advances ─────────────────────────────────────────────

console.log('\nplayback');
A.transport.muted = true;         // no audio device in headless
const before = A.transport.t;
A.play();
pump(700);
const after = A.transport.t;
ok(after > before, `playhead advanced ${before.toFixed(3)} → ${after.toFixed(3)}`);
ok(A.transport.playing, 'transport reports playing');
ok(el('scrub-played').style.width !== '0%', `scrubber moved (${el('scrub-played').style.width})`);
ok(el('tc-current').textContent !== '00:00:00:00',
   `timecode running: ${el('tc-current').textContent}`);

screenshot('out/02-playing.png');

A.pause();
pump(60);
const paused = A.transport.t;
pump(300);
ok(Math.abs(A.transport.t - paused) < 0.02, 'paused clock holds still');

// ── seeking lands where asked ──────────────────────────────────────────────

console.log('\nseek');
const target = clip.length * 0.6;
A.setPlayhead(target);
pump(120);
ok(Math.abs(A.transport.t - target) < 1.0,
   `seek to ${target.toFixed(3)}s landed at ${A.transport.t.toFixed(3)}s`);
screenshot('out/03-seeked.png');

A.setPlayhead(0);
pump(120);
ok(A.transport.t < 0.5, `seek back to 0 landed at ${A.transport.t.toFixed(3)}s`);

// ── frame stepping moves by pictures, both ways ────────────────────────────
// The bug this guards: the buttons used to do currentTime += 1/fps, and a back
// step landed on the frame it started from, so nothing happened.

console.log('\nframe step');
A.setPlayhead(clip.length * 0.4);
pump(60);
const stepOrigin = A.transport.t;

el('btn-next').click();
pump(60);
const stepped = A.transport.t;
ok(stepped > stepOrigin,
   `next frame advanced ${stepOrigin.toFixed(4)} → ${stepped.toFixed(4)}s`);
ok(stepped - stepOrigin < 0.2,
   `and it moved one frame, not a chunk of time (${(stepped - stepOrigin).toFixed(4)}s)`);

el('btn-prev').click();
pump(60);
ok(Math.abs(A.transport.t - stepOrigin) < 0.0005,
   `previous frame came back to ${stepOrigin.toFixed(4)}s (${A.transport.t.toFixed(4)}s)`);

let walk = A.transport.t;
let movedBack = 0;
for (let i = 0; i < 4; i++) {
    el('btn-prev').click();
    pump(30);
    if (A.transport.t < walk) movedBack++;
    walk = A.transport.t;
}
ok(movedBack === 4, `four back steps each moved (${movedBack})`);
screenshot('out/04-stepped.png');

// ── the end of the file is reachable ───────────────────────────────────────
// A reordering codec holds its whole DPB back — sixteen pictures for HEVC —
// and until the pipeline drains the decoder at end of stream none of them are
// ever shown. That is a full second of a 15 fps file missing, and it looks
// like the playhead stopping short of the end.

console.log('\nthe tail of the file');
A.setPlayhead(Math.max(0, clip.length - 2));
pump(200);
let last = A.transport.t, steps = 0;
for (let i = 0; i < 400; i++) {
    if (!video.stepFrame(1)) break;
    pump(20);
    if (A.transport.t <= last) break;
    last = A.transport.t;
    steps++;
}
const frameSec = 1 / (p.video.fps || 25);
ok(steps > 0, `stepped ${steps} frames to the end`);
ok(clip.length - last < frameSec * 2.5,
   `last picture is ${((clip.length - last) / frameSec).toFixed(2)} frames from the end ` +
   `(${last.toFixed(3)}s of ${clip.length.toFixed(3)}s)`);

// ── the timeline shows what is in the file ─────────────────────────────────
// Two lanes: V1 draws a filmstrip, A1 draws the waveform. Both come from
// bro.media in a worker, so this waits for them rather than assuming.

console.log('\ntimeline');
const v1 = () => A.timeline.laneOf(0);
const film = v1().canvas, wave = el('wave');
const litFraction = (canvas) => {
    if (!canvas.width || !canvas.height) return 0;
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return lit / (d.length / 4);
};
// The lane paints its own clip backgrounds, so "not black" no longer means
// "there is a waveform". The trace is the only strongly green thing on it.
const waveFraction = (canvas) => {
    if (!canvas.width || !canvas.height) return 0;
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] - d[i] > 40) lit++;
    return lit / (d.length / 4);
};
waitFor('the worker to read the clip', () => clip.film && (clip.peaks || !p.audio), 30000);
pump(80);
ok(film.width > 100, `filmstrip canvas sized ${film.width}x${film.height}`);
ok(litFraction(film) > 0.5, `filmstrip has picture (${(litFraction(film) * 100).toFixed(0)}% lit)`);
ok(clip.film.times.length === clip.film.count &&
   clip.film.times[clip.film.count - 1] > clip.film.times[0],
   `${clip.film.count} thumbnails walking ${clip.film.times[0].toFixed(2)}s → ` +
   `${clip.film.times[clip.film.count - 1].toFixed(2)}s`);
if (p.audio) {
    ok(waveFraction(wave) > 0.02 && waveFraction(wave) < 0.9,
       `waveform drawn, not a solid block (${(waveFraction(wave) * 100).toFixed(0)}% lit)`);
    ok(clip.peaks.duration > 0, `peaks span ${clip.peaks.duration.toFixed(3)}s`);
} else {
    ok(!clip.peaks, 'no peaks for a file with no audio track');
    ok(waveFraction(wave) < 0.02, 'and no waveform is drawn');
}
screenshot('out/05-timeline.png');

// ── zooming the timeline ───────────────────────────────────────────────────

console.log('\nzoom');
const fitSpan = A.timeline.getView().span;
ok(Math.abs(fitSpan - Math.max(clip.length, 1)) < 0.01,
   `fit shows the whole timeline (${fitSpan.toFixed(3)}s)`);

A.setPlayhead(clip.length * 0.5);
pump(60);
const anchor = A.transport.t;
el('btn-zoom-in').click();
el('btn-zoom-in').click();
el('btn-zoom-in').click();
pump(60);
const v = A.timeline.getView();
ok(v.span < fitSpan * 0.5, `zoomed in to ${v.span.toFixed(3)}s of ${fitSpan.toFixed(3)}s`);
ok(anchor >= v.start && anchor <= v.start + v.span,
   `the playhead stayed in view (${v.start.toFixed(2)}–${(v.start + v.span).toFixed(2)})`);
ok(el('tl-thumb').style.display !== 'none', 'the scrollbar appears once zoomed');
ok(litFraction(film) > 0.5, 'the filmstrip redraws at the new zoom');
ok(el('ruler').children.length > 1,
   `the ruler relabels itself (${el('ruler').children.length} ticks)`);
screenshot('out/06-zoomed.png');

// Panning keeps the window inside the timeline rather than sliding off it.
A.timeline.panBy(-1e6);
ok(A.timeline.getView().start === 0, 'panning stops at the start');
A.timeline.panBy(1e6);
const end = A.timeline.getView();
ok(Math.abs(end.start + end.span - Math.max(clip.length, 1)) < 0.01,
   'and at the end');

el('btn-zoom-fit').click();
pump(40);
ok(Math.abs(A.timeline.getView().span - fitSpan) < 0.01, 'Fit goes back to the whole timeline');

// ── the real gestures, not just the functions behind them ──────────────────
// Everything above drives the model. These are the actual events the engine
// delivers, which is the only way to know the handlers are wired to anything.

console.log('\ngestures');
const rectOf = (e) => e.getBoundingClientRect();
const filmRect = rectOf(v1().lane);
const midY = filmRect.top + filmRect.height / 2;

// Wheel over the timeline zooms about the pointer: the time under the cursor
// has to still be under the cursor afterwards.
const probeX = filmRect.left + filmRect.width * 0.7;
const underCursor = A.timeline.xToTime(probeX - filmRect.left);
wheel(probeX, midY, -3);
pump(40);
const zoomedSpan = A.timeline.getView().span;
ok(zoomedSpan < fitSpan, `wheel zoomed in (${zoomedSpan.toFixed(3)}s)`);
const stillUnder = A.timeline.xToTime(probeX - filmRect.left);
ok(Math.abs(stillUnder - underCursor) < zoomedSpan * 0.02,
   `and held ${underCursor.toFixed(3)}s under the pointer (${stillUnder.toFixed(3)}s)`);
wheel(probeX, midY, 3);
pump(40);
ok(A.timeline.getView().span > zoomedSpan, 'and back out again');
el('btn-zoom-fit').click();
pump(40);

// Dragging a clip on V1 moves it in time.
const wasStart = clip.start;
const grabX = filmRect.left + filmRect.width * 0.3;
const dropX = filmRect.left + filmRect.width * 0.5;
mouseDown(grabX, midY);
pump(20);
mouseMove(grabX + 20, midY);
mouseMove(dropX, midY);
pump(20);
mouseUp(dropX, midY);
pump(60);
ok(clip.start > wasStart,
   `dragging the clip moved it ${wasStart.toFixed(2)}s → ${clip.start.toFixed(2)}s`);

// And dragging it back off the left edge puts it at the start rather than at
// a negative time.
mouseDown(dropX, midY);
mouseMove(dropX - 40, midY);
mouseMove(filmRect.left + 2, midY);
mouseUp(filmRect.left + 2, midY);
pump(60);
ok(clip.start === 0, `dragging it back put it at the start (${clip.start.toFixed(4)}s)`);

// Dragging the ruler scrubs.
const rulerRect = rectOf(el('ruler'));
const scrubTo = rulerRect.left + rulerRect.width * 0.35;
mouseDown(scrubTo, rulerRect.top + rulerRect.height / 2);
mouseUp(scrubTo, rulerRect.top + rulerRect.height / 2);
pump(160);
const wanted = A.timeline.xToTime(scrubTo - rulerRect.left);
ok(Math.abs(A.transport.t - wanted) < 0.5,
   `pressing the ruler at ${wanted.toFixed(2)}s moved the playhead there ` +
   `(${A.transport.t.toFixed(2)}s)`);

// ── a second clip ──────────────────────────────────────────────────────────

if (second) {
    console.log('\na second clip');
    const p2 = bro.ffmpeg.probe(second);
    dropFiles(400, 300, [second]);
    waitFor('the second file to load', () => A.project.clips.length === 2);
    const b = A.project.clips[1];
    ok(A.project.clips.length === 2, 'two clips on the timeline');
    ok(Math.abs(b.start - clip.length) < 0.01,
       `the new clip lands after the first (${b.start.toFixed(3)}s)`);
    ok(A.timeline.getView().span > fitSpan, 'and the view refits to cover both');

    waitFor('the second clip to be read', () => b.film && (b.peaks || !p2.audio), 40000);
    pump(80);
    ok(litFraction(film) > 0.5, 'both clips draw on V1');

    // The transport is the timeline's, not one file's: the playhead crossing
    // the boundary has to hand over to the other clip's decoder.
    A.setPlayhead(clip.length + Math.min(1, b.length / 2));
    pump(200);
    ok(A.activeClip() === b, 'the playhead inside the second clip plays the second clip');
    ok(A.project.selected === b, 'and the inspector follows it');
    ok(el('filename').textContent === b.name, `the title bar names it: ${b.name}`);
    A.setPlayhead(clip.length * 0.5);
    pump(200);
    ok(A.activeClip() === clip, 'and back again');
    screenshot('out/07-two-clips.png');

    // The Sources stage reads every file on the timeline, not the selected
    // one: its card in the spine counts them, and a stage that says three and
    // shows one is asking to be disbelieved.
    {
        const base = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
        const text = el('sources').textContent;
        ok(text.indexOf(base(media)) >= 0 && text.indexOf(base(second)) >= 0,
           'both sources are read out, whichever clip is selected');
        ok((text.match(/Container/g) || []).length === 2,
           'one block per file, and two files means two');
    }

    // Moving one. Dragged past the other, the other is pushed out of the way
    // rather than the two overlapping with no answer to which is on screen.
    b.start = 0;
    A.resolveOverlaps(b);
    A.timeline.draw();
    pump(40);
    ok(b.start === 0, 'the second clip moved to the start');
    ok(Math.abs(clip.start - b.length) < 0.01,
       `and pushed the first one out of the way to ${clip.start.toFixed(3)}s`);

    // Deleting takes it off the timeline and releases its decoder.
    A.select(b);
    A.removeSelection();
    pump(80);
    ok(A.project.clips.length === 1, 'deleting the selected clip removes it');
    ok(!b.video, 'and lets go of its decoder');

    // Deleting leaves the gap the removed clip occupied — nothing closes up on
    // its own. Put the survivor back at the top so the rest of this runs on an
    // ordinary one-clip timeline.
    clip.start = 0;
    A.timeline.fitView();
}

// ── the picture can be scaled and cropped ──────────────────────────────────

console.log('\nviewer transform');
// clip.start is not 0 any more if the reorder above pushed it along.
A.setPlayhead(clip.start + clip.length * 0.3);
pump(200);
const shown = A.activeClip();
ok(!!shown && !!shown.frame, 'the active clip has a crop window');
const wholeW = parseFloat(shown.frame.style.width);
const wholeH = parseFloat(shown.frame.style.height);
ok(wholeW > 0 && wholeH > 0, `picture placed at ${wholeW.toFixed(0)}x${wholeH.toFixed(0)}`);

shown.xform.zoom = 2;
A.viewer.refresh(shown);
pump(40);
ok(Math.abs(parseFloat(shown.frame.style.width) - wholeW * 2) < 1,
   'scale 2× doubles the placed picture');
shown.xform.zoom = 1;

shown.xform.crop = { l: 0.25, t: 0.1, r: 0.25, b: 0.1 };
A.viewer.refresh(shown);
pump(40);
const cw = parseFloat(shown.frame.style.width);
const ch = parseFloat(shown.frame.style.height);
ok(Math.abs(cw - wholeW * 0.5) < 1, `cropping half the width leaves ${cw.toFixed(0)}px`);
ok(Math.abs(ch - wholeH * 0.8) < 1, `and 80% of the height leaves ${ch.toFixed(0)}px`);
// The picture itself is untouched — it is the window that shrank, which is
// what stops a crop from also scaling what is left.
ok(Math.abs(parseFloat(shown.video.style.width) - wholeW) < 1,
   'the picture inside keeps its size');
ok(Math.abs(parseFloat(shown.video.style.left) + wholeW * 0.25) < 1,
   'and slides so the trimmed edge falls outside the window');

A.setCropMode(true);
pump(40);
ok(el('cropbox').className.indexOf('hidden') < 0, 'crop handles appear');
ok(Math.abs(parseFloat(el('cropbox').style.width) - cw) < 1,
   'and sit on the cropped picture');
screenshot('out/08-cropped.png');
A.setCropMode(false);

// Resizing the output canvas re-fits every clip inside it.
const wasStage = A.viewer.stageSize();
A.project.width = 1080; A.project.height = 1920;
A.viewer.layout();
pump(40);
const nowStage = A.viewer.stageSize();
ok(nowStage.h >= nowStage.w, `canvas resized to portrait (${nowStage.w}x${nowStage.h})`);
ok(nowStage.w !== wasStage.w || nowStage.h !== wasStage.h, 'the stage changed shape');
screenshot('out/09-portrait.png');
A.project.width = shown.width; A.project.height = shown.height;
shown.xform.crop = { l: 0, t: 0, r: 0, b: 0 };
A.viewer.layout();

// ── splitting, and trimming by dragging an end ─────────────────────────────
//
// A split is two clips over the same file covering exactly what one covered.
// Trimming is the same edit from the other direction: drag an end inward and
// the pictures under the part you kept must not slide sideways.

console.log('\nsplit and trim');
{
    const before = A.project.clips.length;
    const whole = clip.length, at = clip.start + whole * 0.4;
    A.select(clip);
    A.setPlayhead(at);
    pump(120);
    // Where the playhead actually landed, which is the frame containing the
    // time asked for and so generally a little earlier. The cut is there.
    const cutAt = A.transport.t;
    A.splitAtPlayhead();
    pump(120);
    ok(A.project.clips.length === before + 1, 'splitting makes one more clip');
    const left = A.project.clips.find((c) => c.start === 0 || c === clip);
    const right = A.project.selection[0];
    ok(Math.abs(left.length + right.length - whole) < 0.01,
       `the halves add up to the whole (${left.length.toFixed(2)} + ` +
       `${right.length.toFixed(2)} = ${whole.toFixed(2)}s)`);
    ok(Math.abs(right.start - cutAt) < 0.01, 'the cut is at the playhead');
    ok(Math.abs(right.inPoint - (left.inPoint + left.length)) < 0.01,
       `and the right half starts where the left one stopped in the file ` +
       `(${right.inPoint.toFixed(2)}s in)`);
    ok(right.path === left.path, 'both halves are the same file');

    // Trim the right half's head by dragging its left edge. In-point and start
    // move together, so what is under the remaining pictures does not shift.
    A.timeline.fitView();
    A.timeline.draw();
    pump(40);
    const lane = rectOf(v1().lane);
    const y = lane.top + lane.height / 2;
    const edgeX = lane.left + A.timeline.timeToX(right.start);
    const wasIn = right.inPoint, wasStart = right.start, wasLen = right.length;
    const dragTo = edgeX + Math.max(12, lane.width * 0.05);
    A.select(right);
    mouseDown(edgeX, y);
    mouseMove(edgeX + 8, y);
    mouseMove(dragTo, y);
    mouseUp(dragTo, y);
    pump(80);
    ok(right.start > wasStart, `trimming the head moved the start ` +
       `${wasStart.toFixed(2)} → ${right.start.toFixed(2)}s`);
    ok(Math.abs((right.inPoint - wasIn) - (right.start - wasStart)) < 0.02,
       'and the in-point moved with it, so the pictures stayed put');
    ok(right.length < wasLen, `and the clip got shorter (${right.length.toFixed(2)}s)`);
    ok(Math.abs(right.start + right.length - (wasStart + wasLen)) < 0.02,
       'while its tail stayed where it was');

    // Undo the experiment: rejoin by deleting the right half.
    A.select(right);
    A.removeSelection();
    pump(60);
    left.start = 0;
    left.length = whole;
    left.inPoint = 0;
    A.timeline.fitView();
    A.select(left, 'auto');
    A.setPlayhead(0);
    pump(60);
    ok(A.project.clips.length === before, 'back to where we started');
}

// ── stacked tracks, opacity and selecting several clips ────────────────────

console.log('\ntracks');
{
    const a = A.project.clips[0];
    ok(A.timeline.laneOf(0) && A.timeline.laneOf(1),
       'there is a spare lane above the one in use, to drag into');
    ok(!A.timeline.laneOf(A.project.clips.length + 4), 'and not an endless supply of them');

    a.track = 1;
    A.timeline.draw();
    pump(40);
    ok(A.timeline.laneOf(2) !== null, 'moving a clip up makes a new spare lane');

    // Opacity reaches the picture, not just the model.
    a.xform.opacity = 0.4;
    A.viewer.refreshAll();
    pump(40);
    ok(Math.abs(parseFloat(a.frame.style.opacity) - 0.4) < 0.001,
       'opacity reaches the picture');
    a.xform.opacity = 1;
    a.track = 0;
    A.viewer.refreshAll();
    A.timeline.draw();
    pump(40);
}

// ── the grid ───────────────────────────────────────────────────────────────
//
// The shape is chosen so a cell is the canvas's own aspect, because the clips
// came out of the same canvas — which makes it a search for a square grid, not
// a square cell.

console.log('\ngrid');
{
    const shape = (n, aspect) => A.viewer.gridShape(n, aspect);
    ok(shape(4, 16 / 9).cols === 2 && shape(4, 16 / 9).rows === 2, 'four clips: 2×2');
    ok(shape(12, 16 / 9).cols === 4 && shape(12, 16 / 9).rows === 3, 'a dozen: 4×3, not 3×4');
    ok(shape(2, 16 / 9).cols === 2 && shape(2, 16 / 9).rows === 1, 'two: side by side');
    ok(shape(3, 16 / 9).cols === 2 && shape(3, 16 / 9).rows === 2,
       'three: two-up with a gap, not one row of slivers');

    const s = A.viewer.stageSize();
    const stacked = A.viewer.placement(clip, s.w, s.h);
    A.setLayout('grid');
    pump(60);
    const celled = A.viewer.placement(clip, s.w, s.h);
    ok(!!celled.cell, 'a clip in grid layout gets a cell');
    if (A.project.clips.length === 1) {
        ok(celled.w <= stacked.w + 1, 'one clip fills its cell, which is the whole canvas');
    } else {
        ok(celled.w < stacked.w, 'and its picture is smaller than it was on the whole canvas');
    }
    A.setLayout('stack');
    pump(60);
    ok(!A.viewer.placement(clip, s.w, s.h).cell, 'and back to the whole canvas');
}

// ── controls are wired ─────────────────────────────────────────────────────

console.log('\ncontrols');
el('btn-play').click();
pump(120);
ok(A.transport.playing, 'play button starts playback');
ok(el('btn-play').querySelector('svg') && el('btn-play').getAttribute('data-icon') === 'pause',
   'and shows the pause icon while it plays');
el('btn-play').click();
pump(60);
ok(!A.transport.playing, 'play button pauses again');
ok(el('btn-play').getAttribute('data-icon') === 'play', 'and goes back to the play icon');

el('btn-loop').click();
pump(20);
ok(A.transport.loop === true, 'loop button arms looping');
el('btn-loop').click();
pump(20);
ok(A.transport.loop === false, 'loop button disarms looping');

A.transport.muted = false;
el('btn-mute').click();
pump(20);
ok(A.transport.muted === true, 'mute button mutes');
ok(el('vol-fill').style.width === '0.0%', 'volume meter reads zero when muted');
ok(el('btn-mute').getAttribute('data-icon') === 'muted', 'and the speaker icon crosses out');
el('btn-mute').click();
pump(20);
ok(A.transport.muted === false, 'mute button unmutes');

// ── the row is laid out, not just wired ────────────────────────────────────
//
// These are the kind of thing that breaks silently: a mistyped icon name
// leaves an empty button, and a stray width on one control drags the whole
// transport off centre. Neither shows up in a behavioural check.

console.log('\nlayout');
const iconButtons = document.querySelectorAll('button[data-icon]');
ok(iconButtons.length >= 9, `${iconButtons.length} icon buttons`);
let drawn = 0, sameWidth = new Set();
for (const b of iconButtons) if (b.querySelector('svg')) drawn++;
ok(drawn === iconButtons.length, 'every one of them actually drew its icon');

for (const id of ['btn-start', 'btn-prev', 'btn-next', 'btn-end'])
    sameWidth.add(Math.round(el(id).getBoundingClientRect().width));
ok(sameWidth.size === 1, `the transport buttons are one width (${[...sameWidth]}px)`);

const rowBox  = el('buttonrow').getBoundingClientRect();
const playBox = el('btn-play').getBoundingClientRect();
const offCentre = Math.abs((playBox.left + playBox.width / 2) - (rowBox.left + rowBox.width / 2));
ok(offCentre <= 1, `the transport sits on the centre line (off by ${offCentre.toFixed(1)}px)`);

ok(Math.abs(el('btn-zoom-out').getBoundingClientRect().left -
            el('ruler').getBoundingClientRect().left) < 0.5,
   'the zoom controls start on the timeline’s left edge');

el('btn-start').click();
pump(80);
ok(A.transport.t < 0.5, 'go-to-start rewinds');

const rate = el('rate');
rate.value = '2';
rate.dispatchEvent(new Event('change'));
pump(20);
ok(A.transport.rate === 2 && A.video().playbackRate === 2,
   'speed selector reaches the clip');
rate.value = '1';
rate.dispatchEvent(new Event('change'));
pump(20);

// ── the graph stage ────────────────────────────────────────────────────────
//
// What the timeline comes to, in ffmpeg's own terms. Checked here rather than
// in tests/ui_graph.js because that one runs without media and can only reach
// the refusal: everything below needs a real edit behind it, and a layout is
// only true once it has been measured on a stage that is actually on screen.

console.log('\nthe graph stage');
{
    ok(A.shell.stages().indexOf('graph') === 2,
       'Graph sits between Compose and Encode, where it is in ffmpeg');

    // Through the keyboard, because a stage you can only reach by clicking a
    // card is one the keyboard is lying about.
    //
    // Dispatched on <body> and left to bubble, not on `document`: this engine
    // gives Document `addEventListener` but not `dispatchEvent`, so the node
    // the app listens on is not one a test can aim at directly. Bubbling from
    // body reaches it and is what a real key press does anyway.
    key('n');
    pump(200);
    ok(A.shell.currentStage() === 'graph', 'n goes there');

    const g = A.graph.derive(A.exporter.buildSpec(), A.exporter.specSources());
    ok(g.ok, 'the edit on the timeline can be described as a graph');
    const cards = document.querySelectorAll('#gr-nodes .gn');
    ok(cards.length === g.graph.nodes.length,
       `one card per node — ${cards.length} of them`);

    // Every card measured. A stage that is display:none measures zero, and a
    // layout built from zeroes is a heap of nodes in the top-left corner that
    // nobody ever sees be wrong.
    let flat = 0, laid = 0;
    for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) flat++;
        if (c.style.left !== '' && c.style.top !== '') laid++;
    }
    ok(flat === 0, 'every card has a size');
    ok(laid === cards.length, 'and a place');

    // The nodes are spread out, not stacked: two cards at the same point is
    // what a layout that never ran looks like.
    const spots = new Set();
    for (const c of cards) spots.add(`${c.style.left},${c.style.top}`);
    ok(spots.size === cards.length, 'and no two of them share it');

    // The picture and the command are the same statement. If the stage can
    // draw a node the printer does not put in a chain, one of them is wrong.
    const printed = A.graph.print(g.graph);
    const status = el('gr-status').textContent;
    ok(status.indexOf(`${printed.chains.length} chain`) >= 0,
       `the bar counts what the command bar prints: "${status}"`);
    ok(A.command.currentCommand().indexOf(printed.chains[0]) > 0,
       'and the first chain is in the command underneath, verbatim');

    // Inputs are named after the files, which is the one thing on this screen
    // that ties a node back to something outside it.
    const names = Array.from(document.querySelectorAll('#gr-nodes .gn-input .gn-name'))
                       .map((n) => n.textContent);
    ok(names.length >= 1 && names.some((n) => media.indexOf(n) >= 0),
       `an input card is named after its file: ${names.join(', ')}`);

    // The wires are drawn in screen coordinates against a canvas the size of
    // the viewport, so the two have to agree or half the graph has no wires.
    const canvas = el('gr-wires');
    const vp = el('gr-viewport');
    ok(Math.abs(canvas.width - vp.clientWidth) <= 1 &&
       Math.abs(canvas.height - vp.clientHeight) <= 1,
       `the wire canvas covers the viewport (${canvas.width}x${canvas.height})`);

    flush();
    screenshot('out/11-graph.png');

    // Back, and the picture is still there — the stages hide each other rather
    // than unmounting, because the viewer's <video> elements are the decoders.
    key('Escape');
    pump(200);
    ok(A.shell.currentStage() === 'compose', 'Escape comes back to the edit');
    ok(!!A.video(), 'and the decoders were never torn down');
}

// ── fullscreen strips the chrome ───────────────────────────────────────────

console.log('\nfullscreen');
el('btn-full').click();
pump(80);
ok(document.body.className.indexOf('fs') >= 0, 'body enters fullscreen mode');
flush();
screenshot('out/10-fullscreen.png');
el('btn-full').click();
pump(80);
ok(document.body.className.indexOf('fs') < 0, 'fullscreen toggles back off');

// ── a batch of files at once ───────────────────────────────────────────────
//
// Dropping a morning's recordings is a different act from opening one file:
// they go on tracks of their own, all starting at zero, and play together in a
// grid. This is the last section because it replaces everything on the
// timeline.

console.log('\na batch');
{
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(120);
    ok(A.project.clips.length === 0, 'cleared the timeline');

    const batch = second ? [media, second, media] : [media, media, media];
    A.openBatch(batch);
    waitFor('the batch to load', () => A.project.clips.length === 3);
    pump(300);
    ok(A.project.clips.length === 3, 'three clips from one drop');
    ok(A.project.layout === 'grid', 'and the canvas went to a grid');
    const tracks = A.project.clips.map((c) => c.track);
    ok(new Set(tracks).size === 3, `each on its own track (${tracks.join(', ')})`);
    ok(A.project.clips.every((c) => c.start === 0), 'all starting together at zero');
    ok(A.project.selection.length === 3, 'and all three selected');

    waitFor('all three decoders', () => A.activeClips().length === 3, 20000);
    ok(A.activeClips().length === 3, 'the playhead is inside all three at once');
    const boxes = A.activeClips().map((c) => c.frame.getBoundingClientRect());
    ok(boxes.every((b) => b.width > 4 && b.height > 4), 'each has a cell with a picture in it');
    // Cells must not sit on top of each other — the whole point of a grid.
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
            if (boxes[i].left < boxes[j].right - 1 && boxes[j].left < boxes[i].right - 1 &&
                boxes[i].top < boxes[j].bottom - 1 && boxes[j].top < boxes[i].bottom - 1) overlaps++;
    ok(overlaps === 0, 'and no two cells overlap');
    screenshot('out/11-grid.png');

    // They play together, and are chased back into line rather than left to
    // drift apart on three independent audio clocks.
    A.transport.muted = true;
    A.play();
    pump(1500);
    A.pause();
    pump(100);
    const drift = A.activeClips().map((c) => Math.abs(c.video.currentTime - c.inPoint -
                                                      (A.transport.t - c.start)));
    ok(A.transport.t > 0.2, `the grid played (${A.transport.t.toFixed(2)}s)`);
    ok(Math.max(...drift) < 0.25,
       `and stayed in step (worst drift ${Math.max(...drift).toFixed(3)}s)`);
    screenshot('out/12-grid-playing.png');

    // Property edits reach every selected clip at once.
    A.selectMany(A.project.clips.slice());
    A.showProperties();
    // By selector, not by id: the panel is rebuilt on every change, and its
    // controls are named by what they edit rather than by unique ids.
    const slider = document.querySelector('#transform [data-s="opacity"]');
    ok(!!slider, 'the properties panel has an opacity control for the whole selection');
    slider.value = '50';
    slider.dispatchEvent(new Event('input'));
    pump(60);
    ok(A.project.clips.every((c) => Math.abs(c.xform.opacity - 0.5) < 0.001),
       'and one drag sets all three');
    ok(A.project.clips.every((c) => Math.abs(parseFloat(c.frame.style.opacity) - 0.5) < 0.001),
       'which reaches all three pictures');

    // A property the clips disagree on reads as mixed rather than as one of them.
    A.project.clips[0].xform.crop.l = 0.2;
    A.showProperties();
    const cropLeft = document.querySelector('#transform [data-crop-edge="l"]');
    ok(cropLeft.value === '' && cropLeft.className.indexOf('mixed') >= 0,
       'a crop the three disagree on shows as mixed, not as one of their values');
    A.project.clips[0].xform.crop.l = 0;
    A.viewer.refreshAll();
}

console.log(`\n${checks} checks passed`);
