import {
    pump,
    waitFor,
    el,
    click,
    drag,
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

ok(A.project.clips.length === 1, 'landscape clip loaded');
const cropbox = el('#cropbox');
ok(cropbox.classList.contains('hidden'), '#cropbox initially hidden');

click('#btn-crop');
pump(40);
ok(!cropbox.classList.contains('hidden'), '#cropbox visible after #btn-crop clicked');
ok(el('#btn-crop').classList.contains('on'), '#btn-crop has .on class');

const clip = A.project.selected;
ok(clip !== null, 'clip is selected for cropping');

const cropBeforeNW = Object.assign({}, clip.xform.crop);
drag('.ch[data-h="nw"]', { dx: 30, dy: 20 });
pump(40);
ok(clip.xform.crop.l > cropBeforeNW.l, 'crop left increased after nw handle drag');
ok(clip.xform.crop.t > cropBeforeNW.t, 'crop top increased after nw handle drag');

const cropBeforeSE = Object.assign({}, clip.xform.crop);
drag('.ch[data-h="se"]', { dx: -30, dy: -20 });
pump(40);
ok(clip.xform.crop.r > cropBeforeSE.r, 'crop right increased after se handle drag');
ok(clip.xform.crop.b > cropBeforeSE.b, 'crop bottom increased after se handle drag');

const cropBeforeMove = Object.assign({}, clip.xform.crop);
drag('.ch[data-h="move"]', { dx: 10, dy: 10 });
pump(40);
ok(clip.xform.crop.l !== cropBeforeMove.l, 'crop left updated after move handle drag');
ok(clip.xform.crop.r !== cropBeforeMove.r, 'crop right updated after move handle drag');
ok(clip.xform.crop.t !== cropBeforeMove.t, 'crop top updated after move handle drag');
ok(clip.xform.crop.b !== cropBeforeMove.b, 'crop bottom updated after move handle drag');

click('#btn-crop');
pump(40);
ok(cropbox.classList.contains('hidden'), '#cropbox hidden after second #btn-crop click');
ok(!el('#btn-crop').classList.contains('on'), '#btn-crop lost .on class');

console.log('All ' + checks + ' checks PASS');
