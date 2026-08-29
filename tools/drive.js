// Driving the headless engine from a tool, and the one place that knows how.
//
// Every tool in this directory needs the same six awkward things — where the
// repo root is, how to read an argument, how to let the engine breathe, how to
// wait for something that finishes on another thread, how to make a directory,
// and how to keep a small JSON file beside the media. They were copied into
// three files before this one existed, which is three chances for a `pump` that
// pumps a different amount and a `--flag` that parses differently.
//
// **`pump` is not a sleep and the difference is the whole reason it exists.**
// The engine is single-threaded and cooperative: a render running on a worker
// reports progress by posting onto the JS thread, and a tool that blocked would
// never come back to collect it. So waiting is a loop that gives the engine a
// slice — `wallSleep` yields the CPU, `advanceTime` moves the frame clock so
// animations and timers fire, `flush` drains the queues — and any one of the
// three left out is a hang rather than a slow wait.
//
// **`until` therefore has a deadline and names what it was waiting for.** A tool
// that runs for two hours across a network will eventually be waiting on
// something that is never going to arrive, and "timed out" is not a useful thing
// to be told at hour two. Every call passes a phrase that completes the sentence
// "timed out waiting for …".

const fs = require('fs');

/// The repository root, with forward slashes.
///
/// **`require('fs')` resolves a relative path against the *app* directory**
/// (`ui/`), not the working directory the command was typed in — so `--out
/// out/x.mp4` writes to `ui/out/x.mp4` and the printed path and the written path
/// are different files. Everything here is made absolute against this instead,
/// which is what makes those two the same again.
export const ROOT = fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/');

/// A path as given if it is already absolute, and against the repo root if not.
export const abs = (p) =>
    (/^([a-z]:[\\/]|[\\/])/i.test(String(p)) ? String(p) : `${ROOT}/${p}`)
        .replace(/\\/g, '/');

// ── the command line ───────────────────────────────────────────────────────

/// The arguments, with the `--` separator dropped.
///
/// `ffmpeg-bro-headless ui/ tool.js -- a b --flag c` arrives with the `--` still
/// in it, which is the runner's business and not the tool's.
export const argv = (globalThis.scriptArgs || []).filter((a) => a !== '--');

/// The positional arguments — everything that is not a `--name` or its value.
///
/// Worked out by walking rather than by index, because `list turk --last 5` and
/// `list --last 5 turk` are the same command and a tool that read `argv[1]`
/// would disagree.
export function positionals() {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out.push(a); continue; }
        // A `--name` takes the next token as its value unless that token is
        // itself a `--name`, which is what makes `--verbose` a flag without
        // needing a list of which names are flags.
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
    }
    return out;
}

/// One `--name value` pair, or a default.
export function opt(name, fallback = '') {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/// One `--name value` pair as a number, or a default.
///
/// **A default is returned for a missing option and an unreadable one alike**,
/// but not for a deliberate zero: `--snap 0` turns snapping off and must not
/// come back as the default 0.25. `Number('')` is 0, which is why the presence
/// of the option is tested before its value is.
export function num(name, fallback) {
    const i = argv.indexOf(`--${name}`);
    if (i < 0 || argv[i + 1] === undefined) return fallback;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) ? n : fallback;
}

/// Is `--name` present at all?
export const flag = (name) => argv.indexOf(`--${name}`) >= 0;

// ── letting the engine breathe ─────────────────────────────────────────────

/// Give the engine `ms` of wall time, in slices it can do something with.
export function pump(ms) {
    const n = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < n; i++) { wallSleep(20); advanceTime(20); flush(); }
}

/// Pump until `predicate` is true, or throw naming what never happened.
///
/// `onTick` is called about once a second with the seconds elapsed, which is how
/// a two-hour render says something rather than appearing to have hung.
export function until(what, predicate, timeoutMs, onTick = null) {
    const began = Date.now();
    const deadline = began + timeoutMs;
    let said = began;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(120);
        if (onTick && Date.now() - said > 1000) {
            said = Date.now();
            onTick((said - began) / 1000);
        }
    }
    throw new Error(`timed out waiting for ${what} after ` +
                    `${(timeoutMs / 1000).toFixed(0)} s`);
}

/// The drive pair the shared helpers in `speech.js` take.
export const driver = { pump, until };

// ── saying how big and how long ────────────────────────────────────────────

export const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
export const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/// Seconds as `h:mm:ss`, which is how a VOD's own player writes a timestamp and
/// therefore what a person can paste back into one.
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
    const at = abs(p);
    mkdirp(at.slice(0, at.lastIndexOf('/')));
    fs.writeFileSync(at, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    return at;
}

/// Delete a file, and do not complain that it was already gone.
export function unlink(p) {
    try { fs.unlinkSync(abs(p)); } catch (e) { /* gone */ }
}
