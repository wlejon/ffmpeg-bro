// What a render is doing, while it does it.
//
// Three states with three different things worth saying. A finished render
// offers to put the result back on the timeline, which is the fastest way to
// see what you just made; a stopped one says what it managed to write and that
// the part it got to is playable, because a cancelled render here still lays
// down its trailer.

import { el, div, put, fromTemplate } from '../dom.js';
import { bytes, elapsed, basename } from '../format.js';
import { verdict, openReport } from '../report.js';
import { kindOf, openable } from './destination.js';
import { settings } from './state.js';
import { muxerInfo } from './capabilities.js';

/// What shape the destination of the render being watched is. Asked of the
/// settings rather than carried in the status, because it is a fact about what
/// was asked for and the renderer has no opinion about it.
const destinationKind = () => kindOf(muxerInfo(settings.container) || {});

let pane = null;
let hooks = {};

export function initProgress(node, h) {
    pane = node;
    hooks = h || {};
}

// The nodes of the running panel while one is up, so that a frame can write
// numbers into them instead of building them again. Null the moment the render
// is not running, which is what makes the three states below unable to inherit
// each other's elements.
let live = null;

export function drawProgress(p) {
    const pct = Math.round((p.progress || 0) * 100);
    if (p.state === 'running') return runningPanel(p, pct);
    live = null;
    if (p.state === 'done') return put(pane, () => done(p));
    return put(pane, () => stopped(p, pct));
}

/// The bar, at a percentage and optionally in another colour.
function bar(pct, cls) {
    const node = fromTemplate('tpl-bar');
    const fill = node.querySelector('.ex-fill');
    fill.style.width = `${pct}%`;
    if (cls) fill.classList.add(cls);
    return node;
}

const line = (text, cls = '') => div(`ex-line ${cls}`.trim(), text);

/// What libav had to say about this render, where somebody is already looking.
///
/// A render can succeed and still have been told something worth knowing — a
/// profile the encoder refused, a bitrate it clamped, a tag the muxer would not
/// take. A green bar over a file that is not what was asked for is the failure
/// this whole channel exists to prevent, so the count is stated here and the
/// way to read it is one click. Absent entirely when there is nothing to say:
/// a panel that always carries a "0 warnings" line teaches people to skip the
/// place the real one will appear.
function said() {
    const v = verdict();
    if (!v.errors && !v.warnings) return null;
    const bits = [];
    if (v.errors) bits.push(`${v.errors} error${v.errors === 1 ? '' : 's'}`);
    if (v.warnings) bits.push(`${v.warnings} warning${v.warnings === 1 ? '' : 's'}`);
    return div('ex-line ex-acts', [
        el('button', {
            cls: 'tiny', 'data-f': 'report',
            text: `${bits.join(' and ')} — what the render said`,
            on: { click: openReport },
        }),
    ]);
}

/// What is arriving, said in the terms the destination makes true.
///
/// **The three shapes cannot share a sentence.** A bounded render into one file
/// has frames and a total and therefore an estimate; a render into a set of
/// files has all of that *and* a count of pieces, which is the thing actually
/// showing up on disk and the only number that says a segmenter is segmenting;
/// a stream has no size, no percentage and nothing to open, and what it can say
/// honestly is how long it has been going and how fast the bytes are leaving.
/// A bar creeping towards an end nobody chose is the failure this avoids, and
/// it is the same rule a recording already follows — `openEnded`, and zero
/// meaning nobody knows.
///
/// **The words, not the element.** What the running panel wants from this is the
/// sentence to write into a row it already has — see `writeRunning` — and ''
/// where this shape has nothing extra to say, which is also what decides whether
/// the row exists at all.
function shapeLine(p, kind) {
    if (kind === 'stream') {
        const rate = p.elapsed > 0 ? (p.bytes * 8) / p.elapsed : 0;
        return `${bytes(p.bytes)} sent · ${(rate / 1e6).toFixed(2)} Mb/s`;
    }
    if (p.pieces > 0) return `${p.pieces} file${p.pieces === 1 ? '' : 's'} written so far`;
    return '';
}

/// Which of the running panel's rows exist at all, as one string.
///
/// Everything in it is a question about *shape* rather than about a number: is
/// there a bar, is there a pass line, does this destination count pieces, is it
/// packets or frames being counted. All of them can change part way through a
/// render — pass one becomes pass two, the first segment lands — and none of
/// them changes on the ordinary frame where only the numbers moved.
const runningKey = (p, kind, open) =>
    [open, (p.passes || 1) > 1, kind, p.pieces > 0, !!p.packets, !p.totalFrames].join('|');

/// The panel for a render that is happening, **built once and written into
/// afterwards.**
///
/// It used to be `put()` on every frame, which tore six elements down and built
/// six more sixty times a second for the length of the render — to change four
/// numbers. That is the thing this codebase already refuses to do to the stream
/// list on a drag, and it is worse here: this is the one panel somebody watches
/// for minutes at a time, and rebuilding it under the compositor is what made a
/// running render smear its own lines over each other.
function runningPanel(p, pct) {
    const kind = destinationKind();
    const open = p.openEnded || kind === 'stream';
    const key = runningKey(p, kind, open);
    if (!live || live.key !== key) live = buildRunning(p, kind, open, key);
    writeRunning(live, p, pct, kind, open);
}

function buildRunning(p, kind, open, key) {
    const it = { key };
    // A render with no end has no fraction to draw, and a bar at zero for ten
    // minutes says "stuck" rather than "streaming".
    it.bar = open ? null : bar(0);
    it.fill = it.bar ? it.bar.querySelector('.ex-fill') : null;
    // Which walk over the range this is, and what it is for. A render that is
    // going to do the whole thing again must not report "43%" and leave the
    // rest to be discovered — the percentage already spans the job, and this is
    // what says why it is moving at half the rate it looks like it should.
    it.pass = (p.passes || 1) > 1 ? line('', 'dim') : null;
    it.count = line('', 'mono');
    it.shape = shapeLine(p, kind) ? line('', 'mono') : null;
    it.rate = line('', 'mono dim');
    it.path = line(p.path, 'dim');
    put(pane, () => [
        it.bar, it.pass, it.count, it.shape, it.rate, it.path,
        // **The way out of a render, and it was not on the screen.** `Stop` was
        // the Write stage's own Back button retitled — and the panel that
        // retitles it is the panel that hides the column the button is in, so a
        // running export had a Stop nobody could reach and no other way to end
        // one. It belongs here regardless: what you stop is the thing in front
        // of you, and a render in progress is what this panel is.
        div('ex-line ex-acts', el('button', {
            cls: 'tiny', 'data-f': 'stop', text: 'Stop',
            title: 'Stop',
            on: { click: hooks.stop },
        })),
    ].filter(Boolean));
    return it;
}

function writeRunning(it, p, pct, kind, open) {
    const left = !open && p.fps > 0 && p.totalFrames
        ? Math.max(0, (p.totalFrames - p.frames) / p.fps) : 0;
    if (it.fill) it.fill.style.width = `${pct}%`;
    if (it.pass)
        it.pass.textContent = `pass ${p.pass} of ${p.passes}` +
                              (p.passLabel ? ` — ${p.passLabel}` : '');
    // **Four shapes, because the count and the total are two questions.** A
    // render that copies packets has no output frames at all — what it writes is
    // packets and how many there are is not a thing anybody knows before reading
    // them. A job with no end counts frames and has no total. And a paced render
    // (`-fps_mode vfr`) counts frames, has no total either — the graph decides
    // how many it makes — and still has an honest percentage, because that one is
    // computed against the range's *length*. So `totalFrames == 0` no longer says
    // which of the three it is and `packets` is what tells them apart: "frame 40
    // of 0" looks like a bug in the progress bar, and "40 packets copied" about a
    // render encoding pictures is worse, being wrong and reading as right.
    it.count.textContent =
        p.packets ? `${p.frames} packets copied`
      : open ? `frame ${p.frames}`
      : !p.totalFrames ? `${pct}% · frame ${p.frames}`
                       : `${pct}% · frame ${p.frames} of ${p.totalFrames}`;
    if (it.shape) it.shape.textContent = shapeLine(p, kind);
    it.rate.textContent = `${p.fps.toFixed(1)} fps · ${elapsed(p.elapsed)} so far` +
                          (left > 0.5 ? ` · about ${elapsed(left)} left` : '') +
                          (kind === 'stream' ? '' : ` · ${bytes(p.bytes)}`);
    it.path.textContent = p.path;
}

function done(p) {
    const kind = destinationKind();
    // **A render to a set of files is not "done, here is your file", and a
    // render to a socket has nothing to open at all.** `openable()` is where
    // that is decided — the playlist for hls, the first picture of a numbered
    // run, whichever tee destination is local, nothing for a stream — because
    // a button offering to open something that is not there is worse than no
    // button.
    const back = el('button', { cls: 'tiny', 'data-f': 'back', text: 'Back to settings',
                                on: { click: hooks.back } });
    const open = openable(kind, p.path);
    const buttons = open
        ? [el('button', { cls: 'tiny', 'data-f': 'import', text: 'Add it to the timeline',
                          on: { click: () => hooks.addToTimeline(open) } }), back]
        : [back];

    return [
        bar(100, 'done'),
        line(kind === 'stream' ? `Sent to ${p.path}`
                               : `Wrote ${p.pieces > 0 ? `${p.pieces + 1} files` : basename(p.path)}`,
             'good'),
        line(`${p.frames} ${p.packets ? 'packets' : 'frames'} · ` +
             `${bytes(p.bytes)}${kind === 'stream' ? ' sent' : ''} · ` +
             `${elapsed(p.elapsed)} at ${p.fps.toFixed(1)} fps`, 'mono dim'),
        line(p.path, 'dim'),
        // What "the result" is, when it is not the thing that was named. The
        // playlist is a file that says where the pieces are, and saying so is
        // the difference between a render somebody can use and one they have to
        // go and look in a folder to understand.
        kind === 'files' && open && p.pieces > 0
            ? line(`${p.pieces} more beside it; ${basename(open)} is the one to open`, 'dim')
            : null,
        kind === 'stream'
            ? line('nothing was kept — a stream is gone once it has been sent', 'dim') : null,
        said(),
        div('ex-line ex-acts', buttons),
    ].filter(Boolean);
}

function stopped(p, pct) {
    const cancelled = p.state === 'cancelled';
    return [
        bar(pct, 'stopped'),
        line((cancelled ? 'Stopped' : 'Export failed') + (p.error ? `: ${p.error}` : ''),
             cancelled ? 'dim' : 'ex-failed'),
        cancelled ? line((p.packets ? `${p.frames} packets were copied`
                                    : p.totalFrames
                                        ? `${p.frames} of ${p.totalFrames} frames were written`
                                        : `${p.frames} frames were written`) +
                         ', and the part it got to is playable', 'mono dim') : null,
        cancelled ? line(p.path, 'dim') : null,
        said(),
        div('ex-line ex-acts', el('button', { cls: 'tiny', 'data-f': 'back', text: 'Back to settings',
                                      on: { click: hooks.back } })),
    ];
}
