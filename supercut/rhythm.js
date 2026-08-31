// Words on a beat: a score typed as text, cut out of the corpus, packed onto a
// grid.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// The rest of this application assembles a mix by *finding* — a hit, a listen, a
// press, and the moment goes on the end of the row. That is the right loop when
// the material decides the shape. It is the wrong loop entirely when the shape
// decides the material: "no no no no, on the beat" is a thing somebody can hear
// before they have found a single one of them, and building it by hand is
// twenty presses and then a trim per piece to a length nobody can hit by eye.
//
// So the shape is typed and the finding is done for you. A **score** is a tempo,
// a grid, and a line of words; a **build** is that score turned into clips whose
// lengths are exact multiples of the grid and whose in-points are the moments
// those words were said.
//
// ── The notation, and why each of the three tokens exists ─────────────────
//
//     no  no  no  no
//     what . the -  hell . . -
//
// A token is one **step**, and a step is `60 / tempo / stepsPerBeat` seconds.
// Three kinds:
//
//   - a **word** starts a new piece on this step. `what|wot` is an alternation
//     and is `ui/phrase.js`'s own syntax, unchanged and not re-implemented here;
//     `"you cross"` in quotes is a phrase with a space in it, which is the one
//     thing the token split would otherwise take apart. `hell#2` pins the second
//     take rather than taking the next one.
//   - `.` **holds**: the piece before it is one step longer. Not a repeat and
//     not a rest — the same clip, running on.
//   - `-` **rests**: a step of black and silence.
//
// A line break is nothing but a line break; the grid runs across it. Bars are
// what lines are for, and there is deliberately no bar character — `|` is
// already alternation and a second meaning for it would be a score that
// searched for something nobody typed.
//
// ── A rest is a real clip, because a mix has no holes ─────────────────────
//
// `supercut/mix.js`'s one rule is that the sequence is packed: no gaps, no
// overlaps. A rest is therefore not an absence — there is nowhere for an absence
// to be — it is a **generator clip**, `color=c=black`, which this application
// already knows how to hold, play, render and write into a document because
// `ui/generator.js` and `makeGenerator` are the model's. A silence in a supercut
// is a picture of nothing for exactly one step, which is what a rest is.
//
// ── Cut to the step, and never stretched ──────────────────────────────────
//
// A word is longer or shorter than the step it is given, always. The piece is
// **cut to the step**: the clip is exactly `steps × step` seconds long, so a long
// word is cut off mid-syllable and a short one runs on into whatever followed it
// in the recording. The alternative was to set the clip's speed so the word's own
// span filled the step, and it is not the default because the pitch moves with
// it — audibly past about ±15%, and a supercut where every word is a different
// person is a supercut of nobody. `setSpeed` is one drag away on any card
// afterwards, which is where a decision about *one* piece belongs.
//
// ── Where the beat actually is, which is the whole of "precisely" ─────────
//
// A transcript says a word began at `t`. That number is Parakeet's frame — 0.08 s
// — and the frame is where the *token* was emitted, not where the sound starts.
// At 120 bpm a sixteenth is 125 ms, so an error of one frame is most of a step:
// cutting at the transcript's own number gives a mix that is nearly on the beat
// and sounds like a mistake.
//
// The measurement that says where a sound *starts* is already in this binary and
// had no reader: `bro.ffmpeg.marks` is brosoundml's spectral-flux onset
// detector, native, on a thread (`src/native/sound_marks.h`). So after the clips
// are placed, each one asks for the onsets in a short window around its word and
// **slips** to the nearest one. Four things about that:
//
//   - It is a **slip and not a trim**, which is what makes it safe to do late: a
//     slip moves the footage inside a card whose length and position do not
//     change, so the grid is untouched whatever the answer is and a read that
//     never lands leaves a mix that is merely on the transcript's timing.
//   - The window **starts 0.6 s before the word**, and that is not padding. The
//     flux baseline is an EMA starting at zero with a ~0.5 s time constant, so
//     the first half-second of anything analysed carries marks that are not in
//     it — `docs/api.md` says so and refuses to filter them, because a warm-up
//     here would make this and `bro.sense.analyze()` disagree about one file. The
//     lead puts that half-second before the part being asked about.
//   - The offset is applied **relative**, so it composes with `supercut/cuts.js`:
//     a clip repointed at its cut mid-flight carries a slip through the same
//     subtraction, which is the property `adopt()` there already states.
//   - **An onset is a transient and is not "the word".** Nothing here decides
//     that the nearest transient is the word's own attack; what is claimed is
//     that the piece was moved to the loudest change nearby, and a `TOLERANCE`
//     it cannot exceed is what keeps that claim small. `sound_marks.h` names its
//     marks after the measurement for this reason and so does this.
//
// ── One read at a time, because brotensor says so ─────────────────────────
//
// The mel front-end reaches brotensor's CPU pool, which is a process-wide
// singleton that assumes it is not re-entered — `readSoundMarks` takes a lock
// for it. So sixteen reads started at once would be sixteen rows waiting on a
// mutex, and this queues them one deep exactly as `supercut/acquire.js` queues
// transcriptions and for the same reason.
//
// ── The score is not in the document ──────────────────────────────────────
//
// A `.fbro` holds the *edit*: inputs, clips, canvas, graph, output. The score is
// what produced one, the way a search box is what produced a clip somebody
// added — and the mix outlives it in exactly the same way, because it is a mix
// like any other from the moment it exists. So the score is a working
// preference in `localStorage` beside the split height, and the artifact is the
// clips. Building again does not remember what it built last time and does not
// try to: it appends, and `Clear` is one press.

import { project, projectFps, duration, makeGenerator, addClip, slipClip, changed }
    from '../ui/project.js';
import * as generators from '../ui/generator.js';
import * as library from '../ui/library.js';

// ── the grid ───────────────────────────────────────────────────────────────

/// Beats a minute. 120 because it is the tempo somebody types when they have not
/// decided, and because a sixteenth of it is 125 ms — long enough to hear a word
/// in and short enough that four of them are a bar.
const TEMPO = 120;

/// Steps a beat. Four, so a token is a sixteenth and the two things people
/// actually type — one word a beat with three holds, or four words a beat — are
/// both sayable without changing it.
const STEPS = 4;

/// The window a piece's onsets are looked for in, in seconds either side of the
/// word's transcript time. Small on purpose: this is a refinement of a number
/// that is nearly right, and a wide window would find the transient of the word
/// *before* and move the piece onto it.
const TOLERANCE = 0.2;

/// How long before the word the analysed window starts.
///
/// The flux EMA's warm-up, and the whole reason this is not simply `TOLERANCE`.
/// See the header.
const WARMUP = 0.6;

let tempo = TEMPO;
let per = STEPS;
let text = '';
let loose = false;

const KEY = 'supercut.score';

/// How long one step is, in seconds. The one home for the arithmetic — the
/// parse, the placement, the tab's own note and the suite all ask here.
export function stepSeconds() {
    return 60 / Math.max(1, tempo) / Math.max(1, per);
}

export function score() { return text; }
export function tempoOf() { return tempo; }
export function stepsPerBeat() { return per; }
export function looseOf() { return loose; }

export function setScore(t) { text = String(t == null ? '' : t); remember(); }
export function setTempo(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) tempo = Math.min(600, Math.max(20, n));
    remember();
}
export function setStepsPerBeat(v) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) per = Math.min(16, Math.max(1, n));
    remember();
}
export function setLoose(on) { loose = !!on; remember(); }

/// Read back what was last typed.
///
/// **A version-tolerant read**, which is the rule for everything in the
/// workspace: what is in there was written by an earlier version of this code
/// and every field is sanitised through the same setters a person's typing goes
/// through, so a tempo of `"fast"` or of `1e9` is the default rather than a grid
/// nothing can be placed on.
export function restore() {
    let blob = null;
    try { blob = JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch (e) { blob = null; }
    if (!blob || typeof blob !== 'object') return;
    setTempo(blob.tempo);
    setStepsPerBeat(blob.per);
    setLoose(blob.loose);
    setScore(typeof blob.text === 'string' ? blob.text : '');
}

function remember() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ tempo, per, loose, text }));
    } catch (e) { /* no store; the score is still good for this session */ }
}

// ── the parse ──────────────────────────────────────────────────────────────

/// Split a score into tokens, keeping a quoted phrase whole.
///
/// Whitespace separates, `"` groups, and a line break is whitespace like any
/// other — see the header for why there is no bar character.
function tokensOf(src) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(src || '')))) {
        const quoted = m[1] !== undefined;
        const t = quoted ? m[1] : m[2];
        if (quoted) out.push({ text: t, quoted: true });
        else out.push({ text: t, quoted: false });
    }
    return out;
}

/// A score as pieces, before anything has been looked up.
///
/// Answers `[{ kind, phrase, take, steps }]` where `kind` is `'word'` or
/// `'rest'`. A hold is not a piece — it is a step added to the piece before it,
/// which is what makes the length arithmetic one multiplication and not a
/// second pass.
///
/// **A hold with nothing before it is a rest**, and that is the only forgiving
/// thing in here: a score beginning with `.` is somebody lining a line up under
/// the one above, and refusing it would be pedantry about a step of silence they
/// can see.
export function parse(src) {
    const pieces = [];
    for (const tok of tokensOf(src)) {
        const t = tok.text;
        if (!tok.quoted && (t === '.' || t === '..')) {
            if (pieces.length) pieces[pieces.length - 1].steps++;
            else pieces.push({ kind: 'rest', phrase: '', take: 0, steps: 1 });
            continue;
        }
        if (!tok.quoted && (t === '-' || t === '_')) {
            pieces.push({ kind: 'rest', phrase: '', take: 0, steps: 1 });
            continue;
        }
        // `#2` pins a take. Read off the end and only when it is digits, so a
        // phrase that genuinely contains a hash is still searchable — the
        // matcher flattens it away in any case (`bare` in `ui/phrase.js`).
        let phrase = t;
        let take = 0;
        const pin = /^(.*[^#])#(\d+)$/.exec(t);
        if (!tok.quoted && pin) { phrase = pin[1]; take = +pin[2]; }
        pieces.push({ kind: 'word', phrase, take, steps: 1 });
    }
    return pieces;
}

// ── resolving ──────────────────────────────────────────────────────────────

/// The plan: every piece with the moment it will be cut from, or the reason it
/// cannot be.
///
/// Answers `{ pieces, missing, steps, seconds }`. `missing` is the phrases
/// nothing said, which is what a refusal names.
///
/// **Repeats take a different moment each time.** `no no no no` off one hit four
/// times is one clip repeated, which is not what anybody means by it and is
/// what a loop pedal is for; four takes of the same word is the thing this
/// exists to make. So each phrase carries a cursor and walks its own hits,
/// wrapping when it runs out — a phrase said twice and typed five times is
/// takes 1, 2, 1, 2, 1, which is honest and is better than four copies of one.
///
/// The hits themselves are `ui/library.js`'s, spaced by its rule and confined to
/// whatever the finder is confined to. **Nothing about what counts as an
/// instance is decided here**, which is the rule this repository has already paid
/// for breaking once.
export function resolve(src = text) {
    const pieces = parse(src);
    const found = new Map();     // phrase (as typed) → hits
    const cursor = new Map();
    const missing = [];
    let steps = 0;

    for (const p of pieces) {
        steps += p.steps;
        if (p.kind !== 'word') continue;
        if (!found.has(p.phrase))
            found.set(p.phrase, library.searchWords(p.phrase, { loose }));
        const hits = found.get(p.phrase);
        p.takes = hits.length;
        if (!hits.length) {
            p.hit = null;
            if (missing.indexOf(p.phrase) < 0) missing.push(p.phrase);
            continue;
        }
        let n;
        if (p.take > 0) {
            // A pin past the end is not silently wrapped: somebody who typed
            // `#7` was looking at a list, and giving them take 1 instead would
            // be the tool answering a different question without saying so.
            if (p.take > hits.length) {
                p.hit = null;
                p.why = `only ${hits.length} take${hits.length === 1 ? '' : 's'}`;
                continue;
            }
            n = p.take - 1;
        } else {
            n = (cursor.get(p.phrase) || 0) % hits.length;
            cursor.set(p.phrase, n + 1);
        }
        p.hit = hits[n];
        p.at = hits[n].at;
        p.take = n + 1;
    }
    return { pieces, missing, steps, seconds: steps * stepSeconds() };
}

/// The last plan, for the tab to draw. Recomputed when the score changes rather
/// than on every frame: a resolve is a search of the whole corpus per distinct
/// word, which is milliseconds and is not free.
let planned = { pieces: [], missing: [], steps: 0, seconds: 0 };
export function plan() { return planned; }

/// Work out what the score would build, and answer it.
export function replan() {
    planned = library.available() ? resolve()
                                  : { pieces: parse(text), missing: [], steps: 0,
                                      seconds: 0 };
    return planned;
}

// ── building ───────────────────────────────────────────────────────────────

let hooks = {};
/// The build in flight: the pieces still waiting for their inputs to open.
let job = null;
/// What is being said about the build, as one line. A statement.
let said = '';

export function initRhythm(h) {
    hooks = h || {};
    restore();
}

/// What the tab says about the build. '' when nothing is happening.
export function note() { return said; }

/// Is a build waiting on anything? The press that started it is not repeatable.
export function busy() { return !!job; }

/// Turn the score into clips.
///
/// Answers '' when it started and a sentence when it refused.
///
/// **It refuses rather than approximating**, which is `ui/graph/derive.js`'s rule
/// in another place: a build that quietly left out the two words nothing said
/// would produce a rhythm with two holes in it and nothing on the screen saying
/// which. Every missing word is named at once, because fixing them one press at
/// a time is the version of this nobody would use twice.
///
/// **The press returns.** Opening a recording is a probe on a thread and a
/// six-hour file takes a moment, so the build is a job the frame loop finishes:
/// the inputs are asked for here and the clips are laid when every one of them
/// has answered. They are laid **all at once, in score order** — not one per
/// probe as it lands — because the order of a mix is the order of the words and
/// probes land in whatever order the disk feels like.
export function build() {
    if (job) return 'still building';
    if (!library.available()) return 'no corpus to build from';

    const got = replan();
    if (!got.pieces.length) return 'nothing typed';
    if (got.missing.length)
        return `nothing says ${got.missing.map((w) => `"${w}"`).join(', ')}`;
    const pinned = got.pieces.filter((p) => p.kind === 'word' && !p.hit && p.why);
    if (pinned.length)
        return pinned.map((p) => `"${p.phrase}" — ${p.why}`).join(' · ');
    const noMedia = got.pieces.filter(
        (p) => p.kind === 'word' && p.hit && !p.hit.vod.media);
    if (noMedia.length)
        return `${noMedia.length} of those are in recordings that are not on disk`;

    // One input per distinct recording, asked for now so the opens overlap.
    const paths = [];
    for (const p of got.pieces)
        if (p.kind === 'word' && paths.indexOf(p.hit.vod.media) < 0)
            paths.push(p.hit.vod.media);
    const inputs = paths.map((path) => hooks.openInput({ path, name: path }));

    job = { pieces: got.pieces, inputs, began: Date.now() };
    said = `building ${got.pieces.length} pieces…`;
    return '';
}

/// Every input the build is waiting on has answered — lay the whole score.
///
/// The canvas is settled from the first piece that has a picture, which is
/// `app.js`'s rule for the first clip of a mix and is stated there; a score that
/// begins with a rest would otherwise size the project from a `color` filter
/// this file chose the dimensions of.
function lay() {
    const step = stepSeconds();
    let laid = 0;
    for (const p of job.pieces) {
        if (p.kind === 'rest') {
            if (rest(p.steps * step)) laid++;
            continue;
        }
        // **The in-point is the word's own start and nothing is subtracted from
        // it.** `library.asClip` pads a single word by `WORD_PAD` because a word
        // taken to its edge arrives half said — which is right when the moment
        // is what matters and is exactly wrong here, where the beat *is* the
        // word's start. The pad the cut takes either side is `cuts.js`'s and is
        // material, not in-point.
        const clip = hooks.place({
            path: p.hit.vod.media,
            name: `${p.hit.vod.id} ${p.phrase}`,
            from: Math.max(0, p.at),
            to: Math.max(0, p.at) + p.steps * step,
            vod: p.hit.vod.id,
            title: p.hit.vod.title || '',
        });
        if (!clip) continue;
        laid++;
        // The onset read for this piece, queued rather than started: one runs at
        // a time process-wide. `want` is the transcript's number, which is what
        // the answer is measured against.
        queue.push({ clip: clip.id, path: p.hit.vod.media, want: Math.max(0, p.at),
                     read: 0, phrase: p.phrase });
    }
    job = null;
    said = `${laid} pieces on the grid`;
    if (hooks.edited) hooks.edited();
    return laid;
}

/// One step of black.
///
/// A generator clip, for the reason in the header: the sequence is packed and
/// there is nowhere for an absence to be. `color` at the project's own size and
/// rate, so a rest is the same shape of picture as everything around it and the
/// render has nothing to reconcile.
///
/// **A build that cannot make one goes on without it**, saying so — a filter
/// this build does not have is a real possibility (`whyNotAClip` refuses by
/// name) and losing the whole score to a missing `color` would be worse than a
/// mix that is short a silence.
function rest(seconds) {
    const spec = generators.makeSpec('color', {
        width: project.width || 1920,
        height: project.height || 1080,
        fps: projectFps(),
    });
    const settled = generators.settle(spec);
    if (!settled.ok) { said = `no rest: ${settled.why}`; return false; }
    const clip = makeGenerator(settled);
    clip.track = 0;
    clip.muted = true;
    // A generator has no length of its own — `media` is the edit's number, which
    // is what `makeGenerator` says at length — so it is set to what is being
    // asked for rather than trimmed down to it.
    clip.media = Math.max(seconds, clip.media);
    clip.length = seconds;
    clip.start = duration();
    addClip(clip);
    if (hooks.packed) hooks.packed();
    return true;
}

// ── snapping to the sound ──────────────────────────────────────────────────

/// Pieces waiting for their onsets, and the one read in flight.
const queue = [];
let reading = null;

/// How many pieces are still to be measured, for the line that says so.
export function snapping() { return queue.length + (reading ? 1 : 0); }

/// Start the next onset read, if there is room.
///
/// One at a time — see the header. The window is `[want - WARMUP, want +
/// TOLERANCE]`, so the flux baseline warms up on material before the word rather
/// than on the word itself.
function startRead() {
    if (reading || !queue.length) return false;
    const next = queue.shift();
    const clip = project.clips.find((c) => c.id === next.clip);
    // Removed while the queue waited: a piece somebody deleted is not measured,
    // and the read that would have been started is the cheapest one to not do.
    if (!clip) return true;
    const ss = Math.max(0, next.want - WARMUP);
    try {
        next.read = bro.ffmpeg.marks.reads.start(
            { path: next.path, ss, t: (next.want - ss) + TOLERANCE },
            // Only the transient. A tonal run and a sound gate are measurements
            // of other questions and every one of them is more DSP and a longer
            // list to walk.
            { onsets: true, tonal: false, sound: false });
        next.ss = ss;
        reading = next;
    } catch (e) {
        // A recording that will not open here is one the clip is already playing
        // from, so there is nothing to report and nothing to mend: the piece
        // keeps the transcript's timing.
        return true;
    }
    return true;
}

/// Advance the onset reads. Answers true when a piece moved.
///
/// Synchronous and idempotent, the shape every poll in this application has.
export function tick() {
    let moved = false;

    if (job) {
        // Still opening. An input that refused is not a reason to lose the
        // score — the piece is laid against a file that will not play, which is
        // visible — so what is waited for is an *answer*, either way.
        if (job.inputs.every((i) => !i || i.probe || i.error)) {
            const bad = job.inputs.filter((i) => i && i.error);
            lay();
            if (bad.length) said += ` · ${bad.length} would not open`;
            moved = true;
        }
    }

    if (reading) {
        let answer = null;
        try { answer = bro.ffmpeg.marks.reads.poll(reading.read); }
        catch (e) { answer = null; }
        if (!answer) { reading = null; }
        else if (answer.state !== 'reading') {
            if (answer.state === 'done' && answer.result) {
                if (apply(reading, answer.result)) moved = true;
            }
            reading = null;
        }
    }
    // Starting the next read is not itself a change worth a redraw — nothing on
    // the screen moved — so its answer is deliberately dropped.
    startRead();

    return moved;
}

/// Move one piece onto the transient nearest its word.
///
/// **A slip, so the grid does not move** — see the header. Answers whether it
/// moved anything, which is the difference between a redraw and a frame spent
/// on nothing.
function apply(item, result) {
    const clip = project.clips.find((c) => c.id === item.clip);
    if (!clip) return false;
    let best = 0;
    let by = Infinity;
    for (const m of result.marks || []) {
        if (m.kind !== 'onset') continue;
        // `at` is on the analysed window's clock, which begins at `ss`.
        const t = item.ss + m.at;
        const d = Math.abs(t - item.want);
        if (d < by) { by = d; best = t; }
    }
    // Nothing near enough is a real answer and the ordinary one for a word in
    // the middle of a sentence: the piece keeps the transcript's timing, which
    // is what it already had.
    if (by > TOLERANCE) return false;
    const delta = best - item.want;
    if (Math.abs(delta) < 1e-4) return false;
    slipClip(clip, delta);
    changed('edit');
    return true;
}

/// Forget every outstanding read.
///
/// **`forget` rather than `cancel`**, and required rather than tidy: a terminal
/// read on this surface is handed over exactly once and one nobody polls again
/// sits in the table for the life of the process. Called when the mix is
/// cleared, because a piece that has gone is a piece whose onsets nothing will
/// ever apply.
export function forget() {
    for (const q of queue) if (q.read) { try { bro.ffmpeg.marks.reads.forget(q.read); } catch (e) { /* gone */ } }
    queue.length = 0;
    if (reading) {
        try { bro.ffmpeg.marks.reads.forget(reading.read); } catch (e) { /* gone */ }
        reading = null;
    }
}
