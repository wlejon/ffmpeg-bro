// The corpus: which recordings there are, what was said in them, and where.
//
// This is the *data* half of finding, with no interface in it at all, because
// there are now two interfaces over it — the panel `ui/find.js` opens over the
// Compose stage, and the whole left-hand side of the supercut application. Two
// views over one library; and the reason they are not two libraries is written
// down twice already and was learned the expensive way: when the rule about
// what counts as one instance lived in only one of the two places, a panel and
// a command line reported fifteen and fourteen of the same phrase in the same
// recordings, with nothing anywhere saying which was right.
//
// So everything that decides *what the answer is* lives here or in
// `phrase.js` beneath it, and a view may decide only how to draw it.
//
// ── Where the corpus comes from ───────────────────────────────────────────
//
// **A file is the seam.** `tools/supercut.js index <channel>` writes
// `build/corpus/find.json`, a list of channels and the manifests describing
// them; this reads that and nothing else. The store's layout, the Twitch API and
// the pulling are `corpus/`, a module set the batch verbs in `tools/` and the
// supercut window both drive — see the block at the top of `corpus/store.js`.
// **This file is still on the reading side of that and stays there**: the
// workbench searches a corpus and has no business making one, which is why
// nothing in `ui/` imports `corpus/`. An absent manifest is the ordinary case
// and not an error.
//
// The manifest carries paths and counts, **not words**. The transcripts are a
// megabyte each and already on disk in a form this can read, so they are read
// from here directly — copying ninety thousand words into a second file would
// make a stale copy the first time a recording was transcribed again.

import { clock } from './format.js';
import { parseSrt, streamOf, find, spaced, monologues } from './phrase.js';

const fs = require('fs');

/// The one well-known path. Relative to the working directory, which is where
/// `build/` is for anybody running either application out of the repository.
const ROLL = 'build/corpus/find.json';

/// How close two hits have to be to count as one moment. The same default
/// `tools/supercut.js` uses for `--spacing`, and the same rule — see `spaced`.
export const SPACING = 2;

/// The padding a single word is taken with, in seconds either side.
///
/// The same 1.5 s `tools/clips.js` cuts with, and for the same reason: a word
/// with nothing before it arrives already half said. A stretch of talking is
/// taken as it is — its edges are silences by construction.
export const WORD_PAD = 1.5;

let rollPath = ROLL;
let roll = null;            // the parsed roll-up, false if there is none
let channel = null;         // the manifest in hand
const streams = new Map();  // vodId → search stream, built once

/// Read a corpus from somewhere other than the well-known path.
///
/// The default is one fixed path, which is what makes "there is no corpus" an
/// absent file rather than a setting. It is overridable for the two callers a
/// fixed path would otherwise shut out: a suite, which must not write over
/// somebody's real manifest to prove the search works, and a corpus kept
/// somewhere other than beside the repository.
export function useCorpus(path) {
    rollPath = path || ROLL;
    roll = null;
    channel = null;
    streams.clear();
}

/// Read the same corpus again, because it has changed underneath.
///
/// The roll-up, the manifest and every parsed transcript are read once and kept,
/// which is right for a corpus built by a command line an hour ago and wrong the
/// moment a *window* can add to one: `supercut/acquire.js` writes a manifest on
/// the frame a transcription lands, and without this the words it just read are
/// unfindable until the application is restarted — which is the quietest failure
/// this corpus has.
///
/// **Everything is dropped, including the parsed streams**, which costs 1.4 s
/// over four six-hour recordings on the next search. Keeping the ones whose ids
/// survive would be an optimisation with a wrong answer in it: a recording
/// transcribed a second time has the same id and different words, and a stream
/// held over would answer the old ones for ever. That cost lands once, after a
/// read that took half an hour.
///
/// The channel in hand is picked again by name, so a view that was searching one
/// is still searching it. Answers false when the corpus has gone away entirely.
export function reload() {
    const was = channel && channel.channel;
    roll = null;
    channel = null;
    streams.clear();
    if (!available()) return false;
    return pick(was || undefined);
}

/// Is there a corpus at all? An absent file is the ordinary case.
export function available() {
    if (roll === null) {
        try { roll = JSON.parse(fs.readFileSync(rollPath, 'utf-8')); }
        catch (e) { roll = false; }
    }
    return !!(roll && roll.channels && roll.channels.length);
}

/// The channels on offer, as the roll-up lists them.
export function channels() {
    return available() ? roll.channels.slice() : [];
}

/// The manifest in hand, or null. Its `vods` are what everything else is about.
export function current() { return channel; }

/// Open a channel by name. Called with nothing to open the first one, which is
/// what a single-channel corpus — the ordinary case — never has to think about.
export function pick(name) {
    if (!available()) return false;
    const entry = name ? roll.channels.find((c) => c.channel === name)
                       : roll.channels[0];
    if (!entry) return false;
    if (channel && channel.channel === entry.channel) return true;
    try { channel = JSON.parse(fs.readFileSync(entry.manifest, 'utf-8')); }
    catch (e) { channel = null; return false; }
    streams.clear();
    return true;
}

/// One line about what is loaded, for a view that has to say so.
export function about() {
    if (!channel) return '';
    const hours = channel.vods.reduce((n, v) => n + (v.seconds || 0), 0) / 3600;
    const words = channel.vods.reduce((n, v) => n + (v.words || 0), 0);
    return `${channel.vods.length} recordings · ${hours.toFixed(1)} h · ` +
           `${words.toLocaleString()} words`;
}

/// The search stream for one recording, built once and kept.
///
/// A megabyte of cues parsed per recording, which is why this is memoised rather
/// than done per search: somebody typing into the box asks a new phrase of the
/// same words on every keystroke. The first search of a session pays for all of
/// them (1.4 s over four six-hour recordings); every one after it is ~300 ms.
function streamFor(v) {
    let s = streams.get(v.id);
    if (!s) {
        try { s = streamOf(parseSrt(fs.readFileSync(v.srt, 'utf-8'))); }
        catch (e) { s = streamOf([]); }
        streams.set(v.id, s);
    }
    return s;
}

/// What the corpus holds, newest first — one item per recording.
///
/// **The answer to a question nobody typed**, and the reason it exists: a finder
/// whose list is empty until a phrase is entered shows nothing at all about four
/// recordings and ninety thousand words that are right there. That is a search
/// engine's front page, and it is the wrong shape for a tool over material you
/// already own. Same item shape as a hit, so one list draws all three.
export function recordings() {
    if (!channel) return [];
    return channel.vods.map((v) => ({
        kind: 'vod', vod: v,
        at: 0, to: v.seconds || 0,
        label: String(v.publishedAt || '').slice(0, 10),
        detail: v.title || '',
    })).sort((a, b) => String(b.vod.publishedAt).localeCompare(String(a.vod.publishedAt)));
}

/// Every place a phrase is said, newest recording first.
///
/// A phrase of one character finds most of the corpus and is nobody's question,
/// so the floor is two — expressed against the *letters*, since `|` and spaces
/// are not part of what is being matched.
export function searchWords(phrase, opts = {}) {
    const out = [];
    if (!channel || !phrase) return out;
    if (phrase.replace(/[^a-z0-9|]/gi, '').length < 2) return out;
    for (const v of channel.vods) {
        // Spaced for the same reason `tools/corpus.js` spaces: a phrase said
        // three times for emphasis is one moment, and the two must not come to
        // disagree about that any more than about the matching.
        for (const h of spaced(find(streamFor(v), phrase, { loose: !!opts.loose }),
                               SPACING)) {
            out.push({
                kind: 'word', vod: v, at: h.at, to: h.says,
                label: h.matched, detail: h.context,
            });
        }
    }
    // Newest recording first, then in time order inside it, which is the order
    // somebody thinks about their own recordings in.
    return out.sort((a, b) => String(b.vod.publishedAt).localeCompare(String(a.vod.publishedAt))
                           || a.at - b.at);
}

/// Every stretch of talking in the corpus at these settings, longest first.
///
/// Longest first because the whole point of the list is that you cannot know
/// what is in a stretch before playing it, so the only ranking available is
/// size.
export function searchTalking(opts = {}) {
    const out = [];
    if (!channel) return out;
    for (const v of channel.vods) {
        for (const m of monologues(streamFor(v).words, opts)) {
            out.push({
                kind: 'run', vod: v, at: m.at, to: m.to,
                label: `${Math.round(m.seconds)}s · ${m.words} words · ` +
                       `${m.rate.toFixed(1)}/s`,
                detail: m.opening,
                seconds: m.seconds,
            });
        }
    }
    return out.sort((a, b) => b.seconds - a.seconds);
}

/// A result as the thing a timeline takes: a file, and a span of it.
///
/// A whole recording is taken whole — six hours of it — because that is what was
/// asked for, and trimming it down is one gesture away. Refusing it, or taking
/// the first minute of it, would both be deciding something nobody said.
export function asClip(item) {
    const pad = item.kind === 'word' ? WORD_PAD : 0;
    return {
        path: item.vod.media,
        name: `${item.vod.id} ${clock(item.at)}`,
        from: Math.max(0, item.at - pad),
        to: item.to + pad,
        // Where it came from, so a card can say so and a re-search can find it
        // again. Carried rather than looked up: the clip outlives the result.
        vod: item.vod.id,
        title: item.vod.title || '',
    };
}
