// Every time somebody said a thing, found and cut — the tool, as one command.
//
// A pipeline in eleven verbs, each of which can be run on its own and none of
// which redoes what a previous run finished:
//
//   list        ask Twitch what the channel has, and write it down
//   pull        the recording of each, into the store, by stream copy
//   transcribe  every word in each, with a time, as cues
//   build       pull then transcribe — the two above, in order
//   status      what the store holds and what is still missing
//   index       the manifest the application's Find panel reads
//   phrases     what this channel says a lot — how you pick something to cut
//   search      one phrase across every transcript
//   clips       the seconds around every hit, as files, cached
//   flipbook    one video frame per instance, assembled
//   weave       the phrase said once, every fragment from a different instance
//
//   ffmpeg-bro-headless ui/ tools/supercut.js -- list turk --last 5
//   ffmpeg-bro-headless ui/ tools/supercut.js -- build turk
//   ffmpeg-bro-headless ui/ tools/supercut.js -- search turk "you cross"
//   ffmpeg-bro-headless ui/ tools/supercut.js -- flipbook turk "you cross"
//
// **The verbs are separate because their costs are.** `pull` is network and runs
// at whatever the CDN gives; `transcribe` is the GPU and runs at about 11×
// realtime; `search` is instant and is the one anybody actually iterates on.
// Welding them into one command would mean re-pulling seventeen gigabytes to try
// a different phrase, which is the whole thing this store exists to avoid.
//
// **This is the batch face and no longer the only one.** The mechanics — page
// resolution, the store's layout, pulling a recording — are `corpus/`, which has
// no interface in it and which the supercut application imports too; what is
// here is the verbs, the arguments and the printing. That split was forced by
// one concrete thing rather than chosen for tidiness: `pullMedia` used to drive
// the *workbench's* Write stage (`shell.goTo('write')`, a click on `#ex-go`), so
// a window without one could not pull a recording. See the block at the top of
// `corpus/pull.js`.
//
// What still drives an application through its own surface (`__ffmpegBro`) is
// `transcribe`, `clips`, `flipbook` and `weave` — every render one of those
// performs is a render a person could have performed by hand on the Write
// stage, and the printed command would be theirs. `pull` is a
// `bro.ffmpeg.fetch` and holds no job slot at all.

import { refresh, loadChannel, vodsOf, transcribed, transcribeVod,
         clearEdit, vodPaths, search as searchCorpus, twitchTime, dirFor,
         probeQuietly, isPulled } from './corpus.js';
import { planPull, startPull, pollPull, running } from '../corpus/pull.js';
import { loadSpeech } from './speech.js';
import { readSrt, countPhrases, ranked } from './transcript.js';
import { cutClips } from './clips.js';
import { build as buildFlipbook } from './flipbook.js';
import { weave as buildWeave } from './weave.js';
import { ROOT, abs, argv, positionals, opt, num, flag, driver, exists, sizeOf,
         mkdirp, writeJson, readJson, clock, span, gb, mb } from './drive.js';

const A = globalThis.__ffmpegBro;
const args = positionals();
const verb = (args[0] || '').toLowerCase();

const USAGE = `usage: ffmpeg-bro-headless ui/ tools/supercut.js -- <verb> …

  list <channel> [--last N]        what the channel has, newest first
  pull <channel> [--last N]        the recording of each, by stream copy
  transcribe <channel> [--last N]  every word of each, with a time
  build <channel> [--last N]       pull, then transcribe
  status <channel>                 what the store holds
  index <channel>                  the manifest the app's Find panel reads
  search <channel> <phrase>        one phrase across every transcript
  phrases <channel> [--n 3]        what he says a lot — how you pick one
  clips <channel> <phrase>         the seconds around every hit, as files
  flipbook <channel> <phrase>      one frame per instance, assembled
  weave <channel> <phrase>         the phrase said once, every fragment of it
                                   from a different instance — with the sound

  --last N        how many of the newest recordings to work on. Default 5.
  --skip N        leave out the N newest. A broadcast Twitch is still
                  finalising reads about ten times slower than a settled one,
                  so today's is the one to pull last.
  --loose         match inside longer words: "cross" also finds "crossing".
  --limit N       stop after N hits.
  --spacing S     collapse hits closer together than S seconds. Default 2.
  --device cpu|cuda   which device the model runs on.
  --from S --to S     transcribe only part of each recording.
  --again         redo a step the store has already finished.
  --brief         print hits without the words either side of them.

clips also takes:
  --pad S         seconds before the word. Default 1.5.
  --tail S        seconds after it. Default 1.5.
  --out DIR       where they go. Default: build/corpus/<channel>/clips/<phrase>/

flipbook also takes:
  --out PATH      where the video goes. Default: build/supercut/<channel>-<phrase>.mp4
  --fps N         the output rate. Default 30.
  --hold N        output frames each instance is held for. Default 1.
  --into S        how far inside the word to take the frame. Default 0.10.

weave also takes:
  --out PATH      where the video goes. Default: build/supercut/<channel>-<phrase>-weave.mp4
  --rounds R      walk the instances R times, so the cut is R times faster.
                  The word stays the same length whatever R is. Default 1.

A phrase may carry alternatives: "you cross|ya cross" is one search for either.`;

const channel = args[1];
const last = num('last', 5);
const skip = num('skip', 0);
const device = opt('device', '');

function need(what) {
    if (!channel) { console.log(USAGE); throw new Error(`${what} needs a channel`); }
}

/// The model, loaded once and only when a verb actually needs it.
///
/// 2.5 GB off disk and onto the GPU is several seconds, and `search` — the verb
/// anybody runs twenty times — needs none of it.
let _speech = null;
function speech() {
    if (_speech) return _speech;
    console.log('loading Parakeet…');
    const t0 = Date.now();
    _speech = loadSpeech(ROOT, device ? { device } : {});
    console.log(`  ready in ${((Date.now() - t0) / 1000).toFixed(1)} s · ` +
                `${_speech.sampleRate} Hz · ${_speech.frameSeconds} s per frame`);
    return _speech;
}

// ── list ───────────────────────────────────────────────────────────────────

async function doList() {
    need('list');
    console.log(`asking Twitch what ${channel} has…`);
    const got = await refresh(channel, last);
    console.log(`${got.displayName} (${got.login}, id ${got.id}) — ` +
                `${got.vods.length} past broadcast${got.vods.length === 1 ? '' : 's'}`);
    let total = 0;
    for (const v of got.vods) {
        total += v.seconds;
        console.log(`  ${v.id}  ${String(v.publishedAt).slice(0, 10)}  ` +
                    `${span(v.seconds).padStart(7)}  ${v.title.slice(0, 64)}`);
    }
    console.log(`  ${span(total)} in all · ${dirFor(channel)}`);
}

// ── pull ───────────────────────────────────────────────────────────────────

/// The recording of each, by stream copy — all of them at once.
///
/// **They are all started and the queue decides how many run**, which is the
/// gain from a pull no longer being a render: a fetch holds no job slot, so
/// there is nothing here that has to be done one at a time. No number is stated
/// in this file on purpose. The pool is two workers wide and that is
/// `fetch_queue.h`'s, measured there — every fetch is a download, they share one
/// link, and three concurrent pulls of one CDN finish later in total than two
/// do — so a second number here would be a second answer to one question, and
/// the one that is wrong would be this one.
///
/// Starting them all costs nothing a sequential loop would not: a queued fetch
/// has opened nothing. And it does not make the signed URLs any staler, because
/// every one of them is resolved up front either way — see below.
async function doPull() {
    need('pull');
    const vods = vodsOf(channel, last, skip);
    console.log(`pulling ${vods.length} recording${vods.length === 1 ? '' : 's'}`);

    // **Every `await` first, then every copy.** A `fetch` issued after a long
    // stretch of synchronous pumping never starts — the run dies with "top-level
    // await did not settle" — so the signed URLs and the playlist durations for
    // the whole batch are resolved here, while nothing long has run yet. That is
    // a rule about *this driver*, which stands on the JS thread inside
    // `drive.until` for as long as the pull takes; it is not a rule about
    // pulling, and a window is under no such constraint. `planPull` says so.
    console.log('resolving…');
    const plans = [];
    for (const v of vods) plans.push(await planPull(channel, v));

    const jobs = [];
    for (let i = 0; i < vods.length; i++) {
        const v = vods[i];
        console.log(`[${i + 1}/${vods.length}] ${v.id} · ${span(v.seconds)} · ` +
                    v.title.slice(0, 56));
        const job = startPull(channel, v, plans[i]);
        if (job.dropped)
            console.log(`  leaving out ${job.dropped} data stream` +
                        `${job.dropped === 1 ? '' : 's'} ` +
                        '(Twitch segment metadata, which Matroska will not hold)');
        if (job.state === 'failed') console.log(`  ${v.id} refused: ${job.error}`);
        jobs.push(job);
    }

    let said = 0;
    const began = Date.now();
    driver.until('the recordings', () => {
        for (const job of jobs) pollPull(job);
        const now = Date.now();
        // Every thirty seconds, a line per copy that is actually moving. The
        // queued ones say nothing: "0.0% · 0.00 GB" repeated for four recordings
        // that have not started is a report that hides the one that has.
        if (now - said > 30000) {
            said = now;
            const secs = (now - began) / 1000;
            for (const job of jobs) {
                if (!running(job) || !job.bytes) continue;
                const rate = job.bytes / Math.max(0.001, job.elapsed || secs);
                const pct = job.progress > 0 ? `${(job.progress * 100).toFixed(1)}% · ` : '';
                const left = job.progress > 0
                    ? ` · ${span((job.elapsed || secs) / job.progress -
                                 (job.elapsed || secs))} left` : '';
                console.log(`    ${job.meta.id} · ${pct}${gb(job.bytes)} ` +
                            `(${(rate / 1e6).toFixed(1)} MB/s)${left}`);
            }
        }
        return !jobs.some(running);
    }, 8 * 60 * 60 * 1000);

    let bytes = 0;
    let done = 0;
    for (const job of jobs) {
        if (job.state === 'failed') {
            console.log(`  ${job.meta.id} failed: ${job.error}`);
            continue;
        }
        bytes += job.bytes;
        done++;
        const secs = job.elapsed || (Date.now() - began) / 1000;
        if (job.state === 'done')
            console.log(`  ${job.meta.id} · ${gb(job.bytes)} in ${span(secs)} ` +
                        `(${(job.bytes / 1e6 / Math.max(0.001, secs)).toFixed(1)} MB/s) · ` +
                        `${span(job.seconds)}`);
    }
    console.log(`${done} recording${done === 1 ? '' : 's'} on disk · ${gb(bytes)}`);
}

// ── transcribe ─────────────────────────────────────────────────────────────

function doTranscribe() {
    need('transcribe');
    const vods = vodsOf(channel, last, skip);
    // Completely pulled, not merely present: a pull running in another process
    // has a valid part-file on disk from its first second. See `isPulled`.
    const ready = vods.filter((v) => isPulled(channel, v.id));
    assert(ready.length, `nothing pulled for ${channel} yet — run \`pull ${channel}\` first`);
    if (ready.length < vods.length)
        console.log(`  ${vods.length - ready.length} of ${vods.length} not pulled yet ` +
                    '— transcribing the rest');
    const s = speech();
    const began = Date.now();
    let words = 0;
    for (let i = 0; i < ready.length; i++) {
        const v = ready[i];
        console.log(`[${i + 1}/${ready.length}] ${v.id} · ${v.title.slice(0, 56)}`);
        const got = transcribeVod(A, driver, s, channel, v, {
            from: num('from', 0), to: num('to', 0), again: flag('again'),
        });
        words += got.words;
    }
    clearEdit(A, driver);
    console.log(`${words} words across ${ready.length} recording` +
                `${ready.length === 1 ? '' : 's'} in ${span((Date.now() - began) / 1000)}`);
}

// ── status ─────────────────────────────────────────────────────────────────

function doStatus() {
    need('status');
    const ch = loadChannel(channel);
    assert(ch, `nothing listed for "${channel}" yet — run \`list ${channel}\` first`);
    console.log(`${ch.displayName} · listed ${String(ch.fetchedAt).slice(0, 19)} · ` +
                `${dirFor(channel)}`);
    let pulled = 0;
    let done = 0;
    let bytes = 0;
    let words = 0;
    for (const v of ch.vods) {
        const p = vodPaths(channel, v.id);
        // Three states, not two: a pull in flight has a valid part-file, and
        // saying "pulled" about it is how a transcript of half a broadcast gets
        // made. See `isPulled` in corpus.js.
        const done_ = isPulled(channel, v.id);
        const partial = !done_ && exists(p.media);
        const hasSrt = exists(p.srt);
        if (done_) { pulled++; bytes += sizeOf(p.media); }
        let n = 0;
        if (hasSrt) {
            done++;
            const st = require('fs').readFileSync(p.srt, 'utf-8');
            n = (st.match(/-->/g) || []).length;
            words += n;
        }
        console.log(`  ${v.id}  ${String(v.publishedAt).slice(0, 10)}  ` +
                    `${span(v.seconds).padStart(7)}  ` +
                    `${done_ ? gb(sizeOf(p.media)).padStart(10)
                             : partial ? `${gb(sizeOf(p.media))} partial`.padStart(10)
                             : 'not pulled'.padStart(10)}  ` +
                    `${hasSrt ? `${String(n).padStart(6)} words` : '   not transcribed'}  ` +
                    v.title.slice(0, 40));
    }
    console.log(`  ${pulled}/${ch.vods.length} pulled (${gb(bytes)}) · ` +
                `${done}/${ch.vods.length} transcribed (${words} words)`);
}

// ── search ─────────────────────────────────────────────────────────────────

function hitsFor(phrase) {
    const hits = searchCorpus(channel, phrase, {
        loose: flag('loose'), spacing: num('spacing', 2), context: num('context', 5),
    });
    const limit = num('limit', 0);
    return limit > 0 ? hits.slice(0, limit) : hits;
}

function doSearch() {
    need('search');
    const phrase = args[2];
    assert(phrase, 'which phrase? — `search <channel> "you cross"`');
    const have = transcribed(channel);
    assert(have.length, `no transcripts for ${channel} yet — run \`build ${channel}\``);
    const hits = hitsFor(phrase);
    console.log(`"${phrase}" across ${have.length} transcript` +
                `${have.length === 1 ? '' : 's'}${flag('loose') ? ' (loose)' : ''}`);
    let where = '';
    for (const h of hits) {
        if (h.vodId !== where) {
            where = h.vodId;
            console.log(`  ${h.vodId} · ${String(h.publishedAt).slice(0, 10)} · ` +
                        `${h.title.slice(0, 56)}`);
        }
        console.log(`    ${clock(h.at).padStart(8)}  “${h.matched}”  · ${h.url}`);
        // The words either side are what tells you a hit is the one you meant,
        // so they are on by default. `--brief` is for a caller whose output is
        // going somewhere with a budget rather than to a person.
        if (!flag('brief')) console.log(`              …${h.context}…`);
    }
    console.log(`${hits.length} instance${hits.length === 1 ? '' : 's'}`);
    const out = opt('json', '');
    if (out) { writeJson(out, { channel, phrase, hits }); console.log(`  ${abs(out)}`); }
}

// ── clips ──────────────────────────────────────────────────────────────────

/// The seconds around every hit, as files, cached by recording and time.
function doClips() {
    need('clips');
    const phrase = args[2];
    assert(phrase, 'which phrase? — `clips <channel> "you cross"`');
    const hits = hitsFor(phrase);
    assert(hits.length, `"${phrase}" is never said in ${channel}'s transcripts`);
    const slug = String(phrase).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const dir = abs(opt('out', `build/corpus/${channel}/clips/${slug}`));
    console.log(`"${phrase}" — ${hits.length} instance${hits.length === 1 ? '' : 's'} ` +
                `across ${new Set(hits.map((h) => h.vodId)).size} recording(s)`);
    const res = cutClips(A, driver, {
        hits, dir, pad: num('pad', 1.5), tail: num('tail', 1.5),
    });
    console.log(`${res.made.length} cut · ${res.skipped.length} already there` +
                (res.missing.length ? ` · ${res.missing.length} whose recording is gone` : ''));
    console.log(`  ${dir}`);
}

// ── phrases ────────────────────────────────────────────────────────────────

/// What this channel actually says a lot, which is how you pick a supercut.
///
/// You cannot search for a catchphrase you have not noticed, and twenty hours is
/// too much to listen to. Worse, the phrase you remember and the phrase the ASR
/// wrote are often different, so two hits for a half-remembered one is
/// ambiguous: rarely said, or spelt otherwise in here? This answers both at once.
function doPhrases() {
    need('phrases');
    const have = transcribed(channel);
    assert(have.length, `no transcripts for ${channel} yet — run \`build ${channel}\``);
    const n = num('n', 3);
    const min = num('min', 3);
    const top = num('top', 30);
    const counts = new Map();
    let words = 0;
    for (const v of have) {
        const w = readSrt(v.srt);
        words += w.length;
        countPhrases(w, n, counts);
    }
    const list = ranked(counts, { min });
    console.log(`${n}-word phrases said ${min}+ times · ${have.length} transcript` +
                `${have.length === 1 ? '' : 's'} · ${words} words`);
    for (const p of list.slice(0, top))
        console.log(`  ${String(p.count).padStart(4)}×  ${p.text}`);
    console.log(`  ${list.length} phrase${list.length === 1 ? '' : 's'} qualify`);
}

// ── flipbook ───────────────────────────────────────────────────────────────

async function doFlipbook() {
    need('flipbook');
    const phrase = args[2];
    assert(phrase, 'which phrase? — `flipbook <channel> "you cross"`');
    const hits = hitsFor(phrase);
    assert(hits.length, `"${phrase}" is never said in ${channel}'s transcripts`);
    const slug = `${channel}-${phrase}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const out = abs(opt('out', `build/supercut/${slug}.mp4`));
    mkdirp(out.slice(0, out.lastIndexOf('/')));

    console.log(`"${phrase}" — ${hits.length} instance${hits.length === 1 ? '' : 's'} ` +
                `across ${new Set(hits.map((h) => h.vodId)).size} recording(s)`);
    const without = hits.filter((h) => !h.hasMedia).length;
    if (without)
        console.log(`  ${without} of them are in recordings no longer on disk — ` +
                    `run \`pull ${channel}\` to shoot those too`);
    // No model: the times came off a transcript of these same files, so a
    // flipbook is a seek and a render. See the block at the top of flipbook.js.
    const res = buildFlipbook(A, driver, {
        hits, out,
        fps: num('fps', 30), hold: num('hold', 1), into: num('into', 0.10),
        width: num('width', 0), height: num('height', 0),
    });
    console.log(`flipbook: ${res.shots.length} frames · ${res.seconds.toFixed(2)} s · ` +
                `${res.width}×${res.height} at ${res.fps} fps` +
                (res.hold > 1 ? ` · each held ${res.hold} frames` : '') +
                ` · ${mb(res.bytes)}`);
    if (res.missed.length)
        console.log(`  ${res.missed.length} dropped: ` +
                    res.missed.map((m) => clock(m.at)).join(' '));
    console.log(`  ${res.out}`);
    // The stills stay: they are the evidence for every frame in the video, and
    // looking at one is how you find out whether a hit was really the phrase.
    console.log(`  stills in ${res.frames}`);
}

// ── index ──────────────────────────────────────────────────────────────────

/// Write the manifest the application's Find panel reads.
///
/// **A file is the seam, and it is deliberately a small one.** The panel needs
/// to know which recordings exist, what they are called, where their words are
/// and where their media is; it does not need to know this store's layout, and
/// `ui/` must not come to depend on `tools/` to find out. So the layout stays a
/// fact of `corpus.js` and what crosses over is a list of absolute paths — the
/// same shape of seam a `.fbro` is.
///
/// The word data itself is *not* copied in. The transcripts are a megabyte each
/// and already on disk in a format the application can read; duplicating ninety
/// thousand words into a second file would make a stale copy the first time a
/// recording was transcribed again, and the panel reads the `.srt` directly for
/// the same reason `clips` does.
function doIndex() {
    need('index');
    const have = transcribed(channel);
    assert(have.length, `no transcripts for ${channel} yet — run \`build ${channel}\``);

    let total = 0;
    const vods = have.map((v) => {
        const words = readSrt(v.srt).length;
        total += words;
        return {
            id: v.id, title: v.title || '', publishedAt: v.publishedAt || '',
            seconds: v.seconds || 0, page: v.page || '',
            srt: abs(v.srt), media: v.hasMedia ? abs(v.media) : '', words,
        };
    });
    const built = new Date().toISOString();
    const at = abs(`build/corpus/${channel}/find.json`);
    writeJson(at, { channel, built, vods });

    // The roll-up, at a path the application can look for without being told
    // which channels exist. One well-known file, so a corpus that has never been
    // indexed is simply an absent file and the panel is absent with it.
    const rollPath = abs('build/corpus/find.json');
    const roll = readJson(rollPath) || {};
    const others = (roll.channels || []).filter((c) => c && c.channel !== channel);
    others.push({ channel, manifest: at, vods: vods.length, words: total, built });
    others.sort((a, b) => String(a.channel).localeCompare(String(b.channel)));
    writeJson(rollPath, { channels: others });

    console.log(`${channel} · ${vods.length} recordings · ${total} words`);
    console.log(`  ${at}`);
    console.log(`  ${rollPath}`);
    const without = vods.filter((v) => !v.media).length;
    if (without)
        console.log(`  ${without} have words but no recording on disk — the panel ` +
                    'will find their hits and cannot play them');
}

// ── weave ──────────────────────────────────────────────────────────────────

/// The phrase said once, with every fragment of it from a different instance.
///
/// The flipbook's sibling and its opposite: that one is a frame per instance
/// and silent, this one keeps the sound and is the length of a single saying.
function doWeave() {
    need('weave');
    const phrase = args[2];
    assert(phrase, 'which phrase? — `weave <channel> "you cross"`');
    const hits = hitsFor(phrase);
    assert(hits.length, `"${phrase}" is never said in ${channel}'s transcripts`);
    const slug = `${channel}-${phrase}-weave`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const out = abs(opt('out', `build/supercut/${slug}.mp4`));

    console.log(`"${phrase}" — ${hits.length} instance${hits.length === 1 ? '' : 's'} ` +
                `across ${new Set(hits.map((h) => h.vodId)).size} recording(s)`);
    const res = buildWeave(A, driver, {
        hits, out, rounds: num('rounds', 1),
        fps: num('fps', 0), width: num('width', 0), height: num('height', 0),
    });
    console.log(`weave: ${res.placed.length} fragments from ${res.instances} instances` +
                (res.rounds > 1 ? ` · ${res.rounds} rounds` : '') +
                ` · ${res.seconds.toFixed(2)} s · ${res.width}×${res.height}` +
                ` · ${res.hasAudio ? 'with sound' : 'SILENT'} · ${mb(res.bytes)}`);
    // The shortest fragment is the number that decides whether this is watchable
    // or a strobe, and it is not knowable before the takes are measured.
    console.log(`  shortest fragment ${(res.shortest * 1000).toFixed(0)} ms`);
    if (res.missed.length)
        console.log(`  ${res.missed.length} dropped: ` +
                    res.missed.map((m) => clock(m.at)).join(' '));
    console.log(`  ${res.out}`);
    console.log(`  the edit ${res.doc}`);
}

// ── go ─────────────────────────────────────────────────────────────────────

const VERBS = {
    list: doList, pull: doPull, transcribe: doTranscribe, status: doStatus,
    search: doSearch, phrases: doPhrases, clips: doClips, flipbook: doFlipbook,
    index: doIndex,
    weave: doWeave,
    build: async () => { await doPull(); doTranscribe(); },
};

if (!verb || verb === 'help' || verb === '--help') {
    console.log(USAGE);
} else {
    const run = VERBS[verb];
    assert(run, `no such verb "${verb}"\n\n${USAGE}`);
    await run();
    console.log('done');
}
