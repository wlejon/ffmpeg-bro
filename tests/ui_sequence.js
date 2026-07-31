// Inputs that are assembled, driven the way a person drives them.
//
// Two things are followed end to end, and they are the two the whole feature
// stands on:
//
//   - **a drop of numbered files is one input.** Three hundred frames dropped
//     on the timeline must not be three hundred clips, and the guess has to
//     refuse the things beside them — the logo, the second run, the file with
//     no number in it. This is the most-used path into image sequences and the
//     place a bad guess is most annoying, so it is checked from the drop
//     rather than from the scan;
//   - **a still says what is true about it.** A single picture is no time at
//     all: libavformat says so, and bro's `<video>` agrees, since it drives
//     its clock from decoded pictures. So a still is opened as `-loop 1` with
//     a `-t`, that decision is on the input where it is printed and can be
//     changed, and taking the loop away leaves an input this application
//     refuses to lay out rather than a clip that shows black.
//
// Then the other end: `image2` writes a run of files and the numbering is in
// the filename, so the Write stage says what will be on disk rather than the
// pattern that produces it.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_sequence.js -- <fixture-directory>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const fixtures = args[0];
assert(fixtures, 'pass the fixture directory: ... tests/ui_sequence.js -- <dir>');

const frames = `${fixtures}/frames`;
const still = `${fixtures}/still.png`;
const outDir = `${bro.appDir}/../out`;

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

let failures = 0;
function ok(cond, what) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    if (!cond) failures++;
}
function eq(actual, expected, what) {
    const same = String(actual) === String(expected);
    ok(same, what);
    if (!same) console.log(`    expected: ${expected}\n    actual:   ${actual}`);
}

waitFor('the app to start', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;

function clearAll() {
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    for (const input of A.inputs.inputs.slice()) A.inputs.removeInput(input);
    pump(60);
}

// ── what a drop amounts to ─────────────────────────────────────────────────

console.log('\na drop of numbered files is one input');
{
    // The twelve `shot_%04d.png` frames, named individually the way a file
    // dialog hands them over.
    const paths = [];
    for (let n = 1; n <= 12; n++)
        paths.push(`${frames}/shot_${String(n).padStart(4, '0')}.png`);

    A.openBatch(paths);
    pump(400);

    eq(A.inputs.inputs.length, 1, 'twelve files become one -i, not twelve');
    const input = A.inputs.inputs[0];
    eq(A.inputs.kindOf(input), 'sequence', 'and it is a sequence');
    ok(/shot_%04d\.png$/.test(input.path),
       `whose path is the pattern the files are on disk: ${input.path}`);
    eq(input.format, 'image2', 'opened with -f image2, forced rather than probed');
    eq(input.options.framerate, '25', 'with a frame rate, because a sequence has none');
    eq(input.options.start_number, '1',
       'and a start number, because image2 gives up five past zero');
    eq(A.project.clips.length, 1, 'and one clip on the timeline');

    // The length is the decision, not a property of the files: twelve pictures
    // at 25 fps is 0.48 s and at 12 it is a second.
    const clip = A.project.clips[0];
    ok(Math.abs(clip.length - 12 / 25) < 0.02,
       `twelve frames at 25 fps is ${clip.length.toFixed(3)} s`);

    A.inputs.updateInput(input, {
        options: Object.assign({}, input.options, { framerate: '12' }),
    });
    A.inputs.reprobe(input);
    pump(100);
    ok(Math.abs(A.inputs.lengthOf(input) - 1.0) < 0.02,
       `and the same files at 12 fps are ${A.inputs.lengthOf(input).toFixed(3)} s — the ` +
       'rate is an input option, not something the files know');

    // Every one of those printed in front of its own `-i`, which is where an
    // input option has to be: the same words after it are output options
    // meaning something else.
    A.command.draw();
    const cmd = A.command.currentCommand();
    const i = cmd.indexOf(' -i ');
    const before = cmd.slice(0, i);
    ok(before.indexOf('-framerate 12') >= 0, '-framerate is printed before the -i');
    ok(before.indexOf('-start_number 1') >= 0, 'and -start_number with it');
    ok(before.indexOf('-f image2') >= 0, 'and the forced demuxer');
}

console.log('\nwhat the grouping refuses to guess');
{
    clearAll();
    // The whole folder: two runs and a file beside them that is part of
    // neither. A logo dropped in with three hundred frames is the ordinary
    // case and the one a bad guess ruins.
    const items = A.assemble.openables([frames]);
    const kinds = items.map((it) => it.kind).sort();
    eq(kinds.join(','), 'sequence,sequence,still',
       'a folder of two runs and a stray picture is two sequences and a still');

    const patterns = items.filter((it) => it.kind === 'sequence')
                          .map((it) => it.seq.pattern.replace(/^.*[/\\]/, '')).sort();
    eq(patterns.join(' '), 'plate%d.png shot_%04d.png',
       'and the unpadded run crossing from one digit to two is one %d, not two inputs');

    const one = A.assemble.openables([`${frames}/shot_0001.png`]);
    eq(one.length + ':' + one[0].kind, '1:still',
       'one numbered file on its own is a still and not a sequence of one');

    const notAnImage = A.assemble.openables([`${fixtures}/landscape.mp4`]);
    eq(notAnImage[0].kind, 'file', 'an mp4 takes no part in any of it');
}

// ── a still, which has no length of its own ────────────────────────────────

console.log('\na still is a decision about how long it is');
{
    clearAll();
    A.open(still);
    pump(300);

    eq(A.inputs.inputs.length, 1, 'a single picture is one input');
    const input = A.inputs.inputs[0];
    eq(A.inputs.kindOf(input), 'still', 'and it is a still');
    eq(input.options.loop, '1', 'held with -loop 1, because one picture is nothing to play');
    eq(input.to, 5, 'for a chosen number of seconds, which is what -to says');
    ok(A.inputs.endless(input), 'the input never ends on its own');
    ok(Math.abs(A.inputs.lengthOf(input) - 5) < 0.02,
       `so its length is the five seconds somebody chose (${A.inputs.lengthOf(input)})`);
    eq(A.project.clips.length, 1, 'and there is a clip');
    ok(Math.abs(A.project.clips[0].length - 5) < 0.05, 'as long as the hold');

    A.command.draw();
    const cmd = A.command.currentCommand();
    const before = cmd.slice(0, cmd.indexOf(' -i '));
    ok(before.indexOf('-loop 1') >= 0, '-loop 1 is printed before the -i');
    ok(before.indexOf('-to 5') >= 0, 'and the hold with it');

    // It plays. This is the check the whole "does a still work" question comes
    // down to: with the loop the decoder goes on producing the picture, so the
    // clock advances and the clip behaves like any other.
    A.setPlayhead(0);
    pump(120);
    A.play();
    // Asserting on what the wait answered rather than on the same predicate
    // again: `waitFor` asserts on its own timeout, so a second `ok()` on it
    // cannot do anything but pass.
    ok(waitFor('the still to play', () => A.transport.t > 0.4, 6000),
       `a held still plays — the playhead reached ${A.transport.t.toFixed(2)}`);
    A.pause();
    pump(80);

    // Take the loop away and the input is one picture and no time at all.
    // Nothing invents a length for it; the application says what is true.
    const bare = A.inputs.addInput({ path: still });
    ok(A.inputs.lengthOf(bare) === 0,
       'the same file with no -loop and no -to has no length at all');
    ok(A.openInput(bare) === null,
       'and is refused rather than laid out as a clip of nothing');
    A.inputs.removeInput(bare);

    // **And with the demuxer this application actually forces**, which is the
    // case the refusal was missing. Only a picture opened bare measures zero:
    // `image2` reports one frame at the declared rate — 0.04 s at 25 fps, a
    // whole second at `-framerate 1` — so a length test let a de-looped still
    // straight through and laid it out as a clip of one frame. The refusal is
    // keyed on what the input *is*, so both of these are refused and the
    // measured length is not consulted.
    const delooped = A.inputs.addInput({ path: still, format: 'image2',
                                         options: { framerate: '25' }, to: 5 });
    ok(A.inputs.lengthOf(delooped) > 0,
       `a de-looped still measures more than zero (${A.inputs.lengthOf(delooped)} s), ` +
       'which is why the length was never the question');
    ok(!A.inputs.endless(delooped), 'and nothing about it says it goes on');
    ok(A.openInput(delooped) === null,
       'it is refused anyway, on being a picture that is not held');
    A.inputs.removeInput(delooped);

    const slow = A.inputs.addInput({ path: still, format: 'image2',
                                     options: { framerate: '1' } });
    ok(Math.abs(A.inputs.lengthOf(slow) - 1) < 0.01,
       `at -framerate 1 the same picture measures a whole second (${A.inputs.lengthOf(slow)})`);
    ok(A.openInput(slow) === null, 'and is still refused');
    A.inputs.removeInput(slow);
}

// ── a sequence, played ─────────────────────────────────────────────────────

console.log('\na sequence plays like any other clip');
{
    clearAll();
    const seq = A.assemble.openables([frames])
                 .find((it) => it.kind === 'sequence' && /shot_/.test(it.seq.pattern));
    ok(!!seq, 'the shot_ sequence is there to open');
    const input = A.inputs.addInput(Object.assign({}, seq.spec, {
        // Slower than the default so there is something to watch: the same
        // twelve files, two seconds long, because that is what the option
        // says.
        options: { framerate: '6', start_number: String(seq.seq.start) },
    }));
    const clip = A.openInput(input);
    ok(!!clip, 'and it opens as a clip');
    ok(Math.abs(A.inputs.lengthOf(input) - 2) < 0.05,
       `twelve frames at 6 fps is ${A.inputs.lengthOf(input).toFixed(2)} s`);

    A.setPlayhead(0);
    pump(150);
    A.play();
    ok(waitFor('the sequence to play', () => A.transport.t > 0.5, 8000),
       `an image sequence plays through the same <video> everything else does ` +
       `(reached ${A.transport.t.toFixed(2)})`);
    A.pause();
    pump(80);
}

// ── a sequence with a soundtrack ───────────────────────────────────────────
//
// Asserted end to end, through a real render, because the claim is precisely
// that there is no arrangement here to inspect: a run of frames is a clip with
// no sound, a sound-only file is a clip with no pictures, and the only thing
// that says they go together is a file with both streams in it coming out the
// other end. This was on the "Not yet" list, as two inputs the Write stage
// could say and nothing joined up. It was wrong — nothing has to join them up,
// which is why the check is here rather than a feature being somewhere.

console.log('\na sequence takes a soundtrack from another clip');
{
    clearAll();
    const soundOnly = `${fixtures}/sound.m4a`;
    const probed = bro.ffmpeg.probe(soundOnly);
    const haveSound = !!probed && !probed.error &&
                      (probed.streams || []).some((s) => s.kind === 'audio');
    if (!haveSound) {
        console.log('  (no sound-only file beside the frames — this section is skipped)');
    } else {
        const seq = A.assemble.openables([frames])
                     .find((it) => it.kind === 'sequence' && /shot_/.test(it.seq.pattern));
        const input = A.inputs.addInput(Object.assign({}, seq.spec, {
            options: { framerate: '6', start_number: String(seq.seq.start) },
        }));
        A.openInput(input);
        pump(300);
        A.openBatch([soundOnly]);
        pump(500);

        eq(A.project.clips.length, 2, 'the frames and the sound are two clips');

        // Under, not after. A drop appends, and a soundtrack is the one thing
        // that has to be at the same time as the pictures rather than next to
        // them — which is a track, and is the whole of the arrangement.
        const sc = A.project.clips.find((c) => /sound\.m4a$/.test(c.input.path));
        ok(!!sc, 'and the sound-only file is one of them');
        sc.track = 1;
        sc.start = 0;
        sc.length = 2;
        A.resolveOverlaps(sc);
        pump(200);

        const spec = A.exporter.buildSpec();
        spec.path = `${outDir}/uiseqsound.mp4`;
        ok(spec.audio, 'the render claims a soundtrack');
        eq(spec.clips.length, 2, 'and carries both clips into it');

        let started = '';
        try { bro.ffmpeg.render.start(spec); } catch (e) { started = String(e); }
        ok(!started, `the renderer accepted it (${started || 'accepted'})`);
        if (!started) {
            waitFor('the sequence render', () => bro.ffmpeg.render.poll().state !== 'running',
                    60000);
            const st = bro.ffmpeg.render.poll();
            ok(st.state === 'done', `it finished (${st.state}${st.error ? ': ' + st.error : ''})`);
            if (st.state === 'done') {
                const out = bro.ffmpeg.probe(spec.path);
                const kinds = (out.streams || []).map((s) => s.kind).sort().join(',');
                eq(kinds, 'audio,video', 'and the file has the pictures and the sound in it');
                ok(Math.abs(out.format.duration - 2) < 0.3,
                   `as long as the frames are (${out.format.duration.toFixed(2)} s)`);
            }
        }
    }
    clearAll();
}

// ── writing a run of files ─────────────────────────────────────────────────

console.log('\nthe Write stage says what will be on disk');
{
    clearAll();
    A.open(`${fixtures}/landscape.mp4`);
    pump(400);

    const S = A.exporter.currentSettings();
    const wasContainer = S.container;
    const wasCodec = S.videoCodec;
    const wasPath = S.path;
    const wasFormat = Object.assign({}, S.extraFormat);
    const wasIn = S.rangeIn, wasOut = S.rangeOut;

    A.shell.goTo('write');
    pump(200);

    // Picking image2 puts a frame number in the name, because a path without
    // one is one file overwritten on every frame and nobody means that by
    // picking image2.
    S.path = `${outDir}/uiseq.png`;
    A.exporter.redraw();
    pump(120);
    const pick = document.querySelector('[data-f="container-open"]');
    ok(!!pick, 'the muxer picker is on the Write stage');
    pick.click();
    pump(80);
    const search = document.querySelector('[data-f="fmtsearch"]');
    ok(!!search, 'with a search over a hundred and eighty of them');
    search.value = 'image2';
    search.dispatchEvent(new Event('input'));
    pump(120);
    const image2 = document.querySelector('[data-muxer="image2"]');
    ok(!!image2, 'and image2 among them');
    image2.click();
    pump(200);

    eq(S.container, 'image2', 'picking it sets -f image2');
    ok(bro.ffmpeg.hasFramePattern(S.path),
       `and puts a frame number in the name: ${S.path.replace(/^.*[/\\]/, '')}`);

    // What is shown is the names, not the pattern. `%04d` is the thing people
    // get wrong once and never trust again.
    // The extension names the codec here and nowhere else in libavformat, so
    // asking for PNGs is done by asking for a `.png` — and the encoder follows
    // rather than staying on the mjpeg the muxer declares as its default.
    const pathField = document.querySelector('[data-f="path"]');
    pathField.value = `${outDir}/uiseq%04d.png`;
    pathField.dispatchEvent(new Event('change'));
    pump(150);
    eq(S.videoCodec, 'png',
       'a .png through image2 encodes PNG, because the extension is the codec here');

    // One second of it, so the run is short and countable.
    S.rangeIn = 0;
    S.rangeOut = 1;
    A.exporter.redraw();
    pump(150);
    const names = Array.from(document.querySelectorAll('#ex-dest .ex-filenames .mono'))
                       .map((n) => n.textContent);
    ok(names.length >= 2, `the filenames it will write are listed (${names.join(', ')})`);
    eq(names[0], 'uiseq0001.png', 'beginning with the first one');

    let failed = '';
    try { bro.ffmpeg.render.start(A.exporter.buildSpec()); } catch (e) { failed = String(e); }
    ok(!failed, `a render into image2 starts (${failed || 'accepted'})`);
    waitFor('the render to finish', () => bro.ffmpeg.render.poll().state !== 'running', 60000);
    const st = bro.ffmpeg.render.poll();
    ok(st.state === 'done', `and finishes (${st.state}${st.error ? ': ' + st.error : ''})`);
    ok(st.bytes > 0, `with a size measured over the run of files (${st.bytes} bytes)`);
    pump(200);

    const written = bro.ffmpeg.frameNames(S.path, 1, 3);
    let present = 0;
    for (const n of written) {
        try { bro.ffmpeg.probe(n); present++; } catch (e) { /* not there */ }
    }
    eq(present, 3, 'and the first three files it named are on disk');

    // One picture is the degenerate case, and it is a different decision
    // rather than a shorter range: `-update 1` or every frame lands on the one
    // before.
    const mode = Array.from(document.querySelectorAll('#ex-dest [data-seg="ex-imgmode"]'));
    ok(mode.length === 2, 'the numbering control offers a file per frame or one picture');
    const single = mode.find((b) => b.getAttribute('data-v') === 'one');
    single.click();
    pump(150);
    eq(S.extraFormat.update, '1', 'One picture sets -update 1');
    ok(!bro.ffmpeg.hasFramePattern(S.path),
       `and takes the frame number back out of the name: ${S.path.replace(/^.*[/\\]/, '')}`);

    A.command.draw();
    const cmd = A.command.currentCommand();
    ok(cmd.indexOf('-update 1') >= 0, 'which the command bar prints');

    // **The grammar for taking the number back out is libavformat's, not
    // printf's**, and the two disagree in both directions. `%-3d` carries a
    // printf flag `av_get_frame_filename2` does not accept, so a name with one
    // in it is *not* a pattern — this application draws it as "One picture"
    // and used to strip it anyway. And `%%` is an escaped per cent, which is
    // exactly what `escapePercent` in ffmpeg_sequence.cpp writes, so a regex
    // hunting for `%d` found the second half of it and turned
    // `100%%d bonus.png` into `100% bonus.png`.
    //
    // Both are asked of libav rather than reasoned about: a name it does not
    // read as a run of files is handed back exactly as it came.
    for (const odd of [`${outDir}/uiseq%-3d.png`, `${outDir}/100%%d bonus.png`]) {
        ok(!bro.ffmpeg.hasFramePattern(odd),
           `libavformat reads no frame number in ${odd.replace(/^.*[/\\]/, '')}`);
        S.path = odd;
        A.exporter.redraw();
        pump(120);
        const again = Array.from(document.querySelectorAll('#ex-dest [data-seg="ex-imgmode"]'))
                           .find((b) => b.getAttribute('data-v') === 'one');
        again.click();
        pump(120);
        eq(S.path, odd, 'and asking for One picture leaves the name alone');
    }

    // Left as it was found: ui/.storage.json carries these between runs.
    S.container = wasContainer;
    S.videoCodec = wasCodec;
    S.path = wasPath;
    S.extraFormat = wasFormat;
    S.rangeIn = wasIn;
    S.rangeOut = wasOut;
    A.exporter.redraw();
    pump(120);
}

// ── -stream_loop ───────────────────────────────────────────────────────────

console.log('\n-stream_loop is how much of an input there is');
{
    clearAll();
    const input = A.inputs.addInput({ path: `${fixtures}/landscape.mp4`, streamLoop: 1 });
    ok(Math.abs(A.inputs.lengthOf(input) - 20) < 0.2,
       `-stream_loop 1 on a ten-second file is ${A.inputs.lengthOf(input).toFixed(2)} s of input`);
    ok(A.inputs.summary(input).indexOf('-stream_loop 1') === 0,
       `and the input states it: ${A.inputs.summary(input)}`);

    const clip = A.openInput(input);
    ok(!!clip && Math.abs(clip.length - 20) < 0.3, 'so the clip is twice the file');

    const forever = A.inputs.addInput({ path: `${fixtures}/landscape.mp4`, streamLoop: -1 });
    ok(A.inputs.lengthOf(forever) === 0,
       '-stream_loop -1 has no length, because forever has none');
    ok(A.openInput(forever) === null, 'and is refused until a -to says how long it is');
    A.inputs.updateInput(forever, { to: 15 });
    ok(Math.abs(A.inputs.lengthOf(forever) - 15) < 0.05,
       'with one, it is exactly as long as the decision');
    A.inputs.removeInput(forever);

    clearAll();
}

// ── the input editor ───────────────────────────────────────────────────────

console.log('\nthe Sources stage edits them as the input options they are');
{
    clearAll();
    A.shell.goTo('sources');
    pump(120);

    const seq = A.assemble.openables([frames])
                 .find((it) => it.kind === 'sequence' && /shot_/.test(it.seq.pattern));
    const input = A.inputs.addInput(seq.spec);
    A.drawSources();
    pump(150);

    const fps = document.querySelector('#src-detail [data-f="seqfps"]');
    const start = document.querySelector('#src-detail [data-f="seqstart"]');
    ok(!!fps && !!start, 'a sequence gets its frame rate and start number as rows');
    eq(fps.value, '25', 'showing what is set');

    // Typed into, it goes into the option bag under the name ffmpeg gives it —
    // which is the whole claim: these are demuxer options and not a feature of
    // this application.
    fps.value = '10';
    fps.dispatchEvent(new Event('change'));
    pump(150);
    eq(input.options.framerate, '10', 'and editing one writes the demuxer option');
    ok(Math.abs(A.inputs.lengthOf(input) - 1.2) < 0.05,
       `so the input is twelve frames at 10 fps (${A.inputs.lengthOf(input).toFixed(2)} s)`);

    const glob = Array.from(document.querySelectorAll('#src-detail [data-seg="src-pattern"]'))
                      .find((b) => b.getAttribute('data-v') === 'glob');
    ok(!!glob, 'pattern_type is offered as the demuxer offers it');
    eq(!!glob.disabled, !bro.ffmpeg.globPatterns,
       `and glob is ${bro.ffmpeg.globPatterns ? 'available' : 'refused'} exactly as this ` +
       'build has it');

    // And the still, whose one row is the one thing about it that is not a fact.
    const held = A.inputs.addInput(A.assemble.stillSpec(still));
    A.drawSources();
    pump(150);
    // The list draws newest last; the detail follows whichever is chosen, so
    // pick it the way a click would.
    document.querySelector(`[data-input="${held.id}"]`).click();
    pump(150);
    const hold = document.querySelector('#src-detail [data-f="stillhold"]');
    ok(!!hold, 'a still gets one row, which is how long it is held');
    hold.value = '2';
    hold.dispatchEvent(new Event('change'));
    pump(150);
    eq(held.to, 2, 'and it writes -to, because that is what the decision is');
    ok(Math.abs(A.inputs.lengthOf(held) - 2) < 0.02, 'so the input is two seconds');

    clearAll();
}

// ── the concat demuxer ─────────────────────────────────────────────────────

console.log('\nseveral files as one -i, and which concat that is');
{
    clearAll();
    A.shell.goTo('sources');
    pump(120);
    A.inputs.addInput({ path: `${fixtures}/landscape.mp4` });
    A.inputs.addInput({ path: `${fixtures}/portrait.mp4` });
    A.drawSources();
    pump(120);

    document.getElementById('src-join').click();
    pump(120);
    // Which of the three concats this is, said where it is offered — on the
    // panel's own heading rather than as the four lines of prose above the
    // ticks it used to be. The words still have to be there: three different
    // things in this application are called concat and they are three different
    // renders.
    const note = document.querySelector('#src-list .section-head');
    ok(!!note && note.textContent.indexOf('end to end') >= 0,
       'the join panel opens saying what it is doing');
    ok(note.title.indexOf('before') > 0 && note.title.indexOf('timeline') > 0,
       'saying that it reads the files before decoding, and where to go if that is wrong');

    const ticks = Array.from(document.querySelectorAll('#src-list [data-join]'));
    eq(ticks.length, 2, 'with the two inputs there are to join');
    ticks[0].click(); pump(40);
    ticks[1].click(); pump(40);
    document.querySelector('[data-f="srcjoingo"]').click();
    pump(300);

    const joined = A.inputs.inputs[A.inputs.inputs.length - 1];
    eq(A.inputs.kindOf(joined), 'concat', 'joining makes a concat input');
    eq(joined.format, 'concat', 'opened with -f concat');
    eq(joined.options.safe, '0', 'with -safe 0, because the paths are absolute');
    eq((joined.parts || []).length, 2, 'out of the two files that were ticked');
    // Ten seconds plus eight. The durations are written into the list because
    // without them the demuxer reports none at all until it has read to the end.
    ok(Math.abs(A.inputs.lengthOf(joined) - 18) < 0.3,
       `and it is as long as both of them (${A.inputs.lengthOf(joined).toFixed(2)} s)`);

    clearAll();
    A.shell.goTo('compose');
    pump(80);
}

console.log(`\n${failures ? `FAILED (${failures})` : 'all sequence UI checks passed'}`);
assert(!failures, `${failures} check(s) failed`);
