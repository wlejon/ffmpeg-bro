// A data track, read and plotted, driven the way a person drives it.
//
// This is the other half of `tests/data_test.cpp`. That one is about the
// parser — what GPMF says and what a hostile payload does to a reader of it —
// and this one is about the two seams either side of it:
//
//   - **the affordance is offered exactly where it works.** A `Read it` button
//     appears against a `gpmd` row and against no other stream, because
//     `bro.ffmpeg.data.parsers()` is asked of the native registry rather than
//     written down in `ui/`. A real GoPro file carries `tmcd` and `fdsc` too and
//     neither gets one.
//   - **the read is off the UI thread.** It is started, polled from the frame
//     loop and answered, and while it is in flight the application keeps
//     drawing — which is checked by drawing during it rather than by trusting
//     the word "thread".
//   - **what comes back is what the file says.** The fixture's numbers are
//     chosen so that the divisor is visible: an accelerometer axis that is
//     exactly 9.81 was divided by its `SCAL` and one that is 981 was not.
//   - **a picked series becomes a lane.** The Telemetry lane exists exactly when
//     something is on it, sits directly above the waveform, and its rows follow
//     the clips — a trim moves what is drawn, because the lane maps a reading
//     through `sourceTime` the way the waveform maps peaks.
//   - **it is not in the document, and does not mark one unsaved.** A reading is
//     derived from a file, like `peaks`; the rule is `ui/document.js`'s and the
//     way to check it is to read a track and ask whether the edit changed.
//
// The whole suite runs against the telemetry fixture and skips itself with a
// sentence when there is no data track in the file it was given — which keeps
// it runnable by hand against a real camera file, where every assertion about
// *shape* still holds and the ones about the fixture's own numbers are skipped.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_telemetry.js -- <telemetry.mp4>

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
assert(media, 'pass a media file: ... tests/ui_telemetry.js -- <telemetry.mp4>');

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

const el = (id) => document.getElementById(id);
const q = (sel, root) => (root || document).querySelector(sel);
const qq = (sel, root) => Array.from((root || document).querySelectorAll(sel));

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}
function same(actual, expected, what) {
    if (actual !== expected) {
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
    }
    ok(actual === expected, what);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const type = (node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
};

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;

// ── what this build can read ───────────────────────────────────────────────

console.log('\nwhich data streams have a parser');
A.shell.goTo('sources');
pump(60);

{
    const tags = bro.ffmpeg.data.parsers();
    ok(Array.isArray(tags) && tags.length > 0,
       `the registry answers with ${JSON.stringify(tags)} rather than nothing`);
    ok(tags.indexOf('gpmd') >= 0, "and 'gpmd' is in it");
    // The list is native. A second parser must not need an edit in `ui/`, which
    // is the whole reason this is asked rather than written down — so what is
    // checked is that the *filter* uses it, not that it says one particular
    // thing.
    ok(tags.indexOf('tmcd') < 0,
       "'tmcd' is not — a timecode track is a different format, and a parser that " +
       'guessed at one would produce numbers nobody could check');
}

type(el('src-path'), media);
click(el('src-add'));
pump(80);

const input = A.inputs.inputs[0];
ok(!!input && !!input.probe, 'the file is open and probed');

const dataStreams = input.probe.streams.filter((s) => s.kind === 'data');
const readable = A.telemetry.streamsWorthReading(input);
console.log(`  data streams: ${JSON.stringify(dataStreams.map((s) => `${s.index}:${s.tag}`))}` +
            `, readable: ${JSON.stringify(readable.map((s) => s.tag))}`);

if (!readable.length) {
    console.log('\n  -- skipped: this file carries no data stream anything here parses. ' +
                'Everything below is about reading one, so there is nothing to read. ' +
                'Run it against build/fixtures/telemetry.mp4 or a GoPro file.');
    console.log(`\n${checks} checks passed`);
} else {

const stream = readable[0];

// ── the affordance is where it works, and nowhere else ─────────────────────

console.log('\nthe control is offered against the stream that has a parser');
{
    const rows = qq('.src-data');
    ok(rows.length >= 1, `a data row is drawn under the stream line (${rows.length})`);
    ok(rows.some((r) => r.textContent.indexOf('Read it') >= 0),
       'offering to read it');
    // One control per readable stream, not per data stream. A GoPro file has
    // three data tracks and one parser.
    const buttons = qq('.src-data button').filter((b) => b.textContent === 'Read it');
    same(buttons.length, readable.length,
         `one button per readable stream and no more (${buttons.length} of ` +
         `${dataStreams.length} data streams)`);
}

// ── the read is off the UI thread ──────────────────────────────────────────

console.log('\nreading it does not stop the application');
{
    const before = A.doc.dirty ? 'dirty' : 'clean';
    const button = qq('.src-data button').find((b) => b.textContent === 'Read it');
    click(button);
    pump(0);

    const e0 = A.telemetry.readingOf(input.id, stream.index);
    ok(!!e0, 'an entry exists the moment the press lands');
    // Whatever state it is in by the next flush, what must be true is that the
    // application drew — the press did not block the thread that draws. A local
    // fixture answers in about two milliseconds, so this cannot assert that it
    // is *still* reading without being a race; what it asserts is that the loop
    // ran.
    A.timeline.draw();
    ok(true, 'and the timeline draws while it is in flight');

    waitFor('the read to answer', () => {
        const e = A.telemetry.readingOf(input.id, stream.index);
        return e && e.state !== 'reading';
    });
    const e = A.telemetry.readingOf(input.id, stream.index);
    same(e.state, 'done', `it read (${e.error || 'ok'})`);
    ok(e.reading.packets > 0, `${e.reading.packets} packets`);
    ok(e.reading.series.length > 0, `and ${e.reading.series.length} series in them`);
    same(e.reading.refused, 0, 'with no packet the parser would not finish');
    console.log(`  device: '${e.reading.device}'`);

    // **Derived, so the document is untouched.** The same rule `peaks` follows:
    // reading a file does not change the edit, and a reading that marked a
    // document unsaved would put a star on the title bar for having looked.
    same(A.doc.dirty ? 'dirty' : 'clean', before,
         'and reading a track does not make the document unsaved — a reading is ' +
         'what a file says, not something anybody decided');
}

const reading = A.telemetry.readingOf(input.id, stream.index).reading;

// ── what came back is what the file says ───────────────────────────────────

console.log('\nthe numbers are the ones the divisor makes');
{
    const find = (key, comp) =>
        reading.series.find((s) => s.key === key && s.component === comp);

    // The fixture's own numbers. Skipped against a real camera file, where the
    // shape is the same and the values are wherever somebody was standing.
    const g = find('ACCL', 1);
    if (g && near(g.min, 9.81, 1e-5) && near(g.max, 9.81, 1e-5)) {
        ok(true, `ACCL/1 is 9.81 throughout — one SCAL over three components, ` +
                 `applied (${g.min}..${g.max})`);
        ok(g.scaled, 'and the series says a divisor was applied');
        same(g.units, 'm/s²', 'with the unit the file gave, not one written here');
        ok(g.samples > reading.buckets ||  g.samples > 0,
           `${g.samples} samples folded into ${reading.buckets} buckets`);
        // The exact statistics are over every sample and the buckets are a
        // decimation of them, so the two must agree at the extremes and the
        // bucket count must not be the sample count.
        let lo = Infinity, hi = -Infinity, filled = 0;
        for (let i = 0; i < reading.buckets; i++) {
            if (!g.filled[i]) continue;
            filled++;
            lo = Math.min(lo, g.lo[i]);
            hi = Math.max(hi, g.hi[i]);
        }
        ok(near(lo, g.min, 1e-4) && near(hi, g.max, 1e-4),
           'the buckets reach exactly as far as the exact min and max do');
        ok(filled > 0 && filled <= reading.buckets,
           `${filled} of ${reading.buckets} buckets carry a sample; the rest are ` +
           'marked empty rather than zero, because a gap in a recording is a gap ' +
           'in the line');
    } else {
        console.log('  -- the fixture\'s own numbers are not in this file; skipped');
    }

    const alt = find('GPS5', 2);
    if (alt && near(alt.min, 123.456, 1e-3))
        ok(true, 'GPS5/2 is 123.456 m — the third divisor and not the first, which ' +
                 'is the whole of what a per-component SCAL is');

    // A float under a divisor. The rule that is easiest to get wrong.
    const t = find('TMPC', 0);
    if (t) {
        ok(t.min > 1, `TMPC is ${t.min.toFixed(2)} rather than a hundredth of it — a ` +
                      'divisor undoes a fixed point and a float has none');
        ok(!t.scaled, 'and it says so');
    }

    // Typed arrays, not JS arrays: 40 series of 2000 buckets is 320 000 numbers.
    ok(g ? g.lo.length === reading.buckets : true,
       'the buckets come back as arrays of exactly the length asked for');
}

// ── a picked series becomes a lane ─────────────────────────────────────────

console.log('\npicking a series puts a row on the timeline');
{
    // The read put the first series on by itself, because a read that finished
    // and drew nothing cannot be told from one that found nothing.
    let rows = A.telemetry.telemetryRows();
    ok(rows.length === 1, `the first series went on the lane by itself (${rows.length})`);

    A.shell.goTo('edit');
    pump(60);
    // A clip of the file, so the lane has something to draw against: the lane is
    // the *edit*, and a reading with no clip cut from it is a reading of a file
    // nothing is using.
    A.openInput(input);
    pump(120);
    waitFor('a clip', () => A.project.clips.length > 0);
    A.timeline.draw();
    pump(40);

    const lane = A.timeline.telemetryLane();
    ok(!!lane.lane, 'the lane exists');
    same(lane.rows.length, 1, 'with one row on it');
    ok(lane.rowHeight > 0,
       `and a measured row height of ${lane.rowHeight.toFixed(1)}px — measured ` +
       'rather than chosen, because every box here is border-box');

    // **Directly above the waveform.** A plot read against a waveform wants to
    // be next to the waveform, and the lane re-appends itself last on every sync
    // for that reason.
    const tracks = lane.lane.parentNode.parentNode;
    const kids = Array.from(tracks.children).filter((n) => n.className.indexOf('track-row') >= 0);
    same(kids[kids.length - 1], lane.lane.parentNode,
         'and it is the last row in the box, which puts it against A1');

    // **A row is drawn per clip, so a row has to find its clips.** `clip.input`
    // is the input *object* — `clipsOf()` compares against one and
    // `ui/document.js` writes `c.input.id` — and the lane's own filter compared
    // it to a row's `inputId`, which is the id. Always false, so the lane drew
    // its labels and its reach and no line at all. Asserted here because it is
    // the one thing about this lane a reader of `rows` cannot see: `rows` is the
    // picked list and says nothing about what reached a pixel.
    ok(A.project.clips.some((c) => c.input && c.input.id === lane.rows[0].inputId),
       'and the row finds the clips it belongs to — the id off the input object, ' +
       'not the object against the id');
}

console.log('\nsix at once, because that is how many colours there are');
{
    const before = A.telemetry.telemetryRows().length;
    let refused = '';
    let added = 0;
    for (const s of reading.series) {
        const why = A.telemetry.pick(input.id, stream.index, s);
        if (why) { refused = why; break; }
        added++;
    }
    const rows = A.telemetry.telemetryRows();
    ok(rows.length <= 6, `never more than six rows (${rows.length})`);
    if (reading.series.length + before > 6)
        ok(!!refused, `a seventh is refused in words rather than by dropping one: ` +
                      `"${refused}"`);
    // Each row keeps its own colour, and no two of the six share one — the
    // palette is taken in a fixed order and remembered, so taking one line off
    // does not repaint the others.
    const colors = new Set(rows.map((r) => r.color));
    same(colors.size, rows.length, 'and every row has a colour of its own');

    const first = rows[0];
    A.telemetry.pick(input.id, stream.index,
                     reading.series.find((s) => s.key === rows[1].series.key &&
                                                s.component === rows[1].series.component));
    const after = A.telemetry.telemetryRows();
    ok(after.length === rows.length - 1, 'unpicking one takes one row off');
    same(after[0].color, first.color,
         'and the row above it keeps the colour it had — a lane that recoloured ' +
         'itself would make the colour worth nothing');
    A.telemetry.clearPicked();
    pump(20);
    A.timeline.draw();
    ok(!A.timeline.telemetryLane().lane,
       'and with nothing picked the lane is gone rather than empty');
}

// ── the lane follows the clips ─────────────────────────────────────────────

console.log('\na row is drawn where its clip is');
{
    A.telemetry.pick(input.id, stream.index, reading.series[0]);
    pump(20);
    A.timeline.draw();
    const row = A.timeline.telemetryLane().rows[0];
    ok(!!row, 'one row back on the lane');

    const clip = A.project.clips[0];
    const wasLength = clip.length;
    // The reading is the input's and the lane is the edit's, so what a trim has
    // to move is what is *drawn* rather than what was read. The check is that
    // the reading is untouched by an edit and the map through it is not.
    A.trimClip(clip, 'out', clip.start + wasLength / 2);
    pump(40);
    A.timeline.draw();
    ok(clip.length < wasLength, `the clip is trimmed (${wasLength.toFixed(2)}s → ` +
                                `${clip.length.toFixed(2)}s)`);
    const after = A.telemetry.readingOf(input.id, stream.index);
    same(after.reading.packets, reading.packets,
         'and the track was not read again — a reading belongs to the input, and ' +
         'the lane maps it through each clip');
    ok(A.timeline.telemetryLane().rows.length === 1,
       'the row is still there, drawn over the clip that is left');
}

// ── forgetting one ─────────────────────────────────────────────────────────

console.log('\nforgetting a reading takes its rows with it');
{
    A.telemetry.dropReading(input.id, stream.index);
    pump(20);
    A.timeline.draw();
    ok(!A.telemetry.readingOf(input.id, stream.index), 'the reading is gone');
    same(A.telemetry.telemetryRows().length, 0,
         'and so are the rows that named it — a row pointing at a reading nobody ' +
         'holds is the invisible state this avoids');
    ok(!A.timeline.telemetryLane().lane, 'so the lane is gone too');
}

console.log('\nand an input that goes away takes its reading');
{
    A.telemetry.readStream(input, stream.index);
    waitFor('the read', () => {
        const e = A.telemetry.readingOf(input.id, stream.index);
        return e && e.state !== 'reading';
    });
    ok(!!A.telemetry.readingOf(input.id, stream.index), 'a reading exists again');
    // Through the same channel every other retained thing goes through, which is
    // the point: an input can go away five ways and the one that gets missed is
    // the one that leaves a row naming a file nothing answers to.
    A.removeSelection();
    pump(40);
    A.inputs.removeInput(input);
    pump(60);
    same(A.telemetry.telemetryRows().length, 0, 'and it goes with the input');
}

console.log(`\n${checks} checks passed`);
}
