// A transcript on disk — the one-cue-per-word `.srt` a corpus is searched over.
//
// The transcript this repository writes is **one cue per word**, so an `.srt`
// here is a word list with times rather than a subtitle file in the ordinary
// sense. It is still an `.srt` because this application already opens a subtitle
// file as an ordinary `-i`, already draws its cues over the program monitor and
// already knows how to burn them in — so a transcript that arrives as cues is
// one every part of the app can already use, and nothing had to learn a new kind
// of thing.
//
// ── Why this is a file of its own and not the bottom of store.js ───────────
//
// `corpus/files.js` split from `corpus/store.js` for a reason that applies again
// here, one layer along. `store.js` answers **where a channel's recording
// lives** and never opens one; this answers **what is inside one of those files
// and how one is written**, which is a different question asked by different
// callers — `tools/` reads an `.srt` given a path and never asks the store
// anything, and `ui/library.js` parses its own cues out of a manifest without
// knowing this layout exists.
//
// The dependency settles it. The parse is `ui/phrase.js`'s (see below), and
// folding these three functions into `store.js` would mean that every consumer
// of `vodPaths` — `corpus/pull.js`, the status verb, a window asking where a
// recording is — imported the whole matcher to get a path.
//
// ── The parse is ui/phrase.js's, reached by relative path ─────────────────
//
// **One home for what a cue file says**, which is `parseSrt` in `ui/phrase.js`,
// beside the search that reads its output: the Find panel and these tools must
// not be able to disagree about what a transcript contains any more than they
// may disagree about what matches a phrase. CLAUDE.md states the same rule about
// the matching itself.
//
// Reached as `../ui/phrase.js` and deliberately **not** as `/app/phrase.js`,
// which is how `tools/transcript.js` reaches it: `/app` is the running
// application's own directory, which is `ui/` in the workbench and `supercut/`
// in the second application — and there is no `supercut/phrase.js`. A module in
// `corpus/` is imported by both windows, so it must name the file rather than
// the app. `corpus/pull.js` already reaches `../ui/export/copy.js` this way.
//
// The consequence, stated because it looks like a mistake: under the headless
// runner the two specifiers name one file through two paths and the engine holds
// two instances of it. Nothing in `phrase.js` has state — `parseSrt`, `find` and
// `bare` are pure functions of their arguments — so the two agree by
// construction, which is why `tools/transcript.js` was left as CLAUDE.md
// describes it rather than rewritten to match this.

import { parseSrt } from '../ui/phrase.js';
import { abs, mkdirp } from './files.js';

const fs = require('fs');

/// `hh:mm:ss,mmm` for a number of seconds.
export function stamp(s) {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:` +
           `${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/// Every word in an `.srt`, as `{ from, to, text }`.
///
/// The path goes through `abs` for `files.js`'s reason — `require('fs')`
/// resolves a relative path against the *app* directory rather than the working
/// directory the command was typed in — so a caller holding a path out of
/// `vodPaths` and a caller holding one a person typed are reading the same file.
export function readSrt(path) {
    return parseSrt(fs.readFileSync(abs(path), 'utf-8'));
}

/// Words out as cues, one per word. `words` is `{ from, to, text }`.
///
/// The 0.08 s floor is Parakeet's frame — two tokens from the same frame would
/// otherwise produce a cue that ends before it starts, which some readers refuse
/// and none of them draw.
export function writeSrt(path, words) {
    const at = abs(path);
    mkdirp(at.slice(0, at.lastIndexOf('/')));
    const srt = words.map((w, i) =>
        `${i + 1}\n${stamp(w.from)} --> ${stamp(Math.max(w.to, w.from + 0.08))}\n` +
        `${w.text}\n`).join('\n');
    fs.writeFileSync(at, srt, 'utf-8');
    return at;
}
