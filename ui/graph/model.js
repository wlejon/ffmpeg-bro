// The graph, as a thing the application holds rather than a string it prints.
//
// ffmpeg's model is inputs → a filter graph → encoders → a muxer. This app has
// been presenting an NLE's model, which is a lossy projection of it, and
// printing the filtergraph back out as a translation at the end. Turning that
// around — holding the graph and deriving the *printout* from it — is what
// makes the things ffmpeg can do expressible here at all, because it gives them
// somewhere to live that is not "another field on a clip".
//
// **One node kind, because ffmpeg has one.** A `scale` node is a filter node
// named `scale`; the app's crop and opacity and stacking are not special cases
// of anything, they are `crop`, `colorchannelmixer` and `overlay`. The only
// nodes that are not filters are the two ends: an `input` is a *file* — `-i
// something.mp4`, with an output per stream it is read for — and a `sink` is a
// pad the muxer maps.
//
// **There is more than one sink per stream, and there was always going to be.**
// The derivation makes two — `out:v` and `out:a`, the composite and the mix —
// and a person can place more, each carrying a `name`. A named one is the same
// kind of node on purpose: the cards, the layout, the wires and the previews
// already know what a sink is, and a third kind would have meant teaching every
// one of them the same thing again. What the name buys is that the chain
// feeding it is printed ending in `[that]`, so a stream on the Write stage can
// say `pad:<that>` and be fed from the middle of a graph.
//
// **A node can have more than one output, and an edge says which it leaves
// by.** That was written down as the thing this model could not do for as long
// as an input node was one stream: a file's picture and its sound were two
// nodes reading the same path, which draws `-i a.mp4` twice and says the two
// have nothing to do with each other. They do — `[0:v]` and `[0:a]` are one
// `-i`, one demuxer and one seek. `outs` is what a node produces and
// `edge.fromPort` is which of them a wire carries; a filter has one output and
// says nothing, which is why almost everything below reads as it did.
//
// **Arguments are positional-then-named because ffmpeg's are.** `crop`'s four
// numbers and `scale`'s two are the first entries of the same option table the
// named ones come from — `crop=iw*0.8:ih*0.5` and `crop=w=iw*0.8:h=ih*0.5` are
// the same filter configured the same way. Keeping the split means what is
// printed is what was written, rather than a normalisation of it that nobody
// asked for; a node editor drawn from `filterOptions()` can name the positional
// ones later without any of this changing.
//
// **Derived nodes are rebuilt on every edit; user nodes never are.** That is
// the whole reason a node carries `anchor`, `locked` and `derived`: the
// skeleton is regenerated from the timeline whenever the timeline moves, and
// anything you touched has to be findable again afterwards. A position in an
// array is not findable — a named insert point is.

/// Ids are unique across every graph in the process, not just within one. Two
/// graphs exist at once as soon as a derived skeleton is compared against the
/// one before it, and ids that collide between them turn "is this the same
/// node" into a question with two answers.
let seq = 0;

/// A fresh, empty graph. `derived` sets what nodes added to it are: the
/// skeleton builder wants every node it makes marked, and marking each call
/// site would be noise that one of them eventually forgets.
export function makeGraph(opts = {}) {
    const nodes = [];
    const edges = [];
    const listeners = [];
    const derivedByDefault = !!opts.derived;

    const g = { nodes, edges };

    const idOf = (n) => (typeof n === 'string' ? n : n && n.id);

    g.node = (n) => {
        const id = idOf(n);
        for (const nd of nodes) if (nd.id === id) return nd;
        return null;
    };

    /// A node by the name of what it *is*, rather than by the id it happens to
    /// have been given. The skeleton is thrown away and rebuilt whenever the
    /// timeline moves, so an id is only good for as long as one derivation
    /// lasts; an anchor outlives them all, which is what a lock and a selection
    /// both need.
    ///
    /// Answers with the first, because several user nodes can share one insert
    /// point and each of those is found by its own id.
    g.byAnchor = (anchor) => {
        if (!anchor) return null;
        for (const nd of nodes) if (nd.anchor === anchor) return nd;
        return null;
    };

    /// Structural, and quiet: building a graph is not an edit to one. Only the
    /// mutations below announce themselves, so deriving a skeleton does not
    /// send every listener a hundred notifications about a graph that is not
    /// finished being built.
    g.add = (spec) => {
        const node = {
            id: spec.id || `n${++seq}`,
            kind: spec.kind || 'filter',
            filter: spec.filter || '',
            pos: spec.pos ? spec.pos.slice() : [],
            params: Object.assign({}, spec.params),
            // The pad this node's output is called when something has to name
            // it. Only chain-final nodes need one — see print.js — so most are
            // null and that is not an omission.
            label: spec.label || null,
            anchor: spec.anchor || null,
            locked: !!spec.locked,
            derived: spec.derived !== undefined ? !!spec.derived : derivedByDefault,
        };
        // What the positional arguments are called, where whoever wrote them
        // knew. Not derivable: ffmpeg's own option tables carry aliases as
        // separate entries — `scale` lists `w` and `width` and `h` and
        // `height` — so the n-th option is not reliably the n-th positional
        // argument, and a panel that labelled them by counting would name
        // `crop`'s `x` "h". The derivation knows what it wrote; nothing else
        // has to guess.
        if (spec.posNames) node.posNames = spec.posNames.slice();
        // What this node produces, one entry per output pad, where it has more
        // than the one every filter has. An input carries the streams it is
        // read for — `[{stream:'v'}, {stream:'a'}]` for a file whose picture
        // and sound are both used — and `edge.fromPort` indexes into it.
        // Copied rather than shared: two derivations of one timeline must not
        // be able to reach each other's arrays.
        if (spec.outs) node.outs = spec.outs.map((o) => ({ stream: o.stream }));
        // What this node *reads*, one entry per input pad, where anything knows.
        // Derived from the filter's own pad list rather than from the wires,
        // which is the difference that makes a free graph drawable at all: a
        // node with two inputs and one wire has an empty socket, and an empty
        // socket is a thing to be seen and filled. Counting the wires instead —
        // which is what this did while every graph came out of the derivation
        // fully wired — draws a one-input `overlay` and hides the mistake.
        if (spec.ins) node.ins = spec.ins.map((o) => ({ stream: o.stream }));
        // What only one kind has. Copied rather than merged wholesale so a
        // stray field on a spec cannot quietly become part of the model.
        if (spec.stream) node.stream = spec.stream;
        // What a sink is called, where somebody named it. Only an output of
        // your own has one — the derivation's two ends are named by their
        // anchors — and it is the pad label the chain feeding it is printed
        // with, which is what `pad:<label>` on a stream row reads. Tested
        // against `undefined` rather than for truth, because an output whose
        // name has been cleared is a node with a problem and not a node
        // without a name: dropping the field would turn it back into the
        // render's own sink.
        if (spec.name !== undefined) node.name = spec.name;
        if (spec.index !== undefined) node.index = spec.index;
        if (spec.path) node.path = spec.path;
        // Which of the document's inputs an input node is. Two numbers, because
        // they count different things: `index` is the `-i` number *this graph*
        // gives the pad, and this is the `-i` the application holds — the one
        // carrying the forced demuxer, the option bag and the window. A graph
        // that knew only the path would print a command that opens a different
        // file, since everything before an `-i` belongs to the input.
        if (spec.input !== undefined) node.input = spec.input;
        // The earliest source time anything downstream will ask this input
        // for. Not printed — a command line says it with `trim` — but a
        // renderer given the graph can seek there instead of decoding from the
        // start of the file, which for a clip an hour in is the difference
        // between a render and an hour.
        if (spec.from !== undefined) node.from = spec.from;
        // How many seconds this filter moves the clock forward — the derived
        // `setpts` and the `adelay` beneath it, and nothing else. Not printed
        // either: the expression the node carries is what a command line says,
        // and this is what that expression *comes to*, for the one reader that
        // has to reproduce the same map without being able to evaluate it
        // (`ui/graph/playback.js`, which runs a chain over frames the viewer is
        // already sitting in the middle of). Carried here rather than worked
        // out again from the clip, so the number and the filter that applies it
        // cannot drift apart.
        if (spec.moves !== undefined) node.moves = spec.moves;
        if (spec.title) node.title = spec.title;
        // Where this input's pictures start out: on a card, or in system
        // memory. A fact about the `-i` — `-hwaccel_output_format` and nothing
        // else decides it — and it is carried on the node because everything
        // that asks about it is asking about the *graph*, and a graph that had
        // to reach for the document's input list to answer would not be a pure
        // function of the spec it was derived from.
        if (spec.onDevice !== undefined) node.onDevice = !!spec.onDevice;
        nodes.push(node);
        return node;
    };

    /// `port` is the input index on `to`, which matters: overlay's first input
    /// is what it draws onto and its second is what it draws. Getting them the
    /// wrong way round is a picture, not an error.
    ///
    /// `fromPort` is the output index on `from`, and it matters for the same
    /// reason at the other end: a file's picture and its sound leave the same
    /// node by different pads, and a wire that did not say which would make
    /// `[0:v]` and `[0:a]` the same claim. A filter has one output and every
    /// call about one leaves this at zero.
    g.connect = (from, to, port = 0, fromPort = 0) => {
        const edge = { from: idOf(from), to: idOf(to), port, fromPort };
        edges.push(edge);
        return edge;
    };

    g.disconnect = (from, to) => {
        const a = idOf(from), b = idOf(to);
        for (let i = edges.length - 1; i >= 0; i--)
            if (edges[i].from === a && edges[i].to === b) edges.splice(i, 1);
    };

    /// Whatever arrives at one input pad, taken off it. **An input pad holds
    /// exactly one wire** — that is true of libavfilter and of every node editor
    /// there has ever been — so this is what "unwire that" means and it is also
    /// what makes a hand-made wire able to replace a derived one without anybody
    /// having to delete the old one first.
    g.disconnectAt = (to, port = 0) => {
        const id = idOf(to);
        let any = false;
        for (let i = edges.length - 1; i >= 0; i--)
            if (edges[i].to === id && (edges[i].port || 0) === port) {
                edges.splice(i, 1);
                any = true;
            }
        return any;
    };

    /// Connect, replacing whatever was on that input pad. `connect` is the raw
    /// operation the derivation builds with, where nothing is ever wired twice;
    /// this is the one a person's gesture goes through, where the pad they
    /// dropped on is usually already occupied by the wire the derivation made.
    g.wire = (from, to, port = 0, fromPort = 0) => {
        g.disconnectAt(to, port);
        const edge = g.connect(from, to, port, fromPort);
        g.changed('wire');
        return edge;
    };

    /// The wires arriving at a node, in port order. The sort is not decoration:
    /// edges are stored in the order they were made, and a graph rebuilt after
    /// an edit has no obligation to make them in the same order twice.
    ///
    /// The edges rather than the nodes, for anything that has to know which pad
    /// on the far end it is reading — which is the printer, and nothing else.
    g.inEdges = (n) => {
        const id = idOf(n);
        return edges.filter((e) => e.to === id).sort((a, b) => a.port - b.port);
    };

    g.outEdges = (n) => {
        const id = idOf(n);
        return edges.filter((e) => e.from === id);
    };

    /// What feeds a node, in port order.
    g.producers = (n) => g.inEdges(n).map((e) => g.node(e.from)).filter(Boolean);

    g.consumers = (n) => g.outEdges(n).map((e) => g.node(e.to)).filter(Boolean);

    /// How many output pads a node has. One unless it said otherwise, which is
    /// every filter ever derived here and is what keeps the layout, the sockets
    /// and the printer from each needing to know about `outs`.
    g.outPorts = (n) => {
        const node = g.node(n) || (n && n.id ? n : null);
        if (!node) return 1;
        if (node.kind === 'sink') return 0;
        return node.outs && node.outs.length ? node.outs.length : 1;
    };

    /// How many input pads a node has — what the *filter* takes, not how many
    /// wires happen to be attached. An unwired pad is the whole point: it is
    /// drawn as an empty socket and reported as a graph that will not run, and
    /// counting the wires would make both of those invisible.
    ///
    /// Falls back to the wires for a node nobody has declared pads for, which is
    /// every hand-built graph in the tests and every derived one made before the
    /// pads were worked out.
    g.inPorts = (n) => {
        const node = g.node(n) || (n && n.id ? n : null);
        if (!node) return 0;
        if (node.kind === 'input') return 0;
        if (node.ins) return node.ins.length;
        return Math.max(1, g.inEdges(node).length);
    };

    /// A straight run of filters, each reading the one before it, fed by `from`
    /// — one node, or several for a filter that takes several inputs. The last
    /// one gets `label`, because a run is exactly what ffmpeg calls a chain and
    /// a chain is the only thing that needs its output named.
    ///
    /// A source is a node, or `{ node, out }` where the node has more than one
    /// output and this run wants a particular one. Written that way round so
    /// that every caller reading a filter's single output — which is all of
    /// them but the sound of a clip — says nothing at all.
    ///
    /// This exists so the skeleton reads as the sentence it is ("cut it, move
    /// it, crop it, size it") instead of as twenty add/connect pairs.
    g.run = (from, steps, label) => {
        const sources = Array.isArray(from) ? from : from ? [from] : [];
        let prev = null;
        for (const step of steps) {
            const node = g.add(step);
            if (!prev)
                sources.forEach((src, port) => {
                    if (!src) return;
                    const one = src.node || src;
                    g.connect(one, node, port, src.node ? src.out || 0 : 0);
                });
            else g.connect(prev, node, 0);
            prev = node;
        }
        if (prev && label !== undefined) prev.label = label;
        return prev;
    };

    // ── mutation: the part that is an edit ─────────────────────────────────
    //
    // Everything below announces itself, because everything below is something
    // a person did.

    /// Editing a param locks the node. A value you typed that the next
    /// timeline edit silently reverted is the worst outcome available here —
    /// worse than the edit not applying, because at least that is visible.
    g.setParams = (n, params) => {
        const node = g.node(n);
        if (!node) return null;
        Object.assign(node.params, params);
        node.locked = true;
        g.changed('params');
        return node;
    };

    g.setLocked = (n, on) => {
        const node = g.node(n);
        if (!node || node.locked === !!on) return node;
        node.locked = !!on;
        g.changed('lock');
        return node;
    };

    /// Splice a node into the wire leaving `after` by `fromPort`. Its consumers
    /// are moved to read from the new node instead, which is what "insert here"
    /// means on a wire and is not what connecting to both ends would do.
    ///
    /// The port is why this cannot simply move every edge leaving the node: a
    /// file's picture and its sound leave one input node, and a filter dropped
    /// on the picture that took the sound with it would put an `hflip` in front
    /// of `atrim`.
    g.insertAfter = (after, spec, fromPort = 0) => {
        const src = g.node(after);
        if (!src) return null;
        const node = g.add(Object.assign({ derived: false }, spec));
        for (const e of edges)
            if (e.from === src.id && (e.fromPort || 0) === fromPort && e.to !== node.id) {
                e.from = node.id;
                e.fromPort = 0;
            }
        g.connect(src, node, 0, fromPort);
        g.changed('insert');
        return node;
    };

    /// Take a node out and heal the wire through it: what fed its first input
    /// feeds whatever it fed, by the same pad it arrived on. Removing a node
    /// should not cut the graph in two, and it should not silently move a wire
    /// from one of a file's streams to another.
    g.remove = (n) => {
        const node = g.node(n);
        if (!node) return false;
        const up = g.inEdges(node)[0] || null;
        for (let i = edges.length - 1; i >= 0; i--) {
            const e = edges[i];
            if (e.to === node.id) edges.splice(i, 1);
            else if (e.from === node.id) {
                if (up) { e.from = up.from; e.fromPort = up.fromPort || 0; }
                else edges.splice(i, 1);
            }
        }
        nodes.splice(nodes.indexOf(node), 1);
        g.changed('remove');
        return true;
    };

    g.onChange = (fn) => {
        listeners.push(fn);
        return () => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        };
    };

    g.changed = (what) => { for (const fn of listeners.slice()) fn(what, g); };

    // ── persistence ────────────────────────────────────────────────────────

    /// Plain data, no listeners and no back-references, so it survives
    /// `JSON.stringify` into localStorage and out again.
    ///
    /// Derived nodes are included because a snapshot of the whole graph is what
    /// a diff or a screenshot wants. What gets *persisted* is `userNodes()`:
    /// storing the skeleton would mean restoring a picture of the timeline as
    /// it was rather than deriving one from the timeline as it is.
    g.toJSON = () => ({
        nodes: nodes.map((n) => Object.assign({}, n, {
            params: Object.assign({}, n.params),
            pos: n.pos.slice(),
            outs: n.outs ? n.outs.map((o) => ({ stream: o.stream })) : undefined,
            ins: n.ins ? n.ins.map((o) => ({ stream: o.stream })) : undefined,
        })),
        edges: edges.map((e) => Object.assign({}, e)),
    });

    /// The nodes a person made or changed — everything the derivation cannot
    /// reproduce, which is the only thing worth writing down.
    g.userNodes = () => nodes.filter((n) => !n.derived || n.locked);

    return g;
}

/// What names a node across two derivations.
///
/// A derived node's id lasts exactly as long as the graph it was made in, so it
/// is named by its anchor — what it *is*, rather than which object it happens to
/// be. A node a person made is not derived from anything, so its id is the
/// name, and it is handed out by `overlay.js` from a counter that outlives every
/// rebuild.
///
/// Here rather than in `panel.js`, where it started, because it is now the thing
/// **a hand-made wire's two ends are written as**: an endpoint has to survive
/// the skeleton being thrown away, and this is the only string that does. Four
/// callers now — the panel, the view's selection, the overlay's wires and the
/// problem list — and four spellings of it would be four answers to "is this the
/// same node".
export function keyOf(node) {
    return node ? (node.derived ? node.anchor : node.id) : null;
}

/// The node one of those keys names, whichever kind it is.
export function byKey(g, key) {
    if (!key) return null;
    return g.node(key) || g.byAnchor(key);
}

/// Which stream each node is on, and which each *wire* carries.
///
/// Only the two ends of a graph say so themselves — an input names the streams
/// it is read for, a sink names the one it maps — and everything between is
/// whatever reached it. Here rather than in `layout.js` because it is a fact
/// about the graph and not about where the graph is drawn, and because there
/// are three callers now: the layout colours a wire with it, the card colours
/// its dot, and `subgraph.js` uses it to decide whether a preview of a node is
/// a picture or a waveform. Three implementations of that would be three
/// answers.
///
/// Per wire as well as per node, because an input node is not on one stream: a
/// file's picture and its sound leave the same card by different pads.
///
/// `of(node)` and `ofEdge(edge)`. Relaxed to a fixed point rather than sorted
/// topologically: the pass is over a few dozen nodes, and a cycle in a
/// hand-built graph should come out as a strange picture rather than as a hang.
export function streamsOf(g) {
    const s = new Map();
    for (const n of g.nodes)
        if (n.kind === 'input')
            s.set(n.id, (n.outs && n.outs[0] && n.outs[0].stream) || n.stream || 'v');

    // What leaves a node by a given pad. A file says so per pad; everything
    // else has one output and it is whatever the node is on.
    const outOf = (n, port) => {
        if (!n) return null;
        if (n.outs && n.outs.length) return (n.outs[port] || n.outs[0]).stream;
        return s.get(n.id) || n.stream || null;
    };

    for (let pass = 0; pass <= g.nodes.length; pass++) {
        let moved = false;
        for (const e of g.edges) {
            if (s.has(e.to)) continue;
            const st = outOf(g.node(e.from), e.fromPort || 0);
            if (st) { s.set(e.to, st); moved = true; }
        }
        if (!moved) break;
    }

    return {
        // A node that says what it produces is believed over what reached it,
        // and the two genuinely differ: `showwaves` reads sound and hands back a
        // picture, so a card coloured by its producer would be green and wrong.
        // The generated canvas (`color`) has no producer and no input at all, so
        // it falls back to video — which is what it is.
        of: (n) => (n.outs && n.outs.length && n.outs[0].stream) ||
                   s.get(n.id) || n.stream || 'v',
        ofEdge: (e) => outOf(g.node(e.from), e.fromPort || 0) || 'v',
    };
}

/// A graph back from `toJSON()`. Ids are kept, which is what makes a restored
/// overlay reconnectable to a skeleton derived after it.
export function restore(json) {
    const g = makeGraph();
    if (!json || !Array.isArray(json.nodes)) return g;
    for (const n of json.nodes) g.add(n);
    for (const e of json.edges || []) g.connect(e.from, e.to, e.port || 0, e.fromPort || 0);
    // Ids handed back to us must not be handed out again.
    for (const n of json.nodes) {
        const m = /^n(\d+)$/.exec(String(n.id || ''));
        if (m) seq = Math.max(seq, Number(m[1]));
    }
    return g;
}
