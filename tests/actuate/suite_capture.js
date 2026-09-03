import {
    pump,
    waitFor,
    el,
    click,
    type,
    pressKey,
    KEYS,
    MODS
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

const captureBtn = el('#spine').querySelector('[data-stage="capture"]');
ok(captureBtn !== null, 'found spine button for capture');
click(captureBtn);
pump(60);

ok(A.shell.currentStage() === 'capture', 'active stage is capture');
const stageCapture = el('#st-capture');
ok(stageCapture !== null, 'found #st-capture section');
ok(!stageCapture.classList.contains('hidden'), '#st-capture is visible');

const capList = el('#cap-list');
ok(capList !== null, 'found #cap-list container');
const deviceItems = capList.querySelectorAll('[data-device]');
ok(deviceItems.length > 0, 'available capture devices listed in #cap-list');
const lavfiDevice = capList.querySelector('[data-device="lavfi"]');
ok(lavfiDevice !== null, 'found lavfi device in #cap-list');

click(lavfiDevice);
waitFor('input to appear in capture inputs', () => A.capture.capture.inputs.length > 0);
pump(200);

ok(A.capture.capture.inputs.length === 1, 'lavfi input activated');
const capCards = el('#cap-cards');
ok(capCards !== null, 'found #cap-cards container');
const activeCard = capCards.querySelector('.cap-card');
ok(activeCard !== null, 'found active card in #cap-cards');
ok(activeCard.classList.contains('on'), 'active card has .on class');

const cardPreview = activeCard.querySelector('[data-f="preview"]');
ok(cardPreview !== null, 'card contains preview element');
waitFor('preview video to decode frames', () => cardPreview.videoWidth > 0, 10000);
ok(cardPreview.videoWidth > 0, 'preview video is decoding frames');

const capPathInput = el('#cap-settings').querySelector('[data-f="cappath"]');
ok(capPathInput !== null, 'found output path field [data-f="cappath"] in #cap-settings');
const targetRecPath = `${bro.ffmpeg.tempPath('actuate_rec')}.mkv`;
click(capPathInput);
pump(20);
pressKey('a', MODS.CTRL);
pump(20);
pressKey(KEYS.BACKSPACE);
pump(20);
type(capPathInput, targetRecPath, { blur: true });
pump(40);
ok(A.capture.capture.path === targetRecPath, 'recording path updated in capture settings');

const optSearch = el('#cap-options').querySelector('[data-f="capoptsearch"]');
if (optSearch) {
    click(optSearch);
    pump(20);
    type(optSearch, 'rtbufsize');
    pump(60);
    const rtField = el('#cap-options').querySelector('[data-opt="rtbufsize"]');
    if (rtField) {
        click(rtField);
        pump(20);
        pressKey('a', MODS.CTRL);
        pump(20);
        pressKey(KEYS.BACKSPACE);
        pump(20);
        type(rtField, '5000000', { blur: true });
        pump(60);
        ok(A.inputs.byId(A.capture.capture.inputs[0]).options.rtbufsize === '5000000', 'rtbufsize option set in input options');
    }
}

const cardSeconds = activeCard.querySelector('[data-f="capseconds"]');
if (cardSeconds) {
    click(cardSeconds);
    pump(20);
    pressKey('a', MODS.CTRL);
    pump(20);
    pressKey(KEYS.BACKSPACE);
    pump(20);
    type(cardSeconds, '10', { blur: true });
    pump(40);
    ok(A.inputs.byId(A.capture.capture.inputs[0]).to === 10, 'stop after updated via card');
}

let listenBtn = el('#st-capture').querySelector('[data-f^="listen-"]');
if (!listenBtn) {
    const cardSrc = activeCard.querySelector('[data-f="capsource"]');
    click(cardSrc);
    pump(20);
    pressKey('a', MODS.CTRL);
    pump(20);
    pressKey(KEYS.BACKSPACE);
    pump(20);
    type(cardSrc, 'aevalsrc=0.5*sin(1000*2*PI*t):s=48000', { blur: true });
    waitFor('audio listen button to appear', () => !!el('#st-capture').querySelector('[data-f^="listen-"]'), 10000);
    listenBtn = el('#st-capture').querySelector('[data-f^="listen-"]');
}
ok(listenBtn !== null, 'found audio listen button [data-f^="listen-"]');
click(listenBtn);
pump(100);
ok(A.capture.monitoring() !== '', 'monitoring engaged on pad');
const activeListenBtn = el('#st-capture').querySelector('[data-f^="listen-"]');
ok(activeListenBtn !== null && activeListenBtn.classList.contains('on'), 'listen button has .on class');

click(activeListenBtn);
pump(100);
ok(A.capture.monitoring() === '', 'monitoring stopped on toggle click');

const cardSrcRestore = activeCard.querySelector('[data-f="capsource"]');
click(cardSrcRestore);
pump(20);
pressKey('a', MODS.CTRL);
pump(20);
pressKey(KEYS.BACKSPACE);
pump(20);
type(cardSrcRestore, 'testsrc=size=1280x720:rate=30', { blur: true });
pump(300);

waitFor('ready to record', () => A.capture.ready(), 10000);
const recBtn = el('#cap-bar').querySelector('[data-f="caprecord"]');
ok(recBtn !== null, 'found record button in #cap-bar');
waitFor('record button enabled', () => !recBtn.disabled, 10000);
ok(!recBtn.disabled, 'record button is enabled');

click(recBtn);
pump(200);
ok(A.capture.isRecording(), 'recording started via [data-f="caprecord"]');

const stopBtn = el('#cap-bar').querySelector('[data-f="capstop"]');
ok(stopBtn !== null, 'found stop button in #cap-bar while recording');
pump(200);

click(stopBtn);
waitFor('recording to stop', () => !A.capture.isRecording(), 10000);
ok(!A.capture.isRecording(), 'recording stopped via [data-f="capstop"]');
pump(100);

const capUseBtn = el('#cap-bar').querySelector('[data-f="capuse"]');
ok(capUseBtn !== null, 'recorded file listed with [data-f="capuse"] button');

const composeBtn = el('#spine').querySelector('[data-stage="compose"]');
ok(composeBtn !== null, 'found spine button for compose stage');
click(composeBtn);
pump(100);

ok(A.shell.currentStage() === 'compose', 'returned to compose stage');
ok(A.capture.sessionId() === 0, 'capture session closed cleanly on stage departure');
ok(A.capture.monitoring() === '', 'monitoring cleared on stage departure');
const detachedPreviews = el('#st-capture').querySelectorAll('[data-f="preview"]');
ok(detachedPreviews.length === 0, 'capture preview video elements torn down');

try {
    const fs = require('fs');
    if (targetRecPath && fs.existsSync(targetRecPath)) {
        fs.unlinkSync(targetRecPath);
    }
} catch (e) {}

console.log('All ' + checks + ' checks PASS');
