// Subtitles, driven the way a person drives them.
//
// There are exactly three things anybody wants from subtitles and they are
// three different mechanisms in ffmpeg, so this follows all three from the file
// arriving to the file coming out:
//
//   - **A track beside the picture.** A stream row on the Write stage, saying
//     where its cues come from — carried through as packets, or decoded and
//     written again in whatever the container holds. `-map 1:0 -c:s mov_text`.
//   - **Burned into the picture.** A `subtitles` filter on the Graph stage,
//     placed as an ordinary node, with the path escaped the way libavfilter
//     needs it — which is a trap with a very poor error message.
//   - **Out on its own.** A render whose only stream is subtitles, which is
//     what "extract them" and "convert the format" both are.
//
// And one thing that is deliberately *not* here: the viewer never shows a soft
// subtitle track. There is no subtitle path in playback, which is the same
// structural reason a filter cannot be previewed there, and the honest answer
// is a sentence on the stage rather than an overlay that would then disagree
// with the render.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_subtitles.js -- <fixture-directory>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const dir = args[0];
assert(dir, 'pass the fixture directory: ... tests/ui_subtitles.js -- <dir>');
const media = `${dir}/landscape.mp4`;
const cues = `${dir}/cues.srt`;

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
const q = (sel, root) => (root || document).querySelector(sel);
const qq = (sel, root) => (root || document).querySelectorAll(sel);
const f = (name) => q(`[data-f="${name}"]`);
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

function type(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}
function choose(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

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

// The graph overlay outlives the process — it is the only thing in this
// application that is remembered between runs — so a second run of this suite
// would start with the `subtitles` node the first one placed and count two.
localStorage.removeItem('ffmpeg-bro.graph');

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
A.graph.overlay.clear();

/// The printed command as one string, which is what the bar shows and what
/// `Copy` puts on the clipboard.
function commandText() {
    const p = A.command.parts();
    const head = p.pre.concat(p.inputs)
        .concat(p.graphUsed ? ['-filter_complex', p.graph.chains.join(';')] : [])
        .join(' ');
    return p.tails.map((t) => `${head} ${t.join(' ')}`).join('\n');
}

// ── what this build can write ──────────────────────────────────────────────

console.log('\nwhat this build has');
const sencs = bro.ffmpeg.subtitleEncoders || [];
ok(sencs.length > 0, `${sencs.length} subtitle encoders, discovered rather than listed`);
const named = (id) => sencs.some((e) => e.id === id);
ok(named('mov_text') && named('ass') && named('webvtt') && named('subrip'),
   'including the formats everything converts between');
const assInfo = sencs.find((e) => e.id === 'ass');
ok(assInfo && assInfo.textSub === true, 'ass is reported as text rather than pictures');
const dvd = sencs.find((e) => e.id === 'dvdsub');
ok(!dvd || dvd.textSub === false, 'and dvdsub as pictures of it');

const mp4 = (bro.ffmpeg.muxers || []).find((m) => m.name === 'mp4');
same(mp4.subtitleCodec, 'mov_text',
     'mp4’s subtitle codec is what it answers for, not what it declares ' +
     `(declares "${mp4.defaultSubtitle}")`);
ok(mp4.subtitleCodecs.indexOf('mov_text') >= 0, 'and it is in the list the picker draws from');

// ── a subtitle file is an -i ───────────────────────────────────────────────

console.log('\na file of cues is an input');
dropFiles(400, 300, [media]);
waitFor('the clip to arrive', () => A.project.clips.length === 1);
pump(200);

A.shell.goTo('sources');
pump(60);
type(el('src-path'), cues);
click(el('src-add'));
pump(80);

same(A.inputs.inputs.length, 2, 'adding it makes a second input — a file the render opens');
const sub = A.inputs.inputs[1];
ok(!!sub.probe, 'it probed');
same(A.inputs.kindOf(sub), 'subtitles',
     'and is recognised as subtitles from what libavformat found in it, not from its name');
same(A.project.clips.length, 1, 'nothing was laid out from it — there is no picture to lay out');

const detail = el('src-detail').textContent;
ok(detail.indexOf('Subtitles') >= 0, 'the panel says what it is');
ok(detail.indexOf('subtitles=') >= 0,
   'and states it as the filter argument it would be, escaped');
// The trap this exists for: a drive letter's colon separates a filter's
// arguments, so a Windows path goes in unusable and the error names half of it.
ok(detail.indexOf('\\:') >= 0 || cues.indexOf(':') < 0,
   'with the colon escaped, because a colon separates a filter’s arguments');

ok(el('src-list').textContent.indexOf('unused') >= 0,
   'the card says it is unused, because nothing is reading it yet');

// ── a track beside the picture ─────────────────────────────────────────────

console.log('\na soft subtitle track');
A.shell.goTo('write');
pump(80);

const add = q('[data-add="subtitle"]');
ok(!!add, '+ Subtitle is offered, because mp4 holds one and there is a file to read');
click(add);
pump(60);

const rows = A.exporter.currentSettings().streams;
const srow = rows.find((s) => s.kind === 'subtitle');
ok(!!srow, 'a subtitle row is added');
ok(/^decode:1:0$/.test(srow.source),
   `and arrives reading the file that is open (${srow.source})`);

const label = Array.from(qq('.ex-stream-n')).map((n) => n.textContent);
ok(label.indexOf('S1') >= 0, `it is numbered as a subtitle stream (${label.join(' ')})`);

const picker = q('[data-stream="' + srow.id + '"] [data-f="stream-source"]');
ok(!!picker, 'the row says where its cues come from');
const offers = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
ok(offers.indexOf('copy:1:0') >= 0 && offers.indexOf('decode:1:0') >= 0,
   'offering both ways of reading one track — carried, and converted');

const codecPick = q('[data-stream="' + srow.id + '"] [data-f="stream-codec"]');
ok(!!codecPick, 'and what it comes out as');
const codecs = Array.from(codecPick.querySelectorAll('option')).map((o) => o.value);
ok(codecs.indexOf('subrip') < 0,
   'which does not offer a codec mp4 will refuse — the menu is avformat_query_codec');

// The Sources stage now knows the file is being written, which is the other
// way an input is used without a clip being cut from it.
A.shell.goTo('sources');
pump(60);
ok(el('src-list').textContent.indexOf('written into the output') >= 0,
   'and the Sources card stops calling it unused');
A.shell.goTo('write');
pump(60);

// ── the command ────────────────────────────────────────────────────────────

console.log('\nwhat the command says');
let cmd = commandText();
ok(cmd.indexOf('cues.srt') >= 0, 'the subtitle file is printed as an -i of its own');
ok(/-map \d+:0/.test(cmd), 'with a -map naming its stream');
ok(cmd.indexOf('-c:s mov_text') >= 0 || cmd.indexOf('-c:s:0 mov_text') >= 0,
   `and -c:s saying what it is written as (${(cmd.match(/-c:s\S* \S+/) || [])[0]})`);

// Carried instead of converted: the same -map, a different -c:s. That is the
// whole of the difference and the command has to show it as the whole of it.
choose(picker, 'copy:1:0');
pump(60);
cmd = commandText();
ok(cmd.indexOf('-c:s copy') >= 0 || cmd.indexOf('-c:s:0 copy') >= 0,
   'carrying it through prints -c:s copy instead');
choose(q('[data-stream="' + srow.id + '"] [data-f="stream-source"]'), 'decode:1:0');
pump(60);

// ── the container decides ──────────────────────────────────────────────────

console.log('\nwhich container');
const before = A.exporter.currentSettings().container;
A.exporter.currentSettings().container = 'matroska';
A.exporter.redraw();
pump(60);
const mkvCodecs = Array.from(
    q(`[data-stream="${srow.id}"] [data-f="stream-codec"]`)
        .querySelectorAll('option')).map((o) => o.value);
ok(mkvCodecs.indexOf('ass') >= 0 || mkvCodecs.indexOf('ssa') >= 0,
   `Matroska offers the ASS encoder (${mkvCodecs.join(' ')})`);
ok(mkvCodecs.indexOf('subrip') >= 0, 'and subrip, which mp4 would not take');
A.exporter.currentSettings().container = before;
A.exporter.redraw();
pump(60);

// ── the honesty ────────────────────────────────────────────────────────────

console.log('\nwhat cannot be shown');
const warned = A.exporter.currentWarnings().join(' | ');
ok(warned.indexOf('viewer cannot show') >= 0,
   'the stage says out loud that the viewer will not show the track');
ok(warned.indexOf('no subtitle path in playback') >= 0,
   'and says why, rather than leaving it looking like the track was not written');

// ── the render ─────────────────────────────────────────────────────────────

console.log('\nthe file that comes out');
const outPath = bro.appDir + '/../out/ui-subs.mp4';
const spec = A.exporter.buildSpec({ path: outPath, format: 'mp4', start: 0, end: 3 });
const subSpec = (spec.streams || []).find((s) => s.kind === 'subtitle');
ok(!!subSpec && subSpec.source === 'decode:1:0',
   'the spec the renderer is handed carries the subtitle stream');
ok((spec.inputs || []).some((i) => i.path === cues),
   'and the cue file among the inputs it will open');

bro.ffmpeg.render.start(spec);
waitFor('the render to finish', () => {
    const p = bro.ffmpeg.render.poll();
    return p.state !== 'running';
}, 120000);
const done = bro.ffmpeg.render.poll();
ok(done.state === 'done', `it rendered (${done.state}${done.error ? ': ' + done.error : ''})`);

const back = bro.ffmpeg.probe(outPath);
const track = back.streams.find((s) => s.kind === 'subtitle');
ok(!!track, 'the file has a subtitle stream in it');
same(track && track.codec, 'mov_text', 'written as mov_text, which is what mp4 holds');

// ── burned in ──────────────────────────────────────────────────────────────

console.log('\nburned into the picture');
// Taken off the stream list first: burning in and muxing a track are two
// different answers to the same question, and doing both would be checking
// neither.
A.exporter.currentSettings().streams =
    A.exporter.currentSettings().streams.filter((s) => s.kind !== 'subtitle');
A.exporter.redraw();
pump(40);

A.shell.goTo('sources');
pump(60);
// The card for the cue file has to be the selected one for its panel to be up.
click(q(`[data-input="${sub.id}"]`));
pump(60);
const burn = f('srcburn');
ok(!!burn, 'the subtitle input offers to burn itself into the picture');
click(burn);
pump(120);

same(A.shell.currentStage(), 'graph', 'which takes you to the graph, where the node now is');
const inserted = A.graph.overlay.inserts().filter((r) => r.filter === 'subtitles');
same(inserted.length, 1, 'and what it placed is an ordinary insert, not a private path');
ok(String(inserted[0].params.filename).indexOf('cues.srt') >= 0,
   'carrying the file, escaped as a filter argument');

cmd = commandText();
ok(cmd.indexOf('subtitles=') >= 0, 'the command bar prints the filter');
ok(/subtitles=filename='[^']*cues\.srt'/.test(cmd),
   'with the path quoted the way libavfilter reads it ' +
   `(${(cmd.match(/subtitles=filename='[^']*'/) || [])[0]})`);

const burnSpec = A.exporter.buildSpec({ path: bro.appDir + '/../out/ui-burn.mp4',
                                        format: 'mp4', start: 0, end: 2 });
ok(!!burnSpec.filterGraph && burnSpec.filterGraph.indexOf('subtitles=') >= 0,
   'and the render goes through libavfilter, with the filter in the graph it parses');

bro.ffmpeg.render.start(burnSpec);
waitFor('the burn-in to finish', () => bro.ffmpeg.render.poll().state !== 'running', 120000);
const burned = bro.ffmpeg.render.poll();
ok(burned.state === 'done',
   `a burned-in render writes a file (${burned.state}${burned.error ? ': ' + burned.error : ''})`);
const burnedBack = bro.ffmpeg.probe(bro.appDir + '/../out/ui-burn.mp4');
ok(!burnedBack.streams.some((s) => s.kind === 'subtitle'),
   'with no subtitle stream in it — the cues are the picture now');

console.log(`\n${checks} checks passed`);
