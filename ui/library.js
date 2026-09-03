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
import { abs } from './root.js';
import { parseSrtFrom, emptyStream, growStream, find, spaced, monologues } from './phrase.js';
import * as loudness from './loudness.js';

const fs = require('fs');

/// The one well-known path, against the application rather than against the
/// shell — see `ui/root.js`, which is where that distinction is written down and
/// why. It used to be the bare relative string, which meant the directory the
/// window happened to be started from: a double-clicked application found no
/// corpus and said so over a full one, and everything it then transcribed went
/// into a store this could not read.
const ROLL = abs('build/corpus/find.json');

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
/// Whole-corpus word searches already answered, keyed by the phrase as typed.
///
/// **A score is several searches of one corpus, asked again on every
/// keystroke.** `supercut/rhythm.js` resolves every distinct word in the score
/// through `searchWords`, so typing one character into a twelve-word score used
/// to re-run twelve corpus-wide searches of which eleven had the same answer as
/// the frame before — which over fifty hours is seconds of frozen window per
/// keypress. The answer to a phrase is a property of the corpus and the
/// confinement, so it is kept until one of those changes and `forget()` is the
/// one place that decides when.
const answered = new Map();
/// How many answers are kept. A cap rather than none because a score is typed
/// and every prefix of every word passes through here.
const REMEMBERED = 200;

/// Drop everything read out of the corpus, because the corpus has changed.
///
/// The parsed streams and the answers made out of them go together: a stream
/// that is no longer trustworthy makes an answer that is no longer trustworthy,
/// and keeping the second while dropping the first is the shape of the bug
/// `reload`'s block describes. Confinement is the one change that moves an
/// answer without touching a stream, and `choose` says so there rather than
/// here.
function forget() {
    streams.clear();
    answered.clear();
    warmAt = 0;
}
/// The recordings a search is confined to, as a Set of ids — or null, which is
/// **every** recording and is not the same thing as an empty Set. See `choose`.
let only = null;
/// The channel's *name*, held apart from its parsed manifest because `reload`
/// drops the manifest and must not look like a channel switch: a transcription
/// landing re-reads the corpus, and a confined search that quietly went back to
/// everything on the frame that happened would be the tool changing the question
/// under somebody. See `pick`.
let picked = '';

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
    picked = '';
    only = null;
    forget();
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
    forget();
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
///
/// **Moving to a different channel drops a confined search** and re-reading the
/// same one does not. The ids belong to the channel they were chosen in, so
/// carrying them across would confine the new channel to nothing at all and say
/// so only by finding nothing; `reload` re-reads this same channel by name and
/// must leave the question alone.
export function pick(name) {
    if (!available()) return false;
    const entry = name ? roll.channels.find((c) => c.channel === name)
                       : roll.channels[0];
    if (!entry) return false;
    if (channel && channel.channel === entry.channel) return true;
    try { channel = JSON.parse(fs.readFileSync(entry.manifest, 'utf-8')); }
    catch (e) { channel = null; return false; }
    if (picked && picked !== entry.channel) only = null;
    picked = entry.channel;
    forget();
    return true;
}

/// Confine every search to these recordings, by id.
///
/// **A corpus is not one question.** Twenty broadcasts of one streamer are
/// twenty different afternoons, and "where did he say that" is usually asked
/// about three of them rather than about all six hundred hours — so a phrase
/// found four hundred times across the lot is a list nobody can use, while the
/// same phrase inside the two recordings somebody has in mind is the answer.
///
/// Called with nothing, or with an empty list, goes back to every recording.
/// **That is deliberately not the same as choosing none**: a finder that could
/// be put into a state where it searched nothing at all, and said so only by
/// finding nothing, would be a finder people learned not to trust. There is no
/// way to express "none" here, and the view has one fewer state to draw.
///
/// The choice is a fact about what is being *looked at*, so it lives here beside
/// the search rather than in either view — and it is not in a document and not
/// in `ui/.storage.json`, for the reason `peaks` is not: it describes a session,
/// not an edit.
export function choose(ids) {
    const list = Array.isArray(ids) ? ids : ids ? [...ids] : [];
    only = list.length ? new Set(list.map(String)) : null;
    // The words in each recording are the same words; which recordings are read
    // is not, so the answers go and the streams stay. See `forget`. The
    // background read is an index into the list that just changed, so it starts
    // again — which costs nothing for the recordings it has already read.
    answered.clear();
    warmAt = 0;
    return chosen();
}

/// The ids a search is confined to, as an array — empty when it is not confined.
///
/// An array rather than the Set itself, because a view that could mutate this
/// would be a view deciding what the answer is.
export function chosen() { return only ? [...only] : []; }

/// Is this recording one of the ones being searched?
export const searching = (id) => !only || only.has(String(id));

/// The recordings a search actually walks.
///
/// **Asked of the manifest rather than of the Set**, so a chosen id that is no
/// longer in the corpus — a channel refreshed, a recording transcribed away —
/// narrows to nothing rather than throwing, and an id chosen in another channel
/// cannot leak into this one's results.
function searched() {
    if (!channel) return [];
    return only ? channel.vods.filter((v) => only.has(String(v.id))) : channel.vods;
}

/// One line about what is loaded, for a view that has to say so.
///
/// **Says when a search is confined, because that is the fact most likely to
/// make somebody doubt the tool.** "Nothing says that" over four recordings when
/// twenty are on disk is indistinguishable from a broken search unless the line
/// above it says which four.
export function about() {
    if (!channel) return '';
    const vods = searched();
    const hours = vods.reduce((n, v) => n + (v.seconds || 0), 0) / 3600;
    const words = vods.reduce((n, v) => n + (v.words || 0), 0);
    const what = only ? `${vods.length} of ${channel.vods.length} recordings`
                      : `${vods.length} recordings`;
    return `${what} · ${hours.toFixed(1)} h · ${words.toLocaleString()} words`;
}

/// How many cues are read in one slice of one transcript.
///
/// The number that decides the worst frame a cold search can cost. A hundred
/// hours of transcript is eleven seconds of reading and a recording of it is
/// about a second, so the slice is what stands between a search that fills in
/// and a search that stops the window a recording at a time — measured at 1.6 s
/// a step before there was one. Two hundred cues is a few milliseconds and
/// leaves the overshoot past a frame's budget smaller than a frame.
const CUES = 200;

/// The search stream for one recording: read once, kept, and **grown a slice at
/// a time**.
///
/// The reading is memoised rather than done per search because somebody typing
/// into the box asks a new phrase of the same words on every keystroke. What is
/// held is not the stream itself but the reading of it — the file's text, how
/// far into it the parse has got, and the stream so far — because a caller
/// stepping a search over frames has to be able to stop in the middle of a
/// hundred-megabyte transcript and not merely between two of them. A finished
/// reading drops the text, which is the five megabytes there is no longer any
/// reason to hold.
function readingFor(v) {
    let s = streams.get(v.id);
    if (!s) {
        let text = '';
        try { text = fs.readFileSync(v.srt, 'utf-8'); }
        catch (e) { text = ''; }
        s = { stream: emptyStream(), text, at: 0, done: !text };
        streams.set(v.id, s);
    }
    return s;
}

/// Read more of one transcript, until `until` (a `Date.now()` deadline) or the
/// end of the file. Answers whether the whole of it has been read.
///
/// **Always reads at least one slice.** A budget that could decline to do
/// anything is a search that a busy machine can starve into never finishing, and
/// a search that never finishes is worse than one that blocks — the blocking one
/// at least ends.
function readSome(v, until) {
    const s = readingFor(v);
    while (!s.done) {
        const got = parseSrtFrom(s.text, s.at, CUES);
        growStream(s.stream, got.words);
        s.at = got.next;
        if (s.at >= s.text.length) { s.done = true; s.text = ''; }
        if (until !== undefined && Date.now() >= until) break;
    }
    return s.done;
}

/// The whole stream for one recording, read now.
///
/// What every caller that answers on the line it is called wants. The cost is
/// the cost — about a second a recording — which is why the panel and the
/// results pane ask for a reading instead.
function streamFor(v) {
    readSome(v);
    return readingFor(v).stream;
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
    if (!askable(phrase)) return [];
    const had = answered.get(keyOf(phrase, opts));
    if (had) return had.slice();
    const out = [];
    for (const v of searched()) out.push(...wordsIn(v, phrase, opts));
    const sorted = out.sort(byRecordingThenTime);
    remember(keyOf(phrase, opts), sorted);
    return sorted.slice();
}

/// Is this even a question? A phrase of one character finds most of the corpus
/// and is nobody's, so the floor is two — expressed against the *letters*, since
/// `|` and spaces are not part of what is being matched. `!` on its own is the
/// exception and is a real question: every word that was exclaimed.
function askable(phrase) {
    if (!channel || !phrase) return false;
    if (String(phrase).trim() === '!') return true;
    return String(phrase).replace(/[^a-z0-9|]/gi, '').length >= 2;
}

/// Newest recording first, then in time order inside it, which is the order
/// somebody thinks about their own recordings in. One home, because a stepped
/// search that ordered its partial answer differently from the finished one
/// would reshuffle the list under a hand on its way to the same result.
const byRecordingThenTime = (a, b) =>
    String(b.vod.publishedAt).localeCompare(String(a.vod.publishedAt)) || a.at - b.at;

/// The name an answer is remembered under.
///
/// One home, because three places write and read it — the call that answers at
/// once, the reading that begins, and the reading that finishes — and a
/// separator that differed in one of them would be a memo that never hit and
/// never said so. It did: one of the three was written with a different
/// character between the two halves, and what that cost was every score
/// re-searching the corpus per keystroke while a passing test said the answer
/// was remembered.
const keyOf = (phrase, opts) => `${opts && opts.loose ? 'L' : 'B'} ${phrase}`;

function remember(key, hits) {
    if (answered.size >= REMEMBERED) answered.delete(answered.keys().next().value);
    answered.set(key, hits);
}

/// Every place a phrase is said in **one** recording.
///
/// The one home for what a word search finds, walked both by the call above and
/// by the stepped reading below — which is the point of it being a function at
/// all. A search that answered over frames and a search that answered in one
/// call, each with its own copy of this loop, is exactly the two-copies failure
/// this file's header is about, one level in.
function wordsIn(v, phrase, opts = {}) {
    const out = [];
    // Spaced for the same reason `tools/corpus.js` spaces: a phrase said three
    // times for emphasis is one moment, and the two must not come to disagree
    // about that any more than about the matching.
    for (const h of spaced(find(streamFor(v), phrase, { loose: !!opts.loose }), SPACING)) {
        out.push({
            kind: 'word', vod: v, at: h.at, to: h.says,
            label: h.matched, detail: h.context,
        });
    }
    return out;
}

/// Every stretch of talking in the corpus at these settings.
///
/// Supports `opts.mode`:
///   - 'longest' (default): longest stretches first
///   - 'activated': fast cadence / rapid delivery first
///   - 'yelling': highest vocal energy / exclamations / shouting first
///
/// **What this answers is what the *words* say**, in every mode. `yelling` ranks
/// on the delivery a transcript can be read for — the pace, the `!`, the words
/// written in capitals — and claims nothing about how loud anything was, because
/// finding that out is a decode and a decode is not something a call that
/// answers on the line it is made can do. The measurement is the second phase of
/// `stepSearch` below, and a caller that wants it asks for a reading instead.
export function searchTalking(opts = {}) {
    const out = [];
    if (!channel) return out;
    for (const v of searched()) out.push(...talkingIn(v, opts));
    return rankTalking(out, opts.mode || 'longest');
}

/// Every stretch of talking in **one** recording. The one home, for `wordsIn`'s
/// reason.
function talkingIn(v, opts = {}) {
    const out = [];
    for (const m of monologues(streamFor(v).words, opts)) {
        let tag = '';
        if (m.exclamations > 0) tag += ` · ${m.exclamations}!`;
        tag += ` · ${m.rate.toFixed(1)}/s${m.rate >= 3.2 ? ' fast' : ''}`;
        out.push({
            kind: 'run', vod: v, at: m.at, to: m.to,
            label: `${Math.round(m.seconds)}s · ${m.words} words${tag}`,
            detail: m.opening,
            seconds: m.seconds,
            words: m.words,
            rate: m.rate,
            exclamations: m.exclamations,
            caps: m.caps,
            energyScore: m.energyScore,
            // Three states and not two: `null` is a span nobody has listened to,
            // `0` is one that could not be read, and a number is a measurement.
            // A ranking that treated the first as silence would push every
            // unread stretch to the bottom and call that an answer.
            peakRms: null,
        });
    }
    return out;
}

/// The order a mode puts stretches in. One home, for `byRecordingThenTime`'s
/// reason: the acoustic phase re-ranks a list somebody is already reading, and
/// it has to re-rank it by the same rule that put it in that order.
function rankTalking(runs, mode) {
    if (mode === 'activated')
        return runs.sort((a, b) => b.rate - a.rate || b.seconds - a.seconds);
    if (mode === 'yelling')
        return runs.sort((a, b) => b.energyScore - a.energyScore
                                || b.rate - a.rate || b.seconds - a.seconds);
    return runs.sort((a, b) => b.seconds - a.seconds);
}

// ── a search that answers over frames ──────────────────────────────────────
//
// **A corpus search is priced in the size of the corpus, and the size of a
// corpus is somebody's fifty hours.** Every call above answers on the line it is
// made, which is right for a script and right for four recordings, and is a
// frozen window for the case this is actually used in: the first search of a
// session parses every transcript (~350 ms a recording), every search after it
// walks every stream, and both of those used to happen between one keystroke and
// the next with nothing on the screen saying anything was happening. Fifty hours
// is seconds a keypress.
//
// So a view asks for a **reading** instead: the same search, one recording per
// step, advanced from the frame loop with a time budget, carrying what it has
// found so far and how much is left to look at. Three things about it are
// deliberate.
//
// **The answer is the same answer.** `wordsIn` and `talkingIn` are what both
// paths walk, and the partial list is sorted by the rule the finished one is
// sorted by, so a reading is the whole search made visible rather than a second
// search that might disagree with the first — which is the failure this file's
// header is about.
//
// **A step always does at least one recording**, whatever the budget says. A
// budget that could decline to do anything is a search that can be starved into
// never finishing on a machine that is busy, and a search that never finishes is
// worse than one that blocks: at least the blocking one ends.
//
// **A keystroke abandons the reading and starts another**, and that is cheap
// because the parsed streams are kept. What is thrown away is the walk, not the
// reading of the files.

/// How many stretches are listened to before a ranking settles. The list is
/// capped at 300 drawn and the interesting part is the top of it; two dozen
/// decodes is about a second and a half of worker and is enough to reorder the
/// part anybody reads. The rest keep `peakRms: null`, which says truthfully
/// that nobody listened rather than that there was nothing to hear.
const HEARD = 24;

/// The RMS at which a stretch is called loud on its row. A statement about the
/// measurement, not a classification of what made it — the same line
/// `sound_marks.h` draws between an energy gate and a voice.
const LOUD = 0.25;

/// Begin a search that answers over frames. `kind` is `'words'` or `'talking'`.
///
/// The reading is a plain object a view may read and must not write:
/// `hits` is what has been found so far, `done` says whether that is all of it,
/// `read`/`total` are recordings walked and to walk, `phase` is `'text'`,
/// `'sound'` or `'done'`, and `heard`/`hearing` are spans measured and to
/// measure once the words have run out.
export function beginSearch(kind, opts = {}) {
    const reading = {
        kind, opts: { ...opts },
        vods: [], next: 0,
        hits: [],
        read: 0, total: 0,
        phase: 'done', done: true,
        heard: 0, hearing: 0,
        sound: null, candidates: [],
    };
    if (!channel) return reading;
    if (kind === 'words') {
        if (!askable(opts.phrase)) return reading;
        // Already asked, of this corpus, with this confinement. A score resolves
        // through `searchWords` and shares the same answers.
        const had = answered.get(keyOf(opts.phrase, opts));
        if (had) { reading.hits = had.slice(); return reading; }
    }
    reading.vods = searched();
    reading.total = reading.vods.length;
    if (!reading.total) return reading;
    reading.phase = 'text';
    reading.done = false;
    return reading;
}

/// Do some of it. Answers whether anything changed, which is what a frame loop
/// redraws on — a reading that moved no recording and landed no span is a redraw
/// of a list that is already on the screen.
export function stepSearch(reading, budgetMs = 8) {
    if (!reading || reading.done) return false;
    if (reading.phase === 'text') return stepText(reading, budgetMs);
    if (reading.phase === 'sound') return stepSound(reading);
    return false;
}

function stepText(reading, budgetMs) {
    const until = Date.now() + Math.max(0, budgetMs);
    let did = 0;
    while (reading.next < reading.vods.length) {
        const v = reading.vods[reading.next];
        // The transcript first, a slice at a time. A recording whose words are
        // not all read yet is not searched at all — half of one would be half an
        // answer with nothing saying which half.
        if (!readSome(v, until)) return true;
        reading.hits.push(...(reading.kind === 'words'
            ? wordsIn(v, reading.opts.phrase, reading.opts)
            : talkingIn(v, reading.opts)));
        reading.next++;
        reading.read++;
        did++;
        if (Date.now() >= until) break;
    }

    if (did) {
        if (reading.kind === 'words') reading.hits.sort(byRecordingThenTime);
        else rankTalking(reading.hits, reading.opts.mode || 'longest');
    }

    if (reading.next < reading.vods.length) return did > 0;
    // The words have run out. What happens next is a question about the sound,
    // and only one mode is asking it.
    if (reading.kind === 'words')
        remember(keyOf(reading.opts.phrase, reading.opts), reading.hits.slice());
    if ((reading.opts.mode || 'longest') === 'yelling' && loudness.available()) {
        reading.candidates = reading.hits.filter((h) => h.vod.media).slice(0, HEARD);
        if (reading.candidates.length) {
            reading.hearing = reading.candidates.length;
            reading.sound = loudness.begin(reading.candidates.map(
                (h) => ({ path: h.vod.media, from: h.at, to: h.to })));
            reading.phase = 'sound';
            return true;
        }
    }
    reading.phase = 'done';
    reading.done = true;
    return true;
}

/// Fold the spans that have landed into the ranking.
///
/// **A measurement multiplies the score rather than replacing it.** What was
/// found by the words is a real signal — somebody talking fast in capitals with
/// three exclamation marks is a candidate whatever the meter says — and a
/// ranking that threw it away the moment a number arrived would reorder the list
/// under a hand for a reason nobody could see. So loudness weights what is
/// already there, and the row says which of the two it has: `· loud` appears
/// only on a stretch that was listened to.
function stepSound(reading) {
    const landed = loudness.poll(reading.sound);
    let changed = false;
    for (let i = 0; i < reading.candidates.length; i++) {
        const rms = reading.sound.rms[i];
        if (rms === null || rms === undefined) continue;
        const item = reading.candidates[i];
        if (item.peakRms !== null) continue;
        item.peakRms = rms;
        reading.heard++;
        if (rms > 0) {
            item.energyScore *= 1 + Math.min(3, rms * 4);
            if (rms >= LOUD) item.label += ' · loud';
        }
        changed = true;
    }
    if (changed) rankTalking(reading.hits, reading.opts.mode || 'longest');
    if (reading.sound.done) {
        reading.phase = 'done';
        reading.done = true;
        return true;
    }
    return changed || landed;
}

/// How far a background read of the corpus has got, as an index into
/// `searched()`. Reset wherever the corpus or the confinement changes, because
/// both change what that array is.
let warmAt = 0;

/// Read the corpus while nothing is being asked of it.
///
/// **The calls that answer on the line they are made still exist and still have
/// to be fast.** `supercut/rhythm.js` resolves every word of a score through
/// `searchWords`, and a build needs the whole answer before it can lay a clip —
/// neither can be a reading. What made those slow was never the search (85 ms
/// over a hundred hours) but the first read of the transcripts (8.9 s), and that
/// is a cost with no reason to land on a keystroke: nothing about it depends on
/// the question. So a frame with nothing else to do reads a slice, and by the
/// time anybody types the answer is 85 ms away.
///
/// The same shape as the hardware probe on `supercut/app.js`'s early frames, and
/// for the same reason — the only question was which moment paid.
///
/// Answers whether there was anything left to read, so a caller can stop asking.
export function warmSome(budgetMs = 8) {
    if (!channel) return false;
    const vods = searched();
    if (warmAt >= vods.length) return false;
    const until = Date.now() + Math.max(0, budgetMs);
    while (warmAt < vods.length) {
        if (!readSome(vods[warmAt], until)) return true;
        warmAt++;
        if (Date.now() >= until) break;
    }
    return true;
}

/// Abandon a reading — a phrase typed over, a tab left, a panel closed. Safe on
/// one that has already finished, which is what lets a view cancel the old one
/// without asking whether there was anything to cancel.
export function cancelSearch(reading) {
    if (!reading) return;
    if (reading.sound) loudness.cancel(reading.sound);
    reading.done = true;
    reading.phase = 'done';
}

/// How far along, as a fraction, for a view drawing a bar. The two phases are
/// weighted by what they cost rather than counted as halves: walking the words
/// is where nearly all of the time goes on a corpus of any size, and a bar that
/// jumped to the middle and crawled would be describing the wrong search.
export function searchProgress(reading) {
    if (!reading || reading.done) return 1;
    if (reading.phase !== 'text')
        return 0.9 + 0.1 * (reading.hearing ? reading.heard / reading.hearing : 1);
    if (!reading.total) return 0.9;
    // **The transcript being read counts too.** A recording is a second of
    // parsing on a corpus of this size, so a bar that only moved when one
    // finished would stand still through the part somebody is actually waiting
    // out — which is the whole thing it is there to say is happening.
    return 0.9 * (reading.read + partRead(reading)) / reading.total;
}

/// How much of the transcript now being read has been read, as a fraction.
function partRead(reading) {
    if (reading.next >= reading.vods.length) return 0;
    const s = streams.get(reading.vods[reading.next].id);
    if (!s || s.done || !s.text.length) return 0;
    return Math.min(1, s.at / s.text.length);
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
