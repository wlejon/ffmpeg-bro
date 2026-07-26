// Drive the real UI the way a person does: drop a file on it, press play,
// scrub, and check what the DOM says afterwards.
//
// Video runs on the REAL clock — advanceTime() moves bro's virtual time and
// the decoder ignores it — so every wait here is wallSleep() plus a flush to
// pump media events and present a frame.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_player.js -- <media-file>

const media = (globalThis.scriptArgs || []).filter((a) => a !== '--')[0];
assert(media, 'pass a media file: ... tests/ui_player.js -- <file>');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const el = (id) => document.getElementById(id);
let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

// ── the host bindings are really there ─────────────────────────────────────

console.log('\nbindings');
ok(!!globalThis.bro && !!bro.ffmpeg, 'bro.ffmpeg exists');
ok(bro.ffmpeg.available && bro.ffmpeg.linked, 'reports linked + available');
ok(typeof bro.ffmpeg.version === 'string' && bro.ffmpeg.version.length > 0,
   `version: ${bro.ffmpeg.version}`);
ok(Array.isArray(bro.ffmpeg.hwaccels), `hwaccels: ${bro.ffmpeg.hwaccels.join(' ') || 'none'}`);

console.log('\nprobe');
const p = bro.ffmpeg.probe(media);
ok(p.format.duration > 0, `duration ${p.format.duration.toFixed(3)}s`);
ok(p.streams.length > 0, `${p.streams.length} streams`);
ok(!!p.video, p.video ? `video ${p.video.codec} ${p.video.width}x${p.video.height} ` +
                        `${p.video.fps.toFixed(3)}fps ${p.video.pixFmt}` : 'no video stream');
if (p.audio) console.log(`        audio ${p.audio.codec} ${p.audio.channels}ch ${p.audio.sampleRate}Hz`);

// probe must reject a non-media file rather than returning junk.
let threw = false;
try { bro.ffmpeg.probe(bro.appDir + '/index.html'); } catch (e) { threw = true; }
ok(threw, 'probe throws on a file that is not media');

// ── the app boots ──────────────────────────────────────────────────────────

console.log('\nui');
waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
ok(!!el('player'), 'player element present');
ok(el('dropzone').className.indexOf('hidden') < 0, 'dropzone visible before a file');

// ── dropping a file loads it ───────────────────────────────────────────────

dropFiles(400, 300, [media]);
waitFor('the file to load', () => el('player').className.indexOf('loaded') >= 0);
const video = el('player');

ok(el('dropzone').className.indexOf('hidden') >= 0, 'dropzone hidden after drop');
ok(video.videoWidth > 0 && video.videoHeight > 0,
   `frame size ${video.videoWidth}x${video.videoHeight}`);
ok(Math.abs(video.duration - p.format.duration) < 0.5,
   `element duration ${video.duration.toFixed(3)}s matches the container`);
ok(el('mediainfo').textContent.indexOf('Container') >= 0, 'inspector filled in');
ok(el('chips').textContent.length > 0, `chips: ${el('chips').textContent.replace(/\s+/g, ' ').trim()}`);
ok(el('tc-duration').textContent !== '00:00:00:00',
   `duration timecode ${el('tc-duration').textContent}`);

screenshot('out/01-loaded.png');

// ── playback actually advances ─────────────────────────────────────────────

console.log('\nplayback');
video.muted = true;         // no audio device in headless
const before = video.currentTime;
video.play();
pump(700);
const after = video.currentTime;
ok(after > before, `currentTime advanced ${before.toFixed(3)} → ${after.toFixed(3)}`);
ok(!video.paused, 'element reports playing');
ok(el('scrub-played').style.width !== '0%', `scrubber moved (${el('scrub-played').style.width})`);
ok(el('tc-current').textContent !== '00:00:00:00',
   `timecode running: ${el('tc-current').textContent}`);

screenshot('out/02-playing.png');

video.pause();
pump(60);
const paused = video.currentTime;
pump(300);
ok(Math.abs(video.currentTime - paused) < 0.02, 'paused clock holds still');

// ── seeking lands where asked ──────────────────────────────────────────────

console.log('\nseek');
const target = video.duration * 0.6;
video.currentTime = target;
pump(120);
ok(Math.abs(video.currentTime - target) < 1.0,
   `seek to ${target.toFixed(3)}s landed at ${video.currentTime.toFixed(3)}s`);
screenshot('out/03-seeked.png');

video.currentTime = 0;
pump(120);
ok(video.currentTime < 0.5, `seek back to 0 landed at ${video.currentTime.toFixed(3)}s`);

// ── frame stepping moves by pictures, both ways ────────────────────────────
// The bug: the buttons used to do currentTime += 1/fps, and a back step landed
// on the frame it started from, so nothing happened.

console.log('\nframe step');
video.currentTime = video.duration * 0.4;
pump(60);
const stepOrigin = video.currentTime;

el('btn-next').click();
pump(60);
const stepped = video.currentTime;
ok(stepped > stepOrigin,
   `next frame advanced ${stepOrigin.toFixed(4)} → ${stepped.toFixed(4)}s`);
ok(stepped - stepOrigin < 0.2,
   `and it moved one frame, not a chunk of time (${(stepped - stepOrigin).toFixed(4)}s)`);

el('btn-prev').click();
pump(60);
ok(Math.abs(video.currentTime - stepOrigin) < 0.0005,
   `previous frame came back to ${stepOrigin.toFixed(4)}s (${video.currentTime.toFixed(4)}s)`);

let walk = video.currentTime;
let movedBack = 0;
for (let i = 0; i < 4; i++) {
    el('btn-prev').click();
    pump(30);
    if (video.currentTime < walk) movedBack++;
    walk = video.currentTime;
}
ok(movedBack === 4, `four back steps each moved (${movedBack})`);
screenshot('out/04-stepped.png');

// ── the timeline shows what is in the file ─────────────────────────────────
// Two lanes: V1 draws a filmstrip, A1 draws the waveform. Both come from
// bro.media in a worker, so this waits for them rather than assuming.

console.log('\ntimeline');
const film = el('film'), wave = el('wave');
const litFraction = (canvas) => {
    if (!canvas.width || !canvas.height) return 0;
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return lit / (d.length / 4);
};
waitFor('the worker to draw the lanes',
        () => litFraction(film) > 0.5 && (!p.audio || litFraction(wave) > 0.02), 20000);
ok(film.width > 100, `filmstrip canvas sized ${film.width}x${film.height}`);
ok(litFraction(film) > 0.5, `filmstrip has picture (${(litFraction(film) * 100).toFixed(0)}% lit)`);
ok(el('lane-video').className.indexOf('loaded') >= 0, 'V1 lane marked loaded');
if (p.audio) {
    ok(litFraction(wave) > 0.02 && litFraction(wave) < 0.9,
       `waveform drawn, not a solid block (${(litFraction(wave) * 100).toFixed(0)}% lit)`);
    ok(el('lane-audio').className.indexOf('loaded') >= 0, 'A1 lane marked loaded');
} else {
    // A file with no audio must SAY so, not leave an empty lane looking broken.
    ok(litFraction(wave) < 0.01, 'no waveform drawn for a file with no audio');
    ok(el('audio-label').textContent.indexOf('no audio') >= 0,
       `A1 lane says why it is empty: "${el('audio-label').textContent}"`);
}
screenshot('out/05-timeline.png');

// ── controls are wired ─────────────────────────────────────────────────────

console.log('\ncontrols');
el('btn-play').click();
pump(120);
ok(!video.paused, 'play button starts playback');
el('btn-play').click();
pump(60);
ok(video.paused, 'play button pauses again');

el('btn-loop').click();
pump(20);
ok(video.loop === true, 'loop button arms looping');
el('btn-loop').click();
pump(20);
ok(video.loop === false, 'loop button disarms looping');

video.muted = false;
el('btn-mute').click();
pump(20);
ok(video.muted === true, 'mute button mutes');
ok(el('vol-fill').style.width === '0.0%', 'volume meter reads zero when muted');
el('btn-mute').click();
pump(20);
ok(video.muted === false, 'mute button unmutes');

el('btn-start').click();
pump(80);
ok(video.currentTime < 0.5, 'go-to-start rewinds');

const rate = el('rate');
rate.value = '2';
rate.dispatchEvent(new Event('change'));
pump(20);
ok(video.playbackRate === 2, 'speed selector sets playbackRate');
rate.value = '1';
rate.dispatchEvent(new Event('change'));
pump(20);

// ── fullscreen strips the chrome ───────────────────────────────────────────

console.log('\nfullscreen');
el('btn-full').click();
pump(80);
ok(document.body.className.indexOf('fs') >= 0, 'body enters fullscreen mode');
flush();
screenshot('out/06-fullscreen.png');
el('btn-full').click();
pump(80);
ok(document.body.className.indexOf('fs') < 0, 'fullscreen toggles back off');

console.log(`\n${checks} checks passed`);
