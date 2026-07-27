// The render's back-channel, end to end: from `av_log` inside libav to a line
// somebody can read.
//
// The native suite proves the channel — that a message is captured with its
// level and its source, that the rings are bounded and say what they dropped,
// that a measuring filter's values arrive as a series with sane timestamps.
// This proves the half above it, which is the half that decides whether any of
// that was worth building: that the drain runs off the frame loop without
// anybody asking it to, that a warning reaches the surface and is *visible*
// there, that a render which went fine stays quiet, and that what a filter
// measured is a named series over time rather than more log lines.
//
// The render it drives is deliberately one the renderer will complain about: a
// graph running at half the output rate, which is not fatal, is invisible in
// the file until it plays at double speed, and is exactly the sort of thing
// that used to be said to a console nobody sees. `cropdetect` rides along on
// the same graph, because measuring and warning are the two halves of this
// channel and one render can do both.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_report.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_report.js -- <file>');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

const q = (sel, root) => (root || document).querySelector(sel);
const qq = (sel, root) => (root || document).querySelectorAll(sel);
const el = (id) => document.getElementById(id);
const key = (k) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

waitFor('the app to come up', () => globalThis.__ffmpegBroReady === true);
const app = globalThis.__ffmpegBro;
const report = app.report;

// ── the channel exists before anything has rendered ────────────────────────
//
// Startup, probing and playback all log, and they log to nobody in particular.
// The surface has to be there for them: a report that only comes into being
// when a render does is a report with a hole in it exactly where "why will this
// file not open" lives.

console.log('\nthe report is there before a render is');
ok(!!el('reportbar'), 'the bar is under every stage');
ok(!!el('rep-head') && el('rep-head').textContent.length > 0,
   `and says something without being asked: "${el('rep-head').textContent.trim()}"`);
ok(el('rep-body').classList.contains('hidden'), 'collapsed, because nothing is wrong');

const poll = bro.ffmpeg.render.poll({ log: 0, meta: 0, max: 10 });
ok(Array.isArray(poll.log) && Array.isArray(poll.meta) && poll.cursor,
   'render.poll(cursor) drains the channel');
ok(typeof poll.cursor.log === 'number' && typeof poll.cursor.meta === 'number',
   'and hands back a cursor to carry forward');
const plain = bro.ffmpeg.render.poll();
ok(plain.log === undefined && plain.meta === undefined,
   'a poll that did not ask for messages does not pay for them');
ok(typeof plain.job === 'number', 'but always says which render is running');

// ── a render that has something to say ─────────────────────────────────────

console.log('\na render with a warning and a measurement in it');
app.open(media);
waitFor('the clip to load', () => app.project.clips.length === 1);
pump(200);

const probe = bro.ffmpeg.probe(media);
const out = bro.appDir + '/../out/ui-report.mp4';
const W = 320, H = 180;

// Half the output rate through `fps`, so the renderer says the graph and the
// render disagree about how long a second is — a real warning, from a real
// render, about a real problem. `cropdetect` measures the picture on the way
// past, which is the other half of the channel.
const graph = `[0:v]cropdetect=limit=24:round=2:reset=1,fps=12,scale=${W}:${H}[vout]`;
bro.ffmpeg.render.start({
    path: out, width: W, height: H, fps: 24,
    start: 0, end: 1.0,
    videoCodec: 'libx264', crf: 30, preset: 'ultrafast',
    audio: false,
    filterGraph: graph,
    filterInputs: [{ label: '0:v', path: media, stream: 'v' }],
});

// Nothing here polls or drains: the frame loop does, which is the point.
waitFor('the render to finish', () => {
    const p = report.reportState();
    return p.job === 0 && p.lastJob > 0 && report.seriesList().length > 0;
});
pump(200);

const state = report.reportState();
const job = state.lastJob;
ok(job > 0, `the frame loop drained it without being asked (render #${job})`);

const said = report.messages().filter((m) => m.job === job);
ok(said.length > 0, `${said.length} messages arrived, all pinned to this render`);

const warning = said.find((m) => m.level === 'warning' && /fps/.test(m.text));
ok(!!warning, 'the rate the graph runs at is reported as a warning');
ok(warning && warning.source === 'graph',
   `and it says who said it: ${warning && warning.source}`);

// The messages libav itself emits are the reason for all of this. x264 says
// what profile it settled on at info level, which is below the console's
// threshold and above the report's — the split that lets the channel keep what
// is only wanted afterwards.
const fromLibav = said.filter((m) => m.source && m.source !== 'graph' && m.source !== 'render');
ok(fromLibav.length > 0,
   `libav's own words are in it too: ${fromLibav.slice(0, 3)
       .map((m) => `${m.source}: ${m.text.slice(0, 40)}`).join(' | ')}`);

const verdict = report.verdict(job);
ok(verdict.warnings > 0 && verdict.errors === 0,
   `the verdict on this render is ${verdict.warnings} warnings, ${verdict.errors} errors`);

// ── the head is impossible to miss ─────────────────────────────────────────

console.log('\nsaying so where somebody will see it');
const bar = el('reportbar');
ok(bar.classList.contains('warn'), 'the bar colours itself when a render warned');
ok(!bar.classList.contains('bad'), 'and does not claim an error it did not have');
const headline = el('rep-head').textContent;
ok(/warning/.test(headline), `the one line says so: "${headline.trim()}"`);
ok(/series/.test(headline), 'and counts what was measured');

// ── opened ─────────────────────────────────────────────────────────────────

console.log('\nopened');
key('r');
pump(120);
ok(!el('rep-body').classList.contains('hidden'), 'R opens it from any stage');

const rows = qq('.rep-msg');
ok(rows.length > 0, `${rows.length} messages are on screen`);
const shown = Array.from(rows).map((r) => r.getAttribute('data-level'));
ok(shown.every((l) => l === 'warning' || l === 'error' || l === 'fatal' || l === 'panic'),
   'and at the default level they are the ones worth reading, not the whole log');
const first = q('.rep-msg');
ok(q('.rep-lv', first).textContent.length > 0 &&
   q('.rep-src', first).textContent.length > 0 &&
   q('.rep-text', first).textContent.length > 0,
   'each carrying its level, its source and what was said');

// Everything is still there — the quiet half is a filter, not a discard. That
// matters: the render where the info line turns out to be the answer is the
// one where you go looking for it.
const everything = q('[data-seg="rep-level"][data-v="32"]');
ok(!!everything, 'the level filter offers everything libav said');
everything.dispatchEvent(new MouseEvent('click', { bubbles: true }));
pump(120);
ok(qq('.rep-msg').length > rows.length,
   `${qq('.rep-msg').length} messages under Everything, against ${rows.length} under Warnings`);

// ── what was measured ──────────────────────────────────────────────────────
//
// The half chunk 10 is built on. A filter's metadata is a time series and has
// to arrive as one: named, sampled, in order, and belonging to the render that
// produced it.

console.log('\nwhat the filter measured');
const series = report.seriesList();
ok(series.length > 0, `${series.length} series: ${series.map((s) => s.key).join(' ')}`);
ok(series.every((s) => s.key.indexOf('lavfi.') === 0),
   "named by libavfilter's own keys, verbatim");
const width = report.seriesFor('lavfi.cropdetect.w');
ok(!!width && width.points.length > 1,
   `cropdetect's width is a series of ${width ? width.points.length : 0} points`);
ok(width && width.numeric && Number.isFinite(width.min) && Number.isFinite(width.max),
   `with a range: ${width && width.min} … ${width && width.max}`);
let ascending = true, inRange = true;
for (let i = 0; i < width.points.length; i++) {
    if (i && width.points[i].t + 1e-6 < width.points[i - 1].t) ascending = false;
    if (width.points[i].t < -1e-9 || width.points[i].t > 2.0) inRange = false;
}
ok(ascending, 'sampled in order');
ok(inRange, `and inside the seconds that were rendered (${width.points[0].t.toFixed(2)} … ` +
            `${width.points[width.points.length - 1].t.toFixed(2)})`);
ok(width.points.every((p) => p.job === job), 'every point pinned to this render');

// What it looks like, for the same reason ui_player.js screenshots the viewer:
// every assertion here is about structure, and a panel can satisfy all of them
// while being unreadable.
screenshot('out/report.png');

const seriesRows = qq('.rep-series-row');
ok(seriesRows.length === series.length, `each drawn as a row (${seriesRows.length})`);
const wRow = q('[data-series="lavfi.cropdetect.w"]');
ok(!!wRow, 'the row is named for the series');
ok(q('.rep-series-name', wRow).textContent === 'lavfi.cropdetect.w',
   'and says so on it');
const spark = q('.rep-spark', wRow);
ok(spark && !spark.classList.contains('hidden') && spark.width > 1,
   `with a line drawn over the render (${spark && spark.width}px)`);

// ── it survives the render finishing ───────────────────────────────────────
//
// The messages matter most once it is over. The native rings outlive the job
// for that reason and nothing here is cleared when one ends — so walking away
// to another stage and coming back finds the same report.

console.log('\nit survives');
app.shell.goTo('sources');
pump(200);
app.shell.goTo('compose');
pump(200);
ok(report.messages().filter((m) => m.job === job).length === said.length,
   'the render is over, the stage has changed twice, and what it said is still there');
ok(report.seriesFor('lavfi.cropdetect.w').points.length === width.points.length,
   'and so is everything it measured');
ok(!el('rep-body').classList.contains('hidden'),
   'and the surface is where it was left');

console.log(`\n${checks} checks, all passed`);
