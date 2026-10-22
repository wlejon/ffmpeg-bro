// Canvas lane drawing (video, audio mix, When spans, ruler, scrollbar) and
// the When lane's state and interaction for `ui/timeline.js`.

import { project, isSelected, hasPicture, isGenerator, isTrackLocked,
         sourceTime, speedOf } from './project.js';
import { frameAt, soundNote, showing } from './analysis.js';
import { rulerLabel, clock } from './format.js';
import { dbHeight, ZERO_DBFS } from './levels.js';
import { el, put } from './dom.js';
import { spanRows, placeSpans, editEdge, editBody, commitSpans } from './graph/spans.js';

// How close to a clip's edge a press has to be to mean "trim" rather than
// "move", in pixels. Six is about a fingernail and comfortably clear of the
// 2px selection border.
const TRIM_GRAB = 6;

// The When lane: how tall one row wants to be, how much the rows share, and the
// height below which they stop shrinking. A row is a region and a name, so the
// ideal is one line of the 10px face with room around it; the budget is a little
// over four of those, because past that the lane starts competing with the
// filmstrips for a window that has a viewer in it. Below the floor a row is a
// coloured bar with no room for its name, which is still worth having — it says
// where and it says how many — so the lane grows rather than hiding rows.
const SPAN_ROW = 14;
const SPAN_BUDGET = 62;
const SPAN_FLOOR = 8;

// The colours a row is told apart by. Six, because the label is what actually
// names a node and this is what makes two rows readable as two at a glance; a
// palette long enough to be unique per node would be a set of colours nobody
// could tell apart anyway. Chosen clear of the three colours a *clip* is drawn in
// — blue for a filmstrip, green for sound, violet for a generator — and clear of
// the accent, which everywhere on this timeline means "selected".
//
// Each is a pair: the line, and the wash under it. The wash is transparent
// because the row's name is drawn *under* the regions, so that a span sitting
// over the name does not take the name away.
const SPAN_TINTS = [
    ['#7cc4ff', 'rgba(124, 196, 255, 0.22)'],
    ['#ffcf5c', 'rgba(255, 207, 92, 0.20)'],
    ['#6fdcb0', 'rgba(111, 220, 176, 0.20)'],
    ['#ff8fa3', 'rgba(255, 143, 163, 0.20)'],
    ['#c98bff', 'rgba(201, 139, 255, 0.22)'],
    ['#a8d95c', 'rgba(168, 217, 92, 0.20)'],
];

let ctxRef = null;
export function bindTimelineDrawContext(c) { ctxRef = c; }

// ── drawing ────────────────────────────────────────────────────────────────

// Size a canvas to its box and hand back a cleared context.
function laneContext(canvas) {
    // The box, not the canvas — see laneWidth().
    const box = canvas.parentNode;
    const w = (box ? box.clientWidth : 0) | 0;
    const h = (box ? box.clientHeight : 0) | 0;
    if (w <= 0 || h <= 0) return null;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

export function drawVideoLane(track, canvas) {
    const c = laneContext(canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const { timeToX, xToTime } = ctxRef;

    // A locked track, across the whole lane and under everything. The wash is
    // faint on purpose — it is a standing fact about the track, not a reading —
    // but it is on the lane rather than only on the head because the lane is
    // what somebody watching a drag is looking at, and two washed lanes are two
    // lanes that will move together.
    if (isTrackLocked(track)) {
        ctx.fillStyle = 'rgba(255, 140, 66, 0.07)';
        ctx.fillRect(0, 0, w, h);
    }

    for (const clip of project.clips) {
        if (clip.track !== track) continue;
        const x0 = timeToX(clip.start);
        const x1 = timeToX(clip.start + clip.length);
        const l = Math.max(0, x0), r = Math.min(w, x1);
        if (r <= l) continue;
        const selected = isSelected(clip);
        // A clip with no picture in it is drawn in the waveform lane's colours
        // and says what it is. Left in the video lane's blue with an empty
        // filmstrip it reads as a clip whose thumbnails have not arrived — a
        // state that resolves itself a second later, and this one never will.
        // It stays on its lane rather than being hidden, because the lane is
        // the track it is on and where it sits in the stack is an edit.
        const sound = !hasPicture(clip);
        // A generator is a picture and no file, so it gets a colour of its own
        // rather than the blue a filmstrip is drawn on. It never has one: a strip
        // is grabbed by seeking and a `-f lavfi` source cannot seek (see
        // `analysis.js`), so left in the video lane's blue it would read as a clip
        // whose thumbnails are still coming — the same misreading the sound-only
        // colour exists to prevent, and this one would never resolve either. The
        // bar carries the command that makes it instead, which is what its `name`
        // is.
        const gen = isGenerator(clip);

        ctx.fillStyle = sound ? (selected ? '#24422f' : '#1d3227')
                    : gen ? (selected ? '#43335e' : '#352b4a')
                          : (selected ? '#2a4666' : '#223449');
        ctx.fillRect(l, 0, r - l, h);

        if (sound && r - l > 60 && h > 14) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#8a92a0';
            ctx.fillText('sound only', l + 6, h / 2 + 3);
        }

        if (clip.film && clip.film.strips.length) {
            const { width: tw, height: th } = clip.film;
            // One thumbnail per its own natural width, laid out from the
            // clip's left edge so the pictures hold still while you pan, and
            // each showing the frame that is actually on screen there.
            const slot = Math.max(8, h * (tw / th));
            const first = Math.floor((l - x0) / slot);
            for (let k = first; ; k++) {
                const sx = x0 + k * slot;
                if (sx >= r) break;
                const dl = Math.max(sx, l), dr = Math.min(sx + slot, r);
                if (dr <= dl) continue;
                // Through `sourceTime`, which carries the clip's speed: the
                // filmstrip's times are the file's and a sped-up clip walks
                // through them faster, so a lane that subtracted a start would
                // show the same shot stretched across the bar.
                //
                // `frameAt` rather than an index, because a clip read over a
                // link holds several strips of several spans and the finest one
                // covering this moment is the one to draw — and where none has
                // been read yet the slot is left empty rather than filled with
                // the nearest picture that was, which would be a frame of
                // somewhere else presented as a frame of here.
                const f = frameAt(clip.film, sourceTime(clip, xToTime(sx)));
                if (!f) continue;
                // Partial slots at either edge crop the source rather than
                // squeezing a whole thumbnail into fewer pixels.
                const u0 = (dl - sx) / slot, u1 = (dr - sx) / slot;
                ctx.drawImage(f.bitmap,
                              f.i * tw + u0 * tw, 0, Math.max(1, (u1 - u0) * tw), th,
                              dl, 0, dr - dl, h);
            }
        }

        // A clip that is not fully opaque says so, since on a lower track that
        // is the difference between "hidden" and "gone". A clip that is not at
        // its own speed says so for the stronger version of the same reason:
        // nothing else on the bar can tell you, because a shot at 2× looks
        // exactly like half as much of the same shot until it plays.
        const speed = speedOf(clip);
        const marks = [
            clip.xform.opacity < 0.999 ? { text: Math.round(clip.xform.opacity * 100) + '%',
                                           colour: '#ffb37a' } : null,
            Math.abs(speed - 1) > 1e-6 ? { text: `${+speed.toFixed(3)}×`,
                                           colour: '#7ad4ff' } : null,
        ].filter(Boolean);
        if (marks.length) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(l, 0, r - l, 13);
            ctx.font = '10px Consolas, monospace';
            let at = l + 5;
            for (const m of marks) {
                ctx.fillStyle = m.colour;
                ctx.fillText(m.text, at, 10);
                at += ctx.measureText(m.text).width + 6;
            }
        }

        ctx.strokeStyle = selected ? '#ff8c42'
                        : sound ? '#35604a' : gen ? '#5c4a80' : '#3d6183';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(l + 0.5, 0.5, Math.max(1, r - l - 1), h - 1);

        // Trim grips, on the selection only — four bright bars on every clip
        // would read as clutter, and you can only trim what you have picked.
        if (selected && r - l > 14) {
            ctx.fillStyle = '#ff8c42';
            if (x0 >= 0) ctx.fillRect(l, h * 0.25, 3, h * 0.5);
            if (x1 <= w) ctx.fillRect(r - 3, h * 0.25, 3, h * 0.5);
        }

        // The name, pinned to the visible left edge so it survives scrolling
        // half the clip off screen.
        if (r - l > 46) {
            ctx.font = '10px Consolas, monospace';
            const text = clip.name;
            const tx = l + 5;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(l + 1, h - 15, Math.min(r - l - 2, ctx.measureText(text).width + 8), 14);
            ctx.fillStyle = '#dbe6f2';
            ctx.fillText(text, tx, h - 4);
        }
    }
}

/// Which columns of the lane a clip covers, and what its sound does there.
///
/// One helper because three passes ask the same two questions, and a second
/// copy of the bucket arithmetic would be a second answer to which sample of
/// the file is under a pixel.
///
/// `at(x)` is the whole reading of one column — the loudest rms and the widest
/// envelope of every bucket under it — and it is **null where nothing has been
/// read**. A clip on a link is read a window at a time (`ui/analysis.js`), so
/// most of a long one is not silence but ground nobody has covered yet, and a
/// lane that drew those columns as a flat line would be claiming the recording
/// went quiet there.
function columnsOf(clip, w) {
    const { timeToX, xToTime } = ctxRef;
    const p = clip.peaks;
    const l = Math.max(0, Math.floor(timeToX(clip.start)));
    const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
    if (r <= l || !p || !p.buckets || !p.duration) return null;
    const n = p.buckets;
    const bucketAt = (x) => {
        // The same map the filmstrip reads, and for the same reason: the buckets
        // are the file's seconds and the clip's speed is the slope between them
        // and the lane.
        const t = sourceTime(clip, xToTime(x));
        const b = Math.floor((t / p.duration) * n);
        return b < 0 ? 0 : b >= n ? n - 1 : b;
    };
    const at = (x) => {
        const b0 = bucketAt(x), b1 = Math.max(b0 + 1, bucketAt(x + 1));
        let rms = 0, min = 0, max = 0, any = false;
        for (let b = b0; b < b1 && b < n; b++) {
            // A whole-file read has no `have` and every bucket in it was read,
            // which is the shape this has always been handed and the one a test
            // builds by hand.
            if (p.have && !p.have[b]) continue;
            any = true;
            if (p.rms[b] > rms) rms = p.rms[b];
            if (p.min[b] < min) min = p.min[b];
            if (p.max[b] > max) max = p.max[b];
        }
        return any ? { rms, min, max } : null;
    };
    return { l, r, at };
}

/// The mix, one column of the lane at a time.
///
/// Separated from the drawing because it is the *claim*: two clips that overlap
/// in time are one sound at that moment, and what a reader is judging off A1 is
/// what the render will make of it. A canvas can be checked by eye and not by a
/// test; this can be checked by both.
///
/// `rms` is already rooted, `lo`/`hi` are the summed envelope, and `quiet` is
/// what is deliberately outside the sum — see `drawAudioLane` for why each is
/// combined the way it is.
///
/// `clipped` marks the columns where the envelope has gone past full scale.
/// It is derived from `lo`/`hi` and could be recomputed by the caller; it is
/// returned because it is the answer somebody is looking at A1 *for*, and a
/// number a test can count is worth more than a colour it cannot.
export function mixColumns(w) {
    const power = new Float32Array(w);      // sum of (rms*gain)^2 while accumulating
    const lo = new Float32Array(w), hi = new Float32Array(w);
    const quiet = [];
    let mixed = false;

    for (const clip of project.clips) {
        const col = columnsOf(clip, w);
        if (!col) continue;
        if (clip.muted || clip.volume < 0.02) { quiet.push(col); continue; }
        const g = clip.volume;
        const { l, r, at } = col;
        for (let x = l; x < r; x++) {
            const s = at(x);
            if (!s) continue;
            mixed = true;
            power[x] += (s.rms * g) * (s.rms * g);
            lo[x] += s.min * g;
            hi[x] += s.max * g;
        }
    }
    const clipped = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
        power[x] = Math.sqrt(power[x]);
        // Either half on its own: a mix can go past full scale downwards
        // without ever doing it upwards, and an encoder clips both.
        if (hi[x] > 1 || lo[x] < -1) clipped[x] = 1;
    }
    return { rms: power, lo, hi, quiet, mixed, clipped };
}

/// A1: where the clips are, and **one waveform for the whole timeline**.
///
/// **It draws the mix, not the clips one after another.** Every clip used to be
/// painted in turn, so two that overlapped in time drew over each other and
/// what you saw was whichever happened to be last in the list — which is not
/// what the render makes of that moment, and that moment is exactly what
/// somebody is looking at A1 to judge. The renderer sums the clips; so does
/// this.
///
/// Summed the way a mix is summed, and the two halves are not the same sum:
///
///   - **The envelope adds.** Two sounds at once reach the sum of their peaks
///     when they peak together, and that is what clipping is — so the outline
///     is the honest bound of what the mix can hit.
///   - **The body is a root-sum-of-squares.** Adding RMS would draw a mix half
///     as loud again as it is: power adds, amplitude does not, and two
///     uncorrelated sounds at -6 dB make one at -3 rather than one at 0. That
///     is an estimate — perfectly correlated material really does add — and it
///     is the estimate every meter makes.
///
/// **Drawn in dB, with a line where clipping is** — see `dbHeight`. The sum is
/// the reason the line is worth drawing: two clips that each peak just under
/// full scale make a mix that does not, and until the lane had a scale that
/// went above 1.0 that mix was drawn as exactly full height and looked fine.
///
/// **A muted clip is drawn on its own, dimmed, and is not in the sum.** It is
/// still there and simply not being heard, so hiding it would make it hard to
/// find again; folding it in would draw sound the render will not write. Which
/// of the two a shape is is said by its colour.
export function drawAudioLane() {
    const wave = ctxRef.wave();
    const c = laneContext(wave);
    if (!c) return;
    const { ctx, w, h } = c;
    const { timeToX } = ctxRef;
    const mid = h / 2;

    // Where the clips are, first, so the mix is drawn over their boxes rather
    // than under the next one's.
    for (const clip of project.clips) {
        // **A generator is not on this lane at all.** It has no sound to be part
        // of the mix — the derivation gives it no `atrim` and the render maps
        // nothing from it — so a box here would be a claim that something is
        // waiting to be read, and nothing is. Same argument as the video lane's
        // colour, the other way round.
        if (isGenerator(clip)) continue;
        const l = Math.max(0, Math.floor(timeToX(clip.start)));
        const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
        if (r <= l) continue;
        const p = clip.peaks;
        ctx.fillStyle = p ? (isSelected(clip) ? '#24422f' : '#1d3227') : '#20242c';
        ctx.fillRect(l, 0, r - l, h);
        // What this lane is showing and what it is not — `analysis.soundNote`
        // says both, because "reading…", "no audio track" and "read from the
        // audio-only rendition, which is a second or two from the picture" are
        // one question asked of one clip. Drawn under the shape rather than
        // only where there is no shape: the last of the three is a caveat
        // about a waveform that is right there.
        const note = soundNote(clip);
        if (note && r - l > 60) {
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = '#8a92a0';
            ctx.fillText(note, l + 6, p ? h - 4 : mid + 3);
        }
    }

    const { rms, lo, hi, quiet, mixed, clipped } = mixColumns(w);

    if (mixed) {
        // The RMS body first, then the peak envelope over it: the body is what
        // the sound feels like, the envelope is what it actually reaches.
        ctx.fillStyle = 'rgba(126, 214, 160, 0.35)';
        for (let x = 0; x < w; x++) {
            const y = dbHeight(rms[x]) * mid;
            if (!y) continue;
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        for (let x = 0; x < w; x++) {
            const top = mid - dbHeight(hi[x]) * mid;
            const bot = mid + dbHeight(lo[x]) * mid;
            if (bot - top < 0.5) continue;
            // A column that has gone over is drawn in its own colour rather
            // than left to be inferred from where it ended up: the line says
            // where full scale is, and this says which columns crossed it.
            ctx.fillStyle = clipped[x] ? 'rgba(255, 122, 92, 0.95)'
                                       : 'rgba(126, 214, 160, 0.9)';
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
    }

    // What is not in it, in its own colour and one clip at a time — there is no
    // mix for it to be part of, so there is nothing to sum.
    for (const col of quiet) {
        const { l, r, at } = col;
        ctx.fillStyle = 'rgba(126, 214, 160, 0.12)';
        for (let x = l; x < r; x++) {
            const s = at(x);
            if (!s) continue;
            const y = dbHeight(s.rms) * mid;
            ctx.fillRect(x, mid - y, 1, y * 2);
        }
        ctx.fillStyle = 'rgba(126, 214, 160, 0.3)';
        for (let x = l; x < r; x++) {
            const s = at(x);
            if (!s) continue;
            const top = mid - dbHeight(s.max) * mid;
            const bot = mid + dbHeight(s.min) * mid;
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
    }

    // Full scale, across the whole lane and over everything drawn so far. It
    // is the one number on this lane that does not depend on the edit, which
    // is what makes the shape either side of it mean anything — dashed and
    // dim, because it is a reference and not a reading.
    if (h > 18) {
        const y = ZERO_DBFS * mid;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255, 140, 66, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid - y + 0.5); ctx.lineTo(w, mid - y + 0.5);
        ctx.moveTo(0, mid + y - 0.5); ctx.lineTo(w, mid + y - 0.5);
        ctx.stroke();
        ctx.restore();
        ctx.font = '9px Consolas, monospace';
        ctx.fillStyle = 'rgba(255, 140, 66, 0.65)';
        ctx.fillText('0 dB', 3, mid - y - 2);
    }

    // The outlines last, so a clip's extent stays readable over the waveform
    // rather than being buried under the next clip's body.
    for (const clip of project.clips) {
        const l = Math.max(0, Math.floor(timeToX(clip.start)));
        const r = Math.min(w, Math.ceil(timeToX(clip.start + clip.length)));
        if (r <= l || !clip.peaks) continue;
        const selected = isSelected(clip);
        ctx.strokeStyle = selected ? '#ff8c42' : '#35604a';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(l + 0.5, 0.5, Math.max(1, r - l - 1), h - 1);
    }
}

// ── the When lane ──────────────────────────────────────────────────────────
//
// One row per filter node whose `enable=` turns it on for part of the render, and
// the spans of that node drawn as regions on the timeline's own ruler. The list —
// what the spans are, which clock each is written in, and where that puts them in
// timeline seconds — is `ui/graph/spans.js`; nothing below works any of it out.

/// The lane's own DOM, or null when the edit has no spans in it.
let spanRow = null;
/// The rows as of the last `syncSpanLane()`. Held so that the draw, the hit test
/// and a drag in flight are all about the same list: re-asking per event would
/// mean a derivation per mouse move, and re-asking between the press and the
/// release would mean the row under the hand could be a different row by the time
/// it was let go of.
let spanList = [];
/// How far apart the rows are, **measured rather than chosen**: every box in this
/// application is `border-box`, so a lane styled 42px tall has 40px of canvas in
/// it, and rows laid out at the height they were asked for would run past the
/// bottom and leave the last one clipped. So `syncSpanLane()` decides what the
/// lane's *height* is and the draw divides what it actually got — which is also
/// what the hit test has to use, or a press would find a different row from the
/// one it was aimed at.
let spanRowH = 0;
/// Pixels the lane and the gap above it come to, for `fitHeights()`.
let spanStack = 0;

export function spanStackOf() { return spanStack; }

/// Which of the six colours each row is drawn in, in row order.
///
/// **Hashed from the key rather than taken from the row's position**, so a node
/// keeps its colour when another one appears above it — a lane that recoloured
/// itself every time a span was added somewhere else would make the colour worth
/// nothing, and the whole job of the colour is to be the thing you recognise a row
/// by between glances.
///
/// Adjacent rows that come out the same are nudged apart, which is why this is one
/// pass over the list rather than a function of one key: two touching rows in one
/// colour is the case the eye reads as a single row, and nudging the second one
/// can only be decided against what the first one *ended up* as.
function tintsFor(rows) {
    const out = [];
    for (let r = 0; r < rows.length; r++) {
        const key = String(rows[r].key || '');
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
        let i = h % SPAN_TINTS.length;
        if (r && i === out[r - 1]) i = (i + 1) % SPAN_TINTS.length;
        out.push(i);
    }
    return out;
}

/// Build or drop the lane so that it is there exactly when there are spans.
///
/// **`trackCount()`'s idiom**: the timeline shows lanes for what the edit has, so
/// an edit with nothing on this lane does not carry an empty one, and a span made
/// three stages away on the Graph stage puts the lane here without anybody
/// switching it on. It is a row inside `#tracks` rather than a sibling of the
/// audio row, which is what puts the playhead through it — `#playhead` spans that
/// box — and the playhead is half of what makes a region on this lane answer
/// anything.
export function syncSpanLane() {
    const tracksEl = ctxRef.tracksEl();
    const playhead = ctxRef.playhead();
    spanList = spanRows();
    const want = spanList.length;
    if (!want) {
        if (spanRow) { tracksEl.removeChild(spanRow.row); spanRow = null; }
        spanRowH = 0;
        spanStack = 0;
        return;
    }
    if (!spanRow) {
        const row = el('div', { cls: 'track-row when-row' });
        const head = el('div', { cls: 'track-head', title: 'When' },
            [el('span', { cls: 'track-name', text: 'When' })]);
        const lane = el('div', { cls: 'track-lane', id: 'lane-when' });
        const canvas = document.createElement('canvas');
        lane.appendChild(canvas);
        row.appendChild(head);
        row.appendChild(lane);
        // After every video lane — `syncLanes()` inserts those at the front — and
        // before the playhead, which has to stay last in the box.
        tracksEl.appendChild(row);
        tracksEl.appendChild(playhead);
        spanRow = { row, head, lane, canvas };
        wireSpanLane(spanRow);
        ctxRef.markRebuilt();
    }
    // A row wants `SPAN_ROW`; the rows share `SPAN_BUDGET` between them and stop
    // shrinking at `SPAN_FLOOR`, at which point the lane grows instead — the same
    // trade `syncLanes()` makes, and for the same reason: a row too short to be a
    // region is not worth the pixels it saves.
    const pitch = Math.max(SPAN_FLOOR, Math.min(SPAN_ROW, Math.floor(SPAN_BUDGET / want)));
    // Two for the lane's own border, so that what is left inside it — which is
    // what the canvas measures and what `spanRowH` is divided out of — is exactly
    // the rows.
    const h = want * pitch + 2;
    spanRow.lane.style.height = h + 'px';
    spanRow.row.style.height = h + 'px';
    spanRow.head.classList.toggle('tiny', pitch < 22);
    // The 4px is the gap `.track-row + .track-row` puts above it.
    spanStack = 4 + h;
}

/// The rows, and the spans on them.
///
/// **The name is drawn first and the regions over it**, in a wash rather than a
/// solid, so that a span sitting on top of the name does not take the name away.
/// That is what makes the row readable at any zoom and any pan: the alternative
/// was a label inside each region, which vanishes the moment a span is narrower
/// than its filter's name — and a region nobody can attribute is exactly what this
/// lane exists not to be.
export function drawSpanLane(over) {
    if (!spanRow) return;
    const c = laneContext(spanRow.canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const { timeToX } = ctxRef;
    // The pitch the hit test will use, taken from the height the lane actually
    // got. See `spanRowH`.
    const rh = spanRowH = h / Math.max(1, spanList.length);
    const tints = tintsFor(spanList);

    spanList.forEach((row, i) => {
        const top = i * rh;
        const [line, wash] = SPAN_TINTS[tints[i]];

        // Every other row banded, so a stack of them reads as rows rather than as
        // one lane with shapes at different heights.
        if (i % 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            ctx.fillRect(0, top, w, rh);
        }

        if (rh >= 11) {
            ctx.font = '10px Consolas, monospace';
            const base = top + rh - 3;
            ctx.fillStyle = line;
            ctx.fillText(row.filter, 4, base);
            ctx.fillStyle = '#7c838f';
            ctx.fillText(` · ${row.where}`, 4 + ctx.measureText(row.filter).width, base);
        }

        // The working copy while a drag is in flight, so the regions follow the
        // hand without a write — a write locks the node and redraws the stage,
        // which at sixty frames a second would rebuild the lane out from under it.
        // By key rather than by object, because a redraw can arrive in the
        // middle of a gesture — pressing the lane moves the playhead, which can
        // change the selection, which redraws the timeline — and the list it
        // rebuilds is a fresh set of row objects describing the same nodes.
        const drawn = (over && over.key === row.key && over.drawn) || row.drawn;
        for (const d of drawn) {
            const x0 = timeToX(d.a), x1 = timeToX(d.b);
            const l = Math.max(0, x0), r = Math.min(w, x1);
            if (r <= l) continue;
            ctx.fillStyle = wash;
            ctx.fillRect(l, top + 1, r - l, rh - 2);
            ctx.strokeStyle = line;
            ctx.lineWidth = 1;
            ctx.strokeRect(l + 0.5, top + 1.5, Math.max(1, r - l - 1), rh - 3);
            // The ends you can hold, and only the ends that exist. Drawn where
            // the edge is actually on screen, so a span running off the window
            // does not grow a grip at the edge of it.
            ctx.fillStyle = line;
            if (d.from && x0 >= 0) ctx.fillRect(l, top + 1, 2, rh - 2);
            if (d.to && x1 <= w) ctx.fillRect(r - 2, top + 1, 2, rh - 2);
        }
    });
}

/// The When lane as it is on screen — `{ lane, rows, rowHeight }`, or `null` when
/// the edit has no spans and so has no lane.
///
/// A reader and nothing else, and it exists because everything this lane claims is
/// drawn into a canvas: which node a region belongs to, where its ends are, and
/// how many rows there are cannot be read off the DOM. So the rows a test drags on
/// are the rows the draw used, which is also what makes an assertion about the
/// lane an assertion about the picture rather than about the model a second time —
/// `ui/graph/spans.js` is where the model is checked.
export function whenLane() {
    if (!spanRow) return null;
    return { lane: spanRow.lane, rows: spanList, rowHeight: spanRowH };
}

/// What a press at (x, y) on the When lane means: one end of a span, the whole of
/// one, or nothing.
///
/// **Beside `grabAt` and not inside it.** The two answer the same question and
/// they are deliberately two functions, because a press is on one lane or the
/// other and there is nothing to disambiguate: a clip and a span are never under
/// the same pixel. Folding them together would mean a single function taking a
/// track number *or* a row number and deciding which it had been given, which is
/// the shape that eventually mistakes one for the other. What is shared is the
/// rule — edges first, nearest edge wins, the body only if no edge was near — and
/// `TRIM_GRAB` is shared with it, so a grab zone is the same size wherever you
/// reach for one.
///
/// An end that does not exist is not offered: `gt(t,4)` has no far edge and a grip
/// on the end of the row would say it had one. That is the same restraint the
/// strip's own handles follow, and it comes from the model — `drawn[].to` — rather
/// than from anything measured here.
function spanGrabAt(x, y) {
    if (!spanRowH) return null;
    const row = spanList[Math.floor(y / spanRowH)];
    if (!row) return null;
    const { timeToX } = ctxRef;
    let best = null, bestD = TRIM_GRAB + 1;
    for (const d of row.drawn) {
        const l = timeToX(d.a), r = timeToX(d.b);
        const dl = Math.abs(x - l), dr = Math.abs(x - r);
        // The half-pixel tie-break `grabAt` uses, for the same reason: two spans
        // butted together share an x, so "the span under the pointer" has no
        // answer there and "the nearest end of any of them" always does. On an
        // exact tie the one that *starts* there wins, which is the one whose left
        // edge is drawn on top.
        if (d.from && dl <= TRIM_GRAB && dl - 0.5 < bestD)
            { bestD = dl - 0.5; best = { row, at: d.i, what: 'from' }; }
        if (d.to && dr <= TRIM_GRAB && dr < bestD)
            { bestD = dr; best = { row, at: d.i, what: 'to' }; }
    }
    if (best) return best;
    for (const d of row.drawn)
        if (x >= timeToX(d.a) && x <= timeToX(d.b))
            return { row, at: d.i, what: 'move' };
    return null;
}

/// A whole span's move, snapped like a clip's.
///
/// The same targets `snapStart` uses and for the same reason: the answer somebody
/// wants out of this lane is almost always "cover exactly that shot", and the ends
/// of the shots are on the timeline to be snapped to. `by` is a *distance* and
/// comes back as one, so the caller can hand it to the model unmapped — both
/// clocks run at a second per second, and only their origins differ.
///
/// Both ends are tried, because a span is snapped by whichever of its edges lands
/// on something: dragging a span so its tail meets a cut is as much the gesture as
/// dragging its head there.
function snapShift(a, b, by) {
    const view = ctxRef.view();
    const tolerance = (view.span / Math.max(1, ctxRef.laneWidth())) * 7;
    const targets = [0, ctxRef.playheadTime()];
    for (const c of project.clips) targets.push(c.start, c.start + c.length);
    let best = by, bestD = tolerance;
    for (const t of targets)
        for (const edge of [a + by, b + by]) {
            const d = Math.abs(edge - t);
            if (d < bestD) { bestD = d; best = by + (t - edge); }
        }
    return best;
}

/// The When lane: press to seek, drag an end to move it, drag the middle to move
/// the whole span.
///
/// **Committed on release and not on every move.** A write goes through
/// `overlay.edit`, which on a derived node records a lock and in every case
/// announces an edit — a step of undo, a redraw of the spine, the command bar, the
/// Graph stage and this lane. At sixty frames a second that would rebuild the lane
/// under the hand holding it and leave sixty steps of history behind one gesture.
/// So the regions follow the pointer from a working copy and one write ends the
/// drag. Same rule, and the same reason, as the strip in the column.
///
/// **And nothing is written when the pointer never moved**, which is the same trap
/// the strip fell into: `printEnable(parseEnable(text))` is not the text —
/// `between(t,1.00,2.00)` comes back `between(t,1,2)` — so a bare click on a
/// region would rewrite somebody's expression, and on a derived node it would
/// write a lock that outranks the edit for ever after.
function wireSpanLane(entry) {
    let drag = null;

    entry.lane.addEventListener('mousemove', (e) => {
        if (ctxRef.isDragging()) return;
        const box = entry.lane.getBoundingClientRect();
        const x = e.clientX - box.left;
        const grab = spanGrabAt(x, e.clientY - box.top);
        if (grab) {
            if (grab.what === 'from' || grab.what === 'to') {
                entry.lane.style.cursor = 'ew-resize';
            } else {
                entry.lane.style.cursor = 'move';
            }
        } else {
            entry.lane.style.cursor = 'default';
        }
    });

    ctxRef.tracked(entry.lane,
        (e) => {
            const box = entry.lane.getBoundingClientRect();
            const x = e.clientX - box.left;
            const grab = spanGrabAt(x, e.clientY - box.top);
            // Pressing anywhere on a lane moves the playhead there, including on
            // a span — the same rule the video lanes follow, and it is worth more
            // here than there: the moment you pressed at is the moment `⇤`/`⇥` in
            // the column would place an edge at.
            ctxRef.onSeek(ctxRef.xToTime(x), true);
            drag = grab ? {
                // The key as well as the row: the row object may be replaced by a
                // redraw arriving mid-gesture, and the key is what survives one.
                // The clock cannot change without the range changing, so it is
                // read off the row that was pressed on.
                key: grab.row.key, row: grab.row, i: grab.at, what: grab.what,
                // The span as it was when the press began, for `editBody` —
                // measured from the press rather than accumulated, so a drag that
                // ran past the end of the ruler comes back the way it went out.
                held: Object.assign({}, grab.row.spans[grab.at]),
                a: grab.row.drawn[grab.at].a, b: grab.row.drawn[grab.at].b,
                grabTime: ctxRef.xToTime(x), working: grab.row.spans, moved: false,
            } : null;
        },
        (e) => {
            const x = e.clientX - entry.lane.getBoundingClientRect().left;
            if (!drag) { ctxRef.onSeek(ctxRef.xToTime(x), false); return; }
            const t = ctxRef.xToTime(x);
            const by = t - drag.grabTime;
            const view = ctxRef.view();
            if (!drag.moved && Math.abs(by) * (ctxRef.laneWidth() / view.span) < 3) return;
            drag.moved = true;
            drag.working = drag.what === 'move'
                ? editBody(drag.row, drag.row.spans, drag.i, drag.held,
                           snapShift(drag.a, drag.b, by))
                : editEdge(drag.row, drag.row.spans, drag.i, drag.what, ctxRef.snapTime(t, null));
            // Placed by the model, not by this: where a span lands on the
            // timeline has one answer whether it is being dragged or drawn.
            drawSpanLane({ key: drag.key, drawn: placeSpans(drag.row.clk, drag.working) });
        },
        () => {
            if (drag && drag.moved) commitSpans(drag.row, drag.working);
            ctxRef.onSeek(undefined, false, true);
            drag = null;
        });
}

export function drawRuler() {
    const w = ctxRef.laneWidth();
    const ruler = ctxRef.ruler();
    if (w <= 0) return put(ruler, () => []);
    const view = ctxRef.view();

    // A label roughly every 90 px, landing on a round number of seconds.
    const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const want = (view.span * 90) / w;
    const step = steps.find((s) => s >= want) || steps[steps.length - 1];

    put(ruler, () => {
        const ticks = [];
        const first = Math.ceil(view.start / step) * step;
        for (let t = first; t <= view.start + view.span + 1e-9; t += step) {
            const x = ctxRef.timeToX(t);
            if (x < -2 || x > w) continue;
            ticks.push(el('div', { cls: 'tick', text: rulerLabel(t, view.span),
                                   style: { left: `${x.toFixed(1)}px` } }));
        }
        return ticks;
    });
}

export function drawScrollbar() {
    const scrollThumb = ctxRef.scrollThumb();
    if (!scrollThumb) return;
    const view = ctxRef.view();
    const tot = ctxRef.total();
    const f = Math.min(1, view.span / tot);
    scrollThumb.style.width = (f * 100).toFixed(3) + '%';
    scrollThumb.style.left = ((view.start / tot) * 100).toFixed(3) + '%';
    scrollThumb.style.display = f >= 0.999 ? 'none' : 'block';
    const zoomLabel = ctxRef.zoomLabel();
    if (zoomLabel) {
        const z = tot / view.span;
        zoomLabel.textContent = (z < 10 ? z.toFixed(1) : Math.round(z)) + '×' +
                                `  ${clock(view.start)}–${clock(view.start + view.span)}`;
    }
}

/// Tell the analysis which span of each clip's source is on screen.
///
/// A clip read over a link is read for what is being shown and no more (see
/// `ui/analysis.js`), and this is the one place that knows what that is. Once
/// per clip per draw rather than once per lane: both lanes show the same span
/// of the same clip, and a second caller would be a second answer to which
/// seconds are in view.
///
/// A width of zero is a hidden stage and not a clip nobody can see, which is
/// the standing rule about measuring anything in this frame loop.
export function watchView() {
    const w = ctxRef.laneWidth();
    if (w <= 0) return;
    const { timeToX, xToTime } = ctxRef;
    for (const clip of project.clips) {
        const l = Math.max(0, timeToX(clip.start));
        const r = Math.min(w, timeToX(clip.start + clip.length));
        if (r <= l) continue;
        showing(clip, sourceTime(clip, xToTime(l)), sourceTime(clip, xToTime(r)), r - l);
    }
}
