import {
    pump,
    waitFor,
    el,
    click,
    type,
    drag,
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

const encodeBtn = el('#spine').querySelector('[data-stage="encode"]');
ok(encodeBtn !== null, 'found spine button for encode');
click(encodeBtn);
pump(60);

ok(A.shell.currentStage() === 'encode', 'active stage is encode');
const stageEncode = el('#st-encode');
ok(stageEncode !== null, 'found #st-encode element');
ok(!stageEncode.classList.contains('hidden'), '#st-encode is visible');

const intentList = el('#ex-intent-list');
ok(intentList !== null, 'found #ex-intent-list');
const intentButtons = intentList.querySelectorAll('button');
ok(intentButtons.length > 0, 'found intent preset buttons');
const chipIds = Array.from(intentButtons).map(b => b.getAttribute('data-intent'));
for (const id of chipIds) {
    const chip = intentList.querySelector('[data-intent="' + id + '"]');
    ok(chip !== null, 'found intent button for ' + id);
    click(chip);
    pump(40);
    const activeChip = intentList.querySelector('[data-intent="' + id + '"]');
    ok(activeChip.classList.contains('on') || id === 'master', 'intent preset selection updated for ' + id);
}

const handleIn = el('#ex-handle-in');
const handleOut = el('#ex-handle-out');
ok(handleIn !== null, 'found #ex-handle-in handle');
ok(handleOut !== null, 'found #ex-handle-out handle');

const rangeNums = el('#ex-range-nums');
ok(rangeNums !== null, 'found #ex-range-nums element');
const initialRangeNums = rangeNums.textContent;

drag('#ex-handle-in', { dx: 150, dy: 0 });
pump(40);
const afterInNums = rangeNums.textContent;
ok(afterInNums !== initialRangeNums, 'range numbers updated after dragging handle in');

drag('#ex-handle-out', { dx: -300, dy: 0 });
pump(40);
const afterOutNums = rangeNums.textContent;
ok(afterOutNums !== afterInNums, 'range numbers updated after dragging handle out');

const rangeAllBtn = el('#ex-range-all');
ok(rangeAllBtn !== null, 'found #ex-range-all button');
click('#ex-range-all');
pump(40);
ok(rangeNums.textContent === initialRangeNums, 'range reset to whole timeline after #ex-range-all click');

const writeBtn = el('#spine').querySelector('[data-stage="write"]');
ok(writeBtn !== null, 'found spine button for write');
click(writeBtn);
pump(60);

ok(A.shell.currentStage() === 'write', 'active stage is write');
const stageWrite = el('#st-write');
ok(stageWrite !== null, 'found #st-write element');
ok(!stageWrite.classList.contains('hidden'), '#st-write is visible');

const fs = require('fs');
if (!fs.existsSync('out')) {
    fs.mkdirSync('out');
}
const testOutPath = 'out/actuate-test.mp4';
if (fs.existsSync(testOutPath)) {
    try { fs.unlinkSync(testOutPath); } catch (e) {}
}

const destInput = el('#ex-dest').querySelector('input[data-f="path"]') || el('#ex-dest').querySelector('input');
ok(destInput !== null, 'found destination path input in #ex-dest');
click(destInput);
pump(20);
pressKey('a', MODS.CTRL);
pump(20);
pressKey(KEYS.BACKSPACE);
pump(20);
type(destInput, testOutPath, { blur: true });
pump(40);
ok(destInput.value.includes('actuate-test.mp4'), 'destination path input updated to ' + testOutPath);

const streamsContainer = el('#ex-streams');
ok(streamsContainer !== null, 'found #ex-streams element');
const initialStreams = streamsContainer.querySelectorAll('.ex-stream');
ok(initialStreams.length > 0, 'initial stream rows rendered in #ex-streams');

const addAudioBtn = streamsContainer.querySelector('[data-add="audio"]');
if (addAudioBtn) {
    click(addAudioBtn);
    pump(40);
    const countAfterAdd = streamsContainer.querySelectorAll('.ex-stream').length;
    ok(countAfterAdd === initialStreams.length + 1, 'stream added via + Audio button');
    const dropButtons = streamsContainer.querySelectorAll('[data-f="drop"]');
    const lastDrop = dropButtons[dropButtons.length - 1];
    ok(lastDrop !== null, 'found drop button on added stream');
    click(lastDrop);
    pump(40);
    ok(streamsContainer.querySelectorAll('.ex-stream').length === initialStreams.length, 'stream removed via drop button');
}

const detailBtn = streamsContainer.querySelector('[data-f="detail"]');
ok(detailBtn !== null, 'found stream detail toggle button');
click(detailBtn);
pump(40);
const openedDetail = streamsContainer.querySelector('.ex-stream-detail:not(.hidden)');
ok(openedDetail !== null, 'stream detail section opened');

const closeDetailBtn = streamsContainer.querySelector('[data-f="detail"]');
ok(closeDetailBtn !== null, 'found stream detail close button');
click(closeDetailBtn);
pump(40);
const closedDetail = streamsContainer.querySelector('.ex-stream-detail:not(.hidden)');
ok(closedDetail === null, 'stream detail section closed');

const goBtn = el('#ex-go');
ok(goBtn !== null, 'found #ex-go button');
ok(!goBtn.disabled, '#ex-go is enabled');
click('#ex-go');
pump(60);

const progEl = el('#ex-progress');
ok(progEl !== null && !progEl.classList.contains('hidden'), 'export initiates and #ex-progress is visible');
const pollState = bro.ffmpeg.render.poll().state;
ok(pollState === 'running' || pollState === 'done', 'render state is running or done (' + pollState + ')');

const stopBtn = progEl.querySelector('[data-f="stop"]');
if (stopBtn && bro.ffmpeg.render.poll().state === 'running') {
    click(stopBtn);
    pump(60);
    ok(bro.ffmpeg.render.poll().state === 'cancelled', 'render state cancelled via stop button');
}

const backBtn = progEl.querySelector('[data-f="back"]');
if (backBtn) {
    click(backBtn);
    pump(40);
    ok(!el('#ex-write').classList.contains('hidden'), 'returned to write form');
}

const cancelBtn = el('#ex-cancel');
ok(cancelBtn !== null, 'found #ex-cancel button');
click('#ex-cancel');
pump(60);
ok(A.shell.currentStage() === 'encode', '#ex-cancel navigated back to encode stage');

if (fs.existsSync(testOutPath)) {
    try { fs.unlinkSync(testOutPath); } catch (e) {}
}

console.log('All ' + checks + ' checks PASS');
