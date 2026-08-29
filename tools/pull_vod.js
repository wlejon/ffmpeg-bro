// Pull a VOD — all of it, or only the part you need — through ffmpeg-bro itself.
//
// This is a stream copy, not a download in the usual sense: the packets already
// on the CDN are written into a local container without being decoded, which is
// what `Rewrap` on the Write stage does and is why it runs at whatever the
// network will give rather than at whatever the encoder will.
//
// **The reason it takes a range is the whole point.** HLS is segmented — 1911
// segments of about ten seconds for this VOD — and `-ss`/`-to` *before* `-i` is
// a seek, so libavformat fetches the segments the window covers and no others.
// A montage of forty six-second hits is four minutes of picture out of five and
// a quarter hours, which is 0.6% of the bytes. The same mechanism serves both
// jobs, so there is one thing to get right:
//
//   whole file          --quality 1080p60
//   just the sound      --quality audio          (0.52 GB against 15.3 GB)
//   one window          --from 3600 --to 3660
//
// Usage:
//   ffmpeg-bro-headless ui/ tools/pull_vod.js -- <page-url> [options]
//     --quality <name>   a rendition name (1080p60, 720p60, …) or `audio`.
//                        Default: the best picture.
//     --from <seconds>   window start. Default: the beginning.
//     --to <seconds>     window end. Default: the end.
//     --out <path>       where to write. Default: build/vod/<id>-<quality>.mkv
//
// Matroska by default, because a copy has to go into a container that will hold
// what is being copied and Matroska holds very nearly everything — an mp4 would
// refuse the timed-ID3 track Twitch carries alongside the picture.

// `./vod.js` rather than `/app/vod.js`: page resolution is not a part of
// ffmpeg's model, so the ffmpeg-only pass over the UI took it out of the
// application and it lives here beside the tools that want it. See the block at
// the top of that file.
import { resolve, forListening } from './vod.js';

const argv = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const page = argv[0];
assert(page, 'usage: … tools/pull_vod.js -- <page-url> [--quality n] [--from s] [--to s]');

/// One `--name value` pair off the command line, or a default.
function opt(name, fallback = '') {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const wantQuality = opt('quality', '');
const from = Number(opt('from', '0')) || 0;
const to = Number(opt('to', '0')) || 0;

const A = globalThis.__ffmpegBro;
const fs = require('fs');
const ROOT = fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/');

function pump(ms) {
    const n = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < n; i++) { wallSleep(20); advanceTime(20); flush(); }
}
function until(what, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(120);
    }
    throw new Error(`timed out waiting for ${what}`);
}
const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// ── which stream ───────────────────────────────────────────────────────────

console.log(`resolving ${page}`);
const vod = await resolve(page);
console.log(`  ${vod.label} — ${vod.renditions.length} renditions`);

let pick;
if (/^audio$/i.test(wantQuality)) pick = forListening(vod);
else if (wantQuality)
    pick = vod.renditions.find((r) =>
        String(r.name).toLowerCase() === wantQuality.toLowerCase());
else pick = vod.renditions[0];

assert(pick, `no rendition called "${wantQuality}" — there is ` +
             vod.renditions.map((r) => r.name).join(', '));
console.log(`  pulling ${pick.name} (${Math.round(pick.bandwidth / 1000)} kb/s)`);

// ── the input, windowed ────────────────────────────────────────────────────

A.shell.goTo('sources');
pump(300);

// **The window goes on the copy rows, not on the input, and the difference is
// 550 MB.** `-ss` in front of an `-i` moves where this input's *zero* is — see
// `inputEpoch` in export_source.cpp — and for a stream copy it is not a seek:
// `CopyStreams::open` seeks to the earliest `copyFrom` its taps ask for
// (export_copy.cpp, `av_seek_frame` on the stream the in-point was measured
// against) and skips the seek entirely when that is zero. So an input windowed
// with `ss`/`to` and rows left at whole-file reads from the beginning and merely
// stops early: pulling 3600–3660 s this way fetched 560 MB and wrote a file
// claiming to be 61 minutes.
//
// `copyFrom`/`copyTo` are what actually seek, which is what `Cut` on the Write
// stage sets and is the mechanism this tool wants — libavformat asks the CDN
// only for the segments at or after the in-point.
const input = A.inputs.addInput({
    path: pick.url,
    name: `${vod.label} ${pick.name}`,
    origin: vod.page,
});
console.log('  opening…');
until('the stream to open', () => !!input.probe || !!input.error, 180000);
assert(!input.error, `could not open the stream: ${input.error}`);

// **A clip, because the Write stage will not open without one.** `prepare()`
// refuses an empty timeline, so an application holding an input and no clips has
// no way through to the stream list — which is a real gap for exactly this job,
// where the whole intention is "copy this input" and the timeline is beside the
// point. Laying one out is the cheap way round it here; it costs nothing,
// because every stream this render writes is a `copy:` and none of them reads
// the timeline at all.
A.openInput(input);
pump(600);

const span = to > 0 ? to - from : input.probe.format.duration;
console.log(`  ${input.probe.streams.map((s) => `${s.kind}/${s.codec}`).join(' + ')}` +
            ` · ${(input.probe.format.duration / 60).toFixed(1)} min available`);
if (from > 0 || to > 0)
    console.log(`  window ${from.toFixed(1)}–${(to || input.probe.format.duration).toFixed(1)} s ` +
                `(${span.toFixed(1)} s)`);
console.log(`  expect about ${gb(pick.bandwidth * span / 8)}`);

// ── copy it, through the application's own path ────────────────────────────

const outDir = `${ROOT}/build/vod`;
try { fs.mkdirSync(outDir); } catch (e) { /* already there */ }
const slug = String(pick.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const window = (from > 0 || to > 0) ? `-${Math.round(from)}-${Math.round(to || 0)}` : '';
const out = opt('out', `${outDir}/${vod.id}-${slug}${window}.mkv`);

A.shell.goTo('write');
pump(400);

const S = A.exporter.currentSettings();
S.container = 'matroska';
S.path = out;
A.exporter.redraw();
pump(200);

// `Rewrap` is the Write stage's own shortcut and it writes ordinary `copy:` rows
// into the stream list — so what runs here is exactly what a person pressing the
// button gets, and the printed command is the one they would see.
const rewrap = document.querySelector(`[data-rewrap="${input.id}"]`);
assert(rewrap, 'the Write stage is not offering to rewrap this input');
rewrap.click();
pump(400);

// **Twitch's HLS carries a `timed_id3` data track, and Matroska will not hold
// one.** The application says so before the render rather than after — "the
// matroska muxer may hold no data stream, which 'copy:0:2' is: mp4, mov and
// MPEG-TS carry one and Matroska does not" — which is the refusal working
// exactly as it should.
//
// It is dropped rather than kept, and the container is not changed to suit it,
// because what that track carries is Twitch's own segment metadata: it means
// nothing once the recording is off Twitch, and it is not what anybody pulling a
// VOD came for. `--keep-data` writes to mp4 instead for the case that is wrong.
const keepData = argv.indexOf('--keep-data') >= 0;
if (keepData) {
    S.container = 'mp4';
    S.path = out.replace(/\.mkv$/i, '.mp4');
    A.exporter.redraw();
    pump(200);
} else {
    const before = S.streams.length;
    S.streams = S.streams.filter((s) => s.kind !== 'data');
    if (S.streams.length !== before)
        console.log(`  leaving out ${before - S.streams.length} data stream` +
                    `${before - S.streams.length === 1 ? '' : 's'} ` +
                    '(Twitch segment metadata, which Matroska will not hold)');
    A.exporter.redraw();
    pump(200);
}

// The window, put where the copy path will actually act on it. `Rewrap` writes
// whole-file rows; this is what `Cut` would have written had the clip been
// trimmed to the same span.
if (from > 0 || to > 0) {
    for (const row of S.streams) {
        if (!String(row.source || '').startsWith('copy:')) continue;
        row.copyFrom = from;
        row.copyTo = to;
    }
    A.exporter.redraw();
    pump(200);
}

const copied = S.streams.filter((s) => String(s.source || '').startsWith('copy:'));
console.log(`copying ${copied.length} stream${copied.length === 1 ? '' : 's'} to`);
console.log(`  ${S.path}`);

const began = Date.now();
document.getElementById('ex-go').click();

// Progress, printed as it goes. A pull of the whole VOD is three quarters of an
// hour and a bar nobody can see is not a progress report.
let lastSaid = 0;
until('the pull to finish', () => {
    const p = bro.ffmpeg.render.poll();
    if (p.state !== 'running') return true;
    const now = Date.now();
    if (now - lastSaid > 15000) {
        lastSaid = now;
        const secs = (now - began) / 1000;
        const rate = p.bytes / Math.max(0.001, secs);
        const pct = p.progress > 0 ? `${Math.round(p.progress * 100)}% · ` : '';
        console.log(`  ${pct}${mb(p.bytes)} in ${secs.toFixed(0)} s ` +
                    `(${(rate / 1e6).toFixed(1)} MB/s)`);
    }
    return false;
}, 4 * 60 * 60 * 1000);

const done = bro.ffmpeg.render.poll();
const secs = (Date.now() - began) / 1000;
assert(done.state === 'done', `the pull ${done.state}: ${done.error || ''}`);

const got = bro.ffmpeg.probe(S.path);
console.log(`pulled ${gb(got.format.size)} in ${secs.toFixed(0)} s ` +
            `(${(got.format.size / 1e6 / secs).toFixed(1)} MB/s)`);
console.log(`  ${got.format.name} · ${(got.format.duration / 60).toFixed(1)} min · ` +
            got.streams.map((s) => `${s.kind}/${s.codec}`).join(' + '));
console.log(`  ${S.path}`);
console.log('done');
