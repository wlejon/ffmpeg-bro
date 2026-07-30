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

// ── and stops being offered when it stops being true ───────────────────────
//
// A finding is about the render it was measured during. Move a clip and the
// numbers stay on the screen describing an edit that no longer exists — four
// plausible rectangles about a picture nobody is looking at any more. This
// file's own rule is that a measurement acted on when it should not be is
// worse than one that could not be acted on at all, because it looks like it
// worked, so the offer goes and the sentence stays.

console.log('\na finding stops being offered when the edit moves under it');
{
    // The section above applied a crop and then took it off again, and applying
    // one is itself a change to the graph — so the drawer is redrawn here to
    // read the state as it now is rather than as it was mid-experiment. That
    // the apply marked its own measurement stale is the mechanism working:
    // a `cropdetect` result applied is a graph with a `crop` in it, and the
    // bars it found are no longer there to find.
    A.exporter.redraw();
    report.draw();
    pump(120);
    ok(!q('.rep-stale'), 'nothing is marked stale while the edit is the one that was measured');

    const clip = A.project.clips[0];
    const wasStart = clip.start;
    clip.start = wasStart + 1.5;
    A.exporter.redraw();
    report.draw();
    pump(120);

    ok(!!q('.rep-stale'), 'moving a clip marks the report as measured before the last edit');
    ok(!q('[data-apply="cropdetect"]'),
       'and the offer to act on it is withdrawn rather than left looking current');
    const said = Array.from(qq('.rep-find-no')).map((n) => n.textContent).join(' | ');
    ok(/edit has changed/.test(said),
       `with the reason on the card (${said.slice(0, 120)})`);
    ok(!!q('.rep-find-raw'),
       'while the line it was read out of stays, because it is still true of that render');

    // Put it back: the same edit is the same subject, and a marker that did not
    // clear would be one nobody could ever act on.
    clip.start = wasStart;
    A.exporter.redraw();
    report.draw();
    pump(120);
    ok(!q('.rep-stale'), 'and putting the clip back makes it current again');
}

// ── unless you asked it to measure itself again ─────────────────────────────
//
// The press stays the mechanism and the toggle is the decision: whether a render
// is cheap enough to spend without being asked is a question about somebody's
// machine. So what is checked here is the toggle's two states and the three things
// the automatic path must never do — take the one job slot from something else,
// queue behind it and fire when the reason has passed, or loop.

console.log('\na finding can measure itself again, if you asked it to');
{
    report.setOpen(true);
    // Whatever a previous run of this suite left under the key, since the
    // workspace outlives the process.
    measure.setAutoRemeasure(false);
    report.draw();
    pump(120);

    const toggle = q('[data-f="remeasure"]');
    ok(!!toggle, 'the drawer offers the toggle');
    ok(toggle.className.indexOf('on') < 0 && !measure.autoRemeasure(),
       'off, because spending a render unasked is a decision about somebody’s machine');

    // Remembered on the press, under its own key rather than with the encoder
    // settings — see the block at the bottom of ui/measure.js for why.
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pump(80);
    ok(measure.autoRemeasure(), 'clicking it turns it on');
    ok(q('[data-f="remeasure"]').className.indexOf('on') >= 0, 'and the button says so');
    const stored = JSON.parse(localStorage.getItem('ffmpeg-bro.measure') || '{}');
    ok(stored.remeasure === true,
       `written to the workspace under a key of its own (${JSON.stringify(stored)})`);
    // And nothing else went with it, which is the hazard: the export blob belongs
    // to the muxer it was written against.
    ok(!('container' in stored) && !('extraVideo' in stored),
       'and nothing else went with it — this is not the encode side’s blob');

    // A clip's level, which is in a render's subject — `spec.clips` carries it —
    // and is the one thing in there that `cropdetect` cannot see. What is wanted
    // here is an edit that has *moved*: moving the clip would take it out of the
    // range and leave the re-measure nothing to measure, and cropping or dimming
    // the picture would change cropdetect's answer rather than the question.
    const clip = A.project.clips[0];
    const wasVolume = clip.volume;
    const actionable = () => report.findings().some((f) => f.ok && f.verb);

    if (!actionable()) {
        // A fixture whose picture reaches every edge has nothing to act on, so
        // there is nothing a re-measure would restore. Said rather than failed.
        console.log('  (nothing measured here can be acted on — skipped)');
        measure.setAutoRemeasure(false);
    } else {
        // ── it never takes the slot, and never queues ──────────────────────
        clip.volume = 0.5;
        A.changed('edit');
        A.exporter.redraw();
        report.draw();
        pump(120);
        ok(!!q('.rep-stale'), 'the edit moves under the finding');

        const took = A.exporter.startMeasurement();
        ok(took === '', `something else takes the one job slot by hand (${took || 'it did'})`);
        const refused = report.remeasure();
        ok(/slot/.test(refused),
           `and the automatic one is refused rather than queued (${refused})`);
        report.draw();
        pump(60);
        ok(!!q('.rep-auto-note'), 'with the drawer saying it did not re-measure');
        waitFor('the hand-started render', () => !A.exporter.isRunning());
        pump(400);
        // And nothing fired once the slot came free, which is the whole of "it does
        // not queue": by then the reason for it may have gone.
        const afterHand = report.reportState().lastJob;
        pump(1500);
        ok(report.reportState().lastJob === afterHand,
           'and nothing fires once the slot comes free — a refusal is final, not a queue');

        // ── and it does, when there is a reason and the machine is free ────
        clip.volume = 0.75;
        A.changed('edit');
        A.exporter.redraw();
        report.draw();
        pump(120);
        ok(!!q('.rep-stale'), 'a fresh edit is a fresh reason');
        const before = report.reportState().lastJob;
        const started = report.remeasure();
        ok(started === '', `and the re-measure starts (${started || 'it did'})`);
        waitFor('the automatic measurement', () => !A.exporter.isRunning(), 120000);
        pump(500);
        report.draw();
        pump(120);
        ok(report.reportState().lastJob !== before,
           `which is a render of its own like any other (${before} → ${
               report.reportState().lastJob})`);
        ok(!q('.rep-stale'),
           'and the finding describes the edit again, without a press');
        // What it now *concludes* is cropdetect's business and not this suite's —
        // the render it just did is a different one, and "no bars in this one" is a
        // real answer. What is asserted is that the answer is a fresh one rather
        // than the withdrawn offer and the staleness sentence.
        const fresh = report.findings().find((x) => x.filter === 'cropdetect');
        ok(!!fresh && (!!fresh.verb || !!fresh.reason),
           `with an answer about the render that has just happened (${
               fresh && (fresh.detail || fresh.reason || '').slice(0, 70)})`);

        // ── and it cannot loop ────────────────────────────────────────────
        //
        // Nothing in a measurement touches the edit, so the ordinary path never
        // reaches this; what is asserted is the backstop, which is one attempt per
        // edit whatever the findings look like afterwards.
        const again = report.remeasure();
        ok(again !== '', `a second attempt for the same edit is refused (${again})`);
        const held = report.reportState().lastJob;
        pump(1500);
        ok(report.reportState().lastJob === held,
           'and a frame loop left running does not start another');

        clip.volume = wasVolume;
        A.changed('edit');
        measure.setAutoRemeasure(false);
        report.draw();
        pump(200);
        ok(!measure.autoRemeasure(), 'and it can be turned off again');
    }

    // Left off, because the workspace outlives the process and a suite that armed
    // it would arm it for every run after this one.
    measure.setAutoRemeasure(false);
    // And left quiet as well as off. The section after this one deliberately races
    // the node previews for the one slot, and a measurement still running from here
    // would be a third contender in it.
    waitFor('the machine to go idle again', () => !A.exporter.isRunning());
    pump(200);
}

// ── part of a graph ────────────────────────────────────────────────────────
//
// `Measure now` runs the whole thing. A `cropdetect` on one clip's decoded
// picture does not need the whole thing: it needs that clip's file and the
// filters between the two, and everything else — the other clips, the filters
// after it, the composite, the mix — is decoded, run and thrown away so that
// four numbers can be printed.
//
// So a node can be measured *to*, which is the pair of the ▶ on its card: the
// preview answers "what comes out of here" with a picture and this answers it
// with a number. The proof that it is the same claim and not a cheaper
// lookalike is that the cut is printed from the same model by the same
// `print()` — and the proof that it is worth doing is in the two counts.

console.log('\nmeasuring stops where you say it stops');
{
    // Only one cropdetect in the graph at a time, or two points report into one
    // finding and neither number means anything.
    for (const rec of overlay.inserts().filter((r) => r.filter === 'cropdetect'))
        overlay.removeInsert(rec.id);
    const spec0 = A.exporter.buildSpec();
    const d0 = A.graph.derive(spec0, A.exporter.specSources(), { overlay: overlay.current() });
    const point = d0.points.find((p) => /after-decode$/.test(p.id));
    ok(!!point, `the clip's decoded picture is a point something can be put at (${point && point.id})`);
    const at = overlay.insert(point.id, 'cropdetect',
                              { params: { limit: '24', round: '2', reset: '1' } });

    ok(A.shell.goTo('graph'), 'the Graph stage opens');
    pump(300);
    A.graph.draw();
    // The node previews fill in as the stage settles and they hold the one job
    // slot while they do. Waiting here is not what is under test — the queue
    // that makes the button work anyway is asserted below.
    waitFor('the node previews to settle',
            () => bro.ffmpeg.render.poll().state !== 'running', 120000);
    pump(300);

    const g = A.graph.current();
    const node = g && g.nodes.find((n) => n.filter === 'cropdetect');
    ok(!!node, 'the measuring filter is a node on the graph like any other');

    const cut = A.graph.measureGraph(g, node);
    ok(cut.ok, `the graph can be cut off there (${cut.reason || 'ok'})`);
    ok(cut.nodes < cut.of,
       `and what is left is part of it — ${cut.nodes} nodes of ${cut.of}`);
    ok(cut.filterGraph.indexOf('cropdetect') >= 0,
       `with the measurement in it (${cut.filterGraph})`);
    ok(cut.filterGraph.indexOf('overlay') < 0,
       'and nothing after it: the composite this clip is laid into is not built');
    // The saving that matters is the one on the *files*: an input nothing in
    // the cut reads is an input nothing opens, seeks or decodes.
    ok(cut.filterInputs.length === 1 && cut.filterInputs[0].stream === 'v',
       `reading one pad — the picture it measures and not the sound beside it ` +
       `(${cut.filterInputs.map((i) => i.label).join(' ')})`);
    // A preview of this node would end in `scale`, because a card is 320 pixels
    // wide. A measurement must not: four numbers in a card's pixels are four
    // plausible numbers about a picture nobody is rendering.
    ok(!/scale=/.test(cut.filterGraph),
       'and at the node’s own size, because a number in pixels is about a picture');

    // The gesture: select the node, press the button on it.
    const card = document.querySelector(`#gr-nodes [data-key="${at.id}"]`);
    ok(!!card, 'the node has a card on the stage');
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    pump(200);
    const button = document.querySelector('#gr-panel [data-f="measure-to"]');
    ok(!!button, `and its panel offers to measure to it (“${button && button.textContent}”)`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pump(80);

    const said = el('gr-note') ? el('gr-note').textContent : '';
    ok(/Measuring \d+ of \d+ nodes/.test(said),
       `which says how much of the graph it is over (${said})`);

    waitFor('the partial measurement', () => !A.exporter.isRunning());
    pump(400);
    const st = A.exporter.lastStatus();
    ok(st && st.state === 'done' && /measure/.test(st.path || ''),
       `it goes through the one slot and keeps nothing (${st && st.state})`);

    // And the number is about the point it was taken at. The composite is
    // 320×320 and the source is not, so a `cropdetect` reading the source's own
    // width is the whole claim: this is the picture *at that node*, not the one
    // the render ends with.
    const w = report.seriesFor('lavfi.cropdetect.w');
    const src = (A.project.clips[0].probe && A.project.clips[0].probe.video) || {};
    ok(!!w && w.points.length > 1,
       `cropdetect answered from inside the cut (${w ? w.points.length : 0} points)`);
    if (src.displayWidth)
        ok(w.points[w.points.length - 1].v === src.displayWidth,
           `about the picture at that node — ${w.points[w.points.length - 1].v} wide, ` +
           `which is the source (${src.displayWidth}) and not the ${spec0.width}-wide composite`);

    // A sound pad is measured the same way, and the renderer's rule that a
    // render has a picture in it is satisfied rather than argued with.
    //
    // Re-read rather than reused: the render that just finished redrew the
    // stage, so the graph above is a set of node objects nothing on the screen
    // refers to any more. The button never has that problem — the panel is
    // rebuilt with the graph — and `measureTo` finds a node by key for exactly
    // this reason, but a test naming one has to name it in the graph that is
    // there now.
    const g2 = A.graph.current();
    const sound = g2.nodes.filter((n) => n.kind === 'filter' &&
                                        /^(atrim|asetpts|adelay|amix|volume)$/.test(n.filter));
    if (sound.length) {
        const scut = A.graph.measureGraph(g2, sound[sound.length - 1]);
        ok(scut.ok && scut.audio,
           `a sound pad can be cut at too (${scut.filterGraph || scut.reason})`);
        ok(/color=/.test(scut.filterGraph),
           'with the smallest picture that is not the sound, because a render has one');
        ok(!/showwaves/.test(scut.filterGraph),
           'and no waveform — that is for looking at, and nobody is looking at this');
        ok(A.graph.measureTo(sound[sound.length - 1]) === '',
           'and it runs');
        waitFor('the sound measurement', () => !A.exporter.isRunning());
        pump(300);
        const st2 = A.exporter.lastStatus();
        ok(st2 && st2.state === 'done',
           `to the end (${st2 && (st2.error || st2.state)})`);
    }

    // ── and it waits for the slot rather than losing to a preview ──────────
    //
    // This stage is the one place where something is nearly always rendering:
    // the node previews fill in as the graph settles. A button that came back
    // with "a job is already running" for that reason would be a button that
    // works when you press it twice, which is not a mechanism — so it queues,
    // and the previews stop starting new work while it does.
    {
        const g3 = A.graph.current();
        const mine = g3.nodes.find((n) => n.filter === 'cropdetect');
        ok(A.exporter.startMeasurement() === '',
           'with the whole graph measuring, the one slot is taken');
        el('gr-note').textContent = '';
        ok(A.graph.measureTo(mine) === '',
           'pressing it anyway is not a refusal');
        ok(el('gr-note').textContent === '',
           'and nothing has started — it is waiting for the slot, not racing for it');
        waitFor('the queued measurement to start',
                () => /Measuring/.test(el('gr-note').textContent));
        ok(true, `which it does when the slot comes free (${el('gr-note').textContent})`);
        waitFor('it to finish', () => !A.exporter.isRunning());
        pump(300);
    }

    overlay.removeInsert(at.id);
    A.shell.goTo('encode');
    pump(200);
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
// These filters hang a value on every frame rather than a running total, and
// the reading is asked for in the frame the render reports done — so a number
// combined from one frame means the channel had not been drained when it was
// read, and the score under the wipe is a lottery rather than a measurement.
ok(p && p.frames > 1,
   `over every frame of the comparison rather than one of them (${p && p.frames} frames)`);
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
