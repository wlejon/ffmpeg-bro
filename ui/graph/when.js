// When a filter is on, drawn against the render it is part of.
//
// A number in a field does not answer "is this the right span". The question is
// always about the shape of the thing — does the blur cover the whole of the
// shot, does the logo come off before the cut — and the answer to a question
// about a shape is a picture of it. So `enable` gets a strip: the render's range
// as a ruler, the spans the expression describes drawn on it, and ends that can
// be dragged.
//
// **It is a reading, not a copy.** The strip is built by parsing the stored
// expression on every draw, and nothing is written until somebody drags or
// types — so the control and the text are one mechanism in exactly the way the
// Quality slider and the advanced editor are, and there is no second state for
// them to disagree from. An expression the strip cannot draw is not rewritten:
// the strip stands down, says which part of it it gave up on, and the text
// stays as it was.
//
// **It is in the column, with a line on the card.** A span is a shape with a
// ruler under it and four numbers beside it, which is a column; what belongs on
// a card is what the node is *set to*, and for a time-varying filter that is
// one line — when it is on — which is what `whenBar` draws. That is the same
// division everything else on this stage already follows.
//
// **The clock is stated, because it is not always the same clock.** Every
// derived chain starts `setpts=PTS-STARTPTS+offset/TB`, so `t` downstream of
// that is time into the render. A filter spliced in *before* it — at a clip's
// `after decode` point — sees the source file's own timestamps, and a strip
// labelled 0…range there would be a lie about which seconds are being named. So
// the ruler is worked out from the graph rather than assumed.
//
// **And the playhead can place an edge, on either clock.** `⇤`/`⇥` on a span
// and `On from here` set a moment from where the playhead is standing, mapped
// the same way the mark on the strip is mapped — one function, `playheadOn`,
// because a button that placed an edge somewhere other than where the mark is
// drawn would be this stage contradicting itself in the most literal way it
// could. Where there is no mapping there is no offer: the buttons go dim and
// the line under them says why.

import { el, div, span, put, head, row, select } from '../dom.js';
import { project, sourceTime } from '../project.js';
import { transport } from '../transport.js';
import { range as exportRange } from '../export/spec.js';
import { supportsTimeline, parseEnable, printEnable, drawnSpan,
         moveEdge, nextSpan, enableText } from './enable.js';
import { clock as timecode } from '../format.js';

/// Which clock a node's `t` is on, and what a ruler over it should say.
///
/// Walked rather than assumed: what resets a picture's timestamps is a
/// `setpts`, and whether there is one between a node and the file it came from
/// is a fact about this graph. A node fed by nothing but a generator is on the
/// render's clock too — `color`, `testsrc` and the rest start at zero, which is
/// where the render starts.
export function clockOf(g, node) {
    const r = exportRange();
    const renderClock = { base: 'render', start: 0, length: Math.max(0.001, r.length),
                          at: r.start };
    if (!g || !node) return renderClock;

    const seen = new Set([node.id]);
    const queue = [node];
    let input = null;
    while (queue.length) {
        const n = queue.shift();
        if (n !== node && n.kind === 'filter' &&
            (n.filter === 'setpts' || n.filter === 'asetpts')) return renderClock;
        if (n.kind === 'input') { input = input || n; continue; }
        for (const p of g.producers(n))
            if (!seen.has(p.id)) { seen.add(p.id); queue.push(p); }
    }
    if (!input) return renderClock;

    // A pad read straight off a file. The window is the `trim` the derivation
    // put downstream of it, which is where the seconds of the source this
    // render actually touches are written down; without one — a hand-wired
    // input — the file's own zero is the only honest answer.
    const cut = trimBelow(g, input);
    const start = cut ? cut.start : (input.from || 0);
    const length = cut ? Math.max(0.001, cut.end - cut.start) : renderClock.length;
    return { base: 'source', start, length, at: start, path: input.path || '' };
}

/// The nearest `trim`/`atrim` downstream of a node, as numbers.
function trimBelow(g, from) {
    const seen = new Set([from.id]);
    const queue = [from];
    while (queue.length) {
        const n = queue.shift();
        if (n.kind === 'filter' && (n.filter === 'trim' || n.filter === 'atrim')) {
            const a = Number(n.params.start), b = Number(n.params.end);
            if (Number.isFinite(a) && Number.isFinite(b) && b > a) return { start: a, end: b };
        }
        for (const c of g.consumers(n))
            if (!seen.has(c.id)) { seen.add(c.id); queue.push(c); }
    }
    return null;
}

// ── the column ─────────────────────────────────────────────────────────────

/// The `When` section for one filter node. `commit(value)` is handed the whole
/// `enable` value — quotes and all — and is expected to put it in the same place
/// every other option goes.
export function whenRows(node, g, commit) {
    if (!node || node.kind !== 'filter') return [];
    const value = node.params.enable === undefined ? '' : String(node.params.enable);

    // **Not offered where it would be ignored.** A filter without
    // AVFILTER_FLAG_SUPPORT_TIMELINE is refused by libavfilter the moment it is
    // initialised — `Timeline ('enable' option) not supported with filter …` —
    // so a strip here would be a control that cannot work, drawn beside a
    // render that will not start.
    if (!supportsTimeline(node.filter))
        return [
            head('When'),
            div('gp-hint dim',
                `libavfilter reports no timeline support for ${node.filter}, so it cannot ` +
                'be turned on and off part way through a render — enable= on it is refused ' +
                'when the graph is built, not ignored. A filter that can take one has a ' +
                'When strip here.'),
            value ? div('gp-problems', div('gp-problem',
                `enable= is set on this node and ${node.filter} cannot honour it — ` +
                'the render will refuse the graph')) : null,
        ];

    const parsed = parseEnable(value);
    const clk = clockOf(g, node);
    const out = [head('When')];

    out.push(div('gp-hint dim', clk.base === 'source'
        ? 'This node reads the file before the edit’s clock is applied, so t here is ' +
          `the source’s own timecode — the window this render touches is ${
              timecode(clk.start)} to ${timecode(clk.start + clk.length)}.`
        : 'Seconds into the render, measured from the start of the range. enable= turns ' +
          'the filter on and off; it does not fade a value in.'));

    if (!parsed.ok) {
        out.push(div('gp-problems', div('gp-problem',
            `This is left as you wrote it: ${parsed.reason}.`)));
        out.push(div('gp-hint dim',
            'A strip can draw between(t,a,b), gt(t,a) and lt(t,b) added together. ' +
            'Anything else — n, pos, arithmetic, any of ffmpeg’s evaluator — is yours ' +
            'and stays exactly as typed.'));
        out.push(...rawRow(value, commit));
        return out;
    }

    // The strip, its spans and the actions under **one** element carrying the
    // clock, because `chaseWhen()` drives all three: the mark, the moment the
    // `here` buttons name, and whether they are offered at all. Split across
    // siblings they would have to agree by being recomputed twice.
    out.push(el('div', { cls: 'when-section', ...clockAttrs(clk) }, [
        strip(parsed.spans, clk, commit),
        ...parsed.spans.map((s, i) => spanRow(parsed.spans, s, i, clk, commit)),
        div('gp-actions', [
            el('button', {
                cls: 'tiny', text: parsed.spans.length ? 'Another span' : 'On for a span',
                'data-f': 'addspan',
                on: { click: () => commit(printEnable(
                    parsed.spans.concat([nextSpan(parsed.spans, clk.length)]))) },
            }),
            // A span placed where you are looking rather than where the last
            // one left off. It runs to the end of the ruler because that is the
            // half a press cannot know — "on from here" is a complete thought
            // and "on from here to somewhere arbitrary" is not.
            el('button', {
                cls: 'tiny', text: 'On from here', 'data-f': 'addhere', 'data-here': 'add',
                title: 'Add a span that comes on where the playhead is standing',
                on: { click: () => {
                    const at = playheadOn(clk, transport.t);
                    if (!onRuler(clk, at)) return;
                    commit(printEnable(parsed.spans.concat([
                        { op: 'gt', from: round(at), to: null }])));
                } },
            }),
            parsed.spans.length ? el('button', {
                cls: 'tiny', text: 'Always on', 'data-f': 'always',
                on: { click: () => commit('') },
            }) : null,
        ]),
        // Written by `chaseWhen()`, so it says which second a press would place
        // an edge at while the playhead is moving rather than which second it
        // was at when the column was last built.
        div('when-at dim', el('span', { 'data-f': 'when-at', text: '' })),
    ]));
    out.push(...rawRow(value, commit));
    return out;
}

/// The clock, on an element, for `chaseWhen()` to read back.
///
/// Worked out by walking the graph for a `setpts`, which is a question about
/// the *shape* of the graph: it cannot change without the column being rebuilt
/// anyway, so it travels on the element rather than being recomputed sixty
/// times a second.
function clockAttrs(clk) {
    return {
        'data-clock': clk.base,
        'data-clock-start': String(clk.start),
        'data-clock-at': String(clk.at),
        'data-clock-length': String(clk.length),
        'data-clock-path': clk.path || '',
    };
}

/// Two decimal places. An edge is a number somebody will read back off the
/// field and off the printed `-filter_complex`, and the playhead carries a
/// float that says 2.4000000000000004 in both.
const round = (v) => Math.round(v * 100) / 100;

/// The expression itself, editable. Under the strip rather than instead of it:
/// the strip is how you find the span and this is how you say something the
/// strip cannot.
function rawRow(value, commit) {
    const field = el('input', {
        cls: 'wide mono', 'data-f': 'enable', type: 'text', value,
        placeholder: 'always on',
        // `change`, not `input` — an edit locks the node and redraws the graph.
        on: { change: () => commit(field.value.trim()) },
    });
    return [
        row('enable', field),
        div('gp-help dim',
            'Quoted — a filtergraph separates filters with commas. t, n, pos and ' +
            'everything ffmpeg’s evaluator takes.'),
    ];
}

/// One span as numbers: what it is, and the one or two moments it names.
function spanRow(spans, s, i, clk, commit) {
    const at = (which, v) => {
        const next = spans.map((x) => Object.assign({}, x));
        next[i][which] = v;
        commit(printEnable(next));
    };
    const kind = select({ cls: 'when-op', 'data-span': String(i),
        on: { change: (e) => commit(printEnable(retype(spans, i, e.target.value, clk))) } },
        [{ id: 'between', label: 'between' }, { id: 'gt', label: 'from' },
         { id: 'lt', label: 'until' }],
        s.op === 'gte' ? 'gt' : s.op === 'lte' ? 'lt' : s.op);

    const number = (which) => el('input', {
        cls: 'when-num mono', 'data-edge': `${i}:${which}`, type: 'text',
        value: s[which] === null ? '' : String(s[which]),
        on: { change: (e) => {
            const v = Number(String(e.target.value).trim());
            if (Number.isFinite(v)) at(which, v);
        } },
    });

    // The whole width of the column, not a `row()`'s value box. A span is
    // `between 1 and 3` read across — four controls — and the value box is
    // about a third of the column: the numbers came out eleven pixels wide,
    // which is a field you can see and cannot read.
    // Set this edge to where the playhead is standing. **Disabled rather than
    // absent** when the playhead is off this node's clock: it is the same
    // control either way, and a button that came and went as the playhead
    // crossed a clip boundary would move everything beside it while somebody
    // was reaching for it.
    //
    // Per edge, not per span, because which end you mean is the whole of the
    // question — a single button would have to guess, and a `between` whose far
    // edge jumped when you meant the near one is worse than no button.
    const here = (which) => el('button', {
        cls: 'tiny when-here', text: which === 'from' ? '⇤' : '⇥',
        'data-f': `here${i}:${which}`, 'data-here': `${i}:${which}`,
        title: which === 'from' ? 'Come on where the playhead is standing'
                                : 'Go off where the playhead is standing',
        on: { click: () => {
            const t = playheadOn(clk, transport.t);
            if (!onRuler(clk, t)) return;
            // Through `moveEdge`, which is what a drag on the strip goes
            // through: it keeps a span's ends in order and on the ruler, and a
            // second answer to that would be a second set of rules for the
            // same span depending on how it was placed.
            commit(printEnable(moveEdge(spans, i, which, round(t), clk.length)));
        } },
    });

    return div('when-edit', [
        span(String(i + 1), 'when-i'),
        kind,
        s.from !== null ? number('from') : null,
        s.from !== null ? here('from') : null,
        s.to !== null ? number('to') : null,
        s.to !== null ? here('to') : null,
        el('button', {
            cls: 'tiny', text: '×', title: 'Take this span off',
            'data-f': `dropspan${i}`,
            on: { click: () => commit(printEnable(spans.filter((_, k) => k !== i))) },
        }),
    ]);
}

/// Change what shape a span is without losing where it was. `between` → `from`
/// keeps the moment it started at, which is the one somebody just placed.
function retype(spans, i, op, clk) {
    const next = spans.map((x) => Object.assign({}, x));
    const s = next[i];
    const a = s.from === null ? 0 : s.from;
    const b = s.to === null ? clk.length : s.to;
    if (op === 'between') next[i] = { op: 'between', from: a, to: Math.max(b, a + 0.1) };
    else if (op === 'gt') next[i] = { op: 'gt', from: a, to: null };
    else next[i] = { op: 'lt', from: null, to: b };
    return next;
}

// ── the strip ──────────────────────────────────────────────────────────────

/// The render's range, with the spans on it and their ends draggable.
///
/// Five labels at fixed fractions rather than a measured tick step: the column
/// is a known width and a ruler that has to measure itself is a ruler that
/// cannot be built and read in one turn.
function strip(spans, clk, commit) {
    const track = div('when-track');
    const paint = (list) => put(track, () => list.map((s, i) => spanEl(s, i, clk)));
    paint(spans);

    track.addEventListener('mousedown', (e) => {
        const edge = e.target && e.target.getAttribute && e.target.getAttribute('data-drag');
        const body = e.target && e.target.getAttribute && e.target.getAttribute('data-span');
        if (!edge && !body) return;
        e.preventDefault();
        e.stopPropagation();

        // Measured once, at the start of the gesture: the element is not moving
        // and a rect read per mouse move is a layout flush per mouse move.
        const box = track.getBoundingClientRect();
        const tAt = (ev) => Math.max(0, Math.min(clk.length,
            ((ev.clientX - box.left) / Math.max(1, box.width)) * clk.length));
        const i = Number((edge || body).split(':')[0]) || 0;
        const which = edge ? edge.split(':')[1] : null;
        const held = spans[i];
        const grabbed = tAt(e);
        let working = spans;

        let moved = false;
        const move = (ev) => {
            const t = tAt(ev);
            if (which) working = moveEdge(spans, i, which, t, clk.length);
            else working = shift(spans, i, held, t - grabbed, clk.length);
            moved = true;
            paint(working);
        };
        // Committed on release and not on every move: a write locks the node and
        // redraws the whole stage, which at sixty frames a second would rebuild
        // the strip out from under the hand holding it.
        //
        // And not committed at all when the pointer never moved. The strip is a
        // *reading* of the expression, so a press that changed nothing has to
        // write nothing: `printEnable(parseEnable(text))` is not the text —
        // `between(t,1.00,2.00)` comes back `between(t,1,2)` — and on a derived
        // node the write is a lock, so a bare click on a span would outrank the
        // edit for ever after.
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            if (moved) commit(printEnable(working));
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    });

    // Three, not five. The column is about two hundred pixels wide and a
    // timecode is eight characters; a ruler whose labels overlap each other is
    // a ruler nobody can read a number off.
    const marks = [0, 0.5, 1].map((f) => el('span', {
        cls: 'when-tick', style: { left: `${f * 100}%` },
        text: timecode(clk.at + clk.length * f),
    }));

    // Where the playhead is, on this node's clock. Built here and *moved* by
    // `chaseWhen()` — the strip is in the properties column, and redrawing that
    // sixty times a second would rebuild every control in it under whatever
    // hand was on one. Same rule the node cards' playback readout follows.
    //
    // The clock travels on the element rather than being recomputed per frame:
    // working it out means walking the graph for a `setpts`, which is a
    // question about the shape of the graph and cannot change without the
    // column being rebuilt anyway.
    track.appendChild(el('div', { cls: 'when-head hidden', 'data-f': 'when-head' }));

    return el('div', {
        cls: 'when-strip' + (spans.length ? '' : ' when-always'),
    }, [
        track,
        div('when-ruler', marks),
        spans.length ? null : div('when-hint dim', 'always on'),
    ]);
}

/// Move every strip's playhead to where the playhead now is.
///
/// **Called from the frame loop, and it writes one style per strip.** Judging
/// where a span lands used to mean playing the node and reading `on`/`off` off
/// the card, which answers "is it on *now*" and never "does it cover the shot".
/// A mark on the strip answers the second, which is the question somebody
/// actually has.
///
/// Two clocks, and the second one is why this is not a division. A node
/// downstream of the derivation's `setpts` is on the render's clock, so the
/// playhead maps by subtracting where the range starts. A node spliced in
/// *before* it — at a clip's `after decode` point — sees the source file's own
/// timestamps, and the honest mapping there goes through the clip that is under
/// the playhead: `sourceTime` is the one place that arithmetic lives.
///
/// **Where the mapping is not known, nothing is drawn.** A source-clock node
/// whose file has no clip under the playhead has no answer — the render is not
/// touching that file at this instant — and a mark parked at an edge would be a
/// statement that it is.
/// Where the playhead is standing, in the seconds *this node's* `enable`
/// expression is written in — or `null` when there is no answer.
///
/// The one home for that mapping. It is asked twice a frame apart for two
/// different reasons — the strip's mark is moved by `chaseWhen()` sixty times a
/// second, and `Comes on here` reads it once on a press — and a button that
/// placed an edge somewhere other than where the mark is drawn would be the
/// stage contradicting itself in the most literal way available to it.
///
/// `null` where the mapping is not known: a source-clock node whose file has no
/// clip under the playhead is not being touched by the render at this instant,
/// and there is no moment in its own timecode to name.
export function playheadOn(clk, t) {
    if (!clk || clk.length <= 0) return null;
    if (clk.base !== 'source') return t - exportRange().start;
    // The clip of that file the playhead is actually inside. Several clips of
    // one input are the ordinary case, so it is the one under the playhead
    // rather than the first one found.
    for (const c of project.clips) {
        if (c.path !== clk.path) continue;
        if (t < c.start || t >= c.start + c.length) continue;
        return sourceTime(c, t) - clk.start;
    }
    return null;
}

/// Whether a moment is on the ruler at all — `playheadOn` can answer with a
/// number that is simply off the end, which is not somewhere an edge can go.
function onRuler(clk, at) {
    return at !== null && at >= 0 && at <= clk.length;
}

export function chaseWhen() {
    // By the clock they carry rather than by class, so the column's strip and
    // the one line on a card are one thing to this: both draw the same spans
    // against the same seconds, and a head on only one of them would be the
    // stage disagreeing with itself.
    const strips = document.querySelectorAll('[data-clock]');
    if (!strips.length) return;
    const t = transport.t;

    for (const strip of strips) {
        const headEl = strip.querySelector('[data-f="when-head"]');
        if (!headEl) continue;
        const clk = {
            base: strip.getAttribute('data-clock'),
            start: Number(strip.getAttribute('data-clock-start')) || 0,
            at: Number(strip.getAttribute('data-clock-at')) || 0,
            length: Number(strip.getAttribute('data-clock-length')) || 0,
            path: strip.getAttribute('data-clock-path') || '',
        };

        const on = playheadOn(clk, t);
        const reachable = onRuler(clk, on);
        headEl.classList.toggle('hidden', !reachable);
        if (reachable) headEl.style.left = `${(on / clk.length) * 100}%`;

        // The offers to place an edge there, under the same clock and moving
        // with the same mark: they are only truthful while there is a moment
        // for them to name, and the label is that moment so a press is never a
        // guess about which second it means.
        const note = strip.querySelector('[data-f="when-at"]');
        if (note) note.textContent = reachable
            // Both numbers: the timecode is what the ruler above is labelled
            // in, and the bare second is what goes in the field and into the
            // printed expression.
            ? `⇤ ⇥ place an edge at ${timecode(clk.at + on)} — t=${on.toFixed(2)}`
            : clk.base === 'source'
                ? 'the playhead is not over a clip of this file, so there is no moment ' +
                  'here to place an edge at'
                : 'the playhead is outside the render’s range';
        for (const b of strip.querySelectorAll('[data-here]')) b.disabled = !reachable;
    }
}

/// One drawn span, with a handle at each end that exists only where there is an
/// end to hold: `gt(t,4)` has no far edge, and a grip on the end of the ruler
/// would say it had one.
function spanEl(s, i, clk) {
    const d = drawnSpan(s, clk.length);
    const pc = (v) => `${((v / Math.max(0.001, clk.length)) * 100).toFixed(2)}%`;
    return place(div('when-span', [
        el('span', { cls: 'when-grab', 'data-span': String(i),
                     title: 'Drag to move this span' }),
        s.from !== null ? el('span', { cls: 'when-edge when-edge-a',
                                       'data-drag': `${i}:from`,
                                       title: 'Drag to move where it comes on' }) : null,
        s.to !== null ? el('span', { cls: 'when-edge when-edge-b',
                                     'data-drag': `${i}:to`,
                                     title: 'Drag to move where it goes off' }) : null,
    ]), pc(d.a), pc(Math.max(0.001, d.b - d.a)));
}

function place(node, left, width) {
    node.style.left = left;
    node.style.width = width;
    return node;
}

/// Move a whole span, keeping its length and staying on the ruler.
function shift(spans, i, held, by, length) {
    const out = spans.map((x) => Object.assign({}, x));
    const s = out[i];
    if (held.from !== null && held.to !== null) {
        const width = held.to - held.from;
        const from = Math.max(0, Math.min(length - width, held.from + by));
        s.from = from;
        s.to = from + width;
    } else if (held.from !== null) {
        s.from = Math.max(0, Math.min(length, held.from + by));
    } else {
        s.to = Math.max(0, Math.min(length, held.to + by));
    }
    return out;
}

// ── the card ───────────────────────────────────────────────────────────────

/// One line on the card: when this node is on, as a bar and as words.
///
/// Only where there is something to say — a filter with no `enable` is always
/// on and a card that said so on every node would be nine restatements of the
/// default. Not draggable: the card is what a node is set to, and the strip in
/// the column is where it is changed.
export function whenBar(node, g) {
    if (!node || node.kind !== 'filter') return null;
    const value = node.params.enable === undefined ? '' : String(node.params.enable);
    if (!value) return null;
    const parsed = parseEnable(value);
    const clk = clockOf(g, node);

    const track = div('when-track', parsed.ok
        ? parsed.spans.map((s, i) => {
            const d = drawnSpan(s, clk.length);
            return place(div('when-span when-flat'),
                         `${((d.a / clk.length) * 100).toFixed(2)}%`,
                         `${(((d.b - d.a) / clk.length) * 100).toFixed(2)}%`);
        })
        : null);
    // The playhead, moved by `chaseWhen()` like the column's. On the card as
    // well as in the column because the card is where several nodes are on
    // screen at once: "does this blur cover the shot" is asked of one span, and
    // "which of these is on right now" is asked of all of them, and only the
    // card can answer the second.
    track.appendChild(el('div', { cls: 'when-head hidden', 'data-f': 'when-head' }));

    // The clock on the row rather than on a wrapper: `.gn-when` lays its track
    // and its text out as a flex pair, and a box in between to hang three
    // attributes off would be a layout change to carry data.
    return el('div', {
        cls: 'gn-when' + (parsed.ok ? '' : ' gn-when-raw'),
        ...clockAttrs(clk),
    }, [
        track,
        span(parsed.ok ? enableText(value) : 'a time expression', 'gn-when-text'),
    ]);
}
