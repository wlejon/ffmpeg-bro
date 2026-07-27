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

// Anything the UI builds at runtime is found by selector, never by id —
// because it does not have an id to be found by. Several of these controls
// exist at once (both halves of the preview, a form drawn twice for two
// codecs), and a `data-f` name says which control it is without having to
// invent a unique id for each instance. Selecting the way the app labels
// things is also what makes a test fail when the label changes, rather than
// quietly matching something else.
const q = (sel, root) => (root || document).querySelector(sel);
const qq = (sel, root) => (root || document).querySelectorAll(sel);
/// One of the encode side's form controls, by its data-f name. Searched
/// across the document rather than under one section: the controls now live on
/// two stages — what the picture is put through, and where it goes — and a
/// data-f name is unique whichever stage is holding it.
const f = (name) => q(`[data-f="${name}"]`);
let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

/// Prints both sides before it fails, because "expected 8, got 1" is the whole
/// of the diagnosis and `assert(a === b)` throws it away.
function same(actual, expected, what) {
    if (actual !== expected) {
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
    }
    ok(actual === expected, what);
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

// What the file says its colour is. Reported verbatim and left empty when the
// file says nothing, because "untagged" and "BT.601" are different facts and
// only the point of use is entitled to turn the first into the second. The
// equivalent filtergraph needs these: rendering one edit both ways and
// measuring put the difference between naming every conversion and leaving
// them to swscale at 24.1 dB against 39.1 dB, which is a colour cast rather
// than noise.
{
    const v = clip.probe.video;
    const tags = ['colorSpace', 'colorRange', 'colorPrimaries', 'colorTransfer'];
    ok(tags.every((k) => typeof v[k] === 'string'),
       `probe reports the colour tags (${tags.map((k) => `${k}=${v[k] || '—'}`).join(' ')})`);
    ok(v.colorSpace !== 'unspecified' && v.colorRange !== 'unknown',
       'an untagged stream reads as empty rather than as a word that looks like a value');
}

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

// ── the Encode stage ───────────────────────────────────────────────────────
//
// Four stages over one project, and the spine is both the map and the way
// through. Which one is up is a property of the window, so it is asserted on
// the window rather than on a module's idea of itself.

console.log('\nthe Encode stage');
ok(!!el('btn-export'), 'there is an Export button');
ok(A.shell.currentStage() === 'compose', 'the edit is where you start');
ok(el('st-encode').className.indexOf('hidden') >= 0, 'and Encode is not on screen');

el('btn-export').click();
pump(80);
ok(A.shell.currentStage() === 'encode', 'clicking Export goes to Encode');
ok(el('st-encode').className.indexOf('hidden') < 0, 'which is now the stage on screen');
ok(el('st-compose').className.indexOf('hidden') >= 0, 'and the edit is not');
ok(A.exporter.isOpen(), 'and the module agrees it is up');
ok(document.body.className.indexOf('stage-encode') >= 0,
   'the body says which stage is up, for the chrome that has an opinion about it');
ok(q('#spine [data-stage="encode"]').className.indexOf('on') >= 0,
   'and the spine followed without being clicked');

// The destination belongs to Write. Encode is what the picture is put
// through; a filename at the top of that column was the first thing asked for
// and the last thing decided.
ok(!!q('#st-encode [data-f="vcodec"]') && !!q('#st-encode [data-f="quality"]'),
   'the codec and its quality are on this stage');
ok(!q('#st-encode [data-f="path"]') && !!q('#st-write [data-f="path"]'),
   'and the destination is on the next one');

A.shell.goTo('write');
pump(80);
ok(!!f('path') && f('path').value.length > 0,
   `Write proposes an output path (${f('path').value})`);
ok(!!f('container'), 'and the container menu');
ok(el('ex-summary').textContent.indexOf('frames') >= 0,
   `it states what will be written: ` +
   el('ex-summary').textContent.replace(/\s+/g, ' ').trim());
A.shell.goTo('encode');
pump(40);

// The picture would otherwise keep playing on a stage nobody is looking at,
// which is CPU the encoder wants.
ok(!A.transport.playing, 'leaving the edit pauses playback');

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
// filename beside "Choose…" belongs to the form and used to come back blank —
// and it is drawn onto the Write stage now, so a redraw triggered from Encode
// has to reach a pane that is not on screen.
ok(q('#ex-dest .ex-dir').textContent.length > 0,
   `the form redraws complete on its own, across both stages ` +
   `(${q('#ex-dest .ex-dir').textContent})`);
f('advanced').click();
pump(40);

// ── the command bar ────────────────────────────────────────────────────────
//
// The application's argument is that ffmpeg should stop being a thing you
// guess at, and that argument is not made by a friendly form — every ffmpeg
// GUI has one. It is made by never hiding the invocation. So the thing worth
// testing is that the printed command and the render cannot drift: every key
// the encoder is told must appear, and it must appear with the value the
// encoder was told.

console.log('\nthe command says what will happen');
{
    S.videoCodec = 'libx264';
    S.rate = 'quality';
    S.quality = 22;
    S.preset = 'slow';
    S.extraVideo = {};
    f('container').dispatchEvent(new Event('change'));
    pump(60);

    const text = A.command.currentCommand();
    ok(text.indexOf('ffmpeg ') === 0, 'it is an ffmpeg command');
    ok(text.indexOf('-c:v libx264') > 0, `the codec is named (${text.slice(0, 40)}…)`);

    // Key for key against what the encoder is actually handed. A command that
    // is missing an option describes a different render from the one the
    // preview measured, and looks entirely plausible while doing it.
    //
    // A key an audio encoder also has is printed `-key:v`, because unqualified
    // it would mean every stream: the render has one context per stream and no
    // ambiguity to resolve, and a printed command has to resolve it out loud.
    const opts = A.exporter.currentOptions();
    for (const k of Object.keys(opts))
        ok(text.indexOf(`-${k} ${opts[k]}`) > 0 || text.indexOf(`-${k}:v ${opts[k]}`) > 0,
           `-${k} ${opts[k]} reaches the command, as it reaches the encoder`);

    // And the collision itself: a bitrate render prints -b:v beside -b:a, never
    // a bare -b that would mean both of them.
    S.rate = 'bitrate';
    S.videoBitrate = 6000;
    f('container').dispatchEvent(new Event('change'));
    pump(60);
    const bitrateText = A.command.currentCommand();
    ok(bitrateText.indexOf('-b:v 6000k') > 0,
       'the video bitrate says which stream it belongs to');
    ok(!/ -b \d/.test(bitrateText),
       'and never as a bare -b, which would claim the audio stream as well');
    S.rate = 'quality';
    f('container').dispatchEvent(new Event('change'));
    pump(60);

    // Three things the renderer applies that are *not* in the option bag. They
    // are named fields on the spec, so a command built from the bag alone is
    // quietly incomplete — and each one changes the file.
    ok(/-colorspace \S+ -color_primaries \S+ -color_trc \S+ -color_range \S+/.test(text),
       'the colour tags are there, which the option bag does not carry');
    ok(/ -g \d+/.test(text),
       'and the keyframe interval, which defaults to two seconds here and to 250 in x264');

    // The two halves have to be distinguishable on screen, or the exact part
    // and the translated part read as one claim.
    A.shell.goTo('encode');
    pump(40);
    el('cmd-toggle').click();
    pump(60);
    ok(!!q('#cmd-line .cmd-exact') && !!q('#cmd-line .cmd-equiv'),
       'the exact half and the equivalent half are drawn apart');
    ok(q('#cmd-line .cmd-equiv').textContent.indexOf('overlay=') > 0,
       'the composition is the half marked as a translation');
    ok(q('#cmd-line .cmd-note').textContent.indexOf('av_opt_set') > 0,
       'and the note says which half is which');
    el('cmd-toggle').click();
    pump(40);

    // A graph it cannot express faithfully must produce no graph rather than a
    // wrong one: the only reason to print a command is that it can be run.
    const graph = A.filtergraph(A.exporter.buildSpec());
    ok(graph.ok, 'the current edit can be described');
    ok(graph.chains.join(';').indexOf('amix') < 0 || A.project.clips.length > 1,
       'and a single clip needs no mixer');

    // Put back what this section moved. The script is straight-line and later
    // sections stand on the state earlier ones leave. `slow` in particular is
    // not neutral to leave behind: with it set, the cancellation check further
    // down stopped a render after 24 of 200 frames and the file it left would
    // not open — which is the one thing that section exists to disprove. Why
    // that happens at one preset and not another is not established here; what
    // is established is that this section must not decide it.
    S.quality = 20;
    S.preset = 'medium';
    f('container').dispatchEvent(new Event('change'));
    pump(40);
}

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
    // Warnings belong to the stage that caused them now, not to a blob under a
    // form — they are on Write, beside the statement of what is about to
    // happen, and they light the spine's card from wherever you are standing.
    ok(el('ex-warnings').textContent.indexOf('even dimensions') >= 0,
       'an odd size with 4:2:0 chroma is called out before the encoder refuses it');
    ok(q('#spine [data-stage="write"]').className.indexOf('warn') >= 0,
       'and the spine marks the stage it belongs to');
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
ok(el('ex-cancel').textContent === 'Back',
   `the Stop button goes back to Back when it is over (${el('ex-cancel').textContent})`);
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
ok(A.shell.currentStage() === 'compose',
   'and it put you back on the edit, which is the fastest way to see what you made');
ok(el('st-compose').className.indexOf('hidden') < 0, 'with the timeline on screen again');

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
    // Back along the chain by clicking the spine, which is the navigation as
    // well as the diagram.
    q('#spine [data-stage="compose"]').click();
    pump(40);
    ok(!A.exporter.isOpen(), 'clicking Compose on the spine goes back');
    ok(document.body.className.indexOf('stage-compose') >= 0, 'and the edit is on screen again');
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
    A.shell.goTo('write');
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
    ok(A.exporter.isOpen(), 'the stage stays up to say so');
    // A render holds the host's one job slot and Stop is the way out of one, so
    // the spine refuses the door with a reason rather than offering one that
    // will not open. Now that it has stopped, it opens.
    q('#spine [data-stage="compose"]').click();
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

// ── and the same edit, rendered through libavfilter ────────────────────────
//
// The other end of the graph work: `renderGraph()` produces the same graph the
// command bar prints, and `render.start` runs it through libavfilter instead of
// the internal compositor. export_test.cpp is what proves the two paths make
// the same picture; what is proved here is that the graph this application
// *writes* is one libavfilter will take — a string that renders in C++ says
// nothing about the string the UI produces.

console.log('\nthe same edit, through libavfilter');
{
    ok(Array.isArray(bro.ffmpeg.filters) && bro.ffmpeg.filters.length > 100,
       `libavfilter's own filter list is exposed (${bro.ffmpeg.filters.length})`);
    ok(bro.ffmpeg.filterOptions('scale').some((o) => o.name === 'in_color_matrix'),
       'and each one can be asked what arguments it takes');

    const s = A.exporter.buildSpec();
    s.width = 320;
    s.height = 180;
    s.fps = 25;
    s.end = Math.min(s.end, s.start + 1);       // a test, not a coffee break
    s.path = bro.appDir + '/../out/ui-export-graph.mp4';

    const g = A.renderGraph(s, A.exporter.specSources());
    ok(g.ok, `the edit can be written as a graph to run (${g.reason || 'ok'})`);
    ok(g.filterInputs.length > 0 &&
       g.filterInputs.every((i) => i.path && i.label && i.stream),
       `every pad it reads names its file (${g.filterInputs.map((i) => i.label).join(' ')})`);
    // The tail belongs to the writer on this path, and a graph carrying it
    // would convert into the encoder's colour twice.
    ok(g.filterGraph.indexOf('out_color_matrix') < 0,
       'and it stops in the compositing space');

    s.filterGraph = g.filterGraph;
    s.filterInputs = g.filterInputs;
    let started = '';
    try { bro.ffmpeg.render.start(s); } catch (e) { started = String(e); }
    ok(!started, `the renderer accepted it (${started || 'accepted'})`);

    if (!started) {
        waitFor('the graph render to finish',
                () => bro.ffmpeg.render.poll().state !== 'running', 60000);
        const st = bro.ffmpeg.render.poll();
        ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);

        const gp = bro.ffmpeg.probe(s.path);
        ok(!!gp.video && gp.video.width === 320 && gp.video.height === 180,
           `and wrote a ${gp.video ? gp.video.width + 'x' + gp.video.height : 'broken'} file`);
        ok(Math.abs(gp.format.duration - (s.end - s.start)) < 0.25,
           `as long as the range asked for (${gp.format.duration.toFixed(2)}s)`);
    }
}

// ── a filter put on the graph by hand ──────────────────────────────────────
//
// The other half of that: not a graph handed to `render.start` by a test, but
// one a person made by clicking a + on a wire and picking a filter out of
// libavfilter's own list. What has to be true afterwards is that the filter is
// in the spec the application builds without being asked, that the picture it
// produces is different from the one without it, and that the command bar stops
// calling itself a translation — because on this path it is not one.

console.log('\na filter inserted on the graph');
{
    A.graph.overlay.clear();
    q('#spine [data-stage="graph"]').click();
    pump(300);

    const clipId = A.project.clips[0].id;
    const plus = qq('#gr-nodes .gp-plus');
    ok(plus.length >= 3, `every wire that can take a filter offers one (${plus.length} points)`);
    const at = q(`#gr-nodes [data-point="clip:${clipId}/after-scale"]`);
    ok(!!at, 'including the one after the clip is sized, in the compositing space');

    at.click();
    pump(60);
    ok(!!f('filtersearch'), 'clicking it opens the palette');
    ok(qq('#gr-panel .gp-filter').length > 5,
       'which offers somewhere to start rather than an empty box');

    // Searched by name, out of the whole list this build has — the palette is
    // libavfilter's table, not one written down here.
    f('filtersearch').value = 'hflip';
    f('filtersearch').dispatchEvent(new Event('input'));
    pump(40);
    const choice = q('#gr-panel [data-filter="hflip"]');
    ok(!!choice, 'and finds one by name');
    choice.click();
    pump(120);

    ok(qq('#gr-nodes .gn-user').length === 1, 'the node appears on the graph as yours');
    // Inserting and configuring are one gesture with a pause in it, so what the
    // palette leaves behind is the new node, selected.
    ok(!!q('#gr-panel [data-f="remove"]'), 'and the panel is now about it');
    ok(q('#gr-panel .gp-name').textContent === 'hflip', 'by name');

    // The point of all of it: nobody had to ask for the graph path. A render
    // with a filter of your own in it goes through libavfilter, and the spec
    // the application builds says so.
    const s = A.exporter.buildSpec();
    ok(typeof s.filterGraph === 'string' && s.filterGraph.indexOf('hflip') > 0,
       'the spec the application builds carries the graph, unasked');
    ok(s.filterInputs && s.filterInputs.length > 0, 'and the files its pads read');
    ok(A.command.currentCommand().indexOf('hflip') > 0,
       'the command bar prints the filter it is about to run');

    // The clip is marked in the viewer, because playback decodes through
    // <video> and has no filter path — an unmarked picture would read as the
    // filter not working.
    ok(qq('#viewer .clipframe.filtered').length >= 1,
       'and the picture says it is not showing what will be rendered');

    screenshot('out/export-05-graph-with-a-filter.png');

    // And it renders. Small and short: what is being proved is that the graph
    // this UI wrote is one libavfilter takes, not that x264 works.
    const r = A.exporter.buildSpec({
        width: 320, height: 180, fps: 25,
        end: Math.min(A.exporter.buildSpec().end, A.exporter.buildSpec().start + 1),
        path: bro.appDir + '/../out/ui-export-inserted.mp4',
    });
    ok(r.filterGraph.indexOf('hflip') > 0, 'a preview-sized spec carries it too');
    let started = '';
    try { bro.ffmpeg.render.start(r); } catch (e) { started = String(e); }
    ok(!started, `the renderer accepted it (${started || 'accepted'})`);
    if (!started) {
        waitFor('the inserted-filter render to finish',
                () => bro.ffmpeg.render.poll().state !== 'running', 60000);
        const st = bro.ffmpeg.render.poll();
        ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
        const p = bro.ffmpeg.probe(r.path);
        ok(!!p.video && p.video.width === 320, 'and wrote a file with the filter in it');
    }
}

// ── a lock, and everything that has to say so ──────────────────────────────

console.log('\na value typed into the graph outranks the edit');
{
    const clipId = A.project.clips[0].id;
    const node = q(`#gr-nodes [data-key="clip:${clipId}/scale"]`);
    ok(!!node, 'the scale node can be picked out by what it is');
    node.click();
    pump(60);
    const w = q('#gr-panel [data-pos="0"]');
    ok(!!w, 'its arguments are editable, named the way the derivation wrote them');

    w.value = '96';
    w.dispatchEvent(new Event('change'));
    pump(120);

    ok(A.graph.overlay.isLocked(`clip:${clipId}/scale`), 'typing in one locks the node');
    ok(A.command.currentCommand().indexOf('scale=96:') > 0,
       'the value reaches the command');
    ok(A.graph.summary().locks === 1, 'and the stage counts it');
    screenshot('out/export-06-a-locked-node.png');

    // The edit still applies to everything else, and the control it took over
    // says so where somebody is about to drag it.
    ok(!!A.graph.outranked()[String(clipId)],
       'the application can say which of the panel’s controls it outranks');
    A.select(A.project.clips[0]);
    A.showProperties();
    pump(40);
    ok(!!q('#transform .row.outranked'),
       'and the properties panel marks the one that has stopped applying');

    // Handed back, everything goes with it — including the command, which is
    // the thing that would be quietly wrong if unlocking were only a change to
    // the model.
    const unlock = q('#gr-panel [data-f="unlock"]');
    ok(!!unlock, 'the panel offers it back');
    unlock.click();
    pump(120);
    ok(!A.graph.overlay.isLocked(`clip:${clipId}/scale`), 'unlocking gives it back');
    ok(A.command.currentCommand().indexOf('scale=96:') < 0,
       'and the derivation is in charge of it again');

    A.graph.overlay.clear();
    q('#spine [data-stage="compose"]').click();
    pump(120);
}

// ── and each node showing what it produces ─────────────────────────────────
//
// The previews are renders, so this is the only place they can be checked: the
// subgraph text is proved in ui_graph.js, and what is proved here is that
// libavfilter takes it, that a file comes out, and that the card ends up with a
// picture in it at the size the card is.

console.log('\nwhat each node produces');
{
    q('#spine [data-stage="graph"]').click();
    pump(400);
    ok(A.graph.preview.isEnabled(), 'previews are on by default');

    waitFor('the node previews to render',
            () => A.graph.preview.outstanding() === 0, 90000);
    pump(600);

    const cards = qq('#gr-nodes .gn');
    const shots = qq('#gr-nodes .gn-shot');
    const videos = qq('#gr-nodes .gn-shot video');
    const failed = qq('#gr-nodes .gn-shot-fail');
    ok(shots.length >= 5, `every picture-side node gets one (${shots.length} of ${cards.length})`);
    ok(failed.length === 0,
       `and none of them failed${failed.length ? ': ' + failed[0].textContent : ''}`);
    // A `<video>` per card, and the same count as boxes — this is the check
    // that caught bro's `replaceChildren()` destroying the subtree it removes,
    // which left eight of nine cards empty with nothing in the code to see.
    same(videos.length, shots.length, 'each with its own player, kept across redraws');

    // Audio has no picture and must not pretend to. A waveform of a pad is a
    // real thing to want and it is not a smaller version of this.
    const audioCard = q('#gr-nodes [data-key$="/atrim"]');
    ok(audioCard && !audioCard.querySelector('.gn-shot'),
       'and the sound side has none, rather than a black rectangle');

    screenshot('out/export-07-node-previews.png');
}

console.log('\na node resized to the size that helps');
{
    const key = `clip:${A.project.clips[0].id}/scale`;
    const before = q(`#gr-nodes [data-key="${key}"]`).getBoundingClientRect().width;
    A.graph.overlay.setSize(key, 400);
    A.graph.draw();
    pump(200);

    const after = q(`#gr-nodes [data-key="${key}"]`).getBoundingClientRect().width;
    ok(after > before + 100, `the card is as wide as it was dragged (${before} → ${after})`);

    // A wider card is a sharper render, not a stretched one, so the preview is
    // re-rendered at the new size — which means waiting for it before asking
    // what shape it is.
    waitFor('the bigger preview', () => A.graph.preview.outstanding() === 0, 60000);
    pump(400);
    const shot = A.graph.preview.shotFor(key);
    ok(shot.state === 'ready' && shot.w > 160,
       `re-rendered at the new size (${shot.w}px wide, was 160)`);

    // The media fills the node: the box is the card's width and its height
    // follows the picture's own shape rather than a guess. Read from the styles
    // rather than from `getBoundingClientRect`, which reports screen pixels —
    // the whole container is scaled by the zoom, and comparing a scaled
    // measurement against an unscaled arithmetic is how you get a test that
    // passes at one zoom level.
    const card = q(`#gr-nodes [data-key="${key}"]`);
    same(card.style.width, '400px', 'and the card is the width it was given');
    const box = card.querySelector('.gn-shot');
    same(box.style.height, `${Math.round(((400 - 12) * shot.h) / shot.w)}px`,
         'with the picture filling it at its own aspect');

    // Neighbours move out of the way rather than being drawn over: a column is
    // as wide as its widest card.
    const next = q(`#gr-nodes [data-key="clip:${A.project.clips[0].id}/format"]`);
    ok(next.getBoundingClientRect().left > card.getBoundingClientRect().right,
       'and the column after it is pushed clear');

    A.graph.overlay.setSize(key, 0);
    A.graph.draw();
    pump(120);
}

console.log('\nturning them off');
{
    q('#gr-previews').click();
    pump(200);
    ok(!A.graph.preview.isEnabled(), 'the bar switches them off');
    same(qq('#gr-nodes .gn-shot').length, 0, 'and the cards go back to being text');
    same(A.graph.preview.outstanding(), 0, 'with nothing left queued');
    q('#gr-previews').click();
    pump(200);
    ok(A.graph.preview.isEnabled(), 'and back on again');
    A.graph.overlay.clear();
}

console.log(`\n${checks} checks passed`);
