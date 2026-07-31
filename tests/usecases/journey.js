// What a use case costs, measured rather than argued about.
//
// The suites in `tests/` ask whether the application is *correct*: does the spec
// match the edit, does the option reach the encoder, does the file come out. Not
// one of them asks whether a person could have got there, and that is the
// question this directory exists for — because an application can pass every one
// of those and still be unusable, which is the state this one was in.
//
// **A journey is one person with one job.** It records what they had to press,
// which stage each press was on, and two things that are the whole point:
//
//   - `needs` — an **ffmpeg concept** the step cannot be taken without. Not a
//     word the app happens to use; a thing you have to already understand or the
//     control in front of you means nothing. `muxer`, `stream copy`, `keyframe`,
//     `-update 1`. These are what decide who the application is *for*, and the
//     aggregate across every journey is the answer to that question — which is
//     why the vocabulary is fixed (`CONCEPTS`) rather than free text: a tally
//     only means something if two journeys naming the same difficulty spell it
//     the same way.
//   - `hidden` — the step needed something uncovered first: a fold opened, a tab
//     chosen, a picker searched. A control that is present but not visible is
//     not present to somebody who does not already know it is there.
//
// And `friction` for the sentence that does not fit either — what the person
// would have said out loud.
//
// **The outcome is asserted, so this is a real suite and not an essay.** Every
// journey ends in `got()`, which checks the thing the person actually wanted —
// usually by probing the file that came out. A journey whose steps still run but
// whose file is now wrong fails like any other test. That is deliberate: a
// usability record nobody runs rots in a week, and one that fails the build gets
// fixed.
//
// What this cannot measure is whether somebody would have *found* the path at
// all. The step list is the path a person who already knows the application
// takes — the floor, not the ceiling. So a journey's cost is the best case, and
// the real one is worse.

/// The ffmpeg concepts a step can require. Fixed, because the tally across
/// journeys is the deliverable and free text would not add up.
///
/// A concept is on this list when **the control cannot be used correctly without
/// it** — not when the app merely says the word. Choosing a container from a
/// list of names you recognise is not "muxer"; being unable to choose because
/// the question is which muxer will hold your codecs, is.
export const CONCEPTS = {
    muxer: 'a container is a muxer chosen by name, and which one takes your codecs',
    streamCopy: 'packets can be moved without decoding, and what that forbids',
    keyframe: 'a copied stream can only begin at a keyframe',
    streamList: 'a file is a numbered list of streams, not a picture and a sound',
    map: '-map: which input stream becomes which output stream',
    filterGraph: 'a filter graph, its pads, and the order filters run in',
    crf: 'constant quality is a number that is not a file size',
    rateControl: 'CRF vs bitrate vs two-pass, and which answers your question',
    pixelFormat: 'chroma subsampling, and why an odd width is refused',
    imageSequence: 'image2, %04d, and -update 1 for a single picture',
    tee: 'one encode to several muxers, and how its argument is escaped',
    versions: 'two sizes cannot come out of one encoder',
    sub2video: 'a bitmap subtitle is painted into frames; a text one is libass',
    disposition: 'default/forced/comment are bits on a stream',
    fpsMode: 'constant vs variable frame timing',
    lavfi: 'a device is an -f and an -i, not a name in a list',
    codec: 'an encoder is not a container and the two are chosen separately',
};

const bar = (n = 74) => '─'.repeat(n);

/// One person, one job. Everything below is recorded against it.
///
/// `who` and `wants` are the two sentences that make the rest mean something: a
/// step count with no person attached to it is a number nobody can argue with
/// because nobody knows what it was for.
export function journey({ id, title, who, wants, shell }) {
    const steps = [];
    const frictions = [];
    const shortfalls = [];
    const stages = new Set();
    let failures = 0;
    let outcome = null;

    /// One thing the person did.
    ///
    /// `fn` is what actually drives the application, and it runs inside the step
    /// so that a journey reads as the sequence it is rather than as a script with
    /// annotations bolted beside it. A step whose `fn` throws is recorded as the
    /// dead end it is and the journey carries on, because the *rest* of the path
    /// is still worth knowing about — a journey that stopped at the first refusal
    /// would report one problem per run and hide the four behind it.
    function step(label, opts, fn) {
        if (typeof opts === 'function') { fn = opts; opts = {}; }
        opts = opts || {};
        const at = shell ? shell.currentStage() : '';
        const rec = {
            label,
            stage: opts.stage || at,
            needs: [].concat(opts.needs || []),
            hidden: opts.hidden || '',
            failed: false,
        };
        try {
            if (fn) fn();
        } catch (e) {
            rec.failed = true;
            rec.error = String((e && e.message) || e);
            failures++;
        }
        // Taken *after* the press: a step's stage is where it left you when the
        // press was a move along the spine, and where you were otherwise.
        rec.stage = opts.stage || (shell ? shell.currentStage() : rec.stage);
        stages.add(rec.stage);
        steps.push(rec);
        if (opts.friction) frictions.push(opts.friction);
        return rec;
    }

    /// What the person came for, and whether they got it.
    ///
    /// Asserted rather than described — see the note at the top of this file. A
    /// `got` that goes false fails the build, so this is for the part of the
    /// journey that **works today and must keep working**.
    function got(what, cond, detail = '') {
        outcome = { what, ok: !!cond, detail };
        if (!cond) failures++;
        return !!cond;
    }

    /// Something the person wanted and did not get — recorded, printed, and
    /// deliberately **not** a failure.
    ///
    /// The two have to be separable or this suite cannot exist. A journey that
    /// failed the build every time it found a design problem would be deleted
    /// within a week, and one that quietly passed while the person got the wrong
    /// file would be worth nothing. So `got` guards what works and this one is
    /// the work list: it is the difference between "this broke" and "this was
    /// never right", and only the second is what these journeys were written to
    /// find.
    function shortfall(what, why) {
        shortfalls.push({ what, why });
    }

    /// A sentence about the path that is not about one step of it.
    function friction(text) { frictions.push(text); }

    /// The tally, printed, and returned so a runner can add it up.
    function report() {
        const needed = new Set();
        for (const s of steps) for (const n of s.needs) needed.add(n);
        const hidden = steps.filter((s) => s.hidden);

        console.log('');
        console.log(bar());
        console.log(`${id}  ${title}`);
        console.log(bar());
        console.log(`  who    ${who}`);
        console.log(`  wants  ${wants}`);
        console.log('');
        steps.forEach((s, i) => {
            const n = String(i + 1).padStart(2, ' ');
            const stage = (s.stage || '').padEnd(8, ' ');
            console.log(`  ${n}  ${stage}  ${s.label}${s.failed ? '   ← DEAD END' : ''}`);
            if (s.failed) console.log(`        ${s.error}`);
            if (s.hidden) console.log(`        hidden: ${s.hidden}`);
            for (const c of s.needs)
                console.log(`        needs:  ${c} — ${CONCEPTS[c] || '?'}`);
        });
        console.log('');
        console.log(`  cost   ${steps.length} steps · ${stages.size} stages · ` +
                    `${needed.size} ffmpeg concepts · ${hidden.length} hidden`);
        if (outcome)
            console.log(`  got    ${outcome.what}` +
                        `${outcome.detail ? ` (${outcome.detail})` : ''}` +
                        `   ${outcome.ok ? 'YES' : 'NO'}`);
        if (shortfalls.length) {
            console.log('  did NOT get');
            for (const s of shortfalls) {
                console.log(`    · ${s.what}`);
                if (s.why) console.log(`      ${s.why}`);
            }
        }
        if (frictions.length) {
            console.log('  friction');
            for (const t of frictions) console.log(`    · ${t}`);
        }
        console.log('');

        const summary = {
            id, title, who, wants,
            steps: steps.length,
            stages: Array.from(stages),
            concepts: Array.from(needed),
            hidden: hidden.length,
            frictions,
            shortfalls,
            outcome,
            failures,
        };
        // The machine-readable copy, so a run over every journey can add them up
        // without re-parsing the prose above it.
        //
        // **A file rather than a line of console.** It was `console.log` of the
        // whole object, and bro's logger truncates a long line — so the two
        // journeys with the most to say about themselves were the two whose
        // records arrived unparseable, which is the worst possible pair to lose.
        try {
            const fs = require('fs');
            // **Against `bro.appDir`, not the working directory.** `require('fs')`
            // here resolves a relative path against the app root (`ui/`), so
            // `out/journeys` would have meant `ui/out/journeys` — which does not
            // exist, and the write failed into a catch. Same `appDir/../out`
            // every other suite writes its artifacts to.
            const dir = `${bro.appDir}/../out/journeys`;
            try { fs.mkdirSync(`${bro.appDir}/../out`); } catch (e) { /* already there */ }
            try { fs.mkdirSync(dir); } catch (e) { /* already there */ }
            fs.writeFileSync(`${dir}/${id}.json`,
                             JSON.stringify(summary, null, 2), 'utf-8');
        } catch (e) {
            console.log(`  (could not write the record: ${e.message || e})`);
        }
        return summary;
    }

    /// Fail the process if anything went wrong, after the report is printed —
    /// the report is the reason the suite exists and a throw before it would
    /// take away the one artifact worth having.
    function finish() {
        const s = report();
        if (failures)
            assert(false, `${id}: ${failures} thing${failures === 1 ? '' : 's'} ` +
                          `went wrong — see the journey above`);
        return s;
    }

    return { step, got, shortfall, friction, report, finish };
}

// ── the small conveniences every journey needs ─────────────────────────────

/// Every workspace key this application writes. Named here rather than imported
/// so that a key added to the app and not to this list shows up as a journey
/// inheriting something, which is the failure this exists to prevent.
const WORKSPACE_KEYS = ['ffmpeg-bro.export', 'ffmpeg-bro.explain', 'ffmpeg-bro.graph'];

/// **Start where a new person starts.**
///
/// The workspace is `localStorage` beside the app and it outlives the run that
/// wrote it — by design for the application and a hazard here, because these
/// journeys write to it as a side effect of being journeys. Without this, UC06
/// opened on the image2 muxer, a one-frame range and a facet left on Pictures,
/// all set by UC05, and reported that a file has no video row to remove. That is
/// not a finding about the application; it is one journey wearing another's
/// clothes.
///
/// It is also the honest thing to measure. Every cost recorded here is the cost
/// to somebody arriving at the job, and an application that is easy on the
/// seventh consecutive export of the same shape is not the thing being asked
/// about.
export function freshWorkspace(A) {
    // Clearing the store is what makes the *next* process boot clean — bro
    // writes `ui/.storage.json` back on every change, so a removed key is a
    // removed key on disk.
    for (const k of WORKSPACE_KEYS) {
        try { localStorage.removeItem(k); } catch (e) { /* nothing stored yet */ }
    }
    // And this is what makes *this* process clean, which clearing the store
    // cannot do: the blob was read into `settings` at boot, before any of this
    // ran. Only the remembered fields a journey can move are put back — the list
    // is `REMEMBERED` in ui/export/store.js, and what is here is the subset these
    // journeys actually write to.
    const s = A.exporter.currentSettings();
    s.container = 'mp4';
    s.videoCodec = '';
    s.audioCodec = '';
    s.rate = 'quality';
    s.audio = true;
    s.extraFormat = {};
    s.extraVideo = {};
    s.extraAudio = {};
    s.versions = [];
    s.destinations = [];
    s.metadata = {};
    s.chapters = [];
    s.streams = A.exporter.defaultStreams();
    // Not remembered, so not strictly inherited — put back anyway, because a
    // journey that asserts a duration must not be reading one a previous step
    // in the *same* journey narrowed.
    s.rangeIn = 0;
    s.rangeOut = 0;
    A.exporter.redraw();
    pump(120);
}

/// Run the frame loop for a while. Every journey pumps; the number is always a
/// guess and always the same guess, so it is here rather than in twelve files.
export function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

export const q = (sel, root) => (root || document).querySelector(sel);
export const qq = (sel, root) => Array.from((root || document).querySelectorAll(sel));
/// A control by the name the application labels it with — the same convention
/// every other suite here uses, and for the same reason: a test that selects the
/// way the app labels things fails when the label changes instead of quietly
/// matching something else.
export const f = (name) => q(`[data-f="${name}"]`);

/// Press a control, or say plainly that it was not there.
///
/// A journey is about what somebody could reach, so "there is no such button" is
/// the finding rather than a `TypeError` forty lines down.
export function press(sel, what) {
    const node = typeof sel === 'string' ? q(sel) : sel;
    if (!node) throw new Error(`there is no ${what || sel} to press`);
    node.click();
    pump(60);
    return node;
}

/// Type into a field and let the application hear it.
///
/// **Both events, because the application listens for different ones and a
/// journey must not depend on which.** A path field commits on `change`; the
/// muxer search filters on `input`, so that the list narrows as you type without
/// the caret jumping. Sending only `change` left the search box holding a word
/// and the list showing everything, which quietly turned "searching for mp3
/// finds nothing" into a finding about the application when it was a finding
/// about this file.
export function type(sel, value, what) {
    const node = typeof sel === 'string' ? q(sel) : sel;
    if (!node) throw new Error(`there is no ${what || sel} to type into`);
    node.value = String(value);
    node.dispatchEvent(new Event('input'));
    node.dispatchEvent(new Event('change'));
    pump(60);
    return node;
}

/// Wait for something to become true, or fail saying what was being waited for.
export function until(what, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/// Run a render the way pressing Export does, and wait for it to end.
///
/// The press is `#ex-go`, which is the button; everything after it is the
/// application's own loop, so this waits on `render.poll()` rather than on
/// anything the panel draws.
export function exportAndWait(timeoutMs = 120000) {
    press('#ex-go', 'the Export button');
    until('the render to finish', () => bro.ffmpeg.render.poll().state !== 'running',
          timeoutMs);
    return bro.ffmpeg.render.poll();
}

// ── the documents these journeys are about ─────────────────────────────────

/// Where `make_screencast.js` put the footage and the documents.
///
/// Normalised for the reason it is normalised there: a relative path under
/// `require('fs')` is read against `ui/`, and `${bro.appDir}/..` produces a
/// working but unreadable `…\ui\/..`.
export function screencastDir() {
    const fs = require('fs');
    return `${fs.realpathSync(`${bro.appDir}/..`).replace(/\\/g, '/')}/build/screencast`;
}

/// Open one of the generated `.fbro` documents, the way `File ▸ Open` does.
///
/// **This is the whole point of a journey starting from a document.** A use case
/// is a person with an edit in front of them, and an edit is a document — so a
/// journey that built its timeline out of model calls would be measuring a
/// timeline nobody could have saved. `A.doc.load` is what the Open dialog calls
/// once somebody has picked a file, so what runs here is what runs then.
export function openDocument(A, name) {
    const path = `${screencastDir()}/${name}.fbro`;
    const fs = require('fs');
    assert(fs.existsSync(path),
           `no document at ${path} — run tests/usecases/make_screencast.js first`);
    A.doc.load(path);
    pump(1600);
    assert(A.project.clips.length > 0, `${name}.fbro opened with no clips on the timeline`);
    return path;
}

/// The footage itself, for the journeys that want to compare against it.
export function footage() { return `${screencastDir()}/operating.mp4`; }

/// What actually landed on disk, or null if nothing did.
export function wrote(path) {
    try { return bro.ffmpeg.probe(path); } catch (e) { return null; }
}

/// The stream kinds of a probed file, as a string like `video+audio`.
export const kindsOf = (probe) =>
    probe ? probe.streams.map((s) => s.kind).join('+') : '';

/// How long the file that came out is. On `format` rather than on the probe
/// itself — see docs/api.md — and 0 for a file libavformat will not put a number
/// to, which is what it means rather than a reason to throw.
export const secondsOf = (probe) => (probe && probe.format && probe.format.duration) || 0;

/// A short statement of what landed on disk, for the `got` line.
export const describe = (probe) =>
    probe ? `${kindsOf(probe)} · ${secondsOf(probe).toFixed(2)} s · ` +
            `${probe.format.name} · ${Math.round((probe.format.size || 0) / 1024)} kB`
          : 'nothing was written';
