// A named quantity, sampled over a render, drawn as the line it is.
//
// The Report drawer had a sparkline per series: min to max, no axes, no scale,
// no interaction. That is the right shape for "did this change, and where" in a
// column of eight, and it is the wrong shape for every question anybody
// actually has about a measurement — *what* was it, *when*, and how does it
// compare with the one below it. So the sparkline stays as the index and this
// is what a series opens into.
//
// There is no chart library here and there is not going to be one: this is
// bro's DOM in QuickJS with no npm, so a plot is a `<canvas>` drawn by hand,
// the way `ui/timeline.js` and `ui/graph/canvas.js` already draw. What that
// costs is that every convention has to be chosen rather than inherited, so
// they are written down:
//
// **One axis, never two.** Two quantities with different scales on one plot
// with two y-scales invents a correlation that is not in the data — the
// alignment of the two scales is arbitrary and the reader cannot see that it
// is. When the picked series do not share a scale this normalises them to 0–1
// and *says so on the axis*, which is the honest version of the same wish: the
// shapes can be compared, the values cannot, and the readout under the pointer
// gives the real numbers back.
//
// **Colour follows the series, not its position in the list.** Slots are taken
// in the palette's fixed order — the order *is* the colourblind-safety
// mechanism, since the set was validated pair by pair as a sequence — and then
// *remembered*, so unpicking one line does not repaint the others. A reader who
// has learnt that `lavfi.cropdetect.h` is the orange line must not have that
// taken away by a filter. Past six lines a plot stops being readable and the
// caller is expected to say so rather than inventing a seventh hue.
//
// **The marks are the only loud thing.** Hairline grid one step off the
// surface, solid rather than dashed — a dashed gridline reads as a threshold —
// 2px lines with round joins, an 8px end marker carrying a 2px ring in the
// surface colour so it stays legible where two lines cross.

/// The categorical palette, in a fixed order. Validated as a set against this
/// application's panel surface: every slot inside the dark lightness band, over
/// the chroma floor, ≥ 3:1 against the surface, and worst adjacent-pair
/// separation ΔE 8.4 under protanopia. The order is the safety mechanism rather
/// than a preference — re-ordering it is re-running that check.
export const SERIES_COLORS = [
    '#3987e5',  // blue
    '#d95926',  // orange
    '#199e70',  // aqua
    '#c98500',  // yellow
    '#d55181',  // magenta
    '#008300',  // green
];

/// How many lines one plot will carry. Past this, hue stops being an identity
/// channel: a seventh colour is either a repeat or a generated one nobody
/// validated. The caller says so in words instead.
export const MAX_SERIES = SERIES_COLORS.length;

const SURFACE = '#101216';
const GRID = '#252a33';
const AXIS_TEXT = '#8a92a0';
const CROSSHAIR = '#3d4450';

const PAD = { l: 52, r: 12, t: 10, b: 18 };

/// The next free slot, **in the fixed order above**.
///
/// The order is the safety mechanism, not a preference: the palette was
/// validated pair-by-pair *as an adjacent sequence*, so slots taken in order
/// are guaranteed separable and slots taken at random are not — a hash over the
/// series' name would put green beside aqua as readily as blue beside orange.
/// So the first line on a plot is always blue and the second always orange.
///
/// Stability comes from the caller *remembering* what it handed out rather than
/// from the choice being a function of the key: a colour is given when a series
/// goes on the plot and kept until it comes off, so taking one line off never
/// repaints the others. Recomputing on every draw is the single most common way
/// a chart misleads somebody who has learnt it.
export function nextColor(taken) {
    for (const c of SERIES_COLORS) if (!taken || !taken.has(c)) return c;
    return SERIES_COLORS[0];
}

/// Round a step to something a person reads without decoding: 1, 2, 5, 10, 20…
function niceStep(span, want) {
    if (!(span > 0)) return 1;
    const raw = span / Math.max(1, want);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/// Enough decimals to tell two ticks apart and no more. A y axis reading
/// "0.9999 1.0000 1.0001" is three labels saying one thing; one reading
/// "0 0 0" is worse.
function tickText(v, step) {
    const dp = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)) + 1);
    return v.toFixed(dp);
}

export function shortValue(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1000) return String(Math.round(v));
    if (a >= 1) return String(Math.round(v * 100) / 100);
    return String(Math.round(v * 10000) / 10000);
}

/// Where the picked series sit against each other.
///
/// `shared` is the honest answer to "can these go on one axis": every series is
/// measured against the widest one, and a line that would be flat because it is
/// two orders of magnitude smaller is not a line anybody can read. When they do
/// not share a scale the values are indexed to their own 0–1 and the axis says
/// so — which is the remedy for wanting a second y-axis, rather than the second
/// y-axis.
export function scaleOf(series) {
    let lo = Infinity, hi = -Infinity, widest = 0;
    for (const s of series) {
        if (!s.numeric) continue;
        if (s.min < lo) lo = s.min;
        if (s.max > hi) hi = s.max;
        widest = Math.max(widest, s.max - s.min);
    }
    if (!(hi >= lo)) return { lo: 0, hi: 1, shared: true };
    const span = hi - lo;
    let shared = true;
    if (series.length > 1 && span > 0) {
        for (const s of series) {
            if (!s.numeric) continue;
            const own = s.max - s.min;
            // **A series that never moved is not a reason to normalise.** It is
            // a flat rule wherever it is put, and put at its own value it says
            // something true — two constants at 180 and 320 on one axis are two
            // readable lines, and normalised they are both a rule across the
            // middle with the two laid over each other.
            if (own <= 0) continue;
            // One that *did* move, by under a fiftieth of the plot's height, is
            // the case this is for: drawn on the shared axis it is a flat rule
            // saying "steady" about something that may have doubled.
            if (own < span / 50) shared = false;
        }
    }
    return { lo, hi, shared };
}

/// Draw. Returns the geometry, so the caller can turn a pointer position back
/// into a time without a second copy of the arithmetic.
///
/// `spec` is `{ series, t0, t1, hoverT, marks }`. Every series is
/// `{ key, label, color, points: [{t, v}], min, max, numeric }` — the shape
/// `report.js` already keeps, unchanged, because a plot that needed its own
/// data model would be a second place for a series to be wrong.
export function drawPlot(canvas, spec) {
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    const geom = { w, h, x0: PAD.l, x1: w - PAD.r, y0: PAD.t, y1: h - PAD.b,
                   t0: spec.t0, t1: spec.t1, normalised: false };
    if (w <= 1 || h <= 1) return geom;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return geom;
    ctx.clearRect(0, 0, w, h);

    const series = (spec.series || []).filter((s) => s && s.points && s.points.length);
    const dt = (spec.t1 - spec.t0) || 1;
    const plotW = Math.max(1, geom.x1 - geom.x0);
    const plotH = Math.max(1, geom.y1 - geom.y0);
    const scale = scaleOf(series);
    geom.normalised = !scale.shared;

    let lo = scale.lo, hi = scale.hi;
    if (!scale.shared) { lo = 0; hi = 1; }
    if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }

    const X = (t) => geom.x0 + ((t - spec.t0) / dt) * plotW;
    const Y = (v) => geom.y1 - ((v - lo) / (hi - lo)) * plotH;
    geom.timeAt = (px) => spec.t0 + ((px - geom.x0) / plotW) * dt;
    geom.xOf = X;

    // The value a series contributes at the shared scale. Indexed to its own
    // range when the picked series do not share one; itself otherwise.
    const at = (s, v) => (scale.shared ? v
        : (s.max > s.min ? (v - s.min) / (s.max - s.min) : 0.5));

    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';

    // ── the grid, one step off the surface, solid ──────────────────────────
    const ystep = niceStep(hi - lo, 3);
    ctx.strokeStyle = GRID;
    ctx.fillStyle = AXIS_TEXT;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (let v = Math.ceil(lo / ystep) * ystep; v <= hi + 1e-9; v += ystep) {
        const y = Math.round(Y(v)) + 0.5;
        if (y < geom.y0 - 1 || y > geom.y1 + 1) continue;
        ctx.beginPath();
        ctx.moveTo(geom.x0, y);
        ctx.lineTo(geom.x1, y);
        ctx.stroke();
        const label = scale.shared ? tickText(v, ystep)
                                   : `${Math.round(v * 100)}%`;
        ctx.fillText(label, 4, y);
    }

    // ── the time ruler ─────────────────────────────────────────────────────
    const tstep = niceStep(dt, Math.max(2, Math.floor(plotW / 90)));
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(spec.t0 / tstep) * tstep; t <= spec.t1 + 1e-9; t += tstep) {
        const x = Math.round(X(t)) + 0.5;
        if (x < geom.x0 - 1 || x > geom.x1 + 1) continue;
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(x, geom.y0);
        ctx.lineTo(x, geom.y1);
        ctx.stroke();
        ctx.fillStyle = AXIS_TEXT;
        ctx.fillText(`${Math.round(t * 100) / 100}s`, x + 3, geom.y1 + 3);
    }
    ctx.textBaseline = 'middle';

    // ── what somebody asked to be shown on it ──────────────────────────────
    //
    // A mark is a moment a *measurement* found — a black span, a scene change,
    // a silence — drawn on the same ruler as the numbers so that the two halves
    // of what a filter said are one picture.
    for (const m of (spec.marks || [])) {
        const x = Math.round(X(m.t)) + 0.5;
        if (x < geom.x0 || x > geom.x1) continue;
        ctx.strokeStyle = m.color || CROSSHAIR;
        ctx.beginPath();
        ctx.moveTo(x, geom.y0);
        ctx.lineTo(x, geom.y1);
        ctx.stroke();
        if (m.to !== undefined && m.to > m.t) {
            const x2 = Math.min(geom.x1, X(m.to));
            ctx.fillStyle = m.fill || 'rgba(217, 89, 38, 0.16)';
            ctx.fillRect(x, geom.y0, Math.max(1, x2 - x), plotH);
        }
    }

    // ── the lines ──────────────────────────────────────────────────────────
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of series) {
        if (!s.numeric) continue;
        ctx.strokeStyle = s.color || SERIES_COLORS[0];
        ctx.beginPath();
        let started = false;
        let last = null;
        for (const p of s.points) {
            if (!Number.isFinite(p.v)) continue;
            const px = X(p.t), py = Y(at(s, p.v));
            if (started) ctx.lineTo(px, py);
            else { ctx.moveTo(px, py); started = true; }
            last = { x: px, y: py };
        }
        if (started) ctx.stroke();
        // The end marker, ringed in the surface colour so that two series
        // ending in the same place are still two series.
        if (last) {
            ctx.fillStyle = SURFACE;
            ctx.beginPath();
            ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = s.color || SERIES_COLORS[0];
            ctx.beginPath();
            ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // ── the crosshair ──────────────────────────────────────────────────────
    if (spec.hoverT !== null && spec.hoverT !== undefined) {
        const x = Math.round(X(spec.hoverT)) + 0.5;
        if (x >= geom.x0 && x <= geom.x1) {
            ctx.lineWidth = 1;
            ctx.strokeStyle = CROSSHAIR;
            ctx.beginPath();
            ctx.moveTo(x, geom.y0);
            ctx.lineTo(x, geom.y1);
            ctx.stroke();
            for (const s of series) {
                if (!s.numeric) continue;
                const p = sampleAt(s, spec.hoverT);
                if (!p || !Number.isFinite(p.v)) continue;
                const y = Y(at(s, p.v));
                ctx.fillStyle = SURFACE;
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = s.color || SERIES_COLORS[0];
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    return geom;
}

/// The sample nearest a time. Binary search, because a series is sorted by
/// construction — the report appends in the order the frames came off — and a
/// linear scan per series per mousemove over four thousand points is the kind
/// of thing that makes a frame loop mysteriously expensive.
export function sampleAt(s, t) {
    const pts = s.points;
    if (!pts || !pts.length) return null;
    let a = 0, b = pts.length - 1;
    while (a < b) {
        const m = (a + b) >> 1;
        if (pts[m].t < t) a = m + 1; else b = m;
    }
    const hi = pts[a];
    const lo = a > 0 ? pts[a - 1] : hi;
    return Math.abs(lo.t - t) <= Math.abs(hi.t - t) ? lo : hi;
}
