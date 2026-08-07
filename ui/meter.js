// A level meter, wherever one is drawn.
//
// **One home, because there are two places and they are answering the same
// question.** The Capture stage draws what a live session's devices and its
// composition are doing; the Compose stage draws what is leaving the output right
// now. A person looking at one and then the other is comparing them, and two
// implementations that disagreed by a decibel — or drew the clipping line in two
// places — would make that comparison a quiet lie. The *scale* was already one
// home (`levels.js`); this is the rest of it: the decay, the peak hold, the over
// latch, and what the number beside the bar means.
//
// Four decisions live here, and each of them is a claim the meters make.
//
// **A row per channel, not per pad.** The fault a meter catches that nothing else
// can is one channel of several — a stereo pair with a dead side, a 5.1 mix whose
// centre is ten decibels hot — and a mono summary of either reads perfectly
// healthy. So however many channels the reading has, that many bars, named as
// libav names them (`FL`, `FC`, `LFE`…) and asked of the sound rather than
// assumed. A single-channel pad gets no name label, because `FC` beside the only
// bar there is is a word that answers nothing.
//
// **Three readings, three questions, and they are measured differently on
// purpose.** The bar is what it is doing *now* (the RMS, decaying); the mark is
// what it *just* did (the peak, held); the number is the loudest it has been since
// the latches were cleared. Only the last is a measurement — the first two are
// drawings, sampled at whatever moment a frame happened — which is why the number
// is the high-water mark and not the decaying one. Put on the decaying hold it
// read -6.2 for a source that was exactly -6.02, because a decay sampled at an
// arbitrary moment is a number with a tick count in it.
//
// **The peak is the true peak where the source has one.** `sound_meter.h`
// measures both — the loudest sample, and the loudest point on the signal
// *between* the samples, 4× oversampled — and this draws the true peak, because
// that is the one that says whether a converter or an encoder will clip. Where a
// source can only offer a sample peak (bro's master bus does; see
// `ui/monitor.js`) the reading falls back to it and **the caller must say so on
// the screen**, which is why `truePeak` is a field on the reading rather than an
// assumption made here. A meter printing "true peak" over a sample-peak number is
// worse than one printing neither.
//
// **Nothing heard is not silence.** A device that has stopped delivering, or a
// render between blocks, would read as one delivering quiet if `heard: false`
// drove the bars to zero. So they fall from where they were instead, and what you
// see is a meter going still — which is what has happened.

import { dbHeight, dbLabel, ZERO_DBFS } from './levels.js';
import { div, span, el, put } from './dom.js';

/// How fast the bar falls, per tick, as a multiplier on amplitude — which is a
/// *fixed number of decibels* per tick, since the scale is logarithmic, and is
/// what makes the fall look even. About 20 dB a second at sixty ticks, which is
/// the rate a peak-programme meter falls at and slow enough to read a transient
/// off rather than watch it flicker.
export const FALL = 0.962;

/// And the peak mark, held five times as long. A peak that fell with the bar
/// would tell you nothing the bar did not; one that never fell would be a
/// high-water mark for the whole session, which is what the over light is for.
export const PEAK_FALL = 0.992;

/// One meter: build it once, write to it every frame.
///
/// `opts`:
///   - `name` — what the thing being metered is called. A pad's own name, which
///     for a capture session is what `-map` names (`in0:a`, `aout`) — a friendlier
///     word here would be a second name for the pad the command bar prints.
///   - `title` — the sentence explaining what is being measured and how, hung on
///     the name. Where the guarantee differs between sources (true peak versus
///     sample peak) this is where it is said.
///   - `vertical` — bars bottom-to-top rather than left-to-right. The Capture
///     stage is a column of wide panels and wants them across; a strip beside the
///     viewer is tall and narrow and wants them up.
///   - `trailing` — extra controls on the head row, which is how the Capture
///     stage puts `Listen` beside a pad without this file knowing what monitoring
///     is.
///   - `onClear` — called after the latches are forgotten, for a caller that has
///     something else to forget with them.
///
/// The returned handle owns its DOM: `root` goes wherever the caller wants it,
/// `write` is called once a frame, and nothing here reads the document — a decay
/// is a value with a history and `style.width` is a rounded string.
export function createMeter(opts = {}) {
    const vertical = !!opts.vertical;
    const head = div('m-head');
    const body = div('m-chs' + (vertical ? ' vert' : ''));
    const root = div('m-pad' + (vertical ? ' vert' : ''), [head, body]);
    /// Per channel, in the order the reading has them: the nodes, and the state
    /// between readings.
    let chans = [];
    let drawn = '';         ///< the channel names the rows were built for
    let label = String(opts.name || '');
    let title = String(opts.title || '');

    const drawHead = () => put(head, () => [
        el('span', { cls: 'm-name mono', text: label, title }),
        ...(opts.trailing ? opts.trailing() : []),
    ]);

    /// Build one bar's worth of DOM, and the state that goes with it.
    const buildChannel = (name, several) => {
        const bar = div('m-bar');
        const peak = div('m-peak');
        const read = span('', 'm-read mono');
        const over = el('div', {
            cls: 'm-over', text: 'over',
            'data-f': `over-${label}-${name}`,
            title: 'Over',
            // The press forgets this meter and then tells the caller, which is how
            // one click clears every pad on the Capture stage. `clear` itself is
            // silent, so a caller answering by clearing every meter it owns —
            // including this one — cannot come back round.
            on: { click: () => { clear(); if (opts.onClear) opts.onClear(); } },
        });
        const track = div('m-track' + (vertical ? ' vert' : ''), [
            bar, peak,
            // Full scale, at the fraction `levels.js` puts it — the one mark on the
            // meter that does not depend on what is being measured, and the one
            // that has to agree with A1's clipping line because they are the same
            // statement.
            el('div', {
                cls: 'm-zero' + (vertical ? ' vert' : ''),
                style: vertical ? { bottom: `${(ZERO_DBFS * 100).toFixed(2)}%` }
                                : { left: `${(ZERO_DBFS * 100).toFixed(2)}%` },
            }),
        ]);
        // A name only where there is something to tell apart — see the note at the
        // top. Kept as an element either way so the grid columns line up between a
        // mono pad and a stereo one.
        const cn = span(several ? name : '', 'm-cn mono');
        // One order for both, because it reads the same either way round: what
        // the channel is, the bar, the number, the light. Horizontal is a grid
        // row and vertical is a column of the same four things.
        const row = div('m-ch' + (vertical ? ' vert' : ''), [cn, track, read, over]);
        return { name, row, bar, peak, read, over,
                 level: 0, held: 0, top: 0, clipped: false };
    };

    /// Make the rows match the reading. Rebuilt only when the *channels* change —
    /// a pad reconfiguring, a preview at another channel count — because redrawing
    /// a meter's markup sixty times a second to move a bar would be rebuilding a
    /// panel to change a number in it.
    const sync = (names) => {
        const key = names.join('|');
        if (key === drawn) return;
        drawn = key;
        chans = names.map((n) => buildChannel(n, names.length > 1));
        put(body, () => chans.map((c) => c.row));
    };

    /// Forget both latches on every channel: the over light and the high-water
    /// number beside it.
    ///
    /// One gesture for the two because they answer the same question at different
    /// resolutions — "has this been too loud, and how loud" — and clearing one
    /// without the other would leave a reading nobody could place. A latch that
    /// could not be cleared is a light on for the rest of the session after one
    /// accident, which stops being a reading of anything.
    ///
    /// Silent: it tells nobody, which is what makes it safe to call from an
    /// `onClear` that is clearing several meters at once.
    function clear() {
        for (const c of chans) {
            c.clipped = false;
            c.top = 0;
            c.over.classList.remove('on');
            c.read.textContent = dbLabel(0);
        }
    }

    drawHead();

    return {
        root,

        /// What this meter is of, when that can change under it — the strip beside
        /// the viewer reads the render at one moment and bro's mixer at the next,
        /// and which it is has to be on the screen. A no-op when nothing changed,
        /// so it is safe to call every frame.
        describe(name, why) {
            if (name === label && why === title) return;
            label = String(name || '');
            title = String(why || '');
            drawHead();
        },

        /// One tick. `reading` is `{ heard, channels: [{ name, truePeak, peak,
        /// rms }] }` — the shape `bro.ffmpeg.live.levels` and
        /// `bro.ffmpeg.output.levels` both hand back. Null or empty channels means
        /// nothing arrived, and the bars fall rather than being driven to zero.
        write(reading) {
            const list = (reading && reading.channels) || [];
            if (list.length) sync(list.map((c, i) => c.name || String(i + 1)));
            const heard = !!(reading && reading.heard) && list.length === chans.length;
            for (let i = 0; i < chans.length; i++) {
                const c = chans[i];
                const r = heard ? list[i] : null;
                const now = r ? r.rms : 0;
                // The true peak where the source measured one — see the note at
                // the top. `truePeak` absent rather than zero is what a sample-peak
                // source looks like, and `peak` is then the honest reading.
                const hit = r ? (r.truePeak > 0 ? r.truePeak : r.peak) : 0;
                c.level = Math.max(now, c.level * FALL);
                c.held = Math.max(hit, c.held * PEAK_FALL);
                if (hit > c.top) c.top = hit;
                if (hit > 1) c.clipped = true;

                const at = (v) => `${(dbHeight(v) * 100).toFixed(2)}%`;
                if (vertical) {
                    c.bar.style.height = at(c.level);
                    c.peak.style.bottom = at(c.held);
                } else {
                    c.bar.style.width = at(c.level);
                    c.peak.style.left = at(c.held);
                }
                c.peak.classList.toggle('hidden', c.held <= 0);
                c.bar.classList.toggle('m-hot', c.held > 1);
                c.over.classList.toggle('on', c.clipped);
                c.read.textContent = dbLabel(c.top);
            }
        },

        clear,

        /// How many bars are drawn, for a test that wants to check the meter
        /// followed the output's channel count rather than a number this file
        /// decided.
        channels() { return chans.length; },

        /// Drop every row, so the next reading builds them again. What a meter of
        /// a session that has been given back needs: a bar left standing at -12
        /// while nothing is open is a reading of something that has gone.
        reset() {
            drawn = '';
            chans = [];
            put(body, () => []);
        },
    };
}
