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

ok(A.project.clips.length === 1, 'landscape clip loaded');
ok(A.transport.t === 0, 'initial playhead at 0');
ok(el('#tc-current').textContent === '00:00:00:00', 'initial timecode at 00:00:00:00');

click('#btn-play');
ok(A.transport.playing, 'click #btn-play starts playback');
pump(100);
ok(A.transport.t > 0, 'playback advances playhead');
click('#btn-play');
ok(!A.transport.playing, 'click #btn-play again pauses playback');

click('#btn-start');
pump(40);
ok(A.transport.t === 0, 'click #btn-start resets playhead to 0');
ok(el('#tc-current').textContent === '00:00:00:00', 'timecode reset to 00:00:00:00');

const tcBeforeNext = el('#tc-current').textContent;
const tBeforeNext = A.transport.t;
click('#btn-next');
click('#btn-next');
click('#btn-next');
pump(40);
ok(A.transport.t > tBeforeNext, 'click #btn-next advances playhead time');
ok(el('#tc-current').textContent !== tcBeforeNext, 'click #btn-next advances tc-current');

const tcBeforePrev = el('#tc-current').textContent;
const tBeforePrev = A.transport.t;
click('#btn-prev');
click('#btn-prev');
pump(40);
ok(A.transport.t < tBeforePrev, 'click #btn-prev decreases playhead time');
ok(el('#tc-current').textContent !== tcBeforePrev, 'click #btn-prev updates tc-current');

click('#btn-end');
pump(40);
ok(A.transport.t >= A.project.clips[0].length - 0.2, 'click #btn-end jumps near clip end');
ok(el('#tc-current').textContent !== '00:00:00:00', 'timecode reflects jump near clip end');

click('#btn-start');
pump(40);
ok(A.transport.t === 0, 'click #btn-start returns playhead to 0');
ok(el('#tc-current').textContent === '00:00:00:00', 'timecode returns to 00:00:00:00');

ok(!A.transport.loop, 'loop initially off');
ok(!el('#btn-loop').classList.contains('on'), '#btn-loop does not have .on class initially');
click('#btn-loop');
ok(A.transport.loop, 'click #btn-loop toggles loop to true');
ok(el('#btn-loop').classList.contains('on'), '#btn-loop has .on class');
click('#btn-loop');
ok(!A.transport.loop, 'click #btn-loop toggles loop to false');
ok(!el('#btn-loop').classList.contains('on'), '#btn-loop loses .on class');

const tBeforeScrub = A.transport.t;
const tcBeforeScrub = el('#tc-current').textContent;
drag('#scrub-track', { dx: 100, dy: 0 });
pump(60);
ok(A.transport.t > tBeforeScrub, 'drag #scrub-track updates playhead time');
ok(el('#tc-current').textContent !== tcBeforeScrub, 'drag #scrub-track updates tc-current');

ok(!A.transport.muted, 'transport initially unmuted');
ok(!el('#btn-mute').classList.contains('on'), '#btn-mute initially without .on class');
click('#btn-mute');
ok(A.transport.muted, 'click #btn-mute sets transport.muted to true');
ok(el('#btn-mute').classList.contains('on'), '#btn-mute gains .on class');
click('#btn-mute');
ok(!A.transport.muted, 'click #btn-mute toggles transport.muted back to false');
ok(!el('#btn-mute').classList.contains('on'), '#btn-mute loses .on class');

const volBefore = A.transport.volume;
drag('#vol-track', { dx: -20, dy: 0 });
pump(40);
ok(A.transport.volume !== volBefore, 'drag #vol-track changes volume');
ok(A.transport.volume < volBefore, 'drag #vol-track decreases volume');

ok(A.transport.rate === 1, 'initial rate is 1');
click('#rate');
pump(40);
pressKey(KEYS.DOWN);
pump(40);
pressKey(KEYS.RETURN);
pump(40);
ok(A.transport.rate === 1.5, 'playback rate updated to 1.5 via #rate');
ok(el('#rate').value === '1.5', '#rate select value updated to 1.5');

console.log('All ' + checks + ' checks PASS');
