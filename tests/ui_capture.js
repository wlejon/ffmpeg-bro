// The Capture stage, driven the way a person drives it: pick a device, look at
// what it can see, set one of its options, watch the command bar say what is
// about to run, record, and stop.
//
// **The vehicle is `lavfi`**, libavfilter's *input device* — `-f lavfi -i
// testsrc=size=…` — because CI has no camera and lavfi is openable anywhere.
// It is a device in exactly the way gdigrab is: registered by
// `avdevice_register_all()`, opened by a forced `-f`, reporting no duration and
// never ending. It is **not** the same mechanism as a source filter on the
// Graph stage, which this build also has: `color` and `testsrc` as *filters* are
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

/// Is `what` printed *in front of* the `-i`, which is the whole of what makes
/// it an input option?
///
/// A function rather than the obvious `line.indexOf(what) < line.indexOf('-i ')`
/// because that spelling passes for a command that never mentions `what` at
/// all: `indexOf` answers −1, and −1 is less than every index there is. So an
/// option that silently stopped being printed would go on satisfying the
/// assertion that it is printed in the right place.
function inFrontOfTheInput(line, what) {
    const at = line.indexOf(what);
    const i = line.indexOf('-i ');
    return at >= 0 && i >= 0 && at < i;
}

waitFor('the app', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
const cap = A.capture;
/// The `-i`s this recording reads, as the document's own input objects.
///
/// **Not `capture.inputs`, which is a list of ids.** A device activated here is
/// an ordinary input in `ui/inputs.js` — the same list a file lands in — so a
/// card's device is `input.format`, what follows the `-i` is `input.path`, and
/// its window is `input.to`. That is the whole point of the collapse and the
/// test says it in the same vocabulary the rest of the application does.
const CI = () => cap.captureInputs();

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
    same(CI()[0].format, 'lavfi', 'the device is chosen');
    ok(CI()[0].path.indexOf('testsrc') === 0,
       `and it starts from something openable (${CI()[0].path})`);
    ok(text('#cap-list').indexOf('does not list its sources') >= 0,
       'a device with nothing to enumerate says so rather than showing an empty list');

    // The one refusal that is about the seam between this binary and the
    // engine rather than about the device.
    // Said on the card whose device it is, not in one note for the stage:
    // with several inputs the question is always *which* of them could not be
    // shown, and a stage-wide sentence cannot answer it.
    ok(text('#cap-cards').indexOf('decoded frames rather than packets') >= 0,
       `lavfi cannot be previewed, and the reason is stated: ${text('#cap-cards')}`);
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
    same(CI()[0].options.rtbufsize, '64M',
         'and it lands in the device’s option bag');
}

console.log('\nthe command it is');
{
    const line = A.command.currentCommand();
    console.log(`  ${line}`);
    ok(line.indexOf('-f lavfi') >= 0, 'the device is the demuxer, named with -f');
    ok(inFrontOfTheInput(line, '-rtbufsize 64M'),
       'and its options are in front of the -i, where input options go');
    ok(line.indexOf('-i testsrc') >= 0, 'the source is what -i is handed');
    // The bar is describing the capture rather than the render, which is the
    // point of it being a stage: the timeline's render is a different file.
    ok(line.indexOf('-filter_complex') < 0,
       'and no -filter_complex, because the graph field is empty — one device with nothing ' +
       'asked of it is written as it comes');

    const seconds = q('[data-f="capseconds"]');
    seconds.value = '2';
    seconds.dispatchEvent(new Event('change'));
    pump(120);
    const withT = A.command.currentCommand();
    ok(inFrontOfTheInput(withT, '-t 2'),
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

console.log('\na second device is a second -i, not a second recording');
{
    same(cap.capture.inputs.length, 1, 'one input to start with');
    const before = A.inputs.inputs.length;

    // **Activating is the whole gesture.** There is no blank card to fill in,
    // because a blank card is a state the shared input list cannot hold — an
    // `-i` with no path is an `-i` that will not open, and it would sit on the
    // Sources stage saying so. Clicking a device appends one that is already
    // openable.
    q('[data-device="lavfi"]').click();
    pump(300);
    same(cap.capture.inputs.length, 2, 'activating a device appends an -i');
    same(qa('[data-card]').length, 2, 'and a card, so both devices are on screen at once');
    same(CI()[1].format, 'lavfi', 'the new input is the device that was clicked');
    same(CI()[0].format, 'lavfi', 'and the first one is untouched');
    ok(text('#cap-list').indexOf('editing [1]') >= 0,
       'the column says which input it is about, because there is now more than one');

    // The point of the collapse: it is the *document's* list that grew, so a
    // device is reachable from everywhere an input is.
    same(A.inputs.inputs.length, before + 1,
         'and it went into the document’s input list, not a private one');
    ok(A.inputs.inputs.some((i) => i.id === cap.capture.inputs[1]),
       'the card holds an id into that list rather than an object of its own');
    same(A.inputs.kindOf(CI()[1]), 'device',
         'where it is known to be a device, off the libavdevice registry');
    ok(A.inputs.endless(CI()[1]), 'and to have no end, which is the same rule the engine applies');
}

console.log('\ntwo inputs with no graph have nowhere to meet');
{
    same(cap.graphOf(), null,
         'nothing in the graph reads these devices, which is not the same as a broken graph');
    ok(!cap.ready(), 'so the recording is not ready to start');
    ok(q('[data-f="caprecord"]').disabled, 'and the button says so rather than failing later');
    ok(text('#cap-bar').indexOf('nowhere for [0:v] and [1:v] to meet') >= 0,
       `with the reason, which is the engine's own: ${text('#cap-bar')}`);
    ok(text('#cap-graph').indexOf('source list') >= 0,
       'and the stage says where a graph is made, because there is no field here to make one in');
    // The same refusal from the engine, in case the button ever stops asking.
    let threw = '';
    try {
        bro.ffmpeg.record.start({ sources: cap.asInputs(), path: `${bro.appDir}/../out/x.mkv` });
    } catch (e) { threw = String(e.message || e); }
    ok(threw.indexOf('no filter graph') >= 0,
       `record.start refuses it too, naming the graph: ${threw}`);
}

console.log('\nthe recording’s graph is built on the Graph stage');
{
    // **This is the whole point of a device being a document input.** Nothing
    // below knows what a recording is: `addSource` takes an input id, and these
    // two happen to be cameras. The same three calls made against two files
    // would build the same graph for a render.
    const ov = A.graph.overlay;
    ov.clear();
    const a = ov.addSource(cap.capture.inputs[0]);
    const b = ov.addSource(cap.capture.inputs[1]);
    same(ov.sourceInputs().length, 2, 'both devices are read by the graph on their own account');

    const stack = ov.addNode('hstack', { params: { inputs: '2' } });
    ov.wire(a.id, 0, stack.id, 0);
    ov.wire(b.id, 0, stack.id, 1);
    ov.wire(stack.id, 0, 'out:v', 0);
    pump(200);

    const g = cap.graphOf();
    ok(g && g.ok, `the graph now describes the recording: ${g && (g.reason || g.filterGraph)}`);
    console.log(`  ${g.filterGraph}`);
    ok(g.filterGraph.indexOf('hstack=inputs=2') >= 0, 'and it is the graph that was wired');
    ok(g.filterGraph.indexOf('[0:v]') >= 0 && g.filterGraph.indexOf('[1:v]') >= 0,
       'reading every picture, because with several inputs an unread stream is refused');
    // The renumbering. The nodes were placed in card order here, but the pads
    // are the recording's `-i` numbers whatever order they went in — the graph
    // numbers by where a node was placed and a recording by where its card is.
    same(g.video, 'vout', 'the pad the muxer takes is named for it');
    same(g.audio, null, 'and there is no sound, because neither testsrc has any');
    ok(cap.ready(), 'with a graph that runs, the recording is ready');

    ok(text('#cap-graph').indexOf('hstack') >= 0,
       'the stage shows what will run rather than a field to type it in');
    ok(!q('[data-f="capgraph"]'), 'there is no field: one description of one recording');
    ok(!q('[data-preset]'), 'and no presets — the Graph stage is where a composition is made');
    // Two cards, a picture each, and the graph that joins them — the state the
    // stage exists to let somebody judge before pressing record.
    screenshot('out/ui-capture-two.png');
}

console.log('\na graph that will not run is a refusal, and it names why');
{
    const ov = A.graph.overlay;
    // A third input, unwired: `hstack=inputs=3` has a pad nothing arrives at,
    // which is a graph libavfilter refuses.
    const stack = ov.nodes().find((n) => n.filter === 'hstack');
    ov.edit({ id: stack.id }, { params: { inputs: '3' } });
    pump(150);
    const g = cap.graphOf();
    ok(g && !g.ok, 'the recording is refused rather than started and failed');
    ok(/nothing wired/.test(g.reason), `and the reason names the empty pad: ${g.reason}`);
    ok(!cap.ready(), 'so the button is dead');
    ok(text('#cap-graph').indexOf('will not run') >= 0, 'and the stage says so where the graph is');
    same(A.command.currentCommand().indexOf('-filter_complex'), -1,
         'the command bar prints no graph either — a line that cannot be run is not one to copy');

    ov.edit({ id: stack.id }, { params: { inputs: '2' } });
    pump(150);
    ok(cap.graphOf().ok, 'put back, it runs again');
}

console.log('\nthe command two inputs come to');
{
    const line = A.command.currentCommand();
    console.log(`  ${line}`);
    same(line.split('-f lavfi').length - 1, 2, 'two devices are two -f/-i pairs');
    same(line.split(' -i ').length - 1, 2, 'and two -i, in the order the graph numbers them');
    ok(line.indexOf('-filter_complex') >= 0,
       'the graph is printed, and exactly: nothing rewrites the string on the way to libav');
    ok(line.indexOf('-map [vout]') >= 0,
       'and what the muxer takes is named, because the graph labelled it');
}

console.log('\na recording can write an output of its own');
{
    // The reason this exists: video out is where a *render* of the timeline
    // ends too, and one pad cannot be both the timeline's composite and the
    // cameras'. So the cameras get an output to themselves and the recording
    // is pointed at it — which is `-map`, and nothing about the composition.
    const ov = A.graph.overlay;
    const stack = ov.nodes().find((n) => n.filter === 'hstack');
    same(qa('[data-f="capvpad"]').length, 0,
         'with no outputs of its own the graph offers no choice, so there is no picker');

    const own = ov.addOutput('v');
    ov.unwire('out:v', 0);
    ov.wire(stack.id, 0, own.id, 0);
    pump(200);

    const picker = q('[data-f="capvpad"]');
    ok(!!picker, 'placing one puts the choice on the stage');
    same(picker.options.length, 2, 'video out, and the output that was placed');

    // Until it is picked, the recording still writes video out — which nothing
    // reaches now, and it says so rather than quietly following the wire.
    const before = cap.graphOf();
    ok(before && !before.ok, 'the recording still writes video out, which is now unfed');
    ok(/outputs of its own/.test(before.reason),
       `and the refusal points at the choice: ${before.reason}`);

    picker.value = own.id;
    picker.dispatchEvent(new Event('change'));
    pump(200);
    same(cap.capture.videoPad, own.id, 'picked, the recording writes that end instead');

    const g = cap.graphOf();
    ok(g && g.ok, 'and it runs');
    ok(g.filterGraph.indexOf('hstack=inputs=2') >= 0, 'the same graph the Graph stage holds');
    // Relabelled, not renamed on the stage: a recording is its own invocation
    // with its own muxer, and `resolvePads` maps [vout].
    ok(g.filterGraph.indexOf('[vout]') >= 0,
       'ending in the label the writer maps rather than in the name it has on the stage');
    same(g.filterGraph.indexOf(`[${own.name}]`), -1, 'so [out2] is nowhere in what runs');
    same(g.video, 'vout', 'which is what the spec maps');
    ok(cap.ready(), 'and the button is live');

    // The whole point of the choice, stated where a person would see it: with
    // the cameras off video out, the *render* has its composite back. Before
    // this, wiring them there said the render's picture was the cameras and the
    // spine said so — a true complaint, and one there was no way to answer.
    const spine = q('#spine [data-stage="graph"]').textContent;
    same(spine.indexOf('nothing reads'), -1,
         `and the render has video out to itself again — the spine no longer complains: ${
             spine.replace(/\s+/g, ' ').trim()}`);
    screenshot('out/ui-capture-pad.png');

    // Deleting it out from under the recording is an ordinary gesture on the
    // other stage, and nothing there knows this one was pointed at it.
    ov.removeInsert(own.id);
    pump(200);
    same(cap.capture.videoPad, '', 'deleting it drops the recording back to video out');
    same(qa('[data-f="capvpad"]').length, 0, 'and the choice goes with it');

    ov.wire(stack.id, 0, 'out:v', 0);
    pump(200);
    ok(cap.graphOf().ok, 'wired back to video out, it runs as before');
}

console.log('\nrecording a session of two devices');
{
    // Paced, for the reason capture_test.cpp paces its sessions: a lavfi input
    // produces as fast as it can be read, and two free-running ones exercise
    // none of what a wall-clock session is about.
    const paced = (bro.ffmpeg.filters || []).some((f) => f.name === 'realtime');
    if (!paced) {
        console.log('  SKIP  this build has no realtime filter to pace a lavfi input with');
    } else {
        const sources = qa('[data-f="capsource"]');
        const sizes = ['size=320x240:rate=25', 'size=320x240:rate=25'];
        for (let i = 0; i < 2; i++) {
            sources[i].value = `testsrc=${sizes[i]},realtime`;
            sources[i].dispatchEvent(new Event('change'));
        }
        pump(200);
        const secs = qa('[data-f="capseconds"]');
        for (const s of secs) { s.value = '2'; s.dispatchEvent(new Event('change')); }
        pump(200);

        const out = `${bro.appDir}/../out/ui-capture-session.mkv`;
        const path = q('[data-f="cappath"]');
        path.value = out;
        path.dispatchEvent(new Event('change'));
        pump(150);

        q('[data-f="caprecord"]').click();
        pump(200);
        ok(cap.isRecording(), 'a session of two devices starts');
        ok(waitFor('the session to end', () => !cap.isRecording(), 40000),
           'and ends on its own, because -t belongs to the inputs');

        const probe = bro.ffmpeg.probe(out);
        ok(!!probe.video, 'what it wrote opens and has a picture');
        // The graph is what makes the file: two 320-wide pictures stacked
        // across is one 640-wide picture, which nothing but the graph could
        // have produced.
        same(probe.video.width, 640,
             `and it is both of them side by side (${probe.video.width}x${probe.video.height})`);
        same(probe.video.height, 240, 'at the height they were scaled to');
    }
}

console.log('\nreleasing one');
{
    const before = A.inputs.inputs.length;
    const gone = cap.capture.inputs[1];
    q('[data-f="capremove"][data-input="1"]').click();
    pump(250);
    same(cap.capture.inputs.length, 1, 'the input is gone');
    same(qa('[data-card]').length, 1, 'and so is its card');
    // Both lists, because activating put it in both. An `-i` left behind on
    // the Sources stage by a card being closed would be a file handle nobody
    // asked for.
    same(A.inputs.inputs.length, before - 1,
         'and it left the document’s input list too — releasing is the opposite of activating');
    ok(!A.inputs.byId(gone), 'the id it held resolves to nothing, because nothing holds it');
    ok(!!q('[data-f="capremove"]'),
       'the last card still has a × — no cards is an ordinary state now that the list is shared');

    // Releasing an input takes the node reading it with it, which is `retain()`
    // doing what it already did for a clip. What is left is a graph with one
    // source and an `hstack` with an empty pad — a refusal, and the right one:
    // the recording really would not run.
    same(A.graph.overlay.sourceInputs().length, 1, 'the node reading it went with it');
    ok(!cap.graphOf().ok, 'and what is left of the graph will not run, which is said rather ' +
                          'than silently recorded as something else');

    // Cleared, one device is written as it comes — the case that needs no graph
    // at all, and the one `recordGraph` answers null for.
    A.graph.overlay.clear();
    pump(150);
    same(cap.graphOf(), null, 'with nothing in the graph there is nothing to say about it');
    ok(cap.ready(), 'and with one input that is fine — the device is written as it is');
    const secs = q('[data-f="capseconds"]');
    secs.value = '';
    secs.dispatchEvent(new Event('change'));
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

        // Released first, so the screen grabber is the only card there is.
        // Activating *appends* — clicking a device no longer re-points the
        // focused card at it — so without this the queries below would answer
        // about the lavfi card still standing at [0].
        while (cap.capture.inputs.length) { q('[data-f="capremove"]').click(); pump(120); }
        same(qa('[data-card]').length, 0, 'no devices activated is an ordinary state');
        ok(text('#cap-settings').indexOf('Click a device on the left') >= 0,
           'and the stage says what to do rather than showing a form about nothing');

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
            ok(text('#cap-settings').indexOf('Drag a box on') >= 0,
               'a region is picked rather than typed');

            // The picture is fitted inside its panel rather than stretched to
            // it, because a region is dragged on it and a squashed picture
            // would be a squashed rectangle.
            const pic = q('[data-f="preview"]');
            const panel = q('.cap-pic');
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
            //
            // Dragged as a *fraction of the picture* rather than in fixed
            // pixels, because the picture is as wide as the room the other
            // cards left it: on a wide desktop shown in a card, two hundred
            // pixels of mouse is more screen than there is screen, and the test
            // would be measuring the clamp instead of the arithmetic.
            const scale = pic.videoWidth / pic.clientWidth;
            const dragW = Math.round(pic.clientWidth * 0.5);
            const dragH = Math.round(pic.clientHeight * 0.5);
            cap.setRegionFromDrag({ x: 4, y: 4 }, { x: 4 + dragW, y: 4 + dragH });
            pump(200);
            const o = CI()[0].options;
            ok(!!o.video_size && !!o.offset_x && !!o.offset_y,
               `dragging sets -offset_x -offset_y -video_size (${o.offset_x},${o.offset_y} ${
                   o.video_size})`);
            const w = Number(o.video_size.split('x')[0]);
            const h = Number(o.video_size.split('x')[1]);
            ok(w % 2 === 0 && h % 2 === 0,
               'and the rectangle is even on both sides, because yuv420p has no half pixels');
            ok(Math.abs(w - dragW * scale) <= 4,
               `in the screen’s pixels rather than the card’s (${w} for ${dragW} shown at ${
                   scale.toFixed(2)}×)`);

            const line = A.command.currentCommand();
            ok(inFrontOfTheInput(line, `-video_size ${o.video_size}`),
               'and the command bar prints the region in front of the -i');

            q('[data-f="capwhole"]').click();
            pump(200);
            ok(!CI()[0].options.video_size,
               'giving the whole screen back removes them');

            // A drag that runs off the edge is the common one on a small card,
            // and an unclamped rectangle is one libavdevice refuses at the open
            // ("capture area extends outside window area") — so the region
            // never leaves the screen it is a region of.
            //
            // Done here, on a picture that is the whole screen again, because a
            // region *reopens the device at that size*: dragged on an
            // already-cropped picture, the numbers below would be a fraction of
            // the crop rather than of the screen.
            const full = q('[data-f="preview"]');
            ok(waitFor('the whole screen again', () => full.videoWidth > 0), 'the picture is back');
            const realW = full.videoWidth, realH = full.videoHeight;
            cap.setRegionFromDrag({ x: 4, y: 4 },
                                  { x: full.clientWidth * 4, y: full.clientHeight * 4 });
            pump(200);
            const big = CI()[0].options;
            const bw = Number(big.video_size.split('x')[0]);
            const bh = Number(big.video_size.split('x')[1]);
            ok(bw + Number(big.offset_x) <= realW && bh + Number(big.offset_y) <= realH,
               `a drag past the edge is clamped to the screen (${big.video_size} at ${
                   big.offset_x},${big.offset_y} of ${realW}x${realH})`);

            q('[data-f="capwhole"]').click();
            pump(200);
        }
    } else {
        // No assertion here, and deliberately none. The rule this block opens
        // with is that whatever the answer is it is asserted — but there is
        // nothing to assert about a device that is not in the build, and the
        // only claim available ("gdigrab is absent") is the `if` above written
        // out again. An `ok(true, …)` standing here would count as a check and
        // prove nothing, which is worse than the honest gap.
        console.log('  no gdigrab in this build — this is not Windows');
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
