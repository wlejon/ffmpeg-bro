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

// ── a URL is an ordinary input, opened off this thread ─────────────────────
//
// **Nothing here reaches a network and nothing here needs one.** The address is
// 192.0.2.1, which RFC 5737 reserves for documentation and which is therefore
// never assigned to anything — so what this section asserts is what this
// application does while an open is going nowhere, which is a fact about this
// code. It never asserts that something answered; a test that needed a server
// would be a suite that fails on a train.
//
// Three claims, in order of what they are worth:
//
//   - **Adding a URL returns at once.** It did not before: `probe()` is
//     synchronous, and this thread is the whole application — stage views are
//     never unmounted and the viewer's `<video>` elements are the decoders — so
//     a four-second open was a four-second frozen window.
//   - **The stage says it is connecting, and offers to stop.**
//   - **The stop reaches the open.** `bro.ffmpeg.probes.cancel` sets the
//     `AVIOInterruptCB` libav polls, which is the only thing that can abort a
//     connect already in progress; the input then settles as `stopped` rather
//     than as a fault nobody caused.

console.log('\na URL is an input like any other, opened off this thread');
const protocols = bro.ffmpeg.protocols.input;
ok(protocols.indexOf('https') >= 0, `https is linked in (${protocols.length} input protocols)`);

const nowhere = 'https://192.0.2.1/clip.mp4';
type(el('src-path'), nowhere);
const beforeAdd = Date.now();
click(el('src-add'));
const addMs = Date.now() - beforeAdd;
const url = A.inputs.inputs[A.inputs.inputs.length - 1];

ok(addMs < 500, `adding it returns in ${addMs}ms — the open is on a thread of its own`);
same(url.path, nowhere, 'the URL is kept as written, not resolved against the document');
ok(/^\/@input\//.test(url.src), 'and it gets a token, which is what makes it playable at all');
ok(A.inputs.opening(url), 'the input is opening rather than probed');
ok(el('src-detail').textContent.indexOf('https') >= 0,
   'the panel names the protocol it will go through');
ok(!!f('protooptsearch'), 'and offers the protocol’s own options beside the demuxer’s');

pump(200);
// A machine with no route at all answers "network unreachable" at once, and
// then there is nothing left to stop — a real outcome and not a failure, so the
// half that needs a *blocked* open is skipped rather than failed, the way every
// suite here skips what its fixture cannot provide. The claim above it, that
// adding one did not block, holds either way.
if (A.inputs.opening(url)) {
    ok(el('src-detail').textContent.indexOf('Connecting') >= 0,
       'while it waits the panel says Connecting, with the seconds against the deadline');
    ok(!!f('srcstop'), 'and offers to stop');
    ok(A.project.clips.length === 1,
       'and the rest of the application kept running — the timeline is untouched');
    click(f('srcstop'));
    waitFor('the open to give up', () => !A.inputs.opening(url), 5000);
    same(url.error, 'stopped',
         'Stop aborts the open itself and the input says so, rather than reporting a fault');
} else {
    console.log(`  SKIP  nothing to stop: this machine answered at once (${url.error})`);
    ok(!url.probe && !!url.error, `and the input says why: ${url.error}`);
}

A.inputs.removeInput(url);
pump(40);
ok(A.inputs.inputs.length === 1, 'an input with no clip is removed by asking');

// ── a stream off a page: its other renditions, and saving one locally ──────
//
// `ui/vod.js` turns a Twitch page into a list of HLS renditions — the picture at
// 1080p60 for the cut, `Audio Only` at a fraction of the bytes for a
// transcription pass — and until now everything but the first was resolved,
// counted in a flash message and thrown away, so the second job meant leaving
// the application for a script.
//
// **Driven without the network**, which is the only way this can be a test:
// what `resolve()` produces is `{ path, name, origin, renditions }` and that
// shape is handed to `addInput` directly, pointed at the fixture. What is
// checked is everything downstream of the resolve — which is all of the part
// that is this application's.
//
// Three claims:
//
//   - **the other renditions are on the card**, and picking one is an ordinary
//     change of `-i`;
//   - **`Save a local copy` pulls both of them, the soundtrack first**, in the
//     background and without walking anywhere. The order is the claim: the
//     picture does not begin until the soundtrack is off the link, because the
//     two sharing it cost the soundtrack a third of its rate — see the
//     measurement in ui/localcopy.js;
//   - **the soundtrack landing is said out loud**, since the whole point of
//     pulling it first is that the work needing only sound can start while the
//     picture is still arriving;
//   - **it is a copy and not a re-encode.** Every row is a `copy:`, or the whole
//     point of doing it in this application rather than with a downloader is
//     gone;
//   - **and `Describe it…` is still the way to take the decisions by hand**,
//     which is the Write stage and a range on a row.

A.shell.goTo('sources');
pump(100);
{
    const streamed = A.inputs.addInput({
        path: media,
        name: 'Twitch VOD 123 1080p60',
        origin: 'https://www.twitch.tv/videos/123',
        renditions: [
            { name: '1080p60', url: media, bandwidth: 6000000 },
            { name: 'Audio Only', url: media, bandwidth: 160000, audioOnly: true },
        ],
        rendition: '1080p60',
    });
    waitFor('the stream to open', () => !!streamed.probe || !!streamed.error);
    A.drawSources();
    pump(60);
    // Chosen by clicking its row, which is how the detail column is pointed at
    // an input: `addInput` is the model and the stage's own add path is what
    // normally selects what it just made.
    const pickRow = () => { click(q(`[data-input="${streamed.id}"]`)); pump(60); };
    pickRow();

    const pick = f('srcrendition');
    ok(!!pick, 'an input that came from a page offers its other renditions');
    ok(pick && pick.options.length === 2, 'both of them, not just the one being read');
    ok(el('src-detail').textContent.indexOf('Audio Only') >= 0,
       'the sound-only one is named as such — it is the one a transcription pass wants');

    // ── the pull ───────────────────────────────────────────────────────────
    //
    // The press starts two fetches and stays here. It used to lay a clip out,
    // walk to the Write stage and fill a render in — right about a copy being a
    // render, wrong about the machinery, because the render is the one job slot
    // and a download held it for as long as it took.
    const wasStage = A.shell.currentStage();
    click(f('srclocal'));

    // **Read before anything is pumped**, which is the only place the ordering
    // is visible: these renditions are ten-second fixtures on a local disk and
    // both pulls are over inside one frame. What the press *decides* is decided
    // synchronously, so this is the state it decided.
    const job = A.localcopy.copiesOf(streamed);
    ok(!!job, 'the card knows about this input’s pulls now');
    ok(!job.sameClock,
       'and knows the two are different renditions, so a time found in one is a ' +
       'search hint in the other rather than a cut');
    // **The order, which is the whole claim.** The picture is not started until
    // the soundtrack is off the link: queued together the picture takes the
    // bandwidth and the soundtrack falls to a third of its own rate, so what
    // "audio first" buys is not a smaller file arriving sooner — it is the
    // soundtrack arriving sooner than anything can if the two are sharing.
    same(job.video.state, 'waiting',
         'the picture waits: it does not begin until the soundtrack is off the link');
    same(job.audio.state, 'probing',
         'and the soundtrack is already being opened');

    pump(120);
    same(A.shell.currentStage(), wasStage,
         'the press starts the pull and stays where it is — nothing to walk to');
    ok(!A.exporter.isRunning(),
       'and the render is untouched: a fetch is not in the job slot');

    waitFor('the soundtrack to land', () => job.audio.state === 'done' ||
                                            job.audio.state === 'failed', 60000);
    same(job.audio.state, 'done', `the soundtrack is here (${job.audio.error || 'no error'})`);
    ok(/\.audio\.mkv$/.test(streamed.localAudio || ''),
       `and the input knows where it is: ${streamed.localAudio}`);
    ok(A.localcopy.soundIsHere(streamed),
       'which is the question the whole ordering exists to answer yes to early');

    A.drawSources();
    pump(60);
    ok(el('src-detail').textContent.indexOf('soundtrack is on this machine') >= 0,
       'and the card says so, rather than leaving it to be discovered');

    waitFor('the picture to land', () => job.video.state === 'done' ||
                                         job.video.state === 'failed', 60000);
    same(job.video.state, 'done', `the picture follows it (${job.video.error || 'no error'})`);
    ok(/\.mkv$/.test(streamed.localCopy || '') &&
       streamed.localCopy !== streamed.localAudio,
       `written to a name of its own: ${streamed.localCopy}`);
    // The durable witness that the order held, rather than a timing that this
    // fixture is far too small to show: the queue numbers fetches as they are
    // asked for, so a picture queued after the soundtrack has the larger number.
    ok(job.video.fetch > job.audio.fetch,
       `the picture was queued after the soundtrack (fetch ${job.audio.fetch} then ` +
       `${job.video.fetch})`);

    // What came out is the stream, copied. Read back rather than asserted from
    // the spec: "the rows said copy:" is not the same claim as "the file has the
    // packets in it".
    const back = bro.ffmpeg.probe(streamed.localCopy);
    ok(back && back.streams.length > 0, `the file opens (${back.streams.length} streams)`);
    ok(!back.streams.some((s) => s.kind === 'data'),
       'with no data stream, which Matroska will not hold');

    A.drawSources();
    pump(60);
    pickRow();
    ok(!!f('srclocaluse'),
       'once a copy is here the card offers to point the input at it, which is what ' +
       'makes a word search run on local media');

    // ── and the same copy, by hand ─────────────────────────────────────────
    //
    // The press takes every decision, and those are defaults rather than the
    // only answers. A section, another container or simply reading the command
    // first are the Write stage's, and this is the door to it.
    A.openInput(streamed, { quiet: true });
    pump(120);
    A.shell.goTo('sources');
    pickRow();
    click(f('srclocalhand'));
    pump(120);
    same(A.shell.currentStage(), 'write', 'Describe it… walks to the stage that writes files');

    const S = A.exporter.currentSettings();
    same(S.container, 'matroska',
         'Matroska, because a copy has to go into a container that will hold what is ' +
         'being copied');
    ok(/\.mkv$/.test(S.path || ''), `and a path was filled in: ${S.path}`);
    ok(S.streams.length > 0, 'the stream list was written');
    ok(S.streams.every((s) => String(s.source || '').startsWith('copy:')),
       'every row is a copy — no decode and no encode, which is the whole point');
    ok(!S.streams.some((s) => s.kind === 'data'),
       'and no data row, which Matroska will not hold');
    ok(!A.exporter.isRunning(), 'nothing has been started — the invocation is there to read');
    console.log(`  ${streamed.name}: sound → ${streamed.localAudio}, ` +
                `picture → ${streamed.localCopy}`);

    // The two files this section really wrote. They land beside the document,
    // and a test with no document open has none — so they land in the working
    // directory, which for ctest is the repository. Cleaned up here rather than
    // gitignored: a pattern in .gitignore would hide the next thing that starts
    // writing there by accident.
    const fs = require('fs');
    for (const path of [streamed.localAudio, streamed.localCopy]) {
        try { fs.unlinkSync(path); } catch (e) { /* it is allowed not to be there */ }
    }
}

screenshot('out/sources.png');
console.log(`\nPASS ui_sources — ${checks} checks`);
