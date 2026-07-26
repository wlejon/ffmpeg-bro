const media = (globalThis.scriptArgs || []).filter(function(a) { return a !== '--'; })[0];
for (let i = 0; i < 80 && !globalThis.__ffmpegBroReady; i++) { wallSleep(20); flush(); }
dropFiles(400, 300, [media]);
for (let i = 0; i < 40; i++) { wallSleep(20); advanceTime(20); flush(); }
const v = document.getElementById('player');
v.muted = true;
const D = v.duration;
console.log('duration ' + D.toFixed(2) + ' size ' + v.videoWidth + 'x' + v.videoHeight);

function timeIt(label, fn, n) {
    const t0 = Date.now();
    for (let i = 0; i < n; i++) fn(i);
    const dt = Date.now() - t0;
    console.log('  ' + label + ': ' + (dt / n).toFixed(2) + ' ms/op  (' + n + ' ops)');
}

// Every seek below stays strictly inside [0, duration).
v.currentTime = 0;
timeIt('scrub forward (+1% of duration)', function (i) { v.currentTime = (i / 100) * D; }, 40);
v.currentTime = D * 0.9;
timeIt('scrub backward (-1% of duration)', function (i) { v.currentTime = (0.9 - i / 100) * D; }, 40);
timeIt('seek random', function (i) { v.currentTime = ((i * 7919) % 997) / 997 * D * 0.95; }, 20);
v.currentTime = D * 0.2;
timeIt('frame step forward', function () { v.currentTime = v.currentTime + 1 / 30; }, 40);
timeIt('flush only', function () { flush(); }, 100);
