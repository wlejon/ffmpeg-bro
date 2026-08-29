// One video frame per instance: a flipbook of every time somebody said a thing.
//
// The output is N pictures, each taken at the moment the phrase was said in a
// different broadcast, played back to back. At 30 fps forty instances is one and
// a third seconds — which is the point of it rather than a shortcoming, and is
// also why `--hold` exists.
//
// ── Why a still, and not a clip a frame long ──────────────────────────────
//
// A clip of one frame is a decoder, a seek and a boundary that has to round the
// same way at both ends; forty of them is forty decoders open on six-hour files,
// which is the cost `ui/residency.js` exists to refuse. A still is a PNG. So each
// instance is rendered out as a picture, once, and the flipbook is an image
// sequence — one `-i`, no decoders, and every frame provably the frame that was
// chosen because it is sitting on disk where it can be looked at.
//
// **The stills are kept.** They are the evidence for every frame in the video,
// and opening one is how you find out whether a hit was really the phrase. A
// supercut nobody can check is a supercut nobody can defend.
//
// ── Why there is no alignment step here, and why there used to be ─────────
//
// This file once resolved the Twitch page again, opened the 1080p60 rendition
// over the network, re-transcribed ten seconds around every hit and searched
// *that* for the phrase — a fetch, a decode and a model pass per instance, to
// recover a time the transcript already knew.
//
// It had to, because the transcript was made from the audio-only rendition and
// the pictures came from the picture one, and **two renditions of one Twitch VOD
// do not share a zero**: measured at three points of one recording the offset
// was +0.80 s, +2.21 s and +2.57 s — growing, but not steadily, which is a
// *step* rather than a drift and which therefore no offset and no slope can
// correct. A frame cut at the transcript's time landed on the wrong moment.
//
// `corpus.js` now pulls the whole recording, so the words and the pictures are
// **the same file's seconds** and a word's time is simply where the word is.
// What is left here is a seek and a render. The lesson is worth keeping: the
// alignment code was correct, well tested and completely unnecessary, and the
// way to delete it was to change where the input came from rather than to make
// it cleverer.
//
// ── Where in the word the frame is taken ──────────────────────────────────
//
// Not at the attack. A frame at the exact start of a word catches a mouth still
// opening — the phoneme has not happened yet — so the shot is taken `--into`
// seconds later, clamped to end before the word does. 0.10 s is about one
// syllable in and is what makes a still look like somebody *saying* the thing
// rather than about to.

import { openMedia, clearEdit } from './corpus.js';
import { mkdirp, exists, unlink, abs, clock } from './drive.js';

const fs = require('fs');

// ── one picture ───────────────────────────────────────────────────────────

/// Render a single frame of whatever is on the timeline, at `t`, to `out`.
///
/// **`image2`'s extension names a codec, not a container** — leaving the encoder
/// on the muxer's declared default lands every picture on mjpeg whatever the
/// file is called — so `png` is set by name rather than inferred.
///
/// Rendered into a numbered pattern in a scratch directory and then moved,
/// because a range is walked at the output rate and can land on two frames as
/// easily as one; taking the first of whatever appeared is deterministic where
/// asking for exactly one and hoping is not.
export function shoot(A, drive, t, out, opts = {}) {
    const work = opts.work;
    const fps = opts.fps || 30;
    // A fresh directory per shot, so "the first file in it" means this shot.
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* fine */ }
    mkdirp(work);

    A.shell.goTo('write');
    drive.pump(250);
    const S = A.exporter.currentSettings();
    S.container = 'image2';
    S.videoCodec = 'png';
    S.audio = false;
    S.path = `${work}/%04d.png`;
    S.rangeIn = t;
    // Half a frame, so the range cannot round up into a second picture.
    S.rangeOut = t + 0.5 / fps;
    S.fps = fps;
    if (opts.width) S.width = opts.width;
    if (opts.height) S.height = opts.height;
    S.streams = A.exporter.defaultStreams().filter((s) => s.kind === 'video');
    A.exporter.redraw();
    drive.pump(200);

    document.getElementById('ex-go').click();
    drive.until(`the frame at ${clock(t)}`,
                () => bro.ffmpeg.render.poll().state !== 'running', 10 * 60 * 1000);
    const p = bro.ffmpeg.render.poll();
    assert(p.state === 'done', `the frame at ${clock(t)} ${p.state}: ${p.error || ''}`);

    const made = fs.readdirSync(work).filter((f) => /\.png$/i.test(f)).sort();
    assert(made.length, `the render at ${clock(t)} wrote no picture`);
    unlink(out);
    fs.renameSync(`${work}/${made[0]}`, abs(out));
    return out;
}

// ── the whole thing ────────────────────────────────────────────────────────

/// Shoot every hit and assemble them into one video.
///
/// `hits` is `[{ vodId, media, at, matched, title }]` across any number of
/// recordings; they are grouped so each file is opened exactly once and its
/// seeks run forwards, which is the difference between a scrub and a thrash.
///
/// Takes no speech model. Nothing here listens to anything — the times came off
/// a transcript of these same files, so this is a seek and a render.
export function build(A, drive, opts) {
    const { hits, out } = opts;
    const fps = opts.fps || 30;
    const hold = Math.max(1, opts.hold || 1);
    const into = opts.into === undefined ? 0.10 : opts.into;
    const log = opts.log || console.log;

    const work = `${abs(out).slice(0, abs(out).lastIndexOf('/'))}/.flipbook`;
    const frames = `${work}/frames`;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* fine */ }
    mkdirp(frames);

    const byVod = new Map();
    for (const h of hits) {
        if (!byVod.has(h.vodId)) byVod.set(h.vodId, []);
        byVod.get(h.vodId).push(h);
    }

    const shots = [];
    const missed = [];
    let n = 0;
    let size = { width: opts.width || 0, height: opts.height || 0 };

    for (const [vodId, group] of byVod) {
        group.sort((a, b) => a.at - b.at);
        log(`${vodId} — ${group.length} hit${group.length === 1 ? '' : 's'}` +
            (group[0].title ? ` · ${group[0].title.slice(0, 48)}` : ''));

        // **A transcript outlives its recording.** The store keeps words even
        // after the media has been deleted to reclaim the disk, so a hit with no
        // file is an ordinary state and not a broken store — reported, skipped,
        // and the other recordings still contribute their frames.
        if (!group[0].media || !exists(group[0].media)) {
            log('  the recording is not on disk — skipping its hits');
            for (const h of group) missed.push({ ...h, why: 'recording not on disk' });
            continue;
        }

        clearEdit(A, drive);
        const source = openMedia(A, drive, group[0].media, { name: vodId });
        const end = source.probe.format.duration;
        if (!size.width && source.probe.video) {
            size = { width: source.probe.video.width, height: source.probe.video.height };
            log(`  ${size.width}×${size.height}`);
        }

        for (const h of group) {
            // Inside the word, clamped so it cannot run past the word's end or
            // off the end of the recording.
            const at = Math.min(h.at + into,
                                Math.max(h.at, (h.says || h.at) - 0.02),
                                end - 1 / fps);
            if (!(at >= 0 && at < end)) {
                log(`  – ${clock(h.at)} is outside the recording — dropped`);
                missed.push({ ...h, why: 'outside the recording' });
                continue;
            }
            n += 1;
            const png = `${frames}/${String(n).padStart(4, '0')}.png`;
            shoot(A, drive, at, png, {
                work: `${work}/.shot`, fps,
                width: size.width, height: size.height,
            });
            shots.push({ ...h, shotAt: at, png });
            log(`  ${String(n).padStart(3)}. ${clock(h.at)} “${h.matched}”`);
        }
    }

    assert(shots.length, 'not one instance could be shot');
    log(`shot ${shots.length} frame${shots.length === 1 ? '' : 's'}` +
        (missed.length ? ` · ${missed.length} dropped` : ''));

    // ── assemble ───────────────────────────────────────────────────────────
    //
    // One `-i` for the whole flipbook. The sequence's own `-framerate` is what
    // says how long each picture is on screen — `fps / hold` — and the output
    // encodes at `fps`, so `--hold 3` is each instance held for three frames
    // rather than a third of the pictures being dropped.
    clearEdit(A, drive);
    const pattern = `${frames}/%04d.png`;
    const input = A.inputs.addInput({
        path: pattern,
        // Forced rather than probed: `image2` and the `*_pipe` demuxers both
        // answer for a `.png`, and only one of them reads a *run* of them.
        format: 'image2',
        options: { framerate: String(fps / hold), start_number: '1' },
        name: 'flipbook',
    });
    drive.until('the stills to open', () => !!input.probe || !!input.error, 120000);
    assert(!input.error, `could not open the stills: ${input.error}`);
    const clip = A.openInput(input);
    assert(clip, 'the stills would not lay out as a clip');
    drive.pump(500);

    A.shell.goTo('write');
    drive.pump(400);
    const S = A.exporter.currentSettings();
    S.container = 'mp4';
    S.videoCodec = 'libx264';
    S.audio = false;
    S.fps = fps;
    S.path = abs(out);
    S.rangeIn = 0;
    S.rangeOut = 0;
    if (size.width) { S.width = size.width; S.height = size.height; }
    S.streams = A.exporter.defaultStreams().filter((s) => s.kind === 'video');
    A.exporter.redraw();
    drive.pump(250);

    log(`rendering ${abs(out)}`);
    document.getElementById('ex-go').click();
    drive.until('the flipbook',
                () => bro.ffmpeg.render.poll().state !== 'running', 60 * 60 * 1000);
    const done = bro.ffmpeg.render.poll();
    assert(done.state === 'done', `the flipbook ${done.state}: ${done.error || ''}`);

    const got = bro.ffmpeg.probe(abs(out));
    return { out: abs(out), shots, missed, frames,
             seconds: got.format.duration, bytes: got.format.size,
             width: size.width, height: size.height, fps, hold };
}
