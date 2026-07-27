// What is wrong with this graph, said in sentences that name the node.
//
// While the only graph on the screen was the one the derivation built, this
// file had nothing to do: a derivation produces one shape, every pad it makes
// is wired the moment it is made, and the printer was written against exactly
// that. A graph anybody can wire produces shapes nobody wrote the printer for —
// a pad feeding two filters, a node with an empty input, a `split` whose second
// output goes nowhere, two nodes feeding each other in a circle.
//
// **The rule is refusal, not approximation.** It is the same rule the
// derivation already follows and it is the whole value of printing a command:
// a filtergraph is worth showing because it can be copied somewhere else and
// run, and one that ffmpeg would reject is worse than no graph at all, because
// it looks like one. So every shape below is something ffmpeg itself refuses,
// and each answer names the node and says what to do about it.
//
// They are checked here rather than in `print.js` because printing and running
// are not the only things that ask. `subgraph.js` prints a *pruned* view where
// half the outputs deliberately go nowhere — that is what cutting a graph off
// at a node means — so a printer that refused would refuse every preview. The
// full graph is the only thing these questions are meaningful about.

import { streamsOf, keyOf } from './model.js';
import { padsOf } from './filters.js';
import { supportsTimeline } from './enable.js';

/// What to call a node in a sentence. A filter is its own name; the two ends
/// are named the way their cards are, because that is what the person is
/// looking at.
export function nameOf(n) {
    if (!n) return 'a node';
    // An input the graph reads on its own account carries the name of the input
    // it is, because "input 3" is a number in a list nobody has in front of them
    // and "logo.png" is the thing they placed.
    if (n.kind === 'input') return n.title ? `${n.title} (input ${n.index})` : `input ${n.index}`;
    if (n.kind === 'sink') return n.stream === 'a' ? 'audio out' : 'video out';
    return n.filter || 'a filter';
}

const ordinal = (i, of) => (of > 1 ? `input ${i + 1} of ${of}` : 'input');

/// Every problem in `g`, in node order. Empty means it prints and runs.
///
/// `stranded` is what the overlay could not put back — a wire whose pad the node
/// no longer has, because the option that decides its pad count was changed
/// under it. Passed in rather than found here: only the thing that applied the
/// overlay knows what it could not apply, and a wire that is not in the graph
/// cannot be discovered from the graph.
export function problems(g, stranded = []) {
    const out = [];
    const say = (node, reason) => out.push({ key: keyOf(node), id: node ? node.id : null,
                                             node, reason });
    const streams = streamsOf(g);

    for (const n of g.nodes) {
        // A filter this build does not have is not a shape at all — there is no
        // pad list to check and no chain that could run. Said first because
        // every other complaint about such a node would be noise.
        if (n.kind === 'filter' && !padsOf(n.filter, n.params, n.pos)) {
            say(n, `libavfilter in this build has no filter called “${n.filter}”`);
            continue;
        }

        // **`enable` on a filter that has no timeline support is refused by
        // libavfilter, not ignored.** `set_enable_expr` checks
        // AVFILTER_FLAG_SUPPORT_TIMELINE and returns AVERROR_PATCHWELCOME, so a
        // graph carrying one fails as it is built and the render produces
        // nothing. The panel does not offer a strip for such a filter; this is
        // for the value arriving the other way — typed into the raw field, or
        // moved onto a filter it does not suit — where the alternative is a
        // render that stops with libavfilter's own wording and no node named.
        if (n.kind === 'filter' && n.params.enable !== undefined &&
            String(n.params.enable) !== '' && !supportsTimeline(n.filter))
            say(n, `${nameOf(n)} has no timeline support in this build, so enable= on it ` +
                   'is refused when the graph is built — libavfilter will not run it');

        const ins = g.inPorts(n);
        const arriving = g.inEdges(n);
        for (let p = 0; p < ins; p++) {
            const at = arriving.filter((e) => (e.port || 0) === p);
            if (!at.length)
                say(n, n.kind === 'sink'
                    ? `nothing is wired to ${nameOf(n)}, so the render has no ${
                        n.stream === 'a' ? 'sound' : 'picture'} to write`
                    : `${nameOf(n)} has nothing wired to its ${ordinal(p, ins)}`);
            // Two wires into one pad is not a mix, it is a graph with no answer
            // to which one arrives — and nothing in this application can make
            // one, so it is here for a hand-edited overlay rather than for a
            // gesture.
            else if (at.length > 1)
                say(n, `two wires arrive at ${nameOf(n)}’s ${ordinal(p, ins)}`);
            // The stream check is the one that catches a wire nobody would draw
            // on purpose and everybody draws once: a picture dropped on
            // `amix`, a sound dropped on `overlay`. libavfilter's own message
            // for it names a pad index and no filter.
            else if (n.ins && n.ins[p]) {
                const carried = streams.ofEdge(at[0]);
                const wanted = n.ins[p].stream;
                if (carried && wanted && carried !== wanted)
                    say(n, `a ${carried === 'a' ? 'sound' : 'picture'} wire arrives at ` +
                           `${nameOf(n)}’s ${ordinal(p, ins)}, which takes ` +
                           `${wanted === 'a' ? 'sound' : 'a picture'}`);
            }
        }

        const outs = g.outPorts(n);
        const leaving = g.outEdges(n);
        for (let p = 0; p < outs; p++) {
            const at = leaving.filter((e) => (e.fromPort || 0) === p);
            const pad = outs > 1 ? `output ${p + 1} of ${outs}` : 'output';
            // ffmpeg's parser will not run a graph with a pad hanging off it,
            // and this is also the state a node sits in for the moment between
            // being placed and being wired — so it has to read as "not finished
            // yet" rather than as an accusation.
            if (!at.length) {
                // **An input's pads are ffmpeg's, not a filter's.** `[1:v]` and
                // `[1:a]` are labels on a demuxer's streams, and a label nothing
                // references is ordinary: a logo opened for its picture does not
                // have to have its sound consumed by something. So an unread pad
                // on an input is only worth a word when *none* of them is read —
                // the file would then be opened and thrown away, which is also
                // the state a source sits in between being placed and being
                // wired.
                if (n.kind !== 'input') say(n, `nothing reads ${nameOf(n)}’s ${pad}`);
                else if (!leaving.length && p === 0)
                    say(n, `nothing reads ${nameOf(n)} — wire one of its pads, ` +
                           'or it is opened for nothing');
            }
            // **The one people are surprised by.** A pad can be read once.
            // Reading it twice is what `split` is for, and ffmpeg says "Label
            // found twice" about a graph it has already half-parsed.
            else if (at.length > 1)
                say(n, `${nameOf(n)}’s ${pad} is read by ${at.length} filters — ` +
                       `a pad can only be read once, so put ` +
                       `${streams.of(n) === 'a' ? 'an asplit' : 'a split'} in between`);
        }
    }

    for (const s of stranded) {
        const node = s.node;
        const has = node ? g.inPorts(node) : 0;
        say(node, `${nameOf(node)} has ${has} input${has === 1 ? '' : 's'}, so your wire ` +
                  `at input ${s.port + 1} has nowhere to land — raise its input count to ` +
                  `keep it, or delete the wire`);
    }

    for (const cycle of cycles(g))
        say(cycle[0], `these feed each other in a circle: ${cycle.map(nameOf).join(' → ')} → ` +
                      `${nameOf(cycle[0])}`);

    return out;
}

/// The loops, one node list each.
///
/// A depth-first walk with a colouring, which is the standard one and is worth
/// spelling out here rather than relying on the fixed-point relaxations
/// elsewhere: `depths()` and `streamsOf()` both survive a cycle by giving up
/// after a bounded number of passes, which draws *something* and never says
/// what. A cycle has to be named, because it is the one shape where every other
/// complaint the checker makes is a consequence rather than the cause.
function cycles(g) {
    const state = new Map();          // 0 unvisited, 1 on the stack, 2 done
    const found = [];
    const stack = [];

    const walk = (n) => {
        state.set(n.id, 1);
        stack.push(n);
        for (const e of g.outEdges(n)) {
            const next = g.node(e.to);
            if (!next) continue;
            const s = state.get(next.id) || 0;
            if (s === 1) {
                const at = stack.findIndex((x) => x.id === next.id);
                if (at >= 0) found.push(stack.slice(at));
            } else if (s === 0) walk(next);
        }
        stack.pop();
        state.set(n.id, 2);
    };

    for (const n of g.nodes) if (!state.get(n.id)) walk(n);
    return found;
}
