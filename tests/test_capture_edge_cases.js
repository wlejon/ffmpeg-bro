// Comprehensive UI test suite for Capture stage (st-capture)

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
const errorsFound = [];

function ok(cond, what) {
    checks++;
    if (!cond) {
        console.log(`  FAIL: ${what}`);
        errorsFound.push(`FAIL: ${what}`);
    } else {
        console.log(`  PASS: ${what}`);
    }
}

function same(a, b, what) {
    if (a !== b) {
        console.log(`  FAIL: ${what} (expected "${b}", got "${a}")`);
        errorsFound.push(`FAIL: ${what} (expected "${b}", got "${a}")`);
    } else {
        console.log(`  PASS: ${what}`);
    }
    checks++;
}

waitFor('the app', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const cap = A.capture;

console.log('====================================================');
console.log('SUITE 1: Stage Navigation & Initialization');
console.log('====================================================');

ok(A.shell.goTo('capture'), 'Navigate to capture stage');
pump(100);
ok(!q('#st-capture').classList.contains('hidden'), 'Capture stage is visible');

// Ensure starting with clean state
while (cap.capture.inputs.length > 0) cap.release(0);
pump(100);

console.log('\n====================================================');
console.log('SUITE 2: Card focus and release index alignment');
console.log('====================================================');

// Activate 3 devices
cap.activate('lavfi');
cap.activate('lavfi');
cap.activate('lavfi');
pump(300);

same(cap.capture.inputs.length, 3, 'Activated 3 lavfi devices');
const id0 = cap.captureInputs()[0].id;
const id1 = cap.captureInputs()[1].id;
const id2 = cap.captureInputs()[2].id;

// Focus on card index 1 (id1)
q('[data-card="1"]').dispatchEvent(new Event('mousedown', { bubbles: true }));
pump(50);
same(cap.focused().id, id1, 'Focus is set to card 1 (id1)');

// Now release card index 0 (id0)
cap.release(0);
pump(150);

same(cap.capture.inputs.length, 2, '2 cards remaining after releasing card 0');
// id1 is now at index 0 in captureInputs()
same(cap.captureInputs()[0].id, id1, 'id1 is now at index 0');
same(cap.captureInputs()[1].id, id2, 'id2 is now at index 1');

// Check if focused() still returns id1!
const currentFocusedId = cap.focused() ? cap.focused().id : null;
console.log(`  Focused ID after releasing card 0: ${currentFocusedId} (expected: ${id1})`);
same(currentFocusedId, id1, 'BUG CHECK: focus remains on id1 after removing preceding card 0');

// Clean up
while (cap.capture.inputs.length > 0) cap.release(0);
pump(100);


console.log('\n====================================================');
console.log('SUITE 3: Devices enumeration & source switching');
console.log('====================================================');

const devs = cap.devices();
ok(devs.length > 0, `Devices found: ${devs.map(d => d.name).join(', ')}`);

cap.activate('lavfi');
pump(200);

const srcInput = q('[data-f="capsource"][data-input="0"]');
ok(!!srcInput, 'Source input exists on card 0');

srcInput.value = 'testsrc=size=640x480:rate=15';
srcInput.dispatchEvent(new Event('change'));
pump(200);

same(cap.captureInputs()[0].path, 'testsrc=size=640x480:rate=15', 'Source path updated');

// Test hint button if available
const hintBtn = q('[data-f="caphint"]');
if (hintBtn) {
    hintBtn.click();
    pump(200);
    ok(cap.captureInputs()[0].path.length > 0, 'Hint button updated source path');
}

// Rescan button test
const rescanBtn = q('[data-f="caprescan"]');
if (rescanBtn) {
    rescanBtn.click();
    pump(100);
    ok(true, 'Rescan button clicked successfully without throwing');
}


console.log('\n====================================================');
console.log('SUITE 4: Options Column & Searching');
console.log('====================================================');

const searchField = q('[data-f="capoptsearch"]');
ok(!!searchField, 'Option search box exists');

searchField.value = 'graph';
searchField.dispatchEvent(new Event('input'));
pump(100);

const graphOpt = q('#cap-options [data-opt="graph"]');
ok(!!graphOpt, 'Option search found "graph" option');

// Clear search
searchField.value = '';
searchField.dispatchEvent(new Event('input'));
pump(100);

// Set option rtbufsize
searchField.value = 'rtbufsize';
searchField.dispatchEvent(new Event('input'));
pump(100);

const rtOpt = q('#cap-options [data-opt="rtbufsize"]');
if (rtOpt) {
    rtOpt.value = '32M';
    rtOpt.dispatchEvent(new Event('change'));
    pump(200);
    same(cap.captureInputs()[0].options.rtbufsize, '32M', 'rtbufsize option set on input');
}


console.log('\n====================================================');
console.log('SUITE 5: Region Drag & Reset');
console.log('====================================================');

// Perform setRegionFromDrag
const card0 = q('[data-card="0"]');
const picVideo = card0.querySelector('[data-f="preview"]');
if (picVideo && picVideo.videoWidth > 0) {
    const shownW = picVideo.clientWidth;
    const shownH = picVideo.clientHeight;
    const realW = picVideo.videoWidth;
    const realH = picVideo.videoHeight;
    console.log(`  Preview dimensions: shown ${shownW}x${shownH}, real ${realW}x${realH}`);

    // Drag box from (10, 10) to (110, 110) in shown pixels
    cap.setRegionFromDrag({ x: 10, y: 10 }, { x: 110, y: 110 }, 0);
    pump(200);

    const opts = cap.captureInputs()[0].options;
    ok(!!opts.video_size, `video_size set: ${opts.video_size}`);
    ok(opts.offset_x !== undefined, `offset_x set: ${opts.offset_x}`);
    ok(opts.offset_y !== undefined, `offset_y set: ${opts.offset_y}`);

    const resetBtn = q('[data-f="capwhole"]');
    ok(!!resetBtn, 'Region Reset button exists');
    if (resetBtn) {
        resetBtn.click();
        pump(200);
        same(cap.captureInputs()[0].options.video_size, undefined, 'video_size reset');
    }
} else {
    console.log('  (Skipping region drag tests: preview video not loaded yet)');
}


console.log('\n====================================================');
console.log('SUITE 6: Multi-input Graph validation');
console.log('====================================================');

// Add second input
cap.activate('lavfi');
pump(300);
same(cap.capture.inputs.length, 2, '2 inputs active');

same(cap.ready(), false, '2 inputs without graph -> cap.ready() is false');
ok(q('[data-f="caprecord"]').disabled, 'Record button disabled when graph is missing for 2 inputs');

// Build graph using overlay
const ov = A.graph.overlay;
ov.clear();
const a = ov.addSource(cap.capture.inputs[0]);
const b = ov.addSource(cap.capture.inputs[1]);
const hstack = ov.addNode('hstack', { params: { inputs: '2' } });
ov.wire(a.id, 0, hstack.id, 0);
ov.wire(b.id, 0, hstack.id, 1);
ov.wire(hstack.id, 0, 'out:v', 0);
pump(300);

const g = cap.graphOf();
ok(g && g.ok, 'Graph created and valid for 2 inputs');
same(cap.ready(), true, '2 inputs with graph -> cap.ready() is true');
ok(!q('[data-f="caprecord"]').disabled, 'Record button enabled');

// Check composite video element
const compVideo = q('[data-f="composite"]');
ok(!!compVideo, 'Composite video element rendered');

// Break graph (set inputs=3 when only 2 wired)
ov.edit({ id: hstack.id }, { params: { inputs: '3' } });
pump(200);

const gBreak = cap.graphOf();
ok(gBreak && !gBreak.ok, 'Broken graph recognized');
same(cap.ready(), false, 'Broken graph -> cap.ready() is false');
ok(q('[data-f="caprecord"]').disabled, 'Record button disabled for broken graph');

// Fix graph
ov.edit({ id: hstack.id }, { params: { inputs: '2' } });
pump(200);
same(cap.ready(), true, 'Fixed graph -> cap.ready() is true');


console.log('\n====================================================');
console.log('SUITE 7: Custom Output Pad Selection & Lost Pad handling');
console.log('====================================================');

// Add a custom output node to the graph
const customOut = ov.addOutput('v', 'custom_v');
ov.unwire('out:v', 0);
ov.wire(hstack.id, 0, customOut.id, 0);
pump(200);

const vpadSelect = q('[data-f="capvpad"]');
ok(!!vpadSelect, 'Picture pad selector (capvpad) appeared');

if (vpadSelect) {
    vpadSelect.value = customOut.id;
    vpadSelect.dispatchEvent(new Event('change'));
    pump(200);
    same(cap.capture.videoPad, customOut.id, 'videoPad set to custom output node');
}

// Remove the custom output node
ov.removeInsert(customOut.id);
pump(200);

same(cap.capture.videoPad, '', 'forgetLostPads() reset videoPad to empty string');
same(q('[data-f="capvpad"]'), null, 'capvpad selector hidden when no extra pads exist');

// Rewire graph back to default out:v
ov.wire(hstack.id, 0, 'out:v', 0);
pump(200);


console.log('\n====================================================');
console.log('SUITE 8: Tee Container & Clashing Paths');
console.log('====================================================');

const capFmt = q('[data-f="capformat"]');
capFmt.value = 'tee';
capFmt.dispatchEvent(new Event('change'));
pump(200);

same(cap.capture.format, 'tee', 'Container set to tee');
const dest0 = q('[data-f="capdest-path-0"]');
const dest1 = q('[data-f="capdest-path-1"]');

if (dest0 && dest1) {
    dest0.value = `${bro.appDir}/../out/test_clash.mkv`;
    dest0.dispatchEvent(new Event('change'));
    dest1.value = `${bro.appDir}/../out/test_clash.mkv`;
    dest1.dispatchEvent(new Event('change'));
    pump(200);

    ok(!!cap.clashingPath(), 'Clashing path detected between tee destinations');
    same(cap.ready(), false, 'Clashing path -> cap.ready() is false');

    dest1.value = `${bro.appDir}/../out/test_unique.mkv`;
    dest1.dispatchEvent(new Event('change'));
    pump(200);

    same(cap.clashingPath(), '', 'Clashing path cleared');
    same(cap.ready(), true, 'Ready again');
}

// Switch container back to matroska
capFmt.value = 'matroska';
capFmt.dispatchEvent(new Event('change'));
pump(200);


console.log('\n====================================================');
console.log('SUITE 9: Also-Write Files & Path Clashing');
console.log('====================================================');

// Clear also files if any
cap.capture.also = [];
pump(100);

// Open also section
const alsoSection = q('[data-f="capalso"]');
if (alsoSection) alsoSection.click();
pump(100);

const addAlso = q('[data-f="capalso-add"]');
if (addAlso) addAlso.click();
pump(200);

const alsoPath0 = q('[data-f="capalso-path-0"]');
if (alsoPath0) {
    const mainPath = q('[data-f="cappath"]').value;
    alsoPath0.value = mainPath; // Cause clash with main path
    alsoPath0.dispatchEvent(new Event('change'));
    pump(200);

    ok(!!cap.clashingPath(), 'Clash detected between main path and Also-write file');
    same(cap.ready(), false, 'Clashing also file -> cap.ready() is false');

    alsoPath0.value = `${bro.appDir}/../out/test_also_unique.mkv`;
    alsoPath0.dispatchEvent(new Event('change'));
    pump(200);

    same(cap.clashingPath(), '', 'Clash resolved for also file');
    same(cap.ready(), true, 'Ready again after fixing also path');
}

// Remove also file
const dropAlso0 = q('[data-f="capalso-drop-0"]');
if (dropAlso0) dropAlso0.click();
pump(200);
same(cap.alsoFiles().length, 0, 'Also file removed');


console.log('\n====================================================');
console.log('SUITE 10: Audio Monitoring (Listen)');
console.log('====================================================');

same(cap.monitoring(), '', 'Monitoring initially empty');

// Check live pads
const livePads = bro.ffmpeg.live.pads(cap.sessionId());
console.log(`  Live pads count: ${livePads.length} (${livePads.map(p => p.name).join(', ')})`);

const audioPad = livePads.find(p => p.sound);
if (audioPad) {
    const listenBtn = q(`[data-f="listen-${audioPad.name}"]`);
    ok(!!listenBtn, `Listen button exists for pad ${audioPad.name}`);
    if (listenBtn) {
        listenBtn.click();
        pump(200);
        same(cap.monitoring(), audioPad.name, `Monitoring pad ${audioPad.name}`);
        ok(listenBtn.classList.contains('on'), 'Listen button has class "on"');

        // Stop listening
        listenBtn.click();
        pump(200);
        same(cap.monitoring(), '', 'Monitoring stopped');
        ok(!listenBtn.classList.contains('on'), 'Listen button class "on" removed');
    }
} else {
    console.log('  (No sound pads in current live session, lavfi video-only)');
}


console.log('\n====================================================');
console.log('SUITE 11: Recording execution & Add to timeline');
console.log('====================================================');

// Set limit on card 0
const secsInput = q('[data-f="capseconds"][data-input="0"]');
if (secsInput) {
    secsInput.value = '2';
    secsInput.dispatchEvent(new Event('change'));
    pump(200);
}

const outPath = `${bro.appDir}/../out/test_suite_rec.mkv`;
const mainPathInput = q('[data-f="cappath"]');
mainPathInput.value = outPath;
mainPathInput.dispatchEvent(new Event('change'));
pump(200);

same(cap.ready(), true, 'Ready to record');

const recBtn = q('[data-f="caprecord"]');
ok(!!recBtn, 'Record button exists');
recBtn.click();
pump(300);

ok(cap.isRecording(), 'Recording started');

ok(waitFor('recording to complete', () => !cap.isRecording(), 30000), 'Recording finished');
pump(300);

const recProbe = bro.ffmpeg.probe(outPath);
ok(!!recProbe.video, 'Recorded file probed successfully with video stream');

const useBtn = q('[data-f="capuse"]');
ok(!!useBtn, '"Add to timeline" button exists after recording');

if (useBtn) {
    useBtn.click();
    pump(400);
    same(A.shell.currentStage(), 'compose', 'Clicking "Add to timeline" navigated to compose stage');
    ok(A.project.clips.some(c => c.inputPath && c.inputPath.indexOf('test_suite_rec.mkv') >= 0), 'Clip added to timeline');
}

// Navigate back to capture
A.shell.goTo('capture');
pump(200);


console.log('\n====================================================');
console.log('SUITE 12: Robustness & Error handling');
console.log('====================================================');

// 1. Calling stopRecording when not recording
cap.stopRecording();
ok(true, 'stopRecording() when not recording does not throw');

// 2. Calling startRecording when not ready
while (cap.capture.inputs.length > 0) cap.release(0);
pump(100);
cap.startRecording();
same(cap.isRecording(), false, 'startRecording() when not ready does not start recording');

// 3. Calling release on invalid index
cap.release(999);
ok(true, 'release(999) does not throw');

// 4. Calling setSource with null
cap.setSource('testsrc', null);
ok(true, 'setSource with null input does not throw');

// 5. Calling setRegionFromDrag with invalid index
cap.setRegionFromDrag({ x: 0, y: 0 }, { x: 100, y: 100 }, 999);
ok(true, 'setRegionFromDrag(..., 999) does not throw');

console.log('\n====================================================');
console.log(`TEST SUMMARY: ${checks} checks executed.`);
console.log(`ERRORS FOUND: ${errorsFound.length}`);
if (errorsFound.length > 0) {
    errorsFound.forEach(e => console.log(`  * ${e}`));
}
console.log('====================================================');
