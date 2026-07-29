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
// The two files whose point is one fact each, and whose sections are skipped
// without them: a clip stored sideways, and a clip with no picture in it.
const rotated = args[2];
const soundOnly = args[3];
assert(media, 'pass a media file: ... tests/ui_player.js -- <file> [<file2>] ' +
              '[<rotated>] [<sound-only>]');

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
// The Sources stage is the input editor now, and it is drawn into three
// columns rather than one scroll. A drop makes an input; the detail column is
// what that input turned out to contain.
ok(el('src-detail').textContent.indexOf('What came back') >= 0,
   'the Sources stage read the input');
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

    // The Sources stage lists the inputs — the `-i`s — and not the clips.
    // Two files dropped are two inputs, whichever clip is selected, and the
    // list is the document's rather than the timeline's: an input with nothing
    // cut from it stays on it.
    {
        const base = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
        const list = el('src-list').textContent;
        ok(list.indexOf(base(media)) >= 0 && list.indexOf(base(second)) >= 0,
           'both inputs are listed, whichever clip is selected');
        ok(A.inputs.inputs.length === 2, `two files dropped, two inputs (${A.inputs.inputs.length})`);
        ok(el('src-detail').textContent.indexOf('What came back') >= 0,
           'and the one selected reads out what it contains');
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

// ── the three edits that are about a cut ───────────────────────────────────
//
// Ripple, roll and slip needed nothing added to the model: a clip already knows
// its in-point separately from where it sits, which is the whole of what they
// are arithmetic on. What tells them apart is what each holds constant —
// ripple holds the content and moves everything after, roll holds the total and
// moves the boundary, slip holds the window and moves the content inside it —
// so that is what is asserted, one invariant each.
//
// Driven through the model rather than through three synthesised Alt-drags: the
// arithmetic is the claim, and one gesture at the end is enough to show it is
// reachable.

console.log('\nripple, roll and slip');
{
    const whole = clip.length;
    A.select(clip);
    A.setPlayhead(clip.start + whole * 0.4);
    pump(120);
    A.splitAtPlayhead();
    pump(120);
    const two = A.project.clips.slice().sort((a, b) => a.start - b.start);
    const left = two[0], right = two[1];
    ok(two.length === 2 && Math.abs(right.start - (left.start + left.length)) < 0.001,
       'two clips, butted, which is what a cut is');

    // ── slip ───────────────────────────────────────────────────────────────
    // Nothing about the arrangement moves; a different second of the file is in
    // the same window.
    {
        const was = { start: right.start, length: right.length, inPoint: right.inPoint };
        // Backwards, because the right half of a split already runs to the last
        // frame of the file: there is nothing after it to slip *into*, which is
        // the clamp asserted two checks below rather than a direction to pick
        // by accident.
        A.slipClip(right, -0.5);
        ok(right.start === was.start && right.length === was.length,
           'slipping moves neither where the clip sits nor how long it is');
        ok(Math.abs(right.inPoint - (was.inPoint - 0.5)) < 0.001,
           `only which part of the file is in it (${was.inPoint.toFixed(2)} → ` +
           `${right.inPoint.toFixed(2)}s)`);

        // Clamped at the end of the footage, and it stops rather than getting
        // shorter — a slip that shortened a clip would be a trim wearing the
        // wrong name.
        A.slipClip(right, 9999);
        ok(Math.abs(right.length - was.length) < 0.001,
           'a slip past the end of the file stops rather than shortening the clip');
        ok(right.inPoint + right.length <= right.media + 0.001,
           `and stays inside it (${right.inPoint.toFixed(2)} + ${
               right.length.toFixed(2)} ≤ ${right.media.toFixed(2)}s)`);
        A.slipClip(right, -9999);
        ok(right.inPoint === 0, 'and the other way stops at the first frame');
        right.inPoint = was.inPoint;
    }

    // ── roll ───────────────────────────────────────────────────────────────
    // The programme is the same length afterwards; the cut is somewhere else
    // in it. Both halves change, which is why it is a gesture on the cut.
    {
        const total = () => (right.start + right.length) - left.start;
        const wasTotal = total();
        const wasCut = left.start + left.length;
        const wasRightIn = right.inPoint;
        A.rollCut(left, right, wasCut + 0.5);
        ok(Math.abs(total() - wasTotal) < 0.001,
           `rolling leaves the programme exactly as long (${total().toFixed(3)}s)`);
        ok(Math.abs((left.start + left.length) - (wasCut + 0.5)) < 0.001,
           'with the cut where it was dragged to');
        ok(Math.abs(right.start - (left.start + left.length)) < 0.001,
           'and the two still butted, because one boundary moved and not two');
        ok(Math.abs(right.inPoint - (wasRightIn + 0.5)) < 0.001,
           `the right half starting later in the file (${wasRightIn.toFixed(2)} → ` +
           `${right.inPoint.toFixed(2)}s), which is what makes it a roll and not a trim`);
        A.rollCut(left, right, wasCut);
        ok(Math.abs((left.start + left.length) - wasCut) < 0.001, 'and it rolls back');
    }

    // ── ripple ─────────────────────────────────────────────────────────────
    // The gap closes. That is the whole difference from the trim above, which
    // deliberately leaves one.
    {
        const wasRightStart = right.start;
        const wasLeftLen = left.length;
        const wasTotal = (right.start + right.length) - left.start;
        A.rippleTrim(left, 'end', left.start + left.length - 0.5);
        const shortened = wasLeftLen - left.length;
        ok(shortened > 0.4, `rippling the left clip's tail shortens it (${
            shortened.toFixed(2)}s off)`);
        ok(Math.abs(right.start - (wasRightStart - shortened)) < 0.001,
           'and the clip after it comes back by exactly that much, so no gap is left');
        ok(Math.abs(right.start - (left.start + left.length)) < 0.001,
           'the two still butted');
        ok(Math.abs(((right.start + right.length) - left.start) - wasTotal) > 0.4,
           'and the programme is shorter, which is the point of a ripple');
    }

    // The gesture reaches it. One drag, with Alt held, on the tail of the left
    // clip — everything above is the arithmetic and this is that it is wired.
    {
        A.timeline.fitView();
        A.timeline.draw();
        pump(60);
        const lane = rectOf(v1().lane);
        const y = lane.top + lane.height / 2;
        const edgeX = lane.left + A.timeline.timeToX(left.start + left.length);
        const wasRightStart = right.start;
        const to = edgeX - Math.max(14, lane.width * 0.04);
        // Dispatched rather than driven through the harness's `mouseDown`,
        // which takes a button and a window and has nowhere to put a modifier.
        // The press goes to the lane and the rest to the document, because that
        // is where `tracked()` listens — losing the pointer off the element
        // mid-drag is normal and losing the drag when it does is not.
        const send = (type, px, target) => (target || document).dispatchEvent(
            new MouseEvent(type, { bubbles: true, button: 0, altKey: true,
                                   clientX: Math.round(px), clientY: Math.round(y) }));
        send('mousedown', edgeX, v1().lane);
        send('mousemove', edgeX - 8);
        send('mousemove', to);
        send('mouseup', to);
        pump(80);
        ok(right.start < wasRightStart - 0.01,
           `Alt-dragging a clip's end ripples rather than leaving a gap (${
               wasRightStart.toFixed(2)} → ${right.start.toFixed(2)}s)`);
        ok(Math.abs(right.start - (left.start + left.length)) < 0.02,
           'the clip after it still butted against the new out-point');
    }

    // Back to one clip, so everything after this is the timeline it was.
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
    ok(A.project.clips.length === 1, 'back to one clip, where we started');
}

// ── one waveform for the whole timeline ────────────────────────────────────
//
// A1 used to paint each clip in turn, so two that overlapped in time drew over
// each other and what you saw was whichever came last in the list — which is
// not what the render makes of that moment, and that moment is the one somebody
// is looking at A1 to judge.
//
// The peaks here are hand-made, the way `ui_filtergraph.js` hand-makes specs:
// the claim is arithmetic on two known numbers, and a fixture that happened to
// contain the right sound would prove it only by luck. What is asserted is the
// pair of sums — the envelope adds, the body is a root-sum-of-squares — and
// that a muted clip is outside both.

console.log('\none waveform, not one per clip');
{
    const first = A.project.clips[0];
    A.select(first);
    A.setPlayhead(first.start + first.length * 0.4);
    pump(120);
    A.splitAtPlayhead();
    pump(120);
    const pair = A.project.clips.slice().sort((a, b) => a.start - b.start);
    const a = pair[0], b = pair[1];

    // Laid over each other on two tracks, covering exactly the same seconds:
    // overlapping in time is the whole case, and tracks are how it is reached.
    b.track = 1;
    b.start = a.start;
    b.length = a.length;
    b.inPoint = a.inPoint;

    // A flat -6 dBFS tone in both, so what comes out is checkable by hand.
    const flat = (v) => ({
        buckets: 8, duration: a.length,
        min: new Array(8).fill(-v), max: new Array(8).fill(v),
        rms: new Array(8).fill(v),
    });
    a.peaks = flat(0.5);
    b.peaks = flat(0.5);
    a.volume = 1; b.volume = 1;
    a.muted = false; b.muted = false;

    A.timeline.fitView();
    A.timeline.draw();
    pump(60);
    const w = A.timeline.laneWidthPx();
    const at = Math.round(A.timeline.timeToX(a.start + a.length * 0.5));

    const both = A.timeline.mixColumns(w);
    ok(both.mixed && !both.quiet.length, 'both clips are in the mix');
    ok(Math.abs(both.hi[at] - 1.0) < 0.02,
       `the envelope adds — two at 0.5 reach ${both.hi[at].toFixed(3)}, which is what ` +
       'clipping is');
    ok(Math.abs(both.lo[at] + 1.0) < 0.02,
       `and downwards too (${both.lo[at].toFixed(3)})`);
    ok(Math.abs(both.rms[at] - Math.SQRT1_2) < 0.02,
       `the body is a root-sum-of-squares — two at 0.5 make ${both.rms[at].toFixed(3)}, ` +
       'not 1.0, because power adds and amplitude does not');

    // One clip alone, for the comparison that says the sum happened at all.
    b.muted = true;
    const one = A.timeline.mixColumns(w);
    ok(one.quiet.length === 1, 'a muted clip is outside the mix');
    ok(Math.abs(one.hi[at] - 0.5) < 0.02,
       `so the envelope is one clip's again (${one.hi[at].toFixed(3)})`);
    ok(one.hi[at] < both.hi[at] - 0.2,
       'which is lower than the two of them together — the overlap was summed, not ' +
       'painted over');

    // Volume is part of the mix, because the mixer applies it before summing.
    b.muted = false;
    b.volume = 0.5;
    const quieter = A.timeline.mixColumns(w);
    ok(Math.abs(quieter.hi[at] - 0.75) < 0.02,
       `a clip at half volume contributes half (${quieter.hi[at].toFixed(3)})`);

    // ── the scale it is drawn on ──────────────────────────────────────────
    //
    // The lane is dB now, and the reason the sum above is worth having is that
    // it can exceed full scale. Two claims: that a halving is a fixed distance
    // wherever it happens (which is what makes the scale worth changing to),
    // and that a column past 1.0 is marked (which is what the scale is *for*).
    const { dbHeight, ZERO_DBFS, DB_FLOOR, DB_CEIL } = A.timeline;
    const six = 20 * Math.log10(2) / (DB_CEIL - DB_FLOOR);
    ok(dbHeight(0) === 0 && dbHeight(0.001) === 0,
       'silence and the floor are both on the centre line');
    ok(dbHeight(4) === 1 && dbHeight(1e6) === 1, 'and the ceiling is the top');
    ok(Math.abs(dbHeight(1) - 60 / 66) < 1e-9,
       `full scale is ${dbHeight(1).toFixed(4)} of the way up, leaving 6 dB of ` +
       'headroom above it for a mix that goes over');
    ok(ZERO_DBFS === dbHeight(1), 'which is where the clipping line is drawn');
    ok(Math.abs((dbHeight(1) - dbHeight(0.5)) - six) < 1e-9 &&
       Math.abs((dbHeight(0.5) - dbHeight(0.25)) - six) < 1e-9,
       'a halving is the same distance wherever it happens — which linear ' +
       'amplitude is exactly what does not do');
    ok(dbHeight(-0.5) === dbHeight(0.5),
       'and the trough is as far below the line as the peak is above it');

    // At the boundary, and past it. Two at 0.5 sum to exactly full scale: that
    // is not an over, and saying it was would cry wolf on every loud mix.
    a.volume = 1; b.volume = 1;
    const edge = A.timeline.mixColumns(w);
    ok(Math.abs(edge.hi[at] - 1) < 1e-6 && !edge.clipped[at],
       'a mix that reaches full scale exactly is not clipping');
    a.peaks = flat(0.6);
    const over = A.timeline.mixColumns(w);
    ok(over.hi[at] > 1 && over.clipped[at] === 1,
       `and one that goes past it is (${over.hi[at].toFixed(3)})`);
    ok(dbHeight(over.hi[at]) > ZERO_DBFS,
       'so it is drawn above the line rather than clamped onto it, which is ' +
       'what made an over invisible before');
    // Downwards on its own — asymmetric material really does exist, and an
    // encoder clips both halves.
    a.peaks = flat(0.5);
    a.peaks.min = new Array(8).fill(-0.7);
    const under = A.timeline.mixColumns(w);
    ok(under.hi[at] <= 1 && under.lo[at] < -1 && under.clipped[at] === 1,
       `a mix that only goes over downwards is still clipping (${under.lo[at].toFixed(3)})`);

    // Back to one clip, so everything after this is the timeline it was.
    const whole = a.length + b.length;
    A.select(b);
    A.removeSelection();
    pump(60);
    a.track = 0;
    a.start = 0;
    a.length = whole;
    a.inPoint = 0;
    a.peaks = null;
    a.volume = 1;
    A.timeline.fitView();
    A.select(a, 'auto');
    A.setPlayhead(0);
    pump(60);
    ok(A.project.clips.length === 1, 'back to one clip');
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

// ── a drag that rebuilds the lanes under itself ────────────────────────────
//
// Dragging a clip into the spare top lane is the one gesture that changes the
// track count, and changing the track count drops and rebuilds every row —
// half way through the drag that is doing it. So this is the one place where
// what the drag is holding on to has to outlive what it is standing on:
//
// - the lane the press started on is detached the instant the clip crosses,
//   and a detached element measures `left: 0` — so a drag that kept the
//   element it began on would put the clip's origin at the left edge of the
//   *window* rather than of the lane, and the clip would jump sideways by the
//   width of the track heads and then snap to the wrong neighbours; and
// - the `document` listeners the drag is delivered through cannot belong to
//   the row either, or removing the row would end the gesture that removed it.
//
// Both are checked by one assertion: after crossing, the clip still follows
// the pointer, and it lands where the pointer let go.

console.log('\ndragging across tracks');
{
    const a = A.project.clips[0];
    a.start = 0;
    a.track = 0;
    A.setPlayhead(0);
    A.timeline.fitView();
    A.timeline.draw();
    pump(60);

    const lane0 = rectOf(A.timeline.laneOf(0).lane);
    const yOf = (track) => {
        const r = rectOf(A.timeline.laneOf(track).lane);
        return r.top + r.height / 2;
    };
    const grabX = lane0.left + lane0.width * 0.30;
    const dropX = lane0.left + lane0.width * 0.55;
    // What the pointer asked for, in seconds, measured the way the lane maps
    // them. The tolerance is four pixels of that same lane — enough for the
    // rounding a synthesised pointer does and nothing else: a drag measured
    // against a detached lane lands the clip a whole lane offset out.
    const wanted = A.timeline.xToTime(dropX - lane0.left) -
                   A.timeline.xToTime(grabX - lane0.left);
    const slack = A.timeline.xToTime(4) - A.timeline.xToTime(0);

    mouseDown(grabX, yOf(0));
    pump(20);
    mouseMove(grabX + 6, yOf(0));
    pump(20);
    // Up into the spare lane. This is the move that rebuilds every row.
    mouseMove(grabX + 8, yOf(1));
    pump(40);
    ok(a.track === 1, 'dragging up into the spare lane restacks the clip');
    ok(A.timeline.laneOf(2) !== null,
       'which rebuilds the lanes — there is a new spare above it now');

    // ...and the drag is still live, and still measuring against a lane that
    // is in the document.
    mouseMove(dropX, yOf(1));
    pump(40);
    mouseUp(dropX, yOf(1));
    pump(60);

    ok(Math.abs(a.start - wanted) < slack,
       `the clip landed where the pointer let go: ${a.start.toFixed(3)}s, ` +
       `asked for ${wanted.toFixed(3)}s (±${slack.toFixed(3)}s)`);
    ok(a.track === 1, 'and stayed on the track it was dragged to');

    // Once released, the pointer moves nothing: the drag ended even though the
    // row it started on was taken away in the middle of it.
    const settled = a.start;
    mouseMove(lane0.left + lane0.width * 0.8, yOf(1));
    pump(40);
    ok(a.start === settled, 'and a pointer move after the release moves nothing');

    a.track = 0;
    a.start = 0;
    A.setPlayhead(0);
    A.timeline.fitView();
    A.timeline.draw();
    pump(60);
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
    // One clip by the time the script gets here — the second file's clip was
    // deleted back at "deleting the selected clip removes it" and the split put
    // its own halves back — so a grid of one is the whole canvas. Said as an
    // assertion rather than as an `if`, because the branch for several clips
    // that used to stand beside this was reachable from nowhere in the file and
    // read as coverage of a case nothing here exercises. The several-clip
    // arrangement is the batch section at the bottom, which has its own checks.
    ok(A.project.clips.length === 1, 'one clip on the timeline, so its cell is the canvas');
    ok(celled.w <= stacked.w + 1, 'and it fills that cell');
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
    // Where Graph sits on the spine is asserted in tests/ui_graph.js, which
    // needs no media for it and states it as the two separate facts it is. It
    // was here as well, in one combined `ok`, and a claim proved in two places
    // is a claim that can be half-fixed.

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

    // One act, not two. `waitFor` asserts on its own timeout, so an `ok()` on
    // the same predicate a line later can only ever pass — the wait returned
    // true, or the process has already died inside it. Asserting on what the
    // wait answered is the same check made once.
    ok(waitFor('all three decoders', () => A.activeClips().length === 3, 20000),
       'the playhead is inside all three at once');
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

// ── a clip recorded sideways plays the right way up ────────────────────────
//
// Phones do not turn the pixels; they record landscape frames and write the
// correction into the container. Nothing about that is visible in what is
// decoded, so the whole of this section is about sizes: the element reports the
// size the picture is *shown* at, and the app lays the clip out against that.

if (rotated) {
    console.log('\na rotated clip');
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(120);

    const rp = bro.ffmpeg.probe(rotated);
    ok(rp.video.rotation === 90, `the file says 90 degrees (${rp.video.rotation})`);
    ok(rp.video.displayWidth === rp.video.height && rp.video.displayHeight === rp.video.width,
       `probe swaps the size for it (${rp.video.width}x${rp.video.height} coded, ` +
       `${rp.video.displayWidth}x${rp.video.displayHeight} shown)`);

    dropFiles(400, 300, [rotated]);
    waitFor('the rotated file to load', () => A.project.clips.length === 1);
    const rc = A.project.clips[0];
    waitFor('a decoded frame', () => A.video() && A.video().videoWidth > 0);
    const rv = A.video();

    // The element is the thing a page lays out against, and it reports the
    // shown size. Asserted on the *element* rather than on the probe because
    // this is the half that lives in bro and the half this application trusts.
    ok(rv.videoRotation === 90, `<video> reports videoRotation ${rv.videoRotation}`);
    ok(rv.videoWidth === rp.video.displayWidth && rv.videoHeight === rp.video.displayHeight,
       `and videoWidth/Height are the shown pair (${rv.videoWidth}x${rv.videoHeight})`);
    ok(rv.videoWidth < rv.videoHeight,
       'so a file coded landscape presents as the portrait clip it is');

    // And the app agrees, which is the thing that was actually broken: a clip
    // laid out at the coded size is a portrait picture in a landscape box.
    ok(rc.width === rv.videoWidth && rc.height === rv.videoHeight,
       `the clip is laid out at ${rc.width}x${rc.height}`);
    ok(A.project.width === rc.width && A.project.height === rc.height,
       `and the canvas was seeded from it (${A.project.width}x${A.project.height})`);
    const box = rc.frame.getBoundingClientRect();
    ok(box.height > box.width, `its picture is taller than it is wide (${
        Math.round(box.width)}x${Math.round(box.height)})`);
    flush();
    screenshot('out/13-rotated.png');
}

// ── a file with no picture in it is an ordinary clip ───────────────────────
//
// It contributes to the mix and to nothing else. So it opens, it lays out with
// a real length, it plays and the playhead moves — and it is not a black
// rectangle over whatever is beneath it, not a lane of missing thumbnails, and
// not a rectangle in the render.

if (soundOnly) {
    console.log('\na clip with no picture');
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(120);

    const sp = bro.ffmpeg.probe(soundOnly);
    ok(!sp.video && !!sp.audio, 'the file really has sound and no picture');

    dropFiles(400, 300, [soundOnly]);
    waitFor('the sound-only file to load', () => A.project.clips.length === 1);
    const sc = A.project.clips[0];
    ok(Math.abs(sc.length - sp.format.duration) < 0.05,
       `it laid out with a real length (${sc.length.toFixed(3)}s)`);
    ok(sc.width === 0 && sc.height === 0, 'and with no size, rather than a plausible one');
    ok(A.video() === sc.video, 'it is the clip that owns the moment, there being no other');

    // The element exists — it *is* the decoder and the sound — and its window
    // is not laid out, because a <video> with no picture keeps the 300x150
    // replaced-element box and would sit black over everything below it.
    ok(!!sc.video, 'it has a <video>, because that is the decoder');
    ok(sc.frame.style.display === 'none', 'and its window is never shown');
    const place = A.viewer.placement(sc, 1920, 1080);
    ok(place.w === 0 && place.h === 0, 'placement() gives it no rectangle');

    // Which the render follows for free: the spec carries that rectangle, and
    // the Write stage drops a composite nothing feeds.
    const spec = A.exporter.buildSpec();
    ok(spec.clips.length === 1 && spec.clips[0].w === 0 && spec.clips[0].h === 0,
       'so the spec sends no rectangle for it either');

    // It plays, on the media clock, with no pictures to drive anything.
    A.transport.muted = true;
    A.setPlayhead(0);
    const t0 = A.transport.t;
    A.play();
    pump(900);
    A.pause();
    pump(80);
    ok(A.transport.t > t0 + 0.2,
       `the playhead moved while it played (${t0.toFixed(3)} → ${A.transport.t.toFixed(3)})`);

    // The waveform is read and the filmstrip is not asked for at all.
    ok(waitFor('the waveform', () => !!sc.peaks, 20000), 'its waveform was analysed');
    ok(!sc.film, 'and no filmstrip was grabbed for a file with no pictures in it');
    flush();
    screenshot('out/14-sound-only.png');
}

console.log(`\n${checks} checks passed`);
