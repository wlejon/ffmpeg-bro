// The Sources stage, driven the way a person drives it.
//
// The stage used to be a read-only list derived from the timeline, and what it
// has become is the input editor: a path or a URL typed in, a demuxer forced,
// an option set, a window cut, and then the clip that is made from all of that.
// So this follows one input from being added to being rendered —
//
//   - added by typing a path, with no clip anywhere near it, because an input
//     with nothing cut from it is an ordinary state and the whole reason this
//     stage is not derived from the timeline any more;
//   - configured: `-f` forced from the demuxer picker, `-probesize` set from
//     the option column, a `-ss`/`-to` window that shortens the input;
//   - stated: every one of those printed by the command bar **before** its own
//     `-i`, because an input option after the `-i` is an output option meaning
//     something else;
//   - used: `Use on the timeline` makes a clip of it, the clip is as long as
//     the window and not as long as the file, and the spec the renderer is
//     handed carries the input list with the clip pointing into it;
//   - refused: an option no demuxer has stops the open and says which key.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_sources.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_sources.js -- <file>');

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

/// A click, the way the app hears one.
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/// Typing into a field and leaving it, which is when a text control commits —
/// on `change`, never on `input`, so a value is not applied halfway through
/// being typed.
function type(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;

// ── an input with no clip ──────────────────────────────────────────────────

console.log('\nan input exists without a clip');
A.shell.goTo('sources');
pump(60);

ok(A.inputs.inputs.length === 0, 'nothing is loaded yet');
ok(el('src-list').textContent.indexOf('No inputs') >= 0,
   'and the list says so rather than sitting empty');

type(el('src-path'), media);
click(el('src-add'));
pump(60);

ok(A.inputs.inputs.length === 1, 'typing a path and pressing Add makes one input');
const input = A.inputs.inputs[0];
ok(A.project.clips.length === 0, 'and no clip — an input is not a clip');
ok(!!input.probe, 'it was probed the moment it was added');
ok(el('src-list').textContent.indexOf('unused') >= 0,
   'the list says it is unused rather than hiding it');
ok(el('src-detail').textContent.indexOf('What came back') >= 0,
   'and the panel reads out what it contains');
// One line per stream, not six rows: the codec, and what that kind of stream is
// described by. The rest — profile, language, pixel aspect — is on the line's
// tooltip, because this readout is the one most often looked at on the stage
// and it used to be forty rows on an ordinary camera file.
{
    const lines = qq('.src-stream');
    ok(lines.length === input.probe.streams.length,
       `one line per stream, ${lines.length} of them`);
    const v = Array.from(lines).find((n) => n.textContent.indexOf('V0') === 0);
    ok(!!v && v.textContent.indexOf(input.probe.video.codec) >= 0,
       `the video line names its codec: ${v && v.textContent.replace(/\s+/g, ' ').trim()}`);
    ok(v.title.indexOf(input.probe.video.codecLong || input.probe.video.codec) >= 0,
       'and the long name is the tooltip rather than a row of its own');
}

// The spine states the stage, and what it states is the inputs — not the files
// on the timeline, which is what it counted before there were inputs.
ok(q('[data-stage="sources"]').textContent.indexOf('1 input') >= 0,
   `the spine counts inputs: ${q('[data-stage="sources"]').textContent.replace(/\s+/g, ' ').trim()}`);

// The token, which is how an input's options reach playback: a `<video src>` is
// only a string, so the string names the input.
ok(/^\/@input\//.test(input.src), `it is registered for playback as ${input.src}`);

// ── the demuxer, forced ────────────────────────────────────────────────────

console.log('\nthe demuxer');
const probedFormat = input.probe.format.name;
ok(el('src-detail').textContent.indexOf(probedFormat) >= 0,
   `what it probed as is stated: ${probedFormat}`);

click(f('demuxpick'));
pump(40);
ok(!!f('demuxsearch'), 'the picker is a search over the demuxers, not a list of the good ones');
const searchField = f('demuxsearch');
searchField.value = probedFormat.split(',')[0];
searchField.dispatchEvent(new Event('input', { bubbles: true }));
pump(40);
const offered = Array.from(qq('[data-demuxer]')).map((b) => b.getAttribute('data-demuxer'));
ok(offered.indexOf(probedFormat) >= 0,
   `searching finds it by name among ${offered.length} shown`);

// Found by walking the buttons rather than by an attribute selector: a
// demuxer's name is "mov,mp4,m4a,3gp,3g2,mj2" and a comma inside a selector
// is where this engine starts a second selector.
const pick = Array.from(qq('[data-demuxer]'))
    .find((b) => b.getAttribute('data-demuxer') === probedFormat);
ok(!!pick, 'the one it probed as is among them');
click(pick);
pump(60);
same(input.format, probedFormat, 'picking one forces it — that is what -f means');
ok(el('src-list').textContent.indexOf(`-f ${probedFormat}`) >= 0,
   'and the list says what is set on it, in ffmpeg’s own words');

// ── the demuxer's options ──────────────────────────────────────────────────

console.log('\nits options');
ok(!!f('demuxoptsearch'), 'the demuxer’s own option table is a column beside it');
ok(el('src-options').textContent.indexOf('options ·') >= 0,
   `the column is headed with how many there are: ` +
   el('src-options').textContent.slice(0, 40).replace(/\s+/g, ' ').trim());

const optSearch = f('demuxoptsearch');
optSearch.value = 'probesize';
optSearch.dispatchEvent(new Event('input', { bubbles: true }));
pump(40);
const probeField = q('[data-opt="probesize"]');
ok(!!probeField, 'searching the table finds libavformat’s own -probesize');
type(probeField, '4000000');
pump(60);
same(input.options.probesize, '4000000', 'setting it puts it in the input’s bag');
ok(!!input.probe, 'and the input was opened again with it, successfully');

// ── the decoders, which are not the demuxer ────────────────────────────────
//
// A decoder belongs to an `-i`, which is why its options live here and not on
// the Encode stage: ffmpeg writes `-skip_frame` in front of the same `-i` that
// `-probesize` goes in front of, and for the same reason — both are decisions
// taken while this input is being read. They are a *different bag* from the
// demuxer's because they are a different object with a different table, and
// there is a column per codec the file turned out to carry.

console.log('\nthe decoders reading it');
{
    const codec = input.probe.video.codec;
    const search = f(`decoptsearch-${codec}`);
    ok(!!search, `the ${codec} decoder's own option table is a column too`);
    search.value = 'skip_frame';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    pump(40);
    const field = q('[data-opt="skip_frame"]');
    ok(!!field, 'searching it finds libavcodec’s own -skip_frame');
    type(field, 'nokey');
    pump(80);
    same(input.decoderOptions.skip_frame, 'nokey',
         'setting it puts it in the input’s decoder bag, not the demuxer’s');
    same(input.options.skip_frame, undefined,
         'which is a different bag, because it is a different object');
    ok(!!input.probe, 'and the input is still openable with it');

    same(A.exporter.buildSpec().inputs[0].decoderOptions.skip_frame, 'nokey',
         'the renderer is handed it on the input');
    // Left set: the command bar has no `-i` to print until something is cut
    // from this input, so where it lands in the line is checked below with the
    // rest of what goes in front of one.
}

// ── the window ─────────────────────────────────────────────────────────────

console.log('\nthe window');
const whole = A.inputs.lengthOf(input);
ok(whole > 3, `the file is ${whole.toFixed(2)}s, long enough to cut a window out of`);

type(f('srcss'), '1');
pump(60);
type(f('srcto'), '3');
pump(60);
same(input.ss, 1, '-ss is what the input starts at');
same(input.to, 3, '-to is what it stops at');
const windowed = A.inputs.lengthOf(input);
ok(Math.abs(windowed - 2) < 0.1,
   `so the input is two seconds long, not ${whole.toFixed(2)} (${windowed.toFixed(2)})`);
// The sentence this stage exists to make sayable, on the field it is about
// rather than as a paragraph under it: a stage states, a manual explains.
ok(f('srcss').title.indexOf('in-point') >= 0,
   'and the field itself says an input seek is not a clip’s in-point');
ok(f('srcss').title.indexOf('-ss') >= 0,
   'along with the flag it writes, which is no longer the label');

// ── used on the timeline ───────────────────────────────────────────────────

console.log('\nused on the timeline');
click(f('srcuse'));
waitFor('the clip to arrive', () => A.project.clips.length > 0);
waitFor('a decoded frame', () => A.video() && A.video().videoWidth > 0);
const clip = A.project.clips[0];

ok(clip.input === input, 'the clip references the input rather than carrying a path');
ok(Math.abs(clip.length - 2) < 0.1,
   `and is as long as the window, not as long as the file (${clip.length.toFixed(2)}s)`);
same(clip.src, input.src, 'its <video> plays the input’s token, so the options reach playback');
ok(A.video().videoWidth > 0, 'and it decodes: the token opened the file with -f and -probesize');

A.shell.goTo('sources');
pump(40);
ok(el('src-list').textContent.indexOf('1 clip') >= 0, 'the list now says one clip is cut from it');
ok(f('srcremove').disabled,
   'and it cannot be removed while something is cut from it — a clip needs an input');

// ── the command says all of it, in front of the -i ─────────────────────────

console.log('\nwhat the command says');
const cmd = A.command.currentCommand();
console.log(`  ${cmd.slice(0, 220)}`);

const dashI = cmd.indexOf('-i ');
ok(dashI > 0, 'the command has an input');
const before = cmd.slice(0, dashI);
ok(before.indexOf(`-f ${probedFormat}`) >= 0, '-f is before the -i');
ok(before.indexOf('-probesize 4000000') >= 0, 'and so is the demuxer option');
ok(before.indexOf('-ss 1') >= 0 && before.indexOf('-to 3') >= 0,
   'and so is the window — after the -i, -ss would seek the output instead');
// A decoder option too, and for the same reason: after the `-i` the same word
// is an output option meaning something else entirely.
ok(before.indexOf('-skip_frame nokey') >= 0, 'and so is the decoder option');

// ── the spec the renderer is handed ────────────────────────────────────────

console.log('\nthe spec');
const spec = A.exporter.buildSpec();
ok(Array.isArray(spec.inputs) && spec.inputs.length === 1,
   'the spec carries the input list');
same(spec.inputs[0].format, probedFormat, 'with the forced demuxer on it');
same(spec.inputs[0].options.probesize, '4000000', 'and its options');
same(spec.inputs[0].ss, 1, 'and its window');
same(spec.inputs[0].decoderOptions.skip_frame, 'nokey',
     'and the decoder options, in a bag of their own');
same(spec.clips[0].input, 0, 'and the clip points into the list by index');

delete input.decoderOptions.skip_frame;
A.inputs.reprobe(input);
pump(40);

// ── an option nothing takes is an error ────────────────────────────────────

console.log('\nan unknown option is refused, not shrugged at');
input.options.no_such_option = '1';
A.inputs.reprobe(input);
ok(!input.probe && input.error.indexOf('no_such_option') >= 0,
   `the open is refused and the key is named: ${input.error}`);
delete input.options.no_such_option;
A.inputs.reprobe(input);
ok(!!input.probe && !input.error, 'and taking it out again opens the file');

// ── a URL is an ordinary input ─────────────────────────────────────────────
//
// Nothing is fetched: the point is that a URL can *be* an input at all — that
// it is not turned into a path under ui/, that the protocol is recognised, and
// that its own option table is offered beside the demuxer's. What it would
// take to open one is a server, which a test has no business needing.

console.log('\na URL is an input like any other');
const protocols = bro.ffmpeg.protocols.input;
ok(protocols.indexOf('https') >= 0, `https is linked in (${protocols.length} input protocols)`);

type(el('src-path'), 'https://example.invalid/clip.mp4');
click(el('src-add'));
pump(60);
const url = A.inputs.inputs[A.inputs.inputs.length - 1];
same(url.path, 'https://example.invalid/clip.mp4',
     'the URL is kept as written, not resolved against the document');
ok(/^\/@input\//.test(url.src), 'and it gets a token, which is what makes it playable at all');
ok(el('src-detail').textContent.indexOf('https') >= 0,
   'the panel names the protocol it will go through');
ok(!!f('protooptsearch'), 'and offers the protocol’s own options beside the demuxer’s');
ok(!url.probe && !!url.error, `it cannot be reached from here, and says so: ${url.error}`);

A.inputs.removeInput(url);
pump(40);
ok(A.inputs.inputs.length === 1, 'an input with no clip is removed by asking');

screenshot('out/sources.png');
console.log(`\nPASS ui_sources — ${checks} checks`);
