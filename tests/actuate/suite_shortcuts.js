import {
    pump,
    waitFor,
    el,
    click,
    type,
    pressKey,
    KEYS,
    MODS,
    dropOn
} from './index.js';

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log((cond ? 'PASS: ' : 'FAIL: ') + what);
    globalThis.assert(cond, what);
}

waitFor('app ready', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
pump(60);

dropOn('#dropzone', ['build/fixtures/landscape.mp4']);
waitFor('clip loaded', () => A.project.clips.length > 0);
pump(60);

ok(A.project.clips.length === 1, 'initial clip count is 1');
ok(A.transport.playing === false, 'initial playing state is false');
ok(A.transport.muted === false, 'initial muted state is false');
ok(A.cropMode() === false, 'initial crop mode is false');
ok(A.timeline.currentEditMode() === 'select', 'initial timeline edit mode is select');

function assertNoGlobalShortcuts(stageName) {
    ok(A.transport.playing === false, stageName + ': space did not trigger play/pause');
    ok(A.transport.muted === false, stageName + ': m did not toggle mute');
    ok(A.project.clips.length === 1, stageName + ': s did not split clips');
    ok(A.cropMode() === false, stageName + ': c did not toggle crop mode');
    ok(A.timeline.currentEditMode() === 'select', stageName + ': v/b/y/x did not change timeline edit mode');
}

const sourcesBtn = el('#spine').querySelector('[data-stage="sources"]');
ok(sourcesBtn !== null, 'found spine button for sources');
click(sourcesBtn);
pump(40);
ok(A.shell.currentStage() === 'sources', 'active stage is sources');

const srcInput = el('#src-path');
ok(srcInput !== null, 'found #src-path input');
click(srcInput);
pump(20);
ok(document.activeElement === srcInput, '#src-path is focused');

type(srcInput, 'sample space m s c test');
pump(30);
ok(srcInput.value.includes('sample space m s c test'), '#src-path value contains typed text');
pressKey('v');
pump(10);
pressKey('b');
pump(10);
pressKey('y');
pump(10);
pressKey('x');
pump(10);
assertNoGlobalShortcuts('sources stage');

pressKey(KEYS.DELETE);
pump(10);
pressKey(KEYS.BACKSPACE);
pump(10);
ok(A.project.clips.length === 1, 'sources stage: delete/backspace did not delete clip');

const capBtn = el('#spine').querySelector('[data-stage="capture"]');
ok(capBtn !== null, 'found spine button for capture');
click(capBtn);
pump(40);
ok(A.shell.currentStage() === 'capture', 'active stage is capture');

const capInput = document.querySelector('[data-f="cappath"]') || document.querySelector('#st-capture input');
ok(capInput !== null, 'found text field on capture stage');
click(capInput);
pump(20);
ok(document.activeElement === capInput, 'capture input is focused');

type(capInput, 'capture space m s c v');
pump(30);
pressKey('b');
pump(10);
pressKey('y');
pump(10);
pressKey('x');
pump(10);
assertNoGlobalShortcuts('capture stage');

pressKey(KEYS.DELETE);
pump(10);
pressKey(KEYS.BACKSPACE);
pump(10);
ok(A.project.clips.length === 1, 'capture stage: delete/backspace did not delete clip');

const graphBtn = el('#spine').querySelector('[data-stage="graph"]');
ok(graphBtn !== null, 'found spine button for graph');
click(graphBtn);
pump(40);
ok(A.shell.currentStage() === 'graph', 'active stage is graph');

const grSearch = el('#gr-search');
ok(grSearch !== null, 'found #gr-search input');
click(grSearch);
pump(20);
ok(document.activeElement === grSearch, '#gr-search is focused');

const wiresBeforeGraph = A.graph.placement() ? A.graph.placement().wires.length : 0;
type(grSearch, 'crop v b m s space');
pump(30);
pressKey('y');
pump(10);
pressKey('x');
pump(10);
assertNoGlobalShortcuts('graph stage');

pressKey(KEYS.DELETE);
pump(10);
pressKey(KEYS.BACKSPACE);
pump(10);
ok(A.project.clips.length === 1, 'graph stage: delete/backspace did not delete clip');
const wiresAfterGraph = A.graph.placement() ? A.graph.placement().wires.length : 0;
ok(wiresAfterGraph === wiresBeforeGraph, 'graph stage: delete/backspace did not delete graph wires');

const writeBtn = el('#spine').querySelector('[data-stage="write"]');
ok(writeBtn !== null, 'found spine button for write');
click(writeBtn);
pump(40);
ok(A.shell.currentStage() === 'write', 'active stage is write');

const destInput = el('#ex-dest').querySelector('input[data-f="path"]') || el('#ex-dest').querySelector('input');
ok(destInput !== null, 'found destination path input on write stage');
click(destInput);
pump(20);
ok(document.activeElement === destInput, 'destination path input is focused');

type(destInput, 'my export space m s c v');
pump(30);
pressKey('b');
pump(10);
pressKey('y');
pump(10);
pressKey('x');
pump(10);
assertNoGlobalShortcuts('write stage');

pressKey(KEYS.DELETE);
pump(10);
pressKey(KEYS.BACKSPACE);
pump(10);
ok(A.project.clips.length === 1, 'write stage: delete/backspace did not delete clip');

const compBtn = el('#spine').querySelector('[data-stage="compose"]');
ok(compBtn !== null, 'found spine button for compose');
click(compBtn);
pump(40);
ok(A.shell.currentStage() === 'compose', 'active stage is compose');

const v1Lane = A.timeline.laneOf(0);
if (v1Lane && v1Lane.canvas) {
    click(v1Lane.canvas);
    pump(40);
}
const compInput = document.querySelector('#inspector input') || document.querySelector('#find input');
ok(compInput !== null, 'found input on compose stage');
if (compInput) {
    click(compInput);
    pump(20);
    ok(document.activeElement === compInput, 'compose input is focused');

    type(compInput, '10 space m s c v');
    pump(30);
    pressKey('b');
    pump(10);
    pressKey('y');
    pump(10);
    pressKey('x');
    pump(10);
    assertNoGlobalShortcuts('compose stage');

    pressKey(KEYS.DELETE);
    pump(10);
    pressKey(KEYS.BACKSPACE);
    pump(10);
    ok(A.project.clips.length === 1, 'compose stage: delete/backspace did not delete clip');
}

console.log('All ' + checks + ' checks PASS');
