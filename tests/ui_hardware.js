// The GPU, from the two places a person decides about it.
//
// The application's claim about hardware is unusual and this suite is what
// keeps it honest: **decoding is per input and encoding is per stream, they are
// two decisions rather than one switch, and the one that is usually a mistake
// says so beside itself.** That claim only holds if the controls are actually in
// those two places, if the list they offer is what this machine has rather than
// what the build has, and if the cost is on the screen where the choice is made.
//
// Everything here must pass on a machine with no graphics card at all, which is
// most of what makes it worth writing: the interesting half of the surface is
// the half that reports an absence. So the checks split — what is asserted
// unconditionally (the list is discovered, not the build's; a device that
// cannot decode this codec is not offered; the command prints what is set) and
// what is asserted only when a device turned up.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_hardware.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_hardware.js -- <file>');

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
const q = (sel, root) => (root || document).querySelector(sel);
const qq = (sel, root) => (root || document).querySelectorAll(sel);
const f = (name) => q(`[data-f="${name}"]`);

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}
function same(actual, expected, what) {
    if (actual !== expected) {
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
    }
    ok(actual === expected, what);
}

const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
function type(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}
function pick(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;

// ── what the machine has, as against what the build has ────────────────────

console.log('\nthe machine, not the build');

const built = bro.ffmpeg.hwaccels || [];
const found = bro.ffmpeg.hardware() || [];
ok(built.length > 0, `the build reports ${built.length} device types`);
ok(found.length === built.length,
   'and the probe answers about every one of them, present or not');
ok(found.every((d) => typeof d.present === 'boolean'),
   'each with a yes or no about this machine rather than a name alone');

const working = found.filter((d) => d.present);
console.log(`  ${working.length} of ${found.length} work here: ` +
            (working.map((d) => d.name).join(', ') || 'none'));
// A type that could not be created has to say why. It is the difference
// between "there is no such thing" and "the driver refused", and a UI that
// showed neither would be a UI where a missing device looks like a bug.
ok(found.filter((d) => !d.present).every((d) => typeof d.error === 'string'),
   'and a type that did not work carries libav’s own reason');
ok(working.every((d) => d.pixelFormat),
   'a working device says what format its frames are in');
ok(working.every((d) => Array.isArray(d.decoders) && Array.isArray(d.encoders)),
   'and which decoders and encoders it has, asked of libavcodec');

// ── the decode decision, on Sources ────────────────────────────────────────

console.log('\ndecoding is per input');
A.shell.goTo('sources');
pump(60);
type(el('src-path'), media);
click(el('src-add'));
pump(80);

const input = A.inputs.inputs[0];
ok(!!input && !!input.probe, 'an input is added and probed');
// And a clip made from it, because the command bar prints the render and a
// render with nothing in it has no `-i` to print an input option in front of.
click(f('srcuse'));
pump(120);
ok(A.project.clips.length === 1, 'and a clip cut from it, so there is a render to print');

const picker = f('srchw');
ok(!!picker, 'the input carries an -hwaccel picker — a decoder belongs to an -i');
same(picker.value, '', 'and it starts on the CPU, which is what nothing selected means');

const offered = Array.from(qq('[data-f="srchw"] option')).map((o) => o.value);
ok(offered[0] === '', 'the first choice is the CPU');
// The list is the measured one, cut down again by what this build can decode
// *this codec* with. A menu offering cuda for a ProRes file is a menu that
// fails at the last step.
const codec = input.probe.video && input.probe.video.codec;
const canDecode = working.filter((d) => (d.decoders || []).indexOf(codec) >= 0)
                         .map((d) => d.name);
same(offered.slice(1).join(','), canDecode.join(','),
     `only what decodes ${codec} here is offered (${canDecode.join(', ') || 'nothing'})`);

// The sentence. This is the assertion the whole chunk's honesty rests on: the
// measurement says a hardware decode is slower here, and a control that offered
// it silently would read as an optimisation.
const detail = el('src-detail').textContent;
if (canDecode.length)
    ok(detail.indexOf('Measured slower here than the CPU') >= 0,
       'and the measured cost is stated beside it, not in a manual');
else
    ok(detail.indexOf('on a device') >= 0,
       'and with nothing able to decode it the panel says so rather than showing an empty menu');

if (canDecode.length) {
    const device = canDecode[0];
    pick(f('srchw'), device);
    pump(80);
    same(input.hwaccel, device, `picking ${device} sets -hwaccel on the input`);
    ok(!!f('srchwdev'), 'and -hwaccel_device appears, because two cards is an ordinary machine');
    const keep = qq('[data-seg="srchwkeep"]');
    ok(keep.length === 2,
       'and -hwaccel_output_format, which is the decision that keeps the picture on the card');
    same(input.hwaccelOutputFormat, '',
         'brought down to start with: everything downstream wants pixels it can touch');

    // The command bar is where this has to show up in ffmpeg's own words, and
    // in front of its own `-i` — after it, `-hwaccel` is not an option at all.
    A.command.draw();
    const line = A.command.currentCommand();
    ok(line.indexOf(`-hwaccel ${device}`) >= 0, `the command prints -hwaccel ${device}`);
    ok(line.indexOf(`-hwaccel ${device}`) < line.indexOf(' -i '),
       'in front of the -i, where an input option has to be');

    click(qq('[data-seg="srchwkeep"]')[1]);
    pump(80);
    ok(!!input.hwaccelOutputFormat,
       `keeping them up sets -hwaccel_output_format ${input.hwaccelOutputFormat}`);
    A.command.draw();
    const kept = A.command.currentCommand();
    ok(kept.indexOf(`-hwaccel_output_format ${input.hwaccelOutputFormat}`) >= 0,
       'and the command says so, in front of the -i as well');

    // Back to the CPU. The output format has to go with it: left behind it
    // names a device this input no longer decodes on, which the renderer
    // refuses — correctly, and confusingly.
    pick(f('srchw'), '');
    pump(80);
    same(input.hwaccel, '', 'setting it back to the CPU clears -hwaccel');
    same(input.hwaccelOutputFormat, '', 'and takes the output format with it');
    A.command.draw();
    ok(A.command.currentCommand().indexOf("-hwaccel") < 0, 'and the command stops mentioning it');
}

// ── the encode decision, on Encode ─────────────────────────────────────────

console.log('\nencoding is per stream');
A.shell.goTo('encode');
pump(120);

const codecPicker = f('vcodec');
ok(!!codecPicker, 'the Encode stage picks the encoder');
const encoders = Array.from(qq('[data-f="vcodec"] option'));
const hwNames = [];
for (const d of working) for (const e of d.encoders || []) hwNames.push(e);
const marked = encoders.filter((o) => hwNames.indexOf(o.value) >= 0);
if (hwNames.length) {
    ok(marked.length > 0,
       `${marked.length} of ${encoders.length} encoders run on a card and are offered`);
    // Named for the device rather than badged "hardware": which card it is
    // decides whether a graph ending on that card can hand it frames.
    ok(marked.every((o) => working.some((d) => o.textContent.indexOf(d.name) >= 0)),
       'each says which device it runs on, because that is what has to match the graph');
} else {
    ok(marked.length === 0, 'no encoder here runs on a card, and none is marked as one');
}

// ── a hardware frame reaching a software filter ────────────────────────────
//
// libavfilter's own message for this is four hundred pixel format names and no
// filter. One sentence is the whole of what the checker adds.

console.log('\na picture on a card, and a filter that reads pixels');
if (canDecodeSomething()) {
    const device = firstDecodingDevice();

    // **An input that keeps its pictures up is not, on its own, a problem.**
    // The derivation knows and begins the clip's chain with `hwdownload`,
    // exactly as the compositor's `rgbaAt` downloads whatever it is handed —
    // so the printed graph runs and the render matches it. That is the first
    // thing to assert, because a checker that complained here would be
    // complaining about a graph that works.
    A.shell.goTo('sources');
    pump(60);
    pick(f('srchw'), device);
    pump(80);
    click(qq('[data-seg="srchwkeep"]')[1]);
    pump(120);
    ok(!!A.inputs.inputs[0].hwaccelOutputFormat, 'the input keeps its pictures on the card');
    ok(!problemsNow().length,
       'and the derivation brings them down for the compositor, so nothing is wrong');
    A.command.draw();
    ok(A.command.currentCommand().indexOf('hwdownload') >= 0,
       'the printed graph says so — hwdownload, where the render does it');

    // Now the mistake somebody actually makes: a picture put *up* in front of
    // filters that read pixels — here the compositing `overlay`, which is
    // swscale and pointer arithmetic and cannot be handed a device handle.
    // libavfilter's own message for it is four hundred pixel format names and
    // no filter named.
    const clip = A.project.clips[0];
    A.graph.overlay.insert(`clip:${clip.id}/after-scale`, 'hwupload', { stream: 'v' });
    pump(120);
    const said = problemsNow();
    ok(said.some((p) => /on a card/.test(p) && /reads pixels/.test(p)),
       'a picture uploaded in front of a software filter is named: ' +
       (said.find((p) => /on a card/.test(p)) || said.join(' | ') || 'nothing said'));

    A.graph.overlay.clear();
    pump(120);
    ok(!problemsNow().some((p) => /on a card/.test(p)),
       'and taking it off settles it');
} else {
    console.log('  (nothing on this machine decodes this file on a device — skipped)');
}

// ── where the picture ends up, and what the sound has to do with it ────────
//
// **Nothing.** Whether the encoder is handed a picture on a card is a fact
// about the wire feeding `out:v`, and it must not change because a soundtrack
// was switched on. It did: the warning was a text scan for `hwupload` in the
// *last chain* of the printed graph, and `derive()` builds the audio runs
// after the video sink — so the last chain of any render with sound in it is
// an `atrim` and the answer was unconditionally "no". Toggling Include audio
// flipped a warning about the picture, in two clicks.
//
// This runs on a machine with no card at all: `hwupload` is in every build of
// libavfilter, and `libx264` cannot be handed a device frame whatever is
// installed.

console.log('\nwhere the picture ends up, and the sound has nothing to do with it');
A.graph.overlay.clear();
A.shell.goTo('encode');
pump(80);
{
    const S = A.exporter.currentSettings();
    const keptCodec = S.videoCodec;
    const keptAudio = S.audio;
    const keptStreams = S.streams;

    S.videoCodec = 'libx264';
    A.graph.overlay.insert('composite/after-overlay', 'hwupload', { stream: 'v' });
    pump(120);

    const onCard = (list) => list.some((w) => /leaves its picture on the card/.test(w));

    S.audio = true;
    S.streams = A.exporter.defaultStreams();
    A.exporter.redraw();
    pump(80);
    const withSound = A.exporter.currentWarnings();
    ok(onCard(withSound),
       'an hwupload on the last wire and a software encoder is refused before the ' +
       'Render button, with a soundtrack in the render');

    S.audio = false;
    S.streams = S.streams.filter((s) => s.kind !== 'audio');
    A.exporter.redraw();
    pump(80);
    const silent = A.exporter.currentWarnings();
    ok(onCard(silent), 'and the same render without one');
    ok(onCard(withSound) === onCard(silent),
       'the same answer either way — the sound is not on the wire the encoder reads');

    A.graph.overlay.clear();
    S.videoCodec = keptCodec;
    S.audio = keptAudio;
    S.streams = keptStreams;
    A.exporter.redraw();
    pump(80);
    ok(!onCard(A.exporter.currentWarnings()),
       'and taking the hwupload off takes the warning with it');
}

function canDecodeSomething() {
    const c = A.inputs.inputs[0] && A.inputs.inputs[0].probe &&
              A.inputs.inputs[0].probe.video && A.inputs.inputs[0].probe.video.codec;
    return !!c && working.some((d) => (d.decoders || []).indexOf(c) >= 0);
}
function firstDecodingDevice() {
    const c = A.inputs.inputs[0].probe.video.codec;
    return working.find((d) => (d.decoders || []).indexOf(c) >= 0).name;
}
/// What the checker currently says about the graph, as sentences.
///
/// Asked of the derivation rather than scraped off the cards: a problem is
/// drawn on the node it belongs to and in the spine's one-line summary, so
/// there is no list on the screen to read — and the derivation is what both of
/// those are built from.
function problemsNow() {
    const s = A.graph.summary();
    return (s.problems || []).map((p) => p.reason);
}

console.log(`\n${checks} checks passed`);
