// The render on the program monitor, instead of the clips.
//
// The viewer composites by placing one `<video>` per clip, which is exact for
// everything a clip does on its own and structurally cannot show three things:
// a generated source with no clip behind it, a filter over the whole canvas,
// and a filter that resizes a clip's picture below the point where the clip is
// placed — where the render lays the result over the canvas at its own size
// rather than in a rectangle anything could be placed by. This suite is about
// those three and about the handover the mode is — because the preview is the
// picture, so while it is on it is also the clock.
//
// **What can be asserted and what cannot.** Nothing here compares pixels: a
// screenshot is for the record and the picture on the screen is the host's. What
// *is* checkable is every claim the feature makes about itself — that the source
// is the render's own (`settle()` says which of the two renderers), that a
// generator with nothing on the timeline produces a picture the viewer has no
// element for, that a moved playhead is a new source rather than a seek, and
// that a graph libavfilter refuses arrives as libavfilter's own sentence. Those
// are the things that could silently stop being true.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_output.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_output.js -- <file>');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const el = (id) => document.getElementById(id);
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}
function same(actual, expected, what) {
    if (actual !== expected) {
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
    }
    ok(actual === expected, what);
}

// The overlay outlives the process, so a previous run's nodes would be counted
// as this one's.
localStorage.removeItem('ffmpeg-bro.graph');

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
A.graph.overlay.clear();

const stage = el('stage');
/// The preview's element, or null. Found on the stage rather than by id because
/// it is built and dropped with the mode — there is no id to go stale.
const out = () => stage.querySelector('.outframe');
/// Wait until it has opened its source and knows how long it is.
const opened = (what) => waitFor(what, () => out() && out().duration > 0);

// ── nothing on yet ─────────────────────────────────────────────────────────

console.log('\noff');
{
    ok(!A.output.isOn(), 'the preview starts off');
    ok(!out(), 'and there is no element on the stage for it');
    ok(!el('btn-output').classList.contains('on'), 'and the button says so');
}

// ── the ordinary edit, previewed ───────────────────────────────────────────
//
// No filters of anybody's on the graph, so this is the *compositor* — the same
// `TimelineSource` a plain render walks. It is the case the mode has to be right
// about before any of the interesting ones mean anything.

A.open(media);
waitFor('the file to load', () => A.project.clips.length === 1);
pump(300);
const clip = A.project.clips[0];

console.log('\nthe compositor');
{
    click(el('btn-output'));
    ok(A.output.isOn(), 'the button turns it on');
    ok(el('btn-output').classList.contains('on'), 'and lights up');
    opened('the preview to open');

    const v = out();
    ok(!!v, 'there is one element for the whole picture');
    ok(v.src.indexOf('/@out/') === 0, `pointed at a render: ${v.src}`);
    same(clip.frame.style.display, 'none',
         'and the clip it is a render of is not drawn behind it');
    ok(v.videoWidth > 0, 'it has a picture');
    ok(Math.abs(v.duration - clip.length) < 0.5,
       `as long as the range: ${v.duration} vs ${clip.length}`);
    ok(!A.output.currentFacts().graph,
       'an edit with no filters on it is the compositor’s render');

    // The whole canvas, not a rectangle inside it — the preview *is* the canvas.
    const size = A.viewer.stageSize();
    same(Math.round(parseFloat(v.style.width)), size.w, 'sized to the whole stage');
    same(Math.round(parseFloat(v.style.height)), size.h, 'in both directions');
}

console.log('\nthe clock');
{
    // The picture in front is the master clock, which is the rule transport.js
    // has always stated — and while this is on, the picture in front is the
    // render. So the playhead comes off the preview, and the clips are parked
    // rather than played: the preview carries the render's own mix now, so a clip
    // playing underneath it would be that clip heard twice.
    A.setPlayhead(0);
    pump(200);
    A.play();
    pump(1200);
    const t = A.transport.t;
    ok(t > 0.1, `the playhead moved with the preview (${t.toFixed(2)} s)`);
    ok(Math.abs(t - A.output.at()) < 1e-6, 'and is exactly where the preview is');
    ok(clip.video.paused, 'the clip underneath is not playing');
    A.pause();
    pump(100);
    ok(out().paused, 'and pause stops the preview');
}

console.log('\nthe picture goes on being made');
{
    // **The one failure of this feature that says nothing while it happens.** A
    // picture is published only where the screen has moved and the screen moves
    // only where the element has taken one, so anything that interrupts that pair
    // leaves both halves waiting — and what you get then is a preview that plays
    // its sound perfectly, keeps its playhead moving (`currentPts` falls back to
    // the clock once the pictures have run out) and never changes the picture
    // again. Measured on a 1080p preview of a five-hour file it was permanent:
    // pictures for four seconds, then none for the rest of the range.
    //
    // So: play, and watch the picture's own moment. Nothing here is a rate — a
    // slow machine may make a tenth of the frames — only that it never stops.
    A.setPlayhead(0);
    pump(200);
    A.play();
    let last = -1;
    let stall = 0;
    let worst = 0;
    for (let i = 0; i < 20; i++) {
        pump(200);
        const t = out().currentTime;
        if (t > last + 1e-6) stall = 0;
        else { stall += 200; worst = Math.max(worst, stall); }
        last = t;
    }
    A.pause();
    pump(100);
    ok(worst <= 1000, `the picture never stood still (worst ${worst} ms)`);
    ok(last > 1, `and got somewhere: ${last.toFixed(2)} s of render`);
}

// ── the sound of the render ────────────────────────────────────────────────
//
// The preview was a picture and nothing else, on the argument that the clips
// underneath were the same mix by a cheaper route. True of everything except what
// a preview is for: a filter on the whole programme. So the render's own mix
// comes out of the element, and both halves of that are asserted here —
// that it is audible at all, and that it is *the render's*, which is proved by
// silencing it with a filter on the mix and nothing else.
//
// **Measured at bro's mixer, not at the element.** An element with a src on it
// says nothing about whether anything is audible; `getBusPeakL(0)` is what the
// speakers are being handed. It is bro's own reading — post its pan law — so what
// is checked is silent-versus-audible rather than a number.
console.log('\nthe sound of the render');
{
    const probe = bro.ffmpeg.probe(media);
    const hasSound = !!probe.streams && probe.streams.some((s) => s.kind === 'audio');
    let ctx = null;
    try { ctx = new AudioContext(); } catch (e) { ctx = null; }
    if (!hasSound || !ctx) {
        console.log(`  (skipped: ${!hasSound ? 'the file has no sound' : 'no audio engine'})`);
    } else {
        const loudest = () => {
            let top = 0;
            for (let i = 0; i < 30; i++) { pump(20); top = Math.max(top, ctx.getBusPeakL(0)); }
            return top;
        };
        A.setPlayhead(0);
        pump(200);
        ok(loudest() < 0.001, 'nothing is coming out while the preview is paused');

        A.play();
        pump(400);
        const heard = loudest();
        ok(heard > 0.005, `playing the render is audible (master bus peak ${heard.toFixed(3)})`);
        ok(clip.video.paused, 'and it is not the clip underneath, which is parked');
        A.pause();
        pump(300);

        // The half no clip element can play: a filter on the *mix*. Silencing it
        // there is the assertion worth having — the sound cannot be coming from
        // anywhere but libavfilter's own render if a `volume=0` after the mix
        // stops it.
        // Off and on again around the insert, rather than left on and nudged: the
        // token an element holds carries the *range*, so an edit that leaves the
        // playhead where it is leaves the element pointed at the src it already
        // has — and an assertion made after that is an assertion about the render
        // from before the filter existed.
        A.setOutputPreview(false);
        A.graph.overlay.insert('audio/after-mix', 'volume', { params: { volume: '0' } });
        pump(200);
        A.setPlayhead(0);
        A.setOutputPreview(true);
        opened('the preview to rebuild around the filter');
        ok(A.output.currentFacts().graph, 'a filter on the mix makes it libavfilter’s render');
        A.play();
        pump(600);
        ok(loudest() < 0.001,
           'and a volume=0 on the whole programme is heard — by there being nothing to hear');
        ok(A.transport.t > 0.1, `while the picture goes on playing (${A.transport.t.toFixed(2)} s)`);
        A.pause();

        A.setOutputPreview(false);
        A.graph.overlay.clear();
        pump(200);
        A.setPlayhead(0);
        A.setOutputPreview(true);
        opened('the preview without it');
        A.play();
        pump(400);
        ok(loudest() > 0.005, 'taking the filter off brings the sound back');
        A.pause();
        pump(200);
    }
}

// ── the meter beside the viewer ────────────────────────────────────────────
//
// A1 on the timeline is the analysis's buckets, per clip, made before anything
// played. The strip beside the picture is the other question — how loud is what is
// leaving *now* — and it has two different answers depending on what is making the
// sound, which is the whole of what is asserted here.
//
// With `O` on it is the render's own mix, measured off every block by the run
// behind the preview: **per channel of the output**, at the channel count the
// encoder would be opened with, and a **true peak** rather than a sample peak. Both
// of those are claims that can be checked — the first by changing the output's
// channel count and counting the bars, the second on the Capture stage where the
// signal is arithmetic (see tests/ui_capture.js).
//
// With `O` off there is no render: bro's mixer is summing the clip elements, so
// the strip reads bro's master bus instead and says so. What is checked is that it
// *says which*, because the two readings are not the same claim and a strip that
// quietly swapped between them would be the dishonest version of this feature.
console.log('\nhow loud what is leaving is');
{
    const strip = () => document.getElementById('levels');
    const bars = () => strip().querySelectorAll('.m-bar').length;
    const probe = bro.ffmpeg.probe(media);
    const hasSound = !!probe.streams && probe.streams.some((s) => s.kind === 'audio');

    ok(!!strip(), 'there is a level strip beside the viewer');

    A.setOutputPreview(false);
    A.setPlayhead(0);
    pump(200);
    // The mixer half of this needs bro to have one; the render half does not, since
    // a render is made whether or not anything can be played out of it.
    const engine = A.monitor.why() !== 'no audio engine in this build';

    if (!hasSound) {
        console.log('  (skipped: the file has no sound)');
    } else {
        if (!engine) {
            console.log('  (the mixer half skipped: no audio engine in this build)');
        } else {
            // Off, and nothing playing. The mixer is the answer because there is no
            // render — and it is named, with its own weaker guarantee beside it.
            same(A.monitor.reading(), 'monitor',
                 'with the preview off the strip reads bro’s mixer, because the clips are ' +
                 'what is making the sound and nothing else has a mix to measure');
            same(A.monitor.channelCount(), 2,
                 'as a stereo pair, which is the device’s channels and not the output’s');

            // **And pressing play moves it to the render, with the preview
            // button still off.** This assertion used to be the opposite one —
            // that the strip stayed on the mixer while the clips played — and it
            // was true right up until playback stopped running on the clips.
            // Playing now engages a render of its own, because one source has no
            // cut in it to hitch on (see `play()` in ui/transport.js), and when
            // it takes over it is the render's mix that is being heard. A strip
            // that went on reading bro's speakers would be metering the clips,
            // which by then are parked and silent.
            //
            // The mode is untouched by any of that: `O` is still off, the button
            // is still unlit, and `isWanted()` below is what says so.
            A.play();
            waitFor('playback to reach the render',
                    () => A.monitor.reading() === 'output');
            ok(!A.output.isWanted(),
               'and the preview button is still off — playback borrowed the render, ' +
               'it did not turn the mode on');
            A.pause();
            pump(200);
        }

        // On. Now there *is* a mix of the whole programme, made at the output's own
        // channel count, and that is what the strip should be reading instead.
        A.setPlayhead(0);
        A.setOutputPreview(true);
        opened('the preview to open');
        A.play();
        waitFor('the strip to pick up the render', () => A.monitor.reading() === 'output');
        same(A.monitor.reading(), 'output',
             'with the preview on it reads the render’s own mix rather than the speakers');
        same(A.monitor.why(), '', 'with nothing to explain, because there is something to draw');
        // The number a meter shows is only a measurement if something drove it, so
        // this is the assertion that the reading is *arriving* rather than that the
        // bars exist: the loudest-so-far latch is above the floor.
        const top = () => {
            let best = -Infinity;
            for (const n of strip().querySelectorAll('.m-read')) {
                const v = parseFloat(n.textContent);
                if (isFinite(v)) best = Math.max(best, v);
            }
            return best;
        };
        waitFor('a reading off the render', () => top() > A.levels.DB_FLOOR);
        ok(top() > A.levels.DB_FLOOR,
           `the render’s mix reads on the strip (${top().toFixed(1)} dBFS)`);
        A.pause();
        pump(200);

        // **The channel count is the output's, asked rather than assumed.** One bar
        // per channel of the mix, so an output written in mono is one bar — which is
        // the half of the Not-yet entry that said the old meter was per clip rather
        // than per output channel.
        same(bars(), 2, 'two bars for a stereo output');
        const s = A.exporter.currentSettings();
        const wasChannels = s.channels;
        s.channels = 1;
        A.setOutputPreview(false);
        pump(200);
        A.setPlayhead(0);
        A.setOutputPreview(true);
        opened('the mono preview');
        A.play();
        waitFor('the strip to follow the output down to one channel',
                () => A.monitor.reading() === 'output' && bars() === 1);
        same(bars(), 1, 'and one bar for an output written in mono');
        A.pause();
        s.channels = wasChannels;
        A.setOutputPreview(false);
        pump(300);
        A.setPlayhead(0);
        A.setOutputPreview(true);
        opened('the preview back at the output’s own channel count');
        A.play();
        waitFor('two bars again', () => bars() === 2);
        same(bars(), 2, 'putting the setting back puts the bar back');
        A.pause();
        pump(200);
        // The one state worth a picture on this stage: the render playing with a
        // meter of its own mix beside it.
        screenshot('out/ui-output-levels.png');
    }
}

console.log('\nmoving the playhead');
{
    // A filter graph pulls: it produces the frames it produces, in order, and
    // there is no seeking inside one. So the range is part of the token and a
    // moved playhead is a new source — which is a thing to check rather than a
    // detail, because a token that did not change would leave the picture
    // playing the render as it used to be.
    const before = out().src;
    A.setPlayhead(2);
    pump(900);
    ok(out().src !== before, `a moved playhead is a new src: ${out().src}`);
    ok(out().src.indexOf('-') > 0, 'which carries the range it starts at');
    opened('the preview to reopen');
    ok(Math.abs(A.output.at() - 2) < 0.1,
       `and the picture is where it was asked for (${A.output.at()})`);
}

console.log('\nan edit made while it is playing');
{
    // A preview is re-pointed whenever the edit changes, and an element handed
    // a new src is a *paused* element at zero. So the wanted state is
    // remembered and put back — without it, nudging anything while watching
    // silently stopped the playback it was made during, which is the sort of
    // failure that reads as the mode being flaky rather than as a bug.
    A.setPlayhead(0);
    pump(200);
    A.play();
    pump(400);
    const wasPointedAt = out().src;
    clip.xform.opacity = 0.8;
    A.changed('edit');
    // Past the quiet period, and then long enough for the new source to open.
    waitFor('the preview to be rebuilt', () => out() && out().src !== wasPointedAt);
    opened('the rebuilt preview');
    waitFor('it to pick up playing again', () => !out().paused);
    const t = A.transport.t;
    pump(600);
    ok(A.transport.t > t, `and it goes on playing (${t.toFixed(2)} → ${A.transport.t.toFixed(2)})`);
    A.pause();
    clip.xform.opacity = 1;
    A.changed('edit');
    pump(600);
}

console.log('\nturning it off');
{
    click(el('btn-output'));
    ok(!A.output.isOn(), 'the button turns it off again');
    ok(!out(), 'the element goes with it');
    same(clip.frame.style.display, 'block', 'and the clip is drawn again');
    // The clips were parked at the playhead the whole time, which is what makes
    // coming back a repaint rather than a seek per decoder.
    ok(Math.abs(clip.video.currentTime - A.transport.t) < 0.5,
       'parked where the playhead is');
}

// ── a filter over the whole canvas ─────────────────────────────────────────
//
// The first of the three the viewer cannot show. There is no single picture for
// a filter after the composite to run on, because the composite is one element
// per clip — so this is only ever going to be a render.

console.log('\na programme-wide filter');
{
    A.graph.overlay.insert('composite/after-overlay', 'hflip');
    pump(200);
    A.setPlayhead(0);
    A.setOutputPreview(true);
    opened('the graph preview to open');

    same(A.output.why(), '', 'nothing to explain: it renders');
    const v = out();
    ok(v.videoWidth > 0, 'and there is a picture');

    // The fact that makes it the render rather than a resemblance of one: with a
    // filter of somebody's on the graph, the spec goes through libavfilter — and
    // the preview says so because it asked, which is what `settle` is for.
    const facts = A.output.currentFacts();
    ok(facts.graph, 'the preview is libavfilter’s render, not the compositor’s');
    same(facts.width, A.project.width, 'at the canvas width');
    same(facts.height, A.project.height, 'and height');

    A.play();
    pump(1200);
    ok(A.transport.t > 0.1, `and it plays (${A.transport.t.toFixed(2)} s)`);
    A.pause();
    // The one state worth a picture: a filter that only exists after the
    // composite, on the program monitor.
    screenshot('out/ui-output.png');
    A.setOutputPreview(false);
    A.graph.overlay.clear();
    pump(200);
}

// ── a filter that resizes a clip's picture, after it is placed ─────────────
//
// The second, and it is the half of that which is left: a resize on the way *in*
// changes how big the clip's picture is, which the viewer now lays it out at. A
// resize below the derivation's `scale` is the other thing — the render lays what
// comes out of it over the canvas at its own size, at the rectangle's top-left,
// which is not a rectangle the viewer has any way to place. So that one is
// refused and wears the `fx` badge, and the render has no such problem, because
// placing is what the render does.

console.log('\na filter that resizes the picture after the clip is placed');
{
    A.graph.overlay.insert(`clip:${clip.id}/after-scale`, 'scale',
                           { pos: ['iw/2', 'ih/2'] });
    pump(400);

    ok(!A.graph.playback.srcFor(clip.id),
       'the viewer refuses to play the chain');
    ok(A.graph.playback.whyFor(clip.id).indexOf('size') > 0 ||
       A.graph.playback.whyFor(clip.id).indexOf('×') > 0,
       `and says why: ${A.graph.playback.whyFor(clip.id)}`);

    A.setPlayhead(0);
    A.setOutputPreview(true);
    opened('the preview of a resized clip');
    same(A.output.why(), '', 'the render shows it without complaint');
    ok(out().videoWidth > 0, 'and there is a picture');

    A.setOutputPreview(false);
    A.graph.overlay.clear();
    pump(200);
}

// ── a graph libavfilter will not have ──────────────────────────────────────
//
// A message, in libav's own words, on the stage the picture would have been on.
// The alternative is a black rectangle and a line in a log nobody reads.

console.log('\na graph that will not build');
{
    A.graph.overlay.insert('composite/after-overlay', 'eq',
                           { params: { nosuchoption: '3' } });
    pump(200);
    A.setOutputPreview(true);
    waitFor('the refusal', () => A.output.why());
    ok(A.output.why().indexOf('Option not found') > 0,
       `libavfilter’s own sentence: ${A.output.why()}`);
    ok(!el('out-note').classList.contains('hidden'), 'and it is on the stage');

    A.graph.overlay.clear();
    pump(900);
    waitFor('the picture to come back', () => !A.output.why() && out() && out().duration > 0);
    ok(!A.output.why(), 'taking the filter off brings the picture back');
    ok(el('out-note').classList.contains('hidden'), 'and the message goes');
    A.setOutputPreview(false);
}

// ── a generated source with no clip ────────────────────────────────────────
//
// The third, and the plainest of them: a `testsrc` is a node with no clip, so
// there is no element on the program monitor it could be — every element there
// belongs to something laid out on the timeline. A render has no such rule.

console.log('\na generator with nothing on the timeline');
{
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    waitFor('the timeline to empty', () => A.project.clips.length === 0);
    A.graph.overlay.clear();
    // `d` is the only thing that says how long something with no length of its
    // own is — see `graphLength()` — so a generator without one has no range to
    // render over and is refused rather than guessed at.
    A.graph.overlay.addNode('testsrc', { params: { d: '5', s: '320x240' } });
    pump(300);

    same(A.project.clips.length, 0, 'there is nothing on the timeline');
    A.setOutputPreview(true);
    opened('the generator to render');
    same(A.output.why(), '', 'and it renders');
    ok(out().videoWidth > 0, 'a picture out of a graph with no clip in it');
    ok(Math.abs(out().duration - 5) < 0.5,
       `as long as its own d= says (${out().duration})`);
    A.setOutputPreview(false);
    A.graph.overlay.clear();
    pump(200);
}

// ── nothing to render ──────────────────────────────────────────────────────

console.log('\na range that ends before the timeline does');
{
    // The preview is a render of the *range*, so it runs out where the range
    // does — with the rest of the edit still to come. Stopping there is the
    // honest answer: handing over to the clip after the range would be handing
    // over to something that is not on the screen and is not being previewed.
    A.open(media);
    waitFor('a clip to render', () => A.project.clips.length === 1);
    pump(300);
    const only = A.project.clips[0];
    const s = A.exporter.currentSettings();
    s.rangeIn = 0;
    s.rangeOut = Math.min(1.5, only.length / 2);
    A.setPlayhead(0);
    A.setOutputPreview(true);
    opened('the preview of a range');
    ok(Math.abs(out().duration - s.rangeOut) < 0.4,
       `as long as the range and not the timeline (${out().duration} vs ${only.length})`);

    A.play();
    waitFor('the preview to run out', () => !A.transport.playing, 30000);
    ok(!A.transport.playing, 'it stops when the range does');
    ok(A.transport.t < only.length - 0.3,
       `and leaves the playhead at the end of the range (${A.transport.t.toFixed(2)})`);

    A.setOutputPreview(false);
    s.rangeIn = 0;
    s.rangeOut = 0;
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    waitFor('the timeline to empty again', () => A.project.clips.length === 0);
    pump(200);
}

console.log('\nan empty range');
{
    A.setOutputPreview(true);
    pump(600);
    ok(A.output.why(), `it says so rather than showing black: ${A.output.why()}`);
    A.setOutputPreview(false);
}

console.log(`\n${checks} checks passed`);
