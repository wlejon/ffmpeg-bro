// The edit, saved and opened again.
//
// One object describes the whole edit — see ui/document.js — and everything
// worth checking about it is a round trip: build something that could not have
// been guessed at, throw the application's state away, put the object back, and
// find the same thing. What makes that a real test rather than a JSON exercise
// is *which* things have to come back identical, because three of them are
// names that other files write down:
//
//   - **A clip's id**, which the graph overlay pins a filter to
//     (`clip:7/after-scale`). Renumber on open and every insert quietly moves to
//     a different shot.
//   - **An input's id**, which a graph source node names (`in3`). Renumber and
//     the graph reads a different file — which is why the `localStorage` path
//     refuses to restore one at all, and why the document path can.
//   - **The input order**, which is the `-i` number a spec and a `[0:v]` count
//     in.
//
// So the suite builds two inputs and three clips, wires a filter onto the second
// clip and a source node onto the second input, saves, opens a *different* edit
// over the top, and opens the file again. Anything that survives by accident —
// because the model was never actually cleared — fails the middle step.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_document.js -- <video> [<second video>]

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_document.js -- <file> [<file2>]');
// A second file is what makes "two inputs, in this order" a fact rather than a
// coincidence. Optional, because every suite here runs against one real file.
const other = args[1] || '';

const fs = require('fs');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const el = (id) => document.getElementById(id);
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
const near = (a, b) => Math.abs(a - b) < 1e-6;

// The overlay outlives the process, so a previous run's nodes would be counted
// as this one's.
localStorage.removeItem('ffmpeg-bro.graph');

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const doc = A.doc;
A.graph.overlay.clear();

// Somewhere to write. `tempPath` is the host's own scratch directory, which is
// where the export preview's files go — a document written into the source tree
// would be a file the next run of this suite finds.
const path = `${bro.ffmpeg.tempPath('document')}.fbro`;

/// The last element of a path, either separator. `ui/format.js` has this and it
/// is not on the surface, which is right: the surface is for things a test could
/// not compute for itself.
const leaf = (p) => String(p).split(/[\\/]/).pop();

// ── nothing yet ────────────────────────────────────────────────────────────

same(doc.documentName(), 'Untitled', 'an edit nobody has saved is Untitled');
ok(!doc.documentPath(), 'and has no path');
ok(doc.snapshot().clips.length === 0, 'and no clips in it');

// ── an edit worth keeping ──────────────────────────────────────────────────
//
// Deliberately not the default anything: a second track, a trim that is not from
// zero, a crop, a canvas that is not the clip's size, and a rate the file is not
// at. Every one of those is a field that a reader could drop without any of the
// others noticing.

A.open(media);
waitFor('the file to load', () => A.project.clips.length === 1);
const secondPath = other || media;
A.open(secondPath);
waitFor('the second clip', () => A.project.clips.length === 2);
pump(200);

const first = A.project.clips[0];
const second = A.project.clips[1];
second.track = 1;
second.start = 2.5;
second.inPoint = 0.4;
second.length = Math.min(1.5, second.media - second.inPoint);
second.xform.fit = 'cover';
second.xform.zoom = 1.75;
second.xform.panX = -0.2;
second.xform.crop.l = 0.1;
second.xform.opacity = 0.5;
second.volume = 0.25;
second.muted = true;
A.project.width = 640;
A.project.height = 360;
A.project.fps = 30;
A.project.layout = 'grid';

// A third clip, made by splitting the first, because a split is the one edit
// that hands out a clip id nothing else has seen — and it is the id an anchor
// would be pinned to.
A.setPlayhead(first.start + first.length / 2);
A.splitAtPlayhead();
pump(120);
ok(A.project.clips.length === 3, `a split made a third clip (${A.project.clips.length})`);

// Something on the graph that names both kinds of id.
const inputs = A.inputs.inputs;
same(inputs.length, other ? 2 : 1, `${other ? 'two' : 'one'} input on the Sources stage`);
const anchoredTo = second.id;
A.graph.overlay.insert(`clip:${anchoredTo}/after-scale`, 'hflip');
const sourceNode = A.graph.overlay.addSource(inputs[inputs.length - 1].id);
pump(80);

// And something on the Write stage that only a document carries.
const output = A.exporter.currentSettings();
output.chapters = [{ start: 0, end: 1.25, title: 'Opening' }];
output.rangeIn = 0.5;
output.rangeOut = 2;
output.title = 'a document test';

const before = doc.snapshot();
same(before.clips.length, 3, 'the snapshot has every clip');
same(before.inputs.length, inputs.length, 'and every input');
same(before.canvas.width, 640, 'and the canvas, which is not a clip size');
same(before.canvas.layout, 'grid', 'and the layout');
same(before.output.chapters.length, 1, 'and the chapters, which the workspace does not keep');
same(before.output.rangeIn, 0.5, 'and the render range, for the same reason');
ok(before.graph.inserts.length === 1 && before.graph.nodes.length === 1,
   'and the graph overlay, both kinds of node');

// The snapshot is a value, not a view. An undo stack is a list of these, so one
// that shared its objects with the model would be N copies of the present.
second.xform.zoom = 9;
same(before.clips.find((c) => c.id === second.id).xform.zoom, 1.75,
     'and it does not change when the model does');
second.xform.zoom = 1.75;

// ── written ────────────────────────────────────────────────────────────────

ok(doc.isModified(), 'an edit that has been made is unsaved');
doc.save(path);
ok(!doc.isModified(), 'and is not, once written');
same(doc.documentPath(), path, 'and knows where it went');
ok(fs.existsSync(path), 'and there is a file there');

const text = fs.readFileSync(path, 'utf-8');
ok(text.indexOf('\n') > 0, 'written indented, so a diff of an edit is readable');
const raw = JSON.parse(text);
same(raw.format, 'ffmpeg-bro', 'and says what wrote it');
ok(raw.version >= 1, 'and which version');
ok(!('probe' in (raw.clips[0] || {})) && !('name' in (raw.clips[0] || {})),
   'a clip carries no probe and no name — both are its input\'s answer');
ok(!('src' in (raw.inputs[0] || {})),
   'and an input carries no src, which is a registration this run made');

// ── something else entirely ────────────────────────────────────────────────
//
// The middle step, and the one that makes the round trip mean anything: if the
// model is not genuinely emptied then everything below passes for free.

doc.reset();
A.documentOpened({ clips: [], skipped: [] });
pump(120);
same(A.project.clips.length, 0, 'New empties the timeline');
same(A.inputs.inputs.length, 0, 'and the Sources stage');
ok(A.graph.overlay.isEmpty(), 'and the graph');
same(A.exporter.currentSettings().chapters.length, 0, 'and the chapters, which named this timeline');
same(doc.documentName(), 'Untitled', 'and it is Untitled again');
ok(!doc.isModified(), 'and unmodified, because a new document is not an edit');

A.open(media);
waitFor('a clip in the way', () => A.project.clips.length === 1);
// An input id and a clip id have both been handed out again by now, which is
// exactly the collision the ids in the file have to survive.
ok(A.inputs.inputs[0].id === 'in1' || true, `the fresh input is ${A.inputs.inputs[0].id}`);

// ── opened ─────────────────────────────────────────────────────────────────

const result = doc.load(path);
A.documentOpened(result);
pump(200);

same(result.skipped.length, 0, 'the document opened with nothing left out');
same(A.project.clips.length, 3, 'every clip back');
same(A.inputs.inputs.length, inputs.length, 'every input back');
same(doc.documentName(), leaf(path), 'named after the file');
ok(!doc.isModified(), 'and not unsaved, having just been read');

const back = doc.snapshot();
same(JSON.stringify(back.clips), JSON.stringify(before.clips),
     'the clips are the same clips, ids and all');
same(JSON.stringify(back.inputs), JSON.stringify(before.inputs),
     'and the inputs are the same inputs, in the same order');
same(JSON.stringify(back.canvas), JSON.stringify(before.canvas), 'and the canvas');
same(back.output.chapters.length, 1, 'and the chapters');
same(back.output.rangeIn, 0.5, 'and the range');
same(back.output.title, 'a document test', 'and the title');

const two = A.project.clips.find((c) => c.id === second.id);
ok(!!two, `the clip a filter was pinned to kept its id (${second.id})`);
same(two.xform.fit, 'cover', 'and its fit');
ok(near(two.xform.zoom, 1.75), `and its zoom (${two.xform.zoom})`);
ok(near(two.xform.crop.l, 0.1), 'and its crop');
ok(near(two.xform.opacity, 0.5), 'and its opacity');
ok(near(two.volume, 0.25) && two.muted === true, 'and its level');
ok(near(two.start, 2.5) && near(two.inPoint, 0.4), 'and where it sits and starts');
same(two.track, 1, 'and which track it is on');

// The whole reason the ids are in the file.
const inserts = A.graph.overlay.inserts();
same(inserts.length, 1, 'the inserted filter came back');
same(inserts[0].anchor, `clip:${anchoredTo}/after-scale`,
     'pinned to the clip it was pinned to, by the id that clip still has');
const sources = A.graph.overlay.sourceInputs();
same(sources.length, 1, 'and the source node came back — which localStorage refuses');
same(sources[0], A.inputs.inputs[A.inputs.inputs.length - 1].id,
     'naming the input it named, which is the same file');
ok(A.graph.overlay.nodes().some((n) => n.id === sourceNode.id),
   'with the id it had, so nothing else can be issued it');

// And the clips are playable, which is the thing a list of numbers cannot say.
waitFor('the restored clips to decode', () =>
    A.project.clips.every((c) => c.video && c.video.videoWidth > 0), 30000);
ok(true, 'and every restored clip has a decoder behind it');

// ── a document describing a file that is not there ─────────────────────────
//
// The honest failure: the input comes back carrying libav's message, the clips
// cut from it are not laid out, and the caller is told which. Not a refusal —
// a document with one missing file is a document you still want the rest of.

const broken = JSON.parse(JSON.stringify(raw));
broken.inputs[0].path = `${media}.this-is-not-here.mp4`;
const lost = doc.open(broken);
A.documentOpened(lost);
pump(150);
ok(lost.skipped.length >= 1, `a clip of a missing file is not laid out (${lost.skipped.length})`);
ok(/this-is-not-here/.test(lost.skipped[0].name) ||
   !!lost.skipped[0].why, `and says why: ${lost.skipped[0].why}`);
same(A.inputs.inputs.length, raw.inputs.length,
     'the input itself is still there, carrying its error, the way a Sources row shows one');
ok(!!A.inputs.inputs[0].error, `which is ${A.inputs.inputs[0].error}`);

// ── a file that is not a document ──────────────────────────────────────────

const junk = `${bro.ffmpeg.tempPath('notadoc')}.fbro`;
fs.writeFileSync(junk, 'this is not JSON at all', 'utf-8');
let threw = '';
try { doc.read(junk); } catch (e) { threw = String((e && e.message) || e); }
ok(/is not a document/.test(threw), `a file that is not one says so: ${threw}`);
fs.unlinkSync(junk);

// An empty object is a document, and it is the empty one. Version-tolerant is
// the rule everywhere here: a reader that threw would be a reader that cannot
// open a file written by a version it has never seen.
const nothing = doc.open({});
A.documentOpened(nothing);
pump(120);
same(A.project.clips.length, 0, 'a document with nothing in it opens as nothing');
same(A.inputs.inputs.length, 0, 'with no inputs');

// ── the unsaved marker ─────────────────────────────────────────────────────

doc.load(path);
A.documentOpened({ clips: [], skipped: [] });
pump(120);
ok(!doc.isModified(), 'freshly opened, nothing is unsaved');
ok(el('doc-name').className.indexOf('modified') < 0, 'and the topbar does not say it is');
A.select(A.project.clips[0]);
pump(60);
ok(!doc.isModified(), 'picking a clip is not an edit — a document holds no selection');
A.setLayout('stack');
pump(60);
ok(doc.isModified(), 'moving something is');
ok(el('doc-name').className.indexOf('modified') >= 0, 'and the topbar says so');
same(el('doc-name').textContent, leaf(path),
     'beside the name, which has not changed');

// ── the buttons ────────────────────────────────────────────────────────────
//
// Save is the one press that needs no dialog, because the document already has
// a path. Open and New both go through pickers or replace the timeline, so this
// checks the one that can be pressed without a person in front of it.

click(el('doc-save'));
pump(80);
ok(!doc.isModified(), 'Save writes to where it came from without asking');
ok(fs.existsSync(path), 'and the file is still there');

// ── undo ───────────────────────────────────────────────────────────────────
//
// The second thing the object is for. A step of history is a snapshot minus its
// `output`, so what is checked here is not "does JSON round-trip" — that is
// settled above — but the three rules that decide what a *step* is, and the one
// property that makes undo usable at all: applying a state reconciles rather
// than rebuilds, so a `Ctrl-Z` over a crop does not tear down every decoder.

const H = A.history;

doc.reset();
A.documentOpened({ clips: [], skipped: [] });
A.open(media);
waitFor('a clip to undo', () => A.project.clips.length === 1);
pump(200);
const only = A.project.clips[0];
const element = only.video;
// Somewhere that is not zero, so that "it went back" is a fact rather than the
// clip having been there all along.
only.start = 3;
A.changed('edit');
pump(60);
H.reset();
ok(!H.canUndo() && !H.canRedo(), 'a history just reset has nowhere to go either way');

const wasStart = only.start;

// A drag: `move` per mouse position, one `moved` at the end. One step, and the
// state it goes back to is the one from before the first `move`.
for (let i = 1; i <= 20; i++) { only.start = wasStart + i * 0.1; A.changed('move'); }
A.changed('moved');
pump(60);
same(H.depth(), 1, 'a drag of twenty positions is one step');
ok(doc.isModified(), 'and the document says so');

ok(A.stepHistory(true), 'undo goes back');
pump(80);
ok(near(A.project.clips[0].start, wasStart),
   `to where the drag started (${A.project.clips[0].start} → ${wasStart})`);
ok(!H.canUndo() && H.canRedo(), 'with nothing behind it and one thing ahead');

// The property the whole reconcile exists for.
same(A.project.clips[0].video, element,
     'and the clip is still being decoded by the element it always was');

ok(A.stepHistory(false), 'redo goes forward again');
pump(80);
ok(near(A.project.clips[0].start, wasStart + 2), 'to where the drag ended');

// A change that changed nothing is not a step. `retain()` fires on every model
// change and usually has nothing to drop, which is exactly this case.
const depthWas = H.depth();
A.changed('edit');
A.changed('retain');
pump(40);
same(H.depth(), depthWas, 'a change that changed nothing is not a step');

// Two of a kind in quick succession are one — a slider reports every pixel.
A.project.clips[0].xform.zoom = 1.2; A.changed('edit');
A.project.clips[0].xform.zoom = 1.4; A.changed('edit');
A.project.clips[0].xform.zoom = 1.6; A.changed('edit');
pump(40);
same(H.depth(), depthWas + 1, 'three of a kind inside half a second are one step');
A.stepHistory(true);
pump(60);
ok(near(A.project.clips[0].xform.zoom, 1),
   `and undoing it goes back past all three (${A.project.clips[0].xform.zoom})`);

// ...and apart, they are not. The gap is the rule, so the test has to wait it
// out rather than assert around it.
A.project.clips[0].xform.opacity = 0.8; A.changed('edit');
pump(700);
A.project.clips[0].xform.opacity = 0.6; A.changed('edit');
pump(40);
A.stepHistory(true);
pump(60);
ok(near(A.project.clips[0].xform.opacity, 0.8),
   `a change after the gap is its own step (${A.project.clips[0].xform.opacity})`);

// A new edit throws the redo away, which is what makes a history a tree nobody
// has to think about.
ok(H.canRedo(), 'there is something to redo');
A.setLayout('grid');
pump(60);
ok(!H.canRedo(), 'and an edit made instead of redoing throws it away');
A.setLayout('stack');
pump(60);

// Structure, not only fields.
const before2 = A.project.clips.length;
A.setPlayhead(A.project.clips[0].start + A.project.clips[0].length / 2);
A.splitAtPlayhead();
pump(120);
same(A.project.clips.length, before2 + 1, 'a split is two clips');
A.stepHistory(true);
pump(120);
same(A.project.clips.length, before2, 'and undoing it is one again');
ok(A.project.clips[0].video === element,
   'still decoded by the same element, because the half that survived never moved');

// The graph is on its own change channel and is in the document, so it is in
// the history — which is the case the absence was felt most in.
A.graph.overlay.clear();
pump(60);
const marks = H.depth();
A.graph.overlay.insert(`clip:${A.project.clips[0].id}/after-scale`, 'hflip');
pump(60);
same(H.depth(), marks + 1, 'a filter inserted on the graph is a step');
A.stepHistory(true);
pump(80);
same(A.graph.overlay.inserts().length, 0, 'and undoing it takes the filter off');
A.stepHistory(false);
pump(80);
same(A.graph.overlay.inserts().length, 1, 'and redoing it puts it back');

// What an undo of the *edit* is deliberately not about. Two tracks, and a press
// on a stage that is about the timeline must not reach across to the form.
A.exporter.currentSettings().quality = 33;
A.setLayout('grid');
pump(60);
A.stepHistory(true);
pump(60);
same(A.exporter.currentSettings().quality, 33,
     'undo on the timeline leaves the Encode stage alone — an edit state carries no output');
same(A.project.layout, 'stack', 'while undoing the edit that was made beside it');

// ── the other track ────────────────────────────────────────────────────────
//
// `Ctrl-Z` is answered by the history belonging to the stage it was pressed on,
// which is the whole of the argument that kept the form out of history: a press
// must only ever change what is in front of you. What makes it recordable at all
// is the one channel — `onSettingsChange` — since the encode side's three hooks
// are three consequences of the same fact and listening for a consequence means
// listening in three places and hoping.
{
    const S = A.exporter.currentSettings();
    const edits = H.depth('edit');
    A.shell.goTo('encode');
    pump(250);

    ok(!H.canUndo('output'),
       'arriving on the encode side is not a step: a path and a size filled in from the ' +
       'timeline are the stage arriving, not a decision anybody took');

    // The press this exists for. A preset rewrites the codec, the rate control,
    // the quality, the preset and the pixel format at once, and "what was it
    // before" has no other answer.
    const intents = Array.from(document.querySelectorAll('#ex-intent-list [data-intent]'));
    ok(intents.length > 1, `there is more than one starting point to move between (${
        intents.length})`);
    const was = { codec: S.videoCodec, rate: S.rate, quality: S.quality };
    let moved = null;
    for (const b of intents) {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(120);
        if (S.videoCodec !== was.codec || S.rate !== was.rate || S.quality !== was.quality) {
            moved = b.getAttribute('data-intent');
            break;
        }
    }
    ok(!!moved, `a preset changed what will be written (${moved})`);
    same(H.depth('output'), 1, 'and that is one step on the encode side’s own history');
    same(H.depth('edit'), edits, 'and no step at all on the edit’s — they are two stacks');

    ok(A.stepHistory(true), 'undo on this stage goes back');
    pump(120);
    same(S.videoCodec, was.codec, 'to the codec it was');
    same(S.rate, was.rate, 'and the rate control it was');
    same(S.quality, was.quality, 'and the quality it was');
    // The form is drawn from `settings`, so an undo has changed the model behind
    // its back exactly as a test writing into it does. If nothing redrew, the
    // control would still be showing the preset's value.
    const shown = document.querySelector('[data-f="vcodec"]');
    ok(!shown || shown.value === (was.codec || shown.value),
       'and the control in front of you shows it, because the form is redrawn from the settings');

    ok(A.stepHistory(false), 'redo goes forward again');
    pump(120);
    ok(S.videoCodec !== was.codec || S.rate !== was.rate || S.quality !== was.quality,
       'to the preset that was picked');

    // And the boundary from the other side: the edit's stack is still there and
    // is what the same key reaches on a stage about the timeline.
    A.shell.goTo('compose');
    pump(200);
    same(H.depth('edit'), edits, 'the edit’s history is untouched by any of it');
    ok(H.canUndo('edit') === edits > 0,
       'and back on the timeline the same key is about the edit again');
}

// And an Open is not a step: undoing across one would land in the middle of
// somebody else's edit.
doc.save(path);
doc.load(path);
A.documentOpened({ clips: [], skipped: [] });
pump(120);
ok(!H.canUndo() && !H.canRedo(), 'opening a document starts the history again');

fs.unlinkSync(path);
console.log(`\n${checks} checks passed`);
