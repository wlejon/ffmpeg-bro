// Stress test and edge case test script for Capture Stage

const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(50);
    }
    console.log(`  (timed out waiting for ${what})`);
    return false;
}

let checks = 0;
const failures = [];

function ok(cond, what) {
    checks++;
    if (!cond) {
        console.log(`  FAIL: ${what}`);
        failures.push(`FAIL: ${what}`);
    } else {
        console.log(`  PASS: ${what}`);
    }
}

function same(a, b, what) {
    checks++;
    if (a !== b) {
        console.log(`  FAIL: ${what} (expected "${b}", got "${a}")`);
        failures.push(`FAIL: ${what} (expected "${b}", got "${a}")`);
    } else {
        console.log(`  PASS: ${what}`);
    }
}

waitFor('the app', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const cap = A.capture;

A.shell.goTo('capture');
pump(100);

console.log('====================================================');
console.log('TEST 1: Rapid activate and release cycle');
console.log('====================================================');

for (let cycle = 0; cycle < 5; cycle++) {
    cap.activate('lavfi');
    cap.activate('lavfi');
    pump(50); // don't wait for probes to finish
    cap.release(0);
    pump(50);
    cap.release(0);
    pump(50);
}
pump(200);
same(cap.capture.inputs.length, 0, 'All inputs cleaned up after rapid activate/release');


console.log('\n====================================================');
console.log('TEST 2: Out of bounds drag coordinates in setRegionFromDrag');
console.log('====================================================');

// Test gdigrab (which supports region)
cap.activate('gdigrab');
pump(200);

// Drag from -100, -100 to 300, 300 on a 500x500 shown preview
// Supposing real video size is 1920x1080
const gInput = cap.captureInputs()[0];
if (gInput) {
    // Manually mock clientWidth/clientHeight/videoWidth/videoHeight on mock card video element
    const card = q('[data-card="0"]');
    const fakeVideo = { clientWidth: 500, clientHeight: 500, videoWidth: 1920, videoHeight: 1080 };
    // Temporarily substitute video element for test
    const realCardVideo = cap.focused();
    
    // Call setRegionFromDrag with negative start coordinate
    cap.setRegionFromDrag({ x: -100, y: -100 }, { x: 300, y: 300 }, 0);
    pump(100);

    const opts = cap.captureInputs()[0].options;
    console.log('  Offset X:', opts.offset_x);
    console.log('  Offset Y:', opts.offset_y);
    console.log('  Video Size:', opts.video_size);

    // If offset_x is 0, the width should be from x=0 to x=300 in shown coords -> 300 * (1920/500) = 1152 real px
    // But due to Bug 3, Math.abs(300 - (-100)) = 400 shown px -> 400 * (1920/500) = 1536 real px!
    // Let's check what video_size was set to:
    const expectedW = Math.round(300 * (1920 / 500)) & ~1;
    const actualW = parseInt((opts.video_size || '').split('x')[0], 10);
    console.log(`  Actual width set: ${actualW}, expected if properly clamped: ${expectedW}`);
    ok(actualW <= Math.round(300 * (1920 / 500)) + 2, `BUG CHECK: Drag starting outside (x=-100) does not expand region width past release point (got ${actualW}, max expected ${expectedW})`);
}

cap.release(0);
pump(100);


console.log('\n====================================================');
console.log('TEST 3: Form Inputs & Malformed Values');
console.log('====================================================');

cap.activate('lavfi');
pump(200);

// 1. Invalid 'Stop after' value
const secs = q('[data-f="capseconds"][data-input="0"]');
if (secs) {
    secs.value = 'invalid_number';
    secs.dispatchEvent(new Event('change'));
    pump(100);
    same(cap.captureInputs()[0].to, 0, 'Invalid seconds input defaults to 0');

    secs.value = '-10';
    secs.dispatchEvent(new Event('change'));
    pump(100);
    console.log('  Negative seconds set:', cap.captureInputs()[0].to);
}

// 2. Empty or space path
const pathInput = q('[data-f="cappath"]');
if (pathInput) {
    pathInput.value = '   ';
    pathInput.dispatchEvent(new Event('change'));
    pump(100);
    same(cap.capture.path, '', 'Space-only path trimmed to empty string');
}

// 3. Changing format to unsupported muxer name
const fmt = q('[data-f="capformat"]');
if (fmt) {
    cap.capture.format = 'non_existent_muxer';
    cap.drawCapture();
    pump(100);
    console.log('  recordTarget with invalid format:', cap.recordTarget());
    ok(true, 'Invalid format handled gracefully without throw');
}

// Restore format
cap.capture.format = 'matroska';
cap.drawCapture();
pump(100);

cap.release(0);
pump(100);


console.log('\n====================================================');
console.log('TEST 4: Switching stage while device probe is active');
console.log('====================================================');

cap.activate('lavfi'); // Starts probe
A.shell.goTo('sources'); // Switch stage immediately
pump(200);
same(A.shell.currentStage(), 'sources', 'Navigated to sources stage');
A.shell.goTo('capture'); // Return to capture
pump(200);
same(A.shell.currentStage(), 'capture', 'Returned to capture stage');

// Cleanup
while (cap.capture.inputs.length > 0) cap.release(0);
pump(100);

console.log('\n====================================================');
console.log(`STRESS TEST COMPLETE. Executed ${checks} checks.`);
console.log(`FAILURES: ${failures.length}`);
if (failures.length > 0) {
    failures.forEach(f => console.log(`  * ${f}`));
}
console.log('====================================================');
