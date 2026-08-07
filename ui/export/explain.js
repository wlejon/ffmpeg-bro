// The stage's reasoning, one press away instead of permanently on the screen.
//
// This application explains itself, and that is not a habit to be trimmed: a
// copy can only begin at a keyframe, `tee` is one encode to several places and
// `Also write` is several encodes of one edit, an attachment is what makes a
// styled subtitle look the same on a second machine. Every one of those is a
// sentence somebody needs, and needs *once*.
//
// What they were was permanent. The Write stage drew eight paragraphs against
// twelve controls, every draw, whether or not anybody had ever read one — so the
// prose was the page and the controls were what you hunted through it for, and
// the reasoning stopped being read for exactly the reason it was written.
//
// **So a note is folded, and nothing is deleted.** Every section carries an ⓘ,
// off by default; pressing it puts that section's explanations back, word for
// word, where they were. The choice is remembered in the workspace, so a person
// who wants the essay gets it on every stage they open from then on, and a
// person who has read it once never sees it again.
//
// Two rules about what belongs behind the fold, and the second is the one that
// keeps this honest:
//
//   - **An explanation folds.** It says how a thing works and why it is shaped
//     that way — "a copied stream is the packets that are already in the file".
//     It is the same sentence on every render.
//   - **A statement never does.** What *this* row's numbers do, why a control is
//     absent, what a setting has cost — "216 keyframes, so the copy starts at
//     4.00 s and not the 4.50 you asked for", "the mp4 muxer holds no subtitle
//     codec this build can write". Those change with the settings, they are the
//     answer to a question somebody is holding right now, and hiding one would
//     be an application that knew something and did not say it. `ex-note` and
//     `ex-copy-note` are still what those are drawn as.
//
// The line between them is drawn by hand, note by note, because it is a
// judgement about each sentence and no class name could make it.

import { el, div, span } from '../dom.js';

// Its own key rather than a field in the export blob: `ui/export/store.js` holds
// what the *render* is set to, and every key in it reaches a spec. Whether
// somebody wants the prose is a fact about the person, not about the file being
// written, and a document carrying it would be a document that reformatted
// somebody else's stage.
const KEY = 'ffmpeg-bro.explain';

let all = false;
let open = new Set();
let loaded = false;
const listeners = [];

/// Version-tolerant, like every other read of the workspace: what is in there
/// was written by an earlier version of this file and the keys it names may not
/// exist any more. An unknown key costs nothing — it simply never matches a
/// section — so the read takes what it is given and sanitises only the shape.
function load() {
    if (loaded) return;
    loaded = true;
    try {
        const blob = JSON.parse(localStorage.getItem(KEY) || '{}');
        all = blob.all === true;
        open = new Set(Array.isArray(blob.open) ? blob.open.filter((k) => typeof k === 'string')
                                                : []);
    } catch (e) { /* first run, or a blob from an older shape */ }
}

function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ all, open: Array.from(open) }));
    } catch (e) { /* a workspace that cannot be written is not a reason to fail */ }
}

/// Redraw when the disclosure changes.
///
/// A callback rather than an import of `drawStreams`, because the stage's three
/// panels are three modules and this one is imported by all of them: reaching
/// back for any of their draw functions would be a cycle, and reaching for all
/// three would make this file know the stage's layout.
export function onExplainChange(fn) { listeners.push(fn); }

const fire = () => { save(); for (const fn of listeners) fn(); };

/// Is this section's reasoning showing?
export function explaining(key) { load(); return all || open.has(key); }

/// Is *anything* explaining itself?  What the master control draws itself from.
///
/// Deliberately "any" and not "all". The master is a quiet-everything switch,
/// and a button reading `ⓘ Explain` above a screen with fourteen paragraphs on
/// it — which is what "all" would say the moment one section was turned back
/// off — would be a control lying about the state it is in. Read this way it is
/// always true: pressing it when it is lit puts the prose away, whatever mixture
/// of presses got it there.
export function explainingAny() { load(); return all || open.size > 0; }

// Every section key on this stage, in one list, so that the master control and
// `toggleExplain`'s "all but this one" have something to be a set of. A key
// nothing draws is harmless and a key nothing declares here simply misses the
// master press, which is why they are together rather than beside their sections.
export const SECTIONS = [
    // The Destination column.
    'destination', 'keep-trying', 'versions', 'tee',
    // A stream row's facets, which is what a `.ex-facets` strip's ⓘ names.
    'span', 'naming', 'flags', 'metadata', 'packets', 'attachment',
    // And the sections of the stream column that are not a row.
    'rewrap', 'chapters', 'file-metadata',
];

/// Turn one section's reasoning on or off.
export function toggleExplain(key) {
    load();
    // **Turning one off while everything is on leaves the rest on.** The
    // alternative — a section-level "off" that overrides the master — would be a
    // third state to hold and to draw, and the press people actually make after
    // switching the master on is "not this one, thanks". So the master flag is
    // spent into the explicit set and the one press is honoured.
    if (all) {
        all = false;
        open = new Set(SECTIONS.filter((k) => k !== key));
    } else if (open.has(key)) open.delete(key);
    else open.add(key);
    fire();
}

/// Explain everything, or put all of it away.
export function toggleExplainAll() {
    load();
    // Off whenever anything is on, which is what makes it the one press that
    // always quiets the stage — see `explainingAny`.
    if (all || open.size) { all = false; open.clear(); } else all = true;
    fire();
}

/// The reasoning itself: one node per paragraph, or nothing at all.
///
/// Returns an array so that a caller can drop it straight into a list — `add()`
/// flattens and skips nulls, so `[...rows, why('copy', a, b)]` is the whole of
/// what a call site has to say.
export function why(key, ...texts) {
    return null;
}

/// The ⓘ itself, for a section whose heading is something other than a heading.
///
/// The stream rows' facet strip is the case: what divides that panel is a row of
/// buttons choosing which part of the stream is being edited, and a `.section-head`
/// under it would be a second heading for the thing the strip has already named.
export function whyButton(key) {
    const on = explaining(key);
    return el('button', {
        cls: 'ex-why-b' + (on ? ' on' : ''),
        text: 'ⓘ',
        'data-why': key,
        title: on ? 'Hide what this section is about'
                  : 'What this section is about, and why it is shaped this way',
        on: { click: (e) => { e.stopPropagation(); toggleExplain(key); } },
    });
}

/// A section heading with its own ⓘ.
///
/// The same `.section-head` every other column is divided by, plus the control:
/// the disclosure belongs *on* the heading rather than beside the first
/// paragraph, because with the fold shut there is no paragraph for it to be
/// beside and a control that moves when it is pressed is a control people press
/// twice.
export function explained(key, title, opts = {}) {
    return el('div', Object.assign({ cls: 'section-head ex-head' }, opts), [
        span(title, 'ex-head-t'),
        whyButton(key),
    ]);
}

/// The master control: every section at once.
///
/// One press, because "explain this application to me" is one decision and
/// twenty ⓘs is not where somebody new should have to find it. It says which way
/// it will go rather than which way it is, for the reason every other toggle on
/// this stage does.
export function explainAllButton() {
    const on = explainingAny();
    return el('button', {
        cls: 'ex-why-all' + (on ? ' on' : ''),
        text: on ? 'ⓘ Explaining' : 'ⓘ Explain',
        'data-f': 'explain-all',
        title: on ? 'Put the explanations away — each section keeps its own ⓘ'
                  : 'Show what every section on this stage is about',
        on: { click: () => toggleExplainAll() },
    });
}
