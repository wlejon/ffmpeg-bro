// Where this application is, and therefore what every path it keeps for itself
// is relative to.
//
// ── Why this is a file rather than an expression ───────────────────────────
//
// `build/corpus`, `build/cuts` and `models/parakeet` are not somebody's files:
// they are the application's own, and where they are cannot depend on the
// directory a person happened to be standing in. That is not a tidiness — it was
// a bug with a face. `ui/library.js` read the manifest at the *relative* path
// `build/corpus/find.json` while `corpus/store.js` wrote the store at an
// absolute one, so a window started from anywhere but the repository root found
// no corpus and said so, over a `build/corpus` full of transcribed recordings,
// and every recording it then read went into a store its own search could not
// see. The instruction that hid it — *run it from the repository root* — is a
// thing you can only obey in a terminal, which makes it the last terminal in a
// window that had just learned to fetch its own recordings, its own transcripts
// and its own model.
//
// **`require('fs')` resolves a relative path against the app directory and then
// against the process's**, and the app directory differs between the two
// windows (`ui/`, `supercut/`) while the answer must not — so neither of those
// is the thing to write paths against. One level above the app directory is:
// it is the repository root in a checkout and the `app/` of a packaged tree
// (`scripts/package-release.sh`), and both are where that build keeps its
// `build/`.
//
// ── Why it is in `ui/` ─────────────────────────────────────────────────────
//
// Three files had their own copy of this before it had a home — `corpus/files.js`
// derived it, `supercut/cuts.js` derived it again for `build/cuts`, and
// `ui/library.js` did not derive it at all, which is the half that was wrong.
// `ui/` is the layer all three already share: the supercut window imports its
// model modules by relative path (`supercut/mix.js` and everything beside it),
// `corpus/` is imported by both windows and by the batch verbs, and nothing here
// touches the DOM or drives an application — which is the property that lets any
// of them import it. It is deliberately not in `corpus/`: the workbench's `ui/`
// imports nothing from there, and it needs this answer too.

const fs = require('fs');

/// The directory this application's own `build/` sits in, with forward slashes.
///
/// Guarded, because this runs at import time in a window: a throw here would be
/// an application that does not start, over a path nobody has asked for yet.
function appRoot() {
    try { return fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/'); }
    catch (e) { return '.'; }
}

export const ROOT = appRoot();

/// A path as given if it is already absolute, and against `ROOT` if not.
export const abs = (p) =>
    (/^([a-z]:[\\/]|[\\/])/i.test(String(p)) ? String(p) : `${ROOT}/${p}`)
        .replace(/\\/g, '/');
