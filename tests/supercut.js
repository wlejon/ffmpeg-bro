// The supercut application, driven the way a person drives it: find a phrase,
// put two of the moments in the mix, edit them with the four gestures, and write
// the file.
//
// **The gestures are real mouse events on the real cards**, not calls into
// `mix.js`. The four edits are the whole point of this application and each of
// them is a grab point on a card — a suite that called the functions behind them
// would pass with every one of those grab points wired to the wrong thing.
//
// **The corpus is built here rather than borrowed**, for the reason
// `tests/ui_find.js` gives at length: a real store is tens of gigabytes and is
// not in this repository, the well-known path is fixed, and a suite that used it
// would be one write away from overwriting somebody's real manifest.
//
// What is *not* checked here is that the words match the sound — they do not,
// and they do not have to. The application's job is to turn a time in a
// transcript into a clip of that time; whether the transcript is right is
// `transcribe`'s question.
//
// Usage: ffmpeg-bro-headless supercut/ tests/supercut.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/supercut.js -- <file>');

const fs = require('fs');
const A = globalThis.__supercut;
assert(A, 'the application did not start');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

let checks = 0;
function ok(cond, what) {
    assert(cond, `FAILED: ${what}`);
    checks++;
    console.log(`  ok  ${what}`);
}

/// A `change`-and-`input` that a text field actually hears — the suites
/// synthesise these because they never press a mouse. See the note on `change`
/// in CLAUDE.md.
function type(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    pump(60);
}

/// One drag, in three events, on the elements a hand would touch: down on the
/// grab point, move and up on `<body>` — which is where `mix.js` listens, for
/// the reason written beside those listeners.
function drag(target, dx) {
    const box = target.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const at = (type, node, cx) => node.dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX: cx, clientY: y }));
    at('mousedown', target, x);
    pump(20);
    // Two moves rather than one: the first crosses the slop that separates a
    // click from a drag, and the second is the edit. A gesture that only works
    // when the pointer teleports is not a gesture.
    at('mousemove', document.body, x + Math.sign(dx) * 8);
    at('mousemove', document.body, x + dx);
    pump(20);
    at('mouseup', document.body, x + dx);
    pump(60);
}

const cardEls = () => [...document.querySelectorAll('#cards .card')];
const order = () => A.mix.sequence();
const fileSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };

/// The one rule this application adds to the model: the mix has no holes and no
/// overlaps. Asserted after every edit, because every edit could break it.
function packed(where) {
    let at = 0;
    for (const c of order()) {
        if (Math.abs(c.start - at) > 1e-6) return `${where}: ${c.id} starts at ` +
            `${c.start.toFixed(3)} and should be at ${at.toFixed(3)}`;
        at += c.length;
    }
    return '';
}

// ── a corpus of our own ────────────────────────────────────────────────────

const dir = 'build/fixtures/supercut';
try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* there already */ }

const stamp = (s) => {
    const ms = Math.round(s * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:` +
           `${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// Two instances of the phrase far enough apart to be two moments, plus a run of
// talking and a decoy the boundary rule has to exclude.
const WORDS = [
    ['and', 0.0, 0.3], ['then', 0.35, 0.6], ['you', 0.7, 0.95], ['cross', 1.0, 1.4],
    ['the', 1.5, 1.7], ['line', 1.75, 2.1],
    ['before', 5.0, 5.4], ['you', 5.5, 5.7], ['crossing', 5.75, 6.3],
    ['and', 7.0, 7.2], ['you', 7.3, 7.5], ['cross', 7.55, 8.0],
    ['once', 8.1, 8.4], ['more', 8.5, 8.9],
];
fs.writeFileSync(`${dir}/words.srt`,
    WORDS.map((w, i) => `${i + 1}\n${stamp(w[1])} --> ${stamp(w[2])}\n${w[0]}\n`).join('\n'),
    'utf-8');
fs.writeFileSync(`${dir}/turkey.json`, JSON.stringify({
    channel: 'turkey', built: new Date().toISOString(),
    vods: [{ id: '1', title: 'a fixture', publishedAt: '2026-01-01',
             seconds: 60, srt: `${dir}/words.srt`, media, words: WORDS.length }],
}), 'utf-8');
fs.writeFileSync(`${dir}/find.json`, JSON.stringify({
    channels: [{ channel: 'turkey', manifest: `${dir}/turkey.json`,
                 vods: 1, words: WORDS.length, built: '' }],
}), 'utf-8');

// ── finding ────────────────────────────────────────────────────────────────

console.log('\nfinding');
{
    A.results.useCorpus(`${dir}/nothing-here.json`);
    ok(!A.results.available(), 'no manifest is no corpus, and that is not an error');

    A.results.useCorpus(`${dir}/find.json`);
    ok(A.results.available(), 'a manifest is a corpus');
    A.results.start();
    pump(120);

    // **A corpus is showing before anybody types.** This opened on an empty
    // Words list, which meant a window reporting four recordings and ninety
    // thousand words in the top bar and showing none of it.
    ok(A.results.currentTab() === 'recordings', 'it opens on what is in the corpus');
    ok(A.results.found().length === 1,
       `and the recording is listed without a search (${A.results.found().length})`);
    ok(document.querySelectorAll('#f-list .row.rec').length === 1,
       'as a row of its own shape, not as a hit');

    A.results.setTab('words');
    pump(80);
    const box = document.getElementById('f-phrase');
    ok(!!box, 'there is a box to type in');

    type(box, 'you cross');
    ok(A.results.found().length === 2,
       `"you cross" is found twice (${A.results.found().length})`);
    ok(A.results.found().every((h) => Math.abs(h.at - 5.5) > 0.01),
       'and never inside "you crossing", which is the boundary rule');

    A.results.setTab('talking');
    pump(80);
    ok(A.results.currentTab() === 'talking', 'the other question is showing');
    // **Answered on arrival at the tab's own settings**, rather than sitting
    // empty behind a Find button. Nothing in this fixture is thirty seconds
    // long, so the honest answer here is none — what is asserted is that the
    // question was asked, which the two below then change the answer to.
    ok(A.results.found().length === 0,
       'and it answered on arrival: nothing here is thirty seconds of talking');

    // The fixture has one 2.9 s hole in it, which is the point: at a 3 s gap the
    // whole thing is one stretch, and at 2 s it is two. A stretch is defined by
    // its gaps and by nothing else — and these are the real controls, so this is
    // also the assertion that they are wired to the search.
    type(document.getElementById('f-least'), '5');
    ok(A.results.found().length === 0,
       'at a two-second pause the hole cuts the fixture in half, and neither half lasts');
    type(document.getElementById('f-gap'), '3');
    ok(A.results.found().length === 1,
       `and a three-second pause welds it into one (${A.results.found().length})`);
    A.results.setTab('words');
    pump(80);
    type(document.getElementById('f-phrase'), 'you cross');
}

// ── two moments in the mix ─────────────────────────────────────────────────

console.log('\nthe mix');
{
    A.results.add(0);
    // The probe is a thread; the frame loop is what finishes the add.
    for (let i = 0; i < 200 && order().length < 1; i++) pump(50);
    ok(order().length === 1, 'a found moment becomes a clip');

    A.results.add(1);
    for (let i = 0; i < 200 && order().length < 2; i++) pump(50);
    ok(order().length === 2, 'and a second one');

    ok(!packed('two clips'), packed('two clips') || 'the mix is packed end to end');
    ok(cardEls().length === 2, 'and there are two cards to grab');
}

// ── and each of them is cut out of the recording ───────────────────────────
//
// The clip is in the row on the frame the button was pressed, against the
// recording; the copy that makes it a piece of its own catches up. What is
// asserted here is the *end* of that, because the beginning is a race by design
// — see supercut/cuts.js.

console.log('\ncutting');
{
    const before = order().map((c) => ({ id: c.id, len: c.length, at: c.start }));
    for (let i = 0; i < 400 && A.cuts.pending(); i++) pump(25);
    ok(!A.cuts.pending(), `every cut settled (${A.cuts.pending()} left)`);

    const isCut = (c) => c.path.replace(/\\/g, '/').indexOf('/build/cuts/') >= 0;
    // **Which branch this is depends on the file, and both are the right
    // answer.** A moment plus twenty seconds of handles is a piece of a
    // six-hour recording and worth taking out of it; of a ten-second fixture it
    // is the whole file, and copying a file to itself is the one thing `MOST`
    // exists to refuse. So the fixture asserts the refusal and a real recording
    // asserts the cut — the same shape as every other suite here, which runs
    // against whatever it is given and skips what that file cannot show.
    const long = order().every((c) => c.media > (c.length + 2 * A.cuts.PAD) * 2);
    if (long) {
        const states = order().map((c) => A.cuts.stateOf(c.id));
        ok(states.every((s) => s === 'done'),
           `both moments were cut out rather than refused (${states.join(', ')})`);
        ok(order().every(isCut), 'and each clip is now a clip of its own cut');
        ok(order().every((c) => fileSize(c.path) > 0), 'which is a file on disk');
        // **The recording is off the list.** Left on it, it would be an `-i` in
        // every spec built from this document and a fifteen-gigabyte file the
        // document could not be opened without.
        ok(A.inputs.length === 2 && A.inputs.every(isCut),
           `the inputs are the two cuts and not the recording (${A.inputs.length})`);
    } else {
        ok(order().every((c) => A.cuts.stateOf(c.id) === null),
           'a moment that is most of its recording is not worth cutting out of it');
        ok(order().every((c) => !isCut(c)),
           'so the clips are clips of the recording, which is what was asked for');
        ok(A.inputs.length === 1,
           `both are clips of one input rather than the file being opened twice ` +
           `(${A.inputs.length})`);
    }

    // Either way the edit is the edit it was: a cut moves which file a clip is
    // of and where its zero is, and must move nothing else.
    const after = order().map((c) => ({ id: c.id, len: c.length, at: c.start }));
    ok(after.length === before.length &&
       after.every((a, i) => a.id === before[i].id &&
                             Math.abs(a.len - before[i].len) < 1e-6 &&
                             Math.abs(a.at - before[i].at) < 1e-6),
       'and neither clip changed its length or its place in the row');
    ok(!packed('after cutting'), packed('after cutting') || 'the mix is still packed');
}

// ── trimming, which ripples because a sequence has no holes ────────────────
//
// The regression that matters is **growing**. `ui/project.js` stops a trim at
// the neighbour, which on a timeline is right and in a packed sequence would
// mean no clip could ever be made longer — see `unwalled` in supercut/mix.js.

console.log('\ntrim');
{
    const [a, b] = order();
    const len0 = a.length, total0 = A.duration();

    drag(cardEls()[0].querySelector('.edge.r'), -30);
    ok(a.length < len0 - 0.05,
       `dragging the out-point in makes the clip shorter (${len0.toFixed(2)} → ` +
       `${a.length.toFixed(2)}s)`);
    ok(Math.abs(b.start - a.length) < 1e-6,
       'and the clip after it closes up, which is what ripple means here');
    ok(A.duration() < total0 - 0.05, 'so the mix is shorter by the same amount');
    ok(!packed('after a trim'), packed('after a trim') || 'still packed');

    const shorter = a.length;
    drag(cardEls()[0].querySelector('.edge.r'), 40);
    ok(a.length > shorter + 0.05,
       `and dragging it back out makes it longer again (${a.length.toFixed(2)}s) — ` +
       'which the model refuses on a timeline, because the neighbour is a wall');
    ok(!packed('after growing'), packed('after growing') || 'still packed');

    // The head, which is the other edge and the other clamp: there is no footage
    // before the head of the file.
    const in0 = a.inPoint;
    drag(cardEls()[0].querySelector('.edge.l'), 20);
    ok(a.inPoint > in0 + 0.01 || in0 === 0,
       'trimming the head spends footage rather than moving the clip');
    ok(Math.abs(order()[0].start) < 1e-6,
       'and the first clip is still at zero, because everything moved instead');
}

// ── slip: the window holds still and the footage moves inside it ───────────

console.log('\nslip');
{
    const a = order()[0];
    const start0 = a.start, len0 = a.length, in0 = a.inPoint;
    drag(cardEls()[0].querySelector('canvas'), -25);
    ok(Math.abs(a.start - start0) < 1e-6 && Math.abs(a.length - len0) < 1e-6,
       'the card does not move and does not change length');
    ok(a.inPoint > in0 + 0.01,
       `and it shows later footage: dragging left pushes the film forward ` +
       `(${in0.toFixed(2)} → ${a.inPoint.toFixed(2)}s)`);
    ok(!packed('after a slip'), packed('after a slip') || 'still packed');
}

// ── rate: the footage holds still and the length changes ──────────────────

console.log('\nrate');
{
    const a = order()[0];
    const span0 = a.length * a.speed, len0 = a.length;
    drag(cardEls()[0].querySelector('.rate'), 170);
    ok(Math.abs(a.speed - 2) < 0.05,
       `a drag of one interval doubles the speed (${a.speed.toFixed(2)}×)`);
    ok(Math.abs(a.length * a.speed - span0) < 0.02,
       'the same footage is in it — that is what separates a rate change from a trim');
    ok(a.length < len0 * 0.6,
       `so the card is about half as long (${len0.toFixed(2)} → ${a.length.toFixed(2)}s)`);
    ok(!packed('after a rate change'), packed('after a rate change') || 'still packed');
}

// ── reorder ────────────────────────────────────────────────────────────────

console.log('\nreorder');
{
    const [a, b] = order();
    // Far enough right to pass the middle of the clip after it, which is when a
    // card changes places.
    drag(cardEls()[0].querySelector('.grip'), 400);
    ok(order()[0] === b && order()[1] === a, 'dragging the grip moves the card past its neighbour');
    ok(!packed('after a reorder'), packed('after a reorder') || 'still packed');
    ok(Math.abs(order()[0].start) < 1e-6, 'and what is now first starts at zero');
}

// ── the document is the workbench's ────────────────────────────────────────

console.log('\nthe document');
{
    const path = bro.ffmpeg.tempPath('supercut-test.fbro');
    A.doc.save(path);
    const back = JSON.parse(fs.readFileSync(path, 'utf-8'));
    ok(Array.isArray(back.clips) && back.clips.length === 2,
       'a supercut saves as an ordinary .fbro, which is what opens in ffmpeg-bro');
    ok(back.clips.some((c) => Math.abs((c.speed || 1) - 2) < 0.05),
       'and the speed a rate drag set is in it');

    // Everything about the edit, put back. Ids included: a clip's id is a name
    // other things write down, which is why `open` restores rather than renumbers.
    const wasFirst = order()[0].id;
    A.doc.open(back);
    pump(200);
    ok(order().length === 2, 'and it opens back into two clips');
    ok(order()[0].id === wasFirst, 'with the ids the document named, not fresh ones');
}

// ── writing the file ───────────────────────────────────────────────────────
//
// The end of the whole chain: the same `buildSpec()` the workbench renders with,
// over clips this application laid out, through `bro.ffmpeg.render`. **The sound
// is the assertion**, because a supercut of speech with a silent track is the
// one failure that makes the entire application pointless — and it is a failure
// that has happened here before.

console.log('\nwriting');
{
    const out = bro.ffmpeg.tempPath('supercut-test.mp4');
    A.settings.path = out;
    A.settings.container = 'mp4';
    A.settings.videoCodec = 'libx264';
    A.settings.audioCodec = 'aac';

    // **The button is deliberately not pressed.** It opens SDL's save dialog,
    // which blocks the thread this suite runs on — so what is driven here is
    // everything the press does *after* a path comes back, which is the whole
    // of the render path and the only part with anything to get wrong.
    const built = A.buildSpec();
    ok(built.path === out, 'the spec writes where the settings say');
    ok(built.audio, 'and it has sound in it before a frame is encoded');
    bro.ffmpeg.render.start(built);
    for (let i = 0; i < 1200 && bro.ffmpeg.render.poll().state === 'running'; i++) pump(50);
    const done = bro.ffmpeg.render.poll();
    ok(done.state === 'done', `the render finished: ${done.state} ${done.error || ''}`);

    const got = bro.ffmpeg.probe(out);
    ok(!!got.video, 'the file has a picture');
    ok(!!got.audio, 'and a soundtrack, which is the whole point of a supercut');
    ok(Math.abs(got.format.duration - A.duration()) < 0.5,
       `and it is as long as the mix (${got.format.duration.toFixed(2)} vs ` +
       `${A.duration().toFixed(2)}s)`);
}

console.log(`\n${checks} checks passed`);
