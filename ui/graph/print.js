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
// puts them exactly there — `base`, `v0`, `o0`, `vout`, `a0`, `aout` — plus
// whatever a named output on the end of a run is called. A chain that ends
// somewhere unlabelled still has to be printable, so one is invented; that
// never happens for a derived graph and it is not worth crashing over if a
// hand-built one does it.
//
// **A chain ends in one label per pad the last filter writes.** For everything
// but `split`, `asplit` and `concat` that is one, which is why this reads as it
// always did — but a fork named by a single label declares a destination for
// its first pad and none for its second, and libavfilter refuses the whole
// graph over the one nothing is connected to. So a node's `label` is the
// single-output case and `outLabels` is the per-pad one.

/// One node as ffmpeg would write it: positional arguments first, then named
/// ones, colon-separated. A filter with neither is bare — `null` and `anull`
/// take no arguments at all and `anull=` is a parse error, not a no-op.
export function filterArgs(node) {
    const parts = node.pos.map(String);
    for (const k of Object.keys(node.params)) parts.push(`${k}=${node.params[k]}`);
    return parts.length ? `${node.filter}=${parts.join(':')}` : node.filter;
}

/// How many pads a node writes. One unless it declared otherwise, which is
/// every filter but `split`, `asplit` and `concat`.
const outCount = (n) => (n.outs && n.outs.length ? n.outs.length : 1);

/// What a pad is called when something has to name it, given the output it is
/// read from. An input node names the file and the stream ffmpeg would give it
/// — `0:v` and `0:a` are two pads of one `-i`, which is why the port is a
/// parameter here and not a property of the node.
///
/// **A filter with more than one output cannot be named by one label either.**
/// `split[fork]` declares a destination for the first pad and none for the
/// second, and libavfilter refuses the whole graph over the one nothing is
/// connected to — so those are named per pad: out of `outLabels`, where a
/// named output supplied one, and invented otherwise. A node's own `label` is
/// the single-output case and stays exactly what it was.
function padOf(node, invented, fromPort = 0) {
    if (!node) return '';
    if (node.kind === 'input') {
        const out = node.outs && node.outs[fromPort];
        return `${node.index}:${out ? out.stream : node.stream || 'v'}`;
    }
    if (outCount(node) > 1)
        return (node.outLabels && node.outLabels[fromPort]) || invented(node, fromPort);
    if (node.label) return node.label;
    return invented(node, 0);
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

/// A graph → `{ chains, inputs, inputRefs, video, audio }`.
///
/// `chains` is unjoined, so a caller can lay them out one per line or all on
/// one — the command bar does both, depending on whether it is open.
export function print(g) {
    // Every name already spoken for, so an invented one cannot land on top of
    // it. A person may call an output `x0`, and two chains ending in one label
    // is a graph ffmpeg refuses ("Label found twice") — about a graph it has
    // already half parsed, so the message names nothing anybody placed. The
    // derivation moves its *own* colliding labels for the same reason; this is
    // the other half, for the names nobody chose.
    const taken = new Set();
    for (const node of g.nodes) {
        if (node.label) taken.add(node.label);
        for (const l of node.outLabels || []) if (l) taken.add(l);
        if (node.kind === 'sink' && node.name) taken.add(node.name);
    }
    let invented = 0;
    // Per *pad*, not per node: a `split` writes two of them and one name for
    // both would make the two readers of a fork read the same one.
    const names = new Map();
    const nameFor = (node, port) => {
        const at = `${node.id}#${port || 0}`;
        if (!names.has(at)) {
            let name;
            do { name = `x${invented++}`; } while (taken.has(name));
            taken.add(name);
            names.set(at, name);
        }
        return names.get(at);
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

        // The edges rather than the producers: two chains can read one input
        // node, and which pad each of them names is the edge's business.
        const head = g.inEdges(run[0])
            .map((e) => `[${padOf(g.node(e.from), nameFor, e.fromPort || 0)}]`).join('');
        // One label per pad the last filter writes, in port order — which for
        // everything but a `split` is the one it always was.
        const last = run[run.length - 1];
        let tail = '';
        for (let p = 0; p < outCount(last); p++) tail += `[${padOf(last, nameFor, p)}]`;
        chains.push(head + run.map(filterArgs).join(',') + tail);
    }

    // The files, by the index the input nodes were given. Taken from the nodes
    // rather than passed alongside them so the graph stays the whole story:
    // `[2:v]` in a chain and `-i` number two are the same fact stated twice,
    // and two statements of one fact are two things that can disagree.
    const inputs = [];
    // Which of the document's inputs each `-i` is, index-aligned with `inputs`.
    // The path alone cannot say it: what goes *before* an `-i` — the forced
    // demuxer, the option bag, the window — belongs to the input, and a command
    // that printed the path without them would be a command that opens a
    // different file.
    const inputRefs = [];
    for (const node of g.nodes) {
        if (node.kind !== 'input' || !node.path) continue;
        inputs[node.index] = node.path;
        inputRefs[node.index] = node.input === undefined ? -1 : node.input;
    }

    // A sink does not impose a name, it reports one. With a single audible clip
    // there is no mixer and the pad the muxer maps is that clip's own `[a0]` —
    // naming it `aout` here would print a pad that no chain produces.
    //
    // **The derivation's sinks only.** An output a person named is a pad a
    // *stream* asks for by name (`pad:<label>`), not the render's own picture
    // or soundtrack, and answering with one here would make a composite-fed
    // stream print `-map` for somebody else's pad the moment `out:v` was
    // unwired — which is precisely the state a graph whose whole picture leaves
    // by name is in.
    const pad = (stream) => {
        for (const node of g.nodes) {
            if (node.kind !== 'sink' || node.name || node.stream !== stream) continue;
            const e = g.inEdges(node)[0];
            if (e) return `[${padOf(g.node(e.from), nameFor, e.fromPort || 0)}]`;
        }
        return null;
    };

    return { chains, inputs, inputRefs, video: pad('v'), audio: pad('a') };
}
