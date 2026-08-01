// Opening a large edit without opening every file in it.
//
// The viewer's `<video>` elements *are* the decoders, and the rule used to be
// one per clip, built when the clip arrived and never taken back. That is right
// at a handful of clips and ruinous at seventy-five: measured on a montage of 75
// 1080p60 segments, opening it cost 26 s of frozen window and 9.1 GB resident,
// and with the elements suppressed the same open was 17 ms. `ui/residency.js` is
// the narrowing of that rule — a decoder is held by a clip *near the playhead* —
// and this is the suite for it, plus the second thing the same document
// exposed, which was not the elements at all.
//
// Five facts, none of which is visible in the model, the document or a
// screenshot:
//
//   - **an edit of many clips opens holding few decoders.** Counted, because
//     that is the only way to say it: nothing else on screen differs between an
//     edit with one element per clip and an edit with three.
//   - **every clip under the playhead has one.** `setPlayhead` reads
//     `clip.video.currentTime` on the line after it asks for them, so an element
//     that arrived a frame late would be a crash and not a hitch. This is the
//     bound that must never be traded for a smaller number.
//   - **moving the playhead brings in what it lands on**, wherever it lands and
//     without playing through the gap, which is what a scrub is.
//   - **the lanes survive eviction.** A waveform and a filmstrip belong to the
//     clip rather than to the element, so a decoder closing must leave the
//     timeline exactly as it was — otherwise scrolling would re-decode files,
//     which is the cost this is meant to remove rather than move.
//   - **a measurement landing is not an edit.** A waveform arriving off the
//     worker used to run the whole model-change cascade — the Sources cards, the
//     spine, the command bar, the export rows, every element's source — a
//     hundred and fifty times in one drain. At 22 clips that was a single frame
//     of 12.9 s against a median of 1 ms, which is the freeze this suite exists
//     to keep from coming back. Checked as a frame time, because "it does less
//     work now" has no other honest form.
//
// The edit is built from one file cut many times rather than from many files:
// residency is about how many decoders are open, and a decoder per clip is a
// decoder per clip whether or not two of them read the same path.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_load.js -- <media-file>

const A = globalThis.__ffmpegBro;
const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_load.js -- <file>');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(60);
    }
    throw new Error(`timed out waiting for ${what}`);
}

// ── an edit of many clips ──────────────────────────────────────────────────
//
// Thirty is well past the look-ahead and small enough to build in a test.
// They are laid end to end, which is the montage shape and the one that makes
// "near the playhead" mean something.

const COUNT = 30;

A.shell.goTo('sources');
pump(200);
const input = A.inputs.addInput({ path: media });
waitFor('the file to open', () => !!input.probe || !!input.error);
assert(!input.error, `opening ${media}: ${input.error}`);

for (let i = 0; i < COUNT; i++) A.openInput(input, { quiet: true });
pump(300);
assert(A.project.clips.length === COUNT,
       `expected ${COUNT} clips, laid out ${A.project.clips.length}`);

const clips = A.project.clips.slice().sort((a, b) => a.start - b.start);
const span = clips[clips.length - 1].start + clips[clips.length - 1].length;
assert(span > 0, 'the edit has no length');

// ── 1. few decoders, not one per clip ──────────────────────────────────────

A.setPlayhead(0);
pump(400);
const held = A.resident();
assert(held < COUNT,
       `${held} decoders open for ${COUNT} clips — residency is not bounding anything`);
// The look-ahead plus whatever is under the playhead. Generous, because the
// point is the *shape* — bounded rather than per-clip — and the constants in
// ui/residency.js are explicitly not precious.
assert(held <= 10, `${held} decoders open at the head of a ${COUNT}-clip edit`);
// And the queue behind it has drained rather than grown: a look-ahead that is
// refilled faster than it is emptied is a list of every clip in the edit under
// another name.
assert(A.decodersPending() <= 10,
       `${A.decodersPending()} clips still queued for a decoder after settling`);
console.log(`${COUNT} clips, ${held} decoders open`);

// ── 2. everything under the playhead has one ───────────────────────────────
//
// Checked at every clip in the edit rather than at one, because the failure this
// guards against is a clip the window happened to miss — and it is a crash in
// `setPlayhead`, not a blank picture.

for (const c of clips) {
    const mid = c.start + c.length / 2;
    A.setPlayhead(mid);
    for (const under of A.project.clips)
        if (mid >= under.start && mid < under.start + under.length)
            assert(under.video,
                   `no decoder for the clip at ${mid.toFixed(2)}s, which the playhead is inside`);
}
console.log(`every clip under the playhead held a decoder, across all ${COUNT}`);

// ── 3. a scrub to the far end, without playing through it ──────────────────

A.setPlayhead(0);
pump(400);
const last = clips[clips.length - 1];
A.setPlayhead(last.start + last.length / 2);
pump(200);
assert(last.video, 'a scrub to the last clip left it with no decoder');
// And the first one is let go again, once the frame loop has had a look. It is
// the whole edit away, which is well past `FAR`.
waitFor('the first clip to be let go', () => !clips[0].video, 20000);
assert(A.resident() <= 10,
       `${A.resident()} decoders open after scrubbing to the far end — nothing is being evicted`);
console.log(`scrubbed to the far end: ${A.resident()} decoders open, the first let go`);

// ── 4. the lanes survive the decoder going ─────────────────────────────────
//
// The clip that was just evicted is the one to ask, and what it must still have
// is what the timeline draws. `peaks` is the waveform; a filmstrip may still be
// in flight on a slow machine, so it is only checked when it arrived at all.

waitFor('the first clip to be read', () => !!clips[0].peaks, 120000);
assert(!clips[0].video, 'the clip under test is not evicted, so this proves nothing');
// The two fields `columnsOf` refuses to draw without, rather than "is truthy":
// an envelope with no buckets in it is a lane that says "reading…" forever.
assert(clips[0].peaks.buckets && clips[0].peaks.duration,
       'the waveform went with the decoder — analysis is being driven by residency');
console.log('the evicted clip kept its waveform' +
            (clips[0].film ? ' and its filmstrip' : ''));

// ── 5. a measurement landing is not an edit ────────────────────────────────
//
// The drain is where the freeze was: every result fired the whole cascade, and
// they all arrive in one frame. So the edit is read again from scratch and the
// frames it takes are timed — what is asserted is the *worst* one, because a
// total spread evenly over a hundred frames and a total in one frame are the
// same number and completely different to use.

for (const c of A.project.clips.slice()) { A.select(c); A.removeSelection(); }
pump(200);
assert(A.project.clips.length === 0, 'the edit did not clear');

for (let i = 0; i < COUNT; i++) A.openInput(input, { quiet: true });
A.setPlayhead(0);
// Where the undo track stands once the edit is made and before the readings
// land, so what the drain adds to it can be counted.
const stepsBefore = A.history.depth('edit');

let worst = 0;
let frames = 0;
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
    const at = Date.now();
    wallSleep(0); advanceTime(16); flush();
    const took = Date.now() - at;
    if (took > worst) worst = took;
    frames++;
    if (frames > 20 && A.pending() === 0) break;
}
console.log(`read ${COUNT} clips over ${frames} frames, worst frame ${worst} ms`);
// One second is far above anything this should reach and far below the 12.9 s
// that provoked the change — a threshold that fails on the bug and passes on a
// slow machine, which is the only kind worth asserting.
assert(worst < 1000,
       `a single frame took ${worst} ms while the clips were being read — ` +
       'a measurement landing is running the edit cascade again');

// And it is not an edit in the other sense either: sixty readings landing must
// not put sixty steps on the undo track, or a `Ctrl-Z` after opening a large
// document would walk back through the waveforms instead of the edit.
const added = A.history.depth('edit') - stepsBefore;
assert(added === 0,
       `${added} undo steps arrived while the clips were being read — ` +
       'a measurement is being recorded as an edit');

// ── 6. playback runs on the render, not on the clips ───────────────────────
//
// Crossing from one decoder to the next at every cut is ~65 ms of the drawing
// thread, and on a montage of short clips that is about one visible hitch a
// second. The render has no crossings in it. What has to be true of the swap is
// four things, and none of them is visible in a frame time:
//
//   - **the press is answered now.** Building a render opens every input it
//     reads — 1.2 s on a 75-clip edit — so `play()` must return and let the
//     clips carry playback rather than freezing on the button.
//   - **it takes over.** Otherwise this is all cost and no benefit.
//   - **the mode is not touched.** `O` is a thing somebody chooses; playback
//     borrowing the same render must not light its button, or pressing play
//     would appear to switch a mode nobody asked for.
//   - **a kept render does not answer for a moment nobody is at.** It is held
//     after playback stops so that stop-and-go is free, and while it is held it
//     is neither the picture nor the clock — the bug this caught was a scrub
//     being dragged back to wherever the render had been paused.
//   - **and the picture moves.** Taking the render over is worth nothing if what
//     arrives is a slideshow, which is exactly what it was: the run publishes
//     sixty pictures a second, the element took **0.7**, and the playhead went
//     forward in jumps of two and a half seconds. A pad holds one picture, and
//     the run was composting about a second ahead of the screen because that is
//     how far ahead of the speaker bro's audio ring is — so every pull handed it
//     a frame from the future, which it staged and sat on while the rest were
//     replaced unseen. Checked as *how often the picture changes*, because
//     nothing else tells a preview keeping up from one that has stopped: the
//     playhead's average rate was 1× throughout the failure.

A.setPlayhead(0);
const pressed = Date.now();
A.play();
const pressMs = Date.now() - pressed;
assert(pressMs < 250, `play() blocked for ${pressMs} ms — the render is being built in the press`);

waitFor('the render to take the picture', () => A.output.isShowing(), 60000);
assert(!A.output.isWanted(),
       'playing turned the preview mode on — it should borrow the render, not switch a mode');
console.log(`play() returned in ${pressMs} ms, render took the picture`);

// ── the picture keeps up ───────────────────────────────────────────────────
//
// Counted over frames that are paced against the wall clock, because that is the
// only pacing under which any of this means anything: `advanceTime` handed a
// fixed sixteen milliseconds is real time only if the loop manages sixty frames
// a second, and a loop that manages half that puts bro's clock — and everything
// bro paces against it — at half speed. The failure this guards is invisible
// there.
{
    const fps = (A.output.currentFacts() || {}).fps || 25;
    let shown = 0, last = null;
    const began = Date.now();
    const until = began + 6000;
    while (Date.now() < until) {
        const at = Date.now();
        wallSleep(8);
        advanceTime(Math.max(1, Date.now() - at));
        flush();
        const r = A.output.at();
        if (r !== null && r !== last) { shown++; last = r; }
    }
    const secs = (Date.now() - began) / 1000;
    // **Against the rate the render is making them**, not against the loop's own
    // frame count: the output rate is the ceiling and it is a property of the
    // edit, so a 25 fps fixture can never show one per pass of a loop spinning at
    // a hundred. A third of it is far below anything a working preview reaches —
    // this fixture measures about two thirds — and two orders of magnitude above
    // the failure, which was 0.7 a second against sixty.
    const floor = fps * secs / 3;
    assert(shown > floor,
           `the monitor showed ${shown} pictures in ${secs.toFixed(1)} s of a ` +
           `${fps} fps render (wanted more than ${floor.toFixed(0)}) — the element is ` +
           'being handed a picture from ahead of the screen and sitting on it');
    console.log(`the picture changed ${shown} times in ${secs.toFixed(1)} s ` +
                `of a ${fps} fps render`);
}

// Kept across a pause, and silent while it is kept: neither the picture nor the
// clock, so a scrub is answered by the clips and lands where it was aimed.
A.pause();
pump(200);
assert(!A.output.isShowing(), 'a kept render is still the picture after pausing');
const aim = clips[Math.floor(COUNT / 2)].start + 0.25;
A.setPlayhead(aim);
pump(200);
assert(Math.abs(A.transport.t - aim) < 0.5,
       `scrubbing to ${aim.toFixed(2)}s landed at ${A.transport.t.toFixed(2)}s — ` +
       'a render nobody is watching is driving the playhead');
console.log('a kept render is neither the picture nor the clock');

// ── the graph stage, and what a gesture on it costs ────────────────────────
//
// The same rule as everything above, one stage along: **what a gesture costs is
// what the gesture changed**, not how big the edit is. Thirty clips derive about
// two hundred and seventy nodes and a full redraw of them is most of a second —
// so a stage that did that on every mouse move, or at the end of every drag, is
// a stage that is unusable at exactly the size this suite is about. Three
// claims, and none of them can be seen in a screenshot:
//
//   - **moving a node lays nothing out.** A card is placed by its transform, so
//     the engine has nothing to re-measure; `left`/`top` is a layout property and
//     writing it on one card laid out the whole container — 10.4 ms a move at 634
//     nodes, against 0.8. Asserted as *zero layout passes*, which is the exact
//     form of the claim and does not depend on how fast the machine is.
//   - **letting go writes a pin down.** It used to end with a full redraw:
//     re-derive, throw away every card and build it again, re-measure, re-lay
//     out, reprint the whole `-filter_complex` — 1875 ms, measured, at the end of
//     every drag, to record two numbers the drag had already put on the screen.
//   - **a preview is asked for per card on the screen.** A node preview is an
//     ffmpeg render, and one per node made arriving at this stage cost a render
//     per node and a redraw per render.
//
// The two timing claims are made against a redraw measured *in this run*, so
// what is being asserted is a ratio and not a number of milliseconds on
// somebody's laptop.

A.shell.goTo('graph');
pump(400);
{
    const g = A.graph.current();
    assert(g && g.nodes.length > 60,
           `expected a graph of the whole edit, got ${g ? g.nodes.length : 0} nodes`);

    const full = (() => { const t = perf.now(); A.graph.draw(); return perf.now() - t; })();
    console.log(`a full redraw of ${g.nodes.length} nodes: ${full.toFixed(0)} ms`);

    const head = document.querySelector('.gn-head[data-drag]');
    assert(head, 'no draggable card on the graph stage');
    const box = head.getBoundingClientRect();
    const mouse = (target, type, x, y, buttons) => target.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: y, buttons, button: 0, bubbles: true }));

    const MOVES = 40;
    mouse(head, 'mousedown', box.left + 20, box.top + 8, 1);
    perf.reset();
    const began = perf.now();
    for (let i = 0; i < MOVES; i++)
        mouse(document.body, 'mousemove', box.left + 20 + (i % 20) * 2, box.top + 8 + i, 1);
    const perMove = (perf.now() - began) / MOVES;
    const moved = perf.stats();

    assert(moved.passes === 0 && moved.layoutMs === 0,
           `${MOVES} mouse moves of one card cost ${moved.passes} layout passes ` +
           `(${moved.layoutMs.toFixed(0)} ms over ${moved.nodesLaidOut} nodes) — a card is ` +
           'being moved by an offset rather than by its transform, so the engine is laying ' +
           'the whole container out again for a card that cannot affect any of it');
    assert(perMove < full / 10,
           `a mouse move costs ${perMove.toFixed(1)} ms against ${full.toFixed(0)} ms for a ` +
           'whole redraw — a drag is doing work priced in the size of the graph');
    console.log(`dragging a node: ${perMove.toFixed(2)} ms a move, ${moved.passes} layout passes`);

    const up = perf.now();
    mouse(document.body, 'mouseup', box.left + 60, box.top + 48, 0);
    const upMs = perf.now() - up;
    assert(upMs < full / 3,
           `letting go of a node cost ${upMs.toFixed(0)} ms against ${full.toFixed(0)} ms for a ` +
           'whole redraw — a pin is being written down by rebuilding the graph');
    console.log(`letting go: ${upMs.toFixed(0)} ms`);

    // What is left running is what the screen can show. Not zero — the cards in
    // view are worth a picture and that is the point of the feature — and well
    // under one per node, which is what it used to be.
    const queued = A.graph.preview.outstanding();
    assert(queued < g.nodes.length / 3,
           `${queued} node previews are queued for a graph of ${g.nodes.length} — a render ` +
           'is being asked for per node in the edit rather than per card on the screen');
    console.log(`node previews outstanding: ${queued} of ${g.nodes.length} nodes`);
}

// ── the derivation is priced in the edit, not in its square ────────────────
//
// The Graph stage is the least of the graph's cost, because the graph is derived
// far more often than it is drawn: the spine's card counts the filters and the
// command bar prints the chains, so **every edit restates the whole graph two or
// three times whether or not that stage is up**, and so does every walk to
// another stage. What made the whole application slow at seventy-five clips was
// not any of those callers — it was that `graph/model.js` answered `node()`,
// `byAnchor()` and `inEdges()` by searching the array. Nine nodes a clip is 679
// of them, and one `derive()` plus `print()` over that walked 12.9 million nodes
// and 3.5 million edges to answer eleven thousand lookups: 0.7 s for the card,
// 1.5 s for the bar, 2.4 s to change tab.
//
// **Asserted as a ratio between two sizes, not as a number of milliseconds.**
// The claim is about the *shape* of the cost, and the only honest form of "this
// is not quadratic" is to ask the same question of two edits and compare. A
// threshold in milliseconds would be a threshold about whichever machine ran it.

A.shell.goTo('compose');
pump(200);
{
    // A `derive()` and a `print()`, which is exactly what the spine's card costs
    // and what the command bar pays for. Repeated, because one of them at the
    // small size is under the clock's resolution.
    const REPEATS = 20;
    const restate = (times) => {
        const t = perf.now();
        for (let i = 0; i < times; i++) A.graph.summary();
        return perf.now() - t;
    };
    const nodesNow = () => {
        const d = A.graph.derive(A.exporter.buildSpec(), A.exporter.specSources(),
                                 { overlay: A.graph.overlay.current() });
        return d.ok ? d.graph.nodes.length : 0;
    };

    restate(3);
    const bigNodes = nodesNow();
    const big = restate(REPEATS);

    // A fifth of the edit, so the two sizes are far enough apart that a linear
    // cost and a quadratic one cannot be told apart only by the noise.
    const few = Math.max(4, Math.round(COUNT / 5));
    while (A.project.clips.length > few) {
        const c = A.project.clips[A.project.clips.length - 1];
        A.select(c);
        A.removeSelection();
    }
    pump(200);
    restate(3);
    const smallNodes = nodesNow();
    const small = restate(REPEATS);

    assert(smallNodes > 0 && bigNodes > smallNodes * 2 && small > 0,
           `the two sizes are not far enough apart to measure: ${smallNodes} nodes ` +
           `against ${bigNodes}, ${small.toFixed(1)} ms against ${big.toFixed(1)}`);

    // Linear predicts the ratio of the node counts; quadratic predicts its
    // square. Twice linear passes the first comfortably and fails the second by
    // a wide margin — at these sizes the two predictions are about 4.5 and 20.
    const grew = big / small;
    const linear = bigNodes / smallNodes;
    assert(grew < linear * 2,
           `${bigNodes} nodes cost ${grew.toFixed(1)}× what ${smallNodes} nodes cost, ` +
           `where the graph got ${linear.toFixed(1)}× bigger — the model is being ` +
           'searched rather than looked up, so every restatement of the graph is ' +
           'quadratic in the size of the edit');
    console.log(`restating the graph: ${bigNodes} nodes cost ${grew.toFixed(1)}× ` +
                `${smallNodes} nodes, for ${linear.toFixed(1)}× the graph ` +
                `(${(big / REPEATS).toFixed(1)} ms each)`);
}

console.log('ui_load: ok');
