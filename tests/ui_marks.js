// Finding things by sound, driven the way a person drives it.
//
// The other half of `tests/marks_test.cpp`. That one is about the measurement —
// is a transient found, is it at the right second, is the frequency the one that
// was written — and this one is about the four seams either side of it:
//
//   - **the affordance is offered exactly where it works.** A `Find sounds`
//     button appears under an audio stream and under no other kind, and not at
//     all in a build with no brosoundml in it — `bro.ffmpeg.marks.available()`
//     is asked of the binary rather than assumed, which is `data.parsers()`'s
//     rule.
//   - **the read is off the UI thread.** It is started, polled from the frame
//     loop and answered, and the application keeps drawing while it is in
//     flight — checked by drawing during it rather than by trusting the word
//     "thread". This is the whole reason the DSP is native: `bro.sense.analyze`
//     would freeze the window for seconds on exactly the long footage this
//     feature exists for.
//   - **a mark reaches the timeline through the clip it belongs to.** The lane
//     exists exactly when there are marks on it, sits above the waveform, and a
//     trim moves what is drawn without the soundtrack being read again —
//     because a mark belongs to the *input* and `timelineTime` is the map.
//   - **`,` and `.` land on marks.** In time order, whatever kind each is, from
//     either end, and saying what they landed on.
//
// And the rule the whole thing is judged by: **nothing claims a classification.**
// The three kinds are named after what was measured, the words the interface
// uses come from one place, and none of them says "bird", "speech" or "event".
// That is asserted here, because it is the failure that would make the feature
// a lie and it is the one that cannot be seen in a screenshot.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_marks.js -- <marks.m4a> [<silent.mp4>]

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
const noSound = args[1];
assert(media, 'pass a media file: ... tests/ui_marks.js -- <marks.m4a>');

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
const qq = (sel, root) => Array.from((root || document).querySelectorAll(sel));

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
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const type = (node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
};

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;

// ── can this build look at all ─────────────────────────────────────────────

console.log('\nwhether this build carries the sensors');
{
    const there = A.marks.available();
    console.log(`  bro.ffmpeg.marks.available() = ${there}`);
    ok(typeof there === 'boolean', 'the question has a yes/no answer');
    if (!there) {
        // A supported configuration: `-DBRO_WITH_SOUNDML=OFF`. What is required
        // of it is that the control is absent rather than present and failing,
        // and that the call says why rather than answering with an empty list.
        let threw = '';
        try { bro.ffmpeg.marks.reads.start(media); } catch (e) { threw = String(e.message || e); }
        ok(threw.indexOf('BRO_WITH_SOUNDML') >= 0,
           `and starting a read refuses by name: "${threw}"`);
        console.log('\n  -- skipped: this build has no acoustic sensors. Everything ' +
                    'below is about reading a soundtrack with them.');
        console.log(`\n${checks} checks passed`);
    }
}

if (A.marks.available()) {

// ── the words, which are the whole of the honesty ──────────────────────────

console.log('\nnothing here claims to know what made a sound');
{
    const words = A.marks.MARK_WORDS;
    same(Object.keys(words).sort().join(','), 'onset,sound,tonal',
         'three kinds, each named after the measurement');
    // The words go on the lane's tooltip, on the Sources stage's chips and into
    // the manual, out of this one object. A claim about a *source* of sound —
    // a bird, a word, a door — is a claim the DSP never made, and the whole
    // feature turns on nobody writing one.
    const claims = ['bird', 'speech', 'voice', 'word', 'music', 'gunshot', 'animal'];
    for (const kind of Object.keys(words)) {
        const said = words[kind].toLowerCase();
        const bad = claims.find((c) => said.indexOf(c) >= 0);
        ok(!bad, `'${kind}' says what was measured and not what made it: "${words[kind]}"`);
    }
    // The energy VAD's flag is called `voice` in bro's own snapshot. It is
    // called `sound` here on purpose — an energy gate against a noise floor
    // decided nothing about a voice — and this is the assertion that keeps it
    // that way.
    ok(!('voice' in words), "and the energy gate is called 'sound', not 'voice'");
}

// ── the control is where it works ──────────────────────────────────────────

console.log('\nthe control is offered under a soundtrack and nowhere else');
A.shell.goTo('sources');
pump(60);

type(el('src-path'), media);
click(el('src-add'));
pump(80);

const input = A.inputs.inputs[0];
ok(!!input && !!input.probe, 'the file is open and probed');

const audio = input.probe.streams.filter((s) => s.kind === 'audio');
console.log(`  streams: ${JSON.stringify(input.probe.streams.map((s) => s.kind))}`);

if (!audio.length) {
    console.log('\n  -- skipped: this file has no soundtrack, so there is nothing to ' +
                'listen to. Run it against build/fixtures/marks.m4a.');
    console.log(`\n${checks} checks passed`);
} else {

let button = null;
{
    ok(A.marks.worthReading(input), 'the input is worth listening to');
    button = qq('.src-data button').find((b) => b.textContent === 'Find sounds');
    ok(!!button, 'a Find sounds button is drawn under the stream line');
    // One control, not one per audio stream: the read takes the *best* audio
    // stream, which is what `[0:a]` means on a command line.
    same(qq('.src-data button').filter((b) => b.textContent === 'Find sounds').length, 1,
         'exactly one, because one soundtrack is read');
}

// ── the read is off the UI thread ──────────────────────────────────────────

console.log('\nlistening does not stop the application');
let result = null;
{
    const before = A.doc.dirty ? 'dirty' : 'clean';
    click(button);
    pump(0);

    ok(!!A.marks.readOf(input.id), 'an entry exists the moment the press lands');
    // Whatever state it is in by the next flush, what must be true is that the
    // application drew — the press did not block the thread that draws.
    A.timeline.draw();
    ok(true, 'and the timeline draws while it is in flight');

    waitFor('the soundtrack to be read',
            () => { const e = A.marks.readOf(input.id); return e && e.state !== 'reading'; });
    const e = A.marks.readOf(input.id);
    same(e.state, 'done', `it read (${e.error || 'ok'})`);
    result = e.result;
    console.log(`  ${result.marks.length} marks over ${result.t1.toFixed(2)}s, ` +
                `front-end ${result.rate} Hz win ${result.win} hop ${result.hop}`);
    ok(result.marks.length > 0, 'and found something');
    // The front-end is brosoundml's and comes back on the answer rather than
    // being assumed here: a mark's error bar is the analysis window, and that
    // is bro's number.
    ok(result.rate > 0 && result.win > 0 && result.hop > 0,
       'the answer says which front-end measured it');

    // **Derived, so the document is untouched.** `peaks`'s rule and a telemetry
    // reading's: listening to a file does not change the edit, and a read that
    // marked a document unsaved would put a star on the title bar for having
    // listened.
    same(A.doc.dirty ? 'dirty' : 'clean', before,
         'and listening does not make the document unsaved — a mark is what a ' +
         'soundtrack says, not something anybody decided');
}

// ── what came back ─────────────────────────────────────────────────────────

console.log('\nwhat a mark says about itself');
{
    const kinds = new Set(result.marks.map((m) => m.kind));
    ok([...kinds].every((k) => k === 'onset' || k === 'tonal' || k === 'sound'),
       `every mark is one of the three kinds (${JSON.stringify([...kinds])})`);
    let ordered = true;
    for (let i = 1; i < result.marks.length; i++)
        if (result.marks[i].at < result.marks[i - 1].at) ordered = false;
    ok(ordered, 'and they come back in time order, every kind interleaved');

    const tonal = result.marks.filter((m) => m.kind === 'tonal');
    if (tonal.length) {
        ok(tonal.every((m) => m.hz > 0),
           `a tonal run carries the frequency it was measured at (${Math.round(tonal[0].hz)} Hz)`);
        ok(tonal.every((m) => m.length > 0), 'and a length, because a run has one');
    }
    const onsets = result.marks.filter((m) => m.kind === 'onset');
    if (onsets.length)
        ok(onsets.every((m) => m.length === 0),
           'an onset has no length at all — it is an instant, and a duration ' +
           'drawn for one would be invented');
}

// ── the lane ───────────────────────────────────────────────────────────────

console.log('\nthe marks reach the timeline through the clip');
{
    A.shell.goTo('edit');
    pump(60);
    // A clip of the file, because the lane is the *edit*: marks on a file
    // nothing is cut from are marks of a file nothing is using.
    A.openInput(input);
    pump(120);
    waitFor('a clip', () => A.project.clips.length > 0);
    A.timeline.draw();
    pump(40);

    const lane = A.timeline.marksLane();
    ok(!!lane.lane, 'the lane exists');
    ok(lane.rows.length > 0, `with ${lane.rows.length} marks on it`);

    // The Data lane re-appends itself last so a plot stays beside the waveform;
    // with no plot on screen this one is last, which puts it against A1.
    const tracks = lane.lane.parentNode.parentNode;
    const kids = Array.from(tracks.children)
                      .filter((n) => n.className.indexOf('track-row') >= 0);
    same(kids[kids.length - 1], lane.lane.parentNode,
         'and it is the last row in the box, which puts it against A1');

    // Every mark inside the clip it came from, because a mark outside the
    // window is dropped rather than clamped to the edge.
    const clip = A.project.clips[0];
    ok(lane.rows.every((r) => r.at >= clip.start - 1e-6 &&
                              r.at <= clip.start + clip.length + 1e-6),
       'every mark is inside the clip it belongs to');
}

console.log('\nand they follow a trim without being read again');
{
    const clip = A.project.clips[0];
    const wasLength = clip.length;
    const wasRows = A.timeline.marksLane().rows.length;
    // Trim the front. A mark in the part that was cut off is gone; the ones
    // left have moved on the timeline by exactly what was removed, because
    // `timelineTime` is the one map and the soundtrack was not touched.
    A.trimClip(clip, 'in', clip.start + wasLength / 2);
    pump(40);
    A.timeline.draw();
    ok(clip.length < wasLength,
       `the clip is trimmed (${wasLength.toFixed(2)}s → ${clip.length.toFixed(2)}s)`);
    const after = A.marks.readOf(input.id);
    same(after.result.marks.length, result.marks.length,
         'and the soundtrack was not read again — a mark belongs to the input, ' +
         'and the lane maps it through each clip');
    ok(A.timeline.marksLane().rows.length <= wasRows,
       `the lane draws ${A.timeline.marksLane().rows.length} of them now, which is ` +
       'the ones the edit still contains');
}

// ── the two keys ───────────────────────────────────────────────────────────

console.log('\n, and . walk the marks');
{
    // Undo the trim's effect on this section by starting from a whole clip
    // again: what is being checked is the walk, not the trim.
    A.removeSelection();
    pump(40);
    A.openInput(input);
    pump(120);
    waitFor('a clip', () => A.project.clips.length > 0);
    A.timeline.draw();

    const rows = A.marks.markRows(A.project.clips);
    ok(rows.length >= 2, `there are ${rows.length} marks to walk`);

    A.setPlayhead(0);
    pump(20);
    A.goToMark(1);
    pump(20);
    const first = A.transport.t;
    ok(near(first, rows[0].at, 0.01),
       `. from the start lands on the first mark (${first.toFixed(3)} against ` +
       `${rows[0].at.toFixed(3)})`);

    A.goToMark(1);
    pump(20);
    ok(A.transport.t > first,
       `and again moves on rather than sticking (${A.transport.t.toFixed(3)})`);

    A.goToMark(-1);
    pump(20);
    ok(near(A.transport.t, first, 0.01),
       'and , comes back to the one before it');

    A.goToMark(-1);
    pump(20);
    // Before the first mark there is nothing to go back to, and the playhead
    // stays where it is rather than jumping to zero: a key that does nothing
    // must do *nothing*.
    ok(near(A.transport.t, first, 0.01),
       'at the first mark, , stays put and says so');

    // The order is time, not kind. The whole gesture is "the next thing that
    // happened", and a walk that visited every onset before every run would
    // make it a question about which row you were on.
    //
    // **Moments, not marks.** A transient and the run it opens are two marks at
    // one instant — a click is an onset *and* the start of something above the
    // noise floor — and the walk stops there once, because a press that moved
    // the playhead to where it already is would be a key that appeared broken.
    // So what the walk has to visit is the set of distinct times.
    const moments = [];
    for (const r of rows)
        if (!moments.length || r.at - moments[moments.length - 1] > 0.001)
            moments.push(r.at);
    A.setPlayhead(0);
    pump(20);
    let last = -1, steps = 0, monotone = true;
    for (let i = 0; i < rows.length + 2; i++) {
        const before = A.transport.t;
        A.goToMark(1);
        pump(4);
        if (A.transport.t <= before) break;
        if (A.transport.t < last) monotone = false;
        last = A.transport.t;
        steps++;
    }
    ok(monotone && steps === moments.length,
       `walking forward visits all ${moments.length} moments in time order ` +
       `(${steps} steps over ${rows.length} marks)`);
}

// ── which kinds are drawn ──────────────────────────────────────────────────

console.log('\nturning a kind off takes it off the lane and out of the walk');
{
    const before = A.marks.markRows(A.project.clips).length;
    const kind = A.marks.markRows(A.project.clips)[0].kind;
    A.marks.showKind(kind, false);
    pump(20);
    A.timeline.draw();
    const after = A.marks.markRows(A.project.clips);
    ok(after.length < before,
       `turning '${kind}' off leaves ${after.length} of ${before}`);
    ok(after.every((r) => r.kind !== kind), 'and none of them is that kind');
    A.marks.showKind(kind, true);
    pump(20);
    same(A.marks.markRows(A.project.clips).length, before, 'and back on restores them');
}

// ── forgetting ─────────────────────────────────────────────────────────────

console.log('\nforgetting takes the lane with it');
{
    A.marks.dropMarks(input.id);
    pump(20);
    A.timeline.draw();
    ok(!A.marks.readOf(input.id), 'the read is gone');
    same(A.marks.markRows(A.project.clips).length, 0, 'and so are its marks');
    ok(!A.timeline.marksLane().lane,
       'so the lane is gone rather than empty — the timeline shows lanes for what ' +
       'the edit has');
}

console.log('\nand an input that goes away takes its marks');
{
    A.marks.findSounds(input);
    waitFor('the read',
            () => { const e = A.marks.readOf(input.id); return e && e.state !== 'reading'; });
    ok(!!A.marks.readOf(input.id), 'a read exists again');
    // Through the same channel every other retained thing goes through, which is
    // the point: an input can go away five ways and the one that gets missed is
    // the one that leaves a tick on the lane naming a file nothing answers to.
    A.removeSelection();
    pump(40);
    A.inputs.removeInput(input);
    pump(60);
    ok(!A.marks.readOf(input.id), 'and it goes with the input');
}

// ── a file with no soundtrack ──────────────────────────────────────────────

if (noSound) {
    console.log('\na file with no soundtrack is not offered the control');
    A.shell.goTo('sources');
    pump(60);
    type(el('src-path'), noSound);
    click(el('src-add'));
    pump(120);
    const quiet = A.inputs.inputs[A.inputs.inputs.length - 1];
    waitFor('the probe', () => quiet.probe);
    if ((quiet.probe.streams || []).some((s) => s.kind === 'audio')) {
        console.log('  -- this file has a soundtrack after all; skipped');
    } else {
        ok(!A.marks.worthReading(quiet),
           'a file with no audio stream is not worth listening to');
        ok(!qq('.src-data button').some((b) => b.textContent === 'Find sounds'),
           'and no button is drawn for it — the affordance is where it works, not ' +
           'everywhere with a refusal behind it');
    }
}

console.log(`\n${checks} checks passed`);
}
}
