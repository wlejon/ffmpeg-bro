import {
    pump,
    waitFor,
    el,
    click,
    drag,
    pressKey,
    KEYS,
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
pump(100);

dropOn('#dropzone', ['build/fixtures/landscape.mp4']);
waitFor('clip loaded', () => A.project.clips.length > 0);
pump(100);

ok(A.project.clips.length === 1, 'initial clip loaded');
const v1Entry = A.timeline.laneOf(0);
ok(v1Entry !== null, 'V1 lane entry found');
const v1Lane = v1Entry.lane;
ok(v1Lane !== null, 'V1 lane element rendered');

const selectModeBtn = el('[data-edit-mode="select"]');
const rippleModeBtn = el('[data-edit-mode="ripple"]');
const slipModeBtn = el('[data-edit-mode="slip"]');
const rateModeBtn = el('[data-edit-mode="rate"]');

ok(selectModeBtn.classList.contains('on'), 'select mode has .on initially');
ok(!rippleModeBtn.classList.contains('on'), 'ripple mode does not have .on initially');

click(rippleModeBtn);
pump(40);
ok(rippleModeBtn.classList.contains('on'), 'ripple mode has .on after click');
ok(!selectModeBtn.classList.contains('on'), 'select mode lost .on');
ok(!slipModeBtn.classList.contains('on'), 'slip mode does not have .on');
ok(!rateModeBtn.classList.contains('on'), 'rate mode does not have .on');

click(slipModeBtn);
pump(40);
ok(slipModeBtn.classList.contains('on'), 'slip mode has .on after click');
ok(!rippleModeBtn.classList.contains('on'), 'ripple mode lost .on');

click(rateModeBtn);
pump(40);
ok(rateModeBtn.classList.contains('on'), 'rate mode has .on after click');
ok(!slipModeBtn.classList.contains('on'), 'slip mode lost .on');

click(selectModeBtn);
pump(40);
ok(selectModeBtn.classList.contains('on'), 'select mode restored to .on');
ok(!rateModeBtn.classList.contains('on'), 'rate mode lost .on');

A.project.selected = null;
A.project.selection = [];
ok(A.project.selected === null, 'selection cleared for testing clip selection');

const clipEl = document.querySelector('#tracks .clip') || document.querySelector('.track-lane .clip') || v1Entry.canvas;
click(clipEl);
pump(40);
ok(A.project.selected !== null, 'clip selected in A.project.selected');
ok(A.project.selected === A.project.clips[0], 'selected clip matches project clip');

const clip = A.project.clips[0];
const laneRect = v1Lane.getBoundingClientRect();
const midY = laneRect.y + laneRect.height / 2;

const startBeforeDrag = clip.start;
const midX = laneRect.x + (A.timeline.timeToX(clip.start) + A.timeline.timeToX(clip.start + clip.length)) / 2;
drag({ x: midX, y: midY }, { dx: 40, dy: 0 });
pump(60);
ok(clip.start > startBeforeDrag, 'clip.start increased after drag to the right');

click('#btn-zoom-fit');
pump(40);

const lenBeforeTrim = clip.length;
const edgeX = laneRect.x + A.timeline.timeToX(clip.start + clip.length);
drag({ x: edgeX - 1, y: midY }, { dx: -80, dy: 0 });
pump(60);
ok(clip.length < lenBeforeTrim, 'clip length decreased after trim inward');

const splitTime = clip.start + clip.length / 2;
click(v1Entry.canvas, { x: A.timeline.timeToX(splitTime) });
pump(40);
ok(A.project.selected === clip, 'clip selected at split playhead');
click('#btn-split');
pump(40);
ok(A.project.clips.length === 2, 'split divided clip into two clips');

const initialSpan = A.timeline.getView().span;
click('#btn-zoom-in');
pump(40);
const spanZoomIn = A.timeline.getView().span;
ok(spanZoomIn < initialSpan, 'view span shrinks on #btn-zoom-in');

click('#btn-zoom-out');
pump(40);
const spanZoomOut = A.timeline.getView().span;
ok(spanZoomOut > spanZoomIn, 'view span grows on #btn-zoom-out');

click('#btn-zoom-fit');
pump(40);
const spanZoomFit = A.timeline.getView().span;
ok(spanZoomFit > 0, 'view fits timeline on #btn-zoom-fit');

const clip1 = A.project.clips[1];
const clip1MidX = A.timeline.timeToX(clip1.start + clip1.length / 2);
click(v1Entry.canvas, { x: clip1MidX });
pump(40);
ok(A.project.selected === clip1, 'second clip selected');

pressKey(KEYS.DELETE);
pump(60);
ok(A.project.clips.length === 1, 'clip count decreased from 2 back to 1 via DELETE key');

console.log('All ' + checks + ' checks PASS');
