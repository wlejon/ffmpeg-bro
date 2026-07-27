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
// nodes that are not filters are the two ends: an `input` is a decoded stream
// (`[0:v]`), a `sink` is a pad the muxer maps.
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
        // What only one kind has. Copied rather than merged wholesale so a
        // stray field on a spec cannot quietly become part of the model.
        if (spec.stream) node.stream = spec.stream;
        if (spec.index !== undefined) node.index = spec.index;
        if (spec.path) node.path = spec.path;
        // The earliest source time anything downstream will ask this input
        // for. Not printed — a command line says it with `trim` — but a
        // renderer given the graph can seek there instead of decoding from the
        // start of the file, which for a clip an hour in is the difference
        // between a render and an hour.
        if (spec.from !== undefined) node.from = spec.from;
        if (spec.title) node.title = spec.title;
        nodes.push(node);
        return node;
    };

    /// `port` is the input index on `to`, which matters: overlay's first input
    /// is what it draws onto and its second is what it draws. Getting them the
    /// wrong way round is a picture, not an error.
    ///
    /// There is no port on the *from* side, which is to say a node has one
    /// output. That is enough for everything derived from a timeline and it is
    /// not enough for ffmpeg: `split` and `asplit` exist precisely to read one
    /// pad twice, and until an edge can name which output it leaves by they
    /// cannot be expressed. The printer already breaks its chain at a pad with
    /// two readers, so when the port arrives it arrives here and in `padOf`,
    /// and the chain rule does not change.
    g.connect = (from, to, port = 0) => {
        const edge = { from: idOf(from), to: idOf(to), port };
        edges.push(edge);
        return edge;
    };

    g.disconnect = (from, to) => {
        const a = idOf(from), b = idOf(to);
        for (let i = edges.length - 1; i >= 0; i--)
            if (edges[i].from === a && edges[i].to === b) edges.splice(i, 1);
    };

    /// What feeds a node, in port order. The sort is not decoration: edges are
    /// stored in the order they were made, and a graph rebuilt after an edit
    /// has no obligation to make them in the same order twice.
    g.producers = (n) => {
        const id = idOf(n);
        return edges.filter((e) => e.to === id)
                    .sort((a, b) => a.port - b.port)
                    .map((e) => g.node(e.from))
                    .filter(Boolean);
    };

    g.consumers = (n) => {
        const id = idOf(n);
        return edges.filter((e) => e.from === id).map((e) => g.node(e.to)).filter(Boolean);
    };

    /// A straight run of filters, each reading the one before it, fed by `from`
    /// — one node, or several for a filter that takes several inputs. The last
    /// one gets `label`, because a run is exactly what ffmpeg calls a chain and
    /// a chain is the only thing that needs its output named.
    ///
    /// This exists so the skeleton reads as the sentence it is ("cut it, move
    /// it, crop it, size it") instead of as twenty add/connect pairs.
    g.run = (from, steps, label) => {
        const sources = Array.isArray(from) ? from : from ? [from] : [];
        let prev = null;
        for (const step of steps) {
            const node = g.add(step);
            if (!prev) sources.forEach((src, port) => src && g.connect(src, node, port));
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

    /// Splice a node into the wire leaving `after`. Its consumers are moved to
    /// read from the new node instead, which is what "insert here" means on a
    /// wire and is not what connecting to both ends would do.
    g.insertAfter = (after, spec) => {
        const src = g.node(after);
        if (!src) return null;
        const node = g.add(Object.assign({ derived: false }, spec));
        for (const e of edges)
            if (e.from === src.id && e.to !== node.id) e.from = node.id;
        g.connect(src, node, 0);
        g.changed('insert');
        return node;
    };

    /// Take a node out and heal the wire through it: its first producer feeds
    /// whatever it fed. Removing a node should not cut the graph in two.
    g.remove = (n) => {
        const node = g.node(n);
        if (!node) return false;
        const upstream = g.producers(node)[0];
        for (let i = edges.length - 1; i >= 0; i--) {
            const e = edges[i];
            if (e.to === node.id) edges.splice(i, 1);
            else if (e.from === node.id) {
                if (upstream) e.from = upstream.id;
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
        nodes: nodes.map((n) => Object.assign({}, n, { params: Object.assign({}, n.params), pos: n.pos.slice() })),
        edges: edges.map((e) => Object.assign({}, e)),
    });

    /// The nodes a person made or changed — everything the derivation cannot
    /// reproduce, which is the only thing worth writing down.
    g.userNodes = () => nodes.filter((n) => !n.derived || n.locked);

    return g;
}

/// A graph back from `toJSON()`. Ids are kept, which is what makes a restored
/// overlay reconnectable to a skeleton derived after it.
export function restore(json) {
    const g = makeGraph();
    if (!json || !Array.isArray(json.nodes)) return g;
    for (const n of json.nodes) g.add(n);
    for (const e of json.edges || []) g.connect(e.from, e.to, e.port || 0);
    // Ids handed back to us must not be handed out again.
    for (const n of json.nodes) {
        const m = /^n(\d+)$/.exec(String(n.id || ''));
        if (m) seq = Math.max(seq, Number(m[1]));
    }
    return g;
}
