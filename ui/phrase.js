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
    return parseSrtFrom(String(text), 0).words;
}

/// The same read, a fixed number of cues at a time.
///
/// **Because a hundred hours of transcript is eleven seconds of parsing**, and
/// eleven seconds is not something that can happen between two keystrokes: a
/// caller stepping a search over frames has to be able to stop in the middle of
/// a file, not merely in the middle of a corpus. Measured on a real corpus of
/// eleven recordings, one recording is about a second of this — so a step that
/// finished the file it started was a second of frozen window, which is the same
/// failure one size down. See `beginSearch` in `ui/library.js`.
///
/// Answers `{ words, next }`: the cues read, and where to carry on from. `next`
/// at the end of the text is what says there is no more.
///
/// **Not `split`.** Splitting a five-megabyte transcript makes ninety thousand
/// substrings before the first one is looked at, which is a large part of the
/// second this is trying to break up and cannot be stopped in the middle of.
export function parseSrtFrom(text, from = 0, maxCues = Infinity) {
    const src = String(text);
    const out = [];
    let i = Math.max(0, from);
    let n = 0;
    while (i < src.length && n < maxCues) {
        const edge = blockEnd(src, i);
        n++;
        const cue = cueOf(src.slice(i, edge.at));
        if (cue) out.push(cue);
        i = edge.next;
    }
    return { words: out, next: i };
}

/// Where the block starting at `from` ends, and where the next one begins.
///
/// The separator the whole-file read used is `/\r?\n\r?\n/`, and this finds
/// exactly that by hand: the optional `\r` before the first newline is not part
/// of the block, and everything through the second newline is skipped.
function blockEnd(text, from) {
    let i = from;
    for (;;) {
        const nl = text.indexOf('\n', i);
        if (nl < 0) return { at: text.length, next: text.length };
        let j = nl + 1;
        if (text.charCodeAt(j) === 13) j++;          // \r
        if (text.charCodeAt(j) === 10) {             // \n — a blank line
            const at = text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
            return { at, next: j + 1 };
        }
        i = nl + 1;
    }
}

/// One `.srt` block as a word, or null for anything that is not a cue.
function cueOf(block) {
    const at = (s) => {
        const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : 0;
    };
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const arrow = lines.findIndex((l) => l.includes('-->'));
    if (arrow < 0 || arrow + 1 >= lines.length) return null;
    const [a, b] = lines[arrow].split('-->');
    return { from: at(a), to: at(b), text: lines.slice(arrow + 1).join(' ') };
}

/// The words flattened into one searchable stream.
///
/// Built once per transcript and handed to every phrase, because a corpus search
/// asks several phrases of the same five hours and rebuilding the stream per
/// phrase is the whole cost of the search done again for nothing. That matters
/// far more in the panel than at the command line: somebody typing into a search
/// box asks a new phrase of the same ninety thousand words on every keystroke.
export function streamOf(words) {
    return growStream(emptyStream(), words);
}

/// A stream with nothing in it yet, for a caller filling one in over frames.
export function emptyStream() {
    // The boundary rule needs membership rather than order, and it is asked once
    // per candidate match. Held here rather than built in `find` because the
    // panel asks a *new phrase of the same stream* on every keystroke, and
    // rebuilding two ninety-thousand-entry sets per keystroke is the whole cost
    // of the search several times over.
    return { words: [], text: '', startOf: [], endOf: [], wordAt: [],
             startSet: new Set(), endSet: new Set() };
}

/// Add more words to a stream, in place.
///
/// **A stream is grown rather than built** because the file it is read from is
/// read a piece at a time — see `parseSrtFrom` for why. The arithmetic is
/// unchanged: every offset is against the flattened text as it stands, and text
/// only ever grows at the end, so a stream half built is a correct stream of the
/// words that are in it. That is what lets a search run over a corpus that is
/// still being read, and it is the reason the *first* search of a session is no
/// longer eleven seconds of nothing.
export function growStream(stream, words) {
    let text = stream.text;
    for (let i = 0; i < words.length; i++) {
        const piece = bare(words[i].text);
        const at = stream.words.length;
        stream.words.push(words[i]);
        stream.startOf.push(text.length);
        stream.startSet.add(text.length);
        for (let c = 0; c < piece.length; c++) stream.wordAt.push(at);
        text += piece;
        stream.endOf.push(text.length);
        stream.endSet.add(text.length);
    }
    stream.text = text;
    return stream;
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
        const trimmed = alt.trim();
        const isExclamationOnly = trimmed === '!';
        const wantsExclamation = trimmed.endsWith('!');
        const needle = bare(trimmed);
        if (!needle && !isExclamationOnly) continue;

        if (isExclamationOnly) {
            for (let i = 0; i < stream.words.length; i++) {
                if ((stream.words[i].text || '').includes('!')) {
                    if (seen.has(i)) continue;
                    seen.add(i);
                    const w = stream.words;
                    hits.push({
                        phrase,
                        matched: w[i].text,
                        at: w[i].from,
                        says: w[i].to,
                        first: i,
                        last: i,
                        context: w.slice(Math.max(0, i - contextWords), i + 1 + contextWords)
                                  .map((x) => x.text).join(' '),
                    });
                }
            }
            continue;
        }

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
            if (seen.has(firstWord)) continue;

            const w = stream.words;
            const matchText = w.slice(firstWord, lastWord + 1).map((x) => x.text).join(' ');
            if (wantsExclamation && !matchText.includes('!')) continue;

            seen.add(firstWord);
            hits.push({
                phrase,
                matched: matchText,
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

/// Collapse hits closer together than `spacing` seconds into one.
///
/// **A phrase said three times for emphasis is one moment**, not three, and a
/// list that says three is a list that cuts three clips of overlapping seconds
/// out of the same breath. The first of a cluster is the one kept, because that
/// is where the moment starts.
///
/// This is here rather than beside either caller because it is part of the
/// answer to *what counts as an instance*, and the panel and the clip cutter
/// have to agree on that as exactly as they agree on the matching. They did not:
/// this rule lived in `tools/corpus.js` alone, and the panel found fifteen of a
/// phrase the command line found fourteen of — the same corpus, the same search,
/// and a different answer, with nothing anywhere saying which was right.
export function spaced(hits, spacing = 2) {
    if (!(spacing > 0)) return hits.slice();
    const out = [];
    let last = -Infinity;
    for (const h of hits) {
        if (h.at - last < spacing) continue;
        last = h.at;
        out.push(h);
    }
    return out;
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

/// Every unbroken stretch of talking, ranked by length, pace, or energy.
///
/// Answers `{ at, to, seconds, words, rate, exclamations, caps, energyScore, opening }`
/// per run. `rate` is words per second, `exclamations` is the count of `!`, and
/// `energyScore` measures speech activation (rapid delivery, exclamations, and emphatic capitalization).
///
/// `opts`:
///   - `gap`: max pause between words (default 2s)
///   - `min`: min duration in seconds (default 30s)
///   - `mode`: 'longest' (default) | 'activated' | 'yelling'
///   - `minRate`: minimum cadence filter (e.g. 2.5 w/s for activated speaking)
export function monologues(words, opts = {}) {
    const gap = opts.gap === undefined ? 2 : opts.gap;
    const min = opts.min === undefined ? 30 : opts.min;
    const mode = opts.mode || 'longest';
    const minRate = opts.minRate === undefined ? (mode === 'activated' ? 2.5 : 0) : opts.minRate;
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
            const rate = n / seconds;
            if (rate >= minRate) {
                let exclamations = 0;
                let caps = 0;
                for (let k = from; k < i; k++) {
                    const txt = words[k].text || '';
                    if (txt.includes('!')) exclamations++;
                    const letters = txt.replace(/[^a-zA-Z]/g, '');
                    if (letters.length >= 2 && letters === letters.toUpperCase()) caps++;
                }
                const exclamationRatio = exclamations / n;
                const capsRatio = caps / n;
                // Energy score combines speaking cadence (rate) and emphatic/yelling markers
                const energyScore = rate * (1.0 + 2.0 * exclamationRatio + 1.2 * capsRatio);

                if (mode !== 'yelling' || exclamations > 0 || caps > 0 || energyScore >= 3.2) {
                    runs.push({
                        at: a.from, to: b.to, seconds, words: n,
                        rate,
                        exclamations,
                        caps,
                        energyScore,
                        opening: words.slice(from, Math.min(i, from + 12))
                                      .map((w) => w.text).join(' '),
                    });
                }
            }
        }
        from = i;
    }

    if (mode === 'activated') {
        return runs.sort((x, y) => y.rate - x.rate || y.seconds - x.seconds);
    }
    if (mode === 'yelling') {
        return runs.sort((x, y) => y.energyScore - x.energyScore || y.rate - x.rate || y.seconds - x.seconds);
    }
    return runs.sort((x, y) => y.seconds - x.seconds);
}
