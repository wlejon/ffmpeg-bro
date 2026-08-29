// The manifest — the one file that crosses from the corpus to a view of it.
//
// `ui/library.js` reads `build/corpus/find.json`, which names a manifest per
// channel, which names a recording's words and its media. Three views are built
// on that: the Find panel over Compose, the second application's whole left-hand
// side, and `tools/`.
//
// ── Why a file is the seam, and a deliberately small one ───────────────────
//
// A view needs to know which recordings exist, what they are called, where their
// words are and where their media is. It does not need to know this store's
// layout, and `ui/` must not come to depend on `corpus/` to find out — that is
// the same shape of seam a `.fbro` is, and `useCorpus` in `ui/library.js` takes
// a path for the same reason `corpus/store.js` does not.
//
// **The words themselves are not copied in.** The transcripts are a megabyte
// each and already on disk in a form the application reads; duplicating ninety
// thousand words into a second file would make a stale copy the first time a
// recording was transcribed again. The panel reads the `.srt` directly, which is
// CLAUDE.md's rule about this corpus stated as a file layout.
//
// ── Why writing it is a call and no longer a verb ─────────────────────────
//
// This was the body of `tools/supercut.js`'s `index`, and it moved here for the
// reason everything else in `corpus/` moved: **a window that has just finished
// transcribing a recording has to be able to refresh the manifest itself.**
// Otherwise `index` is a step somebody has to remember, and the failure when
// they do not is the quietest one this corpus has — the panel finds nothing, and
// there is nothing anywhere saying that the recording it would have found was
// transcribed an hour ago. `tools/supercut.js index` now calls this and prints
// what it answers.

import { transcribed, dirFor } from './store.js';
import { readSrt } from './srt.js';
import { abs, readJson, writeJson } from './files.js';

/// The path of the roll-up: one well-known file, so a corpus that has never been
/// indexed is simply an absent file and every view is absent with it.
export const ROLL = abs('build/corpus/find.json');

/// Where one channel's manifest goes — beside its recordings, through `dirFor`
/// rather than built here, so a channel named `Turk` and one named `turk` index
/// into the one directory their recordings are already in.
export const manifestFor = (login) => `${dirFor(login)}/find.json`;

/// Write the manifest for one channel, and put it in the roll-up.
///
/// Answers `{ channel, path, roll, built, vods, words, without }` — `vods` is
/// the rows written, `words` their total, and `without` how many have words but
/// no recording on disk, which is a thing a caller wants to say out loud: the
/// panel will find those hits and cannot play them.
///
/// **Every transcript in the store, not the ones in the listing.** `transcribed`
/// walks the directories, so a recording Twitch has dropped off the end of its
/// retention stays searchable — the listing is the live answer and the
/// directories are the archive.
///
/// Throws rather than asserting, because `assert` is the headless runner's
/// global and this module is imported by a window.
export function writeManifest(name) {
    const have = transcribed(name);
    if (!have.length)
        throw new Error(`no transcripts for "${name}" yet — nothing to index`);

    // Folded once, here, because two files carry the name and `pick()` in
    // `ui/library.js` matches the roll's entry against the manifest's own
    // `channel` — so `Turk` written into one and `turk` into the other is a
    // channel that lists and will not open.
    const login = String(name).toLowerCase();

    let words = 0;
    const vods = have.map((v) => {
        const n = readSrt(v.srt).length;
        words += n;
        return {
            id: v.id, title: v.title || '', publishedAt: v.publishedAt || '',
            seconds: v.seconds || 0, page: v.page || '',
            srt: abs(v.srt), media: v.hasMedia ? abs(v.media) : '', words: n,
        };
    });

    const built = new Date().toISOString();
    const path = manifestFor(login);
    writeJson(path, { channel: login, built, vods });

    // The roll-up is rewritten whole with this channel's row replaced, so a
    // second channel indexed yesterday survives and a channel indexed twice does
    // not appear twice.
    const roll = readJson(ROLL) || {};
    const channels = (roll.channels || []).filter((c) => c && c.channel !== login);
    channels.push({ channel: login, manifest: path, vods: vods.length, words,
                    built });
    channels.sort((a, b) => String(a.channel).localeCompare(String(b.channel)));
    writeJson(ROLL, { channels });

    return { channel: login, path, roll: ROLL, built,
             vods, words, without: vods.filter((v) => !v.media).length };
}
