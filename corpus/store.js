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
// ── What is here and what is not ──────────────────────────────────────────
//
// This file is **where things live and what is on disk**, and nothing else: it
// takes no application, drives no interface and prints nothing. That is what
// lets the command line and a window ask it the same questions and get the same
// answers, which is the whole reason `corpus/` exists — see the block at the top
// of `corpus/vod.js`. Making a recording appear is `corpus/pull.js`'s; the batch
// verbs over both are `tools/supercut.js`'s.
//
// One consequence worth stating, because it bit: **`assert` is not available
// here.** It is a global the *headless* runner installs
// (`headless_bindings.cpp`), so a module that used it worked from `tools/` and
// threw `assert is not defined` inside a window. Everything here that refuses
// throws an `Error` with the same sentence in it.

import { channel as listChannel, pageFor } from './vod.js';
import { abs, exists, readJson, writeJson } from './files.js';

const fs = require('fs');

// ── where things live ──────────────────────────────────────────────────────

/// Where every channel's store is, under the repository root.
///
/// One fixed place rather than a caller-supplied path, which is
/// `ui/library.js`'s decision inverted: that file takes a path because a
/// *reader* may be pointed at a corpus kept anywhere, and this is the writer,
/// for which the layout is the whole point. `abs` resolves it against the
/// repository root, which is the same place from either application — the one
/// thing to check before importing this into a window, and `files.js` says why
/// it holds.
const STORE = abs('build/corpus');

export const dirFor = (login) => `${STORE}/${String(login).toLowerCase()}`;
export const channelFile = (login) => `${dirFor(login)}/channel.json`;

export function vodPaths(login, id) {
    const dir = `${dirFor(login)}/${id}`;
    return { dir, state: `${dir}/state.json`, media: `${dir}/media.mkv`,
             srt: `${dir}/words.srt`, scratch: `${dir}/.audio.wav` };
}

export const loadState = (login, id) => readJson(vodPaths(login, id).state, {}) || {};
export const saveState = (login, id, s) => writeJson(vodPaths(login, id).state, s);

/// Where a recording's picture actually is.
///
/// **A pulled recording is at `vodPaths().media` and an adopted one is wherever
/// it already was**, and this is the one place that difference is decided. A
/// folder of footage somebody points this at is not copied — it is tens of
/// gigabytes that are already on the disk, and a corpus that duplicated it would
/// be a corpus nobody could afford to make — so `corpus/local.js` writes the
/// path into the state file and everything that opens a recording asks here.
///
/// Every reader of a recording's media goes through this: `isPulled`,
/// `transcribed`, `startTranscribe`, and the row `supercut/acquire.js` draws. A
/// second answer would be a recording that transcribes and will not play, or
/// plays and cannot be read.
export function mediaOf(login, id) {
    const st = loadState(login, id);
    return (st && st.local && st.local.path) || vodPaths(login, id).media;
}

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
    if (!ch)
        throw new Error(`nothing listed for "${login}" yet — run \`list ${login}\` first`);
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
        const st = loadState(login, id);
        // **A recording adopted from a folder has no page and its own title**,
        // and both come off the state file rather than out of a listing: there
        // is no listing for one. `pageFor` would otherwise hand a local file a
        // Twitch URL built from a number this store allocated.
        const meta = titles[id] || (st.local
            ? { id, page: '', title: st.local.name || '',
                seconds: (st.media && st.media.seconds) || 0,
                publishedAt: st.publishedAt || '' }
            : { id, page: pageFor(id), title: '', seconds: 0, publishedAt: '' });
        const media = mediaOf(login, id);
        out.push({ ...meta, id, srt: p.srt, media,
                   hasMedia: exists(media), state: st });
    }
    return out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

// ── what is actually on disk ───────────────────────────────────────────────

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
/// So the question is asked of the *state*, which `corpus/pull.js` writes only
/// after the fetch reported `done`. That matters as soon as a pull and a
/// transcribe run at the same time, which is the ordinary way to use this: one
/// process on the network, one on the GPU.
///
/// The pull writes to `media.mkv.part` and renames on Done, so a `media.mkv`
/// that exists at all is now a finished one — but the state is still what is
/// asked, because a store on this machine holds recordings written by the
/// version that wrote straight to the final name.
/// **An adopted file is "pulled" the moment it has been probed**, which is the
/// same statement this makes about a fetch and not a weaker one: the question is
/// whether the whole recording is on this disk and how long it is, and for a
/// file somebody already had, the answer to the first is yes and the second is
/// what the probe said. `corpus/local.js` writes `media.seconds` when the probe
/// lands and not before, so a file being probed is not yet transcribable — which
/// is the condition this guards.
export function isPulled(login, id) {
    const st = loadState(login, id);
    return !!(st && st.media && st.media.seconds > 0 && exists(mediaOf(login, id)));
}
