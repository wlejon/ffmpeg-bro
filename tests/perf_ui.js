// What a seek costs through the whole application, rather than through the
// decoder alone.
//
// perf_test.cpp measures where the time in a seek goes — demux, decode,
// YUV→RGB. This measures the same seeks arriving the way a hand makes them:
// through the clip's <video>, with the app's frame loop, viewer and timeline
// all still running. The two numbers should be close, and when they are not,
// the difference is the application's.
//
// Usage: ffmpeg-bro-headless ui/ tests/perf_ui.js -- <media-file>

const media = (globalThis.scriptArgs || []).filter((a) => a !== '--')[0];
if (!media) throw new Error('usage: perf_ui.js -- <media-file>');

for (let i = 0; i < 80 && !globalThis.__ffmpegBroReady; i++) { wallSleep(20); flush(); }
const A = globalThis.__ffmpegBro;

dropFiles(400, 300, [media]);
for (let i = 0; i < 40; i++) { wallSleep(20); advanceTime(20); flush(); }

// The viewer builds a <video> per clip, so there is no one player element to
// ask for — the app hands over whichever one the playhead is inside.
const v = A.video();
if (!v) throw new Error('no clip loaded');
v.muted = true;
const D = v.duration;
console.log(`duration ${D.toFixed(2)} size ${v.videoWidth}x${v.videoHeight}`);

function timeIt(label, fn, n) {
    const t0 = Date.now();
    for (let i = 0; i < n; i++) fn(i);
    const dt = Date.now() - t0;
    console.log(`  ${label}: ${(dt / n).toFixed(2)} ms/op  (${n} ops)`);
}

// Every seek below stays strictly inside [0, duration).
v.currentTime = 0;
timeIt('scrub forward (+1% of duration)', (i) => { v.currentTime = (i / 100) * D; }, 40);
v.currentTime = D * 0.9;
timeIt('scrub backward (-1% of duration)', (i) => { v.currentTime = (0.9 - i / 100) * D; }, 40);
timeIt('seek random', (i) => { v.currentTime = ((i * 7919) % 997) / 997 * D * 0.95; }, 20);

// Through the app rather than by writing currentTime: setPlayhead is what a
// scrub actually calls, and it has a whole viewer and timeline behind it.
timeIt('setPlayhead (what a scrub calls)', (i) => { A.setPlayhead((i / 100) * D); }, 40);

v.currentTime = D * 0.2;
timeIt('frame step forward', () => A.step(1), 40);
timeIt('flush only', () => flush(), 100);
