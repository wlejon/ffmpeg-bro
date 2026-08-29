// A channel's recordings, on disk, as something a search can be run over.
//
// The unit of work here is a **channel**, not a file, because the question this
// exists to answer is "when did he say that" and nobody knows in advance which
// broadcast it was in. So the store is per channel, every step is resumable, and
// nothing is ever done twice: a VOD that has been transcribed stays transcribed
// when the next one is added, and a run interrupted at hour two picks up at hour
// two.
//
//   build/corpus/<login>/channel.json      what the channel has, newest first
//   build/corpus/<login>/<id>/state.json   what has been done to this VOD
//   build/corpus/<login>/<id>/media.mkv    the recording, picture and sound
//   build/corpus/<login>/<id>/words.srt    one cue per word
//
// ── One file per recording, and that is the load-bearing decision ─────────
//
// An earlier version of this pulled the **audio-only** rendition, because a
// transcript reads the soundtrack and nothing else and that rendition is thirty
// times smaller — 0.6 GB against 17.4 GB for a six-hour broadcast. It worked,
// and it cost far more than it saved, because of something nothing declares:
//
// **Two renditions of one Twitch VOD do not share a zero.** They are two
// separate transcodes. Measured over sixteen consecutive words the audio-only
// copy ran 0.80 s ahead of the 1080p60 one, while both reported the same
// duration to the millisecond and neither carried a start time. And the
// difference is not one number — at three points of the same pair it was
// +0.80 s, +2.21 s and +2.57 s. Growing, but not steadily: that is a *step*,
// where an ad break was resolved differently in the two, so no global offset and
// no slope corrects it.
//
// A transcript made from the cheap copy therefore could not be used to cut the
// expensive one. Every cut had to re-transcribe ten seconds of the picture
// rendition to find the phrase again on *its* clock — a network fetch, a decode
// and a model pass per hit, to recover a fact the transcript already knew.
//
// Pulling the picture makes the transcript and the frames **the same file's
// seconds**, so a word's time is where the word is, full stop. There is no
// alignment step anywhere downstream, `flipbook.js` opens a local file and seeks
// to a number, and the whole class of "the clip missed the word" bug cannot
// happen. It costs disk, which is the cheapest thing in this pipeline.
//
// ── Why the pull is a stream copy and not a download ──────────────────────
//
// It goes through the application's own Write stage as a `copy:` — the packets
// already on the CDN written into a local container without being decoded, which
// is what `Rewrap` does — so it runs at whatever the network gives rather than
// at whatever an encoder would, and what lands on disk is bit-identical to what
// Twitch served. Matroska, because a copy has to go into a container that will
// hold what is being copied and an mp4 would refuse the timed-ID3 track Twitch
// carries alongside the picture.

import { resolve, forWatching, mediaDuration, channel as listChannel,
         pageFor } from './vod.js';
import { transcribeSpan } from './speech.js';
import { writeSrt, readSrt, streamOf, find } from './transcript.js';
import { ROOT, abs, mkdirp, exists, sizeOf, readJson, writeJson, unlink,
         mb, gb, span, clock } from './drive.js';

const fs = require('fs');

// ── where things live ──────────────────────────────────────────────────────

export const dirFor = (login) => `${ROOT}/build/corpus/${String(login).toLowerCase()}`;
export const channelFile = (login) => `${dirFor(login)}/channel.json`;

export function vodPaths(login, id) {
    const dir = `${dirFor(login)}/${id}`;
    return { dir, state: `${dir}/state.json`, media: `${dir}/media.mkv`,
             srt: `${dir}/words.srt`, scratch: `${dir}/.audio.wav` };
}

export const loadState = (login, id) => readJson(vodPaths(login, id).state, {}) || {};
export const saveState = (login, id, s) => writeJson(vodPaths(login, id).state, s);

// ── the channel ────────────────────────────────────────────────────────────

/// Ask Twitch what the channel has and write it down.
///
/// **The listing is refreshed rather than merged.** A VOD Twitch has dropped off
/// the end of its retention is a VOD that cannot be pulled any more, and a store
/// that kept remembering it would offer a page that 404s. What survives a
/// refresh is everything already *on disk* — the recording and the transcript of
/// a VOD are still perfectly searchable after Twitch has forgotten it — so the
/// listing is the live answer and the directories are the archive.
export async function refresh(login, count) {
    const got = await listChannel(login, count);
    writeJson(channelFile(login), { ...got, fetchedAt: new Date().toISOString() });
    return got;
}

/// What the store knows about the channel, or null if it has never been listed.
export const loadChannel = (login) => readJson(channelFile(login), null);

/// The VODs to work on: the listing, newest first, capped at `count`.
///
/// `skip` drops that many of the newest, which is not a nicety. **A broadcast
/// Twitch is still finalising reads about ten times slower than a settled one** —
/// measured on the same CDN host through the same code, 1.2 MB/s for the
/// recording of a few hours ago against 13–21 MB/s for yesterday's, while raw
/// parallel fetches of the slow one's own segments ran at 41 MB/s. So the
/// newest recording is the one to leave until last, and skipping it is how the
/// other four get done in the hour it would have spent on its own.
export function vodsOf(login, count = 0, skip = 0) {
    const ch = loadChannel(login);
    assert(ch, `nothing listed for "${login}" yet — run \`list ${login}\` first`);
    const from = ch.vods.slice(Math.max(0, skip | 0));
    return count > 0 ? from.slice(0, count) : from;
}

/// Every VOD in the store that has a transcript.
///
/// **Directories rather than the listing**, so a transcript outlives the VOD it
/// came from: a channel refreshed after Twitch dropped an old broadcast still
/// searches it. The listing is consulted only for the title, which is a nicety.
export function transcribed(login) {
    const ch = loadChannel(login);
    const titles = {};
    for (const v of (ch ? ch.vods : [])) titles[v.id] = v;
    let ids = [];
    try { ids = fs.readdirSync(dirFor(login)); } catch (e) { return []; }
    const out = [];
    for (const id of ids) {
        if (!/^\d+$/.test(id)) continue;
        const p = vodPaths(login, id);
        if (!exists(p.srt)) continue;
        const meta = titles[id] || { id, page: pageFor(id), title: '', seconds: 0,
                                     publishedAt: '' };
        out.push({ ...meta, id, srt: p.srt, media: p.media,
                   hasMedia: exists(p.media), state: loadState(login, id) });
    }
    return out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

// ── driving the application ────────────────────────────────────────────────

/// Open a path as an input and lay it out, or throw saying why not.
///
/// **A clip, because the Write stage will not open without one.** `prepare()`
/// refuses an empty timeline, so an application holding an input and no clips
/// has no way through to the stream list — which is a real gap for exactly this
/// job, where the whole intention is "copy this input" and the timeline is
/// beside the point.
///
/// `declaredSeconds` is for an input whose container will not say how long it
/// is. **A Twitch HLS playlist reports `duration = 0` through libavformat** —
/// every rendition, every stream inside it — so `lengthOf` is zero, `openInput`
/// refuses to lay out a clip of no length, and the Write stage is unreachable.
/// The length is not unknowable, it is merely uncomputed: it is the sum of the
/// playlist's own `#EXTINF` values (see `mediaDuration` in vod.js). Writing it
/// onto the probe is the tool supplying a number the demuxer declined to total
/// up, from the stream's own manifest — not a guess, and not a number invented
/// here.
export function openMedia(A, drive, path, opts = {}) {
    A.shell.goTo('sources');
    drive.pump(200);
    const input = A.inputs.addInput({ path, name: opts.name || undefined,
                                      origin: opts.origin || undefined });
    drive.until(`${opts.name || path} to open`,
                () => !!input.probe || !!input.error, 300000);
    assert(!input.error, `could not open ${opts.name || path}: ${input.error}`);
    if (opts.declaredSeconds > 0 && !(input.probe.format.duration > 0))
        input.probe.format.duration = opts.declaredSeconds;
    const clip = A.openInput(input);
    assert(clip, `${opts.name || path} would not lay out as a clip ` +
                 `(length ${A.inputs.lengthOf(input)})`);
    drive.pump(400);
    return input;
}

/// Put the application back to an empty edit.
///
/// Between two VODs, because a six-hour input left on the timeline would be read
/// along with the next one — and because the decoders it holds are the memory
/// `ui/residency.js` exists not to spend.
export function clearEdit(A, drive) {
    const clips = A.project.clips.slice();
    if (clips.length) { A.selectMany(clips); A.removeSelection(); }
    // `A.inputs` is the module namespace, so the list is the exported array
    // itself — copied before the walk, because `removeInput` splices it.
    for (const input of A.inputs.inputs.slice()) A.inputs.removeInput(input);
    drive.pump(300);
}

/// `bro.ffmpeg.probe`, with a file that cannot be opened answering null.
export function probeQuietly(path) {
    try { return bro.ffmpeg.probe(abs(path)); } catch (e) { return null; }
}

/// Has this recording been pulled *completely*?
///
/// **The file existing is not the question, and getting that wrong is silent.**
/// A pull in flight has a `media.mkv` on disk from its first second, and it is a
/// valid Matroska the whole way — so `exists()` says yes about a file holding
/// twenty minutes of a six-hour broadcast. Transcribing that writes a transcript
/// with nothing wrong with it that answers "he never said that" about the five
/// and a half hours nobody read.
///
/// So the question is asked of the *state*, which `pullMedia` writes only after
/// the render reported `done`. That matters as soon as a pull and a transcribe
/// run at the same time, which is the ordinary way to use this: one process on
/// the network, one on the GPU.
export function isPulled(login, id) {
    const st = loadState(login, id);
    return !!(st && st.media && st.media.seconds > 0 && exists(vodPaths(login, id).media));
}

// ── step one: the recording ────────────────────────────────────────────────

/// Pull one VOD into the store, picture and sound, by stream copy.
///
/// Resumable: a pull that already produced a file of a plausible length is left
/// alone. "Plausible" is asked of the file rather than of its size — a copy
/// interrupted halfway leaves a valid container holding half a broadcast, and
/// the only honest test of that is what libavformat says its duration is.
/// Ask the network what one recording is, before anything long has run.
///
/// **Every `await` in a pull has to happen before the first copy does, and that
/// is a rule about this engine rather than a preference.** A copy is driven by
/// pumping the engine synchronously for twenty minutes (`drive.until`), and a
/// `fetch` issued *after* such a stretch never starts: the run dies with
/// "top-level await did not settle … no pending jobs, timers, or async work
/// remaining", which is the engine correctly reporting a promise nothing will
/// ever resolve. The first recording of a batch always worked and the second
/// never did, which is exactly the shape of that.
///
/// So resolution is a separate pass. `planPull` is the only async half and it is
/// run for every recording up front; `pullMedia` below is entirely synchronous
/// and can be driven for as long as it likes.
///
/// Answers `null` for a recording already on disk, which is also why the
/// already-pulled test lives here: there is no point resolving a signed URL for
/// something that is not going to be fetched.
export async function planPull(login, meta, log = console.log) {
    const p = vodPaths(login, meta.id);
    mkdirp(p.dir);

    if (exists(p.media)) {
        const got = probeQuietly(p.media);
        // Thirty seconds of slack: a transcode can genuinely end a moment early,
        // and the playlist's total is not the broadcast's to the frame.
        if (got && got.format.duration >= meta.seconds - 30) {
            log(`  ${meta.id} already pulled · ${gb(sizeOf(p.media))} · ` +
                `${span(got.format.duration)}`);
            return null;
        }
        log(`  ${meta.id} stopped at ${span(got ? got.format.duration : 0)} ` +
            `of ${span(meta.seconds)} — pulling again`);
        unlink(p.media);
    }

    const vod = await resolve(meta.page);
    const pick = forWatching(vod);
    assert(pick, `${meta.page} has no picture rendition`);
    const real = await mediaDuration(pick.url);
    log(`  ${meta.id} ${pick.name} · ${Math.round(pick.bandwidth / 1000)} kb/s · ` +
        `${real.segments} segments · ${span(real.seconds)} · ` +
        `expect about ${gb(pick.bandwidth * real.seconds / 8)}`);
    return { pick, real };
}

export function pullMedia(A, drive, login, meta, plan, log = console.log) {
    const p = vodPaths(login, meta.id);
    const state = loadState(login, meta.id);
    if (!plan) {
        const got = probeQuietly(p.media);
        return { path: p.media, bytes: sizeOf(p.media),
                 seconds: got ? got.format.duration : 0, skipped: true };
    }
    const { pick, real } = plan;

    const input = openMedia(A, drive, pick.url, {
        name: `${meta.id} ${pick.name}`, origin: meta.page,
        declaredSeconds: real.seconds,
    });

    A.shell.goTo('write');
    drive.pump(500);
    const S = A.exporter.currentSettings();
    S.container = 'matroska';
    S.path = p.media;
    S.rangeIn = 0;
    S.rangeOut = 0;
    A.exporter.redraw();
    drive.pump(250);

    // `Rewrap` is the Write stage's own shortcut and it writes ordinary `copy:`
    // rows into the stream list — so what runs here is exactly what a person
    // pressing the button gets, and the printed command is the one they'd see.
    const rewrap = document.querySelector(`[data-rewrap="${input.id}"]`);
    assert(rewrap, 'the Write stage is not offering to rewrap this input');
    rewrap.click();
    drive.pump(500);

    // **Twitch's HLS carries a `timed_id3` data track, and Matroska will not
    // hold one.** It is dropped rather than the container changed to suit it,
    // because what it carries is Twitch's own segment metadata: it means nothing
    // once the recording is off Twitch, and it is not what anybody came for.
    const before = S.streams.length;
    S.streams = S.streams.filter((s) => s.kind !== 'data');
    if (S.streams.length !== before)
        log(`  leaving out ${before - S.streams.length} data stream` +
            `${before - S.streams.length === 1 ? '' : 's'} ` +
            '(Twitch segment metadata, which Matroska will not hold)');
    A.exporter.redraw();
    drive.pump(250);

    const began = Date.now();
    document.getElementById('ex-go').click();
    let said = 0;
    drive.until(`the recording of ${meta.id}`, () => {
        const q = bro.ffmpeg.render.poll();
        if (q.state !== 'running') return true;
        const now = Date.now();
        if (now - said > 30000) {
            said = now;
            const secs = (now - began) / 1000;
            const rate = q.bytes / Math.max(0.001, secs);
            const pct = q.progress > 0 ? `${(q.progress * 100).toFixed(1)}% · ` : '';
            const left = q.progress > 0
                ? ` · ${span(secs / q.progress - secs)} left` : '';
            log(`    ${pct}${gb(q.bytes)} in ${span(secs)} ` +
                `(${(rate / 1e6).toFixed(1)} MB/s)${left}`);
        }
        return false;
    }, 8 * 60 * 60 * 1000);

    const done = bro.ffmpeg.render.poll();
    assert(done.state === 'done', `pulling ${meta.id} ${done.state}: ${done.error || ''}`);
    const got = bro.ffmpeg.probe(p.media);
    const secs = (Date.now() - began) / 1000;
    log(`  pulled ${gb(got.format.size)} in ${span(secs)} ` +
        `(${(got.format.size / 1e6 / secs).toFixed(1)} MB/s) · ${span(got.format.duration)}`);

    saveState(login, meta.id, {
        ...state, id: meta.id, title: meta.title, page: meta.page,
        seconds: meta.seconds, publishedAt: meta.publishedAt,
        media: { path: p.media, bytes: got.format.size,
                 seconds: got.format.duration, rendition: pick.name,
                 segments: real.segments, at: new Date().toISOString() },
    });
    return { path: p.media, bytes: got.format.size, seconds: got.format.duration };
}

// ── step two: the words ────────────────────────────────────────────────────

/// Transcribe one VOD's pulled recording into the store.
///
/// Read from the same file the pictures will be cut from, which is the whole
/// point of pulling the picture — see the block at the top. Only the audio
/// stream is rendered, so the pictures are demuxed past rather than decoded.
///
/// Resumable at the level of the whole VOD rather than the chunk: a transcript
/// is either finished or absent. Part of one is worse than none, because a
/// search over it would answer "he never said that" about the half that was
/// never read — and unlike a truncated download there is nothing in the file
/// itself that says so.
export function transcribeVod(A, drive, speech, login, meta, opts = {},
                              log = console.log) {
    const p = vodPaths(login, meta.id);
    const state = loadState(login, meta.id);

    if (exists(p.srt) && !opts.again) {
        const had = readSrt(p.srt).length;
        log(`  already transcribed · ${had} words`);
        return { path: p.srt, words: had, skipped: true };
    }
    // Not `exists` — see `isPulled`. A pull in flight has a valid, growing file
    // on disk, and transcribing that produces a transcript of half a broadcast
    // with nothing in it that says so.
    assert(isPulled(login, meta.id),
           `${meta.id} has not been pulled completely yet`);

    clearEdit(A, drive);
    const input = openMedia(A, drive, p.media, { name: `${meta.id}` });
    assert(input.probe.audio, `${p.media} has no soundtrack`);
    const total = input.probe.format.duration;
    const from = opts.from || 0;
    const to = opts.to > 0 ? Math.min(opts.to, total) : total;
    log(`  ${span(total)} · transcribing ${clock(from)}–${clock(to)}`);

    const began = Date.now();
    const res = transcribeSpan(A, drive, speech, {
        from, to, wav: p.scratch,
        chunkSeconds: opts.chunkSeconds, windowSeconds: opts.windowSeconds,
        overlapSeconds: opts.overlapSeconds,
        onChunk: (c) => {
            const pct = 100 * (c.at - from) / Math.max(0.001, to - from);
            const left = (to - c.at) / Math.max(0.01, c.realtime);
            log(`    ${pct.toFixed(0)}% · ${clock(c.at)} · ${c.words} words · ` +
                `${c.realtime.toFixed(1)}× realtime · ${span(left)} left`);
        },
    });
    unlink(p.scratch);

    writeSrt(p.srt, res.words);
    const wall = (Date.now() - began) / 1000;
    log(`  ${res.words.length} words in ${span(wall)} ` +
        `(${res.realtime.toFixed(1)}× realtime)`);

    saveState(login, meta.id, {
        ...state, id: meta.id, title: meta.title, page: meta.page,
        seconds: meta.seconds, publishedAt: meta.publishedAt,
        transcript: { path: p.srt, words: res.words.length, from, to,
                      realtime: res.realtime, seconds: wall,
                      at: new Date().toISOString() },
    });
    return { path: p.srt, words: res.words.length, realtime: res.realtime };
}

// ── the store, asked a question ────────────────────────────────────────────

/// The searchable stream for one transcript, parsed at most once per process.
///
/// **Searching is the verb people run twenty times**, and a channel's worth of
/// transcripts is a hundred thousand cues to parse and flatten. Doing that again
/// per search is the whole cost of the search repeated for nothing — which does
/// not matter much from a command line, where starting the engine dominates, and
/// matters entirely to a UI holding one process open while somebody types.
const streams = new Map();
export function streamFor(srt) {
    let s = streams.get(srt);
    if (!s) { s = streamOf(readSrt(srt)); streams.set(srt, s); }
    return s;
}

/// A Twitch timestamp — `1h23m45s` — which is what a VOD's own player takes.
///
/// Printed beside every hit so a person can open the moment in a browser and
/// check it. A supercut assembled from times nobody verified is a supercut
/// nobody can defend, and this is the cheapest possible way to verify one.
export function twitchTime(t) {
    const s = Math.max(0, Math.floor(t));
    return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m${s % 60}s`;
}

/// Every place a phrase is said, across every transcript in the store.
///
/// Answers hits carrying the recording they came from and the local file it was
/// read out of, so a caller can go and cut the picture without asking the store
/// a second question — and the time it carries is on that file's own clock.
///
/// **Hits closer together than `spacing` collapse to the first of them.** A
/// phrase repeated for emphasis — said three times in two seconds — is one
/// moment, and three frames of it would be three near-identical pictures in a
/// flipbook whose whole content is that each frame is a different instance.
export function search(login, phrase, opts = {}) {
    const spacing = opts.spacing === undefined ? 2 : opts.spacing;
    const out = [];
    for (const vod of transcribed(login)) {
        const hits = find(streamFor(vod.srt), phrase, {
            loose: opts.loose, context: opts.context,
        });
        let last = -Infinity;
        for (const h of hits) {
            if (h.at - last < spacing) continue;
            last = h.at;
            out.push({
                ...h,
                vodId: vod.id, page: vod.page, title: vod.title,
                publishedAt: vod.publishedAt,
                media: vod.media, hasMedia: vod.hasMedia,
                url: `${vod.page}?t=${twitchTime(h.at)}`,
            });
        }
    }
    return out;
}
