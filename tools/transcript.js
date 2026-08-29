// A transcript on disk, and the two counting passes only a tool ever asks for.
//
// The transcript this repository writes is **one cue per word** — that is what
// `transcribe.js` produces and what everything downstream reads — so an `.srt`
// here is a word list with times rather than a subtitle file in the ordinary
// sense. It is still an `.srt` because this application already opens a subtitle
// file as an ordinary `-i`, already draws its cues over the program monitor and
// already knows how to burn them in, so a transcript that arrives as cues is one
// every part of the app can already use.
//
// ── Where the search itself lives ─────────────────────────────────────────
//
// **The matching is `/app/phrase.js`'s and not this file's**, because the Find
// panel in the application runs the same search and the two must not be able to
// disagree: the panel says where a phrase was said and `clips.js` cuts those
// moments out, so a fix to one copy would leave the list on screen and the files
// on disk describing different sets of moments, with nothing in either saying
// so. That file carries the reasoning with it — why the match is over characters
// rather than over words, and why a match has to begin and end on a word
// boundary.
//
// What stays here is everything that is about a transcript *on disk*: reading
// one, writing one, and the counting that ranks a corpus.

import { bare, parseSrt, streamOf, find, monologues, spaced } from '/app/phrase.js';

const fs = require('fs');

// Re-exported so that a tool has one place to look and the older importers here
// keep working. The definitions are not here; the names are.
export { bare, streamOf, find, monologues, spaced };

// ── the file ───────────────────────────────────────────────────────────────

/// `hh:mm:ss,mmm` for a number of seconds.
export function stamp(s) {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:` +
           `${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/// Every word in an `.srt`, as `{ from, to, text }`.
export function readSrt(path) {
    return parseSrt(fs.readFileSync(path, 'utf-8'));
}

/// Words out as cues, one per word.
///
/// The 0.08 s floor is Parakeet's frame — two tokens from the same frame would
/// otherwise produce a cue that ends before it starts, which some readers refuse
/// and none of them draw.
export function writeSrt(path, words) {
    const srt = words.map((w, i) =>
        `${i + 1}\n${stamp(w.from)} --> ${stamp(Math.max(w.to, w.from + 0.08))}\n` +
        `${w.text}\n`).join('\n');
    fs.writeFileSync(path, srt, 'utf-8');
    return path;
}

/// Every place a phrase is said in a transcript file.
export function findIn(path, phrase, opts = {}) {
    return find(streamOf(readSrt(path)), phrase, opts);
}

// ── what is said a lot ─────────────────────────────────────────────────────

/// Count every run of `n` words, accumulating across transcripts.
///
/// **This exists because choosing the phrase is the hard part of a supercut.**
/// You cannot search for a catchphrase you have not noticed, and you cannot
/// notice one in twenty hours of recording by listening. Worse, the phrase you
/// remember and the phrase the ASR wrote are often different — a search for a
/// half-remembered one comes back with two hits and no way to tell whether that
/// means he rarely says it or that it is spelt some other way in here.
///
/// So: the corpus, ranked. `n` of 3 or 4 is where the interesting answers are —
/// at 1 and 2 the top of the list is the ordinary machinery of English and says
/// nothing about anybody.
export function countPhrases(words, n, into = new Map()) {
    for (let i = 0; i + n <= words.length; i++) {
        const parts = [];
        let ok = true;
        for (let j = 0; j < n; j++) {
            const b = bare(words[i + j].text);
            if (!b) { ok = false; break; }
            parts.push(b);
        }
        if (!ok) continue;
        const key = parts.join(' ');
        const had = into.get(key);
        if (had) { had.count++; }
        // The first time it was said is kept so a caller can go and listen to
        // one without running a second search to find out where any of them are.
        else into.set(key, { text: key, count: 1, first: words[i].from });
    }
    return into;
}

/// The counted phrases, most said first.
export function ranked(counts, opts = {}) {
    const min = opts.min || 2;
    return [...counts.values()].filter((p) => p.count >= min)
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}
