// Subtitles, driven the way a person drives them.
//
// There are exactly three things anybody wants from subtitles and they are
// three different mechanisms in ffmpeg, so this follows all three from the file
// arriving to the file coming out:
//
//   - **A track beside the picture.** A stream row on the Write stage, saying
//     where its cues come from — carried through as packets, or decoded and
//     written again in whatever the container holds. `-map 1:0 -c:s mov_text`.
//   - **Burned into the picture.** A `subtitles` filter, placed as an ordinary
//     node, with the path escaped the way libavfilter needs it — which is a
//     trap with a very poor error message. It has two homes and they are two
//     different clocks: over the whole canvas from the Sources stage, for cues
//     written against the finished programme, and on one clip from its
//     properties panel, for a track that belongs to that file. Only the second
//     can be shown in the viewer, and it is.
//   - **Out on its own.** A render whose only stream is subtitles, which is
//     what "extract them" and "convert the format" both are.
//
// And one thing that is deliberately *not* here: the viewer never shows a
// **soft** subtitle track. bro's `<video>` decodes pictures and sound, and a
// track a player can switch off is neither — so the honest answer is a sentence
// on the stage, and a way to make the cues part of the picture if that is what
// was meant.
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
// A `<select>` and a text field are set the same way — write the value, then
// send `change` — so this is `type` under the name that reads right at a menu.
// One body: two identical ones are two things to keep in step.
const choose = type;

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
ok(el('src-list').textContent.indexOf('written') >= 0,
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

// **What a new row defaults to is asked, not preferred**, and the carry branch
// is the half nothing tested. `avformat_query_codec` says Matroska holds
// subrip, so a row added here reads the packets as they are; the identical
// track into an mp4 came out `decode:` above, because mp4 holds exactly one
// subtitle codec and it is not this one. Defaulting to either unconditionally
// gets half the rows wrong — and the wrong half that still renders, a needless
// re-encode of a track that could have been carried, is the half nobody
// notices.
{
    click(q('[data-add="subtitle"]'));
    pump(60);
    const S = A.exporter.currentSettings();
    const added = S.streams.filter((s) => s.kind === 'subtitle').pop();
    ok(added && /^copy:/.test(added.source),
       `into Matroska a new row carries the packets it already has (${added && added.source})`);
    S.streams = S.streams.filter((s) => s !== added);
    A.exporter.redraw();
    pump(60);
}

A.exporter.currentSettings().container = before;
A.exporter.redraw();
pump(60);

// ── what the window does to the cues ───────────────────────────────────────
//
// Two numbers on the row cut the track, and they cut it **differently
// depending on how the row reads it**: a conversion keeps a cue by where it
// begins, and a copy takes whole packets from a backward seek, so the cue that
// was on screen at the in-point comes too and its stamp — not the in-point —
// becomes the output's zero. The fixture's cues are at 1–2, 4–5.5 and 7–8, so
// an in-point of 4.5 is inside the second one and the two ways disagree about
// it. That disagreement is the whole section.

console.log('\nwhere the cues are');
const cueList = bro.ffmpeg.cueTimes(cues);
ok(cueList.cues.length === 3,
   `libavformat reports the cues off the packets, no decoder opened (${cueList.cues.length})`);
ok(Math.abs(cueList.cues[1].start - 4) < 0.01 && Math.abs(cueList.cues[1].end - 5.5) < 0.01,
   `each with the span it is on screen for (${cueList.cues[1].start}–${cueList.cues[1].end})`);

// The detail panel is where the window lives, and the row was left open by the
// picker above; opened here rather than assumed, because which row is open is
// state this suite has been moving around.
if (!q(`[data-stream="${srow.id}"] .ex-cue`)) {
    click(q(`[data-stream="${srow.id}"] [data-f="detail"]`));
    pump(60);
}
const drawn = qq(`[data-stream="${srow.id}"] .ex-cue`);
same(drawn.length, 3, 'the row draws one entry per cue');
ok(drawn[1].textContent.indexOf('4.00') >= 0 && drawn[1].textContent.indexOf('5.50') >= 0,
   `written as the span it covers rather than as a mark (${drawn[1].textContent})`);

type(q(`[data-stream="${srow.id}"] [data-f="copy-copyFrom"]`), '4.5');
pump(60);

// A conversion: the cue on screen at 4.5 began at 4.0, so it is dropped.
const conv = A.subtitles.cueWindow(srow, cueList);
same(conv.kept.length, 1,
     'a conversion opening at 4.5 s keeps only the cue that starts after it');
same(conv.zero, 4.5, 'and the output’s zero is the moment asked for, exactly');
const convNote = q(`[data-stream="${srow.id}"] .ex-copy-note`).textContent;
ok(convNote.indexOf('drops it') >= 0,
   `the row says the cue is lost rather than leaving it to the file (${convNote.slice(0, 60)}…)`);
const snap = q(`[data-stream="${srow.id}"] [data-f="cue-snap"]`);
ok(!!snap && snap.textContent.indexOf('4.00') >= 0,
   `and offers the cue’s own start as the fix (${snap && snap.textContent})`);
click(snap);
pump(60);
same(srow.copyFrom, 4, 'pressing it opens the window on that cue');
same(A.subtitles.cueWindow(srow, cueList).kept.length, 2, 'which takes it back in');

// The same two numbers, carried instead of converted. Nothing about the file
// changed; what the window means did.
choose(q(`[data-stream="${srow.id}"] [data-f="stream-source"]`), 'copy:1:0');
pump(60);
if (!q(`[data-stream="${srow.id}"] .ex-cue`)) {
    click(q(`[data-stream="${srow.id}"] [data-f="detail"]`));
    pump(60);
}
type(q(`[data-stream="${srow.id}"] [data-f="copy-copyFrom"]`), '4.5');
pump(60);
const copyWin = A.subtitles.cueWindow(srow, cueList);
same(copyWin.kept.length, 2,
     'a copy opening at 4.5 s keeps the cue that was on screen there as well');
same(copyWin.zero, 4, 'because the copy begins on that cue, which becomes the output’s zero');
const copyNote = q(`[data-stream="${srow.id}"] .ex-copy-note`).textContent;
ok(copyNote.indexOf('4.00') >= 0 && copyNote.indexOf('clock starts') >= 0,
   `and the row says where the clock really starts (${copyNote.slice(0, 60)}…)`);
ok(Array.from(qq(`[data-stream="${srow.id}"] .ex-cue`))
        .filter((n) => n.className.indexOf('on') >= 0).length === 1,
   'one entry is marked as the one the output starts on');

// A window that opens *after* a cue has finished still carries it, which is
// the part of the packet path that surprises people: the seek is backward and
// takes whole packets, so 6 s — silence between two cues — still begins on the
// one at 4 s.
type(q(`[data-stream="${srow.id}"] [data-f="copy-copyFrom"]`), '6');
pump(60);
same(A.subtitles.cueWindow(srow, cueList).zero, 4,
     'and a window opening in the silence after a cue still begins on it');

choose(q(`[data-stream="${srow.id}"] [data-f="stream-source"]`), 'decode:1:0');
srow.copyFrom = 0;
A.exporter.redraw();
pump(60);

// ── the honesty ────────────────────────────────────────────────────────────

console.log('\nwhat cannot be shown');
const warned = A.exporter.currentWarnings().join(' | ');
ok(warned.indexOf('viewer cannot show') >= 0,
   'the stage says out loud that the viewer will not show the track');
ok(warned.indexOf('decodes pictures and sound') >= 0,
   'and says why, rather than leaving it looking like the track was not written');
ok(warned.indexOf('Burn in') >= 0,
   'and where the viewer *will* show cues, which is a different statement about the file');

// The one thing an attachment is for, said where the ASS row was added. A
// styled track that carries no font looks different on every machine, and an
// `+ Attachment` button on its own gives nobody a reason to press it.
A.exporter.currentSettings().container = 'matroska';
choose(q(`[data-stream="${srow.id}"] [data-f="stream-source"]`), 'decode:1:0');
srow.codec = 'ass';
A.exporter.redraw();
pump(60);
const styled = A.exporter.currentWarnings().join(' | ');
ok(styled.indexOf('names its fonts by name') >= 0,
   'an ASS track with no font attached says what that costs');
srow.codec = '';
A.exporter.currentSettings().container = 'mp4';
A.exporter.redraw();
pump(60);

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

// ── and a rewrap keeps them ────────────────────────────────────────────────
//
// `Rewrap <file>` used to write a row for every video and audio stream and
// silently leave the subtitle track behind — a shortcut that *succeeds* and
// hands back a file that is not the one it was asked for, which is the worst
// outcome this stage has. It writes a `copy:` row for the cues too now, which
// is the honest first answer for a shortcut that deliberately leaves the
// container alone: the packets that are already there, on an ordinary row that
// can be flipped to `convert` if the target will not hold them.

console.log('\na rewrap keeps the cues');
{
    A.shell.goTo('sources');
    pump(60);
    type(el('src-path'), outPath);
    click(el('src-add'));
    pump(120);
    const made = A.inputs.inputs[A.inputs.inputs.length - 1];
    ok(!!made.probe && made.probe.streams.some((s) => s.kind === 'subtitle'),
       'the file just written is opened as an input, cues and all');

    A.shell.goTo('write');
    pump(80);
    const button = q(`#ex-streams [data-rewrap="${made.id}"]`);
    ok(!!button, 'and the stage offers to rewrap it');
    click(button);
    pump(80);

    const made2 = A.exporter.buildSpec().streams;
    ok(made2.every((s) => /^copy:/.test(s.source)),
       `every row of a rewrap is still a copy (${made2.map((s) => s.source).join(' ')})`);
    const cue = made2.find((s) => s.kind === 'subtitle');
    ok(!!cue, 'including one for the subtitle track, which used to be dropped');
    ok(cue && /^copy:/.test(cue.source),
       `carried rather than converted (${cue && cue.source})`);
    ok(commandText().indexOf('-c:s copy') >= 0 ||
       /-c:s:\d+ copy/.test(commandText()),
       'and the command copies it');

    A.exporter.currentSettings().streams = A.exporter.defaultStreams();
    A.exporter.currentSettings().audio = true;
    A.exporter.redraw();
    pump(60);
}

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

// ── burned into one clip, and on the screen ────────────────────────────────
//
// The other half of burning in, and the half the viewer can show. A `subtitles`
// node over the whole canvas is on the *render's* clock and there is nowhere in
// playback for a filter over the composite to run — the viewer draws a clip per
// element. A node on one clip is on that clip's own chain, above the `setpts`
// that turns the file's clock into the edit's, which is the clock a track
// inside the file and an `.srt` written for the file are both on. So it plays.
//
// Three things are checked here and none of them is "it rendered": which stream
// the filter is told to draw, where the node lands, and that the element in
// front of you is playing the chain with it in.

console.log('\nburned into one clip');
{
    const S = A.subtitles;
    // **`si=` counts subtitle streams, not streams.** Checked against a shape
    // written out here rather than against a file, because the shape that
    // catches it — two subtitle tracks, so that the second one's ordinal and
    // its stream index are different numbers — is not what any fixture is for.
    const shape = { streams: [{ index: 0, kind: 'video' }, { index: 1, kind: 'audio' },
                              { index: 2, kind: 'subtitle' }, { index: 3, kind: 'subtitle' }] };
    same(S.subtitleOrdinal(shape, 2), 0, 'the first subtitle track of a file is si=0');
    same(S.subtitleOrdinal(shape, 3), 1,
         'and the second is si=1 — never si=3, which is where its packets are');
    same(S.subtitleOrdinal(shape, 1), -1, 'a stream that is not one is not counted at all');
    same(S.burnParams('x.srt', 1).si, '1', 'a node for the second says so');
    same(S.burnParams('x.srt', 0).si, undefined,
         'and one for the first says nothing, because si=0 is what the filter does anyway');
    ok(S.canBurn({ kind: 'subtitle', textSub: true }) &&
       !S.canBurn({ kind: 'subtitle', textSub: false }),
       'and pictures of characters are refused, because libass reads characters');
}

A.graph.overlay.clear();
pump(80);
const vclip = A.project.clips[0];
A.select(vclip);
A.showProperties();
pump(80);

// The clip is `landscape.mp4`, which carries no cues of its own — so the one
// row is the file of cues that is open, offered against the clip it would be
// drawn on. A subtitle file is routinely named nothing like the video, so this
// is not filtered by name.
let burns = Array.from(qq('[data-burn]'));
same(burns.length, 1, 'the clip offers the file of cues that is open');
click(burns[0]);
pump(400);

const onClip = A.graph.overlay.inserts().find((r) => r.filter === 'subtitles');
ok(!!onClip, 'pressing it places an ordinary subtitles node');
same(onClip && onClip.anchor, `clip:${vclip.id}/after-decode`,
     'on that clip, above the setpts — which is the clock the cues were written on');
ok(onClip && String(onClip.params.filename).indexOf('cues.srt') >= 0,
   'naming the file, escaped as a filter argument');
same(onClip && onClip.params.si, undefined,
     'and saying nothing about which stream, because a file of cues has one');

ok(vclip.video.src.indexOf('/@fx/') === 0,
   'and the viewer plays the clip with the burn-in on it');
const burnView = A.graph.playback.viewFor(vclip.id);
ok(burnView && burnView.video.indexOf('subtitles=') === 0,
   `at the head of the chain, before the clock moves: ${burnView && burnView.video}`);

cmd = commandText();
ok(cmd.indexOf('subtitles=') >= 0 && cmd.indexOf('[0:v]') >= 0,
   'and the command bar prints it inside the clip’s own chain');

burns = Array.from(qq('[data-burn]'));
same(burns[0].textContent, 'Burned in', 'the button now says the track is on');
click(burns[0]);
pump(400);
ok(!A.graph.overlay.inserts().some((r) => r.filter === 'subtitles'),
   'and pressing it again takes the node off');
same(vclip.video.src, vclip.src,
     'putting the element back on the plain input, exactly');

// A track *inside* a file, which is the common case and the one that needs a
// stream named. The file is the one this test rendered above: an mp4 whose
// streams run video, audio, subtitle — so a burn-in that handed the filter the
// stream index would say `si=2` and draw nothing.
console.log('\na track inside the file');
A.open(outPath);
waitFor('the rendered file to come back as a clip', () => A.project.clips.length === 2);
pump(300);
const sclip = A.project.clips[1];
A.select(sclip);
A.showProperties();
pump(80);

burns = Array.from(qq('[data-burn]'));
same(burns.length, 2, 'its own track is offered beside the cue file');
const rowText = burns[0].parentNode.parentNode.textContent;
ok(rowText.indexOf('2: mov_text') >= 0,
   `the row names the stream the way every other stream is named (${rowText.trim()})`);
click(burns[0]);
pump(400);

const inFile = A.graph.overlay.inserts().find((r) => r.filter === 'subtitles');
ok(!!inFile && String(inFile.params.filename).indexOf('ui-subs.mp4') >= 0,
   'the node reads the clip’s own file, which is what subtitles= takes');
same(inFile && inFile.params.si, undefined,
     'and asks for si=0 by saying nothing — the track is stream 2 and the first of its kind');
ok(sclip.video.src.indexOf('/@fx/') === 0, 'the viewer plays it');
A.graph.overlay.clear();
pump(200);

// ── and back out again ─────────────────────────────────────────────────────
//
// **The escaping has to round-trip**, because the Sources stage reads a
// `movie=`'s filename back to say which file the graph is opening and to offer
// to make it an `-i`. What is written is quoted *and* backslash-escaped — a
// colon separates a filter's arguments and a comma ends the filter — and what
// read it back took only the backslashes off, so the offer handed `addInput` a
// path with an apostrophe on the front of it and the open failed on a filename
// nobody had typed.

console.log('\nthe escaping comes back off');
{
    // Written out by hand rather than asked of the code, so that this states
    // the encoding instead of agreeing with whatever it happens to be: forward
    // slashes, the colon escaped, the lot quoted.
    const escaped = `'${cues.replace(/\\/g, '/').replace(/([:'])/g, '\\$1')}'`;
    ok(/^'.*\\:.*'$/.test(escaped) || cues.indexOf(':') < 0,
       `a filter argument for it is ${escaped}`);

    A.graph.overlay.clear();
    // A free node, because `movie` reads no pad and so cannot be spliced onto
    // a wire — which is exactly how somebody reaches for one.
    A.graph.overlay.addNode('movie', { params: { filename: escaped } });
    A.shell.goTo('sources');
    pump(150);

    const rows = Array.from(qq('#src-list .src-demux'))
                      .map((n) => n.textContent).filter((t) => /movie/.test(t));
    ok(rows.length === 1, 'the file a movie node names is listed under Opened by the graph');
    ok(rows[0].indexOf(cues) >= 0,
       `as the path, with the quotes and the escapes off (${rows[0].trim()})`);
    ok(rows[0].indexOf("'") < 0 && rows[0].indexOf('\\:') < 0,
       'and neither layer left behind');
    A.graph.overlay.clear();
    pump(80);
}

console.log(`\n${checks} checks passed`);
