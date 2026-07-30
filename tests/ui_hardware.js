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
// A `<select>` and a text field are set the same way — write the value, then
// send `change` — so this is `type` under the name that reads right at a menu.
// One body: two identical ones are two things to keep in step.
const pick = type;

/// Is `what` printed *in front of* the `-i`, which is the whole of what makes
/// it an input option?
///
/// A function rather than the obvious `line.indexOf(what) < line.indexOf(' -i ')`
/// because that spelling passes for a command that never mentions `what` at
/// all: `indexOf` answers −1, and −1 is less than every index there is. So an
/// option that quietly stopped being printed would go on satisfying the
/// assertion that it is printed in the right place.
function inFrontOfTheInput(line, what) {
    const at = line.indexOf(what);
    const i = line.indexOf(' -i ');
    return at >= 0 && i >= 0 && at < i;
}

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;

// ── what the machine has, as against what the build has ────────────────────

console.log('\nthe machine, not the build');

const built = bro.ffmpeg.hwaccels || [];
const found = bro.ffmpeg.hardware() || [];
ok(built.length > 0, `the build reports ${built.length} device types`);
// **By name, not by count.** Both of these walk `av_hwdevice_iterate_types`, so
// their lengths are equal however wrong either of them is; what is worth
// asserting is that the probe answers about the *same* types the build
// declares, which is the join the whole picker rests on.
same(found.map((d) => d.name).sort().join(','), built.slice().sort().join(','),
     'and the probe answers about every one of them by name, present or not');
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

// **How many, which is a different question from whether any.** `present` says
// a device of this type could be created; nothing until now said whether there
// was a second one, because libavutil has no count and no iterator over the
// devices of a type — only `av_hwdevice_ctx_create` taking the string
// `-hwaccel_device` takes. So the native half asks by creating one of each
// index until it refuses.
//
// Asserted as a *shape*, never at a number: one card and two cards are both
// machines this has to work on, and a suite that required two would be
// asserting something about the hardware. The shape is what a picker rests on
// — the indices are the strings `-hwaccel_device` takes, they start at 0, and
// they are contiguous, because the walk stops at the first refusal and a gap
// would mean it stopped early and the picker is short.
ok(found.every((d) => Array.isArray(d.devices)),
   'every type reports the devices of it this machine has, by index');
ok(working.every((d) => d.devices.every((x, i) => x === String(i))),
   'and they are 0, 1, 2 … — contiguous, because the walk stops at the first refusal');
ok(found.filter((d) => !d.present).every((d) => d.devices.length === 0),
   'a type this machine has no card for reports none of them');
for (const d of working)
    console.log(`  ${d.name}: ${d.devices.length ? d.devices.join(', ')
                                                 : 'not addressed by index'}`);

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
// it silently would read as an optimisation. It is on the control itself rather
// than in a paragraph under it — a stage states, a manual explains — so what is
// asserted is that the picker carries it, not that the column contains a
// sentence somewhere.
const cost = q('[data-f="srchw"]').title;
if (canDecode.length)
    ok(cost.indexOf('Measured slower here than the CPU') >= 0,
       'and the measured cost is stated on the picker itself, not in a manual');
else
    ok(cost.indexOf('on a device') >= 0,
       'and with nothing able to decode it the picker says so rather than offering an empty menu');

if (canDecode.length) {
    const device = canDecode[0];
    pick(f('srchw'), device);
    pump(80);
    same(input.hwaccel, device, `picking ${device} sets -hwaccel on the input`);
    ok(!!f('srchwdev'), 'and -hwaccel_device appears, because two cards is an ordinary machine');

    // ── which one, of how many ─────────────────────────────────────────────
    //
    // It was a text box until the enumeration existed, for the honest reason
    // that nothing could say whether the number typed into it addressed
    // anything. It is a picker of what this machine has now, and these are the
    // three things that makes true.
    {
        const cards = (working.find((d) => d.name === device) || {}).devices || [];
        const offeredCards = Array.from(qq('[data-f="srchwdev"] option')).map((o) => o.value);
        same(offeredCards.join(','), [''].concat(cards).join(','),
             `the picker offers the default and the ${cards.length} ${device} ` +
             'device(s) this machine reported, and nothing else');
        same(f('srchwdev').value, '',
             'starting on the default, which is what an input that never said anything means');

        if (cards.length) {
            // The last one, so that a machine with two cards exercises the
            // second and a machine with one exercises the only one — the same
            // assertion either way rather than a branch on the count.
            const last = cards[cards.length - 1];
            pick(f('srchwdev'), last);
            pump(80);
            same(input.hwaccelDevice, last, `picking ${device} ${last} sets -hwaccel_device`);
            A.command.draw();
            ok(inFrontOfTheInput(A.command.currentCommand(), `-hwaccel_device ${last}`),
               `and the command prints -hwaccel_device ${last} in front of the -i`);

            // **A value this machine cannot honour is shown, not snapped.**
            // The case is a document written where there were more cards; the
            // shape is an input carrying an index the enumeration does not
            // have. Selecting the default quietly would be a render pointed at
            // a different card from the one the file says.
            A.inputs.updateInput(input, { hwaccelDevice: String(cards.length) });
            A.drawSources();
            pump(80);
            const kept = Array.from(qq('[data-f="srchwdev"] option')).map((o) => o.value);
            same(f('srchwdev').value, String(cards.length),
                 `a stored ${device} ${cards.length}, which is not here, stays selected`);
            ok(kept.indexOf(String(cards.length)) >= 0 &&
               q('[data-f="srchwdev"]').className.indexOf('bad') >= 0,
               'and is offered as its own choice, marked as not on this machine');
            A.inputs.updateInput(input, { hwaccelDevice: '' });
            A.drawSources();
            pump(80);
        }
    }
    const keep = qq('[data-seg="srchwkeep"]');
    ok(keep.length === 2,
       'and -hwaccel_output_format, which is the decision that keeps the picture on the card');
    same(input.hwaccelOutputFormat, '',
         'brought down to start with: everything downstream wants pixels it can touch');

    // The command bar is where this has to show up in ffmpeg's own words, and
    // in front of its own `-i` — after it, `-hwaccel` is not an option at all.
    A.command.draw();
    const line = A.command.currentCommand();
    ok(inFrontOfTheInput(line, `-hwaccel ${device}`),
       `the command prints -hwaccel ${device} in front of the -i, where an input option has to be`);

    click(qq('[data-seg="srchwkeep"]')[1]);
    pump(80);
    ok(!!input.hwaccelOutputFormat,
       `keeping them up sets -hwaccel_output_format ${input.hwaccelOutputFormat}`);
    A.command.draw();
    const kept = A.command.currentCommand();
    ok(inFrontOfTheInput(kept, `-hwaccel_output_format ${input.hwaccelOutputFormat}`),
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

// **The starting points ask the machine, not the build.** `bro.ffmpeg.encoders`
// carries every NVENC, AMF and QSV encoder on a machine with no card in it, so
// a "Fast (GPU)" preset filtered against that is offered everywhere and fails
// at `avcodec_open2` with the render already begun. Stated as a property of the
// list rather than as a branch, so it is asserted on every machine: where the
// preset exists at all, the encoder it applies is one a device that *answered*
// reports.
const gpuIntent = A.exporter.intents().find((i) => i.id === 'gpu');
ok(!gpuIntent ||
   working.some((d) => (d.encoders || []).indexOf(gpuIntent.apply.videoCodec) >= 0),
   gpuIntent
       ? `the GPU preset names an encoder a device here reports (${gpuIntent.apply.videoCodec})`
       : 'no GPU preset is offered, and no device here reports an encoder for one');
if (!hwNames.length)
    ok(!gpuIntent, 'and with nothing on this machine to run it on, it is not offered at all');

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

// ── the rule, on a press ───────────────────────────────────────────────────
//
// Software decode, hardware encode, above SD. That is what this machine was
// measured to want (docs/manual/card.md) and until now the only way to arrive at
// it was to read two sentences, walk to two stages and set three controls. The
// press applies it — and **names what it picked and why**, because choosing on
// somebody's behalf and then having to say so is the whole cost of the thing.
//
// Every assertion here runs on a machine with nothing in it, which is most of what
// makes the section worth writing: "there is nothing to choose" has to be a
// sentence rather than a button that appears to do nothing.

console.log('\nthe rule, applied on a press');
A.graph.overlay.clear();
A.shell.goTo('encode');
pump(150);
{
    const H = A.hardware;
    const S = A.exporter.currentSettings();
    const built = bro.ffmpeg.encoders || [];
    const codecOf = (id) => (built.find((e) => e.id === id) || {}).codecName || '';

    const button = f('hwchoose');
    ok(!!button, 'the Encode stage offers to choose for you');
    // The answer is on the control *before* it is pressed. A button whose effect
    // can only be discovered by pressing it is a button nobody presses twice.
    ok(button.title.length > 40,
       `with what it would do already on it (“${button.title.slice(0, 90)}…”)`);

    // **The candidates are the machine's, not the build's.** This is the failure
    // the GPU preset was written against and it is the same one: a vcpkg ffmpeg
    // carries every NVENC, AMF and QSV encoder on a machine with no card in it, so
    // a list filtered against `bro.ffmpeg.encoders` alone is a list that fails at
    // `avcodec_open2` with the render already begun.
    const onCard = H.hardwareChoices('');
    ok(onCard.every((e) => working.some((d) => (d.encoders || []).indexOf(e.id) >= 0)),
       `every candidate is one a device that answered reports (${
           onCard.map((e) => `${e.id} on ${e.device}`).join(', ') || 'none, and none offered'})`);
    ok(onCard.every((e) => built.some((x) => x.id === e.id)),
       'and one this build actually carries, so the encoder menu can show it');

    // Above SD, where the card is worth two to three times.
    S.width = 1920; S.height = 1080;
    A.exporter.redraw();
    pump(80);
    const big = H.chooseFor({ height: 1080, videoCodec: 'libx264', inputs: [] });
    if (onCard.length) {
        ok(!!big.encoder && working.some((d) => (d.encoders || []).indexOf(big.encoder) >= 0),
           `above SD it picks an encoder this machine has (${big.encoder})`);
        ok(!!big.device && big.why.indexOf(big.device) >= 0,
           `named with the device it runs on (${big.device})`);
        ok(/above SD/.test(big.why),
           `and with the reason, not just the answer (“${big.why.slice(0, 100)}…”)`);
        // Same codec where the machine has one, so a press changes *where* the
        // encoding happens and not what will play on the other end.
        if (onCard.some((e) => e.codec === codecOf('libx264')))
            same(codecOf(big.encoder), codecOf('libx264'),
                 'staying in the codec that was already chosen');
    } else {
        same(big.encoder, '', 'with nothing on a card here, nothing is chosen');
        ok(/no encoder that runs on a device/.test(big.why),
           `and it says so rather than picking nothing silently: “${big.why.slice(0, 110)}…”`);
    }

    // At or below SD the card loses outright — a small frame is all fixed cost —
    // so this is the one direction of the press that takes an encoder *off* a
    // device.
    if (onCard.length) {
        const was = onCard[0].id;
        const small = H.chooseFor({ height: 360, videoCodec: was, inputs: [] });
        ok(small.encoder ? !H.isHardwareEncoder(small.encoder)
                         : /no encoder for/.test(small.why),
           `below SD a device encoder is moved off it (${was} → ${
               small.encoder || 'nothing, because ' + small.why.slice(0, 50)})`);
        ok(/below SD/.test(small.why), `with the reason (“${small.why.slice(0, 100)}…”)`);
    }
    const soft = H.chooseFor({ height: 360, videoCodec: 'libx264', inputs: [] });
    same(soft.encoder, '', 'and a software encoder below SD is already the answer');
    ok(!soft.changed && soft.why.length > 40,
       `so nothing changes, said as a sentence (“${soft.why.slice(0, 100)}…”)`);

    // The decode half, which is the half of the rule with no exceptions.
    if (canDecodeSomething()) {
        A.shell.goTo('sources');
        pump(80);
        pick(f('srchw'), firstDecodingDevice());
        pump(120);
        ok(!!A.inputs.inputs[0].hwaccel,
           `an input is put on a device by hand (${A.inputs.inputs[0].hwaccel})`);
        A.shell.goTo('encode');
        pump(150);
        ok(/back to the CPU/.test(f('hwchoose').title),
           `and the press says beforehand that it will take it off (“${
               f('hwchoose').title.slice(0, 100)}…”)`);
        click(f('hwchoose'));
        pump(250);
        same(A.inputs.inputs[0].hwaccel, '', 'pressing it does');
        same(A.inputs.inputs[0].hwaccelOutputFormat, '',
             'and takes the output format with it, which belongs to the device that named it');
    } else {
        console.log('  (nothing on this machine decodes this file on a device — ' +
                    'the decode half is skipped)');
        click(f('hwchoose'));
        pump(250);
    }

    // And the sentence stays on the stage rather than being flashed away: it is
    // about a decision that has already been written into the controls above it,
    // and one that vanished would be a decision nobody could go back and read.
    const note = q('.ex-chosen');
    ok(!!note && note.textContent.length > 40,
       `the press leaves its reason on the stage: “${
           note ? note.textContent.slice(0, 110) : 'nothing'}…”`);
    if (onCard.length)
        ok(H.isHardwareEncoder(A.exporter.currentSettings().videoCodec),
           `and the encoder it named is the one in force (${
               A.exporter.currentSettings().videoCodec})`);
    else
        ok(!H.isHardwareEncoder(A.exporter.currentSettings().videoCodec),
           'and nothing was moved onto a device that is not here');
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
