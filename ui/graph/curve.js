// What a filter option written as an expression *does*, drawn against the render
// it is part of.
//
// The pair of `when.js`, and built the same way for the same reasons. `enable`
// answers "is this filter on", and the answer to a question about a shape is a
// picture of it; an expression in an option answers "what is this value" and has
// exactly the same problem — a field saying `lerp(0,160,clip(t/2,0,1))` does not
// tell anybody where the crop is at four seconds.
//
// **It is a reading, not a copy.** The curve is `bro.ffmpeg.expr.evaluate` over
// the node's clock on every draw, and nothing is written until somebody drags or
// types. So there is no second state to drift: what is drawn is what libav makes
// of the text, and the text is what the render is handed. An expression this
// cannot draw is not rewritten — the section says which part of it it gave up on
// and the text stays as it was.
//
// **The points editor writes one shape and reads that shape back.** A generator
// that could not re-read its own output would be a one-way door: edit the text
// once and the control can never show it again. So `expr.js` prints `lerp`/`clip`
// and parses exactly that, anything else comes back as "not points", and the
// editor stands down while the curve carries on being drawn. That is the same
// division `when.js` already makes, and it is why the text field is under the
// controls rather than instead of them.
//
// **The clock is `clockOf`'s**, not one worked out here. A filter above the
// derivation's `setpts` is written in the source file's own seconds, and this
// stage has been wrong about that twice — once for an in-point and once for a
// clip's speed — with every reader agreeing with each other while all of them
// were wrong. There is one answer to that question and it is in `when.js`.

import { el, div, span, head, row } from '../dom.js';
import { transport } from '../transport.js';
import { clockOf, playheadOn } from './when.js';
import { optionsOf } from './filters.js';
import { read, sample, printPoints, parsePoints, firstPoints, valueAt,
         evalMode, unquote, quote, num, round } from './expr.js';
import { clock as timecode } from '../format.js';

/// Where a value lives on a node: a named option, or one of the positional
/// arguments the derivation wrote.
///
/// Both, because the most obvious thing to animate in this application is a
/// derived `crop`, whose four numbers are positional — see `positionalRows` in
/// panel.js and `posNames` in model.js for why they are written that way. A
/// section that only knew about named options would offer nothing on the one
/// node everybody reaches for first.
function slotsOf(node) {
    const table = optionsOf(node.filter);
    const out = [];
    const names = node.posNames || [];
    node.pos.forEach((v, i) => {
        const name = names[i] || `#${i + 1}`;
        const o = table.find((x) => x.name === name);
        // Only a string option can hold an expression: an `int` or a `double`
        // is parsed by `av_opt_set` as a number and a `lerp(…)` in one is a
        // render that fails at the filter, not a curve. libav's own type, so
        // nothing here decides which options those are.
        if (o && o.type !== 'string') return;
        out.push({ kind: 'pos', index: i, name, value: String(v), help: o ? o.help : '' });
    });
    for (const o of table) {
        if (o.type !== 'string' || o.name === 'eval') continue;
        if (node.params[o.name] === undefined) continue;
        out.push({ kind: 'param', name: o.name, value: String(node.params[o.name]),
                   help: o.help });
    }
    return out;
}

/// The `Value` section for one filter node. `commit(slot, value)` puts the value
/// back where it came from — a param or a positional argument — which is the
/// panel's business and not this file's.
export function curveRows(node, g, commit) {
    if (!node || node.kind !== 'filter') return [];
    const slots = slotsOf(node).map((s) => Object.assign(s, { read: read(node.filter, s.value) }));
    const live = slots.filter((s) => s.read.state !== 'plain');
    if (!live.length) return [];

    const clk = clockOf(g, node);
    const mode = evalMode(node.filter, node.params);
    // Whether anything here actually moves. **Everything below that is more than
    // one line is conditional on it**, because these rows appear on every derived
    // `scale` and `crop` in the graph — their numbers are string options and a
    // number is an expression that never moves — and a red warning about `eval`
    // over a node nobody has animated is a warning about nothing, printed
    // everywhere, which is how a warning stops being read.
    const moving = live.some((s) => s.read.state !== 'constant');
    const out = [head('Value over time')];

    out.push(div('gp-hint dim', !moving
        ? 'ffmpeg has no keyframes: what it has is a value written as an expression and ' +
          're-read for every picture. These are the options of this filter that can hold ' +
          'one.'
        : clk.base === 'source'
            ? 'This node reads the source before the edit’s clock is applied, so t in an ' +
              `expression here is the source’s own timecode — ${timecode(clk.start)} to ${
                  timecode(clk.start + clk.length)} is the window this render touches.`
            : 'Evaluated per frame, with t as seconds into the render. The curve is libav’s ' +
              'own evaluation of the text, sample by sample — the same av_expr_eval ' +
              'libavfilter calls on the option.'));

    // **The one thing the `eval` option is a signal for.** Not "this option is an
    // expression" — `crop`, `drawtext` and `zoompan` have no `eval` and are the
    // most expression-shaped filters there are — but whether an expression that
    // *is* there gets read again. Said above the curves rather than beside one,
    // because it is true of every option on the filter at once.
    if (moving && mode.has && !mode.per) {
        out.push(div('gp-problems', div('gp-problem',
            `${node.filter} has an eval option and it is ${mode.value || 'unset'}: its ` +
            'expressions are evaluated once when the graph is built, so nothing below ' +
            'changes over the render however it is written.')));
        // The fix, as a press. It is `eval` on the same node through the same
        // commit as everything else here — the option table below can set it
        // too, and a control that wrote it by a private route would be a second
        // place for the value to come from.
        if (mode.frame)
            out.push(div('gp-actions', el('button', {
                cls: 'tiny', text: `Set eval=${mode.frame}`, 'data-f': 'eval-frame',
                title: 'Set eval',
                on: { click: () => commit({ kind: 'param', name: 'eval' }, mode.frame) },
            })));
    } else if (moving && mode.has) {
        out.push(div('gp-hint dim',
            `eval=${mode.value} — libavfilter re-reads these on every frame.`));
    }

    for (const slot of live) out.push(...slotRows(node, slot, clk, mode, commit));
    return out;
}

/// One value: what libav makes of it, the curve where there is one, and the
/// points where they can be read back.
function slotRows(node, slot, clk, mode, commit) {
    const set = (value) => commit(slot, value);
    const rows = [];

    if (slot.read.state === 'constant') {
        // A number is where an animation starts, and this is the whole of the
        // offer to start one. Not a curve: a flat line across the ruler would
        // be a picture of nothing, drawn nine times on a `crop`.
        rows.push(div('curve-flat', [
            span(slot.name, 'curve-name mono'),
            span(slot.read.text, 'curve-value mono'),
            el('button', {
                cls: 'tiny', text: 'Vary over time', 'data-f': `vary:${slot.name}`,
                title: 'Vary over time',
                on: { click: () => set(printPoints(
                    firstPoints(clk, valueAt(slot.read.text, clk.start)))) },
            }),
        ]));
        return rows;
    }

    if (slot.read.state === 'unreadable') {
        rows.push(div('curve-flat', [
            span(slot.name, 'curve-name mono'),
            span(slot.read.text, 'curve-value mono'),
        ]));
        rows.push(div('gp-problems', div('gp-problem',
            `This is left exactly as you wrote it and goes to the render as it is — ${
                slot.read.reason}.`)));
        return rows;
    }

    // It varies, and every variable in it is one there is a number for.
    const points = parsePoints(slot.value);
    rows.push(el('div', { cls: 'curve-section', ...clockAttrs(clk) }, [
        div('curve-head', [
            span(slot.name, 'curve-name mono'),
            mode.has && !mode.per ? span('eval', 'gp-badge locked') : null,
        ]),
        strip(slot.read.text, clk),
        ...(points
            ? points.map((p, i) => pointRow(points, i, clk, set))
            : [div('gp-hint dim',
                   'The curve is drawn from libav’s own evaluation of this. It is not one ' +
                   'this can put handles on: only the shape it writes itself — a value ' +
                   'moving between moments — reads back as points, and everything else ' +
                   'stays yours.')]),
        div('gp-actions', [
            points ? el('button', {
                cls: 'tiny', text: 'Another point', 'data-f': `addpoint:${slot.name}`,
                on: { click: () => set(printPoints(nextPoint(points, clk))) },
            }) : null,
            points ? el('button', {
                cls: 'tiny', text: 'Hold it still', 'data-f': `flatten:${slot.name}`,
                title: 'Hold it still',
                on: { click: () => set(quote(num(points[0].v))) },
            }) : null,
        ]),
        div('curve-at dim', el('span', { 'data-f': 'curve-at', text: '' })),
    ]));

    const field = el('input', {
        cls: 'wide mono', 'data-f': `expr:${slot.name}`, type: 'text',
        value: slot.value === undefined ? '' : String(slot.value),
        // `change`, not `input` — an edit locks the node and redraws the graph.
        on: { change: () => set(quote(unquote(field.value))) },
    });
    rows.push(row(slot.name, field));
    rows.push(div('gp-help dim',
        'Quoted — a filtergraph separates filters with commas. t, and everything ffmpeg’s ' +
        'evaluator takes.'));
    return rows;
}

/// One point as two numbers, and the button that puts it where you are looking.
function pointRow(points, i, clk, set) {
    const at = (which, v) => {
        const next = points.map((p) => Object.assign({}, p));
        next[i][which] = v;
        set(printPoints(next));
    };
    const number = (which) => el('input', {
        cls: 'when-num mono', 'data-point': `${i}:${which}`, type: 'text',
        value: String(points[i][which]),
        on: { change: (e) => {
            const v = Number(String(e.target.value).trim());
            if (Number.isFinite(v)) at(which, v);
        } },
    });
    return div('when-edit', [
        span(String(i + 1), 'when-i'),
        span('at', 'dim'),
        number('t'),
        el('button', {
            cls: 'tiny when-here', text: '⇤', 'data-here': `${i}`,
            title: 'Move point to playhead',
            on: { click: () => {
                const t = playheadOn(clk, transport.t);
                if (t === null || t < clk.start || t > clk.start + clk.length) return;
                at('t', round(t));
            } },
        }),
        span('is', 'dim'),
        number('v'),
        points.length > 2 ? el('button', {
            cls: 'tiny', text: '×', title: 'Remove point', 'data-f': `droppoint${i}`,
            on: { click: () => set(printPoints(points.filter((_, k) => k !== i))) },
        }) : null,
    ]);
}

/// A point to add when somebody asks for one: after the last, or half way to the
/// end of the ruler when the last is already there. Its value is what the curve
/// is already doing at that moment, so adding one does not move the picture —
/// the point is added in order to *then* be dragged.
function nextPoint(points, clk) {
    const last = points[points.length - 1];
    const hi = clk.start + clk.length;
    const t = round(last.t < hi - 0.05 ? Math.min(hi, last.t + Math.max(0.1, clk.length / 4))
                                       : hi);
    if (t <= last.t) return points;
    return points.concat([{ t, v: last.v }]);
}

/// The clock, on the element, for `chaseCurves()` to read back — the same three
/// attributes `when.js` writes, and read the same way. A curve and a When strip
/// on one node are two drawings of the same seconds, and a mark on one that did
/// not agree with the mark on the other would be this stage contradicting itself.
function clockAttrs(clk) {
    return {
        'data-clock': clk.base,
        'data-clock-start': String(clk.start),
        'data-clock-at': String(clk.at),
        'data-clock-length': String(clk.length),
        'data-clock-path': clk.path || '',
    };
}

// ── the drawing ────────────────────────────────────────────────────────────

const CURVE = '#3987e5';
const GRID = '#252a33';
const AXIS = '#8a92a0';

/// The strip: a canvas, its range in words, and the playhead `chaseCurves()`
/// moves.
///
/// A `<canvas>` rather than a row of positioned boxes, for the reason `ui/plot.js`
/// is one: a hundred and twenty samples is a hundred and twenty elements, laid
/// out and styled, in a column that is rebuilt on every derivation.
function strip(text, clk) {
    const canvas = el('canvas', {
        cls: 'curve-canvas', 'data-curve': text,
        'data-curve-start': String(clk.start), 'data-curve-length': String(clk.length),
    });
    const box = div('curve-track', [
        canvas,
        el('div', { cls: 'when-head hidden', 'data-f': 'when-head' }),
    ]);
    // **Not drawn here.** The canvas is not in the document yet, so it measures
    // zero, and most of this window is `display:none` at any moment besides —
    // the stage views hide each other and are never unmounted. So the drawing is
    // `chaseCurves()`'s, on the first frame the box has a width; drawing against
    // a measurement of zero would put a one-pixel curve in a two-hundred-pixel
    // box and then never revisit it.
    return el('div', { cls: 'curve-strip' }, [
        box,
        div('when-ruler', [0, 0.5, 1].map((f) => el('span', {
            cls: 'when-tick', style: { left: `${f * 100}%` },
            text: timecode(clk.at + clk.length * f),
        }))),
    ]);
}

/// Sample and draw one canvas, if it has a width to be drawn at.
///
/// Answers whether it drew, so the chase below can leave alone the ones that are
/// still hidden rather than sampling them sixty times a second.
function drawCurve(canvas) {
    const w = Math.max(0, Math.round(canvas.clientWidth));
    const h = Math.max(0, Math.round(canvas.clientHeight));
    if (w <= 1 || h <= 1) return false;
    const text = canvas.getAttribute('data-curve') || '';
    const win = { start: Number(canvas.getAttribute('data-curve-start')) || 0,
                  length: Number(canvas.getAttribute('data-curve-length')) || 1 };
    const got = sample(text, win, Math.min(240, Math.max(24, w)));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.clearRect(0, 0, w, h);
    if (!got || !got.values.length) return true;

    const values = got.values;
    let lo = Infinity, hi = -Infinity;
    for (const v of values) {
        if (v === null || v === undefined) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    if (!(hi > lo)) {
        // A curve that never moves still has to be somewhere: centred, with a
        // band around it, rather than dividing by zero and landing on the top
        // edge. It happens on a `lerp` between two equal values, which is
        // exactly what `Vary over time` writes to start from.
        const mid = Number.isFinite(lo) ? lo : 0;
        lo = mid - 1; hi = mid + 1;
    }
    const pad = 3;
    const Y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(Y(lo + (hi - lo) / 2)) + 0.5);
    ctx.lineTo(w, Math.round(Y(lo + (hi - lo) / 2)) + 0.5);
    ctx.stroke();

    ctx.strokeStyle = CURVE;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let down = false;
    values.forEach((v, i) => {
        const x = (i / Math.max(1, values.length - 1)) * w;
        // A null is what a division by zero came to — libav answers NaN and the
        // binding hands it over as null rather than as a number. The line lifts
        // rather than joining across it, because a straight segment over a hole
        // is a claim about values there are none of.
        if (v === null || v === undefined) { down = false; return; }
        if (!down) { ctx.moveTo(x, Y(v)); down = true; } else ctx.lineTo(x, Y(v));
    });
    ctx.stroke();

    ctx.fillStyle = AXIS;
    ctx.font = '9px Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(shortNumber(hi), 2, 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(shortNumber(lo), 2, h - 1);
    return true;
}

function shortNumber(v) {
    if (!Number.isFinite(v)) return '';
    if (Math.abs(v) >= 1000) return String(Math.round(v));
    return String(Math.round(v * 100) / 100);
}

/// Draw the curves that have become visible, and move their playheads.
///
/// **Called from the frame loop, beside `chaseWhen()`.** Two jobs, and they run
/// at different rates on purpose: the mark moves every frame because the
/// playhead does, and the curve is re-sampled only when the canvas has a width
/// it was not drawn at — which happens once, when the stage stops being
/// `display:none`, and again when the column is resized. Re-sampling per frame
/// would be a hundred and twenty `av_expr_eval`s per curve per frame for a
/// picture that cannot have changed.
export function chaseCurves() {
    const canvases = document.querySelectorAll('[data-curve]');
    for (const canvas of canvases) {
        const w = Math.round(canvas.clientWidth);
        if (w > 1 && w !== canvas.width) drawCurve(canvas);
    }

    const sections = document.querySelectorAll('.curve-section');
    if (!sections.length) return;
    const t = transport.t;
    for (const section of sections) {
        const headEl = section.querySelector('[data-f="when-head"]');
        if (!headEl) continue;
        const clk = {
            base: section.getAttribute('data-clock'),
            start: Number(section.getAttribute('data-clock-start')) || 0,
            at: Number(section.getAttribute('data-clock-at')) || 0,
            length: Number(section.getAttribute('data-clock-length')) || 0,
        };
        const on = playheadOn(clk, t);
        const reachable = on !== null && on >= clk.start && on <= clk.start + clk.length;
        headEl.classList.toggle('hidden', !reachable);
        if (reachable) headEl.style.left = `${((on - clk.start) / clk.length) * 100}%`;

        const note = section.querySelector('[data-f="curve-at"]');
        if (!note) continue;
        const canvas = section.querySelector('[data-curve]');
        const v = reachable && canvas ? valueAt(canvas.getAttribute('data-curve') || '', on)
                                      : null;
        note.textContent = !reachable
            ? (clk.base === 'source'
                ? 'the playhead is not over a clip of this source'
                : 'the playhead is outside the render’s range')
            : v === null
                ? `t=${on.toFixed(2)} — no value here`
                : `at ${timecode(clk.at + (on - clk.start))} this is ${shortNumber(v)}`;
    }
}

/// One line for a card: that this value moves, and between what.
///
/// The pair of `whenBar`, and offered on the same terms — only where there is
/// something to say. A node whose options are all numbers gets nothing, which is
/// almost every node on the stage.
export function curveBar(node, g) {
    if (!node || node.kind !== 'filter') return null;
    const moving = slotsOf(node)
        .map((s) => ({ slot: s, read: read(node.filter, s.value) }))
        .filter((s) => s.read.state === 'varies');
    if (!moving.length) return null;
    const clk = clockOf(g, node);
    const said = moving.map(({ slot, read: r }) => {
        const got = sample(r.text, clk, 24);
        if (!got) return slot.name;
        const vals = got.values.filter((v) => v !== null && v !== undefined);
        if (!vals.length) return slot.name;
        const lo = Math.min(...vals), hi = Math.max(...vals);
        return lo === hi ? `${slot.name} ${shortNumber(lo)}`
                         : `${slot.name} ${shortNumber(lo)}→${shortNumber(hi)}`;
    });
    return el('div', { cls: 'gn-curve' }, [span(said.join(' · '), 'gn-when-text')]);
}
