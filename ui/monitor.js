// The meter beside the viewer: how loud what is leaving *now* is.
//
// A1 on the timeline is drawn in decibels with a line where clipping is, so an
// over can be *found* — but it is the analysis's buckets, per clip, made before
// anything was played. That answers "where in this shot is it loud". It cannot
// answer the question somebody standing in front of the program monitor actually
// has, which is "is what I am hearing right now too loud", because that is about
// the *output* and about this instant.
//
// So this is a strip of bars beside the picture, on the same scale A1 is drawn on
// (`levels.js`), driven by whichever of two things is making the sound. Which two,
// and why they are not the same reading, is the whole of this file.
//
// ── With `O` on: the render's own mix ──────────────────────────────────────
//
// The output preview is a render running behind a `LiveTap`, and it publishes its
// soundtrack there for the element to play (`playback_output.h`). It measures every
// block on the way past whether or not anybody is listening — the same mechanism a
// capture session's meters read, which is what the Not-yet entry meant by "the
// same missing piece as monitoring a capture below". What comes back is therefore:
//
//   - **per channel of the output**, however many the output has, because the mix
//     is made at the channel count the encoder will be opened with and the reading
//     is taken from that mix rather than from a stereo fold-down of it;
//   - a **true peak**, 4× oversampled — the loudest point on the signal and not
//     merely the loudest sample, which is the difference between a meter that
//     catches an inter-sample over and one that reports a limiter is fine while it
//     distorts. See `sound_meter.h` for the filter and its measured error;
//   - **every block**, not a sample of the ones that happened to be passing when
//     the UI looked, because reading accumulates and clears.
//
// That is the meter this entry was asking for, and it is the reading to trust.
//
// ── With `O` off: bro's master bus, which is a different claim ─────────────
//
// During ordinary playback there is no render. The compositor is not running; the
// clips' `<video>` elements are, and **bro's mixer is summing them** — so there is
// no `mixInto` to measure and no tap to read one from. Three things could have
// gone here and two of them are dishonest:
//
//   - summing the clips' analysed peaks and calling it a meter is the waveform
//     wearing a meter's name, which is exactly what the Not-yet entry complains
//     about; it would be a *prediction* of the mix, made from buckets, drawn as a
//     measurement of it;
//   - running the output preview silently in the background to get a number would
//     double every decode on the machine to light up a strip nobody asked to be
//     accurate to a tenth of a decibel;
//   - asking bro what its mixer actually summed. That one is true, and it is what
//     this does.
//
// **What was read, and why it is the output's level rather than a clip's.** bro's
// audio engine meters every mix bus: `Bus::peakL/peakR/rmsL/rmsR` in
// `third_party/broaudio/include/broaudio/mix/bus.h`, written by
// `Engine::updateBusMeters` at the tail of `processBusEffects` and reachable from
// JS as `AudioContext.getBusPeakL(0)` and its three siblings. Bus 0 is the master,
// and every `<video>` lands on it: `ElVideo` (`src/layout/el_video.cpp`) pushes its
// samples through `pushStreamSamples` and never calls `setPlaybackBus`, so
// `ClipPlayback::busId` stays at its default of 0. The number is therefore the sum
// of every clip under the playhead as the mixer made it — one clip's contribution
// cannot be isolated from it, which is the point. There *is* no per-element meter
// in bro and the element's JS surface has no level on it at all; the bus is the
// only honest place this question has an answer.
//
// Three things it is not, all of them said on the screen rather than only here:
//
//   - **Stereo, always.** It is the device mix, so it has the device's channels
//     and not the output's. A 5.1 render metered this way would be two bars.
//   - **Sample peak, sampled.** `updateBusMeters` takes the absolute maximum of
//     the samples in a callback and overwrites the field, so a transient between
//     two reads is missed and an inter-sample peak is not seen at all. It is the
//     weaker of the two readings in both senses.
//   - **Through the monitoring volume**, which is divided back out here. Every
//     clip is played at `transport.volume * clip.volume` (`transport.js`), and the
//     first of those is how loud you are listening rather than part of the edit —
//     so a meter that did not undo it would lose an over the moment somebody
//     turned the speakers down, which is the opposite of what a meter is for. The
//     clip's own level stays in, because that *is* the edit. With the transport
//     muted there is nothing to divide and the strip says so.
//
// **What closing that properly would need** is stated in `not-yet.md`: bro would
// have to meter a playback instance, or route each element to a bus of its own so
// that `getBusPeak*` could be asked per clip and summed at the output's channel
// count — and neither of those is a line of this application's code.
//
// ── Where it sits ──────────────────────────────────────────────────────────
//
// Beside the picture and not under the timeline, because it is about the picture
// in front: the same reason `out-note` is over the stage. Vertical, because that
// is the shape a meter has been for eighty years and because the strip is tall and
// narrow; the Capture stage draws the same meter across, since it is a column of
// wide panels. One widget, two orientations — see `ui/meter.js`.

import { createMeter } from './meter.js';
import { div } from './dom.js';
import * as output from './output.js';
import { transport } from './transport.js';

let host = null;
let meter = null;

/// bro's audio engine, or null where this build has none. Asked for once: a
/// context that could not be made will not be makeable a frame later, and trying
/// every frame would be an exception a second for the life of the process.
let audio = null;
let askedAudio = false;

/// Why there is nothing to meter, or '' when there is something. Drawn under the
/// bars, because a strip of empty bars is indistinguishable from silence and the
/// two are different answers.
let note = '';
let noteEl = null;

/// What the strip is reading, for the summary and for a test. `'output'` while the
/// preview is on and its render has sound, `'monitor'` while bro's mixer is the
/// answer, `''` while there is nothing to read.
let from = '';

const RENDER_WHY =
    'The render’s own mix, measured block by block at the output’s channel count. ' +
    'True peak, 4× oversampled — the loudest point on the signal, not the loudest ' +
    'sample — so an inter-sample over is caught.';

const BUS_WHY =
    'bro’s master mix bus: every clip summed as the mixer made it, at the device’s ' +
    'two channels rather than the output’s, and a sample peak sampled once a frame ' +
    'rather than a true peak of every block. The monitoring volume is divided back ' +
    'out, so this is the level of the edit and not of your speakers. Turn O on for ' +
    'the render’s own reading.';

export function initMonitor(refs) {
    host = refs && refs.levels;
    if (!host) return;
    meter = createMeter({
        name: 'output',
        title: RENDER_WHY,
        vertical: true,
    });
    host.append(meter.root);
    noteEl = div('m-why dim');
    host.append(noteEl);
}

/// What the strip is reading — `'output'`, `'monitor'` or `''`. For a test, and
/// for anything that wants to say out loud which of the two guarantees is on
/// screen.
export function reading() { return from; }

/// Why there is nothing to meter, or '' when there is.
export function why() { return note; }

/// How many bars are drawn. A test's way of checking that the meter followed the
/// output's channel count rather than a number this file decided.
export function channelCount() { return meter ? meter.channels() : 0; }

/// bro's mixer, or null. Lazily, and once.
function engine() {
    if (askedAudio) return audio;
    askedAudio = true;
    try { audio = new AudioContext(); } catch (e) { audio = null; }
    return audio;
}

/// The render's own reading, or null when there is no render to read.
function fromRender() {
    if (!output.isOn()) return null;
    const r = output.levels();
    if (!r || !r.running) return null;
    if (!(r.rate > 0)) return { silent: true };
    return r;
}

/// bro's master bus, as a reading in the same shape — or null where this build
/// has no mixer.
///
/// **L and R by name**, because that is what the two pairs of getters are: bro
/// meters a bus as a stereo pair and there is no layout to ask. Everywhere else in
/// this application a channel name comes from libav (`av_channel_name`); here the
/// source itself only has two, and calling them anything else would be inventing
/// a name for something that has one.
function fromBus() {
    const ctx = engine();
    if (!ctx) return null;
    const gain = transport.muted ? 0 : transport.volume;
    if (!(gain > 0)) return { muted: true };
    let l = 0, r = 0, lr = 0, rr = 0;
    try {
        l = ctx.getBusPeakL(0); r = ctx.getBusPeakR(0);
        lr = ctx.getBusRmsL(0); rr = ctx.getBusRmsR(0);
    } catch (e) { return null; }
    // `truePeak: 0` deliberately, which is how a source says it has none: the
    // meter then draws `peak` and the label above says sample peak. See
    // `ui/meter.js`.
    return {
        heard: true,
        channels: [
            { name: 'L', truePeak: 0, peak: l / gain, rms: lr / gain },
            { name: 'R', truePeak: 0, peak: r / gain, rms: rr / gain },
        ],
    };
}

/// Read once and draw. Called once a frame from the frame loop, and it is the one
/// caller of either level — both of them clear as they read.
export function tick() {
    if (!meter) return;
    const render = fromRender();
    /// What to write this tick, or null for "nothing arrived". Named for the tick
    /// rather than `reading`, which is the *question* this module answers and is a
    /// function of its own.
    let now = null;
    if (render && !render.silent) {
        from = 'output';
        note = '';
        meter.describe('output', RENDER_WHY);
        now = render;
    } else if (render && render.silent) {
        from = '';
        note = 'this render has no sound';
        meter.describe('output', RENDER_WHY);
    } else {
        const bus = fromBus();
        if (!bus) {
            from = '';
            note = 'no audio engine in this build';
        } else if (bus.muted) {
            from = '';
            note = 'muted — nothing to measure';
        } else {
            from = 'monitor';
            note = 'bro’s mixer · sample peak · L/R';
            now = bus;
        }
        meter.describe('monitor', BUS_WHY);
    }
    // **Written even with nothing to read**, which is what makes the bars fall
    // rather than stick: a reading with no channels in it is "nothing arrived",
    // and that is not silence. See `ui/meter.js`.
    meter.write(now);
    if (noteEl.textContent !== note) noteEl.textContent = note;
}
