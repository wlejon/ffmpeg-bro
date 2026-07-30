// Drives the encode side the way a person does, and then opens what came out
// of it.
//
// The native test (ffmpeg-bro-exporttest) proves the renderer: geometry,
// opacity, mixing, cancellation. This proves the half above it — that the
// stages build a spec matching the edit on screen, that the numbers in the form
// reach the encoder, that progress arrives and finishes, and that the result is
// a file this application can open.
//
// There is no export *dialog* and has not been for some time. What this drives
// is the Encode and Write stages of the spine, which are siblings of Compose
// under `#stages` and hide each other rather than unmounting — so the field
// this file types a filename into is `#st-write [data-f="path"]`, reached by
// stage and `data-f` name because nothing built at runtime carries an id.
//
// The last seven hundred lines are the **Graph stage**, and they are here
// rather than in `ui_graph.js` on purpose: that suite is about the model, the
// printer and the wiring gesture, all of which it can check with no media at
// all, while these sections are about what a graph does to a *render* — a
// filter inserted changing the picture that comes out, a value typed on a card
// outranking the edit, a node previewed and played through the real renderer.
// They need the file, the range and the export slot that the rest of this file
// has already set up.
//
// The one thing it must never do is press "Choose…": a native save dialog
// blocks the JS thread until it is dismissed, and there is nobody at a window
// to dismiss it. The path goes into the text field instead, which is what the
// field is for.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_export.js
//            -- <media-file> [<video-only file>] [<sound-only file>]
//
// The second file, if given, is one with **no audio stream in it at all** —
// which is a different file from one whose soundtrack is quiet, and is the only
// thing that separates "the mix" from "a mix nothing feeds". The third is its
// mirror, with **no video stream in it at all**, which is the only thing that
// separates the composite from a composite nothing feeds. The fourth carries a
// **data stream** — telemetry, timecode, timed metadata — which is the opposite
// question again: a stream this application had no row for rather than one it
// wrongly assumed. The last three sections are one each and are skipped
// without them.

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
const videoOnly = args[1] || '';
const soundOnly = args[2] || '';
const dataFile = args[3] || '';
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

/// A key press, the way the app hears one. Dispatched on `<body>` rather than on
/// `document` — which is where app.js listens — because this engine implements
/// `Document.addEventListener` but not `Document.dispatchEvent`. It bubbles, so
/// it arrives; a real key press takes the same route.
const key = (k, opts) =>
    document.body.dispatchEvent(
        new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opts)));

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
ok(Array.isArray(bro.ffmpeg.muxers) && bro.ffmpeg.muxers.length > 20,
   `${bro.ffmpeg.muxers.length} muxers, e.g. ` +
   bro.ffmpeg.muxers.slice(0, 10).map((m) => m.name).join(' '));
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

// ── a panel that has never been on screen measures nothing ─────────────────
//
// A stage this application has not shown yet has never been through layout, so
// everything in it reports a box of zero — and the standing rule is that a
// measurement of zero is ignored rather than laundered into a number. The
// range strip lives on the Encode stage and `prepare()` draws it for the Write
// stage too, so **going straight to Write** is exactly the case: a fallback of
// 420×62 sized the canvas to something it never is, and the paint that went
// with it was thrown away on the way to Encode.
//
// It has to be first in this suite, because the second visit to anything is a
// visit to a panel that has been laid out once and keeps its box.

console.log('\na panel that has never been on screen');
{
    const strip = el('ex-strip-c');
    ok(strip.getBoundingClientRect().width === 0,
       'the range strip measures nothing before its stage has ever been shown');
    const was = `${strip.width}x${strip.height}`;

    ok(A.shell.goTo('write'), 'the Write stage opens without going through Encode first');
    pump(160);
    same(`${strip.width}x${strip.height}`, was,
         `and the strip is not painted at a size it never has (${strip.width}x${strip.height})`);

    A.shell.goTo('encode');
    pump(160);
    ok(strip.width > 100 && strip.getBoundingClientRect().width > 100,
       `it is painted the moment it is really on screen (${strip.width}x${strip.height})`);

    A.shell.goTo('compose');
    pump(80);
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
ok(!!f('container-open'), 'and the muxer picker');
ok(el('ex-summary').textContent.indexOf('frames') >= 0,
   `it states what will be written: ` +
   el('ex-summary').textContent.replace(/\s+/g, ' ').trim());

// **The summary is written from the readers, not from the raw fields.** An
// empty `settings.audioCodec` means "whatever this container's default is",
// which for mp4 is aac — and it is empty for every render nobody has touched
// the audio codec on, because changing the container blanks it. Read
// literally, the line said the render was *silent* while a soundtrack was
// about to be written, which is the one thing this line exists to state.
{
    const S0 = A.exporter.currentSettings();
    const kept = S0.audioCodec;
    S0.audioCodec = '';
    A.exporter.redraw();
    pump(40);
    const line = el('ex-summary').textContent.replace(/\s+/g, ' ');
    ok(S0.audio && line.indexOf('silent') < 0 && line.indexOf('aac') >= 0,
       `an unset audio codec is the container's own, not silence (${line.trim()})`);
    S0.audioCodec = kept;
    A.exporter.redraw();
    pump(40);
}
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

// **The timeline's rate and the output's are two questions sharing one
// fallback**, and the fallback was written out at eight points of use in two
// different answers — 25 at the ruler, the timecode and a new clip, 30 at the
// spine, the rate menu and the spec. Nothing was ever visibly wrong, because
// `project.fps` is seeded at 25 and every clip falls back to 25 so the `|| 30`
// arms were unreachable. This is the check that says they cannot come apart if
// it ever is: one moment reading as two timecodes is the failure, and it would
// be a probe reporting no rate away.
{
    const keptProject = A.project.fps;
    const keptSetting = S.fps;
    const keptAt = A.transport.t;
    A.project.fps = 0;
    S.fps = 0;
    A.setPlayhead(Math.min(1.32, A.project.clips[0].length - 0.05), true);
    A.exporter.redraw();
    pump(120);

    const spec0 = A.exporter.buildSpec();
    const menu = Array.from(qq('[data-f="fps"] option'))[0];
    same(spec0.fps, 25, 'a timeline with no rate of its own renders at one number');
    ok(menu && menu.textContent.indexOf('25.000') >= 0,
       `and the rate menu names the same one (${menu ? menu.textContent : 'no menu'})`);

    // The transport's timecode is the reader that used to answer 25 while the
    // three above answered 30. The moment is chosen so the two families cannot
    // both be right about it, which is asserted rather than assumed — a
    // separator that happened to coincide would hide the whole thing.
    const at = A.transport.t;
    const frac = at - Math.floor(at);
    const framesAt = (rate) => Math.min(Math.floor(frac * rate), Math.ceil(rate) - 1);
    ok(framesAt(25) !== framesAt(30),
       `the playhead is somewhere the two old answers differ (${at.toFixed(3)} s: ` +
       `${framesAt(25)} at 25, ${framesAt(30)} at 30)`);
    const shown = el('tc-current').textContent;
    same(Number(shown.split(':')[3]), framesAt(spec0.fps),
         `and the timecode counts frames in the same rate the render does (${shown})`);

    A.project.fps = keptProject;
    S.fps = keptSetting;
    A.setPlayhead(keptAt, true);
    A.exporter.redraw();
    pump(40);
}

// **The spec is memoised for exactly one answer, and no longer.** `warnings()`
// used to build five of them per redraw and now builds one, which is worth
// having on a panel that redraws on every keystroke — but a memo that outlived
// a call would have to know about every place a setting is written, including
// the ones a test writes directly. So this is the check that it does not: a
// change and then a read, with no redraw in between.
{
    const wasW = S.width, wasH = S.height;
    const odd = () => A.exporter.currentWarnings().some((t) => /even dimensions/.test(t));
    S.width = 640; S.height = 360;
    ok(!odd(), 'an even output is not complained about');
    S.width = 641;
    ok(odd(), 'and the very next answer knows about a change nothing redrew for');
    S.width = wasW; S.height = wasH;
    ok(!odd(), 'and knows when it is put back');
}

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

// ── and the same column for the audio encoder ──────────────────────────────
//
// `settings.extraAudio` was declared, persisted and read on every render by
// `audioOptions()`, and nothing anywhere wrote to it: the audio encoder was the
// one option bag in this application with no column. Every other one has one —
// the video encoder's beside it, the muxer's on the Write stage, the demuxer's,
// the protocol's and the decoder's on Sources.
//
// Its own search box, because the term belongs to the *list*: `opttable.js`
// keys it by the column's name so that two columns cannot filter each other.
{
    ok(A.exporter.currentSettings().audioCodec === 'aac',
       'the audio encoder is the one the preset chose');
    ok(!!f('aoptsearch'), 'the audio encoder has an option column of its own');
    ok(f('aoptsearch') !== f('optsearch'),
       'and its own search, so the two columns do not filter each other');

    f('aoptsearch').value = 'aac_coder';
    f('aoptsearch').dispatchEvent(new Event('input'));
    pump(60);
    // Re-queried each time: setting an option redraws the form, so a reference
    // held across that is a reference to an element no longer on screen.
    const coder = () => el('ex-advanced').querySelector('[data-opt="aac_coder"]');
    ok(!!coder(), 'searching it finds an option that is aac’s and not x264’s');
    if (coder()) {
        const choices = bro.ffmpeg.encoderOptions('aac')
            .find((x) => x.name === 'aac_coder').values.map((v) => v.name);
        ok(choices.length > 1, `with its named values out of libavcodec (${choices.join(' ')})`);
        const pick = choices[choices.length - 1];
        coder().value = pick;
        coder().dispatchEvent(new Event('change'));
        pump(60);
        // The separator that matters: it has to reach the *audio* bag and the
        // *audio* half of the spec, not the video one it sits beside.
        ok(A.exporter.buildSpec().audioOptions.aac_coder === pick,
           `setting one reaches the audio encoder (-aac_coder ${pick})`);
        ok(A.exporter.buildSpec().videoOptions.aac_coder === undefined,
           'and not the video one');
        // Printed against the audio stream — `-aac_coder:a`, because unqualified
        // an option in an ffmpeg command line means every stream.
        ok(new RegExp(`-aac_coder:a\\S* ${pick}\\b`).test(A.command.currentCommand()),
           'and the command bar prints it against the audio stream');
        // Left set, this would be applied to every render below.
        coder().value = '';
        coder().dispatchEvent(new Event('change'));
        pump(60);
        ok(A.exporter.buildSpec().audioOptions.aac_coder === undefined,
           'clearing it takes it back out');
    }
    f('aoptsearch').value = '';
    f('aoptsearch').dispatchEvent(new Event('input'));
    pump(40);
}

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
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
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
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
    pump(60);
    const bitrateText = A.command.currentCommand();
    ok(bitrateText.indexOf('-b:v 6000k') > 0,
       'the video bitrate says which stream it belongs to');
    ok(!/ -b \d/.test(bitrateText),
       'and never as a bare -b, which would claim the audio stream as well');
    S.rate = 'quality';
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
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
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
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
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));   // forces a redraw
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

// ── the Write stage is the stream list ─────────────────────────────────────
//
// A file is not a picture and a soundtrack, it is a list of streams the muxer
// numbers, and everything this application could not say — a second audio
// track, a language, a forced flag, a fourcc, a font travelling inside the
// file — followed from that list not existing. So the checks here are: that
// the usual two arrive without anybody asking, that a row can be added and
// taken away, that what a row says reaches the renderer, and that the command
// bar prints every one of them. Anything reaching the muxer the bar does not
// print is a bug, and this is where it would be caught.

console.log('\nthe Write stage is the output’s stream list');
{
    A.shell.goTo('write');
    pump(60);

    const rows = () => qq('#ex-streams .ex-stream');
    ok(rows().length === 2, `the usual two arrive without asking (${rows().length})`);
    same(rows()[0].getAttribute('data-kind'), 'video', 'a video stream first');
    same(rows()[1].getAttribute('data-kind'), 'audio', 'then the mix');
    same(q('.ex-stream-n', rows()[0]).textContent, 'V1',
         'numbered by kind, the way every ffmpeg stream specifier counts');

    // Adding one. Two audio tracks in one file is the thing the old writer
    // could not express at all.
    q('#ex-streams [data-add="audio"]').click();
    pump(60);
    same(rows().length, 3, 'a second audio stream can be added');
    same(q('.ex-stream-n', rows()[2]).textContent, 'A2', 'and is numbered A2');

    // What that row says. The detail is a fold because a four-track file would
    // otherwise be forty controls on one screen — and a row you just added
    // arrives with it open, because adding a stream and saying what it is are
    // one gesture with a pause in it.
    const lang = q('#ex-streams [data-f="stream-lang"]');
    ok(!!lang, 'a row you just added opens on its detail');
    ok(qq('#ex-streams [data-f="stream-lang"]').length === 1,
       'and one row at a time, so the list stays a list');
    lang.value = 'fra';
    lang.dispatchEvent(new Event('change'));
    pump(40);

    const title = q('#ex-streams [data-f="stream-title"]');
    title.value = 'Commentary';
    title.dispatchEvent(new Event('change'));
    pump(40);

    // The flags are libavformat's own vocabulary, walked bit by bit with
    // av_disposition_to_string — not a list written down in this repo.
    ok(Array.isArray(bro.ffmpeg.dispositions) && bro.ffmpeg.dispositions.length > 5,
       `libavformat names its dispositions (${bro.ffmpeg.dispositions.length}: ` +
       `${bro.ffmpeg.dispositions.slice(0, 4).join(' ')}…)`);
    const forced = q('#ex-streams [data-disp="forced"]');
    ok(!!forced, 'and each is a toggle on the row');
    forced.click();
    pump(60);
    q('#ex-streams [data-disp="comment"]').click();
    pump(60);

    // The row states what a player will show, so the sentence has to be the
    // one that will be written.
    const tail = q('.ex-stream-tail', qq('#ex-streams .ex-stream')[2]).textContent;
    ok(tail.indexOf('fra') >= 0 && tail.indexOf('forced') >= 0 && tail.indexOf('comment') >= 0,
       `the row says what it carries (${tail})`);

    // And it reaches the renderer.
    let s = A.exporter.buildSpec();
    same(s.streams.length, 3, 'the spec carries every stream');
    const a2 = s.streams.filter((x) => x.kind === 'audio')[1];
    same(a2.language, 'fra', 'with the language on the right one');
    same(a2.metadata.title, 'Commentary', 'and its name');
    ok(a2.disposition.indexOf('forced') > 0 && a2.disposition.indexOf('comment') > 0,
       `and both flags, written the way -disposition takes them (${a2.disposition})`);
    same(a2.source, 'mix', 'fed from the mix, which is what -map means here');
    ok(!!a2.codec, `and an encoder, inherited from Encode (${a2.codec})`);

    // The command bar. This is the claim: nothing reaches the muxer that the
    // bar does not print.
    let text = A.command.currentCommand();
    ok((text.match(/-map /g) || []).length === 3,
       `one -map per stream (${(text.match(/-map /g) || []).length})`);
    ok(text.indexOf('-c:a:1') > 0, `each audio stream names itself (${text.indexOf('-c:a:0') > 0})`);
    ok(text.indexOf('-metadata:s:a:1 language=fra') > 0,
       'the language is printed against the stream it belongs to');
    ok(/-metadata:s:a:1 "?title=Commentary/.test(text), 'and its name');
    ok(text.indexOf('-disposition:a:1') > 0, 'and the disposition');
    ok(text.indexOf('-c:v ') > 0 && text.indexOf('-c:v:') < 0,
       'while the one video stream keeps the unindexed form everybody reads');

    // The fourcc, offered as the muxer's vocabulary rather than as four
    // characters nobody knows to type. hvc1 and hev1 are the same HEVC
    // bitstream and only the first plays on Apple hardware.
    ok(bro.ffmpeg.codecTags('mp4', 'libx264').length > 0,
       `the mp4 muxer names its h264 tags (${bro.ffmpeg.codecTags('mp4', 'libx264').join(' ')})`);
    q('[data-f="detail"]', qq('#ex-streams .ex-stream')[0]).click();
    pump(60);
    const tag = q('#ex-streams [data-f="stream-tag"]');
    ok(!!tag && tag.options.length > 1, 'the video row offers them as a menu');
    if (tag) {
        tag.value = tag.options[tag.options.length - 1].value;
        tag.dispatchEvent(new Event('change'));
        pump(40);
        s = A.exporter.buildSpec();
        same(s.streams[0].tag, tag.value, 'and the choice reaches the renderer');
        ok(A.command.currentCommand().indexOf(`-tag:v ${tag.value}`) > 0,
           'and the command bar prints -tag:v');
    }

    // A fourcc belongs to a container's vocabulary rather than to a codec, so
    // one that was right where it was chosen stops the muxer dead somewhere
    // else — at write_header, with "Invalid data found when processing input"
    // and no mention of the tag at all. Found by writing this test.
    S.streams[0].tag = 'zzzz';
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
    pump(60);
    ok(el('ex-warnings').textContent.indexOf('does not know') >= 0,
       'a tag this container has never heard of is called out, not left to write_header');
    S.streams[0].tag = '';

    // **And the case that actually happens**, which `zzzz` above does not
    // reach: `hvc1` is a real tag, right in an mp4, and meaningless in
    // Matroska. It is the example docs/manual/output.md names and the one
    // somebody arrives at by choosing a tag on the Write stage and then
    // changing the container — so it has to be the container that decides, not
    // the string.
    {
        const codec = bro.ffmpeg.encoders.some((e) => e.id === 'libx265') ? 'libx265' : '';
        const inMp4 = codec ? bro.ffmpeg.codecTags('mp4', codec) : [];
        const inMkv = codec ? bro.ffmpeg.codecTags('matroska', codec) : [];
        if (inMp4.indexOf('hvc1') >= 0) {
            ok(inMkv.indexOf('hvc1') < 0,
               `hvc1 is mp4 vocabulary and not Matroska's (mp4: ${inMp4.join(' ')}; ` +
               `matroska: ${inMkv.join(' ') || 'none'})`);
            const wasContainer = S.container, wasCodec = S.videoCodec;
            S.container = 'mp4';
            S.videoCodec = codec;
            S.streams[0].tag = 'hvc1';
            S.streams[0].codec = codec;
            f('vcodec').dispatchEvent(new Event('change'));
            pump(60);
            ok(A.exporter.currentWarnings().join(' | ').indexOf('does not know') < 0,
               'and in an mp4 it is not warned about');
            S.container = 'matroska';
            f('vcodec').dispatchEvent(new Event('change'));
            pump(60);
            ok(A.exporter.currentWarnings().join(' | ')
                   .indexOf("matroska muxer does not know 'hvc1'") >= 0,
               'the same tag in Matroska is refused before the render, naming both');
            S.container = wasContainer;
            S.videoCodec = wasCodec;
            S.streams[0].tag = '';
            S.streams[0].codec = '';
            f('vcodec').dispatchEvent(new Event('change'));
            pump(60);
        } else {
            console.log('  (no libx265 with an hvc1 tag in this build)');
        }
    }

    // An attachment is a row because it *is* a stream — it has an index and
    // the muxer writes it out of the stream at header time. A chapter is not,
    // which is why it lives beside the list.
    q('#ex-streams [data-add="attachment"]').click();
    pump(60);
    ok(qq('#ex-streams .ex-stream[data-kind="attachment"]').length === 1,
       'an attachment is a row in the list');
    ok(el('ex-warnings').textContent.indexOf('no file yet') >= 0,
       'and one with no file yet says so rather than vanishing from the render');
    const attPath = bro.appDir + '/../out/ui-attachment.txt';
    const attField = q('#ex-streams [data-f="attach-path"]');
    attField.value = attPath;
    attField.dispatchEvent(new Event('change'));
    pump(60);
    ok(A.exporter.buildSpec().streams.some((x) => x.kind === 'attachment' && x.path === attPath),
       'once it has a file it reaches the renderer');
    ok(A.command.currentCommand().indexOf('-attach') > 0,
       'and the command bar prints -attach');
    ok(el('ex-warnings').textContent.indexOf('cannot hold an attachment') >= 0,
       'mp4 cannot hold one, which is said before the muxer refuses it');

    // Chapters are beside the streams, not among them: no index, nothing
    // mapped to them, and no way to say one on an ffmpeg command line at all —
    // which the bar has to admit rather than quietly drop.
    q('#ex-streams [data-add="chapter"]').click();
    pump(60);
    ok(qq('#ex-streams .ex-chapter').length === 1, 'a chapter mark can be added');
    const chTitle = q('#ex-streams [data-ch="0:title"]');
    chTitle.value = 'Opening';
    chTitle.dispatchEvent(new Event('change'));
    pump(40);
    same(A.exporter.buildSpec().chapters[0].title, 'Opening', 'and reaches the renderer');
    el('cmd-toggle').click();
    pump(60);
    ok(q('#cmd-line .cmd-note').textContent.indexOf('FFMETADATA') >= 0,
       'the command bar says chapters cannot be expressed as an argument');
    el('cmd-toggle').click();
    pump(40);

    // The spine states the whole render, so it has to count them.
    ok(q('#spine [data-stage="write"]').textContent.indexOf('streams') >= 0,
       `the spine's card counts them (${q('#spine [data-stage="write"]').textContent
           .replace(/\s+/g, ' ').trim()})`);
    screenshot('out/export-07-stream-list.png');

    // A preview must not inherit an eight-stream output. Both halves of the
    // A/B comparison exist to show what the encoder costs one picture, and a
    // second language track proves nothing about a wipe — so they ask for the
    // renderer's own default of one video stream and one audio stream.
    const pv = A.exporter.previewSpec({ start: 0, end: 0.4 });
    same(pv.streams.length, 0,
         'a preview asks for the renderer’s default list rather than the output’s');
    same(pv.chapters.length, 0, 'and carries no chapter marks into three seconds of a render');

    // Now render one, because the join between this table and the muxer is the
    // whole point of the table.
    {
        const two = A.exporter.buildSpec({
            width: 320, height: 180, fps: 25, end: 0.4,
            path: bro.appDir + '/../out/ui-streams.mkv',
            // Named, not implied by the extension. A render is told which
            // muxer by name now — `-f matroska` — so a path ending in .mkv
            // with the settings still on mp4 writes an mp4 called .mkv,
            // exactly as `ffmpeg -f mp4 out.mkv` does.
            container: 'matroska',
        });
        // Matroska, because that is the container that holds all of it.
        two.streams = two.streams.filter((x) => x.kind !== 'attachment');
        let started = '';
        try { bro.ffmpeg.render.start(two); } catch (e) { started = String(e); }
        ok(!started, `the renderer accepted the list (${started || 'accepted'})`);
        if (!started) {
            waitFor('the multi-stream render', () => bro.ffmpeg.render.poll().state !== 'running',
                    60000);
            const st = bro.ffmpeg.render.poll();
            ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
            const p = bro.ffmpeg.probe(two.path);
            const heard = (p.streams || []).filter((x) => x.kind === 'audio');
            same(heard.length, 2, 'and the file has both audio tracks in it');
            ok(heard[1].language === 'fra', `the second in the language it was given (${heard[1].language})`);
            ok(heard[1].title === 'Commentary', `and under its own name (${heard[1].title})`);
        }
    }

    // A row can be taken away, including the last video one: an audio-only
    // render is a legitimate thing to want.
    const before = qq('#ex-streams .ex-stream').length;
    q('[data-f="drop"]', qq('#ex-streams .ex-stream')[0]).click();
    pump(60);
    same(qq('#ex-streams .ex-stream').length, before - 1, 'a stream can be taken out');
    ok(!A.exporter.buildSpec().streams.some((x) => x.kind === 'video'),
       'including the last video stream, which is what a sound-only render is');
    ok(A.command.currentCommand().indexOf('-vn') > 0,
       'and the command says so with -vn');

    // Sound off on the Encode stage and the audio rows go with it — two
    // switches for one decision is how a render comes out silent while a track
    // list insists it should not have.
    A.shell.goTo('encode');
    pump(40);
    f('audio').click();
    pump(60);
    ok(!qq('#ex-streams .ex-stream[data-kind="audio"]').length,
       'turning sound off on Encode empties the audio rows');
    f('audio').click();
    pump(60);
    ok(qq('#ex-streams .ex-stream[data-kind="audio"]').length === 1,
       'and turning it back on puts one back');

    // Put the list back to what the rest of this script stands on.
    S.streams = [{ id: 1, kind: 'video', source: 'composite', metadata: {} },
                 { id: 2, kind: 'audio', source: 'mix', metadata: {} }];
    S.chapters = [];
    S.metadata = {};
    A.shell.goTo('write');
    pump(60);
    same(qq('#ex-streams .ex-stream').length, 2, 'and it is back to the usual two');
    A.shell.goTo('encode');
    pump(40);
}

// ── which muxer ────────────────────────────────────────────────────────────
//
// The container control was a four-item menu drawn from a four-entry table in
// C++, and everything else this build can write was unreachable. It is now a
// picker over every muxer libavformat has, which is a hundred and eighty — so
// what is being checked here is that a hundred and eighty is navigable without
// a list of the good ones anywhere: facets that are queries, a search over
// name, description and extension, and a choice that reaches the renderer as
// `-f` rather than as a filename somebody hopes will be guessed correctly.

console.log('\nchoosing a muxer');
{
    A.shell.goTo('write');
    pump(60);

    ok(bro.ffmpeg.muxers.length > 100,
       `${bro.ffmpeg.muxers.length} muxers to pick from, which is why it is not a <select>`);
    f('container-open').click();
    pump(40);
    ok(!!f('fmtsearch'), 'opening it gives a search box');
    const list = (sel) => Array.prototype.slice.call(qq(sel));
    const facets = list('[data-facet]');
    ok(facets.length >= 5, `and the groupings, which are queries: ${
        facets.map((b) => b.textContent).join(' ')}`);

    // The default group is the one that matters: the muxers that will hold
    // what this render is set to encode. Every row in it is one
    // avformat_query_codec said yes to, so none of them is marked as a misfit.
    const fitting = list('#st-write .ex-fmt-row');
    ok(fitting.length > 3, `"Fits" offers ${fitting.length} of them for x264 + aac`);
    ok(fitting.every((r) => r.className.indexOf('misfit') < 0),
       'and not one of them would be refused at write_header');
    ok(fitting.some((r) => r.getAttribute('data-muxer') === 'mp4'),
       'mp4 among them');
    ok(!fitting.some((r) => r.getAttribute('data-muxer') === 'webm'),
       'and WebM not, because it will not hold either of these codecs');

    // Search reaches everything, group or no group — a facet is a way of not
    // having to name what you want, and once it has been named, filtering the
    // answer down to the group you were standing in would hide it.
    f('fmtsearch').value = 'mpeg-ts';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    ok(!!q('[data-muxer="mpegts"]'),
       'searching libavformat’s own descriptions finds MPEG-TS by what it is called');

    // "mkv" is the extension the four-entry table used to call this format
    // and is not the name of anything in libavformat, so finding Matroska by
    // it is the search reaching extensions rather than only names.
    f('fmtsearch').value = 'mkv';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    ok(!!q('[data-muxer="matroska"]'),
       'an extension finds the muxer that writes it, though nothing is called mkv');

    f('fmtsearch').value = 'mpegts';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    q('[data-muxer="mpegts"]').click();
    pump(60);

    same(S.container, 'mpegts', 'picking one sets the muxer by name');
    ok(/\.ts$/.test(S.path), `and the filename follows it (${S.path})`);
    const tsSpec = A.exporter.buildSpec();
    same(tsSpec.format, 'mpegts', 'the renderer is told which muxer, by name');
    ok(A.command.currentCommand().indexOf('-f mpegts') > 0,
       'and the command says -f mpegts, because that is what is being run');

    // `avformat_query_codec` has three answers and mpegts gives the third:
    // it has neither a query function nor a tag table, so it says nothing
    // about H.264 rather than saying no. Reading the shrug as a refusal is how
    // a picker comes to insist MPEG-TS will not hold H.264 — so nothing is
    // filtered here and the codec in hand is left alone.
    same(S.videoCodec, 'libx264',
         'a muxer that does not answer for a codec does not have it taken away');
    ok(bro.ffmpeg.muxers.find((m) => m.name === 'mpegts').answersCodecs === false,
       'and the fact that it did not answer is reported rather than guessed at');

    // A muxer that *does* answer narrows the codec list — and the ones it will
    // not take are still listed, marked, because hiding them hides the reason
    // the one you wanted is missing.
    A.shell.goTo('encode');
    pump(40);
    const webm = bro.ffmpeg.muxers.find((m) => m.name === 'webm');
    ok(webm.answersCodecs && webm.videoCodecs.indexOf('libx264') < 0,
       'WebM answers, and its answer about x264 is no');
    const vcodecs = list('[data-f="vcodec"] option');
    ok(vcodecs.length > 10, `the codec menu lists every offered encoder (${vcodecs.length})`);
    A.shell.goTo('write');
    pump(40);

    // ── the muxer's own options ────────────────────────────────────────────
    //
    // The same mechanism as the encoder's advanced column, over the muxer's
    // AVClass instead of the encoder's, applied by the same rule: an unknown
    // key is an error at write_header rather than a setting quietly ignored.

    ok(!!f('formatopts'), 'the muxer states how many options it has');
    f('formatopts').click();
    pump(40);
    ok(el('ex-format-opts').className.indexOf('hidden') < 0,
       'and they open in a column of their own');

    f('fmtoptsearch').value = 'service_id';
    f('fmtoptsearch').dispatchEvent(new Event('input'));
    pump(40);
    const svc = q('#ex-format-opts [data-opt="mpegts_service_id"]');
    ok(!!svc, 'searching finds the muxer’s own options, not the encoder’s');
    svc.value = '17';
    svc.dispatchEvent(new Event('change'));
    pump(40);
    same(String(S.extraFormat.mpegts_service_id), '17', 'setting one reaches the settings');
    same(String(A.exporter.buildSpec().formatOptions.mpegts_service_id), '17',
         'and the spec the renderer is handed');
    ok(A.command.currentCommand().indexOf('-mpegts_service_id 17') > 0,
       'and the command prints it, because it reaches the muxer');

    // Written, and opened again — the whole point of a picker over a hundred
    // and eighty is that what it offers can actually be written.
    {
        const tsPath = bro.appDir + '/../out/ui-mpegts.ts';
        const spec = A.exporter.buildSpec({ width: 320, height: 180, fps: 25, end: 0.4,
                                            path: tsPath });
        let started = '';
        try { bro.ffmpeg.render.start(spec); } catch (e) { started = String(e); }
        ok(!started, `the renderer took it (${started || 'accepted'})`);
        if (!started) {
            waitFor('the mpegts render', () => bro.ffmpeg.render.poll().state !== 'running',
                    60000);
            const st = bro.ffmpeg.render.poll();
            ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
            const probed = bro.ffmpeg.probe(tsPath);
            ok(probed.format.name.indexOf('mpegts') >= 0,
               `and what came out is an MPEG-TS (${probed.format.name})`);
        }
    }

    // A muxer's options are its own. Carrying mpegts_service_id into Matroska
    // would stop the render dead at write_header, where an unknown key is an
    // error rather than a shrug — so changing the muxer empties the bag.
    f('container-open').click();
    pump(40);
    f('fmtsearch').value = 'mp4';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    q('[data-muxer="mp4"]').click();
    pump(60);
    same(S.container, 'mp4', 'back to mp4');
    same(Object.keys(S.extraFormat).length, 0,
         'and the previous muxer’s options did not come with it');
    ok(/\.mp4$/.test(S.path), `the filename came back too (${S.path})`);
    A.shell.goTo('encode');
    pump(40);
}

// ── a container that holds no picture ──────────────────────────────────────
//
// wav, mp3 and flac are sound and nothing else, so picking one leaves the
// render with no video encoder at all — and the rate control still has modes,
// because a bitrate and two passes are what any encoder can be asked for. The
// clamp that keeps the settings honest used to give up before it reached the
// rate whenever there was no encoder to look at, so `quality` survived into a
// control that could not offer it: a segmented row with nothing selected, no
// slider and no bitrate field. The same "no control for the mode you are in"
// state a stored mpeg2video used to reach, and this one needs no stored blob.

console.log('\na container that holds no picture');
{
    const wasContainer = S.container, wasRate = S.rate;
    S.rate = 'quality';
    A.shell.goTo('write');
    pump(60);
    f('container-open').click();
    pump(40);
    f('fmtsearch').value = 'wav';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    const row = q('[data-muxer="wav"]');
    ok(!!row, 'wav is in the picker');
    row.click();
    pump(80);
    same(S.videoCodec, '', 'picking it leaves no video encoder — it holds no picture');

    A.shell.goTo('encode');
    pump(80);
    const chosen = Array.prototype.slice.call(qq('[data-seg="rate"]'))
        .filter((b) => b.className.indexOf('on') >= 0);
    same(chosen.length, 1,
         `the rate control has exactly one mode selected (${
             Array.prototype.slice.call(qq('[data-seg="rate"]'))
                 .map((b) => b.getAttribute('data-v') + (b.className.indexOf('on') >= 0 ? '*' : ''))
                 .join(' ')})`);
    ok(S.rate !== 'quality', `and it is not one nothing here can do (${S.rate})`);
    ok(!!f('vbitrate') || !!f('quality'),
       'so the control for the mode it is in is on the screen');

    // Put it back where the rest of this suite expects it.
    A.shell.goTo('write');
    pump(60);
    f('container-open').click();
    pump(40);
    f('fmtsearch').value = 'mp4';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    q('[data-muxer="mp4"]').click();
    pump(60);
    S.rate = wasRate;
    same(S.container, wasContainer, 'and back to where the rest of this suite starts from');
    A.shell.goTo('encode');
    pump(60);
}

// ── where the render goes ──────────────────────────────────────────────────
//
// A destination stopped being a path and two flags. Four shapes, and the whole
// claim of this section is that the *shape* is asked rather than declared: the
// muxer and the path decide it between them, and every panel, warning, command
// note and progress readout reads that one answer.

console.log('\nwhere the render goes');
{
    A.shell.goTo('write');
    pump(60);
    const D = A.exporter.destination;

    // A known starting point. Every shape below is a container and a path, and
    // both are remembered between runs — so a section that assumed what it
    // inherited would pass or fail on what the last run left behind.
    S.container = 'mp4';
    S.path = bro.appDir + '/../out/ui-export.mp4';
    S.extraFormat = {};
    S.destinations = [];
    A.exporter.redraw();
    pump(40);

    // The ordinary case is still the ordinary case, and it says so.
    same(S.container, 'mp4', 'the container is mp4 to begin with');
    same(D.kindOf(bro.ffmpeg.muxers.find((m) => m.name === 'mp4'), S.path), 'file',
         'a path and a muxer that writes it is one file');
    ok((f('path') || {}).value === S.path, 'and the panel offers the path');

    // A URL is a stream, whatever the muxer thinks. There is no control that
    // says so: the scheme does.
    const wasPath = S.path;
    S.path = 'udp://127.0.0.1:9000';
    A.exporter.redraw();
    pump(40);
    same(D.kindOf(bro.ffmpeg.muxers.find((m) => m.name === 'mp4'), S.path), 'stream',
         'a URL is a stream, asked of the path rather than of a mode control');
    ok(D.schemeOf(S.path) === 'udp', 'the scheme is read out of it');
    ok(D.outputProtocols().length > 5,
       `${D.outputProtocols().length} output protocols in this build, and udp is ` +
       (D.protocolLinked('udp') ? 'one of them' : 'not among them'));
    ok(D.protocolLinked('udp'), 'udp is linked in');
    ok(!D.protocolLinked('no_such_protocol'), 'and a scheme this build lacks is reported so');

    // C:\ is a colon in a path, not a scheme. Getting this wrong would call
    // every Windows path a stream.
    same(D.schemeOf('C:/videos/out.mp4'), '', 'a drive letter is not a protocol');
    // And the same drive letter with a doubled slash after it, which is the
    // form that got past the guard while there were two copies of this parse:
    // the reading end read `c` as a protocol and drew "not in this build"
    // against a perfectly ordinary path.
    same(D.schemeOf('C://videos/out.mp4'), '',
         'nor is it one when the path happens to have two slashes after it');
    same(A.inputs.schemeOf('C://videos/out.mp4'), '',
         'and the reading end says the same, because it is the same parse');

    // `file:` is the long way of writing a path, which is what the renderer
    // says: `isLocalPath` in export_writer.cpp stats a `file:` URL rather than
    // reporting what it sent. A screen that called it a stream would take the
    // "Open the result" button away from a file sitting on the disk.
    same(D.schemeOf('file:///C:/videos/out.mp4'), '',
         'a file: URL is not a stream — it is a path spelt out');
    same(D.kindOf(bro.ffmpeg.muxers.find((m) => m.name === 'mp4'), 'file:///C:/out.mp4'),
         'file', 'so it is one file');
    same(D.openable('file', 'file:///C:/out.mp4'), '///C:/out.mp4',
         'and what to open is the path behind it, the same five characters ' +
         'localPathOf() strips');

    // The protocol's own options, in the same column the muxer's are in and
    // the same bag they travel in — which is what libavformat does with what a
    // muxer does not recognise.
    if (!q('#ex-format-opts [data-f="protooptsearch"]')) {
        f('formatopts').click();
        pump(40);
    }
    ok(!!q('[data-f="protooptsearch"]'),
       'a URL destination offers the protocol’s own option table beside the muxer’s');
    const udpOpts = bro.ffmpeg.protocolOptions('udp') || [];
    ok(udpOpts.length > 3, `udp reports ${udpOpts.length} options`);
    q('[data-f="protooptsearch"]').value = 'pkt_size';
    q('[data-f="protooptsearch"]').dispatchEvent(new Event('input'));
    pump(40);
    const pkt = q('#ex-format-opts [data-opt="pkt_size"]');
    ok(!!pkt, 'searching it finds pkt_size, which is the protocol’s and not the muxer’s');
    pkt.value = '1316';
    pkt.dispatchEvent(new Event('change'));
    pump(40);
    same(String(S.extraFormat.pkt_size), '1316',
         'and it goes in the same bag the muxer’s options do');
    same(String(A.exporter.buildSpec().formatOptions.pkt_size), '1316',
         'which is the bag the renderer is handed');
    ok(A.command.currentCommand().indexOf('-pkt_size 1316') > 0,
       'and the command prints it, because it reaches the destination');
    ok(A.command.currentCommand().indexOf('udp://127.0.0.1:9000') > 0,
       'with the URL as the output, unresolved against anything');

    // A stream has no size and no percentage — the same vocabulary a recording
    // uses, rather than a second convention.
    const streamWarnings = A.exporter.currentWarnings();
    ok(!streamWarnings.some((w) => w.indexOf('no udp output protocol') >= 0),
       'a protocol this build has is not warned about');

    // mp4 down a socket cannot have its index moved to the front, and it fails
    // at the end of the render after everything has been sent.
    ok(S.faststart, 'faststart is on');
    ok(streamWarnings.some((w) => w.indexOf('+faststart') >= 0),
       'and an mp4 to a stream says so, because a socket cannot be rewound');

    delete S.extraFormat.pkt_size;
    S.path = wasPath;
    A.exporter.redraw();
    pump(40);
}

console.log('\na set of files, and what to open at the end');
{
    A.shell.goTo('write');
    pump(40);
    const D = A.exporter.destination;

    const seg = bro.ffmpeg.muxers.find((m) => m.name === 'segment');
    const hls = bro.ffmpeg.muxers.find((m) => m.name === 'hls');
    ok(!!seg && !!hls, 'this build has the segment and hls muxers');
    ok(seg.noFile, 'segment declares AVFMT_NOFILE — it does not write what it is named with');
    same(D.kindOf(seg, 'out/seg-%03d.ts'), 'files', 'so it is a set of files');
    same(D.kindOf(hls, 'out/stream.m3u8'), 'files', 'and so is hls, whose name is a playlist');

    // The other route to a set: the numbering is in the filename, which is the
    // only place image2 can put it.
    const img = bro.ffmpeg.muxers.find((m) => m.name === 'image2');
    same(D.kindOf(img, 'out/frame%04d.png'), 'files', 'a frame pattern is a set of files too');

    // **"Open the result" is a real question for a set.** The playlist is the
    // file that says where the pieces are; a numbered run has no index, so the
    // first picture is the answer; a stream has nothing at all.
    S.container = 'hls';
    S.path = 'out/stream.m3u8';
    same(D.openable('files', S.path), 'out/stream.m3u8',
         'for hls the thing to open is the playlist that was named');
    S.container = 'image2';
    S.path = 'out/frame%04d.png';
    ok(/frame0*1\.png$/.test(D.openable('files', S.path)),
       `a numbered run opens at its first file (${D.openable('files', S.path)})`);
    same(D.openable('stream', 'udp://127.0.0.1:9000'), '',
         'and a stream has nothing to open — what was sent has gone');

    // A segment can only start on a keyframe. Two seconds of GOP against a
    // half-second segment time succeeds and produces two-second segments,
    // which is the shape of failure the warnings list exists for.
    S.container = 'segment';
    S.path = 'out/seg-%03d.ts';
    S.extraFormat = { segment_time: '0.5' };
    S.gopSeconds = 2;
    A.exporter.redraw();
    pump(40);
    const segWarn = A.exporter.currentWarnings();
    ok(segWarn.some((w) => w.indexOf('can only start on a keyframe') >= 0),
       'a keyframe interval longer than the segment time is called out, with both numbers');

    S.extraFormat = {};
    S.gopSeconds = 0;
}

console.log('\nseveral destinations at once');
{
    A.shell.goTo('write');
    const D = A.exporter.destination;

    // Escaping first, because it is the awkward part and it is a pure
    // function. tee splits on `|` honouring a backslash, and reads each
    // destination's options out of `[ ]` on `=` and `:`.
    same(D.escapeTarget('rtmp://host/app/key'), 'rtmp://host/app/key',
         'an ordinary URL needs no escaping');
    same(D.escapeTarget('out/a|b.mkv'), 'out/a\\|b.mkv',
         'a | in a target is escaped, because it is what separates destinations');
    same(D.escapeTarget('out\\a.mkv'), 'out\\\\a.mkv', 'and so is a backslash');
    same(D.escapeOption('0:v'), '0\\:v',
         'inside the brackets a : is escaped, because it separates one option from the next');
    same(D.escapeOption('a]b'), 'a\\]b', 'and a ] , because it ends them');

    same(D.teeSpec([{ format: 'matroska', path: 'out/a.mkv', options: {} },
                    { format: 'mpegts', path: 'udp://127.0.0.1:9000', options: {} }]),
         '[f=matroska]out/a.mkv|[f=mpegts]udp://127.0.0.1:9000',
         'two destinations become one tee argument');
    same(D.teeSpec([{ format: 'hls', path: 'out/s.m3u8', options: { hls_time: '2' } }]),
         '[f=hls:hls_time=2]out/s.m3u8',
         'and each carries its own muxer options in its own brackets');
    same(D.teeSpec([{ format: 'matroska', path: '', options: {} },
                    { format: 'flv', path: 'out/b.flv', options: {} }]),
         '[f=flv]out/b.flv',
         'a half-typed row is skipped rather than written as an empty slave');

    // And the same through the form.
    S.container = 'mp4';
    S.path = bro.appDir + '/../out/ui-tee-a.mkv';
    S.destinations = [];
    A.exporter.redraw();
    pump(40);
    f('container-open').click();
    pump(40);
    f('fmtsearch').value = 'tee';
    f('fmtsearch').dispatchEvent(new Event('input'));
    pump(40);
    ok(!!q('[data-muxer="tee"]'), 'tee is in the picker, found by name');
    q('[data-muxer="tee"]').click();
    pump(60);

    same(S.container, 'tee', 'picking it sets -f tee');
    ok(S.destinations.length === 2,
       'and the file already named becomes the first destination rather than being thrown away');
    same(S.destinations[0].path, bro.appDir + '/../out/ui-tee-a.mkv',
         'carrying the path that was there');
    same(S.destinations[0].format, 'mp4', 'and the muxer that was chosen for it');

    // Make it two real destinations: one Matroska file, one MPEG-TS file.
    S.destinations[0].format = 'matroska';
    S.destinations[1].format = 'mpegts';
    S.destinations[1].path = bro.appDir + '/../out/ui-tee-b.ts';
    A.exporter.redraw();
    pump(40);

    const spec = A.exporter.buildSpec();
    same(spec.format, 'tee', 'the renderer is told -f tee');
    // Escaped as tee reads it, which on Windows means every backslash in a
    // path is doubled — correct, and worth stating, because it is exactly the
    // thing that looks wrong and is the reason this is built rather than typed.
    same(spec.path,
         `[f=matroska]${D.escapeTarget(S.destinations[0].path)}` +
         `|[f=mpegts]${D.escapeTarget(S.destinations[1].path)}`,
         'and the "path" it is given is the destination list, escaped as tee reads it');

    const cmd = A.command.currentCommand();
    ok(cmd.indexOf('-f tee') > 0, 'the command says -f tee');
    ok(cmd.indexOf('[f=matroska]') > 0 && cmd.indexOf('[f=mpegts]') > 0,
       'and prints both destinations');
    // The list contains a `|`, which a shell would read as a pipe. A command
    // that cannot be pasted and run is a command not worth printing.
    ok(/"[^"]*\|[^"]*"/.test(cmd), 'quoted, so the | is tee’s and not the shell’s');

    // The panel says it, in full, because an argument assembled on your behalf
    // is exactly the one that has to be visible.
    ok(q('#ex-dest .ex-tee') && q('#ex-dest .ex-tee').textContent.indexOf('[f=mpegts]') >= 0,
       'and the Write stage shows the argument it built');

    // Now run it. One encode, two files, and both of them the render.
    {
        const s2 = A.exporter.buildSpec({ width: 320, height: 180, fps: 25, end: 0.4 });
        let started = '';
        try { bro.ffmpeg.render.start(s2); } catch (e) { started = String(e); }
        ok(!started, `the renderer took a tee spec (${started || 'accepted'})`);
        if (!started) {
            waitFor('the tee render', () => bro.ffmpeg.render.poll().state !== 'running', 60000);
            const st = bro.ffmpeg.render.poll();
            ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
            same(st.pieces, 2, 'and reports two destinations opened');
            const a = bro.ffmpeg.probe(S.destinations[0].path);
            const b = bro.ffmpeg.probe(S.destinations[1].path);
            ok(a.video && b.video, 'both files carry the picture');
            same(a.video.width, 320, 'and the first is the render');
            same(b.video.width, 320, 'and so is the second');
            ok(b.format.name.indexOf('mpegts') >= 0,
               `in the container it was told (${b.format.name})`);
        }
    }

    // A tee with one destination is one destination with a layer of escaping
    // over it, and saying so is more useful than letting it work.
    const kept = S.destinations[1];
    S.destinations = [S.destinations[0]];
    A.exporter.redraw();
    pump(20);
    ok(A.exporter.currentWarnings().some((w) => w.indexOf('one destination through tee') >= 0),
       'one destination through tee is called out');
    S.destinations = [];
    A.exporter.redraw();
    pump(20);
    ok(A.exporter.currentWarnings().some((w) => w.indexOf('nowhere to go') >= 0),
       'and none at all is called out rather than rendered');
    S.destinations = [];
}

// ── the same edit, written twice ────────────────────────────────────────────
//
// The other half of the question above and the one it is mistaken for: `tee`
// is one encode to several places, a version is several encodes of one edit.
// Which means the check that matters is the one `tee` cannot pass — two files
// at two *sizes*, out of one job.

console.log('\na version is the same edit at another size');
{
    A.shell.goTo('write');
    const wasW = S.width, wasH = S.height, wasOut = S.rangeOut, wasPath = S.path;
    const wasContainer = S.container;
    S.container = 'mp4';
    S.width = 640; S.height = 360; S.rangeOut = 0.4;
    S.path = `${bro.appDir}/../out/uivmaster.mp4`;
    S.destinations = [];
    S.versions = [];
    A.exporter.redraw();
    pump(40);

    // The list is a control, and the button fills the first row in rather than
    // adding an empty one: a version with nothing on it is not a version.
    const add = q('[data-f="versions"]');
    ok(!!add, 'the Also-write section is on the Write stage');
    add.click();
    pump(40);
    same(S.versions.length, 1, 'and opening it starts a version');
    same(S.versions[0].width, 320, 'at half the render’s width');
    ok(/uivmaster-320\.mp4$/.test(S.versions[0].path),
       `beside the render’s own file (${S.versions[0].path})`);

    // One side given, the other worked out from the render's aspect. 640×360 is
    // 16:9, so 320 wide is 180 high and nobody has to say so.
    let spec = A.exporter.buildSpec();
    same(spec.passes.length, 2, 'the render is two passes: the master and the version');
    ok(!spec.passes[0].path, 'the master’s pass overrides no path — it is the render');
    same(spec.passes[1].width, 320, 'and the version’s is its own width');
    same(spec.passes[1].height, 180, 'with the height taken from the render’s aspect');
    same(spec.width, 640, 'while the render itself is untouched');

    // **The rectangles travel with the size.** A clip filling a 640-wide canvas
    // is `w: 640`, and composited unchanged onto a 320-wide one it would be
    // cropped rather than fitted — so the pass carries its own stack, at its own
    // scale, and this is the check that says so.
    ok(spec.passes[1].clips.length === spec.clips.length,
       'the version composites the same clips');
    const big = spec.clips.find((c) => c.w > 0);
    const small = spec.passes[1].clips.find((c) => c.id === big.id);
    ok(!!small && Math.abs(small.w - big.w / 2) <= 1,
       `at half the width (${big.w} → ${small && small.w})`);

    // Both consumers of the spec, which must not disagree with it or with each
    // other: two whole invocations, each scaling to its own size and naming its
    // own file.
    const cmd = A.command.currentCommand().split('\n');
    same(cmd.length, 2, 'the command bar prints two invocations');
    ok(cmd[0].indexOf('640x360') >= 0 && cmd[0].indexOf('uivmaster.mp4') >= 0,
       'the first at the render’s size, to the render’s file');
    ok(cmd[1].indexOf('320x180') >= 0 && cmd[1].indexOf('uivmaster-320.mp4') >= 0,
       'the second at the version’s size, to the version’s file');
    ok(cmd[1].indexOf('scale=320:180') >= 0,
       'and the version’s -filter_complex scales to the version');

    // Now run it, which is the only thing that proves any of the above.
    {
        let started = '';
        try { bro.ffmpeg.render.start(spec); } catch (e) { started = String(e); }
        ok(!started, `the renderer took it (${started || 'accepted'})`);
        if (!started) {
            waitFor('the two-version render',
                    () => bro.ffmpeg.render.poll().state !== 'running', 90000);
            const st = bro.ffmpeg.render.poll();
            ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
            const a = bro.ffmpeg.probe(S.path);
            const b = bro.ffmpeg.probe(S.versions[0].path);
            ok(!!a.video && !!b.video, 'both files carry a picture');
            same(a.video.width, 640, 'the master is the render’s size');
            same(b.video.width, 320, 'and the version is its own');
            same(b.video.height, 180, 'both sides of it');
            // One job, one Stop button, one terminal status — which is the whole
            // reason this is passes and not two renders.
            ok(st.passes >= 2, `reported as one job of ${st.passes} passes`);
        }
    }

    // A muxer of its own, guessed from the extension the way libavformat guesses
    // from a filename — so a proxy in another container needs nothing typed.
    S.versions[0].path = `${bro.appDir}/../out/uivproxy.mkv`;
    A.exporter.redraw();
    pump(20);
    spec = A.exporter.buildSpec();
    same(spec.passes[1].format, 'matroska',
         'a version’s muxer is read off its extension when it names none');
    S.versions[0].format = 'mpegts';
    spec = A.exporter.buildSpec();
    same(spec.passes[1].format, 'mpegts', 'and a named one wins');
    S.versions[0].format = '';

    // **Two encodes aimed at one path is the failure this feature can produce**,
    // and it is exactly the shape the warnings list is for: it succeeds, and one
    // of the two files it paid for is gone.
    S.versions[0].path = S.path;
    A.exporter.redraw();
    pump(20);
    ok(A.exporter.currentWarnings().some((w) => /writes where the render itself writes/.test(w)),
       'a version aimed at the render’s own path is called out');
    S.versions[0].path = `${bro.appDir}/../out/uivproxy.mp4`;

    // And a version that is the render — no size, no muxer — is a second encode
    // of an identical file. Refused as a *render* by `activeVersions` and said
    // out loud, because a stage showing two outputs and writing one is worse
    // than either.
    S.versions[0].width = 0; S.versions[0].height = 0;
    A.exporter.redraw();
    pump(20);
    same(A.exporter.buildSpec().passes, undefined,
         'a version with nothing of its own is not a pass');
    ok(A.exporter.currentWarnings().some((w) => /second encode of the identical file/.test(w)),
       'and it says so rather than silently dropping the row');

    // Two-pass and two versions is four walks: each output measured and then
    // spent, each with a statistics log of its own — a bitrate map measured on
    // 640-wide pictures is not a smaller version of the 320-wide decision.
    S.versions[0].width = 320;
    const wasRate = S.rate;
    S.rate = 'twopass';
    A.exporter.redraw();
    pump(20);
    spec = A.exporter.buildSpec();
    same(spec.passes.length, 4, 'two outputs at two passes each is four walks');
    ok(spec.passes[0].label.indexOf('the master') === 0 &&
       spec.passes[2].label.indexOf('320×180') === 0,
       'labelled by which file as well as which pass');
    ok(spec.passes[0].videoOptions.passlogfile !== spec.passes[2].videoOptions.passlogfile,
       'and each output keeps its statistics somewhere of its own');
    same(spec.passes[2].videoOptions.pass, '1', 'the version is measured first');
    same(spec.passes[3].videoOptions.pass, '2', 'and then spent');
    S.rate = wasRate;

    // A preview is this render written to a temp file, so it has no versions:
    // one would spend a second encode putting three seconds of timeline over
    // the file somebody is keeping.
    same(A.exporter.buildSpec({ path: `${bro.appDir}/../out/uivpreview.mp4` }).passes, undefined,
         'a render aimed somewhere else carries no versions');

    S.versions = [];
    S.width = wasW; S.height = wasH; S.rangeOut = wasOut;
    S.path = wasPath; S.container = wasContainer;
    A.exporter.redraw();
    pump(20);
}

console.log('\nprogress says something true for each shape');
{
    // **Three shapes, three readouts.** A bounded file render has frames, a
    // total and therefore an estimate; a set of files has all of that and a
    // count of pieces, which is the only number that says a segmenter is
    // segmenting; a stream has no size, no percentage and nothing to open.
    A.shell.goTo('write');
    const wasW = S.width, wasH = S.height, wasOut = S.rangeOut;
    S.width = 320; S.height = 180; S.rangeOut = 0.6;

    const runIt = (container, path, extra) => {
        S.container = container;
        S.path = path;
        S.extraFormat = extra || {};
        S.destinations = [];
        A.exporter.redraw();
        pump(40);
        el('ex-go').click();
        pump(60);
        waitFor(`the ${container} render`, () => {
            const s = A.exporter.lastStatus();
            return s && s.state !== 'running';
        }, 60000);
        pump(60);
        return A.exporter.lastStatus();
    };

    // A set of files. The playlist is what was named and what gets opened; the
    // segments are the pieces, counted as libavformat opened them.
    const hls = runIt('hls', bro.appDir + '/../out/ui-hls.m3u8',
                      { hls_time: '0.2', hls_list_size: '0' });
    ok(hls.state === 'done', `an hls render finishes (${hls.state}${hls.error ? ': ' + hls.error : ''})`);
    ok(hls.pieces >= 1, `and reports the segments beside the playlist (${hls.pieces})`);
    const hlsPanel = el('ex-progress').textContent;
    ok(hlsPanel.indexOf('files') >= 0,
       'the panel says how many files came out rather than naming one');
    ok(hlsPanel.indexOf('the one to open') >= 0,
       'and which of them is the one to open, because a playlist is not "here is your file"');
    ok(!!f('import'), 'so there is still something to put back on the timeline');

    // A stream. Nothing was kept, so there is nothing to offer.
    const udp = runIt('mpegts', 'udp://127.0.0.1:45232', { pkt_size: '1316' });
    ok(udp.state === 'done', `a render to udp:// finishes (${udp.state}${udp.error ? ': ' + udp.error : ''})`);
    const udpPanel = el('ex-progress').textContent;
    ok(udpPanel.indexOf('Sent to') >= 0,
       'the panel says it was sent rather than written');
    ok(udpPanel.indexOf('nothing was kept') >= 0,
       'and says so out loud, because a stream is gone once it has been sent');
    ok(!f('import'),
       'with no offer to put it on the timeline, which would be an offer to open a socket');
    ok(udp.bytes > 1024, `what it reports is what went through the socket (${udp.bytes} bytes)`);

    S.width = wasW; S.height = wasH; S.rangeOut = wasOut;

    // Back to something the rest of this file can use.
    S.container = 'mp4';
    S.path = bro.appDir + '/../out/ui-export.mp4';
    S.extraFormat = {};
    A.exporter.redraw();
    pump(40);
    A.shell.goTo('encode');
    pump(40);
}

// ── the rest of what an encoder is told ────────────────────────────────────
//
// None of this is an encoder option, which is exactly why each needed a control
// and a named field on the spec rather than a row in the advanced column. What
// is checked here is the same join the rest of this file checks: a control turns
// into the thing ffmpeg would have been given, and the command bar prints it —
// because anything reaching the renderer the bar does not print is a bug.

console.log('\ntwo passes are a rate-control mode, not a switch');
{
    A.shell.goTo('encode');
    pump(40);
    S.videoCodec = 'libx264';
    f('vcodec').dispatchEvent(new Event('change'));
    pump(60);

    const modes = qq('button[data-seg="rate"]');
    let names = [];
    for (const b of modes) names.push(b.getAttribute('data-v'));
    ok(names.indexOf('twopass') >= 0,
       `two-pass is one of the rate modes, beside the others (${names.join(', ')})`);

    q('button[data-seg="rate"][data-v="twopass"]').click();
    pump(60);
    same(S.rate, 'twopass', 'choosing it is choosing a rate control');
    ok(!!f('vbitrate'), 'and it asks for a bitrate, because that is what it spends');

    f('vbitrate').value = '4000';
    f('vbitrate').dispatchEvent(new Event('change'));
    pump(60);
    same(S.videoBitrate, 4000, 'the bitrate field is the one the mode spends');

    // The spec is where a render becomes two renders, in one place, so the
    // export and both halves of the preview cannot disagree about how many
    // times the range is walked.
    const spec = A.exporter.buildSpec();
    same((spec.passes || []).length, 2, 'the spec says the range is walked twice');
    same(spec.videoOptions.b, '4000k', 'both passes are aimed at the same bitrate');
    same(spec.passes[0].discard, true, 'the first keeps nothing — it is `-f null -`');
    same(spec.passes[0].videoOptions.pass, '1', 'and says which pass it is');
    same(spec.passes[1].videoOptions.pass, '2', 'as does the second');
    ok(spec.passes[0].videoOptions.passlogfile &&
       spec.passes[0].videoOptions.passlogfile === spec.passes[1].videoOptions.passlogfile,
       'both naming the same statistics file, which is the whole handoff');

    // Two invocations, because ffmpeg has no way to say it in one and a single
    // line would print a command that produces a different result.
    const text = A.command.currentCommand();
    const lines = text.split('\n').filter((l) => l.indexOf('ffmpeg ') === 0);
    same(lines.length, 2, 'the command bar prints two invocations');
    ok(lines[0].indexOf('-pass 1') > 0 && lines[0].indexOf('-f null -') > 0,
       'the first writes statistics and keeps no file');
    ok(lines[1].indexOf('-pass 2') > 0 && lines[1].indexOf('.mp4') > 0,
       'the second reads them and writes the output');
    ok(/-passlogfile \S+/.test(lines[0]) && /-passlogfile \S+/.test(lines[1]),
       'and both name the log');

    // **The bow-out.** A caller that names its own option bag has taken the
    // passes with it, and the caller that does is the A/B comparison's lossless
    // reference: it is `crf 0` and there is no bitrate for a second pass to
    // spend, so a reference that quietly ran two would be measured against a
    // different encode from the one the wipe is showing. The preview's own spec
    // keeps them, because the candidate is the render being judged.
    same((A.exporter.buildSpec({ videoOptions: { crf: 0, preset: 'ultrafast' } })
              .passes || []).length,
         0, 'a render that names its own options is one pass, whatever the mode says');
    same((A.exporter.previewSpec({ path: 'out/x.mp4' }).passes || []).length, 2,
         'and the candidate keeps both, because it is the encode being judged');

    S.rate = 'quality';
    f('vcodec').dispatchEvent(new Event('change'));
    pump(60);
    same((A.exporter.buildSpec().passes || []).length, 0,
         'constant quality is one pass again — there is nothing for a second to learn');

    // **And the options a pass names reach the encoder.**
    //
    // Everything above is about the spec, and the spec was right the whole time
    // a two-pass render was quietly a one-pass render done twice: a pass's
    // options were merged into the *settings*, and `outputStreams()` reads
    // those only for the render with no stream list — which no render this
    // application builds is. So `-pass 1` was dropped, silently, in the one
    // codebase whose rule is that an unknown option is an error rather than a
    // shrug.
    //
    // Asserted by breaking it on purpose: a key libx264 does not have, put on a
    // pass. If it reaches libavcodec the render is refused naming it, and if it
    // does not the render succeeds — which is the failure, and is what it did.
    {
        const broken = A.exporter.buildSpec();
        broken.path = bro.appDir + '/../out/pass-options.mp4';
        broken.start = 0; broken.end = 0.4;
        broken.passes = [{ label: 'the only pass',
                           videoOptions: { thisoptiondoesnotexist: '1' } }];
        let refused = '';
        try {
            bro.ffmpeg.render.start(broken);
            waitFor('the render with a broken pass option', () => {
                const st = A.exporter.lastPoll_ ? null : bro.ffmpeg.render.poll();
                return st && st.state && st.state !== 'running';
            }, 60000);
            refused = (bro.ffmpeg.render.poll() || {}).error || '';
        } catch (e) {
            refused = String(e.message || e);
        }
        ok(refused.indexOf('thisoptiondoesnotexist') >= 0,
           `an option a pass names reaches the encoder, and an unknown one stops the ` +
           `render rather than being dropped (${refused || 'the render succeeded'})`);
    }
}

console.log('\na keyframe where the edit cuts');
{
    f('advanced').click();
    pump(60);
    ok(!!q('button[data-seg="kfmode"][data-v="cuts"]'), 'the keyframe control is in Advanced');

    // Nothing here writes a list of times down. What is remembered is the
    // decision, and the answer is re-read from the timeline every time it is
    // asked — which is what keeps it honest after the edit moves.
    const before = A.project.clips.length;
    ok(before >= 1, 'there is something on the timeline to cut');
    // Put back afterwards: everything below renders the whole timeline and
    // measures the result against it, so a cut left in would be this section
    // deciding what the ones after it are looking at.
    const was = A.project.clips.map((c) => ({ c, start: c.start, length: c.length,
                                              inPoint: c.inPoint }));
    A.select(A.project.clips[0]);
    A.setPlayhead(A.project.clips[0].start + A.project.clips[0].length * 0.5, true);
    pump(120);
    A.splitAtPlayhead();
    pump(120);
    ok(A.project.clips.length > before, 'splitting it makes a cut inside the range');
    const cutAt = A.project.clips[1].start;

    q('button[data-seg="kfmode"][data-v="cuts"]').click();
    pump(80);
    same(S.keyframeMode, 'cuts', 'the mode is what is stored');

    const spec = A.exporter.buildSpec();
    const asked = spec.forceKeyFrames.split(',').map(Number);
    ok(asked.some((t) => Math.abs(t - (cutAt - spec.start)) < 0.01),
       `the cut is asked for, in seconds into the output (${spec.forceKeyFrames})`);
    ok(A.command.currentCommand().indexOf('-force_key_frames') > 0,
       'and the command bar prints it');

    // The point of deriving rather than copying: move the clip and the
    // keyframe moves with it. A version that wrote the numbers into a field
    // would go on naming a moment nothing cuts at.
    const second = A.project.clips[1];
    second.start += 0.4;
    second.inPoint += 0.4;
    second.length -= 0.4;
    A.resolveOverlaps(second);
    pump(120);
    const after = A.exporter.buildSpec();
    const now = after.forceKeyFrames.split(',').map(Number);
    ok(now.some((t) => Math.abs(t - (A.project.clips[1].start - after.start)) < 0.01),
       `and it follows the clip when the clip moves (${after.forceKeyFrames})`);

    // Typed times and an expression, which are the same option said two other
    // ways — both ffmpeg's own spellings, so what is stored is what would be
    // typed on a command line.
    q('button[data-seg="kfmode"][data-v="times"]').click();
    pump(60);
    f('kftimes').value = '0.5,1.25';
    f('kftimes').dispatchEvent(new Event('change'));
    pump(60);
    same(A.exporter.buildSpec().forceKeyFrames, '0.5,1.25', 'a list of times goes through as one');

    q('button[data-seg="kfmode"][data-v="expr"]').click();
    pump(60);
    f('kfexpr').value = 'gte(t,n_forced*2)';
    f('kfexpr').dispatchEvent(new Event('change'));
    pump(60);
    same(A.exporter.buildSpec().forceKeyFrames, 'expr:gte(t,n_forced*2)',
         'and an expression carries the prefix ffmpeg wants');

    q('button[data-seg="kfmode"][data-v="none"]').click();
    pump(60);
    same(A.exporter.buildSpec().forceKeyFrames, '', 'off asks for nothing');

    A.project.clips.length = 0;
    for (const w of was) {
        w.c.start = w.start; w.c.length = w.length; w.c.inPoint = w.inPoint;
        A.project.clips.push(w.c);
    }
    A.select(A.project.clips[0]);
    pump(120);
}

console.log('\nhow the frames are timed and shaped');
{
    // Stated, not chosen. Both render paths walk the range at the output rate
    // and stamp each frame with its number, so `cfr` is a fact about this
    // renderer rather than a setting — and a picker offering `vfr` would be
    // offering something neither path can produce.
    ok(qq('button[data-seg="fpsmode"]').length === 0,
       'there is no frame-timing picker, because there is nothing to pick');
    ok(A.command.currentCommand().indexOf('-fps_mode cfr') > 0 ||
       A.command.currentCommand().indexOf('-fps_mode:v cfr') > 0,
       'and the command says so out loud instead');

    q('button[data-seg="fieldorder"][data-v="tt"]').click();
    pump(60);
    same(S.fieldOrder, 'tt', 'field order is a choice');
    same(A.exporter.buildSpec().fieldOrder, 'tt', 'and reaches the renderer');
    const text = A.command.currentCommand();
    ok(text.indexOf('+ildct+ilme') > 0 && text.indexOf('-field_order') > 0,
       'printed as the two things it is: the encoder in field mode and the stream saying which');
    q('button[data-seg="fieldorder"][data-v=""]').click();
    pump(60);

    f('threads').value = '3';
    f('threads').dispatchEvent(new Event('change'));
    f('threadtype').value = 'slice';
    f('threadtype').dispatchEvent(new Event('change'));
    pump(60);
    same(A.exporter.buildSpec().threads, 3, '-threads is a number the renderer is given');
    ok(A.command.currentCommand().indexOf('-thread_type:v slice') > 0 ||
       A.command.currentCommand().indexOf('-thread_type slice') > 0,
       'and the thread type is printed');
    f('threads').value = '0';
    f('threads').dispatchEvent(new Event('change'));
    f('threadtype').value = '';
    f('threadtype').dispatchEvent(new Event('change'));
    pump(60);
    ok(A.command.currentCommand().indexOf('-threads') < 0,
       'auto prints nothing, because it is what every render has always done');

    f('shortest').click();
    pump(60);
    same(A.exporter.buildSpec().shortest, true, '-shortest reaches the renderer');
    ok(A.command.currentCommand().indexOf('-shortest') > 0, 'and is printed');
    f('shortest').click();
    pump(60);
    f('advanced').click();
    pump(40);
}

console.log('\na bitstream filter on a stream');
{
    A.shell.goTo('write');
    pump(60);
    ok(Array.isArray(bro.ffmpeg.bitstreamFilters) && bro.ffmpeg.bitstreamFilters.length > 0,
       `libavcodec's own list of bitstream filters (${bro.ffmpeg.bitstreamFilters.length})`);

    const rows = qq('#ex-streams [data-stream]');
    const video = rows[0];
    video.querySelector('[data-f="detail"]').click();
    pump(60);
    ok(!!q('[data-add="bsf"]'), 'the video row offers a packet chain');
    q('[data-add="bsf"]').click();
    pump(60);

    const pick = f('bsf-0');
    ok(!!pick, 'which is a list, in the order it runs');
    // Narrowed to what will run on this stream's codec, out of each filter's
    // own `codec_ids` — so the menu cannot offer something the render refuses.
    let offered = [];
    for (const o of pick.options) offered.push(o.value);
    ok(offered.indexOf('h264_mp4toannexb') >= 0,
       'offering the filters that run on h264');
    ok(offered.indexOf('hevc_mp4toannexb') < 0,
       'and not the ones that declare a codec this stream is not');
    ok(offered.indexOf('setts') >= 0,
       'a filter that declares no codec list runs on anything, so it is always offered');

    pick.value = 'h264_metadata';
    pick.dispatchEvent(new Event('change'));
    pump(80);

    const spec0 = A.exporter.buildSpec();
    same(spec0.streams[0].bsf.length, 1, 'the chain reaches the spec');
    same(spec0.streams[0].bsf[0].name, 'h264_metadata', 'naming the filter');
    ok(A.command.currentCommand().indexOf('-bsf:v h264_metadata') > 0,
       'and the command bar prints it as -bsf:v');

    // Its own option table, out of the filter's own AVClass, in the same column
    // the encoder's and the muxer's options use.
    const search = f('bsfopts-' + rows[0].getAttribute('data-stream') + '-0');
    ok(!!search, 'with the filter’s own option table beside it');
    if (search) {
        search.value = 'level';
        search.dispatchEvent(new Event('input'));
        pump(60);
        const row = q('.ex-opt-row [data-opt="level"]');
        ok(!!row, 'searching it finds libavcodec’s own option');
        if (row) {
            row.value = '5.1';
            row.dispatchEvent(new Event('change'));
            pump(80);
            same(A.exporter.buildSpec().streams[0].bsf[0].options.level, '5.1',
                 'and a value set on it reaches the spec');
            ok(A.command.currentCommand().indexOf('h264_metadata=level=5.1') > 0,
               'printed the way av_bsf_list_parse_str takes it');
        }
    }

    // A chain is ordered, and the order is the meaning: two filters the other
    // way round are a different file.
    q('[data-add="bsf"]').click();
    pump(60);
    const second = f('bsf-1');
    if (second) {
        second.value = 'dump_extra';
        second.dispatchEvent(new Event('change'));
        pump(80);
        const chain = A.exporter.buildSpec().streams[0].bsf.map((b) => b.name);
        same(chain.join(','), 'h264_metadata,dump_extra', 'two filters run in the order shown');
        q('[data-bsf-move="1:-1"]').click();
        pump(80);
        same(A.exporter.buildSpec().streams[0].bsf.map((b) => b.name).join(','),
             'dump_extra,h264_metadata', 'and the arrows change what runs');
        q('[data-bsf-drop="0"]').click();
        pump(80);
    }
    q('[data-bsf-drop="0"]').click();
    pump(80);
    same((A.exporter.buildSpec().streams[0].bsf || []).length, 0,
         'and removing them leaves the stream as it was');
    A.shell.goTo('encode');
    pump(40);
}

// ── the packet path ────────────────────────────────────────────────────────
//
// A copied stream is the one row on this stage that is not encoded, and the
// three things worth checking are exactly the three things that make it a
// decision rather than a switch: that it can be taken on the row, that the
// keyframe it will actually start on is on the screen before the render, and
// that the edit it contradicts is refused by name.

console.log('\na stream copied rather than encoded');
{
    A.shell.goTo('write');
    pump(60);

    // Where a copy can start, asked of the input. This is the fact the whole
    // surface is built on, so it is checked as a binding first.
    const keys = bro.ffmpeg.keyframes(A.inputs.inputs[0].path);
    ok(keys && Array.isArray(keys.times) && keys.times.length > 0,
       `libavformat reports the keyframes (${keys.times.length}, from the ${keys.how})`);
    ok(keys.times[0] < 0.001,
       `the first is the start of the file (${keys.times[0].toFixed(3)} s)`);
    let rising = true;
    for (let i = 1; i < keys.times.length; i++)
        if (keys.times[i] <= keys.times[i - 1]) rising = false;
    ok(rising, 'and they come back in order');

    // The decision, on the row. The picker is the source: what the stream is
    // made of, or which input stream it is.
    const rows = () => qq('#ex-streams .ex-stream');
    const picker = q('[data-f="stream-source"]', rows()[0]);
    ok(!!picker, 'the video row offers where its content comes from');
    let offered = [];
    for (const o of picker.options) offered.push(o.value);
    ok(offered[0] === 'composite', 'the composite first, because that is what a render is');
    ok(offered.some((v) => /^copy:0:\d+$/.test(v)),
       `and a copy of each of the input’s streams (${offered.join(' ')})`);

    const wantVideo = offered.find((v) => /^copy:0:/.test(v));
    picker.value = wantVideo;
    picker.dispatchEvent(new Event('change'));
    pump(80);

    let spec = A.exporter.buildSpec();
    same(spec.streams[0].source, wantVideo, 'the choice reaches the spec as copy:<input>:<stream>');
    same(spec.streams[0].codec, '', 'with no encoder on it, because there is none to name');

    // What the row says, and what the command says. `-c:v copy` and a `-map`
    // that names an input pad rather than a filtergraph label.
    let text = A.command.currentCommand();
    ok(text.indexOf('-c:v copy') > 0, `the command prints -c:v copy (${text.indexOf('copy')})`);
    ok(/-map 0:\d+/.test(text), 'and a -map naming the input stream');

    // The keyframe surface. An in-point between two keyframes is where a copy
    // costs something, and the whole point is that it says so beforehand.
    const from = q('#ex-streams [data-f="copy-copyFrom"]');
    ok(!!from, 'the row says what part of the input is copied');
    const between = keys.times.length > 1 ? (keys.times[0] + keys.times[1]) / 2 : 0.37;
    from.value = String(between);
    from.dispatchEvent(new Event('change'));
    pump(80);

    ok(qq('#ex-streams .ex-kf').length === keys.times.length,
       `the keyframes are drawn, one mark each (${qq('#ex-streams .ex-kf').length})`);
    const note = q('#ex-streams .ex-copy-note');
    ok(!!note && note.textContent.indexOf('keyframe') >= 0,
       `and what the in-point costs is said in words (${note ? note.textContent : ''})`);
    const snap = q('#ex-streams [data-f="copy-snap"]');
    ok(!!snap, 'with the offer to snap to the keyframe it would start on anyway');

    // And the refusal, where the decision is: a copy cannot land at 0.37 s and
    // the warnings say so with both numbers.
    let said = A.exporter.currentWarnings().join(' | ');
    ok(said.indexOf('keyframe') >= 0 && said.indexOf('more than you asked for') >= 0,
       `the warnings name what the cut costs (${said})`);

    snap.click();
    pump(80);
    spec = A.exporter.buildSpec();
    ok(Math.abs(spec.streams[0].copyFrom - keys.times[0]) < 0.001 ||
       Math.abs(spec.streams[0].copyFrom - keys.times[1]) < 0.001,
       `snapping puts the in-point on a keyframe (${spec.streams[0].copyFrom})`);
    said = A.exporter.currentWarnings().join(' | ');
    ok(said.indexOf('more than you asked for') < 0,
       'and then there is nothing left to warn about');

    // `-ss` goes in front of the `-i`, which is the distinction that decides
    // whether a copy is instant or is a read of the whole file. Taken from the
    // second keyframe, because the first is zero and prints nothing.
    if (keys.times.length > 1) {
        q('#ex-streams [data-kf="' + keys.times[1].toFixed(3) + '"]').click();
        pump(80);
        same(A.exporter.buildSpec().streams[0].copyFrom, keys.times[1],
             'clicking a keyframe is how a cut is put on one');
        text = A.command.currentCommand();
        const ss = text.indexOf('-ss ');
        const i = text.indexOf(' -i ');
        ok(ss > 0 && ss < i, `-ss is an input seek, printed before the -i (${ss} < ${i})`);
    }

    // What a copy contradicts. The picture is not decoded, so a filter on the
    // graph does not reach it — and saying nothing would leave a file that is
    // the input again and looks like a successful export.
    A.graph.overlay.insert('clip:' + A.project.clips[0].id + '/after-scale', 'hflip');
    pump(60);
    said = A.exporter.currentWarnings().join(' | ');
    // Named in full. `the filters on the Graph stage do not reach a copied
    // stream` and `the crop and opacity on this clip do not reach a copied
    // stream` share their tail, so the substring alone would have been
    // satisfied by whichever of the two happened to be there.
    ok(said.indexOf('the filters on the Graph stage do not reach a copied stream') >= 0,
       `a filter on the graph is refused against a copied stream (${said})`);
    A.graph.overlay.clear();
    pump(60);

    // The other three ways a copy contradicts the edit. Each is a setting
    // somebody made that will not be in the file, and each of them renders
    // *successfully* if it is not said — handing back the input again, which is
    // the worst outcome this stage has. Three claims, no render between them.
    {
        const clip = A.project.clips[0];
        const before = A.exporter.currentWarnings().join(' | ');
        ok(before.indexOf('a copy is one input’s packets') < 0 &&
           before.indexOf('the packets go into the file as they are') < 0 &&
           before.indexOf('a copy is not resized') < 0,
           'one clip, uncropped, at the source’s own size warns about none of the three');

        // A second clip. Counted rather than listed: what matters is that what
        // is in the file is one input's packets and not the composition.
        const was = A.project.clips.length;
        A.duplicateClip ? A.duplicateClip(clip)
                        : A.project.clips.push(Object.assign({}, clip,
                              { id: clip.id + 1000, start: clip.start + clip.length }));
        A.exporter.redraw();
        pump(60);
        said = A.exporter.currentWarnings().join(' | ');
        ok(said.indexOf('a copy is one input’s packets') >= 0 &&
           said.indexOf(`${A.project.clips.length} clips`) >= 0,
           `a second clip on the timeline is refused, counted (${said})`);
        A.project.clips.length = was;
        A.exporter.redraw();
        pump(60);

        // A crop. Nothing decodes the picture, so nothing can trim it.
        const crop = clip.xform.crop;
        clip.xform.crop = { l: 0.1, t: 0, r: 0, b: 0 };
        A.exporter.redraw();
        pump(60);
        said = A.exporter.currentWarnings().join(' | ');
        ok(said.indexOf('the crop and opacity on this clip do not reach a copied stream') >= 0,
           `a crop is refused (${said})`);
        clip.xform.crop = crop;

        // An output of a different size. A copy is not resized, so the file is
        // whatever went in — which the summary above it would still be calling
        // the output size.
        const S = A.exporter.currentSettings();
        const w = S.width, h = S.height;
        S.width = w + 320;
        A.exporter.redraw();
        pump(60);
        said = A.exporter.currentWarnings().join(' | ');
        ok(said.indexOf('a copy is not resized') >= 0 &&
           said.indexOf(`${S.width}×${S.height}`) >= 0,
           `an output of a different size is refused, with both sizes (${said})`);
        S.width = w; S.height = h;
        A.exporter.redraw();
        pump(60);
    }

    // The shortcut. Whatever it sets has to be visible in the list afterwards —
    // it writes ordinary rows and there is no hidden mode.
    ok(!!q('#ex-streams [data-rewrap]'), 'the stage offers to rewrap an input outright');
    q('#ex-streams [data-rewrap]').click();
    pump(80);
    spec = A.exporter.buildSpec();
    ok(spec.streams.length >= 1 && spec.streams.every((s) => /^copy:/.test(s.source)),
       `a rewrap makes every stream a copy (${spec.streams.map((s) => s.source).join(' ')})`);
    ok(qq('#ex-streams .ex-stream').length === spec.streams.length,
       'and the list says so — the shortcut leaves ordinary rows behind it');
    text = A.command.currentCommand();
    ok(text.indexOf('-c:v copy') > 0 && text.indexOf('-c:a copy') > 0,
       `the command copies both (${text})`);

    // ── the span, taken off the edit ───────────────────────────────────────
    //
    // A copy conflicts with everything else on the timeline and each conflict
    // is refused above. The span is the one thing that does *not* conflict:
    // a clip's in-point and a copy's `copyFrom` are the same moment on the
    // same clock — `-ss` before an `-i` decides where the input's zero is, and
    // a clip is cut out of what is left — so the numbers go across unchanged.
    // Until this existed they had to be read off the strip and typed.
    {
        const clip = A.project.clips[0];
        const wasIn = clip.inPoint, wasLen = clip.length, wasStart = clip.start;
        clip.inPoint = 1.5;
        clip.length = 3;
        // Explicit, so the assertion holds whether or not other sections have
        // left a second clip of this input on the timeline: with several, the
        // selected one is the only honest answer.
        A.selectMany([clip]);
        A.exporter.redraw();
        pump(80);

        const follow = q('#ex-streams [data-f="copy-follow"]');
        ok(!!follow, 'a copied row offers to take the span off the clip');
        ok(/1\.50/.test(follow.textContent) && /4\.50/.test(follow.textContent),
           `naming both numbers before it is pressed (${follow.textContent.trim()})`);

        follow.click();
        pump(80);
        const followed = A.exporter.buildSpec().streams[0];
        ok(Math.abs(followed.copyFrom - 1.5) < 0.001 &&
           Math.abs(followed.copyTo - 4.5) < 0.001,
           `and the row carries the clip's own in and out points ` +
           `(${followed.copyFrom} → ${followed.copyTo})`);

        // ── and it keeps following ─────────────────────────────────────────
        //
        // The row is bound to the clip now, not a photograph of it. What makes
        // that a link rather than a hidden mode is the two things checked here
        // straight after: the row says which clip it follows, and it offers to
        // stop — and what a following row *keeps* is `copyFrom`, the same field
        // somebody types in, so nothing downstream can tell one from the other.
        ok(!q('#ex-streams [data-f="copy-follow"]') &&
           !!q('#ex-streams [data-f="copy-unfollow"]'),
           'the row now says it is following and offers to stop, rather than offering to follow again');

        clip.inPoint = 2.5;
        A.changed('edit');
        pump(80);
        ok(Math.abs(A.exporter.buildSpec().streams[0].copyFrom - 2.5) < 0.001,
           `trimming the clip afterwards moves the row (${
               A.exporter.buildSpec().streams[0].copyFrom})`);

        // A ripple moves the clip's in-point and everything after it, which is
        // the third of the three gestures the row has to follow.
        A.rippleTrim(clip, 'start', clip.start + 0.5);
        A.changed('moved');
        pump(80);
        ok(Math.abs(A.exporter.buildSpec().streams[0].copyFrom - clip.inPoint) < 0.001,
           `and a ripple does too (${A.exporter.buildSpec().streams[0].copyFrom} = ` +
           `${clip.inPoint})`);

        // Breaking it leaves the numbers exactly where they are: a link broken is
        // not a trim undone.
        const held = A.exporter.buildSpec().streams[0].copyFrom;
        q('#ex-streams [data-f="copy-unfollow"]').click();
        pump(80);
        same(A.exporter.buildSpec().streams[0].copyFrom, held,
             'stopping leaves the numbers exactly where they were');
        clip.inPoint = 1.5;
        A.changed('edit');
        pump(80);
        same(A.exporter.buildSpec().streams[0].copyFrom, held,
             'and the row stops moving — what is left is two ordinary numbers');
        ok(!!q('#ex-streams [data-f="copy-follow"]'),
           'with the offer to follow it again back on the row');

        // ── a followed clip that is deleted ────────────────────────────────
        //
        // The link breaks and *says so*. A row left naming a clip id nothing
        // answers to is exactly the invisible mode the press this replaces was
        // written against. The clip that goes is a half made by splitting, so the
        // input is still on the timeline afterwards and the rest of this section
        // still has a clip to be about.
        {
            const made = A.splitAt(clip.start + clip.length / 2, false);
            ok(made > 0, `a split makes a second clip of the same input (${made})`);
            const half = A.project.clips.find((c) => c.input === clip.input && c !== clip);
            ok(!!half, 'which is the one to follow');
            A.selectMany([half]);
            A.exporter.redraw();
            pump(80);
            const on = q('#ex-streams [data-f="copy-follow"]');
            ok(!!on, 'the row offers to follow the selected one of the two');
            on.click();
            pump(80);
            ok(!!q('#ex-streams [data-f="copy-unfollow"]'), 'and follows it');

            const stood = A.exporter.buildSpec().streams[0].copyFrom;
            A.selectMany([half]);
            A.removeSelection();
            pump(150);
            ok(!q('#ex-streams [data-f="copy-unfollow"]'),
               'deleting that clip takes the link off the row');
            // On the row rather than only in the OSD, because a deletion says
            // "Removed landscape.mp4" of its own accord a moment after the
            // channel has spoken — a sentence that can be shouted over is not a
            // sentence.
            const said = q('#ex-streams [data-f="copy-broke"]');
            ok(!!said && /has gone/.test(said.textContent),
               `and the row says so rather than naming an id nothing answers to: ` +
               `“${said ? said.textContent.slice(0, 80) : 'nothing'}”`);
            same(A.exporter.buildSpec().streams[0].copyFrom, stood,
                 'with the span left exactly where it was');

            // Back to the trim the rest of this section is written against — the
            // split took half of it and the ripple half a second more.
            clip.inPoint = 1.5;
            clip.length = 3;
            A.selectMany([clip]);
            A.changed('edit');
            pump(80);
        }

        // The same decision as one press, which is what `Cut` is: a rewrap
        // with the edit's span on every row rather than none.
        A.exporter.redraw();
        pump(60);
        const cut = q('#ex-streams [data-cut]');
        ok(!!cut, 'and the shortcut beside Rewrap offers the whole thing as a cut');
        cut.click();
        pump(80);
        const cutSpec = A.exporter.buildSpec();
        ok(cutSpec.streams.length >= 1 &&
           cutSpec.streams.every((s) => Math.abs(s.copyFrom - 1.5) < 0.001 &&
                                        Math.abs(s.copyTo - 4.5) < 0.001),
           `every stream cut at the same pair of times (${cutSpec.streams.map(
               (s) => `${s.copyFrom}→${s.copyTo}`).join(' ')})`);

        // The file, because "the spec is right" is not the claim. What comes
        // out is a keyframe-aligned cut: at or *before* 1.5 s, never after, so
        // it is at least the three seconds asked for and nothing like the ten
        // the input is.
        const outCut = bro.appDir + '/../out/lossless-cut.mp4';
        f('path').value = outCut;
        f('path').dispatchEvent(new Event('change', { bubbles: true }));
        pump(80);
        el('ex-go').click();
        pump(60);
        waitFor('the lossless cut', () => {
            const st = A.exporter.lastStatus();
            return st && st.state !== 'running';
        }, 120000);
        const doneCut = A.exporter.lastStatus();
        same(doneCut.state, 'done', `it renders (${doneCut.error || 'no error'})`);
        const backCut = bro.ffmpeg.probe(outCut);
        ok(backCut.format.duration >= 2.9 && backCut.format.duration < 6,
           `and what came out is the cut and not the file (${
               backCut.format.duration.toFixed(2)}s from a ${
               clip.media.toFixed(2)}s input)`);

        // ── the link, through the document ─────────────────────────────────
        //
        // A link is a clip **id**, which is the one thing a document is careful to
        // put back unchanged — so a followed row survives a save and an open for
        // exactly the reason a graph anchor does. What it must not survive is
        // arriving in the *next* edit, where clip 7 is a different shot, and one
        // reader answers both questions: a link is kept only where the clip it
        // names is there. That is what the workspace's own read amounts to at
        // boot, where there are no clips at all.
        {
            const saved = A.doc.snapshot();
            const written = (saved.output.streams || [])[0];
            ok(written && written.followClip === clip.id,
               `a document carries the link as the clip's own id (${
                   written && written.followClip})`);

            A.documentOpened(A.doc.open(saved));
            pump(250);
            const back = A.exporter.currentSettings().streams[0];
            ok(!!back && back.followClip === clip.id,
               `and an open puts it back naming the same clip (${back && back.followClip})`);
            const kept = A.project.clips.find((c) => c.id === clip.id);
            ok(!!kept, 'with that clip still there, by the id it always had');
            kept.inPoint = 2;
            A.changed('edit');
            pump(80);
            ok(Math.abs(A.exporter.buildSpec().streams[0].copyFrom - 2) < 0.001,
               `and it is still following it afterwards (${
                   A.exporter.buildSpec().streams[0].copyFrom})`);

            const odd = JSON.parse(JSON.stringify(saved));
            for (const r of odd.output.streams) r.followClip = 987654;
            A.documentOpened(A.doc.open(odd));
            pump(250);
            ok(!A.exporter.currentSettings().streams.some((r) => r.followClip),
               'while a link naming a clip the document does not describe is dropped on the ' +
               'way in, which is the same read the workspace gets at boot');
        }

        clip.inPoint = wasIn; clip.length = wasLen; clip.start = wasStart;
    }

    // Back to a render, so everything after this is the file it always was.
    A.exporter.currentSettings().streams = A.exporter.defaultStreams();
    A.exporter.currentSettings().audio = true;
    A.exporter.redraw();
    pump(60);
    same(A.exporter.buildSpec().streams[0].source, 'composite',
         'and it goes back to being made');
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

// ── the title ──────────────────────────────────────────────────────────────
//
// A real field that reaches the render, and the named counterpart of
// `settings.metadata` — which is remembered between edits. This was neither:
// it committed without telling anything, so the command bar and the spine went
// on describing a render that no longer matched, and it was dropped on the way
// out. Not `changed`, because a title is metadata about the file rather than
// anything about the picture, and throwing away a candidate render that cost
// ten seconds over one is the division the stream list already draws.

console.log('\nthe title of the file');
{
    A.shell.goTo('encode');
    pump(60);
    if (!f('title')) { f('advanced').click(); pump(80); }
    ok(!!f('title'), 'the title is a field in the advanced column');
    f('title').value = 'Programme one';
    f('title').dispatchEvent(new Event('change'));
    pump(80);
    same(A.exporter.buildSpec().title, 'Programme one', 'and reaches the spec');
    ok(A.command.currentCommand().indexOf('title=Programme one') > 0,
       'the command says -metadata title=…, because it reaches the muxer');
    ok(el('cmd-line').textContent.indexOf('Programme one') > 0,
       'and the bar under the stage was re-said rather than left describing the old one');
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
// Starting a render is what writes the settings down, so this is where the
// remembered block can be read: `title` is in it, beside the metadata bag it
// is the named counterpart of.
{
    let blob = {};
    try { blob = JSON.parse(localStorage.getItem('ffmpeg-bro.export') || '{}'); } catch (e) {}
    same(blob.title, 'Programme one',
         'and the title is remembered for the next edit, as a codec or a language is');
}
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

    // **The two `<video>` elements are the decoders.** `prepare()` draws
    // everything and runs for the Encode stage *and* for the Write stage —
    // stepping between the two is one visit — so a stage rebuilt on every
    // arrival cloned a fresh `tpl-pv-wipe` and started both files again from
    // frame 0. Walking over to set a filename and back should not restart the
    // comparison you were half way through, which is checked here while it is
    // paused on a frame somebody went and found.
    {
        const at = cv.currentTime;
        ok(at > 0.05 && cv.paused, `paused on a frame in the middle (${at.toFixed(2)}s)`);
        A.shell.goTo('write');
        pump(160);
        A.shell.goTo('encode');
        pump(160);
        ok(q('#ex-pv-stage-host .pv-cand') === cv &&
           q('#ex-pv-stage-host .pv-ref') === rv,
           'the same two elements come back from the Write stage');
        ok(Math.abs(cv.currentTime - at) < 0.05,
           `and the picture stayed where it was (${cv.currentTime.toFixed(2)}s)`);
    }

    // **And naming the file does not throw the comparison away.** The reason
    // anybody walks to the Write stage half way through an A/B is to set the
    // filename, and every commit there used to run `invalidateCandidate()` —
    // so typing one discarded a candidate render and the PSNR numbers under
    // the wipe, both of which cost ten seconds. `referenceKey()` already
    // leaves the path out; this is the other half of that decision.
    {
        const was = A.exporter.currentSettings().path;
        A.shell.goTo('write');
        pump(120);
        const field = q('#st-write [data-f="path"]');
        ok(!!field, 'the Write stage has the path field');
        field.value = 'out/export-renamed.mp4';
        field.dispatchEvent(new Event('change'));
        pump(120);
        ok(A.exporter.currentSettings().path === 'out/export-renamed.mp4',
           'typing a filename sets it');
        const st = A.exporter.previewState();
        ok(st.refReady && st.candReady,
           'and both halves of the comparison survive it');
        ok(!!st.stats && st.stats.bytes > 0,
           `along with what the candidate measured (${st.stats ? st.stats.bytes : 0} bytes)`);
        ok(A.command.currentCommand().indexOf('export-renamed.mp4') > 0,
           'while the command bar says where it now goes');

        // image2 is the exception and has to stay one: its extension names a
        // *codec*, so a path really can change what the encoder is, and then
        // the candidate is of something else and must go. Everything the
        // container change touches is put back afterwards — `ui/.storage.json`
        // carries settings between runs, and a section that leaves the encoder
        // somewhere odd fails a section four hundred lines away in the next one.
        const held = { container: S.container, videoCodec: S.videoCodec,
                       rate: S.rate, quality: S.quality };
        S.container = 'image2';
        field.value = 'out/export-renamed%04d.png';
        field.dispatchEvent(new Event('change'));
        pump(120);
        ok(S.videoCodec === 'png', `an image2 path chooses the encoder (${S.videoCodec})`);
        ok(!A.exporter.previewState().candReady,
           'and that one does invalidate the candidate, because it changed the picture');

        S.container = held.container;
        S.videoCodec = held.videoCodec;
        S.rate = held.rate;
        S.quality = held.quality;
        field.value = was;
        field.dispatchEvent(new Event('change'));
        pump(120);
        ok(S.path === was && S.videoCodec === held.videoCodec,
           'and the settings are put back as they were found');
        A.shell.goTo('encode');
        pump(160);
    }

    screenshot('out/export-03b-playing.png');
    A.exporter.togglePreviewPlay();
    pump(60);

    // Changing the quality does not change the picture the encoder was given,
    // so a second preview only has to redo the candidate. Re-rendering the
    // reference every time would double the wait for no reason.
    const key = pv.refKey;
    P.quality = 20;
    A.exporter.currentOptions();
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
    pump(60);
    ok(A.exporter.previewState().refReady && !A.exporter.previewState().candReady,
       'changing the quality invalidates the candidate but keeps the reference');
    ok(A.exporter.previewState().refKey === key, 'because the reference is of the same frames');

    // Changing the output size does change them.
    P.width = 640; P.height = 360;
    // Any control's change redraws the bar; the codec select is the one that
    // is always there whatever the stage is set to.
    f('vcodec').dispatchEvent(new Event('change'));
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

/// Bring up the `+` on the wire that carries a named insert point.
///
/// They appear on the wire under the pointer rather than on every wire at once —
/// five of them permanently on screen read as part of the graph, and n8n, which
/// is where the gesture is from, shows it on hover for the same reason. So a test
/// has to do what a person does: move along the wires until the one it wants
/// shows itself.
function revealPoint(id) {
    const seen = {};
    const rect = q('#gr-viewport').getBoundingClientRect();
    const count = (A.graph.placement() || { wires: [] }).wires.length;
    for (let i = 0; i < count; i++) {
        // Several points along the curve, not only its middle: a short wire
        // between two tall cards has its middle underneath one of them, and a
        // pointer over a card is not over a wire.
        for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
            // Read afresh every time. A preview landing on any card redraws the
            // stage and re-lays it out, so a placement captured before the loop
            // describes where the wires *were* — which is how this test spent a
            // while hovering empty canvas.
            const pl = A.graph.placement();
            if (!pl || !pl.wires[i]) break;
            const p = onWire(pl.wires[i], t, pl);
            mouseMove(rect.left + p.x, rect.top + p.y);
            pump(30);
            for (const b of qq('#gr-nodes .gp-plus')) seen[b.getAttribute('data-point')] = 1;
            const at = q(`#gr-nodes [data-point="${id}"]`);
            if (at) return at;
        }
    }
    console.log(`    (wanted ${id}; the wires offered ${Object.keys(seen).join(', ') || 'nothing'})`);
    return null;
}

/// A point on a wire, in viewport pixels — the same cubic `graph/canvas.js`
/// strokes and hit-tests, with the same horizontal control points.
function onWire(w, t, pl) {
    const x1 = w.x1 * pl.zoom + pl.panX, y1 = w.y1 * pl.zoom + pl.panY;
    const x2 = w.x2 * pl.zoom + pl.panX, y2 = w.y2 * pl.zoom + pl.panY;
    const reach = Math.max(24, Math.abs(x2 - x1) * 0.45);
    const u = 1 - t;
    return {
        x: u * u * u * x1 + 3 * u * u * t * (x1 + reach) + 3 * u * t * t * (x2 - reach) + t * t * t * x2,
        y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2,
    };
}

console.log('\na filter inserted on the graph');
{
    A.graph.overlay.clear();
    q('#spine [data-stage="graph"]').click();
    pump(300);

    const clipId = A.project.clips[0].id;
    same(qq('#gr-nodes .gp-plus').length, 0,
         'no + until the pointer is on a wire — otherwise they read as the graph');
    const at = revealPoint(`clip:${clipId}/after-scale`);
    ok(!!at, 'hovering the right wire brings up the one after the clip is sized');
    same(qq('#gr-nodes .gp-plus').length, 1, 'and only that one');
    const plusBox = at.getBoundingClientRect();
    ok(Math.abs(plusBox.width - plusBox.height) < 1.5,
       `which is round rather than an oval (${Math.round(plusBox.width)}x${Math.round(plusBox.height)})`);

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

    // And the viewer shows it. `hflip` keeps the size of the picture, so the
    // clip's element is pointed at its input with the chain on it rather than
    // at the input alone — see ui/graph/playback.js. The `fx` badge is what a
    // clip wears when playback *cannot* show its filters, so its absence here
    // is the assertion: an unmarked picture that was not filtered would read as
    // the filter not working.
    ok((A.project.clips[0].video.src || '').indexOf('/@fx/') === 0,
       'and the viewer plays the filter rather than the file');
    ok(qq('#viewer .clipframe.filtered').length === 0,
       'so nothing is badged as unshowable');

    screenshot('out/export-05-graph-with-a-filter.png');

    // And it renders. Small and short: what is being proved is that the graph
    // this UI wrote is one libavfilter takes, not that x264 works.
    const r = A.exporter.buildSpec({
        width: 320, height: 180, fps: 25,
        end: Math.min(A.exporter.buildSpec().end, A.exporter.buildSpec().start + 1),
        path: bro.appDir + '/../out/ui-export-inserted.mp4',
    });
    ok(r.filterGraph.indexOf('hflip') > 0, 'a preview-sized spec carries it too');

    // The sound goes with it. A clip's picture and its sound leave one input
    // node by two pads, and the whole of that being right is `[0:a]` naming the
    // *audio* pad of input zero: get the port wrong and this chain reads the
    // picture, which parses, renders nothing, and comes out as a silent file
    // that nobody looks at because the picture is fine.
    ok(/(^|;)\[0:a\]atrim=/.test(r.filterGraph),
       `and the clip’s sound, read from its own pad: ${r.filterGraph.split(';')
           .filter((c) => c.indexOf('[0:a]') === 0).join(';') || '(no audio chain)'}`);
    const aPads = (r.filterInputs || []).filter((i) => i.stream === 'a');
    same(aPads.length, 1, 'one audio pad, on the same file the picture comes from');
    ok(aPads.length === 1 && aPads[0].path === (r.filterInputs[0] || {}).path,
       'which is the same `-i` — one file, two outputs, not two inputs');

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
        // The other half of the file. `hasAudio()` on this path is "did a chain
        // end on a sound pad", so a graph whose audio side never reached the
        // renderer writes a video-only file and every picture check still
        // passes.
        const heard = (p.streams || []).filter((s) => s.kind === 'audio');
        same(heard.length, 1, 'with the soundtrack the graph describes');
    }

    // **And the other outcome, which is the one that has to be said out loud.**
    // A graph the derivation refuses does not stop the render: it goes through
    // the internal compositor instead, which has no filter path in it at all,
    // and what comes out is a successful file with the filters missing. That is
    // the failure the whole lock discipline exists against, so `warnings.js`
    // says so with the reason — and nothing asserted it. A node placed and not
    // wired is the ordinary way to be in that state.
    {
        const stray = A.graph.overlay.addNode('vflip');
        A.exporter.redraw();
        pump(80);
        const spec = A.exporter.buildSpec();
        same(spec.filterGraph, undefined,
             'a graph with a problem in it is not attached to the spec');
        const said = A.exporter.currentWarnings().join(' | ');
        ok(said.indexOf('would go through the internal compositor without your filters') >= 0,
           `and the stage says the render will happen without them (${said})`);
        ok(/vflip/.test(said), 'with the reason, which names the node it is about');
        A.graph.overlay.removeInsert(stray.id);
        A.exporter.redraw();
        pump(80);
        ok(!!A.exporter.buildSpec().filterGraph,
           'and taking it off puts the render back on the graph path');
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
    same(shots.length, cards.length, `every node gets one (${shots.length} of ${cards.length})`);
    ok(failed.length === 0,
       `and none of them failed${failed.length ? ': ' + failed[0].textContent : ''}`);
    // A `<video>` per card, and the same count as boxes — this is the check
    // that caught bro's `replaceChildren()` destroying the subtree it removes,
    // which left eight of nine cards empty with nothing in the code to see.
    same(videos.length, shots.length, 'each with its own player, kept across redraws');

    // The sound side gets a waveform `showwaves` drew from the very samples on
    // that pad — a picture of the thing rather than no picture at all, which is
    // what it used to be. Still a `<video>`, because it is one: the render
    // carries the drawing and the sound it was drawn from.
    const audioCard = q('#gr-nodes [data-key$="/atrim"]');
    const waveBox = audioCard && audioCard.querySelector('.gn-shot');
    ok(!!waveBox, 'the sound side gets one too, rather than an empty card');
    ok(waveBox && waveBox.classList.contains('gn-wave'),
       'marked as a waveform rather than a picture of something');
    ok(!!(waveBox && waveBox.querySelector('video')),
       'and it is a video, because it plays and it is heard');

    const aShot = A.graph.preview.shotFor(audioCard.getAttribute('data-key'));
    ok(aShot && aShot.state === 'ready' && aShot.w > 0 && aShot.h > 0,
       `rendered, at the size the card asked for (${aShot && aShot.w}x${aShot && aShot.h})`);
    ok(aShot && aShot.graph && aShot.graph.audio === true,
       'and it knows it has a soundtrack, which is what unmutes it on play');
    // Wider than tall, and not the picture's shape: a waveform is read across.
    ok(aShot && aShot.h < aShot.w, 'wider than tall, the way a waveform is read');

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

// ── the conventions a node editor is expected to have ──────────────────────
//
// Sockets, a header you can drag, fields on the card, a minimap and a level of
// detail. None of this is decoration: a graph with wires arriving at a bare edge
// cannot say which of `overlay`'s two inputs is the canvas, and a graph you
// cannot rearrange is one you cannot pull apart to read.

console.log('\nsockets, where the wires land');
{
    const pl = A.graph.placement();
    const overlayBox = pl.nodes.find((b) => b.node.filter === 'overlay');
    const card = q(`#gr-nodes [data-node="${overlayBox.node.id}"]`);
    const ins = qq('.gn-sock-in', card);
    same(ins.length, 2, 'the compositor shows a socket for each of its two inputs');
    same(qq('.gn-sock-out', card).length, 1, 'and one for what it produces');

    // The point of drawing them at all: a dot somewhere other than where the
    // curve lands would say this wire goes to that port when it does not.
    const wires = pl.wires.filter((w) => w.edge.to === overlayBox.node.id)
                          .sort((a, b) => a.edge.port - b.edge.port);
    same(wires.length, 2, 'and two wires arrive');
    const tops = Array.from(ins, (s) => parseFloat(s.style.top) + 4).sort((a, b) => a - b);
    const lands = wires.map((w) => w.y2 - overlayBox.y).sort((a, b) => a - b);
    for (let i = 0; i < 2; i++)
        ok(Math.abs(tops[i] - lands[i]) < 1.5,
           `socket ${i} is where its wire lands (${tops[i].toFixed(1)} vs ${lands[i].toFixed(1)})`);

    const sinkCard = q('#gr-nodes [data-key="out:v"]');
    same(qq('.gn-sock-out', sinkCard).length, 0, 'and the muxer’s pad produces nothing further');
}

console.log('\na value typed on the card itself');
{
    const key = `clip:${A.project.clips[0].id}/scale`;
    const field = q(`#gr-nodes [data-key="${key}"] [data-f-name="pos:0"]`);
    ok(!!field, 'the width is a field on the card, not only in the column');

    field.value = '900';
    field.dispatchEvent(new Event('change'));
    pump(200);
    ok(A.graph.overlay.isLocked(key), 'typing in it locks the node, as the column does');
    ok(A.command.currentCommand().indexOf('scale=900:') > 0,
       'and the command bar is already printing it');

    // The edit rebuilt every card. If the field you were using did not come back
    // focused, a second value cannot be typed without finding it again — which is
    // the difference between a control and a form you have to keep clicking.
    textInput('1');
    pump(80);
    const again = q(`#gr-nodes [data-key="${key}"] [data-f-name="pos:0"]`);
    same(again.value, '9001', 'and the field it rebuilt is still the one you are typing into');
    again.value = '900';
    again.dispatchEvent(new Event('change'));
    pump(150);

    // Through the button rather than through `overlay.unlock()`: the command bar
    // is redrawn by the application's own change hook, so a test that reaches
    // past the UI to the model asks a stale string whether the edit took.
    q(`#gr-nodes [data-key="${key}"]`).click();
    pump(80);
    q('#gr-panel [data-f="unlock"]').click();
    pump(150);
    same(A.graph.summary().locks, 0, 'and unlocking hands it back to the derivation');
    ok(A.command.currentCommand().indexOf('scale=900:') < 0, 'command and all');
}

console.log('\na node dragged where you want it');
{
    const key = `clip:${A.project.clips[0].id}/trim`;
    const card = () => q(`#gr-nodes [data-key="${key}"]`);
    const before = parseFloat(card().style.left);
    const head = q('.gn-head', card()).getBoundingClientRect();

    mouseDown(head.left + head.width / 2, head.top + head.height / 2);
    mouseMove(head.left + head.width / 2 + 60, head.top + head.height / 2 + 120);
    pump(60);
    mouseUp(head.left + head.width / 2 + 60, head.top + head.height / 2 + 120);
    pump(200);

    const pin = A.graph.overlay.pinOf(key);
    ok(!!pin, 'letting go pins it where it was dropped');
    ok(Math.abs(parseFloat(card().style.left) - before) > 20,
       `and it is drawn there (${before} → ${card().style.left})`);

    // The whole reason a pin is keyed by anchor: this is what a timeline edit
    // does to the graph, and the node it made is not the node that was dragged.
    A.graph.draw();
    pump(120);
    same(A.graph.overlay.pinOf(key).x, pin.x, 'and it survives the skeleton being rebuilt');

    // A pin is visual. Nothing that was not dragged moves for it.
    q('#gr-relayout').click();
    pump(200);
    same(A.graph.overlay.pinCount(), 0, 'Re-layout gives the whole graph back to the layout');
}

console.log('\nselecting several at once');
{
    // Left-drag on the background is a rubber band, as it is in Nuke, Houdini
    // and Blender — which is why middle-drag is what pans.
    const vp = q('#gr-viewport').getBoundingClientRect();
    mouseDown(vp.left + 4, vp.top + 4);
    mouseMove(vp.left + vp.width - 8, vp.top + vp.height - 8);
    pump(60);
    mouseUp(vp.left + vp.width - 8, vp.top + vp.height - 8);
    pump(120);
    ok(qq('#gr-nodes .gn.on').length > 4,
       `a band over the graph takes in what it covers (${qq('#gr-nodes .gn.on').length})`);
    same(qq('#gr-nodes .gn.primary').length, 1, 'with one of them the one the column is about');
    ok(q('#gr-panel .gp-badge').textContent.indexOf('more') > 0,
       `and the column says there are others: "${q('#gr-panel .gp-badge').textContent}"`);

    // Delete takes away what a person put there and leaves the derivation alone:
    // a derived node *is* the edit, and the way to be rid of one is to change it.
    const before = A.graph.summary().nodes;
    key('Delete');
    pump(150);
    same(A.graph.summary().nodes, before,
         'Delete over a selection of derived nodes removes none of them');

    key('Escape');
    pump(80);
    same(qq('#gr-nodes .gn.on').length, 0, 'Escape clears the selection');
    ok(!q('#st-graph.hidden'), 'and stays on the stage — the second Escape is the one that leaves');
}

console.log('\nfinding your way around it');
{
    ok(!!q('#gr-mini'), 'there is a minimap');
    const mini = q('#gr-mini').getBoundingClientRect();
    ok(mini.width > 100 && mini.height > 60, `and it has a size (${mini.width}x${mini.height})`);

    q('#gr-zoom').click();
    pump(120);
    same(q('#gr-zoom').textContent, '100%', 'the readout is a button back to 1:1');
    ok(qq('#gr-nodes .gn-f').length > 0, 'at which every value is on its card');

    // Zoomed out far enough that 10px argument text stops being text, the cards
    // are their names and their pictures. Nine grey smudges is not a graph.
    for (let i = 0; i < 6; i++) { q('#gr-zoom-out').click(); pump(50); }
    pump(150);
    ok(parseInt(q('#gr-zoom').textContent, 10) < 60, `and it zooms out (${q('#gr-zoom').textContent})`);
    same(qq('#gr-nodes .gn-f').length, 0, 'where the bodies are not drawn at all');
    ok(qq('#gr-nodes .gn-name').length > 5, 'but every node is still named');
    screenshot('out/export-09-graph-zoomed-out.png');

    q('#gr-fit').click();
    pump(200);
    ok(qq('#gr-nodes .gn-f').length > 0, 'and Fit brings the values back');
    ok(parseInt(q('#gr-zoom').textContent, 10) >= 60,
       'because Fit never crosses the threshold it would have to measure twice for');
    screenshot('out/export-10-graph.png');
}

// ── and the whole render, played ───────────────────────────────────────────
//
// The one node on the screen that means "the render" is the pad the muxer maps,
// and playing *that* is what somebody who has just built a graph wants to do
// with it. Everything below is real: every second of picture is a render
// through libavfilter, which is why the checks are about the clock advancing
// and the rate being reported rather than about smoothness, which no test can
// see.

console.log('\nplaying a node');
{
    const outCard = q('#gr-nodes [data-key="out:v"]');
    ok(outCard && outCard.querySelector('.gn-shot'),
       'the pad the muxer maps has a picture too — it is the render');

    const button = q('#gr-nodes [data-play="out:v"]');
    ok(!!button, 'and a play button on it');
    button.click();
    pump(200);
    same(A.graph.preview.playingKey(), 'out:v', 'clicking it plays that node');

    const box = q('#gr-nodes [data-key="out:v"] .gn-shot');
    same(qq('video', box).length, 2,
         'with two players: one showing and one already decoding what comes next');
    ok(!!q('.gn-playbar', box), 'and a readout over the picture');

    // The clock has to actually move, and it has to move past the end of the
    // first piece — which is the whole mechanism: a second render, handed over
    // without the picture stopping.
    const began = A.graph.preview.playStats().at;
    waitFor('the playback to cross into a second rendered piece',
            () => A.graph.preview.playStats() &&
                  A.graph.preview.playStats().at > began + 2.1, 60000);
    const st = A.graph.preview.playStats();
    ok(st.at > began + 2.1, `the clock ran on (${began.toFixed(2)} → ${st.at.toFixed(2)})`);
    ok(st.rate > 0.05 && st.rate <= 1.6,
       `at a rate it reports rather than assumes (${st.rate.toFixed(2)}×)`);
    // Re-found rather than reused: a still landing on another card redraws the
    // stage, and the box captured above is the previous generation of it —
    // alive, because `put()` detaches rather than destroys, and no longer the
    // one anything is writing to.
    const bar = q('#gr-nodes [data-key="out:v"] .gn-playbar');
    ok(/\d\.\d\d×/.test(bar.textContent), `and says so on the card: "${bar.textContent}"`);

    screenshot('out/export-08-playing-a-node.png');

    q('#gr-nodes [data-play="out:v"]').click();
    pump(200);
    same(A.graph.preview.playingKey(), null, 'clicking again stops it');
    const after = q('#gr-nodes [data-key="out:v"] .gn-shot');
    same(qq('video', after).length, 1, 'and the second player goes away with it');
    ok(!q('.gn-playbar', after), 'along with the readout');

    // Two nodes cannot play at once: the host has one render slot, and the
    // second would not be a second playback so much as two stutters.
    q('#gr-nodes [data-play="out:v"]').click();
    pump(120);
    const other = q('#gr-nodes [data-play$="/scale"]');
    if (other) {
        other.click();
        pump(120);
        ok(A.graph.preview.playingKey() !== 'out:v',
           'starting another moves the playback rather than adding one');
        same(qq('#gr-nodes .gn-playbar').length, 1, 'and there is only ever one');
    }
    A.graph.preview.stopPlay();
    A.graph.draw();
    pump(120);
}

// ── and the sound, played ──────────────────────────────────────────────────
//
// Same machinery, same button, same two-element swap — because a waveform
// preview is a video with a soundtrack and not a special case of anything. What
// is different is that it is *heard*, which is the one thing on this screen
// that has to be true only while somebody asked for it: nine cards looping
// their two seconds at once is a room nobody can think in.

console.log('\nplaying a sound pad');
{
    const key = 'out:a';
    const card = q(`#gr-nodes [data-key="${key}"]`);
    ok(!!card, 'the pad the muxer maps on the sound side is on the screen');
    const still = card && card.querySelector('.gn-shot video');
    ok(still && still.muted === true, 'its waveform loops silently, like every other card');

    const button = q(`#gr-nodes [data-play="${key}"]`);
    ok(!!button, 'and it has the same play button the picture side has');
    button.click();
    pump(200);
    same(A.graph.preview.playingKey(), key, 'clicking it plays that pad');

    const box = q(`#gr-nodes [data-key="${key}"] .gn-shot`);
    same(qq('video', box).length, 2, 'with the same two players');
    let silent = 0;
    for (const v of qq('video', box)) if (v.muted) silent++;
    same(silent, 0, 'unmuted, because playing a sound pad is how you hear it');

    const began = A.graph.preview.playStats().at;
    waitFor('the sound playback to cross into a second rendered piece',
            () => A.graph.preview.playStats() &&
                  A.graph.preview.playStats().at > began + 2.1, 60000);
    const st = A.graph.preview.playStats();
    ok(st.at > began + 2.1, `the clock ran on (${began.toFixed(2)} → ${st.at.toFixed(2)})`);

    q(`#gr-nodes [data-play="${key}"]`).click();
    pump(200);
    same(A.graph.preview.playingKey(), null, 'clicking again stops it');
    const quiet = q(`#gr-nodes [data-key="${key}"] .gn-shot video`);
    ok(quiet && quiet.muted === true, 'and the card goes quiet again');
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

// ── two pictures out of one render ─────────────────────────────────────────
//
// The other end of `ExportStream::source`'s `pad:<label>`. A file has been a
// list of streams for some time, and every one of them was fed from one of
// three places: the composite, the mix, or a demuxer. A **named output** is the
// fourth: a sink a person places on the graph, wires anything into, and then
// feeds a stream from on the Write stage — so one render can write the whole
// picture and a crop of it, at two different sizes, out of one decode.
//
// What is proved here is the join. `ui_graph.js` has the model and the printed
// label with no media at all; this is the real stage, the real command bar, the
// real render, and the file that comes out of it read back.

console.log('\na stream fed from a pad of the graph');
{
    // The previews hold the one render slot when they can, and this section
    // wants it. They stay off afterwards on purpose: what follows renders too,
    // and nothing after this is about a card's picture.
    if (A.graph.preview.isEnabled()) { q('#gr-previews').click(); pump(150); }
    A.graph.overlay.clear();
    A.shell.goTo('graph');
    pump(250);

    // The composite, forked: one half goes to the render's own sink as it
    // always did, the other is cropped and named. A `split` because a pad can
    // be read once — which is ffmpeg's rule, not this application's.
    const O = A.graph.overlay;
    const clipId = A.project.clips[0].id;
    const fork = O.addNode('split');
    const half = O.addNode('crop', { pos: ['iw/2', 'ih', '0', '0'] });
    const out = O.addOutput('v', 'left');
    O.wire(`composite/overlay:${clipId}`, 0, fork.id, 0);
    O.wire(fork.id, 0, 'out:v', 0);
    O.wire(fork.id, 1, half.id, 0);
    O.wire(half.id, 0, out.id, 0);
    A.graph.draw();
    pump(250);

    const summary = A.graph.summary();
    ok(summary.ok && summary.problems.length === 0,
       `the graph runs: ${summary.ok ? summary.problems.map((p) => p.reason).join(' | ') || 'nothing wrong'
                                     : summary.reason}`);
    const card = q(`#gr-nodes [data-key="${out.id}"]`);
    ok(!!card, 'the output is a card like any other');
    same(q('.gn-name', card).textContent, 'left', 'called by the name you gave it');

    // The Write stage. A second video row, fed from the pad rather than from
    // the composite — and it keeps its encoder, because unlike a copy it *is*
    // an encoded stream.
    A.shell.goTo('write');
    pump(200);
    const S = A.exporter.currentSettings();
    const keptStreams = S.streams;
    const keptSize = { w: S.width, h: S.height, q: S.quality,
                       a: S.rangeIn, b: S.rangeOut, path: S.path };
    S.streams = A.exporter.defaultStreams();
    A.exporter.redraw();
    pump(120);

    q('#ex-streams [data-add="video"]').click();
    pump(150);
    const vrows = qq('#ex-streams [data-kind="video"]');
    same(vrows.length, 2, 'there are two video rows on the stage');
    const picker = q('[data-f="stream-source"]', vrows[1]);
    const offered = [];
    for (const o of picker.options) offered.push(o.value);
    ok(offered.indexOf('pad:left') >= 0,
       `the graph’s named outputs are offered as sources: ${offered.join(' ')}`);
    picker.value = 'pad:left';
    picker.dispatchEvent(new Event('change'));
    pump(200);

    ok(!!q('[data-f="stream-codec"]', qq('#ex-streams [data-kind="video"]')[1]),
       'a pad-fed row still picks an encoder — it is encoded, unlike a copy');

    // Two renders' worth of settings, small enough to be a test.
    S.width = 320;
    S.height = 180;
    S.quality = 34;
    S.rangeIn = 0;
    S.rangeOut = 1;

    const spec = A.exporter.buildSpec();
    const vs = (spec.streams || []).filter((s) => s.kind === 'video');
    same(vs.length, 2, 'the spec carries both of them');
    same(vs[0].source, 'composite', 'the first is the render’s own picture');
    same(vs[1].source, 'pad:left', 'and the second names the pad by label');
    same(vs[1].width || 0, 0,
         'with no size on it — the job fills that in from the pad, which is the ' +
         'only thing that knows how big a picture is half way down a graph');
    ok(!!spec.filterGraph && spec.filterGraph.indexOf('[left]') >= 0,
       `and the graph the renderer is handed produces it: ${spec.filterGraph || 'none'}`);

    A.command.draw();
    const text = A.command.currentCommand();
    ok(text.indexOf('-map "[left]"') >= 0,
       `the command bar maps it as ffmpeg would: ${text.slice(text.indexOf('-map'))}`);
    same(text.split('-map').length - 1, 3,
       'three -maps: the composite, the mix and the pad');

    const outPath = bro.appDir + '/../out/ui-export-pads.mp4';
    f('path').value = outPath;
    f('path').dispatchEvent(new Event('change', { bubbles: true }));
    pump(120);

    el('ex-go').click();
    pump(60);
    waitFor('the two-picture render', () => {
        const s = A.exporter.lastStatus();
        return s && s.state !== 'running';
    }, 180000);
    const done = A.exporter.lastStatus();
    same(done.state, 'done', `it renders (${done.error || 'no error'})`);

    const back = bro.ffmpeg.probe(outPath);
    const got = (back.streams || []).filter((s) => s.kind === 'video');
    same(got.length, 2, 'two video streams came out of one render');
    same(got[0].width, 320, `the composite is the size the settings asked for (${got[0].width})`);
    same(got[1].width, 160,
         `and the pad is the size the crop made it, which nothing outside libavfilter ` +
         `could have said (${got[1].width})`);
    same(got[1].height, got[0].height, 'at the same height, because only the width was cut');

    // **Renaming it on the graph moves the row that is fed from it.** One fact
    // in two places is the failure: a row left naming the old label would be
    // refused by the renderer for a pad that no longer exists, over a rename
    // that changed nothing about the graph.
    A.shell.goTo('graph');
    pump(200);
    q(`#gr-nodes [data-key="${out.id}"]`).click();
    pump(120);
    const nameField = q('#gr-panel [data-f="outname"]');
    ok(!!nameField, 'the panel edits the output’s name');
    same(nameField.value, 'left', 'showing what it is called');
    nameField.value = 'wide';
    nameField.dispatchEvent(new Event('change'));
    pump(200);
    same(A.exporter.buildSpec().streams.filter((s) => s.kind === 'video')[1].source,
         'pad:wide', 'and the stream fed from it followed the name');
    ok(A.exporter.currentWarnings().every((w) => w.indexOf('no pad called') < 0),
       'so nothing is left naming a pad that is not there');

    // ...and when it does not, which is what the warning is for. Renamed on the
    // model rather than through the panel, because a row that has come adrift is
    // reachable — a stored stream list outlives the graph it was written against.
    A.shell.goTo('write');
    pump(150);
    O.renameOutput(out.id, 'right');
    pump(60);
    const said = A.exporter.currentWarnings().join(' | ');
    ok(/has no pad called that/.test(said),
       `a row naming a pad that is not there is said out loud: ${said}`);
    ok(/nothing in the file is fed from \[right\]/.test(said),
       'and so is an output nothing reads, which is legal and is probably not what ' +
       'somebody who named a pad meant');

    // Leave the settings as they were found: `.storage.json` carries them into
    // the next run, and a suite that passes on a clean checkout and fails on
    // the second is the documented cost of not doing this.
    O.clear();
    S.streams = keptStreams;
    S.width = keptSize.w;
    S.height = keptSize.h;
    S.quality = keptSize.q;
    S.rangeIn = keptSize.a;
    S.rangeOut = keptSize.b;
    S.path = keptSize.path;
    A.exporter.redraw();
    pump(80);
}

// ── a timeline with no soundtrack anywhere on it ───────────────────────────
//
// **The Write stage cannot claim a stream the render will drop.** Native works
// it out by opening: `wantAudio` is set only where a clip's audio actually
// opened, and `outputStreams()` then leaves out every non-copied audio stream.
// This side had no equivalent term — a row tested `settings.audio` and the
// derivation tested `muted`/`volume`, neither of which knows what is in the
// file — so a video-only timeline drew "A1 · the mix, through aac" and the
// command bar printed `[0:a]atrim…`, `-map [a0]` and `-c:a aac` against an `-i`
// with no audio in it. Pasted into a real ffmpeg that is *Stream specifier ':a'
// matches no streams*, which is the whole printed-command claim breaking.
//
// It goes last because it clears the timeline.

if (videoOnly) {
    console.log('\na timeline with no soundtrack anywhere on it');
    A.shell.goTo('compose');
    pump(80);
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    for (const i of A.inputs.inputs.slice()) A.inputs.removeInput(i);
    pump(120);

    dropFiles(400, 300, [videoOnly]);
    waitFor('the video-only file to load', () => A.project.clips.length > 0);
    pump(200);

    const only = A.inputs.inputs[0];
    same(A.inputs.streamKinds(only).join(','), 'v',
         'the probe found a picture and nothing else');
    ok(!A.inputs.hasSound(only), 'so there is no soundtrack in it to read');

    const S2 = A.exporter.currentSettings();
    ok(S2.audio, 'Include audio is still on — nobody turned it off');
    ok(S2.streams.some((s) => s.kind === 'audio'),
       'and the row is still on the stage, because adding a file with sound would use it');

    A.shell.goTo('write');
    pump(150);
    // The note itself, not the row's `textContent` — a row carries an encoder
    // menu and reading the whole of it back would be quoting sixty codec names
    // into the log.
    const note = q('#ex-streams [data-kind="audio"] .ex-stream-none');
    ok(note && /will not be written/.test(note.textContent),
       `but it says so on the row (${note ? note.textContent.trim() : 'nothing said'})`);

    const spec2 = A.exporter.buildSpec();
    ok(!(spec2.streams || []).some((s) => s.kind === 'audio'),
       'the spec carries no audio stream, which is what the renderer would do anyway');

    A.command.draw();
    const line2 = A.command.currentCommand();
    ok(line2.indexOf('[0:a]') < 0, 'the printed graph reads no pad the -i does not produce');
    ok(line2.indexOf('-map "[a0]"') < 0 && line2.indexOf('-map [a0]') < 0,
       'nothing is mapped from one');
    ok(line2.indexOf('-c:a') < 0, 'no audio encoder is named');
    ok(line2.indexOf(' -an') >= 0, 'and -an says so out loud, as ffmpeg spells it');

    // The render itself, because "the spec is right" is not the claim — the
    // claim is that what comes out is a file, and a video-only render is the
    // one this used to describe wrongly.
    S2.width = 160; S2.height = 90; S2.quality = 34;
    S2.rangeIn = 0; S2.rangeOut = 1;
    const out2 = bro.appDir + '/../out/silent-render.mp4';
    f('path').value = out2;
    f('path').dispatchEvent(new Event('change', { bubbles: true }));
    pump(80);
    el('ex-go').click();
    pump(60);
    waitFor('the video-only render', () => {
        const s = A.exporter.lastStatus();
        return s && s.state !== 'running';
    }, 120000);
    const done2 = A.exporter.lastStatus();
    same(done2.state, 'done', `it renders (${done2.error || 'no error'})`);
    const back = bro.ffmpeg.probe(out2);
    ok(!!back.video, 'and what came out has a picture in it');
    ok(!back.audio, 'and no audio stream, which is what every screen said');
} else {
    console.log('\n(no video-only file given — the silent-timeline section is skipped)');
}

// ── a timeline with no picture anywhere on it ──────────────────────────────
//
// The mirror of the section above, and the reason it is a section of its own is
// that the two are answered in different places. Native decides about the mix by
// opening; it cannot decide about the composite the same way, because a graph
// with a generator in it composes a picture out of nothing at all — so this side
// is the only one that can say a timeline of nothing but sound has no picture to
// write. Without the term the Write stage drew "V1 · the composite, through
// libx264" and the render put a black rectangle at the canvas size into the
// file: not a failure, which is what makes it worth a test.

if (soundOnly) {
    console.log('\na timeline with no picture anywhere on it');
    A.shell.goTo('compose');
    pump(80);
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    for (const i of A.inputs.inputs.slice()) A.inputs.removeInput(i);
    pump(120);

    dropFiles(400, 300, [soundOnly]);
    waitFor('the sound-only file to load', () => A.project.clips.length > 0);
    pump(200);

    const only = A.inputs.inputs[0];
    same(A.inputs.streamKinds(only).join(','), 'a',
         'the probe found a soundtrack and nothing else');
    const clip = A.project.clips[0];
    ok(clip.length > 1, `and it laid out with a real length (${clip.length.toFixed(3)}s)`);

    const S4 = A.exporter.currentSettings();
    ok(S4.streams.some((s) => s.kind === 'video'),
       'the video row is still on the stage, because adding a file with a picture would use it');

    A.shell.goTo('write');
    pump(150);
    const note4 = q('#ex-streams [data-kind="video"] .ex-stream-none');
    ok(note4 && /will not be written/.test(note4.textContent),
       `but it says so on the row (${note4 ? note4.textContent.trim() : 'nothing said'})`);

    const spec4 = A.exporter.buildSpec();
    ok(!(spec4.streams || []).some((s) => s.kind === 'video'),
       'the spec carries no video stream');
    ok((spec4.streams || []).some((s) => s.kind === 'audio'),
       'and does carry the soundtrack, which is the whole of what this render is');

    A.command.draw();
    const line4 = A.command.currentCommand();
    ok(line4.indexOf(' -vn') >= 0, '-vn says so out loud, as ffmpeg spells it');
    ok(line4.indexOf('-c:v') < 0, 'and no video encoder is named');

    // The render, because "the spec is right" is not the claim.
    S4.rangeIn = 0; S4.rangeOut = 2;
    const out4 = bro.appDir + '/../out/sound-only-render.mp4';
    f('path').value = out4;
    f('path').dispatchEvent(new Event('change', { bubbles: true }));
    pump(80);
    el('ex-go').click();
    pump(60);
    waitFor('the sound-only render', () => {
        const s = A.exporter.lastStatus();
        return s && s.state !== 'running';
    }, 120000);
    const done4 = A.exporter.lastStatus();
    same(done4.state, 'done', `it renders (${done4.error || 'no error'})`);
    const back4 = bro.ffmpeg.probe(out4);
    ok(!!back4.audio, 'and what came out has a soundtrack in it');
    ok(!back4.video, 'and no video stream, which is what every screen said');
} else {
    console.log('\n(no sound-only file given — the pictureless-timeline section is skipped)');
}

// ── a stream that is neither picture, sound nor cues ───────────────────────
//
// The other direction from the two sections above. Those are about a file
// *missing* a stream this application takes for granted; this is about one
// carrying a stream it had no row for at all — an action camera's telemetry, a
// camera's timecode, timed metadata. `-map` carries it and `-c copy` writes it,
// and the stream list simply dropped every kind outside the four it drew.
//
// **The fourcc is the whole assertion.** Nothing decodes a data stream, so
// `gpmd`, `tmcd` and `mebx` all probe as `bin_data`: a copy that writes the
// track and loses its tag produces a file that passes every check about length,
// timing and stream count while being useless to the one application it was
// carried for. So the check at the end is the name, out of the file.

if (dataFile) {
    console.log('\na data stream carried through');
    A.shell.goTo('compose');
    pump(80);
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    for (const i of A.inputs.inputs.slice()) A.inputs.removeInput(i);
    pump(120);

    dropFiles(400, 300, [dataFile]);
    waitFor('the telemetry file to load', () => A.project.clips.length > 0);
    pump(200);

    const input = A.inputs.inputs[0];
    const dataStreams = (input.probe.streams || []).filter((s) => s.kind === 'data');
    same(dataStreams.length, 1, 'the probe reports the data stream');
    const tag = dataStreams[0].tag;
    same(tag, 'gpmd', `and reports its fourcc, which is all that identifies it (${tag})`);
    same(dataStreams[0].codec, 'bin_data',
         'while the codec name says nothing — every data stream is bin_data');

    A.shell.goTo('write');
    pump(150);

    const add = q('#ex-streams [data-add="data"]');
    ok(!!add, 'the stage offers to carry it');
    add.click();
    pump(120);

    const dataRow = q('#ex-streams [data-kind="data"]');
    ok(!!dataRow, 'and a row appears for it');
    ok(dataRow.textContent.indexOf('D1') >= 0,
       'labelled D1, which is the letter ffmpeg numbers data streams by');
    ok(dataRow.textContent.indexOf(tag) >= 0,
       `and stating the fourcc rather than the codec (${dataRow.textContent.trim()})`);
    ok(!q('.ex-stream-codec', dataRow),
       'with no encoder menu, because there is no encoder for one');
    ok(!q('.ex-kf', dataRow),
       'and no keyframe strip — every sample of a data stream stands on its own');

    const dspec = A.exporter.buildSpec();
    const drow = (dspec.streams || []).find((s) => s.kind === 'data');
    ok(!!drow, 'the spec carries it');
    same(drow.source, `copy:0:${dataStreams[0].index}`,
         `as a copy naming the input stream (${drow ? drow.source : 'nothing'})`);
    same(drow.codec, '', 'with no codec on it');

    A.command.draw();
    const dline = A.command.currentCommand();
    ok(dline.indexOf('-c:d copy') >= 0, `the command prints -c:d copy (${dline})`);
    ok(dline.indexOf(`-map 0:${dataStreams[0].index}`) >= 0,
       'and a -map naming the input stream');
    // ffmpeg's automatic selection never picks a data stream, so `-dn` beside
    // `-vn`/`-an`/`-sn` would read as this application turning something off
    // when in fact nothing was ever going to be on.
    ok(dline.indexOf(' -dn') < 0, 'and no -dn, which would say the opposite of what happens');

    // The render, and then the name out of the file — which is the only check
    // here that a dropped tag would fail.
    const SD = A.exporter.currentSettings();
    SD.rangeIn = 0; SD.rangeOut = 3;
    const outData = bro.appDir + '/../out/data-stream.mp4';
    f('path').value = outData;
    f('path').dispatchEvent(new Event('change', { bubbles: true }));
    pump(80);
    el('ex-go').click();
    pump(60);
    waitFor('the render with a data stream', () => {
        const s = A.exporter.lastStatus();
        return s && s.state !== 'running';
    }, 120000);
    const doneD = A.exporter.lastStatus();
    same(doneD.state, 'done', `it renders (${doneD.error || 'no error'})`);

    const backD = bro.ffmpeg.probe(outData);
    const wroteData = (backD.streams || []).filter((s) => s.kind === 'data');
    same(wroteData.length, 1, 'and what came out has the data stream in it');
    same(wroteData[0].tag, tag,
         `still carrying its fourcc (${wroteData[0] ? wroteData[0].tag : 'none'}) — a copy ` +
         'that lost it would write a track nothing can identify');

    // A container that will not hold one. Refused rather than written without
    // it, and the refusal names the row: libav's own answer here is EINVAL,
    // which is the same integer as a dozen other things.
    SD.container = 'matroska';
    const outMkv = bro.appDir + '/../out/data-stream.mkv';
    A.exporter.redraw();
    pump(60);
    f('path').value = outMkv;
    f('path').dispatchEvent(new Event('change', { bubbles: true }));
    pump(80);
    el('ex-go').click();
    pump(60);
    waitFor('the Matroska attempt', () => {
        const s = A.exporter.lastStatus();
        return s && s.state !== 'running';
    }, 120000);
    const mkv = A.exporter.lastStatus();
    same(mkv.state, 'failed', 'Matroska holds no data stream, so the render is refused');
    ok((mkv.error || '').indexOf('data') >= 0,
       `and the refusal says which row to take off (${mkv.error || 'nothing said'})`);

    SD.container = 'mp4';
    A.exporter.redraw();
    pump(60);
} else {
    console.log('\n(no file with a data stream given — that section is skipped)');
}

// ── a render whose picture is not in any file ───────────────────────────────
//
// A generator clip is a clip, so nothing on the Encode or Write stages had to
// learn anything about one — but the *path* the render takes is not the one an
// edit of files takes, and that is what is checked here. The compositor
// composites frames read from `-i`s and a generator has none, so an edit holding
// one is performed by libavfilter with nothing on the Graph stage at all. It
// needs no fixture: libavfilter makes its own pictures.

console.log('\na render rooted in a generator');
{
    A.graph.overlay.clear();
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(120);

    const gen = A.addGenerator('smptebars');
    pump(200);
    ok(!!gen, `laid out ${gen.name} with nothing else on the timeline`);

    const S = A.exporter.currentSettings();
    S.width = 320;
    S.height = 180;
    S.rangeIn = 0;
    S.rangeOut = 0;
    A.exporter.redraw();
    pump(40);

    // Two clips' worth of one number: the range is measured against the edit's
    // own duration, and a generator clip is what gives an edit holding no files
    // one at all.
    same(A.exporter.range().length, gen.length,
         `the range is the generator's own length (${gen.length}s)`);

    const spec = A.exporter.buildSpec();
    ok(!!spec.filterGraph,
       'a render with a generator on the timeline goes through libavfilter with ' +
       'nothing on the Graph stage — the compositor has no -i to read');
    ok(/^smptebars=/.test(spec.filterGraph.split(';')[1] || ''),
       `and the filter is the head of the clip's chain: ${spec.filterGraph}`);
    same((spec.filterInputs || []).length, 0, 'and it opens no files at all');
    ok(spec.clips.length === 1 && spec.clips[0].input === -1 &&
       !!spec.clips[0].generator,
       'the clip is in the spec as a clip, with no -i and a generator instead');

    // The command bar stops calling the graph a translation, because on this
    // path it is not one.
    ok(A.command.currentCommand().indexOf('-filter_complex') >= 0,
       'the command prints the chains it will parse');

    spec.path = bro.appDir + '/../out/ui-export-generator.mp4';
    spec.end = Math.min(spec.end, spec.start + 1);
    spec.streams = [];
    spec.chapters = [];
    let refused = '';
    try { bro.ffmpeg.render.start(spec); } catch (e) { refused = String(e); }
    ok(!refused, `the renderer accepted it (${refused || 'accepted'})`);
    if (!refused) {
        waitFor('the generator render to finish',
                () => bro.ffmpeg.render.poll().state !== 'running', 60000);
        const st = bro.ffmpeg.render.poll();
        ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
        const out = bro.ffmpeg.probe(spec.path);
        ok(!!out.video && out.video.width === 320 && out.video.height === 180,
           `and wrote a ${out.video ? out.video.width + 'x' + out.video.height : 'broken'} file ` +
           'out of nothing but a filter');
        ok(!out.audio, 'with no soundtrack, because a generator has nothing for the mix');
        ok(Math.abs(out.format.duration - (spec.end - spec.start)) < 0.25,
           `as long as the range asked for (${out.format.duration.toFixed(2)}s)`);
    }

    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(120);
    A.open(media);
    waitFor('the edit back', () => A.project.clips.length === 1, 20000);
    pump(150);
    S.width = 0;
    S.height = 0;
    A.exporter.redraw();
    pump(40);
}

// ── what is carried between runs ───────────────────────────────────────────
//
// `localStorage` is the one thing in this application that outlives the process,
// and it has already cost an afternoon: a botched run left `videoCodec:
// mpeg2video` behind, which has no CRF, so the quality slider was not drawn and
// an assertion four hundred lines earlier failed on a checkout where nothing
// had changed. Both halves of that are asserted here — what is carried, and
// what a stored blob written by an older shape of this application does when it
// comes back in.

console.log('\nwhat survives a restart, and what does not');
{
    const S3 = A.exporter.currentSettings();
    const kept = { container: S3.container, videoCodec: S3.videoCodec, quality: S3.quality,
                   metadata: S3.metadata, chapters: S3.chapters,
                   rangeIn: S3.rangeIn, rangeOut: S3.rangeOut };

    S3.quality = 27;
    S3.metadata = { comment: 'carried' };
    S3.chapters = [{ start: 0, end: 1, title: 'Opening' }];
    A.exporter.rememberSettings();

    // Changed behind the store's back, then restored: whatever comes back is
    // what the blob carried and nothing else.
    S3.quality = 11;
    S3.metadata = {};
    S3.chapters = [];
    A.exporter.restoreSettings();
    same(S3.quality, 27, 'a setting somebody chose comes back');
    same((S3.metadata || {}).comment, 'carried', 'and so does the container metadata');
    // A chapter is a pair of times on *this* timeline, so carrying "Opening,
    // 0 to 1 s" into the next edit would put a mark somewhere that means
    // nothing — unlike a codec or a language, which mean the same thing
    // whatever is being written.
    same((S3.chapters || []).length, 0, 'and a chapter deliberately does not');

    // The repair. Nothing writes these shapes today, which is exactly why they
    // are worth a test: `metadata: null` reaches `Object.keys()` on the Write
    // stage and takes the whole stage down at boot, where nothing on the screen
    // says which key did it.
    const raw = JSON.parse(localStorage.getItem('ffmpeg-bro.export'));
    raw.metadata = null;
    raw.extraVideo = 'not an object';
    raw.destinations = 7;
    raw.container = 'mkv';           // what this field held before muxers had names
    localStorage.setItem('ffmpeg-bro.export', JSON.stringify(raw));
    A.exporter.restoreSettings();
    ok(S3.metadata && typeof S3.metadata === 'object', 'a null bag comes back as an empty one');
    ok(S3.extraVideo && typeof S3.extraVideo === 'object', 'and so does one that is a string');
    ok(Array.isArray(S3.destinations), 'a destination list that is a number comes back a list');
    same(S3.container, 'matroska',
         'and a container written as an extension is the muxer libavformat guesses from it');

    Object.assign(S3, kept);
    A.exporter.rememberSettings();
    A.exporter.redraw();
    pump(40);
}

console.log(`\n${checks} checks passed`);
