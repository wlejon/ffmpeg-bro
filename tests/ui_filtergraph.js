// The equivalent filtergraph, checked against specs written out by hand.
//
// This is the one part of the command bar that is not simply repeating what
// the encoder was told: the composition is performed by ffmpeg_export.cpp, not
// by a filter graph, so the graph shown to the user is a translation and a
// translation can be wrong without anything failing. Nothing here renders —
// `buildSpec()`'s output is a plain object, so the specs below are written
// directly and the answers are compared as strings.
//
// String equality on purpose. A looser check ("it mentions overlay") passes
// for a graph that puts the clip in the wrong place, which is exactly the
// failure this exists to catch.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_filtergraph.js
//        (no media file — nothing here decodes anything)

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

/// A chain by the pad it reads from. The video chains are emitted together and
/// the overlays after them, so an audio chain's index moves with the number of
/// clips — which is not what any of these cases is about.
const chainFrom = (g, pad) =>
    (g.chains || g.filterGraph.split(';')).find((c) => c.indexOf(pad) === 0) ||
    '(no such chain)';

function same(actual, expected, what) {
    if (actual !== expected) {
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
    }
    ok(actual === expected, what);
}

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const { filtergraph, renderGraph } = globalThis.__ffmpegBro;
ok(typeof filtergraph === 'function', 'filtergraph() is on the test surface');
ok(typeof renderGraph === 'function', 'and renderGraph(), which is the same graph to run');

/// A clip with everything at its neutral value, so each case below states only
/// what it is about.
function clip(over) {
    return Object.assign({
        path: 'a.mp4', start: 0, length: 4, inPoint: 0,
        x: 0, y: 0, w: 1920, h: 1080,
        crop: { l: 0, t: 0, r: 0, b: 0 },
        opacity: 1, volume: 1, muted: false, z: 0,
    }, over);
}

function spec(over) {
    return Object.assign({
        width: 1920, height: 1080, fps: 30, start: 0, end: 4,
        audio: true, clips: [clip()],
    }, over);
}

// ── the simplest render there is ───────────────────────────────────────────
//
// One clip, filling the canvas, from the top. Every other case is this one
// with something turned on, so if this is wrong nothing below means anything.

console.log('\none clip, whole canvas');
{
    const g = filtergraph(spec());
    ok(g.ok, 'it can be described');
    same(g.inputs.join(' '), 'a.mp4', 'one input');
    same(g.chains[0], 'color=c=black:s=1920x1080:r=30:d=4[base]',
         'a black canvas at the output size and rate');
    same(g.chains[1],
         '[0:v]trim=start=0:end=4,setpts=PTS-STARTPTS+0/TB,scale=1920:1080,format=rgba[v0]',
         'the clip is cut, placed on the output clock and sized');
    same(g.chains[2],
         '[base][v0]overlay=0:0:eof_action=pass,' +
         'scale=in_range=full:out_color_matrix=bt709:out_range=tv[vout]',
         'laid over the canvas, then converted out of the compositing space');
    same(chainFrom(g, '[0:a]'), '[0:a]atrim=start=0:end=4,asetpts=PTS-STARTPTS[a0]',
         'its audio is cut to the same seconds');
    same(g.audio, '[a0]', 'one clip needs no mixer');
    same(g.video, '[vout]', 'the video pad is named');
    same(g.chains.length, 4, 'and nothing else is emitted');
}

// ── a crop ─────────────────────────────────────────────────────────────────
//
// The crop is a fraction of the source and the source's size is not in the
// spec — the renderer never needs it, because it crops the placed picture. So
// the graph has to do that arithmetic in ffmpeg's own iw/ih terms, and the
// scale that follows has to be of the *kept* part, not of the whole picture.

console.log('\na crop');
{
    const g = filtergraph(spec({
        clips: [clip({ crop: { l: 0.1, t: 0.25, r: 0.1, b: 0.25 } })],
    }));
    same(g.chains[1],
         '[0:v]trim=start=0:end=4,setpts=PTS-STARTPTS+0/TB,' +
         'crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25,scale=1536:540,format=rgba[v0]',
         'crop before scale, and the scale is of what is left');
    ok(g.chains[2].indexOf('[base][v0]overlay=192:270:eof_action=pass') === 0,
       'the overlay moves by the crop, so the kept part stays where it was');
}

// ── two clips, stacked, one half transparent ───────────────────────────────

console.log('\ntwo clips');
{
    const g = filtergraph(spec({
        clips: [
            clip({ path: 'under.mp4' }),
            clip({ path: 'over.mp4', x: 480, y: 270, w: 960, h: 540, opacity: 0.5 }),
        ],
    }));
    same(g.inputs.join(' '), 'under.mp4 over.mp4', 'one input per clip, in paint order');
    same(g.chains[2],
         '[1:v]trim=start=0:end=4,setpts=PTS-STARTPTS+0/TB,scale=960:540,' +
         'format=rgba,colorchannelmixer=aa=0.5[v1]',
         'opacity is set on the alpha the compositing format already carries');
    same(g.chains[3], '[base][v0]overlay=0:0:eof_action=pass[o0]',
         'the bottom clip goes down first, into an intermediate pad');
    ok(g.chains[4].indexOf('[o0][v1]overlay=480:270:eof_action=pass') === 0,
       'and the top one over it');
    ok(g.chains[4].indexOf('[vout]') > 0, 'the last overlay is the one that names [vout]');
    same(g.audio, '[aout]', 'two audible clips are mixed');
    same(g.chains[g.chains.length - 1], '[a0][a1]amix=inputs=2:normalize=0[aout]',
         'summed, not averaged — amix normalises by default and the renderer does not');
}

// ── a clip that starts late and is trimmed at the head ─────────────────────
//
// The three clocks that have to stay separate: where it sits on the timeline,
// where it starts inside its own file, and where the render begins.

console.log('\nthree clocks');
{
    const g = filtergraph(spec({
        start: 1, end: 5,
        clips: [clip({ start: 2, length: 3, inPoint: 10 })],
    }));
    same(g.chains[0], 'color=c=black:s=1920x1080:r=30:d=4[base]',
         'the canvas runs for the range, not for the timeline');
    same(g.chains[1],
         '[0:v]trim=start=10:end=13,setpts=PTS-STARTPTS+1/TB,scale=1920:1080,format=rgba[v0]',
         'cut from the in-point, placed one second into the render');
    same(chainFrom(g, '[0:a]'),
         '[0:a]atrim=start=10:end=13,asetpts=PTS-STARTPTS,adelay=1000:all=1[a0]',
         'the audio is padded with silence to the same offset');
}

// ── a clip only partly inside the range ────────────────────────────────────

console.log('\npartly inside the range');
{
    const g = filtergraph(spec({
        start: 0, end: 2,
        clips: [clip({ start: 1, length: 10, inPoint: 5 })],
    }));
    same(g.chains[1],
         '[0:v]trim=start=5:end=6,setpts=PTS-STARTPTS+1/TB,scale=1920:1080,format=rgba[v0]',
         'only the second that lands inside the range is asked for');
}

console.log('\nclips outside the range');
{
    const g = filtergraph(spec({
        start: 0, end: 2,
        clips: [clip({ path: 'in.mp4' }), clip({ path: 'later.mp4', start: 30 })],
    }));
    ok(g.ok, 'a clip past the end is not an error');
    same(g.inputs.join(' '), 'in.mp4', 'it is simply not an input');
}

// ── volume and mute ────────────────────────────────────────────────────────

console.log('\naudio that is not heard');
{
    const g = filtergraph(spec({
        clips: [clip({ path: 'a.mp4', volume: 0.5 }), clip({ path: 'b.mp4', muted: true })],
    }));
    ok(g.chains.some((c) => c.indexOf('volume=0.5') >= 0), 'a level becomes a volume filter');
    ok(!g.chains.some((c) => c.indexOf('[1:a]') >= 0), 'a muted clip contributes no audio');
    same(g.audio, '[a0]', 'so the mixer is not needed after all');

    const silent = filtergraph(spec({ audio: false }));
    same(silent.audio, null, 'a silent render has no audio pad');
    ok(!silent.chains.some((c) => c.indexOf(':a]') >= 0), 'and no audio chains');
}

// ── colour ─────────────────────────────────────────────────────────────────
//
// Measured against the renderer, colour is most of the difference between this
// graph and the render it describes: 24.1 dB for the obvious graph against
// 39.1 dB once every conversion is named. Which makes these the assertions
// most worth having, because nothing fails when they are wrong — a file comes
// out, and it is the wrong colour.

console.log('\nthe output conversion');
{
    // "auto" is by frame height, the guess every player makes and the one
    // ffmpeg_export.cpp makes. Getting this boundary wrong tags SD content as
    // HD and shifts every colour in it.
    const hd = filtergraph(spec({ width: 1280, height: 720 }));
    ok(hd.chains[2].indexOf('out_color_matrix=bt709') > 0, '720 lines is BT.709');
    same(hd.colour.matrix, 'bt709', 'and is tagged as such');

    const sd = filtergraph(spec({ width: 640, height: 480 }));
    ok(sd.chains[2].indexOf('out_color_matrix=smpte170m') > 0, '480 lines is SMPTE 170M');
    same(sd.colour.transfer, 'smpte170m', 'with the transfer to match');

    // The scale filter and the stream tag do not share a vocabulary: the tag
    // for non-constant-luminance BT.2020 is bt2020nc and swscale calls it
    // bt2020. One written where the other belongs is accepted by neither.
    const wide = filtergraph(spec({ colorspace: 'bt2020' }));
    same(wide.colour.sws, 'bt2020', 'swscale is told bt2020');
    same(wide.colour.matrix, 'bt2020nc', 'and the stream is tagged bt2020nc');

    const full = filtergraph(spec({ colorRange: 'pc' }));
    ok(full.chains[2].indexOf('out_range=pc') > 0, 'full range is asked for');
    same(full.colour.range, 'pc', 'and reported');

    const forced = filtergraph(spec({ height: 480, colorspace: 'bt709' }));
    same(forced.colour.matrix, 'bt709', 'an explicit choice beats the height');

    const px = filtergraph(spec({ pixelFormat: 'yuv422p10le' }));
    ok(px.chains[2].indexOf(',format=yuv422p10le[vout]') > 0,
       'a chosen pixel format is converted to inside the graph');
}

console.log('\nthe source conversion');
{
    // All three of matrix, source range and destination range, or none. Two of
    // the three is worse than none — measured at 24.1 dB against 26.8 dB — so
    // there is no partial spelling to fall into.
    const known = filtergraph(spec(), [{ colorSpace: 'bt470bg', colorRange: 'tv', height: 480 }]);
    ok(known.chains[1].indexOf(
        'scale=1920:1080:in_color_matrix=bt601:in_range=tv:out_range=full') > 0,
       'a tagged source is converted through its own matrix');
    same(known.caveats.length, 0, 'and there is nothing to warn about');

    const untagged = filtergraph(spec(), [{ colorSpace: '', colorRange: '', height: 1080 }]);
    ok(untagged.chains[1].indexOf('in_color_matrix=bt709') > 0,
       'an untagged tall source falls back to BT.709, as the renderer does');
    const small = filtergraph(spec(), [{ colorSpace: '', colorRange: '', height: 576 }]);
    ok(small.chains[1].indexOf('in_color_matrix=bt601') > 0,
       'and an untagged short one to BT.601');

    const unknown = filtergraph(spec());
    ok(unknown.chains[1].indexOf('in_color_matrix') < 0,
       'with nothing known about the source, nothing is claimed about it');
    ok(unknown.caveats.some((c) => c.indexOf('colour') >= 0),
       `and that is said out loud: "${unknown.caveats[0]}"`);
}

console.log('\nthe caveat that cannot be fixed');
{
    const matched = filtergraph(spec({ fps: 30 }), [{ colorSpace: 'bt709', height: 1080, fps: 30 }]);
    same(matched.caveats.length, 0, 'a render at the source rate has nothing to warn about');

    const resampled = filtergraph(spec({ fps: 25 }), [{ colorSpace: 'bt709', height: 1080, fps: 30 }]);
    ok(resampled.caveats.some((c) => c.indexOf('rate') >= 0),
       `30 into 25 is called out: "${resampled.caveats.find((c) => c.indexOf('rate') >= 0)}"`);
}

// ── what it refuses ────────────────────────────────────────────────────────
//
// A graph that is nearly right is worse than no graph: the only reason to show
// one is that it can be taken somewhere else and run.

// ── the graph to run, as opposed to the graph to print ─────────────────────
//
// `bro.ffmpeg.render.start` takes the same graph, with two differences that are
// both consequences of the renderer not being a standalone ffmpeg: the tail
// that converts into the encoder's colour belongs to the writer on this path,
// and the inputs are named rather than numbered. Everything else has to be
// identical, or the render and the command shown above it are two different
// edits.

console.log('\nthe same graph, to run rather than to print');
{
    const s = spec({ clips: [clip(), clip({ x: 960, z: 1, opacity: 0.5 })] });
    const shown = filtergraph(s);
    const run = renderGraph(s);
    ok(run.ok, 'it can be rendered');

    const shownChains = shown.chains;
    const runChains = run.filterGraph.split(';');
    same(runChains.length, shownChains.length, 'the same number of chains');
    const differing = [];
    for (let i = 0; i < shownChains.length; i++)
        if (runChains[i] !== shownChains[i]) differing.push(i);
    same(differing.length, 1, 'exactly one of them differs');
    ok(differing.length === 1 && shownChains[differing[0]].endsWith('[vout]'),
       'and it is the one that ends at [vout]');

    same(chainFrom(run, '[o0][v1]'),
         '[o0][v1]overlay=960:0:eof_action=pass[vout]',
         'the last overlay stops in the compositing space');
    same(chainFrom(shown, '[o0][v1]'),
         '[o0][v1]overlay=960:0:eof_action=pass,' +
         'scale=in_range=full:out_color_matrix=bt709:out_range=tv[vout]',
         'where the printed one goes on into the encoder’s');

    // A pad each, grouped by input, because an input node *is* one file: the
    // picture and the sound of clip zero are two outputs of one `-i` rather
    // than two things that happen to name the same path.
    same(JSON.stringify(run.filterInputs),
         JSON.stringify([{ label: '0:v', path: 'a.mp4', stream: 'v', from: 0 },
                         { label: '0:a', path: 'a.mp4', stream: 'a', from: 0 },
                         { label: '1:v', path: 'a.mp4', stream: 'v', from: 0 },
                         { label: '1:a', path: 'a.mp4', stream: 'a', from: 0 }]),
         'every pad the graph reads says which file and which kind of stream feeds it');

    // `from` is where the renderer seeks each input to. It is not in the
    // printed command — a command line says the same thing with `trim`, and
    // that is what makes the two forms differ by only the colour chain — but
    // without it every input decodes from the start of its file, which for a
    // clip an hour in is an hour.
    //
    // Never *later* than what `trim` will ask for, which is the whole safety
    // argument: the seek is backward-seeking, so being early costs decoding and
    // being late is not reachable.
    const late = renderGraph({
        width: 1920, height: 1080, fps: 30, start: 0, end: 2, audio: true,
        clips: [{ path: 'a.mp4', start: 0, length: 2, inPoint: 615.5,
                  x: 0, y: 0, w: 1920, h: 1080,
                  crop: { l: 0, t: 0, r: 0, b: 0 },
                  opacity: 1, volume: 1, muted: false, z: 0 }],
    });
    same(late.filterInputs[0].from, 615.5, 'a clip with an in-point says where to seek to');
    ok(late.filterGraph.indexOf('trim=start=615.5') > 0,
       'the same number the trim in the graph is cut at');

    // A pixel format is the encoder's business on this path, so it must not
    // appear in what runs — the writer would then convert into it twice.
    const withFormat = renderGraph(spec({ pixelFormat: 'yuv422p' }));
    ok(withFormat.filterGraph.indexOf('yuv422p') < 0,
       'a chosen pixel format stays out of the graph that runs');
    ok(filtergraph(spec({ pixelFormat: 'yuv422p' })).chains.join(';').indexOf('yuv422p') > 0,
       'and stays in the one that is printed');

    // A refusal is a refusal on both paths. Rendering an edit the graph cannot
    // express would be worse than printing one.
    ok(!renderGraph(spec({ clips: [] })).ok, 'and an edit it cannot express is still refused');
}

console.log('\nrefusals');
{
    const empty = filtergraph(spec({ clips: [] }));
    ok(!empty.ok && typeof empty.reason === 'string', `no clips: ${empty.reason}`);

    const noRange = filtergraph(spec({ start: 3, end: 3 }));
    ok(!noRange.ok, `an empty range: ${noRange.reason}`);

    const goneEntirely = filtergraph(spec({
        clips: [clip({ crop: { l: 0.6, t: 0, r: 0.6, b: 0 } })],
    }));
    ok(!goneEntirely.ok, `cropped past nothing: ${goneEntirely.reason}`);

    const noRect = filtergraph(spec({ clips: [clip({ w: 0 })] }));
    ok(!noRect.ok, `no rectangle: ${noRect.reason}`);

    const notANumber = filtergraph(spec({ clips: [clip({ x: NaN })] }));
    ok(!notANumber.ok, `NaN in a rectangle: ${notANumber.reason}`);

    ok(!filtergraph(null).ok, 'no spec at all');

    // Every refusal has to be one the caller can show. A blank reason is a
    // dialog that says nothing.
    for (const r of [empty, noRange, goneEntirely, noRect, notANumber])
        ok(r.reason && r.reason.length > 8, `"${r.reason}" is worth printing`);
}

console.log(`\nPASS ui_filtergraph — ${checks} checks`);
