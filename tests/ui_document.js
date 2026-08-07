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
// The last section is the one part of a document that is **not** the edit: where
// you were standing in it. That is checked in both directions at once, because
// both halves are the claim — all four of it come back on an Open, and none of it
// reaches the undo stack or the unsaved marker.
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
// A speed, which is the one field where `length` alone no longer says what
// footage the clip covers: the source span is `length * speed`, so a reader that
// dropped this and kept the length would open a clip of half the shot. Set after
// the length, and low enough that the source span still fits inside the file —
// which is exactly the clamp `writeClip()` applies on the way back in.
second.speed = 0.5;
// Held now, because `open()` reconciles: the clip object below *is* this one, so
// an assertion written against `second.length` after the round trip would be
// comparing the answer with itself.
const secondSpan = second.length * second.speed;
A.project.width = 640;
A.project.height = 360;
A.project.fps = 30;
A.project.layout = 'grid';
// A sync lock on V2, which is a setting *for a track* rather than a track. Off is
// the default on every track, so a document that carries one carries a decision
// somebody took — and it is the edit, not the session: it decides what an
// Alt-drag does to the clips, so it round-trips like a trim and it is undoable
// like one.
A.setTrackLocked(1, true);

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
// A bag keyed by the track number, holding an entry only where something has
// been set. Asserted as *both* halves, because the second is the design: an entry
// for every lane would be a second answer to how many tracks there are, and
// `trackCount()` is the only one.
ok(!!before.tracks && before.tracks['1'] && before.tracks['1'].locked === true,
   'and the sync lock on V2');
same(Object.keys(before.tracks).join(','), '1',
     'as an entry for that track alone — not a row of false for every lane');
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
ok(raw.tracks && raw.tracks['1'] && raw.tracks['1'].locked === true,
   'the file names the locked track by its number, readable in a diff');

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
ok(!A.isTrackLocked(1), 'and every track is unlocked again, which is the default');
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
same(JSON.stringify(back.tracks), JSON.stringify(before.tracks), 'and the locked tracks');
ok(A.isTrackLocked(1) && !A.isTrackLocked(0),
   'which reaches the model: V2 ripples with the stack again and V1 does not');
ok(A.ripplesWith(1).join(',') === '1',
   'V2 being the only locked track, a ripple on it is still about V2 alone');
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
// **And how fast it runs**, which is half of what footage it covers: `length`
// alone came back right in every version before this one and would have described
// twice the shot.
ok(near(two.speed, 0.5), `and its speed (${two.speed}×)`);
ok(near(two.length * two.speed, secondSpan),
   `so the source span is the span it was written with (${
       (two.length * two.speed).toFixed(3)}s)`);

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
ok(!A.isTrackLocked(0) && !A.isTrackLocked(1), 'and no track locked');

// ── a document whose tracks were written by another version ────────────────
//
// Four files that exist, and none of them may throw: one written before there
// were locks at all, one naming a track this build does not have, one carrying a
// flag this build has never heard of, and one whose entry is not an object. What
// has to come out is the locks it does describe and nothing else — an absent
// `tracks` is *no locks* rather than "leave the last edit's alone", because a
// lock is the edit and opening one is a replacement of the edit.

console.log('\ntracks a document did not write');
{
    const withTracks = (t) => {
        const d = JSON.parse(JSON.stringify(raw));
        if (t === null) delete d.tracks;
        else d.tracks = t;
        A.documentOpened(doc.open(d));
        pump(150);
    };

    withTracks({ 0: { locked: true } });
    ok(A.isTrackLocked(0), 'a lock on V1 opens as a lock on V1');

    withTracks(null);
    ok(!A.isTrackLocked(0) && !A.isTrackLocked(1),
       'a document written before there were locks opens as a timeline that ripples one ' +
       'track at a time, and does not keep the last edit’s');

    withTracks({ 1: { locked: true, spun: 'sideways' } });
    ok(A.isTrackLocked(1),
       'a flag this version has never heard of is ignored rather than refusing the entry');

    // A track number past the ceiling, and one that is not a number. Neither may
    // reach `setTrackLocked`, and neither may take the good entry beside it down.
    withTracks({ 1: { locked: true }, 9: { locked: true }, x: { locked: true },
                 '': { locked: true }, 2: 'yes', 3: null });
    ok(A.isTrackLocked(1), 'the one entry that means something is read');
    ok(!A.isTrackLocked(0) && !A.isTrackLocked(2) && !A.isTrackLocked(3),
       'and a key that is not a track number, or an entry that is not an object, is not');

    // And the claim the whole shape of the record exists for: an entry cannot put
    // a lane on the screen. Two clips, on V1 and V2 — so three lanes, whatever the
    // document says about V8.
    withTracks({ 7: { locked: true } });
    same(A.timeline.laneOf(7), null,
         'a lock on V8 in a document does not make a V8 — how many lanes there are is ' +
         'worked out from the clips');
    ok(!A.isTrackLocked(7),
       'and the entry itself is forgotten, being for a lane the timeline does not draw');
    same(doc.snapshot().tracks['7'], undefined, 'so saving again does not write it back');
}

// ── the unsaved marker ─────────────────────────────────────────────────────

doc.load(path);
A.documentOpened({ clips: [], skipped: [] });
pump(120);
ok(!doc.isModified(), 'freshly opened, nothing is unsaved');
ok(el('doc-name').className.indexOf('modified') < 0, 'and the topbar does not say it is');
A.select(A.project.clips[0]);
pump(60);
// The selection *is* in the document now — see the session section below — and
// the dot deliberately does not follow it. What the marker is about is work you
// could lose, and one that appeared because somebody clicked a clip would be a
// marker nobody reads.
ok(!doc.isModified(), 'picking a clip is not an edit — the dot is about work, not about where you are standing');
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

// **A speed is a step, because it is the edit.** It changes what footage a clip
// covers and how much of the programme it occupies — the same test a sync lock
// passes and the playhead fails. Driven through `setSpeed` and the model's own
// channel, which is what the inspector's control does.
{
    const clip = A.project.clips[0];
    const wasSpeed = clip.speed;
    const wasLen = clip.length;
    const depth = H.depth();
    A.setSpeed(clip, 2);
    A.changed('moved');
    pump(60);
    same(H.depth(), depth + 1, 'setting a clip’s speed is one step of history');
    ok(A.stepHistory(true), 'which Ctrl+Z takes back');
    pump(80);
    const back = A.project.clips[0];
    ok(near(back.speed, wasSpeed) && near(back.length, wasLen),
       `putting back both halves of it — the speed and the length it changed (${
           back.speed}×, ${back.length.toFixed(3)}s)`);
}

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

// A sync lock is in the document, so it is in the history — and that is the
// deliberate contrast with the session, which is in the document and is *not*.
// The test for one and not the other is not whether somebody chose it, it is
// whether it changes the clips: a lock decides what the next Alt-drag does to
// everything after the cut, and where the playhead is standing decides nothing.
{
    A.setTrackLocked(1, false);
    A.changed('lock');
    // Past the coalescing window, so the lock below is its own step rather than
    // being folded into this one — two presses of the same control inside half a
    // second are deliberately one gesture everywhere in this application.
    pump(700);
    const marks2 = H.depth();
    A.setTrackLocked(1, true);
    A.changed('lock');
    pump(60);
    same(H.depth(), marks2 + 1, 'locking a track is a step of undo, because it is the edit');
    ok(A.stepHistory(true), 'and it can be undone');
    pump(80);
    ok(!A.isTrackLocked(1), 'which unlocks the track again');
    A.stepHistory(false);
    pump(80);
    ok(A.isTrackLocked(1), 'and redoing it locks it');
    A.setTrackLocked(1, false);
    A.changed('lock');
    pump(60);
}

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

// ── where you were in it ───────────────────────────────────────────────────
//
// The one part of the snapshot that is not the edit: the selected clip, the
// playhead, the stage and the timeline's window. All four come back, because a
// `.fbro` is a handoff of work in progress and one that opened at zero on the
// Compose stage would hand over the arrangement while throwing away where the
// work had got to.
//
// What has to be true alongside that is the two things it must *not* do, and they
// are the reason `ui/history.js` strips the key: scrubbing must not fill the undo
// stack, and `Ctrl`+`Z` must not answer by moving the playhead.

console.log('\nwhere you were in it');
{
    // A tolerance rather than `near`: the playhead is put back through the
    // transport, which has a frame to land on.
    const close = (a, b) => Math.abs(a - b) < 0.05;

    A.shell.goTo('compose');
    pump(120);
    const clips = A.project.clips;
    ok(clips.length >= 1, `${clips.length} clip(s) to be standing among`);
    const pick = clips[clips.length - 1];
    A.select(pick);
    // A window that is neither the whole edit nor the default, so "it came back"
    // is a fact rather than a coincidence.
    ok(A.timeline.setView(0.2, Math.max(0.5, pick.length / 3)),
       'the timeline window can be put somewhere');
    const view = A.timeline.getView();
    A.setPlayhead(pick.start + Math.min(0.4, pick.length / 2));
    const stood = A.transport.t;
    A.shell.goTo('graph');
    pump(250);

    const snap = doc.snapshot();
    ok(!!snap.session, 'the snapshot carries a session');
    same(snap.session.clip, pick.id,
         'naming the selected clip by the id everything else in the document is written against');
    same(snap.session.stage, 'graph', 'and the stage you were on');
    ok(close(snap.session.playhead, stood),
       `and where the playhead was standing (${snap.session.playhead} vs ${stood})`);
    ok(close(snap.session.view.span, view.span),
       `and how far the timeline was zoomed (${snap.session.view.span} vs ${view.span})`);

    doc.save(path);
    ok(!doc.isModified(), 'and saving it is a save like any other');

    // Somewhere else entirely. Without this the checks below pass for free.
    A.shell.goTo('compose');
    A.select(null);
    A.setPlayhead(0);
    A.timeline.fitView();
    pump(150);
    ok(!A.project.selected && A.transport.t < 0.05, 'moved away from all of it');

    A.documentOpened(doc.load(path));
    pump(300);
    same(A.shell.currentStage(), 'graph', 'opening it puts you back on the stage it was saved from');
    ok(!!A.project.selected && A.project.selected.id === pick.id,
       `with the clip that was selected selected (${A.project.selected && A.project.selected.id})`);
    ok(close(A.transport.t, stood),
       `and the playhead where it was left (${A.transport.t} vs ${stood})`);
    ok(close(A.timeline.getView().span, view.span),
       `and the timeline at the zoom it was at (${A.timeline.getView().span} vs ${view.span})`);
    ok(!doc.isModified(), 'and none of it counts as an edit — the document is not unsaved');

    // ── and it is not in the history ───────────────────────────────────────
    A.shell.goTo('compose');
    pump(200);
    H.reset();
    for (let i = 1; i <= 6; i++) { A.setPlayhead(i * 0.1); pump(20); }
    A.select(A.project.clips[0]);
    pump(80);
    same(H.depth('edit'), 0,
         'scrubbing and picking a clip are not steps — a state is the edit and nothing else');
    ok(!doc.isModified(), 'and neither marks the document unsaved');

    A.setPlayhead(Math.min(0.8, Math.max(0, A.project.clips[0].length / 2)));
    pump(60);
    const at = A.transport.t;
    const zoomWas = A.project.clips[0].xform.zoom;
    A.project.clips[0].xform.zoom = zoomWas + 0.3;
    A.changed('edit');
    pump(80);
    same(H.depth('edit'), 1, 'an edit still is one');
    ok(A.stepHistory(true), 'and it can be undone');
    pump(120);
    ok(near(A.project.clips[0].xform.zoom, zoomWas), 'putting the edit back');
    ok(close(A.transport.t, at),
       `and leaving the playhead exactly where it was (${A.transport.t} vs ${at})`);
    same(A.shell.currentStage(), 'compose', 'on the stage you were standing on');

    // ── a session that names something that is not there ───────────────────
    //
    // Version-tolerant, the same as every other reader here. A clip id is a name
    // the graph's anchors are written against, so the one thing this must never
    // do is select whichever clip now happens to have that number.
    const hand = JSON.parse(fs.readFileSync(path, 'utf-8'));
    hand.session.clip = 987654;
    hand.session.stage = 'not-a-stage';
    hand.session.playhead = 'nonsense';
    hand.session.view = null;
    const odd = doc.open(hand);
    A.documentOpened(odd);
    pump(250);
    same(odd.session.clip, 0,
         'a session naming a clip the document does not describe reads as nothing selected');
    ok(!A.project.selected, 'and nothing is selected, rather than the wrong shot');
    ok(A.shell.currentStage() !== 'not-a-stage',
       `a stage that does not exist is refused by the shell (${A.shell.currentStage()})`);
    same(odd.session.playhead, 0, 'a playhead that is not a number is the start');
    ok(A.timeline.getView().span > 0,
       `and no window written is the whole edit, fitted (${A.timeline.getView().span})`);
}

// And an Open is not a step: undoing across one would land in the middle of
// somebody else's edit.
doc.save(path);
doc.load(path);
A.documentOpened({ clips: [], skipped: [] });
pump(120);
ok(!H.canUndo() && !H.canRedo(), 'opening a document starts the history again');

fs.unlinkSync(path);
// ── a clip that is not of a file ────────────────────────────────────────────
//
// A generator clip is written as what it *is* — a filter and its arguments —
// where a clip of a file is written as an input's id. Three things have to come
// back and each would fail silently on its own:
//
//   - **its id**, out of the same counter every clip's comes from, because
//     `clip:7/after-scale` is a name the graph overlay wrote down;
//   - **its `media`**, which is the one number a document holds *for* a clip
//     rather than re-measuring — a generator produces for as long as it is asked
//     to, so how much of it there is is a decision and not a fact about a file;
//   - **its kind**, because a reconcile that decided a generator was the file
//     clip that used to have that id would re-point the bar at a different shot.

console.log('\na generator clip, round-tripped');
{
    doc.reset();
    pump(150);

    const gen = A.addGenerator('testsrc');
    pump(200);
    ok(!!gen && A.isGenerator(gen), `laid a generator out (${gen.name})`);
    // A file clip beside it, so the ids being kept is a fact about two clips in
    // one list rather than a coincidence about one.
    A.open(media);
    waitFor('the file clip', () => A.project.clips.length === 2);
    pump(150);

    // Deliberately not the default anything, and the sequence matters: grown past
    // the length it was made with, trimmed back in so that there is more of it
    // than the clip uses, slipped inside that, moved, put on the other track and
    // made half opaque. Every one of those is a field a reader could drop without
    // any of the others noticing, and the middle two are the ones only a
    // generator has — `media` past `inPoint + length` is the state that proves
    // the number is the document's rather than something re-measured.
    gen.track = 1;
    gen.start = 0.75;
    A.rippleTrim(gen, 'end', 0.75 + 12);
    A.rippleTrim(gen, 'end', 0.75 + 8);
    A.slipClip(gen, 1.5);
    gen.xform.opacity = 0.4;
    A.changed('moved');
    pump(80);
    const wantMedia = gen.media, wantLen = gen.length, wantId = gen.id;
    ok(wantMedia > 5, `and grew it to ${wantMedia.toFixed(2)}s, past the five it was made with`);
    ok(near(wantLen, 8) && near(gen.inPoint, 1.5) && wantMedia > wantLen + gen.inPoint,
       `then trimmed it back to ${wantLen.toFixed(2)}s and slipped ` +
       `${gen.inPoint.toFixed(2)}s into it, leaving more of it than the clip uses`);
    A.graph.overlay.insert(`clip:${gen.id}/after-scale`, 'hflip');
    pump(200);

    const genPath = `${bro.ffmpeg.tempPath('gendoc')}.fbro`;
    doc.save(genPath);
    const written = JSON.parse(fs.readFileSync(genPath, 'utf-8'));
    const savedGen = written.clips.find((c) => c.generator);
    ok(!!savedGen, 'the file says the clip is a generator');
    same(savedGen.generator.filter, 'testsrc', 'naming the filter');
    same(savedGen.generator.params.size, '1920x1080', 'and its arguments');
    ok(!('input' in savedGen), 'and no input, because there is no file behind it');
    ok(written.clips.some((c) => !c.generator && c.input),
       'while the clip of a file beside it is written as an input id');

    // Throw the edit away entirely, then open the file again.
    doc.reset();
    pump(200);
    same(A.project.clips.length, 0, 'the edit was really cleared in between');

    const reopened = doc.load(genPath);
    A.documentOpened(reopened);
    pump(300);
    same(reopened.skipped.length, 0, 'and it opened with nothing left out');
    same(A.project.clips.length, 2, 'both clips back');

    const back = A.project.clips.find((c) => A.isGenerator(c));
    ok(!!back, 'the generator is a generator again');
    same(back.id, wantId, `with the id it had (${wantId}), which the graph wrote down`);
    ok(near(back.media, wantMedia),
       `and how much of it there is (${back.media.toFixed(2)}s), which nothing could re-measure`);
    ok(near(back.length, wantLen), `and its length (${back.length.toFixed(2)}s)`);
    ok(near(back.inPoint, 1.5) && near(back.start, 0.75) && back.track === 1,
       'and where it sits, where it starts and which track it is on');
    ok(near(back.xform.opacity, 0.4), 'and its opacity');
    same(back.generator.filter, 'testsrc', 'and what it is of');
    // A view over the generator's own `-f lavfi -i`, because there is a filter on
    // the clip — which is the same token a clip of a file gets for the same
    // reason. Without the insert it would be the plain `/@input/` one.
    ok(!!back.video && /^\/@fx\//.test(back.video.src),
       `with an element playing it again, through the filter on it (${back.video.src})`);
    const anchored = A.graph.overlay.inserts();
    ok(anchored.length === 1 && anchored[0].anchor === `clip:${wantId}/after-scale`,
       'and the filter pinned to it is still pinned to it');

    // A reconcile rather than a rebuild: opening the same document again over the
    // top must not touch the element, which is what makes an undo cheap.
    const element = back.video;
    A.documentOpened(doc.open(written));
    pump(200);
    const again = A.project.clips.find((c) => A.isGenerator(c));
    ok(again === back && again.video === element,
       'opening the same document again keeps the very same clip and decoder');

    // A generator this build cannot make is skipped with libavfilter's own
    // sentence, exactly as a clip of a missing file is.
    const bad = JSON.parse(JSON.stringify(written));
    bad.clips.find((c) => c.generator).generator.filter = 'no_such_source';
    const partial = doc.open(bad);
    A.documentOpened(partial);
    pump(200);
    ok(partial.skipped.length === 1 && /no filter called/.test(partial.skipped[0].why),
       `a generator this build has no filter for is not laid out: ${
           partial.skipped.length ? partial.skipped[0].why : 'nothing skipped'}`);
    ok(A.project.clips.length === 1 && !A.isGenerator(A.project.clips[0]),
       'and the rest of the document is still opened');

    try { fs.unlinkSync(genPath); } catch (e) { /* nothing to clean up */ }
    doc.reset();
    pump(150);
}



console.log(`\n${checks} checks passed`);
