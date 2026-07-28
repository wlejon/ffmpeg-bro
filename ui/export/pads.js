// A stream fed by a named output pad of the filter graph.
//
// The counterpart of `copy.js` and `subtitles.js` one source-form over, and it
// is a separate file for the same reason those are: the decisions are different
// ones. A copied stream is packets out of a demuxer and a subtitle stream is
// cues out of a file; a **pad** stream is a picture or a sound the graph made,
// which means everything about it is a fact about the graph and nothing about
// it is a fact about an input.
//
// `pad:<label>` is `-map "[label]"` and nothing else. The label is a named
// output somebody placed on the Graph stage — `graph/overlay.js`'s `addOutput`
// — and the chain feeding it is printed ending in that label, which is what
// makes the printed command and the render one thing rather than two.
//
// **Read out of the overlay rather than out of a derivation.** The outputs are
// what a person placed; a derivation is a function of them and of the timeline,
// costs a whole spec to build, and would answer differently across a redraw in
// which nothing about the outputs had changed. What the *derivation* is asked
// is a different question and it is asked in `warnings.js`: whether the pad a
// row names is one this graph actually produces.

import { settings } from './state.js';
import { outputs as overlayOutputs } from '../graph/overlay.js';

/// `pad:left` → `left`, or null for anything that is not one.
export function parsePad(source) {
    const m = /^pad:(.+)$/.exec(String(source || ''));
    return m ? m[1] : null;
}

export function isPad(row) { return !!parsePad(row && row.source); }

export const padSource = (name) => `pad:${name}`;

/// Every named output a row of this kind could be fed from.
///
/// An output nobody has wired yet has no stream — a pad is a picture or a sound
/// and placing one says neither — so it is offered for both. That is honest
/// rather than lax: wiring it decides, and `check.js` names the mismatch if the
/// wire and the row then disagree.
export function padChoices(kind) {
    const want = kind === 'audio' ? 'a' : 'v';
    return overlayOutputs()
        .filter((n) => n.name && (!n.stream || n.stream === want))
        .map((n) => ({ id: padSource(n.name), name: n.name,
                       label: `the graph’s [${n.name}]` }));
}

/// An output that has been renamed takes the rows fed from it with it.
///
/// **One fact in two places is the failure.** A row left pointing at the old
/// label would be refused by the renderer with a sentence about a pad that no
/// longer exists — for a rename that changed nothing about the graph and that
/// nobody would connect to a stream on another stage. Called where the rename
/// commits, in `graph/panel.js`, because that is the moment the two have to move
/// together.
export function renamePad(from, to) {
    if (!from || !to || from === to) return;
    for (const s of settings.streams || [])
        if (parsePad(s.source) === from) s.source = padSource(to);
}
