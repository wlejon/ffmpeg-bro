// Build a rhythmic montage of spoken phrases, from a transcript.
//
// The third of three tools that share one idea: **find it in the sound, fetch
// only the picture you need.** `pull_vod.js` gets the soundtrack alone (0.4 GB
// against 14.7), `transcribe.js` turns that into words with times, and this
// turns a search over those words into cuts.
//
// **The segments are cut before the timeline is built, and that is the whole
// design.** A montage of 80 hits could be 80 clips of one five-hour file, and
// the application would hold 80 decoders open on 14.7 GB to draw it. Instead
// each hit is cut out first — a few megabytes each — and the montage is an edit
// over small files. It is faster, it is what makes the same script work against
// a *remote* HLS URL where fetching the whole file is not on the table, and the
// intermediate segments are worth having on their own. The last full run touched
// 133 MB of a 14 745 MB master: 0.9%.
//
// ── Where a cut actually goes ──────────────────────────────────────────────
//
// **A word's token time is good to about 25 ms, and the sound gate is no use at
// all.** Both were measured rather than assumed, over 22 segments each cut with
// exactly 2 s of run-up so the transcript's own answer sat at a known place:
//
//   nearest onset to the token time    mean −0.024 s, |error| < 0.13 s for 18/22
//   nearest sound run to it            mean −0.753 s, runs 1–4 s long
//
// The gate loses because this is a game stream: the room is never quiet, so an
// energy run spans whole sentences and says nothing about where a word starts.
// The **onset** sensor — spectral flux — finds the attack, and the transcript is
// what says which attack is the right one. So a cut is placed by asking the
// transcript roughly where and the onset exactly where, which is the one
// combination that is better than either.
//
// This is also why the first version played long: it was not that the times were
// wrong, it was 2 s of run-up and 2 s of run-out around a phrase lasting 0.6 s.
//
// ── Whose clock the transcript is on ──────────────────────────────────────
//
// **The transcript may describe a different file, and nothing says so.** The
// whole point of the audio-first workflow is that the words come from a 0.4 GB
// audio-only pull and the pictures come from a 14.7 GB one — and those are two
// separate transcodes of one stream, which do not share a zero. Measured over
// sixteen consecutive words, the audio-only rendition ran **0.80 s** ahead of
// the 1080p60 one, while both reported the same duration to the millisecond and
// neither carried a start time. Every cut missed its word.
//
// Within one file there is no such error at all: cut ±2 s around a word using a
// transcript of that same file and the word lands at 2.00 s, exactly. So this is
// not an alignment problem to be solved with better timestamps — it is two
// clocks.
//
// **And the difference between them is not one number.** Measured at three
// points of the same pair of files it was +0.80 s, +2.21 s and +2.57 s — growing,
// but not steadily, which is what a *step* looks like rather than a drift. Twitch
// VODs carry discontinuities where the ads were, the two renditions do not
// resolve them identically, and each one moves the clocks a little further
// apart. (The same discontinuities are why a windowed stream copy of the master
// fails at 1132.4 s and nowhere else.) No global offset and no slope can correct
// that.
//
// So the transcript is treated as a **search hint and nothing more**: it says
// roughly where to look, the media is asked what it actually says there, and the
// cut is placed on the media's own answer. A hit whose phrase is not found in
// the audio around it is dropped rather than cut — which is what makes every
// clip in the result provably contain the word it was cut for.
//
// ── Rhythm ────────────────────────────────────────────────────────────────
//
// A montage of speech is percussion, so the cut lengths are a **beat grid** and
// each clip carries its word's attack at the *same offset* inside it. Two
// numbers do all of it and neither is per clip: `--bpm` sets the grid, and
// `--lead` says how far ahead of the attack the cut opens. Every clip is then
// exactly `beats × 60/bpm` long and every attack lands on the same subdivision,
// which is what makes it feel deliberate without keyframing anything.
//
// `--pattern` is the other half: a cycle of phrases with a length each, so
// "thank you:4,fuck:2,fuck:2" is one long thank-you against two short f-words,
// over and over, drawing each from its own queue of hits in time order.
//
// Usage:
//   ffmpeg-bro-headless ui/ tools/montage.js -- <media> <transcript.srt> [options]
//     --pattern <cycle>  "phrase:beats,phrase:beats,…" repeated to fill the cut.
//                        Default: the --phrase/--beats pair below.
//     --phrase <words>   what to look for when there is no pattern. Default:
//                        "thank you".
//     --beats <n>        beats per clip when the pattern does not say. Default 2.
//     --bpm <n>          the grid. 0 means no grid: each clip is its own phrase
//                        plus --tail. Default 100.
//     --lead <seconds>   how long before the attack each cut opens. Default 0.15.
//     --tail <seconds>   run-out past the phrase when --bpm is 0. Default 0.35.
//     --snap <window>    how far to look for an onset, in seconds. 0 turns
//                        snapping off and trusts the token time. Default 0.25.
//     --limit <n>        stop after n clips. Default: until a queue runs dry.
//     --sync auto|<secs>|off
//                        how far the transcript's clock is from this file's.
//                        `auto` measures it — see below. A number states it.
//                        Default: auto.
//     --copy             cut the segments by stream copy instead of re-encoding.
//                        Faster, but see cutSegment() for when it will not work.
//     --out <path>       the montage. Default: build/montage/<name>.mp4
//     --doc <path>       also save the edit as a .fbro. Default: beside --out.

import { loadSpeech, wordsOf, renderAudio, measureShift, bare } from './speech.js';
import { readSrt, streamOf, find } from './transcript.js';
import { ROOT, abs, argv, positionals, opt, driver, clock } from './drive.js';

const { pump, until } = driver;
const [media, transcript] = positionals();
assert(media && transcript,
       'usage: … tools/montage.js -- <media> <transcript.srt> ' +
       '[--pattern "thank you:4,fuck:2"] [--bpm 100]');

const A = globalThis.__ffmpegBro;
const fs = require('fs');

const bpm = Number(opt('bpm', '100'));
const beat = bpm > 0 ? 60 / bpm : 0;
const lead = Number(opt('lead', '0.15'));
const tail = Number(opt('tail', '0.35'));
const snapWindow = Number(opt('snap', '0.25'));
const limit = Number(opt('limit', '0')) || 0;
const copyCut = argv.indexOf('--copy') >= 0;
// How far the transcript's clock is from this file's. Measured by default; see
// `measureShift` in speech.js for what goes wrong when it is assumed to be zero.
const syncArg = opt('sync', 'auto');

/// The cycle of phrases, as `{ phrase, beats }` in order.
function parsePattern(text, defaultBeats) {
    return text.split(',').map((part) => {
        const at = part.lastIndexOf(':');
        const hasBeats = at > 0 && /^\s*[\d.]+\s*$/.test(part.slice(at + 1));
        return {
            phrase: (hasBeats ? part.slice(0, at) : part).trim(),
            beats: hasBeats ? Number(part.slice(at + 1)) : defaultBeats,
        };
    }).filter((s) => s.phrase);
}
const steps = parsePattern(opt('pattern', '') || opt('phrase', 'thank you'),
                           Number(opt('beats', '2')) || 2);
assert(steps.length, 'no phrases to look for');

// ── the search ─────────────────────────────────────────────────────────────
//
// The reader, the flattening and the match all live in `transcript.js`, which
// says why a phrase is looked for in a stream of characters rather than in a run
// of words: an ASR does not put the spaces where you would, so `you cross`,
// `youcross` and `you crossed` are three spellings of one utterance and a
// word-by-word comparison finds only the first. A supercut built by searching
// cannot afford to lose hits it will never know it missed.

const words = readSrt(abs(transcript));
const stream = streamOf(words);
console.log(`${abs(transcript)}`);
console.log(`  ${words.length} words`);

/// Every place a phrase is said, in time order.
const findPhrase = (phrase) => find(stream, phrase, { context: 4 });

// One queue per distinct phrase, drawn from in time order. Two steps naming the
// same phrase share a queue, which is what makes "fuck:2,fuck:2" take the next
// two rather than the same one twice.
const queues = {};
for (const s of steps)
    if (!queues[s.phrase]) queues[s.phrase] = findPhrase(s.phrase);
for (const s of steps)
    assert(queues[s.phrase].length, `"${s.phrase}" is never said in ${transcript}`);
for (const phrase of Object.keys(queues))
    console.log(`  "${phrase}" — ${queues[phrase].length} times`);

// **Two hits too close together cannot both be cut**, because the second's clip
// would replay seconds the first already showed. A clip is at most the longest
// step, so that is the spacing to insist on.
const longest = beat > 0 ? Math.max(...steps.map((s) => s.beats)) * beat
                         : 4;
const taken = [];
const farEnough = (hit) => !taken.some((t) => Math.abs(t - hit.at) < longest + lead);

const order = [];
const cursor = {};
for (const phrase of Object.keys(queues)) cursor[phrase] = 0;
outer:
for (let round = 0; ; round++) {
    let placedAny = false;
    for (const step of steps) {
        const q = queues[step.phrase];
        let hit = null;
        while (cursor[step.phrase] < q.length) {
            const candidate = q[cursor[step.phrase]++];
            if (farEnough(candidate)) { hit = candidate; break; }
        }
        if (!hit) break outer;      // this phrase is spent — the cycle ends whole
        taken.push(hit.at);
        order.push({ hit, beats: step.beats });
        placedAny = true;
        if (limit > 0 && order.length >= limit) break outer;
    }
    if (!placedAny) break;
}
assert(order.length, 'nothing to cut');

const lengthOf = (o) => (beat > 0 ? o.beats * beat
                                  : Math.max(0.4, o.hit.says - o.hit.at) + tail);
const totalSecs = order.reduce((n, o) => n + lengthOf(o), 0);
console.log(`  ${order.length} clips · ${totalSecs.toFixed(1)} s` +
            (beat > 0 ? ` · ${bpm} bpm, beat ${beat.toFixed(3)} s` : ' · no grid'));

// ── cut the segments out ───────────────────────────────────────────────────

// **Handles, because where the cut goes is not known until the sensors have
// seen it.** The segment is cut around the transcript's answer with room either
// side, and the clip is trimmed inside it once the onset says where the attack
// is. Wide enough for the longest step plus the lead plus the snap search.
const HANDLE = Math.max(2, longest + lead + snapWindow + 1);

// **How far either side of the hint to listen.** Wide enough to cover the worst
// offset between two renditions seen so far (2.6 s) several times over, and
// narrow enough that a phrase said again nearby is not mistaken for this one.
const SEARCH = Number(opt('search', '10'));

const segDir = `${ROOT}/build/montage`;
try { fs.mkdirSync(`${ROOT}/build`); } catch (e) { /* there */ }
try { fs.mkdirSync(segDir); } catch (e) { /* there */ }

console.log(`opening ${media}`);
A.shell.goTo('sources');
pump(200);
const source = A.inputs.addInput({ path: abs(media) });
until('the source to open', () => !!source.probe || !!source.error, 180000);
assert(!source.error, `could not open it: ${source.error}`);
A.openInput(source);
pump(400);
console.log(`  ${(source.probe.format.duration / 60).toFixed(1)} min · ` +
            source.probe.streams.map((s) => `${s.kind}/${s.codec}`).join(' + '));
const mediaEnd = source.probe.format.duration;

// **What the encoder was set to before any of this ran.** Locating a phrase
// renders 16 kHz mono PCM, which writes over the sample rate, the channel count
// and the codec — and a video segment cut afterwards would inherit them and come
// out with a soundtrack nobody asked for. Kept once, put back per cut.
A.shell.goTo('write');
pump(300);
const before = A.exporter.currentSettings();
const AUDIO_WAS = { codec: before.audioCodec,
                    rate: before.sampleRate,
                    channels: before.channels };

// ── whose clock the transcript is on ───────────────────────────────────────

/// Measure the transcript's clock against this file's, at one point in it.
///
/// A window of the media is transcribed and its words looked up in the
/// transcript. Thirty seconds is enough for a run of eight distinct words in
/// ordinary speech and cheap on the GPU; the expensive half is decoding the
/// picture to get at the sound, which is why this is done twice and not fifty
/// times.
function shiftAt(where, speech) {
    const wav = `${segDir}/.sync.wav`;
    const audio = renderAudio(A, { pump, until }, where, where + 30, wav);
    const local = wordsOf(speech, speech.model.transcribe(audio), where);
    try { fs.unlinkSync(wav); } catch (e) { /* gone */ }
    if (local.length < 10) return null;
    return measureShift(local, words);
}

/// What to add to a transcript time to get this file's time.
function measureSync() {
    if (/^(off|none|0)$/i.test(syncArg)) return { shift: 0, how: 'off' };
    const stated = Number(syncArg);
    if (Number.isFinite(stated) && syncArg.trim() !== 'auto')
        return { shift: -stated, how: `stated as ${stated.toFixed(3)} s` };

    const speech = loadSpeech(ROOT);
    // Two points, well apart, because a constant offset and a drift look the
    // same from one of them — and a drift would have to be corrected as a slope
    // rather than a number.
    const span = source.probe.format.duration;
    const probes = [span * 0.25, span * 0.75]
        .map((t) => shiftAt(Math.max(0, Math.min(t, span - 35)), speech))
        .filter(Boolean);
    if (!probes.length) {
        console.log('  could not match this file against the transcript — ' +
                    'assuming they share a clock');
        return { shift: 0, how: 'unmeasurable' };
    }
    for (const p of probes)
        console.log(`    at ${clock(p.at)} the transcript is ` +
                    `${p.shift >= 0 ? '+' : ''}${p.shift.toFixed(3)} s — "${p.words}"`);
    if (probes.length === 2 && Math.abs(probes[0].shift - probes[1].shift) > 0.15)
        console.log('  the two disagree by ' +
                    `${Math.abs(probes[0].shift - probes[1].shift).toFixed(3)} s — the ` +
                    'transcript drifts against this file rather than merely ' +
                    'sitting off it, and only the average is applied');
    const mean = probes.reduce((n, p) => n + p.shift, 0) / probes.length;
    return { shift: -mean, how: 'measured' };
}

/// Cut one span into its own file, and say what actually came out.
///
/// **Re-encoded rather than copied, by default, and the reason was a bug.** A
/// windowed stream copy used to fail on files whose GOPs fell a certain way —
/// the epoch every packet was shifted by came from whichever packet arrived
/// first, so a stream starting marginally earlier went negative and the muxer
/// refused it. That is fixed (`CopyStreams::prime`), but a copy still can only
/// begin at a keyframe, so it arrives with up to a GOP of lead-in to trim back
/// off and cannot be exact. Re-encoding gives the span asked for. `--copy` is
/// the fast path where exactness is not the point.
function cutSegment(from, to, path) {
    A.shell.goTo('write');
    pump(250);
    const S = A.exporter.currentSettings();
    S.container = 'matroska';
    S.path = path;
    // Put back whatever locating the phrase overwrote — see `AUDIO_WAS`.
    S.audioCodec = AUDIO_WAS.codec;
    S.sampleRate = AUDIO_WAS.rate;
    S.channels = AUDIO_WAS.channels;

    if (copyCut) {
        A.exporter.redraw();
        pump(150);
        const rewrap = document.querySelector(`[data-rewrap="${source.id}"]`);
        assert(rewrap, 'the Write stage is not offering to rewrap this input');
        rewrap.click();
        pump(300);
        // Data streams go: Twitch's timed-ID3 means nothing here and Matroska
        // will not hold it. Same decision as `pull_vod.js`, same reason.
        S.streams = S.streams.filter((s) => s.kind !== 'data');
        for (const row of S.streams) {
            if (!String(row.source || '').startsWith('copy:')) continue;
            row.copyFrom = from;
            row.copyTo = to;
        }
    } else {
        S.rangeIn = from;
        S.rangeOut = to;
        S.streams = A.exporter.defaultStreams();
    }
    A.exporter.redraw();
    pump(150);
    document.getElementById('ex-go').click();
    until('the cut', () => bro.ffmpeg.render.poll().state !== 'running', 10 * 60 * 1000);
    const p = bro.ffmpeg.render.poll();
    assert(p.state === 'done',
           `cutting ${from.toFixed(1)}–${to.toFixed(1)} ${p.state}: ${p.error || ''}` +
           (copyCut ? '\n  (drop --copy to re-encode the segment instead)' : ''));
    return bro.ffmpeg.probe(path);
}

/// Where the attack is inside a segment, in the segment's own seconds.
///
/// The transcript put the word at `expect`; the onset sensor is asked which
/// transient nearest that is the real one. Falls back to the transcript when
/// nothing fired close enough, which is the honest answer rather than a guess —
/// at 25 ms mean error the token time is a good place to be.
function attackIn(path, expect) {
    if (snapWindow <= 0) return { at: expect, snapped: false };
    const id = bro.ffmpeg.marks.reads.start(path, { minRunSec: 0.05, tonal: false, sound: false });
    const deadline = Date.now() + 120000;
    let result = null;
    for (;;) {
        const p = bro.ffmpeg.marks.reads.poll(id);
        if (p && p.state === 'done') { result = p.result; break; }
        if (p && (p.state === 'failed' || p.state === 'stopped'))
            return { at: expect, snapped: false };
        if (Date.now() > deadline) return { at: expect, snapped: false };
        pump(80);
    }
    let best = null;
    for (const m of (result.marks || [])) {
        if (m.kind !== 'onset') continue;
        if (Math.abs(m.at - expect) > snapWindow) continue;
        if (!best || Math.abs(m.at - expect) < Math.abs(best.at - expect)) best = m;
    }
    return best ? { at: best.at, snapped: true } : { at: expect, snapped: false };
}

console.log('checking whose clock the transcript is on');
const sync = measureSync();
console.log(`  transcript → this file: about ${sync.shift >= 0 ? '+' : ''}` +
            `${sync.shift.toFixed(3)} s (${sync.how}) — a hint for where to look`);

/// Roughly where a transcript time is on this file's clock.
const onMedia = (t) => t + sync.shift;

/// Where the phrase really is, asked of the media rather than the transcript.
///
/// The soundtrack around the hint is transcribed on its own and the phrase found
/// in *that*, so the answer is on the file's clock by construction and no offset
/// between renditions can survive it. Null when the phrase is not there, which
/// is a hit to drop: cutting it anyway is how a montage comes to be full of
/// moments nobody says anything in.
function locate(phrase, near, speech) {
    const wanted = phrase.split(/\s+/).filter(Boolean).map(bare);
    const from = Math.max(0, near - SEARCH);
    const to = Math.min(mediaEnd, near + SEARCH);
    const wav = `${segDir}/.locate.wav`;
    const audio = renderAudio(A, { pump, until }, from, to, wav);
    const heard = wordsOf(speech, speech.model.transcribe(audio), from);
    try { fs.unlinkSync(wav); } catch (e) { /* gone */ }

    let best = null;
    for (let i = 0; i + wanted.length <= heard.length; i++) {
        let ok = true;
        for (let j = 0; j < wanted.length; j++)
            if (bare(heard[i + j].text) !== wanted[j]) { ok = false; break; }
        if (!ok) continue;
        const at = heard[i].from;
        // Nearest to the hint, because a phrase said twice inside one search
        // window is two different hits and this one is the one being placed.
        if (!best || Math.abs(at - near) < Math.abs(best.at - near))
            best = { at, says: heard[i + wanted.length - 1].to };
    }
    return best;
}

const speech = loadSpeech(ROOT);
const segments = [];
const missed = [];
const beganCutting = Date.now();
for (let i = 0; i < order.length; i++) {
    const o = order[i];
    const hint = onMedia(o.hit.at);
    const found = locate(o.hit.phrase, hint, speech);
    if (!found) {
        missed.push(o);
        console.log(`  – ${clock(o.hit.at)} "${o.hit.phrase}" is not in the ` +
                    `${(2 * SEARCH).toFixed(0)} s around ${clock(hint)} — dropped`);
        continue;
    }
    const path = `${segDir}/${String(segments.length + 1).padStart(3, '0')}.mkv`;
    const from = Math.max(0, found.at - HANDLE);
    const to = Math.min(mediaEnd, found.at + HANDLE);
    const got = cutSegment(from, to, path);
    // Where the media itself put the word inside the segment, and then where the
    // onset sensor says the attack really is.
    const expect = found.at - from;
    const attack = attackIn(path, expect);
    segments.push({ path, o, probe: got, attack: attack.at, snapped: attack.snapped });
    console.log(`  ${segments.length}/${order.length} ${clock(found.at)} ` +
                `"${o.hit.phrase}" ${o.beats}b · ${(got.format.size / 1e6).toFixed(1)} MB · ` +
                `found ${(found.at - hint >= 0 ? '+' : '')}${(found.at - hint).toFixed(2)} s ` +
                `off the hint · attack ${attack.snapped
                    ? `${(attack.at - expect >= 0 ? '+' : '')}${(attack.at - expect).toFixed(3)} s snapped`
                    : 'as heard'}`);
}
assert(segments.length, 'not one phrase could be found in the media');
const cutSecs = (Date.now() - beganCutting) / 1000;
const fetched = segments.reduce((n, s) => n + s.probe.format.size, 0);
const snapped = segments.filter((s) => s.snapped).length;
console.log(`cut ${segments.length} segments in ${cutSecs.toFixed(0)} s · ` +
            `${(fetched / 1e6).toFixed(0)} MB of ` +
            `${(source.probe.format.size / 1e6).toFixed(0)} MB ` +
            `(${(100 * fetched / source.probe.format.size).toFixed(1)}%) · ` +
            `${snapped}/${segments.length} snapped to an onset` +
            (missed.length ? ` · ${missed.length} dropped as not found` : ''));

// ── lay them out on the grid ───────────────────────────────────────────────

// The big file goes: everything from here reads the segments, and a five-hour
// input left on the timeline would be rendered along with them.
A.selectMany(A.project.clips.slice());
A.removeSelection();
A.inputs.removeInput(source);
pump(300);

A.shell.goTo('sources');
pump(200);
let at = 0;
for (const seg of segments) {
    const input = A.inputs.addInput({ path: seg.path });
    until(`${seg.path} to open`, () => !!input.probe || !!input.error, 60000);
    assert(!input.error, `could not open ${seg.path}: ${input.error}`);
    const clip = A.openInput(input);
    assert(clip, `${seg.path} would not lay out as a clip`);
    pump(100);
    // **The attack sits `lead` inside every clip**, which is the whole of the
    // rhythm: the cut opens a fixed moment before the word every time, so the
    // emphasis lands on the same subdivision of the bar in each one.
    const want = lengthOf(seg.o);
    clip.inPoint = Math.max(0, Math.min(seg.attack - lead, clip.media - want));
    clip.length = Math.min(want, clip.media - clip.inPoint);
    clip.start = at;
    clip.track = 0;
    at += clip.length;
}
// No `resolveOverlaps` — it takes the one clip that moved and asks what it
// collided with, and these are laid end to end by construction with nothing to
// collide. Called bare it reads `.start` off an undefined clip.
A.sortClips && A.sortClips();
pump(400);
console.log(`laid out ${segments.length} clips · ${at.toFixed(1)} s`);

// ── save the edit, then render it ──────────────────────────────────────────

const name = steps.map((s) => s.phrase).join('-').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const out = abs(opt('out', `build/montage/${name}.mp4`));
const docPath = abs(opt('doc', out.replace(/\.[^./\\]+$/, '.fbro')));

A.doc.save(docPath);
pump(300);
console.log(`saved the edit · ${docPath}`);

A.shell.goTo('write');
pump(400);
const S = A.exporter.currentSettings();
S.container = 'mp4';
S.path = out;
S.rangeIn = 0;
S.rangeOut = 0;
S.streams = A.exporter.defaultStreams();
A.exporter.redraw();
pump(250);

console.log(`rendering ${out}`);
const beganRender = Date.now();
document.getElementById('ex-go').click();
let said = 0;
until('the montage', () => {
    const p = bro.ffmpeg.render.poll();
    if (p.state !== 'running') return true;
    const now = Date.now();
    if (now - said > 15000) {
        said = now;
        console.log(`  ${Math.round((p.progress || 0) * 100)}% · ` +
                    `${((now - beganRender) / 1000).toFixed(0)} s`);
    }
    return false;
}, 2 * 60 * 60 * 1000);
const done = bro.ffmpeg.render.poll();
assert(done.state === 'done', `the montage ${done.state}: ${done.error || ''}`);

const got = bro.ffmpeg.probe(out);
console.log(`montage: ${got.format.duration.toFixed(1)} s · ` +
            `${(got.format.size / 1e6).toFixed(1)} MB · ` +
            `${((Date.now() - beganRender) / 1000).toFixed(0)} s to render`);
console.log(`  ${out}`);
console.log('done');
