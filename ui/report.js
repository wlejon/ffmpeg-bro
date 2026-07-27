// What the render said.
//
// The command bar under every stage says what is *about* to run. This is its
// counterpart and it exists for the same reason: an application whose whole
// argument is that ffmpeg should stop being a thing you guess at cannot let a
// render finish having quietly ignored half of what it was told. Until this
// existed a render could report a percentage, a frame count, a size and — only
// when it failed outright — one sentence. Everything libav* had to say went to
// a console nobody sees, and the whole family of filters that measures rather
// than paints had nowhere at all to put an answer.
//
// So there are two kinds of thing here and they are drawn as two, because they
// are not the same kind of fact:
//
//   - **Messages.** Levelled, attributed, and ordered — `libx264` announcing
//     the profile it settled on, a muxer refusing a tag, the renderer saying
//     the graph runs at a different rate from the output. A list.
//   - **Series.** A filter's measurements, named by libavfilter's own metadata
//     keys and sampled at the timestamps of the frames they came off.
//     `lavfi.cropdetect.w` is a number that changes over the render, and the
//     only useful shape for it is a line. This is what chunk 10's plots and
//     actions grow on, so what matters here is that the data model is right:
//     a named series, points of `{ t, v }`, and nothing invented on the way in.
//
// Three rules the surface follows:
//
// **Quiet when there is nothing wrong.** A render that went fine says so in
// one line and takes up one line. The default filter is warnings and above, so
// the ordinary case shows an empty list rather than four hundred lines of
// encoder chatter — which is present, under `All`, for the render where it
// turns out to matter.
//
// **Impossible to miss when there is.** The head colours itself and counts,
// and the progress panel on the Write stage says so where somebody is already
// looking.
//
// **It survives the render.** The messages matter most once it is over, and
// the native rings outlive the job for exactly that reason — so nothing here
// is cleared when a render ends. `Clear` is a button, because throwing away
// what you were about to read is a decision, not a side effect.

import { el, div, span, put, show, fromTemplate, segmented } from './dom.js';
import { drawPlot, sampleAt, colorFor, shortValue, MAX_SERIES } from './plot.js';
import * as measure from './measure.js';

// libav's own numbering, which arrives on every record as `severity`: small is
// severe. Kept as numbers rather than as a table of names here — the names come
// from the same place the numbers do.
const ERROR = 16, WARNING = 24, INFO = 32;

// What the browser end keeps. The native rings are sized for the gap between
// two polls; this is sized for what a person might scroll back through, and
// both of them say so rather than growing until the process falls over.
const MAX_MESSAGES = 1000;
const MAX_POINTS = 4000;

const state = {
    cursor: { log: 0, meta: 0 },
    messages: [],
    series: new Map(),
    dropped: { log: 0, meta: 0, points: 0 },
    // Which render is running, and which one last said anything. Every record
    // carries the render it was said during, and 0 for the ones said while
    // nothing was rendering — a probe that failed, a decoder complaining during
    // playback. Both are worth reading and only one of them is about a render.
    job: 0,
    lastJob: 0,
    // When each render started talking, so a message can be timed against its
    // own render rather than against how long the application has been open.
    jobStart: new Map(),
};

let refs = {};
let hooks = {};
let open = false;
let level = WARNING;
let mine = true;         // only the render that last said something
let dirty = true;

// Which series are on the plot, and where the pointer is on it.
//
// **Held by key rather than by object**, for the reason the graph holds its
// selection by anchor: a series object is rebuilt from the channel and a
// reference to one would name whichever version happened to exist when it was
// taken. It is also what makes a colour stick to a series across a redraw.
const picked = new Set();
let hoverT = null;
let plotGeom = null;
let plotCanvas = null;

export function initReport(r, h) {
    refs = r;
    hooks = h || {};
    refs.toggle.addEventListener('click', () => setOpen(!open));
    refs.head.addEventListener('click', () => setOpen(!open));
    draw();
}

export function isOpen() { return open; }

export function setOpen(on) {
    if (open === on) return;
    open = on;
    refs.bar.classList.toggle('open', open);
    refs.toggle.textContent = open ? '▾' : '▸';
    show(refs.body, open);
    draw();
}

export function openReport() { setOpen(true); }

/// Everything new since the last frame.
///
/// Called from the frame loop, always — not only while the export workspace is
/// up. A render started from the Write stage keeps going while you walk back to
/// the edit, `probe()` and playback log from wherever you are, and a channel
/// that only listened while one panel was on screen would have holes in it
/// exactly where somebody went to look at something.
export function tick() {
    let p;
    try {
        p = bro.ffmpeg.render.poll({ log: state.cursor.log, meta: state.cursor.meta, max: 500 });
    } catch (e) {
        return;
    }
    state.job = p.job || 0;
    const c = p.cursor || {};
    state.cursor.log = c.log || state.cursor.log;
    state.cursor.meta = c.meta || state.cursor.meta;
    state.dropped.log += c.logDropped || 0;
    state.dropped.meta += c.metaDropped || 0;

    const logs = p.log || [];
    const meta = p.meta || [];
    if (!logs.length && !meta.length) {
        if (dirty) draw();
        return;
    }
    for (const m of logs) addMessage(m);
    for (const s of meta) addSample(s);
    draw();
}

function noteJob(job, at) {
    if (!job) return;
    if (!state.jobStart.has(job)) state.jobStart.set(job, at);
    state.lastJob = job;
}

function addMessage(m) {
    noteJob(m.job, m.at);
    state.messages.push(m);
    if (state.messages.length > MAX_MESSAGES)
        state.messages.splice(0, state.messages.length - MAX_MESSAGES);
    dirty = true;
}

/// One measurement, into the series it belongs to.
///
/// The key is libavfilter's, verbatim — `lavfi.cropdetect.w`, `lavfi.r128.M`,
/// `lavfi.signalstats.YAVG`. It already names both the filter and the quantity,
/// which is what a series wants to be called, and rewriting it into something
/// friendlier would mean a table of filters this application refuses to have.
///
/// A value that parses as a number gets a number; one that does not keeps its
/// string and the series says it is not numeric. Both happen: `cropdetect`
/// measures and `silencedetect` announces.
function addSample(s) {
    noteJob(s.job, s.at);
    let series = state.series.get(s.key);
    if (!series) {
        series = { key: s.key, stream: s.stream, points: [], numeric: true,
                   min: Infinity, max: -Infinity, last: '', job: s.job, count: 0 };
        state.series.set(s.key, series);
    }
    const v = Number(s.value);
    const numeric = s.value !== '' && Number.isFinite(v);
    if (!numeric) series.numeric = false;
    series.points.push({ t: s.at, v: numeric ? v : NaN, raw: s.value, job: s.job });
    series.count++;
    series.last = s.value;
    series.job = s.job;
    if (numeric) {
        if (v < series.min) series.min = v;
        if (v > series.max) series.max = v;
    }
    if (series.points.length > MAX_POINTS) {
        const drop = series.points.length - MAX_POINTS;
        series.points.splice(0, drop);
        state.dropped.points += drop;
    }
    dirty = true;
}

export function clearReport() {
    state.messages.length = 0;
    state.series.clear();
    state.jobStart.clear();
    state.dropped.log = state.dropped.meta = state.dropped.points = 0;
    state.lastJob = 0;
    draw();
}

// ── what is on screen ──────────────────────────────────────────────────────

/// The render the surface is about: the one running, or the last one that said
/// anything. Zero means nothing has rendered and the channel is only carrying
/// what probing and playback had to say.
function subject() { return state.job || state.lastJob; }

function visibleMessages() {
    const job = subject();
    return state.messages.filter((m) =>
        m.severity <= level && (!mine || !job || m.job === job));
}

function countsFor(job) {
    let warnings = 0, errors = 0;
    for (const m of state.messages) {
        if (job && m.job !== job) continue;
        if (m.severity <= ERROR) errors++;
        else if (m.severity <= WARNING) warnings++;
    }
    return { warnings, errors };
}

function seriesForSubject() {
    const job = subject();
    const out = [];
    for (const s of state.series.values())
        if (!mine || !job || s.job === job) out.push(s);
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
}

/// The one line that is always there. It is a statement about the render rather
/// than a label: "nothing to report" is the answer most of the time and is
/// worth saying, because a bar that only ever appears when something is wrong
/// is a bar nobody knows the meaning of when it does.
function headline() {
    const job = subject();
    const n = countsFor(mine ? job : 0);
    const series = seriesForSubject();
    const samples = series.reduce((a, s) => a + s.count, 0);
    const bits = [];
    if (n.errors) bits.push(`${n.errors} error${n.errors === 1 ? '' : 's'}`);
    if (n.warnings) bits.push(`${n.warnings} warning${n.warnings === 1 ? '' : 's'}`);
    if (series.length)
        bits.push(`${series.length} series · ${samples} sample${samples === 1 ? '' : 's'}`);

    const what = state.job ? 'this render'
               : state.lastJob ? 'the last render'
               : 'ffmpeg';
    if (!bits.length)
        return [what === 'ffmpeg' ? 'Nothing to report yet' : `Nothing to report from ${what}`,
                n, series.length];
    return [`${what[0].toUpperCase()}${what.slice(1)}: ${bits.join(' · ')}`, n, series.length];
}

export function draw() {
    if (!refs.head) return;
    dirty = false;
    const [text, n] = headline();
    put(refs.head, () => [
        span(text, 'rep-say'),
        state.dropped.log || state.dropped.meta
            ? span(`${state.dropped.log + state.dropped.meta} dropped`, 'dim rep-dropped')
            : null,
    ]);
    refs.bar.classList.toggle('warn', !n.errors && n.warnings > 0);
    refs.bar.classList.toggle('bad', n.errors > 0);
    if (!open) return;

    put(refs.body, () => [
        drawFilters(),
        div('rep-cols', [
            div('rep-col rep-msgs', drawMessages()),
            div('rep-col rep-series', drawSeries()),
        ]),
    ]);
    // Built, then measured, then painted — the split the range strip and the
    // graph's cards already use, and for the same reason: a canvas has no width
    // until it is in the document.
    paintSparks();
    paintPlot();
}

// ── what was measured, and what can be done about it ───────────────────────

/// The row that starts a measurement.
///
/// **It puts the filter on the graph and does nothing else.** There is no
/// private measuring path in this application, for the reason the node previews
/// have none: a measurement that agreed with the render most of the time would
/// be worse than none, because it would be trusted. So this is a shortcut to a
/// gesture somebody could make on the Graph stage with the palette — placed
/// where the answers appear, since that is where the wish for one occurs — and
/// the card that appears on the graph is the proof it is the same gesture.
function drawOffers() {
    const list = measure.offers();
    if (!list.length) return null;
    return div('rep-measure', [
        span('Measure', 'dim'),
        ...list.map((o) => {
            const on = measure.measuring(o.filter).length > 0;
            return el('button', {
                cls: 'tiny' + (on ? ' on' : ''),
                'data-measure': o.filter,
                title: on
                    ? `${o.filter} is on the graph — click to take it off`
                    : `${o.filter}: ${o.hint}`,
                text: o.label,
                on: { click: () => {
                    if (on) measure.stopMeasuring(o.filter);
                    else {
                        measure.startMeasuring(o.filter);
                        if (hooks.flash)
                            hooks.flash(`${o.filter} is on the graph — render to measure`);
                    }
                    if (hooks.changed) hooks.changed();
                    draw();
                } },
            });
        }),
    ]);
}

/// One measurement that can be acted on — or the reason it cannot.
///
/// The raw text it was read out of is always on the card. That is not
/// decoration: the whole argument for this application is that ffmpeg stops
/// being a thing you guess at, and a number handed over without the line it
/// came from is exactly the sort of thing that has to be taken on trust.
function findingCard(f) {
    const head = div('rep-find-head', [
        span(f.title, 'rep-find-name'),
        span(f.filter, 'mono dim rep-find-filter'),
        span('', 'spacer'),
        f.ok && f.detail ? span(f.detail, 'rep-find-detail') : null,
    ]);
    const body = [];
    if (f.raw) body.push(div('mono dim rep-find-raw', f.raw));
    if (!f.ok) {
        body.push(div('rep-find-no', f.reason));
    } else if (f.reason) {
        // Read, and nothing to do about it — which is a real answer and not a
        // failure, so it is said in the same voice rather than as a warning.
        body.push(div('dim rep-find-no', f.reason));
    } else if (f.verb) {
        body.push(el('button', {
            cls: 'tiny primary', 'data-apply': f.id, title: f.verb.hint,
            text: f.verb.label,
            on: { click: () => { f.verb.apply(hooks); if (hooks.changed) hooks.changed(); draw(); } },
        }));
        body.push(span(f.verb.hint, 'dim rep-find-hint'));
    }
    return div('rep-find' + (f.ok ? '' : ' rep-find-refused'),
               [head, ...body]);
}

function currentFindings() {
    const job = subject();
    const size = hooks.picture ? hooks.picture() : { width: 0, height: 0 };
    return measure.findings({
        series: state.series,
        messages: state.messages.filter((m) => !mine || !job || m.job === job),
        job: mine ? job : 0,
        width: size.width, height: size.height,
    });
}

// ── the plot ───────────────────────────────────────────────────────────────

/// The series on the plot, in the order they were picked, each carrying the
/// colour its key earns. Colour follows the series and not its position, so
/// unpicking one leaves the rest where they were.
function plotted() {
    const taken = new Set();
    const out = [];
    for (const s of seriesForSubject()) {
        if (!picked.has(s.key) || !s.numeric || s.points.length < 2) continue;
        const color = colorFor(s.key, taken);
        taken.add(color);
        out.push(Object.assign({}, s, { color }));
    }
    return out;
}

function drawPlotPanel() {
    const series = plotted();
    if (!series.length) return null;

    plotCanvas = el('canvas', { cls: 'rep-plot-c' });
    plotCanvas.addEventListener('mousemove', (e) => {
        if (!plotGeom || !plotGeom.timeAt) return;
        const box = plotCanvas.getBoundingClientRect();
        const t = plotGeom.timeAt(e.clientX - box.left);
        hoverT = Math.max(plotGeom.t0, Math.min(plotGeom.t1, t));
        paintPlot();
        updateReadout();
    });
    plotCanvas.addEventListener('mouseout', () => { hoverT = null; paintPlot(); updateReadout(); });
    // A measurement is about a moment, and the moment is on the timeline. So a
    // click on the plot is the shortest path from "the number went wrong here"
    // to looking at the frame it went wrong on.
    plotCanvas.addEventListener('click', (e) => {
        if (!plotGeom || !plotGeom.timeAt || !hooks.seek) return;
        const box = plotCanvas.getBoundingClientRect();
        hooks.seek(plotGeom.timeAt(e.clientX - box.left));
    });

    return div('rep-plot', [
        div('rep-plot-legend', series.map((s) => div('rep-key', [
            el('span', { cls: 'rep-swatch', style: { background: s.color } }),
            span(s.key, 'mono'),
        ]))),
        plotCanvas,
        div('rep-plot-foot', [
            el('span', { cls: 'mono rep-readout' }),
            span('', 'spacer'),
            el('span', { cls: 'dim rep-plot-note' }),
        ]),
    ]);
}

/// The values under the pointer, in the series' own units — which is what makes
/// a normalised plot honest rather than merely pretty: the shapes are compared
/// on the axis and the numbers are read here.
function updateReadout() {
    if (!refs.body) return;
    const out = refs.body.querySelector('.rep-readout');
    if (!out) return;
    const series = plotted();
    if (hoverT === null || !series.length) {
        out.textContent = series.length ? 'hover to read a value · click to go there' : '';
        return;
    }
    const bits = [`${hoverT.toFixed(2)}s`];
    for (const s of series) {
        const p = sampleAt(s, hoverT);
        bits.push(`${s.key.replace(/^lavfi\./, '')} ${p ? shortValue(p.v) : '—'}`);
    }
    out.textContent = bits.join('   ');
}

function paintPlot() {
    if (!plotCanvas || !refs.body) return;
    const series = plotted();
    if (!series.length) return;
    let t0 = Infinity, t1 = -Infinity;
    for (const s of series) {
        t0 = Math.min(t0, s.points[0].t);
        t1 = Math.max(t1, s.points[s.points.length - 1].t);
    }
    if (!(t1 > t0)) t1 = t0 + 1;
    plotGeom = drawPlot(plotCanvas, {
        series, t0, t1, hoverT,
        marks: measure.marksOf(currentFindings().filter((f) => f.ok)),
    });
    const note = refs.body.querySelector('.rep-plot-note');
    if (note)
        note.textContent = plotGeom.normalised
            ? 'normalised: these do not share a scale, so the axis is each series’ own ' +
              '0–100% and the numbers are on the left'
            : '';
    updateReadout();
}

function drawFilters() {
    return div('rep-filters', [
        segmented('rep-level', [
            { v: String(ERROR), l: 'Errors' },
            { v: String(WARNING), l: 'Warnings' },
            { v: String(INFO), l: 'Everything' },
        ], String(level), (v) => { level = Number(v); draw(); }),
        el('button', {
            cls: 'tiny' + (mine ? ' on' : ''),
            'data-f': 'mine',
            title: 'Only what the render in hand said, rather than everything since the ' +
                   'application opened',
            text: 'This render',
            on: { click: () => { mine = !mine; draw(); } },
        }),
        span('', 'spacer'),
        el('button', { cls: 'tiny', 'data-f': 'clear', text: 'Clear',
                       on: { click: clearReport } }),
    ]);
}

function levelClass(sev) {
    return sev <= ERROR ? 'bad' : sev <= WARNING ? 'warn' : 'dim';
}

/// When a message was said, against its own render rather than against how long
/// the application has been open — the number anybody reading a render's log
/// wants is seconds into that render.
function when(m) {
    const start = state.jobStart.get(m.job);
    if (m.job && start !== undefined) return `+${(m.at - start).toFixed(1)}s`;
    return `${m.at.toFixed(1)}s`;
}

function drawMessages() {
    const list = visibleMessages();
    const head = div('rep-col-head', [
        span('Messages'),
        span('', 'spacer'),
        span(`${list.length} shown of ${state.messages.length}`, 'dim'),
    ]);
    if (!list.length) {
        return [head, div('rep-empty dim',
            level <= WARNING
                ? 'Nothing at this level. libav says a good deal more than this — ' +
                  'Everything shows it.'
                : 'Nothing yet.')];
    }
    // Newest last, the way a log reads, and the pane is scrolled to the bottom
    // after it is built.
    return [head, div('rep-list', list.map((m) => {
        const node = fromTemplate('tpl-rep-msg');
        node.classList.add(levelClass(m.severity));
        node.setAttribute('data-level', m.level);
        node.querySelector('.rep-lv').textContent = m.level;
        node.querySelector('.rep-src').textContent = m.source || '—';
        node.querySelector('.rep-when').textContent = when(m);
        node.querySelector('.rep-text').textContent = m.text;
        return node;
    }))];
}

function drawSeries() {
    const list = seriesForSubject();
    const found = currentFindings();
    const head = div('rep-col-head', [
        span('Measured'),
        span('', 'spacer'),
        span(list.length ? `${list.length} series` : '', 'dim'),
    ]);
    const offers = drawOffers();
    if (!list.length && !found.length) {
        return [head, offers, div('rep-empty dim',
            'Nothing measured this render. Any filter that answers a question rather ' +
            'than changing a picture reports here — put one on the graph, or use the ' +
            'row above, and what it measures arrives sampled frame by frame.')];
    }
    return [head, offers,
            found.length ? div('rep-finds', found.map(findingCard)) : null,
            drawPlotPanel(),
            div('rep-series-list', list.map(seriesRow))];
}

/// One series, as the index into the plot rather than as the plot.
///
/// The sparkline is still the right shape here — eight of them in a column
/// answer "did this change, and where" at a glance, which is what a list is
/// for. Clicking one puts it on the plot above, where it can be read against
/// the others and pointed at.
function seriesRow(s) {
    const node = fromTemplate('tpl-rep-series');
    node.setAttribute('data-series', s.key);
    const on = picked.has(s.key);
    node.classList.toggle('on', on);
    if (on) node.style.borderLeftColor = colorFor(s.key, null);
    node.addEventListener('click', () => {
        if (picked.has(s.key)) picked.delete(s.key);
        else if (picked.size >= MAX_SERIES) {
            // Past six lines a plot stops being readable: hue is the identity
            // channel and a seventh is either a repeat or a colour nobody
            // checked. Said, rather than quietly generated.
            if (hooks.flash)
                hooks.flash(`A plot holds ${MAX_SERIES} lines — take one off first`);
            return;
        } else picked.add(s.key);
        draw();
    });
    node.querySelector('.rep-series-name').textContent = s.key;
    const span0 = s.points.length ? s.points[0].t : 0;
    const span1 = s.points.length ? s.points[s.points.length - 1].t : 0;
    node.querySelector('.rep-series-stat').textContent =
        (s.numeric && s.min <= s.max
            ? `${trim(s.min)} … ${trim(s.max)} · now ${trim(Number(s.last))}`
            : `last ${s.last}`);
    node.querySelector('.rep-series-span').textContent =
        `${s.stream} · ${s.count} sample${s.count === 1 ? '' : 's'} · ` +
        `${span0.toFixed(2)}–${span1.toFixed(2)}s`;
    const canvas = node.querySelector('.rep-spark');
    // A series of one value, or one that is not a number at all, has no line in
    // it: a flat stroke across a card would say "measured and steady" where the
    // truth is "measured once".
    if (!s.numeric || s.points.length < 2) canvas.classList.add('hidden');
    else canvas.__series = s;
    return node;
}

const trim = (v) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '—');

/// The line, drawn after the row is in the document and has a width.
///
/// Deliberately plain: min to max over the whole span, no axes, no grid, no
/// interaction. It is here to answer "did this change, and where" at a glance,
/// which is what a series in a column of eight of them is for. Chunk 10 is
/// where one of these becomes a plot you can point at.
function paintSparks() {
    if (!refs.body) return;
    for (const canvas of refs.body.querySelectorAll('.rep-spark')) {
        const s = canvas.__series;
        if (!s) continue;
        const w = Math.max(1, Math.round(canvas.clientWidth));
        const h = Math.max(1, Math.round(canvas.clientHeight));
        if (w <= 1) continue;               // the bar is closed, or not laid out yet
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.clearRect(0, 0, w, h);

        const t0 = s.points[0].t;
        const t1 = s.points[s.points.length - 1].t;
        const dt = t1 - t0 || 1;
        let lo = s.min, hi = s.max;
        if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
        const x = (t) => ((t - t0) / dt) * (w - 2) + 1;
        const y = (v) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);

        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        for (const p of s.points) {
            if (!Number.isFinite(p.v)) continue;
            const px = x(p.t), py = y(p.v);
            if (started) ctx.lineTo(px, py);
            else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
    }
}

/// Repaint the lines when the bar changes size.
///
/// The canvases are the one thing here that does not survive a resize on its
/// own — everything else is text that reflows. Guarded on the measured width
/// rather than run every frame, because repainting eight sparklines sixty times
/// a second to draw the same eight sparklines is the sort of thing that makes a
/// frame loop mysteriously expensive. A measurement of zero is the bar being
/// closed, not the bar being narrow.
let lastWidth = -1;
export function chaseReport() {
    if (!open || !refs.body) return;
    const w = refs.body.clientWidth;
    if (w <= 0 || w === lastWidth) return;
    lastWidth = w;
    paintSparks();
    paintPlot();
}

// ── what the rest of the application asks ──────────────────────────────────

/// How the render in hand went, for anything that wants to say so where
/// somebody is already looking — the Write stage's progress panel does.
export function verdict(job) {
    const which = job || subject();
    return countsFor(which);
}

/// The series, for tests and for whatever comes to plot them.
export function seriesList() { return seriesForSubject(); }
export function seriesFor(key) { return state.series.get(key) || null; }
export function messages() { return state.messages.slice(); }
export function reportState() { return state; }

/// What is on the plot, and putting something there. On the surface because a
/// plot is drawn from it and a test has to be able to ask for one without
/// finding a row and clicking it — the row *is* checked, separately, which is
/// the thing that would otherwise go untested if this were the only way in.
export function plotSeries(key, on) {
    if (on === false) picked.delete(key);
    else picked.add(key);
    draw();
}
export function plotted_() { return Array.from(picked); }

/// Every measurement this render supports, parsed — and the reason where it
/// does not. The verbs hang off these, so this is what anything wanting to act
/// on a measurement asks, rather than parsing the channel a second time.
export { currentFindings as findings };
export { measure };
