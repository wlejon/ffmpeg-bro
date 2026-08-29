// Drive the Find panel the way a person does: open it, type a phrase, check
// what it found, play one, and put one on the timeline.
//
// **The corpus is built here rather than borrowed.** A real store is tens of
// gigabytes and is not in this repository, and the panel reads one fixed
// well-known path — so a suite that used the default would be testing whatever
// happened to be on the machine, and worse, would be one `writeFileSync` away
// from overwriting somebody's real manifest. So this writes a manifest of its
// own beside the fixtures, points the panel at it with `useCorpus`, and the
// transcript in it is a handful of words with times chosen to make each
// assertion say one thing.
//
// The media every cue points at is the ordinary fixture, so `Add` really opens a
// file and really lays out a clip. What is *not* checked here is that the words
// match the sound — they do not, and they do not have to: the panel's job is to
// turn a time in a transcript into a clip of that time, and whether the
// transcript is right is `marks` and `transcribe`'s question.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_find.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_find.js -- <file>');

const fs = require('fs');
const A = globalThis.__ffmpegBro;

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

let checks = 0;
function ok(cond, what) {
    assert(cond, `FAILED: ${what}`);
    checks++;
    console.log(`  ok  ${what}`);
}

/// A `change`-and-`input` that a text field actually hears. The suites
/// synthesise these because they never press a mouse — see the note on `change`
/// in CLAUDE.md.
function type(node, value) {
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    pump(60);
}

// ── a corpus of our own ────────────────────────────────────────────────────

const dir = 'build/fixtures/find';
try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* there already */ }

const stamp = (s) => {
    const ms = Math.round(s * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:` +
           `${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// Chosen so that each assertion below has exactly one reason to pass:
//   - "you cross" is said twice, and once as "youcross" — the flattening
//   - "you crossing" is there too, which the boundary rule must exclude
//   - the last three words are 40 s after the others, so there are two runs of
//     talking and only the first is long enough to be listed
const WORDS = [
    ['and', 0.0, 0.3], ['then', 0.35, 0.6], ['you', 0.7, 0.95], ['cross', 1.0, 1.4],
    ['the', 1.5, 1.7], ['line', 1.75, 2.1],
    ['youcross', 3.0, 3.6], ['again', 3.7, 4.1],
    ['before', 5.0, 5.4], ['you', 5.5, 5.7], ['crossing', 5.75, 6.3],
    ['and', 7.0, 7.2], ['you', 7.3, 7.5], ['cross', 7.55, 8.0],
    ['once', 8.1, 8.4], ['more', 8.5, 8.9],
    ['much', 50.0, 50.3], ['later', 50.4, 50.8], ['indeed', 50.9, 51.4],
    // A word said twice within the spacing window: two matches, one moment.
    ['stop', 52.0, 52.2], ['stop', 53.0, 53.2],
];
fs.writeFileSync(`${dir}/words.srt`,
    WORDS.map((w, i) => `${i + 1}\n${stamp(w[1])} --> ${stamp(w[2])}\n${w[0]}\n`).join('\n'),
    'utf-8');

const abs = (p) => (/^([a-zA-Z]:|\/)/.test(p) ? p : `${dir.replace(/[^/]*$/, '')}${p}`);
fs.writeFileSync(`${dir}/turkey.json`, JSON.stringify({
    channel: 'turkey',
    built: new Date().toISOString(),
    vods: [{
        id: '1', title: 'a fixture', publishedAt: '2026-01-01',
        seconds: 60, srt: `${dir}/words.srt`, media, words: WORDS.length,
    }],
}), 'utf-8');
fs.writeFileSync(`${dir}/find.json`, JSON.stringify({
    channels: [{ channel: 'turkey', manifest: `${dir}/turkey.json`,
                 vods: 1, words: WORDS.length, built: '' }],
}), 'utf-8');

// ── the panel is there when a corpus is ────────────────────────────────────

console.log('\nthe corpus');
{
    A.find.useCorpus(`${dir}/nothing-here.json`);
    ok(!A.find.available(),
       'no manifest is no corpus, and that is not an error');

    A.find.useCorpus(`${dir}/find.json`);
    ok(A.find.available(), 'a manifest is a corpus');

    A.shell.goTo('compose');
    pump(120);
    A.find.setOn(true);
    pump(200);
    ok(A.find.isOn(), 'the panel opens');
}

// ── words ──────────────────────────────────────────────────────────────────
//
// The flattening and the boundary rule are `ui/phrase.js`'s and are asserted in
// their own right elsewhere; what is checked here is that the panel is really
// running *that* search, because a panel with a search of its own would find a
// different set of moments from the ones `tools/clips.js` cuts.

console.log('\nwords');
{
    const box = document.getElementById('find-phrase');
    ok(!!box, 'there is a box to type in');

    type(box, 'you cross');
    let hits = A.find.found();
    ok(hits.length === 3,
       `"you cross" is found three times, including the one written as one ` +
       `word (${hits.length})`);
    ok(hits.every((h) => Math.abs(h.at - 5.5) > 0.01),
       'and never inside "you crossing", which is the boundary rule');
    ok(Math.abs(hits[0].at - 0.7) < 0.01,
       `the first is at the start of the first word (${hits[0].at.toFixed(2)}s)`);
    ok(Math.abs(hits[0].to - 1.4) < 0.01,
       `and ends at the end of the last (${hits[0].to.toFixed(2)}s)`);

    type(box, 'crossing');
    ok(A.find.found().length === 1, 'a word that is said once is found once');

    // `|` is one search for either, which is how a name the model spells two
    // ways is searched for at all.
    type(box, 'crossing|indeed');
    ok(A.find.found().length === 2, 'alternates are one search for either');

    // **A phrase said twice in a breath is one moment**, and the panel has to
    // collapse it exactly as the command line does. It did not: on the real
    // corpus the panel found fifteen of a phrase `search` found fourteen of,
    // because this rule lived only in tools/corpus.js. It is `spaced` in
    // phrase.js now, and this is the assertion that keeps them together.
    type(box, 'stop');
    ok(A.find.found().length === 1,
       'two matches a second apart are one moment, the same as at the command line');

    type(box, 'nobody ever says this');
    ok(A.find.found().length === 0, 'and a phrase nobody says finds nothing');
}

// ── talking ────────────────────────────────────────────────────────────────
//
// The other question, and the one there is no phrase to ask. A run is defined by
// its gaps and by nothing else — see the block above `monologues` in phrase.js.

console.log('\ntalking');
{
    A.find.setTab('talking');
    pump(120);
    ok(A.find.currentTab() === 'talking', 'the other tab is showing');

    // The fixture is nine seconds of talking, then forty of nothing, then a
    // second and a half. At a 30 s floor neither run qualifies; at 5 s only the
    // first does; and the 40 s hole is never inside a run at any gap under it.
    const runs = A.find.runsFor({ gap: 2, min: 5 });
    ok(runs.length === 1, `one stretch is long enough at a 5 s floor (${runs.length})`);
    ok(Math.abs(runs[0].seconds - 8.9) < 0.2,
       `and it is the nine seconds before the hole (${runs[0].seconds.toFixed(1)}s)`);
    ok(A.find.runsFor({ gap: 2, min: 30 }).length === 0,
       'nothing here is thirty seconds of talking');
    ok(A.find.runsFor({ gap: 60, min: 5 }).length === 1 &&
       A.find.runsFor({ gap: 60, min: 5 })[0].seconds > 50,
       'a gap wider than the hole welds the two into one run, which is what a ' +
       'gap means');
}

// ── adding to the mix ──────────────────────────────────────────────────────
//
// The whole point of the list. A six-hour recording probes on a thread, so this
// cannot finish on the press that asked for it — the assertion is that it
// finishes at all, which is what `waitForProbe` in ui/app.js is for.

console.log('\nadding to the mix');
{
    A.selectMany(A.project.clips.slice());
    A.removeSelection();
    pump(120);
    const before = A.project.clips.length;

    A.find.setTab('words');
    pump(80);
    type(document.getElementById('find-phrase'), 'you cross');
    const hits = A.find.found();
    ok(hits.length === 3, 'three to choose from');

    A.find.addFound(0);
    // The probe is a thread; the frame loop is what finishes the add.
    for (let i = 0; i < 200 && A.project.clips.length === before; i++) pump(50);
    ok(A.project.clips.length === before + 1, 'a found moment becomes a clip');

    const clip = A.project.clips[A.project.clips.length - 1];
    // 1.5 s of lead, the same padding tools/clips.js cuts with, clamped at zero
    // because this hit is 0.7 s in.
    ok(Math.abs(clip.inPoint) < 0.01,
       `the clip starts at the head of the file, because the hit is 0.7 s in and ` +
       `the padding is 1.5 (${clip.inPoint.toFixed(2)}s)`);
    ok(clip.length > 2.5 && clip.length < 3.5,
       `and covers the word with padding either side (${clip.length.toFixed(2)}s)`);

    A.find.addFound(1);
    for (let i = 0; i < 200 && A.project.clips.length === before + 1; i++) pump(50);
    ok(A.project.clips.length === before + 2, 'a second one is added too');
    const two = A.project.clips[A.project.clips.length - 1];
    ok(Math.abs(two.start - (clip.start + clip.length)) < 0.05,
       'appended after the first, so a list auditioned in order is a mix in that order');
    ok(A.project.clips.filter((c) => c.input === two.input).length === 2,
       'and both are clips of one input, rather than the file being opened twice');

    A.find.setOn(false);
    pump(80);
    ok(!A.find.isOn(), 'the panel closes');
}

console.log(`\n${checks} checks passed`);
