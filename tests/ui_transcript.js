// Finding a word in six hours of talking, driven the way a person drives it.
//
// The seams this is about, in the order they can fail:
//
//   - **an absent model is refused by name.** The weights are 3 GB and are not
//     shipped, so the ordinary state of a fresh checkout is that there is no
//     model. What must never happen is a press that appears to work and quietly
//     produces nothing. The missing file is named, and a file with no soundtrack
//     at all is a *different* refusal — the same distinction `ui_marks.js`
//     draws between a silent recording and one with no sound track in it.
//   - **the read is off the UI thread, and arrives while it runs.** This is the
//     one that separates a transcript from every other read on that surface. A
//     poll answers with the words so far, `read` says how far down the recording
//     it has got, and the application keeps drawing throughout — checked by
//     drawing during it rather than by trusting the word "thread".
//   - **the times are absolute.** Whisper's own timestamps restart at zero
//     every 30 s window; a segment two minutes into a recording must say two
//     minutes. Asserted by transcribing a file built out of one clip repeated,
//     where every repetition's position is known in advance.
//   - **a search says how much it searched.** A search over ten minutes of a
//     six-hour recording that finds nothing, and a search over all six hours
//     that finds nothing, are different answers. `coverage()` is what makes the
//     count honest, and a caller that showed the count alone would be lying.
//
// And the rule the whole thing is judged by, the same shape as `ui_marks.js`'s:
// **a transcript is a search hint and never the cut.** The audio-only and video
// renditions of a VOD do not share a zero, so a hit moves the playhead and a
// human agrees. Nothing in this module trims anything, and that is asserted.
//
// The model is the one fixture that cannot be generated — there is no way to
// synthesise speech a recogniser will read back — so every section that needs
// one is **skipped rather than failed** when it is absent, which is this
// repository's rule for every suite.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_transcript.js -- [<model-dir>] [<silent.mp4>]

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const modelArg = args[0];
const noSound = args[1];

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const el = (id) => document.getElementById(id);
const type = (node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
};
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

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

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const fs = require('fs');

/// A model directory, or '' when there is none to be had. Taken from the
/// argument when given, and otherwise looked for beside brosoundml — where its
/// own download script puts one — so that a developer who has run that script
/// gets the real sections without passing anything.
/// **The smallest model wins, and that is deliberate.** What this suite is about
/// is the seam — does a read arrive progressively, are the times absolute, does
/// a search say how much it searched — and none of that is a question about how
/// good the recogniser is. whisper-tiny answers all of it and transcribes the
/// clean clip that ships beside it correctly; large-v3 answers it identically
/// and is forty times the compute, which on a build without a GPU is the
/// difference between two minutes and most of an hour. A suite that quietly
/// picked the big one would be a suite that times out on an ordinary checkout.
function findModel() {
    const tried = [];
    if (modelArg) tried.push(modelArg);
    tried.push('D:/projects/brosoundml/weights/whisper');
    tried.push('../brosoundml/weights/whisper');
    tried.push('D:/projects/brosoundml/weights/whisper-large-v3');
    for (const dir of tried) {
        try {
            if (fs.existsSync(dir + '/config.json') &&
                fs.existsSync(dir + '/model.safetensors')) return dir;
        } catch (e) { /* not there */ }
    }
    return '';
}
const model = findModel();

// ── the surface ────────────────────────────────────────────────────────────

console.log('\nthe call is there and says what it needs');
{
    ok(bro.ffmpeg.transcribe && bro.ffmpeg.transcribe.reads,
       'bro.ffmpeg.transcribe.reads exists');
    for (const fn of ['start', 'poll', 'cancel', 'forget'])
        ok(typeof bro.ffmpeg.transcribe.reads[fn] === 'function',
           `reads.${fn} is a function`);

    // There is deliberately no `available()`. The question a caller has is not
    // "was this binary built with speech" — it always was — but "is there a
    // model on this disk", which is a property of a path and is answered by the
    // read. `bro.ffmpeg.marks` dropped its own `available()` for the same
    // reason: a call whose answer cannot vary teaches nobody anything.
    ok(bro.ffmpeg.transcribe.available === undefined,
       'no available(): the question is about a path, not about the build');

    // A start with no model named is a programming mistake rather than a
    // missing file, so it throws at the call instead of failing on the thread.
    let threw = '';
    try { bro.ffmpeg.transcribe.reads.start('x.wav', {}); }
    catch (e) { threw = String((e && e.message) || e); }
    ok(threw.includes('opts.model'), 'a start with no model names opts.model');
    ok(threw.includes('download-whisper'),
       'and says where a model comes from, rather than only that one is needed');
}

console.log('\na model that is not there is refused by name');
{
    const id = bro.ffmpeg.transcribe.reads.start('anything.wav',
                                                 { model: 'Z:/no/such/whisper' });
    ok(id > 0, 'the read starts — the refusal is the answer, not the call');
    let p = null;
    waitFor('the refusal', () => {
        p = bro.ffmpeg.transcribe.reads.poll(id);
        return p && !p.reading;
    });
    same(p.state, 'failed', 'it fails');
    ok(p.error.includes('Z:/no/such/whisper/config.json'),
       'and names the file that is missing, not just "could not load"');
    ok(p.error.includes('download-whisper'), 'and says how to get one');
    bro.ffmpeg.transcribe.reads.forget(id);
}

if (noSound && model) {
    console.log('\na file with no soundtrack is a different refusal');
    const id = bro.ffmpeg.transcribe.reads.start(noSound, { model });
    let p = null;
    waitFor('the refusal', () => {
        p = bro.ffmpeg.transcribe.reads.poll(id);
        return p && !p.reading;
    }, 120000);
    same(p.state, 'failed', 'it fails');
    ok(/no sound/i.test(p.error),
       'and says there is no sound, which is not the same as saying nothing was said');
    ok(!p.error.includes('config.json'),
       'and does not blame the model for the file');
    bro.ffmpeg.transcribe.reads.forget(id);
} else {
    console.log('\nskipping the no-soundtrack refusal (no silent fixture or no model)');
}

// ── the model half ─────────────────────────────────────────────────────────

if (!model) {
    console.log('\nskipping every section that needs a model — none on this disk');
    console.log(`  (looked beside brosoundml; pass one: ... tests/ui_transcript.js -- <dir>)`);
    console.log(`\n${checks} checks passed`);
} else {

console.log(`\nusing the model at ${model}`);

/// A speech file of a known shape: one clip repeated, so every repetition's
/// position is known in advance and "the times are absolute" is checkable
/// against arithmetic rather than against whatever the recogniser felt like.
/// Written next to the generated fixtures, and skipped if the source clip that
/// ships with the weights is not there.
function buildSpeech(reps) {
    // Beside the chosen model first, then beside any of the others: the clip
    // ships with brosoundml's own download of whisper-tiny and a checkout that
    // went straight to large-v3 has the weights without it.
    let src = '';
    for (const dir of [model,
                       'D:/projects/brosoundml/weights/whisper',
                       '../brosoundml/weights/whisper']) {
        try {
            if (fs.existsSync(dir + '/test_audio_en.wav')) {
                src = dir + '/test_audio_en.wav';
                break;
            }
        } catch (e) { /* not there */ }
    }
    if (!src) return null;
    const buf = new Uint8Array(fs.readFileSync(src));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 12, data = -1, len = 0;
    while (pos + 8 <= buf.length) {
        const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
        const sz = dv.getUint32(pos + 4, true);
        if (id === 'data') { data = pos + 8; len = sz; break; }
        pos += 8 + sz + (sz & 1);
    }
    if (data < 0) return null;
    const total = len * reps;
    const wav = new Uint8Array(44 + total);
    const wv = new DataView(wav.buffer);
    const tag = (at, s) => { for (let i = 0; i < 4; i++) wav[at + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); wv.setUint32(4, 36 + total, true); tag(8, 'WAVE');
    tag(12, 'fmt '); wv.setUint32(16, 16, true); wv.setUint16(20, 1, true);
    wv.setUint16(22, 1, true); wv.setUint32(24, 16000, true);
    wv.setUint32(28, 32000, true); wv.setUint16(32, 2, true); wv.setUint16(34, 16, true);
    tag(36, 'data'); wv.setUint32(40, total, true);
    for (let i = 0; i < reps; i++) wav.set(buf.subarray(data, data + len), 44 + i * len);
    // Absolute, because the two sides resolve a relative path differently:
    // `fs` here is rooted at `ui/` (the app directory the engine was given) and
    // the native read is rooted at the process's own working directory. One
    // spelling that means the same file to both is the only way not to trip
    // over that.
    const out = fs.realpathSync('..').split('\\').join('/') +
                '/build/fixtures/speech-repeated.wav';
    fs.writeFileSync(out, wav);
    return { path: out, clip: len / 32000, seconds: total / 32000 };
}

const speech = buildSpeech(6);
if (!speech) {
    console.log('  (the weights carry no test_audio_en.wav — skipping the read)');
} else {

console.log(`\na long read arrives while it runs (${speech.seconds.toFixed(0)} s)`);
let done = null;
{
    const id = bro.ffmpeg.transcribe.reads.start(speech.path,
                                                 { model, language: 'en' });
    ok(id > 0, 'it starts');

    // Drawn *during* the read, which is the assertion: a frozen window would
    // fail this by never getting here rather than by reporting anything.
    let partials = 0, sawGrowth = 0, drew = 0;
    let p = null;
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
        pump(100);
        drew++;
        p = bro.ffmpeg.transcribe.reads.poll(id);
        if (!p) break;
        if (p.reading && p.result.segments.length > sawGrowth) {
            sawGrowth = p.result.segments.length;
            partials++;
        }
        if (!p.reading) break;
    }
    ok(drew > 5, `the window kept drawing while it read (${drew} frames)`);
    same(p.state, 'done', 'it finishes');
    same(p.error, '', 'with nothing to report');
    ok(partials > 1,
       `the words arrived while it was still reading (${partials} updates), ` +
       'which is the whole difference from every other read on this surface');

    done = p.result;
    bro.ffmpeg.transcribe.reads.forget(id);
}

console.log('\nthe times are absolute, not per window');
{
    ok(done.segments.length >= 4, `it found segments (${done.segments.length})`);
    // Whisper restarts its own timestamps at zero every 30 s window. If that
    // ever leaks through, a recording's segments sawtooth instead of walking
    // forward — which is the failure that makes a hit unjumpable.
    let back = 0;
    for (let i = 1; i < done.segments.length; i++)
        if (done.segments[i].start < done.segments[i - 1].start - 0.001) back++;
    same(back, 0, 'no segment starts before the one in front of it');

    const last = done.segments[done.segments.length - 1];
    ok(last.end > speech.seconds * 0.8,
       `the last segment is near the end (${last.end.toFixed(1)} s of ` +
       `${speech.seconds.toFixed(0)} s), not stuck inside the first window`);
    ok(last.end <= done.duration + 0.001,
       'and nothing claims time the recording does not have');

    // The file is one clip repeated, so a segment should begin near a multiple
    // of the clip's length. Loose, because the recogniser decides where a
    // phrase ends; the point is that they are spread across the recording
    // rather than clustered in its first thirty seconds.
    const late = done.segments.filter((s) => s.start > 30).length;
    ok(late >= 2, `segments were found past the first window (${late} of them)`);

    same(done.read.toFixed(1), done.duration.toFixed(1),
         'a finished read says it read all of it');
}

console.log('\nfinding a word, and saying how much was looked at');
{
    // Driven through the model rather than through the native call, because
    // what is being checked is the search — folding, the sort and the coverage.
    A.transcript.useModel(model);
    same(A.transcript.modelPath(), model, 'the model is remembered');

    const before = A.transcript.search('country');
    same(before.length, 0, 'nothing is found before anything has been read');
    const cov0 = A.transcript.coverage();
    same(cov0.duration, 0, 'and nothing has been read');

    // A real input, added the way a person adds one. A hand-made object would
    // be dropped on the next frame and the reason is worth knowing: `retain()`
    // forgets every transcript whose input is no longer in the model, which is
    // exactly what must happen when a file is removed while it is being read.
    A.shell.goTo('sources');
    pump(60);
    type(el('src-path'), speech.path);
    click(el('src-add'));
    waitFor('the file to open', () => {
        const i = A.inputs.inputs.find((x) => x.path === speech.path);
        return i && i.probe;
    });
    input = A.inputs.inputs.find((x) => x.path === speech.path);
    ok(!!input, 'the speech file is open');
    ok(A.transcript.worthReading(input),
       'and is offered a transcription, because it has a soundtrack');

    const entry = A.transcript.transcribe(input);
    ok(entry && entry.state === 'reading', 'the press starts a read straight away');
    waitFor('the transcript', () => {
        const e = A.transcript.readOf(input.id);
        return e && e.state !== 'reading';
    }, 600000);
    same(A.transcript.readOf(input.id).state, 'done', 'and it finishes');

    const hits = A.transcript.search('country');
    ok(hits.length >= 2, `the phrase is found where it was said (${hits.length})`);
    ok(hits.every((h) => h.inputId === input.id), 'every hit names its input');
    let outOfOrder = 0;
    for (let i = 1; i < hits.length; i++)
        if (hits[i].start < hits[i - 1].start) outOfOrder++;
    same(outOfOrder, 0, 'hits come back in time order');

    // Case and the punctuation a transcript attaches to a word, but NOT the
    // spaces — collapsing those would make a phrase search match across a word
    // boundary, and a phrase search is the main thing this is for.
    same(A.transcript.search('COUNTRY').length, hits.length, 'case does not matter');
    same(A.transcript.search('country,').length, hits.length,
         'nor does punctuation somebody typed');
    same(A.transcript.search('yourcountry').length, 0,
         'but a space is a space: "yourcountry" is not "your country"');

    const cov = A.transcript.coverage();
    ok(cov.read > 0 && cov.duration > 0, 'coverage says what was searched');
    same(cov.read.toFixed(1), cov.duration.toFixed(1),
         'and after a finished read that is all of it');

    // The line the whole feature turns on. A hit is a place to look: it carries
    // a time and the sentence it was in, and nothing that would let a caller
    // treat it as an edit. The two renditions of a VOD do not share a zero, so
    // a cut placed on a word boundary would be placed on the wrong clock.
    const h = hits[0];
    same(Object.keys(h).sort().join(','), 'at,end,inputId,start,text',
         'a hit is a place and a sentence — no in point, no out point, no clip');
    ok(typeof A.transcript.hitRows === 'function',
       'reaching the timeline is a separate step, through the clips');
    same(A.transcript.hitRows(h, []).length, 0,
         'and a hit with no clip covering it lands nowhere, rather than making one');

}

console.log('\na window is what a hit becomes, and the pad is the two clocks');
{
    // The pad is a *measurement*, not a comfort margin: the transcript is read
    // from the soundtrack rendition and the picture rendition does not share its
    // zero — up to 2.57 s apart on one recording. A pad at or under that would
    // sometimes produce a window that does not contain the words it was cut for,
    // which is the one failure mode this number exists to prevent.
    ok(A.transcript.WINDOW_PAD > 2.57,
       `the pad clears the largest measured clock offset (${A.transcript.WINDOW_PAD}s > 2.57s)`);

    const mid = { start: 100, end: 104 };
    const w = A.transcript.windowFor(mid, 600);
    same(w.from, 100 - A.transcript.WINDOW_PAD, 'a window opens a pad before the words');
    same(w.to, 104 + A.transcript.WINDOW_PAD, 'and closes a pad after them');

    // Both ends clamp to the recording, because a hit in the first ten seconds
    // is the ordinary case and a negative -ss is not a thing.
    const head = A.transcript.windowFor({ start: 1, end: 2 }, 600);
    same(head.from, 0, 'a window at the start does not open before the file does');
    const tail = A.transcript.windowFor({ start: 595, end: 599 }, 600);
    same(tail.to, 600, 'and one at the end does not run past it');
    ok(tail.to > tail.from, 'a window is never empty');

    // A recording that says nothing about its length still gives a window —
    // the clamp is skipped rather than the window refused, because "this file
    // has no duration" is not a reason to be unable to cut twenty seconds of it.
    const unknown = A.transcript.windowFor(mid, 0);
    same(unknown.to, 104 + A.transcript.WINDOW_PAD,
         'a file with no declared duration still yields a window');
}

console.log('\nwhat the card says about the read, and where the search now is');
{
    // **The search is not here any more, and this is the assertion that keeps
    // it that way.** A field, a coverage sentence and twelve hit rows used to
    // hang off this card, three levels deep inside the probe readout, each hit
    // offering a jump, a window pull and a press that opened the window as an
    // input. All of it was worth having and none of it was a description of an
    // input: it is the Find stage's question asked one file at a time. See
    // `wordsRows` in ui/sources.js and `searchFor` in ui/find.js.
    A.shell.goTo('sources');
    pump(60);
    same(document.querySelector('.src-find'), null,
         'no search field on an input card — a search is the Find stage\u2019s question');
    same(document.querySelector('.src-hit'), null, 'and no hit list under a stream');

    // The row that replaced them. Gathered from the rows themselves rather than
    // from a container's textContent: this DOM is bro's subset and aggregating
    // text up a tree is not something to assume of it.
    const readRows = () => Array.from(document.querySelectorAll('.src-read'))
                                .map((n) => n.textContent || '');
    const words = readRows().find((t) => t.indexOf('Words') >= 0);
    ok(!!words, 'the transcript has a row in the Reading it section');
    ok(/\d+ segments?/.test(words), `saying what it found (${words.trim()})`);
    ok(/all of it|only the first/.test(words),
       'and how much of the recording it read — a count without its coverage is ' +
       'the one dishonest way to show this');

    // Which soundtrack it actually read. The old rows were drawn under the
    // *first* audio line and said nothing, which asserted by position an answer
    // no reader gives: both ask libav for `av_find_best_stream` and both report
    // the index they were handed. See `soundStream` in ui/sources.js.
    ok(/A\d|best of \d/.test(words), 'and which stream it read');

    // Which model. A statement rather than a field, and the path is on the
    // tooltip: it is the same value for every input in the list, because the
    // weights are a property of the machine.
    ok(!!document.querySelector('[data-f="srcmodelpick"]'),
       'a picker for the weights — a directory is not a thing to spell by hand');
    same(document.querySelector('.src-model'), null,
         'and no per-input path field, which drew the same machine-wide value once ' +
         'per card and split the stream list in half doing it');
}

console.log('\nthe door to the search arrives with the rule already wired');
{
    // A door rather than a corridor. Walking somebody to an empty canvas and
    // asking them to place a Recording, a Said and a Stack and wire the three
    // together is four presses to get back to what one field did — which is
    // exactly the reason `strip()` exists on that stage.
    const before = A.find.findGraph().nodes.length;
    const door = document.querySelector('[data-f="srcsearchwords"]');
    ok(!!door, 'a finished transcript offers the search');
    click(door);
    pump(60);

    const g = A.find.findGraph();
    ok(g.nodes.length > before, `it placed the rule (${g.nodes.length - before} nodes)`);
    const said = g.nodes.filter((n) => n.kind === 'said');
    same(said.length, 1, 'one Said');
    const src = g.producers(said[0])[0];
    ok(!!src && src.kind === 'source', 'wired to a Recording');
    same(src.params.inputId, input.id, 'which names the recording the press was on');
    ok(g.consumers(said[0]).some((n) => n.kind === 'stack'),
       'and ending in a Stack, because a Said with nowhere to go finds candidates ' +
       'no press can turn into clips');

    // The phrase is the only thing left to do, and it finds what the model's own
    // search finds — one rule reading one recording, not every transcript there
    // is. `searchIn` is the seam; see ui/find/nodes.js.
    g.setParam(said[0], 'phrase', 'country');
    pump(20);
    const stacks = A.find.stacks();
    ok(stacks.length >= 1, 'the stack exists');
    const found = stacks[0].list;
    ok(found.length >= 2, `and holds a candidate per place it was said (${found.length})`);
    ok(found.every((c) => c.inputId === input.id),
       'every one of them off the recording that was wired in');

    // A candidate is a *span* where a hit was a place, and the pad is the two
    // clocks — the same measurement, applied once. `pullSpan` is what stops it
    // being applied twice; see ui/transcript.js.
    ok(found.every((c) => c.out > c.in), 'a candidate is a span, not a moment');
    ok(found.every((c) => c.at >= c.in && c.at <= c.out),
       'with the words inside it, which is what `at` is for');

    // And the panel the door opened onto lists them, each with the one press
    // worth having on a single candidate: go and look at it. That was the hit
    // row's timestamp button on the Sources card, and it is the same restraint
    // — the playhead moves and nothing is cut, because the two renditions of a
    // stream do not share a zero.
    A.drawFind();
    pump(60);
    const cands = Array.from(document.querySelectorAll('#fn-panel .fn-cand'));
    ok(cands.length > 0, `the rule's panel lists what it found (${cands.length})`);
    ok(cands.every((r) => !!r.querySelector('button')),
       'and every row carries the press that goes to that moment');

    // Pressing it again is the same rule, not a second copy of it: the canvas
    // would otherwise grow a chain per press.
    const n = g.nodes.length;
    A.shell.goTo('sources');
    pump(40);
    click(document.querySelector('[data-f="srcsearchwords"]'));
    pump(40);
    same(A.find.findGraph().nodes.length, n,
         'a second press opens the rule it already made rather than making another');
    same(A.find.findGraph().nodes.find((x) => x.kind === 'said').params.phrase, 'country',
         'with the phrase still in it');
}

console.log('\nforgetting it takes the words and the search with them');
{
    // Through the button rather than the model, because that is the only path a
    // person has and it is the one that redraws: this stage is drawn directly
    // rather than off the change channel (see needs()/drawPending() in
    // ui/app.js), so a model call alone leaves the rows it wrote standing.
    A.shell.goTo('sources');
    pump(60);
    const forget = Array.from(document.querySelectorAll('button'))
                        .find((b) => (b.title || '') === 'Drop this transcript.');
    ok(!!forget, 'a finished transcript offers to be forgotten');
    click(forget);
    pump(60);
    same(A.transcript.readOf(input.id), null, 'the press forgets it');
    same(A.transcript.search('country').length, 0, 'and it stops being searchable');
    same(document.querySelector('[data-f="srcsearchwords"]'), null,
         'along with the door to the search, which has nothing left to search');

    // And the rule on the Find stage survives it, saying which press is missing.
    // A rule is *authored* and a transcript is derived — the exact inversion
    // ui/find/model.js is built on — so forgetting the read must not delete the
    // work of wiring it up.
    const g = A.find.findGraph();
    ok(g.nodes.some((x) => x.kind === 'said'),
       'the rule outlives the read it was reading — a rule is authored, a ' +
       'transcript is derived');
    same(A.find.stacks()[0].list.length, 0, 'and finds nothing now');
}

console.log('\nthe model is a machine-wide choice, stated rather than typed per input');
{
    // The weights are not shipped, so choosing them is the first thing anybody
    // does with this feature and it was the first thing to go wrong: a bare
    // text field, committed on `change` — which the engine did not fire for a
    // text control at all — so a path was typed, the button beside it was
    // pressed, and the read failed saying no model had been chosen. The engine
    // is where that was fixed (bro, layout/value_change.h).
    //
    // What is left of it here is the *picker*, and that is the point. The field
    // was drawn once per input while holding one value for all of them, because
    // the weights are a property of the machine — remembered in localStorage
    // for exactly that reason. What somebody needs on a card is which model
    // will run, which the row states in a word.
    A.shell.goTo('sources');
    pump(60);
    ok(!!document.querySelector('[data-f="srcmodelpick"]'),
       'the weights are chosen through a picker');

    A.transcript.useModel('D:/weights/left-behind');
    A.drawSources();
    pump(20);
    const named = Array.from(document.querySelectorAll('.src-read'))
                       .map((n) => n.textContent || '')
                       .find((t) => t.indexOf('left-behind') >= 0);
    ok(!!named, 'and the card names the one that is chosen, by its directory');

    // Remembered, because the weights are a property of this machine and
    // finding them again on every launch is the friction the picker exists to
    // remove. Read back through the store rather than the module's own memory.
    const saved = JSON.parse(localStorage.getItem('ffmpeg-bro.transcript') || '{}');
    same(saved.model, 'D:/weights/left-behind', 'and written down for the next run');

    A.transcript.useModel(model);      // put the real one back for what follows
    A.drawSources();
    pump(20);
}

}  // speech
}  // model

console.log(`\n${checks} checks passed`);
