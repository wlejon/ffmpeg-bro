// Turning a recording into stacks of clips, driven the way a person drives it.
//
// The Find stage is the answer to a question the rest of this application does
// not ask: a six-hour VOD is not scrubbed through, it is *queried*, and what
// comes back has to be arrangeable — "every time he said this, and one long run
// of talking for every three of them". This suite is about the four seams that
// makes:
//
//   - **the arithmetic is pure and is asserted as arithmetic.** A weave, a
//     placement into every third, a merge of overlapping spans and a seeded
//     shuffle are list-in/list-out and are checked directly. That is the whole
//     reason `ui/find/model.js` `evaluate` takes its world as four functions:
//     the alternative is a suite that has to transcribe six hours to find out
//     what a 1:3 mix does.
//   - **a wire carries one kind of thing and refuses the other.** A recording
//     does not go into a `Merge` and a stack does not go into a `Said`. Refused
//     by name, `ui/graph/derive.js`'s rule one stage over, because a wire that
//     silently became something else would produce an empty stack somewhere
//     downstream with nothing on screen saying why.
//   - **a rule reads what has been read and never starts a read.** A finder over
//     a recording nobody has listened to answers empty and says which press is
//     missing. This is what keeps a keystroke in the phrase field cheap.
//   - **the rules are in the document and the stacks are not.** A rule is
//     authored work and survives a save, an open and an undo; what it computes
//     comes back from the rules, exactly as a waveform comes back from a file.
//
// And the rule the whole stage is judged by, which is `ui/transcript.js`'s and
// is inherited rather than restated: **a transcript is a search hint and never
// the cut.** A candidate off a word search carries the measured distance between
// a stream's two renditions either side of it, so what reaches the timeline
// contains the moment rather than cutting at it. That is asserted here, because
// it is the failure that would quietly put every clip on the wrong frame.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_find.js -- <marks.m4a>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_find.js -- <marks.m4a>');

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

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const S = A.findStack;
const N = A.findNodes;

// One real input, opened once and used by every section below.
//
// **The file is real and the *read* is faked**, which is the split that matters
// and is not a shortcut. What costs hours is transcribing six hours of speech,
// and that is what `evaluate`'s four-function world exists to stand in for; the
// recording itself is cheap and has to be real, because a `source` rule names an
// input by id and `find.js` `retain()` deliberately clears one naming an id no
// input answers to — a rule pointing at a file that is not there is exactly the
// state that must not survive.
A.shell.goTo('sources');
pump(40);
A.open(media);
waitFor('the file to open',
        () => A.inputs.inputs.length > 0 && !!A.inputs.inputs[0].probe);
const INPUT = A.inputs.inputs[0];

/// A candidate, short. The tests below are about *order* and *span*, so
/// everything else on one is noise.
const c = (from, to, why) => S.candidate('in1', from, to, 'test', why || '');
const spans = (list) => list.map((x) => `${x.in}-${x.out}`).join(' ');
const whys = (list) => list.map((x) => x.detail).join(' ');

// ── the arithmetic, which is the whole of the expression ───────────────────

console.log('\na weave is what "one of these for every three of those" means');
{
    const a = [c(0, 1, 'a0'), c(10, 11, 'a1'), c(20, 21, 'a2')];
    const b = [c(0, 1, 'b0'), c(1, 2, 'b1'), c(2, 3, 'b2'), c(3, 4, 'b3'),
               c(4, 5, 'b4'), c(5, 6, 'b5'), c(6, 7, 'b6')];
    same(whys(S.mixed(a, b, 1, 3)), 'a0 b0 b1 b2 a1 b3 b4 b5 a2 b6',
         '1 of the first then 3 of the second, over and over');

    // **It runs until both are empty and not until the shorter one is.** A weave
    // that stopped at the shorter would silently discard the tail of the longer
    // — for 1:3 against 3 and 7 that is one candidate found and never seen —
    // and the loss is invisible in the result: it comes out as a montage that is
    // mysteriously short.
    const all = S.mixed(a, b, 1, 3);
    same(all.length, a.length + b.length, 'nothing found is ever silently dropped');

    same(whys(S.mixed(a, [], 1, 3)), 'a0 a1 a2', 'an empty second side leaves the first whole');
    same(S.mixed([], [], 1, 1).length, 0, 'two empty sides are empty');
    // Taking none of either is a setting somebody can type, so it is answered
    // rather than guarded against — and it must not be a loop that never ends.
    same(S.mixed(a, b, 0, 0).length, 0, 'taking none of either is nothing, not a hang');
}

console.log('\nand "every third" is a different operation from a ratio');
{
    const spine = [c(0, 1, 's0'), c(1, 2, 's1'), c(2, 3, 's2'), c(3, 4, 's3'),
                   c(4, 5, 's4'), c(5, 6, 's5')];
    const into = [c(0, 1, 'm0'), c(1, 2, 'm1')];
    same(whys(S.everyNth(spine, into, 3)), 's0 s1 s2 m0 s3 s4 s5 m1',
         'the spine keeps its order and the other is placed into it');
    // The distinction that earns the second node: a ratio consumes both sides
    // symmetrically, this one treats the first as a spine. Running out of the
    // thing being placed leaves the spine continuous.
    same(whys(S.everyNth(spine, [c(0, 1, 'm0')], 3)), 's0 s1 s2 m0 s3 s4 s5',
         'running out of what is being placed leaves the rest of the spine intact');
    same(whys(S.everyNth([c(0, 1, 's0')], into, 3)), 's0 m0 m1',
         'and what is left over is appended rather than dropped');
}

console.log('\nmerging is what stops one moment becoming three clips of itself');
{
    // A word said three times in one breath, padded ten seconds each: three
    // overlapping spans of the same moment. Cut, that is the same clip three
    // times over.
    const overlapping = [c(0, 20), c(5, 25), c(8, 28), c(100, 120)];
    const m = S.merged(overlapping, 0);
    same(m.length, 2, 'three overlapping spans of one moment become one');
    same(spans(m), '0-28 100-120', 'and the survivor covers all of what went into it');
    same(m[0].detail, '3 hits', 'which says how many, rather than under-reporting the recording');

    same(S.merged([c(0, 10), c(12, 20)], 0).length, 2, 'a real gap is not merged');
    same(S.merged([c(0, 10), c(12, 20)], 3).length, 1, '...unless it is inside the tolerance');

    // Two recordings cannot overlap however close their numbers are.
    const two = [S.candidate('in1', 0, 10, 'r'), S.candidate('in2', 1, 9, 'r')];
    same(S.merged(two, 0).length, 2, 'spans of two different recordings never merge');

    // `mix` hands back a list that is deliberately out of time order, and a
    // merge that only folded adjacent neighbours would fold almost none of it.
    same(S.merged([c(8, 28), c(0, 20), c(5, 25)], 0).length, 1,
         'and a list arriving out of order still merges');
}

console.log('\na shuffle is seeded, because a redraw must not reorder a montage');
{
    const list = [c(0, 1, '0'), c(1, 2, '1'), c(2, 3, '2'), c(3, 4, '3'), c(4, 5, '4')];
    const once = whys(S.sorted(list, 'scattered', 7));
    const again = whys(S.sorted(list, 'scattered', 7));
    same(once, again, 'the same seed is the same order');
    ok(once !== whys(S.sorted(list, 'scattered', 8)), 'and a different seed is a different one');
    same(S.sorted(list, 'scattered', 7).length, list.length, 'a shuffle keeps everything');
    same(whys(S.sorted(list, 'found')), '0 1 2 3 4', "'found' is the order the recording said them");
    same(whys(S.sorted([c(0, 5, 'long'), c(0, 1, 'short')], 'longest')), 'long short',
         'and the others are real rearrangements');
}

console.log('\npadding is clamped to the recording it came from');
{
    const at = (id) => (id === 'in1' ? 30 : 0);
    same(spans(S.padded([c(5, 6)], 10, 10, at)), '0-16', 'never before the start');
    same(spans(S.padded([c(25, 26)], 10, 10, at)), '15-30', 'and never past the end');
    // The moment keeps its place in the file, so a row can still say where the
    // word is inside a twenty-second span.
    same(S.padded([c(20, 21)], 10, 10, at)[0].at, 20, 'and the moment keeps its own time');
}

// ── the wires ──────────────────────────────────────────────────────────────

console.log('\na wire carries one kind of thing and refuses the other');
{
    const g = A.find.findGraph();
    for (const n of g.nodes.slice()) g.remove(n);

    const src = g.add('source');
    const said = g.add('said');
    const merge = g.add('merge');
    const sink = g.add('stack');

    same(g.connect(src, said, 0, 0), '', 'a recording goes into a Said');
    ok(g.connect(src, merge, 0, 0) !== '', 'and does not go into a Merge');
    ok(g.connect(src, merge, 0, 0).indexOf('recording') >= 0,
       '...refused by name, saying what it is and where it goes');
    same(g.connect(said, merge, 0, 0), '', 'a stack goes into a Merge');
    same(g.connect(merge, sink, 0, 0), '', 'and into a Stack');
    ok(g.connect(said, src, 0, 0) !== '', 'and never back into a recording socket');

    // A cycle you cannot draw is one nobody has to be told about.
    ok(g.connect(sink, said, 0, 0) !== '', 'a loop is refused rather than survived');
    ok(g.connect(said, said, 0, 0) !== '', 'and a node cannot feed itself');

    // One wire per input socket: a second replaces the first, because every
    // operation here reads exactly one list per pad.
    const said2 = g.add('said');
    g.connect(src, said2, 0, 0);
    g.connect(said2, merge, 0, 0);
    same(g.inEdges(merge).length, 1, 'a socket takes one wire, and a second replaces it');
    same(g.inEdges(merge)[0].from, said2.id, '...the new one');
    g.remove(said2);
}

// ── a rule reads what has been read, and says what is missing ──────────────

console.log('\na finder over a recording nobody has listened to says which press is missing');
{
    const g = A.find.findGraph();
    for (const n of g.nodes.slice()) g.remove(n);
    const src = g.add('source');
    const said = g.add('said');
    const sound = g.add('sound');
    const sink = g.add('stack');
    g.connect(src, said, 0, 0);
    g.connect(src, sound, 0, 0);
    g.connect(said, sink, 0, 0);
    g.setParam(src, 'inputId', INPUT.id);
    g.setParam(said, 'phrase', 'anything');

    // A recording that is open and that nothing has listened to. `coverageOf`
    // and `marksOf` answer null for exactly this — null and "read nothing yet"
    // are different answers, and only the first is a press somebody has not
    // made.
    const unheard = {
        inputById: (id) => (id === INPUT.id ? INPUT : null),
        durationOf: () => 3600,
        coverageOf: () => null,
        marksOf: () => null,
        search: () => [],
    };
    const res = A.find.evaluateWith(unheard);
    same((res.values.get(said.id) || []).length, 0, 'it answers with an empty stack');
    ok((res.notes.get(said.id) || '').indexOf('Transcribe') >= 0,
       '...and names the press that is missing rather than starting one');
    ok((res.notes.get(sound.id) || '').indexOf('Find sounds') >= 0,
       'a Sound rule names its own press, which is a different one');

    // And with nothing wired at all it says so, rather than naming a press
    // about a recording that is not there.
    g.disconnectAt(said, 0);
    const bare = A.find.evaluateWith(unheard);
    ok((bare.notes.get(said.id) || '').indexOf('wire a recording') >= 0,
       'and an unwired rule asks for a recording first');
}

// ── the rules run against a transcript that was never read from a file ─────

console.log('\nthe evaluation takes its world as four functions, so this is checkable at all');
{
    const g = A.find.findGraph();
    for (const n of g.nodes.slice()) g.remove(n);
    const src = g.add('source');
    const said = g.add('said');
    const sink = g.add('stack');
    g.connect(src, said, 0, 0);
    g.connect(said, sink, 0, 0);
    g.setParam(src, 'inputId', INPUT.id);
    g.setParam(said, 'phrase', 'yeah');
    g.setParam(said, 'pad', '10');

    // Four functions and no file, no read and no screen. This is the shape the
    // whole suite turns on.
    const fake = {
        inputById: (id) => (id === INPUT.id ? INPUT : null),
        durationOf: () => 3600,
        coverageOf: () => ({ read: 3600, duration: 3600 }),
        marksOf: () => null,
        search: (id, phrase) => (phrase === 'yeah'
            ? [{ inputId: id, start: 100, end: 102, text: 'oh yeah that is the thing', at: 3 },
               { inputId: id, start: 500, end: 503, text: 'yeah no absolutely', at: 0 }]
            : []),
    };
    const out = A.find.evaluateWith(fake);
    const found = out.values.get(said.id);
    same(found.length, 2, 'two places the word was said');

    // **The pad is the two clocks and this is the assertion that keeps it.** A
    // transcript is read from the cheapest soundtrack — for a Twitch VOD the
    // audio-only rendition — and the picture rendition does not share its zero,
    // measured at up to +2.57 s. A span cut to the word boundary would sometimes
    // not contain the word at all.
    same(spans(found), '90-112 490-513', 'each carried the measured distance either side');
    ok(S.PAD_MIN >= 2.57,
       'and the pad clears the largest offset the two renditions were measured apart');
    same(found[0].at, 100, 'the word keeps its own time inside the padded span');
    ok(found[0].detail.indexOf('yeah') >= 0, 'and the sentence it was in comes with it');

    // The chain restated as counts, which is what the cards print.
    const merge = g.add('merge');
    g.connect(said, merge, 0, 0);
    g.connect(merge, sink, 0, 0);
    const chained = A.find.evaluateWith(fake);
    same((chained.values.get(sink.id) || []).length, 2, 'and the chain carries them to the stack');
}

// ── a hit is a place and never a cut ───────────────────────────────────────

console.log('\nsearch results carry no in point, no out point and no clip');
{
    // `ui/transcript.js` `search()`'s shape, asserted here as well as in
    // tests/ui_transcript.js because the Find stage is now the thing most likely
    // to want to add one — a `Said` rule is exactly where somebody would reach
    // for "and trim it to the word".
    const hits = A.transcript.search('anything at all');
    ok(Array.isArray(hits), 'a search answers with a list');
    for (const h of hits) {
        ok(!('in' in h) && !('out' in h) && !('clip' in h),
           'a hit is a place and a sentence, and nothing that could be cut with');
    }
}

// ── the rules are the document, and the stacks are not ─────────────────────

console.log('\nrules are authored work and survive a save; stacks come back from the rules');
{
    const g = A.find.findGraph();
    for (const n of g.nodes.slice()) g.remove(n);
    const src = g.add('source');
    const said = g.add('said');
    const sink = g.add('stack');
    g.connect(src, said, 0, 0);
    g.connect(said, sink, 0, 0);
    g.setParam(said, 'phrase', 'insane');
    g.setParam(sink, 'name', 'the insanes');

    const snap = A.doc.snapshot();
    ok(!!snap.find, 'the rules are in the document');
    same(snap.find.nodes.length, 3, '...whole');
    // What they produce is not, for `peaks`' reason: derived from the rules the
    // way a waveform is derived from a file.
    const written = JSON.stringify(snap.find);
    ok(written.indexOf('candidate') < 0 && written.indexOf('"out":') < 0,
       'and what they found is not, because it comes back from them');

    A.find.open(snap.find);
    const back = A.find.findGraph();
    same(back.nodes.length, 3, 'an open puts every rule back');
    same(back.edges.length, 2, '...and every wire');
    const phrase = back.nodes.find((n) => n.kind === 'said');
    same(phrase.params.phrase, 'insane', '...with what was typed into it');

    // Version-tolerant, this repository's rule for every read of persisted
    // state: what is in a `.fbro` was written by an earlier version of this
    // code, and one stale node must not refuse the document.
    A.find.open({ nodes: [{ id: 'f90', kind: 'nosuchkind' },
                          { id: 'f91', kind: 'said', params: { phrase: 'ok', gone: 1 } }],
                  edges: [{ from: 'f90', to: 'f91', port: 0, fromPort: 0 },
                          { from: 'nobody', to: 'f91', port: 0, fromPort: 0 }] });
    const tolerant = A.find.findGraph();
    same(tolerant.nodes.length, 1, 'a kind this version does not have is skipped, not thrown on');
    same(tolerant.edges.length, 0, '...and so is a wire naming a node that is not there');
    ok(!('gone' in tolerant.nodes[0].params), 'and a stale field does not ride along into the next save');
}

// ── the stage is on the spine, between the two it belongs between ──────────

console.log('\nthe stage sits where the work is: after the file, before the edit');
{
    const names = qq('#spine .st-name').map((n) => n.textContent);
    const at = names.indexOf('Find');
    ok(at > 0, 'Find is on the spine');
    same(names[at - 1], 'Sources', '...after Sources');
    same(names[at + 1], 'Compose', '...and before Compose');

    // **Reachable with nothing on the timeline**, which is the one thing about
    // its place on the spine that had to be decided rather than inherited.
    // Encode and Write are refused over an empty edit, because there is nothing
    // for them to be about; this stage is the opposite — an empty timeline is
    // the *ordinary* state to arrive in, since finding the material is what you
    // came here to do before there is an edit at all.
    A.project.clips.length = 0;
    A.changed('clips');
    pump(40);
    ok(A.shell.goTo('find'), 'it opens with nothing on the timeline');
    pump(60);
    ok(!el('st-find').classList.contains('hidden'), 'and the stage is up');
    ok(!A.shell.goTo('write'), '...where the encode side is refused over the same empty edit');
    A.shell.goTo('find');
}

// ── a stack becomes an edit, in the order the rules put it in ──────────────

console.log('\nsending a stack makes clips end to end, in the arrangement');
{
    const input = INPUT;

    const before = A.project.clips.length;
    const made = A.find.sendToTimeline([
        S.candidate(input.id, 1, 3, 'said', 'first'),
        S.candidate(input.id, 5, 6, 'said', 'second'),
        S.candidate(input.id, 8, 11, 'said', 'third'),
    ]);
    same(made.made, 3, 'three candidates become three clips');
    same(A.project.clips.length, before + 3, '...on the timeline');

    const mine = A.project.clips.slice(-3);
    // **End to end, in the arrangement.** A stack is an *order* — that is what
    // Mix and Every are for — and laying the clips out at their source times
    // would throw it away and stack them at one place besides.
    same(mine.map((x) => x.length.toFixed(0)).join(','), '2,1,3', 'each is as long as its span');
    same(mine[1].start.toFixed(2), (mine[0].start + mine[0].length).toFixed(2),
         'and each begins where the one before it ended');
    same(mine[2].start.toFixed(2), (mine[1].start + mine[1].length).toFixed(2),
         '...all the way down');
    same(mine[0].inPoint, 1, 'cut from where the candidate said');
    ok(mine[0].name.indexOf('first') >= 0,
       'and named with the reason it is here, not with the file it came from');

    // A candidate whose recording has gone is counted rather than dropped in
    // silence: an input can be removed on Sources while a stack naming it sits
    // on the canvas.
    const gone = A.find.sendToTimeline([S.candidate('no-such-input', 0, 1, 'said', 'x')]);
    same(gone.made, 0, 'a candidate whose recording is gone makes no clip');
    same(gone.skipped, 1, '...and is said out loud rather than dropped in silence');
}

// ── what the words claim ───────────────────────────────────────────────────

console.log('\nnothing on this stage claims a classification the DSP never made');
{
    // `ui/marks.js` `MARK_WORDS` is the one home and `tests/ui_marks.js` guards
    // it. What is checked here is that this stage did not grow a second set of
    // words on the way past — a rule called "find the monologues" would be this
    // application claiming a classification an energy gate never made, and the
    // Find stage is the most tempting place in the codebase to write one.
    const claims = ['bird', 'speech', 'voice', 'monologue', 'music', 'talking', 'silence'];
    for (const key of Object.keys(N.KINDS)) {
        const k = N.KINDS[key];
        const said = `${k.title} ${(k.fields || []).map((f) => f.label).join(' ')}`.toLowerCase();
        const bad = claims.find((x) => said.indexOf(x) >= 0);
        ok(!bad, `'${key}' is named after what it does: "${k.title}"`);
    }
    same(N.KINDS.sound.params.mark, 'sound',
         "the energy gate is still called 'sound' where a rule picks it");
}

console.log(`\n${checks} checks passed`);
