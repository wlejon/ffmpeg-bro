// Undo.
//
// There was none anywhere in this application, and the reason it arrives now
// rather than earlier is that it needed something to be made of. An undo stack
// is a list of states, and until `ui/document.js` there was no such thing as
// "the state" — the edit lived in a model object, a graph overlay and a settings
// bag, with no way to speak about all of it at once. `snapshot()` produces
// exactly what a step of history is, and `open()` is exactly what popping one
// does, so this file is a list, two keys and the three rules that decide what
// counts as a step.
//
// **Two tracks, because `Ctrl-Z` must only ever change what is in front of you.**
// The edit — the clips, the inputs, the canvas, the graph — is one; the Encode
// and Write stages are the other. That is the whole of the argument that kept
// the form out of history for a while, and it turns out to be an argument for
// *separating* the stacks rather than for having one: a `Ctrl-Z` pressed on the
// timeline which silently reverted a codec three stages away would be worse
// than no undo at all, and so would one pressed on the Write stage that quietly
// moved a clip. So the press is answered by the track belonging to the stage it
// was pressed on, and neither can surprise you with the other's work.
//
// The other half of that old argument was that a control you have just changed
// is in front of you with its old value one keystroke away, so undo buys nothing
// on a form. True of one control and false of the press that changes twenty:
// `applyIntent` rewrites the whole shape of a render, the raw option editor and
// the stream list both rewrite bags, and "what was it before I pressed that" has
// no other answer. That is what the second track is for.
//
// **A state is held as text.** `JSON.stringify` of the snapshot, not the object.
// That is three things at once: comparing two states is `===`, so a change that
// changed nothing is dropped rather than becoming a step that appears to do
// nothing when it is undone; a hundred of them is a few hundred kilobytes rather
// than a hundred live object graphs; and `JSON.parse` on the way out is
// inherently a fresh object, which matters because `overlay.adopt()` takes its
// `locks`, `sizes` and `pins` bags by reference and would otherwise edit the
// history in place. The output track needs the same freshness for the same
// reason: `store.adopt()` assigns the bags it is given straight onto `settings`.
//
// **A state is the edit and nothing else.** Two keys of the snapshot are taken
// out and each for its own reason: `output` because it is the other track's, and
// `session` because it is *neither* track's — where the playhead is standing is
// not something anybody did. See the `edit` track below, which is where both
// deletions live because that is where a step is defined.
//
// **A gesture is one step, not a hundred.** A clip dragged along the timeline
// arrives as `move` per mouse position and one `moved` at the end, so `move` is
// ignored outright and the `moved` records the state from before the drag began.
// A slider has no such pair — the inspector reports `edit` on every pixel, and
// so does a quality slider on the Encode stage — so changes of the same kind
// arriving within half a second of each other are folded into the step the run
// started with. The failure that rule prevents is the one every editor without
// it has: forty presses of `Ctrl-Z` to get back past one drag of a crop handle.

import { snapshot, open, touch } from './document.js';
import * as store from './export/store.js';

/// How many steps back. A state is a few kilobytes of text for an ordinary edit,
/// so this is about a megabyte at worst — chosen as "further than anybody
/// reaches" rather than measured, because the thing being traded against is
/// memory nobody notices.
const LIMIT = 100;

/// How close together two changes of the same kind have to be to count as one
/// gesture. Long enough to cover a slider being dragged in stops, short enough
/// that two deliberate presses of the same key are two steps.
const COALESCE = 500;

const listeners = [];

/// Told whenever there is something new to be able to say — which is a button's
/// enabled state and nothing else, so it is coarse on purpose.
export function onChange(fn) { listeners.push(fn); }

function announce() { for (const fn of listeners) fn(); }

/// One stack, and the four rules that make it one. Both tracks are this; they
/// differ in what a state *is* and in what putting one back means, and in
/// nothing else — which is the point of it being a factory. Two copies of the
/// coalescing rule would be two answers to what one gesture is.
///
/// `read` produces the state as text and `write` becomes it. `applying` is per
/// track rather than shared: putting an edit back fires the model's change
/// channel and putting the settings back fires the encode side's, and a shared
/// flag would have one track swallowing the other's steps for as long as the
/// first was mid-apply.
function track(read, write) {
    const past = [];
    const future = [];
    let baseline = '';
    let lastKind = '';
    let lastAt = 0;
    let applying = false;

    /// Start counting from wherever the application is now, keeping nothing.
    const reset = () => {
        past.length = 0;
        future.length = 0;
        baseline = read();
        lastKind = '';
        lastAt = 0;
        announce();
    };

    /// Take where things are now as the baseline, keeping the steps already in
    /// hand. For a change nobody made: arriving on the encode side fills in a
    /// path and a size from the timeline, and an undo that offered to go back to
    /// "no filename" would be offering to undo the act of walking over there.
    const rebase = () => { baseline = read(); };

    const record = (what) => {
        if (applying) return;
        // A drag in flight. Ignored rather than coalesced, because the pair is
        // explicit — the `moved` that ends it is the step, and it wants the
        // state from before the first `move`, which is what leaving `baseline`
        // alone gives it.
        if (what === 'move') return;

        const now = read();
        if (now === baseline) return;

        const at = Date.now();
        const runOn = what === lastKind && at - lastAt < COALESCE && past.length > 0;
        lastKind = what;
        lastAt = at;
        if (runOn) { baseline = now; return; }

        past.push(baseline);
        if (past.length > LIMIT) past.shift();
        future.length = 0;
        baseline = now;
        announce();
    };

    const apply = (text) => {
        applying = true;
        try {
            write(JSON.parse(text));
        } finally {
            applying = false;
        }
        // A gesture cannot run on across an undo: the next change is a new step
        // whatever kind it is, or `Ctrl-Z` followed by one more nudge of the same
        // slider would fold the nudge into the state that was just restored.
        lastKind = '';
        lastAt = 0;
        announce();
    };

    return {
        reset,
        rebase,
        record,
        canUndo: () => past.length > 0,
        canRedo: () => future.length > 0,
        depth: () => past.length,
        undo() {
            if (!past.length) return false;
            future.push(baseline);
            baseline = past.pop();
            apply(baseline);
            return true;
        },
        redo() {
            if (!future.length) return false;
            past.push(baseline);
            baseline = future.pop();
            apply(baseline);
            return true;
        },
    };
}

/// The edit: a document **minus its `output`**, which is the other track's, and
/// **minus its `session`**, which is nobody's.
///
/// `open()` reconciles rather than rebuilds, so a state where one clip's crop
/// differs costs one clip's worth of work and the elements playing the others
/// never learn anything happened.
///
/// **This is where a step of history is defined, so this is where the session is
/// taken out.** A document holds where you were in it — the selected clip, the
/// playhead, the stage, the timeline's zoom — and every one of those is the
/// running application rather than the edit. Left in, all three of this file's
/// rules break at once: `now === baseline` stops meaning "the edit is unchanged",
/// so scrubbing becomes a hundred steps and a genuine edit made after one gets
/// coalesced into it; the stack fills with states that differ in nothing anybody
/// did; and `Ctrl-Z` starts answering with a playhead somewhere else and possibly
/// a different stage, which is the one thing the two tracks exist to prevent.
///
/// Stripped **here rather than in `snapshot()`**, and that is the whole point:
/// `snapshot()` is the document and the document does hold a session. Stripped in
/// `open()` instead would be the other wrong home — it would make an *Open*
/// unable to restore one, which is the feature. So it is taken out at the one
/// place that says what a *step* is, beside `output`, which is out for the same
/// shape of reason and a weaker one.
const edit = track(
    () => {
        const d = snapshot();
        delete d.output;
        delete d.session;
        return JSON.stringify(d);
    },
    (d) => open(d));

/// The Encode and Write stages: the `output` key on its own.
///
/// `store.adopt` is the reader, which is the same one a document and the
/// workspace go through — so a state put back here is sanitised exactly as one
/// read off the disk is, and there is one answer to what a stored container
/// means. `DOCUMENT_KEYS` and not `REMEMBERED`, because the range and the path
/// are settings somebody set and are as undoable as a codec.
const output = track(
    () => JSON.stringify(snapshot().output || {}),
    (blob) => {
        store.adopt(blob, store.DOCUMENT_KEYS);
        for (const fn of restorers) fn();
    });

// What has to redraw when the settings are put back. A list rather than a call,
// because this file must not know what the encode side is made of: `ui/app.js`
// registers the redraw, exactly as it registers the one for an edit.
const restorers = [];
export function onOutputRestored(fn) { restorers.push(fn); }

/// Start counting from wherever the application is now — after boot, after a
/// document is opened, after New. Anything earlier is not a step this history
/// could honestly offer to go back to: it belongs to a different edit. Both
/// tracks, because a document carries both halves.
export function reset() {
    edit.reset();
    output.reset();
}

/// Which track a press belongs to. **The stage decides**, which is the whole of
/// why there are two — see the header.
const trackFor = (which) => (which === 'output' ? output : edit);

export const canUndo = (which) => trackFor(which).canUndo();
export const canRedo = (which) => trackFor(which).canRedo();
export const depth = (which) => trackFor(which).depth();

/// The edit changed. `what` is the kind off the model's or the overlay's change
/// channel, and it is used for two things only: `move` is a drag in flight and
/// is not a step, and two of a kind in quick succession are one step. Everything
/// else about which changes matter is decided by comparing the states, which is
/// the answer that cannot drift out of step with what a document holds.
export function record(what) { edit.record(what); }

/// The settings changed — `onSettingsChange` in `ui/export/state.js`, which is
/// the one channel saying so. One kind rather than several: the three hooks
/// there are three consequences of the same fact, and a step is decided by
/// comparing states either way. `settings` is a kind of its own so that a run of
/// them coalesces without a nudge of a quality slider being folded into a clip
/// drag that happened to be half a second earlier.
export function recordOutput() { output.record('settings'); }

/// Take the settings as they are now as the baseline. Called on the way on to
/// the encode side, where a path and a size are filled in from the timeline.
export function rebaseOutput() { output.rebase(); }

export function undo(which) { return step(which, true); }
export function redo(which) { return step(which, false); }

function step(which, back) {
    const t = trackFor(which);
    if (!(back ? t.undo() : t.redo())) return false;
    // An undo leaves the edit different from the file it was read out of, and
    // says so. It can be wrong in the harmless direction — undoing all the way
    // back to what was saved still reads as modified — which is the same trade
    // the marker makes everywhere else. True of the settings too: they are in
    // the document.
    touch();
    return true;
}
