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

// The corpus itself, for the two assertions that are about *it* rather than
// about a control: which kinds of re-read keep a confined search and which drop
// it. Modules are one instance to a realm, so this is the library the window is
// using and not a second copy of it.
import * as library from '/app/../ui/library.js';
import * as phrase from '/app/../ui/phrase.js';
// Where this checkout is, which is the one thing the fixture paths below have to
// agree with the application about — see `dir`.
import { ROOT, abs } from '/app/../corpus/files.js';
// The two halves of "footage that is already on this disk": what makes a folder
// into a channel, and where the store then says that channel's recordings are.
// Reached the same way `library` is, so this drives the modules the window is
// using rather than second copies of them.
import * as local from '/app/../corpus/local.js';
import * as store from '/app/../corpus/store.js';
// Where the speech model is looked for, which is a question about this machine
// rather than about the corpus — see the section that drives it.
import * as words from '/app/../corpus/words.js';
import * as model from '/app/../corpus/model.js';

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

// **Absolute, and that is not tidiness.** A relative path given to `fs` in a bro
// realm is resolved against the *application* directory, and one given to
// `corpus/files.js` is resolved against the repository root — so a manifest
// written here with a relative `srt` in it was findable by the library and
// invisible to `corpus/store.js`, and every row came up `pulled` with the words
// sitting right there. A real manifest holds absolute paths, so the fixture does
// too, and the two halves are asked the same question.
const dir = `${ROOT}/build/fixtures/supercut`;
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

// ── confining the search to some recordings ────────────────────────────────
//
// **A second corpus rather than a second recording in the first one**, because
// every count asserted above is a count over one recording and adding another
// would move all of them — the assertions would still pass and would have
// stopped being about what they say they are about. This one has what the
// feature needs and nothing else: two recordings saying the same thing, so
// confining the search to one has to halve the answer, and two channels, so the
// rule about which switch drops a choice can be exercised at all.
//
// Driven through the tick itself and not through the library underneath it: the
// press is what somebody actually does, and a test that called `choose` would
// pass on a row whose box was never wired to it.

console.log('\nconfining the search');
{
    const two = { channel: 'twofer', built: new Date().toISOString(),
                  vods: [{ id: 'a', title: 'the first', publishedAt: '2026-02-02',
                           seconds: 60, srt: `${dir}/words.srt`, media,
                           words: WORDS.length },
                         { id: 'b', title: 'the second', publishedAt: '2026-02-01',
                           seconds: 60, srt: `${dir}/words.srt`, media,
                           words: WORDS.length }] };
    fs.writeFileSync(`${dir}/twofer.json`, JSON.stringify(two), 'utf-8');
    fs.writeFileSync(`${dir}/both.json`, JSON.stringify({
        channels: [{ channel: 'twofer', manifest: `${dir}/twofer.json`,
                     vods: 2, words: 2 * WORDS.length, built: '' },
                   { channel: 'turkey', manifest: `${dir}/turkey.json`,
                     vods: 1, words: WORDS.length, built: '' }],
    }), 'utf-8');

    A.results.useCorpus(`${dir}/both.json`);
    A.results.start();
    pump(80);

    const boxes = () => [...document.querySelectorAll('#f-list .row.rec .pick')];
    const found = (phrase) => {
        A.results.setTab('words');
        pump(60);
        type(document.getElementById('f-phrase'), phrase);
        pump(80);
        return A.results.found().length;
    };

    A.results.setTab('recordings');
    pump(80);
    ok(boxes().length === 2, `both recordings offer a tick (${boxes().length})`);
    ok(boxes().every((b) => b.checked),
       'and every one is ticked, because every one is being searched');

    const all = found('you cross');
    ok(all === 4, `unconfined, the phrase is found in both (${all})`);

    // Untick the second: the first untick starts from everything and takes one
    // away, which is the only reading of a row of ticked boxes that is true.
    A.results.setTab('recordings');
    pump(60);
    const off = boxes()[1];
    off.checked = false;
    off.dispatchEvent(new Event('change', { bubbles: true }));
    pump(80);

    const half = found('you cross');
    ok(half === all / 2, `one recording finds half of it (${half} of ${all})`);
    ok(A.results.found().every((h) => String(h.vod.id) === 'a'),
       'and every hit comes from the recording that is still ticked');

    A.results.setTab('recordings');
    pump(60);
    ok(boxes().length === 2,
       'the list still shows both — it is where the choice is made');
    ok(document.getElementById('about').textContent.includes('1 of 2'),
       `the header says which (${document.getElementById('about').textContent})`);

    // The last ticked box cannot be unticked: there is no "search nothing".
    const last = boxes()[0];
    last.checked = false;
    last.dispatchEvent(new Event('change', { bubbles: true }));
    pump(80);
    ok(found('you cross') === half,
       'unticking the last one is refused rather than searching nothing');

    // A transcription landing re-reads the corpus, and must not change the
    // question underneath somebody.
    A.results.setTab('recordings');
    pump(60);
    library.reload();
    pump(80);
    ok(found('you cross') === half, 'a reload leaves a confined search alone');

    // Moving to another channel does, because the ids belong to the one they
    // were chosen in.
    library.pick('turkey');
    pump(80);
    ok(found('you cross') === 2,
       `another channel is searched whole (${A.results.found().length})`);

    A.results.useCorpus(`${dir}/find.json`);
    A.results.start();
    A.results.setTab('words');
    pump(80);
    type(document.getElementById('f-phrase'), 'you cross');
    pump(80);
    ok(A.results.found().length === 2, 'and the suite is back where it was');
}

// ── hearing one, and stopping ──────────────────────────────────────────────
//
// The stop is the half that was missing: an audition ends by itself at the end
// of the moment, which is nothing at all for a six-hour recording pressed by
// mistake. Driven on the button rather than through `screen`, because what is
// asserted is that the row's own control is both halves of it.

console.log('\nauditioning');
{
    const press = (node) => {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(120);
    };
    const listen = () => document.querySelector('#f-list .row button.tiny');

    ok(listen().textContent === '▶', 'a row offers to play the moment');
    press(listen());
    ok(A.screen.isAuditioning(), 'and pressing it plays');
    ok(listen().textContent === '■', 'the same button is now the stop');

    press(listen());
    ok(!A.screen.isAuditioning(), 'which stops it');
    ok(listen().textContent === '▶', 'and offers to play it again');

    // Space is the key everything else stops with, so it is this one's stop too
    // — starting the mix over the top of it would be two things playing.
    press(listen());
    ok(A.screen.isAuditioning(), 'playing again');
    A.togglePlay();
    pump(60);
    ok(!A.screen.isAuditioning() && !A.screen.isPlaying(),
       'Space stops the audition rather than starting the mix under it');
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

// ── one place for everything that is running ───────────────────────────────
//
// Whatever is in flight on this file — the cuts, the proxies, or both, which
// depends on how long the recording is exactly as the cutting section below
// depends on it — is here. What is asserted is the *view*: one row per job and
// no row without one, and a header button that is not there at all when nothing
// is running.

console.log('\nwhat is running');
{
    const button = document.getElementById('btn-flight');
    const panel = document.getElementById('flight');
    const rows = () => document.querySelectorAll('#flight .fl-row').length;

    A.inflight.toggle(true);
    ok(!panel.hidden, 'the list opens');
    // No `pump` between the two: a frame in the middle is a job settling in the
    // middle, and this is about the drawing rather than about the timing.
    const n = A.inflight.count();
    ok(rows() === n, `one row per job and no more (${rows()} of ${n})`);
    ok(n > 0 || document.querySelectorAll('#flight .fl-empty').length === 1,
       'and nothing running says so rather than showing an empty box');

    for (let i = 0; i < 600 && A.inflight.count(); i++) pump(25);
    ok(A.inflight.count() === 0, `everything settles (${A.inflight.count()} left)`);
    ok(rows() === 0 && document.querySelectorAll('#flight .fl-empty').length === 1,
       'and the list says so');

    // A job of its own, handed in the way the render is: the three background
    // jobs this fixture can produce are all over in under a second and a suite
    // that waited for one would be asserting about a race. What is checked here
    // is the row — the columns, the bar and the Stop that calls back into
    // whatever owns the job, which is the whole of what this file does.
    let stopped = 0;
    const fake = { key: 'render', kind: 'Render', name: 'supercut.mp4',
                   note: '50%', progress: 0.5, stop: () => { stopped++; } };
    let live = fake;
    A.inflight.initFlight({ button, panel }, { render: () => live });
    A.inflight.toggle(true);
    ok(rows() === 1, `a job in flight is a row (${rows()})`);
    ok(panel.querySelector('.fl-row .kind').textContent === 'Render' &&
       panel.querySelector('.fl-row .name').textContent === 'supercut.mp4' &&
       panel.querySelector('.fl-row .note').textContent === '50%',
       'saying what it is, what it is of and how far it has got');
    ok(panel.querySelector('.fl-row .fill').style.width === '50%',
       `with a bar that says the same (${panel.querySelector('.fl-row .fill').style.width})`);
    ok(!button.hidden && button.textContent === '1 running',
       `and the header carries the count (${button.textContent})`);

    panel.querySelector('.fl-row button').dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }));
    ok(stopped === 1, 'the Stop on the row is the job\'s own stop');

    live = null;
    // Settle to *quiet* before asking whether the button is gone. The clips the
    // section above put in the mix each ask for a proxy, and a proxy is a real
    // encode whose length belongs to the machine rather than to this suite:
    // NVENC where there is a card, libx264 on a runner where there is not. It is
    // also asked for on the frame the mix is drawn rather than on the frame the
    // clip was added, so a single settle proves nothing — one ran green here
    // with a count of zero and then watched a job start on the very next pump.
    // What this needs is several frames in a row with nothing running, by which
    // time every distinct file has its proxy and `pathFor` answers from the
    // cache rather than starting an encode.
    let quiet = 0;
    for (let i = 0; i < 800 && quiet < 8; i++)
        { pump(25); quiet = A.inflight.count() ? 0 : quiet + 1; }
    A.inflight.toggle(false);
    pump(40);
    ok(panel.hidden, 'it closes');
    ok(button.hidden && A.inflight.count() === 0,
       `and with nothing running the button is not there either (${A.inflight.count()} running)`);
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

// ── and each of them gets a file a hand can drag over ──────────────────────
//
// A proxy is the second thing made for a clip and the first that changes
// nothing: the same clip, of the same file, at the same length, with one more
// file on disk that `supercut/screen.js` shows it from. So what is asserted is
// exactly that — there is one, it is not the clip's own file, and the edit did
// not notice. `pending()` above already waited for it: it counts both stages.

console.log('\nthe proxy');
{
    const before = order().map((c) => ({ id: c.id, path: c.path, len: c.length }));
    for (let i = 0; i < 400 && A.cuts.pending(); i++) pump(25);

    // **Frames first, then the wait.** A proxy is *asked for* by the frame loop
    // — `cuts.tick()` is where a clip that has none is noticed — so `pending()`
    // is zero until one has run, and a wait written the other way round would
    // fall straight through and assert about proxies nobody had requested.
    pump(60);
    for (let i = 0; i < 400 && A.cuts.pending(); i++) pump(25);

    const proxies = order().map((c) => A.cuts.proxyFor(c.path));
    ok(proxies.every((p) => p), `every clip has one (${proxies.filter(Boolean).length}` +
                                ` of ${proxies.length})`);
    ok(proxies.every((p, i) => p !== order()[i].path),
       'and it is a second file rather than the one the clip is of');
    ok(proxies.every((p) => fileSize(p) > 0), 'which is on disk');
    ok(proxies.every((p) => p.indexOf(`-p${A.cuts.PROXY_HEIGHT}.mkv`) > 0),
       `named for the height it was made at (${A.cuts.PROXY_HEIGHT})`);

    // **Nothing about the edit moved.** This is the whole reason a proxy landing
    // is `'screen'` and not `'edit'` in `cuts.tick()`: a row rebuilt here would
    // be a row destroyed under a hand, and a document marked unsaved here would
    // be claiming an edit nobody made.
    const after = order().map((c) => ({ id: c.id, path: c.path, len: c.length }));
    ok(after.length === before.length &&
       after.every((a, i) => a.id === before[i].id && a.path === before[i].path &&
                             Math.abs(a.len - before[i].len) < 1e-6),
       'and no clip changed its file, its length or its place');

    // **It is not in the document**, which is `ui/localcopy.js`'s rule: a proxy
    // is a fact about this machine. A `.fbro` that named one would be a document
    // that opened differently on a machine where the file had been deleted.
    const blob = JSON.stringify(A.doc.snapshot());
    ok(blob.indexOf(`-p${A.cuts.PROXY_HEIGHT}.mkv`) < 0,
       'and no proxy is named anywhere in the document');
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

// ── a head trim keeps the playhead on its sound ────────────────────────────
//
// The mix closes up behind a trim, so a head trim moves the clip's own footage
// out from under a playhead that stayed where it was. What is asserted is the
// thing that matters and not the arithmetic that gets there: the *file* moment
// under the playhead is the same one afterwards.

console.log('\nthe head holds its sound');
{
    const a = order()[0];
    /// Where in the file the playhead is standing, which is the whole question.
    const under = (c, t) => c.inPoint + (t - c.start) * (c.speed || 1);

    A.seek(a.start + a.length * 0.6);
    pump(60);
    const was = under(a, A.transport.t), at0 = A.transport.t, in0 = a.inPoint;

    drag(cardEls()[0].querySelector('.edge.l'), 30);
    ok(a.inPoint > in0 + 0.01,
       `the head is trimmed (${in0.toFixed(3)} → ${a.inPoint.toFixed(3)}s into the file)`);
    ok(A.transport.t < at0 - 0.01,
       `and the playhead came back with the material (${at0.toFixed(3)} → ` +
       `${A.transport.t.toFixed(3)}s)`);
    ok(Math.abs(under(a, A.transport.t) - was) < 0.02,
       `so it is standing on the same sound it was standing on (${was.toFixed(3)}s)`);

    // Trimmed past, there is no material left to hold it on: it lands on what is
    // now the head rather than being left inside the part that was removed.
    A.seek(a.start + 10 / A.mix.zoom());
    pump(60);
    drag(cardEls()[0].querySelector('.edge.l'), 40);
    ok(Math.abs(A.transport.t - order()[0].start) < 1e-6,
       'and a trim that goes past it leaves it on the new head');
    ok(!packed('after a head trim'), packed('after a head trim') || 'still packed');
}

// ── the magnet: a trim taken by the playhead ───────────────────────────────
//
// The one thing on the strip that is not a card and is worth landing on. Driven
// as a real drag, because the magnet is inside the move handler and a test that
// called `trimClip` would pass with the magnet wired to nothing.

console.log('\nthe magnet');
{
    const a = order()[0];
    const px = A.mix.zoom();
    // The playhead a little inside the out-point, and the drag aimed two pixels
    // past it: near enough to be taken, and not so near that landing there would
    // have happened anyway.
    A.seek(a.length - 20 / px);
    pump(60);
    const at = A.transport.t;
    drag(cardEls()[0].querySelector('.edge.r'), -22);
    ok(Math.abs(a.length - at) < 1e-6,
       `an out-point dragged to within two pixels of the playhead lands on it ` +
       `(${a.length.toFixed(4)} = ${at.toFixed(4)}s)`);

    // And the same drag from further off is not taken, which is the half that
    // makes it a magnet rather than a rule.
    const len0 = a.length;
    A.seek(a.length - 60 / px);
    pump(60);
    const far = A.transport.t;
    drag(cardEls()[0].querySelector('.edge.r'), -20);
    ok(Math.abs(a.length - far) > 0.5 / px,
       'and one that stops forty pixels short of it is left where the hand put it');
    ok(Math.abs(a.length - (len0 - 20 / px)) < 0.02,
       `— exactly where the hand put it (${a.length.toFixed(3)}s)`);
    ok(!packed('after a magnet'), packed('after a magnet') || 'still packed');
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

// ── the window onto the mix ────────────────────────────────────────────────
//
// **The row really moves**, which is the assertion the rest of this rests on:
// the offset is a negative margin because this engine has no horizontal
// scrolling, and a margin the layout declined to apply would leave every number
// below correct and nothing on the screen where it says.

console.log('\nthe window');
{
    const strip = document.getElementById('strip');
    const zoomBox = document.getElementById('zoom');
    const stripLeft = () => strip.getBoundingClientRect().left;
    const firstCardX = () => cardEls()[0].getBoundingClientRect().left - stripLeft();

    A.mix.fit();
    A.mix.draw();
    pump(40);
    ok(A.mix.view().left === 0 && A.mix.view().span >= A.duration() - 1e-6,
       'Fit puts the whole mix on the strip, starting at zero');
    ok(document.getElementById('mix-scroll').style.visibility === 'hidden',
       'and there is nothing to scroll, so the bar is not offering to');

    // In far enough that the mix is three strips wide — computed from the mix
    // rather than typed, so this says the same thing whatever is in it, and kept
    // clear of the top of the range so the wheel below still has somewhere to go.
    type(zoomBox, String(Math.round(Math.min(900, (strip.clientWidth * 3) / A.duration()))));
    pump(40);
    ok(A.mix.view().span < A.duration() / 2,
       `zoomed in, half the mix does not fit (${A.mix.view().span.toFixed(2)}s ` +
       `of ${A.duration().toFixed(2)}s)`);
    ok(document.getElementById('mix-scroll').style.visibility === 'visible',
       'and now the bar is there');
    ok(Math.abs(firstCardX()) < 1.5,
       'the first card is still against the left edge, which is where zero is');

    const px = A.mix.zoom();
    A.mix.setLeft(A.duration() / 3);
    pump(40);
    const to = A.mix.view().left;
    ok(to > 0, `the window moved (${to.toFixed(2)}s)`);
    ok(Math.abs(firstCardX() + to * px) < 2,
       `and the row moved with it, by the pixels those seconds are ` +
       `(${firstCardX().toFixed(1)} = -${(to * px).toFixed(1)})`);
    ok(Math.abs(A.mix.xOf(to)) < 1e-6,
       'so the moment at the left edge is at x zero, which is what a card measures from');

    // Zooming about the pointer holds the moment under it still. This is the one
    // that could never work before: the correction was a write to `scrollLeft`,
    // which this engine ignores.
    const off = 200;
    const held = A.mix.view().left + off / A.mix.zoom();
    strip.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, deltaY: -1,
        clientX: stripLeft() + off, clientY: strip.getBoundingClientRect().top + 10,
    }));
    pump(40);
    const still = A.mix.view().left + off / A.mix.zoom();
    ok(A.mix.zoom() > px * 1.2, `the wheel zoomed in (${px.toFixed(0)} → ${A.mix.zoom().toFixed(0)} px/s)`);
    ok(Math.abs(still - held) < 0.01,
       `and the moment under the pointer did not move (${held.toFixed(3)} → ${still.toFixed(3)}s)`);

    // The window cannot be pushed past the end of the mix, which is what stops a
    // strip full of nothing.
    A.mix.setLeft(A.duration() * 10);
    ok(Math.abs(A.mix.view().left + A.mix.view().span - A.duration()) < 1e-6,
       'and it stops with the end of the mix at the right-hand edge');

    A.mix.fit();
    A.mix.draw();
    pump(40);
}

// ── and it holds still while a hand is on a card ───────────────────────────
//
// A trim changes how long the mix is on every move, which moves the range the
// window may sit in and the width of the thumb that measures it. Neither is
// anything anybody can use mid-gesture and both are a picture that will not hold
// still, so both wait for the hand to come off.

console.log('\nthe window under a gesture');
{
    const thumb = document.getElementById('mix-thumb');
    const bar = () => `${thumb.style.width}|${thumb.style.left}`;

    // Zoomed to half the mix, with the window pushed as far right as it goes —
    // which is where a shortening trim would drag it back from.
    type(document.getElementById('zoom'),
         String(Math.round(Math.min(900, (document.getElementById('strip').clientWidth * 2)
                                         / A.duration()))));
    A.mix.setLeft(A.duration());
    pump(40);
    const wasLeft = A.mix.view().left, wasBar = bar(), wasTotal = A.duration();
    ok(wasLeft > 0 && wasBar.indexOf('%') > 0,
       `the window is at the end of the mix and the bar says so (${wasBar})`);

    // A trim in three events, stopping before the hand comes off.
    const edge = cardEls()[0].querySelector('.edge.r');
    const box = edge.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const by = Math.round(order()[0].length * 0.3 * A.mix.zoom());
    const at = (kind, node, cx) => node.dispatchEvent(
        new MouseEvent(kind, { bubbles: true, button: 0, clientX: cx, clientY: y }));
    at('mousedown', edge, x);
    at('mousemove', document.body, x - 8);
    at('mousemove', document.body, x - by);
    pump(20);

    ok(A.duration() < wasTotal - 0.01,
       `mid-drag the mix is shorter (${wasTotal.toFixed(2)} → ${A.duration().toFixed(2)}s)`);
    ok(A.mix.view().left === wasLeft,
       'and the window has not been pulled back from under the hand');
    ok(bar() === wasBar, 'and the bar has not moved or changed size');

    at('mouseup', document.body, x - by);
    pump(40);
    ok(bar() !== wasBar, `letting go settles the bar (${wasBar} → ${bar()})`);
    ok(A.mix.view().left <= A.duration() - A.mix.view().span + 1e-6,
       'and the window with it, back inside the mix that is left');
    ok(!packed('after a held gesture'), packed('after a held gesture') || 'still packed');

    A.mix.fit();
    A.mix.draw();
    pump(40);
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

// ── footage that is already on this disk ───────────────────────────────────
//
// A folder of video files, made into a channel of the corpus. **The assertion
// that matters is that nothing was copied**: the store holds a `state.json` and
// will hold a `words.srt`, and the recording itself stays exactly where it was.
// A corpus that duplicated tens of gigabytes to index it would be one nobody
// could afford to make, and the failure would be invisible until the disk filled.
//
// Driven through `corpus/local.js` and `supercut/acquire.js` rather than through
// the two dialogs: `showOpenFolderDialog` blocks the thread this suite runs on,
// so what is exercised here is everything both presses do after a path comes
// back — which is the whole of the mechanism.

console.log('\nfootage already here');
{
    // **Its own channel, deleted first.** The store's root is one fixed path and
    // it is somebody's real corpus, so a suite may write only under a name it
    // made up and must not leave that behind either. `sc-fixture` is not a
    // Twitch login anybody has pulled.
    const CHAN = 'sc-fixture';
    const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); }
                          catch (e) { /* never existed */ } };
    rmrf(`${ROOT}/build/corpus/${CHAN}`);

    const got = local.adopt([media], CHAN);
    ok(got.added.length === 1, `the file was adopted (${got.added.length})`);
    const id = got.added[0].id;
    ok(/^\d+$/.test(id), `and given a numeric id, which every reader of one expects (${id})`);

    // The whole point, in one line.
    ok(store.mediaOf(CHAN, id).toLowerCase() === abs(media).toLowerCase(),
       'the recording is where it always was — nothing was copied into the store');
    ok(!fs.existsSync(store.vodPaths(CHAN, id).media),
       'and there is no media.mkv in the store beside its state');

    // Not yet measured, so not yet transcribable: `isPulled` is the guard and it
    // is asked of the state rather than of the file existing, for the reason
    // `corpus/store.js` gives at length.
    ok(!store.isPulled(CHAN, id), 'a file nobody has probed yet is not ready to read');

    // The probe is a thread. Pumped rather than waited on, because a press that
    // probed a folder of fifty files would be five seconds of frozen window.
    ok(local.measuring() === 0, 'nothing is queued until something asks');
    ok(local.measure(CHAN) === 1, 'and asking queues exactly the one that needs it');
    for (let i = 0; i < 200 && local.measuring(); i++) { local.tick(); pump(20); }
    ok(!local.measuring(), 'the probe landed');
    ok(store.isPulled(CHAN, id), 'and now the recording has a length and can be read');

    const again = local.adopt([media], CHAN);
    ok(again.added.length === 0 && again.already.length === 1,
       'adopting the same file twice finds its own work rather than duplicating it');
    ok(again.already[0].id === id, 'under the id it already had, so a transcript survives');

    // A file that is not media at all. The refusal names it, which is the
    // difference between a folder that adopted eleven of twelve and one that
    // said why about the twelfth.
    const junk = `${dir}/not-a-video.zzz`;
    fs.writeFileSync(junk, 'this is not a video', 'utf-8');
    const no = local.adopt([junk], CHAN);
    ok(no.refused.length === 1 && no.refused[0].path.endsWith("not-a-video.zzz"),
       'a file no demuxer claims is refused by name rather than silently skipped');

    // What the window then shows. `open` is synchronous and touches no network,
    // which is what makes this drivable at all.
    A.acquire.open(CHAN);
    pump(40);
    ok(A.acquire.showingFolder(),
       'the tab knows this channel is a folder and not a broadcaster');
    const row = A.acquire.list().find((r) => r.id === id);
    ok(!!row && row.local, 'its row says so');
    ok(row.state === 'pulled' || row.state === 'silent',
       `and the recording is here rather than something to fetch (${row && row.state})`);
    ok(row.vod.media && row.vod.media.toLowerCase().indexOf('build/corpus/') < 0,
       'with the row pointing at the original file and not into the store');

    rmrf(`${ROOT}/build/corpus/${CHAN}`);
    try { fs.unlinkSync(junk); } catch (e) { /* fine */ }
}

// ── the checkpoint a read needs ────────────────────────────────────────────
//
// Where the speech model is looked for, and what the window does when there is
// none. **No read is started here** — none could be, on a machine with no
// checkpoint and no card — so what is checked is the resolution and the two
// faces it turns: a named directory answered as given, a wrong one refused, and
// the `Model…` press standing exactly where a `Transcribe` cannot.
//
// **Both branches of the last part run somewhere**, which is the point of
// writing it as a branch rather than a skip: a development machine has a
// checkpoint beside it and takes the first, CI has none and takes the second.
// An arrangement where one of them is never exercised anywhere is the thing
// CLAUDE.md's note about `BRO_WITH_SOUNDML=OFF` is about.

console.log('\nthe checkpoint a read needs');
{
    // Restored from the workspace before anything here moves it, because
    // `acquire.js` restores once and would otherwise do it in the middle of
    // this section and put a remembered directory back over the fixture.
    A.acquire.speech();

    const before = words.chosenSpeechModel();
    const fake = `${dir}/fixture-model`;
    const inner = `${fake}/0.6b-v9`;
    const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); }
                          catch (e) { /* never existed */ } };
    rmrf(fake);

    ok(words.speechModel('D:/nowhere/parakeet') === 'D:/nowhere/parakeet',
       'a directory somebody named is answered as given, so the native refusal ' +
       'is about their path');

    ok(words.useSpeechModel(dir) === false,
       'a directory holding no checkpoint is refused rather than remembered');
    ok(words.speechRefusal().indexOf(dir) >= 0,
       'and the refusal names it, along with everywhere else it looked');
    words.useSpeechModel('');
    ok(words.speechRefusal().split(', ').length >= 3,
       'three places are searched with nobody choosing one');

    // Two of the three files, which is what an interrupted download leaves.
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(`${inner}/config.json`, '{}', 'utf-8');
    fs.writeFileSync(`${inner}/tokenizer.json`, '{}', 'utf-8');
    ok(words.useSpeechModel(fake) === false,
       'a half-finished download is not a checkpoint on this side either');

    fs.writeFileSync(`${inner}/model.safetensors`, 'x', 'utf-8');
    ok(words.useSpeechModel(fake) === true,
       'and the whole three are, one level down from what was pointed at');
    const found = words.foundSpeechModel();
    ok(!!found && found.path === inner && found.from === 'chosen',
       `the size directory is what is read with (${found && found.path})`);

    // Where a fetched one goes: the first place the search looks, which is what
    // makes `Get model` and the search one arrangement rather than two.
    // **Nothing is downloaded here** — a suite may not pull 2.5 GB, and the
    // network half is exercised by hand against the real repository.
    ok(model.modelDir().indexOf(words.modelHome()) === 0,
       `a fetched checkpoint lands under the first place looked in (${model.modelDir()})`);
    const already = model.startModel({ dir: fake });
    ok(already.state === 'skipped',
       'and a fetch into a directory that already holds one does nothing');

    // The window's half. `Model…` is drawn only where there is nothing to read
    // with, which is the same rule the row states by carrying no `Transcribe`.
    words.useSpeechModel(before);
    A.results.setTab('recordings');
    pump(60);
    if (words.foundSpeechModel())
        ok(!document.getElementById('f-model'),
           'with a checkpoint on this machine, nothing asks for one');
    else
        ok(!!document.getElementById('f-model'),
           'with none, the press that mends every row stands beside the channel box');

    rmrf(fake);
    words.useSpeechModel(before);
}

// ── where the corpus is ────────────────────────────────────────────────────
//
// **Against the application, not against the shell.** The default manifest path
// was a bare relative string, which `require('fs')` resolves against the process
// — so a window started from anywhere but the repository root found no corpus
// and said so, over a `build/corpus` full of recordings, while `corpus/store.js`
// went on writing to the absolute one. A double-clicked application is exactly
// that case, and "run it from the repository root" is a thing only a terminal
// can be told.
//
// The assertion is portable because it is a comparison rather than a count: what
// the library says it has must be what is on the disk **at the application's own
// path**, which is true on a machine with a corpus and on one without.

console.log('\nwhere the corpus is');
{
    library.useCorpus('');       // back to the well-known one
    library.reload();
    const there = fs.existsSync(`${ROOT}/build/corpus/find.json`);
    ok(library.available() === there,
       `the default corpus is the one beside the application (${there ? 'one here' : 'none here'})`);

    // And back to the fixture, which every section after this one is about.
    A.results.useCorpus(`${dir}/find.json`);
    A.results.start();
    pump(120);
    ok(A.results.available(), 'and a named one is still read from where it was named');
}

// ── the line ───────────────────────────────────────────────────────────────
//
// A sentence typed, found in the corpus, heard, adjusted by ear, and only then
// put in the mix. **What is asserted is the order of those**: nothing reaches
// the mix until → Mix is pressed, every word resolves as it is completed, and
// the word that just landed is the one being heard — because that order is the
// whole difference between this tab and twenty searches. The words are the
// fixture's, whose transcript is not the sound, which does not matter here for
// `tests/ui_find.js`'s reason; it does mean that whatever the onset pass finds,
// it must not move a card once the line is in the mix.
//
// **The line is driven the way a hand drives it** — typed into the box, a
// block's edge dragged, the space after a word dragged — for the reason the
// four card gestures are: the gestures are the tab.

console.log('\nthe line');
{
    // Back to the one-recording corpus: the counts below are counts of takes.
    A.results.useCorpus(`${dir}/find.json`);
    A.results.start();
    pump(120);

    // A clean mix, so what is asserted about it is what the line put there.
    document.getElementById('btn-clear').dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }));
    pump(60);
    ok(A.mix.sequence().length === 0, 'the mix is empty to begin with');

    A.line.clear();
    A.results.setTab('line');
    pump(80);

    const box = document.getElementById('l-text');
    ok(!!box && !!document.getElementById('l-say') && !!document.getElementById('l-pace') &&
       !!document.getElementById('l-mix'),
       'the tab has the box, Say, the pace and → Mix');
    ok(document.activeElement === box, 'and arrives with the caret in the box');
    ok(!document.getElementById('l-tempo'), 'with no tempo, because the line is not on a beat');
    ok(document.getElementById('l-mix').disabled, '→ Mix has nothing to put in the mix yet');

    const keyIn = (node, key, more = {}) => {
        node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...more }));
        pump(40);
    };
    const press = (node, more = {}) => {
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...more }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, ...more }));
        pump(40);
    };
    const wordPieces = () => A.line.plan().pieces.filter((p) => p.kind === 'word');
    const blocks = () => document.querySelectorAll('#l-ruler .l-word');
    const settleReads = () => { for (let i = 0; i < 400 && A.line.snapping(); i++) pump(25); };

    // ── typing ─────────────────────────────────────────────────────────────
    // A word is a word when something follows it. Until then nothing has been
    // found, so the line does not flash a hole for every spelling on the way.
    type(box, 'cross');
    ok(A.line.count() === 0, 'a word still being typed is not a word yet');
    type(box, 'cross ');
    ok(A.line.count() === 1 && A.line.wordsOf()[0].phrase === 'cross', 'the space completes it');
    ok(!!wordPieces()[0].hit, 'and it is found on the keystroke');
    ok(A.ruler.auditioning() && A.ruler.selectedWord() === 0, 'and heard, and is the selected word');
    ok(A.mix.sequence().length === 0, 'and nothing is in the mix');
    ok(blocks().length === 1, 'the ruler draws it as one block');
    ok(!document.getElementById('l-mix').disabled, 'and → Mix is offered');
    A.results.hush();

    const firstId = A.line.wordsOf()[0].id;
    type(box, 'cross the ');
    ok(A.line.count() === 2 && A.line.wordsOf()[0].id === firstId,
       'the next word is a new word and the first is the same word');
    A.results.hush();
    // Retyping the line changes what changed and keeps the rest.
    A.line.setTake(0, 2);
    type(box, 'cross a ');
    ok(A.line.count() === 2 && A.line.wordsOf()[0].id === firstId && A.line.takeOf(0) === 2 &&
       A.line.wordsOf()[1].phrase === 'a',
       'a word retyped in the middle keeps the take chosen for the one before it');
    A.line.reset(0);
    A.results.hush();

    // Enter says the line, the last word included.
    box.value = 'cross the line';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    pump(30);
    ok(A.line.count() === 2, 'the word at the end of the box is still being typed');
    keyIn(box, 'Enter');
    ok(A.line.count() === 3, 'Enter makes it a word');
    ok(A.ruler.isSaying() && document.getElementById('l-say').textContent.includes('Stop'),
       'and says the line, and the button is the Stop');
    ok(document.querySelectorAll('#l-ruler .l-word.playing').length === 1, 'the word being heard lights up');
    ok(A.mix.sequence().length === 0, 'and the mix is still empty');
    A.ruler.stopSay();
    ok(!A.ruler.isSaying() && document.getElementById('l-say').textContent.includes('Say'),
       'stopping puts the button back');
    ok(document.querySelectorAll('#l-ruler .l-word.playing').length === 0, 'and nothing is lit');

    // ── the same, as a hand does it ────────────────────────────────────────
    // Pressed where the box is and typed into whatever the engine focused —
    // the path that is dead when a field is made and focused inside the press
    // that made it (see the note on `handleProgrammaticFocus` in CLAUDE.md).
    {
        document.getElementById('l-clear').click();
        pump(30);
        ok(A.line.count() === 0 && document.getElementById('l-text').value === '',
           'Clear empties the line and the box');
        const b = document.getElementById('l-text');
        const r = b.getBoundingClientRect();
        click(r.left + r.width / 2, r.top + r.height / 2);
        pump(40);
        ok(document.activeElement === b, 'a real press on the box puts the caret in it');
        textInput('cross ');
        pump(40);
        ok(b.value === 'cross ' && A.line.count() === 1,
           `what is typed reaches it and lands the word ("${b.value}")`);
        textInput('line');
        keyDown(13); keyUp(13);   // Return
        pump(60);
        ok(A.line.count() === 2 && A.ruler.isSaying(), 'Return says the line');
        A.ruler.stopSay();
        A.results.hush();
    }

    // ── what a word is ─────────────────────────────────────────────────────
    // As long as its take, then the speaker's own gap; a comma a longer rest,
    // a full stop a longer one still. `library.naturalGap` is the median gap in
    // the corpus, and this corpus is too small to have one, so it is the floor.
    A.line.say('cross, line.');
    let plan = A.line.plan();
    let pcs = wordPieces();
    ok(pcs.length === 2 && pcs.every((p) => p.hit), 'two words, both found');
    ok(plan.pieces.length === 4 && plan.pieces[1].kind === 'rest' && plan.pieces[3].kind === 'rest',
       'each followed by a rest');
    const g = library.naturalGap();
    ok(Math.abs(g - library.NATURAL_GAP) < 1e-9, `a corpus of fourteen words has no gap of its own (${g})`);
    ok(Math.abs(plan.pieces[1].seconds - Math.max(0.25, 2.5 * g)) < 1e-9 &&
       Math.abs(plan.pieces[3].seconds - Math.max(0.5, 5 * g)) < 1e-9,
       `a comma is a short rest and a full stop a long one (${plan.pieces[1].seconds}, ${plan.pieces[3].seconds})`);
    ok(pcs.every((p) => Math.abs(p.seconds - (p.until - p.from) / p.rate) < 1e-9 && p.rate === 1),
       'a word is as long as its cut, as recorded');
    ok(Math.abs(plan.seconds - plan.pieces.reduce((s, p) => s + p.seconds, 0)) < 1e-9 &&
       plan.pieces.every((p, i) => i === 0 || Math.abs(p.start - (plan.pieces[i - 1].start + plan.pieces[i - 1].seconds)) < 1e-9),
       'and the line is packed');
    ok(A.line.wordsOf()[0].stop === ',' && A.line.wordsOf()[0].phrase === 'cross',
       'the punctuation is taken off the word and kept as its rest');

    // The quiet either side of a take is read off the transcript's neighbours,
    // and it is what ranks the takes.
    const lineP = pcs[1];
    ok(Math.abs(lineP.quiet.before - 0.05) < 1e-6 && Math.abs(lineP.quiet.after - 2.9) < 1e-6,
       `a take knows the quiet either side of it (${lineP.quiet.before}, ${lineP.quiet.after})`);
    ok(pcs[0].takes === 2 && pcs[0].candidates.length === 2 &&
       pcs[0].candidates[0].score >= pcs[0].candidates[1].score &&
       pcs[0].candidates.every((c) => typeof c.clean === 'number' && c.quiet),
       'every take is ranked, cleanest first');

    // A word said twice on one line walks to another take.
    A.line.say('cross cross');
    pcs = wordPieces();
    ok(pcs.length === 2 && pcs[0].hit.at !== pcs[1].hit.at, 'the same word twice is two takes');

    // ── the pace ───────────────────────────────────────────────────────────
    // Realised as the rate within a whole tone, and as the gaps beyond it.
    A.line.say('cross, line.');
    A.line.setPace(2);
    plan = A.line.plan();
    pcs = wordPieces();
    ok(pcs.every((p) => Math.abs(p.rate - A.line.PITCH_NEAR) < 1e-9),
       `at twice the pace a word is sped up to the limit of its voice (${pcs[0].rate}×)`);
    ok(Math.abs(plan.pieces[1].seconds - Math.max(0.25, 2.5 * g) / 2) < 1e-9,
       'and the rests are halved');
    A.line.setPace(1);
    A.ruler.drawControls();
    ok(document.getElementById('l-text').value === 'cross, line.', 'the box keeps the line');

    // ── the cut points ─────────────────────────────────────────────────────
    let p0 = wordPieces()[0];
    const from0 = p0.from, until0 = p0.until;
    A.line.setHead(0, 0.05);
    p0 = wordPieces()[0];
    ok(Math.abs(p0.from - (from0 + 0.05)) < 1e-9 && Math.abs(p0.until - until0) < 1e-9,
       'the head moves where the word starts and not where it ends');
    A.line.nudge(0, -0.02);
    p0 = wordPieces()[0];
    ok(Math.abs(p0.from - (from0 + 0.03)) < 1e-9 && Math.abs(p0.until - (until0 - 0.02)) < 1e-9,
       'a nudge slides both');
    A.ruler.draw();
    ok(!!document.querySelector('#l-ruler .l-word.slipped'), 'and the block says it was moved');
    A.line.reset(0);
    p0 = wordPieces()[0];
    ok(Math.abs(p0.from - from0) < 1e-9 && Math.abs(p0.until - until0) < 1e-9, 'reset puts it back');

    // ── the gestures ───────────────────────────────────────────────────────
    A.ruler.draw();
    pump(30);
    let bl = blocks();
    ok(bl.length === 2, 'two words are two blocks');
    const secW = bl[0].getBoundingClientRect().width / wordPieces()[0].seconds;
    ok(secW > 20, `a second is wide enough to hit (${secW.toFixed(1)}px)`);

    // The right edge is where the word ends in the recording.
    drag(bl[0].querySelector('.grab'), secW * 0.1);
    ok(Math.abs(A.line.tailOf(0) - 0.1) < 0.02,
       `dragging the edge moves the end of the cut (${A.line.tailOf(0).toFixed(3)})`);
    ok(A.ruler.auditioning(), 'and the word is heard on the release');
    A.results.hush();
    A.line.setTail(0, 0);

    // The space after a word is its rest.
    A.ruler.draw();
    pump(30);
    const gapEl = document.querySelector('#l-ruler .l-gap');
    const gap0 = A.line.gapOf(0);
    drag(gapEl, secW * 0.2);
    ok(Math.abs(A.line.gapOf(0) - (gap0 + 0.2)) < 0.02,
       `dragging the space after a word lengthens its rest (${A.line.gapOf(0).toFixed(3)})`);
    A.results.hush();
    A.line.setGap(0, null);
    ok(Math.abs(A.line.gapOf(0) - gap0) < 1e-9, 'and nothing puts it back to what the comma means');

    // The top edge moves the word along the line.
    A.ruler.draw();
    pump(30);
    bl = blocks();
    const w1 = bl[1].getBoundingClientRect();
    const grip = bl[0].querySelector('.grip');
    const g0 = grip.getBoundingClientRect();
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: g0.left + 10, clientY: g0.top + 3 }));
    pump(20);
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: g0.left + 30, clientY: g0.top + 3 }));
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: w1.left + w1.width / 2, clientY: w1.top + w1.height / 2 }));
    pump(20);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: w1.left + w1.width / 2, clientY: w1.top + w1.height / 2 }));
    pump(60);
    ok(A.line.wordsOf()[0].phrase === 'line' && A.line.wordsOf()[1].phrase === 'cross',
       'dragging a word by its top edge moves it along the line');
    ok(document.getElementById('l-text').value === 'line. cross,', `and the box follows (${document.getElementById('l-text').value})`);
    A.line.moveWord(1, 0);

    // ── selecting, and a section ───────────────────────────────────────────
    A.ruler.select(-1);
    ok(!document.querySelector('#l-panel .l-piece'), 'no word selected, no panel');
    press(blocks()[0]);
    ok(A.ruler.selectedWord() === 0, 'pressing a word selects it');
    ok(!!document.querySelector('#l-panel .l-piece') && document.getElementById('l-phrase').value === 'cross',
       'and the panel is about it');
    ok(A.ruler.auditioning(), 'and it is heard');
    ok(!!document.getElementById('l-wave'), 'with its own sound drawn');
    ok(document.querySelectorAll('#l-panel .l-takebtn').length === 2 &&
       document.querySelectorAll('#l-panel .l-takebtn.on').length === 1,
       'every take of the word is a button and the one on the line is marked');
    A.results.hush();
    press(blocks()[1], { shiftKey: true });
    ok(!!A.ruler.sectionOf() && A.ruler.sectionOf().a === 0 && A.ruler.sectionOf().b === 1,
       'shift-pressing another makes a section');
    ok(!!document.querySelector('#l-panel .l-secname') && !!document.getElementById('l-match'),
       'whose panel is about the section');
    ok(document.querySelectorAll('#l-ruler .l-word.sel').length === 2, 'and both blocks are marked');
    A.results.hush();
    ok(A.ruler.selectRelative(-1) === true && A.ruler.selectedWord() === 0 && !A.ruler.sectionOf(),
       'the arrow selects one word again');
    A.results.hush();
    const take0 = wordPieces()[0].take;
    ok(A.ruler.cycleTake(1) === true && wordPieces()[0].take !== take0, '] steps the take');
    A.ruler.cycleTake(-1);
    ok(wordPieces()[0].take === take0, 'and [ steps it back');
    A.results.hush();
    ok(A.ruler.loopWord(0) === true && A.ruler.isWordLooping(), 'a word can be looped');
    A.ruler.stopWordLoop();
    ok(!A.ruler.isWordLooping(), 'until it is stopped');
    ok(A.ruler.key({ key: 'Delete' }) === true && A.line.count() === 1 && A.line.wordsOf()[0].phrase === 'line',
       'Delete takes the selected word off and leaves the other');
    ok(A.ruler.selectedWord() === -1 && !document.querySelector('#l-panel .l-piece'), 'and nothing is selected');

    // ── on a beat ──────────────────────────────────────────────────────────
    // The grid is a quantiser: ticked, every word and every rest is a whole
    // number of steps and the rows are bars; unticked, nothing is.
    A.line.say('cross, line.');
    const beat = document.getElementById('l-beat');
    beat.checked = true;
    beat.dispatchEvent(new Event('change', { bubbles: true }));
    pump(60);
    ok(A.line.onBeatOf() && !!document.getElementById('l-tempo') && !!document.getElementById('l-steps'),
       'on a beat, there is a tempo and a grid');
    type(document.getElementById('l-tempo'), '120');
    ok(Math.abs(A.line.stepSeconds() - 0.125) < 1e-9,
       `120 bpm in sixteenths is an eighth of a second (${A.line.stepSeconds()})`);
    const step = A.line.stepSeconds();
    plan = A.line.plan();
    const off = plan.pieces.map((p) => Math.abs(p.seconds / step - Math.round(p.seconds / step)))
                    .reduce((a, b) => Math.max(a, b), 0);
    ok(off < 1e-6, `every piece is a whole number of steps (worst ${off})`);
    ok(plan.pieces[1].steps >= 1 && plan.pieces[3].steps >= 2,
       'a comma is at least a step of rest and a full stop at least two');
    ok(document.querySelectorAll('#l-ruler .l-rowt')[0].querySelectorAll('.l-beat').length === A.line.stepsPerBar() - 1,
       'and the rows are bars with the beats drawn on them');
    const p0b = wordPieces()[0];
    ok(p0b.steps >= 1 && (p0b.stretched ? Math.abs(p0b.rate - 1) > 1e-9 || Math.abs((p0b.until - p0b.from) - p0b.seconds) < 1e-9
                                        : Math.abs((p0b.until - p0b.from) / p0b.rate - p0b.seconds) < 1e-9),
       `a word fills its steps by a stretch when that is small and by its cut when it is not (${p0b.stretched ? 'stretched' : 'cut'})`);
    beat.checked = false;
    beat.dispatchEvent(new Event('change', { bubbles: true }));
    pump(30);
    ok(!A.line.onBeatOf() && !document.getElementById('l-tempo'), 'unticked, the tempo goes');

    // ── → Mix ──────────────────────────────────────────────────────────────
    // The mix is the last step. Nothing above put anything in it; this does,
    // and what it puts is the line: the words as clips, and the rests as the
    // recording carried on, muted.
    ok(A.mix.sequence().length === 0, 'the mix is empty after all of that');
    A.ruler.commit();
    for (let i = 0; i < 200 && (A.line.busy() || A.mix.sequence().length < 4); i++) pump(30);
    let seq = A.mix.sequence();
    ok(seq.length === 4, `→ Mix puts four clips in the row (${seq.length})`);
    ok(seq[0].word && seq[2].word && seq[1].rest === seq[0].word && seq[3].rest === seq[2].word,
       'a word, its rest, a word, its rest — each rest tagged with the word it follows');
    ok(seq[1].muted && seq[1].path === seq[0].path && !seq[1].generator &&
       Math.abs(seq[1].inPoint - (seq[0].inPoint + seq[0].length * seq[0].speed)) < 1e-6,
       'a rest holds the shot: the same recording carried on from where the word ended, muted');
    ok(!packed('after → Mix'), packed('after → Mix') || 'and the row is packed');
    ok(A.line.isCommitted() && /4 in the mix/.test(A.line.note()), `and the line says so (${A.line.note()})`);
    ok(Math.abs(A.duration() - A.line.plan().seconds) < 1e-6,
       `the mix is as long as the line said it was (${A.duration().toFixed(3)})`);

    // **The onset pass is a slip.** It moves the footage inside a card and never
    // the card.
    const before = seq.map((c) => `${c.start}:${c.length}`).join('|');
    settleReads();
    ok(!A.line.snapping(), 'every onset read finished');
    ok(before === A.mix.sequence().map((c) => `${c.start}:${c.length}`).join('|'),
       'and not one card moved or changed length');

    // Between presses the mix is not touched; pressing again reconciles.
    const id0 = seq[0].id, idRest = seq[1].id, id2 = seq[2].id;
    A.line.setGap(0, 0.5);
    pump(60);
    ok(A.mix.sequence()[1].id === idRest && Math.abs(A.mix.sequence()[1].length - seq[1].length) < 1e-9,
       'an edit to the line leaves the mix alone');
    A.ruler.commit();
    for (let i = 0; i < 100 && A.line.busy(); i++) pump(30);
    ok(A.mix.sequence()[1].id === idRest && Math.abs(A.mix.sequence()[1].length - 0.5) < 1e-6,
       'pressed again, the rest is the same clip at its new length');
    ok(A.mix.sequence()[0].id === id0 && A.mix.sequence()[2].id === id2, 'and the words are the same clips');
    A.line.cycleTake(0, 1);
    A.ruler.commit();
    for (let i = 0; i < 100 && A.line.busy(); i++) pump(30);
    seq = A.mix.sequence();
    ok(seq.length === 4 && seq[0].id !== id0 && seq[0].word === A.line.wordsOf()[0].id,
       'another take is another clip in the same place');
    ok(!packed('after a take'), packed('after a take') || 'and the row is still packed');
    // With the hold off, a rest is black.
    A.line.setRestHold(false);
    A.ruler.commit();
    for (let i = 0; i < 100 && A.line.busy(); i++) pump(30);
    seq = A.mix.sequence();
    ok(seq.length === 4 && !!seq[1].generator && !seq[1].path && seq[1].rest,
       'with the hold off a rest is a generator clip');
    A.line.setRestHold(true);
    // A word taken off takes its clip with it, and its rest.
    A.ruler.select(1);
    A.results.hush();
    A.ruler.key({ key: 'Delete' });
    ok(A.line.count() === 1 && document.getElementById('l-text').value === 'cross,',
       `Delete takes the word out of the box too (${document.getElementById('l-text').value})`);
    A.ruler.commit();
    for (let i = 0; i < 100 && A.line.busy(); i++) pump(30);
    const held = () => A.mix.sequence().map((c) => `${c.word ? 'w' + c.word : c.rest ? 'r' + c.rest : 'hand'}${c.generator ? '(black)' : ''}`).join(' ');
    ok(A.mix.sequence().length === 2 && !A.mix.sequence().some((c) => c.id === id2),
       `a word taken off takes its clip and its rest out of the mix (${held()})`);
    // A moment added by hand keeps its place beside the block.
    A.addMoment({ path: A.mix.sequence()[0].path, name: 'by hand', from: 0.2, to: 0.8 });
    for (let i = 0; i < 200 && A.mix.sequence().length < 3; i++) pump(30);
    ok(A.mix.sequence().length === 3 && !A.mix.sequence()[2].word, 'a moment added by hand goes after the block');
    A.line.say('cross, line.');
    A.ruler.commit();
    for (let i = 0; i < 100 && A.line.busy(); i++) pump(30);
    ok(A.mix.sequence().length === 5 && !A.mix.sequence()[4].word && !A.mix.sequence()[4].rest,
       'and stays there when the line is put in again');
    A.removeClip(A.mix.sequence()[4]);
    A.mix.reflow();
    pump(60);
    settleReads();

    // A word nothing says is a hole that is named, not a refusal.
    A.line.say('cross crozz line');
    A.ruler.draw();
    ok(A.line.plan().missing.indexOf('crozz') >= 0 && document.querySelectorAll('#l-ruler .l-word.bad').length === 1,
       'a word nothing says is drawn as a hole');
    A.ruler.commit();
    for (let i = 0; i < 100 && A.line.busy(); i++) pump(30);
    ok(A.mix.sequence().filter((c) => c.word).length === 2 && /crozz/.test(A.line.note()),
       `the two it does say are in the mix and the hole is named (${A.line.note()})`);
    A.ruler.select(1);
    pump(30);
    const near = document.querySelectorAll('#l-panel .l-near button');
    ok(near.length >= 1 && near[0].textContent.startsWith('cross'),
       'and the panel offers the nearest word the corpus has');
    near[0].dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    pump(40);
    ok(A.line.wordsOf()[1].phrase === 'cross' && A.line.plan().missing.length === 0,
       'which a press puts in its place');
    A.results.hush();

    // Clear on the line clears its clips.
    A.ruler.select(-1);
    A.line.clear();
    pump(60);
    ok(A.mix.sequence().length === 0 && A.line.count() === 0, 'Clear takes the line and its clips off');

    // ── the workspace ──────────────────────────────────────────────────────
    A.line.say('cross, line.');
    const blob = JSON.parse(localStorage.getItem('supercut.line'));
    ok(Array.isArray(blob.words) && blob.words.length === 2 && blob.words[0].stop === ',' && blob.text === 'cross, line.',
       'the workspace holds the words and the text');
    localStorage.removeItem('supercut.line');
    localStorage.setItem('supercut.score', JSON.stringify({ tempo: 90, per: 4, line: 'no, no' }));
    A.line.restore();
    ok(A.line.tempoOf() === 90 && A.line.count() === 2 && A.line.wordsOf()[0].stop === ',',
       'an older workspace holding a grid and a line is read as the line');
    A.line.setTempo(120);
    A.line.clear();

    // ── a word before a pause is the pause too ─────────────────────────────
    // A transcript's word runs to the next token, so its span before a silence
    // is the silence. Such a take is cut at twice the word's typical length
    // and the rest is what it was, quiet after the word — and it is not the
    // take chosen over one said at its usual length.
    // Three seconds apart, because hits closer than that are one moment.
    const LONG = [['the', 0.0, 0.1], ['the', 3.0, 3.1], ['the', 6.0, 8.0], ['end', 8.6, 8.8]];
    fs.writeFileSync(`${dir}/long.srt`,
        LONG.map((w, i) => `${i + 1}\n${stamp(w[1])} --> ${stamp(w[2])}\n${w[0]}\n`).join('\n'), 'utf-8');
    fs.writeFileSync(`${dir}/long-chan.json`, JSON.stringify({
        channel: 'long', built: new Date().toISOString(),
        vods: [{ id: 'l1', title: 'a pause', publishedAt: '2026-01-03',
                 seconds: 60, srt: `${dir}/long.srt`, media, words: LONG.length }],
    }), 'utf-8');
    fs.writeFileSync(`${dir}/long.json`, JSON.stringify({
        channels: [{ channel: 'long', manifest: `${dir}/long-chan.json`, vods: 1, words: LONG.length, built: '' }],
    }), 'utf-8');
    A.results.useCorpus(`${dir}/long.json`);
    A.results.start();
    pump(60);
    A.line.say('the');
    {
        const p = wordPieces()[0];
        const cut = p.candidates.find((c) => Math.abs(c.hit.at - 6) < 1e-6);
        ok(!!cut && Math.abs(cut.raw - 2) < 1e-6 && Math.abs(cut.dur - 0.26) < 1e-6 && cut.quiet.after >= 1.7,
           `a span twenty times the usual is cut at the cap and the rest is quiet after it (${cut && cut.dur}, ${cut && cut.quiet.after.toFixed(2)})`);
        ok(p.said !== cut.said && Math.abs((p.until - p.from) - 0.1) < 1e-6,
           `and the take chosen is one said at its usual length (${Math.round((p.until - p.from) * 1000)} ms)`);
        ok(Math.abs(library.naturalGap() - library.NATURAL_GAP) < 1e-9,
           'a transcript whose words abut does not set the pace');
    }
    A.line.clear();

    // ── a plan is about a corpus ───────────────────────────────────────────
    A.results.useCorpus(`${dir}/nowhere.json`);
    A.line.say('cross');
    ok(A.line.plan().missing.length === 0 && !A.line.pieceOf(0).hit,
       'with no corpus open a word is unresolved rather than missing');
    A.results.useCorpus(`${dir}/find.json`);
    A.results.start();
    pump(60);
    ok(!!A.line.pieceOf(0).hit && A.line.plan().missing.length === 0,
       'and resolves once one is, with nobody asking');
    A.line.clear();

    // ── what can be typed ──────────────────────────────────────────────────
    const vocab = library.vocabulary();
    ok(vocab.length > 2 && vocab.every((e) => e.n > 0) && vocab[0].n >= vocab[vocab.length - 1].n,
       `the corpus has a vocabulary with counts, most said first (${vocab.length} words)`);
    ok(library.saidCount('cross') >= 2 && library.saidCount('zzzz') === 0,
       'a word is counted and a word nothing says counts 0');
    ok(library.suggest('cr').length >= 1 && library.suggest('cr')[0].word === 'cross',
       'the words beginning with what was typed');

    A.ruler.arrive();
    pump(30);
    const box2 = document.getElementById('l-text');
    box2.value = 'cr';
    box2.dispatchEvent(new Event('input', { bubbles: true }));
    pump(30);
    let hints = document.querySelectorAll('#f-controls .l-hint');
    ok(hints.length >= 2 && hints[0].textContent.startsWith('cr') && hints[0].textContent.endsWith('×0') &&
       hints[1].textContent.startsWith('cross') && !hints[1].textContent.endsWith('×0'),
       'typing shows what was typed and the words that begin with it, each with a count');
    keyIn(box2, 'ArrowDown');
    keyIn(box2, 'ArrowDown');
    ok(document.querySelectorAll('#f-controls .l-hint.on').length === 1 &&
       document.querySelector('#f-controls .l-hint.on').textContent.startsWith('cross'),
       'the arrows pick one');
    keyIn(box2, 'Enter');
    ok(box2.value === 'cross ' && A.line.count() === 1 && A.line.wordsOf()[0].phrase === 'cross',
       `Enter puts the one picked in the box and lands it (${box2.value})`);
    ok(document.querySelectorAll('#f-controls .l-hint').length === 0, 'and the hints are gone');
    A.results.hush();
    box2.value = 'cross crozz';
    box2.dispatchEvent(new Event('input', { bubbles: true }));
    pump(30);
    hints = document.querySelectorAll('#f-controls .l-hint');
    ok(hints.length >= 1 && hints[0].classList.contains('none'),
       'a word nothing says is marked before it is landed');
    keyIn(box2, 'Escape');
    ok(document.querySelectorAll('#f-controls .l-hint').length === 0, 'Escape drops the hints');
    A.ruler.select(-1);
    A.line.clear();
    pump(60);
    ok(A.mix.sequence().length === 0, 'and the mix is left empty');
}

// ── tracking higher energy speaking: yelling & activated speaking ──────────
console.log('\ntracking higher energy speaking');
{
    const sampleWords = [
        // Run 1: Calm speech (10 words in 5.0s, rate = 2.0/s)
        { from: 0.0, to: 0.4, text: 'hello' },
        { from: 0.5, to: 0.9, text: 'there' },
        { from: 1.0, to: 1.4, text: 'this' },
        { from: 1.5, to: 1.9, text: 'is' },
        { from: 2.0, to: 2.4, text: 'a' },
        { from: 2.5, to: 2.9, text: 'calm' },
        { from: 3.0, to: 3.4, text: 'and' },
        { from: 3.5, to: 3.9, text: 'steady' },
        { from: 4.0, to: 4.4, text: 'talking' },
        { from: 4.5, to: 5.0, text: 'pace' },

        // Hole of 4 seconds (forces new run)

        // Run 2: Activated speech (12 words in 2.4s, rate = 5.0/s)
        { from: 9.0, to: 9.15, text: 'we' },
        { from: 9.2, to: 9.35, text: 'have' },
        { from: 9.4, to: 9.55, text: 'to' },
        { from: 9.6, to: 9.75, text: 'run' },
        { from: 9.8, to: 9.95, text: 'faster' },
        { from: 10.0, to: 10.15, text: 'and' },
        { from: 10.2, to: 10.35, text: 'keep' },
        { from: 10.4, to: 10.55, text: 'moving' },
        { from: 10.6, to: 10.75, text: 'right' },
        { from: 10.8, to: 10.95, text: 'now' },
        { from: 11.0, to: 11.15, text: 'do' },
        { from: 11.2, to: 11.4, text: 'it' },

        // Hole of 4 seconds (forces new run)

        // Run 3: Yelled / High energy speech (6 words in 2.0s, rate = 3.0/s, exclamations & all-caps)
        { from: 16.0, to: 16.3, text: 'NO!' },
        { from: 16.4, to: 16.7, text: 'STOP!' },
        { from: 16.8, to: 17.1, text: 'WATCH' },
        { from: 17.2, to: 17.5, text: 'OUT!' },
        { from: 17.6, to: 17.8, text: 'GET' },
        { from: 17.9, to: 18.0, text: 'DOWN!' },
    ];

    // Longest mode: Run 1 (5.0s) wins over Run 2 (2.4s) and Run 3 (2.0s)
    const longest = phrase.monologues(sampleWords, { gap: 2, min: 1.5, mode: 'longest' });
    ok(longest.length === 3, 'three speech runs detected');
    ok(longest[0].seconds >= 4.9, `longest monologue is first (${longest[0].seconds.toFixed(1)}s)`);

    // Activated mode: Run 2 (5.0 words/s) wins over Run 3 (3.0 words/s) and Run 1 (2.0 words/s)
    const activated = phrase.monologues(sampleWords, { gap: 2, min: 1.5, mode: 'activated', minRate: 2.5 });
    ok(activated.length === 2, 'two runs beat the 2.5 words/s activated threshold');
    ok(Math.abs(activated[0].rate - 5.0) < 0.1,
       `activated mode ranks highest cadence first (${activated[0].rate.toFixed(1)}/s)`);

    // Yelling mode: Run 3 (exclamations and all-caps shouting) has highest energyScore
    const yelling = phrase.monologues(sampleWords, { gap: 2, min: 1.5, mode: 'yelling' });
    ok(yelling[0].exclamations >= 3,
       `yelling mode ranks exclamation/shouting run first (${yelling[0].exclamations}!)`);
    ok(yelling[0].energyScore > yelling[1].energyScore,
       'yelled run has higher energyScore than calm run');

    // Exclamation search in find():
    const stream = phrase.streamOf(sampleWords);
    const exclamations = phrase.find(stream, '!');
    ok(exclamations.length === 4, `find('!') matches all 4 exclamation words (${exclamations.length})`);
    ok(exclamations.some((h) => h.matched === 'STOP!'), 'matches STOP!');

    // Specific word exclamation filter: "stop!" vs "stop"
    const stopYelled = phrase.find(stream, 'stop!');
    ok(stopYelled.length === 1 && stopYelled[0].matched === 'STOP!', 'find("stop!") finds the yelled take');

    // UI integration: Results tab switching to talking and changing mode
    A.results.setTab('talking');
    pump(60);
    ok(A.results.currentTab() === 'talking', 'switched to talking tab');
    const modeSelect = document.getElementById('f-talking-mode');
    ok(modeSelect !== null, 'f-talking-mode select element exists');
    modeSelect.value = 'activated';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    pump(60);
    ok(document.getElementById('f-min-pace') !== null, 'min pace control appears in activated mode');
}

// ── a search that answers over frames ──────────────────────────────────────
//
// The corpus this application is actually pointed at is a hundred hours, and
// every call that answered on the line it was made froze the window for as long
// as it took: 11 s for the first search of a session, which is the read of the
// transcripts, and ~100 ms for every keystroke after it. What is asserted here
// is that the stepped search is *the same search* — that a reading walked to the
// end finds exactly what the one-call version finds — because a progress bar
// over a different set of answers would be worse than the freeze.

console.log('\na search that answers over frames');
{
    A.results.setTab('recordings');
    A.results.useCorpus(`${dir}/find.json`);
    library.pick('turkey');

    // Reading an `.srt` a slice at a time is what breaks up the freeze, and it
    // has to agree to the word with reading it whole.
    const srt = fs.readFileSync(`${dir}/words.srt`, 'utf-8');
    const whole = phrase.parseSrt(srt);
    const sliced = [];
    let at = 0;
    for (let n = 0; n < 500 && at < srt.length; n++) {
        const got = phrase.parseSrtFrom(srt, at, 3);
        sliced.push(...got.words);
        at = got.next;
    }
    ok(sliced.length === whole.length,
       `sliced three cues at a time reads the same count (${sliced.length})`);
    ok(sliced.every((w, i) => w.text === whole[i].text &&
                    Math.abs(w.from - whole[i].from) < 1e-9),
       'and the same words at the same times');

    /// Walk a reading to the end, pumping frames so that anything read off a
    /// worker can land. Bounded, because a reading that never finishes is the
    /// failure this is checking for.
    const settle = (r) => {
        for (let i = 0; i < 400 && !r.done; i++) { library.stepSearch(r, 8); pump(20); }
        return r;
    };

    // **An answer already given is handed back rather than walked again**, which
    // is what keeps a score — a dozen searches of one corpus, asked again on
    // every keystroke — off the corpus. Asserted as `done` on the frame it
    // begins, because the weaker "it agrees once it finishes" passed for a
    // version in which the key written and the key read were different strings.
    const once = library.searchWords('you cross');
    const stepped = library.beginSearch('words', { phrase: 'you cross' });
    ok(stepped.done, 'a reading of a phrase already answered is finished on the frame it began');
    ok(stepped.hits.length === once.length && once.length === 2,
       `and carries the same hits (${stepped.hits.length})`);
    // The other direction: what a reading finished is what the one-call search
    // then answers without walking anything.
    library.useCorpus(`${dir}/find.json`);
    library.pick('turkey');
    const walked = library.beginSearch('words', { phrase: 'crossing' });
    for (let i = 0; i < 200 && !walked.done; i++) library.stepSearch(walked, 8);
    ok(library.beginSearch('words', { phrase: 'crossing' }).done,
       'and a reading that finished is an answer the next one starts from');

    // A phrase nothing has asked before, so the walk is real.
    const fresh = library.beginSearch('words', { phrase: 'once more' });
    ok(!fresh.done, 'a reading of a new phrase has not finished on the frame it began');
    ok(library.searchProgress(fresh) < 1, 'and says so');
    settle(fresh);
    ok(fresh.done, 'stepping it finishes it');
    ok(library.searchProgress(fresh) === 1, 'and the progress is then whole');
    ok(fresh.hits.length === library.searchWords('once more').length && fresh.hits.length === 1,
       `and it finds exactly what the one-call search finds (${fresh.hits.length})`);

    // Abandoning one is safe and is what a keystroke does to the search before
    // it. What must not happen is a cancelled reading going on reading.
    const dropped = library.beginSearch('talking', { gap: 2, min: 5 });
    library.cancelSearch(dropped);
    ok(dropped.done, 'a cancelled reading is finished, whatever it had left');

    // The acoustic half needs something the energy modes will actually list, and
    // the corpus above is a calm one on purpose — so this is a second fixture of
    // its own rather than exclamation marks bolted onto the words every
    // assertion above counts.
    const YELLED = [
        ['what', 0.0, 0.3], ['are', 0.4, 0.6], ['you', 0.7, 0.9],
        ['DOING!', 1.0, 1.5], ['stop!', 1.6, 2.0], ['right', 2.1, 2.4],
        ['NOW!', 2.5, 3.0], ['i', 3.1, 3.3], ['cannot', 3.4, 3.8],
        ['believe', 3.9, 4.4], ['this', 4.5, 4.8], ['happened', 4.9, 5.6],
    ];
    fs.writeFileSync(`${dir}/yelled.srt`,
        YELLED.map((w, i) => `${i + 1}\n${stamp(w[1])} --> ${stamp(w[2])}\n${w[0]}\n`).join('\n'),
        'utf-8');
    fs.writeFileSync(`${dir}/yelled-chan.json`, JSON.stringify({
        channel: 'yelled', built: new Date().toISOString(),
        vods: [{ id: 'y1', title: 'a loud fixture', publishedAt: '2026-01-02',
                 seconds: 60, srt: `${dir}/yelled.srt`, media, words: YELLED.length }],
    }), 'utf-8');
    fs.writeFileSync(`${dir}/yelled.json`, JSON.stringify({
        channels: [{ channel: 'yelled', manifest: `${dir}/yelled-chan.json`,
                     vods: 1, words: YELLED.length, built: '' }],
    }), 'utf-8');
    library.useCorpus(`${dir}/yelled.json`);
    library.pick('yelled');

    // **A stretch that was listened to carries a number and one that was not
    // carries null**, which is the distinction the ranking is built on — an
    // unread span is not a silent one. Skipped where there is no worker to read
    // with, which is a real configuration and not a failure.
    const loud = library.beginSearch('talking', { gap: 2, min: 5, mode: 'yelling' });
    settle(loud);
    ok(loud.done, 'an energy search finishes');
    ok(loud.hits.length >= 1, `and finds the stretch of talking (${loud.hits.length})`);
    if (typeof Worker === 'function') {
        ok(loud.hits[0].peakRms !== null,
           `the top stretch was listened to (rms ${loud.hits[0].peakRms})`);
        ok(loud.heard === loud.hearing && loud.hearing >= 1,
           `every span it meant to hear was heard (${loud.heard} of ${loud.hearing})`);
    } else {
        ok(loud.hits[0].peakRms === null,
           'with no worker nothing is listened to, and the words still rank it');
    }

    // Reading the corpus while nothing is being asked of it, which is what keeps
    // the calls that cannot be readings — a score resolving — off the 8.9 s.
    library.useCorpus(`${dir}/find.json`);
    library.pick('turkey');
    ok(library.warmSome(8) === true, 'there is a corpus to read before anything asks');
    for (let i = 0; i < 200 && library.warmSome(8); i++) { /* read it */ }
    ok(library.warmSome(8) === false, 'and once it is read there is nothing left to do');
}

console.log(`\n${checks} checks passed`);
