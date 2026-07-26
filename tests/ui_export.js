// Drives the export dialog the way a person does, and then opens what came
// out of it.
//
// The native test (ffmpeg-bro-exporttest) proves the renderer: geometry,
// opacity, mixing, cancellation. This proves the half above it — that the
// dialog builds a spec matching the edit on screen, that the numbers in the
// form reach the encoder, that progress arrives and finishes, and that the
// result is a file this application can open.
//
// The one thing it must never do is press "Choose…": a native save dialog
// blocks the JS thread until it is dismissed, and there is nobody at a window
// to dismiss it. The path goes into the text field instead, which is what the
// field is for.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_export.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_export.js -- <file>');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const el = (id) => document.getElementById(id);

// Anything the UI builds at runtime is found by selector, never by id.
//
// bro's id index is keyed by the id string and is not updated when a
// replacement element claims an id the index already knows, so after a redraw
// getElementById — and querySelector('#…'), which is backed by the same index
// — hands back the *previous* element: detached, measuring zero, wired to
// nothing. Classes and data attributes are matched by walking the live tree,
// so they always answer about what is actually on screen.
const q = (sel, root) => (root || document).querySelector(sel);
const qq = (sel, root) => (root || document).querySelectorAll(sel);
/// One of the Output workspace's form controls, by its data-f name.
const f = (name) => q(`#output [data-f="${name}"]`);
let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

// ── what the build says it can write ───────────────────────────────────────

console.log('\ncapabilities');
ok(Array.isArray(bro.ffmpeg.encoders) && bro.ffmpeg.encoders.length > 0,
   `${bro.ffmpeg.encoders.length} video encoders: ` +
   bro.ffmpeg.encoders.map((e) => e.id).join(' '));
ok(bro.ffmpeg.encoders.some((e) => e.id === 'libx264'), 'x264 is among them');
ok(Array.isArray(bro.ffmpeg.containers) && bro.ffmpeg.containers.length > 0,
   `${bro.ffmpeg.containers.length} containers: ` +
   bro.ffmpeg.containers.map((c) => c.ext).join(' '));
ok(typeof bro.ffmpeg.render.start === 'function' &&
   typeof bro.ffmpeg.render.poll === 'function' &&
   typeof bro.ffmpeg.render.cancel === 'function', 'render.start/poll/cancel exist');

const idle = bro.ffmpeg.render.poll();
ok(idle.state === 'idle', `nothing is running yet (${idle.state})`);

// ── load something ─────────────────────────────────────────────────────────

console.log('\nsetup');
waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
dropFiles(400, 300, [media]);
waitFor('the file to load', () => A.project.clips.length > 0);
waitFor('a decoded frame', () => A.video() && A.video().videoWidth > 0);

// Trim it short. The point is the plumbing, and rendering the whole file would
// make this a test nobody runs twice.
const clip = A.project.clips[0];
clip.length = Math.min(1.6, clip.length);
A.setPlayhead(0);
ok(clip.length > 0.5, `clip trimmed to ${clip.length.toFixed(2)}s for a quick render`);

// ── the spec matches the edit ──────────────────────────────────────────────
//
// This is the join that matters: the renderer knows nothing about fit, zoom,
// pan or grid — it gets rectangles — so the rectangles have to be the ones the
// viewer is drawing.

console.log('\nthe spec describes what is on screen');
let spec = A.exporter.buildSpec();
ok(spec.clips.length === A.project.clips.length,
   `one entry per clip (${spec.clips.length})`);
ok(spec.width === A.project.width && spec.height === A.project.height,
   `canvas size by default (${spec.width}x${spec.height})`);
ok(Math.abs(spec.end - A.project.clips.reduce(
        (d, c) => Math.max(d, c.start + c.length), 0)) < 0.001,
   `range covers the timeline (0 to ${spec.end.toFixed(3)}s)`);

// A single clip, fitted, on a canvas of its own shape: it fills the canvas.
const placed = spec.clips[0];
ok(Math.abs(placed.w - spec.width) < 2 && Math.abs(placed.h - spec.height) < 2,
   `a fitted clip fills the canvas (${placed.w.toFixed(0)}x${placed.h.toFixed(0)})`);
ok(Math.abs(placed.x) < 2 && Math.abs(placed.y) < 2,
   `and sits at the origin (${placed.x.toFixed(1)}, ${placed.y.toFixed(1)})`);

// Move the picture and the rectangle must move with it — the check that the
// spec is read from the model rather than assumed.
clip.xform.zoom = 0.5;
spec = A.exporter.buildSpec();
ok(Math.abs(spec.clips[0].w - placed.w / 2) < 2,
   `scaling the picture scales the rectangle (${spec.clips[0].w.toFixed(0)})`);
ok(spec.clips[0].x > placed.x + 1,
   'and a smaller picture is centred, not pinned to the corner');
clip.xform.zoom = 1;

// Crop travels as fractions, and opacity as itself.
clip.xform.crop.l = 0.25;
clip.xform.opacity = 0.5;
spec = A.exporter.buildSpec();
ok(Math.abs(spec.clips[0].crop.l - 0.25) < 1e-6, 'crop is carried through');
ok(Math.abs(spec.clips[0].opacity - 0.5) < 1e-6, 'opacity is carried through');
clip.xform.crop.l = 0;
clip.xform.opacity = 1;

// ── the Output workspace ───────────────────────────────────────────────────

console.log('\nthe Output workspace');
ok(!!el('btn-export'), 'there is an Export button');
ok(el('output').className.indexOf('hidden') >= 0, 'the workspace starts closed');
ok(el('ws-edit').className.indexOf('on') >= 0, 'and the Edit tab is the one lit');

el('btn-export').click();
pump(80);
ok(el('output').className.indexOf('hidden') < 0, 'clicking Export opens it');
ok(A.exporter.isOpen(), 'and the module agrees it is open');
ok(document.body.className.indexOf('ws-output') >= 0,
   'the body says which workspace is up, which is what hides the edit');
ok(el('ws-output').className.indexOf('on') >= 0 && el('ws-edit').className.indexOf('on') < 0,
   'and the tabs followed it without being clicked');
ok(!!f('path') && f('path').value.length > 0,
   `an output path is proposed (${f('path').value})`);
ok(!!f('container') && !!f('vcodec'), 'format and codec menus are there');
ok(el('ex-summary').textContent.indexOf('frames') >= 0,
   `the summary says what will be written: ` +
   el('ex-summary').textContent.replace(/\s+/g, ' ').trim());

// The picture would otherwise keep playing on a screen nobody is looking at,
// which is CPU the encoder wants.
ok(!A.transport.playing, 'opening the workspace pauses playback');

// The whole reason it is a screen: the comparison gets the window.
const stageBox = el('ex-preview').getBoundingClientRect();
ok(stageBox.width > 700,
   `the preview column is given real room (${Math.round(stageBox.width)} px wide)`);
screenshot('out/export-01-dialog.png');

// ── the controls are ffmpeg options ────────────────────────────────────────
//
// Every setting past the codec becomes a `-key value` pair applied with
// av_opt_set. That is the whole design: the sliders and the raw option editor
// are the same mechanism, so a control that does not show up in this bag is a
// control that does nothing.

console.log('\nthe controls produce ffmpeg options');
const S = A.exporter.currentSettings();

S.videoCodec = 'libx264';
S.rate = 'quality';
S.quality = 20;
S.preset = 'medium';
S.profile = '';
S.tune = '';
S.extraVideo = {};
let o = A.exporter.currentOptions();
ok(String(o.crf) === '20', `the quality control is -crf (${JSON.stringify(o)})`);
ok(o.preset === 'medium', 'and the speed control is -preset');

S.rate = 'bitrate';
S.videoBitrate = 6000;
o = A.exporter.currentOptions();
ok(o.b === '6000k' && o.crf === undefined,
   `switching to a bitrate replaces -crf with -b (${JSON.stringify(o)})`);

S.rate = 'constrained';
o = A.exporter.currentOptions();
ok(!!o.maxrate && !!o.bufsize, `a capped bitrate adds -maxrate and -bufsize (${o.maxrate}/${o.bufsize})`);

S.rate = 'lossless';
o = A.exporter.currentOptions();
ok(String(o.crf) === '0', 'lossless on x264 is -crf 0');

S.rate = 'quality';
S.profile = 'high';
S.tune = 'film';
S.gopSeconds = 2;
S.bframes = 3;
o = A.exporter.currentOptions();
ok(o.profile === 'high' && o.tune === 'film', 'profile and tune are carried');
ok(Number(o.g) > 0 && String(o.bf) === '3',
   `a keyframe interval in seconds becomes -g in frames (${o.g}) and -bf ${o.bf}`);

// The escape hatch has to beat the slider, or the person who went looking for
// the option name gets quietly overruled by a control they did not touch.
S.extraVideo = { crf: '31' };
o = A.exporter.currentOptions();
ok(String(o.crf) === '31', 'a raw option overrides the control that sets the same key');
S.extraVideo = {};
S.gopSeconds = 0;
S.bframes = -1;
S.tune = '';

// Encoders answer for themselves about what they take, so the controls offered
// have to change with the encoder rather than being x264's set for everything.
if (bro.ffmpeg.encoders.some((e) => e.id === 'prores_ks')) {
    const x264Modes = JSON.stringify(bro.ffmpeg.encoderOptions('libx264').map((x) => x.name).sort());
    const proresModes = JSON.stringify(bro.ffmpeg.encoderOptions('prores_ks').map((x) => x.name).sort());
    ok(x264Modes !== proresModes, 'a different encoder reports a different option table');
    const pro = bro.ffmpeg.encoders.find((e) => e.id === 'prores_ks');
    ok(pro.profiles.indexOf('hq') >= 0, `ProRes offers its own profiles (${pro.profiles.join(' ')})`);
    ok(!pro.crf, 'and is not offered a CRF it does not have');
}

// ── presets ────────────────────────────────────────────────────────────────

console.log('\nstarting points');
const intentButtons = q('#ex-intent-list').querySelectorAll('button[data-intent]');
ok(intentButtons.length >= 3, `${intentButtons.length} presets offered`);
{
    const hevc = q('#ex-intent-list').querySelector('button[data-intent="hevc"]');
    if (hevc) {
        hevc.click();
        pump(60);
        ok(A.exporter.currentSettings().videoCodec === 'libx265',
           'picking HEVC selects the x265 encoder');
        ok(q('#ex-intent-list').querySelector('button[data-intent="hevc"]').className.indexOf('on') >= 0,
           'and the preset shows as the one in use');
    }
    const web = q('#ex-intent-list').querySelector('button[data-intent="web"]');
    web.click();
    pump(60);
    ok(A.exporter.currentSettings().videoCodec === 'libx264' &&
       A.exporter.currentOptions().profile === 'high',
       'and going back to the web preset restores H.264 High');
}

// ── the advanced editor ────────────────────────────────────────────────────
//
// The point of this section is that nothing in it was written down here: the
// list, the types, the ranges and the help all come out of libavcodec.

console.log('\nevery option the encoder has');
f('advanced').click();
pump(60);
ok(!!f('optsearch'), 'the advanced section opens with an option search');
// Its own column, not a fold under twenty other controls: eighty options read
// through a slot are not options anyone reads.
ok(el('ex-advanced').className.indexOf('hidden') < 0 &&
   el('ex-advanced').querySelectorAll('[data-f="optsearch"]').length === 1,
   'and it opens in a column of its own');

// The form is now split across two columns but it is still one form. A control
// that only gets wired up when it happens to be in the left one is a control
// that stopped working the day it moved.
{
    const full = el('ex-advanced').querySelector('button[data-seg="crange"][data-v="pc"]');
    ok(!!full, 'the colour range control moved with it');
    if (full) {
        full.click();
        pump(40);
        ok(A.exporter.currentSettings().colorRange === 'pc',
           'and a control in that column still reaches the settings');
        el('ex-advanced').querySelector('button[data-seg="crange"][data-v="tv"]').click();
        pump(40);
    }
}

f('optsearch').value = 'aq-mode';
f('optsearch').dispatchEvent(new Event('input'));
pump(60);
const optRows = el('ex-advanced').querySelectorAll('.ex-opt-row');
ok(optRows.length >= 1, `searching finds matching options (${optRows.length} for "aq-mode")`);
// Re-queried each time rather than held: setting an option redraws the form,
// so a reference kept across that is a reference to an element that is no
// longer on screen — and a test that drives one is not driving the app.
const aqOption = () => el('ex-advanced').querySelector('[data-opt="aq-mode"]');
ok(!!aqOption(), 'including the one that was searched for');
if (aqOption()) {
    // aq-mode is an enum in libavcodec, so the control is a menu of the names
    // it declared — picking one of those rather than inventing a number is
    // both what a person does and the only thing a <select> accepts.
    const choices = bro.ffmpeg.encoderOptions('libx264')
        .find((x) => x.name === 'aq-mode').values.map((v) => v.name);
    ok(choices.length > 1, `and knows its named values (${choices.join(' ')})`);
    const pick = choices[1];
    aqOption().value = pick;
    aqOption().dispatchEvent(new Event('change'));
    pump(60);
    ok(String(A.exporter.currentOptions()['aq-mode']) === pick,
       `setting one puts it in what the encoder is told (-aq-mode ${pick})`);
    ok(A.exporter.buildSpec().videoOptions['aq-mode'] === pick,
       'and it survives into the spec the renderer is handed');
    ok(aqOption().value === pick, 'and the redrawn control shows it');
    // Left set, this would be applied to every render below.
    aqOption().value = '';
    aqOption().dispatchEvent(new Event('change'));
    pump(60);
    ok(A.exporter.currentOptions()['aq-mode'] === undefined, 'clearing it takes it back out');
}
f('optsearch').value = '';
f('optsearch').dispatchEvent(new Event('input'));
pump(40);
screenshot('out/export-01b-advanced.png');
// The form redraws on its own when this is toggled, without the summary. The
// filename beside "Choose…" belongs to the form and used to come back blank.
ok(q('#ex-settings .ex-dir').textContent.length > 0,
   `the form redraws complete on its own (${q('#ex-settings .ex-dir').textContent})`);
f('advanced').click();
pump(40);

// ── warnings ───────────────────────────────────────────────────────────────
//
// The failures worth catching are the ones that produce a valid file that is
// wrong. An encoder that refuses says so itself.

console.log('\nwhat it warns about');
{
    S.width = 641;
    S.height = 361;
    S.pixelFormat = 'yuv420p';
    A.exporter.buildSpec();
    f('container').dispatchEvent(new Event('change'));   // forces a redraw
    pump(60);
    ok(el('ex-summary').textContent.indexOf('even dimensions') >= 0,
       'an odd size with 4:2:0 chroma is called out before the encoder refuses it');
    S.pixelFormat = '';
    S.width = A.project.width;
    S.height = A.project.height;
}

// ── the range ──────────────────────────────────────────────────────────────

console.log('\nwriting part of the timeline');
{
    const total = A.project.clips.reduce((d, c) => Math.max(d, c.start + c.length), 0);
    S.rangeIn = total * 0.25;
    S.rangeOut = total * 0.75;
    const partial = A.exporter.buildSpec();
    ok(Math.abs(partial.start - total * 0.25) < 0.01 &&
       Math.abs(partial.end - total * 0.75) < 0.01,
       `in and out points reach the renderer (${partial.start.toFixed(2)}–${partial.end.toFixed(2)})`);
    ok(!!q('#ex-strip .ex-strip'), 'and the range strip is drawn');

    // An out point kept from a longer timeline must not survive onto a shorter
    // one, or the first render after loading a new project writes nothing.
    S.rangeOut = total * 10;
    ok(Math.abs(A.exporter.range().end - total) < 0.01,
       'an out point past the end is the end');
    S.rangeIn = 0;
    S.rangeOut = 0;
}

// ── set it up and go ───────────────────────────────────────────────────────

console.log('\nrendering');
const outPath = bro.appDir + '/../out/ui-export.mp4';
f('path').value = outPath;
f('path').dispatchEvent(new Event('change'));

// Small, so this is a test and not a coffee break.
f('w').value = '320';
f('h').value = '180';
f('w').dispatchEvent(new Event('change'));
pump(40);
ok(el('ex-summary').textContent.indexOf('320') >= 0,
   'the summary follows the size that was typed');

const fpsSel = f('fps');
fpsSel.value = '25';
fpsSel.dispatchEvent(new Event('change'));
pump(20);

el('ex-go').click();
pump(60);
ok(A.exporter.isRunning(), 'the render started');
ok(el('ex-progress').className.indexOf('hidden') < 0, 'the progress panel replaced the form');
// Not just visible — filled in. An exception inside the first draw leaves an
// empty panel behind a passing "it is not hidden", which is exactly how the
// first version of this shipped a broken opening frame.
ok(el('ex-progress').textContent.trim().length > 0 &&
   el('ex-progress').querySelector('.ex-bar') !== null,
   'and it drew a progress bar on the frame the render started');

waitFor('the render to finish', () => {
    const s = A.exporter.lastStatus();
    return s && s.state !== 'running';
}, 60000);

const done = A.exporter.lastStatus();
ok(done.state === 'done', `it finished (${done.state}${done.error ? ': ' + done.error : ''})`);
ok(done.frames === done.totalFrames && done.frames > 10,
   `every frame was written (${done.frames} of ${done.totalFrames})`);
ok(done.bytes > 1024, `the file has bytes in it (${done.bytes})`);
// "Stop" left under a finished green bar reads as though it is still running.
ok(el('ex-cancel').textContent === 'Close',
   `the Stop button goes back to Close when it is over (${el('ex-cancel').textContent})`);
ok(el('ex-progress').textContent.indexOf('00:00:00') < 0,
   'a sub-second render does not report taking no time at all');
console.log(`        ${done.fps.toFixed(1)} fps, ${done.elapsed.toFixed(2)}s wall`);
flush();
screenshot('out/export-02-done.png');

// ── and the result is real ─────────────────────────────────────────────────

console.log('\nwhat came out');
const p = bro.ffmpeg.probe(outPath);
ok(!!p.video, 'the output probes as media with a video track');
ok(p.video.width === 320 && p.video.height === 180,
   `at the size that was asked for (${p.video.width}x${p.video.height})`);
ok(Math.abs(p.video.fps - 25) < 0.01, `at the frame rate that was asked for (${p.video.fps})`);
ok(Math.abs(p.format.duration - clip.length) < 0.25,
   `as long as the timeline (${p.format.duration.toFixed(2)}s vs ${clip.length.toFixed(2)}s)`);
ok(p.video.codec === 'h264', `encoded with the chosen codec (${p.video.codec})`);

// ── it can be brought back in ──────────────────────────────────────────────

console.log('\nback onto the timeline');
const before = A.project.clips.length;
const importBtn = f('import');
ok(!!importBtn, 'the finished panel offers to add it to the timeline');
importBtn.click();
waitFor('the export to load as a clip', () => A.project.clips.length > before);
const added = A.project.clips[A.project.clips.length - 1];
ok(added.width === 320 && added.height === 180,
   `it opened as a ${added.width}x${added.height} clip`);
ok(el('output').className.indexOf('hidden') >= 0, 'and the workspace closed behind it');
ok(el('ws-edit').className.indexOf('on') >= 0, 'putting you back on the edit');

// ── the preview ────────────────────────────────────────────────────────────
//
// Two renders of the same seconds — one at the chosen settings, one lossless —
// so the cost of a setting can be looked at instead of guessed. This exercises
// the chain, which is the part with a race in it: the second render starts the
// instant the first reports done.

console.log('\nthe A/B preview');
{
    el('btn-export').click();
    pump(80);
    const P = A.exporter.currentSettings();
    P.previewLength = 1;
    P.width = 320;
    P.height = 180;
    P.rate = 'quality';
    P.quality = 30;
    A.exporter.previewState().at = 0;

    const goPv = q('#ex-pv-controls .pv-render');
    ok(!!goPv, 'the preview offers to render');
    goPv.click();
    pump(60);
    ok(A.exporter.isRunning(), 'the reference render started');

    waitFor('both halves of the preview', () => A.exporter.previewState().candReady ||
                                                A.exporter.previewState().error, 90000);
    const pv = A.exporter.previewState();
    ok(!pv.error, `no error along the way (${pv.error || 'none'})`);
    ok(pv.refReady && pv.candReady,
       'the lossless reference and the candidate both rendered');
    ok(!!pv.stats && pv.stats.bytes > 0,
       `and the candidate was measured (${pv.stats ? pv.stats.bytes : 0} bytes ` +
       `for ${pv.stats ? pv.stats.seconds : 0}s)`);

    pump(300);
    ok(!!q('#ex-pv-stage-host .pv-ref') && !!q('#ex-pv-stage-host .pv-cand'), 'both are on screen');
    // The wipe only means anything if the two pictures are on the same pixels;
    // sized to their own boxes, the encoded half would be a squashed copy.
    ok(q('#ex-pv-stage-host .pv-ref').style.width === q('#ex-pv-stage-host .pv-cand').style.width &&
       q('#ex-pv-stage-host .pv-ref').style.width.length > 0,
       `and laid out on identical pixels (${q('#ex-pv-stage-host .pv-ref').style.width})`);
    screenshot('out/export-03-preview.png');

    // The measured size is worth more than any estimate, so it becomes the
    // one the summary quotes.
    ok(el('ex-summary').textContent.indexOf('measured') >= 0,
       'the summary quotes the measured size for the whole render');

    // ── playing it ─────────────────────────────────────────────────────────
    //
    // A still frame is not enough to judge an encode by: banding crawls,
    // grass smears, and both only show in motion. The two halves have to run
    // together to the frame, or the wipe shows the movement between them
    // rather than what the encoder did.

    const rv = q('#ex-pv-stage-host .pv-ref'), cv = q('#ex-pv-stage-host .pv-cand');
    ok(!rv.paused && !cv.paused, 'both halves are playing');
    const t0 = cv.currentTime;
    pump(500);
    ok(cv.currentTime > t0, `and getting on with it (${t0.toFixed(2)} → ${cv.currentTime.toFixed(2)})`);

    // A frame at the preview's rate. Anything looser and the comparison is
    // between two different moments.
    let worst = 0;
    for (let i = 0; i < 6; i++) {
        pump(120);
        worst = Math.max(worst, Math.abs(rv.currentTime - cv.currentTime));
    }
    ok(worst <= 1 / 25 + 1e-6,
       `the two stay inside a frame of each other (worst ${(worst * 1000).toFixed(0)} ms)`);

    // The timecode is the edit's, not the little file's: the frame on screen
    // is one you can go back and find on the timeline.
    const shown = q('#ex-pv-controls .pv-time').textContent;
    ok(shown.indexOf('00:00:0') === 0, `the position is shown as timeline timecode (${shown.trim()})`);
    ok(q('#ex-strip .ex-strip-head').className.indexOf('hidden') < 0,
       'and marked on the range strip');

    // Space is play/pause here, not playback of a timeline nobody can see.
    A.exporter.togglePreviewPlay();
    pump(80);
    ok(cv.paused && rv.paused && !A.exporter.previewState().playing, 'Space stops it');

    // Dragging the scrub bar, through the real hit-testing pipeline. Also
    // where the stepping below starts from: a step at the last frame is a step
    // that correctly refuses to move, which proves nothing either way.
    {
        const bar = q('#ex-pv-controls .ex-pv-scrub').getBoundingClientRect();
        const at = (f) => { mouseDown(bar.left + bar.width * f, bar.top + bar.height / 2);
                            mouseUp(bar.left + bar.width * f, bar.top + bar.height / 2); };
        at(0.5);
        pump(200);
        ok(Math.abs(cv.currentTime - cv.duration * 0.5) < cv.duration * 0.1,
           `scrubbing goes where it was pointed (${cv.currentTime.toFixed(2)} of ${cv.duration.toFixed(2)})`);
        ok(Math.abs(rv.currentTime - cv.currentTime) < 1e-3, 'with both halves together');
    }

    const held = cv.currentTime;
    A.exporter.stepPreviewBy(1);
    pump(120);
    ok(cv.currentTime > held, `a frame step moves on (${held.toFixed(3)} → ${cv.currentTime.toFixed(3)})`);
    ok(Math.abs(rv.currentTime - cv.currentTime) < 1e-3,
       'and lands both halves on exactly the same frame');
    A.exporter.stepPreviewBy(-1);
    pump(120);
    ok(Math.abs(cv.currentTime - held) < 1e-3,
       `and steps back to where it started (${cv.currentTime.toFixed(3)} vs ${held.toFixed(3)})`);

    screenshot('out/export-03b-playing.png');
    A.exporter.togglePreviewPlay();
    pump(60);

    // Changing the quality does not change the picture the encoder was given,
    // so a second preview only has to redo the candidate. Re-rendering the
    // reference every time would double the wait for no reason.
    const key = pv.refKey;
    P.quality = 20;
    A.exporter.currentOptions();
    f('container').dispatchEvent(new Event('change'));
    pump(60);
    ok(A.exporter.previewState().refReady && !A.exporter.previewState().candReady,
       'changing the quality invalidates the candidate but keeps the reference');
    ok(A.exporter.previewState().refKey === key, 'because the reference is of the same frames');

    // Changing the output size does change them.
    P.width = 640; P.height = 360;
    f('container').dispatchEvent(new Event('change'));
    pump(60);
    ok(!A.exporter.previewState().refReady,
       'changing the output size invalidates the reference too');

    ok(!A.exporter.isRunning(), 'and nothing is left running');
    el('ws-edit').click();
    pump(40);
    ok(!A.exporter.isOpen(), 'the Edit tab goes back afterwards');
    ok(document.body.className.indexOf('ws-output') < 0, 'and the edit is on screen again');
}

// ── stopping one ───────────────────────────────────────────────────────────
//
// A render that cannot be stopped is a render nobody starts on a long
// timeline.

console.log('\nstopping a render');
{
    // Something long enough to interrupt: the whole file, slowly.
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(60);
    A.open(media);
    waitFor('the file to reload', () => A.project.clips.length === 1);

    el('btn-export').click();
    pump(60);
    f('path').value = bro.appDir + '/../out/ui-export-stopped.mp4';
    f('path').dispatchEvent(new Event('change'));
    el('ex-go').click();
    pump(200);
    ok(A.exporter.isRunning(), 'a long render is under way');

    el('ex-cancel').click();
    waitFor('it to stop', () => {
        const s = A.exporter.lastStatus();
        return s && s.state !== 'running';
    }, 20000);
    const stopped = A.exporter.lastStatus();
    ok(stopped.state === 'cancelled', `Stop stopped it (${stopped.state})`);
    ok(stopped.frames < stopped.totalFrames,
       `part way through (${stopped.frames} of ${stopped.totalFrames})`);

    const partial = bro.ffmpeg.probe(bro.appDir + '/../out/ui-export-stopped.mp4');
    ok(!!partial.video, 'and what it wrote is still openable');
    ok(A.exporter.isOpen(), 'the workspace stays up to say so');
    el('ws-edit').click();
    pump(40);
    ok(!A.exporter.isOpen(), 'leaving works once the render is not running');
}

// ── and the edit is still there ────────────────────────────────────────────
//
// The workspaces hide each other rather than tearing each other down, which is
// only worth doing if what comes back is what was left. A viewer measuring
// zero, or a timeline drawn while it was off screen, would come back blank.

console.log('\nback on the edit');
pump(200);
{
    const stage = document.getElementById('stage').getBoundingClientRect();
    ok(stage.width > 100 && stage.height > 100,
       `the picture is laid out again (${Math.round(stage.width)}x${Math.round(stage.height)})`);
    const lane = A.timeline.laneWidthPx();
    ok(lane > 100, `and the timeline has its width back (${Math.round(lane)} px)`);
    ok(A.video() !== null, 'with the clip still loaded in its own <video>');
    screenshot('out/export-04-back-on-the-edit.png');
}

console.log(`\n${checks} checks passed`);
