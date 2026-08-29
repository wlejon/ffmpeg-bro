// Reading and writing the small files a corpus is made of, and printing the
// numbers that describe them.
//
// **These were `tools/drive.js`'s and they had to leave it, because `drive.js`
// is the headless driver.** It owns `pump`, `until` and the command line — a
// loop that gives the engine a slice of wall time and a parse of `--flag` — and
// none of that means anything inside a window, where the frame loop is the
// engine's own and there is no argv. A windowed application importing
// `drive.js` to get `mkdirp` would be importing the thing that stops the world.
// So the halves separate: what pumps the engine stays there, what touches a
// file comes here, and `drive.js` re-exports these so there is still exactly one
// `mkdirp` and one `readJson` in the repository.
//
// **A file of its own rather than the bottom of `store.js`**, because the
// dependency would run the wrong way otherwise: `drive.js` would have to import
// the corpus store to get a `writeJson` that has nothing to do with a corpus,
// and so would `corpus/pull.js`. `store.js` answers "where does this channel's
// recording live"; this answers "what is on disk and how big is it", and the
// second question is asked by three files that do not otherwise know about each
// other.

const fs = require('fs');

/// The repository root, with forward slashes.
///
/// **`require('fs')` resolves a relative path against the *app* directory**,
/// not the working directory the command was typed in — so `--out out/x.mp4`
/// writes to `ui/out/x.mp4` and the printed path and the written path are
/// different files. Everything here is made absolute against this instead,
/// which is what makes those two the same again.
///
/// **`bro.appDir` differs between the applications and the answer does not**,
/// which is the one thing to check before importing this into a window: the
/// workbench's app directory is `ui/`, the supercut application's is
/// `supercut/`, and the headless runner is given `ui/` — all three are one
/// directory below the repository root, so `..` is the same place from every
/// one of them. `supercut/cuts.js` already depends on exactly that to find
/// `build/cuts/`. If an application is ever installed somewhere that stops
/// being true, the honest fix is a caller that says where the corpus is — the
/// way `useCorpus` in `ui/library.js` takes a path — rather than a guess made
/// here from a directory name.
///
/// Guarded, because this runs at import time in a window: a throw here would be
/// an application that does not start, over a corpus nobody has asked for yet.
function repoRoot() {
    try { return fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/'); }
    catch (e) { return '.'; }
}

export const ROOT = repoRoot();

/// A path as given if it is already absolute, and against the repo root if not.
export const abs = (p) =>
    (/^([a-z]:[\\/]|[\\/])/i.test(String(p)) ? String(p) : `${ROOT}/${p}`)
        .replace(/\\/g, '/');

// ── saying how big and how long ────────────────────────────────────────────

export const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
export const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/// Seconds as `h:mm:ss`, which is how a VOD's own player writes a timestamp and
/// therefore what a person can paste back into one.
///
/// Deliberately not `clock` from `ui/format.js`, which pads the hours to two
/// digits for a timeline ruler: `01:23:45` and `1:23:45` are the same moment,
/// and the second is the one a Twitch URL and a terminal line are written in.
export const clock = (t) =>
    `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}` +
    `:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/// Seconds as a length a person reads rather than a timestamp they seek to.
export const span = (t) => (t >= 3600 ? `${(t / 3600).toFixed(1)} h`
                          : t >= 60 ? `${(t / 60).toFixed(1)} min`
                          : `${t.toFixed(1)} s`);

// ── small files beside the media ───────────────────────────────────────────

/// Make a directory and every parent of it.
///
/// Walked segment by segment rather than passed `{ recursive: true }`, because
/// this has to work on whatever `mkdirSync` this engine has rather than on the
/// one Node documents — and an already-existing segment is the ordinary case
/// here, not an error.
export function mkdirp(dir) {
    const parts = abs(dir).split('/');
    let at = parts[0];
    for (let i = 1; i < parts.length; i++) {
        at += `/${parts[i]}`;
        if (!parts[i]) continue;
        try { fs.mkdirSync(at); } catch (e) { /* there already, or a parent is */ }
    }
    return abs(dir);
}

export const exists = (p) => {
    try { return fs.existsSync(abs(p)); } catch (e) { return false; }
};

/// How big a file is, or 0 if it is not there.
export function sizeOf(p) {
    try { return fs.statSync(abs(p)).size || 0; } catch (e) { return 0; }
}

/// When a file was last written, in milliseconds, or 0 if it is not there.
///
/// One caller and a real one: a `.part` is a pull that stopped, *unless*
/// something is still writing it, and the only evidence available across two
/// processes is that it changed a moment ago. See `resumable` in `pull.js`.
export function modifiedAt(p) {
    try { return fs.statSync(abs(p)).mtimeMs || 0; } catch (e) { return 0; }
}

/// A JSON file, or `fallback` if it is absent or unreadable.
///
/// **Unreadable counts as absent on purpose.** These files are written by a
/// tool that can be interrupted halfway through a two-hour run, so a truncated
/// one is a thing that genuinely happens — and the useful response is to do the
/// step again, not to stop with a parse error.
export function readJson(p, fallback = null) {
    try { return JSON.parse(fs.readFileSync(abs(p), 'utf-8')); }
    catch (e) { return fallback; }
}

export function writeJson(p, value) {
    return writeText(p, `${JSON.stringify(value, null, 2)}\n`);
}

/// A text file, written whole, answering the absolute path it went to.
///
/// `writeJson`'s sibling for the one thing written here that is not JSON: the
/// `concat` demuxer's list, which **libavformat parses itself**, so it has to be
/// exactly the format libavformat expects rather than anything of ours. The
/// absolute path matters and is not a tidiness: `fs.writeFileSync` here resolves
/// a relative path against something other than this process's idea of the
/// working directory, and a list file written to the wrong place fails as "no
/// such file" at the *demuxer*, three steps from the mistake.
export function writeText(p, text) {
    const at = abs(p);
    mkdirp(at.slice(0, at.lastIndexOf('/')));
    fs.writeFileSync(at, text, 'utf-8');
    return at;
}

/// Delete a file, and do not complain that it was already gone.
export function unlink(p) {
    try { fs.unlinkSync(abs(p)); } catch (e) { /* gone */ }
}

/// Put a finished file under the name everything looks for.
///
/// **A name that exists is a file that finished**, which is the rule
/// `supercut/cuts.js` states and this obeys for the same reason: a session
/// killed mid-copy used to leave a truncated recording under the name the next
/// run would take for a complete one. Everything that writes a media file here
/// writes `<name>.part` and this is the only place the two names are joined up
/// — and it is called only after the writer has published a terminal state,
/// because renaming a file libav still holds fails silently on Windows.
export function rename(from, to) {
    try { fs.renameSync(abs(from), abs(to)); return true; }
    catch (e) { return false; }
}
