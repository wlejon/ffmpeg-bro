// Filters whose output is information, from putting one on the graph to acting
// on what it found.
//
// `ui_report.js` proves the channel reaches a line on screen. This proves the
// half chunk 10 added on top of it, which is the half that decides whether any
// of it was worth capturing: that a measurement can be *started* where somebody
// wants one, that what came back is drawn as a plot rather than as a smudge,
// that a number can be **applied** — and, above all, that a measurement which
// cannot be trusted is refused in words instead of being applied anyway.
//
// The last of those is the one to keep. A crop applied from a `cropdetect` that
// was still finding letterbox is a shot with its edges taken off, and it looks
// exactly like a crop that worked.
//
// Three of the checks here are written against **hand-made channel records**,
// the way `ui_filtergraph.js` is written against hand-made specs. Parsing what a
// filter said is a pure function of what it said, so the spans a `blackdetect`
// finds can be stated exactly rather than hoped for out of a fixture that may
// or may not contain any black — and the cut those spans produce is then made
// on the real timeline, through the real split.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_measure.js -- <media-file>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_measure.js -- <file>');

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 60000) {
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

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

waitFor('the app to come up', () => globalThis.__ffmpegBroReady === true);
const A = globalThis.__ffmpegBro;
const report = A.report;
const measure = report.measure;
const overlay = A.graph.overlay;

// The overlay is remembered in localStorage between runs — there is still no
// project file — so a suite that asserts on what is in the graph has to start
// from an empty one rather than from whatever the last run left.
overlay.clear();

A.open(media);
waitFor('the clip to load', () => A.project.clips.length === 1);
pump(300);

// ── starting one ───────────────────────────────────────────────────────────
//
// The mechanism is and stays "put a filter on the graph". What is offered is a
// shortcut to that gesture, placed where the answers appear — and the proof
// that it is the same gesture is that the node is on the graph afterwards,
// where the palette would have put it and where the command bar prints it.

console.log('\nstarting a measurement puts a filter on the graph');
report.setOpen(true);
pump(120);

const offers = measure.offers();
ok(offers.length > 0, `${offers.length} measurements are offered: ` +
   offers.map((o) => o.filter).join(' '));
ok(offers.every((o) => !!bro.ffmpeg.filters.find((f) => f.name === o.filter)),
   "and every one of them is a filter this build's libavfilter actually has");

const cropBtn = q('[data-measure="cropdetect"]');
ok(!!cropBtn, 'Crop is offered in the drawer');
cropBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
pump(120);

const inserted = overlay.inserts().filter((r) => r.filter === 'cropdetect');
ok(inserted.length === 1, 'clicking it puts one cropdetect on the graph');
ok(inserted[0].anchor === 'composite/after-overlay',
   `at the whole picture, by name rather than by position (${inserted[0].anchor})`);
ok(inserted[0].params.limit === '24' && inserted[0].params.reset === '1',
   'carrying the options that make it answer at all');

// It is an ordinary node, so the graph the render will run has it in it.
const printed = A.filtergraph(A.exporter.buildSpec(), A.exporter.specSources(),
                              { overlay: overlay.current() });
ok(printed.ok && printed.chains.join(';').indexOf('cropdetect') >= 0,
   'and the filtergraph the command bar prints has it in');
ok(q('[data-measure="cropdetect"]').className.indexOf('on') >= 0,
   'the offer says so rather than offering to add a second one');

// ── running it ─────────────────────────────────────────────────────────────
//
// A render whose output is thrown away: the graph, the range, `-f null -`.
// Rendering a file nobody wanted in order to find out what a filter thought of
// it is most of a reason not to bother.

console.log('\nmeasuring is a render that keeps nothing');
const P = A.exporter.currentSettings();
// A square output canvas for a landscape clip, which is a picture with black
// bars top and bottom — so cropdetect has something real to find and the verb
// below has something real to apply. The *project* canvas is what a clip is
// placed in, so that is what has to be square: the output size only rescales
// what the compositor produced.
A.project.width = 320; A.project.height = 320;
A.viewer.refreshAll();
P.width = 320; P.height = 320;
P.rangeIn = 0; P.rangeOut = 1.0;
A.shell.goTo('encode');
pump(200);
report.setOpen(true);
pump(120);

const now = q('[data-f="measure-now"]');
ok(!!now, 'and offers to run it there and then');
now.dispatchEvent(new MouseEvent('click', { bubbles: true }));
// Not `isRunning()` a moment later: a second at 320×180 through an encoder
// that encodes nothing is over in less time than a frame of this test, which
// is the point of it. What is asserted is that it went through the one slot —
// the poll taken as it started names the file it would have written.
ok(A.exporter.lastStatus() && /measure/.test(A.exporter.lastStatus().path || ''),
   `which takes the one render slot like anything else ` +
   `(${A.exporter.lastStatus() && A.exporter.lastStatus().path})`);

waitFor('the measurement to finish', () => !A.exporter.isRunning());
pump(300);

const series = report.seriesList().filter((s) => s.key.indexOf('lavfi.cropdetect.') === 0);
ok(series.length > 0, `${series.length} cropdetect series arrived: ` +
   series.map((s) => s.key.replace('lavfi.cropdetect.', '')).join(' '));
const w = report.seriesFor('lavfi.cropdetect.w');
ok(!!w && w.points.length > 1, `sampled over the render (${w ? w.points.length : 0} points)`);
ok(w && w.points[0].t >= -1e-6 && w.points[w.points.length - 1].t <= 1.5,
   `on the render's own clock (${w.points[0].t.toFixed(2)}–` +
   `${w.points[w.points.length - 1].t.toFixed(2)}s)`);

// ── a plot, not a sparkline ────────────────────────────────────────────────

console.log('\nwhat came back is drawn as a plot');
report.plotSeries('lavfi.cropdetect.w');
report.plotSeries('lavfi.cropdetect.h');
pump(160);

const plot = q('.rep-plot-c');
ok(!!plot, 'picking a series opens a plot');
ok(plot.width > 100 && plot.height > 60,
   `with room to be read (${plot.width}×${plot.height})`);
const keys = qq('.rep-plot-legend .rep-key');
ok(keys.length === 2, `a legend is present for two series (${keys.length} keys)`);
const swatches = Array.from(qq('.rep-plot-legend .rep-swatch'))
    .map((s) => s.style.background);
ok(swatches.length === 2 && swatches[0] !== swatches[1],
   `each carrying its own colour (${swatches.join(' ')})`);

// Colour follows the series, never its position in the list — a reader who has
// learnt that one line is orange must not have that taken away by unpicking a
// different one.
const kept = swatches[0];
report.plotSeries('lavfi.cropdetect.w', false);
pump(120);
const after = Array.from(qq('.rep-plot-legend .rep-swatch')).map((s) => s.style.background);
ok(after.length === 1 && after[0] === kept,
   `taking one off does not repaint the other (${kept} → ${after[0]})`);
report.plotSeries('lavfi.cropdetect.w');
pump(120);

// A row is the way in as well, since that is the one a person clicks.
const row = q('[data-series="lavfi.cropdetect.x"]');
if (row) {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pump(120);
    ok(report.plotted_().indexOf('lavfi.cropdetect.x') >= 0,
       'and clicking a row in the list puts it on the plot too');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pump(80);
}
screenshot('out/measure-plot.png');

// ── the verb ───────────────────────────────────────────────────────────────
//
// The whole point. A measurement that can only be read is a number; one that
// can be applied is a tool.

console.log('\nwhat it found can be applied');
const found = report.findings();
const crop = found.find((f) => f.filter === 'cropdetect');
ok(!!crop, 'cropdetect is read as something that can be acted on');
ok(!!crop.raw && crop.raw.indexOf('crop=') >= 0,
   `and the line it was read out of travels with it (${crop.raw})`);

if (crop.ok && crop.verb) {
    const button = q('[data-apply="cropdetect"]');
    ok(!!button, `the offer is a button: “${button && button.textContent}”`);
    const cropsBefore = overlay.inserts().filter((r) => r.filter === 'crop').length;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pump(160);
    const crops = overlay.inserts().filter((r) => r.filter === 'crop');
    ok(crops.length === cropsBefore + 1, 'applying it puts a crop on the graph');
    const applied = crops[crops.length - 1];
    ok(applied.anchor === inserted[0].anchor,
       'at the point the measurement was taken at, not somewhere else');
    // The four numbers are cropdetect's own, unchanged — which is what makes
    // the raw line and the applied value the same characters, with nothing to
    // compare and nothing to have been rewritten on the way.
    ok(crop.raw.indexOf(`crop=${applied.pos.join(':')}`) === 0,
       `carrying exactly what cropdetect printed (${applied.pos.join(':')})`);
    const g2 = A.renderGraph(A.exporter.buildSpec(), A.exporter.specSources(),
                             { overlay: overlay.current() });
    ok(g2.ok && g2.filterGraph.indexOf(`crop=${applied.pos.join(':')}`) >= 0,
       'and the render that follows goes through it');
    overlay.removeInsert(applied.id);
} else {
    // A source with no bars is a real answer, and the honest one for a fixture
    // that fills its frame. It has to be *said*, not left as a missing button.
    ok(!q('[data-apply="cropdetect"]'),
       `nothing is offered, because ${crop.reason}`);
    ok(!!crop.reason && crop.reason.length > 20, 'and the reason is a sentence');
}

// ── a refusal, rather than a silent rewrite ────────────────────────────────
//
// Every one of these is a pure reading of what the channel holds, so the
// awkward cases can be stated exactly instead of being waited for.

console.log('\na measurement that cannot be trusted is refused');
const bigger = { width: 1920, height: 1080 };

/// A hand-made channel: a Map of series and a list of messages, exactly the
/// shape `report.js` keeps.
function chan(points, messages) {
    const map = new Map();
    for (const key of Object.keys(points)) {
        const list = points[key];
        map.set(key, {
            key, stream: 'video', numeric: true, count: list.length,
            min: Math.min(...list.map((p) => p[1])),
            max: Math.max(...list.map((p) => p[1])),
            last: String(list[list.length - 1][1]), job: 1,
            points: list.map(([t, v]) => ({ t, v, raw: String(v), job: 1 })),
        });
    }
    return { series: map, messages: messages || [], job: 1,
             width: bigger.width, height: bigger.height };
}

/// A series of `[t, v]`, from a list of values one per sample.
const at = (vals) => vals.map((v, i) => [i * 0.1, v]);
const flat = (n, v) => at(new Array(n).fill(v));

{
    // Still widening in the last third, which is what a cropdetect that has not
    // seen the whole shot looks like: eight hundred rows for most of it and
    // nine hundred at the very end.
    const ctx = chan({
        'lavfi.cropdetect.w': flat(12, 1920),
        'lavfi.cropdetect.h': at([800, 800, 800, 800, 800, 800, 800, 800, 800, 800, 900, 900]),
        'lavfi.cropdetect.x': flat(12, 0),
        'lavfi.cropdetect.y': at([140, 140, 140, 140, 140, 140, 140, 140, 140, 140, 90, 90]),
    }, [{ source: 'Parsed_cropdetect_0', job: 1, level: 'info',
          text: 'x1:0 x2:1919 y1:90 y2:989 w:1920 h:900 x:0 y:90 crop=1920:900:0:90' }]);
    const f = measure.findings(ctx).find((x) => x.filter === 'cropdetect');
    ok(f && !f.ok, 'a cropdetect still finding letterbox in the last third is refused');
    ok(f && /has not settled/.test(f.reason) && /800/.test(f.reason) && /900/.test(f.reason),
       `naming both answers rather than picking one: “${f && f.reason}”`);
}

{
    // The picture reaches every edge. Read, and nothing to do about it — which
    // is an answer and is said in the same voice rather than as a failure.
    const ctx = chan({
        'lavfi.cropdetect.w': flat(12, 1920), 'lavfi.cropdetect.h': flat(12, 1080),
        'lavfi.cropdetect.x': flat(12, 0), 'lavfi.cropdetect.y': flat(12, 0),
    }, []);
    const f = measure.findings(ctx).find((x) => x.filter === 'cropdetect');
    ok(f && f.ok && !f.verb && /nothing to crop/.test(f.reason || ''),
       'a picture that reaches every edge is offered no crop, and says why');
}

{
    // ebur128 prints the summary loudnorm is told at end of input and nowhere
    // else, so a render that is still going has half a measurement. Applying it
    // would be normalising to a number that is going to change.
    const ctx = chan({ 'lavfi.r128.I': [[0, -20.5], [0.5, -21.2]] }, []);
    const f = measure.findings(ctx).find((x) => x.filter === 'ebur128');
    ok(f && !f.ok, 'an ebur128 that has not printed its summary is refused');
    ok(f && /-21\.2|summary/.test(f.reason), `and says what it is waiting for: “${f.reason}”`);
}

{
    // And with the summary, the verb — ffmpeg's own two-pass loudness
    // normalisation, which is measure with one filter and apply with another
    // that is told what the first found.
    const summary = [
        'Summary:', '', '  Integrated loudness:', '    I:         -23.5 LUFS',
        '    Threshold: -33.9 LUFS', '', '  Loudness range:', '    LRA:         6.2 LU',
        '    Threshold: -34.0 LUFS', '', '  True peak:', '    Peak:       -1.2 dBFS',
    ].join('\n');
    const ctx = chan({ 'lavfi.r128.I': [[0, -23.5], [1, -23.5]] },
                     [{ source: 'Parsed_ebur128_0', job: 1, level: 'info', text: summary }]);
    const f = measure.findings(ctx).find((x) => x.filter === 'ebur128');
    ok(f && f.ok && !!f.verb, `the summary is read as something to act on: “${f.detail}”`);
    ok(f.raw.indexOf('-23.5') >= 0 && f.raw.indexOf('-1.2') >= 0,
       `with the numbers it was read out of shown (${f.raw})`);
    const before2 = overlay.inserts().length;
    f.verb.apply({});
    const ln = overlay.inserts().find((r) => r.filter === 'loudnorm');
    ok(overlay.inserts().length === before2 + 1 && !!ln,
       'applying it puts loudnorm on the graph');
    ok(ln.params.measured_I === '-23.5' && ln.params.measured_LRA === '6.2' &&
       ln.params.measured_TP === '-1.2' && ln.params.measured_thresh === '-33.9',
       'told every one of the four numbers ebur128 measured, unchanged');
    ok(ln.params.I === '-16' && ln.params.linear === 'true',
       `and a target to reach (${ln.params.I} LUFS, linear)`);
    overlay.removeInsert(ln.id);
}

// ── cut points ─────────────────────────────────────────────────────────────
//
// A span has two ends and an end is a cut, which is the thing an edit can be
// made to agree with. The parse is stated exactly; the cut is made on the real
// timeline, through the real split, and counted.

console.log('\nblack and silence become cuts on the timeline');
{
    const ctx = chan({}, [
        { source: 'Parsed_blackdetect_0', job: 1, level: 'info',
          text: 'black_start:0.4 black_end:0.7 black_duration:0.3' },
        { source: 'Parsed_blackdetect_0', job: 1, level: 'info',
          text: 'black_start:1.2 black_end:1.5 black_duration:0.3' },
    ]);
    const f = measure.findings(ctx).find((x) => x.filter === 'blackdetect');
    ok(f && f.ok && f.spans.length === 2,
       `two stretches of black are read out of what it printed (${f && f.detail})`);
    ok(f.verb.label.indexOf('4 points') >= 0,
       `and become four cut points, not two: “${f.verb.label}”`);

    A.setPlayhead(0);
    const clipsBefore = A.project.clips.length;
    const made = f.verb.apply({ splitAt: (t) => A.splitAt(t, false), flash: () => {} });
    pump(200);
    ok(made > 0 && A.project.clips.length === clipsBefore + made,
       `applying it cuts the timeline where the black was (${clipsBefore} → ` +
       `${A.project.clips.length} clips)`);
    const edges = A.project.clips.map((c) => Math.round(c.start * 100) / 100);
    ok(edges.indexOf(0.4) >= 0 && edges.indexOf(0.7) >= 0,
       `at both ends of each stretch (clips start at ${edges.join(', ')})`);
}

{
    const ctx = chan({}, [{ source: 'Parsed_silencedetect_0', job: 1, level: 'info',
                            text: 'silence_start: 2.5' },
                          { source: 'Parsed_silencedetect_0', job: 1, level: 'info',
                            text: 'silence_end: 3.5 | silence_duration: 1' }]);
    const f = measure.findings(ctx).find((x) => x.filter === 'silencedetect');
    ok(f && f.ok && f.spans.length >= 1,
       `silencedetect's two half-lines join into one span (${f && f.detail})`);
}

{
    const ctx = chan({}, [{ source: 'Parsed_blackdetect_0', job: 1, level: 'info',
                            text: 'blackdetect had nothing to say' }]);
    const f = measure.findings(ctx).find((x) => x.filter === 'blackdetect');
    ok(f && !f.ok && /found nothing/.test(f.reason),
       'and finding nothing is an answer, said as one');
}

// ── what the settings cost, as a number ────────────────────────────────────
//
// The A/B stage renders the same seconds twice, at the settings and losslessly.
// That is a distorted input and a reference sitting on disk with nothing else
// to do, which is exactly what every objective quality metric is defined on.

console.log('\nthe A/B comparison is measured, not only looked at');
A.shell.goTo('encode');
pump(200);
const metrics = A.exporter.qualityMetrics();
ok(metrics.length > 0,
   `this build can measure with ${metrics.map((m) => m.filter).join(', ')}`);

// Cleared, so that the comparison below is of these settings and not of
// whatever the measurement render above left in the channel.
overlay.clear();
pump(80);
A.project.width = 640; A.project.height = 360;
A.viewer.refreshAll();
P.width = 320; P.height = 180; P.previewLength = 1; P.quality = 34;
P.rangeIn = 0; P.rangeOut = 0;
A.exporter.previewState().at = 0;
A.exporter.redraw();
pump(80);
A.exporter.startPreview();
waitFor('both halves of the preview',
        () => A.exporter.previewState().candReady || A.exporter.previewState().error, 120000);
ok(!A.exporter.previewState().error,
   `both halves rendered (${A.exporter.previewState().error || 'no error'})`);

waitFor('the comparison', () => {
    const s = A.exporter.previewState();
    return (s.quality && s.quality.length) || (!s.measuring && !A.exporter.isRunning() &&
                                               s.quality !== null);
}, 120000);
pump(200);

const scored = A.exporter.previewState().quality;
ok(scored && scored.length === metrics.length,
   `and were compared: ${(scored || []).map((m) => `${m.label} ${m.text}`).join(' · ')}`);
const p = (scored || []).find((m) => m.id === 'psnr');
ok(p && p.value > 10 && p.value < 99,
   `PSNR is a real measurement of the two files (${p && p.value.toFixed(2)} dB)`);
ok(!!report.seriesFor('lavfi.psnr.psnr_avg'),
   'and it arrived through the same channel cropdetect uses, as a series');

pump(200);
ok(el('ex-pv-stats').textContent.indexOf('PSNR') >= 0,
   'the number is under the wipe, where the settings are being chosen');
screenshot('out/measure-quality.png');

// A worse encode has to score worse — the one check that says the number is
// about the settings rather than about the plumbing.
const good = p.value;
P.quality = 18;
A.exporter.redraw();
A.exporter.previewState().candReady = false;
A.exporter.previewState().quality = null;
pump(60);
A.exporter.startPreview();
waitFor('the better candidate',
        () => A.exporter.previewState().candReady || A.exporter.previewState().error, 120000);
waitFor('its comparison', () => {
    const s = A.exporter.previewState();
    return s.quality && s.quality.length;
}, 120000);
const better = A.exporter.previewState().quality.find((m) => m.id === 'psnr');
ok(better.value > good,
   `and a better setting measures better (crf 34 → ${good.toFixed(2)} dB, ` +
   `crf 18 → ${better.value.toFixed(2)} dB)`);

console.log(`\n${checks} checks, all passed`);
