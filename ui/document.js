// The edit, as one object.
//
// Until now nothing about an edit survived closing the window. Two habits did —
// what the Encode and Write stages were set to, and what had been inserted and
// locked on the Graph stage, both in `localStorage`, both per machine rather
// than per edit — and the timeline itself was written nowhere at all. Close it
// and the clips, the trims, the placements, the canvas and every `-i` were gone.
//
// **One object, and everything else follows from it.** `snapshot()` produces a
// plain JS value describing the whole edit and `open()` puts one back. A
// document *file* is that object with `JSON.stringify` around it; an undo stack
// is a list of them. Writing the file first and the object second would have
// produced a serialiser, and a serialiser is a thing that can only ever do one
// of those.
//
// That is the same argument `ui/export/spec.js` is made on, and the parallel is
// worth naming: there, one object describes the whole *render* and three
// consumers read it, so the printed command cannot describe a render the
// application would not perform. Here, one object describes the whole *edit*.
//
// Five rules hold it together:
//
//   - **Ids are part of the document.** A clip's id and an input's id are
//     written down, because they are written down elsewhere: the graph overlay
//     pins a filter to `clip:7/after-scale` and a source node names `in3`. An
//     open that renumbered would re-point every anchor at a different shot and
//     every source node at a different file, silently. This is what closes the
//     hole `ui/graph/overlay.js` records at `restore()` — a node naming an input
//     is refused from `localStorage` because the inputs do not come back, and it
//     is restored from a document because they do.
//   - **An input is written as what opens it**, never as a file: the path, the
//     demuxer, both option bags, the hardware decode and the window — the whole
//     of `asInput()`. Opening a document *is* a reopen, so what has to be stored
//     is the thing `ui/inputs.js` reopens from. A file that has moved comes back
//     as an input carrying libav's own message, which is exactly what a Sources
//     row shows for one; deciding what to do about that is not the document's
//     business.
//   - **Nothing derived is written.** A clip's name, size, rate, duration and
//     probe are its input's answer, and `peaks`, `film`, `video`, `frame` and
//     `ready` are the running application. Storing an answer that the next
//     reopen may contradict is how a document comes to disagree with the file it
//     describes.
//   - **Opening is a replacement, never a merge.** Every clip is detached, every
//     input is forgotten, and the whole thing is built again. A merge would need
//     a rule for when two documents' inputs are "the same input", and there is
//     no such rule: two documents' `in3` are two different files.
//   - **The read is version-tolerant**, the same as every other reader here.
//     `version` is written so that a person looking at the file can see what
//     wrote it and so that a future migration has something to branch on;
//     nothing branches on it today, and nothing needs to, because every field is
//     sanitised on the way in whatever the number says.
//
// What a document holds that the workspace deliberately does not — see the
// `REMEMBERED` list in `ui/export/store.js` — is everything that names a moment
// on *this* timeline: the chapters, the render range, and the output path. Those
// are meaningless carried into the next edit and exactly right carried inside
// this one, which is the whole distinction between a habit and a document.
//
// **And a sixth part that is not the edit at all: the session.** Which clip was
// selected, where the playhead was standing, which stage you were on and how far
// the timeline was zoomed. It is written and it is put back, because a `.fbro` is
// a handoff of work in progress rather than an archive of a finished one, and
// handing over the arrangement while throwing away where the work had got to is
// handing over half of it. The question that kept it out — whether opening
// *somebody else's* document should move *your* playhead — is answered yes: there
// is no "only my own documents" case, because that would mean identity on the
// file, and nothing in a document is about who wrote it.
//
// It is the one part of the snapshot that is **not the edit**, and two things
// follow that are stated where they are enforced rather than only here:
//
//   - `ui/history.js` strips it, so a step of undo stays the edit and nothing
//     else. Moving the playhead is not an undoable act.
//   - `touch()` is not called for it. The dot beside the name is about work you
//     could lose, and a document marked unsaved because somebody clicked a clip
//     is a dot that means nothing.

import { project, makeClip, placeClip, removeClip, sortClips, useClipId,
         defaultTransform, applyInput, changed } from './project.js';
import * as inputsModel from './inputs.js';
import * as overlay from './graph/overlay.js';
import { settings } from './export/state.js';
import * as store from './export/store.js';
import { basename } from './format.js';

const FORMAT = 'ffmpeg-bro';
const VERSION = 1;

/// What a document file is called. One extension, because the file dialog's
/// filter and the name a Save As offers are the same fact twice.
export const EXTENSION = 'fbro';

let hooks = {};

/// The three things the document cannot do for itself: a clip's `<video>` is the
/// viewer's, analysing one is the worker's, and where you were standing in the
/// edit is the running application's. Handed in rather than imported so that this
/// module stays a statement about the model — the same reason `ui/project.js`
/// does not know a viewer exists.
///
/// `session()` answers `{ clip, playhead, stage, view }`; there is deliberately
/// no hook the other way, because putting one back is the half that is only true
/// of an *Open* and `ui/app.js` already owns that half — see `documentOpened()`.
/// A second entry point into it would be a second answer to whether an undo may
/// move the playhead, and the answer has to be no.
export function initDocument(h) { hooks = h || {}; }

// ── the object ─────────────────────────────────────────────────────────────

/// The whole edit, as a value nothing else holds a reference into.
///
/// Deep-copied rather than handed out live, and that is not tidiness: an undo
/// stack is a list of these, and a "snapshot" that shared its `xform` objects
/// with the model would change every time the model did, so the stack would be
/// N copies of the present.
export function snapshot() {
    return {
        format: FORMAT,
        version: VERSION,
        canvas: {
            width: project.width,
            height: project.height,
            fps: project.fps,
            layout: project.layout,
        },
        // In list order, because the index is the `-i` number that a spec and a
        // `[0:v]` both count in — see `ui/inputs.js`. A document that came back
        // in a different order would be a different render.
        inputs: inputsModel.inputs.map((i) => Object.assign(inputsModel.asInput(i), {
            id: i.id,
            // What a scan found, where this input came out of one. Not derivable
            // from the path: `probe()` reports what image2 read and image2 stops
            // at the first gap, so the two are different facts and the Sources
            // stage shows both.
            sequence: i.sequence || null,
            parts: i.parts || null,
        })),
        clips: project.clips.map((c) => ({
            id: c.id,
            input: c.input.id,
            track: c.track,
            start: c.start,
            inPoint: c.inPoint,
            length: c.length,
            xform: copy(c.xform),
            volume: c.volume,
            muted: !!c.muted,
        })),
        graph: copy(overlay.current()),
        output: outputBlob(),
        session: sessionBlob(),
    };
}

/// Put one back. Returns what could not be laid out and why, rather than
/// throwing: a document with one missing file is a document you still want the
/// rest of, and the caller is the thing that can say so on screen.
///
/// **A replacement, done by reconciling.** What comes out is the document and
/// nothing else — anything not in it goes — but what happens to get there is a
/// comparison rather than a rebuild: an input the document names with the same
/// id and the same opening is left alone, and a clip of it keeps the `<video>`
/// it already has. That is not an optimisation, it is what makes an *undo*
/// possible at all: this is the call `ui/history.js` makes on every `Ctrl-Z`,
/// and one that tore down every decoder and re-probed every file would take a
/// second and blank the picture for the sake of putting a crop back.
///
/// The order is inputs, then clips, then the inputs nobody wants — so that no
/// input is ever taken away while something is still decoding it.
///
/// **A clip whose input would not open is not laid out**, and it is not dropped
/// from anything except this session — the file on disk still has it. Fix the
/// path and open it again. Laying it out anyway would mean a clip with no
/// probe, which is a rectangle of an unknown size over an unknown length.
export function open(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};

    // ── the inputs it names ──
    const seen = new Set();
    const specs = list(d.inputs).map((s) => readInput(s, seen)).filter(Boolean);
    // The ones whose *opening* changed — a different path, demuxer, option or
    // window — because a clip of one is decoding a file that has just stopped
    // being the file it was, and its element has to be rebuilt. An input the
    // document describes exactly as it already is answers false here and costs
    // nothing: no reprobe, no re-registration, no reload.
    const reopened = new Set();
    for (const spec of specs) {
        const have = spec.id ? inputsModel.byId(spec.id) : null;
        if (!have) inputsModel.addInput(spec);
        else if (inputsModel.updateInput(have, spec)) reopened.add(have);
    }
    for (const input of reopened) applyInput(input);

    // ── the clips it names ──
    const skipped = [];
    const usedIds = new Set();
    const plan = [];
    for (const saved of list(d.clips)) {
        if (!saved || typeof saved !== 'object') continue;
        const input = inputsModel.byId(String(saved.input || ''));
        if (!input) {
            skipped.push({ name: String(saved.input || '?'),
                           why: 'names an input this document does not describe' });
            continue;
        }
        if (!input.probe) {
            skipped.push({ name: input.name, why: input.error || 'could not be opened' });
            continue;
        }
        // A document that hands the same clip id out twice gets a fresh one for
        // the second, whose anchors then simply do not apply — a state the
        // overlay is already built to be in.
        const n = Math.round(Number(saved.id));
        const id = Number.isFinite(n) && n > 0 && !usedIds.has(n) ? n : 0;
        if (id) usedIds.add(id);
        plan.push({ saved, input, id });
    }

    for (const clip of project.clips.slice())
        if (!usedIds.has(clip.id)) dropClip(clip);

    const made = [];
    for (const p of plan) {
        let clip = p.id ? project.clips.find((c) => c.id === p.id) : null;
        // The same id over a different file is not the same clip. Rebuilt rather
        // than re-pointed, because the element *is* the decoder and re-pointing
        // one is what `reloadInput` exists to avoid getting wrong.
        if (clip && clip.input !== p.input) { dropClip(clip); clip = null; }
        let element = !clip || reopened.has(p.input);
        if (!clip) {
            clip = makeClip(p.input);
            if (p.id) { clip.id = p.id; useClipId(p.id); }
            placeClip(clip);
        } else if (element) {
            if (hooks.detach) hooks.detach(clip);
        }
        writeClip(clip, p.saved);
        if (element && hooks.attach) hooks.attach(clip);
        made.push(clip);
    }
    sortClips();

    // ── and the inputs it does not ──
    //
    // Last, now that nothing is cut from them. An input with no clip is an
    // ordinary state on the Sources stage, but not one a document can leave
    // behind: it would be an `-i` this edit never mentioned.
    const wanted = new Set(specs.map((s) => s.id).filter(Boolean));
    for (const input of inputsModel.inputs.slice())
        if (!wanted.has(input.id)) inputsModel.removeInput(input);
    inputsModel.orderInputs(specs.map((s) => s.id));

    readCanvas(d.canvas, made);
    // The overlay after the clips, and that ordering is load-bearing. Removing
    // an input fires the model's change channel, which is where `retain()` drops
    // everything pinned to a clip that is no longer open — so an overlay adopted
    // first would be stripped by the tidying that followed it.
    overlay.adopt(d.graph);
    // **Only when the document has any.** An *edit* history state deliberately
    // carries no `output` — a `Ctrl-Z` on the timeline must not reach the form,
    // which is why the settings are a second stack rather than part of this one —
    // and an absent key has to leave the Encode and Write stages exactly as they
    // are rather than reset them to a default nobody chose.
    store.adopt(d.output, store.DOCUMENT_KEYS);
    changed('document');
    // **Handed back rather than applied**, and only when the document has one.
    // Restoring it is the half that is true of an *Open* and false of an undo —
    // `ui/history.js` strips the key, so a state put back here never carries one
    // anyway — and `ui/app.js` already owns that half, where fitting the ruler and
    // sending the playhead home is decided. Read after the clips, because the one
    // thing in it that has to be checked is whether the clip it names is there.
    return { clips: made, skipped, session: readSession(d.session) };
}

/// Everything a document says about one clip, written over it.
///
/// Separate from making one because the point of the reconcile is that most
/// clips are *not* made: on an undo of a crop this is the whole of the work, and
/// the element it is drawn by never learns anything happened.
function writeClip(clip, saved) {
    clip.track = clamp(Math.round(num(saved.track)), 0, 7);
    clip.start = Math.max(0, num(saved.start));
    clip.inPoint = clamp(num(saved.inPoint), 0, clip.media);
    // What the file actually has, which is not what the document says it had:
    // an input reopened through a different demuxer, or one whose file has been
    // re-encoded since, is a shorter file than the trim was made against. Same
    // clamp `applyInput()` applies for the same reason.
    clip.length = clamp(num(saved.length, clip.media - clip.inPoint),
                        0, Math.max(0, clip.media - clip.inPoint));
    clip.xform = readTransform(saved.xform);
    clip.volume = clamp(num(saved.volume, 1), 0, 4);
    clip.muted = !!saved.muted;
}

function dropClip(clip) {
    if (hooks.detach) hooks.detach(clip);
    removeClip(clip);
}

/// An empty edit: no clips, no inputs, no graph, and the output settings left
/// exactly as they are.
///
/// The settings stay because they are a habit and this is a new document, not a
/// new machine — the same reason they are in `localStorage` at all. What does
/// not stay is the three that name something about the timeline that has just
/// gone: a chapter at 12.5 s, a range, and a path the last edit was going to be
/// written to. The render *size* stays with the codec, because "always cut
/// 1080p" is a habit and not a fact about any one timeline.
///
/// It carries no session either, and so the caller sends the playhead home and
/// fits the ruler — which is right, because there is nothing yet to be standing
/// in the middle of.
export function reset() {
    open({ output: { chapters: [], rangeIn: 0, rangeOut: 0, path: '' } });
    currentPath = '';
    modified = false;
}

// ── reading what was written ───────────────────────────────────────────────
//
// Everything below sanitises. What is being read was written by some earlier
// version of this application, or edited by hand, or is a file that is not a
// document at all — and the failure a reader like this prevents is not a
// refusal, it is a redraw that throws three stages away from the field that did
// it. Same rule as `ui/export/store.js` and `ui/graph/overlay.js`; there is no
// migration here because there has never been a shape to migrate from.

const list = (v) => (Array.isArray(v) ? v : []);
const copy = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/// One `-i`, in the shape `addInput()` takes.
///
/// The id is carried through and is the whole point of the exercise — but only
/// when it is one this run has not already handed out, because a document
/// naming `in3` twice would otherwise produce two inputs that `byId` cannot tell
/// apart, and every clip of the second would be laid out against the first.
function readInput(saved, seen) {
    if (!saved || typeof saved !== 'object') return null;
    const path = String(saved.path || '').trim();
    if (!path) return null;
    const id = String(saved.id || '');
    const free = !!id && !seen.has(id);
    if (free) seen.add(id);
    return {
        // Blank for one this document has already used, which asks `addInput`
        // for a fresh one. A second `in3` would be an input `byId` cannot tell
        // from the first, and every clip of it would be laid out against the
        // wrong file.
        id: free ? id : '',
        path,
        format: String(saved.format || ''),
        options: bag(saved.options),
        decoderOptions: bag(saved.decoderOptions),
        hwaccel: String(saved.hwaccel || ''),
        hwaccelDevice: String(saved.hwaccelDevice || ''),
        hwaccelOutputFormat: String(saved.hwaccelOutputFormat || ''),
        ss: Math.max(0, num(saved.ss)),
        to: Math.max(0, num(saved.to)),
        itsoffset: num(saved.itsoffset),
        streamLoop: Math.round(num(saved.streamLoop)),
        sequence: saved.sequence && typeof saved.sequence === 'object' ? saved.sequence : null,
        parts: Array.isArray(saved.parts) ? saved.parts.map(String) : null,
    };
}

/// An option bag, with every value a string — which is what `-key value` is, and
/// what `av_opt_set` takes. A number that came back as a number would reach the
/// summary line and print as one, which is harmless, and reach a comparison with
/// what the form wrote, which is not.
function bag(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const k of Object.keys(v)) out[k] = String(v[k]);
    return out;
}

/// A clip's geometry, over the top of the default one.
///
/// Merged onto `defaultTransform()` rather than validated field by field,
/// because the shape has one home in `ui/project.js` and a second copy of it
/// here would be a second answer to what a clip's geometry *is* — the failure
/// being a document written by a version that has one more field, read by a
/// version that drops it.
function readTransform(saved) {
    const x = defaultTransform();
    if (!saved || typeof saved !== 'object') return x;
    // The four `viewer.js` `placement()` knows. A fifth would reach the layout
    // as a value nothing matches and fall through to whatever its last `else`
    // happens to be, which is a picture rather than a refusal.
    if (['contain', 'cover', 'stretch', 'actual'].indexOf(saved.fit) >= 0) x.fit = saved.fit;
    x.zoom = clamp(num(saved.zoom, 1), 0.01, 100);
    x.panX = num(saved.panX);
    x.panY = num(saved.panY);
    x.opacity = clamp(num(saved.opacity, 1), 0, 1);
    const c = saved.crop;
    if (c && typeof c === 'object')
        for (const edge of ['l', 't', 'r', 'b']) x.crop[edge] = clamp(num(c[edge]), 0, 1);
    return x;
}

/// The output canvas. Seeded from the first clip when the document does not say,
/// which is what `addClip()` does for the first file dropped on an empty
/// timeline — a document written before there was a canvas to write, and one
/// hand-edited down to a list of clips, both open as the thing they describe.
function readCanvas(saved, clips) {
    const c = saved && typeof saved === 'object' ? saved : {};
    const first = clips.find((k) => k.width > 0);
    project.width = Math.max(0, Math.round(num(c.width, first ? first.width : 0)));
    project.height = Math.max(0, Math.round(num(c.height, first ? first.height : 0)));
    // Zero is not a rate, so it falls through to the clip's the way an absent
    // one does — `clamp` alone would turn it into one frame a second, which is
    // a timeline whose ruler counts in a unit nothing in the edit uses.
    project.fps = clamp(num(c.fps, 0) || (first ? first.fps : 25) || 25, 1, 1000);
    project.layout = c.layout === 'grid' ? 'grid' : 'stack';
}

/// What the Encode and Write stages are set to, as the document holds it.
///
/// Every key `ui/export/store.js` names, which is the workspace's list plus the
/// ones that only mean something inside one edit. Read off `settings` rather
/// than kept as a second list, so a setting added to that module arrives in the
/// document without an edit here.
function outputBlob() {
    const out = {};
    for (const k of store.DOCUMENT_KEYS)
        if (settings[k] !== undefined) out[k] = copy(settings[k]);
    return out;
}

// ── where you were in it ───────────────────────────────────────────────────
//
// Four numbers and a name, and not one of them is the edit: the same file opened
// twice with the playhead in two places is the same render both times. That is
// exactly why they are separable, and it is what lets `ui/history.js` take them
// out again without having to know what any of them mean.

/// The running application, as the document holds it.
///
/// Sanitised on the way *out* as well as on the way in, which the rest of this
/// file does not bother with — the difference is that everything else in the
/// snapshot is already a number in the model, and these come through a hook from
/// four different modules. A `view` whose span arrived as `NaN` would be written
/// into the file as `null` and read back as a window of nothing.
function sessionBlob() {
    const s = hooks.session ? hooks.session() : null;
    if (!s || typeof s !== 'object') return null;
    const v = s.view && typeof s.view === 'object' ? s.view : {};
    return {
        // A clip *id*, because that is the name the rest of the document is
        // written against — see the ids rule at the top. Zero is "nothing
        // selected", which is a state somebody can be in.
        clip: Math.max(0, Math.round(num(s.clip))),
        playhead: Math.max(0, num(s.playhead)),
        stage: String(s.stage || ''),
        // The window as a start and a span, never as a zoom factor: a factor is
        // `total / span` and the total is the edit's own length, so a document
        // opened after a clip was made longer would come back looking at
        // somewhere else entirely.
        view: { start: Math.max(0, num(v.start)), span: Math.max(0, num(v.span)) },
    };
}

/// And back again — version-tolerant, like every other reader here.
///
/// **The clip is the part that has to be checked.** A session names a clip by id
/// and an id is a name other things are written against, so a document whose
/// selected clip is not in it — hand-edited, written by a version that numbered
/// differently, or simply a clip somebody deleted before saving — has to come to
/// *nothing selected*. Selecting the wrong shot is the failure worth preventing:
/// the crop handles and the properties panel would then be pointed at a clip
/// nobody picked, which looks exactly like having picked it.
///
/// The stage is passed through as whatever string it says, because the list of
/// stages is `ui/shell.js`'s and `goTo()` already refuses one it does not have.
/// A copy of that list here would be a second answer to what the stages are.
function readSession(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const n = Math.round(num(saved.clip));
    const clip = n > 0 && project.clips.some((c) => c.id === n) ? n : 0;
    const v = saved.view && typeof saved.view === 'object' ? saved.view : {};
    return {
        clip,
        playhead: Math.max(0, num(saved.playhead)),
        stage: String(saved.stage || ''),
        // A span of zero is "the document did not say", which the caller answers
        // by fitting the ruler — the same thing it does for a document with no
        // session at all. Clamping it to something positive here would invent a
        // window nobody chose.
        view: { start: Math.max(0, num(v.start)), span: Math.max(0, num(v.span)) },
    };
}

// ── the file ───────────────────────────────────────────────────────────────
//
// A document on disk is the object above, indented, as UTF-8 JSON. Indented on
// purpose: it is a text file describing an edit, it goes in a repository beside
// the footage, and a diff of one should be readable. The cost is a few kilobytes
// on a file that is a few kilobytes.

const fs = require('fs');

let currentPath = '';
let modified = false;

/// Where this document came from, or '' for one that has never been saved.
export const documentPath = () => currentPath;

/// What to call it on screen.
export const documentName = () => (currentPath ? basename(currentPath) : 'Untitled');

export const isModified = () => modified;

/// Something in the edit has changed.
///
/// **Deliberately conservative.** The exact answer is "the snapshot differs from
/// the one last written", and computing it means serialising the whole edit on
/// every mouse move of every drag. So this is a flag, and what it buys is the
/// direction the error goes in: it can say *modified* for an edit that has been
/// dragged back to where it started, and it can never say *saved* for one that
/// has not been.
export function touch() { modified = true; }

/// Read one off disk. Throws, with the file named in the message, because a
/// caller that asked for a path has somewhere on screen to put a reason — and a
/// file that is not a document has to say so rather than open as an empty edit
/// over the top of the one in hand.
export function read(path) {
    const text = fs.readFileSync(path, 'utf-8');
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        throw new Error(`${basename(path)} is not a document: ${(e && e.message) || e}`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new Error(`${basename(path)} is not a document`);
    return doc;
}

/// Open a file, and become it.
export function load(path) {
    const result = open(read(path));
    currentPath = String(path);
    modified = false;
    return result;
}

/// Write the edit to a path, and become it.
///
/// The path is taken *after* the write rather than before, so a save that failed
/// — a full disk, a directory that is not there — leaves the document named
/// whatever it was named. A document that renamed itself onto a file it did not
/// manage to write would offer a Save that overwrites nothing.
export function save(path) {
    fs.writeFileSync(String(path), JSON.stringify(snapshot(), null, 2), 'utf-8');
    currentPath = String(path);
    modified = false;
    return currentPath;
}

// ── the dialogs ────────────────────────────────────────────────────────────
//
// SDL's native pickers, which are globals rather than anything on `bro.*`. All
// of them **block the JS thread**: while one is up the frame loop does not run,
// so nothing repaints and playback does not advance. That is the engine's
// behaviour and not something this file can improve on; what it means here is
// that a dialog is opened from a press and never from the frame loop.

const FILTER = `ffmpeg-bro documents|${EXTENSION}`;

/// Where a Save As should start. The document's own directory when it has one,
/// and otherwise a name in whatever the dialog defaults to — SDL takes this as a
/// *location* rather than a filename hint, so a bare name is a path.
function suggestion() {
    if (currentPath) return currentPath;
    return `untitled.${EXTENSION}`;
}

/// Ask for a path and save to it. Returns the path, or '' if it was cancelled.
export function saveAs() {
    const path = showSaveFileDialog(FILTER, suggestion());
    if (!path) return '';
    return save(withExtension(path));
}

/// Save to where it came from, asking only when there is nowhere yet.
export function saveHere() {
    return currentPath ? save(currentPath) : saveAs();
}

/// Ask for a document and open it. Returns null if it was cancelled.
export function openDialog() {
    const picked = showOpenFileDialog(FILTER);
    if (!picked || !picked.length) return null;
    return load(picked[0]);
}

/// A path a person typed without the extension gets it. The dialog's filter
/// does this on Windows and does not everywhere, and a document called
/// `edit` that the Open dialog then filters out of view is a file somebody has
/// to go and find in a shell.
function withExtension(path) {
    const p = String(path);
    return /\.[A-Za-z0-9]+$/.test(p) ? p : `${p}.${EXTENSION}`;
}
