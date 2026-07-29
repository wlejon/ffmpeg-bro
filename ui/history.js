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
// **A state is a document minus its `output`.** Undo is about the *edit* — the
// clips, the inputs, the canvas, the graph — and not about the Encode and Write
// stages, which are a form. Three reasons, and the third is what settles it:
// a control you have just changed is in front of you with its old value one
// keystroke away, so undo buys nothing there; a `Ctrl-Z` pressed on the timeline
// that silently reverted a codec three stages away would be worse than no undo
// at all; and the encode side has three change hooks meaning three different
// things and no single "the settings changed" channel, so recording it reliably
// would mean building that channel first and then getting the behaviour I did
// not want.
//
// **A state is held as text.** `JSON.stringify` of the snapshot, not the object.
// That is three things at once: comparing two states is `===`, so a change that
// changed nothing is dropped rather than becoming a step that appears to do
// nothing when it is undone; a hundred of them is a few hundred kilobytes rather
// than a hundred live object graphs; and `JSON.parse` on the way out is
// inherently a fresh object, which matters because `overlay.adopt()` takes its
// `locks`, `sizes` and `pins` bags by reference and would otherwise edit the
// history in place.
//
// **A gesture is one step, not a hundred.** A clip dragged along the timeline
// arrives as `move` per mouse position and one `moved` at the end, so `move` is
// ignored outright and the `moved` records the state from before the drag began.
// A slider has no such pair — the inspector reports `edit` on every pixel — so
// changes of the same kind arriving within half a second of each other are
// folded into the step the run started with. The failure that rule prevents is
// the one every editor without it has: forty presses of `Ctrl-Z` to get back
// past one drag of a crop handle.

import { snapshot, open, touch } from './document.js';

/// How many steps back. A state is a few kilobytes of text for an ordinary edit,
/// so this is about a megabyte at worst — chosen as "further than anybody
/// reaches" rather than measured, because the thing being traded against is
/// memory nobody notices.
const LIMIT = 100;

/// How close together two changes of the same kind have to be to count as one
/// gesture. Long enough to cover a slider being dragged in stops, short enough
/// that two deliberate presses of the same key are two steps.
const COALESCE = 500;

const past = [];
const future = [];
let baseline = '';
let lastKind = '';
let lastAt = 0;

// True while a state is being put back, so that the change channels an `open()`
// fires do not record the undo as a new edit.
let applying = false;

const listeners = [];

/// Start counting from wherever the application is now — after boot, after a
/// document is opened, after New. Anything earlier is not a step this history
/// could honestly offer to go back to: it belongs to a different edit.
export function reset() {
    past.length = 0;
    future.length = 0;
    baseline = state();
    lastKind = '';
    lastAt = 0;
    announce();
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;
export const depth = () => past.length;

/// Told whenever there is something new to be able to say — which is a button's
/// enabled state and nothing else, so it is coarse on purpose.
export function onChange(fn) { listeners.push(fn); }

function announce() { for (const fn of listeners) fn(); }

function state() {
    const d = snapshot();
    // The one key a history state does not carry. See the header: undo is about
    // the edit, and this is the form.
    delete d.output;
    return JSON.stringify(d);
}

/// Something changed. Decides whether that is a step.
///
/// `what` is the kind off the model's or the overlay's change channel, and it is
/// used for two things only: `move` is a drag in flight and is not a step, and
/// two of a kind in quick succession are one step. Everything else about which
/// changes matter is decided by comparing the states, which is the answer that
/// cannot drift out of step with what a document holds.
export function record(what) {
    if (applying) return;
    // A drag in flight. Ignored rather than coalesced, because the pair is
    // explicit here — the `moved` that ends it is the step, and it wants the
    // state from before the first `move`, which is what leaving `baseline`
    // alone gives it.
    if (what === 'move') return;

    const now = state();
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
}

/// Back one step. Returns false when there is nowhere to go, so the caller can
/// say so rather than doing nothing visible.
export function undo() {
    if (!past.length) return false;
    future.push(baseline);
    baseline = past.pop();
    apply(baseline);
    return true;
}

export function redo() {
    if (!future.length) return false;
    past.push(baseline);
    baseline = future.pop();
    apply(baseline);
    return true;
}

function apply(text) {
    applying = true;
    try {
        // Parsed here rather than held as objects — see the header. The document
        // reader takes what it is given and the overlay keeps some of it by
        // reference, so a state applied twice has to be a new object both times.
        open(JSON.parse(text));
    } finally {
        applying = false;
    }
    // An undo leaves the edit different from the file it was read out of, and
    // says so. It can be wrong in the harmless direction — undoing all the way
    // back to what was saved still reads as modified — which is the same trade
    // the marker makes everywhere else.
    touch();
    // A gesture cannot run on across an undo: the next change is a new step
    // whatever kind it is, or `Ctrl-Z` followed by one more nudge of the same
    // slider would fold the nudge into the state that was just restored.
    lastKind = '';
    lastAt = 0;
    announce();
}
