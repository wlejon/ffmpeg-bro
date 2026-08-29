// A transcript on disk, and finding a phrase in one.
//
// The transcript this repository writes is **one cue per word** — that is what
// `transcribe.js` produces and what everything downstream reads — so an `.srt`
// here is a word list with times rather than a subtitle file in the ordinary
// sense. It is still an `.srt` because this application already opens a subtitle
// file as an ordinary `-i`, already draws its cues over the program monitor and
// already knows how to burn them in, so a transcript that arrives as cues is one
// every part of the app can already use.
//
// ── Why the search is over characters and not over words ──────────────────
//
// **An ASR does not put the spaces where you would.** Parakeet is a
// SentencePiece transducer and its word boundaries come out of the
// detokenization of a run (see `wordsOf` in speech.js); across five hours it
// will write `you cross`, `youcross` and `you crossed` for three utterances a
// person would call the same, and a word-by-word comparison finds only the
// first. Searching a run of words for a run of words therefore silently loses
// hits, and losing hits is the one failure that matters for a supercut built by
// searching — a missed instance is invisible, because nothing in the output says
// it should have been there.
//
// So the words are flattened into one stream of letters and digits with the
// punctuation and the case taken out, the phrase is flattened the same way, and
// the match is an ordinary substring search. The offsets map back to words, so a
// hit still knows which word it started at and what time that word carries.
//
// **A match must begin where a word begins and end where a word ends**, or
// `you cross` finds itself inside `you crossing` and inside `bayou crossbow`.
// That is the boundary rule `loose` turns off, and turning it off is sometimes
// exactly right — `--loose` is how you catch `crossed` and `crossing` along with
// `cross` — so it is an option rather than a decision made here.

import { bare } from './speech.js';

const fs = require('fs');

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
    const text = fs.readFileSync(path, 'utf-8');
    const at = (s) => {
        const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : 0;
    };
    const out = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).filter((l) => l.trim());
        const arrow = lines.findIndex((l) => l.includes('-->'));
        if (arrow < 0 || arrow + 1 >= lines.length) continue;
        const [a, b] = lines[arrow].split('-->');
        out.push({ from: at(a), to: at(b), text: lines.slice(arrow + 1).join(' ') });
    }
    return out;
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

// ── the search ─────────────────────────────────────────────────────────────

/// The words flattened into one searchable stream.
///
/// Built once per transcript and handed to every phrase, because a corpus search
/// asks several phrases of the same five hours and rebuilding the stream per
/// phrase is the whole cost of the search done again for nothing.
export function streamOf(words) {
    let text = '';
    const startOf = [];      // char offset each word begins at
    const endOf = [];        // char offset one past each word's last character
    const wordAt = [];       // for each char, the word it came from
    for (let i = 0; i < words.length; i++) {
        const piece = bare(words[i].text);
        startOf.push(text.length);
        for (let c = 0; c < piece.length; c++) wordAt.push(i);
        text += piece;
        endOf.push(text.length);
    }
    return { words, text, startOf, endOf, wordAt };
}

/// Every place a phrase is said, in time order.
///
/// `phrase` may carry alternatives separated by `|` — `"you cross|ya cross"` is
/// one search for either — because an ASR's spelling of a catchphrase is not
/// something you can know before you have read the transcript, and stating the
/// variants is honest where a fuzzy matcher guessing at them would not be.
///
/// Answers `{ phrase, matched, at, says, first, last, context }` per hit: `at`
/// is the start of the first word, which is the attack a cut is placed against,
/// and `says` is the end of the last.
export function find(stream, phrase, opts = {}) {
    const loose = !!opts.loose;
    const contextWords = opts.context === undefined ? 5 : opts.context;
    const starts = new Set(stream.startOf);
    const ends = new Set(stream.endOf);
    const seen = new Set();
    const hits = [];

    for (const alt of String(phrase).split('|')) {
        const needle = bare(alt);
        if (!needle) continue;
        let from = 0;
        for (;;) {
            const c = stream.text.indexOf(needle, from);
            if (c < 0) break;
            from = c + 1;
            const e = c + needle.length;
            // The boundary rule. Without it `you cross` is inside `you crossing`.
            if (!loose && !(starts.has(c) && ends.has(e))) continue;
            const firstWord = stream.wordAt[c];
            const lastWord = stream.wordAt[e - 1];
            if (firstWord === undefined || lastWord === undefined) continue;
            // A phrase listed twice under two spellings must not be cut twice.
            if (seen.has(firstWord)) continue;
            seen.add(firstWord);
            const w = stream.words;
            hits.push({
                phrase,
                matched: w.slice(firstWord, lastWord + 1).map((x) => x.text).join(' '),
                at: w[firstWord].from,
                says: w[lastWord].to,
                first: firstWord,
                last: lastWord,
                context: w.slice(Math.max(0, firstWord - contextWords),
                                 lastWord + 1 + contextWords)
                          .map((x) => x.text).join(' '),
            });
        }
    }
    return hits.sort((a, b) => a.at - b.at);
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
