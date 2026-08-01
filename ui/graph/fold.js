// The graph as it is drawn when there is more of it than anybody can read.
//
// The derivation makes about nine nodes per clip — an `-i`, a `trim`, a
// `setpts`, a `scale`, a `format`, an `atrim`, an `asetpts`, an `adelay`, and
// an `overlay` into the composite — which is exactly right and is the whole
// point of the stage: the graph is the render, named the way ffmpeg names it.
// It is also 679 cards at seventy-five clips, and 679 cards is not a picture of
// anything. Nobody reads the ninth `trim`; what they came to find out is which
// clip is which and what somebody put in the middle of one.
//
// So a clip's derived run is drawn as **one card that says what it stands for**,
// and opening it puts the run back. This is a fold in the *view* and nowhere
// else: `derive.js` still makes the whole graph, `print.js` still prints the
// whole graph, the render is unchanged, and the command bar along the bottom is
// the same chains it always was. What the fold changes is how many rectangles
// are on the screen.
//
// Four rules, and three of them are about not hiding anything.
//
// **A run holding work of yours is never folded.** A node you inserted, a node
// you locked, and a node the checker has a problem with are the three things on
// this stage that are *not* derivable from the timeline — they are the reason
// the stage exists — and folding one out of sight would be the application
// quietly losing your edit. So a run containing any of them stays open however
// large the graph is, and the toolbar says how many did.
//
// **A fold names what it folded.** The card carries the filters in order, so
// `trim → setpts → scale → format` is on the screen as text where four cards
// used to be; it is a smaller statement of the same fact rather than the fact
// going away.
//
// **The input goes in only when it is this clip's alone.** An `-i` feeding two
// clips cannot belong to either of them, and a fold that swallowed it would draw
// one file as two. So a run takes its input node when that node feeds nothing
// else, which is the montage case — one segment per file — and leaves it outside
// when the same file is cut twice, which is the case a person is most likely to
// be looking at the graph to understand.
//
// **An insert point inside a fold is not offered.** A `+` on a wire that is not
// drawn would be a press with nowhere to land. The count is on the card instead
// and opening the fold brings the points back with the wires.
//
// The fold is not a level of detail. `view.js` already has one of those — below
// `LOD_ZOOM` the card bodies are not built — and it is a different question:
// that one is about how much room a card has, this one is about how many cards
// there should be. Zooming in on a folded graph gets you readable folds, not the
// runs back.

import { makeGraph, streamsOf } from './model.js';

/// Over this many nodes the stage folds unless somebody has said otherwise.
///
/// About thirteen clips. Under it the graph fits on a screen and is the picture
/// of the render this stage was built to be; over it the cards are already too
/// small to read at any zoom that shows more than a handful, so the fold is the
/// only view that answers anything. Not a preference, because a number nobody
/// can predict the effect of is not a setting — the toolbar says what it did and
/// the toggle is one press.
export const FOLD_OVER = 120;

/// Which clip a derived node belongs to, or '' for anything that is not part of
/// one — the composite's overlays, the mix, the sinks, and every node somebody
/// placed themselves.
///
/// The anchor and nothing else. `clip:7/trim` is a name `derive.js` wrote and
/// `ui/document.js` and the graph overlay both persist, so it is the one string
/// that means "the third filter of that shot" across two derivations. Deriving
/// the grouping from the wires instead would put a filter you dropped on a clip
/// into that clip's fold, which is precisely the node that must stay out.
export function clipOf(node) {
    if (!node || !node.derived || !node.anchor) return '';
    const m = /^(clip:[^/]+)\//.exec(node.anchor);
    return m ? m[1] : '';
}

/// The runs this graph could fold, as `key → { key, nodes, filters, input }`.
///
/// `filters` is what the card says and is in the order the derivation made them,
/// which is the order they run in and the order they print in. `input` is the
/// `-i` node where the run gets to take one.
export function runsOf(g) {
    const runs = new Map();
    for (const n of g.nodes) {
        const key = clipOf(n);
        if (!key) continue;
        const run = runs.get(key) ||
            (runs.set(key, { key, nodes: [], filters: [], input: null }).get(key));
        run.nodes.push(n);
        if (n.kind === 'filter') run.filters.push(n.filter);
        // An input anchored into the clip — `clip:7/in` — is a candidate, and
        // whether it is actually taken is decided below, once every run is
        // known.
        if (n.kind === 'input') run.input = n;
    }

    // A file read by more than one run belongs to none of them. Counted over the
    // whole graph rather than over one run, because the second reader is by
    // definition somewhere else.
    const readers = new Map();
    for (const run of runs.values())
        if (run.input) readers.set(run.input.id, (readers.get(run.input.id) || 0) + 1);
    for (const run of runs.values()) {
        if (!run.input) continue;
        // Wired to something outside this run counts as another reader too: a
        // filter of yours reading the file directly is a picture the fold must
        // not swallow.
        const mine = new Set(run.nodes.map((n) => n.id));
        const out = g.outEdges(run.input).some((e) => !mine.has(e.to));
        if (readers.get(run.input.id) > 1 || out) {
            run.nodes = run.nodes.filter((n) => n !== run.input);
            run.input = null;
        }
    }
    return runs;
}

/// Would folding this run hide something that is not derivable from the edit?
///
/// The three answers are the three things this stage is for. Returned as the
/// word rather than as a boolean so the toolbar can say which.
export function heldOpenBy(run, trouble) {
    for (const n of run.nodes) {
        if (!n.derived) return 'a filter of yours';
        if (n.locked) return 'a locked filter';
        if (trouble && trouble.has(n.id)) return 'a problem';
    }
    return '';
}

/// The graph to draw: `{ graph, folds, held, foldable }`.
///
/// `folds` maps a fold node's id to the run it stands for, so the card can name
/// what is inside and a click can open it. `held` counts the runs that would
/// have been folded and were not, with the reason. `foldable` is how many runs
/// there are at all, which is what the toolbar says when nothing is folded.
///
/// **A graph, not a description of one.** Everything downstream of here —
/// `layout()`, the cards, the sockets, the wires, the selection — asks the graph
/// questions (`producers`, `inEdges`, `outPorts`), so a fold that were merely a
/// list of hidden ids would have to be understood by every one of them. Building
/// the folded graph as an ordinary graph means none of them learns anything.
///
/// Ids and anchors are carried across unchanged, which is what keeps a pin, a
/// selection and a preview pointing at the same card either side of a fold.
export function fold(g, opts = {}) {
    const open = opts.open || new Set();
    const trouble = opts.trouble || new Map();
    const runs = runsOf(g);
    countPoints(runs, opts.points);
    const out = { graph: g, folds: new Map(), held: [], foldable: runs.size };
    if (!runs.size) return out;

    const folding = new Map();
    for (const run of runs.values()) {
        if (opts.enabled === false) break;
        if (open.has(run.key)) continue;
        const why = heldOpenBy(run, trouble);
        if (why) { out.held.push({ key: run.key, why }); continue; }
        // A run of one filter is not worth a card that says so.
        if (run.nodes.length < 2) continue;
        folding.set(run.key, run);
    }
    if (!folding.size) return out;

    // Which fold, if any, each node has gone into.
    const into = new Map();
    for (const run of folding.values())
        for (const n of run.nodes) into.set(n.id, run);

    const streams = streamsOf(g);
    const drawn = makeGraph();
    // Nodes first, in their original order, with a fold standing where its run's
    // first node stood — so the columns the layout computes come out in the same
    // left-to-right order the derivation made.
    const foldNode = new Map();
    for (const n of g.nodes) {
        const run = into.get(n.id);
        if (!run) { drawn.add(n); continue; }
        if (foldNode.has(run.key)) continue;
        const node = drawn.add({
            kind: 'fold',
            id: `fold/${run.key}`,
            anchor: `fold/${run.key}`,
            derived: true,
            // What it stands for, on the node, because the card is built from
            // the node and nothing else is handed to it.
            filter: run.filters.join(' → '),
            title: run.key,
            path: run.input ? run.input.path : '',
            index: run.input ? run.input.index : undefined,
            pos: [],
            params: {},
        });
        foldNode.set(run.key, node);
        out.folds.set(node.id, run);
    }

    // Then the wires. A wire with both ends inside one fold is gone; one with
    // an end inside is moved to the fold, on a pad of the fold's own — which is
    // per stream, because a clip's picture and its sound leave it separately and
    // a fold that put both on one pad would draw the mix reading the composite.
    const padOf = (node, stream, side) => {
        const list = side === 'out' ? (node.outs || (node.outs = []))
                                    : (node.ins || (node.ins = []));
        for (let i = 0; i < list.length; i++) if (list[i].stream === stream) return i;
        list.push({ stream });
        return list.length - 1;
    };
    const seen = new Set();
    for (const e of g.edges) {
        const from = into.get(e.from);
        const to = into.get(e.to);
        if (from && to && from.key === to.key) continue;
        const stream = streams.ofEdge(e) || 'v';
        const a = from ? foldNode.get(from.key) : drawn.node(e.from);
        const b = to ? foldNode.get(to.key) : drawn.node(e.to);
        if (!a || !b) continue;
        const fromPort = from ? padOf(a, stream, 'out') : (e.fromPort || 0);
        const port = to ? padOf(b, stream, 'in') : (e.port || 0);
        // Two runs of one clip can reach the same consumer by the same pad once
        // they are folded — the picture and the sound of a clip that goes
        // nowhere else — and a second identical wire is a second line drawn over
        // the first.
        const at = `${a.id}#${fromPort}>${b.id}#${port}`;
        if (seen.has(at)) continue;
        seen.add(at);
        drawn.connect(a, b, port, fromPort);
    }

    out.graph = drawn;
    return out;
}

/// How many insert points each run holds.
///
/// An insert point is a place on a *wire*, and the wires inside a fold are not
/// drawn — so the `+` would be an offer with nowhere to land, and `view.js`
/// already declines to draw one whose node has no box. What is left is saying
/// so: the card carries the count, because "there are two places inside this you
/// can put a filter" is the difference between a fold and a thing that ate your
/// options. They are not moved to the fold's own output instead — "after scale"
/// and "after this whole clip" are different places, and one of them quietly
/// becoming the other is the kind of wrong this stage exists to prevent.
function countPoints(runs, points) {
    const at = new Map();
    for (const run of runs.values()) {
        run.points = 0;
        for (const n of run.nodes) at.set(n.id, run);
    }
    for (const p of points || []) {
        const run = at.get(p.at);
        if (run) run.points++;
    }
}
