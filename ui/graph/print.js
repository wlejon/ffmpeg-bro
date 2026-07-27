// Nodes → the chains `-filter_complex` wants.
//
// ffmpeg's syntax is not a node list. It is a list of *chains*: a run of
// filters joined by commas, reading pads named in brackets at the front and
// naming pads in brackets at the back. Every pad inside a run is anonymous, so
// the same graph can be written many ways and only some of them are readable.
// This picks one, and picks it by the rule ffmpeg's own documentation uses:
//
//   **A run continues while the wire is private.** Node B is appended to A's
//   chain when B has exactly one input, that input is A, and A feeds nothing
//   else. The moment a pad is read twice, or read by a filter that is also
//   reading something else, it has to be given a name — and a named pad is
//   where one chain ends and the next begins.
//
// That rule is why `overlay` always starts a chain (it has two inputs) and why
// the conversion into the encoder's colour space rides on the back of the last
// overlay rather than standing alone (one input, one producer, one consumer).
// It is not a formatting preference: it is the smallest set of names the graph
// can be written with, which is the version a person can read.
//
// Labels come from the nodes. Only a chain-final node needs one, and derive.js
// puts them exactly there — `base`, `v0`, `o0`, `vout`, `a0`, `aout`. A chain
// that ends somewhere unlabelled still has to be printable, so one is invented;
// that never happens for a derived graph and it is not worth crashing over if
// a hand-built one does it.

/// One node as ffmpeg would write it: positional arguments first, then named
/// ones, colon-separated. A filter with neither is bare — `null` and `anull`
/// take no arguments at all and `anull=` is a parse error, not a no-op.
export function filterArgs(node) {
    const parts = node.pos.map(String);
    for (const k of Object.keys(node.params)) parts.push(`${k}=${node.params[k]}`);
    return parts.length ? `${node.filter}=${parts.join(':')}` : node.filter;
}

/// What a pad is called when something has to name it. An input node names the
/// stream ffmpeg gave it; a filter node names its own label.
function padOf(node, invented) {
    if (!node) return '';
    if (node.kind === 'input') return `${node.index}:${node.stream}`;
    if (node.label) return node.label;
    return invented(node);
}

/// Does this node have to start a chain, rather than being appended to one?
///
/// Anything but "exactly one producer, itself a filter, feeding only me".
/// A filter reading an input node starts a chain because the `[0:v]` in front
/// of it is a name; a filter with two producers starts one because there is no
/// single run it could be the continuation of.
function startsChain(g, node) {
    const ps = g.producers(node);
    if (ps.length !== 1) return true;
    if (ps[0].kind !== 'filter') return true;
    return g.consumers(ps[0]).length !== 1;
}

/// A graph → `{ chains, inputs, video, audio }`.
///
/// `chains` is unjoined, so a caller can lay them out one per line or all on
/// one — the command bar does both, depending on whether it is open.
export function print(g) {
    let invented = 0;
    const names = new Map();
    const nameFor = (node) => {
        if (!names.has(node.id)) names.set(node.id, `x${invented++}`);
        return names.get(node.id);
    };

    const chains = [];
    const done = new Set();

    for (const node of g.nodes) {
        if (node.kind !== 'filter' || done.has(node.id)) continue;
        if (!startsChain(g, node)) continue;

        // Walk forward while the wire stays private. `done` is checked inside
        // the loop as well as outside it, because a cycle in a hand-built graph
        // should print something wrong rather than hang.
        const run = [node];
        done.add(node.id);
        for (;;) {
            const cons = g.consumers(run[run.length - 1]);
            if (cons.length !== 1) break;
            const next = cons[0];
            if (next.kind !== 'filter' || done.has(next.id)) break;
            if (g.producers(next).length !== 1) break;
            run.push(next);
            done.add(next.id);
        }

        const head = g.producers(run[0]).map((p) => `[${padOf(p, nameFor)}]`).join('');
        const tail = `[${padOf(run[run.length - 1], nameFor)}]`;
        chains.push(head + run.map(filterArgs).join(',') + tail);
    }

    // The files, by the index the input nodes were given. Taken from the nodes
    // rather than passed alongside them so the graph stays the whole story:
    // `[2:v]` in a chain and `-i` number two are the same fact stated twice,
    // and two statements of one fact are two things that can disagree.
    const inputs = [];
    for (const node of g.nodes)
        if (node.kind === 'input' && node.path) inputs[node.index] = node.path;

    // A sink does not impose a name, it reports one. With a single audible clip
    // there is no mixer and the pad the muxer maps is that clip's own `[a0]` —
    // naming it `aout` here would print a pad that no chain produces.
    const pad = (stream) => {
        for (const node of g.nodes) {
            if (node.kind !== 'sink' || node.stream !== stream) continue;
            const src = g.producers(node)[0];
            if (src) return `[${padOf(src, nameFor)}]`;
        }
        return null;
    };

    return { chains, inputs, video: pad('v'), audio: pad('a') };
}
