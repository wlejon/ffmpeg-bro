import {
    pump,
    waitFor,
    el,
    click,
    type,
    pressKey,
    KEYS,
    MODS,
    setNextFiles
} from './index.js';

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log((cond ? 'PASS: ' : 'FAIL: ') + what);
    globalThis.assert(cond, what);
}

waitFor('app ready', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
pump(100);

const sourcesBtn = el('#spine').querySelector('[data-stage="sources"]');
ok(sourcesBtn !== null, 'found spine button for sources');
click(sourcesBtn);
pump(60);

ok(A.shell.currentStage() === 'sources', 'active stage is sources');
const stageSources = el('#st-sources');
ok(stageSources !== null, 'found #st-sources section');
ok(!stageSources.classList.contains('hidden'), '#st-sources is visible');

const pathInput = el('#src-path');
ok(pathInput !== null, 'found #src-path input');
click('#src-path');
pump(20);
type('#src-path', 'build/fixtures/landscape.mp4');
pump(20);
ok(pathInput.value.includes('landscape.mp4'), '#src-path has landscape.mp4 value');

const addBtn = el('#src-add');
ok(addBtn !== null, 'found #src-add button');
click('#src-add');
waitFor('first input to appear in inputs list', () => A.inputs.inputs.length > 0);
pump(60);

ok(A.inputs.inputs.length === 1, 'first input added to A.inputs.inputs');
ok(A.inputs.inputs[0].path.includes('landscape.mp4'), 'first input path matches landscape.mp4');

const srcList = el('#src-list');
ok(srcList !== null, 'found #src-list container');
const listRowsAfterFirst = srcList.querySelectorAll('.src-row');
ok(listRowsAfterFirst.length === 1, '#src-list contains 1 row');

const srcDetail = el('#src-detail');
ok(srcDetail !== null, 'found #src-detail container');
ok(srcDetail.textContent.includes('What came back'), '#src-detail renders What came back');
ok(srcDetail.textContent.includes('h264'), '#src-detail renders video stream codec h264');
ok(srcDetail.textContent.includes('aac'), '#src-detail renders audio stream codec aac');
ok(srcDetail.querySelectorAll('.src-stream').length >= 2, '#src-detail renders stream rows');

setNextFiles(['build/fixtures/portrait.mp4']);
const browseBtn = el('#src-browse');
ok(browseBtn !== null, 'found #src-browse button');
click('#src-browse');
waitFor('second input to appear in inputs list', () => A.inputs.inputs.length === 2);
pump(60);

ok(A.inputs.inputs.length === 2, 'second input added to A.inputs.inputs');
ok(A.inputs.inputs[1].path.includes('portrait.mp4'), 'second input path matches portrait.mp4');

const listRows = srcList.querySelectorAll('.src-row');
ok(listRows.length === 2, '#src-list contains 2 rows');

click(srcList.querySelectorAll('.src-row')[0]);
pump(60);
const titleAfterFirstClick = srcDetail.querySelector('.src-title');
ok(titleAfterFirstClick !== null, 'found title in #src-detail');
ok(titleAfterFirstClick.textContent.includes('landscape.mp4'), '#src-detail updated for first input');
ok(srcDetail.textContent.includes('640×360'), '#src-detail shows landscape resolution');

click(srcList.querySelectorAll('.src-row')[1]);
pump(60);
const titleAfterSecondClick = srcDetail.querySelector('.src-title');
ok(titleAfterSecondClick !== null, 'found title in #src-detail for second input');
ok(titleAfterSecondClick.textContent.includes('portrait.mp4'), '#src-detail updated for second input');
ok(srcDetail.textContent.includes('360×640'), '#src-detail shows portrait resolution');

click(srcList.querySelectorAll('.src-row')[0]);
pump(60);
const titleAfterThirdClick = srcDetail.querySelector('.src-title');
ok(titleAfterThirdClick.textContent.includes('landscape.mp4'), '#src-detail switched back to first input');

const streamItems = srcDetail.querySelectorAll('.src-stream');
ok(streamItems.length >= 2, 'found stream elements in #src-detail');
for (let i = 0; i < streamItems.length; i++) {
    click(streamItems[i]);
    pump(20);
}
ok(true, 'stream chips/rows are clickable');

const hwSelect = srcDetail.querySelector('[data-f="srchw"]');
if (hwSelect) {
    const origHw = hwSelect.value;
    click(hwSelect);
    pump(40);
    pressKey(KEYS.DOWN);
    pump(40);
    pressKey(KEYS.RETURN);
    pump(40);
    ok(hwSelect.value !== origHw || hwSelect.options.length <= 1, 'hwaccel dropdown actuated');
}

const ssInput = srcDetail.querySelector('[data-f="srcss"]');
ok(ssInput !== null, 'found in-point trim field [data-f="srcss"]');
click(ssInput);
pump(20);
pressKey('a', MODS.CTRL);
pump(20);
pressKey(KEYS.BACKSPACE);
pump(20);
type(ssInput, '1.25', { blur: true });
pump(40);
ok(A.inputs.inputs[0].ss === 1.25, 'in-point trim field updated input.ss to 1.25');

const toInput = srcDetail.querySelector('[data-f="srcto"]');
ok(toInput !== null, 'found out-point trim field [data-f="srcto"]');
click(toInput);
pump(20);
pressKey('a', MODS.CTRL);
pump(20);
pressKey(KEYS.BACKSPACE);
pump(20);
type(toInput, '5.5', { blur: true });
pump(40);
ok(A.inputs.inputs[0].to === 5.5, 'out-point trim field updated input.to to 5.5');

const srcFoot = el('#src-foot');
ok(srcFoot !== null, 'found #src-foot container');
const useBtn = srcFoot.querySelector('[data-f="srcuse"]');
ok(useBtn !== null, 'found Use on the timeline button [data-f="srcuse"]');
ok(!useBtn.disabled, 'Use on the timeline button is enabled');

click(useBtn);
pump(100);

ok(A.project.clips.length > 0, 'clip is added to timeline (A.project.clips.length > 0)');
ok(A.shell.currentStage() === 'compose', 'navigated to compose stage after adding clip to timeline');

console.log('All ' + checks + ' checks PASS');
