// Finding a phrase in a transcript, and finding the stretches where somebody
// talked without stopping.
//
// **This is in `ui/` and not in `tools/` because both read it, and the
// dependency has to run this way.** The tools already drive this application
// through its own surface, so a tool importing an app module is the direction
// that already exists; an app module importing a tool would be the app growing a
// dependency on a script that is deliberately not part of it. What is here is
// the *text* half of the search and nothing else — no files, no corpus layout,
// no ffmpeg — which is exactly the part both readers need to agree on.
//
// **The reason they must agree is that they would otherwise disagree
// silently.** The Find panel says where a phrase was said and `tools/clips.js`
// cuts those moments out; if the panel had its own copy of the matcher, a fix to
// one would leave the list on screen and the files on disk describing different
// sets of moments, and nothing in either would say so.
//
// ── Why the search is over characters and not over words ──────────────────
//
// **An ASR does not put the spaces where you would.** Parakeet is a
// SentencePiece transducer and its word boundaries come out of the
// detokenization of a run; across five hours it will write `you cross`,
// `youcross` and `Ucross` for three utterances a person would call the same, and
// a word-by-word comparison finds only the first. Searching a run of words for a
// run of words therefore silently loses hits, and losing hits is the one failure
// that matters for a supercut built by searching — a missed instance is
// invisible, because nothing in the output says it should have been there.
//
// So the words are flattened into one stream of letters and digits with the
// punctuation and the case taken out, the phrase is flattened the same way, and
// the match is an ordinary substring search. The offsets map back to words, so a
// hit still knows which word it started at and what time that word carries.
//
// **A match must begin where a word begins and end where a word ends**, or
// `you cross` finds itself inside `you crossing` and inside `bayou crossbow`.
// That is the boundary rule `loose` turns off, and turning it off is sometimes
// exactly right — it is how you catch `crossed` and `crossing` along with
// `cross` — so it is an option rather than a decision made here.

/// The flattening rule, and the one home for it.
///
/// Everything that compares two pieces of transcript text goes through this, so
/// that the phrase in the box and the words in the file are reduced the same
/// way. A second implementation that treated an apostrophe differently would
/// make a search that finds nothing for a reason nobody could see.
export const bare = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/// Every word in the text of an `.srt`, as `{ from, to, text }`.
///
/// Takes the text rather than a path: this module does no reading, because its
/// two callers get their bytes in different ways and neither of them needs this
/// file to know which.
///
/// The transcript this repository writes is **one cue per word**, so an `.srt`
/// here is a word list with times rather than a subtitle file in the ordinary
/// sense. It is still an `.srt` because this application already opens a
/// subtitle file as an ordinary `-i` and already draws its cues over the
/// monitor, so a transcript that arrives as cues is one every part of the app
/// can already use.
export function parseSrt(text) {
    const at = (s) => {
        const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : 0;
    };
    const out = [];
    for (const block of String(text).split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).filter((l) => l.trim());
        const arrow = lines.findIndex((l) => l.includes('-->'));
        if (arrow < 0 || arrow + 1 >= lines.length) continue;
        const [a, b] = lines[arrow].split('-->');
        out.push({ from: at(a), to: at(b), text: lines.slice(arrow + 1).join(' ') });
    }
    return out;
}

/// The words flattened into one searchable stream.
///
/// Built once per transcript and handed to every phrase, because a corpus search
/// asks several phrases of the same five hours and rebuilding the stream per
/// phrase is the whole cost of the search done again for nothing. That matters
/// far more in the panel than at the command line: somebody typing into a search
/// box asks a new phrase of the same ninety thousand words on every keystroke.
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
    // The boundary rule needs membership rather than order, and it is asked once
    // per candidate match. Built here rather than in `find` because the panel
    // asks a *new phrase of the same stream* on every keystroke, and rebuilding
    // two ninety-thousand-entry sets per keystroke is the whole cost of the
    // search several times over.
    return { words, text, startOf, endOf, wordAt,
             startSet: new Set(startOf), endSet: new Set(endOf) };
}

/// Every place a phrase is said, in time order.
///
/// `phrase` may carry alternatives separated by `|` — `"you cross|ucross"` is
/// one search for either — because an ASR's spelling of a name is not something
/// you can know before you have read the transcript, and stating the variants is
/// honest where a fuzzy matcher guessing at them would not be.
///
/// Answers `{ phrase, matched, at, says, first, last, context }` per hit: `at`
/// is the start of the first word, which is the attack a cut is placed against,
/// and `says` is the end of the last.
export function find(stream, phrase, opts = {}) {
    const loose = !!opts.loose;
    const contextWords = opts.context === undefined ? 5 : opts.context;
    // A stream built by `streamOf` carries these; one assembled by hand may not.
    const starts = stream.startSet || new Set(stream.startOf);
    const ends = stream.endSet || new Set(stream.endOf);
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

// ── the other question a transcript can answer ─────────────────────────────
//
// A phrase search finds a moment. The other thing worth pulling out of six hours
// is a *stretch* — the places where somebody talked for a minute without
// stopping — because that is the raw material you cut into parts, and there is
// no phrase to search for it by. You cannot know in advance what was said in the
// good bits; what you can know is that a good bit is long and uninterrupted.
//
// **A monologue is defined by the gaps, not by the content.** Nothing here
// classifies anything: it is a run of consecutive words in which no two
// neighbours are more than `gap` apart, lasting at least `min`. That is a
// measurement, and it is named after the measurement for the same reason
// `sound_marks.h` refuses to call an energy gate a voice — a label claiming a
// judgement the arithmetic never made is the failure that would make the feature
// a lie. So it is "an unbroken stretch of talking", and whether it is a story or
// a rant is for the person auditioning it to decide.
//
// The default gap of 2 s is a pause for breath rather than a pause for thought;
// widening it welds separate thoughts into one run and narrowing it cuts a run
// at every hesitation. It is a control rather than a constant because the right
// value is a property of how somebody talks.

/// Every unbroken stretch of talking, longest first.
///
/// Answers `{ at, to, seconds, words, rate, opening }` per run. `rate` is words
/// per second, which is what separates a dense stretch from a slow one covering
/// the same minute, and `opening` is the first few words — enough to recognise a
/// run you are looking for without playing it, and never enough to read instead
/// of playing it.
export function monologues(words, opts = {}) {
    const gap = opts.gap === undefined ? 2 : opts.gap;
    const min = opts.min === undefined ? 30 : opts.min;
    const runs = [];
    if (!words.length) return runs;

    let from = 0;
    for (let i = 1; i <= words.length; i++) {
        // The break is the gap *before* word i, so the run being closed is
        // [from, i-1]. Asked one past the end as well, because the last run has
        // no gap after it and would otherwise never be closed.
        const broken = i === words.length || (words[i].from - words[i - 1].to) > gap;
        if (!broken) continue;
        const a = words[from];
        const b = words[i - 1];
        const seconds = b.to - a.from;
        const n = i - from;
        if (seconds >= min && n > 1) {
            runs.push({
                at: a.from, to: b.to, seconds, words: n,
                rate: n / seconds,
                opening: words.slice(from, Math.min(i, from + 12))
                              .map((w) => w.text).join(' '),
            });
        }
        from = i;
    }
    return runs.sort((x, y) => y.seconds - x.seconds);
}
