// Driving the headless engine from a tool, and the one place that knows how.
//
// Every tool in this directory needs the same six awkward things — where the
// repo root is, how to read an argument, how to let the engine breathe, how to
// wait for something that finishes on another thread, how to make a directory,
// and how to keep a small JSON file beside the media. They were copied into
// three files before this one existed, which is three chances for a `pump` that
// pumps a different amount and a `--flag` that parses differently.
//
// **Half of that list now lives in `corpus/files.js` and is re-exported from
// here**, so a tool still asks this file for all six and there is still one
// implementation of each. The split is by what the thing means rather than by
// what it does: `pump`, `until` and the command line are *this* runner — a loop
// that stops the world for a slice of wall time, and a parse of `argv` — and
// neither exists inside a window. A windowed application needs `mkdirp` and
// `readJson` and must never import the thing that stops the world to get them.
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

// Where the repo root is, how to make a directory, how to keep a small JSON
// file, and how to print a size or a length — all of it `corpus/files.js`'s
// now, and re-exported so every tool here still has one place to ask.
export { ROOT, abs, mkdirp, exists, sizeOf, readJson, writeJson, unlink, rename,
         gb, mb, clock, span } from '../corpus/files.js';

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
