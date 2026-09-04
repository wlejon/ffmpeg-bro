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
    const began = Date.now();
    q('[data-device="lavfi"]').click();
    const clickMs = Date.now() - began;

    // **A device is opened off this thread, and this is the assertion that it
    // is.** `probe()` is synchronous and a device open is not this
    // application's to make fast — `dshow` opening a working audio device
    // measures 920 ms, and a camera another program holds or a capture card
    // mid-reset does not measure at all — so an open on this thread is a frozen
    // window, because stage views are never unmounted and the `<video>` on a
    // card *is* the decoder. `lavfi` opens in a few milliseconds, so what is
    // checked here is the **route** rather than a wait anybody would notice:
    // the input is `opening` the instant the click returns, which is only
    // possible if nothing waited for libav.
    ok(clickMs < 500, `activating one returns in ${clickMs}ms`);
    ok(A.inputs.opening(CI()[0]),
       'and the input is opening rather than probed — the device is on a thread of its own');
    ok(!A.inputs.openStoppable(CI()[0]),
       'a Stop beside it would not reach the open: libavdevice never polls libav’s ' +
       'interrupt callback while it is talking to a driver, so the button says so');
    ok(!!cap.stillOpening(), 'the stage knows a device is outstanding');
    ok(!cap.ready(),
       'so Record is held — a recording opens the devices itself and a second handle ' +
       'on a camera is an error, not a slow path');
    same(cap.sessionId(), 0,
         'and no preview session is opened over the top of it, for the same reason');

    pump(300);
    ok(!cap.stillOpening(), 'it settles by itself, from the frame loop');
    same(CI()[0].format, 'lavfi', 'the device is chosen');
    ok(CI()[0].path.indexOf('testsrc') === 0,
       `and it starts from something openable (${CI()[0].path})`);
    ok(text('#cap-list').indexOf('does not list its sources') >= 0,
       'a device with nothing to enumerate says so rather than showing an empty list');

    // **lavfi previews like anything else**, which it could not do until the
    // crossing between this binary and the engine learned about
    // `wrapped_avframe`. There was a refusal on this card saying so; the seam
    // was the thing to fix, and the assertion that it is fixed is a picture of
    // the right size arriving through the ordinary `<video>` path — the same
    // evidence the screen grabber further down is judged by.
    same(A.inputs.byId(cap.capture.inputs[0]).probe.video.codec, 'wrapped_avframe',
         'lavfi still hands over decoded frames rather than packets — the seam changed, not it');
    const pic = q('[data-f="preview"]');
    ok(!!pic, 'and there is a video element on the card rather than a refusal');
    ok(waitFor('lavfi to decode', () => pic.videoWidth > 0),
       'which decodes: a picture arrives through the same backend every file uses');
    same(pic.videoWidth, 1280, `at the size the device was asked for (${pic.videoWidth}x${
        pic.videoHeight})`);
    same(text('#cap-cards').indexOf('cannot be played here'), -1,
         'and nothing on the stage still says it cannot be');
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
    ok(bar.indexOf('runs until you stop it') >= 0,
       'and the bar says so in words rather than drawing a bar to nowhere');
    ok(bar.indexOf('frames') >= 0 && bar.indexOf('B') >= 0,
       'while stating what it can: elapsed, frames and size are facts');

    // One job slot, and a recording is the one job that cannot be re-run.
    ok(!A.shell.goTo('encode'), 'the other stages are refused while it runs');
    same(A.shell.currentStage(), 'capture', 'and it stays where it was');

    // Pressed through the engine, with a frame between the press and the
    // release, because that is what a hand does and what the synthesised
    // `.click()` below cannot ask: the bar used to be rebuilt on every frame of
    // a recording, so the button that was pressed was gone by the release and
    // Stop could not be pressed at all — while `.click()` went on passing.
    {
        const before = q('[data-f="capstop"]');
        pump(100);
        same(q('[data-f="capstop"]'), before,
             'the Stop button is the same element from one frame to the next');
        const r = before.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        mouseDown(cx, cy); pump(60); mouseUp(cx, cy);
    }
    ok(waitFor('the recording to finish', () => !cap.isRecording()),
       'stopping ends it — pressed and released across a frame, as a hand does');
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

console.log('\na file laid over the device, by the graph');
{
    // **The thing docs/manual/not-yet.md said could not be done**, checked from
    // the stage a person would do it on. A capture's graph is fed by its devices
    // and by no `-i` of its own — that part is true and stays true — but a
    // `movie` node is not an `-i`: it is a filter with no input pads, which is
    // the category the entry itself said already works. What it does that a
    // `color` does not is read a file, and in a graph driven by pushing at a
    // buffersrc and draining a buffersink it is **pulled**: framesync asks it
    // for the frame that pairs with the one the device just delivered, and for
    // no more than that.
    //
    // The file is the one the section above just recorded, so this needs no
    // fixture — which is the property that keeps this suite runnable with no
    // media at all.
    const ov = A.graph.overlay;
    ov.clear();
    const shot = `${bro.appDir}/../out/ui-capture-bounded.mkv`;
    // A filename inside a filter argument carries its own escaping, because a
    // colon separates a filter's arguments and a Windows path is full of them.
    // The same two layers `filterPath()` writes for `subtitles=` and
    // `ui/sources.js` takes off again to say which file a node names.
    const escaped = `'${shot.replace(/\\/g, '/').replace(/[:']/g, (c) => '\\' + c)}'`;

    const dev = ov.addSource(cap.capture.inputs[0]);
    const card = ov.addNode('movie', { params: { filename: escaped } });
    const small = ov.addNode('scale', { pos: ['80', '-2'] });
    const over = ov.addNode('overlay', { pos: ['0', '0'] });
    ov.wire(card.id, 0, small.id, 0);
    ov.wire(dev.id, 0, over.id, 0);
    ov.wire(small.id, 0, over.id, 1);
    ov.wire(over.id, 0, 'out:v', 0);
    pump(200);

    const g = cap.graphOf();
    ok(g && g.ok, `a movie node beside the device is a graph that runs: ${
        g && (g.reason || 'ok')}`);
    if (g && g.ok) {
        ok(g.filterGraph.indexOf('movie=') >= 0 && g.filterGraph.indexOf('[0:v]') >= 0,
           `reading the file inside the graph and the device as [0:v]: ${g.filterGraph}`);
        ok(cap.ready(), 'and the recording is ready — nothing about it is refused');
        ok(text('#cap-graph').indexOf('movie') >= 0,
           'the stage shows the file in the chain it is part of');
        // **No `-i` for it, which is the whole distinction.** A `movie` opens
        // its file inside libavfilter, so the command has the device's input
        // and no other — and the Sources stage is where the file is accounted
        // for, under `Opened by the graph`.
        const line = text('#cmd-line');
        same((line.match(/-i /g) || []).length, 1,
             `one -i, because a movie is not one: ${line.slice(0, 160)}`);
    }

    // And the recording itself, which is the assertion the graph cannot make:
    // a file that came out with the card in it.
    const path = `${bro.appDir}/../out/ui-capture-card.mkv`;
    const field = q('[data-f="cappath"]');
    field.value = path;
    field.dispatchEvent(new Event('change'));
    const seconds = q('[data-f="capseconds"]');
    seconds.value = '1';
    seconds.dispatchEvent(new Event('change'));
    pump(150);
    q('[data-f="caprecord"]').click();
    ok(waitFor('the recording to end', () => !cap.isRecording(), 60000),
       'a recording with a file in its graph runs to the end');
    const probe = bro.ffmpeg.probe(path);
    ok(probe.video && probe.video.width === 1280,
       `and comes out at the device's own size (${probe.video && probe.video.width}x${
           probe.video && probe.video.height})`);

    ov.clear();
    seconds.value = '';
    seconds.dispatchEvent(new Event('change'));
    pump(150);
}

console.log('\nand the destination can be a URL');
{
    // **The other half of "a camera composited with a title and streamed
    // out"**, which docs/manual/not-yet.md used to call a thing this
    // application could not express. The composition is the section above; this
    // is the end of it. A recording is a device into a `Writer` and a `Writer`
    // is a muxer, so a URL reaches one here for the reason it does on the Write
    // stage — nothing was widened to carry one.
    //
    // Nothing here reaches a network: what is checked is the *stage*, which is
    // the half a person touches. That the bytes actually go out through the
    // protocol is tests/capture_test.cpp's, against a listener bound on the
    // loopback in the same process.
    const was = cap.capture.path;
    const field = q('[data-f="cappath"]');
    field.value = 'udp://127.0.0.1:45233';
    field.dispatchEvent(new Event('change'));
    pump(150);

    ok(text('#cap-settings').indexOf('udp · linked in') >= 0,
       'the stage says whether the protocol the URL names is in this build, which is the ' +
       `one thing a path field cannot show: ${text('#cap-settings').slice(0, 120)}`);
    ok(text('#cmd-line').indexOf('udp://127.0.0.1:45233') >= 0,
       'and the command bar prints the URL where the filename goes');
    ok(!q('[data-f="caprecord"]').disabled,
       'and nothing about a URL destination is refused');

    field.value = was;
    field.dispatchEvent(new Event('change'));
    pump(150);
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
    ok(text('#cap-list').indexOf('Editing [1]') >= 0,
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
    // The refusal is said **once**: short beside the dead button, and in full
    // on the strip that is about the graph. It used to be a paragraph in both
    // places, which is the habit this stage was rewritten out of.
    ok(text('#cap-bar').indexOf('Needs a graph') >= 0,
       `the button says why it is dead, beside itself: ${text('#cap-bar')}`);
    ok(text('#cap-graph').indexOf('nothing joining them') >= 0,
       `and the graph strip is where the reason is: ${text('#cap-graph')}`);
    ok(!!q('#cap-graph [data-f="capgraphstage"]'),
       'with the door to the stage that fixes it, rather than a sentence naming it');
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
    // **What the graph makes of them, playing** — the thing this stage could
    // not show until there was a live session behind it. A card is one device;
    // two of them side by side only existed in the file afterwards, and the
    // honest advice was to judge a picture-in-picture by its numbers and then
    // play back the take.
    //
    // Twice the width of one device is the assertion worth having, for the
    // reason the recorded file's width is: nothing but the graph could have
    // produced it, so a composite that quietly showed one camera would fail
    // rather than pass with a plausible picture.
    const one = q('[data-f="preview"]');
    const comp = q('[data-f="composite"]');
    ok(!!comp, 'the composition has a picture of its own, below the cards it is made of');
    ok(waitFor('the composition to arrive', () => comp && comp.videoWidth > 0),
       'which plays — the same CaptureGraph a recording runs, on the same graph text');
    same(comp.videoWidth, one.videoWidth * 2,
         `and it is both devices side by side (${comp.videoWidth}x${comp.videoHeight} from two ${
             one.videoWidth}-wide)`);
    ok(text('#cap-comp').indexOf('What the graph makes') >= 0, 'said above it, once');

    // One open per device, which is what the session is for: three pictures
    // on this stage — two cards and the composition — over two `-i`s.
    same(qa('[data-f="preview"]').length, 2, 'a card each');
    const pads = bro.ffmpeg.live.pads(cap.sessionId());
    same(pads.length, 3, `and one session publishing three pads (${
        pads.map((p) => p.name).join(' ')})`);
    same(pads.filter((p) => p.device).length, 2, 'two of them the devices as they arrived');

    // Two cards, a picture each, the composition beneath them, and the graph
    // that joins them — the state the stage exists to let somebody judge
    // before pressing record.
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

console.log('\nmore than one file out of one recording');
{
    // The third answer to "two outputs", and the one only a recording has:
    // `tee` writes one encode to several places, a version writes several
    // encodes of one edit *one after another*, and a recording cannot run
    // anything twice — what it was reading has happened. So its several
    // encodes are several muxers open at once on the end of one pass.
    const ov = A.graph.overlay;
    const stack = ov.nodes().find((n) => n.filter === 'hstack');

    // A branch of its own, ending somewhere of its own: the whole composition
    // into the first file, the left half of it into the second. The `split` is
    // not a detail of the test — a pad can be read once, and the fork being in
    // the gesture rather than hidden behind it is the Graph stage's rule.
    const fork = ov.addNode('split');
    const half = ov.addNode('crop', { pos: ['iw/2', 'ih', '0', '0'] });
    const own = ov.addOutput('v', 'left');
    ov.unwire('out:v', 0);
    ov.wire(stack.id, 0, fork.id, 0);
    ov.wire(fork.id, 0, 'out:v', 0);
    ov.wire(fork.id, 1, half.id, 0);
    ov.wire(half.id, 0, own.id, 0);
    pump(200);

    same(qa('[data-f^="capalso-path"]').length, 0, 'the Also-write list starts empty');
    q('[data-f="capalso"]').click();
    pump(200);
    const path = q('[data-f="capalso-path-0"]');
    ok(!!path, 'pressing the heading opens the first row');
    same(cap.alsoFiles().length, 0,
         'a row with nowhere to go is not part of the recording yet');

    path.value = `${bro.appDir}/../out/ui-capture-also.mkv`;
    path.dispatchEvent(new Event('change'));
    pump(150);
    same(cap.alsoFiles().length, 1, 'given a path, it is');

    // Left on the recording's own end it is a second encode of the same
    // picture, which is a real thing to want and not what this is about.
    const g0 = cap.graphOf();
    same(g0.files.length, 2, 'the graph is asked about two files now');
    same(g0.files[1].video, 'vout', 'and by default the second is of the same pad');

    const vpad = q('[data-f="capalso-vpad-0"]');
    ok(!!vpad, 'the row picks which end it gets');
    vpad.value = own.id;
    vpad.dispatchEvent(new Event('change'));
    pump(200);

    const g = cap.graphOf();
    ok(g && g.ok, 'pointed at the other output, the recording still runs');
    same(g.files.length, 2, 'two files');
    same(g.files[0].video, 'vout', 'the first takes the pad the writer maps by default');
    same(g.files[1].video, own.name,
         `and the second keeps the name it has on the Graph stage (${g.files[1].video})`);
    ok(g.filterGraph.indexOf('[vout]') >= 0 && g.filterGraph.indexOf(`[${own.name}]`) >= 0,
       `both labels are in the one graph: ${g.filterGraph}`);
    ok(g.filterGraph.indexOf('crop=') >= 0,
       'and the branch only the second file reads is in it — every file’s ends are kept');

    // One command line, two outputs, and the second names the pad it is of.
    // That is what the spec sends, so the bar and the recording cannot
    // disagree about which end goes where.
    const line = text('#cmd-line');
    ok(line.indexOf('-map [vout]') >= 0 && line.indexOf(`-map [${own.name}]`) >= 0,
       `the command bar maps both (${line})`);
    ok(line.indexOf('ui-capture-also.mkv') > line.indexOf('-map [vout]'),
       'with the second file after the first, which is what several outputs is');

    // Two muxers at one path interleave into something no player reads, and
    // the engine refuses it by name — this is the same refusal made in time.
    const was = path.value;
    path.value = q('[data-f="cappath"]').value;
    path.dispatchEvent(new Event('change'));
    pump(150);
    ok(!!cap.clashingPath(), 'two files at one path is caught before the press');
    ok(!cap.ready() && q('[data-f="caprecord"]').disabled,
       'and the button says so rather than failing at the open');
    path.value = was;
    path.dispatchEvent(new Event('change'));
    pump(150);
    ok(cap.ready(), 'moved apart again, it is ready');

    // And now record both of them, because two files is a claim about what is
    // on the disk afterwards and nothing short of reading them says it.
    const first = `${bro.appDir}/../out/ui-capture-two.mkv`;
    const field = q('[data-f="cappath"]');
    field.value = first;
    field.dispatchEvent(new Event('change'));
    const seconds = qa('[data-f="capseconds"]');
    for (const s of seconds) { s.value = '2'; s.dispatchEvent(new Event('change')); }
    pump(200);

    q('[data-f="caprecord"]').click();
    pump(150);
    ok(waitFor('the recording to end', () => !cap.isRecording(), 40000),
       'a recording of two files ends on its own');

    const a = bro.ffmpeg.probe(first);
    const b = bro.ffmpeg.probe(was);
    ok(a.video && b.video, 'both files are there with a picture in them');
    ok(b.video.width * 2 === a.video.width,
       `and the second is the other pad — half the width of the first (${
           a.video.width} and ${b.video.width})`);
    screenshot('out/ui-capture-also.png');

    // Put the stage back the way the rest of this file expects it.
    q('[data-f="capalso-drop-0"]').click();
    pump(150);
    same(cap.capture.also.length, 0, 'removing the row takes the file with it');
    ov.removeInsert(own.id);
    ov.removeInsert(half.id);
    ov.removeInsert(fork.id);
    ov.wire(stack.id, 0, 'out:v', 0);
    for (const s of qa('[data-f="capseconds"]')) {
        s.value = '';
        s.dispatchEvent(new Event('change'));
    }
    pump(200);
    ok(cap.graphOf().ok, 'and the graph is what it was');
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

// ── recording and streaming at once ────────────────────────────────────────
//
// `-f tee` is one encode written to several muxers, which is what somebody
// recording a take while pushing it out wants — and the argument is a small
// escaping language in a filename, so the list is *built*. The claim under test
// is that it is built by the **Write stage's own rows**: one editor, so there is
// one answer to how a `|` is escaped. Two files come out of it and both are
// opened, because "several destinations" is a claim about the disk.
console.log('\nseveral destinations out of one recording');
{
    const D = A.exporter.destination;
    const a = `${bro.appDir}/../out/ui-capture-tee-a.mkv`;
    const b = `${bro.appDir}/../out/ui-capture-tee-b.ts`;

    const field = q('[data-f="cappath"]');
    field.value = a;
    field.dispatchEvent(new Event('change'));
    pump(150);

    const picker = q('[data-f="capformat"]');
    ok(Array.from(picker.options).some((o) => o.value === 'tee'),
       'tee is in the container picker — the one entry there by name, because a muxer that ' +
       'does not write the file it is named with would be filtered out');

    picker.value = 'tee';
    picker.dispatchEvent(new Event('change'));
    pump(200);

    same(cap.capture.destinations.length, 2,
         'picking it makes the take the first destination rather than throwing the name away');
    same(cap.capture.destinations[0].path, a, 'which is the path that was already typed');
    same(cap.capture.destinations[0].format, 'matroska', 'carrying the container it had');
    ok(!q('[data-f="cappath"]'), 'and the single path field is gone — the list is where it goes now');

    same(qa('[data-f^="capdest-path"]').length, 2,
         'the list is edited as a list, by the Write stage’s own rows');

    // Emptied and filled in again through the rows, which is how a person gets
    // here — and an empty list is worth an assertion of its own: a tee opened
    // with no destinations is a muxer opened with an empty filename, which
    // libavformat refuses without saying what it wanted.
    q('[data-f="capdest-drop-0"]').click();
    pump(150);
    q('[data-f="capdest-drop-0"]').click();
    pump(150);
    same(cap.capture.destinations.length, 0, 'Remove takes a destination out of the list');
    ok(!cap.ready() && q('[data-f="caprecord"]').disabled,
       'and a tee with nothing in it has nowhere to write, which the button says');

    const typeInto = (i, path, format) => {
        q('[data-f="capdest-add"]').click();
        pump(150);
        const p = q(`[data-f="capdest-path-${i}"]`);
        p.value = path;
        p.dispatchEvent(new Event('change'));
        pump(100);
        const f = q(`[data-f="capdest-format-${i}"]`);
        f.value = format;
        f.dispatchEvent(new Event('change'));
        pump(150);
    };
    typeInto(0, a, 'matroska');
    typeInto(1, b, 'mpegts');

    // Escaped as tee reads it, which on Windows means every backslash in a
    // path — the same function the render side uses, because it is the same
    // argument.
    same(cap.recordTarget(),
         `[f=matroska]${D.escapeTarget(a)}|[f=mpegts]${D.escapeTarget(b)}`,
         'the muxer is opened with the built argument and not with anything typed');
    ok(text('.ex-tee').indexOf('[f=mpegts]') >= 0,
       'which is shown in full under the list, because an argument assembled on your behalf ' +
       'is the thing that has to be visible');

    const line = text('#cmd-line');
    ok(line.indexOf('-f tee') >= 0, `the command bar says -f tee (${line})`);
    ok(/"[^"]*\|[^"]*"/.test(line), 'and quotes it, so the | is tee’s and not the shell’s');
    same(text('.cap-dest-name'), '2 destinations',
         'the button names how many there are — a tee has no basename to show');

    // The same refusal the Also-write list gets, and now it can be made inside
    // one argument: two destinations at one path is two muxers at one path.
    cap.capture.destinations[1].path = a;
    pump(150);
    ok(!!cap.clashingPath() && !cap.ready(),
       'two destinations aimed at one path is caught before the press, not inside one string');
    cap.capture.destinations[1].path = b;
    pump(150);
    ok(cap.ready(), 'moved apart again, it is ready');

    const secs = q('[data-f="capseconds"]');
    secs.value = '2';
    secs.dispatchEvent(new Event('change'));
    pump(200);

    q('[data-f="caprecord"]').click();
    pump(200);
    ok(waitFor('the tee recording to end', () => !cap.isRecording(), 40000),
       'a recording through tee ends on its own, because -t belongs to the input');

    const pa = bro.ffmpeg.probe(a);
    const pb = bro.ffmpeg.probe(b);
    ok(!!pa.video && !!pb.video, 'both destinations are on the disk with a picture in each');
    same(pa.video.width, pb.video.width,
         'the same width in both, because tee is one encode and not two');
    screenshot('out/ui-capture-tee.png');

    // Back to one file, and the name it had is still there — changing your mind
    // about how many files there are must not lose the name of the one.
    picker.value = 'matroska';
    picker.dispatchEvent(new Event('change'));
    pump(200);
    same(q('[data-f="cappath"]').value, a, 'switching back keeps the single path it had');
    secs.value = '';
    secs.dispatchEvent(new Event('change'));
    pump(100);
}

// ── the levels a session is running at ─────────────────────────────────────
//
// The picture a session makes has been on this stage since its pad was
// published; its sound was drained and dropped, so a capture with a microphone
// in it said nothing at all about the microphone. Whether a level is right is
// the one thing about a take that cannot be fixed afterwards.
//
// **The vehicle is `aevalsrc`, for the reason `testsrc` is the vehicle above**:
// the amplitude is written into the expression, so what the meter should read
// is arithmetic rather than a property of a file. A sine's RMS is its peak over
// root two, and both numbers are asserted, because the two halves of a meter
// are measured differently and a meter that showed peak twice would look right.
//
// Two of the claims below are about *what kind of reading it is*, and both are
// checkable here for the same reason the levels are — the signal is written down:
//
//   - **a bar per channel**, which is what catches a stereo pair with a dead side;
//     two expressions twelve decibels apart is a pair of readings twelve decibels
//     apart, and a mono summary of it would be neither of them;
//   - **a true peak and not a sample peak.** A sine at a quarter of the sample rate
//     with its samples on the zero crossings has a loudest *sample* three decibels
//     below its loudest *point*; a meter reading the first cannot be told from one
//     reading the second until you hand it exactly that.
console.log('\nwhat the sound is doing');
{
    const source = q('[data-f="capsource"]');
    const wasPath = CI()[0].path;
    // **`arealtime` is not decoration.** Without it a `lavfi` source generates as
    // fast as the machine can, the device reader's sound queue overflows and the
    // *oldest blocks are dropped* — which leaves the meter a signal with cuts in it,
    // and an oversampling filter rings on a cut by more than a decibel. A real
    // device delivers in real time; this makes the fixture one.
    const sine = (amp) => `aevalsrc=${amp}*sin(1000*2*PI*t):s=48000,arealtime`;
    const setSource = (v) => {
        source.value = v;
        source.dispatchEvent(new Event('change'));
        pump(400);
    };
    const readOf = () => text('#cap-meters .m-read');
    const dbOf = () => parseFloat(readOf());

    setSource(sine(0.5));
    ok(waitFor('the meter to read', () => /^-\d/.test(readOf()), 12000),
       `a sound pad gets a meter, and it reads (${readOf()} dBFS)`);
    same(text('#cap-meters .m-name'), 'in0:a',
         'named the way ffmpeg names that stream — 0:a is the sound of input 0, and it ' +
         'cannot be confused with in0, which is the picture');

    // -6.02 dBFS. The tolerance is a hundredth of a decibel and not a decibel:
    // the number is the loudest it has been rather than a falling mark sampled
    // at whatever moment this ran, so it is a measurement and can be checked
    // like one — and by what it says, since it is shown to a tenth and a
    // tolerance around a rounded number is a tolerance around the rounding.
    same(readOf(), '-6.0',
         'an amplitude of 0.5 reads -6.0 dBFS, which is exactly half of full scale');

    // **The ceiling of the bar over a moment, not one sample of it.** The bar
    // falls between readings on purpose — that is what makes a transient
    // readable rather than a flicker — so one sample of it is the true level
    // minus however many ticks have passed since the last block of sound
    // arrived. Its ceiling is the level.
    const highest = (read) => {
        let top = 0;
        for (let i = 0; i < 40; i++) { pump(20); top = Math.max(top, read()); }
        return top;
    };
    // **Bounded on one side tightly and on the other loosely, because that is
    // the shape of the claim.** A falling bar can never be *above* the level it
    // was last driven to, so anything over is a real disagreement; below it can
    // only mean the sample landed on a tick that had heard no sound yet, and a
    // block of sound is about as long as a tick. Two ticks of fall is 0.7 dB,
    // which is a fifth of the gap between the two things being told apart.
    const atMost = (got, want, what) =>
        ok(got <= want + 0.05 && got > want - 1.1,
           `${what} — ${got.toFixed(1)}% against ${want.toFixed(1)}%`);
    const bar = () => parseFloat(q('#cap-meters .m-bar').style.width);
    const peak = () => parseFloat(q('#cap-meters .m-peak').style.left);
    // The body is the RMS and the mark is the peak, and for a sine they differ
    // by exactly 3.01 dB. A meter drawing the same number twice would put them
    // on top of each other.
    const { dbHeight } = A.levels;
    const body = highest(bar), mark = highest(peak);
    atMost(body, dbHeight(0.5 / Math.SQRT2) * 100,
           'the bar is the RMS, which for a sine is the peak over root two');
    atMost(mark, dbHeight(0.5) * 100, 'and the mark is the peak, 3 dB above it');
    ok(mark > body, 'so the mark stands clear of the bar rather than sitting on it — the ' +
                    'two halves of a meter are measured differently, and one drawn twice ' +
                    'would look right');

    // Half again. Editing the source is a *new session* — the device is
    // reopened — and the reading starts from nothing, which is right: a
    // high-water mark belongs to the take it was measured in.
    const loud = dbOf();
    const wasBar = bar();
    setSource(sine(0.25));
    ok(waitFor('the meter to follow', () => bar() < wasBar - 3, 12000),
       `the bar follows the device (${wasBar.toFixed(1)}% → ${bar().toFixed(1)}%)`);
    same(readOf(), '-12.0',
         `halving the amplitude reads ${(loud - dbOf()).toFixed(1)} dB down — the same ` +
         'distance a halving is anywhere on this scale');

    // Over. `aevalsrc` will hand out 1.5 quite happily, which is a mix that has
    // gone past what any encoder can write — the one reading a meter exists to
    // catch, and the one a scale that stopped at full scale could not show.
    ok(!q('#cap-meters .m-over.on'), 'nothing has clipped yet');
    setSource(sine(1.5));
    ok(waitFor('the over light', () => !!q('#cap-meters .m-over.on'), 12000),
       'a pad that goes past full scale says so');
    ok(!!q('#cap-meters .m-bar.m-hot'), 'and the bar is drawn in its own colour while it is over');
    ok(dbOf() > 0, `with the reading above zero rather than pinned to it (${readOf()})`);

    // And both latches can be cleared, because one that could not would be a
    // light on for the rest of the session after one accident. Cleared while
    // the source is still over, so what is asserted is that the mechanism
    // resets and starts measuring again rather than that it went quiet.
    ok(!!q('#cap-meters .m-over.on') && dbOf() > 0, 'both latches are set');
    q('#cap-meters .m-over').click();
    ok(!q('#cap-meters .m-over.on'), 'one click forgets both at once');
    pump(500);
    ok(!!q('#cap-meters .m-over.on') && readOf() === '+3.5',
       `and they fill again from what is actually arriving (${readOf()} dBFS, which is ` +
       'what an amplitude of 1.5 is)');

    // A session reading is a fact about that session. Reopening the device —
    // which is what editing the source does — starts again rather than
    // carrying a mark measured through different settings.
    setSource(sine(0.25));
    ok(waitFor('the new session to read', () => /^-1\d/.test(readOf()), 12000),
       `a new session is a new reading rather than the last one's high-water mark ` +
       `(${readOf()} dBFS)`);
    ok(!q('#cap-meters .m-over.on'), 'and the over light starts clear with it');

    // ── a bar per channel ──────────────────────────────────────────────────
    //
    // Two expressions is two channels, and `aevalsrc` takes them separated by a
    // pipe. Twelve decibels apart, because a pair that agreed would be a pair a
    // mono summary could have produced.
    const reads = () => {
        const out = [];
        for (const n of document.querySelectorAll('#cap-meters .m-read'))
            out.push(n.textContent.trim());
        return out;
    };
    setSource('aevalsrc=0.5*sin(1000*2*PI*t)|0.125*sin(1000*2*PI*t):s=48000,arealtime');
    ok(waitFor('two channels to read', () => reads().length === 2 &&
                                            reads().every((r) => /^-\d/.test(r)), 12000),
       `a stereo pad gets a bar per channel (${reads().join(', ')} dBFS)`);
    same(reads()[0], '-6.0', 'the left channel reads its own amplitude');
    same(reads()[1], '-18.1',
         'and the right reads its own, twelve decibels down — which a summary of the ' +
         'two could not say and is the whole reason a meter is per channel');
    // And they are named as libav names them rather than counted out here: the
    // question "which channel is over" is about FL and FR.
    const names = [];
    for (const n of document.querySelectorAll('#cap-meters .m-cn')) names.push(n.textContent);
    same(names.join(','), 'FL,FR',
         'named by libav’s own layout rather than by index');
    // The one state on this stage worth a picture: two channels of one pad reading
    // two different levels, which is the whole argument for a bar per channel.
    screenshot('out/ui-capture-levels.png');

    // ── a true peak, not a sample peak ─────────────────────────────────────
    //
    // 12 kHz at 48 kHz with a quarter-cycle offset puts every sample on ±sin 45°,
    // so the loudest sample is 3 dB below the loudest point of the wave. A
    // sample-peak meter reads -3.1 here and a true-peak meter reads -0.1, and there
    // is no way to be both.
    //
    // **Cleared first, and that is not tidying.** A signal that starts abruptly is a
    // step, and an oversampling filter rings on a step by about a decibel — every
    // meter of this kind does, because a step has no true peak to be wrong about.
    // This one starts at 0.7 of full scale, so the latch catches the ring; what is
    // being measured is the steady state after it.
    setSource('aevalsrc=0.99*sin(12000*2*PI*t+PI/4):s=48000,arealtime');
    ok(waitFor('the meter to read', () => /^[-+]\d/.test(readOf()), 12000),
       'a signal whose peaks fall between its samples reads');
    q('#cap-meters .m-over').click();
    pump(500);
    ok(dbOf() > -0.8 && dbOf() < 0.3,
       `and it reads the peak between them: ${readOf()} dBFS, where the loudest sample ` +
       'in this signal is -3.1 — 4× oversampled, so an inter-sample over is caught');

    setSource(wasPath);
    pump(300);
}

// ── hearing it, as opposed to reading it ───────────────────────────────────
//
// The meter above is what you can have without deciding anything. Monitoring is
// the decision, and what it costs is a pad carrying its blocks to a listener —
// so what is asserted here is both halves of that: the element that is doing it,
// and the sound actually arriving at bro's mixer.
//
// **The mixer is the proof, not the element.** An element with a src on it says
// nothing about whether anything is audible; `AudioContext.getBusPeakL(0)` is the
// master bus, which is what the speakers are being handed. It is bro's own
// reading rather than this application's — post its pan law, so a mono pad reads
// 3 dB below its own samples — which is why what is checked is that it goes from
// silent to audible and back, rather than a number.
console.log('\nhearing a pad rather than reading it');
{
    const source = q('[data-f="capsource"]');
    const wasPath = CI()[0].path;
    const setSource = (v) => {
        source.value = v;
        source.dispatchEvent(new Event('change'));
        pump(400);
    };
    setSource('aevalsrc=0.5*sin(1000*2*PI*t):s=48000');
    ok(waitFor('a sound pad', () => !!q('[data-f="listen-in0:a"]'), 12000),
       'a sound pad offers Listen beside its meter');
    same(cap.monitoring(), '', 'and nothing is being monitored to begin with — sound that ' +
                               'starts by itself is sound nobody asked for');
    ok(!q('[data-f="monitor"]'), 'so there is no element playing anything');
    ok(!q('.cap-m-note'), 'and nothing is being said about feedback, because nothing is out');

    let ctx = null;
    try { ctx = new AudioContext(); } catch (e) { ctx = null; }
    const loudest = () => {
        let top = 0;
        for (let i = 0; i < 25; i++) { pump(20); top = Math.max(top, ctx.getBusPeakL(0)); }
        return top;
    };
    // Silence first, so that "audible" below is a change and not a machine that
    // was making a noise anyway.
    if (ctx) ok(loudest() < 0.001, 'the mixer is silent while nothing is monitored');

    q('[data-f="listen-in0:a"]').click();
    pump(200);
    same(cap.monitoring(), 'in0:a', 'pressing Listen monitors that pad');
    const mon = q('[data-f="monitor"]');
    ok(!!mon, 'which is an element pointed at it');
    same(mon.getAttribute('src'), `/@live/${cap.sessionId()}/in0:a`,
         'at the pad’s own src — a sound pad has one now, and pointing something at it is ' +
         'what makes the session queue any sound at all');
    same(text('[data-f="listen-in0:a"]'), 'Listening', 'and the button says so while it is on');
    if (ctx) {
        const heard = loudest();
        ok(heard > 0.01, `and the sound reaches bro’s mixer (master bus peak ${heard.toFixed(3)})`);
    }

    // The warning, which is a sentence and not a behaviour: nothing is ducked,
    // gated or muted, because whether a microphone can hear these speakers is a
    // fact about the room.
    ok(!!q('.cap-m-note'), 'a monitor that is on says what is being recorded while it plays');
    ok(text('.cap-m-note').indexOf('[0:a]') >= 0,
       'naming the input that can hear it: ' + text('.cap-m-note'));
    ok(text('.cap-m-note').indexOf('ducked or gated') >= 0,
       'and saying plainly that nothing is being done about it for you');

    // Off again. The element goes rather than being muted, because the element
    // *is* the listening: a muted one would go on copying every block into a
    // queue for nobody.
    q('[data-f="listen-in0:a"]').click();
    pump(200);
    same(cap.monitoring(), '', 'pressing it again stops');
    ok(!q('[data-f="monitor"]'), 'and takes the element away rather than muting it');
    ok(!q('.cap-m-note'), 'with nothing left to warn about');
    if (ctx) {
        pump(600);   // the ring holds half a second of what was already decoded
        ok(loudest() < 0.001, 'and the mixer goes quiet');
    }

    // Leaving the stage gives the devices back, and the monitoring goes with
    // them: a session that has ended is not something to be listening to.
    q('[data-f="listen-in0:a"]').click();
    pump(150);
    same(cap.monitoring(), 'in0:a', 'monitoring again');
    cap.leave();
    pump(150);
    same(cap.monitoring(), '', 'leaving the stage stops it with the session');
    cap.arrive();
    pump(400);
    same(cap.monitoring(), '', 'and coming back does not turn it on again by itself');

    setSource(wasPath);
    pump(300);
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

    // **And `Stop at` does not change the answer**, which is the whole of this
    // section rather than a corollary of it. `-t` is what gives an endless
    // input a length everywhere else here — a `-loop 1` still, a
    // `-stream_loop -1` — so a refusal that asked about the *length* let a
    // camera through the moment somebody set one, and it very nearly worked:
    // the compositor is already on the wall clock, because `av_read_frame`
    // blocks. What it cannot do is go back. Measured on the renderer before it
    // was refused: two seconds of a `realtime`-paced device cost 2038 ms
    // untrimmed, 3040 ms trimmed one second in and 5061 ms trimmed three
    // seconds in — a trim on a device is a wait of its own length, and the file
    // is two seconds long either way. See `deviceClip` in
    // src/native/ffmpeg_export.h, which is the other end of this.
    A.inputs.updateInput(input, { to: 3 });
    pump(400);
    same(A.inputs.lengthOf(input), 3,
         'Stop at gives a device a length, the same way it gives a -loop one');
    ok(A.openInput(input) === null,
       'and it is still refused, because a length was never the half that was missing');
    same(A.project.clips.length, before, 'still nothing on the timeline');
    A.inputs.updateInput(input, { to: 0 });
    pump(300);

    A.shell.goTo('sources');
    pump(200);
    A.drawSources();
    pump(100);
    // The Sources stage can describe one even though it cannot use one: forcing
    // `-f dshow` by hand is a legitimate thing to do.
    q(`[data-input="${input.id}"]`).click();
    pump(150);
    ok(text('#src-detail').indexOf('cannot be cut') >= 0,
       'the Sources stage says what a device is rather than showing a file that will not open');
    // The strip's `why` is its title, which is where the long form of every one
    // of these lives — the visible half is one line by design.
    const why = (q('#src-detail .src-strip-v') || {}).title || '';
    ok(why.indexOf('Stop at gives one a length') >= 0,
       'and says which half is missing, because the other half is settable and it is ' +
       `the seek that is not: ${why.slice(0, 120)}`);
    // Where to go instead is a door rather than a sentence naming a stage, for
    // the reason the Capture stage's graph strip carries one: telling somebody
    // to go somewhere is worse than taking them.
    ok(!!q('#src-detail [data-f="srcgocapture"]'), 'and offers the way there');
    ok(q('#src-foot [data-f="srcuse"]').disabled,
       'and the act is dead, with the reason beside it: ' + text('#src-foot'));
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
        // The middle column answers "what now" where somebody is already
        // looking, in two fragments. It used to be a paragraph about what a
        // device is, in the column that should have been holding the output
        // settings — so the one thing worth setting in advance was behind
        // activating a camera.
        ok(text('#cap-add').indexOf('Pick one on the left') >= 0,
           'and the stage says what to do rather than showing a form about nothing');
        ok(text('#cap-settings').indexOf('Save to') >= 0,
           'while the recording’s own settings stay where they are');

        q('[data-device="gdigrab"]').click();
        pump(2500);
        const shown = !!q('[data-f="preview"]');
        // The refusal is on the card, which is the thing that has no picture —
        // #cap-note is only written while a recording is running.
        const note = text('#cap-cards');
        console.log(`  gdigrab: ${shown ? 'previewing' : `refused — ${note}`}`);
        ok(shown || note.length > 0,
           'opening the screen grabber either gives a picture or says why it did not');

        if (shown) {
            ok(waitFor('the screen', () => q('[data-f="preview"]').videoWidth > 0),
               'and the picture is the screen, decoded through the ordinary <video> path');
            // On the card, beside the picture it is dragged on — not a headed
            // section two columns away describing a rectangle you cannot see
            // from there.
            ok(text('#cap-cards').indexOf('Drag to crop') >= 0,
               'a region is picked rather than typed, where it is picked');

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
