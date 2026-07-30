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

const basenameOf = (p) => String(p).split(/[/\\]/).pop();

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

// ── and what each of them says ─────────────────────────────────────────────
//
// The times above are off the packets. What a cue *says* is a second query with
// a second cost — a decoder per track, opened for the question and closed again
// — and the interesting part is not that words come back but what they are: a
// decoded cue is an **ASS dialogue line**, so the words are the last field after
// eight commas and any markup in them has become `{\i1}` override codes. A
// reader that handed either of those to a panel would put punctuation where the
// line should be.

console.log('\nand what they say');
const words = bro.ffmpeg.cueText(cues);
ok(words.textSub === true, `the track is reported as having words in it (${words.codec})`);
same(words.cues.length, 3, 'one entry per cue, decoded');
same(words.cues[0].text, 'first cue',
     'the words themselves, with the dialogue line’s eight leading fields off');
same(words.cues[1].text, 'second cue\nand its second line',
     'a two-line cue as two lines — \\N in an ASS line is a break the author asked for');
same(words.cues[2].text, 'third cue',
     'and the override codes taken out: {\\i1} is an instruction to a renderer, not a word');
// The two lists are joined by *when*, because neither has an index the other
// shares: an mp4 writes an empty sample between its cues, which is a packet in
// the first list and nothing at all in the second.
same(A.subtitles.cueSaying(words, cueList.cues[2].start), 'third cue',
     'and they line up with the packet times, which is how the panel joins them');
same(A.subtitles.cueSaying(words, 3.3), '', 'with nothing to say about a moment with no cue');
ok(drawn[1].textContent.indexOf('second cue') >= 0,
   `so the row draws the line beside the span (${drawn[1].textContent.trim()})`);

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

// ── a track with no words in it ────────────────────────────────────────────
//
// `dvdsub` is the case every question about a subtitle track forks on, and the
// answer is never an empty column: a bitmap cue is a picture of characters, so
// there is nothing to read and the panel has to *say* which codec that is and
// why. The fixture is a Matroska file with a `dvdsub` track beside a picture —
// skipped where it is absent, like every other fixture section here, because
// this suite also runs against a real file somebody passed it.

console.log('\ncues that are pictures');
{
    const pictures = `${dir}/picture-cues.mkv`;
    let has = false;
    try { has = !!bro.ffmpeg.probe(pictures); } catch (e) { has = false; }
    if (!has) {
        console.log(`  SKIP  no picture-cues.mkv in ${dir} — the bitmap section needs one`);
    } else {
        const said = bro.ffmpeg.cueText(pictures);
        same(said.textSub, false, `the track is reported as pictures (${said.codec})`);
        same(said.cues.length, 0, 'with no cues of words, because there are none to have');
        // The times are still knowable, which is the whole reason the two calls
        // are separate: when a picture of text is on screen is the one thing
        // anybody can say about one.
        same(bro.ffmpeg.cueTimes(pictures).cues.length, 3,
             'while when each picture is on screen is read off the packets as usual');

        A.shell.goTo('sources');
        pump(60);
        type(el('src-path'), pictures);
        click(el('src-add'));
        pump(150);
        const shot = A.inputs.inputs[A.inputs.inputs.length - 1];
        const at = A.inputs.inputs.length - 1;

        A.exporter.currentSettings().container = 'matroska';
        A.shell.goTo('write');
        pump(100);
        click(q('[data-add="subtitle"]'));
        pump(80);
        const brow = A.exporter.currentSettings().streams.filter(
            (s) => s.kind === 'subtitle').pop();
        const bstream = shot.probe.streams.find((s) => s.kind === 'subtitle');
        choose(q(`[data-stream="${brow.id}"] [data-f="stream-source"]`),
               `copy:${at}:${bstream.index}`);
        pump(80);
        if (!q(`[data-stream="${brow.id}"] .ex-cue`)) {
            click(q(`[data-stream="${brow.id}"] [data-f="detail"]`));
            pump(80);
        }
        const bmarks = qq(`[data-stream="${brow.id}"] .ex-cue`);
        same(bmarks.length, 3, 'the row still draws the three cues, off the packets');
        const bnote = Array.from(qq(`[data-stream="${brow.id}"] .ex-copy-note`))
            .map((n) => n.textContent).join(' | ');
        ok(bnote.indexOf('pictures of characters') >= 0,
           'and says the cues are pictures rather than leaving the words blank');
        ok(bnote.indexOf('dvd_subtitle') >= 0,
           `naming the codec it asked libavcodec about (${bnote.slice(0, 70)}…)`);
        ok(bnote.indexOf('libass reads characters') >= 0,
           'and why it cannot be burned in either');

        A.exporter.currentSettings().streams = A.exporter.defaultStreams();
        A.exporter.currentSettings().container = 'mp4';
        A.exporter.redraw();
        pump(60);

        // ── and drawn ───────────────────────────────────────────────────────
        //
        // The one thing a bitmap track *can* have done to it besides being
        // carried. It cannot become text (that is OCR) and it cannot go through
        // libass — so `Burn in` is refused by name — but its cues are pictures
        // and `overlay` draws pictures. What `Draw cues` places is three
        // ordinary nodes, and the check is that they are the right three: an
        // input node reading this file, an `overlay` on *this clip's* chain
        // rather than over the whole canvas, and a wire from the input's
        // subtitle pad to the overlay's second input.
        //
        // The renderer's half of this — that the cue is drawn while it is on and
        // taken *off* when it expires — is measured in `export_test.cpp`, where
        // two renders can be compared frame by frame.

        console.log('\ncues that are pictures, drawn');
        A.graph.overlay.clear();
        pump(80);
        const ripOf = () => A.project.clips.find(
            (c) => c.input && String(c.input.path).indexOf('picture-cues') >= 0);
        A.open(pictures);
        waitFor('the rip to come back as a clip', () => !!ripOf());
        pump(300);
        const rip = ripOf();
        same(A.inputs.streamKinds(rip.input).join(','), 'v,a,s',
             'the input grows a cues pad, because its subtitle track is pictures');
        same(A.inputs.streamKinds(A.inputs.inputs[1]).join(','), 'v',
             'and a text sidecar grows none — libass draws those, which is a filter');

        A.select(rip);
        A.showProperties();
        pump(120);
        const draw = q('[data-draw]');
        ok(!!draw, 'the clip offers Draw cues where Burn in would be refused');
        click(draw);
        pump(400);

        const over = A.graph.overlay.inserts().find((r) => r.filter === 'overlay');
        ok(!!over, 'pressing it places an overlay');
        same(over && over.anchor, `clip:${rip.id}/after-decode`,
             'on that clip’s own chain, which is the clock the cues were written on');
        const src = A.graph.overlay.nodes().find((n) => n.kind === 'input');
        ok(!!src && String(src.input) === String(shot.id),
           'and the input as a node of the graph, so its pads can be wired');
        const wire = A.graph.overlay.wires().find((w) => w.to === (over && over.id));
        ok(!!wire && wire.port === 1, 'wired into the overlay’s second input — what is drawn');
        same(wire && wire.fromPort, A.inputs.streamKinds(rip.input).indexOf('s'),
             'leaving by the cues pad and not by the picture');

        // The printed command, which is the point: `[1:s]` into an overlay is
        // what ffmpeg's own CLI takes, and the bar says in as many words that
        // the pad is not a link libavfilter makes.
        cmd = commandText();
        ok(/\[\d+:s\]/.test(cmd) && cmd.indexOf('overlay') >= 0,
           `the command draws the subtitle pad into an overlay (${(cmd.match(/\[\d+:v\]\[\d+:s\]overlay/) || ['—'])[0]})`);
        ok(A.exporter.buildSpec().filterInputs.some((i) => i.stream === 's'),
           'and the spec the renderer is handed says which pad is cues');

        A.showProperties();
        pump(120);
        same(q('[data-draw]').textContent, 'Cues drawn',
             'the button says the cues are on, read off the nodes rather than remembered');
        click(q('[data-draw]'));
        pump(300);
        ok(!A.graph.overlay.inserts().some((r) => r.filter === 'overlay') &&
           !A.graph.overlay.nodes().some((n) => n.kind === 'input'),
           'and pressing it again takes all three back off');
        A.graph.overlay.clear();
        pump(80);
    }
}

// ── cues of your own ───────────────────────────────────────────────────────
//
// The fourth thing, and the one that is not a file: cues the *document* holds.
// What has to be true of them is a chain, and every link is checked here because
// a break anywhere in it is a subtitle that silently is not in the output.
//
//   - **A fork keeps everything, including the styling.** `cueTextOf` was built
//     for a panel and its `text` is the words with the dialogue fields and the
//     override codes stripped, so a fork through that alone would flatten a
//     styled track. `raw` and `header` are what stop it, and the way to check
//     that is to write the file out and read the styles back — which is why this
//     asserts on `cueFileText` rather than on a render.
//   - **The row is repointed in place**, so the file stops being read. Both
//     copies reaching one output without anybody asking for both is the failure
//     this is the answer to.
//   - **A render writes a real file and passes it as an `-i`.** ffmpeg has no
//     other way to take cues, so this is not an implementation detail: the spec
//     grows an input and the row becomes an ordinary `decode:`.
//   - **The lane is the edit.** Dragging an end, splitting at the playhead and
//     retyping are three gestures on one model, and the third is where styling
//     is lost — one cue at a time and never quietly.

console.log('\ncues the document holds');
{
    const styledFile = `${dir}/cues.ass`;
    let has = false;
    try { has = !!bro.ffmpeg.probe(styledFile); } catch (e) { has = false; }

    A.graph.overlay.clear();
    A.doc.reset();
    pump(200);
    A.open(media);
    waitFor('a clip to work against', () => A.project.clips.length === 1);
    pump(200);

    // ── a track typed from nothing ──
    A.shell.goTo('write');
    pump(120);
    A.exporter.currentSettings().container = 'matroska';
    A.exporter.currentSettings().streams = A.exporter.defaultStreams();
    A.exporter.redraw();
    pump(80);
    click(q('[data-add="subtitle"]'));
    pump(120);
    const typed = A.exporter.currentSettings().streams.find((s) => s.kind === 'subtitle');
    ok(/^cues:\d+$/.test(typed.source),
       `+ Subtitle with no subtitle file open makes a track to type into (${typed.source})`);
    same(A.cues.cueTracks.length, 1, 'which is one cue track in the document');

    const fresh = A.cues.cueTracks[0];
    same(A.cues.fileExtension(fresh), 'srt',
         'a track typed here is written as SubRip — words and times and nothing else');
    same(A.cues.cueFileText(fresh, 0, 0), '',
         'and an empty one writes no file at all, rather than a stream with no cues in it');
    const emptyNote = A.exporter.currentWarnings().join(' | ');
    ok(emptyNote.indexOf('no cue inside the render range') >= 0,
       'which the Write stage says out loud rather than leaving a stream to go missing');

    // ── the lane, and the four presses ──
    A.shell.goTo('compose');
    pump(200);
    const lane = A.timeline.cueLane();
    ok(!!lane.lane && lane.tracks.length === 1,
       'the Cues lane is there because a cue track is — the rule every lane here follows');
    ok(!el('cue-row').classList.contains('hidden'),
       'with the words strip under the waveform, where a timing is judged');

    A.timeline.setView(0, 10);
    A.setPlayhead(1);
    pump(80);
    click(f('cue-add'));
    pump(80);
    same(fresh.cues.length, 1, '+ Cue makes one at the playhead');
    same(`${fresh.cues[0].start}–${fresh.cues[0].end}`, '1–3',
         'two seconds long, because that is a line of dialogue');
    type(f('cue-text'), 'a line I typed');
    pump(80);
    same(fresh.cues[0].text, 'a line I typed', 'and the strip is where its words are written');

    // Dragging an end, through the lane itself rather than through the model —
    // the gesture is the pixels, and `snapTime` is what makes it land on the
    // playhead or a cut. A canvas cannot be asserted against, so the reader is
    // `cueLane()` plus `timeToX`, which is how the When lane is driven too.
    const box = lane.lane.getBoundingClientRect();
    const atX = (t) => box.left + A.timeline.timeToX(t);
    const midY = box.top + lane.rowHeight / 2;
    const down = (x) => lane.lane.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: midY }));
    const moveTo = (x) => document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: midY }));
    const release = (x) => document.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: midY }));

    down(atX(3));
    moveTo(atX(4.5));
    release(atX(4.5));
    pump(80);
    same(fresh.cues[0].end, 4.5, 'dragging a cue’s end retimes it');
    same(A.timeline.selectedCue(), fresh.cues[0], 'and the press selected it, so the strip follows');

    A.setPlayhead(2.5);
    pump(60);
    // Where the playhead *landed*, which is not where it was sent: the transport
    // quantises to the project's frame interval, and a test that asserted 2.5
    // would be asserting that it does not.
    const cutAt = A.transport.t;
    click(f('cue-split'));
    pump(80);
    same(fresh.cues.length, 2, 'Split cuts one cue in two at the playhead');
    same(`${fresh.cues[0].end}/${fresh.cues[1].start}`, `${cutAt}/${cutAt}`,
         'exactly there, both sides');
    same(fresh.cues[0].text, 'a line I typed', 'the words stay with the first half');
    same(fresh.cues[1].text, '',
         'and the second arrives empty — where in the sentence the cut goes is a guess');

    // A split leaves you standing on the *second* half — the one you are about to
    // type into — so the last cue in the track is selected and has nothing after
    // it to join. The press is not there at all in that state, which is the
    // check: a control that is always present and sometimes does nothing is a
    // control that looks broken.
    ok(!f('cue-merge'), 'Merge is not offered on the last cue, because there is nothing after it');
    A.timeline.selectCue(fresh, fresh.cues[0]);
    A.timeline.draw();
    pump(80);
    click(f('cue-merge'));
    pump(80);
    same(fresh.cues.length, 1, 'Merge puts them back together');
    same(fresh.cues[0].end, 4.5, 'over the whole span');

    // One undo step per press, which is what the four kinds are for: a run of
    // one kind folds, so a split and the cue added after it would otherwise be
    // one step and `Ctrl-Z` would answer with neither.
    const before = A.cues.cueTracks[0].cues.length;
    click(f('cue-add'));
    pump(80);
    same(A.cues.cueTracks[0].cues.length, before + 1, 'a second cue');
    A.stepHistory('compose', true);
    pump(120);
    same(A.cues.cueTracks[0].cues.length, before,
         'and one Ctrl-Z takes exactly that press back');

    // ── what the render does with it ──
    A.shell.goTo('write');
    pump(120);
    const typedOut = bro.appDir + '/../out/ui-cues-typed.mkv';
    const typedSpec = A.exporter.buildSpec({ path: typedOut, format: 'matroska',
                                             start: 0, end: 6 });
    const typedRow = (typedSpec.streams || []).find((s) => s.kind === 'subtitle');
    ok(!!typedRow && /^decode:\d+:0$/.test(typedRow.source),
       `by the time the renderer sees it, cues:N is an ordinary ${typedRow && typedRow.source}`);
    ok((typedSpec.cueFiles || []).length === 1 &&
       /\.sub\d+\.srt$/.test(typedSpec.cueFiles[0].path),
       `writing one file beside the output, named from it and the track’s id ` +
       `(${basenameOf(typedSpec.cueFiles[0].path)})`);
    ok((typedSpec.inputs || []).some((i) => i.path === typedSpec.cueFiles[0].path &&
                                            i.format === 'srt'),
       'and the file is among the -i files, with the demuxer named rather than guessed');
    same(typedRow.copyFrom, 0,
         'with no window on it — the cues were shifted onto the output’s clock when written');

    for (const cf of typedSpec.cueFiles) {
        const t = A.cues.trackById(cf.id);
        A.cues.writeCueFile(t, cf.path, cf.from, cf.to);
    }
    bro.ffmpeg.render.start(typedSpec);
    waitFor('the typed cues to render',
            () => bro.ffmpeg.render.poll().state !== 'running', 120000);
    const typedDone = bro.ffmpeg.render.poll();
    ok(typedDone.state === 'done',
       `a track that was typed here renders (${typedDone.state}${typedDone.error ? ': ' +
        typedDone.error : ''})`);
    const typedBack = bro.ffmpeg.cueText(typedOut);
    same(typedBack.cues.length, 1, 'and the cue is in the file');
    same(typedBack.cues[0].text, 'a line I typed', 'saying what was typed');

    // ── forking a styled file, which is where work can be lost ──
    if (!has) {
        console.log(`  SKIP  no cues.ass in ${dir} — the styling section needs one`);
    } else {
        A.shell.goTo('sources');
        pump(80);
        type(el('src-path'), styledFile);
        click(el('src-add'));
        pump(200);
        A.shell.goTo('write');
        pump(150);

        A.exporter.currentSettings().streams = A.exporter.defaultStreams();
        A.exporter.redraw();
        pump(80);
        click(q('[data-add="subtitle"]'));
        pump(150);
        const row = A.exporter.currentSettings().streams.find((s) => s.kind === 'subtitle');
        const readFile = row.source;
        ok(/^(copy|decode):\d+:0$/.test(readFile),
           `with a subtitle file open the row reads it instead (${readFile})`);

        const forkPress = f('cue-fork');
        ok(!!forkPress, 'and offers to take those cues into the document');
        click(forkPress);
        pump(200);

        const fork = A.cues.cueTracks[A.cues.cueTracks.length - 1];
        ok(row.source === `cues:${fork.id}`,
           'the press repoints this row at the document — the file stops being read, so ' +
           'both copies can never reach one output');
        same(fork.cues.length, 3, 'with every cue that was in the window');
        ok(fork.header.indexOf('[V4+ Styles]') >= 0 && fork.header.indexOf('Arial') >= 0,
           'and the script header, which is where an ASS track’s look lives');
        ok(fork.cues.every((c) => c.raw.indexOf('Default') >= 0),
           'each cue keeping the dialogue line it came out of, styles and all');
        same(A.cues.fileExtension(fork), 'ass',
             'so it is written as ASS — nothing else could carry that back out');

        // The round trip, stated against the file rather than against a render:
        // a cue nobody retyped comes back byte for byte, under the styles.
        const text = A.cues.cueFileText(fork, 0, 10);
        ok(text.indexOf('Style: Default,Arial,48') >= 0,
           'the file written back carries the styles it came with');
        ok(text.indexOf('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,styled one') >= 0,
           'and a cue nobody touched is the line it always was');

        // What retyping costs, which is the one thing here that loses work.
        A.shell.goTo('compose');
        pump(200);
        const styledTrack = A.cues.cueTracks[A.cues.cueTracks.length - 1];
        A.timeline.selectCue(styledTrack, styledTrack.cues[1]);
        A.timeline.draw();
        pump(80);
        type(f('cue-text'), 'retyped');
        pump(80);
        same(styledTrack.cues[1].text, 'retyped', 'retyping a cue writes its words');
        ok(styledTrack.cues[1].raw.indexOf('Default') >= 0,
           'and keeps its style, layer and margins — the head of the dialogue line');
        const after = A.cues.cueFileText(styledTrack, 0, 10);
        ok(after.indexOf(',Default,,0,0,0,,retyped') >= 0,
           'which is what the file says: the same fields, the new words');
        ok(after.indexOf('styled three') >= 0,
           'and every cue nobody retyped is untouched by it');

        // Nothing here writes back to the file, ever.
        const onDisk = bro.ffmpeg.cueText(styledFile);
        same(onDisk.cues.length, 3, 'the file the cues came out of still has its own three');
        same(onDisk.cues[1].text, 'styled two', 'saying what it always said — it is never written to');

        A.shell.goTo('write');
        pump(150);
        const cmd2 = commandText();
        ok(cmd2.indexOf('.sub') >= 0,
           'the printed command names the file the render writes, so it stays runnable');
        ok(cmd2.indexOf(styledFile) < 0,
           'and no longer opens the file the cues were forked out of');
    }

    // ── and a track of pictures cannot be typed into ──
    const pics = `${dir}/picture-cues.mkv`;
    let hasPics = false;
    try { hasPics = !!bro.ffmpeg.probe(pics); } catch (e) { hasPics = false; }
    if (hasPics) {
        A.shell.goTo('sources');
        pump(80);
        type(el('src-path'), pics);
        click(el('src-add'));
        pump(250);
        const at = A.inputs.inputs.length - 1;
        const bitmapRow = { kind: 'subtitle', source: `copy:${at}:2` };
        const why = A.cues.forkRefusal(bitmapRow);
        ok(why.indexOf('optical character recognition') >= 0,
           `a bitmap track is refused by name rather than typed into (${why.slice(0, 60)}…)`);
    } else {
        console.log(`  SKIP  no picture-cues.mkv in ${dir} — the refusal needs one`);
    }

    A.doc.reset();
    pump(200);
}

console.log(`\n${checks} checks passed`);
