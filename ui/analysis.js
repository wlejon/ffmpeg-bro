// Filling in what a clip looks and sounds like — as much of it as you are
// looking at.
//
// bro.media decodes the file twice more than the player does — every audio
// sample for the envelope, a frame every few seconds for the strip — so it runs
// in a worker and the lanes fill in as the answers arrive. One worker, one
// queue: adding a second clip while the first is still being read waits its
// turn rather than fighting it for the disk.
//
// ── A file is read whole; a link is read for the span on screen ─────────────
//
// The rule used to be one whole-file read per clip and nothing else, which is
// right for a file on disk and ruinous for one that is not. Measured against a
// six-hour Twitch VOD opened by URL:
//
//   24 thumbnails across the WHOLE recording      6.2 s
//   12 thumbnails across a 300 s window           3.4 s
//   the envelope of a 60 s window (Audio Only)    1.9 s
//   the envelope of a 300 s window (Audio Only)  13.1 s
//   the envelope of the whole recording        ~16 min, and every audio packet
//                                                of it down the link
//
// So the two halves are not the same job, and the asymmetry is the whole
// design: **a strip samples and an envelope integrates.** Twenty-four frames of
// a six-hour recording is twenty-four seeks and costs six seconds whether they
// are spread over the whole thing or over five minutes of it — so the picture
// is read across whatever the timeline is showing, at a bounded number of
// frames, and zooming out is not a bigger job. The envelope has to decode every
// sample between its ends, so it is read in a **bounded window**, and zooming
// out past that window leaves the lane honestly blank either side of it.
//
// Sixteen minutes of continuous decoding is not just slow. It is the link taken
// away from the thing you actually asked for, which on this stage is usually a
// local copy (`ui/localcopy.js`) being pulled down the same wire.
//
// `showing()` is how the timeline says which span is on screen. Nothing is read
// for a clip that is not, and a window already held is not read again.
//
// ── Where each half is read from ───────────────────────────────────────────
//
// The picture is read from the clip's own source, always: it is what the cut is
// made against. The sound is read from whichever of these exists first — the
// local copy, the local sound-only copy, the site's audio-only rendition, the
// clip itself — because the same soundtrack behind forty times fewer bytes is
// 3.4x faster to read (1.9 s against 6.5 s for the same sixty seconds), and
// once a copy is on this machine it is free and exact.
//
// **Two of those four are not on the clip's clock**, and that is carried rather
// than forgotten: an audio-only rendition of a Twitch VOD runs up to a couple of
// seconds away from the picture and no offset corrects it (the measurement is in
// the header of ui/localcopy.js). A waveform drawn from one is a waveform of
// this recording placed within a second or two, which is what exploring wants
// and is not what a cut is made from — so `peaks.about` says which source it
// came from and the lane prints it. `tickAnalysis` notices when a better source
// appears and re-reads, which is what makes pulling the sound improve the lane.
//
// ── The shapes, and why they are not the same shape ────────────────────────
//
// The envelope is **one array over the whole file, filled in progressively**:
// `peaks.have` marks which buckets have been read, and a window read scatters
// into its own slice. So every reader addresses it exactly as it always did —
// bucket `t / duration * buckets` — and the windowing is invisible to the
// drawing. The grid is fixed when the clip's source is (see `gridOf`), so two
// windows read at two zooms land in one array rather than in two that disagree.
//
// The strip cannot do that: a bitmap cannot be scattered into another bitmap
// without a canvas to composite through, and a whole-file strip at window
// resolution would be a texture nobody can afford. So the film is a **short
// list of strips**, newest first, and `frameAt` picks the one covering a moment.
//
// Neither is in the document, on the undo track or in the workspace: what a clip
// looks like is derived from the file, which is `peaks`'s standing rule.

import { project, changed, hasPicture, isGenerator } from './project.js';

// ── how much is read, and when ─────────────────────────────────────────────

/// A file on this machine: one read of the whole thing, exactly as before.
const wholeThumbs = (len) => Math.max(8, Math.min(120, Math.round(len / 2)));
const wholeBuckets = (len) => Math.max(600, Math.min(6000, Math.round(len * 12)));

/// A clip on a link. The numbers come from the table in the header.
const THUMB_HEIGHT = 96;
/// Sixteen seeks is about four seconds, which is the longest a lane should take
/// to answer a pan. Twenty-four is affordable too and is what a first, whole-
/// recording overview asks for, since that one is paid once.
const WINDOW_THUMBS = 16;
const OVERVIEW_THUMBS = 24;
/// The envelope's window, in seconds of the source: 120 s off a sound-only
/// source is about four seconds of reading, and 45 s off a muxed one is about
/// five. Two numbers because they are two costs — the muxed rendition carries
/// forty times the bytes for the same soundtrack.
const SOUND_SPAN = 120;
const MUXED_SPAN = 45;
/// How many times the window a view has to be before the envelope is not worth
/// reading at all. At four, a read fills a quarter of the lane — which is a
/// band you can see; at forty it is six pixels.
const TOO_WIDE = 4;
/// The window is padded either side of what is shown, so a small pan is already
/// held and does not start a read.
const PAD = 0.3;
/// How long a view has to hold still before it is read. A drag crosses hundreds
/// of spans and none of them is what you are looking at.
const SETTLE_MS = 200;
/// Strips kept per clip. Eight windows of sixteen frames at 96 px is a few MB,
/// and it is what makes panning back over ground already read instant.
const STRIPS_KEPT = 8;
/// The finest the progressive envelope is allowed to get, which is what bounds
/// its memory: 200k buckets is 2.4 MB of Float32 and puts a six-hour recording
/// at 108 ms a bucket. Beyond that the answer is not a finer grid, it is the
/// local copy — which is a file, and a file is read at its own resolution.
const GRID_MAX = 200000;

const HALVES = ['sound', 'picture'];

let worker = null;
let queued = 0;         // whole-file reads outstanding, for the status line
let windowed = 0;       // window reads in flight — see `tickAnalysis`
/// Every read ever handed to the worker. The only witness there is to the claim
/// this whole module makes — that a still view reads nothing and a window
/// already held is not read again — because a re-read of the same window
/// *replaces* what it produced and leaves the lanes, the strip count and the
/// coverage mask looking exactly as they did.
let reads = 0;

/// What each half of each clip is reading and what it has been asked for, by
/// clip id. Not held on the clip: it is bookkeeping about reads in flight, and
/// a clip that is split hands its *results* to both halves and its reads to
/// neither.
const state = new Map();

function halfState() {
    // `tried` is the last window handed to the worker, and it is what stops a
    // window that came back short of what was asked for from being asked for
    // again on every frame for ever. The same question of the same file has the
    // same answer, so asking it twice is never worth a read.
    return { src: '', link: false, about: '', want: null, since: 0,
             sent: null, tried: null, tooWide: false, token: 0 };
}

function stateOf(clip) {
    let st = state.get(clip.id);
    if (!st) { st = { sound: halfState(), picture: halfState() }; state.set(clip.id, st); }
    return st;
}

/// Where the worker script is, relative to the running application's directory.
///
/// A second application shares this file and does *not* share a copy of the
/// worker beside its own index.html — 47 lines duplicated is 47 lines that can
/// come to disagree about what a reading means. bro resolves a worker path
/// against the app's base directory by plain concatenation, so `../ui/…` is a
/// path out of the app and into the one home this script has.
let workerPath = 'analyze-worker.js';

/// Read from somewhere else, for an application whose directory is not `ui/`.
/// Must be called before the first analysis, which is what building the worker
/// is; after that it is the path already in use.
export function useWorker(path) {
    if (worker) return false;
    workerPath = path || 'analyze-worker.js';
    return true;
}

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerPath);
    worker.onmessage = (e) => receive(e.data);
    return worker;
}

// ── where a half is read from ──────────────────────────────────────────────

/// Which file each half of a clip is read from, and what that costs.
///
/// `path` is what the worker opens, `link` says whether it is over the network,
/// and `about` is what the lane says when the answer is not on the clip's own
/// clock — empty when it is, which is the common case and prints nothing.
///
/// **`input.remote` rather than a look at the string.** Whether an input is
/// read over a link is decided once, where the scheme is already being parsed
/// (`ui/inputs.js`), and a second reading of the same path here would be a
/// second answer to it — including about `file:`, which has a scheme and is a
/// file on this machine.
function sourceFor(clip, half) {
    const input = clip.input;
    const remote = !!(input && input.remote);
    const local = (input && input.localCopy) || '';
    if (local) return { path: local, link: false, about: '' };
    return { path: clip.src || clip.path, link: remote, about: '' };
}

// ── the envelope's grid ────────────────────────────────────────────────────

/// Seconds per bucket for a clip whose sound is read a window at a time.
///
/// **Fixed for as long as the source is**, and that is the point of it: two
/// windows read at two different zooms have to land in one array, and an array
/// that was re-cut every time somebody zoomed would throw away everything read
/// before. Twenty buckets a second where the file is short enough to afford it,
/// and a hard cap on the count where it is not.
function gridOf(clip) {
    const dur = clip.media || 0;
    if (dur <= 0) return 0;
    const n = Math.min(GRID_MAX, Math.max(600, Math.round(dur * 20)));
    return dur / n;
}

function newPeaks(clip, answer, about) {
    const dur = clip.media || answer.duration || 0;
    const step = gridOf(clip);
    const n = step > 0 ? Math.max(1, Math.round(dur / step)) : answer.buckets;
    return {
        sampleRate: answer.sampleRate, channels: answer.channels,
        duration: dur, buckets: n,
        min: new Float32Array(n), max: new Float32Array(n), rms: new Float32Array(n),
        // Which buckets have actually been read. A whole-file read fills it
        // completely; a windowed one fills its slice, and everything else is
        // silence nobody has looked at rather than silence in the recording —
        // which is a distinction the lane draws.
        have: new Uint8Array(n),
        about: about || '',
    };
}

/// Scatter a window's answer into the whole-file array.
///
/// By *time* rather than by index, because bro clamps a window to the file and
/// may hand back a span narrower than the one asked for — and an answer written
/// at the index it was requested at would then be written a bucket or two from
/// where it belongs, which is the kind of wrong that looks right.
function scatter(p, a) {
    const from = a.from || 0;
    const to = a.to || 0;
    if (!(to > from) || !a.buckets) return;
    const step = p.duration / p.buckets;
    const bw = (to - from) / a.buckets;
    for (let i = 0; i < a.buckets; i++) {
        const b0 = Math.max(0, Math.floor((from + i * bw) / step));
        const b1 = Math.min(p.buckets, Math.max(b0 + 1, Math.ceil((from + (i + 1) * bw) / step)));
        for (let b = b0; b < b1; b++) {
            // Merged rather than assigned: where a window's buckets are finer
            // than the grid, several of them land in one and what the lane
            // wants there is the loudest of them, not the last.
            if (p.have[b]) {
                if (a.min[i] < p.min[b]) p.min[b] = a.min[i];
                if (a.max[i] > p.max[b]) p.max[b] = a.max[i];
                if (a.rms[i] > p.rms[b]) p.rms[b] = a.rms[i];
            } else {
                p.min[b] = a.min[i]; p.max[b] = a.max[i]; p.rms[b] = a.rms[i];
                p.have[b] = 1;
            }
        }
    }
}

// ── what a view wants ──────────────────────────────────────────────────────

const same = (a, b) => a && b && Math.abs(a.from - b.from) < 0.5 &&
                       Math.abs(a.to - b.to) < 0.5 && a.n === b.n;

/// What should be read for a half, given the span of the source on screen.
///
/// Returns null when there is nothing to read — no sound in the file, no
/// picture, or a span that has closed to nothing.
function wantFor(clip, half, from, to, px) {
    const dur = clip.media || 0;
    if (dur <= 0) return null;
    let a = Math.max(0, Math.min(dur, from));
    let b = Math.max(0, Math.min(dur, to));
    if (!(b > a)) return null;
    const pad = (b - a) * PAD;
    a = Math.max(0, a - pad);
    b = Math.min(dur, b + pad);

    if (half === 'picture') {
        if (!hasPicture(clip)) return null;
        // Bounded by how many frames a lane can show rather than by the span:
        // the cost is the seeks, and the seeks do not care how far apart they
        // land. So zooming all the way out is the same job as a five-minute
        // window, which is what lets a six-hour recording have an overview at
        // all.
        const wide = b - a > dur * 0.75;
        const n = wide ? OVERVIEW_THUMBS
                       : Math.max(4, Math.min(WINDOW_THUMBS, Math.round(px / 90)));
        return { from: a, to: b, n };
    }

    if (!(clip.probe && clip.probe.audio)) return null;
    const step = gridOf(clip);
    if (step <= 0) return null;
    // Centred on what is shown and clipped to the window the reading can
    // afford — see the table in the header. Zoomed out past it, what is drawn
    // is the middle of the view and the lane says so by leaving the rest blank.
    // A sound-only source is worth two and a half times the window of a muxed
    // one because that is what it costs: 1.9 s against 6.5 s for sixty seconds
    // of the same soundtrack.
    const src = sourceFor(clip, 'sound');
    const cap = !src.link ? dur : (src.about ? SOUND_SPAN : MUXED_SPAN);
    // Far enough out and the window is not worth reading at all. Two minutes of
    // envelope in the middle of a six-hour lane is six pixels of waveform in an
    // otherwise empty bar — four seconds of reading for something that says
    // nothing about where anything is. Past this the lane says to zoom in
    // instead, which is a statement about why it is empty rather than an empty
    // lane you have to work out.
    if (b - a > cap * TOO_WIDE) return null;
    if (b - a > cap) {
        const mid = (a + b) / 2;
        a = Math.max(0, mid - cap / 2);
        b = Math.min(dur, a + cap);
    }
    // Snapped to the grid, so the answer lands on bucket boundaries and two
    // overlapping windows agree about the buckets they share.
    a = Math.floor(a / step) * step;
    b = Math.min(dur, Math.ceil(b / step) * step);
    const n = Math.max(1, Math.round((b - a) / step));
    return { from: a, to: b, n };
}

/// Is this want already answered by what the clip holds?
function covered(clip, half, want) {
    if (half === 'sound') {
        const p = clip.peaks;
        if (!p || !p.have) return false;
        const step = p.duration / p.buckets;
        const b0 = Math.max(0, Math.floor(want.from / step));
        const b1 = Math.min(p.buckets, Math.ceil(want.to / step));
        for (let b = b0; b < b1; b++) if (!p.have[b]) return false;
        return b1 > b0;
    }
    const film = clip.film;
    if (!film || !film.strips.length) return false;
    const wantStep = (want.to - want.from) / Math.max(1, want.n);
    for (const s of film.strips) {
        if (s.from > want.from + 0.5 || s.to < want.to - 0.5) continue;
        // Held at a coarser sampling than the view is asking for is not held:
        // a strip of the whole recording covers every window and answers none
        // of them, which is what would stop a zoom from ever filling in.
        if (s.step <= wantStep * 1.5) return true;
    }
    return false;
}

// ── the two ways a read is asked for ───────────────────────────────────────

/// Read a clip. Called when its source changes and nowhere else.
///
/// **A generator is read for neither half**, and the two refusals have different
/// reasons. There is no sound in one, so there is no envelope — the same
/// argument as a file with no audio track, one step further. And a filmstrip is
/// grabbed by *seeking* to a time and decoding a frame, which is the one thing a
/// `-f lavfi` source cannot do: libavfilter's sources produce forward and the
/// demuxer has no `read_seek`, so every grab after the first would answer with
/// the frame the reader happened to be sitting on. A lane of pictures that are
/// not the pictures at those moments is worse than a bar with no pictures on it,
/// which is what `timeline.js` draws for one.
export function analyzeClip(clip) {
    if (isGenerator(clip)) return;
    state.delete(clip.id);
    clip.peaks = null;
    clip.film = null;
    // What to ask for is `tickAnalysis`'s, which runs on the next frame and
    // every frame after it. Asking here as well would be a second place that
    // decides what a clip needs, and the two would come to disagree the first
    // time one of them learned about a source the other did not.
    tickAnalysis();
}

/// The timeline says which span of a clip's source is on screen, in source
/// seconds, and how wide the clip is there in pixels.
///
/// Asked once per clip per draw from `timeline.draw()` rather than from each
/// lane, because both lanes show the same span of the same clip and a second
/// caller would be a second answer to which seconds are in view.
export function showing(clip, from, to, px) {
    if (isGenerator(clip)) return;
    const st = stateOf(clip);
    for (const half of HALVES) {
        const h = st[half];
        // A file was read whole and there is nothing a view can add.
        if (!h.link) continue;
        const want = wantFor(clip, half, from, to, px);
        // Why the sound lane is empty, for `soundNote` to say. Recorded here
        // because this is where the view is known, and a note that worked it
        // out again from the clip would be a second answer to it.
        if (half === 'sound') h.tooWide = !want && !!(clip.probe && clip.probe.audio);
        if (!want || covered(clip, half, want)) { h.want = null; continue; }
        if (same(h.sent, want) || same(h.tried, want)) continue;
        if (!same(h.want, want)) { h.want = want; h.since = Date.now(); }
    }
}

/// Notice what has changed and hand the worker one thing to do.
///
/// On the frame loop rather than driven by `showing`, for two reasons: a view
/// that has come to rest stops redrawing, and it is the settle that decides a
/// read is wanted; and a source improving — a local copy landing — is not a
/// view change and nothing would otherwise look.
export function tickAnalysis() {
    const now = Date.now();
    for (const clip of project.clips) {
        if (isGenerator(clip)) continue;
        const st = stateOf(clip);
        for (const half of HALVES) {
            const h = st[half];
            const src = sourceFor(clip, half);
            if (src.path !== h.src || src.link !== h.link) {
                // **A source this clip has never been seen with is not a source
                // that changed.** A clip that was just split holds the halves
                // its parent had read, handed over by `splitClip` — a cut does
                // not change how either side looks — and a first sighting that
                // wiped them would make splitting a clip re-read the file
                // twice for a picture it already has.
                const first = !h.src;
                h.src = src.path;
                h.link = src.link;
                h.about = src.about;
                // The token moves whatever the reason, so an answer already in
                // flight about the old source lands nowhere.
                h.token++;
                h.want = null;
                h.sent = null;
                h.tried = null;
                if (!first) { if (half === 'sound') clip.peaks = null; else clip.film = null; }
                if (!src.path) continue;
                const held = half === 'sound' ? clip.peaks : clip.film;
                if (!src.link && !held) {
                    // A file is read whole, in one job, immediately — which is
                    // what this has always done and what every local document
                    // depends on for its timings.
                    const whole = half === 'sound'
                        ? (clip.probe && clip.probe.audio
                            ? { from: 0, to: 0, n: wholeBuckets(clip.media) } : null)
                        : (hasPicture(clip)
                            ? { from: 0, to: 0, n: wholeThumbs(clip.media) } : null);
                    if (whole) { queued++; post(clip, half, h, whole); }
                }
                continue;
            }
            if (!h.want || h.sent) continue;
            if (now - h.since < SETTLE_MS) continue;
            // One window read at a time across the whole application. They are
            // seconds each and they share one link; two at once would halve
            // each other and answer nothing sooner. A whole-file read is not
            // counted here — those are local and are posted as they arrive.
            if (windowed >= 1) continue;
            windowed++;
            post(clip, half, h, h.want);
        }
    }
}

function post(clip, half, h, want) {
    reads++;
    h.sent = want;
    h.tried = want;
    // The want has become a read. Left standing it would be posted again the
    // moment the answer landed, since `covered` is only re-asked by a draw.
    h.want = null;
    ensureWorker().postMessage({
        clip: clip.id, half, token: h.token,
        // The input's token rather than its path where the clip is read as
        // itself, so a strip is of the file as the input opens it — `bro.media`
        // goes through the same backend registry `<video>` does and resolves a
        // token the same way. A local copy and a sibling rendition are ordinary
        // paths, because neither is an input.
        path: h.src,
        from: want.from, to: want.to, n: want.n, height: THUMB_HEIGHT,
    });
}

// ── answers ────────────────────────────────────────────────────────────────

function receive(msg) {
    if (!msg) return;
    const clip = project.clips.find((c) => c.id === msg.clip);
    const st = clip ? state.get(clip.id) : null;
    const h = st && st[msg.half];
    // The counters first and unconditionally: a job that answered is a job that
    // is over, whether or not anybody still wants what it says.
    if (msg.done) {
        if (msg.to > 0) windowed = Math.max(0, windowed - 1);
        else queued = Math.max(0, queued - 1);
    }
    // A clip that was deleted while its analysis was running, or one whose
    // source changed under it: the result has nowhere to go, which is fine — it
    // cost nothing extra to let it finish. Checked *before* `sent` is cleared,
    // because a source that changed already cleared it and the new source's
    // read could have the same two ends.
    if (!clip || !h || h.token !== msg.token) return;
    if (h.sent && h.sent.from === msg.from && h.sent.to === msg.to) h.sent = null;
    if (msg.error) { console.log(`analysis (${msg.half}) ${clip.name}: ${msg.error}`); return; }

    if (msg.half === 'sound') {
        // Null is "there is no audio track in it", which is an answer and not a
        // failure — and one worth not asking again, which is what clearing the
        // want does.
        if (!msg.peaks) { h.want = null; return; }
        if (msg.to <= 0) {
            // A whole-file read is kept exactly as it came back: its own bucket
            // count, no grid and no `have`, which is what every reader has
            // always been handed. Re-cutting it onto the windowed grid would
            // spread six thousand buckets across two hundred thousand and call
            // the result a finer waveform.
            clip.peaks = msg.peaks;
            clip.peaks.about = h.about;
        } else {
            if (!clip.peaks || !clip.peaks.have) clip.peaks = newPeaks(clip, msg.peaks, h.about);
            scatter(clip.peaks, msg.peaks);
        }
        changed('analysis');
        return;
    }

    const t = msg.thumbs;
    if (!t || !t.count) { h.want = null; return; }
    const img = new ImageData(new Uint8ClampedArray(t.data.buffer || t.data),
                              t.width * t.count, t.height);
    createImageBitmap(img).then((bitmap) => {
        // times are seconds into the file, which is what lets the strip be
        // placed by time rather than in even slots — the only thing that stays
        // honest once the timeline can zoom.
        const strip = {
            bitmap, count: t.count, times: t.times,
            from: msg.to > 0 ? msg.from : 0,
            to: msg.to > 0 ? msg.to : (clip.media || 0),
            step: 0,
        };
        // The sampling this strip **answers for**, from what was asked rather
        // than from what came back. A file that ran out of frames gives a short
        // strip, and a step computed from the short count would read as coarser
        // than the request — so the request would never be satisfied and the
        // same window would be read on every frame for ever.
        strip.step = (strip.to - strip.from) / Math.max(1, msg.n || t.count);
        if (!clip.film || clip.film.width !== t.width || clip.film.height !== t.height)
            clip.film = { width: t.width, height: t.height, rotation: t.rotation || 0, strips: [] };
        // Newest first, and anything it completely covers at the same sampling
        // or coarser goes: panning over ground already read must not grow the
        // list, and a re-read of the same window is the common case.
        clip.film.strips = [strip].concat(clip.film.strips.filter(
            (s) => !(s.from >= strip.from - 0.5 && s.to <= strip.to + 0.5 &&
                     s.step >= strip.step - 1e-6)));
        if (clip.film.strips.length > STRIPS_KEPT) clip.film.strips.length = STRIPS_KEPT;
        changed('analysis');
    });
}

// ── reading what was read ──────────────────────────────────────────────────

/// Last thumbnail grabbed at or before `t` seconds into the file.
function thumbAt(times, t) {
    let lo = 0, hi = times.length - 1, best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
}

/// The frame to draw for a moment of a clip's source, or null where none has
/// been read.
///
/// The finest strip covering the moment wins, which is what makes a window read
/// at a zoom replace the overview inside its own span and leave it everywhere
/// else. `i` is the thumbnail's index within `bitmap`, whose tiles are
/// `film.width` wide.
export function frameAt(film, t) {
    if (!film || !film.strips.length) return null;
    let best = null;
    for (const s of film.strips) {
        if (t < s.from - s.step || t > s.to + s.step) continue;
        if (!best || s.step < best.step) best = s;
    }
    if (!best) return null;
    return { bitmap: best.bitmap, i: Math.min(best.count - 1, thumbAt(best.times, t)) };
}

/// What the waveform lane should say about a clip, or '' when the shape speaks
/// for itself.
///
/// A **statement**, in `ui/export/explain.js`'s sense: which recording the
/// envelope was read from is the answer to a question somebody looking at a
/// two-second discrepancy is holding right now, and it changes with what has
/// been pulled onto this machine.
/// **Gated on `clip.probe` and not on a decoder being up.** The lane used to
/// ask `clip.ready`, which was a field on the clip that nothing in the
/// application ever set to true — so the sentence it guarded had never once
/// been drawn, for anybody, which is why nobody had noticed that a file with no
/// audio track said nothing about it. The precondition for saying anything here
/// is knowing what streams the file has, and that is the probe.
export function soundNote(clip) {
    if (!clip || !clip.probe || isGenerator(clip)) return '';
    if (!clip.probe.audio) return 'no audio track';
    const st = state.get(clip.id);
    if (st && st.sound.tooWide) return 'zoom in to read the sound';
    const p = clip.peaks;
    if (!p || !p.buckets || !p.duration) return 'reading…';
    return p.about || '';
}

/// How many clips are still being read, for the status line.
export function pending() { return queued + windowed; }

/// How many reads have been made of anything, ever. See `reads` for why this is
/// the only thing that can check what this module is for.
export function readCount() { return reads; }
