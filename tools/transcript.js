// The two counting passes over a transcript that only a tool ever asks for.
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
// ── Where the file itself went ────────────────────────────────────────────
//
// `stamp`, `readSrt` and `writeSrt` were here and are **`corpus/srt.js`'s** now.
// They describe a file the *store* is made of — `corpus/words.js` writes one at
// the end of every transcription and `ui/library.js` reads one on every search —
// and a module set both applications import cannot reach into `tools/` for them.
// They are re-exported here so that the older importers in this directory keep
// working and so that a tool still has one namespace to look in; the definitions
// are not here, and neither is the reason they are what they are.

import { bare, streamOf, find, monologues, spaced } from '/app/phrase.js';
import { stamp, readSrt, writeSrt } from '../corpus/srt.js';

// Re-exported so that a tool has one place to look. The definitions are not
// here; the names are.
export { bare, streamOf, find, monologues, spaced };
export { stamp, readSrt, writeSrt };

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
