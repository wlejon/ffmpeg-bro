// The Capture stage, driven the way a person drives it: pick a device, look at
// what it can see, set one of its options, watch the command bar say what is
// about to run, record, and stop.
//
// **The vehicle is `lavfi`**, libavfilter's *input device* — `-f lavfi -i
// testsrc=size=…` — because CI has no camera and lavfi is openable anywhere.
// It is a device in exactly the way gdigrab is: registered by
// `avdevice_register_all()`, opened by a forced `-f`, reporting no duration and
// never ending. It is **not** the same mechanism as a source filter on the
// Graph stage, which chunk 8 will add: `color` and `testsrc` as *filters* are
// nodes inside a filtergraph, and the lavfi *device* wraps a whole graph up as
// a demuxer so libavformat can read it as an `-i`. Two different places in the
// pipeline that spell things almost identically.
//
// The machine's real devices are asked about too, and whatever the answer is,
// it is asserted rather than skipped — a test that quietly passed because it
// found no camera would be worse than no test.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_capture.js

const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(50);
    }
    console.log(`  (timed out waiting for ${what})`);
    return false;
}

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}
function same(a, b, what) {
    if (a !== b) console.log(`    expected: ${b}\n    actual:   ${a}`);
    ok(a === b, what);
}
const text = (sel) => (q(sel) || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim();

waitFor('the app', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const cap = A.capture;

console.log('\nthe stage');
{
    ok(A.shell.stages()[0] === 'capture',
       'Capture is first on the spine — it is where an input comes from when there is not one');
    ok(A.shell.goTo('capture'), 'and it opens with nothing loaded, because it needs nothing');
    pump(100);
    ok(!q('#st-capture').classList.contains('hidden'), 'the stage is up');
}

console.log('\nthe devices, out of libavdevice');
{
    const list = cap.devices();
    ok(list.length > 0, `there are devices, because avdevice_register_all() ran (${
        list.map((d) => d.name).join(' ')})`);
    ok(list.some((d) => d.name === 'lavfi'), 'lavfi is one of them');
    // Registered once for video and once for audio, and it is one device.
    same(list.filter((d) => d.name === 'lavfi').length, 1,
         'a device registered for both kinds is one entry, not two');
    ok(qa('[data-device]').length === list.length, 'each has a button');
}

console.log('\nchoosing one');
{
    q('[data-device="lavfi"]').click();
    pump(300);
    same(cap.capture.device, 'lavfi', 'the device is chosen');
    ok(cap.capture.source.indexOf('testsrc') === 0,
       `and it starts from something openable (${cap.capture.source})`);
    ok(text('#cap-list').indexOf('does not list its sources') >= 0,
       'a device with nothing to enumerate says so rather than showing an empty list');

    // The one refusal that is about the seam between this binary and the
    // engine rather than about the device.
    ok(text('#cap-note').indexOf('decoded frames rather than packets') >= 0,
       `lavfi cannot be previewed, and the reason is stated: ${text('#cap-note')}`);
    ok(!q('[data-f="preview"]'), 'so there is no video element pretending otherwise');
}

console.log('\nits options are its demuxer’s');
{
    const all = bro.ffmpeg.demuxerOptions('lavfi').map((o) => o.name);
    ok(all.indexOf('graph') >= 0 && all.indexOf('rtbufsize') >= 0,
       'the column is lavfi’s own table plus libavformat’s generic one');
    ok(text('#cap-options').indexOf('lavfi options') >= 0,
       `and the column says whose it is: ${text('#cap-options').slice(0, 40)}`);

    const search = q('[data-f="capoptsearch"]');
    search.value = 'rtbufsize';
    search.dispatchEvent(new Event('input'));
    pump(80);
    const field = q('#cap-options [data-opt="rtbufsize"]');
    ok(!!field, 'searching finds one');
    field.value = '64M';
    field.dispatchEvent(new Event('change'));
    pump(150);
    same(cap.capture.options.rtbufsize, '64M', 'and it lands in the device’s option bag');
}

console.log('\nthe command it is');
{
    const line = A.command.currentCommand();
    console.log(`  ${line}`);
    ok(line.indexOf('-f lavfi') >= 0, 'the device is the demuxer, named with -f');
    ok(line.indexOf('-rtbufsize 64M') < line.indexOf('-i '),
       'and its options are in front of the -i, where input options go');
    ok(line.indexOf('-i testsrc') >= 0, 'the source is what -i is handed');
    // The bar is describing the capture rather than the render, which is the
    // point of it being a stage: the timeline's render is a different file.
    ok(line.indexOf('-filter_complex') < 0,
       'and there is no filtergraph in it — a capture composites nothing');

    const seconds = q('[data-f="capseconds"]');
    seconds.value = '2';
    seconds.dispatchEvent(new Event('change'));
    pump(120);
    const withT = A.command.currentCommand();
    ok(withT.indexOf('-t 2') >= 0 && withT.indexOf('-t 2') < withT.indexOf('-i '),
       '-t is in front of the -i too: after it, it would limit the output instead');
    seconds.value = '';
    seconds.dispatchEvent(new Event('change'));
    pump(120);
}

console.log('\na recording with no end');
{
    const path = `${bro.appDir}/../out/ui-capture.mkv`;
    const field = q('[data-f="cappath"]');
    field.value = path;
    field.dispatchEvent(new Event('change'));
    pump(120);

    q('[data-f="caprecord"]').click();
    pump(200);
    ok(cap.isRecording(), 'it is recording');

    waitFor('some frames', () => (bro.ffmpeg.render.poll().frames || 0) > 20);
    const p = bro.ffmpeg.render.poll();
    ok(p.openEnded, 'the job says it is open-ended');
    same(p.totalFrames, 0, 'so there is no frame total — zero means nobody knows');
    same(p.progress, 0, 'and no progress fraction');

    const bar = text('#cap-bar');
    console.log(`  ${bar}`);
    ok(bar.indexOf('there is no end until you stop it') >= 0,
       'and the bar says so in words rather than drawing a bar to nowhere');
    ok(bar.indexOf('frames') >= 0 && bar.indexOf('B') >= 0,
       'while stating what it can: elapsed, frames and size are facts');

    // One job slot, and a recording is the one job that cannot be re-run.
    ok(!A.shell.goTo('encode'), 'the other stages are refused while it runs');
    same(A.shell.currentStage(), 'capture', 'and it stays where it was');

    q('[data-f="capstop"]').click();
    ok(waitFor('the recording to finish', () => !cap.isRecording()), 'stopping ends it');
    pump(200);

    const done = bro.ffmpeg.render.poll();
    // The rule the whole job is arranged around: nothing was abandoned.
    same(done.state, 'done', 'and a stopped recording is done, not cancelled');

    const probe = bro.ffmpeg.probe(path);
    ok(probe.format.duration > 0.2,
       `what it wrote has the part that was recorded in it (${probe.format.duration.toFixed(2)} s)`);
    ok(!!probe.video, 'with a picture in it');
    ok(text('#cap-bar').indexOf('ui-capture.mkv') >= 0,
       'and the bar says where it went');
}

console.log('\nand it is a file, which is an input');
{
    q('[data-f="capuse"]').click();
    pump(400);
    same(A.shell.currentStage(), 'compose',
         'adding it follows the arrow from Capture to Sources and lands on the edit');
    ok(A.project.clips.length === 1, 'the recording is a clip');
    ok(A.inputs.inputs.some((i) => i.path.indexOf('ui-capture.mkv') >= 0),
       'and an input, opened as an ordinary file — which is what a recording is');
}

console.log('\na recording that does have an end');
{
    A.shell.goTo('capture');
    pump(150);
    const seconds = q('[data-f="capseconds"]');
    // Five and not one: the lavfi device produces as fast as it can rather
    // than in real time — there is no `-re` here — so a one-second recording
    // is over in a fraction of a second and the bar has nothing to be looked
    // at during.
    seconds.value = '5';
    seconds.dispatchEvent(new Event('change'));
    const field = q('[data-f="cappath"]');
    field.value = `${bro.appDir}/../out/ui-capture-bounded.mkv`;
    field.dispatchEvent(new Event('change'));
    pump(150);

    q('[data-f="caprecord"]').click();
    pump(120);
    const p = bro.ffmpeg.render.poll();
    ok(!p.openEnded, 'given a -t, the job is not open-ended');
    ok(p.totalFrames > 0, `and it does have a total (${p.totalFrames})`);
    ok(cap.isRecording() && text('#cap-bar').indexOf('%') >= 0,
       `so the bar shows a percentage, which now means something (${text('#cap-bar')})`);

    ok(waitFor('it to end by itself', () => !cap.isRecording()),
       'and it ends on its own without anyone pressing stop');
    const probe = bro.ffmpeg.probe(`${bro.appDir}/../out/ui-capture-bounded.mkv`);
    ok(probe.format.duration > 4.0 && probe.format.duration < 6.0,
       `about as long as it was told (${probe.format.duration.toFixed(2)} s)`);
    const seconds2 = q('[data-f="capseconds"]');
    seconds2.value = '';
    seconds2.dispatchEvent(new Event('change'));
    pump(100);
}

console.log('\na live input cannot be laid on a timeline');
{
    const input = A.inputs.addInput({ path: 'testsrc=size=320x240:rate=25', format: 'lavfi' });
    same(A.inputs.kindOf(input), 'device', 'an input with a device demuxer is a device');
    ok(A.inputs.endless(input), 'and it is endless, the same rule the renderer applies');
    same(A.inputs.lengthOf(input), 0, 'so it has no length at all');

    const before = A.project.clips.length;
    const clip = A.openInput(input);
    ok(clip === null, 'laying it on the timeline is refused');
    same(A.project.clips.length, before, 'and nothing was added');

    A.shell.goTo('sources');
    pump(200);
    A.drawSources();
    pump(100);
    // The Sources stage can describe one even though it cannot use one: forcing
    // `-f dshow` by hand is a legitimate thing to do.
    q(`[data-input="${input.id}"]`).click();
    pump(150);
    ok(text('#src-detail').indexOf('A device never ends') >= 0,
       'the Sources stage says what a device is rather than showing a file that will not open');
    ok(text('#src-detail').indexOf('Capture stage') >= 0, 'and where to go instead');
    A.inputs.removeInput(input);
    A.shell.goTo('capture');
    pump(150);
}

console.log('\nthis machine’s own devices');
{
    // Whatever the answer, it is asserted. Nothing here passes for want of a
    // device: gdigrab is either in this build or it is not, and if it is then
    // opening it either works or says why.
    const names = cap.devices().map((d) => d.name);
    console.log(`  devices here: ${names.join(' ')}`);

    const screens = names.filter((n) => cap.takesRegion(n));
    console.log(`  can be asked for a region: ${screens.join(' ') || 'none'}`);
    ok(!cap.takesRegion('lavfi'),
       'a device with no offset_x/offset_y/video_size takes no region — asked of its ' +
       'option table, not decided by name');

    if (names.indexOf('gdigrab') >= 0) {
        ok(cap.takesRegion('gdigrab'),
           'gdigrab does, because its demuxer has all three of those options');

        q('[data-device="gdigrab"]').click();
        pump(2500);
        const shown = !!q('[data-f="preview"]');
        const note = text('#cap-note');
        console.log(`  gdigrab: ${shown ? 'previewing' : `refused — ${note}`}`);
        ok(shown || note.length > 0,
           'opening the screen grabber either gives a picture or says why it did not');

        if (shown) {
            ok(waitFor('the screen', () => q('[data-f="preview"]').videoWidth > 0),
               'and the picture is the screen, decoded through the ordinary <video> path');
            ok(text('#cap-settings').indexOf('Drag a box on the picture') >= 0,
               'a region is picked rather than typed');

            // The picture is fitted inside its panel rather than stretched to
            // it, because a region is dragged on it and a squashed picture
            // would be a squashed rectangle.
            const pic = q('[data-f="preview"]');
            const panel = q('#cap-preview');
            ok(Math.abs(pic.clientWidth / pic.clientHeight -
                        pic.videoWidth / pic.videoHeight) < 0.05,
               `the picture is the shape of the screen (${pic.clientWidth}x${
                   pic.clientHeight} for ${pic.videoWidth}x${pic.videoHeight})`);
            ok(pic.clientWidth <= panel.clientWidth + 1 &&
               pic.clientHeight <= panel.clientHeight + 1, 'and it fits inside its panel');

            // What the drag amounts to, which is the part worth checking: a
            // rectangle on the picture becomes the demuxer's own options in
            // the screen's own pixels. Measured before the drag, because
            // setting a region reopens the device at that size.
            const scale = pic.videoWidth / pic.clientWidth;
            cap.setRegionFromDrag({ x: 20, y: 16 }, { x: 220, y: 136 });
            pump(200);
            const o = cap.capture.options;
            ok(!!o.video_size && !!o.offset_x && !!o.offset_y,
               `dragging sets -offset_x -offset_y -video_size (${o.offset_x},${o.offset_y} ${
                   o.video_size})`);
            const w = Number(o.video_size.split('x')[0]);
            const h = Number(o.video_size.split('x')[1]);
            ok(w % 2 === 0 && h % 2 === 0,
               'and the rectangle is even on both sides, because yuv420p has no half pixels');
            ok(Math.abs(w - 200 * scale) <= 4,
               `in the screen’s pixels rather than the panel’s (${w} for 200 shown at ${
                   scale.toFixed(2)}×)`);

            const line = A.command.currentCommand();
            ok(line.indexOf(`-video_size ${o.video_size}`) < line.indexOf('-i '),
               'and the command bar prints the region in front of the -i');

            q('[data-f="capwhole"]').click();
            pump(200);
            ok(!cap.capture.options.video_size, 'giving the whole screen back removes them');
        }
    } else {
        ok(true, 'no gdigrab in this build — this is not Windows');
    }

    const cams = bro.ffmpeg.deviceSources('dshow');
    if (cams && cams.ok) {
        console.log(`  dshow lists ${cams.sources.length}`);
        ok(cams.sources.every((s) => !!s.name),
           'every dshow source came back with the exact string -i takes, which nobody types');
    } else {
        ok(!cams || !!cams.error,
           `dshow could not be enumerated and said why: ${(cams && cams.error) || 'no dshow'}`);
    }
}

console.log('\nleaving gives the device back');
{
    A.shell.goTo('compose');
    pump(300);
    ok(!q('[data-f="preview"]'),
       'the preview is torn down on the way out — a camera held here is one nothing else ' +
       'can open');
}

screenshot('out/ui-capture.png');
console.log(`\n${checks} checks passed`);
